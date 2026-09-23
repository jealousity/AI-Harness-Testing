/**
 * 无 HTTP 框架依赖的流水线运行服务（docs/10 §4.2 M0-2、§5.2、§5.4）。
 *
 * 这是 Web 与 CLI 之间的**唯一共享层**：路由层只做参数解析、鉴权入口和响应序列化，
 * 阶段逻辑、检查点、人工门、产物路径全部经由本服务转交 `PipelineDriver`。
 * 因此不存在"Web 又写了一套流水线"的可能。
 *
 * 职责边界（docs/10 §4.2 M0-2 原文）：
 * - 身份和项目作用域校验；
 * - 加载、校验和缓存配置；
 * - 装配 `createPlatformHost`；
 * - 调用 `PipelineDriver`；
 * - 映射 `HumanGateWaitAbortedError` 为 `waiting-human`；
 * - 映射机器门禁失败、审核失败、拒绝和异常；
 * - **不在 service 层复制阶段逻辑**。
 *
 * 明确不做（分别属于后续里程碑，见 docs/10 §3）：
 * - 并发锁与幂等键 → M2 / P0-C（`checkpoint-lock.ts`）；
 * - 预算与阶段耗时遥测 → M3 / P1-A；
 * - 后台调度与进程内运行句柄 → M1 的 `async-runner.ts` / `pipeline-run-registry.ts`。
 *
 * @module platform-pipeline/web/pipeline-run-service
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { validatePipelineAcl } from '../acl.ts'
import { initialCheckpoint, loadCheckpoint } from '../checkpoint.ts'
import { loadPipelineConfig } from '../config.ts'
import { resolvePlatformRoots } from '../platform-roots.ts'
import { assertScopeMatch } from '../platform-scope.ts'
import { FsArtifactStore, FsCheckpointPort } from '../stores/fs.ts'
import type { ArtifactStore } from '../driver.ts'
import { STAGE_ORDER, type Checkpoint, type PipelineConfig, type StageId, type StageState } from '../types.ts'
import {
  buildGateEngine,
  createCheckpointHost,
  createPlatformHost,
  gateTaskStoreDir,
  type PlatformHost,
  type PlatformHostOptions,
} from '../runtime/platform-host.ts'
import { FileHumanGateTaskStore, type HumanGateTask } from '../runtime/persistence.ts'
import { HumanGateWaitAbortedError } from '../runtime/persistent-human-gate.ts'
import {
  PipelineRunError,
  toPipelineRunError,
  type ActorContext,
  type CreatePipelineRunInput,
  type GateCancelInput,
  type GateClaimInput,
  type GateDecisionInput,
  type GateTaskFilter,
  type PipelineRunFailure,
  type PipelineRunStatus,
  type PipelineRunSummary,
  type PipelineRunView,
  type ReenterInput,
  type RunResult,
  type StageView,
} from './pipeline-run-types.ts'

/** 宿主工厂：生产环境是 `createPlatformHost`，测试注入 `ScriptedStageRunner` 装配。 */
export type PlatformHostFactory = (options: PlatformHostOptions) => PlatformHost

export interface PipelineRunServiceOptions {
  /**
   * 平台数据根。项目目录一律由 `resolvePlatformRoots` 按 scope 推导，
   * 服务层不拼接任何 artifacts/checkpoints/gates/tasks 路径（docs/10 §4.2 M0-1、§4.3）。
   */
  readonly dataRoot: string
  /** 配置解析器；缺省读取 `configRef` 指向的 pipeline.yaml / json。 */
  readonly loadConfig?: (configRef: string) => Promise<PipelineConfig>
  /** 宿主工厂；缺省 `createPlatformHost`。测试注入脚本化宿主以脱离 API Key 与模型。 */
  readonly createHost?: PlatformHostFactory
  /**
   * 默认人工门等待上限。**缺省 `0`**：只轮询一次就让出控制权，
   * HTTP handler 不会挂住连接等真人裁决（docs/10 §5.4）。
   */
  readonly defaultGateWaitTimeoutMs?: number
  readonly defaultGateTaskTtlMs?: number
  /** `targetBaseUrl` 校验；缺省拒绝本机、内网、链路本地与 CGNAT 地址（docs/10 §5.3 的 SSRF 约束）。 */
  readonly assertTargetBaseUrl?: (url: string) => void
  /** 取消信号（本 service 实例内所有 run 共享；M1 的 async-runner 会改为每 run 独立）。 */
  readonly signal?: AbortSignal
}

