# L1 设计：Pipeline / Revision / Run 事实模型与迁移

> **这是 `docs/18` §1 要求的"迁移设计先行"交付物。**
> 在 L1 写任何实现代码之前，本文件必须先定稿——因为 L1 要改的是**公共事实模型**，
> 设计错了会导致后面 L2~L5 全部返工。
>
> 本文件只做设计，**不含代码改动**。实现顺序与验收在 §9/§10。

---

## 0. 设计基线（写本文件时的现实）

```text
仓库：  /Users/zhangzhixiong/Downloads/harness/test-platform-design
HEAD：  5f84871（本地）
远端：  b9ff843（origin/main），本地 ahead 1
工作区：M web-app/server.mjs、M test/web-http.test.ts、?? docs/18
测试：  928/928 pass（0 fail、0 skipped）
```

现有 Web 层规模（用于评估改动面）：

```text
src/web/pipeline-run-service.ts   2075 行
src/web/pipeline-run-types.ts      870 行
src/web/async-runner.ts            337 行
src/web/pipeline-run-registry.ts   171 行
src/web/server-config.ts           278 行
src/web/ssrf-guard.ts              174 行
web-app/server.mjs                 17 个路由
```

**结论：L1 是一次结构性改造，必须分三步（L1a/L1b/L1c）落地，且全程保持旧 API 可用。**

---

## 1. 目标与非目标

### 1.1 目标

1. 引入三个一等对象：`Pipeline`（身份）、`PipelineRevision`（配置快照）、`PipelineRun`（一次执行）。
2. 编辑不再覆盖运行参数，而是**创建新 Revision**。
3. 同一 Pipeline 支持**多次 Run**；每次 Run 绑定一个 Revision。
4. 旧数据（现有 `pipelines/<id>.json` + `checkpoints/<id>/checkpoint.json` + `artifacts/<id>/`）**继续可读**。
5. 旧 API（`GET /api/pipelines/:id`、`POST /api/pipelines/:id/run` 等）**继续可用**，语义映射到 active Run。
6. 迁移可中断、可恢复、可回滚。

### 1.2 非目标（L1 明确不做）

- 不做 PostgreSQL / Object Store（那是 L4）；
- 不做多用户 / RBAC（那是 L3）；
- 不做 run comparison（那是 L2）；
- 不删除任何旧文件；
- 不改六阶段顺序与机器门禁规则；
- 不改 executor 的会话/证据格式（L2 才把证据绑到 runId）。

---

## 2. 对象模型

### 2.1 Pipeline（身份）

```ts
interface PipelineRecord {
  readonly pipelineId: string
  readonly tenantId: string | null
  readonly projectId: string
  readonly configRef: string
  readonly displayName?: string
  readonly createdAt: number
  readonly updatedAt?: number
  /** 软删除标记。存在即视为已移除（列表默认隐藏）。 */
  readonly deletedAt?: number
  readonly deletedBy?: string
  /** 当前生效的 revision。老数据迁移后指向 migration revision。 */
  readonly activeRevisionId: string
  /** L1a 迁移期间：老结构的位置（相对 dataRoot），迁移完成后可保留作审计线索。 */
  readonly legacyLocator?: LegacyLocator
}

interface LegacyLocator {
  readonly manifestPath: string
  readonly checkpointPath: string
  readonly artifactsRoot: string
  readonly migratedAt: number
}
```

**不变量**

| # | 不变量 |
|---|---|
| P1 | `pipelineId` 创建后不可改 |
| P2 | `tenantId` / `projectId` / `configRef` 不可编辑（改了就不是同一条流水线） |
| P3 | `deletedAt` 是软删除，不是物理删除 |
| P4 | 列表默认隐藏 `deletedAt !== undefined` |
| P5 | `activeRevisionId` 必须指向存在的 revision |
| P6 | 同一个 `(tenantId, projectId, pipelineId)` 唯一 |

### 2.2 PipelineRevision（配置快照）

