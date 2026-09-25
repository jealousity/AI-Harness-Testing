/**
 * 内存后端（docs/10 §8.4「同一套 driver contract tests 同时通过 file backend 和
 * external backend」）。
 *
 * **它不是"测试替身"，而是一个真后端**：结构与文件后端同构——底下是一层
 * "原始存储"（键 → JSON 文本），端口在它上面做 解析 → 版本校验 → 形状校验。
 * 因此 `diagnose` / `migrate` / 损坏报告这些语义能**原样**复用同一套契约测试。
 * 如果做成"直接存对象"的假实现，那些语义就永远测不到。
 *
 * 用途（按诚实度排序）：
 * 1. **证明端口可替换**：契约套件跑两遍，任何偷偷依赖 fs 语义的实现都会现形；
 * 2. 单元测试与本地演示：不落盘、无清理、无并发目录问题；
 * 3. **不作为生产后端**：进程结束即丢数据，也不跨进程互斥。
 *    它的锁只在**进程内**有效，多进程部署必须换成 `file` 或数据库后端。
 *
 * 键格式（`raw` 层可见，便于故障注入与诊断）：
 * ```text
 * checkpoint:<root>   task:<taskId>      gate:<gateTaskId>   case:<caseId>
 * artifact:<path>     knowledge:<id>     usage:<pipelineId>  audit
 * ```
 *
 * @module platform-pipeline/storage/memory
 */

import { randomUUID } from 'node:crypto'
import { PipelineLockHeldError, type PipelineLockOwner } from '../../checkpoint-lock.ts'
import { computeArtifactDigest } from '../../gates/machine.ts'
import type { Checkpoint, StageArtifact } from '../../types.ts'
import type { HumanGateTask, HumanGateTaskStatus, TaskRecord, TaskStatus } from '../../runtime/persistence.ts'
import type { UsageEvent, UsageLogRead } from '../../usage.ts'
import {
  STORAGE_SCHEMA_VERSION,
  StorageCorruptError,
  checkAndStripSchemaVersion,
  readSchemaVersion,
  withSchemaVersion,
  type AuditEvent,
  type AuditEventQuery,
  type AuditEventRead,
  type CaseMeta,
  type KnowledgeConflict,
  type KnowledgeEntry,
  type KnowledgeHit,
  type KnowledgeQuery,
  type StorageBackend,
  type StorageDiagnostic,
  type StorageMigrationReport,
  type StoragePorts,
  type StorageRecordKind,
  type VersionedCase,
} from '../ports.ts'

/**
 * 原始存储层。
 *
 * 暴露出来是为了**故障注入**：契约套件要造"损坏记录""缺版本的历史记录"，
 * 而端口刻意没有"写非法内容"的入口（也不该有）。文件后端用写坏字节达到同样目的，
 * 内存后端就用这一层写坏 JSON。
 */
export interface MemoryRawStore {
  get(key: string): string | undefined
  set(key: string, value: string): void
  delete(key: string): boolean
  keys(): readonly string[]
  /** 迁移前的原值快照（键 → 文本），用于证明"迁移可回滚"。 */
  readonly backups: ReadonlyMap<string, string>
}

export interface MemoryStorageBackend extends StorageBackend {
  readonly raw: MemoryRawStore
}

const KEY = {
  checkpoint: (root: string): string => `checkpoint:${root}`,
  task: (taskId: string): string => `task:${taskId}`,
  gateTask: (gateTaskId: string): string => `gate:${gateTaskId}`,
  case: (caseId: string): string => `case:${caseId}`,
  artifact: (path: string): string => `artifact:${path}`,
  knowledge: (id: string): string => `knowledge:${id}`,
  usage: (pipelineId: string): string => `usage:${pipelineId}`,
  audit: 'audit',
} as const

