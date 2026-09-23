/**
 * Markdown 解析器（docs/10 §5.6.5 D）。
 *
 * 明确不做 `stripMarkdown` 后只返回一段文本——标题、表格、代码块本身就是知识结构，
 * 丢掉它们等于丢掉可追溯性。因此本解析器按行做块级切分，输出：
 * - 标题层级 → `ParsedSection.level`（并给出 `#heading=1.2.3` 形式的编号路径）；
 * - 段落与列表**保持原始顺序**（不重排、不合并）；
 * - Markdown 表格 → `ParsedTable`（含表头推断与行级 sourceRef 基础）；
 * - fenced code block **原样保留**，且绝不执行其中内容；
 * - blockquote / 链接 / 图片引用保留为文本，链接目标另存 metadata；
 * - front matter 单独解析为 metadata，非法 YAML 只给 warning 不中断；
 * - `.mdx` 的 JSX/组件标签按文本处理并给诊断，不执行、不当作 unsupported 整篇丢弃。
 *
 * `plainText` 有意保留 Markdown 原文（去掉 front matter）：对 Markdown 而言原文
 * 本身就是结构最完整的可检索形式，重新"拍平"只会丢信息。
 *
 * @module platform-pipeline/documents/markdown-parser
 */

import { parse as parseYaml } from 'yaml'

import { formatFromExtension } from './document-detect.ts'
import { decodeText } from './document-detect.ts'
import {
  DOCUMENT_DIAGNOSTIC_CODES,
  diagnostic,
  sourceRef,
  type DocumentDiagnostic,
  type DocumentParseRequest,
  type DocumentParser,
  type DocumentParserContext,
  type ParsedDocument,
  type ParsedSection,
  type ParsedTable,
} from './document-types.ts'

interface HeadingToken {
  readonly kind: 'heading'
  readonly level: number
  readonly title: string
  readonly line: number
}

interface CodeToken {
  readonly kind: 'code'
  readonly info: string
  readonly body: string
  readonly startLine: number
  readonly endLine: number
}

interface TableToken {
  readonly kind: 'table'
  readonly headers: readonly string[]
  readonly rows: readonly (readonly string[])[]
  readonly startLine: number
  readonly endLine: number
}

interface TextToken {
  readonly kind: 'text'
  readonly lines: readonly string[]
  readonly startLine: number
  readonly endLine: number
}

type BlockToken = HeadingToken | CodeToken | TableToken | TextToken

export class MarkdownParser implements DocumentParser {
  readonly format = 'markdown' as const
  readonly name = 'builtin-markdown'
  readonly mediaTypes = ['text/markdown', 'text/x-markdown', 'text/plain'] as const

  canParse(input: Readonly<{ path: string; mediaType?: string; magicBytes?: Uint8Array }>): boolean {
    return formatFromExtension(input.path) === 'markdown'
  }

  async parse(request: DocumentParseRequest, context: DocumentParserContext): Promise<ParsedDocument> {
    const decoded = decodeText(context.bytes, context.relativePath)
    const diagnostics: DocumentDiagnostic[] = [...decoded.diagnostics]
    const allLines = decoded.text.replace(/\r\n?/g, '\n').split('\n')

    const frontMatter = extractFrontMatter(allLines, context.relativePath, request.includeMetadata !== false, diagnostics)
    const bodyLines = allLines.slice(frontMatter.consumedLines)
    const tokens = tokenize(bodyLines, context.relativePath, diagnostics)

    const sections = buildSections(tokens, bodyLines, context.relativePath, frontMatter.offset)
    const tables = buildTables(tokens, context.relativePath)
    const metadata = buildMetadata(tokens, frontMatter.data, diagnostics)

    return {
      status: 'parsed',
      format: 'markdown',
      fileName: context.relativePath.split('/').pop() ?? context.relativePath,
      mediaType: 'text/markdown',
      sha256: context.sha256,
      sections,
      tables,
      metadata,
      plainText: bodyLines.join('\n'),
      ...(request.includeRawSource === true ? { rawSource: decoded.text } : {}),
      diagnostics,
      confidence: 'structure-preserved',
      limits: { truncated: false, bytesRead: context.bytes.byteLength },
    }
  }
}

// ── front matter ─────────────────────────────────────────────────────────────

interface FrontMatter {
  readonly data: Readonly<Record<string, string | number | boolean | null>>
  readonly consumedLines: number
  /** 正文首行在原始文件中的行号偏移（1-based 行号 = 数组下标 + offset）。 */
  readonly offset: number
}

