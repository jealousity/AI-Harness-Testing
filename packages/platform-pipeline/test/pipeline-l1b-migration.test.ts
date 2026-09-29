/**
 * L1b 的测试：**双写 + 惰性迁移 + 迁移诊断**（`docs/19` §8 L1b、§4.2、§4.3）。
 *
 * 与 L1a 的测试（`pipeline-l1a-service.test.ts`）分工：
 * - L1a 钉的是"**不写盘**"（回滚成本为零）；
 * - L1b 钉的是"**写了什么、什么时候写、写坏了怎么办**"。
 *
 * 三条承诺性断言（不是"字段对不对"）：
 * 1. **迁移不修改旧文件**：迁移前后旧格式的每个文件 sha256 逐字不变（M1）；
 * 2. **迁移幂等**：已迁移过时 `get` 是纯读，第二次不写盘（M3）；
 * 3. **迁移不执行阶段**：迁移只是搬数据，不得顺带推进流水线（M6）。
 *
 * @module platform-pipeline/test/pipeline-l1b-migration
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import type { PipelineConfig } from '../src/types.ts'
import { resolvePlatformRoots } from '../src/platform-roots.ts'
import { createFileHostRecordStore } from '../src/storage/file/records.ts'
import { createFileStorageBackendFromRoots } from '../src/storage/index.ts'
import { FilePipelineRunService } from '../src/web/pipeline-run-service.ts'
import {
  PIPELINE_INDEX_COLLECTION,
  pipelineIndexDir,
} from '../src/web/pipeline-run-service.ts'
import {
  readL1Snapshot,
  readRun,
  writeRun,
} from '../src/web/pipeline-l1-store.ts'
import {
  L1_INDEX_COLLECTION,
  pipelineIndexDir as locatorIndexDir,
  pipelineIndexEntryPath,
  pipelineRecordKey,
  pipelineRecordPath,
  revisionKey,
  revisionPath,
  runKey,
  runRecordPath,
} from '../src/web/pipeline-locator.ts'
import { CREATE, REVIEWER, ScriptedHost, baseConfig } from './web-fixtures.ts'

const OPERATOR = { actorId: 'ops-1', tenantId: 'acme', roles: ['operator'] as const }

/** 新格式在数据根里的前缀（迁移**允许**动这里，旧格式一个字节都不能动）。 */
const L1_PREFIX = join('pipelines', 'pipe-1') + '/'

let dir: string
let config: PipelineConfig

test.beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'pp-l1b-'))
  config = baseConfig()
})
test.afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

function serviceOf(host: ScriptedHost): FilePipelineRunService {
  return new FilePipelineRunService({ dataRoot: dir, loadConfig: async () => config, createHost: host.factory })
}

/** 数据根的字节级快照（相对路径 → 大小:sha256）。 */
async function snapshot(): Promise<Record<string, string>> {
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

/** 审计日志是**只追加**的观测通道（M2 要求迁移往它追加事件），因此单独比。 */
const AUDIT_LOG = join('tenants', 'acme', 'projects', 'demo', 'audit', 'audit.jsonl')

/**
 * 只取旧格式的**事实文件**（排除 `pipelines/<id>/` 下的新格式，以及只追加的审计日志）。
 *
 * 为什么排除审计日志而不是放宽整条断言：M1 要保护的是**事实**（manifest / checkpoint /
 * 产物）——迁移是"读旧写新"，一个字节都不该动它们。审计日志则相反：M2 明确要求
 * 迁移前写 `migration-intent`、成功后写 `migration-completed`。把日志算进"不得变化"
 * 会让 M1 与 M2 互相打架；正确做法是分开判：事实必须**逐字不变**，
 * 日志必须**只追加**（见 `assertAppendOnly`）。
 */
function legacyFacts(all: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(all).filter(([path]) => !path.startsWith(L1_PREFIX) && path !== AUDIT_LOG),
  )
}

/** 断言 `after` 只是在 `before` 之后追加，没有改写已有内容。 */
async function assertAppendOnly(before: Record<string, string>): Promise<void> {
  const text = await readFile(join(dir, AUDIT_LOG), 'utf8')
  const beforeLength = before[AUDIT_LOG] === undefined
    ? 0
    : Number(before[AUDIT_LOG]!.split(':')[0])
  assert.ok(text.length >= beforeLength, '审计日志不得变短（不得改写或截断已有事件）')
  const prefixDigest = createHash('sha256').update(text.slice(0, beforeLength)).digest('hex')
  if (beforeLength > 0) {
    const expectedDigest = before[AUDIT_LOG]!.split(':')[1]!
    assert.equal(prefixDigest, expectedDigest, '审计日志只能追加，已有前缀的 sha256 必须不变')
  }
}

