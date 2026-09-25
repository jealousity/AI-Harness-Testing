/**
 * 对象存储后端**接口层**（docs/10 §8.3 M4-B、§10 P1-B 第 3 条）。
 *
 * ## 本文件交付什么、不交付什么
 *
 * **交付**：
 * 1. {@link ObjectStoreClient}——SDK 与本平台之间的**唯一接缝**；
 * 2. {@link OBJECT_KEY_ROOTS} 与四个 key 构造函数——**对象键约定**。键是这套后端的
 *    全部结构，键拼错了就再也找不回来，所以它必须是代码而不是文档里的一段散文；
 * 3. {@link assertSafeObjectKey} / {@link assertKeyInProject}——键的**安全校验**。
 *    对象存储没有"目录"，`..` 不会被内核拦住，只能自己拦；
 * 4. {@link classifyObjectStoreError}——驱动错误 → 本平台错误分类。
 *
 * **不交付**：可运行的实现。不 import 任何对象存储 SDK（`@aws-sdk/client-s3` /
 * `@google-cloud/storage` / `minio` / …），不做任何真实连接。未配置时
 * {@link requireObjectStoreClient} 明确抛 `StorageUnavailableError`，
 * **绝不静默降级到文件后端**。
 *
 * ## 为什么这个后端**不能**单独用
 *
 * 对象存储没有条件写（compare-and-swap）。检查点、任务租约、人工门裁决、互斥锁
 * 全都建立在"读改写原子"之上，因此它们**必须**放在有事务的地方（PostgreSQL）。
 * 这里只承担大对象：产物、证据、知识 Markdown、用例 JSON。
 * 两者用 `composeStorageBackends` 组合成一个完整后端——见 ADR-0002。
 *
 * @module platform-pipeline/storage/object-store
 */

import {
  StorageCorruptError,
  StorageUnavailableError,
  isStorageDataError,
  isStorageInfrastructureError,
  type StorageBackendDescription,
} from '../ports.ts'

/** 一次 `head` / `list` 的元信息。只取各家都会给的最小子集。 */
export interface ObjectStat {
  readonly key: string
  readonly size: number
  readonly etag?: string
  readonly updatedAt?: number
}

/**
 * SDK 无关的最小客户端面。
 *
 * 契约（实现者必须保证）：
 * - `get` / `head` 遇到**不存在**必须返回 `null`，**不是**抛 404 异常。
 *   把"没有"表达成异常，会让每一次"这个产物还没写"都被当成故障；
 * - `put` 覆盖同 key 是允许的（产物按固定路径重写是正常行为）；
 * - `list` 只返回给定前缀下的对象，按 key 升序，便于分页与对比。
 */
export interface ObjectStoreClient {
  get(key: string): Promise<Uint8Array | null>
  put(key: string, body: Uint8Array, options?: { readonly contentType?: string; readonly metadata?: Readonly<Record<string, string>> }): Promise<void>
  head(key: string): Promise<ObjectStat | null>
  list(prefix: string): Promise<readonly ObjectStat[]>
  delete(key: string): Promise<void>
}

export interface ObjectStorageOptions {
  /** 已建好的客户端（宿主用自己选的驱动建）。本阶段**唯一**能让它跑起来的方式。 */
  readonly client?: ObjectStoreClient
  /** bucket / 容器名。本阶段不消费它，只作为部署配置与 ADR 的落点。 */
  readonly bucket?: string
  /** 端点（自建 MinIO / 兼容 S3 的网关）。同上，不消费。 */
  readonly endpoint?: string
  /** bucket 内的命名空间前缀（多环境共用一个 bucket 时用）。 */
  readonly keyPrefix?: string
}

/** 对象键的四个根前缀。 */
export const OBJECT_KEY_ROOTS = {
  artifact: 'artifacts',
  evidence: 'evidence',
  knowledge: 'knowledge',
  case: 'cases',
} as const

export type ObjectKeyRoot = (typeof OBJECT_KEY_ROOTS)[keyof typeof OBJECT_KEY_ROOTS]

const KNOWN_ROOTS: readonly string[] = Object.values(OBJECT_KEY_ROOTS)

/** 产物键：`artifacts/<projectId>/<pipelineId>/<stageId>.json`。 */
export function artifactObjectKey(input: { readonly projectId: string; readonly pipelineId: string; readonly stageId: string }): string {
  return [OBJECT_KEY_ROOTS.artifact, input.projectId, input.pipelineId, `${input.stageId}.json`].map(assertSafeSegment).join('/')
}

/**
 * 证据键：`evidence/<projectId>/<pipelineId>/<stageId>/<name>`。
 *
 * 证据放在阶段目录下（而不是平铺）是为了"删掉某个阶段的证据"能一次列全，
 * 也因为同一个阶段可能有多份证据（截图、日志、响应体）。
 */
export function evidenceObjectKey(input: { readonly projectId: string; readonly pipelineId: string; readonly stageId: string; readonly name: string }): string {
  return [
    OBJECT_KEY_ROOTS.evidence, input.projectId, input.pipelineId, input.stageId, input.name,
  ].map(assertSafeSegment).join('/')
}

