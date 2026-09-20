import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { isIP } from 'node:net'
import { lookup } from 'node:dns/promises'
import { extname, join, normalize, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('.', import.meta.url))
const PUBLIC_DIR = join(ROOT, 'public')
const PORT = Number(process.env.PORT || 3080)
const HOST = process.env.HOST || '127.0.0.1'
const MAX_BODY = 64 * 1024
const MAX_REQUIREMENT = 20_000
const MAX_RUNS = 24
const RUN_TTL_MS = 30 * 60 * 1000
const MAX_ACTIVE_RUNS_PER_IP = 2
const MAX_PROMPT_CONTEXT = 48_000
const MODEL_TIMEOUT_MS = 180_000
const ALLOW_PRIVATE_API = process.env.ALLOW_PRIVATE_API === '1'
const runs = new Map()
const activeRunsByIp = new Map()

function cleanupRuns(now = Date.now()) {
  for (const [id, run] of runs) {
    const finishedAt = run.finishedAt ? Date.parse(run.finishedAt) : NaN
    if (Number.isFinite(finishedAt) && now - finishedAt > RUN_TTL_MS) runs.delete(id)
  }
  if (runs.size <= MAX_RUNS) return
  for (const [id, run] of runs) {
    if (!run.finishedAt) continue
    runs.delete(id)
    if (runs.size <= MAX_RUNS) break
  }
}

function activeRunCount(ip) {
  return activeRunsByIp.get(ip) ?? 0
}

function reserveRunSlot(ip) {
  const count = activeRunCount(ip)
  if (count >= MAX_ACTIVE_RUNS_PER_IP) {
    throw new Error('当前已有运行中的任务，请等待完成后再提交')
  }
  activeRunsByIp.set(ip, count + 1)
}

function releaseRunSlot(ip) {
  const next = activeRunCount(ip) - 1
  if (next > 0) activeRunsByIp.set(ip, next)
  else activeRunsByIp.delete(ip)
}

const STAGES = [
  { id: 'receive', label: '需求接收', short: 'RECEIVE' },
  { id: 'analyze', label: '需求分析', short: 'ANALYZE' },
  { id: 'design', label: '测试设计', short: 'DESIGN' },
  { id: 'execute', label: '测试执行', short: 'EXECUTE' },
  { id: 'report', label: '测试报告', short: 'REPORT' },
  { id: 'archive', label: '产物归档', short: 'ARCHIVE' },
]

const DEFAULTS = {
  baseUrl: 'https://api.deepseek.com',
  model: 'deepseek-chat',
  projectType: 'api-service',
}

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

function clientIp(req) {
  // Do not trust forwarded headers: this server may be run without a trusted proxy.
  return req.socket.remoteAddress || 'unknown'
}

function requestPath(req) {
  try {
    return new URL(req.url || '/', 'http://localhost').pathname
  } catch {
    throw new Error('无效的请求地址')
  }
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

function isPrivateAddress(address) {
  const normalized = address.toLowerCase()
  if (normalized === '::1' || normalized.startsWith('fc') || normalized.startsWith('fd') || normalized.startsWith('fe80:')) return true
  const parts = normalized.split('.').map(Number)
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false
  const [a, b] = parts
  return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || (a === 0)
}

async function safeBaseUrl(value) {
  const input = String(value || DEFAULTS.baseUrl).trim().replace(/\/+$/, '')
  const url = new URL(input)
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('API Base URL 必须使用 http 或 https')
  if (url.username || url.password) throw new Error('API Base URL 不能包含用户名或密码')
  if (!ALLOW_PRIVATE_API) {
    const hostname = url.hostname.toLowerCase()
    if (hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local') || hostname === '0.0.0.0') {
      throw new Error('出于安全考虑，默认不允许访问本机或内网 API；如确需使用，请设置 ALLOW_PRIVATE_API=1')
    }
    const address = isIP(hostname) ? hostname : (await lookup(hostname)).address
    if (isPrivateAddress(address)) {
      throw new Error('出于安全考虑，默认不允许访问本机或内网 API；如确需使用，请设置 ALLOW_PRIVATE_API=1')
    }
  }
  return input
}

function digest(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 16)
}

async function readBody(req) {
  let size = 0
  const chunks = []
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY) throw new Error('请求体过大，请压缩需求文本后重试')
    chunks.push(chunk)
  }
  const raw = Buffer.concat(chunks).toString('utf8')
  return raw ? JSON.parse(raw) : {}
}

function cleanText(value, fallback = '') {
  return typeof value === 'string' ? value.trim() : fallback
}

function makeStage(id, status = 'queued') {
  return { id, status, startedAt: null, finishedAt: null, digest: null, content: null, error: null }
}

