import { test } from 'node:test'
import assert from 'node:assert/strict'
import { stageRules } from '../src/gates/stage-rules.ts'
import type { StageArtifact, StageId } from '../src/types.ts'
import { stageContent, executionSessionFor, type Content } from './fixtures.ts'
import { STAGE_ORDER } from '../src/types.ts'

const rules = stageRules({ maxManualClaimedRatio: 0.3 })

function artifact(stageId: StageId, content: Content, inputs: Record<string, string> = {}): StageArtifact {
  return {
    pipelineId: 'pipe-1', stageId, version: 1, inputs,
    content, digest: 'dummy', path: `artifacts/${stageId}.json`,
  }
}

/** 阶段之前各阶段的内容（供 stageContent 生成当前阶段产物）。 */
function contentsUpTo(stageId: StageId): Record<string, Content> {
  const out: Record<string, Content> = {}
  for (const id of STAGE_ORDER) {
    if (STAGE_ORDER.indexOf(id) >= STAGE_ORDER.indexOf(stageId)) break
    out[id] = stageContent(id, out)
  }
  return out
}

/** 阶段之前各阶段的产物（供规则 judge 的上游）。 */
function upstreamsUpTo(stageId: StageId): Record<string, StageArtifact> {
  const contents = contentsUpTo(stageId)
  return Object.fromEntries(Object.entries(contents).map(([id, content]) => [id, artifact(id as StageId, content)]))
}

/** 当前阶段产物内容（基于内容映射生成，非产物映射）。 */
function contentFor(stageId: StageId, upstreams: Record<string, StageArtifact>): Content {
  const contents: Record<string, Content> = {}
  for (const [id, art] of Object.entries(upstreams)) contents[id] = art.content as Content
  return stageContent(stageId, contents)
}

function judgeFor(stageId: StageId, content: Content, upstreams: Record<string, StageArtifact> = upstreamsUpTo(stageId)): boolean {
  const applicable = rules.filter(r => r.stages === 'all' || (Array.isArray(r.stages) && (r.stages as readonly StageId[]).includes(stageId)))
  const execution = stageId === 'execute'
    ? executionSessionFor(upstreams.design?.content as unknown as { testCases: readonly { id: string }[] })
    : undefined
  return applicable.every(r => r.judge({ stageId, artifact: artifact(stageId, content), upstreams, ...(execution === undefined ? {} : { execution }) }).length === 0)
}

test('valid fixtures pass all applicable R rules for every stage', () => {
  for (const stageId of STAGE_ORDER) {
    const upstreams = upstreamsUpTo(stageId)
    const content = contentFor(stageId, upstreams)
    assert.equal(judgeFor(stageId, content, upstreams), true, `stage ${stageId} should pass R rules`)
  }
})

test('R1-03: missing required field without clarification is BLOCKING', () => {
  const upstreams = upstreamsUpTo('receive')
  const content = stageContent('receive', {})
  const bad = { ...content, requirements: [{ ...(content.requirements as unknown[])[0] as object, background: undefined }] }
  const rule = rules.find(r => r.id === 'R1-03')!
  const violations = rule.judge({ stageId: 'receive', artifact: artifact('receive', bad), upstreams })
  assert.ok(violations.some(v => v.rule === 'R1-03' && v.detail.includes('no clarification')))
})

test('R1-03: clarification for a present field is BLOCKING (多澄清)', () => {
  const content = stageContent('receive', {})
  const bad = { ...content, clarifications: [{ requirementId: 'REQ-1', field: 'goals', question: '?' }] }
  const rule = rules.find(r => r.id === 'R1-03')!
  const violations = rule.judge({ stageId: 'receive', artifact: artifact('receive', bad), upstreams: {} })
  assert.ok(violations.some(v => v.rule === 'R1-03' && v.detail.includes('does not correspond')))
})

test('R2-03: versionImpact evidence must be a reference (no whitespace)', () => {
  const content = stageContent('analyze', {})
  const bad = { ...content, versionImpact: [{ version: 'v', impact: 'i', evidence: '没有 依据' }] }
  const rule = rules.find(r => r.id === 'R2-03')!
  assert.ok(rule.judge({ stageId: 'analyze', artifact: artifact('analyze', bad), upstreams: {} }).length > 0)
})

test('R3-01: uncovered requirement is BLOCKING (防漏测核心)', () => {
  const upstreams = upstreamsUpTo('design')
  const content = stageContent('design', upstreams)
  const bad = { ...content, coverageMatrix: { 'REQ-1': ['TC-001'] } } // REQ-2 未覆盖
  const rule = rules.find(r => r.id === 'R3-01')!
  const violations = rule.judge({ stageId: 'design', artifact: artifact('design', bad), upstreams })
  assert.ok(violations.some(v => v.rule === 'R3-01' && v.detail.includes('REQ-2')))
})

test('R3-01: matrix referencing unknown case is BLOCKING', () => {
  const upstreams = upstreamsUpTo('design')
  const content = stageContent('design', upstreams)
  const bad = { ...content, coverageMatrix: { 'REQ-1': ['TC-999'], 'REQ-2': ['TC-002'] } }
  const rule = rules.find(r => r.id === 'R3-01')!
  assert.ok(rule.judge({ stageId: 'design', artifact: artifact('design', bad), upstreams }).some(v => v.detail.includes('TC-999')))
})

test('R3-02: duplicate case id is BLOCKING', () => {
  const upstreams = upstreamsUpTo('design')
  const content = stageContent('design', upstreams)
  const testCases = content.testCases as Record<string, unknown>[]
  const bad = { ...content, testCases: [testCases[0]!, { ...testCases[1]!, id: testCases[0]!.id }] }
  const rule = rules.find(r => r.id === 'R3-02')!
  assert.ok(rule.judge({ stageId: 'design', artifact: artifact('design', bad), upstreams }).length > 0)
})

