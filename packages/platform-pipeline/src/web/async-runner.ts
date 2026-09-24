/**
 * 后台运行与恢复调度（docs/10 §5.2、§5.4）。
 *
 * 采用文档推荐的「持久化状态 + 进程内触发器」：
 *
 * 1. HTTP 请求创建/触发 pipeline；
 * 2. service 侧装配宿主（M2 会在此处加 pipeline lock）；
 * 3. **后台**调用 `driver.run()`，HTTP handler 立刻返回 `202`；
 * 4. 人工门等待超时后，driver 以 `waiting-human` 语义结束本次调用；
 * 5. 人工裁决 API 只写任务，**不在** HTTP 请求内同步跑完整流水线；
 * 6. 后续触发（再次 `run`、裁决后重触发、定时 worker）读取检查点续跑；
 * 7. 进程重启后，{@link AsyncPipelineRunner.recover} 扫描索引并按
 *    {@link decideRecovery} 恢复或标记为可重入。
 *
 * 本模块**不**保存任何状态：并发互斥靠 `PipelineRunRegistry` 的句柄，
 * 页面状态靠检查点/产物/门任务。因此进程重启后 `recover()` 得到的行为
 * 与重启前一致（唯一的差别是"本进程是否正在跑"从空开始）。
 *
 * @module platform-pipeline/web/async-runner
 */

import { scanPipelineIndex, type PipelineRunService } from './pipeline-run-service.ts'
import { PipelineRunRegistry, type PipelineRunHandle, type RunSettlement } from './pipeline-run-registry.ts'
import {
  errorMessageOf,
  toPipelineRunError,
  type ActorContext,
  type PipelineRunErrorView,
  type PipelineRunStatus,
  type RunResult,
} from './pipeline-run-types.ts'

/** 一次后台运行收敛后的结果（供日志/指标/测试观察）。 */
export type BackgroundRunOutcome =
  /** 流水线按正常语义结束（completed / waiting-human / rejected / gate-failed / review-failed / cancelled / failed）。 */
  | { readonly kind: 'run'; readonly pipelineId: string; readonly result: RunResult }
  /** 前置校验或装配阶段抛错（配置非法、provider 缺 Key、作用域不符…）。 */
  | { readonly kind: 'error'; readonly pipelineId: string; readonly error: PipelineRunErrorView }

/** `trigger()` 的结果。 */
export interface TriggerResult {
  readonly started: boolean
  /** 未启动的原因：`already-running` = 本进程已在跑同一流水线。 */
  readonly reason: 'already-running' | null
  readonly handle: PipelineRunHandle | null
}

/** 恢复扫描对单条流水线应采取的动作。 */
export type RecoveryAction = 'resume' | 'await-human' | 'terminal' | 'unreadable'

/**
 * 恢复动作判定（纯函数，便于单测）。
 *
 * | 状态 | 动作 | 理由 |
 * |---|---|---|
 * | `queued` / `running` / `needs-fix` | `resume` | 进程在运行中被杀，检查点未落终态；driver 从 cursor 继续 |
 * | `waiting-human`（有待裁决任务） | `await-human` | 必须等真人，绝不替人做裁决 |
 * | `waiting-human`（无待裁决任务） | `resume` | 裁决已下但尚未被消费，续跑正是去消费它 |
 * | `completed` / `rejected` / `gate-failed` / `cancelled` / `failed` | `terminal` | 终态；重跑需要显式 `reenter`，恢复扫描不替人决定 |
 */
export function decideRecovery(status: PipelineRunStatus, hasOpenGateTask: boolean): RecoveryAction {
  switch (status) {
    case 'queued':
    case 'running':
    case 'needs-fix':
      return 'resume'
    case 'waiting-human':
      return hasOpenGateTask ? 'await-human' : 'resume'
    case 'completed':
    case 'rejected':
    case 'gate-failed':
    case 'cancelled':
    case 'failed':
      return 'terminal'
  }
}

