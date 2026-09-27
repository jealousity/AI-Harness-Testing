import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import type { StageId } from '../types.ts'
import {
  StorageCorruptError,
  StorageUnavailableError,
  checkAndStripSchemaVersion,
  withSchemaVersion,
} from '../storage/ports.ts'

export type TaskStatus = 'queued' | 'running' | 'waiting-human' | 'retrying' | 'completed' | 'failed' | 'cancelled' | 'expired'
export type HumanGateTaskStatus = 'pending' | 'claimed' | 'approved' | 'changes-needed' | 'rejected' | 'expired' | 'cancelled'

export interface Lease {
  readonly owner: string
  readonly acquiredAt: number
  readonly expiresAt: number
}

export interface TaskRecord {
  readonly taskId: string
  readonly tenantId?: string
  readonly projectId: string
  readonly pipelineId: string
  readonly status: TaskStatus
  readonly stageId?: StageId
  readonly createdAt: number
  readonly updatedAt: number
  readonly heartbeatAt?: number
  readonly attempt: number
  readonly lease?: Lease
  readonly error?: string
  readonly metadata?: Readonly<Record<string, unknown>>
}

export interface HumanGateTask {
  readonly gateTaskId: string
  readonly tenantId?: string
  readonly projectId: string
  readonly pipelineId: string
  readonly stageId: StageId
  readonly status: HumanGateTaskStatus
  readonly createdAt: number
  readonly updatedAt: number
  readonly expiresAt?: number
  readonly claimedBy?: string
  readonly lease?: Lease
  readonly artifactPath: string
  /**
   * 送审产物的 digest（docs/11 P1-04）。
   *
   * 批准的身份是**某个具体产物版本**，不是"那个路径上的东西"。少了这个字段，
   * 同路径内容被替换后旧任务仍会按路径被复用——轻则真人看到的 findings 与最终
   * 冻结进检查点的 digest 来自两份不同产物，重则一条 `approved`（尚未消费）的旧
   * 裁决会放行重入后产生的新内容。
   *
   * 可选是为了兼容旧记录：**没有它的任务不可续用**（失败关闭——无法确认批准对象时
   * 宁可多问一次，也绝不自动沿用）。`gateFailed` 升级任务不带它（它不对应具体产物）。
   */
  readonly artifactDigest?: string
  readonly machineStatus: 'passed' | 'failed'
  readonly machineViolations: readonly { rule: string; level: 'BLOCKING' | 'WARNING'; detail: string }[]
  readonly review?: Readonly<{ verdict: string; findings: readonly string[] }>
  readonly decision?: Readonly<{ by: string; action: 'approved' | 'changes-needed' | 'rejected'; note: string; at: number }>
  /**
   * 裁决被编排器消费的时间。
   * 一条裁决只能驱动一次门：消费后同一阶段再开门必须新建任务，
   * 否则 `changes-needed` 打回重跑时会反复命中同一条旧裁决而空转。
   */
  readonly consumedAt?: number
  /** 显式取消记录（外部撤回 / 流水线中止）；仅 status='cancelled' 时存在。 */
  readonly cancellation?: Readonly<{ by: string; note: string; at: number }>
}

export interface TaskStore {
  create(task: Omit<TaskRecord, 'createdAt' | 'updatedAt'> & Partial<Pick<TaskRecord, 'createdAt' | 'updatedAt'>>): Promise<TaskRecord>
  get(taskId: string): Promise<TaskRecord | null>
  list(filter?: { projectId?: string; pipelineId?: string; status?: TaskStatus }): Promise<readonly TaskRecord[]>
  update(taskId: string, patch: Partial<Omit<TaskRecord, 'taskId' | 'createdAt'>>): Promise<TaskRecord>
  acquireLease(taskId: string, owner: string, ttlMs: number): Promise<TaskRecord>
  heartbeat(taskId: string, owner: string, ttlMs: number): Promise<TaskRecord>
  releaseLease(taskId: string, owner: string): Promise<TaskRecord>
  recoverStale(now?: number): Promise<readonly TaskRecord[]>
}

