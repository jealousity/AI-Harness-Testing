# 01 机器门禁规则明细（评审稿 v1）

> 配套文档：[02 流程模板 v1（pipeline.yaml schema 草案）](./02-pipeline-template-v1.md) · [03 Agent 角色设定与边界规则](./03-agent-roles-and-boundaries.md)
> 状态：评审稿。定稿后每条规则进入代码实现 + 单元测试。
> 与本系列后续文档的关系：本文档只定义"机器门禁判定规则"；agent 角色设定与边界规则见 03；流程模板与契约见 02。

---

## 0. 文档目的与范围

机器门禁是每个阶段"产物 → 人工审核"之间的确定性检查层，**永远执行、无 LLM 参与、由代码判定**。本明细定义：

- 门禁在流水线中的位置与两段模型；
- 规则分级（BLOCKING / WARNING）及处理策略；
- 平台标准通用规则（不可删）；
- 六阶段特定规则（可增删，但默认模板给出推荐集）；
- 门禁失败处理流程（回喂重跑 → 升级人工）；
- 判定留痕与审计；
- 项目追加规则的扩展点。

范围外：agent 执行逻辑、人工门问题模板（见 02 文档第 5 节）、存储适配实现。

---

## 1. 门禁位置与两段模型

每个阶段从"执行 → 流转"为四段。注：可选的**交叉检查**（独立审核 agent，03 第 7 节）位于机器门禁与人工审核之间，不改变本文档定义的机器门禁本身：

```
[阶段 agent 执行]
      │  产物落盘（candidate，未准入）
      ▼
[1] 机器门禁（确定性代码，永远执行）
      │  BLOCKING 违规 → 回退重跑（带违规清单）
      │  通过（含 WARNING 记录）
      ▼
[可选] 交叉检查（仅 review.enabled 的阶段，见 03 第 7 节）
      ▼
[2] 人工审核（交互模式，全部阻塞等确认）
      │  通过
      ▼
[3] 标记 done → cursor 推进 → 下一阶段
```

原则：

1. **机器门禁必须先于人工审核**。人只审"已通过机器校验"的产物；机器规则是代码，可单测、可回归、可留痕，人工判断不可回归。
2. **机器闸与人工闸性质不同**：机器闸防"格式/完整性/一致性"错误（可枚举）；人工闸防"语义/责任"错误（不可枚举）；交叉检查（LLM 二读）防"语义/逻辑/偏见"错误，介于两者之间且结论可被人工推翻。
3. **机器门禁不因"该阶段简单"而跳过**；任何阶段（含归档）都有机器门禁。

---

## 2. 规则分级

| 级别 | 语义 | 处理 |
|---|---|---|
| **BLOCKING** | 违反则产物不可流转 | 产物回退本阶段重跑（违规清单回喂 agent，≤N 次，默认 2）；重试耗尽 → `gate-failed` 升级人工（修复产物后放行，或终止流水线） |
| **WARNING** | 不阻断流转，但必须记录并随产物带到人工审核 | 人工审核页必须展示全部 WARNING，人工确认后才流转 |

判定口径：

- 一条规则一次判定产生一条记录（`violation`），含 `rule`、`level`、`detail`、`at`。
- 同一次判定中 BLOCKING 存在即整体 `gate.status = failed`；仅 WARNING 则 `passed`。
- 重跑后重新判定，**全量重判**，不增量补判。

---

## 3. 平台标准通用规则（不可删）

对所有阶段生效，项目不可关闭、不可降级为 WARNING。规则 id 以 `G-` 前缀。

