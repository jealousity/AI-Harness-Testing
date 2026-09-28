# Web 单机运行产品化完善规划书

> **执行对象：DeepSeek V4.1 Flash**  
> **执行方式：按本文件逐阶段实施，不跳阶段、不把 UI mock 冒充真实功能。**  
> **目标：先把 Web 端做到本地单机可运行、六阶段流转完整、UI 交互达到设计标准；暂不推进生产化外部后端。**

---

## 0. 执行摘要

本轮不是重新设计平台，也不是实现 PostgreSQL/Object Store，更不是重新编排六阶段。
本轮只收口 **Web 单机产品体验与 Web 入口正确性**：

```text
浏览器
  → Web HTTP 外壳
  → FilePipelineRunService
  → createPlatformHost
  → PipelineDriver
  → receive → analyze → design → execute → report → archive
  → 机器门禁 / 审核 / 人工门 / 产物 / 事件 / 用量
  → 文件后端持久化
```

完成后，用户在本机执行一次启动命令即可：

1. 打开 Web 页面；
2. 创建一条流水线；
3. 看到六阶段真实状态与当前下一步；
4. 触发后台运行；
5. 在人工门上查看机器违规、审核 findings、产物和裁决上下文；
6. 批准、打回或拒绝；
7. 再次运行消费裁决并继续后续阶段；
8. 查看事件、用量、预算、执行证据与阶段产物；
9. 关闭并重启 Web 服务后，通过恢复扫描继续未完成运行；
10. 所有异常都显示为可理解的状态和下一步，不出现假成功、空产物或静默降级。

---

## 1. 当前基线与本轮边界

### 1.1 当前基线

仓库：

```text
/Users/zhangzhixiong/Downloads/harness/test-platform-design
```

核心包：

```text
packages/platform-pipeline
```

当前 Web 文件：

```text
web-app/server.mjs
web-app/public/index.html
web-app/public/app.js
web-app/public/styles.css
```

当前已有能力：

- `FilePipelineRunService` 已接入六阶段 `PipelineDriver`；
- API 已覆盖创建、运行、查询、产物、门任务、裁决、取消、重入、事件、用量、恢复；
- 文件后端、人工门、锁、检查点、执行器记录、预算与 Web e2e 已有大量测试；
- 当前最近验证基线：**824/824 pass、0 fail、0 skip**；
- Web 本地单机启动方式已有，但仍缺少完整的产品化交互、配置校验与部分一致性防线。

### 1.2 本轮必须解决的已知问题

以下问题是本轮的**强制修复项**，不能只在文档里记录：

| 编号 | 问题 | 影响 |
|---|---|---|
| W-01 | `PipelineRunService.list()` 仍可能调用默认文件索引扫描，绕过注入的 `indexStore` | 注入索引存储后，详情/恢复能看到，列表看不到 |
| W-02 | `records` 缺失时幂等台账静默回退本地文件 | 外部/替换后端会出现事实分裂；本轮单机默认可回退，但必须显式区分 legacy fallback |
| W-03 | Web UI 主要是单页长表单，缺少真正的当前任务导向交互 | 用户不知道当前该做什么，也无法快速定位阶段、门任务和失败原因 |
| W-04 | `openGateTaskId`、阶段门任务和 `gate-failed` 升级任务在 UI 上没有明确区分 | 预算失败升级任务可能被显示成普通待裁决门 |
| W-05 | `/health` 返回正在运行的 pipeline ID | 未鉴权接口泄露运行中的业务标识 |
| W-06 | `PLATFORM_MAX_BODY` 使用 `Number()`，`NaN` 可使请求体限制失效 | 存在内存 DoS 风险 |
| W-07 | `PLATFORM_TRUST_ACTOR_HEADERS=1` 依赖部署者自觉清洗请求头 | 本地单机可用，但必须在启动时明确显示危险模式并防止误暴露 |
| W-08 | 服务启动时配置校验不完整，部分非法配置首次业务请求才暴露 | 健康检查可能假绿 |
| W-09 | 索引扫描把基础设施不可用宽泛归入单条 unreadable | 恢复接口可能返回成功样式而不是明确 storage failure |
| W-10 | create 的 checkpoint 与 index 不是事务 | 中间崩溃可能留下不可见孤儿记录 |
| W-11 | UI 只有基础轮询，没有明确的 loading、stale、冲突、恢复和网络错误交互 | 用户容易重复点击或误判状态 |