/** 内存后端。 */
export function createMemoryStorageBackend(): MemoryStorageBackend {
  const map = new Map<string, string>()
  const backups = new Map<string, string>()
  const raw: MemoryRawStore = {
    get: key => map.get(key),
    set: (key, value) => { map.set(key, value) },
    delete: key => map.delete(key),
    keys: () => [...map.keys()],
    backups,
  }

  // 进程内锁：`Map<pipelineId, owner>`。**不跨进程**，见模块头注释。
  const locks = new Map<string, PipelineLockOwner>()

  const ports: StoragePorts = {
    artifacts: {
      async read(path) {
        // 路径检查必须在查表**之前**：否则"这个逃逸路径下没东西"会先返回 null，
        // 把一次越界读伪装成"文件不存在"（契约里 `产物路径逃逸被拒绝` 测的就是这条）。
        assertSafeArtifactPath(path)
        const text = map.get(KEY.artifact(path))
        if (text === undefined) return null
        const parsed = parseJson(text, path, 'artifact')
        if (isPersistedArtifact(parsed)) return parsed
        return wrapContent(path, parsed)
      },
      async write(artifact) {
        assertSafeArtifactPath(artifact.path)
        map.set(KEY.artifact(artifact.path), JSON.stringify({ ...artifact, content: stripWrapperKeys(artifact.content) }))
      },
    },

    checkpoints: {
      async load(root) {
        const text = map.get(KEY.checkpoint(root))
        if (text === undefined) return null
        const body = readRecord(text, KEY.checkpoint(root), 'checkpoint', isCheckpointShape)
        return body as unknown as Checkpoint
      },
      async save(root, checkpoint) {
        map.set(KEY.checkpoint(root), JSON.stringify(withSchemaVersion(checkpoint as unknown as Record<string, unknown>)))
      },
    },

    tasks: memoryTaskStore(map),
    gateTasks: memoryGateTaskStore(map),
    usage: memoryUsageStore(map),
    audit: memoryAuditStore(map),

    knowledge: {
      async read(query) {
        return (await readHitsFromMap(map, query)).map(hit => hit.entry)
      },
      readHits: (query: KnowledgeQuery) => readHitsFromMap(map, query),
      async findConflicts(entry) {
        const conflicts: KnowledgeConflict[] = []
        const incomingEntities = new Set(entry.entities.map(normalizeTerm))
        const incomingTags = new Set(entry.tags.map(normalizeTerm))
        const supersedes = new Set(entry.supersedes ?? [])
        for (const key of [...map.keys()].filter(item => item.startsWith('knowledge:'))) {
          const existing = readKnowledge(map, key)
          if (existing === null || existing.id === entry.id || existing.project !== entry.project) continue
          if ((existing.status ?? 'active') !== 'active' || supersedes.has(existing.id)) continue
          const sharedEntities = existing.entities.filter(value => incomingEntities.has(normalizeTerm(value)))
          const sharedTags = existing.tags.filter(value => incomingTags.has(normalizeTerm(value)))
          const sameTitle = normalizeTerm(existing.title) === normalizeTerm(entry.title)
          const differentBody = normalizeTerm(existing.body) !== normalizeTerm(entry.body)
          if (differentBody && (sharedEntities.length > 0 || sharedTags.length > 0 || sameTitle)) {
            conflicts.push({
              existingId: existing.id,
              existingVersion: existing.version,
              detail: `与 ${existing.id}@${existing.version} 的结论存在重叠实体/标签但正文不同；请显式 supersedes 旧条目或先人工确认`,
            })
          }
        }
        return conflicts
      },
      async write(entry) {
        const normalized: KnowledgeEntry = {
          ...entry,
          status: entry.status ?? 'active',
          confidence: entry.confidence ?? 'unverified',
          sourceRefs: entry.sourceRefs ?? [],
          supersedes: entry.supersedes ?? [],
        }
        map.set(KEY.knowledge(normalized.id), JSON.stringify(normalized))
        for (const supersededId of normalized.supersedes ?? []) {
          const key = KEY.knowledge(supersededId)
          const existing = readKnowledge(map, key)
          if (existing !== null && (existing.status ?? 'active') === 'active') {
            map.set(key, JSON.stringify({ ...existing, status: 'superseded', supersededBy: normalized.id }))
          }
        }
        return normalized.id
      },
    },

    cases: {
      async query(filter) {
        const metas: CaseMeta[] = []
        for (const key of [...map.keys()].filter(item => item.startsWith('case:'))) {
          const record = readCaseRecord(map, key)
          if (record === null || record.project !== filter.project) continue
          const latest = [...record.versions].sort((a, b) => (a.version < b.version ? 1 : a.version > b.version ? -1 : 0))[0]
          if (latest === undefined) continue
          if (filter.version !== undefined && latest.version !== filter.version) continue
          if (filter.requirement !== undefined && latest.sourceRequirement !== filter.requirement) continue
          metas.push({
            caseId: record.caseId,
            title: titleOf(latest.content),
            version: latest.version,
            project: record.project,
            ...latest.sourceRequirement === '' ? {} : { sourceRequirement: latest.sourceRequirement },
          })
        }
        return metas
      },
      async archive(caseValue) {
        const key = KEY.case(caseValue.caseId)
        const existing = readCaseRecord(map, key)
        const versions = existing === null ? [] : existing.versions.filter(item => item.version !== caseValue.version)
        map.set(key, JSON.stringify(withSchemaVersion({
          caseId: caseValue.caseId,
          project: caseValue.project,
          versions: [...versions, caseValue],
        })))
      },
    },

    lock: async (pipelineId, options = {}) => {
      const ownerId = options.ownerId ?? randomUUID()
      const path = `memory://${pipelineId}`
      const existing = locks.get(pipelineId)
      if (existing !== undefined && existing.ownerId !== ownerId) {
        // 与文件后端同一句话、同一类错误：抢不到必须抛，不能静默并行
        // （CLI/Web 据此报"该流水线正在别处运行"）。
        //
        // 这里**不能**抛 `StorageUnavailableError`："锁被占"是竞争结果，不是基础设施故障；
        // 混为一谈会让 Web 层把它翻成 503「这台存储用不了了」，把用户引向完全错误的排查方向。
        throw new PipelineLockHeldError({
          pipelineId,
          lockPath: path,
          holder: existing,
          // 内存锁随进程消失，不存在过期阈值，因此如实报 0 而不是编一个 6 小时。
          staleMs: options.staleMs ?? 0,
        })
      }
      const now = Date.now()
      const owner: PipelineLockOwner = { ownerId, generation: 1, pid: process.pid, host: 'memory', acquiredAt: now, heartbeatAt: now }
      locks.set(pipelineId, owner)
      return {
        pipelineId,
        path,
        ownerId,
        generation: 1,
        acquiredAt: now,
        // getter 而不是快照：`renew()` 之后 `lock.owner` 必须反映新的心跳时间，
        // 否则"当前 owner 快照"这个承诺就是假的。
        get owner() { return locks.get(pipelineId) ?? owner },
        async renew() {
          const current = locks.get(pipelineId)
          if (current === undefined || current.ownerId !== ownerId) return false
          locks.set(pipelineId, { ...current, heartbeatAt: Date.now() })
          return true
        },
        async release() {
          const current = locks.get(pipelineId)
          if (current === undefined || current.ownerId !== ownerId) return false
          locks.delete(pipelineId)
          return true
        },
      }
    },
  }

  const backend: MemoryStorageBackend = {
    name: 'memory',
    schemaVersion: STORAGE_SCHEMA_VERSION,
    ports,
    raw,
    describe: () => ({
      name: 'memory',
      implementedPorts: ['artifacts', 'checkpoints', 'tasks', 'gateTasks', 'usage', 'audit', 'knowledge', 'cases', 'lock'],
      unavailablePorts: [],
      requiresExternalInfrastructure: false,
    }),
    diagnose: async () => diagnose(map),
    migrate: async () => migrate(map, backups),
  }
  return backend
}

