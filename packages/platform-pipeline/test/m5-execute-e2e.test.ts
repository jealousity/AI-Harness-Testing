/**
 * M5 Web 集成发布门槛：**真实执行器的六阶段端到端**（docs/11 §9 批次 E 第 7 项、docs/13 门槛10）。
 *
 * 与 `web-http.test.ts` 验收7 的关系：那条只验证了**负向的一半**——"execute 缺少真实
 * 执行数据时门禁失败，不出现伪造的执行记录"。本文件补上**正向的一半**：
 * 真实执行数据齐备时，执行对账（R4-08）必须**通过**，流水线必须能跑完六个阶段。
 *
 * 这条正向路径此前从未被端到端覆盖过，原因是脚本化宿主不产生真实执行数据
 * （`ScriptedHost` 原本不装配 `execution` 加载器）。现在用 `beforeStage` 钩子在
 * `execute` 阶段 spawn **之前**驱动真实的 `executor_run` 工具：
 *
 * ```text
 * 真实本地 HTTP 服务（被测系统）
 *   ← 真实 fetch（executor_run 发出真实请求、写证据、写会话链）
 *   → execute 阶段 spawn → 机器门禁 R4-08 用真实会话对账 → 通过
 *   → 人工门 → report → archive → completed
 * ```
 *
 * **已知的"非生产同构"之处（如实声明）**：`targetBaseUrl` 的 SSRF 判据默认拒绝本机与
 * 内网地址，因此本测试必须覆写 `assertTargetBaseUrl` / `assertResolvedTargetAllowed`
 * 才能连本地服务。覆写本身是被设计支持的宿主注入点（"不经过 Web/CLI 创建流程的测试"），
 * 但它确实意味着**公网可达的真实被测系统尚未验证**——那一项在 docs/13 里单列为未收口。
 *
 * @module test/m5-execute-e2e
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { STAGE_ORDER, type PipelineConfig, type StageId } from '../src/types.ts'
import { verifyChain, type ExecutionRecord } from '../src/executor/records.ts'
import { resolvePlatformRoots } from '../src/platform-roots.ts'
import { createExecutionLoader } from '../src/runtime/platform-host.ts'
import { buildPlatformTools, executorEvidenceDir, executorSessionPath } from '../src/runtime/platform-tools.ts'
import { FilePipelineRunService } from '../src/web/pipeline-run-service.ts'
import type { PlatformToolContext } from '../src/runtime/platform-tools.ts'
import { CREATE, REVIEWER, SCOPE, ScriptedHost, baseConfig } from './web-fixtures.ts'

const PIPELINE = 'pipe-1'
/** design 阶段写下的用例：只打真实本地服务的 `/health`。 */
const TEST_CASES = [{ id: 'c1', steps: [{ action: 'GET /health', expected: ['200'] }] }]

/**
 * 阶段产物内容工厂。
 *
 * 三个阶段的产物在 R4-08 对账里各自有明确角色，缺一个就会被判违规：
 * - `design` 写 `testCases`（**计划用例**，R4-08 用它算"漏跑"）；
 * - `execute` 写 `results: [{caseId, recordRef}]`（**阶段 agent 对执行记录的引用**，
 *   R4-08 用它算"伪造结果"与"多余执行"）。`recordRef` 由真实 execute agent 读执行会话后
 *   写下；本测试里会话恰好只有一条记录（seq 1），因此直接写 `'1'`。
 * - 其余阶段用脚本化宿主的默认内容即可。
 */
function contentFactory(): (input: { readonly stageId: StageId }) => unknown {
  return ({ stageId }) => {
    if (stageId === 'design') return { testCases: TEST_CASES }
    if (stageId === 'execute') return { results: [{ caseId: 'c1', recordRef: '1' }] }
    return { stage: stageId, summary: `scripted artifact for ${stageId}` }
  }
}

let dir: string
let config: PipelineConfig

/** 只给 `execute` 打开执行对账规则；其余阶段不配规则，让本用例专注"执行数据是否被认账"。 */
function configWithExecuteReconciliation(): PipelineConfig {
  return baseConfig({
    stages: Object.fromEntries(STAGE_ORDER.map(id => [
      id,
      { rules: id === 'execute' ? ['R4-08'] : [], review: { enabled: false } },
    ])),
  })
}

interface Sut {
  readonly baseUrl: string
  readonly hits: readonly string[]
  readonly close: () => Promise<void>
}

