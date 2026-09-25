/**
 * `PipelineRunService` 契约测试（docs/10 §4.3 M0 验收）。
 *
 * 全部用例都用 `ScriptedStageRunner` + 临时目录，**不启动 Web server、不需要 API Key**：
 * - create / get / run / gate / reenter 六条主路径；
 * - 身份、作用域、SSRF 与乐观并发的拒绝路径；
 * - 进程重启后仍能从持久化事实重建状态（新 service 实例、同一 dataRoot）；
 * - API Key 不出现在任何返回值或错误详情里。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { resolvePlatformRoots } from '../src/platform-roots.ts'
import { STAGE_ORDER, type PipelineConfig, type StageId } from '../src/types.ts'
import { DEFAULT_RULESET_VERSION } from '../src/runtime/platform-host.ts'
import type { HumanGateTask } from '../src/runtime/persistence.ts'
import {
  FilePipelineRunService,
  pipelineIndexDir,
  scanPipelineIndex,
  type PipelineRunServiceOptions,
} from '../src/web/pipeline-run-service.ts'
import {
  PipelineRunError,
  type ActorContext,
} from '../src/web/pipeline-run-types.ts'
import {
  API_KEY,
  CREATE,
  REVIEWER,
  SCOPE,
  ScriptedHost,
  baseConfig,
} from './web-fixtures.ts'

let dir: string
let config: PipelineConfig

test.beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'pp-svc-'))
  config = baseConfig()
})
test.afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

function serviceOf(host: ScriptedHost, overrides: Partial<PipelineRunServiceOptions> = {}): FilePipelineRunService {
  return new FilePipelineRunService({
    dataRoot: dir,
    loadConfig: async () => config,
    createHost: host.factory,
    ...overrides,
  })
}

function isCode(code: string) {
  return (error: unknown): boolean => error instanceof PipelineRunError && error.code === code
}

/** 断言运行停在人工门并返回该门任务。 */
async function expectWaitingHuman(result: Awaited<ReturnType<FilePipelineRunService['run']>>) {
  assert.equal(result.outcome, 'waiting-human')
  if (result.outcome !== 'waiting-human') throw new Error('unreachable: run 未停在人工门')
  return result
}

async function openGateTaskOf(service: FilePipelineRunService): Promise<HumanGateTask> {
  const [task] = await service.listGateTasks(SCOPE, REVIEWER)
  assert.ok(task !== undefined, '期望存在一条人工门任务')
  return task
}

async function approve(service: FilePipelineRunService, gateTaskId: string): Promise<void> {
  await service.claimGate({ ...SCOPE, gateTaskId }, REVIEWER)
  await service.decideGate({ ...SCOPE, gateTaskId, action: 'approved' }, REVIEWER)
}

/** 走一遍「创建 → 运行到 receive 人工门 → 裁决批准」。 */
async function parkedAtReceiveGate() {
  const host = new ScriptedHost()
  const service = serviceOf(host)
  await service.create(CREATE, REVIEWER)
  const first = await expectWaitingHuman(await service.run('pipe-1', REVIEWER))
  assert.equal(first.stageId, 'receive')
  const task = await openGateTaskOf(service)
  assert.equal(task.gateTaskId, first.gateTaskId)
  await approve(service, first.gateTaskId)
  return { host, service, task, first }
}

// ── create / get ────────────────────────────────────────────────────────────

test('create 先落盘初始检查点，再返回 queued（docs/10 §1 原则 5）', async () => {
  const service = serviceOf(new ScriptedHost())
  const summary = await service.create(CREATE, REVIEWER)

  assert.equal(summary.status, 'queued')
  assert.equal(summary.nextStage, 'receive')
  assert.equal(summary.projectId, 'demo')
  assert.equal(summary.tenantId, 'acme')
  assert.equal(summary.configRef, 'pipeline.yaml')

  // 路径必须由 resolvePlatformRoots 推导（docs/10 §4.3），而不是服务层自行拼接。
  const roots = resolvePlatformRoots(dir, config)
  const raw = await readFile(join(roots.checkpointRoot, 'pipe-1', 'checkpoint.json'), 'utf8')
  const checkpoint = JSON.parse(raw) as { pipelineId: string; cursor: number; rulesetVersion: string }
  assert.equal(checkpoint.pipelineId, 'pipe-1')
  assert.equal(checkpoint.cursor, 0)
  assert.equal(checkpoint.rulesetVersion, DEFAULT_RULESET_VERSION)
})

