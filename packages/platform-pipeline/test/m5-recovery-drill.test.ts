/**
 * M5 恢复发布门槛：**自动化恢复演练**（docs/11 §9 批次 E 第 7 项、docs/12 §5.2）。
 *
 * 演练不是"文档里写一遍流程"，而是每次全量测试都真的跑一遍：
 *
 * ```text
 * 造现场（跑到第二个门） → 快照 = 备份 → 拷到全新 dataRoot → 新进程实例
 *   → 视图必须与备份前逐字相同 → recover 判定必须正确 → 批准后必须从原 cursor 继续
 * ```
 *
 * 三条硬断言（对应 docs/12 §5.2 的演练步骤 3/4/5）：
 * 1. 恢复后 `get` 与备份前**逐字相同**（不是"差不多"，是 deepEqual）；
 * 2. 停在人工门的流水线在恢复扫描里必须是 `await-human` 且 `started: false`；
 * 3. 恢复后继续跑，**已完成的阶段不得被重跑**（否则恢复等于把预算烧一遍）。
 *
 * @module test/m5-recovery-drill
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cp, mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import type { PipelineConfig } from '../src/types.ts'
import { resolvePlatformRoots } from '../src/platform-roots.ts'
import { AsyncPipelineRunner } from '../src/web/async-runner.ts'
import { FilePipelineRunService } from '../src/web/pipeline-run-service.ts'
import type { ActorContext, PipelineRunView } from '../src/web/pipeline-run-types.ts'
import { CREATE, REVIEWER, SCOPE, ScriptedHost, baseConfig } from './web-fixtures.ts'

/** 后台运行身份：刻意不声明角色（恢复扫描不得替人裁决）。 */
const RUNNER: ActorContext = { actorId: 'recovery-runner', tenantId: 'acme' }

let dir: string
let config: PipelineConfig

test.beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'pp-recovery-'))
  config = baseConfig()
})
test.afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

function serviceOf(dataRoot: string, host: ScriptedHost): FilePipelineRunService {
  return new FilePipelineRunService({
    dataRoot,
    loadConfig: async () => config,
    createHost: host.factory,
  })
}

/**
 * 造一个"跑了一半"的现场：receive 已批准并完成，analyze 停在人工门。
 *
 * 这样才有东西可验：一个已完成阶段（不能被重跑）+ 一个未决门（必须被续用）+
 * 一份冻结的检查点与产物。
 */
async function halfDonePipeline(): Promise<{
  readonly service: FilePipelineRunService
  readonly host: ScriptedHost
  readonly before: PipelineRunView
  readonly openGateTaskId: string
}> {
  const host = new ScriptedHost()
  const service = serviceOf(dir, host)
  await service.create(CREATE, REVIEWER)

  assert.equal((await service.run('pipe-1', REVIEWER)).outcome, 'waiting-human')
  const [receiveTask] = await service.listGateTasks(SCOPE, REVIEWER)
  await service.claimGate({ ...SCOPE, gateTaskId: receiveTask!.gateTaskId }, REVIEWER)
  await service.decideGate({ ...SCOPE, gateTaskId: receiveTask!.gateTaskId, action: 'approved' }, REVIEWER)
  assert.equal((await service.run('pipe-1', REVIEWER)).outcome, 'waiting-human', 'analyze 应停在人工门')

  const before = await service.get('pipe-1', REVIEWER)
  assert.equal(before.stages.filter(stage => stage.status === 'done').length, 1, '前置：恰好一个阶段已完成')
  assert.ok(before.openGateTaskId !== null, '前置：必须有一个未决门')
  return { service, host, before, openGateTaskId: before.openGateTaskId }
}

