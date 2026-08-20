# 03 Agent 角色设定与边界规则（评审稿）

> 配套文档：[01 机器门禁规则明细](./01-machine-gate-rules.md) · [02 流程模板 v1](./02-pipeline-template-v1.md)
> 状态：评审稿。
> 本文档定义：角色架构、mainAgent 与六阶段 agent 的职责/边界/工具白名单、信息边界矩阵、失败行为分工、证据快照、交叉检查、重入机制。

---

## 0. 文档目的与范围

本系统采用**编排与执行分离**架构：一个 mainAgent 负责初始化与调度，六个阶段各自独立 agent 执行，阶段间只通过契约产物流转。本文档是这些角色的"宪法"——职责、边界、工具、信息权限、失败处理全部在此定义。

范围外：机器门禁规则明细（01）、流程模板与契约（02）、存储适配实现、执行器实现。

---

## 1. 角色架构总览

```
                        ┌────────────────────────────────┐
                        │      mainAgent（编排器）         │
                        │  只调度，不参与测试流程           │
                        │  初始化 / 调度 / 门禁 / 人工门 /  │
                        │  检查点 / 失败分类 / 预算        │
                        └───────────────┬────────────────┘
        spawn + gate + 重试（spawn 同一个阶段 agent）       │ 人工门 A~G（阻塞）
        ┌─────────┬─────────┬──────────┼──────────┬──────────┐
        ▼         ▼         ▼          ▼          ▼          ▼
   [1]receive  [2]analyze  [3]design  [4]execute  [5]report  [6]archive
   独立 agent  独立 agent  独立 agent  独立 agent  独立 agent  独立 agent
        └────────────┴────────────┴──────────┴──────────┘
              只通过契约产物流转（artifacts/<pipelineId>/<stage>.json）
```

**核心不变量**：

1. 六阶段 agent **互不通信**，只通过产物流转（串行、无横向依赖）。
2. mainAgent **只读"路径/摘要/状态"，不读产物内容做任何加工**；产物内容由阶段 agent 自己读。
3. 机器门禁是**确定性代码工具**（mainAgent 调用），永远不是 agent。
4. 每个阶段 agent = mainAgent spawn 的**全新子 agent**（无父会话上下文，prompt 完全自包含），执行完即结束；重试 = 重新 spawn。

---

## 2. mainAgent 角色与边界

> **已决策（D-20）**：mainAgent 实现为 **host 侧纯代码 PipelineDriver**，由用户命令直接驱动（`dsh pipeline run --project <id>`）——**不是 LLM agent 会话**。因此本节的"职责/边界/工具白名单"全部转化为**代码结构约束**：代码天然不会越权、不需要"不读产物"的上下文约束、不需要 goal 生命周期（检查点 + 命令重跑即恢复）。越权处理（06 第 6 节）只针对阶段 agent。

### 2.1 生命周期

- **每轮 pipeline 新建**：接受用户启动命令时初始化；流程结束（cursor=6 且归档完成）时回收。
- **用户可主动终止**：终止时保留检查点与产物，可后续以同 pipelineId 重启续跑或重入。
- 重启续跑 = 读 checkpoint，从 cursor 恢复；与"每轮新建"不冲突——新 mainAgent 实例按同一 pipelineId 续跑旧状态。

### 2.2 职责（只做这些，代码实现）

| 职责 | 说明 | 代码模块（09 骨架） |
|---|---|---|
| 初始化 | 读 pipeline.yaml、解析契约/门/预算/存储适配、创建检查点、建产物目录 | `config.ts` + `checkpoint.ts` |
| 调度 | 按 cursor 顺序 spawn 阶段 agent，前台等待结果；execute 阶段用可续跑的后台 subagent（恢复走 continuation，不重跑） | `stage-spawner.ts` |
| 门禁执行 | 每个阶段产物产生后调用机器门禁，判定 BLOCKING/WARNING | `gates/machine.ts` |
| 语义重试 | 机器门禁 BLOCKING → 带违规清单重新 spawn 同一阶段（≤2 次） | `stage-spawner.ts` |
| 交叉检查 | 对开启 review 的阶段 spawn 独立审核 agent，处理 verdict | `stage-spawner.ts` |
| 人工门 | 门禁（+交叉检查）通过后向人提问（A~G），阻塞等确认；确认结果落检查点；manual 会话由此发起 | `human-gate.ts`（ui-user-questions） |
| 重入 | 接收用户重入指令（命令参数），执行级联重跑 | `driver.ts` |
| 检查点 | cursor 推进、状态写入、恢复时续跑 | `checkpoint.ts` |
| 失败分类 | 瞬态重试 / 永久停止 / 门禁耗尽升级人工 / 预算耗尽暂停 | `driver.ts` |
| 预算 | 每阶段步骤/token/时间上限跟踪，超限标记"预算耗尽" | `driver.ts` + `config.ts` |

