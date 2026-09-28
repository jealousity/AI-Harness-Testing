# Web API 与状态契约（W0 冻结稿）

> **本文件是 `docs/14-web-single-node-productization-plan.md` W0 阶段的交付物。**
>
> 用途：在改任何 Web 代码之前，把**当前真实存在**的 API、状态模型、字段与状态码冻结下来，
> 作为 W1~W6 的对照基准。**本文件只描述现状，不描述期望。** 计划新增/变更的部分集中在
> §9，并明确标注"未实现"。

冻结基线：

| 项 | 值 |
|---|---|
| 仓库 | `/Users/zhangzhixiong/Downloads/harness/test-platform-design` |
| 提交 | `1cefce7`（`HEAD == origin/main`） |
| 测试基线 | `node --test` 824/824 pass、0 fail、0 skip |
| 契约源 | `packages/platform-pipeline/src/web/pipeline-run-types.ts` |
| 路由源 | `web-app/server.mjs` 的 `ROUTES` |
| 服务源 | `packages/platform-pipeline/src/web/pipeline-run-service.ts` |

---

## 1. 分层与责任边界

```text
浏览器（web-app/public/*）
  │  只渲染服务端字段，不在浏览器推断状态
  ▼
HTTP 外壳（web-app/server.mjs）
  │  只做：路由、鉴权入口、参数解析、响应映射
  ▼
FilePipelineRunService（src/web/pipeline-run-service.ts）
  │  作用域校验、配置解析、装配宿主、调用 driver、映射结果
  ▼
PipelineDriver（src/driver.ts）
  │  六阶段编排 + 机器门禁 + 审核 + 人工门
  ▼
StoragePorts（backend.ports）
     检查点 / 产物 / 任务 / 门任务 / 用量 / 审计 / 锁 / records
```

**硬边界**：`server.mjs` 不得包含任何阶段逻辑；不得直接改检查点或门任务 JSON；
不得自行拼 `artifacts/`、`checkpoints/`、`gates/`、`tasks/` 路径。

---

## 2. 身份与作用域

```ts
type ActorRole = 'viewer' | 'reviewer' | 'operator' | 'admin'

interface ActorContext {
  readonly actorId: string
  readonly tenantId?: string
  readonly roles?: readonly ActorRole[]
  readonly projectIds?: readonly string[]
}
```

角色门槛（失败关闭，缺角色即拒绝）：

| 动作 | 要求 | 断言函数 |
|---|---|---|
| `claimGate` / `decideGate` | `reviewer` 或 `admin` | `assertGateRole` |
| `reenter` / `cancelGate` / 取消运行 | `operator` 或 `admin` | `assertOperatorRole` |
| `POST /api/admin/recover` | `admin` | `assertAdminRole` |

作用域规则：

1. `pipelineId` 是**唯一入口**：由它从流水线索引反解 `tenantId` / `projectId` / `configRef`；
2. 请求体里自报的 `projectId` **不决定作用域**，只用于调用方自查；
3. `assertScope` 只比较 `projectId` + `tenantId`；**`scope.environment` 不参与比较**
   （它是部署维度，`ActorContext` 从不携带它）；
4. 跨作用域读取与"不存在"**返回同一状态码**（防枚举），消息只回显调用者自己的作用域；
5. 后台运行身份 `RUNNER_ACTOR` **刻意不声明任何角色**——"后台不得替人裁决"是机器保证。

---

## 3. 六阶段与状态模型

### 3.1 阶段顺序与上游

```ts
const STAGE_ORDER = ['receive', 'analyze', 'design', 'execute', 'report', 'archive'] as const

const STAGE_UPSTREAMS = {
  receive: [],
  analyze: ['receive'],
  design: ['analyze'],
  execute: ['design'],
  report: ['execute'],
  archive: ['receive', 'analyze', 'design', 'execute', 'report'],
}
```

### 3.2 阶段状态（`CheckpointStatus`）

```ts
type CheckpointStatus =
  | 'idle' | 'running' | 'produced' | 'needs-fix'
  | 'gate-failed' | 'review-failed' | 'awaiting-gate' | 'done' | 'needs-reentry'
```