| id | 规则 | 判定逻辑（示例） | 级别 |
|---|---|---|---|
| G-01 | Schema 校验 | 产物按本阶段契约 schema 逐项校验（type/properties/required/items/enum/const/oneOf），任一不符 → BLOCKING | BLOCKING |
| G-02 | 必填非空 | 必填数组/字符串不允许空值当成功（如 `expected: []`、`steps: []`） | BLOCKING |
| G-03 | 证据义务 | 要求 `evidence` 的字段必须有引用；引用可解析（文件存在；用例 id / 需求 id 存在于本产物或上游产物） | BLOCKING |
| G-04 | 幂等合规 | 产物写入固定寻址地址；digest 记录；重跑不产生第二份产物 | BLOCKING |
| G-05 | 预算合规 | 步骤数 / token / 耗时未静默超限；超限必须显式标记 `budgetExceeded: true`，否则视为违规 | BLOCKING |
| G-06 | 占位符禁令 | 必填内容字段禁止 `TODO` / `待补充` / `同上` / `TBD` / `...` 等占位 | BLOCKING |
| G-07 | 内部一致性 | 引用完整性：本产物内部引用（如 `coverageRef`、`caseId`）必须可解析到本产物或上游产物 | BLOCKING |
| G-08 | **输入摘要锁** | 产物声明 `inputs.{stageId: digest}`（消费的上游产物 digest）；机器重算上游产物当前 digest 并比对，任一不一致 → BLOCKING（detail 含新旧 digest）。支撑级联失效与重入（见 03 第 8 节） | BLOCKING |

---

## 4. 六阶段特定规则

默认模板推荐集，规则 id 以阶段前缀（R1~R6）+ 序号命名。**项目可在"标准规则不可删"前提下追加自定义规则（见第 7 节），但默认集之外的删减需评审**。

### [R1] 需求接收

| id | 规则 | 判定逻辑 | 级别 |
|---|---|---|---|
| R1-01 | 需求 id 唯一非空 | 需求清单内 id 无重复、非空 | BLOCKING |
| R1-02 | 来源可溯 | 每条需求带 `sourceRef`（jira ticket / 文件路径 / 粘贴来源） | BLOCKING |
| R1-03 | 缺字段显式化 | 机器核对"契约必填字段中缺失的集合" == `clarifications` 集合（缺什么就澄清什么，二者必须一致，不允许缺字段但澄清列表为空） | BLOCKING |
| R1-04 | 聚合完整性 | 多输入源时，产出数量 ≥ 各源去重后的需求数量下限（防止解析时丢需求） | WARNING |

### [R2] 需求分析

| id | 规则 | 判定逻辑 | 级别 |
|---|---|---|---|
| R2-01 | 澄清问题可答 | 每条 `openQuestions` 带 `needs`（需要确认的具体事项），不允许空问题 | BLOCKING |
| R2-02 | 复用建议可查回 | 每条 `reuseSuggestions.caseId` 能通过用例库适配层查回（库中不存在 → BLOCKING；存在但版本差异 → WARNING） | BLOCKING |
| R2-03 | 影响版本有依据 | `versionImpact` 非空或显式 `"none"`；每条影响项带依据引用（版本档案 / 需求变更点） | BLOCKING |
| R2-04 | 边界自洽 | `boundaries.in` 与 `boundaries.out` 均存在；排除项（`out`）不得与需求目标直接冲突 | WARNING |
| R2-05 | 检索裁剪 | 知识库/历史用例检索结果未超预算裁剪上限；超限必须标记 `retrievalTruncated: true` | WARNING |

### [R3] 测试设计

| id | 规则 | 判定逻辑 | 级别 |
|---|---|---|---|
| R3-01 | **覆盖矩阵完备** | 每个需求点 ≥1 条用例（防漏测核心闸）；矩阵内所有 `caseId` 均存在于 `testCases ∪ reusedCases` | BLOCKING |
| R3-02 | 用例 id 唯一 | `testCases` 与 `reusedCases` 合并集内 id 无重复；id 在流水线内稳定（幂等键的一部分） | BLOCKING |
| R3-03 | 数量预算 | 用例总数（`testCases + reusedCases`）≤ 规模档位推导的生成上限（见 02 文档第 8 节） | BLOCKING |
| R3-04 | gaps 自洽 | `gaps` 列出的需求点确实是"零用例"需求点；与矩阵无矛盾 | BLOCKING |
| R3-05 | 结构完备 | 每条用例（含 `reusedCases`）：`preconditions` / `steps` / `expected` 非空；`execution_level` 已解析（非空）；`reusedCases` 每条带 `sourceCaseId` 与 `adaptation` | BLOCKING |
| R3-06 | 优先级分布 | P0 用例存在且非空（至少一条 P0，`testCases ∪ reusedCases`） | WARNING |
| R3-07 | 复用溯源 | `reusedCases` 的 `sourceCaseId` 能通过用例库适配层查回；`adaptation` 为枚举值 | BLOCKING |

