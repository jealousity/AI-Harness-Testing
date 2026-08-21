/**
 * 宿主侧 fs 存储（4b 最小闭环的产物与检查点落地）：
 * - FsArtifactStore：StageArtifact 的 JSON 读写（路径相对 baseDir 解析）；
 * - FsCheckpointPort：检查点读写（委托 checkpoint.ts 原子写）。
 * @module platform-pipeline/stores/fs
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { loadCheckpoint, saveCheckpoint } from '../checkpoint.ts'
import { computeArtifactDigest } from '../gates/machine.ts'
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
      const parsed = JSON.parse(raw) as unknown
      // 磁盘只存 content：一律包装（wrapper 由宿主内存构建，digest/inputs 由 driver 填充）
      return wrapContent(path, parsed)
    } catch (error) {
      if (isMissingFile(error)) return null
      throw error
    }
  }

  /** 只持久化 content（agent 契约）；wrapper 元数据不落盘（防 agent 镜像 wrapper 结构）。 */
  async write(artifact: StageArtifact): Promise<void> {
    const target = this.resolvePath(artifact.path)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, JSON.stringify(stripWrapperKeys(artifact.content), null, 2))
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

/** 包装字段（宿主元数据；LLM 可能误写进 content，宿主归一化时剥离）。 */
const WRAPPER_KEYS = new Set(['inputs', 'digest', 'version', 'pipelineId', 'stageId'])

/** 剥离 content 顶层的包装字段（防止 LLM 把宿主元数据写进产物）。 */
function stripWrapperKeys(content: unknown): unknown {
  if (content !== null && typeof content === 'object' && !Array.isArray(content)) {
    const out = { ...(content as Record<string, unknown>) }
    for (const key of WRAPPER_KEYS) delete out[key]
    return out
  }
  return content
}

/** 裸内容 → 最小 wrapper（pipelineId/stageId 从路径派生；inputs/digest 待 driver 填充）。 */
function wrapContent(path: string, content: unknown): StageArtifact {
  const segments = path.split('/')
  const stageId = (segments.pop() ?? '').replace(/\.json$/, '')
  const pipelineId = segments.pop() ?? 'unknown'
  const base: StageArtifact = {
    pipelineId, stageId: stageId as StageArtifact['stageId'],
    version: 1, inputs: {}, content: stripWrapperKeys(content), digest: '', path,
  }
  return { ...base, digest: computeArtifactDigest(base) }
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && 'code' in error && (error as { code?: string }).code === 'ENOENT'
}
