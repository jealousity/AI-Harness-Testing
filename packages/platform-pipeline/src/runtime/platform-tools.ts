/**
 * 平台标准工具集的无 Harness 实现（`tool-catalog.ts` 声明的抽象工具名 → 通用实现）。
 *
 * 为什么必须有这个模块：平台 ACL（`tool-catalog.ts`）按**设计文档定义的工具名**声明
 * allow/deny——analyze 允许 `kb_query`/`case_query`、execute 允许 `executor_run`/`env_diag`、
 * archive 允许 `kb_write`/`case_archive`、receive 允许 `parse_doc`。宿主只注册 `fs_read`/`fs_write`
 * 时，这些阶段拿到的是空工具集：模型无法检索知识、无法真实执行、无法回写知识库，
 * 流水线即便"能挂起/能续跑"，各阶段的语义也没有真正完成。
 *
 * 实现全部建立在**无框架依赖**的部件之上（`stores/markdown.ts`、`executor/*`、`checkpoint.ts`），
 * 因此同一套工具既能装在通用宿主里，也能被 Harness 宿主复用。
 *
 * 三条贯穿性约束：
 * - **不伪装**：store 未配置时返回 `available: false`，绝不返回"空结果"让模型误判为"库里没有"；
 *   被测服务基址未配置时 `executor_run` 直接报错，不产出伪造的执行记录（docs/08 防线 1）。
 * - **不越权**：一切文件路径经 `WorkspaceScope` 的 realpath 包含性校验；证据与产物只落宿主指定目录。
 * - **不串流水线**：pipelineId 由宿主注入，模型传入的 pipelineId 与宿主不一致时直接拒绝。
 *
 * @module platform-pipeline/runtime/platform-tools
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join, resolve as resolvePath } from 'node:path'

import { artifactPath, loadCheckpoint } from '../checkpoint.ts'
import {
  IDEMPOTENCY_NAMESPACES,
  fileIdempotencyLedger,
  idempotencyDir,
  idempotencyFingerprint,
  idempotencyKey,
} from '../idempotency.ts'
import {
  DEFAULT_DOCUMENT_LIMITS,
  DOCUMENT_DIAGNOSTIC_CODES,
  SUPPORTED_DOCUMENT_FORMATS,
  diagnostic,
  defaultParserRegistry,
  isSupportedDocumentFormat,
  projectKnowledge,
  readFileWithinLimit,
  resolveDocumentLimits,
  type DocumentDiagnostic,
  type DocumentLimits,
  type DocumentParserRegistry,
  type ParsedDocumentLimits,
  type ParsedSection,
  type ParsedTable,
  type ParseStatus,
  type ContentConfidence,
  type SupportedDocumentFormat,
} from '../documents/index.ts'
import { runDiag, type DiagProbe, type DiagSpec } from '../executor/env-diag.ts'
import { HttpExecutor, type HttpCase, type HttpRequestFn, type HttpStep } from '../executor/http.ts'
import type { ExecutionSession } from '../executor/executor.ts'
import { makeRecord, type ExecutionRecord } from '../executor/records.ts'
import type { EvidenceEntry } from '../executor/verify.ts'
import {
  InvocationJournalCorruptError,
  fileInvocationJournal,
  isRetryableAfterSent,
  type InvocationFragment,
  type InvocationPhase,
  type InvocationRecord,
} from '../executor/invocation-journal.ts'
import { FsArtifactStore } from '../stores/fs.ts'
import type {
  ArtifactStore,
  CaseStorePort,
  CheckpointPort,
  KnowledgeStorePort,
} from '../storage/ports.ts'
import {
  KnowledgeConflictError,
  MarkdownCaseStore,
  MarkdownKnowledgeStore,
  type KnowledgeEntry,
  type VersionedCase,
} from '../stores/markdown.ts'
import { WorkspaceScope } from './fs-tools.ts'
import { recordUsage, type UsageSink } from '../usage.ts'
import type { ToolDefinition } from './ports.ts'

/** `parse_doc` 默认单文档字节上限（与 documents 模块的 `maxFileBytes` 默认值同源）。 */
const DEFAULT_MAX_DOCUMENT_BYTES = DEFAULT_DOCUMENT_LIMITS.maxFileBytes
/** `parse_doc` 生成 draft 知识条目时的默认条目上限。 */
const DEFAULT_MAX_DRAFT_ENTRIES = 200
const DEFAULT_KB_LIMIT = 8
const MAX_KB_LIMIT = 50

export interface PlatformToolContext {
  /** 平台项目根：fs 作用域、产物、执行会话与证据目录的共同基准。 */
  readonly projectRoot: string
  /** 产物存储根（= FsArtifactStore 的 baseDir）。 */
  readonly artifactsRoot: string
  readonly pipelineId: string
  readonly projectId: string
  /**
   * 产物端口（docs/11 P1-09）。
   *
   * 宿主从 `StorageBackend.ports` 注入；缺省时回退到 `artifactsRoot` 的文件实现
   * ——那只服务于**不经宿主装配**的调用方（单测、脚本），真实宿主必须注入，
   * 否则换后端时工具会绕过 backend 直接读本地文件。
   */
  readonly artifacts?: ArtifactStore
  /** 知识库端口；缺省回退到 `knowledgeRoot` 的 markdown 实现。 */
  readonly knowledge?: KnowledgeStorePort
  /** 用例库端口；缺省回退到 `casesRoot` 的 markdown 实现。 */
  readonly cases?: CaseStorePort
  /** 检查点端口（`gate_check` 读它）；缺省回退到 `checkpointRoot` 的文件实现。 */
  readonly checkpoints?: CheckpointPort
  /** markdown-fs 知识库目录；未配置 = `kb_query`/`kb_write` 返回 available=false。 */
  readonly knowledgeRoot?: string
  /** markdown-fs 用例库目录；未配置 = `case_query`/`case_archive` 返回 available=false。 */
  readonly casesRoot?: string
  /** receive 阶段输入文件（相对 projectRoot）；`req_pull` 读它。 */
  readonly receiveInput?: string
  /** 本流水线的检查点目录（`<checkpointRoot>/<pipelineId>`）；`gate_check` 读它。 */
  readonly checkpointRoot?: string
  /**
   * 被测服务基址。缺省时 `executor_run` 返回错误而不是伪造记录——
   * 没有真实被测服务就不允许产出"执行证据"（docs/08）。
   */
  readonly targetBaseUrl?: string
  /**
   * `targetBaseUrl` 的**建连前复核**（docs/11 P1-01）。
   *
   * 宿主注入（生产是 `assertTargetBaseUrlAllowed`）。缺省 = 不复核，仅用于
   * 不经过 Web/CLI 创建流程的测试；**真实宿主必须注入**，否则"创建时校验过一次"
   * 会被当成永久有效，而清单是磁盘文件。
   */
  readonly assertTargetBaseUrl?: (url: string) => void
  /**
   * **解析后**的建连前复核（docs/11 P2-04）：防 DNS rebinding。
   *
   * 与 `assertTargetBaseUrl` 的分工：后者只判字符串（快、无副作用，创建时也用它）；
   * 本钩子在**每次发出请求之前**解析域名并复核实际对端地址。域名可以在创建之后
   * 解析到别处，所以两者不能互相替代。
   *
   * 宿主注入（生产是 `assertTargetResolvedAllowed`）。缺省 = 不复核，仅用于
   * 不经过 Web/CLI 创建流程的测试；**真实宿主必须注入**。
   */
  readonly assertResolvedTargetAllowed?: (url: string) => Promise<void>
  /**
   * 远端幂等键的请求头名（docs/11 P1-07）。
   *
   * 声明它 = **宿主确认被测服务支持幂等键**。此后 `executor_run` 会在每个请求上带
   * `Idempotency-Key: <稳定键>`，于是"请求已发出但结果未知"的用例可以安全重发
   * （远端会把重复请求折叠成同一个副作用）。
   *
   * 缺省（未声明）= 远端不支持幂等键：`sent` 之后一律**明确阻断**，
   * 不假装 exactly-once。**不要为了"让它跑过去"而随便声明它。**
   */
  readonly executorIdempotencyHeader?: string
  /**
   * `env_diag` 的固定探针白名单（docs/06：不授予任意命令执行权）。
   * 模型不能自行指定目标；缺省 = 探针未配置。
   */
  readonly diagProbes?: readonly DiagSpec[]
  readonly diagTimeoutMs?: number
  readonly env?: Readonly<Record<string, string | undefined>>
  /** 注入 HTTP 传输（测试用本地服务器；默认 globalThis.fetch）。 */
  readonly request?: HttpRequestFn
  /** `parse_doc` 单文档字节上限；缺省 = `DEFAULT_DOCUMENT_LIMITS.maxFileBytes`。 */
  readonly maxDocumentBytes?: number
  /** `parse_doc` 表格行数上限；缺省 = `DEFAULT_DOCUMENT_LIMITS.maxTableRows`。 */
  readonly maxTableRows?: number
  /**
   * 注入解析器注册表（测试与"替换解析实现"用）。
   * 缺省用 `defaultParserRegistry()`——CLI / Web / Harness 必须共用同一份内置注册表
   * （docs/10 §5.6.11 第 9 条），因此这里只在显式注入时才偏离默认。
   */
  readonly documentRegistry?: DocumentParserRegistry
  /**
   * 用量落点（docs/10 §7.3「executor 的 case 数量、失败数量和证据数写入 usage」）。
   *
   * 缺省 = 不计量。事件归属的阶段取 `ToolExecutionContext.stageId`；
   * 该字段缺失时**不记事件**（无法归属的事件违反 §7.4「与 pipelineId/stageId 一一绑定」），
   * 而不是编一个阶段名出来。
   */
  readonly usage?: UsageSink
}

