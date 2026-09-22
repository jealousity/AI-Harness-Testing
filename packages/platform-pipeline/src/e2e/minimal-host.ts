/**
 * 最小宿主（4b 端到端）：独立包内组装真实 Harness 栈和 OpenAI-compatible 模型，
 * 跑通 receive → analyze 最小闭环（真实 LLM 阶段 agent + 真实门禁 + 脚本人工门）。
 * 默认保留历史 DeepSeek/Qwen/SenseNova fallback；设置 E2E_PIPELINE_CONFIG 后优先读取
 * 外部 pipeline.yaml 的 llm.providers 配置。
 * @module platform-pipeline/e2e/minimal-host
 */

import { readFile, writeFile, mkdir, rm } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { Context } from '@deepseek-ai/cordis'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import * as LlmDeepSeek from '@deepseek-ai/dsh-llm-deepseek'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import * as Spawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import { SessionId } from '@deepseek-ai/dsh-session'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { loadPipelineConfig } from '../config.ts'
import { providerRegistry } from '../provider-registry.ts'
import type { PipelineConfig } from '../types.ts'
import { FsArtifactStore, FsCheckpointPort } from '../stores/fs.ts'
import { MachineGateEngine, platformGenericRules } from '../gates/machine.ts'
import { stageRules } from '../gates/stage-rules.ts'
import { pipelineContractSchemas } from '../contracts/schemas.ts'
import { PipelineDriver, type HumanGatePort } from '../driver.ts'
import { HarnessStageSpawner } from '../harness/stage-spawner-harness.ts'
import { HarnessReviewRunner } from '../harness/review-runner-harness.ts'
import { applyToolTimeoutPolicy } from '../harness/tool-timeout.ts'
import { TerminalHumanGate } from '../human-gate-terminal.ts'
import UserQuestionService from '@deepseek-ai/dsh-user-questions'
import { HttpExecutor, type HttpCase, type HttpStep } from '../executor/http.ts'

/** 工具调用超时上限：3 分钟（用户硬性要求：超时自动退出并汇报）。 */
const TOOL_TIMEOUT_MS = 180_000

/** LLM 提供者配置（自动切换：DeepSeek 余额不足时回退到千问）。 */
interface LlmTarget {
  readonly label: string
  readonly apiKeyEnv: string
  readonly baseURL: string
  readonly model: string
  /** Harness 的 dsh-llm-deepseek 适配器固定注册此 route；配置 provider 名保留在 label。 */
  readonly harnessRoute: 'deepseek-official'
  readonly configuredProvider?: string
}

const DEEPSEEK_TARGET: LlmTarget = {
  label: 'DeepSeek 官方',
  apiKeyEnv: 'DEEPSEEK_API_KEY',
  baseURL: 'https://api.deepseek.com',
  model: 'deepseek-v4-flash',
  harnessRoute: 'deepseek-official',
}

const QWEN_TARGET: LlmTarget = {
  label: '千问 token-plan（自动切换）',
  apiKeyEnv: 'QWEN_TOKEN_PLAN_CN_API_KEY',
  baseURL: 'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1',
  model: 'qwen3.8-max',
  harnessRoute: 'deepseek-official',
}

/** SenseNova 统一 token 网关（OpenAI 兼容）：实测 glm-5.2 可用且返回标准 tool_calls（deepseek-v4-flash 在该网关上不产 tool_calls，不可用于工具调用阶段）。
 * 在 DeepSeek 官方余额耗尽、千问配额耗尽时作为最后可用 LLM。 */
const SENSENOVA_TARGET: LlmTarget = {
  label: 'SenseNova token 网关',
  apiKeyEnv: 'SENSENOVA_TOKEN_KEY',
  baseURL: 'https://token.sensenova.cn/v1',
  model: 'glm-5.2',
  harnessRoute: 'deepseek-official',
}

/** 从凭据库加载指定 key 到 env；返回是否成功。 */
async function loadKey(envName: string): Promise<boolean> {
  if (process.env[envName] !== undefined && process.env[envName] !== '') return true
  try {
    const raw = await readFile(join(homedir(), '.dsh', '.credentials.yaml'), 'utf8')
    const match = new RegExp(`${envName}:\\s*"?([^"\\n]+)"?`).exec(raw)
    if (match?.[1] !== undefined) {
      process.env[envName] = match[1].trim()
      console.log(`[minimal-host] ${envName} loaded from ~/.dsh/.credentials.yaml`)
      return true
    }
  } catch { /* ignore */ }
  return false
}

