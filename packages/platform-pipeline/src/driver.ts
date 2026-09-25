/**
 * PipelineDriver：编排核心（docs/09 第 2 节 / docs/03 第 2 节）。
 * 用户命令直接驱动的纯代码循环（D-20）：
 * 恢复续跑 → 逐阶段 { spawn → 机器门禁 → 交叉检查 → 人工门 } → 检查点推进 → 重入。
 * 所有副作用通过注入端口（spawn/gates/human/review/artifacts/checkpoint）隔离，
 * 因此可在无 harness 运行时下单测。
 * @module platform-pipeline/driver
 */

import { initialCheckpoint } from './checkpoint.ts'
import { stageRunContext, type SpawnedRun, type StageSpawner } from './stage-spawner.ts'
import { MachineGateEngine, computeArtifactDigest, type JudgeResult } from './gates/machine.ts'
import { StageBudgetExceededError, recordUsage, usageErrorCode, type UsageRecordInput, type UsageSink } from './usage.ts'
import type { ExecutionSession } from './executor/executor.ts'
import {
  STAGE_ORDER,
  STAGE_UPSTREAMS,
  type Checkpoint,
  type PipelineConfig,
  type StageArtifact,
  type StageId,
  type StageState,
} from './types.ts'

export type HumanDecision = 'approved' | 'changes-needed' | 'rejected'

export interface ReviewOutcome {
  readonly verdict: 'pass' | 'conditional' | 'fail' | 'degraded'
  readonly findings: readonly string[]
}

export interface HumanGatePort {
  /** 人工门（block）：返回裁决。 */
  gate(stageId: StageId, artifact: StageArtifact, gate: JudgeResult, review?: ReviewOutcome): Promise<HumanDecision>
  /** gate-failed 升级人工（门禁重试耗尽，D-01 二次机器判定由宿主实现）。 */
  gateFailed(stageId: StageId, gate: JudgeResult): Promise<void>
}

/** 交叉检查端口（docs/03 第 7 节）：宿主实现为独立审核 agent spawn。 */
export interface ReviewRunner {
  run(stageId: StageId, artifact: StageArtifact, gate: JudgeResult): Promise<ReviewOutcome>
}

/** 产物读写端口（宿主实现为 fs）。 */
export interface ArtifactStore {
  read(path: string): Promise<StageArtifact | null>
  /** 可选：将宿主补全后的 wrapper 元数据持久化，保证重启后 digest/inputs 不漂移。 */
  write?(artifact: StageArtifact): Promise<void>
}

export interface CheckpointPort {
  load(root: string): Promise<Checkpoint | null>
  save(root: string, checkpoint: Checkpoint): Promise<void>
}

/** executor 执行数据加载（R4-08/09/10 用；宿主从 executor 写入的记录/证据文件读取）。 */
export interface ExecutionLoader {
  load(stageId: StageId, pipelineId: string): Promise<ExecutionSession | undefined>
}

export interface DriverOptions {
  readonly cfg: PipelineConfig
  readonly pipelineId: string
  readonly root: string
  readonly rulesetVersion: string
  readonly spawn: StageSpawner
  readonly gates: MachineGateEngine
  readonly human: HumanGatePort
  readonly artifacts: ArtifactStore
  readonly checkpoint: CheckpointPort
  readonly review?: ReviewRunner
  /** execute 阶段门禁需要 executor 执行数据（R4-08/09/10）。 */
  readonly execution?: ExecutionLoader
  /** receive 阶段的输入文件路径（降级链末级；传给 receive agent 读取）。 */
  readonly receiveInput?: string
  /** 门禁语义重试次数（docs/01 ET-01：默认 2）。作为阶段重试预算的**上限**，实际取 `min(本值, budget.maxRetries)`。 */
  readonly maxGateRetries?: number
  /** 取消信号（供后台可续跑等待复用 child 时观察；docs/09 验证点 5）。 */
  readonly signal?: AbortSignal
  /**
   * 用量落点（docs/10 §7.3）。缺省 = 不计量。
   *
   * driver 负责三类事件的落盘：`gate`（人工门等待时长，不计入模型预算但要计入运行耗时）、
   * `checkpoint`（每次检查点保存耗时）、以及预算超限时的失败事实（写进检查点，不写用量日志）。
   */
  readonly usage?: UsageSink
  /** 时钟注入（测试要断言确定性的时长）。 */
  readonly now?: () => number
}

