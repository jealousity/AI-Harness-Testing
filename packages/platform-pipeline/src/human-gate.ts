/**
 * 人工门 UI 审核实现（docs/03 第 3 节 / docs/09 第 2 节 / I-2）：
 * 复用 harness 的 ctx.userQuestions（ui-user-questions 弹窗流）把每个阶段的
 * 产物 + 机器门禁判定 + 交叉检查 findings 呈现给真人，阻塞等待裁决。
 *
 * 裁决编码：批准 / 需修改 / 拒绝 → HumanDecision。裁决同时记录一条
 * HumanGateRecord（by / action / note），由可选的 onDecision 回调持久化
 * （driver 当前不合并记录，宿主可据此落审计）。
 *
 * 本文件零 harness 运行时引用：ask 服务以形状依赖注入，UI provider 由宿主
 * 在 ctx.userQuestions 上注册——保持 I-4 独立 npm 包的依赖边界。
 * @module platform-pipeline/human-gate
 */

import type { HumanDecision, HumanGatePort } from './driver.ts'
import type { JudgeResult } from './gates/machine.ts'
import { STAGE_ORDER, type StageArtifact, type StageId } from './types.ts'

// ── ask 服务的形状依赖（harness 注入 ctx.userQuestions；本包不 import 它）──

interface AskOption {
  readonly label: string
  readonly description?: string
}

interface AskItem {
  readonly id: string
  readonly question: string
  readonly header?: string
  readonly detail?: string
  readonly options?: readonly AskOption[]
  readonly multiSelect?: boolean
}

interface AskAnswerItem {
  readonly id: string
  readonly selected: readonly string[]
  readonly custom?: string
}

interface AskAnswer {
  readonly answers: readonly AskAnswerItem[]
}

export interface UserQuestions {
  ask(request: { readonly questions: readonly AskItem[]; readonly signal?: AbortSignal }): Promise<AskAnswer>
}

// ── 裁决审计记录（HumanGateRecord 子集）──

export interface HumanGateAuditRecord {
  readonly by: string
  readonly action: HumanDecision
  readonly note: string
  readonly stageId: StageId
  readonly at: number
}

export interface HumanGateDeps {
  /** 宿主注入的 ctx.userQuestions 实例。 */
  readonly userQuestions: UserQuestions
  /** 裁决记录回调（可选；落审计/检查点用）。 */
  readonly onDecision?: (record: HumanGateAuditRecord) => void
  /** 人工门 id（如 'A'~'G'）与阶段的映射；缺省按阶段顺序推导 A/B/C/D/E/F。 */
  readonly gateLetterByStage?: Readonly<Record<StageId, string>>
  /** 取消信号（流水线整体取消时不再阻塞等人工）。 */
  readonly signal?: AbortSignal
  /** 裁决人标识（记录用）。 */
  readonly by?: string
}

export const APPROVE = '批准' as const
export const CHANGES_NEEDED = '需修改' as const
export const REJECT = '拒绝' as const

const DEFAULT_GATE_LETTERS: readonly string[] = ['A', 'B', 'C', 'D', 'E', 'F']

function safeContentStr(content: unknown, maxChars = 1000): string {
  try {
    let s = JSON.stringify(content)
    if (s.length > maxChars) s = `${s.slice(0, maxChars)}...（截断，共 ${s.length} 字符）`
    return s
  } catch {
    return String(content)
  }
}

function formatGate(gate: JudgeResult): string {
  const blocking = gate.violations.filter(v => v.level === 'BLOCKING')
  const warning = gate.violations.filter(v => v.level === 'WARNING')
  const parts: string[] = [gate.status === 'passed' ? '✅ 机器门禁：通过' : '❌ 机器门禁：未通过']
  if (blocking.length) {
    parts.push(`阻断违规 ${blocking.length} 项：` + blocking.map(v => `[${v.rule}] ${v.detail}`).join('；'))
  }
  if (warning.length) {
    parts.push(`警告 ${warning.length} 项：` + warning.map(v => `[${v.rule}] ${v.detail}`).join('；'))
  }
  return parts.join('\n')
}

function gateLetter(stageId: StageId, letters?: HumanGateDeps['gateLetterByStage']): string {
  if (letters?.[stageId]) return letters[stageId]
  const idx = STAGE_ORDER.indexOf(stageId)
  return idx >= 0 ? (DEFAULT_GATE_LETTERS[idx] ?? '') : ''
}

