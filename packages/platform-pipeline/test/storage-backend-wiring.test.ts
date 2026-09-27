/**
 * 存储后端接入宿主装配（docs/11 P1-09）。
 *
 * 被验证的性质：宿主与 Web 服务**只从 `StorageBackend.ports` 取事实**，不再自己
 * `new FsArtifactStore` / `FsCheckpointPort` / `FileHumanGateTaskStore`。
 * 于是"换后端"就是换一个工厂函数——driver、门禁、工具、服务一行都不用改。
 *
 * 怎么证明"没有绕过 backend"：注入一个**内存后端**，跑一遍完整流程，然后断言
 * 端口拥有的那几个目录**根本没有被创建**。这比"检查代码里有没有 new Fs*"更可靠
 * ——它验证的是运行时行为，而不是文本。
 *
 * @module platform-pipeline/test/storage-backend-wiring
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { resolvePlatformRoots } from '../src/platform-roots.ts'
import { createPlatformHost } from '../src/runtime/platform-host.ts'
import type { PipelineConfig } from '../src/types.ts'
import {
  StorageUnavailableError,
  assertBackendPorts,
  createMemoryStorageBackend,
  type MemoryStorageBackend,
  type StorageBackend,
  type StorageBackendFactory,
  type StorageHealth,
} from '../src/storage/index.ts'
import { FilePipelineRunService } from '../src/web/pipeline-run-service.ts'
import { PipelineRunError } from '../src/web/pipeline-run-types.ts'
import { CREATE, REVIEWER, ScriptedHost, baseConfig } from './web-fixtures.ts'

let dir: string
let config: PipelineConfig

test.beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'pp-backend-wiring-'))
  config = baseConfig()
})
test.afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

/** 固定返回同一个后端实例：模拟"两个入口共享同一个后端"的部署形态。 */
function fixedFactory(backend: StorageBackend): StorageBackendFactory {
  return () => backend
}

function serviceOf(host: ScriptedHost, createStorageBackend?: StorageBackendFactory): FilePipelineRunService {
  return new FilePipelineRunService({
    dataRoot: dir,
    loadConfig: async () => config,
    createHost: host.factory,
    ...(createStorageBackend === undefined ? {} : { createStorageBackend }),
  })
}

/** 端口拥有的目录（这些目录一出现就说明有人绕过后端直接写文件）。 */
function portOwnedDirs(): readonly string[] {
  const roots = resolvePlatformRoots(dir, config)
  return [
    roots.checkpointRoot,
    // `artifactsRoot` **就是项目根**（产物路径自带 `artifacts/` 前缀），
    // 因此这里要检查的是它的 `artifacts/` 子目录。
    join(roots.projectRoot, 'artifacts'),
    join(roots.projectRoot, 'gates'),
    join(roots.projectRoot, 'usage'),
  ]
}

// ── 不绕过后端 ──────────────────────────────────────────────────────────────

test('注入内存后端后跑完整流程：端口拥有的目录一个都没被创建', async () => {
  const backend = createMemoryStorageBackend()
  const host = new ScriptedHost()
  const service = serviceOf(host, fixedFactory(backend))

  await service.create(CREATE, REVIEWER)
  const result = await service.run('pipe-1', REVIEWER)
  assert.equal(result.outcome, 'waiting-human', '脚本化宿主应当停在人工门')

  // 事实确实落在注入的后端里（而不是"哪里都没落"）。
  const keys = [...backend.raw.keys()]
  assert.ok(keys.some(key => key.startsWith('checkpoint:')), `检查点应落在内存后端：${keys.join(', ')}`)
  assert.ok(keys.some(key => key.startsWith('gate:')), `门任务应落在内存后端：${keys.join(', ')}`)
  assert.ok(keys.some(key => key.startsWith('artifact:')), `产物应落在内存后端：${keys.join(', ')}`)
  assert.ok(keys.some(key => key.startsWith('usage:')), `用量应落在内存后端：${keys.join(', ')}`)

  for (const owned of portOwnedDirs()) {
    assert.equal(existsSync(owned), false, `${owned} 不该存在：它已被换成内存后端，出现即说明有人绕过了 backend`)
  }

  // **幂等台账已经不在这个边界里**（docs/11 §二「事实来源统一」）：它通过
  // `ports.records` 走后端，因此换内存后端之后本地**不该**再出现 `idempotency/` 目录。
  // 这条断言就是"换后端换干净了"的运行时证据。
  const roots = resolvePlatformRoots(dir, config)
  assert.equal(existsSync(join(roots.projectRoot, 'idempotency')), false,
    '幂等台账必须走 backend.ports.records，不得在本地留下目录')
  assert.ok([...backend.raw.keys()].some(key => key.startsWith('record:idempotency/')),
    `幂等台账必须落在注入的后端里：${[...backend.raw.keys()].filter(key => key.startsWith('record:')).join(', ')}`)

  // **剩余边界**：流水线索引仍是 dataRoot 级的**宿主级文件记录**。它是 dataRoot 级、
  // 而 `StoragePorts` 是项目级，因此纳入后端需要先定作用域归属（见 docs/11 §13.3）。
  assert.equal(existsSync(join(dir, 'pipelines', 'pipe-1.json')), true, '流水线索引当前仍是文件记录（待裁决边界）')

  // 视图也必须从同一个后端重建。
  const view = await service.get('pipe-1', REVIEWER)
  assert.equal(view.status, 'waiting-human')
  assert.equal(view.stages.filter(stage => stage.status !== 'idle').length, 1)
})