function l1Store(): ReturnType<typeof createFileHostRecordStore> {
  return createFileHostRecordStore(dir)
}

/** 模拟"L1b 之前建的老数据"：把新格式三件套删掉，只留旧格式。 */
async function degradeToLegacyOnly(): Promise<void> {
  const store = l1Store()
  await store.remove('pipelines/pipe-1', 'pipeline')
  await store.remove('pipelines/pipe-1/revisions', 'revision-1')
  await store.remove('pipelines/pipe-1/runs', 'run-1')
}

function auditOf(): ReturnType<typeof createFileStorageBackendFromRoots>['ports']['audit'] {
  return createFileStorageBackendFromRoots(resolvePlatformRoots(dir, config)).ports.audit
}

// ── 双写 ─────────────────────────────────────────────────────────────────────

test('L1b 双写：create 之后新格式三件套与旧事实同时存在，且内容一致', async () => {
  const host = new ScriptedHost()
  const service = serviceOf(host)
  await service.create({ ...CREATE, targetBaseUrl: 'https://staging.example.com', maxGateRetries: 2 }, REVIEWER)

  const snapshotL1 = await readL1Snapshot(l1Store(), 'pipe-1')
  assert.equal(snapshotL1.record.state, 'ok', 'create 必须双写 PipelineRecord')
  assert.equal(snapshotL1.revisions.ok.length, 1)
  assert.equal(snapshotL1.runs.ok.length, 1)

  const record = snapshotL1.record.state === 'ok' ? snapshotL1.record.value : null
  assert.equal(record?.activeRevisionId, 'revision-1')
  assert.equal(record?.projectId, 'demo')
  assert.equal(record?.configRef, 'pipeline.yaml')
  // 新建**不是**迁移：不许把创建者写成 system:migration（那会把"张三建的"说成迁移产物）。
  assert.equal(snapshotL1.revisions.ok[0]!.createdBy, 'alice')
  assert.equal(snapshotL1.revisions.ok[0]!.migratedFrom, undefined)
  assert.equal(snapshotL1.revisions.ok[0]!.targetBaseUrl, 'https://staging.example.com')
  assert.equal(snapshotL1.runs.ok[0]!.createdBy, 'alice')
  assert.equal(snapshotL1.runs.ok[0]!.status, 'queued')

  // 新旧同源：`get` 看到的参数与 revision-1 是同一份事实。
  const view = await service.get('pipe-1', REVIEWER)
  assert.equal(view.params?.targetBaseUrl, snapshotL1.revisions.ok[0]!.targetBaseUrl)
  assert.equal(view.params?.maxGateRetries, snapshotL1.revisions.ok[0]!.maxGateRetries)

  // 物理布局就是 docs/19 §3.1 那一个（不是 `pipelines/<id>.json`，见 §3.3）。
  const all = await snapshot()
  assert.ok(all[join('pipelines', 'pipe-1', 'pipeline.json')] !== undefined)
  assert.ok(all[join('pipelines', 'pipe-1', 'revisions', 'revision-1.json')] !== undefined)
  assert.ok(all[join('pipelines', 'pipe-1', 'runs', 'run-1.json')] !== undefined)
  assert.ok(all[join('pipelines', 'pipe-1.json')] !== undefined, '旧扁平索引必须原样保留')
})

