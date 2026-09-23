# 通用测试辅助平台下一阶段实施规划

> 目标：在现有六阶段流水线和无 Harness runtime 基础上，把 CLI/Web 入口、并发安全、持久化后端和预算计量推进到可部署的通用平台形态。
>
> 本文只负责规划与落地实施契约。后续具体代码实现由 DeepSeek V4.1 Flash 按本文件执行。

## 1. 当前基线

仓库：`/Users/zhangzhixiong/Downloads/harness/test-platform-design`

当前远程版本：`ee4a016 feat: implement harness-free platform tool set and execution reconciliation`

当前状态：

- 设计文档 9 份已定稿，开放问题清零。
- 六阶段流水线已形成稳定编排核心：`receive → analyze → design → execute → report → archive`。
- 机器门禁已覆盖 G-01~G-08 与 R1~R6 阶段规则；G-08 上游 digest 锁和 G-04 幂等语义已落地。
- 知识库 P1 生命周期治理已落地：Markdown/CSV/TSV 导入、draft、active、supersedes、冲突检测、历史快照和回读验证。
- Harness 已从核心运行时解耦为可选适配层；核心 runtime 不依赖 `@deepseek-ai/*`。
- 无 Harness runtime 已具备：
  - OpenAI-compatible `LlmClient`；
  - `OpenAIStageRunner`；
  - `OpenAIReviewRunner`；
  - 文件任务与人工门持久化；
  - 可恢复人工门；
  - CLI `run` / `reenter` / `gate-list` / `gate-claim` / `gate-decide` / `gate-cancel`；
  - `parse_doc`、`kb_query`、`kb_write`、`case_query`、`case_archive`、`executor_run`、`env_diag`、`req_pull`、`gate_check`；
  - execute 阶段的执行会话加载和 R4-08/09/10 对账。
- 当前验证：295/295 测试通过，typecheck/build 通过，CLI 六阶段「挂起 → 裁决 → 续跑」冒烟通过。
- 当前 Web 仍是独立的浏览器演示应用：`web-app/server.mjs` 自己维护内存 run、自己调用模型、自己生成 Markdown 文本，尚未接入 `PipelineDriver`、检查点、人工门、工具注册表和真实 executor。

### 明确保留的原则

1. **Harness 只做可选适配层**：新能力优先进入 `packages/platform-pipeline/src/runtime/` 或核心端口，不把 Harness API 引入核心。
2. **不伪装**：没有真实数据、真实执行或真实存储时，返回显式不可用/失败状态，不生成看似成功的空结果。
3. **不越权**：路径、租户、项目、流水线和工具权限都在宿主侧强制校验，不能只靠 prompt。
4. **不自动批准**：任何人工门、外部写入和高风险执行都不能因超时、异常或模型输出自动变成 `approved`。
5. **先落盘后宣告成功**：产物、检查点、人工门任务、执行记录和审计事件都必须先持久化。
6. **真实 executor 是唯一执行者**：execute agent 只能传 `caseId`，不能传入自定义步骤来伪造执行结果。

## 2. 总体目标与非目标

### 2.1 目标

完成后，平台应能提供以下闭环：

```text
Web/API 请求
  → 租户/项目身份解析
  → 读取 pipeline 配置
  → createPlatformHost / WebHostAdapter
  → PipelineDriver
  → 六阶段产物 + 机器门禁 + 交叉检查 + 可恢复人工门
  → executor 真实执行与证据
  → 知识库/用例库归档
  → Web 状态查询、人工裁决、重入、审计
```

同一套 PipelineDriver 和 runtime 能力应至少支持：

- CLI 单机运行；
- Web/API 长任务运行；
- Harness 适配层运行；
- 后续替换为数据库/对象存储/队列而不改编排规则。

### 2.2 本阶段不做

以下内容不要在本轮实现中扩张范围：

- 不做新的六阶段规则设计；
- 不改变现有机器门禁的判定口径；
- 不把 Web 端重新做成另一套流水线；
- 不实现任意 shell 执行工具；
- 不把任意模型 provider 逻辑散落到 Web server；
- 不把 API Key 写入检查点、任务、日志或返回 JSON；
- 不在没有明确数据模型和迁移策略前直接引入数据库依赖；
- 不实现多租户计费结算，只记录预算使用量和超限状态。

## 3. 里程碑总览

| 里程碑 | 名称 | 目标 | 优先级 | 依赖 | 交付判定 |
|---|---|---|---|---|---|
| M0 | 基线冻结与契约对齐 | 固化当前接口、路径、状态和兼容边界 | P0 | 无 | 文档、测试基线和迁移清单齐全 |
| M1 | Web 接入通用 runtime | Web 不再自建流水线，统一调用 PipelineDriver | P0 | M0 | Web 可启动、查询、挂起、裁决、续跑 |
| M2 | 并发安全与幂等 | 防止同一 pipeline 并发运行、锁误删和重复写入 | P0 | M1 可并行 | 并发测试通过，异常可恢复 |
| M3 | 预算计量与运行遥测 | 记录模型调用、工具调用、阶段耗时和预算超限 | P1 | M1 | 超限可阻断，审计数据可查询 |
| M4 | 持久化端口与外部后端 | 文件存储与数据库/对象存储实现可替换 | P1 | M2、M3 | 核心不绑定具体后端，双实现测试通过 |
| M5 | 平台化发布验收 | 安全、恢复、回归、部署和文档闭环 | P0 发布门槛 | M1~M4 | 发布检查表全部通过 |

建议实现顺序：**M0 → M1 → M2 → M3 → M4 → M5**。

其中 M2 可以在 M1 的 Web adapter 基本接口确定后立即并行设计，但不要在接口尚未稳定时大规模改动。

---

# 4. M0：基线冻结与契约对齐

## 4.1 目标

在写 Web 代码前，先把 CLI 已验证的 runtime 接口变成 Web 可消费的正式契约，避免 Web 再次复制一套运行逻辑。