export type RunOutcome =
  | { readonly outcome: 'completed' }
  | { readonly outcome: 'rejected' | 'gate-failed' | 'review-failed'; readonly stageId: StageId }

const MAX_GATE_RETRIES = 2
const MAX_REVIEW_RETRIES = 1

/**
 * 预算超限时写入检查点的机器规则 id（docs/10 §7.3「超过 budget.maxSteps 立即停止并写入
 * budget-exceeded」）。
 *
 * 复用 `gate-failed` 这条既有终态路径而不是新造状态：它已经把「阶段失败」表达成
 * **不可当阶段门批准**的升级任务（`PersistentHumanGate.gateFailed` 开出的任务
 * `artifactPath` 为空、`machineStatus=failed`，不满足 `findResumableTask`），
 * 因此"不自动进入人工批准"是机器保证，不靠自觉。
 */
const BUDGET_EXCEEDED_RULE = 'R-BUDGET-EXCEEDED'

/** 编排核心。 */
export class PipelineDriver {
  private readonly options: DriverOptions
  private readonly maxGateRetries: number
  private readonly now: () => number

  constructor(options: DriverOptions) {
    this.options = options
    this.maxGateRetries = options.maxGateRetries ?? MAX_GATE_RETRIES
    this.now = options.now ?? (() => Date.now())
  }

