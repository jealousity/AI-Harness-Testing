/**
 * 外部后端接口层 + 后端组合的测试（docs/10 §8.3 M4-B、§8.4、§10 P1-B 第 3 条）。
 *
 * 三块内容：
 * 1. **组合后端跑同一套契约**——`composeStorageBackends` 拼出来的后端必须与单后端
 *    同样通过 `test/storage-contract.ts`。只测单后端时，"组合层偷偷改变了语义"
 *    这件事没有任何用例会报警。
 * 2. **接口层的行为**——PostgreSQL / 对象存储的端口映射、事务边界、DDL、键约定、
 *    错误分类；以及最重要的一条：**未配置时明确失败、绝不降级**。
 * 3. **§8.4 最后一条的端到端证据**——"外部存储不可用时状态明确为 infrastructure
 *    failure，不自动批准或覆盖旧数据"：用真实的 `PipelineDriver` 跑一遍。
 *
 * @module platform-pipeline/test/storage-external
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PipelineDriver, type ArtifactStore, type CheckpointPort, type HumanGatePort } from '../src/driver.ts'
import { MachineGateEngine, computeArtifactDigest } from '../src/gates/machine.ts'
import { normalizeConfig } from '../src/config.ts'
import { toPipelineRunError } from '../src/web/pipeline-run-types.ts'
import type { SpawnRequest, SpawnedRun, StageSpawner } from '../src/stage-spawner.ts'
import type { Checkpoint, StageArtifact, StageId } from '../src/types.ts'
import {
  OBJECT_KEY_ROOTS,
  POSTGRES_PORT_TABLES,
  POSTGRES_TABLES,
  POSTGRES_TRANSACTION_BOUNDARIES,
  STORAGE_SCHEMA_VERSION,
  StorageCorruptError,
  StorageUnavailableError,
  artifactObjectKey,
  assertKeyInProject,
  assertSafeObjectKey,
  caseObjectKey,
  classifyObjectStoreError,
  classifyPostgresError,
  composeStorageBackends,
  createMemoryStorageBackend,
  describeObjectStoreBackend,
  describePostgresBackend,
  evidenceObjectKey,
  isStorageDataError,
  isStorageInfrastructureError,
  knowledgeObjectKey,
  postgresSchemaDdl,
  requireObjectStoreClient,
  requirePostgresClient,
  type ComposedStorageBackend,
  type MemoryStorageBackend,
  type PostgresClient,
  type StorageBackend,
  type StoragePorts,
} from '../src/storage/index.ts'
import { makeCheckpoint, runStorageContract } from './storage-contract.ts'

const CHECKPOINT_ROOT = 'checkpoints'

// ── 组合夹具 ────────────────────────────────────────────────────────────────────

const RECORD_PORTS = ['checkpoints', 'tasks', 'gateTasks', 'usage', 'audit', 'lock'] as const
const OBJECT_PORTS = ['artifacts', 'knowledge', 'cases'] as const

interface Fixture {
  readonly backend: ComposedStorageBackend
  readonly records: MemoryStorageBackend
  readonly objects: MemoryStorageBackend
}

/**
 * 只暴露一部分端口的后端。
 *
 * 组合层要测的是"两个不重叠的部分拼成一个完整后端"，所以夹具必须能造出**局部**后端。
 * 用内存后端当底座，因为这里要验的是组合逻辑，不是某种外部基础设施。
 */
function subset(source: MemoryStorageBackend, name: string, keep: readonly string[]): StorageBackend {
  const ports: Record<string, unknown> = {}
  for (const port of keep) ports[port] = (source.ports as unknown as Record<string, unknown>)[port]
  return {
    name,
    schemaVersion: source.schemaVersion,
    ports: ports as unknown as StoragePorts,
    describe: () => ({ name, implementedPorts: [...keep], unavailablePorts: [], requiresExternalInfrastructure: true }),
    diagnose: () => source.diagnose(),
    migrate: () => source.migrate!(),
  }
}