## 4.2 任务

### M0-1：确认入口边界

重点阅读并以现有接口为准：

- `packages/platform-pipeline/src/driver.ts`
- `packages/platform-pipeline/src/runtime/ports.ts`
- `packages/platform-pipeline/src/runtime/platform-host.ts`
- `packages/platform-pipeline/src/runtime/persistence.ts`
- `packages/platform-pipeline/src/runtime/platform-tools.ts`
- `packages/platform-pipeline/src/checkpoint.ts`
- `packages/platform-pipeline/src/platform-roots.ts`
- `packages/platform-pipeline/src/types.ts`

不得让 Web 直接调用以下内部实现来绕过端口：

- 不直接修改 checkpoint JSON；
- 不直接写人工门 task JSON；
- 不直接调用 `OpenAICompatibleClient` 运行阶段；
- 不直接拼接 artifacts/checkpoints/gates/tasks 路径；
- 不直接执行 HTTP 测试请求。

### M0-2：定义 Web 运行服务接口

建议新增无 HTTP 框架依赖的服务层，例如：

```ts
export interface PipelineRunService {
  create(input: CreatePipelineRunInput): Promise<PipelineRunSummary>
  get(pipelineId: string, actor: ActorContext): Promise<PipelineRunView>
  run(pipelineId: string, actor: ActorContext): Promise<RunResult>
  reenter(input: ReenterInput, actor: ActorContext): Promise<Checkpoint>
  listGateTasks(filter: GateTaskFilter, actor: ActorContext): Promise<readonly HumanGateTask[]>
  claimGate(input: GateClaimInput, actor: ActorContext): Promise<HumanGateTask>
  decideGate(input: GateDecisionInput, actor: ActorContext): Promise<HumanGateTask>
  cancelGate(input: GateCancelInput, actor: ActorContext): Promise<HumanGateTask>
}
```

这个 service 层负责：

- 身份和项目作用域校验；
- 加载、校验和缓存配置；
- 装配 `createPlatformHost`；
- 调用 `PipelineDriver`；
- 映射 `HumanGateWaitAbortedError` 为 `waiting-human`；
- 映射机器门禁失败、审核失败、拒绝和异常；
- 不在 service 层复制阶段逻辑。

### M0-3：统一 Web 状态模型

Web 状态必须直接映射检查点和任务状态，至少包括：

- `queued`
- `running`
- `waiting-human`
- `needs-fix`
- `gate-failed`
- `rejected`
- `completed`
- `failed`
- `cancelled`

阶段视图至少包括：

- `stageId`
- `status`
- `artifactPath`
- `digest`
- `machineStatus`
- `machineViolations`
- `reviewVerdict`
- `reviewFindings`
- `humanGateTaskId`
- `startedAt`
- `finishedAt`
- `failure`

不能只返回当前内存中的文本 artifact；必须能从 checkpoint/artifact store 重建页面状态。

## 4.3 M0 验收

- service 层可以用 `ScriptedStageRunner` 和临时目录单测；
- 不需要启动 Web server 就能验证 create/get/run/gate/reenter；
- API Key 不出现在 service 返回值和日志；
- Web service 的所有路径通过 `resolvePlatformRoots`、`gateTaskStoreDir`、`taskStoreDir`、`artifactPath` 等统一函数生成。

---

# 5. M1：Web 接入通用 runtime

## 5.1 目标

把现有 `web-app/server.mjs` 从“演示性质的内存流水线”改为“通用 runtime 的 HTTP 外壳”。

当前 Web 的以下逻辑必须移除或下沉到 platform-pipeline：

- `runs = new Map()` 作为唯一状态；
- `promptFor()` 自建六阶段 prompt；
- `callModel()` 自建模型请求；
- `runPipeline()` 自己串阶段、自己生成 archive；
- Web 自己把 execute 标成“待执行”而不调用统一 executor；
- Web 自己维护 artifact 数组而不读取 ArtifactStore。

## 5.2 推荐文件布局

建议新增或调整：

```text
packages/platform-pipeline/src/web/
  pipeline-run-service.ts       # Web/HTTP 可调用的 service
  pipeline-run-types.ts         # 请求、响应、actor、错误映射
  pipeline-run-registry.ts      # 进程内运行句柄，非事实存储
  async-runner.ts               # 后台运行与恢复调度

web-app/
  server.mjs                    # 只做 HTTP 路由、鉴权入口、响应映射
  public/app.js                 # 页面轮询、门任务展示与裁决
```

如果实现阶段认为单独的 `web/` 包不合适，也必须保持同样的责任边界，不要把核心逻辑重新写进 `server.mjs`。

## 5.3 API 规划

### 创建/启动

```http
POST /api/projects/:projectId/pipelines
POST /api/pipelines/:pipelineId/run
```

创建请求至少包含：

```json
{
  "projectId": "demo",
  "pipelineId": "pipe-2026-001",
  "configRef": "...",
  "requirementInput": "...",
  "providerName": "primary",
  "targetBaseUrl": "https://staging.example.com"
}
```

约束：

- API Key 由服务端环境变量按 `apiKeyEnv` 注入，不从浏览器表单传递；
- `pipelineId` 必须在租户/项目作用域内唯一；
- `targetBaseUrl` 经过 SSRF 校验，不能默认访问本机和内网；
- 创建后返回 `202` 和 pipeline 标识，不等待整条流水线完成。

### 查询

```http
GET /api/pipelines/:pipelineId
GET /api/pipelines/:pipelineId/stages/:stageId/artifact
GET /api/pipelines/:pipelineId/events
```

查询必须以持久化 checkpoint、artifact、gate task 为事实来源。进程内 registry 只用于保存后台运行句柄和取消信号，不能作为唯一状态。

### 人工门

```http
GET  /api/pipelines/:pipelineId/gates
POST /api/gates/:gateTaskId/claim
POST /api/gates/:gateTaskId/decide
POST /api/gates/:gateTaskId/cancel
```

