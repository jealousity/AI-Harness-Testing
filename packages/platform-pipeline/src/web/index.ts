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
  PIPELINE_INDEX_COLLECTION,
  buildEventTimeline,
  combineSignals,
  deriveRunStatus,
  pipelineIndexDir,
  scanPipelineIndex,
  scanPipelineIndexFrom,
  type PipelineIndexEntry,
  type PipelineIndexScan,
  type PipelineRunManifest,
  type PipelineRunService,
  type PipelineRunServiceOptions,
  type PlatformHostFactory,
  type RunCallOptions,
} from './pipeline-run-service.ts'

export {
  GATE_TTL_CEILING_MS,
  GATE_WAIT_CEILING_MS,
  MAX_BODY_CEILING,
  WebServerConfigError,
  assertStartupConfigUsable,
  assertTrustActorHeadersDeployment,
  isLoopbackHost,
  parseWebServerConfig,
  startupLogLines,
  type EnvRecord,
  type WebServerConfig,
} from './server-config.ts'

export {
  ACTIVE_RUN_STATUSES,
  PipelineModelError,
  REVISION_BEHAVIOR_FIELDS,
  TERMINAL_RUN_STATUSES,
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
  type LegacyLocator,
  type PipelineRecord,
  type PipelineRevision,
  type PipelineRun,
  type RevisionBehaviorField,
  type RunFailure,
} from './pipeline-model.ts'

export {
  UnsafePathSegmentError,
  assertSafeSegment,
  legacyArtifactDir,
  legacyArtifactRoot,
  legacyCheckpointDir,
  legacyCheckpointPath,
  legacyManifestPath,
  pipelineDir,
  // 注意：`pipelineIndexDir` 目前由 `pipeline-run-service.ts` 导出（历史位置），
  // locator 里也有一份同路径的实现。L1a 刻意**不重复导出**（避免同名冲突），
  // L1b 会让服务层委托到 locator，届时再统一。
  pipelineRecordPath,
  revisionDir,
  revisionIdOf,
  revisionPath,
  runArtifactPath,
  runCheckpointLocator,
  runCheckpointPath,
  runDir,
  runIdOf,
  runRecordPath,
  runsDir,
} from './pipeline-locator.ts'

export {
  MIGRATION_ACTOR,
  looksLikeLegacyManifest,
  looksLikePipelineRecord,
  projectLegacy,
  type LegacyProjection,
  type LegacyProjectionInput,
} from './pipeline-legacy.ts'

export {
  assertTargetBaseUrlAllowed,
  assertTargetResolvedAllowed,
  isPrivateAddress,
  safeTargetUrlForMessage,
  type AssertTargetResolvedOptions,
  type ResolveHost,
} from './ssrf-guard.ts'

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
  assertAdminRole,
  deriveNextAction,
  toGateTaskView,
  assertGateRole,
  assertOperatorRole,
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
  type GateTaskKind,
  type GateTaskView,
  type NextActionDecision,
  type NextActionFacts,
  type PipelineDiagnostics,
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
  type StageAction,
  type StageArtifactView,
  type StageFailureView,
  type StageView,
  type StageViolationView,
} from './pipeline-run-types.ts'
