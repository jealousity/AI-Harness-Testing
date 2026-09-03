import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  UiUserQuestionsHumanGate,
  APPROVE,
  CHANGES_NEEDED,
  REJECT,
  type UserQuestions,
  type HumanGateAuditRecord,
} from '../src/human-gate.ts'
import type { StageArtifact, StageId } from '../src/types.ts'
import type { JudgeResult } from '../src/gates/machine.ts'
import type { ReviewOutcome } from '../src/driver.ts'

const stageId = 'analyze' as StageId
const artifact: StageArtifact = {
  pipelineId: 'pid',
  stageId,
  version: 1,
  inputs: {},
  content: { decision: '复用现有登录接口', notes: '人工门确认复用范围' },
  digest: 'd1',
  path: 'artifacts/pid/analyze.json',
}
const gatePassed: JudgeResult = { status: 'passed', violations: [] }
const gateBlocked: JudgeResult = {
  status: 'failed',
  violations: [{ rule: 'G-01', level: 'BLOCKING' as const, detail: '产物缺必填字段', at: 0 }],
}
const review: ReviewOutcome = { verdict: 'conditional', findings: ['复用范围未列明边界'] }

/** 记录入站 ask 请求、返回预设答案的 mock（形状同 ctx.userQuestions）。 */
function makeUserQuestions(answer?: { selected?: string[]; custom?: string }, throwCode?: string): {
  userQuestions: UserQuestions
  asks: Array<{ id: string; question: string; header?: string; detail?: string }>
} {
  const asks: Array<{ id: string; question: string; header?: string; detail?: string }> = []
  return {
    asks,
    userQuestions: {
      ask: async (request) => {
        asks.push({
          id: request.questions[0]!.id,
          question: request.questions[0]!.question,
          header: request.questions[0]!.header,
          detail: request.questions[0]!.detail,
        })
        if (throwCode) throw Object.assign(new Error('ask aborted'), { code: throwCode, name: 'UserQuestionError' })
        return {
          answers: [{
            id: request.questions[0]!.id,
            selected: answer?.selected ?? [APPROVE],
            ...(answer?.custom === undefined ? {} : { custom: answer.custom }),
          }],
        }
      },
    },
  }
}

test('gate: 批准 → approved', async () => {
  const { userQuestions } = makeUserQuestions({ selected: [APPROVE] })
  const gate = new UiUserQuestionsHumanGate({ userQuestions, by: 'reviewer-1' })
  const decision = await gate.gate(stageId, artifact, gatePassed, review)
  assert.equal(decision, 'approved')
})

test('gate: 需修改 → changes-needed', async () => {
  const { userQuestions } = makeUserQuestions({ selected: [CHANGES_NEEDED] })
  const gate = new UiUserQuestionsHumanGate({ userQuestions })
  assert.equal(await gate.gate(stageId, artifact, gatePassed), 'changes-needed')
})

test('gate: 拒绝 → rejected', async () => {
  const { userQuestions } = makeUserQuestions({ selected: [REJECT] })
  const gate = new UiUserQuestionsHumanGate({ userQuestions })
  assert.equal(await gate.gate(stageId, artifact, gatePassed), 'rejected')
})

test('gate: 未选择（空 selected）降级 changes-needed，不批准', async () => {
  const { userQuestions } = makeUserQuestions({ selected: [] })
  const gate = new UiUserQuestionsHumanGate({ userQuestions })
  assert.equal(await gate.gate(stageId, artifact, gatePassed), 'changes-needed')
})

test('gate: 呈现内容含产物摘要、门禁判定与交叉检查 findings', async () => {
  const { userQuestions, asks } = makeUserQuestions({ selected: [APPROVE] })
  const gate = new UiUserQuestionsHumanGate({ userQuestions })
  await gate.gate(stageId, artifact, gateBlocked, review)
  assert.equal(asks.length, 1)
  const presented = asks[0]!
  assert.match(presented.id, /^gate-analyze$/)
  assert.match(presented.question, /analyze/)
  assert.match(presented.detail ?? '', /复用现有登录接口/)
  assert.match(presented.detail ?? '', /机器门禁：未通过/)
  assert.match(presented.detail ?? '', /G-01/)
  assert.match(presented.detail ?? '', /条件通过|交叉检查/)
  assert.match(presented.detail ?? '', /复用范围未列明边界/)
})

