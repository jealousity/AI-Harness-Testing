/**
 * 文档解析统一中间表示（docs/10 §5.6.4）。
 *
 * 本文件是**唯一**的解析结果契约：`runtime/platform-tools.ts` 的 `parse_doc`、
 * `knowledge-projection.ts` 的知识投影、以及后续 Web 上传入口都只认这一套类型。
 * 因此替换某个格式的解析库不会改动 `PipelineDriver`、机器门禁规则或工具契约
 * （docs/10 §5.6.11 验收第 10 条）。
 *
 * 两条贯穿全部解析器的语义：
 * - **不伪装**：没有真实文本层、没有缓存公式值、格式不支持时返回 `unsupported` /
 *   `partial` / `parse-failed` 并给出诊断码，绝不返回看似成功的空结果；
 * - **可追溯**：每个 section/table 都带 `sourceRef`（`requirements.pdf#page=3`、
 *   `cases.xlsx#sheet=接口!A2:F20`、`guide.md#heading=3.2`），知识条目据此回读。
 *
 * @module platform-pipeline/documents/document-types
 */

/** 平台支持的文档格式（docs/10 §5.6.4）。 */
export type SupportedDocumentFormat =
  | 'pdf' | 'docx' | 'doc' | 'xlsx' | 'xls'
  | 'markdown' | 'text' | 'csv' | 'tsv' | 'yaml' | 'json'

/**
 * 全部受支持格式的**运行时**取值列表。
 *
 * 类型 `SupportedDocumentFormat` 在运行时不存在，而工具 JSON schema 的 enum 与
 * `formatHint` 入参校验都需要一份可枚举清单。放在这里保证清单与类型同源：
 * 新增格式时若忘了同步，`satisfies` 会直接编译失败。
 */
export const SUPPORTED_DOCUMENT_FORMATS = [
  'pdf', 'docx', 'doc', 'xlsx', 'xls',
  'markdown', 'text', 'csv', 'tsv', 'yaml', 'json',
] as const satisfies readonly SupportedDocumentFormat[]

/** `formatHint` 等外部字符串入参的收窄校验。 */
export function isSupportedDocumentFormat(value: unknown): value is SupportedDocumentFormat {
  return typeof value === 'string' && (SUPPORTED_DOCUMENT_FORMATS as readonly string[]).includes(value)
}

/** 解析状态。`partial`/`limit-exceeded` 必须带 diagnostics 与 limits（docs/10 §5.6.4）。 */
export type ParseStatus = 'parsed' | 'partial' | 'unsupported' | 'parse-failed' | 'limit-exceeded'

/**
 * 内容置信度。**默认取最低可信档**：任何经过推断、OCR 或布局重建的结果都不得
 * 被标为 `exact-text`（docs/10 §5.6.7「OCR/布局推断结果默认低置信度」）。
 */
export type ContentConfidence = 'exact-text' | 'structure-preserved' | 'layout-approximate' | 'ocr-derived'

/** 解析请求（docs/10 §5.6.4 / §5.6.6）。 */
export interface DocumentParseRequest {
  /** 相对工作区根的路径（绝对路径与 `..` 由 WorkspaceScope 拦下）。 */
  readonly path: string
  readonly formatHint?: SupportedDocumentFormat
  readonly includeTables?: boolean
  readonly includeMetadata?: boolean
  readonly includeRawSource?: boolean
  /** 只读取指定 sheet（Excel）；缺省读全部可见 sheet。 */
  readonly sheetNames?: readonly string[]
  /** 显式允许读取隐藏 sheet；缺省拒绝并给 warning（docs/10 §5.6.5 C）。 */
  readonly includeHiddenSheets?: boolean
  readonly pageRange?: Readonly<{ from?: number; to?: number }>
}

/** 结构化诊断（docs/10 §5.6.4）。`location` 用 sourceRef 片段，便于页面定位。 */
export interface DocumentDiagnostic {
  readonly code: string
  readonly severity: 'info' | 'warning' | 'error'
  readonly message: string
  readonly location?: string
}

/** 结构化段落/章节。 */
export interface ParsedSection {
  readonly id: string
  readonly title?: string
  readonly level?: number
  readonly order: number
  readonly text: string
  readonly page?: number
  readonly sheet?: string
  readonly sourceRef: string
}

/**
 * 单元格值的**原始类型**（docs/10 §5.6.5 C「单元格值按显示值和原始类型区分」）。
 *
 * 为什么需要它：`rows` 里放的是**显示值**字符串，而显示值会撞车——
 * 一个文本单元格 `2024-01-15` 与一个日期单元格的显示值完全相同。下游若要把日期
 * 当日期用（排序、比较、生成测试数据），只有字符串是无法区分的。
 */
