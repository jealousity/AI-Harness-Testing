/**
 * 检查点读写（docs/02 第 9 节 / docs/03 第 8 节）：流水线状态唯一事实。
 * - load：缺失返回 null（首次运行由调用方初始化）。
 * - save：原子写（tmp → rename），先落盘后推进（"先落盘、后宣告成功"）。
 * @module platform-pipeline/checkpoint
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { STAGE_ORDER, type Checkpoint, type StageId, type StageState } from './types.ts'
import {
  StorageCorruptError,
  StorageUnavailableError,
  checkAndStripSchemaVersion,
  withSchemaVersion,
} from './storage/ports.ts'

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

/**
 * 读取检查点；不存在返回 null。
 *
 * 三种结果必须区分开（docs/10 §8.3 M4-A「损坏文件不能静默当空数据」）：
 * - 文件不存在 → `null`（首次运行，正常）；
 * - JSON 非法 / 形状不符 → 抛 {@link StorageCorruptError}。**绝不返回 null**：
 *   检查点是流水线唯一事实，把"读坏了"当成"还没开始"会让 driver 直接重跑整条流水线
 *   并覆盖掉现场（docs/10 §9.2「损坏 checkpoint 会显式失败并保留原件」）；
 * - IO/权限错误 → 抛 {@link StorageUnavailableError}（基础设施故障，不是数据问题）。
 */
export async function loadCheckpoint(root: string): Promise<Checkpoint | null> {
  let raw: string
  try {
    raw = await readFile(join(root, CHECKPOINT_FILE), 'utf8')
  } catch (error) {
    if (isMissingFile(error)) return null
    throw new StorageUnavailableError('file', `read ${CHECKPOINT_FILE}`, errorMessageOf(error), { cause: error })
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    throw new StorageCorruptError(CHECKPOINT_FILE, 'checkpoint', `不是合法 JSON（${errorMessageOf(error)}）`)
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new StorageCorruptError(CHECKPOINT_FILE, 'checkpoint', '顶层不是对象')
  }
  // 先校验并剥掉存储信封：版本更高的检查点必须显式失败，不能按当前形状硬解。
  const body = checkAndStripSchemaVersion(CHECKPOINT_FILE, 'checkpoint', parsed as Record<string, unknown>)
  if (body.pipelineId === undefined || body.cursor === undefined) {
    throw new StorageCorruptError(CHECKPOINT_FILE, 'checkpoint', '缺少 pipelineId 或 cursor')
  }
  return body as unknown as Checkpoint
}

/** 原子写检查点：先写 tmp，再 rename 覆盖（任何时刻磁盘上要么是旧版要么是新版）。 */
export async function saveCheckpoint(root: string, checkpoint: Checkpoint): Promise<void> {
  await mkdir(root, { recursive: true })
  const target = join(root, CHECKPOINT_FILE)
  const tmp = `${target}.tmp`
  await writeFile(tmp, JSON.stringify(withSchemaVersion(checkpoint as unknown as Record<string, unknown>), null, 2))
  await rename(tmp, target)
}

function errorMessageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && 'code' in error && (error as { code?: string }).code === 'ENOENT'
}
