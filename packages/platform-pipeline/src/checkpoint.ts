/**
 * 检查点读写（docs/02 第 9 节 / docs/03 第 8 节）：流水线状态唯一事实。
 * - load：缺失返回 null（首次运行由调用方初始化）。
 * - save：原子写（tmp → rename），先落盘后推进（"先落盘、后宣告成功"）。
 * @module platform-pipeline/checkpoint
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { STAGE_ORDER, type Checkpoint, type StageId, type StageState } from './types.ts'

export const CHECKPOINT_FILE = 'checkpoint.json'

/**
 * 产物相对路径约定（检查点初始化与宿主工具共用，避免两处拼路径漂移）：
 * `artifacts/<pipelineId>/<stageId>.json`，相对平台项目根（= FsArtifactStore 的 baseDir）。
 */
export function artifactPath(pipelineId: string, stageId: StageId): string {
  return `artifacts/${pipelineId}/${stageId}.json`
}

function initialState(stageId: StageId, pipelineId: string): StageState {
  return {
    status: 'idle',
    artifact: artifactPath(pipelineId, stageId),
    digest: '',
    inputs: {},
    history: [],
    reviewDegraded: false,
    gate: {
      machine: { status: 'passed', attempts: 0, violations: [] },
      human: { state: 'open', records: [] },
    },
    failures: [],
  }
}

/** 新建流水线检查点（cursor=0，全阶段 idle）。 */
export function initialCheckpoint(
  pipelineId: string,
  templateVersion: string,
  rulesetVersion: string,
): Checkpoint {
  const stageStates = Object.fromEntries(
    STAGE_ORDER.map(id => [id, initialState(id, pipelineId)]),
  ) as Checkpoint['stageStates']
  return {
    pipelineId,
    templateVersion,
    rulesetVersion,
    cursor: 0,
    stageStates,
    reentries: [],
  }
}

/** 读取检查点；不存在返回 null。 */
export async function loadCheckpoint(root: string): Promise<Checkpoint | null> {
  try {
    const raw = await readFile(join(root, CHECKPOINT_FILE), 'utf8')
    const parsed = JSON.parse(raw) as Checkpoint
    if (parsed.pipelineId === undefined || parsed.cursor === undefined) {
      throw new Error('checkpoint shape invalid')
    }
    return parsed
  } catch (error) {
    if (isMissingFile(error)) return null
    throw error
  }
}

/** 原子写检查点：先写 tmp，再 rename 覆盖（任何时刻磁盘上要么是旧版要么是新版）。 */
export async function saveCheckpoint(root: string, checkpoint: Checkpoint): Promise<void> {
  await mkdir(root, { recursive: true })
  const target = join(root, CHECKPOINT_FILE)
  const tmp = `${target}.tmp`
  await writeFile(tmp, JSON.stringify(checkpoint, null, 2))
  await rename(tmp, target)
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && 'code' in error && (error as { code?: string }).code === 'ENOENT'
}
