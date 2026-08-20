# 06 工具调用权限控制（评审稿）

> 配套文档：[01 机器门禁规则明细](./01-machine-gate-rules.md) · [02 流程模板 v1](./02-pipeline-template-v1.md) · [03 Agent 角色设定与边界规则](./03-agent-roles-and-boundaries.md) · [04 Prompt 模板框架](./04-prompt-templates.md) · [05 阶段 Prompt 模板评审](./05-stage-prompt-reviews.md)
> 状态：评审稿。本文档定义工具调用的**强制层与审批层**；声明层（prompt 第 4 节）见 04/05。

---

## 0. 文档目的与范围

定义阶段 agent **能调用哪些工具、调用了越权工具会怎样、高风险工具如何人工把关**。核心是三层权限模型：声明层（prompt 告知）、强制层（toolFilter 物理不可达）、审批层（requiresApproval 人把关）。

范围外：产物门禁（01）、流程配置（02）、角色边界（03）、prompt 模板（04/05）。

---

## 1. 三层权限模型

| 层 | 是什么 | 性质 |
|---|---|---|
| **声明层** | 每阶段 prompt 第 4 节"工具与权限" | 建议性（agent 可能无视）；作用仅是"告知 agent 世界里有这些工具" |
| **强制层** | mainAgent spawn 时传 `toolFilter`，harness 在子 agent 创建窗口执行 `ctx.tools.restrict()` | **确定性代码**：被禁工具从子 agent 的 prompt 中消失 + 执行被拒绝，物理不可达 |
| **审批层** | 工具级人工确认（`requiresApproval`） | 高风险副作用动作执行前暂停等人确认 |

prompt 只是"告知"，强制才是"保障"，审批是"最后的人闸"。

---

## 2. 工具目录（平台注册时声明元数据）

```jsonc
{
  "id": "kb_query",                 // 工具名（与 toolFilter 同名）
  "effect": "read-only",            // read-only | mutate-workspace | mutate-external | ask-human
  "store": "knowledge",             // knowledge | cases | requirements | fs | executor | external | checkpoint
  "requiresApproval": false         // true 时执行前暂停等人工确认（审批层）
}
```

本系统工具目录（示例，按需扩展）：

| 工具 id | effect | store | requiresApproval | 说明 |
|---|---|---|---|---|
| `kb_query` | read-only | knowledge | — | 知识库只读检索（[2] 用） |
| `kb_write` | mutate-external | knowledge | ✅（外部 KB）/ 融合（共享 fs） | 知识库写入（仅 [6]） |
| `case_query` | read-only | cases | — | 历史用例只读查询（[2] 用） |
| `case_archive` | mutate-external | cases | ✅ | 用例版本化回流（仅 [6]，见第 7 节） |
| `req_pull` | read-only | requirements | — | 需求源拉取（mainAgent 预处理用，阶段 agent 不可见） |
| `parse_doc` | read-only | requirements | — | 文档解析（[1] 用） |
| `fs_read` | read-only | fs | — | 文件读取 |
| `fs_write` | mutate-workspace | fs | 按路径限制，不弹审批 | 文件写入（限 `artifacts/<pipelineId>/` 与各阶段自己路径） |
| `executor_run` | mutate-workspace | executor | 由权限预设治理 | 执行器启动（[4] 用）：**入参只传 caseId，出参为 executor 自产的执行记录与证据**（08 文档第 2 节——agent 无法传入"想要的结果"） |
| `env_diag` | read-only | executor | — | 环境只读诊断：磁盘用量/网络可达性/服务健康/凭据状态（[4] 用，仅返回固定探针的结构化结果，不授予任意命令执行权） |
| `gate_check` | read-only | checkpoint | — | 机器门禁（mainAgent 专用） |
| `subagent` | ask-human | — | — | 仅 mainAgent 可 spawn |

**只读强制的语义**：`kb_query` / `case_query` 是只读变体——工具实现层只有读路径（无副作用），不依赖 agent 自觉。

---

## 3. 平台标准 ACL（每阶段默认，不可删）

与 03 角色表工具列一致，是权限的**唯一事实来源**（版本化，与门禁规则 G 系列同等级：不可删除、不可降级）：

| 阶段 | allow | deny（兜底，显式优先） |
|---|---|---|
| [1] receive | `parse_doc, fs_read, fs_write` | `kb_query, kb_write, case_query, case_archive, executor_run, subagent` |
| [2] analyze | `kb_query, case_query, fs_read, fs_write` | `kb_write, case_archive, parse_doc, executor_run, subagent` |
| [3] design | `fs_read, fs_write` | `kb_query, kb_write, case_query, case_archive, executor_run, subagent` |
| [4] execute | `fs_read, fs_write, executor_run, env_diag` | `kb_write, case_archive, subagent` |
| [5] report | `fs_read, fs_write` | `kb_write, case_archive, executor_run, subagent` |
| [6] archive | `fs_read, fs_write, kb_write, case_archive` | `subagent` |

- 平台演进新增工具时，若不在任何阶段 allow 里 → 默认不可达（deny-all 兜底），不存在"新工具悄悄放行"。
- **越权 ≠ 用了不该用的已存在工具**：被禁工具物理不可见，"用了不该用的"只可能是 ACL 配宽了——那是配置评审问题（见第 4 节），不是运行时违规。这条区分写死，避免把配置问题误判成 agent 问题。
- **execute 阶段的 evidence/ 目录由 executor 独占**（08 文档第 2 节）：execute agent 的 `fs_write` 路径范围排除 `evidence/`，证据只能由 executor 进程写入——agent 无"补写证据"能力。

---

## 4. 项目 delta（默认继承 + 只可收窄）