/**
 * Web/HTTP 可调用的服务契约（docs/10 §4.2 M0-2 原文签名）。
 *
 * 前置校验失败（身份、作用域、配置、不存在、冲突）**抛 `PipelineRunError`**；
 * 运行期结果（完成、等待人工、门禁失败、审核失败、拒绝、取消、异常）由
 * `RunResult` 表达——这些都是流水线的正常状态转移，不是服务调用失败。
 */
export interface PipelineRunService {
  create(input: CreatePipelineRunInput, actor: ActorContext): Promise<PipelineRunSummary>
  get(pipelineId: string, actor: ActorContext): Promise<PipelineRunView>
  run(pipelineId: string, actor: ActorContext): Promise<RunResult>
  reenter(input: ReenterInput, actor: ActorContext): Promise<Checkpoint>
  listGateTasks(filter: GateTaskFilter, actor: ActorContext): Promise<readonly HumanGateTask[]>
  claimGate(input: GateClaimInput, actor: ActorContext): Promise<HumanGateTask>
  decideGate(input: GateDecisionInput, actor: ActorContext): Promise<HumanGateTask>
  cancelGate(input: GateCancelInput, actor: ActorContext): Promise<HumanGateTask>
}

/**
 * 流水线索引项：`pipelineId → 作用域 + 配置引用`。
 *
 * 必须**持久化**而不是只放进程内存——否则进程重启后 `get(pipelineId, actor)` 无法由
 * `pipelineId` 反解出 projectId 与配置，也就谈不上"从检查点重建页面状态"
 * （docs/10 §4.2 M0-3、§5.3「进程内 registry 不能作为唯一状态」、§5.5 验收 6）。
 */
export interface PipelineIndexEntry {
  readonly pipelineId: string
  readonly tenantId: string | null
  readonly projectId: string
  readonly configRef: string
}

/** 流水线索引目录：`<dataRoot>/pipelines`。集中在此处生成，调用点不得自行拼路径。 */
export function pipelineIndexDir(dataRoot: string): string {
  return join(dataRoot, 'pipelines')
}

/** 需要人工门权限的角色（docs/10 §5.3「校验 actor 是否有该项目的人工门权限」）。 */
const GATE_ROLES = ['reviewer', 'admin'] as const
const GATE_DECISIONS = ['approved', 'changes-needed', 'rejected'] as const
const CLAIMABLE_STATUSES = ['pending', 'claimed'] as const
const SAFE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const DEFAULT_RULESET_VERSION = 'platform-generic-r1'
const DEFAULT_CLAIM_TTL_MS = 300_000

/** 默认文件实现：事实全部落在 `dataRoot` 下的项目目录中。 */
export class FilePipelineRunService implements PipelineRunService {
  private readonly options: PipelineRunServiceOptions
  private readonly loadConfig: (configRef: string) => Promise<PipelineConfig>
  private readonly createHost: PlatformHostFactory
  private readonly assertTargetBaseUrl: (url: string) => void
  /** 配置缓存（docs/10 §4.2「加载、校验和缓存配置」）。只缓存解析成功的配置。 */
  private readonly configCache = new Map<string, PipelineConfig>()

  constructor(options: PipelineRunServiceOptions) {
    if (options.dataRoot.trim() === '') throw new Error('PipelineRunService 需要非空 dataRoot')
    this.options = options
    this.loadConfig = options.loadConfig ?? (async ref => loadPipelineConfig(ref))
    this.createHost = options.createHost ?? createPlatformHost
    this.assertTargetBaseUrl = options.assertTargetBaseUrl ?? assertTargetBaseUrlAllowed
  }

