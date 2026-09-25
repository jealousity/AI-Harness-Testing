/**
 * 存储端口统一面（docs/10 §8.2 / §8.3）。
 *
 * 核心规则（driver / gates / stages / tools）**只能依赖这里的接口**，不能依赖
 * `FileHumanGateTaskStore`、`MarkdownKnowledgeStore` 或某个数据库 SDK 的具体类型。
 * 后端切换只改宿主装配（`storage/file`、`storage/memory`、未来的 `storage/postgres`
 * 与 `storage/object-store`），**不改 driver / stages / gates**（docs/10 §8.4）。
 *
 * 三个正交的关注点，别混在一起：
 * 1. **端口**（{@link StoragePorts}）：一组能力接口，编排层与工具只认它。
 * 2. **版本**（{@link STORAGE_SCHEMA_VERSION}）：平台自有的 JSON 记录自带
 *    `schemaVersion`。读到**更高**版本必须显式失败（不猜、不降级、不按当前版本硬解），
 *    读到**旧**版本是可迁移的（{@link StorageBackend.migrate}）。
 * 3. **健康**（{@link StorageBackend.diagnose}）：损坏文件**显式报告**，
 *    绝不静默当空数据——「读不到」与「读坏了」是两件事（docs/10 §8.3 M4-A）。
 *
 * 分层约定：本模块只依赖 `types.ts` / `usage.ts` / `runtime/persistence.ts` /
 * `checkpoint-lock.ts` 的**类型**，不 import 任何具体实现，也不 import `driver.ts`
 * （`driver.ts` 反向依赖本模块）。`ArtifactStore` 与 `CheckpointPort` 的声明**已迁到
 * 本模块**，`driver.ts` 仅做再导出以保持既有 import 路径不变。
 *
 * @module platform-pipeline/storage/ports
 */

import type { AcquirePipelineLockOptions, PipelineLock } from '../checkpoint-lock.ts'
import type { HumanGateTaskStore, TaskStore } from '../runtime/persistence.ts'
import type { UsageStore } from '../usage.ts'
import type { Checkpoint, StageArtifact } from '../types.ts'

// ── 版本 ────────────────────────────────────────────────────────────────────────

/**
 * 平台自有落盘记录的 schema 版本。
 *
 * 语义（务必照此实现，不要"宽容解析"）：
 * - 记录**没有** `schemaVersion` 字段 = 历史遗留的 v1（迁移目标）；
 * - `schemaVersion === STORAGE_SCHEMA_VERSION` = 当前版本；
 * - `schemaVersion < STORAGE_SCHEMA_VERSION` = 可迁移，`diagnose` 报 `migration-needed`；
 * - `schemaVersion > STORAGE_SCHEMA_VERSION` = **本进程读不懂**，抛
 *   {@link StorageSchemaVersionError}。降级去猜字段只会把数据改坏。
 *
 * 每次**不兼容**地改动这些记录的字段形状时必须 +1，并在 `migrate` 里补一条升级路径。
 */
export const STORAGE_SCHEMA_VERSION = 1

/** 落盘记录的种类（诊断与迁移报告用；不是目录名）。 */
export type StorageRecordKind =
  | 'checkpoint'
  | 'artifact'
  | 'task'
  | 'gate-task'
  | 'case-record'
  | 'knowledge-entry'
  | 'usage-event'
  | 'audit-event'

// ── 诊断 ────────────────────────────────────────────────────────────────────────

/**
 * 诊断码。`missing` 是**正常**结果（首次运行就是没有），其余都是异常或待办。
 *
 * 之所以把 `missing` 也列进来：`ok` 的判据是「没有非 missing 的诊断」，
 * 这样"全空的项目根"不会被误报成不健康。
 */
