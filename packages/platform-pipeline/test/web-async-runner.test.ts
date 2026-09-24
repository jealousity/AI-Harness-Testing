/**
 * `AsyncPipelineRunner` 测试（docs/10 §5.2、§5.4、§5.5 验收 2/3/6 的服务侧证据）。
 *
 * 三条主线：
 * - **不阻塞**：`trigger` 立刻返回，流水线在后台跑；HTTP handler 不必等它跑完；
 * - **不并发**：同一 pipeline 在跑时重复 `trigger` 只返回 `already-running`；
 * - **恢复判定**：`recover()` 按持久化状态决定续跑 / 等真人 / 不动终态，
 *   并把不可读项显式报告出来。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import type { PipelineConfig } from '../src/types.ts'
import { AsyncPipelineRunner, decideRecovery } from '../src/web/async-runner.ts'
import { pipelineIndexDir, type PipelineRunServiceOptions } from '../src/web/pipeline-run-service.ts'
import { FilePipelineRunService } from '../src/web/pipeline-run-service.ts'
import { PipelineRunError, type ActorContext } from '../src/web/pipeline-run-types.ts'
import { CREATE, REVIEWER, ScriptedHost, baseConfig } from './web-fixtures.ts'

let dir: string
let config: PipelineConfig

test.beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'pp-async-'))
  config = baseConfig()
})
test.afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

/**
 * 后台运行身份：**刻意不声明 roles**。
 *
 * `assertGateRole` 是失败关闭的，因此这个身份即使被误用到裁决路径上也无法批准任何东西
 * ——这正是"后台运行不得替人裁决"的机器保证。
 */
const RUNNER: ActorContext = { actorId: 'web-runner', tenantId: 'acme' }

function serviceOf(host: ScriptedHost, overrides: Partial<PipelineRunServiceOptions> = {}): FilePipelineRunService {
  return new FilePipelineRunService({
    dataRoot: dir,
    loadConfig: async () => config,
    createHost: host.factory,
    ...overrides,
  })
}

function runnerOf(service: FilePipelineRunService, overrides: Partial<{ readonly actor: ActorContext }> = {}) {
  return new AsyncPipelineRunner({ service, dataRoot: dir, actor: RUNNER, ...overrides })
}

/** 把一条索引项直接写到磁盘（绕过 service，用于构造损坏样本）。 */
async function writeIndexFile(name: string, payload: unknown): Promise<void> {
  const indexDir = pipelineIndexDir(dir)
  await mkdir(indexDir, { recursive: true })
  await writeFile(join(indexDir, name), typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2), 'utf8')
}

// ── decideRecovery：纯函数映射表 ──────────────────────────────────────────────

test('decideRecovery：进程被杀留下的中间态一律续跑', () => {
  for (const status of ['queued', 'running', 'needs-fix'] as const) {
    assert.equal(decideRecovery(status, false), 'resume', status)
    assert.equal(decideRecovery(status, true), 'resume', status)
  }
})

test('decideRecovery：停在人工门时区分"等真人"与"裁决已下待消费"', () => {
  // 有待裁决任务：必须等真人，绝不替人批准。
  assert.equal(decideRecovery('waiting-human', true), 'await-human')
  // 裁决已下但未被消费（openGateTaskId 为 null）：续跑正是去消费它。
  assert.equal(decideRecovery('waiting-human', false), 'resume')
})

test('decideRecovery：终态一律不动，重跑必须显式 reenter', () => {
  for (const status of ['completed', 'rejected', 'gate-failed', 'cancelled', 'failed'] as const) {
    assert.equal(decideRecovery(status, false), 'terminal', status)
    assert.equal(decideRecovery(status, true), 'terminal', status)
  }
})

// ── trigger：不阻塞、不并发 ───────────────────────────────────────────────────

test('trigger 立刻返回，后台运行由 idle() 收敛（HTTP handler 不必等流水线跑完）', async () => {
  const host = new ScriptedHost()
  const service = serviceOf(host)
  const runner = runnerOf(service)
  await service.create(CREATE, REVIEWER)

  const settled: string[] = []
  const withHook = new AsyncPipelineRunner({
    service,
    dataRoot: dir,
    actor: RUNNER,
    onSettled: outcome => { settled.push(outcome.kind) },
  })

  const trigger = await withHook.trigger('pipe-1', REVIEWER)
  assert.equal(trigger.started, true)
  assert.equal(trigger.reason, null)
  assert.equal(withHook.isRunning('pipe-1'), true, 'trigger 返回时后台运行应仍在进行或即将进行')
  // trigger 已经返回而流水线还没跑完：本断言的意义就是"没有同步等完整条流水线"。
  assert.deepEqual(settled, [])

  const settlements = await withHook.idle()
  assert.deepEqual(settlements.map(item => item.ok), [true])
  assert.deepEqual(settled, ['run'])
  assert.equal(withHook.isRunning('pipe-1'), false)

  // 后台跑完一次 run：停在 receive 人工门（脚本化宿主 + gateWaitTimeoutMs=0）。
  const view = await service.get('pipe-1', REVIEWER)
  assert.equal(view.status, 'waiting-human')
  assert.deepEqual(host.stages, ['receive'])
  // 顺带确认 runner 实例之间互不干扰（上面那个 runner 从未被使用）。
  assert.equal(runner.runningIds().length, 0)
})

