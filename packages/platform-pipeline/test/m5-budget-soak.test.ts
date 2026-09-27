/**
 * M5 预算发布门槛：**跨批次、跨进程重启的长跑累计**（docs/11 §9 批次 E 第 7 项、docs/13 门槛8）。
 *
 * 为什么单次运行的预算测试不够：预算的事实来源是**追加写的用量日志**
 * （`<projectRoot>/usage/<pipelineId>.jsonl`）。长跑场景下真正会出问题的是：
 *
 * - 重启之后累计被**重置**（新实例只看到自己那一段）；
 * - 重启之后被**重复计数**（例如把同一段日志读两遍）；
 * - 超限判定依赖"哪一批"而不是累计值，于是拆成多批就永远触发不了。
 *
 * 这三条都不是"跑一次"能暴露的，因此本门槛按**多批次 + 中途换进程实例**来验证。
 *
 * 判据刻意**不写死"每批多少个 step"**：那属于聚合口径的实现细节，写死只会让测试
 * 在口径调整时假失败。真正要钉住的是**关系**——重启前后相同、两批等于两倍、
 * 超限判定用的是累计值。每批的绝对值由测试自己**测量**得到。
 *
 * @module test/m5-budget-soak
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { STAGE_ORDER, type PipelineConfig } from '../src/types.ts'
import { resolvePlatformRoots } from '../src/platform-roots.ts'
import { FilePipelineRunService } from '../src/web/pipeline-run-service.ts'
import type { UsageSummary } from '../src/usage.ts'
import { CREATE, REVIEWER, SCOPE, ScriptedHost, baseConfig } from './web-fixtures.ts'

let dir: string
let config: PipelineConfig

/** 只把 `receive` 的上限压到 `maxSteps`，其余阶段保持默认。 */
function configWithReceiveBudget(maxSteps: number): PipelineConfig {
  return baseConfig({
    stages: Object.fromEntries(STAGE_ORDER.map(id => [
      id,
      { rules: [], review: { enabled: false }, budget: { maxSteps: id === 'receive' ? maxSteps : 20 } },
    ])),
  })
}

function hostOf(): ScriptedHost {
  return new ScriptedHost({ usagePerStage: { tool: 3, llm: 0 } })
}

test.beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'pp-budget-soak-')) })
test.afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

function serviceOf(host: ScriptedHost): FilePipelineRunService {
  return new FilePipelineRunService({ dataRoot: dir, loadConfig: async () => config, createHost: host.factory })
}

/** 读原始用量日志（事实来源）里的 `tool` 事件条数。 */
async function toolEventsInLog(): Promise<number> {
  const path = join(resolvePlatformRoots(dir, config).projectRoot, 'usage', 'pipe-1.jsonl')
  const raw = await readFile(path, 'utf8')
  return raw.split('\n')
    .filter(line => line.trim() !== '')
    .map(line => JSON.parse(line) as { kind?: string })
    .filter(event => event.kind === 'tool')
    .length
}

function receiveOf(summary: UsageSummary) {
  const stage = summary.stages.find(item => item.stageId === 'receive')
  assert.ok(stage !== undefined, 'receive 必须出现在用量汇总里')
  return stage
}

/** 打回重跑，让 `receive` 再 spawn 一次。 */
async function bounceReceive(service: FilePipelineRunService): Promise<void> {
  const [task] = await service.listGateTasks(SCOPE, REVIEWER)
  await service.claimGate({ ...SCOPE, gateTaskId: task!.gateTaskId }, REVIEWER)
  await service.decideGate({ ...SCOPE, gateTaskId: task!.gateTaskId, action: 'changes-needed', note: '需要补充' }, REVIEWER)
  await service.run('pipe-1', REVIEWER)
}

test('门槛8：用量跨批次、跨进程重启累计不重置也不重复计数', async () => {
  config = configWithReceiveBudget(1000) // 上限给足，本用例只验"累计"不验"触发"
  const first = serviceOf(hostOf())
  await first.create(CREATE, REVIEWER)

  // ── 批次 1：跑到 receive 人工门，**测量**每批的 tool step 数 ────────────────
  assert.equal((await first.run('pipe-1', REVIEWER)).outcome, 'waiting-human')
  const afterBatch1 = await first.getUsage('pipe-1', REVIEWER)
  const perBatch = receiveOf(afterBatch1).totals.toolSteps
  assert.ok(perBatch > 0, `每批必须有用量记录，实际 ${perBatch}`)
  assert.deepEqual(receiveOf(afterBatch1).exceeded, [], '上限给足时不应超限')
  assert.equal(await toolEventsInLog(), perBatch, '汇总值必须等于原始日志里的 tool 事件条数')

  // ── 换进程实例（模拟重启）：累计必须**一字不差** ──────────────────────────
  const restarted = serviceOf(hostOf())
  const afterRestart = await restarted.getUsage('pipe-1', REVIEWER)
  assert.equal(receiveOf(afterRestart).totals.toolSteps, perBatch,
    '重启后累计不得重置为 0，也不得重复计数')
  assert.deepEqual(afterRestart.totals, afterBatch1.totals, '流水线级累计也必须一致')
  assert.equal(await toolEventsInLog(), perBatch, '重启本身不得追加任何事件')

  // ── 批次 2：打回重跑 → 累计必须是两批之和（精确相等，不是"大于"）──────────
  await bounceReceive(restarted)
  const afterBatch2 = await restarted.getUsage('pipe-1', REVIEWER)
  assert.equal(receiveOf(afterBatch2).totals.toolSteps, perBatch * 2, '累计必须是两批之和')
  assert.equal(await toolEventsInLog(), perBatch * 2, '日志条数必须与累计一致（不多不少）')

  // ── 再换一次实例：结论必须与上一步逐字相同（纯函数，与谁先读无关）────────
  const third = serviceOf(hostOf())
  assert.deepEqual(await third.getUsage('pipe-1', REVIEWER), afterBatch2, '换实例后汇总必须逐字相同')
})