test('create 对已存在的 pipelineId 返回 conflict（作用域内唯一）', async () => {
  const service = serviceOf(new ScriptedHost())
  await service.create(CREATE, REVIEWER)
  await assert.rejects(() => service.create(CREATE, REVIEWER), isCode('conflict'))
})

test('create 拒绝非法标识符，不把路径拼接交给下游', async () => {
  const service = serviceOf(new ScriptedHost())
  await assert.rejects(() => service.create({ ...CREATE, pipelineId: '../escape' }, REVIEWER), isCode('invalid-request'))
  await assert.rejects(() => service.create({ ...CREATE, pipelineId: '' }, REVIEWER), isCode('invalid-request'))
})

test('get 对未登记的 pipeline 返回 not-found，不静默编造视图', async () => {
  const service = serviceOf(new ScriptedHost())
  await assert.rejects(() => service.get('missing', REVIEWER), isCode('not-found'))
})

test('get 返回的阶段视图恰好是 M0-3 规定的 12 个字段', async () => {
  const service = serviceOf(new ScriptedHost())
  await service.create(CREATE, REVIEWER)
  const view = await service.get('pipe-1', REVIEWER)

  assert.equal(view.status, 'queued')
  assert.equal(view.cursor, 0)
  assert.equal(view.nextStage, 'receive')
  assert.equal(view.templateVersion, 'v1')
  assert.equal(view.openGateTaskId, null)
  assert.deepEqual(view.reentries, [])
  assert.equal(view.failure, null)
  assert.equal(view.stages.length, STAGE_ORDER.length)

  for (const stage of view.stages) {
    assert.deepEqual(Object.keys(stage).sort(), [
      'artifactPath', 'digest', 'failure', 'finishedAt', 'humanGateTaskId',
      'machineStatus', 'machineViolations', 'reviewFindings', 'reviewVerdict',
      'stageId', 'startedAt', 'status',
    ])
    // 无人工门任务时不得用服务端当前时间冒充阶段时间（不伪装）。
    assert.equal(stage.startedAt, null)
    assert.equal(stage.finishedAt, null)
    assert.equal(stage.failure, null)
    assert.equal(stage.reviewVerdict, null)
    assert.equal(stage.humanGateTaskId, null)
    assert.equal(stage.machineStatus, 'passed')
    assert.deepEqual(stage.machineViolations, [])
  }
})

test('阶段 artifactPath 走统一的 artifactPath 约定', async () => {
  const service = serviceOf(new ScriptedHost())
  await service.create(CREATE, REVIEWER)
  const view = await service.get('pipe-1', REVIEWER)
  assert.equal(view.stages[0]!.artifactPath, 'artifacts/pipe-1/receive.json')
  assert.equal(view.stages[5]!.artifactPath, 'artifacts/pipe-1/archive.json')
})

// ── run：挂起、续跑、拒绝自动批准 ────────────────────────────────────────────

test('run 在人工门超时后返回 waiting-human，并保持任务未决（绝不自动批准）', async () => {
  const host = new ScriptedHost()
  const service = serviceOf(host)
  await service.create(CREATE, REVIEWER)
  const result = await expectWaitingHuman(await service.run('pipe-1', REVIEWER))

  assert.equal(result.stageId, 'receive')
  assert.equal(result.view.status, 'waiting-human')
  assert.equal(result.view.openGateTaskId, result.gateTaskId)
  assert.deepEqual(host.stages, ['receive'])

  const stage = result.view.stages[0]!
  assert.equal(stage.status, 'awaiting-gate')
  assert.equal(stage.humanGateTaskId, result.gateTaskId)
  assert.ok(stage.digest !== '', '产物摘要必须已持久化')

  const task = await openGateTaskOf(service)
  assert.equal(task.status, 'pending')
  assert.equal(task.decision, undefined)
  assert.equal(task.consumedAt, undefined)
  assert.equal(task.machineStatus, 'passed')
})

test('裁决后续跑：已批准的 receive 不重生成产物、不重跑审核', async () => {
  const { host, service } = await parkedAtReceiveGate()
  const before = await service.get('pipe-1', REVIEWER)
  const receiveDigest = before.stages[0]!.digest
  assert.deepEqual(host.stages, ['receive'])

  const second = await expectWaitingHuman(await service.run('pipe-1', REVIEWER))
  assert.equal(second.stageId, 'analyze')
  // receive 未被重新 spawn（否则每次重启都会重复消耗模型预算、覆盖真人已审的产物）。
  assert.deepEqual(host.stages, ['receive', 'analyze'])

  const after = await service.get('pipe-1', REVIEWER)
  assert.equal(after.stages[0]!.status, 'done')
  assert.equal(after.stages[0]!.digest, receiveDigest)
  assert.equal(after.stages[0]!.reviewVerdict, null)
  assert.equal(after.stages[1]!.status, 'awaiting-gate')
})

