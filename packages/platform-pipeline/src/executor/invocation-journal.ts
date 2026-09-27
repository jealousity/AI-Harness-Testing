/**
 * 执行调用日志：**每条用例一次调用的可恢复状态机**（docs/11 P1-07 / P1-08）。
 *
 * ## 它解决什么问题
 *
 * executor 会对被测系统发出**真实、不可撤销**的请求。而"发请求"和"把结果落盘"
 * 是两次独立的写盘，中间崩溃会留下一个无法从磁盘回答的问题：
 * **那个请求到底发出去了没有？**
 *
 * 修复前这件事只能靠幂等台账猜，而台账只在**执行完成之后**才写：
 *
 * ```text
 * 查台账（未命中） → 发请求 → 写会话 → 写台账
 *                    ↑ 崩溃在这里：台账与会话都没有，重启后只能再发一次
 * ```
 *
 * 于是"远端副作用已发生、本地一无所知"的状态被当成"还没执行过"，重试即重复副作用。
 * 台账本身并没有错——它只是**表达不了"请求已发出但结果未知"**这件事。
 *
 * ## 状态机
 *
 * 每条用例一个文件，`phase` 单调推进：
 *
 * ```text
 * intent ──→ sent ──→ received ──→ done
 *   │         │          │
 *   │         └──────────┴──→ unknown（进程在 sent 之后、received 之前被杀）
 *   └─ 尚未发出任何请求：重来是安全的
 * ```
 *
 * | phase | 含义 | 重启后的动作 |
 * |---|---|---|
 * | `intent` | 已声明要执行，**尚未发请求** | 安全重来 |
 * | `sent` | 请求已发出，响应未知 | 只在有远端幂等键时重发；否则**明确阻断** |
 * | `received` | 已拿到响应并把该用例的记录/证据落进本文件 | **不重发**，直接补写会话 |
 * | `done` | 会话与台账都已落盘 | 重放既有结果 |
 * | `unknown` | 显式标记为不可判定 | 明确阻断，等人工确认 |
 *
 * ## 两条硬规则
 *
 * 1. **`sent` 是重发屏障**：写 `sent` 必须在**发出请求之前**完成。否则崩溃窗口里
 *    磁盘上还是 `intent`，重启后就会当成"没发过"再发一次。
 * 2. **文件损坏 → `unknown`，不是"没有记录"**：这一点与幂等台账**刻意相反**。
 *    台账损坏时按"无记录"处理是安全的（重新执行 `create` 只是重写同样的检查点）；
 *    而这里损坏的记录可能是 `sent`，当成"没执行过"就等于盲目重发。
 *    {@link InvocationJournalCorruptError} 因此必须向上抛，由调用方转成明确阻断。
 *
 * ## 远端幂等键
 *
 * 远端支持幂等键时（宿主声明 `executorIdempotencyHeader`），`sent` 之后重发是安全的
 * ——远端会把重复请求折叠成同一个副作用。此时 `remoteIdempotencyKey` 落盘，
 * 恢复时允许重发。**远端不支持时不得声称 exactly-once**：`sent` 只能人工确认
 * （查询远端）或明确阻断。
 *
 * @module platform-pipeline/executor/invocation-journal
 */

import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import type { ExecutionRecord } from './records.ts'
import type { EvidenceEntry } from './verify.ts'

/**
 * 调用阶段。
 *
 * `unknown` 是**显式**的：它既可能来自崩溃恢复时的判定，也可能来自人工确认后的标注。
 * 不把它折叠进 `sent` 是为了让"我们确实不知道"这件事在磁盘上可读。
 */
export type InvocationPhase = 'intent' | 'sent' | 'received' | 'done' | 'unknown'

/** 已完成的执行片段（该用例的记录 + 证据），`received` 起存在。 */
export interface InvocationFragment {
  readonly records: readonly ExecutionRecord[]
  readonly evidence: readonly EvidenceEntry[]
}

