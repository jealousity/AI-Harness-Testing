/**
 * XLSX 解析器（docs/10 §5.6.5 C、ADR-0001）。
 *
 * `.xlsx` 是 OOXML 压缩包，**绝不能按普通文本处理**。本解析器输出
 * workbook → sheet → range/table 的中间结构，并对每一项都保留原始位置：
 * `sourceRef` 细化到 `cases.xlsx#sheet=接口!A2:F20`，行级 `rowRefs` 细化到
 * `cases.xlsx#sheet=接口!A2:F2`（§5.6.5 C 与 §5.6.7 的硬要求）。
 *
 * 两条**解包策略**值得单独说明：
 * 1. **两趟解包**。第一趟只取工作簿结构（workbook / rels / sharedStrings / styles /
 *    docProps），据 `state` 与调用方给的 `sheetNames` 决定要读哪些 sheet；第二趟用
 *    精确白名单解包这些 sheet 的 XML。因此**被跳过的隐藏 sheet 的字节从未被解压**，
 *    "默认只读可见 sheet"不只是过滤结果，而是从解压层面就不读。
 * 2. **公式只读缓存值**。有 `<f>` 而无 `<v>` 时标 `FORMULA_VALUE_UNAVAILABLE`，
 *    **绝不自行计算**（§5.6.5 C 明令"不得自行计算并伪装成 Excel 结果"）。
 *
 * 老二进制 `.xls` 不由本解析器处理：注册表找不到解析器时返回 `unsupported`，
 * 并提示转换为 `.xlsx`（ADR-0001 §9）。
 *
 * @module platform-pipeline/documents/xlsx-parser
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
  type ParsedCellType,
  type ParsedDocument,
  type ParsedSection,
  type ParsedTable,
} from './document-types.ts'
import { limitExceeded } from './document-limits.ts'
import { formatFromExtension } from './document-detect.ts'
import { attr, childrenNamed, dig, firstChild, parseXml, textOf, type XmlElement } from './xml.ts'
import {
  parseRelationships,
  partText,
  readOoxmlParts,
  resolveRelationshipTargets,
  type OoxmlParts,
} from './zip-reader.ts'

const XLSX_MAIN_CONTENT_TYPE = 'spreadsheetml.sheet.main+xml'
const DOCX_MAIN_CONTENT_TYPE = 'wordprocessingml.document.main+xml'

const CONTENT_TYPES_PART = '[Content_Types].xml'
const WORKBOOK_PART = 'xl/workbook.xml'
const WORKBOOK_RELS_PART = 'xl/_rels/workbook.xml.rels'
const SHARED_STRINGS_PART = 'xl/sharedStrings.xml'
const STYLES_PART = 'xl/styles.xml'

/** 单元格值的原始类型（与 `ParsedTable.cellTypes` 同源）。 */
export type CellValueType = ParsedCellType

/** 一次 sheet 解析的结果。 */
interface SheetResult {
  readonly name: string
  readonly table?: ParsedTable
  readonly diagnostics: readonly DocumentDiagnostic[]
  readonly truncated: boolean
  readonly rows: number
  readonly columns: number
  readonly cellCount: number
  readonly formulas: readonly string[]
  readonly formulaMissingCache: number
  readonly mergedCells: readonly string[]
  readonly autoFilter?: string
  readonly frozenPane?: string
  readonly tableNames: readonly string[]
}

export class XlsxParser implements DocumentParser {
  readonly format = 'xlsx' as const
  readonly name = 'builtin-xlsx'
  readonly mediaTypes = [
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ] as const

  canParse(input: Readonly<{ path: string; mediaType?: string; magicBytes?: Uint8Array }>): boolean {
    return formatFromExtension(input.path) === 'xlsx'
  }

