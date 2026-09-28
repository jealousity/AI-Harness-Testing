/**
 * Web HTTP 外壳**启动配置**的失败路径测试（`docs/14` W1）。
 *
 * 为什么这些用例必须存在：启动配置的错误模式是"静默失效"型的——
 * `Number('NaN')` 得到 `NaN`，而 `size > NaN` 恒为 `false`，于是请求体上限**形同不存在**，
 * 服务照常启动、照常健康、照常收请求。这类缺陷不会在正常路径上暴露，
 * 只能靠"喂非法值，断言启动失败"来钉住。
 *
 * 覆盖四组：
 * 1. 数值环境变量的严格解析（NaN / 小数 / 科学计数法 / 十六进制 / 负数 / 越界）；
 * 2. 危险部署组合（非回环绑定 + 信任请求头身份）的失败关闭；
 * 3. 启动期完整配置校验（ACL / 审批覆盖 / 规则引用 / provider 引用）；
 * 4. 启动日志不泄露数据根、配置路径与凭据。
 *
 * @module platform-pipeline/test/web-server-config
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { STAGE_ORDER, type PipelineConfig } from '../src/types.ts'
import {
  GATE_TTL_CEILING_MS,
  GATE_WAIT_CEILING_MS,
  MAX_BODY_CEILING,
  WebServerConfigError,
  assertStartupConfigUsable,
  assertTrustActorHeadersDeployment,
  isLoopbackHost,
  parseWebServerConfig,
  startupLogLines,
} from '../src/web/server-config.ts'
import { baseConfig } from './web-fixtures.ts'

const DATA_ROOT = '/tmp/web-data-root'
const CONFIG_PATH = '/tmp/pipeline.yaml'

/** 最小合法环境。 */
function envOf(overrides: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return {
    PLATFORM_DATA_ROOT: DATA_ROOT,
    PLATFORM_CONFIG_PATH: CONFIG_PATH,
    ...overrides,
  }
}

/** 断言解析失败且 `field` 指向预期变量。 */
function expectConfigError(env: Record<string, string | undefined>, field: string): void {
  assert.throws(
    () => parseWebServerConfig(env),
    (error: unknown) => {
      assert.ok(error instanceof WebServerConfigError, `期望 WebServerConfigError，实际 ${String(error)}`)
      assert.equal(error.field, field, `错误应指向 ${field}，实际 ${error.field}：${error.message}`)
      return true
    },
  )
}

// ── 1. 严格数值解析 ────────────────────────────────────────────────────────────

test('W1：合法最小环境解析成功，缺省值符合契约', () => {
  const config = parseWebServerConfig(envOf())
  assert.equal(config.port, 3080)
  assert.equal(config.host, '127.0.0.1')
  assert.equal(config.maxBodyBytes, 64 * 1024)
  assert.equal(config.configRef, 'default')
  assert.equal(config.gateWaitTimeoutMs, 0)
  assert.equal(config.gateTaskTtlMs, undefined)
  assert.equal(config.trustActorHeaders, false)
  assert.equal(config.trustedProxy, false)
  assert.equal(config.dataRoot, DATA_ROOT)
  assert.equal(config.configPath, CONFIG_PATH)
})

test('W1：PLATFORM_MAX_BODY=NaN 必须启动失败（否则请求体上限静默失效）', () => {
  // 这条是 W-06 的直接回归：`Number('NaN')` 是 NaN，而 `size > NaN` 恒为 false。
  expectConfigError(envOf({ PLATFORM_MAX_BODY: 'NaN' }), 'PLATFORM_MAX_BODY')
})

test('W1：数值环境变量拒绝小数、科学计数法、十六进制、带符号与空白', () => {
  for (const bad of ['1.5', '1e3', '0x10', '-1', '+1', 'Infinity', '-Infinity', '1 2', ' 1 2 ', 'abc', 'NaN']) {
    expectConfigError(envOf({ PLATFORM_MAX_BODY: bad }), 'PLATFORM_MAX_BODY')
  }
})

test('W1：数值环境变量拒绝越界与不安全整数', () => {
  expectConfigError(envOf({ PLATFORM_MAX_BODY: '0' }), 'PLATFORM_MAX_BODY')
  expectConfigError(envOf({ PLATFORM_MAX_BODY: String(MAX_BODY_CEILING + 1) }), 'PLATFORM_MAX_BODY')
  expectConfigError(envOf({ PORT: '0' }), 'PORT')
  expectConfigError(envOf({ PORT: '65536' }), 'PORT')
  expectConfigError(envOf({ PLATFORM_GATE_WAIT_TIMEOUT_MS: String(GATE_WAIT_CEILING_MS + 1) }), 'PLATFORM_GATE_WAIT_TIMEOUT_MS')
  expectConfigError(envOf({ PLATFORM_GATE_TASK_TTL_MS: String(GATE_TTL_CEILING_MS + 1) }), 'PLATFORM_GATE_TASK_TTL_MS')
  expectConfigError(envOf({ PORT: '9007199254740993' }), 'PORT')
})

