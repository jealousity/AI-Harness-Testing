/**
 * 文档格式与编码检测（docs/10 §5.6.3）。
 *
 * 判定顺序刻意设计成「**内容优先、扩展名其次**」：
 * 1. magic bytes 命中且与扩展名一致 → 直接采信；
 * 2. magic bytes 命中但与扩展名冲突 → **以内容为准**并给 `FORMAT_MAGIC_BYTES_MISMATCH`
 *    诊断（扩展名不可信是常见情况：`.txt` 里装着 PDF、`.docx` 里装着 zip 之外的东西）；
 * 3. magic bytes 未命中 → 回退扩展名，并在二进制族上给冲突诊断（避免把 OOXML
 *    当文本读成乱码）；
 * 4. 都判不出来 → `unknown`。
 *
 * 编码检测同样不猜测：只认 BOM 与严格 UTF-8 校验，解不出来就按 UTF-8 有损解码
 * 并给 `ENCODING_NOT_UTF8` warning，绝不静默当成正常文本。
 *
 * @module platform-pipeline/documents/document-detect
 */

import { extname } from 'node:path'

import { DOCUMENT_DIAGNOSTIC_CODES, diagnostic, type DocumentDiagnostic, type SupportedDocumentFormat } from './document-types.ts'

/** 扩展名 → 格式。空扩展名按纯文本处理（工作区里很常见）。 */
const EXTENSION_FORMATS: Readonly<Record<string, SupportedDocumentFormat>> = {
  '.pdf': 'pdf',
  '.docx': 'docx',
  '.doc': 'doc',
  '.xlsx': 'xlsx',
  '.xls': 'xls',
  '.md': 'markdown',
  '.markdown': 'markdown',
  '.mdx': 'markdown',
  '.csv': 'csv',
  '.tsv': 'tsv',
  '.tab': 'tsv',
  '.yaml': 'yaml',
  '.yml': 'yaml',
  '.json': 'json',
  '.txt': 'text',
  '.log': 'text',
  '.rst': 'text',
  '.adoc': 'text',
}

/** 格式 → 标准 MIME（写入 ParsedDocument.mediaType 与 manifest）。 */
const FORMAT_MEDIA_TYPES: Readonly<Record<SupportedDocumentFormat, string>> = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  doc: 'application/msword',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  xls: 'application/vnd.ms-excel',
  markdown: 'text/markdown',
  text: 'text/plain',
  csv: 'text/csv',
  tsv: 'text/tab-separated-values',
  yaml: 'application/yaml',
  json: 'application/json',
}

/** 二进制族（magic bytes 必须校验；不匹配时不能按文本读取）。 */
export const BINARY_FORMATS: readonly SupportedDocumentFormat[] = ['pdf', 'docx', 'doc', 'xlsx', 'xls']

/** ZIP 容器族（OOXML：docx/xlsx/pptx）。 */
const ZIP_FORMATS: readonly SupportedDocumentFormat[] = ['docx', 'xlsx']

export interface MagicSignature {
  readonly format: SupportedDocumentFormat
  readonly bytes: readonly number[]
  readonly description: string
}

/** 已知 magic bytes。顺序即匹配优先级。 */
export const MAGIC_SIGNATURES: readonly MagicSignature[] = [
  { format: 'pdf', bytes: [0x25, 0x50, 0x44, 0x46, 0x2d], description: '%PDF-' },
  { format: 'docx', bytes: [0x50, 0x4b, 0x03, 0x04], description: 'PK\\x03\\x04 (zip)' },
  { format: 'doc', bytes: [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1], description: 'OLE2 复合文档' },
]

export interface DocumentFormatDetection {
  readonly format: SupportedDocumentFormat | 'unknown'
  readonly mediaType?: string
  /** 由 magic bytes 判出的格式（未命中为 undefined）。 */
  readonly magicFormat?: SupportedDocumentFormat
  /** magic bytes 与扩展名冲突。 */
  readonly conflict: boolean
  readonly diagnostics: readonly DocumentDiagnostic[]
}

/** 按扩展名判定格式（不读内容）。 */
export function formatFromExtension(path: string): SupportedDocumentFormat | undefined {
  return EXTENSION_FORMATS[extname(path).toLocaleLowerCase()]
}

export function mediaTypeOf(format: SupportedDocumentFormat): string {
  return FORMAT_MEDIA_TYPES[format]
}

/**
 * 按 magic bytes 判定格式。
 *
 * OLE2 容器同时可能是 `.doc` 与 `.xls`——两者共享同一签名的老格式，
 * 因此这里返回 `doc`，由调用方结合扩展名决定（`.xls` 的扩展名优先于该猜测）。
 */