```ts
interface PipelineRevision {
  readonly revisionId: string
  readonly pipelineId: string
  readonly revisionNumber: number      // 从 1 开始，单调递增
  readonly createdAt: number
  readonly createdBy: string
  readonly status: 'active' | 'superseded'

  readonly requirementInput?: string
  readonly providerName?: string
  readonly targetBaseUrl?: string
  readonly rulesetVersion: string
  readonly maxGateRetries?: number
  readonly gateWaitTimeoutMs?: number
  readonly gateTaskTtlMs?: number
  readonly diagCredentials?: readonly string[]

  /** 覆盖全部会改变运行行为的字段；用于去重与审计绑定。 */
  readonly fingerprint: string
  /** 老数据迁移产生的第一个 revision。 */
  readonly migratedFrom?: string
}
```

**不变量**

| # | 不变量 |
|---|---|
| R1 | Revision 创建后**不可变**（任何字段都不再改） |
| R2 | `revisionNumber` 在同一 pipeline 内单调递增、不跳号 |
| R3 | 同一 pipeline 内最多一个 `status: 'active'` |
| R4 | `fingerprint` 覆盖所有行为字段（含 `rulesetVersion`） |
| R5 | 凭据**值**绝不进入 revision；`diagCredentials` 只存环境变量名 |
| R6 | `targetBaseUrl` 在创建 revision 时做 SSRF 校验 |
| R7 | 创建新 revision 时，若 fingerprint 与当前 active 相同 → **不新建**，直接返回当前 active（避免"改了个空格产生一版"） |

### 2.3 PipelineRun（一次执行）

```ts
type PipelineRunStatus =
  | 'queued' | 'running' | 'waiting-human' | 'needs-fix'
  | 'gate-failed' | 'review-failed' | 'rejected' | 'completed' | 'failed' | 'cancelled'

interface PipelineRun {
  readonly runId: string
  readonly pipelineId: string
  readonly revisionId: string
  readonly attempt: number             // 同 run 内第几次尝试（阶段重试不算）
  readonly status: PipelineRunStatus
  readonly cursor: number
  readonly createdAt: number
  readonly startedAt?: number
  readonly finishedAt?: number
  readonly createdBy: string
  readonly failure?: {
    readonly code: string
    readonly detail: string
    readonly stageId?: string
    readonly at: number
  }
  /** L1a 期间指向老 checkpoint；L1b 之后指向 run 自己的检查点。 */
  readonly checkpointLocator: string
}
```

**不变量**

| # | 不变量 |
|---|---|
| N1 | 一个 pipeline 同时最多一个 `status in ('queued','running','waiting-human','needs-fix')` 的 Run |
| N2 | Run 绑定 `revisionId`，且该 revision 属于同一 pipeline |
| N3 | `runId` 全局唯一 |
| N4 | 终态 Run 不可再推进（`completed`/`rejected`/`cancelled`/`gate-failed`/`review-failed`/`failed`） |
| N5 | 用户点"重新运行" → **新 `runId`**；同一 Run 内的阶段重试 → 同 `runId`，`attempt` 递增 |
| N6 | 运行锁保护的是 **active Run**，不是 pipelineId（L1c 起） |

### 2.4 与现有类型的关系

现有 `PipelineRunView`（`pipeline-run-types.ts`）继续作为**视图**存在，但它描述的是
"某个 Run 的视图"，而不是"某个 pipeline 的视图"。

```text
PipelineRecord      ← 身份
PipelineRevision    ← 配置
PipelineRun         ← 运行
PipelineRunView     ← 上述三者的派生视图（新增 runId / revisionId / revisionNumber 字段）
```

---

## 3. 存储布局与 locator

### 3.1 目标布局

```text
<dataRoot>/
  pipelines/<pipelineId>.json                  # **旧 manifest / 现有索引**（L1 期间不动）
  pipelines/<pipelineId>/
    pipeline.json                              # PipelineRecord（新）★ 独立路径，见 §3.3
    revisions/<revisionId>.json                # PipelineRevision（新）
    runs/<runId>.json                          # PipelineRun（新）
    runs/<runId>/checkpoint.json               # L1b 起
    runs/<runId>/artifacts/<stageId>.json      # L1b 起
  # ── 以下为旧结构，L1 期间保持可读，不删 ──
  tenants/<tenant>/projects/<project>/
    checkpoints/<pipelineId>/checkpoint.json
    artifacts/<pipelineId>/<stageId>.json
    gates/<gateTaskId>.json
    tasks/<taskId>.json
    usage/<pipelineId>.jsonl
    audit/audit.jsonl
```

