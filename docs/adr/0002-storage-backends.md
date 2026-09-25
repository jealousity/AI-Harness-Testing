# ADR-0002：存储后端选型、端口映射与事务边界

- 状态：已接受
- 日期：2026-09-25
- 适用范围：`packages/platform-pipeline/src/storage/`
- 依据：`docs/10-next-phase-implementation-plan.md` §8.2、§8.3（M4-A / M4-B）、§8.4、§10 P1-B

## 背景

`docs/10` §8.2 要求把持久化提升为**可替换的端口**，§8.3 M4-B 要求"评估并实现
PostgreSQL / object-store adapter"，§10 P1-B 第 3 条给出兜底："**若本阶段不部署外部后端，
至少交付接口和 ADR**"。本 ADR 记录：选了哪些后端、端口怎么映射、事务边界在哪、
为什么本阶段只交付接口层、以及将来真正落地时怎么切、怎么回滚。

已落地并可运行的后端（本 ADR 之前）：

| 后端 | 位置 | 依赖 | 用途 |
|---|---|---|---|
| `file` | `src/storage/file/` | 本地文件系统 | 本地开发、单机部署（生产可用） |
| `memory` | `src/storage/memory/` | 无 | 契约验证、单元测试（**不作为生产后端**） |

本 ADR 新增的**接口层**（不可独立运行，无 SDK 依赖）：

| 模块 | 位置 | 内容 |
|---|---|---|
| 组合层 | `src/storage/compose.ts` | `composeStorageBackends()`：把 records 与 objects 拼成一个完整后端 |
| PostgreSQL | `src/storage/postgres/` | `PostgresClient` 接缝、DDL、端口↔表映射、事务边界、错误分类 |
| 对象存储 | `src/storage/object-store/` | `ObjectStoreClient` 接缝、对象键约定、键安全校验、错误分类 |

## 决策摘要

| 关注点 | 决策 | 理由 |
|---|---|---|
| 需要事务/CAS 的状态 | **PostgreSQL**（checkpoint、task、gate task、usage、audit、lock） | 这些操作全是"读改写原子"，对象存储给不了条件写 |
| 大对象 | **对象存储**（artifact、evidence、知识 Markdown、用例 JSON） | 产物是 MB 级 blob，塞进 `bytea` 会把库拖垮；且对象存储天然可 CDN/生命周期管理 |
| 后端形态 | **records + objects 组合**，不是二选一 | 两类后端各自都不完整，见下文第 2 节 |
| 本阶段交付深度 | **接口层 + 本 ADR**，不引入 SDK、不建连 | 见下文第 4 节 |
| 未配置时行为 | 抛 `StorageUnavailableError`（HTTP 503），**不降级** | 静默降级会让"数据到底写到哪了"无法回答 |
| 队列 / Redis | **本阶段不做** | 端口（`lock` + `tasks`）已就位，多机调度出现时只需换这两个端口的实现 |

## 1. 端口 ↔ 后端映射

`docs/10` §8.2 列出的 9 个端口，落到后端如下（`*` = 必需端口）：

| 端口 | 必需 | file | memory | **postgres** | **object-store** | 载体 |
|---|---|---|---|---|---|---|
| `ArtifactStore` | * | ✅ | ✅ | ❌ | ✅ | 对象：`artifacts/<proj>/<pipe>/<stage>.json` |
| `CheckpointPort` | * | ✅ | ✅ | ✅ | ❌ | 表：`pipeline_checkpoint` + `pipeline_checkpoint_stage` |
| `TaskStore` | * | ✅ | ✅ | ✅ | ❌ | 表：`pipeline_task` |
| `HumanGateTaskStore` | * | ✅ | ✅ | ✅ | ❌ | 表：`pipeline_gate_task` |
| `UsageStore` | * | ✅ | ✅ | ✅ | ❌ | 表：`pipeline_usage_event` |
| `AuditEventStore` | * | ✅ | ✅ | ✅ | ❌ | 表：`pipeline_audit_event` |
| `KnowledgeStore` | 可选 | ✅ | ✅ | ❌ | ✅ | 对象：`knowledge/<proj>/<id>.md` |
| `CaseStore` | 可选 | ✅ | ✅ | ❌ | ✅ | 对象：`cases/<proj>/<caseId>.json` |
| `PipelineLock` | 可选 | ✅ | ✅（仅进程内） | ✅ | ❌ | 表：`pipeline_lock`（CAS on `generation`） |

