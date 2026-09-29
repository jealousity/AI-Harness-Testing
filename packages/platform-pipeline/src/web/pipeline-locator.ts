/**
 * L1 存储布局的**唯一路径来源**（`docs/19-l1-pipeline-revision-run-design.md` §3.2）。
 *
 * ```text
 * <dataRoot>/
 *   pipelines/<pipelineId>.json                  # PipelineRecord（索引）
 *   pipelines/<pipelineId>/
 *     revisions/<revisionId>.json                # PipelineRevision
 *     runs/<runId>.json                          # PipelineRun
 *     runs/<runId>/checkpoint.json               # L1b 起
 *     runs/<runId>/artifacts/<stageId>.json      # L1b 起
 * ```
 *
 * **为什么必须收口成一处**（`docs/18` §8.6）：历史上锁路径就是因为三个入口各拼一套
 * （CLI 传 checkpoints 根、Web 传 per-pipeline 目录）而**等于没锁**。路径推导只要存在
 * 第二处实现，就迟早会分叉。因此本模块**不依赖** `pipeline-run-service.ts`
 * （避免循环依赖，也让服务层将来可以反过来委托到这里）。
 *
 * L1a 阶段：这些函数**只被读路径使用**，不产生任何新格式文件。
 *
 * @module platform-pipeline/web/pipeline-locator
 */

import { join } from 'node:path'

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

/**
 * 索引目录 = `<dataRoot>/pipelines`。
 *
 * 与 `pipeline-run-service.ts` 的 `pipelineIndexDir(dataRoot)` **保持同一路径**
 * （已核对：`join(dataRoot, 'pipelines')`）。L1b 会让服务层委托到本函数。
 */
export function pipelineIndexDir(dataRoot: string): string {
  return join(dataRoot, 'pipelines')
}

/** 索引记录：`<dataRoot>/pipelines/<pipelineId>.json`。 */
export function pipelineRecordPath(dataRoot: string, pipelineId: string): string {
  return join(pipelineIndexDir(dataRoot), `${assertSafeSegment(pipelineId, 'pipelineId')}.json`)
}

/** 单条流水线的目录：`<dataRoot>/pipelines/<pipelineId>/`。 */
export function pipelineDir(dataRoot: string, pipelineId: string): string {
  return join(pipelineIndexDir(dataRoot), assertSafeSegment(pipelineId, 'pipelineId'))
}

export function revisionDir(dataRoot: string, pipelineId: string): string {
  return join(pipelineDir(dataRoot, pipelineId), 'revisions')
}

export function revisionPath(dataRoot: string, pipelineId: string, revisionId: string): string {
  return join(revisionDir(dataRoot, pipelineId), `${assertSafeSegment(revisionId, 'revisionId')}.json`)
}

export function runsDir(dataRoot: string, pipelineId: string): string {
  return join(pipelineDir(dataRoot, pipelineId), 'runs')
}

export function runRecordPath(dataRoot: string, pipelineId: string, runId: string): string {
  return join(runsDir(dataRoot, pipelineId), `${assertSafeSegment(runId, 'runId')}.json`)
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
  return `pipelines/${assertSafeSegment(pipelineId, 'pipelineId')}`
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
 * 旧 manifest 的路径。
 *
 * 旧结构里 manifest 与索引**是同一个文件**（`<dataRoot>/pipelines/<id>.json`），
 * 只是形状不同：旧的是扁平运行参数，新的是 `PipelineRecord`。因此两者的路径函数相同——
 * 这不是重复，而是"同一路径、两种形状"，由 `pipeline-legacy.ts` 负责判别。
 */
export function legacyManifestPath(dataRoot: string, pipelineId: string): string {
  return pipelineRecordPath(dataRoot, pipelineId)
}
