/**
 * stage-spawner 的 harness 适配层（docs/09 第 3 节 / docs/06 第 5 节）。
 * 通过 `ctx.subagents.start(name, request)` 实际 spawn 阶段 agent：
 * - 生效 ACL → harness ToolRestriction（结构一致，allow 存在即白名单）；
 * - assemblePrompt → ContentBlock[]（text 消息）；
 * - 前台等待 run.result（stopReason === 'completed' 为成功）。
 *
 * 依赖声明为 peerDependencies（由宿主 harness 提供）；devDependencies 仅用于
 * typecheck。execute 阶段的后台可续跑 spawn（docs/09 验证点 5）已落地：
 * request.mode === 'continuable' 时走 ctx.subagents.startContinuable，
 * 再用 listChildren 轮询 child activity 转 'inactive' 视为完成；provider
 * 无 prepareContinuable 能力时透明降级为前台 one-shot。
 *
 * ⚠️ 运行时零 harness 依赖：本模块对 @deepseek-ai/* 全部为 type-only import，
 * 类型擦除后无运行时引用——保持"独立 npm 包"部署模型（I-4）。
 * @module platform-pipeline/harness/stage-spawner-harness
 */

import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { SubagentListEntry, SubagentRuntime, SubagentStartRequest } from '@deepseek-ai/dsh-subagent'
import type { ToolRestriction } from '@deepseek-ai/dsh-tools'
import { assemblePrompt } from '../prompt/assemble.ts'
import { resolveStageAcl, type SpawnRequest, type SpawnedRun, type StageSpawner } from '../stage-spawner.ts'
import type { PipelineConfig, ToolFilter } from '../types.ts'

/** 宿主注入面：subagents 服务 + 当前 agent（parent）+ 取消信号。 */
export interface HarnessSpawnerDeps {
  /** `ctx.subagents` 的 start 面；可选附带 startContinuable/listChildren 以启用后台可续跑。 */
  readonly subagents: Pick<SubagentRuntime, 'start'> & Partial<ContinuableOps>
  /** 发起 spawn 的宿主 agent（in-process provider 从此派生 workspace/lineage/depth）。 */
  readonly parent: Agent
  /** 取消信号（来自宿主调用上下文）。 */
  readonly signal: AbortSignal
  /** provider 名；默认 'spawn'（in-process one-shot）。 */
  readonly providerName?: string
  /** 子 agent 委托深度上限（可选）。 */
  readonly maxDepth?: number
  /** 后台可续跑轮询间隔（测试可注入；默认 2000ms）。 */
  readonly continuablePollMs?: number
}

/** 后台可续跑所需子集（harness 提供；本包仅 type 引用，运行时由宿主注入）。 */
interface ContinuableOps {
  startContinuable(spec: {
    provider: string
    label: string
    request: Omit<SubagentStartRequest, 'label' | 'signal' | 'outputSchema'>
    signal: AbortSignal
  }): Promise<{ readonly childId: string; readonly messageId: string }>
  listChildren(parentSessionId: string, signal?: AbortSignal): Promise<SubagentListEntry[]>
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
      inputDigests: request.inputDigests,
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

    // 后台可续跑（execute 等长任务；provider 无 prepareContinuable 时透明降级为 oneshot）。
    if (request.mode === 'continuable' && this.deps.subagents.startContinuable !== undefined) {
      const childId = await this.startContinuable_(startRequest)
      return { stageId: request.stageId, artifactPath: request.artifactPath, childId }
    }

    const run = await this.deps.subagents.start(this.deps.providerName ?? 'spawn', startRequest)
    try {
      const result = await run.result
      if (result.stopReason !== 'completed') {
        console.log(`[HarnessStageSpawner] ${request.stageId} stop=${result.stopReason} diagnostic=${JSON.stringify(result.diagnostic ?? null)} outputLen=${result.output?.length ?? 0}`)
        const diag = result.diagnostic !== undefined ? ` (${result.diagnostic})` : ''
        const output = (result.output ?? []).map((b) => 'text' in b ? String(b.text ?? '') : '')
          .join('\n').slice(0, 800)
        if (output) console.log(`[HarnessStageSpawner] ${request.stageId} ${result.stopReason}${diag}: ${JSON.stringify(output)}`)
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

  /** 启动后台可续跑 child，并等待其完成（写产物）后才返回。 */
  private async startContinuable_(startRequest: SubagentStartRequest): Promise<string> {
    const ops = this.deps.subagents
    if (ops.startContinuable === undefined) {
      throw new Error('HarnessStageSpawner: startContinuable is not provided by the subagents adapter')
    }
    type ContinuableSpec = {
      provider: string
      label: string
      request: Omit<SubagentStartRequest, 'label' | 'signal' | 'outputSchema'>
      signal: AbortSignal
    }
    const spec: ContinuableSpec = {
      provider: this.deps.providerName ?? 'spawn',
      label: startRequest.label ?? this.deps.parent.id,
      request: {
        prompt: startRequest.prompt,
        parent: startRequest.parent,
        toolFilter: startRequest.toolFilter,
        ...(startRequest.agentOptions !== undefined ? { agentOptions: startRequest.agentOptions } : {}),
        ...(startRequest.maxDepth !== undefined ? { maxDepth: startRequest.maxDepth } : {}),
        ...(startRequest.persona !== undefined ? { persona: startRequest.persona } : {}),
      },
      signal: this.deps.signal,
    }
    // 必须带接收者调用：解构出来的方法会丢 this
    // （SubagentService.startContinuable 内部是 this.requireContinuations()，
    //  脱离接收者调用会报 "Cannot read properties of undefined"，已在真实宿主实测到）
    const { childId } = await ops.startContinuable(spec)
    await this.waitContinuable(childId, this.deps.signal)
    return childId
  }

  /** 等待一个已存在的后台可续跑 child 完成（activity 转 'inactive'）。恢复续跑复用此路径。 */
  async waitContinuable(childId: string, signal?: AbortSignal): Promise<void> {
    const ops = this.deps.subagents
    if (ops.listChildren === undefined) return // 无 listChildren 能力：no-op 降级
    const parentSessionId = this.deps.parent.id
    const poll = this.deps.continuablePollMs ?? 2000
    while (!signal?.aborted) {
      // 同样必须带接收者调用（见上：解构会丢 this）
      const entries = await ops.listChildren(parentSessionId, signal)
      const entry = entries.find(e => e.id === childId)
      if (entry?.kind === 'child' && entry.activity === 'inactive') return
      if (entry?.kind === 'diagnostic') {
        throw new Error(`stage continuable child "${childId}" ended in diagnostic state: ${entry.reason}`)
      }
      // 尚处于创建窗口或仍 running：轮询等待
      await new Promise<void>(resolve => setTimeout(resolve, poll))
    }
  }
}
