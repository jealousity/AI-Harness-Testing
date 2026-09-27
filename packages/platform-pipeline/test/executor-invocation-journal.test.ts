/**
 * 执行调用的可恢复状态机（docs/11 P1-07 / P1-08）。
 *
 * 被验证的性质：executor 会发出**真实、不可撤销**的请求，而"发请求"和"把结果落盘"
 * 是两次独立的写盘。修复前台账只在执行完成后才写，于是"远端副作用已发生、本地一无所知"
 * 会被当成"还没执行过"，重试即重复副作用。
 *
 * 本文件用**注入的 request**（不发真实 socket）+ **人为制造的现场**（把会话路径变成
 * 目录让落盘失败 / 直接改写调用日志的 phase）来复现崩溃窗口，因此完全确定性、不依赖 sleep。
 *
 * @module platform-pipeline/test/executor-invocation-journal
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync as exists } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import {
  buildPlatformTools,
  executorInvocationDir,
  executorSessionPath,
  type PlatformToolContext,
} from '../src/runtime/platform-tools.ts'
import type { HttpRequestFn } from '../src/executor/http.ts'
import type { InvocationPhase } from '../src/executor/invocation-journal.ts'
import type { ToolDefinition } from '../src/runtime/ports.ts'

let dir: string

test.beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'pp-invocation-')) })
test.afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

const signal = new AbortController().signal
const PIPELINE = 'p1'

/** 工具执行上下文（`executor_run` 只用到 `signal`）。 */
const ctx = { signal }

interface RunResult {
  readonly records?: readonly { readonly caseId: string; readonly status: string; readonly seq: number }[]
  readonly error?: string
  readonly replayedCaseIds?: readonly string[]
  readonly blockedCaseIds?: readonly string[]
  readonly hint?: string
}

interface RecordedCall {
  readonly url: string
  readonly headers: Readonly<Record<string, string>>
}

/** 注入的 HTTP 传输：记录每次请求（含请求头），不发真实 socket。 */
function recordingRequest(): { readonly calls: RecordedCall[]; readonly request: HttpRequestFn } {
  const calls: RecordedCall[] = []
  return {
    calls,
    request: async (url, init) => {
      calls.push({ url, headers: init.headers })
      return { status: 200, text: async () => 'ok' }
    },
  }
}

function baseContext(overrides: Partial<PlatformToolContext> = {}): PlatformToolContext {
  return { projectRoot: dir, artifactsRoot: dir, pipelineId: PIPELINE, projectId: 'proj-a', ...overrides }
}

function executorTool(context: PlatformToolContext): ToolDefinition {
  const found = buildPlatformTools(context).find(candidate => candidate.name === 'executor_run')
  assert.ok(found !== undefined, 'executor_run 未注册')
  return found
}

async function writeDesign(content: unknown, digest = 'd'): Promise<void> {
  await mkdir(join(dir, 'artifacts', PIPELINE), { recursive: true })
  await writeFile(
    join(dir, 'artifacts', PIPELINE, 'design.json'),
    JSON.stringify({
      pipelineId: PIPELINE, stageId: 'design', version: 1, digest, inputs: {},
      path: `artifacts/${PIPELINE}/design.json`, content,
    }),
    'utf8',
  )
}

function designWith(ids: readonly string[]): unknown {
  return { testCases: ids.map(id => ({ id, steps: [{ action: 'GET /health', expected: ['200'] }] })) }
}

function journalPath(caseId: string): string {
  return join(executorInvocationDir(dir, PIPELINE), `${caseId}.json`)
}

async function readJournal(caseId: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(journalPath(caseId), 'utf8')) as Record<string, unknown>
}

/**
 * 模拟"崩溃在**完成之前**留下的现场"。
 *
 * 需要同时清理三样东西，否则造出的是现实中不可能出现的组合状态：
 * - 调用日志：退回指定阶段，并丢掉完成片段；
 * - 幂等台账：完成之前不可能有台账记录（台账在 `done` 之后才写）；
 * - 会话文件：会话是在整批执行完之后才写的，崩溃早于它。
 *
 * 键与指纹都沿用上一次真实执行写下的值——这样才与"同一次调用"匹配；
 * 自己编一个指纹只会让日志被当成另一次调用而失效，测不到想测的分支。
 */
async function simulateCrashBeforeCompletion(
  caseId: string,
  phase: InvocationPhase,
  patch: Record<string, unknown> = {},
): Promise<void> {
  const current = await readJournal(caseId)
  const { fragment: _dropped, ...rest } = current
  await writeFile(journalPath(caseId), JSON.stringify({ ...rest, ...patch, phase }, null, 2), 'utf8')
  await rm(join(dir, 'idempotency', 'executor-invocation', `${String(current.key)}.json`), { force: true })
  await rm(executorSessionPath(dir, PIPELINE), { force: true })
}