  async run(): Promise<RunOutcome> {
    let cp = await this.options.checkpoint.load(this.options.root)
      ?? initialCheckpoint(this.options.pipelineId, this.options.cfg.templateVersion, this.options.rulesetVersion)

    while (cp.cursor < STAGE_ORDER.length) {
      const stageId = STAGE_ORDER[cp.cursor]!
      let state = cp.stageStates[stageId]!

      if (state.status === 'done') {
        cp = await this.advance(cp, stageId)
        continue
      }

      const runCtx = stageRunContext(stageId, cp)
      const inputPaths = this.inputPathsOf(stageId, cp)
      const inputDigests = await this.inputDigestsOf(stageId, cp)

      // 人工门等待中重启（docs/03 第 8 节）：产物已在盘上、审核结论已随人工门任务持久化，
      // 因此**不重新 spawn**，直接复用既有产物重新过门禁并回到人工门。否则每次重启都会
      // 重复消耗模型预算、并把已被真人审核过的产物覆盖成新版本（审核对象与批准对象错位）。
      const parked = await this.resumableAtGate(state)
      let spawned: SpawnedRun
      try {
        if (parked) {
          spawned = { stageId, artifactPath: state.artifact }
        } else if (state.childSessionId !== undefined && this.options.spawn.waitContinuable !== undefined
            && !this.isReSpawnState(state.status)) {
          // 恢复续跑（docs/09 验证点 5）：复用既有后台 child，不重复 spawn。
          await this.options.spawn.waitContinuable(state.childSessionId, this.options.signal)
          spawned = { stageId, artifactPath: state.artifact, childId: state.childSessionId }
        } else {
          spawned = await this.options.spawn.runStage({
            stageId,
            pipelineId: this.options.pipelineId,
            inputPaths,
            inputDigests,
            artifactPath: state.artifact,
            mode: stageId === 'execute' ? 'continuable' : 'oneshot',
            ...(runCtx.extra === undefined ? {} : { extraContext: runCtx.extra }),
            previousViolations: state.gate.machine.violations.length === 0 ? undefined : state.gate.machine.violations,
          }, this.options.cfg)
          if (spawned.childId !== undefined) {
            cp = await this.update(cp, stageId, { childSessionId: spawned.childId })
            state = cp.stageStates[stageId]!
          }
        }
      } catch (error) {
        // 预算超限（docs/10 §7.3）：立即停止、落盘成 `budget-exceeded`，**不重试**
        // ——同一份预算再跑一遍只会再烧一次模型；也绝不自动进入人工批准。
        if (error instanceof StageBudgetExceededError) {
          return await this.failOnBudgetExceeded(cp, stageId, error)
        }
        throw error
      }

      // 读取产物。损坏（非法 JSON）与缺失都按「阶段失败」处理，走与机器门禁失败
// 完全相同的重试路径（违规清单回喂 → agent 重做 → 重判），而不是让整条流水线
// 以一句 SyntaxError 崩掉。实测：execute 阶段 agent 在字符串里嵌了未转义的
// 双引号，产物非法 JSON，旧行为直接把整个 run 打断，既没重试也没到人工门。
      let artifact: StageArtifact | null = null
      let unreadable: string | undefined
      try {
        artifact = await this.options.artifacts.read(spawned.artifactPath)
      } catch (error) {
        unreadable = error instanceof Error ? error.message : String(error)
      }
      if (artifact === null || unreadable !== undefined) {
        const detail = unreadable !== undefined
          ? `阶段产物不是合法 JSON（${unreadable}）：请以合法 JSON 重写 ${spawned.artifactPath}；`
            + '特别注意字符串内部的双引号必须转义（\\"），否则会切断字符串。'
          : `阶段未产出产物：${spawned.artifactPath}`
        const violation = { rule: 'R-ARTIFACT-READABLE', level: 'BLOCKING' as const, detail, at: Date.now() }
        const machine = {
          ...state.gate.machine,
          status: 'failed' as const,
          violations: [violation],
          attempts: state.gate.machine.attempts + 1,
        }
        if (state.gate.machine.attempts < this.gateRetryLimit(stageId)) {
          cp = await this.update(cp, stageId, { status: 'needs-fix', gate: { ...state.gate, machine } })
          continue // 违规清单经 stageRunContext 回喂重跑
        }
        cp = await this.update(cp, stageId, { status: 'gate-failed', gate: { ...state.gate, machine } })
        await this.options.human.gateFailed(stageId, machine)
        return { outcome: 'gate-failed', stageId }
      }
      const upstreams = await this.loadUpstreams(stageId, cp)
      // 宿主填充输入摘要锁（G-08）：优先用检查点持久化的 inputs（冻结），首次运行从当前上游填充
      const persisted = cp.stageStates[stageId]!.inputs
      const hasPersisted = persisted !== undefined && Object.keys(persisted).length > 0
      const filled = hasPersisted
        ? { ...artifact, inputs: persisted, digest: cp.stageStates[stageId]!.digest || computeArtifactDigest({ ...artifact, inputs: persisted }) }
        : this.fillInputLocks(artifact, upstreams)
      if (this.options.artifacts.write !== undefined) {
        await this.options.artifacts.write(filled)
      }

      // 1. 机器门禁（全量重判；G-08 摘要锁在此拦截级联失效；R4-08/09/10 需 executor 执行数据）
      const execution = await this.options.execution?.load(stageId, this.options.pipelineId)
      const configuredRules = this.options.cfg.stages[stageId]!.rules
      const ruleIds = this.options.gates.validateRuleIds(configuredRules).length === 0 ? configuredRules : undefined
      const gate = this.options.gates.judge(
        stageId,
        filled,
        upstreams,
        state.gate.machine.attempts + 1,
        execution,
        ruleIds,
      )
      if (gate.status === 'failed') {
        if (state.gate.machine.attempts < this.gateRetryLimit(stageId)) {
          cp = await this.update(cp, stageId, {
            status: 'needs-fix',
            gate: { ...state.gate, machine: { ...gate, attempts: state.gate.machine.attempts + 1 } },
          })
          continue // 违规清单经 stageRunContext 回喂重跑
        }
        cp = await this.update(cp, stageId, {
          status: 'gate-failed',
          gate: { ...state.gate, machine: { ...gate, attempts: state.gate.machine.attempts + 1 } },
        })
        await this.options.human.gateFailed(stageId, gate)
        return { outcome: 'gate-failed', stageId }
      }

      // 2. 交叉检查（analyze/design/execute/report 开启；docs/03 第 7 节）
      //    恢复等待中的门时不重复审核：上次的 verdict/findings 已随人工门任务持久化，
      //    重复审核既浪费一次盲审预算，也可能让「真人正在看的那份结论」被新结论替换。
      let review: ReviewOutcome | undefined
      if (!parked && this.options.cfg.stages[stageId]!.review.enabled && this.options.review !== undefined) {
        review = await this.options.review.run(stageId, artifact, gate)
        if (review.verdict === 'fail') {
          const retried = state.failures.filter(f => f.kind === 'review-fail').length
          if (retried < this.reviewRetryLimit(stageId)) {
            cp = await this.update(cp, stageId, {
              status: 'needs-fix',
              failures: [
                ...state.failures,
                { kind: 'review-fail', at: Date.now(), rule: 'review', detail: review.findings.join('\n') },
              ],
            })
            continue // findings 经 stageRunContext 回喂重跑（≤1 次）
          }
          return { outcome: 'review-failed', stageId }
        }
        if (review.verdict === 'degraded') {
          cp = await this.update(cp, stageId, { reviewDegraded: true })
          state = cp.stageStates[stageId]!
        }
      }

      // 3. 人工门（block；D-01 二次机器判定由宿主 human 实现）
      cp = await this.update(cp, stageId, { status: 'awaiting-gate' })
      state = cp.stageStates[stageId]!
      // 等待时长单独计量（docs/10 §7.2）：人工门等待**不计入模型预算**，但要计入运行耗时，
      // 因此它记成 `kind: 'gate'` 而不是混进 llm/tool。
      const gateStartedAt = this.now()
      let decision: HumanDecision
      try {
        decision = await this.options.human.gate(stageId, artifact, gate, review)
      } catch (error) {
        await this.record({ stageId, kind: 'gate', startedAt: gateStartedAt, finishedAt: this.now(), success: false, errorCode: usageErrorCode(error) })
        throw error
      }
      await this.record({ stageId, kind: 'gate', startedAt: gateStartedAt, finishedAt: this.now(), success: true })
      if (decision === 'rejected') return { outcome: 'rejected', stageId } // 状态保留 awaiting-gate（产物保留，可重入）
      if (decision === 'changes-needed') {
        cp = await this.update(cp, stageId, {
          status: 'needs-fix',
          gate: { ...state.gate, human: { state: 'changes-needed', records: state.gate.human.records } },
        })
        continue
      }

      // 4. 推进（持久化 digest+inputs 供 G-08 跨运行级联）
      cp = await this.update(cp, stageId, {
        status: 'done',
        digest: filled.digest,
        inputs: filled.inputs,
        reviewDegraded: state.reviewDegraded,
        gate: { ...state.gate, human: { state: 'approved', records: state.gate.human.records } },
      })
      cp = await this.advance(cp, stageId)
    }
    return { outcome: 'completed' }
  }