  async parse(request: DocumentParseRequest, context: DocumentParserContext): Promise<ParsedDocument> {
    // ── 第一趟：只取工作簿结构，不解压任何 sheet ──
    const structure = readOoxmlParts(context.bytes, {
      path: context.relativePath,
      limits: context.limits,
      signal: context.signal,
      accept: isStructurePart,
    })
    assertIsWorkbook(structure, context.relativePath)

    const diagnostics: DocumentDiagnostic[] = [...structure.diagnostics]
    const workbookXml = partText(structure.parts, WORKBOOK_PART)
    if (workbookXml === undefined) {
      throw new DocumentParseError(
        DOCUMENT_DIAGNOSTIC_CODES.structuredParseFailed,
        `压缩包内缺少 ${WORKBOOK_PART}；文件可能已损坏，或不是有效的 .xlsx。`,
        context.relativePath,
      )
    }

    const workbook = parseWorkbook(workbookXml, context.relativePath, diagnostics)
    const relationships = parseWorkbookRelationships(structure, context.relativePath, diagnostics)
    const sheets = resolveSheets(workbook, relationships, context.relativePath, diagnostics)
    const styles = parseStyles(partText(structure.parts, STYLES_PART), context.relativePath, diagnostics)
    const sharedStrings = parseSharedStrings(partText(structure.parts, SHARED_STRINGS_PART), context.relativePath, diagnostics)

    // ── 选择要读的 sheet：默认只读可见 sheet ──
    const selection = selectSheets(sheets, request, context.relativePath, diagnostics)
    if (selection.toRead.length > context.limits.maxSheets) {
      throw limitExceeded(
        `本次请求读取 ${selection.toRead.length} 个 sheet，超过上限 ${context.limits.maxSheets}；`
        + '请用 sheetNames 指定要读取的 sheet 后重试。',
      )
    }

    // ── 第二趟：精确白名单解包被选中的 sheet 与它们引用的表格定义 ──
    const sheetPartNames = new Set(selection.toRead.map(sheet => sheet.partName))
    const sheetRelsNames = new Set(selection.toRead.map(sheet => relsPartFor(sheet.partName)))
    const tableParts = new Set<string>()
    // 表格定义归属于**哪张 sheet** 只能由该 sheet 自己的 rels 决定，
    // 不能从 `xl/tables/tableN.xml` 的编号反推——编号与 sheet 的对应关系不保证一致。
    const tablePartsBySheet = new Map<string, string[]>()
    for (const sheet of selection.toRead) {
      const relsXml = partText(structure.parts, relsPartFor(sheet.partName))
      if (relsXml === undefined) continue
      const parsed = parseRelationships(relsXml, context.relativePath)
      diagnostics.push(...parsed.diagnostics)
      const owned: string[] = []
      for (const partName of resolveRelationshipTargets(parsed.relationships, dirnameOf(sheet.partName)).values()) {
        if (!partName.startsWith('xl/tables/')) continue
        tableParts.add(partName)
        owned.push(partName)
      }
      if (owned.length > 0) tablePartsBySheet.set(sheet.name, owned)
    }

    const content = readOoxmlParts(context.bytes, {
      path: context.relativePath,
      limits: context.limits,
      signal: context.signal,
      accept: name => sheetPartNames.has(name) || sheetRelsNames.has(name) || tableParts.has(name),
    })
    diagnostics.push(...content.diagnostics)

    const tableNamesBySheet = readTableNames(tablePartsBySheet, content, context.relativePath, diagnostics)

    // ── 逐 sheet 解析 ──
    const results: SheetResult[] = []
    let rowsRead = 0
    let truncated = false
    for (const sheet of selection.toRead) {
      if (context.signal.aborted) {
        throw new DocumentParseError(DOCUMENT_DIAGNOSTIC_CODES.aborted, 'Excel 解析被取消。')
      }
      const xml = partText(content.parts, sheet.partName)
      if (xml === undefined) {
        diagnostics.push(diagnostic(
          DOCUMENT_DIAGNOSTIC_CODES.structuredParseFailed,
          'warning',
          `sheet「${sheet.name}」的部件 ${sheet.partName} 在压缩包内不存在，已跳过。`,
          context.relativePath,
        ))
        continue
      }
      const result = parseSheet({
        name: sheet.name,
        xml,
        path: context.relativePath,
        styles,
        sharedStrings,
        date1904: workbook.date1904,
        limits: context.limits,
        tableNames: tableNamesBySheet.get(sheet.name) ?? [],
      })
      diagnostics.push(...result.diagnostics)
      rowsRead += result.rows
      if (result.truncated) truncated = true
      results.push(result)
    }

    const tables = request.includeTables === false
      ? []
      : results.flatMap(result => (result.table === undefined ? [] : [result.table]))

    const metadata = request.includeMetadata === false
      ? {}
      : xlsxMetadata(workbook, results, selection, structure, context.relativePath, diagnostics)

    // sheet 名 + 表名进 section：让"工作簿里有哪些 sheet"本身成为可检索的知识，
    // 否则一份只含数据的 xlsx 在知识库里只剩下表格行，丢失了它属于哪张表。
    const sections = buildSections(results, selection, context.relativePath)

    const plainText = sections.map(section => section.text).join('\n\n')
    const empty = tables.length === 0 && sections.every(section => section.text.trim() === '')

    return {
      status: empty ? 'partial' : 'parsed',
      format: 'xlsx',
      fileName: context.relativePath.split('/').pop() ?? context.relativePath,
      mediaType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      sha256: context.sha256,
      sheetNames: sheets.map(sheet => sheet.name),
      sections,
      tables,
      metadata,
      plainText,
      // 有意不提供 rawSource：sheet XML 是机器结构，回给模型只会挤占上下文（§5.6.8）。
      diagnostics,
      confidence: 'structure-preserved',
      limits: {
        truncated,
        sheetsRead: results.length,
        rowsRead,
        bytesRead: context.bytes.byteLength,
        uncompressedBytes: structure.uncompressedBytes + content.uncompressedBytes,
      },
    }
  }
}

/**
 * 第一趟白名单：只取工作簿结构与属性，**不含任何 sheet 数据部件**。
 *
 * 但必须包含 sheet 自己的关系文件（`xl/worksheets/_rels/sheetN.xml.rels`）：
 * 表格定义（`xl/tables/*.xml`）归属于哪张 sheet **只能**由该 sheet 的 rels 决定，
 * 而 rels 是决定"第二趟要读哪些 table 部件"的前提。漏掉它的后果不是报错，而是
 * `tableDefinitions` 永远为空——表格名静默丢失。
 *
 * 这不削弱"未选中的 sheet 字节从不被解压"：rels 是几十字节的清单，不是 sheet 数据。
 */
function isStructurePart(name: string): boolean {
  return name === CONTENT_TYPES_PART
    || name === WORKBOOK_PART
    || name === WORKBOOK_RELS_PART
    || name === SHARED_STRINGS_PART
    || name === STYLES_PART
    || /^docProps\/(core|app)\.xml$/.test(name)
    || /^xl\/worksheets\/_rels\/[^/]+\.rels$/.test(name)
}

/** sheet 部件对应的关系文件：`xl/worksheets/sheet1.xml` → `xl/worksheets/_rels/sheet1.xml.rels`。 */
function relsPartFor(partName: string): string {
  return `${dirnameOf(partName)}/_rels/${partName.slice(partName.lastIndexOf('/') + 1)}.rels`
}

function dirnameOf(partName: string): string {
  const slash = partName.lastIndexOf('/')
  return slash < 0 ? '' : partName.slice(0, slash)
}