export type StorageDiagnosticCode =
  /** 记录不存在（正常，不是故障）。 */
  | 'missing'
  /** JSON 解析失败（文件被写坏、磁盘截断、被手工改错）。 */
  | 'corrupt-json'
  /** JSON 合法但形状不符合契约（缺必填字段、类型不对）。 */
  | 'schema-invalid'
  /** `schemaVersion` 高于本进程支持——**必须显式失败**，不能按当前版本硬解。 */
  | 'unsupported-version'
  /** 旧版本，可被 `migrate` 升级。 */
  | 'migration-needed'
  /** 路径越界 / 软链接逃逸 / 权限不足 / IO 错误。 */
  | 'unreadable'

export interface StorageDiagnostic {
  readonly code: StorageDiagnosticCode
  readonly kind: StorageRecordKind
  /** 记录引用：相对项目根的路径，或后端自定的稳定标识（**不含绝对路径**）。 */
  readonly ref: string
  /** 人读说明（中文）。 */
  readonly detail: string
  /** `migrate` 能否自动修复（`corrupt-json` 一律 false——坏字节不能猜）。 */
  readonly recoverable: boolean
}

export interface StorageHealth {
  readonly backend: string
  /** 无任何非 `missing` 诊断时为 true。 */
  readonly ok: boolean
  /** 后端当前写入的 schema 版本。 */
  readonly schemaVersion: number
  readonly diagnostics: readonly StorageDiagnostic[]
}

// ── 错误 ────────────────────────────────────────────────────────────────────────

/**
 * 存储**不可用**（基础设施故障）：连不上、没权限、磁盘满、根目录不存在。
 *
 * 与领域错误的区别必须保持住（docs/10 §8.4）：
 * - 它**不是**"阶段产物写得不好"，因此**绝不能**被 driver 归成门禁违规去让 agent 重做
 *   —— 重做一百次也写不进一个只读的盘；
 * - 它**绝不能**触发自动批准或覆盖旧数据，只能上抛成 infrastructure failure；
 * - Web 层映射成 `storage-unavailable`（HTTP 503），与 `run-failed`(500) 区分开。
 */
export class StorageUnavailableError extends Error {
  readonly backend: string
  readonly operation: string

  constructor(backend: string, operation: string, message: string, options: { cause?: unknown } = {}) {
    super(`[storage:${backend}] ${operation} 不可用：${message}`, options)
    this.name = 'StorageUnavailableError'
    this.backend = backend
    this.operation = operation
  }
}

/**
 * 记录**损坏**（JSON 非法或形状不符）。
 *
 * 与 {@link StorageUnavailableError} 分开：损坏是"这份数据不能用了"，
 * 不可用是"这台存储用不了了"。前者可以诊断 + 人工修复 + 迁移，后者只能修基础设施。
 * 两者都**不**允许被当成空数据静默跳过（docs/10 §8.3 M4-A）。
 */
export class StorageCorruptError extends Error {
  readonly ref: string
  readonly kind: StorageRecordKind
  readonly diagnostics: readonly StorageDiagnostic[]

  constructor(ref: string, kind: StorageRecordKind, message: string, options: { cause?: unknown } = {}) {
    super(`存储记录损坏（${kind} ${ref}）：${message}`, options)
    this.name = 'StorageCorruptError'
    this.ref = ref
    this.kind = kind
    this.diagnostics = [{
      code: 'corrupt-json',
      kind,
      ref,
      detail: message,
      recoverable: false,
    }]
  }
}

/** 记录版本高于本进程支持：只能升级进程，不能降级解析。 */
export class StorageSchemaVersionError extends Error {
  readonly ref: string
  readonly found: number
  readonly supported: number

  constructor(ref: string, found: number, supported: number) {
    super(`存储记录 ${ref} 的 schemaVersion=${found} 高于本进程支持的 ${supported}：请升级进程，不要降级解析`)
    this.name = 'StorageSchemaVersionError'
    this.ref = ref
    this.found = found
    this.supported = supported
  }
}

/** 存储不可用时的统一归类（Web / CLI 层用它决定 infrastructure failure）。 */
export function isStorageInfrastructureError(error: unknown): boolean {
  return error instanceof StorageUnavailableError
}

