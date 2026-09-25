/**
 * Web HTTP 外壳端到端测试（docs/10 §5.5 M1 验收八条）。
 *
 * 被测对象是**真实的 `web-app/server.mjs` 子进程**，不是被测代码的替身：
 * 路由、鉴权入口、响应映射、service、driver、检查点、产物、人工门、后台调度
 * 全部走真实链路。唯一被替换的是 **LLM 阶段运行器**（`PLATFORM_HOST_MODULE`
 * 注入 `ScriptedHost`）——这正是 `ScriptedStageRunner` 存在的意义，也是本测试
 * 不消耗 API Key 的前提。
 *
 * 为什么必须用子进程：§5.5 验收 6「进程重启后可以从 checkpoint 继续」只有在
 * 真的杀掉进程再拉起来时才成立。同进程内新建 service 实例是另一件事（那条路径
 * 已由 `pipeline-run-service.test.ts` 覆盖）。
 *
 * 子进程启动要先把 TypeScript 源码图编译一遍（实测 10~25 秒），因此所有
 * 等待都显式设了较长的上限；`node:test` 默认不设超时，够用。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer, type AddressInfo } from 'node:net'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { computeArtifactDigest } from '../src/gates/machine.ts'
import { resolvePlatformRoots } from '../src/platform-roots.ts'
import { baseConfig } from './web-fixtures.ts'

const PACKAGE_ROOT = fileURLToPath(new URL('..', import.meta.url))
const REPO_ROOT = resolve(PACKAGE_ROOT, '..', '..')
const SERVER_ENTRY = join(REPO_ROOT, 'web-app', 'server.mjs')
const FIXTURES_URL = pathToFileURL(join(PACKAGE_ROOT, 'test', 'web-fixtures.ts')).href
const CLI_ENTRY = join(PACKAGE_ROOT, 'src', 'cli.ts')

/** 子进程启动预算：TS 源码图首次编译约 10~25s，留足余量。 */
const BOOT_TIMEOUT_MS = 120_000
const REQUEST_TIMEOUT_MS = 30_000

const PROJECT_ID = 'demo'
const PIPELINE_ID = 'pipe-1'
const TENANT_ID = 'acme'

async function freePort(): Promise<number> {
  const probe = createServer()
  await new Promise<void>(resolve => probe.listen(0, '127.0.0.1', resolve))
  const port = (probe.address() as AddressInfo).port
  await new Promise<void>(resolve => probe.close(() => resolve()))
  return port
}

/**
 * 一次「Web 部署」：临时目录 + 配置文件 + 脚本化宿主模块 + 可反复起停的 server 子进程。
 *
 * `dir` 在重启之间保持不变——这正是验收 6 与 8 的前提（同一 dataRoot）。
 */
class WebApp {
  readonly dir: string
  readonly configPath: string
  readonly spawnLog: string
  port = 0
  private child: ChildProcess | null = null
  private output = ''

  private constructor(dir: string) {
    this.dir = dir
    this.configPath = join(dir, 'pipeline.json')
    this.spawnLog = join(dir, 'spawns.log')
  }

  static async create(configOverrides: Record<string, unknown> = {}): Promise<WebApp> {
    const dir = await mkdtemp(join(tmpdir(), 'pp-web-'))
    const app = new WebApp(dir)
    // 用 JSON 写配置：`loadPipelineConfig` 按扩展名判格式，JSON 不需要 YAML 转义。
    await writeFile(app.configPath, JSON.stringify(baseConfig(configOverrides), null, 2), 'utf8')
    await writeFile(app.spawnLog, '', 'utf8')

    // 脚本化宿主模块：与 createPlatformHost 同装配顺序，只换掉 LLM 阶段运行器。
    // 产物内容带自增 `call`，因此"是否重生成"能从 digest 上直接看出来。
    // `initialCall` 从既有日志行数续号：进程重启后 call 仍单调，否则重生成的
    // 产物会拿到与重启前相同的编号，digest 相同，"被重生成"就不可见了。
    await writeFile(join(dir, 'scripted-host.mjs'), [
      "import { appendFileSync, readFileSync } from 'node:fs'",
      `import { ScriptedHost } from ${JSON.stringify(FIXTURES_URL)}`,
      '',
      'const logPath = process.env.SPAWN_LOG',
      'const initialCall = readFileSync(logPath, "utf8").split("\\n").filter(line => line.trim() !== "").length',
      '',
      'const host = new ScriptedHost({',
      '  initialCall,',
      '  content: ({ stageId, call }) => ({ stage: stageId, call }),',
      '  onSpawn: (stageId, call) => appendFileSync(logPath, `${stageId} ${call}\\n`),',
      '})',
      '',
      'export function createHost(options) { return host.factory(options) }',
      '',
    ].join('\n'), 'utf8')
    return app
  }

