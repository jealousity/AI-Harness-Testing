# 02 流程模板 v1（pipeline.yaml schema 草案）（评审稿）

> 配套文档：[01 机器门禁规则明细](./01-machine-gate-rules.md) · [03 Agent 角色设定与边界规则](./03-agent-roles-and-boundaries.md)
> 状态：评审稿。schema 与默认模板待评审后定稿。
> 与本系列后续文档的关系：机器门禁规则见 01；agent 角色设定与边界规则见 03；本模板只声明"阶段/契约/门/预算/门禁/存储/交叉检查"，阶段执行者（agent 角色）留接口。

---

## 0. 文档目的

定义平台型测试辅助系统的**流程模板 schema 草案**与**固定六阶段默认模板**。平台按此模板实例化每个测试项目：

```
平台配置（每项目一份 pipeline.yaml）
  ├─ projectId / projectType / templateVersion
  ├─ 六阶段（固定，见第 3 节）
  │    每阶段 = 契约（输入/输出 schema）+ 门配置 + 预算 + 门禁规则引用 + 存储适配
  ├─ 存储适配（知识库/用例库/需求源 → 实现）
  ├─ 执行类型解析链
  └─ 规模档位（S/M/L → 预算实例化）
```

运行模式：**仅交互模式**（CI 已确认放弃）。

---

## 1. 已锁定设计决策（回顾）

| 决策 | 内容 |
|---|---|
| 阶段骨架 | 固定六阶段：需求接收 → 需求分析 → 测试设计 → 测试执行 → 测试报告 → 产物归档 |
| 人工门 | A~G 全部为人工门，交互模式阻塞等确认（`block`）；人工可事后反悔 → 重入（级联重跑） |
| 机器门禁 | 每阶段在人工审核前执行；BLOCKING/WARNING 分级；平台标准不可删、项目可追加；含输入摘要锁 G-08 |
| 执行类型 | 读取"prompt 输入 > 项目模板 > 项目类型 > 平台默认"解析链，落盘为 `execution_level` |
| 存储 | 兼容文件系统（markdown 目录）与外部系统（Jira/Xray/TestLink）；需求源支持 API 只读 / 导出文件 / 人工粘贴降级链 |
| 运行模式 | 交互模式（CI 已放弃，无头自动运行相关字段全部移除） |
| 规模 | 项目动态规划：规模档位 → 预算/生成上限/检索裁剪上限实例化 |
| 角色 | 编排执行分离：mainAgent 只调度（每轮新建/回收），六阶段各自独立 agent，阶段间只通过契约产物流转（见 03） |
| 证据 | execute 阶段固化证据快照（evidence/ + evidence-manifest.json），报告阶段只读快照（见 03 第 6 节） |
| 交叉检查 | analyze/design/report 默认开启独立审核 agent（第三道闸），其余默认关（见 03 第 7 节） |
| 重入 | 用户可对已批准阶段发起重入，级联重跑全部下游（方案 A，G-08 强制失效）（见 03 第 8 节） |
| 工具权限 | 三层权限：声明（prompt 第 4 节）+ 强制（spawn 时 toolFilter，物理不可达）+ 审批（requiresApproval 批次确认）；平台标准 ACL 不可删、项目只可收窄（见 06 文档） |
| 执行可信 | executor 唯一执行者（agent 只编排+聚合+分类）；executor_run 入参只传 caseId；证据由 executor 独占写入；R4-08 对账 / R4-09 时序链 / R4-10 证据锚定；manual 会话级见证（见 08 文档） |

---

## 2. pipeline.yaml schema 草案

