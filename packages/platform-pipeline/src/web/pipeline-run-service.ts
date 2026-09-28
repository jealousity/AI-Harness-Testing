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
  hostRecordIdempotencyLedger,
  idempotencyDir,
  idempotencyFingerprint,
  idempotencyKey,
  type IdempotencyField,
  type IdempotencyLedger,
} from '../idempotency.ts'
import { resolvePlatformRoots, type PlatformStorageRoots } from '../platform-roots.ts'
import { assertScopeMatch } from '../platform-scope.ts'
import { assertTargetBaseUrlAllowed, assertTargetResolvedAllowed } from './ssrf-guard.ts'
import { createFileStorageBackendFromRoots } from '../storage/file/index.ts'
import { createFileHostRecordStore } from '../storage/file/records.ts'
import {
  StorageCorruptError,
  StorageUnavailableError,
  assertBackendPorts,
  assertStorageBackendHealthy,
  type HostRecordStore,
  type StorageBackend,
  type StorageBackendFactory,
} from '../storage/ports.ts'
import { FsArtifactStore } from '../stores/fs.ts'
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
import { type HumanGateTask, type HumanGateTaskStore } from '../runtime/persistence.ts'
import { HumanGateWaitAbortedError } from '../runtime/persistent-human-gate.ts'
import { inspectPipelineLock } from '../checkpoint-lock.ts'
import {
  PipelineRunError,
  assertGateRole,
  assertOperatorRole,
  deriveNextAction,
  errorMessageOf,
  toGateTaskView,
  toPipelineRunError,
  type ActorContext,
  type CreatePipelineRunInput,
  type GateCancelInput,
  type GateClaimInput,
  type GateDecisionInput,
  type GateTaskFilter,
  type GateTaskKind,
  type GateTaskView,
  type PipelineDiagnostics,
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
  /** 建连前的解析后复核（docs/11 P2-04）；缺省 = `assertTargetResolvedAllowed`。 */
  readonly assertResolvedTargetAllowed?: (url: string) => Promise<void>
  /** 取消信号（本 service 实例内所有 run 共享；M1 的 async-runner 会改为每 run 独立）。 */
  readonly signal?: AbortSignal
  /**
   * 运行锁的 stale 上限（毫秒）。缺省 6 小时——与 CLI / Harness 一致。
   *
   * 判断依据是锁的 `heartbeatAt` 而不是取得时间，因此**长跑流水线不会被误抢**：
   * 锁会按 `staleMs / 3` 自动续租。只有"进程被杀、心跳停摆"才会超过这个上限。
   */
  readonly lockStaleMs?: number
  /**
   * 存储后端工厂（docs/11 P1-09）。
   *
   * 缺省 = 文件后端。服务是**多项目**的（项目目录由 `resolvePlatformRoots` 推导），
   * 所以注入的是"根 → 后端"的工厂而不是现成实例。
   *
   * 换后端 = 换这一个函数：`create`/`run`/`get`/`gate`/`usage` 一行都不用改。
   */
  readonly createStorageBackend?: StorageBackendFactory
  /**
   * **dataRoot 级**宿主记录的存储工厂（流水线索引 / 运行清单用它）。
   *
   * 为什么与 `createStorageBackend` 分开：`StorageBackendFactory` 是**项目级**的
   * （绑死一个 `projectRoot`），而流水线索引是 **dataRoot 级、跨项目**的注册表
   * （恢复扫描要一次枚举全部流水线）。两者作用域不同，因此是两处注入点。
   *
   * 缺省 = `createFileHostRecordStore`（落在 `<dataRoot>/pipelines/<id>.json`，
   * **与既有布局逐字相同**），因此不注入时行为与之前完全一致。
   */
  readonly createHostRecordStore?: (dataRoot: string) => HostRecordStore
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
   * 前置校验（配置 / provider / 审批覆盖 / 检查点可读）。
   *
   * 供后台运行入口在**启动之前**调用：这样"明显跑不起来"的失败会同步返回给调用者，
   * 而不是只写进服务端日志。详见实现处的文档注释。
   */
  preflight(pipelineId: string, actor: ActorContext): Promise<void>
  /**
   * 数据根体检（`GET /api/pipelines/:pipelineId/diagnostics`，docs/14 W5 第 9 条）。
   *
   * 汇总后端诊断、索引不可读项、用量坏行、创建中间态与运行锁现状。
   * 要求 `operator`：它是只读的，但暴露的是部署层面的排障信息。
   */
  diagnose(pipelineId: string, actor: ActorContext): Promise<PipelineDiagnostics>
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
  listGateTasks(filter: GateTaskFilter, actor: ActorContext): Promise<readonly GateTaskView[]>
  claimGate(input: GateClaimInput, actor: ActorContext): Promise<GateTaskView>
  decideGate(input: GateDecisionInput, actor: ActorContext): Promise<GateTaskView>
  cancelGate(input: GateCancelInput, actor: ActorContext): Promise<GateTaskView>
}

/**
 * 流水线运行清单（manifest）：`pipelineId → 作用域 + 配置引用 + 运行参数`。
 *
 * 必须**持久化**而不是只放进程内存——否则进程重启后 `get(pipelineId, actor)` 无法由
 * `pipelineId` 反解出 projectId 与配置，也就谈不上"从检查点重建页面状态"
 * （docs/10 §4.2 M0-3、§5.3「进程内 registry 不能作为唯一状态」、§5.5 验收 6）。
 *
 * 运行参数（`targetBaseUrl` / `providerName` / `requirementInput` / 重试与 TTL /
 * 诊断探针）**也必须在这里**（docs/11 P1-01）：它们只在 `create` 请求里出现过一次，
 * 之后每一次 `run`（包括进程重启后的 `run`）都只能从磁盘恢复。修复前这些字段只被
 * 校验、不被保存，于是真实 execute 永远拿不到 `targetBaseUrl`。
 *
 * **为什么不另开一个 manifest 文件**：`index` 与 `manifest` 是同一份事实，分成两个
 * 文件就有两次写，中间崩溃会留下"清单在、索引不在"或反之的半成品状态——而那正是
 * `docs/11` 要求避免的"部分失败不得宣称创建成功"。合成一个文件后，一次原子写
 * （tmp → rename）就同时确定了作用域与运行参数。
 *
 * 后 7 个字段**可选**：历史索引文件只有前 4 个字段，读侧按"未声明"处理（不编造值）。
 * 未声明的运行参数由宿主装配的缺省值兜底，语义与 `create` 时省略该参数一致。
 */
export interface PipelineRunManifest {
  readonly pipelineId: string
  readonly tenantId: string | null
  readonly projectId: string
  readonly configRef: string
  /**
   * 创建过程是否已收口（docs/14 W2 第 5 条）。
   *
   * `'creating'` = **索引已写、检查点尚未确认**的中间态。它必须**可见**：
   * 创建要在"索引"与"检查点"两处落盘，两处之间崩溃时，若索引后写就会留下
   * 一份谁也看不见的孤儿检查点（列表查不到、恢复扫描扫不到、`get` 说 404），
   * 运维只能看到"凭空消失的一次创建"。改为索引先写 `creating`、检查点成功后再翻成
   * `ready`，中间态就始终可被恢复扫描报告（`creation-incomplete`）。
   *
   * 历史索引没有这个字段，按 `'ready'` 解释（向后兼容，无需迁移）。
   */
  readonly creationState?: 'creating' | 'ready'
  /** 创建时生效的规则集版本；历史索引没有这个字段。 */
  readonly rulesetVersion?: string
  /** 创建时间（毫秒）；历史索引没有这个字段。 */
  readonly createdAt?: number
  /** receive 阶段的输入文件路径（降级链末级）。 */
  readonly requirementInput?: string
  /** 指定 provider 名；缺省按配置的 `llm.defaultProvider` 回退。 */
  readonly providerName?: string
  /** 被测服务基址；executor 建连前会用同一份判据复核。 */
  readonly targetBaseUrl?: string
  readonly maxGateRetries?: number
  /** 人工门等待上限；`0` = 只轮询一次就让出控制权。 */
  readonly gateWaitTimeoutMs?: number
  readonly gateTaskTtlMs?: number
  /** `env_diag` 的固定探针白名单：**只存环境变量名**，绝不存凭据值。 */
  readonly diagCredentials?: readonly string[]
}

