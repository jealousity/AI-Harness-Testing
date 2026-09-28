/**
 * 数据根体检的测试（`docs/14` W5 第 9 条）。
 *
 * 体检的价值全在"能不能如实报出坏东西"。因此这一组**刻意把数据根弄坏**，逐类验证：
 * checkpoint 损坏、索引损坏、用量坏行、创建中间态、运行锁残留，以及权限与不存在。
 *
 * 同时钉住一条容易被写坏的性质：**体检只读**——跑完体检之后数据根必须一字未改。
 *
 * @module platform-pipeline/test/web-diagnostics
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { appendFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import type { PipelineConfig } from '../src/types.ts'
import { resolvePlatformRoots } from '../src/platform-roots.ts'
import { createFileStorageBackendFromRoots } from '../src/storage/file/index.ts'
import { FilePipelineRunService } from '../src/web/pipeline-run-service.ts'
import { PipelineRunError } from '../src/web/pipeline-run-types.ts'
import { CREATE, REVIEWER, SCOPE, ScriptedHost, baseConfig } from './web-fixtures.ts'

const OPERATOR = { actorId: 'ops-1', tenantId: 'acme', roles: ['operator'] as const }
const VIEWER = { actorId: 'viewer-1', tenantId: 'acme', roles: ['viewer'] as const }

let dir: string
let config: PipelineConfig

test.beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'pp-diag-'))
  config = baseConfig()
})
test.afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

function serviceOf(host: ScriptedHost): FilePipelineRunService {
  return new FilePipelineRunService({ dataRoot: dir, loadConfig: async () => config, createHost: host.factory })
}

/** 项目根（数据根下的租户/项目目录）。 */
function projectRoot(): string {
  return resolvePlatformRoots(dir, config).projectRoot
}

/** 数据根的**字节级快照**：用来证明体检是只读的。 */
async function snapshot(): Promise<Readonly<Record<string, string>>> {
  const out: Record<string, string> = {}
  async function walk(current: string): Promise<void> {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const full = join(current, entry.name)
      if (entry.isDirectory()) { await walk(full); continue }
      if (!entry.isFile()) continue
      out[full.slice(dir.length + 1)] = `${(await stat(full)).size}:${createHash('sha256').update(await readFile(full)).digest('hex')}`
    }
  }
  await walk(dir)
  return out
}

test('W5：健康的数据根体检通过，且报告里没有需要处置的项', async () => {
  const service = serviceOf(new ScriptedHost())
  await service.create(CREATE, REVIEWER)

  const report = await service.diagnose('pipe-1', OPERATOR)
  assert.equal(report.pipelineId, 'pipe-1')
  assert.equal(report.projectId, 'demo')
  assert.equal(report.backend.name, 'file')
  assert.equal(report.backend.ok, true)
  assert.deepEqual(report.storage, [], `健康数据根不应有存储诊断：${JSON.stringify(report.storage)}`)
  assert.equal(report.index.entries, 1)
  assert.deepEqual(report.index.unreadable, [])
  assert.equal(report.usageSkippedLines, 0)
  assert.equal(report.creationState, 'ready')
  assert.equal(report.attentionNeeded, false)
})

test('W5：checkpoint 损坏被报出来（corrupt-json），且不可自动修复', async () => {
  const service = serviceOf(new ScriptedHost())
  await service.create(CREATE, REVIEWER)
  // 把检查点写成坏 JSON：模拟磁盘截断 / 手工改错。
  await writeFile(join(projectRoot(), 'checkpoints', 'pipe-1', 'checkpoint.json'), '{ 这不是 JSON', 'utf8')

  const report = await service.diagnose('pipe-1', OPERATOR)
  assert.equal(report.attentionNeeded, true)
  const corrupt = report.storage.find(item => item.code === 'corrupt-json')
  assert.ok(corrupt !== undefined, `必须报出 checkpoint 损坏：${JSON.stringify(report.storage)}`)
  assert.equal(corrupt.kind, 'checkpoint')
  assert.equal(corrupt.recoverable, false, '坏字节不能被自动"修复"（那是在猜）')
  // ref 必须是**相对路径**，不泄露部署布局。
  assert.equal(corrupt.ref.startsWith('/'), false, `ref 不得是绝对路径：${corrupt.ref}`)
})

