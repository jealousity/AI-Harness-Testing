/**
 * manual 执行会话模型（docs/08 第 4 节）。
 * 会话级见证：一次会话 2 个确认点覆盖整批（成本 O(批) 非 O(条)）。
 * - 时间窗默认 4h（ET-04），超窗自动关闭需重开；
 * - 回填必须带 sessionId + attestedBy + 时间戳在窗口内（R4-11a）；
 * - manual 失败必须带说明（R4-11b）。
 * @module platform-pipeline/execute/manual-session
 */

export const DEFAULT_MANUAL_WINDOW_MS = 4 * 60 * 60 * 1000 // 4h（ET-04）

export interface ManualSession {
  readonly id: string
  readonly caseIds: readonly string[]
  readonly attestedBy: string
  readonly windowMs: number
  readonly startedAt: number
  readonly expiresAt: number
  readonly status: 'open' | 'closed'
}

export interface ManualAttestation {
  readonly caseId: string
  readonly status: 'pass' | 'fail' | 'skipped'
  /** 失败必填（R4-11b）。 */
  readonly note?: string
  readonly attestedBy: string
  readonly sessionId: string
  readonly at: number
}

export type AttestResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string }

export interface ManualSessionOptions {
  readonly id: string
  readonly caseIds: readonly string[]
  readonly attestedBy: string
  readonly windowMs?: number
  readonly now?: number
}

/** 开启会话（时间窗 = now + windowMs）。 */
export function openManualSession(options: ManualSessionOptions): ManualSession {
  const now = options.now ?? Date.now()
  const windowMs = options.windowMs ?? DEFAULT_MANUAL_WINDOW_MS
  if (windowMs <= 0) throw new Error('manual session windowMs must be positive')
  if (options.caseIds.length === 0) throw new Error('manual session needs at least one case')
  return {
    id: options.id,
    caseIds: [...options.caseIds],
    attestedBy: options.attestedBy,
    windowMs,
    startedAt: now,
    expiresAt: now + windowMs,
    status: 'open',
  }
}

/** 校验一条回填（R4-11a/b）；通过后调用方记录（upsert by caseId 允许分批修正）。 */
export function validateAttestation(session: ManualSession, attestation: ManualAttestation): AttestResult {
  if (session.status !== 'open') return { ok: false, reason: `session "${session.id}" is ${session.status}` }
  if (attestation.sessionId !== session.id) return { ok: false, reason: `attestation sessionId "${attestation.sessionId}" does not match "${session.id}"` }
  if (attestation.attestedBy !== session.attestedBy) {
    return { ok: false, reason: `attestation attestedBy "${attestation.attestedBy}" does not match session owner "${session.attestedBy}"` }
  }
  if (attestation.at < session.startedAt || attestation.at > session.expiresAt) {
    return { ok: false, reason: `attestation at ${attestation.at} outside session window [${session.startedAt}, ${session.expiresAt}]` }
  }
  if (!session.caseIds.includes(attestation.caseId)) {
    return { ok: false, reason: `case "${attestation.caseId}" is not in session ${session.id}` }
  }
  if (attestation.status === 'fail' && (attestation.note === undefined || attestation.note.trim() === '')) {
    return { ok: false, reason: `case "${attestation.caseId}" failed without a note (R4-11b)` }
  }
  return { ok: true }
}

/** 会话是否已过期（超窗自动关闭，ET-04）。 */
export function isExpired(session: ManualSession, now: number = Date.now()): boolean {
  return now > session.expiresAt
}
