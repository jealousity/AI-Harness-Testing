/**
 * 无 Harness 的宿主侧 fs 工具（`fs_read` / `fs_write`）。
 *
 * 阶段 prompt 要求 agent「先写产物（固定路径），再结束；写失败 = 阶段失败」，
 * 因此无 Harness 宿主必须提供可用的 fs 工具，而不是只有 ACL 声明。
 *
 * 两条硬约束：
 * - **路径包含性**：一切路径相对工作区根解析，拒绝绝对路径、`..` 越界，并在
 *   解析真实路径（realpath）后二次校验，避免软链接逃逸。
 * - **写范围收窄**：`fs_write` 只允许写显式声明的相对前缀（缺省不允许任何写入），
 *   对应 docs/06「阶段只写自己的产物路径」。
 *
 * @module platform-pipeline/runtime/fs-tools
 */

import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, resolve, sep } from 'node:path'

import type { ToolDefinition } from './ports.ts'

export class FsToolPathError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'FsToolPathError'
  }
}

export interface FsReadToolOptions {
  /** 工作区根（绝对路径）。 */
  readonly root: string
}

export interface FsWriteToolOptions {
  /** 工作区根（绝对路径）。 */
  readonly root: string
  /**
   * 允许写入的相对路径前缀；空数组 = 不允许任何写入。
   * 例：`['artifacts/<pipelineId>']`。
   */
  readonly writablePrefixes?: readonly string[]
}

/** 只读工具：读工作区内任意文件（内容按 utf8 返回）。 */
export function fsReadTool(options: FsReadToolOptions): ToolDefinition<{ path?: unknown }, string> {
  const scope = new WorkspaceScope(options.root)
  return {
    name: 'fs_read',
    description: '读取工作区内的文件内容。path 为相对工作区根的路径。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['path'],
      properties: { path: { type: 'string', description: '相对工作区根的文件路径' } },
    },
    async execute(args, context) {
      assertNotAborted(context.signal)
      const target = await scope.existingFile(args?.path)
      return await readFile(target, 'utf8')
    },
  }
}

/** 受限写工具：只能写 writablePrefixes 覆盖的路径。 */
export function fsWriteTool(options: FsWriteToolOptions): ToolDefinition<{ path?: unknown; content?: unknown }, { ok: true; path: string; bytes: number }> {
  const scope = new WorkspaceScope(options.root)
  // 归一化前缀：去掉前导 './' 与尾部 '/'；空串会退化成「整个工作区可写」，直接丢弃。
  const prefixes = (options.writablePrefixes ?? [])
    .map(prefix => prefix.replace(/^\.?\//, '').replace(/\/+$/, ''))
    .filter(prefix => prefix !== '')
  return {
    name: 'fs_write',
    description: '把内容写入工作区内允许的路径（覆盖写）。path 为相对工作区根的路径。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['path', 'content'],
      properties: {
        path: { type: 'string', description: '相对工作区根的文件路径' },
        content: { type: 'string', description: '要写入的完整文件内容' },
      },
    },
    async execute(args, context) {
      assertNotAborted(context.signal)
      if (typeof args?.content !== 'string') throw new FsToolPathError('content must be a string')
      const target = await scope.writableFile(args?.path, prefixes)
      await writeFile(target, args.content, 'utf8')
      return { ok: true, path: relativeLabel(scope.rootPath(), target), bytes: Buffer.byteLength(args.content, 'utf8') }
    },
  }
}

/**
 * 工作区路径作用域：解析 root 的真实路径（消解 /tmp → /private/tmp 一类软链接），
 * 之后所有候选路径都在真实根下解析并做包含性校验。
 */
class WorkspaceScope {
  private readonly rawRoot: string
  private cached: string | undefined

  constructor(root: string) {
    this.rawRoot = resolve(root)
  }

  rootPath(): string {
    return this.cached ?? this.rawRoot
  }

  private async realRoot(): Promise<string> {
    if (this.cached !== undefined) return this.cached
    await mkdir(this.rawRoot, { recursive: true })
    this.cached = await realpath(this.rawRoot)
    return this.cached
  }

  /** 解析一个必须已存在的文件路径。 */
  async existingFile(path: unknown): Promise<string> {
    const root = await this.realRoot()
    const candidate = this.resolveInside(root, path)
    const real = await this.realpathOrThrow(candidate)
    this.assertInside(root, real, path)
    return real
  }

  /** 解析一个允许写入的路径（父目录不存在时创建，并做软链接二次校验）。 */
  async writableFile(path: unknown, prefixes: readonly string[]): Promise<string> {
    const root = await this.realRoot()
    const candidate = this.resolveInside(root, path)
    if (prefixes.length === 0) throw new FsToolPathError('fs_write is not enabled for this workspace')
    const allowed = prefixes.some(prefix => isInside(resolve(root, prefix), candidate))
    if (!allowed) throw new FsToolPathError(`path is outside the writable scope: ${relativeLabel(root, candidate)}`)
    await mkdir(dirname(candidate), { recursive: true })
    // 父目录建好后再校验一次真实路径：拦掉「白名单目录本身是软链接」的情况。
    this.assertInside(root, await this.realpathOrThrow(dirname(candidate)), path)
    return candidate
  }

  private resolveInside(root: string, path: unknown): string {
    if (typeof path !== 'string' || path.trim() === '') throw new FsToolPathError('path must be a non-empty string')
    if (isAbsolute(path)) throw new FsToolPathError('path must be relative to the workspace root')
    const candidate = resolve(root, path)
    this.assertInside(root, candidate, path)
    return candidate
  }

  private assertInside(root: string, candidate: string, path: unknown): void {
    if (!isInside(root, candidate)) throw new FsToolPathError(`path escapes the workspace root: ${String(path)}`)
  }

  private async realpathOrThrow(target: string): Promise<string> {
    try {
      return await realpath(target)
    } catch (error) {
      if (error instanceof Error && 'code' in error && (error as { code?: string }).code === 'ENOENT') {
        throw new FsToolPathError(`path does not exist: ${target}`)
      }
      throw error
    }
  }
}

function isInside(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${sep}`)
}

function relativeLabel(root: string, target: string): string {
  return target.startsWith(`${root}${sep}`) ? target.slice(root.length + 1) : target
}

function assertNotAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new FsToolPathError('tool call was aborted')
}
