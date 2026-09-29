/**
 * L1a 只读端点的测试（`docs/19` §8）。
 *
 * 两个端点 `listRevisions` / `listRuns` 是 L1 的**只读兼容层**：
 * 把现有 manifest + checkpoint 在内存里投影成 L1 对象。
 *
 * 因此这里要钉住两条**承诺性**断言（不只是"字段对不对"）：
 * 1. **不写盘**：跑完两个端点后，数据根里每个文件的 sha256 与大小必须逐字不变
 *    ——这是"L1a 回滚成本为零"的实质；
 * 2. **不泄露部署布局**：响应里**不得出现**数据根的绝对路径
 *    （`projectLegacy` 产出的 `legacyLocator` 是绝对路径，必须被剥掉）。
 *
 * @module platform-pipeline/test/pipeline-l1a-service
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import type { PipelineConfig } from '../src/types.ts'
import { FilePipelineRunService } from '../src/web/pipeline-run-service.ts'
import { PipelineRunError } from '../src/web/pipeline-run-types.ts'
import { CREATE, REVIEWER, SCOPE, ScriptedHost, baseConfig } from './web-fixtures.ts'

const OPERATOR = { actorId: 'ops-1', tenantId: 'acme', roles: ['operator'] as const }

let dir: string
let config: PipelineConfig

test.beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'pp-l1a-'))
  config = baseConfig()
})
test.afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

function serviceOf(host: ScriptedHost): FilePipelineRunService {
  return new FilePipelineRunService({ dataRoot: dir, loadConfig: async () => config, createHost: host.factory })
}

/** 数据根的字节级快照（路径 → 大小:sha256）。 */
async function snapshot(): Promise<Readonly<Record<string, string>>> {
  const out: Record<string, string> = {}
  async function walk(current: string): Promise<void> {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const full = join(current, entry.name)
      if (entry.isDirectory()) { await walk(full); continue }
      if (!entry.isFile()) continue
      const digest = createHash('sha256').update(await readFile(full)).digest('hex')
      out[full.slice(dir.length + 1)] = `${(await stat(full)).size}:${digest}`
    }
  }
  await walk(dir)
  return out
}

// ── 正向 ─────────────────────────────────────────────────────────────────────

test('L1a：listRevisions 返回 revision-1（含参数与指纹）', async () => {
  const service = serviceOf(new ScriptedHost())
  await service.create({ ...CREATE, targetBaseUrl: 'https://staging.example.com', maxGateRetries: 2 }, REVIEWER)

  const view = await service.listRevisions('pipe-1', OPERATOR)
  assert.equal(view.pipelineId, 'pipe-1')
  assert.equal(view.pipeline.activeRevisionId, 'revision-1')
  assert.equal(view.pipeline.projectId, 'demo')
  assert.equal(view.revisions.length, 1)

  const revision = view.revisions[0]!
  assert.equal(revision.revisionId, 'revision-1')
  assert.equal(revision.revisionNumber, 1)
  assert.equal(revision.status, 'active')
  assert.equal(revision.targetBaseUrl, 'https://staging.example.com')
  assert.equal(revision.maxGateRetries, 2)
  assert.ok(revision.fingerprint.length > 0, '必须有行为指纹（R4）')
  // **L1b 起这条断言的期望变了**：端点优先读**落盘的新格式**，因此 `createdBy` 是真实
  // 创建者而不是 `system:migration`。原先一律用内存投影时，一条刚被 alice 建的流水线
  // 会显示成"迁移产物"——磁盘上写 alice、API 说 migration，同一件事两个说法。
  assert.equal(revision.createdBy, 'alice', 'L1b 之后读的是落盘记录，创建者必须是真人')
  assert.equal(revision.migratedFrom, undefined, '新建的不是迁移产物，不该带迁移标记')
})

