/**
 * markdown-fs 存储适配（docs/02 第 7 节，首批实现）：
 * - KnowledgeStore：知识条目按 <id>.md 存储，JSON 元数据头 + 正文；
 *   读取按 entities/project 过滤、date 降序、limit 裁剪。
 * - CaseStore：用例按 <caseId>.json 存储版本数组；archive 版本化去重（R6-02）。
 * 归档格式 = 检索格式（R6-01）；检索友好性由 R6-05 回读验证。
 * @module platform-pipeline/stores/markdown
 */

import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

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
}

export interface KnowledgeQuery {
  readonly entities: readonly string[]
  readonly project?: string
  readonly limit: number
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
    const files = await this.listMd()
    const entries: StoredKnowledge[] = []
    for (const file of files) {
      const raw = await readFile(join(this.dir, file), 'utf8')
      const firstLine = raw.split('\n', 1)[0] ?? ''
      const meta = decodeMeta(firstLine)
      if (meta === null) continue
      if (query.project !== undefined && meta.project !== query.project) continue
      const hits = query.entities.filter(e => meta.entities.includes(e))
      if (hits.length === 0) continue
      entries.push({ meta, body: raw.split('\n').slice(1).join('\n') })
    }
    entries.sort((a, b) => (a.meta.date < b.meta.date ? 1 : a.meta.date > b.meta.date ? -1 : 0))
    return entries.slice(0, query.limit).map(e => e.meta)
  }

  /** 写入条目；同 id 幂等覆盖（R6-03 归档幂等）。 */
  async write(entry: KnowledgeEntry): Promise<string> {
    await mkdir(this.dir, { recursive: true })
    const target = join(this.dir, `${safeName(entry.id)}.md`)
    const content = `${encodeMeta(entry)}\n${entry.body}\n`
    await writeFile(target, content)
    return entry.id
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
