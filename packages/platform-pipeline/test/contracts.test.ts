import { test } from 'node:test'
import assert from 'node:assert/strict'
import { validateSubset } from '../src/gates/schema.ts'
import { pipelineContractSchemas } from '../src/contracts/schemas.ts'
import { stageContent, type Content } from './fixtures.ts'
import { STAGE_ORDER, type StageId } from '../src/types.ts'

const schemas = pipelineContractSchemas()

function upstreamsUpTo(stageId: StageId): Record<string, Content> {
  const out: Record<string, Content> = {}
  for (const id of STAGE_ORDER) {
    if (STAGE_ORDER.indexOf(id) >= STAGE_ORDER.indexOf(stageId)) break
    out[id] = stageContent(id, out)
  }
  return out
}

test('all six stage fixtures validate against their contract schemas (G-01/G-02 clean)', () => {
  for (const stageId of STAGE_ORDER) {
    const content = stageContent(stageId, upstreamsUpTo(stageId))
    const errors = validateSubset(content, schemas[stageId]!)
    assert.deepEqual(errors, [], `stage ${stageId} fixture should validate clean, got: ${errors.join('; ')}`)
  }
})

test('a structural mutation fails G-01 (unknown property)', () => {
  const content = stageContent('receive', {})
  const bad = { ...content, sneaky: true }
  assert.ok(validateSubset(bad, schemas.receive!).some(e => e.includes('unexpected property')))
})

test('empty requirements array fails G-01 minItems', () => {
  const content = stageContent('receive', {})
  const bad = { ...content, requirements: [] }
  assert.ok(validateSubset(bad, schemas.receive!).some(e => e.includes('at least 1')))
})

test('invalid priority enum fails G-01', () => {
  const content = stageContent('receive', {})
  const bad = {
    ...content,
    requirements: [{ ...(content.requirements as unknown[])[0] as object, priority: 'P9' }],
  }
  assert.ok(validateSubset(bad, schemas.receive!).some(e => e.includes('enum')))
})
