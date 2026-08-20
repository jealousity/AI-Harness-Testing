import { test } from 'node:test'
import assert from 'node:assert/strict'
import { effectiveAcl, validatePipelineAcl, validateStageDelta } from '../src/acl.ts'
import { PLATFORM_ACL } from '../src/tool-catalog.ts'
import { normalizeConfig } from '../src/config.ts'
import { STAGE_ORDER, type PipelineConfig } from '../src/types.ts'

const BASE = {
  projectId: 'p',
  projectType: 'api-service',
  templateVersion: 'v1',
  scaleTier: 'S',
  stores: {
    knowledge: { impl: 'markdown-fs' },
    cases: { impl: 'markdown-fs' },
    requirements: { primary: { impl: 'paste' } },
  },
  stages: {},
}

function cfg(stages: Record<string, unknown>): PipelineConfig {
  return normalizeConfig({ ...BASE, stages })
}

test('effectiveAcl without delta equals platform standard', () => {
  const c = cfg({})
  for (const id of STAGE_ORDER) {
    assert.deepEqual(effectiveAcl(id, c), PLATFORM_ACL[id])
  }
})

test('effectiveAcl merges delta deny into base', () => {
  const c = cfg({ analyze: { tools: { deny: ['kb_query'] } } })
  const acl = effectiveAcl('analyze', c)
  assert.ok(acl.deny?.includes('kb_query'))
  assert.ok(acl.allow?.includes('kb_query')) // 平台标准 allow 保留
  assert.ok(acl.allow?.includes('case_query'))
})

test('effectiveAcl merges delta allow (project extension)', () => {
  const c = cfg({ design: { tools: { allow: ['case_query'] } } })
  const acl = effectiveAcl('design', c)
  assert.ok(acl.allow?.includes('case_query'))
})

test('validateStageDelta rejects unknown tool names', () => {
  const result = validateStageDelta('analyze', { allow: ['no_such_tool'] })
  assert.equal(result.ok, false)
  assert.match(result.errors[0] ?? '', /unknown tool "no_such_tool"/)
})

test('validateStageDelta rejects lifting a platform-standard deny', () => {
  // design 平台 deny kb_query；delta.allow 想放行 = 降级标准，拒绝
  const result = validateStageDelta('design', { allow: ['kb_query'] })
  assert.equal(result.ok, false)
  assert.match(result.errors[0] ?? '', /platform-standard deny/)
})

test('validateStageDelta accepts deny-only delta', () => {
  const result = validateStageDelta('analyze', { deny: ['kb_query'] })
  assert.equal(result.ok, true)
})

test('validatePipelineAcl aggregates all stages', () => {
  const c = cfg({
    design: { tools: { allow: ['kb_query'] } }, // 非法：试图放行标准 deny
    execute: { tools: { deny: ['no_such_tool'] } }, // 非法：未知工具
  })
  const result = validatePipelineAcl(c)
  assert.equal(result.ok, false)
  assert.equal(result.errors.length, 2)
})

test('validatePipelineAcl passes a clean config', () => {
  const c = cfg({ analyze: { tools: { deny: ['kb_query'] } } })
  const result = validatePipelineAcl(c)
  assert.equal(result.ok, true)
  assert.deepEqual(result.errors, [])
})