  get baseUrl(): string {
    return `http://127.0.0.1:${this.port}`
  }

  async start(): Promise<void> {
    assert.equal(this.child, null, 'server 已在运行')
    if (this.port === 0) this.port = await freePort()
    this.output = ''
    const child = spawn(process.execPath, [SERVER_ENTRY], {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        PORT: String(this.port),
        HOST: '127.0.0.1',
        PLATFORM_DATA_ROOT: this.dir,
        PLATFORM_CONFIG_PATH: this.configPath,
        PLATFORM_CONFIG_REF: 'default',
        PLATFORM_ACTOR_ID: 'e2e-operator',
        PLATFORM_ACTOR_TENANT: TENANT_ID,
        PLATFORM_ACTOR_ROLES: 'reviewer,admin',
        PLATFORM_RUNNER_ACTOR_ID: 'e2e-runner',
        PLATFORM_GATE_WAIT_TIMEOUT_MS: '0',
        PLATFORM_HOST_MODULE: join(this.dir, 'scripted-host.mjs'),
        SPAWN_LOG: this.spawnLog,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    child.stdout?.on('data', chunk => { this.output += String(chunk) })
    child.stderr?.on('data', chunk => { this.output += String(chunk) })
    this.child = child

    const deadline = Date.now() + BOOT_TIMEOUT_MS
    for (;;) {
      if (child.exitCode !== null) {
        throw new Error(`server 启动即退出（code ${child.exitCode}）：\n${this.output}`)
      }
      try {
        const response = await this.rawRequest('GET', '/health')
        if (response.status === 200) return
      } catch {
        // 端口还没起来：继续等。
      }
      if (Date.now() > deadline) {
        throw new Error(`server 在 ${BOOT_TIMEOUT_MS}ms 内未就绪：\n${this.output}`)
      }
      await new Promise(resolve => setTimeout(resolve, 300))
    }
  }

  /** 模拟进程重启：先杀掉（等它真的退出），再用同一 dataRoot 拉起。 */
  async restart(): Promise<void> {
    await this.stop()
    await this.start()
  }

  async stop(): Promise<void> {
    const child = this.child
    if (child === null) return
    this.child = null
    await new Promise<void>(resolve => {
      child.once('exit', () => resolve())
      child.kill('SIGKILL')
      // 兜底：极少数情况下 exit 事件可能已经错过。
      setTimeout(resolve, 5000)
    })
  }

  private async rawRequest(method: string, path: string, body?: unknown): Promise<{ status: number; body: unknown }> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      method,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      ...(body === undefined
        ? {}
        : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
    })
    const text = await response.text()
    return { status: response.status, body: text === '' ? null : JSON.parse(text) }
  }

  async request(method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> {
    return this.rawRequest(method, path, body) as Promise<{ status: number; body: any }>
  }

  /** 已发生的阶段 spawn 记录（`<stageId> <call>` 行）。 */
  async spawns(): Promise<readonly string[]> {
    const raw = await readFile(this.spawnLog, 'utf8')
    return raw.split('\n').filter(line => line.trim() !== '')
  }

  /** 后台运行是异步的：轮询到"没有后台运行在跑"为止，再断言状态。 */
  async settle(timeoutMs = 60_000): Promise<any> {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const { body } = await this.request('GET', `/api/pipelines/${PIPELINE_ID}`)
      if (body.running === false) return body
      if (Date.now() > deadline) throw new Error(`后台运行在 ${timeoutMs}ms 内未收敛：${JSON.stringify(body)}`)
      await new Promise(resolve => setTimeout(resolve, 250))
    }
  }
}

async function withApp(
  run: (app: WebApp) => Promise<void>,
  configOverrides: Record<string, unknown> = {},
): Promise<void> {
  const app = await WebApp.create(configOverrides)
  try {
    await app.start()
    await run(app)
  } finally {
    await app.stop()
    await rm(app.dir, { recursive: true, force: true })
  }
}

/**
 * 创建流水线；同一 `pipelineId` 已存在时按「复用」处理。
 *
 * 两种情况都算"已经建好了"：202（首次创建）与 409（磁盘上已存在但台账里没有本次
 * 请求的记录，见 docs/10 §6.3 M2-3）。多个断言段落共用同一条流水线时不必各自记账。
 */
async function createPipeline(app: WebApp): Promise<void> {
  const created = await app.request('POST', `/api/projects/${PROJECT_ID}/pipelines`, { pipelineId: PIPELINE_ID })
  if (created.status === 202) return
  assert.equal(created.body?.error?.code, 'conflict', `创建流水线失败：${created.status} ${JSON.stringify(created.body)}`)
}