async function createRun(input, ip) {
  cleanupRuns()
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('请求体必须是 JSON 对象')
  const apiKey = cleanText(input.apiKey)
  if (!apiKey) throw new Error('请先输入 API Key')
  if (apiKey.length > 512) throw new Error('API Key 长度异常，请检查是否粘贴了额外内容')
  const requirement = cleanText(input.requirement)
  if (!requirement) throw new Error('请填写待测试需求')
  if (requirement.length > MAX_REQUIREMENT) throw new Error(`需求文本不能超过 ${MAX_REQUIREMENT} 个字符`)
  const baseUrl = await safeBaseUrl(input.baseUrl)
  reserveRunSlot(ip)

  const run = {
    id: randomUUID(),
    createdAt: new Date().toISOString(),
    finishedAt: null,
    status: 'queued',
    clientIp: ip,
    projectName: cleanText(input.projectName, '未命名项目').slice(0, 80),
    projectType: cleanText(input.projectType, DEFAULTS.projectType),
    requirement,
    baseUrl,
    model: cleanText(input.model, DEFAULTS.model).slice(0, 160),
    stages: Object.fromEntries(STAGES.map(({ id }) => [id, makeStage(id)])),
    apiKey,
    artifacts: [],
    error: null,
  }
  runs.set(run.id, run)
  return run
}

function publicRun(run) {
  return {
    id: run.id,
    createdAt: run.createdAt,
    status: run.status,
    projectName: run.projectName,
    projectType: run.projectType,
    baseUrl: run.baseUrl,
    model: run.model,
    stages: run.stages,
    artifacts: run.artifacts,
    error: run.error,
  }
}

