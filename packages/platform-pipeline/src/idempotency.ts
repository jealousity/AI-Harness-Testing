/**
 * 稳定幂等键与幂等台账（docs/10 §6.3 M2-3、§6.4）。
 *
 * 解决的问题不是"防止并发"（那是 `checkpoint-lock.ts` 的职责），而是
 * **同一个请求被重复投递时不产生第二次副作用**：HTTP 重试、用户双击、
 * 进程在"已执行完、响应未送达"之间被杀，都会让同一个操作跑第二遍。
 * 在流水线里这类重复的代价是实打实的——重复裁决会二次驱动人工门，
 * 重复执行会让 `session.json` 里出现两条同用例记录，随即被 R4-08
 * 判成 `unexecuted record seq N is unreferenced (多余执行)`，整条流水线卡在门禁上。
 *
 * ## 键的构造
 *
 * 键 = `sha256(JSON.stringify([namespace, ...规范化字段]))`，即
 * **只由字段决定、与调用时间/调用顺序/进程无关**的纯函数（§6.3「稳定幂等键」）。
 * `namespace` 参与哈希，因此不同操作类型的字段即使偶然相同也不会撞键。
 *
 * §6.3 列出的六类键里，本模块落地 P0-C 要求的三类：
 *
 * | 操作 | 键字段 | 常量 |
 * |---|---|---|
 * | pipeline create | `tenantId/projectId/pipelineId` | {@link IDEMPOTENCY_NAMESPACES}.pipelineCreate |
 * | human gate decision | `gateTaskId/decisionId` | {@link IDEMPOTENCY_NAMESPACES}.gateDecision |
 * | executor invocation | `pipelineId/caseId/inputDigest` | {@link IDEMPOTENCY_NAMESPACES}.executorInvocation |
 *
 * 其余三类各有归属，不在这里重复造机制：stage artifact 已由 G-04 的
 * `pipelineId/stageId/version/inputDigest` 摘要幂等覆盖（`gates/machine.ts`），
 * knowledge write 与 case archive 由 `stores/markdown.ts` 按 `entryId/caseId + version`
 * 天然幂等（同版本重复写入是同一条目，不产生新版本）。
 *
 * ## 台账语义（同一把键 = 同一个操作）
 *
 * - **无记录** → 执行 `produce()`，把结果落盘；
 * - **有记录且请求指纹一致** → **不执行**，返回首次结果（`replayed: true`）；
 * - **有记录但请求指纹不同** → 抛 {@link IdempotencyConflictError}。
 *
 * 第三条是刻意的：键只由少量标识字段算出（比如 create 的键里没有 `configRef`），
 * 若指纹不一致还静默重放，就变成"拿 A 请求的结果糊弄 B 请求"，正是 docs/10 §5.3
 * 「绝不静默复用」禁止的事。因此指纹（= 请求全部实质字段的规范化 JSON）
 * 一并落盘并逐字比对。
 *
 * ## 落盘与竞争
 *
 * 一条记录 = 一个文件 `<projectRoot>/idempotency/<namespace>/<key>.json`，
 * 用 `wx`（独占创建）写入：**先写者胜**。并发的第二个进程写失败后回读先写者的记录
 * 并重放它，不会产生第二份副作用。文件损坏（读得出来但解析不了）按"无记录"处理并
 * 原子覆盖，避免一条坏文件把某个键永久锁死。
 *
 * 已知窗口：`produce()` 与写记录之间仍有极小的时间差。若恰在此刻被杀，
 * 重试会走到"无记录"分支再执行一次。对 create 而言第二次只是重写内容相同的初始
 * 检查点；对 executor 而言用例的 `inputDigest` 未变，第二次执行会被 R4-08 视为多余记录——
 * 这是本模块能给出的最强保证，进一步的原子性需要把台账与业务写入放进同一事务，
 * 属于存储层演进（§6.2 末条），不在 M2 范围内。
 *
 * @module platform-pipeline/idempotency
 */

import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

/** 幂等键的字段类型。故意只接受字符串与数字：对象/数组的 JSON 序列化不稳定。 */
export type IdempotencyField = string | number

/**
 * 操作命名空间。
 *
 * 只列 P0-C 要求落地的三类（见模块注释的对照表）；新增操作时在这里加一个常量，
 * 而不是让调用方自己写裸字符串——否则同一个操作在两个入口会写出两个命名空间，
 * 幂等静默失效。
 */
