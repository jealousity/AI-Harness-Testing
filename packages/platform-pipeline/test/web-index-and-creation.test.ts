/**
 * 索引存储一致性、创建中间态与幂等台账回退的失败路径测试（`docs/14` W2）。
 *
 * 这一组针对的是"**换后端只换了一半**"这类问题：它们不会在单后端、单进程、
 * 一次成功的路径上暴露，只有在**注入自定义存储**、**中途失败**、**重建实例**时才会显形。
 *
 * 覆盖四组：
 * 1. `list()` 必须走注入的索引存储（此前它调 `scanPipelineIndex(dataRoot)`，
 *    自己又 new 了一个默认文件存储，于是"详情能打开、列表里没有"）；
 * 2. 索引扫描必须区分**数据损坏**（只影响那一条）与**基础设施不可用**（整体抛出）；
 * 3. 创建中间态 `creationState: 'creating'` 必须可见、可报告、可接管；
 * 4. 幂等台账在后端端口不完整时不得静默回退到本地磁盘。
 *
 * @module platform-pipeline/test/web-index-and-creation
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import type { PipelineConfig } from '../src/types.ts'
import { createFileStorageBackendFromRoots } from '../src/storage/file/index.ts'
import { createMemoryStorageBackend } from '../src/storage/memory/index.ts'
import {
  StorageCorruptError,
  StorageUnavailableError,
  assertBackendPorts,
  type HostRecord,
  type HostRecordStore,
  type StorageBackend,
} from '../src/storage/ports.ts'
import { AsyncPipelineRunner } from '../src/web/async-runner.ts'
import {
  PIPELINE_INDEX_COLLECTION,
  FilePipelineRunService,
  scanPipelineIndexFrom,
} from '../src/web/pipeline-run-service.ts'
import { PipelineRunError, toPipelineRunError } from '../src/web/pipeline-run-types.ts'
import { CREATE, REVIEWER, SCOPE, ScriptedHost, baseConfig } from './web-fixtures.ts'

let dir: string
let config: PipelineConfig

test.beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'pp-w2-'))
  config = baseConfig()
})
test.afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

/** 一个真实的、可用的内存索引存储（不是桩：它就是 memory 后端的 records 端口）。 */
function memoryStore(): HostRecordStore {
  return createMemoryStorageBackend().ports.records as HostRecordStore
}

function serviceWith(options: {
  readonly store?: HostRecordStore
  readonly backend?: (roots: any) => StorageBackend
}): FilePipelineRunService {
  const host = new ScriptedHost()
  return new FilePipelineRunService({
    dataRoot: dir,
    loadConfig: async () => config,
    createHost: host.factory,
    ...(options.store === undefined ? {} : { createHostRecordStore: () => options.store as HostRecordStore }),
    ...(options.backend === undefined ? {} : { createStorageBackend: options.backend }),
  })
}

/** 索引存储：所有操作都抛基础设施故障（模拟外部后端断开）。 */
function unavailableStore(): HostRecordStore {
  const boom = (): never => { throw new StorageUnavailableError('test-index', 'op', '模拟索引后端不可用') }
  return {
    read: async () => boom(),
    write: async () => boom(),
    createIfAbsent: async () => boom(),
    listIds: async () => boom(),
    list: async () => boom(),
    remove: async () => boom(),
  }
}

/** 索引存储：某一条读出来是坏的（数据问题），其余正常。 */
function oneCorruptStore(inner: HostRecordStore, corruptId: string): HostRecordStore {
  return {
    ...inner,
    read: async (collection: string, id: string) => {
      if (collection === PIPELINE_INDEX_COLLECTION && id === corruptId) {
        throw new StorageCorruptError(`${id}.json`, 'record', '模拟单条索引损坏')
      }
      return inner.read(collection, id)
    },
    listIds: (collection: string) => inner.listIds(collection),
    write: (collection: string, id: string, value: unknown) => inner.write(collection, id, value),
    createIfAbsent: (collection: string, id: string, value: unknown) => inner.createIfAbsent(collection, id, value),
    list: (collection: string) => inner.list(collection),
    remove: (collection: string, id: string) => inner.remove(collection, id),
  }
}

// ── 1. list() 必须走注入的索引存储 ────────────────────────────────────────────

