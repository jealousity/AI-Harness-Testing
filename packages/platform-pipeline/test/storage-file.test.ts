/**
 * 文件后端契约测试（docs/10 §8.4 第一半：同一套契约跑通 file backend）。
 *
 * 本文件做两件事：
 * 1. 用 `test/storage-contract.ts` 的**后端无关**契约套件跑文件后端；
 * 2. 补文件后端**专有**的保证——备份目录真的落在磁盘上、锁工厂可用、
 *    损坏记录不会被覆盖、裸 content 产物不算损坏。
 *
 * @module platform-pipeline/test/storage-file
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { PipelineLockHeldError } from '../src/checkpoint-lock.ts'
import { StorageCorruptError, createFileStorageBackend, type StorageBackend } from '../src/storage/index.ts'
import { makeCheckpoint, runStorageContract } from './storage-contract.ts'

/**
 * 当前用例的项目根。
 *
 * 只有 `appendRawUsageLine` 钩子需要它——用量日志的路径由后端从项目根推导，
 * 而钩子的入参里没有项目根（契约刻意不暴露实现路径）。顶层用例在文件内是顺序执行的，
 * 因此这个变量在每条用例内都是稳定的。
 */
let currentDir = ''

async function workspace(): Promise<{ dir: string; checkpointRoot: string; backend: StorageBackend }> {
  const dir = await mkdtemp(join(tmpdir(), 'pp-storage-file-'))
  currentDir = dir
  return {
    dir,
    checkpointRoot: join(dir, 'checkpoints'),
    backend: createFileStorageBackend({
      projectRoot: dir,
      knowledgeRoot: join(dir, 'knowledge'),
      casesRoot: join(dir, 'cases'),
    }),
  }
}

runStorageContract({
  name: 'file',
  create: async () => {
    const ws = await workspace()
    return {
      backend: ws.backend,
      checkpointRoot: ws.checkpointRoot,
      cleanup: () => rm(ws.dir, { recursive: true, force: true }),
    }
  },
  seedLegacyRecord: async context => {
    // 历史遗留形态：形状合法但**没有** schemaVersion（v1 之前）。
    const path = join(context.checkpointRoot, 'checkpoint.json')
    await mkdir(context.checkpointRoot, { recursive: true })
    await writeFile(path, JSON.stringify(makeCheckpoint('legacy'), null, 2), 'utf8')
    return {
      ref: 'checkpoints/checkpoint.json',
      read: () => context.backend.ports.checkpoints.load(context.checkpointRoot),
    }
  },
  hooks: {
    corruptCheckpoint: async (_backend, checkpointRoot) => {
      await mkdir(checkpointRoot, { recursive: true })
      // 截断的 JSON：真实场景里就是磁盘写一半 / 被手工改坏。
      await writeFile(join(checkpointRoot, 'checkpoint.json'), '{"pipelineId":"p1","cursor":', 'utf8')
    },
    seedFutureCheckpoint: async (_backend, checkpointRoot) => {
      await mkdir(checkpointRoot, { recursive: true })
      const future = { ...makeCheckpoint('p1'), schemaVersion: 99 }
      await writeFile(join(checkpointRoot, 'checkpoint.json'), JSON.stringify(future, null, 2), 'utf8')
    },
    appendRawUsageLine: async (_backend, pipelineId, line) => {
      const dir = join(currentDir, 'usage')
      await mkdir(dir, { recursive: true })
      await appendFile(join(dir, `${pipelineId}.jsonl`), `${line}\n`, 'utf8')
    },
  },
})

// ── 文件后端专有 ────────────────────────────────────────────────────────────────

test('[file] describe() 声明为无外部依赖的文件后端', async () => {
  const ws = await workspace()
  try {
    const description = ws.backend.describe()
    assert.equal(description.name, 'file')
    assert.equal(description.requiresExternalInfrastructure, false)
    assert.deepEqual(description.unavailablePorts, [])
    assert.ok(description.implementedPorts.includes('lock'))
    assert.ok(description.implementedPorts.includes('knowledge'))
    assert.ok(description.implementedPorts.includes('cases'))
  } finally {
    await rm(ws.dir, { recursive: true, force: true })
  }
})