export const IDEMPOTENCY_NAMESPACES = {
  pipelineCreate: 'pipeline-create',
  gateDecision: 'gate-decision',
  executorInvocation: 'executor-invocation',
  /**
   * 不是一类操作的键，而是 `executor invocation` 键里 `inputDigest` 的**摘要命名空间**
   * （见 `runtime/platform-tools.ts` 的 `executorInputDigest`）。单独占一个命名空间，
   * 是为了让摘要与键的哈希输入互不相同——否则 `inputDigest` 会与 `key` 撞成同一个值。
   */
  executorCaseInput: 'executor-case-input',
} as const

export type IdempotencyNamespace =
  (typeof IDEMPOTENCY_NAMESPACES)[keyof typeof IDEMPOTENCY_NAMESPACES]

/** 幂等台账目录（项目作用域；三个入口都用它，避免各自拼路径导致台账分裂）。 */
export function idempotencyDir(projectRoot: string): string {
  return join(projectRoot, 'idempotency')
}

/** 规范化字段：数字统一成十进制字面量，`-0` 归一到 `0`，避免同一输入算出两个键。 */
function normalizeField(field: IdempotencyField): string {
  if (typeof field !== 'number') return field
  if (!Number.isFinite(field)) return field > 0 ? 'Infinity' : Number.isNaN(field) ? 'NaN' : '-Infinity'
  return Object.is(field, -0) ? '0' : String(field)
}

/**
 * 请求指纹：`[namespace, ...字段]` 的规范化 JSON。
 *
 * 它同时是键的哈希输入与"同一个键上的请求是否变了"的判据，因此必须**稳定**：
 * 同一组字段在任何进程、任何时刻都得到同一个字符串。
 */
export function idempotencyFingerprint(namespace: string, fields: readonly IdempotencyField[]): string {
  return JSON.stringify([namespace, ...fields.map(normalizeField)])
}

/** 由规范化字段算出的稳定幂等键（sha256 十六进制）。 */
export function idempotencyKey(namespace: string, fields: readonly IdempotencyField[]): string {
  return createHash('sha256').update(idempotencyFingerprint(namespace, fields), 'utf8').digest('hex')
}

/**
 * 同一把键上出现了不同内容的请求。
 *
 * 不继承 `PipelineRunError`：本模块要被 Web 层、CLI 与运行时工具共用，
 * 而运行时工具（`executor_run`）不该依赖 Web 层的错误类型。各调用方按自己的
 * 错误模型映射它——service 层映射成 `conflict`(409)，工具层映射成 `{ error }`。
 */
export class IdempotencyConflictError extends Error {
  readonly namespace: string
  readonly key: string
  /** 首次落盘时的请求指纹。 */
  readonly recordedFingerprint: string
  /** 本次请求的指纹。 */
  readonly requestedFingerprint: string

  constructor(namespace: string, key: string, recordedFingerprint: string, requestedFingerprint: string) {
    super(`幂等键已被不同内容的请求占用（${namespace} / ${key.slice(0, 12)}…）：同一操作标识不能携带不同内容`)
    this.name = 'IdempotencyConflictError'
    this.namespace = namespace
    this.key = key
    this.recordedFingerprint = recordedFingerprint
    this.requestedFingerprint = requestedFingerprint
  }
}

/** 一条幂等记录：首次执行的结果快照。 */
export interface IdempotencyRecord<T = unknown> {
  readonly key: string
  readonly namespace: string
  /** 首次落盘时的请求指纹（重放时用于逐字比对）。 */
  readonly fingerprint: string
  readonly createdAt: number
  /** 首次执行的结果。重放时**原样**返回，不重新推导。 */
  readonly result: T
}

/** 一次幂等调用的结果。 */
export interface IdempotencyOutcome<T = unknown> {
  /** `true` = 命中已有记录，本次**没有执行** `produce()`。 */
  readonly replayed: boolean
  readonly namespace: string
  readonly key: string
  readonly record: IdempotencyRecord<T>
  readonly result: T
}

/** 一次幂等调用的输入。 */
export interface IdempotencyRequest<T> {
  readonly namespace: string
  readonly key: string
  readonly fingerprint: string
  /** 首次执行体。命中记录时**不会**被调用。 */
  readonly produce: () => Promise<T>
}