### 2.3 边界（代码结构约束，天然成立）

```
mainAgent 是代码（D-20），以下约束由代码结构保证，无需 prompt：
✗ 不参与任何测试领域内容——driver.ts 只调用阶段 agent，不自己分析/设计/执行/报告/归档
✗ 不"顺手修复"产物——门禁失败只重 spawn 或升级人工，代码无产物编辑分支
✗ 不把产物全文嵌入 LLM 上下文——代码无此行为；阶段 agent 自读产物
✗ 不绕过人工门——human-gate.ts 是唯一放行路径，无自动放行分支
✗ 不直接写知识库/用例库——只经 archive 阶段 agent（kb_write/case_archive 工具）
✓ 允许：读产物路径/摘要/digest 用于校验、写检查点与运行日志、spawn/重 spawn、问人、调门禁引擎、执行重入
```

**"不读产物内容"的边界在代码驱动下含义变化**：不再防"LLM 上下文爆炸"，而是**结构约束**——driver 只读路径/摘要/digest 做门禁与对账，产物正文由阶段 agent 与门禁引擎消费，避免 driver 与门禁引擎重复实现业务逻辑。

### 2.4 工具白名单（代码驱动下 = 阶段 agent 的 spawn 约束）

> mainAgent 是代码，无自身工具白名单。本节语义变为：**driver 可调用的服务面** 与 **阶段 agent 的 spawn 约束**（强制层见 06 文档：`stage-spawner` 传 toolFilter，被禁工具在子 agent 世界物理不可达；`requiresApproval` 工具在归档阶段与人工门 G 融合为批次审批）。

| driver 可调用（host 服务） | 阶段 agent 可见（toolFilter 强制） |
|---|---|
| `stage-spawner`（spawn/重 spawn/审核 agent） | 各阶段 ACL 白名单（06 第 3 节），如 analyze：kb_query/case_query/fs_read/fs_write |
| `gates/machine.ts`（门禁引擎） | 测试领域工具按阶段收窄；execute 的 fs_write 排除 evidence/ |
| `human-gate.ts`（ui-user-questions） | 外部系统写入工具（jira 等）仅 archive 阶段经 requiresApproval |
| `checkpoint.ts` / `config.ts` / `executor/*` / `stores/*` | 越权处理见 06 第 6 节（1 次记录 → 2 次失败 → 重跑复发升级人工） |

---

## 3. 六阶段 agent 角色总表

横切边界（所有阶段 agent 统一，见 3.1）；每阶段差异见下表。表中"工具白名单"为声明层，**强制层**由 06 文档的 spawn toolFilter 保证（被禁工具物理不可达），声明与强制必须一致。

| 阶段 | 角色（只做） | 工具白名单 | 信息边界 | 禁止行为 |
|---|---|---|---|---|
| [1] receive | 解析/清洗/聚合需求输入 → receive.json | 解析工具（pdf/ppt/word→文本）、read、write（仅自己产物路径） | 只给：输入源 + 契约 + 澄清模板 | 分析需求、写用例、访问知识库 |
| [2] analyze | 知识检索（只读）+ 边界/范围/版本影响分析 + 复用建议 → analyze.json | 知识库只读查询、用例库只读查询、read、write（仅自己产物） | 只给：receive.json + 知识/用例检索工具（只读）+ 版本档案 | 写知识库、生成用例、执行测试；不改需求内容 |
| [3] design | 按需求点生成用例 + 合入复用清单 → design.json | read（上游产物）、write（仅自己产物） | 只给：analyze.json（确认后版本）+ 复用清单 | 执行测试、写 KB、自行决定复用（只消费清单） |
| [4] execute | **编排者+聚合者**（非执行者）：制定计划、经 executor 执行、聚合 executor 记录为 results、分类与填 note；**executor 是唯一执行者**（executor_run 入参只传 caseId，出参为 executor 自产记录与证据）；支持逐用例续跑（环境中断恢复：已通过用例不重跑，产物 resumed: true）；系统级问题诊断（env_diag 采集证据，blocking 级给建议后停止，不算用例失败）；manual 档走会话级见证回填（08 文档第 4 节） | 执行器工具（executor_run 传 caseId）、环境初始化（幂等）、env_diag（只读诊断）、fs_read、fs_write（**排除 evidence/，该目录 executor 独占**） | 只给：design.json + 执行器配置 + 环境信息 | 改写 executor 记录/证据（R4-08/09/10 防伪）、改用例设计产物、写 KB、擅自改环境配置 |
| [5] report | 解读统计（数据由代码聚合）→ report.json | read（execute.json + 统计结果文件 + evidence-manifest）、write（仅自己产物） | 只给：execute.json + 代码算好的 stats + 证据清单 | 自己计算统计数字、自行决定发布（只能给建议） |
| [6] archive | 按模板归档知识条目 + 用例版本化回流 → archive.json（写入前门 G） | KB 写入、用例库写入、read（全部上游产物）、write（仅自己产物） | 只给：上游全部产物路径 + 归档模板 | 修改上游产物、删除/覆盖历史版本 |