映射的机器可读版本在代码里：`POSTGRES_PORT_TABLES`、`OBJECT_KEY_ROOTS`。
**测试会校验代码与 DDL 一致**（`test/storage-external.test.ts`）——映射表和建表语句
是同一件事的两种写法，让它们能各自漂移就是在制造"文档说有、代码里没有"。

## 2. 为什么 PostgreSQL 与对象存储必须**组合**

单看任何一个都不完整：

- **只有 PostgreSQL**：产物是 MB 级 blob。放进 `bytea` 会让每次 checkpoint 的 WAL
  膨胀、备份变慢，而且它本来就不该承担"文件"这件事。→ `artifacts` 端口无解。
- **只有对象存储**：检查点、任务租约、人工门裁决、互斥锁全都建立在"读改写原子"之上。
  对象存储通常**没有条件写**（S3 的 `If-None-Match` 只在部分场景可用，GCS 的
  generation-match 也不是所有 SDK 都暴露），两个进程同时写同一个 key 就是
  后写覆盖先写——**人工门的裁决会被静默丢掉**，这正是 M2 花大力气修掉的那类问题。

所以真实部署 = **records（PostgreSQL）+ objects（对象存储）**，由
`composeStorageBackends()` 拼成一个 `StorageBackend`：

```ts
// recordsBackend / objectsBackend 由落地真实实现时新增的工厂产出（本阶段不存在，见第 4 节）
const backend = composeStorageBackends({
  name: 'production',
  parts: [
    { role: 'records', backend: recordsBackend },
    { role: 'objects', backend: objectsBackend },
  ],
})
```

组合层做了四件**必须**有唯一落点的事（否则每个宿主会自己拼一套）：

1. **版本一致性**：各部分 `schemaVersion` 不一致直接拒绝装配——同一进程里存在两套
   记录格式时，读谁的都会读错一半。
2. **端口冲突显式化**：同一端口被两个部分提供时拒绝装配，除非宿主用 `overrides`
   明确表态。组合层**不替宿主猜优先级**。
3. **能力声明合并**：`describe()` 汇总两部分的 `implementedPorts` / `unavailablePorts`，
   并如实传播 `requiresExternalInfrastructure`。
4. **装配即校验**：缺必需端口在 `composeStorageBackends()` 里就抛错，而不是等到
   第一次跑流水线才表现为"某个功能莫名其妙不可用"。

`portOrigins` 是排障用的可观测面：`describe()` 只回答"有哪些端口"，
`portOrigins` 回答"这个端口是谁提供的"。

## 3. 事务边界

`docs/10` §8.4 要求"checkpoint 与 gate task 的事务边界清晰"。完整清单在
`POSTGRES_TRANSACTION_BOUNDARIES`（代码里，每条都带 `why`）。三条最关键的：

### 3.1 检查点保存：一条语句完成 CAS

```sql
UPDATE pipeline_checkpoint
   SET revision = revision + 1, payload = $payload, cursor = $cursor, updated_at = now()
 WHERE project_id = $project AND pipeline_id = $pipeline AND revision = $expected;
-- rowCount = 0 → 有人先写了，重读后重试（不要盲目重放）
```

写成"先 SELECT revision，再 UPDATE"会允许两个进程各自基于同一旧版本写入，
后写的**静默覆盖**先写的。阶段投影表必须在同一事务内更新，否则 Web 列出的
"卡在 execute 的流水线"就是骗人的。

### 3.2 人工门裁决：条件更新，0 行即拒绝

```sql
UPDATE pipeline_gate_task
   SET status = $action, decision = $decision, updated_at = now()
 WHERE project_id = $project AND gate_task_id = $id
   AND status = 'claimed' AND claimed_by = $actor;
-- rowCount = 0 → 不是你的 claim，拒绝
```

把"检查是不是他持有"和"写入裁决"拆成两条语句，就允许两个人在同一毫秒各自裁决成功。
人工门是责任链，一次裁决只能有一个责任人。

### 3.3 产物 → 检查点：**刻意不做**分布式事务

产物在对象存储、检查点在 PostgreSQL，两者无法共用一个事务。因此顺序**固定**为：

```text
1. 写产物（同路径可覆盖，幂等）
2. 写检查点（唯一声明"阶段完成"的地方）
```

中间崩溃的结果是"有产物、没声称完成"。重试会重跑该阶段并覆盖产物——这正是
§8.4 要求的可重试语义。**反过来（先写检查点）会得到"声称完成但没有产物"，
那才是不可恢复的**：门禁会拿一个不存在的产物去判，人工门会批准一个空对象。

