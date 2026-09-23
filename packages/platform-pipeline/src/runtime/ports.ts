/**
 * 不依赖具体 Agent 框架的运行时端口。
 *
 * PipelineDriver 已经通过 StageSpawner/HumanGatePort/ReviewRunner 接口隔离
 * 宿主能力；这里把工具和模型边界也显式化，供 CLI、Web 或其他 Agent runtime 注入。
 */

import type { JudgeResult } from '../gates/machine.ts'
import type { ReviewOutcome } from '../driver.ts'
import type { SpawnRequest, SpawnedRun, StageSpawner } from '../stage-spawner.ts'
import type { PipelineConfig, StageArtifact, StageId } from '../types.ts'

export interface StageRunner extends StageSpawner {
  runStage(request: SpawnRequest, cfg: PipelineConfig): Promise<SpawnedRun>
}

export interface LlmMessage {
  readonly role: 'system' | 'user' | 'assistant' | 'tool'
  readonly content: string
  readonly toolCallId?: string
}

export interface LlmToolCall {
  readonly id: string
  readonly name: string
  readonly arguments: string
}

export interface LlmResponse {
  readonly content: string
  readonly json?: unknown
  readonly toolCalls?: readonly LlmToolCall[]
  readonly finishReason?: string
  readonly usage?: Readonly<{ inputTokens?: number; outputTokens?: number }>
}

export interface LlmResponseFormat {
  readonly type: 'text' | 'json_object' | 'json_schema'
  readonly name?: string
  readonly schema?: unknown
  readonly strict?: boolean
}

export interface LlmClient {
  complete(request: {
    readonly model: string
    readonly messages: readonly LlmMessage[]
    readonly tools?: readonly ToolDefinition[]
    readonly responseFormat?: LlmResponseFormat
    readonly signal?: AbortSignal
  }): Promise<LlmResponse>
}

export interface ToolDefinition<TArgs = unknown, TResult = unknown> {
  readonly name: string
  readonly description: string
  /** JSON Schema passed to an OpenAI-compatible model when this tool is exposed. */
  readonly parameters?: unknown
  execute(args: TArgs, context: ToolExecutionContext): Promise<TResult>
}

export interface ToolExecutionContext {
  readonly signal: AbortSignal
  readonly stageId?: StageId
  readonly pipelineId?: string
}

export interface ToolFilter {
  readonly allow?: readonly string[]
  readonly deny?: readonly string[]
}

export interface ToolRegistry {
  register<TArgs, TResult>(tool: ToolDefinition<TArgs, TResult>): void
  get(name: string): ToolDefinition | undefined
  list(): readonly ToolDefinition[]
  restrict(filter: ToolFilter): ToolRegistry
}

export interface HumanGate {
  gate(stageId: StageId, artifact: StageArtifact, gate: JudgeResult, review?: ReviewOutcome): Promise<'approved' | 'changes-needed' | 'rejected'>
  gateFailed(stageId: StageId, gate: JudgeResult): Promise<void>
}
