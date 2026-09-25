import { assemblePrompt } from '../prompt/assemble.ts'
import { computeArtifactDigest } from '../gates/machine.ts'
import { resolveStageAcl, type SpawnRequest, type SpawnedRun, type StageSpawner } from '../stage-spawner.ts'
import type { ArtifactStore } from '../driver.ts'
import type { PipelineConfig, StageArtifact, StageId } from '../types.ts'
import {
  StageBudgetExceededError,
  recordUsage,
  usageErrorCode,
  type UsageRecordInput,
  type UsageSink,
} from '../usage.ts'
import type { LlmClient, LlmMessage, LlmResponse, ToolDefinition, ToolRegistry } from './ports.ts'

export interface OpenAIStageRunnerOptions {
  readonly llm: LlmClient
  readonly tools?: ToolRegistry
  readonly artifacts: ArtifactStore
  readonly model: string
  readonly systemPrompt?: string
  readonly maxToolSteps?: number
  readonly signal?: AbortSignal
  /**
   * 用量落点（docs/10 §7.3）。缺省 = 不计量，行为与 M3 之前逐字一致。
   *
   * 计量是**尽力而为**的观测（见 `usage.ts` 的 `recordUsage`），而预算强制在
   * 本类内存里完成——因此"没接 sink"不等于"没有预算约束"。
   */
  readonly usage?: UsageSink
  /** 时钟注入（测试要断言确定性的时长，docs/09「测试零真实等待」）。 */
  readonly now?: () => number
}

/**
 * 无 Harness 的 Agent 阶段运行器：prompt → LLM → 受限工具调用 → 结构化产物。
 *
 * 它只依赖 LlmClient、ToolRegistry 和 ArtifactStore，Harness 适配器可以完全替换。
 *
 * M3 起它同时承担**阶段预算的真实约束**（docs/10 §7.3）：
 * - 工具步数超过 `budget.maxSteps` → 立即停止并抛 {@link StageBudgetExceededError}；
 * - `budget.timeoutMs > 0` → 用派生 `AbortSignal` 实施阶段 wall-clock deadline；
 *   `timeoutMs: 0` 保持"不设 deadline"语义，**不是**立即超时；
 * - 每次模型调用与工具调用各记一条用量事件（含 token；provider 未返回则留空，
 *   由汇总层标记 `tokensAvailable: false`）。
 *
 * deadline 用**派生信号**而不是复用宿主信号：阶段超时被中止，不能连带把整条流水线
 * 的宿主信号置为 aborted——否则后续阶段会带着"已取消"的信号启动，
 * 也会让上层把它误读成人工门取消（docs/10 §7.4）。
 */
export class OpenAIStageRunner implements StageSpawner {
  private readonly options: OpenAIStageRunnerOptions
  private readonly now: () => number

  constructor(options: OpenAIStageRunnerOptions) {
    this.options = options
    this.now = options.now ?? (() => Date.now())
  }