function makeFixture(): Fixture {
  const records = createMemoryStorageBackend()
  const objects = createMemoryStorageBackend()
  const backend = composeStorageBackends({
    name: 'composed',
    parts: [
      { role: 'records', backend: subset(records, 'records', RECORD_PORTS) },
      { role: 'objects', backend: subset(objects, 'objects', OBJECT_PORTS) },
    ],
  })
  return { backend, records, objects }
}

/**
 * 当前用例的夹具。
 *
 * 契约套件的钩子只拿到 `(backend, checkpointRoot)`——刻意不暴露实现路径。
 * 顶层用例在文件内顺序执行，所以这个变量在每条用例内都是稳定的（与
 * `test/storage-file.test.ts` 的 `currentDir` 同一手法）。
 */
let current: Fixture | undefined

function requireCurrent(): Fixture {
  assert.notEqual(current, undefined, '钩子只能在用例体内调用：create() 已经建好夹具')
  return current!
}

runStorageContract({
  name: 'composed',
  create: async () => {
    const fixture = makeFixture()
    current = fixture
    return {
      backend: fixture.backend,
      checkpointRoot: CHECKPOINT_ROOT,
      cleanup: async () => { current = undefined },
    }
  },
  seedLegacyRecord: async context => {
    requireCurrent().records.raw.set(`checkpoint:${CHECKPOINT_ROOT}`, JSON.stringify(makeCheckpoint('legacy')))
    return {
      ref: `checkpoint:${CHECKPOINT_ROOT}`,
      read: () => context.backend.ports.checkpoints.load(CHECKPOINT_ROOT),
    }
  },
  hooks: {
    corruptCheckpoint: async () => {
      requireCurrent().records.raw.set(`checkpoint:${CHECKPOINT_ROOT}`, '{"pipelineId":"p1","cursor":')
    },
    seedFutureCheckpoint: async () => {
      requireCurrent().records.raw.set(`checkpoint:${CHECKPOINT_ROOT}`, JSON.stringify({ ...makeCheckpoint('p1'), schemaVersion: 99 }))
    },
    appendRawUsageLine: async (_backend, pipelineId, line) => {
      const raw = requireCurrent().records.raw
      const key = `usage:${pipelineId}`
      raw.set(key, `${raw.get(key) ?? ''}${line}\n`)
    },
  },
})

// ── 组合层专有 ──────────────────────────────────────────────────────────────────

test('[compose] 端口来源可查：产物来自 objects，检查点来自 records', () => {
  const { backend } = makeFixture()
  assert.equal(backend.portOrigins.get('artifacts'), 'objects')
  assert.equal(backend.portOrigins.get('knowledge'), 'objects')
  assert.equal(backend.portOrigins.get('cases'), 'objects')
  assert.equal(backend.portOrigins.get('checkpoints'), 'records')
  assert.equal(backend.portOrigins.get('lock'), 'records')

  const description = backend.describe()
  assert.equal(description.name, 'composed')
  assert.equal(description.requiresExternalInfrastructure, true, '有部分依赖外部基础设施，组合后就必须如实说需要')
  assert.deepEqual(
    [...description.implementedPorts].sort(),
    [...RECORD_PORTS, ...OBJECT_PORTS].sort(),
  )
})

test('[compose] 同一个端口被两个部分提供时拒绝装配，不替宿主猜优先级', () => {
  const records = createMemoryStorageBackend()
  const objects = createMemoryStorageBackend()
  assert.throws(
    () => composeStorageBackends({
      parts: [
        { role: 'records', backend: subset(records, 'records', ['checkpoints', 'artifacts']) },
        { role: 'objects', backend: subset(objects, 'objects', ['artifacts']) },
      ],
    }),
    (error: unknown) => {
      assert.ok(error instanceof StorageUnavailableError)
      assert.match((error as Error).message, /artifacts 被多个部分同时提供/)
      return true
    },
  )
})

test('[compose] 宿主用 overrides 明确表态时，端口冲突不再报错且覆盖优先', () => {
  const records = createMemoryStorageBackend()
  const objects = createMemoryStorageBackend()
  const chosen = objects.ports.artifacts
  const backend = composeStorageBackends({
    parts: [
      { role: 'records', backend: subset(records, 'records', ['checkpoints', 'tasks', 'gateTasks', 'usage', 'audit', 'artifacts']) },
      { role: 'objects', backend: subset(objects, 'objects', ['artifacts']) },
    ],
    overrides: { artifacts: chosen },
  })
  assert.equal(backend.portOrigins.get('artifacts'), 'override')
  assert.equal(backend.ports.artifacts, chosen)
})

