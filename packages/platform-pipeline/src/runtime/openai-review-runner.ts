/**
 * 无 Harness 的交叉检查审核 runner（docs/03 第 7 节）。
 *
 * 与 `OpenAIStageRunner` 同源：`assembleReviewPrompt` → LlmClient → 只读工具循环 →
 * 结构化审核报告。差异在纪律：
 * - **盲审**：只看产物路径 + 上游路径 + 机器门禁违规清单，不带任何生产 agent 上下文；
 * - **只读**：默认只暴露 `fs_read`，审核不能改产物；
 * - **不阻塞**：审核不可用（无模型、无结构化结果、超出步数预算）一律降级 `degraded`
 *   （docs/03 第 7.5 节），由编排器标记 reviewDegraded 而不是让流水线崩掉；
 * - **不放过阻断项**：findings 里出现 `blocker` 时强制 `fail`，不采信模型自报的 `pass`。
 *
 * @module platform-pipeline/runtime/openai-review-runner
 */

import { assembleReviewPrompt } from '../prompt/review.ts'
import type { ReviewOutcome, ReviewRunner } from '../driver.ts'
import type { JudgeResult } from '../gates/machine.ts'
import type { StageArtifact, StageId } from '../types.ts'
import type { LlmClient, LlmMessage, LlmResponse, ToolDefinition, ToolRegistry } from './ports.ts'

/** 审核默认只能用的工具（盲审只读；docs/03 第 7 节）。 */
export const DEFAULT_REVIEW_TOOLS: readonly string[] = ['fs_read']

const DEFAULT_MAX_REVIEW_STEPS = 8

export interface OpenAIReviewRunnerOptions {
  readonly llm: LlmClient
  readonly model: string
  /** 宿主工具集；审核会从中按 `allowedTools` 取交集，缺省只有 `fs_read`。 */
  readonly tools?: ToolRegistry
  readonly allowedTools?: readonly string[]
  readonly systemPrompt?: string
  readonly maxToolSteps?: number
  readonly signal?: AbortSignal
}

export class OpenAIReviewRunner implements ReviewRunner {
  private readonly options: OpenAIReviewRunnerOptions

  constructor(options: OpenAIReviewRunnerOptions) {
    this.options = options
  }

  async run(stageId: StageId, artifact: StageArtifact, gate: JudgeResult): Promise<ReviewOutcome> {
    try {
      return await this.review(stageId, artifact, gate)
    } catch (error) {
      // 审核不可用 → 降级，不阻塞流水线（docs/03 第 7.5 节）
      return { verdict: 'degraded', findings: [`交叉检查不可用：${errorMessage(error)}`] }
    }
  }

  private async review(stageId: StageId, artifact: StageArtifact, gate: JudgeResult): Promise<ReviewOutcome> {
    const dir = artifact.path.slice(0, artifact.path.lastIndexOf('/'))
    const upstreamPaths: Record<string, string> = {}
    for (const upstream of Object.keys(artifact.inputs)) upstreamPaths[upstream] = `${dir}/${upstream}.json`

    const prompt = assembleReviewPrompt({
      stageId,
      pipelineId: artifact.pipelineId,
      artifactPath: artifact.path,
      upstreamPaths,
      violations: gate.violations.map(v => ({ rule: v.rule, level: v.level, detail: v.detail })),
    })

    const tools = this.restrictedTools()
    const messages: LlmMessage[] = [
      ...(this.options.systemPrompt === undefined ? [] : [{ role: 'system' as const, content: this.options.systemPrompt }]),
      { role: 'user', content: prompt },
    ]
    const maxSteps = this.options.maxToolSteps ?? DEFAULT_MAX_REVIEW_STEPS

    let response: LlmResponse | undefined
    for (let step = 0; step < maxSteps; step += 1) {
      response = await this.options.llm.complete({
        model: this.options.model,
        messages,
        ...(tools.length === 0 ? {} : { tools }),
        responseFormat: { type: 'json_object' },
        signal: this.options.signal,
      })
      if (response.toolCalls === undefined || response.toolCalls.length === 0) break
      messages.push({ role: 'assistant', content: response.content, toolCalls: response.toolCalls })
      for (const call of response.toolCalls) {
        messages.push({
          role: 'tool',
          toolCallId: call.id,
          toolName: call.name,
          content: await runReviewTool(tools.find(candidate => candidate.name === call.name), call, stageId, artifact.pipelineId, this.options.signal),
        })
      }
    }

    if (response === undefined) throw new Error('审核模型未返回结果')
    if (response.toolCalls !== undefined && response.toolCalls.length > 0) throw new Error(`审核超出工具步数预算（${maxSteps}）`)
    return normalizeReview(parseReviewReport(response))
  }