  /** 重入（docs/03 第 8 节）：cursor 回退到该阶段，该阶段及全部下游标记 needs-reentry。 */
  async reenter(stageId: StageId, by: string, reason: string): Promise<Checkpoint> {
    let cp = await this.options.checkpoint.load(this.options.root)
      ?? initialCheckpoint(this.options.pipelineId, this.options.cfg.templateVersion, this.options.rulesetVersion)
    const index = STAGE_ORDER.indexOf(stageId)
    if (index < 0) throw new Error(`reenter: unknown stage "${stageId}"`)

    const stageStates = { ...cp.stageStates }
    for (const id of STAGE_ORDER) {
      if (STAGE_ORDER.indexOf(id) < index) continue
      const s = stageStates[id]!
      stageStates[id] = {
        ...s,
        status: 'needs-reentry',
        // 重入 = 全新生命周期（docs/03 第 8.2 节 [6]"全新 spawn"）：
        // - 输入摘要锁解锁：重跑时按当前上游重新锁定（G-08 复验）；否则下游
        //   持久化的旧 digest 会把级联重跑永久 BLOCKING（锁只对未重跑阶段生效）；
        // - 机器门禁归零：不把上一周期的违规清单回喂进重入 prompt；
        // - 人工门重开（docs/03 第 8.6 节），批准记录保留作审计；
        // - review 失败计数清零：重入后交叉检查重试预算重新开始。
        inputs: {},
        digest: '',
        failures: [],
        gate: {
          machine: { status: 'passed', attempts: 0, violations: [] },
          human: { state: 'open', records: s.gate.human.records },
        },
        // 旧产物归档进 history（docs/03 第 8.4 节），保留审计
        history: s.digest === '' ? s.history : [...s.history, { digest: s.digest, capturedAt: Date.now() }],
      }
    }
    cp = {
      ...cp,
      cursor: index,
      stageStates,
      reentries: [
        ...cp.reentries,
        {
          stageId, by, at: Date.now(), reason,
          cascade: true,
          cursorBefore: cp.cursor, cursorAfter: index,
        },
      ],
    }
    await this.options.checkpoint.save(this.options.root, cp)
    return cp
  }

