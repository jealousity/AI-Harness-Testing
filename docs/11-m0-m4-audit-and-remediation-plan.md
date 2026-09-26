# M0-M4 阶段完成度与正确性审计报告

- 审计日期：2026-09-25
- 审计仓库：`/Users/zhangzhixiong/Downloads/harness/test-platform-design`
- 审计提交：`08461fe refactor: extract storage ports and backend contracts`
- 远程一致性：`HEAD == origin/main == 08461fe`
- 工作区状态：审计开始时干净
- 审计对象：M0、M1、M2、M3、M4 的代码、测试、文档、提交说明和运行时装配
- 审计目的：判断“DeepSeek 已完成 M0-M4”的说法是否成立，并给出可直接执行的整改方案和强制约束提示词

> **重要结论先行：** 当前不是“所有 M0-M4 已完整正确完成”。准确状态是：
>
> - **M0：主体完成，证据充分。**
> - **M1：架构主体完成，但存在 P1 级运行参数丢失和权限边界缺口；不能按完整闭环验收。**
> - **M2：锁和常规幂等主体完成，但存在 P1 级人工门并发 CAS、executor exactly-once 崩溃窗口、reenter TOCTOU 和 digest 绑定缺口。**
> - **M3：主体完成，预算与用量证据充分；`maxTestCases` 当前只计量不硬中断，必须继续保持文档诚实。**
> - **M4-A：完成。**
> - **M4-B：只完成接口层、组合层、DDL/事务规格和 ADR，**没有可运行 PostgreSQL/Object Store adapter，且运行时宿主尚未真正接收并使用可替换 `StorageBackend`。
> - **M5：未完成。** 因此当前不能标记为“平台试运行”或“生产外部后端已就绪”。

---

## 1. 审计方法与可信证据

### 1.1 对照材料

本次审计同时对照以下材料，不以 DeepSeek 的提交说明或 README 单独作为结论依据：

1. `docs/10-next-phase-implementation-plan.md`
   - M0-M4 目标、任务、验收条件、固定验收模板、最终完成定义；
2. `packages/platform-pipeline/README.md`
   - 当前模块、测试数量、状态说明、存储后端说明；
3. 实际源码
   - `src/web/`、`src/runtime/`、`src/driver.ts`、`src/usage.ts`、`src/documents/`、`src/storage/`、`web-app/server.mjs`；
4. 实际测试
   - service contract、Web HTTP、并发、预算、解析安全、storage contract；
5. Git 历史和当前工作区
   - `git log`、`git status`、`HEAD` 与 `origin/main`；
6. 实际命令结果
   - typecheck、build typecheck、全量 `node --test`。

### 1.2 当前验证结果

| 验证项 | 结果 |
|---|---|
| `NODE_OPTIONS='--max-old-space-size=6144' ./node_modules/.bin/tsc --noEmit` | 通过 |
| `NODE_OPTIONS='--max-old-space-size=6144' ./node_modules/.bin/tsc -p tsconfig.build.json` | 通过 |
| `NODE_OPTIONS='--max-old-space-size=6144' /usr/local/bin/node --test` | **707/707 通过，0 失败** |
| Git 工作区 | 干净 |
| 本地与远程 | `HEAD == origin/main == 08461fe` |

> 测试全绿只能证明现有测试所覆盖的路径通过，不能证明未被测试的重启、并发、参数持久化和外部后端装配语义正确。本报告的主要问题正是从“实现与契约对照”及“测试缺口”中发现的。

### 1.3 严重等级

- **P0：** 可直接造成跨租户/跨项目数据泄露、自动批准、不可逆错误事实或生产数据严重破坏；应立即阻断发布。
- **P1：** 关键业务闭环、权限、恢复、并发一致性或生产部署能力不满足；修复前不得宣称对应里程碑完整完成。
- **P2：** 资源边界、诊断、文档或长期维护风险；不能忽略，但可排在 P0/P1 之后。

本次没有确认到已经被现有路径稳定复现的 P0；但 P1 问题足以阻断 M1/M2/M4 完整验收。

---

## 2. M0-M4 完成度总表

| 里程碑 | 计划目标 | 实际完成度 | 正确性判断 | 阻断项 |
|---|---|---:|---|---|
| M0 | 基线冻结、Web service 契约、状态模型、解析契约 | 90% | 主体正确 | 文档基线过时；部分边界需纳入后续 M5 |
| M1 | Web 接入统一 runtime，HTTP/后台/恢复闭环 | 75% | 主体正确，关键参数与权限缺口 | P1-01、P1-02、P1-03、P1-04 |
| M2 | 锁、并发、stale recovery、幂等 | 75% | 文件锁主体正确，业务 exactly-once 不完整 | P1-05、P1-06、P1-07、P1-08 |
| M3 | 预算强制、usage、Web/CLI 查询 | 90% | 主体正确 | `maxTestCases` 非硬中断，需保持明确边界 |
| M4-A | 存储端口、文件后端强化、契约测试 | 100% | 证据充分 | 需接入宿主统一装配才能发挥价值 |
| M4-B | 可替换外部后端 | 40% | 接口层和规格正确，运行时未完成 | P1-09 |
| M5 | 发布验收 | 0% | 尚未完成 | 安全/恢复/部署 runbook 未收口 |