/**
 * 知识条目键：`knowledge/<projectId>/<entryId>.md`。
 *
 * 后缀是 `.md` 而不是 `.json`：知识条目**对人可读**是它的价值之一，
 * 序列化沿用 `MarkdownKnowledgeStore` 的 `<!-- pp-meta --> + 正文` 格式，
 * 因此"从文件后端搬到对象存储"就是一次对象复制，不需要转换脚本。
 */
export function knowledgeObjectKey(input: { readonly projectId: string; readonly entryId: string }): string {
  return [OBJECT_KEY_ROOTS.knowledge, input.projectId, `${input.entryId}.md`].map(assertSafeSegment).join('/')
}

/** 用例键：`cases/<projectId>/<caseId>.json`（内含全部历史版本）。 */
export function caseObjectKey(input: { readonly projectId: string; readonly caseId: string }): string {
  return [OBJECT_KEY_ROOTS.case, input.projectId, `${input.caseId}.json`].map(assertSafeSegment).join('/')
}

/** 键的总长度上限。S3 是 1024 字节；这里按字符算，留足余量。 */
export const OBJECT_KEY_MAX_LENGTH = 1024

/**
 * 校验对象键。
 *
 * 为什么必须有：对象存储没有目录树，`../` **不会**被内核拦住——它就是键里的三个字符，
 * 但一个把键当路径拼接的适配器（本地缓存、网关、备份脚本）会因此写到命名空间外面。
 * 另外限制"必须落在已知根前缀下"，这样"阶段只能写自己的产物前缀"（§9.1）才是可校验的。
 */
export function assertSafeObjectKey(key: string): string {
  if (key === '') throw new StorageUnavailableError('object-store', 'object-key', '键不得为空')
  if (key.length > OBJECT_KEY_MAX_LENGTH) {
    throw new StorageUnavailableError('object-store', 'object-key', `键过长（${key.length} > ${OBJECT_KEY_MAX_LENGTH}）：${key.slice(0, 64)}…`)
  }
  if (key.includes('\\')) {
    throw new StorageUnavailableError('object-store', 'object-key', `键不得含反斜杠（会被当路径分隔符解释）：${key}`)
  }
  // 控制字符会打断 HTTP 头与日志；它们不可能是合法键的一部分。
  if (/[\u0000-\u001f\u007f]/.test(key)) {
    throw new StorageUnavailableError('object-store', 'object-key', '键不得含控制字符')
  }
  const segments = key.split('/')
  for (const segment of segments) {
    if (segment === '') throw new StorageUnavailableError('object-store', 'object-key', `键含空段（前导/尾随/连续斜杠）：${key}`)
    if (segment === '.' || segment === '..') throw new StorageUnavailableError('object-store', 'object-key', `键含相对段 ${segment}：${key}`)
  }
  if (!KNOWN_ROOTS.includes(segments[0]!)) {
    throw new StorageUnavailableError(
      'object-store', 'object-key',
      `键必须落在已知根前缀下（${KNOWN_ROOTS.join(' / ')}），实际 ${segments[0]}`,
    )
  }
  return key
}

/**
 * 校验键属于指定项目。
 *
 * 项目作用域（§9.1）在对象存储里的**唯一**表达方式就是这个：键的第二段必须是 projectId。
 * 少了这一步，一个被篡改的 caseId 就能读到别的项目的用例——而对象存储不会替你报错。
 */
export function assertKeyInProject(key: string, projectId: string): string {
  assertSafeObjectKey(key)
  const actual = key.split('/')[1]
  if (actual !== projectId) {
    throw new StorageUnavailableError(
      'object-store', 'project-scope',
      `键 ${key} 属于项目 ${actual}，与当前项目 ${projectId} 不符`,
    )
  }
  return key
}

/**
 * 驱动错误 → 本平台错误分类。
 *
 * 与 `classifyPostgresError` 同一原则：**默认方向是基础设施故障**。
 * 未知错误当成"数据坏了/没有数据"会让驱动去重跑、去覆盖，而真正的原因可能是网络抖动。
 */
export function classifyObjectStoreError(error: unknown, operation: string, key?: string): StorageUnavailableError | StorageCorruptError {
  if (isStorageInfrastructureError(error) || isStorageDataError(error)) {
    return error as StorageUnavailableError | StorageCorruptError
  }
  const code = codeOf(error)
  const status = statusOf(error)
  if (code !== null && OBJECT_STORE_CORRUPT_CODES.has(code)) {
    return new StorageCorruptError(key ?? operation, 'artifact', `对象内容校验失败（${code}）：${describeError(error)}`)
  }
  if (status === 404 || (code !== null && OBJECT_STORE_MISSING_CODES.has(code))) {
    // 不是"故障"也不是"损坏"，而是**适配器违反了契约**：`get`/`head` 必须把"不存在"
    // 表达成 null。把它报成故障是刻意的——否则"产物还没写"会静默变成"存储挂了"，
    // 或者反过来，适配器作者永远不会发现自己的 404 处理是错的。
    return new StorageUnavailableError(
      'object-store', operation,
      `键不存在（${key ?? '(未给出 key)'}）：客户端必须把 404 表达成 null 而不是抛错——返回 null 是契约，不是异常`,
      { cause: error },
    )
  }
  return new StorageUnavailableError(
    'object-store', operation,
    [status === null ? null : `HTTP ${status}`, code, describeError(error)].filter(part => part !== null).join('：'),
    { cause: error },
  )
}

