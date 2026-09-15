/**
 * executor 契约（docs/08 第 2/6 节）。
 * executor 是唯一执行者：入参只传 caseId，出参为自产记录与证据。
 * runner 实现（http/ui/client）为可插拔适配器；side-effect 留痕契约随实现验收（ET-03）。
 * @module platform-pipeline/executor
 */

import type { EvidenceEntry } from './verify.ts'
import type { ExecutionRecord } from './records.ts'

export { makeRecord, hashRecord, verifyChain } from './records.ts'
export type { ChainViolation, ExecutionRecord, ExecutionStatus } from './records.ts'
export { reconcile, verifyEvidence } from './verify.ts'
export type { EvidenceEntry, EvidenceViolation, ReconcileResult } from './verify.ts'

export interface ExecutorContext {
  /** 用例定义来源（executor 自读 design.json，不信任调用方传入的内容）。 */
  readonly designArtifactPath: string
  /** 证据快照目录（executor 独占写；execute agent 无写权）。 */
  readonly evidenceDir: string
  /** 本次执行调用身份（capturedBy 前缀）。 */
  readonly invocationId: string
  /**
   * 续跑：上一次会话的链尾与 seq 水位（ET-02「环境中断续跑开启新链段，
   * 段头 prevHash 链接旧链尾」）。
   *
   * 为什么必须有：executor_run 可被多次调用（分批执行）。若每次都从 seq=1、
   * prevHash=''、segment=1 重开，则后一次调用会覆盖/断开前一次的记录链，
   * 门禁对账（R4-08）就会判定先前批次"漏跑"。实测踩到：先跑一批 10 条、
   * 再单独跑 1 条，会话文件里只剩最后 1 条 → 10 条 pass 反而被判无记录。
   */
  readonly continuation?: ExecutorContinuation
}

/** 续跑水位：新链段从 startSeq 起编号，段头 prevHash 链接旧链尾。 */
export interface ExecutorContinuation {
  readonly startSeq: number
  readonly prevHash: string
  readonly segment: number
}

/** 一次执行会话：记录链 + 证据 + manifest 索引。 */
export interface ExecutionSession {
  /** 按 seq 升序的记录（可能多段，续跑新段）。 */
  readonly records: readonly ExecutionRecord[]
  readonly evidence: readonly EvidenceEntry[]
  /** manual 会话（R4-11a 时间窗校验用；宿主从 manual 会话存储提供，可选）。 */
  readonly manualSessions?: readonly ManualSessionRecord[]
  /** manual 回填见证（R4-11a/b 校验用；宿主提供，可选）。 */
  readonly manualAttestations?: readonly ManualAttestationRecord[]
}

/** manual 会话记录（门禁侧视图，与 execute/manual-session 的 ManualSession 对齐）。 */
export interface ManualSessionRecord {
  readonly id: string
  readonly attestedBy: string
  readonly startedAt: number
  readonly expiresAt: number
  readonly status: 'open' | 'closed'
}

/** manual 回填见证记录（门禁侧视图）。 */
export interface ManualAttestationRecord {
  readonly caseId: string
  readonly sessionId: string
  readonly attestedBy: string
  readonly at: number
  readonly status: 'pass' | 'fail' | 'skipped'
  readonly note?: string
}

/** 执行器实现契约（http runner 等）。 */
export interface Executor {
  /** 入参只传 caseId；executor 自读用例定义、真实执行、自产记录与证据。 */
  run(caseIds: readonly string[], ctx: ExecutorContext): Promise<ExecutionSession>
}
