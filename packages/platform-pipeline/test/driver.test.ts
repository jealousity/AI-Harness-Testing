import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PipelineDriver, type ArtifactStore, type CheckpointPort, type HumanGatePort, type ReviewOutcome, type ReviewRunner } from '../src/driver.ts'
import { MachineGateEngine, computeArtifactDigest, platformGenericRules, type GateRule } from '../src/gates/machine.ts'
import { initialCheckpoint } from '../src/checkpoint.ts'
import { normalizeConfig } from '../src/config.ts'
import { resolveStageAcl, type SpawnRequest, type SpawnedRun, type StageSpawner } from '../src/stage-spawner.ts'
import { STAGE_ORDER, type Checkpoint, type PipelineConfig, type StageArtifact, type StageId } from '../src/types.ts'

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

function cfg(): PipelineConfig {
  return normalizeConfig(BASE)
}

/** 内存产物库：spawn 写入，driver 读取。 */
class MemoryArtifacts implements ArtifactStore {
  readonly map = new Map<string, StageArtifact>()
  async read(path: string): Promise<StageArtifact | null> {
    return this.map.get(path) ?? null
  }
  put(artifact: StageArtifact): void {
    this.map.set(artifact.path, artifact)
  }
}

/** Mock spawn：生成通用产物写入内存库，记录调用（stageId + extraContext + inputDigests）。 */
class MockSpawn implements StageSpawner {
  readonly calls: Array<{ stageId: StageId; extraContext?: string; inputDigests?: Readonly<Record<string, string>> }> = []
  private readonly artifacts: MemoryArtifacts
  constructor(artifacts: MemoryArtifacts) {
    this.artifacts = artifacts
  }
  async runStage(request: SpawnRequest, _cfg: PipelineConfig): Promise<SpawnedRun> {
    this.calls.push({ stageId: request.stageId, extraContext: request.extraContext, inputDigests: request.inputDigests })
    const artifact: StageArtifact = {
      pipelineId: request.pipelineId,
      stageId: request.stageId,
      version: 1,
      inputs: Object.fromEntries(Object.entries(request.inputPaths).map(([up]) => [up, 'upstream-digest'])),
      content: { ok: true },
      digest: '',
      path: request.artifactPath,
    }
    this.artifacts.put({ ...artifact, digest: computeArtifactDigest(artifact) })
    return { stageId: request.stageId, artifactPath: request.artifactPath }
  }
}

/** 内存检查点端口。 */
class MemoryCheckpoint implements CheckpointPort {
  value: Checkpoint | null = null
  async load(_root: string): Promise<Checkpoint | null> {
    return this.value
  }
  async save(_root: string, cp: Checkpoint): Promise<void> {
    this.value = cp
  }
}

/** 可编排的人工门端口。 */
class ScriptedHuman implements HumanGatePort {
  readonly calls: Array<{ stageId: StageId; decision: string }> = []
  decisions = new Map<StageId, 'approved' | 'changes-needed' | 'rejected' | 'scripted'>()
  /** 每次调用后按顺序消费的脚本；空则默认 approved。 */
  script: Array<{ stageId: StageId; decision: 'approved' | 'changes-needed' | 'rejected' }> = []
  gateFailedCalls: StageId[] = []
  async gate(stageId: StageId): Promise<'approved' | 'changes-needed' | 'rejected'> {
    const idx = this.script.findIndex(entry => entry.stageId === stageId)
    const decision = idx >= 0 ? this.script.splice(idx, 1)[0]!.decision : 'approved'
    this.calls.push({ stageId, decision })
    return decision
  }
  async gateFailed(stageId: StageId): Promise<void> {
    this.gateFailedCalls.push(stageId)
  }
}

/** 可编排的交叉检查端口。 */
class ScriptedReview implements ReviewRunner {
  verdicts = new Map<StageId, ReviewOutcome>()
  calls: StageId[] = []
  async run(stageId: StageId): Promise<ReviewOutcome> {
    this.calls.push(stageId)
    return this.verdicts.get(stageId) ?? { verdict: 'pass', findings: [] }
  }
}

function engine(rules: readonly GateRule[] = []): MachineGateEngine {
  return new MachineGateEngine(rules, 'rules-v1')
}

