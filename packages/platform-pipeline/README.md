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
| `web/` | 无 HTTP 框架依赖的 `PipelineRunService`：作用域/身份校验、配置装载与缓存、宿主装配、检查点与人工门驱动的 create/get/list/run/reenter/gate-*/artifact/events；Web 状态与阶段视图（12 字段）全部由持久化事实重建。另有 `pipeline-run-registry.ts`（进程内运行句柄，**刻意不导出状态查询**，只存句柄与取消信号）与 `async-runner.ts`（触发/取消/进程重启后的恢复扫描，`decideRecovery` 为纯函数） | 10 §4/§5 |

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
| 核心（`.`、`/runtime`、`/documents`、`/web`） | `yaml` + `fflate` + `pdfjs-dist` | 不引用任何 `@deepseek-ai/*`；根入口的公开类型面也不含 cordis 类型 |
| Harness 适配层（`/harness`、`/harness-plugin`） | `@deepseek-ai/dsh-tools`、`@deepseek-ai/dsh-timeout` + 类型级 cordis/dsh-agent/dsh-llm/dsh-subagent/dsh-user-questions | 声明为 **optional peerDependencies**，harness-free 消费者不会被强制安装 |

两个文档解析依赖的许可证与体积已按 docs/10 §5.6.9 记录在 `docs/adr/0001-document-parsing-libraries.md`：`fflate`（MIT，零依赖）与 `pdfjs-dist`（Apache-2.0，零依赖，解压约 33 MiB 且**懒加载**——只有真的解析 PDF 时才 `import()`，markdown/csv 路径不受影响）。

因此：`import 'platform-pipeline'`、`platform-pipeline/runtime`、`platform-pipeline/documents`、`platform-pipeline/web` 在任何环境都可直接使用；只有 `platform-pipeline/harness` 与 `platform-pipeline/harness-plugin` 需要宿主自行安装上表的 Harness 包。这四条不变量由 `test/harness-isolation.test.ts` 持续守卫（核心零引用、peer 声明与实际引用一致、`src/e2e` 不进发布物）。

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

- 设计文档：9 份定稿（docs/01~09）+ 24 条决策（docs/07）+ 下一阶段实施规划（docs/10）+ 1 份 ADR（docs/adr/0001 文档解析库选型）
- 确定性代码层：已覆盖核心编排、执行可信、知识库治理和通用平台基础，当前 **553 项测试全绿**
  - 注：在受限沙箱里跑全量 `node --test` 时，`test/fs-tools.test.ts` 的清理步骤可能被宿主 `safe-delete` 批量删除守卫拦下（按「每轮删除次数 > 阈值」判定，与代码无关）。单独运行该文件即通过。
- 宿主接线：完成（minimal-host）；真实 LLM 六阶段端到端通过，含重入级联 + 故障注入（里程碑 7）
- Web 运行服务（M0 契约层）：`platform-pipeline/web` 提供无 HTTP 框架依赖的 `PipelineRunService`，覆盖 create/get/list/run/reenter 与人工门 list/claim/decide/cancel，以及 `getStageArtifact`/`listEvents`/`scanPipelineIndex`；Web 状态与阶段视图全部由检查点、产物与人工门任务重建，服务层不复制阶段逻辑。
- **Web 接入（P0-B 完成，docs/10 §5）**：`web-app/` 是这套 runtime 的 **HTTP 外壳**（不再是独立的浏览器演示实现），按 §5.4「持久化状态 + 进程内触发器」工作——HTTP 触发立刻 `202`，后台跑 driver，人工门以 `waiting-human` 让出控制权，进程重启后由 `POST /api/admin/recover` 扫描恢复。
  - **凭据边界**：API Key 只由服务端按配置里的 `apiKeyEnv` 从环境变量注入，浏览器既不上传也读不到；`configRef` 是服务端白名单逻辑引用（否则等于开放任意文件读取）。
  - **身份边界**：默认**不信任**任何请求头（`PLATFORM_TRUST_ACTOR_HEADERS=1` 才读 `x-actor-*`，且缺 `x-actor-id` 即 401）；后台运行身份**刻意不声明 roles**，因此「后台不得替人裁决」是机器保证而非约定。
  - 接口：`GET /health`、`GET/POST /api/pipelines*`（create `202`、`run`/`cancel` `202`、`gates`、`events`、`stages/:id/artifact`（无产物 `404`）、`reenter`）、`POST /api/gates/:id/{claim,decide,cancel}`、`POST /api/admin/recover`。
