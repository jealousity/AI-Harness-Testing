/**
 * platform-pipeline 公共出口（docs/09 实现骨架第 1 步）。
 * @module platform-pipeline
 */

export {
  STAGE_ORDER,
  type Checkpoint,
  type CheckpointStatus,
  type ExecutionLevel,
  type ExecutionPolicy,
  type HumanGateConfig,
  type HumanGateRecord,
  type HumanGateState,
  type MachineGateState,
  type PipelineConfig,
  type ProjectType,
  type ReentryRecord,
  type ReleasePolicy,
  type ReviewConfig,
  type ScaleTier,
  type StageBudget,
  type StageConfig,
  type StageId,
  type StageState,
  type StoreRef,
  type StoresConfig,
  type ToolFilter,
  type Violation,
} from './types.ts'

export {
  PLATFORM_ACL,
  TOOL_CATALOG,
  toolById,
  type ToolEffect,
  type ToolEntry,
  type ToolStore,
} from './tool-catalog.ts'

export {
  effectiveAcl,
  validatePipelineAcl,
  validateStageDelta,
  type AclValidation,
} from './acl.ts'

export {
  DEFAULT_MAX_MANUAL_CLAIMED_RATIO,
  expandRuleList,
  loadPipelineConfig,
  normalizeConfig,
  parsePipelineConfig,
} from './config.ts'

export {
  CHECKPOINT_FILE,
  initialCheckpoint,
  loadCheckpoint,
  saveCheckpoint,
} from './checkpoint.ts'

export {
  assemblePrompt,
  capExtraContext,
  MAX_EXTRA_CONTEXT_CHARS,
  TRUNCATED_MARK,
  type PromptInput,
} from './prompt/assemble.ts'

export {
  STAGE_SPECS,
  type StagePromptSpec,
} from './prompt/specs.ts'

export {
  resolveStageAcl,
  stageRunContext,
  type SpawnRequest,
  type SpawnedRun,
  type StageSpawner,
} from './stage-spawner.ts'
