/**
 * 存储后端**契约测试套件**（docs/10 §8.4「同一套 driver contract tests 同时通过
 * file backend 和 external backend」）。
 *
 * 本文件不是测试文件本身，而是一个**参数化的套件**：`runStorageContract()` 被
 * `test/storage-file.test.ts`（文件后端）与 `test/storage-memory.test.ts`（内存后端）
 * 各自调用一次。因此这里的断言必须是**端口不变量**，不能依赖任何一种后端的实现细节：
 *
 * - 只断言"写入后能读回 / 缺失返回 null / 损坏显式失败 / 版本更高必须拒绝"这类语义；
 * - **不**断言目录名、文件名、原子 rename、JSONL 行号——那是实现，不是契约；
 * - 每条用例自己 `create()` 一个全新后端，用例之间不共享状态。
 *
 * 为什么值得这样写：后端可替换是"会自动退化的性质"。只测文件后端时，
 * 任何一处偷偷依赖 fs 语义（例如"读不到就是没有"）都会在换后端那天才暴露。
 *
 * @module platform-pipeline/test/storage-contract
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { computeArtifactDigest } from '../src/gates/machine.ts'
import {
  STORAGE_SCHEMA_VERSION,
  StorageCorruptError,
  StorageSchemaVersionError,
  assertBackendPorts,
  type AuditEvent,
  type StorageBackend,
  type StoragePorts,
} from '../src/storage/index.ts'
import type { StageArtifact } from '../src/types.ts'

export interface StorageContractContext {
  readonly backend: StorageBackend
  /**
   * 传给 `checkpoints.load/save` 的 `root`。
   *
   * 端口签名要求宿主显式给根（`CheckpointPort.load(root)`），所以契约必须用**宿主会传的
   * 那个根**去测——用一个自造的相对路径测，等于在测一份没人会走的分支。
   * 内存后端可以直接忽略它（用固定键即可）。
   */
  readonly checkpointRoot: string
  /** 清理（删临时目录等）；内存后端可以是空操作。 */
  readonly cleanup: () => Promise<void>
}

export interface StorageContractOptions {
  /** 后端名，用于用例标题。 */
  readonly name: string
  /** 为每条用例建一个**全新**后端（独立目录 / 独立内存实例）。 */
  readonly create: () => Promise<StorageContractContext>
  /**
   * 本后端不提供的可选端口（`knowledge` / `cases`）。
   *
   * 用"显式声明 + 对应用例跳过"而不是"静默通过"：静默通过会让
   * "后端没实现"与"后端实现了但坏了"看起来一样。
   */
  readonly unsupported?: readonly string[]
  /**
   * 构造一个"旧版本记录"（缺 `schemaVersion`）用于迁移用例。
   * 缺省 = 不支持，迁移用例跳过。
   */
  readonly seedLegacyRecord?: (context: StorageContractContext) => Promise<{ readonly ref: string; readonly read: () => Promise<unknown> }>
  /**
   * "造损坏 / 造未来版本"的钩子。
   *
   * 为什么必须由后端提供：损坏是**存储层**的概念（"文件里是坏字节"），而端口只暴露
   * 读写——没有"写入非法内容"的端口，也不该有。契约套件只声明"需要一个造损坏的钩子"，
   * 不规定怎么造；文件后端写坏字节，内存后端直接塞坏记录。
   */
  readonly hooks?: {
    readonly corruptCheckpoint?: (backend: StorageBackend, checkpointRoot: string) => Promise<void>
    readonly seedFutureCheckpoint?: (backend: StorageBackend, checkpointRoot: string) => Promise<void>
    readonly appendRawUsageLine?: (backend: StorageBackend, pipelineId: string, line: string) => Promise<void>
  }
}

const T = (options: StorageContractOptions, suffix: string): string => `[${options.name}] ${suffix}`