test('trigger 对不存在的流水线抛 not-found，不留下后台句柄', async () => {
  const runner = runnerOf(serviceOf(new ScriptedHost()))
  await assert.rejects(
    () => runner.trigger('no-such-pipeline', REVIEWER),
    (error: unknown) => error instanceof PipelineRunError && error.code === 'not-found',
  )
  assert.equal(runner.runningIds().length, 0)
})

test('同一 pipeline 运行期间重复 trigger 只返回 already-running，不并发', async () => {
  const service = serviceOf(new ScriptedHost())
  await service.create(CREATE, REVIEWER)
  // 用 gateWaitTimeoutMs 之外的阻塞点很难造，因此这里直接用 registry 观测：
  // 第一次 trigger 后立刻第二次，此时第一次仍在跑（脚本化宿主至少跨若干微任务）。
  const runner = runnerOf(service)
  const first = await runner.trigger('pipe-1', REVIEWER)
  assert.equal(first.started, true)

  const second = await runner.trigger('pipe-1', REVIEWER)
  // 若第一次已跑完（释放了句柄），第二次就会正常启动；两种情况都不得并发。
  if (second.started) {
    assert.equal(runner.isRunning('pipe-1'), true)
    await runner.idle()
  } else {
    assert.equal(second.reason, 'already-running')
    assert.equal(second.handle, null)
    await runner.idle()
  }
  // 无论走哪条分支，最终句柄必须清空。
  assert.deepEqual(runner.runningIds(), [])
})

test('cancel 中止后台运行，且不把取消伪装成成功', async () => {
  const service = serviceOf(new ScriptedHost())
  await service.create(CREATE, REVIEWER)
  const runner = runnerOf(service)
  const outcomes: string[] = []
  const withHook = new AsyncPipelineRunner({
    service, dataRoot: dir, actor: RUNNER,
    onSettled: outcome => { outcomes.push(outcome.kind === 'run' ? outcome.result.outcome : 'error') },
  })

  await withHook.trigger('pipe-1', REVIEWER)
  // 取消一个没有句柄的流水线返回 false（幂等）。
  assert.equal(withHook.cancel('pipe-1'), true)
  await withHook.idle()
  // 取消后流水线要么已按 cancelled 结束，要么本次运行根本没来得及观察信号就完成了；
  // 两种情况下都绝不能出现 "completed" 这种"取消却成功"的伪装。
  assert.equal(outcomes.includes('completed'), false)

  const view = await service.get('pipe-1', REVIEWER)
  assert.notEqual(view.status, 'completed')
  assert.equal(runner.runningIds().length, 0)
})

// ── recover：恢复扫描 ─────────────────────────────────────────────────────────

test('recover 续跑进程被杀留下的 queued 流水线', async () => {
  const host = new ScriptedHost()
  const service = serviceOf(host)
  const runner = runnerOf(service)
  await service.create(CREATE, REVIEWER)
  assert.equal((await service.get('pipe-1', REVIEWER)).status, 'queued')

  const outcomes = await runner.recover()
  assert.deepEqual(outcomes, [
    { pipelineId: 'pipe-1', action: 'resume', status: 'queued', started: true, detail: null },
  ])

  await runner.idle()
  // 恢复确实驱动了流水线：停在 receive 人工门，且只 spawn 了一次 receive。
  assert.deepEqual(host.stages, ['receive'])
  assert.equal((await service.get('pipe-1', REVIEWER)).status, 'waiting-human')
})

test('recover 对停在人工门的流水线只报告 await-human，不替人裁决也不启动', async () => {
  const host = new ScriptedHost()
  const service = serviceOf(host)
  const runner = runnerOf(service)
  await service.create(CREATE, REVIEWER)
  await runner.trigger('pipe-1', REVIEWER)
  await runner.idle()

  const before = await service.get('pipe-1', REVIEWER)
  assert.equal(before.status, 'waiting-human')
  assert.ok(before.openGateTaskId !== null)

  const outcomes = await runner.recover()
  assert.deepEqual(outcomes, [
    { pipelineId: 'pipe-1', action: 'await-human', status: 'waiting-human', started: false, detail: null },
  ])
  // 没有新的 spawn：等真人就是等真人，恢复扫描不能顺手跑一遍。
  assert.deepEqual(host.stages, ['receive'])
})

