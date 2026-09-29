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
{ "target": "run", "pipelineId": "...", "cancelled": true }
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

  // W3 新增的**派生**字段（不是落盘事实）
  currentStage: StageId | null
  nextAction: StageAction
  blockingReason: string | null
  gateKind: GateTaskKind | null
}
```

`StageAction = 'run' | 'view-artifact' | 'claim-gate' | 'decide-gate' | 'reenter' | 'retry-storage' | 'none'`
`GateTaskKind = 'stage' | 'escalation'`

**派生规则**（`deriveNextAction`，纯函数，逐行有用例）：

| 状态 | 未决门 | `nextAction` |
|---|---|---|
| `running` | — | `none`（后台运行进行中，此刻没有"正确的人工动作"） |
| `queued` | — | `run` |
| `needs-fix` | — | `run` |
| `waiting-human` | 有（stage 或 escalation） | `decide-gate` |
| `waiting-human` | 无 | `run`（去消费已登记的裁决） |
| `gate-failed` / `review-failed` / `rejected` / `cancelled` / `failed` | — | `reenter` |
| `completed` | — | `view-artifact`（`blockingReason` 为 `null`） |

**三条硬规则**：① 终态永不产出 `decide-gate` / `claim-gate`；② `running` 给 `none`；
③ `claim-gate` 与 `retry-storage` **不由视图派生**（前者因 `decideGate` 自动认领，
后者由 HTTP 层在 503 时使用）。

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
{ "gates": [ GateTaskView ] }
```

`GateTaskView = HumanGateTask & { isEscalation: boolean }` —— 派生字段，**不改落盘形状**。
`isEscalation: true` 表示升级任务（`artifactPath === ''`、`machineStatus === 'failed'`），
**永远不能被当作阶段批准**。`claimGate` / `decideGate` / `cancelGate` 的单条返回同样带它。

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

请求体：`{ pipelineId, note? }` → `200`：

```json
{ "target": "gate", "cancelled": true, "task": GateTaskView }
```

> **W3 变更（破坏性）**：此前直接返回任务本体。两个 cancel 端点现在共用
> `{ target, cancelled, ... }` 形状，页面可以用一套分支渲染"取消后台运行"与
> "撤回人工门任务"这两件不同的事。

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

## 8.3 W3 落地记录（六阶段流转与派生字段）

| 项 | 落地方式 | 证据 |
|---|---|---|
| `nextAction` 映射表 | `deriveNextAction` 纯函数，覆盖 10 个状态 × 3 种门情形 | `test/web-stage-flow.test.ts` |
| `currentStage` | `STAGE_ORDER` 里第一个非 `done` 的阶段；与 `nextStage` 恒等（有用例钉住） | 同文件（逐阶段推进 6 次） |
| `gateKind` | 由未决门的 `artifactPath === ''` 派生 `'stage'` / `'escalation'` | 同文件 |
| `isEscalation` | `toGateTaskView` 派生，四个门任务方法统一返回 | 同文件（含真实预算超限路径） |
| cancel 语义统一 | 两个端点共用 `{ target, cancelled, ... }` | `web-app/server.mjs` |

### 与规划书建议形状的**有意偏离**（按 docs/14 §5.1 报告冲突）

1. **未新增 `stale` 字段**。规划书 §3 W3 的建议视图里有它，但服务端**没有**可诚实表达
   它的依据：客户端的"数据可能过期"取决于浏览器自己的轮询状态（暂停/失败），服务端无从
   得知；服务端唯一能说的"有后台运行在跑"已由既有 `running` 表达。新增一个同义字段
   就是伪造事实，违反 docs/10 §1 原则 2「不伪装」。
2. **`claim-gate` 不作为派生动作**。`decideGate` 在调用者未持 claim 时**自动认领**
   （`decideOnce`），认领因此不是前置条件。把它当作"下一步"会逼用户点一个非必需按钮。
   它仍保留在 `StageAction` 中，供页面做可选的"我要处理"按钮。
3. **`retry-storage` 不由视图派生**。视图能成功构建就说明存储当时可用；该取值保留给
   HTTP 层在 503 时使用，让页面只需要一套动作词汇表。

### 已知边界（不是缺陷）

- `blockingReason` **不含认领人身份**：视图是 actor 无关的，塞入 `claimedBy` 会让同一条
  流水线对不同调用者返回不同视图。