test('L1b 双写：PATCH 创建新 revision（R7 去重 / R2 递增 / R3 单一 active）', async () => {
  const service = serviceOf(new ScriptedHost())
  await service.create(CREATE, REVIEWER)

  // ① 无行为变化 → R7：不新建 revision（否则"改了个空格产生一版"）。
  await service.update({ pipelineId: 'pipe-1' }, REVIEWER)
  let snapshotL1 = await readL1Snapshot(l1Store(), 'pipe-1')
  assert.deepEqual(snapshotL1.revisions.ok.map(item => item.revisionId), ['revision-1'],
    'R7：行为参数没变就不该产生新版本')

  // ② 行为变化 → 新建 revision-2，旧版转 superseded（R3 单一 active）。
  await service.update({ pipelineId: 'pipe-1', maxGateRetries: 5 }, REVIEWER)
  snapshotL1 = await readL1Snapshot(l1Store(), 'pipe-1')
  assert.deepEqual(snapshotL1.revisions.ok.map(item => item.revisionId), ['revision-1', 'revision-2'])
  assert.deepEqual(snapshotL1.revisions.ok.map(item => item.revisionNumber), [1, 2], 'R2：编号连续递增')
  assert.deepEqual(snapshotL1.revisions.ok.map(item => item.status), ['superseded', 'active'], 'R3：最多一个 active')
  const record = snapshotL1.record.state === 'ok' ? snapshotL1.record.value : null
  assert.equal(record?.activeRevisionId, 'revision-2', 'activeRevisionId 必须跟着走（P5）')
  assert.equal(snapshotL1.revisions.ok[1]!.maxGateRetries, 5)

  // ③ 再 PATCH 成**同一份**参数 → 仍然不新建（指纹口径与迁移路径一致）。
  await service.update({ pipelineId: 'pipe-1', maxGateRetries: 5 }, REVIEWER)
  snapshotL1 = await readL1Snapshot(l1Store(), 'pipe-1')
  assert.equal(snapshotL1.revisions.ok.length, 2)

  // 旧侧必须同步（L1b 是"双写"，不是"只写新的"）。
  const view = await service.get('pipe-1', REVIEWER)
  assert.equal(view.params?.maxGateRetries, 5)
})

test('L1b 双写：run 之后 run-1 的状态与游标跟着检查点刷新', async () => {
  const service = serviceOf(new ScriptedHost())
  await service.create(CREATE, REVIEWER)
  await service.run('pipe-1', REVIEWER)

  const snapshotL1 = await readL1Snapshot(l1Store(), 'pipe-1')
  const run = snapshotL1.runs.ok[0]!
  const view = await service.get('pipe-1', REVIEWER)
  assert.equal(run.status, view.status, 'run 镜像必须与 get 的视图同源')
  assert.equal(run.status, 'waiting-human')
  assert.equal(run.cursor, view.cursor)
  // 旧检查点里没有 run 的起止时间，因此不许编（Checkpoint 类型里就没有这两个字段）。
  assert.equal(run.startedAt, undefined)
  assert.equal(run.finishedAt, undefined)
})

// ── 惰性迁移 ─────────────────────────────────────────────────────────────────

test('L1b 迁移：老数据被 get 访问时补齐新格式，且**旧文件逐字节不变**（M1）', async () => {
  const service = serviceOf(new ScriptedHost())
  await service.create(CREATE, REVIEWER)
  await service.run('pipe-1', REVIEWER)
  await degradeToLegacyOnly()

  const before = await snapshot()
  assert.equal(Object.keys(legacyFacts(before)).length > 0, true, '前置：旧格式事实应当存在')

  const view = await service.get('pipe-1', REVIEWER)
  assert.equal(view.pipelineId, 'pipe-1')

  const after = await snapshot()
  assert.deepEqual(legacyFacts(after), legacyFacts(before),
    'M1：迁移**不得修改、不得删除**旧文件（逐文件 sha256 比对）')
  await assertAppendOnly(before)

  // 新格式必须真的补齐了，而且出处标成迁移。
  const snapshotL1 = await readL1Snapshot(l1Store(), 'pipe-1')
  assert.equal(snapshotL1.record.state, 'ok')
  assert.deepEqual(snapshotL1.revisions.ok.map(item => item.revisionId), ['revision-1'])
  assert.deepEqual(snapshotL1.runs.ok.map(item => item.runId), ['run-1'])
  assert.equal(snapshotL1.revisions.ok[0]!.createdBy, 'system:migration')
  assert.equal(snapshotL1.revisions.ok[0]!.migratedFrom, 'legacy-manifest')
})

test('L1b 迁移：已迁移过时 get 是纯读——第二次不写盘（M3 幂等）', async () => {
  const service = serviceOf(new ScriptedHost())
  await service.create(CREATE, REVIEWER)
  await degradeToLegacyOnly()

  await service.get('pipe-1', REVIEWER)
  const afterFirst = await snapshot()
  await service.get('pipe-1', REVIEWER)
  await service.get('pipe-1', REVIEWER)
  const afterThird = await snapshot()
  assert.deepEqual(afterThird, afterFirst,
    'M3：迁移幂等——已迁移过时读端点不得再写盘（否则每次 get 都是一次写）')
})

