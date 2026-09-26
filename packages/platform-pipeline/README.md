# platform-pipeline

测试辅助平台六阶段流水线插件包（设计文档见仓库根 `docs/`，实现骨架见 `docs/09-implementation-skeleton.md`）。

六阶段：需求接收 → 需求分析 → 测试设计 → 测试执行 → 测试报告 → 产物归档。核心运行时**不依赖任何 Harness 包**（仅 `yaml` + 文档解析用的 `fflate`/`pdfjs-dist`），DeepSeek Harness 作为可选适配层通过 `platform-pipeline/harness` 子路径接入；**独立 npm 包**部署（I-4：任何人任何平台可部署）。

## 架构一句话

> 契约定边界、门禁管产物、ACL 管动作、executor 保执行可信、检查点保恢复、人工门保责任、agent 只管自己那一阶段。

## 模块（src/）

| 模块 | 内容 | 设计文档 |
|---|---|---|
| `types.ts` | 流水线配置 / 检查点 / 产物核心类型；STAGE_ORDER / STAGE_UPSTREAMS | 02 |
| `config.ts` | pipeline.yaml/json → PipelineConfig（默认预算/门/规则/交叉检查；规则范围展开） | 02 |
| `checkpoint.ts` | 检查点原子读写（tmp→rename） | 02/03 |
| `checkpoint-lock.ts` | 跨进程运行互斥锁：`mkdir` 独占目录 + `owner.json`（`ownerId`/`generation`/`pid`/`host`/`acquiredAt`/`heartbeatAt`）；自动续租；release/renew 同时校验 `ownerId`+`generation`；stale 恢复双判据（同主机 pid 已死 → `dead-holder` 立即接管；否则看 `heartbeatAt` 超期）；抢占走「确认→原子改名→再确认→才删除」并落 `pipeline-lock-audit.jsonl` | 10 §6.3 M2-1 |
| `idempotency.ts` | 稳定幂等键（`sha256(namespace + 规范化字段)`）与文件幂等台账：命中即重放首次结果、同键不同内容 → `conflict`、`wx` 独占写实现"先写者胜"、损坏记录不锁死键 | 10 §6.3 M2-3 |
| `acl.ts` + `tool-catalog.ts` | 生效 ACL（平台标准 + 项目 delta）+ 工具目录；校验未知工具/降级标准 deny | 06 |
| `gates/` | 机器门禁引擎：JSON Schema 子集校验器 + G-01~08 规则（含 G-08 摘要锁） | 01 |
| `driver.ts` | PipelineDriver 编排核心：恢复续跑 / 门禁重试 / 人工门 / 交叉检查 / 重入级联 | 09/03 |
| `stage-spawner.ts` | StageSpawner 接口 + 生效 ACL 解析 + 运行上下文推导 | 09/06 |
| `harness/` | HarnessStageSpawner：`ctx.subagents.start` + toolFilter 映射；`runtime-config.ts` 统一 provider 能力/API Key 校验与项目存储根；execute 走 `startContinuable` 后台可续跑 + `listChildren` 轮询 | 09/06/平台化 |
| `executor/` | 执行可信：时序链（R4-09）/ 对账（R4-08）/ 证据锚定（R4-10）/ HttpExecutor（wire 留痕）/ env_diag 探针 | 08 |
| `stores/` | FsArtifactStore / FsCheckpointPort / MarkdownKnowledgeStore / MarkdownCaseStore（版本化回流） | 02/07 |
| `report/` | 报告渲染器（六段人读报告，确定性代码） | 02/12 |
| `execute/` | manual 执行会话模型（4h 窗口 / R4-11a / 失败必注） | 08/04 |
| `prompt/` | 公共骨架 + 六阶段差异段 + 审核 prompt（必查清单） | 04/05 |
| `plugin.ts` | cordis 插件入口：装配确定性组件，注册 `ctx.pipeline` 服务。**公开签名不含 cordis 类型**（用结构化 `PluginHostContext`），因此根入口对 harness-free 消费者零类型依赖 | 09 |
| `provider-registry.ts` | 通用 OpenAI-compatible provider 声明、环境变量密钥检查与能力选择 | 平台化 |
| `platform-scope.ts` | tenant/project/environment 作用域和安全数据目录 | 平台化 |
| `knowledge-import.ts` | Markdown 章节、CSV/TSV 表格导入为 draft 知识条目 | 平台化 |
| `documents/` | 文档解析注册表与统一中间表示：格式检测（magic bytes 优先）/ 限额与超时 / 安全解包（白名单 + 逐块硬上限 + 路径穿越即拒绝）/ **PDF**（`pdfjs-dist`，按页 `#page=N`，不产出表格）/ **DOCX**（标题三级判据、列表、表格、合并单元格不复制内容、页眉页脚不并入正文、宏与嵌入对象不解压）/ **XLSX**（两趟解包、日期/布尔/错误/公式按缓存值、隐藏 sheet 默认不读、`#sheet=接口!A2:F20`）/ Markdown·CSV·TSV·TXT·YAML·JSON 解析器 / `ParsedDocument` → draft 知识投影。CLI、Web、Harness 三入口共用 `defaultParserRegistry()` | 10 §5.6 |
| `documents/xml.ts` + `documents/zip-reader.ts` | OOXML 的唯一 XML 与 ZIP 入口：自研分词器不做实体扩展（XXE 与实体爆炸**构造上不可能**）；白名单解包使不读的字节不可能造成危害；不信任 ZIP 声明值，按逐块实际字节执行硬上限 | 10 §5.6.5 / ADR-0001 |
| `runtime/` | 无 Harness 的 StageRunner / LlmClient / ToolRegistry / HumanGate 端口、ScriptedStageRunner、OpenAICompatibleClient、OpenAIStageRunner、TaskStore 与 HumanGateTaskStore、平台标准工具集（`parse_doc`/`kb_*`/`case_*`/`executor_run`/`env_diag`/`req_pull`/`gate_check`） | 方案一 |
| `usage.ts` | 预算计量与运行遥测：`UsageEvent`（字段集封闭）/ `UsageStore` + append-only JSONL 文件实现（`usage/<pipelineId>.jsonl`，损坏行**显式**返回 `skipped`）/ `UsageRecorder`（补 scope、`eventId`、由两侧时间戳算 `durationMs`）/ `StageBudgetExceededError` / `summarizeUsage` 纯函数（按阶段分组 + `exceeded` 与 `budgetFailures` 双来源 + `tokensAvailable`）。**强制约束发生在内存，落盘只是尽力而为的观测**（`recordUsage` 吞异常） | 10 §7 |
| `storage/ports.ts` | **存储端口统一面**：9 个端口（`ArtifactStore`/`CheckpointPort`/`TaskStore`/`HumanGateTaskStore`/`UsageStore`/`AuditEventStore`/`KnowledgeStore`/`CaseStore`/`PipelineLock`）+ `StorageBackend`（端口/版本/体检/迁移）+ 记录信封（`STORAGE_SCHEMA_VERSION`、`withSchemaVersion`/`checkAndStripSchemaVersion`）+ 两类存储错误（`StorageUnavailableError` = 基础设施故障、`StorageCorruptError` = 这份数据不能用了）+ `StorageDiagnostic` 六种诊断码 + `assertBackendPorts` 装配校验。核心规则只依赖这里，不依赖任何具体后端 | 10 §8.2 |
| `storage/file/` | 文件后端装配：`createFileStorageBackend()` + `diagnose()`（六种诊断码，产物只扫 `<artifactsRoot>/artifacts/**`，不从项目根递归）+ `migrate()`（先备份到 `backups/migration-<ts>/`、幂等、逐条报告、损坏只跳过）+ `fileAuditStore()`（append-only `audit.jsonl`，文本脱敏 + 敏感字段名整体丢弃）。**产物/知识条目/JSONL 日志不迁移**（各有明确理由，写在 `migrate()` 的 doc 里） | 10 §8.3 M4-A |
| `storage/memory/` | 内存后端：**不是测试替身而是真后端**（底下是"键 → JSON 文本"的原始层，端口在其上做解析→版本校验→形状校验），因此 `diagnose`/`migrate`/损坏语义与文件后端同构。用途：证明端口可替换、单元测试、本地演示。**不作为生产后端**（进程结束即丢数据，锁只在进程内有效） | 10 §8.4 |
| `storage/compose.ts` | `composeStorageBackends()`：把 records（PostgreSQL）与 objects（对象存储）拼成一个完整后端。做四件必须有唯一落点的事：版本一致性校验、端口冲突显式化（不替宿主猜优先级）、能力声明合并、装配即校验必需端口；`portOrigins` 用于排障（"这个端口是谁提供的"） | 10 §8.3 M4-B / ADR-0002 |
| `storage/postgres/` | PostgreSQL **接口层**（不引 SDK、不建连）：`PostgresClient` 接缝（`query`/`transaction`，SDK 无关）、`postgresSchemaDdl()` 表结构（8 张表，含 CAS 用的 `revision` 与 `generation`）、`POSTGRES_PORT_TABLES` 端口↔表映射、`POSTGRES_TRANSACTION_BOUNDARIES` 事务边界（含"产物先写、检查点后写"的跨存储顺序论证）、`classifyPostgresError()` 按 SQLSTATE 分类。未配置时 `requirePostgresClient()` **明确抛 `StorageUnavailableError`，绝不降级到文件后端** | 10 §8.3 M4-B / ADR-0002 |
| `storage/object-store/` | 对象存储 **接口层**（不引 SDK、不建连）：`ObjectStoreClient` 接缝、**对象键约定**（`artifacts/`·`evidence/`·`knowledge/`·`cases/`，构造函数而非文档散文）、键安全校验（`..`/绝对路径/空段/未知根前缀/跨项目一律拒绝——对象存储没有目录树，只能自己拦）、`classifyObjectStoreError()`。**不承担**需要 CAS 的端口（检查点/任务/门任务/用量/审计/锁），那些必须在 PostgreSQL 里 | 10 §8.3 M4-B / ADR-0002 |
| `web/` | 无 HTTP 框架依赖的 `PipelineRunService`：作用域/身份校验、配置装载与缓存、宿主装配、检查点与人工门驱动的 create/get/list/run/reenter/gate-*/artifact/events/usage；Web 状态与阶段视图（12 字段）全部由持久化事实重建。另有 `pipeline-run-registry.ts`（进程内运行句柄，**刻意不导出状态查询**，只存句柄与取消信号）与 `async-runner.ts`（触发/取消/进程重启后的恢复扫描，`decideRecovery` 为纯函数） | 10 §4/§5 |

