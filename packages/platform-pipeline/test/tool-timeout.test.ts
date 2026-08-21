import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { applyToolTimeoutPolicy, toolTimeoutResult, TOOL_TIMEOUT } from '../src/harness/tool-timeout.ts'

function textResult(text: string): { type: 'text'; text: string }[] {
  return [{ type: 'text', text }]
}

/** cooperative 工具：观察 exec.signal；abort 后立即收敛（quiescence）。 */
function cooperativeTool(name: string, opts: { timeoutMs?: number; hangMs?: number } = {}) {
  return defineTool({
    name,
    description: name,
    parameters: {},
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean' } } },
      render: (_a, v) => textResult(JSON.stringify(v)),
    },
    ...(opts.timeoutMs === undefined ? {} : { timeoutMs: opts.timeoutMs }),
    async execute(_args, exec) {
      if (opts.hangMs === undefined) return { ok: true }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, opts.hangMs)
        exec.signal.addEventListener('abort', () => {
          clearTimeout(timer)
          resolve()
        }, { once: true })
      })
      return { ok: true }
    },
  })
}

async function mount(): Promise<Context> {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  return ctx
}

test('toolTimeoutResult renders a structured TOOL_TIMEOUT error', () => {
  const result = toolTimeoutResult(180_000)
  assert.equal(result.isError, true)
  assert.equal(result.error?.info?.code, TOOL_TIMEOUT)
  const text = result.content.map(b => 'text' in b ? b.text : '').join('')
  assert.match(text, /180 秒|180000ms/)
})

test('tool without timeoutMs runs without a deadline', async () => {
  const ctx = await mount()
  ctx.tools.register(cooperativeTool('t_fast'))
  applyToolTimeoutPolicy(ctx)
  const out = await ctx.tools.execute({ callId: 'c1' as never, name: 't_fast', arguments: {}, signal: new AbortController().signal })
  assert.equal(out.isError, false)
  assert.deepEqual(out.value, { ok: true })
})

test('tool with timeoutMs completes normally when faster than the deadline', async () => {
  const ctx = await mount()
  ctx.tools.register(cooperativeTool('t_quick', { timeoutMs: 5_000, hangMs: 30 }))
  applyToolTimeoutPolicy(ctx)
  const out = await ctx.tools.execute({ callId: 'c1' as never, name: 't_quick', arguments: {}, signal: new AbortController().signal })
  assert.equal(out.isError, false)
  assert.deepEqual(out.value, { ok: true })
})

test('tool exceeding its deadline is aborted and replaced with TOOL_TIMEOUT', async () => {
  const ctx = await mount()
  ctx.tools.register(cooperativeTool('t_slow', { timeoutMs: 150, hangMs: 60_000 }))
  applyToolTimeoutPolicy(ctx)
  const out = await ctx.tools.execute({ callId: 'c1' as never, name: 't_slow', arguments: {}, signal: new AbortController().signal })
  assert.equal(out.isError, true)
  assert.equal(out.error?.info?.code, TOOL_TIMEOUT)
})

test('upstream cancellation (non-timeout) is preserved, not misread as TOOL_TIMEOUT', async () => {
  const ctx = await mount()
  ctx.tools.register(cooperativeTool('t_cancel', { timeoutMs: 5_000, hangMs: 60_000 }))
  applyToolTimeoutPolicy(ctx)
  const ac = new AbortController()
  const pending = ctx.tools.execute({ callId: 'c1' as never, name: 't_cancel', arguments: {}, signal: ac.signal })
  setTimeout(() => ac.abort(), 80)
  const out = await pending
  // 上游取消：registry 报 ABORTED，而不是本插件的 TOOL_TIMEOUT（code 区分有效）
  assert.notEqual(out.error?.info?.code, TOOL_TIMEOUT)
})