/** 真实被测系统：一个真的会响应 HTTP 的本地服务，并记录收到的请求。 */
async function startSut(): Promise<Sut> {
  const hits: string[] = []
  const server: Server = createServer((request, response) => {
    hits.push(`${request.method ?? 'GET'} ${request.url ?? '/'}`)
    if (request.url === '/health') {
      response.writeHead(200, { 'content-type': 'text/plain' })
      response.end('ok')
      return
    }
    response.writeHead(404, { 'content-type': 'text/plain' })
    response.end('missing')
  })
  await new Promise<void>(resolve => { server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  assert.ok(address !== null && typeof address === 'object', '监听地址必须可读')
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    hits,
    close: () => new Promise<void>((resolve, reject) => {
      server.close(error => { error === undefined ? resolve() : reject(error) })
    }),
  }
}

test.beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'pp-execute-e2e-'))
  config = configWithExecuteReconciliation()
})
test.afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

/** 在 `execute` 阶段 spawn 之前，用真实 executor 对真实被测系统执行一次。 */
async function runRealExecutor(baseUrl: string): Promise<void> {
  // 基准必须是**解析后的项目根**（`resolvePlatformRoots`），不是 dataRoot：
  // 产物/证据/会话都落在 `<dataRoot>/tenants/<t>/projects/<p>/` 下面。
  const roots = resolvePlatformRoots(dir, config)
  const context: PlatformToolContext = {
    projectRoot: roots.projectRoot,
    artifactsRoot: roots.artifactsRoot,
    pipelineId: PIPELINE,
    projectId: 'demo',
    targetBaseUrl: baseUrl,
    // 见模块头注释：本机地址默认被 SSRF 判据拒绝，测试宿主必须显式放行。
    assertTargetBaseUrl: () => {},
    assertResolvedTargetAllowed: async () => {},
  }
  const tool = buildPlatformTools(context).find(candidate => candidate.name === 'executor_run')
  assert.ok(tool !== undefined, 'executor_run 必须注册')
  const result = await tool.execute({}, { signal: new AbortController().signal }) as {
    readonly error?: string
    readonly records?: readonly { readonly caseId: string; readonly status: string }[]
  }
  assert.equal(result.error, undefined, `真实执行不得失败：${result.error ?? ''}`)
  assert.deepEqual(result.records?.map(record => [record.caseId, record.status]), [['c1', 'pass']])
}

/**
 * 一路批准人工门，直到 `settled` 返回 true（或流水线自行进入终态）。
 *
 * 返回最后那次 `run()` 的 outcome；若流水线先到达 `settled` 条件，返回 `null`
 * 表示"已停在条件上，尚未继续跑"。
 */
async function approveUntil(
  service: FilePipelineRunService,
  settled: (view: Awaited<ReturnType<FilePipelineRunService['get']>>) => boolean,
): Promise<string | null> {
  for (let round = 0; round < STAGE_ORDER.length + 2; round += 1) {
    const result = await service.run(PIPELINE, REVIEWER)
    if (result.outcome !== 'waiting-human') return result.outcome
    if (settled(await service.get(PIPELINE, REVIEWER))) return null
    const open = (await service.listGateTasks(SCOPE, REVIEWER))
      .find(task => task.status === 'pending' || task.status === 'claimed')
    assert.ok(open !== undefined, '等待人工门时必须存在未决门任务')
    await service.claimGate({ ...SCOPE, gateTaskId: open.gateTaskId }, REVIEWER)
    await service.decideGate({ ...SCOPE, gateTaskId: open.gateTaskId, action: 'approved' }, REVIEWER)
  }
  assert.fail('流水线在预期轮数内没有进入终态')
}

/** 一路批准到流水线进入终态。 */
async function approveUntilSettled(service: FilePipelineRunService): Promise<string> {
  const outcome = await approveUntil(service, () => false)
  assert.ok(outcome !== null, 'settled 恒为 false 时不可能返回 null')
  return outcome
}

/** 批准当前未决门（认领 + 批准），**不触发下一次 run**。 */
async function approveOpenGate(service: FilePipelineRunService): Promise<void> {
  const open = (await service.listGateTasks(SCOPE, REVIEWER))
    .find(task => task.status === 'pending' || task.status === 'claimed')
  assert.ok(open !== undefined, '等待人工门时必须存在未决门任务')
  await service.claimGate({ ...SCOPE, gateTaskId: open.gateTaskId }, REVIEWER)
  await service.decideGate({ ...SCOPE, gateTaskId: open.gateTaskId, action: 'approved' }, REVIEWER)
}