### 2.1 “已完成”与“已设计”的区别

当前代码中有若干注释或 ADR 写出了目标态，例如：

> `createPlatformHost` 收一个 `StorageBackend`，把 `backend.ports` 分发给 driver / 工具 / Web 服务。

但当前 `PlatformHostOptions` 没有 `storageBackend` 或 `StoragePorts` 参数，`createPlatformHost()` 仍直接构造 `FsArtifactStore`、`FileHumanGateTaskStore`、`FsCheckpointPort`；Web service 也直接构造文件实现。

因此审计必须区分：

- **接口已定义** ≠ **运行时已接入**；
- **测试夹具能组合** ≠ **生产宿主可切换**；
- **错误类型已定义** ≠ **所有入口都能正确传播**；
- **README 写明完成** ≠ **对应的正向和负向验收证据都存在**。

---

## 3. M0 审计：主体完成

### 3.1 已确认完成

#### A. Web service 契约

`PipelineRunService` 已覆盖：

- create/get/list/run；
- stage artifact 和 events 查询；
- usage 查询；
- reenter；
- gate list/claim/decide/cancel。

主要证据：

- `packages/platform-pipeline/src/web/pipeline-run-service.ts:151-198`
- `packages/platform-pipeline/test/pipeline-run-service.test.ts`

#### B. 状态从持久化事实重建

页面状态主要从：

- checkpoint；
- artifact；
- human gate task；

重建，不依赖进程内 Map 作为第二份事实。

主要证据：

- `src/web/pipeline-run-service.ts:883-911`
- `src/web/pipeline-run-service.ts:921-980`
- `test/pipeline-run-service.test.ts` 的重启和状态重建测试。

#### C. 文档解析统一注册表

当前已具备：

- PDF；
- DOCX；
- XLSX；
- Markdown；
- CSV/TSV/TXT/YAML/JSON；
- OOXML 白名单解包、路径安全、实体不扩展、宏/嵌入对象跳过；
- draft 知识投影和来源引用。

主要证据：

- `src/documents/index.ts:39-65`
- `src/runtime/platform-tools.ts:250-310`
- `test/documents-*.test.ts`
- `docs/adr/0001-document-parsing-libraries.md`

### 3.2 M0 尚需修正文档问题

`docs/10-next-phase-implementation-plan.md:11-30` 仍保留旧基线：

- 当前版本仍写 `ee4a016`；
- 当前测试仍写 `295/295`；
- Web 仍描述为独立浏览器演示。

实际 HEAD 已是 `08461fe`，当前测试是 707 项，Web 已接入 runtime。

**处理建议：**在本报告确认后，由专门的文档提交更新 `docs/10` 的“当前基线”，并明确标注历史基线与当前状态，避免后续 DeepSeek 读取旧文字再次误判。

---

## 4. M1 审计：架构主体完成，但不能完整验收

### 4.1 已确认完成

- `web-app/server.mjs` 已成为 HTTP 外壳；
- 后台运行由 `async-runner.ts` 驱动；
- HTTP create/run 返回 202；
- Web e2e 已覆盖等待人工门、裁决、changes-needed、六阶段完成、kill/restart、Web/CLI 同一 dataRoot；
- 运行时通过 `createPlatformHost` 和 `PipelineDriver`，没有保留独立 `runPipeline` 主实现。

主要证据：

- `web-app/server.mjs:109-175`
- `web-app/server.mjs:271-405`
- `src/web/async-runner.ts:48-252`
- `test/web-http.test.ts`

### 4.2 P1-01：create 请求中的运行参数被接收但没有持久化

**等级：P1，阻断真实 Web execute 闭环。**

#### 现象

请求类型和 HTTP 路由接受：

- `requirementInput`；
- `providerName`；
- `targetBaseUrl`；
- `maxGateRetries`；
- `gateWaitTimeoutMs`；
- `gateTaskTtlMs`；
- `diagCredentials`。

证据：

- `src/web/pipeline-run-types.ts:261-278`
- `web-app/server.mjs:285-297`

但 `createOnce()` 只保存 checkpoint 和以下 index 字段：

- `pipelineId`；
- `tenantId`；
- `projectId`；
- `configRef`。