### 3.3 流水线状态（`PipelineRunStatus`）

```ts
type PipelineRunStatus =
  | 'queued' | 'running' | 'waiting-human' | 'needs-fix'
  | 'gate-failed' | 'review-failed' | 'rejected' | 'completed' | 'failed' | 'cancelled'
```

### 3.4 人工门任务状态（`HumanGateTaskStatus`）

```ts
type HumanGateTaskStatus =
  | 'pending' | 'claimed' | 'approved' | 'changes-needed'
  | 'rejected' | 'expired' | 'cancelled'
```

**两种任务必须区分**（当前代码已如此，UI 尚未区分——见 W-04）：

| 种类 | 产生者 | `artifactPath` | `machineStatus` | 能否被当作阶段批准 |
|---|---|---|---|---|
| **阶段门任务** | 阶段推进到人工门 | 非空（对应产物） | `passed` | 能 |
| **升级任务** | `human.gateFailed`（机器门禁失败/预算超限） | `''`（空） | `failed` | **永远不能**（`findResumableTask` 要求 `artifactPath` 一致且 `machineStatus=passed`） |

### 3.5 事件类型（`PipelineEventKind`）

```ts
type PipelineEventKind =
  | 'gate-opened' | 'gate-claimed' | 'gate-decided'
  | 'gate-cancelled' | 'gate-consumed' | 'stage-failure' | 'reenter'
```

`at` **一律来自持久化时间戳**，不是服务端观测时间；重启后同一流水线的事件流顺序与时间一致。

### 3.6 流转规则（不可违反）

1. 阶段顺序固定，不得跳过；
2. 人工门**绝不由超时、异常或轮询自动批准**；
3. 裁决只写**裁决事实**，必须由**下一次 `run` 消费**才推进阶段；
4. `changes-needed` / `rejected` / 取消必须带非空说明（`invalid-request`，且在 `claim` 之前校验）；
5. 机器门禁失败 → `gate-failed` 终态 + 升级任务；**不重试**（同一份预算再跑只会再烧一次模型）；
6. 审核重试耗尽 → `review-failed` 终态，且重启后**不得再次 spawn**；
7. `execute` 阶段必须用真实执行记录对账（R4-08/09/10），缺数据即阻断，**不伪造**；
8. 重入作废该阶段及下游产物并级联重跑；`expectedCurrentDigest` 不匹配即 `conflict`；
9. 同一流水线同时只有一个后台运行（跨进程运行锁）；抢不到即 `conflict`。

---

## 4. HTTP 接口清单（现状）

`web-app/server.mjs` 的 `ROUTES` 共 **15** 个端点。**全部为已有端点，本轮不新增。**

| # | 方法 | 路径 | 成功码 | 说明 |
|---|---|---|---|---|
| 1 | GET | `/health` | 200 | 健康检查 |
| 2 | GET | `/api/pipelines` | 200 | 枚举调用者可见流水线 |
| 3 | POST | `/api/projects/:projectId/pipelines` | 202 | 创建（不等待完成） |
| 4 | POST | `/api/pipelines/:pipelineId/run` | 202 | 触发后台运行 |
| 5 | POST | `/api/pipelines/:pipelineId/cancel` | 202 | 取消后台运行 |
| 6 | GET | `/api/pipelines/:pipelineId` | 200 | 运行视图 |
| 7 | GET | `/api/pipelines/:pipelineId/gates` | 200 | 门任务列表 |
| 8 | GET | `/api/pipelines/:pipelineId/events` | 200 | 事件时间线 |
| 9 | GET | `/api/pipelines/:pipelineId/usage` | 200 | 用量与预算 |
| 10 | GET | `/api/pipelines/:pipelineId/stages/:stageId/artifact` | 200 / 404 | 阶段产物 |
| 11 | POST | `/api/pipelines/:pipelineId/reenter` | 202 | 登记重入 |
| 12 | POST | `/api/gates/:gateTaskId/claim` | 200 | 认领门任务 |
| 13 | POST | `/api/gates/:gateTaskId/decide` | 200 | 裁决门任务 |
| 14 | POST | `/api/gates/:gateTaskId/cancel` | 200 | 取消门任务 |
| 15 | POST | `/api/admin/recover` | 200 | 恢复扫描（admin） |

