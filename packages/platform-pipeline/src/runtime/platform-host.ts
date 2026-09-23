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
 *   └─ checkpoint: FsCheckpointPort
 * ```
 *
 * 除 `llm.providers` 声明的 API Key（经环境变量注入）外，本模块不读取任何隐式全局状态。
 * @module platform-pipeline/runtime/platform-host
 */

import { join } from 'node:path'

import { PipelineDriver } from '../driver.ts'
import { MachineGateEngine, platformGenericRules } from '../gates/machine.ts'
import { stageRules } from '../gates/stage-rules.ts'
import { pipelineContractSchemas } from '../contracts/schemas.ts'
import { resolvePlatformRoots, type PlatformStorageRoots } from '../platform-roots.ts'
import { LlmProviderRegistry, type ResolvedLlmProvider } from '../provider-registry.ts'
import { FsArtifactStore, FsCheckpointPort } from '../stores/fs.ts'
import { STAGE_ORDER, type PipelineConfig } from '../types.ts'
import { fsReadTool, fsWriteTool } from './fs-tools.ts'
import { OpenAICompatibleClient } from './openai-client.ts'
import { OpenAIReviewRunner } from './openai-review-runner.ts'
import { OpenAIStageRunner } from './openai-stage-runner.ts'
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
  readonly maxGateRetries?: number
  /** 人工门等待上限（毫秒）；`0` = 只轮询一次就让出控制权。缺省不限。 */
  readonly gateWaitTimeoutMs?: number
  readonly gateTaskTtlMs?: number
  readonly onGatePending?: (task: HumanGateTask) => unknown
  readonly onGateDecision?: (record: PersistentGateAuditRecord) => unknown
  /** 追加工具；不能与内建 `fs_read`/`fs_write` 同名（同名直接报错，避免静默越权覆盖）。 */
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
  const tools = buildToolRegistry(roots, options)
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
    ...(options.receiveInput === undefined ? {} : { receiveInput: options.receiveInput }),
    ...(options.maxGateRetries === undefined ? {} : { maxGateRetries: options.maxGateRetries }),
    ...(signal === undefined ? {} : { signal }),
  })

  return { roots, checkpointRoot, provider, llm, tools, artifacts, gateTasks, tasks, gate, driver }
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
 * 内建工具集：`fs_read` 覆盖整个工作区，`fs_write` 只覆盖本流水线的产物目录。
 * 阶段 prompt 要求 agent 自己把产物写到固定路径，因此写权限必须真的可达，
 * 但范围收窄到 `artifacts/<pipelineId>/`（docs/06「阶段只写自己的产物路径」）。
 */
function buildToolRegistry(roots: PlatformStorageRoots, options: PlatformHostOptions): ToolRegistry {
  const registry = new InMemoryToolRegistry()
  registry.register(fsReadTool({ root: roots.projectRoot }))
  registry.register(fsWriteTool({ root: roots.projectRoot, writablePrefixes: [`artifacts/${options.pipelineId}`] }))
  // 同名注册会抛错：宁可启动失败，也不要静默用外部实现覆盖内建 fs 边界。
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
