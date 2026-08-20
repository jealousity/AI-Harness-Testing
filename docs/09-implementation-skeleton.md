# 09 实现层骨架（评审稿）

> 配套文档：[01~08 设计文档](./)（01 门禁 · 02 流程模板 · 03 角色边界 · 04 模板框架 · 05 阶段模板 · 06 工具权限 · 07 决策清单 · 08 执行可信）
> 状态：评审稿。本骨架把设计映射到 DeepSeek Harness 原语，给出结构级 TypeScript 代码。**骨架，非生产代码**；标注 `<验证点>` 处需在实现时对照 harness 实际 API 确认。

---

## 0. 分层架构

> **已决策（D-20）**：mainAgent 实现为 **host 侧纯代码 PipelineDriver**，由用户命令直接驱动——不是 LLM agent 会话。因此 mainAgent 无"上下文约束/越权/工具白名单"概念（代码天然不会越权），强制层全部落在代码结构里。

```
┌────────────────────────── host 进程（cordis plugin）──────────────────────────┐
│  platform-pipeline 插件                                                        │
│   ├─ driver.ts          PipelineDriver（原 mainAgent）：用户命令直接驱动       │
│   │                      初始化 → 逐阶段 { spawn → 门禁 → 交叉检查 → 人工门 }  │
│   │                      → 检查点 → 重入（纯代码，非 LLM agent）               │
│   ├─ config.ts         pipeline.yaml 解析 → 生效 ACL / 契约 / 预算             │
│   ├─ checkpoint.ts     检查点读写（固定路径 JSON + 原子写 + digest）           │
│   ├─ gates/machine.ts  机器门禁引擎（规则表驱动 + gate_check 服务）            │
│   ├─ executor/*        确定性执行器（executor_run 服务 + hash chain）         │
│   ├─ stores/*          存储适配（knowledge/cases/requirements）               │
│   ├─ stage-spawner.ts  阶段 spawn（ACL 强制 + 调 SubagentProvider.start）     │
│   └─ human-gate.ts     人工门（ui-user-questions 服务 + manual 会话）         │
└──────────────┬──────────────────────────────────────────────────────────┘
               │ 直接调用（host 代码 ↔ host 服务；人工门经 ui-user-questions）
               ▼
┌────────────────────────── 阶段 agent（一次性 subagent）──────────────────────┐
│  [1]~[6]：写产物文件 → 结束；工具被 ACL 收窄，证据目录 executor 独占            │
└──────────────────────────────────────────────────────────────────────────┘
```

**关键决策**：mainAgent 是代码而非 agent——用户命令（如 `dsh pipeline run --project acme-pay`）直接构造并运行 PipelineDriver；阶段 agent 仍是真实 subagent（唯一有 LLM 的部分），其 spawn 经 `stage-spawner` 强制 ACL。

---

## 1. 核心类型（types.ts）

```ts
/** 检查点：流水线状态唯一事实（02 第 9 节）。 */
export interface Checkpoint {
  pipelineId: string
  templateVersion: string
  rulesetVersion: string
  cursor: number                                   // 下一个要执行的阶段下标
  stageStates: Record<StageId, StageState>
  reentries: ReentryRecord[]
  budget: Record<StageId, StageBudget>
}

export type StageStatus =
  | 'idle' | 'running' | 'produced' | 'needs-fix'
  | 'gate-failed' | 'awaiting-gate' | 'done' | 'needs-reentry'

export interface StageState {
  status: StageStatus
  artifact: string                                 // artifacts/<pipelineId>/<stageId>.json
  digest: string
  history: { digest: string; capturedAt: number; supersededBy?: number }[]
  reviewDegraded: boolean
  gate: {
    machine: { status: 'passed' | 'failed'; attempts: number; violations: Violation[] }
    review?: { status: 'pass' | 'conditional' | 'fail' | 'degraded'; report: string; findings: ReviewFinding[] }
    human: { state: 'open' | 'approved' | 'changes-needed'; records: HumanGateRecord[] }
  }
  failures: { kind: FailureKind; rule?: string; at: number }[]
}

/** 产物输入摘要锁（G-08）：产物声明的上游 digest。 */
export interface InputLocks { [upstreamStage: string]: string }

/** 阶段产物统一包装：内容 + 摘要锁 + 版本信息。 */
export interface StageArtifact<Content = unknown> {
  pipelineId: string
  stageId: StageId
  version: number                                  // 重入/回环覆盖时递增
  inputs: InputLocks
  content: Content
}
```

