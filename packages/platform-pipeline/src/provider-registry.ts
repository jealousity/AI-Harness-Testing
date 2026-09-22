/**
 * 通用模型 provider 注册表。
 *
 * 平台核心只负责校验和选择 provider，不持有 API Key，也不直接发起模型请求。
 * Harness 宿主可以把 selected provider 映射到具体的 LLM 插件。
 */

import type { LlmConfig, LlmProviderConfig } from './types.ts'

export interface ResolvedLlmProvider extends LlmProviderConfig {
  readonly name: string
  readonly apiKey: string
}

export interface ProviderCapabilityRequirement {
  readonly tools?: boolean
  readonly structuredOutput?: boolean
  readonly streaming?: boolean
  readonly continuation?: boolean
}

export class LlmProviderRegistry {
  private readonly config: LlmConfig
  private readonly env: Readonly<Record<string, string | undefined>>

  constructor(config: LlmConfig, env: Readonly<Record<string, string | undefined>> = process.env) {
    this.config = config
    this.env = env
  }

  names(): string[] {
    return Object.keys(this.config.providers).sort()
  }

  resolve(name = this.config.defaultProvider, requirement?: ProviderCapabilityRequirement): ResolvedLlmProvider {
    const provider = this.config.providers[name]
    if (provider === undefined) throw new Error(`unknown llm provider: ${name}`)
    const apiKey = this.env[provider.apiKeyEnv]
    if (apiKey === undefined || apiKey.trim() === '') throw new Error(`missing API key environment variable: ${provider.apiKeyEnv}`)
    const capabilities = provider.capabilities ?? {}
    for (const key of ['tools', 'structuredOutput', 'streaming', 'continuation'] as const) {
      if (requirement?.[key] === true && capabilities[key] !== true) {
        throw new Error(`provider ${name} does not declare required capability: ${key}`)
      }
    }
    return { name, ...provider, apiKey }
  }

  select(requirement?: ProviderCapabilityRequirement): ResolvedLlmProvider {
    const ordered = [this.config.defaultProvider, ...this.names().filter(name => name !== this.config.defaultProvider)]
    const failures: string[] = []
    for (const name of ordered) {
      try {
        return this.resolve(name, requirement)
      } catch (error) {
        failures.push(`${name}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    throw new Error(`no usable llm provider: ${failures.join('; ')}`)
  }
}

export function providerRegistry(config: LlmConfig, env?: Readonly<Record<string, string | undefined>>): LlmProviderRegistry {
  return new LlmProviderRegistry(config, env)
}