/** 创建流水线并把它跑到第一次人工门，返回门任务。 */
async function openFirstGate(app: WebApp): Promise<any> {
  await createPipeline(app)
  await app.request('POST', `/api/pipelines/${PIPELINE_ID}/run`)
  const view = await app.settle()
  assert.equal(view.status, 'waiting-human')
  const gates = await app.request('GET', `/api/pipelines/${PIPELINE_ID}/gates`)
  const task = gates.body.gates.find((item: any) => item.status === 'pending')
  assert.ok(task !== undefined, '期望存在一条待裁决的人工门任务')
  return task
}

/** 用真实 CLI 读同一 dataRoot，返回解析后的 JSON 输出。 */
async function cliJson(app: WebApp, command: string): Promise<any> {
  const child = spawn(process.execPath, [
    CLI_ENTRY, command,
    '--config', app.configPath,
    '--data-root', app.dir,
    '--pipeline-id', PIPELINE_ID,
  ], { cwd: REPO_ROOT, stdio: ['ignore', 'pipe', 'pipe'] })
  let out = ''
  let err = ''
  child.stdout?.on('data', chunk => { out += String(chunk) })
  child.stderr?.on('data', chunk => { err += String(chunk) })
  const code = await new Promise<number>(resolve => child.once('exit', value => resolve(value ?? -1)))
  assert.equal(code, 0, `CLI ${command} 失败：${err}`)
  return JSON.parse(out)
}

async function decide(app: WebApp, task: any, action: string, note = ''): Promise<any> {
  return app.request('POST', `/api/gates/${task.gateTaskId}/decide`, {
    pipelineId: PIPELINE_ID, action, note, expectedUpdatedAt: task.updatedAt,
  })
}

/** 反复「触发 → 收敛 → 批准待裁决任务」，直到流水线到达终态。 */
async function driveToTerminal(app: WebApp, rounds = 8): Promise<any> {
  for (let round = 0; round < rounds; round += 1) {
    await app.request('POST', `/api/pipelines/${PIPELINE_ID}/run`)
    const view = await app.settle()
    if (view.status === 'completed') return view
    const gates = await app.request('GET', `/api/pipelines/${PIPELINE_ID}/gates`)
    const task = gates.body.gates.find((item: any) => item.status === 'pending')
    if (task === undefined) return view
    const decided = await decide(app, task, 'approved')
    assert.equal(decided.status, 200)
  }
  throw new Error('流水线在给定轮数内未完成')
}

// ── 验收 1：create 返回 202，且不泄露 API Key ────────────────────────────────

test('验收1：创建流水线返回 202，响应里没有任何 provider 凭据字段', async () => {
  await withApp(async app => {
    const created = await app.request('POST', `/api/projects/${PROJECT_ID}/pipelines`, {
      pipelineId: PIPELINE_ID,
      // 即便客户端硬塞凭据，服务端也不该把它带进任何响应（配置里根本没有这个字段）。
      apiKey: 'sk-should-be-ignored-0123456789',
    })
    assert.equal(created.status, 202)
    assert.equal(created.body.pipelineId, PIPELINE_ID)
    assert.equal(created.body.status, 'queued')
    assert.equal(created.body.nextStage, 'receive')
    assert.equal(JSON.stringify(created.body).includes('sk-should-be-ignored'), false)

    const view = await app.request('GET', `/api/pipelines/${PIPELINE_ID}`)
    assert.equal(view.status, 200)
    assert.equal(JSON.stringify(view.body).includes('sk-'), false)
    // 不回显服务器部署布局。
    assert.equal(JSON.stringify(view.body).includes(app.dir), false)

    // 同一 pipelineId 的**同一请求**重复投递走幂等重放：返回首次的 202 结果，
    // 不再报冲突（docs/10 §6.3 M2-3 / §6.4「重试不产生副作用」）。
    const again = await app.request('POST', `/api/projects/${PROJECT_ID}/pipelines`, { pipelineId: PIPELINE_ID })
    assert.equal(again.status, 202)
    assert.equal(again.body.pipelineId, PIPELINE_ID)
    assert.equal(again.body.status, 'queued')

    // §5.3「绝不静默复用」仍然成立：换了内容的同 id 创建必须冲突。
    // 键字段（tenantId/projectId/pipelineId）相同，但 rulesetVersion 会写进初始检查点，
    // 属于创建内容的一部分——指纹不一致即拒。
    const divergent = await app.request('POST', `/api/projects/${PROJECT_ID}/pipelines`, {
      pipelineId: PIPELINE_ID,
      rulesetVersion: 'v2',
    })
    assert.equal(divergent.status, 409)
    assert.equal(divergent.body.error.code, 'conflict')

    // 前端页面不得包含任何凭据输入控件（§5.1：浏览器不再上传 key）。
    const page = await fetch(`${app.baseUrl}/`)
    const html = await page.text()
    assert.equal(html.includes('type="password"'), false)
    assert.equal(html.includes('id="api-key"'), false)
  })
})