/** 探测端点是否可用（发一个最小请求，30 s 超时；model 必须存在，否则部分网关对 404 直接判不可用）。 */
async function probeEndpoint(baseURL: string, apiKey: string, model: string): Promise<boolean> {
  try {
    const resp = await fetch(`${baseURL}/chat/completions`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: 'hi' }], max_tokens: 1 }),
      signal: AbortSignal.timeout(30_000),
    })
    if (resp.ok) return true
    // 明确不可用：余额/配额不足、认证失败
    const text = await resp.text()
    const exhausted = 'insufficient_balance|insufficient quota|insufficient_quota|quota has been exhausted|invalid_api_key|invalid_request_error'
    if (new RegExp(exhausted, 'i').test(text)) return false
    // 其他 HTTP 错误也视为不可用
    return false
  } catch {
    return false
  }
}

/**
 * 选择 LLM provider：优先使用 pipeline.yaml 的 llm.providers；没有配置时
 * 保留历史 e2e 的三段 fallback，方便验证旧配置和桌面凭据。
 */
async function selectLlmProvider(config?: PipelineConfig): Promise<LlmTarget> {
  if (config?.llm !== undefined) {
    const registry = providerRegistry(config.llm, process.env)
    const failures: string[] = []
    for (const name of [config.llm.defaultProvider, ...registry.names().filter(value => value !== config.llm!.defaultProvider)]) {
      try {
        const provider = registry.resolve(name, { tools: true })
        const target: LlmTarget = {
          label: `配置 provider ${name}`,
          apiKeyEnv: provider.apiKeyEnv,
          baseURL: provider.baseUrl,
          model: provider.model,
          harnessRoute: 'deepseek-official',
          configuredProvider: name,
        }
        if (await probeEndpoint(target.baseURL, provider.apiKey, target.model)) {
          console.log(`[minimal-host] LLM: 使用 pipeline.yaml provider=${name} model=${target.model}`)
          return target
        }
        failures.push(`${name}: endpoint probe failed`)
      } catch (error) {
        failures.push(`${name}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    throw new Error(`pipeline.yaml 中没有可用的 LLM provider：${failures.join('; ')}`)
  }

  const deepseekOk = await loadKey(DEEPSEEK_TARGET.apiKeyEnv)
  const qwenOk = await loadKey(QWEN_TARGET.apiKeyEnv)
  const senseOk = await loadKey(SENSENOVA_TARGET.apiKeyEnv)

  if (!deepseekOk && !qwenOk && !senseOk) {
    throw new Error('未配置 pipeline.yaml llm.providers，且没有 DEEPSEEK_API_KEY、QWEN_TOKEN_PLAN_CN_API_KEY 或 SENSENOVA_TOKEN_KEY')
  }

  if (deepseekOk) {
    const usable = await probeEndpoint(DEEPSEEK_TARGET.baseURL, process.env[DEEPSEEK_TARGET.apiKeyEnv]!, DEEPSEEK_TARGET.model)
    if (usable) {
      console.log('[minimal-host] LLM: 使用历史 DeepSeek fallback')
      return DEEPSEEK_TARGET
    }
  }

  if (qwenOk) {
    const qwenUsable = await probeEndpoint(QWEN_TARGET.baseURL, process.env[QWEN_TARGET.apiKeyEnv]!, QWEN_TARGET.model)
    if (qwenUsable) {
      console.log(`[minimal-host] LLM: 使用历史 ${QWEN_TARGET.label}`)
      return QWEN_TARGET
    }
  }

  if (senseOk) {
    const senseUsable = await probeEndpoint(SENSENOVA_TARGET.baseURL, process.env[SENSENOVA_TARGET.apiKeyEnv]!, SENSENOVA_TARGET.model)
    if (senseUsable) {
      console.log(`[minimal-host] LLM: 使用历史 ${SENSENOVA_TARGET.label}`)
      return SENSENOVA_TARGET
    }
  }

  throw new Error('所有 LLM 端点均不可用；请检查 pipeline.yaml llm.providers 或历史 fallback 凭据')
}

function textResult(text: string): ContentBlock[] {
  return [{ type: 'text', text }]
}

/** 注册最小工具集（ACL allow 名单全覆盖；fs 相对路径按 baseDir 解析）。 */
function registerTools(ctx: Context, baseDir: string, baseUrl: string): void {
  const resolve = (path: string): string => (path.startsWith('/') ? path : join(baseDir, path))

  ctx.tools.register(defineTool({
    name: 'fs_read',
    description: 'Read a file (absolute or workspace-relative path). Returns its text content.',
    parameters: { path: { type: 'string', required: true, description: 'file path' } },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { text: { type: 'string' } } },
      render: (_args, value) => textResult(value.text ?? ''),
    },
    timeoutMs: TOOL_TIMEOUT_MS,
    async execute(args) {
      const text = await readFile(resolve(args.path!), 'utf8')
      return { text }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'fs_write',
    description: 'Write a file (absolute or workspace-relative path). Returns the path.',
    parameters: {
      path: { type: 'string', required: true, description: 'file path' },
      content: { type: 'string', required: true, description: 'file content' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { path: { type: 'string' } } },
      render: (_args, value) => [{ type: 'text', text: `written ${value.path}` }],
    },
    timeoutMs: TOOL_TIMEOUT_MS,
    async execute(args) {
      const target = resolve(args.path)
      await mkdir(target.slice(0, target.lastIndexOf('/')), { recursive: true })
      await writeFile(target, args.content)
      return { path: args.path }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'parse_doc',
    description: 'Parse a document file (text/markdown; ppt/word not supported in minimal host) and return its text.',
    parameters: { path: { type: 'string', required: true, description: 'document path' } },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { text: { type: 'string' } } },
      render: (_args, value) => textResult(value.text ?? ''),
    },
    timeoutMs: TOOL_TIMEOUT_MS,
    async execute(args) {
      return { text: await readFile(resolve(args.path!), 'utf8') }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'kb_query',
    description: 'Query the knowledge base (read-only). Minimal host returns empty.',
    parameters: { entities: { type: 'array', items: { type: 'string' }, description: 'query entities' } },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { entries: { type: 'array', items: { type: 'json' } } } },
      render: () => textResult('[]'),
    },
    timeoutMs: TOOL_TIMEOUT_MS,
    async execute() {
      return { entries: [] }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'case_query',
    description: 'Query historical cases (read-only). Minimal host returns empty.',
    parameters: {},
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { cases: { type: 'array', items: { type: 'json' } } } },
      render: () => textResult('[]'),
    },
    timeoutMs: TOOL_TIMEOUT_MS,
    async execute() {
      return { cases: [] }
    },
  }))

  // executor_run：真实 HttpExecutor（本地假登录 API；记录+证据落盘，供执行可信门禁验证）
  const executorState: { session?: import('../executor/executor.ts').ExecutionSession } = {}
  ctx.tools.register(defineTool({
    name: 'executor_run',
    description: 'Execute the given case ids against the login API and return their real records. Call this with the case ids from design.json.',
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
    timeoutMs: TOOL_TIMEOUT_MS,
    async execute(args) {
      try {
        const design = JSON.parse(await readFile(join(baseDir, 'artifacts', 'e2e-2026', 'design.json'), 'utf8')) as {
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
            const dirPath = join(baseDir, 'executor', 'evidence')
            await mkdir(dirPath, { recursive: true })
            await writeFile(join(dirPath, path.split('/').pop() ?? 'x'), content)
          },
        })
        const session = await executor.run(args.caseIds ?? cases.map((c) => c.id), {
          designArtifactPath: join(baseDir, 'artifacts', 'e2e-2026', 'design.json'),
          evidenceDir: join(baseDir, 'executor', 'evidence'),
          invocationId: `inv-${Date.now()}`,
        })
        executorState.session = session
        await writeFile(join(baseDir, 'executor', 'session.json'), JSON.stringify(session))
        // 只给 agent 记录摘要（caseId/status/evidenceRefs/真实时长），不暴露实现细节
        return { records: session.records.map((r) => ({ seq: r.seq, caseId: r.caseId, status: r.status, evidenceRefs: r.evidenceRefs, durationMs: r.durationMs })) } as never
      } catch (error) {
        return { error: error instanceof Error ? error.message : String(error) }
      }
    },
  }))
  void executorState

  // DENY 名单中的工具也需存在（restrict() 校验所有 filter 名）：无操作 stub
  for (const name of ['kb_write', 'case_archive', 'subagent']) {
    ctx.tools.register(defineTool({
      name,
      description: `${name} — not available in minimal host.`,
      parameters: {},
      output: {
        schema: { type: 'object', additionalProperties: false, properties: { error: { type: 'string' } } },
        render: (_args, value) => textResult(value.error ?? ''),
      },
      timeoutMs: TOOL_TIMEOUT_MS,
      async execute() {
        return { error: `${name} not available in minimal host` }
      },
    }))
  }

  ctx.tools.register(defineTool({
    name: 'env_diag',
    description: 'Environment diagnostic probes. Minimal host returns empty.',
    parameters: {},
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { probes: { type: 'array', items: { type: 'json' } } } },
      render: () => textResult('[]'),
    },
    timeoutMs: TOOL_TIMEOUT_MS,
    async execute() {
      return { probes: [] }
    },
  }))
}

/**
 * 人工门接线（真实现，无脚本跳过）：
 * - 默认：真终端人工门 TerminalHumanGate —— 必须真人在 TTY 上当面裁决；
 *   无 TTY（无人值守）时抛 NO_HUMAN_AT_CONSOLE，流水线**响亮失败**而非假批准。
 * - E2E_HUMAN_ANSWERS="1,1,2 理由,1,1,1"：无人值守回归用，把预置输入喂给
 *   **同一个真实现**（仍走校验/必填理由/审计记录），不注入任何伪造裁决的 provider。
 */
function makeHumanGate(parentSessionId: string): HumanGatePort {
  const onDecision = (record: { stageId: string; action: string; note: string }): void => {
    console.log(`[minimal-host] 人工门 ${record.stageId} 裁决记录：${record.action}${record.note ? `（${record.note}）` : ''}`)
  }

  const scripted = process.env.E2E_HUMAN_ANSWERS
  if (scripted !== undefined && scripted !== '') {
    const lines = scripted.split(',').map(s => s.trim())
    console.warn(`[minimal-host] ⚠ 人工门输入来自 E2E_HUMAN_ANSWERS（${lines.length} 条）——非真实人工，仅供无人值守回归`)
    return new TerminalHumanGate({
      input: Readable.from(lines.map(l => `${l}\n`)),
      output: process.stdout,
      allowNonTty: true,
      by: 'e2e-scripted-input',
      onDecision,
    })
  }

  console.log('[minimal-host] 人工门 = 真终端问答：需要真人在场，逐门当面裁决（无默认值、无自动批准）')
  return new TerminalHumanGate({ by: parentSessionId, onDecision })
}

const PIPELINE_YAML = `
projectId: e2e-2026
projectType: api-service
templateVersion: v1
scaleTier: S
releasePolicy: { maxManualClaimedRatio: 0.3 }
stores:
  knowledge: { impl: markdown-fs, path: kb }
  cases: { impl: markdown-fs, path: cases }
  requirements: { primary: { impl: paste } }
stages: {}
`

const INPUT_TEXT = `需求：登录功能改造
目标：支持手机号+验证码登录
变更点：新增验证码登录接口 POST /api/login/sms；原有密码登录保留
验收标准：1) 手机号+验证码可登录成功；2) 验证码错误返回 400；3) 密码登录不受影响
优先级：P0
来源：jira:PAY-100`

/** 本地假登录 API：/api/login/sms（成功 200；验证码错 400）、/api/login（密码登录 200）。 */
function startFakeApi(): Promise<{ server: Server; baseUrl: string }> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      const url = req.url ?? ''
      if (url.startsWith('/api/login/sms')) {
        const raw: string[] = []
        req.on('data', (chunk) => raw.push(String(chunk)))
        req.on('end', () => {
          let code = 'wrong'
          try { code = String(JSON.parse(raw.join('') || '{}').code ?? 'wrong') } catch { /* ignore */ }
          if (code === '123456') {
            res.writeHead(200, { 'content-type': 'application/json' })
            res.end(JSON.stringify({ token: 'sms-token-1', ok: true }))
          } else {
            res.writeHead(400, { 'content-type': 'application/json' })
            res.end(JSON.stringify({ error: 'invalid code' }))
          }
        })
        return
      }
      if (url.startsWith('/api/login')) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ token: 'pwd-token-1', ok: true }))
        return
      }
      res.writeHead(404)
      res.end('not found')
    })
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (address === null || typeof address === 'string') throw new Error('no port')
      resolve({ server, baseUrl: `http://127.0.0.1:${address.port}` })
    })
  })
}

