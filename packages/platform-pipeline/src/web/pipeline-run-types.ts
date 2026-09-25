/**
 * Web/HTTP 可调用的流水线运行服务契约（docs/10 §4.2 M0-2、§4.2 M0-3、§5.3）。
 *
 * 本文件只定义**类型与错误映射**，不接任何 HTTP 框架：路由、鉴权中间件和响应序列化
 * 由 `web-app/server.mjs` 负责。因此同一套契约既能被 HTTP 外壳消费，也能被 CLI 或
 * 测试直接调用（docs/10 §4.3：service 层可以用 ScriptedStageRunner 和临时目录单测，
 * 不需要启动 Web server）。
 *
 * 三条约束（docs/10 §1「明确保留的原则」）：
 * - **不伪装**：无法从持久化事实推导的字段一律返回 `null`，不生成看似成功的占位值；
 * - **不越权**：scope 校验在 service 层强制完成，不接受调用方自报的租户/项目；
 * - **不泄露凭据**：provider API Key 只存在于宿主进程环境变量中，绝不进入返回值、
 *   错误详情或日志（docs/10 §2.2、§4.3）。
 *
 * @module platform-pipeline/web/pipeline-run-types
 */

import type { HumanGateTaskStatus } from '../runtime/persistence.ts'
import { isStorageInfrastructureError, type StorageUnavailableError } from '../storage/ports.ts'
import type { CheckpointStatus, InputLocks, ReentryRecord, StageId } from '../types.ts'

// ── 作用域与身份（docs/10 §10 P0-A「明确 actor/tenant/project/pipeline scope 类型」）──

/**
 * 流水线作用域：租户 → 项目 → 流水线（docs/10 §4.2 M0-3、§5.3）。
 *
 * `tenantId` 可选，缺省时由 `platform-scope.ts` 归一到 `default`；`projectId` 与
 * `pipelineId` 必须贯穿产物、人工门任务、知识库与执行数据，是全部路径推导的输入。
 */
export interface PipelineScope {
  readonly tenantId?: string
  readonly projectId: string
  readonly pipelineId: string
}

/**
 * 调用者角色。
 *
 * 权限判定（docs/10 §5.3「校验 actor 是否有该项目的人工门权限」）：
 * - `get` / `listGateTasks`：只要求 `actorId` 非空；
 * - `claimGate` / `decideGate`：要求 `reviewer` 或 `admin`；
 * - `reenter` / `cancelGate`：要求 `operator` 或 `admin`。
 *
 * 判定是**失败关闭**的：缺少 `roles` 即视为无特权，不会因为字段缺省而放行。
 */
export type ActorRole = 'viewer' | 'reviewer' | 'operator' | 'admin'

/**
 * 调用者身份。人工门的 claim/decide/cancel 与重入都要把 `actorId` 写进审计记录。
 *
 * `projectIds` 非空时即为项目白名单：不在列表内一律拒绝（防止跨项目读取）。
 * `roles` 缺省时特权操作直接拒绝——宿主鉴权层必须显式填充，而不是靠"没传就是管理员"。
 */
export interface ActorContext {
  readonly actorId: string
  /** 调用者所属租户；与配置 `scope.tenantId` 不一致时拒绝（docs/10 §4.2「身份和项目作用域校验」）。 */
  readonly tenantId?: string
  readonly projectIds?: readonly string[]
  readonly roles?: readonly ActorRole[]
}

// ── Web 状态模型（docs/10 §4.2 M0-3）──────────────────────────────────────────

/**
 * Web 运行状态。必须**直接映射**检查点与人工门任务状态，不得自造状态机。
 *
 * 映射口径（`PipelineRunService` 实现，`checkpoint.cursor` = 下一个待执行阶段下标）：
 *
 * | Web 状态 | 来源事实 |
 * |---|---|
 * | `queued` | 检查点不存在或 `cursor === 0` 且首阶段仍 `idle` |
 * | `running` | 任一阶段 `running`/`produced`/`needs-fix`（且未被人工门挂起） |
 * | `waiting-human` | 任一阶段 `awaiting-gate` |
 * | `needs-fix` | 当前阶段 `needs-fix`（门禁或审核回喂重跑中） |
 * | `gate-failed` | 任一阶段 `gate-failed` |
 * | `rejected` | 任一阶段 `awaiting-gate` 且最近人工门任务 `status === 'rejected'` |
 * | `completed` | `cursor === STAGE_ORDER.length` 且全阶段 `done` |
 * | `failed` | 运行抛出异常且检查点未落入上述任一终态 |
 * | `cancelled` | 人工门等待被 `AbortSignal` 中止，或门任务被外部取消 |
 */
