import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { PLATFORM_ACL, TOOL_CATALOG } from '../src/tool-catalog.ts'
import { registerStageTools } from '../src/harness/stage-tools.ts'

async function mount(): Promise<Context> {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  return ctx
}

function textResult(text: string): { type: 'text'; text: string }[] {
  return [{ type: 'text', text }]
}

/** 真实宿主已有的同名真工具（此处用 stub 代替），用于验证宿主插件不与之撞名。 */
function subagentStub() {
  return defineTool({
    name: 'subagent',
    description: 'real host subagent tool',
    parameters: {},
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean' } } },
      render: (_a, v) => textResult(JSON.stringify(v)),
    },
    async execute() {
      return { ok: true }
    },
  })
}

async function deps() {
  const base = await mkdtemp(join(tmpdir(), 'stage-tools-'))
  const artifactsRoot = join(base, 'artifacts')
  await mkdir(artifactsRoot, { recursive: true })
  return {
    baseDir: base,
    artifactsRoot,
    evidenceDir: join(base, 'executor', 'evidence'),
    sessionPath: join(base, 'executor', 'session.json'),
  }
}

/**
 * 回归：阶段 ACL 用的是**设计文档定义的抽象工具名**，tools.restrict() 会校验
 * 所有 filter 名必须存在。宿主插件若不注册它们，阶段子会话直接起不来：
 *   tools.restrict() names unknown global tools "parse_doc", "fs_read", ...
 * 这条测试把「ACL 引用的每个名字都必须在注册后存在」钉住。
 */
test('registerStageTools 注册 ACL 引用的全部工具名（否则 restrict() 直接报未知工具）', async () => {
  const ctx = await mount()
  ctx.tools.register(subagentStub()) // 模拟真实宿主已提供的 subagent

  registerStageTools(ctx, await deps())

  const missing: string[] = []
  for (const [stage, filter] of Object.entries(PLATFORM_ACL)) {
    for (const name of [...(filter.allow ?? []), ...(filter.deny ?? [])]) {
      if (ctx.tools.get(name) === undefined) missing.push(`${stage}:${name}`)
    }
  }
  assert.deepEqual(missing, [], `以下 ACL 工具名在宿主中不存在，restrict() 会失败：${missing.join(', ')}`)
})

test('registerStageTools 覆盖抽象工具目录中宿主应提供的每一项', async () => {
  const ctx = await mount()
  ctx.tools.register(subagentStub())
  registerStageTools(ctx, await deps())

  // subagent 由真实宿主提供，不在本模块职责内
  const expected = TOOL_CATALOG.map(t => t.id).filter(id => id !== 'subagent')
  const missing = expected.filter(id => ctx.tools.get(id) === undefined)
  assert.deepEqual(missing, [], `抽象工具目录中未注册：${missing.join(', ')}`)
})

test('不覆盖宿主已有的同名真工具（如 subagent），避免把真工具替换成 stub', async () => {
  const ctx = await mount()
  ctx.tools.register(subagentStub())
  const before = ctx.tools.get('subagent')

  registerStageTools(ctx, await deps())

  assert.equal(ctx.tools.get('subagent'), before, 'subagent 必须是宿主原工具，不能被降级覆盖')
  assert.equal(ctx.tools.get('subagent')?.description, 'real host subagent tool')
})

test('fs_write / fs_read 真实读写工作区（阶段 agent 靠它们产出产物）', async () => {
  const ctx = await mount()
  ctx.tools.register(subagentStub())
  const d = await deps()
  registerStageTools(ctx, d)

  const written = await ctx.tools.get('fs_write')!.execute(
    { path: 'nested/out.json', content: '{"ok":true}' } as never,
    {} as never,
  )
  assert.deepEqual(written, { path: 'nested/out.json' })
  assert.equal(await readFile(join(d.baseDir, 'nested/out.json'), 'utf8'), '{"ok":true}')

  const read = await ctx.tools.get('fs_read')!.execute({ path: 'nested/out.json' } as never, {} as never)
  assert.deepEqual(read, { text: '{"ok":true}' })
})

test('executor_run 在未配置被测服务时拒绝产出执行记录（不允许伪造证据）', async () => {
  const ctx = await mount()
  ctx.tools.register(subagentStub())
  registerStageTools(ctx, await deps()) // targetBaseUrl 缺省

  const result = await ctx.tools.get('executor_run')!.execute({ caseIds: ['c1'] } as never, {} as never) as { error?: string }
  assert.match(result.error ?? '', /未配置被测服务基址/)
})

test('executor_run 找不到 design 产物时明确报错，而不是空跑成功', async () => {
  const ctx = await mount()
  ctx.tools.register(subagentStub())
  const d = await deps()
  registerStageTools(ctx, { ...d, targetBaseUrl: 'http://127.0.0.1:1' })

  const result = await ctx.tools.get('executor_run')!.execute({ caseIds: ['c1'] } as never, {} as never) as { error?: string }
  assert.match(result.error ?? '', /未找到 design 产物/)
})

test('executor_run 对真实 design 产物发起真实 HTTP 并落执行会话', async () => {
  const ctx = await mount()
  ctx.tools.register(subagentStub())
  const d = await deps()
  await mkdir(join(d.artifactsRoot, 'pipe-1'), { recursive: true })
  await writeFile(
    join(d.artifactsRoot, 'pipe-1', 'design.json'),
    JSON.stringify({ testCases: [{ id: 'TC-1', steps: [{ action: 'GET /health', expected: ['200'] }] }] }),
  )

  // 本地假服务：真实 HTTP，返回 200
  const { createServer } = await import('node:http')
  const server = createServer((_req, res) => { res.writeHead(200); res.end('ok') })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0

  try {
    registerStageTools(ctx, { ...d, targetBaseUrl: `http://127.0.0.1:${port}` })
    const result = await ctx.tools.get('executor_run')!.execute({ caseIds: ['TC-1'] } as never, {} as never) as {
      records?: Array<{ caseId: string; status: string }>
    }
    assert.equal(result.records?.[0]?.caseId, 'TC-1')
    assert.equal(result.records?.[0]?.status, 'pass')
    const session = JSON.parse(await readFile(d.sessionPath, 'utf8')) as { records: unknown[] }
    assert.equal(session.records.length, 1, '执行会话必须落盘，供执行可信门禁 R4-08/09/10 对账')
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})