/** 交叉检查故障注入：E2E_FAULT_REVIEW_FAIL=<stage>[:次数]（默认 1 次）。前 N 次判 fail 模拟审核发现问题。 */
function makeReviewWithFaultInjection(ctx: Context, parent: import('@deepseek-ai/dsh-agent').Agent): import('../driver.ts').ReviewRunner {
  const real = new HarnessReviewRunner({
    subagents: ctx.subagents,
    parent,
    signal: new AbortController().signal,
    toolFilter: { allow: ['fs_read'] }, // 盲审只读
    // execute 审核需要看见 executor 自产数据（记录+证据清单），否则"结果↔记录↔证据一致性"必查面无法复核
    extraPaths: (stageId): Record<string, string> => (stageId === 'execute'
      ? { 'executor 执行会话（records+evidence 清单）': 'executor/session.json' }
      : {}),
  })
  const spec = process.env.E2E_FAULT_REVIEW_FAIL ?? ''
  if (spec === '') return real
  const [faultStage, countRaw] = spec.split(':')
  const faultCount = countRaw === undefined ? 1 : Number(countRaw)
  let injected = 0
  return {
    async run(stageId, artifact, gate) {
      if (stageId === faultStage && injected < faultCount) {
        injected += 1
        const finding = `【注入故障 ${injected}/${faultCount}】覆盖完整性存疑：请逐条核对上游 analyze.json 的验收标准与变更点，确认每条都有 ≥1 条用例覆盖；未覆盖的必须写入 gaps 并说明原因。同时复核用例 steps/expected 是否可执行（非空话）。`
        console.log(`[minimal-host] 故障注入：审核 ${stageId} 判 fail（${injected}/${faultCount}）`)
        return { verdict: 'fail' as const, findings: [finding] }
      }
      return real.run(stageId, artifact, gate)
    },
  }
}

