/**
 * M5 安全发布门槛（docs/11 §9 批次 E 第 7 项、docs/12 §6）。
 *
 * 与散落在各处的单元级安全测试**互补**，而不是重复：那些测试证明"某个判据存在"，
 * 这一组证明**它们在真实服务边界上组合起来仍然成立**。三件单元测试做不到的事：
 *
 * 1. **零副作用**：越权请求被拒之后，磁盘上的事实必须**一字未改**——
 *    逐文件比字节，而不是"看返回码是 403 就放心了"。
 * 2. **凭据穷举**：把所有返回对象与错误详情递归扫一遍哨兵，而不是抽查一两个字段。
 * 3. **不泄露存在性**：被拒时不能通过错误消息/列表内容反推"另一条流水线存在"。
 *
 * 发布门槛的判定是"这一组必须全绿"，因此这里的每条断言都必须是**确定性**的。
 *
 * @module test/m5-security-gate
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import type { PipelineConfig } from '../src/types.ts'
import { FilePipelineRunService } from '../src/web/pipeline-run-service.ts'
import { PipelineRunError, type ActorContext } from '../src/web/pipeline-run-types.ts'
import { API_KEY, CREATE, REVIEWER, SCOPE, ScriptedHost, baseConfig } from './web-fixtures.ts'

let dir: string
let config: PipelineConfig

test.beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'pp-m5-security-'))
  config = baseConfig()
})
test.afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

function serviceOf(host: ScriptedHost): FilePipelineRunService {
  return new FilePipelineRunService({
    dataRoot: dir,
    loadConfig: async () => config,
    createHost: host.factory,
  })
}

/** 只读身份：能看，不能改。 */
const VIEWER: ActorContext = { actorId: 'viewer-1', tenantId: 'acme', roles: ['viewer'] }
/** 无角色身份（`assertXxxRole` 是失败关闭的，因此它等价于 viewer）。 */
const NO_ROLE: ActorContext = { actorId: 'nobody', tenantId: 'acme' }

/** 跑到 receive 人工门并停住。 */
async function parkedAtGate(): Promise<{ readonly service: FilePipelineRunService; readonly host: ScriptedHost }> {
  const host = new ScriptedHost()
  const service = serviceOf(host)
  await service.create(CREATE, REVIEWER)
  const result = await service.run('pipe-1', REVIEWER)
  assert.equal(result.outcome, 'waiting-human', '前置：必须停在人工门')
  return { service, host }
}

/**
 * 项目目录的**字节级快照**：`相对路径 → sha256`。
 *
 * 用字节而不是"读出来 deepEqual"，因为要抓的正是"被改写了一个字段"这种变化；
 * 而且哈希不会把凭据带进断言失败信息里。
 */
async function snapshotProject(): Promise<Readonly<Record<string, string>>> {
  const out: Record<string, string> = {}
  async function walk(current: string): Promise<void> {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const full = join(current, entry.name)
      if (entry.isDirectory()) { await walk(full); continue }
      if (!entry.isFile()) continue
      const info = await stat(full)
      out[full.slice(dir.length + 1)] = `${info.size}:${createHash('sha256').update(await readFile(full)).digest('hex')}`
    }
  }
  await walk(dir)
  return out
}

/** 递归扫描任意返回值，收集所有字符串（用于凭据穷举）。 */
function stringsOf(value: unknown, depth = 0): string[] {
  if (depth > 12) return []
  if (typeof value === 'string') return [value]
  if (value === null || typeof value !== 'object') return []
  if (Array.isArray(value)) return value.flatMap(item => stringsOf(item, depth + 1))
  return Object.entries(value as Record<string, unknown>).flatMap(([key, item]) => [key, ...stringsOf(item, depth + 1)])
}

// ── 门槛 1：越权矩阵 × 零副作用 ──────────────────────────────────────────────

test('门槛1：越权请求一律拒绝，且磁盘事实一字未改（字节级）', async () => {
  const { service } = await parkedAtGate()
  const [task] = await service.listGateTasks(SCOPE, REVIEWER)
  const before = await snapshotProject()

  const attempts: readonly { readonly name: string; readonly run: (actor: ActorContext) => Promise<unknown> }[] = [
    { name: 'claimGate', run: actor => service.claimGate({ ...SCOPE, gateTaskId: task!.gateTaskId }, actor) },
    { name: 'decideGate', run: actor => service.decideGate({ ...SCOPE, gateTaskId: task!.gateTaskId, action: 'approved' }, actor) },
    { name: 'cancelGate', run: actor => service.cancelGate({ ...SCOPE, gateTaskId: task!.gateTaskId }, actor) },
    { name: 'reenter', run: actor => service.reenter({ ...SCOPE, stageId: 'receive', reason: '越权尝试' }, actor) },
  ]

  for (const actor of [VIEWER, NO_ROLE]) {
    for (const attempt of attempts) {
      await assert.rejects(
        () => attempt.run(actor),
        (error: unknown) => {
          assert.ok(error instanceof PipelineRunError, `${attempt.name} 应抛 PipelineRunError`)
          assert.equal(error.code, 'forbidden', `${attempt.name} 对 ${actor.actorId} 必须是 forbidden`)
          return true
        },
      )
    }
  }

  const after = await snapshotProject()
  assert.deepEqual(after, before, '被拒的请求不得产生任何持久化副作用（逐文件字节比对）')
})

