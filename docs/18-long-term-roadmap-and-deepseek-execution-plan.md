# 通用测试辅助平台长期演进与 DeepSeek 执行任务书

> **执行对象：DeepSeek V4.1 Flash**  
> **执行方式：按阶段、按验收门槛执行；不跨阶段堆代码，不把接口层当成真实能力。**  
> **本任务书的上游设计：** `docs/14-web-single-node-productization-plan.md`、`docs/15-web-api-and-state-contract.md`、`docs/16-local-single-node-runbook.md`、`docs/17-web-single-node-acceptance.md`。  
> **任务书定位：** W0~W6 单机 Web 之后的长期演进路线，目标是把当前“单条流水线 + checkpoint”逐步演进成“流水线身份 + 配置版本 + 执行运行 + 不可变证据”的平台。

---

## 0. 先读这一页：总原则与当前现实

### 0.1 远期北极星

最终产品不是一个“能点按钮跑六阶段”的页面，而是一个可回答以下问题的测试证据平台：

```text
这条流水线是谁？
这次运行基于哪一版配置？
哪一个阶段生成了这个产物？
这个结果是否来自真实执行？
谁在什么时候批准了什么？
这次运行与上次运行相比发生了什么变化？
如果删除/编辑/重启/换后端，事实还能不能被追溯？
```

目标模型：

```text
Pipeline（身份）
  → PipelineRevision（配置快照）
    → PipelineRun（一次执行）
      → StageAttempt（阶段尝试）
        → Artifact / Evidence / GateTask / Usage / Audit
```

### 0.2 当前基线必须如实登记

仓库根：

```text
/Users/zhangzhixiong/Downloads/harness/test-platform-design
```

当前本地与远端状态（执行前必须重新核对，以下不是永久真相）：

```text
本地 HEAD：      5f84871
origin/main：    b9ff843
本地 ahead：     1
工作区：         以执行前 git status --short 为准
```

当前已具备或已落地的能力：

- 六阶段：`receive → analyze → design → execute → report → archive`；
- PipelineDriver、机器门禁、审核、人工门、真实 executor、预算、用量和恢复；
- Web 单机控制台、左侧菜单/右侧内容结构、流水线列表、详情、产物、门任务、事件、诊断；
- `PATCH /api/pipelines/:id` 编辑运行参数；
- `DELETE /api/pipelines/:id` 当前语义为**只摘索引、数据保留**；
- `diagnostics` HTTP/CLI 体检；
- `preflight` 前置失败可见；
- 运行期 `run-error` 可落盘并重启重建；
- 当前历史基线测试数曾达到 927/927 通过，但**执行本任务书前必须重新跑全量，不得直接引用旧数字**。

仍然必须如实保留的限制：

- PostgreSQL/Object Store 尚未形成生产可运行后端；
- 多副本、多租户 SaaS、队列/worker 尚未完成；
- 真实公网系统 + 真实模型尚未验收；
- 真实浏览器交互验收受 Chromium 下载环境限制，不能把静态 UI 契约当浏览器验收；
- 当前 `pipelineId + manifest + checkpoint` 仍不是最终的 Revision/Run 模型。

### 0.3 不可违反的原则

1. **先冻结事实模型，再继续加 UI。** 不允许继续把所有参数、状态和历史都塞进一份 manifest。
2. **Pipeline 身份、配置版本、执行运行、产物证据必须最终分层。**
3. **编辑不是重跑。** 编辑配置不自动批准、不自动重入、不自动覆盖旧产物。
4. **移除不是物理删除。** 普通移除只做软删除/摘索引；永久清理必须是独立的高危运维动作。
5. **旧运行不可变。** 新配置、新运行不覆盖旧产物、旧证据、旧审计。
6. **所有业务状态来自持久化事实。** 浏览器、进程内 registry、缓存不得成为第二份事实来源。
7. **后台不得替真人裁决。** 任何恢复、超时、网络错误、模型异常都不得变成 `approved`。
8. **所有入口共用同一业务服务和存储端口。** Web、CLI、Harness、恢复进程不能各写一套事实。
9. **不静默降级。** 后端端口缺失、存储不可用、审计写失败、证据缺失都要有明确语义。
10. **不伪造执行。** execute 阶段只能读真实 executor 会话/证据，不能用模型生成的结果替代执行事实。
11. **不引入 Harness 核心依赖。** 新能力进入 `src/runtime/`、`src/web/` 或端口层；`@deepseek-ai/*` 只在适配层。
12. **每个阶段先失败测试，后实现，最后全量验证。**

