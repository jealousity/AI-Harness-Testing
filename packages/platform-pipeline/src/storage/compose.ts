/**
 * 后端组合（docs/10 §8.3 M4-B）。
 *
 * 为什么需要它：M4-B 的两类外部后端**各自都不完整**——
 * - PostgreSQL 管不住大对象：产物/证据是 MB 级 blob，塞进 `bytea` 会把库拖垮，
 *   而且它本来就不该承担"文件"这件事；
 * - 对象存储管不住需要 CAS 与事务的状态：检查点、门任务、租约都要求"读改写"原子，
 *   而对象存储通常**没有条件写**——两个进程同时写同一个 key 就是后写覆盖先写。
 *
 * 所以真实部署是 **records（PostgreSQL）+ objects（对象存储）的组合**。而"组合"必须有
 * 唯一的落点，否则每个宿主都会自己拼一套、各拼各的（M2 已经吃过这个亏：三个入口拼出
 * 三条不同的锁路径，等于没锁）。
 *
 * 本模块**只依赖 `StorageBackend` 接口**，因此现在就能用 file / memory 后端验证，
 * 不需要任何外部基础设施——这正是"端口真的可替换"的又一处证据。
 *
 * @module platform-pipeline/storage/compose
 */

import {
  STORAGE_SCHEMA_VERSION,
  StorageUnavailableError,
  assertBackendPorts,
  type StorageBackend,
  type StorageDiagnostic,
  type StorageHealth,
  type StorageMigrationReport,
  type StoragePorts,
} from './ports.ts'

/** 组合里各部分的角色。同一角色只能出现一次。 */
export type StorageBackendRole = 'records' | 'objects'

export interface ComposedStoragePart {
  readonly role: StorageBackendRole
  readonly backend: StorageBackend
}

export interface ComposeStorageOptions {
  /** 组合后端的名字。缺省用各部分的 `name` 以 `+` 连接。 */
  readonly name?: string
  readonly parts: readonly ComposedStoragePart[]
  /**
   * 端口覆盖：给"两部分都不提供、但宿主自己有实现"的端口留出口。
   *
   * 显式覆盖**优先**于部分提供的实现，且此时不再报"端口冲突"——覆盖本身就是
   * 宿主的意图声明（例如宿主自己实现 `lock`，因为它的互斥在别处）。
   */
  readonly overrides?: Partial<StoragePorts>
}

/** 组合后端的迁移报告：在标准报告之上补一份按部分拆开的账。 */
export interface ComposedMigrationReport extends StorageMigrationReport {
  readonly parts: readonly {
    readonly role: StorageBackendRole
    readonly backend: string
    readonly backupDir: string | null
    readonly migrated: number
    readonly skipped: number
  }[]
}

/**
 * 组合后端。
 *
 * `portOrigins` 是 `describe()` 之外的可观测面：`describe()` 只回答"有哪些端口"，
 * 排障时还要回答"这个端口是谁提供的"。把它做成结构化字段而不是日志，
 * 是为了让宿主自检脚本能直接断言（例如"`lock` 必须来自 records 而不是 override"）。
 */
export interface ComposedStorageBackend extends StorageBackend {
  readonly portOrigins: ReadonlyMap<string, string>
  migrate(): Promise<ComposedMigrationReport>
}

/** 端口名清单（顺序即 `describe()` 的输出顺序）。 */
const PORT_NAMES = ['artifacts', 'checkpoints', 'tasks', 'gateTasks', 'usage', 'audit', 'knowledge', 'cases', 'lock'] as const

/**
 * 把若干后端组合成一个。
 *
 * 校验（宁可装配时炸掉，也不要在线上表现为"某个功能莫名其妙不可用"）：
 * 1. 至少一个部分，且每个角色只出现一次；
 * 2. 所有部分的 `schemaVersion` **必须一致**——版本不一致意味着同一个进程里有两套
 *    记录格式，读谁的都会读错一半；
 * 3. 同一个端口不得被两个部分同时提供（除非宿主用 `overrides` 明确表态）；
 * 4. 组合结果必须满足必需端口（§8.2），否则直接失败。
 */