裁决接口必须：

- 校验 actor 是否有该项目的人工门权限；
- 先 claim 或校验当前 lease；
- `approved` / `changes-needed` / `rejected` 必须显式传入；
- 记录 note、actor、时间和审计事件；
- 不允许覆盖已经 consumed 的裁决；
- 返回 `consumedAt` 之前/之后的状态差异。

### 重入

```http
POST /api/pipelines/:pipelineId/reenter
```

请求必须包含：

```json
{
  "stageId": "design",
  "reason": "需求变更",
  "expectedCurrentDigest": "..."
}
```

`expectedCurrentDigest` 用于防止页面打开过久后把其他人的新版本覆盖掉。

## 5.4 Web 后台运行语义

推荐采用“持久化状态 + 进程内触发器”：

1. HTTP 请求创建/触发 pipeline；
2. service 获取 pipeline lock；
3. 后台调用 `driver.run()`；
4. 人工门等待超时后，driver 以 `waiting-human` 语义结束本次调用；
5. 人工裁决 API 只写任务，不在 HTTP 请求内同步跑完整流水线；
6. 后续 worker/重新触发器读取 checkpoint 并续跑；
7. 进程重启后，扫描 `running`/`awaiting-gate` 状态并恢复或标记为可重入。

不要在 HTTP handler 中直接 `await driver.run()` 后保持连接等待人工裁决。

## 5.5 M1 验收

必须有以下端到端测试：

1. 创建 pipeline 返回 `202`，不泄露 API Key；
2. 后台运行到 receive 人工门，查询接口返回 `waiting-human`；
3. claim + decide 后再次触发，receive 产物不重生成；
4. 六阶段全部裁决后返回 `completed`；
5. `changes-needed` 只重跑当前阶段及其下游，旧裁决不会重复消费；
6. 进程重启后可以从 checkpoint 继续；
7. execute 没有 targetBaseUrl 时明确失败，不出现伪造 execution record；
8. Web 和 CLI 读取同一 dataRoot 时能看到同一 checkpoint、artifact 和 gate task。

---

## 5.6 文档解析与知识库导入专项（P0，必须独立验收）

### 5.6.1 强制目标

知识库和 receive/analyze 阶段的文档工具必须支持以下格式：

| 类型 | 扩展名 | 必须支持的内容 |
|---|---|---|
| PDF | `.pdf` | 页面文本、页码、文档元数据；尽可能保留段落顺序；扫描件 OCR 作为可选能力，不能把 OCR 结果伪装成高置信度原文 |
| Word | `.docx`、`.doc` | 标题层级、段落、列表、表格、页眉/页脚（若可提取）、文档元数据；`.doc` 老格式要明确支持范围或在上传时明确拒绝 |
| Excel | `.xlsx`、`.xls` | 工作表名、表头、数据行、单元格值、合并单元格的可解释表示；空行和隐藏 sheet 的处理策略必须固定；公式优先读取计算后的值，同时保留公式信息（若库支持） |
| Markdown | `.md`、`.markdown`、`.mdx` | 标题层级、段落、列表、代码块、表格、引用、链接、原始 Markdown；不能只取纯文本而丢掉标题和表格语义 |
| 文本/表格 | `.txt`、`.csv`、`.tsv`、`.yaml`、`.yml`、`.json` | 原文或结构化数据；编码、分隔符、引号、换行和 JSON 合法性要显式处理 |

这不是“尽量支持”。上述 PDF、Word、Excel、Markdown 是平台知识库导入的**硬性格式要求**。如果某一种格式在当前运行环境无法安全解析，工具必须返回结构化的 `unsupported`/`parse-failed`，并说明缺失能力，绝不能把二进制内容当 UTF-8 文本读取后继续生成知识条目。

### 5.6.2 当前缺口

当前 `runtime/platform-tools.ts` 的 `parse_doc` 只覆盖文本族、CSV/TSV 和 JSON，PDF/Word/Excel 当前会显式返回 unsupported。这是正确的安全降级，但不是目标完成状态。

后续实现必须将 `parse_doc` 从“单函数按扩展名分支”升级为**解析器注册表 + 统一中间表示**，不要把 PDF、Word、Excel 的库调用继续堆在一个超长工具函数里。

### 5.6.3 推荐模块边界

建议新增以下结构；名称可以调整，但职责必须保持独立：

```text
packages/platform-pipeline/src/documents/
  document-types.ts          # 输入、输出、中间表示、诊断、置信度
  document-parser.ts         # ParserRegistry / DocumentParser 接口
  document-detect.ts         # 扩展名、MIME、magic bytes、编码检测
  markdown-parser.ts         # Markdown AST/章节/表格解析
  pdf-parser.ts              # PDF 文本和页码提取
  word-parser.ts             # DOCX OOXML 提取；DOC 老格式单独策略
  excel-parser.ts            # XLSX/XLS 工作簿和表格提取
  delimited-parser.ts        # CSV/TSV
  text-parser.ts             # TXT/YAML/JSON 等文本族
  document-limits.ts         # 文件大小、页数、sheet 数、单元格数、文本长度限制
  document-sanitize.ts       # 路径、宏、外链、嵌入对象和敏感字段处理
  knowledge-projection.ts    # ParsedDocument → draft KnowledgeEntry
```

`runtime/platform-tools.ts` 只负责：

1. 校验调用参数和 workspace 路径；
2. 调用 `ParserRegistry`；
3. 将统一中间表示序列化为 tool result；
4. 可选地调用 `knowledge-projection` 生成 draft；
5. 不直接处理 OOXML、PDF 二进制或 Excel 工作簿细节。

### 5.6.4 统一解析接口

建议定义如下接口：