/**
 * 解析 YAML front matter。
 *
 * 只认文件**第一行**就是 `---` 且能找到闭合 `---` 的形式。非法 YAML 不中断解析
 * （正文仍然可读），只给 `FRONT_MATTER_INVALID` warning 并把原文留作 metadata。
 */
function extractFrontMatter(
  lines: readonly string[],
  path: string,
  includeMetadata: boolean,
  diagnostics: DocumentDiagnostic[],
): FrontMatter {
  const none: FrontMatter = { data: {}, consumedLines: 0, offset: 0 }
  if (lines[0]?.trim() !== '---') return none
  const close = lines.findIndex((line, index) => index > 0 && (line.trim() === '---' || line.trim() === '...'))
  if (close < 0) {
    diagnostics.push(diagnostic(
      DOCUMENT_DIAGNOSTIC_CODES.frontMatterInvalid,
      'warning',
      'front matter 起始标记没有对应闭合标记，已按正文处理。',
      path,
    ))
    return none
  }
  const raw = lines.slice(1, close).join('\n')
  const consumedLines = close + 1
  if (!includeMetadata) return { data: {}, consumedLines, offset: consumedLines }
  try {
    const parsed = parseYaml(raw) as unknown
    return { data: toMetadataRecord(parsed), consumedLines, offset: consumedLines }
  } catch (error) {
    diagnostics.push(diagnostic(
      DOCUMENT_DIAGNOSTIC_CODES.frontMatterInvalid,
      'warning',
      `front matter 不是合法 YAML（${error instanceof Error ? error.message : String(error)}）；已忽略，正文解析不受影响。`,
      path,
    ))
    return { data: {}, consumedLines, offset: consumedLines }
  }
}

function toMetadataRecord(value: unknown): Record<string, string | number | boolean | null> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {}
  const out: Record<string, string | number | boolean | null> = {}
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (item === null || typeof item === 'string' || typeof item === 'number' || typeof item === 'boolean') {
      out[key] = item
    } else if (Array.isArray(item)) {
      out[key] = item.map(entry => (typeof entry === 'string' ? entry : JSON.stringify(entry))).join(', ')
    } else {
      out[key] = JSON.stringify(item)
    }
  }
  return out
}

// ── 块级切分 ─────────────────────────────────────────────────────────────────

