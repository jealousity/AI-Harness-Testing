/**
 * Web HTTP 外壳的**启动配置解析与部署前置校验**（`docs/14` W1）。
 *
 * 为什么单独成模块而不是留在 `web-app/server.mjs` 里：
 * `server.mjs` 是 `.mjs` 脚本，没有导出面，任何逻辑放进去都只能靠"起进程 + 打日志"验证。
 * 启动配置的正确性恰恰是**最需要失败路径测试**的部分（`NaN`、小数、越界、危险模式），
 * 因此把它做成核心包里的可测模块，`server.mjs` 只调用。
 *
 * 三条纪律：
 * 1. **严格解析**：数值环境变量只接受十进制非负整数；`NaN` / `Infinity` / 小数 /
 *    负数 / 科学计数法 / 十六进制一律**启动即失败**，不做隐式兜底。
 *    （历史问题：`Number('NaN')` 得到 `NaN`，而 `size > NaN` 恒为 `false`，
 *    于是请求体上限**静默失效**。）
 * 2. **失败关闭**：危险部署组合（非回环绑定 + 信任请求头身份）默认拒绝启动，
 *    必须显式声明可信代理才放行。
 * 3. **不泄露**：本模块产出的启动日志行**不含** API Key、数据根绝对路径、
 *    配置文件绝对路径。
 *
 * @module platform-pipeline/web/server-config
 */

import type { PipelineConfig } from '../types.ts'
import { validatePipelineAcl } from '../acl.ts'
import { buildGateEngine, validateApprovalCoverage } from '../runtime/platform-host.ts'
import type { ActorContext, ActorRole } from './pipeline-run-types.ts'

/** 环境变量表（只读；测试直接传普通对象）。 */
export type EnvRecord = Readonly<Record<string, string | undefined>>

/** 启动配置错误。`field` 指明是哪个变量/环节，便于运维直接定位。 */
export class WebServerConfigError extends Error {
  readonly field: string

  constructor(field: string, message: string) {
    super(`${field}：${message}`)
    this.name = 'WebServerConfigError'
    this.field = field
  }
}

export interface WebServerConfig {
  readonly port: number
  readonly host: string
  /** 请求体上限（字节）。恒为 `[1, MAX_BODY_CEILING]` 内的安全整数。 */
  readonly maxBodyBytes: number
  readonly configRef: string
  readonly configPath: string
  readonly dataRoot: string
  readonly gateWaitTimeoutMs: number
  readonly gateTaskTtlMs?: number
  readonly trustActorHeaders: boolean
  /** 是否显式声明"身份由可信反向代理提供"（`PLATFORM_TRUSTED_PROXY=1`）。 */
  readonly trustedProxy: boolean
  readonly serverActor: ActorContext
  readonly runnerActor: ActorContext
}

/** 请求体上限的硬上界。JSON API 超过这个量级基本是配置错误，而不是真实需求。 */
export const MAX_BODY_CEILING = 64 * 1024 * 1024
/** 人工门等待上限的硬上界（24 小时）。 */
export const GATE_WAIT_CEILING_MS = 24 * 60 * 60 * 1000
/** 门任务 TTL 的硬上界（30 天）。 */
export const GATE_TTL_CEILING_MS = 30 * 24 * 60 * 60 * 1000

const DECIMAL_INTEGER = /^[0-9]+$/

/**
 * 严格解析一个非负十进制整数环境变量。
 *
 * 刻意**不使用** `Number(raw)`：它会接受 `'1e3'`、`'0x10'`、`' 12 '`、`'Infinity'`，
 * 并把非法输入变成 `NaN`——而 `NaN` 参与比较时**永远为 false**，会让"上限检查"
 * 这类代码静默失效。这里要求"看起来就是十进制整数"，再做安全整数与范围校验。
 */
function integerOf(
  env: EnvRecord,
  name: string,
  options: { readonly fallback?: number; readonly min: number; readonly max: number },
): number {
  const raw = env[name]
  if (raw === undefined || raw.trim() === '') {
    if (options.fallback !== undefined) return options.fallback
    throw new WebServerConfigError(name, '必填（未设置或为空）')
  }
  const text = raw.trim()
  if (!DECIMAL_INTEGER.test(text)) {
    throw new WebServerConfigError(
      name,
      `必须是十进制非负整数，实际为 ${JSON.stringify(raw)}（不接受小数、科学计数法、十六进制或 NaN）`,
    )
  }
  const value = Number(text)
  if (!Number.isSafeInteger(value)) {
    throw new WebServerConfigError(name, `超出安全整数范围：${text}`)
  }
  if (value < options.min || value > options.max) {
    throw new WebServerConfigError(name, `必须在 [${options.min}, ${options.max}] 内，实际为 ${value}`)
  }
  return value
}