test('六阶段全部批准后返回 completed', async () => {
  const host = new ScriptedHost()
  const service = serviceOf(host)
  await service.create(CREATE, REVIEWER)

  for (let round = 0; round < STAGE_ORDER.length; round += 1) {
    const result = await expectWaitingHuman(await service.run('pipe-1', REVIEWER))
    assert.equal(result.stageId, STAGE_ORDER[round])
    await approve(service, result.gateTaskId)
  }
  const final = await service.run('pipe-1', REVIEWER)
  assert.equal(final.outcome, 'completed')

  const view = await service.get('pipe-1', REVIEWER)
  assert.equal(view.status, 'completed')
  assert.equal(view.nextStage, null)
  assert.equal(view.cursor, STAGE_ORDER.length)
  assert.equal(view.openGateTaskId, null)
  assert.ok(view.stages.every(stage => stage.status === 'done'))
  // 每阶段恰好 spawn 一次：没有因重启或重入而重复生成。
  assert.deepEqual(host.stages, [...STAGE_ORDER])
})

test('changes-needed 打回重跑并开新门，旧裁决不会被重复消费', async () => {
  const host = new ScriptedHost()
  const service = serviceOf(host)
  await service.create(CREATE, REVIEWER)

  const first = await expectWaitingHuman(await service.run('pipe-1', REVIEWER))
  await service.claimGate({ ...SCOPE, gateTaskId: first.gateTaskId }, REVIEWER)
  await service.decideGate({ ...SCOPE, gateTaskId: first.gateTaskId, action: 'changes-needed', note: '缺少验收标准' }, REVIEWER)

  // driver 消费这条裁决 → 打回 needs-fix → 立即重跑该阶段 → 开一条全新门。
  const after = await expectWaitingHuman(await service.run('pipe-1', REVIEWER))
  assert.equal(after.stageId, 'receive')
  assert.notEqual(after.gateTaskId, first.gateTaskId)
  assert.deepEqual(host.stages, ['receive', 'receive'])

  const tasks = await service.listGateTasks(SCOPE, REVIEWER)
  const old = tasks.find(task => task.gateTaskId === first.gateTaskId)
  assert.equal(old?.status, 'changes-needed')
  assert.ok(old?.consumedAt !== undefined, '旧裁决必须被消费，否则重跑会空转')
  assert.equal(after.view.status, 'waiting-human')
  assert.equal(after.view.openGateTaskId, after.gateTaskId)
})

// ── 人工门：权限、租约与终态 ─────────────────────────────────────────────────

test('人工门裁决要求 reviewer/admin，未声明角色一律拒绝（失败关闭）', async () => {
  const service = serviceOf(new ScriptedHost())
  await service.create(CREATE, REVIEWER)
  const result = await expectWaitingHuman(await service.run('pipe-1', REVIEWER))

  const viewer: ActorContext = { actorId: 'bob', tenantId: 'acme' }
  const viewerRole: ActorContext = { actorId: 'bob', tenantId: 'acme', roles: ['viewer'] }
  for (const actor of [viewer, viewerRole]) {
    await assert.rejects(() => service.claimGate({ ...SCOPE, gateTaskId: result.gateTaskId }, actor), isCode('forbidden'))
    await assert.rejects(
      () => service.decideGate({ ...SCOPE, gateTaskId: result.gateTaskId, action: 'approved' }, actor),
      isCode('forbidden'),
    )
  }
  // 只读查询不需要特权角色。
  assert.equal((await service.listGateTasks(SCOPE, viewer)).length, 1)
  assert.equal((await service.get('pipe-1', viewer)).status, 'waiting-human')
})

