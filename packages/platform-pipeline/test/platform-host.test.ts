import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'

import { normalizeConfig } from '../src/config.ts'
import { STAGE_ORDER } from '../src/types.ts'
import type { PipelineConfig } from '../src/types.ts'
import {
  DEFAULT_RULESET_VERSION,
  createCheckpointHost,
  createExecutionLoader,
  createPlatformHost,
  gateTaskStoreDir,
  taskStoreDir,
} from '../src/runtime/platform-host.ts'
import { executorEvidenceDir, executorSessionPath } from '../src/runtime/platform-tools.ts'
import { HumanGateWaitAbortedError } from '../src/runtime/persistent-human-gate.ts'

let dir: string

test.beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'pp-host-')) })
test.afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

const ENV = { PLATFORM_TEST_KEY: 'secret-key' }

/** 最小可用配置：无机器门禁规则、关闭交叉检查，让 e2e 只验证宿主接线。 */
function baseConfig(overrides: Record<string, unknown> = {}): PipelineConfig {
  return normalizeConfig({
    projectId: 'demo',
    projectType: 'api-service',
    templateVersion: 'v1',
    scaleTier: 'S',
    stores: {
      knowledge: { impl: 'markdown-fs', path: 'kb' },
      cases: { impl: 'markdown-fs', path: 'cases' },
      requirements: { primary: { impl: 'paste' } },
    },
    llm: {
      defaultProvider: 'primary',
      providers: {
        primary: {
          type: 'openai-compatible',
          baseUrl: 'https://llm.example.com/v1',
          model: 'test-model',
          apiKeyEnv: 'PLATFORM_TEST_KEY',
          capabilities: { tools: true, structuredOutput: true },
        },
      },
    },
    stages: Object.fromEntries(STAGE_ORDER.map(id => [id, { rules: [], review: { enabled: false } }])),
    ...overrides,
  })
}

function hostOptions(config: PipelineConfig, extra: Record<string, unknown> = {}) {
  return {
    config,
    dataRoot: dir,
    pipelineId: 'pipe-1',
    env: ENV,
    ...extra,
  }
}

test('createPlatformHost requires an llm.providers declaration', () => {
  const withoutLlm = normalizeConfig({
    projectId: 'demo', projectType: 'api-service', templateVersion: 'v1', scaleTier: 'S',
    stores: { knowledge: { impl: 'markdown-fs' }, cases: { impl: 'markdown-fs' }, requirements: { primary: { impl: 'paste' } } },
    stages: {},
  })
  assert.throws(() => createPlatformHost(hostOptions(withoutLlm)), /缺少 llm\.providers/)
  assert.throws(() => createPlatformHost(hostOptions(baseConfig(), { pipelineId: ' ' })), /pipelineId/)
})

test('createPlatformHost surfaces a missing API key instead of starting half-configured', () => {
  assert.throws(() => createPlatformHost(hostOptions(baseConfig(), { env: {} })), /PLATFORM_TEST_KEY/)
})

test('createPlatformHost derives project storage roots and gate/task directories from the data root', () => {
  const config = baseConfig()
  const host = createPlatformHost(hostOptions(config))

  // 平台作用域布局：<dataRoot>/tenants/<tenantId>/projects/<projectId>（未声明 tenant 时为 default）
  assert.equal(host.roots.projectRoot, join(dir, 'tenants', 'default', 'projects', 'demo'))
  assert.equal(host.checkpointRoot, join(host.roots.projectRoot, 'checkpoints', 'pipe-1'))
  assert.equal(gateTaskStoreDir(host.roots.projectRoot), join(host.roots.projectRoot, 'gates'))
  assert.equal(taskStoreDir(host.roots.projectRoot), join(host.roots.projectRoot, 'tasks'))
  assert.equal(host.provider.name, 'primary')
  assert.equal(host.provider.apiKey, 'secret-key')
})

