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

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve as resolvePath } from 'node:path'

import { artifactPath, loadCheckpoint } from '../checkpoint.ts'
import { runDiag, type DiagProbe, type DiagSpec } from '../executor/env-diag.ts'
import { HttpExecutor, type HttpCase, type HttpRequestFn, type HttpStep } from '../executor/http.ts'
import type { ExecutionSession } from '../executor/executor.ts'
import { FsArtifactStore } from '../stores/fs.ts'
import {
  KnowledgeConflictError,
  MarkdownCaseStore,
  MarkdownKnowledgeStore,
  type KnowledgeEntry,
  type VersionedCase,
} from '../stores/markdown.ts'
import { WorkspaceScope } from './fs-tools.ts'
import type { ToolDefinition } from './ports.ts'

/** 单次工具调用可读文档上限（超出显式标记截断，不静默丢内容）。 */
const DEFAULT_MAX_DOCUMENT_BYTES = 512 * 1024
/** 表格工具最多返回的数据行数（含表头）。 */
const DEFAULT_MAX_TABLE_ROWS = 2000
const DEFAULT_KB_LIMIT = 8
const MAX_KB_LIMIT = 50

export interface PlatformToolContext {
  /** 平台项目根：fs 作用域、产物、执行会话与证据目录的共同基准。 */
  readonly projectRoot: string
  /** 产物存储根（= FsArtifactStore 的 baseDir）。 */
  readonly artifactsRoot: string
  readonly pipelineId: string
  readonly projectId: string
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
   * `env_diag` 的固定探针白名单（docs/06：不授予任意命令执行权）。
   * 模型不能自行指定目标；缺省 = 探针未配置。
   */
  readonly diagProbes?: readonly DiagSpec[]
  readonly diagTimeoutMs?: number
  readonly env?: Readonly<Record<string, string | undefined>>
  /** 注入 HTTP 传输（测试用本地服务器；默认 globalThis.fetch）。 */
  readonly request?: HttpRequestFn
  readonly maxDocumentBytes?: number
  readonly maxTableRows?: number
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
  const maxDocBytes = ctx.maxDocumentBytes ?? DEFAULT_MAX_DOCUMENT_BYTES
  const maxTableRows = ctx.maxTableRows ?? DEFAULT_MAX_TABLE_ROWS
  const knowledge = ctx.knowledgeRoot === undefined ? undefined : new MarkdownKnowledgeStore(ctx.knowledgeRoot)
  const cases = ctx.casesRoot === undefined ? undefined : new MarkdownCaseStore(ctx.casesRoot)

  return [
    parseDocTool(ctx, maxDocBytes, maxTableRows),
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

/** 文本族扩展名（按原文返回）与表格族（结构化解析）。二进制文档显式不支持。 */
const TEXT_EXTENSIONS = new Set(['.md', '.markdown', '.mdx', '.txt', '.log', '.rst', '.adoc', '.yaml', '.yml'])
const TABLE_EXTENSIONS: Readonly<Record<string, string>> = { '.csv': ',', '.tsv': '\t', '.tab': '\t' }
/** 已知但当前不支持的二进制格式：显式报错，避免模型把二进制当文本读成乱码。 */
const KNOWN_BINARY_EXTENSIONS = new Set(['.xlsx', '.xls', '.docx', '.doc', '.pptx', '.ppt', '.pdf', '.zip', '.png', '.jpg', '.jpeg'])

interface ParseDocArgs {
  readonly path?: unknown
}

interface ParseDocResult {
  readonly path: string
  readonly format: 'text' | 'table' | 'json' | 'unsupported'
  readonly text?: string
  readonly rows?: readonly (readonly string[])[]
  readonly truncated?: boolean
  readonly error?: string
}

function parseDocTool(ctx: PlatformToolContext, maxBytes: number, maxRows: number): ToolDefinition<ParseDocArgs, ParseDocResult> {
  const scope = new WorkspaceScope(ctx.projectRoot)
  return {
    name: 'parse_doc',
    description:
      '解析工作区内的项目文档并返回可用文本。支持 md/markdown/txt/log/yaml 等文本族、'
      + 'csv/tsv 表格（结构化 rows）与 json；xlsx/docx/pdf 等二进制格式当前不支持，会显式报错。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['path'],
      properties: { path: { type: 'string', description: '相对工作区根的文档路径' } },
    },
    async execute(args, context) {
      assertNotAborted(context.signal)
      const label = typeof args?.path === 'string' ? args.path : ''
      const target = await scope.existingFile(args?.path)
      const extension = extensionOf(target)
      if (KNOWN_BINARY_EXTENSIONS.has(extension)) {
        return {
          path: label,
          format: 'unsupported',
          error: `不支持解析 ${extension} 二进制文档：请先转换为 markdown / csv / txt 后再导入（当前宿主不内置 Office/PDF 解析器）。`,
        }
      }
      const raw = await readFile(target, 'utf8')
      const text = stripBom(raw)
      const truncated = Buffer.byteLength(text, 'utf8') > maxBytes
      const body = truncated ? text.slice(0, maxBytes) : text
      const delimiter = TABLE_EXTENSIONS[extension]
      if (delimiter !== undefined) {
        const table = parseDelimited(body, delimiter, maxRows)
        return {
          path: label,
          format: 'table',
          rows: table.rows,
          ...(truncated || table.truncated ? { truncated: true } : {}),
        }
      }
      if (extension === '.json') {
        try {
          return { path: label, format: 'json', text: JSON.stringify(JSON.parse(body), null, 2) }
        } catch (error) {
          // 非法 JSON 不当成"解析成功"：退回原文并显式说明，避免模型基于半截结构推理。
          return {
            path: label,
            format: 'text',
            text: body,
            error: `文件不是合法 JSON（${errorMessage(error)}），已按原文返回。`,
          }
        }
      }
      if (TEXT_EXTENSIONS.has(extension) || extension === '') {
        return { path: label, format: 'text', text: body, ...(truncated ? { truncated: true } : {}) }
      }
      return {
        path: label,
        format: 'unsupported',
        error: `不支持解析 ${extension} 文档：当前支持 ${[...TEXT_EXTENSIONS, ...Object.keys(TABLE_EXTENSIONS), '.json'].join(' / ')}。`,
      }
    },
  }
}

/** RFC4180 风格分隔符解析：支持引号包裹、双引号转义与 CRLF。 */
function parseDelimited(text: string, delimiter: string, maxRows: number): { rows: string[][]; truncated: boolean } {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false
  let truncated = false
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!
    if (quoted) {
      if (char !== '"') { field += char; continue }
      if (text[index + 1] === '"') { field += '"'; index += 1; continue }
      quoted = false
      continue
    }
    if (char === '"') { quoted = true; continue }
    if (char === delimiter) { row.push(field); field = ''; continue }
    if (char === '\r') continue
    if (char === '\n') {
      row.push(field)
      rows.push(row)
      row = []
      field = ''
      if (rows.length >= maxRows) { truncated = true; break }
      continue
    }
    field += char
  }
  if (!truncated && (field !== '' || row.length > 0)) {
    row.push(field)
    rows.push(row)
  }
  return { rows, truncated }
}

