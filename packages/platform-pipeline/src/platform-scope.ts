/**
 * 通用平台作用域和文件布局。
 * 所有宿主（Harness、CLI、Web）都应使用同一套项目边界规则。
 */

import { isAbsolute, join, relative, resolve } from 'node:path'
import type { PlatformScope } from './types.ts'

export interface ScopeContext {
  readonly tenantId?: string
  readonly projectId: string
  readonly environment?: string
}

export function assertScopeMatch(expected: PlatformScope, actual: ScopeContext): void {
  if (expected.projectId !== actual.projectId) throw new Error(`project scope mismatch: expected ${expected.projectId}, got ${actual.projectId}`)
  if (expected.tenantId !== undefined && expected.tenantId !== actual.tenantId) throw new Error(`tenant scope mismatch: expected ${expected.tenantId}, got ${actual.tenantId ?? '(missing)'}`)
  if (expected.environment !== undefined && expected.environment !== actual.environment) throw new Error(`environment scope mismatch: expected ${expected.environment}, got ${actual.environment ?? '(missing)'}`)
}

export function projectDataRoot(root: string, scope: ScopeContext): string {
  const tenant = safeSegment(scope.tenantId ?? 'default', 'tenantId')
  const project = safeSegment(scope.projectId, 'projectId')
  return resolve(root, 'tenants', tenant, 'projects', project)
}

export function scopedPath(root: string, scope: ScopeContext, ...segments: string[]): string {
  const base = projectDataRoot(root, scope)
  const target = resolve(base, ...segments.map(segment => safeRelativeSegment(segment)))
  const rel = relative(base, target)
  if (rel === '..' || rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(rel)) throw new Error('scoped path escapes project data root')
  return target
}

function safeSegment(value: string, field: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) throw new Error(`${field} must be a safe identifier`)
  return value
}

function safeRelativeSegment(value: string): string {
  if (value.trim() === '' || value.includes('\0') || isAbsolute(value) || value.split(/[\\/]/).some(part => part === '..')) throw new Error('path segment must stay inside project data root')
  return value
}
