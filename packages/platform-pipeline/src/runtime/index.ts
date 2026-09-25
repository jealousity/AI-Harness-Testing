export type {
  HumanGate,
  LlmClient,
  LlmMessage,
  LlmResponse,
  LlmResponseFormat,
  LlmToolCall,
  StageRunner,
  ToolDefinition,
  ToolExecutionContext,
  ToolFilter,
  ToolRegistry,
} from './ports.ts'

export { InMemoryToolRegistry, ToolAccessError, executeTool } from './tool-registry.ts'
export type { UsageSink } from '../usage.ts'
export { OpenAICompatibleClient, OpenAICompatibleError, type OpenAICompatibleClientOptions } from './openai-client.ts'
export { OpenAIStageRunner, type OpenAIStageRunnerOptions } from './openai-stage-runner.ts'
export {
  FileHumanGateTaskStore,
  FileTaskStore,
  newTaskId,
  type HumanGateTask,
  type HumanGateTaskStatus,
  type HumanGateTaskStore,
  type Lease,
  type TaskRecord,
  type TaskStatus,
  type TaskStore,
} from './persistence.ts'

export {
  CallbackHumanGate,
  CallbackReviewRunner,
  ScriptedStageRunner,
  type HumanDecisionFactory,
  type ScriptedContentFactory,
} from './scripted-runtime.ts'

export {
  DEFAULT_GATE_POLL_INTERVAL_MS,
  DEFAULT_GATE_TASK_TTL_MS,
  HumanGateWaitAbortedError,
  HumanGateExpiredError,
  PersistentHumanGate,
  type GateDegradePolicy,
  type PersistentGateAuditRecord,
  type PersistentHumanGateOptions,
} from './persistent-human-gate.ts'

export {
  FsToolPathError,
  WorkspaceScope,
  fsReadTool,
  fsWriteTool,
  type FsReadToolOptions,
  type FsWriteToolOptions,
} from './fs-tools.ts'

export {
  buildPlatformTools,
  executorEvidenceDir,
  executorSessionPath,
  loadExecutionSession,
  parseWorkspaceDocument,
  type ParseDocToolResult,
  type ParseDocumentToolOptions,
  type PlatformToolContext,
} from './platform-tools.ts'

export { DEFAULT_REVIEW_TOOLS, OpenAIReviewRunner, type OpenAIReviewRunnerOptions } from './openai-review-runner.ts'

export {
  DEFAULT_RULESET_VERSION,
  buildGateEngine,
  createCheckpointHost,
  createExecutionLoader,
  createPlatformHost,
  gateTaskStoreDir,
  taskStoreDir,
  usageLogDir,
  validateApprovalCoverage,
  type CheckpointHost,
  type CheckpointHostOptions,
  type PlatformHost,
  type PlatformHostOptions,
} from './platform-host.ts'
