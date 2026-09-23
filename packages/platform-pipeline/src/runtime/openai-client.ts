import type { LlmClient, LlmMessage, LlmResponse, LlmResponseFormat, ToolDefinition } from './ports.ts'

export interface OpenAICompatibleClientOptions {
  readonly baseUrl: string
  readonly apiKey?: string
  readonly apiKeyEnv?: string
  readonly defaultModel?: string
  readonly timeoutMs?: number
  readonly maxRetries?: number
  readonly fetchImpl?: typeof fetch
  readonly headers?: Readonly<Record<string, string>>
}

export class OpenAICompatibleError extends Error {
  readonly status?: number
  readonly retriable: boolean
  readonly providerMessage: string

  constructor(message: string, options: { status?: number; retriable?: boolean; providerMessage?: string } = {}) {
    super(message)
    this.name = 'OpenAICompatibleError'
    this.status = options.status
    this.retriable = options.retriable ?? false
    this.providerMessage = options.providerMessage ?? message
  }
}

export class OpenAICompatibleClient implements LlmClient {
  private readonly baseUrl: string
  private readonly apiKey: string
  private readonly defaultModel?: string
  private readonly timeoutMs: number
  private readonly maxRetries: number
  private readonly fetchImpl: typeof fetch
  private readonly headers: Readonly<Record<string, string>>