/** 损坏或版本不符（可诊断、可迁移、可人工修）。 */
export function isStorageDataError(error: unknown): boolean {
  return error instanceof StorageCorruptError || error instanceof StorageSchemaVersionError
}

// ── 版本字段读写 ────────────────────────────────────────────────────────────────

/**
 * 读记录里的 `schemaVersion`。
 *
 * 返回 `null` = 字段缺失（历史遗留 v1）。返回 `'invalid'` = 字段存在但不是非负整数
 * ——这**不是**"当作 v1 宽容处理"的场景，调用方应报 `schema-invalid`。
 */
export function readSchemaVersion(value: unknown): number | null | 'invalid' {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  const raw = (value as Record<string, unknown>).schemaVersion
  if (raw === undefined) return null
  if (typeof raw !== 'number' || !Number.isSafeInteger(raw) || raw < 0) return 'invalid'
  return raw
}

/**
 * 校验读到的版本，必要时抛错。
 *
 * 调用点必须在**解析出形状之前**调用它：版本更高的记录可能字段全变了，
 * 先按当前版本解构会得到一堆 `undefined`，然后把"读不懂"伪装成"空数据"。
 */
export function assertSchemaVersion(ref: string, value: unknown): number {
  const version = readSchemaVersion(value)
  if (version === 'invalid') throw new StorageCorruptError(ref, 'checkpoint', 'schemaVersion 不是非负整数')
  if (version === null) return STORAGE_SCHEMA_VERSION // 历史遗留，按当前形状读（见 migrate）
  if (version > STORAGE_SCHEMA_VERSION) throw new StorageSchemaVersionError(ref, version, STORAGE_SCHEMA_VERSION)
  return version
}

/** 给待落盘的记录补上 `schemaVersion`（已是当前版本则原样返回，不重复写）。 */
export function withSchemaVersion<T extends Record<string, unknown>>(value: T): T & { readonly schemaVersion: number } {
  if (value.schemaVersion === STORAGE_SCHEMA_VERSION) return value as T & { readonly schemaVersion: number }
  return { ...value, schemaVersion: STORAGE_SCHEMA_VERSION }
}

/**
 * 校验并**剥掉** `schemaVersion`（JSONL 日志的读路径用）。
 *
 * 为什么剥掉：`schemaVersion` 是**存储信封**，不是业务字段。端口对外的返回类型是
 * `UsageEvent` / `AuditEvent`，如果把它漏出去，类型就在说谎，而且汇总逻辑
 * （例如断言字段集封闭的测试）会被一个纯存储关注点污染。
 *
 * 版本更高的行**不猜**：抛 {@link StorageSchemaVersionError}，由调用方决定
 * 是整份失败还是把这一行记进 `skipped`。
 */
export function checkAndStripSchemaVersion(ref: string, kind: StorageRecordKind, value: Record<string, unknown>): Record<string, unknown> {
  const version = readSchemaVersion(value)
  if (version === 'invalid') throw new StorageCorruptError(ref, kind, 'schemaVersion 不是非负整数')
  if (version !== null && version > STORAGE_SCHEMA_VERSION) {
    throw new StorageSchemaVersionError(ref, version, STORAGE_SCHEMA_VERSION)
  }
  if (version === null) return value
  const { schemaVersion: _dropped, ...rest } = value
  return rest
}

// ── 审计 ────────────────────────────────────────────────────────────────────────

/**
 * 审计事件种类（docs/10 §8.2 的 `AuditEventStore`）。
 *
 * 刻意**不含** `usage` 类事件：用量是计量（高频、可丢、有独立汇总），
 * 审计是责任链（低频、必须成对可查）。混在一起会让两者都难用。
 */
export type AuditEventKind =
  | 'pipeline-created'
  | 'run-started'
  | 'run-settled'
  | 'stage-advanced'
  | 'gate-opened'
  | 'gate-decided'
  | 'gate-failed'
  | 'reentry'
  | 'cancelled'
  | 'artifact-written'
  | 'executor-invoked'
  | 'knowledge-written'
  | 'case-archived'
  | 'lock-event'
  | 'storage-migrated'

