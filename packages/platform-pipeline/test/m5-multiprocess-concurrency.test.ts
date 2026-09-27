/**
 * M5 并发发布门槛：**真实多进程**竞争（docs/11 §9 批次 E 第 7 项、docs/12 §6）。
 *
 * 为什么必须是多进程：单元测试里的 `Promise.all([claim(a), claim(b)])` 证明的是
 * "同一进程内的读改写被串行化了"。而生产上的竞争来自**多个进程**——
 * Web 服务、CLI、恢复扫描可能同时在写同一份记录。in-process 的互斥（内存后端用的
 * 串行链）对它完全无效，只有真正落到文件系统/数据库的 CAS 才拦得住。
 *
 * 因此这一组用 `child_process` 起**真实的 node 进程**，让它们同时抢：
 * 1. 同一条门任务的 `claim`（per-task 互斥）；
 * 2. 同一条流水线的运行锁（跨进程锁）；
 * 3. 同一条门任务的 `decide`（认领之后只有持有者能裁决）。
 *
 * 子进程脚本在运行时写到临时目录（而不是放进 `test/`）：`node --test` 会把
 * `test/**` 下的每个文件都当成测试文件，放一个"没有测试的脚本"进去只会制造噪音。
 *
 * @module test/m5-multiprocess-concurrency
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'

import type { PipelineConfig } from '../src/types.ts'
import { FilePipelineRunService } from '../src/web/pipeline-run-service.ts'
import { CREATE, REVIEWER, SCOPE, ScriptedHost, baseConfig } from './web-fixtures.ts'

const here = dirname(fileURLToPath(import.meta.url))
const PACKAGE_ROOT = join(here, '..')

/** 子进程并发度：4 个真实进程足以暴露"读改写没加锁"，又不至于拖慢测试。 */
const WORKERS = 4
/**
 * 抢到锁的进程持有时长。
 *
 * 必须明显长于"其他进程的启动时间"（node 启动 + 类型剥离 + 模块加载，实测数百毫秒），
 * 否则会误判成"没竞争"；但也不需要长到让测试变慢。
 */
const HOLD_MS = 2_500

let dir: string
let childDir: string
let config: PipelineConfig

test.beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'pp-mp-'))
  childDir = await mkdtemp(join(tmpdir(), 'pp-mp-child-'))
  config = baseConfig()
})
test.afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
  await rm(childDir, { recursive: true, force: true })
})

function serviceOf(host: ScriptedHost): FilePipelineRunService {
  return new FilePipelineRunService({
    dataRoot: dir,
    loadConfig: async () => config,
    createHost: host.factory,
  })
}

interface ChildOutcome {
  readonly ok: boolean
  readonly code?: string
  readonly message?: string
  readonly pid?: number
  /** 仅 `lock` 模式：本次持有锁的区间（用于判"互斥"而不是"只有一个成功"）。 */
  readonly acquiredAt?: number
  readonly releasedAt?: number
}

/**
 * 写子进程脚本。
 *
 * 用**绝对路径动态 import**：脚本落在临时目录里，相对说明符解析不到仓库模块。
 * `.ts` 后缀让 node 的类型剥离生效（与 `node --test test/*.ts` 同一机制）。
 */