test('decide 自动认领，但不抢占他人未过期的 claim', async () => {
  const service = serviceOf(new ScriptedHost())
  await service.create(CREATE, REVIEWER)
  const result = await expectWaitingHuman(await service.run('pipe-1', REVIEWER))

  const other: ActorContext = { actorId: 'carol', tenantId: 'acme', roles: ['reviewer'] }
  const claimed = await service.claimGate({ ...SCOPE, gateTaskId: result.gateTaskId }, other)
  assert.equal(claimed.claimedBy, 'carol')

  await assert.rejects(
    () => service.claimGate({ ...SCOPE, gateTaskId: result.gateTaskId }, REVIEWER),
    isCode('gate-not-claimable'),
  )
  await assert.rejects(
    () => service.decideGate({ ...SCOPE, gateTaskId: result.gateTaskId, action: 'approved' }, REVIEWER),
    isCode('gate-not-claimable'),
  )
})

test('changes-needed/rejected 必须带非空 note，且按「请求不合法」拒绝而不是「门不可裁决」', async () => {
  const service = serviceOf(new ScriptedHost())
  await service.create(CREATE, REVIEWER)
  const result = await expectWaitingHuman(await service.run('pipe-1', REVIEWER))

  // 400 而不是 409：这是请求本身不合法，与「门已是终态」是两件事。
  // 若在这里报 409，页面会去刷新任务状态，而真正该做的是补一个说明。
  for (const action of ['rejected', 'changes-needed'] as const) {
    await assert.rejects(
      () => service.decideGate({ ...SCOPE, gateTaskId: result.gateTaskId, action }, REVIEWER),
      isCode('invalid-request'),
    )
    await assert.rejects(
      () => service.decideGate({ ...SCOPE, gateTaskId: result.gateTaskId, action, note: '   ' }, REVIEWER),
      isCode('invalid-request'),
    )
  }

  // 被拒的请求不留副作用：任务仍未被认领，可以正常裁决。
  const gates = await service.listGateTasks(SCOPE, REVIEWER)
  assert.equal(gates.find(task => task.gateTaskId === result.gateTaskId)?.claimedBy, undefined)
  const decided = await service.decideGate(
    { ...SCOPE, gateTaskId: result.gateTaskId, action: 'rejected', note: '范围不清' },
    REVIEWER,
  )
  assert.equal(decided.decision?.action, 'rejected')
})

test('未知裁决动作被拒绝，不会退化成"缺省批准"', async () => {
  const service = serviceOf(new ScriptedHost())
  await service.create(CREATE, REVIEWER)
  const result = await expectWaitingHuman(await service.run('pipe-1', REVIEWER))
  await assert.rejects(
    () => service.decideGate({ ...SCOPE, gateTaskId: result.gateTaskId, action: 'approve' as 'approved' }, REVIEWER),
    isCode('invalid-request'),
  )
})

test('已裁决的任务不能再次裁决，已消费的裁决不能再次驱动门', async () => {
  const { service, task } = await parkedAtReceiveGate()

  // 已裁决（approved）但尚未被消费：拒绝再次裁决。
  await assert.rejects(
    () => service.decideGate({ ...SCOPE, gateTaskId: task.gateTaskId, action: 'approved' }, REVIEWER),
    isCode('gate-not-decidable'),
  )

  // run 消费该裁决后再裁决：明确报 gate-consumed。
  await service.run('pipe-1', REVIEWER)
  await assert.rejects(
    () => service.decideGate({ ...SCOPE, gateTaskId: task.gateTaskId, action: 'approved' }, REVIEWER),
    isCode('gate-consumed'),
  )
})

test('decide 的乐观并发：expectedUpdatedAt 不匹配时返回 conflict', async () => {
  const service = serviceOf(new ScriptedHost())
  await service.create(CREATE, REVIEWER)
  const result = await expectWaitingHuman(await service.run('pipe-1', REVIEWER))

  await assert.rejects(
    () => service.decideGate({ ...SCOPE, gateTaskId: result.gateTaskId, action: 'approved', expectedUpdatedAt: 1 }, REVIEWER),
    isCode('conflict'),
  )

  // 与磁盘上的当前值一致时正常通过。
  const task = await openGateTaskOf(service)
  const decided = await service.decideGate({ ...SCOPE, gateTaskId: task.gateTaskId, action: 'approved', expectedUpdatedAt: task.updatedAt }, REVIEWER)
  assert.equal(decided.status, 'approved')
  assert.equal(decided.decision?.by, 'alice')
})

