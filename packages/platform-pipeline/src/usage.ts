/**
 * 用量计量与阶段预算（docs/10 §7 M3：预算计量与运行遥测）。
 *
 * 这一层要解决两件互不相同的事，**不要把它们混在一起**：
 *
 * 1. **强制约束（enforcement）**：`budget.maxSteps` / `timeoutMs` / `maxRetries` /
 *    `maxTestCases` 从"只写进 prompt 的文字"变成真实运行约束。强制判定发生在
 *    **内存里**（运行器自己数工具步数、driver 自己数重试次数、看墙钟），
 *    因此**不依赖用量日志写盘成功**——计量坏了也必须照常拦住越界。
 * 2. **可审计用量（telemetry）**：每条 `UsageEvent` 落盘成不可变事实，
 *    供 Web/CLI 查询与事后对账。这是**尽力而为**的观测：
 *    写盘失败不会让流水线失败（见 {@link recordUsage}），但也不会伪装成功。
 *
 * 事实来源约定：用量日志是 append-only JSONL（`<projectRoot>/usage/<pipelineId>.jsonl`），
 * 与检查点、幂等台账一样按**项目**共享、按 pipelineId 分文件，三入口（CLI / Web / Harness）
 * 读的是同一份。各自拼路径会让"预算查询"在不同入口给出不同答案——和锁路径分裂
 * （§6.2 第 5 条）是同一类错误。
 *
 * 隐私边界（docs/10 §7.4）：用量事件**只记录计量数字与标识**，绝不写入 API Key、
 * 完整 prompt 或模型响应正文。因此本模块的字段集是封闭的：要加字段先问它是不是敏感内容。
 *
 * @module platform-pipeline/usage
 */

