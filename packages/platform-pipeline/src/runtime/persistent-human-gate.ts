/**
 * 可恢复人工门适配器（无 Harness 依赖）。
 *
 * `PipelineDriver` 的人工门端口是「阻塞直到返回裁决」的语义；真实平台上裁决人可能
 * 几分钟、几小时甚至跨进程重启之后才出现。`PersistentHumanGate` 把这次等待变成一条
 * 持久化任务，而不是一次内存中的阻塞调用：
 *
 *   create(pending) → 外部 actor claim/decide → 映射为 HumanDecision
 *
 * 三条硬性质：
 * 1. **可恢复**：任务先落盘再等待。续用规则有两条——
 *    - 未决任务：进程崩溃重启后继续等同一个门，不重复弹门；
 *    - 已裁决但未被消费的任务：人工在流水线未运行时完成裁决，下一次 run 直接认这条结论。
 *    裁决一旦被消费（`consumedAt`）就不再复用，因此 `changes-needed` 打回重跑会正确开新门。
 * 2. **绝不自动批准**：等待被中止（AbortSignal / 超时）、任务被外部取消、任务过期时，默认
 *    **抛错**；只有宿主显式配置 `onAborted` / `onExpired` 才会降级为某个裁决。
 *    任何情况下都不会出现「没有人裁决却 approved」。
 * 3. **零框架依赖**：只依赖 `HumanGateTaskStore` 端口；文件实现、数据库实现均可替换。
 *
 * 宿主侧（UI / 值班系统）通过同一个 store 与门交互：
 * ```ts
 * const [task] = await store.list({ pipelineId, status: 'pending' })
 * await store.claim(task.gateTaskId, 'alice', 60_000)
 * await store.decide(task.gateTaskId, 'alice', 'approved', '')
 * ```
 *
 * @module platform-pipeline/runtime/persistent-human-gate
 */

import { setTimeout as delay } from 'node:timers/promises'

import type { HumanDecision, HumanGatePort, ReviewOutcome } from '../driver.ts'
import type { JudgeResult } from '../gates/machine.ts'
import type { StageArtifact, StageId } from '../types.ts'
import { newTaskId, type HumanGateTask, type HumanGateTaskStore } from './persistence.ts'

/** 默认人工门任务有效期：24 小时（超时后任务转为 expired，不再可裁决）。 */
export const DEFAULT_GATE_TASK_TTL_MS = 24 * 60 * 60 * 1000
/** 默认轮询间隔。 */
export const DEFAULT_GATE_POLL_INTERVAL_MS = 500

const DECIDED_STATUSES: readonly HumanGateTask['status'][] = ['approved', 'changes-needed', 'rejected']

const ABORT_DETAIL: Readonly<Record<'signal' | 'cancelled' | 'timeout', string>> = {
  signal: 'waiting aborted by signal',
  cancelled: 'gate task cancelled externally',
  timeout: 'waiting exceeded waitTimeoutMs; task stays open for the next run',
}

/** 等待被中止（信号取消、任务被外部取消，或等待超过上限）。 */
export class HumanGateWaitAbortedError extends Error {
  readonly gateTaskId: string
  readonly stageId: StageId
  /**
   * 'signal' = 等待被 AbortSignal 中止；'cancelled' = 任务被外部显式取消；
   * 'timeout' = 等待超过 waitTimeoutMs（宿主主动让出控制权，任务仍保持未决）。
   */
  readonly reason: 'signal' | 'cancelled' | 'timeout'

  constructor(input: { readonly gateTaskId: string; readonly stageId: StageId; readonly reason: 'signal' | 'cancelled' | 'timeout'; readonly detail: string }) {
    super(`human gate ${input.stageId} aborted (${input.reason}): ${input.detail}`)
    this.name = 'HumanGateWaitAbortedError'
    this.gateTaskId = input.gateTaskId
    this.stageId = input.stageId
    this.reason = input.reason
  }
}