// ── 验收 2：后台运行到人工门后查询为 waiting-human ────────────────────────────

test('验收2：后台运行到 receive 人工门，查询接口返回 waiting-human 且阶段状态来自持久化事实', async () => {
  await withApp(async app => {
    const task = await openFirstGate(app)

    const view = await app.request('GET', `/api/pipelines/${PIPELINE_ID}`)
    assert.equal(view.body.status, 'waiting-human')
    assert.equal(view.body.openGateTaskId, task.gateTaskId)
    assert.equal(view.body.running, false, '人工门让出控制权后本进程不应仍标记为运行中')

    const receive = view.body.stages.find((stage: any) => stage.stageId === 'receive')
    assert.equal(receive.status, 'awaiting-gate')
    assert.equal(receive.humanGateTaskId, task.gateTaskId)
    // startedAt 来自门任务的 createdAt（不是服务端观测时间）。
    assert.equal(receive.startedAt, task.createdAt)
    assert.equal(receive.digest.length > 0, true, '停在人工门时 digest 由产物文件回读')
    // 未跑到的阶段保持 idle 且没有 artifact 内容。
    assert.equal(view.body.stages.find((stage: any) => stage.stageId === 'analyze').status, 'idle')

    // 事件时间线只含持久化时间戳：至少有一条「开门」。
    const events = await app.request('GET', `/api/pipelines/${PIPELINE_ID}/events`)
    assert.deepEqual(events.body.events.map((event: any) => event.kind), ['gate-opened'])
    assert.equal(events.body.events[0].at, task.createdAt)

    // 产物回读：receive 已产出，analyze 尚未产出（404，而不是空对象）。
    const artifact = await app.request('GET', `/api/pipelines/${PIPELINE_ID}/stages/receive/artifact`)
    assert.equal(artifact.status, 200)
    assert.deepEqual(artifact.body.content, { stage: 'receive', call: 1 })
    const missing = await app.request('GET', `/api/pipelines/${PIPELINE_ID}/stages/analyze/artifact`)
    assert.equal(missing.status, 404)

    // 后台运行是异步的：run 立刻返回 202，而不是在请求内等完整条流水线。
    const triggered = await app.request('POST', `/api/pipelines/${PIPELINE_ID}/run`)
    assert.equal(triggered.status, 202)
    await app.settle()
  })
})

// ── 验收 3：claim + decide 后再触发，receive 产物不重生成 ─────────────────────

test('验收3：裁决后再次触发不重生成 receive 产物，也不重跑该阶段的审核', async () => {
  await withApp(async app => {
    const task = await openFirstGate(app)
    const before = await app.request('GET', `/api/pipelines/${PIPELINE_ID}/stages/receive/artifact`)
    assert.deepEqual(before.body.content, { stage: 'receive', call: 1 })

    // 显式 claim + decide（走完整裁决路径，而不是只调 decide）。
    const claimed = await app.request('POST', `/api/gates/${task.gateTaskId}/claim`, { pipelineId: PIPELINE_ID })
    assert.equal(claimed.status, 200)
    assert.equal(claimed.body.status, 'claimed')
    assert.equal(claimed.body.claimedBy, 'e2e-operator')
    const decided = await app.request('POST', `/api/gates/${task.gateTaskId}/decide`, {
      pipelineId: PIPELINE_ID, action: 'approved', note: '同意', expectedUpdatedAt: claimed.body.updatedAt,
    })
    assert.equal(decided.status, 200)
    assert.equal(decided.body.decision.action, 'approved')
    assert.equal(decided.body.consumedAt, undefined, '裁决尚未被消费')

    // 再次触发：消费 receive 的裁决并前进到 analyze。
    await app.request('POST', `/api/pipelines/${PIPELINE_ID}/run`)
    const view = await app.settle()
    assert.equal(view.status, 'waiting-human')

    const after = await app.request('GET', `/api/pipelines/${PIPELINE_ID}/stages/receive/artifact`)
    assert.equal(after.body.digest, before.body.digest, 'receive 产物不得被重生成')
    assert.deepEqual(after.body.content, { stage: 'receive', call: 1 })
    // 只有 analyze 被 spawn 过一次：receive 没有第二次 spawn（call 计数不会出现 receive 2）。
    assert.deepEqual(await app.spawns(), ['receive 1', 'analyze 2'])

    // receive 的裁决已被消费，不会再驱动门。
    const gates = await app.request('GET', `/api/pipelines/${PIPELINE_ID}/gates`)
    const consumed = gates.body.gates.find((item: any) => item.gateTaskId === task.gateTaskId)
    assert.equal(typeof consumed.consumedAt, 'number')
    const events = await app.request('GET', `/api/pipelines/${PIPELINE_ID}/events`)
    assert.equal(events.body.events.some((event: any) => event.kind === 'gate-consumed'), true)

    // 已消费的裁决不能再次裁决。
    const again = await decide(app, consumed, 'approved')
    assert.equal(again.status, 409)
    assert.equal(again.body.error.code, 'gate-consumed')
  })
})