### [R4] 测试执行

| id | 规则 | 判定逻辑 | 级别 |
|---|---|---|---|
| R4-01 | 覆盖无缺跑 | `results` 覆盖全部计划用例（无缺跑、无多余）；计划清单来自 [R3] 产物 | BLOCKING |
| R4-02 | 失败带证据（快照清单） | 每条 fail/pending 带 `evidence`，且必须引用 `evidence-manifest.json` 条目；条目 digest 可验证、文件存在（证据快照完整性，见 03 第 6 节） | BLOCKING |
| R4-03 | 失败分类隔离 + 关联校验 | `envIssues`（环境问题）与用例失败（defect/case 问题）分类不混；同一现象不得同时计入两类；`results` 中带 `envIssueId` 的失败，其引用必须存在于 `envIssues`（续跑时环境关联失败可重跑的依据，见 03/05 execute 模板） | BLOCKING |
| R4-04 | manual 档清单 | `execution_level: manual` 的用例全部进入 `pendingManual` 清单（人工执行回填入口） | BLOCKING |
| R4-05 | 环境初始化幂等 | 环境初始化执行记录带幂等键；重跑次数与产物记录一致 | WARNING |
| R4-06 | 续跑完整性 | `resumed: true` 时：已 pass 用例未重跑（attempts 保持原值）、未执行用例全部有结果；`resumed` 与 `results` 状态自洽 | WARNING |
| R4-07 | 阻塞级环境问题可行动 | `severity: blocking` 的 envIssue 必须带非空 `diagnosis`（env_diag 证据）与 `recommendation`（修复建议）；`category` 为枚举值 | BLOCKING |
| R4-08 | **执行-产物对账**（防空跑/漏跑） | 机器重算 `executorRecords` ↔ `results`：每个 result 必须引用真实存在的 record（无 record 的 result = 伪造）；每个计划用例必须有 record（无 record = 漏跑）；每个 record 必须被引用（无引用 = 多余执行） | BLOCKING |
| R4-09 | **时序链**（防删改记录） | executor 记录带 prevHash/ownHash：逐条重算 hash，链必须连续、时间单调、时长与时间戳跨度一致；删/插/改/回填历史时间 → 链断或 hash 不匹配 | BLOCKING |
| R4-10 | **证据指纹与来源锚定**（防虚假产物） | evidence 必须 `capturedBy: "executor:<invocationId>"`（agent 写的证据不认）、digest 可重算、capturedAt 与 record 时间窗口一致、文件存在且非空 | BLOCKING |
| R4-11 | **manual 信任规则** | a. manual 结果必须带 `sessionId` + `attestedBy`，时间戳在会话窗口内；b. manual 失败无说明 → BLOCKING；c. 报告披露 manual 占比与未抽检数 | BLOCKING |

### [R5] 测试报告

| id | 规则 | 判定逻辑 | 级别 |
|---|---|---|---|
| R5-01 | **数字与源一致** | 机器重算 `stats.passRate / byPriority / byModule` 与产物比对，不一致即 BLOCKING（数字必须由代码聚合，LLM 只做解读） | BLOCKING |
| R5-02 | 缺陷可追溯（快照清单） | 每条缺陷分析引用存在的 `caseId`；证据引用从 `evidence-manifest.json` 解析，禁止引用快照外路径（见 03 第 6 节） | BLOCKING |
| R5-03 | 风险非空 | `risks` 数组非空（"无风险"也须显式写 `[]` 之外的说明，如 `[{risk: "none", evidence: ...}]`） | BLOCKING |
| R5-04 | 未确认项披露 | `unconfirmed` 列出全部 WARNING / 人工未确认项；为空时须显式声明 | BLOCKING |
| R5-05 | 发布建议合规 | `releaseRecommendation` 字段存在且为枚举值（approve / conditional / reject）+ 理由 | BLOCKING |
| R5-06 | **发布建议信任约束** | manual-claimed 结果占比超阈值（默认 >30%，按项目档位可覆盖，写入 pipeline.yaml `releasePolicy.maxManualClaimedRatio`）或未完成抽检时，`releaseRecommendation` 不得为 `approve`（只能 conditional/reject）（见 08 文档第 4.2 节） | BLOCKING |