---

## 1. 长期路线总览

| 阶段 | 名称 | 目标 | 是否允许改变公共模型 | 完成门槛 |
|---|---|---|---|---|
| L0 | 当前分支收口 | 把现有 UI、编辑/移除、诊断、测试和远端状态收干净 | 允许修当前契约，不新增大模型 | 工作区干净、远端同步、全量通过 |
| L1 | Pipeline / Revision / Run 模型 | 建立最终事实模型，兼容旧 manifest/checkpoint | **是，必须迁移设计先行** | contract test + 迁移/回滚演练 |
| L2 | 运行历史与证据血缘 | 一条流水线支持多次 run，产物不可覆盖，支持比较 | 是 | 两次运行可追溯、可比较、可恢复 |
| L3 | 多人协作与审批中心 | 用户、角色、待办、认领、评论、通知、审计 | 是 | 多 actor 并发/越权/裁决测试 |
| L4 | 外部后端与 worker 化 | PostgreSQL + Object Store + Queue/Worker | 是 | file/external contract 双实现，多进程恢复 |
| L5 | 平台生态 | provider、解析器、模板、知识库、用例库、SDK、专家包 | 是 | 插件隔离、版本兼容、回归套件 |

**强制顺序：**

```text
L0 → L1 → L2 → L3 → L4 → L5
```

L3 的多人协作可以在 L2 的基础模型稳定后并行设计，但不能在 L1 模型未冻结前大规模做权限 UI。

---

## 2. L0：当前分支收口（先做，不得跳过）

### 2.1 目标

在进入 Revision/Run 重构之前，先把当前分支的工作状态收干净。当前本地可能领先远端，且近期有 UI/编辑/移除改动；DeepSeek **必须以执行时实际状态为准**，不能假设本任务书生成时的引用仍然有效。

### 2.2 执行步骤

```bash
cd /Users/zhangzhixiong/Downloads/harness/test-platform-design
git status --short
git log --oneline -8
git rev-parse HEAD
git rev-parse origin/main
```

然后：

1. 先确认当前未提交修改属于哪一组：
   - UI 菜单/右侧列表/通用配置；
   - 编辑/移除 service/API；
   - 诊断接口/CLI；
   - 运行期异常落盘；
   - 文档/测试计数。
2. 不得把互不相关的半成品混成一个“远期重构”提交。
3. 当前 UI 必须保持以下结构：

```text
左侧一级菜单
├── 通用配置
└── 流水线列表

右侧内容
├── 通用配置面板
├── 流水线列表面板
└── 流水线详情面板
```

4. 当前列表语义必须明确：
   - sidebar 只显示“流水线列表”菜单项，不显示流水线条目；
   - 点击菜单项，右侧显示列表；
   - 点击右侧列表中的具体流水线，右侧切换到详情；
   - 详情返回列表，不回到 sidebar 条目列表；
   - 右上角只保留“新建流水线”，不要再放“流水线列表”重复入口；
   - 通用配置菜单项点击后，右侧显示通用配置；
   - 流水线 ID 只能在新建/编辑流水线对话框中出现，不得出现在通用配置面板。

5. 编辑/移除的当前语义必须明确：
   - edit：修改运行参数，不修改作用域，不自动重入；
   - remove：只摘索引，数据保留，返回 `dataRetained: true`；
   - edit 要有 `operator` 权限；remove 要有 `admin` 权限；
   - 有运行锁时 edit/remove 返回 `conflict`；
   - 编辑与移除都写审计事件。

### 2.3 L0 验收（**已全部完成**）

- [x] `tsc --noEmit` 通过；
- [x] `tsc -p tsconfig.build.json` 通过；
- [x] 全量测试通过（**928/928 pass、0 fail、0 skipped**）；
- [x] `test/web-ui-contract.test.ts` 通过（14/14）；
- [x] 真实 Web 服务返回的 HTML 中：sidebar 没有流水线条目、右侧有列表表格；
- [x] UI 相关修改先给用户预览，用户确认后才能 commit/push；
- [x] `HEAD == origin/main`；
- [x] 工作区干净。

### 2.4 L0 执行记录（证据）