  async create(input: CreatePipelineRunInput, actor: ActorContext): Promise<PipelineRunSummary> {
    assertActor(actor)
    assertSafeIdentifier(input.pipelineId, 'pipelineId')
    assertSafeIdentifier(input.projectId, 'projectId')
    assertProjectAllowed(actor, input.projectId)
    if (input.targetBaseUrl !== undefined) this.assertTargetBaseUrl(input.targetBaseUrl)

    const config = await this.configOf(input.configRef)
    this.assertScope(config, input.projectId, actor)

    const roots = resolvePlatformRoots(this.options.dataRoot, config)
    const checkpointRoot = join(roots.checkpointRoot, input.pipelineId)
    const checkpoint = new FsCheckpointPort()

    // pipelineId 在租户/项目作用域内唯一（docs/10 §5.3）：已存在即冲突，绝不静默复用。
    if (await this.readIndex(input.pipelineId) !== null) {
      throw new PipelineRunError('conflict', `pipeline 已存在：${input.pipelineId}`, { pipelineId: input.pipelineId })
    }
    // 先落盘后返回（docs/10 §1 原则 5）：创建成功 = 磁盘上已有可恢复的初始检查点。
    await checkpoint.save(checkpointRoot, initialCheckpoint(
      input.pipelineId,
      config.templateVersion,
      input.rulesetVersion ?? DEFAULT_RULESET_VERSION,
    ))
    await this.writeIndex({
      pipelineId: input.pipelineId,
      tenantId: config.scope?.tenantId ?? null,
      projectId: config.projectId,
      configRef: input.configRef,
    })

    return {
      pipelineId: input.pipelineId,
      tenantId: config.scope?.tenantId ?? null,
      projectId: config.projectId,
      configRef: input.configRef,
      status: 'queued',
      nextStage: STAGE_ORDER[0]!,
    }
  }

  async get(pipelineId: string, actor: ActorContext): Promise<PipelineRunView> {
    assertActor(actor)
    assertSafeIdentifier(pipelineId, 'pipelineId')
    const { config, checkpoint } = await this.loadRun(pipelineId, actor)
    return this.buildView(config, checkpoint)
  }

  async run(pipelineId: string, actor: ActorContext): Promise<RunResult> {
    assertActor(actor)
    assertSafeIdentifier(pipelineId, 'pipelineId')
    const { config, checkpointRoot } = await this.locate(pipelineId, actor)
    await this.requireCheckpoint(checkpointRoot)

    const host = this.createHost(this.hostOptions(config, pipelineId))

    try {
      const outcome = await host.driver.run()
      const view = await this.buildView(config, await this.requireCheckpoint(checkpointRoot))
      if (outcome.outcome === 'completed') return { outcome: 'completed', view }
      return { outcome: outcome.outcome, stageId: outcome.stageId, view }
    } catch (error) {
      const view = await this.buildView(config, await this.requireCheckpoint(checkpointRoot))
      // 人工门等待被中止：超时 = 让出控制权等真人裁决（docs/10 §4.2、§5.4 第 4 步）；
      // 信号中止 / 任务被外部取消 = 本次运行取消。两条路径都绝不自动批准。
      if (error instanceof HumanGateWaitAbortedError) {
        if (error.reason === 'timeout') {
          return { outcome: 'waiting-human', stageId: error.stageId, gateTaskId: error.gateTaskId, view }
        }
        return { outcome: 'cancelled', view }
      }
      // 运行期异常不写检查点，因此无法从持久化事实重建 —— 只能随本次 RunResult 返回。
      return { outcome: 'failed', error: toPipelineRunError(error).toView(), view }
    }
  }

  async reenter(input: ReenterInput, actor: ActorContext): Promise<Checkpoint> {
    assertActor(actor)
    assertSafeIdentifier(input.pipelineId, 'pipelineId')
    if (input.reason.trim() === '') throw new PipelineRunError('invalid-request', 'reenter 需要非空 reason')
    if (!STAGE_ORDER.includes(input.stageId)) {
      throw new PipelineRunError('invalid-request', `未知阶段：${input.stageId}`, { allowed: [...STAGE_ORDER] })
    }
    const { config, checkpointRoot } = await this.locate(input.pipelineId, actor)
    const current = await this.requireCheckpoint(checkpointRoot)

    // 乐观并发：页面打开过久时不得覆盖他人产生的新版本（docs/10 §5.3）。
    // digest 口径与视图一致（检查点优先，缺省回读产物），否则停在人工门时永远对不上。
    const digest = await this.digestOf(config, current.stageStates[input.stageId]!)
    if (input.expectedCurrentDigest !== undefined && digest !== input.expectedCurrentDigest) {
      throw new PipelineRunError('conflict', `阶段 ${input.stageId} 的 digest 已变化，请刷新后重试`, {
        stageId: input.stageId,
        expected: input.expectedCurrentDigest,
        actual: digest,
      })
    }

    // 只动检查点，不解析 provider：没有 API Key 的运维同学也要能登记重入（与 CLI 一致）。
    const host = createCheckpointHost({
      config,
      dataRoot: this.options.dataRoot,
      pipelineId: input.pipelineId,
      ...(this.options.signal === undefined ? {} : { signal: this.options.signal }),
    })
    return host.driver.reenter(input.stageId, actor.actorId, input.reason)
  }