test('[file] 未声明 knowledge/cases 路径时，端口如实报不可用（不伪装）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pp-storage-file-min-'))
  try {
    const backend = createFileStorageBackend({ projectRoot: dir })
    const description = backend.describe()
    assert.equal(backend.ports.knowledge, undefined)
    assert.equal(backend.ports.cases, undefined)
    const ports = description.unavailablePorts.map(item => item.port).sort()
    assert.deepEqual(ports, ['cases', 'knowledge'])
    for (const item of description.unavailablePorts) assert.notEqual(item.reason.trim(), '')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('[file] 迁移在磁盘上留下备份目录，原文件可回滚', async () => {
  const ws = await workspace()
  try {
    const path = join(ws.checkpointRoot, 'checkpoint.json')
    await mkdir(ws.checkpointRoot, { recursive: true })
    const original = JSON.stringify(makeCheckpoint('legacy'), null, 2)
    await writeFile(path, original, 'utf8')

    const report = await ws.backend.migrate!()
    assert.equal(report.migrated.length, 1)
    assert.notEqual(report.backupDir, null, '迁移必须留备份')
    assert.equal(report.backupDir!.startsWith('/'), false, '备份路径相对项目根，不泄露绝对路径')

    const backup = join(ws.dir, report.backupDir!, 'checkpoints', 'checkpoint.json')
    assert.equal(existsSync(backup), true, `备份文件应存在：${backup}`)
    assert.equal(await readFile(backup, 'utf8'), original, '备份内容必须与迁移前逐字节一致')

    const migrated = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>
    assert.equal(migrated.schemaVersion, 1)
    assert.equal(migrated.pipelineId, 'legacy')
  } finally {
    await rm(ws.dir, { recursive: true, force: true })
  }
})

test('[file] 迁移遇到损坏记录只跳过它，不动原件、不阻断其它记录', async () => {
  const ws = await workspace()
  try {
    const legacyPath = join(ws.checkpointRoot, 'checkpoint.json')
    await mkdir(ws.checkpointRoot, { recursive: true })
    await writeFile(legacyPath, JSON.stringify(makeCheckpoint('legacy'), null, 2), 'utf8')
    // 另造一条损坏记录（同一个 checkpoint 目录下不会被扫到，因此放到 tasks/ 里）。
    const tasksDir = join(ws.dir, 'tasks')
    await mkdir(tasksDir, { recursive: true })
    const brokenPath = join(tasksDir, 'broken.json')
    await writeFile(brokenPath, '{ not json', 'utf8')

    const report = await ws.backend.migrate!()
    assert.equal(report.migrated.length, 1, JSON.stringify(report))
    assert.equal(report.skipped.length, 1)
    assert.match(report.skipped[0]!.reason, /损坏|不是合法 JSON/)
    assert.equal(await readFile(brokenPath, 'utf8'), '{ not json', '损坏原件必须原样保留')
  } finally {
    await rm(ws.dir, { recursive: true, force: true })
  }
})

test('[file] 锁工厂绑定检查点根：同一 pipeline 第二次获取被拒绝', async () => {
  const ws = await workspace()
  try {
    const lock = await ws.backend.ports.lock!('p1', { ownerId: 'owner-a', heartbeatMs: 0 })
    assert.equal(lock.pipelineId, 'p1')
    await assert.rejects(
      () => ws.backend.ports.lock!('p1', { ownerId: 'owner-b', heartbeatMs: 0 }),
      (error: unknown) => {
        assert.ok(error instanceof PipelineLockHeldError, `期望 PipelineLockHeldError，实际 ${(error as Error)?.name}`)
        return true
      },
    )
    // 不同 pipeline 互不阻塞。
    const other = await ws.backend.ports.lock!('p2', { ownerId: 'owner-b', heartbeatMs: 0 })
    assert.equal(other.pipelineId, 'p2')
    await other.release()

    assert.equal(await lock.release(), true)
    const again = await ws.backend.ports.lock!('p1', { ownerId: 'owner-c', heartbeatMs: 0 })
    await again.release()
  } finally {
    await rm(ws.dir, { recursive: true, force: true })
  }
})

test('[file] 产物是"裸 content"时不算损坏（阶段 agent 首次写入的合法形态）', async () => {
  const ws = await workspace()
  try {
    const dir = join(ws.dir, 'artifacts', 'p1')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'receive.json'), JSON.stringify({ summary: '裸内容' }), 'utf8')

    const health = await ws.backend.diagnose()
    assert.equal(health.ok, true, `裸 content 产物不应被判损坏：${JSON.stringify(health.diagnostics)}`)
    // 而且它仍能被读出来（FsArtifactStore 会补最小 wrapper）。
    const artifact = await ws.backend.ports.artifacts.read('artifacts/p1/receive.json')
    assert.notEqual(artifact, null)
    assert.deepEqual(artifact!.content, { summary: '裸内容' })
  } finally {
    await rm(ws.dir, { recursive: true, force: true })
  }
})

