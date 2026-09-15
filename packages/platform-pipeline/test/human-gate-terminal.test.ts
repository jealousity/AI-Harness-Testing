import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Readable, Writable } from 'node:stream'
import {
  TerminalHumanGate,
  NoHumanAtConsoleError,
  APPROVE,
  CHANGES_NEEDED,
  REJECT,
  type HumanGateAuditRecord,
} from '../src/index.ts'
import type { StageArtifact, StageId } from '../src/types.ts'
import type { JudgeResult } from '../src/gates/machine.ts'

const stageId = 'analyze' as StageId
const artifact: StageArtifact = {
  pipelineId: 'pid',
  stageId,
  version: 1,
  inputs: { receive: 'abc123' },
  content: { decision: '复用现有登录接口' },
  digest: 'd1',
  path: 'artifacts/pid/analyze.json',
}
const gatePassed: JudgeResult = { status: 'passed', violations: [] }
const gateBlocked: JudgeResult = {
  status: 'failed',
  violations: [{ rule: 'G-01', level: 'BLOCKING' as const, detail: '产物缺必填字段', at: 0 }],
}
const review = { verdict: 'conditional', findings: ['复用范围未列明边界'] }

/** 收集输出的假 stdout。 */
class Sink extends Writable {
  text = ''
  override _write(chunk: unknown, _enc: unknown, cb: () => void): void {
    this.text += String(chunk)
    cb()
  }
}

/** 用预置输入行驱动真实现（仍走真校验）。 */
function gateWith(lines: string[], opts: { allowNonTty?: boolean; signal?: AbortSignal } = {}) {
  const out = new Sink()
  const records: HumanGateAuditRecord[] = []
  const gate = new TerminalHumanGate({
    input: Readable.from(lines.map(l => `${l}\n`)),
    output: out,
    allowNonTty: opts.allowNonTty ?? true,
    ...(opts.signal === undefined ? {} : { signal: opts.signal }),
    by: 'tester',
    onDecision: r => records.push(r),
  })
  return { gate, out, records }
}

test('无 TTY 且未显式放行 → 抛 NO_HUMAN_AT_CONSOLE（绝不自动批准）', async () => {
  const out = new Sink()
  const gate = new TerminalHumanGate({
    input: Readable.from(['1\n']), // 非 TTY：isTTY 为 undefined
    output: out,
    by: 'tester',
  })
  await assert.rejects(
    () => gate.gate(stageId, artifact, gatePassed, review),
    (err: unknown) => err instanceof NoHumanAtConsoleError
      && (err as { code?: string }).code === 'NO_HUMAN_AT_CONSOLE',
  )
  // 关键：不得因为拿不到人而产出任何裁决呈现以外的副作用（无默认批准）
  assert.equal(out.text, '')
})

test('选择 1 → approved，并写入审计记录', async () => {
  const { gate, records } = gateWith(['1', ''])
  assert.equal(await gate.gate(stageId, artifact, gatePassed, review), 'approved')
  assert.equal(records.length, 1)
  assert.equal(records[0]!.action, 'approved')
  assert.equal(records[0]!.by, 'tester')
  assert.equal(records[0]!.stageId, 'analyze')
})

test('选择 2 + 理由 → changes-needed，理由进审计记录', async () => {
  const { gate, records } = gateWith(['2', '必须补充短信接口的失败分支'])
  assert.equal(await gate.gate(stageId, artifact, gatePassed, review), 'changes-needed')
  assert.equal(records[0]!.action, 'changes-needed')
  assert.equal(records[0]!.note, '必须补充短信接口的失败分支')
})

test('选择 3 → rejected', async () => {
  const { gate, records } = gateWith(['3', '方案方向错误'])
  assert.equal(await gate.gate(stageId, artifact, gatePassed, review), 'rejected')
  assert.equal(records[0]!.action, 'rejected')
})

test('接受选项原文（中文裁决词）', async () => {
  const { gate } = gateWith([APPROVE, ''])
  assert.equal(await gate.gate(stageId, artifact, gatePassed, review), 'approved')
})