test('[compose] 各部分 schemaVersion 不一致时拒绝装配（同一进程不允许两套记录格式）', () => {
  const records = createMemoryStorageBackend()
  const objects = createMemoryStorageBackend()
  const skewed: StorageBackend = { ...subset(objects, 'skewed', OBJECT_PORTS), schemaVersion: STORAGE_SCHEMA_VERSION + 1 }
  assert.throws(
    () => composeStorageBackends({
      parts: [
        { role: 'records', backend: subset(records, 'records', RECORD_PORTS) },
        { role: 'objects', backend: skewed },
      ],
    }),
    (error: unknown) => {
      assert.ok(error instanceof StorageUnavailableError)
      assert.match((error as Error).message, /schemaVersion 不一致/)
      return true
    },
  )
})

test('[compose] 同一角色出现两次时拒绝装配', () => {
  const a = createMemoryStorageBackend()
  const b = createMemoryStorageBackend()
  assert.throws(
    () => composeStorageBackends({
      parts: [
        { role: 'records', backend: subset(a, 'a', ['checkpoints']) },
        { role: 'records', backend: subset(b, 'b', ['tasks']) },
      ],
    }),
    /角色 records 被提供了两次/,
  )
})

test('[compose] 拼不出必需端口时装配即失败（而不是等第一次跑流水线）', () => {
  const objects = createMemoryStorageBackend()
  assert.throws(
    () => composeStorageBackends({ parts: [{ role: 'objects', backend: subset(objects, 'objects', ['artifacts']) }] }),
    (error: unknown) => {
      assert.ok(error instanceof StorageUnavailableError)
      assert.match((error as Error).message, /必需端口缺失/)
      return true
    },
  )
})

test('[compose] 部分的 unavailablePorts 会向上冒泡，但已被别的部分补上的不算', () => {
  const records = createMemoryStorageBackend()
  const objects = createMemoryStorageBackend()
  const partial: StorageBackend = {
    ...subset(objects, 'objects', ['artifacts']),
    describe: () => ({
      name: 'objects',
      implementedPorts: ['artifacts'],
      unavailablePorts: [
        { port: 'checkpoints', reason: '对象存储没有条件写' },
        { port: 'cases', reason: '本部署未启用用例回流' },
      ],
      requiresExternalInfrastructure: true,
    }),
  }
  const backend = composeStorageBackends({
    parts: [
      { role: 'records', backend: subset(records, 'records', RECORD_PORTS) },
      { role: 'objects', backend: partial },
    ],
  })
  const ports = backend.describe().unavailablePorts.map(item => item.port)
  assert.deepEqual(ports, ['cases'], 'checkpoints 已由 records 提供，不该再报不可用')
  assert.match(backend.describe().unavailablePorts[0]!.reason, /objects/)
})

test('[compose] 迁移按部分执行并合并成一份账，备份目录不一致时不谎报', async () => {
  const records = createMemoryStorageBackend()
  const objects = createMemoryStorageBackend()
  records.raw.set(`checkpoint:${CHECKPOINT_ROOT}`, JSON.stringify(makeCheckpoint('legacy')))
  const backend = composeStorageBackends({
    name: 'composed',
    parts: [
      { role: 'records', backend: subset(records, 'records', RECORD_PORTS) },
      { role: 'objects', backend: subset(objects, 'objects', OBJECT_PORTS) },
    ],
  })

  const report = await backend.migrate()
  assert.equal(report.backend, 'composed')
  assert.equal(report.migrated.length, 1)
  assert.equal(report.migrated[0]!.ref, `records/checkpoint:${CHECKPOINT_ROOT}`, '合并后的 ref 必须带部分名，否则两个部分报同一相对路径时分不清')
  assert.deepEqual(report.parts.map(part => part.role), ['records', 'objects'])
  // 内存后端没有磁盘备份，所以两部分都是 null → 合并后也不该编一个目录出来。
  assert.equal(report.backupDir, null)
})

