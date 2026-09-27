import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, utimes } from 'node:fs/promises'
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

test('FileHumanGateTaskStore cancels open tasks but never overwrites a decision', async () => {
  const store = new FileHumanGateTaskStore(join(dir, 'gates'))
  await store.create({
    gateTaskId: 'gate-cancel', projectId: 'demo', pipelineId: 'pipeline-1', stageId: 'design', artifactPath: 'artifacts/pipeline-1/design.json',
    machineStatus: 'passed', machineViolations: [], expiresAt: Date.now() + 10_000,
  })
  const cancelled = await store.cancel('gate-cancel', 'alice', '需求撤回')
  assert.equal(cancelled.status, 'cancelled')
  assert.equal(cancelled.cancellation?.by, 'alice')
  assert.equal(cancelled.cancellation?.note, '需求撤回')
  assert.equal(cancelled.lease, undefined)
  await assert.rejects(() => store.cancel('gate-cancel', 'alice'), /not cancellable/)
  await assert.rejects(() => store.cancel('gate-cancel', '  '), /actor must not be empty/)

  await store.create({
    gateTaskId: 'gate-decided', projectId: 'demo', pipelineId: 'pipeline-1', stageId: 'design', artifactPath: 'artifacts/pipeline-1/design.json',
    machineStatus: 'passed', machineViolations: [], status: 'approved',
    decision: { by: 'bob', action: 'approved', note: '', at: Date.now() },
  })
  await assert.rejects(() => store.cancel('gate-decided', 'alice'), /not cancellable/)
  assert.equal((await store.get('gate-decided'))?.status, 'approved')
})

test('FileHumanGateTaskStore consumes a decision exactly once and refuses to consume an open task', async () => {
  const store = new FileHumanGateTaskStore(join(dir, 'gates'))
  await store.create({
    gateTaskId: 'gate-consume', projectId: 'demo', pipelineId: 'pipeline-1', stageId: 'analyze',
    artifactPath: 'artifacts/pipeline-1/analyze.json', machineStatus: 'passed', machineViolations: [],
    expiresAt: Date.now() + 10_000,
  })
  await assert.rejects(() => store.consume('gate-consume', 5), /not consumable/)

  await store.claim('gate-consume', 'alice', 10_000)
  await store.decide('gate-consume', 'alice', 'approved', '')
  const consumed = await store.consume('gate-consume', 7)
  assert.equal(consumed.consumedAt, 7)
  assert.equal(consumed.updatedAt, 7)
  // 重复消费是幂等的：不得把 consumedAt 推到更晚（否则审计时间线会被改写）
  const again = await store.consume('gate-consume', 99)
  assert.equal(again.consumedAt, 7)
})

// ── P1-05：文件门任务必须是 CAS（docs/11）─────────────────────────────────────
//
// 修复前 `claim`/`decide`/`cancel` 都是 `get → 检查 → save`：两个调用者可以同时读到
// 同一个 pending 快照、各自通过检查、再先后写入，最后写入者覆盖前者——而两个调用都
// 返回"成功"。下面用 `Promise.all` 制造这个交错：`get()` 内部的 await 会让两个调用
// 都停在"已读到快照、尚未写入"的位置，因此这是**确定性**复现，不需要任何 sleep。

/** 造一条 pending 门任务。 */
async function seedGate(store: FileHumanGateTaskStore, gateTaskId: string): Promise<void> {
  await store.create({
    gateTaskId, projectId: 'demo', pipelineId: 'pipeline-1', stageId: 'analyze',
    artifactPath: 'artifacts/pipeline-1/analyze.json', machineStatus: 'passed', machineViolations: [],
    expiresAt: Date.now() + 60_000,
  })
}

test('并发 claim 只允许一个成功，另一个必须明确失败', async () => {
  const store = new FileHumanGateTaskStore(join(dir, 'gates'))
  await seedGate(store, 'gate-race-claim')

  const results = await Promise.allSettled([
    store.claim('gate-race-claim', 'alice', 60_000),
    store.claim('gate-race-claim', 'bob', 60_000),
  ])
  const ok = results.filter(result => result.status === 'fulfilled')
  assert.equal(ok.length, 1, `并发 claim 只能有一个成功：${results.map(r => r.status).join(',')}`)

  // 最终磁盘事实必须与胜者的返回值一致（不得返回一个已被覆盖的旧快照）。
  const persisted = await store.get('gate-race-claim')
  const winner = (ok[0] as PromiseFulfilledResult<{ readonly claimedBy?: string }>).value
  assert.equal(persisted!.status, 'claimed')
  assert.equal(persisted!.claimedBy, winner.claimedBy)
  assert.equal(persisted!.lease!.owner, persisted!.claimedBy)
})