// ── 原始层读写 ──────────────────────────────────────────────────────────────────

function parseJson(text: string, ref: string, kind: StorageRecordKind): unknown {
  try {
    return JSON.parse(text)
  } catch (error) {
    throw new StorageCorruptError(ref, kind, `不是合法 JSON（${error instanceof Error ? error.message : String(error)}）`)
  }
}

/** 解析 → 校验版本 → 剥信封 → 形状校验。顺序不能换（见 `storage/ports.ts` 的说明）。 */
function readRecord(text: string, ref: string, kind: StorageRecordKind, validate: (value: unknown) => string | null): Record<string, unknown> {
  const parsed = parseJson(text, ref, kind)
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new StorageCorruptError(ref, kind, '顶层不是对象')
  }
  const body = checkAndStripSchemaVersion(ref, kind, parsed as Record<string, unknown>)
  const problem = validate(body)
  if (problem !== null) throw new StorageCorruptError(ref, kind, problem)
  return body
}

function isCheckpointShape(value: unknown): string | null {
  const record = asRecord(value)
  if (record === null) return '顶层不是对象'
  if (typeof record.pipelineId !== 'string' || record.pipelineId === '') return '缺少 pipelineId'
  if (typeof record.cursor !== 'number') return '缺少 cursor'
  return null
}

function isTaskShape(value: unknown): string | null {
  const record = asRecord(value)
  if (record === null) return '顶层不是对象'
  if (typeof record.taskId !== 'string' || record.taskId === '') return '缺少 taskId'
  if (typeof record.pipelineId !== 'string') return '缺少 pipelineId'
  if (typeof record.status !== 'string') return '缺少 status'
  return null
}

function isGateTaskShape(value: unknown): string | null {
  const record = asRecord(value)
  if (record === null) return '顶层不是对象'
  if (typeof record.gateTaskId !== 'string' || record.gateTaskId === '') return '缺少 gateTaskId'
  if (typeof record.pipelineId !== 'string') return '缺少 pipelineId'
  if (typeof record.stageId !== 'string') return '缺少 stageId'
  if (typeof record.status !== 'string') return '缺少 status'
  return null
}

function isCaseRecordShape(value: unknown): string | null {
  const record = asRecord(value)
  if (record === null) return '顶层不是对象'
  if (typeof record.caseId !== 'string' || record.caseId === '') return '缺少 caseId'
  if (!Array.isArray(record.versions)) return 'versions 不是数组'
  return null
}

function isKnowledgeShape(value: unknown): string | null {
  const record = asRecord(value)
  if (record === null) return '顶层不是对象'
  if (typeof record.id !== 'string' || record.id === '') return '缺少 id'
  return null
}

function readKnowledge(map: Map<string, string>, key: string): KnowledgeEntry | null {
  const text = map.get(key)
  if (text === undefined) return null
  const parsed = parseJson(text, key, 'knowledge-entry')
  const problem = isKnowledgeShape(parsed)
  if (problem !== null) throw new StorageCorruptError(key, 'knowledge-entry', problem)
  return parsed as unknown as KnowledgeEntry
}

