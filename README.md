# 测试辅助平台设计（Test Platform Design）

平台型测试辅助系统设计文档集：六阶段流水线（需求接收 → 需求分析 → 测试设计 → 测试执行 → 测试报告 → 产物归档），基于 DeepSeek Harness 原语（subagent / toolFilter / session / ui-user-questions）。

## 一句话

> 契约定边界、门禁管产物、ACL 管动作、executor 保执行可信、检查点保恢复、人工门保责任、agent 只管自己那一阶段。

## Web 应用（仅需 API Key）

`web-app/` 是浏览器优先的可运行版本：不依赖 Electron、桌面端配置或本地模型，只需一个 OpenAI 兼容 API Key 即可启动六阶段测试辅助流水线。

```bash
cd web-app
node server.mjs
# 浏览器打开 http://127.0.0.1:3080
```

默认使用 DeepSeek 兼容端点；页面也支持修改 API Base URL 与模型名称。API Key 只在当前流水线运行期间驻留服务端内存，不写入浏览器存储、运行日志或阶段产物。执行阶段默认生成“待执行”计划，不会伪造被测系统的真实通过结果。

Web 版默认只允许访问公网模型端点，并限制单个来源同时运行 2 个任务；如明确需要连接本机 Ollama 或内网网关，可用 `ALLOW_PRIVATE_API=1 node server.mjs` 开启内网地址。生产部署还应在反向代理前增加登录鉴权、HTTPS、持久化存储和多进程任务队列。

```bash
# 可选：修改监听地址/端口
HOST=127.0.0.1 PORT=3080 node server.mjs
# 可选：允许本机或内网模型端点（只建议本地开发）
ALLOW_PRIVATE_API=1 node server.mjs
```

### 当前版本已补齐的运行保障

- 输入校验：JSON Content-Type、请求体大小、API Key 长度、Base URL 协议及凭据格式
- SSRF 防护：默认拒绝 localhost、私网、回环、链路本地和未解析为公网地址的模型端点
- 资源保护：单来源并发上限、运行记录数量上限、完成记录 TTL 清理
- 失败恢复：429 与 5xx 自动进行一次退避重试；服务商错误只返回截断后的错误信息
- 浏览器安全：移除通配 CORS，增加 CSP、`X-Frame-Options`、`nosniff`、`no-store` 等响应头
- Prompt 控制：上游产物上下文设有长度上限，避免多阶段内容无限膨胀

## 原始 harness 实现状态与本轮加固

本项目的核心实现位于 `packages/platform-pipeline`，Web 版只是额外的浏览器演示入口，不代表原始 harness 的全部能力。当前原始 harness 已完成以下高优先级加固：

- 阶段 `fs_read` / `fs_write` 统一限制在工作区根内，拒绝 `..`、绝对路径越界和软链接逃逸
- `executor_run` 按显式 `pipelineId` 精确选择 `design.json`，不再按 mtime 猜测；多项目共用目录时避免串读
- 执行会话和 evidence 支持按 pipeline 隔离目录；执行器写入证据路径受到根目录约束
- R4-08 对账新增 result.caseId 与 executor record.caseId 绑定校验
- R4-10 可选读取证据文件并重算 digest，检查文件越界、缺失和空文件
- artifact wrapper（pipelineId/stageId/inputs/digest/version/path）完整持久化，重启后不再依赖路径重新推导
- pipeline 配置支持文档中的 `stages: [{ id, ... }]` 数组形式，也兼容现有对象形式
- 门禁引擎按 `stage.rules` 选择规则；宿主装载时拒绝引用未实现的规则，避免配置与运行时静默漂移
- review agent 默认只允许 `fs_read`，拒绝写文件、执行器、子 agent 和归档写入
- 同一宿主进程内拒绝同一 pipeline 的并发 run/reenter
- execute prompt 要求 `executor_run` 显式带当前 pipelineId

目前仍未完成的后续项：宿主直接执行 CLI run/reenter、外部 Jira/Xray/TestLink 适配、host 侧预算计量，以及完整的跨进程 heartbeat/乐观版本检查。这些不应在文档中标记为“生产完成”。本轮已补充 CLI `validate/status` 和 R6-05 回读结果契约，`run/reenter` 仍必须通过宿主注入真人门与 stage spawner。

