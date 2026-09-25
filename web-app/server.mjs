/**
 * 通用测试辅助平台的 Web HTTP 外壳（docs/10 §5.1、§5.3、§5.4）。
 *
 * 本文件**只做三件事**：HTTP 路由、鉴权入口、响应映射。
 *
 * 流水线逻辑一律经
 * `FilePipelineRunService` → `createPlatformHost` → `PipelineDriver`
 * 完成。相对改造前（docs/10 §5.1）明确移除了：
 *
 * - `runs = new Map()` 作为唯一状态 → 事实来自检查点/产物/门任务，进程内只留后台句柄；
 * - `promptFor()` 自建六阶段 prompt → 阶段 prompt 属 platform-pipeline；
 * - `callModel()` 自建模型请求 → 由 `OpenAICompatibleClient` 按配置 provider 发起；
 * - `runPipeline()` 自己串阶段、自己生成 archive → 由 `PipelineDriver` 执行；
 * - Web 自己把 execute 标成"待执行" → 由 execute 阶段门禁对账真实执行记录；
 * - Web 自己维护 artifact 数组 → 由 `ArtifactStore` 回读。
 *
 * 凭据策略（docs/10 §2.2、§5.3）：API Key **只**由服务端按配置里的 `apiKeyEnv`
 * 从进程环境变量注入。浏览器既不上传、也无法读取任何 provider 凭据；
 * `configRef` 也由服务端配置决定，浏览器不能借它指向任意文件。
 *
 * @module harness-web-app/server
 */

import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { extname, join, normalize, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { loadPipelineConfig } from '../packages/platform-pipeline/src/config.ts'
import {
  AsyncPipelineRunner,
  FilePipelineRunService,
  PipelineRunError,
  errorMessageOf,
  redactSecrets,
} from '../packages/platform-pipeline/src/web/index.ts'

const ROOT = fileURLToPath(new URL('.', import.meta.url))
const PUBLIC_DIR = join(ROOT, 'public')

// ── 服务端配置（全部来自环境变量；浏览器不可覆盖）────────────────────────────

const PORT = Number(process.env.PORT || 3080)
const HOST = process.env.HOST || '127.0.0.1'
const MAX_BODY = Number(process.env.PLATFORM_MAX_BODY || 64 * 1024)

/** 平台数据根：检查点、产物、门任务、知识库都落在这里。**必填**。 */
const DATA_ROOT = requireEnv('PLATFORM_DATA_ROOT')
/** 流水线配置文件路径。**必填**：API Key 的 `apiKeyEnv` 就声明在这份配置里。 */
const CONFIG_PATH = requireEnv('PLATFORM_CONFIG_PATH')
/**
 * 客户端必须使用的逻辑配置引用（docs/10 §5.3）。
 *
 * 浏览器传的是**逻辑名**而不是路径：服务端把它映射到 {@link CONFIG_PATH}。
 * 因此改配置指向不需要（也不能）由浏览器决定，路径穿越在类型上就不成立。
 */
const CONFIG_REF = process.env.PLATFORM_CONFIG_REF || 'default'

/** 人工门等待上限；缺省 `0` = 只轮询一次就让出控制权，HTTP 不挂住等真人（§5.4）。 */
const GATE_WAIT_TIMEOUT_MS = Number(process.env.PLATFORM_GATE_WAIT_TIMEOUT_MS || 0)
const GATE_TASK_TTL_MS = optionalNumber(process.env.PLATFORM_GATE_TASK_TTL_MS)

/**
 * 是否信任请求头里的调用者身份。
 *
 * **默认关闭**：此时所有请求都用服务端配置的固定身份（见 {@link SERVER_ACTOR}），
 * 客户端无法通过伪造请求头提权。只有在反向代理已完成真实鉴权、并会**剥除**
 * 客户端自带的同名头时才应开启。
 */
const TRUST_ACTOR_HEADERS = process.env.PLATFORM_TRUST_ACTOR_HEADERS === '1'

/** 单操作者模式下使用的身份（默认只有 viewer：不能裁决人工门）。 */
const SERVER_ACTOR = {
  actorId: process.env.PLATFORM_ACTOR_ID || 'web-operator',
  ...(process.env.PLATFORM_ACTOR_TENANT ? { tenantId: process.env.PLATFORM_ACTOR_TENANT } : {}),
  roles: splitList(process.env.PLATFORM_ACTOR_ROLES, ['viewer']),
  ...(process.env.PLATFORM_ACTOR_PROJECTS ? { projectIds: splitList(process.env.PLATFORM_ACTOR_PROJECTS, []) } : {}),
}

/**
 * 后台运行身份：**刻意不声明任何角色**。
 *
 * 后台运行只驱动流水线，不参与人工门裁决。`assertGateRole` 是失败关闭的，
 * 因此这个身份即使被误用到裁决路径上也批准不了任何东西（"后台不得替人裁决"
 * 的机器保证，docs/10 §1 原则）。
 */
const RUNNER_ACTOR = { actorId: process.env.PLATFORM_RUNNER_ACTOR_ID || 'web-runner' }

function requireEnv(name) {
  const value = process.env[name]
  if (value === undefined || value.trim() === '') {
    throw new Error(`缺少必需的环境变量 ${name}（Web 外壳不做隐式兜底）`)
  }
  return value
}

function optionalNumber(raw) {
  if (raw === undefined || raw.trim() === '') return undefined
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`环境变量必须是非负整数：${raw}`)
  return value
}

