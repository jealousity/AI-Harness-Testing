/**
 * 跨进程运行互斥锁（docs/10 §6.3 M2-1）。
 *
 * 用**独占目录**做互斥：`mkdir` 在 POSIX 上是原子的，「谁先建成谁持有」不需要额外
 * 的原子原语。目录里放一个 `owner.json` 记录持有者与租约：
 *
 * - `ownerId`：每次 acquire 重新生成（UUID），是"这一份持有"的唯一标识；
 * - `generation`：该 pipeline 上单调递增的持有代数，落盘在锁目录**外面**
 *   （`.pipeline.lock.gen`），因此释放后不归零——同一个 ownerId 的两次持有也能区分；
 * - `heartbeatAt`：租约时间。判断 stale **只看它**，不看 `acquiredAt`：否则一条跑了
 *   7 小时的流水线会被当成死锁抢走（§6.2 第 3 条）；
 * - `pid` / `host`：只给运维看，不参与判定（跨主机时 pid 无意义）。
 *
 * `release()` 必须同时校验 `ownerId` + `generation`（§6.2 第 4 条）：只校验"owner
 * 文件在不在"，会让过期持有者醒来后的 release 删掉新持有者的锁。
 *
 * 抢占（stale recovery）刻意不做 `rm -rf`（§6.3 末条）。步骤是：
 * 读到 stale → **再读一次确认没变** → 把整个锁目录**原子改名**到一个唯一名字 →
 * 在改名后的目录里**第三次确认 owner 仍是那个 stale 的** → 才递归删除。
 * 改名成功即意味着我们独占了这个目录，删的是自己的目录，而不是"别人可能正在用的
 * 路径"。第三次确认若发现对方刚续租/换手，就把目录改名放回去并放弃本轮。
 *
 * 残留窗口：文件系统锁无法做到完全无竞争，`读 owner` 与 `rename` 之间仍有极小的
 * 时间窗。这里的取舍是**宁可抢锁失败，也不删别人的活锁**——失败方会重试，最多
 * 抛 `PipelineLockHeldError`，绝不会静默并行推进同一条流水线。
 *
 * @module platform-pipeline/checkpoint-lock
 */

