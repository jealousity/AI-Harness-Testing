/**
 * 文档解析的安全化处理（docs/10 §5.6.3、§5.6.5、§5.6.8）。
 *
 * 覆盖四件事：
 * 1. **文件名安全化**：上传文件名只用于展示与诊断，**绝不参与存储路径**；
 * 2. **压缩包条目名校验**：拒绝绝对路径、`..`、反斜杠与控制字符（防路径穿越）；
 * 3. **危险 OOXML 部件识别**：宏、OLE/嵌入对象、ActiveX、外部链接一律**不解析**
 *    并记诊断——不是"解析后忽略"，而是根本不进入解析流程；
 * 4. **隔离临时目录与日志摘要**：解压只落临时目录、必须清理、清理失败要记录；
 *    日志只写 hash 与计数，**永不写文档全文**（文档可能含密码/token/身份证号）。
 *
 * @module platform-pipeline/documents/document-sanitize
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { DOCUMENT_DIAGNOSTIC_CODES, DocumentParseError, type DocumentDiagnostic, type ParsedDocument } from './document-types.ts'

/** 存储名长度上限（保留原始扩展名需要余量）。 */
const MAX_FILE_NAME_LENGTH = 128
/** 压缩包条目名长度上限。 */
const MAX_ARCHIVE_ENTRY_LENGTH = 512

/**
 * 安全化文件名：只保留 basename，剥掉路径分隔符与控制字符。
 *
 * 结果**只用于展示与诊断**。真正的存储路径由 `inputId` 决定（docs/10 §5.6.8
 * 「上传文件名不能决定实际存储路径」）。
 */
export function sanitizeFileName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? ''
  const cleaned = base
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/^\.+/, '')
    .trim()
  if (cleaned === '') return 'document'
  if (cleaned.length <= MAX_FILE_NAME_LENGTH) return cleaned
  const dot = cleaned.lastIndexOf('.')
  const extension = dot > 0 && cleaned.length - dot <= 16 ? cleaned.slice(dot) : ''
  return `${cleaned.slice(0, MAX_FILE_NAME_LENGTH - extension.length)}${extension}`
}

/**
 * 校验压缩包条目名。任何一条不合格即拒绝整个归档——
 * 宁可 `parse-failed`，也不要在解压阶段被路径穿越写到隔离目录之外。
 */
export function assertSafeArchiveEntry(name: string): void {
  if (name === '' || name.length > MAX_ARCHIVE_ENTRY_LENGTH) {
    throw new DocumentParseError(DOCUMENT_DIAGNOSTIC_CODES.dangerousPartRemoved, `压缩包条目名长度非法：${name.slice(0, 64)}`)
  }
  if (name.includes('\0') || name.includes('\\')) {
    throw new DocumentParseError(DOCUMENT_DIAGNOSTIC_CODES.dangerousPartRemoved, `压缩包条目名含非法字符：${name}`)
  }
  if (name.startsWith('/') || /^[A-Za-z]:/.test(name)) {
    throw new DocumentParseError(DOCUMENT_DIAGNOSTIC_CODES.dangerousPartRemoved, `压缩包条目使用绝对路径：${name}`)
  }
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(name)) {
    throw new DocumentParseError(DOCUMENT_DIAGNOSTIC_CODES.dangerousPartRemoved, `压缩包条目名含控制字符：${name}`)
  }
  const segments = name.split('/')
  if (segments.some(segment => segment === '..' || segment === '.')) {
    throw new DocumentParseError(DOCUMENT_DIAGNOSTIC_CODES.dangerousPartRemoved, `压缩包条目名包含路径穿越：${name}`)
  }
  if (segments.some(segment => segment === '')) {
    throw new DocumentParseError(DOCUMENT_DIAGNOSTIC_CODES.dangerousPartRemoved, `压缩包条目名含空路径段：${name}`)
  }
}

/** 危险部件类别。 */
export type DangerousPartKind = 'macro' | 'ole-object' | 'embedded' | 'activex' | 'external-link'

export interface DangerousPart {
  readonly kind: DangerousPartKind
  readonly pattern: RegExp
  readonly reason: string
}

/**
 * 危险 OOXML 部件。命中即**跳过且不解析**，并产出一条诊断。
 *
 * 判定基于 OPC 规范里的固定部件路径，不做内容嗅探——固定路径足以覆盖宏、
 * 嵌入对象、ActiveX 与外部链接这四类唯一需要执行/联网才能生效的东西。
 */
