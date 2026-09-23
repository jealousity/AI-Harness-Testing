/**
 * 解析器注册表与统一中间表示的装配点（docs/10 §5.6.3、§5.6.4）。
 *
 * 注册表负责**所有格式共通的横切关注点**，解析器只管自己格式的细节：
 * - 文件字节上限校验、原始文件 sha256（source identity，解析前计算）；
 * - 格式检测（magic bytes 优先）与冲突判定；
 * - 解析超时与 `AbortSignal` 合并；
 * - `status` / `confidence` / `limits` 的归一与自洽校验；
 * - section/table/文本长度的软上限统一截断（解析器忘了也不会失控）；
 * - 失败一律转成**结构化** `ParsedDocument`，绝不抛异常给调用方。
 *
 * CLI、Web、Harness 三个入口共用同一个 `defaultParserRegistry()`，
 * 保证「同一份文档在哪个入口解析结果都一样」（docs/10 §5.6.11 第 9 条）。
 *
 * @module platform-pipeline/documents/document-parser
 */

import { createHash } from 'node:crypto'

import {
  DOCUMENT_DIAGNOSTIC_CODES,
  DocumentParseError,
  diagnostic,
  type DocumentDiagnostic,
  type DocumentParser,
  type DocumentParserContext,
  type DocumentLimits,
  type ParsedDocument,
  type ParsedSection,
  type ParsedTable,
  type SupportedDocumentFormat,
} from './document-types.ts'
import {
  assertFileSize,
  capList,
  capText,
  resolveDocumentLimits,
  withParseTimeout,
} from './document-limits.ts'
import { BINARY_FORMATS, detectDocumentFormat, mediaTypeOf } from './document-detect.ts'

/** 一次解析的输入。路径由调用方（`WorkspaceScope`）解析并校验，注册表不再拼路径。 */
export interface DocumentParseInput {
  /** 相对工作区根的路径；写入 sourceRef。 */
  readonly path: string
  /** 已通过包含性校验的绝对路径；仅解析器需要落临时文件时使用。 */
  readonly absolutePath: string
  readonly bytes: Uint8Array
  readonly formatHint?: SupportedDocumentFormat
  readonly includeTables?: boolean
  readonly includeMetadata?: boolean
  readonly includeRawSource?: boolean
  readonly sheetNames?: readonly string[]
  readonly includeHiddenSheets?: boolean
  readonly pageRange?: Readonly<{ from?: number; to?: number }>
  readonly declaredMediaType?: string
  readonly limits?: Partial<DocumentLimits>
  readonly signal: AbortSignal
}

/** 解析器注册表。 */
export class DocumentParserRegistry {
  private readonly parsers: DocumentParser[] = []

  constructor(parsers: readonly DocumentParser[] = []) {
    for (const parser of parsers) this.register(parser)
  }

  /** 注册解析器。同一格式重复注册直接报错，避免"哪个实现生效"变得不可预期。 */
  register(parser: DocumentParser): void {
    if (this.parsers.some(existing => existing.format === parser.format)) {
      throw new Error(`duplicate document parser for format "${parser.format}"`)
    }
    this.parsers.push(parser)
  }

  /** 已注册的格式（诊断与测试用）。 */
  formats(): readonly SupportedDocumentFormat[] {
    return this.parsers.map(parser => parser.format)
  }

  parserFor(format: SupportedDocumentFormat | 'unknown'): DocumentParser | undefined {
    return this.parsers.find(parser => parser.format === format)
  }