import { randomUUID } from 'node:crypto'
import { appendFile, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { hostname } from 'node:os'
import { dirname, join } from 'node:path'

/** 默认租约上限：6 小时没有任何心跳即视为死锁。 */
const DEFAULT_STALE_MS = 6 * 60 * 60 * 1000
/** 自动续租间隔 = 租约上限的 1/3，留两次重试余量。 */
const HEARTBEAT_DIVISOR = 3
/** 抢占的有界重试次数：每次都可能被别人抢先，几轮之内拿不到就认输。 */
const MAX_STEAL_ATTEMPTS = 4

const LOCK_DIR_NAME = '.pipeline.lock'
const OWNER_FILE_NAME = 'owner.json'
const GENERATION_FILE_NAME = '.pipeline.lock.gen'

/** owner 文件的内容（`pid`/`host` 仅供排查，不参与判定）。 */
export interface PipelineLockOwner {
  readonly ownerId: string
  readonly generation: number
  readonly pid: number
  readonly host: string
  readonly acquiredAt: number
  readonly heartbeatAt: number
}

export type PipelineLockEventKind =
  | 'acquired'
  | 'renewed'
  | 'released'
  | 'release-refused'
  | 'renew-refused'
  | 'stale-recovered'
  | 'stale-refused'
  | 'contended'

/** 审计事件（`stale-recovered` 是 docs/10 §6.3 明确要求必须记录的那一条）。 */
export interface PipelineLockEvent {
  readonly kind: PipelineLockEventKind
  readonly pipelineId: string
  readonly at: number
  readonly lockPath: string
  /** 事件主体：本次持有者（`contended` 时为试图抢锁的一方）。 */
  readonly owner: PipelineLockOwner
  /** 被抢占 / 被拒绝时的原持有者；没有则 null。 */
  readonly previous: PipelineLockOwner | null
  readonly detail: string
}

export type PipelineLockAudit = (event: PipelineLockEvent) => void | Promise<void>

/**
 * 需要落盘的事件种类。
 *
 * 只写"异常或需要解释"的事件：`acquired`/`renewed`/`released` 是每次 run 都会发生的
 * 例行事件，全写会让审计文件被噪声淹没；而 §6.3 明确要求记录的 stale recovery、
 * 以及"为什么这把锁没抢到/没释放掉"的拒绝事件，才是审计真正要回答的问题。
 */
const AUDITED_LOCK_EVENTS: ReadonlySet<PipelineLockEventKind> = new Set([
  'stale-recovered', 'stale-refused', 'release-refused', 'renew-refused', 'contended',
])

/** 锁审计文件路径（与 `human-gate-audit.jsonl` 同级，放在 checkpoints 根下）。 */
export function lockAuditPath(checkpointRoot: string): string {
  return join(checkpointRoot, 'pipeline-lock-audit.jsonl')
}

/**
 * JSONL 审计落盘。CLI / Web / Harness 三个入口共用它，避免各自拼路径导致审计分裂。
 *
 * 写失败**不抛**：审计是旁路，不能因为它写不下去就把一条本来能跑的流水线拦下来。
 */
export function fileLockAudit(path: string): PipelineLockAudit {
  return async event => {
    if (!AUDITED_LOCK_EVENTS.has(event.kind)) return
    try {
      await mkdir(dirname(path), { recursive: true })
      await appendFile(path, `${JSON.stringify(event)}\n`, 'utf8')
    } catch {
      // 有意忽略
    }
  }
}

export interface PipelineLock {
  readonly pipelineId: string
  readonly path: string
  readonly ownerId: string
  readonly generation: number
  readonly acquiredAt: number
  /** 当前 owner 快照（含最近一次续租后的 `heartbeatAt`）。 */
  readonly owner: PipelineLockOwner
  /** 续租：把 `heartbeatAt` 推到当前时间。已被抢占/已被删除时返回 false，不抛。 */
  renew(): Promise<boolean>
  /** 释放：同时校验 `ownerId` + `generation`。返回是否真的删除了自己的锁；幂等。 */
  release(): Promise<boolean>
}

export interface AcquirePipelineLockOptions {
  /** 租约上限（毫秒）。缺省 6 小时；非正数或非有限值 = 永不过期。 */
  readonly staleMs?: number
  /** 自动续租间隔（毫秒）。缺省 `staleMs / 3`；传 0 关闭自动续租。 */
  readonly heartbeatMs?: number
  readonly audit?: PipelineLockAudit
  readonly now?: () => number
  /** owner 文件里的 host 字段（测试可注入，避免依赖真实主机名）。 */
  readonly host?: string
  /** 覆盖 ownerId（测试用；生产必须每次随机）。 */
  readonly ownerId?: string
}

/** 锁被他人持有。CLI/Web 应把它翻译成"该流水线正在别处运行"，而不是静默并行。 */
export class PipelineLockHeldError extends Error {
  readonly pipelineId: string
  readonly lockPath: string
  readonly holder: PipelineLockOwner | null
  readonly staleMs: number

  constructor(input: {
    readonly pipelineId: string
    readonly lockPath: string
    readonly holder: PipelineLockOwner | null
    readonly staleMs: number
  }) {
    const who = input.holder === null
      ? '无法确认持有者（owner 文件缺失或损坏）'
      : `持有者 ${input.holder.ownerId}（generation ${input.holder.generation}，pid ${input.holder.pid}@${input.holder.host}，`
        + `最后心跳 ${new Date(input.holder.heartbeatAt).toISOString()}）`
    super(`pipeline ${input.pipelineId} 已被其他进程锁定：${who}；锁路径 ${input.lockPath}`)
    this.name = 'PipelineLockHeldError'
    this.pipelineId = input.pipelineId
    this.lockPath = input.lockPath
    this.holder = input.holder
    this.staleMs = input.staleMs
  }
}

/** `checkpoints/<pipelineId>`：driver 的检查点根，也是锁所在目录。 */
export function pipelineCheckpointDir(checkpointRoot: string, pipelineId: string): string {
  return join(checkpointRoot, assertSafePipelineId(pipelineId))
}

/**
 * 锁路径固定为项目作用域下 `checkpoints/<pipelineId>/.pipeline.lock`（§6.3 M2-1）。
 *
 * **CLI / Web / Harness 三个入口都必须用它**：此前 Harness 传的是 checkpoints 根、
 * Web 传的是 per-pipeline 目录，两者拼出的锁路径不同，等于没锁（§6.2 第 5 条）。
 * 因此这里统一收 `(checkpointRoot, pipelineId)` 两个参数——参数形状一样，拼错的机会
 * 才少。
 */
export function pipelineLockPath(checkpointRoot: string, pipelineId: string): string {
  return join(pipelineCheckpointDir(checkpointRoot, pipelineId), LOCK_DIR_NAME)
}

/** 取得该 pipeline 的运行锁；已被他人持有时抛 {@link PipelineLockHeldError}。 */
export async function acquirePipelineLock(
  checkpointRoot: string,
  pipelineId: string,
  options: AcquirePipelineLockOptions = {},
): Promise<PipelineLock> {
  const id = assertSafePipelineId(pipelineId)
  const dir = pipelineCheckpointDir(checkpointRoot, id)
  const path = join(dir, LOCK_DIR_NAME)
  const counterPath = join(dir, GENERATION_FILE_NAME)
  const now = options.now ?? (() => Date.now())
  const staleMs = options.staleMs ?? DEFAULT_STALE_MS
  const host = options.host ?? hostname()
  const audit = options.audit

  await mkdir(dir, { recursive: true })

  let previous: PipelineLockOwner | null = null
  let created = false
  for (let attempt = 0; attempt < MAX_STEAL_ATTEMPTS && !created; attempt += 1) {
    try {
      await mkdir(path)
      created = true
      break
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }

    const holder = await readOwner(path)
    const at = now()
    const reason = staleReason(holder, at, staleMs)
    if (holder !== null && reason === null) {
      await emit(audit, {
        kind: 'contended', pipelineId: id, at, lockPath: path,
        owner: provisionalOwner(options.ownerId, 0, host, at), previous: holder,
        detail: `锁仍有效（心跳 ${new Date(holder.heartbeatAt).toISOString()}），拒绝抢占`,
      })
      throw new PipelineLockHeldError({ pipelineId: id, lockPath: path, holder, staleMs })
    }

    // 删除前再读一次：`holder` 是我们几微秒前看到的，期间对方可能已续租或换手。
    const confirmed = await readOwner(path)
    if (!sameHolder(confirmed, holder)) continue

    const recovered = await stealStaleLock(path, holder, { id, now, staleMs, audit, host, ownerId: options.ownerId })
    if (recovered === null) continue
    previous = recovered
  }

  if (!created) {
    const holder = await readOwner(path)
    await emit(audit, {
      kind: 'contended', pipelineId: id, at: now(), lockPath: path,
      owner: provisionalOwner(options.ownerId, 0, host, now()), previous: holder,
      detail: `抢占重试 ${MAX_STEAL_ATTEMPTS} 轮仍未取得锁`,
    })
    throw new PipelineLockHeldError({ pipelineId: id, lockPath: path, holder, staleMs })
  }

  const acquiredAt = now()
  const generation = await bumpGeneration(counterPath, previous?.generation ?? 0)
  let current: PipelineLockOwner = {
    ownerId: options.ownerId ?? randomUUID(),
    generation,
    pid: process.pid,
    host,
    acquiredAt,
    heartbeatAt: acquiredAt,
  }
  await writeOwner(path, current)

  let released = false
  let timer: ReturnType<typeof setInterval> | undefined

  const lock: PipelineLock = {
    pipelineId: id,
    path,
    ownerId: current.ownerId,
    generation: current.generation,
    acquiredAt: current.acquiredAt,
    get owner(): PipelineLockOwner { return current },
    async renew(): Promise<boolean> {
      if (released) return false
      const at = now()
      const seen = await readOwner(path)
      if (seen === null || !sameHolder(seen, current)) {
        await emit(audit, {
          kind: 'renew-refused', pipelineId: id, at, lockPath: path,
          owner: current, previous: seen,
          detail: '续租被拒：锁已被他人持有或已被删除',
        })
        return false
      }
      const next: PipelineLockOwner = { ...current, heartbeatAt: at }
      try {
        await writeOwner(path, next)
      } catch {
        return false
      }
      current = next
      await emit(audit, {
        kind: 'renewed', pipelineId: id, at, lockPath: path,
        owner: current, previous: null, detail: '心跳已更新',
      })
      return true
    },
    async release(): Promise<boolean> {
      if (released) return false
      released = true
      if (timer !== undefined) { clearInterval(timer); timer = undefined }
      const at = now()
      const seen = await readOwner(path)
      if (seen === null || !sameHolder(seen, current)) {
        await emit(audit, {
          kind: 'release-refused', pipelineId: id, at, lockPath: path,
          owner: current, previous: seen,
          detail: '释放被拒：锁已被他人持有或已被删除，不做任何删除',
        })
        return false
      }
      const tomb = `${path}.released-${randomUUID()}`
      try {
        await rename(path, tomb)
      } catch {
        return false
      }
      const moved = await readOwner(tomb)
      if (moved === null || !sameHolder(moved, current)) {
        await restoreTomb(tomb, path)
        await emit(audit, {
          kind: 'release-refused', pipelineId: id, at, lockPath: path,
          owner: current, previous: moved,
          detail: '释放被拒：改名后发现持有者已变，已尝试放回原处',
        })
        return false
      }
      await rm(tomb, { recursive: true, force: true })
      await emit(audit, {
        kind: 'released', pipelineId: id, at, lockPath: path,
        owner: current, previous: null, detail: '已释放',
      })
      return true
    },
  }

  await emit(audit, {
    kind: 'acquired', pipelineId: id, at: acquiredAt, lockPath: path,
    owner: current, previous,
    detail: previous === null ? '首次取得锁' : `接管 stale 锁（原 generation ${previous.generation}）`,
  })

  const heartbeatMs = options.heartbeatMs
    ?? (Number.isFinite(staleMs) && staleMs > 0 ? Math.max(1, Math.floor(staleMs / HEARTBEAT_DIVISOR)) : 0)
  if (heartbeatMs > 0) {
    timer = setInterval(() => { void lock.renew() }, heartbeatMs)
    // 续租定时器不得阻止进程退出（CLI 一次 run 结束后要能自然结束）。
    timer.unref?.()
  }

  return lock
}

/** 抢占一个已确认 stale 的锁；成功返回被抢走的 owner，失败（被抢先）返回 null。 */
async function stealStaleLock(
  path: string,
  expected: PipelineLockOwner | null,
  context: {
    readonly id: string
    readonly now: () => number
    readonly staleMs: number
    readonly audit: PipelineLockAudit | undefined
    readonly host: string
    readonly ownerId: string | undefined
  },
): Promise<PipelineLockOwner | null> {
  // 把整个锁目录原子改名到唯一名字：改名成功 = 我们独占了这个目录，
  // 之后才能安全递归删除（删的是自己的目录，而不是别人可能正在用的路径）。
  const tomb = `${path}.stale-${randomUUID()}`
  try {
    await rename(path, tomb)
  } catch {
    return null // 目录已消失或改名失败：让调用方重试
  }

  const moved = await readOwner(tomb)
  const reason = staleReason(moved, context.now(), context.staleMs)
  if (reason === null) {
    // 改名前那一刻它被续租/换手了。放回去，本轮放弃——宁可抢不到，也不删活锁。
    await restoreTomb(tomb, path)
    await emit(context.audit, {
      kind: 'stale-refused', pipelineId: context.id, at: context.now(), lockPath: path,
      owner: provisionalOwner(context.ownerId, 0, context.host, context.now()), previous: moved,
      detail: '改名后发现持有者仍有效，已放回原处，不抢占',
    })
    return null
  }

  await rm(tomb, { recursive: true, force: true })
  const stolen = moved ?? expected
  await emit(context.audit, {
    kind: 'stale-recovered', pipelineId: context.id, at: context.now(), lockPath: path,
    owner: provisionalOwner(context.ownerId, 0, context.host, context.now()), previous: stolen,
    detail: stolen === null
      ? `清除了残留锁目录（${STALE_REASON_DETAIL[reason]}）`
      : `清除了 stale 锁（${STALE_REASON_DETAIL[reason]}；原持有者 ${stolen.ownerId}，generation ${stolen.generation}）`,
  })
  return stolen
}

/** 把改名后的目录放回原位；放不回（原位已被新持有者占用）就留在原地，不删。 */
async function restoreTomb(tomb: string, path: string): Promise<void> {
  try {
    await rename(tomb, path)
  } catch {
    // 原位已被占用：保留 tomb 目录供人工排查，绝不做"顺手删掉"。
  }
}

async function readOwner(lockPath: string): Promise<PipelineLockOwner | null> {
  try {
    const raw = await readFile(join(lockPath, OWNER_FILE_NAME), 'utf8')
    return normalizeOwner(JSON.parse(raw) as unknown)
  } catch {
    // 目录在但 owner 文件缺失/损坏：身份不可确认，由调用方按 stale 处理。
    return null
  }
}

/** 兼容旧版 owner 文件（只有 `owner`/`acquiredAt`/`pid`）：缺的字段按最小语义补全。 */
function normalizeOwner(value: unknown): PipelineLockOwner | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  const ownerId = typeof record.ownerId === 'string'
    ? record.ownerId
    : (typeof record.owner === 'string' ? record.owner : undefined)
  if (ownerId === undefined || ownerId === '') return null
  const acquiredAt = typeof record.acquiredAt === 'number' ? record.acquiredAt : 0
  return {
    ownerId,
    // 旧版没有 generation 概念，但它确实是该 pipeline 的第一个持有者，
    // 因此按 1 计（不变量：任何真实持有者的 generation ≥ 1）。缺省给 0 会让
    // "接管的锁"和"全新流水线的首次加锁"都拿到 1，审计上分不开。
    generation: typeof record.generation === 'number' ? record.generation : 1,
    pid: typeof record.pid === 'number' ? record.pid : 0,
    host: typeof record.host === 'string' ? record.host : '',
    acquiredAt,
    // 旧文件没有 heartbeatAt：退化成 acquiredAt，语义仍是"最后一次已知存活时间"。
    heartbeatAt: typeof record.heartbeatAt === 'number' ? record.heartbeatAt : acquiredAt,
  }
}

