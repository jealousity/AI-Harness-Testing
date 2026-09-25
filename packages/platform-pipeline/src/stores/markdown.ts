/**
 * markdown-fs 存储适配（docs/02 第 7 节，首批实现）：
 * - KnowledgeStore：知识条目按 <id>.md 存储，JSON 元数据头 + 正文；
 *   读取按 entities/project 过滤、date 降序、limit 裁剪。
 * - CaseStore：用例按 <caseId>.json 存储版本数组；archive 版本化去重（R6-02）。
 * 归档格式 = 检索格式（R6-01）；检索友好性由 R6-05 回读验证。
 * @module platform-pipeline/stores/markdown
 */

import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { StorageCorruptError, StorageUnavailableError, readSchemaVersion, withSchemaVersion } from '../storage/ports.ts'
import type {
  CaseMeta,
  KnowledgeConfidence,
  KnowledgeConflict,
  KnowledgeEntry,
  KnowledgeHit,
  KnowledgeKind,
  KnowledgeQuery,
  KnowledgeStatus,
  VersionedCase,
} from '../storage/ports.ts'

/**
 * 数据类型与端口的声明在 `storage/ports.ts`（docs/10 §8.2：端口不能被某个具体后端绑架）。
 * 这里再导出，保持既有 `import { type KnowledgeEntry } from '../stores/markdown.ts'` 不变。
 */
export type {
  CaseMeta,
  KnowledgeConfidence,
  KnowledgeConflict,
  KnowledgeEntry,
  KnowledgeHit,
  KnowledgeKind,
  KnowledgeQuery,
  KnowledgeStatus,
  VersionedCase,
}

export class KnowledgeConflictError extends Error {
  readonly conflicts: readonly KnowledgeConflict[]

  constructor(conflicts: readonly KnowledgeConflict[]) {
    super(`knowledge write conflicts with active entries: ${conflicts.map(conflict => conflict.existingId).join(', ')}`)
    this.name = 'KnowledgeConflictError'
    this.conflicts = conflicts
  }
}

interface StoredKnowledge {
  readonly meta: KnowledgeEntry
  readonly body: string
}

const KB_META_PREFIX = '<!-- pp-meta:'

function encodeMeta(entry: KnowledgeEntry): string {
  return `${KB_META_PREFIX} ${JSON.stringify(entry)} -->`
}

/**
 * 解析元数据行。
 *
 * 三种结果必须区分开（docs/10 §8.3 M4-A「损坏文件不能静默当空数据」）：
 * - 没有前缀 → 不是知识文件（正常，`{ kind: 'not-knowledge' }`）；
 * - 有前缀但 JSON 非法 → **损坏**，必须上抛，不能当成"没有这条"；
 * - 解析成功 → 条目。
 *
 * 旧实现把后两种都返回 null，于是"这个文件被写坏了"与"这个文件不是知识条目"
 * 在调用方看来完全一样——知识库会静默少一条，而没人知道。
 */
type MetaDecode =
  | { readonly kind: 'not-knowledge' }
  | { readonly kind: 'corrupt'; readonly reason: string }
  | { readonly kind: 'entry'; readonly entry: KnowledgeEntry }

export type KnowledgeMetaDecode = MetaDecode

/**
 * 解析知识文件的元数据行。**导出**是为了让存储后端的 `diagnose` 复用同一套判定，
 * 而不是在体检里另写一份"像不像损坏"的启发式（两份口径必然漂移）。
 */
export function decodeKnowledgeMeta(line: string): MetaDecode {
  if (!line.startsWith(KB_META_PREFIX)) return { kind: 'not-knowledge' }
  const json = line.slice(KB_META_PREFIX.length).trim().replace(/ -->$/, '')
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch (error) {
    return { kind: 'corrupt', reason: `元数据行不是合法 JSON（${error instanceof Error ? error.message : String(error)}）` }
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { kind: 'corrupt', reason: '元数据行 JSON 不是对象' }
  }
  const entry = parsed as KnowledgeEntry
  if (typeof entry.id !== 'string' || entry.id === '' || typeof entry.project !== 'string') {
    return { kind: 'corrupt', reason: '元数据缺少 id/project 字段' }
  }
  return { kind: 'entry', entry }
}