/** 任务到达 expiresAt 仍无裁决。 */
export class HumanGateExpiredError extends Error {
  readonly gateTaskId: string
  readonly stageId: StageId
  readonly expiresAt: number | undefined

  constructor(input: { readonly gateTaskId: string; readonly stageId: StageId; readonly expiresAt: number | undefined }) {
    super(`human gate ${input.stageId} expired without a decision: ${input.gateTaskId}`)
    this.name = 'HumanGateExpiredError'
    this.gateTaskId = input.gateTaskId
    this.stageId = input.stageId
    this.expiresAt = input.expiresAt
  }
}

/** 人工门裁决审计记录（宿主可据此落审计/通知）。 */
export interface PersistentGateAuditRecord {
  readonly gateTaskId: string
  readonly stageId: StageId
  readonly by: string
  readonly action: HumanDecision
  readonly note: string
  readonly at: number
}

/**
 * 等待中止/过期时的降级策略。
 * 类型层排除了 `'approved'`：宿主可以决定「中止即打回」或「中止即拒绝」，
 * 但无法配置「中止即批准」——自动批准在这条路径上不可表达。
 */
export type GateDegradePolicy = 'changes-needed' | 'rejected' | 'throw'

export interface PersistentHumanGateOptions {
  readonly store: HumanGateTaskStore
  readonly projectId: string
  readonly pipelineId: string
  readonly tenantId?: string
  /** 人工门任务有效期（毫秒）；默认 24 小时。 */
  readonly taskTtlMs?: number
  /** 轮询间隔（毫秒）；默认 500。 */
  readonly pollIntervalMs?: number
  /**
   * 单次等待上限（毫秒）。到点仍未裁决则按 `onAborted` 处理（默认抛
   * `HumanGateWaitAbortedError`，reason `'timeout'`），**任务保持未决**，下次调用会续上。
   * 传 `0` = 只轮询一次就让出控制权（CLI 的「挂起等人工」模式）。
   * 缺省不限。
   */
  readonly waitTimeoutMs?: number
  /**
   * 任务创建/挂起后的回调（宿主据此通知 UI、发事件、写值班队列）。
   * 恢复既有未决任务时**不会**重复触发。
   */
  readonly onPending?: (task: HumanGateTask) => unknown
  /** 裁决（或升级确认）落地后的审计回调。 */
  readonly onDecision?: (record: PersistentGateAuditRecord) => unknown
  /** 中止信号；中止后不再阻塞等待人工。 */
  readonly signal?: AbortSignal
  /**
   * 可注入的等待实现。默认真实计时；测试可传空实现，事件驱动的宿主也可借此把
   * 「轮询」换成文件监听/消息订阅（在 ms 超时前 resolve 即可）。
   */
  readonly sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
  /** 可注入时钟（测试用）。 */
  readonly now?: () => number
  /** 等待被中止时的策略；默认 'throw'（绝不自动批准）。 */
  readonly onAborted?: GateDegradePolicy
  /** 任务过期时的策略；默认 'throw'（绝不自动批准）。 */
  readonly onExpired?: GateDegradePolicy
  /**
   * `gateFailed` 是否阻塞等待人工确认。默认 `false`：此时只落一条升级任务供
   * UI/值班队列消费，流水线立即以 gate-failed 终止（与 driver 语义一致）。
   */
  readonly waitOnGateFailed?: boolean
}

type GateResolution =
  | { readonly kind: 'decided'; readonly task: HumanGateTask; readonly decision: NonNullable<HumanGateTask['decision']> }
  | { readonly kind: 'aborted'; readonly task: HumanGateTask; readonly reason: 'signal' | 'cancelled' | 'timeout' }
  | { readonly kind: 'expired'; readonly task: HumanGateTask }
  | { readonly kind: 'waiting' }

/**
 * 持久化人工门：把 driver 的阻塞式 `human.gate()` 变成可恢复的任务等待。
 *
 * 同一个 pipeline 的同一阶段在同一产物上只会有一条未决任务；因此进程重启、
 * 宿主重新拉起流水线时，等待是**续上**的，而不是重新发起一次审核。
 */