---

**新增环境变量**：`PLATFORM_TRUSTED_PROXY`（`'1'` 表示"身份由可信反向代理提供"，
是开启请求头信任且非回环绑定时的**显式表态**）。未设置时该组合拒绝启动。

## 8.2 W2 落地记录（索引 / 创建 / 台账一致性）

| 项 | 落地方式 | 证据 |
|---|---|---|
| `list()` 与 `get`/`recover` 同源 | `list()` 改用 `scanPipelineIndexFrom(this.indexStore)`（此前调 `scanPipelineIndex(dataRoot)`，会另 new 一个默认文件存储） | `test/web-index-and-creation.test.ts` |
| 索引扫描错误分类 | 只把**数据问题**（记录损坏 / 形状不符 / 键不一致）放进 `unreadable`；`StorageUnavailableError` **整体抛出**，由外壳映射 503 | 同文件（list 与 recover 各一条） |
| 创建中间态 | manifest/索引新增 `creationState`；落盘顺序改为 **索引(creating) → 检查点 → 索引(ready)**；允许同指纹的 create 接管中间态 | 同文件（4 条） |
| 中间态可见性 | `get`/`list`/`run` → `conflict`(409) + `hint`；`recover()` → `creation-incomplete` + `started: false` | 同文件 |
| 外部后端缺 `records` | `assertBackendPorts` 对 `requiresExternalInfrastructure: true` 的后端**装配即失败**；服务层另有同规则纵深防御 | 同文件（3 条） |

### 新增状态与字段

- **落盘**：索引/manifest 新增可选 `creationState: 'creating' | 'ready'`。
  **历史索引没有该字段 → 按 `'ready'` 解释，无需迁移。**
- **`RecoveryAction`** 新增 `'creation-incomplete'`（与 `'unreadable'` 区分：
  前者只需重新 create 接管，后者要去修那条记录）。
- **409 新增一个触发场景**：索引存在但 `creationState === 'creating'`。

### 已知语义（不是缺陷）

- `list()` **跳过**中间态条目（沿用"不用半成品状态冒充成功"的既有策略）。
  中间态通过 `get`(409 + hint) 与 `recover`(creation-incomplete) 暴露。
- 同指纹并发 create 会各自接管中间态并写检查点（原子写，后者覆盖前者）。
  指纹覆盖全部行为参数，因此这是"同一意图的重复提交"，可接受；但它**不是**分布式事务。

---

## 8.4 W4 落地记录（Web UI 信息架构与交互）

`web-app/public/` 三个文件重写（`index.html` 230 行 / `app.js` 1026 行 / `styles.css` 260 行），
无框架、无外部资源（本地单机可离线）。落地要点与证据（`test/web-ui-contract.test.ts`，12 项）：

| 规划书要求 | 落地方式 |
|---|---|
| 首屏向导而非空表格 | `#wizard` 与 `#workspace` 互斥显示 |
| 创建表单分四组 | 四个 `<fieldset>`：基本信息 / 需求输入 / 被测服务 / 运行选项 |
| 不接收 API Key | 页面无凭据输入；有测试断言**表单控件**不含 `apiKey` |
| 创建成功自动打开 | `createPipeline()` 末尾调用 `openPipeline()` |
| URL 只存导航上下文 | `#pipeline=<id>`；运行状态一律重新拉取 |
| 列表按项目/状态筛选 | `#list-filters` + `renderList()` 本地过滤 |
| 轮询不覆盖用户输入 | `gatesFrozen()`：有焦点或非空输入则冻结门面板并提示 |
| 请求中禁用按钮 | `state.busy` + 汇总渲染时同步 `disabled` |
| 409 自动刷新 | 三个动作的 catch 里按 `httpStatus === 409` 触发 `refresh()` |
| 503 不当成"没数据" | `describeError()` 单独识别 503 并给出重试入口 |
| 刷新恢复同一流水线 | 启动时从 `location.hash` 还原 `pipelineId` |
| 阶段变化不打断阅读 | 当前任务卡整块重绘；产物查看器保留展开状态 |
| 产物可折叠 | `renderValue()`：数组/对象/长文本用 `<details>` |
| 安全渲染 | **全程 `textContent`**；有测试断言 app.js 无 `innerHTML`/`insertAdjacentHTML` |
| 键盘/焦点/禁用态 | `:focus-visible`、`button:disabled`、`aria-current="step"` |
| 窄屏不溢出 | `.stepper { overflow-x: auto }` + 窄屏媒体查询 |
| aria-live | 连接状态、当前任务、门任务提示均为 `aria-live="polite"` |
| 自动刷新可暂停 | `#btn-poll` + "已暂停，数据可能过期" |