证据：

- `src/web/pipeline-run-service.ts:332-363`

后续 `run()` / 恢复只从 index 和 config 装配 host：

- `src/web/pipeline-run-service.ts:779-792`

`hostOptions()` 没有传入 create 时的上述参数。

#### 直接后果

- `targetBaseUrl` 只被校验，不进入真实 executor；
- `requirementInput` 不进入 receive 阶段；
- `providerName` 不影响 provider 选择；
- `maxGateRetries`、gate timeout、task TTL 使用 service 默认值；
- 进程重启后无法恢复原请求语义；
- 同一个 pipelineId 的请求参数改变，也没有被完整纳入幂等指纹。

#### 最小复现

创建：

```json
{
  "pipelineId": "p1",
  "projectId": "demo",
  "configRef": "examples/pipeline.yaml",
  "requirementInput": "requirements/spec.md",
  "providerName": "secondary",
  "targetBaseUrl": "https://staging.example",
  "maxGateRetries": 0,
  "gateWaitTimeoutMs": 60000,
  "gateTaskTtlMs": 900000,
  "diagCredentials": ["QA_API_KEY"]
}
```

随后重新创建 service 实例并调用 `run(p1)`。应当仍使用上述参数；当前实现无法证明这一点，真实 execute 很可能因 `targetBaseUrl` 缺失而拒绝。

#### 解决办法

新增不可变的 `PipelineRunManifest`，建议放在：

```text
<dataRoot>/pipelines/<pipelineId>.json
```

manifest 至少保存：

```ts
interface PipelineRunManifest {
  pipelineId: string
  tenantId: string | null
  projectId: string
  configRef: string
  rulesetVersion: string
  requirementInput?: string
  providerName?: string
  targetBaseUrl?: string
  maxGateRetries?: number
  gateWaitTimeoutMs?: number
  gateTaskTtlMs?: number
  diagCredentials?: readonly string[]
  createdAt: number
}
```

硬约束：

1. 不保存 API Key，只保存环境变量名；
2. `targetBaseUrl` 仍需在创建时校验，且 executor 建连前再次校验；
3. manifest 写入必须原子；
4. 幂等 fingerprint 必须覆盖所有会影响运行行为的字段；
5. 同一 `pipelineId` 的行为参数改变必须返回 `409 conflict`，不能静默复用首次结果；
6. `run()`、reenter、recover、Web 查询都从同一 manifest 读取；
7. 创建成功的定义必须包含 manifest、初始 checkpoint、索引三者均已成功持久化，或具备明确可恢复的补偿状态。

#### 必须新增的测试

- create 后捕获 `PlatformHostOptions`，逐字段断言；
- 新 service 实例重启后参数仍一致；
- `targetBaseUrl` 真正进入 executor；
- `providerName` 选择正确 provider；
- `maxGateRetries` / gate timeout / task TTL 生效；
- 同 pipelineId 改变任一运行参数返回 conflict；
- manifest、checkpoint、usage、gate task 不出现 API Key 明文。

### 4.3 P1-02：viewer 可执行 reenter、cancel 和 admin recover

**等级：P1，阻断 Web 授权闭环。**

类型契约明确写明：

- `claimGate` / `decideGate`：`reviewer` 或 `admin`；
- `reenter` / `cancelGate`：`operator` 或 `admin`。

证据：

- `src/web/pipeline-run-types.ts:36-46`

实现只有 claim/decide 调用了 `assertGateRole()`：

- `src/web/pipeline-run-service.ts:547-560`
- `src/web/pipeline-run-service.ts:637-646`

缺失：

- `reenter()` 未校验 operator/admin；
- `cancelGate()` 未校验 operator/admin；
- HTTP `/api/pipelines/:id/cancel` 只调用 `service.get()` 后直接 `runner.cancel()`；
- `/api/admin/recover` 没有 actor/admin 校验。

HTTP 证据：

- `web-app/server.mjs:314-318`
- `web-app/server.mjs:402-405`

#### 解决办法

新增统一函数：

```ts
function assertOperatorRole(actor: ActorContext): void
function assertAdminRole(actor: ActorContext): void
```

并在 service 层强制调用：

- `reenter()` → operator/admin；
- `cancelGate()` → operator/admin；
- `cancel pipeline` → operator/admin；
- `recover()` → admin，或拆成 service 的 `recover(actor)`；
- 后台实际运行身份仍不得带 reviewer/admin roles，不能因修权限而意外自动批准人工门。

#### 必须新增的测试

- viewer reenter → 403；
- viewer cancelGate → 403；
- viewer cancel pipeline → 403；
- 无身份 `/api/admin/recover` → 401/403；
- operator/admin 正常通过；
- recover 不消费真人裁决、不自动批准。

