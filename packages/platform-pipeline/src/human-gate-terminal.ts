/**
 * 真终端人工门（HumanGatePort 实现）：在 TTY 上把阶段产物 + 机器门禁判定 +
 * 交叉检查 findings 呈现给真人，阻塞等待其当面裁决。
 *
 * 与 UiUserQuestionsHumanGate 共用同一份呈现构造器（human-gate.ts），
 * 两者只是渠道不同：本文件走 TTY，那条走 harness 弹窗流。
 *
 * **无脚本跳过**：没有任何默认值、超时批准或自动兜底。
 * - 非 TTY（无真人在场，如 CI / 重定向 stdin）→ 抛 NO_HUMAN_AT_CONSOLE，响亮失败；
 * - 输入提前 EOF → 同样按「无人应答」失败，绝不落成批准；
 * - 非法输入 → 重新追问，不取默认项；
 * - 打回/拒绝 → 理由必填，否则重跑无从修起。
 * 宁可使流水线停止，也不产生假的人工裁决。
 *
 * 行读取用自建队列而非 node:readline：readline 在没有待答问题时会**丢弃**
 * 已到达的行，并在输入流结束时关闭，导致管道喂输入不可靠。自建读取器不丢行，
 * 且支持按取消信号中止。
 *
 * 本文件零 harness 运行时引用（I-4 依赖边界）。
 * @module platform-pipeline/human-gate-terminal
 */

import type { HumanDecision, HumanGatePort } from './driver.ts'
import type { JudgeResult } from './gates/machine.ts'
import {
  APPROVE,
  CHANGES_NEEDED,
  REJECT,
  buildGateFailedPresentation,
  buildGatePresentation,
  type GatePresentation,
  type HumanGateAuditRecord,
} from './human-gate.ts'
import type { StageArtifact, StageId } from './types.ts'

/** 无真人在场（非 TTY / 提前 EOF）→ 拒绝给出裁决。 */
export class NoHumanAtConsoleError extends Error {
  readonly code = 'NO_HUMAN_AT_CONSOLE'
  constructor(message: string) {
    super(message)
    this.name = 'NoHumanAtConsoleError'
  }
}

/** 人工门等待被取消（与 UI 渠道 ASK_ABORTED 同语义）。 */
export class HumanGateAbortedError extends Error {
  readonly code = 'ASK_ABORTED'
  constructor(message = 'human gate aborted') {
    super(message)
    this.name = 'HumanGateAbortedError'
  }
}

export interface TerminalHumanGateDeps {
  /** 输入流；默认 process.stdin。 */
  readonly input?: NodeJS.ReadableStream
  /** 输出流；默认 process.stdout。 */
  readonly output?: NodeJS.WritableStream
  readonly onDecision?: (record: HumanGateAuditRecord) => void
  readonly gateLetterByStage?: Partial<Readonly<Record<StageId, string>>>
  readonly by?: string
  readonly signal?: AbortSignal
  /**
   * 允许非 TTY 输入（仅供自动化测试驱动真实现用）。
   * 默认 false —— 无 TTY 即视为无真人在场，响亮失败而非批准。
   */
  readonly allowNonTty?: boolean
}

/**
 * 行队列读取器：完整行进队列（不丢弃），被消费时立刻交付给等待者。
 * 流结束且已无缓存行 → 后续读取按 EOF 失败。
 */
class LineReader {
  private readonly queue: string[] = []
  private waiter: { resolve: (line: string) => void; reject: (err: Error) => void } | null = null
  private ended = false
  private endedWith: Error | null = null
  private buffer = ''

  constructor(input: NodeJS.ReadableStream) {
    input.on('data', (chunk: unknown) => { this.onData(String(chunk)) })
    input.on('end', () => { this.onEnd() })
    input.on('close', () => { this.onEnd() })
    input.on('error', (err: Error) => { this.onEnd(err) })
    // 挂载时流可能已结束（'end' 已经错过）→ 立即标记，避免读方永远等待
    if ((input as { readableEnded?: boolean }).readableEnded === true) {
      queueMicrotask(() => { this.onEnd() })
    }
  }