### 1.3 本轮明确不做

以下内容不进入本轮范围：

- 不做 PostgreSQL/Object Store；
- 不做多副本、队列、计费、SaaS 多租户部署；
- 不做真实公网被测系统 + 真实模型环境验收（M5 10b 仍单列）；
- 不做真实跨天数运行验收（M5 8c 仍单列）；
- 不修改六阶段顺序；
- 不重新设计机器门禁规则；
- 不把 Harness 依赖引入核心 runtime；
- 不在浏览器保存 API Key；
- 不用前端状态替代 checkpoint、artifact、gate task、usage、event 等持久化事实；
- 不把自动轮询、HTTP 超时或浏览器刷新解释成批准；
- 不用 mock 数据填充“已完成”状态。

---

## 2. 目标态验收定义

### 2.1 单机启动验收

本地仅依赖 Node 与仓库文件后端即可启动：

```bash
cd /Users/zhangzhixiong/Downloads/harness/test-platform-design
PLATFORM_DATA_ROOT=/absolute/path/to/web-data \
PLATFORM_CONFIG_PATH=/absolute/path/to/examples/pipeline.yaml \
PLATFORM_CONFIG_REF=default \
PORT=3080 \
/usr/local/bin/node web-app/server.mjs
```

启动时必须：

- 校验 `PORT`、`PLATFORM_MAX_BODY`、等待超时等数值环境变量；
- 校验配置文件可读、结构合法、阶段 ACL 合法、审批工具覆盖完整；
- 校验文件数据根可创建/可读写；
- 输出不含 API Key、绝对数据路径、配置真实文件路径；
- `/health` 只返回固定健康信息，不返回 pipeline ID；
- 默认身份仍是最小权限 viewer；
- 如果开启 `PLATFORM_TRUST_ACTOR_HEADERS=1`，健康信息和启动日志必须明确标红危险模式，且非 loopback 绑定时按显式策略拒绝或要求可信代理配置。

### 2.2 六阶段流转验收

阶段顺序固定：

```text
receive → analyze → design → execute → report → archive
```

每一阶段必须遵守：

```text
idle
  → running
  → produced / 机器门禁
  → review（如配置启用）
  → awaiting-gate
  → approved + consumed
  → done
  → 下一阶段
```

异常路径必须明确：

| 情况 | 流程结果 | UI 表现 | 是否允许自动继续 |
|---|---|---|---|
| 机器门禁通过且无需人工门 | 进入下一阶段 | 显示自动通过与时间 | 是，按配置规则 |
| 机器门禁通过、需要人工门 | `waiting-human` | 显示待裁决、阶段和产物 | 否 |
| 人工批准 | 裁决任务 `approved`，下一次 run 消费 | 显示“已批准，待继续运行” | 不在裁决请求内自动跑完整流水线 |
| `changes-needed` | 当前阶段 `needs-fix` / 需要重跑 | 显示打回原因与“再次运行” | 否，必须下一次显式 run |
| `rejected` | 终止 | 显示拒绝原因 | 否 |
| 任务取消 | 运行进入明确取消/等待状态 | 区分“取消门任务”和“取消后台运行” | 否 |
| 机器门禁失败 | `gate-failed` | 显示违规与升级任务，不显示普通阶段门 | 否 |
| review 重试耗尽 | `review-failed` | 显示 findings 与终态 | 否 |
| executor 数据缺失 | R4-08 阻断 | 显示“没有真实执行证据” | 否 |
| storage 不可用 | `storage-unavailable` / 503 | 显示基础设施故障与重试建议 | 否 |
| 进程重启 | recover 决定 `resume` / `await-human` / `terminal` | 显示恢复结果 | 只允许机器恢复，不允许后台替人裁决 |

### 2.3 UI 验收

页面不是“六个状态标签 + JSON 输出”，必须达到以下结构：