```yaml
projectId: acme-pay-2026            # 项目标识（幂等键根）
projectType: api-service            # api-service | web-ui | desktop-client | mixed
templateVersion: v1
displayName: ACME 支付平台测试流水线

# 执行类型解析链的"项目模板"层（优先级高于 projectType 默认，低于本次运行 prompt 输入）
executionPolicy:
  defaultLevel: auto                # auto | hybrid | manual
  overrides:                        # 按用例前缀/标签覆盖
    - match: "UI-*"
      level: hybrid
    - match: "client-*"
      level: manual

# 规模档位：决定预算与生成上限（见第 8 节）
scaleTier: M                        # S | M | L

# 发布建议信任约束（R5-06 联动）：manual-claimed 占比上限，超限不得 approve
releasePolicy:
  maxManualClaimedRatio: 0.3        # 默认 0.3；项目档位可覆盖

# 存储适配（见第 7 节）
stores:
  knowledge: { impl: markdown-fs, path: "kb/acme-pay" }
  cases:      { impl: markdown-fs, path: "cases/acme-pay" }
  requirements:
    primary:  { impl: jira, projectKey: PAY, mode: readonly-api }
    fallback: [{ impl: export-files, dir: "inputs/requirements" }, { impl: paste }]

# 六阶段固定顺序；每阶段的 gate/budget/rules/review/tools 可覆盖默认模板
stages:
  - id: receive
    gate: { human: { id: A, block: true } }
    budget: { maxSteps: 20, timeoutMs: 600000, maxRetries: 2 }
    rules: [G-01..G-07, R1-01..R1-04]          # 默认模板规则引用；项目可追加
    review: { enabled: false }                  # 交叉检查（见第 12 节）：receive 默认关
    tools: { deny: [] }                         # 工具 ACL delta：默认继承平台标准（见 06 文档）
  - id: analyze
    gate: { human: { id: B, block: true }, human2: { id: C, block: true } }
    budget: { maxSteps: 30, timeoutMs: 900000, maxRetries: 2 }
    rules: [G-01..G-07, R2-01..R2-05, acme-R2-06]   # 追加规则示例
    review: { enabled: true }                   # analyze 默认开（高风险）
    tools: { deny: [kb_query] }                 # 项目可收窄：本示例关掉知识库检索（加 deny 自由）
  - id: design
    gate: { human: { id: D, block: true } }
    budget: { maxSteps: 40, timeoutMs: 1200000, maxRetries: 2, maxTestCases: 200 }
    rules: [G-01..G-07, R3-01..R3-07]
    review: { enabled: true }                   # design 默认开（高风险）
    tools: {}                                   # 无 delta：完全继承平台标准 ACL
  - id: execute
    gate: { human: { id: E, block: true } }
    budget: { maxSteps: 100, timeoutMs: 0, maxRetries: 2 }   # timeoutMs 0 = 项目定义（执行阶段另设用例级超时）
    rules: [G-01..G-07, R4-01..R4-11]
    review: { enabled: true }                   # execute 默认开（执行可信复核，08 文档第 5 节）
    tools: {}
  - id: report
    gate: { human: { id: F, block: true } }
    budget: { maxSteps: 20, timeoutMs: 600000, maxRetries: 2 }
    rules: [G-01..G-07, R5-01..R5-05]
    review: { enabled: true }                   # report 默认开（高风险）
    tools: {}
  - id: archive
    gate: { human: { id: G, block: true } }
    budget: { maxSteps: 20, timeoutMs: 600000, maxRetries: 2 }
    rules: [G-01..G-07, R6-01..R6-05]
    review: { enabled: false }                  # archive 默认关（模板化写入）
    tools: {}                                   # 写库工具（kb_write/case_archive）requiresApproval，与门 G 融合
```

字段说明（草案，定稿时补全）：

| 字段 | 说明 |
|---|---|
| `projectType` | 平台级默认执行策略的查找键（见第 6 节） |
| `executionPolicy` | 项目模板层的执行档位覆盖；优先级低于本次运行 prompt 输入 |
| `scaleTier` | 规模档位，见第 8 节 |
| `releasePolicy` | 发布建议信任约束（R5-06）：`maxManualClaimedRatio` 默认 0.3，超限时 releaseRecommendation 不得为 approve；项目档位可覆盖 |
| `stores` | 三类存储的实现选择；`requirements` 支持降级链（primary → fallback[]） |
| `stages[].gate.human` | 人工门引用（A~G 明细见第 5 节）；`block: true` 固定 |
| `stages[].budget` | 阶段预算；`maxTestCases` 等阶段专属预算字段按需扩展 |
| `stages[].rules` | 门禁规则引用列表；追加规则以项目前缀命名 |
| `stages[].review` | 交叉检查开关（`enabled`）；默认 analyze/design/report 开，其余关；详情见 03 第 7 节 |
| `stages[].tools` | 工具 ACL delta：默认继承平台标准（06 文档第 3 节）；追加 deny 自由、追加 allow 需评审；生效 ACL 在 spawn 时校验 |