export type PipelineRunStatus =
  | 'queued'
  | 'running'
  | 'waiting-human'
  | 'needs-fix'
  | 'gate-failed'
  | 'rejected'
  | 'completed'
  | 'failed'
  | 'cancelled'

/** 机器门禁违规项（与 `Violation` 同构，去掉 `at` 以免页面误当阶段时间线）。 */
export interface StageViolationView {
  readonly rule: string
  readonly level: 'BLOCKING' | 'WARNING'
  readonly detail: string
}

/**
 * 阶段失败摘要（取 `StageState.failures` 的最后一条）。
 * `at` 是检查点里持久化的真实时间戳，不是服务端观测时间。
 */
export interface StageFailureView {
  readonly kind: string
  readonly rule: string | null
  readonly detail: string | null
  readonly at: number
}

/**
 * 阶段视图（docs/10 §4.2 M0-3 的 12 个字段，缺一不可）。
 *
 * 全部字段都必须能**从持久化事实重建**（检查点 + 产物 + 人工门任务），
 * 不允许只回放进程内存里的文本产物：
 *
 * | 字段 | 事实来源 |
 * |---|---|
 * | `stageId` / `status` / `artifactPath` / `digest` | `Checkpoint.stageStates[stageId]` |
 * | `machineStatus` / `machineViolations` | `StageState.gate.machine` |
 * | `reviewVerdict` / `reviewFindings` | 该阶段最近一条人工门任务的 `review` |
 * | `humanGateTaskId` | 该阶段最近一条人工门任务（等待中即为待裁决那条） |
 * | `failure` | `StageState.failures` 最后一条 |
 * | `startedAt` | 该阶段最近一条人工门任务的 `createdAt`（= 产物送审时刻） |
 * | `finishedAt` | 该门任务的 `decision.at ?? cancellation.at` |
 *
 * `startedAt`/`finishedAt` 在**没有人工门任务时返回 `null`**，而不是用服务端当前时间
 * 冒充阶段时间（不伪装）。M3 会引入权威的阶段耗时遥测（docs/10 §3），届时替换来源。
 */
export interface StageView {
  readonly stageId: StageId
  readonly status: CheckpointStatus
  readonly artifactPath: string
  readonly digest: string
  readonly machineStatus: 'passed' | 'failed'
  readonly machineViolations: readonly StageViolationView[]
  readonly reviewVerdict: string | null
  readonly reviewFindings: readonly string[]
  readonly humanGateTaskId: string | null
  readonly startedAt: number | null
  readonly finishedAt: number | null
  readonly failure: StageFailureView | null
}

/** 流水线级失败摘要。`detail` 取自持久化事实（门禁违规 / 审核 findings / 异常消息）。 */
export interface PipelineRunFailure {
  readonly kind: 'gate-failed' | 'review-failed' | 'rejected' | 'cancelled' | 'error'
  readonly stageId: StageId | null
  readonly detail: string
}

/**
 * 阶段产物视图（`GET /api/pipelines/:pipelineId/stages/:stageId/artifact`，docs/10 §5.3）。
 *
 * 直接回读产物文件（`FsArtifactStore.read`），不做任何补齐或推断：
 * `version` / `inputs` 缺省时由 `wrapContent` 补成 `1` / `{}`，因此页面看到的是
 * 「磁盘上这条产物是什么」，而不是「服务端以为它应该是什么」。
 *
 * `artifactPath` 是**相对产物根**的路径（如 `artifacts/pipe-1/receive.json`），
 * 不返回服务器绝对路径（docs/10 §5.3 不泄露部署布局）。
 */
export interface StageArtifactView {
  readonly pipelineId: string
  readonly stageId: StageId
  readonly artifactPath: string
  readonly digest: string
  readonly version: number
  readonly inputs: InputLocks
  readonly content: unknown
}

