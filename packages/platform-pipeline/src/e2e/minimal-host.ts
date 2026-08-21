/**
 * 最小宿主（4b 端到端）：独立包内组装真实 harness 栈 + 真实 DeepSeek 外接模型，
 * 跑通 receive → analyze 最小闭环（真实 LLM 阶段 agent + 真实门禁 + 脚本人工门）。
 * 运行：DEEPSEEK_API_KEY 未设时从 ~/.dsh/.credentials.yaml 读取（桌面端已配置）。
 * @module platform-pipeline/e2e/minimal-host
 */

import { readFile, writeFile, mkdir, rm } from 'node:fs/promises'
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

/** 从桌面端凭据库读取 DEEPSEEK_API_KEY（不打印值）。 */
async function ensureApiKey(): Promise<void> {
  if (process.env.DEEPSEEK_API_KEY !== undefined && process.env.DEEPSEEK_API_KEY !== '') return
  try {
    const raw = await readFile(join(homedir(), '.dsh', '.credentials.yaml'), 'utf8')
    const match = /DEEPSEEK_API_KEY:\s*"?([^"\n]+)"?/.exec(raw)
    if (match?.[1] !== undefined) {
      process.env.DEEPSEEK_API_KEY = match[1].trim()
      console.log('[minimal-host] DEEPSEEK_API_KEY loaded from ~/.dsh/.credentials.yaml')
    }
  } catch {
    throw new Error('DEEPSEEK_API_KEY 未设置且无法从 ~/.dsh/.credentials.yaml 读取')
  }
}

function textResult(text: string): ContentBlock[] {
  return [{ type: 'text', text }]
}

/** 注册最小工具集（ACL allow 名单全覆盖；fs 相对路径按 baseDir 解析）。 */
function registerTools(ctx: Context, baseDir: string): void {
  const resolve = (path: string): string => (path.startsWith('/') ? path : join(baseDir, path))

  ctx.tools.register(defineTool({
    name: 'fs_read',
    description: 'Read a file (absolute or workspace-relative path). Returns its text content.',
    parameters: { path: { type: 'string', required: true, description: 'file path' } },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { text: { type: 'string' } } },
      render: (_args, value) => textResult(value.text ?? ''),
    },
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
    async execute() {
      return { cases: [] }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'executor_run',
    description: 'Run test cases via the executor. Not wired in minimal host.',
    parameters: { caseIds: { type: 'array', items: { type: 'string' }, description: 'case ids' } },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { error: { type: 'string' } } },
      render: (_args, value) => textResult(value.error ?? ''),
    },
    async execute() {
      return { error: 'executor not wired in minimal host' }
    },
  }))

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

async function main(): Promise<void> {
  await ensureApiKey()
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
  registerTools(ctx, workdir)
  await ctx.plugin(LlmDeepSeek, { apiKeyEnv: 'DEEPSEEK_API_KEY', baseURL: 'https://api.deepseek.com' })
  await ctx.plugin(SubagentRuntime)
  await ctx.plugin(Spawn, { providerName: 'spawn' })

  const parent = ctx.agentLoop.create(SessionId('pipeline-parent'), {
    provider: 'deepseek-official',
    model: 'deepseek-v4-flash',
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
    receiveInput: join(workdir, 'inputs', 'requirements.txt'),
  })

  console.log('[minimal-host] driver run start...')
  const outcome = await driver.run()
  console.log('[minimal-host] outcome:', JSON.stringify(outcome))

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
