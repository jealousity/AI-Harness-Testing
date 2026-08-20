# platform-pipeline

测试辅助平台六阶段流水线插件包（设计文档见仓库根 `docs/`，实现骨架见 `docs/09-implementation-skeleton.md`）。

## 状态

实现骨架第 1 步：**独立包骨架 + pipeline.yaml 配置解析 + 检查点读写 + 生效 ACL 计算**（纯 TS，零 harness 运行时依赖，可单测）。

- `src/types.ts` —— 流水线配置 / 检查点核心类型（docs/02 第 2/9 节）
- `src/tool-catalog.ts` —— 工具目录 + 平台标准 ACL（docs/06 第 2/3 节）
- `src/config.ts` —— pipeline.yaml/json → PipelineConfig（默认预算/门/规则/交叉检查）
- `src/acl.ts` —— 生效 ACL = 平台标准 + 项目 delta，校验未知工具/降级标准 deny（docs/06 第 4 节）
- `src/checkpoint.ts` —— 检查点读写（原子写 tmp→rename）（docs/02 第 9 节）

## 使用

```bash
npm install        # yaml + typescript(dev)
npm test           # node --test（原生 TS，Node >= 24）
npm run typecheck  # tsc --noEmit
```

## 部署模型

独立 npm 包（供任何 harness 部署加载，见仓库根 README 决策摘要）。后续步骤（stage-spawner / 门禁引擎 / executor / 存储适配）将声明 `@deepseek-ai/*` 为 peerDependencies，由宿主 harness 提供。

## 已核实的 harness 绑定（集成时用）

- 宿主服务入口：`ctx.subagents.start(name, request): Promise<SubagentRun>`
  （`@deepseek-ai/dsh-subagent`，checkout rc.5）
- `SubagentStartRequest.toolFilter`（`ToolRestriction`：`{ allow?, deny? }`）与本包 `ToolFilter` 结构一致；
  **allow 存在即白名单**。强制层：被禁工具从子 agent prompt 消失 + 执行被拒。
- ⚠️ 版本对齐：checkout `0.1.0-rc.5` vs npm `@deepseek-ai/dsh-subagent@next 0.1.0-rc.8`，
  devDependencies pin 版本按宿主部署决定（见 docs/09 第 11 节验证点 4）。