export interface IdempotencyLedger {
  /** 读取已有记录；文件缺失或损坏返回 `null`（损坏视作无记录，见模块注释）。 */
  lookup<T = unknown>(namespace: string, key: string): Promise<IdempotencyRecord<T> | null>
  /** 幂等执行：命中记录则重放，否则执行并落盘。 */
  run<T>(request: IdempotencyRequest<T>): Promise<IdempotencyOutcome<T>>
}

export interface FileIdempotencyLedgerOptions {
  /** 注入时钟（测试用）。 */
  readonly now?: () => number
}

/**
 * 文件系统实现的幂等台账。
 *
 * `dir` 是**幂等根目录**（`idempotencyDir(projectRoot)`），命名空间是它的子目录。
 */
export function fileIdempotencyLedger(dir: string, options: FileIdempotencyLedgerOptions = {}): IdempotencyLedger {
  const now = options.now ?? (() => Date.now())
  const recordPath = (namespace: string, key: string): string => join(dir, namespace, `${key}.json`)

  async function lookup<T>(namespace: string, key: string): Promise<IdempotencyRecord<T> | null> {
    let raw: string
    try {
      raw = await readFile(recordPath(namespace, key), 'utf8')
    } catch {
      return null
    }
    try {
      const parsed = JSON.parse(raw) as Partial<IdempotencyRecord<T>>
      // 形状不完整的记录（半截写入、被手工改坏）按"无记录"处理：留着它只会让这个键
      // 永久不可用，而重放一条字段缺失的记录会把错误结果当成首次结果返回。
      if (parsed.key !== key || parsed.namespace !== namespace || typeof parsed.fingerprint !== 'string') return null
      return parsed as IdempotencyRecord<T>
    } catch {
      return null
    }
  }

  /** 原子写（tmp → rename）：任何时刻磁盘上要么没有记录，要么是一条完整记录。 */
  async function writeAtomic<T>(record: IdempotencyRecord<T>): Promise<void> {
    const target = recordPath(record.namespace, record.key)
    await mkdir(dirname(target), { recursive: true })
    const tmp = `${target}.tmp-${process.pid}-${now()}`
    await writeFile(tmp, `${JSON.stringify(record, null, 2)}\n`, 'utf8')
    await rename(tmp, target)
  }

  /** 独占创建：已存在（EEXIST）返回 `false`，不覆盖先写者的记录。 */
  async function writeIfAbsent<T>(record: IdempotencyRecord<T>): Promise<boolean> {
    const target = recordPath(record.namespace, record.key)
    await mkdir(dirname(target), { recursive: true })
    try {
      await writeFile(target, `${JSON.stringify(record, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' })
      return true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false
      throw error
    }
  }

  return {
    lookup,
    async run<T>(request: IdempotencyRequest<T>): Promise<IdempotencyOutcome<T>> {
      const existing = await lookup<T>(request.namespace, request.key)
      if (existing !== null) return replay(request, existing)

      const result = await request.produce()
      const record: IdempotencyRecord<T> = {
        key: request.key,
        namespace: request.namespace,
        fingerprint: request.fingerprint,
        createdAt: now(),
        result,
      }
      if (await writeIfAbsent(record)) {
        return { replayed: false, namespace: request.namespace, key: request.key, record, result }
      }
      // 竞争失败：另一个进程先写了。以**先写者**的记录为准，本次结果作废——
      // 这正是"先写者胜"要表达的意思（返回首次结果，而不是第二次执行的结果）。
      const winner = await lookup<T>(request.namespace, request.key)
      if (winner !== null) return replay(request, winner)
      // 先写者留下的文件损坏：原子覆盖，避免这个键永久不可用。
      await writeAtomic(record)
      return { replayed: false, namespace: request.namespace, key: request.key, record, result }
    },
  }
}

/** 命中记录时的统一出口：先比对指纹，再重放首次结果。 */
function replay<T>(request: IdempotencyRequest<T>, record: IdempotencyRecord<T>): IdempotencyOutcome<T> {
  if (record.fingerprint !== request.fingerprint) {
    throw new IdempotencyConflictError(request.namespace, request.key, record.fingerprint, request.fingerprint)
  }
  return { replayed: true, namespace: request.namespace, key: request.key, record, result: record.result }
}