  async runStage(request: SpawnRequest, cfg: PipelineConfig): Promise<SpawnedRun> {
    const resolved = resolveStageAcl(request.stageId, cfg)
    if (!resolved.ok) throw new Error(`stage "${request.stageId}" ACL invalid: ${resolved.errors.join('; ')}`)
    const budget = cfg.stages[request.stageId].budget
    const prompt = assemblePrompt({
      stageId: request.stageId,
      pipelineId: request.pipelineId,
      inputPaths: request.inputPaths,
      inputDigests: request.inputDigests,
      artifactPath: request.artifactPath,
      budget,
      toolAcl: resolved.acl,
      schemaFilePath: `schemas/${request.stageId}.schema.json`,
      ...(request.extraContext === undefined ? {} : { extraContext: request.extraContext }),
      ...(request.previousViolations === undefined ? {} : { previousViolations: request.previousViolations }),
    })
    // A generic runtime may provide only a subset of the platform catalog. Expose
    // the intersection; an unavailable model-requested name is handled explicitly
    // below instead of failing before the LLM gets a chance to finish.
    const restrictedTools = this.options.tools === undefined ? [] : this.options.tools.list().filter(tool => isAllowedTool(tool.name, resolved.acl))
    const messages: LlmMessage[] = [
      ...(this.options.systemPrompt === undefined ? [] : [{ role: 'system' as const, content: this.options.systemPrompt }]),
      { role: 'user', content: prompt },
    ]

    const startedAt = this.now()
    const callerSignal = this.options.signal
    // `timeoutMs: 0` = 项目定义 → 不设阶段 deadline（docs/10 §7.3 明确要求保持该语义）。
    const deadlineSignal = budget.timeoutMs > 0 ? AbortSignal.timeout(budget.timeoutMs) : undefined
    const signal = combineSignals(deadlineSignal, callerSignal)
    const toolSignal = signal ?? new AbortController().signal
    const throwIfDeadlineExceeded = (): void => {
      if (deadlineSignal?.aborted !== true) return
      // 宿主信号也中止时不归因于预算：那是"用户取消"，不是"阶段超时"。
      if (callerSignal?.aborted === true) return
      throw new StageBudgetExceededError(request.stageId, {
        kind: 'timeout',
        used: Math.max(0, this.now() - startedAt),
        limit: budget.timeoutMs,
      })
    }

    const record = (input: UsageRecordInput): Promise<void> => recordUsage(this.options.usage, input)
    const maxSteps = Math.min(budget.maxSteps, this.options.maxToolSteps ?? 20)
    let toolSteps = 0
    let response: LlmResponse | undefined
    for (let step = 0; step < maxSteps; step += 1) {
      response = await completeWithUsage(this.options.llm, {
        model: this.options.model,
        messages,
        ...(restrictedTools.length === 0 ? {} : { tools: restrictedTools }),
        responseFormat: { type: 'json_object' },
        ...(signal === undefined ? {} : { signal }),
      }, request.stageId, record, this.now)
      throwIfDeadlineExceeded()
      if (response.toolCalls === undefined || response.toolCalls.length === 0) break
      messages.push({
        role: 'assistant',
        content: response.content,
        toolCalls: response.toolCalls,
      })
      for (const call of response.toolCalls) {
        toolSteps += 1
        const tool = restrictedTools.find(candidate => candidate.name === call.name)
        const callStartedAt = this.now()
        const outcome = tool === undefined
          ? { content: JSON.stringify({ error: `tool is not available: ${call.name}` }), ok: false, errorCode: 'tool-unavailable' }
          : await executeToolCall(tool, call.arguments, {
            signal: toolSignal,
            stageId: request.stageId,
            pipelineId: request.pipelineId,
          })
        await record({
          stageId: request.stageId,
          kind: 'tool',
          startedAt: callStartedAt,
          finishedAt: this.now(),
          success: outcome.ok,
          toolName: call.name,
          ...(outcome.errorCode === undefined ? {} : { errorCode: outcome.errorCode }),
        })
        throwIfDeadlineExceeded()
        messages.push({ role: 'tool', toolCallId: call.id, toolName: call.name, content: outcome.content })
      }
    }
    if (response === undefined) throw new Error(`stage "${request.stageId}" received no LLM response`)
    if (response.toolCalls !== undefined && response.toolCalls.length > 0) {
      // 循环用尽仍有未回喂的工具调用 = 模型还想继续调工具，但阶段预算不允许。
      // 立即停止（不再多跑一轮模型），并把事实交给 driver 落盘成 budget-exceeded。
      //
      // `used = toolSteps + 1`：被拒绝的那一刻模型**仍要求**再来一步，因此真实需求
      // 至少是 `toolSteps + 1`。报 `toolSteps` 会得到 `used === limit`，
      // 与"超出预算"的语义自相矛盾（也让汇总层的 `used > limit` 判据漏报）。
      throw new StageBudgetExceededError(request.stageId, { kind: 'max-steps', used: toolSteps + 1, limit: maxSteps })
    }
    const content = parseStructuredContent(response)
    const previous = await this.options.artifacts.read(request.artifactPath)
    const base: StageArtifact = {
      pipelineId: request.pipelineId,
      stageId: request.stageId,
      version: (previous?.version ?? 0) + 1,
      inputs: request.inputDigests ?? {},
      content,
      digest: '',
      path: request.artifactPath,
    }
    if (this.options.artifacts.write === undefined) throw new Error('OpenAIStageRunner requires an ArtifactStore.write implementation')
    await this.options.artifacts.write({ ...base, digest: computeArtifactDigest(base) })
    return { stageId: request.stageId, artifactPath: request.artifactPath }
  }
}

