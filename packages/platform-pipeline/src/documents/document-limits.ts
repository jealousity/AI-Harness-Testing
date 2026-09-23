/**
 * 文档解析资源上限（docs/10 §5.6.3、§5.6.5、§5.6.10）。
 *
 * 上限分两类，**语义不同，不能混用**：
 * - **硬上限**：超出即拒绝整个解析（文件字节、页数、sheet 数、解压总量、压缩比、
 *   解析超时）。抛 `DocumentParseError(LIMIT_EXCEEDED)` → `status='limit-exceeded'`。
 * - **软上限**：截断并继续，但必须标 `truncated` 与诊断（文本字符数、行数、section/table 数）。
 *   → `status='partial'`。
 *
 * 所有解析器都必须走这里的函数，不允许各自写 `if (x > 100000)` 之类的散装判断。
 *
 * @module platform-pipeline/documents/document-limits
 */

import { DOCUMENT_DIAGNOSTIC_CODES, DocumentParseError, type DocumentLimits } from './document-types.ts'

export type { DocumentLimits } from './document-types.ts'

/**
 * 默认上限。
 *
 * 取值原则是「够用且不可能拖垮单进程」：单文件 32 MiB（比默认 workspace 文档大得多，
 * 又远小于典型 OOM 阈值）、解压总量 256 MiB、压缩比 200:1（正常 OOXML 正文在 10:1 量级，
 * 200:1 只可能出现在刻意构造的 zip bomb 上）。
 */
export const DEFAULT_DOCUMENT_LIMITS: DocumentLimits = {
  maxFileBytes: 32 * 1024 * 1024,
  maxPages: 500,
  maxSheets: 64,
  maxRowsPerSheet: 20_000,
  maxColumnsPerSheet: 512,
  maxCellsPerSheet: 200_000,
  maxZipEntries: 2_048,
  maxZipEntryBytes: 64 * 1024 * 1024,
  maxUncompressedBytes: 256 * 1024 * 1024,
  maxCompressionRatio: 200,
  maxTextChars: 2_000_000,
  maxSections: 5_000,
  maxTables: 500,
  maxTableRows: 5_000,
  maxTableColumns: 256,
  timeoutMs: 30_000,
}

/** 覆盖部分上限；非法值（非正整数）直接报错，不静默回退默认值。 */
export function resolveDocumentLimits(partial?: Partial<DocumentLimits>): DocumentLimits {
  if (partial === undefined) return DEFAULT_DOCUMENT_LIMITS
  const merged: Record<string, number> = { ...DEFAULT_DOCUMENT_LIMITS }
  for (const [key, value] of Object.entries(partial)) {
    if (value === undefined) continue
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error(`document limit "${key}" must be a positive integer`)
    }
    merged[key] = value
  }
  return merged as unknown as DocumentLimits
}

/** 硬上限：超出即拒绝解析。 */
export function limitExceeded(message: string, location?: string): DocumentParseError {
  return new DocumentParseError(DOCUMENT_DIAGNOSTIC_CODES.limitExceeded, message, location)
}

/** 文件字节硬上限（解析前就要判，避免把超大文件读进内存）。 */
export function assertFileSize(bytes: number, limits: DocumentLimits): void {
  if (bytes > limits.maxFileBytes) {
    throw limitExceeded(`文档 ${bytes} 字节超过上限 ${limits.maxFileBytes} 字节`)
  }
}

/** 软上限：截断文本并返回是否发生截断。 */
export function capText(text: string, limits: DocumentLimits): { readonly text: string; readonly truncated: boolean } {
  if (text.length <= limits.maxTextChars) return { text, truncated: false }
  return { text: text.slice(0, limits.maxTextChars), truncated: true }
}

/** 软上限：截断数组。 */
export function capList<T>(values: readonly T[], max: number): { readonly values: readonly T[]; readonly truncated: boolean } {
  if (values.length <= max) return { values, truncated: false }
  return { values: values.slice(0, max), truncated: true }
}

/**
 * 逐项累计上限（页/sheet/行/单元格）。
 *
 * 用法：`const budget = new LimitBudget('sheet', limits.maxSheets)`，每处理一项
 * `budget.take()`，超限时抛 `LIMIT_EXCEEDED`。
 */