  async listGateTasks(filter: GateTaskFilter, actor: ActorContext): Promise<readonly HumanGateTask[]> {
    assertActor(actor)
    assertSafeIdentifier(filter.pipelineId, 'pipelineId')
    const { store } = await this.gateStoreOf(filter.pipelineId, filter.projectId, actor)
    return store.list({
      pipelineId: filter.pipelineId,
      ...(filter.status === undefined ? {} : { status: filter.status }),
    })
  }

  async claimGate(input: GateClaimInput, actor: ActorContext): Promise<HumanGateTask> {
    assertActor(actor)
    assertGateRole(actor)
    const { store, task } = await this.requireGateTask(input, actor)
    try {
      return await store.claim(task.gateTaskId, actor.actorId, input.ttlMs ?? DEFAULT_CLAIM_TTL_MS)
    } catch (error) {
      throw toPipelineRunError(error, 'gate-not-claimable')
    }
  }

  async decideGate(input: GateDecisionInput, actor: ActorContext): Promise<HumanGateTask> {
    assertActor(actor)
    assertGateRole(actor)
    if (!GATE_DECISIONS.includes(input.action)) {
      throw new PipelineRunError('invalid-request', `未知裁决：${input.action}`, { allowed: [...GATE_DECISIONS] })
    }
    const { store, task } = await this.requireGateTask(input, actor)

    // 已消费的裁决不允许再次驱动门（docs/10 §5.3）。
    if (task.consumedAt !== undefined) {
      throw new PipelineRunError('gate-consumed', `该裁决已被消费，不能再驱动门：${task.gateTaskId}`, {
        gateTaskId: task.gateTaskId,
        consumedAt: task.consumedAt,
      })
    }
    // 乐观并发：避免覆盖他人在同一页面上完成的裁决（先于终态判定，页面过期是最有用的诊断）。
    if (input.expectedUpdatedAt !== undefined && task.updatedAt !== input.expectedUpdatedAt) {
      throw new PipelineRunError('conflict', `门任务已被更新，请刷新后重试：${task.gateTaskId}`, {
        gateTaskId: task.gateTaskId,
        expected: input.expectedUpdatedAt,
        actual: task.updatedAt,
      })
    }
    // 已终态（approved/changes-needed/rejected/expired/cancelled）不接受再次裁决。
    if (!(CLAIMABLE_STATUSES as readonly string[]).includes(task.status)) {
      throw new PipelineRunError('gate-not-decidable', `门任务已是终态，不能再次裁决：${task.status}`, {
        gateTaskId: task.gateTaskId,
        status: task.status,
      })
    }

    try {
      // decide 要求持有当前 claim；已持有则复用，否则按 CLI 既有范式认领。
      // store 在他人持有未过期租约时会抛错，因此这里不会静默抢占他人的 claim。
      const owned = task.status === 'claimed' && task.claimedBy === actor.actorId
      if (!owned) await store.claim(task.gateTaskId, actor.actorId, DEFAULT_CLAIM_TTL_MS)
      return await store.decide(task.gateTaskId, actor.actorId, input.action, input.note ?? '')
    } catch (error) {
      throw toPipelineRunError(error, 'gate-not-decidable')
    }
  }

  async cancelGate(input: GateCancelInput, actor: ActorContext): Promise<HumanGateTask> {
    assertActor(actor)
    const { store, task } = await this.requireGateTask(input, actor)
    if (store.cancel === undefined) throw new PipelineRunError('run-failed', '当前门存储不支持 cancel')
    try {
      return await store.cancel(task.gateTaskId, actor.actorId, input.note ?? '')
    } catch (error) {
      throw toPipelineRunError(error, 'gate-not-decidable')
    }
  }

  // ── 内部：索引、作用域、配置 ────────────────────────────────────────────────