1. **顶部运行上下文**
   - pipeline ID、项目、租户、当前状态、最后更新时间；
   - 当前下一阶段；
   - 是否后台运行；
   - 数据是否正在刷新、最近一次刷新失败原因。

2. **六阶段 Stepper**
   - 六阶段固定横向/纵向流程图；
   - 当前阶段高亮；
   - 已完成、运行中、等待人工、失败、待重入、未开始使用不同状态；
   - 每一阶段显示机器门禁、审核、人工门、digest、时间；
   - 点击阶段进入详情，不丢失当前 pipeline 上下文。

3. **当前任务卡**
   - 只显示当前最重要的下一步：运行、查看产物、认领门、裁决、重入、恢复或查看故障；
   - 不允许在不适用的状态下显示误导按钮；
   - `gate-failed` 升级任务与普通阶段人工门使用不同颜色、不同文案、不同操作集合。

4. **人工门工作区**
   - 当前任务摘要；
   - 阶段产物摘要与完整产物查看入口；
   - artifact digest；
   - 机器违规；
   - review verdict/findings；
   - 认领状态、认领人、TTL、更新时间；
   - 批准 / 打回 / 拒绝 / 取消；
   - 打回、拒绝、取消必须填写非空说明；
   - 按钮在请求期间禁用，成功后不可重复提交；
   - conflict 后自动刷新，不显示“已成功”。

5. **产物查看器**
   - JSON 结构化查看；
   - 长文本折叠；
   - digest、版本、路径、创建时间；
   - 产物不存在显示“尚未产出”，不能显示空 JSON；
   - 产物读取失败显示明确的 storage/read 错误；
   - 所有服务端文本必须通过 `textContent` 或安全转义渲染，不能把 artifact 内容直接拼进 `innerHTML`。

6. **事件时间线**
   - 按持久化时间排序；
   - 显示阶段、事件类型、actor、说明；
   - 区分事实事件与运维提示；
   - 不把浏览器轮询时间伪造为业务事件。

7. **用量与预算面板**
   - 每阶段 used / limit / exceeded；
   - budget failure 与日志重算 exceeded 分开显示；
   - tokens unavailable 不显示为 0；
   - 预算终态不显示为普通人工门；
   - 刷新后与 CLI/重启读取结果一致。

8. **错误与恢复体验**
   - 首次加载、局部加载、轮询失败、网络断开、服务重启分别显示；
   - 显示“数据可能已更新，请刷新”，而不是覆盖当前页面为假状态；
   - 404、403、409、503 的提示不同；
   - 不能把 202 误显示成已完成；
   - 页面刷新后根据 URL/本地非事实导航参数恢复当前 pipeline，不保存运行状态。

---

## 3. 执行阶段与任务分解

> DeepSeek 必须按以下顺序执行。每个阶段完成后先跑该阶段测试，再进入下一阶段。

### W0：基线对齐与 Web 契约冻结

**目标**：在改 UI 前先冻结当前 API、状态、字段和单机启动行为。

必须阅读：

- `docs/10-next-phase-implementation-plan.md`；
- `docs/11-m0-m4-audit-and-remediation-plan.md`；
- `docs/13-m5-release-gates.md`；
- `docs/08-execution-trust.md`；
- `packages/platform-pipeline/src/driver.ts`；
- `packages/platform-pipeline/src/web/pipeline-run-service.ts`；
- `packages/platform-pipeline/src/web/pipeline-run-types.ts`；
- `packages/platform-pipeline/src/web/async-runner.ts`；
- `web-app/server.mjs`；
- `web-app/public/index.html`、`app.js`、`styles.css`；
- `test/web-http.test.ts` 与 M5 Web 测试。

交付：

- `docs/15-web-api-and-state-contract.md`，记录本轮最终 API 和状态契约；
- 不改业务代码；
- 文档必须明确哪些 API 是已有、哪些是本轮新增；
- 记录所有 `202/200/404/409/503` 语义。

### W1：Web Server 启动与安全硬化

**目标**：本地单机启动即是可信状态，不是假绿。

目标文件：

