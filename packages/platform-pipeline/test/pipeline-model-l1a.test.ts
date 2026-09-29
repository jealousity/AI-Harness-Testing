/**
 * L1a 的测试：事实模型不变量、路径收口、旧数据投影（`docs/19` §2/§3/§7）。
 *
 * L1a 的定位是**只读兼容**——本文件的所有断言都不应该产生任何磁盘写入。
 * 因此这里刻意**不碰文件系统**：三个模块都是纯函数，可以直接断言。
 *
 * @module platform-pipeline/test/pipeline-model-l1a
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isAbsolute, join } from 'node:path'

import { STAGE_ORDER } from '../src/types.ts'
import { initialCheckpoint } from '../src/checkpoint.ts'
import {
  PipelineModelError,
  assertIdentityImmutable,
  assertPipelineInvariants,
  assertRevisionInvariants,
  assertRevisionNumbering,
  assertRunInvariants,
  assertSingleActiveRevision,
  assertSingleActiveRun,
  isActiveRunStatus,
  isTerminalRunStatus,
  revisionFingerprint,
  type PipelineRecord,
  type PipelineRevision,
  type PipelineRun,
} from '../src/web/pipeline-model.ts'
import {
  UnsafePathSegmentError,
  assertSafeSegment,
  legacyCheckpointLocator,
  legacyCheckpointPath,
  legacyManifestPath,
  pipelineIndexDir,
  pipelineIndexEntryPath,
  pipelineRecordPath,
  revisionIdOf,
  revisionPath,
  runArtifactPath,
  runCheckpointPath,
  runIdOf,
  runRecordPath,
} from '../src/web/pipeline-locator.ts'
import {
  LEGACY_MIGRATION_SOURCE,
  MIGRATION_ACTOR,
  looksLikeLegacyManifest,
  looksLikePipelineRecord,
  projectLegacy,
} from '../src/web/pipeline-legacy.ts'
import { resolvePlatformRoots } from '../src/platform-roots.ts'
import { baseConfig } from './web-fixtures.ts'

const DATA_ROOT = '/tmp/l1a-data'

function pipelineOf(overrides: Partial<PipelineRecord> = {}): PipelineRecord {
  return {
    pipelineId: 'pipe-1',
    tenantId: 'acme',
    projectId: 'demo',
    configRef: 'default',
    createdAt: 1_000,
    activeRevisionId: 'revision-1',
    ...overrides,
  }
}

function revisionOf(overrides: Partial<PipelineRevision> = {}): PipelineRevision {
  return {
    revisionId: 'revision-1',
    pipelineId: 'pipe-1',
    revisionNumber: 1,
    createdAt: 1_000,
    createdBy: 'ops-1',
    status: 'active',
    rulesetVersion: 'platform-generic-r1',
    fingerprint: 'fp-1',
    ...overrides,
  }
}

function runOf(overrides: Partial<PipelineRun> = {}): PipelineRun {
  return {
    runId: 'run-1',
    pipelineId: 'pipe-1',
    revisionId: 'revision-1',
    attempt: 1,
    status: 'queued',
    cursor: 0,
    createdAt: 1_000,
    createdBy: 'ops-1',
    checkpointLocator: 'pipelines/pipe-1/runs/run-1/checkpoint.json',
    ...overrides,
  }
}

/** 断言某个调用抛出的 `PipelineModelError` 的 invariant 等于预期。 */
function expectInvariant(fn: () => void, invariant: string): void {
  assert.throws(fn, (error: unknown) => {
    assert.ok(error instanceof PipelineModelError, `期望 PipelineModelError，实际 ${String(error)}`)
    assert.equal(error.invariant, invariant, `不变量编号不符：${error.message}`)
    return true
  })
}

// ── 1. 路径收口（locator）─────────────────────────────────────────────────────

