/**
 * 文件后端（docs/10 §8.3 M4-A）：把现有的 fs 实现装配成一个 `StorageBackend`。
 *
 * 这一层**不重写**任何存储逻辑——`FsArtifactStore`、`FsCheckpointPort`、
 * `FileTaskStore`、`FileHumanGateTaskStore`、`MarkdownKnowledgeStore`、
 * `MarkdownCaseStore`、`fileUsageStore` 都是既有实现，这里只做：
 * 1. **装配**：按项目根推导目录，组装成 {@link StoragePorts}；
 * 2. **体检**（`diagnose`）：扫描损坏 / 版本问题，**显式报告**，绝不静默当空数据；
 * 3. **迁移**（`migrate`）：把缺 `schemaVersion` 的历史记录补上，改前先备份。
 *
 * 目录布局（与 `runtime/platform-host.ts` 的既有约定一致，不要另立一套）：
 * ```text
 * <projectRoot>/
 *   checkpoints/<pipelineId>/checkpoint.json
 *   checkpoints/<pipelineId>/.pipeline.lock/
 *   artifacts/<pipelineId>/<stageId>.json
 *   tasks/<taskId>.json
 *   gates/<gateTaskId>.json
 *   usage/<pipelineId>.jsonl
 *   audit/audit.jsonl
 * ```
 *
 * @module platform-pipeline/storage/file
 */