// ── PostgreSQL 接口层 ───────────────────────────────────────────────────────────

test('[postgres] 未配置时明确失败：不返回空实现，也不降级到文件后端', () => {
  for (const options of [{}, { connectionString: 'postgres://user:pw@localhost:5432/db' }]) {
    assert.throws(
      () => requirePostgresClient(options),
      (error: unknown) => {
        assert.ok(error instanceof StorageUnavailableError, `期望 StorageUnavailableError，实际 ${(error as Error)?.name}`)
        assert.equal((error as StorageUnavailableError).backend, 'postgres')
        assert.equal(isStorageInfrastructureError(error), true)
        assert.match((error as Error).message, /不会.*自动降级到文件后端/)
        return true
      },
    )
  }
})

test('[postgres] 注入 client 后原样返回同一个客户端（本层不做任何包装）', () => {
  const client = {
    query: async () => ({ rows: [], rowCount: 0 }),
    transaction: async (work: (tx: unknown) => Promise<unknown>) => work({}),
  } as unknown as PostgresClient
  assert.equal(requirePostgresClient({ client }), client)
})

test('[postgres] 能力声明：六个记录端口 + 明确把大对象让给 object-store', () => {
  const description = describePostgresBackend()
  assert.equal(description.name, 'postgres')
  assert.equal(description.requiresExternalInfrastructure, true)
  assert.deepEqual(
    [...description.implementedPorts].sort(),
    ['audit', 'checkpoints', 'gateTasks', 'lock', 'tasks', 'usage'],
  )
  const unavailable = description.unavailablePorts.map(item => item.port).sort()
  assert.deepEqual(unavailable, ['artifacts', 'cases', 'knowledge'])
  for (const item of description.unavailablePorts) assert.notEqual(item.reason.trim(), '')
})

test('[postgres] 端口↔表映射与 DDL 一致：映射里的表都真的建了', () => {
  const ddl = postgresSchemaDdl()
  for (const [port, tables] of Object.entries(POSTGRES_PORT_TABLES)) {
    assert.ok(tables.length > 0, `${port} 必须有表`)
    for (const table of tables) {
      assert.ok(ddl.includes(table), `${port} 映射到 ${table}，但 DDL 里没有它`)
    }
  }
  // 反向：DDL 里的表也必须都在映射里，否则就是没人用的死表。
  const mapped = new Set(Object.values(POSTGRES_PORT_TABLES).flat())
  for (const table of Object.values(POSTGRES_TABLES)) {
    if (table === POSTGRES_TABLES.schemaMeta) continue
    assert.ok(mapped.has(table), `DDL 建了 ${table}，但没有任何端口映射到它`)
  }
})

test('[postgres] DDL 幂等且对 schema 名做白名单校验（防 DDL 注入）', () => {
  assert.equal(postgresSchemaDdl(), postgresSchemaDdl(), '同样的入参必须生成同样的 DDL')
  assert.ok(postgresSchemaDdl().includes('CREATE SCHEMA IF NOT EXISTS public'))
  assert.ok(postgresSchemaDdl('app').includes('app.pipeline_checkpoint'))
  for (const bad of ['Public', 'a-b', 'a.b', 'x; DROP TABLE y', '', '1abc']) {
    assert.throws(() => postgresSchemaDdl(bad), StorageUnavailableError, `schema 名 ${JSON.stringify(bad)} 必须被拒绝`)
  }
})

test('[postgres] 事务边界覆盖 checkpoints 与 gateTasks，且每条都写清了理由', () => {
  const ids = POSTGRES_TRANSACTION_BOUNDARIES.map(item => item.id)
  for (const required of ['checkpoint-save', 'gate-decide', 'gate-consume', 'artifact-then-checkpoint']) {
    assert.ok(ids.includes(required), `缺少事务边界 ${required}（§8.4 要求 checkpoint 与 gate task 的事务边界清晰）`)
  }
  for (const item of POSTGRES_TRANSACTION_BOUNDARIES) {
    assert.ok(item.why.length > 20, `${item.id} 的 why 太短，等于没解释`)
    assert.ok(item.ports.length > 0)
    assert.notEqual(item.isolation.trim(), '')
  }
  // 跨存储那条必须明确"不做分布式事务"，否则后来者会以为它是原子的。
  const crossStore = POSTGRES_TRANSACTION_BOUNDARIES.find(item => item.id === 'artifact-then-checkpoint')!
  assert.match(crossStore.isolation, /n\/a/)
  assert.match(crossStore.why, /先写产物、后写检查点/)
})