执行时间：2026-09-29。收口提交：`5f84871`、`233832d`、`4bfd663`（均已推送）。

```text
tsc --noEmit                      OK
tsc -p tsconfig.build.json        OK
test/web-ui-contract.test.ts      14/14 pass
test/web-pipeline-edit.test.ts     9/9  pass
node --test                       928/928 pass、0 fail、0 skipped
```

真实服务 HTML 结构核验（**17/17 PASS**）：

```text
sidebar 无输入框 / 不含流水线条目 / 有「通用配置」「流水线列表」两个菜单项
右侧：通用配置面板（恰好 6 个输入，不含流水线 ID）/ 流水线列表表格 / 详情工作区
右上角：['暂停自动刷新', '立即刷新', '＋ 新建流水线']（无重复的「流水线列表」入口）
详情页：有「编辑参数 / 移除」
标签配平：section 8/8、aside 1/1、nav 2/2、table 1/1、ul 1/1、details 1/1、dialog 2/2、form 2/2
```

**核验中修掉一个真实缺口**（记入 `4bfd663`）：

`PATCH /api/pipelines/:id` 此前会**静默忽略**不可编辑字段 ——
`{"projectId":"other"}` 返回 `200 {"changedFields":[]}`。事实确实没被改（符合"作用域不可编辑"），
但调用方会**以为改成功了**，这违反 §0.3 第 9 条"不静默降级"，也让 §2.2 第 5 条的"语义必须明确"不成立。

修法：`web-app/server.mjs` 增加 `EDITABLE_PATCH_FIELDS` 白名单，白名单外的字段一律
`400 invalid-request`（`details` 带 `unknown` / `editable` / `hint`）。
新增 e2e 用例「验收11」钉住；真实服务复验：可编辑字段 200、`projectId` 400、
未知字段 400、拒绝后 `projectId` 事实未变。

**L0 遗留（转 L1）**：`EDITABLE_PATCH_FIELDS` 与 `pipeline-run-service.ts` 的
`EDITABLE_MANIFEST_FIELDS` 是两处定义，目前没有自动校验二者同步的机制
（与 `AuditEventKind` vs `AUDIT_EVENT_KINDS` 是同类陷阱）。

**L0 不做：** Revision/Run 重构、PostgreSQL、worker、多用户、计费。

---

## 3. L1：Pipeline / Revision / Run 最终事实模型

这是远期最重要的一阶段。没有 L1，后面的编辑、多次运行、结果比较、外部后端都会不断返工。

### 3.1 最终对象模型

```text
Pipeline
  └── Revision 1
       ├── Run 1
       │    ├── StageAttempt receive
       │    ├── StageAttempt analyze
       │    └── Artifact / GateTask / Evidence / Usage
       └── Run 2
            ├── StageAttempt receive
            └── ...

Pipeline
  └── Revision 2
       └── Run 3
```

### 3.2 Pipeline 身份模型

建议类型：

```ts
interface PipelineRecord {
  readonly pipelineId: string
  readonly tenantId: string | null
  readonly projectId: string
  readonly displayName?: string
  readonly createdAt: number
  readonly updatedAt?: number
  readonly deletedAt?: number
  readonly activeRevisionId?: string
}
```

硬约束：

- `pipelineId` 创建后不可改；
- `tenantId`/`projectId` 不允许 edit；
- `deletedAt` 是软删除，不等于物理删除；
- 列表默认隐藏 `deletedAt !== undefined`；
- admin 可查 archived/removed 记录；
- 普通调用者访问已移除流水线继续按存在性隐藏策略返回 `not-found`。

### 3.3 Revision 配置快照模型

```ts
interface PipelineRevision {
  readonly revisionId: string
  readonly pipelineId: string
  readonly revisionNumber: number
  readonly createdAt: number
  readonly createdBy: string
  readonly status: 'active' | 'superseded' | 'archived'

  readonly requirementInput?: string
  readonly providerName?: string
  readonly targetBaseUrl?: string
  readonly rulesetVersion: string
  readonly maxGateRetries?: number
  readonly gateWaitTimeoutMs?: number
  readonly gateTaskTtlMs?: number
  readonly diagCredentials?: readonly string[]

  /** 配置快照的稳定摘要，供 run 与审计绑定。 */
  readonly fingerprint: string
}
```

硬约束：

