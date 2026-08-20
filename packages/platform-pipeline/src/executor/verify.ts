/**
 * 执行-产物对账（docs/08 第 3 节防线 1，R4-08）与证据锚定（防线 3，R4-10）。
 * @module platform-pipeline/executor/verify
 */

import type { ExecutionRecord } from './records.ts'

/** R4-08 对账结果。 */
export interface ReconcileResult {
  readonly ok: boolean
  /** 计划用例但没有记录（漏跑）。 */
  readonly missingRecords: readonly string[]
  /** 结果引用了不存在的记录（伪造结果）。 */
  readonly phantomResults: readonly string[]
  /** 记录未被任何结果引用（多余执行，可疑）。 */
  readonly unclaimedRecords: readonly number[]
}

/**
 * R4-08：executorRecords ↔ results 双向覆盖对账。
 * @param records - executor 自产记录。
 * @param planCaseIds - 计划用例 id（design.json 的 testCases ∪ reusedCases）。
 * @param results - 阶段 agent 聚合的 results（每条带 recordRef）。
 * @returns 对账结果；任一问题 → ok=false。
 */
export function reconcile(
  records: readonly ExecutionRecord[],
  planCaseIds: readonly string[],
  results: readonly { readonly caseId: string; readonly recordRef: string }[],
): ReconcileResult {
  const recordByCase = new Map(records.map(r => [r.caseId, r]))
  const recordSeqs = new Set(records.map(r => r.seq))
  const referenced = new Set<string>()

  const missingRecords: string[] = []
  for (const caseId of planCaseIds) {
    if (!recordByCase.has(caseId)) missingRecords.push(caseId)
  }

  const phantomResults: string[] = []
  for (const result of results) {
    const seq = Number(result.recordRef)
    if (!Number.isInteger(seq) || !recordSeqs.has(seq)) {
      phantomResults.push(`${result.caseId}@${result.recordRef}`)
      continue
    }
    referenced.add(result.recordRef)
  }

  const unclaimedRecords = records
    .filter(r => !referenced.has(String(r.seq)))
    .map(r => r.seq)

  return {
    ok: missingRecords.length === 0 && phantomResults.length === 0 && unclaimedRecords.length === 0,
    missingRecords,
    phantomResults,
    unclaimedRecords,
  }
}

/** 证据条目（R4-10 来源锚定）。 */
export interface EvidenceEntry {
  readonly id: string
  readonly recordId: number
  readonly file: string
  readonly digest: string
  readonly capturedBy: string
  readonly capturedAt: number
}

export interface EvidenceViolation {
  readonly rule: string
  readonly detail: string
}

/**
 * R4-10：证据指纹与来源锚定。
 * - capturedBy 必须是 executor 身份（agent 写的证据不认）；
 * - capturedAt 在记录的时间窗口内（防从旧测试偷证据）；
 * - digest/file 非空。
 */
export function verifyEvidence(
  entries: readonly EvidenceEntry[],
  records: readonly ExecutionRecord[],
): readonly EvidenceViolation[] {
  const violations: EvidenceViolation[] = []
  const recordBySeq = new Map(records.map(r => [r.seq, r]))
  for (const entry of entries) {
    if (!entry.capturedBy.startsWith('executor:')) {
      violations.push({ rule: 'R4-10', detail: `evidence "${entry.id}": capturedBy "${entry.capturedBy}" is not an executor identity` })
    }
    if (entry.file === '' || entry.digest === '') {
      violations.push({ rule: 'R4-10', detail: `evidence "${entry.id}": file/digest must be non-empty` })
    }
    const record = recordBySeq.get(entry.recordId)
    if (record === undefined) {
      violations.push({ rule: 'R4-10', detail: `evidence "${entry.id}": references unknown record ${entry.recordId}` })
      continue
    }
    // 记录时间窗口：capturedAt ∈ [record.capturedAt, record.capturedAt + durationMs]
    if (entry.capturedAt < record.capturedAt || entry.capturedAt > record.capturedAt + record.durationMs) {
      violations.push({
        rule: 'R4-10',
        detail: `evidence "${entry.id}": capturedAt ${entry.capturedAt} outside record ${record.seq} window [${record.capturedAt}, ${record.capturedAt + record.durationMs}]`,
      })
    }
  }
  return violations
}