/** 执行会话落盘路径约定（`executor_run` 与 `ExecutionLoader` 共用）。 */
export function executorSessionPath(projectRoot: string, pipelineId: string): string {
  return join(projectRoot, 'executor', pipelineId, 'session.json')
}

/** 执行证据落盘目录约定（executor 独占写；execute 阶段 agent 无写权）。 */
export function executorEvidenceDir(projectRoot: string, pipelineId: string): string {
  return join(projectRoot, 'executor', pipelineId, 'evidence')
}

/**
 * 执行调用日志目录约定（docs/11 P1-07）。
 *
 * 与 `session.json` / `evidence/` 同级：三者同属"这一次真实执行"的事实，
 * 放在一起才能让运维一眼看全现场。
 */
export function executorInvocationDir(projectRoot: string, pipelineId: string): string {
  return join(projectRoot, 'executor', pipelineId, 'invocations')
}

/**
 * 读取执行会话（driver 的 `ExecutionLoader` 实现）。
 *
 * 文件缺失 → undefined（execute 阶段尚未真实执行，门禁 R4-08/09/10 会据此判定未执行）；
 * 文件存在但损坏 → 抛错，绝不返回"空会话"——那等于把伪造的执行数据洗成合法。
 */
export async function loadExecutionSession(
  sessionPath: string,
  evidenceDir: string,
): Promise<ExecutionSession | undefined> {
  let raw: string
  try {
    raw = await readFile(sessionPath, 'utf8')
  } catch (error) {
    if (isMissingFile(error)) return undefined
    throw error
  }
  const parsed = JSON.parse(raw) as Record<string, unknown>
  if (!Array.isArray(parsed.records)) {
    throw new Error(`执行会话文件缺少 records 数组：${sessionPath}`)
  }
  return {
    ...(typeof parsed.pipelineId === 'string' ? { pipelineId: parsed.pipelineId } : {}),
    evidenceDir: typeof parsed.evidenceDir === 'string' ? parsed.evidenceDir : evidenceDir,
    records: parsed.records as never,
    evidence: Array.isArray(parsed.evidence) ? (parsed.evidence as never) : ([] as never),
  }
}

/** 构造平台标准工具集（顺序即 ACL 目录顺序）。 */
export function buildPlatformTools(ctx: PlatformToolContext): readonly ToolDefinition[] {
  // 端口优先：宿主装配的后端是唯一事实来源（docs/11 P1-09）。
  // 目录回退只服务于不经宿主装配的调用方（单测、脚本）。
  const knowledge = ctx.knowledge
    ?? (ctx.knowledgeRoot === undefined ? undefined : new MarkdownKnowledgeStore(ctx.knowledgeRoot))
  const cases = ctx.cases
    ?? (ctx.casesRoot === undefined ? undefined : new MarkdownCaseStore(ctx.casesRoot))

  return [
    parseDocTool(ctx),
    kbQueryTool(ctx, knowledge),
    kbWriteTool(ctx, knowledge),
    caseQueryTool(ctx, cases),
    caseArchiveTool(ctx, cases),
    reqPullTool(ctx),
    executorRunTool(ctx),
    envDiagTool(ctx),
    gateCheckTool(ctx),
  ]
}

// ── parse_doc ────────────────────────────────────────────────────────────────

/** `parse_doc` 入参（docs/10 §5.6.6）。字段全是 `unknown`，逐个显式校验。 */
interface ParseDocArgs {
  readonly path?: unknown
  readonly formatHint?: unknown
  readonly includeTables?: unknown
  readonly includeMetadata?: unknown
  readonly sheetNames?: unknown
  readonly includeHiddenSheets?: unknown
  readonly pageRange?: unknown
  readonly projectKnowledge?: unknown
}

/**
 * `parse_doc` 返回结构（docs/10 §5.6.6）。
 *
 * **`available` 与 `status` 是两件事**：
 * - `available: false` = 本次调用没有得到可信的文档结果（路径越界 / 文件不存在 / 读取失败）；
 * - `available: true` = 注册表完成了工作，结果质量由 `status` 说明。因此
 *   `available: true` **不等于** "解析成功"：`unsupported` / `parse-failed` 同样是
 *   `available: true`，只是没有任何可用内容。
 *
 * 这层区分是必须的：模型看到 `available: true` 才不会把"宿主没有这个能力"误读成
 * "文档里没有这段内容"（与 `kb_query` 的 `available: false` 同一条原则）。
 */
export interface ParseDocToolResult {
  readonly available: boolean
  readonly status: ParseStatus
  readonly format: SupportedDocumentFormat | 'unknown'
  readonly fileName: string
  readonly sha256?: string
  readonly confidence?: ContentConfidence
  readonly pageCount?: number
  readonly sheetNames?: readonly string[]
  readonly metadata?: Readonly<Record<string, string | number | boolean | null>>
  readonly sections: readonly ParsedSection[]
  readonly tables: readonly ParsedTable[]
  readonly plainText: string
  /** 全部 section/table 的位置引用，便于模型直接引用来源（docs/10 §10 P0-A1）。 */
  readonly sourceRefs: readonly string[]
  readonly diagnostics: readonly DocumentDiagnostic[]
  readonly limits?: ParsedDocumentLimits
  /** `projectKnowledge: true` 时生成的 **draft** 候选条目；永不写入知识库。 */
  readonly draftEntries?: readonly KnowledgeEntry[]
  readonly draftWarnings?: readonly string[]
  readonly error?: string
}

/** 共享解析入口的参数：CLI/Web（本模块）与 Harness 侧 `stage-tools` 都用它。 */
export interface ParseDocumentToolOptions {
  /** 工作区根（绝对路径）；路径包含性校验的唯一基准。 */
  readonly projectRoot: string
  readonly signal: AbortSignal
  /** 当前项目 id；只有它存在时才允许生成 draft（知识条目必须绑定项目）。 */
  readonly projectId?: string
  /** 当前流水线 id；写入 draft 的 `sourcePipeline`，使其可直接提交 `kb_write`。 */
  readonly pipelineId?: string
  readonly limits?: Partial<DocumentLimits>
  readonly registry?: DocumentParserRegistry
  readonly maxDraftEntries?: number
}

