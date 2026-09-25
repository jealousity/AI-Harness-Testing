/**
 * 无 HTTP 框架依赖的 Web 运行层出口（docs/10 §5.2）。
 *
 * 与 `runtime/` 一样拥有独立入口：核心包 `index.ts` 只暴露与入口无关的
 * 配置/检查点/门禁/ACL 能力，宿主装配与 Web 服务分别走 `./runtime` 与 `./web`。
 *
 * @module platform-pipeline/web
 */

export {
  FilePipelineRunService,
  assertTargetBaseUrlAllowed,
  buildEventTimeline,
  combineSignals,
  deriveRunStatus,
  pipelineIndexDir,
  scanPipelineIndex,
  type PipelineIndexEntry,
  type PipelineIndexScan,
  type PipelineRunService,
  type PipelineRunServiceOptions,
  type PlatformHostFactory,
  type RunCallOptions,
} from './pipeline-run-service.ts'

export {
  PipelineRunRegistry,
  type PipelineRunHandle,
  type RunSettlement,
} from './pipeline-run-registry.ts'

export {
  AsyncPipelineRunner,
  decideRecovery,
  type AsyncPipelineRunnerOptions,
  type BackgroundRunOutcome,
  type RecoveryAction,
  type RecoveryOutcome,
  type TriggerResult,
} from './async-runner.ts'

export {
  UsageRecorder,
  budgetFailuresOf,
  fileUsageStore,
  retryFactsOf,
  summarizeUsage,
  usageDir,
  type StageUsageSummary,
  type UsageEvent,
  type UsageLimitExceeded,
  type UsageSink,
  type UsageStore,
  type UsageSummary,
  type UsageTotals,
} from '../usage.ts'

export {
  PIPELINE_RUN_ERROR_HTTP_STATUS,
  PipelineRunError,
  errorMessageOf,
  redactSecrets,
  toPipelineRunError,
  type ActorContext,
  type ActorRole,
  type CreatePipelineRunInput,
  type GateCancelInput,
  type GateClaimInput,
  type GateDecisionInput,
  type GateTaskFilter,
  type PipelineEventKind,
  type PipelineEventView,
  type PipelineRunErrorCode,
  type PipelineRunErrorView,
  type PipelineRunFailure,
  type PipelineRunStatus,
  type PipelineRunSummary,
  type PipelineRunView,
  type PipelineScope,
  type ReenterInput,
  type RunResult,
  type StageArtifactView,
  type StageFailureView,
  type StageView,
  type StageViolationView,
} from './pipeline-run-types.ts'
