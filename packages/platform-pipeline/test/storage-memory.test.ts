/**
 * 内存后端契约测试（docs/10 §8.4 第二半：同一套契约跑通第二个后端）。
 *
 * **它存在的唯一理由是证明"端口真的可替换"**：契约套件被**原样**跑第二遍，
 * 用例标题、断言、夹具都来自 `test/storage-contract.ts`，本文件只提供
 * "怎么造一个全新后端 / 怎么造损坏"这些后端相关的胶水。
 *
 * 如果只测文件后端，任何偷偷依赖 fs 语义的实现（"读不到就是没有"、
 * "目录不存在就等于空"）都会在换后端那天才暴露——而那天通常已经在生产上。
 *
 * 本文件另外补内存后端**专有**的保证与**已知边界**：
 * 体检覆盖知识条目、迁移留原值快照但如实不谎报磁盘备份目录、
 * 锁只在同一实例内互斥（不是跨进程锁）。
 *
 * @module platform-pipeline/test/storage-memory
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PipelineLockHeldError } from '../src/checkpoint-lock.ts'
import {
  StorageCorruptError,
  createMemoryStorageBackend,
  type MemoryRawStore,
  type MemoryStorageBackend,
  type StorageBackend,
} from '../src/storage/index.ts'
import {
  makeCheckpoint,
  makeKnowledgeEntry,
  runStorageContract,
} from './storage-contract.ts'

/**
 * 传给 `checkpoints.load/save` 的根。
 *
 * 内存后端只把它当键的一部分（不做任何路径解析），所以这里给一个**相对**形态的值：
 * 与文件后端一样，诊断里的 `ref` 不该泄露绝对路径。
 */
const CHECKPOINT_ROOT = 'checkpoints'

/** 契约套件只认 `StorageBackend`；内存后端额外暴露 `raw` 层用于故障注入。 */
function rawOf(backend: StorageBackend): MemoryRawStore {
  const memory = backend as MemoryStorageBackend
  assert.notEqual(memory.raw, undefined, '内存后端必须暴露 raw 层（契约套件靠它造损坏）')
  return memory.raw
}

runStorageContract({
  name: 'memory',
  create: async () => ({
    backend: createMemoryStorageBackend(),
    checkpointRoot: CHECKPOINT_ROOT,
    // 内存后端没有临时目录要删——这正是它作为"第二条验证通路"的便利之处。
    cleanup: async () => {},
  }),
  seedLegacyRecord: async context => {
    // 历史遗留形态：形状合法但**没有** schemaVersion（v1 之前）。
    rawOf(context.backend).set(`checkpoint:${CHECKPOINT_ROOT}`, JSON.stringify(makeCheckpoint('legacy')))
    return {
      ref: `checkpoint:${CHECKPOINT_ROOT}`,
      read: () => context.backend.ports.checkpoints.load(CHECKPOINT_ROOT),
    }
  },
  hooks: {
    corruptCheckpoint: async backend => {
      // 截断的 JSON：真实场景里就是写一半 / 被手工改坏。
      rawOf(backend).set(`checkpoint:${CHECKPOINT_ROOT}`, '{"pipelineId":"p1","cursor":')
    },
    seedFutureCheckpoint: async backend => {
      rawOf(backend).set(`checkpoint:${CHECKPOINT_ROOT}`, JSON.stringify({ ...makeCheckpoint('p1'), schemaVersion: 99 }))
    },
    appendRawUsageLine: async (backend, pipelineId, line) => {
      const raw = rawOf(backend)
      const key = `usage:${pipelineId}`
      raw.set(key, `${raw.get(key) ?? ''}${line}\n`)
    },
  },
})

// ── 内存后端专有 ────────────────────────────────────────────────────────────────

test('[memory] describe() 声明为无外部依赖的完整后端', async () => {
  const backend = createMemoryStorageBackend()
  const description = backend.describe()
  assert.equal(description.name, 'memory')
  assert.equal(description.requiresExternalInfrastructure, false)
  assert.deepEqual(description.unavailablePorts, [])
  for (const port of ['artifacts', 'checkpoints', 'tasks', 'gateTasks', 'usage', 'audit', 'knowledge', 'cases', 'lock']) {
    assert.ok(description.implementedPorts.includes(port), `${port} 应声明为已实现`)
  }
})