/**
 * 审计事件。
 *
 * **只记标识与结论，绝不记凭据**（docs/10 §2.2 / §9.1）：`detail` 与 `metadata`
 * 不得出现 API Key、完整 prompt、模型响应正文。
 */
export interface AuditEvent {
  readonly eventId: string
  readonly at: number
  readonly kind: AuditEventKind
  /** 触发者：真人 id、后台运行标识或系统组件名。 */
  readonly actor: string
  readonly tenantId?: string
  readonly projectId?: string
  readonly pipelineId?: string
  readonly stageId?: string
  /** 人读说明（中文）。 */
  readonly detail: string
  readonly metadata?: Readonly<Record<string, unknown>>
}

export interface AuditEventQuery {
  readonly projectId?: string
  readonly pipelineId?: string
  readonly kind?: AuditEventKind
  /** 只返回 `at >= since` 的事件。 */
  readonly since?: number
  /** 上限（默认 200；防止把整份审计读进内存）。 */
  readonly limit?: number
}

/**
 * 审计读取结果。
 *
 * 与 `UsageLogRead` 同形（`{ events, skipped }`）而不是直接返回数组：审计文件是
 * **append-only 的文本**，一行写坏是可能的（磁盘截断、手工编辑、并发写入未落齐）。
 * 直接返回数组只有两种实现——要么整份读不出来（法证价值归零），
 * 要么静默少几行（"没发生过"与"读不出来"混为一谈）。显式返回 `skipped` 两者都避免。
 */
export interface AuditEventRead {
  readonly events: readonly AuditEvent[]
  readonly skipped: readonly { readonly line: number; readonly reason: string }[]
}

/**
 * 审计事件存储：**append-only**。
 *
 * 没有 `update` / `delete`：审计要么是"当时记下的"，要么不存在。
 * 允许"重放同一条事件"是后端的自由（例如网络重试），因此 `eventId` 由调用方提供时
 * 应当被尊重，但**不要求**去重——去重会让"漏了一条"与"重了一条"都变得不可见。
 */
export interface AuditEventStore {
  append(input: Omit<AuditEvent, 'eventId' | 'at'> & Partial<Pick<AuditEvent, 'eventId' | 'at'>>): Promise<AuditEvent>
  read(query?: AuditEventQuery): Promise<AuditEventRead>
}

// ── 端口 ────────────────────────────────────────────────────────────────────────

/**
 * 产物读写端口（宿主实现为 fs / 对象存储）。
 *
 * 已从 `driver.ts` 迁到本模块：它是**存储**能力，不是编排能力。
 * `driver.ts` 仍再导出它，既有 `import { type ArtifactStore } from '../driver.ts'` 不受影响。
 */
export interface ArtifactStore {
  read(path: string): Promise<StageArtifact | null>
  /** 可选：将宿主补全后的 wrapper 元数据持久化，保证重启后 digest/inputs 不漂移。 */
  write?(artifact: StageArtifact): Promise<void>
}

/** 检查点读写端口（已从 `driver.ts` 迁到本模块）。 */
export interface CheckpointPort {
  load(root: string): Promise<Checkpoint | null>
  save(root: string, checkpoint: Checkpoint): Promise<void>
}

// ── 知识库 / 用例库 ──────────────────────────────────────────────────────────────

/**
 * 知识条目与用例的**数据类型**声明在这里（而不是在 `stores/markdown.ts`）。
 *
 * 理由：端口必须能被"非 markdown 后端"实现（数据库、向量库、对象存储）。
 * 数据类型若留在某个具体后端模块里，其它后端就只能反向依赖那个模块——
 * 这正是 docs/10 §8.2 要避免的「核心规则依赖具体类型」。
 * `stores/markdown.ts` 仍然再导出它们，既有 import 路径不变。
 */