### 3.1 横切边界（所有阶段 agent 统一）

1. **只写自己的产物路径**（`artifacts/<pipelineId>/<stageId>.json`，幂等覆盖），不碰他人产物。
2. **不与人直接交互**：所有澄清/确认/审批都输出到产物字段（`clarifications`/`openQuestions`/`pendingManual`），由 mainAgent 转人工门。单个人机交互面，避免六个 agent 各自问人。
3. **预算自约束**：步骤上限来自 pipeline.yaml，超限显式标记"预算耗尽"，不静默。
4. **产物可信度规则**：输出必须带 evidence；无法验证的结论显式标"未验证"。
5. **失败处理**：阶段 agent 自己不做重试决策——产物落盘即交还 mainAgent，重试/门禁/人工升级全部由 mainAgent 决定。重试策略是**代码**（mainAgent 侧），不是每个 agent 各自即兴。
6. **产物声明输入摘要锁**（见第 8 节 G-08）：每条产物记录消费的上游产物 digest。

---

## 4. 信息边界矩阵（谁看到什么）

| 信息 | mainAgent | receive | analyze | design | execute | report | archive |
|---|---|---|---|---|---|---|---|
| pipeline.yaml 配置 | ✅ | ✅（契约子集） | ✅（契约子集） | ✅ | ✅ | ✅ | ✅ |
| 需求原始输入 | 路径+digest | ✅ | ✗（只经 receive.json） | ✗ | ✗ | ✗ | 只读引用 |
| receive.json | 路径+digest | 自产 | ✅ | ✗ | 只读 | 只读 | 只读 |
| analyze.json | 路径+digest | ✗ | 自产（回环/重入覆盖） | ✅ | ✗ | 只读 | 只读 |
| design.json | 路径+digest | ✗ | ✗ | 自产 | ✅ | 只读 | 只读 |
| execute.json | 路径+digest | ✗ | ✗ | ✗ | 自产 | ✅ | 只读 |
| execute/evidence/ | 校验 digest（经工具） | ✗ | ✗ | ✗ | 自产自录 | 只读（经 manifest） | 只读引用 |
| report.json | 路径+digest | ✗ | ✗ | ✗ | ✗ | 自产 | 只读 |
| 知识库/用例库 | ✗（经工具） | ✗ | 只读 | ✗ | ✗ | ✗ | 读写 |
| 检查点/人工门/重入记录 | ✅ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |

原则：**每个 agent 只看"自己的输入 + 自己的契约"，下游不可见上游的中间过程**（防上下文膨胀，也防"照抄上游结论"的偏置）。

---

## 5. 失败行为分工

| 失败类型 | 谁处理 | 处理方式 |
|---|---|---|
| 瞬态（subagent 未settle/网络/超时） | mainAgent | 重 spawn 同一阶段（幂等产物地址保证收敛） |
| 机器门禁 BLOCKING | mainAgent | 违规清单回喂 → 重 spawn 阶段 agent（≤N 次，默认 2） |
| 门禁重试耗尽（gate-failed） | 人工（经 mainAgent） | 修复产物后放行（仍需二次机器判定）或终止 |
| 交叉检查 fail | mainAgent | findings 回喂 → 重 spawn 生产 agent（≤1 次）；仍 fail → 连审核报告升级人工 |
| 语义（人工门 changes-needed） | 人工（经 mainAgent） | 反馈 → 重 spawn 该阶段 |
| 重入（人工事后反悔） | 人工（经 mainAgent） | 级联重跑（见第 8 节） |
| 越权调用（调用不存在的工具） | mainAgent | 分层处理（06 第 6 节）：1 次记录纠正 → 同次执行内 2 次阶段失败 → 重跑复发升级人工 |
| 永久（schema 无解/凭证缺失/输入缺失） | mainAgent | 停止流水线，明确报告原因，不重试 |
| 预算耗尽 | mainAgent | 标记"预算耗尽"，暂停等人工决策 |