  /**
   * 解析一份文档。**永远返回 `ParsedDocument`**：格式不支持、加密、超限、损坏、
   * 被取消都通过 `status` + `diagnostics` 表达，不抛异常——否则调用方（LLM 工具、
   * Web 路由）会各自发明一套错误结构。
   */
  async parse(input: DocumentParseInput): Promise<ParsedDocument> {
    const limits = resolveDocumentLimits(input.limits)
    const sha256 = createHash('sha256').update(input.bytes).digest('hex')
    const fileName = input.path.split('/').pop() ?? input.path

    try {
      assertFileSize(input.bytes.byteLength, limits)
    } catch (error) {
      return this.failure(input, sha256, 'unknown', toDiagnostics(error))
    }

    const detection = detectDocumentFormat({
      path: input.path,
      bytes: input.bytes,
      ...(input.formatHint === undefined ? {} : { formatHint: input.formatHint }),
      ...(input.declaredMediaType === undefined ? {} : { declaredMediaType: input.declaredMediaType }),
    })

    if (detection.format === 'unknown') {
      return this.failure(input, sha256, 'unknown', detection.diagnostics)
    }

    // 二进制族但 magic bytes 对不上：既不能按该格式解析，也不能退回按文本读
    // （docs/10 §5.6.1「绝不能把二进制内容当 UTF-8 文本读取后继续生成知识条目」）。
    if (BINARY_FORMATS.includes(detection.format) && detection.magicFormat === undefined) {
      return this.failure(input, sha256, detection.format, detection.diagnostics)
    }

    const parser = this.parserFor(detection.format)
    if (parser === undefined) {
      return this.failure(input, sha256, detection.format, [
        ...detection.diagnostics,
        diagnostic(
          DOCUMENT_DIAGNOSTIC_CODES.formatNotSupported,
          'error',
          unsupportedMessage(detection.format),
          input.path,
        ),
      ])
    }

    const timeout = withParseTimeout(input.signal, limits.timeoutMs)
    try {
      const context: DocumentParserContext = {
        signal: timeout.signal,
        absolutePath: input.absolutePath,
        relativePath: input.path,
        bytes: input.bytes,
        sha256,
        limits,
      }
      const parsed = await parser.parse(
        {
          path: input.path,
          ...(input.formatHint === undefined ? {} : { formatHint: input.formatHint }),
          ...(input.includeTables === undefined ? {} : { includeTables: input.includeTables }),
          ...(input.includeMetadata === undefined ? {} : { includeMetadata: input.includeMetadata }),
          ...(input.includeRawSource === undefined ? {} : { includeRawSource: input.includeRawSource }),
          ...(input.sheetNames === undefined ? {} : { sheetNames: input.sheetNames }),
          ...(input.includeHiddenSheets === undefined ? {} : { includeHiddenSheets: input.includeHiddenSheets }),
          ...(input.pageRange === undefined ? {} : { pageRange: input.pageRange }),
        },
        context,
      )
      return normalize(parsed, {
        format: detection.format,
        fileName,
        sha256,
        bytesRead: input.bytes.byteLength,
        mediaType: detection.mediaType,
        extraDiagnostics: detection.diagnostics,
        limits,
      })
    } catch (error) {
      const aborted = timeout.reason()
      const diagnostics = aborted === 'timeout'
        ? [diagnostic(DOCUMENT_DIAGNOSTIC_CODES.parseTimeout, 'error', `解析超过 ${limits.timeoutMs}ms 未完成，已中止。`, input.path)]
        : aborted === 'caller'
          ? [diagnostic(DOCUMENT_DIAGNOSTIC_CODES.aborted, 'warning', '解析被调用方取消。', input.path)]
          : toDiagnostics(error, input.path)
      return this.failure(input, sha256, detection.format, [...detection.diagnostics, ...diagnostics])
    } finally {
      timeout.dispose()
    }
  }

  /** 构造结构化失败结果（status 由诊断码决定）。 */
  private failure(
    input: DocumentParseInput,
    sha256: string,
    format: SupportedDocumentFormat | 'unknown',
    diagnostics: readonly DocumentDiagnostic[],
  ): ParsedDocument {
    const fileName = input.path.split('/').pop() ?? input.path
    return {
      status: statusForDiagnostics(diagnostics),
      format,
      fileName,
      ...(format === 'unknown' ? {} : { mediaType: mediaTypeOf(format) }),
      sha256,
      sections: [],
      tables: [],
      metadata: {},
      plainText: '',
      diagnostics,
      confidence: 'exact-text',
      limits: { truncated: false, bytesRead: input.bytes.byteLength },
    }
  }
}

interface NormalizeContext {
  readonly format: SupportedDocumentFormat | 'unknown'
  readonly fileName: string
  readonly sha256: string
  readonly bytesRead: number
  readonly mediaType?: string
  readonly extraDiagnostics: readonly DocumentDiagnostic[]
  readonly limits: DocumentLimits
}

/**
 * 归一解析器输出：补全身份字段、合并诊断、统一截断、校验 status/confidence 自洽。
 *
 * 三条强制修正（解析器即使忘了也会被纠正）：
 * - `limits.truncated=true` 时 `status` 不能是 `parsed` → 降为 `partial` 并补 `TRUNCATED` 诊断；
 * - `partial` / `limit-exceeded` 必须有至少一条 warning/error 诊断（否则调用方无从判断原因）；
 * - 空内容且无任何诊断 → 补 `EMPTY_CONTENT`，避免"解析成功但什么都没有"的静默结果。
 */