---

## 2. PipelineDriver 主循环（driver.ts）—— 用户命令直接驱动（D-20）

```ts
/** 用户命令 `dsh pipeline run --project <id> [--reenter <stageId>]` 构造并运行。 */
export class PipelineDriver {
  constructor(
    private readonly cfg: PipelineConfig,
    private readonly cp: CheckpointStore,
    private readonly spawn: StageSpawner,          // stage-spawner：ACL 强制
    private readonly gates: MachineGateEngine,
    private readonly human: HumanGatePort,          // ui-user-questions 服务
  ) {}

  /** 恢复 = 读检查点续跑；重入 = 命令参数回退 cursor（03 第 8 节）。 */
  async run(): Promise<void> {
    const cp = await this.cp.load()
    while (cp.cursor < STAGE_ORDER.length) {
      const stageId = STAGE_ORDER[cp.cursor]
      const stage = cp.stageStates[stageId]

      if (stage.status === 'done') { cp.cursor++; continue }        // 幂等跳过
      if (stage.status === 'needs-reentry') { /* 重入路径：回退后按 produced 重跑 */ }

      // 1. spawn 阶段 agent（强制层在此：toolFilter + 产物路径 + 违规清单回喂）
      const artifact = await this.spawn.runStage(stageId, cp, stage.status === 'needs-fix'
        ? stage.gate.machine.violations : undefined)

      // 2. 机器门禁（代码重算；G-08 摘要锁 / R4-08 对账 / R4-09 时序链 / R4-10 锚定）
      const gate = await this.gates.judge(stageId, artifact)
      if (gate.status === 'failed') {
        if (stage.gate.machine.attempts < this.cfg.maxGateRetries) {  // N=2
          await this.cp.save({ ...cp, stageStates: { ...cp.stageStates, [stageId]: {
            ...stage, status: 'needs-fix', gate: { machine: gate, ...stage.gate } } } })
          continue                                                  // 违规清单回喂重跑
        }
        await this.human.gateFailed(stageId, gate)                  // 升级人工，二次判定
        return
      }

      // 3. 交叉检查（analyze/design/execute/report 开启）
      if (this.cfg.stages[stageId].review.enabled) {
        const verdict = await this.spawn.runReview(stageId, artifact, gate)
        if (verdict === 'fail') { /* findings 回喂重跑（≤1 次）或升级人工 */ }
      }

      // 4. 人工门（block；manual 会话在 execute 阶段由此处发起）
      const decision = await this.human.gate(stageId, artifact, gate)
      if (decision === 'rejected') return
      if (decision === 'changes-needed') { /* 带人工反馈重跑 */ continue }

      // 5. 推进
      await this.cp.save({ ...cp, cursor: cp.cursor + 1,
        stageStates: { ...cp.stageStates, [stageId]: { ...stage, status: 'done' } } })
    }
  }
}
```

> 说明：D-20 后本循环是**纯代码**——无需 goal pause/resume（检查点 + 命令重跑即恢复）、无需 mainAgent 上下文约束（代码不会越权）、越权处理只针对阶段 agent（06 第 6 节）。

---

## 3. 阶段 spawn（pipeline_stage.ts）—— 强制层落点