/**
 * 兼容别名：索引项就是运行清单（同一份文件、同一次原子写）。
 *
 * 保留旧名字是为了让 `scanPipelineIndex` 的既有调用方与测试不必跟着改——它们关心
 * 的是"pipelineId → 作用域"，而那是清单的子集。
 */
export type PipelineIndexEntry = PipelineRunManifest

/**
 * 流水线索引目录：`<dataRoot>/pipelines`。集中在此处生成，调用点不得自行拼路径。
 *
 * 这是**默认（文件）实现**的落盘位置；索引本身走 {@link HostRecordStore}，
 * `collection = 'pipelines'`。因此换一个 store 就能把索引搬到别的后端，
 * 而默认行为与落盘布局逐字不变。
 */
export function pipelineIndexDir(dataRoot: string): string {
  return join(dataRoot, 'pipelines')
}

/** 索引所在的集合名（`HostRecordStore` 的 `collection`）。 */
export const PIPELINE_INDEX_COLLECTION = 'pipelines'

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
 * 从**任意记录存储**扫描全部流水线索引项（按 `pipelineId` 排序，保证恢复顺序确定）。
 *
 * 逐条读、逐条 catch：单条索引损坏只影响它自己，**不让整次扫描失败**。
 * 这正是端口要提供 `listIds` 而不是只有 `list` 的原因——`list` 会在第一条坏记录上抛错，
 * 于是扫描只能在"整体失败"与"静默跳过坏记录"之间二选一，两者都不可接受。
 */
export async function scanPipelineIndexFrom(store: HostRecordStore): Promise<PipelineIndexScan> {
  const ids = await store.listIds(PIPELINE_INDEX_COLLECTION)
  const entries: PipelineIndexEntry[] = []
  const unreadable: { file: string; reason: string }[] = []
  for (const id of ids) {
    try {
      const value = await store.read(PIPELINE_INDEX_COLLECTION, id)
      if (!isIndexEntry(value)) throw new Error('索引字段缺失或类型不符')
      // 键才是权威：记录里的 `pipelineId` 与键不一致说明它被改写坏了，
      // 继续用就会去解析另一个流水线的作用域与配置。
      if (value.pipelineId !== id) {
        throw new Error(`索引 pipelineId 与键不一致：${value.pipelineId} ≠ ${id}`)
      }
      entries.push(value)
    } catch (error) {
      // **基础设施故障必须整体抛出**，不能降级成"这一条读不了"（docs/14 W2 第 4 条）。
      // 否则外部后端断开时，列表会返回一个**空的成功结果**、恢复扫描会报几条 unreadable，
      // 运维看到的是"没有流水线"而不是"存储挂了"——两件事的处置完全不同。
      // 只有数据层面的问题（记录损坏、形状不符、键不一致）才只影响这一条。
      if (error instanceof StorageUnavailableError) throw error
      unreadable.push({ file: `${id}.json`, reason: errorMessageOf(error) })
    }
  }
  return { entries, unreadable }
}

/**
 * 扫描全部流水线索引项（**文件存储**的便捷入口）。
 *
 * 保留这个签名是为了让既有调用方与测试不必跟着改；它等价于
 * `scanPipelineIndexFrom(createFileHostRecordStore(dataRoot))`。
 * 目录不存在 = 尚无任何流水线，返回空结果而不是报错。
 */
export async function scanPipelineIndex(dataRoot: string): Promise<PipelineIndexScan> {
  return scanPipelineIndexFrom(createFileHostRecordStore(dataRoot))
}

/**
 * 清单形状校验。
 *
 * 可选字段一旦出现就必须类型正确——**不能静默忽略**：把 `maxGateRetries: "lots"`
 * 当成"没写"，会让一次磁盘损坏伪装成"用了默认参数"，而流水线照样跑起来
 * （docs/11 P1-01「不得静默降级」、P2-01）。
 */
function isIndexEntry(value: unknown): value is PipelineRunManifest {
  if (value === null || typeof value !== 'object') return false
  const candidate = value as Record<string, unknown>
  return typeof candidate.pipelineId === 'string' && candidate.pipelineId !== ''
    && typeof candidate.projectId === 'string' && candidate.projectId !== ''
    && typeof candidate.configRef === 'string' && candidate.configRef !== ''
    && (candidate.tenantId === null || typeof candidate.tenantId === 'string')
    && optionalNonEmptyString(candidate, 'rulesetVersion')
    && optionalNonEmptyString(candidate, 'requirementInput')
    && optionalNonEmptyString(candidate, 'providerName')
    && optionalNonEmptyString(candidate, 'targetBaseUrl')
    && optionalFiniteNumber(candidate, 'createdAt')
    && optionalFiniteNumber(candidate, 'maxGateRetries')
    && optionalFiniteNumber(candidate, 'gateWaitTimeoutMs')
    && optionalFiniteNumber(candidate, 'gateTaskTtlMs')
    && optionalNonEmptyStringArray(candidate, 'diagCredentials')
    && optionalCreationState(candidate)
}

/**
 * `creationState` 的形状校验。
 *
 * 出现即必须是两个合法取值之一——**不能静默忽略**：把 `creationState: 'createing'`
 * 当成"没写"，会让一次拼写错误表现为"这条流水线已就绪"，而它其实停在中间态。
 */
function optionalCreationState(candidate: Record<string, unknown>): boolean {
  const value = candidate.creationState
  return value === undefined || value === 'creating' || value === 'ready'
}

function optionalNonEmptyString(record: Record<string, unknown>, key: string): boolean {
  const value = record[key]
  return value === undefined || (typeof value === 'string' && value !== '')
}

function optionalFiniteNumber(record: Record<string, unknown>, key: string): boolean {
  const value = record[key]
  return value === undefined || (typeof value === 'number' && Number.isFinite(value))
}

function optionalNonEmptyStringArray(record: Record<string, unknown>, key: string): boolean {
  const value = record[key]
  return value === undefined
    || (Array.isArray(value) && value.every(item => typeof item === 'string' && item !== ''))
}