test('门槛1b：被拒的裁决不会留下"已认领"痕迹，真 reviewer 之后仍能正常裁决', async () => {
  const { service } = await parkedAtGate()
  const [task] = await service.listGateTasks(SCOPE, REVIEWER)
  await assert.rejects(() => service.claimGate({ ...SCOPE, gateTaskId: task!.gateTaskId }, VIEWER))

  const stillPending = (await service.listGateTasks(SCOPE, REVIEWER))[0]!
  assert.equal(stillPending.status, 'pending', '被拒的认领不得把任务变成 claimed')
  assert.equal(stillPending.claimedBy, undefined)

  const claimed = await service.claimGate({ ...SCOPE, gateTaskId: task!.gateTaskId }, REVIEWER)
  assert.equal(claimed.claimedBy, 'alice')
})

// ── 门槛 2：凭据穷举 ────────────────────────────────────────────────────────

test('门槛2：所有返回对象与错误详情里都不含 provider 凭据（递归穷举）', async () => {
  const { service } = await parkedAtGate()
  const [task] = await service.listGateTasks(SCOPE, REVIEWER)

  const surfaces: readonly unknown[] = [
    await service.list(REVIEWER),
    await service.get('pipe-1', REVIEWER),
    await service.listEvents('pipe-1', REVIEWER),
    await service.getUsage('pipe-1', REVIEWER),
    await service.listGateTasks(SCOPE, REVIEWER),
    await service.getStageArtifact('pipe-1', 'receive', REVIEWER),
  ]

  // 错误详情同样要扫：它是最容易漏掉的一条出网通道。
  const errorSurfaces: unknown[] = []
  for (const attempt of [
    () => service.get('nope', REVIEWER),
    () => service.claimGate({ ...SCOPE, gateTaskId: 'nope' }, REVIEWER),
    () => service.decideGate({ ...SCOPE, gateTaskId: task!.gateTaskId, action: 'changes-needed', note: '' }, REVIEWER),
    () => service.getUsage('nope', REVIEWER),
  ]) {
    try { await attempt() } catch (error) {
      errorSurfaces.push(error instanceof PipelineRunError ? error.toView() : String(error))
    }
  }
  assert.ok(errorSurfaces.length >= 3, '前置：应当至少收集到几条错误详情')

  for (const surface of [...surfaces, ...errorSurfaces]) {
    for (const text of stringsOf(surface)) {
      assert.ok(!text.includes(API_KEY), `返回内容里出现了 provider 凭据：${text.slice(0, 80)}`)
      assert.ok(!text.includes('apiKey'), `返回内容里出现了 apiKey 字段：${text.slice(0, 80)}`)
    }
  }
})

// ── 门槛 3：不泄露存在性 ────────────────────────────────────────────────────

test('门槛3：越权与不存在都不泄露"另一条流水线存在"这件事', async () => {
  const { service } = await parkedAtGate()
  // 造一条属于**别的项目**的流水线（同一 dataRoot、不同 projectId）。
  const otherHost = new ScriptedHost()
  const other = new FilePipelineRunService({
    dataRoot: dir,
    loadConfig: async () => ({ ...config, projectId: 'other-project' }),
    createHost: otherHost.factory,
  })
  await other.create({ projectId: 'other-project', pipelineId: 'secret-pipe', configRef: 'pipeline.yaml' }, REVIEWER)

  // 1. 用自己的身份读别人的流水线：拒绝，且消息里不得出现对方的标识。
  await assert.rejects(
    () => service.get('secret-pipe', REVIEWER),
    (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error)
      assert.ok(!message.includes('other-project'), `不得泄露对方项目标识：${message}`)
      assert.ok(!message.includes('secret-pipe') || error instanceof PipelineRunError,
        '错误消息不应回显请求的标识（它由调用方提供，回显会助长探测）')
      return true
    },
  )

  // 2. 列表不得包含别人的流水线。
  const mine = await service.list(REVIEWER)
  assert.deepEqual(mine.map(item => item.pipelineId), ['pipe-1'], '列表只能含作用域内的流水线')

  // 3. "不存在"与"越权"的**返回码形状**必须一致，否则可以用来枚举。
  const notFound = await service.get('definitely-not-here', REVIEWER).catch((error: unknown) => error as PipelineRunError)
  const forbidden = await service.get('secret-pipe', REVIEWER).catch((error: unknown) => error as PipelineRunError)
  assert.ok(notFound instanceof PipelineRunError && forbidden instanceof PipelineRunError)
  assert.equal(notFound.httpStatus, forbidden.httpStatus,
    `"不存在"(${notFound.code}/${notFound.httpStatus}) 与"越权"(${forbidden.code}/${forbidden.httpStatus}) 的状态码必须一致，否则可枚举`)
})