test('[memory] 体检覆盖知识条目：写坏的知识记录不会被报成健康', async () => {
  const backend = createMemoryStorageBackend()
  rawOf(backend).set('knowledge:kb-1', 'not json at all')

  const health = await backend.diagnose()
  assert.equal(health.ok, false, '知识记录被写坏时体检必须报不健康')
  const corrupt = health.diagnostics.filter(item => item.code === 'corrupt-json')
  assert.equal(corrupt.length, 1, JSON.stringify(health.diagnostics))
  assert.equal(corrupt[0]!.kind, 'knowledge-entry')
  assert.equal(corrupt[0]!.ref, 'knowledge:kb-1')
  assert.equal(corrupt[0]!.recoverable, false)

  // 检索也必须显式失败：不能把坏记录当成"知识库里没有它"而静默少一条。
  await assert.rejects(
    () => backend.ports.knowledge!.read({ project: 'proj', entities: ['x'], limit: 5 }),
    StorageCorruptError,
  )
})

test('[memory] 知识条目不报 migration-needed：它的版本是领域概念，不是存储 schema 版本', async () => {
  const backend = createMemoryStorageBackend()
  await backend.ports.knowledge!.write(makeKnowledgeEntry('kb-1', '登录接口返回 401', ['login']))

  // 知识条目没有平台版本信封，因此体检不得把它当成"待迁移的历史记录"。
  const health = await backend.diagnose()
  assert.deepEqual(health.diagnostics, [], `知识条目不应产生诊断：${JSON.stringify(health.diagnostics)}`)
  assert.equal(health.ok, true)

  // 迁移也不该碰它（与文件后端一致：`<!-- pp-meta -->` 行本身就是领域条目）。
  const report = await backend.migrate!()
  assert.deepEqual(report.migrated, [])
  assert.deepEqual(report.skipped, [])
})

test('[memory] 迁移留原值快照可回滚，但如实不谎报磁盘备份目录', async () => {
  const backend = createMemoryStorageBackend()
  const raw = rawOf(backend)
  const original = JSON.stringify(makeCheckpoint('legacy'))
  raw.set(`checkpoint:${CHECKPOINT_ROOT}`, original)

  const report = await backend.migrate!()
  assert.equal(report.migrated.length, 1, JSON.stringify(report))
  // 诚实优先于形式一致：内存后端没有可回滚的磁盘备份，就不报一个目录出来。
  assert.equal(report.backupDir, null, '内存后端不得谎报备份目录')
  assert.equal(raw.backups.get(`checkpoint:${CHECKPOINT_ROOT}`), original, '原值快照必须与迁移前逐字节一致')

  const migrated = JSON.parse(raw.get(`checkpoint:${CHECKPOINT_ROOT}`)!) as Record<string, unknown>
  assert.equal(migrated.schemaVersion, 1)
  assert.equal(migrated.pipelineId, 'legacy')
})

test('[memory] 迁移遇到损坏记录只跳过它，不动原件、不阻断其它记录', async () => {
  const backend = createMemoryStorageBackend()
  const raw = rawOf(backend)
  raw.set(`checkpoint:${CHECKPOINT_ROOT}`, JSON.stringify(makeCheckpoint('legacy')))
  raw.set('task:t-broken', '{ not json')

  const report = await backend.migrate!()
  assert.equal(report.migrated.length, 1, JSON.stringify(report))
  assert.equal(report.skipped.length, 1)
  assert.equal(report.skipped[0]!.ref, 'task:t-broken')
  assert.match(report.skipped[0]!.reason, /损坏|不是合法 JSON/)
  assert.equal(raw.get('task:t-broken'), '{ not json', '损坏原件必须原样保留')
})