```ts
export class StageSpawner {
  /** 每个阶段 agent 一次性的 spawn：ACL 强制 + 结构化 prompt + 产物路径。 */
  async runStage(
    stageId: StageId,
    cp: Checkpoint,
    violations?: Violation[],            // 门禁重跑时回喂
  ): Promise<StageArtifact> {
    const stage = this.cfg.stages[stageId]
    // 1. 计算生效 ACL = 平台标准 + 项目 delta（06 第 4 节）
    const acl = this.acl.effective(stageId)
    // 2. 拼装 prompt：公共骨架 + 差异段 + schema 内联简版 + extraContext（≤2K）
    const prompt = this.prompt.assemble(stageId, {
      pipelineId: cp.pipelineId,
      inputPaths: this.inputsOf(stageId, cp),
      budget: stage.budget,
      extraContext: this.extraContext(stageId, cp, violations),
    })
    // 3. spawn：toolFilter 强制 + 前台等待（execute 阶段用后台可续跑）
    const run = await this.provider.start({
      request: {
        description: stageId,
        prompt,
        toolFilter: acl,                 // ← 强制层：被禁工具物理不可达
        ...(stageId === 'execute' ? { background: true } : {}),   // <验证点> continuation API
      },
    } as never)                          // <验证点> ResolvedSubagentStartRequest 精确形状
    // 4. 读产物文件，校验存在 + 结构（机器门禁在下一步做完整判定）
    return this.artifactReader.read(stageId, cp.pipelineId)
  }

  /** 审核 agent：盲审、schema 强制、只读快照。 */
  async runReview(stageId: StageId, artifact: StageArtifact, gate: MachineGateResult): Promise<ReviewVerdict> {
    const reviewPrompt = this.prompt.review(stageId, {
      contract: this.cfg.stages[stageId].contract,
      upstreamPaths: this.inputsOf(stageId, /* cp */),
      artifactPath: artifact.path,
      violations: gate.violations,
      mustCheck: REVIEW_CHECKLIST[stageId],     // D-14 必查清单
    })
    const run = await this.provider.start({ request: {
      description: `review:${stageId}`, prompt: reviewPrompt,
      toolFilter: { allow: ['fs_read', 'fs_write'], deny: [] },   // 审核 agent 只读产物
      outputSchema: reviewSchema(stageId),       // <验证点> 结构化输出 API
    } } as never)
    return this.reviewReader.read(stageId, run)
  }
}
```

**强制层清单**（在 spawn 内做，不依赖 agent）：
1. `toolFilter` 来自生效 ACL（allow + deny 合并），spawn 前对工具目录全量校验（未知名 → 抛错）。
2. execute 阶段的 `fs_write` 路径白名单**排除 `evidence/`**（08 第 2 节）。
3. extraContext 上限 2K token，超限截断标注（D-15）。
4. 门禁重跑时 `violations` 回喂进 prompt（01 第 5 节）。

---

## 4. 机器门禁引擎（gates/machine.ts）—— 确定性代码，规则表驱动

```ts
export interface GateRule {
  id: string                                 // G-01..G-08 / R1-01..R6-05
  level: 'BLOCKING' | 'WARNING'
  stages: StageId[]                          // 作用阶段；G 系列为全部
  judge: (ctx: RuleContext) => Violation[]   // 纯函数：产物 + 上游 → 违规列表
}

/** 规则表：平台标准（不可删）+ 项目追加（代码实现 + 单测）。 */
export class MachineGateEngine {
  constructor(private readonly rules: GateRule[]) {}

  /** 全量重判（不增量），留痕进检查点。 */
  async judge(stageId: StageId, artifact: StageArtifact): Promise<MachineGateResult> {
    const violations: Violation[] = []
    for (const rule of this.rules.filter(r => r.stages.includes(stageId))) {
      violations.push(...rule.judge({ artifact, upstream: await this.upstreams(artifact.inputs) }))
    }
    const status = violations.some(v => v.level === 'BLOCKING') ? 'failed' : 'passed'
    return { status, attempts: 1, violations, rulesetVersion: this.rulesetVersion }
  }
}
```

规则实现要点（对应设计）：

| 规则 | 实现要点 |
|---|---|
| G-08 摘要锁 | 重算上游产物 digest，与 `artifact.inputs` 比对（级联失效与重入的根基） |
| R4-08 对账 | 重算 `executorRecords ↔ results` 双向引用覆盖（防空跑/漏跑） |
| R4-09 时序链 | 逐条重算 hash 链；续跑链段段头链接旧尾（08 第 3 节） |
| R4-10 证据锚定 | evidence 的 `capturedBy` 必须是 executor 身份 + digest 可重算 + 时间窗一致 |
| R5-01 数字一致 | 重算 stats 并与 report.json 比对（LLM 禁手） |

---

## 5. 检查点读写（checkpoint.ts）

```ts
export class CheckpointStore {
  constructor(private readonly root: string) {}   // artifacts/<pipelineId>/

  async load(): Promise<Checkpoint> { /* 读 checkpoint.json；缺失 → 初始化 */ }
  async save(cp: Checkpoint): Promise<void> {
    // 原子写：写临时文件 → fsync → rename；先落盘后推进（03 第 8 节）
    const tmp = `${CHECKPOINT_PATH}.tmp`
    await writeJson(tmp, cp); await fsync(tmp); await rename(tmp, CHECKPOINT_PATH)
  }
  // 产物历史（重入替换）：写 history/<stageId>/v<version>.json
}
```

