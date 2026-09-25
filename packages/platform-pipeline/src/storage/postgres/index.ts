/**
 * PostgreSQL 后端**接口层**（docs/10 §8.3 M4-B、§8.4、§10 P1-B 第 3 条）。
 *
 * ## 本文件交付什么、不交付什么
 *
 * **交付**（§10 明确允许"至少交付接口和 ADR"）：
 * 1. {@link PostgresClient}——SDK 与本平台之间的**唯一接缝**。`PipelineDriver` 永远
 *    看不到它，只有宿主装配才注入；
 * 2. {@link postgresSchemaDdl}——表结构（含主键、外键、索引）。DDL 是**规格**不是实现，
 *    但它决定了乐观并发与事务边界能不能成立，所以必须现在就定下来；
 * 3. {@link POSTGRES_PORT_TABLES}——端口 ↔ 表映射（§8.3 要求"表映射说明"）；
 * 4. {@link POSTGRES_TRANSACTION_BOUNDARIES}——事务边界（§8.4 要求"checkpoint 与
 *    gate task 的事务边界清晰"）；
 * 5. {@link classifyPostgresError}——驱动错误 → 本平台错误分类。
 *
 * **不交付**：可运行的 SQL 实现。
 * - 不 import 任何数据库 SDK（`pg` / `postgres` / `kysely` / …），因此本包的依赖表里
 *   不会多出一个只有 PostgreSQL 部署才需要的驱动；
 * - 不做任何真实连接。未配置时 {@link requirePostgresClient} **明确抛
 *   `StorageUnavailableError`**（infrastructure failure），**绝不静默降级到文件后端**
 *   ——静默降级会让"数据到底写到哪了"变成无法回答的问题。
 *
 * 选型、端口↔后端映射、事务边界、迁移与回滚策略见 `docs/adr/0002-storage-backends.md`。
 *
 * @module platform-pipeline/storage/postgres
 */

import {
  StorageCorruptError,
  StorageUnavailableError,
  isStorageDataError,
  isStorageInfrastructureError,
  type StorageBackendDescription,
  type StorageRecordKind,
} from '../ports.ts'

/** 默认 schema（PG 的 namespace）。 */
export const POSTGRES_DEFAULT_SCHEMA = 'public'

/** 一次查询的结果：只取各家驱动都会给的最小子集。 */
export interface PostgresQueryResult<Row = Record<string, unknown>> {
  readonly rows: readonly Row[]
  readonly rowCount: number
}

/**
 * SDK 无关的最小客户端面。
 *
 * 为什么不直接用某个库的类型：`pg` 的 `Pool`、`postgres` 的 `Sql`、`kysely` 的
 * `Kysely` 形状各不相同。端口一旦长在某个库的类型上，换库就等于改端口——
 * 那正是 §8.2 禁止的"核心依赖某个数据库 SDK 的具体类型"。
 */
export interface PostgresClient {
  query<Row = Record<string, unknown>>(sql: string, params?: readonly unknown[]): Promise<PostgresQueryResult<Row>>
  /**
   * 在一个事务里跑 `work`，**同一连接**内执行。
   *
   * 实现者必须保证：
   * - `work` 内的所有 `query` 走同一个连接，中途不得归还连接池；
   * - `work` 抛错 → 回滚，并把**原错误原样**抛出去（不要包成驱动错误，
   *   否则 `StorageUnavailableError` 会在这一层被吃掉）；
   * - 提交失败 → 抛 `StorageUnavailableError`：提交结果未知，**不能**宣称成功。
   */
  transaction<T>(work: (tx: PostgresClient) => Promise<T>): Promise<T>
  /** 关闭连接池。可选：宿主自己管生命周期时不必实现。 */
  close?(): Promise<void>
}