import { randomUUID } from 'node:crypto'
import { appendFile, mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { STAGE_ORDER, type StageBudget, type StageId } from './types.ts'

/** 用量事件的类别（docs/10 §7.2）。 */
export type UsageKind = 'llm' | 'tool' | 'review' | 'executor' | 'gate' | 'checkpoint'

/**
 * 一条不可变用量事件（docs/10 §7.2 的事件模型）。
 *
 * 在文档给定字段之外补了三个**可选**计量数字（`caseCount`/`failureCount`/
 * `evidenceCount`）：§7.3 要求"executor 的 case 数量、失败数量和证据数写入 usage"，
 * 而原始字段集里没有承载它们的位置。补在这里而不是另开一张表，
 * 是为了让一条 `executor` 事件自身就能被完整对账。
 */
export interface UsageEvent {
  readonly eventId: string
  readonly tenantId: string
  readonly projectId: string
  readonly pipelineId: string
  readonly stageId: StageId
  readonly kind: UsageKind
  readonly startedAt: number
  readonly finishedAt: number
  readonly durationMs: number
  readonly inputTokens?: number
  readonly outputTokens?: number
  readonly toolName?: string
  readonly success: boolean
  readonly errorCode?: string
  /** `kind='executor'`：本次调用实际执行（非重放）的用例数。 */
  readonly caseCount?: number
  /** `kind='executor'`：其中失败用例数。 */
  readonly failureCount?: number
  /** `kind='executor'`：本次产生的证据条目数。 */
  readonly evidenceCount?: number
}

/**
 * 记录一条用量所需的输入：scope、`eventId` 与 `durationMs` 由 {@link UsageRecorder} 补齐。
 *
 * 调用方只描述"发生了什么"，不自己编 id 和时长——否则各调用点会各自算一套口径。
 */
export interface UsageRecordInput {
  readonly stageId: StageId
  readonly kind: UsageKind
  readonly startedAt: number
  readonly finishedAt: number
  readonly success: boolean
  readonly inputTokens?: number
  readonly outputTokens?: number
  readonly toolName?: string
  readonly errorCode?: string
  readonly caseCount?: number
  readonly failureCount?: number
  readonly evidenceCount?: number
}

/** 用量落点。运行器 / 审核 / 工具 / driver 都只依赖这个最小接口。 */
export interface UsageSink {
  record(input: UsageRecordInput): Promise<void>
}

/** 无操作 sink：未配置计量时使用，避免调用点到处写 `if (sink !== undefined)`。 */
export const nullUsageSink: UsageSink = Object.freeze({
  record: async (): Promise<void> => {},
})

/**
 * 记录一条用量事件；**计量失败绝不改变流水线结果**。
 *
 * 为什么在这里吞掉异常：预算强制在内存里完成（见模块头注释），用量日志是观测面。
 * 因为磁盘写满或权限问题让一条本来能跑完的流水线失败，是把可观测性问题升级成业务故障。
 * 反过来也不能"假装记上了"：失败即事件不存在，查询结果自然少一条，
 * 汇总里的 `skippedLines` 与日志本身才是判断计量是否完整的依据。
 */
export async function recordUsage(sink: UsageSink | undefined, input: UsageRecordInput): Promise<void> {
  if (sink === undefined) return
  try {
    await sink.record(input)
  } catch {
    // 有意忽略：见上面的说明。
  }
}

/** 用量日志的读取结果。 */
export interface UsageLogRead {
  readonly events: readonly UsageEvent[]
  /**
   * 无法解析的行（1-based 行号 + 原因）。
   *
   * 显式返回而不是静默跳过：预算查询若把"日志损坏"当成"没有用量"，
   * 运维会看到一条用量为 0 的流水线，从而误判预算充足。
   */
  readonly skipped: readonly { readonly line: number; readonly reason: string }[]
}

/** 用量存储端口（文件实现见 {@link fileUsageStore}）。 */
export interface UsageStore {
  append(event: UsageEvent): Promise<void>
  read(pipelineId: string): Promise<UsageLogRead>
}

/** 用量日志目录：`<projectRoot>/usage`。集中在此生成，调用点不得自行拼路径。 */
export function usageDir(projectRoot: string): string {
  return join(projectRoot, 'usage')
}

/** 某条流水线的用量日志路径。 */
export function usageLogPath(dir: string, pipelineId: string): string {
  return join(dir, `${assertSafeSegment(pipelineId, 'pipelineId')}.jsonl`)
}

/**
 * 文件用量存储：append-only JSONL。
 *
 * 用 `appendFile` 而不是"读改写"：预算事件是**追加事实**，并发追加（CLI 与 Web 同时跑
 * 两条流水线）必须各自成立，读改写会让后写者覆盖先写者的记录。单行 JSON 远小于
 * `PIPE_BUF`，因此 `O_APPEND` 写入在本平台的目标平台上原子。
 */
export function fileUsageStore(dir: string): UsageStore {
  return {
    async append(event: UsageEvent): Promise<void> {
      await mkdir(dir, { recursive: true })
      await appendFile(usageLogPath(dir, event.pipelineId), `${JSON.stringify(event)}\n`, 'utf8')
    },
    async read(pipelineId: string): Promise<UsageLogRead> {
      const path = usageLogPath(dir, pipelineId)
      let raw: string
      try {
        raw = await readFile(path, 'utf8')
      } catch (error) {
        // 日志不存在 = 这条流水线还没有任何用量记录（不是错误）。
        if (isMissingFile(error)) return { events: [], skipped: [] }
        throw error
      }
      const events: UsageEvent[] = []
      const skipped: { line: number; reason: string }[] = []
      const lines = raw.split('\n')
      for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index]!.trim()
        if (line === '') continue
        try {
          const parsed = JSON.parse(line) as unknown
          if (!isUsageEvent(parsed)) throw new Error('用量事件字段缺失或类型不符')
          events.push(parsed)
        } catch (error) {
          skipped.push({ line: index + 1, reason: errorMessageOf(error) })
        }
      }
      return { events, skipped }
    },
  }
}

/**
 * 把"发生了什么"补齐成可落盘事件（scope / eventId / durationMs）。
 *
 * `now` 与 `newEventId` 可注入：测试要断言确定性的时长与 id，生产用真实时钟与 UUID。
 */
export class UsageRecorder implements UsageSink {
  private readonly store: UsageStore
  private readonly scope: { readonly tenantId: string; readonly projectId: string; readonly pipelineId: string }
  private readonly now: () => number
  private readonly newEventId: () => string

