/**
 * 单机生命周期的硬性质测试（`docs/14` W5）。
 *
 * 三条只有"单机 + 文件后端"才需要单独钉住的性质：
 * 1. **业务状态只写在数据根里**——数据根之外出现任何业务文件，都说明某个入口自己拼了
 *    路径（历史上正是"三个入口拼出三条不同路径"的同类问题）。这条性质靠
 *    "把数据根放进一个父目录，跑完整生命周期后比对父目录"来验证。
 * 2. **重启后事实从磁盘重建**——进程内只有句柄，杀掉之后必须能靠检查点/产物/门任务
 *    还原出同一条流水线的状态。
 * 3. **数据根按需自动创建**——不需要用户手工 mkdir 每一层。
 *
 * @module platform-pipeline/test/web-single-node
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readdir, rm, stat } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { tmpdir } from 'node:os'

import type { PipelineConfig } from '../src/types.ts'
import { resolvePlatformRoots } from '../src/platform-roots.ts'
import { createMemoryStorageBackend } from '../src/storage/memory/index.ts'
import { AsyncPipelineRunner } from '../src/web/async-runner.ts'
import { FilePipelineRunService } from '../src/web/pipeline-run-service.ts'
import { CREATE, REVIEWER, SCOPE, ScriptedHost, baseConfig } from './web-fixtures.ts'

let parent: string
let dir: string
let config: PipelineConfig

test.beforeEach(async () => {
  // 数据根放在一个**父目录**里：这样才能断言"数据根之外没被写"。
  parent = await mkdtemp(join(tmpdir(), 'pp-single-'))
  dir = join(parent, 'data')
  await mkdir(dir, { recursive: true })
  config = baseConfig()
})
test.afterEach(async () => { await rm(parent, { recursive: true, force: true }) })

function serviceOf(host: ScriptedHost): FilePipelineRunService {
  return new FilePipelineRunService({ dataRoot: dir, loadConfig: async () => config, createHost: host.factory })
}

/** 递归列出某目录下的全部文件（相对该目录的路径，已排序）。 */
async function listFiles(root: string): Promise<readonly string[]> {
  const out: string[] = []
  async function walk(current: string): Promise<void> {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const full = join(current, entry.name)
      if (entry.isDirectory()) { await walk(full); continue }
      if (entry.isFile()) out.push(relative(root, full))
    }
  }
  await walk(root)
  return out.sort()
}

/** 跑完一条完整生命周期：创建 → 跑到门 → 裁决 → 继续跑到下一个门。 */
async function runLifecycle(service: FilePipelineRunService): Promise<void> {
  await service.create(CREATE, REVIEWER)
  await service.run('pipe-1', REVIEWER)
  const [task] = await service.listGateTasks(SCOPE, REVIEWER)
  assert.ok(task !== undefined)
  await service.claimGate({ ...SCOPE, gateTaskId: task.gateTaskId }, REVIEWER)
  await service.decideGate({ ...SCOPE, gateTaskId: task.gateTaskId, action: 'approved' }, REVIEWER)
  await service.run('pipe-1', REVIEWER)
}

test('W5：完整生命周期只写数据根，数据根之外一个业务文件都没有', async () => {
  await runLifecycle(serviceOf(new ScriptedHost()))

  // 数据根里确实有东西（否则"没写外面"是空洞的）。
  const inside = await listFiles(dir)
  assert.ok(inside.length > 0, '生命周期跑完，数据根里应当有持久化事实')

  // 数据根**之外**（父目录里除 data 以外的部分）不得出现任何文件。
  const outside = (await listFiles(parent)).filter(path => !path.startsWith('data/'))
  assert.deepEqual(outside, [],
    `数据根之外出现业务文件，说明某个入口自己拼了路径：${outside.join(', ')}`)

  // 关键事实落在预期位置（不是"写到别处恰好没被检查到"）。
  const roots = resolvePlatformRoots(dir, config)
  assert.ok(inside.includes(relative(dir, join(dir, 'pipelines', 'pipe-1.json'))), '索引应在 <dataRoot>/pipelines/')
  assert.ok(inside.some(path => path.endsWith('checkpoints/pipe-1/checkpoint.json')), '检查点应在 checkpoints/<id>/')
  assert.ok(inside.some(path => path.endsWith('artifacts/pipe-1/receive.json')), '产物应在 artifacts/<id>/')
  assert.ok(inside.some(path => path.endsWith('gates') || path.includes('/gates/')), '门任务应落在 gates/')
  void roots
})

