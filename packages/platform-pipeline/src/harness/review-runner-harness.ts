/**
 * 交叉检查审核 agent 的 harness 适配器（docs/03 第 7 节 / docs/09 第 3 节）。
 * 通过 `ctx.subagents.start` spawn 独立审核 agent（盲审、零父上下文），
 * 用 `outputSchema`（结构化输出）强制 verdict/findings/checked 结构；
 * 审核不可用（超时/失败/无结构化结果）→ 降级 degraded（03 第 7.5 节，不阻塞流水线）。
 * 运行时零 harness 依赖（type-only import，I-4）。
 * @module platform-pipeline/harness/review-runner-harness
 */

import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { SubagentRuntime } from '@deepseek-ai/dsh-subagent'
import type { ReviewOutcome, ReviewRunner } from '../driver.ts'
import type { JudgeResult } from '../gates/machine.ts'
import { assembleReviewPrompt } from '../prompt/review.ts'
import { toContentBlocks } from './stage-spawner-harness.ts'
import type { StageArtifact, StageId, SubsetSchema } from '../types.ts'

export interface HarnessReviewDeps {
  /** `ctx.subagents` 的 start 面。 */
  readonly subagents: Pick<SubagentRuntime, 'start'>
  /** 发起审核的宿主 agent（in-process provider 由此派生）。 */
  readonly parent: Agent
  readonly signal: AbortSignal
  readonly providerName?: string
  readonly maxDepth?: number
}

/** 审核报告结构化 schema（docs/03 第 7.4 节；outputSchema 用，断言子集兼容）。 */
export const REVIEW_OUTPUT_SCHEMA: SubsetSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['stageId', 'verdict', 'findings', 'checked', 'confidence'],
  properties: {
    stageId: { type: 'string' },
    verdict: { type: 'string', enum: ['pass', 'conditional', 'fail'] },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['severity', 'claim', 'evidence', 'suggestedAction'],
        properties: {
          severity: { type: 'string', enum: ['blocker', 'concern', 'nit'] },
          claim: { type: 'string' },
          evidence: { type: 'string' },
          suggestedAction: { type: 'string', enum: ['rerun', 'address-in-human-gate', 'optional'] },
        },
      },
    },
    checked: { type: 'array', items: { type: 'string' } },
    confidence: { type: 'number' },
  },
}

interface ReviewStructured {
  readonly stageId: string
  readonly verdict: 'pass' | 'conditional' | 'fail'
  readonly findings: readonly { readonly severity: string; readonly claim: string }[]
  readonly checked: readonly string[]
}

/** harness 适配的 ReviewRunner 实现。 */
export class HarnessReviewRunner implements ReviewRunner {
  private readonly deps: HarnessReviewDeps

  constructor(deps: HarnessReviewDeps) {
    this.deps = deps
  }

  async run(stageId: StageId, artifact: StageArtifact, gate: JudgeResult): Promise<ReviewOutcome> {
    const dir = artifact.path.slice(0, artifact.path.lastIndexOf('/'))
    const upstreamPaths: Record<string, string> = {}
    for (const upstream of Object.keys(artifact.inputs)) {
      upstreamPaths[upstream] = `${dir}/${upstream}.json`
    }
    const prompt = assembleReviewPrompt({
      stageId,
      pipelineId: artifact.pipelineId,
      artifactPath: artifact.path,
      upstreamPaths,
      violations: gate.violations.map(v => ({ rule: v.rule, level: v.level, detail: v.detail })),
    })
    const run = await this.deps.subagents.start(this.deps.providerName ?? 'spawn', {
      label: `review:${stageId}`,
      prompt: toContentBlocks(prompt),
      parent: this.deps.parent,
      signal: this.deps.signal,
      outputSchema: REVIEW_OUTPUT_SCHEMA as never, // <验证点> ObjectJsonSchema 断言子集
      ...(this.deps.maxDepth === undefined ? {} : { maxDepth: this.deps.maxDepth }),
    })
    try {
      const result = await run.result
      if (result.stopReason !== 'completed' || result.structured === undefined) {
        return { verdict: 'degraded', findings: [`审核 agent 未返回结构化结果（${result.stopReason}）`] }
      }
      const structured = result.structured as unknown as ReviewStructured
      return {
        verdict: structured.verdict,
        findings: structured.findings.map(f => f.claim),
      }
    } finally {
      run.dispose()
    }
  }
}
