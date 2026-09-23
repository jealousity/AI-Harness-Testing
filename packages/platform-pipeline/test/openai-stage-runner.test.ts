import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { OpenAIStageRunner } from '../src/runtime/openai-stage-runner.ts'
import { InMemoryToolRegistry } from '../src/runtime/tool-registry.ts'
import { FsArtifactStore } from '../src/stores/fs.ts'
import { normalizeConfig } from '../src/config.ts'
import type { LlmClient, LlmMessage, LlmResponse } from '../src/runtime/ports.ts'

let dir: string

test.beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'pp-agent-runner-')) })
test.afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

function config() {
  return normalizeConfig({
    projectId: 'agent-runtime', projectType: 'api-service', templateVersion: 'v1', scaleTier: 'S',
    stores: { knowledge: { impl: 'markdown-fs', path: 'knowledge' }, cases: { impl: 'markdown-fs', path: 'cases' }, requirements: { primary: { impl: 'paste' } } },
    stages: { analyze: { review: { enabled: false } }, design: { review: { enabled: false } }, execute: { review: { enabled: false } }, report: { review: { enabled: false } } },
  })
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
