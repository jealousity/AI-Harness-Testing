import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { CallbackHumanGate, InMemoryToolRegistry, ScriptedStageRunner, executeTool } from '../src/runtime/index.ts'
import { PipelineDriver } from '../src/driver.ts'
import { normalizeConfig } from '../src/config.ts'
import { FsArtifactStore, FsCheckpointPort } from '../src/stores/fs.ts'
import { MachineGateEngine, platformGenericRules } from '../src/gates/machine.ts'
import { stageRules } from '../src/gates/stage-rules.ts'
import { pipelineContractSchemas } from '../src/contracts/schemas.ts'
import { stageContent, executionSessionFor, type Content } from './fixtures.ts'
import type { PipelineConfig, StageId } from '../src/types.ts'

let dir: string

test.beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'pp-runtime-'))
})

test.afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

function config(): PipelineConfig {
  return normalizeConfig({
    projectId: 'generic-runtime',
    projectType: 'api-service',
    templateVersion: 'v1',
    scaleTier: 'S',
    stores: {
      knowledge: { impl: 'markdown-fs', path: 'knowledge' },
      cases: { impl: 'markdown-fs', path: 'cases' },
      requirements: { primary: { impl: 'paste' } },
    },
    stages: {
      analyze: { review: { enabled: false } },
      design: { review: { enabled: false } },
      execute: { review: { enabled: false } },
      report: { review: { enabled: false } },
    },
  })
}

test('InMemoryToolRegistry enforces allow/deny without Harness', async () => {
  const tools = new InMemoryToolRegistry()
  tools.register({
    name: 'sum',
    description: 'sum numbers',
    async execute(args: { a: number; b: number }) { return args.a + args.b },
  })
  tools.register({
    name: 'secret',
    description: 'secret',
    async execute() { return 'hidden' },
  })
  const restricted = tools.restrict({ allow: ['sum'], deny: ['secret'] })
  assert.equal(await executeTool(restricted, 'sum', { a: 2, b: 3 }, { signal: new AbortController().signal }), 5)
  assert.equal(restricted.get('secret'), undefined)
  assert.throws(() => tools.restrict({ allow: ['missing'] }), /unknown tool/)
})

test('ScriptedStageRunner runs a complete PipelineDriver without Harness', async () => {
  const cfg = config()
  const artifacts = new FsArtifactStore(dir)
  const runner = new ScriptedStageRunner(artifacts, ({ request, upstream }) => stageContent(request.stageId, upstream as Readonly<Record<string, Content>>))
  const human = new CallbackHumanGate(({ stageId }) => {
    assert.ok(stageId)
    return 'approved'
  })
  const gates = new MachineGateEngine(
    [...platformGenericRules(pipelineContractSchemas()), ...stageRules({ maxManualClaimedRatio: cfg.releasePolicy.maxManualClaimedRatio })],
    cfg.templateVersion,
  )
  const driver = new PipelineDriver({
    cfg,
    pipelineId: 'generic-1',
    root: join(dir, 'checkpoints'),
    rulesetVersion: cfg.templateVersion,
    spawn: runner,
    gates,
    human,
    artifacts,
    checkpoint: new FsCheckpointPort(),
    execution: {
      load: async stageId => {
        if (stageId !== 'execute') return undefined
        const design = await artifacts.read('artifacts/generic-1/design.json')
        return design === null ? undefined : executionSessionFor(design.content as { testCases: readonly { id: string }[] }) as never
      },
    },
  })
  assert.deepEqual(await driver.run(), { outcome: 'completed' })
  const checkpoint = await new FsCheckpointPort().load(join(dir, 'checkpoints'))
  assert.equal(checkpoint?.cursor, 6)
  assert.equal(checkpoint?.stageStates.archive.status, 'done')
})