/**
 * 按 docs/10 §5.6.3 的职责边界解析工作区文档：
 * 校验参数与路径 → 调注册表 → 序列化为 tool result →（可选）投影 draft。
 *
 * **不处理任何格式细节**（OOXML / PDF / Excel 全在 `documents/` 里），因此换解析库
 * 不会改动工具契约。本函数也**不为入参错误抛异常**：路径越界与读取失败一律返回
 * `available: false` + 结构化诊断（docs/10 §5.6.6「错误响应必须结构化」）。
 */
export async function parseWorkspaceDocument(
  args: unknown,
  options: ParseDocumentToolOptions,
): Promise<ParseDocToolResult> {
  const raw = (args ?? {}) as Record<string, unknown>
  const requested = typeof raw.path === 'string' ? raw.path.trim() : ''
  const label = normalizeRelativePath(requested)

  const scope = new WorkspaceScope(options.projectRoot)
  let target: string
  try {
    target = await scope.existingFile(requested)
  } catch (error) {
    return unavailableResult(label, errorMessage(error))
  }

  // 字节上限必须在**读取之前**生效（docs/11 P2-02）。`readFile()` 会把整个文件读进内存，
  // 一份 10 GiB 的"文档"在限额判据生效之前就已经把进程打爆了——那样的限额等于没有。
  // `readFileWithinLimit` 先 `stat` 判一次，再按 `maxBytes + 1` 有界读取，
  // 因此"stat 与 read 之间文件变大"也越不过上限。
  const limits = resolveDocumentLimits(options.limits)
  const read = await readFileWithinLimit(target, limits.maxFileBytes)
  if (!read.ok) {
    if (read.reason === 'too-large') {
      // 超限是**可信结论**（available: true），与解析器内部的 limit-exceeded 同形：
      // 调用方不需要区分"读前拒"和"读后拒"，两者都是"这份文档太大"。
      return limitExceededResult(label, read.detail, read.size ?? 0)
    }
    return unavailableResult(label, `读取文档失败：${read.detail}`)
  }
  const bytes = read.bytes

  const includeTables = raw.includeTables !== false
  const includeMetadata = raw.includeMetadata !== false
  const formatHint = isSupportedDocumentFormat(raw.formatHint) ? raw.formatHint : undefined
  const sheetNames = stringArray(raw.sheetNames)
  const pageRange = pageRangeOf(raw.pageRange)

  const registry = options.registry ?? defaultParserRegistry()
  const doc = await registry.parse({
    path: label,
    absolutePath: target,
    bytes,
    ...(formatHint === undefined ? {} : { formatHint }),
    includeTables,
    includeMetadata,
    // 原始字节永不回给模型（docs/10 §5.6.8「默认不向模型发送原始二进制」）。
    includeRawSource: false,
    ...(sheetNames.length === 0 ? {} : { sheetNames }),
    includeHiddenSheets: raw.includeHiddenSheets === true,
    ...(pageRange === undefined ? {} : { pageRange }),
    ...(options.limits === undefined ? {} : { limits: options.limits }),
    signal: options.signal,
  })

  const diagnostics: DocumentDiagnostic[] = [...doc.diagnostics]
  let draftEntries: readonly KnowledgeEntry[] | undefined
  let draftWarnings: readonly string[] | undefined

  if (raw.projectKnowledge === true) {
    const project = options.projectId?.trim() ?? ''
    if (project === '') {
      diagnostics.push(diagnostic(
        DOCUMENT_DIAGNOSTIC_CODES.parserFailed,
        'warning',
        '宿主未配置 projectId，无法生成 draft 知识条目；本次只返回解析结构。',
        label,
      ))
    } else {
      const projection = projectKnowledge(doc, {
        project,
        ...(options.pipelineId === undefined ? {} : { sourcePipeline: options.pipelineId }),
        maxEntries: options.maxDraftEntries ?? DEFAULT_MAX_DRAFT_ENTRIES,
      })
      draftEntries = projection.entries
      draftWarnings = projection.warnings
    }
  }

  return {
    available: true,
    status: doc.status,
    format: doc.format,
    fileName: doc.fileName,
    sha256: doc.sha256,
    confidence: doc.confidence,
    ...(doc.pageCount === undefined ? {} : { pageCount: doc.pageCount }),
    ...(doc.sheetNames === undefined ? {} : { sheetNames: doc.sheetNames }),
    ...(includeMetadata ? { metadata: doc.metadata } : {}),
    sections: doc.sections,
    tables: includeTables ? doc.tables : [],
    plainText: doc.plainText,
    sourceRefs: uniqueRefs(doc.sections, includeTables ? doc.tables : []),
    diagnostics,
    limits: doc.limits,
    ...(draftEntries === undefined ? {} : { draftEntries }),
    ...(draftWarnings === undefined ? {} : { draftWarnings }),
  }
}

/** 无法得到可信结果时的结构化失败（`available: false`，绝不伪装成 `parsed`）。 */
function unavailableResult(path: string, message: string): ParseDocToolResult {
  return {
    available: false,
    status: 'parse-failed',
    format: 'unknown',
    fileName: path.split('/').pop() ?? path,
    sections: [],
    tables: [],
    plainText: '',
    sourceRefs: [],
    diagnostics: [diagnostic(DOCUMENT_DIAGNOSTIC_CODES.parserFailed, 'error', message, path)],
    error: message,
  }
}

/**
 * 读取前就超限（docs/11 P2-02）。
 *
 * 与 {@link unavailableResult} 的关键差别：`available: true`——**这是一条可信结论**
 * （"这份文档超过上限"），而不是"拿不到结果"。`available: false` 留给"路径越界/
 * 文件不存在/读不出来"这类真正无法下结论的情况。
 */
function limitExceededResult(path: string, message: string, bytesRead: number): ParseDocToolResult {
  return {
    available: true,
    status: 'limit-exceeded',
    format: 'unknown',
    fileName: path.split('/').pop() ?? path,
    sections: [],
    tables: [],
    plainText: '',
    sourceRefs: [],
    diagnostics: [diagnostic(DOCUMENT_DIAGNOSTIC_CODES.limitExceeded, 'error', message, path)],
    limits: { truncated: true, bytesRead },
  }
}

function parseDocTool(ctx: PlatformToolContext): ToolDefinition<ParseDocArgs, ParseDocToolResult> {
  const limits: Partial<DocumentLimits> = {
    maxFileBytes: ctx.maxDocumentBytes ?? DEFAULT_MAX_DOCUMENT_BYTES,
    maxTableRows: ctx.maxTableRows ?? DEFAULT_DOCUMENT_LIMITS.maxTableRows,
  }
  return {
    name: 'parse_doc',
    description:
      '解析工作区内的项目文档并返回**结构化**结果：sections（标题层级/段落/页码）、tables（表头与数据行）、'
      + 'plainText（供检索）、diagnostics（结构化诊断）与 limits（截断情况）。'
      + `支持 ${SUPPORTED_DOCUMENT_FORMATS.join(' / ')}；`
      + '.doc/.xls 老二进制格式与未安装解析器的格式会返回 status=unsupported 并说明缺失能力，'
      + '绝不会把二进制当文本读出乱码。sourceRefs 可直接用于引用来源位置。'
      + 'projectKnowledge=true 时额外返回 draft 候选知识条目（仅 draft；active 写入需走人工门）。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['path'],
      properties: {
        path: { type: 'string', description: '相对工作区根的文档路径' },
        formatHint: { type: 'string', enum: [...SUPPORTED_DOCUMENT_FORMATS], description: '格式提示；与 magic bytes 冲突时以文件内容为准' },
        includeTables: { type: 'boolean', description: '是否返回结构化表格，默认 true' },
        includeMetadata: { type: 'boolean', description: '是否返回文档元数据，默认 true' },
        sheetNames: { type: 'array', items: { type: 'string' }, description: '只读取指定 sheet（Excel）' },
        includeHiddenSheets: { type: 'boolean', description: '是否读取隐藏 sheet（Excel），默认 false' },
        pageRange: {
          type: 'object',
          additionalProperties: false,
          properties: { from: { type: 'integer' }, to: { type: 'integer' } },
          description: '只读取指定页码范围（PDF）',
        },
        projectKnowledge: { type: 'boolean', description: '是否生成 draft 候选知识条目，默认 false' },
      },
    },
    async execute(args, context) {
      assertNotAborted(context.signal)
      return await parseWorkspaceDocument(args, {
        projectRoot: ctx.projectRoot,
        signal: context.signal,
        ...(ctx.projectId === undefined ? {} : { projectId: ctx.projectId }),
        pipelineId: ctx.pipelineId,
        limits,
        ...(ctx.documentRegistry === undefined ? {} : { registry: ctx.documentRegistry }),
      })
    },
  }
}

