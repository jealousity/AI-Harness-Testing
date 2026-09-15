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
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { HttpExecutor, type HttpCase, type HttpStep } from '../executor/http.ts'
import { loadCheckpoint } from '../checkpoint.ts'

const TOOL_TIMEOUT_MS = 180_000

/** 抽象目录中需要 DENY 但宿主不提供实现的名字（注册为无操作 stub 以通过 restrict 校验）。 */
const STUBBED_DENY_TOOLS = ['kb_write', 'case_archive'] as const

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

/**
 * 在产物根下定位最新的 design.json。
 *
 * 布局注意：检查点把产物路径钉成 `artifacts/<pipelineId>/<stage>.json`，所以相对
 * artifactsRoot 实际还多一层 `artifacts/`。实测踩到过：只找 `<root>/*\/design.json`
 * 时 executor 永远找不到 design 产物，execute 阶段 11 条用例全部 pending、零执行
 * （子会话逐字报告「executor 无法定位上游 design 产物」）。故两级都找。
 */
async function findNewestDesignArtifact(artifactsRoot: string): Promise<string | undefined> {
  const candidates: Array<{ path: string; mtime: number }> = []
  const consider = async (path: string): Promise<void> => {
    try {
      const info = await stat(path)
      candidates.push({ path, mtime: info.mtimeMs })
    } catch {
      // 不存在，跳过
    }
  }

  // 直接子目录（<root>/<pipelineId>/design.json）与标准布局（<root>/artifacts/<pipelineId>/design.json）
  for (const base of [artifactsRoot, join(artifactsRoot, 'artifacts')]) {
    let entries: string[]
    try {
      entries = await readdir(base)
    } catch {
      continue
    }
    for (const entry of entries) {
      await consider(join(base, entry, 'design.json'))
    }
  }

  if (candidates.length === 0) return undefined
  candidates.sort((a, b) => b.mtime - a.mtime)
  return candidates[0]!.path
}

/**
 * 注册阶段工具集。已存在的同名工具会被跳过（不覆盖宿主真工具）。
 */
/**
 * 读既有执行会话（用于续接链）。文件不存在 → undefined（首次执行）。
 * 文件存在但读不动/不是合法 JSON → 抛错：**不覆盖**，把未损坏的原件留给诊断，
 * 因为静默丢弃既有记录等于销毁执行真相。
 */
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
  const resolve = (path: string): string => (path.startsWith('/') ? path : join(deps.baseDir, path))
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
      return { text: await readFile(resolve(args.path!), 'utf8') }
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
      const target = resolve(args.path!)
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
      return { text: await readFile(resolve(args.path!), 'utf8') }
    },
  }))

  register('kb_query', () => defineTool({
    name: 'kb_query',
    description: 'Query the knowledge base (read-only).',
    parameters: { entities: { type: 'array', items: { type: 'string' }, description: 'query entities' } },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { entries: { type: 'array', items: { type: 'json' } } } },
      render: () => textResult('[]'),
    },
    timeoutMs,
    async execute() {
      return { entries: [] }
    },
  }))

  register('case_query', () => defineTool({
    name: 'case_query',
    description: 'Query historical cases (read-only).',
    parameters: {},
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { cases: { type: 'array', items: { type: 'json' } } } },
      render: () => textResult('[]'),
    },
    timeoutMs,
    async execute() {
      return { cases: [] }
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
        return { text: await readFile(resolve(deps.receiveInput), 'utf8') }
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
        const cp = await loadCheckpoint(join(deps.checkpointRoot, args.pipelineId!))
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
    parameters: { caseIds: { type: 'array', items: { type: 'string' }, description: 'case ids to run' } },
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
        const designPath = await findNewestDesignArtifact(deps.artifactsRoot)
        if (designPath === undefined) {
          return { error: `未找到 design 产物（${deps.artifactsRoot}/*/design.json）：design 阶段尚未完成。` }
        }
        const design = JSON.parse(await readFile(designPath, 'utf8')) as {
          testCases: Array<{ id: string; steps: Array<{ action?: string; expected?: string[] }> }>
        }
        const cases: HttpCase[] = design.testCases.map((tc) => {
          const first = tc.steps[0] ?? {}
          const match = /^(GET|POST|PUT|DELETE)\s+(\/\S+)/.exec(first.action ?? '')
          const expected = first.expected?.find((e) => /^\d{3}$/.test(e))
          const step: HttpStep = {
            kind: 'http-request', name: tc.id, method: match?.[1] ?? 'GET',
            url: baseUrl + (match?.[2] ?? '/api/login/sms'),
            ...(expected === undefined ? {} : { expectedStatus: Number(expected) }),
          }
          return { id: tc.id, steps: [step] }
        })
        const executor = new HttpExecutor({
          resolveCase: async (id) => cases.find((c) => c.id === id),
          writeEvidence: async (path, content) => {
            await mkdir(deps.evidenceDir, { recursive: true })
            await writeFile(join(deps.evidenceDir, path.split('/').pop() ?? 'x'), content)
          },
        })
        // 续接既有会话，而不是覆盖：executor_run 会被多次调用（分批执行），
        // 每次覆盖会让先前批次的记录消失，门禁对账 R4-08 随即判定它们「漏跑」。
        // 实测踩到：先跑 10 条、再单独跑 1 条 → 会话只剩最后 1 条 → 10 条 pass 被判无记录。
        const prior = await readSessionFile(deps.sessionPath)
        const last = prior?.records[prior.records.length - 1]
        const session = await executor.run(args.caseIds ?? cases.map((c) => c.id), {
          designArtifactPath: designPath,
          evidenceDir: deps.evidenceDir,
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
        await writeFile(deps.sessionPath, JSON.stringify(merged))
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