### 4.4 P1-03：reenter 的 expected digest 检查位于锁外，存在 TOCTOU

**等级：P1，可能覆盖别的进程刚产生的新版本。**

当前顺序：

1. `locate()`；
2. 读取 checkpoint；
3. 计算 digest；
4. 比较 `expectedCurrentDigest`；
5. 之后才获取 pipeline lock。

证据：

- `src/web/pipeline-run-service.ts:500-535`
- 具体顺序见 `:507-523`。

#### 解决办法

必须把以下步骤放进同一把 pipeline lock：

```text
acquire lock
load index/manifest/checkpoint
read current artifact/digest
compare expectedCurrentDigest
perform driver.reenter
save checkpoint
release lock
```

不能使用锁外快照作为锁内写入的并发依据。

#### 必须新增的测试

使用 barrier，不使用固定 sleep：

1. A 读取前/拿锁后暂停；
2. B 获锁并完成 reenter，产生 D2；
3. A 再获锁；
4. A 必须返回 409，checkpoint 保留 B 的状态。

---

## 5. M2 审计：锁主体正确，业务 exactly-once 尚未闭环

### 5.1 已确认完成

- lock 路径统一为 `checkpoints/<pipelineId>/.pipeline.lock`；
- ownerId/generation/pid/host/acquiredAt/heartbeatAt 已落盘；
- 自动续租、stale recovery、kill 后接管、旧 owner 不误删新 owner；
- CLI/Web/Harness 复用相同锁逻辑；
- pipeline create、gate decision、executor invocation 有幂等键基础；
- 双进程和 SIGKILL 测试通过。

主要证据：

- `src/checkpoint-lock.ts:47-252`
- `src/checkpoint-lock.ts:346-388`
- `test/concurrency.test.ts`
- `src/idempotency.ts`

### 5.2 P1-04：人工门任务只绑定 artifactPath，不绑定 artifact digest

**等级：P1，可能把旧批准复用给新产物。**

`findResumableTask()` 只比较：

- stageId；
- machineStatus=`passed`；
- artifactPath；
- task 是否可续用。

证据：

- `src/runtime/persistent-human-gate.ts:302-321`

`HumanGateTask` 当前也没有对应的 `artifactDigest` 字段，而 PostgreSQL DDL 设计已经预留 `artifact_digest`，说明设计与文件实现不一致。

#### 最小复现

1. 跑到 receive 人工门，得到任务 T1；
2. 记录旧 digest D1；
3. 保持路径不变，替换 artifact 内容为 D2；
4. 再次 run。

当前按路径仍可能找到 T1，导致旧任务的 review/findings/decision 与新内容不一致。

#### 解决办法

- `HumanGateTask` 增加 `artifactDigest`；
- 创建任务时记录最终送入 machine gate/review/human gate 的同一份 artifact digest；
- `findResumableTask(stageId, artifactPath, artifactDigest)` 三者同时匹配；
- digest 变化时旧任务标记 stale/invalid，不得复用，必须新开门或明确失败；
- machine gate、review、human gate 必须接收同一份最终 artifact，不得一个用 raw artifact、一个用 filled artifact；
- file/memory/PostgreSQL 三种后端保持相同语义。

#### 必须新增的测试

- 同一路径替换内容后，旧 pending task 不可续用；
- 旧 approved-but-unconsumed task 不可批准新 digest；
- 重启后 artifact 被篡改，必须重新开门或显式失败；
- task digest、machine gate digest、checkpoint digest 一致。

### 5.3 P1-05：文件人工门 claim/decide/cancel 不是 CAS

**等级：P1，多进程/并发 reviewer 下会丢失裁决。**

当前 `FileHumanGateTaskStore` 的流程是：

```text
get -> 检查状态/lease -> save
```

证据：

- `src/runtime/persistence.ts:176-220`

`claim()`、`decide()`、`cancel()` 都存在 read-modify-write 窗口；pipeline lock 只保护 run/reenter，不保护外部人工门 API。

#### 解决办法

文件后端至少实现一种：

1. 每个 gate task 独立锁；或
2. 记录中增加 `revision`，使用临时文件 + 条件 rename/CAS；或
3. 通过同一 gate-task lock 串行化 get/check/save。

外部 PostgreSQL 必须使用条件 UPDATE：

```sql
UPDATE pipeline_gate_task
SET status = $action, decision = $decision, revision = revision + 1
WHERE gate_task_id = $id
  AND revision = $expectedRevision
  AND status = 'claimed'
  AND claimed_by = $actor;
```

0 行必须返回明确 conflict/不可裁决，不能成功返回一个已经被覆盖的旧对象。

#### 必须新增的测试