### 知识库 P0 闭环

- `kb_query`、`kb_write`、`case_query`、`case_archive` 已接入 `markdown-fs`；未配置时明确返回 `available: false`，不再用空数组伪装“查询成功但无结果”。
- KnowledgeEntry 支持 `kind/status/confidence/sourceRefs/scope/validUntil` 扩展字段；查询结果带 `score`、`matchedBy`、`matchedTerms`，便于 analyze 阶段判断来源和可信度。
- 知识库检索支持实体、标签和文本关键词，并按项目过滤；默认只消费 active 知识。
- archive prompt 要求记录本次写入的 `expectedIds`，再通过 `kb_query` 回读并写入 `verifiedIds/allExpectedHit`；R6-05 会检查是否命中本次归档的全部知识 ID，而不仅仅是任意旧条目。
- host-plugin 会根据 pipeline 配置自动解析 `stores.knowledge.path` 与 `stores.cases.path`，构造本地 Markdown 存储适配器。

### 通用平台基础能力

- `pipeline.yaml` 支持 `scope.tenantId/environment` 与 `llm.providers` 声明；API Key 只通过 `apiKeyEnv` 从宿主环境注入，不写入配置文件。
- `LlmProviderRegistry` 负责 provider 选择、环境变量检查和 tools/structuredOutput/streaming/continuation 能力校验；平台核心不直接发起模型请求。
- `resolveHarnessHostRuntime` 已接入 `harness/host-plugin.ts`：设置 `dataRoot` 后，Harness 宿主启动会自动选择 provider、校验 API Key/能力并计算项目存储根；显式 `artifactsRoot`/`checkpointRoot` 仍兼容旧单项目宿主。
- `minimal-host.ts` 支持 `E2E_PIPELINE_CONFIG`，可以从外部项目 YAML 读取 `llm.providers`，将 baseUrl/model/apiKeyEnv 配置传给 Harness LLM 适配器；未指定时才使用历史 e2e fallback。
- 方案一已落地：新增无 Harness 依赖的 `runtime` 端口（StageRunner、LlmClient、ToolRegistry、HumanGate）与 `ScriptedStageRunner`，可以仅用 PipelineDriver + 文件存储完成六阶段回归；默认包入口不再导出/加载 Harness 适配层，Harness 代码通过 `platform-pipeline/harness` 与 `platform-pipeline/harness-plugin` 可选子路径使用。
- runtime 已提供基于原生 `fetch` 的 `OpenAICompatibleClient`：API Key 可由环境变量注入，支持 tools、json_object/json_schema 结构化输出、超时、429/5xx 重试、tool calls/usage 解析和不泄露密钥的错误归一化。
- `OpenAIStageRunner` 已把 `assemblePrompt`、Stage ACL、受限 ToolRegistry、LLM tool-call 循环和 StageArtifact 落盘串起来；因此无需 Harness 即可用 OpenAI-compatible 模型驱动单阶段，再交给现有 PipelineDriver 门禁和人工门。
- runtime 新增 `FileTaskStore` / `FileHumanGateTaskStore`：持久化任务状态、租约、heartbeat、过期回收和人工门 claim/decision/expiry/cancel。
- `PersistentHumanGate` 把 driver 的阻塞式 `human.gate()` 变成**可恢复**的任务等待：先落盘 pending 任务再等待，外部 actor 通过 `claim()` + `decide()` 裁决。续用规则两条——未决任务（崩溃重启后继续等同一个门）与**已裁决但未被消费**的任务（人工在流水线未运行时完成裁决，下一次 run 直接认这条结论）；裁决一旦被消费（`consumedAt`）就不再复用，因此 `changes-needed` 打回重跑会正确开新门。`waitTimeoutMs: 0` 即「只轮询一次就让出控制权」，CLI 的挂起模式依赖它。
- 人工门的失败路径全部默认**抛错**，且降级策略在类型层排除了 `'approved'`（`GateDegradePolicy` 只有 `changes-needed` / `rejected` / `throw`）：等待被中止、任务被外部取消、任务过期都不会自动批准，宿主必须显式 opt-in 才会降级为某个裁决。
- `gateFailed` 只落一条升级任务（`machineStatus: 'failed'` + 空产物路径），因此永远不会被 `gate()` 误当作阶段门复用；配置 `waitOnGateFailed: true` 时才阻塞等待人工确认。
- driver 支持**在人工门上重启**：`awaiting-gate` 且产物仍可读时跳过 spawn 与重复盲审，直接复用既有产物重新过门禁并回到人工门。否则每次重启都会重复消耗模型预算，并把真人正在审核的那份产物替换成新版本（审核对象与批准对象错位）。
- `OpenAIReviewRunner` 补齐了无 Harness 的交叉检查：`assembleReviewPrompt` → LlmClient → 只读工具循环（默认只暴露 `fs_read`）→ 结构化审核报告；findings 出现 `blocker` 时强制 `fail`（不采信模型自报的 `pass`），审核不可用一律降级 `degraded` 而不阻塞流水线。
- `fsReadTool` / `fsWriteTool` 是阶段 prompt 要求「先写产物再结束」的落地依赖：路径相对工作区根解析并做 realpath 二次校验（拒绝绝对路径、`..` 越界和软链接逃逸），`fs_write` 只覆盖 `artifacts/<pipelineId>/`。
- `createPlatformHost` 把上述部件按 pipeline 配置装配成可直接运行的宿主（provider 由 `LlmProviderRegistry` 选择，API Key 只从环境变量注入）；`createCheckpointHost` 只装配检查点侧能力，因此 `reenter` 一类运维操作**不需要 API Key**。
- `buildPlatformTools` 补齐了平台 ACL 声明但宿主原先缺失的工具实现，使各阶段的 `allow` 真正可达（此前 analyze/execute/archive 拿到的工具集是空的）：`parse_doc`（md/txt/yaml 文本族、csv/tsv 结构化表格、json 归一化；xlsx/docx/pdf 等二进制显式报错而非返回乱码）、`kb_query`/`kb_write`、`case_query`/`case_archive`、`executor_run`、`env_diag`、`req_pull`、`gate_check`。全部建立在无框架依赖的 `stores/markdown.ts`、`executor/*`、`checkpoint.ts` 之上，Harness 宿主同样可复用。
- 工具实现遵循三条硬约束：**不伪装**（store 未配置返回 `available: false` 并附 `hint`，绝不返回空结果让模型误判"库里没有"；未配置 `targetBaseUrl` 时 `executor_run` 直接报错，不产出伪造的执行记录）、**不越权**（路径统一走 `WorkspaceScope` 的 realpath 包含性校验；证据落盘前剥离绝对路径前缀再校验，用例 id 里带 `../` 会被拒绝）、**不串流水线**（模型传入的 `pipelineId` 与宿主不一致即拒绝）。`kb_write`/`case_archive` 的 `project`/`sourcePipeline` 身份字段由宿主强制，不接受模型改写。
- `createExecutionLoader` 把 executor 的执行会话接进 driver：`execute` 阶段的门禁（R4-08/09/10）据此对账执行记录、时序链与证据指纹。会话缺失 = 尚未真实执行，门禁判定"未提供执行数据"并拦截，而不是放行一份没有执行证据的产物。
- `validateApprovalCoverage` 在启动时校验「需审批工具 ↔ 阻塞人工门」：阶段允许了 `kb_write`/`case_archive`（`requiresApproval`）却没有阻塞人工门 = 配置错误，立即失败；归档写库的批次审批由该阶段的人工门承担（docs/06 第 7 节）。
- CLI 新增 `run` / `reenter` / `gate-list` / `gate-claim` / `gate-decide` / `gate-cancel`：`run` 遇到人工门且 `--wait-ms` 内无人裁决时打印待办并以退出码 3 结束，裁决后再执行一次 `run` 即从该门续跑（产物不重生成、审核不重跑）。
- `projectDataRoot` / `scopedPath` / `resolvePlatformRoots` 为 Harness、CLI、Web 共享租户/项目目录边界，拒绝跨项目和 `..` 路径逃逸，并统一 artifacts/checkpoints/knowledge/cases 目录。
- `parseMarkdownKnowledge` 与 `parseDelimitedKnowledge` 支持 Markdown 章节、CSV/TSV 表格导入，统一生成 `draft` 知识条目并保留 `sourceRefs`；用例库仍由 `MarkdownCaseStore` 独立管理。
- CLI 提供 `knowledge-import --input <file> --store <knowledge-dir> --project <projectId>`，导入先落 draft，不会绕过 P1 冲突治理直接覆盖 active 知识。
- 本轮删除过期的 `packages/platform-pipeline/platform-pipeline-0.1.0.tgz`；当前阶段以源码构建和宿主部署为准，不把旧打包产物作为交付物。

