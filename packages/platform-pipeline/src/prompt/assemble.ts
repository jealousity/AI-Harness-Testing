/**
 * Prompt 拼装器（docs/04 第 2/5 节；docs/05 模板）。
 * - 公共骨架 + 阶段差异段 → 完整自包含 prompt。
 * - extraContext 上限（D-15：默认 2K token 近似 = 6000 字符），超限截断并标注。
 * - 门禁重跑时 previousViolations 回喂进 prompt（docs/01 第 5 节）。
 * @module platform-pipeline/prompt/assemble
 */

import { COMMON_SKELETON } from './common.ts'
import { STAGE_SPECS } from './specs.ts'
import type { StageBudget, StageId, ToolFilter, Violation } from '../types.ts'

/** extraContext 上限（D-15：2K token 近似；中文约 1.5~2 字符/token，取保守 3 字符）。 */
export const MAX_EXTRA_CONTEXT_CHARS = 6000
export const TRUNCATED_MARK = '\n…[extraContext 已截断，仅保留开头]'

export interface PromptInput {
  readonly stageId: StageId
  readonly pipelineId: string
  /** 上游产物路径（仅路径，不传正文——docs/03 第 2.3 节）。 */
  readonly inputPaths: Readonly<Record<string, string>>
  /** 上游产物的权威 digest（编排器注入；agent 无哈希工具，须原样抄写进 inputs）。 */
  readonly inputDigests?: Readonly<Record<string, string>>
  readonly artifactPath: string
  readonly budget: StageBudget
  /** 生效 ACL（声明层展示；强制层由 stage-spawner 的 toolFilter 保证）。 */
  readonly toolAcl: ToolFilter
  /** 完整 schema 文件路径（外链；内联简版已在 specs 中）。 */
  readonly schemaFilePath?: string
  /** 重入/回环时携带（人工答复/门 G 批准等），受上限截断。 */
  readonly extraContext?: string
  /** 门禁重跑时携带的违规清单。 */
  readonly previousViolations?: readonly Violation[]
}

/** 截断 extraContext 到上限字符数，超限在末尾标注。 */
export function capExtraContext(text: string | undefined, maxChars = MAX_EXTRA_CONTEXT_CHARS): string {
  if (text === undefined || text === '') return ''
  if (text.length <= maxChars) return text
  return `${text.slice(0, maxChars)}${TRUNCATED_MARK}`
}

/**
 * 渲染输入摘要锁：给出编排器注入的**权威 digest 真值**供 agent 原样抄写。
 * 无 digest 的上游不渲染占位符——agent 无哈希工具，任何占位符都只能是编造值，
 * 会让 G-08 误判并污染证据链；缺项由 driver.fillInputLocks 兜底补全。
 */
function renderInputLocks(
  inputPaths: Readonly<Record<string, string>>,
  inputDigests: Readonly<Record<string, string>> | undefined,
): string {
  const entries = Object.entries(inputDigests ?? {})
    .filter(([upstream]) => inputPaths[upstream] !== undefined)
  return entries.map(([upstream, digest]) => `"${upstream}": "${digest}"`).join(', ')
}

function renderViolations(violations: readonly Violation[] | undefined): string {
  if (violations === undefined || violations.length === 0) return ''
  const lines = violations.map(v => `- [${v.level}] ${v.rule}: ${v.detail}`)
  return `\n## 重跑要求（机器门禁违规，必须逐条修复后重新提交）\n${lines.join('\n')}\n`
}

function fill(template: string, slots: Readonly<Record<string, string>>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (match, name: string) => slots[name] ?? match)
}

/** 拼装完整阶段 prompt。 */
export function assemblePrompt(input: PromptInput): string {
  const spec = STAGE_SPECS[input.stageId]
  const extra = capExtraContext(input.extraContext)
  const extraSection = [
    extra === '' ? '' : `\n## 9. 本次运行附加上下文（extraContext）\n${extra}\n`,
    renderViolations(input.previousViolations),
  ].join('')

  const slots: Record<string, string> = {
    stageName: input.stageId,
    stageTitle: spec.title,
    stageId: input.stageId,
    roleTail: spec.roleTail,
    pipelineId: input.pipelineId,
    inputPaths: Object.entries(input.inputPaths).map(([k, v]) => `- ${k}: ${v}`).join('\n') || '（无上游产物）',
    task: spec.task,
    artifactPath: input.artifactPath,
    schemaInline: spec.schemaInline,
    inputLocks: renderInputLocks(input.inputPaths, input.inputDigests),
    schemaFileNote: input.schemaFilePath === undefined
      ? ''
      : `- 完整 schema 文件：${input.schemaFilePath}（可 read 读取，以文件为准）`,
    allowTools: spec.allowTools.join('、'),
    denyTools: spec.denyTools.join('、'),
    maxSteps: String(input.budget.maxSteps),
    boundaries: spec.boundaries,
    artifactNotes: spec.artifactNotes,
    extraSection,
  }
  return fill(COMMON_SKELETON, slots)
}