/** 需要人工门权限的角色（docs/10 §5.3「校验 actor 是否有该项目的人工门权限」）。 */
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
  /**
   * 流水线索引的记录存储（dataRoot 级）。
   *
   * 构造时固定一次：索引是**跨项目**的注册表，不需要按项目缓存（那是项目级后端的事）。
   */
  private readonly indexStore: HostRecordStore
  private readonly assertTargetBaseUrl: (url: string) => void
  /** 建连前的解析后复核（docs/11 P2-04）。 */
  private readonly assertResolvedTargetAllowed: (url: string) => Promise<void>
  /** 配置缓存（docs/10 §4.2「加载、校验和缓存配置」）。只缓存解析成功的配置。 */
  private readonly configCache = new Map<string, PipelineConfig>()
  /**
   * 按项目根缓存的后端（docs/11 P1-09）。
   *
   * 必须按项目缓存：一个后端实例绑死一个 `projectRoot`，而本服务同时服务多个项目。
   * 缓存还让"同一次进程里对同一项目只装配一次后端"成立——否则每次 `get` 都会
   * 新建一遍 store（在文件后端上只是浪费，在外部后端上就是每次新建连接池）。
   */
  private readonly backends = new Map<string, StorageBackend>()
  /** 已做过健康检查的后端。`diagnose()` 会扫全项目记录，不能每次调用都跑。 */
  private readonly healthy = new WeakSet<StorageBackend>()

  constructor(options: PipelineRunServiceOptions) {
    if (options.dataRoot.trim() === '') throw new Error('PipelineRunService 需要非空 dataRoot')
    this.options = options
    this.loadConfig = options.loadConfig ?? (async ref => loadPipelineConfig(ref))
    this.createHost = options.createHost ?? createPlatformHost
    this.indexStore = (options.createHostRecordStore ?? createFileHostRecordStore)(options.dataRoot)
    this.assertTargetBaseUrl = options.assertTargetBaseUrl ?? assertTargetBaseUrlAllowed
    this.assertResolvedTargetAllowed = options.assertResolvedTargetAllowed ?? assertTargetResolvedAllowed
  }

  async create(input: CreatePipelineRunInput, actor: ActorContext): Promise<PipelineRunSummary> {
    assertActor(actor)
    assertSafeIdentifier(input.pipelineId, 'pipelineId')
    assertSafeIdentifier(input.projectId, 'projectId')
    assertProjectAllowed(actor, input.projectId)
    if (input.targetBaseUrl !== undefined) this.assertTargetBaseUrl(input.targetBaseUrl)
    assertDiagCredentials(input.diagCredentials)
    assertNonNegativeInteger(input.maxGateRetries, 'maxGateRetries')
    assertNonNegativeInteger(input.gateWaitTimeoutMs, 'gateWaitTimeoutMs')
    assertNonNegativeInteger(input.gateTaskTtlMs, 'gateTaskTtlMs')

    const config = await this.configOf(input.configRef)
    this.assertScope(config, input.projectId, actor, { kind: 'expose' })

    const roots = resolvePlatformRoots(this.options.dataRoot, config)
    const rulesetVersion = input.rulesetVersion ?? DEFAULT_RULESET_VERSION
    const namespace = IDEMPOTENCY_NAMESPACES.pipelineCreate
    // 键字段 = docs/10 §6.3 的 `tenantId/projectId/pipelineId`。
    return this.runIdempotent(
      config,
      roots.projectRoot,
      namespace,
      idempotencyKey(namespace, [config.scope?.tenantId ?? '', config.projectId, input.pipelineId]),
      // 指纹必须覆盖**所有会影响运行行为、且会被落盘的字段**（docs/11 P1-01）：
      // 同一个 pipelineId 换了被测基址/provider/重试预算/诊断探针就是另一次创建，
      // 必须 409 拒绝而不是静默重放首次结果（docs/10 §5.3「绝不静默复用」）。
      idempotencyFingerprint(namespace, createFingerprintFields(input, config.projectId, rulesetVersion)),
      () => this.createOnce(input, config, roots, rulesetVersion),
    )
  }

  /**
   * 首次创建（幂等台账未命中时执行）。
   *
   * 幂等语义：同一 `(tenantId, projectId, pipelineId)` 且请求内容一致的重复投递返回
   * **首次的 summary**，不再报 409——这是 §6.4「重试不产生副作用」要的行为。真正
   * 换了内容（另一个 `configRef`、另一个 `targetBaseUrl`…）的请求由指纹比对拦成
   * `conflict`，因此 §5.3 的「绝不静默复用」仍然成立：静默复用的只是**同一个**请求。
   *
   * 落盘顺序与失败语义（docs/11 P1-01「部分失败不得宣称创建成功」）：
   * 1. 检查点（`save` 是 tmp→rename 原子写）；
   * 2. 清单（同一次原子写同时确定作用域与运行参数）。
   * 第 2 步失败时 `create` 抛错、幂等台账**不落盘**（`idempotency.ts`：`produce` 抛错
   * 即不留"已完成"记录），因此调用方看到的是失败而不是半成品成功；重试会重新走
   * 这两步并覆盖第 1 步留下的检查点，不需要人工清理。
   */
  private async createOnce(
    input: CreatePipelineRunInput,
    config: PipelineConfig,
    roots: PlatformStorageRoots,
    rulesetVersion: string,
  ): Promise<PipelineRunSummary> {
    const checkpointRoot = join(roots.checkpointRoot, input.pipelineId)
    const checkpoint = this.backendOf(config).ports.checkpoints

    // pipelineId 在租户/项目作用域内唯一（docs/10 §5.3）：已存在即冲突，绝不静默复用。
    // 走到这里说明台账里没有本次请求的记录，磁盘上的同 id 流水线是别人/旧版本建的。
    // 已存在但记录损坏时 readIndex 抛 storage-unavailable：宁可拒绝创建，也不覆盖坏记录。
    //
    // **例外：上一次创建停在中间态**（`creationState === 'creating'`）。那是"同一意图的
    // 前一次尝试没写完"，指纹相同（否则走不到这里），因此允许**接管**——
    // 否则一次崩溃就会让这个 pipelineId 永久不可用。
    const existing = await this.readIndex(input.pipelineId)
    if (existing !== null && existing.creationState !== 'creating') {
      throw new PipelineRunError('conflict', `pipeline 已存在：${input.pipelineId}`, { pipelineId: input.pipelineId })
    }

    // 落盘顺序（docs/14 W2 第 5 条）：**索引先写 `creating`，检查点成功后翻 `ready`**。
    //
    // 反过来（检查点先写）的失败模式是：检查点已落盘、索引写失败 → 这条流水线
    // 列表查不到、恢复扫描扫不到、`get` 说 404，**没有任何报告**。先写索引则最坏情况
    // 是"一条可见的中间态记录"，恢复扫描能报 `creation-incomplete`，也能被重新 create 接管。
    const manifest = manifestOf(input, config, rulesetVersion)
    await this.writeIndex({ ...manifest, creationState: 'creating' })
    try {
      await checkpoint.save(checkpointRoot, initialCheckpoint(input.pipelineId, config.templateVersion, rulesetVersion))
    } catch (error) {
      // 检查点写失败：索引停在 `creating`（**故意不清理**）。删掉它反而会回到
      // "两处都看不见"的状态；留着它，恢复扫描与 `get` 都能如实报告这次失败。
      throw error
    }
    await this.writeIndex({ ...manifest, creationState: 'ready' })

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
    // 必须用**注入的**索引存储（docs/14 W2 第 1 条）：此前这里调 `scanPipelineIndex(dataRoot)`
    // 会重新构造一个默认文件存储，于是换了后端之后 `create/get/recover` 看外部索引、
    // 而 `list` 看本地文件目录——同一条流水线"详情能打开、列表里没有"。
    const scan = await scanPipelineIndexFrom(this.indexStore)
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
    const artifact = await this.backendOf(config).ports.artifacts.read(state.artifact)
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
    const tasks = await this.backendOf(config).ports.gateTasks.list({ pipelineId })
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
    const read = await this.backendOf(config).ports.usage.read(pipelineId)
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
    const { manifest, config, backend, checkpointRoot } = await this.locate(pipelineId, actor)
    await this.requireCheckpoint(backend, pipelineId, checkpointRoot)

    // 运行互斥（§6.3 M2-2）：锁覆盖 load checkpoint → 阶段产物生成 → 门禁/审核/人工门
    // 推进 → checkpoint save。**不含**人工门"阻塞等待"之后的续写——见下面的说明。
    const lock = await this.acquireRunLock(backend, pipelineId)
    try {
      const host = this.createHost(this.hostOptions(config, manifest, pipelineId, options.signal))

      try {
        const outcome = await host.driver.run()
        const view = await this.buildView(config, await this.requireCheckpoint(backend, pipelineId, checkpointRoot))
        if (outcome.outcome === 'completed') return { outcome: 'completed', view }
        return { outcome: outcome.outcome, stageId: outcome.stageId, view }
      } catch (error) {
        const view = await this.buildView(config, await this.requireCheckpoint(backend, pipelineId, checkpointRoot))
        // 人工门等待被中止：超时 = 让出控制权等真人裁决（docs/10 §4.2、§5.4 第 4 步）；
        // 信号中止 / 任务被外部取消 = 本次运行取消。两条路径都绝不自动批准。
        if (error instanceof HumanGateWaitAbortedError) {
          if (error.reason === 'timeout') {
            return { outcome: 'waiting-human', stageId: error.stageId, gateTaskId: error.gateTaskId, view }
          }
          return { outcome: 'cancelled', view }
        }
        // 运行期异常**落盘**（docs/14 W5 遗留项）。
        //
        // 此前它只随 RunResult 返回给后台任务，于是后台运行时在 UI 上**完全不可见**：
        // 检查点没写、事件流里没有、页面只说"尚未开始"，用户只会反复点"触发运行"。
        // 这与"前置校验失败"不同——那个已经在启动后台任务之前同步返回了（见 `preflight`）。
        //
        // 顺序要紧：**先落盘、再建视图**，否则这一次返回的视图里看不到刚记下的失败。
        const failure = toPipelineRunError(error)
        await this.recordRunFailure(backend, pipelineId, checkpointRoot, failure)
        const failedView = await this.buildView(
          config, await this.requireCheckpoint(backend, pipelineId, checkpointRoot),
        )
        return { outcome: 'failed', error: failure.toView(), view: failedView }
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

  /**
   * 把运行期异常落盘到**当前阶段**的 `failures` 上（docs/14 W5 遗留项）。
   *
   * 为什么放在 service 而不是 driver：`docs/10 §4.2 M0-2` 明确把"映射机器门禁失败、
   * 审核失败、拒绝**和异常**"列为 service 的职责；而且 service 是唯一同时拿到
   * backend / 检查点根 / 错误分类的地方。
   *
   * **尽力而为**：写不进去就不写（存储坏了本来就写不进任何东西），
   * 但**绝不吞掉原异常**——调用方仍然拿到 `outcome: 'failed'` 与原始错误视图。
   */
  private async recordRunFailure(
    backend: StorageBackend,
    pipelineId: string,
    checkpointRoot: string,
    error: PipelineRunError,
  ): Promise<void> {
    try {
      const checkpoint = await this.requireCheckpoint(backend, pipelineId, checkpointRoot)
      const stageId = STAGE_ORDER[checkpoint.cursor]
      if (stageId === undefined) return // 游标已过末阶段：没有可归属的阶段
      const state = checkpoint.stageStates[stageId]!
      const updated: Checkpoint = {
        ...checkpoint,
        stageStates: {
          ...checkpoint.stageStates,
          [stageId]: {
            ...state,
            failures: [
              ...state.failures,
              // `kind` 用 `run-error` 与门禁/审核失败区分；错误码写进 detail 而不是 rule
              // ——`rule` 是**门禁规则 id**（如 R4-08），塞错误码会让人误以为它是一条规则。
              { kind: 'run-error', detail: `[${error.code}] ${error.message}`, at: Date.now() },
            ],
          },
        },
      }
      await backend.ports.checkpoints.save(checkpointRoot, updated)
    } catch {
      // 落盘失败不能盖掉原异常：调用方要拿到的仍然是"这次运行为什么失败"。
    }
  }

  /**
   * **前置校验**（docs/14 W5）：跑完 `run()` 里除"取锁 + 跑 driver"之外的全部准备步骤。
   *
   * 为什么单独开一个方法：这些失败（配置非法、**provider 缺 Key**、审批覆盖缺失…）
   * 都是在 `createHost()` 里**同步**抛出来的，但 `run()` 是被后台任务调用的——
   * 于是失败只进服务端日志，HTTP 那边早就返回了 `202`。实测：缺 `PLATFORM_LLM_API_KEY`
   * 时页面显示"尚未开始：触发运行"，用户会反复点同一个按钮而得不到任何解释。
   *
   * 把前置校验前移到**启动后台运行之前**，失败就能以 `started: false` + 明确 reason
   * 回到调用者。这比"把失败持久化"更好：失败发生得更早，而且**不新增任何状态**——
   * 用"进程内记住上次失败"来补是被架构禁止的（那会成为第二份事实来源）。
   *
   * **不取运行锁**：锁要留给真正的 `run()`，否则前置校验会把锁持有到后台运行结束。
   * 因此本方法**不保证**"校验通过后 run 一定能开始"（并发、锁竞争仍可能让 run 失败）；
   * 它只保证"明显跑不起来的配置在启动后台任务之前就被拦下"。
   */
  async preflight(pipelineId: string, actor: ActorContext): Promise<void> {
    assertActor(actor)
    assertSafeIdentifier(pipelineId, 'pipelineId')
    const { manifest, config, backend, checkpointRoot } = await this.locate(pipelineId, actor)
    await this.requireCheckpoint(backend, pipelineId, checkpointRoot)
    // 组装一次宿主：provider 解析、工具 ACL、审批覆盖都在这一步发生。
    // 宿主会被丢弃（`run()` 会自己再建一个），代价是构造开销，不是模型调用。
    try {
      this.createHost(this.hostOptions(config, manifest, pipelineId, undefined))
    } catch (error) {
      // `createHost` 抛的是**普通 Error**（provider 解析失败、审批覆盖缺失等）。
      // 服务层的约定是"前置失败一律抛 `PipelineRunError`"，调用方才能按错误码分支；
      // 直接透传裸 Error 会让调用方拿不到 code，只能把一切归成 500。
      // `run()` 里的 catch 也是这么翻译的，这里保持一致。
      throw toPipelineRunError(error)
    }
  }

  /**
   * 数据根体检（docs/14 W5 第 9 条）。
   *
   * 刻意**只读**：不获取运行锁、不修改任何记录。排障路径上做写操作是最糟的设计。
   *
   * `allowCreating: true`：体检必须能诊断"创建未完成"这种状态——那正是最需要被
   * 诊断的情况之一，若沿用 `requireIndex` 的中间态拒绝就会永远看不到它。
   */
  async diagnose(pipelineId: string, actor: ActorContext): Promise<PipelineDiagnostics> {
    assertActor(actor)
    // 只读，但暴露的是部署层面的排障信息，因此要运维角色。
    assertOperatorRole(actor, '数据根体检')
    assertSafeIdentifier(pipelineId, 'pipelineId')

    const { manifest, config, backend, checkpointBase } = await this.locate(pipelineId, actor, { allowCreating: true })
    const health = await backend.diagnose()
    // 索引扫描：不可读项**显式列出**（不静默跳过），否则"恢复扫描看不见某条"无从解释。
    const scan = await scanPipelineIndexFrom(this.indexStore)
    // 用量坏行：**直接读用量日志**，不走 `getUsage`。
    //
    // 为什么不能用 `getUsage`：它要 `loadRun`（检查点 + 索引都必须可读）。而体检恰恰
    // 要在**数据坏了的时候**能跑——实测中"检查点损坏"与"创建未完成"两种情况下，
    // `getUsage` 会先抛 `StorageCorruptError` / `conflict`，于是体检永远报不出那件事。
    // 排障工具依赖被排查的对象健康，是自相矛盾的。
    const usageRead = await backend.ports.usage.read(pipelineId)
    const lock = await inspectPipelineLock(checkpointBase, pipelineId)

    const creationState: 'creating' | 'ready' = manifest.creationState === 'creating' ? 'creating' : 'ready'
    const now = Date.now()
    const heartbeatAt = lock.owner?.heartbeatAt ?? null
    return {
      pipelineId,
      projectId: config.projectId,
      tenantId: config.scope?.tenantId ?? null,
      backend: { name: health.backend, schemaVersion: health.schemaVersion, ok: health.ok },
      storage: health.diagnostics,
      index: { entries: scan.entries.length, unreadable: scan.unreadable },
      usageSkippedLines: usageRead.skipped.length,
      creationState,
      lock: {
        present: lock.present,
        ownerId: lock.owner?.ownerId ?? null,
        heartbeatAt,
        ageMs: heartbeatAt === null ? null : now - heartbeatAt,
      },
      attentionNeeded: !health.ok
        || scan.unreadable.length > 0
        || usageRead.skipped.length > 0
        || creationState === 'creating',
    }
  }

  async reenter(input: ReenterInput, actor: ActorContext): Promise<Checkpoint> {
    assertActor(actor)
    // 重入会回退 cursor 并把下游标 needs-reentry——这是**运维动作**，不是只读查询
    // （docs/11 P1-02）。此前只检查"actorId 非空"，任何只读调用者都能改变流水线事实。
    assertOperatorRole(actor, '流水线重入')
    assertSafeIdentifier(input.pipelineId, 'pipelineId')
    if (input.reason.trim() === '') throw new PipelineRunError('invalid-request', 'reenter 需要非空 reason')
    if (!STAGE_ORDER.includes(input.stageId)) {
      throw new PipelineRunError('invalid-request', `未知阶段：${input.stageId}`, { allowed: [...STAGE_ORDER] })
    }
    const { config, backend, checkpointRoot } = await this.locate(input.pipelineId, actor)

    // 重入会写检查点（cursor 回退 + 下游标 needs-reentry），因此与 run 抢同一把锁。
    //
    // **乐观并发的读取与比较必须在锁内**（docs/11 P1-03）：锁外读到的检查点/digest
    // 不是写入那一刻的状态，用它做校验等于允许覆盖别人刚产生的新版本——两个进程
    // 各自"校验通过"然后先后写入，后写的静默覆盖先写的。正确顺序只能是
    // 取锁 → 读检查点 → 读产物算 digest → 比较 → 重入 → 释放锁。
    const lock = await this.acquireRunLock(backend, input.pipelineId)
    try {
      const current = await this.requireCheckpoint(backend, input.pipelineId, checkpointRoot)
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
        // 与 `locate` 用同一个缓存工厂：重入读写的检查点必须和 Web 读的是同一份事实。
        createStorageBackend: this.cachedBackendFactory(),
        ...(this.options.signal === undefined ? {} : { signal: this.options.signal }),
      })
      return await host.driver.reenter(input.stageId, actor.actorId, input.reason)
    } finally {
      await lock.release()
    }
  }

  async listGateTasks(filter: GateTaskFilter, actor: ActorContext): Promise<readonly GateTaskView[]> {
    assertActor(actor)
    assertSafeIdentifier(filter.pipelineId, 'pipelineId')
    const { store } = await this.gateStoreOf(filter.pipelineId, filter.projectId, actor)
    const tasks = await store.list({
      pipelineId: filter.pipelineId,
      ...(filter.status === undefined ? {} : { status: filter.status }),
    })
    // 派生 `isEscalation`（docs/14 W3 第 3 条）：把"`artifactPath === ''` 即升级任务"
    // 这条**隐式**约定显式化，页面才能对两种任务给出不同文案与操作集合。
    return tasks.map(toGateTaskView)
  }

  async claimGate(input: GateClaimInput, actor: ActorContext): Promise<GateTaskView> {
    assertActor(actor)
    assertGateRole(actor)
    const { store, task } = await this.requireGateTask(input, actor)
    try {
      return toGateTaskView(await store.claim(task.gateTaskId, actor.actorId, input.ttlMs ?? DEFAULT_CLAIM_TTL_MS))
    } catch (error) {
      throw toPipelineRunError(error, 'gate-not-claimable')
    }
  }

  async decideGate(input: GateDecisionInput, actor: ActorContext): Promise<GateTaskView> {
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
    const { store, task, projectRoot, config } = await this.requireGateTask(input, actor)

    // 缺省不带 decisionId = 不启用幂等：行为与 M2 之前逐字一致（终态 → gate-not-decidable，
    // 已消费 → gate-consumed）。带上它以后，同一个 (gateTaskId, decisionId) 的重复投递
    // 会重放首次裁决结果（§6.4「同一 gate decision 重试不会重复消费」）。
    if (input.decisionId === undefined) return toGateTaskView(await this.decideOnce(store, task, input, actor))

    const namespace = IDEMPOTENCY_NAMESPACES.gateDecision
    const decided = await this.runIdempotent(
      config,
      projectRoot,
      namespace,
      idempotencyKey(namespace, [task.gateTaskId, input.decisionId]),
      idempotencyFingerprint(namespace, [input.pipelineId, task.gateTaskId, input.action, input.note ?? '', actor.actorId]),
      () => this.decideOnce(store, task, input, actor),
    )
    return toGateTaskView(decided)
  }

  /**
   * 真正的裁决（幂等层之下）。
   *
   * 终态、`consumedAt` 与乐观并发校验都放在这里而不是 `decideGate` 的入口：
   * 重复投递**必须能走到幂等台账**才能被重放，若在入口就按「已消费」拒掉，
   * 重试永远拿不到首次结果（§6.4 的反面）。
   */
  private async decideOnce(
    store: HumanGateTaskStore,
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

  async cancelGate(input: GateCancelInput, actor: ActorContext): Promise<GateTaskView> {
    assertActor(actor)
    // 取消门任务会把它推进 `cancelled` 终态（不可再裁决）——同为运维动作（docs/11 P1-02）。
    assertOperatorRole(actor, '取消人工门任务')
    const { store, task } = await this.requireGateTask(input, actor)
    if (store.cancel === undefined) throw new PipelineRunError('run-failed', '当前门存储不支持 cancel')
    try {
      return toGateTaskView(await store.cancel(task.gateTaskId, actor.actorId, input.note ?? ''))
    } catch (error) {
      throw toPipelineRunError(error, 'gate-not-decidable')
    }
  }

  // ── 内部：索引、作用域、配置 ────────────────────────────────────────────────

  /**
   * 该项目根对应的存储后端（docs/11 P1-09）。
   *
   * 按 `projectRoot` 缓存；装配时 `assertBackendPorts` 立刻校验端口完整性，
   * 而不是等到某个功能"莫名其妙不可用"。
   */
  private backendOf(config: PipelineConfig): StorageBackend {
    return this.backendForRoots(resolvePlatformRoots(this.options.dataRoot, config))
  }

  private backendForRoots(roots: PlatformStorageRoots): StorageBackend {
    const cached = this.backends.get(roots.projectRoot)
    if (cached !== undefined) return cached
    const backend = (this.options.createStorageBackend ?? createFileStorageBackendFromRoots)(roots)
    assertBackendPorts(backend)
    this.backends.set(roots.projectRoot, backend)
    return backend
  }

  /**
   * 转发给宿主的工厂：**返回本服务缓存的那个后端**。
   *
   * 为什么不能直接把 `options.createStorageBackend` 透传给宿主：那个工厂每次调用都可能
   * 造一个新实例（内存后端尤其如此），于是 Web 读后端 A、driver 写后端 B —— 两边各自
   * "成功"，而事实分裂。文件后端因为落在同一个目录上而**看起来**没事，正好掩盖这个错误。
   *
   * 用缓存包装之后，"服务与宿主看同一份事实"就是机器保证，而不是一句约定。
   */
  private cachedBackendFactory(): StorageBackendFactory {
    return roots => this.backendForRoots(roots)
  }

  /**
   * 后端的**健康检查**（docs/11 P1-09 第五步）：每个后端只做一次。
   *
   * 放在首次使用而不是构造函数里：`diagnose()` 会扫全项目记录（外部后端还可能建连），
   * 而构造函数是同步的。读路径都经 {@link locate}，因此"第一次真正要用它"就是检查点。
   *
   * 只有**基础设施读不了**（`unreadable`）才算后端不可用并抛 `StorageUnavailableError`；
   * 单条记录损坏 / 待迁移是**数据问题**，它们在 `diagnose()` 的返回里照常报告，
   * 但让整个服务起不来比坏一条记录更糟。
   */
  private async ensureBackendHealthy(backend: StorageBackend): Promise<void> {
    if (this.healthy.has(backend)) return
    try {
      await assertStorageBackendHealthy(backend)
    } catch (error) {
      // 服务契约是"前置失败抛 PipelineRunError"（docs/10 §4.2）。原样放一个
      // `StorageUnavailableError` 出去，HTTP 外壳会把它归成 `run-failed`(500)——
      // 而它应当是 `storage-unavailable`(503)：运维动作完全不同。
      throw toPipelineRunError(error, 'storage-unavailable')
    }
    this.healthy.add(backend)
  }

  /** 解析流水线所在项目、检查点路径与运行清单，并校验调用者作用域。 */
  private async locate(
    pipelineId: string,
    actor: ActorContext,
    options: { readonly allowCreating?: boolean } = {},
  ): Promise<{
    readonly manifest: PipelineRunManifest
    readonly config: PipelineConfig
    readonly backend: StorageBackend
    readonly checkpointRoot: string
    /** checkpoints 根（不含 pipelineId）：锁路径由它与 pipelineId 一起拼出。 */
    readonly checkpointBase: string
  }> {
    const manifest = await this.requireIndex(pipelineId, options.allowCreating === true)
    const config = await this.configOf(manifest.configRef)
    // 索引与配置漂移（改配置里的 projectId 后没重建索引）在这里被拦下，而不是串到别的项目目录。
    this.assertScope(config, manifest.projectId, actor, { kind: 'hide', pipelineId })
    const backend = this.backendOf(config)
    await this.ensureBackendHealthy(backend)
    const roots = resolvePlatformRoots(this.options.dataRoot, config)
    return {
      manifest,
      config,
      backend,
      checkpointRoot: join(roots.checkpointRoot, pipelineId),
      checkpointBase: roots.checkpointRoot,
    }
  }

  /**
   * 取得该流水线的运行锁（docs/10 §6.3 M2-1/M2-2）。
   *
   * 走 `backend.ports.lock` 而不是直接调 `acquirePipelineLock`（docs/11 P1-09）：
   * 外部后端把互斥映射到 advisory lock / `SETNX`，语义不变（抢不到抛
   * `PipelineLockHeldError`）。文件后端的工厂已经绑定了检查点根，因此调用方
   * 只给 pipelineId——这正是 M2 修掉的"三个入口拼出三条不同路径 = 等于没锁"。
   *
   * 抢不到锁时抛 `conflict`(409) 而不是 500：这是"别人正在跑"，不是服务故障。
   */
  private async acquireRunLock(backend: StorageBackend, pipelineId: string): Promise<PipelineLock> {
    const factory = backend.ports.lock
    if (factory === undefined) {
      throw new PipelineRunError('storage-unavailable', `存储后端 ${backend.name} 未提供 lock 端口：无法保证同一条流水线不被并发运行`, {
        backend: backend.name,
      })
    }
    try {
      return await factory(pipelineId, {
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
    const { config, backend, checkpointRoot } = await this.locate(pipelineId, actor)
    return { config, checkpoint: await this.requireCheckpoint(backend, pipelineId, checkpointRoot) }
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
    config: PipelineConfig,
    projectRoot: string,
    namespace: string,
    key: string,
    fingerprint: string,
    produce: () => Promise<T>,
  ): Promise<T> {
    // 台账优先走**该项目的后端端口**（docs/11 §二「事实来源统一」）：否则换后端之后
    // 检查点在后端里、台账还在本地盘上，多副本各记各的，幂等静默失效。
    const backend = this.backendOf(config)
    const records = backend.ports.records
    if (records === undefined && backend.describe().requiresExternalInfrastructure) {
      // **失败关闭**（docs/14 W2 第 3 条）：声明依赖外部基础设施的后端却不提供 `records`，
      // 说明它的端口面不完整。此时回退到本地文件会让"检查点在外部后端、台账在本地磁盘"，
      // 多副本各记各的 —— 幂等静默失效，且**没有任何报错**。宁可 503。
      throw new PipelineRunError(
        'storage-unavailable',
        `后端 ${backend.name} 声明依赖外部基础设施，但未提供 records 端口：`
        + '幂等台账会静默落回本地磁盘，多副本之间不再共享同一份幂等事实',
        { backend: backend.name },
      )
    }
    // 非外部后端（file/memory/自定义本地后端）仍允许 legacy 文件回退：它与其它端口
    // 落在同一台机器上，不产生跨副本分裂。文件后端本身已提供 `records`，因此这条
    // 回退在实践中只服务于"没实现 records 的自定义本地后端"。
    const ledger: IdempotencyLedger = records === undefined
      ? fileIdempotencyLedger(idempotencyDir(projectRoot))
      : hostRecordIdempotencyLedger(records)
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

  /**
   * 配置声明的租户/项目必须与调用者一致（跨项目读取在此被拒）。
   *
   * **跨作用域读取按"不存在"回应，而不是 403**（docs/11 M5 安全门槛 3）。
   * 用 403 区分"存在但不是你的"与"不存在"，等于给了一个**枚举通道**：
   * 攻击者拿任意合法身份反复试，就能画出别人的 pipelineId 地图，
   * 并从"expected demo, got other-project"里读出对方属于哪个项目。
   *
   * 代价是运维少了一条"这是别人的项目"的直接提示——那份可诊断性由**服务端日志**
   * 承担（错误详情里带 `reason: 'scope'`），不出现在响应里。
   *
   * 项目白名单（`assertProjectAllowed`）仍然抛 `scope-mismatch`：那是调用者**自己声明的**
   * 输入与自己的配置不符，回显它不泄露任何别人的信息。
   */
  private assertScope(
    config: PipelineConfig,
    projectId: string,
    actor: ActorContext,
    /**
     * 不匹配时的回应方式。
     *
     * - `hide`：读**既有**流水线时用。按"不存在"回应，防止用 403/404 的差别枚举
     *   别人的 pipelineId（docs/11 M5 安全门槛 3）。
     * - `expose`：**创建**时用。此时不匹配的是调用者自己声明的 `projectId` 与自己的
     *   `configRef` 指向的配置——回显它不泄露任何别人的信息，而且这是纠错必需的信息。
     */
    onMismatch: { readonly kind: 'hide'; readonly pipelineId: string } | { readonly kind: 'expose' },
  ): void {
    assertProjectAllowed(actor, projectId)
    try {
      // 只比较**调用者能够声明**的维度：项目与租户。
      //
      // `scope.environment` 刻意不参与比较：它是**部署维度**（由服务端配置决定），
      // 不在 `ActorContext` 里、调用者无法声明它，`projectDataRoot` 推导项目目录时
      // 也只用租户与项目。把它放进比较的后果不是"更严格"，而是**任何声明了
      // `scope.environment` 的配置永久不可用**（`expected staging, got (missing)`），
      // 示例配置 `examples/pipeline.yaml` 正是这种情况。
      // 参数顺序很关键：`expected` 必须是**调用者自己的**作用域。
      // 反过来的话，`assertScopeMatch` 的消息（它只回显 `expected`）就会把**目标**的
      // 项目/租户标识打出来——正好泄露了它本该隐藏的东西。
      assertScopeMatch(
        { projectId, ...(actor.tenantId === undefined ? {} : { tenantId: actor.tenantId }) },
        {
          projectId: config.projectId,
          ...(config.scope?.tenantId === undefined ? {} : { tenantId: config.scope.tenantId }),
        },
      )
    } catch (error) {
      if (onMismatch.kind === 'expose') throw toPipelineRunError(error, 'scope-mismatch')
      // 诊断性由**服务端日志**承担（详情里带 `reason: 'scope'`），不出现在响应里。
      throw new PipelineRunError('not-found', `未登记的 pipeline：${onMismatch.pipelineId}`, {
        pipelineId: onMismatch.pipelineId,
        reason: 'scope',
      })
    }
  }

  /**
   * 宿主装配选项。
   *
   * 运行参数一律来自**持久化清单**而不是请求参数或进程内状态（docs/11 P1-01）：
   * `run` 可能在另一个进程里、也可能在几天后的重启之后发生，那时唯一还存在的
   * 事实就是磁盘上的清单。清单未声明的项才回落到 service 级默认值。
   */
  private hostOptions(
    config: PipelineConfig,
    manifest: PipelineRunManifest,
    pipelineId: string,
    callSignal?: AbortSignal,
  ): PlatformHostOptions {
    // 每次调用的信号与 service 级信号并列：任一中止即中止本次运行。
    // 这样取消某条流水线的后台运行不会连带取消同实例上其他流水线的运行。
    const signal = combineSignals(this.options.signal, callSignal)
    const gateWaitTimeoutMs = manifest.gateWaitTimeoutMs ?? this.options.defaultGateWaitTimeoutMs ?? 0
    const gateTaskTtlMs = manifest.gateTaskTtlMs ?? this.options.defaultGateTaskTtlMs
    const diagCredentials = manifest.diagCredentials
    return {
      config,
      dataRoot: this.options.dataRoot,
      pipelineId,
      ...(manifest.rulesetVersion === undefined ? {} : { rulesetVersion: manifest.rulesetVersion }),
      ...(manifest.requirementInput === undefined ? {} : { receiveInput: manifest.requirementInput }),
      ...(manifest.providerName === undefined ? {} : { providerName: manifest.providerName }),
      ...(manifest.targetBaseUrl === undefined ? {} : { targetBaseUrl: manifest.targetBaseUrl }),
      ...(manifest.maxGateRetries === undefined ? {} : { maxGateRetries: manifest.maxGateRetries }),
      // `diagCredentials` 只存环境变量名；探针白名单由它推出，模型不能自行指定目标。
      ...(diagCredentials === undefined || diagCredentials.length === 0
        ? {}
        : { diagProbes: diagCredentials.map(target => ({ kind: 'credentials' as const, target })) }),
      // 缺省 0：HTTP handler 不在请求内挂住等真人裁决（docs/10 §5.4）。
      gateWaitTimeoutMs,
      ...(gateTaskTtlMs === undefined ? {} : { gateTaskTtlMs }),
      // executor 建连前复核用的同一份判据（docs/11 P1-01）：清单是磁盘文件，
      // 可能被篡改或来自旧版本，不能只信"创建时校验过一次"。
      assertTargetBaseUrl: this.assertTargetBaseUrl,
      assertResolvedTargetAllowed: this.assertResolvedTargetAllowed,
      // 宿主必须用**本服务缓存的那一个**后端（docs/11 P1-09），否则 Web 读一个事实源、
      // driver 写另一个。用包装过的工厂而不是直接透传，见 `cachedBackendFactory`。
      createStorageBackend: this.cachedBackendFactory(),
      ...(signal === undefined ? {} : { signal }),
    }
  }

  /** 门任务存储：路径经 `gateTaskStoreDir` 统一生成（docs/10 §4.3）。 */
  private async gateStoreOf(pipelineId: string, projectId: string | undefined, actor: ActorContext): Promise<{
    readonly store: HumanGateTaskStore
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
      store: this.backendOf(config).ports.gateTasks,
      config,
      projectRoot: roots.projectRoot,
    }
  }

  /** 读取门任务并校验它确实属于给定项目/流水线（防止跨流水线裁决）。 */
  private async requireGateTask(
    input: { readonly projectId?: string; readonly pipelineId: string; readonly gateTaskId: string },
    actor: ActorContext,
  ): Promise<{
    readonly store: HumanGateTaskStore
    readonly task: HumanGateTask
    readonly projectRoot: string
    /** 该流水线的配置：调用方（幂等台账）需要它来定位**同一个**存储后端。 */
    readonly config: PipelineConfig
  }> {
    assertSafeIdentifier(input.pipelineId, 'pipelineId')
    assertSafeIdentifier(input.gateTaskId, 'gateTaskId')
    const { store, projectRoot, config } = await this.gateStoreOf(input.pipelineId, input.projectId, actor)
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
    return { store, task, projectRoot, config }
  }

  /**
   * 读取检查点并校验它**确实属于**请求的那条流水线（docs/11 P2-01 剩余）。
   *
   * 为什么必须交叉校验：检查点路径由 `checkpointRoot/<pipelineId>` 拼出，因此正常情况下
   * 两者一致。但检查点是**磁盘文件**——被手工改坏、被别的进程写到错误位置、或来自一次
   * 失败的迁移时，内容里的 `pipelineId` 会与路径不一致。此时若继续按请求的 id 往下走，
   * 后续所有事实（产物路径、门任务归属、用量 scope）都会建立在一条错位的记录上。
   *
   * 归类为 `storage-unavailable` 而不是 `not-found`：真相是**登记记录损坏**，
   * 不是"这条流水线不存在"。报 `not-found` 会让运维去建一条新的，
   * 而正确动作是修复/清理这个文件。
   */
  private async requireCheckpoint(backend: StorageBackend, pipelineId: string, checkpointRoot: string): Promise<Checkpoint> {
    const checkpoint = await backend.ports.checkpoints.load(checkpointRoot)
    if (checkpoint === null) throw new PipelineRunError('not-found', '流水线不存在', { checkpointRoot })
    if (checkpoint.pipelineId !== pipelineId) {
      throw new PipelineRunError(
        'storage-unavailable',
        `检查点记录的 pipelineId（${checkpoint.pipelineId}）与请求的 ${pipelineId} 不一致：登记记录损坏或被放错了位置`,
        { checkpointRoot, expectedPipeline: pipelineId, actualPipeline: checkpoint.pipelineId },
      )
    }
    return checkpoint
  }

  // ── 内部：流水线索引（pipelineId → 作用域 + 配置引用）────────────────────────

  private async requireIndex(pipelineId: string, allowCreating = false): Promise<PipelineRunManifest> {
    const entry = await this.readIndex(pipelineId)
    if (entry === null) {
      throw new PipelineRunError('not-found', `未登记的 pipeline：${pipelineId}`, { pipelineId })
    }
    // `allowCreating` 只给**体检**用：排障恰恰要看"创建未完成"这种状态，
    // 若这里一律抛 conflict，体检就永远诊断不了最需要诊断的情况。
    if (entry.creationState === 'creating' && allowCreating) return entry
    // 创建中间态（索引已写、检查点未确认）**不能当成正常流水线**：
    // 它的检查点可能还不存在，继续往下走会得到莫名其妙的 not-found/storage-unavailable。
    // 这里给出**可操作**的答复，而不是把它混进 404（那会让运维以为"从来没建过"）。
    if (entry.creationState === 'creating') {
      throw new PipelineRunError('conflict', `流水线创建未完成：${pipelineId}`, {
        pipelineId,
        creationState: 'creating',
        hint: '上一次 create 在写入检查点前中断。用同一 pipelineId 重新 create 即可接管；'
          + '恢复扫描也会把它报成 creation-incomplete。',
      })
    }
    return entry
  }

  /**
   * 读运行清单（= 流水线索引）。
   *
   * 与 {@link scanPipelineIndex} **复用同一套校验**（docs/11 P2-01）：此前这里只做
   * `JSON.parse` + 类型断言，于是字段类型不对的清单会被当成合法记录继续用——
   * 一次磁盘损坏就变成"静默用默认参数跑"。
   *
   * 损坏一律抛 `storage-unavailable`：调用方没做错任何事（不是 400），这条流水线也
   * 确实存在（不是 404 谎称不存在），需要运维去修那条记录。
   */
  private async readIndex(pipelineId: string): Promise<PipelineRunManifest | null> {
    let parsed: unknown
    try {
      parsed = await this.indexStore.read(PIPELINE_INDEX_COLLECTION, pipelineId)
    } catch (error) {
      // 记录损坏（端口**必须抛**，不返回 null）→ 归成 `storage-unavailable`：
      // 调用方没做错任何事（不是 400），这条流水线也确实存在（不是 404 谎称不存在），
      // 需要运维去修那条记录。
      if (error instanceof StorageCorruptError) throw corruptIndex(pipelineId, errorMessageOf(error))
      throw error
    }
    if (parsed === null) return null
    if (!isIndexEntry(parsed)) throw corruptIndex(pipelineId, '字段缺失或类型不符')
    // 文件名才是权威键：清单里的 pipelineId 与文件名不一致说明记录被改写坏了，
    // 继续用它就会去解析另一个流水线的作用域与配置。
    if (parsed.pipelineId !== pipelineId) {
      throw corruptIndex(pipelineId, `清单 pipelineId 与文件名不一致：${parsed.pipelineId} ≠ ${pipelineId}`)
    }
    return parsed
  }

  /**
   * 写索引（`HostRecordStore.write` 由实现保证原子：任何时刻要么是旧版要么是新版）。
   */
  private async writeIndex(entry: PipelineRunManifest): Promise<void> {
    await this.indexStore.write(PIPELINE_INDEX_COLLECTION, entry.pipelineId, entry)
  }

  // ── 内部：视图重建（docs/10 §4.2 M0-3「必须能从 checkpoint/artifact store 重建页面状态」）──

  private async buildView(config: PipelineConfig, checkpoint: Checkpoint): Promise<PipelineRunView> {
    const roots = resolvePlatformRoots(this.options.dataRoot, config)
    const artifacts = this.backendOf(config).ports.artifacts
    const store = this.backendOf(config).ports.gateTasks
    const tasks = await store.list({ pipelineId: checkpoint.pipelineId })
    const status = deriveRunStatus(checkpoint, tasks)

    const stages = await Promise.all(STAGE_ORDER.map(async stageId => {
      const state = checkpoint.stageStates[stageId]!
      return buildStageView(stageId, state, stageTaskOf(tasks, stageId), await effectiveDigest(artifacts, state))
    }))

    // ── W3 派生字段（docs/14 W3）：全部由上面的事实算出，不引入任何新状态 ──────────
    //
    // `currentStage` 用**阶段状态**（第一个非 done）而不是游标推导：游标是编排实现细节，
    // 而界面要回答的是"用户此刻该看哪个阶段"。
    const currentStage = STAGE_ORDER.find(id => checkpoint.stageStates[id]!.status !== 'done') ?? null
    const currentStageStatus = currentStage === null ? null : checkpoint.stageStates[currentStage]!.status
    // 未决门 = 第一条 pending/claimed 的任务。注意它**可能是升级任务**（`artifactPath === ''`），
    // 因此必须带出种类，页面才能给出不同文案与操作集合。
    const openTask = tasks.find(task => task.status === 'pending' || task.status === 'claimed') ?? null
    const gateKind: GateTaskKind | null = openTask === null
      ? null
      : (openTask.artifactPath === '' ? 'escalation' : 'stage')
    const decision = deriveNextAction({
      status,
      currentStage,
      currentStageStatus,
      gateKind,
      gateStatus: openTask?.status ?? null,
    })

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
      openGateTaskId: openTask?.gateTaskId ?? null,
      reentries: checkpoint.reentries,
      failure: deriveRunFailure(status, checkpoint, tasks),
      currentStage,
      nextAction: decision.action,
      blockingReason: decision.reason,
      gateKind,
    }
  }

  /** 当前生效的阶段摘要：检查点值优先，缺失时回读产物文件（见 `effectiveDigest`）。 */
  private async digestOf(config: PipelineConfig, state: StageState): Promise<string> {
    return effectiveDigest(this.backendOf(config).ports.artifacts, state)
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
  // 交叉检查重试耗尽：与 gate-failed 同为**持久化终态**（docs/11 P1-06），
  // 因此恢复扫描不会把它当"续跑"重启，重跑必须显式 reenter。
  if (states.some(state => state.status === 'review-failed')) return 'review-failed'
  if (states.some(state => state.status === 'needs-fix')) return 'needs-fix'
  /**
   * 运行期异常（docs/14 W5 遗留项）：`service.run` 在 driver 抛异常时把它记到**当前阶段**
   * 的 `failures` 上。必须在 `running` 之前判——异常发生时阶段状态往往还停在 `running`，
   * 否则这条已经落盘的失败会被"看起来在跑"盖住。
   *
   * 判据刻意限定在**当前阶段**且**最后一条**失败，并排除 `done` / `needs-reentry`：
   * 否则一次历史异常会永久把状态钉在 `failed`，重入并重跑成功之后仍然显示失败。
   */
  const current = STAGE_ORDER[checkpoint.cursor]
  const currentState = current === undefined ? undefined : checkpoint.stageStates[current]
  if (currentState !== undefined
      && currentState.status !== 'done'
      && currentState.status !== 'needs-reentry'
      && currentState.failures[currentState.failures.length - 1]?.kind === 'run-error') {
    return 'failed'
  }

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
  if (status === 'review-failed') {
    const stageId = STAGE_ORDER.find(id => checkpoint.stageStates[id]!.status === 'review-failed')
    if (stageId === undefined) return null
    const last = lastFailureOf(checkpoint.stageStates[stageId]!)
    return { kind: 'review-failed', stageId, detail: last?.detail ?? '' }
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

/**
 * `diagCredentials` 只能是环境变量名（docs/10 §5.3 的 `env_diag` 固定探针白名单）。
 *
 * 校验放在 `create` 而不是留给 `env_diag` 执行时：一旦落进清单，它就成了
 * "宿主允许探测的目标"，而清单是长期事实。畸形取值（带路径分隔符、超长、
 * 空串）没有任何合法用途，必须在请求层拒绝。
 */
function assertDiagCredentials(values: readonly string[] | undefined): void {
  if (values === undefined) return
  if (!Array.isArray(values)) {
    throw new PipelineRunError('invalid-request', 'diagCredentials 必须是字符串数组')
  }
  for (const value of values) {
    if (typeof value !== 'string' || !ENV_VAR_NAME.test(value)) {
      throw new PipelineRunError('invalid-request', `diagCredentials 只接受环境变量名：${JSON.stringify(value)}`, {
        allowed: ENV_VAR_NAME.source,
      })
    }
  }
}

/** 环境变量名：与 `apiKeyEnv` 同一条约束，不接受空串、前导数字与路径分隔符。 */
const ENV_VAR_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/

/** 计数类运行参数：非负整数。负值或小数没有任何合法语义，按请求不合法拒绝。 */
function assertNonNegativeInteger(value: number | undefined, field: string): void {
  if (value === undefined) return
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new PipelineRunError('invalid-request', `${field} 必须是非负整数`, { field, value })
  }
}

/** 去掉首尾空白；空串与未声明等价（不把 `''` 写进清单冒充"已配置"）。 */
function nonEmptyText(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  return trimmed === undefined || trimmed === '' ? undefined : trimmed
}

/** 构造要落盘的运行清单：未声明的字段**不写**，不写假值。 */
function manifestOf(
  input: CreatePipelineRunInput,
  config: PipelineConfig,
  rulesetVersion: string,
): PipelineRunManifest {
  const requirementInput = nonEmptyText(input.requirementInput)
  const providerName = nonEmptyText(input.providerName)
  const targetBaseUrl = nonEmptyText(input.targetBaseUrl)
  const diagCredentials = input.diagCredentials === undefined || input.diagCredentials.length === 0
    ? undefined
    : [...input.diagCredentials]
  return {
    pipelineId: input.pipelineId,
    tenantId: config.scope?.tenantId ?? null,
    projectId: config.projectId,
    configRef: input.configRef,
    rulesetVersion,
    createdAt: Date.now(),
    ...(requirementInput === undefined ? {} : { requirementInput }),
    ...(providerName === undefined ? {} : { providerName }),
    ...(targetBaseUrl === undefined ? {} : { targetBaseUrl }),
    ...(input.maxGateRetries === undefined ? {} : { maxGateRetries: input.maxGateRetries }),
    ...(input.gateWaitTimeoutMs === undefined ? {} : { gateWaitTimeoutMs: input.gateWaitTimeoutMs }),
    ...(input.gateTaskTtlMs === undefined ? {} : { gateTaskTtlMs: input.gateTaskTtlMs }),
    ...(diagCredentials === undefined ? {} : { diagCredentials }),
  }
}

/**
 * 幂等指纹字段。
 *
 * 必须与 {@link manifestOf} 落盘的字段**一一对应**：少一个就会出现"换了参数却重放
 * 首次结果"，多一个则会让"改了不影响运行的字段"的重试误报冲突。因此两者放在一起，
 * 改动时不可能只改一边。
 */
function createFingerprintFields(
  input: CreatePipelineRunInput,
  projectId: string,
  rulesetVersion: string,
): IdempotencyField[] {
  return [
    projectId,
    input.pipelineId,
    input.configRef,
    rulesetVersion,
    nonEmptyText(input.requirementInput) ?? '',
    nonEmptyText(input.providerName) ?? '',
    nonEmptyText(input.targetBaseUrl) ?? '',
    input.maxGateRetries ?? '',
    input.gateWaitTimeoutMs ?? '',
    input.gateTaskTtlMs ?? '',
    ...(input.diagCredentials ?? []),
  ]
}

/** 清单损坏：不是调用方的错（不是 400），也不能谎称"流水线不存在"（不是 404）。 */
function corruptIndex(pipelineId: string, detail: string): PipelineRunError {
  return new PipelineRunError('storage-unavailable', `流水线登记记录损坏（${pipelineId}）：${detail}`, { pipelineId })
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