/** 结构校验：靠必需部件判断归档是否可用（截断的 ZIP 不会自己报错，见 ADR-0001 §6）。 */
function assertIsWorkbook(parts: OoxmlParts, path: string): void {
  const contentTypes = partText(parts.parts, CONTENT_TYPES_PART)
  if (contentTypes === undefined) {
    throw new DocumentParseError(
      DOCUMENT_DIAGNOSTIC_CODES.structuredParseFailed,
      '压缩包内缺少 [Content_Types].xml，不是有效的 OOXML 文档（可能已损坏）。',
      path,
    )
  }
  if (contentTypes.includes(DOCX_MAIN_CONTENT_TYPE) && !contentTypes.includes(XLSX_MAIN_CONTENT_TYPE)) {
    throw new DocumentParseError(
      DOCUMENT_DIAGNOSTIC_CODES.formatMismatch,
      '文件内容实际是 Word 文档（wordprocessingml），与扩展名 .xlsx 不符；请以内容为准改用 .docx 导入。',
      path,
    )
  }
  if (!contentTypes.includes(XLSX_MAIN_CONTENT_TYPE)) {
    throw new DocumentParseError(
      DOCUMENT_DIAGNOSTIC_CODES.structuredParseFailed,
      '压缩包内没有 Excel 主工作簿内容类型（spreadsheetml.sheet.main+xml）。',
      path,
    )
  }
}

// ── 工作簿结构 ───────────────────────────────────────────────────────────────

interface WorkbookInfo {
  readonly date1904: boolean
  readonly sheets: readonly { readonly name: string; readonly sheetId: string; readonly state: string; readonly relationshipId?: string }[]
}

function parseWorkbook(xml: string, path: string, diagnostics: DocumentDiagnostic[]): WorkbookInfo {
  const parsed = parseXml(xml, path)
  diagnostics.push(...parsed.diagnostics)
  if (parsed.root === undefined) {
    throw new DocumentParseError(DOCUMENT_DIAGNOSTIC_CODES.structuredParseFailed, 'workbook.xml 没有根元素。', path)
  }
  const properties = firstChild(parsed.root, 'workbookPr')
  const date1904 = properties !== undefined && isTruthy(attr(properties, 'date1904'))

  const container = firstChild(parsed.root, 'sheets')
  const sheets = container === undefined ? [] : childrenNamed(container, 'sheet').map(element => ({
    name: attr(element, 'name') ?? '',
    sheetId: attr(element, 'sheetId') ?? '',
    state: (attr(element, 'state') ?? 'visible').toLocaleLowerCase(),
    ...(attr(element, 'id') === undefined ? {} : { relationshipId: attr(element, 'id')! }),
  }))
  if (sheets.length === 0) {
    diagnostics.push(diagnostic(
      DOCUMENT_DIAGNOSTIC_CODES.emptyContent,
      'warning',
      'workbook.xml 里没有声明任何 sheet。',
      path,
    ))
  }
  return { date1904, sheets }
}

/** `xl/_rels/workbook.xml.rels`：`rId` → sheet 部件名。 */
function parseWorkbookRelationships(
  parts: OoxmlParts,
  path: string,
  diagnostics: DocumentDiagnostic[],
): ReadonlyMap<string, string> {
  const xml = partText(parts.parts, WORKBOOK_RELS_PART)
  if (xml === undefined) return new Map()
  const parsed = parseRelationships(xml, path)
  diagnostics.push(...parsed.diagnostics)
  // base 为 `xl/`：workbook.xml.rels 里的相对 Target 是相对 xl/ 的。
  return resolveRelationshipTargets(parsed.relationships, 'xl')
}

interface SheetRef {
  readonly name: string
  readonly sheetId: string
  readonly hidden: boolean
  readonly partName: string
}

/**
 * 把 sheet 名与部件名对上。
 *
 * 必须走关系表而不是"sheetN.xml 按顺序对应"——删除或重排 sheet 之后文件编号与
 * 显示顺序不再一致，按编号猜会把数据读串。
 */
function resolveSheets(
  workbook: WorkbookInfo,
  relationships: ReadonlyMap<string, string>,
  path: string,
  diagnostics: DocumentDiagnostic[],
): readonly SheetRef[] {
  const sheets: SheetRef[] = []
  for (const sheet of workbook.sheets) {
    if (sheet.relationshipId === undefined) {
      diagnostics.push(diagnostic(
        DOCUMENT_DIAGNOSTIC_CODES.structuredParseFailed,
        'warning',
        `sheet「${sheet.name}」没有 r:id，无法定位它的 XML 部件，已跳过。`,
        path,
      ))
      continue
    }
    const partName = relationships.get(sheet.relationshipId)
    if (partName === undefined) {
      diagnostics.push(diagnostic(
        DOCUMENT_DIAGNOSTIC_CODES.structuredParseFailed,
        'warning',
        `sheet「${sheet.name}」的关系 ${sheet.relationshipId} 在 workbook.xml.rels 里没有目标，已跳过。`,
        path,
      ))
      continue
    }
    sheets.push({
      name: sheet.name,
      sheetId: sheet.sheetId,
      hidden: sheet.state === 'hidden' || sheet.state === 'veryhidden',
      partName,
    })
  }
  return sheets
}

interface SheetSelection {
  readonly toRead: readonly SheetRef[]
  readonly skippedHidden: readonly SheetRef[]
}

/**
 * 选出本次要读的 sheet。
 *
 * 规则（§5.6.5 C）：
 * - 默认只读可见 sheet；隐藏 sheet 被跳过并给 `HIDDEN_SHEET_SKIPPED` warning；
 * - `includeHiddenSheets: true` 才读隐藏 sheet；
 * - 给了 `sheetNames` 时按名字精确筛选，名字不存在只警告不报错。
 */