export function formatFromMagicBytes(bytes: Uint8Array): SupportedDocumentFormat | undefined {
  for (const signature of MAGIC_SIGNATURES) {
    if (bytes.length < signature.bytes.length) continue
    if (signature.bytes.every((value, index) => bytes[index] === value)) return signature.format
  }
  return undefined
}

/** zip 容器签名（含空归档 `PK\x05\x06` 与分卷 `PK\x07\x08`）。 */
export function isZipContainer(bytes: Uint8Array): boolean {
  if (bytes.length < 4) return false
  if (bytes[0] !== 0x50 || bytes[1] !== 0x4b) return false
  return (bytes[2] === 0x03 && bytes[3] === 0x04)
    || (bytes[2] === 0x05 && bytes[3] === 0x06)
    || (bytes[2] === 0x07 && bytes[3] === 0x08)
}

/**
 * 综合判定：magic bytes 优先，冲突时以内容为准并给诊断。
 *
 * `formatHint` 只在**判不出任何格式**时作为兜底，且会给 warning——
 * 模型不能靠 hint 把 PDF 说成 markdown。
 */
export function detectDocumentFormat(input: {
  readonly path: string
  readonly bytes: Uint8Array
  readonly formatHint?: SupportedDocumentFormat
  readonly declaredMediaType?: string
}): DocumentFormatDetection {
  const diagnostics: DocumentDiagnostic[] = []
  const extensionFormat = formatFromExtension(input.path)
  const magic = formatFromMagicBytes(input.bytes)

  if (magic !== undefined) {
    const resolved = resolveContainerFormat(magic, extensionFormat)
    const conflict = extensionFormat !== undefined && extensionFormat !== resolved
      && !sharesContainer(magic, extensionFormat)
    if (conflict) {
      diagnostics.push(diagnostic(
        DOCUMENT_DIAGNOSTIC_CODES.formatMismatch,
        'warning',
        `文件内容看起来是 ${resolved}（magic bytes ${describeMagic(resolved)}），但扩展名是 ${extensionFormat}；以内容为准。`,
        input.path,
      ))
    }
    return {
      format: resolved,
      mediaType: input.declaredMediaType ?? mediaTypeOf(resolved),
      magicFormat: resolved,
      conflict,
      diagnostics,
    }
  }

  // magic 未命中：扩展名说是二进制族 → 内容对不上，不能按文本读。
  if (extensionFormat !== undefined && BINARY_FORMATS.includes(extensionFormat)) {
    diagnostics.push(diagnostic(
      DOCUMENT_DIAGNOSTIC_CODES.formatMismatch,
      'error',
      `扩展名声明为 ${extensionFormat}，但文件头不是 ${describeMagic(extensionFormat)}；无法按该格式解析，也不会按文本读取。`,
      input.path,
    ))
    return {
      format: extensionFormat,
      mediaType: input.declaredMediaType ?? mediaTypeOf(extensionFormat),
      conflict: true,
      diagnostics,
    }
  }

  if (extensionFormat !== undefined) {
    return {
      format: extensionFormat,
      mediaType: input.declaredMediaType ?? mediaTypeOf(extensionFormat),
      conflict: false,
      diagnostics,
    }
  }

  if (input.formatHint !== undefined) {
    diagnostics.push(diagnostic(
      DOCUMENT_DIAGNOSTIC_CODES.formatUnknown,
      'warning',
      `无法从内容或扩展名判定格式，按 formatHint=${input.formatHint} 处理。`,
      input.path,
    ))
    return {
      format: input.formatHint,
      mediaType: input.declaredMediaType ?? mediaTypeOf(input.formatHint),
      conflict: false,
      diagnostics,
    }
  }

  // 内容可解码为 UTF-8 时按纯文本处理，否则判 unknown（不猜）。
  if (isProbablyUtf8Text(input.bytes)) {
    return { format: 'text', mediaType: mediaTypeOf('text'), conflict: false, diagnostics }
  }
  diagnostics.push(diagnostic(
    DOCUMENT_DIAGNOSTIC_CODES.formatUnknown,
    'error',
    '无法判定文档格式：扩展名缺失或未知，且文件头不匹配任何已知格式。',
    input.path,
  ))
  return { format: 'unknown', conflict: false, diagnostics }
}

export interface DecodedText {
  readonly text: string
  readonly encoding: 'utf-8' | 'utf-8-bom' | 'utf-16le' | 'utf-16be' | 'utf-8-lossy'
  readonly diagnostics: readonly DocumentDiagnostic[]
}

const UTF8_BOM = [0xef, 0xbb, 0xbf]
const UTF16LE_BOM = [0xff, 0xfe]
const UTF16BE_BOM = [0xfe, 0xff]