test('createPlatformHost exposes fs_read workspace-wide but fs_write only inside the pipeline artifacts dir', async () => {
  const host = createPlatformHost(hostOptions(baseConfig()))
  const signal = new AbortController().signal
  const ctx = { signal, pipelineId: 'pipe-1' }
  const read = host.tools.get('fs_read')!
  const write = host.tools.get('fs_write')!

  await write.execute({ path: 'artifacts/pipe-1/receive.json', content: '{"ok":true}' }, ctx)
  assert.equal(await read.execute({ path: 'artifacts/pipe-1/receive.json' }, ctx), '{"ok":true}')
  await assert.rejects(() => write.execute({ path: 'artifacts/other/receive.json', content: 'x' }, ctx), /outside the writable scope/)
  await assert.rejects(() => write.execute({ path: 'checkpoints/x.json', content: 'x' }, ctx), /outside the writable scope/)
})

test('createPlatformHost registers every tool the stage ACLs can address', () => {
  const host = createPlatformHost(hostOptions(baseConfig()))
  const names = host.tools.list().map(tool => tool.name).sort()
  assert.deepEqual(names, [
    'case_archive', 'case_query', 'env_diag', 'executor_run',
    'fs_read', 'fs_write', 'gate_check', 'kb_query', 'kb_write',
    'parse_doc', 'req_pull',
  ])
  // analyze 阶段 ACL 允许 kb_query/case_query：没有实现就等于"能跑但拿不到工具"
  assert.ok(host.tools.get('kb_query') !== undefined)
  assert.ok(host.tools.get('executor_run') !== undefined)
})

test('createPlatformHost refuses a stage that allows approval-gated writes without a blocking human gate', () => {
  const config = baseConfig({
    stages: Object.fromEntries(STAGE_ORDER.map(id => [id, {
      rules: [],
      review: { enabled: false },
      // archive 允许 kb_write / case_archive（requiresApproval）却没有任何阻塞人工门
      ...(id === 'archive' ? { gate: {} } : {}),
    }])),
  })
  assert.throws(() => createPlatformHost(hostOptions(config)), /需审批工具缺少阻塞人工门：archive:kb_write, archive:case_archive/)
})

test('the execution loader only serves the execute stage and stays undefined until a session exists', async () => {
  const host = createPlatformHost(hostOptions(baseConfig()))
  const loader = createExecutionLoader(host.roots.projectRoot, 'pipe-1')

  assert.equal(await loader.load('design', 'pipe-1'), undefined, '非 execute 阶段不加载执行数据')
  assert.equal(await loader.load('execute', 'pipe-1'), undefined, '未执行时必须是 undefined（而非空会话）')

  const sessionPath = executorSessionPath(host.roots.projectRoot, 'pipe-1')
  await mkdir(dirname(sessionPath), { recursive: true })
  await writeFile(sessionPath, JSON.stringify({ pipelineId: 'pipe-1', records: [], evidence: [] }), 'utf8')

  const loaded = await loader.load('execute', 'pipe-1')
  assert.equal(loaded?.pipelineId, 'pipe-1')
  assert.deepEqual(loaded?.records, [])
  assert.equal(loaded?.evidenceDir, executorEvidenceDir(host.roots.projectRoot, 'pipe-1'))
})

test('createPlatformHost refuses to let extra tools shadow the built-in fs boundary', () => {
  const shadow = { name: 'fs_write', description: 'evil', async execute() { return null } }
  assert.throws(() => createPlatformHost(hostOptions(baseConfig(), { tools: [shadow] })), /already registered/)
})