test('L1a：locator 产出的路径与现有索引路径一致（不是另立一套）', () => {
  // 索引目录必须与 `pipeline-run-service.ts` 的 `pipelineIndexDir` 完全相同，
  // 否则新旧代码会读写两个不同位置。
  assert.equal(pipelineIndexDir(DATA_ROOT), join(DATA_ROOT, 'pipelines'))
  // **旧**扁平索引：与现有索引存储同路径（`collection='pipelines'`, `id=pipelineId`）。
  assert.equal(pipelineIndexEntryPath(DATA_ROOT, 'pipe-1'), join(DATA_ROOT, 'pipelines', 'pipe-1.json'))
  // **新** PipelineRecord：独立路径，**不是** pipelines/<id>.json（docs/19 §3.3）。
  // 写错到旧路径会被 `isIndexEntry` 静默接受、运行参数静默丢失。
  assert.equal(pipelineRecordPath(DATA_ROOT, 'pipe-1'), join(DATA_ROOT, 'pipelines', 'pipe-1', 'pipeline.json'))
  assert.notEqual(
    pipelineRecordPath(DATA_ROOT, 'pipe-1'),
    pipelineIndexEntryPath(DATA_ROOT, 'pipe-1'),
    '新旧两条路径必须不同——这正是 §3.3 那个会静默损坏行为的陷阱',
  )
  // 旧 manifest 与旧索引**是同一个文件**（两种形状），迁移读的就是它。
  assert.equal(legacyManifestPath(DATA_ROOT, 'pipe-1'), pipelineIndexEntryPath(DATA_ROOT, 'pipe-1'))
  assert.equal(
    revisionPath(DATA_ROOT, 'pipe-1', 'revision-1'),
    join(DATA_ROOT, 'pipelines', 'pipe-1', 'revisions', 'revision-1.json'),
  )
  assert.equal(
    runRecordPath(DATA_ROOT, 'pipe-1', 'run-1'),
    join(DATA_ROOT, 'pipelines', 'pipe-1', 'runs', 'run-1.json'),
  )
  assert.equal(
    runCheckpointPath(DATA_ROOT, 'pipe-1', 'run-1'),
    join(DATA_ROOT, 'pipelines', 'pipe-1', 'runs', 'run-1', 'checkpoint.json'),
  )
  assert.equal(
    runArtifactPath(DATA_ROOT, 'pipe-1', 'run-1', 'receive'),
    join(DATA_ROOT, 'pipelines', 'pipe-1', 'runs', 'run-1', 'artifacts', 'receive.json'),
  )
  // 旧检查点路径：`<checkpointsRoot>/<pipelineId>/checkpoint.json`
  const roots = resolvePlatformRoots(DATA_ROOT, baseConfig())
  assert.equal(legacyCheckpointPath(roots, 'pipe-1'), join(roots.checkpointRoot, 'pipe-1', 'checkpoint.json'))
})

test('L1a：旧检查点的**相对定位**在数据根之内且不含绝对路径', () => {
  // `PipelineRun.checkpointLocator` 会出现在响应里，因此必须是相对路径（docs/15）。
  const roots = resolvePlatformRoots(DATA_ROOT, baseConfig())
  const locator = legacyCheckpointLocator(DATA_ROOT, roots, 'pipe-1')
  assert.equal(isAbsolute(locator), false, `不得是绝对路径：${locator}`)
  assert.equal(locator.startsWith('..'), false, `不得逃出数据根：${locator}`)
  assert.equal(locator.includes(DATA_ROOT), false, `不得包含数据根：${locator}`)
  assert.ok(locator.endsWith('/checkpoints/pipe-1/checkpoint.json'), `指向旧检查点：${locator}`)
  // 分隔符统一成 `/`，让同一份数据在不同平台比较相等。
  assert.equal(locator.includes('\\'), false)
})