function harness(): {
  driver: PipelineDriver
  artifacts: MemoryArtifacts
  spawn: MockSpawn
  human: ScriptedHuman
  review: ScriptedReview
  cp: MemoryCheckpoint
} {
  const artifacts = new MemoryArtifacts()
  const spawn = new MockSpawn(artifacts)
  const human = new ScriptedHuman()
  const review = new ScriptedReview()
  const cp = new MemoryCheckpoint()
  const driver = new PipelineDriver({
    cfg: cfg(),
    pipelineId: 'pipe-1',
    root: 'artifacts/pipe-1',
    rulesetVersion: 'rules-v1',
    spawn,
    gates: engine(),
    human,
    artifacts,
    checkpoint: cp,
    review,
  })
  return { driver, artifacts, spawn, human, review, cp }
}

test('happy path: all six stages spawn in order and cursor completes', async () => {
  const { driver, spawn, cp } = harness()
  const outcome = await driver.run()
  assert.deepEqual(outcome, { outcome: 'completed' })
  assert.deepEqual(spawn.calls.map(c => c.stageId), [...STAGE_ORDER])
  assert.equal(cp.value?.cursor, 6)
  assert.equal(spawn.calls.every(c => c.extraContext === undefined), true)
})

test('gate fail retries: violations feed back via extraContext, then passes', async () => {
  const artifacts = new MemoryArtifacts()
  const spawn = new MockSpawn(artifacts)
  const human = new ScriptedHuman()
  let failures = 0
  const flaky: GateRule = {
    id: 'R-fake', level: 'BLOCKING', stages: ['analyze'],
    judge: () => {
      failures += 1
      return failures <= 1
        ? [{ rule: 'R-fake', level: 'BLOCKING', detail: 'fake violation', at: Date.now() }]
        : []
    },
  }
  const d = new PipelineDriver({
    cfg: cfg(), pipelineId: 'pipe-1', root: 'artifacts/pipe-1', rulesetVersion: 'v1',
    spawn, gates: engine([flaky]), human,
    artifacts, checkpoint: new MemoryCheckpoint(), review: undefined,
  })
  const outcome = await d.run()
  assert.deepEqual(outcome, { outcome: 'completed' })
  const analyzeCalls = spawn.calls.filter(c => c.stageId === 'analyze')
  assert.equal(analyzeCalls.length, 2)
  assert.ok(analyzeCalls[1]?.extraContext?.includes('机器门禁判定未通过'))
  assert.ok(analyzeCalls[1]?.extraContext?.includes('R-fake'))
  assert.equal(human.gateFailedCalls.length, 0)
})

test('gate fail exhaust: after max retries escalates to human gateFailed', async () => {
  const artifacts = new MemoryArtifacts()
  const spawn = new MockSpawn(artifacts)
  const human = new ScriptedHuman()
  const always: GateRule = {
    id: 'R-always', level: 'BLOCKING', stages: ['design'],
    judge: () => [{ rule: 'R-always', level: 'BLOCKING', detail: 'always', at: Date.now() }],
  }
  const d = new PipelineDriver({
    cfg: cfg(), pipelineId: 'pipe-1', root: 'artifacts/pipe-1', rulesetVersion: 'v1',
    spawn, gates: engine([always]), human,
    artifacts, checkpoint: new MemoryCheckpoint(), review: undefined,
  })
  const outcome = await d.run()
  assert.deepEqual(outcome, { outcome: 'gate-failed', stageId: 'design' })
  assert.deepEqual(human.gateFailedCalls, ['design'])
  assert.equal(spawn.calls.filter(c => c.stageId === 'design').length, 3) // 初始 + 2 次重试
})

test('human rejected stops the pipeline', async () => {
  const { driver, spawn, human, cp } = harness()
  human.script = [{ stageId: 'report', decision: 'rejected' }]
  const outcome = await driver.run()
  assert.deepEqual(outcome, { outcome: 'rejected', stageId: 'report' })
  assert.ok(!spawn.calls.some(c => c.stageId === 'archive'))
  assert.equal(cp.value?.stageStates.report.status, 'awaiting-gate')
})

