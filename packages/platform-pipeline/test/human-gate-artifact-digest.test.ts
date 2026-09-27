/**
 * 人工门必须绑定**具体产物版本**（docs/11 P1-04）。
 *
 * 批准的身份是"某个 artifact 版本"，而不是"某个路径上的东西"。修复前
 * `findResumableTask` 只比对 `stageId + artifactPath + machineStatus`，于是：
 *
 * - 同路径内容被替换后，旧任务仍会被复用 —— 真人看到的 findings 与最终冻结进
 *   检查点的 digest 来自两份不同的产物；
 * - 更严重的是 `approved` 但尚未消费的旧任务，会在重入/重跑产生新产物之后
 *   继续驱动门，等于**用旧批准放行新内容**。
 *
 * 修复后判定条件是 `pipelineId + stageId + artifactPath + artifactDigest + machineStatus`。
 * 没有 digest 的历史任务**不可续用**（失败关闭：宁可多问一次，绝不自动批准）。
 *
 * @module platform-pipeline/test/human-gate-artifact-digest
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import type { JudgeResult } from '../src/gates/machine.ts'
import type { StageArtifact } from '../src/types.ts'
import { FileHumanGateTaskStore, type HumanGateTask } from '../src/runtime/persistence.ts'
import { HumanGateWaitAbortedError, PersistentHumanGate } from '../src/runtime/persistent-human-gate.ts'

let dir: string

test.beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'pp-gate-digest-')) })
test.afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

const noSleep = async (): Promise<void> => {}
const ARTIFACT_PATH = 'artifacts/p1/analyze.json'

function artifact(digest: string, path = ARTIFACT_PATH): StageArtifact {
  return { pipelineId: 'p1', stageId: 'analyze', version: 1, inputs: {}, content: { ok: true }, digest, path }
}

function passedGate(): JudgeResult { return { status: 'passed', violations: [] } }

function storeDir(): string { return join(dir, 'gates') }

/**
 * 只轮询一次就让出控制权的门：`gate()` 会抛 `HumanGateWaitAbortedError`，
 * 但**任务保持未决**——这正是"挂起等人工"的形态，也是本文件观察开门行为的抓手。
 */
function gateOf(store: FileHumanGateTaskStore): PersistentHumanGate {
  return new PersistentHumanGate({ store, projectId: 'demo', pipelineId: 'p1', sleep: noSleep, waitTimeoutMs: 0 })
}

async function tasksOf(store: FileHumanGateTaskStore): Promise<readonly HumanGateTask[]> {
  return store.list({ pipelineId: 'p1' })
}

function openTaskOf(tasks: readonly HumanGateTask[]): HumanGateTask {
  const found = tasks.find(task => task.status === 'pending' || task.status === 'claimed')
  assert.ok(found !== undefined, `期望存在未决任务：${JSON.stringify(tasks.map(t => [t.gateTaskId, t.status]))}`)
  return found
}

// ── 任务记录 digest ─────────────────────────────────────────────────────────

test('人工门任务记录它送审的那个产物 digest', async () => {
  const store = new FileHumanGateTaskStore(storeDir())
  const gate = gateOf(store)

  await assert.rejects(() => gate.gate('analyze', artifact('digest-A'), passedGate()), HumanGateWaitAbortedError)

  const [task] = await tasksOf(store)
  assert.equal(task!.artifactDigest, 'digest-A', '任务必须记下"批准的是哪一份产物"')
})

// ── 同一 digest 续用；digest 变了必须新开门 ──────────────────────────────────

test('同一路径同一 digest 仍续用同一个门（重启不重复弹门的行为不能被破坏）', async () => {
  const store = new FileHumanGateTaskStore(storeDir())
  const gate = gateOf(store)

  await assert.rejects(() => gate.gate('analyze', artifact('digest-A'), passedGate()), HumanGateWaitAbortedError)
  const first = openTaskOf(await tasksOf(store))

  await assert.rejects(() => gate.gate('analyze', artifact('digest-A'), passedGate()), HumanGateWaitAbortedError)
  const tasks = await tasksOf(store)
  assert.equal(tasks.length, 1, '产物没变就不该开第二个门')
  assert.equal(tasks[0]!.gateTaskId, first.gateTaskId)
})