/** 原子写 owner 文件（tmp → rename），避免读到写了一半的 JSON。 */
async function writeOwner(lockPath: string, owner: PipelineLockOwner): Promise<void> {
  const target = join(lockPath, OWNER_FILE_NAME)
  const temp = `${target}.${process.pid}.${randomUUID()}.tmp`
  await writeFile(temp, JSON.stringify(owner), 'utf8')
  await rename(temp, target)
}

/** 身份相同 = `ownerId` + `generation` + `heartbeatAt` 三者都相同（含同为 null）。 */
function sameHolder(a: PipelineLockOwner | null, b: PipelineLockOwner | null): boolean {
  if (a === null || b === null) return a === b
  return a.ownerId === b.ownerId && a.generation === b.generation && a.heartbeatAt === b.heartbeatAt
}

function isStale(owner: PipelineLockOwner, at: number, staleMs: number): boolean {
  if (!Number.isFinite(staleMs) || staleMs <= 0) return false // 非正数/无穷 = 永不过期
  return at - owner.heartbeatAt > staleMs
}

/** 可以安全抢占的原因；`null` = 锁仍有效。 */
type StaleReason = 'dead-holder' | 'heartbeat-expired' | 'unreadable'

/**
 * 判定一把锁能不能被抢占。
 *
 * 两个独立判据，满足任一即可：
 *
 * - `dead-holder`：**同主机且持有者 pid 已不存在**。`kill -9` 不会执行任何清理，
 *   锁目录会原样留下；只看心跳的话，一次 kill 会让流水线卡到心跳超期（默认 6 小时），
 *   这正是 §6.4 说的"不会卡死永久"要避免的。pid 被复用的情况会被判成"还活着"，
 *   于是退回心跳判据——宁可多等，也不抢活锁。
 * - `heartbeat-expired`：`heartbeatAt` 超过 `staleMs`。跨主机时这是唯一可用的判据
 *   （pid 在别的机器上没有意义）。
 */