function stringOf(env: EnvRecord, name: string): string {
  const raw = env[name]
  if (raw === undefined || raw.trim() === '') {
    throw new WebServerConfigError(name, '必填（Web 外壳不做隐式兜底）')
  }
  return raw.trim()
}

function optionalStringOf(env: EnvRecord, name: string): string | undefined {
  const raw = env[name]
  if (raw === undefined || raw.trim() === '') return undefined
  return raw.trim()
}

/** 逗号分隔列表；空项丢弃。 */
function listOf(raw: string | undefined, fallback: readonly string[]): readonly string[] {
  if (raw === undefined || raw.trim() === '') return fallback
  return raw.split(',').map(item => item.trim()).filter(item => item !== '')
}

/**
 * 是否为本机回环地址。
 *
 * 只有回环绑定才能"默认信任请求头身份"——因为此时请求在操作系统层面只能来自本机，
 * 外部调用者根本无法建连，伪造请求头的前提不成立。
 */
export function isLoopbackHost(host: string): boolean {
  const value = host.trim().toLowerCase()
  if (value === 'localhost' || value === '::1' || value === '[::1]') return true
  if (value === '::ffff:127.0.0.1') return true
  // 127.0.0.0/8 全部是回环。
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(value)
  if (match === null) return false
  const octets = match.slice(1).map(part => Number(part))
  if (octets.some(octet => octet > 255)) return false
  return octets[0] === 127
}

/**
 * 危险部署组合的前置校验。
 *
 * `PLATFORM_TRUST_ACTOR_HEADERS=1` 时身份**完全来自请求头**（含 `x-actor-roles`）。
 * 只要服务能被外部直接访问、或反向代理没有剥除客户端同名头，攻击者就能自称 `admin`。
 * 因此：
 * - 未开启 → 放行（默认态）；
 * - 开启 + 回环绑定 → 放行（外部建连不可能）；
 * - 开启 + 非回环 + 显式声明可信代理（`PLATFORM_TRUSTED_PROXY=1`）→ 放行；
 * - 其余 → **拒绝启动**。
 */
export function assertTrustActorHeadersDeployment(input: {
  readonly host: string
  readonly trustActorHeaders: boolean
  readonly trustedProxy: boolean
}): void {
  if (!input.trustActorHeaders) return
  if (isLoopbackHost(input.host)) return
  if (input.trustedProxy) return
  throw new WebServerConfigError(
    'PLATFORM_TRUST_ACTOR_HEADERS',
    `已开启"信任请求头身份"，但 HOST=${JSON.stringify(input.host)} 不是回环地址，`
    + '且未显式声明可信代理。此时任何能访问该端口的调用者都可以自带 '
    + '`x-actor-roles: admin` 提权。请改为：① 绑定 127.0.0.1；或 '
    + '② 确认反向代理会剥除客户端同名头，并设置 PLATFORM_TRUSTED_PROXY=1 显式表态。',
  )
}