test('cancelGate 让流水线进入 cancelled，而不是静默重新开门', async () => {
  const service = serviceOf(new ScriptedHost())
  await service.create(CREATE, REVIEWER)
  const result = await expectWaitingHuman(await service.run('pipe-1', REVIEWER))

  const cancelled = await service.cancelGate({ ...SCOPE, gateTaskId: result.gateTaskId, note: '需求撤回' }, REVIEWER)
  assert.equal(cancelled.status, 'cancelled')
  assert.equal(cancelled.cancellation?.by, 'alice')

  const view = await service.get('pipe-1', REVIEWER)
  assert.equal(view.status, 'cancelled')
  assert.equal(view.failure?.kind, 'cancelled')
  assert.equal(view.failure?.stageId, 'receive')
  assert.equal(view.failure?.detail, '需求撤回')
})

test('门任务跨流水线/跨项目不可操作', async () => {
  const service = serviceOf(new ScriptedHost())
  await service.create(CREATE, REVIEWER)
  const result = await expectWaitingHuman(await service.run('pipe-1', REVIEWER))

  await assert.rejects(
    () => service.claimGate({ projectId: 'demo', pipelineId: 'other-pipe', gateTaskId: result.gateTaskId }, REVIEWER),
    isCode('not-found'),
  )
  await assert.rejects(
    () => service.claimGate({ projectId: 'other-project', pipelineId: 'pipe-1', gateTaskId: result.gateTaskId }, REVIEWER),
    isCode('scope-mismatch'),
  )
  await assert.rejects(
    () => service.claimGate({ ...SCOPE, gateTaskId: 'gate-missing' }, REVIEWER),
    isCode('not-found'),
  )
})

// ── reenter ─────────────────────────────────────────────────────────────────

test('reenter 校验 expectedCurrentDigest，避免覆盖他人新版本', async () => {
  const { service } = await parkedAtReceiveGate()
  await assert.rejects(
    () => service.reenter({ ...SCOPE, stageId: 'receive', reason: '需求变更', expectedCurrentDigest: 'stale-digest' }, REVIEWER),
    isCode('conflict'),
  )

  const view = await service.get('pipe-1', REVIEWER)
  const checkpoint = await service.reenter({
    ...SCOPE, stageId: 'receive', reason: '需求变更', expectedCurrentDigest: view.stages[0]!.digest,
  }, REVIEWER)
  assert.equal(checkpoint.cursor, 0)
  assert.equal(checkpoint.reentries.length, 1)
  assert.equal(checkpoint.reentries[0]!.by, 'alice')
  assert.equal(checkpoint.reentries[0]!.reason, '需求变更')
  assert.equal(checkpoint.stageStates.receive.status, 'needs-reentry')
})

test('reenter 拒绝未知阶段与空 reason', async () => {
  const service = serviceOf(new ScriptedHost())
  await service.create(CREATE, REVIEWER)
  await assert.rejects(
    () => service.reenter({ ...SCOPE, stageId: 'nope' as StageId, reason: 'x' }, REVIEWER),
    isCode('invalid-request'),
  )
  await assert.rejects(
    () => service.reenter({ ...SCOPE, stageId: 'receive', reason: '   ' }, REVIEWER),
    isCode('invalid-request'),
  )
})

test('reenter 不需要 API Key（只动检查点）', async () => {
  const service = serviceOf(new ScriptedHost())
  await service.create(CREATE, REVIEWER)
  // 用一个不会解析 provider 的宿主工厂：reenter 走 createCheckpointHost，不该碰它。
  const failing = new FilePipelineRunService({
    dataRoot: dir,
    loadConfig: async () => config,
    createHost: () => { throw new Error('reenter 不应装配完整宿主') },
  })
  const checkpoint = await failing.reenter({ ...SCOPE, stageId: 'analyze', reason: '需求变更' }, REVIEWER)
  assert.equal(checkpoint.cursor, 1)
  void service
})

// ── 身份、作用域与 SSRF ─────────────────────────────────────────────────────

test('空 actorId 一律 unauthenticated', async () => {
  const service = serviceOf(new ScriptedHost())
  await assert.rejects(() => service.create(CREATE, { actorId: '  ' }), isCode('unauthenticated'))
  await assert.rejects(() => service.get('pipe-1', { actorId: '' }), isCode('unauthenticated'))
  await assert.rejects(() => service.listGateTasks(SCOPE, { actorId: '' }), isCode('unauthenticated'))
})

