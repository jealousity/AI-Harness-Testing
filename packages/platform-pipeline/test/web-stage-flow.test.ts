/**
 * 六阶段流转闭环与派生字段的测试（`docs/14` W3）。
 *
 * 三块内容：
 * 1. **`deriveNextAction` 的映射表**（纯函数，逐行覆盖）——它是"页面该显示什么按钮"的
 *    唯一来源，因此必须比 UI 更早、更严地被钉住；
 * 2. **视图派生字段**在真实 service 上的表现（`currentStage` / `nextAction` /
 *    `blockingReason` / `gateKind`）；
 * 3. **阶段门 vs 升级任务**的显式区分（`isEscalation`），以及六阶段逐阶段推进。
 *
 * 为什么这些必须存在：派生字段的价值全在"与服务端真实行为一致"。若 `nextAction` 说
 * `decide-gate` 而服务端拒绝，或说 `run` 而其实该先消费裁决，页面就会引导用户走向
 * 一连串 409——比不显示按钮更糟。
 *
 * @module platform-pipeline/test/web-stage-flow
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { STAGE_ORDER, type PipelineConfig } from '../src/types.ts'
import { FilePipelineRunService } from '../src/web/pipeline-run-service.ts'
import {
  deriveNextAction,
  type GateTaskKind,
  type NextActionFacts,
} from '../src/web/pipeline-run-types.ts'
import { CREATE, REVIEWER, SCOPE, ScriptedHost, baseConfig } from './web-fixtures.ts'

let dir: string
let config: PipelineConfig

test.beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'pp-w3-'))
  config = baseConfig()
})
test.afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

function serviceOf(host: ScriptedHost): FilePipelineRunService {
  return new FilePipelineRunService({ dataRoot: dir, loadConfig: async () => config, createHost: host.factory })
}

function facts(overrides: Partial<NextActionFacts> = {}): NextActionFacts {
  return {
    status: 'queued',
    currentStage: 'receive',
    currentStageStatus: 'idle',
    gateKind: null,
    gateStatus: null,
    ...overrides,
  }
}

/** 批准当前未决门（认领 + 批准），不触发下一次 run。 */
async function approveOpenGate(service: FilePipelineRunService): Promise<void> {
  const open = (await service.listGateTasks(SCOPE, REVIEWER))
    .find(task => task.status === 'pending' || task.status === 'claimed')
  assert.ok(open !== undefined, '等待人工门时必须存在未决门任务')
  await service.claimGate({ ...SCOPE, gateTaskId: open.gateTaskId }, REVIEWER)
  await service.decideGate({ ...SCOPE, gateTaskId: open.gateTaskId, action: 'approved' }, REVIEWER)
}

// ── 1. deriveNextAction 映射表 ────────────────────────────────────────────────

test('W3：running → none（后台运行进行中，此刻没有"正确的人工动作"）', () => {
  const decision = deriveNextAction(facts({ status: 'running', currentStageStatus: 'running' }))
  assert.equal(decision.action, 'none')
  assert.match(String(decision.reason), /后台运行进行中/)
})

test('W3：queued → run；已登记重入时理由不同', () => {
  assert.equal(deriveNextAction(facts({ status: 'queued' })).action, 'run')
  assert.match(String(deriveNextAction(facts({ status: 'queued' })).reason), /尚未开始/)

  const reentered = deriveNextAction(facts({ status: 'queued', currentStageStatus: 'needs-reentry' }))
  assert.equal(reentered.action, 'run')
  assert.match(String(reentered.reason), /重入已登记/)
})

test('W3：needs-fix → run（打回后要显式再跑一次）', () => {
  const decision = deriveNextAction(facts({ status: 'needs-fix', currentStageStatus: 'needs-fix' }))
  assert.equal(decision.action, 'run')
  assert.match(String(decision.reason), /打回/)
})

test('W3：waiting-human + 阶段门 → decide-gate（认领由服务端自动完成，不是前置步骤）', () => {
  const decision = deriveNextAction(facts({
    status: 'waiting-human', currentStage: 'design', currentStageStatus: 'awaiting-gate',
    gateKind: 'stage', gateStatus: 'pending',
  }))
  assert.equal(decision.action, 'decide-gate')
  assert.match(String(decision.reason), /design/)
  assert.match(String(decision.reason), /自动完成/,
    '必须说清认领不是前置条件——否则页面会多一个非必需步骤')
})

test('W3：waiting-human + 已被他人认领 → 仍是 decide-gate，但理由说明冲突风险', () => {
  const decision = deriveNextAction(facts({
    status: 'waiting-human', gateKind: 'stage', gateStatus: 'claimed',
  }))
  assert.equal(decision.action, 'decide-gate')
  assert.match(String(decision.reason), /已被认领/)
})

test('W3：waiting-human + 升级任务 → decide-gate，且理由点名"升级"', () => {
  const decision = deriveNextAction(facts({
    status: 'waiting-human', gateKind: 'escalation', gateStatus: 'pending',
  }))
  assert.equal(decision.action, 'decide-gate')
  assert.match(String(decision.reason), /升级/)
})

