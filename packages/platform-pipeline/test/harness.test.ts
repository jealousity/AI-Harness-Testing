import { test } from 'node:test'
import assert from 'node:assert/strict'
import { toContentBlocks, toToolRestriction } from '../src/harness/index.ts'
import { HarnessStageSpawner } from '../src/harness/stage-spawner-harness.ts'
import type { HarnessSpawnerDeps } from '../src/harness/stage-spawner-harness.ts'
import type { PipelineConfig, ToolFilter } from '../src/types.ts'
import { normalizeConfig } from '../src/config.ts'

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

const parent: any = { id: 'parent-session' }
const signal = new AbortController().signal
const runReq = {
  stageId: 'receive' as const,
  pipelineId: 'pid',
  inputPaths: {},
  artifactPath: 'artifacts/pid/receive.json',
}

// mock subagents adapter（仅用于单测；类型为 any 以避开 harness 真实接口形状）
type MockSubagents = any

test('toContentBlocks wraps prompt as a text ContentBlock', () => {
  const blocks = toContentBlocks('# 阶段 receive')
  assert.equal(blocks.length, 1)
  const block = blocks[0] as { type: string; text?: string }
  assert.equal(block.type, 'text')
  assert.equal(block.text, '# 阶段 receive')
})

test('toToolRestriction maps allow/deny and omits undefined keys', () => {
  const filter: ToolFilter = { allow: ['kb_query', 'fs_read'], deny: ['kb_write'] }
  const restriction = toToolRestriction(filter)
  assert.deepEqual(restriction.allow, ['kb_query', 'fs_read'])
  assert.deepEqual(restriction.deny, ['kb_write'])
  assert.ok(restriction.allow !== undefined)

  const bare: ToolFilter = { deny: ['subagent'] }
  const bareRestriction = toToolRestriction(bare)
  assert.equal(bareRestriction.allow, undefined)
  assert.deepEqual(bareRestriction.deny, ['subagent'])
})

function deps(subagents: MockSubagents): HarnessSpawnerDeps {
  return { subagents, parent, signal, providerName: 'spawn' }
}

test('runStage one-shot awaits result and disposes the run', async () => {
  const calls: string[] = []
  const spawner = new HarnessStageSpawner(deps({
    start: async () => {
      calls.push('start')
      return {
        result: Promise.resolve({ stopReason: 'completed' as const }),
        dispose() { calls.push('dispose') },
      }
    },
  }))
  const out = await spawner.runStage(runReq, cfg())
  assert.deepEqual(out, { stageId: 'receive', artifactPath: 'artifacts/pid/receive.json' })
  assert.deepEqual(calls, ['start', 'dispose'])
})

test('runStage mode=continuable uses startContinuable, waits, and returns childId', async () => {
  const calls: string[] = []
  const spawner = new HarnessStageSpawner(deps({
    start: async () => { throw new Error('must not use one-shot') },
    startContinuable: async () => {
      calls.push('startContinuable')
      return { childId: 'child-1', messageId: 'msg-1' }
    },
    listChildren: async () => {
      calls.push('list')
      return [
        { kind: 'child', id: 'child-1', mode: 'continuable' as const, label: 'receive', activity: 'inactive' as const, hasChildren: false },
      ]
    },
  }))
  const out = await spawner.runStage({ ...runReq, mode: 'continuable' }, cfg())
  assert.deepEqual(out, { stageId: 'receive', artifactPath: 'artifacts/pid/receive.json', childId: 'child-1' })
  assert.deepEqual(calls, ['startContinuable', 'list'])
})

test('runStage mode=continuable degrades to one-shot when startContinuable is absent', async () => {
  const calls: string[] = []
  const spawner = new HarnessStageSpawner(deps({
    start: async () => {
      calls.push('start')
      return { result: Promise.resolve({ stopReason: 'completed' as const }), dispose() {} }
    },
  }))
  const out = await spawner.runStage({ ...runReq, mode: 'continuable' }, cfg())
  assert.equal(out.childId, undefined)
  assert.deepEqual(calls, ['start'])
})

test('waitContinuable polls listChildren until child activity turns inactive', async () => {
  const calls: string[] = []
  let listN = 0
  const spawner = new HarnessStageSpawner(deps({
    start: async () => ({ result: Promise.resolve({ stopReason: 'completed' as const }), dispose() {} }),
    listChildren: async () => {
      listN += 1
      calls.push('list')
      if (listN < 3) {
        return [{ kind: 'child', id: 'child-1', mode: 'continuable' as const, label: 'x', activity: 'running' as const, hasChildren: false }]
      }
      return [{ kind: 'child', id: 'child-1', mode: 'continuable' as const, label: 'x', activity: 'inactive' as const, hasChildren: false }]
    },
  }))
  await spawner.waitContinuable('child-1', signal)
  assert.equal(listN, 3)
  assert.deepEqual(calls, ['list', 'list', 'list'])
})

test('waitContinuable surfaces a diagnostic child as an error', async () => {
  const spawner = new HarnessStageSpawner(deps({
    start: async () => ({ result: Promise.resolve({ stopReason: 'completed' as const }), dispose() {} }),
    listChildren: async () => [
      { kind: 'diagnostic', id: 'child-1', reason: 'corrupt' as const },
    ],
  }))
  await assert.rejects(spawner.waitContinuable('child-1', signal), /diagnostic state/)
})

test('waitContinuable is a no-op when listChildren capability is absent', async () => {
  const spawner = new HarnessStageSpawner(deps({
    start: async () => ({ result: Promise.resolve({ stopReason: 'completed' as const }), dispose() {} }),
  }))
  await spawner.waitContinuable('child-1', signal)
})