export class PersistentHumanGate implements HumanGatePort {
  private readonly options: PersistentHumanGateOptions
  private readonly taskTtlMs: number
  private readonly pollIntervalMs: number
  private readonly waitTimeoutMs: number | undefined
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>
  private readonly now: () => number
  private readonly onAborted: GateDegradePolicy
  private readonly onExpired: GateDegradePolicy

  constructor(options: PersistentHumanGateOptions) {
    if (options.projectId.trim() === '') throw new Error('PersistentHumanGate requires a non-empty projectId')
    if (options.pipelineId.trim() === '') throw new Error('PersistentHumanGate requires a non-empty pipelineId')

    this.taskTtlMs = options.taskTtlMs ?? DEFAULT_GATE_TASK_TTL_MS
    assertPositiveInteger(this.taskTtlMs, 'taskTtlMs')
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_GATE_POLL_INTERVAL_MS
    assertPositiveInteger(this.pollIntervalMs, 'pollIntervalMs')
    if (options.waitTimeoutMs !== undefined && (!Number.isSafeInteger(options.waitTimeoutMs) || options.waitTimeoutMs < 0)) {
      throw new Error('waitTimeoutMs must be a non-negative integer')
    }
    this.waitTimeoutMs = options.waitTimeoutMs

    this.options = options
    this.sleep = options.sleep ?? defaultSleep
    this.now = options.now ?? (() => Date.now())
    this.onAborted = options.onAborted ?? 'throw'
    this.onExpired = options.onExpired ?? 'throw'
  }

  async gate(stageId: StageId, artifact: StageArtifact, gate: JudgeResult, review?: ReviewOutcome): Promise<HumanDecision> {
    const task = await this.openTask(stageId, artifact, gate, review)
    const resolution = await this.waitForResolution(task)

    switch (resolution.kind) {
      case 'decided': {
        // 先消费再返回：一条裁决只能驱动一次门。若此处之后进程崩溃、检查点尚未推进，
        // 下一次 run 会重新开一条门再问一次——方向安全（宁可多问一次，绝不自动批准）。
        await this.consumeTask(resolution.task)
        await this.options.onDecision?.({
          gateTaskId: resolution.task.gateTaskId,
          stageId,
          by: resolution.decision.by,
          action: resolution.decision.action,
          note: resolution.decision.note,
          at: resolution.decision.at,
        })
        return resolution.decision.action
      }
      case 'aborted':
        return this.applyAbortedPolicy(new HumanGateWaitAbortedError({
          gateTaskId: resolution.task.gateTaskId,
          stageId,
          reason: resolution.reason,
          detail: ABORT_DETAIL[resolution.reason],
        }))
      case 'expired':
        return this.applyExpiredPolicy(new HumanGateExpiredError({
          gateTaskId: resolution.task.gateTaskId,
          stageId,
          expiresAt: resolution.task.expiresAt,
        }))
      default:
        throw new Error(`unreachable gate resolution for stage ${stageId}`)
    }
  }

  async gateFailed(stageId: StageId, gate: JudgeResult): Promise<void> {
    const task = await this.createTask({
      prefix: 'gate-failed',
      stageId,
      // 升级任务不对应具体产物：既不会参与 gate() 的恢复匹配，也不允许被误当阶段门批准。
      artifactPath: '',
      machineStatus: 'failed',
      violations: gate.violations.map(v => ({ rule: v.rule, level: v.level, detail: v.detail })),
    })

    if (this.options.waitOnGateFailed !== true) return

    // 流水线此刻已经以 gate-failed 终止；升级等待失败不应把异常再抛给 driver。
    try {
      const resolution = await this.waitForResolution(task)
      const decided = resolution.kind === 'decided' ? resolution.decision : undefined
      if (decided !== undefined) await this.consumeTask(task)
      await this.options.onDecision?.({
        gateTaskId: task.gateTaskId,
        stageId,
        by: decided?.by ?? 'system',
        action: decided?.action ?? 'rejected',
        note: decided?.note ?? `gate-failed 升级未获确认（${resolution.kind}）`,
        at: decided?.at ?? this.now(),
      })
    } catch (error) {
      await this.options.onDecision?.({
        gateTaskId: task.gateTaskId,
        stageId,
        by: 'system',
        action: 'rejected',
        note: `gate-failed 升级等待中止：${errorMessage(error)}`,
        at: this.now(),
      })
    }
  }

