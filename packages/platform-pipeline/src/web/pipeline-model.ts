/**
 * L1 事实模型的**类型与不变量**（`docs/19-l1-pipeline-revision-run-design.md` §2）。
 *
 * 三个一等对象：
 * ```text
 * PipelineRecord     身份      —— 这条流水线是谁
 * PipelineRevision   配置快照  —— 这一次跑用哪套参数
 * PipelineRun        一次执行  —— 这一次跑到哪了
 * ```
 *
 * **本模块只放类型与纯函数**，不做任何 I/O：
 * - 路径推导在 `pipeline-locator.ts`；
 * - 旧数据投影在 `pipeline-legacy.ts`。
 * 这样不变量可以在单测里被直接断言，而不需要起存储。
 *
 * L1a 阶段的定位：**只读兼容**。本模块产出的对象**不落盘**，
 * 因此即使模型设计错了，回滚成本为零（`docs/19` §8）。
 *
 * @module platform-pipeline/web/pipeline-model
 */

import { STAGE_ORDER, type StageId } from '../types.ts'
import { idempotencyFingerprint } from '../idempotency.ts'
import type { PipelineRunStatus } from './pipeline-run-types.ts'

// ── Pipeline（身份）───────────────────────────────────────────────────────────

/**
 * 旧结构的定位信息。
 *
 * 迁移期间保留它有两个用处：① 排障时能回答"这条新记录是从哪个文件投影出来的"；
 * ② L1b 惰性迁移时知道该去读哪些旧文件。**迁移完成后不删**——它是审计线索。
 */
export interface LegacyLocator {
  /** 相对 dataRoot 的 manifest 路径。 */
  readonly manifestPath: string
  /** 相对项目根的 checkpoint 路径。 */
  readonly checkpointPath: string
  /** 相对项目根的产物根。 */
  readonly artifactsRoot: string
  readonly migratedAt: number
}

export interface PipelineRecord {
  readonly pipelineId: string
  readonly tenantId: string | null
  readonly projectId: string
  readonly configRef: string
  readonly displayName?: string
  readonly createdAt: number
  readonly updatedAt?: number
  /** 软删除标记。存在即视为已移除（列表默认隐藏）。**不是物理删除。** */
  readonly deletedAt?: number
  readonly deletedBy?: string
  /** 当前生效的 revision；老数据投影后指向 `revision-1`。 */
  readonly activeRevisionId: string
  readonly legacyLocator?: LegacyLocator
}

// ── PipelineRevision（配置快照）───────────────────────────────────────────────

/** 会改变运行行为、因而必须进入 fingerprint 的字段。 */
export const REVISION_BEHAVIOR_FIELDS = [
  'requirementInput', 'providerName', 'targetBaseUrl', 'rulesetVersion',
  'maxGateRetries', 'gateWaitTimeoutMs', 'gateTaskTtlMs', 'diagCredentials',
] as const

export type RevisionBehaviorField = (typeof REVISION_BEHAVIOR_FIELDS)[number]

export interface PipelineRevision {
  readonly revisionId: string
  readonly pipelineId: string
  /** 从 1 开始，同一 pipeline 内单调递增、不跳号。 */
  readonly revisionNumber: number
  readonly createdAt: number
  readonly createdBy: string
  readonly status: 'active' | 'superseded'

  readonly requirementInput?: string
  readonly providerName?: string
  readonly targetBaseUrl?: string
  readonly rulesetVersion: string
  readonly maxGateRetries?: number
  readonly gateWaitTimeoutMs?: number
  readonly gateTaskTtlMs?: number
  /** **只存环境变量名，绝不存值**（`docs/18` §0.3 第 9 条与 `docs/19` R5）。 */
  readonly diagCredentials?: readonly string[]

  /** 覆盖 `REVISION_BEHAVIOR_FIELDS` 的稳定摘要，用于去重与审计绑定。 */
  readonly fingerprint: string
  /** 老数据迁移产生的第一个 revision 的来源标记。 */
  readonly migratedFrom?: string
}

// ── PipelineRun（一次执行）────────────────────────────────────────────────────

export interface RunFailure {
  readonly code: string
  readonly detail: string
  readonly stageId?: StageId
  readonly at: number
}