test('changes-needed re-runs the stage then approves', async () => {
  const artifacts = new MemoryArtifacts()
  const spawn = new MockSpawn(artifacts)
  const h = new ScriptedHuman()
  h.script = [
    { stageId: 'analyze', decision: 'changes-needed' },
  ]
  const d = new PipelineDriver({
    cfg: cfg(), pipelineId: 'pipe-1', root: 'artifacts/pipe-1', rulesetVersion: 'v1',
    spawn, gates: engine(), human: h,
    artifacts, checkpoint: new MemoryCheckpoint(), review: undefined,
  })
  const outcome = await d.run()
  assert.deepEqual(outcome, { outcome: 'completed' })
  assert.equal(spawn.calls.filter(c => c.stageId === 'analyze').length, 2)
})

test('review fail retries once with findings fed back, then passes', async () => {
  const artifacts = new MemoryArtifacts()
  const spawn = new MockSpawn(artifacts)
  const review = new ScriptedReview()
  let first = true
  review.verdicts.set('analyze', { verdict: 'fail', findings: ['版本影响遗漏 v2.1'] })
  const d = new PipelineDriver({
    cfg: cfg(), pipelineId: 'pipe-1', root: 'artifacts/pipe-1', rulesetVersion: 'v1',
    spawn, gates: engine(), human: new ScriptedHuman(),
    artifacts, checkpoint: new MemoryCheckpoint(), review: {
      async run(stageId) {
        if (stageId === 'analyze' && first) { first = false; return review.verdicts.get(stageId)! }
        return { verdict: 'pass', findings: [] }
      },
    },
  })
  const outcome = await d.run()
  assert.deepEqual(outcome, { outcome: 'completed' })
  const analyzeCalls = spawn.calls.filter(c => c.stageId === 'analyze')
  assert.equal(analyzeCalls.length, 2)
  assert.ok(analyzeCalls[1]?.extraContext?.includes('交叉检查未通过'))
  assert.ok(analyzeCalls[1]?.extraContext?.includes('版本影响遗漏'))
})

test('review fail twice escalates to review-failed', async () => {
  const artifacts = new MemoryArtifacts()
  const spawn = new MockSpawn(artifacts)
  const d = new PipelineDriver({
    cfg: cfg(), pipelineId: 'pipe-1', root: 'artifacts/pipe-1', rulesetVersion: 'v1',
    spawn, gates: engine(), human: new ScriptedHuman(),
    artifacts, checkpoint: new MemoryCheckpoint(),
    review: { async run() { return { verdict: 'fail', findings: ['x'] } } },
  })
  const outcome = await d.run()
  assert.deepEqual(outcome, { outcome: 'review-failed', stageId: 'analyze' })
  assert.equal(spawn.calls.filter(c => c.stageId === 'analyze').length, 2) // 初始 + 1 次重试
})

test('review degraded records flag and proceeds', async () => {
  const artifacts = new MemoryArtifacts()
  const review = new ScriptedReview()
  review.verdicts.set('analyze', { verdict: 'degraded', findings: [] })
  const d = new PipelineDriver({
    cfg: cfg(), pipelineId: 'pipe-1', root: 'artifacts/pipe-1', rulesetVersion: 'v1',
    spawn: new MockSpawn(artifacts), gates: engine(), human: new ScriptedHuman(),
    artifacts, checkpoint: new MemoryCheckpoint(), review,
  })
  const outcome = await d.run()
  assert.deepEqual(outcome, { outcome: 'completed' })
})