async function writeWorker(): Promise<string> {
  const path = join(childDir, 'worker.ts')
  const imports = {
    service: join(PACKAGE_ROOT, 'src/web/pipeline-run-service.ts'),
    storage: join(PACKAGE_ROOT, 'src/storage/file/index.ts'),
    roots: join(PACKAGE_ROOT, 'src/platform-roots.ts'),
    fixtures: join(here, 'web-fixtures.ts'),
  }
  await writeFile(path, `
const [mode, dataRoot, pipelineId, gateTaskId, holdMs, actorId] = process.argv.slice(2)
const { FilePipelineRunService } = await import(${JSON.stringify(imports.service)})
const { createFileStorageBackendFromRoots } = await import(${JSON.stringify(imports.storage)})
const { resolvePlatformRoots } = await import(${JSON.stringify(imports.roots)})
const { ScriptedHost, baseConfig, REVIEWER, SCOPE } = await import(${JSON.stringify(imports.fixtures)})

// 每个子进程用**不同**的身份：这是 CAS 的前提。同一身份重复认领是合法的租约刷新，
// 因此"4 个同身份进程都成功"并不能说明 CAS 有问题——但那样就测不到 CAS。
const ACTOR = actorId === undefined || actorId === "" ? REVIEWER : { ...REVIEWER, actorId }

const service = new FilePipelineRunService({
  dataRoot,
  loadConfig: async () => baseConfig(),
  createHost: new ScriptedHost().factory,
})

function report(payload) {
  process.stdout.write(JSON.stringify(payload) + "\\n")
}

try {
  if (mode === "claim") {
    const task = await service.claimGate({ ...SCOPE, pipelineId, gateTaskId }, ACTOR)
    report({ ok: true, by: task.claimedBy, pid: process.pid })
  } else if (mode === "decide") {
    const task = await service.decideGate({ ...SCOPE, pipelineId, gateTaskId, action: "approved" }, ACTOR)
    report({ ok: true, decision: task.decision && task.decision.by, pid: process.pid })
  } else if (mode === "lock") {
    const backend = createFileStorageBackendFromRoots(resolvePlatformRoots(dataRoot, baseConfig()))
    const lock = await backend.ports.lock(pipelineId, { ownerId: "child-" + process.pid })
    const acquiredAt = Date.now()
    // 持有足够久，让其他进程真的撞上"已被持有"。
    await new Promise(resolve => setTimeout(resolve, Number(holdMs)))
    await lock.release()
    // 报出**持有区间**：跨进程互斥的真正判据是"区间不重叠"，
    // 而不是"总共只有一个成功"——先到者释放后，后到者当然可以成功。
    report({ ok: true, pid: process.pid, acquiredAt, releasedAt: Date.now() })
  } else {
    report({ ok: false, code: "bad-mode", message: mode })
  }
} catch (error) {
  report({
    ok: false,
    code: error && error.code ? String(error.code) : (error && error.name ? String(error.name) : "unknown"),
    message: String(error && error.message ? error.message : error),
  })
}
`, 'utf8')
  return path
}

/** 起一个子进程并等它输出一行 JSON。 */
function runWorker(script: string, args: readonly string[]): Promise<ChildOutcome> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], { cwd: PACKAGE_ROOT, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    child.stdout.on('data', (chunk: Buffer) => { out += chunk.toString('utf8') })
    child.stderr.on('data', (chunk: Buffer) => { err += chunk.toString('utf8') })
    child.on('error', reject)
    child.on('close', () => {
      const line = out.split('\n').map(text => text.trim()).filter(text => text !== '').pop()
      if (line === undefined) {
        reject(new Error(`子进程没有输出结果：stdout=${JSON.stringify(out)} stderr=${JSON.stringify(err)}`))
        return
      }
      try {
        resolve(JSON.parse(line) as ChildOutcome)
      } catch (error) {
        reject(new Error(`子进程输出不是 JSON：${line}（${String(error)}）`))
      }
    })
  })
}

/** 跑到 receive 人工门，返回未决门任务 id。 */
async function parkedGateTaskId(): Promise<string> {
  const service = serviceOf(new ScriptedHost())
  await service.create(CREATE, REVIEWER)
  assert.equal((await service.run('pipe-1', REVIEWER)).outcome, 'waiting-human')
  const [task] = await service.listGateTasks(SCOPE, REVIEWER)
  return task!.gateTaskId
}

// ── 门槛 6：跨进程门任务 CAS ────────────────────────────────────────────────