function readCaseRecord(map: Map<string, string>, key: string): (Record<string, unknown> & { caseId: string; project: string; versions: VersionedCase[] }) | null {
  const text = map.get(key)
  if (text === undefined) return null
  return readRecord(text, key, 'case-record', isCaseRecordShape) as unknown as Record<string, unknown> & { caseId: string; project: string; versions: VersionedCase[] }
}

// ── 任务 ────────────────────────────────────────────────────────────────────────

const TERMINAL_TASK_STATUS: readonly TaskStatus[] = ['completed', 'failed', 'cancelled', 'expired']

function memoryTaskStore(map: Map<string, string>): StoragePorts['tasks'] {
  const read = (taskId: string): TaskRecord | null => {
    const key = KEY.task(taskId)
    const text = map.get(key)
    if (text === undefined) return null
    return readRecord(text, key, 'task', isTaskShape) as unknown as TaskRecord
  }
  const save = (task: TaskRecord): TaskRecord => {
    map.set(KEY.task(task.taskId), JSON.stringify(withSchemaVersion(task as unknown as Record<string, unknown>)))
    return task
  }
  const require = (taskId: string): TaskRecord => {
    const task = read(taskId)
    if (task === null) throw new Error(`task not found: ${taskId}`)
    return task
  }
  const all = (): TaskRecord[] => [...map.keys()]
    .filter(key => key.startsWith('task:'))
    .map(key => read(key.slice('task:'.length)))
    .filter((task): task is TaskRecord => task !== null)

  return {
    async create(input) {
      const now = Date.now()
      return save({ ...input, createdAt: input.createdAt ?? now, updatedAt: input.updatedAt ?? now })
    },
    async get(taskId) { return read(taskId) },
    async list(filter = {}) {
      return all()
        .filter(task => (filter.projectId === undefined || task.projectId === filter.projectId)
          && (filter.pipelineId === undefined || task.pipelineId === filter.pipelineId)
          && (filter.status === undefined || task.status === filter.status))
        .sort((a, b) => a.createdAt - b.createdAt)
    },
    async update(taskId, patch) {
      const current = require(taskId)
      return save({ ...current, ...patch, taskId, createdAt: current.createdAt, updatedAt: Date.now() })
    },
    async acquireLease(taskId, owner, ttlMs) {
      validateLease(owner, ttlMs)
      const current = require(taskId)
      assertLeaseAvailable(current.lease, owner)
      const now = Date.now()
      return save({ ...current, lease: { owner, acquiredAt: now, expiresAt: now + ttlMs }, heartbeatAt: now, status: current.status === 'queued' ? 'running' : current.status, updatedAt: now })
    },
    async heartbeat(taskId, owner, ttlMs) {
      validateLease(owner, ttlMs)
      const current = require(taskId)
      assertLeaseOwner(current.lease, owner)
      const now = Date.now()
      return save({ ...current, lease: { owner, acquiredAt: current.lease!.acquiredAt, expiresAt: now + ttlMs }, heartbeatAt: now, updatedAt: now })
    },
    async releaseLease(taskId, owner) {
      const current = require(taskId)
      assertLeaseOwner(current.lease, owner)
      const { lease: _lease, ...withoutLease } = current
      return save({ ...(withoutLease as TaskRecord), heartbeatAt: Date.now(), lease: undefined, updatedAt: Date.now() })
    },
    async recoverStale(now = Date.now()) {
      const stale = all().filter(task => task.lease !== undefined && task.lease.expiresAt <= now && !TERMINAL_TASK_STATUS.includes(task.status))
      const recovered: TaskRecord[] = []
      for (const task of stale) {
        recovered.push(save({
          ...task, status: 'queued', lease: undefined,
          error: `stale lease recovered from ${task.lease!.owner}`, updatedAt: now,
        }))
      }
      return recovered
    },
  }
}

// ── 人工门任务 ──────────────────────────────────────────────────────────────────