test('reenter receive after upstream change: cascade re-locks inputs and completes (no G-08 deadlock)', async () => {
  // receive 重跑时内容变化（模拟需求变更）→ digest 变化 → 下游必须重新锁定而非被旧锁永久 BLOCKING
  const artifacts = new MemoryArtifacts()
  const calls: StageId[] = []
  let receiveRound = 0
  const spawn: StageSpawner = {
    async runStage(request: SpawnRequest): Promise<SpawnedRun> {
      calls.push(request.stageId)
      if (request.stageId === 'receive') receiveRound += 1
      const content = request.stageId === 'receive' ? { ok: true, round: receiveRound } : { ok: true }
      const artifact: StageArtifact = {
        pipelineId: request.pipelineId, stageId: request.stageId, version: 1,
        inputs: {}, content, digest: '', path: request.artifactPath,
      }
      artifacts.put({ ...artifact, digest: computeArtifactDigest(artifact) })
      return { stageId: request.stageId, artifactPath: request.artifactPath }
    },
  }
  const cp = new MemoryCheckpoint()
  const gates = new MachineGateEngine(
    platformGenericRules({}).filter(r => r.id === 'G-08'),
    'rules-v1',
  )
  const driver = new PipelineDriver({
    cfg: cfg(), pipelineId: 'pipe-1', root: 'artifacts/pipe-1', rulesetVersion: 'rules-v1',
    spawn, gates, human: new ScriptedHuman(), artifacts, checkpoint: cp,
    review: undefined,
  })

  assert.deepEqual(await driver.run(), { outcome: 'completed' })
  const firstReceiveDigest = cp.value?.stageStates.receive.digest
  assert.ok(firstReceiveDigest !== undefined && firstReceiveDigest !== '')

  await driver.reenter('receive', 'tester', '需求变更')
  // 重入解锁：下游输入锁清零、机器门禁归零（重跑时按当前上游重新锁定）
  assert.deepEqual(cp.value?.stageStates.analyze.inputs, {})
  assert.equal(cp.value?.stageStates.analyze.gate.machine.violations.length, 0)
  assert.deepEqual(cp.value?.stageStates.receive.inputs, {})

  assert.deepEqual(await driver.run(), { outcome: 'completed' })
  // receive 重跑后 digest 变化（内容变了）
  const newReceiveDigest = cp.value?.stageStates.receive.digest
  assert.notEqual(newReceiveDigest, firstReceiveDigest)
  // analyze 已重新锁定到 receive 的新 digest（G-08 通过 = 级联重跑完成）
  assert.equal(cp.value?.stageStates.analyze.inputs.receive, newReceiveDigest)
  // design 锁定到 analyze 的库内 digest（wrapContent 口径：inputs 待宿主填充）
  const analyzeStored = artifacts.map.get(cp.value!.stageStates.analyze.artifact)
  assert.equal(cp.value?.stageStates.design.inputs.analyze, analyzeStored?.digest)
  // 全部六阶段重跑
  assert.equal(calls.length, 12)
  // 旧 digest 归档进 history（docs/03 第 8.4 节）
  assert.ok((cp.value?.stageStates.analyze.history.length ?? 0) >= 1)
})

test('reenter rolls back cursor, marks downstream needs-reentry, and resumes', async () => {
  const { driver, spawn, cp } = harness()
  assert.deepEqual(await driver.run(), { outcome: 'completed' })
  assert.equal(spawn.calls.length, 6)

  await driver.reenter('analyze', 'tester', '版本影响遗漏')
  assert.equal(cp.value?.cursor, 1)
  assert.equal(cp.value?.stageStates.analyze.status, 'needs-reentry')
  assert.equal(cp.value?.stageStates.design.status, 'needs-reentry')
  assert.equal(cp.value?.stageStates.receive.status, 'done') // 上游不受影响
  assert.equal(cp.value?.reentries.length, 1)
  assert.equal(cp.value?.reentries[0]?.reason, '版本影响遗漏')

  // 续跑：analyze 起重新处理
  await driver.run()
  const analyzeCalls = spawn.calls.filter(c => c.stageId === 'analyze')
  assert.equal(analyzeCalls.length, 2)
  assert.ok(analyzeCalls[1]?.extraContext?.includes('重入'))
  assert.equal(cp.value?.cursor, 6)
  assert.equal(cp.value?.stageStates.analyze.status, 'done')
})

