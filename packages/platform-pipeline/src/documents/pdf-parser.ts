/**
 * PDF 解析器（docs/10 §5.6.5 A、ADR-0001）。
 *
 * 边界先说清楚：
 * - **不手写 PDF 二进制解析**（§5.6.5 A 明令）。文本提取交给 `pdfjs-dist`，且通过
 *   `PdfTextExtractor` 接缝注入——换库不影响本文件之外任何契约（§5.6.11 第 10 条）。
 * - **不产出 `tables`**。PDF 没有表格语义，只有绝对定位的文字与线段；任何"表格识别"
 *   都是布局推断。§5.6.5 A 明确禁止"把布局不稳定的文本硬拼成准确表格"，
 *   因此这里宁可让 `tables` 为空并给出解释性诊断。
 * - **不执行任何文档内容**：PDF.js 不实现 PDF 的 JavaScript 解释器，解析时另外显式
 *   传 `isEvalSupported: false`；表单动作、`/URI` 外链、`/EmbeddedFile` 附件都不触发。
 *   原始字节里的危险特性只做**诊断**（见 `DANGEROUS_PDF_FEATURES`）。
 * - **扫描件不伪装**：整篇没有可提取文本时返回 `partial` + `NO_TEXT_LAYER`，
 *   绝不返回"解析成功但内容为空"。
 *
 * @module platform-pipeline/documents/pdf-parser
 */

import {
  DOCUMENT_DIAGNOSTIC_CODES,
  DocumentParseError,
  diagnostic,
  sourceRef,
  type ContentConfidence,
  type DocumentDiagnostic,
  type DocumentParseRequest,
  type DocumentParser,
  type DocumentParserContext,
  type ParsedDocument,
  type ParsedSection,
} from './document-types.ts'
import { formatFromExtension } from './document-detect.ts'
import { limitExceeded } from './document-limits.ts'

/** PDF magic bytes（`%PDF-`）。 */
const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46, 0x2d]

/**
 * 原始字节里值得报告的 PDF 特性。**这只是诊断，不是安全边界**——
 * 安全边界是"PDF.js 根本不执行 JavaScript"。
 *
 * 有意不收录 `/JS`：两个字符的短名在二进制流里必然大量误报，会把这个诊断变成噪音。
 */
const DANGEROUS_PDF_FEATURES: readonly { readonly needle: string; readonly reason: string }[] = [
  { needle: '/JavaScript', reason: 'PDF JavaScript 动作' },
  { needle: '/OpenAction', reason: '文档打开时自动执行的动作' },
  { needle: '/Launch', reason: '启动外部程序的动作' },
  { needle: '/EmbeddedFile', reason: '嵌入附件' },
  { needle: '/RichMedia', reason: '富媒体注释' },
  { needle: '/XFA', reason: 'XFA 表单' },
  { needle: '/GoToR', reason: '跳转到外部文档的动作' },
]

/** 单页文本项：文本 + 基线位置（用于顺序异常检测）。 */
export interface PdfTextItem {
  readonly text: string
  readonly x: number
  readonly y: number
  readonly eol: boolean
}

/** 单页提取结果。 */
export interface PdfPageText {
  /** 1-based 页码。 */
  readonly page: number
  readonly items: readonly PdfTextItem[]
}

export interface PdfExtraction {
  /** 文档总页数（不受 pageRange 影响）。 */
  readonly pageCount: number
  /** 实际读取的页（按页码升序）。 */
  readonly pages: readonly PdfPageText[]
  /** 文档是否带加密字典（可能是仅 owner 密码，仍可读）。 */
  readonly encrypted: boolean
}

export interface PdfExtractOptions {
  readonly pageRange?: Readonly<{ from?: number; to?: number }>
  /** 允许读取的最大页数；超出抛 `DocumentParseError(LIMIT_EXCEEDED)`。 */
  readonly maxPages: number
  readonly signal: AbortSignal
}

/**
 * 页面文本提取接缝。
 *
 * 抽出这一层的三个理由：
 * 1. §5.6.9 要求依赖可替换、失败可降级——换库只改实现，不改契约；
 * 2. 测试能注入确定性提取器，不必为每个断言准备真实 PDF；
 * 3. "库加载失败 → `unsupported`"这条降级路径可以被真正测到（否则只能靠读代码相信）。
 */
export interface PdfTextExtractor {
  readonly name: string
  extract(bytes: Uint8Array, options: PdfExtractOptions): Promise<PdfExtraction>
}