// ── 验收 4：六阶段全部裁决后 completed ───────────────────────────────────────

test('验收4：六阶段全部裁决后流水线返回 completed，且每个阶段都有产物', async () => {
  await withApp(async app => {
    await createPipeline(app)
    const view = await driveToTerminal(app)

    assert.equal(view.status, 'completed')
    assert.equal(view.cursor, 6)
    assert.equal(view.nextStage, null)
    assert.deepEqual(view.stages.map((stage: any) => stage.status), Array(6).fill('done'))
    assert.equal(view.failure, null)
    assert.deepEqual(await app.spawns(), ['receive 1', 'analyze 2', 'design 3', 'execute 4', 'report 5', 'archive 6'])

    for (const stageId of ['receive', 'analyze', 'design', 'execute', 'report', 'archive']) {
      const artifact = await app.request('GET', `/api/pipelines/${PIPELINE_ID}/stages/${stageId}/artifact`)
      assert.equal(artifact.status, 200, `${stageId} 应有产物`)
      assert.equal(artifact.body.stageId, stageId)
      assert.match(artifact.body.artifactPath, new RegExp(`^artifacts/${PIPELINE_ID}/${stageId}\\.json$`))
    }

    // 终态：恢复扫描不得重跑它（§5.4 第 7 步）。
    const recovered = await app.request('POST', '/api/admin/recover')
    assert.equal(recovered.status, 200)
    assert.deepEqual(recovered.body.outcomes, [
      { pipelineId: PIPELINE_ID, action: 'terminal', status: 'completed', started: false, detail: null },
    ])
    await new Promise(resolve => setTimeout(resolve, 500))
    assert.equal((await app.spawns()).length, 6)
  })
})

// ── 验收 5：changes-needed 只重跑当前阶段及下游，旧裁决不重复消费 ─────────────

test('验收5：changes-needed 打回当前阶段，旧裁决不被重复消费', async () => {
  await withApp(async app => {
    await createPipeline(app)

    // 批准 receive，前进到 analyze。
    await app.request('POST', `/api/pipelines/${PIPELINE_ID}/run`)
    await app.settle()
    let gates = await app.request('GET', `/api/pipelines/${PIPELINE_ID}/gates`)
    const receiveTask = gates.body.gates.find((item: any) => item.status === 'pending')
    assert.equal(receiveTask.stageId, 'receive')
    assert.equal((await decide(app, receiveTask, 'approved')).status, 200)

    await app.request('POST', `/api/pipelines/${PIPELINE_ID}/run`)
    await app.settle()
    const designNotYet = await app.request('GET', `/api/pipelines/${PIPELINE_ID}/stages/design/artifact`)
    assert.equal(designNotYet.status, 404, 'design 还没跑')
    const analyzeBefore = await app.request('GET', `/api/pipelines/${PIPELINE_ID}/stages/analyze/artifact`)
    assert.deepEqual(analyzeBefore.body.content, { stage: 'analyze', call: 2 })

    // 打回 analyze：必须带非空说明（store 层强制）。
    gates = await app.request('GET', `/api/pipelines/${PIPELINE_ID}/gates`)
    const analyzeTask = gates.body.gates.find((item: any) => item.status === 'pending')
    assert.equal(analyzeTask.stageId, 'analyze')
    const noNote = await decide(app, analyzeTask, 'changes-needed')
    assert.equal(noNote.status, 400, `changes-needed 缺少 note 必须被拒：${JSON.stringify(noNote.body)}`)
    assert.equal(noNote.body.error.code, 'invalid-request')
    // 被拒的请求不留副作用：任务仍是未决、未认领状态。
    const stillPending = (await app.request('GET', `/api/pipelines/${PIPELINE_ID}/gates`))
      .body.gates.find((item: any) => item.gateTaskId === analyzeTask.gateTaskId)
    assert.equal(stillPending.status, 'pending')
    assert.equal(stillPending.claimedBy, undefined)
    assert.equal((await decide(app, analyzeTask, 'changes-needed', '边界条件缺失')).status, 200)

    // 再次触发：analyze 重跑（新 call），receive 不动。
    await app.request('POST', `/api/pipelines/${PIPELINE_ID}/run`)
    const view = await app.settle()
    assert.equal(view.status, 'waiting-human')
    const analyzeAfter = await app.request('GET', `/api/pipelines/${PIPELINE_ID}/stages/analyze/artifact`)
    assert.deepEqual(analyzeAfter.body.content, { stage: 'analyze', call: 3 })
    assert.notEqual(analyzeAfter.body.digest, analyzeBefore.body.digest)
    const receiveAfter = await app.request('GET', `/api/pipelines/${PIPELINE_ID}/stages/receive/artifact`)
    assert.deepEqual(receiveAfter.body.content, { stage: 'receive', call: 1 }, 'receive 不得被连带重跑')

    // 旧裁决（changes-needed）已被消费，不会再次命中同一条而空转。
    gates = await app.request('GET', `/api/pipelines/${PIPELINE_ID}/gates`)
    const oldAnalyze = gates.body.gates.filter((item: any) => item.stageId === 'analyze')
    assert.equal(oldAnalyze.length, 2, '打回后应新开一条门任务')
    assert.equal(typeof oldAnalyze.find((item: any) => item.decision?.action === 'changes-needed').consumedAt, 'number')
    assert.equal(oldAnalyze.find((item: any) => item.status === 'pending').gateTaskId !== analyzeTask.gateTaskId, true)
  })
})

