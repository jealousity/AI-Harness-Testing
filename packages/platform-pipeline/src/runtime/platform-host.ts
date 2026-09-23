/**
 * 无 Harness 宿主装配（方案一的落地入口）。
 *
 * 把已就绪的通用部件按 pipeline 配置接成一条可直接运行的六阶段流水线：
 *
 * ```text
 * PipelineDriver
 *   ├─ spawn    : OpenAIStageRunner（prompt → LLM → 受限工具 → 结构化产物）
 *   ├─ review   : OpenAIReviewRunner（盲审 + 只读工具 + 不可用降级）
 *   ├─ human    : PersistentHumanGate（落盘任务 + 外部 claim/decide + 可恢复）
 *   ├─ artifacts: FsArtifactStore
 *   ├─ execution: 从 executor/<pipelineId>/session.json 只读加载（R4-08/09/10 对账）
 *   └─ checkpoint: FsCheckpointPort
 * ```
 *
 * 工具集覆盖平台 ACL 声明的全部工具名（fs 族 + `parse_doc`/`kb_*`/`case_*`/`executor_run`/
 * `env_diag`/`req_pull`/`gate_check`），使每个阶段的 allow 真正可达，而不是"能跑但拿不到工具"。
 *
 * 除 `llm.providers` 声明的 API Key（经环境变量注入）外，本模块不读取任何隐式全局状态。
 * @module platform-pipeline/runtime/platform-host
 */

import { join } from 'node:path'

import { effectiveAcl } from '../acl.ts'
import { PipelineDriver, type ExecutionLoader } from '../driver.ts'
import { MachineGateEngine, platformGenericRules } from '../gates/machine.ts'
import { stageRules } from '../gates/stage-rules.ts'
import { pipelineContractSchemas } from '../contracts/schemas.ts'
import { resolvePlatformRoots, type PlatformStorageRoots } from '../platform-roots.ts'
import { LlmProviderRegistry, type ResolvedLlmProvider } from '../provider-registry.ts'
import { FsArtifactStore, FsCheckpointPort } from '../stores/fs.ts'
import { toolById } from '../tool-catalog.ts'
import { STAGE_ORDER, type PipelineConfig, type StageId } from '../types.ts'
import type { DiagSpec } from '../executor/env-diag.ts'
import { fsReadTool, fsWriteTool } from './fs-tools.ts'
import { OpenAICompatibleClient } from './openai-client.ts'
import { OpenAIReviewRunner } from './openai-review-runner.ts'
import { OpenAIStageRunner } from './openai-stage-runner.ts'
import {
  buildPlatformTools,
  executorEvidenceDir,
  executorSessionPath,
  loadExecutionSession,
} from './platform-tools.ts'
import { FileHumanGateTaskStore, FileTaskStore, type HumanGateTask } from './persistence.ts'
import {
  PersistentHumanGate,
  type PersistentGateAuditRecord,
} from './persistent-human-gate.ts'
import { InMemoryToolRegistry } from './tool-registry.ts'
import type { ToolDefinition, ToolRegistry } from './ports.ts'

/** 默认规则集版本（写入检查点，用于追溯判定口径）。 */
export const DEFAULT_RULESET_VERSION = 'platform-generic-r1'