/** section/table 的 sourceRef 去重（保持首次出现顺序）。 */
function uniqueRefs(sections: readonly ParsedSection[], tables: readonly ParsedTable[]): string[] {
  return [...new Set([...sections.map(section => section.sourceRef), ...tables.map(table => table.sourceRef)])]
}

/**
 * 归一化模型传入的相对路径，用作 sourceRef 前缀。
 *
 * 只做纯文本归一（反斜杠→斜杠、去 `./`、折叠 `//`、去尾 `/`）：**不**参与实际路径
 * 解析——真实路径由 `WorkspaceScope` 的 realpath 包含性校验决定，两者职责不重叠。
 */
function normalizeRelativePath(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\.\/+/, '').replace(/\/{2,}/g, '/').replace(/\/+$/, '')
}

/** 页码区间入参校验：只接受正整数，非法值直接忽略（不猜测模型意图）。 */
function pageRangeOf(value: unknown): { from?: number; to?: number } | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const raw = value as Record<string, unknown>
  const from = positiveInteger(raw.from)
  const to = positiveInteger(raw.to)
  if (from === undefined && to === undefined) return undefined
  return { ...(from === undefined ? {} : { from }), ...(to === undefined ? {} : { to }) }
}

function positiveInteger(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
  const truncated = Math.trunc(value)
  return truncated >= 1 ? truncated : undefined
}

// ── 知识库 / 用例库 ───────────────────────────────────────────────────────────

interface KbQueryArgs {
  readonly entities?: unknown
  readonly tags?: unknown
  readonly text?: unknown
  readonly limit?: unknown
}

function kbQueryTool(ctx: PlatformToolContext, store: KnowledgeStorePort | undefined): ToolDefinition<KbQueryArgs, unknown> {
  return {
    name: 'kb_query',
    description: '检索项目知识库（只读）。返回 available/source/entries，每条含 score 与匹配依据 matchedBy/matchedTerms。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        entities: { type: 'array', items: { type: 'string' }, description: '按实体检索（权重最高）' },
        tags: { type: 'array', items: { type: 'string' }, description: '按标签检索' },
        text: { type: 'string', description: '自由文本检索' },
        limit: { type: 'integer', description: `最多返回条数，默认 ${DEFAULT_KB_LIMIT}，上限 ${MAX_KB_LIMIT}` },
      },
    },
    async execute(args, context) {
      assertNotAborted(context.signal)
      if (store === undefined) {
        return { available: false, source: 'unconfigured', entries: [], hint: '宿主未配置 markdown-fs 知识库（stores.knowledge）；这不是"知识库为空"。' }
      }
      const entities = stringArray(args?.entities)
      const tags = stringArray(args?.tags)
      const text = typeof args?.text === 'string' ? args.text : undefined
      if (entities.length === 0 && tags.length === 0 && (text === undefined || text.trim() === '')) {
        return {
          available: true,
          source: 'markdown-fs',
          entries: [],
          hint: '未提供检索条件（entities/tags/text）：本次未执行检索，不代表知识库为空。',
        }
      }
      const query = {
        ...(entities.length === 0 ? {} : { entities }),
        ...(tags.length === 0 ? {} : { tags }),
        ...(text === undefined ? {} : { text }),
        project: ctx.projectId,
        limit: clampLimit(args?.limit),
      }
      const hits = store.readHits === undefined
        ? (await store.read(query)).map(entry => ({ entry, score: 0, matchedBy: [], matchedTerms: [] }))
        : await store.readHits(query)
      return {
        available: true,
        source: 'markdown-fs',
        entries: hits.map(hit => ({
          ...hit.entry,
          score: hit.score,
          matchedBy: [...hit.matchedBy],
          matchedTerms: [...hit.matchedTerms],
        })),
      }
    },
  }
}

interface KbWriteArgs {
  readonly entry?: unknown
}

function kbWriteTool(ctx: PlatformToolContext, store: KnowledgeStorePort | undefined): ToolDefinition<KbWriteArgs, unknown> {
  return {
    name: 'kb_write',
    description:
      '把一条**已获人工批准**的结构化知识条目写入项目知识库。必填 id/title/version/body；'
      + 'date/project/sourcePipeline/tags/entities 缺省由宿主补全。与既有活跃条目结论冲突时返回 conflict，需显式 supersedes。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['entry'],
      properties: { entry: { type: 'object', description: '知识条目对象（见 docs/02 知识条目 schema）' } },
    },
    async execute(args, context) {
      assertNotAborted(context.signal)
      if (store === undefined) {
        return { available: false, error: '宿主未配置 markdown-fs 知识库（stores.knowledge），无法写入。' }
      }
      const raw = args?.entry
      if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
        return { available: true, error: 'entry 必须是对象' }
      }
      const incoming = raw as Record<string, unknown>
      const missing = ['id', 'title', 'version', 'body'].filter(field => !isNonEmptyString(incoming[field]))
      if (missing.length > 0) {
        return { available: true, error: `知识条目缺少必填字段：${missing.join(', ')}` }
      }
      // 身份字段不接受模型改写：写错项目/来源会让知识库静默串项目。
      if (incoming.project !== undefined && incoming.project !== ctx.projectId) {
        return { available: true, error: `entry.project 必须等于当前项目 ${ctx.projectId}` }
      }
      if (incoming.sourcePipeline !== undefined && incoming.sourcePipeline !== ctx.pipelineId) {
        return { available: true, error: `entry.sourcePipeline 必须等于当前流水线 ${ctx.pipelineId}` }
      }
      const date = incoming.date
      if (date !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(String(date))) {
        return { available: true, error: 'entry.date 必须是 YYYY-MM-DD' }
      }
      const entry: KnowledgeEntry = {
        ...(incoming as unknown as KnowledgeEntry),
        id: String(incoming.id),
        title: String(incoming.title),
        version: String(incoming.version),
        body: String(incoming.body),
        date: typeof date === 'string' ? date : today(),
        project: ctx.projectId,
        sourcePipeline: ctx.pipelineId,
        tags: stringArray(incoming.tags),
        entities: stringArray(incoming.entities),
      }
      try {
        const id = await store.write(entry)
        return { available: true, id, conflict: false }
      } catch (error) {
        if (error instanceof KnowledgeConflictError) {
          return { available: true, conflict: true, conflicts: [...error.conflicts] }
        }
        throw error
      }
    },
  }
}

interface CaseQueryArgs {
  readonly requirement?: unknown
  readonly version?: unknown
}

function caseQueryTool(ctx: PlatformToolContext, store: CaseStorePort | undefined): ToolDefinition<CaseQueryArgs, unknown> {
  return {
    name: 'case_query',
    description: '检索项目历史用例（只读）。可按来源需求与版本过滤，返回每个用例的最新版本元信息。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        requirement: { type: 'string', description: '来源需求标识过滤' },
        version: { type: 'string', description: '版本过滤' },
      },
    },
    async execute(args, context) {
      assertNotAborted(context.signal)
      if (store === undefined) {
        return { available: false, source: 'unconfigured', cases: [], hint: '宿主未配置 markdown-fs 用例库（stores.cases）；这不是"没有历史用例"。' }
      }
      const cases = await store.query({
        project: ctx.projectId,
        ...(isNonEmptyString(args?.requirement) ? { requirement: String(args.requirement) } : {}),
        ...(isNonEmptyString(args?.version) ? { version: String(args.version) } : {}),
      })
      return { available: true, source: 'markdown-fs', cases }
    },
  }
}

interface CaseArchiveArgs {
  readonly case?: unknown
}