```ts
export type SupportedDocumentFormat =
  | 'pdf' | 'docx' | 'doc' | 'xlsx' | 'xls'
  | 'markdown' | 'text' | 'csv' | 'tsv' | 'yaml' | 'json'

export type ParseStatus = 'parsed' | 'partial' | 'unsupported' | 'parse-failed' | 'limit-exceeded'
export type ContentConfidence = 'exact-text' | 'structure-preserved' | 'layout-approximate' | 'ocr-derived'

export interface DocumentParseRequest {
  readonly path: string
  readonly formatHint?: SupportedDocumentFormat
  readonly includeTables?: boolean
  readonly includeMetadata?: boolean
  readonly includeRawSource?: boolean
  readonly sheetNames?: readonly string[]
  readonly pageRange?: Readonly<{ from?: number; to?: number }>
}

export interface DocumentDiagnostic {
  readonly code: string
  readonly severity: 'info' | 'warning' | 'error'
  readonly message: string
  readonly location?: string
}

export interface ParsedSection {
  readonly id: string
  readonly title?: string
  readonly level?: number
  readonly order: number
  readonly text: string
  readonly page?: number
  readonly sheet?: string
  readonly sourceRef: string
}

export interface ParsedTable {
  readonly id: string
  readonly title?: string
  readonly headers: readonly string[]
  readonly rows: readonly (readonly string[])[]
  readonly page?: number
  readonly sheet?: string
  readonly sourceRef: string
  readonly truncated?: boolean
}

export interface ParsedDocument {
  readonly status: ParseStatus
  readonly format: SupportedDocumentFormat | 'unknown'
  readonly fileName: string
  readonly mediaType?: string
  readonly sha256: string
  readonly pageCount?: number
  readonly sheetNames?: readonly string[]
  readonly sections: readonly ParsedSection[]
  readonly tables: readonly ParsedTable[]
  readonly metadata: Readonly<Record<string, string | number | boolean | null>>
  readonly plainText: string
  readonly rawSource?: string
  readonly diagnostics: readonly DocumentDiagnostic[]
  readonly confidence: ContentConfidence
  readonly limits: Readonly<{
    truncated: boolean
    pagesRead?: number
    sheetsRead?: number
    rowsRead?: number
    bytesRead?: number
  }>
}

export interface DocumentParser {
  readonly format: SupportedDocumentFormat
  readonly mediaTypes: readonly string[]
  canParse(input: Readonly<{ path: string; mediaType?: string; magicBytes?: Uint8Array }>): boolean
  parse(request: DocumentParseRequest, signal: AbortSignal): Promise<ParsedDocument>
}
```

实现细节要求：

- `sha256` 在解析前基于原始文件计算，作为 source identity；
- `sourceRef` 必须包含文件相对路径及位置信息，例如 `requirements.pdf#page=3`、`cases.xlsx#sheet=登录用例!A1:D20`、`spec.md#heading=2.1`；
- `plainText` 供 LLM 检索，`sections`/`tables` 供结构化知识生成，不能只保留其中一种；
- `status=partial` 时必须有 diagnostics 和 limits，不能只返回截断文本；
- 每个解析器都要接受 `AbortSignal`，大 PDF/Excel 解析被取消时及时释放资源；
- 解析器不得写原文件，也不得执行文档中的宏、脚本、外链或嵌入对象。

### 5.6.5 解析器实现细节

#### A. PDF

推荐使用成熟的纯 Node/JavaScript PDF 文本提取库，具体依赖由实现模型结合 Node ≥24、许可证和维护状态确认；不能手写 PDF 二进制解析器。

必须实现：

- 文件 magic bytes 校验（`%PDF-`）；扩展名不可信时以内容检测为准；
- 页数限制和总字节限制；
- 每页文本提取，并保留 `#page=N` sourceRef；
- 处理文本顺序异常时返回 warning；
- 文档没有可提取文本时返回 `partial` 或 `parse-failed`；
- 扫描 PDF 不得自动声称已完成解析；若接入 OCR，结果 confidence 必须为 `ocr-derived`，每页标记 OCR 来源；
- 拒绝执行 PDF 中的 JavaScript、表单动作、外部链接和嵌入附件；
- PDF 密码保护时返回明确错误码 `DOCUMENT_ENCRYPTED`；
- 大文件、异常对象和解析超时必须由统一 limit/timeout 处理。

表格提取是增强能力，不得把 PDF 中布局不稳定的文本硬拼成“准确表格”。提取失败时保留页文本和 warning，不生成结构化表格假象。

#### B. Word

`.docx` 本质是 OOXML 压缩包，必须使用成熟解析库或安全的 XML 解包流程，不得直接把 zip 内容交给模型。

必须实现：

- 标题、段落、列表顺序保留；
- 表格转 `ParsedTable`，表格来源包含章节或文档位置；
- 合并单元格要么展开并记录 `merged` 诊断，要么保留明确的合并信息，不能静默复制造成事实重复；
- 页眉/页脚、脚注、尾注的策略固定并写入 diagnostics；
- 图片、文本框、SmartArt、嵌入对象默认不当作已解析文本；
- DOCX 中的外部链接、宏、嵌入 OLE 不执行；
- `.doc` 老二进制格式必须二选一：接入明确安全的解析适配器，或返回 `unsupported` 并提示转换为 `.docx`，不能猜测解析；
- 解压文件数量、单文件大小、总展开大小设置上限，防 zip bomb；
- XML 实体、路径穿越和外部实体解析必须禁用。

#### C. Excel

`.xlsx`/`.xls` 不能按普通文本处理。必须以 workbook → sheet → range/table 的中间结构输出。

必须实现：