const FENCE = /^(\s{0,3})(`{3,}|~{3,})\s*(.*)$/
const ATX_HEADING = /^(\s{0,3})(#{1,6})\s+(.*?)\s*#*\s*$/
const SETEXT_UNDERLINE = /^\s{0,3}(=+|-{2,})\s*$/

function tokenize(lines: readonly string[], path: string, diagnostics: DocumentDiagnostic[]): readonly BlockToken[] {
  const tokens: BlockToken[] = []
  let pending: string[] = []
  let pendingStart = 0
  let jsxReported = false

  const flush = (endLine: number): void => {
    if (pending.length === 0) return
    tokens.push({ kind: 'text', lines: [...pending], startLine: pendingStart, endLine })
    pending = []
  }

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!

    // fenced code block：内部一律按原文处理，标题/表格/JSX 都不参与识别。
    const fence = FENCE.exec(line)
    if (fence !== null) {
      const marker = fence[2]!
      const info = fence[3]!.trim()
      flush(index)
      const body: string[] = []
      let cursor = index + 1
      let closed = false
      for (; cursor < lines.length; cursor += 1) {
        const candidate = lines[cursor]!
        const closeMatch = FENCE.exec(candidate)
        if (closeMatch !== null && closeMatch[2]!.startsWith(marker[0]!) && closeMatch[2]!.length >= marker.length
          && closeMatch[3]!.trim() === '') {
          closed = true
          break
        }
        body.push(candidate)
      }
      tokens.push({ kind: 'code', info, body: body.join('\n'), startLine: index, endLine: cursor })
      if (!closed) {
        diagnostics.push(diagnostic(
          DOCUMENT_DIAGNOSTIC_CODES.truncated,
          'warning',
          `第 ${index + 1} 行开始的 fenced code block 没有闭合标记，已按到文件末尾处理。`,
          path,
        ))
      }
      index = cursor
      continue
    }

    const heading = ATX_HEADING.exec(line)
    if (heading !== null) {
      flush(index)
      tokens.push({ kind: 'heading', level: heading[2]!.length, title: heading[3]!.trim(), line: index })
      continue
    }

    // setext 标题：下一行是 === 或 ---，且当前行有内容
    if (line.trim() !== '' && !isTableRow(line) && SETEXT_UNDERLINE.test(lines[index + 1] ?? '')) {
      flush(index)
      const underline = lines[index + 1]!.trim()
      tokens.push({ kind: 'heading', level: underline.startsWith('=') ? 1 : 2, title: line.trim(), line: index })
      index += 1
      continue
    }

    // Markdown 表格：当前行是表头，下一行是分隔行
    if (isTableRow(line) && isTableSeparator(lines[index + 1] ?? '')) {
      flush(index)
      const headers = splitTableRow(line)
      const rows: string[][] = []
      let cursor = index + 2
      for (; cursor < lines.length; cursor += 1) {
        const candidate = lines[cursor]!
        if (!isTableRow(candidate)) break
        rows.push(splitTableRow(candidate))
      }
      tokens.push({ kind: 'table', headers, rows, startLine: index, endLine: cursor - 1 })
      index = cursor - 1
      continue
    }

    if (!jsxReported && /^\s*<[A-Z][A-Za-z0-9.]*[\s/>]/.test(line)) {
      jsxReported = true
      diagnostics.push(diagnostic(
        DOCUMENT_DIAGNOSTIC_CODES.jsxAsText,
        'warning',
        '文档含 JSX/组件标签（疑似 .mdx）；标签按纯文本保留，不执行、不解析组件语义。',
        path,
      ))
    }

    if (pending.length === 0) pendingStart = index
    pending.push(line)
  }
  flush(lines.length - 1)
  return tokens
}

function isTableRow(line: string): boolean {
  return line.includes('|') && line.trim().startsWith('|')
}

function isTableSeparator(line: string): boolean {
  const trimmed = line.trim()
  if (trimmed === '' || !trimmed.includes('-')) return false
  if (!/^\|?[\s:|-]+\|?$/.test(trimmed)) return false
  return splitTableRow(trimmed).length > 0
}

/** 拆表格行：剥掉首尾 `|`、还原 `\|` 转义、去掉单元格两侧空白。 */
function splitTableRow(line: string): string[] {
  let body = line.trim()
  if (body.startsWith('|')) body = body.slice(1)
  if (body.endsWith('|')) body = body.slice(0, -1)
  const cells: string[] = []
  let current = ''
  for (let index = 0; index < body.length; index += 1) {
    const char = body[index]!
    if (char === '\\' && body[index + 1] === '|') { current += '|'; index += 1; continue }
    if (char === '|') { cells.push(current.trim()); current = ''; continue }
    current += char
  }
  cells.push(current.trim())
  return cells
}

// ── 章节与表格组装 ───────────────────────────────────────────────────────────

/** 标题编号路径：`1`、`1.1`、`1.1.2`（同级递增，跨级补齐）。 */
function headingNumbers(tokens: readonly BlockToken[]): ReadonlyMap<number, string> {
  const counters: number[] = []
  const numbers = new Map<number, string>()
  for (const token of tokens) {
    if (token.kind !== 'heading') continue
    counters.length = token.level
    counters[token.level - 1] = (counters[token.level - 1] ?? 0) + 1
    for (let index = 0; index < token.level; index += 1) counters[index] = counters[index] ?? 1
    numbers.set(token.line, counters.filter(value => value !== undefined).join('.'))
  }
  return numbers
}

function buildSections(
  tokens: readonly BlockToken[],
  bodyLines: readonly string[],
  path: string,
  offset: number,
): readonly ParsedSection[] {
  const numbers = headingNumbers(tokens)
  const sections: ParsedSection[] = []
  let current: { title?: string; level?: number; number?: string; startLine: number; chunks: string[] } | null = null

  const flush = (endLine: number): void => {
    if (current === null) return
    const text = current.chunks.join('\n').trim()
    const fragment = current.number === undefined
      ? `lines=${current.startLine + 1 + offset}-${endLine + 1 + offset}`
      : `heading=${current.number}`
    sections.push({
      id: `section-${sections.length + 1}`,
      ...(current.title === undefined ? {} : { title: current.title }),
      ...(current.level === undefined ? {} : { level: current.level }),
      order: sections.length,
      text,
      sourceRef: sourceRef(path, fragment),
    })
    current = null
  }

  for (const token of tokens) {
    if (token.kind === 'heading') {
      flush(token.line - 1)
      current = {
        title: token.title,
        level: token.level,
        number: numbers.get(token.line),
        startLine: token.line,
        chunks: [],
      }
      continue
    }
    if (current === null) current = { startLine: token.startLine, chunks: [] }
    if (token.kind === 'code') {
      // 代码块原样保留（含围栏），但绝不执行。
      const fence = token.info === '' ? '```' : `\`\`\`${token.info}`
      current.chunks.push(`${fence}\n${token.body}\n\`\`\``)
      continue
    }
    if (token.kind === 'table') {
      current.chunks.push(renderTableText(token))
      continue
    }
    current.chunks.push(token.lines.join('\n'))
  }
  flush(bodyLines.length - 1)

  // 纯空白章节没有知识价值，直接丢弃（不生成空 section 干扰检索）。
  return sections.filter(section => section.text.trim() !== '' || section.title !== undefined)
}