function normalize(parsed: ParsedDocument, context: NormalizeContext): ParsedDocument {
  const diagnostics = [...context.extraDiagnostics, ...parsed.diagnostics]

  const sectionsCap = capList(parsed.sections, context.limits.maxSections)
  const tablesCap = capList(
    parsed.tables.map(table => capTable(table, context.limits)),
    context.limits.maxTables,
  )
  const textCap = capText(parsed.plainText, context.limits)

  let truncated = parsed.limits.truncated || sectionsCap.truncated || tablesCap.truncated || textCap.truncated
  if (truncated && !diagnostics.some(item => item.code === DOCUMENT_DIAGNOSTIC_CODES.truncated)) {
    diagnostics.push(diagnostic(
      DOCUMENT_DIAGNOSTIC_CODES.truncated,
      'warning',
      '文档超出解析上限，结果已截断；请缩小 pageRange / sheetNames 或拆分文档后重新解析。',
    ))
  }

  let status = parsed.status
  if (truncated && status === 'parsed') status = 'partial'
  if (status === 'parsed' && textCap.text.trim() === '' && sectionsCap.values.length === 0 && tablesCap.values.length === 0) {
    diagnostics.push(diagnostic(
      DOCUMENT_DIAGNOSTIC_CODES.emptyContent,
      'warning',
      '解析完成但没有可提取内容；文件可能是空文档、只有图片，或缺少文本层。',
    ))
    status = 'partial'
  }
  if ((status === 'partial' || status === 'limit-exceeded') && !diagnostics.some(item => item.severity !== 'info')) {
    diagnostics.push(diagnostic(
      DOCUMENT_DIAGNOSTIC_CODES.truncated,
      'warning',
      `解析状态为 ${status}，但解析器未给出具体原因；请检查文档是否超出上限或含不可提取内容。`,
    ))
  }
  if (status !== 'parsed' && status !== 'partial') truncated = parsed.limits.truncated

  return {
    status,
    format: context.format,
    fileName: context.fileName,
    ...(context.mediaType === undefined ? {} : { mediaType: context.mediaType }),
    sha256: context.sha256,
    ...(parsed.pageCount === undefined ? {} : { pageCount: parsed.pageCount }),
    ...(parsed.sheetNames === undefined ? {} : { sheetNames: parsed.sheetNames }),
    sections: sectionsCap.values,
    tables: tablesCap.values,
    metadata: parsed.metadata,
    plainText: textCap.text,
    ...(parsed.rawSource === undefined ? {} : { rawSource: parsed.rawSource }),
    diagnostics,
    confidence: parsed.confidence,
    limits: {
      ...parsed.limits,
      truncated,
      bytesRead: parsed.limits.bytesRead ?? context.bytesRead,
    },
  }
}

function capTable(table: ParsedTable, limits: DocumentLimits): ParsedTable {
  const rows = capList(table.rows, limits.maxTableRows)
  const headers = capList(table.headers, limits.maxTableColumns)
  if (!rows.truncated && !headers.truncated) return table
  return {
    ...table,
    headers: headers.values,
    rows: rows.values.map(row => capList(row, limits.maxTableColumns).values),
    truncated: true,
  }
}

/**
 * 无解析器时的降级提示。
 *
 * `.doc` / `.xls` 是**有意的**不支持（docs/10 §5.6.5 B/C 要求二选一：接入安全适配器，
 * 或返回 unsupported 并指明迁移路径），因此给出定向转换建议；其余格式给通用建议。
 * 提示只影响文案，`status` 一律由 `FORMAT_NOT_SUPPORTED` 映射为 `unsupported`。
 */
function unsupportedMessage(format: SupportedDocumentFormat | 'unknown'): string {
  if (format === 'doc') {
    return '当前运行环境没有安全的 .doc 解析器（老二进制格式无法保证不执行宏与嵌入对象），请先转换为 .docx 后再导入。'
  }
  if (format === 'xls') {
    return '当前运行环境没有安全的 .xls 解析器（老二进制格式无法保证不执行宏与外部连接），请先转换为 .xlsx 后再导入。'
  }
  if (format === 'unknown') {
    return '无法识别文档格式；请确认扩展名与文件内容一致，或转换为 markdown / csv / txt 后再导入。'
  }
  return `当前运行环境没有安全的 ${format} 解析器；请先转换为 markdown / csv / txt 后再导入。`
}

/** 诊断码 → 状态。 */
function statusForDiagnostics(diagnostics: readonly DocumentDiagnostic[]): ParsedDocument['status'] {  const codes = new Set(diagnostics.map(item => item.code))
  if (codes.has(DOCUMENT_DIAGNOSTIC_CODES.limitExceeded)) return 'limit-exceeded'
  if (codes.has(DOCUMENT_DIAGNOSTIC_CODES.documentEncrypted)) return 'unsupported'
  if (codes.has(DOCUMENT_DIAGNOSTIC_CODES.formatNotSupported)) return 'unsupported'
  if (codes.has(DOCUMENT_DIAGNOSTIC_CODES.formatUnknown)) return 'unsupported'
  if (codes.has(DOCUMENT_DIAGNOSTIC_CODES.formatMismatch)) return 'unsupported'
  return 'parse-failed'
}

/** 异常 → 诊断。 */
function toDiagnostics(error: unknown, location?: string): readonly DocumentDiagnostic[] {
  if (error instanceof DocumentParseError) {
    return [diagnostic(error.code, 'error', error.message, error.location ?? location)]
  }
  const message = error instanceof Error ? error.message : String(error)
  return [diagnostic(DOCUMENT_DIAGNOSTIC_CODES.parserFailed, 'error', `解析失败：${message}`, location)]
}

/** 便于解析器复用：把一组 section 的 order 重新编号并截断到 limits。 */
export function reindexSections(sections: readonly ParsedSection[]): readonly ParsedSection[] {
  return sections.map((section, index) => ({ ...section, order: index }))
}