function splitList(raw, fallback) {
  if (raw === undefined || raw.trim() === '') return fallback
  return raw.split(',').map(item => item.trim()).filter(item => item !== '')
}

// ── 装配：service + 后台运行调度 ─────────────────────────────────────────────

/**
 * 逻辑 `configRef` → 实际配置路径。
 *
 * 只接受服务端配置的那一个引用：`configRef` 来自请求体，若直接当路径用就成了
 * 任意文件读取（浏览器可以让服务端去解析 `/etc/passwd` 之类）。因此这里做白名单，
 * 不匹配即 `config-invalid`。
 */
async function loadConfig(configRef) {
  if (configRef !== CONFIG_REF) {
    throw new Error(`未知的 configRef：${configRef}（本服务只接受 ${CONFIG_REF}）`)
  }
  return loadPipelineConfig(CONFIG_PATH)
}

/**
 * 宿主工厂。默认用真实 `createPlatformHost`；`PLATFORM_HOST_MODULE` 指向一个
 * 导出 `createHost(options)` 的模块时改用它。
 *
 * 存在的唯一理由是**测试**：端到端测试需要把 LLM 阶段运行器换成脚本化实现，
 * 才能在不消耗 API Key 的前提下验证路由、鉴权、持久化与恢复语义。
 */
async function loadHostFactory() {
  const modulePath = process.env.PLATFORM_HOST_MODULE
  if (modulePath === undefined || modulePath.trim() === '') return undefined
  const loaded = await import(pathToFileURL(resolve(modulePath)).href)
  if (typeof loaded.createHost !== 'function') {
    throw new Error(`PLATFORM_HOST_MODULE 必须导出 createHost(options)：${modulePath}`)
  }
  return loaded.createHost
}

const createHost = await loadHostFactory()

// 启动即加载配置：配置非法要在启动时失败，而不是等第一个请求才 500。
await loadConfig(CONFIG_REF)

const service = new FilePipelineRunService({
  dataRoot: DATA_ROOT,
  loadConfig,
  ...(createHost === undefined ? {} : { createHost }),
  defaultGateWaitTimeoutMs: GATE_WAIT_TIMEOUT_MS,
  ...(GATE_TASK_TTL_MS === undefined ? {} : { defaultGateTaskTtlMs: GATE_TASK_TTL_MS }),
})

const runner = new AsyncPipelineRunner({
  service,
  dataRoot: DATA_ROOT,
  actor: RUNNER_ACTOR,
  /**
   * 后台运行收敛后的**运维日志**。
   *
   * 刻意只打日志、不落盘、也不进 HTTP 响应：运行期异常不写检查点，因此它不是
   * 持久化事实，若暴露给页面就会被当成"流水线状态"。阶段级失败（门禁违规、审核
   * findings）本来就由检查点持久化、经 `GET /api/pipelines/:id` 呈现；
   * 权威的运行遥测属于 M3（docs/10 §7）。
   */
  onSettled: outcome => {
    if (outcome.kind === 'error') {
      console.error(`[pipeline ${outcome.pipelineId}] 运行前置失败 ${outcome.error.code}: ${outcome.error.message}`)
      return
    }
    const { outcome: kind } = outcome.result
    console.log(`[pipeline ${outcome.pipelineId}] 后台运行结束：${kind}`)
  },
})