/**
 * 诊断：拦截出站 fetch，记录发往 LLM 网关的请求关键字段与错误响应体。
 * 仅在 E2E_LLM_TRACE=1 时安装。只在非 2xx 时读响应体，避免干扰 SSE 流。
 */
function installLlmTrace(): void {
  if (process.env.E2E_LLM_TRACE !== '1') return
  const gateway = process.env.E2E_LLM_TRACE_HOST ?? 'token.sensenova.cn'
  const realFetch = globalThis.fetch
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : (input as { url?: string })?.url ?? String(input)
    if (!url.includes(gateway)) return realFetch(input as RequestInfo, init)

    let summary = ''
    try {
      const b = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : null
      if (b) {
        const tools = Array.isArray(b.tools) ? (b.tools as unknown[]).length : 0
        summary = ` model=${String(b.model)} stream=${String(b.stream)} max_tokens=${String(b.max_tokens)}`
          + ` temp=${String(b.temperature)} tools=${tools}`
          + ` thinking=${JSON.stringify(b.thinking ?? null)} reasoning_effort=${JSON.stringify(b.reasoning_effort ?? null)}`
          + ` msgs=${Array.isArray(b.messages) ? (b.messages as unknown[]).length : 0}`
          + ` bodyKeys=${Object.keys(b).join(',')}`
      }
    } catch { summary = ' <unparsable body>' }

    const t0 = Date.now()
    try {
      const r = await realFetch(input as RequestInfo, init)
      const ms = Date.now() - t0
      if (!r.ok) {
        const txt = await r.clone().text().catch(() => '')
        console.log(`[llm-trace] ${r.status} ${ms}ms${summary}\n[llm-trace]     err → ${txt.slice(0, 500)}`)
      } else {
        console.log(`[llm-trace] ${r.status} ${ms}ms${summary}`)
      }
      return r
    } catch (err) {
      console.log(`[llm-trace] THREW ${Date.now() - t0}ms${summary} → ${(err as Error).name}: ${(err as Error).message}`)
      throw err
    }
  }) as typeof fetch
  console.log(`[llm-trace] 已安装 fetch 拦截（网关 ${gateway}）`)
}

