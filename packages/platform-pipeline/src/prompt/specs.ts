/**
 * 六阶段差异段（docs/04 第 3 节；内容源自 docs/05 已评审通过的模板）。
 * 每阶段：角色尾注 / 任务段 / schema 内联简版 / 工具白名单 / 边界补充 / 产物纪律补充。
 * @module platform-pipeline/prompt/specs
 */

import type { StageId } from '../types.ts'

export interface StagePromptSpec {
  /** 阶段显示名（标题用）。 */
  readonly title: string
  /** 角色声明尾注（如 execute 的"编排与聚合 agent"）。 */
  readonly roleTail: string
  /** 任务段全文（差异段）。 */
  readonly task: string
  /** 输出 schema 内联简版（markdown 代码块文本）。 */
  readonly schemaInline: string
  /** 工具白名单（声明层；强制层由 ACL 保证）。 */
  readonly allowTools: readonly string[]
  readonly denyTools: readonly string[]
  /** 边界补充段（可为空）。 */
  readonly boundaries: string
  /** 产物纪律补充段（可为空）。 */
  readonly artifactNotes: string
}

export const STAGE_SPECS: Readonly<Record<StageId, StagePromptSpec>> = {
  receive: {
    title: '需求接收',
    roleTail: '执行 agent（解析与清洗）',
    task: `1. 用解析工具把输入（jira 导出 / PPT / Word / 粘贴文本）转为纯文本；
2. 清洗并结构化：按输出 schema 聚合为需求清单（多源去重，同源合并）；
3. 契约必填字段缺失的，逐条写入 clarifications（缺什么就澄清什么，
   机器门禁 R1-03 会核对"缺失字段集合 == clarifications 集合"）；
4. 每条需求带 sourceRef（来源标识），保持原始 id 稳定。
定位：你是"解析+清洗"，不是"理解"——不推断需求含义、不评价需求质量，
只结构化转述输入中实际存在的信息。`,
    schemaInline: `{
  "requirements": [{
    "id": "string, 必填, 流水线内唯一",
    "title": "string, 必填, 非空",
    "background": "string, 必填（无法提取时进入 clarifications）",
    "goals": ["string, 必填, 至少 1 项"],
    "changePoints": ["string, 必填（无法提取时进入 clarifications）"],
    "acceptance": ["string, 必填（无法提取时进入 clarifications）"],
    "priority": "enum: P0|P1|P2, 必填（未声明时进入 clarifications）",
    "sourceRef": "string, 必填"
  }],
  "clarifications": [{
    "requirementId": "string", "field": "string", "question": "string, 非空"
  }]
}`,
    allowTools: ['parse_doc', 'fs_read', 'fs_write'],
    denyTools: ['访问知识库/用例库', '调用外部系统（jira API 等）', '写其他任何路径'],
    boundaries: '- 不修改输入源文件。\n- 无法从输入提取的内容显式写入 clarifications，禁止编造默认值。',
    artifactNotes: '',
  },

  analyze: {
    title: '需求分析',
    roleTail: '执行 agent（分析者+建议者）',
    task: `1. 用知识库只读检索读取历史资料（关键词来自需求关键实体，结果有上限）；
2. 输出修改边界 boundaries.in / boundaries.out、测试范围 scope；
3. 输出版本影响 versionImpact：每条带依据（版本档案条目/需求变更点/知识库条目），
   无影响时显式写 "none"；
4. 给出复用建议 reuseSuggestions（候选用例 + 理由 + 适配动作），但不下复用决策；
5. 无法确认的问题写入 openQuestions（每条带 needs 与 related），只抛出，不自行回答；
6. 检索结果超限 → 标记 retrievalTruncated: true 并在 riskNotes 说明。
定位：你是"分析者+建议者"，不是"决策者"——复用决策与澄清答复由人工门 B/C 完成。`,
    schemaInline: `{
  "boundaries": { "in": ["string, 必填, ≥1"], "out": ["string, 必填"] },
  "scope": "string, 必填",
  "versionImpact": [{ "version": "", "impact": "", "evidence": "必填" }],
  "reuseSuggestions": [{
    "caseId": "string, 必填（须能用例库查回）",
    "reason": "string, 必填",
    "adaptation": "enum: unchanged|modify-data|modify-expectation"
  }],
  "openQuestions": [{ "question": "", "needs": "", "related": "REQ-id" }],
  "riskNotes": ["string"],
  "retrievalTruncated": "boolean, 必填"
}`,
    allowTools: ['kb_query', 'case_query', 'fs_read', 'fs_write'],
    denyTools: ['写知识库/用例库', '生成用例', '执行测试', '修改 receive.json 或任何上游产物'],
    boundaries: '- 不修改需求内容（receive.json 的原文、优先级、范围一概不动）。',
    artifactNotes: '- 每个结论字段尽量附 evidence（版本档案条目 id / 知识库条目 id / receive.json 字段引用）。',
  },

  design: {
    title: '测试设计',
    roleTail: '执行 agent（设计执行者）',
    task: `1. 按需求点生成用例：每个需求点 ≥1 条用例（覆盖矩阵必须完备，机器门禁 R3-01 校验）；
2. 覆盖矩阵 coverageMatrix 与 testCases ∪ reusedCases 双向一致；
3. 复用清单中的用例单独列出为 reusedCases（不并入 testCases），
   带 sourceCaseId + 适配动作（unchanged / modify-data / modify-expectation）+ 适配后完整内容；
4. 无法覆盖的需求点写入 gaps（带原因），宁可 gaps 也不要假装覆盖；
5. 用例总数（testCases + reusedCases）不得超过预算上限；超出按 P0/P1/P2 分层取舍。
定位：你是"设计执行者"，不是"决策者"——复用范围来自人工门 C 的确认清单。`,
    schemaInline: `{
  "testCases": [{ "id": "TC-", "title": "", "preconditions": ["≥1"],
    "execution_level": "auto|hybrid|manual", "priority": "P0|P1|P2",
    "coverageRef": ["REQ-id"], "steps": [{"action":"","data":{}}],
    "expected": ["≥1"], "data": "可选", "cleanup": "可选" }],
  "reusedCases": [{ "id": "TC-", "sourceCaseId": "历史库 id", "title": "",
    "adaptation": "unchanged|modify-data|modify-expectation", "...": "同 testCases" }],
  "coverageMatrix": { "REQ-001": ["TC-0001"] },
  "gaps": [{ "requirementId": "REQ-id", "reason": "" }]
}`,
    allowTools: ['fs_read', 'fs_write'],
    denyTools: ['执行测试', '写知识库/用例库', '自行决定复用清单之外的用例'],
    boundaries: '- steps 与 expected 不能是空话；无法给出可执行断言的场景写入 gaps。\n- 覆盖矩阵与 gaps 必须自洽（R3-04）。',
    artifactNotes: '- 每条用例的 coverageRef 必须指向 analyze.json 中真实存在的需求点 id。',
  },

  execute: {
    title: '测试执行',
    roleTail: '编排与聚合 agent（非执行者）',
    task: `1. 制定执行计划：环境、执行器分档、执行顺序；plan.order 覆盖全部用例；
2. 按 execution_level 分档编排：
   - auto / hybrid：调用 executor_run(caseIds) 让 executor 执行——入参只传用例 id，
     不传、不指定任何"期望结果"；executor 自读 design.json、真实执行、返回自产记录；
   - manual：不执行，进入 pendingManual 清单，等待人工在 manual 执行会话内回填；
3. 环境初始化必须幂等（重复执行收敛）；
4. 证据由 executor 写入 evidence/ 并生成 evidence-manifest（executor 独占，你无写权）；
5. 区分 envIssues（环境问题）与用例失败，不得混记；
6. 全部计划用例必须有结果（pass/fail/pending），缺跑即违规（R4-01）；
7. 续跑（环境中断恢复）：已 pass 保留不重跑；已 fail 保留除非 envIssueId 关联；
   pending/未执行继续执行；产物 resumed: true；
8. 系统级问题诊断：阻塞时用 env_diag 定位并采集证据，blocking 级给 recommendation
   后停止，不把环境故障算成用例失败；
9. manual 回填（会话级见证）：原样引用人工提交的状态与说明，带 sessionId/attestedBy；
   manual 失败必须带说明。
定位：你是"编排者+聚合者+诊断者"，不是"执行者/定性者"——执行由 executor 完成，
失败定性由人工门 E 处理。`,
    schemaInline: `{
  "plan": { "env": ["≥1"], "executors": [{"level":"auto|hybrid|manual","impl":""}],
    "order": ["覆盖全部用例 id"] },
  "results": [{ "caseId": "", "recordRef": "executor 记录 id（必填）",
    "status": "pass|fail|pending", "evidence": ["manifest 条目 id"],
    "durationMs": 0, "attempts": 1, "envIssueId": "可选",
    "manualClaimed": "可选", "attestedBy": "可选", "sessionId": "可选",
    "note": "失败原因；manual 失败必填" }],
  "envIssues": [{ "id": "env-", "category": "network|disk|server|credentials|other",
    "severity": "blocking|degrading|warning", "issue": "", "diagnosis": ["≥1"],
    "impact": ["caseId 或 all"], "resolution": "", "recommendation": "" }],
  "pendingManual": ["caseId"],
  "resumed": "boolean, 必填"
}`,
    allowTools: ['fs_read', 'fs_write', 'executor_run', 'env_diag'],
    denyTools: ['kb_write', 'case_archive', 'subagent', '修改 executor 记录或 evidence', '修改 design.json 或任何上游产物'],
    boundaries: '- 环境问题与用例失败分类记录，证据分别采集。\n- 用例级超时由执行器配置决定；达到上限停止。',
    artifactNotes: '- 幂等纪律：同一用例每次尝试以 (caseId, attempt) 区分，重试不重复副作用。\n- 执行可信纪律：只聚合 executor 记录，不改记录/证据/状态（R4-08/09/10）。',
  },

  report: {
    title: '测试报告',
    roleTail: '执行 agent（解读者+建议者）',
    task: `1. 只解读，不计算：所有统计数字以 stats 文件为准，禁止自行计算或"修正"；
2. 缺陷分析逐条关联 caseId 与证据引用（从 evidence-manifest 解析，不引用快照外路径）；
3. 给出风险清单（每条带等级与证据）；风险数组非空（无风险显式写 "none"）；
4. 发布建议：只给建议（approve/conditional/reject + 理由），不下决定；
   manual-claimed 占比超阈值（>30%）或未完成抽检时不得给 approve（R5-06）；
5. unconfirmed 列出全部未确认项（WARNING/遗留 pending/重入次数/reviewDegraded）；
6. 复用用例（reusedCases）通过率单独披露（stats.bySource）。
定位：你是"解读者+建议者"，不是"决策者"——发布决策由人工门 F 审批。`,
    schemaInline: `{
  "stats": { "total": 0, "passed": 0, "failed": 0, "passRate": 0.0,
    "byPriority": {}, "byModule": {},
    "bySource": { "new": {"total":0,"passed":0,"passRate":0},
                  "reused": {"total":0,"passed":0,"passRate":0} } },
  "defectAnalysis": [{ "caseId": "", "defect": "", "severity": "critical|major|minor",
    "evidence": ["manifest 条目 id"], "classification": "defect|case-issue|env-issue|suspected" }],
  "risks": [{ "risk": "", "level": "high|medium|low", "evidence": "" }],
  "releaseRecommendation": "approve|conditional|reject",
  "recommendationReason": "string, 必填",
  "unconfirmed": ["string"]
}`,
    allowTools: ['fs_read', 'fs_write'],
    denyTools: ['kb_write', 'case_archive', 'executor_run', '访问快照外路径', '修改 execute.json 或任何上游产物'],
    boundaries: '- 不计算统计数字；stats 的准确性由代码聚合与机器门禁 R5-01 保证。\n- 无法追溯的"问题"进 risks 或 unconfirmed 而非 defectAnalysis。',
    artifactNotes: '- stats 必须与 stats 文件逐字一致（R5-01 重算比对）。',
  },

  archive: {
    title: '产物归档',
    roleTail: '执行 agent（归档执行者）',
    task: `第一趟（准备，不写库）：
1. 按知识条目模板生成 knowledgeEntries（标题/日期/项目/版本/标签/实体/正文/来源流水线）
   ——归档格式 = 检索格式，关键实体非空（R6-01）；
2. 用例版本化回流 caseArchive：testCases（新）与 reusedCases（复用，按 sourceCaseId
   映射历史版本）都回流，带版本 + 来源需求 + ticketRef（R6-02）；
3. 更新版本档案 versionArchive（本次变更摘要）；
4. archiveReport 先记 pending 清单，不执行写库；
第二趟（写库，仅当 extraContext 携带人工门 G 批准）：
5. 按批准后的清单执行 kb_write / case_archive，只写批准清单内的内容，不增不减（R6-04）；
6. 更新 archiveReport 为实际结果；幂等：同一 pipelineId 重复归档覆盖同条目（R6-03）；
   历史版本只追加记录，不覆盖删除。
定位：你是"归档执行者"，不是"审计者"——归档内容正确性由人工门 G 确认。`,
    schemaInline: `{
  "knowledgeEntries": [{ "id": "", "title": "", "date": "", "project": "",
    "version": "", "tags": ["string"], "entities": ["≥1"], "body": "非空",
    "sourcePipeline": "" }],
  "caseArchive": [{ "caseId": "", "version": "", "sourceRequirement": "",
    "ticketRef": "", "content": {} }],
  "versionArchive": [{ "version": "", "changeSummary": "" }],
  "archiveReport": { "entries": 0, "cases": 0, "skipped": ["string"], "written": false }
}`,
    allowTools: ['fs_read', 'fs_write', 'kb_write', 'case_archive'],
    denyTools: ['subagent', '修改上游产物', '删除/覆盖历史版本', '写门 G 批准清单之外的任何内容'],
    boundaries: '- 第一趟绝不写库：写库只发生在门 G 批准后的第二趟。\n- 历史版本只追加记录，不覆盖删除。',
    artifactNotes: '- 知识条目必须满足检索模板（02 第 11 节）：实体非空、正文非空、来源可溯。',
  },
}