- 两个 actor 并发 claim，最多一个成功；
- 两个 actor 并发 decide，最多一个成功；
- claim/decide 返回值与最终磁盘事实一致；
- stale claim 恢复与新 claim 不会覆盖新 owner；
- 使用 barrier，禁止固定 sleep。

### 5.4 P1-06：review-failed 没有闭合到持久化终态

**等级：P1，重启可能绕过 review retry 上限。**

review 失败且重试耗尽时：

- driver 返回 `{ outcome: 'review-failed' }`；
- 没有继续写入持久化终态；
- checkpoint 可能仍是 `needs-fix`。

证据：

- `src/driver.ts:245-260`
- `src/web/async-runner.ts:54-74`：`needs-fix` 会被恢复为 `resume`。

#### 解决办法

二选一，但必须让当前返回结果和重启后状态一致：

**方案 A：**新增持久化 `review-failed` 状态。

**方案 B：**保留 `needs-fix`，但把 review failure 次数、最后 findings、最终时间戳写入 checkpoint，恢复时按持久化计数返回 terminal，不得再次 spawn。

推荐方案 A，语义更直接。

#### 必须新增的测试

- review 连续失败达到上限后 checkpoint 有最终 failure；
- 新 service 实例 `get()` 与原始 RunResult 语义一致；
- `recover()` 返回 terminal；
- 重启后 spawn 次数不会从 2 增加到 3。

### 5.5 P1-07：executor exactly-once 存在远端副作用后的崩溃窗口

**等级：P1，不能对不支持幂等键的外部接口宣称 exactly-once。**

当前顺序大致是：

1. 查本地幂等台账；
2. 发送真实 HTTP 请求；
3. 写 execution session/evidence；
4. 写本地幂等台账。

证据：

- `src/runtime/platform-tools.ts:823-905`
- `src/idempotency.ts:41-52`

进程可能在真实请求成功后、台账落盘前崩溃。重启后看不到台账，会再次发送请求。

#### 解决办法

不能只靠本地 ledger。至少采用以下策略之一：

- 预写 invocation intent；
- 给远端请求传递稳定 idempotency key；
- 记录 request-sent / response-received / receipt；
- 重启发现 unknown 时阻止盲目重发，转为人工处理或查询远端结果；
- 对不支持幂等键的非幂等 API 明确标记 `at-most-once-unprovable`，不伪装 exactly-once。

#### 必须新增的测试

- HTTP 已返回成功、ledger 尚未写入时注入崩溃；
- 重启不得无条件第二次发送；
- 并发两次 invocation 最多产生一个远端副作用，或进入明确 unknown；
- session/evidence/ledger 恢复后互相一致。

### 5.6 P1-08：幂等台账与业务写入仍不是同一事务

**等级：P1，设计文档已明确承认，但不能作为“完整 exactly-once”交付。**

当前幂等台账的 `produce()` 和业务副作用不是原子提交。对于本地文件，不能凭空实现跨远端副作用的一致事务；应把事实说清楚，改为可恢复状态机，而不是继续扩大“幂等已完成”的表述。

---

## 6. M3 审计：主体完成，边界必须保持诚实

### 6.1 已确认完成

- `UsageEvent`、`UsageStore`、append-only JSONL；
- LLM/tool/review/executor/gate/checkpoint 计量；
- maxSteps 硬停；
- timeout deadline；
- maxRetries 收紧；
- budget exceeded 写 checkpoint failure/gate-failed，不能自动批准；
- Web/CLI 查询同一份持久化日志；
- usage sink 写失败不升级为业务失败；
- token/prompt/response 不进入 usage。

主要证据：

- `src/usage.ts`
- `src/driver.ts:159-166, 779-805`
- `test/usage.test.ts`
- `test/openai-stage-runner.test.ts`
- `test/web-http.test.ts`

### 6.2 `maxTestCases` 的边界

当前 `maxTestCases` 做计量和报告，不在阶段内硬中断。这个边界已在 README 和提交说明中写明，因此目前不是隐性缺陷；但后续提示词必须禁止 DeepSeek 把它改写成“已实现硬限制”。

若将来要硬中断，必须先定义：

- design 产物超过限制时是拒绝还是截断；
- executor 是否允许分批；
- 已执行部分如何记账；
- 是否需要人工门；
- 重试是否复用已执行结果。

在这些定义前，不得随意增加 `slice(0, maxTestCases)` 这种静默截断。

---

## 7. M4 审计：M4-A 完成，M4-B 只有接口层

### 7.1 已确认完成：M4-A

已交付：

- `src/storage/ports.ts`：9 个端口、版本信封、诊断、迁移、存储错误；
- `src/storage/file/`：文件后端、体检、迁移、审计；
- `src/storage/memory/`：同构第二后端；
- `src/storage/compose.ts`：组合层；
- `test/storage-contract.ts`：后端无关契约套件；
- file/memory/compose 契约测试；
- schema version、损坏数据显式失败、迁移备份/幂等。