- 工作簿名称和 sheet 名；
- 默认只读取可见 sheet，提供显式参数读取隐藏 sheet；若配置不允许读取隐藏 sheet，返回 warning；
- 每个 sheet 的有效区域、表头推断、行列数量；
- 单元格值按显示值和原始类型区分（字符串、数字、日期、布尔、错误、空值）；
- 公式默认读取缓存计算值，同时可保留公式文本；没有缓存值时标记 `FORMULA_VALUE_UNAVAILABLE`，不得自行计算并伪装成 Excel 结果；
- 合并单元格、筛选、冻结窗格和表格名称作为 metadata 或 diagnostics；
- 空行策略固定：表格内部空行保留，尾部空行裁剪；
- 每个 sheet 设置最大行数、列数、单元格数和总展开内存限制；
- `.xls` 老格式必须有专门适配器，否则明确 unsupported；
- 不执行宏、外部链接、Power Query、数据连接和嵌入对象；
- sourceRef 细化到 `file.xlsx#sheet=Sheet1!A1:D20`。

建议工具调用支持：

```json
{
  "path": "requirements.xlsx",
  "sheetNames": ["接口需求", "验收标准"],
  "includeTables": true
}
```

模型不能通过参数读取 workspace 外的 sheet 文件，也不能绕过文件大小和单元格上限。

#### D. Markdown

Markdown 不能简单 `stripMarkdown` 后只返回一段文本，因为标题、表格和代码块本身是知识结构。

必须实现：

- 标题层级转换为 `ParsedSection.level`；
- 段落和列表保留顺序；
- Markdown 表格转 `ParsedTable`；
- fenced code block 原样保留，但代码内容默认不执行；
- blockquote、链接、图片引用保留为文本或 metadata；
- front matter 单独解析为 metadata，非法 front matter 返回 warning；
- sourceRef 至少包含 heading 路径或行号；
- `.mdx` 中 JSX/组件标签不执行，按文本或 unsupported block 处理；
- 超过文本长度限制时返回 `partial` 和行/字符范围。

### 5.6.6 `parse_doc` 工具契约

`parse_doc` 应扩展为：

```json
{
  "path": "docs/requirements.pdf",
  "formatHint": "pdf",
  "includeTables": true,
  "includeMetadata": true,
  "pageRange": { "from": 1, "to": 20 }
}
```

返回不能只使用当前的 `{ format, text, rows }` 简化结构，建议返回：

```json
{
  "available": true,
  "status": "parsed",
  "format": "pdf",
  "fileName": "requirements.pdf",
  "sha256": "...",
  "confidence": "structure-preserved",
  "sections": [
    {
      "id": "section-1",
      "title": "登录需求",
      "level": 1,
      "order": 0,
      "text": "...",
      "page": 2,
      "sourceRef": "requirements.pdf#page=2"
    }
  ],
  "tables": [],
  "plainText": "...",
  "diagnostics": [],
  "limits": {
    "truncated": false,
    "pagesRead": 20,
    "bytesRead": 123456
  }
}
```

错误响应必须结构化：

```json
{
  "available": true,
  "status": "unsupported",
  "format": "doc",
  "diagnostics": [
    {
      "code": "FORMAT_NOT_SUPPORTED",
      "severity": "error",
      "message": "当前运行环境没有安全的 .doc 解析器，请先转换为 .docx"
    }
  ]
}
```

下列情况禁止返回 `available=true, status=parsed`：

- 文件不存在；
- 路径越界或软链接逃逸；
- magic bytes 与声明格式明显冲突；
- 加密 PDF 未提供解密能力；
- Office 文件是宏/嵌入对象而不是可安全提取的正文；
- 解析器超时或达到限制后没有标记 `partial`/`limit-exceeded`；
- 文档内容为空且没有说明原因。

### 5.6.7 从文档到知识条目的投影

解析和知识写入必须分两步，不能“上传文档后直接让模型写 active 知识”：

```text
原始文件
  → DocumentParser
  → ParsedDocument
  → LLM/规则抽取候选事实
  → KnowledgeEntry(status=draft)
  → machine validation
  → 人工门/审批
  → kb_write
  → kb_query 回读
```

`KnowledgeEntry.sourceRefs` 必须引用 `ParsedDocument` 的位置：

- PDF：`requirements.pdf#page=3`；
- Word：`spec.docx#table=2,row=4` 或章节路径；
- Excel：`cases.xlsx#sheet=接口!A2:F20`；
- Markdown：`guide.md#heading=3.2` 或行号范围。

抽取时的硬约束：

- 不允许模型凭空补齐文档没有的业务事实；
- 表格行必须能追溯到原始 sheet/表格位置；
- OCR/布局推断结果默认低置信度，不能直接生成 `verified`；
- `active` 知识仍必须经过现有冲突治理和人工门；
- 同一文档重复导入应由 `sha256 + sourceRef + entryId/version` 幂等，不重复制造知识条目；
- 文档更新后，旧条目是否 supersede 必须有明确策略，不能按文件名覆盖。

### 5.6.8 文档存储与上传安全

文档解析的输入文件不能任意落在项目 workspace 里。建议增加：

```text
<dataRoot>/tenants/<tenantId>/projects/<projectId>/inputs/<inputId>/original
<dataRoot>/tenants/<tenantId>/projects/<projectId>/inputs/<inputId>/manifest.json
<dataRoot>/tenants/<tenantId>/projects/<projectId>/inputs/<inputId>/parsed.json
```

`manifest.json` 至少记录：

- inputId、tenantId、projectId、pipelineId；
- 原始文件名和安全化后的存储名；
- MIME、扩展名、文件大小、sha256；
- 上传 actor、上传时间；
- parser name/version；
- parse status、confidence、diagnostics 摘要；
- 是否生成 draft 知识条目。

安全要求：

- 上传文件名不能决定实际存储路径；
- 所有解压目录必须在临时隔离目录并做总大小限制；
- 解析完成后临时目录必须清理，清理失败要记录；
- 禁止执行 Office 宏、PDF JavaScript、外部实体、外链下载和嵌入程序；
- 默认不向模型发送原始二进制，只发送 ParsedDocument 的受限结构；
- 只把必要的页、sheet、章节发送给模型，避免将整份大文档无上限放入 prompt；
- 文档可能包含密码、token、身份证号等敏感信息，日志只能记录摘要和 hash，不记录全文。