test('宿主把后端的端口**原样**交给各部件，不做包装替换', async () => {
  const backend = createMemoryStorageBackend()
  const host = createPlatformHost({
    config: baseConfig({ llm: { defaultProvider: 'p', providers: { p: {
      type: 'openai-compatible', baseUrl: 'https://llm.invalid/v1', model: 'm',
      apiKeyEnv: 'PP_UNUSED_KEY', capabilities: { tools: true, structuredOutput: true },
    } } } }),
    dataRoot: dir,
    pipelineId: 'pipe-1',
    env: { PP_UNUSED_KEY: 'sk-not-used' },
    createStorageBackend: fixedFactory(backend),
  })

  assert.equal(host.backend, backend)
  assert.equal(host.ports, backend.ports)
  for (const port of ['artifacts', 'checkpoints', 'tasks', 'gateTasks', 'usage'] as const) {
    assert.equal(host.ports[port], backend.ports[port], `${port} 必须是后端自己的端口对象`)
  }
  // 缺省装配也要能通过端口完整性校验。
  assert.doesNotThrow(() => assertBackendPorts(host.backend))
})

test('两个 service 实例共享同一后端时，检查点与门任务互相可见', async () => {
  const backend = createMemoryStorageBackend()
  const first = serviceOf(new ScriptedHost(), fixedFactory(backend))
  await first.create(CREATE, REVIEWER)
  const parked = await first.run('pipe-1', REVIEWER)
  assert.equal(parked.outcome, 'waiting-human')
  const [task] = await first.listGateTasks({ projectId: 'demo', pipelineId: 'pipe-1' }, REVIEWER)

  // 另一个实例（模拟另一个进程）：同一后端 + 同一 dataRoot。
  const second = serviceOf(new ScriptedHost(), fixedFactory(backend))
  const view = await second.get('pipe-1', REVIEWER)
  assert.equal(view.status, 'waiting-human', '状态必须来自共享后端的检查点')
  assert.equal(view.openGateTaskId, task!.gateTaskId, '门任务也必须来自共享后端')
  const [taskAgain] = await second.listGateTasks({ projectId: 'demo', pipelineId: 'pipe-1' }, REVIEWER)
  assert.equal(taskAgain!.gateTaskId, task!.gateTaskId)
})

// ── 装配与健康检查的失败路径 ────────────────────────────────────────────────

test('后端缺必需端口时装配即失败，不静默退化成"某个功能不可用"', () => {
  const backend = createMemoryStorageBackend()
  const broken: StorageBackend = {
    name: 'broken',
    schemaVersion: backend.schemaVersion,
    ports: { ...backend.ports, checkpoints: undefined } as unknown as StorageBackend['ports'],
    describe: () => ({ name: 'broken', implementedPorts: ['artifacts'], unavailablePorts: [], requiresExternalInfrastructure: true }),
    diagnose: () => backend.diagnose(),
  }
  assert.throws(() => assertBackendPorts(broken), (error: unknown) => {
    assert.ok(error instanceof StorageUnavailableError)
    assert.match((error as Error).message, /必需端口缺失：checkpoints/)
    return true
  })
})