test('同一路径内容被替换（digest 变）后旧任务不再可续用，必须新开门', async () => {
  const store = new FileHumanGateTaskStore(storeDir())
  const gate = gateOf(store)

  await assert.rejects(() => gate.gate('analyze', artifact('digest-A'), passedGate()), HumanGateWaitAbortedError)
  const stale = openTaskOf(await tasksOf(store))

  await assert.rejects(() => gate.gate('analyze', artifact('digest-B'), passedGate()), HumanGateWaitAbortedError)

  const tasks = await tasksOf(store)
  assert.equal(tasks.length, 2, `digest 变了必须新开门，实际：${JSON.stringify(tasks.map(t => [t.artifactDigest, t.status]))}`)
  const fresh = tasks.find(task => task.gateTaskId !== stale.gateTaskId)!
  assert.equal(fresh.artifactDigest, 'digest-B')
  assert.equal(fresh.status, 'pending')
})

test('旧 approved-but-unconsumed 任务绝不能批准新 digest（旧批准不得放行新内容）', async () => {
  const store = new FileHumanGateTaskStore(storeDir())
  const gate = gateOf(store)

  // 1. 第一份产物开门，然后**在流水线之外**被真人批准（未被消费）。
  await assert.rejects(() => gate.gate('analyze', artifact('digest-A'), passedGate()), HumanGateWaitAbortedError)
  const old = openTaskOf(await tasksOf(store))
  await store.claim(old.gateTaskId, 'alice', 60_000)
  await store.decide(old.gateTaskId, 'alice', 'approved', 'lgtm')

  // 2. 产物被重写（digest-B），下一次 run 到来。
  await assert.rejects(() => gate.gate('analyze', artifact('digest-B'), passedGate()), HumanGateWaitAbortedError)

  const tasks = await tasksOf(store)
  assert.equal(tasks.length, 2, '旧批准属于 digest-A，不能用来放行 digest-B')
  const oldAfter = tasks.find(task => task.gateTaskId === old.gateTaskId)!
  assert.equal(oldAfter.status, 'approved')
  assert.equal(oldAfter.consumedAt, undefined, '旧批准必须原样保留作审计，但不得被消费')
  assert.equal(oldAfter.artifactDigest, 'digest-A')
  const fresh = tasks.find(task => task.gateTaskId !== old.gateTaskId)!
  assert.equal(fresh.artifactDigest, 'digest-B')
  assert.equal(fresh.status, 'pending')
})

test('没有 artifactDigest 的历史任务不可续用（失败关闭：宁可多问一次）', async () => {
  const store = new FileHumanGateTaskStore(storeDir())
  // 直接构造一条"旧版本写的"任务：路径与阶段都对，但没有 digest 字段。
  await store.create({
    gateTaskId: 'gate-legacy',
    projectId: 'demo',
    pipelineId: 'p1',
    stageId: 'analyze',
    artifactPath: ARTIFACT_PATH,
    machineStatus: 'passed',
    machineViolations: [],
    status: 'pending',
    expiresAt: Date.now() + 60_000,
  })

  const gate = gateOf(store)
  await assert.rejects(() => gate.gate('analyze', artifact('digest-A'), passedGate()), HumanGateWaitAbortedError)

  const tasks = await tasksOf(store)
  assert.equal(tasks.length, 2, '无法确认批准对象的旧任务不得被复用')
  const fresh = openTaskOf(tasks.filter(task => task.gateTaskId !== 'gate-legacy'))
  assert.equal(fresh.artifactDigest, 'digest-A')
})

test('不同 pipeline 的相同阶段/digest 互不干扰（作用域仍按 pipelineId 隔离）', async () => {
  const store = new FileHumanGateTaskStore(storeDir())
  const gate = gateOf(store)

  await assert.rejects(() => gate.gate('analyze', artifact('digest-A'), passedGate()), HumanGateWaitAbortedError)
  await store.create({
    gateTaskId: 'gate-other',
    projectId: 'demo',
    pipelineId: 'other-pipeline',
    stageId: 'analyze',
    artifactPath: ARTIFACT_PATH,
    machineStatus: 'passed',
    machineViolations: [],
    status: 'pending',
    artifactDigest: 'digest-A',
    expiresAt: Date.now() + 60_000,
  })

  await assert.rejects(() => gate.gate('analyze', artifact('digest-A'), passedGate()), HumanGateWaitAbortedError)
  const mine = (await tasksOf(store)).filter(task => task.pipelineId === 'p1')
  assert.equal(mine.length, 1, '不得把别的流水线的任务当成自己的门')
})