### 知识库 P1 生命周期与冲突治理

- 默认只检索 `active` 条目，并自动排除已过期条目；可显式查询其他状态。
- 新条目支持 `supersedes` / `supersededBy`；替代旧条目时旧条目会标记为 `superseded`，默认检索不会再返回旧结论。
- 同项目下，若新条目与现有 active 条目共享实体/标签但正文不同，写入会返回结构化冲突，不会静默覆盖。
- 只有显式 `supersedes` 旧条目时才允许替代，并保留旧版本快照到知识库 `.history/`。
- `kb_write` 会返回 `conflict` 与冲突详情，交由人工门 G 决定，不把冲突交给模型自行覆盖。

## 架构决策摘要

| 决策 | 内容 |
|---|---|
| 阶段骨架 | 固定六阶段；mainAgent 为 host 侧纯代码 PipelineDriver（用户命令驱动，非 LLM agent） |
| 人工门 | A~G 全部阻塞等确认；支持事后重入（级联重跑，G-08 摘要锁强制失效） |
| 机器门禁 | 每阶段在人工审核前执行；BLOCKING/WARNING 分级；平台标准不可删、项目可追加 |
| 交叉检查 | analyze/design/execute/report 默认开启独立审核 agent（盲审 + 必查清单） |
| 执行可信 | executor 唯一执行者（agent 只编排+聚合+分类）；R4-08 对账 / R4-09 时序链 / R4-10 证据锚定；manual 会话级见证 |
| 工具权限 | 三层权限：声明（prompt）+ 强制（spawn toolFilter，物理不可达）+ 审批（requiresApproval 批次确认） |
| 执行类型 | prompt 输入 > 项目模板 > 项目类型 > 平台默认 解析链（auto/hybrid/manual） |
| 存储 | 兼容文件系统（markdown 目录）与外部系统（Jira/Xray/TestLink）；需求源降级链 |