  constructor(options: {
    readonly store: UsageStore
    readonly scope: { readonly tenantId: string; readonly projectId: string; readonly pipelineId: string }
    readonly now?: () => number
    readonly newEventId?: () => string
  }) {
    this.store = options.store
    this.scope = options.scope
    this.now = options.now ?? (() => Date.now())
    this.newEventId = options.newEventId ?? (() => randomUUID())
  }

  async record(input: UsageRecordInput): Promise<void> {
    const event: UsageEvent = {
      eventId: this.newEventId(),
      tenantId: this.scope.tenantId,
      projectId: this.scope.projectId,
      pipelineId: this.scope.pipelineId,
      stageId: input.stageId,
      kind: input.kind,
      startedAt: input.startedAt,
      finishedAt: input.finishedAt,
      // 时长由两侧时间戳算出而不是由调用方自报：调用点各报一个数就会出现"时长与区间不符"。
      durationMs: Math.max(0, input.finishedAt - input.startedAt),
      success: input.success,
      ...(input.inputTokens === undefined ? {} : { inputTokens: input.inputTokens }),
      ...(input.outputTokens === undefined ? {} : { outputTokens: input.outputTokens }),
      ...(input.toolName === undefined ? {} : { toolName: input.toolName }),
      ...(input.errorCode === undefined ? {} : { errorCode: input.errorCode }),
      ...(input.caseCount === undefined ? {} : { caseCount: input.caseCount }),
      ...(input.failureCount === undefined ? {} : { failureCount: input.failureCount }),
      ...(input.evidenceCount === undefined ? {} : { evidenceCount: input.evidenceCount }),
    }
    // 这里**不吞异常**：UsageRecorder 是诚实实现，调用方经 recordUsage() 决定容错策略。
    await this.store.append(event)
  }
}

// ── 预算超限 ─────────────────────────────────────────────────────────────────

/** 超限维度。 */
export type UsageLimitKind = 'max-steps' | 'max-test-cases' | 'timeout' | 'max-retries'

/** 一条超限事实（`used` / `limit` 口径由 `kind` 决定）。 */
export interface UsageLimitExceeded {
  readonly kind: UsageLimitKind
  readonly stageId: StageId
  readonly used: number
  readonly limit: number
}

/**
 * 阶段超出预算（docs/10 §7.3）。
 *
 * 单独成一个类型而不是复用 `Error` + 文本匹配：driver 必须**区分**"预算超限"
 * 与"阶段随便抛了个异常"——前者要落盘成 `budget-exceeded` 失败并禁止自动进入
 * 人工批准，后者按运行期异常处理。
 *
 * 它属于核心层（`src/`），不继承 `PipelineRunError`（Web 层类型）：
 * 运行器与 driver 都不该依赖 Web 层错误模型。
 */
export class StageBudgetExceededError extends Error {
  readonly stageId: StageId
  readonly limit: UsageLimitExceeded

  constructor(stageId: StageId, limit: { readonly kind: UsageLimitKind; readonly used: number; readonly limit: number }) {
    super(budgetExceededMessage(stageId, limit))
    this.name = 'StageBudgetExceededError'
    this.stageId = stageId
    this.limit = { ...limit, stageId }
  }
}

function budgetExceededMessage(stageId: StageId, limit: { readonly kind: UsageLimitKind; readonly used: number; readonly limit: number }): string {
  switch (limit.kind) {
    case 'max-steps':
      return `stage "${stageId}" exceeded tool-call step budget (${limit.limit}): 已执行 ${limit.used} 次工具调用`
    case 'timeout':
      return `stage "${stageId}" exceeded wall-clock deadline (${limit.limit}ms): 实际耗时 ${limit.used}ms`
    case 'max-test-cases':
      return `stage "${stageId}" exceeded test-case budget (${limit.limit}): 已执行 ${limit.used} 个用例`
    case 'max-retries':
      return `stage "${stageId}" exceeded retry budget (${limit.limit}): 已重试 ${limit.used} 次`
  }
}

/**
 * 把异常归一成短错误码，供用量事件的 `errorCode` 字段使用。
 *
 * **绝不返回 `error.message`**：它可能带上 provider 响应片段或用户数据，而用量日志是
 * 长期留存、可被 Web/CLI 查询的（docs/10 §7.4「usage 事件不包含 API Key、完整 prompt
 * 或敏感响应」）。因此这里只映射到固定的枚举值。
 */
