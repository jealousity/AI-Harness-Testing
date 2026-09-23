# platform-pipeline

测试辅助平台六阶段流水线插件包（设计文档见仓库根 `docs/`，实现骨架见 `docs/09-implementation-skeleton.md`）。

六阶段：需求接收 → 需求分析 → 测试设计 → 测试执行 → 测试报告 → 产物归档。基于 DeepSeek Harness 原语，**独立 npm 包**部署（I-4：任何人任何平台可部署）。

## 架构一句话

> 契约定边界、门禁管产物、ACL 管动作、executor 保执行可信、检查点保恢复、人工门保责任、agent 只管自己那一阶段。

## 模块（src/）

| 模块 | 内容 | 设计文档 |
|---|---|---|
| `types.ts` | 流水线配置 / 检查点 / 产物核心类型；STAGE_ORDER / STAGE_UPSTREAMS | 02 |
| `config.ts` | pipeline.yaml/json → PipelineConfig（默认预算/门/规则/交叉检查；规则范围展开） | 02 |
| `checkpoint.ts` | 检查点原子读写（tmp→rename） | 02/03 |
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
| `plugin.ts` | cordis 插件入口：装配确定性组件，注册 `ctx.pipeline` 服务 | 09 |
| `provider-registry.ts` | 通用 OpenAI-compatible provider 声明、环境变量密钥检查与能力选择 | 平台化 |
| `platform-scope.ts` | tenant/project/environment 作用域和安全数据目录 | 平台化 |
| `knowledge-import.ts` | Markdown 章节、CSV/TSV 表格导入为 draft 知识条目 | 平台化 |
| `runtime/` | 无 Harness 的 StageRunner / LlmClient / ToolRegistry / HumanGate 端口、ScriptedStageRunner、OpenAICompatibleClient、OpenAIStageRunner、TaskStore 与 HumanGateTaskStore | 方案一 |

## 使用

```bash
npm install        # 通用核心只需 yaml；Harness 适配器依赖作为开发依赖保留
npm test           # node --test（原生 TS，Node >= 24）
npm run typecheck  # tsc --noEmit
npm run cli -- validate --config ../../examples/pipeline.yaml   # 配置自检

# 无 Harness 的 OpenAI-compatible 客户端（API Key 只从环境变量读取）
export PLATFORM_LLM_API_KEY=...
# OpenAICompatibleClient 支持 tools、json_schema、超时和 429/5xx 重试
npm run cli -- knowledge-import --input ./docs/project.md --store ./knowledge --project demo-project
# CSV/TSV 同样支持，导入结果默认写为 draft 知识并携带 sourceRefs

# 当前阶段按源码构建和宿主部署，不生成或依赖 tgz 打包产物
npm run build      # tsc -p tsconfig.build.json → dist/

# 配置中的 API Key 只从环境变量注入
export PLATFORM_LLM_API_KEY=...
# provider 能力和项目 scope 会在 pipeline 配置装载时校验
```

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

最小宿主已落地（`src/e2e/minimal-host.ts`），真实外接 DeepSeek / 千问 六阶段端到端跑通（receive→analyze→design→execute→report→archive），含重入级联 + 故障注入审核 fail 回喂重跑闭环（见 `test/e2e/`）。它默认使用内置 e2e 配置；设置 `E2E_PIPELINE_CONFIG=/path/to/pipeline.yaml` 后会读取外部项目配置中的 `llm.providers`，并将 provider 的 baseUrl/model/apiKeyEnv 转换为 Harness LLM 插件配置，仍由 Harness 的 `deepseek-official` 适配路由承载 OpenAI-compatible 请求。

## 状态

- 设计文档：9 份定稿（docs/01~09）+ 24 条决策（docs/07）
- 确定性代码层：已覆盖核心编排、执行可信、知识库治理和通用平台基础，当前 **213 项测试全绿**
- 宿主接线：完成（minimal-host）；真实 LLM 六阶段端到端通过，含重入级联 + 故障注入（里程碑 7）
- 当前阶段不生成 tgz 打包产物；通用核心默认入口不加载 Harness 适配层，Harness 宿主代码通过 `platform-pipeline/harness` 与 `platform-pipeline/harness-plugin` 可选子路径使用。
- `FileTaskStore` / `FileHumanGateTaskStore` 通过原子 JSON 文件记录任务状态、worker lease、heartbeat 和人工门决策；适合作为单机/单数据根实现，分布式部署仍需数据库或队列后端。