function renderTableText(token: TableToken): string {
  const header = `| ${token.headers.join(' | ')} |`
  const separator = `| ${token.headers.map(() => '---').join(' | ')} |`
  return [header, separator, ...token.rows.map(row => `| ${row.join(' | ')} |`)].join('\n')
}

function buildTables(tokens: readonly BlockToken[], path: string): readonly ParsedTable[] {
  const numbers = headingNumbers(tokens)
  const tables: ParsedTable[] = []
  let lastHeading: { number?: string; title?: string } = {}
  let indexInHeading = 0

  for (const token of tokens) {
    if (token.kind === 'heading') {
      lastHeading = { ...(numbers.get(token.line) === undefined ? {} : { number: numbers.get(token.line) }), title: token.title }
      indexInHeading = 0
      continue
    }
    if (token.kind !== 'table') continue
    indexInHeading += 1
    const fragment = lastHeading.number === undefined
      ? `table=${tables.length + 1}`
      : `heading=${lastHeading.number},table=${indexInHeading}`
    tables.push({
      id: `table-${tables.length + 1}`,
      ...(lastHeading.title === undefined ? {} : { title: `${lastHeading.title} 表格 ${indexInHeading}` }),
      headers: token.headers,
      rows: token.rows,
      // 行级 ref：知识投影据此把每条表格行知识追溯到具体行（docs/10 §5.6.7）。
      rowRefs: token.rows.map((_row, rowIndex) => sourceRef(path, `${fragment},row=${rowIndex + 1}`)),
      sourceRef: sourceRef(path, fragment),
    })
  }
  return tables
}

/**
 * 链接/图片引用保留为文本（正文里不动），但把目标单独抽到 metadata，
 * 便于审计"文档引用了哪些外部地址"——**不下载、不解析**。
 */
function buildMetadata(
  tokens: readonly BlockToken[],
  frontMatter: Readonly<Record<string, string | number | boolean | null>>,
  diagnostics: DocumentDiagnostic[],
): Readonly<Record<string, string | number | boolean | null>> {
  const body = tokens
    .filter((token): token is TextToken => token.kind === 'text')
    .map(token => token.lines.join('\n'))
    .join('\n')
  const links = [...body.matchAll(/\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)].map(match => match[2]!)
  const images = [...body.matchAll(/!\[([^\]]*)\]\(([^)\s]+)/g)].map(match => match[2]!)
  const codeBlocks = tokens.filter((token): token is CodeToken => token.kind === 'code')

  const metadata: Record<string, string | number | boolean | null> = { ...frontMatter }
  if (links.length > 0) metadata.linkTargets = [...new Set(links)].slice(0, 50).join(', ')
  if (images.length > 0) metadata.imageTargets = [...new Set(images)].slice(0, 50).join(', ')
  metadata.codeBlockCount = codeBlocks.length
  if (codeBlocks.some(block => block.info !== '')) {
    metadata.codeLanguages = [...new Set(codeBlocks.map(block => block.info).filter(info => info !== ''))].join(', ')
  }
  if (links.length + images.length > 0) {
    diagnostics.push(diagnostic(
      DOCUMENT_DIAGNOSTIC_CODES.externalReferencesIgnored,
      'info',
      `文档含 ${links.length} 个链接与 ${images.length} 个图片引用；只记录目标地址，不下载、不解析外部内容。`,
    ))
  }
  return metadata
}
