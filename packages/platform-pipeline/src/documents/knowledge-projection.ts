/**
 * `ParsedDocument` → draft 知识条目（docs/10 §5.6.3、§5.6.7）。
 *
 * 投影是**纯规则**的，不调用模型：
 * docs/10 §5.6.7 明令「不允许模型凭空补齐文档没有的业务事实」，因此这里
 * 只做结构搬运（章节正文、表格行字段），正文一律取自文档原文，不生成任何
 * 文档中不存在的表述。需要语义抽取时由上层 Agent 在拿到 `ParsedDocument`
 * 之后自行完成，且仍要走下面的 draft → 机器校验 → 人工门链路。
 *
 * 三条硬约束：
 * 1. **只出 draft**：`status` 恒为 `'draft'`，`confidence` 恒不为 `'verified'`/`'reviewed'`。
 *    active 写入仍由机器校验 + 人工门 + 冲突治理决定（§5.6.7）。
 * 2. **失败不产出**：`unsupported` / `parse-failed` / `limit-exceeded` 的文档不生成任何条目——
 *    宁可没有知识，也不要基于半截解析结果建库。
 * 3. **可追溯 + 幂等**：每条条目的 `sourceRefs` 指向页码 / sheet-range / heading / 表格行；
 *    `id` 由 `sha256 + sourceRef` 决定，因此**同一份文档重复导入得到同一批 id**，
 *    而内容变更会得到新 id（绝不按文件名覆盖，§5.6.7 最后一条）。
 *
 * @module platform-pipeline/documents/knowledge-projection
 */

import { createHash } from 'node:crypto'

import type {
  KnowledgeConfidence,
  KnowledgeEntry,
  KnowledgeKind,
} from '../stores/markdown.ts'
import type { ParsedDocument, ParsedTable } from './document-types.ts'

/** 表格即内容的格式：投影只出行级条目，避免章节条目与行条目重复。 */
const TABLE_ONLY_FORMATS: readonly ParsedDocument['format'][] = ['csv', 'tsv', 'xlsx', 'xls']

/** 单次投影的条目上限（防止超大文档把知识库写爆）。 */
const DEFAULT_MAX_ENTRIES = 500

export interface KnowledgeProjectionOptions {
  readonly project: string
  readonly sourcePipeline?: string
  readonly date?: string
  readonly version?: string
  readonly kind?: KnowledgeKind
  readonly tags?: readonly string[]
  readonly entities?: readonly string[]
  /**
   * 本次导入显式替代的条目 id。
   *
   * **默认不 supersede**：文档更新后旧条目保持原样、新版本生成新 id，由人工门
   * 决定是否替代。docs/10 §5.6.7 要求「旧条目是否 supersede 必须有明确策略，
   * 不能按文件名覆盖」——把决定权交给调用方显式声明，就是那个策略。
   */
  readonly supersedes?: readonly string[]
  readonly maxEntries?: number
}

export interface KnowledgeProjectionResult {
  /** 源文档内容标识；调用方据此判断"同一份文档"与"内容已变更"。 */
  readonly documentSha256: string
  readonly status: ParsedDocument['status']
  /** 本次投影使用的整体置信度（所有条目共享）。 */
  readonly confidence: KnowledgeConfidence
  readonly entries: readonly KnowledgeEntry[]
  readonly warnings: readonly string[]
}

/**
 * 把解析结果投影为 draft 知识条目。
 *
 * 粒度规则（`TABLE_ONLY_FORMATS` 与其余格式分开）：
 * - CSV/TSV/XLSX/XLS：**只出行级条目**——这类文档里每行就是一个事实，再额外产出
 *   一个"整表章节"条目只会重复；
 * - Markdown/Word/PDF/TXT/YAML/JSON：**章节条目 + 表格行条目**——表格在叙述型文档里
 *   通常补充正文，两种粒度都是独立知识单元。
 */
export function projectKnowledge(doc: ParsedDocument, options: KnowledgeProjectionOptions): KnowledgeProjectionResult {
  const project = options.project.trim()
  if (project === '') throw new Error('knowledge projection requires a non-empty project')

  const confidence = confidenceFor(doc)
  const warnings: string[] = []

  if (doc.status === 'unsupported' || doc.status === 'parse-failed' || doc.status === 'limit-exceeded') {
    warnings.push(
      `文档状态为 ${doc.status}，不生成知识条目：${doc.diagnostics.map(item => item.code).join(', ') || '无诊断信息'}`,
    )
    return { documentSha256: doc.sha256, status: doc.status, confidence, entries: [], warnings }
  }
  if (doc.status === 'partial') {
    warnings.push('文档只被部分解析（partial）；条目已标记低置信度，人工门必须复核截断范围外的内容是否缺失。')
  }
  if (confidence === 'inferred') {
    warnings.push(`解析置信度为 ${doc.confidence}（OCR / 布局推断），条目只能作为线索，不得当作原文事实。`)
  }

  const declaredEntities = unique([...(options.entities ?? []), ...splitMetadataList(doc.metadata.entities)])
  const declaredTags = unique([...(options.tags ?? []), ...splitMetadataList(doc.metadata.tags)])
  const tableOnly = TABLE_ONLY_FORMATS.includes(doc.format)
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES

  const entries: KnowledgeEntry[] = []
  const push = (entry: KnowledgeEntry): void => {
    if (entries.length >= maxEntries) return
    entries.push(entry)
  }

  if (!tableOnly) {
    for (const section of doc.sections) {
      if (section.text.trim() === '') continue
      push(buildEntry({
        project,
        title: section.title ?? doc.fileName,
        body: section.text,
        sourceRefs: [section.sourceRef],
        doc,
        options,
        confidence,
        entities: declaredEntities,
        tags: declaredTags,
      }))
    }
  }

  for (const table of doc.tables) {
    for (let index = 0; index < table.rows.length; index += 1) {
      const row = table.rows[index]!
      if (row.every(cell => cell.trim() === '')) continue
      const ref = table.rowRefs?.[index] ?? `${table.sourceRef},row=${index + 1}`
      push(buildEntry({
        project,
        title: rowTitle(table, row, index),
        body: renderRowBody(table.headers, row),
        sourceRefs: [ref],
        doc,
        options,
        confidence,
        entities: declaredEntities,
        tags: declaredTags,
      }))
    }
  }

  if (entries.length >= maxEntries && countCandidates(doc, tableOnly) > maxEntries) {
    warnings.push(`候选条目超过上限 ${maxEntries}，只保留前 ${maxEntries} 条；请拆分文档后重新导入。`)
  }

  return { documentSha256: doc.sha256, status: doc.status, confidence, entries, warnings }
}