function memoryGateTaskStore(map: Map<string, string>): StoragePorts['gateTasks'] {
  const read = (gateTaskId: string): HumanGateTask | null => {
    const key = KEY.gateTask(gateTaskId)
    const text = map.get(key)
    if (text === undefined) return null
    return readRecord(text, key, 'gate-task', isGateTaskShape) as unknown as HumanGateTask
  }
  const save = (task: HumanGateTask): HumanGateTask => {
    map.set(KEY.gateTask(task.gateTaskId), JSON.stringify(withSchemaVersion(task as unknown as Record<string, unknown>)))
    return task
  }
  const require = (gateTaskId: string): HumanGateTask => {
    const task = read(gateTaskId)
    if (task === null) throw new Error(`human gate task not found: ${gateTaskId}`)
    return task
  }
  const all = (): HumanGateTask[] => [...map.keys()]
    .filter(key => key.startsWith('gate:'))
    .map(key => read(key.slice('gate:'.length)))
    .filter((task): task is HumanGateTask => task !== null)

  return {
    async create(input) {
      const now = Date.now()
      return save({ ...input, status: input.status ?? 'pending', createdAt: input.createdAt ?? now, updatedAt: input.updatedAt ?? now })
    },
    async get(gateTaskId) { return read(gateTaskId) },
    async list(filter = {}) {
      return all()
        .filter(task => (filter.projectId === undefined || task.projectId === filter.projectId)
          && (filter.pipelineId === undefined || task.pipelineId === filter.pipelineId)
          && (filter.status === undefined || task.status === filter.status))
        .sort((a, b) => a.createdAt - b.createdAt)
    },
    async claim(gateTaskId, actor, ttlMs) {
      validateLease(actor, ttlMs)
      const current = require(gateTaskId)
      if (!['pending', 'claimed'].includes(current.status)) throw new Error(`human gate task is not claimable: ${current.status}`)
      if (current.lease !== undefined && current.lease.expiresAt > Date.now() && current.lease.owner !== actor) throw new Error(`human gate task is claimed by ${current.lease.owner}`)
      const now = Date.now()
      return save({ ...current, status: 'claimed', claimedBy: actor, lease: { owner: actor, acquiredAt: current.lease?.acquiredAt ?? now, expiresAt: now + ttlMs }, updatedAt: now })
    },
    async decide(gateTaskId, actor, action, note) {
      const current = require(gateTaskId)
      if (current.status !== 'claimed' || current.claimedBy !== actor) throw new Error('human gate decision requires the active claim owner')
      if (note.trim() === '' && action !== 'approved') throw new Error('changes-needed/rejected decisions require a non-empty note')
      const { lease: _lease, ...withoutLease } = current
      return save({ ...(withoutLease as HumanGateTask), status: action as HumanGateTaskStatus, decision: { by: actor, action, note, at: Date.now() }, updatedAt: Date.now(), lease: undefined })
    },
    async expire(now = Date.now()) {
      const candidates = all().filter(task => (task.expiresAt !== undefined && task.expiresAt <= now && ['pending', 'claimed'].includes(task.status))
        || (task.lease !== undefined && task.lease.expiresAt <= now && task.status === 'claimed'))
      return candidates.map(task => save({ ...task, status: 'expired', updatedAt: now, lease: undefined }))
    },
    async consume(gateTaskId, at = Date.now()) {
      const current = require(gateTaskId)
      if (current.consumedAt !== undefined) return current
      if (!['approved', 'changes-needed', 'rejected'].includes(current.status)) throw new Error(`human gate task is not consumable: ${current.status}`)
      return save({ ...current, consumedAt: at, updatedAt: at })
    },
    async cancel(gateTaskId, actor, note = '') {
      if (actor.trim() === '') throw new Error('cancellation actor must not be empty')
      const current = require(gateTaskId)
      if (!['pending', 'claimed'].includes(current.status)) throw new Error(`human gate task is not cancellable: ${current.status}`)
      const { lease: _lease, ...withoutLease } = current
      const now = Date.now()
      return save({ ...(withoutLease as HumanGateTask), status: 'cancelled', cancellation: { by: actor, note, at: now }, updatedAt: now, lease: undefined })
    },
  }
}

// ── 用量 ────────────────────────────────────────────────────────────────────────

function memoryUsageStore(map: Map<string, string>): StoragePorts['usage'] {
  return {
    async append(event: UsageEvent) {
      const key = KEY.usage(event.pipelineId)
      const existing = map.get(key) ?? ''
      map.set(key, `${existing}${JSON.stringify(withSchemaVersion(event as unknown as Record<string, unknown>))}\n`)
    },
    async read(pipelineId: string): Promise<UsageLogRead> {
      const text = map.get(KEY.usage(pipelineId))
      if (text === undefined) return { events: [], skipped: [] }
      const events: UsageEvent[] = []
      const skipped: { line: number; reason: string }[] = []
      const lines = text.split('\n')
      for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index]!.trim()
        if (line === '') continue
        try {
          const parsed = parseJson(line, `usage/${pipelineId}.jsonl#L${index + 1}`, 'usage-event')
          const record = asRecord(parsed)
          if (record === null) throw new Error('用量事件必须是 JSON 对象')
          const body = checkAndStripSchemaVersion(`usage/${pipelineId}.jsonl#L${index + 1}`, 'usage-event', record)
          if (!isUsageEvent(body)) throw new Error('用量事件字段缺失或类型不符')
          events.push(body)
        } catch (error) {
          skipped.push({ line: index + 1, reason: errorMessageOf(error) })
        }
      }
      return { events, skipped }
    },
  }
}

// ── 审计 ────────────────────────────────────────────────────────────────────────