静态资源：`GET /` → `index.html`；其它路径按文件名直出，**路径穿越一律 403**。

---

## 5. 请求与响应契约

### 5.1 `GET /health`

```json
{
  "ok": true,
  "app": "harness-web-app",
  "configRef": "default",
  "trustActorHeaders": false
}
```

> **已由 W1 收紧（W-05）**：原响应含 `running: [pipelineId...]`，那是一个**未鉴权**的
> 枚举旁路——本服务其它路径都刻意把"存在但无权限"伪装成 `not-found`，而 `/health`
> 直接把正在运行的 ID 列出来。现已移除。
> 单条流水线的运行状态仍可从 `GET /api/pipelines/:pipelineId` 的 `running` 字段读取
> （已鉴权、已作用域校验），能力没有丢失。
> 回归：`test/web-http.test.ts` 验收10a 断言健康响应**字段集合恰好**为这四个键。

### 5.2 `GET /api/pipelines`

```json
{ "pipelines": [ PipelineRunSummary ] }
```

### 5.3 `POST /api/projects/:projectId/pipelines`

请求体：

```ts
interface CreatePipelineRunInput {
  pipelineId: string                 // 必填
  configRef?: string                 // 只接受服务端配置的 CONFIG_REF
  requirementInput?: string
  providerName?: string
  targetBaseUrl?: string             // 经 SSRF 校验
  rulesetVersion?: string
  maxGateRetries?: number            // 非负整数
  gateWaitTimeoutMs?: number         // 非负整数
  gateTaskTtlMs?: number             // 非负整数
  diagCredentials?: readonly string[]  // env_diag 探针白名单
}
```

响应 `202`：

```ts
interface PipelineRunSummary {
  pipelineId: string
  tenantId: string | null
  projectId: string
  configRef: string
  status: PipelineRunStatus
  nextStage: StageId | null
}
```

**不含 API Key、不含 `dataRoot` 等服务器绝对路径。**

### 5.4 `POST /api/pipelines/:pipelineId/run`

响应 `202`：

```json
{ "pipelineId": "...", "started": true, "reason": "...", "running": true }
```

`started: false` 的 `reason` 形如 `already-running`（已有后台运行）。

**202 只表示"已登记/已触发"，绝不表示阶段完成。**

### 5.5 `POST /api/pipelines/:pipelineId/cancel`

先 `assertOperatorRole`，再 `service.get` 确认作用域（**顺序不能反**，否则 403/404
的差别会泄露存在性）。响应 `202`：

```json
{ "pipelineId": "...", "cancelled": true }
```

### 5.6 `GET /api/pipelines/:pipelineId`

```ts
interface PipelineRunView {
  pipelineId: string
  tenantId: string | null
  projectId: string
  status: PipelineRunStatus
  cursor: number
  nextStage: StageId | null
  templateVersion: string
  rulesetVersion: string
  stages: readonly StageView[]
  openGateTaskId: string | null
  reentries: readonly ReentryRecord[]
  failure: PipelineRunFailure | null
}
```

响应体额外合并运行时字段：`running: boolean`（来自进程内 registry）。

```ts
interface StageView {
  stageId: StageId
  status: CheckpointStatus
  artifactPath: string
  digest: string
  machineStatus: 'passed' | 'failed'
  machineViolations: readonly { rule: string; level: 'BLOCKING' | 'WARNING'; detail: string }[]
  reviewVerdict: string | null
  reviewFindings: readonly string[]
  humanGateTaskId: string | null
  startedAt: number | null
  finishedAt: number | null
  failure: { kind: string; rule: string | null; detail: string | null; at: number } | null
}

interface PipelineRunFailure {
  kind: 'gate-failed' | 'review-failed' | 'rejected' | 'cancelled' | 'error'
  stageId: StageId | null
  detail: string
}
```