function selectSheets(
  sheets: readonly SheetRef[],
  request: DocumentParseRequest,
  path: string,
  diagnostics: DocumentDiagnostic[],
): SheetSelection {
  const includeHidden = request.includeHiddenSheets === true
  const requested = request.sheetNames?.filter(name => name.trim() !== '') ?? []

  let candidates = sheets
  if (requested.length > 0) {
    const wanted = new Set(requested)
    const missing = requested.filter(name => !sheets.some(sheet => sheet.name === name))
    if (missing.length > 0) {
      diagnostics.push(diagnostic(
        DOCUMENT_DIAGNOSTIC_CODES.structuredParseFailed,
        'warning',
        `请求的 sheet 不存在，已忽略：${missing.join(', ')}；工作簿实际含 ${sheets.map(sheet => sheet.name).join(', ')}。`,
        path,
      ))
    }
    candidates = sheets.filter(sheet => wanted.has(sheet.name))
  }

  const skippedHidden = includeHidden ? [] : candidates.filter(sheet => sheet.hidden)
  if (skippedHidden.length > 0) {
    diagnostics.push(diagnostic(
      DOCUMENT_DIAGNOSTIC_CODES.hiddenSheetSkipped,
      'warning',
      `已跳过 ${skippedHidden.length} 个隐藏 sheet（${skippedHidden.map(sheet => sheet.name).join(', ')}）：`
      + '默认不读取隐藏 sheet，以免把过程数据或废弃内容当业务事实；如确需读取请显式传 includeHiddenSheets=true。',
      path,
    ))
  }
  return { toRead: candidates.filter(sheet => includeHidden || !sheet.hidden), skippedHidden }
}

// ── sharedStrings / styles ───────────────────────────────────────────────────

/** 共享字符串表：`<si>` 的序号即 `<c t="s"><v>序号</v>` 里的值。 */
function parseSharedStrings(
  xml: string | undefined,
  path: string,
  diagnostics: DocumentDiagnostic[],
): readonly string[] {
  if (xml === undefined) return []
  const parsed = parseXml(xml, path)
  diagnostics.push(...parsed.diagnostics)
  if (parsed.root === undefined) return []
  // `textOf` 会把 `<r><t>a</t></r><r><t>b</t></r>`（富文本分段）拼回 "ab"。
  return childrenNamed(parsed.root, 'si').map(element => textOf(element))
}

/** 日期/时间类数字格式。判定结果决定序列号如何转成可读值。 */
type DateKind = 'date' | 'datetime' | 'time'

interface StylesInfo {
  /** `cellXfs` 的序号即单元格 `s` 属性；值是该格式的 numFmtId。 */
  readonly cellXfs: readonly number[]
  /** 自定义格式码：numFmtId → formatCode。 */
  readonly customFormats: ReadonlyMap<number, string>
}

function parseStyles(
  xml: string | undefined,
  path: string,
  diagnostics: DocumentDiagnostic[],
): StylesInfo {
  if (xml === undefined) return { cellXfs: [], customFormats: new Map() }
  const parsed = parseXml(xml, path)
  diagnostics.push(...parsed.diagnostics)
  if (parsed.root === undefined) return { cellXfs: [], customFormats: new Map() }

  const customFormats = new Map<number, string>()
  const formats = firstChild(parsed.root, 'numFmts')
  if (formats !== undefined) {
    for (const format of childrenNamed(formats, 'numFmt')) {
      const id = integerOrUndefined(attr(format, 'numFmtId'))
      const code = attr(format, 'formatCode')
      if (id !== undefined && code !== undefined) customFormats.set(id, code)
    }
  }

  const cellXfs: number[] = []
  const container = firstChild(parsed.root, 'cellXfs')
  if (container !== undefined) {
    for (const xf of childrenNamed(container, 'xf')) {
      cellXfs.push(integerOrUndefined(attr(xf, 'numFmtId')) ?? 0)
    }
  }
  return { cellXfs, customFormats }
}

/**
 * 内置日期/时间格式 id（ECMA-376 第 18.8.30 节）。
 *
 * 只收录**确定是日期/时间**的 id。`m` 在 Excel 格式码里既可能是月也可能是分钟，
 * 因此自定义格式码靠 `y`/`d`/`h`/`s` 判定，只有单独一个 `m` 时不猜。
 */
const BUILTIN_DATE_KINDS: ReadonlyMap<number, DateKind> = new Map([
  [14, 'date'], [15, 'date'], [16, 'date'], [17, 'date'],
  [18, 'time'], [19, 'time'], [20, 'time'], [21, 'time'],
  [22, 'datetime'],
  [45, 'time'], [46, 'time'], [47, 'time'],
])

function dateKindFor(numFmtId: number, styles: StylesInfo): DateKind | undefined {
  const builtin = BUILTIN_DATE_KINDS.get(numFmtId)
  if (builtin !== undefined) return builtin
  const code = styles.customFormats.get(numFmtId)
  if (code === undefined) return undefined
  // 去掉引号里的字面量与颜色/条件段，避免把 "年" 之类的文字当成日期记号。
  const stripped = code.replace(/"[^"]*"/g, '').replace(/\[[^\]]*\]/g, '').replace(/\\./g, '')
  const hasDate = /[yd]/i.test(stripped)
  const hasTime = /[hs]/i.test(stripped)
  if (hasDate && hasTime) return 'datetime'
  if (hasDate) return 'date'
  if (hasTime) return 'time'
  return undefined
}

// ── sheet 解析 ───────────────────────────────────────────────────────────────

interface ParseSheetInput {
  readonly name: string
  readonly xml: string
  readonly path: string
  readonly styles: StylesInfo
  readonly sharedStrings: readonly string[]
  readonly date1904: boolean
  readonly limits: DocumentParserContext['limits']
  readonly tableNames: readonly string[]
}

/** 一个已定位的单元格。 */
interface LocatedCell {
  readonly row: number
  readonly column: number
  readonly display: string
  readonly type: CellValueType
  readonly formula?: string
  readonly hasFormula: boolean
  readonly hasCachedValue: boolean
}