  /** 解析流水线所在项目与检查点路径，并校验调用者作用域。 */
  private async locate(pipelineId: string, actor: ActorContext): Promise<{
    readonly config: PipelineConfig
    readonly checkpointRoot: string
  }> {
    const entry = await this.requireIndex(pipelineId)
    const config = await this.configOf(entry.configRef)
    // 索引与配置漂移（改配置里的 projectId 后没重建索引）在这里被拦下，而不是串到别的项目目录。
    this.assertScope(config, entry.projectId, actor)
    const roots = resolvePlatformRoots(this.options.dataRoot, config)
    return { config, checkpointRoot: join(roots.checkpointRoot, pipelineId) }
  }

  private async loadRun(pipelineId: string, actor: ActorContext): Promise<{
    readonly config: PipelineConfig
    readonly checkpoint: Checkpoint
  }> {
    const { config, checkpointRoot } = await this.locate(pipelineId, actor)
    return { config, checkpoint: await this.requireCheckpoint(checkpointRoot) }
  }

  private async configOf(configRef: string): Promise<PipelineConfig> {
    const cached = this.configCache.get(configRef)
    if (cached !== undefined) return cached
    let config: PipelineConfig
    try {
      config = await this.loadConfig(configRef)
      // 引用未实现规则时立即失败，避免配置与运行时静默漂移（与 CLI validate 同口径）。
      buildGateEngine(config)
      const acl = validatePipelineAcl(config)
      if (!acl.ok) throw new Error(`ACL 非法：${acl.errors.join('; ')}`)
    } catch (error) {
      throw toPipelineRunError(error, 'config-invalid')
    }
    this.configCache.set(configRef, config)
    return config
  }

  /** 配置声明的租户/项目/环境必须与调用者一致（跨项目读取在此被拒）。 */
  private assertScope(config: PipelineConfig, projectId: string, actor: ActorContext): void {
    assertProjectAllowed(actor, projectId)
    try {
      assertScopeMatch(
        {
          projectId: config.projectId,
          ...(config.scope?.tenantId === undefined ? {} : { tenantId: config.scope.tenantId }),
          ...(config.scope?.environment === undefined ? {} : { environment: config.scope.environment }),
        },
        { projectId, ...(actor.tenantId === undefined ? {} : { tenantId: actor.tenantId }) },
      )
    } catch (error) {
      throw toPipelineRunError(error, 'scope-mismatch')
    }
  }

  private hostOptions(config: PipelineConfig, pipelineId: string): PlatformHostOptions {
    const gateTaskTtlMs = this.options.defaultGateTaskTtlMs
    return {
      config,
      dataRoot: this.options.dataRoot,
      pipelineId,
      // 缺省 0：HTTP handler 不在请求内挂住等真人裁决（docs/10 §5.4）。
      gateWaitTimeoutMs: this.options.defaultGateWaitTimeoutMs ?? 0,
      ...(gateTaskTtlMs === undefined ? {} : { gateTaskTtlMs }),
      ...(this.options.signal === undefined ? {} : { signal: this.options.signal }),
    }
  }

  /** 门任务存储：路径经 `gateTaskStoreDir` 统一生成（docs/10 §4.3）。 */
  private async gateStoreOf(pipelineId: string, projectId: string, actor: ActorContext): Promise<{
    readonly store: FileHumanGateTaskStore
    readonly config: PipelineConfig
  }> {
    const { config } = await this.locate(pipelineId, actor)
    if (config.projectId !== projectId) {
      throw new PipelineRunError('scope-mismatch', `项目不匹配：期望 ${config.projectId}，收到 ${projectId}`, {
        expected: config.projectId,
        actual: projectId,
      })
    }
    const roots = resolvePlatformRoots(this.options.dataRoot, config)
    return { store: new FileHumanGateTaskStore(gateTaskStoreDir(roots.projectRoot)), config }
  }