export interface PostgresStorageOptions {
  /**
   * 已建好的客户端（宿主用自己选的驱动建）。
   *
   * 这是本阶段**唯一**能让 PostgreSQL 后端跑起来的方式。
   */
  readonly client?: PostgresClient
  /**
   * 连接串。
   *
   * 本阶段**不消费它**——没有 SDK 就建不出客户端。保留这个字段是为了让部署配置样例
   * 与 ADR 里的说明有落点，但 {@link requirePostgresClient} 会明确告诉你"还需要注入
   * `client`"，而不是拿它去偷偷建连。
   */
  readonly connectionString?: string
  /** schema 名。缺省 {@link POSTGRES_DEFAULT_SCHEMA}。 */
  readonly schema?: string
  /** 连接池上限。只用于生成 DDL 注释与部署说明，不在此处建池。 */
  readonly poolSize?: number
}

/** 表名。集中在这里，避免各处拼字符串拼出两套命名。 */
export const POSTGRES_TABLES = {
  schemaMeta: 'pipeline_schema_meta',
  checkpoint: 'pipeline_checkpoint',
  checkpointStage: 'pipeline_checkpoint_stage',
  task: 'pipeline_task',
  gateTask: 'pipeline_gate_task',
  usageEvent: 'pipeline_usage_event',
  auditEvent: 'pipeline_audit_event',
  lock: 'pipeline_lock',
} as const

/**
 * 端口 ↔ 表映射（§8.3 要求"表映射说明"）。
 *
 * 由它可以直接读出两条硬边界：
 * - `artifacts` **没有**表——产物是大对象，归 object-store；
 * - 需要 CAS / 事务的端口（checkpoints、gateTasks、tasks、lock）**都有**表——
 *   对象存储给不了条件写，所以这些端口不能放那边。
 */
export const POSTGRES_PORT_TABLES: Readonly<Record<string, readonly string[]>> = {
  checkpoints: [POSTGRES_TABLES.checkpoint, POSTGRES_TABLES.checkpointStage],
  tasks: [POSTGRES_TABLES.task],
  gateTasks: [POSTGRES_TABLES.gateTask],
  usage: [POSTGRES_TABLES.usageEvent],
  audit: [POSTGRES_TABLES.auditEvent],
  lock: [POSTGRES_TABLES.lock],
} as const

export interface PostgresTransactionBoundary {
  readonly id: string
  readonly ports: readonly string[]
  readonly tables: readonly string[]
  /** 隔离级别；`n/a` 表示刻意不做事务（跨存储）。 */
  readonly isolation: string
  readonly why: string
}

/**
 * 事务边界（§8.4「checkpoint 与 gate task 的事务边界清晰」）。
 *
 * 每条都写清了"为什么"，因为"要不要放进一个事务"是**正确性**问题不是风格问题：
 * 放进去 = 两个事实要么都成立要么都不成立；放外面 = 中间崩溃会留下一个半成品状态，
 * 那必须是一个**能自愈**的状态（见 `artifact-then-checkpoint`）。
 */