/** 解析并校验全部启动配置。任何非法取值都在这里抛出，不让它流到运行时。 */
export function parseWebServerConfig(env: EnvRecord): WebServerConfig {
  const host = optionalStringOf(env, 'HOST') ?? '127.0.0.1'
  const port = integerOf(env, 'PORT', { fallback: 3080, min: 1, max: 65535 })
  const maxBodyBytes = integerOf(env, 'PLATFORM_MAX_BODY', { fallback: 64 * 1024, min: 1, max: MAX_BODY_CEILING })
  const gateWaitTimeoutMs = integerOf(env, 'PLATFORM_GATE_WAIT_TIMEOUT_MS', {
    fallback: 0, min: 0, max: GATE_WAIT_CEILING_MS,
  })
  const ttlRaw = optionalStringOf(env, 'PLATFORM_GATE_TASK_TTL_MS')
  const gateTaskTtlMs = ttlRaw === undefined
    ? undefined
    : integerOf(env, 'PLATFORM_GATE_TASK_TTL_MS', { min: 0, max: GATE_TTL_CEILING_MS })

  const configRef = optionalStringOf(env, 'PLATFORM_CONFIG_REF') ?? 'default'
  const configPath = stringOf(env, 'PLATFORM_CONFIG_PATH')
  const dataRoot = stringOf(env, 'PLATFORM_DATA_ROOT')

  const trustActorHeaders = env.PLATFORM_TRUST_ACTOR_HEADERS === '1'
  const trustedProxy = env.PLATFORM_TRUSTED_PROXY === '1'
  assertTrustActorHeadersDeployment({ host, trustActorHeaders, trustedProxy })

  const serverActor: ActorContext = {
    actorId: optionalStringOf(env, 'PLATFORM_ACTOR_ID') ?? 'web-operator',
    ...(optionalStringOf(env, 'PLATFORM_ACTOR_TENANT') === undefined
      ? {}
      : { tenantId: optionalStringOf(env, 'PLATFORM_ACTOR_TENANT') as string }),
    roles: listOf(optionalStringOf(env, 'PLATFORM_ACTOR_ROLES'), ['viewer']) as readonly ActorRole[],
    ...(optionalStringOf(env, 'PLATFORM_ACTOR_PROJECTS') === undefined
      ? {}
      : { projectIds: listOf(optionalStringOf(env, 'PLATFORM_ACTOR_PROJECTS'), []) }),
  }

  /**
   * 后台运行身份**刻意不声明任何角色**：这样"后台不得替人裁决"是机器保证
   * （`assertGateRole` 失败关闭），而不是靠自觉。
   */
  const runnerActor: ActorContext = {
    actorId: optionalStringOf(env, 'PLATFORM_RUNNER_ACTOR_ID') ?? 'web-runner',
  }

  return {
    port, host, maxBodyBytes, configRef, configPath, dataRoot,
    gateWaitTimeoutMs,
    ...(gateTaskTtlMs === undefined ? {} : { gateTaskTtlMs }),
    trustActorHeaders, trustedProxy, serverActor, runnerActor,
  }
}

/**
 * 启动期**完整**配置校验（`docs/14` W1 第 6 条）。
 *
 * 为什么必须在启动时做：`loadPipelineConfig` 只做结构解析，规则引用、阶段 ACL、
 * 审批工具覆盖都推迟到第一次业务请求。后果是 `/health` 报"健康"，而第一条
 * `create` 才炸——健康检查**假绿**，运维会以为部署没问题。
 *
 * 覆盖四件事（任一失败即启动失败）：
 * 1. 阶段 ACL delta 合法（`validatePipelineAcl`）；
 * 2. 需审批工具必须有阻塞人工门（`validateApprovalCoverage`）；
 * 3. 规则引用可构建成门禁引擎（`buildGateEngine`，规则 id 拼错会在这里暴露）；
 * 4. 默认 provider 在 `llm.providers` 里存在。
 *
 * **不校验** API Key 是否存在：凭据按 `apiKeyEnv` 在真正调用模型时才从环境变量读取，
 * 没有 Key 也应该能启动、能创建、能跑到门（只是跑不了 LLM 阶段）。把 Key 缺失做成
 * 启动失败会让"只看页面/只做人工裁决"的用法无法使用。
 */
export function assertStartupConfigUsable(config: PipelineConfig): void {
  const acl = validatePipelineAcl(config)
  if (!acl.ok) {
    throw new WebServerConfigError('配置阶段 ACL', acl.errors.join('; '))
  }

  try {
    validateApprovalCoverage(config)
  } catch (error) {
    throw new WebServerConfigError('配置审批覆盖', error instanceof Error ? error.message : String(error))
  }

  try {
    buildGateEngine(config)
  } catch (error) {
    throw new WebServerConfigError('配置门禁规则', error instanceof Error ? error.message : String(error))
  }

  const llm = config.llm
  if (llm !== undefined && llm.providers[llm.defaultProvider] === undefined) {
    throw new WebServerConfigError(
      '配置 provider',
      `defaultProvider=${JSON.stringify(llm.defaultProvider)} 未在 llm.providers 中声明`
      + `（已声明：${Object.keys(llm.providers).join(', ') || '（空）'}）`,
    )
  }
}

/**
 * 启动日志行。
 *
 * **刻意不含**：API Key / 任何凭据、`dataRoot` 绝对路径、配置文件绝对路径。
 * 只回显"运维需要知道的运行时事实"：监听地址、逻辑 configRef、危险模式是否开启。
 */
export function startupLogLines(config: WebServerConfig): readonly string[] {
  const lines = [
    `Harness Web listening at http://${config.host}:${config.port} (configRef=${config.configRef}, trustActorHeaders=${config.trustActorHeaders})`,
  ]
  if (config.trustActorHeaders) {
    lines.push(
      config.trustedProxy
        ? 'WARNING: 身份取自请求头，且已声明可信代理。请确认反向代理会剥除客户端自带的 x-actor-* 头。'
        : 'WARNING: 身份取自请求头（回环绑定）。仅限本机使用，不要把该端口暴露给外部。',
    )
  }
  return lines
}