function countCandidates(doc: ParsedDocument, tableOnly: boolean): number {
  const sectionCount = tableOnly ? 0 : doc.sections.filter(section => section.text.trim() !== '').length
  const rowCount = doc.tables.reduce((sum, table) => sum + table.rows.length, 0)
  return sectionCount + rowCount
}

/**
 * 解析置信度 → 知识置信度。
 *
 * **恒不为 `verified` / `reviewed`**：投影产物一律是 draft，人工门之前不存在
 * "已验证"的知识（docs/10 §5.6.7「OCR/布局推断结果默认低置信度，不能直接生成 verified」）。
 */
function confidenceFor(doc: ParsedDocument): KnowledgeConfidence {
  if (doc.confidence === 'ocr-derived' || doc.confidence === 'layout-approximate') return 'inferred'
  return 'unverified'
}

interface BuildEntryInput {
  readonly project: string
  readonly title: string
  readonly body: string
  readonly sourceRefs: readonly string[]
  readonly doc: ParsedDocument
  readonly options: KnowledgeProjectionOptions
  readonly confidence: KnowledgeConfidence
  readonly entities: readonly string[]
  readonly tags: readonly string[]
}

function buildEntry(input: BuildEntryInput): KnowledgeEntry {
  const title = input.title.trim() === '' ? input.doc.fileName : input.title.trim()
  const sourceRefs = unique(input.sourceRefs)
  // 幂等键：同一份文档（sha256）的同一个位置（sourceRef）永远得到同一个 id。
  const identity = createHash('sha1').update(`${input.doc.sha256}|${sourceRefs.join(',')}`).digest('hex').slice(0, 12)
  return {
    id: `${safeSlug(input.project)}-${safeSlug(title)}-${identity}`,
    title,
    date: input.options.date ?? new Date().toISOString().slice(0, 10),
    project: input.project,
    version: input.options.version ?? `doc-${input.doc.sha256.slice(0, 12)}`,
    tags: unique(input.tags),
    entities: unique(input.entities),
    body: input.body.trim(),
    sourcePipeline: input.options.sourcePipeline ?? `parse_doc:${input.doc.fileName}`,
    kind: input.options.kind ?? 'requirement-fact',
    // 只出 draft：active 必须走机器校验 + 人工门 + 冲突治理。
    status: 'draft',
    confidence: input.confidence,
    sourceRefs,
    ...(input.options.supersedes === undefined || input.options.supersedes.length === 0
      ? {}
      : { supersedes: unique(input.options.supersedes) }),
  }
}

/** 行标题：优先用第一个非空单元格；否则用表名 + 行号。 */
function rowTitle(table: ParsedTable, row: readonly string[], index: number): string {
  const first = row.find(cell => cell.trim() !== '')
  if (first !== undefined) return first.trim()
  return `${table.title ?? table.id} 第 ${index + 1} 行`
}

/** 行正文：`表头: 值`，跳过空单元格；表头缺失时退化为 `列N: 值`。 */
function renderRowBody(headers: readonly string[], row: readonly string[]): string {
  const lines: string[] = []
  for (let index = 0; index < row.length; index += 1) {
    const value = row[index]!.trim()
    if (value === '') continue
    const header = headers[index]?.trim() || `列${index + 1}`
    lines.push(`${header}: ${value}`)
  }
  return lines.join('\n')
}

/** 从 front matter 声明的 entities/tags 读取列表（文档自己声明，不是模型推断）。 */
function splitMetadataList(value: string | number | boolean | null | undefined): string[] {
  if (typeof value !== 'string') return []
  return value.split(/[,，;；、|]/).map(item => item.trim()).filter(Boolean)
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values.map(value => value.trim()).filter(Boolean))]
}

function safeSlug(value: string): string {
  const normalized = value.toLocaleLowerCase('zh-CN').trim()
  const ascii = normalized.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  if (ascii !== '') return ascii.slice(0, 60)
  return `knowledge-${createHash('sha1').update(value).digest('hex').slice(0, 10)}`
}
