/**
 * 工具目录与平台标准 ACL（docs/06 第 2/3 节）。
 * 工具目录：平台注册工具时声明 effect/store/requiresApproval 元数据。
 * 平台标准 ACL：每阶段默认 allow/deny，不可删除、不可降级（docs/06 第 3 节）。
 * @module platform-pipeline/tool-catalog
 */

import type { StageId, ToolFilter } from './types.ts'

export type ToolEffect = 'read-only' | 'mutate-workspace' | 'mutate-external' | 'ask-human'
export type ToolStore = 'knowledge' | 'cases' | 'requirements' | 'fs' | 'executor' | 'external' | 'checkpoint'

export interface ToolEntry {
  readonly id: string
  readonly effect: ToolEffect
  readonly store: ToolStore
  /** 执行前暂停等人工确认（docs/06 第 7 节）；归档写库与门 G 融合为批次审批。 */
  readonly requiresApproval?: boolean
}

/** 工具目录（docs/06 第 2 节）。 */
export const TOOL_CATALOG: readonly ToolEntry[] = [
  { id: 'kb_query', effect: 'read-only', store: 'knowledge' },
  { id: 'kb_write', effect: 'mutate-external', store: 'knowledge', requiresApproval: true },
  { id: 'case_query', effect: 'read-only', store: 'cases' },
  { id: 'case_archive', effect: 'mutate-external', store: 'cases', requiresApproval: true },
  { id: 'req_pull', effect: 'read-only', store: 'requirements' },
  { id: 'parse_doc', effect: 'read-only', store: 'requirements' },
  { id: 'fs_read', effect: 'read-only', store: 'fs' },
  { id: 'fs_write', effect: 'mutate-workspace', store: 'fs' },
  { id: 'executor_run', effect: 'mutate-workspace', store: 'executor' },
  { id: 'env_diag', effect: 'read-only', store: 'executor' },
  { id: 'gate_check', effect: 'read-only', store: 'checkpoint' },
  { id: 'subagent', effect: 'ask-human', store: 'executor' },
]

/** 按 id 查工具；未知 id 返回 undefined（spawn 前全量校验用）。 */
export function toolById(id: string): ToolEntry | undefined {
  return TOOL_CATALOG.find(entry => entry.id === id)
}

/**
 * 平台标准 ACL（docs/06 第 3 节）。
 * - deny 兜底：平台演进新增工具时若不在任何 allow 里，默认不可达。
 * - execute 的 fs_write 路径范围排除 evidence/（docs/08 第 2 节，执行可信），
 *   此处以注释标记；路径级收窄由 stage-spawner 实现时落地。
 */
export const PLATFORM_ACL: Readonly<Record<StageId, ToolFilter>> = {
  receive: {
    allow: ['parse_doc', 'fs_read', 'fs_write'],
    deny: ['kb_query', 'kb_write', 'case_query', 'case_archive', 'executor_run', 'env_diag', 'subagent'],
  },
  analyze: {
    allow: ['kb_query', 'case_query', 'fs_read', 'fs_write'],
    deny: ['kb_write', 'case_archive', 'parse_doc', 'executor_run', 'env_diag', 'subagent'],
  },
  design: {
    allow: ['fs_read', 'fs_write'],
    deny: ['kb_query', 'kb_write', 'case_query', 'case_archive', 'parse_doc', 'executor_run', 'env_diag', 'subagent'],
  },
  execute: {
    allow: ['fs_read', 'fs_write', 'executor_run', 'env_diag'],
    deny: ['kb_write', 'case_archive', 'parse_doc', 'subagent'],
  },
  report: {
    allow: ['fs_read', 'fs_write'],
    deny: ['kb_write', 'case_archive', 'parse_doc', 'executor_run', 'env_diag', 'subagent'],
  },
  archive: {
    allow: ['fs_read', 'fs_write', 'kb_write', 'case_archive'],
    deny: ['parse_doc', 'executor_run', 'env_diag', 'subagent'],
  },
}