export const POSTGRES_TRANSACTION_BOUNDARIES: readonly PostgresTransactionBoundary[] = [
  {
    id: 'checkpoint-save',
    ports: ['checkpoints'],
    tables: [POSTGRES_TABLES.checkpoint, POSTGRES_TABLES.checkpointStage],
    isolation: 'read committed',
    why: '检查点正文与阶段投影必须同事务：投影落后于 payload 时，Web 列出的"卡在 execute 的流水线"就是骗人的。'
      + '乐观并发（`revision`）也必须在同一条 UPDATE 里完成，'
      + '写成"先 SELECT revision 再 UPDATE"会允许两个进程各自基于同一旧版本写入，后写的静默覆盖先写的。',
  },
  {
    id: 'gate-decide',
    ports: ['gateTasks'],
    tables: [POSTGRES_TABLES.gateTask],
    isolation: 'read committed',
    why: '裁决必须由当前 claim 持有者做出，且必须是**条件更新**：'
      + '`UPDATE … SET status=$action WHERE gate_task_id=$1 AND status=\'claimed\' AND claimed_by=$actor`，0 行即拒绝。'
      + '把"检查是不是他持有"和"写入裁决"分成两条语句，就允许两个人在同一毫秒各自裁决成功——'
      + '而人工门是责任链，一次裁决只能有一个责任人。',
  },
  {
    id: 'gate-consume',
    ports: ['gateTasks'],
    tables: [POSTGRES_TABLES.gateTask],
    isolation: 'read committed',
    why: '`consumed_at` 是幂等闸门：`UPDATE … SET consumed_at = COALESCE(consumed_at, $at) … RETURNING *`。'
      + '重复消费返回**同一个**时间戳，因此"已裁决未消费的任务会被续用一次"不会变成"被消费两次"。',
  },
  {
    id: 'task-lease',
    ports: ['tasks'],
    tables: [POSTGRES_TABLES.task],
    isolation: 'read committed',
    why: '取租约必须是条件更新（`WHERE lease_expires_at IS NULL OR lease_expires_at <= $now`），'
      + '不是"先查后写"——后者在过期租约恢复时会两个 worker 同时抢到同一个任务。',
  },
  {
    id: 'lock-acquire',
    ports: ['lock'],
    tables: [POSTGRES_TABLES.lock],
    isolation: 'read committed',
    why: 'CAS on `generation`：`UPDATE … SET owner_id=$owner, generation=generation+1 '
      + 'WHERE pipeline_id=$1 AND (expires_at IS NULL OR expires_at <= $now OR owner_id=$owner) RETURNING *`。'
      + '0 行 = 锁被他人持有，必须抛 `PipelineLockHeldError`（与文件后端同一类错误），不得静默并行。',
  },
  {
    id: 'usage-append',
    ports: ['usage'],
    tables: [POSTGRES_TABLES.usageEvent],
    isolation: 'read committed',
    why: '单语句插入即可，用 `ON CONFLICT (project_id, event_id) DO NOTHING` 保证重复追加幂等。'
      + '用量是**计量**：按"可丢"处理——写失败记下错误码继续，不得因为它失败而把阶段判失败。',
  },
  {
    id: 'audit-append',
    ports: ['audit'],
    tables: [POSTGRES_TABLES.auditEvent],
    isolation: 'read committed',
    why: '单语句插入。审计是**责任链**：写失败必须上抛（与用量恰好相反），'
      + '因为"这次是谁批准的"查不到时，整个门禁的意义就没有了。',
  },
  {
    id: 'artifact-then-checkpoint',
    ports: ['artifacts', 'checkpoints'],
    tables: [POSTGRES_TABLES.checkpoint, POSTGRES_TABLES.checkpointStage],
    isolation: 'n/a（跨存储，刻意不做分布式事务）',
    why: '产物在对象存储、检查点在 PostgreSQL，两者无法共用一个事务，所以顺序固定为'
      + '**先写产物、后写检查点**。产物按固定路径写入、可被重跑覆盖；检查点才是"阶段完成"的'
      + '唯一声明。中间崩溃的结果是"有产物、没声称完成"，重试会重跑该阶段并覆盖产物——'
      + '这正是 §8.4 要求的可重试语义。反过来（先写检查点）会得到"声称完成但没有产物"，'
      + '那才是不可恢复的：门禁会拿一个不存在的产物去判，人工门会批准一个空对象。',
  },
]

/**
 * 生成表结构 DDL。
 *
 * 刻意用 `IF NOT EXISTS` 全量幂等：部署脚本可以无条件执行，不需要先探测当前状态。
 * 但**它不做迁移**——把已有表改结构必须走 `migrate()`，见 ADR-0002。
 */
