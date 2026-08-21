/**
 * cordis 插件入口（docs/09 第 3/10 节）：把 platform-pipeline 接入 harness 宿主。
 * 提供 `ctx.pipeline` 服务（配置 / run / reenter），装配确定性组件；
 * harness 集成点（stage spawner 的 parent Agent、人工门 ui-user-questions、
 * 交叉检查审核 agent）由宿主注入——注入缺失时启动即失败（永久失败，不重试）。
 * CLI 子命令（`dsh pipeline run`）属宿主侧接线（I-3），本插件只暴露服务。
 * @module platform-pipeline/plugin
 */

import type { Context } from '@deepseek-ai/cordis'
import { loadPipelineConfig } from './config.ts'
import { FsArtifactStore, FsCheckpointPort } from './stores/fs.ts'
import { MachineGateEngine, platformGenericRules } from './gates/machine.ts'
import { stageRules } from './gates/stage-rules.ts'
import { pipelineContractSchemas } from './contracts/schemas.ts'
import { PipelineDriver, type HumanGatePort, type ReviewRunner, type RunOutcome } from './driver.ts'
import type { StageSpawner } from './stage-spawner.ts'
import type { PipelineConfig, StageId, SubsetSchema } from './types.ts'
import { join } from 'node:path'

export interface PipelinePluginConfig {
  /** pipeline.yaml 路径。 */
  readonly configPath: string
  readonly rulesetVersion?: string
  /** 产物根（artifacts/）。 */
  readonly artifactsRoot: string
  /** 检查点根（每个 pipelineId 一个子目录）。 */
  readonly checkpointRoot: string
  /** 各阶段契约 schema（G-01 用；缺省则该阶段跳过 schema 校验）。 */
  readonly schemaByStage?: Readonly<Partial<Record<StageId, SubsetSchema>>>
  /** 阶段 spawn（宿主注入：HarnessStageSpawner + parent Agent）。 */
  readonly spawner: StageSpawner
  /** 人工门（宿主注入：ui-user-questions 实现；D-01 二次机器判定也在此）。 */
  readonly human: HumanGatePort
  /** 交叉检查（宿主注入：独立审核 agent）。 */
  readonly review?: ReviewRunner
}

/** `ctx.pipeline` 服务面。 */
export interface PipelineService {
  readonly config: PipelineConfig
  /** 运行/续跑一条流水线（检查点恢复；返回终止原因）。 */
  run(pipelineId: string): Promise<RunOutcome>
  /** 人工发起重入（级联重跑，docs/03 第 8 节）。 */
  reenter(pipelineId: string, stageId: StageId, by: string, reason: string): Promise<void>
}

/** cordis 插件主体：装配确定性组件并注册 `pipeline` 服务。 */
export async function apply(ctx: Context, config: PipelinePluginConfig): Promise<void> {
  const cfg = await loadPipelineConfig(config.configPath)
  const artifacts = new FsArtifactStore(config.artifactsRoot)
  const checkpoint = new FsCheckpointPort()
  const schemas = config.schemaByStage ?? pipelineContractSchemas()
  const gates = new MachineGateEngine(
    [...platformGenericRules(schemas), ...stageRules({ maxManualClaimedRatio: cfg.releasePolicy.maxManualClaimedRatio })],
    config.rulesetVersion ?? cfg.templateVersion,
  )

  const makeDriver = (pipelineId: string): PipelineDriver => new PipelineDriver({
    cfg,
    pipelineId,
    root: join(config.checkpointRoot, pipelineId),
    rulesetVersion: config.rulesetVersion ?? cfg.templateVersion,
    spawn: config.spawner,
    gates,
    human: config.human,
    artifacts,
    checkpoint,
    ...(config.review === undefined ? {} : { review: config.review }),
  })

  const service: PipelineService = {
    config: cfg,
    run: (pipelineId) => makeDriver(pipelineId).run(),
    reenter: async (pipelineId, stageId, by, reason) => {
      await makeDriver(pipelineId).reenter(stageId, by, reason)
    },
  }
  ctx.provide('pipeline', service)
  // 生命周期：fiber 卸载时由 cordis 自动移除 provide。
  // 集成点（宿主侧接线）：CLI `dsh pipeline run` → ctx.pipeline.run(pipelineId)（I-3）。
}