/**
 * 解码文本文件。
 *
 * 只认 BOM 与**严格** UTF-8 校验。严格校验失败时按 UTF-8 有损解码（替换字符）
 * 并给 `ENCODING_NOT_UTF8` warning——这比抛错更有用（文档仍可读，只是部分字符
 * 变成 U+FFFD），但绝不静默当成正常文本。
 */
export function decodeText(bytes: Uint8Array, path: string): DecodedText {
  const diagnostics: DocumentDiagnostic[] = []
  if (startsWith(bytes, UTF8_BOM)) {
    return { text: new TextDecoder('utf-8').decode(bytes.subarray(3)), encoding: 'utf-8-bom', diagnostics }
  }
  if (startsWith(bytes, UTF16LE_BOM)) {
    return { text: new TextDecoder('utf-16le').decode(bytes.subarray(2)), encoding: 'utf-16le', diagnostics }
  }
  if (startsWith(bytes, UTF16BE_BOM)) {
    return { text: new TextDecoder('utf-16be').decode(bytes.subarray(2)), encoding: 'utf-16be', diagnostics }
  }
  try {
    const strict = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    return { text: strict, encoding: 'utf-8', diagnostics }
  } catch {
    diagnostics.push(diagnostic(
      DOCUMENT_DIAGNOSTIC_CODES.encodingNotUtf8,
      'warning',
      '文件不是合法 UTF-8（也没有 BOM）；已按 UTF-8 有损解码，无法识别的字节显示为 U+FFFD。',
      path,
    ))
    return { text: new TextDecoder('utf-8').decode(bytes), encoding: 'utf-8-lossy', diagnostics }
  }
}

/** 探测编码（供 detect 阶段判断「内容是否像文本」）。 */
export function detectTextEncoding(bytes: Uint8Array): DecodedText['encoding'] {
  if (startsWith(bytes, UTF8_BOM)) return 'utf-8-bom'
  if (startsWith(bytes, UTF16LE_BOM)) return 'utf-16le'
  if (startsWith(bytes, UTF16BE_BOM)) return 'utf-16be'
  return isProbablyUtf8Text(bytes) ? 'utf-8' : 'utf-8-lossy'
}

/** 是否像 UTF-8 文本：严格解码成功，且不含 NUL（二进制文件几乎必有 NUL）。 */
export function isProbablyUtf8Text(bytes: Uint8Array): boolean {
  if (bytes.length === 0) return true
  for (const byte of bytes.subarray(0, Math.min(bytes.length, 4096))) {
    if (byte === 0x00) return false
  }
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, Math.min(bytes.length, 65536)))
    return true
  } catch {
    return false
  }
}

function startsWith(bytes: Uint8Array, prefix: readonly number[]): boolean {
  if (bytes.length < prefix.length) return false
  return prefix.every((value, index) => bytes[index] === value)
}

function describeMagic(format: SupportedDocumentFormat): string {
  const signature = MAGIC_SIGNATURES.find(item => item.format === format)
  if (signature !== undefined) return signature.description
  // docx 与 xlsx 共享同一条 ZIP 签名，`MAGIC_SIGNATURES` 里只登记了 docx 一条，
  // 否则会给出"未知签名"这种对诊断毫无帮助的文案。
  if (ZIP_FORMATS.includes(format)) return 'PK\\x03\\x04 (zip)'
  return '未知签名'
}

/**
 * magic bytes 只能定到**容器**；容器内的具体格式由扩展名消歧。
 *
 * 两种共享容器：
 * - OLE2（`D0CF11E0…`）→ `doc` / `xls`；
 * - ZIP（`PK\x03\x04`）→ `docx` / `xlsx`。
 *
 * 缺了这一步，`.xlsx` 会被 ZIP 签名判成 `docx`：既给出错误的 unsupported 提示
 * （让人去转 .docx），也会在 XLSX 解析器就位后把工作簿路由到错误的解析器。
 * 扩展名缺失时不做猜测，保留 magic 结果。
 */
function resolveContainerFormat(
  magic: SupportedDocumentFormat,
  extensionFormat: SupportedDocumentFormat | undefined,
): SupportedDocumentFormat {
  if (extensionFormat === undefined) return magic
  if (magic === 'doc' && (extensionFormat === 'doc' || extensionFormat === 'xls')) return extensionFormat
  if (magic === 'docx' && ZIP_FORMATS.includes(extensionFormat)) return extensionFormat
  return magic
}

/** magic 与扩展名是否只是"同一容器内的不同成员"（此时不算冲突）。 */
function sharesContainer(
  magic: SupportedDocumentFormat,
  extensionFormat: SupportedDocumentFormat | undefined,
): boolean {
  if (extensionFormat === undefined) return false
  if (magic === 'doc') return extensionFormat === 'doc' || extensionFormat === 'xls'
  if (magic === 'docx') return ZIP_FORMATS.includes(extensionFormat)
  return false
}