test('L1a：listRuns 返回 run-1，状态与游标跟当前检查点走', async () => {
  const service = serviceOf(new ScriptedHost())
  await service.create(CREATE, REVIEWER)

  const fresh = await service.listRuns('pipe-1', OPERATOR)
  assert.equal(fresh.runs.length, 1)
  assert.equal(fresh.runs[0]!.runId, 'run-1')
  assert.equal(fresh.runs[0]!.revisionId, 'revision-1')
  assert.equal(fresh.runs[0]!.attempt, 1)
  assert.equal(fresh.runs[0]!.status, 'queued', '全新流水线应是 queued')
  // **不编时序**：老数据没有 run 的起止时间，L1b 也不编（旧 `Checkpoint` 里就没这两个字段）。
  assert.equal(fresh.runs[0]!.startedAt, undefined)
  assert.equal(fresh.runs[0]!.finishedAt, undefined)

  // 跑到人工门后，状态必须跟着变（说明它读的是**当前**事实，不是创建时的快照）。
  await service.run('pipe-1', REVIEWER)
  const parked = await service.listRuns('pipe-1', OPERATOR)
  assert.equal(parked.runs[0]!.status, 'waiting-human')
  assert.equal(parked.runs[0]!.cursor, 0)
})

// ── 承诺 1：不写盘 ───────────────────────────────────────────────────────────

test('L1a：两个只读端点**不写盘**——数据根逐文件 sha256 必须不变', async () => {
  const service = serviceOf(new ScriptedHost())
  await service.create(CREATE, REVIEWER)
  await service.run('pipe-1', REVIEWER)

  const before = await snapshot()
  assert.ok(Object.keys(before).length > 0, '前置：数据根里应当已有事实')

  await service.listRevisions('pipe-1', OPERATOR)
  await service.listRuns('pipe-1', OPERATOR)
  // 多跑几次，防止"第一次恰好没写、第二次才写"这种偶发。
  await service.listRevisions('pipe-1', OPERATOR)
  await service.listRuns('pipe-1', OPERATOR)

  const after = await snapshot()
  assert.deepEqual(after, before, 'L1a 只读端点不得修改数据根里的任何一个字节')
  // 也不能**新增**文件（尤其是新格式的 pipelines/<id>/revisions/、runs/）。
  const added = Object.keys(after).filter(path => before[path] === undefined)
  assert.deepEqual(added, [], `不得新增任何文件（L1a 不落盘），实际新增：${added.join('、')}`)
})

// ── 承诺 2：不泄露部署布局 ───────────────────────────────────────────────────

test('L1a：响应里不得出现数据根的绝对路径（legacyLocator 必须被剥掉）', async () => {
  const service = serviceOf(new ScriptedHost())
  await service.create(CREATE, REVIEWER)

  for (const view of [
    await service.listRevisions('pipe-1', OPERATOR),
    await service.listRuns('pipe-1', OPERATOR),
  ]) {
    const serialized = JSON.stringify(view)
    assert.equal(serialized.includes(dir), false, `响应不得包含数据根绝对路径：${serialized.slice(0, 300)}`)
    assert.equal(serialized.includes('legacyLocator'), false, 'legacyLocator 是内部字段，不得出 API')
    assert.equal(serialized.includes('checkpointRoot'), false, '不得泄露 checkpoint 根')
  }
})

// ── 权限与存在性 ─────────────────────────────────────────────────────────────

test('L1a：未登记 → not-found；跨作用域 → 也是 not-found（不泄露存在性）', async () => {
  const service = serviceOf(new ScriptedHost())
  await service.create(CREATE, REVIEWER)

  const missing = await service.listRuns('nope', OPERATOR).then(() => null, (error: unknown) => error)
  assert.ok(missing instanceof PipelineRunError)
  assert.equal(missing.code, 'not-found')

  // 跨租户：必须与"不存在"**同码同形**，否则就是存在性枚举通道。
  const foreign = await service
    .listRevisions('pipe-1', { actorId: 'mallory', tenantId: 'other' })
    .then(() => null, (error: unknown) => error)
  assert.ok(foreign instanceof PipelineRunError)
  assert.equal(foreign.code, 'not-found', '跨作用域必须与不存在返回同一个错误码')
})