```
生效 ACL = 平台标准 + 项目 delta（pipeline.yaml stages[].tools）
  ├─ 追加 deny：自由（收窄无风险，无需评审）
  ├─ 追加 allow：需评审（扩大攻击面，配置必须带 review 标注）
  └─ 不允许删除/降级平台标准 deny
```

pipeline.yaml 示例：

```yaml
stages:
  - id: analyze
    tools: { deny: [kb_query] }        # 项目可关掉知识库检索（收窄）
  - id: design
    tools: { allow: [case_query] }     # 项目需要读用例做覆盖比对（需评审，带 review 标注）
```

---

## 5. 运行时强制（mainAgent 侧）

```
spawn 阶段 agent 时：
  subagent({ prompt, toolFilter: 生效ACL, ... })
    ├─ 工具目录校验：allow/deny 中的工具名必须存在于工具目录
    │    （未知名 → spawn 失败，启动即暴露配置错误；deny-all 防护 harness 已内置）
    ├─ harness 执行 restrict()：被禁工具从子 agent prompt 消失 + 执行被拒绝 ← 强制点
    ├─ requiresApproval 工具（归档写库等）→ 批次审批（第 7 节）
    └─ 越权调用 → 分层处理（第 6 节）
```

强制点不在 prompt 里：即使 prompt 被注入篡改、或 agent 试图调用被禁工具，工具本身不存在于它的世界。

---

## 6. 越权处理（分层策略）

```
第一次越权调用（调用不存在的工具）
  → 记录 toolViolations[0]（工具日志 + 检查点）
  → 不打断：agent 收到"工具不存在"错误，获得自然纠正机会
  → 阶段继续

同一次执行内第二次越权调用
  → 阶段失败（语义失败类）
  → mainAgent 重 spawn 一次（extraContext 标注"你调用了不存在的工具 X，
     只允许使用第 4 节列出的工具"）
  → 重 spawn 后再次越权 → 升级人工（不再重试）

跨阶段/跨流水线同一工具名反复出现
  → 工具目录层标记该工具名为"疑似注入目标"，报告阶段 unconfirmed 披露
```

**理由**（分层而非一刀切）：

- 单次越权信息量低：LLM 偶发幻觉工具名是真实的低频事件，一次即失败会过度惩罚、增加摩擦。
- 重复是唯一可靠信号：幻觉不会重复同一个工具名，注入会。第一次是"幻觉 vs 注入"判别期（记录 + 自然纠正），第二次是定性（持续越权 = 角色混淆或注入，不再容忍）。
- 纯放行会留无限探测窗口（恶意输入让 agent 反复试工具，烧预算且无警报）；一次即失败则惩罚过度。分层取两者中间。

---

## 7. 审批层（三类动作三种治理）

| 动作类别 | 治理方式 | 理由 |
|---|---|---|
| **外部系统写入**（case_archive → Xray/TestLink、kb_write → 外部 KB、jira 写） | `requiresApproval: true`，无条件 | 外部副作用难撤销，动作级确认不可省 |
| **共享存储写入**（v1 的 markdown-fs 知识库/用例库——跨项目长期资产） | `requiresApproval: true`，**与人工门 G 融合为一次确认**（D-18：合并一次、清单内按知识库/用例库分组展示） | 写入共享资产是持久副作用；G 已是内容级确认，融合成"一个弹窗：归档清单 + 待执行写入"，避免两次打扰 |
| **workspace 产物写**（fs_write 到 `artifacts/<pipelineId>/`） | 不弹审批，路径限制为唯一治理 | 流水线私有产物，可重建、可清理，弹审批是噪音 |
| **执行器**（executor_run） | 不弹审批，由 harness 权限预设治理（Workspace Write 等） | 执行是本阶段核心职责，逐次审批不可操作；权限预设已在更底层兜底 |
| **subagent**（仅 mainAgent） | mainAgent 自己的工具集被 restrict 收窄 | 与 03 角色边界一致 |

**关键设计**：审批不是"每个写操作都弹窗"，而是按**批次/动作单元**确认——归档阶段一次确认覆盖该次全部写库操作。兑现 03 第 7 节"人工门永不被替代"，同时不制造审批疲劳。

---

## 8. 审计

- 每次工具调用（含被拒调用）落工具日志：`{ stage, tool, args摘要, verdict: allowed|denied, at }`（args 脱敏，secret 字段不记录）。
- 越权尝试记检查点 `toolViolations[]`；报告阶段 `unconfirmed` 披露。
- harness 的 session 日志（tool/call 事件）天然提供调用记录，本设计在其上附加 ACL verdict。

---

## 9. 一致性约束（四者必须一致）

03 角色表工具列 / 05 prompt 第 4 节 / 02 的 tools 字段 / 运行时 toolFilter **四者必须一致**：

- 模板测试新增一条：按 pipeline.yaml 生成子 agent，断言子 agent 可见工具集 == 生效 ACL（allow 集）。
- 任何一处变更（如某阶段新增工具）必须四处同步；测试失败即暴露漂移。

---

## 10. 开放问题（待评审）

1. ~~工具目录的注册主体~~ ✅ 已决策（D-16）：平台插件注册为主，pipeline.yaml 只引用 + delta。
2. ~~args 脱敏规则~~ ✅ 已决策（D-17）：平台通用规则兜底（key/token/password/secret 键名匹配 + 值截断）+ 凭据类敏感工具额外声明敏感字段。
3. ~~批次审批的粒度~~ ✅ 已决策（D-18）：合并一次确认，清单内按知识库/用例库分组展示（见第 7 节）。
4. ~~越权重试的 budget 消耗~~ ✅ 已隐含决策：计入阶段 maxRetries（03 第 5 节失败行为分工，重试预算统一由 mainAgent 代码化策略管理）。
