/**
 * 运行清单（manifest）与运行参数持久化（docs/11 P1-01）。
 *
 * 被验证的性质：`create` 请求里那些**影响运行行为**的参数（被测基址、provider、
 * 输入文件、重试/TTL、诊断探针）必须落进持久化清单，并在 `run` 时逐字段传给宿主装配。
 * 修复前它们只被校验、不被保存，因此进程重启后 `run` 拿不到它们——真实 execute
 * 会因为没有 `targetBaseUrl` 而永远拒绝执行，而 Web e2e 用的是脚本化宿主，
 * 看不到这个缺口。
 *
 * 另一个性质：同一 `pipelineId` 换了行为参数必须 `conflict`(409)，绝不静默复用
 * 首次结果（docs/10 §5.3「绝不静默复用」）。
 *
 * @module platform-pipeline/test/web-run-manifest
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import type { PipelineConfig } from '../src/types.ts'
import type { PlatformHostOptions } from '../src/runtime/platform-host.ts'
import { FilePipelineRunService, pipelineIndexDir } from '../src/web/pipeline-run-service.ts'
import { PipelineRunError, type CreatePipelineRunInput } from '../src/web/pipeline-run-types.ts'
import { REVIEWER, ScriptedHost, baseConfig } from './web-fixtures.ts'

let dir: string
let config: PipelineConfig

test.beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'pp-manifest-'))
  config = configWithSecondaryProvider()
})
test.afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

/** 两个 provider：`providerName` 才有可区分的取值（只声明一个时它恒等于默认值）。 */
function configWithSecondaryProvider(): PipelineConfig {
  const provider = (baseUrl: string, model: string): Record<string, unknown> => ({
    type: 'openai-compatible',
    baseUrl,
    model,
    apiKeyEnv: 'PLATFORM_SERVICE_TEST_KEY',
    capabilities: { tools: true, structuredOutput: true },
  })
  return baseConfig({
    llm: {
      defaultProvider: 'primary',
      providers: {
        primary: provider('https://llm.example.com/v1', 'test-model'),
        secondary: provider('https://llm2.example.com/v1', 'test-model-2'),
      },
    },
  })
}

/** 记录宿主工厂收到的装配选项——"create 的参数是否真的传下去"只能这样断言。 */
function recordingService(host = new ScriptedHost(), overrides: Record<string, unknown> = {}): {
  readonly service: FilePipelineRunService
  readonly seen: PlatformHostOptions[]
} {
  const seen: PlatformHostOptions[] = []
  const service = new FilePipelineRunService({
    dataRoot: dir,
    loadConfig: async () => config,
    createHost: options => {
      seen.push(options)
      return host.factory(options)
    },
    ...overrides,
  })
  return { service, seen }
}

/** 会影响运行行为的参数集合（缺一个就少一条持久化路径）。 */
const RUN_PARAMS = {
  requirementInput: 'requirements/spec.md',
  providerName: 'secondary',
  targetBaseUrl: 'https://staging.example.com',
  maxGateRetries: 1,
  gateWaitTimeoutMs: 0,
  gateTaskTtlMs: 900_000,
  diagCredentials: ['QA_API_KEY'],
} as const

function createInput(extra: Partial<CreatePipelineRunInput> = {}): CreatePipelineRunInput {
  return { projectId: 'demo', pipelineId: 'pipe-1', configRef: 'pipeline.yaml', ...RUN_PARAMS, ...extra }
}

function manifestPath(pipelineId = 'pipe-1'): string {
  return join(pipelineIndexDir(dir), `${pipelineId}.json`)
}

async function readManifest(pipelineId = 'pipe-1'): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(manifestPath(pipelineId), 'utf8')) as Record<string, unknown>
}

function isCode(code: string) {
  return (error: unknown): boolean => error instanceof PipelineRunError && error.code === code
}

// ── P1-01：create 参数必须落盘并传给宿主 ───────────────────────────────────────