/**
 * 调一次模型并记一条 `llm` 用量事件（成功与失败都记）。
 *
 * 失败也记是有意的：`docs/10 §7.4` 要求"LLM 超时不会被误记为人工门取消"，
 * 而"超时确实发生过"这件事只有失败事件能证明。事件里只放**归一化的 errorCode**，
 * 不放 provider 原文——那可能带上响应内容（§7.4 禁止）。
 */
async function completeWithUsage(
  llm: LlmClient,
  request: Parameters<LlmClient['complete']>[0],
  stageId: StageId,
  record: (input: UsageRecordInput) => Promise<void>,
  now: () => number,
): Promise<LlmResponse> {
  const startedAt = now()
  try {
    const response = await llm.complete(request)
    await record({
      stageId,
      kind: 'llm',
      startedAt,
      finishedAt: now(),
      success: true,
      ...(response.usage?.inputTokens === undefined ? {} : { inputTokens: response.usage.inputTokens }),
      ...(response.usage?.outputTokens === undefined ? {} : { outputTokens: response.usage.outputTokens }),
    })
    return response
  } catch (error) {
    await record({
      stageId,
      kind: 'llm',
      startedAt,
      finishedAt: now(),
      success: false,
      errorCode: usageErrorCode(error),
    })
    throw error
  }
}

/** 工具调用结果：`ok`/`errorCode` 供用量事件使用，`content` 原样回喂模型。 */
interface ToolCallOutcome {
  readonly content: string
  readonly ok: boolean
  readonly errorCode?: string
}

async function executeToolCall(
  tool: ToolDefinition,
  rawArguments: string,
  context: { signal: AbortSignal; stageId: SpawnRequest['stageId']; pipelineId: string },
): Promise<ToolCallOutcome> {
  let args: unknown
  try {
    args = rawArguments.trim() === '' ? {} : JSON.parse(rawArguments)
  } catch {
    return { content: JSON.stringify({ error: 'tool arguments were not valid JSON' }), ok: false, errorCode: 'invalid-arguments' }
  }
  try {
    const result = await tool.execute(args, context)
    return { content: serializeToolResult(result), ok: true }
  } catch (error) {
    return {
      content: JSON.stringify({ error: error instanceof Error ? error.message : String(error) }),
      ok: false,
      errorCode: 'tool-failed',
    }
  }
}

/**
 * 把异常归一成短错误码。
 *
 * **绝不返回 `error.message`**：它可能带上 provider 响应片段或用户数据，
 * 而用量日志是长期留存、可被 Web/CLI 查询的（docs/10 §7.4）。
 * 实现放在 `usage.ts`，让 driver / 审核 / 运行器共用同一套映射。
 */

function combineSignals(primary: AbortSignal | undefined, secondary: AbortSignal | undefined): AbortSignal | undefined {
  if (primary === undefined) return secondary
  if (secondary === undefined) return primary
  return AbortSignal.any([primary, secondary])
}

function parseStructuredContent(response: LlmResponse): unknown {
  if (response.json !== undefined) return response.json
  const text = response.content.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
  if (text === '') throw new Error('LLM returned empty stage artifact')
  try { return JSON.parse(text) } catch { throw new Error('LLM returned non-JSON stage artifact') }
}

function isAllowedTool(name: string, filter: { readonly allow?: readonly string[]; readonly deny?: readonly string[] }): boolean {
  if (filter.deny?.includes(name)) return false
  return filter.allow === undefined || filter.allow.includes(name)
}

function serializeToolResult(value: unknown): string {
  if (typeof value === 'string') return value
  try { return JSON.stringify(value) } catch { return JSON.stringify({ error: 'tool result was not serializable' }) }
}
