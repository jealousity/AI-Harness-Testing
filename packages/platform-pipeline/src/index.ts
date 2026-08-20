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

export {
  MachineGateEngine,
  computeArtifactDigest,
  platformGenericRules,
  type GateRule,
  type JudgeResult,
  type RuleContext,
} from './gates/machine.ts'

export {
  deepEqual,
  validateSubset,
  type SubsetSchema,
} from './gates/schema.ts'

export type { InputLocks, StageArtifact } from './types.ts'

export {
  HarnessStageSpawner,
  toContentBlocks,
  toToolRestriction,
  type HarnessSpawnerDeps,
} from './harness/index.ts'

export {
  PipelineDriver,
  type ArtifactStore,
  type CheckpointPort,
  type DriverOptions,
  type HumanDecision,
  type HumanGatePort,
  type ReviewOutcome,
  type ReviewRunner,
  type RunOutcome,
} from './driver.ts'

export {
  makeRecord,
  hashRecord,
  verifyChain,
  reconcile,
  verifyEvidence,
} from './executor/executor.ts'
export type {
  ChainViolation,
  EvidenceEntry,
  EvidenceViolation,
  ExecutionRecord,
  ExecutionSession,
  ExecutionStatus,
  Executor,
  ExecutorContext,
  ReconcileResult,
} from './executor/executor.ts'

export {
  FsArtifactStore,
  FsCheckpointPort,
} from './stores/fs.ts'

export {
  HttpExecutor,
  type HttpCase,
  type HttpRequestFn,
  type HttpResponse,
  type HttpStep,
} from './executor/http.ts'