test('[postgres] 错误分类：数据异常归损坏，连接/资源/死锁归不可用，未知一律不可用', () => {
  const corrupt = classifyPostgresError({ code: '22P02' }, 'load checkpoint', 'checkpoint', 'p1')
  assert.ok(corrupt instanceof StorageCorruptError)
  assert.equal(isStorageDataError(corrupt), true)

  for (const code of ['08006', '53300', '57P01', '40001', '42P01', '28P01']) {
    const error = classifyPostgresError({ code }, 'save checkpoint', 'checkpoint')
    assert.ok(error instanceof StorageUnavailableError, `SQLSTATE ${code} 应归基础设施故障`)
    assert.match((error as Error).message, new RegExp(code))
  }

  // 没有 code 的未知错误 → 不可用（fail-safe 方向：宁可说"存储坏了"，也不能说"没有数据"）。
  const unknown = classifyPostgresError(new Error('socket hang up'), 'save checkpoint', 'checkpoint')
  assert.ok(unknown instanceof StorageUnavailableError)
  assert.match((unknown as Error).message, /socket hang up/)

  // 已经是本平台的错误 → 原样返回，不二次包装（否则 cause 链会被吃掉）。
  const original = new StorageUnavailableError('postgres', 'op', 'x')
  assert.equal(classifyPostgresError(original, 'save checkpoint', 'checkpoint'), original)
})

// ── 对象存储接口层 ──────────────────────────────────────────────────────────────

test('[object-store] 未配置时明确失败：不返回空实现，也不降级到文件后端', () => {
  for (const options of [{}, { bucket: 'pp-artifacts', endpoint: 'http://localhost:9000' }]) {
    assert.throws(
      () => requireObjectStoreClient(options),
      (error: unknown) => {
        assert.ok(error instanceof StorageUnavailableError)
        assert.equal((error as StorageUnavailableError).backend, 'object-store')
        assert.match((error as Error).message, /不会.*自动降级到文件后端/)
        return true
      },
    )
  }
})

test('[object-store] 键约定：四个根前缀各司其职', () => {
  assert.equal(
    artifactObjectKey({ projectId: 'proj', pipelineId: 'p1', stageId: 'receive' }),
    'artifacts/proj/p1/receive.json',
  )
  assert.equal(
    evidenceObjectKey({ projectId: 'proj', pipelineId: 'p1', stageId: 'execute', name: 'trace.log' }),
    'evidence/proj/p1/execute/trace.log',
  )
  assert.equal(knowledgeObjectKey({ projectId: 'proj', entryId: 'kb-1' }), 'knowledge/proj/kb-1.md')
  assert.equal(caseObjectKey({ projectId: 'proj', caseId: 'c1' }), 'cases/proj/c1.json')
  // 键必须自带项目段：这是对象存储里项目作用域的唯一表达方式。
  assert.equal(assertKeyInProject('cases/proj/c1.json', 'proj'), 'cases/proj/c1.json')
  assert.deepEqual(Object.values(OBJECT_KEY_ROOTS), ['artifacts', 'evidence', 'knowledge', 'cases'])
})

