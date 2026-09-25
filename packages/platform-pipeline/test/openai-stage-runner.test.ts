import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { OpenAIStageRunner } from '../src/runtime/openai-stage-runner.ts'
import { InMemoryToolRegistry } from '../src/runtime/tool-registry.ts'
import { FsArtifactStore } from '../src/stores/fs.ts'
import { normalizeConfig } from '../src/config.ts'
import { StageBudgetExceededError, type UsageRecordInput, type UsageSink } from '../src/usage.ts'
import type { LlmClient, LlmMessage, LlmResponse } from '../src/runtime/ports.ts'

let dir: string

test.beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'pp-agent-runner-')) })
test.afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

/** 阶段配置覆盖（`stages` 按阶段浅合并，未声明的阶段仍走默认）。 */
function config(stages: Record<string, unknown> = {}) {
  return normalizeConfig({
    projectId: 'agent-runtime', projectType: 'api-service', templateVersion: 'v1', scaleTier: 'S',
    stores: { knowledge: { impl: 'markdown-fs', path: 'knowledge' }, cases: { impl: 'markdown-fs', path: 'cases' }, requirements: { primary: { impl: 'paste' } } },
    stages: {
      analyze: { review: { enabled: false } },
      design: { review: { enabled: false } },
      execute: { review: { enabled: false } },
      report: { review: { enabled: false } },
      ...stages,
    },
  })
}

/** 收集用量输入（不落盘，测试只关心"记了什么"）。 */
class CollectingSink implements UsageSink {
  readonly inputs: UsageRecordInput[] = []
  async record(input: UsageRecordInput): Promise<void> { this.inputs.push(input) }
  of(kind: UsageRecordInput['kind']): readonly UsageRecordInput[] {
    return this.inputs.filter(input => input.kind === kind)
  }
}

class FakeLlm implements LlmClient {
  readonly requests: readonly LlmMessage[][] = []
  private readonly responses: LlmResponse[]
  constructor(responses: LlmResponse[]) { this.responses = responses }
  async complete(request: Parameters<LlmClient['complete']>[0]): Promise<LlmResponse> {
    ;(this.requests as LlmMessage[][]).push([...request.messages])
    const response = this.responses.shift()
    if (response === undefined) throw new Error('no fake response')
    return response
  }
}

test('OpenAIStageRunner executes restricted tool calls and persists structured artifact', async () => {
  const tools = new InMemoryToolRegistry()
  tools.register({
    name: 'parse_doc', description: 'look up a value', parameters: { type: 'object', properties: { key: { type: 'string' } }, required: ['key'] },
    async execute(args: { key: string }) { return { value: `found:${args.key}` } },
  })
  const llm = new FakeLlm([
    { content: '', toolCalls: [{ id: 'call-1', name: 'parse_doc', arguments: '{"key":"payment"}' }] },
    { content: '{"requirements":[],"clarifications":[],"assumptions":[],"risks":[],"scope":{},"acceptanceCriteria":[]}', json: { requirements: [], clarifications: [], assumptions: [], risks: [], scope: {}, acceptanceCriteria: [] }, finishReason: 'stop' },
  ])
  const runner = new OpenAIStageRunner({ llm, tools, artifacts: new FsArtifactStore(dir), model: 'test-model', systemPrompt: 'test system' })
  const request = { stageId: 'receive' as const, pipelineId: 'p1', inputPaths: {}, inputDigests: {}, artifactPath: 'artifacts/p1/receive.json' }
  const result = await runner.runStage(request, config())
  assert.equal(result.artifactPath, request.artifactPath)
  assert.equal(llm.requests.length, 2)
  assert.equal(llm.requests[1]?.at(-1)?.role, 'tool')
  assert.match(llm.requests[1]?.at(-1)?.content ?? '', /found:payment/)
  const artifact = await new FsArtifactStore(dir).read(request.artifactPath)
  assert.deepEqual(artifact?.content, { requirements: [], clarifications: [], assumptions: [], risks: [], scope: {}, acceptanceCriteria: [] })
})

test('OpenAIStageRunner rejects unavailable tools and non-JSON final output', async () => {
  const llm = new FakeLlm([{ content: '', toolCalls: [{ id: 'call-1', name: 'missing', arguments: '{}' }] }, { content: 'not json' }])
  const runner = new OpenAIStageRunner({ llm, tools: new InMemoryToolRegistry(), artifacts: new FsArtifactStore(dir), model: 'test-model' })
  await assert.rejects(() => runner.runStage({ stageId: 'receive', pipelineId: 'p1', inputPaths: {}, artifactPath: 'artifacts/p1/receive.json' }, config()), /non-JSON/)
  assert.match(llm.requests[1]?.at(-1)?.content ?? '', /not available/)
})