字段事实来源（不得由浏览器推断）：

| 字段 | 来源 |
|---|---|
| `stageId` / `status` / `artifactPath` / `digest` | `Checkpoint.stageStates[stageId]` |
| `machineStatus` / `machineViolations` | `StageState.gate.machine` |
| `reviewVerdict` / `reviewFindings` | 该阶段最近一条门任务的 `review` |
| `humanGateTaskId` | 该阶段最近一条**阶段门**任务（排除升级任务） |
| `startedAt` | 该阶段最近一条门任务的 `createdAt` |
| `finishedAt` | `decision.at ?? cancellation.at` |
| `failure` | `StageState.failures` 最后一条 |

`startedAt` / `finishedAt` 在**没有门任务时为 `null`**，不用服务端当前时间冒充。

> **digest 的两种口径（不是 bug）**：driver 只在阶段推进到 `done` 时才把 digest 冻结进
> 检查点；`awaiting-gate` 阶段视图里的 digest 是**回读产物**得到的，因此与检查点里的空值
> 本就不相等。`idle` / `needs-reentry` **不回读**（否则会把已作废的旧产物当成当前版本）。

### 5.7 `GET /api/pipelines/:pipelineId/gates`

查询参数：`status`（可选，`HumanGateTaskStatus`）。

```json
{ "gates": [ HumanGateTask ] }
```

### 5.8 `GET /api/pipelines/:pipelineId/events`

```json
{ "events": [ PipelineEventView ] }
```

```ts
interface PipelineEventView {
  kind: PipelineEventKind
  at: number
  stageId: StageId | null
  gateTaskId: string | null
  actorId: string | null
  detail: string
}
```

### 5.9 `GET /api/pipelines/:pipelineId/usage`

返回 `UsageSummary`（`used` / `limit` / `exceeded` / `budgetFailures` / `skippedLines` /
`totals`）。事实来自**持久化用量日志 + 检查点重试事实**，因此 Web 与 CLI 结论一致。

### 5.10 `GET /api/pipelines/:pipelineId/stages/:stageId/artifact`

`200` → `StageArtifactView`；尚未产出 → **`404`**（不是空对象）。

```ts
interface StageArtifactView {
  pipelineId: string
  stageId: StageId
  artifactPath: string   // 相对产物根，不泄露部署布局
  digest: string
  version: number
  inputs: InputLocks
  content: unknown
}
```

### 5.11 `POST /api/pipelines/:pipelineId/reenter`

请求体：`{ stageId, reason, expectedCurrentDigest? }`。响应 `202`：

```json
{ "pipelineId": "...", "cursor": 3, "reentries": [...] }
```

`expectedCurrentDigest` 不匹配 → `conflict`(409)。

### 5.12 `POST /api/gates/:gateTaskId/claim`

请求体：`{ pipelineId, ttlMs? }` → `200` + `HumanGateTask`。

### 5.13 `POST /api/gates/:gateTaskId/decide`

请求体：`{ pipelineId, action, note?, decisionId?, expectedUpdatedAt? }`

- `action` **必须显式传入**（不存在"缺省即批准"）；
- `decisionId` 由页面生成、重试沿用同一个 → 重复投递**重放首次裁决结果**，不二次驱动门；
- `expectedUpdatedAt` 提供乐观并发；
- `changes-needed` / `rejected` 必须带非空 `note`，否则 `invalid-request`(400)，
  且**在 claim 之前**返回（不留下租约副作用）。

### 5.14 `POST /api/gates/:gateTaskId/cancel`

请求体：`{ pipelineId, note? }` → `200` + `HumanGateTask`。

### 5.15 `POST /api/admin/recover`

`assertAdminRole` → `200`：`{ "outcomes": [...] }`。每项含
`pipelineId` / `action` / `started` / `detail`。

`decideRecovery(status, hasOpenGateTask)` 是纯函数：

