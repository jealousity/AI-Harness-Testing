/**
 * 生效 ACL 计算与校验（docs/06 第 4/5/9 节）。
 * - 生效 ACL = 平台标准 + 项目 delta（加 deny 自由 / 加 allow 需评审）。
 * - 平台标准 deny 不可降级：delta.allow 不得包含平台 deny 的工具。
 * - 未知工具名 → 启动即失败（spawn 前全量校验）。
 * @module platform-pipeline/acl
 */

import { PLATFORM_ACL, toolById } from './tool-catalog.ts'
import { STAGE_ORDER, type PipelineConfig, type StageId, type ToolFilter } from './types.ts'

export interface AclValidation {
  readonly ok: boolean
  readonly errors: readonly string[]
}

/** 合并平台标准与项目 delta，产出 stage-spawner 实际传给子 agent 的 toolFilter。 */
export function effectiveAcl(stageId: StageId, cfg: PipelineConfig): ToolFilter {
  const base = PLATFORM_ACL[stageId]
  const delta = cfg.stages[stageId].tools
  return {
    ...(base.allow !== undefined || delta?.allow !== undefined
      ? { allow: [...(base.allow ?? []), ...(delta?.allow ?? [])] }
      : {}),
    ...(base.deny !== undefined || delta?.deny !== undefined
      ? { deny: [...(base.deny ?? []), ...(delta?.deny ?? [])] }
      : {}),
  }
}

/**
 * 校验单阶段的项目 delta（docs/06 第 4 节）：
 * - allow/deny 中的工具名必须存在于工具目录；
 * - delta.allow 不得包含平台标准 deny 的工具（试图绕过标准 deny = 降级，拒绝）。
 */
export function validateStageDelta(stageId: StageId, delta: ToolFilter | undefined): AclValidation {
  const errors: string[] = []
  if (delta === undefined) return { ok: true, errors }
  const names = [...(delta.allow ?? []), ...(delta.deny ?? [])]
  for (const name of names) {
    if (toolById(name) === undefined) {
      errors.push(`stage "${stageId}": unknown tool "${name}" in project ACL delta`)
    }
  }
  const baseDeny = new Set(PLATFORM_ACL[stageId].deny ?? [])
  for (const name of delta.allow ?? []) {
    if (baseDeny.has(name)) {
      errors.push(`stage "${stageId}": delta.allow "${name}" attempts to lift a platform-standard deny (not allowed)`)
    }
  }
  return { ok: errors.length === 0, errors }
}

/** 全流水线 ACL 校验：每个阶段的 delta 都合法。 */
export function validatePipelineAcl(cfg: PipelineConfig): AclValidation {
  const errors: string[] = []
  for (const stageId of STAGE_ORDER) {
    const result = validateStageDelta(stageId, cfg.stages[stageId].tools)
    errors.push(...result.errors)
  }
  return { ok: errors.length === 0, errors }
}