test('[object-store] 键校验：相对段、绝对路径、空段、未知根前缀、跨项目一律拒绝', () => {
  for (const bad of [
    'artifacts/../secrets.json',
    '/artifacts/proj/p1/receive.json',
    'artifacts//proj/p1/receive.json',
    'artifacts/proj/p1/',
    'artifacts\\proj\\p1\\receive.json',
    'unknown/proj/p1/receive.json',
    '',
    `artifacts/${'x'.repeat(1200)}`,
  ]) {
    assert.throws(() => assertSafeObjectKey(bad), StorageUnavailableError, `键 ${JSON.stringify(bad.slice(0, 40))} 必须被拒绝`)
  }

  // 构造函数同样受保护：projectId 里塞 `../` 拼不出逃逸的键。
  for (const bad of ['..', '../other', 'a/b', '', '.']) {
    assert.throws(
      () => artifactObjectKey({ projectId: bad, pipelineId: 'p1', stageId: 'receive' }),
      StorageUnavailableError,
      `projectId ${JSON.stringify(bad)} 必须被拒绝`,
    )
  }

  assert.throws(() => assertKeyInProject('cases/other/c1.json', 'proj'), /与当前项目 proj 不符/)
})

test('[object-store] 能力声明：如实把需要 CAS 的端口全部让出去', () => {
  const description = describeObjectStoreBackend()
  assert.equal(description.name, 'object-store')
  assert.equal(description.requiresExternalInfrastructure, true)
  assert.deepEqual([...description.implementedPorts].sort(), ['artifacts', 'cases', 'knowledge'])
  const unavailable = description.unavailablePorts.map(item => item.port).sort()
  assert.deepEqual(unavailable, ['audit', 'checkpoints', 'gateTasks', 'lock', 'tasks', 'usage'])
  for (const item of description.unavailablePorts) assert.notEqual(item.reason.trim(), '')
})

test('[object-store] 错误分类：校验失败归损坏，404 归"适配器违反契约"，未知一律不可用', () => {
  const corrupt = classifyObjectStoreError({ code: 'BadDigest' }, 'get artifacts/proj/p1/receive.json', 'artifacts/proj/p1/receive.json')
  assert.ok(corrupt instanceof StorageCorruptError)
  assert.equal(isStorageDataError(corrupt), true)

  const missing = classifyObjectStoreError({ statusCode: 404 }, 'get artifacts/proj/p1/receive.json', 'artifacts/proj/p1/receive.json')
  assert.ok(missing instanceof StorageUnavailableError)
  assert.match((missing as Error).message, /必须把 404 表达成 null/)

  const serverError = classifyObjectStoreError({ $metadata: { httpStatusCode: 503 } }, 'put x', 'artifacts/proj/p1/receive.json')
  assert.ok(serverError instanceof StorageUnavailableError)
  assert.match((serverError as Error).message, /HTTP 503/)

  const unknown = classifyObjectStoreError(new Error('connection reset'), 'put x', 'artifacts/proj/p1/receive.json')
  assert.ok(unknown instanceof StorageUnavailableError)
  assert.equal(isStorageInfrastructureError(unknown), true)
})

// ── §8.4 最后一条的端到端证据 ────────────────────────────────────────────────────

const BASE_CONFIG = {
  projectId: 'p',
  projectType: 'api-service',
  templateVersion: 'v1',
  scaleTier: 'S',
  stores: {
    knowledge: { impl: 'markdown-fs' },
    cases: { impl: 'markdown-fs' },
    requirements: { primary: { impl: 'paste' } },
  },
  stages: {},
}

class MemoryArtifacts implements ArtifactStore {
  readonly map = new Map<string, StageArtifact>()
  async read(path: string): Promise<StageArtifact | null> {
    return this.map.get(path) ?? null
  }
  put(artifact: StageArtifact): void {
    this.map.set(artifact.path, artifact)
  }
}

class WritingSpawn implements StageSpawner {
  readonly calls: StageId[] = []
  private readonly artifacts: MemoryArtifacts
  constructor(artifacts: MemoryArtifacts) {
    this.artifacts = artifacts
  }
  async runStage(request: SpawnRequest): Promise<SpawnedRun> {
    this.calls.push(request.stageId)
    const artifact: StageArtifact = {
      pipelineId: request.pipelineId,
      stageId: request.stageId,
      version: 1,
      inputs: {},
      content: { ok: true },
      digest: '',
      path: request.artifactPath,
    }
    this.artifacts.put({ ...artifact, digest: computeArtifactDigest(artifact) })
    return { stageId: request.stageId, artifactPath: request.artifactPath }
  }
}