function caseArchiveTool(ctx: PlatformToolContext, store: CaseStorePort | undefined): ToolDefinition<CaseArchiveArgs, unknown> {
  return {
    name: 'case_archive',
    description: '把一个**已获人工批准**的版本化用例归档到项目用例库（同 caseId 不同 version 追加版本记录，R6-02）。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['case'],
      properties: { case: { type: 'object', description: '版本化用例对象（caseId/version/project/sourceRequirement/ticketRef/content）' } },
    },
    async execute(args, context) {
      assertNotAborted(context.signal)
      if (store === undefined) {
        return { available: false, error: '宿主未配置 markdown-fs 用例库（stores.cases），无法归档。' }
      }
      const raw = args?.case
      if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
        return { available: true, error: 'case 必须是对象' }
      }
      const incoming = raw as Record<string, unknown>
      const missing = ['caseId', 'version'].filter(field => !isNonEmptyString(incoming[field]))
      if (missing.length > 0) {
        return { available: true, error: `用例缺少必填字段：${missing.join(', ')}` }
      }
      if (incoming.project !== undefined && incoming.project !== ctx.projectId) {
        return { available: true, error: `case.project 必须等于当前项目 ${ctx.projectId}` }
      }
      if (!('content' in incoming)) {
        return { available: true, error: '用例缺少 content（归档格式必须与检索格式一致，R6-01）' }
      }
      const value: VersionedCase = {
        ...(incoming as unknown as VersionedCase),
        caseId: String(incoming.caseId),
        version: String(incoming.version),
        project: ctx.projectId,
        sourceRequirement: typeof incoming.sourceRequirement === 'string' ? incoming.sourceRequirement : '',
        ticketRef: typeof incoming.ticketRef === 'string' ? incoming.ticketRef : '',
      }
      await store.archive(value)
      return { available: true, caseId: value.caseId, version: value.version }
    },
  }
}

// ── receive 输入 ──────────────────────────────────────────────────────────────

function reqPullTool(ctx: PlatformToolContext): ToolDefinition<Record<string, never>, unknown> {
  const scope = new WorkspaceScope(ctx.projectRoot)
  return {
    name: 'req_pull',
    description: '拉取本流水线的原始需求输入（只读）。未配置输入路径时显式报错。',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    async execute(_args, context) {
      assertNotAborted(context.signal)
      if (ctx.receiveInput === undefined || ctx.receiveInput.trim() === '') {
        return { error: '宿主未配置 receive 输入路径（receiveInput）' }
      }
      try {
        return { text: await readFile(await scope.existingFile(ctx.receiveInput), 'utf8') }
      } catch (error) {
        return { error: errorMessage(error) }
      }
    },
  }
}

// ── executor_run ─────────────────────────────────────────────────────────────

interface ExecutorRunArgs {
  readonly pipelineId?: unknown
  readonly caseIds?: unknown
}

interface ExecutorRunResult {
  readonly records?: readonly unknown[]
  readonly error?: string
  /** 本次**没有真正执行**、直接重放首次记录的用例 id（docs/10 §6.3 M2-3）。 */
  readonly replayedCaseIds?: readonly string[]
  /**
   * 因"上一次调用结果未知"而拒绝执行的用例 id（docs/11 P1-07）。
   *
   * 存在它时**一个请求都没有发出**：宁可整批阻断，也不在结果不可判定时制造重复副作用。
   */
  readonly blockedCaseIds?: readonly string[]
  /** 处置方式（给 agent 与运维看的可执行说明，不是泛泛的"请联系管理员"）。 */
  readonly hint?: string
}

/** 幂等台账里存的执行记录摘要：与回给 agent 的形状一致，重放时原样返回。 */
interface ExecutorInvocationResult {
  readonly seq: number
  readonly caseId: string
  readonly status: string
  readonly evidenceRefs: readonly string[]
  readonly durationMs: number
}

/**
 * 单个用例的执行输入摘要（docs/10 §6.3 M2-3 里的 `inputDigest`）。
 *
 * 输入 = 用例定义（由 design 产物决定 → 用产物 digest 代表）+ 被测服务基址。
 * `targetBaseUrl` 必须进摘要：换一个被测服务再跑同一用例是**不同的执行**，
 * 不能被上一轮针对另一个环境的记录顶替。
 */
function executorInputDigest(pipelineId: string, caseId: string, designDigest: string, baseUrl: string): string {
  return idempotencyKey(IDEMPOTENCY_NAMESPACES.executorCaseInput, [pipelineId, caseId, designDigest, baseUrl])
}

/** 去重且保持首次出现顺序：同一次调用里重复传同一个 caseId 不该被执行两次。 */
function dedupeStrings(values: readonly string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const value of values) {
    if (seen.has(value)) continue
    seen.add(value)
    out.push(value)
  }
  return out
}

/**
 * 真实执行器工具（docs/08 防线 1：executor 是唯一执行者）。
 *
 * - 用例定义**由 executor 自读** `artifacts/<pipelineId>/design.json`，不采信调用方传入的步骤内容；
 * - 证据落 `executor/<pipelineId>/evidence/`（execute 阶段 agent 无写权）；
 * - 会话按 seq/prevHash 续接而非覆盖：executor_run 会被分批多次调用，覆盖会让先前批次
 *   的记录消失，门禁 R4-08 随即把它们判成"漏跑"（Harness 侧实测踩到过）；
 * - 幂等（docs/10 §6.3 M2-3）：键 = `pipelineId/caseId/inputDigest`。同一批用例在**同一
 *   design 产物 + 同一被测基址**下重复投递（重试、进程被杀后重来）直接重放首次记录，
 *   不再执行第二遍——否则会话里会多出一条同用例记录，被 R4-08 判成
 *   `unexecuted record seq N is unreferenced (多余执行)`，整条流水线卡在门禁上。
 *   设计变更后 `designDigest` 变了 → 键变了 → 是**新的一轮执行**，正常重跑。
 */