/** 跑一整套后端契约。 */
export function runStorageContract(options: StorageContractOptions): void {
  const unsupported = new Set(options.unsupported ?? [])
  const skipIfUnsupported = (port: string): string | false =>
    unsupported.has(port) ? `后端 ${options.name} 未提供 ${port} 端口` : false

  // ── 端口完整性 ────────────────────────────────────────────────────────────────

  test(T(options, '必需端口齐全，且 describe() 声称的端口都真的存在'), async () => {
    const { backend, checkpointRoot, cleanup } = await options.create()
    try {
      assert.doesNotThrow(() => assertBackendPorts(backend))
      const description = backend.describe()
      assert.equal(description.name, options.name)
      assert.equal(backend.name, options.name)
      assert.equal(backend.schemaVersion, STORAGE_SCHEMA_VERSION)
      for (const port of description.implementedPorts) {
        assert.notEqual(
          (backend.ports as unknown as Record<string, unknown>)[port], undefined,
          `describe() 声称实现 ${port}，但 ports.${port} 是空的`,
        )
      }
    } finally {
      await cleanup()
    }
  })

  test(T(options, '未声明的可选端口不会被伪装成可用'), async () => {
    const { backend, checkpointRoot, cleanup } = await options.create()
    try {
      for (const item of backend.describe().unavailablePorts) {
        assert.notEqual(item.reason.trim(), '', `${item.port} 必须给出不可用原因`)
        assert.equal(
          (backend.ports as unknown as Record<string, unknown>)[item.port], undefined,
          `${item.port} 被声明为不可用，却仍然装配了实现`,
        )
      }
    } finally {
      await cleanup()
    }
  })

  // ── 产物 ──────────────────────────────────────────────────────────────────────

  test(T(options, '产物 write → read 往返，wrapper 元数据不漂移'), async () => {
    const { backend, checkpointRoot, cleanup } = await options.create()
    try {
      const artifact = makeArtifact('p1', 'receive', { summary: '需求已接收' })
      await backend.ports.artifacts.write!(artifact)
      const read = await backend.ports.artifacts.read(artifact.path)
      assert.notEqual(read, null)
      assert.equal(read!.pipelineId, 'p1')
      assert.equal(read!.stageId, 'receive')
      assert.equal(read!.path, artifact.path)
      assert.equal(read!.digest, artifact.digest)
      assert.deepEqual(read!.content, { summary: '需求已接收' })
    } finally {
      await cleanup()
    }
  })

  test(T(options, '产物缺失返回 null（不是抛错，也不是空对象）'), async () => {
    const { backend, checkpointRoot, cleanup } = await options.create()
    try {
      assert.equal(await backend.ports.artifacts.read('artifacts/nobody/receive.json'), null)
    } finally {
      await cleanup()
    }
  })

  test(T(options, '产物路径逃逸被拒绝'), async () => {
    const { backend, checkpointRoot, cleanup } = await options.create()
    try {
      await assert.rejects(
        () => backend.ports.artifacts.read('../../etc/passwd'),
        /escape|越界|不允许|outside/i,
      )
    } finally {
      await cleanup()
    }
  })

  // ── 检查点 ────────────────────────────────────────────────────────────────────

  test(T(options, '检查点 save → load 往返；缺失返回 null'), async () => {
    const { backend, checkpointRoot, cleanup } = await options.create()
    try {
      assert.equal(await backend.ports.checkpoints.load(checkpointRoot), null)
      const checkpoint = makeCheckpoint('p1')
      await backend.ports.checkpoints.save(checkpointRoot, checkpoint)
      const loaded = await backend.ports.checkpoints.load(checkpointRoot)
      assert.notEqual(loaded, null)
      assert.equal(loaded!.pipelineId, 'p1')
      assert.equal(loaded!.cursor, 0)
      assert.equal(Object.keys(loaded!.stageStates).length, 6)
    } finally {
      await cleanup()
    }
  })

  test(T(options, '检查点损坏时显式失败，绝不静默当空数据'), async () => {
    const { backend, checkpointRoot, cleanup } = await options.create()
    try {
      await corruptCheckpoint(options, backend, checkpointRoot)
      await assert.rejects(
        () => backend.ports.checkpoints.load(checkpointRoot),
        (error: unknown) => {
          assert.ok(
            error instanceof StorageCorruptError,
            `期望 StorageCorruptError，实际 ${(error as Error)?.name}: ${(error as Error)?.message}`,
          )
          return true
        },
      )
      // 关键：损坏**不能**被读成 null（那会让 driver 以为"还没开始"而重跑并覆盖现场）。
      await assert.rejects(() => backend.ports.checkpoints.load(checkpointRoot))
    } finally {
      await cleanup()
    }
  })

  test(T(options, '检查点 schemaVersion 高于本进程支持时必须拒绝，不降级解析'), async () => {
    const { backend, checkpointRoot, cleanup } = await options.create()
    try {
      await seedFutureCheckpoint(options, backend, checkpointRoot)
      await assert.rejects(
        () => backend.ports.checkpoints.load(checkpointRoot),
        (error: unknown) => {
          assert.ok(error instanceof StorageSchemaVersionError, `期望 StorageSchemaVersionError，实际 ${(error as Error)?.name}`)
          return true
        },
      )
    } finally {
      await cleanup()
    }
  })

  // ── 任务 ──────────────────────────────────────────────────────────────────────

  test(T(options, '任务 create/get/list/update 与租约语义'), async () => {
    const { backend, checkpointRoot, cleanup } = await options.create()
    try {
      const store = backend.ports.tasks
      const created = await store.create({ taskId: 't1', projectId: 'proj', pipelineId: 'p1', status: 'queued', attempt: 1 })
      assert.equal(created.taskId, 't1')
      assert.equal((await store.get('t1'))!.status, 'queued')
      assert.equal(await store.get('nope'), null)

      const leased = await store.acquireLease('t1', 'worker-a', 60_000)
      assert.equal(leased.lease!.owner, 'worker-a')
      // 别人不能抢走一个仍然有效的租约。
      await assert.rejects(() => store.acquireLease('t1', 'worker-b', 60_000), /leased by|claimed by/)
      // 非持有者不能续租/释放。
      await assert.rejects(() => store.heartbeat('t1', 'worker-b', 60_000), /ownership|owner/)
      await assert.rejects(() => store.releaseLease('t1', 'worker-b'), /ownership|owner/)

      const released = await store.releaseLease('t1', 'worker-a')
      assert.equal(released.lease, undefined)

      await store.update('t1', { status: 'completed' })
      const listed = await store.list({ pipelineId: 'p1', status: 'completed' })
      assert.equal(listed.length, 1)
      assert.deepEqual(await store.list({ pipelineId: 'other' }), [])
    } finally {
      await cleanup()
    }
  })

  test(T(options, '过期租约可被恢复，终态任务不被恢复'), async () => {
    const { backend, checkpointRoot, cleanup } = await options.create()
    try {
      const store = backend.ports.tasks
      await store.create({ taskId: 'stale', projectId: 'proj', pipelineId: 'p1', status: 'queued', attempt: 1 })
      // ttl 最小合法值是正数；用一个极小值让它立刻过期。
      await store.acquireLease('stale', 'dead-worker', 1)
      await new Promise(resolve => setTimeout(resolve, 5))
      const recovered = await store.recoverStale()
      assert.equal(recovered.length, 1)
      assert.equal(recovered[0]!.taskId, 'stale')
      assert.equal(recovered[0]!.status, 'queued')
      assert.equal(recovered[0]!.lease, undefined)

      await store.create({ taskId: 'done', projectId: 'proj', pipelineId: 'p1', status: 'completed', attempt: 1 })
      await store.acquireLease('done', 'dead-worker', 1)
      await new Promise(resolve => setTimeout(resolve, 5))
      const again = await store.recoverStale()
      assert.deepEqual(again.map(task => task.taskId), [])
    } finally {
      await cleanup()
    }
  })

  // ── 人工门任务 ────────────────────────────────────────────────────────────────

  test(T(options, '门任务 claim → decide → consume，裁决必须由持有 claim 的人做'), async () => {
    const { backend, checkpointRoot, cleanup } = await options.create()
    try {
      const store = backend.ports.gateTasks
      const task = await store.create(makeGateTaskInput('g1'))
      assert.equal(task.status, 'pending')

      await store.claim('g1', 'reviewer-a', 60_000)
      // 非持有者不能裁决（否则 claim 形同虚设）。
      await assert.rejects(() => store.decide('g1', 'reviewer-b', 'approved', ''), /claim owner|claimed by/)
      // changes-needed / rejected 必须带 note。
      await assert.rejects(() => store.decide('g1', 'reviewer-a', 'changes-needed', '  '), /non-empty note|必填|must/)

      const decided = await store.decide('g1', 'reviewer-a', 'changes-needed', '接口清单不完整')
      assert.equal(decided.status, 'changes-needed')
      assert.equal(decided.decision!.note, '接口清单不完整')

      // 消费是幂等的：第二次消费返回同一条（不重复驱动门）。
      const first = await store.consume('g1')
      const second = await store.consume('g1')
      assert.equal(first.consumedAt, second.consumedAt)

      // 未裁决的任务不可消费。
      await store.create(makeGateTaskInput('g2'))
      await assert.rejects(() => store.consume('g2'), /not consumable|consumed/)
    } finally {
      await cleanup()
    }
  })

  test(T(options, '已裁决的门任务不可取消——取消不能覆盖真人裁决'), async () => {
    const { backend, checkpointRoot, cleanup } = await options.create()
    try {
      const store = backend.ports.gateTasks
      await store.create(makeGateTaskInput('g1'))
      await store.claim('g1', 'reviewer-a', 60_000)
      await store.decide('g1', 'reviewer-a', 'approved', '')
      await assert.rejects(() => store.cancel!('g1', 'ops', '撤回'), /not cancellable|cancellable/)
    } finally {
      await cleanup()
    }
  })

  // ── 用量 ──────────────────────────────────────────────────────────────────────

  test(T(options, '用量 append → read；按 pipelineId 隔离'), async () => {
    const { backend, checkpointRoot, cleanup } = await options.create()
    try {
      const store = backend.ports.usage
      await store.append(makeUsageEvent('p1', 'receive', 'llm'))
      await store.append(makeUsageEvent('p1', 'analyze', 'tool'))
      await store.append(makeUsageEvent('p2', 'receive', 'llm'))

      const p1 = await store.read('p1')
      assert.equal(p1.events.length, 2)
      assert.deepEqual(p1.events.map(event => event.stageId), ['receive', 'analyze'])
      assert.deepEqual(p1.skipped, [])
      assert.equal((await store.read('p2')).events.length, 1)
      assert.deepEqual(await store.read('unknown'), { events: [], skipped: [] })
    } finally {
      await cleanup()
    }
  })

  test(T(options, '用量日志损坏行显式报告 skipped，不静默跳过'), async () => {
    const { backend, checkpointRoot, cleanup } = await options.create()
    try {
      await backend.ports.usage.append(makeUsageEvent('p1', 'receive', 'llm'))
      await appendRawUsageLine(options, backend, 'p1', '{"kind":"llm"}')
      await appendRawUsageLine(options, backend, 'p1', 'not json at all')

      const read = await backend.ports.usage.read('p1')
      assert.equal(read.events.length, 1, '合法行必须仍然可读（一行坏掉不能毁掉整份日志）')
      assert.equal(read.skipped.length, 2)
      for (const item of read.skipped) {
        assert.ok(item.line > 0)
        assert.notEqual(item.reason.trim(), '')
      }
    } finally {
      await cleanup()
    }
  })

  // ── 审计 ──────────────────────────────────────────────────────────────────────

  test(T(options, '审计 append → read，可按 pipelineId 与 kind 过滤'), async () => {
    const { backend, checkpointRoot, cleanup } = await options.create()
    try {
      const store = backend.ports.audit
      const appended = await store.append({ kind: 'gate-decided', actor: 'reviewer-a', pipelineId: 'p1', detail: '批准 receive' })
      assert.notEqual(appended.eventId, '')
      assert.ok(appended.at > 0)
      await store.append({ kind: 'reentry', actor: 'ops', pipelineId: 'p1', detail: '需求变更' })
      await store.append({ kind: 'gate-decided', actor: 'reviewer-a', pipelineId: 'p2', detail: '批准 analyze' })

      const all = await store.read()
      assert.equal(all.events.length, 3)
      assert.deepEqual(all.skipped, [])
      assert.equal((await store.read({ pipelineId: 'p1' })).events.length, 2)
      const decided = await store.read({ kind: 'gate-decided' })
      assert.deepEqual(decided.events.map(event => event.pipelineId), ['p1', 'p2'])
    } finally {
      await cleanup()
    }
  })

  test(T(options, '审计事件按时间有序，limit 取最新的 N 条'), async () => {
    const { backend, checkpointRoot, cleanup } = await options.create()
    try {
      const store = backend.ports.audit
      for (let index = 0; index < 5; index += 1) {
        await store.append({ kind: 'run-started', actor: 'runner', pipelineId: 'p1', detail: `第 ${index} 次`, at: 1000 + index })
      }
      const read = await store.read({ limit: 2 })
      assert.deepEqual(read.events.map(event => event.detail), ['第 3 次', '第 4 次'])
    } finally {
      await cleanup()
    }
  })

  test(T(options, '审计不落凭据：疑似 token 的文本被脱敏，敏感字段名被丢弃'), async () => {
    const { backend, checkpointRoot, cleanup } = await options.create()
    try {
      const event = await backend.ports.audit.append({
        kind: 'run-started',
        actor: 'runner',
        pipelineId: 'p1',
        detail: 'provider 返回 401，key=sk-live-abcdefghijklmnop',
        metadata: { apiKey: 'sk-live-abcdefghijklmnop', note: 'ok' },
      })
      assert.equal(event.detail.includes('sk-live'), false, '文本里的 token 必须被脱敏')
      assert.equal(JSON.stringify(event).includes('sk-live'), false, '序列化后也不得含 token')
      assert.equal((event.metadata as Record<string, unknown>).apiKey, undefined)
      assert.equal((event.metadata as Record<string, unknown>).note, 'ok')

      const read = await backend.ports.audit.read({ pipelineId: 'p1' })
      assert.equal(JSON.stringify(read.events).includes('sk-live'), false, '读回来也不得含 token')
    } finally {
      await cleanup()
    }
  })

  // ── 体检 ──────────────────────────────────────────────────────────────────────

  test(T(options, '全新（空）项目体检通过：没有记录不是故障'), async () => {
    const { backend, checkpointRoot, cleanup } = await options.create()
    try {
      const health = await backend.diagnose()
      assert.equal(health.ok, true, `空项目不应报不健康：${JSON.stringify(health.diagnostics)}`)
      assert.equal(health.backend, options.name)
      assert.equal(health.schemaVersion, STORAGE_SCHEMA_VERSION)
      assert.deepEqual(health.diagnostics, [])
    } finally {
      await cleanup()
    }
  })

  test(T(options, '体检把损坏记录报成 corrupt-json，而不是静默略过'), async () => {
    const { backend, checkpointRoot, cleanup } = await options.create()
    try {
      await corruptCheckpoint(options, backend, checkpointRoot)
      const health = await backend.diagnose()
      assert.equal(health.ok, false)
      const corrupt = health.diagnostics.filter(item => item.code === 'corrupt-json')
      assert.equal(corrupt.length, 1, JSON.stringify(health.diagnostics))
      assert.equal(corrupt[0]!.kind, 'checkpoint')
      assert.equal(corrupt[0]!.recoverable, false, '坏字节不能猜，必须标成不可自动修复')
      assert.equal(corrupt[0]!.ref.startsWith('/'), false, 'ref 不得是绝对路径（诊断会经 HTTP 出去）')
    } finally {
      await cleanup()
    }
  })

  // ── 迁移 ──────────────────────────────────────────────────────────────────────

  const migrateSkip = options.seedLegacyRecord === undefined
    ? `后端 ${options.name} 未提供 seedLegacyRecord`
    : false

  test(T(options, '迁移：旧记录补上 schemaVersion，可重复执行且不破坏数据'), { skip: migrateSkip }, async () => {
    const { backend, checkpointRoot, cleanup } = await options.create()
    try {
      assert.notEqual(backend.migrate, undefined, '后端必须提供 migrate')
      const seeded = await options.seedLegacyRecord!({ backend, checkpointRoot, cleanup: async () => {} })

      // 迁移前：体检应报 migration-needed。
      const before = await backend.diagnose()
      assert.ok(
        before.diagnostics.some(item => item.code === 'migration-needed'),
        `迁移前应报 migration-needed：${JSON.stringify(before.diagnostics)}`,
      )
      const payloadBefore = await seeded.read()

      const report = await backend.migrate!()
      assert.equal(report.backend, options.name)
      assert.equal(report.toVersion, STORAGE_SCHEMA_VERSION)
      assert.ok(report.migrated.length >= 1, `应至少迁移一条：${JSON.stringify(report)}`)
      assert.deepEqual(report.skipped, [])

      // 迁移后：版本已补齐，数据等价，体检不再报 migration-needed。
      const payloadAfter = await seeded.read()
      assert.deepEqual(stripVersion(payloadAfter), stripVersion(payloadBefore), '迁移不得改变数据内容')
      const after = await backend.diagnose()
      assert.equal(
        after.diagnostics.some(item => item.code === 'migration-needed'), false,
        `迁移后不应再有 migration-needed：${JSON.stringify(after.diagnostics)}`,
      )

      // 幂等：再跑一次不再改动任何记录。
      const second = await backend.migrate!()
      assert.deepEqual(second.migrated, [])
    } finally {
      await cleanup()
    }
  })

  // ── 可选端口 ──────────────────────────────────────────────────────────────────

  test(T(options, '知识库：写入后可检索；冲突必须显式 supersedes'), { skip: skipIfUnsupported('knowledge') }, async () => {
    const { backend, checkpointRoot, cleanup } = await options.create()
    try {
      const store = backend.ports.knowledge!
      await store.write(makeKnowledgeEntry('kb-1', '登录接口返回 401', ['login']))
      const found = await store.read({ project: 'proj', entities: ['login'], limit: 10 })
      assert.equal(found.length, 1)
      assert.equal(found[0]!.id, 'kb-1')

      // 同一实体、不同结论 → 必须被识别成冲突（不能静默并存）。
      const conflicts = await store.findConflicts(makeKnowledgeEntry('kb-2', '登录接口返回 500', ['login']))
      assert.equal(conflicts.length, 1)
      assert.equal(conflicts[0]!.existingId, 'kb-1')
      // 显式 supersedes 后不再是冲突。
      const superseding = { ...makeKnowledgeEntry('kb-3', '登录接口返回 500', ['login']), supersedes: ['kb-1'] }
      assert.deepEqual(await store.findConflicts(superseding), [])
    } finally {
      await cleanup()
    }
  })

  test(T(options, '用例库：版本化回流保留历史版本'), { skip: skipIfUnsupported('cases') }, async () => {
    const { backend, checkpointRoot, cleanup } = await options.create()
    try {
      const store = backend.ports.cases!
      await store.archive({ caseId: 'c1', version: 'v1', project: 'proj', sourceRequirement: 'r1', ticketRef: 'T-1', content: { title: '登录成功' } })
      await store.archive({ caseId: 'c1', version: 'v2', project: 'proj', sourceRequirement: 'r1', ticketRef: 'T-1', content: { title: '登录成功（含验证码）' } })

      const metas = await store.query({ project: 'proj' })
      assert.equal(metas.length, 1, '同 caseId 只出现一次（取最新版本）')
      assert.equal(metas[0]!.version, 'v2')
      assert.equal(metas[0]!.title, '登录成功（含验证码）')
      assert.deepEqual(await store.query({ project: 'other' }), [])
    } finally {
      await cleanup()
    }
  })
}

