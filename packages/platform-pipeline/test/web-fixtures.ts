/**
 * Web 层测试的共享脚手架（`pipeline-run-service` / `async-runner` / HTTP 端到端共用）。
 *
 * 提供两件事：
 * - {@link baseConfig}：最小可用流水线配置（无机器门禁规则、关闭审核），让契约测试
 *   只验证接线，不被门禁规则干扰；
 * - {@link ScriptedHost}：与 `createPlatformHost` **同样的装配顺序**，只把 LLM 阶段
 *   运行器换成 `ScriptedStageRunner`。因此测试既不需要 API Key，也不改任何契约。
 *
 * 命名沿用 `test/document-fixtures.ts` 的约定：本文件不含 `test()`，`node --test`
 * 不会把它当成用例文件。
 */

import { join } from 'node:path'

import { normalizeConfig } from '../src/config.ts'
import { PipelineDriver, type ArtifactStore } from '../src/driver.ts'
import { resolvePlatformRoots } from '../src/platform-roots.ts'
import { STAGE_ORDER, type PipelineConfig, type StageId } from '../src/types.ts'
import { DEFAULT_RULESET_VERSION, buildGateEngine, gateTaskStoreDir, taskStoreDir } from '../src/runtime/platform-host.ts'
import type { PlatformHost, PlatformHostOptions } from '../src/runtime/platform-host.ts'
import { FileHumanGateTaskStore, FileTaskStore } from '../src/runtime/persistence.ts'
import { PersistentHumanGate } from '../src/runtime/persistent-human-gate.ts'
import { ScriptedStageRunner } from '../src/runtime/scripted-runtime.ts'
import { InMemoryToolRegistry } from '../src/runtime/tool-registry.ts'
import { OpenAICompatibleClient } from '../src/runtime/openai-client.ts'
import type { ResolvedLlmProvider } from '../src/provider-registry.ts'
import { FsArtifactStore, FsCheckpointPort } from '../src/stores/fs.ts'
import type { SpawnRequest, SpawnedRun, StageSpawner } from '../src/stage-spawner.ts'
import {
  StageBudgetExceededError,
  UsageRecorder,
  fileUsageStore,
  recordUsage,
  usageDir,
  type UsageLimitKind,
  type UsageSink,
} from '../src/usage.ts'
import type { PlatformHostFactory } from '../src/web/pipeline-run-service.ts'
import type { ActorContext, CreatePipelineRunInput } from '../src/web/pipeline-run-types.ts'

/** 测试用凭据：只存在于宿主的 provider 解析结果里，绝不允许出现在任何返回值中。 */
export const API_KEY = 'sk-service-test-secret-value'
export const ENV_VAR = 'PLATFORM_SERVICE_TEST_KEY'

/** 最小可用配置：无机器门禁规则、关闭交叉检查，让契约测试只验证服务层接线。 */
export function baseConfig(overrides: Record<string, unknown> = {}): PipelineConfig {
  return normalizeConfig({
    projectId: 'demo',
    projectType: 'api-service',
    templateVersion: 'v1',
    scaleTier: 'S',
    scope: { tenantId: 'acme' },
    stores: {
      knowledge: { impl: 'markdown-fs', path: 'kb' },
      cases: { impl: 'markdown-fs', path: 'cases' },
      requirements: { primary: { impl: 'paste' } },
    },
    llm: {
      defaultProvider: 'primary',
      providers: {
        primary: {
          type: 'openai-compatible',
          baseUrl: 'https://llm.example.com/v1',
          model: 'test-model',
          apiKeyEnv: ENV_VAR,
          capabilities: { tools: true, structuredOutput: true },
        },
      },
    },
    stages: Object.fromEntries(STAGE_ORDER.map(id => [id, { rules: [], review: { enabled: false } }])),
    ...overrides,
  })
}