function executorRunTool(ctx: PlatformToolContext): ToolDefinition<ExecutorRunArgs, ExecutorRunResult> {
  const artifacts = ctx.artifacts ?? new FsArtifactStore(ctx.artifactsRoot)
  const sessionPath = executorSessionPath(ctx.projectRoot, ctx.pipelineId)
  const evidenceDir = executorEvidenceDir(ctx.projectRoot, ctx.pipelineId)
  const ledger = fileIdempotencyLedger(idempotencyDir(ctx.projectRoot))
  const invocationNamespace = IDEMPOTENCY_NAMESPACES.executorInvocation
  return {
    name: 'executor_run',
    description:
      '对被测系统真实执行指定用例并返回真实执行记录（只传 caseIds，用例定义由 executor 自读 design 产物）。'
      + '不传 caseIds 表示执行 design 中的全部用例。'
      + '同一用例在相同输入下重复调用会重放既有记录，不会重复执行。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        pipelineId: { type: 'string', description: '当前流水线 id；与宿主不一致时拒绝执行' },
        caseIds: { type: 'array', items: { type: 'string' }, description: '要执行的用例 id 列表' },
      },
    },
    async execute(args, context) {
      assertNotAborted(context.signal)
      const startedAt = Date.now()
      /**
       * 记一条 `executor` 用量事件并返回原结果。
       *
       * `caseCount` 只数**本次真正执行**的用例（重放的不算）：重放用例的消耗已经记在
       * 首次调用那条事件里，再记一次会让 `maxTestCases` 汇总重复计数。
       */
      const finish = async (
        result: ExecutorRunResult,
        usage: {
          readonly success: boolean
          readonly errorCode?: string
          readonly caseCount?: number
          readonly failureCount?: number
          readonly evidenceCount?: number
        },
      ): Promise<ExecutorRunResult> => {
        if (context.stageId !== undefined) {
          await recordUsage(ctx.usage, {
            stageId: context.stageId,
            kind: 'executor',
            startedAt,
            finishedAt: Date.now(),
            ...usage,
          })
        }
        return result
      }
      const baseUrl = ctx.targetBaseUrl
      if (baseUrl === undefined || baseUrl.trim() === '') {
        return await finish(
          { error: '宿主未配置被测服务基址（targetBaseUrl）：拒绝伪造执行记录，execute 阶段的 R4-08/09/10 将无法通过。' },
          { success: false, errorCode: 'executor-unavailable' },
        )
      }
      // 建连前复核（docs/11 P1-01）：`targetBaseUrl` 来自持久化清单，是磁盘文件，
      // 可能被篡改或来自旧版本。创建时校验过一次不等于它现在仍然安全——
      // 这里必须用同一份判据再看一眼，且**在发出任何请求之前**。
      if (ctx.assertTargetBaseUrl !== undefined) {
        try {
          ctx.assertTargetBaseUrl(baseUrl)
        } catch (error) {
          return await finish(
            { error: `被测服务基址未通过宿主复核，拒绝执行：${errorMessage(error)}` },
            { success: false, errorCode: 'target-unavailable' },
          )
        }
      }
      // 解析后复核（docs/11 P2-04）：字面量校验只能证明"那个字符串看起来安全"，
      // 域名可以在创建之后解析到内网（DNS rebinding）。必须在**发出任何请求之前**
      // 解析一次并复核实际对端地址。
      if (ctx.assertResolvedTargetAllowed !== undefined) {
        try {
          await ctx.assertResolvedTargetAllowed(baseUrl)
        } catch (error) {
          return await finish(
            { error: `被测服务基址解析后未通过宿主复核，拒绝执行：${errorMessage(error)}` },
            { success: false, errorCode: 'target-unavailable' },
          )
        }
      }
      const requested = isNonEmptyString(args?.pipelineId) ? String(args.pipelineId) : ctx.pipelineId
      if (requested !== ctx.pipelineId) {
        return await finish(
          { error: `pipelineId 不匹配：本次运行绑定 ${ctx.pipelineId}，拒绝执行 ${requested}（防止跨流水线串读用例）` },
          { success: false, errorCode: 'pipeline-mismatch' },
        )
      }
      const design = await artifacts.read(artifactPath(ctx.pipelineId, 'design'))
      if (design === null) {
        return await finish(
          { error: `未找到 design 产物（artifacts/${ctx.pipelineId}/design.json）：design 阶段尚未完成。` },
          { success: false, errorCode: 'design-missing' },
        )
      }
      const content = design.content as {
        readonly testCases?: readonly Record<string, unknown>[]
        readonly reusedCases?: readonly Record<string, unknown>[]
      }
      const designCases = [...(content.testCases ?? []), ...(content.reusedCases ?? [])]
        .map(raw => ({ id: String((raw as Record<string, unknown>).id ?? ''), steps: Array.isArray((raw as Record<string, unknown>).steps) ? (raw as { steps: readonly Record<string, unknown>[] }).steps : [] }))
        .filter(entry => entry.id !== '')
      if (designCases.length === 0) {
        return await finish(
          { error: 'design 产物中没有任何带 id 的用例（testCases/reusedCases 均为空）。' },
          { success: false, errorCode: 'design-empty' },
        )
      }
      const requestedIds = dedupeStrings(
        args?.caseIds === undefined ? designCases.map(entry => entry.id) : stringArray(args.caseIds),
      )
      if (requestedIds.length === 0) {
        return await finish({ error: 'caseIds 必须是非空字符串数组' }, { success: false, errorCode: 'invalid-case-ids' })
      }
      const known = new Set(designCases.map(entry => entry.id))
      const unknown = requestedIds.filter(id => !known.has(id))
      if (unknown.length > 0) {
        // 不在 design 里的用例无法执行：显式失败，避免产出一条"凭空 pass"的记录。
        return await finish(
          { error: `caseIds 不在 design 产物中：${unknown.join(', ')}` },
          { success: false, errorCode: 'unknown-case-ids' },
        )
      }

      // ── 分流：调用日志（权威）→ 幂等台账（兜底）→ 真正执行 ────────────────────
      //
      // 顺序不能换。台账只在**执行完成之后**才写，因此它表达不了"请求已发出但结果未知"；
      // 调用日志的 `phase` 才表达得了（docs/11 P1-07 / P1-08）。
      const journal = fileInvocationJournal(executorInvocationDir(ctx.projectRoot, ctx.pipelineId))
      const remoteIdempotencyHeader = ctx.executorIdempotencyHeader

      const replayable = new Map<string, ExecutorInvocationResult>()
      const resumable = new Map<string, InvocationRecord>()
      const pending: {
        readonly caseId: string
        readonly key: string
        readonly fingerprint: string
        readonly attempt: number
        readonly remoteIdempotencyKey?: string
      }[] = []
      const blocked: { readonly caseId: string; readonly phase: InvocationPhase; readonly journalPath: string }[] = []

      for (const caseId of requestedIds) {
        const fields = [ctx.pipelineId, caseId, executorInputDigest(ctx.pipelineId, caseId, design.digest, baseUrl)]
        const key = idempotencyKey(invocationNamespace, fields)
        const fingerprint = idempotencyFingerprint(invocationNamespace, fields)

        let record
        try {
          record = await journal.read(caseId)
        } catch (error) {
          if (error instanceof InvocationJournalCorruptError) {
            // 损坏 = **不可判定**，不是"没执行过"：当成没执行过就会盲目重发。
            blocked.push({ caseId, phase: 'unknown', journalPath: journal.pathOf(caseId) })
            continue
          }
          throw error
        }
        // 指纹不一致 = 换了 design 或被测基址 = 另一次调用，日志里的旧阶段不适用。
        const sameInvocation = record !== null && record.fingerprint === fingerprint
        const attempt = (sameInvocation ? record!.attempt : 0) + 1

        if (sameInvocation) {
          const phase = record!.phase
          if ((phase === 'done' || phase === 'received') && record!.fragment !== undefined) {
            if (phase === 'done') replayable.set(caseId, summaryOfFragment(record!.fragment))
            else resumable.set(caseId, record!)
            continue
          }
          if (phase === 'unknown' || (phase === 'sent' && !isRetryableAfterSent(record!))) {
            // 请求已发出、响应未落盘，而远端不支持幂等键：**明确阻断**，
            // 既不重发也不假装成功（docs/11 P1-07）。
            blocked.push({ caseId, phase, journalPath: journal.pathOf(caseId) })
            continue
          }
          // intent / 带远端幂等键的 sent → 可以安全地重来一次。
        }

        // 台账兜底：老版本或人工处置过的现场可能只有台账没有日志。
        const ledgerRecord = await ledger.lookup<ExecutorInvocationResult>(invocationNamespace, key)
        if (ledgerRecord !== null) {
          replayable.set(caseId, ledgerRecord.result)
          continue
        }
        pending.push({
          caseId, key, fingerprint, attempt,
          ...(remoteIdempotencyHeader === undefined ? {} : { remoteIdempotencyKey: key }),
        })
      }

      if (blocked.length > 0) {
        // 一次调用要么完整执行，要么明确阻断：存在不可判定的用例时**一个新请求都不发**。
        const detail = blocked
          .map(item => `- ${item.caseId}（${item.phase}）：${item.journalPath}`)
          .join('\n')
        return await finish(
          {
            error: `拒绝执行：以下用例的上一次调用结果未知，重发可能造成重复副作用。\n${detail}`,
            blockedCaseIds: blocked.map(item => item.caseId),
            hint: remoteIdempotencyHeader === undefined
              ? '处置方式（二选一）：①向被测服务确认这些用例未被执行 → 删除对应的调用日志文件后重试；'
                + '②确认已执行 → 把该文件的 phase 改为 done 并填入远端返回的结果摘要。'
                + '若被测服务支持幂等键，可在宿主声明 executorIdempotencyHeader，此后这类用例可安全重发。'
              : '处置方式：向被测服务确认结果后删除对应调用日志文件（宿主已声明远端支持幂等键，正常情况下不会走到这里）。',
          },
          { success: false, errorCode: 'invocation-unknown' },
        )
      }
      if (pending.length === 0 && resumable.size === 0) {
        // 全部命中：一个用例都不执行，会话文件一个字节都不改。
        return await finish(
          { records: requestedIds.map(id => replayable.get(id)!), replayedCaseIds: requestedIds },
          // 重放 = 没有真实执行，因此 caseCount 为 0：重放用例的消耗已记在首次调用那条事件里。
          { success: true, caseCount: 0, failureCount: 0, evidenceCount: 0 },
        )
      }

      const executor = new HttpExecutor({
        resolveCase: async (id) => {
          const found = designCases.find(entry => entry.id === id)
          if (found === undefined) return undefined
          // 远端幂等键：同一条用例在**同一次调用**（同 design + 同基址）下永远是同一个值，
          // 因此重发会被远端折叠成同一个副作用。
          const remoteKey = remoteIdempotencyHeader === undefined
            ? undefined
            : pending.find(item => item.caseId === id)?.remoteIdempotencyKey
          return {
            id: found.id,
            steps: toHttpSteps(
              found.id,
              found.steps,
              baseUrl,
              remoteKey === undefined || remoteIdempotencyHeader === undefined
                ? undefined
                : { [remoteIdempotencyHeader]: remoteKey },
            ),
          }
        },
        writeEvidence: async (path, evidenceContent) => {
          // HttpExecutor 传的是 `<evidenceDir>/<file>` 绝对路径；转成相对证据根后再做
          // 包含性校验（绝对路径一律拒绝），防止用例 id 里带 `../` 把证据写到目录外。
          const relative = path.startsWith(`${evidenceDir}/`) ? path.slice(evidenceDir.length + 1) : path
          const target = await evidenceScope(evidenceDir).writableFile(relative, ['.'])
          await mkdir(dirname(target), { recursive: true })
          await writeFile(target, evidenceContent, 'utf8')
        },
        ...(ctx.request === undefined ? {} : { request: ctx.request }),
      })
      const prior = await readSessionFile(sessionPath)

      // ── 先补齐"已收到响应、会话未落盘"的用例，再执行新的 ──────────────────────
      //
      // 顺序必须是"续用在前、执行在后"：续用片段的 seq/prevHash 是在崩溃前按当时的
      // 链尾算出来的，重排到新记录之后会让链断掉。会话内的记录顺序不要求与
      // `requestedIds` 一致（R4-08 按 caseId 对账），因此重排是安全的。
      const produced = new Map<string, ExecutorInvocationResult>()
      const resumedRecords: ExecutionRecord[] = []
      const resumedEvidence: EvidenceEntry[] = []
      for (const caseId of requestedIds) {
        const record = resumable.get(caseId)
        if (record === undefined) continue
        const fragment = record.fragment
        if (fragment === undefined) continue
        // 重新挂链：内容（capturedAt/durationMs/status/evidenceRefs）原样保留，
        // 只按**当前**链尾重算位置与摘要——否则与期间产生的会话记录撞 seq。
        for (const entry of fragment.records) {
          const tail = resumedRecords[resumedRecords.length - 1] ?? prior?.records[prior.records.length - 1]
          const rechained = makeRecord({
            seq: (tail?.seq ?? 0) + 1,
            caseId: entry.caseId,
            capturedAt: entry.capturedAt,
            durationMs: entry.durationMs,
            status: entry.status,
            evidenceRefs: entry.evidenceRefs,
            prevHash: tail?.ownHash ?? '',
            segment: tail?.segment ?? 1,
          })
          resumedRecords.push(rechained)
        }
        resumedEvidence.push(...fragment.evidence)
        const lastResumed = resumedRecords[resumedRecords.length - 1]
        if (lastResumed !== undefined) {
          produced.set(caseId, {
            seq: lastResumed.seq, caseId, status: lastResumed.status,
            evidenceRefs: lastResumed.evidenceRefs, durationMs: lastResumed.durationMs,
          })
        }
      }

      const executedRecords: ExecutionRecord[] = []
      const executedEvidence: EvidenceEntry[] = []
      const invocationId = `inv-${Date.now()}`
      for (const item of pending) {
        const base = {
          caseId: item.caseId, key: item.key, fingerprint: item.fingerprint, attempt: item.attempt,
          ...(item.remoteIdempotencyKey === undefined ? {} : { remoteIdempotencyKey: item.remoteIdempotencyKey }),
        }
        // ① intent：声明要执行，此刻**尚未发出任何请求**。
        await journal.write({ ...base, phase: 'intent', updatedAt: Date.now() })
        // ② sent：**发请求之前**的屏障。写成功之后才允许发请求——否则崩溃窗口里
        //    磁盘上仍是 intent，重启就会把"可能已发出"当成"没发过"再发一次。
        await journal.write({ ...base, phase: 'sent', updatedAt: Date.now() })

        const tail = executedRecords[executedRecords.length - 1]
          ?? resumedRecords[resumedRecords.length - 1]
          ?? prior?.records[prior.records.length - 1]
        const one = await executor.run([item.caseId], {
          designArtifactPath: artifactPath(ctx.pipelineId, 'design'),
          evidenceDir,
          invocationId,
          ...(tail === undefined
            ? {}
            : { continuation: { startSeq: tail.seq + 1, prevHash: tail.ownHash, segment: tail.segment } }),
        })
        // ③ received：响应已拿到、记录与证据已落进日志 → 之后**不需要重发**。
        await journal.write({
          ...base, phase: 'received', updatedAt: Date.now(),
          fragment: { records: one.records, evidence: one.evidence },
        })
        executedRecords.push(...one.records)
        executedEvidence.push(...one.evidence)
        const record = one.records[one.records.length - 1]
        if (record !== undefined) {
          produced.set(item.caseId, {
            seq: record.seq, caseId: record.caseId, status: record.status,
            evidenceRefs: record.evidenceRefs, durationMs: record.durationMs,
          })
        }
      }

      const merged = {
        pipelineId: ctx.pipelineId,
        evidenceDir,
        records: [...(prior?.records ?? []), ...resumedRecords, ...executedRecords],
        evidence: [...(prior?.evidence ?? []), ...resumedEvidence, ...executedEvidence],
      }
      // 原子写（tmp → rename）：会话文件是 R4-08/09/10 的对账依据，半截写入等于把真实
      // 执行数据变成"不可对账"——正是 §6.4 要避免的状态。
      await mkdir(dirname(sessionPath), { recursive: true })
      const tmpPath = `${sessionPath}.tmp-${process.pid}`
      await writeFile(tmpPath, JSON.stringify(merged, null, 2), 'utf8')
      await rename(tmpPath, sessionPath)

      // ④ done：会话已落盘 → 之后重放即可，不必再看日志阶段。
      //    **续用的用例也要标 done**：它们这一轮已经"落地"，不标就会在下一次调用里
      //    被反复续用（结果虽然一致，但阶段永远不收敛，且每次都白写一遍会话）。
      //    台账仍然写（向后兼容：service 层与其它读取方按台账判断"这个键有没有结果"）。
      //    登记失败不掩盖执行结果——事实来源始终是会话文件 + 调用日志。
      const settled: { readonly caseId: string; readonly key: string; readonly fingerprint: string; readonly attempt: number; readonly remoteIdempotencyKey?: string }[] = [
        ...[...resumable.values()].map(record => ({
          caseId: record.caseId, key: record.key, fingerprint: record.fingerprint,
          attempt: record.attempt,
          ...(record.remoteIdempotencyKey === undefined ? {} : { remoteIdempotencyKey: record.remoteIdempotencyKey }),
        })),
        ...pending,
      ]
      for (const item of settled) {
        const summary = produced.get(item.caseId)
        if (summary === undefined) continue
        try {
          await journal.write({
            caseId: item.caseId, key: item.key, fingerprint: item.fingerprint,
            attempt: item.attempt, phase: 'done', updatedAt: Date.now(),
            ...(item.remoteIdempotencyKey === undefined ? {} : { remoteIdempotencyKey: item.remoteIdempotencyKey }),
            fragment: {
              records: merged.records.filter(record => record.caseId === item.caseId),
              // `done` 阶段的证据已经在会话文件里了，日志只需要记录摘要（用于重放）。
              // `EvidenceEntry` 不带 caseId，这里也没有"按用例取证据"的需求。
              evidence: [],
            },
          })
        } catch {
          // 有意忽略：日志写不进去只会让下一次重试重放会话，不会让本次结果失真。
        }
        try {
          await ledger.run<ExecutorInvocationResult>({
            namespace: invocationNamespace,
            key: item.key,
            fingerprint: item.fingerprint,
            produce: async () => summary,
          })
        } catch {
          // 有意忽略：台账写不进去只会让下一次重试再执行一遍，不会让本次结果失真。
        }
      }

      // 只回给 agent 记录摘要（不暴露链内部字段），完整记录由宿主供门禁对账。
      return await finish(
        {
          records: requestedIds
            .map(id => produced.get(id) ?? replayable.get(id))
            .filter((record): record is ExecutorInvocationResult => record !== undefined),
          ...(replayable.size === 0 ? {} : { replayedCaseIds: requestedIds.filter(id => replayable.has(id)) }),
        },
        {
          success: true,
          caseCount: executedRecords.length,
          failureCount: executedRecords.filter(record => record.status !== 'pass').length,
          evidenceCount: executedEvidence.length,
        },
      )
    },
  }
}