// ── HTTP 基础设施 ────────────────────────────────────────────────────────────

function json(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'referrer-policy': 'no-referrer',
  })
  res.end(body)
}

function pathnameOf(req) {
  try {
    return new URL(req.url || '/', 'http://localhost').pathname
  } catch {
    throw new PipelineRunError('invalid-request', '无效的请求地址')
  }
}

function queryOf(req) {
  try {
    return new URL(req.url || '/', 'http://localhost').searchParams
  } catch {
    return new URLSearchParams()
  }
}

async function readJsonBody(req) {
  const declared = Number(req.headers['content-length'] || 0)
  if (declared > MAX_BODY) throw new PipelineRunError('invalid-request', '请求体过大')
  let size = 0
  const chunks = []
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY) throw new PipelineRunError('invalid-request', '请求体过大')
    chunks.push(chunk)
  }
  const raw = Buffer.concat(chunks).toString('utf8').trim()
  if (raw === '') return {}
  try {
    const parsed = JSON.parse(raw)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('请求体必须是 JSON 对象')
    }
    return parsed
  } catch (error) {
    throw new PipelineRunError('invalid-request', `请求体不是合法 JSON 对象：${errorMessageOf(error)}`)
  }
}

function optionalString(value, field) {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') throw new PipelineRunError('invalid-request', `${field} 必须是字符串`)
  return value
}

function requiredString(value, field) {
  const parsed = optionalString(value, field)
  if (parsed === undefined || parsed.trim() === '') {
    throw new PipelineRunError('invalid-request', `${field} 必填`)
  }
  return parsed
}

/**
 * 解析调用者身份（**鉴权入口**，docs/10 §5.3）。
 *
 * 默认返回服务端固定身份，完全忽略客户端请求头；只有显式开启
 * `PLATFORM_TRUST_ACTOR_HEADERS=1` 时才读取请求头（此时必须由反向代理
 * 完成真实鉴权并剥除同名头）。**失败关闭**：开启后若缺 `x-actor-id` 直接 401。
 */
function actorOf(req) {
  if (!TRUST_ACTOR_HEADERS) return SERVER_ACTOR
  const actorId = req.headers['x-actor-id']
  if (typeof actorId !== 'string' || actorId.trim() === '') {
    throw new PipelineRunError('unauthenticated', '缺少 x-actor-id（已开启 PLATFORM_TRUST_ACTOR_HEADERS）')
  }
  const tenant = req.headers['x-actor-tenant']
  const roles = req.headers['x-actor-roles']
  const projects = req.headers['x-actor-projects']
  return {
    actorId: actorId.trim(),
    ...(typeof tenant === 'string' && tenant.trim() !== '' ? { tenantId: tenant.trim() } : {}),
    roles: typeof roles === 'string' ? splitList(roles, []) : [],
    ...(typeof projects === 'string' && projects.trim() !== ''
      ? { projectIds: splitList(projects, []) }
      : {}),
  }
}

// ── 路由 ─────────────────────────────────────────────────────────────────────

/**
 * 路由表：`方法 + 正则` → 处理器。正则捕获组按顺序传给处理器。
 *
 * 处理器只做参数解析与响应映射；一切业务判定都在 service 内，因此
 * 「HTTP 又写了一套流水线」在结构上不可能发生（docs/10 §5.2）。
 */