test('W5：索引损坏被显式列出（不静默跳过），且不影响其它流水线的体检', async () => {
  const service = serviceOf(new ScriptedHost())
  await service.create(CREATE, REVIEWER)
  await service.create({ ...CREATE, pipelineId: 'pipe-2' }, REVIEWER)
  // 弄坏 pipe-2 的索引，然后体检 pipe-1。
  await writeFile(join(dir, 'pipelines', 'pipe-2.json'), '{ 坏掉的索引', 'utf8')

  const report = await service.diagnose('pipe-1', OPERATOR)
  assert.equal(report.attentionNeeded, true, '索引损坏必须让体检标记"需要处置"')
  assert.deepEqual(report.index.unreadable.map(item => item.file), ['pipe-2.json'],
    `不可读项必须逐条列出：${JSON.stringify(report.index.unreadable)}`)
  assert.equal(report.index.entries, 1, '可读的那条仍应计入')
})

test('W5：用量日志坏行被报出来（计量不完整，不能读成"用量为 0"）', async () => {
  const service = serviceOf(new ScriptedHost())
  await service.create(CREATE, REVIEWER)
  await service.run('pipe-1', REVIEWER)

  const usagePath = join(projectRoot(), 'usage', 'pipe-1.jsonl')
  await appendFile(usagePath, '{ 这不是 JSON\n', 'utf8')

  const report = await service.diagnose('pipe-1', OPERATOR)
  assert.equal(report.usageSkippedLines, 1, '坏行必须被计入 skippedLines')
  assert.equal(report.attentionNeeded, true)
})

test('W5：创建中间态能被体检到（不被 conflict 挡住）', async () => {
  // 造一条"索引已写、检查点未确认"的中间态。
  const store = (await import('../src/storage/memory/index.ts')).createMemoryStorageBackend().ports.records
  assert.ok(store !== undefined)
  await store.write('pipelines', 'pipe-1', {
    pipelineId: 'pipe-1', tenantId: 'acme', projectId: 'demo', configRef: 'pipeline.yaml',
    creationState: 'creating',
  })

  const service = new FilePipelineRunService({
    dataRoot: dir, loadConfig: async () => config, createHost: new ScriptedHost().factory,
    createHostRecordStore: () => store,
  })
  // 关键：`get` 会因中间态抛 conflict，但**体检必须能诊断它**——那正是最需要诊断的状态。
  const blocked = await service.get('pipe-1', OPERATOR).then(() => null, (error: unknown) => error)
  assert.equal((blocked as PipelineRunError)?.code, 'conflict', '前置：get 对中间态应当拒绝')

  const report = await service.diagnose('pipe-1', OPERATOR)
  assert.equal(report.creationState, 'creating')
  assert.equal(report.attentionNeeded, true)
})

test('W5：运行锁残留被如实报告（不判定 stale）', async () => {
  const service = serviceOf(new ScriptedHost())
  await service.create(CREATE, REVIEWER)

  // 体检前：没有锁。
  const before = await service.diagnose('pipe-1', OPERATOR)
  assert.equal(before.lock.present, false)
  assert.equal(before.lock.ownerId, null)
  assert.equal(before.lock.ageMs, null)

  // 真的取一把锁并**不释放**（模拟"持锁进程还活着/或崩溃残留"）。
  const backend = createFileStorageBackendFromRoots(resolvePlatformRoots(dir, config))
  assert.ok(backend.ports.lock !== undefined)
  const lock = await backend.ports.lock('pipe-1', { ownerId: 'holder-1' })

  const after = await service.diagnose('pipe-1', OPERATOR)
  assert.equal(after.lock.present, true, '锁目录存在必须被报出来')
  assert.equal(after.lock.ownerId, 'holder-1', '必须能读出 owner（排障要的就是这个）')
  assert.ok(typeof after.lock.ageMs === 'number' && after.lock.ageMs >= 0, '心跳年龄必须是数字')
  await lock.release()
})

test('W5：体检是**只读**的（跑完之后数据根一字未改）', async () => {
  const service = serviceOf(new ScriptedHost())
  await service.create(CREATE, REVIEWER)
  await service.run('pipe-1', REVIEWER)

  const before = await snapshot()
  await service.diagnose('pipe-1', OPERATOR)
  await service.diagnose('pipe-1', OPERATOR)
  const after = await snapshot()
  assert.deepEqual(after, before, '体检不得修改任何持久化事实（它是排障路径，不是写路径）')
})

test('W5：体检要求 operator 角色（viewer 被拒），不存在返回 404', async () => {
  const service = serviceOf(new ScriptedHost())
  await service.create(CREATE, REVIEWER)

  const denied = await service.diagnose('pipe-1', VIEWER).then(() => null, (error: unknown) => error)
  assert.ok(denied instanceof PipelineRunError, `期望 PipelineRunError，实际 ${String(denied)}`)
  assert.equal(denied.code, 'forbidden')

  const missing = await service.diagnose('nope', OPERATOR).then(() => null, (error: unknown) => error)
  assert.ok(missing instanceof PipelineRunError)
  assert.equal(missing.code, 'not-found')
})