test('L1a：locator 拒绝路径穿越（pipelineId 来自请求，不能拼出数据根之外的路径）', () => {
  for (const bad of ['..', '../..', 'a/b', '/abs', '', '.', 'a\\b', '中文']) {
    assert.throws(
      () => pipelineRecordPath(DATA_ROOT, bad),
      (error: unknown) => {
        assert.ok(error instanceof UnsafePathSegmentError, `${bad} 应被拒绝，实际 ${String(error)}`)
        return true
      },
      `pipelineId=${JSON.stringify(bad)} 必须被拒绝`,
    )
  }
  // 正向：合法 id 放行。
  assert.equal(assertSafeSegment('pipe-1.2_x', 'pipelineId'), 'pipe-1.2_x')
  // 产物路径里的 stageId 也必须校验。
  assert.throws(() => runArtifactPath(DATA_ROOT, 'pipe-1', 'run-1', '../escape' as never), UnsafePathSegmentError)
})

test('L1a：revision/run 的 id 是确定性的（迁移幂等的前提）', () => {
  assert.equal(revisionIdOf('pipe-1', 1), 'revision-1')
  assert.equal(revisionIdOf('pipe-1', 7), 'revision-7')
  assert.equal(runIdOf('pipe-1', 1), 'run-1')
  // 同一个输入永远得到同一个 id——否则迁移中断后重跑会产生"看起来像新版本"的垃圾。
  assert.equal(revisionIdOf('pipe-1', 1), revisionIdOf('pipe-1', 1))
  assert.throws(() => revisionIdOf('pipe-1', 0), UnsafePathSegmentError)
  assert.throws(() => runIdOf('pipe-1', -1), UnsafePathSegmentError)
})

// ── 2. 不变量 ────────────────────────────────────────────────────────────────

test('L1a：Pipeline 身份不变量（P1/P3/P5）', () => {
  assert.doesNotThrow(() => assertPipelineInvariants(pipelineOf()))
  expectInvariant(() => assertPipelineInvariants(pipelineOf({ pipelineId: '  ' })), 'P1')
  expectInvariant(() => assertPipelineInvariants(pipelineOf({ projectId: '' })), 'P1')
  expectInvariant(() => assertPipelineInvariants(pipelineOf({ configRef: '' })), 'P1')
  expectInvariant(() => assertPipelineInvariants(pipelineOf({ activeRevisionId: '' })), 'P5')
  // P3：软删除必须留痕——否则审计回答不了"谁移除的"。
  expectInvariant(() => assertPipelineInvariants(pipelineOf({ deletedAt: 2_000 })), 'P3')
  assert.doesNotThrow(() => assertPipelineInvariants(pipelineOf({ deletedAt: 2_000, deletedBy: 'admin-1' })))
  // updatedAt 不能早于 createdAt。
  expectInvariant(() => assertPipelineInvariants(pipelineOf({ updatedAt: 999 })), 'P1')
})

test('L1a：身份字段不可变（P2）——这是 EDITABLE_PATCH_FIELDS 之外的纵深防御', () => {
  const before = pipelineOf()
  assert.doesNotThrow(() => assertIdentityImmutable(before, pipelineOf({ displayName: 'x', updatedAt: 2_000 })))
  for (const patch of [
    { pipelineId: 'other' }, { projectId: 'other' }, { tenantId: 'other' }, { configRef: 'other' },
  ] as const) {
    expectInvariant(() => assertIdentityImmutable(before, pipelineOf(patch)), 'P2')
  }
})

test('L1a：Revision 不变量（R2/R4/R5）', () => {
  assert.doesNotThrow(() => assertRevisionInvariants(revisionOf()))
  expectInvariant(() => assertRevisionInvariants(revisionOf({ revisionNumber: 0 })), 'R2')
  expectInvariant(() => assertRevisionInvariants(revisionOf({ rulesetVersion: '' })), 'R4')
  expectInvariant(() => assertRevisionInvariants(revisionOf({ fingerprint: '' })), 'R4')
  // R5：diagCredentials 只允许环境变量名——出现"值"的形状就说明有人把凭据塞进来了。
  assert.doesNotThrow(() => assertRevisionInvariants(revisionOf({ diagCredentials: ['ACME_API_TOKEN', 'K2'] })))
  expectInvariant(() => assertRevisionInvariants(revisionOf({ diagCredentials: ['sk-live-abc'] })), 'R5')
  expectInvariant(() => assertRevisionInvariants(revisionOf({ diagCredentials: ['lower_case'] })), 'R5')
})

