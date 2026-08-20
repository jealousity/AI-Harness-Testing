import { test } from 'node:test'
import assert from 'node:assert/strict'
import { validateSubset, deepEqual, type SubsetSchema } from '../src/gates/schema.ts'
import {
  MachineGateEngine,
  computeArtifactDigest,
  platformGenericRules,
} from '../src/gates/machine.ts'
import type { StageArtifact } from '../src/types.ts'

// ── schema 子集校验器 ────────────────────────────────────────────────────────

test('validateSubset: type/required/additionalProperties/enum/const/oneOf', () => {
  const schema: SubsetSchema = {
    type: 'object',
    additionalProperties: false,
    required: ['id', 'kind'],
    properties: {
      id: { type: 'string' },
      kind: { type: 'string', enum: ['a', 'b'] },
      count: { type: 'integer' },
      items: { type: 'array', items: { type: 'string' } },
    },
  }
  assert.deepEqual(validateSubset({ id: 'x', kind: 'a', items: ['1'] }, schema), [])
  assert.ok(validateSubset({ kind: 'a' }, schema).some(e => e.includes('missing required "id"')))
  assert.ok(validateSubset({ id: 'x', kind: 'c' }, schema).some(e => e.includes('enum')))
  assert.ok(validateSubset({ id: 'x', kind: 'a', extra: 1 }, schema).some(e => e.includes('unexpected property')))
  assert.ok(validateSubset({ id: 1, kind: 'a' }, schema).some(e => e.includes('expected string')))
})

test('validateSubset: oneOf and const', () => {
  const schema: SubsetSchema = { oneOf: [{ type: 'string' }, { type: 'number' }] }
  assert.deepEqual(validateSubset('s', schema), [])
  assert.ok(validateSubset(true, schema).some(e => e.includes('exactly one')))
  assert.deepEqual(validateSubset(7, { const: 7 }), [])
  assert.ok(validateSubset(8, { const: 7 }).length > 0)
})

test('deepEqual compares JSON values', () => {
  assert.equal(deepEqual({ a: [1, 2] }, { a: [1, 2] }), true)
  assert.equal(deepEqual({ a: [1, 2] }, { a: [1, 3] }), false)
  assert.equal(deepEqual(null, null), true)
})

// ── 机器门禁引擎 G-01~G-08 ──────────────────────────────────────────────────

const receiveSchema: SubsetSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['requirements', 'clarifications'],
  properties: {
    requirements: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        required: ['id', 'title'],
        properties: {
          id: { type: 'string' },
          title: { type: 'string' },
        },
      },
    },
    clarifications: { type: 'array', items: { type: 'object' } },
    budgetExceeded: { type: 'boolean' },
  },
}

/** 通过 G-01/G-02 的合法 receive 内容（clarifications 允许空）。 */
const validContent = { requirements: [{ id: 'REQ-1', title: '需求1' }], clarifications: [] }

function artifact(content: unknown, overrides: Partial<StageArtifact> = {}): StageArtifact {
  const base: StageArtifact = {
    pipelineId: 'p',
    stageId: 'receive',
    version: 1,
    inputs: {},
    content,
    digest: '',
    path: 'artifacts/p/receive.json',
  }
  const digest = computeArtifactDigest({ ...base, ...overrides })
  return { ...base, ...overrides, digest }
}

function engine(): MachineGateEngine {
  return new MachineGateEngine(platformGenericRules({ receive: receiveSchema }), 'rules-v1')
}

test('G-01: schema violation is BLOCKING', () => {
  const r = engine().judge('receive', artifact({ requirements: 'not-array' }), {}, 1)
  assert.equal(r.status, 'failed')
  assert.ok(r.violations.some(v => v.rule === 'G-01'))
})

test('G-02: empty required strings/arrays are BLOCKING', () => {
  const r = engine().judge('receive', artifact({ requirements: [{ id: '', title: 'x' }], clarifications: [] }), {}, 1)
  assert.equal(r.status, 'failed')
  assert.ok(r.violations.some(v => v.rule === 'G-02' && v.detail.includes('id')))
})

test('G-03: empty evidence arrays are BLOCKING', () => {
  const r = engine().judge('receive', artifact({ requirements: [], clarifications: [], evidenceRefs: [] }), {}, 1)
  assert.ok(r.violations.some(v => v.rule === 'G-03'))
})

test('G-04: digest mismatch is BLOCKING; self-consistent artifact passes', () => {
  const good = artifact(validContent)
  assert.deepEqual(engine().judge('receive', good, {}, 1).violations.filter(v => v.rule === 'G-04'), [])
  const tampered = { ...good, version: 2 } // digest 仍基于 version 1，声明 version 2 → 不匹配
  assert.ok(engine().judge('receive', tampered, {}, 1).violations.some(v => v.rule === 'G-04'))
})

test('G-05: budgetExceeded true is WARNING, non-boolean is BLOCKING', () => {
  const warn = engine().judge('receive', artifact({ ...validContent, budgetExceeded: true }), {}, 1)
  assert.equal(warn.status, 'passed')
  assert.ok(warn.violations.some(v => v.rule === 'G-05' && v.level === 'WARNING'))
  const bad = engine().judge('receive', artifact({ requirements: [], clarifications: [], budgetExceeded: 'yes' }), {}, 1)
  assert.equal(bad.status, 'failed')
})

test('G-06: placeholders are BLOCKING', () => {
  const r = engine().judge('receive', artifact({ requirements: [], clarifications: [{ question: '同上' }] }), {}, 1)
  assert.ok(r.violations.some(v => v.rule === 'G-06'))
})

test('G-07: unresolvable internal refs are BLOCKING', () => {
  const r = engine().judge('receive', artifact({
    requirements: [{ id: 'REQ-1', title: 'x' }],
    clarifications: [{ requirementId: 'REQ-NOPE', question: '?' }],
  }), {}, 1)
  assert.ok(r.violations.some(v => v.rule === 'G-07' && v.detail.includes('REQ-NOPE')))
})

test('G-08: stale upstream digest is BLOCKING (级联失效核心)', () => {
  const upstream = artifact(validContent)
  const downstream = artifact(validContent, { inputs: { receive: 'stale-digest' } })
  const r = engine().judge('receive', downstream, { receive: upstream }, 1)
  assert.ok(r.violations.some(v => v.rule === 'G-08' && v.detail.includes('stale-digest')))
  // 上游未提供 → BLOCKING
  const missing = engine().judge('receive', downstream, {}, 1)
  assert.ok(missing.violations.some(v => v.rule === 'G-08' && v.detail.includes('not provided')))
})

test('ruleset version is independent (D-03)', () => {
  assert.equal(engine().version(), 'rules-v1')
})

test('stage-scoped rules only run for their stages', () => {
  const scoped: ReturnType<typeof platformGenericRules> = [{
    id: 'R1-01', level: 'BLOCKING', stages: ['receive'],
    judge: () => [{ rule: 'R1-01', level: 'BLOCKING' as const, detail: 'receive only', at: 1 }],
  }]
  const e = new MachineGateEngine(scoped, 'v1')
  const onReceive = e.judge('receive', artifact(validContent), {}, 1)
  assert.equal(onReceive.status, 'failed')
  const offReceive = e.judge('analyze', artifact(validContent, { stageId: 'analyze' }), {}, 1)
  assert.equal(offReceive.status, 'passed')
})