test('L1b 迁移：中断（只写了 record）后重跑幂等补齐（§4.3）', async () => {
  const service = serviceOf(new ScriptedHost())
  await service.create(CREATE, REVIEWER)
  await service.run('pipe-1', REVIEWER)

  // 制造"迁移中断"的主形态：record 在、revisions/runs 缺。
  const store = l1Store()
  await store.remove('pipelines/pipe-1/revisions', 'revision-1')
  await store.remove('pipelines/pipe-1/runs', 'run-1')
  const broken = await readL1Snapshot(store, 'pipe-1')
  assert.equal(broken.record.state, 'ok')
  assert.equal(broken.revisions.ok.length, 0)
  assert.equal(broken.runs.ok.length, 0)

  await service.get('pipe-1', REVIEWER)
  const healed = await readL1Snapshot(l1Store(), 'pipe-1')
  assert.deepEqual(healed.revisions.ok.map(item => item.revisionId), ['revision-1'],
    '重跑必须补回**同一个** revision-1（id 是确定性的，不能变成 revision-2）')
  assert.deepEqual(healed.runs.ok.map(item => item.runId), ['run-1'])
  assert.equal(healed.runs.ok[0]!.status, 'waiting-human', '补回来的 run 状态要与当前事实一致')
})

test('L1b 迁移：写审计且事件**读得出来**（钉住类型与白名单同步）', async () => {
  const service = serviceOf(new ScriptedHost())
  await service.create(CREATE, REVIEWER)
  await degradeToLegacyOnly()

  await service.get('pipe-1', REVIEWER)

  const read = await auditOf().read({ pipelineId: 'pipe-1' })
  const kinds = read.events.map(event => event.kind)
  // 成对出现（M2）：只有"意图"没有"完成"说明那一次是中断的。
  assert.ok(kinds.includes('migration-intent'), `缺 migration-intent：${kinds.join('、')}`)
  assert.ok(kinds.includes('migration-completed'), `缺 migration-completed：${kinds.join('、')}`)
  // 读侧白名单必须包含它们——只加类型不加数组会让事件"记了但永远查不出来"（踩过一次）。
  assert.equal(read.skipped.length, 0)
})

test('L1b 迁移：**不触发任何阶段执行**（M6）', async () => {
  const host = new ScriptedHost()
  const service = serviceOf(host)
  await service.create(CREATE, REVIEWER)
  await service.run('pipe-1', REVIEWER)
  await degradeToLegacyOnly()

  const stagesBefore = [...host.stages]
  await service.get('pipe-1', REVIEWER)
  assert.deepEqual([...host.stages], stagesBefore, 'M6：迁移只是搬数据，不得顺带推进流水线')
})

// ── 迁移诊断（§4.3）──────────────────────────────────────────────────────────

test('L1b 诊断：migrated / needed / incomplete / conflict 四态都报得出', async () => {
  const service = serviceOf(new ScriptedHost())
  await service.create(CREATE, REVIEWER)

  // ① 双写之后 → migrated
  let report = (await service.diagnose('pipe-1', OPERATOR)).migration
  assert.equal(report.state, 'migrated')
  assert.equal(report.record, 'ok')
  assert.equal(report.revisions, 1)
  assert.equal(report.runs, 1)
  assert.deepEqual(report.diagnostics, [])

  // ② 新格式一个字都没有 → needed（**不算 attentionNeeded**：L1b 期间这是正常状态）
  await degradeToLegacyOnly()
  const diagnostics = await service.diagnose('pipe-1', OPERATOR)
  report = diagnostics.migration
  assert.equal(report.state, 'needed')
  assert.equal(report.record, 'missing')
  assert.deepEqual(report.diagnostics.map(item => item.code), ['migration-needed'])
  assert.equal(report.diagnostics[0]!.recoverable, true, 'needed 是**可自动修复**的（下次访问会补）')
  assert.equal(diagnostics.attentionNeeded, false, 'needed 不该把整份体检报成"需要处置"')

  // ③ 写了一半 → incomplete
  await service.get('pipe-1', REVIEWER)
  await l1Store().remove('pipelines/pipe-1/runs', 'run-1')
  report = (await service.diagnose('pipe-1', OPERATOR)).migration
  assert.equal(report.state, 'incomplete')
  assert.deepEqual(report.diagnostics.map(item => item.code), ['migration-incomplete'])
  assert.equal(report.diagnostics[0]!.recoverable, true, '重跑迁移即可（幂等）')

  // ④ 新旧不一致 → conflict（这里把 run 的游标改坏）
  await service.get('pipe-1', REVIEWER)
  const store = l1Store()
  const runRead = await readRun(store, 'pipe-1', 'run-1')
  assert.equal(runRead.state, 'ok')
  if (runRead.state === 'ok') await writeRun(store, { ...runRead.value, cursor: 99 })
  const conflictDiagnostics = await service.diagnose('pipe-1', OPERATOR)
  report = conflictDiagnostics.migration
  assert.equal(report.state, 'conflict')
  assert.deepEqual(report.diagnostics.map(item => item.code), ['migration-conflict'])
  assert.ok(report.diagnostics[0]!.detail.includes('run.cursor'),
    `冲突明细必须指出**哪个字段**，实际：${report.diagnostics[0]!.detail}`)
  assert.equal(report.diagnostics[0]!.recoverable, false, '冲突要人判断，不能宣称可自动修复')
  assert.equal(conflictDiagnostics.attentionNeeded, true)
})

