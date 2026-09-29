/**
 * L1 新格式（`PipelineRecord` / `PipelineRevision` / `PipelineRun`）的**读写**。
 *
 * 与 `pipeline-model.ts` 的分工：那个模块只有类型与纯函数、**不碰存储**；
 * 这个模块只做 I/O、**不含业务判断**（该不该写、写哪个版本由 service 决定）。
 *
 * **走可注入的 `HostRecordStore`，不直接碰文件系统**（`docs/11` §二「事实来源统一」）。
 * 这条不是洁癖：L1 新格式若自己拼路径写磁盘，换后端（内存/对象存储/PostgreSQL）之后
 * 新格式仍然落在本地——"换后端只改装配"当场失效，而单机测试**看不见**这件事
 * （`test/storage-backend-wiring.test.ts` 里"注入之后本地不得再出现 pipelines/ 目录"
 * 就是那条判据，实测把它抓出来过一次）。
 *
 * 坐标全部来自 `pipeline-locator.ts`（`docs/19` §3.2）：
 * 本模块只做 `(collection, id)` → 记录 的映射，不推导任何路径。
 *
 * 记录语义照抄既有存储端口的约定（`storage/file/records.ts`、`checkpoint.ts`）：
 * 缺失 → `missing`、**损坏 → `corrupt` 且带明细**（绝不降级成"没有记录"）、
 * 写原子（由 store 保证）、带 `schemaVersion`（版本更高的记录显式失败）。
 *
 * @module platform-pipeline/web/pipeline-l1-store
 */

import {
  isStorageDataError,
  type HostRecordStore,
} from '../storage/ports.ts'
import {
  pipelineRecordKey,
  revisionCollection,
  revisionKey,
  runCollection,
  runKey,
} from './pipeline-locator.ts'
import {
  type PipelineRecord,
  type PipelineRevision,
  type PipelineRun,
} from './pipeline-model.ts'
// 形状判据**复用** `pipeline-legacy.ts` 里的那一份，不在这里再写一套：
// "什么算合法的 PipelineRecord" 只能有一处定义，否则读路径与判别路径会分叉。
import { looksLikePipelineRecord } from './pipeline-legacy.ts'

/** 单条记录的读取结果。**三态**，不是"值或 null"——损坏必须能被区分出来。 */
export type L1ReadResult<T> =
  | { readonly state: 'missing' }
  | { readonly state: 'ok'; readonly value: T }
  | { readonly state: 'corrupt'; readonly detail: string }

/** 扫描里不可读的一项。`ref` 是**相对**坐标（`collection/id`），不含绝对路径。 */
export interface L1CorruptRef {
  readonly ref: string
  readonly detail: string
}

export interface L1Snapshot {
  readonly record: L1ReadResult<PipelineRecord>
  readonly revisions: { readonly ok: readonly PipelineRevision[]; readonly corrupt: readonly L1CorruptRef[] }
  readonly runs: { readonly ok: readonly PipelineRun[]; readonly corrupt: readonly L1CorruptRef[] }
}

/** L1 记录存储：由 service 注入（`createHostRecordStore` 的同一个工厂，根为 dataRoot）。 */
export type L1RecordStore = HostRecordStore

// ── 形状校验（只判**必填字段**，不拒绝多余字段——前向兼容）────────────────────

function errorMessageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function assertRecordShape(value: Record<string, unknown>): PipelineRecord {
  if (!looksLikePipelineRecord(value)) {
    throw new Error('缺少 pipelineId / projectId / configRef / activeRevisionId 或类型不符')
  }
  if (typeof value.createdAt !== 'number') throw new Error('createdAt 必须是数字')
  return value as unknown as PipelineRecord
}

function assertRevisionShape(value: Record<string, unknown>): PipelineRevision {
  if (typeof value.revisionId !== 'string' || value.revisionId === '') throw new Error('revisionId 缺失')
  if (typeof value.pipelineId !== 'string' || value.pipelineId === '') throw new Error('pipelineId 缺失')
  if (typeof value.revisionNumber !== 'number') throw new Error('revisionNumber 缺失')
  if (typeof value.status !== 'string') throw new Error('status 缺失')
  if (typeof value.fingerprint !== 'string' || value.fingerprint === '') throw new Error('fingerprint 缺失')
  if (typeof value.rulesetVersion !== 'string' || value.rulesetVersion === '') throw new Error('rulesetVersion 缺失')
  return value as unknown as PipelineRevision
}

function assertRunShape(value: Record<string, unknown>): PipelineRun {
  if (typeof value.runId !== 'string' || value.runId === '') throw new Error('runId 缺失')
  if (typeof value.pipelineId !== 'string' || value.pipelineId === '') throw new Error('pipelineId 缺失')
  if (typeof value.revisionId !== 'string' || value.revisionId === '') throw new Error('revisionId 缺失')
  if (typeof value.status !== 'string') throw new Error('status 缺失')
  if (typeof value.cursor !== 'number') throw new Error('cursor 缺失')
  if (typeof value.checkpointLocator !== 'string' || value.checkpointLocator === '') {
    throw new Error('checkpointLocator 缺失')
  }
  return value as unknown as PipelineRun
}

// ── 读 ────────────────────────────────────────────────────────────────────────

/**
 * 读一条记录并做形状校验。
 *
 * `read` 在**损坏时抛**（端口约定），这里把"抛"翻译成 `corrupt` 状态：
 * 迁移与体检都**不允许**因为一条坏记录而整体失败（`docs/19` M5）。
 * 但绝不把损坏说成"没有"——那会让坏数据被静默重建。
 */
