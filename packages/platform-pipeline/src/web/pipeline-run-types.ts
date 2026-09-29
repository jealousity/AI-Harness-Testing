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

import type { HumanGateTask, HumanGateTaskStatus } from '../runtime/persistence.ts'
import { GateTaskBusyError } from '../runtime/persistence.ts'
import { isStorageInfrastructureError, type StorageDiagnostic, type StorageUnavailableError } from '../storage/ports.ts'
import type { CheckpointStatus, InputLocks, ReentryRecord, StageId } from '../types.ts'
import type { PipelineRecord, PipelineRevision, PipelineRun } from './pipeline-model.ts'

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
 * | `review-failed` | 任一阶段 `review-failed`（交叉检查重试耗尽；持久化终态） |
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
  | 'review-failed'
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

/**
 * 流水线的**运行参数**（清单里可编辑的那部分）。
 *
 * 只在 `get()` 的返回值上出现（列表与运行结果不需要它，因此视图里是可选字段）。
 * 页面用它**预填编辑表单**——没有它就只能让用户盲填，而"留空 = 不修改"会让
 * 用户无法确认当前值到底是什么。
 */
export interface PipelineRunParams {
  readonly requirementInput?: string
  readonly providerName?: string
  readonly targetBaseUrl?: string
  readonly rulesetVersion?: string
  readonly maxGateRetries?: number
  readonly gateWaitTimeoutMs?: number
  readonly gateTaskTtlMs?: number
  readonly diagCredentials?: readonly string[]
  /** 最近一次编辑时间；从未编辑过则缺省。 */
  readonly updatedAt?: number
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
 * 服务端为 UI 派生的"下一步动作"（`docs/14` W3 第 1 条）。
 *
 * 为什么由**服务端**派生而不是让前端按状态自己推：状态与"该做什么"的映射散在前端，
 * 就会出现"页面显示可以批准，服务端却拒绝"这类不一致。集中在一处派生、并由测试逐行
 * 覆盖映射表，前端只负责渲染。
 *
 * 取值语义：
 * | 取值 | 含义 |
 * |---|---|
 * | `run` | 触发运行（首次、打回重跑、重入已登记、消费已下的裁决） |
 * | `view-artifact` | 终态已完成，去看产物 |
 * | `claim-gate` | 认领人工门任务。**不由视图派生**：`decideGate` 会在未持 claim 时自动认领，
 *   因此认领只是可选的"我要处理"声明（页面可提供按钮，但它不是"下一步"） |
 * | `decide-gate` | 裁决人工门任务（**仅** `waiting-human` 时可能出现） |
 * | `reenter` | 终态需要人工介入：登记重入才能继续 |
 * | `retry-storage` | **不由视图派生**：保留给 HTTP 层在 503 时使用。视图能成功构建，
 *   就说明存储当时是可用的，因此这个取值不会出现在 `PipelineRunView.nextAction` 里 |
 * | `none` | 当前没有可执行的动作（例如后台运行正在进行中） |
 */
export type StageAction =
  | 'run'
  | 'view-artifact'
  | 'claim-gate'
  | 'decide-gate'
  | 'reenter'
  | 'retry-storage'
  | 'none'

/**
 * 人工门任务的种类（`docs/14` W3 第 3 条）。
 *
 * - `stage`：**阶段门**。对应一份真实产物，批准即推进该阶段。
 * - `escalation`：**升级任务**。由 `human.gateFailed` 产生（机器门禁失败 / 预算超限），
 *   `artifactPath` 为空、`machineStatus` 为 `failed`，**永远不能被当作阶段批准**。
 *
 * 两者在数据上早已可区分（`artifactPath === ''`），但那是**隐式**的：UI 必须自己知道
 * 这条约定。把它显式化，页面才能给出不同文案与不同操作集合。
 */
export type GateTaskKind = 'stage' | 'escalation'

/**
 * 人工门任务的**视图**：持久化记录 + 派生的种类标记。
 *
 * 刻意不在 `HumanGateTask` 上直接加字段——那会改变落盘形状，需要迁移。
 * 派生字段只存在于返回给调用方的视图里。
 */
export interface GateTaskView extends HumanGateTask {
  /** `true` = 升级任务（不对应产物，不可被批准为阶段门）。 */
  readonly isEscalation: boolean
}

/** 由持久化记录派生门任务视图。 */
export function toGateTaskView(task: HumanGateTask): GateTaskView {
  return { ...task, isEscalation: task.artifactPath === '' }
}

/** {@link deriveNextAction} 的输入：全部来自已构建的视图事实，不含任何新状态。 */
export interface NextActionFacts {
  readonly status: PipelineRunStatus
  /** 当前阶段（第一个非 `done` 的阶段）。 */
  readonly currentStage: StageId | null
  /** 当前阶段的检查点状态。 */
  readonly currentStageStatus: CheckpointStatus | null
  /** 未决门的种类；没有未决门时为 `null`。 */
  readonly gateKind: GateTaskKind | null
  /**
   * 未决门的状态。
   *
   * **必须带上它**：`decideGate` 要求调用者**持有 claim**（否则 `gate-not-decidable`），
   * 因此"先认领再裁决"是两步。只看 kind 会给出一个点了就被拒的动作。
   */
  readonly gateStatus: HumanGateTaskStatus | null
}

export interface NextActionDecision {
  readonly action: StageAction
  readonly reason: string | null
}

/**
 * 派生"下一步该做什么"（纯函数）。
 *
 * 三条硬规则：
 * 1. **终态永不出现 `decide-gate` / `claim-gate`**：`gate-failed` / `review-failed` /
 *    `rejected` / `cancelled` / `failed` 一律给 `reenter`——页面因此不可能渲染出一个
 *    "批准"按钮而服务端拒绝它（docs/14 W3 第 7 条）。
 * 2. **`running` 给 `none`**：后台运行进行中，此刻没有任何人工动作是"正确"的；
 *    催人去操作只会制造并发冲突。
 * 3. **未决门给 `claim-gate` 还是 `decide-gate` 取决于它是否已被认领**——
 *    这不是 UI 偏好，而是 `decideGate` 的前置条件。
 *
 * `retry-storage` 刻意**不在此函数的取值范围内**：视图能成功构建就说明存储可用。
 */
export function deriveNextAction(facts: NextActionFacts): NextActionDecision {
  switch (facts.status) {
    case 'running':
      return { action: 'none', reason: '后台运行进行中：等它结束或停在人工门后再操作' }
    case 'completed':
      // 终态且无待办：去看产物。这不是"催办"，只是把入口指出来。
      return { action: 'view-artifact', reason: null }
    case 'waiting-human': {
      if (facts.gateKind === null) {
        return { action: 'run', reason: '裁决已登记但尚未被消费：触发运行以消费它并推进到下一阶段' }
      }
      const subject = facts.gateKind === 'escalation'
        ? '机器门禁失败已升级为待处理任务'
        : `阶段「${facts.currentStage ?? '未知'}」停在人工门`
      // 注意：**不**把 `claim-gate` 作为派生动作。`decideGate` 在调用者未持 claim 时会
      // 自动认领（`decideOnce`），因此认领不是前置条件，只是可选的"我要处理"声明。
      // 把它当成"下一步"会逼用户点一个非必需的按钮。
      return facts.gateStatus === 'claimed'
        ? {
            action: 'decide-gate',
            reason: `${subject}：已被认领（同租约内裁决会冲突，可等租约过期）`,
          }
        : { action: 'decide-gate', reason: `${subject}：等待裁决（认领由服务端自动完成）` }
    }
    case 'gate-failed':
      return { action: 'reenter', reason: '机器门禁失败是终态：修正原因后重入该阶段（不重试）' }
    case 'review-failed':
      return { action: 'reenter', reason: '交叉检查重试已耗尽（终态）：修正后重入该阶段' }
    case 'rejected':
      return { action: 'reenter', reason: '流水线已被拒绝（终态）：需要重入才能继续' }
    case 'cancelled':
      return { action: 'reenter', reason: '运行已取消（终态）：需要重入才能继续' }
    case 'failed':
      return { action: 'reenter', reason: '运行期失败（终态）：需要重入才能继续' }
    case 'needs-fix':
      return { action: 'run', reason: '阶段被人工打回：触发运行会重跑该阶段' }
    case 'queued':
      return facts.currentStageStatus === 'needs-reentry'
        ? { action: 'run', reason: '重入已登记：触发运行会级联重跑该阶段及其下游' }
        : { action: 'run', reason: '尚未开始：触发运行' }
  }
}

/**
 * 编辑流水线请求（`PATCH /api/pipelines/:pipelineId`）。
 *
 * **只应用出现的字段**：没传的保持原值。要清空一个可选字符串/数组，传空串或空数组
 * （不用 `null`——那会与"没传"难以区分，而 JSON 里两者都能表达，容易误清）。
 *
 * **不包含** `projectId` / `tenantId` / `configRef`：它们决定作用域与索引键，
 * 改了就不是同一条流水线了（要换项目就新建一条）。
 */
export interface UpdatePipelineRunInput {
  readonly pipelineId: string
  readonly requirementInput?: string
  readonly providerName?: string
  readonly targetBaseUrl?: string
  readonly rulesetVersion?: string
  readonly maxGateRetries?: number
  readonly gateWaitTimeoutMs?: number
  readonly gateTaskTtlMs?: number
  readonly diagCredentials?: readonly string[]
}

/** 编辑结果。 */
export interface PipelineUpdateView {
  readonly pipelineId: string
  readonly updatedAt: number
  /** 变更过的字段名（没变更时为空数组）。 */
  readonly changedFields: readonly string[]
  /**
   * 面向运维的提醒。当这条流水线**已经产出过阶段产物**时给出——
   * 那些产物是在**旧参数**下产生的，参数改了它们不会自动重做。
   */
  readonly warning: string | null
}

/**
 * 移除流水线结果（`DELETE /api/pipelines/:pipelineId`）。
 *
 * **当前实现只摘掉索引，数据仍留在数据根**（`dataRetained: true`）。
 * 理由写在 `dataRetainedReason` 里——真删需要给产物/检查点/任务/门任务四个端口
 * 增加 `remove` 能力并同步三个后端与契约测试，那是独立的一项工作。
 * 保留数据意味着可恢复、可取证；清理由运维在数据根上做。
 */
export interface PipelineRemovalView {
  readonly pipelineId: string
  readonly removed: boolean
  readonly dataRetained: boolean
  readonly dataRetainedReason: string
}

/**
 * 对外可见的 Pipeline 记录：**剥掉 `legacyLocator`**。
 *
 * 那三个字段是服务器绝对路径，返回给浏览器即泄露部署布局（`docs/15` 的硬要求）。
 * 用 `Omit` 而不是"记得别返回它"——类型层面就让它无法出现在响应里。
 */
export type PublicPipelineRecord = Omit<PipelineRecord, 'legacyLocator'>

/**
 * L1 迁移状态（`docs/19` §4.3）。
 *
 * ```text
 * migrated    新格式齐全且与旧格式一致（正常）
 * needed      旧格式在、新格式一个字都没有（还没迁过；访问时会自动补）
 * incomplete  新格式写了一半（record 在、revision 或 run 缺）——迁移中断
 * conflict    新旧都在但事实不一致（双写漏了一处 / 有人手工改过其中一侧）
 * ```
 */
export type PipelineMigrationState = 'migrated' | 'needed' | 'incomplete' | 'conflict'

/**
 * L1 迁移现状（`GET /api/pipelines/:id/diagnostics` 的一部分）。
 *
 * 为什么单独一段而不是塞进 `backend.storage`：那段是**存储 schema 健康**的判据，
 * 它非空就意味着 `backend.ok === false`、`attentionNeeded === true`。
 * 而 L1b 期间"还没迁移"是**完全正常**的状态，把它算进 `ok` 会让每一份老数据根
 * 一开机就报不健康——报警一旦是常态，就没人看了。
 */
export interface PipelineMigrationReport {
  readonly state: PipelineMigrationState
  /** 新格式文件本身的状态（`corrupt` 表示文件在但读不出来）。 */
  readonly record: 'missing' | 'ok' | 'corrupt'
  readonly revisions: number
  readonly runs: number
  /** 需要人工/自动处置的明细。`ref` 是**相对**路径，不含数据根。 */
  readonly diagnostics: readonly StorageDiagnostic[]
}

/** `GET /api/pipelines/:id/revisions`（`docs/19` §8 的 L1a 只读端点）。 */
export interface PipelineRevisionsView {
  readonly pipelineId: string
  readonly pipeline: PublicPipelineRecord
  readonly revisions: readonly PipelineRevision[]
}

/** `GET /api/pipelines/:id/runs`。 */
export interface PipelineRunsView {
  readonly pipelineId: string
  readonly pipeline: PublicPipelineRecord
  readonly runs: readonly PipelineRun[]
}

/**
 * 数据根体检结果（`GET /api/pipelines/:pipelineId/diagnostics`，docs/14 W5 第 9 条）。
 *
 * 为什么需要它：单机部署里出问题时，运维只能看服务端日志或手工翻文件。
 * 把已有的 `StorageBackend.diagnose()`（六类诊断码）、索引扫描、用量日志坏行、
 * 创建中间态与运行锁现状**汇总成一份可读报告**，排障才有起点。
 *
 * 覆盖规划书要求的七类：配置不可读 / checkpoint 损坏 / 门任务损坏 / 索引损坏 /
 * usage 损坏行 / 锁残留 / 版本过高。其中前两类由 `storage` 的诊断码表达
 * （`unreadable` / `corrupt-json` / `schema-invalid`），版本问题由
 * `unsupported-version` 与 `migration-needed` 表达。
 */
export interface PipelineDiagnostics {
  readonly pipelineId: string
  readonly projectId: string
  readonly tenantId: string | null
  readonly backend: {
    readonly name: string
    readonly schemaVersion: number
    /** 后端自评：无任何非 `missing` 诊断时为 true。 */
    readonly ok: boolean
  }
  /** 后端诊断明细。`ref` 是**相对项目根**的路径，不含绝对路径。 */
  readonly storage: readonly StorageDiagnostic[]
  /** 索引扫描：条数与不可读项（不可读项**显式列出**，不静默跳过）。 */
  readonly index: {
    readonly entries: number
    readonly unreadable: readonly { readonly file: string; readonly reason: string }[]
  }
  /** 用量日志里无法解析的行数；`> 0` 表示计量不完整，不能读成"用量为 0"。 */
  readonly usageSkippedLines: number
  /** 创建是否收口（`creating` = 索引已写、检查点未确认，可用同一 id 重新 create 接管）。 */
  readonly creationState: 'creating' | 'ready'
  /**
   * 运行锁现状。**不判定 stale**（见 `inspectPipelineLock` 的说明）：
   * 这里只如实报告"锁目录在不在、owner 是谁、心跳多久没动"。
   */
  readonly lock: {
    readonly present: boolean
    readonly ownerId: string | null
    readonly heartbeatAt: number | null
    /** 心跳距今毫秒数；`heartbeatAt` 不可读时为 `null`。 */
    readonly ageMs: number | null
  }
  /** 汇总：有任何需要处置的项时为 true。**不代替**逐项判断，只是给页面一个入口信号。 */
  readonly attentionNeeded: boolean
  /**
   * L1 事实模型的迁移现状（`docs/19` §4.3）。**只读报告，体检不触发迁移**
   * ——排障路径上做写操作是最糟的设计。
   */
  readonly migration: PipelineMigrationReport
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