export interface HumanGateTaskStore {
  create(task: Omit<HumanGateTask, 'createdAt' | 'updatedAt' | 'status'> & Partial<Pick<HumanGateTask, 'createdAt' | 'updatedAt' | 'status'>>): Promise<HumanGateTask>
  get(gateTaskId: string): Promise<HumanGateTask | null>
  list(filter?: { projectId?: string; pipelineId?: string; status?: HumanGateTaskStatus }): Promise<readonly HumanGateTask[]>
  claim(gateTaskId: string, actor: string, ttlMs: number): Promise<HumanGateTask>
  decide(gateTaskId: string, actor: string, action: 'approved' | 'changes-needed' | 'rejected', note: string): Promise<HumanGateTask>
  expire(now?: number): Promise<readonly HumanGateTask[]>
  /**
   * 标记裁决已被消费。**必选**：编排器靠它区分「这条裁决还没用」和「这条裁决已经驱动过一次门」，
   * 缺了它 `changes-needed` 打回重跑会反复命中同一条旧裁决。
   */
  consume(gateTaskId: string, at?: number): Promise<HumanGateTask>
  /**
   * 可选：显式取消未决任务（外部撤回 / 流水线中止）。
   * 已裁决（approved/changes-needed/rejected）或已终态的任务不可取消——取消不能覆盖真人裁决。
   */
  cancel?(gateTaskId: string, actor: string, note?: string): Promise<HumanGateTask>
}

export class FileTaskStore implements TaskStore {
  private readonly dir: string
  constructor(dir: string) { this.dir = dir }

  async create(input: Omit<TaskRecord, 'createdAt' | 'updatedAt'> & Partial<Pick<TaskRecord, 'createdAt' | 'updatedAt'>>): Promise<TaskRecord> {
    const now = Date.now()
    const task: TaskRecord = { ...input, createdAt: input.createdAt ?? now, updatedAt: input.updatedAt ?? now }
    await writeJson(this.path(task.taskId), task)
    return task
  }

  async get(taskId: string): Promise<TaskRecord | null> { return readJson(this.path(taskId), 'task') }

  async list(filter: { projectId?: string; pipelineId?: string; status?: TaskStatus } = {}): Promise<readonly TaskRecord[]> {
    const values = await readAll<TaskRecord>(this.dir, 'task')
    return values.filter(task => (filter.projectId === undefined || task.projectId === filter.projectId)
      && (filter.pipelineId === undefined || task.pipelineId === filter.pipelineId)
      && (filter.status === undefined || task.status === filter.status))
      .sort((a, b) => a.createdAt - b.createdAt)
  }

  async update(taskId: string, patch: Partial<Omit<TaskRecord, 'taskId' | 'createdAt'>>): Promise<TaskRecord> {
    const current = await requireValue(this.get(taskId), `task not found: ${taskId}`)
    const next: TaskRecord = { ...current, ...patch, taskId, createdAt: current.createdAt, updatedAt: Date.now() }
    await writeJson(this.path(taskId), next)
    return next
  }

  async acquireLease(taskId: string, owner: string, ttlMs: number): Promise<TaskRecord> {
    validateLease(owner, ttlMs)
    const current = await requireValue(this.get(taskId), `task not found: ${taskId}`)
    assertLeaseAvailable(current.lease, owner)
    const now = Date.now()
    return this.update(taskId, { lease: { owner, acquiredAt: now, expiresAt: now + ttlMs }, heartbeatAt: now, status: current.status === 'queued' ? 'running' : current.status })
  }

  async heartbeat(taskId: string, owner: string, ttlMs: number): Promise<TaskRecord> {
    validateLease(owner, ttlMs)
    const current = await requireValue(this.get(taskId), `task not found: ${taskId}`)
    assertLeaseOwner(current.lease, owner)
    const now = Date.now()
    return this.update(taskId, { lease: { owner, acquiredAt: current.lease!.acquiredAt, expiresAt: now + ttlMs }, heartbeatAt: now })
  }

  async releaseLease(taskId: string, owner: string): Promise<TaskRecord> {
    const current = await requireValue(this.get(taskId), `task not found: ${taskId}`)
    assertLeaseOwner(current.lease, owner)
    const { lease: _lease, ...withoutLease } = current
    return this.update(taskId, { ...withoutLease, heartbeatAt: Date.now(), lease: undefined })
  }

  async recoverStale(now = Date.now()): Promise<readonly TaskRecord[]> {
    const stale = (await this.list()).filter(task => task.lease !== undefined && task.lease.expiresAt <= now && !['completed', 'failed', 'cancelled', 'expired'].includes(task.status))
    const recovered: TaskRecord[] = []
    for (const task of stale) recovered.push(await this.update(task.taskId, { status: 'queued', lease: undefined, error: `stale lease recovered from ${task.lease!.owner}` }))
    return recovered
  }

  private path(taskId: string): string { return join(this.dir, `${safeId(taskId)}.json`) }
}

