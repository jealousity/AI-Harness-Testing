/**
 * 从平台数据根和 pipeline 配置计算项目级持久化目录。
 * 宿主可以用它装配 FsArtifactStore、FsCheckpointPort、知识库和用例库，
 * 避免各入口分别拼路径导致跨项目串读。
 */

import { resolve } from 'node:path'
import type { PipelineConfig } from './types.ts'
import { projectDataRoot, scopedPath, type ScopeContext } from './platform-scope.ts'

export interface PlatformStorageRoots {
  readonly projectRoot: string
  readonly artifactsRoot: string
  readonly checkpointRoot: string
  readonly knowledgeRoot?: string
  readonly casesRoot?: string
}

export function resolvePlatformRoots(dataRoot: string, config: Pick<PipelineConfig, 'projectId' | 'scope' | 'stores'>): PlatformStorageRoots {
  const scope: ScopeContext = {
    projectId: config.projectId,
    ...(config.scope?.tenantId === undefined ? {} : { tenantId: config.scope.tenantId }),
    ...(config.scope?.environment === undefined ? {} : { environment: config.scope.environment }),
  }
  const projectRoot = projectDataRoot(dataRoot, scope)
  const knowledgeRoot = config.stores.knowledge.impl === 'markdown-fs' && typeof config.stores.knowledge.path === 'string'
    ? scopedPath(dataRoot, scope, config.stores.knowledge.path)
    : undefined
  const casesRoot = config.stores.cases.impl === 'markdown-fs' && typeof config.stores.cases.path === 'string'
    ? scopedPath(dataRoot, scope, config.stores.cases.path)
    : undefined
  return {
    projectRoot,
    // FsArtifactStore receives the project workspace root because artifact paths
    // already include the `artifacts/<pipelineId>/...` prefix.
    artifactsRoot: projectRoot,
    checkpointRoot: resolve(projectRoot, 'checkpoints'),
    ...(knowledgeRoot === undefined ? {} : { knowledgeRoot }),
    ...(casesRoot === undefined ? {} : { casesRoot }),
  }
}
