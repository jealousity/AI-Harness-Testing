import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import type { JudgeResult } from '../src/gates/machine.ts'
import type { StageArtifact } from '../src/types.ts'
import {
  FileHumanGateTaskStore,
  type HumanGateTask,
  type HumanGateTaskStore,
} from '../src/runtime/persistence.ts'
import {
  HumanGateWaitAbortedError,
  HumanGateExpiredError,
  PersistentHumanGate,
  type PersistentGateAuditRecord,
} from '../src/runtime/persistent-human-gate.ts'

let dir: string

test.beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'pp-human-gate-')) })
test.afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

const noSleep = async (): Promise<void> => {}

function artifact(path = 'artifacts/p1/analyze.json'): StageArtifact {
  return { pipelineId: 'p1', stageId: 'analyze', version: 1, inputs: {}, content: { ok: true }, digest: 'digest-1', path }
}

function passedGate(): JudgeResult { return { status: 'passed', violations: [] } }
function failedGate(): JudgeResult {
  return { status: 'failed', violations: [{ rule: 'G-01', level: 'BLOCKING', detail: 'missing coverage', at: 1 }] }
}

function openTask(tasks: readonly HumanGateTask[]): HumanGateTask {
  const found = tasks.find(task => task.status === 'pending' || task.status === 'claimed')
  assert.ok(found !== undefined, 'expected an open human gate task')
  return found
}

function storeDir(): string { return join(dir, 'gates') }

test('PersistentHumanGate opens a pending task and maps an external decision', async () => {
  const store = new FileHumanGateTaskStore(storeDir())
  const opened: HumanGateTask[] = []
  const audits: PersistentGateAuditRecord[] = []
  const gate = new PersistentHumanGate({
    store,
    projectId: 'demo',
    pipelineId: 'p1',
    sleep: noSleep,
    onPending: async (task) => {
      opened.push(task)
      await store.claim(task.gateTaskId, 'alice', 60_000)
      await store.decide(task.gateTaskId, 'alice', 'approved', 'lgtm')
    },
    onDecision: (record) => { audits.push(record) },
  })

  const decision = await gate.gate('analyze', artifact(), passedGate())

  assert.equal(decision, 'approved')
  assert.equal(opened.length, 1)
  assert.equal(opened[0]?.status, 'pending')
  assert.equal(opened[0]?.machineStatus, 'passed')
  assert.equal(opened[0]?.artifactPath, 'artifacts/p1/analyze.json')
  assert.equal(opened[0]?.expiresAt !== undefined, true)
  assert.equal(audits.length, 1)
  assert.equal(audits[0]?.by, 'alice')
  assert.equal(audits[0]?.action, 'approved')
  assert.equal(audits[0]?.note, 'lgtm')

  const tasks = await store.list({ pipelineId: 'p1' })
  assert.equal(tasks.length, 1)
  assert.equal(tasks[0]?.status, 'approved')
})

test('PersistentHumanGate records machine violations and review findings on the task', async () => {
  const store = new FileHumanGateTaskStore(storeDir())
  let created: HumanGateTask | undefined
  const gate = new PersistentHumanGate({
    store,
    projectId: 'demo',
    pipelineId: 'p1',
    sleep: noSleep,
    onPending: async (task) => {
      created = task
      await store.claim(task.gateTaskId, 'alice', 60_000)
      await store.decide(task.gateTaskId, 'alice', 'rejected', '结论不成立')
    },
  })

  const decision = await gate.gate('report', artifact('artifacts/p1/report.json'), {
    status: 'passed',
    violations: [{ rule: 'G-05', level: 'WARNING', detail: 'no evidence ref', at: 2 }],
  }, { verdict: 'conditional', findings: ['缺少证据锚定'] })

  assert.equal(decision, 'rejected')
  assert.equal(created?.machineViolations.length, 1)
  assert.equal(created?.machineViolations[0]?.rule, 'G-05')
  assert.equal(created?.review?.verdict, 'conditional')
  assert.deepEqual(created?.review?.findings, ['缺少证据锚定'])
})

