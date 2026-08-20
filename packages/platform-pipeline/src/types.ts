/**
 * 核心类型：流水线配置、工具 ACL、检查点（docs/09 实现骨架第 1 节；docs/02 第 2/9 节）。
 * @module platform-pipeline/types
 */

/** 固定六阶段（docs/02 决策：阶段骨架固定）。 */
export const STAGE_ORDER = ['receive', 'analyze', 'design', 'execute', 'report', 'archive'] as const
export type StageId = (typeof STAGE_ORDER)[number]

export type ProjectType = 'api-service' | 'web-ui' | 'desktop-client' | 'mixed'
export type ScaleTier = 'S' | 'M' | 'L'
export type ExecutionLevel = 'auto' | 'hybrid' | 'manual'

/** 工具 ACL（docs/06 第 2 节）：allow 白名单 / deny 黑名单，deny 显式优先。 */
export interface ToolFilter {
  readonly allow?: readonly string[]
  readonly deny?: readonly string[]
}

/** 阶段预算（docs/02 第 2 节）；timeoutMs 0 = 项目定义（execute 用例级超时另定）。 */
export interface StageBudget {
  readonly maxSteps: number
  readonly timeoutMs: number
  readonly maxRetries: number
  readonly maxTestCases?: number
}

/** 人工门（docs/02 第 5 节）：block 固定 true（交互模式全阻塞）。 */
export interface HumanGateConfig {
  readonly id: string
  readonly block: boolean
}

/** 交叉检查开关（docs/03 第 7 节）：默认 analyze/design/execute/report 开。 */
export interface ReviewConfig {
  readonly enabled: boolean
}

/** 执行类型解析链的"项目模板"层（docs/02 第 6 节）。 */
export interface ExecutionPolicy {
  readonly defaultLevel?: ExecutionLevel
  readonly overrides?: readonly { readonly match: string; readonly level: ExecutionLevel }[]
}

/** 存储适配引用（docs/02 第 7 节）：impl 指向实现（markdown-fs / jira / xray / testlink / export-files / paste）。 */
export interface StoreRef {
  readonly impl: string
  readonly [key: string]: unknown
}

/** 三类存储：知识库 / 用例库 / 需求源（需求源支持降级链）。 */
export interface StoresConfig {
  readonly knowledge: StoreRef
  readonly cases: StoreRef
  readonly requirements: {
    readonly primary: StoreRef
    readonly fallback?: readonly StoreRef[]
  }
}

/** 发布建议信任约束（docs/08 第 4.2 节 / 01 R5-06）：manual 占比超限不得 approve。 */
export interface ReleasePolicy {
  readonly maxManualClaimedRatio: number
}

/** 单阶段配置（docs/02 第 2 节）。 */
export interface StageConfig {
  readonly id: StageId
  readonly gate: Readonly<Record<string, HumanGateConfig>>
  readonly budget: StageBudget
  /** 机器门禁规则引用（docs/01 G/R 系列 id）；shorthand "G-01..G-07" 在设计稿中表示范围，装载时须展开为显式列表。 */
  readonly rules: readonly string[]
  readonly review: ReviewConfig
  /** 工具 ACL delta（docs/06 第 4 节）：默认继承平台标准，仅写增量。 */
  readonly tools?: ToolFilter
}

/** 顶层流水线配置（docs/02 第 2 节 pipeline.yaml）。 */
export interface PipelineConfig {
  readonly projectId: string
  readonly projectType: ProjectType
  readonly templateVersion: string
  readonly displayName?: string
  readonly executionPolicy?: ExecutionPolicy
  readonly scaleTier: ScaleTier
  readonly releasePolicy: ReleasePolicy
  readonly stores: StoresConfig
  readonly stages: Readonly<Record<StageId, StageConfig>>
}

// ── 检查点（docs/02 第 9 节 / docs/03 第 8 节）─────────────────────────────

export type CheckpointStatus =
  | 'idle' | 'running' | 'produced' | 'needs-fix'
  | 'gate-failed' | 'awaiting-gate' | 'done' | 'needs-reentry'

export interface Violation {
  readonly rule: string
  readonly level: 'BLOCKING' | 'WARNING'
  readonly detail: string
  readonly at: number
}

export interface MachineGateState {
  readonly status: 'passed' | 'failed'
  readonly attempts: number
  readonly violations: readonly Violation[]
}

export interface HumanGateRecord {
  readonly by: string
  readonly action: string
  readonly at: number
  readonly note?: string
}

export interface HumanGateState {
  readonly state: 'open' | 'approved' | 'changes-needed'
  readonly records: readonly HumanGateRecord[]
}

export interface StageState {
  readonly status: CheckpointStatus
  readonly artifact: string
  readonly digest: string
  /** 产物历史（重入/回环替换掉的旧版，docs/03 第 8.4 节）。 */
  readonly history: readonly { readonly digest: string; readonly capturedAt: number; readonly supersededBy?: number }[]
  readonly reviewDegraded: boolean
  readonly gate: {
    readonly machine: MachineGateState
    readonly human: HumanGateState
  }
  readonly failures: readonly { readonly kind: string; readonly rule?: string; readonly at: number }[]
}

export interface ReentryRecord {
  readonly stageId: StageId
  readonly by: string
  readonly at: number
  readonly reason: string
  readonly cascade: boolean
  readonly cursorBefore: number
  readonly cursorAfter: number
}

/** 流水线状态唯一事实（docs/02 第 9 节）。 */
export interface Checkpoint {
  readonly pipelineId: string
  readonly templateVersion: string
  readonly rulesetVersion: string
  /** 下一个要执行的阶段下标（0..STAGE_ORDER.length）。 */
  readonly cursor: number
  readonly stageStates: Readonly<Record<StageId, StageState>>
  readonly reentries: readonly ReentryRecord[]
}
