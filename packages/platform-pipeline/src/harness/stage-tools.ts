/**
 * 阶段工具集（抽象工具名 → 真实实现）——宿主接线与 e2e 共用。
 *
 * 背景（实测踩到的坑）：阶段 ACL（tool-catalog.ts）里的 allow/deny 用的是
 * **设计文档定义的工具名**（parse_doc / fs_read / fs_write / kb_query …）。
 * harness 的 `tools.restrict()` 会校验所有 filter 名必须存在——宿主若没注册
 * 这些名字，会直接报
 *   tools.restrict() names unknown global tools "parse_doc", "fs_read", …
 * 阶段子会话根本起不来。所以集成到真实宿主时，必须把这套工具按原样注册。
 *
 * 注意 `subagent`：它在本抽象目录里是 DENY 项，但真实 harness 已经提供了
 * 同名真工具。这里**不注册** `subagent`（注册会与真工具撞名/覆盖），
 * 由 ACL 的 deny 负责在阶段内禁用它。
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'
import { mkdir, readdir, readFile, realpath, stat, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve as resolvePath } from 'node:path'
import { HttpExecutor, type HttpCase, type HttpStep } from '../executor/http.ts'
import { KnowledgeConflictError, MarkdownCaseStore, MarkdownKnowledgeStore, type KnowledgeEntry, type VersionedCase } from '../stores/markdown.ts'
import { loadCheckpoint } from '../checkpoint.ts'

const TOOL_TIMEOUT_MS = 180_000

/** 抽象目录中需要 DENY 但宿主不提供实现的名字（注册为无操作 stub 以通过 restrict 校验）。 */
const STUBBED_DENY_TOOLS = [] as const

export interface StageToolsDeps {
  /** 相对路径基准目录（工作区根）。产物根应在其下。 */
  readonly baseDir: string
  /** 产物根目录：executor_run 在其中定位 <pipelineId>/design.json。 */
  readonly artifactsRoot: string
  /** 执行证据落盘目录。 */
  readonly evidenceDir: string
  /** 执行会话落盘路径（供 R4-08/09/10 执行可信门禁对账）。 */
  readonly sessionPath: string
  /** receive 阶段输入文件（req_pull 读它）。 */
  readonly receiveInput?: string
  /** 检查点根目录（gate_check 按 pipelineId 读它）。 */
  readonly checkpointRoot?: string
  /** 当前流水线 id；用于精确绑定 design / session，禁止跨 pipeline 串读。 */
  readonly pipelineIdProvider?: () => string | undefined
  /** 可选的按 pipeline 隔离执行会话路径。 */
  readonly sessionPathProvider?: (pipelineId: string) => string
  /** 可选的按 pipeline 隔离证据目录。 */
  readonly evidenceDirProvider?: (pipelineId: string) => string
  /** 本地知识库/用例库适配；未提供时工具返回 available=false，不伪装为空结果。 */
  readonly knowledgeStore?: MarkdownKnowledgeStore
  readonly caseStore?: MarkdownCaseStore
  readonly projectId?: string
  /**
   * 被测服务基址。缺省时 executor_run 返回错误而不伪造执行记录——
   * 没有真实被测服务就不允许产出"执行证据"。
   */
  readonly targetBaseUrl?: string
  readonly timeoutMs?: number
}

function textResult(text: string) {
  return [{ type: 'text' as const, text }]
}

function unwrapArtifactText(text: string): string {
  try {
    const value = JSON.parse(text) as Record<string, unknown>
    if (value !== null && typeof value === 'object' && 'content' in value
      && typeof value.pipelineId === 'string' && typeof value.stageId === 'string'
      && typeof value.digest === 'string' && 'inputs' in value) {
      return JSON.stringify(value.content, null, 2)
    }
  } catch {
    // 普通文本/裸 JSON 原样返回
  }
  return text
}

/**
 * 在产物根下按 pipelineId 精确定位 design.json。
 *
 * 旧实现按 mtime 取“最新”产物，多个流水线并行时可能执行错误项目的用例。
 * 没有 pipelineId 时只允许存在一个候选，多个候选必须显式失败，绝不猜测。
 */