// ── 默认实现：懒加载 pdfjs-dist ───────────────────────────────────────────────

/** pdfjs 的最小结构面。有意不 import 它的类型：换库时本文件不该跟着改。 */
interface PdfjsModuleLike {
  getDocument(source: Record<string, unknown>): PdfjsLoadingTaskLike
}

interface PdfjsLoadingTaskLike {
  readonly promise: Promise<PdfjsDocumentLike>
  destroy(): Promise<void>
}

interface PdfjsDocumentLike {
  readonly numPages: number
  getPage(pageNumber: number): Promise<PdfjsPageLike>
}

interface PdfjsPageLike {
  getTextContent(): Promise<{ readonly items: readonly unknown[] }>
  cleanup(): void
}

/**
 * 交给 pdfjs 之前**必须**做一份独立副本。两个原因都是实测踩到的：
 *
 * 1. **pdfjs 会转移（transfer）传入的 ArrayBuffer**。实测：`getDocument({data})` 之后，
 *    调用方那个 `Uint8Array` 的 `length` 变成 0、`buffer.byteLength` 变成 0——
 *    底层 buffer 已被 detach 并移交给 pdfjs。后果非常隐蔽：解析本身成功，但之后任何
 *    对同一份字节的读取都会静默拿到空数据（例如 `limits.bytesRead` 变成 0、
 *    从文件头取版本号取不到），而且第二次解析同一个数组会直接抛
 *    `Cannot transfer object of unsupported type.`。
 *    因此这里传副本，保证 `context.bytes` 在整个解析过程里始终有效。
 * 2. **pdfjs 显式拒绝 `Buffer`**，报
 *    `Please provide binary data as 'Uint8Array', rather than 'Buffer'.`——尽管
 *    `Buffer` 是 `Uint8Array` 的子类。而 Node 的 `fs.readFile` 返回的正是 `Buffer`。
 *
 * 代价是 PDF 路径多一次最多 32 MiB 的拷贝（受 `maxFileBytes` 约束），
 * 换来的是"字节在所有解析路径上都保持有效"。
 */
function isolatedCopy(bytes: Uint8Array): Uint8Array {
  const copy = new Uint8Array(bytes.byteLength)
  copy.set(bytes)
  return copy
}

/**
 * 懒加载 `pdfjs-dist` 的 legacy 构建。
 *
 * 用 legacy 构建是实测结论：直接 import 主入口会打印
 * `Warning: Please use the 'legacy' build in Node.js environments.`。
 *
 * 懒加载的意义：`pdfjs-dist` 解压后约 33 MiB（ADR-0001 §4），只有真的解析 PDF 时才
 * 触碰它，markdown/csv 路径不受影响。
 */
async function loadPdfjs(): Promise<PdfjsModuleLike> {
  const module = (await import('pdfjs-dist/legacy/build/pdf.mjs')) as unknown
  return module as PdfjsModuleLike
}

export class PdfjsTextExtractor implements PdfTextExtractor {
  readonly name = 'pdfjs-dist/legacy'