test('门槛3b：作用域不匹配的消息只回显**调用者自己**的作用域，不回显目标的', async () => {
  // `create` 路径用 `expose`：这条消息会**原样出网**（不像读取路径会被 `not-found` 吞掉），
  // 因此它必须只含调用者自己声明的值。参数顺序传反过一次——那样消息里出现的其实是
  // **配置（目标）**的租户标识，既是错误措辞又是泄露。这里把它钉住。
  const service = serviceOf(new ScriptedHost())
  const error = await service
    .create(CREATE, { actorId: 'bob', tenantId: 'other-tenant' })
    .catch((thrown: unknown) => thrown as PipelineRunError)

  assert.ok(error instanceof PipelineRunError, `期望 PipelineRunError，实际 ${String(error)}`)
  assert.equal(error.code, 'scope-mismatch')
  assert.ok(!error.message.includes('acme'),
    `不得回显目标租户（acme）：${error.message}`)
  assert.ok(error.message.includes('other-tenant'),
    `必须回显调用者自己的租户，否则调用方无法纠错：${error.message}`)
})

// ── 门槛 4：绝不自动批准 ────────────────────────────────────────────────────

test('门槛4：等待超时与任务被取消都不会让阶段自动推进', async () => {
  const host = new ScriptedHost()
  const service = serviceOf(host)
  await service.create(CREATE, REVIEWER)

  // 1. 等待超时（服务默认 gateWaitTimeoutMs: 0 → 只轮询一次就让出控制权）。
  assert.equal((await service.run('pipe-1', REVIEWER)).outcome, 'waiting-human')
  const viewAfterTimeout = await service.get('pipe-1', REVIEWER)
  assert.equal(viewAfterTimeout.status, 'waiting-human')
  assert.notEqual(viewAfterTimeout.stages.find(stage => stage.stageId === 'receive')!.status, 'done',
    '等待超时绝不能让阶段变成 done（那等于自动批准）')

  // 2. 任务被外部取消：取消本身不推进阶段。
  const [task] = await service.listGateTasks(SCOPE, REVIEWER)
  await service.cancelGate({ ...SCOPE, gateTaskId: task!.gateTaskId }, REVIEWER)
  const afterCancel = await service.get('pipe-1', REVIEWER)
  assert.equal(afterCancel.status, 'cancelled', '取消后视图必须反映"已取消"')
  assert.notEqual(afterCancel.stages.find(stage => stage.stageId === 'receive')!.status, 'done',
    '任务被取消同样不能让阶段变成 done')

  // 3. 取消之后再跑一次：**会重新开门**（取消的是"这一次送审"，不是整条流水线），
  //    但绝不会因此变成 done。这条断言把当前语义钉住，免得日后被误改成"取消即通过"。
  assert.equal((await service.run('pipe-1', REVIEWER)).outcome, 'waiting-human')
  const afterRerun = await service.get('pipe-1', REVIEWER)
  assert.equal(afterRerun.status, 'waiting-human')
  assert.notEqual(afterRerun.stages.find(stage => stage.stageId === 'receive')!.status, 'done',
    '重新开门之后阶段仍然不是 done')
  assert.notEqual(afterRerun.openGateTaskId, task!.gateTaskId, '被取消的任务不得被复用，必须是一条新门')
})

// ── 门槛 5：工具权限与配置自检 ──────────────────────────────────────────────

test('门槛5：需审批工具必须有阻塞人工门，否则装配即失败（不靠 prompt 兜）', async () => {
  const { validateApprovalCoverage } = await import('../src/runtime/platform-host.ts')
  // 正常配置（kb_write/case_archive 所在阶段都有阻塞门）必须通过。
  assert.doesNotThrow(() => validateApprovalCoverage(config))

  // 把某阶段的 gate 全部关掉，而它仍允许 kb_write → 必须装配失败。
  const broken = baseConfig()
  const archive = broken.stages.archive
  const tampered: PipelineConfig = {
    ...broken,
    stages: {
      ...broken.stages,
      archive: { ...archive, gate: Object.fromEntries(Object.entries(archive.gate).map(([key, value]) => [key, { ...value, block: false }])) },
    },
  }
  assert.throws(() => validateApprovalCoverage(tampered), /需审批工具缺少阻塞人工门/,
    '允许写库却没有阻塞人工门 = 配置错误，必须启动即失败')
})