## 文档索引与阅读顺序

| 文档 | 主题 | 层 |
|---|---|---|
| [docs/01-machine-gate-rules.md](docs/01-machine-gate-rules.md) | 机器门禁规则明细（G/R 系列，含 G-08 摘要锁、R4 执行可信、R5 发布约束） | 产物质量 |
| [docs/02-pipeline-template-v1.md](docs/02-pipeline-template-v1.md) | 流程模板 v1（pipeline.yaml schema、六阶段契约、人工门明细、报告渲染模板） | 流程配置 |
| [docs/03-agent-roles-and-boundaries.md](docs/03-agent-roles-and-boundaries.md) | Agent 角色与边界（PipelineDriver + 六阶段 + 证据快照 + 交叉检查 + 重入） | 角色 |
| [docs/04-prompt-templates.md](docs/04-prompt-templates.md) | Prompt 模板框架（公共骨架、差异段、审核模板、指令外壳） | 模板 |
| [docs/05-stage-prompt-reviews.md](docs/05-stage-prompt-reviews.md) | 六阶段完整 prompt 模板（已全部评审通过） | 模板 |
| [docs/06-tool-permission-control.md](docs/06-tool-permission-control.md) | 工具调用权限控制（三层权限、ACL、越权分层、审批） | 权限 |
| [docs/07-decision-checklist.md](docs/07-decision-checklist.md) | 决策清单（23 条全部决策） | 决策 |
| [docs/08-execution-trust.md](docs/08-execution-trust.md) | 执行可信设计（executor 唯一执行者、三条防线、manual 信任模型） | 执行可信 |
| [docs/09-implementation-skeleton.md](docs/09-implementation-skeleton.md) | 实现层骨架（结构级 TS 代码、harness 原语映射、落地顺序） | 实现 |

**建议阅读顺序**：02（流程全貌）→ 03（角色）→ 01（门禁）→ 06（权限）→ 08（执行可信）→ 04/05（模板）→ 09（实现骨架）；07 是决策汇总，可随时查阅。