test('W2：注入自定义索引存储后，list() 必须看得见（此前会去扫本地文件目录）', async () => {
  const store = memoryStore()
  const service = serviceWith({ store })
  await service.create(CREATE, REVIEWER)

  // 索引确实落在注入的存储里。
  assert.deepEqual(await store.listIds(PIPELINE_INDEX_COLLECTION), ['pipe-1'])
  // 本地**不该**出现 pipelines/ 目录（否则说明有一条旁路仍在写文件）。
  assert.equal(existsSync(join(dir, 'pipelines')), false, '注入索引存储后本地不得再出现 pipelines/')

  const listed = await service.list(REVIEWER)
  assert.deepEqual(listed.map(item => item.pipelineId), ['pipe-1'],
    `list() 必须读注入的索引存储，实际：${JSON.stringify(listed)}`)

  // 详情与列表必须给出同一份事实。
  const view = await service.get('pipe-1', REVIEWER)
  assert.equal(view.pipelineId, 'pipe-1')
  assert.equal(view.projectId, listed[0]!.projectId)
})

test('W2：注入自定义索引存储后，重建 service 实例仍能 get/list', async () => {
  const store = memoryStore()
  await serviceWith({ store }).create(CREATE, REVIEWER)

  // 新实例（模拟进程重启）：只共享同一份索引存储。
  const restarted = serviceWith({ store })
  assert.equal((await restarted.get('pipe-1', REVIEWER)).pipelineId, 'pipe-1')
  assert.deepEqual((await restarted.list(REVIEWER)).map(item => item.pipelineId), ['pipe-1'])
})

test('W2：恢复扫描与 service 必须使用同一个索引存储（否则"看不见任何流水线"）', async () => {
  const store = memoryStore()
  const service = serviceWith({ store })
  await service.create(CREATE, REVIEWER)

  const runner = new AsyncPipelineRunner({
    service,
    dataRoot: dir,
    actor: { actorId: 'runner', tenantId: 'acme' },
    createHostRecordStore: () => store,
  })
  const outcomes = await runner.recover()
  assert.deepEqual(outcomes.map(item => item.pipelineId), ['pipe-1'],
    '恢复扫描必须通过同一个索引存储看见这条流水线')
  await runner.idle()
})

// ── 2. 索引扫描的错误分类 ─────────────────────────────────────────────────────

test('W2：索引存储不可用时，list() 必须整体失败（503），不得返回空列表', async () => {
  const service = serviceWith({ store: unavailableStore() })
  const error = await service.list(REVIEWER).catch((thrown: unknown) => thrown)

  // service 层的约定是**抛原始存储错误**（`StorageUnavailableError`），由 HTTP 外壳
  // 经 `toPipelineRunError` 统一映射。这里同时钉住两件事：错误类型 + 最终状态码。
  assert.ok(error instanceof StorageUnavailableError, `期望 StorageUnavailableError，实际 ${String(error)}`)
  const mapped = toPipelineRunError(error)
  assert.equal(mapped.code, 'storage-unavailable')
  assert.equal(mapped.httpStatus, 503,
    '基础设施故障不能被降级成"没有流水线"：返回空列表会让运维以为数据没了')
})

test('W2：索引存储不可用时，恢复扫描必须整体失败，不得报成几条 unreadable', async () => {
  const store = memoryStore()
  const service = serviceWith({ store })
  await service.create(CREATE, REVIEWER)

  // 换成不可用的存储：恢复扫描必须炸，而不是返回"0 条需要恢复"。
  const runner = new AsyncPipelineRunner({
    service,
    dataRoot: dir,
    actor: { actorId: 'runner', tenantId: 'acme' },
    createHostRecordStore: () => unavailableStore(),
  })
  const error = await runner.recover().catch((thrown: unknown) => thrown)
  assert.ok(error instanceof StorageUnavailableError, `期望 StorageUnavailableError，实际 ${String(error)}`)
  await runner.idle()
})

test('W2：单条索引损坏只报告那一条，其余照常返回', async () => {
  const inner = memoryStore()
  await inner.write(PIPELINE_INDEX_COLLECTION, 'good', {
    pipelineId: 'good', tenantId: 'acme', projectId: 'demo', configRef: 'pipeline.yaml',
  })
  await inner.write(PIPELINE_INDEX_COLLECTION, 'broken', {
    pipelineId: 'broken', tenantId: 'acme', projectId: 'demo', configRef: 'pipeline.yaml',
  })
  await inner.write(PIPELINE_INDEX_COLLECTION, 'mismatch', {
    pipelineId: 'other-id', tenantId: 'acme', projectId: 'demo', configRef: 'pipeline.yaml',
  })

  const scan = await scanPipelineIndexFrom(oneCorruptStore(inner, 'broken'))
  assert.deepEqual(scan.entries.map(entry => entry.pipelineId), ['good'])
  assert.deepEqual(scan.unreadable.map(item => item.file).sort(), ['broken.json', 'mismatch.json'],
    '损坏与键不一致都必须只影响自己那一条')
})