/** 严格解析：损坏即抛（`ref` 用于诊断，必须是相对路径而不是绝对路径）。 */
function requireMeta(raw: string, ref: string): KnowledgeEntry | null {
  const decoded = decodeKnowledgeMeta(raw.split('\n', 1)[0] ?? '')
  if (decoded.kind === 'corrupt') {
    throw new StorageCorruptError(ref, 'knowledge-entry', decoded.reason)
  }
  return decoded.kind === 'entry' ? decoded.entry : null
}

/** markdown-fs 知识库（docs/02 第 7 节 KnowledgeStore）。 */
export class MarkdownKnowledgeStore {
  private readonly dir: string

  constructor(dir: string) {
    this.dir = dir
  }

  async read(query: KnowledgeQuery): Promise<KnowledgeEntry[]> {
    return (await this.readHits(query)).map(hit => hit.entry)
  }

  async readHits(query: KnowledgeQuery): Promise<KnowledgeHit[]> {
    const files = await this.listMd()
    const hits: KnowledgeHit[] = []
    const entities = (query.entities ?? []).map(normalizeTerm).filter(Boolean)
    const tags = (query.tags ?? []).map(normalizeTerm).filter(Boolean)
    const textTerms = tokenize(query.text ?? '')
    for (const file of files) {
      const raw = await readFile(join(this.dir, file), 'utf8')
      const meta = requireMeta(raw, file)
      if (meta === null) continue
      if (query.project !== undefined && meta.project !== query.project) continue
      if (query.service !== undefined && meta.scope?.services !== undefined && !meta.scope.services.includes(query.service)) continue
      if (query.environment !== undefined && meta.scope?.environments !== undefined && !meta.scope.environments.includes(query.environment)) continue
      const status = meta.status ?? 'active'
      if ((query.status ?? 'active') !== status) continue
      if (!query.includeExpired && meta.validUntil !== undefined && meta.validUntil < new Date().toISOString().slice(0, 10)) continue
      const searchable = [meta.title, ...meta.tags, ...meta.entities, meta.body].map(normalizeTerm).join(' ')
      const matchedEntities = entities.filter(term => searchable.includes(term))
      const matchedTags = tags.filter(term => meta.tags.map(normalizeTerm).some(tag => tag.includes(term)))
      const matchedText = textTerms.filter(term => searchable.includes(term))
      if (entities.length + tags.length + textTerms.length === 0) continue
      if (matchedEntities.length + matchedTags.length + matchedText.length === 0) continue
      const matchedBy: KnowledgeHit['matchedBy'] = [
        ...(matchedEntities.length > 0 ? ['entity' as const] : []),
        ...(matchedTags.length > 0 ? ['tag' as const] : []),
        ...(matchedText.some(term => normalizeTerm(meta.title).includes(term)) ? ['title' as const] : []),
        ...(matchedText.some(term => normalizeTerm(meta.body).includes(term)) ? ['body' as const] : []),
      ]
      const score = matchedEntities.length * 4 + matchedTags.length * 3 + matchedText.length
        + (meta.confidence === 'verified' ? 1 : 0) + (meta.status === 'active' || meta.status === undefined ? 1 : 0)
      hits.push({ entry: meta, score, matchedBy, matchedTerms: [...new Set([...matchedEntities, ...matchedTags, ...matchedText])] })
    }
    hits.sort((a, b) => b.score - a.score || (a.entry.date < b.entry.date ? 1 : -1))
    return hits.slice(0, Math.max(0, query.limit))
  }

