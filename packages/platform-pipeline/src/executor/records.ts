/**
 * 执行记录与时序链（docs/08 第 3 节防线 2，R4-09）。
 * executor 唯一执行者自产记录；每条记录带 prevHash/ownHash 构成链：
 * - 删/插/改一条 → 链断或 hash 不匹配；
 * - 回填历史时间 → 时序倒退；
 * - 环境中断续跑开启新链段，段头 prevHash 链接旧链尾（ET-02）。
 * @module platform-pipeline/executor/records
 */

import { createHash } from 'node:crypto'

export type ExecutionStatus = 'pass' | 'fail' | 'pending'

export interface ExecutionRecord {
  readonly seq: number
  readonly caseId: string
  readonly capturedAt: number
  readonly durationMs: number
  readonly status: ExecutionStatus
  readonly evidenceRefs: readonly string[]
  readonly prevHash: string
  readonly ownHash: string
  /** 链段号：续跑新链段递增（ET-02）。 */
  readonly segment: number
  /** 段头：上一链段尾的 ownHash（续跑时必填）。 */
  readonly resumedFrom?: string
}

/** 记录参与哈希的载荷（不含 ownHash 自身）。 */
function payloadOf(record: Omit<ExecutionRecord, 'ownHash'>): string {
  return JSON.stringify({
    seq: record.seq,
    caseId: record.caseId,
    capturedAt: record.capturedAt,
    durationMs: record.durationMs,
    status: record.status,
    evidenceRefs: record.evidenceRefs,
    prevHash: record.prevHash,
    segment: record.segment,
    ...(record.resumedFrom === undefined ? {} : { resumedFrom: record.resumedFrom }),
  })
}

export function hashRecord(record: Omit<ExecutionRecord, 'ownHash'>): string {
  return createHash('sha256').update(payloadOf(record)).digest('hex')
}

/** 构建一条记录（ownHash 自动计算）。 */
export function makeRecord(
  input: Omit<ExecutionRecord, 'ownHash'>,
): ExecutionRecord {
  return { ...input, ownHash: hashRecord(input) }
}

export interface ChainViolation {
  readonly rule: string
  readonly detail: string
}

/**
 * 校验时序链（R4-09）：链连续、时间单调、时长与时间戳跨度一致、段间衔接正确。
 * @param records - 按 seq 升序排列的全部记录（可能跨段）。
 * @returns 违规列表（空 = 通过）。
 */
export function verifyChain(records: readonly ExecutionRecord[]): readonly ChainViolation[] {
  const violations: ChainViolation[] = []
  if (records.length === 0) return violations

  const bySeq = new Map(records.map(r => [r.seq, r]))
  let prevOwnHash: string | undefined
  let prevCapturedAt: number | undefined
  let prevDurationMs: number | undefined
  let prevSegment: number | undefined
  let prevResumedFrom: string | undefined

  for (const record of records) {
    // hash 自洽
    const recomputed = hashRecord(record)
    if (recomputed !== record.ownHash) {
      violations.push({ rule: 'R4-09', detail: `seq ${record.seq}: ownHash mismatch (tampered)` })
    }
    // prevHash 连续（段内链接前一记录，段头链接 resumedFrom 或空）
    if (prevOwnHash !== undefined && record.segment === prevSegment) {
      if (record.prevHash !== prevOwnHash) {
        violations.push({ rule: 'R4-09', detail: `seq ${record.seq}: prevHash does not link segment ${record.segment} tail` })
      }
    } else if (record.segment !== prevSegment && prevSegment !== undefined) {
      // 段边界（非首条）：新段段头 prevHash 必须链接旧段尾
      if (record.resumedFrom === undefined || record.resumedFrom !== prevOwnHash) {
        violations.push({ rule: 'R4-09', detail: `seq ${record.seq}: segment ${record.segment} head must link previous tail via resumedFrom` })
      }
    }
    // 时间单调
    if (prevCapturedAt !== undefined && record.capturedAt < prevCapturedAt) {
      violations.push({ rule: 'R4-09', detail: `seq ${record.seq}: capturedAt regresses (${record.capturedAt} < ${prevCapturedAt})` })
    }
    // 时长与时间戳跨度一致：上一记录时长不得超过其到本记录的时间跨度
    if (prevCapturedAt !== undefined && prevDurationMs !== undefined) {
      if (prevDurationMs > record.capturedAt - prevCapturedAt) {
        violations.push({
          rule: 'R4-09',
          detail: `seq ${record.seq - 1}: durationMs ${prevDurationMs} exceeds elapsed ${record.capturedAt - prevCapturedAt}`,
        })
      }
    }
    // seq 连续
    if (bySeq.has(record.seq - 1) && prevSegment === record.segment) {
      // 段内 seq 必须递增 1；段边界允许 seq 重新编排（续跑新段从 1 起）——此处校验同段内连续性
      const expectedPrev = bySeq.get(record.seq - 1)
      if (expectedPrev !== undefined && expectedPrev.ownHash !== record.prevHash && record.segment === expectedPrev.segment) {
        violations.push({ rule: 'R4-09', detail: `seq ${record.seq}: non-contiguous sequence within segment` })
      }
    }
    prevOwnHash = record.ownHash
    prevCapturedAt = record.capturedAt
    prevDurationMs = record.durationMs
    prevSegment = record.segment
    prevResumedFrom = record.resumedFrom
  }
  void prevResumedFrom
  return violations
}