test('PersistentHumanGate resumes an open task after a restart instead of opening a second gate', async () => {
  const store = new FileHumanGateTaskStore(storeDir())
  // 模拟上一次进程在等待人工裁决时崩溃留下的未决任务。
  await store.create({
    gateTaskId: 'gate-orphan',
    projectId: 'demo',
    pipelineId: 'p1',
    stageId: 'analyze',
    artifactPath: 'artifacts/p1/analyze.json',
    machineStatus: 'passed',
    machineViolations: [],
    expiresAt: Date.now() + 60_000,
  })

  const opened: HumanGateTask[] = []
  let polls = 0
  const gate = new PersistentHumanGate({
    store,
    projectId: 'demo',
    pipelineId: 'p1',
    onPending: (task) => { opened.push(task) },
    sleep: async () => {
      polls += 1
      assert.ok(polls <= 5, 'gate should settle within a few polls')
      const open = openTask(await store.list({ pipelineId: 'p1' }))
      await store.claim(open.gateTaskId, 'bob', 60_000)
      await store.decide(open.gateTaskId, 'bob', 'changes-needed', '补齐覆盖率')
    },
  })

  const decision = await gate.gate('analyze', artifact(), passedGate())

  assert.equal(decision, 'changes-needed')
  assert.equal(opened.length, 0, 'a resumed task must not re-trigger onPending')
  const tasks = await store.list({ pipelineId: 'p1' })
  assert.equal(tasks.length, 1)
  assert.equal(tasks[0]?.gateTaskId, 'gate-orphan')
  assert.equal(tasks[0]?.decision?.by, 'bob')
})

test('PersistentHumanGate reuses a decided-but-unconsumed gate exactly once', async () => {
  const store = new FileHumanGateTaskStore(storeDir())
  // 人工在流水线未运行时完成了裁决：这条结论必须被下一次 run 认领，而不是被丢弃。
  await store.create({
    gateTaskId: 'gate-old',
    projectId: 'demo',
    pipelineId: 'p1',
    stageId: 'analyze',
    artifactPath: 'artifacts/p1/analyze.json',
    machineStatus: 'passed',
    machineViolations: [],
    status: 'changes-needed',
    decision: { by: 'bob', action: 'changes-needed', note: '补齐覆盖率', at: 1 },
    expiresAt: Date.now() + 60_000,
  })

  const opened: HumanGateTask[] = []
  const gate = new PersistentHumanGate({
    store,
    projectId: 'demo',
    pipelineId: 'p1',
    waitTimeoutMs: 0,
    onPending: (task) => { opened.push(task) },
    sleep: noSleep,
  })

  assert.equal(await gate.gate('analyze', artifact(), passedGate()), 'changes-needed')
  assert.equal(opened.length, 0, '续用既有裁决时不应新建门')
  const tasks = await store.list({ pipelineId: 'p1' })
  assert.equal(tasks.length, 1)
  assert.equal(tasks[0]?.consumedAt !== undefined, true, '裁决被消费后才允许下一轮开门')

  // 打回重跑后再次开门：旧裁决已消费，必须新建一条门（否则会反复命中旧裁决而空转）
  const next = new PersistentHumanGate({
    store,
    projectId: 'demo',
    pipelineId: 'p1',
    waitTimeoutMs: 0,
    onPending: (task) => { opened.push(task) },
    sleep: noSleep,
  })
  await assert.rejects(() => next.gate('analyze', artifact(), passedGate()), HumanGateWaitAbortedError)
  assert.equal(opened.length, 1)
  assert.equal((await store.list({ pipelineId: 'p1' })).length, 2)
})

test('PersistentHumanGate never auto-approves on expiry', async () => {
  const store = new FileHumanGateTaskStore(storeDir())
  let clock = 1_000_000
  const gate = new PersistentHumanGate({
    store,
    projectId: 'demo',
    pipelineId: 'p1',
    taskTtlMs: 10,
    now: () => { clock += 1_000; return clock },
    sleep: noSleep,
  })

  await assert.rejects(() => gate.gate('analyze', artifact(), passedGate()), HumanGateExpiredError)

  const tasks = await store.list({ pipelineId: 'p1' })
  assert.equal(tasks.length, 1)
  assert.equal(tasks[0]?.status, 'expired')
  assert.equal(tasks[0]?.decision, undefined)
})

test('PersistentHumanGate degrades on expiry only when the host opts in', async () => {
  const store = new FileHumanGateTaskStore(storeDir())
  let clock = 2_000_000
  const gate = new PersistentHumanGate({
    store,
    projectId: 'demo',
    pipelineId: 'p1',
    taskTtlMs: 10,
    onExpired: 'changes-needed',
    now: () => { clock += 1_000; return clock },
    sleep: noSleep,
  })

  assert.equal(await gate.gate('analyze', artifact(), passedGate()), 'changes-needed')
})