import { copyFile, mkdir, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import type { Dirent } from 'node:fs'
import { FsArtifactStore, FsCheckpointPort } from '../../stores/fs.ts'
import { MarkdownCaseStore, MarkdownKnowledgeStore, decodeKnowledgeMeta } from '../../stores/markdown.ts'
import { FileHumanGateTaskStore, FileTaskStore } from '../../runtime/persistence.ts'
import { fileUsageStore } from '../../usage.ts'
import { acquirePipelineLock, fileLockAudit, lockAuditPath } from '../../checkpoint-lock.ts'
import { auditDir as defaultAuditDir, fileAuditStore } from './audit.ts'
import {
  STORAGE_SCHEMA_VERSION,
  readSchemaVersion,
  withSchemaVersion,
  type StorageBackend,
  type StorageBackendDescription,
  type StorageDiagnostic,
  type StorageHealth,
  type StorageMigrationReport,
  type StoragePorts,
  type StorageRecordKind,
} from '../ports.ts'

export { AUDIT_LOG_FILE, auditDir, auditLogPath, fileAuditStore } from './audit.ts'

export interface FileStorageOptions {
  readonly projectRoot: string
  /** 产物基址（`artifactPath` 已含 `artifacts/<pipelineId>/` 前缀）。缺省 = `projectRoot`。 */
  readonly artifactsRoot?: string
  /** 检查点根。缺省 = `<projectRoot>/checkpoints`。 */
  readonly checkpointRoot?: string
  /** 通用任务目录。缺省 = `<projectRoot>/tasks`。 */
  readonly tasksDir?: string
  /** 人工门任务目录。缺省 = `<projectRoot>/gates`。 */
  readonly gateTasksDir?: string
  /** 用量日志目录。缺省 = `<projectRoot>/usage`。 */
  readonly usageDir?: string
  /** 审计日志目录。缺省 = `<projectRoot>/audit`。 */
  readonly auditDir?: string
  /** 知识库根（配置未声明时缺省不装配）。 */
  readonly knowledgeRoot?: string
  /** 用例库根（配置未声明时缺省不装配）。 */
  readonly casesRoot?: string
  /** 迁移备份目录（相对项目根）。缺省 `backups`。 */
  readonly backupDir?: string
}

interface ResolvedDirs {
  readonly projectRoot: string
  readonly artifactsRoot: string
  readonly checkpointRoot: string
  readonly tasksDir: string
  readonly gateTasksDir: string
  readonly usageDir: string
  readonly auditDir: string
  readonly backupDir: string
  readonly knowledgeRoot?: string
  readonly casesRoot?: string
}

function resolveDirs(options: FileStorageOptions): ResolvedDirs {
  const projectRoot = resolve(options.projectRoot)
  return {
    projectRoot,
    artifactsRoot: resolve(options.artifactsRoot ?? projectRoot),
    checkpointRoot: resolve(options.checkpointRoot ?? join(projectRoot, 'checkpoints')),
    tasksDir: resolve(options.tasksDir ?? join(projectRoot, 'tasks')),
    gateTasksDir: resolve(options.gateTasksDir ?? join(projectRoot, 'gates')),
    usageDir: resolve(options.usageDir ?? join(projectRoot, 'usage')),
    auditDir: resolve(options.auditDir ?? defaultAuditDir(projectRoot)),
    backupDir: resolve(projectRoot, options.backupDir ?? 'backups'),
    ...(options.knowledgeRoot === undefined ? {} : { knowledgeRoot: resolve(options.knowledgeRoot) }),
    ...(options.casesRoot === undefined ? {} : { casesRoot: resolve(options.casesRoot) }),
  }
}

/** 装配文件后端。 */
export function createFileStorageBackend(options: FileStorageOptions): StorageBackend {
  const dirs = resolveDirs(options)

  const ports: StoragePorts = {
    artifacts: new FsArtifactStore(dirs.artifactsRoot),
    checkpoints: new FsCheckpointPort(),
    tasks: new FileTaskStore(dirs.tasksDir),
    gateTasks: new FileHumanGateTaskStore(dirs.gateTasksDir),
    usage: fileUsageStore(dirs.usageDir),
    audit: fileAuditStore(dirs.auditDir),
    ...(dirs.knowledgeRoot === undefined ? {} : { knowledge: new MarkdownKnowledgeStore(dirs.knowledgeRoot) }),
    ...(dirs.casesRoot === undefined ? {} : { cases: new MarkdownCaseStore(dirs.casesRoot) }),
    lock: (pipelineId, lockOptions = {}) => acquirePipelineLock(dirs.checkpointRoot, pipelineId, {
      ...lockOptions,
      // 审计默认落在 checkpoints 根下（与 M2 的既有路径一致，不另立一份）。
      audit: lockOptions.audit ?? fileLockAudit(lockAuditPath(dirs.checkpointRoot)),
    }),
  }

  return {
    name: 'file',
    schemaVersion: STORAGE_SCHEMA_VERSION,
    ports,
    describe: (): StorageBackendDescription => ({
      name: 'file',
      implementedPorts: [
        'artifacts', 'checkpoints', 'tasks', 'gateTasks', 'usage', 'audit', 'lock',
        ...(dirs.knowledgeRoot === undefined ? [] : ['knowledge']),
        ...(dirs.casesRoot === undefined ? [] : ['cases']),
      ],
      unavailablePorts: [
        ...(dirs.knowledgeRoot === undefined
          ? [{ port: 'knowledge', reason: '配置未声明 stores.knowledge 路径' }]
          : []),
        ...(dirs.casesRoot === undefined
          ? [{ port: 'cases', reason: '配置未声明 stores.cases 路径' }]
          : []),
      ],
      requiresExternalInfrastructure: false,
    }),
    diagnose: () => diagnose(dirs),
    migrate: () => migrate(dirs),
  }
}

// ── 体检 ────────────────────────────────────────────────────────────────────────

interface ScanTarget {
  readonly dir: string
  readonly kind: StorageRecordKind
  readonly match: (file: string) => boolean
  readonly depth: number
  /** 形状校验；返回 null 表示通过，返回字符串表示失败原因。 */
  readonly validate: (parsed: unknown) => string | null
  /** 是否参与 schema 版本检查与迁移（agent 自产内容不参与）。 */
  readonly versioned: boolean
}

async function diagnose(dirs: ResolvedDirs): Promise<StorageHealth> {
  const diagnostics: StorageDiagnostic[] = []

  // 项目根不可读 = 基础设施问题，先报出来（此时后面的扫描都会失败，不要重复刷屏）。
  const rootProblem = await probeDirectory(dirs.projectRoot)
  if (rootProblem !== null) {
    diagnostics.push({
      code: 'unreadable', kind: 'checkpoint', ref: '.',
      detail: `项目根不可读：${rootProblem}`, recoverable: false,
    })
    return { backend: 'file', ok: false, schemaVersion: STORAGE_SCHEMA_VERSION, diagnostics }
  }

  for (const target of scanTargets(dirs)) {
    diagnostics.push(...await scanOne(target, dirs.projectRoot))
  }
  return {
    backend: 'file',
    ok: diagnostics.length === 0,
    schemaVersion: STORAGE_SCHEMA_VERSION,
    diagnostics,
  }
}

function scanTargets(dirs: ResolvedDirs): ScanTarget[] {
  const targets: ScanTarget[] = [
    {
      dir: dirs.checkpointRoot, kind: 'checkpoint', depth: 2, versioned: true,
      match: file => file === 'checkpoint.json',
      validate: validateCheckpoint,
    },
    {
      // 只扫 `<artifactsRoot>/artifacts/**`，**不能**从 artifactsRoot 本身递归：
      // 它的缺省值就是项目根，从根递归会把 checkpoints/tasks/gates 下的 JSON 也当成
      // 产物扫一遍，于是同一份文件被报两次（一次 checkpoint、一次 artifact）。
      dir: join(dirs.artifactsRoot, 'artifacts'), kind: 'artifact', depth: 2, versioned: false,
      match: file => file.endsWith('.json'),
      // 产物允许是"裸 content"（阶段 agent 首次写入的形态），因此只校验 JSON 可解析。
      validate: () => null,
    },
    {
      dir: dirs.tasksDir, kind: 'task', depth: 1, versioned: true,
      match: file => file.endsWith('.json'),
      validate: validateTask,
    },
    {
      dir: dirs.gateTasksDir, kind: 'gate-task', depth: 1, versioned: true,
      match: file => file.endsWith('.json'),
      validate: validateGateTask,
    },
  ]
  if (dirs.casesRoot !== undefined) {
    targets.push({
      dir: dirs.casesRoot, kind: 'case-record', depth: 1, versioned: true,
      match: file => file.endsWith('.json'),
      validate: validateCaseRecord,
    })
  }
  if (dirs.knowledgeRoot !== undefined) {
    targets.push({
      dir: dirs.knowledgeRoot, kind: 'knowledge-entry', depth: 1, versioned: false,
      match: file => file.endsWith('.md'),
      // 知识条目自带领域 `version`，元数据行就是条目本身，不参与存储信封版本。
      validate: raw => (typeof raw === 'string' ? validateKnowledge(raw) : null),
    })
  }
  return targets
}

async function scanOne(target: ScanTarget, projectRoot: string): Promise<StorageDiagnostic[]> {
  const out: StorageDiagnostic[] = []
  const files = await listFiles(target.dir, target.match, target.depth)
  for (const file of files) {
    const ref = relative(projectRoot, file) || file
    let raw: string
    try {
      raw = await readFile(file, 'utf8')
    } catch (error) {
      out.push({ code: 'unreadable', kind: target.kind, ref, detail: errorMessageOf(error), recoverable: false })
      continue
    }
    if (target.kind === 'knowledge-entry') {
      const problem = target.validate(raw)
      if (problem !== null) out.push({ code: 'corrupt-json', kind: target.kind, ref, detail: problem, recoverable: false })
      continue
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch (error) {
      out.push({
        code: 'corrupt-json', kind: target.kind, ref,
        detail: `不是合法 JSON（${errorMessageOf(error)}）`, recoverable: false,
      })
      continue
    }
    const shapeProblem = target.validate(parsed)
    if (shapeProblem !== null) {
      out.push({ code: 'schema-invalid', kind: target.kind, ref, detail: shapeProblem, recoverable: false })
      continue
    }
    if (!target.versioned) continue
    const version = readSchemaVersion(parsed)
    if (version === 'invalid') {
      out.push({
        code: 'schema-invalid', kind: target.kind, ref,
        detail: 'schemaVersion 不是非负整数', recoverable: false,
      })
      continue
    }
    if (version === null) {
      out.push({
        code: 'migration-needed', kind: target.kind, ref,
        detail: `缺少 schemaVersion（按历史遗留 v1 处理），可迁移到 v${STORAGE_SCHEMA_VERSION}`, recoverable: true,
      })
      continue
    }
    if (version > STORAGE_SCHEMA_VERSION) {
      out.push({
        code: 'unsupported-version', kind: target.kind, ref,
        detail: `schemaVersion=${version} 高于本进程支持的 ${STORAGE_SCHEMA_VERSION}：请升级进程，不要降级解析`,
        recoverable: false,
      })
    }
  }
  return out
}

// ── 迁移 ────────────────────────────────────────────────────────────────────────

/**
 * 把缺 `schemaVersion` 的历史记录补上当前版本。
 *
 * 三条硬约束：
 * 1. **先备份**：原文件按相对路径复制到 `backups/migration-<ts>/`，备份失败即中止该条；
 * 2. **可重复执行**：已有当前版本的记录不动（幂等）；
 * 3. **逐条报告**：跳过的必须带原因——静默跳过会让"迁移完成了"变成一句空话。
 *
 * 不迁移的东西（有意）：
 * - **产物**：可能是阶段 agent 写的裸 content，改写它等于篡改 agent 输出；
 * - **知识条目**：元数据行就是领域条目本身，自带 `version`；
 * - **JSONL 日志**（usage / audit）：append-only，历史行缺少版本字段是合法形态
 *   （读侧按 v1 处理并把版本更高的行记进 `skipped`），改写历史日志会破坏"不可篡改"。
 */
async function migrate(dirs: ResolvedDirs): Promise<StorageMigrationReport> {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const backupDir = join(dirs.backupDir, `migration-${stamp}`)
  const migrated: { ref: string; kind: StorageRecordKind; from: number }[] = []
  const skipped: { ref: string; kind: StorageRecordKind; reason: string }[] = []
  let wroteBackup = false

  for (const target of scanTargets(dirs)) {
    if (!target.versioned) continue
    const files = await listFiles(target.dir, target.match, target.depth)
    for (const file of files) {
      const ref = relative(dirs.projectRoot, file) || file
      let raw: string
      try {
        raw = await readFile(file, 'utf8')
      } catch (error) {
        skipped.push({ ref, kind: target.kind, reason: `读取失败：${errorMessageOf(error)}` })
        continue
      }
      let parsed: unknown
      try {
        parsed = JSON.parse(raw)
      } catch (error) {
        skipped.push({ ref, kind: target.kind, reason: `损坏（不是合法 JSON）：${errorMessageOf(error)}` })
        continue
      }
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        skipped.push({ ref, kind: target.kind, reason: '顶层不是 JSON 对象' })
        continue
      }
      const shapeProblem = target.validate(parsed)
      if (shapeProblem !== null) {
        skipped.push({ ref, kind: target.kind, reason: `形状不符：${shapeProblem}` })
        continue
      }
      const version = readSchemaVersion(parsed)
      if (version === 'invalid') {
        skipped.push({ ref, kind: target.kind, reason: 'schemaVersion 不是非负整数' })
        continue
      }
      if (version === STORAGE_SCHEMA_VERSION) continue // 幂等：已是最新，不动
      if (version !== null && version > STORAGE_SCHEMA_VERSION) {
        skipped.push({
          ref, kind: target.kind,
          reason: `schemaVersion=${version} 高于本进程支持的 ${STORAGE_SCHEMA_VERSION}，需升级进程`,
        })
        continue
      }
      const backupPath = join(backupDir, ref)
      try {
        await mkdir(dirname(backupPath), { recursive: true })
        await copyFile(file, backupPath)
        wroteBackup = true
      } catch (error) {
        skipped.push({ ref, kind: target.kind, reason: `备份失败，未改动原件：${errorMessageOf(error)}` })
        continue
      }
      try {
        const next = withSchemaVersion(parsed as Record<string, unknown>)
        const temp = `${file}.migrate.${process.pid}.tmp`
        await writeFile(temp, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
        await rename(temp, file)
      } catch (error) {
        skipped.push({ ref, kind: target.kind, reason: `写入失败（原件已备份，未损坏）：${errorMessageOf(error)}` })
        continue
      }
      migrated.push({ ref, kind: target.kind, from: version ?? 1 })
    }
  }

  return {
    backend: 'file',
    fromVersion: 1,
    toVersion: STORAGE_SCHEMA_VERSION,
    migrated,
    skipped,
    backupDir: wroteBackup ? relative(dirs.projectRoot, backupDir) : null,
  }
}

// ── 形状校验 ────────────────────────────────────────────────────────────────────

function validateCheckpoint(parsed: unknown): string | null {
  const record = asRecord(parsed)
  if (record === null) return '顶层不是对象'
  if (typeof record.pipelineId !== 'string' || record.pipelineId === '') return '缺少 pipelineId'
  if (typeof record.cursor !== 'number') return '缺少 cursor'
  if (asRecord(record.stageStates) === null) return 'stageStates 不是对象'
  return null
}

function validateTask(parsed: unknown): string | null {
  const record = asRecord(parsed)
  if (record === null) return '顶层不是对象'
  if (typeof record.taskId !== 'string' || record.taskId === '') return '缺少 taskId'
  if (typeof record.pipelineId !== 'string') return '缺少 pipelineId'
  if (typeof record.status !== 'string') return '缺少 status'
  return null
}

function validateGateTask(parsed: unknown): string | null {
  const record = asRecord(parsed)
  if (record === null) return '顶层不是对象'
  if (typeof record.gateTaskId !== 'string' || record.gateTaskId === '') return '缺少 gateTaskId'
  if (typeof record.pipelineId !== 'string') return '缺少 pipelineId'
  if (typeof record.stageId !== 'string') return '缺少 stageId'
  if (typeof record.status !== 'string') return '缺少 status'
  return null
}

function validateCaseRecord(parsed: unknown): string | null {
  const record = asRecord(parsed)
  if (record === null) return '顶层不是对象'
  if (typeof record.caseId !== 'string' || record.caseId === '') return '缺少 caseId'
  if (!Array.isArray(record.versions)) return 'versions 不是数组'
  return null
}

function validateKnowledge(raw: string): string | null {
  const decoded = decodeKnowledgeMeta(raw.split('\n', 1)[0] ?? '')
  return decoded.kind === 'corrupt' ? `知识元数据损坏：${decoded.reason}` : null
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

// ── 目录扫描 ────────────────────────────────────────────────────────────────────

/** 递归列文件；目录不存在返回空（不是错误），其它 IO 错误上抛。 */
async function listFiles(dir: string, match: (file: string) => boolean, depth: number): Promise<string[]> {
  if (depth < 1) return []
  let entries: Dirent[]
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch (error) {
    if (isMissingFile(error)) return []
    throw error
  }
  const out: string[] = []
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      out.push(...await listFiles(full, match, depth - 1))
      continue
    }
    if (entry.isFile() && match(entry.name)) out.push(full)
  }
  return out.sort()
}

/**
 * 目录是否可用；返回 null 表示可用。
 *
 * **目录不存在算可用**：项目根是首次运行时才创建的（`mkdir -p` 由各写入路径负责），
 * 把它报成 `unreadable` 会让每个全新项目一上来就"体检不通过"。
 */
async function probeDirectory(dir: string): Promise<string | null> {
  try {
    const info = await stat(dir)
    if (!info.isDirectory()) return `${dir} 不是目录`
    return null
  } catch (error) {
    if (isMissingFile(error)) return null
    return errorMessageOf(error)
  }
}

function errorMessageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && 'code' in error && (error as { code?: string }).code === 'ENOENT'
}

/** 供测试与调用方复用的形状校验（避免两处口径漂移）。 */
export const FILE_STORAGE_VALIDATORS = {
  checkpoint: validateCheckpoint,
  task: validateTask,
  gateTask: validateGateTask,
  caseRecord: validateCaseRecord,
} as const