### 已知缺口（W4 冒烟实测，**需要后端改动，本轮未修**）

**后台运行的"前置失败"在 UI 上完全不可见。**

实测：配置缺 `PLATFORM_LLM_API_KEY` 时，`POST /api/pipelines/:id/run` 返回 `202`（已受理），
随后后台运行以 `provider-unavailable` 失败；该失败**只出现在服务端日志**——
检查点没写、事件流里没有、视图仍显示 `queued`，页面只说"尚未开始：触发运行"。
用户会反复点"触发运行"而得不到任何解释。

**修法与结果（W5 已修）**：这类失败（provider 缺 Key、审批覆盖缺失…）是在**宿主装配**时
**同步**抛出来的，却发生在后台任务内部。因此正确修法不是"把失败持久化"，而是
**把前置校验前移到启动后台任务之前**：

- 新增 `PipelineRunService.preflight(pipelineId, actor)`：跑完 `run()` 里除"取锁 + 跑 driver"
  之外的全部准备步骤；
- `AsyncRunner.trigger()` 在 `registry.start()` **之前**调用它；失败时返回
  `{ started: false, reason: '<错误码>: <消息>' }`，**不启动**注定失败的后台任务；
- 请求级错误（404/403/400/401）仍按原状态码冒泡，不被降级。

这比持久化更好：失败发生得更早，而且**不新增任何状态**（用"进程内记住上次失败"来补
是被架构禁止的）。证据：`test/web-preflight.test.ts`（用**真实宿主**复现缺 Key 路径）。

**仍未覆盖的一半**：真正的**运行期**异常（driver 内部抛错）不写检查点，因此后台运行时
对 UI 仍不可见——那需要权威的运行遥测（M3），**本轮未做**，已记在 §8.5。

---

## 8.5 W5 落地记录（单机运行、恢复与数据生命周期）

| 规划书要求 | 落地方式 | 证据 |
|---|---|---|
| 本地启动说明 + 最小环境变量模板 | 新增 `docs/16-local-single-node-runbook.md` | 手册本身 |
| 数据根按需创建、**数据根之外不写业务状态** | 由后端按需 `mkdir`；有测试把数据根放进父目录、跑完整生命周期后比对父目录 | `test/web-single-node.test.ts` |
| 创建 → 门 → 关进程 → 重启 → recover → 继续 | `recover` 用与 service 同一个索引存储；重启后视图逐字相同 | 同文件（3 项） |
| recover 不替真人裁决、不自动批准 | `await-human` + `started: false` + **零 spawn** | 同文件 |
| 进程内句柄不作事实来源 | 重启后 `get`/`listGateTasks`/`listEvents` 全部从磁盘重建 | 同文件 |
| **后台运行前置失败对 UI 可见** | `preflight` 前移（见 §8.4） | `test/web-preflight.test.ts`（5 项） |

### 契约变化

- **新增** `PipelineRunService.preflight(pipelineId, actor): Promise<void>`。
- **`POST /api/pipelines/:id/run` 的 `started: false` 新增取值形态**
  `'<错误码>: <消息>'`（例如 `provider-unavailable: ... missing API key environment variable: X`）。
  原有 `'already-running'` 语义不变。

### 已知边界（不是缺陷）

- `preflight` **不取运行锁**（锁要留给真正的 `run()`），因此它只保证"明显跑不起来的配置
  在启动后台任务之前被拦下"，**不保证**"校验通过后 run 一定能开始"。
- **运行期异常已落盘**（W5 遗留项，已补）：`service.run` 捕获到 driver 抛出的非预期异常时，
  把它记到**当前阶段**的 `failures`（`kind: 'run-error'`，错误码写进 detail），
  `deriveRunStatus` 据此产出 `failed`，`nextAction` 为 `reenter`。
  这样后台运行时崩溃在 UI 上**可见**，且**重启后仍然可见**（是持久化事实）。
  证据：`test/web-stage-flow.test.ts` 的三条。
  已知边界：**存储本身故障时写不进任何东西**（此时 `recordRunFailure` 静默放弃，
  但绝不吞掉原异常）；那类故障由 `storage-unavailable`(503) 表达。