export interface PipelineRun {
  readonly runId: string
  readonly pipelineId: string
  readonly revisionId: string
  /** 同一次运行内的尝试序号。**用户主动"重新运行"是新 runId，不是 attempt+1**（Q1）。 */
  readonly attempt: number
  readonly status: PipelineRunStatus
  readonly cursor: number
  readonly createdAt: number
  readonly startedAt?: number
  readonly finishedAt?: number
  readonly createdBy: string
  readonly failure?: RunFailure
  /** 该 run 的检查点位置（相对 dataRoot）。L1a 指向旧 checkpoint。 */
  readonly checkpointLocator: string
}

// ── 不变量 ───────────────────────────────────────────────────────────────────

/** 运行态（未收敛）：同一 pipeline 同时最多一个。 */
export const ACTIVE_RUN_STATUSES: readonly PipelineRunStatus[] = [
  'queued', 'running', 'waiting-human', 'needs-fix',
]

/** 终态：不可再推进。 */
export const TERMINAL_RUN_STATUSES: readonly PipelineRunStatus[] = [
  'completed', 'rejected', 'cancelled', 'gate-failed', 'review-failed', 'failed',
]

export function isTerminalRunStatus(status: PipelineRunStatus): boolean {
  return TERMINAL_RUN_STATUSES.includes(status)
}

export function isActiveRunStatus(status: PipelineRunStatus): boolean {
  return ACTIVE_RUN_STATUSES.includes(status)
}

/** 不变量违例。**不继承** `PipelineRunError`——那是 HTTP 层的错误分类，这里是模型自检。 */
export class PipelineModelError extends Error {
  readonly invariant: string

  constructor(invariant: string, message: string) {
    super(`[${invariant}] ${message}`)
    this.name = 'PipelineModelError'
    this.invariant = invariant
  }
}

function fail(invariant: string, message: string): never {
  throw new PipelineModelError(invariant, message)
}

function assertNonEmpty(value: string, invariant: string, field: string): void {
  if (value.trim() === '') fail(invariant, `${field} 不能为空`)
}

/**
 * Pipeline 身份不变量（`docs/19` §2.1 P1~P6）。
 *
 * 注意：**"pipelineId 不可改"不在本函数里判**——那需要新旧两份对象才能比。
 * 它由 `assertIdentityImmutable(previous, next)` 判。
 */
export function assertPipelineInvariants(record: PipelineRecord): void {
  assertNonEmpty(record.pipelineId, 'P1', 'pipelineId')
  assertNonEmpty(record.projectId, 'P1', 'projectId')
  assertNonEmpty(record.configRef, 'P1', 'configRef')
  assertNonEmpty(record.activeRevisionId, 'P5', 'activeRevisionId')
  if (record.deletedAt !== undefined) {
    // P3：软删除必须留痕（谁删的、什么时候），否则审计无法回答"谁移除的"。
    if (record.deletedBy === undefined) fail('P3', '软删除必须记录 deletedBy')
  }
  if (record.updatedAt !== undefined && record.updatedAt < record.createdAt) {
    fail('P1', 'updatedAt 不能早于 createdAt')
  }
}

/**
 * 身份字段不可变（`docs/19` §2.1 P1/P2）。
 *
 * `pipelineId` / `projectId` / `tenantId` / `configRef` 决定索引键与作用域，
 * 改了就不是同一条流水线。HTTP 层的 `EDITABLE_PATCH_FIELDS` 白名单是第一道，
 * 这里是第二道（纵深防御：白名单只校验字段名，不保证没人绕过）。
 */
export function assertIdentityImmutable(previous: PipelineRecord, next: PipelineRecord): void {
  for (const field of ['pipelineId', 'projectId', 'tenantId', 'configRef'] as const) {
    if (previous[field] !== next[field]) {
      fail('P2', `${field} 不可变：${JSON.stringify(previous[field])} → ${JSON.stringify(next[field])}`)
    }
  }
}

/** Revision 不变量（`docs/19` §2.2 R1~R7）。 */
export function assertRevisionInvariants(revision: PipelineRevision): void {
  assertNonEmpty(revision.revisionId, 'R1', 'revisionId')
  assertNonEmpty(revision.pipelineId, 'R1', 'pipelineId')
  assertNonEmpty(revision.rulesetVersion, 'R4', 'rulesetVersion')
  if (!Number.isSafeInteger(revision.revisionNumber) || revision.revisionNumber < 1) {
    fail('R2', `revisionNumber 必须是从 1 开始的整数：${revision.revisionNumber}`)
  }
  assertNonEmpty(revision.fingerprint, 'R4', 'fingerprint')

  // R5：凭据**值**绝不进入 revision。这里能判的是"形状"——
  // 环境变量名的形状（大写字母/数字/下划线）；出现别的东西就说明有人把值塞进来了。
  for (const name of revision.diagCredentials ?? []) {
    if (!/^[A-Z][A-Z0-9_]*$/.test(name)) {
      fail('R5', `diagCredentials 只允许环境变量名（大写字母/数字/下划线），实际：${JSON.stringify(name)}`)
    }
  }
}