test('非法输入必须重新追问，绝不默认通过', async () => {
  const { gate, out, records } = gateWith(['', 'y', '9', '批准', ''])
  assert.equal(await gate.gate(stageId, artifact, gatePassed, review), 'approved')
  assert.ok(out.text.includes('无法识别的输入'), '非法输入应被拒绝并提示')
  // 三次非法（空/y/9）后才接受：证明没有取默认值
  assert.equal(records.length, 1)
})

test('打回/拒绝必须给出非空理由，空理由重新追问', async () => {
  const { gate, out, records } = gateWith(['2', '', '   ', '缺边界说明'])
  assert.equal(await gate.gate(stageId, artifact, gatePassed, review), 'changes-needed')
  assert.ok(out.text.includes('理由不能为空'))
  assert.equal(records[0]!.note, '缺边界说明')
})

test('呈现内容与 UI 渠道同源：含机器门禁判定、交叉检查 findings、门禁字母', async () => {
  const { gate, out } = gateWith(['1', ''])
  await gate.gate(stageId, artifact, gateBlocked, review)
  assert.ok(out.text.includes(' 机器门禁：未通过'))
  assert.ok(out.text.includes('[G-01] 产物缺必填字段'))
  assert.ok(out.text.includes('交叉检查：conditional'))
  assert.ok(out.text.includes('复用范围未列明边界'))
  assert.ok(out.text.includes('人工门 B'), 'analyze 是第二个阶段 → 门禁字母 B')
  assert.ok(out.text.includes('artifacts/pid/analyze.json'))
})

test('取消（abort）→ changes-needed 并留痕，不抛异常', async () => {
  const ac = new AbortController()
  ac.abort()
  const { gate, records } = gateWith(['1'], { signal: ac.signal })
  assert.equal(await gate.gate(stageId, artifact, gatePassed, review), 'changes-needed')
  assert.equal(records[0]!.action, 'changes-needed')
  assert.ok(records[0]!.note.includes('ASK_ABORTED'))
})

test('gateFailed 在取消时静默返回（不因升级提示崩溃）', async () => {
  const ac = new AbortController()
  ac.abort()
  const { gate } = gateWith(['1'], { signal: ac.signal })
  await gate.gateFailed(stageId, gateBlocked) // 不抛即通过
})

test('gateFailed 呈现升级信息并记录 rejected', async () => {
  const { gate, out, records } = gateWith(['1', '同意终止'])
  await gate.gateFailed(stageId, gateBlocked)
  assert.ok(out.text.includes('门禁重试耗尽'))
  assert.ok(out.text.includes('阻断违规 1 项'))
  assert.equal(records[0]!.action, 'rejected')
})

test('可自定义门禁字母映射（宿主可改 A~G）', async () => {
  const out = new Sink()
  const gate = new TerminalHumanGate({
    input: Readable.from(['1\n', '\n']),
    output: out,
    allowNonTty: true,
    gateLetterByStage: { analyze: 'G' },
  })
  await gate.gate(stageId, artifact, gatePassed, review)
  assert.ok(out.text.includes('人工门 G'))
})

test('同一门实例跨多门复用行读取器：连续两次裁决都能拿到输入（回归：曾永久等待）', async () => {
  const { gate, records } = gateWith(['1', '', '2', '需要补充失败分支覆盖'])
  assert.equal(await gate.gate(stageId, artifact, gatePassed, review), 'approved')
  assert.equal(await gate.gate(stageId, artifact, gatePassed, review), 'changes-needed')
  assert.equal(records.length, 2)
  assert.equal(records[1]!.note, '需要补充失败分支覆盖')
})

test('输入提前结束且无可用行 → 响亮失败（既不永久等待也不批准）', async () => {
  const out = new Sink()
  const gate = new TerminalHumanGate({
    input: Readable.from([]),
    output: out,
    allowNonTty: true,
  })
  await assert.rejects(
    () => gate.gate(stageId, artifact, gatePassed, review),
    (err: unknown) => err instanceof NoHumanAtConsoleError,
  )
})