export type KnowledgeKind =
  | 'requirement-fact' | 'test-finding' | 'defect-pattern' | 'risk-pattern'
  | 'test-strategy' | 'environment-issue' | 'reuse-candidate' | 'decision-record'
  | 'api-contract' | 'release-lesson'

export type KnowledgeStatus = 'draft' | 'reviewed' | 'active' | 'superseded' | 'archived'
export type KnowledgeConfidence = 'unverified' | 'inferred' | 'reviewed' | 'verified'

export interface KnowledgeEntry {
  readonly id: string
  readonly title: string
  readonly date: string
  readonly project: string
  readonly version: string
  readonly tags: readonly string[]
  readonly entities: readonly string[]
  readonly body: string
  readonly sourcePipeline: string
  readonly kind?: KnowledgeKind
  readonly status?: KnowledgeStatus
  readonly confidence?: KnowledgeConfidence
  readonly sourceRefs?: readonly string[]
  readonly scope?: Readonly<{ services?: readonly string[]; environments?: readonly string[] }>
  readonly validUntil?: string
  readonly supersedes?: readonly string[]
  readonly supersededBy?: string
}

export interface KnowledgeQuery {
  readonly entities?: readonly string[]
  readonly tags?: readonly string[]
  readonly text?: string
  readonly project?: string
  readonly service?: string
  readonly environment?: string
  readonly status?: KnowledgeStatus
  readonly includeExpired?: boolean
  readonly limit: number
}

export interface KnowledgeConflict {
  readonly existingId: string
  readonly existingVersion: string
  readonly detail: string
}

export interface KnowledgeHit {
  readonly entry: KnowledgeEntry
  readonly score: number
  readonly matchedBy: readonly ('title' | 'tag' | 'entity' | 'body')[]
  readonly matchedTerms: readonly string[]
}

export interface CaseMeta {
  readonly caseId: string
  readonly title: string
  readonly version: string
  readonly project: string
  readonly sourceRequirement?: string
}

export interface VersionedCase {
  readonly caseId: string
  readonly version: string
  readonly project: string
  readonly sourceRequirement: string
  readonly ticketRef: string
  readonly content: unknown
}

/**
 * 知识库端口（docs/10 §8.2 `KnowledgeStore`）。
 *
 * `write` **不做**冲突裁决——冲突必须由调用方先 `findConflicts` 再决定
 * （supersedes 或走人工门）。把裁决藏进 write 会让"谁批准了这次覆盖"失去痕迹。
 */
export interface KnowledgeStorePort {
  read(query: KnowledgeQuery): Promise<readonly KnowledgeEntry[]>
  /** 命中明细（含 score 与匹配维度）；不支持排序打分的后端可以不实现。 */
  readHits?(query: KnowledgeQuery): Promise<readonly KnowledgeHit[]>
  findConflicts(entry: KnowledgeEntry): Promise<readonly KnowledgeConflict[]>
  write(entry: KnowledgeEntry): Promise<string>
}

/** 用例库端口（docs/10 §8.2 `CaseStore`，版本化回流 R6-02）。 */
export interface CaseStorePort {
  query(filter: { readonly project: string; readonly requirement?: string; readonly version?: string }): Promise<readonly CaseMeta[]>
  archive(caseValue: VersionedCase): Promise<void>
}

/**
 * 存储端口集合。
 *
 * `required` 的端口必须存在；`knowledge` / `cases` / `lock` 是**可选**的：
 * 不是每个部署形态都需要知识库（例如纯执行环境），也不需要一个跨进程锁
 * （例如把互斥交给数据库唯一约束的部署）。
 */
export interface StoragePorts {
  readonly artifacts: ArtifactStore
  readonly checkpoints: CheckpointPort
  readonly tasks: TaskStore
  readonly gateTasks: HumanGateTaskStore
  readonly usage: UsageStore
  readonly audit: AuditEventStore
  readonly knowledge?: KnowledgeStorePort
  readonly cases?: CaseStorePort
  readonly lock?: PipelineLockFactory
}

