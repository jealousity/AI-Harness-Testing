/**
 * OOXML 安全解包（docs/10 §5.6.5 B/C、§5.6.8、ADR-0001 §6）。
 *
 * DOCX/XLSX 都是 ZIP 容器。本模块是唯一的解包入口，安全性质全部在这里落地：
 *
 * 1. **部件白名单**：只解压本次真正要读的部件（`accept` 谓词）。图片、字体、宏、
 *    嵌入对象因此在解压阶段就出局——**不解压的字节不可能造成危害**。
 *    这是防 zip bomb 的主要防线（ADR-0001 §6 实测：白名单下炸弹条目零输出）。
 * 2. **不信任 central directory 的声明值**：ZIP 头里的大小是可以伪造的（deflate 理论
 *    最大压缩比约 1032:1，32 MiB 输入最坏可膨胀到 ~33 GiB）。因此除了用声明值做一次
 *    廉价预检，还在 `ondata` 里逐块累计**实际**解压字节数，超限即中断该条目。
 * 3. **路径穿越即拒绝整个归档**：`assertSafeArchiveEntry` 不合格直接失败。虽然本模块
 *    **只解压到内存、从不落盘**（因此路径穿越不可利用），但拒绝畸形归档能避免
 *    "把恶意文档当正常文档解析"。
 * 4. **全内存**：不创建临时目录，因此 §5.6.8 的"解压目录必须隔离并清理"天然满足。
 *
 * @module platform-pipeline/documents/zip-reader
 */

import { Unzip, UnzipInflate, UnzipPassThrough } from 'fflate'

import { DOCUMENT_DIAGNOSTIC_CODES, DocumentParseError, type DocumentDiagnostic, type DocumentLimits } from './document-types.ts'
import { isZipContainer } from './document-detect.ts'
import { assertSafeArchiveEntry, classifyDangerousPart, dangerousPartDiagnostics } from './document-sanitize.ts'
import { attr, childrenNamed, parseXml, type XmlLimits } from './xml.ts'

export interface ReadOoxmlPartsOptions {
  /** 部件白名单：返回 false 的部件**不会被解压**。 */
  readonly accept: (name: string) => boolean
  readonly limits: DocumentLimits
  /** 相对工作区根的路径，仅用于诊断定位。 */
  readonly path: string
  readonly signal: AbortSignal
}

export interface OoxmlParts {
  readonly parts: ReadonlyMap<string, Uint8Array>
  readonly diagnostics: readonly DocumentDiagnostic[]
  /** 被白名单排除的部件名（不含危险部件，危险部件单独统计）。 */
  readonly ignored: readonly string[]
  /** 实际解压出的总字节数。 */
  readonly uncompressedBytes: number
  /** 归档内条目总数（含被跳过的）。 */
  readonly entryCount: number
}

/**
 * 读取 OOXML 归档中白名单内的部件。
 *
 * 失败语义（抛 `DocumentParseError`，由注册表映射为 `status`）：
 * - 不是 ZIP 容器 → `parse-failed`；
 * - 条目名不安全（路径穿越/绝对路径/控制字符）→ `parse-failed`；
 * - 条目数/单条目大小/累计解压量超限 → `limit-exceeded`；
 * - 被取消 → `parse-failed`（诊断码 `PARSE_ABORTED`，注册表侧不覆盖已给出的诊断）。
 */