```text
waiting-human + 有未决门 → await-human（不启动）
waiting-human + 无未决门 → resume（去消费裁决）
终态                    → terminal
```

**恢复扫描永不替人裁决。**

---

## 6. 状态码语义（冻结）

| 码 | 含义 | 典型触发 |
|---|---|---|
| `200` | 查询或同步动作成功 | GET 系列、claim/decide/cancel 门 |
| `202` | **请求已登记/后台已触发**，不代表阶段完成 | create、run、cancel、reenter |
| `400` | 请求字段不合法 | 缺 `pipelineId`、非法 `stageId`、`changes-needed` 缺 note |
| `401` | 身份缺失 | 开启 trust headers 但缺 `x-actor-id` |
| `403` | 调用者自身角色/白名单不足 | viewer 裁决、非 operator 重入 |
| `404` | 不存在**或跨作用域隐藏** | 未登记 pipelineId、无权限读取 |
| `409` | 状态冲突 | 并发裁决、digest 过期、`already-running` |
| `422` | 配置非法 | `config-invalid` |
| `500` | 未归类运行期异常 | `run-failed` |
| `503` | 基础设施不可用 | `storage-unavailable`、`provider-unavailable` |

### 6.1 错误码 → HTTP（`PIPELINE_RUN_ERROR_HTTP_STATUS`）

| 错误码 | HTTP |
|---|---|
| `invalid-request` | 400 |
| `unauthenticated` | 401 |
| `forbidden` | 403 |
| `scope-mismatch` | 403 |
| `not-found` | 404 |
| `conflict` | 409 |
| `gate-not-claimable` | 409 |
| `gate-not-decidable` | 409 |
| `gate-consumed` | 409 |
| `config-invalid` | 422 |
| `provider-unavailable` | 503 |
| `storage-unavailable` | 503 |
| `run-failed` | 500 |

### 6.2 错误响应体（冻结形状）

```json
{
  "error": {
    "code": "conflict",
    "message": "可读提示（只含调用者自己的作用域）",
    "details": {},
    "httpStatus": 409
  }
}
```

`details` 经 `redactSecrets` 脱敏（`apiKey` / `authorization` / `bearer` / `token` /
`secret` / `password` / `credential` 命中即整体替换为 `[redacted]`）。

---

## 7. 运行结果类型（`RunResult`）

`POST .../run` 的**同步**返回值（HTTP 层只取 `started/reason`，因为后台运行）：

```ts
type RunResult =
  | { outcome: 'completed';      view: PipelineRunView }
  | { outcome: 'waiting-human';  stageId; gateTaskId; view }
  | { outcome: 'rejected';       stageId; view }
  | { outcome: 'gate-failed';    stageId; view }
  | { outcome: 'review-failed';  stageId; view }
  | { outcome: 'cancelled';      view }
  | { outcome: 'failed';         error: PipelineRunErrorView; view }
```

**前置失败抛 `PipelineRunError`；运行期结果由 `RunResult` 返回，不抛异常。**

---

## 8. 不得破坏的不变量（W1~W6 的回归基准）

1. `HEAD == origin/main`、工作区干净才动手；
2. 六阶段顺序与上游关系不变；
3. 人工门不得自动批准；
4. 裁决必须由下一次 `run` 消费；
5. 跨作用域读取与"不存在"同码同形；
6. 错误消息只回显调用者自己的作用域；
7. 返回体与日志不含 API Key；
8. `execute` 缺真实执行数据即阻断，不伪造记录；
9. 同一流水线同时只有一个后台运行；
10. Web / CLI / 重启读写**同一份**持久化事实；
11. `202` 不得被解释为阶段完成；
12. 产物未产出返回 `404`，不返回空对象。

---

## 8.1 W1 落地记录（启动与安全硬化）