/**
 * 门任务正被另一个进程改写（文件后端的 per-task 互斥没抢到）。
 *
 * 单独成一个类型而不是靠报错文本：`toPipelineRunError` 按**类型**映射成
 * `conflict`(409)，换后端（数据库条件更新）时这条语义不会因为文案变化而失效。
 */
export class GateTaskBusyError extends Error {
  readonly gateTaskId: string

  constructor(gateTaskId: string) {
    super(`human gate task ${gateTaskId} is busy: another process is mutating it`)
    this.name = 'GateTaskBusyError'
    this.gateTaskId = gateTaskId
  }
}

/** 单条门任务互斥的等待上限：超过就明确失败，而不是无限挂住调用方。 */
const GATE_TASK_LOCK_WAIT_MS = 2_000
/** 抢锁的重试间隔。 */
const GATE_TASK_LOCK_RETRY_MS = 5
/** 锁被视为"持有者已崩溃"的年龄。临界区只有几次小文件读写，30s 足够宽松。 */
const GATE_TASK_LOCK_STALE_MS = 30_000

export class FileHumanGateTaskStore implements HumanGateTaskStore {
  private readonly dir: string
  constructor(dir: string) { this.dir = dir }

  async create(input: Omit<HumanGateTask, 'createdAt' | 'updatedAt' | 'status'> & Partial<Pick<HumanGateTask, 'createdAt' | 'updatedAt' | 'status'>>): Promise<HumanGateTask> {
    const now = Date.now()
    const task: HumanGateTask = { ...input, status: input.status ?? 'pending', createdAt: input.createdAt ?? now, updatedAt: input.updatedAt ?? now }
    // 新记录用全新 id，不可能与并发写者撞同一路径，因此不需要加锁。
    await writeJson(this.path(task.gateTaskId), task)
    return task
  }

  async get(gateTaskId: string): Promise<HumanGateTask | null> { return readJson(this.path(gateTaskId), 'gate-task') }

  async list(filter: { projectId?: string; pipelineId?: string; status?: HumanGateTaskStatus } = {}): Promise<readonly HumanGateTask[]> {
    const values = await readAll<HumanGateTask>(this.dir, 'gate-task')
    return values.filter(task => (filter.projectId === undefined || task.projectId === filter.projectId)
      && (filter.pipelineId === undefined || task.pipelineId === filter.pipelineId)
      && (filter.status === undefined || task.status === filter.status))
      .sort((a, b) => a.createdAt - b.createdAt)
  }

  /**
   * 认领。
   *
   * **必须在互斥锁内**（docs/11 P1-05）：`get → 检查 → save` 不是原子操作，
   * 两个调用者可以同时读到同一个 pending 快照、各自通过检查、再先后写入，
   * 最后写入者覆盖前者——而两个调用都会返回"成功"。
   */
  async claim(gateTaskId: string, actor: string, ttlMs: number): Promise<HumanGateTask> {
    validateLease(actor, ttlMs)
    return this.withLock(gateTaskId, async () => {
      const current = await requireValue(this.get(gateTaskId), `human gate task not found: ${gateTaskId}`)
      if (!['pending', 'claimed'].includes(current.status)) throw new Error(`human gate task is not claimable: ${current.status}`)
      if (current.lease !== undefined && current.lease.expiresAt > Date.now() && current.lease.owner !== actor) throw new Error(`human gate task is claimed by ${current.lease.owner}`)
      const now = Date.now()
      return this.save({ ...current, status: 'claimed', claimedBy: actor, lease: { owner: actor, acquiredAt: current.lease?.acquiredAt ?? now, expiresAt: now + ttlMs }, updatedAt: now })
    })
  }

  /** 裁决。与 `claim` 同理：检查"是不是当前 claim 持有者"与写入必须原子。 */
  async decide(gateTaskId: string, actor: string, action: 'approved' | 'changes-needed' | 'rejected', note: string): Promise<HumanGateTask> {
    return this.withLock(gateTaskId, async () => {
      const current = await requireValue(this.get(gateTaskId), `human gate task not found: ${gateTaskId}`)
      if (current.status !== 'claimed' || current.claimedBy !== actor) throw new Error('human gate decision requires the active claim owner')
      if (note.trim() === '' && action !== 'approved') throw new Error('changes-needed/rejected decisions require a non-empty note')
      const { lease: _lease, ...withoutLease } = current
      return this.save({ ...withoutLease, status: action, decision: { by: actor, action, note, at: Date.now() }, updatedAt: Date.now(), lease: undefined })
    })
  }