  /** 读取门任务并校验它确实属于给定项目/流水线（防止跨流水线裁决）。 */
  private async requireGateTask(
    input: { readonly projectId: string; readonly pipelineId: string; readonly gateTaskId: string },
    actor: ActorContext,
  ): Promise<{ readonly store: FileHumanGateTaskStore; readonly task: HumanGateTask }> {
    assertSafeIdentifier(input.pipelineId, 'pipelineId')
    assertSafeIdentifier(input.gateTaskId, 'gateTaskId')
    const { store } = await this.gateStoreOf(input.pipelineId, input.projectId, actor)
    const task = await store.get(input.gateTaskId)
    if (task === null) throw new PipelineRunError('not-found', `门任务不存在：${input.gateTaskId}`, { gateTaskId: input.gateTaskId })
    if (task.pipelineId !== input.pipelineId || task.projectId !== input.projectId) {
      throw new PipelineRunError('scope-mismatch', `门任务不属于该流水线：${input.gateTaskId}`, {
        gateTaskId: input.gateTaskId,
        expectedPipeline: input.pipelineId,
        actualPipeline: task.pipelineId,
      })
    }
    return { store, task }
  }

  private async requireCheckpoint(checkpointRoot: string): Promise<Checkpoint> {
    const checkpoint = await loadCheckpoint(checkpointRoot)
    if (checkpoint === null) throw new PipelineRunError('not-found', '流水线不存在', { checkpointRoot })
    return checkpoint
  }

  // ── 内部：流水线索引（pipelineId → 作用域 + 配置引用）────────────────────────

  private async requireIndex(pipelineId: string): Promise<PipelineIndexEntry> {
    const entry = await this.readIndex(pipelineId)
    if (entry === null) {
      throw new PipelineRunError('not-found', `未登记的 pipeline：${pipelineId}`, { pipelineId })
    }
    return entry
  }

  private async readIndex(pipelineId: string): Promise<PipelineIndexEntry | null> {
    try {
      return JSON.parse(await readFile(join(pipelineIndexDir(this.options.dataRoot), `${pipelineId}.json`), 'utf8')) as PipelineIndexEntry
    } catch (error) {
      if (isMissingFile(error)) return null
      throw error
    }
  }

  /** 原子写（tmp → rename），与检查点同一口径：任何时刻磁盘上要么是旧版要么是新版。 */
  private async writeIndex(entry: PipelineIndexEntry): Promise<void> {
    const dir = pipelineIndexDir(this.options.dataRoot)
    await mkdir(dir, { recursive: true })
    const target = join(dir, `${entry.pipelineId}.json`)
    const tmp = `${target}.tmp`
    await writeFile(tmp, `${JSON.stringify(entry, null, 2)}\n`, 'utf8')
    await rename(tmp, target)
  }

  // ── 内部：视图重建（docs/10 §4.2 M0-3「必须能从 checkpoint/artifact store 重建页面状态」）──

  private async buildView(config: PipelineConfig, checkpoint: Checkpoint): Promise<PipelineRunView> {
    const roots = resolvePlatformRoots(this.options.dataRoot, config)
    const artifacts = new FsArtifactStore(roots.artifactsRoot)
    const store = new FileHumanGateTaskStore(gateTaskStoreDir(roots.projectRoot))
    const tasks = await store.list({ pipelineId: checkpoint.pipelineId })
    const status = deriveRunStatus(checkpoint, tasks)

    const stages = await Promise.all(STAGE_ORDER.map(async stageId => {
      const state = checkpoint.stageStates[stageId]!
      return buildStageView(stageId, state, stageTaskOf(tasks, stageId), await effectiveDigest(artifacts, state))
    }))

    return {
      pipelineId: checkpoint.pipelineId,
      tenantId: config.scope?.tenantId ?? null,
      projectId: config.projectId,
      status,
      cursor: checkpoint.cursor,
      nextStage: STAGE_ORDER[checkpoint.cursor] ?? null,
      templateVersion: checkpoint.templateVersion,
      rulesetVersion: checkpoint.rulesetVersion,
      stages,
      openGateTaskId: tasks.find(task => task.status === 'pending' || task.status === 'claimed')?.gateTaskId ?? null,
      reentries: checkpoint.reentries,
      failure: deriveRunFailure(status, checkpoint, tasks),
    }
  }

  /** 当前生效的阶段摘要：检查点值优先，缺失时回读产物文件（见 `effectiveDigest`）。 */
  private async digestOf(config: PipelineConfig, state: StageState): Promise<string> {
    return effectiveDigest(new FsArtifactStore(resolvePlatformRoots(this.options.dataRoot, config).artifactsRoot), state)
  }
}

// ── 视图推导（纯函数，便于单测）──────────────────────────────────────────────

