/**
 * 文件后端：审计事件（append-only JSONL）。
 *
 * 与 `usage.ts` 的 `fileUsageStore` 同形但**语义不同**，别合并：
 * - 用量是**计量**（高频、可丢、有独立汇总，写失败被吞掉）；
 * - 审计是**责任链**（低频、必须可查、写失败要让人知道）。
 *
 * 为什么是 append-only JSONL 而不是 JSON 数组：
 * 审计的核心价值是"当时记下的顺序"与"不可篡改"。读改写数组会让并发追加互相覆盖，
 * 也会让"删掉某条"变得和"重写整个文件"一样容易——责任链就没了。
 *
 * @module platform-pipeline/storage/file/audit
 */

import { appendFile, mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import {
  StorageUnavailableError,
  checkAndStripSchemaVersion,
  withSchemaVersion,
  type AuditEvent,
  type AuditEventKind,
  type AuditEventQuery,
  type AuditEventRead,
  type AuditEventStore,
} from '../ports.ts'

/** 审计日志文件名（固定在项目根下）。 */
export const AUDIT_LOG_FILE = 'audit.jsonl'

/** 审计目录约定：`<projectRoot>/audit/`。 */
export function auditDir(projectRoot: string): string {
  return join(projectRoot, 'audit')
}

export function auditLogPath(dir: string): string {
  return join(dir, AUDIT_LOG_FILE)
}

/** 默认读取上限：审计可以很长，默认不把整份读进内存。 */
const DEFAULT_LIMIT = 200

/**
 * 脱敏：把疑似凭据的片段替换掉（docs/10 §2.2 / §9.1「日志、错误、usage、audit、
 * checkpoint 均无 secret」）。
 *
 * 这是**第二道防线**：调用方本来就不该把 Key 传进来。但审计是"事后才发现写错了"
 * 的地方——一旦落盘就无法撤回，所以宁可在这里多拦一次。
 * Web 层的 `redactSecrets` 更宽（还按字段名拦），这里只拦文本里的 token 形态。
 */
const SECRET_TEXT_PATTERN = /\b(?:sk|Bearer)[-_][A-Za-z0-9._-]{8,}/gi

/** 命中即整体丢弃的字段名（宁可少记一个字段，也不要记下凭据）。 */
const SECRET_FIELD_PATTERN = /(api[-_]?key|authorization|bearer|token|secret|password|credential)/i

function scrubText(value: string): string {
  return value.replace(SECRET_TEXT_PATTERN, '[redacted]')
}

function scrubMetadata(value: Readonly<Record<string, unknown>> | undefined): Readonly<Record<string, unknown>> | undefined {
  if (value === undefined) return undefined
  const out: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value)) {
    if (SECRET_FIELD_PATTERN.test(key)) continue
    out[key] = scrubValue(item)
  }
  return out
}

function scrubValue(value: unknown): unknown {
  if (typeof value === 'string') return scrubText(value)
  if (Array.isArray(value)) return value.map(scrubValue)
  if (value !== null && typeof value === 'object') return scrubMetadata(value as Record<string, unknown>)
  return value
}

/** 文件审计存储。 */
export function fileAuditStore(dir: string): AuditEventStore {
  return {
    async append(input): Promise<AuditEvent> {
      const event: AuditEvent = {
        ...input,
        eventId: input.eventId ?? randomUUID(),
        at: input.at ?? Date.now(),
        detail: scrubText(input.detail),
        ...(input.metadata === undefined ? {} : { metadata: scrubMetadata(input.metadata) }),
      }
      const line = JSON.stringify(withSchemaVersion(event as unknown as Record<string, unknown>))
      try {
        await mkdir(dir, { recursive: true })
        // appendFile 走 O_APPEND：并发追加各自成立。读改写会让后写者覆盖先写者。
        await appendFile(auditLogPath(dir), `${line}\n`, 'utf8')
      } catch (error) {
        // 审计写失败**必须上抛**（与用量不同）：它是责任链，静默丢失等于没有审计。
        throw new StorageUnavailableError('file', `append ${AUDIT_LOG_FILE}`, errorMessageOf(error), { cause: error })
      }
      return event
    },

    async read(query: AuditEventQuery = {}): Promise<AuditEventRead> {
      const path = auditLogPath(dir)
      let raw: string
      try {
        raw = await readFile(path, 'utf8')
      } catch (error) {
        // 文件不存在 = 还没有任何审计事件（正常，不是故障）。
        if (isMissingFile(error)) return { events: [], skipped: [] }
        throw new StorageUnavailableError('file', `read ${AUDIT_LOG_FILE}`, errorMessageOf(error), { cause: error })
      }
      const events: AuditEvent[] = []
      const skipped: { line: number; reason: string }[] = []
      const lines = raw.split('\n')
      for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index]!.trim()
        if (line === '') continue
        try {
          const parsed = JSON.parse(line) as unknown
          if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
            throw new Error('审计事件必须是 JSON 对象')
          }
          // 先校验并剥掉存储信封，再校验业务字段（版本更高的行必须被明确拒绝）。
          const body = checkAndStripSchemaVersion(`${AUDIT_LOG_FILE}#L${index + 1}`, 'audit-event', parsed as Record<string, unknown>)
          if (!isAuditEvent(body)) throw new Error('审计事件字段缺失或类型不符')
          if (!matches(body, query)) continue
          events.push(body)
        } catch (error) {
          // 损坏行**显式报告**，不静默跳过：否则"审计缺了几条"与"当时没记"无法区分。
          skipped.push({ line: index + 1, reason: errorMessageOf(error) })
        }
      }
      events.sort((a, b) => a.at - b.at)
      const limit = query.limit ?? DEFAULT_LIMIT
      return { events: events.slice(Math.max(0, events.length - limit)), skipped }
    },
  }
}

function matches(event: AuditEvent, query: AuditEventQuery): boolean {
  if (query.projectId !== undefined && event.projectId !== query.projectId) return false
  if (query.pipelineId !== undefined && event.pipelineId !== query.pipelineId) return false
  if (query.kind !== undefined && event.kind !== query.kind) return false
  if (query.since !== undefined && event.at < query.since) return false
  return true
}

function isAuditEvent(value: unknown): value is AuditEvent {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return typeof record.eventId === 'string' && record.eventId !== ''
    && typeof record.at === 'number' && Number.isFinite(record.at)
    && typeof record.kind === 'string' && (AUDIT_EVENT_KINDS as readonly string[]).includes(record.kind)
    && typeof record.actor === 'string' && record.actor !== ''
    && typeof record.detail === 'string'
}

/**
 * 合法的事件种类白名单。
 *
 * 用它做**读侧**校验（而不是只做类型）：`kind` 是审计的唯一分类维度，
 * 一个拼错的 kind（`gate-decide`）会让事件永远查不出来——那是"记了等于没记"。
 */
export const AUDIT_EVENT_KINDS: readonly AuditEventKind[] = [
  'pipeline-created', 'run-started', 'run-settled', 'stage-advanced', 'gate-opened',
  'gate-decided', 'gate-failed', 'reentry', 'cancelled', 'artifact-written',
  'executor-invoked', 'knowledge-written', 'case-archived', 'lock-event', 'storage-migrated',
]

function errorMessageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && 'code' in error && (error as { code?: string }).code === 'ENOENT'
}