test('create 的运行参数落进持久化清单（不是只校验后丢弃）', async () => {
  const { service } = recordingService()
  await service.create(createInput(), REVIEWER)

  const manifest = await readManifest()
  assert.equal(manifest.pipelineId, 'pipe-1')
  assert.equal(manifest.projectId, 'demo')
  assert.equal(manifest.tenantId, 'acme')
  assert.equal(manifest.configRef, 'pipeline.yaml')
  assert.equal(manifest.requirementInput, RUN_PARAMS.requirementInput)
  assert.equal(manifest.providerName, RUN_PARAMS.providerName)
  assert.equal(manifest.targetBaseUrl, RUN_PARAMS.targetBaseUrl)
  assert.equal(manifest.maxGateRetries, RUN_PARAMS.maxGateRetries)
  assert.equal(manifest.gateWaitTimeoutMs, RUN_PARAMS.gateWaitTimeoutMs)
  assert.equal(manifest.gateTaskTtlMs, RUN_PARAMS.gateTaskTtlMs)
  assert.deepEqual(manifest.diagCredentials, [...RUN_PARAMS.diagCredentials])
  assert.equal(typeof manifest.rulesetVersion, 'string')
  assert.equal(typeof manifest.createdAt, 'number')
})

test('run 把清单里的每个运行参数逐字段传给宿主装配', async () => {
  const { service, seen } = recordingService()
  await service.create(createInput(), REVIEWER)
  await service.run('pipe-1', REVIEWER)

  assert.equal(seen.length, 1, 'run 应当装配一次宿主')
  const options = seen[0]!
  assert.equal(options.receiveInput, RUN_PARAMS.requirementInput)
  assert.equal(options.providerName, RUN_PARAMS.providerName)
  assert.equal(options.targetBaseUrl, RUN_PARAMS.targetBaseUrl)
  assert.equal(options.maxGateRetries, RUN_PARAMS.maxGateRetries)
  assert.equal(options.gateWaitTimeoutMs, RUN_PARAMS.gateWaitTimeoutMs)
  assert.equal(options.gateTaskTtlMs, RUN_PARAMS.gateTaskTtlMs)
  assert.deepEqual(options.diagProbes, [{ kind: 'credentials', target: 'QA_API_KEY' }])
  assert.equal(typeof options.assertTargetBaseUrl, 'function', 'executor 建连前复核用的校验器必须注入宿主')
})

test('进程重启（新 service 实例）后 run 仍从清单读到同样的运行参数', async () => {
  await recordingService().service.create(createInput(), REVIEWER)

  // 全新实例、全新宿主工厂：进程内没有任何残留状态。
  const { service, seen } = recordingService()
  await service.run('pipe-1', REVIEWER)

  assert.equal(seen.length, 1)
  const options = seen[0]!
  assert.equal(options.receiveInput, RUN_PARAMS.requirementInput)
  assert.equal(options.providerName, RUN_PARAMS.providerName)
  assert.equal(options.targetBaseUrl, RUN_PARAMS.targetBaseUrl)
  assert.equal(options.maxGateRetries, RUN_PARAMS.maxGateRetries)
  assert.equal(options.gateWaitTimeoutMs, RUN_PARAMS.gateWaitTimeoutMs)
  assert.equal(options.gateTaskTtlMs, RUN_PARAMS.gateTaskTtlMs)
  assert.deepEqual(options.diagProbes, [{ kind: 'credentials', target: 'QA_API_KEY' }])
})

test('清单里的行为参数优先于 service 默认值（默认值只是缺省，不是覆盖）', async () => {
  const { service, seen } = recordingService(new ScriptedHost(), {
    defaultGateWaitTimeoutMs: 2_000,
    defaultGateTaskTtlMs: 67_890,
  })
  await service.create(createInput(), REVIEWER)
  await service.run('pipe-1', REVIEWER)

  const options = seen[0]!
  assert.equal(options.gateWaitTimeoutMs, RUN_PARAMS.gateWaitTimeoutMs, '清单值必须压过 service 默认值')
  assert.equal(options.gateTaskTtlMs, RUN_PARAMS.gateTaskTtlMs, '清单值必须压过 service 默认值')
})

test('未声明运行参数时，清单不写假值、宿主也不收到显式 undefined', async () => {
  const { service, seen } = recordingService()
  await service.create({ projectId: 'demo', pipelineId: 'pipe-1', configRef: 'pipeline.yaml' }, REVIEWER)

  const manifest = await readManifest()
  for (const key of ['requirementInput', 'providerName', 'targetBaseUrl', 'maxGateRetries', 'gateWaitTimeoutMs', 'gateTaskTtlMs', 'diagCredentials']) {
    assert.equal(key in manifest, false, `未声明的 ${key} 不应被写成假值：${JSON.stringify(manifest[key])}`)
  }

  await service.run('pipe-1', REVIEWER)
  const options = seen[0]!
  assert.equal('targetBaseUrl' in options, false)
  assert.equal('diagProbes' in options, false)
  assert.equal('receiveInput' in options, false)
})