// ── 3. 创建中间态 ─────────────────────────────────────────────────────────────

test('W2：检查点写入失败时，索引停在 creating，恢复扫描报 creation-incomplete', async () => {
  const store = memoryStore()
  const service = serviceWith({
    store,
    backend: roots => {
      const base = createFileStorageBackendFromRoots(roots)
      return {
        ...base,
        ports: {
          ...base.ports,
          checkpoints: {
            load: base.ports.checkpoints.load,
            save: async () => { throw new StorageUnavailableError('test', 'checkpoint.save', '模拟检查点写失败') },
          },
        },
      }
    },
  })

  await assert.rejects(() => service.create(CREATE, REVIEWER))

  // 关键：这次失败的创建**必须留下可见痕迹**，而不是"凭空消失的一次创建"。
  const raw = await store.read(PIPELINE_INDEX_COLLECTION, 'pipe-1') as { creationState?: string }
  assert.equal(raw?.creationState, 'creating', '检查点失败后索引必须停在 creating')

  const runner = new AsyncPipelineRunner({
    service, dataRoot: dir, actor: { actorId: 'runner', tenantId: 'acme' },
    createHostRecordStore: () => store,
  })
  const outcomes = await runner.recover()
  const mine = outcomes.find(item => item.pipelineId === 'pipe-1')
  assert.ok(mine !== undefined, `恢复扫描必须报告这条中间态：${JSON.stringify(outcomes)}`)
  assert.equal(mine.action, 'creation-incomplete',
    '必须报 creation-incomplete，而不是 unreadable（记录本身完全可读）')
  assert.equal(mine.started, false, '中间态绝不能被自动启动')
  await runner.idle()
})

test('W2：创建中间态下 get 给出可操作答复，而不是 404', async () => {
  const store = memoryStore()
  const service = serviceWith({
    store,
    backend: roots => {
      const base = createFileStorageBackendFromRoots(roots)
      return {
        ...base,
        ports: {
          ...base.ports,
          checkpoints: {
            load: base.ports.checkpoints.load,
            save: async () => { throw new StorageUnavailableError('test', 'checkpoint.save', '模拟检查点写失败') },
          },
        },
      }
    },
  })
  await assert.rejects(() => service.create(CREATE, REVIEWER))

  const error = await service.get('pipe-1', REVIEWER).catch((thrown: unknown) => thrown)
  assert.ok(error instanceof PipelineRunError)
  assert.equal(error.code, 'conflict', '中间态是"状态不允许"，不是"不存在"（404 会让人以为从没建过）')
  assert.match(String(error.details.hint ?? ''), /重新 create/,
    '必须告诉运维怎么恢复，而不是只说状态冲突')
})

test('W2：创建中间态可以被同一 pipelineId 重新 create 接管', async () => {
  const store = memoryStore()
  let failCheckpoints = true
  const service = serviceWith({
    store,
    backend: roots => {
      const base = createFileStorageBackendFromRoots(roots)
      return {
        ...base,
        ports: {
          ...base.ports,
          checkpoints: {
            load: base.ports.checkpoints.load,
            save: async (root: string, checkpoint: any) => {
              if (failCheckpoints) throw new StorageUnavailableError('test', 'checkpoint.save', '模拟检查点写失败')
              return base.ports.checkpoints.save(root, checkpoint)
            },
          },
        },
      }
    },
  })

  await assert.rejects(() => service.create(CREATE, REVIEWER))
  failCheckpoints = false

  // 接管：同一 pipelineId、同一指纹 → 必须成功，而不是永久 conflict。
  const summary = await service.create(CREATE, REVIEWER)
  assert.equal(summary.pipelineId, 'pipe-1')
  const raw = await store.read(PIPELINE_INDEX_COLLECTION, 'pipe-1') as { creationState?: string }
  assert.equal(raw?.creationState, 'ready', '接管成功后必须翻成 ready')
  assert.equal((await service.get('pipe-1', REVIEWER)).status, 'queued')
})