export function usageErrorCode(error: unknown): string {
  if (error instanceof StageBudgetExceededError) return 'budget-exceeded'
  if (!(error instanceof Error)) return 'unknown-error'
  if (error.name === 'AbortError') return 'cancelled'
  if (error.name === 'OpenAICompatibleError') return 'llm-request-failed'
  if (error.name === 'HumanGateWaitAbortedError') return 'gate-wait-aborted'
  if (error.name === 'Error') return 'operation-failed'
  return error.name
}

/** 阶段重试事实（来自检查点，不是用量事件——重试发生在 driver 内）。 */
export interface StageRetryFacts {
  /** 门禁重试次数（`StageState.gate.machine.attempts`）。 */
  readonly gateRetries: number
  /** 审核回喂重跑次数（`StageState.failures` 里 `review-fail` 的条数）。 */
  readonly reviewRetries: number
}

/** 从检查点阶段状态读重试事实。 */
export function retryFactsOf(state: {
  readonly gate: { readonly machine: { readonly attempts: number } }
  readonly failures: readonly { readonly kind: string }[]
}): StageRetryFacts {
  return {
    gateRetries: state.gate.machine.attempts,
    reviewRetries: state.failures.filter(failure => failure.kind === 'review-fail').length,
  }
}

/**
 * 从检查点阶段状态读"运行器当场停止"的次数（`failures[].kind === 'budget-exceeded'`）。
 *
 * 这是预算强制的**权威事实**：它由 driver 在阶段失败的那一刻落盘，与用量日志是否
 * 写成功无关。查询方要判断"这个阶段真的因为预算被拦下过"，看这里而不是看 `exceeded`。
 */
export function budgetFailuresOf(state: { readonly failures: readonly { readonly kind: string }[] }): number {
  return state.failures.filter(failure => failure.kind === 'budget-exceeded').length
}

// ── 汇总（used / limit / exceeded）──────────────────────────────────────────

/** 一段区间内的用量汇总。 */
export interface UsageTotals {
  readonly llmCalls: number
  readonly toolSteps: number
  /** 审核侧的模型调用次数（与 `llmCalls` **分开**：审核有独立预算，不能吞阶段主预算）。 */
  readonly reviewCalls: number
  readonly reviewToolSteps: number
  readonly executorInvocations: number
  readonly executorCases: number
  readonly executorFailures: number
  readonly executorEvidence: number
  /** 人工门等待时长（不计入模型预算，但要计入运行耗时）。 */
  readonly gateWaitMs: number
  /** 检查点落盘时长。 */
  readonly checkpointMs: number
  readonly inputTokens: number
  readonly outputTokens: number
  /**
   * token 计量是否完整：有模型调用且**每一次**都带回了 provider 用量。
   *
   * provider 未返回 usage 时（§7.2「未返回则标记 unavailable」）该值为 false，
   * 此时 `inputTokens`/`outputTokens` 只是"已知部分的下界"，不能当成真实用量。
   */
  readonly tokensAvailable: boolean
  /** 从最早事件开始到最晚事件结束的墙钟跨度（不是各段时长之和）。 */
  readonly wallClockMs: number
}

/** 单阶段用量汇总。 */
export interface StageUsageSummary {
  readonly stageId: StageId
  readonly budget: StageBudget
  readonly totals: UsageTotals
  readonly retries: StageRetryFacts
  /**
   * 按用量算出来的超限项。
   *
   * 与 {@link budgetFailures} 是**两个来源**，不要互相替代：
   * `exceeded` 是"读日志重算出来的口径"（例如模型一次响应里批量调了 30 个工具，
   * 而 `maxSteps` 是 20），`budgetFailures` 是"运行器当场停止并落盘的事实"
   * （模型用满预算后仍要求继续，运行器拒绝并抛错）。
   * 两者可能只出现其一，页面要把它们都显示出来才完整。
   */
  readonly exceeded: readonly UsageLimitExceeded[]
  /** 检查点里记录的 `budget-exceeded` 失败次数（运行器当场停止的权威事实）。 */
  readonly budgetFailures: number
}