---

## 3. 固定六阶段默认模板

### [1] 需求接收（receive）

- **输入**：Jira API 只读 / 导出文件（PPT/Word）/ 自然语言粘贴（降级链，见第 7 节）
- **处理**：解析（确定性工具，LLM 只做清洗与结构化）→ 聚合去重 → 缺字段进澄清
- **输出 schema（草案）**：
  ```jsonc
  {
    "requirements": [{
      "id": "REQ-001", "title": "", "background": "", "goals": [""],
      "changePoints": [""], "acceptance": [""], "priority": "P0|P1|P2",
      "sourceRef": "jira:PAY-123 | file:inputs/req.pptx | paste"
    }],
    "clarifications": [{ "requirementId": "REQ-001", "field": "acceptance", "question": "" }]
  }
  ```
- **人工门 A**：确认需求理解（解析是否正确、字段是否完整、聚合是否齐全）
- **机器门禁**：G-01~G-07 + R1-01~R1-04

### [2] 需求分析（analyze）

- **输入**：[1] 产物 + 知识库检索结果 + 历史用例检索结果
- **处理**：整体分析（修改边界、测试范围、版本影响）→ 知识检索 → 复用建议 → 抛出澄清 → 人工答复后重跑覆盖同一产物
- **输出 schema（草案）**：
  ```jsonc
  {
    "boundaries": { "in": [""], "out": [""] },
    "scope": "",
    "versionImpact": [{ "version": "", "impact": "", "evidence": "" }],
    "reuseSuggestions": [{ "caseId": "", "reason": "", "adaptation": "unchanged|modify-data|modify-expectation" }],
    "openQuestions": [{ "question": "", "needs": "", "related": "REQ-001" }],
    "riskNotes": [""]
  }
  ```
- **人工门 B**：答复澄清问题（回环入口：答复 → 重跑本阶段 → 覆盖同一产物）
- **人工门 C**：确认复用清单（复用决策责任在人）
- **机器门禁**：G-01~G-07 + R2-01~R2-05

### [3] 测试设计（design）

- **输入**：[2] 产物（含人工确认后版本）+ 复用清单
- **处理**：按需求点生成用例（新用例）+ **复用用例单独成组（reusedCases，不并入 testCases）** → 覆盖矩阵 → gaps 自检
- **输出 schema（草案）**：
  ```jsonc
  {
    "testCases": [ /* 本次新设计用例，见第 10 节通用用例 schema */ ],
    "reusedCases": [ /* 复用用例单独列出：含 sourceCaseId + adaptation + 适配后完整内容 */ ],
    "coverageMatrix": { "REQ-001": ["TC-0001", "TC-0002"] },
    "gaps": [{ "requirementId": "REQ-003", "reason": "无验收标准" }]
  }
  ```
  （机器门禁 R3-01/R3-02/R3-05/R3-07 对 `testCases ∪ reusedCases` 合并集生效）
- **人工门 D**：用例评审（可配 auto 的项目层覆盖，但默认 block）
- **机器门禁**：G-01~G-07 + R3-01~R3-06（R3-01 覆盖矩阵完备是防漏测核心闸）

### [4] 测试执行（execute）