const ROUTES = [
  ['GET', /^\/api\/pipelines$/, async (req, res) => {
    json(res, 200, { pipelines: await service.list(actorOf(req)) })
  }],

  ['POST', /^\/api\/projects\/([^/]+)\/pipelines$/, async (req, res, projectId) => {
    const body = await readJsonBody(req)
    const configRef = optionalString(body.configRef, 'configRef') ?? CONFIG_REF
    if (configRef !== CONFIG_REF) {
      throw new PipelineRunError('invalid-request', `本服务只接受 configRef=${CONFIG_REF}`, { got: configRef })
    }
    const summary = await service.create({
      projectId,
      pipelineId: requiredString(body.pipelineId, 'pipelineId'),
      configRef: CONFIG_REF,
      ...optionalFields(body, ['requirementInput', 'providerName', 'targetBaseUrl', 'rulesetVersion']),
      ...optionalNumbers(body, ['maxGateRetries', 'gateWaitTimeoutMs', 'gateTaskTtlMs']),
      ...(Array.isArray(body.diagCredentials) ? { diagCredentials: body.diagCredentials } : {}),
    }, actorOf(req))
    // docs/10 §5.3：创建后返回 202 与流水线标识，不等待整条流水线完成。
    json(res, 202, summary)
  }],

  ['POST', /^\/api\/pipelines\/([^/]+)\/run$/, async (req, res, pipelineId) => {
    // 后台运行：立刻返回 202，不等人工裁决（docs/10 §5.4）。
    // 用调用者自己的身份驱动运行，使后台运行与审计对象一致。
    const trigger = await runner.trigger(pipelineId, actorOf(req))
    json(res, 202, {
      pipelineId,
      started: trigger.started,
      reason: trigger.reason,
      running: runner.isRunning(pipelineId),
    })
  }],

  ['POST', /^\/api\/pipelines\/([^/]+)\/cancel$/, async (req, res, pipelineId) => {
    // 先确认调用者有权看这条流水线，再取消（否则等于把取消变成探测接口）。
    await service.get(pipelineId, actorOf(req))
    json(res, 202, { pipelineId, cancelled: runner.cancel(pipelineId, 'cancelled via web api') })
  }],

  ['GET', /^\/api\/pipelines\/([^/]+)\/gates$/, async (req, res, pipelineId) => {
    const status = queryOf(req).get('status') ?? undefined
    json(res, 200, {
      gates: await service.listGateTasks({
        pipelineId,
        ...(status === null || status === undefined ? {} : { status }),
      }, actorOf(req)),
    })
  }],

  ['GET', /^\/api\/pipelines\/([^/]+)\/events$/, async (req, res, pipelineId) => {
    json(res, 200, { events: await service.listEvents(pipelineId, actorOf(req)) })
  }],

  ['GET', /^\/api\/pipelines\/([^/]+)\/usage$/, async (req, res, pipelineId) => {
    // 用量与预算（docs/10 §7.3）：事实来自持久化用量日志 + 检查点重试事实，
    // 因此 Web 与 CLI 对同一条流水线给出一致的 used/limit/exceeded。
    json(res, 200, await service.getUsage(pipelineId, actorOf(req)))
  }],

  ['GET', /^\/api\/pipelines\/([^/]+)\/stages\/([^/]+)\/artifact$/, async (req, res, pipelineId, stageId) => {
    const artifact = await service.getStageArtifact(pipelineId, stageId, actorOf(req))
    if (artifact === null) {
      // 尚未产出：404 而不是空对象——空对象会被页面当成"产物存在但内容为空"。
      json(res, 404, { error: `阶段 ${stageId} 尚无产物` })
      return
    }
    json(res, 200, artifact)
  }],

  ['POST', /^\/api\/pipelines\/([^/]+)\/reenter$/, async (req, res, pipelineId) => {
    const body = await readJsonBody(req)
    const checkpoint = await service.reenter({
      pipelineId,
      stageId: requiredString(body.stageId, 'stageId'),
      reason: requiredString(body.reason, 'reason'),
      ...optionalFields(body, ['expectedCurrentDigest']),
    }, actorOf(req))
    json(res, 202, {
      pipelineId: checkpoint.pipelineId,
      cursor: checkpoint.cursor,
      reentries: checkpoint.reentries,
    })
  }],

  ['GET', /^\/api\/pipelines\/([^/]+)$/, async (req, res, pipelineId) => {
    const view = await service.get(pipelineId, actorOf(req))
    json(res, 200, { ...view, running: runner.isRunning(pipelineId) })
  }],

  ['POST', /^\/api\/gates\/([^/]+)\/claim$/, async (req, res, gateTaskId) => {
    const body = await readJsonBody(req)
    json(res, 200, await service.claimGate({
      pipelineId: requiredString(body.pipelineId, 'pipelineId'),
      gateTaskId,
      ...optionalNumbers(body, ['ttlMs']),
    }, actorOf(req)))
  }],

  ['POST', /^\/api\/gates\/([^/]+)\/decide$/, async (req, res, gateTaskId) => {
    const body = await readJsonBody(req)
    json(res, 200, await service.decideGate({
      pipelineId: requiredString(body.pipelineId, 'pipelineId'),
      gateTaskId,
      // action 必须显式传入：不存在"缺省即批准"（docs/10 §5.3）。
      action: requiredString(body.action, 'action'),
      // decisionId 由页面生成、重试沿用同一个：带上它以后重复投递会重放首次裁决结果，
      // 不会二次驱动门（docs/10 §6.3 M2-3、§6.4）。
      ...optionalFields(body, ['note', 'decisionId']),
      ...optionalNumbers(body, ['expectedUpdatedAt']),
    }, actorOf(req)))
  }],

  ['POST', /^\/api\/gates\/([^/]+)\/cancel$/, async (req, res, gateTaskId) => {
    const body = await readJsonBody(req)
    json(res, 200, await service.cancelGate({
      pipelineId: requiredString(body.pipelineId, 'pipelineId'),
      gateTaskId,
      ...optionalFields(body, ['note']),
    }, actorOf(req)))
  }],

  ['POST', /^\/api\/admin\/recover$/, async (req, res) => {
    // docs/10 §5.4 第 7 步：进程重启后扫描 running/awaiting-gate 并恢复或标记可重入。
    json(res, 200, { outcomes: await runner.recover() })
  }],
]

