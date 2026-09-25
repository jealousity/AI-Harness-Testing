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
 * - 外部存储后端（PostgreSQL / object store）→ M4 / P1-B；
 * - 后台调度与进程内运行句柄 → M1 的 `async-runner.ts` / `pipeline-run-registry.ts`。
 *
 * 幂等（docs/10 §6.3 M2-3）：`create` 与 `decideGate` 走 `idempotency.ts` 的台账；
 * 运行锁在 `run`/`reenter` 内落地（`checkpoint-lock.ts`）。
 * 用量与预算（docs/10 §7.3 M3）：`getUsage` 读 `usage.ts` 的持久化日志，
 * 预算强制在运行器 / driver 内存里完成（不依赖日志写盘成功）。
 *
 * @module platform-pipeline/web/pipeline-run-service
 */

import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { validatePipelineAcl } from '../acl.ts'
import { initialCheckpoint, loadCheckpoint } from '../checkpoint.ts'
import {
  acquirePipelineLock,
  fileLockAudit,
  lockAuditPath,
  PipelineLockHeldError,
  type PipelineLock,
} from '../checkpoint-lock.ts'
import { loadPipelineConfig } from '../config.ts'
import {
  IDEMPOTENCY_NAMESPACES,
  IdempotencyConflictError,
  fileIdempotencyLedger,
  idempotencyDir,
  idempotencyFingerprint,
  idempotencyKey,
  type IdempotencyLedger,
} from '../idempotency.ts'
import { resolvePlatformRoots, type PlatformStorageRoots } from '../platform-roots.ts'
import { assertScopeMatch } from '../platform-scope.ts'
import { FsArtifactStore, FsCheckpointPort } from '../stores/fs.ts'
import {
  budgetFailuresOf,
  fileUsageStore,
  retryFactsOf,
  summarizeUsage,
  usageDir,
  type UsageSummary,
} from '../usage.ts'
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
  errorMessageOf,
  toPipelineRunError,
  type ActorContext,
  type CreatePipelineRunInput,
  type GateCancelInput,
  type GateClaimInput,
  type GateDecisionInput,
  type GateTaskFilter,
  type PipelineEventKind,
  type PipelineEventView,
  type PipelineRunFailure,
  type PipelineRunStatus,
  type PipelineRunSummary,
  type PipelineRunView,
  type ReenterInput,
  type RunResult,
  type StageArtifactView,
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
  /**
   * 运行锁的 stale 上限（毫秒）。缺省 6 小时——与 CLI / Harness 一致。
   *
   * 判断依据是锁的 `heartbeatAt` 而不是取得时间，因此**长跑流水线不会被误抢**：
   * 锁会按 `staleMs / 3` 自动续租。只有"进程被杀、心跳停摆"才会超过这个上限。
   */
  readonly lockStaleMs?: number
}

/** `run()` 的每次调用选项。 */
export interface RunCallOptions {
  /**
   * 本次运行的取消信号（由 `PipelineRunRegistry` 的句柄提供）。
   *
   * 与 service 构造参数 `signal` 是**并列**关系：任一中止即中止本次运行
   * （用 `AbortSignal.any` 合并）。这样"取消某一条流水线的后台运行"不会
   * 连带取消同一 service 实例上其他流水线的运行。
   */
  readonly signal?: AbortSignal
}

/**
 * 合并多个取消信号；全部缺省时返回 `undefined`（而不是造一个永不中止的信号，
 * 避免下游把它当成"宿主声明了不会取消"）。
 */