  // ── 任务创建与恢复 ──────────────────────────────────────────────────────────

  /** 续上未决任务；没有则新建。这是「可恢复」的关键：重启后不会重复弹门。 */
  private async openTask(stageId: StageId, artifact: StageArtifact, gate: JudgeResult, review?: ReviewOutcome): Promise<HumanGateTask> {
    const resumed = await this.findResumableTask(stageId, artifact.path)
    if (resumed !== null) return resumed

    return this.createTask({
      prefix: 'gate',
      stageId,
      artifactPath: artifact.path,
      machineStatus: gate.status === 'passed' ? 'passed' : 'failed',
      violations: gate.violations.map(v => ({ rule: v.rule, level: v.level, detail: v.detail })),
      ...(review === undefined ? {} : { review }),
    })
  }

  private async createTask(input: {
    readonly prefix: string
    readonly stageId: StageId
    readonly artifactPath: string
    readonly machineStatus: 'passed' | 'failed'
    readonly violations: readonly { rule: string; level: 'BLOCKING' | 'WARNING'; detail: string }[]
    readonly review?: ReviewOutcome
  }): Promise<HumanGateTask> {
    const task = await this.options.store.create({
      gateTaskId: newTaskId(input.prefix),
      ...(this.options.tenantId === undefined ? {} : { tenantId: this.options.tenantId }),
      projectId: this.options.projectId,
      pipelineId: this.options.pipelineId,
      stageId: input.stageId,
      status: 'pending',
      artifactPath: input.artifactPath,
      machineStatus: input.machineStatus,
      machineViolations: input.violations,
      ...(input.review === undefined ? {} : { review: { verdict: input.review.verdict, findings: [...input.review.findings] } }),
      expiresAt: this.now() + this.taskTtlMs,
    })
    await this.options.onPending?.(task)
    return task
  }

  /**
   * 查找本 pipeline 该阶段上可续用的门任务。可续用 = 两类：
   * - **未决**（pending/claimed 且未过期）：进程崩溃重启后继续等同一个门；
   * - **已裁决但尚未被消费**：人工在流水线未运行时完成了裁决，下一次 run 必须认这条结论
   *   （否则「挂起 → 裁决 → 续跑」会丢掉真人裁决，重新开一个空门）。
   *
   * 已消费、已过期、已取消的任务都不可续用 —— 前者防止 `changes-needed` 打回重跑空转，
   * 后两者要求宿主显式重入而不是静默重开。
   *
   * 要求 `machineStatus === 'passed'` 且产物路径一致：gateFailed 升级任务
   * （`failed` + 空路径）因此永远不会被 gate() 误当作阶段门。
   */
  private async findResumableTask(stageId: StageId, artifactPath: string): Promise<HumanGateTask | null> {
    const now = this.now()
    const tasks = await this.options.store.list({ pipelineId: this.options.pipelineId })
    const open = tasks.find(task => task.stageId === stageId
      && task.machineStatus === 'passed'
      && task.artifactPath === artifactPath
      && isResumable(task, now))
    return open ?? null
  }

  /** 消费裁决，使其不能再次驱动门。 */
  private async consumeTask(task: HumanGateTask): Promise<void> {
    if (task.consumedAt !== undefined) return
    await this.options.store.consume(task.gateTaskId, this.now())
  }

  // ── 等待与裁决 ──────────────────────────────────────────────────────────────