### 3.2 locator 函数（**唯一路径来源**）

新增 `src/web/pipeline-locator.ts`，所有入口必须调用它，禁止自行拼路径：

```ts
function pipelineRecordPath(dataRoot: string, pipelineId: string): string
function pipelineDir(dataRoot: string, pipelineId: string): string
function revisionPath(dataRoot: string, pipelineId: string, revisionId: string): string
function runRecordPath(dataRoot: string, pipelineId: string, runId: string): string
function runCheckpointPath(dataRoot: string, pipelineId: string, runId: string): string
function runArtifactPath(dataRoot: string, pipelineId: string, runId: string, stageId: StageId): string
function legacyCheckpointRoot(roots: PlatformStorageRoots): string
function legacyArtifactRoot(roots: PlatformStorageRoots): string
```

**为什么必须收口**：`docs/18` §8.6 禁止"各入口各写一套事实"。历史上锁路径就是这样出过问题
（CLI/Web/Harness 拼出三条不同路径 = 等于没锁）。路径推导必须先收成一个模块。

### 3.3 ⚠️ 为什么 `PipelineRecord` **不能**写在 `pipelines/<pipelineId>.json`

本文件早期版本把 `PipelineRecord` 放在 `pipelines/<pipelineId>.json`——**那正是旧 manifest 的路径**。
实测确认这是一个**会静默损坏行为**的陷阱：

```text
现有索引读取器 `isIndexEntry` 只校验 pipelineId / projectId / configRef 非空，
**忽略多余字段**；而 `PipelineRecord` 恰好都有这三个字段 → 被当成合法 manifest 接受。
后果：targetBaseUrl / providerName / 运行预算这些**只存在于旧 manifest** 的字段全部丢失，
      而 create / run 继续"成功"——行为已经变了却没有任何报错。
```

证据：`test/pipeline-l1a-service.test.ts` 的
「L1a⚠️：把 PipelineRecord 形状写进 pipelines/<id>.json 会被**静默误读**」——
它把索引文件原地换成新形状，断言 `get()` **不报错**且 `params` 变成 `{}`。
这条测试是**特征测试**（characterization test），故意钉住这个危险事实：
将来若有人"顺手修好" `isIndexEntry`，它会失败并强制其更新本设计。

**因此**：新形状写在 `pipelines/<pipelineId>/pipeline.json`（独立路径），
旧索引在 L1 期间**原样保留**，直到 L1c 才切换。这也让"新旧并存"成为物理上可能，
而不是靠"读取时按形状猜"。

### 3.4 读路径解析顺序（L1a 兼容策略）

```text
读一条 pipeline：
  1. 读 pipelines/<id>/pipeline.json（新形状）
  2. 若不存在 → 读 pipelines/<id>.json 并**按形状判别**：
     - looksLikeLegacyManifest → 投影成内存态三对象（**不落盘**，L1a 纯读兼容）
     - looksLikePipelineRecord → 兼容早期误写到该路径的情况（不推荐，见 §3.3）
  3. 两者都不认 → 报 `schema-invalid` 诊断（**不猜**）
  4. 文件不存在 → not-found
```

**为什么还要按形状判别**：历史数据里没有版本号可用；而且磁盘上确实可能同时存在
"早期版本误写的新形状"与"正常的旧形状"。判别顺序固定为"先新路径、再旧路径 + 形状判别"，
结果只取决于内容，不取决于时间。

**L1a 只读兼容、不写新格式**——这样即使 L1a 上线后发现问题，回滚只是"关掉新读路径"，
磁盘上没有任何新格式数据。

---

## 4. 迁移状态机

### 4.1 三阶段迁移（L1a → L1b → L1c）

