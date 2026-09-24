/**
 * DOCX 解析器（docs/10 §5.6.5 B、ADR-0001）。
 *
 * `.docx` 是 OOXML 压缩包。本解析器**不把 zip 内容交给模型**，而是走
 * `zip-reader.ts` 的白名单解包 + `xml.ts` 的无实体扩展分词，自己抽正文结构。
 * 这样做的理由（ADR-0001 §6）：宏、OLE 嵌入、ActiveX、外链在解包阶段就出局，
 * 而 XXE 与实体爆炸在分词器里**构造上不可能**。
 *
 * 关键策略（逐条对应 §5.6.5 B）：
 * - 标题层级：先看段落的 `outlineLvl`，再看 `pStyle` 在 `styles.xml` 里的 `outlineLvl`，
 *   最后按样式名兜底（`Heading1` / `heading 1` / `标题 1` / `Title`）。
 * - 段落与列表**保持文档顺序**，列表层级取自 `numPr/ilvl`。
 * - 表格转 `ParsedTable`；合并单元格**展开但不复制内容**，并把合并范围写进 metadata
 *   与 `MERGED_CELLS` 诊断——§5.6.5 B 明确禁止"静默复制造成事实重复"。
 * - 页眉/页脚、脚注、尾注策略固定：**不并入正文**，只给 `HEADERS_FOOTERS_SKIPPED` 诊断。
 * - 图片、文本框、SmartArt、嵌入对象**不当作文本**（它们在解包白名单外，从未被解压）。
 * - `.doc` 老二进制格式不由本解析器处理：注册表找不到解析器时返回 `unsupported`。
 *
 * @module platform-pipeline/documents/docx-parser
 */

