/**
 * 项目知识文档导入：Markdown 与 CSV/TSV。
 *
 * 导入结果先生成 draft 知识条目，随后由 MarkdownKnowledgeStore 的冲突治理
 * 和人工门决定是否进入 active；用例不在此模块处理，保持知识库/用例库边界清晰。
 */

import { createHash } from 'node:crypto'
import { extname } from 'node:path'
import { readFile } from 'node:fs/promises'
import type { KnowledgeEntry, KnowledgeKind, KnowledgeStatus } from './stores/markdown.ts'
import { MarkdownKnowledgeStore } from './stores/markdown.ts'

export interface KnowledgeImportOptions {
  readonly project: string
  readonly sourcePipeline?: string
  readonly sourceRef?: string
  readonly version?: string
  readonly date?: string
  readonly kind?: KnowledgeKind
  readonly status?: KnowledgeStatus
  readonly tags?: readonly string[]
  readonly entities?: readonly string[]
}

export interface KnowledgeImportResult {
  readonly format: 'markdown' | 'csv' | 'tsv'
  readonly sourceRef: string
  readonly entries: readonly KnowledgeEntry[]
}

export async function importKnowledgeFile(path: string, options: KnowledgeImportOptions): Promise<KnowledgeImportResult> {
  return importKnowledgeText(await readFile(path, 'utf8'), path, options)
}

export async function importKnowledgeText(text: string, sourceName: string, options: KnowledgeImportOptions): Promise<KnowledgeImportResult> {
  const format = detectFormat(sourceName)
  const sourceRef = options.sourceRef ?? sourceName
  const entries = format === 'markdown'
    ? parseMarkdownKnowledge(text, sourceRef, options)
    : parseDelimitedKnowledge(text, format, sourceRef, options)
  return { format, sourceRef, entries }
}

export async function ingestKnowledgeFile(store: MarkdownKnowledgeStore, path: string, options: KnowledgeImportOptions): Promise<KnowledgeImportResult> {
  const result = await importKnowledgeFile(path, options)
  for (const entry of result.entries) await store.write(entry)
  return result
}

export function parseMarkdownKnowledge(text: string, sourceRef: string, options: KnowledgeImportOptions): KnowledgeEntry[] {
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  const headings = lines.map((line, index) => {
    const match = /^(#{1,6})\s+(.+?)\s*$/.exec(line)
    return match === null ? null : { index, level: match[1]!.length, title: match[2]!.replace(/\s+#*$/, '').trim() }
  }).filter((value): value is { index: number; level: number; title: string } => value !== null && value.title !== '')
  const selectedLevel = headings.some(item => item.level >= 2) ? 2 : 1
  const sections = headings.filter(item => item.level === selectedLevel)
  const fallbackTitle = firstNonEmpty(lines.find(line => line.trim() !== '' && !line.trim().startsWith('<!--')), sourceRef)
  if (sections.length === 0) return [makeEntry(fallbackTitle, text.trim(), sourceRef, options, 1)]
  return sections.map((section, index) => {
    const next = sections[index + 1]?.index ?? lines.length
    const body = lines.slice(section.index + 1, next).join('\n').trim()
    return makeEntry(section.title, body, sourceRef, options, index + 1)
  }).filter(entry => entry.body !== '')
}

export function parseDelimitedKnowledge(text: string, format: 'csv' | 'tsv', sourceRef: string, options: KnowledgeImportOptions): KnowledgeEntry[] {
  const delimiter = format === 'tsv' ? '\t' : ','
  const rows = parseDelimited(text.replace(/\r\n?/g, '\n'), delimiter)
  const headers = rows.shift()?.map(value => value.trim()) ?? []
  if (headers.length === 0 || headers.every(value => value === '')) throw new Error(`${format} knowledge document has no header row`)
  return rows.map((row, rowIndex) => {
    const fields = headers.map((header, index) => [header || `column_${index + 1}`, row[index] ?? ''] as const)
    const map = new Map(fields.map(([key, value]) => [key.toLocaleLowerCase('zh-CN').trim(), value.trim()]))
    const title = firstValue(map, ['title', 'name', '标题', '名称', 'key', '键']) || `${sourceRef} row ${rowIndex + 2}`
    const entityText = firstValue(map, ['entity', 'entities', 'service', '服务', '实体'])
    const tagText = firstValue(map, ['tags', 'tag', 'labels', '标签'])
    const body = fields.filter(([key, value]) => value !== '' && !['title', 'name', '标题', '名称', 'key', '键'].includes(key.toLocaleLowerCase('zh-CN').trim()))
      .map(([key, value]) => `${key}: ${value}`).join('\n')
    return makeEntry(title, body || `${title}\n`, sourceRef, {
      ...options,
      entities: unique([...(options.entities ?? []), ...splitList(entityText)]),
      tags: unique([...(options.tags ?? []), ...splitList(tagText)]),
    }, rowIndex + 2)
  }).filter(entry => entry.body.trim() !== '')
}

function makeEntry(title: string, body: string, sourceRef: string, options: KnowledgeImportOptions, ordinal: number): KnowledgeEntry {
  const project = options.project.trim()
  if (project === '') throw new Error('knowledge import project is required')
  const baseId = `${safeSlug(project)}-${safeSlug(title)}`
  const id = ordinal === 1 ? baseId : `${baseId}-${ordinal}`
  return {
    id,
    title,
    date: options.date ?? new Date().toISOString().slice(0, 10),
    project,
    version: options.version ?? 'import-1',
    tags: unique(options.tags ?? []),
    entities: unique(options.entities ?? []),
    body: body.trim(),
    sourcePipeline: options.sourcePipeline ?? `import:${sourceRef}`,
    kind: options.kind ?? 'requirement-fact',
    status: options.status ?? 'draft',
    confidence: 'unverified',
    sourceRefs: [sourceRef],
  }
}

function detectFormat(sourceName: string): 'markdown' | 'csv' | 'tsv' {
  const extension = extname(sourceName).toLocaleLowerCase()
  if (extension === '.csv') return 'csv'
  if (extension === '.tsv') return 'tsv'
  return 'markdown'
}

function parseDelimited(text: string, delimiter: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let quoted = false
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!
    if (char === '"') {
      if (quoted && text[index + 1] === '"') { cell += '"'; index += 1 }
      else quoted = !quoted
    } else if (char === delimiter && !quoted) {
      row.push(cell); cell = ''
    } else if (char === '\n' && !quoted) {
      row.push(cell); cell = ''
      if (row.some(value => value.trim() !== '')) rows.push(row)
      row = []
    } else cell += char
  }
  if (cell !== '' || row.length > 0) {
    row.push(cell)
    if (row.some(value => value.trim() !== '')) rows.push(row)
  }
  if (quoted) throw new Error('knowledge table contains an unterminated quoted field')
  return rows
}

function firstValue(map: ReadonlyMap<string, string>, keys: readonly string[]): string {
  for (const key of keys) {
    const value = map.get(key)
    if (value !== undefined && value !== '') return value
  }
  return ''
}

function firstNonEmpty(value: string | undefined, fallback: string): string {
  return value?.trim() || fallback
}

function splitList(value: string): string[] {
  return value.split(/[,，;；、|]/).map(item => item.trim()).filter(Boolean)
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values.map(value => value.trim()).filter(Boolean))]
}

function safeSlug(value: string): string {
  const normalized = value.toLocaleLowerCase('zh-CN').trim()
  const ascii = normalized.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  if (ascii !== '') return ascii
  return `knowledge-${createHash('sha1').update(value).digest('hex').slice(0, 10)}`
}
