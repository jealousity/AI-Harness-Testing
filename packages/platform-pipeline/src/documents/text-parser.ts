/**
 * 纯文本族解析器：TXT / YAML / JSON（docs/10 §5.6.1「文本/表格」行）。
 *
 * 共同约定：
 * - 编码由 `decodeText` 显式判定（BOM / 严格 UTF-8 / 有损降级 + warning）；
 * - 每个文件产出一个 `ParsedSection`，`sourceRef` 用行号范围；
 * - YAML / JSON 的**合法性显式处理**：解析失败不抛错，而是降为 `partial` +
 *   `STRUCTURED_PARSE_FAILED`，并把原文留在 `plainText` 里——既不让模型基于
 *   半截结构推理，也不假装"解析成功"。
 *
 * @module platform-pipeline/documents/text-parser
 */

import { parse as parseYaml } from 'yaml'

import { decodeText, formatFromExtension } from './document-detect.ts'
import {
  DOCUMENT_DIAGNOSTIC_CODES,
  diagnostic,
  sourceRef,
  type DocumentDiagnostic,
  type DocumentParseRequest,
  type DocumentParser,
  type DocumentParserContext,
  type ParsedDocument,
  type SupportedDocumentFormat,
} from './document-types.ts'

/** 解析器标识：`text` 格式同时服务 `.txt/.log/.rst/.adoc` 与无扩展名文件。 */
export class PlainTextParser implements DocumentParser {
  readonly format = 'text' as const
  readonly name = 'builtin-text'
  readonly mediaTypes = ['text/plain'] as const

  canParse(input: Readonly<{ path: string; mediaType?: string; magicBytes?: Uint8Array }>): boolean {
    const format = formatFromExtension(input.path)
    return format === 'text' || format === undefined
  }

  async parse(request: DocumentParseRequest, context: DocumentParserContext): Promise<ParsedDocument> {
    const decoded = decodeText(context.bytes, context.relativePath)
    const normalized = decoded.text.replace(/\r\n?/g, '\n')
    const lineCount = normalized === '' ? 0 : normalized.split('\n').length

    return {
      status: 'parsed',
      format: 'text',
      fileName: context.relativePath.split('/').pop() ?? context.relativePath,
      mediaType: 'text/plain',
      sha256: context.sha256,
      sections: [{
        id: 'section-1',
        title: context.relativePath.split('/').pop() ?? context.relativePath,
        order: 0,
        text: normalized,
        sourceRef: sourceRef(context.relativePath, `lines=1-${Math.max(lineCount, 1)}`),
      }],
      tables: [],
      metadata: { encoding: decoded.encoding, lineCount, charCount: normalized.length },
      plainText: normalized,
      ...(request.includeRawSource === true ? { rawSource: decoded.text } : {}),
      diagnostics: [...decoded.diagnostics],
      confidence: 'exact-text',
      limits: { truncated: false, bytesRead: context.bytes.byteLength },
    }
  }
}

/** YAML 解析器（`.yaml` / `.yml`）。 */
export class YamlParser implements DocumentParser {
  readonly format = 'yaml' as const
  readonly name = 'builtin-yaml'
  readonly mediaTypes = ['application/yaml', 'text/yaml'] as const

  canParse(input: Readonly<{ path: string; mediaType?: string; magicBytes?: Uint8Array }>): boolean {
    return formatFromExtension(input.path) === 'yaml'
  }