  async extract(bytes: Uint8Array, options: PdfExtractOptions): Promise<PdfExtraction> {
    let pdfjs: PdfjsModuleLike
    try {
      pdfjs = await loadPdfjs()
    } catch (error) {
      // 打包裁剪 / 边缘运行时把依赖剥掉时的降级：明确说"缺能力"，不抛未捕获异常。
      throw new DocumentParseError(
        DOCUMENT_DIAGNOSTIC_CODES.formatNotSupported,
        `当前运行环境没有可用的 PDF 解析库（pdfjs-dist 加载失败：${error instanceof Error ? error.message : String(error)}）；`
        + '请安装 pdfjs-dist 后重试，或先把 PDF 转换为 markdown / 文本再导入。',
      )
    }

    const loadingTask = pdfjs.getDocument({
      // 必须传副本：pdfjs 会 detach 传入的 buffer，且拒绝 Buffer。见 isolatedCopy。
      data: isolatedCopy(bytes),
      // 禁止库内部走 eval 路径（§5.6.5 A「拒绝执行 PDF 中的 JavaScript」）。
      isEvalSupported: false,
      // 文本提取不需要字体渲染与系统字体，关掉可省下大量内存与时间。
      useSystemFonts: false,
      disableFontFace: true,
      disableAutoFetch: true,
      disableStream: true,
      verbosity: 0,
    })

    let document: PdfjsDocumentLike
    try {
      document = await loadingTask.promise
    } catch (error) {
      await safeDestroy(loadingTask)
      throw mapPdfjsError(error)
    }

    try {
      const pageCount = document.numPages
      const range = pageRangeWithin(pageCount, options.pageRange)
      if (range.from > range.to) {
        throw limitExceeded(
          `请求的页码范围 ${describeRange(options.pageRange)} 超出文档页数 ${pageCount}，没有可读取的页。`,
        )
      }
      const requested = range.to - range.from + 1
      if (requested > options.maxPages) {
        throw limitExceeded(
          `本次请求读取 ${requested} 页，超过页数上限 ${options.maxPages}；请用 pageRange 缩小范围后重试。`,
        )
      }

      const pages: PdfPageText[] = []
      for (let page = range.from; page <= range.to; page += 1) {
        if (options.signal.aborted) {
          throw new DocumentParseError(DOCUMENT_DIAGNOSTIC_CODES.aborted, 'PDF 解析被取消。')
        }
        const handle = await document.getPage(page)
        try {
          const content = await handle.getTextContent()
          pages.push({ page, items: toItems(content.items) })
        } finally {
          handle.cleanup()
        }
      }

      return { pageCount, pages, encrypted: containsBytes(bytes, asciiBytes('/Encrypt')) }
    } finally {
      await safeDestroy(loadingTask)
    }
  }
}

/** `destroy()` 失败不该覆盖真正的错误，也不该让调用方以为解析成功。 */
async function safeDestroy(task: PdfjsLoadingTaskLike): Promise<void> {
  try {
    await task.destroy()
  } catch {
    // 释放失败不影响已取到的结果；资源由进程回收。
  }
}

/**
 * pdfjs 异常 → 结构化失败。
 *
 * 实测（ADR-0001）：加密 PDF 抛 `PasswordException`（`No password given` /
 * `Incorrect Password`）；损坏 PDF 抛 `InvalidPDFException`（`Invalid PDF structure.`）。
 * 因此按 `name` 判别，不依赖库内部类（换库时这段仍成立）。
 */
function mapPdfjsError(error: unknown): DocumentParseError {
  const name = (error as { name?: unknown } | null)?.name
  const message = error instanceof Error ? error.message : String(error)
  if (name === 'PasswordException') {
    return new DocumentParseError(
      DOCUMENT_DIAGNOSTIC_CODES.documentEncrypted,
      'PDF 受密码保护，无法读取内容；请提供未加密版本，或先用 PDF 工具解除保护后再导入。',
    )
  }
  if (name === 'InvalidPDFException') {
    return new DocumentParseError(
      DOCUMENT_DIAGNOSTIC_CODES.structuredParseFailed,
      `PDF 结构无效，无法解析：${message}`,
    )
  }
  return new DocumentParseError(
    DOCUMENT_DIAGNOSTIC_CODES.structuredParseFailed,
    `PDF 解析失败：${message}`,
  )
}

/** 把 pdfjs 的文本项收窄成我们需要的形状（`TextMarkedContent` 之类没有 `str`，丢弃）。 */
function toItems(raw: readonly unknown[]): readonly PdfTextItem[] {
  const items: PdfTextItem[] = []
  for (const entry of raw) {
    if (entry === null || typeof entry !== 'object') continue
    const candidate = entry as { str?: unknown; transform?: unknown; hasEOL?: unknown }
    if (typeof candidate.str !== 'string') continue
    const transform = Array.isArray(candidate.transform) ? candidate.transform : []
    const x = typeof transform[4] === 'number' ? transform[4] : 0
    const y = typeof transform[5] === 'number' ? transform[5] : 0
    items.push({ text: candidate.str, x, y, eol: candidate.hasEOL === true })
  }
  return items
}

/** 页码范围求交：1-based 闭区间；`from` 缺省为 1，`to` 缺省为末页。 */
function pageRangeWithin(
  pageCount: number,
  pageRange: PdfExtractOptions['pageRange'],
): { readonly from: number; readonly to: number } {
  const from = Math.max(1, pageRange?.from ?? 1)
  const to = Math.min(pageCount, pageRange?.to ?? pageCount)
  return { from, to }
}

function describeRange(pageRange: PdfExtractOptions['pageRange']): string {
  if (pageRange === undefined) return '(未指定)'
  return `${pageRange.from ?? 1}-${pageRange.to ?? '末页'}`
}