1. Revision 创建后不可变；
2. edit 不覆盖旧 revision，而是创建新 revision；
3. 任何 Run 必须绑定 `revisionId`；
4. `apiKey` 及凭据值绝不进入 revision；
5. `diagCredentials` 只允许环境变量名，不允许值；
6. `targetBaseUrl` 在创建 revision 时做 SSRF 校验；
7. provider 能力在启动/run preflight 时再次校验；
8. revision fingerprint 覆盖所有会改变运行行为的字段。

### 3.4 Run 执行模型

```ts
interface PipelineRun {
  readonly runId: string
  readonly pipelineId: string
  readonly revisionId: string
  readonly attempt: number
  readonly status:
    | 'queued'
    | 'running'
    | 'waiting-human'
    | 'completed'
    | 'failed'
    | 'rejected'
    | 'cancelled'
    | 'gate-failed'
    | 'review-failed'
  readonly cursor: number
  readonly createdAt: number
  readonly startedAt?: number
  readonly finishedAt?: number
  readonly failure?: {
    readonly code: string
    readonly detail: string
    readonly stageId?: string
    readonly at: number
  }
}
```

并发策略：

- 同一 `pipelineId` 同时最多一个 active Run；
- 历史 Run 可以有多个；
- 运行锁的兼容阶段可以仍用 `pipelineId`，但新模型要明确“锁保护 active run”；
- 不允许两个 Run 同时修改同一份 checkpoint；
- 同一次重试是同一个 `runId` 的新 `attempt`，还是新 `runId`，必须固定语义：
  - 建议：用户点击“重新运行”产生新 `runId`；
  - 同一 Run 内部的阶段重试仍使用同一个 `runId` + `attempt`。

### 3.5 兼容当前数据

当前结构类似：

```text
pipelines/<pipelineId>.json
checkpoints/<pipelineId>/checkpoint.json
artifacts/<pipelineId>/<stageId>.json
```

L1 不能直接删旧结构。迁移建议：

```text
旧 manifest + checkpoint
  → PipelineRecord(pipelineId)
  → PipelineRevision(revision-1)
  → PipelineRun(run-1)
  → 原有 checkpoint/artifact 通过 legacy locator 读取
```

迁移原则：

- 先读旧格式，后写新格式；
- 同一数据根允许新旧格式并存；
- 每次迁移写 `migration-needed` / `migration-completed` 审计事件；
- 迁移失败保留旧数据，不覆盖；
- 任何自动迁移都要先备份；
- 回滚时旧版本仍能读取旧结构；
- 不把一次迁移写成“没有迁移风险”。

### 3.6 L1 API

建议新增/调整：

```text
GET    /api/pipelines
POST   /api/projects/:projectId/pipelines
GET    /api/pipelines/:pipelineId
PATCH  /api/pipelines/:pipelineId              # 创建新 revision，不覆盖旧 run
DELETE /api/pipelines/:pipelineId              # 软删除/摘索引
POST   /api/pipelines/:pipelineId/restore      # admin 恢复软删除
GET    /api/pipelines/:pipelineId/revisions
GET    /api/pipelines/:pipelineId/revisions/:revisionId
POST   /api/pipelines/:pipelineId/runs         # 基于指定/当前 revision 创建新 run
GET    /api/pipelines/:pipelineId/runs
GET    /api/runs/:runId
POST   /api/runs/:runId/run
POST   /api/runs/:runId/cancel
```

兼容策略：

- 现有 `POST /api/pipelines/:id/run` 暂时保留，内部转换为“使用 active revision 创建/触发 run”；
- 现有 `GET /api/pipelines/:id` 暂时保留，返回 active run 的兼容视图；
- 新客户端使用 `runId`；旧客户端继续使用 `pipelineId`；
- 兼容字段不能覆盖新字段：`pipelineId` 是身份，`runId` 是运行实例。

### 3.7 L1 测试要求

必须新增：

```text
test/pipeline-revision-contract.test.ts
test/pipeline-run-contract.test.ts
test/pipeline-migration.test.ts
test/pipeline-legacy-compat.test.ts
```

失败路径至少包括：