- **输入**：[3] 产物 + 执行器配置
- **处理**：制定测试计划 → 编排步骤 → 准备执行器（按 execution_level 分档）→ 初始化环境（幂等）→ 执行 → 回填/采集结果 → **固化证据快照**（evidence/ + evidence-manifest.json，见 03 第 6 节；固化时机在人工门 E 之前）。支持**逐用例续跑**（环境中断恢复时已通过用例不重跑，产物 `resumed: true`）与**系统级问题诊断**（env_diag 采集证据，blocking 级给建议后停止，不算用例失败）——见 03/05 execute 模板
- **输出 schema（草案）**：
  ```jsonc
  {
    "plan": { "env": [""], "executors": [{ "level": "auto|hybrid|manual", "impl": "" }], "order": ["TC-0001"] },
    "results": [{ "caseId": "TC-0001", "status": "pass|fail|pending", "evidence": ["ev-0001"], "durationMs": 0, "attempts": 1 }],
    "envIssues": [{ "issue": "", "resolution": "" }],
    "pendingManual": ["TC-0005"]
  }
  ```
  （`evidence` 引用 `evidence-manifest.json` 条目 id，R4-02 校验快照完整性）
- **人工门 E**：失败用例定性（真缺陷 / 用例问题 / 环境问题）
- **机器门禁**：G-01~G-07 + R4-01~R4-05

### [5] 测试报告（report）

- **输入**：[4] 产物 + 统计数据（**代码聚合**，LLM 只解读）
- **处理**：统计（通过率/优先级/模块分布）→ 缺陷分析（带证据）→ 风险 → 发布建议
- **输出 schema（草案）**：
  ```jsonc
  {
    "stats": { "total": 0, "passed": 0, "failed": 0, "passRate": 0.0, "byPriority": {}, "byModule": {} },
    "defectAnalysis": [{ "caseId": "", "defect": "", "severity": "", "evidence": [""] }],
    "risks": [{ "risk": "", "level": "", "evidence": "" }],
    "releaseRecommendation": "approve|conditional|reject",
    "unconfirmed": [""]
  }
  ```
- **人工门 F**：发布建议审批
- **机器门禁**：G-01~G-07 + R5-01~R5-05

### [6] 产物归档（archive）

- **输入**：[1]~[5] 全部产物
- **处理**：知识条目化（检索模板）→ 用例版本化回流 → 版本档案更新 → 归档幂等
- **输出 schema（草案）**：
  ```jsonc
  {
    "knowledgeEntries": [{ /* 见第 11 节 */ }],
    "caseArchive": [{ "caseId": "", "version": "2026.08", "sourceRequirement": "REQ-001", "ticketRef": "PAY-123", "content": {} }],
    "versionArchive": [{ "version": "2026.08", "changeSummary": "" }],
    "archiveReport": { "entries": 0, "cases": 0, "skipped": [] }
  }
  ```
- **人工门 G**：归档确认（写知识库/用例库必须有真人确认）
- **机器门禁**：G-01~G-07 + R6-01~R6-05

---

## 4. 产物契约总表（默认模板）

约定：产物 = 通过输出校验的 JSON，落 `artifacts/<pipelineId>/<stageId>.json`（幂等地址）；校验失败 = 阶段失败，不产生下游输入。下游消费方列于"消费方"。

| 阶段 | 产物文件 | 消费方 | 下游关键依赖 |
|---|---|---|---|
| [1] receive | `receive.json` | [2][4][5][6] | 需求 id 稳定（R1-01） |
| [2] analyze | `analyze.json` | [3][6] | 澄清答复后覆盖同一产物（门 B 回环） |
| [3] design | `design.json` | [4][6] | 覆盖矩阵完备（R3-01） |
| [4] execute | `execute.json` | [5][6] | results 覆盖全部计划用例（R4-01） |
| [5] report | `report.json` | [6] | 数字与 execute.json 重算一致（R5-01） |
| [6] archive | `archive.json` | 知识库/用例库 | 幂等去重（R6-03） |

---

## 5. 人工门 A~G 明细

所有门 `block: true`（交互模式阻塞等确认）。门的结果（问题 + 答复 + 确认人 + 时间）落检查点，恢复时已答复的门直接跳过。