- **数据根体检已实现**（`GET /api/pipelines/:id/diagnostics`）：把 `backend.diagnose()`
  的六类诊断码、索引不可读项、用量坏行、创建中间态与运行锁现状汇总成一份只读报告。
  覆盖规划书要求的七类。证据：`test/web-diagnostics.test.ts`（8 项）。
  已知边界：**索引自身损坏的那条流水线无法通过本接口体检**——反解不出它的配置与项目根；
  此时改体检同项目的另一条流水线，`index.unreadable` 会把它列出来。

---

## 8.6 编辑 / 移除流水线（W5 后续）

| 接口 | 语义 | 权限 |
|---|---|---|
| `PATCH /api/pipelines/:pipelineId` | 只改**运行参数**（需求输入 / provider / 被测基址 / 规则集 / 重试上限 / 门等待 / TTL / 诊断探针）。**不改**作用域字段与状态 | `operator` |
| `DELETE /api/pipelines/:pipelineId` | **只摘索引**（`dataRetained: true`），数据仍留在数据根 | `admin` |

**编辑的三条边界**（都有用例钉住）：① 不改 `projectId`/`tenantId`/`configRef`——它们决定索引键；
② **不改状态**：已有产物时只返回 `warning`，不自动重入；③ 有运行在进行中时 `conflict`（判据用**运行锁**，
跨进程有效；不用进程内 registry）。

**移除为什么不是真删**：产物/检查点/任务/门任务四个端口都没有 `remove` 能力。
真删要么给这四个端口加 `remove` 并同步三个后端与契约测试，要么让 service 按文件路径递归删
（跨过后端抽象、绕过路径安全校验）。保留数据换来**可恢复**与**审计链不断**。

**新增落盘/契约**：
- `PipelineRunView.params?`（**仅 `get()` 填**）——页面据此预填编辑表单；
- manifest 新增 `updatedAt?`（与 `createdAt` 分开）；
- `AuditEventKind` 新增 `pipeline-updated` / `pipeline-removed`
  ——**必须同时加进运行时白名单 `AUDIT_EVENT_KINDS`**，否则写侧照写、读侧静默丢弃
  （本文件上面那段注释警告的正是这件事，实测踩到过一次）。

---

## 8.7 L1 事实模型：只读端点 + 双写 + 惰性迁移（L1a / L1b）

> 设计依据：`docs/19-l1-pipeline-revision-run-design.md`。**L1b 期间读侧不变**——
> 下面所有"新增"都是**增量**：既有端点的请求与响应**逐字不变**（967 项测试兜底）。

| 接口 | 语义 | 权限 | 阶段 |
|---|---|---|---|
| `GET /api/pipelines/:id/revisions` | 列出该流水线的 **Revision**（配置快照） | `operator` | L1a |
| `GET /api/pipelines/:id/runs` | 列出该流水线的 **Run**（一次执行） | `operator` | L1a |

**响应形状（冻结）**：

```ts
// GET /api/pipelines/:id/revisions
{ pipelineId, pipeline: PublicPipelineRecord, revisions: PipelineRevision[] }
// GET /api/pipelines/:id/runs
{ pipelineId, pipeline: PublicPipelineRecord, runs: PipelineRun[] }
```

**两条硬约束（都有用例钉住）**：

1. **不泄露部署布局**：`PublicPipelineRecord = Omit<PipelineRecord, 'legacyLocator'>`。
   `legacyLocator` 的三个字段是**服务器绝对路径**，在**类型层面**让它无法出现在响应里，
   而不是靠"记得别返回它"。`PipelineRun.checkpointLocator` 一律是**相对 dataRoot** 的路径。
2. **`migration` 段不污染 `backend.ok`**：`PipelineDiagnostics` 新增 `migration`：

```ts
interface PipelineMigrationReport {
  state: 'migrated' | 'needed' | 'incomplete' | 'conflict'
  record: 'missing' | 'ok' | 'corrupt'
  revisions: number
  runs: number
  diagnostics: StorageDiagnostic[]     // ref 是**相对**路径，不含数据根
}
```