## 使用

```bash
npm install        # 通用核心只需 yaml；Harness 适配器依赖作为 devDependencies 保留
npm test           # node --test（原生 TS，Node >= 24）
npm run typecheck  # tsc --noEmit
npm run cli -- validate --config ../../examples/pipeline.yaml   # 配置自检

# 无 Harness 的 OpenAI-compatible 客户端（API Key 只从环境变量读取）
export PLATFORM_LLM_API_KEY=...
# OpenAICompatibleClient 支持 tools、json_schema、超时和 429/5xx 重试
npm run cli -- knowledge-import --input ./docs/project.md --store ./knowledge --project demo-project
# CSV/TSV 同样支持，导入结果默认写为 draft 知识并携带 sourceRefs

# 预算与运行遥测查询（只读，不需要 API Key；无记录时返回全 0 而非报错）
npm run cli -- usage --config ../../examples/pipeline.yaml --data-root ../../data --pipeline-id demo-001

# 当前阶段按源码构建和宿主部署，不生成或依赖 tgz 打包产物
npm run build      # rm -rf dist && tsc -p tsconfig.build.json → dist/（不含 src/e2e）

# 配置中的 API Key 只从环境变量注入
export PLATFORM_LLM_API_KEY=...
# provider 能力和项目 scope 会在 pipeline 配置装载时校验
```