```text
L1a 只读兼容（无写入）
  旧数据 → 内存态新对象；新对象尚未落盘
  回滚成本：0（无数据变化）

L1b 双写（新写入新格式 + 保留旧格式）
  创建 pipeline / 创建 revision / 创建 run → 同时写新旧
  旧数据被访问时 → 惰性迁移（写新格式，旧文件保留）
  回滚成本：低（旧格式仍在，旧代码可读）

L1c 切换为单一事实源（新格式）
  新写入只写新格式；旧文件只读保留，不再更新
  回滚成本：中（需把新格式回导出旧格式，见 §4.4）
```

**每阶段都必须可以停在那里跑一段时间**，不得要求"一次切完"。

### 4.2 惰性迁移（L1b）

触发点：任何一次 `get(pipelineId)` 命中旧格式且未迁移过。

```text
读旧 manifest + checkpoint
  → 构造 PipelineRecord（activeRevisionId = revision-1）
  → 构造 PipelineRevision-1（从旧 manifest 的运行参数字段）
  → 构造 PipelineRun-1（status/cursor 从 checkpoint 推导）
  → 写 pipelines/<id>.json
  → 写 revisions/revision-1.json
  → 写 runs/run-1.json
  → 追加审计 pipeline-migrated
  → 返回新视图
```

**硬约束**

| # | 约束 |
|---|---|
| M1 | 迁移**不修改、不删除**旧文件 |
| M2 | 迁移前先写 `migration-intent` 审计事件；成功后写 `migration-completed` |
| M3 | 迁移中断后重跑必须**幂等**（新格式已存在则跳过，不重复写） |
| M4 | 迁移只做"读旧 → 写新"，**不合并语义**（不猜历史 revision） |
| M5 | 迁移失败不得让 `get` 失败——降级为"只读旧格式"并返回明确诊断 |
| M6 | 迁移不得触发任何阶段执行 |

### 4.3 迁移中断的恢复

```text
检测：pipelines/<id>.json 存在但 revisions/ 或 runs/ 缺失
  → 视为"迁移未完成"
  → 重新执行迁移（幂等）
  → 若新格式已存在且合法 → 跳过写入，只补审计
```

新增诊断码（`StorageDiagnosticCode`）：

```text
'migration-needed'      已有（旧格式待迁移）
'migration-incomplete'  新增（新格式存在但不完整）
'migration-conflict'    新增（新旧格式都存在但事实不一致）
```

`diagnose()` 必须报告这三类，**不静默**。

### 4.4 回滚（L1c → L1b）

```text
1. 停写（只读模式）
2. 导出：PipelineRecord + active revision + 最近 run → 旧 manifest + 旧 checkpoint
3. 校验：新旧两侧视图 deepEqual
4. 切回旧代码（旧代码只读旧格式）
5. 新格式文件**保留不删**（回滚后可再切回来）
```

**L1c 上线前必须演练一次回滚**，并把演练结果写进 `docs/17` 式的验收记录。

---

## 5. 兼容矩阵

### 5.1 API 兼容

| 现有 API | L1 行为 | 新 API |
|---|---|---|
| `GET /api/pipelines` | 返回 active Run 的摘要（隐藏软删除） | 可选 `?includeRemoved=true`（admin） |
| `GET /api/pipelines/:id` | 返回 **active Run 视图**（保持现有字段，新增 `runId`/`revisionId`） | `GET /api/runs/:runId` |
| `POST /api/projects/:pid/pipelines` | 创建 Pipeline + revision-1 + run-1 | 同上 |
| `POST /api/pipelines/:id/run` | 触发 **active Run**；无 active Run 时按 active revision 新建 run | `POST /api/pipelines/:id/runs` |
| `PATCH /api/pipelines/:id` | **创建新 revision**（不再改 manifest）；行为参数变化时返回新 `revisionId` | `POST /api/pipelines/:id/revisions` |
| `DELETE /api/pipelines/:id` | 软删除（`deletedAt`），数据保留 | `POST /api/pipelines/:id/restore`（admin） |
| `GET /api/pipelines/:id/gates` | 限定 active Run | `GET /api/runs/:runId/gates` |
| `GET /api/pipelines/:id/events` | 限定 active Run | `GET /api/runs/:runId/events` |
| `GET /api/pipelines/:id/usage` | 限定 active Run，另附 pipeline 汇总 | `GET /api/runs/:runId/usage` |
| `GET /api/pipelines/:id/stages/:s/artifact` | 限定 active Run | `GET /api/runs/:runId/stages/:s/artifact` |
| `GET /api/pipelines/:id/diagnostics` | 保持（体检是项目级，不随 run 变） | — |