当前全量测试 707 项通过，storage 专项也通过。

### 7.2 P1-09：StorageBackend 没有接入实际宿主装配

**等级：P1，阻断“后端可替换”运行验收。**

接口注释声称 `createPlatformHost` 收 `StorageBackend`，但：

- `PlatformHostOptions` 没有 `storageBackend` / `StoragePorts`；
- `createPlatformHost()` 直接 new `FsArtifactStore`、`FileHumanGateTaskStore`、`FsCheckpointPort`；
- `FilePipelineRunService` 直接 new `FsArtifactStore`、`FileHumanGateTaskStore`、`FsCheckpointPort`；
- `composeStorageBackends()` 只在测试/导出层被使用。

证据：

- `src/runtime/platform-host.ts:58-105, 127-214`
- `src/web/pipeline-run-service.ts:29-73, 779-817, 885-895`

#### 直接后果

- 即使未来构造出 PostgreSQL/Object Store backend，Web/driver 也不会使用它；
- 多进程/多机仍使用本地文件；
- 可能出现“一个组件写外部后端，另一个组件从文件读取”的双事实；
- docs/10 §8.4 “backend 切换只改宿主装配”目前只是目标设计，不是已验收行为。

#### 解决办法

第一步：宿主注入：

```ts
interface PlatformHostOptions {
  // ...已有字段
  readonly storageBackend?: StorageBackend
}
```

第二步：`PlatformHost` 暴露 `backend` / `ports`，所有 driver、gate、artifact、checkpoint、task、usage、audit 都从同一份 backend 取端口。

第三步：Web service 注入宿主工厂或 backend 工厂，不在 service 中直接 new 文件 store。

第四步：把 pipeline index、idempotency、审计、manifest 的事实来源明确纳入同一套持久化设计；不能只抽出九个端口后继续在 Web 旁路 `node:fs`。

第五步：启动时执行 `assertBackendPorts()` 和 `diagnose()`；外部后端不可用必须返回 `storage-unavailable`，不能 fallback 到 file。

#### 必须新增的测试

- 注入带 sentinel 的 memory backend，断言 host/driver/Web 不访问任何 `Fs*` 实现；
- 两个 service 实例使用同一 backend 时共享 checkpoint/gate/index；
- `describe()` 中声明的每个端口都实际被使用；
- backend diagnose 失败映射为 infrastructure failure；
- backend 切换只修改宿主装配代码，stage/gate/driver 测试无需修改。

### 7.3 M4-B 的真实完成度

当前 PostgreSQL/Object Store：

- 有 SDK 无关接口；
- 有 DDL；
- 有端口↔表/对象键映射；
- 有事务边界说明；
- 有错误分类；
- 有未配置时明确失败测试；
- **没有真实连接、真实 CRUD、真实事务、真实对象读写、真实 external backend contract test**。

因此应标记为：

> **M4-B 接口层与 ADR 完成；可运行外部后端未完成。**

这符合 `docs/10 §10 P1-B` 的“若本阶段不部署外部后端，至少交付接口和 ADR”兜底语义，但不等价于完整 external backend production readiness。

---

## 8. P2 级问题与改进项

### 8.1 文档基线过时

`docs/10:11-30` 仍描述旧提交、旧测试数量和旧 Web 状态。必须更新为“历史基线”或当前基线。

### 8.2 `readIndex()` 没有复用严格索引校验

`scanPipelineIndex()` 有 `isIndexEntry()` 和文件名一致性校验，但 `readIndex()` 主要是 JSON.parse + cast：

- `src/web/pipeline-run-service.ts:856-870`

建议统一为一个严格读取函数，校验：

- pipelineId；
- projectId；
- configRef；
- tenantId；
- 文件名与 pipelineId 一致；
- index 与 checkpoint 的 pipelineId 一致。

损坏索引必须显式进入 `storage-corrupt`/`unreadable` 诊断，不能依赖未捕获 TypeError。

### 8.3 文档 `maxFileBytes` 没有在 readFile 前阻断

`parseWorkspaceDocument()` 先把整个文件读入内存，再调用 parser：

- `src/runtime/platform-tools.ts:258-280`

而 `assertFileSize()` 的注释要求解析前限制：

- `src/documents/document-limits.ts:64-69`

建议：

1. 先 `stat()`，超限立即结构化返回；
2. 处理竞态时使用最多读取 `maxFileBytes + 1` 的流式读取；
3. parser 内保留二次校验。

### 8.4 `maxCompressionRatio` helper 未接入 OOXML 实际解包