/** 该阶段最近一条**阶段门**任务（排除 `gateFailed` 升级任务：它们 artifactPath 为空）。 */
function stageTaskOf(tasks: readonly HumanGateTask[], stageId: StageId): HumanGateTask | undefined {
  return tasks
    .filter(task => task.stageId === stageId && task.artifactPath !== '')
    .sort((a, b) => b.createdAt - a.createdAt)[0]
}

/**
 * 从检查点与门任务推导 Web 状态（映射表见 `PipelineRunStatus` 的文档注释）。
 *
 * `failed` 不会由本函数产生：运行期异常不写检查点，因此无法从持久化事实重建；
 * 它只出现在 `RunResult.outcome === 'failed'` 中（M3 遥测落地后由失败事件补齐）。
 */
export function deriveRunStatus(checkpoint: Checkpoint, tasks: readonly HumanGateTask[]): PipelineRunStatus {
  const states = STAGE_ORDER.map(id => checkpoint.stageStates[id]!)

  if (checkpoint.cursor >= STAGE_ORDER.length && states.every(state => state.status === 'done')) return 'completed'

  const awaiting = STAGE_ORDER.find(id => checkpoint.stageStates[id]!.status === 'awaiting-gate')
  if (awaiting !== undefined) {
    const task = stageTaskOf(tasks, awaiting)
    if (task?.status === 'rejected') return 'rejected'
    if (task?.status === 'cancelled') return 'cancelled'
    return 'waiting-human'
  }

  if (states.some(state => state.status === 'gate-failed')) return 'gate-failed'
  if (states.some(state => state.status === 'needs-fix')) return 'needs-fix'
  if (states.some(state => state.status === 'needs-reentry')) return 'running'
  if (states.some(state => state.status === 'running' || state.status === 'produced')) return 'running'
  if (checkpoint.cursor === 0 && states.every(state => state.status === 'idle')) return 'queued'
  return 'running'
}

function deriveRunFailure(
  status: PipelineRunStatus,
  checkpoint: Checkpoint,
  tasks: readonly HumanGateTask[],
): PipelineRunFailure | null {
  if (status === 'gate-failed') {
    const stageId = STAGE_ORDER.find(id => checkpoint.stageStates[id]!.status === 'gate-failed')
    if (stageId === undefined) return null
    const violations = checkpoint.stageStates[stageId]!.gate.machine.violations
    return { kind: 'gate-failed', stageId, detail: violations.map(v => `[${v.level}] ${v.rule}: ${v.detail}`).join('\n') }
  }
  if (status === 'rejected' || status === 'cancelled') {
    const stageId = STAGE_ORDER.find(id => checkpoint.stageStates[id]!.status === 'awaiting-gate')
    if (stageId === undefined) return null
    const task = stageTaskOf(tasks, stageId)
    const detail = status === 'rejected' ? task?.decision?.note ?? '' : task?.cancellation?.note ?? ''
    return { kind: status, stageId, detail }
  }
  if (status === 'needs-fix') {
    const stageId = STAGE_ORDER.find(id => checkpoint.stageStates[id]!.status === 'needs-fix')
    if (stageId === undefined) return null
    const last = lastFailureOf(checkpoint.stageStates[stageId]!)
    if (last === undefined || last.kind !== 'review-fail') return null
    return { kind: 'review-failed', stageId, detail: last.detail ?? '' }
  }
  return null
}

function lastFailureOf(state: StageState): StageState['failures'][number] | undefined {
  return state.failures[state.failures.length - 1]
}

/**
 * 阶段当前生效的产物摘要。
 *
 * 检查点只在阶段推进到 `done` 时才持久化 digest，因此阶段停在人工门期间
 * `StageState.digest` 仍是空串。此时按 docs/10 §4.2 M0-3「必须能从
 * checkpoint/**artifact store** 重建页面状态」回读产物文件取摘要。
 *
 * 两种状态不回读：
 * - `idle`：还没产出过，磁盘上若有文件也只可能是更早周期的残留；
 * - `needs-reentry`：重入已判定旧产物作废（driver 会把它归档进 history），
 *   把旧文件摘要当作"当前版本"会误导页面与 `expectedCurrentDigest` 校验。
 */
async function effectiveDigest(artifacts: ArtifactStore, state: StageState): Promise<string> {
  if (state.digest !== '') return state.digest
  if (state.status === 'idle' || state.status === 'needs-reentry') return ''
  try {
    return (await artifacts.read(state.artifact))?.digest ?? ''
  } catch {
    // 产物损坏：保持空摘要，交由机器门禁在下次运行时报 R-ARTIFACT-READABLE。
    return ''
  }
}