export class LimitBudget {
  private readonly label: string
  private readonly max: number
  private used = 0

  constructor(label: string, max: number) {
    this.label = label
    this.max = max
  }

  /** 占用一个额度；超限抛错。 */
  take(amount = 1): void {
    this.used += amount
    if (this.used > this.max) {
      throw limitExceeded(`${this.label} 数量超过上限 ${this.max}`)
    }
  }

  get count(): number {
    return this.used
  }

  get limit(): number {
    return this.max
  }
}

/**
 * 解压条目校验（防 zip bomb，docs/10 §5.6.5 B）。
 *
 * 三层判据缺一不可：
 * 1. 条目数上限——拦「几万个空文件」；
 * 2. 单条目解压后大小上限——拦「单个巨大 XML」；
 * 3. 总解压量 + 压缩比上限——拦「小文件解压成几个 G」。
 *
 * 注意：**必须用压缩后真实字节数**算压缩比。Office 的 `[Content_Types].xml` 之类
 * 小文件压缩比天然很高（可达 50:1），所以压缩比只在累计解压量超过
 * `maxUncompressedBytes / maxCompressionRatio` 的基线后才参与判定，避免误杀正常文档。
 */
export function assertZipEntryWithinLimits(
  entryName: string,
  compressedBytes: number,
  uncompressedBytes: number,
  totals: { readonly entries: number; readonly uncompressedBytes: number },
  limits: DocumentLimits,
): void {
  if (totals.entries > limits.maxZipEntries) {
    throw limitExceeded(`压缩包条目数 ${totals.entries} 超过上限 ${limits.maxZipEntries}`, entryName)
  }
  if (uncompressedBytes > limits.maxZipEntryBytes) {
    throw limitExceeded(`压缩包条目 ${entryName} 解压后 ${uncompressedBytes} 字节超过单条目上限 ${limits.maxZipEntryBytes}`, entryName)
  }
  if (totals.uncompressedBytes > limits.maxUncompressedBytes) {
    throw limitExceeded(`压缩包解压总量 ${totals.uncompressedBytes} 字节超过上限 ${limits.maxUncompressedBytes}`, entryName)
  }
  const baseline = Math.floor(limits.maxUncompressedBytes / limits.maxCompressionRatio)
  if (compressedBytes > 0 && totals.uncompressedBytes > baseline
    && totals.uncompressedBytes / compressedBytes > limits.maxCompressionRatio) {
    throw limitExceeded(
      `压缩包压缩比 ${Math.round(totals.uncompressedBytes / compressedBytes)}:1 超过上限 ${limits.maxCompressionRatio}:1`,
      entryName,
    )
  }
}

/**
 * 合并「调用方 AbortSignal」与「解析超时」。
 *
 * 返回的组合信号在任一条件触发时 abort，`reason` 区分来源，便于注册表映射
 * `PARSE_ABORTED` / `PARSE_TIMEOUT`。必须调用 `dispose()` 清掉定时器，
 * 否则大文档批量解析会积压大量待触发定时器。
 */
export function withParseTimeout(
  signal: AbortSignal,
  timeoutMs: number,
): { readonly signal: AbortSignal; readonly reason: () => 'caller' | 'timeout' | null; readonly dispose: () => void } {
  const controller = new AbortController()
  let cause: 'caller' | 'timeout' | null = null
  const abort = (next: 'caller' | 'timeout'): void => {
    if (cause === null) cause = next
    controller.abort()
  }
  const onCallerAbort = (): void => { abort('caller') }
  if (signal.aborted) abort('caller')
  else signal.addEventListener('abort', onCallerAbort, { once: true })
  const timer = setTimeout(() => { abort('timeout') }, timeoutMs)
  // 不要让解析超时把整个进程的退出拖住。
  if (typeof timer === 'object' && 'unref' in timer) timer.unref()
  return {
    signal: controller.signal,
    reason: () => cause,
    dispose: () => {
      clearTimeout(timer)
      signal.removeEventListener('abort', onCallerAbort)
    },
  }
}