/**
 * 跨进程互斥锁工厂（`checkpoint-lock.ts` 的 `acquirePipelineLock` 是一个实现）。
 *
 * 工厂**已绑定存储根**（调用方只给 pipelineId）：把根暴露给调用方等于让每个入口
 * 自己拼锁路径——那正是 M2 修掉的"三个入口拼出三条不同路径 = 等于没锁"。
 * 外部后端实现把互斥映射到数据库 advisory lock / `SETNX` 即可，语义不变：
 * 抢不到必须抛 {@link import('../checkpoint-lock.ts').PipelineLockHeldError}，不静默并行。
 */
export type PipelineLockFactory = (pipelineId: string, options?: AcquirePipelineLockOptions) => Promise<PipelineLock>

export interface StorageBackendDescription {
  /** 后端名（`file` / `memory` / `postgres` / `object-store`）。 */
  readonly name: string
  /** 本后端**已实现**的端口名（用于"后端能力可声明、可校验"）。 */
  readonly implementedPorts: readonly string[]
  /** 本后端**未实现**的端口名 + 原因（例如"需要数据库连接，本阶段未部署"）。 */
  readonly unavailablePorts: readonly { readonly port: string; readonly reason: string }[]
  /** 后端是否要求外部基础设施（file/memory 为 false）。 */
  readonly requiresExternalInfrastructure: boolean
}

/**
 * 存储后端：端口 + 版本 + 健康 + 迁移。
 *
 * 宿主只依赖它：`createPlatformHost` 收一个 `StorageBackend`，把 `backend.ports` 分发给
 * driver / 工具 / Web 服务。**换后端 = 换这一处装配**。
 */
export interface StorageBackend {
  readonly name: string
  readonly schemaVersion: number
  readonly ports: StoragePorts
  describe(): StorageBackendDescription
  /**
   * 扫描并报告损坏 / 版本问题。**不抛异常**（单个坏文件不能打断整次体检），
   * 全部问题以 {@link StorageDiagnostic} 返回。
   */
  diagnose(): Promise<StorageHealth>
  /**
   * 把旧版本记录升级到当前 `schemaVersion`。
   *
   * 约定：
   * - **先备份再改**（原文件改名到 `.bak` 或写入 `backups/`），失败不破坏原件；
   * - 逐条报告，`skipped` 必须带上原因（不静默跳过）；
   * - 可重复执行（幂等）：已是当前版本的记录不动。
   */
  migrate?(): Promise<StorageMigrationReport>
}

export interface StorageMigrationReport {
  readonly backend: string
  readonly fromVersion: number
  readonly toVersion: number
  readonly migrated: readonly { readonly ref: string; readonly kind: StorageRecordKind; readonly from: number }[]
  readonly skipped: readonly { readonly ref: string; readonly kind: StorageRecordKind; readonly reason: string }[]
  readonly backupDir: string | null
}

// ── 装配校验 ────────────────────────────────────────────────────────────────────

/**
 * 校验后端确实提供了它 `describe()` 声称实现的端口。
 *
 * 为什么要运行时校验：`StoragePorts` 里可选端口很多，一个后端漏装配某个端口
 * 只会表现为"某个功能莫名其妙不可用"（例如审计永远为空）。启动时炸掉比线上猜好。
 */
export function assertBackendPorts(backend: StorageBackend): void {
  const missing = backend.describe().implementedPorts.filter(port => !hasPort(backend.ports, port))
  if (missing.length > 0) {
    throw new StorageUnavailableError(
      backend.name,
      'assertBackendPorts',
      `后端声称实现但实际缺失的端口：${missing.join(', ')}`,
    )
  }
  for (const port of ['artifacts', 'checkpoints', 'tasks', 'gateTasks', 'usage', 'audit'] as const) {
    if (!hasPort(backend.ports, port)) {
      throw new StorageUnavailableError(backend.name, 'assertBackendPorts', `必需端口缺失：${port}`)
    }
  }
}

function hasPort(ports: StoragePorts, port: string): boolean {
  return (ports as unknown as Record<string, unknown>)[port] !== undefined
}