test('门槛8a：超限判定用的是**累计值**，不是"这一批用了多少"', async () => {
  // 上限压到 1：单批就已经超过，因此超限必须报出**累计**的 used，而不是批内增量。
  config = configWithReceiveBudget(1)
  const service = serviceOf(hostOf())
  await service.create(CREATE, REVIEWER)
  await service.run('pipe-1', REVIEWER)

  const usage = await service.getUsage('pipe-1', REVIEWER)
  const receive = receiveOf(usage)
  const exceeded = receive.exceeded
  assert.equal(exceeded.length, 1, `累计超过上限 1 必须报超限：${JSON.stringify(receive)}`)
  assert.equal(exceeded[0]!.kind, 'max-steps')
  assert.equal(exceeded[0]!.limit, 1)
  assert.equal(exceeded[0]!.used, receive.totals.toolSteps,
    '报出的 used 必须是累计值（否则"拆成多批就永远触发不了"）')

  // 跨重启后这个结论必须一致（不能因为"这一批没超"而消失）。
  const restarted = serviceOf(hostOf())
  assert.deepEqual(receiveOf(await restarted.getUsage('pipe-1', REVIEWER)).exceeded, exceeded)
})

test('门槛8b：预算被强制停止时，流水线以 gate-failed 结束且该阶段不进入人工门', async () => {
  config = configWithReceiveBudget(1000)
  // 运行器当场抛 `StageBudgetExceededError`（脚本化宿主用 `budgetExceededStages` 复现）。
  const host = new ScriptedHost({
    usagePerStage: { tool: 3, llm: 0 },
    budgetExceededStages: ['receive'],
  })
  const service = serviceOf(host)
  await service.create(CREATE, REVIEWER)

  const result = await service.run('pipe-1', REVIEWER)
  assert.equal(result.outcome, 'gate-failed', `预算超限必须以终态结束，实际 ${result.outcome}`)

  const view = await service.get('pipe-1', REVIEWER)
  assert.equal(view.status, 'gate-failed')
  assert.notEqual(view.stages.find(stage => stage.stageId === 'receive')!.status, 'done',
    '预算超限不得把阶段标成完成')

  // 预算超限**不得开出阶段门**（那会把"预算用尽"包装成"待批准"）。
  //
  // 注意区分两种任务：`gateFailed` 会开一条**升级任务**（`artifactPath` 为空、
  // `machineStatus: 'failed'`），它只用于通知人去处理，**永远不会**被 `gate()` 当作
  // 阶段批准（`findResumableTask` 明确排除它）。因此这里断言的是"没有阶段门"，
  // 而不是"没有任何任务"。
  const receiveStage = view.stages.find(stage => stage.stageId === 'receive')!
  assert.equal(receiveStage.humanGateTaskId, null, '该阶段不得有阶段门任务')
  const openTask = (await service.listGateTasks(SCOPE, REVIEWER))
    .find(task => task.gateTaskId === view.openGateTaskId)
  assert.ok(openTask !== undefined, 'openGateTaskId 必须指向一条真实存在的任务')
  assert.equal(openTask.artifactPath, '',
    '指向的必须是升级任务（不对应产物），而不是一条可被当作阶段批准的门')

  // 汇总里的两个来源都要对得上，且**不要互相替代**（`usage.ts` 明确区分它们）：
  // - 用量日志：这次是一开工就超限，因此没有任何 tool 事件；
  // - 检查点里的 failure：**"预算用尽被强制停止"这件事的事实来源在这里**。
  const usage = await service.getUsage('pipe-1', REVIEWER)
  assert.equal(receiveOf(usage).totals.toolSteps, 0,
    '本次在 spawn 时就超限，日志里不应有任何 tool 事件')
  assert.equal(usage.budgetFailures, 1, '检查点里必须留下一条 budget-exceeded 事实')
})