**兼容原则**：旧端点**永不返回新语义**（例如不因为有了多 run 就让旧端点在多个 run 之间跳）；
旧端点**永远指向 active Run**，这是可预测的。

### 5.2 落盘字段兼容

| 旧字段 | 新位置 | 兼容策略 |
|---|---|---|
| manifest 的运行参数字段 | `PipelineRevision` | 迁移时复制；旧 manifest 保留 |
| manifest 的 `creationState` | 不迁移（那是创建中间态） | L1a 起不再产生新的 creating |
| `createdAt` / `updatedAt` | `PipelineRecord` | 直接复制 |
| checkpoint 的 `stageStates` / `cursor` | `PipelineRun` + run checkpoint | 复制；旧 checkpoint 保留 |
| `reentries` | run checkpoint | 属于某一次运行的重入历史 |

---

## 6. 并发与锁

### 6.1 L1 期间的锁语义

```text
L1a：锁路径不变（仍按 pipelineId）—— 保证与旧代码互操作
L1b：锁路径不变，但锁的语义明确为"保护 active Run"
L1c：锁路径改为 (pipelineId, runId) 两级：
      - pipeline 级锁：保护"创建/切换 revision、创建 run"
      - run 级锁：保护"推进该 run 的阶段"
```

**为什么 L1c 才拆**：拆锁路径会让新旧代码互不互斥。L1a/L1b 必须保证"新旧进程不能同时推进
同一条流水线"，所以路径不能变。

### 6.2 必须新增的并发测试

```text
1. 两个进程同时 PATCH → 只有一个 revision 成功，另一个得到 conflict
2. 两个进程同时创建 run → 只有一个 active Run
3. 旧代码（按 pipelineId 锁）+ 新代码（L1b）同时推进 → 仍互斥
4. L1c 之后：两个 run 可并行（不同 runId），但同一 run 仍互斥
```

---

## 7. 失败路径清单（L1 必须覆盖的测试）

命名建议 `test/pipeline-revision-contract.test.ts` / `pipeline-run-contract.test.ts` /
`pipeline-migration.test.ts` / `pipeline-legacy-compat.test.ts`：

```text
【身份】
- pipelineId 不可改（PATCH 拒绝）
- projectId / tenantId / configRef 不可改（PATCH 拒绝）
- 软删除后列表隐藏、admin 可见
- 软删除后普通读取返回 not-found（不泄露存在性）
- 恢复软删除后回到列表

【Revision】
- 创建 revision 后旧 revision 仍可读
- fingerprint 相同 → 不新建 revision
- fingerprint 不同 → 新建 revision 且 revisionNumber 递增
- 同一 pipeline 内最多一个 active
- 凭据值不进入 revision（哨兵扫描）
- diagCredentials 只允许环境变量名
- targetBaseUrl 创建 revision 时过 SSRF

【Run】
- 一个 pipeline 同时最多一个 active Run
- 终态 Run 不可推进
- 重新运行产生新 runId
- 同一 run 内阶段重试 attempt 递增、runId 不变
- Run 的 revisionId 必须属于同一 pipeline

【迁移】
- 旧 manifest 可读成 PipelineRecord + revision-1 + run-1
- 旧 checkpoint 的 cursor/stageStates 正确映射
- 迁移中断（只写了 PipelineRecord）→ 重跑幂等成功
- 迁移失败 → get 降级为只读旧格式 + 明确诊断（不抛异常、不丢数据）
- 迁移不修改旧文件（逐文件 sha256 比对）
- 迁移写审计事件

【兼容】
- 旧 GET /api/pipelines/:id 与 GET /api/runs/:activeRunId 返回同一事实
- 旧 POST /api/pipelines/:id/run 与 POST /api/pipelines/:id/runs 语义一致
- 旧 PATCH 语义变为"创建 revision"后，旧客户端仍拿到 200 + 可用视图
- 旧 DELETE 语义为软删除后，旧客户端仍拿到 200

【并发】
- 并发 PATCH → 一个成功一个 conflict
- 并发创建 run → 只有一个 active
- 新旧代码同时推进同一条流水线 → 互斥
```