// ── 字节级工具（避免为 32 MiB 文件分配一个等长字符串）──────────────────────────

function asciiBytes(text: string): Uint8Array {
  const out = new Uint8Array(text.length)
  for (let index = 0; index < text.length; index += 1) out[index] = text.charCodeAt(index) & 0xff
  return out
}

function containsBytes(haystack: Uint8Array, needle: Uint8Array): boolean {
  return indexOfBytes(haystack, needle) >= 0
}

function indexOfBytes(haystack: Uint8Array, needle: Uint8Array): number {
  if (needle.length === 0 || haystack.length < needle.length) return -1
  const first = needle[0]!
  const last = haystack.length - needle.length
  outer: for (let start = 0; start <= last; start += 1) {
    if (haystack[start] !== first) continue
    for (let offset = 1; offset < needle.length; offset += 1) {
      if (haystack[start + offset] !== needle[offset]) continue outer
    }
    return start
  }
  return -1
}

// ── 解析器 ───────────────────────────────────────────────────────────────────

export class PdfParser implements DocumentParser {
  readonly format = 'pdf' as const
  readonly name: string
  readonly mediaTypes = ['application/pdf'] as const

  private readonly extractor: PdfTextExtractor

  constructor(extractor: PdfTextExtractor = new PdfjsTextExtractor()) {
    this.extractor = extractor
    this.name = `builtin-pdf:${extractor.name}`
  }

  canParse(input: Readonly<{ path: string; mediaType?: string; magicBytes?: Uint8Array }>): boolean {
    if (formatFromExtension(input.path) === 'pdf') return true
    const magic = input.magicBytes
    if (magic === undefined) return false
    return PDF_MAGIC.every((value, index) => magic[index] === value)
  }

  async parse(request: DocumentParseRequest, context: DocumentParserContext): Promise<ParsedDocument> {
    const diagnostics: DocumentDiagnostic[] = []

    // magic bytes 校验（扩展名不可信；§5.6.5 A 第一条）。
    if (!containsBytes(context.bytes, asciiBytes('%PDF-'))) {
      throw new DocumentParseError(
        DOCUMENT_DIAGNOSTIC_CODES.formatMismatch,
        '文件头不含 %PDF- 签名，无法按 PDF 解析。',
      )
    }

    const dangerous = DANGEROUS_PDF_FEATURES.filter(feature => containsBytes(context.bytes, asciiBytes(feature.needle)))
    if (dangerous.length > 0) {
      diagnostics.push(diagnostic(
        DOCUMENT_DIAGNOSTIC_CODES.dangerousPartRemoved,
        'warning',
        `文档含 ${dangerous.map(feature => feature.reason).join('、')}：解析器不执行任何 PDF 动作、不下载外链、不打开嵌入附件，`
        + '这些特性只被记录，不会生效。',
        context.relativePath,
      ))
    }

    const extraction = await this.extractor.extract(context.bytes, {
      ...(request.pageRange === undefined ? {} : { pageRange: request.pageRange }),
      maxPages: context.limits.maxPages,
      signal: context.signal,
    })

    if (extraction.encrypted) {
      diagnostics.push(diagnostic(
        DOCUMENT_DIAGNOSTIC_CODES.documentEncrypted,
        'info',
        '文档带加密字典（/Encrypt），本次以空用户密码成功读取；若正文异常请确认是否缺少解密凭据。',
        context.relativePath,
      ))
    }

    const sections: ParsedSection[] = []
    const pageTexts: string[] = []
    let emptyPages = 0
    for (const page of extraction.pages) {
      const text = renderPageText(page.items)
      if (text.trim() === '') emptyPages += 1
      pageTexts.push(text)
      // 每页一个 section：页码就是最自然、也是唯一可靠的 PDF 结构单位。
      if (text.trim() === '') continue
      sections.push({
        id: `section-${sections.length + 1}`,
        title: `第 ${page.page} 页`,
        order: sections.length,
        text,
        page: page.page,
        sourceRef: sourceRef(context.relativePath, `page=${page.page}`),
      })
    }

    const suspectPages = extraction.pages.filter(page => textOrderSuspect(page.items))
    if (suspectPages.length > 0) {
      diagnostics.push(diagnostic(
        DOCUMENT_DIAGNOSTIC_CODES.textOrderSuspect,
        'warning',
        `第 ${suspectPages.map(page => page.page).join(', ')} 页的文本位置顺序异常（同一页内基线多次回跳，常见于多栏排版或浮动文本框）：`
        + '提取出的行序可能与阅读顺序不一致，引用时请核对原文。',
        context.relativePath,
      ))
    }

    if (emptyPages === extraction.pages.length) {
      // 扫描件：没有文本层。绝不返回"解析成功但内容为空"。
      diagnostics.push(diagnostic(
        DOCUMENT_DIAGNOSTIC_CODES.noTextLayer,
        'error',
        `已读取 ${extraction.pages.length} 页，但没有提取到任何文本（疑似扫描件或纯图片 PDF）。`
        + '本环境未接入 OCR，请改用带文本层的 PDF，或先做 OCR 后再导入。',
        context.relativePath,
      ))
    } else if (emptyPages > 0) {
      diagnostics.push(diagnostic(
        DOCUMENT_DIAGNOSTIC_CODES.noTextLayer,
        'warning',
        `有 ${emptyPages} 页没有可提取文本（共 ${extraction.pages.length} 页），这些页可能是图片或扫描件。`,
        context.relativePath,
      ))
    }

    if (request.includeTables !== false) {
      diagnostics.push(diagnostic(
        DOCUMENT_DIAGNOSTIC_CODES.tableExtractionUnavailable,
        'info',
        'PDF 不含表格语义，本解析器不产出结构化表格：任何"表格"都只能是布局推断，'
        + '按 §5.6.5 A 不得把不稳定的文本布局硬拼成准确表格。请使用页文本与 sourceRef。',
        context.relativePath,
      ))
    }

    const confidence: ContentConfidence = 'structure-preserved'
    // 只要有任意一页读不到文本就只能是 partial：我们确实没有完整提取这份文档。
    const status = emptyPages === 0 ? 'parsed' : 'partial'

    return {
      status,
      format: 'pdf',
      fileName: context.relativePath.split('/').pop() ?? context.relativePath,
      mediaType: 'application/pdf',
      sha256: context.sha256,
      pageCount: extraction.pageCount,
      sections,
      tables: [],
      metadata: pdfMetadata(context.bytes, extraction.pageCount, extraction.pages.length),
      plainText: pageTexts.filter(text => text.trim() !== '').join('\n'),
      // 有意不提供 rawSource：PDF 的原始字节是二进制，回给模型既无用又违反 §5.6.8。
      diagnostics,
      confidence,
      limits: {
        truncated: false,
        pagesRead: extraction.pages.length,
        bytesRead: context.bytes.byteLength,
      },
    }
  }
}