test('L1a：Run 不变量（N2~N5）与"迁移路径显式放宽时序"', () => {
  assert.doesNotThrow(() => assertRunInvariants(runOf()))
  expectInvariant(() => assertRunInvariants(runOf({ attempt: 0 })), 'N5')
  expectInvariant(() => assertRunInvariants(runOf({ cursor: STAGE_ORDER.length + 1 })), 'N2')
  expectInvariant(() => assertRunInvariants(runOf({ checkpointLocator: '' })), 'N2')
  // N4：终态必须冻结。
  expectInvariant(() => assertRunInvariants(runOf({ status: 'completed' })), 'N4')
  assert.doesNotThrow(() => assertRunInvariants(runOf({ status: 'completed', finishedAt: 2_000 })))
  expectInvariant(() => assertRunInvariants(runOf({ status: 'queued', finishedAt: 2_000 })), 'N4')

  // 迁移路径：老数据没有 run 的起止时间，**显式**放宽（不是悄悄放宽）。
  assert.doesNotThrow(() => assertRunInvariants(
    runOf({ status: 'completed' }),
    { allowUnknownTiming: true },
  ))
  // 即使放宽时序，其它判据仍然生效。
  expectInvariant(() => assertRunInvariants(runOf({ attempt: 0 }), { allowUnknownTiming: true }), 'N5')
})

test('L1a：同一 pipeline 至多一个运行态 run / 一个 active revision', () => {
  assert.doesNotThrow(() => assertSingleActiveRun([runOf(), runOf({ runId: 'run-2', status: 'completed', finishedAt: 2 })]))
  assert.doesNotThrow(() => assertSingleActiveRun([]))
  expectInvariant(
    () => assertSingleActiveRun([runOf(), runOf({ runId: 'run-2', status: 'waiting-human' })]),
    'N1',
  )
  assert.doesNotThrow(() => assertSingleActiveRevision([revisionOf(), revisionOf({ revisionId: 'revision-2', revisionNumber: 2, status: 'superseded' })]))
  expectInvariant(
    () => assertSingleActiveRevision([revisionOf(), revisionOf({ revisionId: 'revision-2', revisionNumber: 2 })]),
    'R3',
  )
})

test('L1a：revisionNumber 必须从 1 连续递增（跳号说明删过或写坏了）', () => {
  assert.doesNotThrow(() => assertRevisionNumbering([]))
  assert.doesNotThrow(() => assertRevisionNumbering([revisionOf()]))
  assert.doesNotThrow(() => assertRevisionNumbering([
    revisionOf({ revisionId: 'revision-2', revisionNumber: 2, status: 'superseded' }),
    revisionOf(),
  ]))
  expectInvariant(() => assertRevisionNumbering([
    revisionOf(), revisionOf({ revisionId: 'revision-3', revisionNumber: 3 }),
  ]), 'R2')
})

test('L1a：运行态/终态集合互不重叠且覆盖全部状态', () => {
  const all = ['queued', 'running', 'waiting-human', 'needs-fix', 'gate-failed', 'review-failed', 'rejected', 'completed', 'failed', 'cancelled'] as const
  for (const status of all) {
    assert.equal(
      isActiveRunStatus(status) !== isTerminalRunStatus(status),
      true,
      `${status} 必须恰好属于运行态或终态之一`,
    )
  }
})

// ── 3. 行为指纹 ──────────────────────────────────────────────────────────────

