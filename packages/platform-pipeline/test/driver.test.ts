import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PipelineDriver, type ArtifactStore, type CheckpointPort, type HumanGatePort, type ReviewOutcome, type ReviewRunner } from '../src/driver.ts'
import { MachineGateEngine, computeArtifactDigest, type GateRule } from '../src/gates/machine.ts'
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

/** Mock spawn：生成通用产物写入内存库，记录调用（stageId + extraContext）。 */
class MockSpawn implements StageSpawner {
  readonly calls: Array<{ stageId: StageId; extraContext?: string }> = []
  private readonly artifacts: MemoryArtifacts
  constructor(artifacts: MemoryArtifacts) {
    this.artifacts = artifacts
  }
  async runStage(request: SpawnRequest, _cfg: PipelineConfig): Promise<SpawnedRun> {
    this.calls.push({ stageId: request.stageId, extraContext: request.extraContext })
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