- **并发安全与幂等（P0-C 完成，docs/10 §6）**：`checkpoint-lock.ts` 从 best-effort 目录锁升级为可审计、可恢复、不会误删他人锁的运行互斥。
  - **锁路径唯一**：`pipelineLockPath(checkpointRoot, pipelineId)` = `checkpoints/<pipelineId>/.pipeline.lock`，CLI / Web / Harness 三个入口共用同一函数——此前 Web 传 per-pipeline 目录、Harness 传 checkpoints 根，拼出的路径不同，等于没锁（§6.2 第 5 条）。
  - **不会被误抢**：stale 判定**只看 `heartbeatAt`**（不看 `acquiredAt`），锁按 `staleMs/3` 自动续租，因此跑 7 小时的流水线不会被判成死锁；`kill -9` 则由「同主机 + `pid` 不存在」判据立即接管，不必等 6 小时。
  - **不会误删**：release/renew 同时校验 `ownerId` + `generation`（`generation` 落盘在锁目录**外面**，释放后不归零，同一 ownerId 的两次持有也能区分）；抢占不做 `rm -rf`，而是「读→确认→原子改名到唯一墓碑→再确认→才递归删除」，发现对方刚续租就把墓碑改名放回并记 `stale-refused`。
  - **幂等键（§6.3 M2-3）**：`pipeline create` = `tenantId/projectId/pipelineId`、`human gate decision` = `gateTaskId/decisionId`、`executor invocation` = `pipelineId/caseId/inputDigest`。重复投递返回**首次结果**而不是报错或重复执行；同一把键换了内容则以 `conflict` 拒绝（§5.3「绝不静默复用」仍然成立）。`executor_run` 的 `inputDigest` 含 design 产物摘要与 `targetBaseUrl`，因此"设计变了/换了被测服务"是新一轮执行，而重试是重放。
  - **不产生不可对账记录**：executor 会话与幂等台账均原子落盘（tmp→rename）；重复执行同一批用例不再往会话里追加第二条同用例记录（那会被 R4-08 判成 `unexecuted record ... (多余执行)`）。
  - 双进程与 kill/restart 由 `test/concurrency.test.ts` 用**真实子进程**守卫（互斥、SIGKILL 后立即接管、跨进程抢占、release 不误删他人锁、无 `.stale-*` 残留）。
- 文档解析（P0-A1 完成）：`documents/` 已提供注册表 + 统一中间表示 + **PDF/DOCX/XLSX/Markdown 四类必支持格式** + 文本族与分隔符表格解析器；`parse_doc` 走注册表，返回 `status`/`confidence`/`sections`/`tables`/`plainText`/`sourceRefs`/`diagnostics`/`limits`，并按 §5.6.8 不回传原始字节。`.doc`/`.xls` 按 ADR-0001 §9 显式 `unsupported` 并给出定向转换提示。
  - `sourceRef` 四级可追溯：`requirements.pdf#page=3`、`spec.docx#heading=1.1,table=1,row=2`、`cases.xlsx#sheet=接口!A2:F20`、`cases.csv#table=1,row=2`。
  - 不伪装：无文本层 → `partial` + `NO_TEXT_LAYER`；无缓存公式值 → `FORMULA_VALUE_UNAVAILABLE` 且**绝不自行计算**；无解析器 → `unsupported`；二进制族 magic 不匹配 → **绝不退回按文本读**。
  - 安全：OOXML 走白名单解包（不读的字节不可能造成危害）+ 逐块实际字节硬上限（不信任 ZIP 声明值）+ 路径穿越即拒绝 + 全内存不落盘；自研 XML 分词器不做实体扩展，XXE 与实体爆炸**构造上不可能**；宏/嵌入对象/ActiveX/外链在解包阶段出局。
- Harness 解耦由 `test/harness-isolation.test.ts` 守卫：核心源码零 `@deepseek-ai/*` 引用、适配层依赖全部声明为 optional peer、`src/e2e` 不进构建产物。
- 当前阶段不生成 tgz 打包产物；通用核心默认入口不加载 Harness 适配层，Harness 宿主代码通过 `platform-pipeline/harness` 与 `platform-pipeline/harness-plugin` 可选子路径使用。
- `FileTaskStore` / `FileHumanGateTaskStore` 通过原子 JSON 文件记录任务状态、worker lease、heartbeat 和人工门决策；适合作为单机/单数据根实现，分布式部署仍需数据库或队列后端。