/**
 * 事件类型（`GET /api/pipelines/:pipelineId/events`，docs/10 §5.3）。
 *
 * 只覆盖**有持久化时间戳**的事实：
 *
 * | 事件 | 时间戳来源 | 执行者来源 |
 * |---|---|---|
 * | `gate-opened` | `HumanGateTask.createdAt` | 无（系统开门） |
 * | `gate-claimed` | `HumanGateTask.lease.acquiredAt` | `claimedBy` |
 * | `gate-decided` | `decision.at` | `decision.by` |
 * | `gate-cancelled` | `cancellation.at` | `cancellation.by` |
 * | `gate-consumed` | `consumedAt` | 无（编排器消费） |
 * | `stage-failure` | `StageState.failures[].at` | 无 |
 * | `reenter` | `ReentryRecord.at` | `ReentryRecord.by` |
 *
 * M3 会引入权威的运行遥测（LLM 调用、工具步骤、耗时，docs/10 §7），届时事件流
 * 会以那套数据为准；在那之前本投影就是"能从磁盘重建的全部时间线"。
 */
export type PipelineEventKind =
  | 'gate-opened'
  | 'gate-claimed'
  | 'gate-decided'
  | 'gate-cancelled'
  | 'gate-consumed'
  | 'stage-failure'
  | 'reenter'

/**
 * 一条事件。
 *
 * `at` 一律来自持久化时间戳，**不是**服务端观测时间；因此同一条流水线的
 * 事件流在重启后、在不同进程里读到的顺序与时间完全一致。
 */
export interface PipelineEventView {
  readonly kind: PipelineEventKind
  readonly at: number
  readonly stageId: StageId | null
  /** 关联的人工门任务 id；`stage-failure` / `reenter` 为 `null`。 */
  readonly gateTaskId: string | null
  /** 执行者；系统产生的事件（开门、消费、失败）为 `null`。 */
  readonly actorId: string | null
  readonly detail: string
}

/**
 * 流水线运行视图（`GET /api/pipelines/:pipelineId`，docs/10 §5.3）。
 *
 * 事实来源是检查点 + 产物 + 人工门任务；进程内运行句柄（`pipeline-run-registry.ts`）
 * 只保存后台句柄和取消信号，**不能作为唯一状态**。
 */
export interface PipelineRunView {
  readonly pipelineId: string
  readonly tenantId: string | null
  readonly projectId: string
  readonly status: PipelineRunStatus
  readonly cursor: number
  readonly nextStage: StageId | null
  readonly templateVersion: string
  readonly rulesetVersion: string
  readonly stages: readonly StageView[]
  /** 当前待裁决的人工门任务 id（无则 `null`）；页面据此渲染裁决入口。 */
  readonly openGateTaskId: string | null
  readonly reentries: readonly ReentryRecord[]
  readonly failure: PipelineRunFailure | null
}

/**
 * 创建结果（`POST /api/projects/:projectId/pipelines` 的 `202` 响应体，docs/10 §5.3）。
 *
 * 只含可推导事实：不返回 `dataRoot`/`checkpointRoot` 等服务器绝对路径，避免向浏览器
 * 泄露部署布局。
 */
export interface PipelineRunSummary {
  readonly pipelineId: string
  readonly tenantId: string | null
  readonly projectId: string
  readonly configRef: string
  readonly status: PipelineRunStatus
  readonly nextStage: StageId | null
}

// ── 请求类型（docs/10 §5.3）──────────────────────────────────────────────────

/**
 * 创建流水线请求。对应 `POST /api/projects/:projectId/pipelines` 的请求体。
 *
 * **不含 API Key**：provider 凭据由服务端按配置里的 `apiKeyEnv` 从环境变量注入
 * （docs/10 §5.3「API Key 由服务端环境变量按 `apiKeyEnv` 注入，不从浏览器表单传递」）。
 * `dataRoot` 同样不在请求体里，它是 service 构造参数（服务端部署配置）。
 */
export interface CreatePipelineRunInput {
  readonly projectId: string
  readonly pipelineId: string
  /** 配置引用；由 service 注入的配置解析器转成实际配置路径。 */
  readonly configRef: string
  /** receive 阶段的输入文件路径（降级链末级）。 */
  readonly requirementInput?: string
  readonly providerName?: string
  /** 被测服务基址；经 SSRF 校验后才允许执行（docs/10 §5.3）。 */
  readonly targetBaseUrl?: string
  readonly rulesetVersion?: string
  readonly maxGateRetries?: number
  /** 人工门等待上限；`0` = 只轮询一次就让出控制权（挂起模式）。 */
  readonly gateWaitTimeoutMs?: number
  readonly gateTaskTtlMs?: number
  /** `env_diag` 的固定探针白名单（模型不能自行指定目标）。 */
  readonly diagCredentials?: readonly string[]
}