  constructor(options: OpenAICompatibleClientOptions) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl)
    this.apiKey = resolveApiKey(options)
    this.defaultModel = options.defaultModel
    this.timeoutMs = validatePositiveInteger(options.timeoutMs ?? 180_000, 'timeoutMs')
    this.maxRetries = validateNonNegativeInteger(options.maxRetries ?? 1, 'maxRetries')
    this.fetchImpl = options.fetchImpl ?? fetch
    this.headers = options.headers ?? {}
  }

  async complete(request: Parameters<LlmClient['complete']>[0]): Promise<LlmResponse> {
    const model = request.model || this.defaultModel
    if (model === undefined || model.trim() === '') throw new OpenAICompatibleError('LLM model is required')
    const callerSignal = request.signal ?? new AbortController().signal
    const body = {
      model,
      messages: request.messages.map(toMessage),
      ...(request.tools === undefined ? {} : { tools: request.tools.map(toOpenAITool) }),
      ...(request.responseFormat === undefined ? {} : { response_format: toResponseFormat(request.responseFormat) }),
    }

    let lastError: unknown
    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      try {
        const response = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${this.apiKey}`,
            'content-type': 'application/json',
            ...this.headers,
          },
          body: JSON.stringify(body),
          signal: combineSignals(AbortSignal.timeout(this.timeoutMs), callerSignal),
        })
        const raw = await response.text()
        const payload = parseJson(raw)
        if (!response.ok) {
          const providerMessage = extractProviderMessage(payload, raw)
          const error = new OpenAICompatibleError(`LLM request failed (HTTP ${response.status}): ${providerMessage}`, {
            status: response.status,
            retriable: response.status === 429 || response.status >= 500,
            providerMessage,
          })
          if (error.retriable && attempt < this.maxRetries) {
            await wait(backoffMs(attempt), callerSignal)
            lastError = error
            continue
          }
          throw error
        }
        return parseResponse(payload)
      } catch (error) {
        if (isAbortError(error, callerSignal)) throw new OpenAICompatibleError('LLM request was cancelled or timed out', { providerMessage: 'cancelled or timed out' })
        lastError = error
        if (error instanceof OpenAICompatibleError && !error.retriable) throw error
        if (attempt < this.maxRetries) {
          await wait(backoffMs(attempt), callerSignal)
          continue
        }
      }
    }
    if (lastError instanceof Error) throw lastError
    throw new OpenAICompatibleError('LLM request failed')
  }
}

function resolveApiKey(options: OpenAICompatibleClientOptions): string {
  const key = options.apiKey ?? (options.apiKeyEnv === undefined ? undefined : process.env[options.apiKeyEnv])
  if (key === undefined || key.trim() === '') throw new OpenAICompatibleError(`missing API key${options.apiKeyEnv === undefined ? '' : ` environment variable: ${options.apiKeyEnv}`}`)
  return key.trim()
}

function normalizeBaseUrl(value: string): string {
  const baseUrl = value.trim().replace(/\/+$/, '')
  let url: URL
  try { url = new URL(baseUrl) } catch { throw new OpenAICompatibleError('baseUrl must be a valid URL') }
  if (!['http:', 'https:'].includes(url.protocol)) throw new OpenAICompatibleError('baseUrl must use http or https')
  if (url.username || url.password) throw new OpenAICompatibleError('baseUrl must not contain credentials')
  return baseUrl
}

function toMessage(message: LlmMessage): Record<string, unknown> {
  return {
    role: message.role,
    content: message.content,
    ...(message.toolCallId === undefined ? {} : { tool_call_id: message.toolCallId }),
    ...(message.toolName === undefined ? {} : { name: message.toolName }),
    ...(message.toolCalls === undefined ? {} : { tool_calls: message.toolCalls.map(toolCall => ({
      id: toolCall.id,
      type: 'function',
      function: { name: toolCall.name, arguments: toolCall.arguments },
    })) }),
  }
}

function toOpenAITool(tool: ToolDefinition): Record<string, unknown> {
  return {
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters ?? { type: 'object', additionalProperties: true },
    },
  }
}

function toResponseFormat(format: LlmResponseFormat): Record<string, unknown> {
  if (format.type === 'json_schema') {
    if (format.name === undefined || format.schema === undefined) throw new OpenAICompatibleError('json_schema response format requires name and schema')
    return { type: 'json_schema', json_schema: { name: format.name, schema: format.schema, strict: format.strict ?? true } }
  }
  return { type: format.type }
}

function parseResponse(payload: unknown): LlmResponse {
  if (payload === null || typeof payload !== 'object') throw new OpenAICompatibleError('LLM response was not valid JSON')
  const choice = (payload as { choices?: unknown[] }).choices?.[0]
  if (choice === null || typeof choice !== 'object') throw new OpenAICompatibleError('LLM response did not contain a choice')
  const message = (choice as { message?: unknown }).message
  if (message === null || typeof message !== 'object') throw new OpenAICompatibleError('LLM response did not contain a message')
  const contentValue = (message as { content?: unknown }).content
  const content = typeof contentValue === 'string' ? contentValue : contentValue === null || contentValue === undefined ? '' : JSON.stringify(contentValue)
  const toolCallsRaw = (message as { tool_calls?: unknown }).tool_calls
  const toolCalls = Array.isArray(toolCallsRaw) ? toolCallsRaw.map(toToolCall).filter((value): value is NonNullable<typeof value> => value !== undefined) : undefined
  const usageRaw = (payload as { usage?: { prompt_tokens?: unknown; completion_tokens?: unknown } }).usage
  const usage = usageRaw === undefined ? undefined : {
    ...(typeof usageRaw.prompt_tokens === 'number' ? { inputTokens: usageRaw.prompt_tokens } : {}),
    ...(typeof usageRaw.completion_tokens === 'number' ? { outputTokens: usageRaw.completion_tokens } : {}),
  }
  let json: unknown
  if (content.trim() !== '') {
    try { json = JSON.parse(content) } catch { json = undefined }
  }
  return {
    content,
    ...(json === undefined ? {} : { json }),
    ...(toolCalls?.length === 0 ? {} : { toolCalls }),
    ...((choice as { finish_reason?: unknown }).finish_reason === undefined ? {} : { finishReason: String((choice as { finish_reason: unknown }).finish_reason) }),
    ...(usage === undefined ? {} : { usage }),
  }
}

function toToolCall(value: unknown): { id: string; name: string; arguments: string } | undefined {
  if (value === null || typeof value !== 'object') return undefined
  const item = value as { id?: unknown; function?: { name?: unknown; arguments?: unknown } }
  if (typeof item.id !== 'string' || item.function === undefined || typeof item.function.name !== 'string') return undefined
  return { id: item.id, name: item.function.name, arguments: typeof item.function.arguments === 'string' ? item.function.arguments : JSON.stringify(item.function.arguments ?? {}) }
}

function parseJson(raw: string): unknown {
  try { return JSON.parse(raw) } catch { return raw }
}

function extractProviderMessage(payload: unknown, raw: string): string {
  if (payload !== null && typeof payload === 'object') {
    const error = (payload as { error?: { message?: unknown } | string }).error
    const message = typeof error === 'string' ? error : error?.message
    if (typeof message === 'string' && message.trim() !== '') return message.slice(0, 300)
    const messageValue = (payload as { message?: unknown }).message
    if (typeof messageValue === 'string' && messageValue.trim() !== '') return messageValue.slice(0, 300)
  }
  return raw.trim().slice(0, 300) || 'provider returned no error message'
}

function validatePositiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new OpenAICompatibleError(`${name} must be a positive integer`)
  return value
}

function validateNonNegativeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new OpenAICompatibleError(`${name} must be a non-negative integer`)
  return value
}

function backoffMs(attempt: number): number { return Math.min(2_000, 250 * (2 ** attempt)) }
function wait(ms: number, signal: AbortSignal): Promise<void> { return new Promise((resolve, reject) => { const timer = setTimeout(resolve, ms); if (signal.aborted) { clearTimeout(timer); reject(signal.reason) } else signal.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason) }, { once: true }) }) }
function combineSignals(primary: AbortSignal, secondary?: AbortSignal): AbortSignal { if (secondary === undefined) return primary; return AbortSignal.any([primary, secondary]) }
function isAbortError(error: unknown, signal: AbortSignal): boolean { return signal.aborted || (error instanceof Error && error.name === 'AbortError') }