## 依赖分层

包分三层，依赖方向严格单向：**`harness/` → 核心 → 无外部框架**。

| 层 | 运行时依赖 | 说明 |
|---|---|---|
| 核心（`.`、`/runtime`、`/documents`、`/web`、`/storage`） | `yaml` + `fflate` + `pdfjs-dist` | 不引用任何 `@deepseek-ai/*`；根入口的公开类型面也不含 cordis 类型 |
| Harness 适配层（`/harness`、`/harness-plugin`） | `@deepseek-ai/dsh-tools`、`@deepseek-ai/dsh-timeout` + 类型级 cordis/dsh-agent/dsh-llm/dsh-subagent/dsh-user-questions | 声明为 **optional peerDependencies**，harness-free 消费者不会被强制安装 |

两个文档解析依赖的许可证与体积已按 docs/10 §5.6.9 记录在 `docs/adr/0001-document-parsing-libraries.md`：`fflate`（MIT，零依赖）与 `pdfjs-dist`（Apache-2.0，零依赖，解压约 33 MiB 且**懒加载**——只有真的解析 PDF 时才 `import()`，markdown/csv 路径不受影响）。

因此：`import 'platform-pipeline'`、`platform-pipeline/runtime`、`platform-pipeline/documents`、`platform-pipeline/web`、`platform-pipeline/storage` 在任何环境都可直接使用；只有 `platform-pipeline/harness` 与 `platform-pipeline/harness-plugin` 需要宿主自行安装上表的 Harness 包。这四条不变量由 `test/harness-isolation.test.ts` 持续守卫（核心零引用、peer 声明与实际引用一致、`src/e2e` 不进发布物）。

