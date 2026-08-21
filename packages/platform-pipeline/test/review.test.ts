import { test } from 'node:test'
import assert from 'node:assert/strict'
import { assembleReviewPrompt, REVIEW_CHECKLISTS } from '../src/prompt/review.ts'

test('assembleReviewPrompt is blind: no producer context, has checklist and schema', () => {
  const prompt = assembleReviewPrompt({
    stageId: 'analyze',
    pipelineId: 'pipe-1',
    artifactPath: 'artifacts/pipe-1/analyze.json',
    upstreamPaths: { receive: 'artifacts/pipe-1/receive.json' },
    violations: [{ rule: 'R2-03', level: 'BLOCKING', detail: '缺依据' }],
  })
  assert.ok(prompt.includes('与生产 agent 无任何关系'))
  assert.ok(prompt.includes('artifacts/pipe-1/analyze.json'))
  assert.ok(prompt.includes('[BLOCKING] R2-03'))
  assert.ok(prompt.includes('"verdict": "enum: pass|conditional|fail"'))
  assert.ok(prompt.includes('checked 必须列出你实际复核的必查面'))
  assert.ok(prompt.includes('不得调用 subagent / 委托复核'))
})

test('analyze checklist covers the four design faces (D-14)', () => {
  const list = REVIEW_CHECKLISTS.analyze
  assert.ok(list.some(item => item.includes('boundaries')))
  assert.ok(list.some(item => item.includes('versionImpact')))
  assert.ok(list.some(item => item.includes('reuseSuggestions')))
  assert.ok(list.some(item => item.includes('openQuestions')))
})

test('stages with review disabled have empty checklists', () => {
  assert.deepEqual(REVIEW_CHECKLISTS.receive, [])
  assert.deepEqual(REVIEW_CHECKLISTS.archive, [])
})
