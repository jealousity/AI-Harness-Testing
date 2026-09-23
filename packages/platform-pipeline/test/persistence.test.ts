import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { FileHumanGateTaskStore, FileTaskStore } from '../src/runtime/persistence.ts'

let dir: string

test.beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'pp-persistence-')) })
test.afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

function task() {
  return { taskId: 'task-1', projectId: 'demo', pipelineId: 'pipeline-1', status: 'queued' as const, attempt: 0 }
}

test('FileTaskStore persists status transitions, heartbeat and stale recovery', async () => {
  const store = new FileTaskStore(join(dir, 'tasks'))
  const created = await store.create(task())
  assert.equal(created.status, 'queued')
  const leased = await store.acquireLease('task-1', 'worker-a', 10_000)
  assert.equal(leased.status, 'running')
  assert.equal(leased.lease?.owner, 'worker-a')
  await assert.rejects(() => store.acquireLease('task-1', 'worker-b', 1000), /leased by worker-a/)
  const beat = await store.heartbeat('task-1', 'worker-a', 10_000)
  assert.equal(beat.heartbeatAt !== undefined, true)
  await assert.rejects(() => store.heartbeat('task-1', 'worker-b', 10_000), /active lease ownership/)
  const recovered = await store.recoverStale(Date.now() + 20_000)
  assert.equal(recovered.length, 1)
  assert.equal(recovered[0]?.status, 'queued')
  assert.equal(recovered[0]?.lease, undefined)
  const raw = await readFile(join(dir, 'tasks', 'task-1.json'), 'utf8')
  assert.match(raw, /stale lease recovered/)
})

test('FileHumanGateTaskStore supports claim, decision and expiry', async () => {
  const store = new FileHumanGateTaskStore(join(dir, 'gates'))
  await store.create({
    gateTaskId: 'gate-1', projectId: 'demo', pipelineId: 'pipeline-1', stageId: 'analyze', artifactPath: 'artifacts/pipeline-1/analyze.json',
    machineStatus: 'passed', machineViolations: [], expiresAt: Date.now() + 10_000,
  })
  const claimed = await store.claim('gate-1', 'alice', 1000)
  assert.equal(claimed.status, 'claimed')
  await assert.rejects(() => store.claim('gate-1', 'bob', 1000), /claimed by alice/)
  await assert.rejects(() => store.decide('gate-1', 'alice', 'rejected', ''), /non-empty note/)
  const decided = await store.decide('gate-1', 'alice', 'approved', '')
  assert.equal(decided.status, 'approved')
  assert.equal(decided.decision?.by, 'alice')
})

test('FileHumanGateTaskStore expires pending tasks and rejects expired decisions', async () => {
  const store = new FileHumanGateTaskStore(join(dir, 'gates'))
  await store.create({
    gateTaskId: 'gate-expired', projectId: 'demo', pipelineId: 'pipeline-1', stageId: 'report', artifactPath: 'artifacts/pipeline-1/report.json',
    machineStatus: 'failed', machineViolations: [{ rule: 'R5-01', level: 'BLOCKING', detail: 'fabricated pass rate' }], expiresAt: 100,
  })
  const expired = await store.expire(101)
  assert.equal(expired.length, 1)
  assert.equal(expired[0]?.status, 'expired')
  await assert.rejects(() => store.claim('gate-expired', 'alice', 1000), /not claimable/)
})