### 5.6.9 依赖与许可证决策

实现模型选择解析库时必须先做小型 ADR，不允许“看到能 import 就直接安装”。ADR 至少写明：

- Node ≥24 兼容性；
- PDF/DOCX/XLSX/DOC/XLS 各自采用的库；
- 是否支持纯 JavaScript，是否依赖系统二进制；
- 许可证是否允许当前项目分发和商用；
- 是否支持流式/分页/大文件限制；
- 安全历史和维护状态；
- 是否会执行宏、外链或 XML 外部实体；
- 失败时如何降级到 `unsupported`；
- 是否需要单独的 worker/沙箱进程。

建议优先选择维护稳定、可限制资源、不会执行文档内容的库；不要为了支持 `.doc`/`.xls` 直接引入需要系统 LibreOffice 的黑盒转换，除非部署环境、隔离和许可证已经确认。

### 5.6.10 文档解析测试矩阵

必须新增 fixture 和测试，不能只测扩展名：

#### 正常样本

- 含中文和英文标题的 Markdown；
- 含嵌套列表、引用、代码块和表格的 Markdown；
- 多页可复制文本 PDF；
- 没有文本层的扫描 PDF；
- 含标题、列表、表格和合并单元格的 DOCX；
- 含多个 sheet、日期、公式、隐藏 sheet、合并单元格的 XLSX；
- CSV/TSV 含引号、换行、中文、空列和 CRLF。

#### 异常样本

- 损坏 PDF/ZIP/OOXML；
- 加密 PDF；
- `.doc`/`.xls` 在未配置适配器时明确 unsupported；
- PDF 超页、Excel 超行、文档超字节限制；
- zip bomb 或极高压缩比 Office 文件；
- 外部实体、外部链接、宏和嵌入对象；
- 非 UTF-8 文本；
- magic bytes 与扩展名不一致；
- 软链接、`..`、绝对路径和路径编码绕过；
- 解析中 AbortSignal；
- 同一文件重复导入和文件内容变更后的重新导入。

#### 知识投影样本

- PDF 页码 sourceRef 能回读；
- Word 表格行 sourceRef 能回读；
- Excel sheet/range sourceRef 能回读；
- Markdown heading sourceRef 能回读；
- OCR/partial 结果不能被赋予 `verified`；
- 冲突条目仍走现有 `KnowledgeConflictError`；
- active 写入仍需人工门，不能被 `parse_doc` 绕过。

### 5.6.11 文档解析专项验收标准

只有满足以下条件，才能认为“知识库支持 PDF/Word/Excel/Markdown”：

1. 四类格式都有实际 fixture 和成功解析测试；
2. 每类格式都有损坏、超限、路径越界和不支持能力测试；
3. 解析结果同时保留可检索纯文本和可追溯结构；
4. 所有知识条目带可定位 `sourceRefs`；
5. 解析失败不会生成 active 知识；
6. OCR/布局推断结果有 confidence 标记；
7. 不执行宏、脚本、外链或嵌入对象；
8. 大文件和恶意压缩文件有资源上限；
9. CLI、Web、Harness 入口共用同一 ParserRegistry；
10. 解析器替换不会修改 `PipelineDriver` 和机器门禁规则。

---

# 6. M2：并发安全与幂等

## 6.1 目标

将当前 `checkpoint-lock.ts` 的 best-effort 目录锁提升为可审计、可恢复、不会误删其他进程锁的运行互斥机制。

## 6.2 当前风险

现有目录锁已经能阻止普通并发，但存在以下需要在落地时明确处理的边界：

- stale lock 删除与另一个进程刚刚续租之间可能竞争；
- 进程崩溃时锁只能靠时间判断；
- 没有 heartbeat/lease 更新；
- release 只校验 owner 文件，无法校验 lock generation；
- Web 后台 runner 和 CLI 可能使用不同锁路径；
- checkpoint save 与 artifact/session 写入之间缺少一致性策略。

## 6.3 任务

### M2-1：统一 pipeline lock

- 锁路径固定为项目作用域下 `checkpoints/<pipelineId>/.pipeline.lock`；
- owner 文件包含 `ownerId`、`generation`、`pid`、`host`、`acquiredAt`、`heartbeatAt`；
- acquire 使用 `mkdir`/独占创建；
- 续租更新 heartbeat；
- release 必须同时校验 ownerId + generation；
- stale recovery 必须记录审计事件；
- 不能使用 `rm -rf` 这种宽泛删除；只删除精确 lock 目录且再次确认 owner。

### M2-2：运行互斥范围

锁覆盖：

- load checkpoint；
- 阶段产物生成；
- artifact wrapper 补全；
- machine gate/review/human gate 状态推进；
- checkpoint save；
- execute session merge。

人工门“等待”期间可以释放运行锁，但必须保留 `awaiting-gate` checkpoint 和 pending task。裁决后的下一次运行重新 acquire。

### M2-3：幂等键

为以下操作增加稳定幂等键：

- pipeline create：`tenantId/projectId/pipelineId`；
- stage artifact：`pipelineId/stageId/version/inputDigest`；
- human gate decision：`gateTaskId/decisionId`；
- executor invocation：`pipelineId/caseId/inputDigest`；
- knowledge write：`project/entryId/version`；
- case archive：`project/caseId/version`。

## 6.4 M2 验收

- 两个进程同时 run 同一 pipeline，只有一个能推进；
- stale lock 可以恢复，但不会删除新进程刚取得的锁；
- release 不会误删其他 owner 的锁；
- 同一 gate decision 重试不会重复消费；
- 同一 executor invocation 重试不会重复产生不可对账记录；
- kill -9 后重启可恢复或明确标记为 stale，不会卡死永久。

---

# 7. M3：预算计量与运行遥测

## 7.1 目标