export function readOoxmlParts(bytes: Uint8Array, options: ReadOoxmlPartsOptions): OoxmlParts {
  if (!isZipContainer(bytes)) {
    throw new DocumentParseError(
      DOCUMENT_DIAGNOSTIC_CODES.structuredParseFailed,
      '文件不是 ZIP 容器（缺少 PK 签名），无法按 OOXML 解包。',
      options.path,
    )
  }

  const limits = options.limits
  const parts = new Map<string, Uint8Array>()
  const ignored: string[] = []
  const dangerousNames: string[] = []
  let entryCount = 0
  let uncompressedBytes = 0
  let fatal: DocumentParseError | null = null
  let overflow: DocumentParseError | null = null

  const fail = (error: DocumentParseError): void => {
    if (fatal === null) fatal = error
  }

  const unzip = new Unzip((file) => {
    if (fatal !== null) return
    entryCount += 1

    if (options.signal.aborted) {
      fail(new DocumentParseError(DOCUMENT_DIAGNOSTIC_CODES.aborted, '解包被调用方取消。', options.path))
      return
    }
    if (entryCount > limits.maxZipEntries) {
      fail(new DocumentParseError(
        DOCUMENT_DIAGNOSTIC_CODES.limitExceeded,
        `压缩包条目数超过上限 ${limits.maxZipEntries}`,
        options.path,
      ))
      return
    }

    // 目录条目本身无内容，跳过（不调用 start()）。
    if (file.name.endsWith('/')) return

    try {
      assertSafeArchiveEntry(file.name)
    } catch (error) {
      fail(error instanceof DocumentParseError
        ? error
        : new DocumentParseError(DOCUMENT_DIAGNOSTIC_CODES.structuredParseFailed, String(error), options.path))
      return
    }

    if (classifyDangerousPart(file.name) !== undefined) {
      dangerousNames.push(file.name)
      return
    }
    if (!options.accept(file.name)) {
      ignored.push(file.name)
      return
    }

    // 廉价预检：用声明值先挡掉明显超限的条目（快速失败）。声明值不可信，
    // 真正的硬上限在 ondata 里按实际字节数执行。
    if (file.originalSize !== undefined && file.originalSize > limits.maxZipEntryBytes) {
      fail(new DocumentParseError(
        DOCUMENT_DIAGNOSTIC_CODES.limitExceeded,
        `压缩包条目 ${file.name} 声明解压后 ${file.originalSize} 字节，超过单条目上限 ${limits.maxZipEntryBytes}`,
        options.path,
      ))
      return
    }

    const chunks: Uint8Array[] = []
    let received = 0
    file.ondata = (error, chunk, final) => {
      if (error) {
        // fflate 会把 ondata 抛出的错误回调回来；也可能回报解压本身的错误。
        overflow = overflow ?? new DocumentParseError(
          DOCUMENT_DIAGNOSTIC_CODES.limitExceeded,
          `压缩包条目 ${file.name} 解压中止：${error.message}`,
          options.path,
        )
        return
      }
      if (overflow !== null) return
      received += chunk.length
      uncompressedBytes += chunk.length
      if (received > limits.maxZipEntryBytes || uncompressedBytes > limits.maxUncompressedBytes) {
        const message = received > limits.maxZipEntryBytes
          ? `压缩包条目 ${file.name} 实际解压 ${received} 字节，超过单条目上限 ${limits.maxZipEntryBytes}`
          : `压缩包解压总量 ${uncompressedBytes} 字节，超过上限 ${limits.maxUncompressedBytes}`
        // 抛出后 fflate 会以错误回调终止该条目，条目不会进入 parts。
        throw new DocumentParseError(DOCUMENT_DIAGNOSTIC_CODES.limitExceeded, message, options.path)
      }
      chunks.push(chunk)
      if (final) parts.set(file.name, concat(chunks, received))
    }
    file.start()
  })

  unzip.register(UnzipPassThrough)
  unzip.register(UnzipInflate)

  let pushError: unknown
  try {
    unzip.push(bytes, true)
  } catch (error) {
    pushError = error
  }

  if (fatal !== null) throw fatal
  if (overflow !== null) throw overflow
  if (pushError !== undefined) {
    throw pushError instanceof DocumentParseError
      ? pushError
      : new DocumentParseError(
        DOCUMENT_DIAGNOSTIC_CODES.structuredParseFailed,
        `ZIP 解包失败：${pushError instanceof Error ? pushError.message : String(pushError)}`,
        options.path,
      )
  }

  const diagnostics: DocumentDiagnostic[] = [...dangerousPartDiagnostics(dangerousNames)]
  return { parts, diagnostics, ignored, uncompressedBytes, entryCount }
}