```text
web-app/server.mjs
web-app/server.test.mjs 或 packages/platform-pipeline/test/web-server-config.test.ts
```

任务：

1. 新增统一严格数值解析：`PORT`、`PLATFORM_MAX_BODY`、`PLATFORM_GATE_WAIT_TIMEOUT_MS`、TTL；
2. `NaN`、Infinity、小数、负数、超安全整数在启动时明确失败；
3. `readJsonBody` 对 `MAX_BODY` 失效场景增加测试；
4. `/health` 不返回 `runningIds()`，只返回固定健康信息和非敏感配置状态；
5. trust actor headers：
   - 默认关闭保持不变；
   - 开启时启动日志明确警告；
   - `HOST` 非 loopback 时必须要求显式可信代理配置，或拒绝启动；
   - 不能凭请求头自身证明“来自可信代理”；
6. 启动时完成完整配置校验：配置结构、阶段 ACL、审批覆盖、provider 引用、数据根读写；
7. storage-unavailable 与配置 invalid 不能等到第一次业务请求才暴露；
8. 增加请求超时/断开连接处理，避免超大请求长时间占用连接。

失败路径测试：

- `PLATFORM_MAX_BODY=NaN` 启动失败；
- `content-length` 超限拒绝；
- chunk 累积超限拒绝；
- `/health` 不包含任何 pipeline ID；
- trust headers 默认关闭时伪造请求头无效；
- 非 loopback + trust headers 无可信代理策略时拒绝启动；
- 非法配置启动失败；
- storage 诊断失败启动失败或返回明确 503，不假健康。

### W2：Service/API 一致性与单机事实闭环

**目标**：Web 的所有 API 都使用同一个 service、同一个 backend、同一个 index store。

目标文件：

```text
packages/platform-pipeline/src/web/pipeline-run-service.ts
packages/platform-pipeline/src/web/async-runner.ts
packages/platform-pipeline/src/web/pipeline-run-types.ts
web-app/server.mjs
```

任务：

1. 修复 `list()` 绕过 `indexStore`：改为 `scanPipelineIndexFrom(this.indexStore)`；
2. service 与 runner 使用同一个 dataRoot index store 实例/工厂，不能各自默认构造；
3. `records` 缺失策略显式化：
   - 默认文件单机允许 legacy fallback，但启动日志/diagnose 必须显示；
   - 外部/自定义 backend 缺 records 时失败关闭；
   - 不能因为后端声明不完整而静默回落；
4. `scanPipelineIndexFrom()` 区分：
   - `StorageCorruptError` → 单条 unreadable；
   - `StorageUnavailableError`/连接失败 → 整体 storage-unavailable；
5. create 过程增加可恢复状态：
   - 推荐新增 `creating` manifest/index 状态；
   - checkpoint/index 任一失败，恢复扫描能报告 creation-incomplete；
   - 不得出现 checkpoint 已写但 Web 永久看不见且无报告；
6. API 错误体统一：
   ```json
   {
     "error": {
       "code": "conflict",
       "message": "可读提示",
       "details": {},
       "httpStatus": 409
     }
   }
   ```
7. 保持默认单机文件布局兼容；不做数据迁移。

失败路径测试：

- 自定义 index store 创建后 `list()` 能看到；
- 自定义 index store 中创建后重建 service 仍能 `get/list`；
- 自定义 index store 恢复扫描与 service 使用同一事实；
- index store 不可用时 list/recover 返回 503，而非空列表；
- 单条索引损坏只报告该条；
- checkpoint 成功、index 失败时 recovery 报 creation-incomplete；
- create 重试不会覆盖不同 fingerprint；
- 自定义 backend 缺 records 时不落本地 idempotency 文件。

### W3：六阶段状态流转与 API 交互闭环

**目标**：API 能完整支持六阶段的“运行 → 门 → 裁决 → 消费 → 下一阶段”循环。

任务：

1. 为每个阶段定义可展示的 `StageAction`：
   - `run`；
   - `view-artifact`；
   - `claim-gate`；
   - `decide-gate`；
   - `reenter`；
   - `retry-storage`；
   - `none`。