export type ParsedCellType =
  | 'string' | 'number' | 'date' | 'datetime' | 'time'
  | 'boolean' | 'error' | 'empty'

/** 结构化表格。 */
export interface ParsedTable {
  readonly id: string
  readonly title?: string
  readonly headers: readonly string[]
  readonly rows: readonly (readonly string[])[]
  readonly page?: number
  readonly sheet?: string
  readonly sourceRef: string
  readonly truncated?: boolean
  /**
   * 行级 sourceRef，与 `rows` 同序。
   *
   * docs/10 §5.6.4 的 `ParsedTable` 只有表级 `sourceRef`，但 §5.6.7 要求
   * 「表格行必须能追溯到原始 sheet/表格位置」。与其让投影层去反解表级字符串
   * （`#sheet=接口!A2:F20` 里的行号要重新解析，格式一改就静默失效），
   * 不如让解析器直接给出每行的精确位置：Excel 用 `#sheet=接口!A2:F2`，
   * Word/Markdown 用 `#table=2,row=4`。**这是对文档接口的纯增量扩展**，
   * 文档列出的字段一个不少。
   */
  readonly rowRefs?: readonly string[]
  /**
   * 单元格原始类型，与 `rows` 同序同宽（含表头行吗？**不含**——与 `rows` 对齐，
   * 表头类型可由 `headerTypes` 取）。
   *
   * 同为纯增量扩展，依据是 §5.6.5 C 明确要求区分字符串/数字/日期/布尔/错误/空值。
   * 只有 Excel 解析器会填它；文本族与 Word/Markdown 的显示值即真实值，留空。
   */
  readonly cellTypes?: readonly (readonly ParsedCellType[])[]
  /** 表头行的单元格原始类型，与 `headers` 同序。 */
  readonly headerTypes?: readonly ParsedCellType[]
}

/** 解析结果的资源使用事实（docs/10 §5.6.4）。 */
export interface ParsedDocumentLimits {
  readonly truncated: boolean
  readonly pagesRead?: number
  readonly sheetsRead?: number
  readonly rowsRead?: number
  readonly bytesRead?: number
  /** 解压后的总字节数（Office 文档；用于暴露 zip bomb 风险）。 */
  readonly uncompressedBytes?: number
}

/** 解析结果（docs/10 §5.6.4）。 */
export interface ParsedDocument {
  readonly status: ParseStatus
  readonly format: SupportedDocumentFormat | 'unknown'
  readonly fileName: string
  readonly mediaType?: string
  readonly sha256: string
  readonly pageCount?: number
  readonly sheetNames?: readonly string[]
  readonly sections: readonly ParsedSection[]
  readonly tables: readonly ParsedTable[]
  readonly metadata: Readonly<Record<string, string | number | boolean | null>>
  readonly plainText: string
  readonly rawSource?: string
  readonly diagnostics: readonly DocumentDiagnostic[]
  readonly confidence: ContentConfidence
  readonly limits: ParsedDocumentLimits
}

/**
 * 单个格式的解析器（docs/10 §5.6.4）。
 *
 * 实现约定：
 * - **只读**：不得写原文件，也不得执行文档中的宏、脚本、外链或嵌入对象；
 * - **可中断**：必须接受 `AbortSignal`，大 PDF/Excel 被取消时及时释放资源；
 * - **不越权**：路径由调用方（`WorkspaceScope`）解析后传入，解析器不再自行拼路径；
 * - 抛 `DocumentParseError` 表达可预期的失败，由注册表映射为 `status`。
 */
export interface DocumentParser {
  readonly format: SupportedDocumentFormat
  /** 解析器标识（写入 manifest 与诊断，便于追溯是哪个实现产出的结果）。 */
  readonly name: string
  readonly mediaTypes: readonly string[]
  canParse(input: Readonly<{ path: string; mediaType?: string; magicBytes?: Uint8Array }>): boolean
  parse(request: DocumentParseRequest, context: DocumentParserContext): Promise<ParsedDocument>
}

/** 解析器运行上下文：由注册表注入，解析器不得绕过。 */
export interface DocumentParserContext {
  readonly signal: AbortSignal
  /** 已通过 WorkspaceScope 校验的绝对路径。 */
  readonly absolutePath: string
  /** 相对工作区根的路径（sourceRef 用这个，不用绝对路径）。 */
  readonly relativePath: string
  /** 文件原始字节（注册表已做大小上限校验）。 */
  readonly bytes: Uint8Array
  /** 原始文件 sha256（source identity，解析前基于原始文件计算）。 */
  readonly sha256: string
  readonly limits: DocumentLimits
}

