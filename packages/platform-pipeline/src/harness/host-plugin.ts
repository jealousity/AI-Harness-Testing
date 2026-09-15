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

import { appendFile, mkdir, readFile } from 'node:fs/promises'
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
import type { StageId } from '../types.ts'

/** 插件名（cordis 生命周期标识）。 */
export const name = 'platform-pipeline-host'

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
  /** subagent provider 名（默认 'spawn'）。 */
  readonly providerName?: string
  /** 是否启用交叉检查（默认启用）。 */
  readonly enableReview?: boolean
  /** 审核 agent 工具白名单（盲审只读；缺省由宿主决定）。 */
  readonly reviewAllowTools?: readonly string[]
  /** 工具名（默认 'pipeline_run'）。 */
  readonly toolName?: string
  /** 工具与整条流水线的超时（毫秒，默认 30 分钟）。 */
  readonly timeoutMs?: number
}

function textResult(text: string): ContentBlock[] {
  return [{ type: 'text', text }]
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
      const { driver } = await assemble(pipelineId, agent, AbortSignal.timeout(config.timeoutMs ?? 30 * 60 * 1000))
      return driver.run()
    },
    reenter: async (pipelineId: string, stageId: StageId, by: string, reason: string): Promise<void> => {
      const agent = ctx.agents.roots()[0]
      if (agent === undefined) throw new Error('当前没有活体根会话 agent，无法重入流水线。')
      const { driver } = await assemble(pipelineId, agent, AbortSignal.timeout(config.timeoutMs ?? 30 * 60 * 1000))
      await driver.reenter(stageId, by, reason)
    },
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
      action: { type: 'string', description: 'run (default) | reenter' },
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
    timeoutMs: config.timeoutMs ?? 30 * 60 * 1000,
    async execute(args, exec) {
      const agent = requireRootAgent(ctx, exec as { readonly agent?: Agent })
      const pipelineId = args.pipelineId
      if (typeof pipelineId !== 'string' || pipelineId.trim() === '') {
        throw new Error('pipelineId 必填。')
      }
      const action = typeof args.action === 'string' ? args.action : 'run'

      const { driver, decisions } = await assemble(pipelineId, agent, exec.signal)

      if (action === 'reenter') {
        const stageId = args.stageId
        if (typeof stageId !== 'string' || stageId.trim() === '') {
          throw new Error('action="reenter" 需要 stageId。')
        }
        await driver.reenter(stageId as StageId, agent.id, typeof args.reason === 'string' ? args.reason : '')
      }

      const outcome = await driver.run()
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
}