2. API view 增加派生但不伪造事实的 `nextAction` / `blockingReason`，由服务端根据持久化状态计算；
3. `gate-failed` 升级任务与普通阶段人工门使用不同类型或明确 `isEscalationTask` 字段；
4. 统一“取消后台运行”和“取消人工门任务”两个操作的返回语义；
5. 门任务裁决后只写裁决事实，下一次 `run` 才消费；
6. `changes-needed` 必须要求说明；
7. `rejected`、`cancelled`、`gate-failed`、`review-failed` 终态不能显示批准按钮；
8. `reenter` 必须要求正确 digest，并在锁内完成检查；
9. execute 必须继续使用真实 executor 记录，不允许 Web 端写执行结果；
10. report/archive 必须展示真实产物和归档结果，不能只显示“已完成”。

建议的状态响应扩展：

```ts
interface PipelineRunView {
  ...existingFields
  readonly currentStage: StageId | null
  readonly nextAction: 'run' | 'view-artifact' | 'claim-gate' | 'decide-gate' | 'reenter' | 'retry-storage' | 'none'
  readonly blockingReason: string | null
  readonly gateKind: 'stage' | 'escalation' | null
  readonly stale: boolean
}
```

`nextAction` 必须由检查点、任务、产物和后端状态推导，不能由浏览器上一次状态推断。

失败路径测试：

- 六阶段逐阶段推进并断言每次 cursor/nextStage；
- 每种人工裁决路径；
- 门任务重复裁决；
- 冲突后页面刷新；
- gate-failed 升级任务不能被当成阶段批准；
- 预算失败不进入普通人工门；
- execute 无执行记录阻断；
- report/archive 缺上游产物阻断；
- 重入旧 digest 拒绝，新 digest 成功；
- 进程重启后 waiting-human 不自动批准。

### W4：重做 Web UI 信息架构与交互

**目标**：从“长页面调试表单”升级为“当前任务导向的单机控制台”。

目标文件：

```text
web-app/public/index.html
web-app/public/app.js
web-app/public/styles.css
```

推荐不引入前端框架，继续使用原生 DOM；若 DeepSeek 认为需要依赖，必须先报告依赖、体积、离线运行和安全影响，未经确认不得引入。

页面结构：

```text
AppShell
├── TopBar
│   ├── Brand
│   ├── ServiceHealth
│   ├── PipelineSelector
│   └── Refresh/ConnectionState
├── PipelineSummary
│   ├── tenant/project/pipeline
│   ├── status/currentStage/nextAction
│   └── primaryAction
├── StageStepper
├── MainWorkspace
│   ├── CurrentTaskCard
│   ├── ArtifactViewer
│   ├── GateReviewPanel
│   └── FailureRecoveryPanel
├── UsageBudgetPanel
├── EventTimeline
└── AdvancedDetails
    ├── manifest summary
    ├── raw machine violations
    └── backend/diagnostic information
```

交互要求：

1. 首屏没有 pipeline 时显示“创建/打开”向导，而不是空表格；
2. 创建表单分为基本信息、需求输入、被测服务、运行选项；
3. 脱离 API Key 输入；明确提示凭据由服务端注入；
4. 创建成功自动打开该 pipeline；
5. URL 使用 `?pipelineId=` 或 hash 仅保存导航上下文，不保存运行状态；
6. 列表支持按项目/状态筛选；
7. 轮询只更新当前事实，不能覆盖用户正在查看的产物或展开面板；
8. 请求中按钮禁用并显示进度；
9. 409 自动刷新当前 pipeline/gate；
10. 503 显示“存储暂不可用”，提供重试，不显示空列表；
11. 页面重启/刷新后恢复到同一 pipeline；
12. 当前阶段变化时，在不打断用户阅读的前提下更新“当前任务卡”；
13. 产物查看器对 JSON、长文本、数组、机器违规、findings 使用可折叠结构；
14. 所有服务端内容安全渲染，禁止 `innerHTML` 拼接不可信内容；
15. 键盘可操作、焦点可见、按钮有明确禁用态、颜色不作为唯一状态信息；
16. 移动宽度下六阶段 Stepper 可横向滚动，门任务按钮不溢出；
17. 使用 aria-label/role/aria-live 展示状态变化；
18. 自动刷新可暂停，暂停后页面明确标记“已暂停，数据可能过期”。