test('L1a：revision 指纹稳定——同配置同指纹、换配置换指纹、字段顺序无关', () => {
  const base = { providerName: 'primary', targetBaseUrl: 'https://x.example.com', maxGateRetries: 2 }
  const same = { maxGateRetries: 2, targetBaseUrl: 'https://x.example.com', providerName: 'primary' }
  assert.equal(revisionFingerprint(base), revisionFingerprint(same), '字段顺序不能影响指纹')

  assert.notEqual(revisionFingerprint(base), revisionFingerprint({ ...base, providerName: 'backup' }))
  assert.notEqual(revisionFingerprint(base), revisionFingerprint({ ...base, maxGateRetries: 3 }))
  // 缺省与显式空串必须**不同**：一个"没设"、一个"设成空"，行为上不等价。
  assert.notEqual(revisionFingerprint({ providerName: undefined }), revisionFingerprint({ providerName: '' }))
  // 数组顺序必须影响指纹（探针白名单换了顺序，语义上是另一份配置）。
  assert.notEqual(
    revisionFingerprint({ diagCredentials: ['A', 'B'] }),
    revisionFingerprint({ diagCredentials: ['B', 'A'] }),
  )
})

// ── 4. 旧数据投影 ────────────────────────────────────────────────────────────

const LEGACY_MANIFEST = {
  pipelineId: 'pipe-1',
  tenantId: 'acme',
  projectId: 'demo',
  configRef: 'default',
  rulesetVersion: 'platform-generic-r1',
  createdAt: 1_000,
  requirementInput: '/tmp/req.pdf',
  targetBaseUrl: 'https://staging.example.com',
  maxGateRetries: 2,
  diagCredentials: ['ACME_API_TOKEN'],
}

const MIGRATION_PROVENANCE = { createdBy: MIGRATION_ACTOR, migratedFrom: LEGACY_MIGRATION_SOURCE }

test('L1a：旧 manifest + checkpoint 投影成三对象，且**不编时序**', () => {
  const config = baseConfig()
  const roots = resolvePlatformRoots(DATA_ROOT, config)
  const projection = projectLegacy({
    manifest: LEGACY_MANIFEST,
    checkpoint: initialCheckpoint('pipe-1', 'v1', 'platform-generic-r1'),
    tasks: [],
    dataRoot: DATA_ROOT,
    roots,
    now: 9_000,
    provenance: MIGRATION_PROVENANCE,
  })

  assert.equal(projection.pipeline.pipelineId, 'pipe-1')
  assert.equal(projection.pipeline.activeRevisionId, 'revision-1')
  assert.equal(projection.pipeline.deletedAt, undefined, '投影不能凭空加上删除标记')
  assert.equal(projection.revision.revisionNumber, 1)
  assert.equal(projection.revision.status, 'active')
  assert.equal(projection.revision.createdBy, MIGRATION_ACTOR, '迁移产生的对象不能看起来像某个真人建的')
  assert.equal(projection.revision.migratedFrom, 'legacy-manifest')
  assert.equal(projection.revision.providerName, undefined, '旧 manifest 没有 provider 就是没有')
  assert.equal(projection.run.runId, 'run-1')
  assert.equal(projection.run.attempt, 1)
  assert.equal(projection.run.revisionId, 'revision-1')
  assert.equal(projection.run.status, 'queued', '全新 checkpoint 应投影成 queued')
  // **关键**：老数据没有 run 的起止时间 → 留空，不拿 createdAt 冒充。
  assert.equal(projection.run.startedAt, undefined)
  assert.equal(projection.run.finishedAt, undefined)

  // 迁移线索必须留下（排障时要能回答"这条新记录是从哪个文件投影出来的"）。
  assert.equal(projection.pipeline.legacyLocator?.manifestPath, join(DATA_ROOT, 'pipelines', 'pipe-1.json'))
  assert.equal(projection.pipeline.legacyLocator?.checkpointPath, legacyCheckpointPath(roots, 'pipe-1'))
})