test('W2：中间态可被接管，但**不同指纹**仍然拒绝（不静默复用）', async () => {
  const store = memoryStore()
  // 手工造一条中间态索引：模拟"上一次创建换了参数还没写完"。
  await store.write(PIPELINE_INDEX_COLLECTION, 'pipe-1', {
    pipelineId: 'pipe-1', tenantId: 'acme', projectId: 'demo', configRef: 'pipeline.yaml',
    creationState: 'creating',
  })

  const service = serviceWith({ store })
  // 同指纹：接管成功。
  await service.create(CREATE, REVIEWER)

  // 换一个会影响运行行为的参数 → 台账指纹不同 → 必须 409，不得静默复用。
  const divergent = await service
    .create({ ...CREATE, targetBaseUrl: 'https://staging.example.com' }, REVIEWER)
    .catch((thrown: unknown) => thrown)
  assert.ok(divergent instanceof PipelineRunError, `期望 PipelineRunError，实际 ${String(divergent)}`)
  assert.equal(divergent.code, 'conflict', '同 pipelineId 换行为参数必须 409')
})

// ── 4. 幂等台账回退策略 ───────────────────────────────────────────────────────

test('W2：声明外部基础设施的后端缺 records → 装配即失败（不静默回退本地磁盘）', async () => {
  const base = createMemoryStorageBackend()
  const externalWithoutRecords: StorageBackend = {
    ...base,
    name: 'fake-external',
    ports: { ...base.ports, records: undefined },
    describe: () => ({
      name: 'fake-external',
      implementedPorts: ['artifacts', 'checkpoints', 'tasks', 'gateTasks', 'usage', 'audit'],
      unavailablePorts: [],
      requiresExternalInfrastructure: true,
    }),
  }
  assert.throws(
    () => assertBackendPorts(externalWithoutRecords),
    (error: unknown) => {
      assert.ok(error instanceof StorageUnavailableError)
      assert.match(String(error), /records/, '错误必须点名缺失的端口')
      return true
    },
  )
})

test('W2：本地后端缺 records 仍允许装配（不产生跨副本分裂）', async () => {
  const base = createMemoryStorageBackend()
  const localWithoutRecords: StorageBackend = {
    ...base,
    ports: { ...base.ports, records: undefined },
    // 夹具必须**自洽**：ports 里没有的端口，`describe().implementedPorts` 就不能声称实现，
    // 否则 `assertBackendPorts` 会以"声称实现但实际缺失"报错——那是另一条规则。
    describe: () => ({
      ...base.describe(),
      implementedPorts: base.describe().implementedPorts.filter(port => port !== 'records'),
    }),
  }
  assert.doesNotThrow(() => assertBackendPorts(localWithoutRecords),
    '本地后端与其它端口同机，回退不产生跨副本分裂')
})

test('W2：外部后端缺 records 时，create 报 storage-unavailable 而不是写本地台账', async () => {
  const base = createMemoryStorageBackend()
  const externalWithoutRecords: StorageBackend = {
    ...base,
    name: 'fake-external',
    ports: { ...base.ports, records: undefined },
    describe: () => ({
      name: 'fake-external',
      implementedPorts: ['artifacts', 'checkpoints', 'tasks', 'gateTasks', 'usage', 'audit'],
      unavailablePorts: [],
      requiresExternalInfrastructure: true,
    }),
  }
  const service = serviceWith({ backend: () => externalWithoutRecords })

  const error = await service.create(CREATE, REVIEWER).catch((thrown: unknown) => thrown)
  // **装配即失败**：`backendOf` 会先跑 `assertBackendPorts`，因此这里拿到的是
  // 原始存储错误；外壳映射成 503。`runIdempotent` 里那条同规则检查是纵深防御
  // （只对"装配后被改动过端口"的后端可达），正常路径到不了。
  assert.ok(error instanceof StorageUnavailableError, `期望 StorageUnavailableError，实际 ${String(error)}`)
  assert.equal(toPipelineRunError(error).httpStatus, 503)

  // 关键：**不得**在本地留下 idempotency 目录（那正是"静默回退"的证据）。
  const roots = join(dir, 'tenants', 'acme', 'projects', 'demo')
  assert.equal(existsSync(join(roots, 'idempotency')), false,
    '外部后端缺 records 时绝不能静默把台账写到本地磁盘')
})