export function postgresSchemaDdl(schema: string = POSTGRES_DEFAULT_SCHEMA): string {
  const s = assertSafeSchemaName(schema)
  return `-- platform-pipeline PostgreSQL schema（docs/adr/0002-storage-backends.md）
-- 幂等：可无条件重复执行。改结构请走 migrate()，不要在这里改历史定义。
CREATE SCHEMA IF NOT EXISTS ${s};

-- 存储 schema 版本（§8.3「记录 schema version 和 ruleset version」）。
-- 单行表：id 恒为 true 且带 CHECK，第二条 INSERT 会被主键挡住。
CREATE TABLE IF NOT EXISTS ${s}.${POSTGRES_TABLES.schemaMeta} (
  id              boolean     PRIMARY KEY DEFAULT true CHECK (id),
  schema_version  integer     NOT NULL,
  ruleset_version text        NOT NULL,
  applied_at      timestamptz NOT NULL DEFAULT now()
);

-- 检查点：整份 JSONB + 乐观并发用的 revision。
CREATE TABLE IF NOT EXISTS ${s}.${POSTGRES_TABLES.checkpoint} (
  project_id       text        NOT NULL,
  pipeline_id      text        NOT NULL,
  revision         bigint      NOT NULL DEFAULT 0,
  schema_version   integer     NOT NULL,
  template_version text        NOT NULL,
  ruleset_version  text        NOT NULL,
  cursor           integer     NOT NULL,
  payload          jsonb       NOT NULL,
  updated_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, pipeline_id)
);

-- 阶段投影（**派生表**：同一事务内随 payload 更新，可从 payload 重建）。
-- 存在的唯一理由是"列出卡在某个阶段的流水线"不该去解析 JSONB。
CREATE TABLE IF NOT EXISTS ${s}.${POSTGRES_TABLES.checkpointStage} (
  project_id      text        NOT NULL,
  pipeline_id     text        NOT NULL,
  stage_id        text        NOT NULL,
  status          text        NOT NULL,
  artifact_path   text,
  artifact_digest text,
  machine_status  text,
  human_state     text,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, pipeline_id, stage_id),
  FOREIGN KEY (project_id, pipeline_id)
    REFERENCES ${s}.${POSTGRES_TABLES.checkpoint} (project_id, pipeline_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS ${POSTGRES_TABLES.checkpointStage}_status_idx
  ON ${s}.${POSTGRES_TABLES.checkpointStage} (project_id, status);

-- 任务与租约。租约过期恢复靠条件更新，因此 (status, lease_expires_at) 要有索引。
CREATE TABLE IF NOT EXISTS ${s}.${POSTGRES_TABLES.task} (
  project_id       text        NOT NULL,
  task_id          text        NOT NULL,
  pipeline_id      text        NOT NULL,
  status           text        NOT NULL,
  attempt          integer     NOT NULL DEFAULT 0,
  lease_owner      text,
  lease_expires_at timestamptz,
  heartbeat_at     timestamptz,
  payload          jsonb       NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, task_id)
);
CREATE INDEX IF NOT EXISTS ${POSTGRES_TABLES.task}_lease_idx
  ON ${s}.${POSTGRES_TABLES.task} (status, lease_expires_at);

-- 人工门任务。
-- artifact_digest 单独成列：门禁批准的是**某个具体产物**，不是"那个路径上的东西"。
-- 少了它，重入（reenter）后新旧产物会共用一份旧裁决。
CREATE TABLE IF NOT EXISTS ${s}.${POSTGRES_TABLES.gateTask} (
  project_id       text        NOT NULL,
  gate_task_id     text        NOT NULL,
  pipeline_id      text        NOT NULL,
  stage_id         text        NOT NULL,
  artifact_path    text,
  artifact_digest  text,
  machine_status   text        NOT NULL,
  status           text        NOT NULL,
  claimed_by       text,
  lease_owner      text,
  lease_expires_at timestamptz,
  decision         jsonb,
  cancellation     jsonb,
  consumed_at      timestamptz,
  expires_at       timestamptz,
  payload          jsonb       NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, gate_task_id)
);
CREATE INDEX IF NOT EXISTS ${POSTGRES_TABLES.gateTask}_pending_idx
  ON ${s}.${POSTGRES_TABLES.gateTask} (project_id, pipeline_id, status);

-- 用量事件（append-only；计量，可丢）。
CREATE TABLE IF NOT EXISTS ${s}.${POSTGRES_TABLES.usageEvent} (
  project_id  text    NOT NULL,
  event_id    text    NOT NULL,
  pipeline_id text    NOT NULL,
  stage_id    text    NOT NULL,
  kind        text    NOT NULL,
  started_at  bigint  NOT NULL,
  finished_at bigint  NOT NULL,
  duration_ms bigint  NOT NULL,
  success     boolean NOT NULL,
  error_code  text,
  payload     jsonb   NOT NULL,
  PRIMARY KEY (project_id, event_id)
);
CREATE INDEX IF NOT EXISTS ${POSTGRES_TABLES.usageEvent}_query_idx
  ON ${s}.${POSTGRES_TABLES.usageEvent} (project_id, pipeline_id, started_at);

-- 审计事件（append-only；责任链，写失败必须上抛）。
CREATE TABLE IF NOT EXISTS ${s}.${POSTGRES_TABLES.auditEvent} (
  project_id  text   NOT NULL,
  event_id    text   NOT NULL,
  at          bigint NOT NULL,
  kind        text   NOT NULL,
  actor       text   NOT NULL,
  pipeline_id text,
  stage_id    text,
  detail      text   NOT NULL,
  metadata    jsonb,
  PRIMARY KEY (project_id, event_id)
);
CREATE INDEX IF NOT EXISTS ${POSTGRES_TABLES.auditEvent}_query_idx
  ON ${s}.${POSTGRES_TABLES.auditEvent} (project_id, at);
CREATE INDEX IF NOT EXISTS ${POSTGRES_TABLES.auditEvent}_pipeline_idx
  ON ${s}.${POSTGRES_TABLES.auditEvent} (project_id, pipeline_id, at);

-- 流水线互斥锁（CAS on generation）。
CREATE TABLE IF NOT EXISTS ${s}.${POSTGRES_TABLES.lock} (
  project_id   text    NOT NULL,
  pipeline_id  text    NOT NULL,
  owner_id     text    NOT NULL,
  generation   bigint  NOT NULL,
  pid          integer NOT NULL,
  host         text    NOT NULL,
  acquired_at  bigint  NOT NULL,
  heartbeat_at bigint  NOT NULL,
  expires_at   bigint,
  PRIMARY KEY (project_id, pipeline_id)
);

-- 审计表的 append-only 必须由**权限**保证，不能靠自觉：
--   REVOKE UPDATE, DELETE ON ${s}.${POSTGRES_TABLES.auditEvent} FROM <app_role>;
--   GRANT INSERT, SELECT ON ${s}.${POSTGRES_TABLES.auditEvent} TO <app_role>;
-- 只读视图可以用一个不带 INSERT 的角色连库来强制。见 ADR-0002「审计的不可篡改」。
`
}