`assertZipEntryWithinLimits()` 已定义压缩比判定：

- `src/documents/document-limits.ts:116-152`

但 `src/documents/zip-reader.ts:127-151` 实际只检查单条大小和总量，没有调用压缩比函数。

这不等于当前没有任何 zip bomb 防护——条目数、单条大小、总解压量仍有效——但声明的压缩比策略没有真正执行。需要补调用和专门 fixture。

### 8.5 SSRF 校验的 userinfo 和 IPv4-mapped IPv6

`assertTargetBaseUrlAllowed()` 将原始 URL放入错误消息：

- `src/web/pipeline-run-service.ts:1175-1191`

当前没有明确拒绝 `url.username/url.password`，也没有覆盖 `::ffff:127.0.0.1` 等 IPv4-mapped IPv6。

建议：

- 拒绝 URL userinfo；
- 错误消息只输出安全摘要，不回显完整 raw URL；
- 使用标准 IP 解析覆盖 mapped IPv6、loopback、link-local、private、CGNAT、unspecified；
- 建连前再次校验解析后的实际地址，防 DNS rebinding。

---

## 9. 直接执行的整改顺序

> DeepSeek 不得跳过顺序，不得先做“看起来更大的架构重写”。每一批都必须先补测试，再改实现，再验证，再提交。

### 批次 A：先封锁权限和事实丢失

1. 增加 `PipelineRunManifest`，修复 create 参数持久化和幂等 fingerprint；
2. 增加 operator/admin/recover 权限；
3. 把 reenter digest 校验移入 lock；
4. 增加 viewer/operator/admin 的 service + HTTP 测试。

**批次 A 验收：** 现有 707 项全绿 + 新增 manifest/权限/TOCTOU 测试全绿；任何 viewer 不能改变流水线状态。

### 批次 B：修人工门身份与并发

1. `HumanGateTask.artifactDigest`；
2. `findResumableTask` path + digest；
3. machine/review/human 使用同一最终 artifact；
4. 文件 gate task 增加 per-task CAS/revision；
5. review-failed 持久化终态；
6. 并发 claim/decide barrier 测试。

**批次 B 验收：** 旧批准永远不能批准新 digest；并发 claim/decide 最多一个成功；重启不会绕过 review retry。

### 批次 C：修 executor 不可伪装的 exactly-once 边界

1. 预写 invocation intent；
2. 远端 idempotency key；
3. request sent/response received/unknown 状态；
4. 崩溃恢复时禁止对 unknown 盲目重发；
5. 对不支持幂等的接口明确降级为人工处理，而不是宣称 exactly-once。

**批次 C 验收：** 真实 HTTP 成功后在本地落盘前崩溃，重启不会静默二次副作用。

### 批次 D：把 storage backend 真正接入宿主

1. `PlatformHostOptions.storageBackend`；
2. host/service/driver/gate/tool 统一从 `backend.ports` 取事实；
3. index/manifest/idempotency 的事实来源与 backend 关系明确；
4. file backend 作为默认宿主装配；
5. memory sentinel backend 验证没有 Fs 旁路；
6. 外部 backend 仍未实现时，启动明确 `storage-unavailable`，不 fallback。

**批次 D 验收：** 只改宿主装配即可切换 backend，stage/gate/driver 不改；同一份 contract test 在 file 和第二个真实可运行 backend 通过。

### 批次 E：资源和文档收口

1. parser 前置 file size；
2. 接入 compression ratio；
3. SSRF userinfo/mapped IPv6/建连复核；
4. 严格 readIndex；
5. 更新 `docs/10` 当前基线；
6. 编写部署/恢复 runbook；
7. 完成 M5 安全、恢复、并发、预算、Web 集成发布门槛。

---

## 10. 每批次固定验收模板

DeepSeek 每完成一个批次，提交说明必须逐项回答，缺一项视为未完成：

1. 本批修改了哪些文件？逐文件说明原因；
2. 哪些接口、状态、路径、落盘字段发生变化？给出兼容策略；
3. 是否新增任何 `@deepseek-ai/*` 核心依赖？默认必须回答“否”；
4. 是否改变了自动批准、跨租户、跨项目、路径越权、凭据存储行为？必须给负向测试；
5. 新增了哪些失败路径测试？逐项列测试名；
6. typecheck、build、全量测试、专项测试的原始结果是什么？写清 `pass/fail/skip`；
7. Web、CLI、Harness、进程重启是否继续读写同一份持久化事实？给出文件或端口证据；
8. 未完成项、已知竞态窗口、迁移/回滚风险是什么？不能写“无”作为占位；
9. 本次是否真正满足目标，还是只完成接口/规格？必须明确区分“可运行实现”和“接口层”；
10. 提交 hash、工作区状态、`HEAD == origin/main` 是否确认？