test('W1：边界值被接受（上界本身合法）', () => {
  const config = parseWebServerConfig(envOf({
    PORT: '65535',
    PLATFORM_MAX_BODY: String(MAX_BODY_CEILING),
    PLATFORM_GATE_WAIT_TIMEOUT_MS: String(GATE_WAIT_CEILING_MS),
    PLATFORM_GATE_TASK_TTL_MS: '0',
  }))
  assert.equal(config.port, 65535)
  assert.equal(config.maxBodyBytes, MAX_BODY_CEILING)
  assert.equal(config.gateWaitTimeoutMs, GATE_WAIT_CEILING_MS)
  assert.equal(config.gateTaskTtlMs, 0)
})

test('W1：缺失必填环境变量必须失败，且错误指向具体变量', () => {
  expectConfigError({ PLATFORM_CONFIG_PATH: CONFIG_PATH }, 'PLATFORM_DATA_ROOT')
  expectConfigError({ PLATFORM_DATA_ROOT: DATA_ROOT }, 'PLATFORM_CONFIG_PATH')
  expectConfigError({ PLATFORM_DATA_ROOT: '   ', PLATFORM_CONFIG_PATH: CONFIG_PATH }, 'PLATFORM_DATA_ROOT')
})

// ── 2. 危险部署组合 ────────────────────────────────────────────────────────────

test('W1：isLoopbackHost 只认回环地址', () => {
  for (const loopback of ['127.0.0.1', '127.1.2.3', '127.255.255.255', 'localhost', 'LOCALHOST', '::1', '[::1]', '::ffff:127.0.0.1']) {
    assert.equal(isLoopbackHost(loopback), true, `${loopback} 应被判为回环`)
  }
  for (const external of ['0.0.0.0', '192.168.1.10', '10.0.0.1', '::', 'example.com', '128.0.0.1', '127.0.0.256']) {
    assert.equal(isLoopbackHost(external), false, `${external} 不应被判为回环`)
  }
})

test('W1：默认关闭信任请求头时，任何绑定都放行', () => {
  assert.doesNotThrow(() => assertTrustActorHeadersDeployment({
    host: '0.0.0.0', trustActorHeaders: false, trustedProxy: false,
  }))
})

test('W1：开启信任请求头 + 回环绑定放行（外部无法建连）', () => {
  assert.doesNotThrow(() => assertTrustActorHeadersDeployment({
    host: '127.0.0.1', trustActorHeaders: true, trustedProxy: false,
  }))
})

test('W1：开启信任请求头 + 非回环绑定 + 未声明可信代理必须拒绝启动（W-07）', () => {
  assert.throws(
    () => assertTrustActorHeadersDeployment({
      host: '0.0.0.0', trustActorHeaders: true, trustedProxy: false,
    }),
    (error: unknown) => {
      assert.ok(error instanceof WebServerConfigError)
      assert.equal(error.field, 'PLATFORM_TRUST_ACTOR_HEADERS')
      // 错误信息必须说清风险与两条出路，而不是只说"配置非法"。
      assert.match(error.message, /x-actor-roles/)
      assert.match(error.message, /PLATFORM_TRUSTED_PROXY/)
      return true
    },
  )
  // 通过 parseWebServerConfig 走一遍完整路径，确认它确实接进了启动解析。
  expectConfigError(envOf({
    HOST: '0.0.0.0',
    PLATFORM_TRUST_ACTOR_HEADERS: '1',
  }), 'PLATFORM_TRUST_ACTOR_HEADERS')
})

test('W1：开启信任请求头 + 非回环 + 显式声明可信代理放行', () => {
  const config = parseWebServerConfig(envOf({
    HOST: '0.0.0.0',
    PLATFORM_TRUST_ACTOR_HEADERS: '1',
    PLATFORM_TRUSTED_PROXY: '1',
  }))
  assert.equal(config.trustActorHeaders, true)
  assert.equal(config.trustedProxy, true)
})

test('W1：后台运行身份不得声明任何角色（机器保证"后台不替人裁决"）', () => {
  const config = parseWebServerConfig(envOf({ PLATFORM_ACTOR_ROLES: 'admin,reviewer' }))
  assert.deepEqual(config.serverActor.roles, ['admin', 'reviewer'])
  assert.equal(config.runnerActor.roles, undefined, '后台身份一旦声明角色就能替人裁决')
  assert.equal(config.runnerActor.actorId, 'web-runner')
})

test('W1：默认身份只有 viewer（最小权限）', () => {
  const config = parseWebServerConfig(envOf())
  assert.deepEqual(config.serverActor.roles, ['viewer'])
})

// ── 3. 启动期完整配置校验 ──────────────────────────────────────────────────────

test('W1：合法配置通过启动校验', () => {
  assert.doesNotThrow(() => assertStartupConfigUsable(baseConfig()))
})