// ── 验收 6：进程重启后从 checkpoint 继续 ─────────────────────────────────────

test('验收6：杀掉 server 进程再拉起，仍能从检查点与门任务继续', async () => {
  const app = await WebApp.create()
  try {
    await app.start()
    const task = await openFirstGate(app)
    const before = await app.request('GET', `/api/pipelines/${PIPELINE_ID}`)
    assert.equal(before.body.status, 'waiting-human')
    const beforeDigest = before.body.stages[0].digest

    // 真实重启：进程被杀，进程内 registry 与配置缓存全部丢失。
    await app.restart()

    const after = await app.request('GET', `/api/pipelines/${PIPELINE_ID}`)
    assert.equal(after.status, 200)
    assert.equal(after.body.status, 'waiting-human', '状态由持久化事实重建，不因重启丢失')
    assert.equal(after.body.openGateTaskId, task.gateTaskId, '重启后仍指向同一条待裁决任务')
    assert.equal(after.body.stages[0].digest, beforeDigest)
    assert.equal(after.body.running, false, '重启后本进程没有任何后台运行')

    // 恢复扫描：裁决未下 → 只报告 await-human，不替人裁决也不启动。
    const recovered = await app.request('POST', '/api/admin/recover')
    assert.deepEqual(recovered.body.outcomes, [
      { pipelineId: PIPELINE_ID, action: 'await-human', status: 'waiting-human', started: false, detail: null },
    ])

    // 裁决后重启过的进程能续跑：receive 不重生成，前进到 analyze。
    const gates = await app.request('GET', `/api/pipelines/${PIPELINE_ID}/gates`)
    const pending = gates.body.gates.find((item: any) => item.status === 'pending')
    assert.equal((await decide(app, pending, 'approved')).status, 200)

    const recoveredAgain = await app.request('POST', '/api/admin/recover')
    assert.deepEqual(recoveredAgain.body.outcomes, [
      { pipelineId: PIPELINE_ID, action: 'resume', status: 'waiting-human', started: true, detail: null },
    ])
    const view = await app.settle()
    assert.equal(view.status, 'waiting-human')
    const receiveAfter = await app.request('GET', `/api/pipelines/${PIPELINE_ID}/stages/receive/artifact`)
    assert.equal(receiveAfter.body.digest, beforeDigest, '重启 + 续跑都不得重生成已批准产物')
    assert.deepEqual(await app.spawns(), ['receive 1', 'analyze 2'])
  } finally {
    await app.stop()
    await rm(app.dir, { recursive: true, force: true })
  }
})

// ── 验收 7：execute 没有 targetBaseUrl 时明确失败，不伪造执行记录 ─────────────