`backend.ok` 的语义仍是"**存储 schema 健康**"。把"还没迁移"算进它会
让每一份老数据根一开机就报不健康——报警一旦是常态就没人看了。
`attentionNeeded` 只在 `state` 为 `incomplete` / `conflict` 时置真。

**新增落盘/契约**：

- `AuditEventKind` 新增 `migration-intent` / `migration-completed`（成对出现，
  **必须同时加进 `AUDIT_EVENT_KINDS`**——同一类坑第三次出现，用例已钉住读得出来）；
- `StorageDiagnosticCode` 新增 `migration-incomplete` / `migration-conflict`；
- 新格式落盘坐标：`pipelines/<id>/pipeline.json`、`pipelines/<id>/revisions/<rid>.json`、
  `pipelines/<id>/runs/<runId>.json`。**注意不是** `pipelines/<id>.json`（那是旧扁平索引，
  写错会被 `isIndexEntry` 静默接受、运行参数静默丢失，见 `docs/19` §3.3）；
- 落盘一律走**可注入的** `HostRecordStore`（`(collection, id)` 坐标），
  文件路径由坐标推导——直接写文件会让"换后端只改装配"静默失效。

**L1b 的读侧承诺**：`create` / `PATCH` / `run` 双写；`get` 在新格式**不齐全**时惰性迁移；
其余读端点（`list` / 产物 / 事件 / 用量 / 门任务 / 体检）**纯读旧格式，一个字节都不写**。

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
| `PipelineRunView.currentStage` | 新增（派生） | W3 | ✅ 已实现（`1f15943`）｜`test/web-stage-flow.test.ts` |
| `PipelineRunView.nextAction` | 新增（派生） | W3 | ✅ 已实现（`1f15943`）｜同文件 |
| `PipelineRunView.blockingReason` | 新增（派生） | W3 | ✅ 已实现（`1f15943`）｜同文件 |
| `PipelineRunView.gateKind`（`'stage' \| 'escalation' \| null`） | 新增（派生） | W3 | ✅ 已实现（`1f15943`）｜同文件 |
| `PipelineRunView.stale` | 新增（派生） | W3 | ❌ **有意不实现**，理由见 §8.3（服务端无诚实依据，等价信息已由 `running` 表达） |
| 门任务 `isEscalation` | 新增（派生） | W3 | ✅ 已实现（`1f15943`）｜同文件 |
| 两个 cancel 端点响应形状统一 | **变更（破坏性）** | W3 | ✅ 已实现（`1f15943`）｜`web-app/server.mjs` |
| Web UI 信息架构与交互重做 | 重写（前端） | W4 | ✅ 已实现（`9611476`）｜`test/web-ui-contract.test.ts`（12 项） |
| 后台运行**前置**失败对 UI 可见 | 新增 | W5 | ✅ 已实现（`67c4f5c`）｜`preflight` 前移，见 §8.4 |
| 后台运行**运行期**失败对 UI 可见 | 新增 | W5 补 | ✅ 已实现（本次提交）｜`run-error` 落盘 + `deriveRunStatus` 产出 `failed`；`test/web-stage-flow.test.ts`（3 项） |
| 数据根体检接口 | 新增 | W5 | ✅ 已实现（本次提交）｜`GET /api/pipelines/:id/diagnostics` + `test/web-diagnostics.test.ts`（8 项） |
| 数据根体检 **CLI 命令** | 新增 | — | ⬜ 未实现：接口已够用，CLI 命令未加 |
| `list()` 改用注入的 `indexStore` | **缺陷修复（W-01）** | W2 | ✅ 已实现（`f46cf37`）｜`test/web-index-and-creation.test.ts` |
| `records` 缺失时显式区分 legacy fallback 与失败关闭 | 变更 | W2 | ✅ 已实现（`f46cf37`）｜`assertBackendPorts` 对"外部后端"失败关闭；同文件 |
| 索引扫描区分数据损坏与基础设施不可用 | 变更 | W2 | ✅ 已实现（`f46cf37`）｜`scanPipelineIndexFrom` 只把数据问题放进 `unreadable` |
| 创建过程可恢复状态（`creating` → `ready`） | 新增 | W2 | ✅ 已实现（`f46cf37`）｜`creationState` + `RecoveryAction: 'creation-incomplete'` |

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