async function readOne<T>(
  store: L1RecordStore,
  collection: string,
  id: string,
  assertShape: (value: Record<string, unknown>) => T,
): Promise<L1ReadResult<T>> {
  let raw: unknown
  try {
    raw = await store.read(collection, id)
  } catch (error) {
    // 数据错误（损坏 / 版本过高）与基础设施错误（IO、后端不可用）都归成 `corrupt`：
    // 对调用方而言"这个位置读不出可信内容"是同一件事。明细里带上原因，不静默。
    return { state: 'corrupt', detail: `${isStorageDataError(error) ? '记录不可用' : '读取失败'}：${errorMessageOf(error)}` }
  }
  if (raw === null || raw === undefined) return { state: 'missing' }
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return { state: 'corrupt', detail: '顶层不是对象' }
  }
  try {
    return { state: 'ok', value: assertShape(raw as Record<string, unknown>) }
  } catch (error) {
    return { state: 'corrupt', detail: `形状不符：${errorMessageOf(error)}` }
  }
}

export async function readPipelineRecord(
  store: L1RecordStore,
  pipelineId: string,
): Promise<L1ReadResult<PipelineRecord>> {
  const key = pipelineRecordKey(pipelineId)
  return readOne(store, key.collection, key.id, assertRecordShape)
}

export async function readRevision(
  store: L1RecordStore,
  pipelineId: string,
  revisionId: string,
): Promise<L1ReadResult<PipelineRevision>> {
  const key = revisionKey(pipelineId, revisionId)
  return readOne(store, key.collection, key.id, assertRevisionShape)
}

export async function readRun(
  store: L1RecordStore,
  pipelineId: string,
  runId: string,
): Promise<L1ReadResult<PipelineRun>> {
  const key = runKey(pipelineId, runId)
  return readOne(store, key.collection, key.id, assertRunShape)
}

/** 扫一个集合下的全部记录。集合不存在 = 空（不是错误）。 */
async function listCollection<T>(
  store: L1RecordStore,
  collection: string,
  assertShape: (value: Record<string, unknown>) => T,
): Promise<{ readonly ok: readonly T[]; readonly corrupt: readonly L1CorruptRef[] }> {
  let ids: readonly string[]
  try {
    ids = await store.listIds(collection)
  } catch (error) {
    return { ok: [], corrupt: [{ ref: collection, detail: `集合不可读：${errorMessageOf(error)}` }] }
  }
  const ok: T[] = []
  const corrupt: L1CorruptRef[] = []
  for (const id of ids) {
    const read = await readOne(store, collection, id, assertShape)
    if (read.state === 'ok') ok.push(read.value)
    else if (read.state === 'corrupt') corrupt.push({ ref: `${collection}/${id}`, detail: read.detail })
  }
  return { ok, corrupt }
}

export async function listRevisions(
  store: L1RecordStore,
  pipelineId: string,
): Promise<{ readonly ok: readonly PipelineRevision[]; readonly corrupt: readonly L1CorruptRef[] }> {
  const scanned = await listCollection(store, revisionCollection(pipelineId), assertRevisionShape)
  // 按编号排序（不是 id 排序）：`revision-10` 在字符串序里会排在 `revision-2` 前面。
  return { ...scanned, ok: [...scanned.ok].sort((a, b) => a.revisionNumber - b.revisionNumber) }
}

/** run 的编号从 `runId` 里取（`run-<n>`）；取不到就排到最后，不猜。 */
function runOrdinal(runId: string): number {
  const matched = /^run-(\d+)$/.exec(runId)
  return matched === null ? Number.MAX_SAFE_INTEGER : Number(matched[1])
}

export async function listRuns(
  store: L1RecordStore,
  pipelineId: string,
): Promise<{ readonly ok: readonly PipelineRun[]; readonly corrupt: readonly L1CorruptRef[] }> {
  const scanned = await listCollection(store, runCollection(pipelineId), assertRunShape)
  return { ...scanned, ok: [...scanned.ok].sort((a, b) => runOrdinal(a.runId) - runOrdinal(b.runId)) }
}

// ── 写 ────────────────────────────────────────────────────────────────────────

export async function writePipelineRecord(store: L1RecordStore, record: PipelineRecord): Promise<void> {
  const key = pipelineRecordKey(record.pipelineId)
  await store.write(key.collection, key.id, record as unknown as Record<string, unknown>)
}

export async function writeRevision(store: L1RecordStore, revision: PipelineRevision): Promise<void> {
  const key = revisionKey(revision.pipelineId, revision.revisionId)
  await store.write(key.collection, key.id, revision as unknown as Record<string, unknown>)
}

export async function writeRun(store: L1RecordStore, run: PipelineRun): Promise<void> {
  const key = runKey(run.pipelineId, run.runId)
  await store.write(key.collection, key.id, run as unknown as Record<string, unknown>)
}

/**
 * 一次读齐新格式的全部事实（`diagnose` 与迁移都用它）。
 *
 * 一次读齐而不是分三次调用：三者必须来自**同一个时刻**的观察，
 * 否则"record 在、revision 缺"可能只是读到两次之间的写入。
 */
export async function readL1Snapshot(store: L1RecordStore, pipelineId: string): Promise<L1Snapshot> {
  return {
    record: await readPipelineRecord(store, pipelineId),
    revisions: await listRevisions(store, pipelineId),
    runs: await listRuns(store, pipelineId),
  }
}