test('resume reuses an existing continuable child instead of re-spawning (验证点 5)', async () => {
  const artifacts = new MemoryArtifacts()

  /** 记录 runStage（重新 spawn）与 waitContinuable（复用既有 child）调用。 */
  class DedupSpawn implements StageSpawner {
    readonly calls: StageId[] = []
    readonly waits: string[] = []
    async runStage(request: SpawnRequest): Promise<SpawnedRun> {
      this.calls.push(request.stageId)
      const artifact: StageArtifact = {
        pipelineId: request.pipelineId, stageId: request.stageId, version: 1,
        inputs: {}, content: { ok: true }, digest: '', path: request.artifactPath,
      }
      artifacts.put({ ...artifact, digest: computeArtifactDigest(artifact) })
      return request.mode === 'continuable'
        ? { stageId: request.stageId, artifactPath: request.artifactPath, childId: `child-${request.stageId}` }
        : { stageId: request.stageId, artifactPath: request.artifactPath }
    }
    async waitContinuable(childId: string): Promise<void> {
      this.waits.push(childId)
      const artifact: StageArtifact = {
        pipelineId: 'pipe-1', stageId: 'execute', version: 1,
        inputs: {}, content: { ok: true }, digest: '', path: 'artifacts/pipe-1/execute.json',
      }
      artifacts.put({ ...artifact, digest: computeArtifactDigest(artifact) })
    }
  }

  const spawn = new DedupSpawn()
  const human = new ScriptedHuman()
  const cp = new MemoryCheckpoint()
  // 模拟「execute 已 startContinuable 但父进程崩溃」：cursor 停在 execute，childSessionId 已持久化，状态仍 idle
  const base = initialCheckpoint('pipe-1', 'v1', 'rules-v1')
  cp.value = {
    ...base,
    cursor: 3,
    stageStates: { ...base.stageStates, execute: { ...base.stageStates.execute, childSessionId: 'child-execute' } },
  }
  const d = new PipelineDriver({
    cfg: cfg(), pipelineId: 'pipe-1', root: 'artifacts/pipe-1', rulesetVersion: 'v1',
    spawn, gates: engine(), human, artifacts, checkpoint: cp, review: undefined,
  })

  const outcome = await d.run()
  assert.deepEqual(outcome, { outcome: 'completed' })
  // execute 走复用，未重新 spawn；下游 report/archive 正常 one-shot spawn
  assert.deepEqual(spawn.calls, ['report', 'archive'])
  assert.deepEqual(spawn.waits, ['child-execute'])
})

test('needs-reentry re-spawns even when a prior childSessionId exists', async () => {
  const artifacts = new MemoryArtifacts()
  class DedupSpawn implements StageSpawner {
    readonly calls: StageId[] = []
    readonly waits: string[] = []
    async runStage(request: SpawnRequest): Promise<SpawnedRun> {
      this.calls.push(request.stageId)
      const artifact: StageArtifact = {
        pipelineId: request.pipelineId, stageId: request.stageId, version: 1,
        inputs: {}, content: { ok: true }, digest: '', path: request.artifactPath,
      }
      artifacts.put({ ...artifact, digest: computeArtifactDigest(artifact) })
      return request.mode === 'continuable'
        ? { stageId: request.stageId, artifactPath: request.artifactPath, childId: `child-${request.stageId}` }
        : { stageId: request.stageId, artifactPath: request.artifactPath }
    }
    async waitContinuable(childId: string): Promise<void> {
      this.waits.push(childId)
    }
  }
  const spawn = new DedupSpawn()
  const human = new ScriptedHuman()
  const cp = new MemoryCheckpoint()
  const base = initialCheckpoint('pipe-1', 'v1', 'rules-v1')
  cp.value = {
    ...base,
    cursor: 3,
    stageStates: {
      ...base.stageStates,
      execute: { ...base.stageStates.execute, status: 'needs-reentry', childSessionId: 'child-execute' },
    },
  }
  const d = new PipelineDriver({
    cfg: cfg(), pipelineId: 'pipe-1', root: 'artifacts/pipe-1', rulesetVersion: 'v1',
    spawn, gates: engine(), human, artifacts, checkpoint: cp, review: undefined,
  })

  const outcome = await d.run()
  assert.deepEqual(outcome, { outcome: 'completed' })
  // 重入 = 全新生命周期：必须重新 spawn，不得复用旧 child
  assert.deepEqual(spawn.calls, ['execute', 'report', 'archive'])
  assert.deepEqual(spawn.waits, [])
  assert.equal(cp.value?.stageStates.execute.childSessionId, 'child-execute')
})

/**
 * 模拟真实磁盘存储语义：只存 content，读回时以 inputs={} 重建 wrapper
 * （与 FsArtifactStore.wrapContent 一致）。用于暴露「digest 跨持久化/重载漂移」缺陷。
 */