function parseSheet(input: ParseSheetInput): SheetResult {
  const diagnostics: DocumentDiagnostic[] = []
  const parsed = parseXml(input.xml, input.path)
  diagnostics.push(...parsed.diagnostics)
  const root = parsed.root
  if (root === undefined) {
    throw new DocumentParseError(
      DOCUMENT_DIAGNOSTIC_CODES.structuredParseFailed,
      `sheet「${input.name}」的 XML 没有根元素。`,
      input.path,
    )
  }

  const mergeRanges = readMergeRanges(root)
  const autoFilter = readAutoFilter(root)
  const frozenPane = readFrozenPane(root)
  const cells: LocatedCell[] = []
  let truncated = false
  let formulaMissingCache = 0
  const formulas: string[] = []

  const sheetData = firstChild(root, 'sheetData')
  let fallbackRow = 0
  let cellBudget = input.limits.maxCellsPerSheet

  if (sheetData !== undefined) {
    for (const rowElement of childrenNamed(sheetData, 'row')) {
      const declaredRow = integerOrUndefined(attr(rowElement, 'r'))
      const rowIndex = declaredRow ?? fallbackRow + 1
      fallbackRow = rowIndex

      if (rowIndex > input.limits.maxRowsPerSheet) {
        truncated = true
        break
      }

      let fallbackColumn = 0
      for (const cellElement of childrenNamed(rowElement, 'c')) {
        const reference = attr(cellElement, 'r')
        const position = reference === undefined ? undefined : parseCellReference(reference)
        const row = position?.row ?? rowIndex
        const column = position?.column ?? fallbackColumn + 1
        fallbackColumn = column

        if (row > input.limits.maxRowsPerSheet || column > input.limits.maxColumnsPerSheet) {
          truncated = true
          continue
        }
        if (cellBudget <= 0) {
          truncated = true
          continue
        }
        cellBudget -= 1

        const styleIndex = integerOrUndefined(attr(cellElement, 's'))
        const numFmtId = styleIndex === undefined ? 0 : (input.styles.cellXfs[styleIndex] ?? 0)
        const decoded = decodeCell(cellElement, attr(cellElement, 't'), numFmtId, input)

        // 公式文本一律保留（§5.6.5 C「同时可保留公式文本」），与有无缓存值无关。
        if (decoded.hasFormula && decoded.formula !== undefined && decoded.formula !== '') {
          formulas.push(`${input.name}!${reference ?? `${columnLetter(column)}${row}`}=${decoded.formula}`)
        }

        if (decoded.hasFormula && !decoded.hasCachedValue) {
          formulaMissingCache += 1
          // 绝不自行计算（§5.6.5 C）：按空值处理并让诊断说明原因。
          cells.push({
            row,
            column,
            display: '',
            type: 'empty',
            hasFormula: true,
            hasCachedValue: false,
            ...(decoded.formula === undefined ? {} : { formula: decoded.formula }),
          })
          continue
        }
        if (decoded.type === 'empty' && decoded.display === '') continue
        cells.push({
          row,
          column,
          display: decoded.display,
          type: decoded.type,
          hasFormula: decoded.hasFormula,
          hasCachedValue: decoded.hasCachedValue,
          ...(decoded.formula === undefined ? {} : { formula: decoded.formula }),
        })
      }
    }
  }

  if (truncated) {
    diagnostics.push(diagnostic(
      DOCUMENT_DIAGNOSTIC_CODES.truncated,
      'warning',
      `sheet「${input.name}」超出解析上限（行 ${input.limits.maxRowsPerSheet} / 列 ${input.limits.maxColumnsPerSheet} / `
      + `单元格 ${input.limits.maxCellsPerSheet}），结果已截断。`,
      input.path,
    ))
  }
  if (formulaMissingCache > 0) {
    diagnostics.push(diagnostic(
      DOCUMENT_DIAGNOSTIC_CODES.formulaValueUnavailable,
      'warning',
      `sheet「${input.name}」有 ${formulaMissingCache} 个公式单元格没有缓存计算值：这些单元格按空值处理，`
      + '本解析器不会自行计算公式（否则会把推断结果伪装成 Excel 的计算结果）。',
      input.path,
    ))
  }
  if (mergeRanges.length > 0) {
    diagnostics.push(diagnostic(
      DOCUMENT_DIAGNOSTIC_CODES.mergedCells,
      'warning',
      `sheet「${input.name}」含 ${mergeRanges.length} 处合并单元格（${mergeRanges.slice(0, 20).join(', ')}`
      + `${mergeRanges.length > 20 ? ' …' : ''}）：只有左上角单元格有值，其余位置为空。`,
      input.path,
    ))
  }

  const built = buildSheetTable({ cells, name: input.name, path: input.path, mergeRanges })

  return {
    name: input.name,
    ...(built === undefined ? {} : { table: built.table }),
    diagnostics,
    truncated,
    rows: built?.rows ?? 0,
    columns: built?.columns ?? 0,
    cellCount: cells.length,
    formulas: formulas.slice(0, 50),
    formulaMissingCache,
    mergedCells: mergeRanges,
    ...(autoFilter === undefined ? {} : { autoFilter }),
    ...(frozenPane === undefined ? {} : { frozenPane }),
    tableNames: input.tableNames,
  }
}

interface DecodedCell {
  readonly display: string
  readonly type: CellValueType
  readonly formula?: string
  readonly hasFormula: boolean
  readonly hasCachedValue: boolean
}

/**
 * 解码一个 `<c>`。
 *
 * 类型判定顺序遵循 ECMA-376：`t` 属性决定值的解释方式；`t` 缺省或 `n` 是数字，
 * 数字再按 `numFmtId` 细分是否日期/时间。**公式单元格读 `<v>` 缓存值**，
 * 没有缓存值时不猜。
 */
