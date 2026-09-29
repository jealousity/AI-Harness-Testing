/**
 * 旧数据 → L1 对象的**纯函数投影**（`docs/19-l1-pipeline-revision-run-design.md` §3.3 / §4.2）。
 *
 * L1a 的定位是**只读兼容**：把现有的
 * `pipelines/<id>.json`（旧扁平 manifest）+ `checkpoints/<id>/checkpoint.json`
 * 在**内存里**投影成 `PipelineRecord + PipelineRevision + PipelineRun`，
 * **不写任何新格式文件**。这样即使模型设计错了，回滚成本为零。
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
  legacyArtifactRoot,
  legacyManifestPath,
  runCheckpointLocator,
} from './pipeline-locator.ts'
import {
  assertPipelineInvariants,
  assertRevisionInvariants,
  assertRunInvariants,
  revisionFingerprint,
  type PipelineRecord,
  type PipelineRevision,
  type PipelineRun,
} from './pipeline-model.ts'

/** 迁移产生的对象在审计里用这个 actor，避免看起来像某个真人建的。 */
export const MIGRATION_ACTOR = 'system:migration'

export interface LegacyProjectionInput {
  readonly manifest: PipelineRunManifest
  readonly checkpoint: Checkpoint
  /** 门任务参与状态推导（`waiting-human` / `rejected` / `cancelled` 需要它）。 */
  readonly tasks: readonly HumanGateTask[]
  readonly dataRoot: string
  readonly roots: PlatformStorageRoots
  /** 注入的时钟（纯函数不自己取时间）。 */
  readonly now: number
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
  const { manifest, checkpoint, tasks, dataRoot, roots, now } = input
  const revisionId = revisionIdOf(manifest.pipelineId, 1)
  const runId = runIdOf(manifest.pipelineId, 1)

  // 时序：**老数据没有 run 的起止时间**。`createdAt` 是"这条流水线被创建的时间"，
  // 不是"这次运行开始的时间"；拿它冒充会让"运行耗时"从一开始就是错的。
  // 因此这里**留空**，并在 §不变量里显式放行（allowUnknownTiming）。
  const revision: PipelineRevision = {
    revisionId,
    pipelineId: manifest.pipelineId,
    revisionNumber: 1,
    createdAt: manifest.createdAt ?? now,
    createdBy: MIGRATION_ACTOR,
    status: 'active',
    ...(manifest.requirementInput === undefined ? {} : { requirementInput: manifest.requirementInput }),
    ...(manifest.providerName === undefined ? {} : { providerName: manifest.providerName }),
    ...(manifest.targetBaseUrl === undefined ? {} : { targetBaseUrl: manifest.targetBaseUrl }),
    // `rulesetVersion` 在旧 manifest 里可能缺省（历史索引没有该字段），
    // 用 checkpoint 的作为回退——checkpoint 里那个是**真正生效过的**版本。
    rulesetVersion: manifest.rulesetVersion ?? checkpoint.rulesetVersion,
    ...(manifest.maxGateRetries === undefined ? {} : { maxGateRetries: manifest.maxGateRetries }),
    ...(manifest.gateWaitTimeoutMs === undefined ? {} : { gateWaitTimeoutMs: manifest.gateWaitTimeoutMs }),
    ...(manifest.gateTaskTtlMs === undefined ? {} : { gateTaskTtlMs: manifest.gateTaskTtlMs }),
    ...(manifest.diagCredentials === undefined ? {} : { diagCredentials: manifest.diagCredentials }),
    fingerprint: revisionFingerprint({
      requirementInput: manifest.requirementInput ?? null,
      providerName: manifest.providerName ?? null,
      targetBaseUrl: manifest.targetBaseUrl ?? null,
      rulesetVersion: manifest.rulesetVersion ?? checkpoint.rulesetVersion,
      maxGateRetries: manifest.maxGateRetries ?? null,
      gateWaitTimeoutMs: manifest.gateWaitTimeoutMs ?? null,
      gateTaskTtlMs: manifest.gateTaskTtlMs ?? null,
      diagCredentials: manifest.diagCredentials ?? null,
    }),
    migratedFrom: 'legacy-manifest',
  }

  const pipeline: PipelineRecord = {
    pipelineId: manifest.pipelineId,
    tenantId: manifest.tenantId,
    projectId: manifest.projectId,
    configRef: manifest.configRef,
    createdAt: manifest.createdAt ?? revision.createdAt,
    ...(manifest.updatedAt === undefined ? {} : { updatedAt: manifest.updatedAt }),
    activeRevisionId: revisionId,
    legacyLocator: {
      manifestPath: legacyManifestPath(dataRoot, manifest.pipelineId),
      checkpointPath: legacyCheckpointPath(roots, manifest.pipelineId),
      artifactsRoot: legacyArtifactRoot(roots),
      migratedAt: now,
    },
  }

  const run: PipelineRun = {
    runId,
    pipelineId: manifest.pipelineId,
    revisionId,
    attempt: 1,
    // 状态用**现有的**推导函数，不另写一套：两套推导一定会分叉，
    // 而"页面显示什么状态"必须只有一处定义。
    status: deriveRunStatus(checkpoint, tasks),
    cursor: checkpoint.cursor,
    createdAt: revision.createdAt,
    createdBy: MIGRATION_ACTOR,
    // **相对定位**，不是绝对路径——这个字段会出现在响应里（见 `runCheckpointLocator` 的说明）。
    // L1a 仍指向旧检查点（还没迁到 run 目录）；L1b 迁移后内容不变（run 目录结构就是它）。
    checkpointLocator: runCheckpointLocator(manifest.pipelineId, runId),
  }

  assertPipelineInvariants(pipeline)
  assertRevisionInvariants(revision)
  assertRunInvariants(run, { allowUnknownTiming: true })
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