class DiskLikeArtifacts implements ArtifactStore {
  readonly content = new Map<string, unknown>()
  async read(path: string): Promise<StageArtifact | null> {
    if (!this.content.has(path)) return null
    const segments = path.split('/')
    const stageId = (segments.pop() ?? '').replace(/\.json$/, '')
    const pipelineId = segments.pop() ?? 'unknown'
    const base: StageArtifact = {
      pipelineId, stageId: stageId as StageId, version: 1, inputs: {},
      content: this.content.get(path), digest: '', path,
    }
    return { ...base, digest: computeArtifactDigest(base) }
  }
}

test('driver 向 spawn 注入上游权威 digest（agent 无哈希工具，只能原样抄写）', async () => {
  const { driver, spawn, cp } = harness()
  await driver.run()

  const analyze = spawn.calls.find(c => c.stageId === 'analyze')
  const persistedReceive = cp.value?.stageStates.receive.digest
  assert.ok(persistedReceive !== undefined && persistedReceive !== '')
  assert.equal(analyze?.inputDigests?.receive, persistedReceive, 'analyze 应收到 receive 的权威 digest')

  // receive 无上游：不得注入任何 digest（空对象，不是缺省 undefined）
  const receive = spawn.calls.find(c => c.stageId === 'receive')
  assert.deepEqual(receive?.inputDigests, {})

  // archive 是末级：应拿到上游全部（传递性）权威 digest，不含未产出的阶段
  const archive = spawn.calls.find(c => c.stageId === 'archive')
  assert.deepEqual(
    Object.keys(archive?.inputDigests ?? {}).sort(),
    ['analyze', 'design', 'execute', 'receive', 'report'],
  )
})

test('上游 digest 与机器门禁同源：注入值 == 门禁读盘重算值（注入不得另立口径）', async () => {
  const artifacts = new DiskLikeArtifacts()
  const cp = new MemoryCheckpoint()
  const seen: Array<{ stage: StageId; upstream: string; digest: string }> = []
  const capture: GateRule = {
    id: 'CAPTURE', level: 'WARNING', stages: 'all',
    judge: ({ stageId, upstreams }) => {
      for (const [up, art] of Object.entries(upstreams)) {
        seen.push({ stage: stageId, upstream: up, digest: art.digest })
      }
      return []
    },
  }
  const spawn: StageSpawner = {
    async runStage(request: SpawnRequest): Promise<SpawnedRun> {
      artifacts.content.set(request.artifactPath, { ok: true, stage: request.stageId })
      return { stageId: request.stageId, artifactPath: request.artifactPath }
    },
  }
  const d = new PipelineDriver({
    cfg: cfg(), pipelineId: 'pipe-1', root: 'artifacts/pipe-1', rulesetVersion: 'v1',
    spawn, gates: engine([capture]), human: new ScriptedHuman(), artifacts, checkpoint: cp, review: undefined,
  })

  assert.deepEqual(await d.run(), { outcome: 'completed' })

  // 门禁判定 design 时看到的上游 analyze digest
  const gateSaw = seen.find(r => r.stage === 'design' && r.upstream === 'analyze')
  assert.ok(gateSaw !== undefined, 'design 门禁应看到 analyze 上游')
  assert.notEqual(gateSaw.digest, '')

  const analyzePath = cp.value?.stageStates.analyze.artifact
  const analyzeRead = await artifacts.read(analyzePath!)
  assert.equal(
    gateSaw.digest, analyzeRead?.digest,
    '门禁必须用读盘重算值（磁盘内容变 → digest 变，可检出事后改文件）',
  )
  assert.notEqual(
    gateSaw.digest, cp.value?.stageStates.analyze.digest,
    '门禁不得盲信检查点冻结的 digest，否则丧失篡改检测（docs/08 digest 可重算）',
  )
})

