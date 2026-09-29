/**
 * 旧数据 → L1 对象的**纯函数投影**（`docs/19-l1-pipeline-revision-run-design.md` §3.3 / §4.2）。
 *
 * 把现有的 `pipelines/<id>.json`（旧扁平 manifest）+ `checkpoints/<id>/checkpoint.json`
 * 在**内存里**投影成 `PipelineRecord + PipelineRevision + PipelineRun`。
 *
 * 两个调用场景，靠 `provenance` 区分（**必填**，见下）：
 * - **L1a 只读兼容**：端点拿到结果直接用于视图，磁盘零新文件；
 * - **L1b 双写 / 惰性迁移**：结果被 `pipeline-l1-store.ts` 落盘。
 *
 * 三条纪律：
 * 1. **不编事实**：老数据里没有的信息（run 的开始/结束时间）**保持 undefined**，
 *    不拿 `createdAt` 或"当前时间"冒充；
 * 2. **不猜历史**：只产出 `revision-1` / `run-1`，不试图从 checkpoint 里"反推"出多版本历史；
 * 3. **纯函数**：不读盘、不写盘、不看时间（`now` 由调用方注入），因此可以单测。
 *
 * @module platform-pipeline/web/pipeline-legacy
 */

import type { Checkpoint } from '../types.ts'
import type { PlatformStorageRoots } from '../platform-roots.ts'
import type { HumanGateTask } from '../runtime/persistence.ts'
import { deriveRunStatus, type PipelineRunManifest } from './pipeline-run-service.ts'
import {
  revisionIdOf,
  runIdOf,
  legacyCheckpointPath,
  legacyCheckpointLocator,
  legacyArtifactRoot,
  legacyManifestPath,
} from './pipeline-locator.ts'
import {
  makePipelineRecord,
  makeRevision,
  makeRun,
  type LegacyLocator,
  type PipelineRecord,
  type PipelineRevision,
  type PipelineRun,
  type RevisionParamsSource,
} from './pipeline-model.ts'

/** 迁移产生的对象在审计里用这个 actor，避免看起来像某个真人建的。 */
export const MIGRATION_ACTOR = 'system:migration'

/** 迁移产生的第一个 revision 的来源标记。 */
export const LEGACY_MIGRATION_SOURCE = 'legacy-manifest'

/**
 * 从旧 manifest + checkpoint 取出一组**行为参数**。
 *
 * 唯一实现：迁移路径（`projectLegacy`）与新建路径（service 的双写）都必须走它，
 * 否则两条路会各自解释"缺省字段是什么"，指纹随之分叉（见 `revisionConfigOf`）。
 *
 * 取法上的两个讲究：
 * - `rulesetVersion` 在旧 manifest 里可能缺省（历史索引没有该字段），
 *   回退到 checkpoint 里那个——那是**真正生效过的**版本；
 * - 其余字段**缺省就是缺省**，不写成 `null`/`''`。`undefined` 与 `''` 行为不同
 *   （前者走默认 provider，后者是一个空 provider 名），归一交给 `normalizeField`。
 */
export function revisionParamsOf(
  manifest: PipelineRunManifest,
  checkpoint: Checkpoint,
): RevisionParamsSource {
  return {
    ...(manifest.requirementInput === undefined ? {} : { requirementInput: manifest.requirementInput }),
    ...(manifest.providerName === undefined ? {} : { providerName: manifest.providerName }),
    ...(manifest.targetBaseUrl === undefined ? {} : { targetBaseUrl: manifest.targetBaseUrl }),
    rulesetVersion: manifest.rulesetVersion ?? checkpoint.rulesetVersion,
    ...(manifest.maxGateRetries === undefined ? {} : { maxGateRetries: manifest.maxGateRetries }),
    ...(manifest.gateWaitTimeoutMs === undefined ? {} : { gateWaitTimeoutMs: manifest.gateWaitTimeoutMs }),
    ...(manifest.gateTaskTtlMs === undefined ? {} : { gateTaskTtlMs: manifest.gateTaskTtlMs }),
    ...(manifest.diagCredentials === undefined ? {} : { diagCredentials: manifest.diagCredentials }),
  }
}

/**
 * 旧结构的定位信息（**相对路径**，绝不出绝对路径）。
 *
 * `migratedAt` 的语义是"这条新记录**首次**从旧格式投影出来的时刻"——
 * 双写新建时也用它（那时旧格式就是 create 刚写下的 manifest），因此不是"仅迁移"。
 */
export function legacyLocatorOf(
  dataRoot: string,
  roots: PlatformStorageRoots,
  pipelineId: string,
  now: number,
): LegacyLocator {
  return {
    manifestPath: legacyManifestPath(dataRoot, pipelineId),
    checkpointPath: legacyCheckpointPath(roots, pipelineId),
    artifactsRoot: legacyArtifactRoot(roots),
    migratedAt: now,
  }
}