/** 脚本化宿主的可注入点（端到端测试用：产物内容要能区分"这是第几次 spawn"）。 */
export interface ScriptedHostOptions {
  /**
   * 阶段产物内容工厂。缺省返回固定摘要，因此同一阶段重复 spawn 的 digest 不变
   * ——需要断言"产物被重生成/未被重生成"时必须注入带计数的实现。
   */
  readonly content?: (input: { readonly stageId: StageId; readonly call: number }) => unknown
  /** 每次 spawn 的回调（`call` 跨 host 实例累计，从 `initialCall + 1` 开始）。 */
  readonly onSpawn?: (stageId: StageId, call: number) => unknown
  /**
   * `call` 的起始值。
   *
   * 端到端测试必须**跨进程**续号（进程重启后从既有 spawn 日志的行数接着数）：
   * 否则重启后重生成的产物会拿到与重启前相同的 `call`，内容相同 → digest 相同，
   * 于是「重启后产物被重生成」这件事在断言里彻底不可见。
   */
  readonly initialCall?: number
  /**
   * 每个阶段 spawn 前的异步钩子（毫秒级延迟、等待另一个进程的信号……）。
   *
   * 双进程并发测试需要**确定性**的重叠窗口：没有它，一次 run 只有十几毫秒，
   * 两个进程几乎不可能真的同时处在临界区里，测试会退化成"碰运气"；
   * 而固定 `sleep` 在并行跑全量测试时又会被拖长到失效——所以钩子必须是
   * 可以"等另一个进程的信号"的，而不是只能等一个固定时长。
   */
  readonly beforeStage?: (request: SpawnRequest) => Promise<void>
  /**
   * 每次 spawn 写入的用量事件条数（脚本化宿主的用量替身）。
   *
   * 真实阶段会发起多次模型调用与工具调用，脚本化运行器没有这些动作，
   * 因此由这里"声明"它代表多少消耗——测试要断言 `used/limit/exceeded` 时才有事实可算。
   * 缺省 `{ llm: 1, tool: 1 }`。
   */
  readonly usagePerStage?: { readonly llm?: number; readonly tool?: number }
  /**
   * 这些阶段在 spawn 时直接抛预算超限（验证 docs/10 §7.3 的失败路径：
   * 阶段失败 + 检查点可恢复 + 不进入人工批准）。
   */
  readonly budgetExceededStages?: readonly StageId[]
  /** 超限维度；缺省 `max-steps`。 */
  readonly budgetExceededKind?: UsageLimitKind
}

/** 记录 spawn 调用的脚本化运行器：用于断言"已批准阶段不重生成"。 */
export class RecordingSpawner implements StageSpawner {
  readonly stages: StageId[] = []
  private readonly inner: ScriptedStageRunner
  private readonly beforeStage: ((request: SpawnRequest) => Promise<void>) | undefined
  private readonly usage: UsageSink | undefined
  private readonly usagePerStage: { readonly llm: number; readonly tool: number }
  private readonly budgetExceededStages: ReadonlySet<StageId>
  private readonly budgetExceededKind: UsageLimitKind
  private call: number

  constructor(artifacts: ArtifactStore, options: ScriptedHostOptions = {}, usage?: UsageSink) {
    this.call = options.initialCall ?? 0
    this.beforeStage = options.beforeStage
    this.usage = usage
    this.usagePerStage = { llm: options.usagePerStage?.llm ?? 1, tool: options.usagePerStage?.tool ?? 1 }
    this.budgetExceededStages = new Set(options.budgetExceededStages ?? [])
    this.budgetExceededKind = options.budgetExceededKind ?? 'max-steps'
    this.inner = new ScriptedStageRunner(artifacts, ({ request }) => {
      this.call += 1
      const call = this.call
      options.onSpawn?.(request.stageId, call)
      return options.content === undefined
        ? { stage: request.stageId, summary: `scripted artifact for ${request.stageId}` }
        : options.content({ stageId: request.stageId, call })
    })
  }

  async runStage(request: SpawnRequest, cfg: PipelineConfig): Promise<SpawnedRun> {
    this.stages.push(request.stageId)
    if (this.beforeStage !== undefined) await this.beforeStage(request)
    if (this.budgetExceededStages.has(request.stageId)) {
      const budget = cfg.stages[request.stageId].budget
      const limit = this.budgetExceededKind === 'timeout' ? budget.timeoutMs : budget.maxSteps
      throw new StageBudgetExceededError(request.stageId, {
        kind: this.budgetExceededKind,
        used: limit + 1,
        limit,
      })
    }
    const spawned = await this.inner.runStage(request, cfg)
    await this.emitUsage(request.stageId)
    return spawned
  }

  /** 每次 spawn 记一组用量事件（`llm` + `tool`），代表这个阶段"确实跑了活"。 */
  private async emitUsage(stageId: StageId): Promise<void> {
    if (this.usage === undefined) return
    const at = Date.now()
    for (let index = 0; index < this.usagePerStage.llm; index += 1) {
      await recordUsage(this.usage, {
        stageId, kind: 'llm', startedAt: at, finishedAt: at, success: true,
        inputTokens: 10, outputTokens: 5,
      })
    }
    for (let index = 0; index < this.usagePerStage.tool; index += 1) {
      await recordUsage(this.usage, {
        stageId, kind: 'tool', startedAt: at, finishedAt: at, success: true, toolName: 'fs_read',
      })
    }
  }
}