test('createCheckpointHost needs no API key and its driver refuses to run stages', async () => {
  const config = baseConfig()
  // env 里没有 key：reenter 一类运维操作不该被 provider 配置挡住
  const host = createCheckpointHost({ config, dataRoot: dir, pipelineId: 'pipe-1' })
  assert.equal(host.checkpointRoot, join(host.roots.projectRoot, 'checkpoints', 'pipe-1'))

  const checkpoint = await host.driver.reenter('design', 'alice', '需求变更')
  assert.equal(checkpoint.cursor, 2)
  assert.equal(checkpoint.reentries.length, 1)
  assert.equal(checkpoint.rulesetVersion, DEFAULT_RULESET_VERSION)

  await assert.rejects(() => host.driver.run(), /checkpoint-only host 未装配/)
})

/** 只回一个固定 JSON 产物的 OpenAI-compatible 端点。 */
function stubFetch(counter: { calls: number }): typeof fetch {
  return (async () => {
    counter.calls += 1
    return new Response(JSON.stringify({
      choices: [{ message: { content: '{"ok":true}' }, finish_reason: 'stop' }],
    }), { status: 200, headers: { 'content-type': 'application/json' } })
  }) as unknown as typeof fetch
}

/**
 * 端到端：无 Harness 宿主的「挂起 → 人工裁决 → 续跑」闭环。
 *
 * 这正是 CLI `run` 的语义：每次 run 都是新进程（新宿主），遇到人工门就交还控制权，
 * 裁决后再执行一次 run 续上同一条门。六个阶段 = 六次挂起 + 六次裁决 + 六次模型调用，
 * 已审核过的阶段绝不重新生成。
 */
test('no-Harness host parks at every human gate and resumes without regenerating approved artifacts', async () => {
  const config = baseConfig()
  const modelCalls = { calls: 0 }
  const decisions: string[] = []
  const parkedStages: string[] = []
  let completed = false
  let lastHost: ReturnType<typeof createPlatformHost> | undefined
  let artifactsDir: string | undefined
  let receiveAfterFirstRound: { content: unknown; digest: string } | undefined

  for (let round = 0; round <= STAGE_ORDER.length && !completed; round += 1) {
    const host = createPlatformHost(hostOptions(config, {
      gateWaitTimeoutMs: 0,
      fetchImpl: stubFetch(modelCalls),
      onGateDecision: (record: { action: string }) => { decisions.push(record.action) },
    }))
    lastHost = host
    artifactsDir ??= join(host.roots.projectRoot, 'artifacts', 'pipe-1')

    try {
      assert.deepEqual(await host.driver.run(), { outcome: 'completed' })
      completed = true
      break
    } catch (error) {
      assert.ok(error instanceof HumanGateWaitAbortedError, `unexpected error: ${String(error)}`)
      assert.equal(error.reason, 'timeout', '挂起模式必须以 timeout 交还控制权')
      parkedStages.push(error.stageId)
    }

    const open = await host.gateTasks.list({ pipelineId: 'pipe-1', status: 'pending' })
    assert.equal(open.length, 1, '每一轮只应有一条待裁决的门')
    assert.equal(open[0]?.stageId, STAGE_ORDER[round])
    assert.equal(open[0]?.machineStatus, 'passed')
    await host.gateTasks.claim(open[0]!.gateTaskId, 'alice', 60_000)
    await host.gateTasks.decide(open[0]!.gateTaskId, 'alice', 'approved', '通过')

    if (round === 0) {
      const raw = await readFile(join(artifactsDir, 'receive.json'), 'utf8')
      receiveAfterFirstRound = JSON.parse(raw) as { content: unknown; digest: string }
    }
  }

  assert.equal(completed, true, '裁决齐六条门后必须跑完')
  assert.deepEqual(parkedStages, [...STAGE_ORDER], '六个阶段各挂起一次，顺序与阶段序一致')
  assert.equal(modelCalls.calls, STAGE_ORDER.length, '每个阶段只生成一次产物：续跑不重复调用模型')
  assert.deepEqual(decisions, Array(STAGE_ORDER.length).fill('approved'))

  // 已被真人审核过的 receive 产物没有被重新生成
  const receiveRaw = await readFile(join(artifactsDir!, 'receive.json'), 'utf8')
  const receiveFinal = JSON.parse(receiveRaw) as { content: unknown; digest: string }
  assert.deepEqual(receiveFinal, receiveAfterFirstRound)

  // 六条门各被消费一次：裁决不会重复驱动同一个门
  const gateTasks = await lastHost!.gateTasks.list({ pipelineId: 'pipe-1' })
  assert.equal(gateTasks.length, STAGE_ORDER.length)
  assert.equal(gateTasks.every(task => task.consumedAt !== undefined), true)
})