---

## 11. DeepSeek 强制约束提示词

下面提示词可直接作为 DeepSeek 执行本仓库任务时的固定前置约束。完整可复制版本另存为：

```text
docs/prompts/deepseek-m0-m5-execution-constraints.md
```

核心原则是：**不允许把“写了接口、写了测试、写了注释、README 声称完成”当成可运行完成。必须用实际代码路径和测试证据证明。**

---

## 12. 审计结论签字版

### 可以确认完成

- M0：Web service 契约、状态重建、文档解析注册表和 PDF/DOCX/XLSX/Markdown 解析主体完成；
- M3：预算强制、usage、Web/CLI 查询主体完成；
- M4-A：端口抽取、文件/内存/组合后端、schema/诊断/迁移、契约套件完成；
- M2：锁、stale recovery、跨进程竞争测试主体完成。

### 不能确认完整完成

- M1：create 运行参数在真实 Web run/restart 中的闭环；权限完整性；reenter TOCTOU；
- M2：人工门 digest 绑定、文件 gate task CAS、review-failed 重启语义、executor exactly-once 崩溃窗口；
- M4-B：可运行 PostgreSQL/Object Store；实际宿主 backend 切换；
- M5：部署、恢复、安全发布门槛。

### 最终状态表述

> **DeepSeek 已完成 M0-M4 的大量主体代码和测试，但未完成所有 M0-M4 的正确性闭环。当前最准确的状态是：M0 主体完成、M1/M2 存在 P1 阻断项、M3 主体完成、M4-A 完成、M4-B 仅接口层完成、M5 未开始收口。**

在 P1-01、P1-02、P1-03、P1-04、P1-05、P1-06、P1-07、P1-09 修复并通过新增验收前，不得对外宣称“平台化 M0-M4 全部完成”。

---

## 13. 修复进度

> 本节由修复提交维护。**只有"代码 + 失败路径测试 + 全量验证"三者齐备才标记 ✅**；
> 只交付接口或只更新文档的项一律保持 ⬜，并在备注里写明真实状态。

| 编号 | 问题 | 状态 | 证据 |
|---|---|---|---|
| P1-01 | create 运行参数没有持久化 | ✅ 已修复 | `PipelineRunManifest`（= 流水线索引，同一份文件同一次原子写）；`hostOptions()` 全部从清单读取；幂等指纹覆盖全部行为参数；executor 建连前复核。测试：`test/web-run-manifest.test.ts`（10 项）+ `test/platform-tools.test.ts` 的建连前复核 |
| P1-02 | viewer 可执行 reenter/cancel/recover | ✅ 已修复 | `assertGateRole` / `assertOperatorRole` / `assertAdminRole` 收敛到 `pipeline-run-types.ts`，service 与 HTTP 外壳共用。测试：`test/web-actor-roles.test.ts`（8 项）+ `test/web-http.test.ts` 的 viewer 403 |
| P1-03 | reenter 的 digest 校验在锁外 | ✅ 已修复 | `reenter` 改为「取锁 → 读检查点 → 算 digest → 比较 → 重入」；观测面测试：别人持锁 + 检查点缺失时必须报 `conflict` 而不是锁外快照的 `not-found`。测试：`test/pipeline-run-service.test.ts` 的 2 项 |
| P1-04 | 人工门不绑定 artifact digest | ⬜ 未修复 | 批次 B |
| P1-05 | 文件 gate task 非 CAS | ⬜ 未修复 | 批次 B |
| P1-06 | review-failed 未持久化终态 | ⬜ 未修复 | 批次 B |
| P1-07 | executor 崩溃窗口可重复副作用 | ⬜ 未修复 | 批次 C |
| P1-08 | 幂等台账与业务写入非同事务 | ⬜ 未修复 | 批次 C |
| P1-09 | StorageBackend 未接入宿主装配 | ⬜ 未修复 | 批次 D |
| P2-01 | `readIndex` 校验不统一 | 🟡 部分修复 | `readIndex` 已复用 `isIndexEntry` 并校验文件名一致性（P1-01 的"不静默降级"依赖它）；**checkpoint.pipelineId 交叉校验仍未做**，见批次 E |
| P2-02 | parser 未在 readFile 前限制字节 | ⬜ 未修复 | 批次 E |
| P2-03 | 压缩比策略未接入 zip reader | ⬜ 未修复 | 批次 E |
| P2-04 | SSRF userinfo / mapped IPv6 | ⬜ 未修复 | 批次 E |
| P2-05 | 更新 docs/10 旧基线 | ⬜ 未修复 | 批次 E |
| P2-06 | 部署与恢复 runbook | ⬜ 未修复 | 批次 E |