async function sessionRecords(): Promise<readonly { readonly caseId: string; readonly seq: number }[]> {
  const raw = JSON.parse(await readFile(executorSessionPath(dir, PIPELINE), 'utf8')) as {
    records: readonly { readonly caseId: string; readonly seq: number }[]
  }
  return raw.records
}

// ── 正常路径 ────────────────────────────────────────────────────────────────

test('正常执行后调用日志停在 done，重复投递不再发请求', async () => {
  await writeDesign(designWith(['c1', 'c2']))
  const { calls, request } = recordingRequest()
  const entry = executorTool(baseContext({ targetBaseUrl: 'https://sut.example', request }))

  const first = await entry.execute({}, ctx) as RunResult
  assert.deepEqual(first.records!.map(record => [record.caseId, record.status]), [['c1', 'pass'], ['c2', 'pass']])
  assert.equal(calls.length, 2)

  for (const caseId of ['c1', 'c2']) {
    const journal = await readJournal(caseId)
    assert.equal(journal.phase, 'done', `${caseId} 完成后必须停在 done`)
    assert.equal(typeof journal.key, 'string')
    assert.equal(typeof journal.fingerprint, 'string')
  }

  const second = await entry.execute({}, ctx) as RunResult
  assert.equal(calls.length, 2, '已完成的调用不得再发请求')
  assert.deepEqual(second.replayedCaseIds, ['c1', 'c2'])
})

// ── 崩溃窗口一：响应已到、会话未落盘 ─────────────────────────────────────────

test('崩溃注入：HTTP 成功但会话落盘失败 → 重启不重发，从调用日志补齐会话', async () => {
  await writeDesign(designWith(['c1', 'c2']))
  const { calls, request } = recordingRequest()
  const entry = executorTool(baseContext({ targetBaseUrl: 'https://sut.example', request }))

  // 制造"落盘会话时进程被杀"的现场：把 executor 目录设为**只读**。
  // 调用日志与证据都在它的子目录里（子目录自身可写），因此两者照常落盘；
  // 只有 `session.json.tmp-*` 写不进去 → 异常正好发生在"响应已拿到、会话未落盘"。
  const executorDir = join(dir, 'executor', PIPELINE)
  await mkdir(join(executorDir, 'invocations'), { recursive: true })
  await mkdir(join(executorDir, 'evidence'), { recursive: true })
  await chmod(executorDir, 0o500)
  try {
    await assert.rejects(() => entry.execute({}, ctx), '会话落盘失败必须向上抛，不能吞掉')
  } finally {
    await chmod(executorDir, 0o700)
  }

  assert.equal(calls.length, 2, '崩溃前两个用例的请求都已发出')
  for (const caseId of ['c1', 'c2']) {
    assert.equal((await readJournal(caseId)).phase, 'received', `${caseId} 必须停在 received`)
  }
  assert.equal(await exists(executorSessionPath(dir, PIPELINE)), false, '会话确实没落盘')

  // 重启（同一个 dataRoot）：响应已经在日志里，不得再发一次。
  const after = await entry.execute({}, ctx) as RunResult

  assert.equal(calls.length, 2, '重启后**不得**再发任何请求：响应已经在日志里了')
  const records = await sessionRecords()
  assert.deepEqual(records.map(record => record.caseId), ['c1', 'c2'], '会话必须由调用日志补齐')
  assert.deepEqual(records.map(record => record.seq), [1, 2], '补齐的记录必须按当前链尾重新挂链')
  assert.equal(after.records!.length, 2)
  assert.equal((await readJournal('c1')).phase, 'done')
})

// ── 崩溃窗口二：请求已发出、响应未落盘 ───────────────────────────────────────

test('请求已发出但响应未知、远端不支持幂等键 → 明确阻断，一个新请求都不发', async () => {
  await writeDesign(designWith(['c1', 'c2']))
  const { calls, request } = recordingRequest()
  const entry = executorTool(baseContext({ targetBaseUrl: 'https://sut.example', request }))

  await entry.execute({ caseIds: ['c1'] }, ctx)
  assert.equal(calls.length, 1)
  // 模拟"请求发出后、响应落盘前被杀"：把 c1 退回 sent，且**没有**远端幂等键。
  await simulateCrashBeforeCompletion('c1', 'sent')

  const blocked = await entry.execute({ caseIds: ['c1', 'c2'] }, ctx) as RunResult
  assert.deepEqual(blocked.blockedCaseIds, ['c1'])
  assert.match(blocked.error ?? '', /结果未知/)
  assert.match(blocked.hint ?? '', /调用日志|幂等键/, '必须给出可执行的处置方式，而不是"请联系管理员"')
  assert.equal(calls.length, 1, '存在不可判定用例时一个新请求都不发（连 c2 也不执行）')
  assert.equal((await readJournal('c1')).phase, 'sent', '阻断不得改写现场')
})