/**
 * 脚本化宿主（与 `createPlatformHost` 同样的装配顺序，只把 LLM 阶段运行器换成
 * `ScriptedStageRunner`）。
 *
 * 关键点：**产物库实例由宿主工厂创建并交给 spawner**，否则 spawner 会写到另一个
 * baseDir，driver 读不到产物、机器门禁以 R-ARTIFACT-READABLE 拦下。
 * 所有 host 实例共用同一个 `RecordingSpawner`，因此 spawn 记录跨多次 `run()` 累积。
 *
 * provider/llm 字段仍按真实形状构造（API Key 由宿主持有），用于验证服务层不会把它带进返回值。
 */
export class ScriptedHost {
  private spawner: RecordingSpawner | undefined
  private readonly options: ScriptedHostOptions

  constructor(options: ScriptedHostOptions = {}) {
    this.options = options
  }

  /** 累计的 spawn 记录（跨多次 run 与多个 host 实例）。 */
  get stages(): readonly StageId[] {
    return this.spawner?.stages ?? []
  }

  readonly factory: PlatformHostFactory = (options: PlatformHostOptions): PlatformHost => {
    const roots = resolvePlatformRoots(options.dataRoot, options.config)
    const checkpointRoot = join(roots.checkpointRoot, options.pipelineId)
    const artifacts = new FsArtifactStore(roots.artifactsRoot)
    // 用量记录器与生产同源（同一份 `usageDir` + `UsageRecorder`），否则"预算查询"
    // 在测试里走的是另一套路径，等于没验证 docs/10 §7.3。
    const usage = new UsageRecorder({
      store: fileUsageStore(usageDir(roots.projectRoot)),
      scope: {
        tenantId: options.config.scope?.tenantId ?? 'default',
        projectId: options.config.projectId,
        pipelineId: options.pipelineId,
      },
    })
    this.spawner ??= new RecordingSpawner(artifacts, this.options, usage)
    const spawner = this.spawner
    const gateTasks = new FileHumanGateTaskStore(gateTaskStoreDir(roots.projectRoot))
    const tasks = new FileTaskStore(taskStoreDir(roots.projectRoot))
    const gate = new PersistentHumanGate({
      store: gateTasks,
      projectId: options.config.projectId,
      pipelineId: options.pipelineId,
      ...(options.config.scope?.tenantId === undefined ? {} : { tenantId: options.config.scope.tenantId }),
      ...(options.gateWaitTimeoutMs === undefined ? {} : { waitTimeoutMs: options.gateWaitTimeoutMs }),
      ...(options.gateTaskTtlMs === undefined ? {} : { taskTtlMs: options.gateTaskTtlMs }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    })
    const provider: ResolvedLlmProvider = {
      name: 'scripted',
      type: 'openai-compatible',
      baseUrl: 'https://llm.invalid/v1',
      model: 'scripted',
      apiKeyEnv: ENV_VAR,
      apiKey: API_KEY,
      capabilities: { tools: true, structuredOutput: true },
    }
    const driver = new PipelineDriver({
      cfg: options.config,
      pipelineId: options.pipelineId,
      root: checkpointRoot,
      rulesetVersion: DEFAULT_RULESET_VERSION,
      spawn: spawner,
      gates: buildGateEngine(options.config),
      human: gate,
      artifacts,
      checkpoint: new FsCheckpointPort(),
      usage,
    })
    return {
      roots,
      checkpointRoot,
      provider,
      llm: new OpenAICompatibleClient({
        baseUrl: provider.baseUrl,
        apiKey: provider.apiKey,
        defaultModel: provider.model,
        fetchImpl: async () => { throw new Error('scripted host: LLM 不应被调用') },
      }),
      tools: new InMemoryToolRegistry(),
      artifacts,
      gateTasks,
      tasks,
      gate,
      driver,
      usage,
    }
  }
}

/** 具备全部角色、租户与配置一致的调用者。 */
export const REVIEWER: ActorContext = { actorId: 'alice', tenantId: 'acme', roles: ['reviewer', 'admin'] }

export const CREATE: CreatePipelineRunInput = { projectId: 'demo', pipelineId: 'pipe-1', configRef: 'pipeline.yaml' }

export const SCOPE = { projectId: 'demo', pipelineId: 'pipe-1' } as const