test('同一 pipelineId 改变任一行为参数都返回 conflict(409)，绝不静默复用首次结果', async () => {
  const { service } = recordingService()
  await service.create(createInput(), REVIEWER)

  const mutations: Record<string, unknown>[] = [
    { targetBaseUrl: 'https://other.example.com' },
    { providerName: 'primary' },
    { requirementInput: 'requirements/other.md' },
    { maxGateRetries: 0 },
    { gateWaitTimeoutMs: 1000 },
    { gateTaskTtlMs: 1000 },
    { diagCredentials: ['OTHER_KEY'] },
  ]
  for (const mutation of mutations) {
    await assert.rejects(
      () => service.create(createInput(mutation), REVIEWER),
      isCode('conflict'),
      `改变 ${Object.keys(mutation)[0]} 必须 conflict：${JSON.stringify(mutation)}`,
    )
  }

  // 同一请求重复投递仍按幂等重放，不算冲突（§6.4 的反面）。
  const replay = await service.create(createInput(), REVIEWER)
  assert.equal(replay.pipelineId, 'pipe-1')
})

test('清单只保存环境变量名，不落任何凭据值', async () => {
  const { service } = recordingService()
  await service.create(createInput(), REVIEWER)

  const raw = await readFile(manifestPath(), 'utf8')
  // 测试宿主的 API Key 常量（`web-fixtures.ts`）绝不允许出现在清单里。
  assert.equal(raw.includes('sk-service-test-secret-value'), false, '清单不得含 API Key 值')
  assert.equal(raw.includes('QA_API_KEY'), true, '只允许出现环境变量名')
  assert.equal(raw.includes('apiKey'), false, '清单不得出现任何 apiKey 字段')
})

test('create 拒绝非法的 diagCredentials：只接受环境变量名', async () => {
  const { service } = recordingService()
  // 这些取值在类型层本就不该出现（`readonly string[]`），但 HTTP 请求体不受类型约束，
  // 所以运行时的校验必须真的存在——用 as 造出"类型系统拦不住"的输入。
  const invalid: readonly unknown[] = [['not a var'], ['1LEADING'], [''], ['A-B'], ['x'.repeat(200)], [42], ['OK', 'bad name'], 'not-an-array']
  for (const bad of invalid) {
    await assert.rejects(
      () => service.create(createInput({ diagCredentials: bad as readonly string[] }), REVIEWER),
      isCode('invalid-request'),
      `diagCredentials ${JSON.stringify(bad)} 必须被拒绝`,
    )
  }
})

test('清单字段类型不符时显式失败，不静默退回默认参数', async () => {
  const { service } = recordingService()
  await service.create(createInput(), REVIEWER)

  const manifest = await readManifest()
  await writeFile(manifestPath(), JSON.stringify({ ...manifest, maxGateRetries: 'lots' }, null, 2), 'utf8')

  await assert.rejects(
    () => service.run('pipe-1', REVIEWER),
    (error: unknown) => {
      assert.ok(error instanceof PipelineRunError, `期望 PipelineRunError，实际 ${(error as Error)?.name}: ${(error as Error)?.message}`)
      assert.notEqual(error.code, 'conflict')
      return true
    },
    '损坏的清单必须显式失败，而不是用默认值继续跑',
  )
})

test('清单与请求不一致时不得静默串到别的项目（文件名才是权威键）', async () => {
  const { service } = recordingService()
  await service.create(createInput(), REVIEWER)

  const manifest = await readManifest()
  await writeFile(manifestPath(), JSON.stringify({ ...manifest, pipelineId: 'someone-else' }, null, 2), 'utf8')

  await assert.rejects(() => service.get('pipe-1', REVIEWER), (error: unknown) => {
    assert.ok(error instanceof PipelineRunError)
    assert.notEqual(error.code, 'scope-mismatch', '不能按被篡改的 pipelineId 去解析另一个项目')
    return true
  })
})