export interface PlatformHostOptions {
  readonly config: PipelineConfig
  /** 平台数据根；项目目录由 `resolvePlatformRoots` 按 scope 推导。 */
  readonly dataRoot: string
  readonly pipelineId: string
  readonly rulesetVersion?: string
  /** 指定 provider 名；缺省按 `llm.defaultProvider` 起逐个回退。 */
  readonly providerName?: string
  readonly env?: Readonly<Record<string, string | undefined>>
  readonly signal?: AbortSignal
  /** receive 阶段的输入文件路径（降级链末级）。 */
  readonly receiveInput?: string
  /**
   * 被测服务基址（execute 阶段的 `executor_run` 用它真实发请求）。
   * 缺省时 `executor_run` 拒绝执行并报错——没有真实被测服务就不允许产出执行证据。
   */
  readonly targetBaseUrl?: string
  /** `env_diag` 的固定探针白名单（模型不能自行指定目标）。 */
  readonly diagProbes?: readonly DiagSpec[]
  readonly diagTimeoutMs?: number
  readonly maxGateRetries?: number
  /** 人工门等待上限（毫秒）；`0` = 只轮询一次就让出控制权。缺省不限。 */
  readonly gateWaitTimeoutMs?: number
  readonly gateTaskTtlMs?: number
  readonly onGatePending?: (task: HumanGateTask) => unknown
  readonly onGateDecision?: (record: PersistentGateAuditRecord) => unknown
  /** 追加工具；不能与内建工具（`fs_read`/`fs_write` 与平台标准工具集）同名（同名直接报错，避免静默越权覆盖）。 */
  readonly tools?: readonly ToolDefinition[]
  readonly timeoutMs?: number
  readonly maxRetries?: number
  /** 自定义传输（测试注入 / 私有网关代理）。 */
  readonly fetchImpl?: typeof fetch
}

export interface PlatformHost {
  readonly roots: PlatformStorageRoots
  readonly checkpointRoot: string
  readonly provider: ResolvedLlmProvider
  readonly llm: OpenAICompatibleClient
  readonly tools: ToolRegistry
  readonly artifacts: FsArtifactStore
  readonly gateTasks: FileHumanGateTaskStore
  readonly tasks: FileTaskStore
  readonly gate: PersistentHumanGate
  readonly driver: PipelineDriver
}

/** 人工门任务目录约定（CLI 与宿主共用，避免两处拼路径漂移）。 */
export function gateTaskStoreDir(projectRoot: string): string {
  return join(projectRoot, 'gates')
}

/** 通用任务目录约定。 */
export function taskStoreDir(projectRoot: string): string {
  return join(projectRoot, 'tasks')
}

/** 从配置装配可直接运行的宿主；配置不完整时立即报错，不做隐式兜底。 */
export function createPlatformHost(options: PlatformHostOptions): PlatformHost {
  const { config } = options
  if (options.pipelineId.trim() === '') throw new Error('pipelineId 必填')
  if (config.llm === undefined) {
    throw new Error('pipeline 配置缺少 llm.providers：无 Harness 宿主必须显式声明至少一个 provider（API Key 经 apiKeyEnv 注入）')
  }
  // 允许了 requiresApproval 工具（kb_write / case_archive）的阶段必须有阻塞人工门，
  // 否则"先批准再写库"无从落地（docs/06 第 7 节）。
  validateApprovalCoverage(config)

  const roots = resolvePlatformRoots(options.dataRoot, config)
  const checkpointRoot = join(roots.checkpointRoot, options.pipelineId)

  const registry = new LlmProviderRegistry(config.llm, options.env ?? process.env)
  const requirement = { tools: true, structuredOutput: true } as const
  const provider = options.providerName === undefined
    ? registry.select(requirement)
    : registry.resolve(options.providerName, requirement)

  const llm = new OpenAICompatibleClient({
    baseUrl: provider.baseUrl,
    apiKey: provider.apiKey,
    defaultModel: provider.model,
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    ...(options.maxRetries === undefined ? {} : { maxRetries: options.maxRetries }),
    ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
  })

  const artifacts = new FsArtifactStore(roots.artifactsRoot)
  const gates = buildGateEngine(config)
  const tools = buildToolRegistry(roots, options, checkpointRoot)
  const signal = options.signal

  const stageRunner = new OpenAIStageRunner({
    llm, tools, artifacts, model: provider.model,
    ...(signal === undefined ? {} : { signal }),
  })
  const review = new OpenAIReviewRunner({
    llm, tools, model: provider.model,
    ...(signal === undefined ? {} : { signal }),
  })

  const gateTasks = new FileHumanGateTaskStore(gateTaskStoreDir(roots.projectRoot))
  const tasks = new FileTaskStore(taskStoreDir(roots.projectRoot))
  const gate = new PersistentHumanGate({
    store: gateTasks,
    projectId: config.projectId,
    pipelineId: options.pipelineId,
    ...(config.scope?.tenantId === undefined ? {} : { tenantId: config.scope.tenantId }),
    ...(options.gateTaskTtlMs === undefined ? {} : { taskTtlMs: options.gateTaskTtlMs }),
    ...(options.gateWaitTimeoutMs === undefined ? {} : { waitTimeoutMs: options.gateWaitTimeoutMs }),
    ...(options.onGatePending === undefined ? {} : { onPending: options.onGatePending }),
    ...(options.onGateDecision === undefined ? {} : { onDecision: options.onGateDecision }),
    ...(signal === undefined ? {} : { signal }),
  })

  const driver = new PipelineDriver({
    cfg: config,
    pipelineId: options.pipelineId,
    root: checkpointRoot,
    rulesetVersion: options.rulesetVersion ?? DEFAULT_RULESET_VERSION,
    spawn: stageRunner,
    gates,
    human: gate,
    artifacts,
    checkpoint: new FsCheckpointPort(),
    review,
    // execute 阶段门禁（R4-08/09/10）要对账 executor 自产的记录与证据；
    // 会话由 executor_run 落盘，这里只做只读加载（缺失 = 未真实执行，门禁据此拦截）。
    execution: createExecutionLoader(roots.projectRoot, options.pipelineId),
    ...(options.receiveInput === undefined ? {} : { receiveInput: options.receiveInput }),
    ...(options.maxGateRetries === undefined ? {} : { maxGateRetries: options.maxGateRetries }),
    ...(signal === undefined ? {} : { signal }),
  })

  return { roots, checkpointRoot, provider, llm, tools, artifacts, gateTasks, tasks, gate, driver }
}

