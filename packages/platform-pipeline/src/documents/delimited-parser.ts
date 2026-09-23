/**
 * CSV / TSV 解析器（docs/10 §5.6.1「文本/表格」行）。
 *
 * 按 RFC 4180 处理引号包裹、双引号转义、字段内换行与 CRLF。三处**显式**处理
 * （docs/10 §5.6.1「编码、分隔符、引号、换行和 JSON 合法性要显式处理」）：
 * - 未闭合引号 → `parse-failed`。宁可整体失败，也不返回一张字段错位的假表；
 * - 行内单元格数与表头不一致 → 补齐/截断并给 `RAGGED_ROWS` warning；
 * - 超出最大行/列数 → **软截断**并标 `truncated`（`partial`），不整体拒绝。
 *
 * @module platform-pipeline/documents/delimited-parser
 */

import { decodeText, formatFromExtension } from './document-detect.ts'
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
  type SupportedDocumentFormat,
} from './document-types.ts'

export class DelimitedParser implements DocumentParser {
  readonly format: SupportedDocumentFormat
  readonly name: string
  readonly mediaTypes: readonly string[]
  private readonly delimiter: string

  constructor(format: 'csv' | 'tsv') {
    this.format = format
    this.name = `builtin-${format}`
    this.delimiter = format === 'tsv' ? '\t' : ','
    this.mediaTypes = format === 'tsv' ? ['text/tab-separated-values'] : ['text/csv']
  }

  canParse(input: Readonly<{ path: string; mediaType?: string; magicBytes?: Uint8Array }>): boolean {
    return formatFromExtension(input.path) === this.format
  }

  async parse(request: DocumentParseRequest, context: DocumentParserContext): Promise<ParsedDocument> {
    const decoded = decodeText(context.bytes, context.relativePath)
    const diagnostics: DocumentDiagnostic[] = [...decoded.diagnostics]
    const normalized = decoded.text.replace(/\r\n?/g, '\n')

    const parsed = parseDelimitedRows(normalized, this.delimiter, context.relativePath)
    const headers = parsed.rows.length === 0 ? [] : (parsed.rows[0] ?? []).map(value => value.trim())
    const dataRows = parsed.rows.slice(1)

    const columnCap = context.limits.maxColumnsPerSheet
    const rowCap = context.limits.maxRowsPerSheet
    const truncated = dataRows.length > rowCap || headers.length > columnCap
    const cappedHeaders = headers.slice(0, columnCap)
    const cappedRows = dataRows.slice(0, rowCap).map(row => normalizeRow(row, cappedHeaders.length, diagnostics, context.relativePath))

    if (dataRows.length > rowCap) {
      diagnostics.push(diagnostic(
        DOCUMENT_DIAGNOSTIC_CODES.truncated,
        'warning',
        `数据行 ${dataRows.length} 行超过上限 ${rowCap} 行，只解析前 ${rowCap} 行。`,
        context.relativePath,
      ))
    }
    if (headers.length > columnCap) {
      diagnostics.push(diagnostic(
        DOCUMENT_DIAGNOSTIC_CODES.truncated,
        'warning',
        `列数 ${headers.length} 超过上限 ${columnCap}，只解析前 ${columnCap} 列。`,
        context.relativePath,
      ))
    }

    const tables: ParsedTable[] = cappedHeaders.length === 0
      ? []
      : [{
          id: 'table-1',
          title: context.relativePath.split('/').pop() ?? context.relativePath,
          headers: cappedHeaders,
          rows: cappedRows,
          // 行级 ref：CSV 没有 sheet 概念，用表序号 + 数据行号定位（docs/10 §5.6.7）。
          rowRefs: cappedRows.map((_row, rowIndex) => sourceRef(context.relativePath, `table=1,row=${rowIndex + 1}`)),
          sourceRef: sourceRef(context.relativePath, 'table=1'),
          ...(truncated ? { truncated: true } : {}),
        }]

    const sections: ParsedSection[] = [{
      id: 'section-1',
      title: tables[0]?.title,
      order: 0,
      text: renderRows(cappedHeaders, cappedRows),
      sourceRef: sourceRef(context.relativePath, `lines=1-${Math.min(parsed.rows.length, rowCap + 1)}`),
    }]

    return {
      status: truncated ? 'partial' : 'parsed',
      format: this.format,
      fileName: context.relativePath.split('/').pop() ?? context.relativePath,
      mediaType: this.mediaTypes[0]!,
      sha256: context.sha256,
      sections,
      tables,
      metadata: {
        delimiter: this.delimiter === '\t' ? 'tab' : 'comma',
        rowCount: cappedRows.length,
        columnCount: cappedHeaders.length,
      },
      plainText: normalized,
      ...(request.includeRawSource === true ? { rawSource: decoded.text } : {}),
      diagnostics,
      confidence: 'structure-preserved',
      limits: { truncated, rowsRead: cappedRows.length, bytesRead: context.bytes.byteLength },
    }
  }
}

/** 行内单元格数与表头不一致时补齐/截断，并只报一次 warning。 */
function normalizeRow(
  row: readonly string[],
  columnCount: number,
  diagnostics: DocumentDiagnostic[],
  path: string,
): readonly string[] {
  if (row.length === columnCount) return row
  if (!diagnostics.some(item => item.code === DOCUMENT_DIAGNOSTIC_CODES.raggedRows)) {
    diagnostics.push(diagnostic(
      DOCUMENT_DIAGNOSTIC_CODES.raggedRows,
      'warning',
      `存在单元格数与表头（${columnCount} 列）不一致的行；不足处补空、超出部分截断。`,
      path,
    ))
  }
  if (row.length > columnCount) return row.slice(0, columnCount)
  return [...row, ...Array.from({ length: columnCount - row.length }, () => '')]
}

function renderRows(headers: readonly string[], rows: readonly (readonly string[])[]): string {
  if (headers.length === 0) return ''
  return [
    `| ${headers.join(' | ')} |`,
    `| ${headers.map(() => '---').join(' | ')} |`,
    ...rows.map(row => `| ${row.join(' | ')} |`),
  ].join('\n')
}

/**
 * RFC 4180 状态机：引号包裹、`""` 转义、字段内换行、CRLF。
 *
 * 未闭合引号抛 `DocumentParseError(UNTERMINATED_QUOTE)` → 注册表映射为 `parse-failed`。
 * 完全空白的行被丢弃（CSV 里常见），但**表格内部的空单元格保留**。
 */
export function parseDelimitedRows(text: string, delimiter: string, path: string): { readonly rows: readonly (readonly string[])[] } {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false

  const endField = (): void => {
    row.push(field)
    field = ''
  }
  const endRow = (): void => {
    endField()
    if (row.some(cell => cell.trim() !== '')) rows.push(row)
    row = []
  }

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!
    if (quoted) {
      if (char !== '"') { field += char; continue }
      if (text[index + 1] === '"') { field += '"'; index += 1; continue }
      quoted = false
      continue
    }
    if (char === '"' && field === '') { quoted = true; continue }
    if (char === delimiter) { endField(); continue }
    if (char === '\n') { endRow(); continue }
    field += char
  }
  if (quoted) {
    throw new DocumentParseError(
      DOCUMENT_DIAGNOSTIC_CODES.unterminatedQuote,
      '分隔符文件存在未闭合的引号字段；拒绝输出可能错位的表格，请修复后重新解析。',
      path,
    )
  }
  if (field !== '' || row.length > 0) endRow()
  return { rows }
}