test('注入给下一个阶段的 digest 就是门禁将要重算的那个值（prompt 与门禁同源）', async () => {
  const artifacts = new DiskLikeArtifacts()
  const cp = new MemoryCheckpoint()
  const seen: Array<{ stage: StageId; upstream: string; digest: string }> = []
  const captured: Array<{ stage: StageId; inputDigests?: Readonly<Record<string, string>> }> = []
  const capture: GateRule = {
    id: 'CAPTURE', level: 'WARNING', stages: 'all',
    judge: ({ stageId, upstreams }) => {
      for (const [up, art] of Object.entries(upstreams)) seen.push({ stage: stageId, upstream: up, digest: art.digest })
      return []
    },
  }
  const spawn: StageSpawner = {
    async runStage(request: SpawnRequest): Promise<SpawnedRun> {
      captured.push({ stage: request.stageId, inputDigests: request.inputDigests })
      artifacts.content.set(request.artifactPath, { ok: true, stage: request.stageId })
      return { stageId: request.stageId, artifactPath: request.artifactPath }
    },
  }
  const d = new PipelineDriver({
    cfg: cfg(), pipelineId: 'pipe-1', root: 'artifacts/pipe-1', rulesetVersion: 'v1',
    spawn, gates: engine([capture]), human: new ScriptedHuman(), artifacts, checkpoint: cp, review: undefined,
  })

  assert.deepEqual(await d.run(), { outcome: 'completed' })

  // analyze 收到的注入值，必须等于门禁判定 analyze 时对 receive 的重算值
  const injected = captured.find(c => c.stage === 'analyze')?.inputDigests?.receive
  const gateSawReceive = seen.find(r => r.stage === 'analyze' && r.upstream === 'receive')?.digest
  assert.ok(injected !== undefined && injected !== '')
  assert.equal(injected, gateSawReceive, '注入值与门禁重算值必须一致，否则 agent 抄写的锁必然与门禁对不上')
})

/**
 * 原始 JSON 字符串库：read 时真解析（模拟 FsArtifactStore——坏 JSON 抛 SyntaxError）。
 */
class RawJsonArtifacts implements ArtifactStore {
  readonly raw = new Map<string, string>()
  setJson(path: string, content: unknown): void {
    this.raw.set(path, JSON.stringify(content))
  }
  async read(path: string): Promise<StageArtifact | null> {
    const text = this.raw.get(path)
    if (text === undefined) return null
    const parsed = JSON.parse(text) as Record<string, unknown>
    const segments = path.split('/')
    const stageId = (segments[segments.length - 1] ?? '').replace(/\.json$/, '') as StageId
    return {
      pipelineId: segments[1] ?? 'pipe-1',
      stageId,
      version: 1,
      path,
      content: (parsed['content'] ?? parsed) as never,
      inputs: {},
      digest: 'digest-0',
    } as StageArtifact
  }
}

/**
 * 回归：产物损坏（非法 JSON）必须走「阶段失败 → 回喂重做」路径，
 * 而不是让整条流水线以一句 SyntaxError 崩掉。
 * 实测踩到：execute 阶段 agent 在字符串里嵌了未转义双引号，产物非法 JSON，
 * 旧行为直接打断整个 run —— 既没重试、也没走到人工门。
 */
test('产物非法 JSON：按阶段失败重试并回喂解析错误，重做成功后继续', async () => {
  const artifacts = new RawJsonArtifacts()
  const cp = new MemoryCheckpoint()
  const seenViolations: string[] = []
  let receiveAttempts = 0
  const spawn: StageSpawner = {
    async runStage(request: SpawnRequest): Promise<SpawnedRun> {
      if (request.stageId === 'receive') {
        receiveAttempts += 1
        if (request.previousViolations !== undefined) {
          seenViolations.push(...request.previousViolations.map(v => v.detail))
        }
        // 第一次写坏 JSON（模拟未转义引号），第二次写合法 JSON
        if (receiveAttempts === 1) {
          artifacts.raw.set(request.artifactPath, '{"requirements":[{"id":"R-1","text":"含 "裸引号" 的值"}]}')
        } else {
          artifacts.setJson(request.artifactPath, { requirements: [{ id: 'R-1', text: 'ok' }] })
        }
      } else {
        artifacts.setJson(request.artifactPath, { ok: true, stage: request.stageId })
      }
      return { stageId: request.stageId, artifactPath: request.artifactPath }
    },
  }
  const d = new PipelineDriver({
    cfg: cfg(), pipelineId: 'pipe-1', root: 'artifacts/pipe-1', rulesetVersion: 'v1',
    spawn, gates: engine([]), human: new ScriptedHuman(), artifacts, checkpoint: cp, review: undefined,
  })

  assert.deepEqual(await d.run(), { outcome: 'completed' })
  assert.equal(receiveAttempts, 2, '坏产物必须触发一次重做')
  assert.ok(
    seenViolations.some(v => /不是合法 JSON/.test(v)),
    `重做时必须回喂解析错误，实际回喂：${JSON.stringify(seenViolations)}`,
  )
})