test('W5：重启后事实从磁盘重建（进程内只剩句柄）', async () => {
  await runLifecycle(serviceOf(new ScriptedHost()))
  const before = await serviceOf(new ScriptedHost()).get('pipe-1', REVIEWER)

  // 新 service + 新宿主 = 模拟重启：进程内什么都没留下。
  const restarted = serviceOf(new ScriptedHost())
  const after = await restarted.get('pipe-1', REVIEWER)

  assert.deepEqual(after, before, '重启后视图必须逐字相同（事实全在磁盘上）')
  assert.equal(after.status, 'waiting-human', '应当停在第二个阶段的人工门')
  assert.equal(after.currentStage, 'analyze')

  // 门任务与事件同样从磁盘重建。
  const gates = await restarted.listGateTasks(SCOPE, REVIEWER)
  assert.ok(gates.some(task => task.status === 'approved'), '已批准的裁决必须在重启后仍可见')
  const events = await restarted.listEvents('pipe-1', REVIEWER)
  assert.ok(events.some(event => event.kind === 'gate-decided'), '裁决事件必须从磁盘重建')
})

test('W5：恢复扫描在重启后不替人裁决，也不重复 spawn 已完成阶段', async () => {
  await runLifecycle(serviceOf(new ScriptedHost()))

  const host = new ScriptedHost()
  const service = serviceOf(host)
  const runner = new AsyncPipelineRunner({
    service, dataRoot: dir, actor: { actorId: 'runner', tenantId: 'acme' },
  })
  const outcomes = await runner.recover()
  const mine = outcomes.find(item => item.pipelineId === 'pipe-1')
  assert.ok(mine !== undefined, `恢复扫描必须看见这条流水线：${JSON.stringify(outcomes)}`)
  assert.equal(mine.action, 'await-human', '停在人工门必须等真人')
  assert.equal(mine.started, false, '恢复扫描绝不能替人裁决或自动推进')
  await runner.idle()
  assert.deepEqual(host.stages, [], 'await-human 不得触发任何 spawn')
})

test('W5：数据根按需自动创建（不需要用户手工 mkdir 每一层）', async () => {
  // 用一个**不存在**的数据根：服务自己应当把它建出来。
  const fresh = join(parent, 'brand-new-root')
  const host = new ScriptedHost()
  const service = new FilePipelineRunService({
    dataRoot: fresh, loadConfig: async () => config, createHost: host.factory,
  })
  await service.create(CREATE, REVIEWER)

  assert.equal((await stat(fresh)).isDirectory(), true, '数据根必须被自动创建')
  const files = await listFiles(fresh)
  assert.ok(files.length > 0, `创建后应当已有持久化事实：${files.join(', ')}`)
})

test('W5：创建中间态在重启后仍可被接管（不会因为重启永久卡住 pipelineId）', async () => {
  const store = createMemoryStorageBackend().ports.records
  assert.ok(store !== undefined, '内存后端必须提供 records 端口')
  // 手工造一条"索引已写、检查点未确认"的中间态：模拟创建过程中进程被杀。
  await store.write('pipelines', 'pipe-1', {
    pipelineId: 'pipe-1', tenantId: 'acme', projectId: 'demo', configRef: 'pipeline.yaml',
    creationState: 'creating',
  })

  const service = new FilePipelineRunService({
    dataRoot: dir, loadConfig: async () => config, createHost: new ScriptedHost().factory,
    createHostRecordStore: () => store,
  })
  // 重启之后重新 create 同一 pipelineId → 接管中间态，而不是永久 conflict。
  const summary = await service.create(CREATE, REVIEWER)
  assert.equal(summary.pipelineId, 'pipe-1')
  assert.equal((await service.get('pipe-1', REVIEWER)).status, 'queued')
})