import {
  DOCUMENT_DIAGNOSTIC_CODES,
  DocumentParseError,
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
import { formatFromExtension } from './document-detect.ts'
import { attr, childrenNamed, dig, firstChild, paragraphText, parseXml, type XmlElement } from './xml.ts'
import { partText, parseRelationships, readOoxmlParts, type OoxmlParts } from './zip-reader.ts'

/** OPC 主文档部件的内容类型，用于确认"这确实是 Word 文档"而不是改了扩展名的 xlsx。 */
const DOCX_MAIN_CONTENT_TYPE = 'wordprocessingml.document.main+xml'
const XLSX_MAIN_CONTENT_TYPE = 'spreadsheetml.sheet.main+xml'

const DOCUMENT_PART = 'word/document.xml'
const STYLES_PART = 'word/styles.xml'
const CONTENT_TYPES_PART = '[Content_Types].xml'

/** 页眉/页脚/脚注/尾注/批注：策略固定为"不并入正文"，只登记不解析。 */
const SIDECAR_PATTERNS: readonly { readonly pattern: RegExp; readonly label: string }[] = [
  { pattern: /^word\/header\d*\.xml$/, label: '页眉' },
  { pattern: /^word\/footer\d*\.xml$/, label: '页脚' },
  { pattern: /^word\/footnotes\.xml$/, label: '脚注' },
  { pattern: /^word\/endnotes\.xml$/, label: '尾注' },
  { pattern: /^word\/comments\.xml$/, label: '批注' },
]

/** 不需要下钻的正文子元素（属性容器、书签、校对标记等）。 */
const SKIP_DESCENT: ReadonlySet<string> = new Set([
  'sectPr', 'bookmarkStart', 'bookmarkEnd', 'commentRangeStart', 'commentRangeEnd',
  'proofErr', 'permStart', 'permEnd', 'moveFromRangeStart', 'moveFromRangeEnd',
])

/** 段落级样式信息（来自 `styles.xml`）。 */
interface DocxStyle {
  readonly name?: string
  readonly outlineLevel?: number
}

export class DocxParser implements DocumentParser {
  readonly format = 'docx' as const
  readonly name = 'builtin-docx'
  readonly mediaTypes = [
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  ] as const

  canParse(input: Readonly<{ path: string; mediaType?: string; magicBytes?: Uint8Array }>): boolean {
    return formatFromExtension(input.path) === 'docx'
  }

  async parse(request: DocumentParseRequest, context: DocumentParserContext): Promise<ParsedDocument> {
    const parts = readOoxmlParts(context.bytes, {
      path: context.relativePath,
      limits: context.limits,
      signal: context.signal,
      accept: name => isWantedPart(name),
    })

    assertIsWordDocument(parts, context.relativePath)

    const diagnostics: DocumentDiagnostic[] = [...parts.diagnostics]
    const documentXml = partText(parts.parts, DOCUMENT_PART)
    if (documentXml === undefined) {
      throw new DocumentParseError(
        DOCUMENT_DIAGNOSTIC_CODES.structuredParseFailed,
        `压缩包内缺少 ${DOCUMENT_PART}；文件可能已损坏，或不是有效的 .docx。`,
        context.relativePath,
      )
    }

    const styles = parseStyles(partText(parts.parts, STYLES_PART), context.relativePath, diagnostics)
    reportSidecars(parts, diagnostics, context.relativePath)
    reportExternalRelationships(parts, diagnostics, context.relativePath)

    const parsedDocument = parseXml(documentXml, context.relativePath)
    diagnostics.push(...parsedDocument.diagnostics)
    const body = parsedDocument.root === undefined ? undefined : firstChild(parsedDocument.root, 'body')
    if (body === undefined) {
      throw new DocumentParseError(
        DOCUMENT_DIAGNOSTIC_CODES.structuredParseFailed,
        `${DOCUMENT_PART} 里找不到 <w:body>，无法定位正文。`,
        context.relativePath,
      )
    }

    const blocks = blockElements(body)
    const includeTables = request.includeTables !== false
    const built = buildSections(blocks, styles, context.relativePath, diagnostics, includeTables)
    const extractedTables = buildTables(blocks, styles, context.relativePath, diagnostics)
    const tables = includeTables ? extractedTables.tables : []

    const metadata = request.includeMetadata === false
      ? {}
      : docxMetadata(parts, context.relativePath, extractedTables.merges, diagnostics)

    const plainText = built.sections.map(section => section.text).join('\n\n')

    return {
      status: 'parsed',
      format: 'docx',
      fileName: context.relativePath.split('/').pop() ?? context.relativePath,
      mediaType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      sha256: context.sha256,
      sections: built.sections,
      tables,
      metadata,
      plainText,
      ...(request.includeRawSource === true ? { rawSource: documentXml } : {}),
      diagnostics,
      // 标题/列表/表格结构来自文档自身声明的样式与 XML 结构，不是推断出来的。
      confidence: 'structure-preserved',
      limits: {
        truncated: false,
        bytesRead: context.bytes.byteLength,
        uncompressedBytes: parts.uncompressedBytes,
      },
    }
  }
}

/** 解包白名单：只取正文、样式、内容类型与文档属性。其余（图片/字体/主题）不解压。 */
function isWantedPart(name: string): boolean {
  if (name === DOCUMENT_PART || name === STYLES_PART || name === CONTENT_TYPES_PART) return true
  if (name === 'word/_rels/document.xml.rels') return true
  if (/^docProps\/(core|app)\.xml$/.test(name)) return true
  return false
}

/**
 * 结构校验：靠**必需部件**判断归档是否可用。
 *
 * 这不是多余的防御——实测（ADR-0001 §6）截断的 ZIP 不会让 `fflate` 报错，它会
 * 基于残缺的本地文件头"成功"解出条目。因此**损坏检测必须靠结构完整性**：
 * 缺 `[Content_Types].xml` 或主文档部件 → `parse-failed`，而不是返回半截内容。
 */
function assertIsWordDocument(parts: OoxmlParts, path: string): void {
  const contentTypes = partText(parts.parts, CONTENT_TYPES_PART)
  if (contentTypes === undefined) {
    throw new DocumentParseError(
      DOCUMENT_DIAGNOSTIC_CODES.structuredParseFailed,
      '压缩包内缺少 [Content_Types].xml，不是有效的 OOXML 文档（可能已损坏）。',
      path,
    )
  }
  if (contentTypes.includes(XLSX_MAIN_CONTENT_TYPE) && !contentTypes.includes(DOCX_MAIN_CONTENT_TYPE)) {
    throw new DocumentParseError(
      DOCUMENT_DIAGNOSTIC_CODES.formatMismatch,
      '文件内容实际是 Excel 工作簿（spreadsheetml），与扩展名 .docx 不符；请以内容为准改用 .xlsx 导入。',
      path,
    )
  }
  if (!contentTypes.includes(DOCX_MAIN_CONTENT_TYPE)) {
    throw new DocumentParseError(
      DOCUMENT_DIAGNOSTIC_CODES.structuredParseFailed,
      '压缩包内没有 Word 主文档内容类型（wordprocessingml.document.main+xml）。',
      path,
    )
  }
}

/** 登记被跳过的页眉/页脚/脚注/尾注/批注与图片资源。 */
function reportSidecars(parts: OoxmlParts, diagnostics: DocumentDiagnostic[], path: string): void {
  const labels = new Map<string, number>()
  let media = 0
  for (const name of parts.ignored) {
    if (name.startsWith('word/media/')) {
      media += 1
      continue
    }
    for (const sidecar of SIDECAR_PATTERNS) {
      if (sidecar.pattern.test(name)) {
        labels.set(sidecar.label, (labels.get(sidecar.label) ?? 0) + 1)
        break
      }
    }
  }
  if (labels.size > 0) {
    const summary = [...labels].map(([label, count]) => `${label}×${count}`).join('、')
    diagnostics.push(diagnostic(
      DOCUMENT_DIAGNOSTIC_CODES.headersFootersSkipped,
      'warning',
      `已跳过 ${summary}：本解析器只解析正文，页眉/页脚/脚注/尾注/批注不并入正文，`
      + '以免同一句话在正文与页眉里各出现一次。',
      path,
    ))
  }
  if (media > 0) {
    diagnostics.push(diagnostic(
      DOCUMENT_DIAGNOSTIC_CODES.embeddedObjectsIgnored,
      'info',
      `文档含 ${media} 个媒体资源（图片/音视频），未解压也未当作文本；如其中有需要读取的图内文字，请先做 OCR。`,
      path,
    ))
  }
}

// ── styles.xml ───────────────────────────────────────────────────────────────

/** 解析段落样式表：`styleId` → 名称与大纲级别。 */
function parseStyles(
  xml: string | undefined,
  path: string,
  diagnostics: DocumentDiagnostic[],
): ReadonlyMap<string, DocxStyle> {
  const styles = new Map<string, DocxStyle>()
  if (xml === undefined) return styles
  const parsed = parseXml(xml, path)
  diagnostics.push(...parsed.diagnostics)
  if (parsed.root === undefined) return styles

  for (const style of childrenNamed(parsed.root, 'style')) {
    const type = attr(style, 'type')
    if (type !== undefined && type !== 'paragraph') continue
    const styleId = attr(style, 'styleId')
    if (styleId === undefined) continue
    const name = dig(style, 'name')
    const outline = dig(style, 'pPr', 'outlineLvl')
    const outlineValue = outline === undefined ? undefined : integerOrUndefined(attr(outline, 'val'))
    styles.set(styleId, {
      ...(name === undefined || attr(name, 'val') === undefined ? {} : { name: attr(name, 'val')! }),
      ...(outlineValue === undefined ? {} : { outlineLevel: outlineValue }),
    })
  }
  return styles
}

// ── 正文遍历 ─────────────────────────────────────────────────────────────────

/**
 * 按文档顺序取出正文里的 `w:p` 与 `w:tbl`。
 *
 * 会下钻内容控件（`w:sdt` 的 `w:sdtContent`）与其他包装元素，否则用内容控件包裹的
 * 段落会被整段丢掉——这是 Word 里很常见的写法。
 */
function blockElements(body: XmlElement): readonly XmlElement[] {
  const out: XmlElement[] = []
  const stack: XmlElement[] = []
  pushElements(stack, body)
  while (stack.length > 0) {
    const node = stack.pop()!
    if (node.name === 'p' || node.name === 'tbl') {
      out.push(node)
      continue
    }
    if (SKIP_DESCENT.has(node.name)) continue
    // `w:sdt` 只下钻 sdtContent，避免把 sdtPr（控件属性）里的元素当成正文。
    const source = node.name === 'sdt' ? firstChild(node, 'sdtContent') : node
    if (source === undefined) continue
    pushElements(stack, source)
  }
  return out
}

function pushElements(stack: XmlElement[], parent: XmlElement): void {
  for (let index = parent.children.length - 1; index >= 0; index -= 1) {
    const child = parent.children[index]!
    if (child.kind === 'element') stack.push(child)
  }
}

/**
 * 判定段落的标题级别（1-9）；非标题返回 undefined。
 *
 * 三级判据，从严到宽：段落自身的 `outlineLvl` → 样式表里的 `outlineLvl` → 样式名兜底。
 * 前两级是文档**显式声明**的结构，只有兜底才是模式匹配。
 */
function headingLevel(paragraph: XmlElement, styles: ReadonlyMap<string, DocxStyle>): number | undefined {
  const pPr = firstChild(paragraph, 'pPr')
  if (pPr === undefined) return undefined

  const ownOutline = dig(pPr, 'outlineLvl')
  if (ownOutline !== undefined) {
    const value = integerOrUndefined(attr(ownOutline, 'val'))
    if (value !== undefined && value >= 0 && value <= 8) return value + 1
  }

  const styleId = attr(firstChild(pPr, 'pStyle') ?? pPr, 'val')
  if (styleId === undefined) return undefined

  const declared = styles.get(styleId)?.outlineLevel
  if (declared !== undefined && declared >= 0 && declared <= 8) return declared + 1

  return headingLevelFromStyleName(styleId) ?? headingLevelFromStyleName(styles.get(styleId)?.name ?? '')
}

/** 样式名兜底。只认明确表达"标题"的写法，不做模糊猜测。 */
function headingLevelFromStyleName(name: string): number | undefined {
  if (name === '') return undefined
  const trimmed = name.trim()
  if (trimmed === 'Title' || trimmed === '标题') return 1
  const patterns = [/^heading\s*([1-9])$/i, /^h([1-9])$/i, /^标题\s*([1-9])$/, /^([1-9])$/]
  for (const pattern of patterns) {
    const match = pattern.exec(trimmed)
    if (match?.[1] !== undefined) return Number.parseInt(match[1], 10)
  }
  return undefined
}

/** 列表缩进层级（`numPr/ilvl`）；非列表返回 undefined。 */
function listLevel(paragraph: XmlElement): number | undefined {
  const pPr = firstChild(paragraph, 'pPr')
  if (pPr === undefined) return undefined
  const ilvl = dig(pPr, 'numPr', 'ilvl')
  if (ilvl === undefined) return undefined
  return integerOrUndefined(attr(ilvl, 'val'))
}

interface BuiltSections {
  readonly sections: readonly ParsedSection[]
}

/**
 * 组装章节。
 *
 * 分组规则：一个标题 + 它之后、下一个同级或更高级标题之前的内容，构成一个 section。
 * 首个标题之前的引言内容单独成段。**整篇没有标题时退化为"每段一个 section"**——
 * 否则一份没有用样式的 Word 会变成单一巨型 section，知识粒度完全失效。
 *
 * `includeTables=false` 时不写表格占位：占位文案指向 `tables`，而调用方明确表示
 * 不要 `tables`，留着就成了一条指向空数组的死引用。
 */
function buildSections(
  blocks: readonly XmlElement[],
  styles: ReadonlyMap<string, DocxStyle>,
  path: string,
  diagnostics: DocumentDiagnostic[],
  includeTables: boolean,
): BuiltSections {
  const hasHeading = blocks.some(block => block.name === 'p' && headingLevel(block, styles) !== undefined)
  const numbers = headingNumbers(blocks, styles)
  const sections: ParsedSection[] = []

  if (!hasHeading) {
    let paragraphIndex = 0
    for (const block of blocks) {
      if (block.name !== 'p') continue
      paragraphIndex += 1
      const text = paragraphText(block).trim()
      if (text === '') continue
      sections.push({
        id: `section-${sections.length + 1}`,
        order: sections.length,
        text,
        sourceRef: sourceRef(path, `paragraph=${paragraphIndex}`),
      })
    }
    return { sections }
  }

  let current: { title?: string; level?: number; number?: string; chunks: string[] } | null = null
  let paragraphIndex = 0
  const flush = (): void => {
    if (current === null) return
    const text = current.chunks.join('\n').trim()
    if (text === '' && current.title === undefined) {
      current = null
      return
    }
    sections.push({
      id: `section-${sections.length + 1}`,
      ...(current.title === undefined ? {} : { title: current.title }),
      ...(current.level === undefined ? {} : { level: current.level }),
      order: sections.length,
      text,
      sourceRef: sourceRef(path, current.number === undefined ? `paragraph=${paragraphIndex}` : `heading=${current.number}`),
    })
    current = null
  }

  for (const block of blocks) {
    if (block.name === 'tbl') {
      if (!includeTables) continue
      if (current === null) current = { chunks: [] }
      // 表格在章节正文里只占位，结构化内容由 tables 单独给出（避免同一份数据出现两次）。
      current.chunks.push(`[表格 ${countTablesSoFar(blocks, block)}：结构化内容见 tables]`)
      continue
    }
    paragraphIndex += 1
    const level = headingLevel(block, styles)
    const text = paragraphText(block).trim()
    if (level !== undefined) {
      flush()
      current = {
        title: text === '' ? `未命名标题 ${numbers.get(block) ?? ''}`.trim() : text,
        level,
        number: numbers.get(block),
        chunks: [],
      }
      continue
    }
    if (text === '') continue
    if (current === null) current = { chunks: [] }
    const indent = listLevel(block)
    current.chunks.push(indent === undefined || indent === 0 ? text : `${'  '.repeat(indent)}- ${text}`)
  }
  flush()

  if (sections.length === 0) {
    diagnostics.push(diagnostic(
      DOCUMENT_DIAGNOSTIC_CODES.emptyContent,
      'warning',
      '正文里没有可提取的段落文本；文档可能是空文档，或正文全部位于图片/文本框中。',
      path,
    ))
  }
  return { sections }
}

/** 该表格是文档里的第几个表格（用于正文占位文案）。 */
function countTablesSoFar(blocks: readonly XmlElement[], target: XmlElement): number {
  let count = 0
  for (const block of blocks) {
    if (block.name !== 'tbl') continue
    count += 1
    if (block === target) return count
  }
  return count
}

/** 标题编号路径（`1`、`1.1`、`1.1.2`），与 Markdown 解析器同一套规则。 */
function headingNumbers(blocks: readonly XmlElement[], styles: ReadonlyMap<string, DocxStyle>): ReadonlyMap<XmlElement, string> {
  const counters: number[] = []
  const numbers = new Map<XmlElement, string>()
  for (const block of blocks) {
    if (block.name !== 'p') continue
    const level = headingLevel(block, styles)
    if (level === undefined) continue
    counters.length = level
    counters[level - 1] = (counters[level - 1] ?? 0) + 1
    for (let index = 0; index < level; index += 1) counters[index] = counters[index] ?? 1
    numbers.set(block, counters.filter(value => value !== undefined).join('.'))
  }
  return numbers
}

// ── 表格 ─────────────────────────────────────────────────────────────────────

interface MergeInfo {
  readonly axis: 'columns' | 'rows'
  readonly row: number
  readonly column: number
  readonly span: number
}

interface ExtractedTable {
  readonly headers: readonly string[]
  readonly rows: readonly (readonly string[])[]
  readonly merges: readonly MergeInfo[]
  readonly ragged: boolean
}

interface BuiltTables {
  readonly tables: readonly ParsedTable[]
  /** 全部合并范围的可读记法（写入 metadata，便于人工核对）。 */
  readonly merges: readonly string[]
}

function buildTables(
  blocks: readonly XmlElement[],
  styles: ReadonlyMap<string, DocxStyle>,
  path: string,
  diagnostics: DocumentDiagnostic[],
): BuiltTables {
  const numbers = headingNumbers(blocks, styles)
  const tables: ParsedTable[] = []
  const merges: string[] = []
  let lastHeading: { readonly number?: string; readonly title?: string } = {}
  let indexInHeading = 0
  let ragged = false

  for (const block of blocks) {
    if (block.name === 'p') {
      const level = headingLevel(block, styles)
      if (level !== undefined) {
        lastHeading = {
          ...(numbers.get(block) === undefined ? {} : { number: numbers.get(block) }),
          title: paragraphText(block).trim(),
        }
        indexInHeading = 0
      }
      continue
    }

    indexInHeading += 1
    const extracted = extractTable(block)
    if (extracted.ragged) ragged = true
    const fragment = lastHeading.number === undefined
      ? `table=${tables.length + 1}`
      : `heading=${lastHeading.number},table=${indexInHeading}`
    for (const merge of extracted.merges) merges.push(describeMerge(merge))

    tables.push({
      id: `table-${tables.length + 1}`,
      ...(lastHeading.title === undefined || lastHeading.title === ''
        ? {}
        : { title: `${lastHeading.title} 表格 ${indexInHeading}` }),
      headers: extracted.headers,
      rows: extracted.rows,
      rowRefs: extracted.rows.map((_row, rowIndex) => sourceRef(path, `${fragment},row=${rowIndex + 1}`)),
      sourceRef: sourceRef(path, fragment),
    })
  }

  if (merges.length > 0) {
    diagnostics.push(diagnostic(
      DOCUMENT_DIAGNOSTIC_CODES.mergedCells,
      'warning',
      `文档含 ${merges.length} 处合并单元格（${merges.slice(0, 20).join(', ')}${merges.length > 20 ? ' …' : ''}）：`
      + '内容只保留在合并区域的首个单元格，其余位置留空——不复制内容，避免同一事实在表格里重复出现。',
      path,
    ))
  }
  if (ragged) {
    diagnostics.push(diagnostic(
      DOCUMENT_DIAGNOSTIC_CODES.raggedRows,
      'warning',
      '部分表格行的单元格数与表头不一致（合并单元格或手工插列所致）；缺失位置已按空值补齐。',
      path,
    ))
  }
  return { tables, merges }
}

/**
 * 抽取一个 `w:tbl`。
 *
 * 合并单元格的处理是这里的核心：`gridSpan`（横向）与 `vMerge`（纵向）都**只把内容留在
 * 合并区域的首个单元格**，其余位置填空字符串，并登记合并范围。这样下游不会看到
 * "同一句话在 3 列里各出现一次"的假重复（§5.6.5 B）。
 */
function extractTable(table: XmlElement): ExtractedTable {
  const rows = childrenNamed(table, 'tr')
  const grid: string[][] = []
  const merges: MergeInfo[] = []
  const openVertical: (number | undefined)[] = []
  let ragged = false

  rows.forEach((row, rowIndex) => {
    const cells: string[] = []
    let column = 0
    for (const cell of childrenNamed(row, 'tc')) {
      const properties = firstChild(cell, 'tcPr')
      const spanElement = properties === undefined ? undefined : firstChild(properties, 'gridSpan')
      const span = Math.max(1, integerOrUndefined(spanElement === undefined ? undefined : attr(spanElement, 'val')) ?? 1)
      const mergeElement = properties === undefined ? undefined : firstChild(properties, 'vMerge')
      const isContinuation = mergeElement !== undefined && attr(mergeElement, 'val') !== 'restart'

      const text = paragraphText(cell).trim()
      if (isContinuation) {
        cells.push('')
      } else {
        if (openVertical[column] !== undefined) {
          const start = openVertical[column]!
          if (rowIndex - start > 1) merges.push({ axis: 'rows', row: start, column, span: rowIndex - start })
          openVertical[column] = undefined
        }
        if (mergeElement !== undefined) openVertical[column] = rowIndex
        cells.push(text)
      }
      if (span > 1) {
        merges.push({ axis: 'columns', row: rowIndex, column, span })
        for (let extra = 1; extra < span; extra += 1) cells.push('')
      }
      column += span
    }
    grid.push(cells)
  })

  // 收尾：仍在打开的纵向合并，跨度算到表格末尾。
  openVertical.forEach((start, column) => {
    if (start !== undefined && rows.length - start > 1) {
      merges.push({ axis: 'rows', row: start, column, span: rows.length - start })
    }
  })

  const width = grid.reduce((max, row) => Math.max(max, row.length), 0)
  if (grid.some(row => row.length !== width)) ragged = true
  const normalized = grid.map(row => {
    if (row.length === width) return row
    return [...row, ...Array.from({ length: width - row.length }, () => '')]
  })

  const headers = normalized[0] ?? []
  return {
    headers: headers.map((cell, index) => (cell === '' ? `列${index + 1}` : cell)),
    rows: normalized.slice(1),
    merges,
    ragged,
  }
}

/** 合并范围的可读记法（`A1:C1` / `A2:A4`），写入诊断与 metadata。 */
function describeMerge(merge: MergeInfo): string {
  const start = `${columnLetter(merge.column)}${merge.row + 1}`
  const end = merge.axis === 'columns'
    ? `${columnLetter(merge.column + merge.span - 1)}${merge.row + 1}`
    : `${columnLetter(merge.column)}${merge.row + merge.span}`
  return `${start}:${end}`
}

/** 列序号 → 字母（0 → A，25 → Z，26 → AA）。 */
function columnLetter(index: number): string {
  let value = index
  let out = ''
  while (true) {
    out = String.fromCharCode(65 + (value % 26)) + out
    value = Math.floor(value / 26) - 1
    if (value < 0) break
  }
  return out
}

// ── 文档属性与外部引用 ───────────────────────────────────────────────────────

/**
 * 登记文档级外部引用。
 *
 * `word/_rels/document.xml.rels` 里 `TargetMode="External"` 的关系就是超链接、
 * 外部图片、外部模板。它们**只登记不解析**：不下载、不打开、不把地址交给模型当内容。
 * 这与 §5.6.5 B「DOCX 中的外部链接…不执行」一致——这里做的是"报出来"，
 * 而"不执行"由架构保证（我们根本没有发起网络请求的代码路径）。
 */
function reportExternalRelationships(
  parts: OoxmlParts,
  diagnostics: DocumentDiagnostic[],
  path: string,
): void {
  const relsXml = partText(parts.parts, 'word/_rels/document.xml.rels')
  if (relsXml === undefined) return
  const parsed = parseRelationships(relsXml, path)
  diagnostics.push(...parsed.diagnostics)
  const external = parsed.relationships.filter(relationship => relationship.external)
  if (external.length === 0) return
  const targets = [...new Set(external.map(relationship => relationship.target))].slice(0, 20)
  diagnostics.push(diagnostic(
    DOCUMENT_DIAGNOSTIC_CODES.externalReferencesIgnored,
    'info',
    `文档含 ${external.length} 个外部引用，只登记目标地址、不下载不解析：${targets.join(', ')}`
    + `${external.length > targets.length ? ' …' : ''}`,
    path,
  ))
}

/** 从 `docProps/core.xml` 与 `docProps/app.xml` 取标题、作者等**声明**的元数据。 */
function docxMetadata(
  parts: OoxmlParts,
  path: string,
  mergeDescriptions: readonly string[],
  diagnostics: DocumentDiagnostic[],
): Readonly<Record<string, string | number | boolean | null>> {
  const metadata: Record<string, string | number | boolean | null> = {}

  const core = partText(parts.parts, 'docProps/core.xml')
  if (core !== undefined) {
    const parsed = parseXml(core, path)
    diagnostics.push(...parsed.diagnostics)
    if (parsed.root !== undefined) {
      copyText(parsed.root, 'title', metadata, 'title')
      copyText(parsed.root, 'creator', metadata, 'creator')
      copyText(parsed.root, 'lastModifiedBy', metadata, 'lastModifiedBy')
      copyText(parsed.root, 'created', metadata, 'created')
      copyText(parsed.root, 'modified', metadata, 'modified')
    }
  }

  const app = partText(parts.parts, 'docProps/app.xml')
  if (app !== undefined) {
    const parsed = parseXml(app, path)
    diagnostics.push(...parsed.diagnostics)
    if (parsed.root !== undefined) {
      copyText(parsed.root, 'Company', metadata, 'company')
      copyInteger(parsed.root, 'Words', metadata, 'wordCount')
      copyInteger(parsed.root, 'Pages', metadata, 'appPageCount')
      copyInteger(parsed.root, 'Paragraphs', metadata, 'paragraphCount')
    }
  }

  // 合并范围：诊断只给摘要（前 20 个），完整清单放 metadata 供人工核对。
  if (mergeDescriptions.length > 0) {
    metadata.mergedCells = mergeDescriptions.join(', ')
    metadata.mergedCellCount = mergeDescriptions.length
  }
  return metadata
}

/** 取元素的直接文本（按本地名匹配，命名空间前缀被忽略）。 */
function copyText(
  root: XmlElement,
  localName: string,
  into: Record<string, string | number | boolean | null>,
  key: string,
): void {
  const value = elementText(firstChild(root, localName)).trim()
  if (value !== '') into[key] = value
}

/** 取元素文本并解析为整数；不是整数就不写入（不猜、不置 0）。 */
function copyInteger(
  root: XmlElement,
  localName: string,
  into: Record<string, string | number | boolean | null>,
  key: string,
): void {
  const value = integerOrUndefined(elementText(firstChild(root, localName)))
  if (value !== undefined) into[key] = value
}

/** 元素的直接文本子节点（不递归：这些属性元素都是纯文本）。 */
function elementText(element: XmlElement | undefined): string {
  if (element === undefined) return ''
  let out = ''
  for (const child of element.children) {
    if (child.kind === 'text') out += child.value
  }
  return out
}

/** 只接受十进制整数字符串；其余（含空串、小数、非数字）返回 undefined。 */
function integerOrUndefined(value: string | undefined): number | undefined {
  if (value === undefined || !/^-?\d+$/.test(value.trim())) return undefined
  const parsed = Number.parseInt(value.trim(), 10)
  return Number.isSafeInteger(parsed) ? parsed : undefined
}