这条顺序由 `test/storage-external.test.ts` 端到端验证：让检查点端口在第一次
保存时抛 `StorageUnavailableError`，断言产物**已写出**、检查点**未落盘**、
人工门**一次都没被调用**，且存储恢复后重试能跑完六个阶段。

### 3.4 用量 vs 审计：失败处理恰好相反

| | 用量 | 审计 |
|---|---|---|
| 定位 | 计量（高频、可丢） | 责任链（低频、必须可查） |
| 写失败 | 记录错误码后继续 | **必须上抛** |
| 表约束 | `ON CONFLICT (project_id, event_id) DO NOTHING` | `REVOKE UPDATE, DELETE` |

审计表的 append-only 必须由**权限**保证，不能靠自觉（见 `postgresSchemaDdl()` 末尾的
注释块）。对象存储给不了同等强度的保证（对象可被覆盖），这也是审计不放对象存储的原因。

## 4. 本阶段为什么只交付接口层

四条理由，按重要性排序：

1. **没有可验证的环境**。写一套没人跑过的 SQL，等于把"看起来对的 SQL"当成已验证的资产
   ——这比没有更危险：后来者会信任它。`docs/10` §8.4 的验收标准是"同一套契约同时通过
   file 与 external"，本阶段用 `memory` + `composed` 作为第二、第三个后端，
   已经把"端口真的可替换"证成了。
2. **不替宿主做选型**。自建 PostgreSQL 还是云 RDS、S3 兼容网关还是原生 S3/GCS/Azure，
   取决于部署形态。本平台提供接缝（`PostgresClient` / `ObjectStoreClient`），
   驱动由宿主注入。
3. **依赖面**。本包当前运行时依赖只有 3 个（`fflate`、`pdfjs-dist`、`yaml`）。
   引入 `pg` 或 `@aws-sdk/client-s3` 会让所有部署都背上一个只有少数部署需要的驱动。
4. **没有消费者**。当前形态是单机 + Web，`file` 后端已经够用；外部后端的触发条件是
   **多进程 / 多机部署**、**单机磁盘成为瓶颈**、或**需要跨机器共享流水线状态**。
   在那之前，接口层就是正确的交付深度。

**何时该做真实实现**：出现上面任一触发条件时，按本 ADR 第 1 节建表、
按第 3 节实现事务边界、把驱动接到 `PostgresClient` / `ObjectStoreClient`，
然后用 `runStorageContract({ name: 'postgres', ... })` 与
`runStorageContract({ name: 'object-store', ... })` 跑同一套契约。
**不需要改动** `driver.ts`、`gates/`、任何 `stage` 或 `web/` 代码。

## 5. 后端切换方式

`docs/10` §8.4：「backend 切换只改宿主装配，不改 stages/gates/driver」。具体落点：

```ts
// 单机（当前，可用）
const backend = createFileStorageBackend({ projectRoot, knowledgeRoot, casesRoot })

// 多机（将来）——recordsBackend / objectsBackend 由落地真实实现时新增的工厂产出；
// 本阶段只有接口层与这份 ADR（第 4 节），不要照抄这两行去跑。
const backend = composeStorageBackends({
  name: 'production',
  parts: [
    { role: 'records', backend: recordsBackend },
    { role: 'objects', backend: objectsBackend },
  ],
})
```

宿主把 `backend.ports` 分发给 driver / 工具 / Web 服务。核心规则只依赖
`src/storage/ports.ts` 里的接口类型，不依赖 `FileHumanGateTaskStore`、
`MarkdownKnowledgeStore` 或任何数据库 SDK 的具体类型。

未配置外部后端时的行为是**明确失败**：

```
[storage:postgres] connect 不可用：既没有注入 client，也没有配置 connectionString。
PostgreSQL 后端当前只交付接口层（见 docs/adr/0002-storage-backends.md）；
宿主必须用自己选择的驱动建好客户端，再通过 options.client 注入。
这里**不会**自动降级到文件后端——静默降级会让"数据到底写到了哪里"变成无法回答的问题。
```

## 6. 迁移与回滚

### 6.1 记录格式只有一份定义

PostgreSQL 的表里保留 `payload jsonb`（检查点、任务、门任务）与 `payload jsonb`
（用量/审计）。**列的职责是索引与约束，不是第二套 schema**：记录的完整形状与校验
仍然只在 `src/storage/ports.ts` 与各端口的读侧校验器里定义一次。

这条设计决定了迁移与回滚都是**机械操作**，不需要写字段映射：

- 文件 → PostgreSQL：读 JSON 文件 → 按表插入 `payload`，同时把可查询字段
  （`cursor`、`status`、`artifact_digest`…）填进对应列；