/**
 * driver 的执行数据加载器（R4-08/09/10 对账用）。
 *
 * 只对 execute 阶段生效：其余阶段返回 undefined。会话缺失 = 尚未真实执行，
 * 门禁据此判定"未执行"并拦截，而不是放行一份没有执行证据的产物。
 */
export function createExecutionLoader(projectRoot: string, pipelineId: string): ExecutionLoader {
  const sessionPath = executorSessionPath(projectRoot, pipelineId)
  const evidenceDir = executorEvidenceDir(projectRoot, pipelineId)
  return {
    load: async (stageId: StageId) => {
      if (stageId !== 'execute') return undefined
      return loadExecutionSession(sessionPath, evidenceDir)
    },
  }
}

/** 门禁引擎 + 配置引用规则校验（引用未实现规则时立即失败，避免配置与运行时静默漂移）。 */
export function buildGateEngine(config: PipelineConfig): MachineGateEngine {
  const engine = new MachineGateEngine(
    [...platformGenericRules(pipelineContractSchemas()), ...stageRules({ maxManualClaimedRatio: config.releasePolicy.maxManualClaimedRatio })],
    config.templateVersion,
  )
  const missing = STAGE_ORDER.flatMap(id => engine.validateRuleIds(config.stages[id]!.rules).map(rule => `${id}:${rule}`))
  if (missing.length > 0) throw new Error(`配置引用未实现规则：${missing.join(', ')}`)
  return engine
}

/**
 * 校验「需审批工具 ↔ 阻塞人工门」的覆盖关系（docs/06 第 7 节）。
 *
 * `kb_write` / `case_archive` 属 mutate-external + requiresApproval。通用宿主没有独立的
 * 逐调用审批通道，归档写库的批次审批由该阶段的阻塞人工门承担（tool-catalog.ts 的设计约定：
 * 「归档写库与门 G 融合为批次审批」）。因此：阶段允许了这类工具却没有阻塞人工门 = 配置错误，
 * 启动即失败，而不是运行到写库那一刻才无声放行。
 */
export function validateApprovalCoverage(config: PipelineConfig): void {
  const uncovered: string[] = []
  for (const stageId of STAGE_ORDER) {
    const gated = Object.values(config.stages[stageId].gate).some(gate => gate.block)
    if (gated) continue
    for (const name of effectiveAcl(stageId, config).allow ?? []) {
      if (toolById(name)?.requiresApproval === true) uncovered.push(`${stageId}:${name}`)
    }
  }
  if (uncovered.length > 0) {
    throw new Error(
      `需审批工具缺少阻塞人工门：${uncovered.join(', ')}；请在对应阶段配置 gate.<name>.block=true，`
      + '或从 ACL 中移除该工具（写库不得无人工批准自动放行）',
    )
  }
}