test('W3：waiting-human 但**没有未决门** → run（去消费已登记的裁决）', () => {
  const decision = deriveNextAction(facts({ status: 'waiting-human', gateKind: null }))
  assert.equal(decision.action, 'run')
  assert.match(String(decision.reason), /尚未被消费/)
})

test('W3：全部终态都给 reenter，绝不出现 decide-gate / claim-gate', () => {
  for (const status of ['gate-failed', 'review-failed', 'rejected', 'cancelled', 'failed'] as const) {
    // 即使带着一个未决门，终态也不允许出现批准类动作（docs/14 W3 第 7 条）。
    const decision = deriveNextAction(facts({
      status, gateKind: 'escalation', gateStatus: 'pending',
    }))
    assert.equal(decision.action, 'reenter', `${status} 必须是 reenter，实际 ${decision.action}`)
    assert.notEqual(decision.action, 'decide-gate')
    assert.notEqual(decision.action, 'claim-gate')
  }
})

test('W3：completed → view-artifact 且没有 blockingReason', () => {
  const decision = deriveNextAction(facts({ status: 'completed', currentStage: null, currentStageStatus: null }))
  assert.equal(decision.action, 'view-artifact')
  assert.equal(decision.reason, null, '已完成没有"待办理由"可说，不要编一句')
})

test('W3：deriveNextAction 永不产出 retry-storage（视图能构建就说明存储可用）', () => {
  const statuses = ['queued', 'running', 'waiting-human', 'needs-fix', 'gate-failed', 'review-failed', 'rejected', 'completed', 'failed', 'cancelled'] as const
  const gateKinds: readonly (GateTaskKind | null)[] = [null, 'stage', 'escalation']
  for (const status of statuses) {
    for (const gateKind of gateKinds) {
      const decision = deriveNextAction(facts({ status, gateKind, gateStatus: gateKind === null ? null : 'pending' }))
      assert.notEqual(decision.action, 'retry-storage',
        `${status}/${gateKind} 不该产出 retry-storage：它由 HTTP 层在 503 时使用`)
    }
  }
})

// ── 2. 视图派生字段（真实 service）────────────────────────────────────────────

test('W3：新建流水线 → queued / currentStage=receive / nextAction=run', async () => {
  const service = serviceOf(new ScriptedHost())
  await service.create(CREATE, REVIEWER)

  const view = await service.get('pipe-1', REVIEWER)
  assert.equal(view.status, 'queued')
  assert.equal(view.currentStage, 'receive')
  assert.equal(view.nextAction, 'run')
  assert.equal(view.gateKind, null)
  assert.equal(view.openGateTaskId, null)
})

test('W3：跑到人工门 → waiting-human / decide-gate / gateKind=stage', async () => {
  const service = serviceOf(new ScriptedHost())
  await service.create(CREATE, REVIEWER)
  await service.run('pipe-1', REVIEWER)

  const view = await service.get('pipe-1', REVIEWER)
  assert.equal(view.status, 'waiting-human')
  assert.equal(view.currentStage, 'receive')
  assert.equal(view.nextAction, 'decide-gate')
  assert.equal(view.gateKind, 'stage', '阶段门必须是 stage，不能被当成升级任务')
  assert.ok(view.openGateTaskId !== null)
})

test('W3：裁决已下但未消费 → waiting-human / nextAction=run', async () => {
  const service = serviceOf(new ScriptedHost())
  await service.create(CREATE, REVIEWER)
  await service.run('pipe-1', REVIEWER)
  await approveOpenGate(service)   // 只裁决，不 run

  const view = await service.get('pipe-1', REVIEWER)
  assert.equal(view.status, 'waiting-human')
  assert.equal(view.gateKind, null, '裁决已下，此刻没有未决门')
  assert.equal(view.nextAction, 'run', '下一步是触发运行以消费裁决')
  assert.match(String(view.blockingReason), /尚未被消费/)
})

test('W3：currentStage 与 nextStage 在全部阶段都一致（语义不同但当前恒等）', async () => {
  const service = serviceOf(new ScriptedHost())
  await service.create(CREATE, REVIEWER)

  // 逐阶段推进：每次先跑到该阶段的人工门，再断言派生字段。
  for (const stageId of STAGE_ORDER) {
    await service.run('pipe-1', REVIEWER)
    const view = await service.get('pipe-1', REVIEWER)
    assert.equal(view.currentStage, stageId, `应停在 ${stageId}`)
    assert.equal(view.nextStage, stageId, `游标也应指向 ${stageId}`)
    assert.equal(view.currentStage, view.nextStage,
      '当前实现下两者必须一致；若某天分叉，必须有测试解释原因')
    assert.equal(view.stages.find(stage => stage.stageId === stageId)!.status, 'awaiting-gate')
    await approveOpenGate(service)
  }

  // 最后一次批准之后还要再跑一次才会消费它并进入终态。
  await service.run('pipe-1', REVIEWER)

  // 六阶段全部完成：currentStage 归 null，nextAction 指向产物。
  const done = await service.get('pipe-1', REVIEWER)
  assert.equal(done.status, 'completed')
  assert.equal(done.currentStage, null)
  assert.equal(done.nextStage, null)
  assert.equal(done.nextAction, 'view-artifact')
  assert.deepEqual(done.stages.map(stage => stage.status), STAGE_ORDER.map(() => 'done'))
})