UI 不得出现：

- “已完成”但流水线实际是 queued/running；
- 没有产物时显示空对象；
- gate-failed 显示“请批准”；
- 失败状态没有错误原因；
- 轮询异常覆盖掉已有的最后一个可信状态；
- 把 HTTP 202 显示成阶段 completed；
- 将 gate decision 直接等同于阶段已完成。

### W5：单机运行、恢复与数据生命周期

**目标**：用户可以在本地单机完成完整生命周期，重启后不丢事实。

任务：

1. 提供一个明确的本地启动说明和最小环境变量模板；
2. 服务启动自动创建数据根下必要目录，数据根之外不写业务状态；
3. 支持：创建 → 运行到门 → 关闭进程 → 重启 → admin recover → 继续；
4. recover 使用与 service 同一 index store 和 file backend；
5. recover 不替真人裁决，不自动批准；
6. 后台运行句柄只保存在内存，事实仍来自 checkpoint/artifact/task/event/usage；
7. 取消后台运行后，页面显示“取消信号已发送/当前运行已结束”，不能虚构已取消阶段；
8. 本地数据损坏时显示可操作诊断，不能静默清空；
9. 提供数据根体检命令/接口，至少报告：
   - 配置不可读；
   - checkpoint 损坏；
   - 门任务损坏；
   - 索引损坏；
   - usage 损坏行；
   - 锁残留；
   - 版本过高。

### W6：完整 Web 验收与交付文档

**目标**：把本轮结果变成 DeepSeek 可逐条执行的验收证据。

必须新增或更新：

```text
test/web-single-node-product.test.ts
test/web-ui-contract.test.ts 或等价浏览器无框架测试
README.md
docs/15-web-api-and-state-contract.md
docs/16-local-single-node-runbook.md
```

至少覆盖：

1. 启动服务成功；
2. 健康接口不泄露 pipeline ID；
3. 创建流水线返回 202；
4. Web 列表、详情、恢复使用同一索引事实；
5. 六阶段逐阶段推进；
6. 每个阶段人工门批准；
7. changes-needed 打回并再次运行；
8. rejected 终止；
9. machine gate failure 显示升级任务；
10. review-failed 终态；
11. execute 真实执行数据对账；
12. 缺少执行数据拒绝；
13. 产物不存在返回 404，不返回空对象；
14. 产物读取、机器违规、findings 安全显示；
15. 事件时间线与持久化事实一致；
16. usage/预算与 CLI 一致；
17. 进程杀死后 recover；
18. 重启后不自动批准；
19. 并发裁决冲突；
20. storage unavailable 返回 503；
21. trust headers 误配被拒或有明确警告；
22. body NaN/超限配置启动失败；
23. 默认单机文件布局兼容；
24. 浏览器刷新后仍能打开同一 pipeline；
25. UI 所有主要操作有 loading/error/success 状态。

---

## 4. API 契约要求

### 4.1 保留并校验现有接口

```text
GET  /health
GET  /api/pipelines
POST /api/projects/:projectId/pipelines
GET  /api/pipelines/:pipelineId
POST /api/pipelines/:pipelineId/run
POST /api/pipelines/:pipelineId/cancel
GET  /api/pipelines/:pipelineId/gates
GET  /api/pipelines/:pipelineId/events
GET  /api/pipelines/:pipelineId/usage
GET  /api/pipelines/:pipelineId/stages/:stageId/artifact
POST /api/pipelines/:pipelineId/reenter
POST /api/gates/:gateTaskId/claim
POST /api/gates/:gateTaskId/decide
POST /api/gates/:gateTaskId/cancel
POST /api/admin/recover
```

### 4.2 所有返回必须带稳定语义

- `202`：请求已登记/后台任务已触发，不代表阶段完成；
- `200`：查询或同步事实成功；
- `400`：请求字段不合法；
- `401`：身份缺失；
- `403`：调用者自身权限/白名单不足；
- `404`：不存在或跨作用域隐藏；
- `409`：状态冲突、过期 digest、并发裁决冲突；
- `503`：存储、配置或外部基础设施不可用。