/**
 * 计算 revision 的行为指纹（`docs/19` R4）。
 *
 * 复用 `idempotencyFingerprint` 而不是另写一套：指纹算法只应有一处实现，
 * 否则两处对"什么算同一个 revision"的判断会分叉。
 *
 * **注意它是什么**：`idempotencyFingerprint` 返回的是**规范化字段的序列化**
 * （如 `["pipeline-revision","v:primary",…]`），**不是** sha256 摘要——
 * 它的用途是**等值比较**（"两次配置是不是同一份"），不是当摘要展示。
 * 需要摘要的是 `idempotencyKey`。字段名沿用现有约定，但别把它当哈希用。
 */
export function revisionFingerprint(fields: Partial<Record<RevisionBehaviorField, unknown>>): string {
  // **按固定字段顺序**取值并显式规范化：缺省 → 空串，数组 → 用 \u0000 连接。
  // 顺序固定是关键——`Object.keys` 的顺序不保证稳定，那会让"同一份配置"算出两个指纹。
  return idempotencyFingerprint('pipeline-revision', REVISION_BEHAVIOR_FIELDS.map(field => normalizeField(fields[field])))
}

/**
 * 把行为字段规范化成稳定字符串，**并带类型标签**。
 *
 * 为什么必须带标签：`undefined`（没设）与 `''`（显式清空）在行为上**不等价**——
 * 前者走"用默认 provider"，后者会被当成一个空 provider 名。如果两者都规范化成空串，
 * 两份行为不同的配置会算出**同一个指纹**，于是"换配置"会被误判成"同一份配置"，
 * 直接破坏 R4。这是写测试时抓出来的（见 `test/pipeline-model-l1a.test.ts`）。
 */
function normalizeField(value: unknown): string {
  if (value === undefined) return 'u:'
  if (value === null) return 'n:'
  if (Array.isArray(value)) return `a:${value.map(item => String(item)).join('\u0000')}`
  return `v:${String(value)}`
}

/**
 * 构造 revision 所需的行为参数来源。
 *
 * 三个来源共用它：① 旧 manifest 迁移；② `create` 的输入；③ `PATCH` 之后的 next manifest。
 * 之所以要统一类型，是因为**指纹口径必须只有一处**（见 `revisionConfigOf`）。
 */
export interface RevisionParamsSource {
  readonly requirementInput?: string
  readonly providerName?: string
  readonly targetBaseUrl?: string
  readonly rulesetVersion: string
  readonly maxGateRetries?: number
  readonly gateWaitTimeoutMs?: number
  readonly gateTaskTtlMs?: number
  readonly diagCredentials?: readonly string[]
}

/** `revisionConfigOf` 的产出：revision 的配置部分 + 指纹。 */
export interface RevisionConfig {
  readonly requirementInput?: string
  readonly providerName?: string
  readonly targetBaseUrl?: string
  readonly rulesetVersion: string
  readonly maxGateRetries?: number
  readonly gateWaitTimeoutMs?: number
  readonly gateTaskTtlMs?: number
  readonly diagCredentials?: readonly string[]
  readonly fingerprint: string
}

/**
 * 从行为参数派生 revision 的配置部分（含指纹）。**唯一实现。**
 *
 * 为什么必须唯一：迁移路径与新建路径若各算一次指纹，**同一份配置会得到两个指纹**，
 * 于是"PATCH 一份与当前完全相同的参数"会被误判成变化、白建一个 revision（破坏 R7）。
 * 迁移路径曾经把缺省字段写成 `?? null`，而新建路径留 `undefined`——
 * 在 `normalizeField` 里 `null` 是 `n:`、`undefined` 是 `u:`，两者**不相等**。
 * 这个 bug 在统一到本函数时才被消除。
 */