// ── 夹具 ────────────────────────────────────────────────────────────────────────

export function makeArtifact(pipelineId: string, stageId: StageArtifact['stageId'], content: unknown): StageArtifact {
  const base: StageArtifact = {
    pipelineId,
    stageId,
    version: 1,
    inputs: {},
    content,
    digest: '',
    path: `artifacts/${pipelineId}/${stageId}.json`,
  }
  return { ...base, digest: computeArtifactDigest(base) }
}

export function makeCheckpoint(pipelineId: string): Parameters<StoragePorts['checkpoints']['save']>[1] {
  const stageStates = Object.fromEntries(
    ['receive', 'analyze', 'design', 'execute', 'report', 'archive'].map(stageId => [stageId, {
      status: 'idle' as const,
      artifact: `artifacts/${pipelineId}/${stageId}.json`,
      digest: '',
      inputs: {},
      history: [],
      reviewDegraded: false,
      gate: { machine: { status: 'passed' as const, attempts: 0, violations: [] }, human: { state: 'open' as const, records: [] } },
      failures: [],
    }]),
  )
  return {
    pipelineId,
    templateVersion: 'v1',
    rulesetVersion: 'v1',
    cursor: 0,
    stageStates: stageStates as never,
    reentries: [],
  }
}

export function makeUsageEvent(pipelineId: string, stageId: 'receive' | 'analyze', kind: 'llm' | 'tool') {
  return {
    eventId: `${pipelineId}-${stageId}-${kind}`,
    tenantId: 'default',
    projectId: 'proj',
    pipelineId,
    stageId,
    kind,
    startedAt: 1_000,
    finishedAt: 1_010,
    durationMs: 10,
    success: true,
  } as const
}