  private onData(text: string): void {
    this.buffer += text
    let idx = this.buffer.indexOf('\n')
    while (idx >= 0) {
      const line = this.buffer.slice(0, idx).replace(/\r$/, '')
      this.buffer = this.buffer.slice(idx + 1)
      this.deliver(line)
      idx = this.buffer.indexOf('\n')
    }
  }

  private deliver(line: string): void {
    const w = this.waiter
    if (w === null) {
      this.queue.push(line)
      return
    }
    this.waiter = null
    w.resolve(line)
  }

  private onEnd(err?: Error): void {
    if (this.ended) return
    this.ended = true
    if (err !== undefined) this.endedWith = err
    // 末尾无换行的残留内容仍算一行
    if (err === undefined && this.buffer.length > 0) {
      const rest = this.buffer
      this.buffer = ''
      this.queue.push(rest)
    }
    const w = this.waiter
    if (w === null) return
    this.waiter = null
    if (err !== undefined) {
      w.reject(err)
    } else if (this.queue.length > 0) {
      w.resolve(this.queue.shift()!)
    } else {
      w.reject(new Error('input ended before a decision was given (EOF)'))
    }
  }

  readLine(signal?: AbortSignal): Promise<string> {
    if (this.queue.length > 0) return Promise.resolve(this.queue.shift()!)
    if (this.ended) {
      return Promise.reject(this.endedWith ?? new Error('input ended before a decision was given (EOF)'))
    }
    return new Promise<string>((resolve, reject) => {
      const onAbort = (): void => {
        this.waiter = null
        reject(new HumanGateAbortedError())
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      const detach = (): void => { signal?.removeEventListener('abort', onAbort) }
      this.waiter = {
        resolve: (line) => { detach(); resolve(line) },
        reject: (err) => { detach(); reject(err) },
      }
    })
  }

  dispose(): void {
    this.ended = true
    this.queue.length = 0
    this.waiter = null
  }
}

/** 裁决录入：接受 1/2/3 或选项原文；空输入/未知输入返回 null（无默认项）。 */
function parseChoice(raw: string, options: readonly { readonly label: string }[]): number | null {
  const token = raw.trim()
  if (token === '') return null
  const idx = Number.parseInt(token, 10)
  if (Number.isInteger(idx) && idx >= 1 && idx <= options.length) return idx - 1
  const byLabel = options.findIndex(o => o.label === token)
  return byLabel >= 0 ? byLabel : null
}

function decisionOf(label: string): HumanDecision {
  if (label === APPROVE) return 'approved'
  if (label === CHANGES_NEEDED) return 'changes-needed'
  if (label === REJECT) return 'rejected'
  return 'changes-needed'
}

/** 真终端人工门。 */
export class TerminalHumanGate implements HumanGatePort {
  private readonly deps: TerminalHumanGateDeps
  /**
   * 行读取器按门实例**复用**：每个门新建会在流结束后重建 reader，
   * 而 'end' 已错过 → 后续门永远等待。整条流水线共用一个 reader。
   */
  private reader: LineReader | null = null

  constructor(deps: TerminalHumanGateDeps = {}) {
    this.deps = deps
  }

  private ensureReader(input: NodeJS.ReadableStream): LineReader {
    this.reader ??= new LineReader(input)
    return this.reader
  }

  /** 经方法读取以避开 TS 对 readonly 依赖的控制流收窄。 */
  private isAborted(): boolean {
    return this.deps.signal?.aborted === true
  }

  async gate(
    stageId: StageId,
    artifact: StageArtifact,
    gate: JudgeResult,
    review?: { readonly verdict: string; readonly findings: readonly string[] } | undefined,
  ): Promise<HumanDecision> {
    const p = buildGatePresentation(stageId, artifact, gate, review, this.deps.gateLetterByStage)
    return this.ask(stageId, p, { requireReasonUnlessApproved: true })
  }