// ── 3. 阶段门 vs 升级任务 ─────────────────────────────────────────────────────

test('W3：阶段门 isEscalation=false；升级任务 isEscalation=true 且不可被当作阶段批准', async () => {
  const host = new ScriptedHost({ budgetExceededStages: ['receive'] })
  const service = serviceOf(host)
  await service.create(CREATE, REVIEWER)
  assert.equal((await service.run('pipe-1', REVIEWER)).outcome, 'gate-failed')

  const tasks = await service.listGateTasks(SCOPE, REVIEWER)
  const escalation = tasks.find(task => task.isEscalation)
  assert.ok(escalation !== undefined, `预算超限必须留下升级任务：${JSON.stringify(tasks)}`)
  assert.equal(escalation.artifactPath, '', '升级任务不对应产物')
  assert.equal(escalation.machineStatus, 'failed')

  const view = await service.get('pipe-1', REVIEWER)
  assert.equal(view.status, 'gate-failed')
  assert.equal(view.gateKind, 'escalation', 'gate-failed 的未决门必须是升级任务')
  assert.equal(view.nextAction, 'reenter', '终态的动作是重入，不是批准')
  assert.equal(
    view.stages.find(stage => stage.stageId === 'receive')!.humanGateTaskId,
    null,
    '升级任务不得被算作该阶段的阶段门',
  )
})

test('W3：单条门任务返回也带 isEscalation（claim/decide/cancel 三条路径）', async () => {
  const service = serviceOf(new ScriptedHost())
  await service.create(CREATE, REVIEWER)
  await service.run('pipe-1', REVIEWER)

  const openTask = async (): Promise<{ gateTaskId: string }> => {
    const [task] = (await service.listGateTasks(SCOPE, REVIEWER)).filter(item => item.status === 'pending')
    assert.ok(task !== undefined, '期望存在一条待认领的门任务')
    return task
  }

  // 认领 + 裁决走同一条门（阶段门）。
  const first = await openTask()
  const claimed = await service.claimGate({ ...SCOPE, gateTaskId: first.gateTaskId }, REVIEWER)
  assert.equal(claimed.isEscalation, false, '阶段门认领后仍应标成 stage')

  const decided = await service.decideGate({ ...SCOPE, gateTaskId: first.gateTaskId, action: 'approved' }, REVIEWER)
  assert.equal(decided.isEscalation, false)
  assert.equal(decided.status, 'approved')

  // 取消必须用**另一条**门：已批准的任务不可取消（服务端正确地拒绝）。
  await service.run('pipe-1', REVIEWER)
  const second = await openTask()
  assert.notEqual(second.gateTaskId, first.gateTaskId, '推进后应开出一条新的门')
  const cancelled = await service.cancelGate({ ...SCOPE, gateTaskId: second.gateTaskId }, REVIEWER)
  assert.equal(cancelled.isEscalation, false)
  assert.equal(cancelled.status, 'cancelled')
})

// ── 4. 终态不提供批准路径 ─────────────────────────────────────────────────────

test('W3：rejected 终态下 nextAction 是 reenter，且服务端确实拒绝再裁决', async () => {
  const service = serviceOf(new ScriptedHost())
  await service.create(CREATE, REVIEWER)
  await service.run('pipe-1', REVIEWER)
  const [pending] = (await service.listGateTasks(SCOPE, REVIEWER)).filter(task => task.status === 'pending')
  await service.claimGate({ ...SCOPE, gateTaskId: pending!.gateTaskId }, REVIEWER)
  await service.decideGate({ ...SCOPE, gateTaskId: pending!.gateTaskId, action: 'rejected', note: '需求不成立' }, REVIEWER)
  await service.run('pipe-1', REVIEWER)

  const view = await service.get('pipe-1', REVIEWER)
  assert.equal(view.status, 'rejected')
  assert.equal(view.nextAction, 'reenter', '页面因此不会渲染出"批准"按钮')

  // 与派生结论一致：服务端确实不接受再裁决。
  const rejected = await service
    .decideGate({ ...SCOPE, gateTaskId: pending!.gateTaskId, action: 'approved' }, REVIEWER)
    .then(() => null, (error: unknown) => error)
  assert.ok(rejected !== null, '终态裁决必须被拒（否则 nextAction=reenter 就是错的）')
  const code = (rejected as { readonly code?: string }).code
  assert.ok(['gate-not-decidable', 'gate-consumed', 'gate-not-claimable'].includes(String(code)),
    `终态裁决必须被拒，实际 ${String(code)}`)
})
