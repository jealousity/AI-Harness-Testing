import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { apply as pipelinePlugin, type PipelinePluginConfig, type PipelineService } from '../src/plugin.ts'
import { FsArtifactStore } from '../src/stores/fs.ts'
import { computeArtifactDigest } from '../src/gates/machine.ts'
import type { SpawnRequest, SpawnedRun, StageSpawner } from '../src/stage-spawner.ts'
import type { HumanGatePort } from '../src/driver.ts'
import type { PipelineConfig, StageArtifact } from '../src/types.ts'
import { stageContent, executionSessionFor, type Content } from './fixtures.ts'

const FIXTURE_YAML = `
projectId: acme-pay-2026
projectType: api-service
templateVersion: v1
scaleTier: M
releasePolicy: { maxManualClaimedRatio: 0.3 }
stores:
  knowledge: { impl: markdown-fs, path: kb }
  cases: { impl: markdown-fs, path: cases }
  requirements: { primary: { impl: paste } }
stages: {}
`

let dir: string

test.beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'pp-plugin-'))
})

test.afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

/** 脚本替身 spawner：从上游产物生成符合契约的产物内容（G/R 规则全通过）。 */
class ScriptedSpawn implements StageSpawner {
  readonly calls: string[] = []
  private readonly artifacts: FsArtifactStore
  constructor(artifactsRoot: string) {
    this.artifacts = new FsArtifactStore(artifactsRoot)
  }
  async runStage(request: SpawnRequest, _cfg: PipelineConfig): Promise<SpawnedRun> {
    this.calls.push(request.stageId)
    // 读取传递性上游内容
    const upstreamContents: Record<string, Content> = {}
    for (const path of new Set(Object.values(request.inputPaths))) {
      const upstream = await this.artifacts.read(path)
      if (upstream !== null) upstreamContents[upstream.stageId] = upstream.content as Content
    }
    const content = stageContent(request.stageId, upstreamContents)
    const inputs: Record<string, string> = {}
    for (const [upstream, path] of Object.entries(request.inputPaths)) {
      const upstreamArtifact = await this.artifacts.read(path)
      inputs[upstream] = upstreamArtifact?.digest ?? 'missing-upstream'
    }
    const base: StageArtifact = {
      pipelineId: request.pipelineId,
      stageId: request.stageId,
      version: 1,
      inputs,
      content,
      digest: '',
      path: request.artifactPath,
    }
    await this.artifacts.write({ ...base, digest: computeArtifactDigest(base) })
    return { stageId: request.stageId, artifactPath: request.artifactPath }
  }
}

class ApprovingHuman implements HumanGatePort {
  readonly gates: string[] = []
  async gate(stageId: string): Promise<'approved'> {
    this.gates.push(stageId)
    return 'approved'
  }
  async gateFailed(): Promise<void> {}
}

async function boot(): Promise<{ ctx: Context; fiber: { dispose(): Promise<void> }; service: PipelineService; spawn: ScriptedSpawn; human: ApprovingHuman }> {
  const configPath = join(dir, 'pipeline.yaml')
  await writeFile(configPath, FIXTURE_YAML)
  const artifactsRoot = join(dir, 'artifacts')
  const checkpointRoot = join(dir, 'checkpoints')
  const spawn = new ScriptedSpawn(artifactsRoot)
  const human = new ApprovingHuman()
  const artifacts = new FsArtifactStore(artifactsRoot)
  const pluginConfig: PipelinePluginConfig = {
    configPath,
    artifactsRoot,
    checkpointRoot,
    spawner: spawn,
    human,
    // R4-08/09/10：从磁盘 design 产物生成合法执行会话
    execution: {
      load: async (stageId, _pipelineId) => {
        if (stageId !== 'execute') return undefined
        const design = await artifacts.read('artifacts/pipe-1/design.json')
        if (design === null) return undefined
        return executionSessionFor(design.content as unknown as { testCases: readonly { id: string }[] })
      },
    },
  }
  const ctx = new Context()
  const fiber = await ctx.plugin(pipelinePlugin, pluginConfig) as unknown as { dispose(): Promise<void> }
  const service = (ctx as unknown as { pipeline: PipelineService }).pipeline
  return { ctx, fiber, service, spawn, human }
}

test('plugin loads in a real cordis context and provides ctx.pipeline', async () => {
  const { fiber, service } = await boot()
  assert.equal(service.config.projectId, 'acme-pay-2026')
  assert.equal(service.config.stages.receive.gate.human.id, 'A')
  await fiber.dispose()
})

test('run drives all six stages, writing artifacts and checkpoint to disk', async () => {
  const { fiber, service, spawn, human } = await boot()
  const outcome = await service.run('pipe-1')
  assert.deepEqual(outcome, { outcome: 'completed' })
  assert.deepEqual(spawn.calls, ['receive', 'analyze', 'design', 'execute', 'report', 'archive'])
  assert.deepEqual(human.gates, ['receive', 'analyze', 'design', 'execute', 'report', 'archive'])

  // 磁盘产物（6 个）与检查点
  for (const stage of ['receive', 'analyze', 'design', 'execute', 'report', 'archive']) {
    const artifact = await readFile(join(dir, 'artifacts', 'artifacts', 'pipe-1', `${stage}.json`), 'utf8')
    assert.ok(JSON.parse(artifact).stageId === stage)
  }
  const checkpoint = JSON.parse(await readFile(join(dir, 'checkpoints', 'pipe-1', 'checkpoint.json'), 'utf8'))
  assert.equal(checkpoint.cursor, 6)
  assert.equal(checkpoint.stageStates.receive.status, 'done')
  await fiber.dispose()
})

test('reenter rolls back cursor and records reentry via the service', async () => {
  const { fiber, service, spawn } = await boot()
  await service.run('pipe-1')
  assert.equal(spawn.calls.length, 6)

  await service.reenter('pipe-1', 'analyze', 'tester', '版本影响遗漏')
  const checkpoint = JSON.parse(await readFile(join(dir, 'checkpoints', 'pipe-1', 'checkpoint.json'), 'utf8'))
  assert.equal(checkpoint.cursor, 1)
  assert.equal(checkpoint.stageStates.analyze.status, 'needs-reentry')
  assert.equal(checkpoint.stageStates.design.status, 'needs-reentry')
  assert.equal(checkpoint.stageStates.receive.status, 'done')
  assert.equal(checkpoint.reentries.length, 1)
  assert.equal(checkpoint.reentries[0].reason, '版本影响遗漏')

  // 续跑：analyze 起重跑，上游 receive 跳过
  await service.run('pipe-1')
  assert.equal(spawn.calls.filter(c => c === 'analyze').length, 2)
  assert.equal(spawn.calls.filter(c => c === 'receive').length, 1)
  await fiber.dispose()
})