把配置中的 `budget.maxSteps`、`timeoutMs`、`maxRetries` 从“只传给 prompt/配置”变成真实运行约束和可审计用量。

## 7.2 计量模型

建议新增不可变事件：

```ts
export interface UsageEvent {
  readonly eventId: string
  readonly tenantId: string
  readonly projectId: string
  readonly pipelineId: string
  readonly stageId: StageId
  readonly kind: 'llm' | 'tool' | 'review' | 'executor' | 'gate' | 'checkpoint'
  readonly startedAt: number
  readonly finishedAt: number
  readonly durationMs: number
  readonly inputTokens?: number
  readonly outputTokens?: number
  readonly toolName?: string
  readonly success: boolean
  readonly errorCode?: string
}
```

阶段预算至少包括：

- LLM 调用次数；
- tool-call 步数；
- 输入/输出 token（provider 返回时记录，未返回则标记 unavailable）；
- 阶段 wall-clock 超时；
- executor case 数量；
- review 重试次数；
- human gate 等待时间（不计入模型预算，但要计入运行耗时）。

## 7.3 任务

- 在 `OpenAICompatibleClient` 或其上层注入 usage sink；
- 在 `OpenAIStageRunner` 维护每阶段 tool step counter；
- 超过 `budget.maxSteps` 立即停止并写入 `budget-exceeded`；
- `timeoutMs: 0` 的现有语义继续保持为不设阶段 deadline，不要误解为立即超时；
- review 使用独立预算，不能吞掉 stage 主预算；
- executor 的 case 数量、失败数量和证据数写入 usage；
- 运行结束时写入 summary：`used / limit / exceeded`。

## 7.4 M3 验收

- 模型连续 tool call 超过 maxSteps 时阶段失败且 checkpoint 可恢复；
- LLM 超时不会被误记为人工门取消；
- usage 事件不包含 API Key、完整 prompt 或敏感响应；
- usage 事件与 pipelineId/stageId 一一绑定；
- 预算超限可在 Web/CLI 查询；
- 295 项现有回归测试不改变既有门禁语义。

---

# 8. M4：持久化端口与外部后端

## 8.1 目标

把当前文件实现提升为可替换的端口实现，保留文件存储用于本地开发和单机部署。

## 8.2 需要抽象的存储端口

现有或建议保留以下接口边界：

- `ArtifactStore`
- `CheckpointPort`
- `HumanGateTaskStore`
- `TaskStore`
- `KnowledgeStore`
- `CaseStore`
- `UsageStore`
- `AuditEventStore`
- `PipelineLock`

核心规则只能依赖接口，不能依赖 `FileHumanGateTaskStore`、`MarkdownKnowledgeStore` 或某个数据库 SDK 的具体类型。

## 8.3 后端路线

建议分两步：

### M4-A：文件后端强化

- 原子写统一使用 temp + rename；
- 补 realpath/权限/软链接检查；
- 所有 JSON schema 在读入时校验；
- 损坏文件不能静默当空数据；
- 增加迁移版本字段；
- 记录 schema version 和 ruleset version。

### M4-B：外部后端适配

优先支持：

- PostgreSQL：checkpoint、gate task、task、usage、audit；
- 对象存储：artifact、evidence、知识 Markdown、用例 JSON；
- Redis/队列：后台运行触发和 lease（如部署形态确实需要）。

数据库/对象存储实现应新增在独立目录，例如：

```text
packages/platform-pipeline/src/storage/
  ports.ts
  file/
  postgres/
  object-store/
```

不要把数据库连接初始化塞入 `PipelineDriver`。

## 8.4 M4 验收

- 同一套 driver contract tests 同时通过 file backend 和 external backend；
- backend 切换只改宿主装配，不改 stages/gates/driver；
- checkpoint 与 gate task 的事务边界清晰；
- artifact 写成功但 checkpoint 写失败时能重试，不会宣称阶段完成；
- 外部存储不可用时状态明确为 infrastructure failure，不自动批准或覆盖旧数据。

---

# 9. M5：平台化发布验收

## 9.1 安全检查

- API Key 只来自服务端环境变量；
- 日志、错误、usage、audit、checkpoint 均无 secret；
- Web API 有身份、项目作用域和人工门权限校验；
- `targetBaseUrl` 防 SSRF，重定向策略明确；
- 文件路径防 `..`、绝对路径和软链接逃逸；
- `fs_write` 只允许阶段自己的 artifacts 前缀；
- `executor_run` 只接受设计产物里的 caseId；
- `kb_write` / `case_archive` 不可绕过人工批准；
- 外部模型返回的 tool name 必须经过注册表和 stage ACL 双重过滤。

## 9.2 恢复检查

- Web 进程重启后可从 checkpoint 查询状态；
- awaiting-gate 任务不会重复生成产物；
- 已裁决未消费任务会被续用一次；
- consumed 决策不会重复驱动阶段；
- changes-needed 会开新阶段版本和新人工门；
- stale lock 可以诊断和恢复；
- 损坏 checkpoint/session 会显式失败并保留原件。

## 9.3 回归检查

每次发布至少运行：

```bash
cd packages/platform-pipeline
NODE_OPTIONS="--max-old-space-size=6144" ./node_modules/.bin/tsc --noEmit
NODE_OPTIONS="--max-old-space-size=6144" ./node_modules/.bin/tsc -p tsconfig.build.json
/usr/local/bin/node --test
```

并额外执行：

- Web API 集成测试；
- 双进程并发测试；
- kill/restart 恢复测试；
- 本地真实 HTTP executor 测试；
- 真实 OpenAI-compatible provider 冒烟（测试环境 key，不进日志）；
- 跨租户/跨项目访问拒绝测试；
- 预算超限测试；
- storage backend contract tests。

## 9.4 发布门槛

满足以下条件才允许从“开发可用”标记为“平台试运行”：