/**
 * 驱动错误 → 本平台错误分类。
 *
 * **默认方向是"基础设施故障"**：未知错误一律 `StorageUnavailableError`。
 * 反过来的默认（未知错误当成"数据坏了 / 没有数据"）会让驱动去重跑、去覆盖，
 * 而真正的原因可能只是网络抖了一下——重跑一百次也写不进去，还可能把好数据覆盖掉。
 *
 * 分类依据是**稳定的**两类信号，不猜某个 SDK 的错误类名：
 * - PostgreSQL 的 SQLSTATE 前两位（`error.code`，`pg` / `postgres` / `kysely` 都给）；
 * - Node 的 errno 字符串（`ECONNREFUSED` 等）。
 */
export function classifyPostgresError(
  error: unknown,
  operation: string,
  kind: StorageRecordKind,
  ref?: string,
): StorageUnavailableError | StorageCorruptError {
  if (isStorageInfrastructureError(error) || isStorageDataError(error)) {
    return error as StorageUnavailableError | StorageCorruptError
  }
  const code = codeOf(error)
  if (code !== null && SQLSTATE_CORRUPT_CLASSES.has(code.slice(0, 2))) {
    // `22*`（data exception）是唯一敢判成"这份数据坏了"的一类：它说的是
    // "库里存的这串字节解释不出来"，而不是"连不上/写不进"。
    return new StorageCorruptError(ref ?? operation, kind, `数据异常（SQLSTATE ${code}）：${describeError(error)}`)
  }
  return new StorageUnavailableError(
    'postgres', operation,
    code === null ? describeError(error) : `SQLSTATE ${code}：${describeError(error)}`,
    { cause: error },
  )
}