test('远端声明支持幂等键时，sent 可以安全重发，且请求带稳定幂等键', async () => {
  await writeDesign(designWith(['c1']))
  const { calls, request } = recordingRequest()
  const entry = executorTool(baseContext({
    targetBaseUrl: 'https://sut.example',
    request,
    executorIdempotencyHeader: 'Idempotency-Key',
  }))

  await entry.execute({}, ctx)
  assert.equal(calls.length, 1)
  const stableKey = calls[0]!.headers['Idempotency-Key']
  assert.equal(typeof stableKey, 'string')
  assert.notEqual(stableKey, '', '声明了幂等键头就必须真的带上')

  await simulateCrashBeforeCompletion('c1', 'sent')
  const retried = await entry.execute({}, ctx) as RunResult
  assert.equal(retried.blockedCaseIds, undefined, '有远端幂等键时重发是安全的')
  assert.equal(calls.length, 2, '允许重发')
  assert.equal(calls[1]!.headers['Idempotency-Key'], stableKey, '重发必须带**同一个**稳定键，否则远端无法折叠')
})

test('幂等键头由宿主声明，design 产物里的同名字段顶不掉它', async () => {
  await writeDesign({
    testCases: [{
      id: 'c1',
      steps: [{ action: 'GET /health', expected: ['200'], headers: { 'Idempotency-Key': 'model-supplied' } }],
    }],
  })
  const { calls, request } = recordingRequest()
  const entry = executorTool(baseContext({
    targetBaseUrl: 'https://sut.example',
    request,
    executorIdempotencyHeader: 'Idempotency-Key',
  }))

  await entry.execute({}, ctx)
  assert.notEqual(calls[0]!.headers['Idempotency-Key'], 'model-supplied', '幂等键是宿主的安全边界，模型不能覆盖')
})

// ── 损坏与 intent ───────────────────────────────────────────────────────────

test('调用日志损坏 → 阻断，绝不当成"没执行过"', async () => {
  await writeDesign(designWith(['c1']))
  const { calls, request } = recordingRequest()
  const entry = executorTool(baseContext({ targetBaseUrl: 'https://sut.example', request }))

  await mkdir(executorInvocationDir(dir, PIPELINE), { recursive: true })
  await writeFile(journalPath('c1'), '{ 这不是 JSON', 'utf8')

  const blocked = await entry.execute({}, ctx) as RunResult
  assert.deepEqual(blocked.blockedCaseIds, ['c1'])
  assert.equal(calls.length, 0, '无法判定上一次是否已发出时必须阻断（与幂等台账相反：那里损坏按无记录处理是安全的）')
})

test('intent（尚未发出任何请求）可以安全重来', async () => {
  await writeDesign(designWith(['c1']))
  const { calls, request } = recordingRequest()
  const entry = executorTool(baseContext({ targetBaseUrl: 'https://sut.example', request }))

  await entry.execute({}, ctx)
  await simulateCrashBeforeCompletion('c1', 'intent')

  const again = await entry.execute({}, ctx) as RunResult
  assert.equal(again.blockedCaseIds, undefined)
  assert.equal(calls.length, 2, 'intent 阶段确定没有发出请求，重来是安全的')
  assert.equal((await readJournal('c1')).phase, 'done')
})

test('换了 design 产物 digest = 另一次调用：旧日志的阶段不适用，正常重跑', async () => {
  await writeDesign(designWith(['c1']), 'd1')
  const { calls, request } = recordingRequest()
  const entry = executorTool(baseContext({ targetBaseUrl: 'https://sut.example', request }))
  await entry.execute({}, ctx)
  await simulateCrashBeforeCompletion('c1', 'sent')

  // 设计变了 → inputDigest 变了 → 键与指纹都变了 → 不是同一次调用。
  await writeDesign(designWith(['c1']), 'd2')
  const fresh = await entry.execute({}, ctx) as RunResult
  assert.equal(fresh.blockedCaseIds, undefined, '另一次调用不该被上一次的 sent 卡住')
  assert.equal(calls.length, 2)
})

test('部分用例已完成时只执行未命中的那些（分批语义不被破坏）', async () => {
  await writeDesign(designWith(['c1', 'c2', 'c3']))
  const { calls, request } = recordingRequest()
  const entry = executorTool(baseContext({ targetBaseUrl: 'https://sut.example', request }))

  await entry.execute({ caseIds: ['c1'] }, ctx)
  assert.equal(calls.length, 1)
  const rest = await entry.execute({ caseIds: ['c1', 'c2', 'c3'] }, ctx) as RunResult
  assert.equal(calls.length, 3, '只有未命中的 c2/c3 被真正执行')
  assert.deepEqual(rest.replayedCaseIds, ['c1'])
  assert.deepEqual((await sessionRecords()).map(record => record.caseId), ['c1', 'c2', 'c3'])
})
