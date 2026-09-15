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

/**
 * 回归：subagents 服务的方法**必须带接收者调用**。
 *
 * 真实 SubagentService.startContinuable 内部是 `this.requireContinuations()`，
 * 一旦像 `const f = ops.startContinuable; f(spec)` 这样解构后调用，this 丢失，
 * 报 "Cannot read properties of undefined (reading 'requireContinuations')"。
 * 已在真实 GUI 宿主实测到该失败。
 *
 * 既有 mock 用箭头函数，天然不依赖 this —— 所以这类 bug 漏网。这里改用
 * **依赖 this 的类方法**当 mock，脱离接收者调用必然失败。
 */
class ServiceLikeSubagents {
  readonly calls: string[] = []
  #ready = true

  private requireReady(): boolean {
    if (!this.#ready) throw new Error('service not ready')
    return true
  }

  async startContinuable(spec: { provider: string }): Promise<{ childId: string }> {
    this.requireReady() // 解构调用会在此处因 this === undefined 而抛错
    this.calls.push(`startContinuable:${spec.provider}`)
    return { childId: 'child-1' }
  }

  async listChildren(parentSessionId: string, _signal?: AbortSignal): Promise<unknown[]> {
    this.requireReady()
    this.calls.push(`listChildren:${parentSessionId}`)
    return [{ id: 'child-1', kind: 'child', activity: 'inactive' }]
  }

  async start(): Promise<never> {
    this.requireReady()
    throw new Error('must not use one-shot for continuable mode')
  }
}

test('mode=continuable 带接收者调用 startContinuable（解构会丢 this 而失败）', async () => {
  const service = new ServiceLikeSubagents()
  const spawner = new HarnessStageSpawner(deps(service))
  const out = await spawner.runStage({ ...runReq, mode: 'continuable' }, cfg())
  assert.equal(out.childId, 'child-1')
  assert.deepEqual(service.calls, ['startContinuable:spawn', 'listChildren:parent-session'])
})

test('waitContinuable 带接收者调用 listChildren（解构会丢 this 而失败）', async () => {
  const service = new ServiceLikeSubagents()
  const spawner = new HarnessStageSpawner(deps(service))
  await spawner.waitContinuable('child-1', signal)
  assert.deepEqual(service.calls, ['listChildren:parent-session'])
})

test('服务方法若被解构则会失败——反证上面的约束真的起作用', async () => {
  const service = new ServiceLikeSubagents()
  const unbound = service.startContinuable // 故意解构
  await assert.rejects(
    () => unbound({ provider: 'spawn' }),
    /Cannot read properties of undefined/,
    'mock 必须真的依赖 this，否则这条回归测试是空的',
  )
})