test('后端读不了记录（unreadable）时服务报 storage-unavailable，绝不降级到文件', async () => {
  const backend = createMemoryStorageBackend()
  const unhealthy: StorageBackend = {
    ...backend,
    name: 'unhealthy',
    diagnose: async (): Promise<StorageHealth> => ({
      backend: 'unhealthy',
      ok: false,
      schemaVersion: backend.schemaVersion,
      diagnostics: [{
        code: 'unreadable',
        kind: 'checkpoint',
        ref: 'checkpoint:pipe-1',
        detail: '磁盘不可读（测试注入）',
        recoverable: false,
      }],
    }),
  }
  const service = serviceOf(new ScriptedHost(), fixedFactory(unhealthy))
  await service.create(CREATE, REVIEWER)

  await assert.rejects(
    () => service.get('pipe-1', REVIEWER),
    (error: unknown) => {
      assert.ok(error instanceof PipelineRunError, `期望 PipelineRunError，实际 ${(error as Error)?.name}`)
      assert.equal(error.code, 'storage-unavailable')
      assert.match((error as Error).message, /磁盘不可读/)
      return true
    },
  )
})

test('单条记录损坏（corrupt-json）不阻断服务启动，只在体检里报告', async () => {
  const backend = createMemoryStorageBackend()
  const noisy: StorageBackend = {
    ...backend,
    name: 'noisy',
    diagnose: async (): Promise<StorageHealth> => ({
      backend: 'noisy',
      ok: false,
      schemaVersion: backend.schemaVersion,
      diagnostics: [{
        code: 'corrupt-json',
        kind: 'task',
        ref: 'task:t-1',
        detail: '不是合法 JSON',
        recoverable: false,
      }],
    }),
  }
  const service = serviceOf(new ScriptedHost(), fixedFactory(noisy))
  await service.create(CREATE, REVIEWER)
  // 坏的是**别的**记录：这条流水线照常可读（让整个服务起不来比坏一条记录更糟）。
  const view = await service.get('pipe-1', REVIEWER)
  assert.equal(view.status, 'queued')
})

// ── "换后端只改装配" ────────────────────────────────────────────────────────

test('同一段业务代码在文件后端与内存后端上得到相同结果（换后端只改装配）', async () => {
  // 每次运行用**独立**的 dataRoot：共用的话第二次 create 会命中幂等台账而重放首次结果
  // （那是正确行为），但这里要比较的是"同一段业务在两个后端上的结果"，不是幂等。
  async function runWith(createStorageBackend?: StorageBackendFactory): Promise<{
    readonly outcome: string
    readonly status: string
    readonly spawns: readonly string[]
  }> {
    const runDir = await mkdtemp(join(tmpdir(), 'pp-backend-switch-'))
    try {
      const host = new ScriptedHost()
      const service = new FilePipelineRunService({
        dataRoot: runDir,
        loadConfig: async () => config,
        createHost: host.factory,
        ...(createStorageBackend === undefined ? {} : { createStorageBackend }),
      })
      await service.create(CREATE, REVIEWER)
      const result = await service.run('pipe-1', REVIEWER)
      const view = await service.get('pipe-1', REVIEWER)
      return { outcome: result.outcome, status: view.status, spawns: [...host.stages] }
    } finally {
      await rm(runDir, { recursive: true, force: true })
    }
  }

  // 唯一的差别是"传不传后端工厂"——业务代码（ScriptedHost / driver / 门禁 / 服务层）
  // 一个字都没改。两者结果必须一致，否则说明某处偷偷依赖了后端实现细节。
  const memoryRun = await runWith(() => createMemoryStorageBackend())
  const fileRun = await runWith(undefined)

  assert.deepEqual(memoryRun, fileRun, '同一段业务代码在两个后端上必须得到相同结果')
  assert.equal(memoryRun.outcome, 'waiting-human')
  assert.deepEqual(memoryRun.spawns, ['receive'])
})

test('内存后端的锁端口也被宿主使用：并发 run 被同一把锁挡住', async () => {
  const backend = createMemoryStorageBackend()
  const first = serviceOf(new ScriptedHost(), fixedFactory(backend))
  await first.create(CREATE, REVIEWER)

  // 直接占用后端提供的锁（等价于"另一个进程正在跑"）。
  const lock = await backend.ports.lock!('pipe-1', { ownerId: 'other-owner' })
  try {
    await assert.rejects(
      () => first.run('pipe-1', REVIEWER),
      (error: unknown) => {
        assert.ok(error instanceof PipelineRunError)
        assert.equal(error.code, 'conflict', '抢不到锁必须是 conflict(409)，不是 500')
        return true
      },
    )
  } finally {
    await lock.release()
  }
})

test('内存后端的锁只在进程内有效这一边界仍被如实声明', () => {
  const backend: MemoryStorageBackend = createMemoryStorageBackend()
  const description = backend.describe()
  assert.equal(description.name, 'memory')
  assert.equal(description.requiresExternalInfrastructure, false)
  assert.deepEqual(description.unavailablePorts, [], '内存后端确实实现了全部端口，不伪装成不可用')
  assert.ok(description.implementedPorts.includes('lock'))
})
