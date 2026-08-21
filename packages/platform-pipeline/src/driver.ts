/**
 * PipelineDriver：编排核心（docs/09 第 2 节 / docs/03 第 2 节）。
 * 用户命令直接驱动的纯代码循环（D-20）：
 * 恢复续跑 → 逐阶段 { spawn → 机器门禁 → 交叉检查 → 人工门 } → 检查点推进 → 重入。
 * 所有副作用通过注入端口（spawn/gates/human/review/artifacts/checkpoint）隔离，
 * 因此可在无 harness 运行时下单测。
 * @module platform-pipeline/driver
 */

import { initialCheckpoint } from './checkpoint.ts'
import { stageRunContext, type StageSpawner } from './stage-spawner.ts'
import { MachineGateEngine, computeArtifactDigest, type JudgeResult } from './gates/machine.ts'
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
  /** 门禁语义重试次数（docs/01 ET-01：默认 2）。 */
  readonly maxGateRetries?: number
}

export type RunOutcome =
  | { readonly outcome: 'completed' }
  | { readonly outcome: 'rejected' | 'gate-failed' | 'review-failed'; readonly stageId: StageId }

const MAX_GATE_RETRIES = 2
const MAX_REVIEW_RETRIES = 1

/** 编排核心。 */
export class PipelineDriver {
  private readonly options: DriverOptions
  private readonly maxGateRetries: number

  constructor(options: DriverOptions) {
    this.options = options
    this.maxGateRetries = options.maxGateRetries ?? MAX_GATE_RETRIES
  }

  async run(): Promise<RunOutcome> {
    let cp = await this.options.checkpoint.load(this.options.root)
      ?? initialCheckpoint(this.options.pipelineId, this.options.cfg.templateVersion, this.options.rulesetVersion)

    while (cp.cursor < STAGE_ORDER.length) {
      const stageId = STAGE_ORDER[cp.cursor]!
      let state = cp.stageStates[stageId]!

      if (state.status === 'done') {
        cp = await this.advance(cp)
        continue
      }

      const runCtx = stageRunContext(stageId, cp)
      const inputPaths = this.inputPathsOf(stageId, cp)
      const spawned = await this.options.spawn.runStage({
        stageId,
        pipelineId: this.options.pipelineId,
        inputPaths,
        artifactPath: state.artifact,
        ...(runCtx.extra === undefined ? {} : { extraContext: runCtx.extra }),
        previousViolations: state.gate.machine.violations.length === 0 ? undefined : state.gate.machine.violations,
      }, this.options.cfg)

      const artifact = await this.options.artifacts.read(spawned.artifactPath)
      if (artifact === null) {
        throw new Error(`stage "${stageId}" produced no artifact at ${spawned.artifactPath}`)
      }
      const upstreams = await this.loadUpstreams(stageId, cp)
      // 宿主填充输入摘要锁（G-08）：优先用检查点持久化的 inputs（冻结），首次运行从当前上游填充
      const persisted = cp.stageStates[stageId]!.inputs
      const hasPersisted = persisted !== undefined && Object.keys(persisted).length > 0
      const filled = hasPersisted
        ? { ...artifact, inputs: persisted, digest: cp.stageStates[stageId]!.digest || computeArtifactDigest({ ...artifact, inputs: persisted }) }
        : this.fillInputLocks(artifact, upstreams)

      // 1. 机器门禁（全量重判；G-08 摘要锁在此拦截级联失效；R4-08/09/10 需 executor 执行数据）
      const execution = await this.options.execution?.load(stageId, this.options.pipelineId)
      const gate = this.options.gates.judge(stageId, filled, upstreams, state.gate.machine.attempts + 1, execution)
      if (gate.status === 'failed') {
        if (state.gate.machine.attempts < this.maxGateRetries) {
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
      let review: ReviewOutcome | undefined
      if (this.options.cfg.stages[stageId]!.review.enabled && this.options.review !== undefined) {
        review = await this.options.review.run(stageId, artifact, gate)
        if (review.verdict === 'fail') {
          const retried = state.failures.filter(f => f.kind === 'review-fail').length
          if (retried < MAX_REVIEW_RETRIES) {
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
      const decision = await this.options.human.gate(stageId, artifact, gate, review)
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
      cp = await this.advance(cp)
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
    await this.options.checkpoint.save(this.options.root, next)
    return next
  }

  private async advance(cp: Checkpoint): Promise<Checkpoint> {
    const next: Checkpoint = { ...cp, cursor: cp.cursor + 1 }
    await this.options.checkpoint.save(this.options.root, next)
    return next
  }
}