  async parse(request: DocumentParseRequest, context: DocumentParserContext): Promise<ParsedDocument> {
    const decoded = decodeText(context.bytes, context.relativePath)
    const normalized = decoded.text.replace(/\r\n?/g, '\n')
    const diagnostics: DocumentDiagnostic[] = [...decoded.diagnostics]
    const metadata: Record<string, string | number | boolean | null> = { encoding: decoded.encoding }
    let status: ParsedDocument['status'] = 'parsed'

    try {
      const parsed = parseYaml(normalized) as unknown
      // 多文档 YAML 会返回数组；两者都只是"合法"，不做语义解读。
      const record = parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
        ? parsed as Record<string, unknown>
        : {}
      metadata.topLevelKeys = Object.keys(record).slice(0, 100).join(', ')
      metadata.documentCount = Array.isArray(parsed) ? parsed.length : 1
    } catch (error) {
      status = 'partial'
      metadata.valid = false
      diagnostics.push(diagnostic(
        DOCUMENT_DIAGNOSTIC_CODES.structuredParseFailed,
        'warning',
        `不是合法 YAML（${error instanceof Error ? error.message : String(error)}）；已按原文返回，未做结构解读。`,
        context.relativePath,
      ))
    }

    const lineCount = normalized === '' ? 0 : normalized.split('\n').length
    return {
      status,
      format: 'yaml',
      fileName: context.relativePath.split('/').pop() ?? context.relativePath,
      mediaType: 'application/yaml',
      sha256: context.sha256,
      sections: [{
        id: 'section-1',
        title: context.relativePath.split('/').pop() ?? context.relativePath,
        order: 0,
        text: normalized,
        sourceRef: sourceRef(context.relativePath, `lines=1-${Math.max(lineCount, 1)}`),
      }],
      tables: [],
      metadata,
      plainText: normalized,
      ...(request.includeRawSource === true ? { rawSource: decoded.text } : {}),
      diagnostics,
      confidence: 'structure-preserved',
      limits: { truncated: false, bytesRead: context.bytes.byteLength },
    }
  }
}

/** JSON 解析器（`.json`）。 */
export class JsonParser implements DocumentParser {
  readonly format = 'json' as const
  readonly name = 'builtin-json'
  readonly mediaTypes = ['application/json'] as const

  canParse(input: Readonly<{ path: string; mediaType?: string; magicBytes?: Uint8Array }>): boolean {
    return formatFromExtension(input.path) === 'json'
  }

  async parse(request: DocumentParseRequest, context: DocumentParserContext): Promise<ParsedDocument> {
    const decoded = decodeText(context.bytes, context.relativePath)
    const normalized = decoded.text.replace(/\r\n?/g, '\n')
    const diagnostics: DocumentDiagnostic[] = [...decoded.diagnostics]
    const metadata: Record<string, string | number | boolean | null> = { encoding: decoded.encoding }
    let status: ParsedDocument['status'] = 'parsed'
    let plainText = normalized

    try {
      const parsed = JSON.parse(normalized) as unknown
      metadata.valid = true
      metadata.rootType = Array.isArray(parsed) ? 'array' : parsed === null ? 'null' : typeof parsed
      if (Array.isArray(parsed)) metadata.itemCount = parsed.length
      else if (parsed !== null && typeof parsed === 'object') {
        metadata.topLevelKeys = Object.keys(parsed as Record<string, unknown>).slice(0, 100).join(', ')
      }
      plainText = JSON.stringify(parsed, null, 2)
    } catch (error) {
      // 非法 JSON 不当成"解析成功"：退回原文并显式说明（与既有 parse_doc 行为一致）。
      status = 'partial'
      metadata.valid = false
      diagnostics.push(diagnostic(
        DOCUMENT_DIAGNOSTIC_CODES.structuredParseFailed,
        'warning',
        `不是合法 JSON（${error instanceof Error ? error.message : String(error)}）；已按原文返回，未做结构解读。`,
        context.relativePath,
      ))
    }

    return {
      status,
      format: 'json',
      fileName: context.relativePath.split('/').pop() ?? context.relativePath,
      mediaType: 'application/json',
      sha256: context.sha256,
      sections: [{
        id: 'section-1',
        title: context.relativePath.split('/').pop() ?? context.relativePath,
        order: 0,
        text: plainText,
        sourceRef: sourceRef(context.relativePath, 'lines=1-1'),
      }],
      tables: [],
      metadata,
      plainText,
      ...(request.includeRawSource === true ? { rawSource: decoded.text } : {}),
      diagnostics,
      confidence: 'structure-preserved',
      limits: { truncated: false, bytesRead: context.bytes.byteLength },
    }
  }
}