/** 内容校验失败类：字节收全了但校验不过，是"这份数据不能用了"。 */
const OBJECT_STORE_CORRUPT_CODES = new Set([
  'BadDigest', 'InvalidDigest', 'ChecksumMismatch', 'XAmzContentSHA256Mismatch', 'IncompleteBody', 'EntityTooSmall',
])

/** 各家的"键不存在"错误码（S3 / GCS / Azure 各一套）。 */
const OBJECT_STORE_MISSING_CODES = new Set(['NoSuchKey', 'NoSuchObject', 'NotFound', 'BlobNotFound', 'NoSuchBucket'])

/**
 * 对象存储部分的能力声明。
 *
 * **它不是一个可装配的后端**：`assertBackendPorts` 会因为缺 `checkpoints` 等必需端口
 * 而拒绝它。这是对的——对象存储单独用不出一条流水线，必须与 records 后端组合。
 */
export function describeObjectStoreBackend(): StorageBackendDescription {
  return {
    name: 'object-store',
    implementedPorts: ['artifacts', 'knowledge', 'cases'],
    unavailablePorts: [
      { port: 'checkpoints', reason: '检查点需要读改写原子（乐观并发）：对象存储通常无条件写，两个进程同时写同一个 key 就是后写覆盖先写' },
      { port: 'tasks', reason: '任务租约必须条件更新（抢租约要原子），对象存储给不了条件写' },
      { port: 'gateTasks', reason: '人工门裁决要"校验 claim 持有者 + 写裁决"一步完成，否则两个人能在同一毫秒各自裁决成功' },
      { port: 'usage', reason: '用量是高频追加：对象存储没有 append，只能读改写整个对象，写放大且并发必丢' },
      { port: 'audit', reason: '审计要 append-only 且可查；对象可被覆盖，不可篡改性只能靠 bucket policy，弱于数据库的 REVOKE' },
      { port: 'lock', reason: '互斥锁的本质就是 CAS，对象存储无条件写给不了互斥' },
    ],
    requiresExternalInfrastructure: true,
  }
}

/** 取客户端；未配置时**明确失败**（§8.4：infrastructure failure，不自动降级）。 */
export function requireObjectStoreClient(options: ObjectStorageOptions, operation = 'connect'): ObjectStoreClient {
  if (options.client !== undefined) return options.client
  const hint = options.bucket === undefined && options.endpoint === undefined
    ? '既没有注入 client，也没有配置 bucket / endpoint'
    : '配置了 bucket / endpoint，但本阶段不引入任何对象存储 SDK，无法自行建连'
  throw new StorageUnavailableError(
    'object-store',
    operation,
    `${hint}。对象存储后端当前只交付接口层（见 docs/adr/0002-storage-backends.md）；`
    + '宿主必须用自己选择的驱动建好客户端，再通过 options.client 注入。'
    + '这里**不会**自动降级到文件后端——静默降级会让"数据到底写到了哪里"变成无法回答的问题。',
  )
}

/** 单段（projectId / pipelineId / caseId…）的安全校验：不许含斜杠或相对段。 */
function assertSafeSegment(segment: string): string {
  if (segment === '') throw new StorageUnavailableError('object-store', 'object-key', '键的某一段为空')
  if (segment === '.' || segment === '..') {
    throw new StorageUnavailableError('object-store', 'object-key', `键的某一段是相对段 ${segment}`)
  }
  if (segment.includes('/') || segment.includes('\\')) {
    throw new StorageUnavailableError('object-store', 'object-key', `键的某一段含路径分隔符：${segment}`)
  }
  return segment
}

function codeOf(error: unknown): string | null {
  if (error === null || typeof error !== 'object') return null
  const record = error as Record<string, unknown>
  for (const key of ['code', 'name', 'Code']) {
    const value = record[key]
    if (typeof value === 'string' && value !== '') return value
  }
  return null
}

function statusOf(error: unknown): number | null {
  if (error === null || typeof error !== 'object') return null
  const record = error as Record<string, unknown>
  for (const key of ['status', 'statusCode', 'httpStatusCode', '$metadata']) {
    const value = record[key]
    if (typeof value === 'number' && Number.isFinite(value)) return value
    if (value !== null && typeof value === 'object') {
      const nested = (value as Record<string, unknown>).httpStatusCode
      if (typeof nested === 'number') return nested
    }
  }
  return null
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