async function findDesignArtifact(artifactsRoot: string, pipelineId?: string): Promise<string | undefined> {
  const candidates: string[] = []
  const consider = async (path: string): Promise<void> => {
    try {
      await stat(path)
      candidates.push(path)
    } catch {
      // 不存在，跳过
    }
  }
  if (pipelineId !== undefined && pipelineId.trim() !== '') {
    for (const base of [artifactsRoot, join(artifactsRoot, 'artifacts')]) {
      await consider(join(base, pipelineId, 'design.json'))
    }
    return candidates[0]
  }
  for (const base of [artifactsRoot, join(artifactsRoot, 'artifacts')]) {
    let entries: string[]
    try { entries = await readdir(base) } catch { continue }
    for (const entry of entries) await consider(join(base, entry, 'design.json'))
  }
  if (candidates.length > 1) {
    throw new Error(`发现多个 design 产物但未提供 pipelineId，拒绝按 mtime 猜测：${candidates.join(', ')}`)
  }
  return candidates[0]
}

/**
 * 注册阶段工具集。已存在的同名工具会被跳过（不覆盖宿主真工具）。
 */
/**
 * 读既有执行会话（用于续接链）。文件不存在 → undefined（首次执行）。
 * 文件存在但读不动/不是合法 JSON → 抛错：**不覆盖**，把未损坏的原件留给诊断，
 * 因为静默丢弃既有记录等于销毁执行真相。
 */
async function assertRealPathWithin(root: string, target: string): Promise<void> {
  const realRoot = await realpath(root)
  let probe = target
  while (true) {
    try {
      const realProbe = await realpath(probe)
      const rel = relative(realRoot, realProbe)
      if (rel.startsWith('..') || isAbsolute(rel)) throw new Error(`path escapes workspace root: ${target}`)
      return
    } catch (error) {
      if (error instanceof Error && /escapes workspace root/.test(error.message)) throw error
      const parent = dirname(probe)
      if (parent === probe) throw new Error(`path cannot be resolved inside workspace root: ${target}`)
      probe = parent
    }
  }
}

/** Resolve and sandbox a tool path. Absolute paths are accepted only inside baseDir. */
async function resolveToolPath(baseDir: string, requested: string, forWrite = false): Promise<string> {
  if (typeof requested !== 'string' || requested.trim() === '') throw new Error('path must be a non-empty string')
  const root = resolvePath(baseDir)
  const target = resolvePath(root, requested)
  const rel = relative(root, target)
  if (rel.startsWith('..') || isAbsolute(rel)) throw new Error(`path escapes workspace root: ${requested}`)
  await assertRealPathWithin(root, forWrite ? dirname(target) : target)
  return target
}

async function readSessionFile(
  path: string,
): Promise<{ records: Array<{ seq: number; ownHash: string; segment: number }>; evidence: unknown[] } | undefined> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
  const parsed = JSON.parse(text) as { records?: never[]; evidence?: never[] }
  return { records: parsed.records ?? [], evidence: parsed.evidence ?? [] }
}