  // ── 私有辅助 ────────────────────────────────────────────────────────────────

  private inputPathsOf(stageId: StageId, cp: Checkpoint): Readonly<Record<string, string>> {
    if (stageId === 'receive' && this.options.receiveInput !== undefined) {
      return { input: this.options.receiveInput }
    }
    const out: Record<string, string> = {}
    for (const upstream of STAGE_UPSTREAMS[stageId]!) {
      out[upstream] = cp.stageStates[upstream]!.artifact
    }
    return out
  }

  /**
   * 上游产物的权威 digest（供 prompt 注入，让 agent 原样抄写）。
   *
   * 口径与机器门禁**同源**：直接取自 `loadUpstreams`（即 ArtifactStore.read 的结果，
   * 磁盘口径重算、可检出事后改文件——docs/08「digest 可重算」）。若改用检查点里
   * 冻结的 digest，注入值与门禁重算值会分属两套口径，且会丧失篡改检测。
   */
  private async inputDigestsOf(stageId: StageId, cp: Checkpoint): Promise<Readonly<Record<string, string>>> {
    const upstreams = await this.loadUpstreams(stageId, cp)
    const out: Record<string, string> = {}
    for (const upstream of STAGE_UPSTREAMS[stageId] ?? []) {
      const digest = upstreams[upstream]?.digest
      if (digest !== undefined && digest !== '') out[upstream] = digest
    }
    return out
  }

  /** 加载当前阶段之前的全部产物（传递性上游，供 R3-01 等规则读取 receive 需求清单）。 */
  private async loadUpstreams(stageId: StageId, cp: Checkpoint): Promise<Readonly<Record<string, StageArtifact>>> {
    const out: Record<string, StageArtifact> = {}
    const currentIndex = STAGE_ORDER.indexOf(stageId)
    for (let i = 0; i < currentIndex; i++) {
      const upstream = STAGE_ORDER[i]!
      const artifact = await this.options.artifacts.read(cp.stageStates[upstream]!.artifact)
      if (artifact !== null) out[upstream] = artifact
    }
    return out
  }

  /** 宿主填充输入摘要锁（G-08）：为缺失的上游 digest 补全并重算 digest（上游变更 → 下次判定自动 BLOCKING）。 */
  private fillInputLocks(artifact: StageArtifact, upstreams: Readonly<Record<string, StageArtifact>>): StageArtifact {
    let changed = false
    const inputs = { ...artifact.inputs }
    for (const upstream of STAGE_UPSTREAMS[artifact.stageId] ?? []) {
      if (inputs[upstream] !== undefined) continue
      const digest = upstreams[upstream]?.digest
      if (digest === undefined) continue
      inputs[upstream] = digest
      changed = true
    }
    if (!changed) return artifact
    const base = { ...artifact, inputs }
    return { ...base, digest: computeArtifactDigest(base) }
  }

  private async update(cp: Checkpoint, stageId: StageId, patch: Partial<StageState>): Promise<Checkpoint> {
    const next: Checkpoint = {
      ...cp,
      stageStates: {
        ...cp.stageStates,
        [stageId]: { ...cp.stageStates[stageId]!, ...patch },
      },
    }
    await this.save(next, stageId)
    return next
  }

  private async advance(cp: Checkpoint, stageId: StageId): Promise<Checkpoint> {
    const next: Checkpoint = { ...cp, cursor: cp.cursor + 1 }
    await this.save(next, stageId)
    return next
  }

