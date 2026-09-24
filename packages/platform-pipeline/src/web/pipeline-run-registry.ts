/**
 * 进程内运行句柄注册表（docs/10 §5.2「进程内运行句柄，非事实存储」）。
 *
 * 本模块**只**回答一个问题：*这个进程此刻是否正在跑某条流水线*。
 * 它不保存任何阶段状态、产物、裁决或游标——那些事实一律来自检查点、
 * 产物库与人工门任务（docs/10 §5.3「查询必须以持久化 checkpoint、artifact、
 * gate task 为事实来源。进程内 registry 只用于保存后台运行句柄和取消信号，
 * 不能作为唯一状态」）。
 *
 * 因此本文件刻意**不导出**任何"当前状态""当前阶段"之类的查询方法：一旦导出，
 * 调用方就会开始把它当状态源用，进程重启后必然得到与磁盘不一致的视图。
 * 唯一的例外是 {@link PipelineRunHandle.startedAt}，它是**本进程**的观测时间，
 * 明确不是阶段时间（阶段时间只能来自检查点与门任务，docs/10 §4.2 M0-3）。
 *
 * @module platform-pipeline/web/pipeline-run-registry
 */

/**
 * 一次后台运行的收敛结果。
 *
 * 注册表**永不**让 `work` 的异常逃逸成未处理拒绝（那会终止宿主进程），
 * 也不会静默吞掉它——异常被完整装进 `{ ok: false, error }` 交给调用方，
 * 由 `async-runner` 决定映射成什么（通常是 `run-failed`）。
 */
export type RunSettlement =
  | { readonly ok: true }
  | { readonly ok: false; readonly error: unknown }

/** 后台运行句柄。持有它的唯一用途是观察收敛与请求取消。 */
export interface PipelineRunHandle {
  readonly pipelineId: string
  /**
   * 本进程**开始**这次后台运行的时间（`Date.now()`）。
   *
   * 明确不是阶段时间：阶段耗时遥测属于 M3（docs/10 §7），在那之前页面的
   * `startedAt` 只能来自人工门任务的 `createdAt`（docs/10 §4.2 M0-3）。
   */
  readonly startedAt: number
  /**
   * 传给 `work` 的取消信号（只读视图）。
   *
   * 持有者**不能**用它反向取消：`AbortSignal` 没有 `abort()`，取消统一走
   * {@link PipelineRunRegistry.cancel}，让"谁能取消"收敛到一个入口。
   */
  readonly signal: AbortSignal
  /** 本次运行的收敛 Promise；**永远 resolve**，异常装在 `RunSettlement` 里。 */
  readonly settled: Promise<RunSettlement>
}

interface RunRecord {
  readonly handle: PipelineRunHandle
  /** 私有控制器：`AbortSignal` 是只读视图，真正的中止动作只有这里能做。 */
  readonly controller: AbortController
}

/**
 * 进程内运行句柄注册表。
 *
 * 生命周期约定：`start` 时登记，`work` 结束后立刻释放。释放必须发生在工作
 * 结束**之后**——否则「已触发但仍在跑」会被误判成空闲，第二次触发就会与
 * 第一次并发写同一份检查点（M2 的 pipeline lock 落地前，这是唯一的互斥手段）。
 *
 * 同一 `pipelineId` 在运行期间重复 `start` 返回 `null`，由调用方翻译成
 * `already-running`，而不是排队或并发执行。
 */
export class PipelineRunRegistry {
  private readonly records = new Map<string, RunRecord>()

  /** 当前正在运行的流水线数量。 */
  get size(): number {
    return this.records.size
  }

  has(pipelineId: string): boolean {
    return this.records.has(pipelineId)
  }

  get(pipelineId: string): PipelineRunHandle | undefined {
    return this.records.get(pipelineId)?.handle
  }

  /** 正在运行的流水线 id（按插入顺序，便于日志与测试断言）。 */
  ids(): readonly string[] {
    return [...this.records.keys()]
  }

  /**
   * 登记并启动一次后台运行。
   *
   * `work` 在**当前 tick 之后**才真正开始执行（本方法同步返回句柄），因此
   * HTTP handler 可以立刻响应 `202` 而不必等流水线跑完（docs/10 §5.4
   * 「不要在 HTTP handler 中直接 await driver.run() 后保持连接等待人工裁决」）。
   *
   * @returns 新句柄；该 `pipelineId` 已在运行时返回 `null`（不排队、不并发）。
   */
  start(pipelineId: string, work: (signal: AbortSignal) => Promise<void>): PipelineRunHandle | null {
    if (pipelineId.trim() === '') throw new Error('PipelineRunRegistry.start 需要非空 pipelineId')
    if (this.records.has(pipelineId)) return null

    const controller = new AbortController()
    let release!: (settlement: RunSettlement) => void
    const settled = new Promise<RunSettlement>(resolve => { release = resolve })

    const handle: PipelineRunHandle = {
      pipelineId,
      startedAt: Date.now(),
      signal: controller.signal,
      settled,
    }
    // 先登记再启动：work 内部的同步部分若立刻查询 has()，必须看到自己。
    this.records.set(pipelineId, { handle, controller })

    void (async () => {
      // 先给成功值，`catch` 再覆盖：这样 `finally` 里一定能读到已赋值的 settlement。
      let settlement: RunSettlement = { ok: true }
      try {
        await work(controller.signal)
      } catch (error) {
        settlement = { ok: false, error }
      } finally {
        this.records.delete(pipelineId)
        release(settlement)
      }
    })()

    return handle
  }

  /**
   * 中止指定流水线的后台运行。
   *
   * 只发信号，**不**改任何持久化事实：取消是否被观察到由 driver/人工门决定
   * （等待超时 → `waiting-human`，信号中止 → `cancelled`，两者都绝不自动批准）。
   *
   * @returns 是否确有正在运行的句柄被中止（幂等：重复调用返回 `false`）。
   */
  cancel(pipelineId: string, reason = 'cancelled by host'): boolean {
    const record = this.records.get(pipelineId)
    if (record === undefined) return false
    record.controller.abort(new Error(reason))
    return true
  }

  /** 中止全部后台运行（进程优雅退出用）。 */
  cancelAll(reason = 'host shutting down'): readonly string[] {
    const ids = this.ids()
    for (const pipelineId of ids) this.cancel(pipelineId, reason)
    return ids
  }

  /** 等待指定流水线的后台运行收敛；无句柄时立即返回 `{ ok: true }`。 */
  async settled(pipelineId: string): Promise<RunSettlement> {
    const handle = this.records.get(pipelineId)?.handle
    return handle === undefined ? { ok: true } : handle.settled
  }

  /**
   * 等待当前全部后台运行收敛（测试与优雅退出用）。
   *
   * 循环读取而不是快照：`work` 内部可能触发新的运行（例如恢复扫描续跑），
   * 只等一轮快照会提前返回，测试就会读到中间态。
   */
  async allSettled(): Promise<readonly RunSettlement[]> {
    const settlements: RunSettlement[] = []
    while (this.records.size > 0) {
      const current = [...this.records.values()].map(record => record.handle.settled)
      settlements.push(...await Promise.all(current))
    }
    return settlements
  }
}
