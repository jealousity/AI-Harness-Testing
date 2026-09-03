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
| `harness/` | HarnessStageSpawner：`ctx.subagents.start` + toolFilter 映射（type-only 依赖，运行时零 harness 引用） | 09/06 |
| `executor/` | 执行可信：时序链（R4-09）/ 对账（R4-08）/ 证据锚定（R4-10）/ HttpExecutor（wire 留痕）/ env_diag 探针 | 08 |
| `stores/` | FsArtifactStore / FsCheckpointPort / MarkdownKnowledgeStore / MarkdownCaseStore（版本化回流） | 02/07 |
| `report/` | 报告渲染器（六段人读报告，确定性代码） | 02/12 |
| `execute/` | manual 执行会话模型（4h 窗口 / R4-11a / 失败必注） | 08/04 |
| `prompt/` | 公共骨架 + 六阶段差异段 + 审核 prompt（必查清单） | 04/05 |
| `plugin.ts` | cordis 插件入口：装配确定性组件，注册 `ctx.pipeline` 服务 | 09 |

## 使用

```bash
npm install        # 依赖（yaml 运行时；@deepseek-ai/* 仅 devDeps/peerDeps）
npm test           # node --test（原生 TS，Node >= 24）
npm run typecheck  # tsc --noEmit
npm run cli -- validate --config ../../examples/pipeline.yaml   # 配置自检

# I-4 独立 npm 包部署
npm run build      # tsc -p tsconfig.build.json → dist/
npm pack           # prepack 自动 build，产出 platform-pipeline-0.1.0.tgz

# 任意环境安装（零 harness 运行时依赖，仅 peerDependencies 声明宿主能力）
npm install platform-pipeline-0.1.0.tgz
node -e "import('platform-pipeline').then(m => console.log(m.STAGE_ORDER.join('→')))"
```

## 宿主接线（已完成）

`run`/`reenter` 需要宿主注入（`src/plugin.ts` 集成点，均标注）：

- **spawner**：`HarnessStageSpawner` + 当前会话的 parent Agent（`ctx.subagents.start`，API 已核实，见 docs/09 验证点）
- **human**：ui-user-questions 实现的人工门（A~G；D-01 二次机器判定）
- **review**：独立审核 agent（`outputSchema` 结构化输出）

最小宿主已落地（`src/e2e/minimal-host.ts`），真实外接 DeepSeek / 千问 六阶段端到端跑通（receive→analyze→design→execute→report→archive），含重入级联 + 故障注入审核 fail 回喂重跑闭环（见 `test/e2e/`）。

## 状态

- 设计文档：9 份定稿（docs/01~09）+ 24 条决策（docs/07）
- 确定性代码层：**全部落地，137 单测全绿**
- 宿主接线：完成（minimal-host）；真实 LLM 六阶段端到端通过，含重入级联 + 故障注入（里程碑 7）
- I-4 独立 npm 包：`platform-pipeline-0.1.0.tgz` 已产出并验证（干净目录 `npm install` → import → 解析真实 pipeline.yaml → 算 ACL 全部通过）