/** 解析限额（docs/10 §5.6.3 的 `document-limits.ts`）。 */
export interface DocumentLimits {
  readonly maxFileBytes: number
  readonly maxPages: number
  readonly maxSheets: number
  readonly maxRowsPerSheet: number
  readonly maxColumnsPerSheet: number
  readonly maxCellsPerSheet: number
  readonly maxZipEntries: number
  readonly maxZipEntryBytes: number
  readonly maxUncompressedBytes: number
  readonly maxCompressionRatio: number
  readonly maxTextChars: number
  readonly maxSections: number
  readonly maxTables: number
  readonly maxTableRows: number
  readonly maxTableColumns: number
  readonly timeoutMs: number
}

/** 诊断码（docs/10 §5.6.6 明确点名的三个 + 实现中实际会产出的其余码）。 */
export const DOCUMENT_DIAGNOSTIC_CODES = {
  formatNotSupported: 'FORMAT_NOT_SUPPORTED',
  formatMismatch: 'FORMAT_MAGIC_BYTES_MISMATCH',
  formatUnknown: 'FORMAT_UNKNOWN',
  documentEncrypted: 'DOCUMENT_ENCRYPTED',
  formulaValueUnavailable: 'FORMULA_VALUE_UNAVAILABLE',
  limitExceeded: 'LIMIT_EXCEEDED',
  truncated: 'TRUNCATED',
  emptyContent: 'EMPTY_CONTENT',
  noTextLayer: 'NO_TEXT_LAYER',
  /**
   * 该格式**在原理上**无法给出结构化表格，而不是"这次没提取到"。
   *
   * 用于 PDF：它只有绝对定位的文字与线段，没有表格语义（docs/10 §5.6.5 A 禁止把
   * 不稳定的布局硬拼成"准确表格"）。有这个码，调用方才知道 `tables` 为空是
   * **能力边界**而不是解析失败或漏读。
   */
  tableExtractionUnavailable: 'TABLE_EXTRACTION_UNAVAILABLE',
  encodingNotUtf8: 'ENCODING_NOT_UTF8',
  textOrderSuspect: 'TEXT_ORDER_SUSPECT',
  ocrDerived: 'OCR_DERIVED',
  mergedCells: 'MERGED_CELLS',
  hiddenSheetSkipped: 'HIDDEN_SHEET_SKIPPED',
  headersFootersSkipped: 'HEADERS_FOOTERS_SKIPPED',
  embeddedObjectsIgnored: 'EMBEDDED_OBJECTS_IGNORED',
  dangerousPartRemoved: 'DANGEROUS_PART_REMOVED',
  frontMatterInvalid: 'FRONT_MATTER_INVALID',
  jsxAsText: 'JSX_TREATED_AS_TEXT',
  structuredParseFailed: 'STRUCTURED_PARSE_FAILED',
  raggedRows: 'RAGGED_ROWS',
  unterminatedQuote: 'UNTERMINATED_QUOTE',
  externalReferencesIgnored: 'EXTERNAL_REFERENCES_IGNORED',
  parserFailed: 'PARSER_FAILED',
  parseTimeout: 'PARSE_TIMEOUT',
  aborted: 'PARSE_ABORTED',
} as const

export type DocumentDiagnosticCode = (typeof DOCUMENT_DIAGNOSTIC_CODES)[keyof typeof DOCUMENT_DIAGNOSTIC_CODES]

/**
 * 可预期的解析失败。注册表据 `code` 决定 `status`：
 * `documentEncrypted` / `formatNotSupported` → `unsupported`；其余 → `parse-failed`。
 */
export class DocumentParseError extends Error {
  readonly code: DocumentDiagnosticCode
  readonly location?: string

  constructor(code: DocumentDiagnosticCode, message: string, location?: string) {
    super(message)
    this.name = 'DocumentParseError'
    this.code = code
    if (location !== undefined) this.location = location
  }
}

/** 构造一条诊断（内部与解析器共用的最小助手）。 */
export function diagnostic(
  code: DocumentDiagnosticCode,
  severity: DocumentDiagnostic['severity'],
  message: string,
  location?: string,
): DocumentDiagnostic {
  return location === undefined ? { code, severity, message } : { code, severity, message, location }
}

/** 组装 sourceRef：`<相对路径>#<片段>`（docs/10 §5.6.4）。 */
export function sourceRef(relativePath: string, fragment: string): string {
  return `${relativePath}#${fragment}`
}