  async expire(now = Date.now()): Promise<readonly HumanGateTask[]> {
    const candidates = (await this.list()).filter(task => (task.expiresAt !== undefined && task.expiresAt <= now && ['pending', 'claimed'].includes(task.status)) || (task.lease !== undefined && task.lease.expiresAt <= now && task.status === 'claimed'))
    const expired: HumanGateTask[] = []
    for (const task of candidates) {
      // 逐条加锁：过期回收也可能与 claim/decide 并发，不能读改写裸奔。
      expired.push(await this.withLock(task.gateTaskId, async () => {
        const current = await this.get(task.gateTaskId)
        // 期间被别人裁决/取消了：不再当作过期处理（不覆盖别人的终态）。
        if (current === null || !['pending', 'claimed'].includes(current.status)) return current ?? task
        return this.save({ ...current, status: 'expired', updatedAt: now, lease: undefined })
      }))
    }
    return expired
  }

  /** 消费裁决。幂等：已消费则原样返回（并发下两个调用者必须拿到**同一个**时间戳）。 */
  async consume(gateTaskId: string, at = Date.now()): Promise<HumanGateTask> {
    return this.withLock(gateTaskId, async () => {
      const current = await requireValue(this.get(gateTaskId), `human gate task not found: ${gateTaskId}`)
      if (current.consumedAt !== undefined) return current
      if (!['approved', 'changes-needed', 'rejected'].includes(current.status)) {
        throw new Error(`human gate task is not consumable: ${current.status}`)
      }
      return this.save({ ...current, consumedAt: at, updatedAt: at })
    })
  }

  /** 取消。与 `decide` 抢同一把锁：二者只能有一个把任务推进终态。 */
  async cancel(gateTaskId: string, actor: string, note = ''): Promise<HumanGateTask> {
    if (actor.trim() === '') throw new Error('cancellation actor must not be empty')
    return this.withLock(gateTaskId, async () => {
      const current = await requireValue(this.get(gateTaskId), `human gate task not found: ${gateTaskId}`)
      if (!['pending', 'claimed'].includes(current.status)) throw new Error(`human gate task is not cancellable: ${current.status}`)
      const { lease: _lease, ...withoutLease } = current
      const now = Date.now()
      return this.save({ ...withoutLease, status: 'cancelled', cancellation: { by: actor, note, at: now }, updatedAt: now, lease: undefined })
    })
  }

  private path(gateTaskId: string): string { return join(this.dir, `${safeId(gateTaskId)}.json`) }
  private async save(task: HumanGateTask): Promise<HumanGateTask> { await writeJson(this.path(task.gateTaskId), task); return task }

  // ── 单条任务互斥（docs/11 P1-05）────────────────────────────────────────────

  private lockDir(gateTaskId: string): string { return join(this.dir, '.locks', `${safeId(gateTaskId)}.lock`) }

  /**
   * 在**该任务**的互斥锁内执行 `work`。
   *
   * 为什么文件后端需要它：POSIX 没有"条件 rename"，所以文件上的 CAS 只能靠互斥
   * 把"读 → 检查 → 写"包成临界区。锁只作用于单条任务，不同门任务互不阻塞。
   *
   * 三条性质：
   * - **有界等待**：超过 {@link GATE_TASK_LOCK_WAIT_MS} 就抛
   *   {@link GateTaskBusyError}（映射成 `conflict` 409），不无限挂住调用方；
   * - **自愈**：持有者崩溃会留下锁目录，超过 {@link GATE_TASK_LOCK_STALE_MS}
   *   可被后来者接管（否则一次崩溃会永久锁死这个门）；
   * - **不误删**：释放前核对锁目录里的持有者令牌，只删自己的锁；被判定过期并
   *   回收后，原持有者不会再去删别人的锁。
   */
  private async withLock<T>(gateTaskId: string, work: () => Promise<T>): Promise<T> {
    const lockDir = this.lockDir(gateTaskId)
    const token = randomUUID()
    await mkdir(dirname(lockDir), { recursive: true })
    const deadline = Date.now() + GATE_TASK_LOCK_WAIT_MS
    for (;;) {
      try {
        await mkdir(lockDir)
        await writeFile(join(lockDir, 'owner'), token, 'utf8')
        break
      } catch (error) {
        if (!isAlreadyExists(error)) throw error
        if (await reclaimIfStale(lockDir)) continue
        if (Date.now() >= deadline) throw new GateTaskBusyError(gateTaskId)
        await delay(GATE_TASK_LOCK_RETRY_MS)
      }
    }
    try {
      return await work()
    } finally {
      await releaseLock(lockDir, token)
    }
  }
}

