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

export class KnowledgeConflictError extends Error {
  readonly conflicts: readonly KnowledgeConflict[]

  constructor(conflicts: readonly KnowledgeConflict[]) {
    super(`knowledge write conflicts with active entries: ${conflicts.map(conflict => conflict.existingId).join(', ')}`)
    this.name = 'KnowledgeConflictError'
    this.conflicts = conflicts
  }
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

interface StoredKnowledge {
  readonly meta: KnowledgeEntry
  readonly body: string
}

const KB_META_PREFIX = '<!-- pp-meta:'

function encodeMeta(entry: KnowledgeEntry): string {
  return `${KB_META_PREFIX} ${JSON.stringify(entry)} -->`
}

function decodeMeta(line: string): KnowledgeEntry | null {
  if (!line.startsWith(KB_META_PREFIX)) return null
  const json = line.slice(KB_META_PREFIX.length).trim().replace(/ -->$/, '')
  try {
    return JSON.parse(json) as KnowledgeEntry
  } catch {
    return null
  }
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
      const firstLine = raw.split('\n', 1)[0] ?? ''
      const meta = decodeMeta(firstLine)
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
      const existing = decodeMeta(raw.split('\n', 1)[0] ?? '')
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
    let previous: KnowledgeEntry | null = null
    try {
      const raw = await readFile(target, 'utf8')
      previous = decodeMeta(raw.split('\n', 1)[0] ?? '')
    } catch {
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
        const old = decodeMeta(raw.split('\n', 1)[0] ?? '')
        if (old !== null && (old.status ?? 'active') === 'active') {
          const superseded = { ...old, status: 'superseded' as const, supersededBy: normalized.id }
          await writeFile(supersededPath, `${encodeMeta(superseded)}\n${superseded.body}\n`)
        }
      } catch {
        // Missing supersedes target is reported by the caller as a conflict-safe no-op.
      }
    }
    const content = `${encodeMeta(normalized)}\n${normalized.body}\n`
    const temp = `${target}.${process.pid}.tmp`
    await writeFile(temp, content)
    await rename(temp, target)
    return normalized.id
  }

  private async listMd(): Promise<string[]> {
    try {
      return (await readdir(this.dir)).filter(f => f.endsWith('.md'))
    } catch {
      return []
    }
  }
}

interface StoredCase {
  readonly caseId: string
  readonly project: string
  readonly versions: readonly VersionedCase[]
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

  /** 版本化回流：同 caseId 同 version 覆盖，不同 version 追加（R6-02 只追加版本记录）。 */
  async archive(caseValue: VersionedCase): Promise<void> {
    await mkdir(this.dir, { recursive: true })
    const path = join(this.dir, `${safeName(caseValue.caseId)}.json`)
    const existing = await this.load(path)
    const versions = existing === null
      ? []
      : existing.versions.filter(v => v.version !== caseValue.version)
    const stored: StoredCase = {
      caseId: caseValue.caseId,
      project: caseValue.project,
      versions: [...versions, caseValue],
    }
    await writeFile(path, JSON.stringify(stored, null, 2))
  }

  private async load(path: string): Promise<StoredCase | null> {
    try {
      const parsed = JSON.parse(await readFile(path, 'utf8')) as StoredCase
      if (parsed.caseId === undefined) return null
      return parsed
    } catch {
      return null
    }
  }

  private async listJson(): Promise<string[]> {
    try {
      return (await readdir(this.dir)).filter(f => f.endsWith('.json'))
    } catch {
      return []
    }
  }
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