const SECRET_TEXT_PATTERN = /\b(?:sk|Bearer)[-_][A-Za-z0-9._-]{8,}/gi
const SECRET_FIELD_PATTERN = /(api[-_]?key|authorization|bearer|token|secret|password|credential)/i

function memoryAuditStore(map: Map<string, string>): StoragePorts['audit'] {
  return {
    async append(input) {
      const event: AuditEvent = {
        ...input,
        eventId: input.eventId ?? randomUUID(),
        at: input.at ?? Date.now(),
        detail: input.detail.replace(SECRET_TEXT_PATTERN, '[redacted]'),
        ...(input.metadata === undefined ? {} : { metadata: scrubMetadata(input.metadata) }),
      }
      const key = KEY.audit
      const existing = map.get(key) ?? ''
      map.set(key, `${existing}${JSON.stringify(withSchemaVersion(event as unknown as Record<string, unknown>))}\n`)
      return event
    },
    async read(query: AuditEventQuery = {}): Promise<AuditEventRead> {
      const text = map.get(KEY.audit)
      if (text === undefined) return { events: [], skipped: [] }
      const events: AuditEvent[] = []
      const skipped: { line: number; reason: string }[] = []
      const lines = text.split('\n')
      for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index]!.trim()
        if (line === '') continue
        try {
          const parsed = parseJson(line, `audit.jsonl#L${index + 1}`, 'audit-event')
          const record = asRecord(parsed)
          if (record === null) throw new Error('审计事件必须是 JSON 对象')
          const body = checkAndStripSchemaVersion(`audit.jsonl#L${index + 1}`, 'audit-event', record)
          if (!isAuditEvent(body)) throw new Error('审计事件字段缺失或类型不符')
          if (query.projectId !== undefined && body.projectId !== query.projectId) continue
          if (query.pipelineId !== undefined && body.pipelineId !== query.pipelineId) continue
          if (query.kind !== undefined && body.kind !== query.kind) continue
          if (query.since !== undefined && body.at < query.since) continue
          events.push(body)
        } catch (error) {
          skipped.push({ line: index + 1, reason: errorMessageOf(error) })
        }
      }
      events.sort((a, b) => a.at - b.at)
      const limit = query.limit ?? 200
      return { events: events.slice(Math.max(0, events.length - limit)), skipped }
    },
  }
}

function scrubMetadata(value: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  const out: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value)) {
    if (SECRET_FIELD_PATTERN.test(key)) continue
    out[key] = typeof item === 'string' ? item.replace(SECRET_TEXT_PATTERN, '[redacted]') : item
  }
  return out
}

// ── 体检与迁移 ──────────────────────────────────────────────────────────────────

interface ScanTarget {
  readonly prefix: string
  readonly kind: StorageRecordKind
  readonly validate: (value: unknown) => string | null
}

/** 带版本信封的记录：体检要看版本，迁移要补版本。 */
const VERSIONED_PREFIXES: readonly ScanTarget[] = [
  { prefix: 'checkpoint:', kind: 'checkpoint', validate: isCheckpointShape },
  { prefix: 'task:', kind: 'task', validate: isTaskShape },
  { prefix: 'gate:', kind: 'gate-task', validate: isGateTaskShape },
  { prefix: 'case:', kind: 'case-record', validate: isCaseRecordShape },
]

/**
 * 不带平台版本信封的记录。
 *
 * 知识条目的"版本"是**领域概念**（`KnowledgeEntry.version`），不是存储 schema 版本，
 * 所以体检只做 JSON 与形状检查、**不**报 `migration-needed`，迁移也不碰它——
 * 与文件后端一致（`<!-- pp-meta -->` 行本身就是领域条目）。
 * 但仍要扫：否则知识记录被写坏时 `diagnose` 会报"健康"，而 `read` 却抛错。
 */
const SHAPE_ONLY_PREFIXES: readonly ScanTarget[] = [
  { prefix: 'knowledge:', kind: 'knowledge-entry', validate: isKnowledgeShape },
]

