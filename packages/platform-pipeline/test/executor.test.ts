import { test } from 'node:test'
import assert from 'node:assert/strict'
import { hashRecord, makeRecord, verifyChain, type ExecutionRecord } from '../src/executor/records.ts'
import { reconcile, verifyEvidence, type EvidenceEntry } from '../src/executor/verify.ts'

let nextSeq = 0
function rec(overrides: Partial<ExecutionRecord> = {}): ExecutionRecord {
  const base: Omit<ExecutionRecord, 'ownHash'> = {
    seq: ++nextSeq,
    caseId: `TC-${nextSeq}`,
    capturedAt: 1000 + nextSeq * 100,
    durationMs: 50,
    status: 'pass',
    evidenceRefs: [],
    prevHash: '',
    segment: 1,
    ...overrides,
  }
  return makeRecord(base)
}

function linkedChain(count: number, startAt = 1000): ExecutionRecord[] {
  nextSeq = 0
  const chain: ExecutionRecord[] = []
  let prevHash = ''
  for (let i = 0; i < count; i++) {
    const r = makeRecord({
      seq: i + 1,
      caseId: `TC-${String(i + 1).padStart(3, '0')}`,
      capturedAt: startAt + i * 100,
      durationMs: 50,
      status: 'pass',
      evidenceRefs: [],
      prevHash,
      segment: 1,
    })
    chain.push(r)
    prevHash = r.ownHash
  }
  return chain
}

test('hashRecord is deterministic and sensitive to content', () => {
  const a = makeRecord({ seq: 1, caseId: 'TC-1', capturedAt: 1, durationMs: 1, status: 'pass', evidenceRefs: [], prevHash: '', segment: 1 })
  const b = makeRecord({ seq: 1, caseId: 'TC-1', capturedAt: 1, durationMs: 1, status: 'pass', evidenceRefs: [], prevHash: '', segment: 1 })
  assert.equal(a.ownHash, b.ownHash)
  assert.notEqual(a.ownHash, hashRecord({ ...a, status: 'fail' }))
})

test('verifyChain accepts a linked chain', () => {
  const chain = linkedChain(3)
  assert.deepEqual(verifyChain(chain), [])
})

test('verifyChain catches tampering (ownHash mismatch)', () => {
  const chain = linkedChain(3)
  const tampered = { ...chain[1]!, durationMs: 999 } as ExecutionRecord
  assert.ok(verifyChain([chain[0]!, tampered, chain[2]!]).some(v => v.rule === 'R4-09' && v.detail.includes('ownHash')))
})

test('verifyChain catches a deleted record (link break)', () => {
  const chain = linkedChain(3)
  const broken = [chain[0]!, chain[2]!]
  assert.ok(verifyChain(broken).some(v => v.detail.includes('prevHash does not link')))
})

test('verifyChain catches time regression', () => {
  const chain = linkedChain(3)
  const regressed = { ...chain[2]!, capturedAt: chain[0]!.capturedAt - 1 } as ExecutionRecord
  // 需同时修正 hash 才能走到时序检查——直接构造
  const fixed = makeRecord({ ...regressed })
  const arr = [chain[0]!, chain[1]!, fixed]
  assert.ok(verifyChain(arr).some(v => v.detail.includes('capturedAt regresses')))
})

test('verifyChain catches duration exceeding elapsed span', () => {
  const chain = linkedChain(2)
  const slow = makeRecord({ ...chain[0]!, durationMs: 200 })
  const arr = [slow, chain[1]!]
  assert.ok(verifyChain(arr).some(v => v.detail.includes('exceeds elapsed')))
})

test('verifyChain accepts resumed segments linking previous tail (ET-02)', () => {
  nextSeq = 0
  const seg1 = linkedChain(2)
  const seg2 = [makeRecord({
    seq: 1, caseId: 'TC-999', capturedAt: 1300, durationMs: 50, status: 'pending',
    evidenceRefs: [], prevHash: seg1[seg1.length - 1]!.ownHash, segment: 2, resumedFrom: seg1[seg1.length - 1]!.ownHash,
  })]
  assert.deepEqual(verifyChain([...seg1, ...seg2]), [])
})

test('verifyChain rejects a segment head not linking previous tail', () => {
  const seg1 = linkedChain(2)
  const badHead = makeRecord({
    seq: 1, caseId: 'TC-999', capturedAt: 1300, durationMs: 50, status: 'pending',
    evidenceRefs: [], prevHash: 'wrong', segment: 2, resumedFrom: 'wrong',
  })
  assert.ok(verifyChain([...seg1, badHead]).some(v => v.detail.includes('must link previous tail')))
})

// ── R4-08 对账 ───────────────────────────────────────────────────────────────

test('reconcile passes when records cover plan and results reference them', () => {
  const records = linkedChain(2)
  const result = reconcile(
    records,
    ['TC-001', 'TC-002'],
    [
      { caseId: 'TC-001', recordRef: '1' },
      { caseId: 'TC-002', recordRef: '2' },
    ],
  )
  assert.equal(result.ok, true)
})

test('reconcile flags missing records (漏跑)', () => {
  const records = linkedChain(1)
  const result = reconcile(records, ['TC-001', 'TC-002'], [{ caseId: 'TC-001', recordRef: '1' }])
  assert.equal(result.ok, false)
  assert.deepEqual(result.missingRecords, ['TC-002'])
})

test('reconcile flags phantom results (伪造结果)', () => {
  const records = linkedChain(1)
  const result = reconcile(records, ['TC-001'], [{ caseId: 'TC-001', recordRef: '99' }])
  assert.equal(result.ok, false)
  assert.deepEqual(result.phantomResults, ['TC-001@99'])
})

test('reconcile flags unclaimed records (多余执行)', () => {
  const records = linkedChain(2)
  const result = reconcile(records, ['TC-001'], [{ caseId: 'TC-001', recordRef: '1' }])
  assert.equal(result.ok, false)
  assert.deepEqual(result.unclaimedRecords, [2])
})

// ── R4-10 证据锚定 ───────────────────────────────────────────────────────────

test('verifyEvidence accepts executor-captured evidence in window', () => {
  const records = linkedChain(1)
  const entry: EvidenceEntry = {
    id: 'ev-1', recordId: 1, file: 'evidence/1.log', digest: 'd',
    capturedBy: 'executor:inv-1', capturedAt: records[0]!.capturedAt + 10,
  }
  assert.deepEqual(verifyEvidence([entry], records), [])
})

test('verifyEvidence rejects non-executor capturedBy (agent-written evidence)', () => {
  const records = linkedChain(1)
  const entry: EvidenceEntry = {
    id: 'ev-1', recordId: 1, file: 'evidence/1.log', digest: 'd',
    capturedBy: 'agent-zhang', capturedAt: records[0]!.capturedAt + 10,
  }
  assert.ok(verifyEvidence([entry], records).some(v => v.rule === 'R4-10' && v.detail.includes('not an executor identity')))
})

test('verifyEvidence rejects evidence outside record time window (stolen evidence)', () => {
  const records = linkedChain(1)
  const entry: EvidenceEntry = {
    id: 'ev-1', recordId: 1, file: 'evidence/1.log', digest: 'd',
    capturedBy: 'executor:inv-1', capturedAt: records[0]!.capturedAt + records[0]!.durationMs + 1000,
  }
  assert.ok(verifyEvidence([entry], records).some(v => v.detail.includes('outside record')))
})
