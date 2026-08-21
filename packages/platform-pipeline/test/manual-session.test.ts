import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_MANUAL_WINDOW_MS,
  isExpired,
  openManualSession,
  validateAttestation,
  type ManualAttestation,
  type ManualSession,
} from '../src/execute/manual-session.ts'

const T0 = 1_000_000

function session(overrides: Partial<Parameters<typeof openManualSession>[0]> = {}): ManualSession {
  return openManualSession({
    id: 'm-1',
    caseIds: ['TC-1', 'TC-2'],
    attestedBy: 'tester-a',
    now: T0,
    ...overrides,
  })
}

function attest(overrides: Partial<ManualAttestation> = {}): ManualAttestation {
  return {
    caseId: 'TC-1',
    status: 'pass',
    attestedBy: 'tester-a',
    sessionId: 'm-1',
    at: T0 + 1000,
    ...overrides,
  }
}

test('openManualSession sets 4h default window and open status', () => {
  const s = session()
  assert.equal(s.status, 'open')
  assert.equal(s.windowMs, DEFAULT_MANUAL_WINDOW_MS)
  assert.equal(s.expiresAt, T0 + DEFAULT_MANUAL_WINDOW_MS)
  assert.deepEqual(s.caseIds, ['TC-1', 'TC-2'])
})

test('valid attestation passes (R4-11a)', () => {
  assert.deepEqual(validateAttestation(session(), attest()), { ok: true })
})

test('attestation outside time window rejected', () => {
  const s = session()
  const r = validateAttestation(s, attest({ at: s.expiresAt + 1 }))
  assert.equal(r.ok, false)
  if (!r.ok) assert.match(r.reason, /outside session window/)
})

test('attestation for unknown case rejected', () => {
  const r = validateAttestation(session(), attest({ caseId: 'TC-NOPE' }))
  assert.equal(r.ok, false)
  if (!r.ok) assert.match(r.reason, /not in session/)
})

test('attestation with wrong owner rejected', () => {
  const r = validateAttestation(session(), attest({ attestedBy: 'intruder' }))
  assert.equal(r.ok, false)
  if (!r.ok) assert.match(r.reason, /does not match session owner/)
})

test('manual failure without note rejected (R4-11b)', () => {
  const bad = validateAttestation(session(), attest({ status: 'fail' }))
  assert.equal(bad.ok, false)
  if (!bad.ok) assert.match(bad.reason, /failed without a note/)
  const ok = validateAttestation(session(), attest({ status: 'fail', note: '复现：断言超时' }))
  assert.equal(ok.ok, true)
})

test('isExpired after window; expired session rejects attestation', () => {
  const s = session()
  assert.equal(isExpired(s, s.expiresAt), false)
  assert.equal(isExpired(s, s.expiresAt + 1), true)
  const late = validateAttestation(s, attest({ at: s.expiresAt + 5000 }))
  assert.equal(late.ok, false)
})