关键点：**阶段 agent 永远不自我重试**。所有重试/升级决策在 mainAgent 侧（代码化策略），阶段 agent 是"单次射击"的，prompt 干净、行为可预期。

---

## 6. 证据快照机制（execute/report 阶段）

### 6.1 决策

证据访问采用**证据固化快照 + 清单**，而非"路径清单（live 引用）"。

| 维度 | 路径清单（live 引用） | 证据快照（固化副本 + 清单） |
|---|---|---|
| 时间一致性 | ✗ 报告阶段可能在 execute 数小时后跑，workspace 已变 | ✅ 固化在执行时点，永不变 |
| 幂等/可重放 | ✗ 重放依赖 workspace 现状 | ✅ 快照 + digest，报告可逐字节重放 |
| 恢复友好 | ✗ mainAgent 重启后不保证原路径还在 | ✅ 快照在产物目录内，随 pipeline 走 |
| 权限收敛 | ✗ report agent 需要访问整个 workspace | ✅ 只读快照目录 |
| 审计 | ✗ 证据内容可能事后被改 | ✅ digest 锁定 |
| 存储成本 | ✅ 零复制 | ✗ 大日志/截图翻倍（用 6.4 混合策略缓解） |

### 6.2 形态

```
artifacts/<pipelineId>/execute/
  execute.json                     # 产物（results 里 evidence 字段引用 manifest 条目 id）
  evidence/                        # 证据快照目录（executor 进程独占写入，execute agent 不可写——08 文档第 2 节）
    0001-request.log
    0001-response-assert.png
  evidence-manifest.json           # 清单：证据条目 → 快照文件 → digest
```

manifest schema（草案）：

```jsonc
{
  "version": 1,
  "capturedAt": 1723...,
  "entries": [
    {
      "id": "ev-0001",
      "kind": "log | screenshot | assertion | artifact",
      "caseId": "TC-0001",
      "file": "evidence/0001-request.log",
      "digest": "sha256:...",
      "sizeBytes": 2048,
      "truncated": false,          // 大文件摘要化时置 true
      "sourcePath": "logs/tc-0001.log"   // truncated 时保留的原路径引用（只读回读）
    }
  ]
}
```

### 6.3 固化时机

execute 结束、**人工门 E 之前**固化（门 E 定性缺陷看的是快照，保证"人工看到的就是门禁检查的"）。固化动作由 **executor 进程**完成（executor 自产自录，execute agent 无 evidence/ 写权，见 08 文档第 2 节），mainAgent 只校验清单完整性。

### 6.4 大小策略（混合）

- 小文件（默认 < 5MB）：全量快照。
- 大文件：**摘要快照 + 原路径引用 + 校验和**（`truncated: true` + 保留 `sourcePath`），report 阶段按需回读原文件（只读）。

### 6.5 机器门禁联动（同步进 01）

- R4-02 升级：`results` 里的证据必须引用 manifest 条目，且条目 digest 可验证、文件存在。
- R5-02 升级：报告引用的证据同样从 manifest 解析，禁止引用快照外路径。

---

## 7. 交叉检查（独立审核 agent）

### 7.1 定位

第三道闸，介于机器门禁和人工门之间，只对高风险产物开：

```
produced → machine-gate（确定性）→ [cross-check（LLM 语义复核，可选）] → human-gate → done
```

- 机器门禁：防"格式/完整性/一致性"错误（可枚举，代码）。
- 交叉检查：防"语义/逻辑/偏见"错误（LLM 二读）。
- 人工门：最终责任裁决，**永不被交叉检查替代**（交叉检查只是给人提供第二意见，结论可被人工推翻）。

### 7.2 触发策略（配置化）

pipeline.yaml 每阶段加 `review` 字段（同步进 02）：

