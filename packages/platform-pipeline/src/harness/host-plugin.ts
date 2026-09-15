/**
 * 宿主接线插件（把 platform-pipeline 真正接进 harness 宿主）。
 *
 * plugin.ts 只装配确定性组件并暴露 `ctx.pipeline`；spawner / human / review
 * 这些**运行时对象**必须由宿主现场构造。本文件就是 harness 内的那个宿主：
 * 用可序列化配置 + ctx 服务构造注入面，并注册触发入口。
 *
 * 真实链路（无脚本跳过）：
 * - 阶段 spawn → `ctx.subagents.start`（parent = 触发流水线的**根会话 agent**）；
 * - 人工门 → `ctx.userQuestions`（harness 真弹窗流，阻塞等真人在界面上裁决）；
 * - 交叉检查 → 结构化输出审核 agent（盲审，只读）。
 *
 * 触发约束：`pipeline_run` 工具只能由**根会话 agent**调用。人工门裁决在 UI 上
 * 归属触发会话，子 agent 代表不了真人 —— 非根调用直接拒绝，不做降级。
 *
 * 真人裁决同时落 JSONL 审计（`<checkpointRoot>/human-gate-audit.jsonl`），
 * 使「确有真人逐门裁决」可事后核查。
 *
 * ⚠️ 本文件属宿主接线层，允许运行时引用 harness 包；包的对外能力仍由
 * human-gate.ts / driver.ts 等零 harness 依赖的模块提供（I-4）。
 * @module platform-pipeline/harness/host-plugin
 */

import { appendFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { SubagentRuntime } from '@deepseek-ai/dsh-subagent'
import { loadPipelineConfig } from '../config.ts'
import { FsArtifactStore, FsCheckpointPort } from '../stores/fs.ts'
import { MachineGateEngine, platformGenericRules } from '../gates/machine.ts'
import { stageRules } from '../gates/stage-rules.ts'
import { pipelineContractSchemas } from '../contracts/schemas.ts'
import { PipelineDriver, type RunOutcome } from '../driver.ts'
import { UiUserQuestionsHumanGate, type HumanGateAuditRecord } from '../human-gate.ts'
import { HarnessStageSpawner } from './stage-spawner-harness.ts'
import { HarnessReviewRunner } from './review-runner-harness.ts'
import { applyToolTimeoutPolicy } from './tool-timeout.ts'
import { registerStageTools } from './stage-tools.ts'
import type { StageId } from '../types.ts'

/** 插件名（cordis 生命周期标识）。 */
export const name = 'platform-pipeline-host'

/**
 * 构建标识：宿主插件没有可靠的「代码是否已加载」信号——配置热重载会重新 apply
 * 但**不重新 import 模块**，所以改了代码不重启就仍是旧代码在跑（已反复踩到）。
 * 每次改动插件代码**必须递增**本值，并用 pipeline_run action=status 确认宿主
 * 实际加载的是哪一版，避免盲目重启 / 盲目重试。
 */
export const HOST_PLUGIN_BUILD = 'build-2026-09-15-2215'

/** 依赖的 harness 服务。 */
export const inject = ['agents', 'userQuestions', 'subagents', 'tools']

export interface HostPluginConfig {
  /** pipeline.yaml 路径。 */
  readonly configPath: string
  /** 产物根目录。 */
  readonly artifactsRoot: string
  /** 检查点根目录。 */
  readonly checkpointRoot: string
  /**
   * receive 阶段的输入文件路径（需求原文）。缺省时 receive 无上游也无输入，
   * 只能凭空产出——真实运行必须提供。
   */
  readonly receiveInput?: string
  /**
   * execute 阶段执行会话路径（executor 写的 session.json）；R4-08/09/10
   * 对账需要它，缺省则 execute 门禁拿不到执行数据。
   */
  readonly executionSessionPath?: string
  /** 执行证据落盘目录（缺省：executionSessionPath 同级的 evidence/）。 */
  readonly evidenceDir?: string
  /** 被测服务基址。缺省时 executor_run 拒绝伪造执行记录。 */
  readonly targetBaseUrl?: string
  /** subagent provider 名（默认 'spawn'）。 */
  readonly providerName?: string
  /** 是否启用交叉检查（默认启用）。 */
  readonly enableReview?: boolean
  /** 审核 agent 工具白名单（盲审只读；缺省由宿主决定）。 */
  readonly reviewAllowTools?: readonly string[]
  /** 工具名（默认 'pipeline_run'）。 */
  readonly toolName?: string
  /** 工具与整条流水线的超时（毫秒，默认 120 分钟）。
   * 含 6 次人工门等待，30 分钟不够——超时会由工具超时策略强制中止。 */
  readonly timeoutMs?: number
}

function textResult(text: string): ContentBlock[] {
  return [{ type: 'text', text }]
}

/**
 * 把 driver 的 "produced no artifact" 失败改写成可定位的诊断。
 *
 * 实测踩到的坑：产物路径是相对路径（`artifacts/<pipelineId>/<stage>.json`），
 * 阶段子会话带着自己的工作区根（cwd），会把该相对路径**绝对化**后写入。若
 * artifactsRoot 与子会话工作区根不一致，产物会落到别处，driver 只报一句
 * "produced no artifact"，看不出是路径口径不一致。这里主动去找产物实际落点。
 */
async function runWithDiagnostics<T>(
  run: () => Promise<T>,
  pipelineId: string,
  artifactsRoot: string,
): Promise<T> {
  try {
    return await run()
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const matched = /produced no artifact at (\S+)/.exec(message)
    if (matched === null) {
      // 非产物路径问题：补上栈回溯。宿主里的失败常常只回一句 message，
      // 定位不到真正的抛出点（已实测吃过这个亏）。
      const stack = error instanceof Error && error.stack !== undefined
        ? error.stack.split('\n').slice(0, 12).join('\n')
        : '(no stack)'
      throw new Error(`${message}\n\n【栈回溯（宿主插件 ${HOST_PLUGIN_BUILD}）】\n${stack}`)
    }
    const artifactPath = matched[1]!
    const expected = join(artifactsRoot, artifactPath)
    const lines = [
      message,
      '',
      '【产物路径口径诊断】',
      `  期望读取点：${expected}`,
      `  artifactsRoot：${artifactsRoot}`,
      '  产物路径是相对路径，阶段子会话会按**自己的工作区根**（harness 写进它的',
      '  系统提示，可在子会话 session.jsonl 的 cwd 字段核对）绝对化后写入。',
      `  不变式：artifactsRoot 必须等于阶段子会话的工作区根（会话 cwd）。`,
      '  若不一致，产物会落在 <子会话 cwd>/' + artifactPath + '。',
    ]
    // 主动找产物是否落在子会话工作区根下（补一条确证，而不是让调用方自己猜）
    for (const root of [process.cwd()]) {
      try {
        const found = await stat(join(root, artifactPath))
        lines.push(`  已确认产物实际落点：${join(root, artifactPath)}（${found.size} 字节）`)
        lines.push('  → 把 artifactsRoot 改成该工作区根即可对齐。')
      } catch {
        // 不在此根下，跳过
      }
    }
    lines.push(`  （pipelineId=${pipelineId}）`)
    throw new Error(lines.join('\n'))
  }
}

/**
 * 把契约 schema 落盘到 `<artifactsRoot>/schemas/<stage>.schema.json`。
 *
 * 为什么需要：阶段提示词写着「完整 schema 文件：schemas/<stage>.schema.json
 * （可 read 读取，以文件为准）」，但这些文件**此前从未被写到磁盘上**——schema 只
 * 存在于代码里（contracts/schemas.ts）。实测后果：阶段 agent 按提示词去 read 一律
 * ENOENT，只能照正文散文模板构造结构，并在产物里如实抱怨「契约声明的
 * schemas/execute.schema.json 在工作区不存在」。
 *
 * 每次跑之前重新落盘（而非只在装载时），保证与当前代码里的 schema 一致。
 */
export async function materializeContractSchemas(artifactsRoot: string): Promise<string[]> {
  const dir = join(artifactsRoot, 'schemas')
  await mkdir(dir, { recursive: true })
  const schemas = pipelineContractSchemas()
  const written: string[] = []
  for (const [stageId, schema] of Object.entries(schemas)) {
    const path = join(dir, `${stageId}.schema.json`)
    await writeFile(path, `${JSON.stringify(schema, null, 2)}\n`, 'utf8')
    written.push(path)
  }
  return written
}

/** 真人裁决 JSONL 审计：追加一条不可变的裁决记录。 */
async function appendAudit(path: string, record: HumanGateAuditRecord): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await appendFile(path, `${JSON.stringify(record)}\n`, 'utf8')
}