test('并发 decide 只允许一个成功，另一个不得覆盖已落盘的裁决', async () => {
  const store = new FileHumanGateTaskStore(join(dir, 'gates'))
  await seedGate(store, 'gate-race-decide')
  // 同一持有者认领后并发提交两个不同裁决（页面双开 / 两个值班同学）。
  await store.claim('gate-race-decide', 'alice', 60_000)

  const results = await Promise.allSettled([
    store.decide('gate-race-decide', 'alice', 'approved', ''),
    store.decide('gate-race-decide', 'alice', 'rejected', '结论不成立'),
  ])
  const ok = results.filter(result => result.status === 'fulfilled')
  assert.equal(ok.length, 1, `并发 decide 只能有一个成功：${results.map(r => r.status).join(',')}`)

  const persisted = await store.get('gate-race-decide')
  const winner = (ok[0] as PromiseFulfilledResult<{ readonly decision?: { readonly action: string } }>).value
  assert.equal(persisted!.decision!.action, winner.decision!.action, '磁盘事实必须与胜者的返回值一致')
})

test('并发 cancel 与 decide 不会互相覆盖（终态只有一个）', async () => {
  const store = new FileHumanGateTaskStore(join(dir, 'gates'))
  await seedGate(store, 'gate-race-cancel')
  await store.claim('gate-race-cancel', 'alice', 60_000)

  const results = await Promise.allSettled([
    store.decide('gate-race-cancel', 'alice', 'approved', ''),
    store.cancel('gate-race-cancel', 'ops', '重复门'),
  ])
  const ok = results.filter(result => result.status === 'fulfilled')
  assert.equal(ok.length, 1, `取消与裁决只能有一个生效：${results.map(r => r.status).join(',')}`)

  const persisted = await store.get('gate-race-cancel')
  const winner = (ok[0] as PromiseFulfilledResult<{ readonly status: string }>).value
  assert.equal(persisted!.status, winner.status)
})

test('并发 consume 只推进一次，且所有返回值与磁盘事实一致', async () => {
  const store = new FileHumanGateTaskStore(join(dir, 'gates'))
  await seedGate(store, 'gate-race-consume')
  await store.claim('gate-race-consume', 'alice', 60_000)
  await store.decide('gate-race-consume', 'alice', 'approved', '')

  const results = await Promise.all([
    store.consume('gate-race-consume', 11),
    store.consume('gate-race-consume', 22),
  ])
  const persisted = await store.get('gate-race-consume')
  assert.equal(persisted!.consumedAt, results[0]!.consumedAt, '磁盘事实必须等于首次消费的时间戳')
  assert.equal(results[1]!.consumedAt, persisted!.consumedAt, '幂等消费不得返回另一个时间戳')
})

test('互斥只作用于单条任务：不同门任务之间不互相阻塞', async () => {
  const store = new FileHumanGateTaskStore(join(dir, 'gates'))
  await seedGate(store, 'gate-parallel-a')
  await seedGate(store, 'gate-parallel-b')

  const [a, b] = await Promise.all([
    store.claim('gate-parallel-a', 'alice', 60_000),
    store.claim('gate-parallel-b', 'bob', 60_000),
  ])
  assert.equal(a.claimedBy, 'alice')
  assert.equal(b.claimedBy, 'bob')
})

test('持锁进程崩溃不会永久锁死任务：过期锁可被后来者接管', async () => {
  const store = new FileHumanGateTaskStore(join(dir, 'gates'))
  await seedGate(store, 'gate-stale-lock')

  // 直接造一个"崩溃留下的"锁目录（mtime 已在很久以前）。
  const lockDir = join(dir, 'gates', '.locks', 'gate-stale-lock.lock')
  await mkdir(lockDir, { recursive: true })
  const old = new Date(Date.now() - 10 * 60_000)
  await utimes(lockDir, old, old)

  const claimed = await store.claim('gate-stale-lock', 'alice', 60_000)
  assert.equal(claimed.claimedBy, 'alice', '过期锁必须能被接管，否则一次崩溃会永久锁死这个门')
})