test('租户不匹配与项目白名单外一律拒绝（不靠前端传参决定越权）', async () => {
  const service = serviceOf(new ScriptedHost())
  await service.create(CREATE, REVIEWER)

  await assert.rejects(() => service.get('pipe-1', { actorId: 'mallory', tenantId: 'other' }), isCode('scope-mismatch'))
  await assert.rejects(
    () => service.create({ ...CREATE, pipelineId: 'pipe-2' }, { actorId: 'bob', tenantId: 'acme', projectIds: ['other'] }),
    isCode('forbidden'),
  )
  // 白名单包含目标项目时放行。
  const ok = await service.create({ ...CREATE, pipelineId: 'pipe-3' }, { actorId: 'bob', tenantId: 'acme', projectIds: ['demo'] })
  assert.equal(ok.projectId, 'demo')
})

test('targetBaseUrl 经 SSRF 校验，默认拒绝本机与内网', async () => {
  const service = serviceOf(new ScriptedHost())
  const cases: readonly (readonly [string, string])[] = [
    ['http://127.0.0.1:8080', 'forbidden'],
    ['http://localhost:3000', 'forbidden'],
    ['http://10.0.0.5/api', 'forbidden'],
    ['http://172.16.3.4/api', 'forbidden'],
    ['http://192.168.1.9/api', 'forbidden'],
    ['http://169.254.169.254/latest/meta-data', 'forbidden'],
    ['http://[::1]:8080', 'forbidden'],
    ['http://svc.internal/api', 'forbidden'],
    ['http://staging.local/api', 'forbidden'],
    ['ftp://staging.example.com', 'invalid-request'],
    ['not-a-url', 'invalid-request'],
  ]
  for (const [url, code] of cases) {
    await assert.rejects(() => service.create({ ...CREATE, pipelineId: 'ssrf', targetBaseUrl: url }, REVIEWER), isCode(code))
  }

  // 公网地址允许；被拒绝的 create 不留下任何半成品状态。
  const ok = await service.create({ ...CREATE, pipelineId: 'ok', targetBaseUrl: 'https://staging.example.com' }, REVIEWER)
  assert.equal(ok.status, 'queued')
  await assert.rejects(() => service.get('ssrf', REVIEWER), isCode('not-found'))
})

test('配置非法时返回 config-invalid，而不是带着坏配置起流水线', async () => {
  const service = new FilePipelineRunService({
    dataRoot: dir,
    loadConfig: async () => { throw new Error('pipeline config parse failed: unexpected token') },
    createHost: new ScriptedHost().factory,
  })
  await assert.rejects(() => service.create(CREATE, REVIEWER), isCode('config-invalid'))
})

// ── 持久化事实与进程重启 ─────────────────────────────────────────────────────

test('新 service 实例（模拟进程重启）能从持久化事实重建同一视图', async () => {
  const first = await parkedAtReceiveGate()
  const before = await first.service.get('pipe-1', REVIEWER)

  // 全新实例：配置缓存、内存状态全部清空，只共享同一个 dataRoot。
  const restartedHost = new ScriptedHost()
  const restarted = serviceOf(restartedHost)
  const after = await restarted.get('pipe-1', REVIEWER)

  assert.deepEqual(after, before)
  assert.equal(after.status, 'waiting-human')
  assert.equal(after.openGateTaskId, before.openGateTaskId)

  // 续跑仍然从该门继续，不重复 spawn receive。
  const resumed = await expectWaitingHuman(await restarted.run('pipe-1', REVIEWER))
  assert.equal(resumed.stageId, 'analyze')
  assert.deepEqual(restartedHost.stages, ['analyze'])
})

test('流水线索引与检查点落在 dataRoot 下的租户/项目目录内', async () => {
  const service = serviceOf(new ScriptedHost())
  await service.create(CREATE, REVIEWER)

  const index = JSON.parse(await readFile(join(pipelineIndexDir(dir), 'pipe-1.json'), 'utf8')) as Record<string, unknown>
  assert.deepEqual(index, { pipelineId: 'pipe-1', tenantId: 'acme', projectId: 'demo', configRef: 'pipeline.yaml' })
  assert.ok(pipelineIndexDir(dir).startsWith(dir))
})

// ── 凭据不泄露 ───────────────────────────────────────────────────────────────

test('API Key 不出现在任何返回值、视图或错误详情里', async () => {
  const { service } = await parkedAtReceiveGate()
  const view = await service.get('pipe-1', REVIEWER)
  const gates = await service.listGateTasks(SCOPE, REVIEWER)
  const runResult = await service.run('pipe-1', REVIEWER)

  for (const payload of [view, gates, runResult]) {
    assert.equal(JSON.stringify(payload).includes(API_KEY), false)
  }
})