test('恢复演练：备份 → 恢复到全新 dataRoot → 视图逐字相同、判定正确、不重跑已完成阶段', async () => {
  const { before, openGateTaskId } = await halfDonePipeline()

  // ── 1. 备份：停写之后整棵拷贝（docs/12 §5.1 的"静止点"要求）───────────────
  const restored = await mkdtemp(join(tmpdir(), 'pp-recovery-restored-'))
  try {
    await cp(dir, restored, { recursive: true })

    // ── 2. 全新进程实例（新 service + 新宿主），只共享恢复出来的 dataRoot ──────
    const restoredHost = new ScriptedHost()
    const service = serviceOf(restored, restoredHost)

    const after = await service.get('pipe-1', REVIEWER)
    assert.deepEqual(after, before, '恢复后的视图必须与备份前逐字相同')

    // ── 3. 恢复扫描：停在人工门 → await-human，且**不启动** ──────────────────
    const runner = new AsyncPipelineRunner({ service, dataRoot: restored, actor: RUNNER })
    const outcomes = await runner.recover()
    const mine = outcomes.find(item => item.pipelineId === 'pipe-1')!
    assert.equal(mine.action, 'await-human', '停在人工门必须等真人，恢复扫描不得替人裁决')
    assert.equal(mine.started, false)
    await runner.idle()
    assert.deepEqual(restoredHost.stages, [], 'await-human 不得触发任何 spawn')

    // ── 4. 真人批准之后必须从原 cursor 继续，且**不重跑已完成的阶段** ─────────
    //    注意：列表按 createdAt 升序，第 0 条是 receive 那条**已消费**的旧任务，
    //    因此这里必须显式挑未决的那条。
    const restoredTasks = await service.listGateTasks(SCOPE, REVIEWER)
    const open = restoredTasks.find(item => item.status === 'pending' || item.status === 'claimed')
    assert.ok(open !== undefined, '恢复后必须仍有未决门')
    assert.equal(open.gateTaskId, openGateTaskId, '未决门必须被完整恢复（不是重新开一条）')
    await service.claimGate({ ...SCOPE, gateTaskId: open.gateTaskId }, REVIEWER)
    await service.decideGate({ ...SCOPE, gateTaskId: open.gateTaskId, action: 'approved' }, REVIEWER)
    const resumed = await service.run('pipe-1', REVIEWER)

    assert.equal(resumed.outcome, 'waiting-human', '批准 analyze 后应停在 design 的人工门')
    // `restoredHost` 是恢复之后新建的宿主，因此它的 stages 只记录**恢复之后**的 spawn。
    // 期望恰好是 ['design']：receive 与 analyze 都已 done，一个都不许被重跑
    // （重跑它们等于把预算烧一遍，而且会把已被真人审核过的产物覆盖成新版本）。
    assert.deepEqual(restoredHost.stages, ['design'],
      `恢复后只应 spawn 下一个阶段 design（实际 ${JSON.stringify(restoredHost.stages)}）`)

    const final = await service.get('pipe-1', REVIEWER)
    assert.equal(final.stages.filter(stage => stage.status === 'done').length, 2, 'receive 与 analyze 都应为 done')
  } finally {
    await rm(restored, { recursive: true, force: true })
  }
})

test('恢复演练：终态流水线在恢复扫描里是 terminal，不会被重启', async () => {
  // 用取消制造一个终态（`cancelled` 在 decideRecovery 里属 terminal）。
  const host = new ScriptedHost()
  const service = serviceOf(dir, host)
  await service.create(CREATE, REVIEWER)
  await service.run('pipe-1', REVIEWER)
  const [task] = await service.listGateTasks(SCOPE, REVIEWER)
  await service.cancelGate({ ...SCOPE, gateTaskId: task!.gateTaskId }, REVIEWER)
  assert.equal((await service.get('pipe-1', REVIEWER)).status, 'cancelled')

  const restored = await mkdtemp(join(tmpdir(), 'pp-recovery-terminal-'))
  try {
    await cp(dir, restored, { recursive: true })
    const restoredHost = new ScriptedHost()
    const restoredService = serviceOf(restored, restoredHost)
    assert.equal((await restoredService.get('pipe-1', REVIEWER)).status, 'cancelled')

    const runner = new AsyncPipelineRunner({ service: restoredService, dataRoot: restored, actor: RUNNER })
    const outcomes = await runner.recover()
    const mine = outcomes.find(item => item.pipelineId === 'pipe-1')!
    assert.equal(mine.action, 'terminal')
    assert.equal(mine.started, false)
    await runner.idle()
    assert.deepEqual(restoredHost.stages, [], '终态不得被恢复扫描重启')
  } finally {
    await rm(restored, { recursive: true, force: true })
  }
})

test('恢复演练：检查点缺失的流水线被显式报告，不被静默跳过', async () => {
  await halfDonePipeline()
  const restored = await mkdtemp(join(tmpdir(), 'pp-recovery-missing-'))
  try {
    await cp(dir, restored, { recursive: true })
    // 删掉检查点：只剩清单与门任务 → 这是一条"看得见但恢复不了"的项。
    await rm(join(resolvePlatformRoots(restored, config).checkpointRoot, 'pipe-1'), { recursive: true, force: true })

    const restoredHost = new ScriptedHost()
    const service = serviceOf(restored, restoredHost)
    const runner = new AsyncPipelineRunner({ service, dataRoot: restored, actor: RUNNER })
    const outcomes = await runner.recover()

    // 恢复扫描必须把"看得见但恢复不了"的项报出来，而不是当它不存在。
    const reported = outcomes.find(item => item.pipelineId === 'pipe-1')
    assert.ok(reported !== undefined, '索引还在，因此这一项必须出现在恢复结果里')
    assert.notEqual(reported.action, 'resume', '检查点都没了，不能假装能续跑')
    await runner.idle()
  } finally {
    await rm(restored, { recursive: true, force: true })
  }
})