/** 运行结果（`POST /api/pipelines/:pipelineId/run`）。 */
export type RunResult =
  | { readonly outcome: 'completed'; readonly view: PipelineRunView }
  | { readonly outcome: 'waiting-human'; readonly stageId: StageId; readonly gateTaskId: string; readonly view: PipelineRunView }
  | { readonly outcome: 'rejected'; readonly stageId: StageId; readonly view: PipelineRunView }
  | { readonly outcome: 'gate-failed'; readonly stageId: StageId; readonly view: PipelineRunView }
  | { readonly outcome: 'review-failed'; readonly stageId: StageId; readonly view: PipelineRunView }
  | { readonly outcome: 'cancelled'; readonly view: PipelineRunView }
  | { readonly outcome: 'failed'; readonly error: PipelineRunErrorView; readonly view: PipelineRunView }

/** 重入请求（`POST /api/pipelines/:pipelineId/reenter`，docs/10 §5.3）。 */
export interface ReenterInput {
  /**
   * 可选：调用方自报的项目。
   *
   * 作用域**不由本字段决定**——`reenter` 用 `pipelineId` 从流水线索引反解项目与配置，
   * 再用 `ActorContext` 做越权判定（docs/10 §5.3）。因此本字段仅用于调用方自查，
   * 填错也不会放宽或收紧任何权限（这正是 docs/10 §5.3 示例里没有它的原因）。
   */
  readonly projectId?: string
  readonly pipelineId: string
  readonly stageId: StageId
  readonly reason: string
  /**
   * 页面加载时的当前阶段 digest。用于防止页面打开过久后把其他人的新版本覆盖掉：
   * 与检查点中的 digest 不一致时以 `conflict` 拒绝（docs/10 §5.3）。
   */
  readonly expectedCurrentDigest?: string
}

/**
 * 人工门任务过滤（`GET /api/pipelines/:pipelineId/gates`）。
 *
 * `projectId` 可选：HTTP 路径里只有 `pipelineId`，项目由索引反解（docs/10 §5.3）。
 * 提供时作为**额外的**一致性校验，不匹配即拒（防止调用方把两个不同流水线的
 * 项目/流水线标识拼在一起）。
 */
export interface GateTaskFilter {
  readonly projectId?: string
  readonly pipelineId: string
  readonly status?: HumanGateTaskStatus
}

/** 认领人工门任务（`POST /api/gates/:gateTaskId/claim`）。 */
export interface GateClaimInput {
  readonly projectId?: string
  /** 必填：跨流水线裁决的唯一防线（任务记录里的 pipelineId 必须与它一致）。 */
  readonly pipelineId: string
  readonly gateTaskId: string
  /** 租约时长；缺省由 store 决定。 */
  readonly ttlMs?: number
}

/**
 * 裁决人工门任务（`POST /api/gates/:gateTaskId/decide`）。
 *
 * `action` 必须显式传入（docs/10 §5.3）：不存在"缺省即批准"的路径。
 * 返回值中的 `consumedAt` 表达「裁决被编排器消费之前/之后」的差异——未被消费表示
 * 下一次 `run` 会认这条结论，已消费表示这条裁决已经驱动过一次门，不会再复用。
 */