/** 从已完成的执行片段取出该用例的记录摘要。 */
function summaryOfFragment(fragment: InvocationFragment): ExecutorInvocationResult {
  const record = fragment.records[fragment.records.length - 1]
  if (record === undefined) {
    return { seq: 0, caseId: '', status: 'fail', evidenceRefs: [], durationMs: 0 }
  }
  return {
    seq: record.seq,
    caseId: record.caseId,
    status: record.status,
    evidenceRefs: record.evidenceRefs,
    durationMs: record.durationMs,
  }
}

/**
 * design 产物的步骤 → HttpExecutor 的步骤定义。
 * 容忍两种写法：`action: "POST /api/login"` 字符串，或显式 `method`/`url` 字段；
 * 相对路径统一拼上被测服务基址（executor 只认绝对 URL）。
 *
 * `extraHeaders` 用于注入**远端幂等键**（docs/11 P1-07）：它在步骤自带的 headers
 * **之后**合并，因此宿主声明的幂等键不会被 design 产物里的同名字段顶掉——
 * 那是宿主的安全边界，不是模型可以覆盖的内容。
 */
function toHttpSteps(
  caseId: string,
  rawSteps: readonly Record<string, unknown>[],
  baseUrl: string,
  extraHeaders?: Readonly<Record<string, string>>,
): HttpStep[] {
  return rawSteps.map((raw, index) => {
    const action = typeof raw.action === 'string' ? raw.action : ''
    const match = /^(GET|POST|PUT|PATCH|DELETE)\s+(\/\S+)/i.exec(action)
    const explicitUrl = typeof raw.url === 'string' ? raw.url : typeof raw.endpoint === 'string' ? raw.endpoint : undefined
    const expectedValues = Array.isArray(raw.expected) ? raw.expected.map(String) : []
    const expectedStatus = typeof raw.expectedStatus === 'number'
      ? raw.expectedStatus
      : Number(expectedValues.find(value => /^\d{3}$/.test(value))) || undefined
    const declared = raw.headers !== null && typeof raw.headers === 'object' && !Array.isArray(raw.headers)
      ? Object.fromEntries(Object.entries(raw.headers as Record<string, unknown>).map(([key, value]) => [key, String(value)]))
      : undefined
    const headers = extraHeaders === undefined ? declared : { ...(declared ?? {}), ...extraHeaders }
    const path = explicitUrl ?? match?.[2] ?? '/'
    return {
      kind: 'http-request' as const,
      name: typeof raw.name === 'string' && raw.name !== '' ? raw.name : `${caseId}-step-${index + 1}`,
      method: (typeof raw.method === 'string' ? raw.method : match?.[1] ?? 'GET').toUpperCase(),
      url: /^https?:\/\//i.test(path) ? path : `${baseUrl.replace(/\/+$/, '')}${path.startsWith('/') ? '' : '/'}${path}`,
      ...(headers === undefined ? {} : { headers }),
      ...(raw.body === undefined ? {} : { body: raw.body }),
      ...(expectedStatus === undefined ? {} : { expectedStatus }),
      ...(typeof raw.expectedContains === 'string' ? { expectedContains: raw.expectedContains } : {}),
      ...(typeof raw.timeoutMs === 'number' ? { timeoutMs: raw.timeoutMs } : {}),
    }
  })
}