test('W1：llm 缺省时通过启动校验（只看页面/只做人工裁决不需要 provider）', () => {
  const config = baseConfig({ llm: undefined })
  assert.doesNotThrow(() => assertStartupConfigUsable(config))
})

test('W1：defaultProvider 未在 providers 中声明 → 启动失败', () => {
  // 注意构造方式：**不能**把非法 llm 交给 `baseConfig()`——`normalizeConfig` 自己就会拒绝
  // （`llm.defaultProvider references unknown provider`），那样这条用例测到的是
  // 配置解析器而不是本模块。这里直接构造对象，验证"绕过 normalizeConfig 的
  // 手工 PipelineConfig 也会被启动校验拦下"（纵深防御）。
  const base = baseConfig()
  const config: PipelineConfig = {
    ...base,
    llm: { defaultProvider: 'missing', providers: base.llm?.providers ?? {} },
  }
  assert.throws(
    () => assertStartupConfigUsable(config),
    (error: unknown) => {
      assert.ok(error instanceof WebServerConfigError)
      assert.equal(error.field, '配置 provider')
      assert.match(error.message, /missing/)
      return true
    },
  )
})

test('W1：阶段 ACL 引用未知工具 → 启动失败（而不是等第一次 create）', () => {
  const broken = baseConfig({
    stages: Object.fromEntries(STAGE_ORDER.map(id => [
      id,
      { rules: [], review: { enabled: false }, ...(id === 'receive' ? { tools: { allow: ['no_such_tool'] } } : {}) },
    ])),
  })
  assert.throws(
    () => assertStartupConfigUsable(broken),
    (error: unknown) => {
      assert.ok(error instanceof WebServerConfigError)
      assert.equal(error.field, '配置阶段 ACL')
      assert.match(error.message, /no_such_tool/)
      return true
    },
  )
})

test('W1：需审批工具缺少阻塞人工门 → 启动失败', () => {
  const base = baseConfig()
  const archive = base.stages.archive
  const broken: PipelineConfig = {
    ...base,
    stages: {
      ...base.stages,
      // 关掉 archive 的全部阻塞门，而该阶段仍允许写库 → 必须启动失败。
      archive: {
        ...archive,
        gate: Object.fromEntries(Object.entries(archive.gate).map(([key, value]) => [key, { ...value, block: false }])),
      },
    },
  }
  assert.throws(
    () => assertStartupConfigUsable(broken),
    (error: unknown) => {
      assert.ok(error instanceof WebServerConfigError)
      assert.equal(error.field, '配置审批覆盖')
      return true
    },
  )
})

test('W1：阶段规则引用未知规则 id → 启动失败', () => {
  const broken = baseConfig({
    stages: Object.fromEntries(STAGE_ORDER.map(id => [
      id,
      { rules: id === 'receive' ? ['R9-99'] : [], review: { enabled: false } },
    ])),
  })
  assert.throws(
    () => assertStartupConfigUsable(broken),
    (error: unknown) => {
      assert.ok(error instanceof WebServerConfigError)
      assert.equal(error.field, '配置门禁规则')
      return true
    },
  )
})

// ── 4. 启动日志不泄露 ─────────────────────────────────────────────────────────

test('W1：启动日志不含数据根、配置路径与凭据', () => {
  const config = parseWebServerConfig(envOf({
    PLATFORM_ACTOR_ID: 'operator-1',
    PLATFORM_LLM_API_KEY: 'sk-should-never-appear',
  }))
  const text = startupLogLines(config).join('\n')
  assert.ok(!text.includes(DATA_ROOT), `不得回显数据根：${text}`)
  assert.ok(!text.includes(CONFIG_PATH), `不得回显配置路径：${text}`)
  assert.ok(!text.includes('sk-should-never-appear'), `不得回显凭据：${text}`)
  // 必须回显运维真正需要的事实。
  assert.match(text, /127\.0\.0\.1:3080/)
  assert.match(text, /configRef=default/)
})

test('W1：开启信任请求头时启动日志必须给出明确警告', () => {
  const loopback = startupLogLines(parseWebServerConfig(envOf({ PLATFORM_TRUST_ACTOR_HEADERS: '1' }))).join('\n')
  assert.match(loopback, /WARNING/)
  assert.match(loopback, /不要把该端口暴露给外部/)

  const behindProxy = startupLogLines(parseWebServerConfig(envOf({
    HOST: '0.0.0.0', PLATFORM_TRUST_ACTOR_HEADERS: '1', PLATFORM_TRUSTED_PROXY: '1',
  }))).join('\n')
  assert.match(behindProxy, /WARNING/)
  assert.match(behindProxy, /x-actor-\*/)
})

test('W1：未开启信任请求头时启动日志不出现警告', () => {
  const text = startupLogLines(parseWebServerConfig(envOf())).join('\n')
  assert.ok(!text.includes('WARNING'), `不该有警告：${text}`)
})