/** 单条流水线的恢复结论。 */
export interface RecoveryOutcome {
  readonly pipelineId: string
  readonly action: RecoveryAction
  /** 读不到视图（`unreadable`）时为 `null`。 */
  readonly status: PipelineRunStatus | null
  /** 本次恢复是否真的启动了后台运行。 */
  readonly started: boolean
  /** 未启动/不可读的原因；成功启动时为 `null`。 */
  readonly detail: string | null
}

export interface AsyncPipelineRunnerOptions {
  readonly service: PipelineRunService
  /**
   * 平台数据根：恢复扫描据此找到流水线索引目录（与 service 同一份配置，
   * 两处不一致会导致"恢复扫描看不见任何流水线"）。
   */
  readonly dataRoot: string
  /**
   * 后台运行的**兜底**身份。
   *
   * 这个身份**只驱动运行**：它不参与人工门裁决（裁决必须来自 HTTP 请求里的
   * 真人 actor，否则等于用系统身份自动批准）。因此调用方应传一个不声明
   * `roles` 的身份——`assertGateRole` 是失败关闭的，不声明角色即无法裁决。
   *
   * HTTP 入口应把**调用者自己的身份**传给 {@link AsyncPipelineRunner.trigger}，
   * 让后台运行的身份与审计对象保持一致；本字段只在未显式传入时生效。
   */
  readonly actor: ActorContext
  readonly registry?: PipelineRunRegistry
  /** 每次后台运行收敛后的回调（日志/指标）。回调抛错不影响流水线。 */
  readonly onSettled?: (outcome: BackgroundRunOutcome) => unknown
}

/**
 * 用流水线索引里的租户补齐身份。
 *
 * `assertScopeMatch` 要求租户**精确匹配**（配置声明了 `tenantId` 时，调用者缺该字段
 * 会被判为不匹配）。恢复扫描逐条读索引，因此这里按每条流水线的真实租户补齐，
 * 而不是让调用方预先知道所有租户。
 */
function withTenant(actor: ActorContext, tenantId: string | null): ActorContext {
  if (tenantId === null || actor.tenantId !== undefined) return actor
  return { ...actor, tenantId }
}

/**
 * 后台运行与恢复调度器。
 *
 * 与 service 的分工：service 回答"这条流水线现在是什么状态"（读持久化事实），
 * runner 回答"这个进程现在要不要为它启动一次运行"（内存事实 + 持久化状态判定）。
 */
export class AsyncPipelineRunner {
  private readonly options: AsyncPipelineRunnerOptions
  /** 进程内运行句柄：唯一的并发互斥手段（M2 的 pipeline lock 落地前的替代品）。 */
  readonly registry: PipelineRunRegistry

  constructor(options: AsyncPipelineRunnerOptions) {
    if (options.dataRoot.trim() === '') throw new Error('AsyncPipelineRunner 需要非空 dataRoot')
    this.options = options
    this.registry = options.registry ?? new PipelineRunRegistry()
  }

  /**
   * 触发一次后台运行并立刻返回（docs/10 §5.4「不要在 HTTP handler 中直接
   * `await driver.run()` 后保持连接等待人工裁决」）。
   *
   * 先读一次视图，使"流水线不存在"能在 HTTP 层映射成 `404`，而不是异步地
   * 消失在后台。这一步与启动之间有极小的竞态窗口，但它只影响错误码的精确度，
   * 不影响正确性：真正的事实判定仍在 driver 内。
   *
   * @param actor 后台运行使用的身份；缺省用构造时的兜底身份。HTTP 入口应传入
   *   调用者身份，使后台运行与审计对象一致。
   */
  async trigger(pipelineId: string, actor?: ActorContext): Promise<TriggerResult> {
    const runAs = actor ?? this.options.actor
    // 读不到会抛 PipelineRunError（not-found / scope-mismatch / config-invalid），
    // 由调用方映射成 HTTP 状态；这里刻意不吞掉。
    await this.options.service.get(pipelineId, runAs)

    const handle = this.registry.start(pipelineId, async signal => {
      let outcome: BackgroundRunOutcome
      try {
        // 每次调用独立信号：取消这条流水线不会连带取消同实例上的其他流水线。
        const result = await this.options.service.run(pipelineId, runAs, { signal })
        outcome = { kind: 'run', pipelineId, result }
      } catch (error) {
        // 前置校验失败（配置非法、provider 缺 Key…）走到这里；运行期失败由 RunResult 表达。
        outcome = { kind: 'error', pipelineId, error: toPipelineRunError(error).toView() }
      }
      try {
        await this.options.onSettled?.(outcome)
      } catch {
        // 观察者抛错不能影响流水线本身，更不能让句柄无法释放。
      }
    })

    if (handle === null) return { started: false, reason: 'already-running', handle: null }
    return { started: true, reason: null, handle }
  }