function concat(chunks: readonly Uint8Array[], total: number): Uint8Array {
  if (chunks.length === 1) return chunks[0]!
  const out = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.length
  }
  return out
}

/** 用 UTF-8 解码部件文本；去掉 BOM（OOXML 部件可能带 BOM）。 */
export function partText(parts: ReadonlyMap<string, Uint8Array>, name: string): string | undefined {
  const bytes = parts.get(name)
  if (bytes === undefined) return undefined
  const text = new TextDecoder('utf-8').decode(bytes)
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
}

/**
 * 解析 OPC 关系文件（`*.rels`）：`Id` → 目标部件名。
 *
 * `TargetMode="External"` 的关系（外链、外部图片）**只登记不解析**——它们既不会
 * 被下载，也不会出现在返回的映射里，避免调用方误以为拿到了可读内容。
 */
/**
 * OPC 关系（`*.rels`）。
 *
 * `external: true` 的关系（外链工作簿、外部图片）**只登记不解析**：它们既不会被下载，
 * 也不会进入目标映射，避免调用方误以为拿到了可读内容。
 */
export interface OoxmlRelationship {
  readonly id: string
  readonly target: string
  readonly type: string
  readonly external: boolean
}

/**
 * 解析 `*.rels` 部件。只读取 `Relationship` 元素，不做任何网络访问。
 */
export function parseRelationships(
  xml: string,
  path: string,
  limits?: XmlLimits,
): { readonly relationships: readonly OoxmlRelationship[]; readonly diagnostics: readonly DocumentDiagnostic[] } {
  const parsed = parseXml(xml, path, limits)
  const relationships: OoxmlRelationship[] = []
  if (parsed.root === undefined) return { relationships, diagnostics: parsed.diagnostics }
  for (const element of childrenNamed(parsed.root, 'Relationship')) {
    const id = attr(element, 'Id')
    const target = attr(element, 'Target')
    if (id === undefined || target === undefined) continue
    relationships.push({
      id,
      target,
      type: attr(element, 'Type') ?? '',
      external: (attr(element, 'TargetMode') ?? '').toLocaleLowerCase() === 'external',
    })
  }
  return { relationships, diagnostics: parsed.diagnostics }
}

/**
 * 把关系目标解析成归档内的部件名。
 *
 * - `Target="/xl/worksheets/sheet1.xml"` → `xl/worksheets/sheet1.xml`（绝对部件名）；
 * - `Target="worksheets/sheet1.xml"`（相对 `xl/_rels/workbook.xml.rels` 的 base 为 `xl/`）
 *   → `xl/worksheets/sheet1.xml`。
 *
 * 越出归档根（`..` 逃逸）返回 undefined——**不猜测、不修正**。
 */
export function resolveRelationshipTarget(baseDir: string, target: string): string | undefined {
  if (target === '') return undefined
  const absolute = target.startsWith('/')
  const combined = absolute ? target.slice(1) : `${baseDir}/${target}`
  const segments: string[] = []
  for (const segment of combined.split('/')) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') {
      if (segments.length === 0) return undefined
      segments.pop()
      continue
    }
    segments.push(segment)
  }
  return segments.length === 0 ? undefined : segments.join('/')
}

/**
 * `Id` → 归档内部件名。外链关系与无法解析的目标都被排除，
 * 调用方拿到的一定是归档内真实存在的部件名候选。
 */
export function resolveRelationshipTargets(
  relationships: readonly OoxmlRelationship[],
  baseDir: string,
): ReadonlyMap<string, string> {
  const out = new Map<string, string>()
  for (const relationship of relationships) {
    if (relationship.external) continue
    const resolved = resolveRelationshipTarget(baseDir, relationship.target)
    if (resolved !== undefined) out.set(relationship.id, resolved)
  }
  return out
}