test('L1b 诊断：体检**只读**——跑完不得改变任何文件', async () => {
  const service = serviceOf(new ScriptedHost())
  await service.create(CREATE, REVIEWER)
  await degradeToLegacyOnly()

  const before = await snapshot()
  await service.diagnose('pipe-1', OPERATOR)
  assert.deepEqual(await snapshot(), before, '体检是排障入口，不得改变被观察对象')
})

test('L1b 迁移：新格式走**注入的**记录存储，不落在本地盘（换后端只改装配）', async () => {
  const store = l1Store()
  const service = new FilePipelineRunService({
    dataRoot: dir,
    loadConfig: async () => config,
    createHost: new ScriptedHost().factory,
    createHostRecordStore: () => store,
  })
  await service.create(CREATE, REVIEWER)

  const snapshotL1 = await readL1Snapshot(store, 'pipe-1')
  assert.equal(snapshotL1.record.state, 'ok', '新格式必须落在注入的存储里')

  // 旧扁平索引也必须在同一个存储里（否则"索引在 A、新记录在 B"这种半分裂无法诊断）。
  const indexPath = pipelineIndexEntryPath(dir, 'pipe-1')
  const indexRead = await store.read('pipelines', 'pipe-1')
  assert.notEqual(indexRead, null)
  assert.equal(indexPath.endsWith(join('pipelines', 'pipe-1.json')), true)
})

// ── 新端点的读侧：优先落盘，缺失才回落投影 ───────────────────────────────────

test('L1b 读侧：新端点优先读**落盘**的新格式（不把真人建的流水线说成迁移产物）', async () => {
  const service = serviceOf(new ScriptedHost())
  await service.create({ ...CREATE, targetBaseUrl: 'https://staging.example.com' }, REVIEWER)

  const revisions = await service.listRevisions('pipe-1', OPERATOR)
  const revision = revisions.revisions[0]!
  // 落盘记录说 createdBy=alice；若端点去用内存投影，就会说 system:migration——
  // 同一件事两个说法，而"谁做的"正是审计存在的理由。实测（真实服务冒烟）抓到过。
  assert.equal(revision.createdBy, 'alice')
  assert.equal(revision.migratedFrom, undefined)
  assert.equal(revisions.pipeline.activeRevisionId, 'revision-1')

  const runs = await service.listRuns('pipe-1', OPERATOR)
  assert.equal(runs.runs[0]!.createdBy, 'alice')

  // 落盘的那一份必须与端点返回的一致（同一事实，不是两份）。
  const snapshotL1 = await readL1Snapshot(l1Store(), 'pipe-1')
  assert.deepEqual(snapshotL1.revisions.ok, revisions.revisions)
  assert.deepEqual(snapshotL1.runs.ok, runs.runs)
})

