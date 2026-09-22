/**
 * Harness 宿主启动前的通用配置解析。
 *
 * 这里不启动 Cordis，也不加载具体 LLM 插件；只把项目配置转换为安全、
 * 可供 host-plugin 使用的运行时信息。这样 CLI、GUI 和未来 Web worker
 * 可以共享同一套 provider 与项目目录规则。
 */

import type { PipelineConfig } from '../types.ts'
import { resolvePlatformRoots, type PlatformStorageRoots } from '../platform-roots.ts'
import { LlmProviderRegistry, type ResolvedLlmProvider } from '../provider-registry.ts'

export interface HarnessHostStorageInput {
  readonly dataRoot?: string
  readonly artifactsRoot?: string
  readonly checkpointRoot?: string
}

export interface HarnessHostRuntimeInput extends HarnessHostStorageInput {
  readonly providerName?: string
  readonly environment?: Readonly<Record<string, string | undefined>>
}

export interface HarnessHostRuntime {
  readonly roots: PlatformStorageRoots
  readonly providerName?: string
  readonly provider?: ResolvedLlmProvider
}

export function resolveHarnessHostRuntime(config: PipelineConfig, input: HarnessHostRuntimeInput): HarnessHostRuntime {
  const roots = input.dataRoot === undefined
    ? resolveExplicitRoots(input)
    : resolvePlatformRoots(input.dataRoot, config)
  if (config.llm === undefined) {
    return {
      roots,
      ...(input.providerName === undefined ? {} : { providerName: input.providerName }),
    }
  }
  const registry = new LlmProviderRegistry(config.llm, input.environment)
  const provider = registry.resolve(input.providerName ?? config.llm.defaultProvider, {
    tools: true,
    ...(config.stages.analyze.review.enabled || config.stages.design.review.enabled || config.stages.execute.review.enabled || config.stages.report.review.enabled
      ? { structuredOutput: true }
      : {}),
  })
  return { roots, providerName: provider.name, provider }
}

function resolveExplicitRoots(input: HarnessHostStorageInput): PlatformStorageRoots {
  if (input.artifactsRoot === undefined || input.checkpointRoot === undefined) {
    throw new Error('Harness host requires dataRoot or both artifactsRoot and checkpointRoot')
  }
  return {
    projectRoot: input.artifactsRoot,
    artifactsRoot: input.artifactsRoot,
    checkpointRoot: input.checkpointRoot,
  }
}
