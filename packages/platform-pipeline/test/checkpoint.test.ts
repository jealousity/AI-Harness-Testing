import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initialCheckpoint, loadCheckpoint, saveCheckpoint } from '../src/checkpoint.ts'
import { STAGE_ORDER } from '../src/types.ts'

let dir: string

test.beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'pp-checkpoint-'))
})

test.afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

test('initialCheckpoint has idle stages, cursor 0, and artifact paths', () => {
  const cp = initialCheckpoint('pipe-1', 'v1', 'rules-v1')
  assert.equal(cp.pipelineId, 'pipe-1')
  assert.equal(cp.cursor, 0)
  assert.deepEqual(cp.reentries, [])
  for (const id of STAGE_ORDER) {
    assert.equal(cp.stageStates[id].status, 'idle')
    assert.equal(cp.stageStates[id].artifact, `artifacts/pipe-1/${id}.json`)
    assert.deepEqual(cp.stageStates[id].gate.human.records, [])
  }
})

test('save then load round-trips the checkpoint', async () => {
  const cp = initialCheckpoint('pipe-2', 'v1', 'rules-v1')
  await saveCheckpoint(dir, cp)
  const loaded = await loadCheckpoint(dir)
  assert.ok(loaded !== null)
  assert.equal(loaded.pipelineId, 'pipe-2')
  assert.equal(loaded.stageStates.analyze.status, 'idle')
})

test('load returns null when no checkpoint exists', async () => {
  const loaded = await loadCheckpoint(dir)
  assert.equal(loaded, null)
})

test('save is atomic: no tmp file left behind and content is valid JSON', async () => {
  const cp = initialCheckpoint('pipe-3', 'v1', 'rules-v1')
  await saveCheckpoint(dir, cp)
  const files = await readdir(dir)
  assert.deepEqual(files, ['checkpoint.json'])
  const raw = await readFile(join(dir, 'checkpoint.json'), 'utf8')
  assert.deepEqual(JSON.parse(raw).pipelineId, 'pipe-3')
})