```yaml
stages:
  - id: analyze
    review: { enabled: true }     # 默认开启：analyze / design / report
  - id: design
    review: { enabled: true }
  - id: report
    review: { enabled: true }
  - id: receive / execute / archive
    review: { enabled: false }    # receive 确定性解析、execute 执行、archive 模板化写入
```

### 7.3 独立性保障（关键，防"走形式"）

1. **全新 spawn、零父上下文**：审核 agent 是 mainAgent spawn 的独立 subagent，prompt 完全自包含，看不到生产 agent 的会话、推理、提示词。
2. **盲审**：只给它"契约 + 上游输入产物 + 待审产物 + 机器门禁违规清单"，不告诉它生产 agent 是谁、用了什么模型、怎么写的。
3. **只看快照**：报告阶段复核证据时读同一个 `evidence-manifest`，与生产 agent、人工看到的是同一份。
4. **输出必须过自身 schema**：审核报告是结构化产物，同样走机器门禁校验，防输出空话。
5. **禁止自我确认**：审核 agent 不得调用 subagent 或把审核任务再委托出去；它的输出就是终稿。

### 7.4 审核报告 schema 与判定

```jsonc
// artifacts/<pipelineId>/<stageId>.review.json
{
  "stageId": "analyze",
  "verdict": "pass | conditional | fail",
  "findings": [{
    "severity": "blocker | concern | nit",
    "claim": "版本影响遗漏了 v2.1 的支付回调变更",
    "evidence": "analyze.json#versionImpact 未覆盖 2026.06 版本档案条目 kb-acme-pay-2026-06-03",
    "suggestedAction": "rerun | address-in-human-gate | optional"
  }],
  "checked": ["boundaries", "versionImpact", "reuseSuggestions"],
  "confidence": 0.0
}
```

判定处理（mainAgent 执行，代码化策略）：

| verdict | 处理 |
|---|---|
| `pass` | 进入人工门（正常路径） |
| `fail`（存在 blocker findings） | 视为语义失败：findings 回喂 → 重 spawn 生产 agent（≤1 次）；仍 fail → 连审核报告一起升级人工 |
| `conditional` | 不重跑，但 findings 必须随产物进入人工门，**人工门必须逐条表态**后才流转 |

### 7.5 预算与降级（防止交叉检查本身成为故障点）

- 审核 agent 预算独立且小：maxSteps ≤ 10、超时短；超限即判定"审核不可用"。
- **审核不可用 ≠ 流水线失败**：降级为"机器门禁 + 人工门"，检查点记 `reviewDegraded: true`，报告阶段在 `unconfirmed` 中披露"本阶段未经交叉检查"。
- 交叉检查不参与瞬态重试：审核 agent 失败一次即降级，不反复重试。

### 7.6 人工门与交叉检查的交互

- 人工门页面展示三层信息：机器门禁违规清单（WARNING）+ 交叉检查 findings（conditional/fail 的）+ 产物本身。
- 人工可推翻交叉检查结论：允许，留痕（`gate.human.records[].note` 记录"驳回审核 findings X，理由：…"）。

---

## 8. 重入机制（人工事后反悔）

用户可能因疏忽批准了不合格产物。重入 = 用户主动要求某阶段重新执行，级联重跑全部下游。

### 8.1 核心机制：产物输入摘要锁（新机器门禁规则 G-08，平台标准，不可删）

每条阶段产物声明它消费的上游产物 digest：

```jsonc
// artifacts/<pipelineId>/<stageId>.json 内新增
{
  ...,
  "inputs": {
    "receive": "sha256:abc...",
    "analyze": "sha256:def..."
  }
}
```

```
G-08  输入摘要锁（BLOCKING）
  判定：产物声明 inputs.{stageId: digest}，机器重算上游产物当前 digest 并比对。
        任一不一致 → BLOCKING，detail = "上游产物已变更（<stage> 旧 digest → 新 digest），本产物已过期"
```

**为什么关键**：级联失效变成**确定性代码行为**，而不是编排器记得去标记。上游一变，所有下游产物在下一次门禁判定时自动 BLOCKING——即使有人跳过重跑逻辑也拦得住。同时天然支持"缓存跳过"（上游 digest 未变 → 下游可跳过重跑），为将来的增量重跑铺路。

### 8.2 重入流程