  /**
   * 保存检查点并记一条 `checkpoint` 用量事件。
   *
   * 落盘失败照常抛出（检查点是唯一事实，写不进去必须让调用方知道），
   * 但失败事件先记下来——否则"检查点保存很慢/一直失败"在用量视图里完全不可见。
   */
  private async save(cp: Checkpoint, stageId: StageId): Promise<void> {
    const startedAt = this.now()
    try {
      await this.options.checkpoint.save(this.options.root, cp)
      await this.record({ stageId, kind: 'checkpoint', startedAt, finishedAt: this.now(), success: true })
    } catch (error) {
      await this.record({ stageId, kind: 'checkpoint', startedAt, finishedAt: this.now(), success: false, errorCode: usageErrorCode(error) })
      throw error
    }
  }

  /** 记一条用量事件；未注入 sink 时是空操作（计量是尽力而为的观测）。 */
  private async record(input: UsageRecordInput): Promise<void> {
    await recordUsage(this.options.usage, input)
  }

  /**
   * 该阶段的门禁重试上限 = `min(全局上限, budget.maxRetries)`（docs/10 §7.1：把
   * `maxRetries` 从"只写进 prompt"变成真实运行约束）。
   *
   * 取 `min` 而不是直接替换：全局上限表达部署方的兜底意图，配置只能**收紧**它。
   */
  private gateRetryLimit(stageId: StageId): number {
    return Math.min(this.maxGateRetries, this.options.cfg.stages[stageId]!.budget.maxRetries)
  }

  /** 该阶段的审核重试上限，同样受 `budget.maxRetries` 约束（docs/10 §7.3 独立预算）。 */
  private reviewRetryLimit(stageId: StageId): number {
    return Math.min(MAX_REVIEW_RETRIES, this.options.cfg.stages[stageId]!.budget.maxRetries)
  }

  /**
   * 预算超限的落盘（docs/10 §7.3）。
   *
   * 三个硬约束：
   * 1. **不重试**——同一份预算再跑一遍只会再烧一次模型；
   * 2. **不进入人工批准**——置 `gate-failed` 并走 `human.gateFailed` 开升级任务，
   *    该任务的 `artifactPath` 为空、`machineStatus=failed`，`findResumableTask`
   *    永远不会把它当阶段门批准（`persistent-human-gate.ts` 的既有保证）；
   * 3. **检查点可恢复**——失败事实（`failures[].kind='budget-exceeded'` + 机器违规）
   *    在返回前已落盘，因此进程重启后 `status`/CLI 仍能看到原因，运维可用
   *    `reenter` 调整预算后重跑。
   */
  private async failOnBudgetExceeded(
    cp: Checkpoint,
    stageId: StageId,
    error: StageBudgetExceededError,
  ): Promise<RunOutcome> {
    const current = cp.stageStates[stageId]!
    const at = this.now()
    const detail = error.message
    const violation = { rule: BUDGET_EXCEEDED_RULE, level: 'BLOCKING' as const, detail, at }
    const machine = {
      ...current.gate.machine,
      status: 'failed' as const,
      violations: [violation],
      attempts: current.gate.machine.attempts + 1,
    }
    await this.update(cp, stageId, {
      status: 'gate-failed',
      gate: { ...current.gate, machine },
      failures: [
        ...current.failures,
        { kind: 'budget-exceeded', rule: BUDGET_EXCEEDED_RULE, detail, at },
      ],
    })
    await this.options.human.gateFailed(stageId, machine)
    return { outcome: 'gate-failed', stageId }
  }

  /** 需要重新 spawn（而非复用既有 child）的状态：门禁回喂 / 人工重入 = 全新生命周期。 */
  private isReSpawnState(status: StageState['status']): boolean {
    return status === 'needs-fix' || status === 'needs-reentry'
  }

  /**
   * 阶段停在人工门等待中且产物仍可读 → 可以跳过 spawn 直接回到门禁+人工门。
   * 产物被删除或损坏时返回 false，回退到正常的重新生成路径。
   */
  private async resumableAtGate(state: StageState): Promise<boolean> {
    if (state.status !== 'awaiting-gate') return false
    try {
      return await this.options.artifacts.read(state.artifact) !== null
    } catch {
      return false
    }
  }
}