---

## 6. executor 契约（executor/executor.ts）—— 执行可信的核心

```ts
/** 执行器唯一执行者契约（08 第 2 节）。 */
export interface Executor {
  /** 入参只传 caseId；executor 自读 design.json、真实执行、自产记录与证据。 */
  run(caseIds: readonly string[], ctx: ExecutorContext): Promise<ExecutionSession>
}

/** executor 自产的执行记录（R4-09 时序链成员）。 */
export interface ExecutionRecord {
  seq: number
  caseId: string
  capturedAt: number
  durationMs: number
  status: 'pass' | 'fail' | 'pending'
  evidenceRefs: string[]
  prevHash: string                     // ← 上一条记录 hash（链）
  ownHash: string                      // ← 本条整体 hash
  segment: number                      // 续跑新链段（08 第 3 节）
  resumedFrom?: string                 // 段头：旧链尾 hash
}

export interface EvidenceEntry {
  id: string; recordId: string; file: string
  digest: string
  capturedBy: 'executor:' + string     // ← 来源锚定（R4-10），agent 写的证据不认
  capturedAt: number
}
```

- **side-effect 留痕契约**（08 第 6 节）：http runner 抓真实 wire 数据、ui runner 截图 + DOM 快照、client runner 进程清单；**独立确定性测试验收**（ET-03）：断言"每条记录必有对应留痕"。
- **evidence/ 目录权限**：executor 进程独占；execute agent 的 fs_write 排除该目录（06 第 9 节一致性）。

---

## 7. 存储适配（stores/）

```ts
// 与 02 第 7 节接口一致；markdown-fs 首批实现，jira/xray/testlink 后续。
export interface KnowledgeStore {
  read(query: { entities: string[]; project: string; limit: number }): Promise<Entry[]>
  write(entry: KnowledgeEntry): Promise<string>
}
export interface CaseStore {
  query(filter: { project: string; requirement?: string; version?: string }): Promise<CaseMeta[]>
  archive(case: VersionedCase): Promise<void>
}
export interface RequirementSource {
  pull(sourceRef: RequirementSourceRef): Promise<RequirementRaw[]>
}
// 需求源降级链：jira API → 导出文件 → 人工粘贴（任一成功即继续）
```

---

## 8. 配置解析（config.ts）→ 生效 ACL

```ts
export interface PipelineConfig {
  projectId: string; projectType: ProjectType; templateVersion: string
  scaleTier: 'S' | 'M' | 'L'
  releasePolicy: { maxManualClaimedRatio: number }        // 默认 0.3（R5-06）
  stages: Record<StageId, StageConfig>                     // 契约/门/预算/规则/review/tools-delta
}

/** 生效 ACL = 平台标准（不可删）+ 项目 delta（加 deny 自由 / 加 allow 需评审）。 */
export function effectiveAcl(stageId: StageId, cfg: PipelineConfig): ToolFilter {
  const base = PLATFORM_ACL[stageId]
  const delta = cfg.stages[stageId].tools ?? {}
  return {
    allow: [...(base.allow ?? []), ...(delta.allow ?? [])],
    deny: [...(base.deny ?? []), ...(delta.deny ?? [])],
  } // <验证点> 与 harness ToolRestriction 语义（allow 存在即白名单？deny 优先？）对齐
}
```

---

## 9. harness 原语映射表（用现成的 vs 新建的）