test('L1a：空 actorId 被拒（与其它端点一致，不因为"只读"就放松）', async () => {
  const service = serviceOf(new ScriptedHost())
  await service.create(CREATE, REVIEWER)
  const denied = await service.listRuns('pipe-1', { actorId: '  ' }).then(() => null, (e: unknown) => e)
  assert.ok(denied instanceof PipelineRunError)
  assert.equal(denied.code, 'unauthenticated')
})

test('L1a：新增只读端点不改变任何现有端点行为（投影与 get 读同一份事实）', async () => {
  const service = serviceOf(new ScriptedHost())
  await service.create(CREATE, REVIEWER)
  await service.run('pipe-1', REVIEWER)

  const view = await service.get('pipe-1', REVIEWER)
  const runs = await service.listRuns('pipe-1', OPERATOR)
  assert.equal(runs.runs[0]!.status, view.status, '投影状态必须与 get 的视图一致（同一份事实）')
  assert.equal(runs.runs[0]!.cursor, view.cursor)
  assert.equal(runs.pipeline.activeRevisionId, 'revision-1')
  void SCOPE
})

// ── 危险特征测试（L1b 必须避开的陷阱）───────────────────────────────────────

test('L1a⚠️：把 PipelineRecord 形状写进 pipelines/<id>.json 会被**静默误读**', async () => {
  // 这不是"期望行为"，而是**当前实现的危险特征**，故意钉住它，原因有二：
  //
  // 1. 现有索引读取器 `isIndexEntry` 只要求 `pipelineId`/`projectId`/`configRef` 非空，
  //    **忽略多余字段**；而 `PipelineRecord` 恰好都有这三个字段 → 会被当成合法 manifest。
  // 2. 于是 `targetBaseUrl` / `providerName` / 运行预算这些**只存在于旧 manifest** 的字段
  //    会被静默丢掉，`create`/`run` 继续"成功"，但行为已经变了。
  //
  // 结论：**L1b 绝对不能把新形状写到 `pipelines/<id>.json`**（那正是旧 manifest 的路径），
  // 必须写到 `pipelines/<id>/pipeline.json`。见 `docs/19` §3.1 的修正说明。
  //
  // 这条测试的价值：如果将来有人"顺手修好" `isIndexEntry` 让它拒绝新形状，
  // 这条测试会失败 → 强制他去更新设计文档，而不是悄悄改掉这个事实。
  const service = serviceOf(new ScriptedHost())
  await service.create({ ...CREATE, targetBaseUrl: 'https://staging.example.com' }, REVIEWER)

  // 把索引文件**原地换成** PipelineRecord 形状（模拟"错误地写到同一路径"）。
  const indexPath = join(dir, 'pipelines', 'pipe-1.json')
  const original = JSON.parse(await readFile(indexPath, 'utf8')) as Record<string, unknown>
  await writeFile(indexPath, JSON.stringify({
    pipelineId: original.pipelineId,
    tenantId: original.tenantId,
    projectId: original.projectId,
    configRef: original.configRef,
    createdAt: original.createdAt,
    activeRevisionId: 'revision-1',   // 新形状的标志字段
  }), 'utf8')

  // 危险特征：服务**没有报错**，照常返回视图……
  const view = await service.get('pipe-1', REVIEWER)
  assert.equal(view.pipelineId, 'pipe-1')
  // ……但运行参数已经不见了（旧 manifest 的字段在新形状里不存在）。
  // `PipelineRunView.params` 来自 manifest，因此这里能直接观察到丢失。
  assert.deepEqual(view.params, {},
    'PipelineRecord 形状下运行参数全部丢失——这正是不能写到同一路径的原因')
})