- 不允许改变 pipelineId；
- 不允许改变 projectId/tenantId/configRef；
- revision fingerprint 不一致时不能静默复用；
- 旧 manifest 能读成 revision-1；
- 迁移中断后可重试；
- 迁移中断不删除旧数据；
- 一个 pipeline 多次 run 互不覆盖；
- 两个 active run 并发时只有一个成功；
- 旧 API 与新 API 读取同一事实；
- 删除后普通读取隐藏、admin 可恢复；
- 删除不物理删除审计/证据。

### 3.8 L1 的执行进度与落地证据

**本节只放指针**，细节与证据一律写在 `docs/19`（那里才是设计与执行记录的唯一出处，
避免同一件事在两份文档里各说一套）：

| 阶段 | 状态 | 证据位置 |
|---|---|---|
| L1a（类型 + locator + 只读兼容） | ✅ 完成 | `docs/19` §8「L1a 执行记录」 |
| L1b（双写 + 惰性迁移 + 迁移诊断） | ✅ 完成 | `docs/19` §8「L1b 执行记录」 |
| L1c（切事实来源 + 搬 run 检查点 + 拆锁） | ⬜ 未开始 | `docs/19` §8「L1c」 |

**上表里"完成"的含义**是"该阶段自定的交付项与承诺性断言全部达成"，**不是**"L1 的
§3.7 清单全部做完"。§3.7 里"多次 run 互不覆盖""两个 active run 并发"两条按 `docs/19`
的划分属 L1c（需要 run 级检查点与 pipeline 级锁），**尚未达成**——
如实留在这里，不用"看起来像做了"的占位测试充数。

实际新增的测试文件（命名与 §3.7 的建议不同，理由写在 `docs/19` §7）：

```text
test/pipeline-model-l1a.test.ts       26 项  L1a：模型不变量 / 指纹 / 投影 / 路径
test/pipeline-l1a-service.test.ts      8 项  L1a：两个只读端点的承诺性断言
test/pipeline-l1b-migration.test.ts   13 项  L1b：双写 / 迁移 / 迁移诊断 / 并发
```

---

## 4. L2：运行历史、阶段尝试与证据血缘

### 4.1 目标

解决当前系统的核心历史问题：同一个 pipeline 的下一次运行不能覆盖上一次的产物、用量和执行证据。

### 4.2 目录/存储目标结构

建议目标结构：

```text
<dataRoot>/
  pipelines/<pipelineId>.json
  pipelines/<pipelineId>/
    revisions/<revisionId>.json
    runs/<runId>.json
    runs/<runId>/checkpoint.json
    runs/<runId>/stages/<stageId>/attempts/<attempt>/state.json
    runs/<runId>/artifacts/<stageId>.json
    runs/<runId>/evidence/<caseId>/...
    runs/<runId>/usage.jsonl
    runs/<runId>/events.jsonl
    audit.jsonl
```

不要一步重命名所有旧路径。先建立统一 locator：

```ts
pipelineRecordPath(pipelineId)
revisionPath(pipelineId, revisionId)
runPath(runId)
checkpointPath(runId)
artifactPath(runId, stageId)
evidencePath(runId, caseId)
```

所有入口必须调用 locator，禁止自行拼接路径。

### 4.3 产物不可变规则

- 一个 `Artifact` 绑定 `runId + revisionId + stageId + attempt`；
- 写入后 digest 不变；
- 重跑产生新 attempt 或新 run，不覆盖旧文件；
- gate task 必须绑定 artifact digest；
- 人工批准必须对应具体 digest；
- 若 digest 变化，旧批准自动失效，不能继续消费；
- UI 显示“当前产物”和“历史产物”两个概念。

### 4.4 Run 对比能力

新增只读接口：

```text
GET /api/pipelines/:pipelineId/runs/compare?left=<runId>&right=<runId>
```

返回：

```ts
interface RunComparison {
  readonly pipelineId: string
  readonly leftRunId: string
  readonly rightRunId: string
  readonly changedStages: readonly string[]
  readonly artifactChanges: readonly {
    readonly stageId: string
    readonly leftDigest: string | null
    readonly rightDigest: string | null
  }[]
  readonly executionChanges: readonly {
    readonly caseId: string
    readonly leftStatus: string | null
    readonly rightStatus: string | null
    readonly leftEvidence: string | null
    readonly rightEvidence: string | null
  }[]
  readonly usageDelta: unknown
}
```

### 4.5 L2 UI

流水线详情增加二级导航：

