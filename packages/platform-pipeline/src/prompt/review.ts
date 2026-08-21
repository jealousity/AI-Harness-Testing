/**
 * 交叉检查审核 prompt（docs/03 第 7 节 / docs/04 第 4 节）。
 * 盲审：独立 spawn、零父上下文、只看产物与上游输入、必查清单（D-14）；
 * 输出必须过自身 schema（verdict + findings + checked）。
 * @module platform-pipeline/prompt/review
 */

import type { StageId } from '../types.ts'

/** 各阶段必查清单（D-14：与审核报告的 checked 数组对照，防漏审关键面）。 */
export const REVIEW_CHECKLISTS: Readonly<Record<StageId, readonly string[]>> = {
  receive: [],
  analyze: [
    'boundaries 自洽（in/out 与需求目标无冲突）',
    'versionImpact 每条带依据（版本档案/需求变更点）',
    'reuseSuggestions 可查回（caseId 存在于用例库）',
    'openQuestions 可答（每条带 needs）',
  ],
  design: [
    '覆盖矩阵完备（每个需求点 ≥1 条用例）',
    'gaps 自洽（列出的需求点确实是零用例）',
    '用例可执行性（steps/expected 非空话）',
    '复用用例适配正确性（adaptation 与内容一致）',
  ],
  execute: [
    '结果与证据一致性（results ↔ executor 记录 ↔ manifest）',
    '覆盖完整性（无缺跑、无多余记录）',
    '异常模式（全 pass 但时长 0 / evidence 同一秒 / manual 占比异常）',
  ],
  report: [
    'stats 与 execute.json 重算一致',
    '缺陷证据可追溯（caseId + manifest 引用）',
    '发布建议与风险/缺陷自洽（manual 占比约束 R5-06）',
  ],
  archive: [],
}

export interface ReviewPromptInput {
  readonly stageId: StageId
  readonly pipelineId: string
  readonly artifactPath: string
  readonly upstreamPaths: Readonly<Record<string, string>>
  /** 机器门禁违规清单（若有）。 */
  readonly violations?: readonly { rule: string; level: string; detail: string }[]
  readonly schemaFilePath?: string
}

const REVIEW_SCHEMA_INLINE = `{
  "stageId": "string",
  "verdict": "enum: pass|conditional|fail",
  "findings": [{
    "severity": "enum: blocker|concern|nit",
    "claim": "string",
    "evidence": "string（产物路径#字段 或 manifest 条目）",
    "suggestedAction": "enum: rerun|address-in-human-gate|optional"
  }],
  "checked": ["string（本次实际复核的必查面）"],
  "confidence": "number（0..1）"
}`

/** 拼装交叉检查审核 prompt（盲审模板，docs/04 第 4 节）。 */
export function assembleReviewPrompt(input: ReviewPromptInput): string {
  const checklist = REVIEW_CHECKLISTS[input.stageId] ?? []
  const violations = input.violations ?? []
  return `# 交叉检查：${input.stageId} 阶段产物复核

## 1. 角色
你是独立审核 agent，与生产 agent 无任何关系（不知道它、看不到它的会话/提示词）。
你的职责是找问题，不是补完产物。

## 2. 输入（盲审）
- 契约（输出 schema）：${input.schemaFilePath ?? '（以产物结构为准）'}
- 上游输入产物路径：${Object.entries(input.upstreamPaths).map(([k, v]) => `${k}: ${v}`).join('；') || '（无）'}
- 待审产物路径：${input.artifactPath}
- 机器门禁违规清单：${violations.length === 0 ? '（无）' : violations.map(v => `[${v.level}] ${v.rule}: ${v.detail}`).join('；')}

## 3. 复核范围（必查清单，逐项复核并在 checked 中如实记录）
${checklist.length === 0 ? '（本阶段未配置必查清单，按产物契约自行确定复核面）' : checklist.map((item, i) => `${i + 1}. ${item}`).join('\n')}

## 4. 输出
- 结构化审核报告，严格匹配：
${REVIEW_SCHEMA_INLINE}
- verdict 判定：存在 blocker findings → fail；仅 concern/nit → conditional；无实质问题 → pass。
- 每条 finding 必须带证据引用（产物路径#字段 或 manifest 条目），禁止无依据断言。
- checked 必须列出你实际复核的必查面（与第 3 节清单对照，未查的面不得列入）。

## 5. 禁止
- 不得调用 subagent / 委托复核；
- 不得输出空话（无 findings 的 pass 必须附完整 checked 清单）；
- 不得把"生产 agent 可能怎么想"作为依据，只基于产物与证据；
- 你不修改产物；你的报告是独立产物 ${input.pipelineId}/${input.stageId}.review.json。
`
}