test('[file] 损坏的用例记录会被显式拒绝，绝不被 archive 覆盖', async () => {
  const ws = await workspace()
  try {
    const path = join(ws.dir, 'cases', 'c1.json')
    await mkdir(join(ws.dir, 'cases'), { recursive: true })
    await writeFile(path, '{ "caseId": "c1", "versions": [', 'utf8')

    await assert.rejects(
      () => ws.backend.ports.cases!.archive({ caseId: 'c1', version: 'v1', project: 'proj', sourceRequirement: 'r1', ticketRef: 'T-1', content: {} }),
      (error: unknown) => {
        assert.ok(error instanceof StorageCorruptError, `期望 StorageCorruptError，实际 ${(error as Error)?.name}`)
        return true
      },
    )
    assert.equal(
      await readFile(path, 'utf8'), '{ "caseId": "c1", "versions": [',
      '损坏原件必须原样保留（不能覆盖旧数据）',
    )
    // 检索也必须显式失败，不能把损坏文件当成"这个项目没有用例"。
    await assert.rejects(() => ws.backend.ports.cases!.query({ project: 'proj' }), StorageCorruptError)
  } finally {
    await rm(ws.dir, { recursive: true, force: true })
  }
})

test('[file] 知识元数据损坏时检索显式失败，不静默少一条', async () => {
  const ws = await workspace()
  try {
    await mkdir(join(ws.dir, 'knowledge'), { recursive: true })
    await writeFile(join(ws.dir, 'knowledge', 'kb-1.md'), '<!-- pp-meta: {oops -->\n正文\n', 'utf8')

    await assert.rejects(
      () => ws.backend.ports.knowledge!.read({ project: 'proj', entities: ['x'], limit: 5 }),
      StorageCorruptError,
    )
    const health = await ws.backend.diagnose()
    assert.equal(health.ok, false)
    assert.ok(health.diagnostics.some(item => item.kind === 'knowledge-entry' && item.code === 'corrupt-json'))
  } finally {
    await rm(ws.dir, { recursive: true, force: true })
  }
})

test('[file] 体检报出缺版本的历史记录，且不把它们当损坏', async () => {
  const ws = await workspace()
  try {
    const path = join(ws.checkpointRoot, 'checkpoint.json')
    await mkdir(ws.checkpointRoot, { recursive: true })
    await writeFile(path, JSON.stringify(makeCheckpoint('legacy'), null, 2), 'utf8')

    const health = await ws.backend.diagnose()
    assert.equal(health.ok, false, '缺版本是待办，不是健康')
    assert.deepEqual(health.diagnostics.map(item => item.code), ['migration-needed'])
    assert.equal(health.diagnostics[0]!.recoverable, true)
    // 但它是**可读**的：旧版本按 v1 读，不能因此拒绝启动。
    assert.notEqual(await ws.backend.ports.checkpoints.load(ws.checkpointRoot), null)
  } finally {
    await rm(ws.dir, { recursive: true, force: true })
  }
})