- PostgreSQL → 文件：按主键 `SELECT payload` → 写成原路径的 JSON 文件。

### 6.2 迁移步骤（文件 → 外部后端）

1. **先备份**：`pg_dump` 目标库 + 对象存储 bucket 打开版本控制；文件侧
   `backups/migration-<时间戳>/`（`migrate()` 已经这么做）。
2. **建表**：执行 `postgresSchemaDdl(schema)`（幂等，可无条件重复执行）。
3. **导入**：检查点、任务、门任务、用量、审计 → 表；产物、证据、知识、用例 →
   对象存储（键约定见 `artifactObjectKey` 等构造函数）。
4. **体检**：`backend.diagnose()` 必须 `ok: true`。任何 `corrupt-json` /
   `schema-invalid` / `migration-needed` 都必须先处理，不能带着诊断上线。
5. **补版本**：`backend.migrate()` 幂等，可重复执行。
6. **切换装配**，然后**保留文件侧只读一段时间**再清理。

### 6.3 回滚

反向执行 6.2 的第 3 步即可（表 → JSON 文件），因为表里存的就是同一份 payload。
对象存储侧的对象可以直接复制回文件系统（知识条目用的是同一种
`<!-- pp-meta --> + 正文` 序列化格式，不需要转换）。

**审计表必须在备份里**，且回滚后要重新 `REVOKE UPDATE, DELETE`。

## 7. 已知边界与待对齐项

这些是**跨后端**问题，必须在端口层或共享层解决，**不能只改一个后端**——
只改一个后端会让"同一套契约"变成谎言，行为差异会在切换部署形态那天爆发。

| # | 问题 | 现状 | 正确的修法 |
|---|---|---|---|
| 1 | `findResumableTask` 只按 `stageId + artifactPath + machineStatus` 匹配，**不校验产物 digest** | 重入（`reenter`）后可能复用旧裁决批准新内容 | 在共享层（`PersistentHumanGate`）加 digest 比较。PG 的 DDL 已预留 `artifact_digest` 列，就是为了这一步不需要改表 |
| 2 | 幂等台账与业务写入仍是两次落盘 | `docs/10` §6.2 末条 | PG 可以用一个事务同时写两张表，但**必须先在端口层表达**"这两件事要一起成功"，否则 file 后端无法遵守同一契约 |
| 3 | 同一 pipeline 同一阶段是否允许存在多个未裁决门任务 | file 后端**允许**（靠 `findResumableTask` 挑一个） | 因此 PG **不能**加"部分唯一索引"来禁止它——那会造成跨后端行为差异。要改就得改契约 |
| 4 | 对象存储没有条件写，`artifacts` 并发写是"后写覆盖" | file 后端同样如此 | 若将来要防，需在端口层引入 `expectedDigest` 之类的条件参数 |
| 5 | 审计 append-only 的强度 | PG 靠 `REVOKE`；对象存储只能靠 bucket policy | 因此审计**固定**放 PG，不随部署形态改变 |
| 6 | `memory` 后端的锁只在进程内有效 | 已写进模块头注释与测试（`锁是**进程内**的`） | 生产部署必须用 file / PG；这一点由 `describe().name` 与锁路径 `memory://` 可观测 |

## 8. 一致性证据

| 证据 | 位置 |
|---|---|
| 同一套契约跑通 file 后端（31 项） | `test/storage-file.test.ts` |
| 同一套契约跑通 memory 后端（32 项） | `test/storage-memory.test.ts` |
| 同一套契约跑通**组合**后端（22 项契约 + 8 项组合专有，合计 44 项） | `test/storage-external.test.ts` |
| 外部存储不可用 → infrastructure failure、不宣称阶段完成、不自动批准 | `test/storage-external.test.ts`（用真实 `PipelineDriver`） |
| 基础设施故障 → `storage-unavailable`(503)，普通异常 → `run-failed`(500) | `test/storage-external.test.ts` |
| DDL 与端口映射一致、DDL 幂等、schema 名白名单防注入 | `test/storage-external.test.ts` |
| 对象键防逃逸（`..` / 绝对路径 / 空段 / 未知根前缀 / 跨项目） | `test/storage-external.test.ts` |

契约套件本身在 `test/storage-contract.ts`，它对后端**无假设**：只断言
"写入后能读回 / 缺失返回 null / 损坏显式失败 / 版本更高必须拒绝"这类语义，
不断言目录名、文件名、原子 rename、JSONL 行号。