/** 整条流水线的用量汇总（`GET /api/pipelines/:id/usage` 的响应体）。 */
export interface UsageSummary {
  readonly pipelineId: string
  readonly stages: readonly StageUsageSummary[]
  readonly totals: UsageTotals
  readonly exceeded: readonly UsageLimitExceeded[]
  /** 全流水线累计的预算强制停止次数（各阶段之和）。 */
  readonly budgetFailures: number
  /** 无法解析的日志行数；`> 0` 表示计量不完整，不能把它读成"用量为 0"。 */
  readonly skippedLines: number
}

export interface SummarizeUsageOptions {
  readonly budgetOf: (stageId: StageId) => StageBudget
  readonly retriesOf?: (stageId: StageId) => StageRetryFacts
  /** 检查点里该阶段的 `budget-exceeded` 失败条数；缺省 0。 */
  readonly budgetFailuresOf?: (stageId: StageId) => number
  readonly skippedLines?: number
  /**
   * 覆盖 `pipelineId`。缺省取首条事件的 `pipelineId`。
   *
   * 调用方（Web/CLI）应显式传入：**没有用量事件时**也要能回答"这条流水线的用量是多少"，
   * 而不是返回一个空 `pipelineId` 让页面以为查错了对象。
   */
  readonly pipelineId?: string
}

/**
 * 把用量事件聚合成 `used / limit / exceeded`（docs/10 §7.3）。
 *
 * 纯函数：同样的输入永远得到同样的输出，因此 Web 与 CLI 对同一条流水线给出一致结论，
 * 也与"谁先读"无关。
 *
 * 超限判定（`exceeded`）与**强制停止**是两件事：`max-steps` 会在运行器里当场抛错，
 * 这里只是把事实重新算出来给人看；`max-test-cases` 与 `timeout` 目前是**计量 + 报告**
 * （用例数由 design 阶段产物决定，阶段内不做硬中断），不伪装成"已强制拦截"。
 */
export function summarizeUsage(
  events: readonly UsageEvent[],
  options: SummarizeUsageOptions,
): UsageSummary {
  const byStage = new Map<StageId, UsageEvent[]>()
  for (const stageId of STAGE_ORDER) byStage.set(stageId, [])
  for (const event of events) {
    // 未知 stageId 的事件（例如将来新增阶段后读到旧日志）不参与阶段汇总，
    // 但也不丢：它仍会计入流水线级 totals。
    byStage.get(event.stageId)?.push(event)
  }

  const stages = STAGE_ORDER.map((stageId): StageUsageSummary => {
    const stageEvents = byStage.get(stageId) ?? []
    const budget = options.budgetOf(stageId)
    const totals = totalsOf(stageEvents)
    const retries = options.retriesOf?.(stageId) ?? { gateRetries: 0, reviewRetries: 0 }
    return {
      stageId,
      budget,
      totals,
      retries,
      exceeded: exceededOf(stageId, budget, totals, retries),
      budgetFailures: options.budgetFailuresOf?.(stageId) ?? 0,
    }
  })

  return {
    pipelineId: options.pipelineId ?? events[0]?.pipelineId ?? '',
    stages,
    totals: totalsOf(events),
    exceeded: stages.flatMap(stage => stage.exceeded),
    budgetFailures: stages.reduce((sum, stage) => sum + stage.budgetFailures, 0),
    skippedLines: options.skippedLines ?? 0,
  }
}

