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
  /** 每次 spawn 的回调（`call` 跨 host 实例累计，从 1 开始）。 */
  readonly onSpawn?: (stageId: StageId, call: number) => unknown
}

/** 记录 spawn 调用的脚本化运行器：用于断言"已批准阶段不重生成"。 */
export class RecordingSpawner implements StageSpawner {
  readonly stages: StageId[] = []
  private readonly inner: ScriptedStageRunner
  private call = 0

  constructor(artifacts: ArtifactStore, options: ScriptedHostOptions = {}) {
    this.inner = new ScriptedStageRunner(artifacts, ({ request }) => {
      this.call += 1
      const call = this.call
      options.onSpawn?.(request.stageId, call)
      return options.content === undefined
        ? { stage: request.stageId, summary: `scripted artifact for ${request.stageId}` }
        : options.content({ stageId: request.stageId, call })
    })
  }

  runStage(request: SpawnRequest, cfg: PipelineConfig): Promise<SpawnedRun> {
    this.stages.push(request.stageId)
    return this.inner.runStage(request, cfg)
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
    this.spawner ??= new RecordingSpawner(artifacts, this.options)
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
    }
  }
}

/** 具备全部角色、租户与配置一致的调用者。 */
export const REVIEWER: ActorContext = { actorId: 'alice', tenantId: 'acme', roles: ['reviewer', 'admin'] }

export const CREATE: CreatePipelineRunInput = { projectId: 'demo', pipelineId: 'pipe-1', configRef: 'pipeline.yaml' }

export const SCOPE = { projectId: 'demo', pipelineId: 'pipe-1' } as const