class CountingHuman implements HumanGatePort {
  readonly calls: StageId[] = []
  async gate(stageId: StageId): Promise<'approved'> {
    this.calls.push(stageId)
    return 'approved'
  }
  async gateFailed(stageId: StageId): Promise<void> {
    this.calls.push(stageId)
  }
}

/** 检查点端口：可以命令它"下一次写入失败"，用来模拟外部存储中途不可用。 */
class FlakyCheckpoint implements CheckpointPort {
  value: Checkpoint | null = null
  failNextSave = false
  saves = 0
  async load(): Promise<Checkpoint | null> {
    return this.value
  }
  async save(_root: string, checkpoint: Checkpoint): Promise<void> {
    if (this.failNextSave) {
      this.failNextSave = false
      throw new StorageUnavailableError('postgres', 'save checkpoint', '连接池耗尽')
    }
    this.saves += 1
    this.value = checkpoint
  }
}

function driverWith(checkpoint: CheckpointPort): {
  driver: PipelineDriver
  spawn: WritingSpawn
  human: CountingHuman
  artifacts: MemoryArtifacts
} {
  const artifacts = new MemoryArtifacts()
  const spawn = new WritingSpawn(artifacts)
  const human = new CountingHuman()
  const driver = new PipelineDriver({
    cfg: normalizeConfig(BASE_CONFIG),
    pipelineId: 'pipe-1',
    root: 'artifacts/pipe-1',
    rulesetVersion: 'v1',
    spawn,
    gates: new MachineGateEngine([], 'rules-v1'),
    human,
    artifacts,
    checkpoint,
    review: undefined,
  })
  return { driver, spawn, human, artifacts }
}

test('外部存储中途不可用：产物写成功但检查点写失败 → 明确失败、不宣称阶段完成、不自动批准', async () => {
  const checkpoint = new FlakyCheckpoint()
  checkpoint.failNextSave = true
  const { driver, spawn, human, artifacts } = driverWith(checkpoint)

  await assert.rejects(
    () => driver.run(),
    (error: unknown) => {
      assert.ok(error instanceof StorageUnavailableError, `期望 StorageUnavailableError，实际 ${(error as Error)?.name}: ${(error as Error)?.message}`)
      assert.equal(isStorageInfrastructureError(error), true)
      assert.equal(isStorageDataError(error), false, '基础设施故障不是数据损坏，运维动作完全不同')
      return true
    },
  )

  // 1. 产物确实写成功了（receive 已经跑完）——这正是"能重试"的前提。
  assert.deepEqual(spawn.calls, ['receive'])
  assert.equal(artifacts.map.size, 1)
  // 2. 但**没有任何阶段被宣称完成**：检查点根本没落盘。
  const claimed: Checkpoint | null = checkpoint.value
  assert.equal(claimed, null, '检查点写失败时不得宣称任何阶段完成')
  assert.equal(checkpoint.saves, 0)
  // 3. 也**没有**自动进入人工批准：存储坏了不是"待批准"。
  assert.deepEqual(human.calls, [], '存储基础设施故障绝不能被包装成人工门')

  // 4. 存储恢复后重试成功（同一 driver、同一产物库），不丢也不重复声明。
  const outcome = await driver.run()
  assert.deepEqual(outcome, { outcome: 'completed' })
  assert.equal(checkpoint.value?.cursor, 6)
  assert.equal(human.calls.length, 6)
})

test('存储基础设施故障映射成 storage-unavailable(503)，而不是 run-failed(500)', () => {
  const mapped = toPipelineRunError(new StorageUnavailableError('postgres', 'save checkpoint', '连接池耗尽'))
  assert.equal(mapped.code, 'storage-unavailable')
  assert.equal(mapped.httpStatus, 503)
  assert.equal(mapped.details.backend, 'postgres')
  assert.equal(mapped.details.operation, 'save checkpoint')

  // 对照：普通运行期异常仍是 500。两者分开才有运维意义。
  assert.equal(toPipelineRunError(new Error('阶段崩了')).code, 'run-failed')
  assert.equal(toPipelineRunError(new Error('阶段崩了')).httpStatus, 500)
})
