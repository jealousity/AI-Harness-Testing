# 测试辅助平台设计（Test Platform Design）

平台型测试辅助系统设计文档集：六阶段流水线（需求接收 → 需求分析 → 测试设计 → 测试执行 → 测试报告 → 产物归档），基于 DeepSeek Harness 原语（subagent / toolFilter / session / ui-user-questions）。

## 一句话

> 契约定边界、门禁管产物、ACL 管动作、executor 保执行可信、检查点保恢复、人工门保责任、agent 只管自己那一阶段。

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

见 [docs/07-decision-checklist.md](docs/07-decision-checklist.md) 决策记录表：D-01~D-20（设计决策）+ I-1~I-3（实现期决策），全部确认。

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
- 决策：**23 条全部确认**
- 六阶段 prompt 模板：**全部评审通过**
- 实现：骨架已定（docs/09），待按落地顺序开发