async function diagnose(map: Map<string, string>) {
  const diagnostics: StorageDiagnostic[] = []
  for (const [key, text] of map) {
    const versioned = VERSIONED_PREFIXES.find(item => key.startsWith(item.prefix))
    const shapeOnly = versioned === undefined ? SHAPE_ONLY_PREFIXES.find(item => key.startsWith(item.prefix)) : undefined
    const target = versioned ?? shapeOnly
    if (target === undefined) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch (error) {
      diagnostics.push({ code: 'corrupt-json', kind: target.kind, ref: key, detail: `不是合法 JSON（${errorMessageOf(error)}）`, recoverable: false })
      continue
    }
    const record = asRecord(parsed)
    if (record === null) {
      diagnostics.push({ code: 'schema-invalid', kind: target.kind, ref: key, detail: '顶层不是对象', recoverable: false })
      continue
    }
    const problem = target.validate(record)
    if (problem !== null) {
      diagnostics.push({ code: 'schema-invalid', kind: target.kind, ref: key, detail: problem, recoverable: false })
      continue
    }
    if (shapeOnly !== undefined) continue
    const version = readSchemaVersion(record)
    if (version === 'invalid') {
      diagnostics.push({ code: 'schema-invalid', kind: target.kind, ref: key, detail: 'schemaVersion 不是非负整数', recoverable: false })
      continue
    }
    if (version === null) {
      diagnostics.push({ code: 'migration-needed', kind: target.kind, ref: key, detail: `缺少 schemaVersion（按历史遗留 v1 处理），可迁移到 v${STORAGE_SCHEMA_VERSION}`, recoverable: true })
      continue
    }
    if (version > STORAGE_SCHEMA_VERSION) {
      diagnostics.push({ code: 'unsupported-version', kind: target.kind, ref: key, detail: `schemaVersion=${version} 高于本进程支持的 ${STORAGE_SCHEMA_VERSION}：请升级进程，不要降级解析`, recoverable: false })
    }
  }
  return { backend: 'memory', ok: diagnostics.length === 0, schemaVersion: STORAGE_SCHEMA_VERSION, diagnostics }
}

async function migrate(map: Map<string, string>, backups: Map<string, string>): Promise<StorageMigrationReport> {
  const migrated: { ref: string; kind: StorageRecordKind; from: number }[] = []
  const skipped: { ref: string; kind: StorageRecordKind; reason: string }[] = []
  for (const [key, text] of map) {
    const target = VERSIONED_PREFIXES.find(item => key.startsWith(item.prefix))
    if (target === undefined) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch (error) {
      skipped.push({ ref: key, kind: target.kind, reason: `损坏（不是合法 JSON）：${errorMessageOf(error)}` })
      continue
    }
    const record = asRecord(parsed)
    if (record === null) {
      skipped.push({ ref: key, kind: target.kind, reason: '顶层不是 JSON 对象' })
      continue
    }
    const problem = target.validate(record)
    if (problem !== null) {
      skipped.push({ ref: key, kind: target.kind, reason: `形状不符：${problem}` })
      continue
    }
    const version = readSchemaVersion(record)
    if (version === 'invalid') {
      skipped.push({ ref: key, kind: target.kind, reason: 'schemaVersion 不是非负整数' })
      continue
    }
    if (version === STORAGE_SCHEMA_VERSION) continue
    if (version !== null && version > STORAGE_SCHEMA_VERSION) {
      skipped.push({ ref: key, kind: target.kind, reason: `schemaVersion=${version} 高于本进程支持的 ${STORAGE_SCHEMA_VERSION}，需升级进程` })
      continue
    }
    // 内存后端的"备份"就是原值快照：进程内存里的数据没有持久化价值，
    // 因此不宣称存在可回滚的磁盘备份（backupDir 恒为 null），但快照仍然留着可查。
    backups.set(key, text)
    map.set(key, JSON.stringify(withSchemaVersion(record)))
    migrated.push({ ref: key, kind: target.kind, from: version ?? 1 })
  }
  return {
    backend: 'memory',
    fromVersion: 1,
    toVersion: STORAGE_SCHEMA_VERSION,
    migrated,
    skipped,
    // 诚实优先于形式一致：内存后端没有可回滚的磁盘备份，不谎报一个目录。
    backupDir: null,
  }
}

// ── 形状守卫 ────────────────────────────────────────────────────────────────────

const WRAPPER_KEYS = new Set(['inputs', 'digest', 'version', 'pipelineId', 'stageId', 'path'])

function isPersistedArtifact(value: unknown): value is StageArtifact {
  const record = asRecord(value)
  if (record === null) return false
  return typeof record.pipelineId === 'string'
    && typeof record.stageId === 'string'
    && typeof record.version === 'number'
    && typeof record.digest === 'string'
    && typeof record.path === 'string'
    && asRecord(record.inputs) !== null
    && 'content' in record
}

function stripWrapperKeys(content: unknown): unknown {
  const record = asRecord(content)
  if (record === null) return content
  const out = { ...record }
  for (const key of WRAPPER_KEYS) delete out[key]
  return out
}

function wrapContent(path: string, content: unknown): StageArtifact {
  assertSafeArtifactPath(path)
  const segments = path.split('/')
  const stageId = (segments.pop() ?? '').replace(/\.json$/, '')
  const pipelineId = segments.pop() ?? 'unknown'
  const base: StageArtifact = {
    pipelineId, stageId: stageId as StageArtifact['stageId'],
    version: 1, inputs: {}, content: stripWrapperKeys(content), digest: '', path,
  }
  return { ...base, digest: computeArtifactDigest(base) }
}

/** 与 `FsArtifactStore` 同一判据与同一句话（契约测的就是这条）。 */
function assertSafeArtifactPath(path: string): void {
  if (path.includes('..') || path.startsWith('/') || path.includes('\\')) {
    throw new Error(`path escapes artifact base: ${path}`)
  }
}

