# 08 执行可信设计（评审稿）

> 配套文档：[01 机器门禁规则明细](./01-machine-gate-rules.md) · [02 流程模板 v1](./02-pipeline-template-v1.md) · [03 Agent 角色设定与边界规则](./03-agent-roles-and-boundaries.md) · [04 Prompt 模板框架](./04-prompt-templates.md) · [05 阶段 Prompt 模板评审](./05-stage-prompt-reviews.md) · [06 工具调用权限控制](./06-tool-permission-control.md) · [07 待定决策清单](./07-decision-checklist.md)
> 状态：评审稿。本文档解决 execute 阶段的可信问题：防空跑、防漏跑、防虚假产物。

---

## 0. 文档目的与范围

execute 是全流水线唯一有真实副作用的阶段，也是最容易被"空跑/漏跑/伪造"攻破的阶段。本文档定义执行可信架构：可信执行者（executor）作为唯一事实源、三条确定性机器防线、manual 档信任模型、抽样复核。

核心前提：**只要"执行"和"记录"由同一个 LLM agent 完成，防伪造在原理上做不到**。因此核心解法不是更严格的提示词，而是把执行从 agent 手里拿走。

---

## 1. 威胁模型

| 攻击 | 表现 | 现有设计为何挡不住 |
|---|---|---|
| **空跑** | 声称跑了用例，实际没调用执行器；或调用但传假参数 | R4-02 只查 evidence 文件存在 + digest 可验——agent 连证据文件都能自己编 |
| **漏跑** | 跳过部分用例（尤其 P2/复用用例），产物"结果齐全" | R4-01 只查 results 覆盖计划用例——agent 可给没跑的用例编 pass |
| **虚假产物** | 伪造 pass/fail、伪造日志/截图、环境故障写成用例失败 | 产物、证据都是 agent 自己写的，机器门禁验的是"它自己写的东西的一致性" |

一句话：门禁能防"格式错误"，防不了"agent 撒谎"——因为事实源与篡改者是同一个。

---

## 2. 核心解法：可信执行者（executor 唯一事实源）

架构变更：**执行由确定性 executor 完成，agent 不再"执行"测试，只做"编排 + 聚合 + 分类"**。

```
execute agent（LLM）── 只做：编排计划、把 executor 记录聚合成 results、分类、填 note
       │  executor_run(caseIds) —— 传用例 id，不传"我要的结果"
       ▼
executor（确定性代码）── 唯一执行者：
       自己 fs_read design.json（不信任 agent 传入的内容）
       → 真执行（HTTP/UI/客户端，或生成 manual 清单）
       → 产出 execution records + 自写 evidence（executor 进程身份）
       → 返回结构化记录（每用例：真实状态、时长、证据 refs、原始输出）
       ▼
机器门禁（代码重算对账，第 3 节）
       ▼
交叉检查（execute 默认开启，第 5 节）+ 人工门 E + 抽样复核
```

关键点：

1. **executor_run 入参只是 caseId，出参是 executor 自己生成的记录**。executor 自己从 design.json 读用例定义——agent 无法传一份假的用例内容让它跑。
2. **证据由 executor 写，agent 无写权**（06 ACL 收紧：evidence/ 目录只有 executor 可写，agent 的 fs_write 范围排除 evidence/）。agent 连"补一张截图"都做不到。
3. **agent 的 results 只能"引用记录 + 分类"**：每条 result 必须带 executor record id；pass/fail 由 executor 断言结果决定，agent 只能加 note（失败原因分类），不能改状态。
4. **manual 档例外**（无 executor 的用例）：人工执行 → 会话级见证回填（第 4 节），产物标记 `manualClaimed`，报告披露"依赖人工陈述"。

---

## 3. 三条确定性防线（机器门禁，代码重算，不靠 LLM）

### 防线 1：执行-产物对账（防空跑 + 漏跑）→ 新规则 R4-08