export function combineSignals(...signals: readonly (AbortSignal | undefined)[]): AbortSignal | undefined {
  const present = signals.filter((signal): signal is AbortSignal => signal !== undefined)
  if (present.length === 0) return undefined
  if (present.length === 1) return present[0]
  return AbortSignal.any(present)
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
  /**
   * 枚举**当前调用者可见且可读取**的流水线（docs/10 §5.4 第 7 步的恢复扫描、
   * §5.3 查询接口的列表页）。
   *
   * 只返回作用域内且配置可解析的项：作用域外的 pipelineId 不返回（不泄露他人
   * 标识），索引/配置损坏的项也不返回（不用半成品状态冒充成功）。恢复扫描需要
   * 把损坏项**报告**出来，因此它直接用 {@link scanPipelineIndex}，不走本方法。
   */
  list(actor: ActorContext): Promise<readonly PipelineRunSummary[]>
  run(pipelineId: string, actor: ActorContext, options?: RunCallOptions): Promise<RunResult>
  /**
   * 回读某阶段的产物文件（`GET /api/pipelines/:pipelineId/stages/:stageId/artifact`）。
   *
   * 返回 `null` 表示该阶段尚未产出（`StageState.artifact` 为空）或产物文件已不存在；
   * 两种情况都不编造空产物。
   */
  getStageArtifact(pipelineId: string, stageId: StageId, actor: ActorContext): Promise<StageArtifactView | null>
  /**
   * 流水线事件时间线（`GET /api/pipelines/:pipelineId/events`）。
   *
   * 只投影**有持久化时间戳**的事实（见 `PipelineEventKind`），按时间升序返回。
   * 不生成"服务器看到请求的时刻"这类非事实事件。
   */
  listEvents(pipelineId: string, actor: ActorContext): Promise<readonly PipelineEventView[]>
  /**
   * 用量与预算查询（`GET /api/pipelines/:pipelineId/usage`，docs/10 §7.3）。
   *
   * 事实来源是**持久化用量日志**（`<projectRoot>/usage/<pipelineId>.jsonl`）加检查点里的
   * 重试事实，因此同一份数据在 Web、CLI、重启后读出的 `used/limit/exceeded` 完全一致。
   * 作用域校验与 `get` 同源：查不到他人项目的用量。
   */
  getUsage(pipelineId: string, actor: ActorContext): Promise<UsageSummary>
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

/**
 * 索引扫描结果。
 *
 * `unreadable` 必须显式返回而不是静默跳过：恢复扫描（docs/10 §5.4 第 7 步）要能
 * 报告"这条流水线因索引损坏而无法恢复"，否则运维会以为全部恢复了。
 */
export interface PipelineIndexScan {
  readonly entries: readonly PipelineIndexEntry[]
  readonly unreadable: readonly { readonly file: string; readonly reason: string }[]
}

/**
 * 扫描全部流水线索引项（按 `pipelineId` 排序，保证恢复顺序确定）。
 *
 * 索引目录不存在 = 尚无任何流水线，返回空结果而不是报错。
 * 单个索引文件损坏只影响它自己，不会让整次扫描失败。
 */
export async function scanPipelineIndex(dataRoot: string): Promise<PipelineIndexScan> {
  const dir = pipelineIndexDir(dataRoot)
  let names: string[]
  try {
    names = await readdir(dir)
  } catch (error) {
    if (isMissingFile(error)) return { entries: [], unreadable: [] }
    throw error
  }

  const entries: PipelineIndexEntry[] = []
  const unreadable: { file: string; reason: string }[] = []
  for (const name of names.filter(candidate => candidate.endsWith('.json')).sort()) {
    try {
      const parsed = JSON.parse(await readFile(join(dir, name), 'utf8')) as unknown
      if (!isIndexEntry(parsed)) throw new Error('索引字段缺失或类型不符')
      // 文件名才是权威键（readIndex 按文件名读取）；两者不一致说明索引被改写坏了。
      const expected = name.replace(/\.json$/, '')
      if (parsed.pipelineId !== expected) {
        throw new Error(`索引 pipelineId 与文件名不一致：${parsed.pipelineId} ≠ ${expected}`)
      }
      entries.push(parsed)
    } catch (error) {
      unreadable.push({ file: name, reason: errorMessageOf(error) })
    }
  }
  return { entries, unreadable }
}

function isIndexEntry(value: unknown): value is PipelineIndexEntry {
  if (value === null || typeof value !== 'object') return false
  const candidate = value as Record<string, unknown>
  return typeof candidate.pipelineId === 'string' && candidate.pipelineId !== ''
    && typeof candidate.projectId === 'string' && candidate.projectId !== ''
    && typeof candidate.configRef === 'string' && candidate.configRef !== ''
    && (candidate.tenantId === null || typeof candidate.tenantId === 'string')
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
    const rulesetVersion = input.rulesetVersion ?? DEFAULT_RULESET_VERSION
    const namespace = IDEMPOTENCY_NAMESPACES.pipelineCreate
    // 键字段 = docs/10 §6.3 的 `tenantId/projectId/pipelineId`。
    return this.runIdempotent(
      roots.projectRoot,
      namespace,
      idempotencyKey(namespace, [config.scope?.tenantId ?? '', config.projectId, input.pipelineId]),
      // 指纹只覆盖 create 真正落盘的字段：请求体里的 `targetBaseUrl`/`maxGateRetries` 等
      // 创建时不读取，把它们算进指纹只会让"改了不影响创建结果的字段"的重试误报冲突。
      idempotencyFingerprint(namespace, [config.projectId, input.pipelineId, input.configRef, rulesetVersion]),
      () => this.createOnce(input, config, roots, rulesetVersion),
    )
  }

  /**
   * 首次创建（幂等台账未命中时执行）。
   *
   * 幂等语义：同一 `(tenantId, projectId, pipelineId)` 且请求内容一致的重复投递返回
   * **首次的 summary**，不再报 409——这是 §6.4「重试不产生副作用」要的行为。真正
   * 换了内容（如另一个 `configRef`）的请求由指纹比对拦成 `conflict`，因此
   * §5.3 的「绝不静默复用」仍然成立：静默复用的只是**同一个**请求。
   */
  private async createOnce(
    input: CreatePipelineRunInput,
    config: PipelineConfig,
    roots: PlatformStorageRoots,
    rulesetVersion: string,
  ): Promise<PipelineRunSummary> {
    const checkpointRoot = join(roots.checkpointRoot, input.pipelineId)
    const checkpoint = new FsCheckpointPort()

    // pipelineId 在租户/项目作用域内唯一（docs/10 §5.3）：已存在即冲突，绝不静默复用。
    // 走到这里说明台账里没有本次请求的记录，磁盘上的同 id 流水线是别人/旧版本建的。
    if (await this.readIndex(input.pipelineId) !== null) {
      throw new PipelineRunError('conflict', `pipeline 已存在：${input.pipelineId}`, { pipelineId: input.pipelineId })
    }
    // 先落盘后返回（docs/10 §1 原则 5）：创建成功 = 磁盘上已有可恢复的初始检查点。
    await checkpoint.save(checkpointRoot, initialCheckpoint(input.pipelineId, config.templateVersion, rulesetVersion))
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

  async list(actor: ActorContext): Promise<readonly PipelineRunSummary[]> {
    assertActor(actor)
    const scan = await scanPipelineIndex(this.options.dataRoot)
    const summaries: PipelineRunSummary[] = []
    for (const entry of scan.entries) {
      try {
        // loadRun 内含作用域校验：作用域外会抛 scope-mismatch/forbidden，直接跳过。
        const { config, checkpoint } = await this.loadRun(entry.pipelineId, actor)
        const view = await this.buildView(config, checkpoint)
        summaries.push({
          pipelineId: view.pipelineId,
          tenantId: view.tenantId,
          projectId: view.projectId,
          configRef: entry.configRef,
          status: view.status,
          nextStage: view.nextStage,
        })
      } catch {
        // 不返回：作用域外的项不泄露标识；配置损坏的项不用半成品状态冒充成功。
        // 恢复扫描需要报告这类项，因此它直接用 scanPipelineIndex() 并记录 unreadable。
        continue
      }
    }
    return summaries.sort((a, b) => (a.pipelineId < b.pipelineId ? -1 : a.pipelineId > b.pipelineId ? 1 : 0))
  }

  async getStageArtifact(pipelineId: string, stageId: StageId, actor: ActorContext): Promise<StageArtifactView | null> {
    assertActor(actor)
    assertSafeIdentifier(pipelineId, 'pipelineId')
    if (!STAGE_ORDER.includes(stageId)) {
      throw new PipelineRunError('invalid-request', `未知阶段：${stageId}`, { allowed: [...STAGE_ORDER] })
    }
    const { config, checkpoint } = await this.loadRun(pipelineId, actor)
    const state = checkpoint.stageStates[stageId]!
    // 尚未产出（idle 或产物已被重入归档）时返回 null，不编造空产物。
    if (state.artifact === '') return null

    const roots = resolvePlatformRoots(this.options.dataRoot, config)
    const artifact = await new FsArtifactStore(roots.artifactsRoot).read(state.artifact)
    if (artifact === null) return null
    return {
      pipelineId,
      stageId,
      artifactPath: artifact.path,
      digest: artifact.digest,
      version: artifact.version,
      inputs: artifact.inputs,
      content: artifact.content,
    }
  }

  async listEvents(pipelineId: string, actor: ActorContext): Promise<readonly PipelineEventView[]> {
    assertActor(actor)
    assertSafeIdentifier(pipelineId, 'pipelineId')
    const { config, checkpoint } = await this.loadRun(pipelineId, actor)
    const roots = resolvePlatformRoots(this.options.dataRoot, config)
    const tasks = await new FileHumanGateTaskStore(gateTaskStoreDir(roots.projectRoot)).list({ pipelineId })
    return buildEventTimeline(checkpoint, tasks)
  }

  /**
   * 用量与预算查询（docs/10 §7.3「预算超限可在 Web/CLI 查询」）。
   *
   * 读的是**磁盘上的用量日志**而不是进程内存：这条流水线可能是别的进程（CLI / 另一个
   * Web 实例 / 重启前的自己）跑的，只有日志是共同事实。
   *
   * 日志缺失 = 尚无用量记录（不是错误），此时各阶段 `used` 全为 0，
   * 而 `budget` 仍然如实回显——页面能区分"没跑过"与"跑过但没超限"。
   */
  async getUsage(pipelineId: string, actor: ActorContext): Promise<UsageSummary> {
    assertActor(actor)
    assertSafeIdentifier(pipelineId, 'pipelineId')
    const { config, checkpoint } = await this.loadRun(pipelineId, actor)
    const roots = resolvePlatformRoots(this.options.dataRoot, config)
    const read = await fileUsageStore(usageDir(roots.projectRoot)).read(pipelineId)
    return summarizeUsage(read.events, {
      pipelineId,
      budgetOf: stageId => config.stages[stageId]!.budget,
      retriesOf: stageId => retryFactsOf(checkpoint.stageStates[stageId]!),
      budgetFailuresOf: stageId => budgetFailuresOf(checkpoint.stageStates[stageId]!),
      skippedLines: read.skipped.length,
    })
  }

  async run(pipelineId: string, actor: ActorContext, options: RunCallOptions = {}): Promise<RunResult> {
    assertActor(actor)
    assertSafeIdentifier(pipelineId, 'pipelineId')
    const { config, checkpointRoot, checkpointBase } = await this.locate(pipelineId, actor)
    await this.requireCheckpoint(checkpointRoot)

    // 运行互斥（§6.3 M2-2）：锁覆盖 load checkpoint → 阶段产物生成 → 门禁/审核/人工门
    // 推进 → checkpoint save。**不含**人工门"阻塞等待"之后的续写——见下面的说明。
    const lock = await this.acquireRunLock(checkpointBase, pipelineId)
    try {
      const host = this.createHost(this.hostOptions(config, pipelineId, options.signal))

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
    } finally {
      // §6.3 M2-2「人工门等待期间可以释放运行锁，但必须保留 awaiting-gate checkpoint 和
      // pending task。裁决后的下一次运行重新 acquire」：让出控制权（waiting-human /
      // cancelled / failed）时这里就释放，`awaiting-gate` 与 pending task 都是持久化事实，
      // 不受影响；下一次 run 会重新 acquire。
      //
      // 反过来，**阻塞等待中（`--wait-ms > 0`）刻意不释放**：那种情况下本进程稍后还要
      // 继续推进并写检查点，而同节又要求 checkpoint save 在锁内。中途放手会让另一个进程
      // 同时写同一份检查点——比"多占一会儿锁"危险得多。长时间阻塞靠自动续租（心跳）
      // 保证不被误判 stale。
      await lock.release()
    }
  }

  async reenter(input: ReenterInput, actor: ActorContext): Promise<Checkpoint> {
    assertActor(actor)
    assertSafeIdentifier(input.pipelineId, 'pipelineId')
    if (input.reason.trim() === '') throw new PipelineRunError('invalid-request', 'reenter 需要非空 reason')
    if (!STAGE_ORDER.includes(input.stageId)) {
      throw new PipelineRunError('invalid-request', `未知阶段：${input.stageId}`, { allowed: [...STAGE_ORDER] })
    }
    const { config, checkpointRoot, checkpointBase } = await this.locate(input.pipelineId, actor)
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

    // 重入会写检查点（cursor 回退 + 下游标 needs-reentry），因此与 run 抢同一把锁。
    const lock = await this.acquireRunLock(checkpointBase, input.pipelineId)
    try {
      // 只动检查点，不解析 provider：没有 API Key 的运维同学也要能登记重入（与 CLI 一致）。
      const host = createCheckpointHost({
        config,
        dataRoot: this.options.dataRoot,
        pipelineId: input.pipelineId,
        ...(this.options.signal === undefined ? {} : { signal: this.options.signal }),
      })
      return await host.driver.reenter(input.stageId, actor.actorId, input.reason)
    } finally {
      await lock.release()
    }
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
    // 动作语义校验前置：`changes-needed` / `rejected` 必须带非空 note。
    // store 层也强制这条规则，但那里抛的是普通 `Error`，会被下面的 catch 归成
    // `gate-not-decidable`（409）——把「请求不合法」误报成「门不可裁决」，与
    // 「未知裁决 → 400」自相矛盾。这里先按 `invalid-request` 拒绝，并且**在
    // claim 之前**返回，因此失败的请求不会留下任何租约副作用。
    if (input.action !== 'approved' && (input.note ?? '').trim() === '') {
      throw new PipelineRunError('invalid-request', `${input.action} 必须带非空 note`, { action: input.action })
    }
    if (input.decisionId !== undefined) assertSafeIdentifier(input.decisionId, 'decisionId')
    const { store, task, projectRoot } = await this.requireGateTask(input, actor)

    // 缺省不带 decisionId = 不启用幂等：行为与 M2 之前逐字一致（终态 → gate-not-decidable，
    // 已消费 → gate-consumed）。带上它以后，同一个 (gateTaskId, decisionId) 的重复投递
    // 会重放首次裁决结果（§6.4「同一 gate decision 重试不会重复消费」）。
    if (input.decisionId === undefined) return this.decideOnce(store, task, input, actor)

    const namespace = IDEMPOTENCY_NAMESPACES.gateDecision
    return this.runIdempotent(
      projectRoot,
      namespace,
      idempotencyKey(namespace, [task.gateTaskId, input.decisionId]),
      idempotencyFingerprint(namespace, [input.pipelineId, task.gateTaskId, input.action, input.note ?? '', actor.actorId]),
      () => this.decideOnce(store, task, input, actor),
    )
  }

  /**
   * 真正的裁决（幂等层之下）。
   *
   * 终态、`consumedAt` 与乐观并发校验都放在这里而不是 `decideGate` 的入口：
   * 重复投递**必须能走到幂等台账**才能被重放，若在入口就按「已消费」拒掉，
   * 重试永远拿不到首次结果（§6.4 的反面）。
   */
  private async decideOnce(
    store: FileHumanGateTaskStore,
    task: HumanGateTask,
    input: GateDecisionInput,
    actor: ActorContext,
  ): Promise<HumanGateTask> {
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
    /** checkpoints 根（不含 pipelineId）：锁路径由它与 pipelineId 一起拼出。 */
    readonly checkpointBase: string
  }> {
    const entry = await this.requireIndex(pipelineId)
    const config = await this.configOf(entry.configRef)
    // 索引与配置漂移（改配置里的 projectId 后没重建索引）在这里被拦下，而不是串到别的项目目录。
    this.assertScope(config, entry.projectId, actor)
    const roots = resolvePlatformRoots(this.options.dataRoot, config)
    return { config, checkpointRoot: join(roots.checkpointRoot, pipelineId), checkpointBase: roots.checkpointRoot }
  }

  /**
   * 取得该流水线的运行锁（docs/10 §6.3 M2-1/M2-2）。
   *
   * 锁路径由 {@link pipelineLockPath} 统一算出，与 CLI / Harness 完全一致——此前 Web 与
   * Harness 传的基准目录不同（一个是 per-pipeline 目录、一个是 checkpoints 根），拼出的
   * 锁路径不一样，等于没锁（§6.2 第 5 条）。
   *
   * 抢不到锁时抛 `conflict`(409) 而不是 500：这是"别人正在跑"，不是服务故障。
   */
  private async acquireRunLock(checkpointBase: string, pipelineId: string): Promise<PipelineLock> {
    try {
      return await acquirePipelineLock(checkpointBase, pipelineId, {
        audit: fileLockAudit(lockAuditPath(checkpointBase)),
        ...(this.options.lockStaleMs === undefined ? {} : { staleMs: this.options.lockStaleMs }),
      })
    } catch (error) {
      if (error instanceof PipelineLockHeldError) {
        throw new PipelineRunError('conflict', error.message, {
          pipelineId,
          lockPath: error.lockPath,
          holder: error.holder === null ? null : {
            ownerId: error.holder.ownerId,
            generation: error.holder.generation,
            pid: error.holder.pid,
            host: error.holder.host,
            heartbeatAt: error.holder.heartbeatAt,
          },
        })
      }
      throw error
    }
  }

  private async loadRun(pipelineId: string, actor: ActorContext): Promise<{
    readonly config: PipelineConfig
    readonly checkpoint: Checkpoint
  }> {
    const { config, checkpointRoot } = await this.locate(pipelineId, actor)
    return { config, checkpoint: await this.requireCheckpoint(checkpointRoot) }
  }

  /**
   * 幂等执行（docs/10 §6.3 M2-3）。
   *
   * 台账按**项目**共享（`idempotencyDir(projectRoot)`），命名空间区分子目录，
   * 因此 Web、CLI 与运行时工具看到的是同一份台账——各自拼路径会让幂等静默失效，
   * 和锁路径分裂是同一类错误（§6.2 第 5 条）。
   *
   * `IdempotencyConflictError` → `conflict`(409)：同一把键上出现了不同内容的请求，
   * 属于调用方错误，不是服务故障。
   */
  private async runIdempotent<T>(
    projectRoot: string,
    namespace: string,
    key: string,
    fingerprint: string,
    produce: () => Promise<T>,
  ): Promise<T> {
    const ledger: IdempotencyLedger = fileIdempotencyLedger(idempotencyDir(projectRoot))
    try {
      return (await ledger.run({ namespace, key, fingerprint, produce })).result
    } catch (error) {
      if (error instanceof IdempotencyConflictError) {
        throw new PipelineRunError('conflict', error.message, {
          namespace: error.namespace,
          key: error.key,
          recordedFingerprint: error.recordedFingerprint,
          requestedFingerprint: error.requestedFingerprint,
        })
      }
      throw error
    }
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

  /** 配置声明的租户/项目必须与调用者一致（跨项目读取在此被拒）。 */
  private assertScope(config: PipelineConfig, projectId: string, actor: ActorContext): void {
    assertProjectAllowed(actor, projectId)
    try {
      // 只比较**调用者能够声明**的维度：项目与租户。
      //
      // `scope.environment` 刻意不参与比较：它是**部署维度**（由服务端配置决定），
      // 不在 `ActorContext` 里、调用者无法声明它，`projectDataRoot` 推导项目目录时
      // 也只用租户与项目。把它放进比较的后果不是"更严格"，而是**任何声明了
      // `scope.environment` 的配置永久不可用**（`expected staging, got (missing)`），
      // 示例配置 `examples/pipeline.yaml` 正是这种情况。
      assertScopeMatch(
        {
          projectId: config.projectId,
          ...(config.scope?.tenantId === undefined ? {} : { tenantId: config.scope.tenantId }),
        },
        { projectId, ...(actor.tenantId === undefined ? {} : { tenantId: actor.tenantId }) },
      )
    } catch (error) {
      throw toPipelineRunError(error, 'scope-mismatch')
    }
  }

  private hostOptions(config: PipelineConfig, pipelineId: string, callSignal?: AbortSignal): PlatformHostOptions {
    const gateTaskTtlMs = this.options.defaultGateTaskTtlMs
    // 每次调用的信号与 service 级信号并列：任一中止即中止本次运行。
    // 这样取消某条流水线的后台运行不会连带取消同实例上其他流水线的运行。
    const signal = combineSignals(this.options.signal, callSignal)
    return {
      config,
      dataRoot: this.options.dataRoot,
      pipelineId,
      // 缺省 0：HTTP handler 不在请求内挂住等真人裁决（docs/10 §5.4）。
      gateWaitTimeoutMs: this.options.defaultGateWaitTimeoutMs ?? 0,
      ...(gateTaskTtlMs === undefined ? {} : { gateTaskTtlMs }),
      ...(signal === undefined ? {} : { signal }),
    }
  }

  /** 门任务存储：路径经 `gateTaskStoreDir` 统一生成（docs/10 §4.3）。 */
  private async gateStoreOf(pipelineId: string, projectId: string | undefined, actor: ActorContext): Promise<{
    readonly store: FileHumanGateTaskStore
    readonly config: PipelineConfig
    /** 项目根：幂等台账目录由它与 `idempotencyDir` 拼出，与锁/产物同源。 */
    readonly projectRoot: string
  }> {
    const { config } = await this.locate(pipelineId, actor)
    // 项目一律由索引 + 配置推导；调用方自报的项目只作**额外**一致性校验。
    // 不匹配即拒：防止把两个不同流水线的项目/流水线标识拼在一起绕过作用域。
    if (projectId !== undefined && config.projectId !== projectId) {
      throw new PipelineRunError('scope-mismatch', `项目不匹配：期望 ${config.projectId}，收到 ${projectId}`, {
        expected: config.projectId,
        actual: projectId,
      })
    }
    const roots = resolvePlatformRoots(this.options.dataRoot, config)
    return {
      store: new FileHumanGateTaskStore(gateTaskStoreDir(roots.projectRoot)),
      config,
      projectRoot: roots.projectRoot,
    }
  }

  /** 读取门任务并校验它确实属于给定项目/流水线（防止跨流水线裁决）。 */
  private async requireGateTask(
    input: { readonly projectId?: string; readonly pipelineId: string; readonly gateTaskId: string },
    actor: ActorContext,
  ): Promise<{ readonly store: FileHumanGateTaskStore; readonly task: HumanGateTask; readonly projectRoot: string }> {
    assertSafeIdentifier(input.pipelineId, 'pipelineId')
    assertSafeIdentifier(input.gateTaskId, 'gateTaskId')
    const { store, projectRoot } = await this.gateStoreOf(input.pipelineId, input.projectId, actor)
    const task = await store.get(input.gateTaskId)
    if (task === null) throw new PipelineRunError('not-found', `门任务不存在：${input.gateTaskId}`, { gateTaskId: input.gateTaskId })
    // 流水线归属是必检项：这是"用 A 流水线的身份裁决 B 流水线任务"的唯一防线。
    if (task.pipelineId !== input.pipelineId) {
      throw new PipelineRunError('scope-mismatch', `门任务不属于该流水线：${input.gateTaskId}`, {
        gateTaskId: input.gateTaskId,
        expectedPipeline: input.pipelineId,
        actualPipeline: task.pipelineId,
      })
    }
    // 项目只在调用方显式声明时校验（HTTP 路径里没有 projectId，由索引推导）。
    if (input.projectId !== undefined && task.projectId !== input.projectId) {
      throw new PipelineRunError('scope-mismatch', `门任务不属于该项目：${input.gateTaskId}`, {
        gateTaskId: input.gateTaskId,
        expectedProject: input.projectId,
        actualProject: task.projectId,
      })
    }
    return { store, task, projectRoot }
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
 * 从持久化事实重建事件时间线（`GET /api/pipelines/:pipelineId/events`）。
 *
 * 纯函数：输入是检查点 + 门任务，输出是排序后的事件。**每条事件的 `at` 都来自
 * 磁盘上的时间戳**（见 `PipelineEventKind` 的映射表），因此同一份数据在任何进程、
 * 任何时刻读出的时间线完全相同。
 *
 * 排序：先按 `at` 升序，`at` 相同再按 {@link EVENT_ORDER} 定序（同一毫秒内
 * "开门 → 认领 → 裁决 → 消费"必须稳定，否则页面上的因果顺序会随机翻转），
 * 最后按 `gateTaskId` 兜底，保证结果确定。
 */
export function buildEventTimeline(
  checkpoint: Checkpoint,
  tasks: readonly HumanGateTask[],
): readonly PipelineEventView[] {
  const events: PipelineEventView[] = []

  for (const stageId of STAGE_ORDER) {
    for (const failure of checkpoint.stageStates[stageId]!.failures) {
      events.push({
        kind: 'stage-failure',
        at: failure.at,
        stageId,
        gateTaskId: null,
        actorId: null,
        detail: `[${failure.kind}]${failure.rule === undefined ? '' : ` ${failure.rule}`}${failure.detail === undefined ? '' : `: ${failure.detail}`}`,
      })
    }
  }

  for (const record of checkpoint.reentries) {
    events.push({
      kind: 'reenter',
      at: record.at,
      stageId: record.stageId,
      gateTaskId: null,
      actorId: record.by,
      detail: `${record.reason}（cursor ${record.cursorBefore} → ${record.cursorAfter}${record.cascade ? '，级联下游' : ''}）`,
    })
  }

  for (const task of tasks) {
    events.push({
      kind: 'gate-opened',
      at: task.createdAt,
      stageId: task.stageId,
      gateTaskId: task.gateTaskId,
      actorId: null,
      detail: `产物 ${task.artifactPath} 送审（机器门禁 ${task.machineStatus}）`,
    })
    if (task.claimedBy !== undefined && task.lease !== undefined) {
      events.push({
        kind: 'gate-claimed',
        at: task.lease.acquiredAt,
        stageId: task.stageId,
        gateTaskId: task.gateTaskId,
        actorId: task.claimedBy,
        detail: `认领至 ${new Date(task.lease.expiresAt).toISOString()}`,
      })
    }
    if (task.decision !== undefined) {
      events.push({
        kind: 'gate-decided',
        at: task.decision.at,
        stageId: task.stageId,
        gateTaskId: task.gateTaskId,
        actorId: task.decision.by,
        detail: task.decision.note === '' ? task.decision.action : `${task.decision.action}：${task.decision.note}`,
      })
    }
    if (task.cancellation !== undefined) {
      events.push({
        kind: 'gate-cancelled',
        at: task.cancellation.at,
        stageId: task.stageId,
        gateTaskId: task.gateTaskId,
        actorId: task.cancellation.by,
        detail: task.cancellation.note === '' ? '已取消' : task.cancellation.note,
      })
    }
    if (task.consumedAt !== undefined) {
      events.push({
        kind: 'gate-consumed',
        at: task.consumedAt,
        stageId: task.stageId,
        gateTaskId: task.gateTaskId,
        actorId: null,
        detail: '裁决已驱动过一次门，不会被重复消费',
      })
    }
  }

  return events.sort((a, b) => {
    if (a.at !== b.at) return a.at - b.at
    const byKind = EVENT_ORDER.indexOf(a.kind) - EVENT_ORDER.indexOf(b.kind)
    if (byKind !== 0) return byKind
    return (a.gateTaskId ?? '') < (b.gateTaskId ?? '') ? -1 : (a.gateTaskId ?? '') > (b.gateTaskId ?? '') ? 1 : 0
  })
}

/** 同一毫秒内的因果定序（开门 → 认领 → 裁决 → 取消 → 消费 → 失败 → 重入）。 */
const EVENT_ORDER: readonly PipelineEventKind[] = [
  'gate-opened', 'gate-claimed', 'gate-decided', 'gate-cancelled', 'gate-consumed', 'stage-failure', 'reenter',
]

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