| 项 | 落地方式 | 证据 |
|---|---|---|
| 严格数值解析 | 新增 `src/web/server-config.ts` 的 `parseWebServerConfig`；只接受十进制非负整数，`NaN`/小数/科学计数法/十六进制/负数/越界**启动即失败** | `test/web-server-config.test.ts` |
| 请求体上限 | `PLATFORM_MAX_BODY` 经严格解析后注入 `readJsonBody`；`content-length` 与分块累积两条路径都拒绝 | 验收10c + 手工冒烟 |
| `/health` 脱敏 | 只回 `ok`/`app`/`configRef`/`trustActorHeaders` | 验收10a |
| 危险部署组合 | `assertTrustActorHeadersDeployment`：信任请求头 + 非回环 + 未声明 `PLATFORM_TRUSTED_PROXY=1` → 拒绝启动 | 验收10e + 手工冒烟（exit=1） |
| 启动期完整配置校验 | `assertStartupConfigUsable`：阶段 ACL、审批覆盖、规则引用、provider 引用 | `test/web-server-config.test.ts` |
| 启动日志不泄露 | `startupLogLines` 只含监听地址、逻辑 configRef、危险模式警告 | 同文件 |

**新增环境变量**：`PLATFORM_TRUSTED_PROXY`（`'1'` 表示"身份由可信反向代理提供"，
是开启请求头信任且非回环绑定时的**显式表态**）。未设置时该组合拒绝启动。

---

## 9. 本轮计划新增/变更的契约

> 以下为 `docs/14` W1~W3 的计划内容，**冻结稿确认它们尚未存在**。实现时必须
> 先写契约测试，并在本文件对应章节把状态从"计划"改为"已实现 + 提交号"。

| 计划项 | 类型 | 归属阶段 | 状态 |
|---|---|---|---|
| `GET /health` 移除 `running` 字段 | **变更（收紧）** | W1 | ✅ 已实现（`ee0814b`）｜`test/web-http.test.ts` 验收10a |
| 数值环境变量严格校验，非法即启动失败 | 变更 | W1 | ✅ 已实现（`ee0814b`）｜`test/web-server-config.test.ts`（22 项） |
| 非 loopback + trust headers 无可信代理策略时拒绝启动 | 新增 | W1 | ✅ 已实现（`ee0814b`）｜同文件 + 验收10e；新增 `PLATFORM_TRUSTED_PROXY=1` 显式表态 |
| 启动时完成完整配置/ACL/审批覆盖校验 | 变更 | W1 | ✅ 已实现（`ee0814b`）｜`assertStartupConfigUsable`；`web-app/server.mjs` 启动即调用 |
| `PipelineRunView.currentStage` | 新增（派生） | W3 | 未实现 |
| `PipelineRunView.nextAction` | 新增（派生） | W3 | 未实现 |
| `PipelineRunView.blockingReason` | 新增（派生） | W3 | 未实现 |
| `PipelineRunView.gateKind`（`'stage' \| 'escalation' \| null`） | 新增（派生） | W3 | 未实现 |
| `PipelineRunView.stale` | 新增（派生） | W3 | 未实现 |
| `list()` 改用注入的 `indexStore` | **缺陷修复（W-01）** | W2 | 未实现 |
| `records` 缺失时显式区分 legacy fallback 与失败关闭 | 变更 | W2 | 未实现 |
| 索引扫描区分数据损坏与基础设施不可用 | 变更 | W2 | 未实现 |
| 创建过程可恢复状态（`creating` → `ready`） | 新增 | W2 | 未实现 |

**派生字段的硬约束**：`nextAction` / `currentStage` / `blockingReason` / `gateKind`
必须由**服务端**从检查点 + 产物 + 门任务 + 后端状态推导，**不得**由浏览器缓存推断，
也**不得**引入第二份事实来源。

---

## 10. 冻结声明

1. 本文件描述的是 `1cefce7` 时点的**真实实现**，不是期望；
2. W1~W6 期间**不得**在未更新本文件的情况下改动 §4/§5/§6 的任何形状；
3. §9 的每一项在实现完成后必须回填"已实现 + 提交号 + 测试文件"；
4. 若实现中发现规划与本文件冲突，按 `docs/14` §5.1 与约束书 §一.7 **先报告冲突**，
   不得自行选择解释；
5. 本阶段（W0）**不含任何业务代码改动**。