  async findConflicts(entry: KnowledgeEntry): Promise<KnowledgeConflict[]> {
    const files = await this.listMd()
    const conflicts: KnowledgeConflict[] = []
    const incomingEntities = new Set(entry.entities.map(normalizeTerm))
    const incomingTags = new Set(entry.tags.map(normalizeTerm))
    const supersedes = new Set(entry.supersedes ?? [])
    for (const file of files) {
      const raw = await readFile(join(this.dir, file), 'utf8')
      const existing = requireMeta(raw, file)
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
  }

  /** 写入条目；冲突必须显式 supersedes，版本变化会保留历史快照。 */
  async write(entry: KnowledgeEntry): Promise<string> {
    await mkdir(this.dir, { recursive: true })
    const target = join(this.dir, `${safeName(entry.id)}.md`)
    const normalized: KnowledgeEntry = {
      ...entry,
      status: entry.status ?? 'active',
      confidence: entry.confidence ?? 'unverified',
      sourceRefs: entry.sourceRefs ?? [],
      supersedes: entry.supersedes ?? [],
    }
    if (normalized.status === 'active') {
      const conflicts = await this.findConflicts(normalized)
      if (conflicts.length > 0) throw new KnowledgeConflictError(conflicts)
    }
    // 读旧版本：只有「文件不存在」才算"没有旧版本"。损坏必须抛——
    // 否则损坏的旧条目会被当成"从没有过"，历史快照静默丢失、正文被覆盖（docs/10 §8.4）。
    let previous: KnowledgeEntry | null = null
    try {
      const raw = await readFile(target, 'utf8')
      previous = requireMeta(raw, `${safeName(entry.id)}.md`)
    } catch (error) {
      if (!isMissingFile(error)) throw error
      previous = null
    }
    if (previous !== null && previous.version !== normalized.version) {
      const historyDir = join(this.dir, '.history')
      await mkdir(historyDir, { recursive: true })
      await writeFile(join(historyDir, `${safeName(previous.id)}@${safeName(previous.version)}.md`), `${encodeMeta(previous)}\n${previous.body}\n`)
    }
    for (const supersededId of normalized.supersedes ?? []) {
      const supersededPath = join(this.dir, `${safeName(supersededId)}.md`)
      try {
        const raw = await readFile(supersededPath, 'utf8')
        const old = requireMeta(raw, `${safeName(supersededId)}.md`)
        if (old !== null && (old.status ?? 'active') === 'active') {
          const superseded = { ...old, status: 'superseded' as const, supersededBy: normalized.id }
          await writeFile(supersededPath, `${encodeMeta(superseded)}\n${superseded.body}\n`)
        }
      } catch (error) {
        // 目标缺失是正常 no-op（调用方按"冲突安全"处理）；损坏则必须上抛。
        if (!isMissingFile(error)) throw error
      }
    }
    const content = `${encodeMeta(normalized)}\n${normalized.body}\n`
    const temp = `${target}.${process.pid}.tmp`
    await writeFile(temp, content)
    await rename(temp, target)
    return normalized.id
  }

  /**
   * 列目录。
   *
   * 只有 `ENOENT`（目录还没建）才算"空知识库"；权限/IO 错误必须上抛成
   * {@link StorageUnavailableError}——把"读不了"当成"没有"是 docs/10 §8.3 明令禁止的
   * 静默当空数据，而且它会让检索结果悄悄变少而无人察觉。
   */
  private async listMd(): Promise<string[]> {
    try {
      return (await readdir(this.dir)).filter(f => f.endsWith('.md'))
    } catch (error) {
      if (isMissingFile(error)) return []
      throw new StorageUnavailableError('file', `readdir ${this.dir}`, error instanceof Error ? error.message : String(error), { cause: error })
    }
  }
}

interface StoredCase {
  readonly caseId: string
  readonly project: string
  readonly versions: readonly VersionedCase[]
  /** 平台自有记录版本（docs/10 §8.3 M4-A）。缺失 = 历史遗留 v1。 */
  readonly schemaVersion?: number
}

/** markdown-fs 用例库（docs/02 第 7 节 CaseStore，版本化回流 R6-02）。 */
export class MarkdownCaseStore {
  private readonly dir: string

  constructor(dir: string) {
    this.dir = dir
  }