export interface GateDecisionInput {
  readonly projectId?: string
  /** 必填：跨流水线裁决的唯一防线。 */
  readonly pipelineId: string
  readonly gateTaskId: string
  readonly action: 'approved' | 'changes-needed' | 'rejected'
  /** `changes-needed` / `rejected` 必须非空（store 层强制）。 */
  readonly note?: string
  /**
   * 页面加载时看到的任务 `updatedAt`。与磁盘上的当前值不一致时以 `conflict` 拒绝，
   * 避免覆盖他人的裁决（docs/10 §5.3「不允许覆盖已经 consumed 的裁决」）。
   */
  readonly expectedUpdatedAt?: number
  /**
   * 幂等标识（docs/10 §6.3 M2-3：human gate decision 的键 = `gateTaskId/decisionId`）。
   *
   * **由调用方生成**（一次裁决意图一个 id，重试沿用同一个）。服务端生成不了：
   * 重试请求与首次请求在服务端看起来完全一样，只有调用方知道自己"又发了一次"。
   *
   * 缺省 = 不启用幂等，行为与 M2 之前完全一致（终态 → `gate-not-decidable`，
   * 已消费 → `gate-consumed`）。带上它以后，同一个 `(gateTaskId, decisionId)`
   * 的重复投递会**重放首次裁决结果**，不再报错、也不会二次驱动门（§6.4）。
   */
  readonly decisionId?: string
}

/** 取消人工门任务（`POST /api/gates/:gateTaskId/cancel`）。 */
export interface GateCancelInput {
  readonly projectId?: string
  /** 必填：跨流水线取消的唯一防线。 */
  readonly pipelineId: string
  readonly gateTaskId: string
  readonly note?: string
}

// ── 错误映射（docs/10 §10 P0-A「新增 PipelineRunService 类型和错误映射」）────────

/**
 * 服务层错误码。只覆盖**前置校验与已知失败路径**：运行期失败（门禁失败、审核失败、
 * 拒绝、异常）由 `RunResult` 表达，不抛异常。
 */
export type PipelineRunErrorCode =
  /** 请求体字段缺失/类型非法（如空 pipelineId、非法 stageId）。 */
  | 'invalid-request'
  /** 调用者身份缺失（空 actorId）。 */
  | 'unauthenticated'
  /** 角色不足（人工门裁决要求 reviewer/admin，重入与取消要求 operator/admin）。 */
  | 'forbidden'
  /** 调用者租户/项目与配置或路径不一致（跨项目读取）。 */
  | 'scope-mismatch'
  /** 流水线或人工门任务不存在。 */
  | 'not-found'
  /** 流水线标识已被占用，或 `expectedCurrentDigest` / `expectedUpdatedAt` 不匹配。 */
  | 'conflict'
  /** 门任务不可认领（已裁决、已终态，或被他人持有有效租约）。 */
  | 'gate-not-claimable'
  /** 门任务不可裁决（未持有 claim，或已终态）。 */
  | 'gate-not-decidable'
  /** 裁决已被消费，不允许再次驱动门。 */
  | 'gate-consumed'
  /** pipeline 配置缺失或非法。 */
  | 'config-invalid'
  /** 配置声明的 provider 无法解析（缺环境变量、能力不满足）。 */
  | 'provider-unavailable'
  /**
   * 存储后端不可用（基础设施故障）。
   *
   * 与 `run-failed` 分开的理由（docs/10 §8.4）：这不是"流水线跑失败了"，
   * 而是"这台存储用不了了"。运维动作完全不同（前者看产物与规则，后者修基础设施），
   * 而且它**绝不能**被解读成"阶段需要人工批准"。
   */
  | 'storage-unavailable'
  /** 其他未归类的运行期异常。 */
  | 'run-failed'

/** 错误码 → HTTP 状态码。service 层不接 HTTP，但保留映射意图供路由层直接使用。 */
export const PIPELINE_RUN_ERROR_HTTP_STATUS: Readonly<Record<PipelineRunErrorCode, number>> = {
  'invalid-request': 400,
  'unauthenticated': 401,
  forbidden: 403,
  'scope-mismatch': 403,
  'not-found': 404,
  conflict: 409,
  'gate-not-claimable': 409,
  'gate-not-decidable': 409,
  'gate-consumed': 409,
  'config-invalid': 422,
  'provider-unavailable': 503,
  'storage-unavailable': 503,
  'run-failed': 500,
}

/** 可序列化的错误视图（返回值与日志用；`details` 已经过凭据脱敏）。 */
export interface PipelineRunErrorView {
  readonly code: PipelineRunErrorCode
  readonly message: string
  readonly details: Readonly<Record<string, unknown>>
}

/**
 * 服务层错误。
 *
 * `details` 在构造时**不做脱敏**（保留调用栈内的原始上下文），但 `toJSON()` 与
 * `toView()` 会先脱敏再输出——因此序列化到 HTTP 响应或日志时不会带出 API Key。
 */