function buildStageView(stageId: StageId, state: StageState, task: HumanGateTask | undefined, digest: string): StageView {
  const last = lastFailureOf(state)
  return {
    stageId,
    status: state.status,
    artifactPath: state.artifact,
    digest,
    machineStatus: state.gate.machine.status,
    machineViolations: state.gate.machine.violations.map(v => ({ rule: v.rule, level: v.level, detail: v.detail })),
    reviewVerdict: task?.review?.verdict ?? null,
    reviewFindings: task?.review?.findings ?? [],
    humanGateTaskId: task?.gateTaskId ?? null,
    // 无人工门任务时返回 null，而不是用服务端当前时间冒充阶段时间（不伪装）。
    startedAt: task?.createdAt ?? null,
    finishedAt: task?.decision?.at ?? task?.cancellation?.at ?? null,
    failure: last === undefined ? null : { kind: last.kind, rule: last.rule ?? null, detail: last.detail ?? null, at: last.at },
  }
}

// ── 校验辅助 ─────────────────────────────────────────────────────────────────

function assertActor(actor: ActorContext): void {
  if (actor.actorId.trim() === '') throw new PipelineRunError('unauthenticated', 'actorId 必填')
}

/** 人工门裁决需要 reviewer/admin；**失败关闭**——未声明角色即拒绝。 */
function assertGateRole(actor: ActorContext): void {
  const roles = actor.roles ?? []
  if (!roles.some(role => (GATE_ROLES as readonly string[]).includes(role))) {
    throw new PipelineRunError('forbidden', '人工门裁决需要 reviewer 或 admin 角色', {
      actorId: actor.actorId,
      required: [...GATE_ROLES],
    })
  }
}

function assertProjectAllowed(actor: ActorContext, projectId: string): void {
  if (actor.projectIds === undefined) return
  if (!actor.projectIds.includes(projectId)) {
    throw new PipelineRunError('forbidden', `调用者无权访问项目：${projectId}`, { actorId: actor.actorId, projectId })
  }
}

function assertSafeIdentifier(value: string, field: string): void {
  if (!SAFE_IDENTIFIER.test(value)) {
    throw new PipelineRunError('invalid-request', `${field} 必须是安全标识符（${SAFE_IDENTIFIER.source}）`, { field, value })
  }
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && 'code' in error && (error as { code?: string }).code === 'ENOENT'
}

/**
 * `targetBaseUrl` 的静态 SSRF 校验（docs/10 §5.3「不能默认访问本机和内网」）。
 *
 * 只做**字面量**判定：拒绝本机名、`.internal`/`.local`、回环/私有/链路本地/CGNAT 地址，
 * 以及非 http(s) 协议。不做 DNS 解析，因此无法防止 DNS rebinding —— executor 侧在
 * 建立连接时仍须复核实际对端地址。
 */
export function assertTargetBaseUrlAllowed(rawUrl: string): void {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    throw new PipelineRunError('invalid-request', `targetBaseUrl 不是合法 URL：${rawUrl}`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new PipelineRunError('invalid-request', `targetBaseUrl 只允许 http/https：${rawUrl}`, { protocol: url.protocol })
  }
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal') || host.endsWith('.local')) {
    throw new PipelineRunError('forbidden', `targetBaseUrl 不允许指向本机/内网：${rawUrl}`, { host })
  }
  if (isPrivateAddress(host)) {
    throw new PipelineRunError('forbidden', `targetBaseUrl 不允许指向私有地址：${rawUrl}`, { host })
  }
}

function isPrivateAddress(host: string): boolean {
  if (host === '::1' || host === '::' || host === '0.0.0.0') return true
  // IPv6 唯一本地地址 fc00::/7 与链路本地 fe80::/10
  if (/^f[cd][0-9a-f]{2}:/i.test(host) || /^fe[89ab][0-9a-f]:/i.test(host)) return true
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host)
  if (match === null) return false
  const [a, b] = [Number(match[1]), Number(match[2])]
  if (a === 0 || a === 10 || a === 127) return true
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 192 && b === 168) return true
  if (a === 169 && b === 254) return true
  if (a === 100 && b >= 64 && b <= 127) return true
  return false
}