### [R6] 产物归档

| id | 规则 | 判定逻辑 | 级别 |
|---|---|---|---|
| R6-01 | 知识条目模板完整 | 每条 `knowledgeEntries` 满足检索模板字段（见 02 文档第 11 节），关键实体（模块/接口/变更点）非空 | BLOCKING |
| R6-02 | 用例回流版本化 | 每条 `caseArchive` 带版本 + 来源需求 + 关联 ticket；同一 (内容摘要, 需求) 去重不覆盖旧版本记录 | BLOCKING |
| R6-03 | 归档幂等 | 同一 pipelineId 重复归档不产生重复条目（产物寻址 + 摘要去重） | BLOCKING |
| R6-04 | 清单一致性 | 归档清单与上游产物清单一致（[R1]~[R5] 产物全部入档，无缺漏、无多余） | BLOCKING |
| R6-05 | 检索回读验证 | 知识库结构变更后触发示例检索回读，验证能命中（检索友好性验收）；平时定期抽检（D-04） | WARNING |

---

## 5. 门禁失败处理流程

```
机器门禁 BLOCKING 违规
   │
   ├─ 违规清单回喂阶段 agent（语义重试，≤N 次，默认 2）
   │     每次重跑把 violations 作为上下文输入，要求逐条修复
   │
   └─ 重试耗尽仍违规 → gate-failed → 升级人工：
        人工可"修复产物后放行"或"终止流水线"（此时才需要人介入机器层）
```

处理原则：

1. **回喂的是违规清单，不是原产物**。agent 拿到"哪里不合格"而非"重做一遍"，避免无信息重跑。
2. 重跑次数计入阶段预算；重试耗尽后进入 `gate-failed` 状态，流水线暂停等待人工，不再自动重试。
3. WARNING 不触发回退，但必须进入人工审核页；**允许一键全部确认 + 留痕**（D-02），未确认的 WARNING 由 [R5-04] 在报告中披露。
4. **人工"修复放行"后仍需二次机器判定**（D-01）：人工修复只是提供新产物版本，放行前必须再跑一次机器门禁；人工 override 记录在 `gate.human.records`（含理由）。

---

## 6. 判定留痕与审计

每次机器门禁判定必须写入检查点（见 02 文档第 9 节）：

- `gate.machine.status`：`passed | failed`
- `gate.machine.attempts`：本次产物的判定次数
- `gate.machine.violations[]`：每条含 `rule` / `level` / `detail` / `at`，含 WARNING
- `gate.human.records[]`：人工动作留痕（`by` / `action` / `at` / `note`）

留痕要求：

- 人工放行被 BLOCKING 拦截的产物（`gate-failed` 后人工修复放行）必须记录"人工 override"及理由。
- 规则本身有版本（规则集随模板版本演进），判定记录须带规则集版本，保证历史判定可回放。

---

## 7. 扩展点：项目追加规则

- **允许追加、不允许删标准规则**（G-01~G-07 与默认阶段规则集不可删）。
- 追加规则同样走代码实现 + 单元测试，与平台规则同一判定管道、同一留痕格式。
- 追加规则可挂任意阶段；规则 id 以项目前缀命名（如 `acme-R3-07`），避免与平台规则冲突。
- 追加规则可覆盖"WARNING/BLOCKING 级别"但不得修改平台规则的级别。
- 规则集变更属于模板版本变更：升级模板时，历史流水线按旧规则集判定结果继续，不受新规则回溯影响。

示例（追加规则）：

```
acme-R3-07  每条用例必须带 data 字段引用   BLOCKING   （项目规范：数据驱动必须外置）
acme-R2-06  复用建议必须来自近 6 个月用例    WARNING    （项目规范：过期用例需提示）
```

---

## 8. 开放问题（待评审）

1. ~~重试次数 N 的取值~~ ✅ 已决策：保持 N=2（一次是幻觉判别期、二次定性，之后升级人工）。
2. ~~规则集版本与模板版本的关系~~ ✅ 已决策（D-03）：规则集独立版本化。
3. ~~归档回读验证（R6-05）的成本~~ ✅ 已决策（D-04）：仅知识库结构变更后回读 + 定期抽检。

**01 全部开放问题清零。**
