/**
 * 真实 ui-user-questions provider 链路验证（里程碑 UI 审核，"真实 UI 弹窗"）：
 * 挂载 harness 的 apiproxy 测试栈（api-proxy-question.spec 同套），
 * apiproxy 自动注册真实 provider——ask({agent}) 发 mux question/requested 事件，
 * api.respond(client-response) 把真人答案回传，ask 解析为 { answers }。
 * 这等于验证了 Web GUI 底层走的真实协议通路（GUI 只是渲染层），
 * 而非用"返回预设答案的桩"走形。
 *
 * 零 harness 运行时耦合：仅 devDep @deepseek-ai/dsh-host-apiproxy，运行时边界不变。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import SessionStore from '@deepseek-ai/dsh-session'
import UserQuestionService from '@deepseek-ai/dsh-user-questions'
import { createApiProxy, RpcId } from '@deepseek-ai/dsh-host-apiproxy'
import type { ApiProxy, MuxFrame, RpcRequest } from '@deepseek-ai/dsh-host-apiproxy/api'
import { UiUserQuestionsHumanGate, APPROVE } from '../src/human-gate.ts'
import type { StageArtifact, StageId } from '../src/types.ts'
import type { JudgeResult } from '../src/gates/machine.ts'

const stageId = 'analyze' as StageId
const artifact: StageArtifact = {
  pipelineId: 'pid',
  stageId,
  version: 1,
  inputs: {},
  content: { decision: '真 provider 链路验证' },
  digest: 'd1',
  path: 'artifacts/pid/analyze.json',
}
const gatePassed: JudgeResult = { status: 'passed', violations: [] }

async function harness(): Promise<{ ctx: Context; api: ApiProxy }> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(UserQuestionService)
  return {
    ctx,
    api: createApiProxy(ctx, { defaultModelSelection: () => ({ provider: 'p', model: 'm' }), cwd: '/tmp' }),
  }
}

function liveAgent(ctx: Context): Agent {
  const session = ctx.sessions.create()
  const value = { id: session.id, session, status: 'idle', ctx } as Agent
  ctx.agents.register(value)
  return value
}

function openMux(api: ApiProxy, abort: AbortController): {
  waitForQuestion(): Promise<RpcRequest<Extract<MuxFrame, { type: 'question/requested' }>>>
} {
  let resolve!: (v: RpcRequest<Extract<MuxFrame, { type: 'question/requested' }>>) => void
  const q = new Promise<RpcRequest<Extract<MuxFrame, { type: 'question/requested' }>>>((r) => { resolve = r })
  void (async () => {
    for await (const env of api.events.mux({ rpcId: RpcId('human-gate-mux'), payload: {} }, abort.signal)) {
      if (env.payload.type === 'question/requested') {
        resolve(env as RpcRequest<Extract<MuxFrame, { type: 'question/requested' }>>)
      }
    }
  })()
  return { waitForQuestion: () => q }
}

function respond(
  env: RpcRequest<Extract<MuxFrame, { type: 'question/requested' }>>,
  selected: string[],
): Parameters<ApiProxy['respond']>[0] {
  return {
    type: 'client-response',
    rpcId: env.rpcId,
    result: { ok: true, value: { sessionId: env.payload.sessionId, answer: { answers: [{ id: env.payload.questions[0]!.id, selected }] } } },
  }
}

test('真 provider 链路：ask 弹出 question/requested，respond 批准 → gate 返回 approved', async () => {
  const { ctx, api } = await harness()
  const abort = new AbortController()
  const mux = openMux(api, abort)
  const agent = liveAgent(ctx) // 注册为 live root，供 ask 校验与 session 绑定

  const humanGate = new UiUserQuestionsHumanGate({
    userQuestions: ctx.userQuestions,
    agent,
    by: 'real-ui-test',
  })
  const asked = humanGate.gate(stageId, artifact, gatePassed)

  // 真实 provider：ask 挂起并推送 question/requested mux 事件
  const env = await mux.waitForQuestion()
  assert.equal(env.payload.type, 'question/requested')
  assert.equal(env.payload.questions.length, 1)
  // 断言呈现给真人的问题里包含人工门文案
  const q = env.payload.questions[0]!
  assert.match(q.question, /analyze/)
  assert.equal(q.options?.length, 3)

  // 模拟真人点选"批准"
  assert.deepEqual(await api.respond(respond(env, [APPROVE])), { accepted: true })

  const decision = await asked
  assert.equal(decision, 'approved')
  abort.abort()
})