/** 数据异常类：`22*`（invalid text representation、numeric overflow…）。 */
const SQLSTATE_CORRUPT_CLASSES = new Set(['22'])

/**
 * PostgreSQL 后端的能力声明。
 *
 * 这是"后端**将会**具备什么"的规格，**不是**一个可装配的后端：本阶段没有 SQL 实现，
 * 装配它只会得到明确的基础设施故障。它存在的用途是宿主装配前的自检与 ADR 里的映射表。
 */
export function describePostgresBackend(): StorageBackendDescription {
  return {
    name: 'postgres',
    implementedPorts: ['checkpoints', 'tasks', 'gateTasks', 'usage', 'audit', 'lock'],
    unavailablePorts: [
      { port: 'artifacts', reason: '产物/证据是大对象（MB 级 blob），由 object-store 后端承载（docs/10 §8.3）' },
      { port: 'knowledge', reason: '知识条目以 Markdown 形式对外可读，与产物同处对象存储便于按项目导出' },
      { port: 'cases', reason: '用例 JSON 与知识条目同处对象存储，便于按项目导出/备份' },
    ],
    requiresExternalInfrastructure: true,
  }
}

/**
 * 取客户端；未配置时**明确失败**。
 *
 * 这是本模块的运行时行为，也是 §8.4「外部存储不可用时状态明确为 infrastructure failure」
 * 的落点：不返回 null、不返回一个空实现、**不降级到文件后端**。
 */
export function requirePostgresClient(options: PostgresStorageOptions, operation = 'connect'): PostgresClient {
  if (options.client !== undefined) return options.client
  const hint = options.connectionString === undefined
    ? '既没有注入 client，也没有配置 connectionString'
    : '配置了 connectionString，但本阶段不引入任何数据库 SDK，无法自行建连'
  throw new StorageUnavailableError(
    'postgres',
    operation,
    `${hint}。PostgreSQL 后端当前只交付接口层（见 docs/adr/0002-storage-backends.md）；`
    + '宿主必须用自己选择的驱动建好客户端，再通过 options.client 注入。'
    + '这里**不会**自动降级到文件后端——静默降级会让"数据到底写到了哪里"变成无法回答的问题。',
  )
}

function assertSafeSchemaName(schema: string): string {
  // schema 名会被直接拼进 DDL（PG 不支持把标识符当参数绑定），因此必须白名单校验：
  // 一个带引号或分号的 schema 名就是一次 DDL 注入。
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(schema)) {
    throw new StorageUnavailableError(
      'postgres', 'schema-name',
      `schema 名不合法：${JSON.stringify(schema)}；只允许小写字母/数字/下划线且以字母或下划线开头`,
    )
  }
  return schema
}

function codeOf(error: unknown): string | null {
  if (error === null || typeof error !== 'object') return null
  const record = error as Record<string, unknown>
  for (const key of ['code', 'sqlState', 'errno']) {
    const value = record[key]
    if (typeof value === 'string' && value !== '') return value
    if (typeof value === 'number') return String(value)
  }
  return null
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