function staleReason(owner: PipelineLockOwner | null, at: number, staleMs: number): StaleReason | null {
  if (owner === null) return 'unreadable'
  if (isHolderDead(owner)) return 'dead-holder'
  return isStale(owner, at, staleMs) ? 'heartbeat-expired' : null
}

/** 同主机 + pid 不存在 → 持有者已死。跨主机或 pid 未知时不作判断。 */
function isHolderDead(owner: PipelineLockOwner): boolean {
  if (owner.pid <= 0) return false
  if (owner.host !== hostname()) return false
  try {
    process.kill(owner.pid, 0) // 信号 0 = 只探测存在性，不真的发信号
    return false
  } catch (error) {
    // ESRCH = 不存在（已死）；EPERM = 存在但无权限（算活着）。
    return (error as NodeJS.ErrnoException).code === 'ESRCH'
  }
}

const STALE_REASON_DETAIL: Readonly<Record<StaleReason, string>> = {
  'dead-holder': '持有者进程已不存在（kill -9 后未清理锁）',
  'heartbeat-expired': '心跳超期',
  unreadable: 'owner 文件缺失或损坏，身份不可确认',
}

/** generation 单调递增：计数器只增不减，且不低于被抢占者的代数。 */
async function bumpGeneration(counterPath: string, previousGeneration: number): Promise<number> {
  const persisted = await readGeneration(counterPath)
  const next = Math.max(persisted, previousGeneration) + 1
  try {
    await mkdir(dirname(counterPath), { recursive: true })
    await writeFile(counterPath, String(next), 'utf8')
  } catch {
    // 计数器写失败不阻塞加锁：generation 退化成进程内序号也不影响正确性
    // （release 同时校验 ownerId，两者一起才构成身份）。
  }
  return next
}