  private async waitForResolution(task: HumanGateTask): Promise<GateResolution> {
    let current = task
    const deadline = this.waitTimeoutMs === undefined ? undefined : this.now() + this.waitTimeoutMs
    for (;;) {
      const resolution = await this.inspect(current)
      if (resolution.kind !== 'waiting') return resolution

      if (this.aborted()) {
        return { kind: 'aborted', task: await this.cancelTask(current, 'aborted by signal'), reason: 'signal' }
      }
      if (deadline !== undefined && this.now() >= deadline) {
        // 让出控制权但**不取消任务**：裁决人仍可继续裁决，下次调用会续上等待。
        return { kind: 'aborted', task: current, reason: 'timeout' }
      }

      try {
        await this.sleep(this.pollIntervalMs, this.options.signal)
      } catch (error) {
        if (this.aborted()) {
          return { kind: 'aborted', task: await this.cancelTask(current, 'aborted while waiting'), reason: 'signal' }
        }
        throw error
      }

      const next = await this.options.store.get(current.gateTaskId)
      if (next === null) throw new Error(`human gate task disappeared while waiting: ${current.gateTaskId}`)
      current = next
    }
  }

  /** 判定一次当前任务状态；任务已到 expiresAt 时先落盘为 expired 再返回。 */
  private async inspect(task: HumanGateTask): Promise<GateResolution> {
    let current = task
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const settled = settledResolution(current)
      if (settled !== null) return settled

      const expiresAt = current.expiresAt
      if (expiresAt === undefined || expiresAt > this.now()) return { kind: 'waiting' }

      await this.options.store.expire(this.now())
      const swept = await this.options.store.get(current.gateTaskId)
      if (swept === null) throw new Error(`human gate task disappeared while expiring: ${current.gateTaskId}`)
      current = swept
    }
    throw new Error(`human gate task could not be expired: ${task.gateTaskId}`)
  }

  /** 尽力把未决任务标记为 cancelled；已裁决/已终态或 store 不支持时保持原状。 */
  private async cancelTask(task: HumanGateTask, note: string): Promise<HumanGateTask> {
    const store = this.options.store
    if (store.cancel === undefined) return task
    const current = await store.get(task.gateTaskId)
    if (current === null) return task
    if (current.status !== 'pending' && current.status !== 'claimed') return current
    return store.cancel(task.gateTaskId, 'system', note)
  }

  private applyAbortedPolicy(error: HumanGateWaitAbortedError): HumanDecision {
    if (this.onAborted === 'throw') throw error
    return this.onAborted
  }

  /** 单独取一次信号状态：避免 TS 把 `signal.aborted` 收窄成常量而漏掉 sleep 期间的中止。 */
  private aborted(): boolean {
    return this.options.signal?.aborted === true
  }

  private applyExpiredPolicy(error: HumanGateExpiredError): HumanDecision {
    if (this.onExpired === 'throw') throw error
    return this.onExpired
  }
}

function settledResolution(task: HumanGateTask): GateResolution | null {
  if (DECIDED_STATUSES.includes(task.status)) {
    if (task.decision === undefined) throw new Error(`human gate task ${task.gateTaskId} is ${task.status} without a decision record`)
    return { kind: 'decided', task, decision: task.decision }
  }
  if (task.status === 'cancelled') return { kind: 'aborted', task, reason: 'cancelled' }
  if (task.status === 'expired') return { kind: 'expired', task }
  return null
}

/** 可续用的任务：未决且未过期，或已裁决但尚未被消费。 */
function isResumable(task: HumanGateTask, now: number): boolean {
  if (task.status === 'pending' || task.status === 'claimed') {
    return task.expiresAt === undefined || task.expiresAt > now
  }
  if (DECIDED_STATUSES.includes(task.status)) return task.consumedAt === undefined
  return false
}

async function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  await delay(ms, undefined, signal === undefined ? {} : { signal })
}

function assertPositiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