```
机器重算：
  executorRecords（执行器真实记录集） ↔ results（agent 产物）
  - 每个 result 必须引用一个真实存在的 record（无 record 的 result = 伪造）
  - 每个计划用例必须有 record（无 record 的用例 = 漏跑）
  - 每个 record 必须被引用（无引用的 record = 多余执行，可疑）
不一致 → BLOCKING
```

直接掐死"空跑"和"漏跑"：agent 要造假必须先伪造 executor 记录，而记录在 agent 不可写的目录里。

### 防线 2：时序链（hash chain，防删改记录）→ 新规则 R4-09

```
executor 每条记录带：
  { seq, caseId, capturedAt, durationMs, status, evidenceRefs[],
    prevHash,          ← 上一条记录的 hash
    ownHash }          ← 本条记录整体 hash

校验：逐条重算 hash，链必须连续、时间必须单调、时长必须与时间戳跨度一致。
删一条 → 链断；插一条 → 链断；改一条 → ownHash 不匹配；回填历史时间 → 时序倒退。
```

"漏跑"的最终兜底：agent 想删掉不利记录，整条链断，机器门禁立刻发现。记录级 hash chain 实现成本低（executor 是代码，加两个字段），**v1 就做**（已确认）。

**跨会话续跑语义（已确认）**：环境中断续跑开启**新链段**，段头 `prevHash` 指向旧链尾；R4-09 校验段间连续性——段内不可篡改，段间可审计衔接（段头记录带 `segment: N` 与 `resumedFrom: <旧链尾 hash>`）。

### 防线 3：证据指纹与来源锚定（防虚假产物）→ 新规则 R4-10

```
每条 evidence：
  { id, recordId, file, digest, capturedBy: "executor:<invocationId>", capturedAt }
校验：
  - digest 可重算（防事后改文件）
  - capturedBy 必须是 executor 身份（agent 写的证据直接不认）
  - capturedAt 与该 record 的时间窗口一致（防"从旧测试偷证据"）
  - 证据文件存在且非空
```

配合防线 2 的时序，证据不能从别处搬运（时间对不上）。

---

## 4. manual 档信任模型 v1（会话级见证，成本 O(批) 而非 O(条)）

无 executor 的用例（客户端测试、需人工操作的 UI 场景）依赖人工执行，无法机器验证。信任模型：

### 4.1 manual 执行会话（一次确认覆盖一批）

```
mainAgent 在人工门 E 前发起"manual 执行会话"：
  弹窗：manual 用例清单（N 条）+ 两个动作
        [确认开始人工执行] ── 会话开启（sessionId + 时间窗，默认 4h 有效）
        [全部标记为跳过]   ── 显式放弃（进 gaps，不进结果）
  人工在会话内执行并回填（可分批，都落在同一会话窗口内）
  回填完成 → [确认结束会话] ── 一次确认覆盖整批
```

- **成本**：一个 manual 批次 = 2 个确认点（开始 + 结束），与用例数量无关。
- **锚定**：回填的每条结果必须带 `sessionId` + 时间戳（在窗口内）——无会话锚定的 manual 结果 BLOCKING。
- **时间窗（已确认）**：默认 4h；超窗自动关闭会话，需重新开启（新确认点，成本可控）。

### 4.2 结果分级（信任层显式化）

```jsonc
// execute.json 的 manual 结果
{
  "caseId": "TC-0031",
  "status": "pass",
  "manualClaimed": true,         // 人工陈述，非 executor 验证
  "attestedBy": "tester-zhang",  // 会话见证人
  "sessionId": "m-sess-20260820-01",
  "note": "..."                  // 失败时必填
}
```

- 报告按信任层分级呈现：**executor-verified**（可信）/ **manual-claimed**（人工陈述，低信任）。
- **发布建议联动**（新规则 R5-06）：manual-claimed 占比超阈值（默认 >30%）或未完成抽检时，`releaseRecommendation` 不得为 `approve`（只能 conditional/reject）。

### 4.3 失败必注（成本与风险成比例）

- **manual 失败用例必须附一行说明**（现象/复现步骤），且进入人工门 E 定性。
- 成本随失败数增长，不随用例总数增长（O(失败数)，非 O(n)）。