function chosenDecision(selected: readonly string[]): HumanDecision {
  const top = selected[0] ?? ''
  if (top === REJECT) return 'rejected'
  if (top === APPROVE) return 'approved'
  if (top === CHANGES_NEEDED) return 'changes-needed'
  return 'changes-needed'
}

function noteFrom(answer: AskAnswerItem | undefined): string {
  return answer?.custom ?? ''
}

/** 人工门 UI 审核（阻塞等真人裁决）。 */
export class UiUserQuestionsHumanGate implements HumanGatePort {
  private readonly deps: HumanGateDeps

  constructor(deps: HumanGateDeps) {
    this.deps = deps
  }

  async gate(stageId: StageId, artifact: StageArtifact, gate: JudgeResult, review?: { readonly verdict: string; readonly findings: readonly string[] } | undefined): Promise<HumanDecision> {
    const letter = gateLetter(stageId, this.deps.gateLetterByStage)
    const artifactStr = safeContentStr(artifact.content)
    const reviewLine = review === undefined
      ? '交叉检查：未启用'
      : `交叉检查：${review.verdict}${review.findings.length ? ' — ' + review.findings.join('；') : ''}`

    const detail = [
      `阶段 ${stageId}${letter ? `（人工门 ${letter}）` : ''} 已完成，产物：${artifact.path}（version ${artifact.version}）。`,
      formatGate(gate),
      reviewLine,
      `产物摘要：\n${artifactStr}`,
    ].join('\n')

    const q: AskItem = {
      id: `gate-${stageId}`,
      question: `阶段 ${stageId} 已完成，请审核后裁决。`,
      header: `人工门 ${letter} · ${stageId}`,
      detail,
      options: [
        { label: APPROVE, description: '通过，继续下一阶段' },
        { label: CHANGES_NEEDED, description: '打回重做（违规/审核建议回喂）' },
        { label: REJECT, description: '终止本阶段，标记 rejected' },
      ],
    }

    let answer: AskAnswer
    try {
      answer = await this.deps.userQuestions.ask({ questions: [q], signal: this.deps.signal })
    } catch (error) {
      const code = error instanceof Error && 'code' in error ? (error as { code?: string }).code : undefined
      // 取消（ABORTED）不打回——视为需修改重新进入门禁；其它错误抛出
      if (code === 'ASK_ABORTED') {
        const note = '人工门等待被取消（ASK_ABORTED）'
        this.deps.onDecision?.({ by: this.deps.by ?? 'system', action: 'changes-needed', note, stageId, at: Date.now() })
        return 'changes-needed'
      }
      throw error
    }

    const ansItem = answer.answers[0]
    const decision = chosenDecision(ansItem?.selected ?? [])
    const note = noteFrom(ansItem)
    this.deps.onDecision?.({ by: this.deps.by ?? 'system', action: decision, note, stageId, at: Date.now() })
    return decision
  }

  async gateFailed(stageId: StageId, gate: JudgeResult): Promise<void> {
    const letter = gateLetter(stageId, this.deps.gateLetterByStage)
    const blocking = gate.violations.filter(v => v.level === 'BLOCKING')
    const detail = [
      `阶段 ${stageId}${letter ? `（人工门 ${letter}）` : ''} 门禁重试耗尽，已升级人工。`,
      `阻断违规 ${blocking.length} 项：` + blocking.map(v => `[${v.rule}] ${v.detail}`).join('；'),
    ].join('\n')

    const q: AskItem = {
      id: `gate-failed-${stageId}`,
      question: '门禁已升级人工，请确认是否仍要终止本阶段。',
      header: `门禁升级 · ${stageId}`,
      detail,
      options: [
        { label: '确认终止', description: '按门禁结果终止（默认）' },
        { label: '记备注', description: '记录备注后仍终止' },
      ],
    }

    try {
      const answer = await this.deps.userQuestions.ask({ questions: [q], signal: this.deps.signal })
      const note = noteFrom(answer.answers[0])
      this.deps.onDecision?.({ by: this.deps.by ?? 'system', action: 'rejected', note: `gate-failed 确认：${note}`.replace(/^gate-failed 确认：$/, 'gate-failed 已确认'), stageId, at: Date.now() })
    } catch (error) {
      // 升级提示不应因无 provider / 取消而崩溃（pipeline 即将以 gate-failed 终止）
      if (error instanceof Error && 'code' in error && (error as { code?: string }).code === 'ASK_ABORTED') return
    }
  }
}