export function makeGateTaskInput(gateTaskId: string) {
  return {
    gateTaskId,
    projectId: 'proj',
    pipelineId: 'p1',
    stageId: 'receive' as const,
    artifactPath: 'artifacts/p1/receive.json',
    machineStatus: 'passed' as const,
    machineViolations: [],
  }
}

export function makeKnowledgeEntry(id: string, body: string, entities: readonly string[]) {
  return {
    id,
    title: id,
    date: '2026-09-25',
    project: 'proj',
    version: 'v1',
    tags: ['api'],
    entities,
    body,
    sourcePipeline: 'p1',
  }
}

/** 只比较业务内容：迁移允许增加 `schemaVersion`，不允许改别的。 */
function stripVersion(value: unknown): unknown {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return value
  const { schemaVersion: _dropped, ...rest } = value as Record<string, unknown>
  return rest
}

// ── 损坏钩子的调用点（缺省钩子会明确报错，而不是让用例静默通过） ──────────────────

async function corruptCheckpoint(options: StorageContractOptions, backend: StorageBackend, checkpointRoot: string): Promise<void> {
  const hook = options.hooks?.corruptCheckpoint
  if (hook === undefined) throw new Error(`[${options.name}] 契约套件未提供 hooks.corruptCheckpoint`)
  await hook(backend, checkpointRoot)
}

async function seedFutureCheckpoint(options: StorageContractOptions, backend: StorageBackend, checkpointRoot: string): Promise<void> {
  const hook = options.hooks?.seedFutureCheckpoint
  if (hook === undefined) throw new Error(`[${options.name}] 契约套件未提供 hooks.seedFutureCheckpoint`)
  await hook(backend, checkpointRoot)
}

async function appendRawUsageLine(options: StorageContractOptions, backend: StorageBackend, pipelineId: string, line: string): Promise<void> {
  const hook = options.hooks?.appendRawUsageLine
  if (hook === undefined) throw new Error(`[${options.name}] 契约套件未提供 hooks.appendRawUsageLine`)
  await hook(backend, pipelineId, line)
}

/** 契约套件用到的审计类型（避免调用方额外 import）。 */
export type ContractAuditEvent = AuditEvent
