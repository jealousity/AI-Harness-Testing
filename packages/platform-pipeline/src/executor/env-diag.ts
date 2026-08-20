/**
 * env_diag：环境只读诊断（docs/06 工具目录；docs/08 execute 阶段系统级问题诊断）。
 * 固定探针，只返回结构化结果，不授予任意命令执行权：
 * - disk：磁盘用量（statfs）；
 * - network：TCP 可达性（net.connect 带超时）；
 * - service：HTTP 健康检查（fetch 带超时）；
 * - credentials：环境变量存在性（不泄露值）。
 * @module platform-pipeline/executor/env-diag
 */

import { statfs } from 'node:fs/promises'
import { connect } from 'node:net'

export type DiagKind = 'disk' | 'network' | 'service' | 'credentials'

export interface DiagProbe {
  readonly kind: DiagKind
  /** disk: 路径；network: host；service: url；credentials: 环境变量名。 */
  readonly target: string
  readonly ok: boolean
  readonly detail: string
  readonly at: number
}

export interface DiagSpec {
  readonly kind: DiagKind
  /** disk: 路径；network: host；service: url；credentials: 环境变量名。 */
  readonly target: string
  readonly port?: number
}

export interface EnvDiagOptions {
  readonly timeoutMs?: number
  readonly minFreeBytes?: number
  readonly env?: NodeJS.ProcessEnv
}

const DEFAULT_TIMEOUT_MS = 3000
const DEFAULT_MIN_FREE_BYTES = 64 * 1024 * 1024 // 64MB

/** 磁盘用量探针（statfs）。 */
export async function diagDisk(path: string, minFreeBytes = DEFAULT_MIN_FREE_BYTES, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<DiagProbe> {
  const at = Date.now()
  try {
    const info = await withTimeout(statfs(path), timeoutMs)
    const free = info.bavail * info.bsize
    return {
      kind: 'disk', target: path,
      ok: free >= minFreeBytes,
      detail: `free ${Math.round(free / (1024 * 1024))}MB (threshold ${Math.round(minFreeBytes / (1024 * 1024))}MB)`,
      at,
    }
  } catch (error) {
    return { kind: 'disk', target: path, ok: false, detail: `statfs failed: ${errorMessage(error)}`, at }
  }
}

/** TCP 可达性探针（带超时；不发送任何数据）。 */
export async function diagNetwork(host: string, port: number, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<DiagProbe> {
  const at = Date.now()
  return new Promise((resolve) => {
    const socket = connect({ host, port })
    const done = (ok: boolean, detail: string): void => {
      socket.destroy()
      resolve({ kind: 'network', target: host, ok, detail, at })
    }
    socket.setTimeout(timeoutMs)
    socket.once('connect', () => done(true, `tcp ${host}:${port} reachable`))
    socket.once('timeout', () => done(false, `tcp ${host}:${port} timed out after ${timeoutMs}ms`))
    socket.once('error', (error) => done(false, `tcp ${host}:${port} unreachable: ${error.message}`))
  })
}

/** HTTP 健康检查探针（带超时；ok = 2xx/3xx）。 */
export async function diagService(url: string, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<DiagProbe> {
  const at = Date.now()
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) })
    return {
      kind: 'service', target: url,
      ok: response.ok,
      detail: `http ${response.status}`,
      at,
    }
  } catch (error) {
    return { kind: 'service', target: url, ok: false, detail: `fetch failed: ${errorMessage(error)}`, at }
  }
}

/** 凭据存在性探针（只报存在/缺失，绝不泄露值）。 */
export function diagCredential(envVar: string, env: NodeJS.ProcessEnv = process.env): DiagProbe {
  const value = env[envVar]
  return {
    kind: 'credentials', target: envVar,
    ok: typeof value === 'string' && value.trim() !== '',
    detail: typeof value === 'string' && value.trim() !== '' ? 'present' : 'missing',
    at: Date.now(),
  }
}

/** 批量运行探针（并行）。 */
export async function runDiag(specs: readonly DiagSpec[], options: EnvDiagOptions = {}): Promise<DiagProbe[]> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  return Promise.all(specs.map((spec) => {
    switch (spec.kind) {
      case 'disk': return diagDisk(spec.target, options.minFreeBytes ?? DEFAULT_MIN_FREE_BYTES, timeoutMs)
      case 'network': return diagNetwork(spec.target, spec.port ?? 80, timeoutMs)
      case 'service': return diagService(spec.target, timeoutMs)
      case 'credentials': return Promise.resolve(diagCredential(spec.target, options.env ?? process.env))
    }
  }))
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms)
    promise.then(
      (value) => { clearTimeout(timer); resolve(value) },
      (error: unknown) => { clearTimeout(timer); reject(error) },
    )
  })
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