test('错误详情递归脱敏（apiKey / authorization / sk- 形态 token）', () => {
  const error = new PipelineRunError('run-failed', 'boom', {
    apiKey: API_KEY,
    nested: { authorization: `Bearer ${API_KEY}` },
    note: `泄漏样例 ${API_KEY}`,
  })
  const serialized = JSON.stringify(error.toJSON())
  assert.equal(serialized.includes(API_KEY), false)
  assert.equal(error.toView().details.apiKey, '[redacted]')
  assert.equal(error.httpStatus, 500)
})

test('错误码到 HTTP 状态的映射覆盖全部前置失败路径', () => {
  const expected: Readonly<Record<string, number>> = {
    'invalid-request': 400,
    unauthenticated: 401,
    forbidden: 403,
    'scope-mismatch': 403,
    'not-found': 404,
    conflict: 409,
    'gate-not-claimable': 409,
    'gate-not-decidable': 409,
    'gate-consumed': 409,
    'config-invalid': 422,
    'provider-unavailable': 503,
    'run-failed': 500,
  }
  for (const [code, status] of Object.entries(expected)) {
    assert.equal(new PipelineRunError(code as never, 'x').httpStatus, status)
  }
})

// ── 索引扫描（docs/10 §5.4 第 7 步恢复扫描的输入）─────────────────────────────

/** 把一条索引项直接写到磁盘（绕过 service，用于构造损坏/越权样本）。 */
async function writeIndexFile(name: string, payload: unknown): Promise<void> {
  const indexDir = pipelineIndexDir(dir)
  await mkdir(indexDir, { recursive: true })
  await writeFile(join(indexDir, name), typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2), 'utf8')
}

test('scanPipelineIndex 对不存在的索引目录返回空结果，而不是报错', async () => {
  assert.deepEqual(await scanPipelineIndex(dir), { entries: [], unreadable: [] })
})

test('scanPipelineIndex 按 pipelineId 排序，保证恢复顺序确定', async () => {
  await writeIndexFile('pipe-c.json', { pipelineId: 'pipe-c', tenantId: null, projectId: 'demo', configRef: 'c.yaml' })
  await writeIndexFile('pipe-a.json', { pipelineId: 'pipe-a', tenantId: null, projectId: 'demo', configRef: 'a.yaml' })
  await writeIndexFile('pipe-b.json', { pipelineId: 'pipe-b', tenantId: null, projectId: 'demo', configRef: 'b.yaml' })

  const scan = await scanPipelineIndex(dir)
  assert.deepEqual(scan.entries.map(entry => entry.pipelineId), ['pipe-a', 'pipe-b', 'pipe-c'])
  assert.deepEqual(scan.unreadable, [])
})

test('scanPipelineIndex 报告损坏索引而不是静默跳过（恢复必须能看见无法恢复的项）', async () => {
  await writeIndexFile('good.json', { pipelineId: 'good', tenantId: null, projectId: 'demo', configRef: 'p.yaml' })
  await writeIndexFile('broken-json.json', '{ 这不是 JSON')
  await writeIndexFile('missing-field.json', { pipelineId: 'missing-field' })
  await writeIndexFile('mismatch.json', { pipelineId: 'other-id', tenantId: null, projectId: 'demo', configRef: 'p.yaml' })

  const scan = await scanPipelineIndex(dir)
  assert.deepEqual(scan.entries.map(entry => entry.pipelineId), ['good'])
  assert.deepEqual(scan.unreadable.map(item => item.file).sort(), ['broken-json.json', 'mismatch.json', 'missing-field.json'])
  assert.match(scan.unreadable.find(item => item.file === 'mismatch.json')!.reason, /与文件名不一致/)
})

// ── list：枚举调用者可见的流水线 ──────────────────────────────────────────────

test('list 只返回调用者作用域内的流水线，越权项不泄露标识', async () => {
  const service = serviceOf(new ScriptedHost())
  await service.create(CREATE, REVIEWER)

  const visible = await service.list(REVIEWER)
  assert.deepEqual(visible.map(item => item.pipelineId), ['pipe-1'])
  assert.equal(visible[0]!.status, 'queued')
  assert.equal(visible[0]!.projectId, 'demo')
  assert.equal(visible[0]!.configRef, 'pipeline.yaml')
  assert.equal(visible[0]!.nextStage, 'receive')

  // 项目白名单不含 demo：既不返回条目，也不通过报错泄露它存在。
  const outsider: ActorContext = { actorId: 'bob', tenantId: 'acme', projectIds: ['other-project'] }
  assert.deepEqual(await service.list(outsider), [])
})