  async query(filter: { readonly project: string; readonly requirement?: string; readonly version?: string }): Promise<CaseMeta[]> {
    const files = await this.listJson()
    const metas: CaseMeta[] = []
    for (const file of files) {
      const stored = await this.load(join(this.dir, file))
      if (stored === null || stored.project !== filter.project) continue
      const latest = [...stored.versions].sort((a, b) => (a.version < b.version ? 1 : a.version > b.version ? -1 : 0))[0]
      if (latest === undefined) continue
      if (filter.version !== undefined && latest.version !== filter.version) continue
      if (filter.requirement !== undefined && latest.sourceRequirement !== filter.requirement) continue
      metas.push({
        caseId: stored.caseId,
        title: titleOf(latest.content),
        version: latest.version,
        project: stored.project,
        ...latest.sourceRequirement === '' ? {} : { sourceRequirement: latest.sourceRequirement },
      })
    }
    return metas
  }

  /**
   * 版本化回流：同 caseId 同 version 覆盖，不同 version 追加（R6-02 只追加版本记录）。
   *
   * 原子写（tmp → rename）：直接 `writeFile` 会在写一半时被读到半个 JSON，
   * 而**下一个** `load` 又会把那个半截文件判成损坏——自己制造的损坏。
   */
  async archive(caseValue: VersionedCase): Promise<void> {
    await mkdir(this.dir, { recursive: true })
    const path = join(this.dir, `${safeName(caseValue.caseId)}.json`)
    const existing = await this.load(path)
    const versions = existing === null
      ? []
      : existing.versions.filter(v => v.version !== caseValue.version)
    const stored: StoredCase = withSchemaVersion({
      caseId: caseValue.caseId,
      project: caseValue.project,
      versions: [...versions, caseValue],
    })
    const temp = `${path}.${process.pid}.tmp`
    await writeFile(temp, JSON.stringify(stored, null, 2))
    await rename(temp, path)
  }

  /**
   * 读一条用例记录。
   *
   * 只有「文件不存在」返回 null。**损坏必须抛**：旧实现在 catch 里一律返回 null，
   * 于是 `archive` 会把损坏记录当成"没有历史版本"，直接覆盖——静默丢数据。
   * 这正是 docs/10 §8.3「损坏文件不能静默当空数据」与 §8.4「不覆盖旧数据」要禁的行为。
   */
  private async load(path: string): Promise<StoredCase | null> {
    const ref = path.slice(path.lastIndexOf('/') + 1)
    let raw: string
    try {
      raw = await readFile(path, 'utf8')
    } catch (error) {
      if (isMissingFile(error)) return null
      throw new StorageUnavailableError('file', `read ${ref}`, error instanceof Error ? error.message : String(error), { cause: error })
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch (error) {
      throw new StorageCorruptError(ref, 'case-record', `不是合法 JSON（${error instanceof Error ? error.message : String(error)}）`)
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new StorageCorruptError(ref, 'case-record', '顶层不是对象')
    }
    const version = readSchemaVersion(parsed)
    if (version === 'invalid') throw new StorageCorruptError(ref, 'case-record', 'schemaVersion 不是非负整数')
    const record = parsed as StoredCase
    if (typeof record.caseId !== 'string' || record.caseId === '' || !Array.isArray(record.versions)) {
      throw new StorageCorruptError(ref, 'case-record', '缺少 caseId 或 versions 不是数组')
    }
    return record
  }

  /** 同 `MarkdownKnowledgeStore.listMd`：只有 `ENOENT` 才算空。 */
  private async listJson(): Promise<string[]> {
    try {
      return (await readdir(this.dir)).filter(f => f.endsWith('.json'))
    } catch (error) {
      if (isMissingFile(error)) return []
      throw new StorageUnavailableError('file', `readdir ${this.dir}`, error instanceof Error ? error.message : String(error), { cause: error })
    }
  }
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && 'code' in error && (error as { code?: string }).code === 'ENOENT'
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
  if (content !== null && typeof content === 'object') {
    const title = (content as Record<string, unknown>).title
    if (typeof title === 'string' && title !== '') return title
  }
  return '(未命名用例)'
}

function safeName(id: string): string {
  const cleaned = id.replace(/[^A-Za-z0-9._-]/g, '_')
  return cleaned === '' ? 'unnamed' : cleaned
}