export class PipelineRunError extends Error {
  readonly code: PipelineRunErrorCode
  readonly details: Readonly<Record<string, unknown>>

  constructor(code: PipelineRunErrorCode, message: string, details: Readonly<Record<string, unknown>> = {}) {
    super(message)
    this.name = 'PipelineRunError'
    this.code = code
    this.details = details
  }

  get httpStatus(): number {
    return PIPELINE_RUN_ERROR_HTTP_STATUS[this.code]
  }

  /** 脱敏后的可序列化视图。 */
  toView(): PipelineRunErrorView {
    return {
      code: this.code,
      message: this.message,
      details: redactSecrets(this.details) as Readonly<Record<string, unknown>>,
    }
  }

  toJSON(): PipelineRunErrorView & { readonly httpStatus: number } {
    return { ...this.toView(), httpStatus: this.httpStatus }
  }
}

/**
 * 凭据类字段名（大小写不敏感）。命中即整体替换为 `[redacted]`。
 *
 * 覆盖 `apiKey` / `api_key` / `api-key`、`Authorization`、`Bearer`、`token`、`secret`、
 * `password`、`credential`——即 docs/10 §2.2 禁止进入检查点、任务、日志和返回 JSON 的字段。
 */
const SECRET_FIELD_PATTERN = /(api[-_]?key|authorization|bearer|token|secret|password|credential)/i

/**
 * 递归脱敏：字段名命中 {@link SECRET_FIELD_PATTERN} 的值整体替换；字符串中的
 * `sk-...` 形态 token 也替换，避免凭据藏在消息文本里。
 */
export function redactSecrets(value: unknown): unknown {
  if (typeof value === 'string') return value.replace(/\b(?:sk|Bearer)[-_][A-Za-z0-9._-]{8,}/gi, '[redacted]')
  if (Array.isArray(value)) return value.map(item => redactSecrets(item))
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] = SECRET_FIELD_PATTERN.test(key) ? '[redacted]' : redactSecrets(item)
    }
    return out
  }
  return value
}

/** 把未知异常归一成可展示的文本（不吞掉非 Error 值）。 */
export function errorMessageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * 把端口层抛出的原始异常映射成服务层错误码。
 *
 * 映射依据是**实现层已有的报错文本**（`runtime/persistence.ts` 的
 * `HumanGateTaskStore`、`runtime/persistent-human-gate.ts`、`config.ts`），
 * 而不是臆测的异常类型——因此端口换成数据库实现后仍能命中同一套语义。
 * 未识别的异常一律落到 `run-failed`，绝不静默降级成成功。
 */
export function toPipelineRunError(error: unknown, fallback: PipelineRunErrorCode = 'run-failed'): PipelineRunError {
  if (error instanceof PipelineRunError) return error
  // 存储基础设施故障走**类型判据**而不是文本匹配：它是跨后端的语义（file 是磁盘、
  // postgres 是连接池），靠中文报错文本去认会在换后端时静默失效。
  if (isStorageInfrastructureError(error)) {
    const storage = error as StorageUnavailableError
    return new PipelineRunError('storage-unavailable', errorMessageOf(error), { backend: storage.backend, operation: storage.operation })
  }
  const message = errorMessageOf(error)
  const code = classifyMessage(message, fallback)
  return new PipelineRunError(code, message)
}

function classifyMessage(message: string, fallback: PipelineRunErrorCode): PipelineRunErrorCode {
  if (/human gate task not found|task not found|配置不存在|no such file/i.test(message)) return 'not-found'
  if (/is not claimable|is leased by|claimed by/i.test(message)) return 'gate-not-claimable'
  if (/requires the active claim owner|is not cancellable|is not decidable/i.test(message)) return 'gate-not-decidable'
  if (/is not consumable|already consumed/i.test(message)) return 'gate-consumed'
  if (/scope mismatch|escapes project data root|must be a safe identifier/i.test(message)) return 'scope-mismatch'
  if (/必填|must be|invalid|非法|must not be empty/i.test(message)) return 'invalid-request'
  if (/缺少 llm\.providers|provider|apiKeyEnv|capabilit/i.test(message)) return 'provider-unavailable'
  if (/配置|config|templateVersion|未实现规则/i.test(message)) return 'config-invalid'
  return fallback
}