| 门 | 阶段 | 确认内容 | 问题模板（草案） | 默认确认人 |
|---|---|---|---|---|
| A | [1] 接收 | 需求理解正确性 | "以下需求解析结果是否与原始输入一致？缺字段是否已全部进入澄清？" | 测试负责人 |
| B | [2] 分析 | 澄清问题答复 | 逐条展示 `openQuestions`，要求回答或标注"无需确认" | 需求方/产品 |
| C | [2] 分析 | 复用用例清单 | "以下候选用例是否复用？（可逐条：复用/改数据/改期望/不复用）" | 测试负责人 |
| D | [3] 设计 | 用例集评审 | "用例集是否覆盖全部需求点？优先级与数量是否可接受？" | 测试负责人 |
| E | [4] 执行 | 失败用例定性 | "以下失败用例属于：真缺陷 / 用例问题 / 环境问题？" | 测试工程师 |
| F | [5] 报告 | 发布建议审批 | "发布建议为 approve/conditional/reject，是否同意？" | 测试负责人/发布决策人 |
| G | [6] 归档 | 归档内容确认 | "以下条目将写入知识库/用例库，确认无误？" | 测试负责人 |

---

## 6. 执行类型配置解析链

```
execution_level(用例) = resolve(
  本次运行 prompt 输入显式指定        // 最高优先（如"本批全部按 hybrid 跑"）
  → 项目模板 executionPolicy          // 项目级（含 overrides 按前缀匹配）
  → 项目类型 projectType 默认         // api-service→auto, web-ui→hybrid, desktop-client→manual
  → 平台启发默认（同 projectType 默认）
)
```

- 用例 schema 的 `execution_level` 是**解析结果的落盘记录**，不是配置源头。
- 门 E 的语义随档位变化：auto 档失败用例直接进缺陷队列候选；hybrid 档失败自动进"待人工复核"；manual 档由人工执行回填后进入门 E。

---

## 7. 存储适配层

所有存储访问走适配接口，平台配置选择实现：

```ts
interface KnowledgeStore {
  read(query: { entities: string[]; project: string; limit: number }): Promise<Entry[]>
  write(entry: KnowledgeEntry): Promise<string>   // 返回条目 id；同 pipeline 幂等覆盖
}
interface CaseStore {
  query(filter: { project: string; requirement?: string; version?: string }): Promise<CaseMeta[]>
  archive(case: VersionedCase): Promise<void>     // 版本化回流，去重
}
interface RequirementSource {
  pull(sourceRef: RequirementSourceRef): Promise<RequirementRaw[]>
}
```

| 实现 | 知识库 | 用例库 | 需求源 |
|---|---|---|---|
| `markdown-fs` | ✅（首批） | ✅（首批） | — |
| `jira`（只读 API） | — | — | ✅（首批） |
| `xray` / `testlink` | — | ✅（后续） | — |
| `export-files` / `paste` | — | — | ✅（降级链末级） |

需求源降级链：`Jira API 只读 → 导出文件解析 → 人工粘贴`，任一成功即继续；全部失败 = 永久失败，不重试。

---

## 8. 规模档位与预算实例化

平台按项目规模档位推导运行时预算（动态规划）：

| 档位 | 典型规模 | 需求点预算 | 用例生成上限 | 检索裁剪上限 | 阶段默认 maxSteps |
|---|---|---|---|---|---|
| S | ≤5 需求点 | ≤5 | ≤60 | 10 条目 | 20 |
| M | 6~30 需求点 | ≤30 | ≤200 | 30 条目 | 30~40 |
| L | >30 需求点 | 无硬上限（分块） | ≤500/批 | 50 条目/需求 | 40+（分块处理） |

- 超限处理：用例超上限 → 分层（P0 必测 / P1 / P2），报告 gaps；检索超限 → 标记 `retrievalTruncated`（R2-05），不无脑灌入上下文。
- 预算字段在 `pipeline.yaml` 的 `scaleTier` 基础上可被项目覆盖。

---

## 9. 检查点结构