  /**
   * 取消某条流水线的后台运行（`POST /api/pipelines/:id/cancel` 一类运维入口）。
   *
   * 只发信号、不改持久化事实：本次运行会以 `cancelled`（或人工门的
   * `waiting-human`）结束，而不是被静默标记成成功。
   */
  cancel(pipelineId: string, reason?: string): boolean {
    return reason === undefined ? this.registry.cancel(pipelineId) : this.registry.cancel(pipelineId, reason)
  }

  isRunning(pipelineId: string): boolean {
    return this.registry.has(pipelineId)
  }

  runningIds(): readonly string[] {
    return this.registry.ids()
  }

  /** 等待当前全部后台运行收敛（测试与优雅退出用）。 */
  idle(): Promise<readonly RunSettlement[]> {
    return this.registry.allSettled()
  }

  /**
   * 进程重启后的恢复扫描（docs/10 §5.4 第 7 步）。
   *
   * 遍历流水线索引，逐条读持久化视图后按 {@link decideRecovery} 决定：
   * 续跑、等真人裁决、或标记为终态不再动它。索引损坏与视图不可读的项
   * **显式返回**在结果里（`action: 'unreadable'`），而不是静默跳过——
   * 否则运维会以为"全部已恢复"。
   *
   * 返回结果按 `pipelineId` 排序，便于日志对比与测试断言。
   */
  async recover(): Promise<readonly RecoveryOutcome[]> {
    const scan = await scanPipelineIndex(this.options.dataRoot)
    const outcomes: RecoveryOutcome[] = scan.unreadable.map(item => ({
      pipelineId: item.file.replace(/\.json$/, ''),
      action: 'unreadable' as const,
      status: null,
      started: false,
      detail: `索引不可读：${item.reason}`,
    }))

    for (const entry of scan.entries) {
      // 按每条流水线的真实租户补齐身份：assertScopeMatch 要求租户精确匹配。
      const actor = withTenant(this.options.actor, entry.tenantId)
      try {
        const view = await this.options.service.get(entry.pipelineId, actor)
        const action = decideRecovery(view.status, view.openGateTaskId !== null)
        if (action !== 'resume') {
          outcomes.push({ pipelineId: entry.pipelineId, action, status: view.status, started: false, detail: null })
          continue
        }
        const trigger = await this.trigger(entry.pipelineId, actor)
        outcomes.push({
          pipelineId: entry.pipelineId,
          action,
          status: view.status,
          started: trigger.started,
          detail: trigger.started ? null : '本进程已在运行该流水线',
        })
      } catch (error) {
        outcomes.push({
          pipelineId: entry.pipelineId,
          action: 'unreadable',
          status: null,
          started: false,
          detail: errorMessageOf(error),
        })
      }
    }

    return outcomes.sort((a, b) => (a.pipelineId < b.pipelineId ? -1 : a.pipelineId > b.pipelineId ? 1 : 0))
  }

  /** 优雅退出：中止全部后台运行并返回被中止的 id。 */
  shutdown(reason?: string): readonly string[] {
    return reason === undefined ? this.registry.cancelAll() : this.registry.cancelAll(reason)
  }
}