## 宿主接线（已完成）

通用 Harness 宿主可优先传入：

```ts
await ctx.plugin(platformPipelineHost, {
  configPath: './pipeline.yaml',
  dataRoot: './data',
  providerName: 'primary',
})
```

宿主会根据 `scope.tenantId` / `projectId` 计算项目目录，校验 `llm.providers` 声明和 API Key 环境变量，再装配 artifacts、checkpoints、knowledge、cases。旧的 `artifactsRoot` + `checkpointRoot` 显式配置仍兼容。

`run`/`reenter` 需要宿主注入（`src/plugin.ts` 集成点，均标注）：

- **spawner**：`HarnessStageSpawner` + 当前会话的 parent Agent（`ctx.subagents.start`，API 已核实，见 docs/09 验证点）
- **human**：ui-user-questions 实现的人工门（A~G；D-01 二次机器判定）
- **review**：独立审核 agent（`outputSchema` 结构化输出）

最小宿主已落地（`src/e2e/minimal-host.ts`，**仅测试用，不进入构建产物**），真实外接 DeepSeek / 千问 六阶段端到端跑通（receive→analyze→design→execute→report→archive），含重入级联 + 故障注入审核 fail 回喂重跑闭环（见 `test/e2e/`）。它默认使用内置 e2e 配置；设置 `E2E_PIPELINE_CONFIG=/path/to/pipeline.yaml` 后会读取外部项目配置中的 `llm.providers`，并将 provider 的 baseUrl/model/apiKeyEnv 转换为 Harness LLM 插件配置，仍由 Harness 的 `deepseek-official` 适配路由承载 OpenAI-compatible 请求。

## 状态

- 设计文档：9 份定稿（docs/01~09）+ 24 条决策（docs/07）+ 下一阶段实施规划（docs/10）+ 2 份 ADR（docs/adr/0001 文档解析库选型、docs/adr/0002 存储后端选型与事务边界）
- 确定性代码层：已覆盖核心编排、执行可信、知识库治理和通用平台基础，当前 **729 项测试全绿**
  - 注：在受限沙箱里跑全量 `node --test` 时，`test/fs-tools.test.ts` 的清理步骤可能被宿主 `safe-delete` 批量删除守卫拦下（按「每轮删除次数 > 阈值」判定，与代码无关）。单独运行该文件即通过。