/** 页文本：按 `hasEOL` 断行，保留 PDF 自身的行结构。 */
function renderPageText(items: readonly PdfTextItem[]): string {
  let out = ''
  for (const item of items) {
    out += item.text
    if (item.eol) out += '\n'
  }
  return out.trim()
}

/**
 * 文本顺序是否可疑。
 *
 * PDF 的 y 轴向上增长，正文通常自上而下排列，所以提取顺序里 y 应当**非递增**。
 * 出现明显回跳（y 变大）意味着提取器在页内来回跳块——多栏排版、浮动文本框、
 * 或按对象顺序而非阅读顺序输出的生成器都会这样。
 *
 * 这是**启发式**：只用于给调用方一个"别把这段当线性文本读"的提示，
 * 不改变任何解析结果，也不参与门禁。
 */
function textOrderSuspect(items: readonly PdfTextItem[]): boolean {
  if (items.length < 8) return false
  let backwards = 0
  let comparisons = 0
  for (let index = 1; index < items.length; index += 1) {
    const previous = items[index - 1]!
    const current = items[index]!
    comparisons += 1
    // 容差 1pt：同一行的微小抖动不算回跳。
    if (current.y > previous.y + 1) backwards += 1
  }
  return comparisons > 0 && backwards / comparisons > 0.2
}

/** 从头部取 `%PDF-x.y`，并附上页数与读取页数。 */
function pdfMetadata(
  bytes: Uint8Array,
  pageCount: number,
  pagesRead: number,
): Readonly<Record<string, string | number | boolean | null>> {
  const metadata: Record<string, string | number | boolean | null> = {
    pageCount,
    pagesRead,
  }
  const head = new TextDecoder('latin1').decode(bytes.subarray(0, Math.min(bytes.length, 1024)))
  const version = /%PDF-(\d+\.\d+)/.exec(head)
  if (version?.[1] !== undefined) metadata.pdfVersion = version[1]
  return metadata
}