test('验收7：execute 缺少真实执行数据时门禁失败，不出现伪造的执行记录', async () => {
  // 给 execute 配上执行-产物对账规则（R4-08）：没有 executor 自产的记录即 BLOCKING。
  await withApp(async app => {
    await createPipeline(app)
    // 前三个阶段正常批准到 execute。
    for (const stageId of ['receive', 'analyze', 'design']) {
      await app.request('POST', `/api/pipelines/${PIPELINE_ID}/run`)
      const view = await app.settle()
      assert.equal(view.status, 'waiting-human', `期望停在 ${stageId} 人工门`)
      const gates = await app.request('GET', `/api/pipelines/${PIPELINE_ID}/gates`)
      const task = gates.body.gates.find((item: any) => item.status === 'pending')
      assert.equal(task.stageId, stageId)
      assert.equal((await decide(app, task, 'approved')).status, 200)
    }

    // 触发 execute：机器门禁必须拦下"没有执行数据"的产物。
    await app.request('POST', `/api/pipelines/${PIPELINE_ID}/run`)
    const view = await app.settle()
    assert.equal(view.status, 'gate-failed')
    assert.equal(view.failure.kind, 'gate-failed')
    assert.equal(view.failure.stageId, 'execute')
    assert.match(view.failure.detail, /R4-08/)

    const execute = view.stages.find((stage: any) => stage.stageId === 'execute')
    assert.equal(execute.status, 'gate-failed')
    assert.equal(execute.machineStatus, 'failed')
    assert.deepEqual(execute.machineViolations.map((violation: any) => violation.rule), ['R4-08'])
    assert.equal(execute.machineViolations[0].level, 'BLOCKING')
    assert.match(execute.machineViolations[0].detail, /executor/)

    // 绝不出现"待执行"被当成通过：report / archive 不得推进。
    assert.equal(view.stages.find((stage: any) => stage.stageId === 'report').status, 'idle')
    assert.equal(view.stages.find((stage: any) => stage.stageId === 'archive').status, 'idle')
    // 门禁失败会为该阶段开一条 **gate-failed 升级任务**（供人查看违规清单），但它
    // 不对应任何产物（`artifactPath` 为空）、`machineStatus` 为 failed，因此不满足
    // `PersistentHumanGate.findResumableTask` 的匹配条件（要求 machineStatus=passed
    // 且 artifactPath 与产物一致），**永远不可能被误当阶段门批准**。
    // 这里断言的是"不存在可批准的 execute 阶段门"，而不是"一条任务都没有"——
    // 后者与 `gateFailed` 的设计（升级给人看）相反。
    const gates = await app.request('GET', `/api/pipelines/${PIPELINE_ID}/gates`)
    const executeTasks = gates.body.gates.filter((item: any) => item.stageId === 'execute')
    assert.equal(executeTasks.length, 1, '门禁失败应开一条升级任务，且只有一条')
    assert.equal(executeTasks[0].machineStatus, 'failed')
    assert.equal(executeTasks[0].artifactPath, '')
    assert.equal(executeTasks[0].status, 'pending')
    assert.equal(
      executeTasks.some((item: any) => item.machineStatus === 'passed'),
      false,
      '不存在可被当阶段门批准的 execute 任务',
    )
  }, {
    stages: Object.fromEntries(
      ['receive', 'analyze', 'design', 'execute', 'report', 'archive'].map(id => [
        id,
        { rules: id === 'execute' ? ['R4-08'] : [], review: { enabled: false } },
      ]),
    ),
  })
})

// ── 验收 8：Web 与 CLI 读取同一 dataRoot 时看到同一份事实 ─────────────────────