export interface InvocationRecord {
  readonly caseId: string
  /** 幂等键：`pipelineId/caseId/inputDigest`，用于识别"这是不是同一次调用"。 */
  readonly key: string
  /** 请求指纹。与当前请求不一致 = 另一次调用（换了 design 或被测基址）。 */
  readonly fingerprint: string
  readonly phase: InvocationPhase
  /** 第几次尝试执行这条用例（从 1 开始）。 */
  readonly attempt: number
  readonly updatedAt: number
  /** 远端幂等键（宿主声明远端支持幂等键时才带）；有它时 `sent` 之后重发是安全的。 */
  readonly remoteIdempotencyKey?: string
  /** `received` 起存在的执行片段。 */
  readonly fragment?: InvocationFragment
  readonly detail?: string
}

/** 调用日志损坏。**必须阻断**，不能当成"没有记录"（那等于盲目重发）。 */
export class InvocationJournalCorruptError extends Error {
  readonly caseId: string
  readonly ref: string

  constructor(caseId: string, ref: string, detail: string) {
    super(`执行调用日志损坏（${caseId} / ${ref}）：${detail}；无法判定上一次请求是否已发出，拒绝盲目重发`)
    this.name = 'InvocationJournalCorruptError'
    this.caseId = caseId
    this.ref = ref
  }
}

export interface InvocationJournal {
  /** 读一条记录；文件不存在返回 `null`，**损坏抛 {@link InvocationJournalCorruptError}**。 */
  read(caseId: string): Promise<InvocationRecord | null>
  /** 原子覆盖写一条记录（tmp → rename）。 */
  write(record: InvocationRecord): Promise<void>
  /** 删除一条记录（人工确认远端未执行后清理现场）。 */
  remove(caseId: string): Promise<void>
  /** 记录文件路径（供诊断信息与人工处置说明引用）。 */
  pathOf(caseId: string): string
}

/** 文件名安全化：用例 id 可能含 `/` 等字符，直接拼路径会逃出日志目录。 */
function safeCaseFile(caseId: string): string {
  const safe = caseId.replace(/[^A-Za-z0-9._-]/g, '_')
  if (safe === '' || safe === '.' || safe === '..') throw new Error(`caseId 不能用作日志文件名：${JSON.stringify(caseId)}`)
  return `${safe}.json`
}

function isPhase(value: unknown): value is InvocationPhase {
  return value === 'intent' || value === 'sent' || value === 'received' || value === 'done' || value === 'unknown'
}

/**
 * 文件系统实现的调用日志。
 *
 * `dir` 是**该流水线**的调用日志目录（`executorInvocationDir(projectRoot, pipelineId)`）。
 */
export function fileInvocationJournal(dir: string): InvocationJournal {
  const pathOf = (caseId: string): string => join(dir, safeCaseFile(caseId))

  return {
    pathOf,

    async read(caseId) {
      const ref = pathOf(caseId)
      let raw: string
      try {
        raw = await readFile(ref, 'utf8')
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
        throw error
      }
      let parsed: unknown
      try {
        parsed = JSON.parse(raw) as unknown
      } catch (error) {
        throw new InvocationJournalCorruptError(caseId, ref, `不是合法 JSON（${error instanceof Error ? error.message : String(error)}）`)
      }
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new InvocationJournalCorruptError(caseId, ref, '顶层不是对象')
      }
      const record = parsed as Partial<InvocationRecord>
      if (record.caseId !== caseId || !isPhase(record.phase)
        || typeof record.key !== 'string' || typeof record.fingerprint !== 'string') {
        throw new InvocationJournalCorruptError(caseId, ref, '字段缺失或类型不符')
      }
      return record as InvocationRecord
    },

    async write(record) {
      const target = pathOf(record.caseId)
      await mkdir(dirname(target), { recursive: true })
      const tmp = `${target}.tmp-${process.pid}`
      await writeFile(tmp, `${JSON.stringify(record, null, 2)}\n`, 'utf8')
      await rename(tmp, target)
    },

    async remove(caseId) {
      await rm(pathOf(caseId), { force: true })
    },
  }
}

/** 该调用是否**允许在恢复时重发**：只有远端幂等键能让 `sent` 变得可重试。 */
export function isRetryableAfterSent(record: InvocationRecord): boolean {
  return record.phase === 'sent' && record.remoteIdempotencyKey !== undefined
}
