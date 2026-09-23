import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { StageId } from '../types.ts'

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
  readonly machineStatus: 'passed' | 'failed'
  readonly machineViolations: readonly { rule: string; level: 'BLOCKING' | 'WARNING'; detail: string }[]
  readonly review?: Readonly<{ verdict: string; findings: readonly string[] }>
  readonly decision?: Readonly<{ by: string; action: 'approved' | 'changes-needed' | 'rejected'; note: string; at: number }>
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

  async get(taskId: string): Promise<TaskRecord | null> { return readJson(this.path(taskId)) }

  async list(filter: { projectId?: string; pipelineId?: string; status?: TaskStatus } = {}): Promise<readonly TaskRecord[]> {
    const values = await readAll<TaskRecord>(this.dir)
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

export class FileHumanGateTaskStore implements HumanGateTaskStore {
  private readonly dir: string
  constructor(dir: string) { this.dir = dir }

  async create(input: Omit<HumanGateTask, 'createdAt' | 'updatedAt' | 'status'> & Partial<Pick<HumanGateTask, 'createdAt' | 'updatedAt' | 'status'>>): Promise<HumanGateTask> {
    const now = Date.now()
    const task: HumanGateTask = { ...input, status: input.status ?? 'pending', createdAt: input.createdAt ?? now, updatedAt: input.updatedAt ?? now }
    await writeJson(this.path(task.gateTaskId), task)
    return task
  }

  async get(gateTaskId: string): Promise<HumanGateTask | null> { return readJson(this.path(gateTaskId)) }

  async list(filter: { projectId?: string; pipelineId?: string; status?: HumanGateTaskStatus } = {}): Promise<readonly HumanGateTask[]> {
    const values = await readAll<HumanGateTask>(this.dir)
    return values.filter(task => (filter.projectId === undefined || task.projectId === filter.projectId)
      && (filter.pipelineId === undefined || task.pipelineId === filter.pipelineId)
      && (filter.status === undefined || task.status === filter.status))
      .sort((a, b) => a.createdAt - b.createdAt)
  }

  async claim(gateTaskId: string, actor: string, ttlMs: number): Promise<HumanGateTask> {
    validateLease(actor, ttlMs)
    const current = await requireValue(this.get(gateTaskId), `human gate task not found: ${gateTaskId}`)
    if (!['pending', 'claimed'].includes(current.status)) throw new Error(`human gate task is not claimable: ${current.status}`)
    if (current.lease !== undefined && current.lease.expiresAt > Date.now() && current.lease.owner !== actor) throw new Error(`human gate task is claimed by ${current.lease.owner}`)
    const now = Date.now()
    return this.save({ ...current, status: 'claimed', claimedBy: actor, lease: { owner: actor, acquiredAt: current.lease?.acquiredAt ?? now, expiresAt: now + ttlMs }, updatedAt: now })
  }

  async decide(gateTaskId: string, actor: string, action: 'approved' | 'changes-needed' | 'rejected', note: string): Promise<HumanGateTask> {
    const current = await requireValue(this.get(gateTaskId), `human gate task not found: ${gateTaskId}`)
    if (current.status !== 'claimed' || current.claimedBy !== actor) throw new Error('human gate decision requires the active claim owner')
    if (note.trim() === '' && action !== 'approved') throw new Error('changes-needed/rejected decisions require a non-empty note')
    const { lease: _lease, ...withoutLease } = current
    return this.save({ ...withoutLease, status: action, decision: { by: actor, action, note, at: Date.now() }, updatedAt: Date.now(), lease: undefined })
  }

  async expire(now = Date.now()): Promise<readonly HumanGateTask[]> {
    const candidates = (await this.list()).filter(task => (task.expiresAt !== undefined && task.expiresAt <= now && ['pending', 'claimed'].includes(task.status)) || (task.lease !== undefined && task.lease.expiresAt <= now && task.status === 'claimed'))
    const expired: HumanGateTask[] = []
    for (const task of candidates) expired.push(await this.save({ ...task, status: 'expired', updatedAt: now, lease: undefined }))
    return expired
  }

  async cancel(gateTaskId: string, actor: string, note = ''): Promise<HumanGateTask> {
    if (actor.trim() === '') throw new Error('cancellation actor must not be empty')
    const current = await requireValue(this.get(gateTaskId), `human gate task not found: ${gateTaskId}`)
    if (!['pending', 'claimed'].includes(current.status)) throw new Error(`human gate task is not cancellable: ${current.status}`)
    const { lease: _lease, ...withoutLease } = current
    const now = Date.now()
    return this.save({ ...withoutLease, status: 'cancelled', cancellation: { by: actor, note, at: now }, updatedAt: now, lease: undefined })
  }

  private path(gateTaskId: string): string { return join(this.dir, `${safeId(gateTaskId)}.json`) }
  private async save(task: HumanGateTask): Promise<HumanGateTask> { await writeJson(this.path(task.gateTaskId), task); return task }
}

export function newTaskId(prefix = 'task'): string { return `${prefix}-${randomUUID()}` }

async function readAll<T>(dir: string): Promise<T[]> {
  try {
    const files = (await readdir(dir)).filter(file => file.endsWith('.json'))
    const values: T[] = []
    for (const file of files) {
      const value = await readJson<T>(join(dir, file))
      if (value !== null) values.push(value)
    }
    return values
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}

async function readJson<T>(path: string): Promise<T | null> {
  try { return JSON.parse(await readFile(path, 'utf8')) as T } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true })
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  await rename(temp, path)
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