  async gateFailed(stageId: StageId, gate: JudgeResult): Promise<void> {
    const p = buildGateFailedPresentation(stageId, gate, this.deps.gateLetterByStage)
    try {
      // 升级提示是「确认终止」：无论选哪项，门禁结果成立 → 一律记为 rejected（与 UI 渠道一致）
      await this.ask(stageId, p, { requireReasonUnlessApproved: false, forceAction: 'rejected' })
    } catch (error) {
      // 升级提示不应因取消/无人而崩溃（pipeline 即将以 gate-failed 终止）
      if (error instanceof HumanGateAbortedError) return
      if (error instanceof NoHumanAtConsoleError) return
      throw error
    }
  }

  /** 渲染 → 阻塞读入 → 校验 → 记录。无任何自动兜底。 */
  private async ask(
    stageId: StageId,
    p: GatePresentation,
    opts: { readonly requireReasonUnlessApproved: boolean; readonly forceAction?: HumanDecision },
  ): Promise<HumanDecision> {
    const input = this.deps.input ?? process.stdin
    const output = this.deps.output ?? process.stdout
    const isTty = (input as { isTTY?: boolean }).isTTY === true

    if (!isTty && this.deps.allowNonTty !== true) {
      throw new NoHumanAtConsoleError(
        `人工门 ${p.letter || stageId} 需要真人在场裁决，但当前输入不是 TTY`
        + `（无人值守运行不允许自动批准）。请在带真人的终端中运行，`
        + `或改用 harness 弹窗渠道；若确需自动化驱动本实现，请显式设置 allowNonTty。`,
      )
    }

    // 呈现给真人的材料（与 UI 渠道同源）
    output.write('\n' + '─'.repeat(72) + '\n')
    output.write(`【${p.header}】${p.question}\n`)
    output.write('─'.repeat(72) + '\n')
    output.write(p.detail + '\n')
    output.write('─'.repeat(72) + '\n')
    p.options.forEach((o, i) => {
      output.write(`  ${i + 1}) ${o.label}${o.description ? ` —— ${o.description}` : ''}\n`)
    })
    output.write('─'.repeat(72) + '\n')

    const reader = this.ensureReader(input)
    const askLine = async (prompt: string): Promise<string> => {
      output.write(prompt)
      return reader.readLine(this.deps.signal)
    }

    try {
      if (this.isAborted()) throw new HumanGateAbortedError()

      let choice: number | null = null
      while (choice === null) {
        const raw = await askLine(`请选择 [1-${p.options.length}]（必须输入，无默认值）：`)
        choice = parseChoice(raw, p.options)
        if (choice === null) {
          output.write(`  ✗ 无法识别的输入 ${JSON.stringify(raw.trim())}；请输入 1~${p.options.length} 或选项原文。\n`)
        }
      }

      const label = p.options[choice]!.label
      const decision = opts.forceAction ?? decisionOf(label)

      let note = ''
      if (opts.requireReasonUnlessApproved && decision !== 'approved') {
        // 打回/拒绝必须给出理由——否则重跑无从修起
        while (note.trim() === '') {
          note = await askLine('请填写理由（打回/拒绝必填，将回喂重跑）：')
          if (note.trim() === '') output.write('  ✗ 理由不能为空。\n')
        }
      } else {
        note = await askLine('备注（可回车跳过）：')
      }

      const trimmed = note.trim()
      output.write(`  ✓ 已记录裁决：${label}${trimmed ? `（${trimmed}）` : ''}\n`)

      this.deps.onDecision?.({
        by: this.deps.by ?? 'terminal-human',
        action: decision,
        note: trimmed,
        stageId,
        at: Date.now(),
      })
      return decision
    } catch (error) {
      if (error instanceof HumanGateAbortedError) {
        this.deps.onDecision?.({
          by: this.deps.by ?? 'terminal-human',
          action: 'changes-needed',
          note: '人工门等待被取消（ASK_ABORTED）',
          stageId,
          at: Date.now(),
        })
        return 'changes-needed'
      }
      const msg = error instanceof Error ? error.message : String(error)
      throw new NoHumanAtConsoleError(
        `人工门 ${p.letter || stageId} 未获得真人裁决（未产生任何批准）：${msg}`,
      )
    }
  }
}