```jsonc
{
  "pipelineId": "acme-pay-2026-01",
  "templateVersion": "v1",
  "rulesetVersion": "v1",                // 机器门禁规则集版本（判定留痕用）
  "cursor": 4,                           // 下一个要执行的阶段下标（0..6）
  "stageStates": {
    "analyze": {
      "status": "awaiting-gate",         // idle|running|produced|needs-fix|gate-failed|awaiting-gate|done|needs-reentry
      "artifact": "artifacts/<pipe>/analyze.json",
      "digest": "sha256:...",
      "history": [                        // 产物历史（重入替换掉的旧版，见 03 第 8 节）
        { "digest": "sha256:def...", "capturedAt": 1723..., "supersededBy": 1723... }
      ],
      "reviewDegraded": false,            // 交叉检查不可用时置 true（03 第 7.5 节）
      "gate": {
        "machine": {
          "status": "passed",            // passed|failed
          "attempts": 1,
          "violations": [{ "rule": "R2-02", "level": "warning", "detail": "...", "at": 1723... }]
        },
        "review": {                       // 交叉检查记录（review.enabled 时存在）
          "status": "pass | conditional | fail | degraded",
          "report": "artifacts/<pipe>/analyze.review.json",
          "findings": []
        },
        "human": {
          "state": "open",               // open|approved|changes-needed
          "records": [{ "by": "tester", "action": "approve", "at": 1723..., "note": "..." }]
        }
      },
      "failures": [{ "kind": "gate-blocking", "rule": "R3-01", "at": 1723... }]
    }
  },
  "reentries": [                          // 重入审计（03 第 8 节）
    { "stageId": "analyze", "by": "tester", "at": 1723..., "reason": "版本影响遗漏",
      "cascade": true, "cursorBefore": 4, "cursorAfter": 1 }
  ],
  "budget": { "perStage": { "maxSteps": 30, "timeoutMs": 900000, "maxRetries": 2 } }
}
```

状态机（每阶段，含交叉检查与重入）：

```
idle → running → produced → machine-gate
   ├─ BLOCKING 违规 → needs-fix（回喂违规重跑，≤N 次）→ produced
   │      └─ 重试耗尽 → gate-failed → 升级人工（修复放行/终止）
   └─ passed（含 WARNING）
         ├─ [review.enabled] cross-check
         │     ├─ fail → needs-fix（findings 回喂重跑 ≤1 次）→ produced
         │     ├─ conditional → 带 findings 进人工门（逐条表态）
         │     └─ pass / 审核不可用（degraded）→ 进人工门
         └─ human-gate（block）
               ├─ approved → done → cursor++
               ├─ changes-needed → needs-fix（带人工反馈重跑）
               └─ rejected → 终止

done 之后：用户可发起重入 → needs-reentry（cursor 回退，下游 stale，级联重跑）
```

---

## 10. 通用用例 schema（草案 v1）

```jsonc
{
  "id": "TC-0001",               // 流水线内唯一；幂等键的一部分
  "title": "登录接口-正确凭证",
  "preconditions": ["已注册用户 u1"],
  "execution_level": "auto",     // auto | hybrid | manual（解析链结果落盘）
  "priority": "P0",              // P0 必测 / P1 / P2
  "coverageRef": ["REQ-001"],    // 关联需求点（覆盖矩阵）
  "steps": [{ "action": "POST /api/login", "data": { "username": "u1" } }],
  "expected": ["HTTP 200", "返回 token"],
  "data": "testdata/login-correct.json",   // 测试数据引用（可选）
  "cleanup": "删除创建的会话"              // 可选：清理动作（环境幂等）
}
```

后续优化方向（另行评审）：数据驱动模板、参数化、断言表达式标准化、与 Xray/TestLink 字段映射。

---

## 11. 知识库条目模板（检索友好）

归档格式 = 检索格式。每条 `knowledgeEntry`：

```yaml
id: kb-acme-pay-2026-08-01
title: 支付接口幂等键规范
date: 2026-08-17
project: acme-pay
version: 2026.08
tags: [接口, 幂等, 支付]
entities: [PaymentService, idempotency-key, POST /api/pay]   # 检索关键词来源
body: |
  <正文：模块、变更点、结论、证据引用>
sourcePipeline: acme-pay-2026-01
```

验收：归档后对 `entities` 跑一次示例检索，验证能命中（R6-05）。

---

## 12. 报告渲染模板（人读视图）

report.json 是**机器事实源**（门禁/交叉检查/人工门 F/归档都消费它）；人读报告是它的**渲染视图**，由确定性代码渲染（不是 LLM 再写一遍——避免"LLM 解读完又让 LLM 写文档"的双重失真）。渲染模板与 report.json 字段一一映射：

