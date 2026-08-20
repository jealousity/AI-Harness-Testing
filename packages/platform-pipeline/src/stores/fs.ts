/**
 * 宿主侧 fs 存储（4b 最小闭环的产物与检查点落地）：
 * - FsArtifactStore：StageArtifact 的 JSON 读写（路径相对 baseDir 解析）；
 * - FsCheckpointPort：检查点读写（委托 checkpoint.ts 原子写）。
 * @module platform-pipeline/stores/fs
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { loadCheckpoint, saveCheckpoint } from '../checkpoint.ts'
import type { ArtifactStore, CheckpointPort } from '../driver.ts'
import type { Checkpoint, StageArtifact } from '../types.ts'

/** StageArtifact 的 fs 存储（写入时建父目录）。 */
export class FsArtifactStore implements ArtifactStore {
  private readonly baseDir: string

  constructor(baseDir: string) {
    this.baseDir = resolve(baseDir)
  }

  async read(path: string): Promise<StageArtifact | null> {
    const target = this.resolvePath(path)
    try {
      const raw = await readFile(target, 'utf8')
      const parsed = JSON.parse(raw) as StageArtifact
      if (parsed.stageId === undefined || parsed.content === undefined) return null
      return parsed
    } catch (error) {
      if (isMissingFile(error)) return null
      throw error
    }
  }

  async write(artifact: StageArtifact): Promise<void> {
    const target = this.resolvePath(artifact.path)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, JSON.stringify(artifact, null, 2))
  }

  private resolvePath(path: string): string {
    // 防路径逃逸：只允许 baseDir 内（docs/06：阶段只写自己的产物路径）
    const resolved = resolve(this.baseDir, path)
    if (!resolved.startsWith(`${this.baseDir}/`) && resolved !== this.baseDir) {
      throw new Error(`path escapes artifact base: ${path}`)
    }
    return resolved
  }
}

/** 检查点 fs 端口（委托 checkpoint.ts 的原子写）。 */
export class FsCheckpointPort implements CheckpointPort {
  async load(root: string): Promise<Checkpoint | null> {
    return loadCheckpoint(root)
  }

  async save(root: string, checkpoint: Checkpoint): Promise<void> {
    return saveCheckpoint(root, checkpoint)
  }
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && 'code' in error && (error as { code?: string }).code === 'ENOENT'
}