test('R3-04: gap for a covered requirement is BLOCKING', () => {
  const upstreams = upstreamsUpTo('design')
  const content = stageContent('design', upstreams)
  const bad = { ...content, gaps: [{ requirementId: 'REQ-1', reason: 'x' }] }
  const rule = rules.find(r => r.id === 'R3-04')!
  assert.ok(rule.judge({ stageId: 'design', artifact: artifact('design', bad), upstreams }).length > 0)
})

test('R4-01: missing result (漏跑) is BLOCKING', () => {
  const upstreams = upstreamsUpTo('execute')
  const content = contentFor('execute', upstreams)
  const results = content.results as Record<string, unknown>[]
  const bad = { ...content, results: results.slice(1) } // 缺第一个用例
  const rule = rules.find(r => r.id === 'R4-01')!
  assert.ok(rule.judge({ stageId: 'execute', artifact: artifact('execute', bad), upstreams }).some(v => v.detail.includes('TC-001')))
})

test('R4-03: result envIssueId referencing unknown envIssue is BLOCKING', () => {
  const upstreams = upstreamsUpTo('execute')
  const content = contentFor('execute', upstreams)
  const results = content.results as Record<string, unknown>[]
  const bad = { ...content, results: [{ ...results[0]!, envIssueId: 'env-999' }] }
  const rule = rules.find(r => r.id === 'R4-03')!
  assert.ok(rule.judge({ stageId: 'execute', artifact: artifact('execute', bad), upstreams }).length > 0)
})

test('R5-01: LLM-fabricated passRate is BLOCKING', () => {
  const content = stageContent('report', {})
  const bad = { ...content, stats: { ...(content.stats as object), total: 2, passed: 2, failed: 0, passRate: 0.5 } }
  const rule = rules.find(r => r.id === 'R5-01')!
  assert.ok(rule.judge({ stageId: 'report', artifact: artifact('report', bad), upstreams: {} }).some(v => v.detail.includes('passRate')))
})

test('R5-06: approve with high manual ratio is BLOCKING', () => {
  const upstreams = upstreamsUpTo('report')
  const execute = contentFor('execute', upstreams) as Content
  const results = execute.results as Record<string, unknown>[]
  const manual = results.map(r => ({ ...r, manualClaimed: true }))
  const upstreamsWithManual = {
    ...upstreams,
    execute: artifact('execute', { ...execute, results: manual }, {}),
  }
  const content = stageContent('report', {})
  const rule = rules.find(r => r.id === 'R5-06')!
  const violations = rule.judge({ stageId: 'report', artifact: artifact('report', content), upstreams: upstreamsWithManual })
  assert.ok(violations.some(v => v.rule === 'R5-06'))
})

test('R6-02: unarchived designed case is BLOCKING', () => {
  const upstreams = upstreamsUpTo('archive')
  const content = contentFor('archive', upstreams)
  const bad = { ...content, caseArchive: [] }
  const rule = rules.find(r => r.id === 'R6-02')!
  assert.ok(rule.judge({ stageId: 'archive', artifact: artifact('archive', bad), upstreams }).length > 0)
})


test('R4-08: missing executor record is BLOCKING (漏跑)', () => {
  const upstreams = upstreamsUpTo('execute')
  const content = contentFor('execute', upstreams)
  // 结果引用了不存在的记录 seq 99（伪造结果）
  const results = content.results as Record<string, unknown>[]
  const bad = { ...content, results: [{ ...results[0]!, recordRef: '99' }] }
  const rule = rules.find(r => r.id === 'R4-08')!
  const execution = executionSessionFor(upstreams.design!.content as unknown as { testCases: readonly { id: string }[] })
  const violations = rule.judge({ stageId: 'execute', artifact: artifact('execute', bad), upstreams, execution })
  assert.ok(violations.some(v => v.rule === 'R4-08' && v.detail.includes('no executor record')))
})

test('R4-09: tampered record chain is BLOCKING', () => {
  const upstreams = upstreamsUpTo('execute')
  const content = contentFor('execute', upstreams)
  const execution = executionSessionFor(upstreams.design!.content as unknown as { testCases: readonly { id: string }[] })
  const tampered = { ...execution.records[0]!, durationMs: 9999 }
  const rule = rules.find(r => r.id === 'R4-09')!
  const violations = rule.judge({ stageId: 'execute', artifact: artifact('execute', content), upstreams, execution: { ...execution, records: [tampered, ...execution.records.slice(1)] } })
  assert.ok(violations.some(v => v.rule === 'R4-09'))
})

test('R4-10: agent-written evidence is BLOCKING', () => {
  const upstreams = upstreamsUpTo('execute')
  const content = contentFor('execute', upstreams)
  const execution = executionSessionFor(upstreams.design!.content as unknown as { testCases: readonly { id: string }[] })
  const bad = { ...execution, evidence: [{ ...execution.evidence[0]!, capturedBy: 'agent-zhang' }] }
  const rule = rules.find(r => r.id === 'R4-10')!
  const violations = rule.judge({ stageId: 'execute', artifact: artifact('execute', content), upstreams, execution: bad })
  assert.ok(violations.some(v => v.rule === 'R4-10' && v.detail.includes('not an executor identity')))
})

test('R4-08: missing execution data is BLOCKING', () => {
  const upstreams = upstreamsUpTo('execute')
  const content = contentFor('execute', upstreams)
  const rule = rules.find(r => r.id === 'R4-08')!
  const violations = rule.judge({ stageId: 'execute', artifact: artifact('execute', content), upstreams })
  assert.ok(violations.some(v => v.rule === 'R4-08' && v.detail.includes('not provided')))
})