test('list 的状态来自持久化事实：停在人工门后变为 waiting-human', async () => {
  const { service } = await parkedAtReceiveGate()
  const [summary] = await service.list(REVIEWER)
  assert.equal(summary!.status, 'waiting-human')
  // 裁决已批准但尚未被消费：cursor 仍停在 receive，下一次 run 要做的正是消费它。
  // 因此 nextStage 是 receive 而不是 analyze（analyze 要等这次消费完成才轮到）。
  assert.equal(summary!.nextStage, 'receive')
})

test('list 跳过索引损坏或配置不可解析的项，不用半成品状态冒充成功', async () => {
  const service = serviceOf(new ScriptedHost())
  await service.create(CREATE, REVIEWER)
  await writeIndexFile('broken.json', '{ 不是 JSON')
  // 指向不存在的配置：可读出索引，但 config-invalid，必须被跳过。
  await writeIndexFile('orphan.json', { pipelineId: 'orphan', tenantId: null, projectId: 'demo', configRef: 'no-such.yaml' })

  const visible = await service.list(REVIEWER)
  assert.deepEqual(visible.map(item => item.pipelineId), ['pipe-1'])
})

test('list 空 actorId 一律 unauthenticated', async () => {
  const service = serviceOf(new ScriptedHost())
  await assert.rejects(() => service.list({ actorId: '  ' }), isCode('unauthenticated'))
})

test('配置声明 scope.environment 时服务仍可用（部署维度不参与调用者作用域比较）', async () => {
  // 回归：`assertScope` 曾把 `scope.environment` 也拿去和调用者比较，而 `ActorContext`
  // 从不携带 environment，导致**任何声明了它的配置永久不可用**
  // （`expected staging, got (missing)`）。示例配置 examples/pipeline.yaml 正是这种情况。
  config = baseConfig({ scope: { tenantId: 'acme', environment: 'staging' } })
  const host = new ScriptedHost()
  const service = serviceOf(host)

  const summary = await service.create(CREATE, REVIEWER)
  assert.equal(summary.status, 'queued')
  // 项目目录只由租户与项目推导，environment 不影响路径。
  const roots = resolvePlatformRoots(dir, config)
  assert.ok(roots.projectRoot.endsWith(join('tenants', 'acme', 'projects', 'demo')))
  assert.equal(roots.projectRoot.includes('staging'), false)
  assert.equal((await service.get('pipe-1', REVIEWER)).status, 'queued')
})

// ── getStageArtifact：回读产物文件 ────────────────────────────────────────────

test('getStageArtifact 在阶段尚未产出时返回 null，不编造空产物', async () => {
  const service = serviceOf(new ScriptedHost())
  await service.create(CREATE, REVIEWER)
  assert.equal(await service.getStageArtifact('pipe-1', 'receive', REVIEWER), null)
})

test('getStageArtifact 回读真实产物内容、digest 与相对路径', async () => {
  const { service } = await parkedAtReceiveGate()
  const artifact = await service.getStageArtifact('pipe-1', 'receive', REVIEWER)
  assert.ok(artifact !== null)
  assert.equal(artifact.stageId, 'receive')
  // 相对产物根的路径：不向浏览器泄露服务器部署布局。
  assert.equal(artifact.artifactPath, 'artifacts/pipe-1/receive.json')
  assert.equal(artifact.artifactPath.startsWith('/'), false)
  assert.equal(artifact.version, 1)
  assert.deepEqual(artifact.content, { stage: 'receive', summary: 'scripted artifact for receive' })
  assert.match(artifact.digest, /^[0-9a-f]{16,}$/)
  // digest 必须与检查点里持久化的那份一致，否则页面会展示一个"算出来对不上"的值。
  const view = await service.get('pipe-1', REVIEWER)
  assert.equal(artifact.digest, view.stages[0]!.digest)
})

test('getStageArtifact 拒绝未知阶段与越权调用者', async () => {
  const service = serviceOf(new ScriptedHost())
  await service.create(CREATE, REVIEWER)
  await assert.rejects(
    () => service.getStageArtifact('pipe-1', 'not-a-stage' as never, REVIEWER),
    isCode('invalid-request'),
  )
  const outsider: ActorContext = { actorId: 'bob', tenantId: 'acme', projectIds: ['other-project'] }
  await assert.rejects(() => service.getStageArtifact('pipe-1', 'receive', outsider), isCode('forbidden'))
})