test('PersistentHumanGate aborts on signal and cancels the open task', async () => {
  const store = new FileHumanGateTaskStore(storeDir())
  const controller = new AbortController()
  const gate = new PersistentHumanGate({
    store,
    projectId: 'demo',
    pipelineId: 'p1',
    signal: controller.signal,
    sleep: noSleep,
    onPending: () => { controller.abort() },
  })

  await assert.rejects(() => gate.gate('analyze', artifact(), passedGate()), (error: unknown) => {
    assert.ok(error instanceof HumanGateWaitAbortedError)
    assert.equal(error.reason, 'signal')
    assert.equal(error.stageId, 'analyze')
    return true
  })

  const tasks = await store.list({ pipelineId: 'p1' })
  assert.equal(tasks.length, 1)
  assert.equal(tasks[0]?.status, 'cancelled')
  assert.equal(tasks[0]?.cancellation?.by, 'system')
})

test('PersistentHumanGate treats an externally cancelled task as an abort', async () => {
  const store = new FileHumanGateTaskStore(storeDir())
  const gate = new PersistentHumanGate({
    store,
    projectId: 'demo',
    pipelineId: 'p1',
    onAborted: 'changes-needed',
    sleep: async () => {
      const open = openTask(await store.list({ pipelineId: 'p1' }))
      await store.cancel(open.gateTaskId, 'alice', '需求撤回')
    },
  })

  assert.equal(await gate.gate('analyze', artifact(), passedGate()), 'changes-needed')
  const tasks = await store.list({ pipelineId: 'p1' })
  assert.equal(tasks[0]?.status, 'cancelled')
  assert.equal(tasks[0]?.cancellation?.note, '需求撤回')
})

test('PersistentHumanGate still aborts when the store cannot cancel', async () => {
  const inner = new FileHumanGateTaskStore(storeDir())
  const bare: HumanGateTaskStore = {
    create: input => inner.create(input),
    get: id => inner.get(id),
    list: filter => inner.list(filter),
    claim: (id, actor, ttlMs) => inner.claim(id, actor, ttlMs),
    decide: (id, actor, action, note) => inner.decide(id, actor, action, note),
    expire: now => inner.expire(now),
    consume: (id, at) => inner.consume(id, at),
  }
  const controller = new AbortController()
  const gate = new PersistentHumanGate({
    store: bare,
    projectId: 'demo',
    pipelineId: 'p1',
    signal: controller.signal,
    sleep: noSleep,
    onPending: () => { controller.abort() },
  })

  await assert.rejects(() => gate.gate('analyze', artifact(), passedGate()), HumanGateWaitAbortedError)
  const tasks = await inner.list({ pipelineId: 'p1' })
  assert.equal(tasks[0]?.status, 'pending', 'without cancel support the task is left for expiry sweep')
})

test('gateFailed records an escalation task that gate() never resumes', async () => {
  const store = new FileHumanGateTaskStore(storeDir())
  const opened: HumanGateTask[] = []
  const gate = new PersistentHumanGate({
    store,
    projectId: 'demo',
    pipelineId: 'p1',
    onPending: (task) => { opened.push(task) },
    sleep: async () => {
      const open = openTask(await store.list({ pipelineId: 'p1' }))
      await store.claim(open.gateTaskId, 'alice', 60_000)
      await store.decide(open.gateTaskId, 'alice', 'approved', '')
    },
  })

  await gate.gateFailed('analyze', failedGate())

  const escalations = await store.list({ pipelineId: 'p1' })
  assert.equal(escalations.length, 1)
  assert.equal(escalations[0]?.machineStatus, 'failed')
  assert.equal(escalations[0]?.artifactPath, '')
  assert.equal(escalations[0]?.status, 'pending')

  // 真正的阶段门不会被升级任务吞掉：仍会新建一条 passed 任务。
  assert.equal(await gate.gate('analyze', artifact(), passedGate()), 'approved')
  assert.equal(opened.length, 2)
  const all = await store.list({ pipelineId: 'p1' })
  assert.equal(all.length, 2)
  assert.equal(all.filter(task => task.machineStatus === 'passed').length, 1)
})

test('gateFailed waits for acknowledgement only when configured', async () => {
  const store = new FileHumanGateTaskStore(storeDir())
  const audits: PersistentGateAuditRecord[] = []
  const gate = new PersistentHumanGate({
    store,
    projectId: 'demo',
    pipelineId: 'p1',
    waitOnGateFailed: true,
    onDecision: (record) => { audits.push(record) },
    sleep: async () => {
      const open = openTask(await store.list({ pipelineId: 'p1' }))
      await store.claim(open.gateTaskId, 'alice', 60_000)
      await store.decide(open.gateTaskId, 'alice', 'approved', '已确认终止')
    },
  })

  await gate.gateFailed('analyze', failedGate())

  assert.equal(audits.length, 1)
  assert.equal(audits[0]?.by, 'alice')
  assert.equal(audits[0]?.note, '已确认终止')
  const tasks = await store.list({ pipelineId: 'p1' })
  assert.equal(tasks[0]?.status, 'approved')
})