test('L1b 读侧：新格式不齐全时回落到内存投影（老数据仍可读）', async () => {
  const service = serviceOf(new ScriptedHost())
  await service.create(CREATE, REVIEWER)
  await degradeToLegacyOnly()

  const revisions = await service.listRevisions('pipe-1', OPERATOR)
  assert.equal(revisions.revisions.length, 1)
  assert.equal(revisions.revisions[0]!.createdBy, 'system:migration',
    '回落投影时出处必须是"迁移"，不能冒充真人')
  assert.equal(revisions.revisions[0]!.migratedFrom, 'legacy-manifest')

  // **回落是只读的**：`listRevisions` 不是迁移触发点（那只有 `get`），因此磁盘上仍无新格式。
  const snapshotL1 = await readL1Snapshot(l1Store(), 'pipe-1')
  assert.equal(snapshotL1.record.state, 'missing', '读端点不得顺手写盘')
})

// ── 并发 ─────────────────────────────────────────────────────────────────────

test('L1b 并发：两个 get 同时触发迁移，不得产生垃圾 revision（幂等的前提）', async () => {
  const service = serviceOf(new ScriptedHost())
  await service.create(CREATE, REVIEWER)
  await degradeToLegacyOnly()

  // 迁移的内容是**确定性**的（revision-1/run-1 由 pipelineId 推出、内容来自同一份旧事实），
  // 加上记录存储的写是原子的，因此两个并发迁移只会写出同一份结果。
  // 这条不变量很重要：否则"多副本/多进程同时访问老数据"会各自造出一个 revision-N。
  await Promise.all([
    service.get('pipe-1', REVIEWER),
    service.get('pipe-1', REVIEWER),
    service.get('pipe-1', REVIEWER),
  ])

  const snapshotL1 = await readL1Snapshot(l1Store(), 'pipe-1')
  assert.deepEqual(snapshotL1.revisions.ok.map(item => item.revisionId), ['revision-1'],
    `并发迁移不得造出第二个 revision，实际：${snapshotL1.revisions.ok.map(item => item.revisionId).join('、')}`)
  assert.deepEqual(snapshotL1.runs.ok.map(item => item.runId), ['run-1'])
  assert.equal(snapshotL1.record.state, 'ok')
})

// ── §9 验收门槛：locator 是唯一路径来源 ───────────────────────────────────────

test('L1b 门槛：`pipelines/` 路径只在 locator 里拼，别处不得自行拼（§3.2）', async () => {
  // 判据指向"用了什么"而不是"提到了什么"：只扫 `join(...)` 里带 `'pipelines'` 的**代码**行，
  // 注释与 API 路由字符串（`/api/pipelines/:id`）不算——把描述也算进来只会让这条测试被注释搞崩。
  const srcDir = new URL('../src/', import.meta.url)
  const offenders: string[] = []
  async function walk(current: URL): Promise<void> {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const child = new URL(entry.name + (entry.isDirectory() ? '/' : ''), current)
      if (entry.isDirectory()) { await walk(child); continue }
      if (!entry.name.endsWith('.ts')) continue
      const text = await readFile(child, 'utf8')
      text.split('\n').forEach((line, index) => {
        const trimmed = line.trim()
        if (trimmed.startsWith('*') || trimmed.startsWith('//') || trimmed.startsWith('/*')) return
        if (/join\([^)]*['"`]pipelines['"`]/.test(line)) {
          offenders.push(`${entry.name}:${index + 1} ${trimmed}`)
        }
      })
    }
  }
  await walk(srcDir)
  assert.deepEqual(offenders, [], `路径推导必须收口在 pipeline-locator.ts，别处不得拼：${offenders.join(' | ')}`)

  // 服务层的导出必须**委托**到 locator，而不是各留一份（否则两处迟早分叉）。
  assert.equal(pipelineIndexDir(dir), locatorIndexDir(dir))
  assert.equal(PIPELINE_INDEX_COLLECTION, L1_INDEX_COLLECTION)

  // 坐标与文件路径必须互相一致——它们由同一处推导，不一致就说明有人绕过了 locator。
  assert.equal(join(dir, ...pipelineRecordKey('pipe-1').collection.split('/'), 'pipeline.json'),
    pipelineRecordPath(dir, 'pipe-1'))
  assert.equal(join(dir, ...revisionKey('pipe-1', 'revision-2').collection.split('/'), 'revision-2.json'),
    revisionPath(dir, 'pipe-1', 'revision-2'))
  assert.equal(join(dir, ...runKey('pipe-1', 'run-3').collection.split('/'), 'run-3.json'),
    runRecordPath(dir, 'pipe-1', 'run-3'))
})

