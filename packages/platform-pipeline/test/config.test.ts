import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_MAX_MANUAL_CLAIMED_RATIO,
  expandRuleList,
  normalizeConfig,
  parsePipelineConfig,
} from '../src/config.ts'
import { STAGE_ORDER, type PipelineConfig } from '../src/types.ts'

const FULL_FIXTURE = {
  projectId: 'acme-pay-2026',
  projectType: 'api-service',
  templateVersion: 'v1',
  displayName: 'ACME 支付平台测试流水线',
  scaleTier: 'M',
  releasePolicy: { maxManualClaimedRatio: 0.3 },
  stores: {
    knowledge: { impl: 'markdown-fs', path: 'kb/acme-pay' },
    cases: { impl: 'markdown-fs', path: 'cases/acme-pay' },
    requirements: {
      primary: { impl: 'jira', projectKey: 'PAY', mode: 'readonly-api' },
      fallback: [{ impl: 'export-files', dir: 'inputs/requirements' }, { impl: 'paste' }],
    },
  },
  stages: {
    analyze: { tools: { deny: ['kb_query'] } },
    design: { review: { enabled: false } },
    execute: { budget: { maxSteps: 200 } },
  },
}

function cfg(overrides: Record<string, unknown> = {}): PipelineConfig {
  return normalizeConfig({ ...FULL_FIXTURE, ...overrides })
}

test('normalizeConfig fills per-stage defaults for unmentioned stages', () => {
  const c = cfg()
  for (const id of STAGE_ORDER) {
    assert.ok(c.stages[id], `stage ${id} present`)
  }
  // receive 未在 fixture 出现 → 全默认
  assert.equal(c.stages.receive.gate.human.id, 'A')
  assert.equal(c.stages.receive.gate.human.block, true)
  assert.equal(c.stages.receive.review.enabled, false)
  assert.deepEqual(c.stages.receive.rules, [
    'G-01', 'G-02', 'G-03', 'G-04', 'G-05', 'G-06', 'G-07', 'G-08',
    'R1-01', 'R1-02', 'R1-03', 'R1-04',
  ])
  assert.equal(c.stages.receive.budget.maxSteps, 20)
})

test('analyze keeps dual human gates B/C and merges tools delta', () => {
  const c = cfg()
  assert.equal(c.stages.analyze.gate.human.id, 'B')
  assert.equal(c.stages.analyze.gate.human2.id, 'C')
  assert.deepEqual(c.stages.analyze.tools, { deny: ['kb_query'] })
  // 交叉检查默认开启
  assert.equal(c.stages.analyze.review.enabled, true)
})

test('explicit stage overrides win over defaults', () => {
  const c = cfg()
  assert.equal(c.stages.design.review.enabled, false)
  assert.equal(c.stages.execute.budget.maxSteps, 200)
  assert.equal(c.stages.execute.budget.timeoutMs, 0) // 默认保留
})

test('releasePolicy default is 0.3 when omitted', () => {
  const c = normalizeConfig({ ...FULL_FIXTURE, releasePolicy: undefined })
  assert.equal(c.releasePolicy.maxManualClaimedRatio, DEFAULT_MAX_MANUAL_CLAIMED_RATIO)
})

test('invalid releasePolicy ratio is rejected', () => {
  assert.throws(() => cfg({ releasePolicy: { maxManualClaimedRatio: 1.5 } }), /\[0,1\]/)
})

test('missing projectId is rejected', () => {
  assert.throws(() => {
    const { projectId: _drop, ...rest } = FULL_FIXTURE
    normalizeConfig(rest)
  }, /projectId/)
})

test('invalid projectType is rejected', () => {
  assert.throws(() => cfg({ projectType: 'desktop' }), /projectType/)
})

test('invalid scaleTier is rejected', () => {
  assert.throws(() => cfg({ scaleTier: 'XL' }), /scaleTier/)
})

test('expandRuleList expands G and R ranges and keeps plain ids', () => {
  assert.deepEqual(expandRuleList(['G-01..G-03', 'R4-01..R4-03', 'X-99']), [
    'G-01', 'G-02', 'G-03',
    'R4-01', 'R4-02', 'R4-03',
    'X-99',
  ])
  assert.throws(() => expandRuleList(['G-03..G-01']), /descending/)
  assert.throws(() => expandRuleList(['G-01..R4-02']), /different prefixes/)
})

test('parsePipelineConfig parses YAML with the design draft shape', () => {
  const yaml = `
projectId: acme-pay-2026
projectType: api-service
templateVersion: v1
scaleTier: M
stores:
  knowledge: { impl: markdown-fs, path: kb/acme-pay }
  cases: { impl: markdown-fs, path: cases/acme-pay }
  requirements:
    primary: { impl: jira, projectKey: PAY, mode: readonly-api }
    fallback:
      - { impl: export-files, dir: inputs/requirements }
      - { impl: paste }
stages:
  analyze:
    tools:
      deny: [kb_query]
`
  const c = parsePipelineConfig(yaml, 'yaml')
  assert.equal(c.projectId, 'acme-pay-2026')
  assert.equal(c.stages.analyze.tools?.deny?.[0], 'kb_query')
  assert.equal(c.stages.report.gate.human.id, 'F')
  assert.equal(c.stages.report.review.enabled, true)
})

test('yaml rules shorthand range expands', () => {
  const yaml = `
projectId: p
projectType: api-service
templateVersion: v1
scaleTier: S
stores:
  knowledge: { impl: markdown-fs }
  cases: { impl: markdown-fs }
  requirements: { primary: { impl: paste } }
stages:
  receive:
    rules: [G-01..G-03]
`
  const c = parsePipelineConfig(yaml, 'yaml')
  assert.deepEqual(c.stages.receive.rules, ['G-01', 'G-02', 'G-03'])
})