function decodeCell(
  cell: XmlElement,
  type: string | undefined,
  numFmtId: number,
  input: ParseSheetInput,
): DecodedCell {
  const formulaElement = firstChild(cell, 'f')
  const formula = formulaElement === undefined ? undefined : textOf(formulaElement)
  const hasFormula = formulaElement !== undefined

  if (type === 'inlineStr') {
    const inline = firstChild(cell, 'is')
    const text = inline === undefined ? '' : textOf(inline)
    return { display: text, type: 'string', hasFormula, hasCachedValue: text !== '', ...(formula === undefined ? {} : { formula }) }
  }

  const valueElement = firstChild(cell, 'v')
  const raw = valueElement === undefined ? undefined : textOf(valueElement)
  const hasCachedValue = raw !== undefined

  if (type === 's') {
    const index = raw === undefined ? undefined : integerOrUndefined(raw)
    const text = index === undefined ? '' : (input.sharedStrings[index] ?? '')
    if (raw !== undefined && text === '') {
      return { display: '', type: 'empty', hasFormula, hasCachedValue: true, ...(formula === undefined ? {} : { formula }) }
    }
    return { display: text, type: 'string', hasFormula, hasCachedValue, ...(formula === undefined ? {} : { formula }) }
  }

  if (type === 'str') {
    // 公式的字符串结果（`t="str"`）：缓存值就是字符串本身。
    return { display: raw ?? '', type: raw === undefined ? 'empty' : 'string', hasFormula, hasCachedValue, ...(formula === undefined ? {} : { formula }) }
  }

  if (type === 'b') {
    const truthy = raw === '1' || raw?.toLocaleLowerCase() === 'true'
    return { display: raw === undefined ? '' : (truthy ? 'TRUE' : 'FALSE'), type: raw === undefined ? 'empty' : 'boolean', hasFormula, hasCachedValue, ...(formula === undefined ? {} : { formula }) }
  }

  if (type === 'e') {
    return { display: raw ?? '', type: raw === undefined ? 'empty' : 'error', hasFormula, hasCachedValue, ...(formula === undefined ? {} : { formula }) }
  }

  if (type === 'd') {
    // ISO 8601 日期字符串（少见的 `t="d"`）。
    return { display: raw ?? '', type: raw === undefined ? 'empty' : 'datetime', hasFormula, hasCachedValue, ...(formula === undefined ? {} : { formula }) }
  }

  // `t` 缺省或 `n`：数字。可能被格式化成日期/时间。
  if (raw === undefined) {
    return { display: '', type: 'empty', hasFormula, hasCachedValue: false, ...(formula === undefined ? {} : { formula }) }
  }
  const numeric = Number(raw)
  if (!Number.isFinite(numeric)) {
    // 数字格式却存着非数字：按字符串保留，不丢内容。
    return { display: raw, type: 'string', hasFormula, hasCachedValue, ...(formula === undefined ? {} : { formula }) }
  }
  const kind = dateKindFor(numFmtId, input.styles)
  if (kind !== undefined) {
    return { display: formatSerial(numeric, kind, input.date1904), type: kind, hasFormula, hasCachedValue, ...(formula === undefined ? {} : { formula }) }
  }
  return { display: raw, type: 'number', hasFormula, hasCachedValue, ...(formula === undefined ? {} : { formula }) }
}

interface BuildTableInput {
  readonly cells: readonly LocatedCell[]
  readonly name: string
  readonly path: string
  readonly mergeRanges: readonly string[]
}

interface BuiltSheetTable {
  readonly table: ParsedTable
  readonly rows: number
  readonly columns: number
}

/**
 * 把定位好的单元格摆回网格。
 *
 * 空行策略固定为「**表格内部空行保留，尾部空行裁剪**」（§5.6.5 C）：
 * 网格按坐标填充，因此内部空行天然存在；行号的最大值就是有效区域的下界，
 * 因此尾部空行天然被裁掉。这正是 Excel 自己"已用区域"的定义。
 */
function buildSheetTable(input: BuildTableInput): BuiltSheetTable | undefined {
  if (input.cells.length === 0) return undefined

  let maxRow = 0
  let maxColumn = 0
  for (const cell of input.cells) {
    if (cell.row > maxRow) maxRow = cell.row
    if (cell.column > maxColumn) maxColumn = cell.column
  }

  const grid: string[][] = []
  const types: CellValueType[][] = []
  for (let row = 1; row <= maxRow; row += 1) {
    grid.push(Array.from({ length: maxColumn }, () => ''))
    types.push(Array.from({ length: maxColumn }, (): CellValueType => 'empty'))
  }
  for (const cell of input.cells) {
    grid[cell.row - 1]![cell.column - 1] = cell.display
    types[cell.row - 1]![cell.column - 1] = cell.type
  }

  // 表头推断：第一个非空行。首行全空时把它当表头会得到一串"列N"。
  const headerIndex = grid.findIndex(row => row.some(cell => cell.trim() !== ''))
  const headerRow = headerIndex < 0 ? [] : grid[headerIndex]!
  const headerTypes = headerIndex < 0 ? [] : types[headerIndex]!
  const bodyRows = headerIndex < 0 ? [] : grid.slice(headerIndex + 1)
  const bodyTypes = headerIndex < 0 ? [] : types.slice(headerIndex + 1)

  const range = `A1:${columnLetter(maxColumn)}${maxRow}`
  const sheetName = quoteSheetName(input.name)
  const fragment = `sheet=${sheetName}!${range}`

  return {
    table: {
      id: `table-${input.name}`,
      title: input.name,
      sheet: input.name,
      headers: headerRow.map((cell, index) => (cell.trim() === '' ? `列${index + 1}` : cell)),
      rows: bodyRows,
      rowRefs: bodyRows.map((_row, index) => sourceRef(input.path, `sheet=${sheetName}!${rowRange(index + headerIndex + 2, maxColumn)}`)),
      sourceRef: sourceRef(input.path, fragment),
      cellTypes: bodyTypes,
      headerTypes,
    },
    rows: maxRow,
    columns: maxColumn,
  }
}