- 宿主接线：完成（minimal-host）；真实 LLM 六阶段端到端通过，含重入级联 + 故障注入（里程碑 7）
- Web 运行服务（M0 契约层）：`platform-pipeline/web` 提供无 HTTP 框架依赖的 `PipelineRunService`，覆盖 create/get/list/run/reenter 与人工门 list/claim/decide/cancel，以及 `getStageArtifact`/`listEvents`/`scanPipelineIndex`；Web 状态与阶段视图全部由检查点、产物与人工门任务重建，服务层不复制阶段逻辑。
- **Web 接入（P0-B 完成，docs/10 §5）**：`web-app/` 是这套 runtime 的 **HTTP 外壳**（不再是独立的浏览器演示实现），按 §5.4「持久化状态 + 进程内触发器」工作——HTTP 触发立刻 `202`，后台跑 driver，人工门以 `waiting-human` 让出控制权，进程重启后由 `POST /api/admin/recover` 扫描恢复。
  - **凭据边界**：API Key 只由服务端按配置里的 `apiKeyEnv` 从环境变量注入，浏览器既不上传也读不到；`configRef` 是服务端白名单逻辑引用（否则等于开放任意文件读取）。
  - **身份边界**：默认**不信任**任何请求头（`PLATFORM_TRUST_ACTOR_HEADERS=1` 才读 `x-actor-*`，且缺 `x-actor-id` 即 401）；后台运行身份**刻意不声明 roles**，因此「后台不得替人裁决」是机器保证而非约定。
  - 接口：`GET /health`、`GET/POST /api/pipelines*`（create `202`、`run`/`cancel` `202`、`gates`、`events`、`usage`、`stages/:id/artifact`（无产物 `404`）、`reenter`）、`POST /api/gates/:id/{claim,decide,cancel}`、`POST /api/admin/recover`。
- **并发安全与幂等（P0-C 完成，docs/10 §6）**：`checkpoint-lock.ts` 从 best-effort 目录锁升级为可审计、可恢复、不会误删他人锁的运行互斥。
  - **锁路径唯一**：`pipelineLockPath(checkpointRoot, pipelineId)` = `checkpoints/<pipelineId>/.pipeline.lock`，CLI / Web / Harness 三个入口共用同一函数——此前 Web 传 per-pipeline 目录、Harness 传 checkpoints 根，拼出的路径不同，等于没锁（§6.2 第 5 条）。
  - **不会被误抢**：stale 判定**只看 `heartbeatAt`**（不看 `acquiredAt`），锁按 `staleMs/3` 自动续租，因此跑 7 小时的流水线不会被判成死锁；`kill -9` 则由「同主机 + `pid` 不存在」判据立即接管，不必等 6 小时。
  - **不会误删**：release/renew 同时校验 `ownerId` + `generation`（`generation` 落盘在锁目录**外面**，释放后不归零，同一 ownerId 的两次持有也能区分）；抢占不做 `rm -rf`，而是「读→确认→原子改名到唯一墓碑→再确认→才递归删除」，发现对方刚续租就把墓碑改名放回并记 `stale-refused`。
  - **幂等键（§6.3 M2-3）**：`pipeline create` = `tenantId/projectId/pipelineId`、`human gate decision` = `gateTaskId/decisionId`、`executor invocation` = `pipelineId/caseId/inputDigest`。重复投递返回**首次结果**而不是报错或重复执行；同一把键换了内容则以 `conflict` 拒绝（§5.3「绝不静默复用」仍然成立）。`executor_run` 的 `inputDigest` 含 design 产物摘要与 `targetBaseUrl`，因此"设计变了/换了被测服务"是新一轮执行，而重试是重放。
  - **不产生不可对账记录**：executor 会话与幂等台账均原子落盘（tmp→rename）；重复执行同一批用例不再往会话里追加第二条同用例记录（那会被 R4-08 判成 `unexecuted record ... (多余执行)`）。
  - 双进程与 kill/restart 由 `test/concurrency.test.ts` 用**真实子进程**守卫（互斥、SIGKILL 后立即接管、跨进程抢占、release 不误删他人锁、无 `.stale-*` 残留）。