/** 只挑出请求体里出现过的可选字符串字段（避免把 `undefined` 显式写进对象）。 */
function optionalFields(body, names) {
  const out = {}
  for (const name of names) {
    const value = optionalString(body[name], name)
    if (value !== undefined) out[name] = value
  }
  return out
}

function optionalNumbers(body, names) {
  const out = {}
  for (const name of names) {
    const raw = body[name]
    if (raw === undefined || raw === null) continue
    if (!Number.isSafeInteger(raw) || raw < 0) {
      throw new PipelineRunError('invalid-request', `${name} 必须是非负整数`)
    }
    out[name] = raw
  }
  return out
}

// ── 静态资源 ─────────────────────────────────────────────────────────────────

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
}

async function serveStatic(req, res, pathname) {
  const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '')
  const target = normalize(join(PUBLIC_DIR, relative))
  // 路径穿越防护：静态目录之外一律 403。
  if (target !== PUBLIC_DIR && !target.startsWith(PUBLIC_DIR + sep)) {
    return json(res, 403, { error: 'forbidden' })
  }
  try {
    const body = await readFile(target)
    res.writeHead(200, {
      'content-type': CONTENT_TYPES[extname(target)] || 'application/octet-stream',
      'cache-control': 'no-cache',
      'x-content-type-options': 'nosniff',
      'x-frame-options': 'DENY',
      'referrer-policy': 'no-referrer',
      'content-security-policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'",
    })
    res.end(body)
  } catch {
    json(res, 404, { error: 'not found' })
  }
}

// ── 服务器 ───────────────────────────────────────────────────────────────────

const server = createServer(async (req, res) => {
  let pathname = '/'
  try {
    pathname = pathnameOf(req)
    if (req.method === 'GET' && pathname === '/health') {
      // 只回显可公开的运行时事实；不回显 dataRoot / configPath（不泄露部署布局）。
      return json(res, 200, {
        ok: true,
        app: 'harness-web-app',
        configRef: CONFIG_REF,
        trustActorHeaders: TRUST_ACTOR_HEADERS,
        running: runner.runningIds(),
      })
    }

    for (const [method, pattern, handler] of ROUTES) {
      if (req.method !== method) continue
      const match = pattern.exec(pathname)
      if (match === null) continue
      return await handler(req, res, ...match.slice(1).map(decodeURIComponent))
    }

    if (req.method === 'GET') return await serveStatic(req, res, pathname)
    return json(res, 405, { error: 'method not allowed' })
  } catch (error) {
    // 错误映射：`PipelineRunError` 自带 HTTP 状态；未知异常一律 500，绝不降级成 200。
    const mapped = error instanceof PipelineRunError
      ? error
      : new PipelineRunError('run-failed', errorMessageOf(error))
    // 错误详情经 redactSecrets 脱敏后再出网：凭据不进日志也不进响应（docs/10 §2.2）。
    return json(res, mapped.httpStatus, { error: redactSecrets(mapped.toView()) })
  }
})

server.listen(PORT, HOST, () => {
  // 只打印监听地址与逻辑配置引用，不打印 dataRoot / configPath / 任何凭据。
  console.log(`Harness Web listening at http://${HOST}:${PORT} (configRef=${CONFIG_REF}, trustActorHeaders=${TRUST_ACTOR_HEADERS})`)
})

function shutdown() {
  // 先中止后台运行，再关连接：避免运行中的流水线被硬切断而留下半写状态。
  runner.shutdown('server shutting down')
  server.close(() => process.exit(0))
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