export const DANGEROUS_PARTS: readonly DangerousPart[] = [
  { kind: 'macro', pattern: /(^|\/)vbaProject\.bin$/i, reason: 'VBA 宏工程' },
  { kind: 'macro', pattern: /(^|\/)vbaData\.xml$/i, reason: 'VBA 宏数据' },
  { kind: 'activex', pattern: /(^|\/)activeX(\/|$)/i, reason: 'ActiveX 控件' },
  { kind: 'activex', pattern: /(^|\/)ctrlProps\//i, reason: 'ActiveX 控件属性' },
  { kind: 'ole-object', pattern: /(^|\/)oleObject[^/]*$/i, reason: 'OLE 嵌入对象' },
  { kind: 'embedded', pattern: /(^|\/)embeddings\//i, reason: '嵌入文件' },
  { kind: 'embedded', pattern: /(^|\/)attachments\//i, reason: '嵌入附件' },
  { kind: 'external-link', pattern: /(^|\/)externalLinks\//i, reason: '外部工作簿链接' },
]

/** 命中危险部件则返回其类别，否则 undefined。 */
export function classifyDangerousPart(entryName: string): DangerousPart | undefined {
  return DANGEROUS_PARTS.find(part => part.pattern.test(entryName))
}

/** 为一批被跳过的危险部件生成诊断（按类别聚合，避免几十条重复警告）。 */
export function dangerousPartDiagnostics(entryNames: readonly string[]): readonly DocumentDiagnostic[] {
  const byKind = new Map<DangerousPartKind, { reason: string; count: number }>()
  for (const name of entryNames) {
    const part = classifyDangerousPart(name)
    if (part === undefined) continue
    const current = byKind.get(part.kind)
    byKind.set(part.kind, { reason: part.reason, count: (current?.count ?? 0) + 1 })
  }
  return [...byKind].map(([kind, value]) => ({
    code: DOCUMENT_DIAGNOSTIC_CODES.dangerousPartRemoved,
    severity: 'warning' as const,
    message: `已跳过 ${value.count} 个${value.reason}部件（${kind}）：解析器不执行宏、脚本、嵌入对象或外部链接。`,
  }))
}

/**
 * 在系统临时目录下创建隔离目录。
 *
 * 用 `mkdtemp` 保证目录名不可预测（防符号链接抢占），且**不放在项目 workspace 内**，
 * 因此解压产物不可能被误当成项目文件（docs/10 §5.6.8「所有解压目录必须在临时隔离目录」）。
 */
export async function createIsolatedTempDir(prefix = 'pp-doc-'): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix))
}

/**
 * 清理隔离目录。清理失败**不吞掉**，交给 `onFailure` 记录（docs/10 §5.6.8
 * 「清理失败要记录」），由宿主决定写日志还是写审计。
 */
export async function disposeTempDir(dir: string, onFailure?: (error: unknown, dir: string) => void): Promise<void> {
  try {
    await rm(dir, { recursive: true, force: true })
  } catch (error) {
    onFailure?.(error, dir)
  }
}

/** 日志安全的文档摘要。**不含 `plainText` / `rawSource` / 任何正文片段。** */
export interface DocumentLogSummary {
  readonly status: ParsedDocument['status']
  readonly format: ParsedDocument['format']
  readonly fileName: string
  readonly sha256: string
  readonly confidence: ParsedDocument['confidence']
  readonly sectionCount: number
  readonly tableCount: number
  readonly plainTextChars: number
  readonly diagnosticCodes: readonly string[]
  readonly truncated: boolean
}

/**
 * 生成日志摘要。
 *
 * 有意只暴露计数与 hash：文档可能包含密码、token、身份证号，日志写全文
 * 等于把敏感信息复制到日志系统（docs/10 §5.6.8 最后一条）。
 */
export function documentLogSummary(doc: ParsedDocument): DocumentLogSummary {
  return {
    status: doc.status,
    format: doc.format,
    fileName: doc.fileName,
    sha256: doc.sha256,
    confidence: doc.confidence,
    sectionCount: doc.sections.length,
    tableCount: doc.tables.length,
    plainTextChars: doc.plainText.length,
    diagnosticCodes: [...new Set(doc.diagnostics.map(item => item.code))].sort(),
    truncated: doc.limits.truncated,
  }
}

/** 便于解析器统一给出「危险部件被忽略」的诊断。 */
export function ignoredPartDiagnostic(message: string, location?: string): DocumentDiagnostic {
  return location === undefined
    ? { code: DOCUMENT_DIAGNOSTIC_CODES.embeddedObjectsIgnored, severity: 'warning', message }
    : { code: DOCUMENT_DIAGNOSTIC_CODES.embeddedObjectsIgnored, severity: 'warning', message, location }
}
