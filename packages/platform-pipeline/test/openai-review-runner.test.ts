import { test } from 'node:test'
import assert from 'node:assert/strict'

import type { StageArtifact } from '../src/types.ts'
import type { JudgeResult } from '../src/gates/machine.ts'
import type { LlmClient, LlmMessage, LlmResponse, ToolDefinition } from '../src/runtime/ports.ts'
import { InMemoryToolRegistry } from '../src/runtime/tool-registry.ts'
import { DEFAULT_REVIEW_TOOLS, OpenAIReviewRunner } from '../src/runtime/openai-review-runner.ts'

class StubLlm implements LlmClient {
  readonly calls: Array<{ readonly messages: readonly LlmMessage[]; readonly tools?: readonly ToolDefinition[] }> = []
  private readonly responses: LlmResponse[]

  constructor(...responses: LlmResponse[]) {
    this.responses = responses
  }

  async complete(request: { messages: readonly LlmMessage[]; tools?: readonly ToolDefinition[] }): Promise<LlmResponse> {
    this.calls.push({ messages: request.messages, ...(request.tools === undefined ? {} : { tools: request.tools }) })
    const next = this.responses.shift()
    if (next === undefined) throw new Error('no scripted response left')
    return next
  }
}

function artifact(): StageArtifact {
  return {
    pipelineId: 'p1',
    stageId: 'analyze',
    version: 1,
    inputs: { receive: 'digest-receive' },
    content: { scope: 'x' },
    digest: 'd1',
    path: 'artifacts/p1/analyze.json',
  }
}

const gate: JudgeResult = { status: 'passed', violations: [] }

function readTool(name = 'fs_read'): ToolDefinition {
  return { name, description: name, async execute() { return 'file-content' } }
}

test('OpenAIReviewRunner maps a structured report and surfaces review coverage', async () => {
  const llm = new StubLlm({
    content: '',
    json: {
      stageId: 'analyze',
      verdict: 'conditional',
      findings: [{ severity: 'concern', claim: '版本影响未覆盖 v2.1', evidence: 'analyze.json#versionImpact', suggestedAction: 'address-in-human-gate' }],
      checked: ['边界', '版本影响'],
      confidence: 0.7,
    },
  })
  const runner = new OpenAIReviewRunner({ llm, model: 'm' })
  const outcome = await runner.run('analyze', artifact(), gate)

  assert.equal(outcome.verdict, 'conditional')
  assert.equal(outcome.findings.length, 2)
  assert.match(outcome.findings[0]!, /\[concern\] 版本影响未覆盖 v2\.1｜证据：analyze\.json#versionImpact/)
  assert.match(outcome.findings[1]!, /审核覆盖：边界；版本影响/)
  // 盲审 prompt 必须带上待审产物路径与上游路径
  const prompt = llm.calls[0]!.messages.at(-1)!.content
  assert.match(prompt, /artifacts\/p1\/analyze\.json/)
  assert.match(prompt, /artifacts\/p1\/receive\.json/)
})

test('OpenAIReviewRunner forces fail when a blocker finding is present', async () => {
  const llm = new StubLlm({
    content: '',
    json: {
      stageId: 'analyze',
      verdict: 'pass',
      findings: [{ severity: 'blocker', claim: '未验证结论被当作已验证', evidence: 'analyze.json#scope' }],
      checked: ['x'],
    },
  })
  const outcome = await new OpenAIReviewRunner({ llm, model: 'm' }).run('analyze', artifact(), gate)
  assert.equal(outcome.verdict, 'fail', '模型自报 pass 不得放过 blocker')
})

test('OpenAIReviewRunner degrades on an unusable report instead of guessing a verdict', async () => {
  const badVerdict = new StubLlm({ content: '', json: { verdict: 'maybe', findings: [], checked: [] } })
  const degraded = await new OpenAIReviewRunner({ llm: badVerdict, model: 'm' }).run('analyze', artifact(), gate)
  assert.equal(degraded.verdict, 'degraded')
  assert.match(degraded.findings[0]!, /非法 verdict/)

  const badFindings = new StubLlm({ content: '', json: { verdict: 'pass', findings: 'nope' } })
  assert.equal((await new OpenAIReviewRunner({ llm: badFindings, model: 'm' }).run('analyze', artifact(), gate)).verdict, 'degraded')

  const notObject = new StubLlm({ content: '', json: ['pass'] })
  assert.equal((await new OpenAIReviewRunner({ llm: notObject, model: 'm' }).run('analyze', artifact(), gate)).verdict, 'degraded')
})

test('OpenAIReviewRunner degrades when the model call fails (review must not block the pipeline)', async () => {
  const llm: LlmClient = { async complete() { throw new Error('provider exploded') } }
  const outcome = await new OpenAIReviewRunner({ llm, model: 'm' }).run('analyze', artifact(), gate)
  assert.equal(outcome.verdict, 'degraded')
  assert.match(outcome.findings[0]!, /provider exploded/)
})

test('OpenAIReviewRunner exposes read-only tools only, and reports unknown tool calls back to the model', async () => {
  const tools = new InMemoryToolRegistry([readTool('fs_read'), readTool('fs_write')])
  const llm = new StubLlm(
    { content: '', toolCalls: [
      { id: 'c1', name: 'fs_read', arguments: '{"path":"artifacts/p1/analyze.json"}' },
      { id: 'c2', name: 'fs_write', arguments: '{"path":"artifacts/p1/analyze.json","content":"{}"}' },
    ] },
    { content: '', json: { stageId: 'analyze', verdict: 'pass', findings: [], checked: ['x'] } },
  )
  const outcome = await new OpenAIReviewRunner({ llm, model: 'm', tools }).run('analyze', artifact(), gate)

  assert.equal(outcome.verdict, 'pass')
  assert.deepEqual(llm.calls[0]!.tools?.map(tool => tool.name), ['fs_read'], '审核不得看到写工具')
  const toolMessages = llm.calls[1]!.messages.filter(message => message.role === 'tool')
  assert.equal(toolMessages[0]?.content, 'file-content')
  assert.match(toolMessages[1]?.content ?? '', /tool is not available to the reviewer: fs_write/)
})

test('OpenAIReviewRunner default tool allowlist is read-only', () => {
  assert.deepEqual([...DEFAULT_REVIEW_TOOLS], ['fs_read'])
})