### 4.4 针对性抽检（manual 档提高抽检率）

- 抽样复核中 manual 用例抽检率默认 **15%**（auto 5%），**manual 失败全抽**。
- 抽检发现不一致 → 该批 manual 结果**整体降级为"未确认"**并披露，触发惩罚性路径：此时才对该批逐条人工复核（诚实用户永不触发）。

### 4.5 机器门禁联动（新规则 R4-11）

| 规则 | 判定 | 级别 |
|---|---|---|
| R4-11a | manual 结果必须带 `sessionId` + `attestedBy`，时间戳在会话窗口内 | BLOCKING |
| R4-11b | manual 失败无说明 → BLOCKING | BLOCKING |
| R4-11c | 报告阶段：manual 占比、未抽检数披露（联动 R5-06 发布建议约束） | BLOCKING |

---

## 5. 抽样复核（最后一道，防系统性造假）

机器对账保证"记录与结果一致"，但 executor 与 agent 合谋超出机器对账能力，抽样复核兜底：

- **人工抽查**：人工门 E 之外，对 execute 产物抽样 N 条（默认 5%，至少 3 条），人工对照"结果 ↔ 证据 ↔ 原始记录"验证真实。
- **交叉检查（execute 默认开启，已确认）**：审核 agent 复核"结果与证据一致性 + 覆盖完整性 + 异常模式"（全 pass 但时长 0、evidence 同一秒、manual 占比异常等）。
- **抽样策略**：随机抽 N 条防系统性侥幸 + 强制抽"全 pass 的 P2 复用用例"（最易漏跑部分）。
- 报告披露：抽查结果 + 异常模式。

---

## 6. 剩余不可消除的信任面（诚实说明）

| 信任面 | 对策 |
|---|---|
| executor 本身被攻破（供应链/环境被控） | 部署侧防护（只读安装、校验和、最小权限），不在流水线设计内 |
| executor 内部假执行（没真跑却生成记录） | **executor side-effect 留痕契约**：接口类记录真实请求/响应（executor 自抓 wire 数据）、UI 类记录截图 + DOM 快照、客户端类记录进程清单——写入 executor 实现契约；**独立确定性测试验收（已确认）**：断言"每条记录必有对应副作用留痕"，作为 executor 验收项随实现交付 |
| manual 档 | 依赖人工陈述，靠会话见证 + 结果分级 + 披露 + 抽检（第 4 节） |

---

## 7. 与现有设计的衔接（同步修订点）

| 文档 | 修订 |
|---|---|
| 01 | 新增 R4-08 / R4-09 / R4-10 / R4-11（a/b/c）；新增 R5-06（manual 占比约束发布建议） |
| 03 | execute 角色："执行者+记录者+诊断者"改为"编排者+聚合者"（executor 唯一执行者）；证据快照由 executor 写 |
| 05 | execute 模板：executor_run 语义（传 caseId 不传结果）、evidence 由 executor 写、manual 会话机制、R4-08/09/10/11 前置 |
| 06 | ACL：evidence/ 目录 executor 独占（execute agent 的 fs_write 排除 evidence/）；executor_run 定义更新（入参 caseId、出参 executor 自产记录） |

---

## 8. 决策记录

| 编号 | 问题 | 决策 | 备注 |
|---|---|---|---|
| ET-01 | 门禁语义重试次数 N | 保持 N=2 | 一次判别期、二次定性，之后升级人工 |
| ET-02 | hash chain 跨会话续跑 | 新链段，段头 prevHash 链接旧链尾 | R4-09 校验段间连续性 |
| ET-03 | executor 防假执行验收 | 独立确定性测试：断言"每条记录必有对应副作用留痕" | 作为 executor 验收项随实现交付 |
| ET-04 | manual 会话时间窗 | 默认 4h，超窗自动关闭需重开 | 新确认点成本可控 |
| ET-05 | R5-06 阈值 | 默认 30%，项目档位可覆盖 | 写入 pipeline.yaml `releasePolicy.maxManualClaimedRatio` |

**08 全部开放问题清零。**