/**
 * 内建工具集：
 * - `fs_read` 覆盖整个工作区，`fs_write` 只覆盖本流水线的产物目录（阶段只写自己的产物路径）；
 * - 平台标准工具集（`parse_doc`/`kb_query`/`kb_write`/`case_query`/`case_archive`/`req_pull`/
 *   `executor_run`/`env_diag`/`gate_check`）按 tool-catalog 的工具名注册，使各阶段 ACL
 *   声明的 allow 真正可达——否则 analyze/execute/archive 拿到的工具集是空的。
 */
function buildToolRegistry(
  roots: PlatformStorageRoots,
  options: PlatformHostOptions,
  checkpointRoot: string,
): ToolRegistry {
  const registry = new InMemoryToolRegistry()
  registry.register(fsReadTool({ root: roots.projectRoot }))
  registry.register(fsWriteTool({ root: roots.projectRoot, writablePrefixes: [`artifacts/${options.pipelineId}`] }))
  for (const tool of buildPlatformTools({
    projectRoot: roots.projectRoot,
    artifactsRoot: roots.artifactsRoot,
    pipelineId: options.pipelineId,
    projectId: options.config.projectId,
    ...(roots.knowledgeRoot === undefined ? {} : { knowledgeRoot: roots.knowledgeRoot }),
    ...(roots.casesRoot === undefined ? {} : { casesRoot: roots.casesRoot }),
    ...(options.receiveInput === undefined ? {} : { receiveInput: options.receiveInput }),
    checkpointRoot,
    ...(options.targetBaseUrl === undefined ? {} : { targetBaseUrl: options.targetBaseUrl }),
    ...(options.diagProbes === undefined ? {} : { diagProbes: options.diagProbes }),
    ...(options.diagTimeoutMs === undefined ? {} : { diagTimeoutMs: options.diagTimeoutMs }),
    ...(options.env === undefined ? {} : { env: options.env }),
  })) {
    registry.register(tool)
  }
  // 同名注册会抛错：宁可启动失败，也不要静默用外部实现覆盖内建工具的权限边界。
  for (const tool of options.tools ?? []) registry.register(tool)
  return registry
}

export interface CheckpointHostOptions {
  readonly config: PipelineConfig
  readonly dataRoot: string
  readonly pipelineId: string
  readonly rulesetVersion?: string
}

export interface CheckpointHost {
  readonly roots: PlatformStorageRoots
  readonly checkpointRoot: string
  readonly driver: PipelineDriver
}

/**
 * 只装配检查点侧能力（`reenter` 一类运维操作）：**不解析 provider、不需要 API Key**。
 *
 * 返回的 driver 只能用于 `reenter()`；若误调用 `run()`，会立刻因端口未装配而报错，
 * 而不是静默跑出一条半成品流水线。
 */
export function createCheckpointHost(options: CheckpointHostOptions): CheckpointHost {
  if (options.pipelineId.trim() === '') throw new Error('pipelineId 必填')
  const roots = resolvePlatformRoots(options.dataRoot, options.config)
  const unavailable = (what: string) => (): never => {
    throw new Error(`checkpoint-only host 未装配 ${what}；运行阶段请改用 createPlatformHost`)
  }
  const driver = new PipelineDriver({
    cfg: options.config,
    pipelineId: options.pipelineId,
    root: join(roots.checkpointRoot, options.pipelineId),
    rulesetVersion: options.rulesetVersion ?? DEFAULT_RULESET_VERSION,
    spawn: { runStage: unavailable('stage spawner') },
    gates: buildGateEngine(options.config),
    human: { gate: unavailable('human gate'), gateFailed: unavailable('human gate') },
    artifacts: new FsArtifactStore(roots.artifactsRoot),
    checkpoint: new FsCheckpointPort(),
  })
  return { roots, checkpointRoot: join(roots.checkpointRoot, options.pipelineId), driver }
}