async function main(): Promise<void> {
  installLlmTrace()
  const { baseUrl } = await startFakeApi()
  const workdir = join(process.cwd(), '.e2e-workdir')
  await rm(workdir, { recursive: true, force: true })
  await mkdir(join(workdir, 'inputs'), { recursive: true })
  const configuredPipelinePath = process.env.E2E_PIPELINE_CONFIG
  const pipelinePath = configuredPipelinePath ?? join(workdir, 'pipeline.yaml')
  if (configuredPipelinePath === undefined) await writeFile(pipelinePath, PIPELINE_YAML)
  const cfg = await loadPipelineConfig(pipelinePath)
  const target = await selectLlmProvider(cfg)
  await writeFile(join(workdir, 'inputs', 'requirements.txt'), INPUT_TEXT)

  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx, {
    systemPrompt: { persona: 'You are a careful testing engineer agent. Follow your instructions precisely.' },
  })
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(UserQuestionService) // ctx.userQuestions：人工门 UI 审核（I-2）
  registerTools(ctx, workdir, baseUrl)
  applyToolTimeoutPolicy(ctx) // 工具调用 >3 分钟自动中止并汇报（用户硬性要求）
  // 千问需要禁用 thinking（避免发送 reasoning_effort），并覆盖模型目录
  const pluginConfig: Record<string, unknown> = { apiKeyEnv: target.apiKeyEnv, baseURL: target.baseURL }
  if (target === QWEN_TARGET) {
    pluginConfig.thinking = 'disabled'
    pluginConfig.models = [{ id: 'qwen3.8-max', name: 'Qwen3.8 Max', contextWindow: 1_000_000, maxTokens: 131_072 }]
  } else if (target === SENSENOVA_TARGET) {
    // SenseNova 网关：glm-5.2 非流式能正常返回 tool_calls；纯推理会全塞 reasoning_content。
    // TODO（明晚续）：流式链路直测显示 agent-loop 的 stream 只收到 reasoning block → 子 agent 判零内容 error；
    // 需确认加 tool 后 stream 是否产出 tool_calls，或改用 reasoning_effort=none。
    pluginConfig.models = [{ id: 'glm-5.2', name: 'GLM-5.2', contextWindow: 1_048_576, maxTokens: 65_536 }]
  } else if (target.configuredProvider !== undefined) {
    pluginConfig.models = [{ id: target.model, name: target.model, contextWindow: 128_000, maxTokens: 16_384 }]
  }
  await ctx.plugin(LlmDeepSeek, pluginConfig as never)
  await ctx.plugin(SubagentRuntime)
  await ctx.plugin(Spawn, { providerName: 'spawn' })

  const parent = ctx.agentLoop.create(SessionId('pipeline-parent'), {
    provider: target.harnessRoute,
    model: target.model,
  })
  console.log('[minimal-host] parent agent created:', parent.id)

  // 内联 spawn（带子 agent 终态日志），替代 HarnessStageSpawner 以便调试
  const spawner: import('../stage-spawner.ts').StageSpawner = {
    async runStage(request, cfg) {
      const { assemblePrompt } = await import('../prompt/assemble.ts')
      const { resolveStageAcl, stageRunContext } = await import('../stage-spawner.ts')
      const resolved = resolveStageAcl(request.stageId, cfg)
      if (!resolved.ok) throw new Error(`ACL invalid: ${resolved.errors.join('; ')}`)
      const prompt = assemblePrompt({
        stageId: request.stageId,
        pipelineId: request.pipelineId,
        inputPaths: request.inputPaths,
        inputDigests: request.inputDigests,
        artifactPath: request.artifactPath,
        budget: cfg.stages[request.stageId]!.budget,
        toolAcl: resolved.acl,
        schemaFilePath: `schemas/${request.stageId}.schema.json`,
        ...(request.extraContext === undefined ? {} : { extraContext: request.extraContext }),
      })
      console.log(`[minimal-host] === spawn ${request.stageId} ===`)
      const run = await ctx.subagents.start('spawn', {
        label: request.stageId,
        prompt: [{ type: 'text', text: prompt }],
        parent,
        signal: new AbortController().signal,
        toolFilter: resolved.acl,
      })
      try {
        const result = await run.result
        const text = result.output.map(b => 'text' in b ? String(b.text ?? '') : '').join('')
        console.log(`[minimal-host] --- child ${request.stageId} stop=${result.stopReason} diag=${result.diagnostic ?? ''}`)
        console.log(`[minimal-host] --- child result keys: ${Object.keys(result).join(',')}`)
        console.log(`[minimal-host] --- child full result: ${JSON.stringify({ ...result, output: result.output.map((b: unknown) => b), }, null, 0).slice(0, 2500)}`)
        console.log(`[minimal-host] --- child output (${text.length} chars): ${JSON.stringify(text.slice(0, 2500))}`)
      } finally {
        run.dispose()
      }
      return { stageId: request.stageId, artifactPath: request.artifactPath }
    },
  }
  const driver = new PipelineDriver({
    cfg,
    pipelineId: 'e2e-2026',
    root: join(workdir, 'checkpoints'),
    rulesetVersion: 'e2e-v1',
    spawn: spawner,
    gates: new MachineGateEngine(
      [...platformGenericRules(pipelineContractSchemas()), ...stageRules({ maxManualClaimedRatio: 0.3 })],
      'e2e-v1',
    ),
    human: makeHumanGate(parent.id),
    artifacts: new FsArtifactStore(workdir), // 基址 = agent CWD，artifactPath 相对路径直接解析
    checkpoint: new FsCheckpointPort(),
    // 交叉检查（docs/03 第 7 节）：独立审核 agent 盲审；cfg 开启的阶段（analyze/design/execute/report）生效。
    // 故障注入（里程碑 7 验收）：E2E_FAULT_REVIEW_FAIL=<stage>[:次数] —— 前 N 次该阶段审核判 fail
    // （模拟审核发现问题），之后交给真实审核器，验证 findings 回喂重跑闭环。
    review: makeReviewWithFaultInjection(ctx, parent),
    receiveInput: join(workdir, 'inputs', 'requirements.txt'),
    // execute 门禁 R4-08/09/10：读取 executor 真实执行会话
    execution: {
      load: async (stageId) => {
        if (stageId !== 'execute') return undefined
        try {
          const raw = await readFile(join(workdir, 'executor', 'session.json'), 'utf8')
          return JSON.parse(raw) as { records: never[]; evidence: never[] }
        } catch {
          return undefined
        }
      },
    },
  })

  // 隔离探针：spawn 一个极简子 agent（无工具、仅回复），区分 LLM 流式链路 vs 工具/pipeline 层
  console.log('[minimal-host] === 探针：极简子 agent（无工具）===')
  {
    try {
      const probe = await ctx.subagents.start('spawn', {
        label: 'probe-trivial',
        prompt: [{ type: 'text', text: 'Just reply with the word OK and nothing else.' }],
        parent,
        signal: new AbortController().signal,
      })
      const pr = await probe.result
      console.log(`[minimal-host] probe-trivial stop=${pr.stopReason} outputLen=${pr.output.length}`)
      probe.dispose()
    } catch (err) {
      console.log(`[minimal-host] probe-trivial THREW: ${(err as Error).name}: ${(err as Error).message}`)
      console.log(`[minimal-host] probe-trivial stack: ${((err as Error).stack ?? '').slice(0, 1400)}`)
    }
    // agent-loop 只走 stream()：用同一路径直接测，拿到真实错误
    console.log('[minimal-host] === 探针：ctx.llm.stream 直测（agent-loop 同路径）===')
    {
      const llm = ctx.llm
      const models = await llm.listModels(target.harnessRoute)
      console.log(`[minimal-host] 注册模型：${models.map((m: unknown) => JSON.stringify(m).slice(0, 120)).join(' | ')}`)
      try {
        // 诊断探针：Message 需要 branded id + source（由 agent-loop 正常构造），
        // 这里只为直测 stream 通路，按目标参数类型精确断言。
        const probeMessages = [{ role: 'user', content: [{ type: 'text', text: 'Say OK in one word.' }] }] as unknown as
          Parameters<typeof llm.stream>[0]['messages']
        const stream = llm.stream({
          provider: target.harnessRoute,
          model: target.model,
          system: 'Be terse.',
          messages: probeMessages,
          maxTokens: 2000,
          signal: new AbortController().signal,
        })
        let n = 0
        const kinds: string[] = []
        let tail = ''
        for await (const chunk of stream) {
          n += 1
          const k = (chunk as { type?: string }).type ?? '?'
          if (!kinds.includes(k)) kinds.push(k)
          tail = JSON.stringify(chunk).slice(0, 300)
        }
        console.log(`[minimal-host] stream OK chunks=${n} chunkTypes=[${kinds.join(',')}]`)
        console.log(`[minimal-host] stream 末段: ${tail}`)
      } catch (err) {
        const e = err as Error & { code?: string, response?: unknown, cause?: unknown }
        console.log(`[minimal-host] stream THREW ${e.name} code=${e.code} msg=${e.message}`)
        console.log(`[minimal-host] stream stack: ${(e.stack ?? '').slice(0, 1600)}`)
        if (e.response) console.log(`[minimal-host] stream response: ${JSON.stringify(e.response).slice(0, 600)}`)
        if (e.cause) console.log(`[minimal-host] stream cause: ${JSON.stringify(e.cause).slice(0, 600)}`)
      }
    }
  }

  console.log('[minimal-host] driver run start...')
  const outcome = await driver.run()
  console.log('[minimal-host] outcome:', JSON.stringify(outcome))

  // 重入场景（E2E_REENTRY=1）：需求变更 → 重入 receive → 级联重跑全下游
  if (process.env.E2E_REENTRY === '1' && outcome.outcome === 'completed') {
    console.log('[minimal-host] === 重入场景：需求变更，重入 receive ===')
    const inputPath = join(workdir, 'inputs', 'requirements.txt')
    await writeFile(inputPath, `${INPUT_TEXT}
补充变更点：验证码发送频率限制——同一手机号 60 秒内仅可发送 1 次，超限返回 429
补充验收标准：4) 60 秒内重复发送验证码返回 429`)
    const cpAfterReenter = await driver.reenter('receive', 'e2e-tester', '需求变更：新增验证码频率限制')
    console.log('[minimal-host] reenter done; analyze.inputs 已解锁:', JSON.stringify(cpAfterReenter.stageStates.analyze.inputs))
    const reentryOutcome = await driver.run()
    console.log('[minimal-host] reentry outcome:', JSON.stringify(reentryOutcome))
    if (reentryOutcome.outcome !== 'completed') {
      throw new Error(`重入级联重跑未完成: ${JSON.stringify(reentryOutcome)}`)
    }
    // 验证：重入记录 + 全部下游重跑 + history 归档
    const cpFinal = await new FsCheckpointPort().load(join(workdir, 'checkpoints'))
    if (cpFinal === null) throw new Error('重入后检查点丢失')
    console.log('[minimal-host] reentries:', JSON.stringify(cpFinal.reentries.map(r => ({ stageId: r.stageId, by: r.by, reason: r.reason }))))
    for (const stage of ['receive', 'analyze', 'design', 'execute', 'report', 'archive'] as const) {
      const st = cpFinal.stageStates[stage]
      console.log(`[minimal-host] ${stage}: status=${st.status} history=${st.history.length} inputs=${JSON.stringify(st.inputs).slice(0, 80)}`)
    }
  }

  for (const stage of ['receive', 'analyze', 'design']) {
    try {
      const artifact = await readFile(join(workdir, 'artifacts', 'e2e-2026', `${stage}.json`), 'utf8')
      console.log(`[minimal-host] ${stage}.json 存在（${artifact.length} bytes）`)
    } catch {
      console.log(`[minimal-host] ${stage}.json 未生成`)
    }
  }
  await (ctx as unknown as { fiber?: { dispose(): Promise<void> } }).fiber?.dispose()
}

main().then(
  () => { process.exit(0) },
  (error) => {
    console.error('[minimal-host] FAILED:', error instanceof Error ? error.message : error)
    process.exit(1)
  },
)