export function registerStageTools(ctx: Context, deps: StageToolsDeps): void {
  const timeoutMs = deps.timeoutMs ?? TOOL_TIMEOUT_MS
  const resolve = (path: string, forWrite = false): Promise<string> => resolveToolPath(deps.baseDir, path, forWrite)
  const exists = (name: string): boolean => {
    try {
      return ctx.tools.get(name) !== undefined
    } catch {
      return false
    }
  }

  const register = (name: string, build: () => Parameters<Context['tools']['register']>[0]): void => {
    if (exists(name)) return
    ctx.tools.register(build())
  }

  register('fs_read', () => defineTool({
    name: 'fs_read',
    description: 'Read a file (absolute or workspace-relative path). Returns its text content.',
    parameters: { path: { type: 'string', required: true, description: 'file path' } },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { text: { type: 'string' } } },
      render: (_args, value) => textResult(value.text ?? ''),
    },
    timeoutMs,
    async execute(args) {
      return { text: unwrapArtifactText(await readFile(await resolve(args.path!), 'utf8')) }
    },
  }))

  register('fs_write', () => defineTool({
    name: 'fs_write',
    description: 'Write a file (absolute or workspace-relative path). Returns the path.',
    parameters: {
      path: { type: 'string', required: true, description: 'file path' },
      content: { type: 'string', required: true, description: 'file content' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { path: { type: 'string' } } },
      render: (_args, value) => textResult(`written ${value.path}`),
    },
    timeoutMs,
    async execute(args) {
      const target = await resolve(args.path!, true)
      const dir = target.slice(0, target.lastIndexOf('/'))
      if (dir !== '') await mkdir(dir, { recursive: true })
      await writeFile(target, args.content!)
      return { path: args.path! }
    },
  }))

  register('parse_doc', () => defineTool({
    name: 'parse_doc',
    description: 'Parse a document file (text/markdown; ppt/word not supported) and return its text.',
    parameters: { path: { type: 'string', required: true, description: 'document path' } },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { text: { type: 'string' } } },
      render: (_args, value) => textResult(value.text ?? ''),
    },
    timeoutMs,
    async execute(args) {
      return { text: unwrapArtifactText(await readFile(await resolve(args.path!), 'utf8')) }
    },
  }))

  register('kb_query', () => defineTool({
    name: 'kb_query',
    description: 'Query the knowledge base (read-only). Returns availability, source, score and provenance.',
    parameters: {
      entities: { type: 'array', items: { type: 'string' }, description: 'query entities' },
      tags: { type: 'array', items: { type: 'string' }, description: 'query tags' },
      text: { type: 'string', description: 'free-text query' },
      limit: { type: 'integer', description: 'maximum hits, default 8' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: {
        available: { type: 'boolean' }, source: { type: 'string' }, entries: { type: 'array', items: { type: 'json' } } },
      },
      render: (_args, value) => textResult(JSON.stringify(value)),
    },
    timeoutMs,
    async execute(args) {
      if (deps.knowledgeStore === undefined) return { available: false, source: 'unconfigured', entries: [] }
      const hits = await deps.knowledgeStore.readHits({
        ...(Array.isArray(args.entities) ? { entities: args.entities as string[] } : {}),
        ...(Array.isArray(args.tags) ? { tags: args.tags as string[] } : {}),
        ...(typeof args.text === 'string' ? { text: args.text } : {}),
        project: deps.projectId,
        limit: typeof args.limit === 'number' ? Math.min(Math.max(args.limit, 1), 50) : 8,
      })
      return { available: true, source: 'markdown-fs', entries: hits.map(hit => ({ ...hit.entry, score: hit.score, matchedBy: [...hit.matchedBy], matchedTerms: [...hit.matchedTerms] })) } as never
    },
  }))

  register('kb_write', () => defineTool({
    name: 'kb_write',
    description: 'Write one approved structured knowledge entry to the configured knowledge store.',
    parameters: { entry: { type: 'json', required: true, description: 'knowledge entry object' } },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { available: { type: 'boolean' }, id: { type: 'string' }, conflict: { type: 'boolean' }, conflicts: { type: 'array', items: { type: 'json' } }, error: { type: 'string' } } },
      render: (_args, value) => textResult(JSON.stringify(value)),
    },
    timeoutMs,
    async execute(args) {
      if (deps.knowledgeStore === undefined) return { available: false, error: 'knowledge store is not configured' }
      const entry = args.entry as unknown as KnowledgeEntry
      if (entry === null || typeof entry !== 'object' || typeof entry.id !== 'string' || entry.id.trim() === '') return { available: true, error: 'entry.id is required' }
      if (deps.projectId !== undefined && entry.project !== deps.projectId) return { available: true, error: `entry.project must equal ${deps.projectId}` }
      try {
        const id = await deps.knowledgeStore.write(entry)
        return { available: true, id, conflict: false }
      } catch (error) {
        if (error instanceof KnowledgeConflictError) return { available: true, conflict: true, conflicts: [...error.conflicts] } as never
        throw error
      }
    },
  }))

  register('case_query', () => defineTool({
    name: 'case_query',
    description: 'Query historical cases (read-only).',
    parameters: { requirement: { type: 'string' }, version: { type: 'string' } },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { available: { type: 'boolean' }, source: { type: 'string' }, cases: { type: 'array', items: { type: 'json' } } } },
      render: (_args, value) => textResult(JSON.stringify(value)),
    },
    timeoutMs,
    async execute(args) {
      if (deps.caseStore === undefined) return { available: false, source: 'unconfigured', cases: [] }
      const cases = await deps.caseStore.query({
        project: deps.projectId ?? '',
        ...(typeof args.requirement === 'string' ? { requirement: args.requirement } : {}),
        ...(typeof args.version === 'string' ? { version: args.version } : {}),
      })
      return { available: true, source: 'markdown-fs', cases } as never
    },
  }))

  register('case_archive', () => defineTool({
    name: 'case_archive',
    description: 'Archive one approved versioned test case to the configured case store.',
    parameters: { case: { type: 'json', required: true, description: 'versioned case object' } },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { available: { type: 'boolean' }, caseId: { type: 'string' }, error: { type: 'string' } } },
      render: (_args, value) => textResult(JSON.stringify(value)),
    },
    timeoutMs,
    async execute(args) {
      if (deps.caseStore === undefined) return { available: false, error: 'case store is not configured' }
      const value = args.case as unknown as VersionedCase
      if (value === null || typeof value !== 'object' || typeof value.caseId !== 'string' || value.caseId.trim() === '') return { available: true, error: 'case.caseId is required' }
      if (deps.projectId !== undefined && value.project !== deps.projectId) return { available: true, error: `case.project must equal ${deps.projectId}` }
      await deps.caseStore.archive(value)
      return { available: true, caseId: value.caseId }
    },
  }))

  register('env_diag', () => defineTool({
    name: 'env_diag',
    description: 'Environment diagnostic probes.',
    parameters: {},
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { probes: { type: 'array', items: { type: 'json' } } } },
      render: () => textResult('[]'),
    },
    timeoutMs,
    async execute() {
      return { probes: [] }
    },
  }))

  register('req_pull', () => defineTool({
    name: 'req_pull',
    description: 'Pull the raw requirement input for the current pipeline (read-only).',
    parameters: {},
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: { text: { type: 'string' }, error: { type: 'string' } },
      },
      render: (_args, value) => textResult(value.text ?? value.error ?? ''),
    },
    timeoutMs,
    async execute() {
      if (deps.receiveInput === undefined) return { error: '未配置 receive 输入路径（receiveInput）' }
      try {
        return { text: await readFile(await resolve(deps.receiveInput), 'utf8') }
      } catch (error) {
        return { error: error instanceof Error ? error.message : String(error) }
      }
    },
  }))

  register('gate_check', () => defineTool({
    name: 'gate_check',
    description: 'Read the pipeline checkpoint (read-only): per-stage gate verdicts and cursor state.',
    parameters: { pipelineId: { type: 'string', required: true, description: 'pipeline id' } },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: { text: { type: 'string' }, error: { type: 'string' } },
      },
      render: (_args, value) => textResult(value.text ?? value.error ?? ''),
    },
    timeoutMs,
    async execute(args) {
      if (deps.checkpointRoot === undefined) return { error: '未配置检查点根目录（checkpointRoot）' }
      try {
        const pipelineRoot = await resolveToolPath(deps.checkpointRoot, String(args.pipelineId ?? ''))
        const cp = await loadCheckpoint(pipelineRoot)
        if (cp === null) return { error: `检查点不存在：${args.pipelineId}` }
        return { text: JSON.stringify(cp, null, 2) }
      } catch (error) {
        return { error: error instanceof Error ? error.message : String(error) }
      }
    },
  }))

  // executor_run：真实 HttpExecutor（记录 + 证据落盘，供执行可信门禁 R4-08/09/10 对账）。
  register('executor_run', () => defineTool({
    name: 'executor_run',
    description: 'Execute the given case ids against the system under test and return their real records. Call this with the case ids from design.json.',
    parameters: {
      pipelineId: { type: 'string', description: 'current pipeline id; required when multiple pipelines share the workspace' },
      caseIds: { type: 'array', items: { type: 'string' }, description: 'case ids to run' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          records: { type: 'array', items: { type: 'json' } },
          error: { type: 'string' },
        },
      },
      render: (_args, value) => textResult(JSON.stringify(value.records ?? value.error ?? [])),
    },
    timeoutMs,
    async execute(args) {
      const baseUrl = deps.targetBaseUrl
      if (baseUrl === undefined || baseUrl === '') {
        return { error: '未配置被测服务基址（targetBaseUrl）：拒绝伪造执行记录，execute 阶段的执行可信门禁将无法通过。' }
      }
      try {
        const requestedPipelineId = typeof args.pipelineId === 'string' && args.pipelineId.trim() !== ''
          ? args.pipelineId.trim()
          : deps.pipelineIdProvider?.()
        const designPath = await findDesignArtifact(deps.artifactsRoot, requestedPipelineId)
        if (designPath === undefined) {
          return { error: `未找到 design 产物（${deps.artifactsRoot}/*/design.json）：design 阶段尚未完成。` }
        }
        const design = JSON.parse(await readFile(designPath, 'utf8')) as {
          pipelineId?: string
          testCases?: Array<{ id: string; steps: Array<Record<string, unknown>> }>
          reusedCases?: Array<{ id: string; steps: Array<Record<string, unknown>> }>
        }
        if (requestedPipelineId !== undefined && design.pipelineId !== undefined && design.pipelineId !== requestedPipelineId) {
          return { error: `design 产物 pipelineId=${design.pipelineId} 与当前 pipelineId=${requestedPipelineId} 不一致` }
        }
        const allDesignCases = [...(design.testCases ?? []), ...(design.reusedCases ?? [])]
        const selectedIds = args.caseIds ?? allDesignCases.map((c) => c.id)
        if (!Array.isArray(selectedIds) || selectedIds.some((id) => typeof id !== 'string' || id.trim() === '')) {
          return { error: 'caseIds 必须是非空字符串数组' }
        }
        if (new Set(selectedIds).size !== selectedIds.length) {
          return { error: 'caseIds 不能包含重复用例' }
        }
        const cases: HttpCase[] = allDesignCases.map((tc) => {
          const steps: HttpStep[] = tc.steps.map((raw, index) => {
            const action = typeof raw.action === 'string' ? raw.action : ''
            const method = typeof raw.method === 'string' ? raw.method.toUpperCase() : undefined
            const explicitUrl = typeof raw.url === 'string' ? raw.url : typeof raw.endpoint === 'string' ? raw.endpoint : undefined
            const match = /^(GET|POST|PUT|PATCH|DELETE)\s+(\/\S+)/i.exec(action)
            const expectedValues = Array.isArray(raw.expected) ? raw.expected.map(String) : []
            const expectedStatus = typeof raw.expectedStatus === 'number'
              ? raw.expectedStatus
              : Number(expectedValues.find((value) => /^\d{3}$/.test(value))) || undefined
            const path = explicitUrl ?? match?.[2] ?? '/api/login/sms'
            const url = /^https?:\/\//i.test(path) ? path : `${baseUrl}${path.startsWith('/') ? '' : '/'}${path}`
            const headers = raw.headers !== null && typeof raw.headers === 'object' && !Array.isArray(raw.headers)
              ? Object.fromEntries(Object.entries(raw.headers as Record<string, unknown>).map(([key, value]) => [key, String(value)]))
              : undefined
            return {
              kind: 'http-request', name: `${tc.id}-step-${index + 1}`,
              method: method ?? match?.[1]?.toUpperCase() ?? 'GET', url,
              ...(headers === undefined ? {} : { headers }),
              ...(raw.body === undefined ? {} : { body: raw.body }),
              ...(expectedStatus === undefined ? {} : { expectedStatus }),
              ...(typeof raw.expectedContains === 'string' ? { expectedContains: raw.expectedContains } : {}),
              ...(typeof raw.timeoutMs === 'number' ? { timeoutMs: raw.timeoutMs } : {}),
            }
          })
          return { id: tc.id, steps }
        })
        const executor = new HttpExecutor({
          resolveCase: async (id) => cases.find((c) => c.id === id),
          writeEvidence: async (path, content) => {
            const evidenceRoot = requestedPipelineId === undefined
              ? deps.evidenceDir
              : (deps.evidenceDirProvider?.(requestedPipelineId) ?? deps.evidenceDir)
            const target = isAbsolute(path) ? resolvePath(path) : resolvePath(evidenceRoot, path)
            const rel = relative(resolvePath(evidenceRoot), target)
            if (rel.startsWith('..') || isAbsolute(rel)) throw new Error(`非法 evidence 文件路径：${path}`)
            await mkdir(evidenceRoot, { recursive: true })
            await assertRealPathWithin(evidenceRoot, dirname(target))
            await writeFile(target, content, { flag: 'wx' }).catch(async (error) => {
              if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
              await writeFile(target, content)
            })
          },
        })
        // 续接既有会话，而不是覆盖：executor_run 会被多次调用（分批执行），
        // 每次覆盖会让先前批次的记录消失，门禁对账 R4-08 随即判定它们「漏跑」。
        // 实测踩到：先跑 10 条、再单独跑 1 条 → 会话只剩最后 1 条 → 10 条 pass 被判无记录。
        const sessionPath = deps.sessionPathProvider?.(requestedPipelineId ?? '') ?? deps.sessionPath
        const evidenceRoot = deps.evidenceDirProvider?.(requestedPipelineId ?? '') ?? deps.evidenceDir
        const prior = await readSessionFile(sessionPath)
        const last = prior?.records[prior.records.length - 1]
        const session = await executor.run(selectedIds, {
          designArtifactPath: designPath,
          evidenceDir: evidenceRoot,
          invocationId: `inv-${Date.now()}`,
          ...(last === undefined
            ? {}
            : {
                continuation: {
                  startSeq: last.seq + 1,
                  prevHash: last.ownHash,
                  segment: last.segment, // 同一执行链的连续批次：不开新段，链保持完整可验
                },
              }),
        })
        // 合并：旧记录 + 新记录（证据同样合并），保持一条完整可验证的链
        const merged = {
          records: [...(prior?.records ?? []), ...session.records],
          evidence: [...(prior?.evidence ?? []), ...session.evidence],
        }
        await mkdir(dirname(sessionPath), { recursive: true })
        await writeFile(sessionPath, JSON.stringify({ pipelineId: requestedPipelineId, evidenceDir: evidenceRoot, ...merged }, null, 2))
        // 只给 agent 记录摘要（caseId/status/evidenceRefs/真实时长），不暴露实现细节
        return {
          records: session.records.map((r) => ({
            seq: r.seq, caseId: r.caseId, status: r.status, evidenceRefs: r.evidenceRefs, durationMs: r.durationMs,
          })),
        } as never
      } catch (error) {
        return { error: error instanceof Error ? error.message : String(error) }
      }
    },
  }))

  // DENY 名单中的工具也需存在（restrict() 校验所有 filter 名）：无操作 stub。
  // `subagent` 不在此列——真实宿主已提供同名真工具，注册会撞名。
  for (const name of STUBBED_DENY_TOOLS) {
    register(name, () => defineTool({
      name,
      description: `${name} — not available in this host.`,
      parameters: {},
      output: {
        schema: { type: 'object', additionalProperties: false, properties: { error: { type: 'string' } } },
        render: (_args, value) => textResult(value.error ?? ''),
      },
      timeoutMs,
      async execute() {
        return { error: `${name} not available in this host` }
      },
    }))
  }
}