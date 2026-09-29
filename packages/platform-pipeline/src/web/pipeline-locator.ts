/**
 * L1 存储布局的**唯一路径来源**（`docs/19-l1-pipeline-revision-run-design.md` §3.2）。
 *
 * ```text
 * <dataRoot>/
 *   pipelines/<pipelineId>.json                  # 旧扁平索引 / 旧 manifest（L1 期间原样保留）
 *   pipelines/<pipelineId>/
 *     pipeline.json                              # PipelineRecord（新）★ 见 §3.3
 *     revisions/<revisionId>.json                # PipelineRevision（新）
 *     runs/<runId>.json                          # PipelineRun（新）
 *     runs/<runId>/checkpoint.json               # L1b 起
 *     runs/<runId>/artifacts/<stageId>.json      # L1b 起
 * ```
 *
 * **为什么必须收口成一处**（`docs/18` §8.6）：历史上锁路径就是因为三个入口各拼一套
 * （CLI 传 checkpoints 根、Web 传 per-pipeline 目录）而**等于没锁**。路径推导只要存在
 * 第二处实现，就迟早会分叉。因此本模块**不依赖** `pipeline-run-service.ts`
 * （避免循环依赖，也让服务层将来可以反过来委托到这里）。
 *
 * **⚠️ 新路径与旧路径必须由两个函数分别表达**（§3.3）：旧扁平索引
 * `pipelines/<id>.json` 与新记录 `pipelines/<id>/pipeline.json` 只差一个 `/`，
 * 一旦混用，新形状会被旧的索引读取器静默接受、运行参数静默丢失。
 * 因此这里刻意**没有**"反正都是同一条流水线"的兜底函数——想读旧索引就必须显式写
 * `pipelineIndexEntryPath`，让调用点自己承担"我在读旧格式"这件事。
 *
 * @module platform-pipeline/web/pipeline-locator
 */

import { isAbsolute, join, relative, resolve, sep } from 'node:path'

import type { PlatformStorageRoots } from '../platform-roots.ts'
import type { StageId } from '../types.ts'

/**
 * 安全标识符：与 `storage/ports.ts` 的 `assertHostRecordKey` 同一条正则。
 *
 * 这些路径段**来自调用方**（pipelineId 来自请求、revisionId/runId 来自内部生成），
 * 因此必须拦 `..`、`/`、绝对路径。少这一步，`../..` 就能把读写落到数据根之外。
 */
const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

export class UnsafePathSegmentError extends Error {
  readonly field: string

  constructor(field: string, value: string) {
    super(`${field} 必须是安全标识符（${SAFE_SEGMENT.source}）：${JSON.stringify(value)}`)
    this.name = 'UnsafePathSegmentError'
    this.field = field
  }
}

export function assertSafeSegment(value: string, field: string): string {
  if (!SAFE_SEGMENT.test(value)) throw new UnsafePathSegmentError(field, value)
  return value
}

// ── 新格式（L1）───────────────────────────────────────────────────────────────
//
// 新格式的坐标用**两套等价表达**，且**只有本模块能推导**（§3.2）：
//
//   存储坐标 (collection, id)  ← 真正做 I/O 时用（走可注入的 HostRecordStore）
//   文件路径                   ← 由坐标推导，供排障与测试核对
//
// 为什么不是只留文件路径：L1 新格式必须走**可注入的**记录存储，否则换后端之后
// 新格式仍然写本地磁盘——那就破坏了"换后端只改装配"（`docs/11` §二）。
// 而"文件路径"仍要有，因为 §3.1 的布局是排障与迁移时要能直接看到的。
// 两者由同一组函数推导（`storePathOf`），因此**不可能分叉**。

/** `HostRecordStore` 的坐标。`collection` 是相对存储根的路径，允许含 `/`。 */
export interface L1RecordKey {
  readonly collection: string
  readonly id: string
}

/** 新记录在存储里的 id（文件名去掉 `.json`）。 */
export const L1_RECORD_ID = 'pipeline'

/** 索引集合名（`HostRecordStore` 的 `collection`）。**唯一来源**，服务层从这里取。 */
export const L1_INDEX_COLLECTION = 'pipelines'

/** 单条流水线的集合名（`pipelines/<pipelineId>`）。 */
export function pipelineCollectionOf(pipelineId: string): string {
  return `${L1_INDEX_COLLECTION}/${assertSafeSegment(pipelineId, 'pipelineId')}`
}

/**
 * 坐标的**人读相对形式**（`collection/id`），用于诊断的 `ref`。
 *
 * 为什么让诊断也走这里：诊断里写的 `pipelines/<id>/pipeline.json` 若与真实布局分叉，
 * 排障时就会照着一条不存在的路径去找文件。同一处推导，就没有这个可能。
 */
export function recordRefOf(key: L1RecordKey): string {
  return `${key.collection}/${key.id}`
}

function pipelineCollection(pipelineId: string): string {
  return pipelineCollectionOf(pipelineId)
}