test('L1a：投影复用 deriveRunStatus——不另写一套状态推导', () => {
  const roots = resolvePlatformRoots(DATA_ROOT, baseConfig())
  const checkpoint = initialCheckpoint('pipe-1', 'v1', 'platform-generic-r1')
  // 造一个"停在人工门"的检查点：receive 处于 awaiting-gate。
  const parked = {
    ...checkpoint,
    stageStates: {
      ...checkpoint.stageStates,
      receive: { ...checkpoint.stageStates.receive, status: 'awaiting-gate' as const },
    },
  }
  const projection = projectLegacy({
    manifest: LEGACY_MANIFEST, checkpoint: parked, tasks: [],
    dataRoot: DATA_ROOT, roots, now: 9_000,
    provenance: MIGRATION_PROVENANCE,
  })
  // 没有门任务时 awaiting-gate 会推导成 waiting-human（由 deriveRunStatus 决定）。
  assert.equal(projection.run.status, 'waiting-human')
})

test('L1a：rulesetVersion 缺省时回退到 checkpoint 里那个（真正生效过的版本）', () => {
  const roots = resolvePlatformRoots(DATA_ROOT, baseConfig())
  const { rulesetVersion: _omitted, ...withoutRuleset } = LEGACY_MANIFEST
  const projection = projectLegacy({
    manifest: withoutRuleset,
    checkpoint: initialCheckpoint('pipe-1', 'v1', 'from-checkpoint-r9'),
    tasks: [],
    dataRoot: DATA_ROOT,
    roots,
    now: 9_000,
    provenance: MIGRATION_PROVENANCE,
  })
  assert.equal(projection.revision.rulesetVersion, 'from-checkpoint-r9')
})

test('L1a：投影是纯函数——同样的输入两次得到同样结果（可重放）', () => {
  const roots = resolvePlatformRoots(DATA_ROOT, baseConfig())
  const input = {
    manifest: LEGACY_MANIFEST,
    checkpoint: initialCheckpoint('pipe-1', 'v1', 'platform-generic-r1'),
    tasks: [],
    dataRoot: DATA_ROOT,
    roots,
    now: 9_000,
    provenance: MIGRATION_PROVENANCE,
  }
  assert.deepEqual(projectLegacy(input), projectLegacy(input))
})

// ── 5. 新旧形状判别 ──────────────────────────────────────────────────────────

test('L1a：靠**结构**判别新旧索引形状（历史记录里没有版本号可依据）', () => {
  assert.equal(looksLikeLegacyManifest(LEGACY_MANIFEST), true)
  assert.equal(looksLikeLegacyManifest(pipelineOf()), false, '新形状有 activeRevisionId，不是旧 manifest')
  assert.equal(looksLikePipelineRecord(pipelineOf()), true)
  assert.equal(looksLikePipelineRecord(LEGACY_MANIFEST), false)
  // 坏数据两类都不认——调用方据此报损坏，而不是猜。
  for (const junk of [null, undefined, 42, 'x', [], {}, { pipelineId: 'p' }]) {
    assert.equal(looksLikeLegacyManifest(junk), false)
    assert.equal(looksLikePipelineRecord(junk), false)
  }
})

test('L1a：locator 产出的都是绝对路径或明确相对 dataRoot（不混两种语义）', () => {
  const roots = resolvePlatformRoots(DATA_ROOT, baseConfig())
  // 所有 locator 都以 dataRoot / roots 为基，返回绝对路径。
  for (const path of [
    pipelineRecordPath(DATA_ROOT, 'pipe-1'),
    revisionPath(DATA_ROOT, 'pipe-1', 'revision-1'),
    runRecordPath(DATA_ROOT, 'pipe-1', 'run-1'),
    runCheckpointPath(DATA_ROOT, 'pipe-1', 'run-1'),
    legacyCheckpointPath(roots, 'pipe-1'),
  ]) {
    assert.equal(isAbsolute(path), true, `${path} 应当是绝对路径`)
    assert.equal(path.startsWith(DATA_ROOT), true, `${path} 应当落在 dataRoot 之下`)
  }
})
