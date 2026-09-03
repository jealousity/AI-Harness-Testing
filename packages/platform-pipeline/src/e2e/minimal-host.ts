/**
 * 最小宿主（4b 端到端）：独立包内组装真实 harness 栈 + 真实 DeepSeek 外接模型，
 * 跑通 receive → analyze 最小闭环（真实 LLM 阶段 agent + 真实门禁 + 脚本人工门）。
 * 运行：DEEPSEEK_API_KEY 未设时从 ~/.dsh/.credentials.yaml 读取（桌面端已配置）。
 * @module platform-pipeline/e2e/minimal-host
 */

import { readFile, writeFile, mkdir, rm } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { homedir } from 'node:os'
import { join } from 'node:path'
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
import { FsArtifactStore, FsCheckpointPort } from '../stores/fs.ts'
import { MachineGateEngine, platformGenericRules } from '../gates/machine.ts'
import { stageRules } from '../gates/stage-rules.ts'
import { pipelineContractSchemas } from '../contracts/schemas.ts'
import { PipelineDriver, type HumanGatePort } from '../driver.ts'
import { HarnessStageSpawner } from '../harness/stage-spawner-harness.ts'
import { HarnessReviewRunner } from '../harness/review-runner-harness.ts'
import { applyToolTimeoutPolicy } from '../harness/tool-timeout.ts'
import { HttpExecutor, type HttpCase, type HttpStep } from '../executor/http.ts'

/** 工具调用超时上限：3 分钟（用户硬性要求：超时自动退出并汇报）。 */
const TOOL_TIMEOUT_MS = 180_000

/** LLM 提供者配置（自动切换：DeepSeek 余额不足时回退到千问）。 */
interface LlmTarget {
  readonly label: string
  readonly apiKeyEnv: string
  readonly baseURL: string
  readonly model: string
}

const DEEPSEEK_TARGET: LlmTarget = {
  label: 'DeepSeek 官方',
  apiKeyEnv: 'DEEPSEEK_API_KEY',
  baseURL: 'https://api.deepseek.com',
  model: 'deepseek-v4-flash',
}

const QWEN_TARGET: LlmTarget = {
  label: '千问 token-plan（自动切换）',
  apiKeyEnv: 'QWEN_TOKEN_PLAN_CN_API_KEY',
  baseURL: 'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1',
  model: 'qwen3.8-max',
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

/** 探测端点是否可用（发一个最小请求，30 s 超时）。 */
async function probeEndpoint(baseURL: string, apiKey: string): Promise<boolean> {
  try {
    const resp = await fetch(`${baseURL}/chat/completions`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'x', messages: [{ role: 'user', content: 'hi' }], max_tokens: 1 }),
      signal: AbortSignal.timeout(30_000),
    })
    if (resp.ok) return true
    // 检查是否为余额不足 / 认证错误（这些情况明确不可用）
    const text = await resp.text()
    if (text.includes('Insufficient Balance') || text.includes('invalid_api_key') || text.includes('invalid_request_error')) return false
    // 其他 HTTP 错误也视为不可用
    return false
  } catch {
    return false
  }
}

/** 选择 LLM 提供者：优先 DeepSeek，余额不足时自动切换到千问。 */
async function selectLlmProvider(): Promise<LlmTarget> {
  const deepseekOk = await loadKey(DEEPSEEK_TARGET.apiKeyEnv)
  const qwenOk = await loadKey(QWEN_TARGET.apiKeyEnv)

  if (!deepseekOk && !qwenOk) {
    throw new Error('既无 DEEPSEEK_API_KEY 也无 QWEN_TOKEN_PLAN_CN_API_KEY')
  }

  if (deepseekOk) {
    const usable = await probeEndpoint(DEEPSEEK_TARGET.baseURL, process.env[DEEPSEEK_TARGET.apiKeyEnv]!)
    if (usable) {
      console.log('[minimal-host] LLM: 使用 DeepSeek 官方（余额充足）')
      return DEEPSEEK_TARGET
    }
    console.log('[minimal-host] LLM: DeepSeek 余额不足，自动切换到千问')
  }

  if (qwenOk) {
    console.log(`[minimal-host] LLM: 使用${QWEN_TARGET.label}`)
    return QWEN_TARGET
  }

  throw new Error('DeepSeek 不可用且未找到千问密钥')
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

class ApprovingHuman implements HumanGatePort {
  readonly gates: string[] = []
  async gate(stageId: string): Promise<'approved'> {
    this.gates.push(stageId)
    console.log(`[minimal-host] 人工门 ${stageId}: 通过（脚本替身）`)
    return 'approved'
  }
  async gateFailed(): Promise<void> {}
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

async function main(): Promise<void> {
  const target = await selectLlmProvider()
  const { baseUrl } = await startFakeApi()
  const workdir = join(process.cwd(), '.e2e-workdir')
  await rm(workdir, { recursive: true, force: true })
  await mkdir(join(workdir, 'inputs'), { recursive: true })
  await writeFile(join(workdir, 'pipeline.yaml'), PIPELINE_YAML)
  await writeFile(join(workdir, 'inputs', 'requirements.txt'), INPUT_TEXT)

  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx, {
    systemPrompt: { persona: 'You are a careful testing engineer agent. Follow your instructions precisely.' },
  })
  await ctx.plugin(AgentLoop, { agents: [] })
  registerTools(ctx, workdir, baseUrl)
  applyToolTimeoutPolicy(ctx) // 工具调用 >3 分钟自动中止并汇报（用户硬性要求）
  // 千问需要禁用 thinking（避免发送 reasoning_effort），并覆盖模型目录
  const pluginConfig: Record<string, unknown> = { apiKeyEnv: target.apiKeyEnv, baseURL: target.baseURL }
  if (target === QWEN_TARGET) {
    pluginConfig.thinking = 'disabled'
    pluginConfig.models = [{ id: 'qwen3.8-max', name: 'Qwen3.8 Max', contextWindow: 1_000_000, maxTokens: 131_072 }]
  }
  await ctx.plugin(LlmDeepSeek, pluginConfig as never)
  await ctx.plugin(SubagentRuntime)
  await ctx.plugin(Spawn, { providerName: 'spawn' })

  const parent = ctx.agentLoop.create(SessionId('pipeline-parent'), {
    provider: 'deepseek-official',
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
        const text = result.output.map(b => 'text' in b ? String(b.text ?? '') : '').join('').slice(0, 600)
        console.log(`[minimal-host] --- child ${request.stageId} stop=${result.stopReason} diag=${result.diagnostic ?? ''}`)
        if (text) console.log(`[minimal-host] --- child output: ${JSON.stringify(text)}`)
      } finally {
        run.dispose()
      }
      return { stageId: request.stageId, artifactPath: request.artifactPath }
    },
  }
  const cfg = await loadPipelineConfig(join(workdir, 'pipeline.yaml'))
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
    human: new ApprovingHuman(),
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
