/**
 * cordis 插件入口（docs/09 第 3/10 节）：把 platform-pipeline 接入 harness 宿主。
 * 提供 `ctx.pipeline` 服务（配置 / run / reenter），装配确定性组件；
 * harness 集成点（stage spawner 的 parent Agent、人工门 ui-user-questions、
 * 交叉检查审核 agent）由宿主注入——注入缺失时启动即失败（永久失败，不重试）。
 * CLI 子命令（`dsh pipeline run`）属宿主侧接线（I-3），本插件只暴露服务。
 * @module platform-pipeline/plugin
 */

import { loadPipelineConfig } from './config.ts'
import { FsArtifactStore, FsCheckpointPort } from './stores/fs.ts'
import { MachineGateEngine, platformGenericRules } from './gates/machine.ts'
import { stageRules } from './gates/stage-rules.ts'
import { pipelineContractSchemas } from './contracts/schemas.ts'
import { PipelineDriver, type ExecutionLoader, type HumanGatePort, type ReviewRunner, type RunOutcome } from './driver.ts'
import type { StageSpawner } from './stage-spawner.ts'
import type { PipelineConfig, StageId } from './types.ts'
import type { SubsetSchema } from './gates/schema.ts'
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
  /** executor 执行数据（宿主注入：从 executor 写入的记录/证据读取；R4-08/09/10 用）。 */
  readonly execution?: ExecutionLoader
}

/** `ctx.pipeline` 服务面。 */
export interface PipelineService {
  readonly config: PipelineConfig
  /** 运行/续跑一条流水线（检查点恢复；返回终止原因）。 */
  run(pipelineId: string): Promise<RunOutcome>
  /** 人工发起重入（级联重跑，docs/03 第 8 节）。 */
  reenter(pipelineId: string, stageId: StageId, by: string, reason: string): Promise<void>
}

/**
 * 本插件用到的宿主上下文**最小结构面**（cordis `Context` 的结构化子集）。
 *
 * 为什么不直接写 `import type { Context } from '@deepseek-ai/cordis'`：
 * `apply` 是包根出口（`platform-pipeline`）导出的公开 API。一旦签名里出现 cordis
 * 类型，`dist/plugin.d.ts` 就会带上 `import type … from '@deepseek-ai/cordis'`——
 * 任何 **harness-free** 的消费者只要 `import 'platform-pipeline'`，就必须额外安装
 * cordis 才能通过类型检查（运行时不缺，类型面缺）。这与 docs/10 §1「Harness 已从
 * 核心运行时解耦为可选适配层」的基线直接冲突。
 *
 * 改成结构类型后，cordis 的 `Context` 仍然天然满足这个接口（`provide` 是它的
 * 模块增强成员），但"依赖 cordis"退化成调用方的自由选择，不再进入本包的类型面。
 */
export interface PluginHostContext {
  /**
   * 注册一个服务实现。
   *
   * 返回值（disposer）**有意忽略**：cordis 会在 fiber 卸载时自动移除该 provide，
   * 本插件不需要手动撤销，因此这里把它收窄成 `void` 以免暴露 cordis 细节。
   */
  provide(name: string, value?: unknown): void
}

/** cordis 插件主体：装配确定性组件并注册 `pipeline` 服务。 */
export async function apply(ctx: PluginHostContext, config: PipelinePluginConfig): Promise<void> {
  const cfg = await loadPipelineConfig(config.configPath)
  const artifacts = new FsArtifactStore(config.artifactsRoot)
  const checkpoint = new FsCheckpointPort()
  const schemas = config.schemaByStage ?? pipelineContractSchemas()
  const gates = new MachineGateEngine(
    [...platformGenericRules(schemas), ...stageRules({ maxManualClaimedRatio: cfg.releasePolicy.maxManualClaimedRatio })],
    config.rulesetVersion ?? cfg.templateVersion,
  )
  for (const stageId of Object.keys(cfg.stages) as StageId[]) {
    const missing = gates.validateRuleIds(cfg.stages[stageId]!.rules)
    if (missing.length > 0) throw new Error(`pipeline config references unimplemented rule(s) for ${stageId}: ${missing.join(', ')}`)
  }

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
    ...(config.execution === undefined ? {} : { execution: config.execution }),
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