interface StoredSession {
  /** 完整记录：续用（把 `received` 片段补进会话）需要原样保留内容字段。 */
  readonly records: readonly ExecutionRecord[]
  readonly evidence: readonly EvidenceEntry[]
}

/** 读既有会话；文件不存在 → undefined。损坏时抛错（不静默丢弃执行真相）。 */
async function readSessionFile(path: string): Promise<StoredSession | undefined> {
  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch (error) {
    if (isMissingFile(error)) return undefined
    throw error
  }
  const parsed = JSON.parse(raw) as { records?: ExecutionRecord[]; evidence?: EvidenceEntry[] }
  return { records: parsed.records ?? [], evidence: parsed.evidence ?? [] }
}

// ── env_diag / gate_check ────────────────────────────────────────────────────

function envDiagTool(ctx: PlatformToolContext): ToolDefinition<Record<string, never>, unknown> {
  return {
    name: 'env_diag',
    description: '环境只读诊断：按宿主配置的固定探针白名单返回结构化探针结果（模型不能指定探针目标）。',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    async execute(_args, context) {
      assertNotAborted(context.signal)
      const specs = ctx.diagProbes ?? []
      if (specs.length === 0) {
        return { available: false, probes: [], hint: '宿主未配置 env_diag 探针白名单（diagProbes）；这不代表环境健康。' }
      }
      const probes: DiagProbe[] = await runDiag(specs, {
        ...(ctx.diagTimeoutMs === undefined ? {} : { timeoutMs: ctx.diagTimeoutMs }),
        ...(ctx.env === undefined ? {} : { env: ctx.env as NodeJS.ProcessEnv }),
      })
      return { available: true, probes }
    },
  }
}

interface GateCheckArgs {
  readonly pipelineId?: unknown
}

function gateCheckTool(ctx: PlatformToolContext): ToolDefinition<GateCheckArgs, unknown> {
  return {
    name: 'gate_check',
    description: '读取本流水线检查点（只读）：各阶段门禁判定与游标状态。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: { pipelineId: { type: 'string', description: '流水线 id；与宿主不一致时拒绝' } },
    },
    async execute(args, context) {
      assertNotAborted(context.signal)
      if (ctx.checkpoints === undefined && ctx.checkpointRoot === undefined) {
        return { error: '宿主未配置检查点端口或目录（checkpoints / checkpointRoot）' }
      }
      const requested = isNonEmptyString(args?.pipelineId) ? String(args.pipelineId) : ctx.pipelineId
      if (requested !== ctx.pipelineId) return { error: `pipelineId 不匹配：本次运行绑定 ${ctx.pipelineId}` }
      try {
        const checkpoint = ctx.checkpoints === undefined
          ? await loadCheckpoint(ctx.checkpointRoot!)
          : await ctx.checkpoints.load(ctx.checkpointRoot ?? ctx.pipelineId)
        if (checkpoint === null) return { error: `检查点不存在：${ctx.pipelineId}` }
        return { text: JSON.stringify(checkpoint, null, 2) }
      } catch (error) {
        return { error: errorMessage(error) }
      }
    },
  }
}

// ── 共用小工具 ───────────────────────────────────────────────────────────────

/** 证据目录作用域（每次新建：目录可能尚未创建，realpath 需先 mkdir）。 */
function evidenceScope(evidenceDir: string): WorkspaceScope {
  return new WorkspaceScope(resolvePath(evidenceDir))
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === 'string' && item.trim() !== '').map(item => item.trim())
}

function isNonEmptyString(value: unknown): boolean {
  return typeof value === 'string' && value.trim() !== ''
}

function clampLimit(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_KB_LIMIT
  return Math.min(Math.max(Math.trunc(value), 1), MAX_KB_LIMIT)
}

function today(): string {
  return new Date().toISOString().slice(0, 10)
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && 'code' in error && (error as { code?: string }).code === 'ENOENT'
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function assertNotAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new Error('tool call was aborted')
}