## 决策记录（23 条）

见 [docs/07-decision-checklist.md](docs/07-decision-checklist.md) 决策记录表：D-01~D-20（设计决策）+ I-1~I-4（实现期决策），全部确认。

## 术语表

| 术语 | 含义 |
|---|---|
| 产物（artifact） | 阶段输出的结构化 JSON，落 `artifacts/<pipelineId>/<stageId>.json`（幂等地址） |
| 检查点（checkpoint） | 流水线状态唯一事实（cursor + 阶段状态 + 门禁/人工门记录 + 重入审计） |
| 机器门禁 | 产物在人工审核前的确定性校验层（BLOCKING/WARNING） |
| 人工门 A~G | 七个阻塞等确认的质量责任点 |
| 交叉检查 | 独立审核 agent 对高风险产物的语义二读（第三道闸） |
| G-08 摘要锁 | 产物声明消费的上游 digest；上游变更 → 下游自动 BLOCKING（级联失效） |
| 重入 | 用户对已批准阶段发起重新执行，级联重跑全部下游 |
| executor | 确定性执行器（唯一执行者）；executor_run 入参只传 caseId |
| manual 会话 | 无 executor 用例的人工执行会话（会话级见证，一次 2 个确认点覆盖整批） |
| 生效 ACL | 平台标准 ACL + 项目 delta（加 deny 自由、加 allow 需评审） |

## 状态

- 设计文档：**9 份全部定稿**，开放问题全部清零
- 决策：**24 条全部确认**（D-01~D-20 + I-1~I-4）
- 六阶段 prompt 模板：**全部评审通过**
- 实现：核心编排、执行可信、知识库生命周期、通用平台基础和文档解析已落地（`packages/platform-pipeline`，当前 447 项测试全绿）；方案一已提供无 Harness 的通用 runtime 端口、OpenAI-compatible 阶段/审核 runner、可恢复人工门、CLI 运行通道，以及覆盖平台 ACL 全部工具名的通用工具集与执行会话对账接线；知识库已支持 PDF / Word / Excel / Markdown 四类文档的解析与知识投影（选型见 `docs/adr/0001-document-parsing-libraries.md`）；仍有 Web 入口、跨进程文件锁、外部存储、预算计量等生产化工作待完成
- 当前阶段按源码构建和 Harness 宿主部署，不保留过期 tgz 打包产物；provider 配置、项目作用域和知识导入已具备基础实现
- 测试与构建需要 Node ≥ 24（`src/harness/tool-timeout.ts` 使用了 `using` 显式资源管理语法）；用更低版本运行 `node --test` 会在加载该文件时报 `SyntaxError: Unexpected identifier`，属于环境问题而非代码缺陷
- 本机默认堆上限下 `tsc --noEmit` 可能被系统 OOM 杀掉（退出码 137，无任何输出）；用 `NODE_OPTIONS=--max-old-space-size=6144 tsc --noEmit` 即可通过，同样是环境问题

## 无 Harness 运行通道（CLI）

```bash
cd packages/platform-pipeline
export PLATFORM_LLM_API_KEY=...          # 对应 pipeline.yaml 里 llm.providers.*.apiKeyEnv

# 跑到第一个人工门就交还控制权（退出码 3），不阻塞终端
node src/cli.ts run --config ../../examples/pipeline.yaml --data-root /tmp/platform-data --pipeline-id demo-1

# 查看待裁决的门（含机器门禁违规、交叉检查 findings、产物路径）
node src/cli.ts gate-list --config ../../examples/pipeline.yaml --data-root /tmp/platform-data

# 裁决，然后再跑一次 run 即从该门续跑
node src/cli.ts gate-decide --config ../../examples/pipeline.yaml --data-root /tmp/platform-data \
  --task <gateTaskId> --actor alice --action approved --note "通过"

# 回退重入（只动检查点，不需要 API Key）
node src/cli.ts reenter --config ../../examples/pipeline.yaml --data-root /tmp/platform-data \
  --pipeline-id demo-1 --stage design --by alice --reason "需求变更"
```

`--wait-ms <n>` 可改为阻塞等待 n 毫秒（0 或省略 = 立即挂起）。`gate-list` 默认只读，加 `--sweep` 才会把过期任务落盘为 `expired`。