export function composeStorageBackends(options: ComposeStorageOptions): ComposedStorageBackend {
  const name = options.name ?? options.parts.map(part => part.backend.name).join('+')
  if (options.parts.length === 0) {
    throw new StorageUnavailableError(name, 'compose', '至少需要一个后端部分')
  }
  const roles = new Set<StorageBackendRole>()
  for (const part of options.parts) {
    if (roles.has(part.role)) {
      throw new StorageUnavailableError(name, 'compose', `角色 ${part.role} 被提供了两次：组合里每个角色只能有一个后端`)
    }
    roles.add(part.role)
  }

  const versions = new Set(options.parts.map(part => part.backend.schemaVersion))
  if (versions.size > 1) {
    throw new StorageUnavailableError(
      name, 'compose',
      `各部分 schemaVersion 不一致（${options.parts.map(part => `${part.backend.name}=${part.backend.schemaVersion}`).join(', ')}）：`
      + '同一进程里不允许存在两套记录格式，请先各自 migrate',
    )
  }

  const ports: Record<string, unknown> = {}
  const origin = new Map<string, string>()
  for (const port of PORT_NAMES) {
    const providers = options.parts.filter(part => (part.backend.ports as unknown as Record<string, unknown>)[port] !== undefined)
    const override = options.overrides === undefined ? undefined : (options.overrides as unknown as Record<string, unknown>)[port]
    // 冲突只在**宿主没有表态**时才是错误：`overrides` 就是表态，此时优先级已确定，
    // 再报冲突等于让宿主无法表达"我知道两边都有，我要这一个"。
    if (providers.length > 1 && override === undefined) {
      throw new StorageUnavailableError(
        name, 'compose',
        `端口 ${port} 被多个部分同时提供（${providers.map(part => part.role).join(', ')}）：`
        + '组合层不替宿主猜优先级，请用 overrides 明确指定',
      )
    }
    const provided = providers[0]
    if (override !== undefined) {
      ports[port] = override
      origin.set(port, 'override')
    } else if (provided !== undefined) {
      ports[port] = (provided.backend.ports as unknown as Record<string, unknown>)[port]
      origin.set(port, provided.role)
    }
  }

  const implementedPorts = PORT_NAMES.filter(port => ports[port] !== undefined)
  const unavailablePorts: { port: string; reason: string }[] = []
  for (const part of options.parts) {
    for (const item of part.backend.describe().unavailablePorts) {
      if (implementedPorts.includes(item.port as (typeof PORT_NAMES)[number])) continue
      if (unavailablePorts.some(existing => existing.port === item.port)) continue
      unavailablePorts.push({ port: item.port, reason: `${part.role}（${part.backend.name}）：${item.reason}` })
    }
  }

  const backend: ComposedStorageBackend = {
    name,
    schemaVersion: options.parts[0]!.backend.schemaVersion,
    ports: ports as unknown as StoragePorts,
    portOrigins: origin,
    describe: () => ({
      name,
      implementedPorts,
      unavailablePorts,
      requiresExternalInfrastructure: options.parts.some(part => part.backend.describe().requiresExternalInfrastructure),
    }),
    diagnose: async () => diagnoseParts(name, options.parts),
    migrate: async () => migrateParts(name, options.parts),
  }

  // 装配即校验：缺必需端口在这里就炸，而不是等到第一次跑流水线。
  assertBackendPorts(backend)
  return backend
}

async function diagnoseParts(name: string, parts: readonly ComposedStoragePart[]): Promise<StorageHealth> {
  const diagnostics: StorageDiagnostic[] = []
  let ok = true
  for (const part of parts) {
    const health = await part.backend.diagnose()
    if (!health.ok) ok = false
    for (const item of health.diagnostics) {
      // ref 前面加角色名：排障时第一眼要看出"是哪一半坏了"，否则两个部分报同样的
      // 相对路径（`checkpoint.json` 之类）根本分不清。
      diagnostics.push({ ...item, ref: `${part.role}/${item.ref}` })
    }
  }
  return {
    backend: name,
    ok,
    schemaVersion: parts[0]?.backend.schemaVersion ?? STORAGE_SCHEMA_VERSION,
    diagnostics,
  }
}

/**
 * 组合后的迁移：逐部分执行，再合并成一份账。
 *
 * `backupDir` 只在各部分给出**同一个**非空目录时才填写；否则为 `null`，
 * 并附上 `parts` 明细。理由：把两个不同目录硬拼成一个字符串是对备份位置的谎报，
 * 而操作员需要知道的恰恰是"备份到底在哪"。
 *
 * 没有 `migrate()` 的部分按"无事可做"处理（不是跳过，是没有旧版本概念）。
 */
async function migrateParts(name: string, parts: readonly ComposedStoragePart[]): Promise<ComposedMigrationReport> {
  const migrated: { ref: string; kind: StorageMigrationReport['migrated'][number]['kind']; from: number }[] = []
  const skipped: { ref: string; kind: StorageMigrationReport['skipped'][number]['kind']; reason: string }[] = []
  const detail: ComposedMigrationReport['parts'][number][] = []
  const dirs = new Set<string>()
  let fromVersion = STORAGE_SCHEMA_VERSION
  let toVersion = 0

  for (const part of parts) {
    if (part.backend.migrate === undefined) {
      detail.push({ role: part.role, backend: part.backend.name, backupDir: null, migrated: 0, skipped: 0 })
      continue
    }
    const report = await part.backend.migrate()
    for (const item of report.migrated) migrated.push({ ...item, ref: `${part.role}/${item.ref}` })
    for (const item of report.skipped) skipped.push({ ...item, ref: `${part.role}/${item.ref}` })
    if (report.backupDir !== null) dirs.add(report.backupDir)
    fromVersion = Math.min(fromVersion, report.fromVersion)
    toVersion = Math.max(toVersion, report.toVersion)
    detail.push({
      role: part.role,
      backend: part.backend.name,
      backupDir: report.backupDir,
      migrated: report.migrated.length,
      skipped: report.skipped.length,
    })
  }

  return {
    backend: name,
    fromVersion,
    toVersion: toVersion === 0 ? STORAGE_SCHEMA_VERSION : toVersion,
    migrated,
    skipped,
    backupDir: dirs.size === 1 ? [...dirs][0]! : null,
    parts: detail,
  }
}