```text
流水线详情
├── 当前运行
├── 运行历史
├── 版本历史
├── 结果比较
├── 人工门
├── 产物
├── 执行证据
└── 审计
```

### 4.6 L2 验收

- 同一 pipeline 至少两次 run；
- 两次 run 的产物互不覆盖；
- 旧 run 在新 revision 创建后仍可读取；
- gate task 不可批准旧 digest 以推进新 run；
- execute 证据能定位到 runId；
- usage 能按 run 聚合，也能按 pipeline 汇总；
- 比较接口只读，不改变任何状态；
- 进程重启后历史完整；
- 旧 API 仍能读 active run。

---

## 5. L3：多人协作与审批中心

### 5.1 目标

从“单机 operator 自己点按钮”升级为多人协作：

```text
用户
  → 角色
  → 租户
  → 项目
  → 流水线
  → 运行
  → 门任务
```

### 5.2 权限模型

最低角色：

```text
viewer
operator
reviewer
admin
owner（可选，项目级）
```

权限矩阵必须写成代码与测试，不只写文档：

| 动作 | viewer | operator | reviewer | admin |
|---|---:|---:|---:|---:|
| 看列表 | ✅ | ✅ | ✅ | ✅ |
| 看详情/产物 | ✅ | ✅ | ✅ | ✅ |
| 创建流水线 | —/按项目 | ✅ | ✅ | ✅ |
| 编辑参数 | — | ✅ | ✅ | ✅ |
| 认领门 | — | — | ✅ | ✅ |
| 裁决门 | — | — | ✅ | ✅ |
| 重入 | — | ✅ | ✅ | ✅ |
| 取消运行 | — | ✅ | ✅ | ✅ |
| 移除/恢复 | — | — | — | ✅ |
| 诊断 | — | ✅ | ✅ | ✅ |
| 永久清理 | — | — | — | 单独高危权限 |

### 5.3 审批中心

新增页面/接口：

```text
GET /api/gates?assignee=me&status=pending
GET /api/gates/my-tasks
POST /api/gates/:id/claim
POST /api/gates/:id/decide
```

UI 必须显示：

- 项目 / pipeline / run / revision；
- 阶段；
- artifact digest；
- 机器违规；
- review findings；
- 真实执行证据摘要；
- 认领人；
- 租约剩余时间；
- 变更说明；
- 决策历史。

### 5.4 并发规则

- claim 使用 CAS；
- decide 使用 `expectedUpdatedAt`；
- 幂等使用 `decisionId`；
- 已消费裁决不可重复推进；
- 失败请求不能留下租约；
- 越权请求不能泄露任务存在性；
- viewer 不能通过请求头伪造 reviewer/admin。

### 5.5 L3 验收

- 4 个真实进程并发认领/裁决；
- 跨租户列表/详情/门任务隐藏；
- operator 不能裁决；
- reviewer 不能移除；
- admin 可以恢复软删除；
- 审计记录包含 actor、时间、pipeline、run、revision、task、digest；
- 通知失败不回滚业务事实；
- 页面刷新后待办状态来自服务端。

---

## 6. L4：外部后端与 worker 化

### 6.1 目标

只有 L1/L2 模型稳定后才做生产化后端：

```text
Web API
  → PostgreSQL（事务事实）
  → Queue
       → Worker
            → PipelineDriver
            → Object Store（产物/证据）
```

### 6.2 后端职责

| 事实 | 目标后端 |
|---|---|
| Pipeline / Revision / Run | PostgreSQL |
| Checkpoint CAS | PostgreSQL |
| GateTask / Lease / Decision | PostgreSQL |
| Idempotency records | PostgreSQL |
| Audit | PostgreSQL append-only 表或事件表 |
| Lock | PostgreSQL advisory lock / lease |
| Artifact | Object Store |
| Executor evidence | Object Store |
| Usage | PostgreSQL 或 append-only event store |
| 大型报告 | Object Store |

### 6.3 事务边界

必须先落实 ADR，再写实现：

1. checkpoint CAS：按 `runId + revision` 做条件更新；
2. gate decision：条件更新，0 行即冲突；
3. idempotency：先写者胜，首次结果可重放；
4. artifact → checkpoint：产物先写，检查点后写；
5. artifact 写成功、checkpoint 写失败：恢复扫描必须能发现 orphan artifact；
6. usage 与 audit 失败处理分开：usage 可尽力而为，audit 要明确是否强制；
7. Object Store key 不允许跨项目/跨 run 越界；
8. PostgreSQL 不存 API Key、prompt、响应正文。