function rowRange(row: number, columns: number): string {
  return `A${row}:${columnLetter(columns)}${row}`
}

/**
 * sheet 名的引用形式。
 *
 * 含空格或特殊字符时 Excel 用单引号包裹（`'接口 需求'!A1`），并且内部的单引号要
 * 写成两个。sourceRef 要能被回读到原文件，所以这里必须照 Excel 的规则来。
 */
function quoteSheetName(name: string): string {
  if (/^[A-Za-z_\u4e00-\u9fff][A-Za-z0-9_.\u4e00-\u9fff]*$/.test(name)) return name
  return `'${name.replace(/'/g, "''")}'`
}

/** 列序号 → 字母（1 → A，26 → Z，27 → AA）。 */
function columnLetter(index: number): string {
  let value = index - 1
  let out = ''
  while (value >= 0) {
    out = String.fromCharCode(65 + (value % 26)) + out
    value = Math.floor(value / 26) - 1
  }
  return out
}

/** 解析 `AB12` → `{ row: 12, column: 28 }`；非法返回 undefined。 */
function parseCellReference(reference: string): { readonly row: number; readonly column: number } | undefined {
  const match = /^\$?([A-Za-z]{1,3})\$?(\d{1,7})$/.exec(reference.trim())
  if (match === null) return undefined
  const letters = match[1]!.toLocaleUpperCase()
  const row = Number.parseInt(match[2]!, 10)
  if (!Number.isSafeInteger(row) || row < 1) return undefined
  let column = 0
  for (let index = 0; index < letters.length; index += 1) {
    column = column * 26 + (letters.charCodeAt(index) - 64)
  }
  return { row, column }
}

// ── sheet 元数据（合并/筛选/冻结/表格名）────────────────────────────────────

function readMergeRanges(root: XmlElement): readonly string[] {
  const container = firstChild(root, 'mergeCells')
  if (container === undefined) return []
  const ranges: string[] = []
  for (const merge of childrenNamed(container, 'mergeCell')) {
    const ref = attr(merge, 'ref')
    if (ref !== undefined && ref.trim() !== '') ranges.push(ref.trim())
  }
  return ranges
}

function readAutoFilter(root: XmlElement): string | undefined {
  const filter = firstChild(root, 'autoFilter')
  const ref = filter === undefined ? undefined : attr(filter, 'ref')
  return ref === undefined || ref.trim() === '' ? undefined : ref.trim()
}

/** 冻结窗格：`<pane xSplit ySplit topLeftCell state="frozen"/>` → `topLeftCell`。 */
function readFrozenPane(root: XmlElement): string | undefined {
  const view = dig(root, 'sheetViews', 'sheetView')
  if (view === undefined) return undefined
  const pane = firstChild(view, 'pane')
  if (pane === undefined) return undefined
  const state = (attr(pane, 'state') ?? '').toLocaleLowerCase()
  if (state !== 'frozen' && state !== 'frozenSplit') return undefined
  return attr(pane, 'topLeftCell') ?? `${attr(pane, 'xSplit') ?? '0'},${attr(pane, 'ySplit') ?? '0'}`
}

/** 表格定义（`xl/tables/*.xml`）：按 sheet 归属读出 `displayName` + `ref`。 */
function readTableNames(
  partsBySheet: ReadonlyMap<string, readonly string[]>,
  content: OoxmlParts,
  path: string,
  diagnostics: DocumentDiagnostic[],
): ReadonlyMap<string, readonly string[]> {
  const bySheet = new Map<string, string[]>()
  for (const [sheetName, partNames] of partsBySheet) {
    const labels: string[] = []
    for (const partName of partNames) {
      const xml = partText(content.parts, partName)
      if (xml === undefined) continue
      const parsed = parseXml(xml, path)
      diagnostics.push(...parsed.diagnostics)
      if (parsed.root === undefined) continue
      const name = attr(parsed.root, 'displayName') ?? attr(parsed.root, 'name')
      if (name === undefined) continue
      const ref = attr(parsed.root, 'ref')
      labels.push(ref === undefined ? name : `${name}(${ref})`)
    }
    if (labels.length > 0) bySheet.set(sheetName, labels)
  }
  return bySheet
}

// ── 章节与 metadata ──────────────────────────────────────────────────────────

/**
 * 把 sheet 摘要做成 section。
 *
 * 目的不是重复表格数据，而是让"这份工作簿有哪些 sheet、各多大、有什么表"成为
 * 可检索的知识——否则一份纯数据 xlsx 进知识库后只剩下表格行，丢失归属信息。
 */
function buildSections(
  results: readonly SheetResult[],
  selection: SheetSelection,
  path: string,
): readonly ParsedSection[] {
  const sections: ParsedSection[] = []
  for (const result of results) {
    const lines = [
      `sheet「${result.name}」：有效区域 ${result.rows} 行 × ${result.columns} 列，共 ${result.cellCount} 个非空单元格。`,
    ]
    if (result.tableNames.length > 0) lines.push(`表格定义：${result.tableNames.join('、')}`)
    if (result.autoFilter !== undefined) lines.push(`自动筛选范围：${result.autoFilter}`)
    if (result.frozenPane !== undefined) lines.push(`冻结窗格：${result.frozenPane}`)
    if (result.mergedCells.length > 0) lines.push(`合并单元格：${result.mergedCells.join(', ')}`)
    if (result.formulaMissingCache > 0) lines.push(`无缓存值的公式单元格：${result.formulaMissingCache} 个`)
    sections.push({
      id: `section-${sections.length + 1}`,
      title: `sheet: ${result.name}`,
      order: sections.length,
      text: lines.join('\n'),
      sheet: result.name,
      sourceRef: sourceRef(path, `sheet=${quoteSheetName(result.name)}`),
    })
  }
  if (selection.skippedHidden.length > 0) {
    sections.push({
      id: `section-${sections.length + 1}`,
      title: '跳过的隐藏 sheet',
      order: sections.length,
      text: `本次未读取的隐藏 sheet：${selection.skippedHidden.map(sheet => sheet.name).join(', ')}`,
      sourceRef: sourceRef(path, 'sheet=#hidden'),
    })
  }
  return sections
}