```
用户："重入 analyze 阶段，原因：当时审核通过了版本影响遗漏"
   │
[1] 前置校验：流水线当前不在 running（若某阶段正跑 → 拒绝：等待结束或先终止）
[2] 审计留痕：记录 { by, at, stageId, reason, cascade: true }
[3] 产物归档：当前 analyze 产物移入 history（见 8.4），保留审计
[4] cursor ← analyze 的下标；analyze 状态 → needs-reentry
[5] 下游状态全部标记 stale（其 inputs 摘要锁在下次门禁时必然不匹配）
[6] 重跑 analyze（全新 spawn）：机器门禁 → 交叉检查 → 人工门 B/C 重新打开 → approved → done
[7] 串行继续 design → execute → report → archive（各自全链路闸重走一遍）
```

- **重入 = 事后触发的 changes-needed**：与"人工门 changes-needed → needs-fix"同一机制，触发点在批准之后。阶段本身无需新逻辑。
- **下游重跑是级联默认语义**（方案 A，已确认）：design/execute/report/archive 都因输入摘要锁过期而重跑。安全默认，不提供"保留下游"选项。
- **流水线已跑完（cursor=6）也能重入**：重入后回到 running，等于"为修正而重开"；archive 重跑写库走幂等（同 pipelineId 覆盖同条目）。

### 8.3 状态机与检查点更新

```
done（已批准，cursor 已越过）
   │  用户主动重入
   ▼
needs-reentry（cursor 回退到该阶段；下游 stale）
   └─ 重跑该阶段（全新 spawn）→ produced → machine-gate → [cross-check] → human-gate
        ├─ approved → done（cursor 继续）
        └─ changes-needed / rejected → 照旧
```

检查点新增（同步进 02）：

```jsonc
"stageStates": {
  "analyze": {
    "status": "needs-reentry",
    "artifact": "artifacts/<pipe>/analyze.json",
    "history": [
      { "digest": "sha256:def...", "capturedAt": 1723..., "supersededBy": 1723... }
    ]
  }
},
"reentries": [
  { "stageId": "analyze", "by": "tester", "at": 1723..., "reason": "版本影响遗漏",
    "cascade": true, "cursorBefore": 4, "cursorAfter": 1 }
]
```

状态集最终版：`idle | running | produced | needs-fix | gate-failed | awaiting-gate | done | needs-reentry`。

### 8.4 产物历史版本（superseded）

重入前把旧产物固化，不覆盖删除：

```
artifacts/<pipelineId>/
  analyze.json                        # 当前版本（重入后是新版）
  history/analyze/v1.json             # 被重入替换掉的旧版（含当时 digest）
  history/analyze/v2.json
```

用途：审计（"批准时看到的是什么"）、对比（重入前后差异）、重放（人工门记录里的 digest 对应回具体版本）。保留策略：流水线生命周期内全留；回收时按平台配置归档或清理。

### 8.5 边界与守卫

| 场景 | 行为 |
|---|---|
| 流水线某阶段正 running | 拒绝重入：等待当前阶段结束，或先终止 |
| 重入申请时 cursor 之后已有已批准阶段 | 级联重跑全部下游（G-08 自动强制），无"保留下游"选项 |
| 重入的是 archive（写库后） | 允许；重跑走归档幂等，覆盖同 pipelineId 条目；审计记录"归档重入" |
| 重入后再次批准 | 正常 done；允许再次重入（审计链完整） |
| 交叉检查 fail 导致重跑 | 与重入正交：门禁内重跑 vs 人工事后重跑，互不替代 |

### 8.6 交互与披露

- 人工门页面提供**"重入该环节"入口**（即使已批准）：显示"该阶段已批准，可发起重入"，要求填原因，确认级联影响范围。
- 重入后该阶段的人工门**重新打开**，之前的批准记录保留在 history 中作对照。
- 交叉检查对重入后的新产物**照常执行**（analyze/design/report 默认开）。
- 报告阶段 `unconfirmed` 披露"本流水线发生过 N 次重入"。

---

## 9. 开放问题（待评审）

1. ~~重入指令入口形态~~ ✅ 已决策（D-07）：独立命令入口为主 + 人工门页面弹窗为辅。
2. ~~evidence 快照保留策略~~ ✅ 已决策（D-09）：随流水线归档长期保留。
3. **交叉检查的模型选择**：审核 agent 是否强制使用与生产 agent 不同的模型（防同源偏见）？建议：v1 不强制，仅建议（07 决策清单 D-19）。
4. ~~六阶段 prompt 模板~~ ✅ 已全部定稿（05 文档）。
