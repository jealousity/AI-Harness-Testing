/**
 * 用量计量与预算汇总（docs/10 §7.2 / §7.3 / §7.4）的单元测试。
 *
 * 这里覆盖的是**纯逻辑**：事件形状、落盘/回读、汇总口径、超限判定、错误码脱敏。
 * 预算强制（超 maxSteps 立即停止）与 driver 落盘在各自的测试文件里验证。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { STAGE_ORDER, type StageBudget, type StageId } from '../src/types.ts'
import {
  StageBudgetExceededError,
  UsageRecorder,
  fileUsageStore,
  nullUsageSink,
  recordUsage,
  retryFactsOf,
  summarizeUsage,
  usageDir,
  usageErrorCode,
  usageLogPath,
  type UsageEvent,
  type UsageRecordInput,
  type UsageSink,
} from '../src/usage.ts'

let dir: string

test.beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'pp-usage-')) })
test.afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

function budget(overrides: Partial<StageBudget> = {}): StageBudget {
  return { maxSteps: 20, timeoutMs: 600_000, maxRetries: 2, ...overrides }
}

function budgetOf(overrides: Partial<Record<StageId, StageBudget>> = {}) {
  return (stageId: StageId): StageBudget => overrides[stageId] ?? budget()
}

function event(stageId: StageId, kind: UsageEvent['kind'], overrides: Partial<UsageEvent> = {}): UsageEvent {
  return {
    eventId: `${stageId}-${kind}-${Math.random().toString(36).slice(2, 8)}`,
    tenantId: 'acme',
    projectId: 'demo',
    pipelineId: 'pipe-1',
    stageId,
    kind,
    startedAt: 1_000,
    finishedAt: 1_050,
    durationMs: 50,
    success: true,
    ...overrides,
  }
}

// ── 路径约定 ─────────────────────────────────────────────────────────────────

test('usageDir 固定在项目根的 usage 子目录下，日志按 pipelineId 分文件', () => {
  assert.equal(usageDir('/data/proj'), join('/data/proj', 'usage'))
  assert.equal(usageLogPath('/data/proj/usage', 'pipe-1'), join('/data/proj/usage', 'pipe-1.jsonl'))
})

test('usageLogPath 拒绝会把路径带出用量目录的 pipelineId', () => {
  for (const evil of ['../evil', 'a/b', 'a\\b', '.', '..', '']) {
    assert.throws(() => usageLogPath('/data/usage', evil), /不能用作路径片段/, `应拒绝 ${JSON.stringify(evil)}`)
  }
})

// ── 文件存储 ─────────────────────────────────────────────────────────────────

test('fileUsageStore 追加后可回读；日志不存在时返回空而不是报错', async () => {
  const store = fileUsageStore(usageDir(dir))
  assert.deepEqual(await store.read('pipe-1'), { events: [], skipped: [] })

  await store.append(event('receive', 'llm', { inputTokens: 10, outputTokens: 4 }))
  await store.append(event('receive', 'tool', { toolName: 'fs_read' }))
  const read = await store.read('pipe-1')
  assert.equal(read.events.length, 2)
  assert.equal(read.skipped.length, 0)
  assert.equal(read.events[0]?.inputTokens, 10)
  assert.equal(read.events[1]?.toolName, 'fs_read')
})

test('不同 pipelineId 的日志互不干扰', async () => {
  const store = fileUsageStore(usageDir(dir))
  await store.append(event('receive', 'llm'))
  await store.append(event('receive', 'llm', { pipelineId: 'pipe-2' }))
  assert.equal((await store.read('pipe-1')).events.length, 1)
  assert.equal((await store.read('pipe-2')).events.length, 1)
})

test('损坏行被显式报告，而不是静默丢弃（否则"计量不完整"会被读成"用量为 0"）', async () => {
  const store = fileUsageStore(usageDir(dir))
  await store.append(event('receive', 'llm'))
  const path = usageLogPath(usageDir(dir), 'pipe-1')
  await writeFile(path, `${await readFile(path, 'utf8')}not json\n{"kind":"llm"}\n`, 'utf8')

  const read = await store.read('pipe-1')
  assert.equal(read.events.length, 1)
  assert.deepEqual(read.skipped.map(item => item.line), [2, 3])
  assert.equal(read.skipped.every(item => item.reason !== ''), true)
})

// ── 记录器 ───────────────────────────────────────────────────────────────────

test('UsageRecorder 补齐 scope / eventId，并按时间戳算时长（不采信调用方自报）', async () => {
  const store = fileUsageStore(usageDir(dir))
  const recorder = new UsageRecorder({
    store,
    scope: { tenantId: 'acme', projectId: 'demo', pipelineId: 'pipe-1' },
    now: () => 5_000,
    newEventId: () => 'ev-fixed',
  })
  await recorder.record({ stageId: 'analyze', kind: 'llm', startedAt: 4_000, finishedAt: 4_250, success: true })

  const [saved] = (await store.read('pipe-1')).events
  assert.equal(saved?.eventId, 'ev-fixed')
  assert.equal(saved?.tenantId, 'acme')
  assert.equal(saved?.projectId, 'demo')
  assert.equal(saved?.pipelineId, 'pipe-1')
  assert.equal(saved?.stageId, 'analyze')
  assert.equal(saved?.durationMs, 250)
})

test('时间戳倒挂时时长归零，不产生负用量', async () => {
  const store = fileUsageStore(usageDir(dir))
  const recorder = new UsageRecorder({
    store,
    scope: { tenantId: 'acme', projectId: 'demo', pipelineId: 'pipe-1' },
  })
  await recorder.record({ stageId: 'analyze', kind: 'llm', startedAt: 9_000, finishedAt: 8_000, success: false })
  assert.equal((await store.read('pipe-1')).events[0]?.durationMs, 0)
})

test('recordUsage 吞掉 sink 异常：计量坏了不得让流水线失败', async () => {
  const broken: UsageSink = { record: async () => { throw new Error('disk full') } }
  await assert.doesNotReject(() => recordUsage(broken, {
    stageId: 'receive', kind: 'llm', startedAt: 1, finishedAt: 2, success: true,
  }))
  await assert.doesNotReject(() => recordUsage(undefined, {
    stageId: 'receive', kind: 'llm', startedAt: 1, finishedAt: 2, success: true,
  }))
  await assert.doesNotReject(() => nullUsageSink.record({
    stageId: 'receive', kind: 'llm', startedAt: 1, finishedAt: 2, success: true,
  }))
})

// ── 汇总 ─────────────────────────────────────────────────────────────────────

test('summarizeUsage 按阶段分组，并对每个阶段回显配置里的 budget（used/limit 可对比）', () => {
  const summary = summarizeUsage([
    event('receive', 'llm'),
    event('receive', 'tool', { toolName: 'fs_read' }),
    event('analyze', 'llm'),
  ], { budgetOf: budgetOf(), pipelineId: 'pipe-1' })

  assert.equal(summary.pipelineId, 'pipe-1')
  assert.deepEqual(summary.stages.map(stage => stage.stageId), [...STAGE_ORDER])
  const receive = summary.stages.find(stage => stage.stageId === 'receive')!
  assert.equal(receive.totals.llmCalls, 1)
  assert.equal(receive.totals.toolSteps, 1)
  assert.equal(receive.budget.maxSteps, 20)
  // 没有事件的阶段也要出现，且 used 全为 0——"没跑过"与"跑了但没超限"必须可区分。
  const archive = summary.stages.find(stage => stage.stageId === 'archive')!
  assert.equal(archive.totals.llmCalls, 0)
  assert.equal(archive.budget.maxSteps, 20)
})

test('流水线级 totals 是各阶段之和，wallClockMs 是跨度而不是时长之和', () => {
  const summary = summarizeUsage([
    event('receive', 'llm', { startedAt: 1_000, finishedAt: 1_100, durationMs: 100 }),
    event('analyze', 'llm', { startedAt: 5_000, finishedAt: 5_010, durationMs: 10 }),
  ], { budgetOf: budgetOf() })
  assert.equal(summary.totals.llmCalls, 2)
  assert.equal(summary.totals.wallClockMs, 4_010)
})

test('token 计量不完整时 tokensAvailable 为 false（provider 未返回 usage 不得当成 0 用量）', () => {
  const withTokens = summarizeUsage([
    event('receive', 'llm', { inputTokens: 10, outputTokens: 5 }),
  ], { budgetOf: budgetOf() })
  assert.equal(withTokens.totals.tokensAvailable, true)
  assert.equal(withTokens.totals.inputTokens, 10)

  const mixed = summarizeUsage([
    event('receive', 'llm', { inputTokens: 10, outputTokens: 5 }),
    event('receive', 'llm'),
  ], { budgetOf: budgetOf() })
  assert.equal(mixed.totals.tokensAvailable, false)
  assert.equal(mixed.totals.llmCalls, 2)

  const none = summarizeUsage([], { budgetOf: budgetOf() })
  assert.equal(none.totals.tokensAvailable, false)
})

test('审核用量与阶段主预算分开统计（review 不吞 llm/tool 步数）', () => {
  const summary = summarizeUsage([
    event('design', 'llm'),
    event('design', 'tool', { toolName: 'fs_read' }),
    event('design', 'review'),
    event('design', 'review', { toolName: 'fs_read' }),
  ], { budgetOf: budgetOf() })
  const design = summary.stages.find(stage => stage.stageId === 'design')!
  assert.equal(design.totals.llmCalls, 1)
  assert.equal(design.totals.toolSteps, 1)
  assert.equal(design.totals.reviewCalls, 1)
  assert.equal(design.totals.reviewToolSteps, 1)
  assert.deepEqual(design.exceeded, [])
})

test('人工门等待与检查点耗时单独成桶，不计入模型预算', () => {
  const summary = summarizeUsage([
    event('receive', 'gate', { durationMs: 900_000 }),
    event('receive', 'checkpoint', { durationMs: 12 }),
  ], { budgetOf: budgetOf({ receive: budget({ timeoutMs: 600_000 }) }) })
  const receive = summary.stages.find(stage => stage.stageId === 'receive')!
  assert.equal(receive.totals.gateWaitMs, 900_000)
  assert.equal(receive.totals.checkpointMs, 12)
  assert.equal(receive.totals.llmCalls, 0)
  // 人工门等了 15 分钟（> timeoutMs），但阶段本身没有超时：等待不属于阶段 wall-clock 预算。
  assert.deepEqual(receive.exceeded, [])
})

test('executor 用量汇总 case / 失败 / 证据数', () => {
  const summary = summarizeUsage([
    event('execute', 'executor', { caseCount: 3, failureCount: 1, evidenceCount: 3 }),
    event('execute', 'executor', { caseCount: 0, failureCount: 0, evidenceCount: 0 }),
  ], { budgetOf: budgetOf() })
  const execute = summary.stages.find(stage => stage.stageId === 'execute')!
  assert.equal(execute.totals.executorInvocations, 2)
  assert.equal(execute.totals.executorCases, 3)
  assert.equal(execute.totals.executorFailures, 1)
  assert.equal(execute.totals.executorEvidence, 3)
})

// ── 超限判定 ─────────────────────────────────────────────────────────────────

test('tool steps 超过 maxSteps → max-steps 超限', () => {
  const events = Array.from({ length: 21 }, () => event('receive', 'tool', { toolName: 'fs_read' }))
  const summary = summarizeUsage(events, { budgetOf: budgetOf({ receive: budget({ maxSteps: 20 }) }) })
  assert.deepEqual(summary.exceeded, [{ kind: 'max-steps', stageId: 'receive', used: 21, limit: 20 }])
})

test('timeoutMs: 0 = 项目定义，不设阶段 deadline，绝不当成立即超时', () => {
  const summary = summarizeUsage([
    event('execute', 'llm', { startedAt: 0, finishedAt: 10_000_000, durationMs: 10_000_000 }),
  ], { budgetOf: budgetOf({ execute: budget({ timeoutMs: 0 }) }) })
  assert.deepEqual(summary.exceeded, [])
})

test('wall-clock 超过 timeoutMs → timeout 超限', () => {
  const summary = summarizeUsage([
    event('receive', 'llm', { startedAt: 0, finishedAt: 700_000, durationMs: 700_000 }),
  ], { budgetOf: budgetOf({ receive: budget({ timeoutMs: 600_000 }) }) })
  assert.deepEqual(summary.exceeded, [{ kind: 'timeout', stageId: 'receive', used: 700_000, limit: 600_000 }])
})

test('maxTestCases 未声明 = 不设上限；声明后超过即超限', () => {
  const events = [event('design', 'executor', { caseCount: 5 })]
  assert.deepEqual(summarizeUsage(events, { budgetOf: budgetOf() }).exceeded, [])
  assert.deepEqual(
    summarizeUsage(events, { budgetOf: budgetOf({ design: budget({ maxTestCases: 4 }) }) }).exceeded,
    [{ kind: 'max-test-cases', stageId: 'design', used: 5, limit: 4 }],
  )
})

test('重试预算：门禁重试与审核重试各自与 maxRetries 比较，取较大值', () => {
  const over = summarizeUsage([], {
    budgetOf: budgetOf({ analyze: budget({ maxRetries: 2 }) }),
    retriesOf: stageId => stageId === 'analyze' ? { gateRetries: 3, reviewRetries: 0 } : { gateRetries: 0, reviewRetries: 0 },
  })
  assert.deepEqual(over.exceeded, [{ kind: 'max-retries', stageId: 'analyze', used: 3, limit: 2 }])

  const atLimit = summarizeUsage([], {
    budgetOf: budgetOf(),
    retriesOf: stageId => stageId === 'analyze' ? { gateRetries: 2, reviewRetries: 1 } : { gateRetries: 0, reviewRetries: 0 },
  })
  // 恰好用满不算超：3 次重试分别落在两个独立预算里，各自都没越界。
  assert.deepEqual(atLimit.exceeded, [])
})

test('retryFactsOf 从检查点阶段状态读门禁重试与审核重试次数', () => {
  assert.deepEqual(retryFactsOf({
    gate: { machine: { attempts: 2 } },
    failures: [{ kind: 'review-fail' }, { kind: 'budget-exceeded' }, { kind: 'review-fail' }],
  }), { gateRetries: 2, reviewRetries: 2 })
})

test('summarizeUsage 是纯函数：同样输入得到同样输出，与调用顺序无关', () => {
  const events = [event('receive', 'llm'), event('analyze', 'tool', { toolName: 'fs_read' })]
  const first = summarizeUsage(events, { budgetOf: budgetOf(), pipelineId: 'pipe-1' })
  const second = summarizeUsage(events, { budgetOf: budgetOf(), pipelineId: 'pipe-1' })
  assert.deepEqual(first, second)
  assert.deepEqual(
    summarizeUsage([...events].reverse(), { budgetOf: budgetOf(), pipelineId: 'pipe-1' }).totals,
    first.totals,
  )
})

test('skippedLines 透传：日志损坏必须能被查询方看见', () => {
  const summary = summarizeUsage([], { budgetOf: budgetOf(), skippedLines: 3 })
  assert.equal(summary.skippedLines, 3)
})

// ── 超限错误与错误码 ─────────────────────────────────────────────────────────

test('StageBudgetExceededError 带上 stageId 与 used/limit，消息含英文关键片段', () => {
  const error = new StageBudgetExceededError('receive', { kind: 'max-steps', used: 21, limit: 20 })
  assert.equal(error.stageId, 'receive')
  assert.deepEqual(error.limit, { kind: 'max-steps', stageId: 'receive', used: 21, limit: 20 })
  assert.match(error.message, /exceeded tool-call step budget \(20\)/)
  assert.match(error.message, /21/)
})

test('四种超限维度的消息都可读', () => {
  const kinds = ['max-steps', 'timeout', 'max-test-cases', 'max-retries'] as const
  for (const kind of kinds) {
    const error = new StageBudgetExceededError('execute', { kind, used: 5, limit: 4 })
    assert.match(error.message, /execute/, `kind=${kind}`)
    assert.match(error.message, /5/, `kind=${kind}`)
  }
})

test('usageErrorCode 只产出固定枚举，绝不回传异常消息（凭据/响应正文不得进日志）', () => {
  const budgetError = new StageBudgetExceededError('receive', { kind: 'max-steps', used: 1, limit: 0 })
  assert.equal(usageErrorCode(budgetError), 'budget-exceeded')

  const abort = new Error('aborted')
  abort.name = 'AbortError'
  assert.equal(usageErrorCode(abort), 'cancelled')

  const provider = new Error('HTTP 401: sk-secret-value leaked in provider message')
  provider.name = 'OpenAICompatibleError'
  const code = usageErrorCode(provider)
  assert.equal(code, 'llm-request-failed')
  assert.equal(code.includes('sk-'), false)

  const plain = new Error('内部实现细节 123')
  assert.equal(usageErrorCode(plain), 'operation-failed')
  assert.equal(usageErrorCode('not an error'), 'unknown-error')
  assert.equal(usageErrorCode(undefined), 'unknown-error')
})

test('用量事件的字段集是封闭的：没有任何承载 prompt / 响应正文 / 凭据的位置', () => {
  const input: UsageRecordInput = {
    stageId: 'receive', kind: 'llm', startedAt: 1, finishedAt: 2, success: true,
    inputTokens: 3, outputTokens: 4,
  }
  assert.deepEqual(
    Object.keys(input).sort(),
    ['finishedAt', 'inputTokens', 'kind', 'outputTokens', 'stageId', 'startedAt', 'success'],
  )
  // 全字段版本（含 executor 计量数字）也不引入自由文本字段。
  const full = event('execute', 'executor', {
    toolName: 'executor_run', errorCode: 'executor-unavailable',
    caseCount: 1, failureCount: 0, evidenceCount: 1,
  })
  assert.deepEqual(Object.keys(full).sort(), [
    'caseCount', 'durationMs', 'errorCode', 'eventId', 'evidenceCount', 'failureCount', 'finishedAt',
    'kind', 'pipelineId', 'projectId', 'stageId', 'startedAt', 'success', 'tenantId', 'toolName',
  ])
})