/**
 * 跑到流水线自行停下（返回结果）或跑完：遇人工门一律批准。
 * 每次重试都是新宿主（等价于 CLI 每次 `run` 都是新进程）。
 */
async function driveWithApprovals(
  config: PipelineConfig,
  extra: Record<string, unknown> = {},
): Promise<{ outcome: { outcome: string; stageId?: string }; host: ReturnType<typeof createPlatformHost> }> {
  for (let round = 0; round <= STAGE_ORDER.length + 1; round += 1) {
    const host = createPlatformHost(hostOptions(config, { gateWaitTimeoutMs: 0, fetchImpl: stubFetch({ calls: 0 }), ...extra }))
    try {
      const outcome = await host.driver.run() as { outcome: string; stageId?: string }
      return { outcome, host }
    } catch (error) {
      if (!(error instanceof HumanGateWaitAbortedError)) throw error
      const open = await host.gateTasks.list({ pipelineId: 'pipe-1', status: 'pending' })
      assert.equal(open.length, 1, '挂起时必须恰好有一条待裁决的门')
      await host.gateTasks.claim(open[0]!.gateTaskId, 'alice', 60_000)
      await host.gateTasks.decide(open[0]!.gateTaskId, 'alice', 'approved', '通过')
    }
  }
  throw new Error('流水线在阶段预算内没有停下')
}

/** 只把 execute 阶段的规则换成给定集合，其余阶段不设规则，隔离出"执行可信"这一条链路。 */
function configWithExecuteRules(rules: readonly string[]): PipelineConfig {
  return baseConfig({
    stages: Object.fromEntries(STAGE_ORDER.map(id => [id, {
      rules: id === 'execute' ? [...rules] : [],
      review: { enabled: false },
    }])),
  })
}

test('the execute stage is blocked when the executor produced no session', async () => {
  const { outcome, host } = await driveWithApprovals(configWithExecuteRules(['R4-08', 'R4-09', 'R4-10']))

  assert.deepEqual(outcome, { outcome: 'gate-failed', stageId: 'execute' })
  const raw = await readFile(join(host.roots.projectRoot, 'checkpoints', 'pipe-1', 'checkpoint.json'), 'utf8')
  const checkpoint = JSON.parse(raw) as { stageStates: Record<string, { gate: { machine: { violations: Array<{ rule: string; detail: string }> } } }> }
  const violations = checkpoint.stageStates.execute!.gate.machine.violations
  // 执行会话缺失必须被判"未提供执行数据"，而不是默默放行一份没有执行证据的产物
  assert.match(JSON.stringify(violations), /executor execution data not provided/)
  assert.ok(violations.some(violation => violation.rule === 'R4-08'))
})

test('the execute stage passes once a real executor session is on disk', async () => {
  const probe = createPlatformHost(hostOptions(baseConfig()))
  const sessionPath = executorSessionPath(probe.roots.projectRoot, 'pipe-1')
  await mkdir(dirname(sessionPath), { recursive: true })
  // 空链是合法链：stub 模型产出的 design/execute 产物都没有用例与结果，对账自然为空集。
  await writeFile(sessionPath, JSON.stringify({ pipelineId: 'pipe-1', records: [], evidence: [] }), 'utf8')

  const { outcome } = await driveWithApprovals(configWithExecuteRules(['R4-08', 'R4-09', 'R4-10']))
  assert.deepEqual(outcome, { outcome: 'completed' })
})