test('产物非法 JSON 且重试耗尽：升级到人工 gateFailed，而不是崩掉', async () => {
  const artifacts = new RawJsonArtifacts()
  const cp = new MemoryCheckpoint()
  const human = new ScriptedHuman()
  const spawn: StageSpawner = {
    async runStage(request: SpawnRequest): Promise<SpawnedRun> {
      artifacts.raw.set(request.artifactPath, '{"broken": "裸 "引号" 值"}')
      return { stageId: request.stageId, artifactPath: request.artifactPath }
    },
  }
  const d = new PipelineDriver({
    cfg: cfg(), pipelineId: 'pipe-1', root: 'artifacts/pipe-1', rulesetVersion: 'v1',
    spawn, gates: engine([]), human, artifacts, checkpoint: cp, review: undefined,
  })

  const outcome = await d.run()
  assert.equal(outcome.outcome, 'gate-failed')
  assert.equal(outcome.stageId, 'receive')
  assert.ok(human.gateFailedCalls.includes('receive'), '重试耗尽必须走人工门 gateFailed')
})

/**
 * 人工门等待中重启（可恢复人工门的前置条件）。
 *
 * 场景：进程在 `awaiting-gate` 状态退出（rejected 会保留该状态），运维裁决后重新 run。
 * 必须**复用既有产物**直接回到门禁+人工门，而不是重新 spawn：
 * 重新 spawn 会重复消耗模型预算，并把真人正在审核的那份产物替换成新版本。
 */
test('人工门等待中重启：复用既有产物，不重新 spawn、不重跑交叉检查', async () => {
  const artifacts = new MemoryArtifacts()
  const spawn = new MockSpawn(artifacts)
  const human = new ScriptedHuman()
  const review = new ScriptedReview()
  const cp = new MemoryCheckpoint()
  const driver = new PipelineDriver({
    cfg: cfg(), pipelineId: 'pipe-1', root: 'artifacts/pipe-1', rulesetVersion: 'v1',
    spawn, gates: engine(), human, artifacts, checkpoint: cp, review,
  })

  human.script = [{ stageId: 'report', decision: 'rejected' }]
  assert.deepEqual(await driver.run(), { outcome: 'rejected', stageId: 'report' })
  assert.equal(cp.value?.stageStates.report.status, 'awaiting-gate')

  const spawnedBefore = spawn.calls.length
  const reportReviewsBefore = review.calls.filter(id => id === 'report').length

  // 裁决改为通过后重跑：应当从该门续上，而不是重做 report
  human.script = []
  assert.deepEqual(await driver.run(), { outcome: 'completed' })
  assert.equal(spawn.calls.filter(c => c.stageId === 'report').length, 1, '不得重新 spawn report')
  assert.deepEqual(
    spawn.calls.slice(spawnedBefore).map(c => c.stageId), ['archive'],
    '续跑只应继续推进下游，不得重做已停在门上的阶段',
  )
  assert.equal(
    review.calls.filter(id => id === 'report').length, reportReviewsBefore,
    '审核结论已随人工门任务持久化，续跑不得重复盲审',
  )
  assert.equal(cp.value?.stageStates.report.status, 'done')
})

test('门等待中重启但产物已丢失：回退到重新生成', async () => {
  const artifacts = new MemoryArtifacts()
  const spawn = new MockSpawn(artifacts)
  const human = new ScriptedHuman()
  const cp = new MemoryCheckpoint()
  const driver = new PipelineDriver({
    cfg: cfg(), pipelineId: 'pipe-1', root: 'artifacts/pipe-1', rulesetVersion: 'v1',
    spawn, gates: engine(), human, artifacts, checkpoint: cp, review: undefined,
  })

  human.script = [{ stageId: 'report', decision: 'rejected' }]
  assert.deepEqual(await driver.run(), { outcome: 'rejected', stageId: 'report' })

  const reportPath = cp.value!.stageStates.report.artifact
  artifacts.map.delete(reportPath)

  human.script = []
  assert.deepEqual(await driver.run(), { outcome: 'completed' })
  assert.equal(
    spawn.calls.filter(c => c.stageId === 'report').length, 2,
    '产物不可读时必须回退到重新 spawn，而不是拿空产物过门禁',
  )
})