// ── M3：预算计量与强制停止（docs/10 §7.3 / §7.4）──────────────────────────────

test('工具步数用满 budget.maxSteps 后模型仍要求继续 → 立即停止并抛预算超限', async () => {
  const tools = new InMemoryToolRegistry()
  tools.register({ name: 'parse_doc', description: 'd', async execute() { return { ok: true } } })
  // 模型每次都要求再调一次工具：永远不会主动收尾。
  const llm = new FakeLlm(Array.from({ length: 10 }, (_, index) => ({
    content: '',
    toolCalls: [{ id: `call-${index}`, name: 'parse_doc', arguments: '{}' }],
  })))
  const usage = new CollectingSink()
  const runner = new OpenAIStageRunner({
    llm, tools, artifacts: new FsArtifactStore(dir), model: 'test-model', usage,
  })
  const error = await runner.runStage(
    { stageId: 'receive', pipelineId: 'p1', inputPaths: {}, artifactPath: 'artifacts/p1/receive.json' },
    config({ receive: { budget: { maxSteps: 2 } } }),
  ).then(() => null, (thrown: unknown) => thrown)

  assert.ok(error instanceof StageBudgetExceededError)
  assert.equal(error.stageId, 'receive')
  assert.equal(error.limit.kind, 'max-steps')
  assert.equal(error.limit.limit, 2)
  // used > limit：被拒绝的那一刻模型仍要求再来一步（否则"超出预算"无从表达）。
  assert.equal(error.limit.used, 3)
  // 立即停止：不再多跑一轮模型（只有 2 次 llm 调用，而不是把 10 条脚本跑完）。
  assert.equal(llm.requests.length, 2)
  // 失败前发生的消耗仍然被计量：2 次模型调用 + 2 次工具调用。
  assert.equal(usage.of('llm').length, 2)
  assert.equal(usage.of('tool').length, 2)
  assert.equal(usage.of('tool').every(input => input.toolName === 'parse_doc' && input.success), true)
  // 阶段失败时**不写产物**：宁可没有产物，也不要留下半成品被门禁当成通过。
  assert.equal(await new FsArtifactStore(dir).read('artifacts/p1/receive.json'), null)
})

test('模型调用带回 usage 时 token 记入事件；未带回时字段留空（不冒充 0）', async () => {
  const llm = new FakeLlm([
    { content: '', toolCalls: [{ id: 'c1', name: 'parse_doc', arguments: '{}' }], usage: { inputTokens: 120, outputTokens: 30 } },
    { content: '{"a":1}', json: { a: 1 } },
  ])
  const tools = new InMemoryToolRegistry()
  tools.register({ name: 'parse_doc', description: 'd', async execute() { return 1 } })
  const usage = new CollectingSink()
  const runner = new OpenAIStageRunner({ llm, tools, artifacts: new FsArtifactStore(dir), model: 'm', usage })
  await runner.runStage({ stageId: 'receive', pipelineId: 'p1', inputPaths: {}, artifactPath: 'artifacts/p1/receive.json' }, config())

  const llmEvents = usage.of('llm')
  assert.equal(llmEvents.length, 2)
  assert.equal(llmEvents[0]?.inputTokens, 120)
  assert.equal(llmEvents[0]?.outputTokens, 30)
  // 第二次模型响应没有 usage → 字段缺席，而不是被填成 0（0 会让汇总误判"没消耗"）。
  assert.equal('inputTokens' in (llmEvents[1] ?? {}), false)
})

test('budget.timeoutMs > 0 时阶段 deadline 生效：抛 timeout 超限且不牵连宿主信号', async () => {
  const tools = new InMemoryToolRegistry()
  // 工具名必须是 receive 阶段 ACL 允许的名字（`parse_doc`），否则它根本不会被暴露给模型，
  // 测试会退化成"工具不可用"而测不到 deadline。工具刻意**不观察** signal：
  // 证明阶段侧还有兜底判定，而不是只靠下游配合。
  tools.register({ name: 'parse_doc', description: 'd', async execute() { await new Promise(resolve => setTimeout(resolve, 80)); return 1 } })
  const llm = new FakeLlm([
    { content: '', toolCalls: [{ id: 'c1', name: 'parse_doc', arguments: '{}' }] },
    { content: '{"a":1}', json: { a: 1 } },
  ])
  const hostSignal = new AbortController()
  const runner = new OpenAIStageRunner({
    llm, tools, artifacts: new FsArtifactStore(dir), model: 'm', signal: hostSignal.signal,
  })
  const error = await runner.runStage(
    { stageId: 'receive', pipelineId: 'p1', inputPaths: {}, artifactPath: 'artifacts/p1/receive.json' },
    config({ receive: { budget: { timeoutMs: 20 } } }),
  ).then(() => null, (thrown: unknown) => thrown)

  assert.ok(error instanceof StageBudgetExceededError)
  assert.equal(error.limit.kind, 'timeout')
  assert.equal(error.limit.limit, 20)
  assert.ok(error.limit.used >= 20)
  // deadline 用派生信号：阶段超时**不能**把宿主信号置成 aborted，
  // 否则后续阶段会带着"已取消"启动，上层也会把它误读成人工门取消（§7.4）。
  assert.equal(hostSignal.signal.aborted, false)
})