- **预算计量与运行遥测（P1-A 完成，docs/10 §7）**：`usage.ts` 把「强制约束」与「可审计用量」分开——**预算在内存里拦，用量落盘只是尽力而为的观测**。
  - **强制不依赖落盘**：运行器自己数工具步数、driver 自己数重试次数、阶段自己看墙钟；`recordUsage` 写盘失败被吞掉（磁盘问题不该把可观测性故障升级成业务故障），但也不"假装记上了"——失败即事件不存在，由 `skipped` 与日志本身判断计量是否完整。
  - **四类预算维度**：`maxSteps`（阶段内工具步数硬停）、`timeoutMs`（阶段 deadline）、`maxTestCases`（计量与报告；用例数由 design 产物决定，阶段内不做硬中断）、`maxRetries`（重试上限）。
  - **`maxSteps` 硬停的 `used` 口径**：循环用尽仍有未回喂工具调用时抛 `used = toolSteps + 1`——被拒绝那一刻模型**仍要求**再来一步；报 `toolSteps` 会得到 `used === limit`，与"超出预算"自相矛盾。
  - **阶段 deadline 用派生信号**：`budget.timeoutMs > 0` 才创建 `AbortSignal.timeout(timeoutMs)`，不与宿主取消信号互相污染；`timeoutMs: 0` 保持"不设 deadline"语义（**绝不是立即超时**），在判据层与实现层双重保证。宿主信号也 aborted 时不归因于预算（那是"用户取消"）。
  - **超限落盘复用 `gate-failed` 终态**：写 `failures[].kind='budget-exceeded'` + 机器违规 `R-BUDGET-EXCEEDED`（BLOCKING）并调 `human.gateFailed`——该升级任务 `artifactPath` 为空、`machineStatus=failed`，`findResumableTask` 永远不会把它当阶段门批准，因此「**绝不自动进入人工批准**」是机器保证而非约定。**不重试**（同一份预算再跑一遍只会再烧一次模型）。
  - **`maxRetries` 成为真实约束**：`gateRetryLimit = min(maxGateRetries ?? 2, budget.maxRetries)`、`reviewRetryLimit = min(1, budget.maxRetries)`——配置只能**收紧**部署方的全局兜底，不能放宽。
  - **review 独立预算**：审核的模型与工具调用一律记 `kind: 'review'`（工具调用另带 `toolName`），不记成 `llm`/`tool`，因此一次昂贵盲审不会让阶段看起来"步数用尽"。
  - **两个超限来源并存**：`exceeded`（读日志重算的口径，如一次响应批量调 30 个工具）与 `budgetFailures`（driver 当场停止落盘的权威事实）可能只出现其一，页面要都显示。`wallClockMs` 是**最早开始到最晚结束的跨度**，不是时长之和；`tokensAvailable = llmCalls > 0 && llmCallsWithUsage === llmCalls`（provider 未返回 usage 时不得当成 0 用量）。
  - **隐私边界**：用量事件只记计量数字与标识，**绝不写 API Key、完整 prompt、模型响应正文**；`usageErrorCode` 只映射固定枚举，**绝不返回 `error.message`**。
  - 接口：Web `GET /api/pipelines/:id/usage`、CLI `usage --config <yaml> --data-root <dir> --pipeline-id <id>`（只读、不需要 API Key；检查点缺失时重试事实按 0 计并返回 `checkpointFound: false`）。