test('门槛6：4 个真实进程同时 claim 同一条门任务，恰好一个成功', async () => {
  const gateTaskId = await parkedGateTaskId()
  const script = await writeWorker()

  // 每个进程用**不同**的身份——同一身份重复认领是合法的租约刷新（幂等），
  // 那测不到 CAS。CAS 要回答的是"两个不同的人同时认领会怎样"。
  const actors = ['alice', 'bob', 'carol', 'dave']
  const outcomes = await Promise.all(
    actors.map(actor => runWorker(script, ['claim', dir, 'pipe-1', gateTaskId, '0', actor])),
  )
  const winners = outcomes.filter(outcome => outcome.ok)
  assert.equal(winners.length, 1,
    `跨进程 claim 只能有一个成功，实际 ${winners.length} 个：${JSON.stringify(outcomes)}`)

  // 落盘事实必须与胜者一致（不是"返回值说成功了但磁盘上是别人"）。
  const service = serviceOf(new ScriptedHost())
  const task = (await service.listGateTasks(SCOPE, REVIEWER))[0]!
  assert.equal(task.status, 'claimed')
  assert.ok(actors.includes(task.claimedBy!), `claimedBy 必须是胜者之一：${task.claimedBy}`)
})

test('门槛6b：认领之后 4 个进程同时 decide，恰好一个成功', async () => {
  const gateTaskId = await parkedGateTaskId()
  const service = serviceOf(new ScriptedHost())
  await service.claimGate({ ...SCOPE, gateTaskId }, REVIEWER)
  const script = await writeWorker()

  // 认领者是 alice；四个进程分别以 alice/bob/carol/dave 身份提交裁决——
  // 只有 alice 是持有者，且状态转移本身也只允许一次。
  const outcomes = await Promise.all(
    ['alice', 'bob', 'carol', 'dave'].map(actor => runWorker(script, ['decide', dir, 'pipe-1', gateTaskId, '0', actor])),
  )
  const winners = outcomes.filter(outcome => outcome.ok)
  assert.equal(winners.length, 1,
    `跨进程 decide 只能有一个成功，实际 ${winners.length} 个：${JSON.stringify(outcomes)}`)

  const task = (await service.listGateTasks(SCOPE, REVIEWER))[0]!
  assert.equal(task.status, 'approved')
  assert.equal(task.decision!.by, 'alice')
})

// ── 门槛 7：跨进程运行锁 ────────────────────────────────────────────────────

test('门槛7：4 个真实进程同时抢同一条流水线的运行锁，持有区间绝不重叠', async () => {
  await parkedGateTaskId()
  const script = await writeWorker()

  const outcomes = await Promise.all(
    Array.from({ length: WORKERS }, () => runWorker(script, ['lock', dir, 'pipe-1', '', String(HOLD_MS)])),
  )
  const winners = outcomes.filter(outcome => outcome.ok)
  const losers = outcomes.filter(outcome => !outcome.ok)

  // 判据是**互斥**（持有区间两两不重叠），不是"总共只有一个成功"：
  // 先到者释放之后，后到者当然可以成功——那是正确行为，不是竞态。
  assert.ok(winners.length >= 1, `至少要有一个进程抢到锁：${JSON.stringify(outcomes)}`)
  assert.ok(losers.length >= 1,
    `必须真的发生竞争（至少一个进程被拒），否则这条门槛是空跑的：${JSON.stringify(outcomes)}`)

  const intervals = winners
    .map(outcome => ({ pid: outcome.pid, from: outcome.acquiredAt!, to: outcome.releasedAt! }))
    .sort((a, b) => a.from - b.from)
  for (let index = 1; index < intervals.length; index += 1) {
    const previous = intervals[index - 1]!
    const current = intervals[index]!
    assert.ok(current.from >= previous.to,
      `两个进程同时持有锁：pid ${previous.pid} 持有到 ${previous.to}，pid ${current.pid} 从 ${current.from} 就开始`)
  }

  // 失败方必须给出"被持有"这一明确原因，而不是超时/未知错误。
  for (const loser of losers) {
    assert.match(`${loser.code} ${loser.message}`, /PipelineLockHeldError|held|locked by/i,
      `失败原因必须是"锁被持有"：${JSON.stringify(loser)}`)
  }
})

test('门槛7b：锁释放之后下一个进程能立刻抢到（不会永久锁死）', async () => {
  await parkedGateTaskId()
  const script = await writeWorker()

  const first = await runWorker(script, ['lock', dir, 'pipe-1', '', '200'])
  assert.equal(first.ok, true)
  const second = await runWorker(script, ['lock', dir, 'pipe-1', '', '0'])
  assert.equal(second.ok, true, `锁必须被正常释放：${JSON.stringify(second)}`)
})