test('gate: 交叉检查缺失时提示"未启用"', async () => {
  const { userQuestions, asks } = makeUserQuestions({ selected: [APPROVE] })
  const gate = new UiUserQuestionsHumanGate({ userQuestions })
  await gate.gate(stageId, artifact, gatePassed)
  assert.match(asks[0]!.detail ?? '', /交叉检查：未启用/)
})

test('gate: ASK_ABORTED 降级 changes-needed 并记录裁决', async () => {
  const { userQuestions } = makeUserQuestions(undefined, 'ASK_ABORTED')
  const records: HumanGateAuditRecord[] = []
  const gate = new UiUserQuestionsHumanGate({
    userQuestions,
    by: 'reviewer-2',
    onDecision: (r) => records.push(r),
  })
  assert.equal(await gate.gate(stageId, artifact, gatePassed), 'changes-needed')
  assert.equal(records.length, 1)
  assert.equal(records[0]!.action, 'changes-needed')
  assert.match(records[0]!.note, /ASK_ABORTED/)
  assert.equal(records[0]!.by, 'reviewer-2')
  assert.equal(records[0]!.stageId, 'analyze')
  assert.equal(typeof records[0]!.at, 'number')
})

test('gate: 裁决记录回调捕获备注（custom）与动作', async () => {
  const { userQuestions } = makeUserQuestions({ selected: [CHANGES_NEEDED], custom: '补充复用范围' })
  const records: HumanGateAuditRecord[] = []
  const gate = new UiUserQuestionsHumanGate({ userQuestions, onDecision: (r) => records.push(r) })
  await gate.gate(stageId, artifact, gatePassed)
  assert.equal(records.length, 1)
  assert.equal(records[0]!.action, 'changes-needed')
  assert.equal(records[0]!.note, '补充复用范围')
})

test('gate: 非 ABORTED 错误向上传抛（不吞）', async () => {
  const { userQuestions } = makeUserQuestions(undefined, 'NO_PROVIDER')
  const gate = new UiUserQuestionsHumanGate({ userQuestions })
  await assert.rejects(() => gate.gate(stageId, artifact, gatePassed), /ask aborted/)
})

test('gateFailed: 呈现升级提示并记录确认', async () => {
  const { userQuestions, asks } = makeUserQuestions({ selected: ['确认终止'], custom: '已归档' })
  const records: HumanGateAuditRecord[] = []
  const gate = new UiUserQuestionsHumanGate({ userQuestions, onDecision: (r) => records.push(r) })
  await gate.gateFailed(stageId, gateBlocked)
  assert.equal(asks.length, 1)
  assert.match(asks[0]!.id, /^gate-failed-analyze$/)
  assert.match(asks[0]!.detail ?? '', /重试耗尽/)
  assert.match(asks[0]!.detail ?? '', /G-01/)
  assert.equal(records.length, 1)
  assert.equal(records[0]!.action, 'rejected')
})

test('gateFailed: ASK_ABORTED 不抛错（pipeline 即将终止，升级提示不该阻塞）', async () => {
  const { userQuestions } = makeUserQuestions(undefined, 'ASK_ABORTED')
  const gate = new UiUserQuestionsHumanGate({ userQuestions })
  await gate.gateFailed(stageId, gateBlocked)
})

test('gateLetter: 缺省按阶段顺序推导 A~F，可被显式映射覆盖', async () => {
  const { userQuestions, asks } = makeUserQuestions({ selected: [APPROVE] })
  const gate = new UiUserQuestionsHumanGate({
    userQuestions,
    gateLetterByStage: { archive: 'G' },
  })
  await gate.gate('archive' as StageId, artifact, gatePassed)
  assert.match(asks[0]!.detail ?? '', /人工门 G/)
  await gate.gate(stageId, artifact, gatePassed)
  assert.match(asks[1]!.detail ?? '', /人工门 B/)
})