test('验收8：Web 与 CLI 读同一 dataRoot，看到同一检查点、产物与门任务', async () => {
  await withApp(async app => {
    const task = await openFirstGate(app)

    // 用真实 CLI（同一 dataRoot + 同一配置）读状态。
    const statusAtGate = await cliJson(app, 'status')
    const viewAtGate = await app.request('GET', `/api/pipelines/${PIPELINE_ID}`)

    // 检查点：标量字段与阶段状态逐字段一致。
    assert.equal(statusAtGate.cursor, viewAtGate.body.cursor)
    assert.equal(statusAtGate.templateVersion, viewAtGate.body.templateVersion)
    assert.equal(statusAtGate.rulesetVersion, viewAtGate.body.rulesetVersion)
    for (const stage of viewAtGate.body.stages) {
      assert.equal(statusAtGate.stages[stage.stageId].status, stage.status, `${stage.stageId} 状态不一致`)
    }
    assert.equal(statusAtGate.stages.receive.status, 'awaiting-gate')

    // digest 的两种口径——这不是"放宽断言"，而是把两侧各自的事实都钉死：
    // driver 只在阶段推进到 `done` 时才把 digest 冻结进检查点（`src/driver.ts` 第 4 步），
    // 停在人工门期间 `StageState.digest` 是空串；Web 视图按 docs/10 §4.2 M0-3
    // 从产物库回读，因此 `awaiting-gate` 阶段两侧**本就不该相等**。
    assert.equal(statusAtGate.stages.receive.digest, '', '停在人工门时检查点尚未冻结 digest')
    for (const stage of viewAtGate.body.stages.filter((item: any) => item.status === 'idle')) {
      assert.equal(statusAtGate.stages[stage.stageId].digest, '', `${stage.stageId} 未产出时两侧 digest 都应为空`)
      assert.equal(stage.digest, '', `${stage.stageId} 未产出时视图 digest 也应为空`)
    }

    // 产物：测试独立重算磁盘上那份产物的摘要（不经 HTTP、不复用服务端的派生逻辑），
    // 证明 Web 回读的摘要确实就是那份产物的摘要，而不是另算的一个值。
    const artifact = await app.request('GET', `/api/pipelines/${PIPELINE_ID}/stages/receive/artifact`)
    assert.equal(artifact.status, 200)
    const roots = resolvePlatformRoots(app.dir, baseConfig())
    const onDisk = JSON.parse(await readFile(join(roots.artifactsRoot, artifact.body.artifactPath), 'utf8'))
    assert.equal(
      onDisk.digest,
      computeArtifactDigest({
        content: onDisk.content,
        inputs: onDisk.inputs,
        pipelineId: onDisk.pipelineId,
        stageId: onDisk.stageId,
        version: onDisk.version,
      }),
      '磁盘上的产物摘要必须能被独立重算出来',
    )
    assert.equal(artifact.body.digest, onDisk.digest)
    const receiveAtGate = viewAtGate.body.stages.find((stage: any) => stage.stageId === 'receive')
    assert.equal(receiveAtGate.digest, artifact.body.digest)

    // 门任务：CLI 的 gate-list 与 Web 的 gates 接口必须是同一批任务。
    const cliGateList = await cliJson(app, 'gate-list')
    const webGates = await app.request('GET', `/api/pipelines/${PIPELINE_ID}/gates`)
    assert.equal(cliGateList.count, webGates.body.gates.length)
    assert.deepEqual(
      cliGateList.tasks.map((item: any) => item.gateTaskId),
      webGates.body.gates.map((item: any) => item.gateTaskId),
    )
    assert.equal(cliGateList.tasks[0].gateTaskId, task.gateTaskId)

    // 批准后 receive 推进到 `done`：检查点 digest 被冻结，此时两侧必须逐字相同
    // ——这才是「同一检查点」在 digest 上的真正断言。
    assert.equal((await decide(app, task, 'approved')).status, 200)
    await app.request('POST', `/api/pipelines/${PIPELINE_ID}/run`)
    const viewAfter = await app.settle()
    assert.equal(viewAfter.status, 'waiting-human')
    const receiveAfter = viewAfter.stages.find((stage: any) => stage.stageId === 'receive')
    assert.equal(receiveAfter.status, 'done')
    assert.equal(receiveAfter.digest, artifact.body.digest, '冻结进检查点的正是那份已批准产物的摘要')
    const statusAfter = await cliJson(app, 'status')
    assert.equal(statusAfter.stages.receive.digest, receiveAfter.digest, '已冻结的 digest 两侧必须逐字一致')
  })
})

// ── 支撑性断言：凭据边界与越权 ───────────────────────────────────────────────

test('鉴权入口：默认不信任请求头，伪造身份头不产生任何提权', async () => {
  await withApp(async app => {
    await createPipeline(app)
    const health = await app.request('GET', '/health')
    assert.equal(health.body.trustActorHeaders, false)

    // 伪造的身份头被忽略：审计里的 actor 仍是服务端配置身份。
    const task = await openFirstGate(app)
    const response = await fetch(`${app.baseUrl}/api/gates/${task.gateTaskId}/claim`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-actor-id': 'mallory', 'x-actor-roles': 'admin' },
      body: JSON.stringify({ pipelineId: PIPELINE_ID }),
    })
    assert.equal(response.status, 200)
    const claimed = await response.json()
    assert.equal(claimed.claimedBy, 'e2e-operator')
  })
})

test('错误映射：configRef 白名单、未知流水线 404、非法裁决 400、未知阶段 400', async () => {
  await withApp(async app => {
    // configRef 是服务端配置，浏览器传路径不能让它去读任意文件。
    const traversal = await app.request('POST', `/api/projects/${PROJECT_ID}/pipelines`, {
      pipelineId: PIPELINE_ID,
      configRef: '../../etc/passwd',
    })
    assert.equal(traversal.status, 400)
    assert.equal(traversal.body.error.code, 'invalid-request')

    const missing = await app.request('GET', '/api/pipelines/never-created')
    assert.equal(missing.status, 404)
    assert.equal(missing.body.error.code, 'not-found')

    await createPipeline(app)
    const noAction = await app.request('POST', '/api/gates/whatever/decide', { pipelineId: PIPELINE_ID })
    assert.equal(noAction.status, 400)
    assert.match(noAction.body.error.message, /action 必填/)

    const badStage = await app.request('GET', `/api/pipelines/${PIPELINE_ID}/stages/not-a-stage/artifact`)
    assert.equal(badStage.status, 400)
    assert.equal(badStage.body.error.code, 'invalid-request')

    // 跨流水线裁决：任务不属于该 pipelineId 一律拒绝。
    const task = await openFirstGate(app)
    const cross = await app.request('POST', `/api/gates/${task.gateTaskId}/decide`, {
      pipelineId: 'other-pipeline', action: 'approved',
    })
    assert.equal(cross.status, 404, '未登记的 other-pipeline 先被 not-found 拦下')
    assert.equal(cross.body.error.code, 'not-found')
  })
})