export interface LegacyProjectionInput {
  readonly manifest: PipelineRunManifest
  readonly checkpoint: Checkpoint
  /** 门任务参与状态推导（`waiting-human` / `rejected` / `cancelled` 需要它）。 */
  readonly tasks: readonly HumanGateTask[]
  readonly dataRoot: string
  readonly roots: PlatformStorageRoots
  /** 注入的时钟（纯函数不自己取时间）。 */
  readonly now: number
  /**
   * 这批对象算谁产生的。
   *
   * **必填、没有缺省**：这是刻意的。缺省值无论取哪一边都会出错——
   * 默认 `system:migration` 会把"张三刚建的流水线"记成迁移产物；
   * 默认"调用者"又会让真正的迁移看起来像某个真人做的。
   * 让两个调用点各自把意图写出来，是唯一不会错的方案。
   */
  readonly provenance: ProjectionProvenance
}

export interface ProjectionProvenance {
  readonly createdBy: string
  /** 只有**老数据迁移**产生的 revision 才带这个标记；双写新建的**不带**。 */
  readonly migratedFrom?: string
}

export interface LegacyProjection {
  readonly pipeline: PipelineRecord
  readonly revision: PipelineRevision
  readonly run: PipelineRun
}

/**
 * 把旧 manifest + checkpoint 投影成 L1 三对象。
 *
 * **不落盘**。调用方（L1a 的只读端点）拿到结果后直接用于视图，磁盘上零新文件。
 */
export function projectLegacy(input: LegacyProjectionInput): LegacyProjection {
  const { manifest, checkpoint, tasks, dataRoot, roots, now, provenance } = input
  const revisionId = revisionIdOf(manifest.pipelineId, 1)
  const runId = runIdOf(manifest.pipelineId, 1)
  const createdAt = manifest.createdAt ?? now

  // 构造走 `pipeline-model.ts` 的**共用构造器**，不在这里再写一遍字段映射：
  // 迁移路径与新建路径的指纹口径必须一致（见 `revisionConfigOf` 的说明）。
  const revision = makeRevision({
    revisionId,
    pipelineId: manifest.pipelineId,
    revisionNumber: 1,
    createdAt,
    createdBy: provenance.createdBy,
    status: 'active',
    params: revisionParamsOf(manifest, checkpoint),
    ...(provenance.migratedFrom === undefined ? {} : { migratedFrom: provenance.migratedFrom }),
  })

  const pipeline = makePipelineRecord({
    pipelineId: manifest.pipelineId,
    tenantId: manifest.tenantId,
    projectId: manifest.projectId,
    configRef: manifest.configRef,
    createdAt,
    ...(manifest.updatedAt === undefined ? {} : { updatedAt: manifest.updatedAt }),
    activeRevisionId: revisionId,
    legacyLocator: legacyLocatorOf(dataRoot, roots, manifest.pipelineId, now),
  })

  // 时序：**老数据没有 run 的起止时间**。`createdAt` 是"这条流水线被创建的时间"，
  // 不是"这次运行开始的时间"；拿它冒充会让"运行耗时"从一开始就是错的。
  // 因此这里留空，并显式放行（allowUnknownTiming）——放宽是**有名字的**。
  const run = makeRun({
    runId,
    pipelineId: manifest.pipelineId,
    revisionId,
    attempt: 1,
    // 状态用**现有的**推导函数，不另写一套：两套推导一定会分叉，
    // 而"页面显示什么状态"必须只有一处定义。
    status: deriveRunStatus(checkpoint, tasks),
    cursor: checkpoint.cursor,
    createdAt,
    createdBy: provenance.createdBy,
    // **相对定位**，不是绝对路径——这个字段会出现在响应里（见 `legacyCheckpointLocator` 的说明）。
    //
    // 指向**旧**检查点（`docs/19` §2.3）：L1a/L1b 期间 `runs/<runId>/checkpoint.json`
    // 根本还没被写，指过去就是撒谎；L1c 把检查点搬进 run 目录时才改指新位置。
    // 这里曾经写成 `runCheckpointLocator(...)`（新路径），与文档相反——是写 L1b 时核出来的。
    checkpointLocator: legacyCheckpointLocator(dataRoot, roots, manifest.pipelineId),
  }, { allowUnknownTiming: true })

  return { pipeline, revision, run }
}

/**
 * 判定一份索引记录是"旧扁平 manifest"还是"新 `PipelineRecord`"。
 *
 * 判据是**结构**而不是版本号：旧形状的标识字段是 `projectId` + `configRef`，
 * 且**没有** `activeRevisionId`；新形状一定有 `activeRevisionId`。
 *
 * 为什么不用版本号：历史索引里根本没有版本字段，加一个就要回填；
 * 而结构判别对"手工改坏的文件"也更宽容（能识别出它属于哪一种，再单独报损坏）。
 */
export function looksLikeLegacyManifest(value: unknown): value is PipelineRunManifest {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  if (typeof record.pipelineId !== 'string' || typeof record.projectId !== 'string') return false
  if (typeof record.configRef !== 'string') return false
  // 新形状一定有 activeRevisionId；有它就不是旧 manifest。
  return record.activeRevisionId === undefined
}

/** 判定一份索引记录是不是新 `PipelineRecord`。 */
export function looksLikePipelineRecord(value: unknown): value is PipelineRecord {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return typeof record.pipelineId === 'string'
    && typeof record.projectId === 'string'
    && typeof record.configRef === 'string'
    && typeof record.activeRevisionId === 'string'
    && record.activeRevisionId !== ''
}