/** PipelineRecord 的坐标 → `pipelines/<pipelineId>/pipeline.json`。 */
export function pipelineRecordKey(pipelineId: string): L1RecordKey {
  return { collection: pipelineCollection(pipelineId), id: L1_RECORD_ID }
}

/** Revision 的集合 → `pipelines/<pipelineId>/revisions/`。 */
export function revisionCollection(pipelineId: string): string {
  return `${pipelineCollection(pipelineId)}/revisions`
}

export function revisionKey(pipelineId: string, revisionId: string): L1RecordKey {
  return { collection: revisionCollection(pipelineId), id: assertSafeSegment(revisionId, 'revisionId') }
}

/** Run 的集合 → `pipelines/<pipelineId>/runs/`。 */
export function runCollection(pipelineId: string): string {
  return `${pipelineCollection(pipelineId)}/runs`
}

export function runKey(pipelineId: string, runId: string): L1RecordKey {
  return { collection: runCollection(pipelineId), id: assertSafeSegment(runId, 'runId') }
}

/** 坐标 → 文件路径。**唯一的换算点**，路径与坐标因此不可能分叉。 */
function storePathOf(dataRoot: string, key: L1RecordKey): string {
  return join(dataRoot, ...key.collection.split('/'), `${key.id}.json`)
}

function storeDirOf(dataRoot: string, collection: string): string {
  return join(dataRoot, ...collection.split('/'))
}

/**
 * 索引目录 = `<dataRoot>/pipelines`。
 *
 * **唯一来源**：服务层的 `pipelineIndexDir` 委托到这里（`docs/19` §3.2）。
 */
export function pipelineIndexDir(dataRoot: string): string {
  return join(dataRoot, L1_INDEX_COLLECTION)
}

/**
 * 旧扁平索引 = `<dataRoot>/pipelines/<pipelineId>.json`。
 *
 * **这是旧格式**：索引与旧 manifest 是同一个文件、两种形状（§3.3）。
 * 新写入**不要**用它；新记录走 `pipelineRecordPath`。
 */
export function pipelineIndexEntryPath(dataRoot: string, pipelineId: string): string {
  return join(pipelineIndexDir(dataRoot), `${assertSafeSegment(pipelineId, 'pipelineId')}.json`)
}

/** 单条流水线的目录：`<dataRoot>/pipelines/<pipelineId>/`。 */
export function pipelineDir(dataRoot: string, pipelineId: string): string {
  return join(pipelineIndexDir(dataRoot), assertSafeSegment(pipelineId, 'pipelineId'))
}

/**
 * **新** PipelineRecord：`<dataRoot>/pipelines/<pipelineId>/pipeline.json`。
 *
 * 为什么不是 `pipelines/<pipelineId>.json`：那条路径是旧索引，见 §3.3 ——
 * 把新形状写进去会被 `isIndexEntry` 静默接受，`targetBaseUrl` 等只存在于旧 manifest
 * 的字段全部丢失，而 create/run 继续"成功"。实测证据在
 * `test/pipeline-l1a-service.test.ts` 的特征测试里。
 */
export function pipelineRecordPath(dataRoot: string, pipelineId: string): string {
  return storePathOf(dataRoot, pipelineRecordKey(pipelineId))
}

export function revisionDir(dataRoot: string, pipelineId: string): string {
  return storeDirOf(dataRoot, revisionCollection(pipelineId))
}

export function revisionPath(dataRoot: string, pipelineId: string, revisionId: string): string {
  return storePathOf(dataRoot, revisionKey(pipelineId, revisionId))
}

export function runsDir(dataRoot: string, pipelineId: string): string {
  return storeDirOf(dataRoot, runCollection(pipelineId))
}

export function runRecordPath(dataRoot: string, pipelineId: string, runId: string): string {
  return storePathOf(dataRoot, runKey(pipelineId, runId))
}

export function runDir(dataRoot: string, pipelineId: string, runId: string): string {
  return join(runsDir(dataRoot, pipelineId), assertSafeSegment(runId, 'runId'))
}

export function runCheckpointPath(dataRoot: string, pipelineId: string, runId: string): string {
  return join(runDir(dataRoot, pipelineId, runId), 'checkpoint.json')
}

/**
 * **相对 dataRoot** 的检查点定位。
 *
 * 与 `runCheckpointPath`（绝对路径）刻意分开：
 * - 绝对路径只在**真要做 I/O** 时用；
 * - 要放进返回值/API 的一律用这个相对形式。
 *
 * 为什么分开而不是"记得别返回绝对路径"：`PipelineRun.checkpointLocator` 是个会出现在
 * 响应里的字段，用绝对路径就是把数据根泄露给浏览器（`docs/15` 明令禁止）。
 * 实测踩过一次——测试里那条"响应不得包含数据根绝对路径"就是判据。
 */
export function runCheckpointLocator(pipelineId: string, runId: string): string {
  return `${pipelineCollectionOf(pipelineId)}`
    + `/runs/${assertSafeSegment(runId, 'runId')}/checkpoint.json`
}

