import { assemblePrompt } from '../prompt/assemble.ts'
import { computeArtifactDigest } from '../gates/machine.ts'
import { resolveStageAcl, type SpawnRequest, type SpawnedRun, type StageSpawner } from '../stage-spawner.ts'
import type { ArtifactStore } from '../driver.ts'
import type { PipelineConfig, StageArtifact } from '../types.ts'
import type { LlmClient, LlmMessage, LlmResponse, ToolDefinition, ToolRegistry } from './ports.ts'

export interface OpenAIStageRunnerOptions {
  readonly llm: LlmClient
  readonly tools?: ToolRegistry
  readonly artifacts: ArtifactStore
  readonly model: string
  readonly systemPrompt?: string
  readonly maxToolSteps?: number
  readonly signal?: AbortSignal
}

/**
 * 无 Harness 的 Agent 阶段运行器：prompt → LLM → 受限工具调用 → 结构化产物。
 *
 * 它只依赖 LlmClient、ToolRegistry 和 ArtifactStore，Harness 适配器可以完全替换。
 */
export class OpenAIStageRunner implements StageSpawner {
  private readonly options: OpenAIStageRunnerOptions

  constructor(options: OpenAIStageRunnerOptions) {
    this.options = options
  }

  async runStage(request: SpawnRequest, cfg: PipelineConfig): Promise<SpawnedRun> {
    const resolved = resolveStageAcl(request.stageId, cfg)
    if (!resolved.ok) throw new Error(`stage "${request.stageId}" ACL invalid: ${resolved.errors.join('; ')}`)
    const prompt = assemblePrompt({
      stageId: request.stageId,
      pipelineId: request.pipelineId,
      inputPaths: request.inputPaths,
      inputDigests: request.inputDigests,
      artifactPath: request.artifactPath,
      budget: cfg.stages[request.stageId].budget,
      toolAcl: resolved.acl,
      schemaFilePath: `schemas/${request.stageId}.schema.json`,
      ...(request.extraContext === undefined ? {} : { extraContext: request.extraContext }),
      ...(request.previousViolations === undefined ? {} : { previousViolations: request.previousViolations }),
    })
    // A generic runtime may provide only a subset of the platform catalog. Expose
    // the intersection; an unavailable model-requested name is handled explicitly
    // below instead of failing before the LLM gets a chance to finish.
    const restrictedTools = this.options.tools === undefined ? [] : this.options.tools.list().filter(tool => isAllowedTool(tool.name, resolved.acl))
    const messages: LlmMessage[] = [
      ...(this.options.systemPrompt === undefined ? [] : [{ role: 'system' as const, content: this.options.systemPrompt }]),
      { role: 'user', content: prompt },
    ]
    let response: LlmResponse | undefined
    const maxSteps = Math.min(cfg.stages[request.stageId].budget.maxSteps, this.options.maxToolSteps ?? 20)
    for (let step = 0; step < maxSteps; step += 1) {
      response = await this.options.llm.complete({
        model: this.options.model,
        messages,
        ...(restrictedTools.length === 0 ? {} : { tools: restrictedTools }),
        responseFormat: { type: 'json_object' },
        signal: this.options.signal,
      })
      if (response.toolCalls === undefined || response.toolCalls.length === 0) break
      messages.push({
        role: 'assistant',
        content: response.content,
        toolCalls: response.toolCalls,
      })
      for (const call of response.toolCalls) {
        const tool = restrictedTools.find(candidate => candidate.name === call.name)
        if (tool === undefined) {
          messages.push({ role: 'tool', toolCallId: call.id, toolName: call.name, content: JSON.stringify({ error: `tool is not available: ${call.name}` }) })
          continue
        }
        messages.push({
          role: 'tool',
          toolCallId: call.id,
          toolName: call.name,
          content: await executeToolCall(tool, call.arguments, {
            signal: this.options.signal ?? new AbortController().signal,
            stageId: request.stageId,
            pipelineId: request.pipelineId,
          }),
        })
      }
    }
    if (response === undefined) throw new Error(`stage "${request.stageId}" received no LLM response`)
    if (response.toolCalls !== undefined && response.toolCalls.length > 0) throw new Error(`stage "${request.stageId}" exceeded tool-call step budget (${maxSteps})`)
    const content = parseStructuredContent(response)
    const previous = await this.options.artifacts.read(request.artifactPath)
    const base: StageArtifact = {
      pipelineId: request.pipelineId,
      stageId: request.stageId,
      version: (previous?.version ?? 0) + 1,
      inputs: request.inputDigests ?? {},
      content,
      digest: '',
      path: request.artifactPath,
    }
    if (this.options.artifacts.write === undefined) throw new Error('OpenAIStageRunner requires an ArtifactStore.write implementation')
    await this.options.artifacts.write({ ...base, digest: computeArtifactDigest(base) })
    return { stageId: request.stageId, artifactPath: request.artifactPath }
  }
}

async function executeToolCall(tool: ToolDefinition, rawArguments: string, context: { signal: AbortSignal; stageId: SpawnRequest['stageId']; pipelineId: string }): Promise<string> {
  let args: unknown
  try { args = rawArguments.trim() === '' ? {} : JSON.parse(rawArguments) } catch {
    return JSON.stringify({ error: 'tool arguments were not valid JSON' })
  }
  try {
    const result = await tool.execute(args, context)
    return serializeToolResult(result)
  } catch (error) {
    return JSON.stringify({ error: error instanceof Error ? error.message : String(error) })
  }
}

function parseStructuredContent(response: LlmResponse): unknown {
  if (response.json !== undefined) return response.json
  const text = response.content.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
  if (text === '') throw new Error('LLM returned empty stage artifact')
  try { return JSON.parse(text) } catch { throw new Error('LLM returned non-JSON stage artifact') }
}

function isAllowedTool(name: string, filter: { readonly allow?: readonly string[]; readonly deny?: readonly string[] }): boolean {
  if (filter.deny?.includes(name)) return false
  return filter.allow === undefined || filter.allow.includes(name)
}

function serializeToolResult(value: unknown): string {
  if (typeof value === 'string') return value
  try { return JSON.stringify(value) } catch { return JSON.stringify({ error: 'tool result was not serializable' }) }
}