function isUsageEvent(value: unknown): value is UsageEvent {
  const record = asRecord(value)
  if (record === null) return false
  return typeof record.eventId === 'string'
    && typeof record.pipelineId === 'string'
    && typeof record.stageId === 'string'
    && typeof record.kind === 'string'
    && typeof record.success === 'boolean'
}

function isAuditEvent(value: unknown): value is AuditEvent {
  const record = asRecord(value)
  if (record === null) return false
  return typeof record.eventId === 'string' && record.eventId !== ''
    && typeof record.at === 'number' && Number.isFinite(record.at)
    && typeof record.kind === 'string' && record.kind !== ''
    && typeof record.actor === 'string' && record.actor !== ''
    && typeof record.detail === 'string'
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

// ── 通用小工具 ──────────────────────────────────────────────────────────────────

function validateLease(owner: string, ttlMs: number): void {
  if (owner.trim() === '') throw new Error('lease owner must not be empty')
  if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) throw new Error('lease ttlMs must be a positive integer')
}

function assertLeaseAvailable(lease: { readonly owner: string; readonly expiresAt: number } | undefined, owner: string): void {
  if (lease !== undefined && lease.expiresAt > Date.now() && lease.owner !== owner) throw new Error(`task is leased by ${lease.owner}`)
}

function assertLeaseOwner(lease: { readonly owner: string; readonly expiresAt: number } | undefined, owner: string): void {
  if (lease === undefined || lease.owner !== owner || lease.expiresAt <= Date.now()) throw new Error('active lease ownership is required')
}

function normalizeTerm(value: string): string {
  return value.trim().toLocaleLowerCase('zh-CN').replace(/\s+/g, '')
}

function tokenize(value: string): string[] {
  const normalized = value.trim().toLocaleLowerCase('zh-CN')
  if (normalized === '') return []
  const terms = normalized.split(/[\s,，、;；/]+/).filter(Boolean)
  const chars = [...normalized.replace(/[\s,，、;；/]+/g, '')]
  return [...new Set([...terms, ...chars.filter(char => /[\u4e00-\u9fff]/.test(char))])]
}

function titleOf(content: unknown): string {
  const record = asRecord(content)
  if (record !== null && typeof record.title === 'string' && record.title !== '') return record.title
  return '(未命名用例)'
}

function errorMessageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * 知识检索（从原始层重建，`read` 与 `readHits` 共用）。
 *
 * 刻意做成**模块级函数**而不是对象方法：对象方法里的 `this` 一旦被解构
 * （`const { readHits } = store`）就会失效，而后端实现是会被解构/转发的。
 */
async function readHitsFromMap(map: Map<string, string>, query: KnowledgeQuery): Promise<KnowledgeHit[]> {
  const entities = (query.entities ?? []).map(normalizeTerm).filter(Boolean)
  const tags = (query.tags ?? []).map(normalizeTerm).filter(Boolean)
  const textTerms = tokenize(query.text ?? '')
  const hits: KnowledgeHit[] = []
  for (const key of [...map.keys()].filter(item => item.startsWith('knowledge:'))) {
    const entry = readKnowledge(map, key)
    if (entry === null) continue
    if (query.project !== undefined && entry.project !== query.project) continue
    const status = entry.status ?? 'active'
    if ((query.status ?? 'active') !== status) continue
    if (query.service !== undefined && entry.scope?.services !== undefined && !entry.scope.services.includes(query.service)) continue
    if (query.environment !== undefined && entry.scope?.environments !== undefined && !entry.scope.environments.includes(query.environment)) continue
    const searchable = [entry.title, ...entry.tags, ...entry.entities, entry.body].map(normalizeTerm).join(' ')
    const matchedEntities = entities.filter(term => searchable.includes(term))
    const matchedTags = tags.filter(term => entry.tags.map(normalizeTerm).some(tag => tag.includes(term)))
    const matchedText = textTerms.filter(term => searchable.includes(term))
    if (entities.length + tags.length + textTerms.length === 0) continue
    if (matchedEntities.length + matchedTags.length + matchedText.length === 0) continue
    const matchedBy: KnowledgeHit['matchedBy'] = [
      ...(matchedEntities.length > 0 ? ['entity' as const] : []),
      ...(matchedTags.length > 0 ? ['tag' as const] : []),
      ...(matchedText.some(term => normalizeTerm(entry.title).includes(term)) ? ['title' as const] : []),
      ...(matchedText.some(term => normalizeTerm(entry.body).includes(term)) ? ['body' as const] : []),
    ]
    hits.push({
      entry,
      score: matchedEntities.length * 4 + matchedTags.length * 3 + matchedText.length,
      matchedBy,
      matchedTerms: [...new Set([...matchedEntities, ...matchedTags, ...matchedText])],
    })
  }
  hits.sort((a, b) => b.score - a.score || (a.entry.date < b.entry.date ? 1 : -1))
  return hits.slice(0, Math.max(0, query.limit))
}