export function runArtifactPath(
  dataRoot: string,
  pipelineId: string,
  runId: string,
  stageId: StageId,
): string {
  return join(runDir(dataRoot, pipelineId, runId), 'artifacts', `${assertSafeSegment(stageId, 'stageId')}.json`)
}

// ── 标识符生成（确定性，保证迁移幂等）────────────────────────────────────────

/**
 * 迁移与新建共用的确定性 revision id。
 *
 * **确定性**是迁移幂等的前提（`docs/19` §4.2 M3）：同一个 pipeline 的第 1 个 revision
 * 永远是 `revision-1`，因此迁移中断后重跑不会产生 `revision-2` 这种"看起来像新版本"的垃圾。
 */
export function revisionIdOf(pipelineId: string, revisionNumber: number): string {
  assertSafeSegment(pipelineId, 'pipelineId')
  if (!Number.isSafeInteger(revisionNumber) || revisionNumber < 1) {
    throw new UnsafePathSegmentError('revisionNumber', String(revisionNumber))
  }
  return `revision-${revisionNumber}`
}

/** 同上，用于 run。 */
export function runIdOf(pipelineId: string, runNumber: number): string {
  assertSafeSegment(pipelineId, 'pipelineId')
  if (!Number.isSafeInteger(runNumber) || runNumber < 1) {
    throw new UnsafePathSegmentError('runNumber', String(runNumber))
  }
  return `run-${runNumber}`
}

// ── 旧格式（L1 期间保持可读，不删）───────────────────────────────────────────

/** 旧检查点根：`<checkpointsRoot>/<pipelineId>/`。 */
export function legacyCheckpointDir(roots: PlatformStorageRoots, pipelineId: string): string {
  return join(roots.checkpointRoot, assertSafeSegment(pipelineId, 'pipelineId'))
}

export function legacyCheckpointPath(roots: PlatformStorageRoots, pipelineId: string): string {
  return join(legacyCheckpointDir(roots, pipelineId), 'checkpoint.json')
}

/** 旧产物根：`<artifactsRoot>/artifacts/<pipelineId>/`（与 `checkpoint.ts` 的 `artifactPath` 一致）。 */
export function legacyArtifactRoot(roots: PlatformStorageRoots): string {
  return join(roots.artifactsRoot, 'artifacts')
}

export function legacyArtifactDir(roots: PlatformStorageRoots, pipelineId: string): string {
  return join(legacyArtifactRoot(roots), assertSafeSegment(pipelineId, 'pipelineId'))
}

/**
 * **相对 dataRoot** 的旧检查点定位。
 *
 * `docs/19` §2.3：`PipelineRun.checkpointLocator` 在 **L1a/L1b 期间指向老 checkpoint**，
 * 因为新格式的 `runs/<runId>/checkpoint.json` 此时**根本还没被写**——
 * 报一个不存在的路径等于撒谎，L1c 切目录时才改指新位置。
 *
 * 与 `runCheckpointLocator` 一样，存在的意义是"绝对路径不出 API"：
 * 旧检查点根在数据根之下（`<dataRoot>/tenants/<t>/projects/<p>/checkpoints/...`），
 * 因此可以安全地表达成相对路径。
 *
 * 分隔符统一成 `/`：这个值会被落盘并可能被非 POSIX 的调用方读到，
 * 存平台相关的 `\` 会让同一份数据在不同机器上比较不相等。
 */
export function legacyCheckpointLocator(
  dataRoot: string,
  roots: PlatformStorageRoots,
  pipelineId: string,
): string {
  const rel = relative(resolve(dataRoot), resolve(legacyCheckpointPath(roots, pipelineId)))
  // 旧检查点根一定在数据根之下（`resolvePlatformRoots` 用 `projectDataRoot(dataRoot, …)` 推导）。
  // 万一不是，宁可**显式失败**也不要返回一个带 `../` 的路径——那既泄露布局又会指到数据根之外。
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(
      `旧检查点不在数据根之内，无法表达成相对路径：dataRoot=${dataRoot} checkpoint=${legacyCheckpointPath(roots, pipelineId)}`,
    )
  }
  return rel.split(sep).join('/')
}

/**
 * 旧 manifest 的路径 = 旧扁平索引的路径。
 *
 * 旧结构里 manifest 与索引**是同一个文件**（`<dataRoot>/pipelines/<id>.json`），
 * 只是形状不同（扁平的运行参数 vs `PipelineRecord`），由 `pipeline-legacy.ts` 判别。
 *
 * 保留两个名字而不是只留一个：`pipelineIndexEntryPath` 表达"索引项"（读侧视角），
 * `legacyManifestPath` 表达"迁移的源文件"（迁移侧视角）。它们**必须**指向同一路径，
 * 但用途不同——迁移代码读的是后者，这样"迁移在读旧格式"在调用点就看得见。
 */
export function legacyManifestPath(dataRoot: string, pipelineId: string): string {
  return pipelineIndexEntryPath(dataRoot, pipelineId)
}
