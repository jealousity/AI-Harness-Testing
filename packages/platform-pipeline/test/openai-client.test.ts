import { test } from 'node:test'
import assert from 'node:assert/strict'
import { OpenAICompatibleClient, OpenAICompatibleError } from '../src/runtime/openai-client.ts'

test('OpenAICompatibleClient sends messages/tools and parses JSON response', async () => {
  let request: { url: string; init: RequestInit } | undefined
  const client = new OpenAICompatibleClient({
    baseUrl: 'https://llm.example.com/v1/',
    apiKey: 'secret-key',
    fetchImpl: async (url, init) => {
      request = { url: String(url), init: init ?? {} }
      return new Response(JSON.stringify({
        choices: [{ message: { content: '{"ok":true}', tool_calls: [{ id: 'call-1', function: { name: 'lookup', arguments: '{"id":"1"}' } }] }, finish_reason: 'tool_calls' }],
        usage: { prompt_tokens: 12, completion_tokens: 7 },
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    },
  })
  const response = await client.complete({
    model: 'general-model',
    messages: [{ role: 'user', content: 'hello' }],
    tools: [{ name: 'lookup', description: 'look up', parameters: { type: 'object' }, async execute() { return null } }],
    responseFormat: { type: 'json_schema', name: 'answer', schema: { type: 'object' } },
  })
  assert.equal(request?.url, 'https://llm.example.com/v1/chat/completions')
  const body = JSON.parse(String(request?.init.body))
  assert.equal(request?.init.headers instanceof Headers ? request.init.headers.get('authorization') : (request?.init.headers as Record<string, string>).authorization, 'Bearer secret-key')
  assert.equal(body.model, 'general-model')
  assert.equal(body.tools[0].function.name, 'lookup')
  assert.deepEqual(body.response_format, { type: 'json_schema', json_schema: { name: 'answer', schema: { type: 'object' }, strict: true } })
  assert.equal(response.content, '{"ok":true}')
  assert.deepEqual(response.json, { ok: true })
  assert.equal(response.toolCalls?.[0]?.name, 'lookup')
  assert.deepEqual(response.usage, { inputTokens: 12, outputTokens: 7 })
})

test('OpenAICompatibleClient reads API key from environment and retries 429', async () => {
  let attempts = 0
  const previous = process.env.TEST_LLM_KEY
  process.env.TEST_LLM_KEY = 'from-env'
  const client = new OpenAICompatibleClient({
    baseUrl: 'https://llm.example.com',
    apiKeyEnv: 'TEST_LLM_KEY',
    maxRetries: 1,
    fetchImpl: async () => {
      attempts += 1
      if (attempts === 1) return new Response(JSON.stringify({ error: { message: 'busy' } }), { status: 429 })
      return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), { status: 200 })
    },
  })
  try {
    const response = await client.complete({ model: 'm', messages: [] })
    assert.equal(response.content, 'ok')
    assert.equal(attempts, 2)
  } finally {
    if (previous === undefined) delete process.env.TEST_LLM_KEY
    else process.env.TEST_LLM_KEY = previous
  }
})

test('OpenAICompatibleClient normalizes provider errors without exposing the API key', async () => {
  const client = new OpenAICompatibleClient({
    baseUrl: 'https://llm.example.com',
    apiKey: 'do-not-leak',
    maxRetries: 0,
    fetchImpl: async () => new Response(JSON.stringify({ error: { message: 'invalid model' } }), { status: 400 }),
  })
  await assert.rejects(
    () => client.complete({ model: 'missing', messages: [] }),
    (error: unknown) => error instanceof OpenAICompatibleError
      && error.status === 400
      && error.message.includes('invalid model')
      && !error.message.includes('do-not-leak'),
  )
})

test('OpenAICompatibleClient validates API endpoint and structured schema requirements', async () => {
  assert.throws(() => new OpenAICompatibleClient({ baseUrl: 'file:///tmp', apiKey: 'x' }), /http or https/)
  const client = new OpenAICompatibleClient({ baseUrl: 'https://llm.example.com', apiKey: 'x', fetchImpl: fetch })
  assert.rejects(
    () => client.complete({ model: 'm', messages: [], responseFormat: { type: 'json_schema' } }),
    /requires name and schema/,
  )
})
