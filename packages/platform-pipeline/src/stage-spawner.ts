/**
 * 阶段 spawn（docs/09 第 3 节 / docs/06 第 5 节）。
 * 强制层落点：生效 ACL → toolFilter；本包暴露接口，harness 绑定（SubagentProvider.start）
 * 由宿主插件实现（<验证点>：ResolvedSubagentStartRequest 精确形状）。
 * @module platform-pipeline/stage-spawner
 */

import type { Checkpoint, StageId, ToolFilter } from './types.ts'
import { effectiveAcl, validateStageDelta } from './acl.ts'
import type { PipelineConfig } from './types.ts'

export interface SpawnRequest {
  readonly stageId: StageId
  readonly pipelineId: string
  readonly inputPaths: Readonly<Record<string, string>>
  readonly artifactPath: string
  readonly extraContext?: string
  /** 门禁重跑时回喂的违规清单。 */
  readonly previousViolations?: readonly { rule: string; level: 'BLOCKING' | 'WARNING'; detail: string; at: number }[]
}

export interface SpawnedRun {
  readonly stageId: StageId
  /** 阶段 agent 产物路径（spawn 结束后由调用方读取并交机器门禁）。 */
  readonly artifactPath: string
}

/**
 * 阶段 agent spawn 服务（宿主实现）：
 * 1. 计算生效 ACL（平台标准 + delta），校验未知工具 / 标准 deny 降级；
 * 2. 拼装 prompt（assemblePrompt）；
 * 3. 调 SubagentProvider.start({ request: { toolFilter: acl, ... } })——被禁工具物理不可达；
 * 4. execute 阶段用后台可续跑 spawn（恢复走 continuation，不重跑）。
 */
export interface StageSpawner {
  runStage(request: SpawnRequest, cfg: PipelineConfig): Promise<SpawnedRun>
}

/** 宿主实现前的纯逻辑辅助：解析生效 ACL 并校验（供实现与测试复用）。 */
export function resolveStageAcl(stageId: StageId, cfg: PipelineConfig): { ok: true; acl: ToolFilter } | { ok: false; errors: string[] } {
  const delta = cfg.stages[stageId].tools
  const validation = validateStageDelta(stageId, delta)
  if (!validation.ok) return { ok: false, errors: [...validation.errors] }
  return { ok: true, acl: effectiveAcl(stageId, cfg) }
}

/** 恢复辅助：根据检查点状态决定本次运行是首次/重跑/续跑，产出对应 extraContext 提示。 */
export function stageRunContext(stageId: StageId, cp: Checkpoint): { kind: 'first' | 'needs-fix' | 'reentry'; extra?: string } {
  const stage = cp.stageStates[stageId]
  switch (stage.status) {
    case 'needs-fix': {
      const violations = stage.gate.machine.violations
      return {
        kind: 'needs-fix',
        extra: `机器门禁判定未通过，需修复以下问题：\n${violations.map(v => `- [${v.level}] ${v.rule}: ${v.detail}`).join('\n')}`,
      }
    }
    case 'needs-reentry':
      return { kind: 'reentry', extra: '本次为人工发起的重入重跑：上游可能已变更，按当前输入重新执行；已 pass 的下游将级联重跑。' }
    default:
      return { kind: 'first' }
  }
}