/** `mkdir` 独占失败：目录已存在（= 锁被持有）。 */
function isAlreadyExists(error: unknown): boolean {
  return error instanceof Error && (error as { code?: string }).code === 'EEXIST'
}

/**
 * 回收"持有者已崩溃"的锁；返回是否值得立刻重试。
 *
 * 抢占不做 `rm -rf` 一个可能仍被他人持有的目录，而是**原子改名到唯一墓碑再删**：
 * 改名是原子的，谁先改名成功谁负责清理，另一个只会拿到 ENOENT 并重试。
 */
async function reclaimIfStale(lockDir: string): Promise<boolean> {
  let ageMs: number
  try {
    ageMs = Date.now() - (await stat(lockDir)).mtimeMs
  } catch {
    return true // 锁已消失：直接重试即可
  }
  if (ageMs < GATE_TASK_LOCK_STALE_MS) return false
  const tombstone = `${lockDir}.stale-${randomUUID()}`
  try {
    await rename(lockDir, tombstone)
  } catch {
    return true // 别人抢先处理了
  }
  await rm(tombstone, { recursive: true, force: true })
  return true
}

/** 只删自己持有的锁：被判定过期并回收后，不碰后来者的锁。 */
async function releaseLock(lockDir: string, token: string): Promise<void> {
  let owner: string
  try {
    owner = await readFile(join(lockDir, 'owner'), 'utf8')
  } catch {
    return
  }
  if (owner !== token) return
  await rm(lockDir, { recursive: true, force: true })
}

export function newTaskId(prefix = 'task'): string { return `${prefix}-${randomUUID()}` }

async function readAll<T>(dir: string, kind: 'task' | 'gate-task'): Promise<T[]> {
  try {
    const files = (await readdir(dir)).filter(file => file.endsWith('.json'))
    const values: T[] = []
    for (const file of files) {
      const value = await readJson<T>(join(dir, file), kind)
      if (value !== null) values.push(value)
    }
    return values
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}

/**
 * 读一条 JSON 记录。
 *
 * 三种结果必须区分开（docs/10 §8.3 M4-A）：
 * - 文件不存在 → `null`（正常）；
 * - JSON 非法 / 形状不符 → 抛 {@link StorageCorruptError}。**绝不返回 null**：
 *   把"读坏了"当成"没有这条"会让任务/门任务凭空消失，而调用方会据此创建新记录，
 *   等于用新数据覆盖现场；
 * - IO/权限错误 → 抛 {@link StorageUnavailableError}。
 *
 * 另外先校验并剥掉 `schemaVersion` 存储信封：版本更高的记录必须显式失败，
 * 且这个纯存储字段不能漏进 `TaskRecord` / `HumanGateTask` 的对外形状。
 */
async function readJson<T>(path: string, kind: 'task' | 'gate-task' = 'task'): Promise<T | null> {
  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw new StorageUnavailableError('file', `read ${basename(path)}`, errorMessageOf(error), { cause: error })
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    throw new StorageCorruptError(basename(path), kind, `不是合法 JSON（${errorMessageOf(error)}）`)
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new StorageCorruptError(basename(path), kind, '顶层不是对象')
  }
  return checkAndStripSchemaVersion(basename(path), kind, parsed as Record<string, unknown>) as unknown as T
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true })
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`
  // 落盘带 `schemaVersion`（docs/10 §8.3 M4-A）；读侧会剥掉，端口形状不变。
  await writeFile(temp, `${JSON.stringify(withSchemaVersion(value as Record<string, unknown>), null, 2)}\n`, 'utf8')
  await rename(temp, path)
}

function errorMessageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function requireValue<T>(value: Promise<T | null>, message: string): Promise<T> {
  const resolved = await value
  if (resolved === null) throw new Error(message)
  return resolved
}

function safeId(value: string): string {
  const safe = value.replace(/[^A-Za-z0-9._-]/g, '_')
  if (safe === '') throw new Error('record id must not be empty')
  return safe
}

function validateLease(owner: string, ttlMs: number): void {
  if (owner.trim() === '') throw new Error('lease owner must not be empty')
  if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) throw new Error('lease ttlMs must be a positive integer')
}

function assertLeaseAvailable(lease: Lease | undefined, owner: string): void {
  if (lease !== undefined && lease.expiresAt > Date.now() && lease.owner !== owner) throw new Error(`task is leased by ${lease.owner}`)
}

function assertLeaseOwner(lease: Lease | undefined, owner: string): void {
  if (lease === undefined || lease.owner !== owner || lease.expiresAt <= Date.now()) throw new Error('active lease ownership is required')
}