async function readGeneration(counterPath: string): Promise<number> {
  try {
    const value = Number((await readFile(counterPath, 'utf8')).trim())
    return Number.isSafeInteger(value) && value >= 0 ? value : 0
  } catch {
    return 0
  }
}

/** 事件里的"我方"身份占位（此刻还没算出真正的 ownerId/generation）。 */
function provisionalOwner(ownerId: string | undefined, generation: number, host: string, at: number): PipelineLockOwner {
  return {
    ownerId: ownerId ?? 'pending',
    generation,
    pid: process.pid,
    host,
    acquiredAt: at,
    heartbeatAt: at,
  }
}

/** 审计失败绝不影响锁状态：这里吞掉异常，只保证"尝试记录过"。 */
async function emit(audit: PipelineLockAudit | undefined, event: PipelineLockEvent): Promise<void> {
  if (audit === undefined) return
  try {
    await audit(event)
  } catch {
    // 有意忽略
  }
}

/** pipelineId 会直接拼进路径，因此必须挡住路径分隔符与 `.`/`..`。 */
function assertSafePipelineId(pipelineId: string): string {
  if (typeof pipelineId !== 'string' || pipelineId === '') throw new Error('pipelineId 不能为空')
  if (pipelineId.includes('\0') || pipelineId.includes('/') || pipelineId.includes('\\')
    || pipelineId === '.' || pipelineId === '..') {
    throw new Error(`pipelineId 不能包含路径分隔符或相对路径：${pipelineId}`)
  }
  return pipelineId
}