test('[memory] 迁移是幂等的：已是当前版本的记录逐字节不动', async () => {
  const backend = createMemoryStorageBackend()
  await backend.ports.checkpoints.save(CHECKPOINT_ROOT, makeCheckpoint('p1'))
  const raw = rawOf(backend)
  const before = raw.get(`checkpoint:${CHECKPOINT_ROOT}`)!

  const report = await backend.migrate!()
  assert.deepEqual(report.migrated, [], '已是当前版本就无事可做')
  assert.equal(raw.get(`checkpoint:${CHECKPOINT_ROOT}`), before, '幂等：不得改写已合规的记录')
})

test('[memory] 锁：同一 pipeline 第二次获取被拒绝，release 后可再获取', async () => {
  const backend = createMemoryStorageBackend()
  const lock = await backend.ports.lock!('p1', { ownerId: 'owner-a' })
  assert.equal(lock.pipelineId, 'p1')
  assert.equal(lock.path, 'memory://p1')
  assert.equal(lock.owner.host, 'memory')

  await assert.rejects(
    () => backend.ports.lock!('p1', { ownerId: 'owner-b' }),
    (error: unknown) => {
      // 必须是"锁被占"这一类错误，**不是** StorageUnavailableError——
      // 后者会被 Web 翻成 503「存储用不了」，把用户引向错误的排查方向。
      assert.ok(error instanceof PipelineLockHeldError, `期望 PipelineLockHeldError，实际 ${(error as Error)?.name}`)
      assert.equal((error as PipelineLockHeldError).pipelineId, 'p1')
      return true
    },
  )

  // 不同 pipeline 互不阻塞。
  const other = await backend.ports.lock!('p2', { ownerId: 'owner-b' })
  assert.equal(other.pipelineId, 'p2')
  assert.equal(await other.release(), true)

  // 非持有者释放不动别人的锁；持有者释放是幂等的。
  assert.equal(await lock.release(), true)
  assert.equal(await lock.release(), false, '重复释放必须幂等（不能误删后来者拿到的锁）')

  const again = await backend.ports.lock!('p1', { ownerId: 'owner-c' })
  assert.equal(await again.release(), true)
})

test('[memory] 锁是**进程内**的：不同实例之间不互斥（已知边界，生产必须换后端）', async () => {
  // 这条用例把限制**写死**成断言，免得日后有人误以为它是跨进程锁。
  // 内存后端只用于单机开发 / 测试 / 契约验证；多进程部署请用 file 或数据库后端。
  const first = createMemoryStorageBackend()
  const second = createMemoryStorageBackend()

  const lockA = await first.ports.lock!('p1', { ownerId: 'owner-a' })
  const lockB = await second.ports.lock!('p1', { ownerId: 'owner-b' })
  assert.equal(lockA.pipelineId, 'p1')
  assert.equal(lockB.pipelineId, 'p1', '两个实例各自持锁——这正是"不跨进程"的含义')

  await lockA.release()
  await lockB.release()
})

test('[memory] 产物是"裸 content"时不算损坏（与文件后端同一语义）', async () => {
  const backend = createMemoryStorageBackend()
  rawOf(backend).set('artifact:artifacts/p1/receive.json', JSON.stringify({ summary: '裸内容' }))

  const health = await backend.diagnose()
  assert.equal(health.ok, true, `裸 content 产物不应被判损坏：${JSON.stringify(health.diagnostics)}`)

  const artifact = await backend.ports.artifacts.read('artifacts/p1/receive.json')
  assert.notEqual(artifact, null)
  assert.deepEqual(artifact!.content, { summary: '裸内容' })
})

test('[memory] 体检报出缺版本的历史记录，且不把它们当损坏', async () => {
  const backend = createMemoryStorageBackend()
  rawOf(backend).set(`checkpoint:${CHECKPOINT_ROOT}`, JSON.stringify(makeCheckpoint('legacy')))

  const health = await backend.diagnose()
  assert.equal(health.ok, false, '缺版本是待办，不是健康')
  assert.deepEqual(health.diagnostics.map(item => item.code), ['migration-needed'])
  assert.equal(health.diagnostics[0]!.recoverable, true)
  // 但它是**可读**的：旧版本按 v1 读，不能因此拒绝启动。
  assert.notEqual(await backend.ports.checkpoints.load(CHECKPOINT_ROOT), null)
})