---

## 8. 实现顺序（L1a → L1b → L1c）

### L1a：类型 + locator + 只读兼容（**不写新格式**）

交付：

```text
src/web/pipeline-model.ts          # PipelineRecord / PipelineRevision / PipelineRun 类型与不变量断言
src/web/pipeline-locator.ts        # 唯一路径来源
src/web/pipeline-legacy.ts         # 旧 manifest/checkpoint → 新对象的纯函数投影
```

要求：

- 新增 `GET /api/pipelines/:id/revisions`、`/runs` 只读端点（数据来自内存投影）；
- **不写任何新格式文件**；
- 旧端点行为**逐字不变**（用现有 928 项测试兜底）。

验收：现有测试全绿 + 新增 legacy 投影测试；磁盘零新文件。

#### L1a 执行记录（证据）

执行时间：2026-09-29。提交：`80c85e5`（代码）、`eebd2fe`（设计定稿）。

```text
tsc --noEmit                          OK
node --test test/pipeline-model-l1a.test.ts     17/17 pass
node --test test/pipeline-l1a-service.test.ts    8/8  pass
node --test                          953/953 pass、0 fail、0 skipped
```

L1a 的两条**承诺性**断言（不是"字段对不对"，而是"承诺有没有被破坏"）：

```text
1. 不写盘：跑完 listRevisions / listRuns 后，数据根里每个文件的
   sha256 + 大小逐字不变 —— 这是"L1a 回滚成本为零"的实质。
2. 不泄露部署布局：响应体里不得出现数据根绝对路径。
   projectLegacy 产出的 legacyLocator 是绝对路径，必须被剥掉；
   用 PublicPipelineRecord = Omit<PipelineRecord,'legacyLocator'> 在**类型层面**
   让它无法出现在响应里，而不是靠"记得别返回它"。
```

**L1a 期间发现并修掉的两个真实缺陷**（都记入 `eebd2fe` / `80c85e5`）：

| 缺陷 | 后果 | 修法 |
|---|---|---|
| `PipelineRecord` 若写在 `pipelines/<id>.json` | `isIndexEntry` 忽略多余字段 → 新形状被当合法 manifest → **运行参数静默丢失** | 改到 `pipelines/<pipelineId>/pipeline.json`；特征测试钉住（见 §3.3） |
| `revisionFingerprint` 把 `undefined` 与 `''` 归一成同一值 | 两份**行为不同**的配置算出同一指纹，破坏 R4 | `normalizeField` 加类型标签（`u:`/`n:`/`a:`/`v:`） |

**§9 验收门槛的 L1a 部分**：

- [x] 三对象类型冻结，且不变量有断言函数（`assertRunInvariants` 等，不是只写在文档里）
- [x] 旧数据可读（953 项现有测试全绿）
- [ ] locator 是唯一路径来源 —— **未达**：`pipeline-run-service.ts` 仍有一处
      `join(dataRoot, 'pipelines')`。按 §3.2 的设计，服务层委托到 locator 属 **L1b**，
      此处如实记为未勾选，不得提前勾。

### L1b：双写 + 惰性迁移

交付：

- 创建 pipeline/revision/run 时双写；
- 旧数据访问时惰性迁移（幂等、可中断）；
- `diagnose()` 报告 `migration-*` 诊断码。

验收：迁移测试 + 并发测试 + 迁移不修改旧文件（sha256）。

### L1c：切换单一事实源 + 锁拆分

交付：

- 新写入只写新格式；
- 锁拆成 pipeline 级 + run 级；
- 旧文件只读保留。

验收：回滚演练（§4.4）+ 多进程并发 + 全量回归。