- **存储端口与后端契约（P1-B 完成，docs/10 §8）**：持久化从"文件实现"提升为**可替换的端口**，核心规则只依赖 `src/storage/ports.ts` 的接口。
  - **端口可替换是被测出来的，不是声称的**：`test/storage-contract.ts` 是一份**后端无关**的参数化契约套件，被三个后端各跑一遍——`file`（31 项）、`memory`（32 项）、`compose`（44 项）。契约只断言"写入后能读回 / 缺失返回 null / 损坏显式失败 / 版本更高必须拒绝"这类语义，**不**断言目录名、文件名、原子 rename、JSONL 行号。只测一个后端时，任何偷偷依赖 fs 语义的实现都会在换后端那天才暴露。
  - **损坏与缺失是两个概念**：读不到（`ENOENT`）→ `null`（正常）；读坏了（JSON 非法 / 形状不符）→ **抛错**。混淆的后果很具体：检查点被当成"还没开始"而重跑并覆盖现场；用例记录被当成"没有历史版本"而被 archive 覆盖（静默丢数据）。这条修在 `loadCheckpoint` / `readJson` / `MarkdownKnowledgeStore` / `MarkdownCaseStore` 四处。
  - **两类存储错误分开**：`StorageUnavailableError`（连不上/没权限/磁盘满）与 `StorageCorruptError`（这份数据不能用了）。前者**绝不能**被 driver 归成门禁违规去让 agent 重做（重做一百次也写不进只读盘），也绝不能触发自动批准；Web 层映射成 `storage-unavailable`(503) 而不是 `run-failed`(500)，且走**类型判据**不走中文报错文本匹配（换后端时文本匹配会静默失效）。
  - **记录信封**：平台自有 JSON 记录带 `schemaVersion`。缺失 = 历史遗留 v1（可迁移）；等于当前 = OK；**低于**当前 = 可迁移；**高于**当前 = 必须显式失败（`StorageSchemaVersionError`），**绝不降级解析**。强制顺序是"先校验并剥掉版本 → 再做形状校验"——版本更高的记录字段可能全变了，先按当前版本解构会得到一堆 `undefined`，把"读不懂"伪装成"空数据"。
  - **体检与迁移**：`diagnose()` 返回六种诊断码（`missing`/`corrupt-json`/`schema-invalid`/`unsupported-version`/`migration-needed`/`unreadable`），**不抛异常**（单个坏文件不能打断整次体检）；`migrate()` 先备份（`backups/migration-<ts>/`）→ 失败不破坏原件 → 逐条报告（`skipped` 必带原因）→ **幂等**。产物/知识条目/JSONL 日志**不迁移**（改写产物等于篡改 agent 输出；知识元数据行本身就是领域条目；append-only 日志改写会破坏不可篡改）。
  - **审计与用量分离**：用量是**计量**（高频、可丢、写失败被吞）；审计是**责任链**（低频、必须可查、写失败上抛）。审计 append-only JSONL，读侧损坏行**显式返回** `skipped: [{line, reason}]`；脱敏双保险——文本里 `sk(?:k|-)`/`Bearer-` 形态的 token 替换为 `[redacted]`，字段名命中 `api_key|authorization|bearer|token|secret|password|credential` 整体丢弃。
  - **外部后端本阶段只交付接口层 + ADR**（`docs/10` §10 P1-B 第 3 条明确允许）：`storage/postgres/` 与 `storage/object-store/` 不引入任何数据库/对象存储 SDK、不做真实连接；交付的是接缝（`PostgresClient`/`ObjectStoreClient`）、表结构与索引、端口↔表/键映射、事务边界、错误分类。未配置时 `requirePostgresClient()` / `requireObjectStoreClient()` **明确抛 `StorageUnavailableError`**——**绝不静默降级到文件后端**（静默降级会让"数据到底写到哪了"变成无法回答的问题）。选型理由、迁移与回滚、以及 6 条**必须在端口层解决**的跨后端待对齐项见 `docs/adr/0002-storage-backends.md`。
  - **组合是必须的**：PostgreSQL 管不住 MB 级产物，对象存储给不了条件写（检查点/租约/门裁决/锁全是"读改写原子"）。`composeStorageBackends()` 把两者拼成一个后端，并在装配时就拒绝"端口冲突""版本不一致""缺必需端口"——不替宿主猜优先级。
  - **可重试语义有端到端证据**（§8.4）：产物写成功但检查点写失败时，driver **明确失败、不宣称阶段完成、不调用人工门**；存储恢复后重试能跑完六个阶段。顺序固定为"先写产物、后写检查点"——反过来会得到"声称完成但没有产物"，那才是不可恢复的。
