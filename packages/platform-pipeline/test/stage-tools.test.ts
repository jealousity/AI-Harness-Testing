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
import { FsArtifactStore } from '../src/stores/fs.ts'

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
 * 回归：检查点把产物路径钉成 `artifacts/<pipelineId>/<stage>.json`（带硬编码
 * `artifacts/` 前缀），FsArtifactStore 以 artifactsRoot 为基准解析它。阶段 agent
 * 用 fs_write 写**同一个相对路径**——所以 baseDir 必须等于 artifactsRoot，
 * 否则写入点与读取点不重合，每个阶段都报 "produced no artifact"。
 */
test('阶段写入点与 driver 读取点重合：baseDir == artifactsRoot（否则阶段全部 no artifact）', async () => {
  const ctx = await mount()
  ctx.tools.register(subagentStub())
  const d = await deps()

  // 模拟宿主插件的接线：baseDir = artifactsRoot（这正是被这条测试钉住的性质）
  registerStageTools(ctx, { ...d, baseDir: d.artifactsRoot })

  // 阶段 agent 拿到的路径来自检查点初始 stageStates
  const { initialCheckpoint } = await import('../src/checkpoint.ts')
  const pipelineId = 'host-2026'
  const artifactPath = initialCheckpoint(pipelineId, 'v1', 'v1').stageStates.receive!.artifact
  assert.equal(artifactPath, `artifacts/${pipelineId}/receive.json`)

  // 阶段 agent 通过 fs_write 写它（提示词里说这是"唯一写路径"）
  await ctx.tools.get('fs_write')!.execute(
    { path: artifactPath, content: JSON.stringify({ requirements: [{ id: 'R-1', text: '登录改造' }] }) } as never,
    {} as never,
  )

  // driver 通过 FsArtifactStore(artifactsRoot) 读同一个路径，必须能读到
  const store = new FsArtifactStore(d.artifactsRoot)
  const artifact = await store.read(artifactPath)
  assert.ok(artifact !== null, `driver 读不到阶段产物（写入点≠读取点）：${artifactPath}`)
  assert.equal(artifact.pipelineId, pipelineId)
  assert.equal(artifact.stageId, 'receive')
})

test('baseDir 取 dirname(artifactsRoot) 会让写入点与读取点错开（反向验证，防回归）', async () => {
  const ctx = await mount()
  ctx.tools.register(subagentStub())
  const d = await deps()
  const wrongBase = join(d.artifactsRoot, '..') // 错误接线的等价形式

  registerStageTools(ctx, { ...d, baseDir: wrongBase })
  const artifactPath = 'artifacts/pipe-2/receive.json'
  await ctx.tools.get('fs_write')!.execute({ path: artifactPath, content: '{"a":1}' } as never, {} as never)

  const store = new FsArtifactStore(d.artifactsRoot)
  assert.equal(await store.read(artifactPath), null, '错误基准下 driver 必须读不到——证明该约束真的起作用')
})

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
/**
 * 回归：executor 必须能在**标准布局**下找到 design 产物。
 * 检查点把产物路径钉成 `artifacts/<pipelineId>/<stage>.json`，故相对 artifactsRoot
 * 还多一层 `artifacts/`。实测踩到过：只找 `<root>/<pid>/design.json` 时 executor
 * 永远找不到 design 产物，execute 阶段全部用例 pending、零执行。
 */
test('executor_run 能在标准布局 <artifactsRoot>/artifacts/<pid>/design.json 下找到 design 产物', async () => {
  const ctx = await mount()
  ctx.tools.register(subagentStub())
  const d = await deps()
  // 标准布局：artifactsRoot/artifacts/<pipelineId>/design.json
  await mkdir(join(d.artifactsRoot, 'artifacts', 'host-2026'), { recursive: true })
  await writeFile(
    join(d.artifactsRoot, 'artifacts', 'host-2026', 'design.json'),
    JSON.stringify({ testCases: [{ id: 'TC-1', steps: [{ action: 'GET /health', expected: ['200'] }] }] }),
  )

  const { createServer } = await import('node:http')
  const server = createServer((_req, res) => { res.writeHead(200); res.end('ok') })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0

  try {
    registerStageTools(ctx, { ...d, baseDir: d.artifactsRoot, targetBaseUrl: `http://127.0.0.1:${port}` })
    const result = await ctx.tools.get('executor_run')!.execute({ caseIds: ['TC-1'] } as never, {} as never) as {
      records?: Array<{ caseId: string; status: string }>
      error?: string
    }
    assert.equal(result.error, undefined, `标准布局下不应报错：${result.error ?? ''}`)
    assert.equal(result.records?.[0]?.status, 'pass')
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

/**
 * 回归：executor_run 被多次调用（分批执行）时必须**续接**会话，不能覆盖。
 *
 * 实测踩到的严重后果：子会话先跑一批 [TC-1..TC-3]、又单独跑 [TC-4]，
 * 旧实现每次 writeFile 覆盖 → 会话里只剩最后 1 条记录 → 机器门禁 R4-08
 * 去查权威记录，判定前 3 条「漏跑」，把一份「4 条全 pass」的产物判成 BLOCKING，
 * 三次重试耗尽后升级到人工门终止。即：产物自述 pass，权威记录却不存在。
 *
 * 该测试同时钉住 seq 连续与哈希链完整（verifyChain）。
 */
test('executor_run 分批调用必须续接记录链：第二批不得吞掉第一批', async () => {
  const ctx = await mount()
  ctx.tools.register(subagentStub())
  const d = await deps()

  const { createServer } = await import('node:http')
  const server = createServer((_req, res) => { res.writeHead(200); res.end('ok') })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0

  try {
    await mkdir(join(d.artifactsRoot, 'artifacts', 'host-2026'), { recursive: true })
    await writeFile(
      join(d.artifactsRoot, 'artifacts', 'host-2026', 'design.json'),
      JSON.stringify({
        testCases: ['TC-1', 'TC-2', 'TC-3', 'TC-4'].map(id => ({ id, steps: [{ action: 'GET /health', expected: ['200'] }] })),
      }),
    )
    registerStageTools(ctx, { ...d, baseDir: d.artifactsRoot, targetBaseUrl: `http://127.0.0.1:${port}` })

    // 第一批 3 条
    await ctx.tools.get('executor_run')!.execute({ caseIds: ['TC-1', 'TC-2', 'TC-3'] } as never, {} as never)
    // 第二批 1 条（旧实现在这里覆盖掉前 3 条）
    await ctx.tools.get('executor_run')!.execute({ caseIds: ['TC-4'] } as never, {} as never)

    const session = JSON.parse(await readFile(d.sessionPath, 'utf8')) as {
      records: Array<{ seq: number; caseId: string }>
    }
    assert.deepEqual(
      session.records.map(r => r.caseId),
      ['TC-1', 'TC-2', 'TC-3', 'TC-4'],
      '两批记录必须都在（旧实现在此只剩 ["TC-4"]）',
    )
    assert.deepEqual(session.records.map(r => r.seq), [1, 2, 3, 4], 'seq 必须连续续接，不重开')

    // 链必须完整可验（R4-09/10 会验链）：续接若断链，这里会暴露
    const { verifyChain } = await import('../src/executor/records.ts')
    const chainViolations = verifyChain(session.records as never)
    assert.deepEqual(chainViolations, [], `续接后链必须完整，实际：${JSON.stringify(chainViolations)}`)
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})