### 6.4 Worker 语义

Worker 必须做到：

- 从持久化 queue claim 任务；
- 用租约防止两个 worker 同时运行同一 run；
- 心跳续租；
- worker 崩溃后可恢复；
- 结果未知时不盲目重发 executor 请求；
- 运行身份不带 reviewer/admin 角色；
- worker 只调用 service/driver，不绕过端口；
- 运行期失败写入持久化 Run failure；
- 完成后释放租约并写 run-settled。

### 6.5 迁移顺序

```text
文件后端诊断
  → 文件数据备份
  → 导出 Pipeline/Revision/Run
  → 导入 PostgreSQL
  → 上传 Artifact/Evidence
  → 双读校验
  → 单写切换
  → 旧文件只读保留
  → 回滚窗口结束后再清理
```

禁止：

- 一次迁移直接删旧文件；
- 只迁移 checkpoint 不迁移 audit/usage；
- 只迁移文件不迁移 revision/run 关系；
- 外部后端失败时静默回退本地盘；
- 用 SQLite 冒充多副本生产后端。

### 6.6 L4 验收

- file 与 external backend 共用同一 contract test；
- 多进程 CAS；
- 多 worker lease；
- worker kill/restart；
- migration interrupted/resume/rollback；
- artifact orphan 诊断；
- 审计链连续；
- 数据根中不存在第二份幂等台账；
- Web/CLI/worker 读同一事实。

---

## 7. L5：平台生态

L5 只能在 L1/L2/L4 稳定后进入。

### 7.1 Provider 插件

```ts
interface ProviderAdapter {
  readonly providerId: string
  readonly capabilities: readonly string[]
  validate(config: unknown): Promise<void>
  createClient(input: ProviderClientInput): LlmClient
}
```

约束：

- adapter 不把凭据返回给 Web；
- provider 能力在启动与运行前校验；
- provider 不改变六阶段规则；
- provider 错误映射为固定错误码；
- provider 包不进入核心默认入口。

### 7.2 文档解析插件

继续使用注册表：

```text
defaultParserRegistry()
  → Markdown / CSV / TSV / TXT / YAML / JSON
  → PDF / DOCX / XLSX
  → 可选第三方 parser
```

每个 parser 必须提供：

- format；
- magic bytes/扩展名判定；
- 字节/页数/单元格限制；
- 超时与取消；
- 路径安全；
- 结构化诊断；
- 不回传原始字节。

### 7.3 模板、知识库、用例库

- 模板版本化；
- 知识条目有 draft/reviewed/active；
- 用例有版本与来源；
- 归档写入需要人工门；
- query 只读；
- 冲突必须显式呈现；
- 不让模型直接把结果写成 active。

### 7.4 SDK / Expert / Connector

最终对外能力可以是：

```text
platform-pipeline/core
platform-pipeline/web
platform-pipeline/cli
platform-pipeline/harness
platform-pipeline/plugin-sdk
```

但 SDK 发布前必须完成：

- 稳定类型；
- 版本兼容策略；
- 错误码文档；
- 安全边界；
- 最小示例；
- 不能把内部路径与文件布局当公共 API。

---

## 8. DeepSeek 固定执行协议

### 8.1 每次开工前

```bash
cd /Users/zhangzhixiong/Downloads/harness/test-platform-design
git status --short
git log --oneline -8
git rev-parse HEAD
git rev-parse origin/main
```

如果 `HEAD != origin/main`：

- 先说明 ahead/behind；
- 不在错误基线上继续新功能；
- 先同步或明确用户授权。

### 8.2 每个阶段的固定顺序

```text
读设计文档
  → 读端口与现有实现
    → 写失败测试
      → 最小实现
        → 专项测试
          → typecheck
            → build
              → 全量测试
                → Web e2e（若改 Web）
                  → 文档回填
                    → 给用户预览
                      → 用户确认后 commit
                        → push
```

### 8.3 验证命令

```bash
cd /Users/zhangzhixiong/Downloads/harness/test-platform-design/packages/platform-pipeline

NODE_OPTIONS="--max-old-space-size=6144" ./node_modules/.bin/tsc --noEmit
NODE_OPTIONS="--max-old-space-size=6144" ./node_modules/.bin/tsc -p tsconfig.build.json
NODE_OPTIONS="--max-old-space-size=6144" /usr/local/bin/node --test
```