- **审计整改批次 A 完成（docs/11 P1-01 / P1-02 / P1-03）**：
  - **运行清单（P1-01）**：`create` 请求里所有影响运行行为的参数（`targetBaseUrl`、`providerName`、`requirementInput`、`maxGateRetries`、门等待/TTL、`diagCredentials`）现在落进**持久化清单**——清单与流水线索引是**同一份文件、同一次原子写**（分成两个文件就会有两次写，中间崩溃留下半成品）。此前这些字段只被校验、不被保存，于是真实 execute 永远拿不到 `targetBaseUrl`，而 Web e2e 用的是脚本化宿主，看不到这个缺口。
    - 幂等指纹覆盖全部行为参数：同一 `pipelineId` 换了被测基址/provider/重试预算/探针就是另一次创建，返回 `conflict`(409) 而不是静默重放首次结果。
    - `targetBaseUrl` **建连前再复核一次**：清单是磁盘文件，可能被篡改或来自旧版本；`executor_run` 在发出任何请求之前调用宿主注入的同一份判据。
    - `diagCredentials` 只接受环境变量名（`/^[A-Za-z_][A-Za-z0-9_]{0,127}$/`），且**只存变量名、绝不存凭据值**。
    - 清单字段类型不符时显式失败（`storage-unavailable`）：把 `maxGateRetries: "lots"` 当成"没写"会让一次磁盘损坏伪装成"用了默认参数"。
  - **运维角色边界（P1-02）**：`assertGateRole` / `assertOperatorRole` / `assertAdminRole` 收敛到一处，service 与 HTTP 外壳共用。`reenter`、`cancelGate`、取消运行要求 `operator`/`admin`，`/api/admin/recover` 要求 `admin`。此前 `reenter`/`cancelGate` 只检查"actorId 非空"，任何只读调用者都能回退 cursor、取消门任务。判定**失败关闭**：未声明角色即拒绝。
  - **重入的乐观并发进锁（P1-03）**：`reenter` 的顺序改为「取锁 → 读检查点 → 读产物算 digest → 比较 → 重入 → 释放锁」。此前 digest 校验在锁外，两个进程可以各自"校验通过"然后先后写入，后写的静默覆盖先写的。
  - 剩余 P1/P2 项的状态见 `docs/11-m0-m4-audit-and-remediation-plan.md` 第 13 节（P1-04~P1-09、P2-02~P2-06 仍未修复）。
- 文档解析（P0-A1 完成）：`documents/` 已提供注册表 + 统一中间表示 + **PDF/DOCX/XLSX/Markdown 四类必支持格式** + 文本族与分隔符表格解析器；`parse_doc` 走注册表，返回 `status`/`confidence`/`sections`/`tables`/`plainText`/`sourceRefs`/`diagnostics`/`limits`，并按 §5.6.8 不回传原始字节。`.doc`/`.xls` 按 ADR-0001 §9 显式 `unsupported` 并给出定向转换提示。
  - `sourceRef` 四级可追溯：`requirements.pdf#page=3`、`spec.docx#heading=1.1,table=1,row=2`、`cases.xlsx#sheet=接口!A2:F20`、`cases.csv#table=1,row=2`。
  - 不伪装：无文本层 → `partial` + `NO_TEXT_LAYER`；无缓存公式值 → `FORMULA_VALUE_UNAVAILABLE` 且**绝不自行计算**；无解析器 → `unsupported`；二进制族 magic 不匹配 → **绝不退回按文本读**。
  - 安全：OOXML 走白名单解包（不读的字节不可能造成危害）+ 逐块实际字节硬上限（不信任 ZIP 声明值）+ 路径穿越即拒绝 + 全内存不落盘；自研 XML 分词器不做实体扩展，XXE 与实体爆炸**构造上不可能**；宏/嵌入对象/ActiveX/外链在解包阶段出局。
- Harness 解耦由 `test/harness-isolation.test.ts` 守卫：核心源码零 `@deepseek-ai/*` 引用、适配层依赖全部声明为 optional peer、`src/e2e` 不进构建产物。
- 当前阶段不生成 tgz 打包产物；通用核心默认入口不加载 Harness 适配层，Harness 宿主代码通过 `platform-pipeline/harness` 与 `platform-pipeline/harness-plugin` 可选子路径使用。
- `FileTaskStore` / `FileHumanGateTaskStore` 通过原子 JSON 文件记录任务状态、worker lease、heartbeat 和人工门决策；适合作为单机/单数据根实现，分布式部署仍需数据库或队列后端。