test('门槛10：真实执行数据齐备时，R4-08 对账通过，六阶段跑到 completed', async () => {
  const sut = await startSut()
  try {
    const host = new ScriptedHost({
      content: contentFactory(),
      // 关键：装配执行数据加载器，让 R4-08 有真实会话可对账。
      execution: createExecutionLoader(resolvePlatformRoots(dir, config).projectRoot, PIPELINE),
    })
    const service = new FilePipelineRunService({
      dataRoot: dir,
      loadConfig: async () => config,
      createHost: host.factory,
    })
    await service.create(CREATE, REVIEWER)

    // 1. 逐阶段推进到 **design 的裁决已下、但尚未被消费**。
    //
    //    时点很关键：一旦再调一次 `run()`，driver 会立刻消费 design 的批准、推进到
    //    execute 并在同一次调用里撞上 R4-08——那时真实执行数据还没产生。
    //    因此这里**只批准、不再 run**，把"插入真实执行"的窗口留出来。
    for (const stageId of ['receive', 'analyze', 'design']) {
      const result = await service.run(PIPELINE, REVIEWER)
      assert.equal(result.outcome, 'waiting-human', `前置：${stageId} 应停在人工门，实际 ${result.outcome}`)
      await approveOpenGate(service)
    }

    // 2. 用真实 executor 对真实被测系统执行一次（真实请求、真实证据、真实会话链）。
    //    executor 自读 `artifacts/<pipelineId>/design.json`，因此必须在 design 落盘之后。
    await runRealExecutor(sut.baseUrl)

    // 3. 继续跑：execute 阶段的 R4-08 必须用刚产生的真实会话判过账。
    const outcome = await approveUntilSettled(service)
    const probe = await service.get(PIPELINE, REVIEWER)
    assert.equal(outcome, 'completed',
      `真实执行数据齐备时必须能跑完六阶段，实际 ${outcome}；`
      + `execute violations=${JSON.stringify(probe.stages.find(stage => stage.stageId === 'execute')!.machineViolations)}`)

    // ── 真实执行的痕迹：请求真的发出去了、证据真的落盘了、链真的完整 ──────────
    assert.deepEqual(sut.hits, ['GET /health'], `被测系统必须真的收到请求，实际 ${JSON.stringify(sut.hits)}`)

    const roots = resolvePlatformRoots(dir, config)
    const evidenceFiles = await readdir(executorEvidenceDir(roots.projectRoot, PIPELINE))
    assert.ok(evidenceFiles.length > 0, '真实执行必须留下证据文件')

    const session = JSON.parse(await readFile(executorSessionPath(roots.projectRoot, PIPELINE), 'utf8')) as {
      readonly records: readonly ExecutionRecord[]
    }
    assert.equal(session.records.length, TEST_CASES.length)
    assert.deepEqual(verifyChain(session.records), [], '执行记录链必须完整（R4-09 的前提）')

    // ── 终态视图：六个阶段全部 done，且 execute 的对账没有被绕过 ───────────────
    const view = await service.get(PIPELINE, REVIEWER)
    assert.equal(view.status, 'completed')
    assert.deepEqual(view.stages.map(stage => stage.status), STAGE_ORDER.map(() => 'done'))
    assert.equal(view.stages.find(stage => stage.stageId === 'execute')!.machineStatus, 'passed',
      'R4-08 必须真的用真实会话判过账，而不是"没数据所以跳过"')
  } finally {
    await sut.close()
  }
})

test('门槛10b：同一套配置下若执行数据缺失，R4-08 必须拦下 execute（正向门槛的另一半）', async () => {
  // 除 `beforeStage` 之外完全相同的装配：不驱动 executor → 没有执行数据。
  const host = new ScriptedHost({
    content: ({ stageId }) => (stageId === 'design'
      ? { testCases: TEST_CASES }
      : { stage: stageId, summary: `scripted artifact for ${stageId}` }),
    execution: createExecutionLoader(dir, PIPELINE),
  })
  const service = new FilePipelineRunService({
    dataRoot: dir,
    loadConfig: async () => config,
    createHost: host.factory,
  })
  await service.create(CREATE, REVIEWER)

  const outcome = await approveUntilSettled(service)
  assert.equal(outcome, 'gate-failed', `没有执行数据时 execute 必须被拦下，实际 ${outcome}`)

  const view = await service.get(PIPELINE, REVIEWER)
  const execute = view.stages.find(stage => stage.stageId === 'execute')!
  assert.equal(execute.status, 'gate-failed')
  assert.ok(execute.machineViolations.some(violation => violation.rule === 'R4-08'),
    `必须报出 R4-08 违规，实际 ${JSON.stringify(execute.machineViolations)}`)

  // 关键：不得因为"没有执行数据"就伪造一条记录。
  const roots = resolvePlatformRoots(dir, config)
  await assert.rejects(
    () => readFile(join(roots.projectRoot, 'executor', PIPELINE, 'session.json'), 'utf8'),
    /ENOENT/,
    '没有真实执行时不得存在执行会话文件',
  )
})