test('gateFailed does not throw when the acknowledgement wait is aborted', async () => {
  const store = new FileHumanGateTaskStore(storeDir())
  const controller = new AbortController()
  const audits: PersistentGateAuditRecord[] = []
  const gate = new PersistentHumanGate({
    store,
    projectId: 'demo',
    pipelineId: 'p1',
    waitOnGateFailed: true,
    signal: controller.signal,
    sleep: noSleep,
    onPending: () => { controller.abort() },
    onDecision: (record) => { audits.push(record) },
  })

  await gate.gateFailed('analyze', failedGate())

  assert.equal(audits.length, 1)
  assert.equal(audits[0]?.action, 'rejected')
  assert.match(audits[0]?.note ?? '', /未获确认/)
})

test('PersistentHumanGate rejects invalid options', () => {
  const store = new FileHumanGateTaskStore(storeDir())
  assert.throws(() => new PersistentHumanGate({ store, projectId: ' ', pipelineId: 'p1' }), /projectId/)
  assert.throws(() => new PersistentHumanGate({ store, projectId: 'demo', pipelineId: '' }), /pipelineId/)
  assert.throws(() => new PersistentHumanGate({ store, projectId: 'demo', pipelineId: 'p1', taskTtlMs: 0 }), /taskTtlMs/)
  assert.throws(() => new PersistentHumanGate({ store, projectId: 'demo', pipelineId: 'p1', pollIntervalMs: -1 }), /pollIntervalMs/)
  assert.throws(() => new PersistentHumanGate({ store, projectId: 'demo', pipelineId: 'p1', waitTimeoutMs: -1 }), /waitTimeoutMs/)
})

/**
 * CLI 的「挂起等人工」模式：waitTimeoutMs=0 只轮询一次就让出控制权。
 * 关键性质：**任务保持未决**（不取消、不过期），裁决人仍可继续裁决。
 */
test('PersistentHumanGate hands control back on wait timeout without cancelling the task', async () => {
  const store = new FileHumanGateTaskStore(storeDir())
  const gate = new PersistentHumanGate({
    store, projectId: 'demo', pipelineId: 'p1', waitTimeoutMs: 0, sleep: noSleep,
  })

  await assert.rejects(() => gate.gate('analyze', artifact(), passedGate()), (error: unknown) => {
    assert.ok(error instanceof HumanGateWaitAbortedError)
    assert.equal(error.reason, 'timeout')
    return true
  })

  const tasks = await store.list({ pipelineId: 'p1' })
  assert.equal(tasks.length, 1)
  assert.equal(tasks[0]?.status, 'pending', '让出控制权不等于取消：裁决人仍可裁决')
})

test('PersistentHumanGate resumes the same task after a wait timeout and honours the decision', async () => {
  const store = new FileHumanGateTaskStore(storeDir())
  const parked = new PersistentHumanGate({
    store, projectId: 'demo', pipelineId: 'p1', waitTimeoutMs: 0, sleep: noSleep,
  })
  await assert.rejects(() => parked.gate('analyze', artifact(), passedGate()), HumanGateWaitAbortedError)
  const taskId = (await store.list({ pipelineId: 'p1' }))[0]!.gateTaskId

  await store.claim(taskId, 'alice', 60_000)
  await store.decide(taskId, 'alice', 'approved', '通过')

  // 第二次调用（等价于运维裁决后再执行一次 run）：续上同一条任务并返回裁决
  const resumed = new PersistentHumanGate({
    store, projectId: 'demo', pipelineId: 'p1', waitTimeoutMs: 0, sleep: noSleep,
    onPending: () => { throw new Error('续跑不应新建人工门任务') },
  })
  assert.equal(await resumed.gate('analyze', artifact(), passedGate()), 'approved')
  assert.equal((await store.list({ pipelineId: 'p1' })).length, 1)
})

test('PersistentHumanGate returns a decision already present on the first poll (no waiting)', async () => {
  const store = new FileHumanGateTaskStore(storeDir())
  await store.create({
    gateTaskId: 'gate-ready', projectId: 'demo', pipelineId: 'p1', stageId: 'analyze',
    artifactPath: 'artifacts/p1/analyze.json', machineStatus: 'passed', machineViolations: [],
    status: 'approved', decision: { by: 'alice', action: 'approved', note: '', at: 1 },
    expiresAt: Date.now() + 60_000,
  })
  const gate = new PersistentHumanGate({
    store, projectId: 'demo', pipelineId: 'p1', waitTimeoutMs: 0,
    sleep: () => { throw new Error('已有裁决时不应进入等待') },
  })
  assert.equal(await gate.gate('analyze', artifact(), passedGate()), 'approved')
})