function xlsxMetadata(
  workbook: WorkbookInfo,
  results: readonly SheetResult[],
  selection: SheetSelection,
  structure: OoxmlParts,
  path: string,
  diagnostics: DocumentDiagnostic[],
): Readonly<Record<string, string | number | boolean | null>> {
  const metadata: Record<string, string | number | boolean | null> = {
    sheetCount: workbook.sheets.length,
    sheetsRead: results.length,
    date1904: workbook.date1904,
    sheetNames: workbook.sheets.map(sheet => sheet.name).join(', '),
  }
  if (selection.skippedHidden.length > 0) {
    metadata.hiddenSheetsSkipped = selection.skippedHidden.map(sheet => sheet.name).join(', ')
  }
  const dimensions = results
    .filter(result => result.rows > 0)
    .map(result => `${result.name}!A1:${columnLetter(result.columns)}${result.rows}`)
  if (dimensions.length > 0) metadata.sheetDimensions = dimensions.join('; ')

  const merged = results.flatMap(result => result.mergedCells.map(range => `${result.name}!${range}`))
  if (merged.length > 0) {
    metadata.mergedCells = merged.slice(0, 200).join(', ')
    metadata.mergedCellCount = merged.length
  }
  const filters = results
    .filter(result => result.autoFilter !== undefined)
    .map(result => `${result.name}!${result.autoFilter}`)
  if (filters.length > 0) metadata.autoFilters = filters.join('; ')

  const panes = results
    .filter(result => result.frozenPane !== undefined)
    .map(result => `${result.name}=${result.frozenPane}`)
  if (panes.length > 0) metadata.frozenPanes = panes.join('; ')

  const tables = results.flatMap(result => result.tableNames.map(name => `${result.name}: ${name}`))
  if (tables.length > 0) metadata.tableDefinitions = tables.join('; ')

  // 公式文本单独保留：§5.6.5 C 要求"公式默认读取缓存计算值，**同时可保留公式文本**"。
  const formulas = results.flatMap(result => result.formulas)
  if (formulas.length > 0) metadata.formulaCells = formulas.slice(0, 100).join('; ')
  const missing = results.reduce((sum, result) => sum + result.formulaMissingCache, 0)
  if (missing > 0) metadata.formulaCellsWithoutCache = missing

  // 文档属性（标题/作者）：与 DOCX 保持一致，取的是文档**自己声明**的值。
  const core = partText(structure.parts, 'docProps/core.xml')
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
  const app = partText(structure.parts, 'docProps/app.xml')
  if (app !== undefined) {
    const parsed = parseXml(app, path)
    diagnostics.push(...parsed.diagnostics)
    if (parsed.root !== undefined) copyText(parsed.root, 'Company', metadata, 'company')
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
  const element = firstChild(root, localName)
  if (element === undefined) return
  let value = ''
  for (const child of element.children) {
    if (child.kind === 'text') value += child.value
  }
  const trimmed = value.trim()
  if (trimmed !== '') into[key] = trimmed
}

/** 只接受十进制整数字符串；其余返回 undefined（不猜）。 */
function integerOrUndefined(value: string | undefined): number | undefined {
  if (value === undefined || !/^-?\d+$/.test(value.trim())) return undefined
  const parsed = Number.parseInt(value.trim(), 10)
  return Number.isSafeInteger(parsed) ? parsed : undefined
}

function isTruthy(value: string | undefined): boolean {
  if (value === undefined) return false
  const normalized = value.trim().toLocaleLowerCase()
  return normalized === '1' || normalized === 'true' || normalized === 'on'
}

/**
 * Excel 序列号 → 可读日期/时间。
 *
 * 1900 系统的起点是 1899-12-31，但 Excel 为兼容 Lotus 1-2-3 把 1900 当闰年，
 * 于是序列号 60 对应一个不存在的 1900-02-29。因此 60 之后要减 1 才是真实天数；
 * 序列号 60 本身按 1900-02-28 处理（不伪造一个不存在的日期）。
 */
function formatSerial(serial: number, kind: DateKind, date1904: boolean): string {
  const epoch = date1904 ? Date.UTC(1904, 0, 1) : Date.UTC(1899, 11, 31)
  const adjusted = date1904 ? serial : (serial >= 60 ? serial - 1 : serial)
  const milliseconds = epoch + Math.round(adjusted * 86_400_000)
  const date = new Date(milliseconds)

  const year = date.getUTCFullYear()
  const month = `${date.getUTCMonth() + 1}`.padStart(2, '0')
  const day = `${date.getUTCDate()}`.padStart(2, '0')
  const hour = `${date.getUTCHours()}`.padStart(2, '0')
  const minute = `${date.getUTCMinutes()}`.padStart(2, '0')
  const second = `${date.getUTCSeconds()}`.padStart(2, '0')

  if (kind === 'date') return `${year}-${month}-${day}`
  if (kind === 'time') return `${hour}:${minute}:${second}`
  // datetime：整点省略时间部分，避免给纯日期值硬加 00:00:00。
  return hour === '00' && minute === '00' && second === '00'
    ? `${year}-${month}-${day}`
    : `${year}-${month}-${day} ${hour}:${minute}:${second}`
}