function promptFor(stageId, run, previous) {
  const upstream = previous.map((item) => `【${item.stageId}】\n${item.content}`).join('\n\n')
  const context = upstream
    ? `\n\n上游阶段产物（只读，必须保持事实一致）：\n${upstream.length > MAX_PROMPT_CONTEXT ? `${upstream.slice(0, MAX_PROMPT_CONTEXT)}\n\n[上游内容过长，后续内容已截断]` : upstream}`
    : ''
  const common = `你是测试辅助平台的 ${STAGES.find((stage) => stage.id === stageId)?.label || stageId} 专家。\n项目：${run.projectName}\n项目类型：${run.projectType}\n\n原始需求：\n${run.requirement}${context}`
  const instructions = {
    receive: `${common}\n\n请把原始需求整理成结构化需求摘要，明确目标、范围、验收标准、风险、未决问题。只输出 Markdown，不要编造需求中没有的业务事实。`,
    analyze: `${common}\n\n请分析需求的可测试性与风险：拆解功能点、边界条件、异常路径、依赖、优先级，并列出需要向产品或研发确认的问题。只输出 Markdown。`,
    design: `${common}\n\n请设计可执行测试方案。至少覆盖 happy path、校验失败、鉴权/权限、幂等性、并发或重试（适用时）。给出用例 ID、前置条件、步骤、期望结果和优先级。只输出 Markdown。`,
    execute: `${common}\n\n请根据测试用例生成本次执行计划与执行记录模板。由于当前 Web 版没有接入被测系统，不要声称真实请求已发送；明确标记为“待执行”，并给出每条用例的执行命令/请求建议、证据要求和通过判定。只输出 Markdown。`,
    report: `${common}\n\n请汇总上游结果形成测试报告草案：覆盖范围、风险、阻塞项、发布建议、证据索引和下一步动作。对无法真实执行的内容标记为“未执行”，不要虚构通过率。只输出 Markdown。`,
  }
  return instructions[stageId]
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function providerMessage(payload) {
  const message = payload?.error?.message || payload?.message
  return typeof message === 'string' && message.trim() ? message.trim().slice(0, 300) : '服务商未返回具体错误信息'
}

async function callModel(run, prompt) {
  const request = {
    method: 'POST',
    headers: {
      authorization: `Bearer ${run.apiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: run.model,
      messages: [
        { role: 'system', content: '你输出的是测试平台内部产物。优先准确、可审计、结构化；不要泄露 API Key。' },
        { role: 'user', content: prompt },
      ],
      temperature: 0.2,
      max_tokens: 4000,
    }),
    signal: AbortSignal.timeout(MODEL_TIMEOUT_MS),
  }
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const response = await fetch(`${run.baseUrl}/chat/completions`, request)
    const raw = await response.text()
    let payload
    try { payload = JSON.parse(raw) } catch { payload = null }
    if (response.ok) {
      const content = payload?.choices?.[0]?.message?.content
      if (Array.isArray(content)) return content.map((part) => part?.text || '').join('').trim()
      if (typeof content === 'string' && content.trim()) return content.trim()
      throw new Error('模型返回中没有可用文本，请检查模型名称或 API Base URL')
    }
    if (attempt === 0 && (response.status === 429 || response.status >= 500)) {
      await wait(800)
      continue
    }
    throw new Error(`模型请求失败（HTTP ${response.status}）：${providerMessage(payload)}`)
  }
  throw new Error('模型请求失败，请稍后重试')
}

async function runPipeline(run) {
  run.status = 'running'
  const previous = []
  try {
    for (const stage of STAGES.slice(0, -1)) {
      const state = run.stages[stage.id]
      state.status = 'running'
      state.startedAt = new Date().toISOString()
      const content = await callModel(run, promptFor(stage.id, run, previous))
      const artifact = {
        pipelineId: run.id,
        stageId: stage.id,
        version: 1,
        digest: digest({ stageId: stage.id, content }),
        content,
      }
      state.status = 'done'
      state.finishedAt = new Date().toISOString()
      state.digest = artifact.digest
      state.content = content
      previous.push(artifact)
      run.artifacts.push(artifact)
    }
    const archiveContent = `# 产物归档\n\n- Pipeline ID: ${run.id}\n- 项目：${run.projectName}\n- 模型：${run.model}\n- 产物数量：${run.artifacts.length}\n- 归档摘要：${run.artifacts.map((item) => `${item.stageId}=${item.digest}`).join('，')}\n\n> 本次归档只记录 Web 端生成的阶段产物。执行阶段未连接被测系统，因此不能将“待执行”标记为真实通过。`
    const archive = { pipelineId: run.id, stageId: 'archive', version: 1, digest: digest(archiveContent), content: archiveContent }
    const archiveState = run.stages.archive
    archiveState.status = 'done'
    archiveState.startedAt = new Date().toISOString()
    archiveState.finishedAt = new Date().toISOString()
    archiveState.digest = archive.digest
    archiveState.content = archive.content
    run.artifacts.push(archive)
    run.status = 'completed'
  } catch (error) {
    const active = Object.values(run.stages).find((stage) => stage.status === 'running')
    if (active) {
      active.status = 'failed'
      active.error = errorMessage(error)
      active.finishedAt = new Date().toISOString()
    }
    run.status = 'failed'
    run.error = errorMessage(error)
  } finally {
    // The key is needed only while the run is in flight. Never expose it via publicRun().
    run.apiKey = undefined
    run.finishedAt = new Date().toISOString()
    releaseRunSlot(run.clientIp)
    cleanupRuns()
  }
}

function contentType(path) {
  return {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
  }[extname(path)] || 'application/octet-stream'
}

async function serveStatic(req, res) {
  const requestPath = decodeURIComponent(new URL(req.url, 'http://localhost').pathname)
  const relative = requestPath === '/' ? 'index.html' : requestPath.replace(/^\/+/, '')
  const target = normalize(join(PUBLIC_DIR, relative))
  if (!target.startsWith(PUBLIC_DIR + sep)) return json(res, 403, { error: 'forbidden' })
  try {
    const body = await readFile(target)
    res.writeHead(200, {
      'content-type': contentType(target),
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

const server = createServer(async (req, res) => {
  try {
    const pathname = requestPath(req)
    if (req.method === 'GET' && pathname === '/health') return json(res, 200, { ok: true, app: 'harness-web-app' })
    if (req.method === 'POST' && pathname === '/api/runs') {
      if (!String(req.headers['content-type'] || '').toLowerCase().includes('application/json')) {
        return json(res, 415, { error: '请求必须使用 application/json' })
      }
      const declaredLength = Number(req.headers['content-length'] || 0)
      if (declaredLength > MAX_BODY) return json(res, 413, { error: '请求体过大，请压缩需求文本后重试' })
      const ip = clientIp(req)
      const input = await readBody(req)
      const run = await createRun(input, ip)
      void runPipeline(run)
      return json(res, 202, { runId: run.id })
    }
    if (req.method === 'GET' && pathname.startsWith('/api/runs/')) {
      cleanupRuns()
      const run = runs.get(pathname.slice('/api/runs/'.length))
      return run ? json(res, 200, publicRun(run)) : json(res, 404, { error: 'run not found' })
    }
    if (req.method === 'GET') return serveStatic(req, res)
    return json(res, 405, { error: 'method not allowed' })
  } catch (error) {
    const message = errorMessage(error)
    const status = message.includes('请求体过大') ? 413 : message.includes('API Key') || message.includes('需求文本') ? 422 : 400
    return json(res, status, { error: message })
  }
})

server.listen(PORT, HOST, () => {
  console.log(`Harness Web listening at http://${HOST}:${PORT}`)
})

function shutdown() {
  server.close(() => process.exit(0))
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