/** 解析触发者：必须是活的根会话 agent（人工门裁决的归属会话）。 */
function requireRootAgent(ctx: Context, exec: { readonly agent?: Agent }): Agent {
  const agent = exec.agent
  if (agent === undefined) {
    throw new Error('pipeline_run 缺少调用方 agent（exec.agent 未设置）：无法确定人工门裁决归属的会话。')
  }
  const roots = ctx.agents.roots()
  if (!roots.includes(agent)) {
    throw new Error(
      'pipeline_run 只能由根会话 agent 触发：人工门弹窗在界面上归属触发会话，'
      + '子 agent 无法代表真人裁决。请在主会话中发起流水线。',
    )
  }
  return agent
}

/** 流水线运行所需的装配结果。 */
interface Assembled {
  readonly driver: PipelineDriver
  readonly decisions: HumanGateAuditRecord[]
}

export function apply(ctx: Context, config: HostPluginConfig): void {
  const toolName = config.toolName ?? 'pipeline_run'
  const auditPath = join(config.checkpointRoot, 'human-gate-audit.jsonl')

  /** 用真实 ctx 服务装配一条流水线（每次运行独立 driver，检查点负责续跑）。 */
  const assemble = async (pipelineId: string, agent: Agent, signal: AbortSignal): Promise<Assembled> => {
    const cfg = await loadPipelineConfig(config.configPath)
    const schemas = pipelineContractSchemas()
    const gates = new MachineGateEngine(
      [...platformGenericRules(schemas), ...stageRules({ maxManualClaimedRatio: cfg.releasePolicy.maxManualClaimedRatio })],
      cfg.templateVersion,
    )

    const decisions: HumanGateAuditRecord[] = []
    const human = new UiUserQuestionsHumanGate({
      userQuestions: ctx.userQuestions,
      agent,
      by: agent.id,
      onDecision: (record) => {
        decisions.push(record)
        void appendAudit(auditPath, record).catch((err: unknown) => {
          ctx.logger?.warn?.(`人工门裁决审计写入失败：${String(err)}`)
        })
      },
    })

    const subagents = ctx.subagents as unknown as Pick<SubagentRuntime, 'start'>
    const spawn = new HarnessStageSpawner({
      subagents,
      parent: agent,
      signal,
      ...(config.providerName === undefined ? {} : { providerName: config.providerName }),
    })
    const review = config.enableReview === false
      ? undefined
      : new HarnessReviewRunner({
        subagents,
        parent: agent,
        signal,
        ...(config.providerName === undefined ? {} : { providerName: config.providerName }),
        ...(config.reviewAllowTools === undefined ? {} : { toolFilter: { allow: [...config.reviewAllowTools] } }),
      })

    const driver = new PipelineDriver({
      cfg,
      pipelineId,
      root: join(config.checkpointRoot, pipelineId),
      rulesetVersion: cfg.templateVersion,
      spawn,
      gates,
      human,
      artifacts: new FsArtifactStore(config.artifactsRoot),
      checkpoint: new FsCheckpointPort(),
      ...(config.receiveInput === undefined ? {} : { receiveInput: config.receiveInput }),
      ...(config.executionSessionPath === undefined
        ? {}
        : {
          execution: {
            load: async (stageId: StageId) => {
              if (stageId !== 'execute') return undefined
              try {
                const raw = await readFile(config.executionSessionPath!, 'utf8')
                return JSON.parse(raw) as never
              } catch {
                return undefined
              }
            },
          },
        }),
      ...(review === undefined ? {} : { review }),
    })
    return { driver, decisions }
  }

  // 程序化入口（CLI / 宿主代码）：取当前活体根 agent
  ctx.provide('pipeline', {
    config: config,
    run: async (pipelineId: string): Promise<RunOutcome> => {
      const agent = ctx.agents.roots()[0]
      if (agent === undefined) throw new Error('当前没有活体根会话 agent，无法运行流水线。')
      const { driver } = await assemble(pipelineId, agent, AbortSignal.timeout(config.timeoutMs ?? 120 * 60 * 1000))
      return driver.run()
    },
    reenter: async (pipelineId: string, stageId: StageId, by: string, reason: string): Promise<void> => {
      const agent = ctx.agents.roots()[0]
      if (agent === undefined) throw new Error('当前没有活体根会话 agent，无法重入流水线。')
      const { driver } = await assemble(pipelineId, agent, AbortSignal.timeout(config.timeoutMs ?? 120 * 60 * 1000))
      await driver.reenter(stageId, by, reason)
    },
  })

  // 阶段工具集：阶段 ACL（tool-catalog.ts）用的是**设计文档定义的抽象工具名**
  // （parse_doc / fs_read / fs_write / kb_query / ...），而 tools.restrict() 会校验
  // 所有 filter 名必须存在。宿主不注册这些名字时，阶段子会话直接起不来：
  //   tools.restrict() names unknown global tools "parse_doc", "fs_read", ...
  const executorDir = dirname(config.executionSessionPath ?? join(dirname(config.artifactsRoot), 'executor', 'session.json'))
  registerStageTools(ctx, {
    // 【不变式】baseDir == artifactsRoot == **阶段子会话继承的工作区根**。
    //
    // 检查点把产物路径钉成 `artifacts/<pipelineId>/<stage>.json`（checkpoint.ts 的
    // initialState），FsArtifactStore 以 artifactsRoot 为基准解析这条相对路径。
    //
    // 而阶段子会话带着自己的 cwd（harness 会把工作目录写进它的系统提示），模型会把
    // 提示词里的相对路径**绝对化**为 `<cwd>/artifacts/...` 再调 fs_write，绝对路径被
    // 原样透传。于是三者必须指向同一个根，否则：
    //   - baseDir ≠ artifactsRoot        → 写入点与读取点错开（下方测试双向钉住）
    //   - artifactsRoot ≠ 子会话工作区根 → 模型绝对化后写到别处，driver 报
    //     "stage ... produced no artifact"（已在真实 GUI 宿主实测到）
    //
    // 故 artifactsRoot 应配置为阶段子会话的工作区根（GUI 会话里即会话 cwd）。
    baseDir: config.artifactsRoot,
    artifactsRoot: config.artifactsRoot,
    evidenceDir: config.evidenceDir ?? join(executorDir, 'evidence'),
    sessionPath: config.executionSessionPath ?? join(executorDir, 'session.json'),
    ...(config.targetBaseUrl === undefined ? {} : { targetBaseUrl: config.targetBaseUrl }),
    ...(config.receiveInput === undefined ? {} : { receiveInput: config.receiveInput }),
    checkpointRoot: config.checkpointRoot,
  })

  // 工具调用超时强制（docs：>3 分钟自动中止）——全局钩子，装一次
  applyToolTimeoutPolicy(ctx)

  ctx.tools.register(defineTool({
    name: toolName,
    description:
      'Run or resume the platform pipeline (receive→analyze→design→execute→report→archive) for one pipelineId. '
      + 'Each stage blocks on a real human decision in this session before advancing. '
      + 'Set action="reenter" with stageId + reason to cascade a re-run after an upstream change.',
    parameters: {
      pipelineId: { type: 'string', required: true, description: 'pipeline id (artifact directory name), e.g. e2e-2026' },
      action: { type: 'string', description: 'run (default) | reenter | status' },
      stageId: { type: 'string', description: 'reenter only: stage to re-enter from' },
      reason: { type: 'string', description: 'reenter only: why this re-entry happens' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          outcome: { type: 'string' },
          pipelineId: { type: 'string' },
          humanDecisions: { type: 'number' },
          summary: { type: 'string' },
        },
      },
      render: (_args, value) => textResult(value.summary ?? String(value.outcome ?? '')),
    },
    timeoutMs: config.timeoutMs ?? 120 * 60 * 1000,
    async execute(args, exec) {
      const agent = requireRootAgent(ctx, exec as { readonly agent?: Agent })
      const pipelineId = args.pipelineId
      if (typeof pipelineId !== 'string' || pipelineId.trim() === '') {
        throw new Error('pipelineId 必填。')
      }
      const action = typeof args.action === 'string' ? args.action : 'run'

      // 只读自检：确认插件在本宿主里确实装载、配置可解析、人工门渠道就绪。
      // 不运行流水线、不发起任何问答——用于集成后安全验证（否则一跑就要等真人点 6 次）。
      if (action === 'status') {
        const cfg = await loadPipelineConfig(config.configPath)
        const roots = ctx.agents.roots()
        return {
          outcome: 'status',
          pipelineId,
          humanDecisions: 0,
          summary: [
            `platform-pipeline 已接入本宿主（${HOST_PLUGIN_BUILD}）。`,
            `项目 ${cfg.projectId} / 模板 ${cfg.templateVersion} / 人工门渠道 = ctx.userQuestions 真弹窗（无自动批准）`,
            `产物根 ${config.artifactsRoot}`,
            `需求输入 ${config.receiveInput ?? '（未配置）'}`,
            `当前活体根会话 agent ${roots.length} 个；本次调用归属 ${agent.id}`,
            '调用 pipeline_run（action 省略或 "run"）即开始，六阶段将逐个弹窗等你裁决。',
          ].join('\n'),
        }
      }

      // 阶段提示词指向 schemas/<stage>.schema.json（"以文件为准"），跑之前保证它真在磁盘上
      const schemaFiles = await materializeContractSchemas(config.artifactsRoot)
      console.log(`[platform-pipeline] 已落盘契约 schema ${schemaFiles.length} 份 → ${dirname(schemaFiles[0] ?? config.artifactsRoot)}`)

      const { driver, decisions } = await assemble(pipelineId, agent, exec.signal)

      if (action === 'reenter') {
        const stageId = args.stageId
        if (typeof stageId !== 'string' || stageId.trim() === '') {
          throw new Error('action="reenter" 需要 stageId。')
        }
        await driver.reenter(stageId as StageId, agent.id, typeof args.reason === 'string' ? args.reason : '')
      }

      const outcome = await runWithDiagnostics(
        () => driver.run(),
        pipelineId,
        config.artifactsRoot,
      )
      const outcomeKind = outcome.outcome
      return {
        outcome: outcomeKind,
        pipelineId,
        humanDecisions: decisions.length,
        summary: `流水线 ${pipelineId} 结果：${outcomeKind}；真人裁决 ${decisions.length} 次（审计：${auditPath}）。`,
      }
    },
  }))

  // 装载可见性：日志放在 register 之后 —— 打印出来即证明服务与工具都已注册成功
  // （无脚本跳过的人工门渠道必须能从启动日志确认，否则「装没装上」无从判断）。
  console.log(
    `[platform-pipeline] 已装载：工具 ${toolName}；人工门 = ctx.userQuestions 真弹窗`
    + `（阻塞等真人裁决，无自动批准）；审计 → ${auditPath}`,
  )

  // 落一条装载标记：宿主（GUI/桌面应用）的标准输出通常拿不到，
  // 标记文件是判断「配置热重载是否真的加载了插件」的唯一可靠证据。
  void appendFile(
    join(config.checkpointRoot, 'plugin-loads.jsonl'),
    `${JSON.stringify({ at: Date.now(), pid: process.pid, toolName, note: 'host-plugin loaded' })}\n`,
    'utf8',
  ).catch(() => { /* 标记失败不影响装载 */ })
}