如果改了 `src/web/` 或 `web-app/`：

```bash
NODE_OPTIONS="--max-old-space-size=6144" /usr/local/bin/node --test test/web-http.test.ts
```

本地 HTTP 冒烟：

```bash
curl --noproxy '*' http://127.0.0.1:3080/health
```

### 8.4 提交纪律

每个阶段结束前必须给用户看：

- 改动的文件；
- UI 预览（如果改 UI）；
- API/落盘变化；
- 测试结果；
- 未完成项；
- 是否可以提交。

**用户没有确认前，不得 commit/push。**

### 8.5 Commit 模板

提交正文必须回答：

1. 改了哪些文件？
2. API、状态、路径、落盘字段有什么变化？兼容策略是什么？
3. 是否新增 Harness/运行时依赖？
4. 是否改变自动批准、越权、凭据、审计行为？负向测试是什么？
5. 新增哪些失败路径测试？
6. typecheck/build/test 的实际 pass/fail/skip？
7. Web/CLI/重启/worker 是否读同一份事实？
8. 未完成项、竞态、迁移、回滚风险？

### 8.6 禁止事项

- 不要直接删除个人目录或数据根；
- 不要用 `rm -rf` 清理业务数据；
- 不要用浏览器缓存保存运行状态；
- 不要增加一个内存 Map 作为第二份 pipeline 状态；
- 不要在编辑时自动批准/自动重入；
- 不要在移除时悄悄物理删除审计；
- 不要把旧 artifact 覆盖成新 run artifact；
- 不要把 `runId` 与 `pipelineId` 混为一谈；
- 不要把 provider 错误塞成 `failed` 而不提供 code/detail；
- 不要把存储故障伪装成空列表；
- 不要把 SQLite 当多副本生产后端；
- 不要把真实模型调用作为单元测试前置；
- 不要为了让测试变绿而降低安全规则；
- 不要删测试、skip 测试、放宽断言；
- 不要未经用户确认 commit/push。

---

## 9. 远期完成判定

### L1 完成

- [ ] Pipeline / Revision / Run 类型已冻结；
- [ ] 旧数据可读；
- [ ] 迁移可中断/恢复/回滚；
- [ ] edit 创建新 revision；
- [ ] run 绑定 revision；
- [ ] 旧 artifact 不被覆盖；
- [ ] 新旧 API 兼容；
- [ ] contract test 全绿。

### L2 完成

- [ ] 同一 pipeline 支持多次 run；
- [ ] 每次 run 有独立产物/用量/证据；
- [ ] digest 与 gate task 绑定；
- [ ] 支持 run comparison；
- [ ] 运行历史重启后可读。

### L3 完成

- [ ] 角色矩阵落代码；
- [ ] 多 actor 越权测试；
- [ ] 审批中心；
- [ ] 并发 claim/decide；
- [ ] 通知失败不影响事实；
- [ ] 审计可查询。

### L4 完成

- [ ] PostgreSQL 真实 CRUD/事务/CAS；
- [ ] Object Store 真实读写；
- [ ] Queue/Worker 可恢复；
- [ ] file/external contract 相同；
- [ ] 迁移与回滚演练；
- [ ] 多副本共享幂等、锁、审计。

### L5 完成

- [ ] provider adapter；
- [ ] parser registry 扩展；
- [ ] 模板/知识库/用例库版本化；
- [ ] plugin SDK；
- [ ] Expert/Connector 集成边界；
- [ ] 公共 API 与版本策略冻结。

---

## 10. 最终建议

现在不要直接做 PostgreSQL，也不要继续零散加 UI 按钮。

**下一轮真正的第一件事是 L0 收口，然后进入 L1：Pipeline / Revision / Run。**

推荐实现顺序：

```text
L0 当前分支收口
  → Pipeline/Revision/Run 类型与迁移设计
    → 新运行历史
      → 证据与产物血缘
        → 多人协作
          → PostgreSQL/Object Store/Worker
            → 插件与生态
```

如果 DeepSeek 只能先执行一件事，就执行：

> **先建立不可变的 Revision + Run 模型，并保持旧 API/旧数据可读；不要继续在单一 manifest/checkpoint 上堆功能。**