```markdown
# 测试报告：<项目> <版本>（pipeline: <pipelineId>）

## 1. 执行概况            ← stats
   - 总用例 / 通过 / 失败 / 通过率（含按优先级、按模块）
   - 新用例 vs 复用用例通过率（bySource）
   - 执行说明：续跑次数（resumed）、环境问题数（envIssues）

## 2. 缺陷分析            ← defectAnalysis
   | 用例 | 缺陷描述 | 严重级 | 定性 | 证据 |
   （classification 区分：真缺陷 / 用例问题 / 环境问题 / 疑似）
   - 疑似问题单独列出（无证据，待人工确认）

## 3. 风险                ← risks
   - 逐条：风险描述 / 等级 / 证据来源

## 4. 发布建议            ← releaseRecommendation + recommendationReason
   - 结论：approve / conditional / reject
   - 理由（引用第 2、3 节）
   - 【审批人签字】← 人工门 F 在此落款

## 5. 未确认项            ← unconfirmed
   - WARNING / 遗留 pending / 重入记录 / reviewDegraded

## 6. 证据附录            ← evidence-manifest 索引
   - 证据清单（ev-0001 → 文件 → digest），全文快照见 artifacts/execute/evidence/
```

渲染规则：

- 渲染是确定性代码（模板 + 变量插槽），输入只有 report.json 与 evidence-manifest，输出 markdown 报告文件（`artifacts/<pipelineId>/report.md`）。**渲染由 mainAgent 代码执行**（D-08），report agent 只出 report.json——避免"LLM 解读完又让 LLM 写文档"的双重失真。
- 归档入库用 report.json 的**结构化版本**（非 markdown 渲染稿），保证下游检索/对比/统计直接用结构。
- 六段章节标题固定；空章节（如无缺陷）显式写"无"而非省略——与 risks 非空（R5-03）、unconfirmed 披露（R5-04）同一纪律。

---

## 13. 交叉检查（配置摘要）

第三道闸（machine-gate → cross-check → human-gate），只对高风险产物开；默认 `review.enabled`：analyze / design / report / **execute** = true（execute 开启用于执行可信复核：结果与证据一致性、覆盖完整性、异常模式——见 08 文档第 5 节），receive / archive = false。审核 agent 由 mainAgent 独立 spawn（盲审、零父上下文），输出 `stageId.review.json`（verdict: pass/conditional/fail）。verdict=fail → findings 回喂重跑生产 agent（≤1 次）；conditional → 带 findings 进人工门逐条表态；审核不可用 → 降级（`reviewDegraded: true`）不阻塞流水线。完整设计见 03 第 7 节。

---

## 14. 开放问题（待评审）

1. ~~门 B 回环的产物覆盖语义~~ ✅ 已决策（D-05）：覆盖同一产物 + 答复记录另存（检查点 history），见 07 决策清单。
2. ~~D 门可配 auto 的边界~~ ✅ 已决策（D-06）：可配 auto，但须项目评审背书（带 review 标注），降级记录进 unconfirmed。
3. ~~用例 schema 与 Xray/TestLink 字段映射~~ ✅ 已决策（D-10）：后置，接外部系统前再定（接口已预留 CaseStore）。
4. ~~agent 角色设定与边界规则~~ ✅ 已成型为 03 文档。
5. ~~执行阶段的用例级超时~~ ✅ 已决策（D-11）：按档位（auto 短 / hybrid 中 / manual 长）× 类型（接口/UI/客户端）组合，项目模板给默认值，pipeline.yaml 可覆盖。
6. ~~重入入口形态~~ ✅ 已决策（D-07）：独立命令入口为主 + 人工门页面弹窗为辅，见 07 决策清单。
7. ~~evidence 快照保留策略~~ ✅ 已决策（D-09）：随流水线归档长期保留（存储成本靠大文件摘要化控制）。
8. ~~报告渲染入口~~ ✅ 已决策（D-08）：mainAgent 代码渲染，report agent 只出 report.json（见第 12 节渲染规则）。