export function revisionConfigOf(source: RevisionParamsSource): RevisionConfig {
  return {
    rulesetVersion: source.rulesetVersion,
    ...(source.requirementInput === undefined ? {} : { requirementInput: source.requirementInput }),
    ...(source.providerName === undefined ? {} : { providerName: source.providerName }),
    ...(source.targetBaseUrl === undefined ? {} : { targetBaseUrl: source.targetBaseUrl }),
    ...(source.maxGateRetries === undefined ? {} : { maxGateRetries: source.maxGateRetries }),
    ...(source.gateWaitTimeoutMs === undefined ? {} : { gateWaitTimeoutMs: source.gateWaitTimeoutMs }),
    ...(source.gateTaskTtlMs === undefined ? {} : { gateTaskTtlMs: source.gateTaskTtlMs }),
    ...(source.diagCredentials === undefined ? {} : { diagCredentials: source.diagCredentials }),
    // 注意传的是**原始值**（可能 undefined），不做 `?? null` 归一——
    // 归一交给 `normalizeField`，它已经带了类型标签。
    fingerprint: revisionFingerprint({
      requirementInput: source.requirementInput,
      providerName: source.providerName,
      targetBaseUrl: source.targetBaseUrl,
      rulesetVersion: source.rulesetVersion,
      maxGateRetries: source.maxGateRetries,
      gateWaitTimeoutMs: source.gateWaitTimeoutMs,
      gateTaskTtlMs: source.gateTaskTtlMs,
      diagCredentials: source.diagCredentials,
    }),
  }
}

// ── 构造器（唯一一份；迁移与新建都走这里）────────────────────────────────────

export interface RevisionDraft {
  readonly revisionId: string
  readonly pipelineId: string
  readonly revisionNumber: number
  readonly createdAt: number
  readonly createdBy: string
  readonly status: 'active' | 'superseded'
  readonly params: RevisionParamsSource
  /** 只有**老数据迁移**产生的 revision 才带这个标记；新建的**不带**。 */
  readonly migratedFrom?: string
}

/** 构造并自检一个 revision（不变量违例会**立刻**抛出，而不是等落盘之后才发现）。 */
export function makeRevision(draft: RevisionDraft): PipelineRevision {
  const revision: PipelineRevision = {
    revisionId: draft.revisionId,
    pipelineId: draft.pipelineId,
    revisionNumber: draft.revisionNumber,
    createdAt: draft.createdAt,
    createdBy: draft.createdBy,
    status: draft.status,
    ...revisionConfigOf(draft.params),
    ...(draft.migratedFrom === undefined ? {} : { migratedFrom: draft.migratedFrom }),
  }
  assertRevisionInvariants(revision)
  return revision
}

export interface PipelineRecordDraft {
  readonly pipelineId: string
  readonly tenantId: string | null
  readonly projectId: string
  readonly configRef: string
  readonly createdAt: number
  readonly updatedAt?: number
  readonly deletedAt?: number
  readonly deletedBy?: string
  readonly activeRevisionId: string
  readonly legacyLocator?: LegacyLocator
}

export function makePipelineRecord(draft: PipelineRecordDraft): PipelineRecord {
  const record: PipelineRecord = {
    pipelineId: draft.pipelineId,
    tenantId: draft.tenantId,
    projectId: draft.projectId,
    configRef: draft.configRef,
    createdAt: draft.createdAt,
    ...(draft.updatedAt === undefined ? {} : { updatedAt: draft.updatedAt }),
    ...(draft.deletedAt === undefined ? {} : { deletedAt: draft.deletedAt }),
    ...(draft.deletedBy === undefined ? {} : { deletedBy: draft.deletedBy }),
    activeRevisionId: draft.activeRevisionId,
    ...(draft.legacyLocator === undefined ? {} : { legacyLocator: draft.legacyLocator }),
  }
  assertPipelineInvariants(record)
  return record
}

export interface RunDraft {
  readonly runId: string
  readonly pipelineId: string
  readonly revisionId: string
  readonly attempt: number
  readonly status: PipelineRunStatus
  readonly cursor: number
  readonly createdAt: number
  readonly startedAt?: number
  readonly finishedAt?: number
  readonly createdBy: string
  readonly failure?: RunFailure
  readonly checkpointLocator: string
}

/**
 * 构造并自检一个 run。
 *
 * `allowUnknownTiming` 由调用方显式选择：**只有**"从旧检查点投影"那条路可以放宽
 * （老数据没记起止时间），新写入一律严格。
 */