  // ── 以下为 W3 新增的**派生**字段（不是落盘事实，全部由服务端从上面的事实算出）──

  /**
   * 当前所在阶段 = **STAGE_ORDER 里第一个不是 `done` 的阶段**；全部完成时为 `null`。
   *
   * 与 `nextStage` 的区别：`nextStage` 是"游标指向哪"（实现细节），本字段是"用户此刻
   * 该看哪个阶段"（界面语义）。当前实现下两者恒等（有测试钉住），但语义不同：
   * 前者来自 `checkpoint.cursor`，后者来自阶段状态。
   */
  readonly currentStage: StageId | null
  /** 服务端派生的下一步动作（映射表见 {@link StageAction}）。 */
  readonly nextAction: StageAction
  /** 为什么是这一步（面向运维的一句话）；没有可说的时为 `null`。 */
  readonly blockingReason: string | null
  /** 当前未决门的种类；没有未决门时为 `null`。 */
  readonly gateKind: GateTaskKind | null
  /**
   * 运行参数（仅 `get()` 填；列表与运行结果不带它）。
   * 页面据此预填编辑表单。
   */
  readonly params?: PipelineRunParams
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
  // 门任务正被另一个进程改写：这是**并发冲突**（重试即可），既不是请求不合法，
  // 也不是门本身进了终态。按类型判据映射，避免依赖中文/英文报错文本。
  if (error instanceof GateTaskBusyError) {
    return new PipelineRunError('conflict', errorMessageOf(error), { gateTaskId: error.gateTaskId })
  }
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

// ── 角色守卫（docs/10 §5.3、docs/11 P1-02）────────────────────────────────────

/**
 * 人工门裁决允许的角色。
 *
 * 与 `ActorRole` 的文档注释是同一条契约的两种写法：注释说明意图，这里的常量
 * 是**唯一**的判定实现。此前 `reenter`/`cancelGate` 没有对应常量，于是它们
 * 只检查了"actorId 非空"——任何只读调用者都能回退 cursor、取消门任务。
 */
const GATE_ROLES: readonly ActorRole[] = ['reviewer', 'admin']
/** 运维动作（重入、取消运行、取消门任务）允许的角色。 */
const OPERATOR_ROLES: readonly ActorRole[] = ['operator', 'admin']
/** 平台管理动作（恢复扫描）允许的角色。 */
const ADMIN_ROLES: readonly ActorRole[] = ['admin']

/**
 * 角色判定：**失败关闭**。
 *
 * 缺少 `roles` 一律视为无特权——绝不因为"字段没传"而放行，否则任何忘记声明角色的
 * 调用方都会自动获得特权，而那正是最需要拦住的调用方（例如后台运行身份）。
 */
function requireRole(actor: ActorContext, allowed: readonly ActorRole[], action: string): void {
  const roles = actor.roles ?? []
  if (!roles.some(role => allowed.includes(role))) {
    throw new PipelineRunError('forbidden', `${action}需要 ${allowed.join(' 或 ')} 角色`, {
      actorId: actor.actorId,
      required: [...allowed],
    })
  }
}

/** 人工门裁决（`claimGate` / `decideGate`）：reviewer 或 admin。 */
export function assertGateRole(actor: ActorContext): void {
  requireRole(actor, GATE_ROLES, '人工门裁决')
}

/**
 * 运维动作（`reenter` / `cancelGate` / 取消运行）：operator 或 admin。
 *
 * `action` 由调用点给出，让 403 的文本直接说明**哪个**动作被拒
 * （"流水线重入需要 operator 或 admin 角色"比"权限不足"有用得多）。
 */
export function assertOperatorRole(actor: ActorContext, action = '该运维动作'): void {
  requireRole(actor, OPERATOR_ROLES, action)
}

/** 平台管理动作（`/api/admin/recover`）：admin。 */
export function assertAdminRole(actor: ActorContext, action = '该平台管理动作'): void {
  requireRole(actor, ADMIN_ROLES, action)
}