---

## 9. 验收门槛（L1 完成判定）

- [ ] 三对象类型冻结，且不变量有断言函数（不是只写在文档里）
- [ ] locator 是唯一路径来源（grep 全仓无第二处拼 `pipelines/`、`runs/`）
- [ ] 旧数据可读（928 项现有测试全绿）
- [ ] 迁移可中断、可恢复、可回滚，且**不修改旧文件**
- [ ] `PATCH` 创建新 revision（不再覆盖 manifest）
- [ ] 每次 Run 绑定 revisionId
- [ ] 旧 artifact 不被新 run 覆盖
- [ ] 旧 API 与新 API 读同一事实
- [ ] 并发测试（PATCH / run / 新旧代码混跑）全绿
- [ ] `diagnose()` 报告迁移诊断码
- [ ] 回滚演练记录写进验收文档

---

## 10. 决策记录（L1a 开工前已定稿）

| # | 问题 | 决定 | 理由 |
|---|---|---|---|
| **Q1** | 用户点"重新运行"是新建 run 还是同一 run 的 `attempt+1`？ | **新建 run** | `attempt` 只用于**同一次运行内**的阶段重试；用户主动再跑一次是**新的一次运行**，必须有自己的产物与证据，否则"运行历史"与"结果比较"（L2）不成立 |
| **Q2** | 软删除后 `pipelineId` 能否被新 pipeline 复用？ | **永久占用** | 复用会让审计与历史产生歧义（同一个 ID 指过两条不同的流水线）。要换项目/换身份请换 ID |
| Q3 | `PATCH` 无字段变化时是否创建 revision？ | **不创建** | 避免噪音版本；见 R7 |
| Q4 | 旧 `POST /api/pipelines/:id/run` 在无 active Run 时是否自动创建 run？ | **自动创建**，并在响应里回传 `runId` | 保持旧客户端可用；同时让新客户端能拿到 runId |
| Q5 | L1c 之后是否允许同一 pipeline 两个 run 并行？ | **允许**（不同 runId），但**同一 run 严格互斥** | 并行运行是 L2 比较能力的前提；同一 run 双写会破坏事实 |
| Q6 | run 级产物目录会显著放大磁盘吗？ | **会**，L1 只记录风险 | 保留策略（保留最近 N 次 run）放 L2，不塞进 L1 |

**Q1 的落地形态**（写清楚，避免实现时含糊）：

```text
POST /api/pipelines/:id/run      → 触发 **active Run**
POST /api/pipelines/:id/runs     → 显式创建**新 Run**（绑定 active revision），再触发
"重新运行"按钮                    → 调 /runs（新 runId），不是把旧 run 重跑
同一次运行内的阶段重试             → 同一 runId，attempt + 1（driver 内部行为，不变）
```

**Q2 的落地形态**：

```text
PipelineRecord.deletedAt 存在 → pipelineId 永久占用
create 时若发现 deletedAt 存在 → 409 conflict，错误详情里说明"该 ID 已被已移除的流水线占用；
要恢复请用 restore，要新建请换 ID"
```

---

## 11. 风险

| 风险 | 影响 | 缓解 |
|---|---|---|
| 改动面大（web 层 2075 行核心 service） | 回归风险高 | 分 L1a/L1b/L1c；L1a 不写盘，回滚成本为 0 |
| 旧 API 语义漂移 | 现有客户端/测试失效 | 兼容矩阵（§5.1）+ 928 项测试兜底 |
| 迁移中断留下半成品 | 数据不可读 | 幂等迁移 + `migration-incomplete` 诊断 + 降级为只读旧格式 |
| 锁路径提前拆分 | 新旧进程不再互斥 | 锁路径 L1c 才拆（§6.1） |
| 磁盘放大（每 run 一套产物） | 长期运维成本 | L1 只记录风险；保留策略放 L2 |

---

## 12. 一句话

> **L1a 只加类型、locator 与只读兼容，不写任何新格式文件——这样即使设计错了，回滚成本是零。**
> 双写（L1b）与切源（L1c）必须在 L1a 稳定运行之后再做。