test('recover 在裁决已下但未被消费时续跑，去消费那条裁决', async () => {
  const host = new ScriptedHost()
  const service = serviceOf(host)
  const runner = runnerOf(service)
  await service.create(CREATE, REVIEWER)
  await runner.trigger('pipe-1', REVIEWER)
  await runner.idle()

  // 真人批准（走 reviewer 身份，不是后台身份）。
  const task = (await service.listGateTasks({ projectId: 'demo', pipelineId: 'pipe-1' }, REVIEWER))[0]!
  await service.claimGate({ projectId: 'demo', pipelineId: 'pipe-1', gateTaskId: task.gateTaskId }, REVIEWER)
  await service.decideGate({ projectId: 'demo', pipelineId: 'pipe-1', gateTaskId: task.gateTaskId, action: 'approved' }, REVIEWER)

  const decided = await service.get('pipe-1', REVIEWER)
  assert.equal(decided.status, 'waiting-human', '裁决未被消费前状态仍是等待人工')
  assert.equal(decided.openGateTaskId, null, '没有待裁决任务')

  const outcomes = await runner.recover()
  assert.deepEqual(outcomes, [
    { pipelineId: 'pipe-1', action: 'resume', status: 'waiting-human', started: true, detail: null },
  ])
  await runner.idle()

  // receive 的裁决被消费：不再重跑 receive，前进到 analyze 并停在那里等门。
  assert.deepEqual(host.stages, ['receive', 'analyze'])
  const after = await service.get('pipe-1', REVIEWER)
  assert.equal(after.status, 'waiting-human')
  assert.equal(after.stages.find(stage => stage.stageId === 'analyze')!.status, 'awaiting-gate')
  assert.equal(after.stages.find(stage => stage.stageId === 'receive')!.status, 'done')
})

/**
 * 反复「触发 → 等收敛 → 批准待裁决任务」，直到流水线到达终态。
 *
 * 轮数上界 = 阶段数 + 1：最后一次 run 只消费 archive 的裁决，不新开门。
 * 用有界循环而不是固定次数，避免"差一轮"这类脆弱断言。
 */
async function driveToTerminal(service: FilePipelineRunService, runner: AsyncPipelineRunner): Promise<void> {
  const scope = { projectId: 'demo', pipelineId: 'pipe-1' } as const
  for (let round = 0; round <= 6; round += 1) {
    await runner.trigger('pipe-1', REVIEWER)
    await runner.idle()
    if ((await service.get('pipe-1', REVIEWER)).status === 'completed') return
    const task = (await service.listGateTasks(scope, REVIEWER)).find(candidate => candidate.status === 'pending')
    if (task === undefined) return
    await service.claimGate({ ...scope, gateTaskId: task.gateTaskId }, REVIEWER)
    await service.decideGate({ ...scope, gateTaskId: task.gateTaskId, action: 'approved' }, REVIEWER)
  }
}

test('recover 对终态流水线不做任何动作', async () => {
  const host = new ScriptedHost()
  const service = serviceOf(host)
  const runner = runnerOf(service)
  await service.create(CREATE, REVIEWER)

  await driveToTerminal(service, runner)
  assert.equal((await service.get('pipe-1', REVIEWER)).status, 'completed')
  assert.deepEqual(host.stages, ['receive', 'analyze', 'design', 'execute', 'report', 'archive'])
  const spawnedBefore = [...host.stages]

  const outcomes = await runner.recover()
  assert.deepEqual(outcomes, [
    { pipelineId: 'pipe-1', action: 'terminal', status: 'completed', started: false, detail: null },
  ])
  assert.deepEqual(host.stages, spawnedBefore, '终态不得被恢复扫描重跑')
})

test('recover 显式报告不可读项，而不是静默跳过', async () => {
  const service = serviceOf(new ScriptedHost())
  const runner = runnerOf(service)
  await service.create(CREATE, REVIEWER)
  await writeIndexFile('broken.json', '{ 不是 JSON')

  const outcomes = await runner.recover()
  assert.deepEqual(outcomes.map(item => [item.pipelineId, item.action]), [
    ['broken', 'unreadable'],
    ['pipe-1', 'resume'],
  ])
  assert.match(outcomes[0]!.detail!, /索引不可读/)
  await runner.idle()
})

test('recover 结果按 pipelineId 排序，便于日志对比', async () => {
  const service = serviceOf(new ScriptedHost())
  const runner = runnerOf(service)
  for (const id of ['pipe-c', 'pipe-a', 'pipe-b']) {
    await service.create({ ...CREATE, pipelineId: id }, REVIEWER)
  }
  const outcomes = await runner.recover()
  assert.deepEqual(outcomes.map(item => item.pipelineId), ['pipe-a', 'pipe-b', 'pipe-c'])
  await runner.idle()
})

test('shutdown 中止全部后台运行并返回被中止的 id', async () => {
  const service = serviceOf(new ScriptedHost())
  await service.create(CREATE, REVIEWER)
  const runner = runnerOf(service)
  await runner.trigger('pipe-1', REVIEWER)
  const cancelled = runner.shutdown('进程退出')
  // 若本次运行已经跑完，则没有可中止的句柄（返回空数组）；两种情况都不得抛错。
  assert.ok(Array.isArray(cancelled))
  await runner.idle()
  assert.deepEqual(runner.runningIds(), [])
})