  private restrictedTools(): readonly ToolDefinition[] {
    if (this.options.tools === undefined) return []
    const allowed = this.options.allowedTools ?? DEFAULT_REVIEW_TOOLS
    return this.options.tools.list().filter(tool => allowed.includes(tool.name))
  }
}

interface ReviewFinding {
  readonly severity: 'blocker' | 'concern' | 'nit'
  readonly claim: string
  readonly evidence: string
}

/**
 * 归一化审核报告：
 * - verdict 必须是 pass/conditional/fail，否则降级（不猜、不放行）；
 * - findings 必须是数组，否则降级；
 * - 出现 blocker → 强制 fail（安全方向优先：宁可多一次重跑，也不放过阻断项）。
 */
function normalizeReview(raw: unknown): ReviewOutcome {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { verdict: 'degraded', findings: ['审核返回的结构不是对象'] }
  }
  const record = raw as Record<string, unknown>
  const verdict = record.verdict
  if (verdict !== 'pass' && verdict !== 'conditional' && verdict !== 'fail') {
    return { verdict: 'degraded', findings: [`审核返回了非法 verdict：${JSON.stringify(verdict)}`] }
  }
  if (!Array.isArray(record.findings)) {
    return { verdict: 'degraded', findings: ['审核报告的 findings 不是数组'] }
  }

  const findings = record.findings.map(toFinding)
  const lines = findings.map(finding => finding.evidence === ''
    ? `[${finding.severity}] ${finding.claim}`
    : `[${finding.severity}] ${finding.claim}｜证据：${finding.evidence}`)
  const coverage = renderCoverage(record.checked)
  if (coverage !== undefined) lines.push(coverage)

  return {
    verdict: findings.some(finding => finding.severity === 'blocker') ? 'fail' : verdict,
    findings: lines,
  }
}

function toFinding(value: unknown): ReviewFinding {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { severity: 'concern', claim: JSON.stringify(value) ?? '（无法解析的 finding）', evidence: '' }
  }
  const record = value as Record<string, unknown>
  const severity = record.severity === 'blocker' || record.severity === 'nit' ? record.severity : 'concern'
  return {
    severity,
    claim: typeof record.claim === 'string' && record.claim.trim() !== '' ? record.claim : JSON.stringify(record),
    evidence: typeof record.evidence === 'string' ? record.evidence : '',
  }
}

/** 把「本次实际复核面」附在 findings 末尾：不阻塞，但让人工门看到审核覆盖面。 */
function renderCoverage(checked: unknown): string | undefined {
  if (!Array.isArray(checked) || checked.length === 0) return '审核覆盖：未声明（checked 为空）'
  return `审核覆盖：${checked.map(item => String(item)).join('；')}`
}

async function runReviewTool(
  tool: ToolDefinition | undefined,
  call: { readonly id: string; readonly name: string; readonly arguments: string },
  stageId: StageId,
  pipelineId: string,
  signal: AbortSignal | undefined,
): Promise<string> {
  if (tool === undefined) return JSON.stringify({ error: `tool is not available to the reviewer: ${call.name}` })
  let args: unknown
  try {
    args = call.arguments.trim() === '' ? {} : JSON.parse(call.arguments)
  } catch {
    return JSON.stringify({ error: 'tool arguments were not valid JSON' })
  }
  try {
    const result = await tool.execute(args, { signal: signal ?? new AbortController().signal, stageId, pipelineId })
    return typeof result === 'string' ? result : JSON.stringify(result)
  } catch (error) {
    return JSON.stringify({ error: errorMessage(error) })
  }
}

function parseReviewReport(response: LlmResponse): unknown {
  if (response.json !== undefined) return response.json
  const text = response.content.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
  if (text === '') throw new Error('审核模型返回空报告')
  return JSON.parse(text) as unknown
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