export function makeRun(draft: RunDraft, options: { readonly allowUnknownTiming?: boolean } = {}): PipelineRun {
  const run: PipelineRun = {
    runId: draft.runId,
    pipelineId: draft.pipelineId,
    revisionId: draft.revisionId,
    attempt: draft.attempt,
    status: draft.status,
    cursor: draft.cursor,
    createdAt: draft.createdAt,
    ...(draft.startedAt === undefined ? {} : { startedAt: draft.startedAt }),
    ...(draft.finishedAt === undefined ? {} : { finishedAt: draft.finishedAt }),
    createdBy: draft.createdBy,
    ...(draft.failure === undefined ? {} : { failure: draft.failure }),
    checkpointLocator: draft.checkpointLocator,
  }
  assertRunInvariants(run, options)
  return run
}

/**
 * Run 不变量（`docs/19` §2.3 N2~N5）。N1/N6 需要跨 run 才能判，见 `assertSingleActiveRun`。
 *
 * `allowUnknownTiming` 只给**旧数据投影**用：老检查点里**没有记录** run 的开始/结束时间，
 * 投影时不能编一个出来。新写入的 run 必须走严格模式（默认），否则"终态必须有 finishedAt"
 * 这条判据会被悄悄放宽。**放宽必须是显式的、有名字的、只对迁移路径开放的。**
 */
export function assertRunInvariants(run: PipelineRun, options: { readonly allowUnknownTiming?: boolean } = {}): void {
  assertNonEmpty(run.runId, 'N3', 'runId')
  assertNonEmpty(run.pipelineId, 'N2', 'pipelineId')
  assertNonEmpty(run.revisionId, 'N2', 'revisionId')
  assertNonEmpty(run.checkpointLocator, 'N2', 'checkpointLocator')
  if (!Number.isSafeInteger(run.attempt) || run.attempt < 1) {
    fail('N5', `attempt 必须是从 1 开始的整数：${run.attempt}`)
  }
  if (run.cursor < 0 || run.cursor > STAGE_ORDER.length) {
    fail('N2', `cursor 必须在 [0, ${STAGE_ORDER.length}] 内：${run.cursor}`)
  }
  // N4：终态必须冻结——有 finishedAt 却没进终态，或进了终态却没有 finishedAt，都是坏的。
  const terminal = isTerminalRunStatus(run.status)
  if (!options.allowUnknownTiming) {
    if (terminal && run.finishedAt === undefined) {
      fail('N4', `终态 run 必须有 finishedAt（status=${run.status}）`)
    }
    if (!terminal && run.finishedAt !== undefined) {
      fail('N4', `非终态 run 不应有 finishedAt（status=${run.status}）`)
    }
  }
  if (run.failure !== undefined) {
    assertNonEmpty(run.failure.code, 'N2', 'failure.code')
    assertNonEmpty(run.failure.detail, 'N2', 'failure.detail')
  }
}

/**
 * 同一 pipeline 内最多一个运行态 run（`docs/19` §2.3 N1）。
 *
 * 为什么是"至多一个"而不是"恰好一个"：流水线可以没有正在跑的 run（比如全部终态、
 * 或刚创建还没触发）。这条不变量要拦的是**两个 run 同时改同一份检查点**。
 */
export function assertSingleActiveRun(runs: readonly PipelineRun[]): void {
  const active = runs.filter(run => isActiveRunStatus(run.status))
  if (active.length > 1) {
    fail('N1', `同一 pipeline 同时只能有一个运行态 run，实际 ${active.length} 个：${active.map(r => r.runId).join('、')}`)
  }
}

/** 同一 pipeline 内最多一个 active revision（`docs/19` §2.2 R3）。 */
export function assertSingleActiveRevision(revisions: readonly PipelineRevision[]): void {
  const active = revisions.filter(revision => revision.status === 'active')
  if (active.length > 1) {
    fail('R3', `同一 pipeline 同时只能有一个 active revision，实际 ${active.length} 个：${active.map(r => r.revisionId).join('、')}`)
  }
}

/**
 * revisionNumber 单调递增、不跳号（`docs/19` §2.2 R2）。
 *
 * 跳号说明"有人删过 revision"或"并发写坏了"——两种都不该被静默接受：
 * revision 编号是审计里引用配置版本的锚点。
 */
export function assertRevisionNumbering(revisions: readonly PipelineRevision[]): void {
  const numbers = [...revisions].map(revision => revision.revisionNumber).sort((a, b) => a - b)
  for (const [index, number] of numbers.entries()) {
    if (number !== index + 1) {
      fail('R2', `revisionNumber 必须从 1 连续递增，实际第 ${index + 1} 个是 ${number}`)
    }
  }
}