- Web 已不再维护独立的 `runPipeline`；
- Web 与 CLI 使用同一 PipelineDriver/runtime；
- 运行事实不依赖进程内 Map；
- 同一 pipeline 并发运行被可靠阻止；
- 人工门、executor、知识库和归档都有持久化事实；
- 预算、审计和错误状态可查询；
- 完整测试、恢复测试、安全测试全部通过；
- 已明确单机文件后端和生产外部后端的适用边界。

## 10. DeepSeek V4.1 Flash 执行任务清单

以下清单可以直接逐项交给实现模型。每完成一项，都要先补测试再改实现，并保持小提交。

### P0-A：M0 契约

- [ ] 阅读并确认 `driver.ts`、`runtime/ports.ts`、`platform-host.ts`、`persistence.ts`、`platform-tools.ts`。
- [ ] 新增 `PipelineRunService` 类型和错误映射，不接 HTTP。
- [ ] 用 ScriptedStageRunner 写 service contract tests。
- [ ] 明确 actor/tenant/project/pipeline scope 类型。

### P0-A1：文档解析与知识库导入

- [ ] 新增 `documents/` 解析器注册表和 `ParsedDocument` 统一中间表示。
- [ ] 实现 PDF、DOCX/可选 DOC、XLSX/可选 XLS、Markdown、CSV/TSV、TXT/YAML/JSON 解析器。
- [ ] PDF 保留页码，Word 保留章节/表格，Excel 保留 sheet/range，Markdown 保留 heading/table/code block。
- [ ] 所有解析器实现文件大小、页数、sheet 数、行数、字符数、解压大小和超时限制。
- [ ] 禁止宏、PDF JavaScript、外链下载、XML 外部实体、OLE/嵌入对象和任意代码执行。
- [ ] `.doc`/`.xls` 如果没有安全解析器必须返回 `unsupported`，不能按文本读取或假装支持。
- [ ] `parse_doc` 返回 `status`、`confidence`、`sections`、`tables`、`plainText`、`diagnostics`、`limits` 和 `sourceRefs`。
- [ ] 文档解析只生成 `draft` 知识条目；active 写入仍走机器校验、人工门、冲突治理和回读验证。
- [ ] 增加正常、损坏、加密、超限、恶意压缩、路径越界、AbortSignal、重复导入和 sourceRef 回读测试。
- [ ] 写 ADR 记录解析库、Node 兼容性、许可证、沙箱方式、失败降级和 `.doc`/`.xls` 支持策略。

### P0-B：M1 Web 接入

- [ ] 把 Web API Key 输入改为服务端 provider 配置；浏览器不再上传 key。
- [ ] 新增 Web service，所有运行通过 `createPlatformHost` + `PipelineDriver`。
- [ ] 删除或停用 Web 自建 `promptFor`、`callModel`、`runPipeline`。
- [ ] 新增 create/get/run/gates/claim/decide/cancel/reenter API。
- [ ] 前端显示真实阶段状态、人工门任务、机器违规和审核 findings。
- [ ] 增加 Web 进程重启后的恢复测试。

### P0-C：M2 并发

- [ ] 强化 `checkpoint-lock.ts` 的 owner/generation/heartbeat/stale recovery。
- [ ] CLI 与 Web 复用相同 lock 路径和 acquire/release 逻辑。
- [ ] 为 pipeline create、gate decision、executor invocation 增加幂等键。
- [ ] 增加双进程和 kill/restart 测试。

### P1-A：M3 预算

- [ ] 新增 UsageEvent/UsageStore 和文件实现。
- [ ] 接入 LLM usage、tool steps、review、executor、耗时。
- [ ] 超限时写 checkpoint failure，不自动进入人工批准。
- [ ] Web/CLI 提供 usage 查询。

### P1-B：M4 存储

- [ ] 抽取 storage ports 和 file contract tests。
- [ ] 文件后端补 schema version、损坏文件诊断、迁移策略。
- [ ] 评估并实现 PostgreSQL/object-store adapter；若本阶段不部署外部后端，至少交付接口和 ADR。

### P0-D：M5 发布

- [ ] 全量 typecheck/build/test。
- [ ] 安全、恢复、并发、预算、Web 集成测试。
- [ ] 更新 README 状态、部署说明和配置样例。
- [ ] 推送前确认工作区干净、`HEAD == origin/main`。

## 11. 每项实现的固定验收模板

实现模型每个任务完成后，必须在提交说明中回答：

1. 改了哪些文件？
2. 哪些接口/状态/路径发生变化？
3. 是否引入了 Harness 依赖？若是，为什么（默认应为否）。
4. 是否有任何自动批准、跨项目读取或路径越权风险？
5. 新增了哪些失败路径测试？
6. typecheck/build/全量测试结果是什么？
7. Web/CLI/进程重启是否使用相同的持久化事实？
8. 未完成项和后续迁移风险是什么？

## 12. 建议提交顺序

建议不要把所有里程碑合并成一个大提交：

1. `feat: add framework-neutral web pipeline service`
2. `feat: wire web api to persistent pipeline runtime`
3. `fix: harden pipeline lease and idempotency`
4. `feat: add usage accounting and budget enforcement`
5. `refactor: extract storage ports and backend contracts`
6. `docs: add deployment and recovery runbook`

每个提交都应独立可回滚；不要在未通过 M1 测试前开始 M4 的数据库实现。

## 13. 最终完成定义

本规划全部落地的标志不是“Web 页面能显示六个阶段”，而是：

> 同一个租户/项目下，CLI、Web、Harness 三种入口都能调用同一个 PipelineDriver；流水线状态、产物、执行证据、人工裁决、知识归档、预算和审计均来自持久化事实；文档解析统一支持 PDF、Word、Excel、Markdown 等格式，并能把每条知识追溯到页码、章节、sheet/range 或 heading；进程重启、并发运行、模型不可用、工具越权、执行器缺失和存储损坏时都能进入明确的失败/等待/恢复状态，绝不静默批准或伪造成功。
