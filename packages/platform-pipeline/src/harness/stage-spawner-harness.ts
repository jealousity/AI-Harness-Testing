/**
 * stage-spawner 的 harness 适配层（docs/09 第 3 节 / docs/06 第 5 节）。
 * 通过 `ctx.subagents.start(name, request)` 实际 spawn 阶段 agent：
 * - 生效 ACL → harness ToolRestriction（结构一致，allow 存在即白名单）；
 * - assemblePrompt → ContentBlock[]（text 消息）；
 * - 前台等待 run.result（stopReason === 'completed' 为成功）。
 *
 * 依赖声明为 peerDependencies（由宿主 harness 提供）；devDependencies 仅用于
 * typecheck。execute 阶段的后台可续跑 spawn（continuation manager）为 TODO：
 * 见 docs/09 验证点 5，先用前台 one-shot 覆盖（execute 长任务后续接入）。
 *
 * ⚠️ 运行时零 harness 依赖：本模块对 @deepseek-ai/* 全部为 type-only import，
 * 类型擦除后无运行时引用——保持"独立 npm 包"部署模型（I-4）。
 * @module platform-pipeline/harness/stage-spawner-harness
 */

import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { SubagentRuntime, SubagentStartRequest } from '@deepseek-ai/dsh-subagent'
import type { ToolRestriction } from '@deepseek-ai/dsh-tools'
import { assemblePrompt } from '../prompt/assemble.ts'
import { resolveStageAcl, type SpawnRequest, type SpawnedRun, type StageSpawner } from '../stage-spawner.ts'
import type { PipelineConfig, ToolFilter } from '../types.ts'

/** 宿主注入面：subagents 服务 + 当前 agent（parent）+ 取消信号。 */
export interface HarnessSpawnerDeps {
  /** `ctx.subagents` 的 start 面。 */
  readonly subagents: Pick<SubagentRuntime, 'start'>
  /** 发起 spawn 的宿主 agent（in-process provider 从此派生 workspace/lineage/depth）。 */
  readonly parent: Agent
  /** 取消信号（来自宿主调用上下文）。 */
  readonly signal: AbortSignal
  /** provider 名；默认 'spawn'（in-process one-shot）。 */
  readonly providerName?: string
  /** 子 agent 委托深度上限（可选）。 */
  readonly maxDepth?: number
}

/** prompt 字符串 → harness ContentBlock[]（text 消息）。 */
export function toContentBlocks(prompt: string): ContentBlock[] {
  return [{ type: 'text', text: prompt }]
}

/** 生效 ACL → harness ToolRestriction（结构一致；allow 存在即白名单）。 */
export function toToolRestriction(filter: ToolFilter): ToolRestriction {
  return {
    ...(filter.allow === undefined ? {} : { allow: filter.allow }),
    ...(filter.deny === undefined ? {} : { deny: filter.deny }),
  }
}

/** harness 适配的 StageSpawner 实现。 */
export class HarnessStageSpawner implements StageSpawner {
  private readonly deps: HarnessSpawnerDeps

  constructor(deps: HarnessSpawnerDeps) {
    this.deps = deps
  }

  async runStage(request: SpawnRequest, cfg: PipelineConfig): Promise<SpawnedRun> {
    const resolved = resolveStageAcl(request.stageId, cfg)
    if (!resolved.ok) {
      throw new Error(`stage "${request.stageId}" ACL invalid: ${resolved.errors.join('; ')}`)
    }
    const prompt = assemblePrompt({
      stageId: request.stageId,
      pipelineId: request.pipelineId,
      inputPaths: request.inputPaths,
      artifactPath: request.artifactPath,
      budget: cfg.stages[request.stageId].budget,
      toolAcl: resolved.acl,
      schemaFilePath: `schemas/${request.stageId}.schema.json`,
      extraContext: request.extraContext,
      previousViolations: request.previousViolations,
    })
    const startRequest: SubagentStartRequest = {
      label: request.stageId,
      prompt: toContentBlocks(prompt),
      parent: this.deps.parent,
      signal: this.deps.signal,
      toolFilter: toToolRestriction(resolved.acl),
      ...(this.deps.maxDepth === undefined ? {} : { maxDepth: this.deps.maxDepth }),
    }
    const run = await this.deps.subagents.start(this.deps.providerName ?? 'spawn', startRequest)
    try {
      const result = await run.result
      if (result.stopReason !== 'completed') {
        throw new Error(
          `stage "${request.stageId}" subagent ended with ${result.stopReason}`
          + (result.diagnostic === undefined ? '' : `: ${result.diagnostic}`),
        )
      }
    } finally {
      run.dispose()
    }
    return { stageId: request.stageId, artifactPath: request.artifactPath }
  }
}