### 4.3 可考虑新增的只读接口

只有在现有接口不足以支持 UI 时才新增，且必须先写契约测试：

```text
GET /api/pipelines/:pipelineId/summary
GET /api/pipelines/:pipelineId/diagnostics
GET /api/pipelines/:pipelineId/stages/:stageId/decisions
```

不得新增一个只在 Web 内存中存在的状态接口。

---

## 5. DeepSeek 执行纪律

### 5.1 每个子任务的固定流程

1. 先执行并记录：
   ```bash
   git status --short
   git log --oneline -8
   git rev-parse HEAD
   git rev-parse origin/main
   ```
2. 读取对应设计文档、接口、实现、测试；
3. 先写失败测试；
4. 实现最小修改；
5. 运行专项测试；
6. 运行 typecheck；
7. 运行 build；
8. 运行全量测试；
9. 如果改了 `web-app/` 或 `src/web/`，补跑 Web HTTP e2e；
10. 更新 README、docs/15、docs/16 和本文件状态；
11. 单独提交；
12. 提交后核对 `HEAD == origin/main`。

### 5.2 禁止事项

- 不要把 `list()`、recover、CLI、Web 各自实现一套索引扫描；
- 不要让自定义 backend 缺端口时静默落到本地文件；
- 不要把 `gate-failed` 升级任务当普通人工门；
- 不要用前端 `setTimeout` 代替持久化状态消费；
- 不要把 202、queued、running 显示成 completed；
- 不要改机器门禁规则来让 UI 测试通过；
- 不要为了视觉效果伪造空 artifact、空 findings 或空 execution record；
- 不要删除或 skip 失败测试；
- 不要在 `server.mjs` 重写 PipelineDriver 逻辑；
- 不要引入 Harness 核心依赖；
- 不要启用真实 API Key 作为测试前置条件；
- 不要把 localhost 的代理 502 当作 Web 服务故障；HTTP 冒烟使用 `curl --noproxy '*'`。

### 5.3 提交说明固定要求

每个提交正文必须回答：

1. 改了哪些文件？
2. API、状态、路径、落盘字段有什么变化？兼容策略是什么？
3. 是否新增 Harness 或其他运行时依赖？
4. 是否改变自动批准、权限、跨租户、路径、凭据行为？负向测试是什么？
5. 新增了哪些失败路径测试？逐项列出名称。
6. `tsc --noEmit`、build、全量测试的 pass/fail/skip 原始结果是什么？
7. Web、CLI、重启是否继续读同一份持久化事实？证据是什么？
8. 未完成项、竞态窗口、迁移/回滚风险是什么？

---

## 6. 完成判定

只有同时满足以下条件，才能把本轮标为完成：

- [ ] W0~W6 全部完成；
- [ ] Web API 契约文档已更新；
- [ ] 六阶段每条正向/负向路径都有测试；
- [ ] `list/get/recover` 使用同一索引事实；
- [ ] 单机启动配置严格校验；
- [ ] `/health` 不泄露 pipeline ID；
- [ ] UI 不显示假状态、假成功、空产物；
- [ ] 人工门和升级任务在 UI 上明确区分；
- [ ] 真实执行、预算、事件、产物均可回读；
- [ ] 重启恢复不自动批准；
- [ ] `tsc --noEmit` 通过；
- [ ] `tsc -p tsconfig.build.json` 通过；
- [ ] 全量测试通过；
- [ ] Web HTTP e2e 通过；
- [ ] 单机运行手册可以让新用户从零启动并完成一条流水线；
- [ ] 当前仍未完成的 M4-B、M5 8c、M5 10b 不得被写成已完成；
- [ ] 工作区干净，`HEAD == origin/main`。

**本轮完成后的准确表述应是：**

> “Web 端已达到本地单机运行标准，六阶段流转、人工门、执行证据、恢复、预算和 UI 交互均有可复核实现与测试；生产化外部后端、公网真实被测系统和真实跨天运行仍未包含在本轮完成范围内。”