// ── 知识库 / 用例库 ───────────────────────────────────────────────────────────

interface KbQueryArgs {
  readonly entities?: unknown
  readonly tags?: unknown
  readonly text?: unknown
  readonly limit?: unknown
}

function kbQueryTool(ctx: PlatformToolContext, store: MarkdownKnowledgeStore | undefined): ToolDefinition<KbQueryArgs, unknown> {
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
      const hits = await store.readHits({
        ...(entities.length === 0 ? {} : { entities }),
        ...(tags.length === 0 ? {} : { tags }),
        ...(text === undefined ? {} : { text }),
        project: ctx.projectId,
        limit: clampLimit(args?.limit),
      })
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

function kbWriteTool(ctx: PlatformToolContext, store: MarkdownKnowledgeStore | undefined): ToolDefinition<KbWriteArgs, unknown> {
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

function caseQueryTool(ctx: PlatformToolContext, store: MarkdownCaseStore | undefined): ToolDefinition<CaseQueryArgs, unknown> {
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

function caseArchiveTool(ctx: PlatformToolContext, store: MarkdownCaseStore | undefined): ToolDefinition<CaseArchiveArgs, unknown> {
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
}

/**
 * 真实执行器工具（docs/08 防线 1：executor 是唯一执行者）。
 *
 * - 用例定义**由 executor 自读** `artifacts/<pipelineId>/design.json`，不采信调用方传入的步骤内容；
 * - 证据落 `executor/<pipelineId>/evidence/`（execute 阶段 agent 无写权）；
 * - 会话按 seq/prevHash 续接而非覆盖：executor_run 会被分批多次调用，覆盖会让先前批次
 *   的记录消失，门禁 R4-08 随即把它们判成"漏跑"（Harness 侧实测踩到过）。
 */
function executorRunTool(ctx: PlatformToolContext): ToolDefinition<ExecutorRunArgs, ExecutorRunResult> {
  const artifacts = new FsArtifactStore(ctx.artifactsRoot)
  const sessionPath = executorSessionPath(ctx.projectRoot, ctx.pipelineId)
  const evidenceDir = executorEvidenceDir(ctx.projectRoot, ctx.pipelineId)
  return {
    name: 'executor_run',
    description:
      '对被测系统真实执行指定用例并返回真实执行记录（只传 caseIds，用例定义由 executor 自读 design 产物）。'
      + '不传 caseIds 表示执行 design 中的全部用例。',
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
      const baseUrl = ctx.targetBaseUrl
      if (baseUrl === undefined || baseUrl.trim() === '') {
        return { error: '宿主未配置被测服务基址（targetBaseUrl）：拒绝伪造执行记录，execute 阶段的 R4-08/09/10 将无法通过。' }
      }
      const requested = isNonEmptyString(args?.pipelineId) ? String(args.pipelineId) : ctx.pipelineId
      if (requested !== ctx.pipelineId) {
        return { error: `pipelineId 不匹配：本次运行绑定 ${ctx.pipelineId}，拒绝执行 ${requested}（防止跨流水线串读用例）` }
      }
      const design = await artifacts.read(artifactPath(ctx.pipelineId, 'design'))
      if (design === null) {
        return { error: `未找到 design 产物（artifacts/${ctx.pipelineId}/design.json）：design 阶段尚未完成。` }
      }
      const content = design.content as {
        readonly testCases?: readonly Record<string, unknown>[]
        readonly reusedCases?: readonly Record<string, unknown>[]
      }
      const designCases = [...(content.testCases ?? []), ...(content.reusedCases ?? [])]
        .map(raw => ({ id: String((raw as Record<string, unknown>).id ?? ''), steps: Array.isArray((raw as Record<string, unknown>).steps) ? (raw as { steps: readonly Record<string, unknown>[] }).steps : [] }))
        .filter(entry => entry.id !== '')
      if (designCases.length === 0) {
        return { error: 'design 产物中没有任何带 id 的用例（testCases/reusedCases 均为空）。' }
      }
      const requestedIds = args?.caseIds === undefined ? designCases.map(entry => entry.id) : stringArray(args.caseIds)
      if (requestedIds.length === 0) return { error: 'caseIds 必须是非空字符串数组' }
      const known = new Set(designCases.map(entry => entry.id))
      const unknown = requestedIds.filter(id => !known.has(id))
      if (unknown.length > 0) {
        // 不在 design 里的用例无法执行：显式失败，避免产出一条"凭空 pass"的记录。
        return { error: `caseIds 不在 design 产物中：${unknown.join(', ')}` }
      }
      const executor = new HttpExecutor({
        resolveCase: async (id) => {
          const found = designCases.find(entry => entry.id === id)
          return found === undefined ? undefined : { id: found.id, steps: toHttpSteps(found.id, found.steps, baseUrl) }
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
      const last = prior?.records[prior.records.length - 1]
      const session = await executor.run(requestedIds, {
        designArtifactPath: artifactPath(ctx.pipelineId, 'design'),
        evidenceDir,
        invocationId: `inv-${Date.now()}`,
        ...(last === undefined
          ? {}
          : { continuation: { startSeq: last.seq + 1, prevHash: last.ownHash, segment: last.segment } }),
      })
      const merged = {
        pipelineId: ctx.pipelineId,
        evidenceDir,
        records: [...(prior?.records ?? []), ...session.records],
        evidence: [...(prior?.evidence ?? []), ...session.evidence],
      }
      await mkdir(dirname(sessionPath), { recursive: true })
      await writeFile(sessionPath, JSON.stringify(merged, null, 2), 'utf8')
      // 只回给 agent 记录摘要（不暴露链内部字段），完整记录由宿主供门禁对账。
      return {
        records: session.records.map(record => ({
          seq: record.seq, caseId: record.caseId, status: record.status,
          evidenceRefs: record.evidenceRefs, durationMs: record.durationMs,
        })),
      }
    },
  }
}

/**
 * design 产物的步骤 → HttpExecutor 的步骤定义。
 * 容忍两种写法：`action: "POST /api/login"` 字符串，或显式 `method`/`url` 字段；
 * 相对路径统一拼上被测服务基址（executor 只认绝对 URL）。
 */
function toHttpSteps(caseId: string, rawSteps: readonly Record<string, unknown>[], baseUrl: string): HttpStep[] {
  return rawSteps.map((raw, index) => {
    const action = typeof raw.action === 'string' ? raw.action : ''
    const match = /^(GET|POST|PUT|PATCH|DELETE)\s+(\/\S+)/i.exec(action)
    const explicitUrl = typeof raw.url === 'string' ? raw.url : typeof raw.endpoint === 'string' ? raw.endpoint : undefined
    const expectedValues = Array.isArray(raw.expected) ? raw.expected.map(String) : []
    const expectedStatus = typeof raw.expectedStatus === 'number'
      ? raw.expectedStatus
      : Number(expectedValues.find(value => /^\d{3}$/.test(value))) || undefined
    const headers = raw.headers !== null && typeof raw.headers === 'object' && !Array.isArray(raw.headers)
      ? Object.fromEntries(Object.entries(raw.headers as Record<string, unknown>).map(([key, value]) => [key, String(value)]))
      : undefined
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
  readonly records: readonly { readonly seq: number; readonly ownHash: string; readonly segment: number }[]
  readonly evidence: readonly unknown[]
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
  const parsed = JSON.parse(raw) as { records?: never[]; evidence?: never[] }
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
      if (ctx.checkpointRoot === undefined) return { error: '宿主未配置检查点目录（checkpointRoot）' }
      const requested = isNonEmptyString(args?.pipelineId) ? String(args.pipelineId) : ctx.pipelineId
      if (requested !== ctx.pipelineId) return { error: `pipelineId 不匹配：本次运行绑定 ${ctx.pipelineId}` }
      try {
        const checkpoint = await loadCheckpoint(ctx.checkpointRoot)
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

function extensionOf(path: string): string {
  const base = path.slice(path.lastIndexOf('/') + 1)
  const dot = base.lastIndexOf('.')
  return dot <= 0 ? '' : base.slice(dot).toLowerCase()
}

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
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