test('budget.timeoutMs: 0 = 项目定义，不设阶段 deadline（慢工具照样跑完）', async () => {
  const tools = new InMemoryToolRegistry()
  tools.register({ name: 'parse_doc', description: 'd', async execute() { await new Promise(resolve => setTimeout(resolve, 60)); return 1 } })
  const llm = new FakeLlm([
    { content: '', toolCalls: [{ id: 'c1', name: 'slow', arguments: '{}' }] },
    { content: '{"a":1}', json: { a: 1 } },
  ])
  const runner = new OpenAIStageRunner({ llm, tools, artifacts: new FsArtifactStore(dir), model: 'm' })
  const spawned = await runner.runStage(
    { stageId: 'receive', pipelineId: 'p1', inputPaths: {}, artifactPath: 'artifacts/p1/receive.json' },
    config({ receive: { budget: { timeoutMs: 0 } } }),
  )
  assert.equal(spawned.stageId, 'receive')
  assert.notEqual(await new FsArtifactStore(dir).read('artifacts/p1/receive.json'), null)
})

test('模型报错也记一条失败 llm 事件，但错误码里不含 provider 原文（凭据不进日志）', async () => {
  class FailingLlm implements LlmClient {
    async complete(): Promise<LlmResponse> {
      const error = new Error('HTTP 401: Authorization Bearer sk-super-secret-value')
      error.name = 'OpenAICompatibleError'
      throw error
    }
  }
  const usage = new CollectingSink()
  const runner = new OpenAIStageRunner({
    llm: new FailingLlm(), artifacts: new FsArtifactStore(dir), model: 'm', usage,
  })
  await assert.rejects(() => runner.runStage(
    { stageId: 'receive', pipelineId: 'p1', inputPaths: {}, artifactPath: 'artifacts/p1/receive.json' },
    config(),
  ))

  const [event] = usage.of('llm')
  assert.equal(event?.success, false)
  assert.equal(event?.errorCode, 'llm-request-failed')
  const serialized = JSON.stringify(usage.inputs)
  assert.equal(serialized.includes('sk-super-secret-value'), false)
  assert.equal(serialized.includes('Authorization'), false)
})

test('工具失败被记为 success=false + errorCode，同时错误仍回喂模型（不中断阶段）', async () => {
  const tools = new InMemoryToolRegistry()
  tools.register({ name: 'parse_doc', description: 'd', async execute() { throw new Error('工具内部炸了') } })
  const llm = new FakeLlm([
    { content: '', toolCalls: [{ id: 'c1', name: 'parse_doc', arguments: '{}' }] },
    { content: '{"a":1}', json: { a: 1 } },
  ])
  const usage = new CollectingSink()
  const runner = new OpenAIStageRunner({ llm, tools, artifacts: new FsArtifactStore(dir), model: 'm', usage })
  await runner.runStage({ stageId: 'receive', pipelineId: 'p1', inputPaths: {}, artifactPath: 'artifacts/p1/receive.json' }, config())

  const [toolEvent] = usage.of('tool')
  assert.equal(toolEvent?.success, false)
  assert.equal(toolEvent?.errorCode, 'tool-failed')
  assert.match(llm.requests[1]?.at(-1)?.content ?? '', /工具内部炸了/)
})

test('用量事件都绑定到当前 stageId（§7.4 一一绑定），且不写入 prompt 正文', async () => {
  const llm = new FakeLlm([{ content: '{"a":1}', json: { a: 1 } }])
  const usage = new CollectingSink()
  const runner = new OpenAIStageRunner({ llm, artifacts: new FsArtifactStore(dir), model: 'm', usage, systemPrompt: '系统提示：内部约定' })
  await runner.runStage({ stageId: 'design', pipelineId: 'p1', inputPaths: {}, artifactPath: 'artifacts/p1/design.json' }, config())

  assert.equal(usage.inputs.length, 1)
  assert.equal(usage.inputs[0]?.stageId, 'design')
  assert.equal(usage.inputs[0]?.kind, 'llm')
  assert.equal(JSON.stringify(usage.inputs).includes('内部约定'), false)
})