| 能力 | harness 原语 | 状态 |
|---|---|---|
| 阶段 spawn（带 toolFilter 强制） | `SubagentProvider.start({ request: { toolFilter } })` | 现成（<验证点> 精确请求形状） |
| 结构化输出（审核 agent） | provider capability `outputSchema` + `structured_output` 工具 | 现成 |
| 长流程暂停/恢复 | ~~goal 域~~ **不再需要**（D-20 后为纯代码驱动：检查点 + 命令重跑即恢复） | — |
| 人工提问/人工门 | ui-user-questions | 现成 |
| 产物/检查点文件 | fs 服务 + workspace | 现成 |
| 工具注册（阶段 agent 可见工具） | `ctx.tools.register(defineTool({...}))` | 现成 |
| **机器门禁引擎**（gate_check 服务） | 新建：规则表 + judge + 留痕 | 🆕 |
| **stage-spawner**（ACL 强制 spawn） | 新建：封装 provider.start + 生效 ACL | 🆕 |
| **executor + hash chain + evidence 锚定** | 新建：确定性模块 + runner 实现 | 🆕 |
| **env_diag** | 新建：固定探针（磁盘/网络/服务/凭据） | 🆕 |
| **manual 执行会话** | 新建：会话状态 + 超窗（4h）关闭 | 🆕 |
| **存储适配**（kb_query/kb_write/case_query/case_archive） | 新建：接口 + markdown-fs 实现 | 🆕 |

---

## 10. 落地顺序（先最小闭环）

| 步骤 | 内容 | 验收 |
|---|---|---|
| 1 | 配置解析 + 检查点 + 工具目录/ACL 计算 | 单测：pipeline.yaml → 生效 ACL |
| 2 | `pipeline_stage` 工具 + 公共骨架 prompt 拼装 | 能 spawn 一个阶段 agent 并写产物 |
| 3 | 机器门禁引擎（G-01~08 先做） | 单测：伪造产物被 BLOCKING |
| 4 | **最小闭环：receive → 门禁 → 人工门 A → analyze → 门禁 → 门 B/C** | 端到端：真实输入跑通前两阶段 |
| 5 | executor 契约 + http runner + hash chain | 单测：记录链校验、对账 R4-08 |
| 6 | design → execute（含 manual 会话）→ report → archive 逐阶段接入 | 全六阶段端到端 |
| 7 | 重入 + 交叉检查 + 执行可信抽检 | 故障注入：重入级联、审核 fail |

---

## 11. 验证点（实现时需对照 harness 实际 API）

1. `ResolvedSubagentStartRequest` 的精确形状（toolFilter/background/outputSchema 字段名）。
2. execute 阶段后台可续跑 spawn 的确切方式（continuation manager API）。
3. `ToolRestriction` 语义：allow 与 deny 的合并规则（白名单 vs 黑名单优先级）。
4. `structured_output` 在审核 agent 场景的接入方式（或直接读 review.json 文件）。
5. goal pause/resume 与"人工门等待"的对接（mainAgent 等待期间是否释放会话）。

---

## 12. 决策记录

| 编号 | 问题 | 决策 | 备注 |
|---|---|---|---|
| D-20 | mainAgent 触发形态 | 用户命令直接驱动 host 侧 PipelineDriver（纯代码） | 无 goal 生命周期、无 agent 越权概念 |
| I-1 | 插件包结构 | **独立 cordis 插件包** `platform-pipeline` | 可插拔、可单测、不污染现有 host 组合 |
| I-2 | manual 会话 UI | **复用 ui-user-questions 弹窗流** | 开始会话→逐条回填→结束会话问答序列；专用界面后续可换 |
| I-3 | 用户命令入口 | **挂现有 CLI 子命令**：`dsh pipeline run --project <id> [--reenter <stageId>]` | 与 `dsh web` 等现有子命令一致 |

**09 全部开放问题清零。** 实现前置决策齐备。

---

## 13. 落地顺序（复述，含决策标注）

| 步骤 | 内容 | 验收 |
|---|---|---|
| 1 | 独立插件包骨架 + 配置解析 + 检查点 + 工具目录/ACL 计算 | 单测：pipeline.yaml → 生效 ACL |
| 2 | `stage-spawner` + 公共骨架 prompt 拼装 | 能 spawn 一个阶段 agent 并写产物 |
| 3 | 机器门禁引擎（G-01~08 先做） | 单测：伪造产物被 BLOCKING |
| 4 | **最小闭环：receive → 门禁 → 人工门 A → analyze → 门禁 → 门 B/C** | 端到端：真实输入跑通前两阶段 |
| 5 | executor 契约 + http runner + hash chain | 单测：记录链校验、对账 R4-08 |
| 6 | design → execute（含 manual 会话）→ report → archive 逐阶段接入 | 全六阶段端到端 |
| 7 | 重入 + 交叉检查 + 执行可信抽检 | 故障注入：重入级联、审核 fail |