function totalsOf(events: readonly UsageEvent[]): UsageTotals {
  let llmCalls = 0
  let toolSteps = 0
  let reviewCalls = 0
  let reviewToolSteps = 0
  let executorInvocations = 0
  let executorCases = 0
  let executorFailures = 0
  let executorEvidence = 0
  let gateWaitMs = 0
  let checkpointMs = 0
  let inputTokens = 0
  let outputTokens = 0
  let llmCallsWithUsage = 0
  let startedAt = Number.POSITIVE_INFINITY
  let finishedAt = Number.NEGATIVE_INFINITY

  for (const event of events) {
    if (event.startedAt < startedAt) startedAt = event.startedAt
    if (event.finishedAt > finishedAt) finishedAt = event.finishedAt
    switch (event.kind) {
      case 'llm':
        llmCalls += 1
        if (event.inputTokens !== undefined || event.outputTokens !== undefined) llmCallsWithUsage += 1
        break
      case 'tool':
        toolSteps += 1
        break
      case 'review':
        if (event.toolName === undefined) reviewCalls += 1
        else reviewToolSteps += 1
        break
      case 'executor':
        executorInvocations += 1
        executorCases += event.caseCount ?? 0
        executorFailures += event.failureCount ?? 0
        executorEvidence += event.evidenceCount ?? 0
        break
      case 'gate':
        gateWaitMs += event.durationMs
        break
      case 'checkpoint':
        checkpointMs += event.durationMs
        break
    }
    inputTokens += event.inputTokens ?? 0
    outputTokens += event.outputTokens ?? 0
  }

  return {
    llmCalls,
    toolSteps,
    reviewCalls,
    reviewToolSteps,
    executorInvocations,
    executorCases,
    executorFailures,
    executorEvidence,
    gateWaitMs,
    checkpointMs,
    inputTokens,
    outputTokens,
    tokensAvailable: llmCalls > 0 && llmCallsWithUsage === llmCalls,
    wallClockMs: Number.isFinite(startedAt) && Number.isFinite(finishedAt) ? Math.max(0, finishedAt - startedAt) : 0,
  }
}

function exceededOf(
  stageId: StageId,
  budget: StageBudget,
  totals: UsageTotals,
  retries: StageRetryFacts,
): readonly UsageLimitExceeded[] {
  const exceeded: UsageLimitExceeded[] = []
  if (totals.toolSteps > budget.maxSteps) {
    exceeded.push({ kind: 'max-steps', stageId, used: totals.toolSteps, limit: budget.maxSteps })
  }
  // `timeoutMs: 0` = 项目定义，**不设阶段 deadline**（docs/10 §7.3 明确要求保持这个语义）。
  // 因此这里不是"0 毫秒就超时"，而是"不参与判定"。
  if (budget.timeoutMs > 0 && totals.wallClockMs > budget.timeoutMs) {
    exceeded.push({ kind: 'timeout', stageId, used: totals.wallClockMs, limit: budget.timeoutMs })
  }
  // 只有配置显式声明了 maxTestCases 才判定；未声明 = 不设上限。
  if (budget.maxTestCases !== undefined && totals.executorCases > budget.maxTestCases) {
    exceeded.push({ kind: 'max-test-cases', stageId, used: totals.executorCases, limit: budget.maxTestCases })
  }
  // 重试预算：门禁重试与审核重试**各自**受 `maxRetries` 约束（不是二者之和），
  // 因此取两者的较大值与该上限比较。
  const usedRetries = Math.max(retries.gateRetries, retries.reviewRetries)
  if (usedRetries > budget.maxRetries) {
    exceeded.push({ kind: 'max-retries', stageId, used: usedRetries, limit: budget.maxRetries })
  }
  return exceeded
}

// ── 校验辅助 ─────────────────────────────────────────────────────────────────

/**
 * 拒绝会把路径带出目录的标识符。
 *
 * `pipelineId` 上游已按安全标识符校验过（`PipelineRunService`），但用量日志是
 * **按 id 拼文件名**的，多一道包含性防线比"相信上游"便宜得多。
 */
function assertSafeSegment(value: string, field: string): string {
  if (value.trim() === '' || value.includes('/') || value.includes('\\') || value === '.' || value === '..') {
    throw new Error(`${field} 不能用作路径片段：${JSON.stringify(value)}`)
  }
  return value
}

function isUsageEvent(value: unknown): value is UsageEvent {
  if (value === null || typeof value !== 'object') return false
  const candidate = value as Record<string, unknown>
  return typeof candidate.eventId === 'string' && candidate.eventId !== ''
    && typeof candidate.pipelineId === 'string' && candidate.pipelineId !== ''
    && typeof candidate.kind === 'string'
    && typeof candidate.startedAt === 'number'
    && typeof candidate.finishedAt === 'number'
    && typeof candidate.success === 'boolean'
    && typeof candidate.stageId === 'string'
    && (STAGE_ORDER as readonly string[]).includes(candidate.stageId)
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && 'code' in error && (error as { code?: string }).code === 'ENOENT'
}

function errorMessageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
