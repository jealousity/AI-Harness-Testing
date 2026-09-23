/**
 * platform-pipeline CLI。
 *
 * 两条通道：
 * - **无 Harness 运行通道**：`run` / `reenter` / `gate-*` 由本 CLI 自己装配宿主
 *   （`createPlatformHost`），不再要求外部注入 spawner/human。
 * - **只读检查通道**：`validate` / `status` / `knowledge-import`，不需要 API Key。
 *
 * 人工门是**挂起式**的：`run` 遇到门且 `--wait-ms` 内无人裁决时打印待办并退出（退出码 3），
 * 裁决后再执行一次 `run` 即从该门续跑（产物不重生成、审核不重跑）。
 *
 * @module platform-pipeline/cli
 */

import { join } from 'node:path'

import { loadCheckpoint } from './checkpoint.ts'
import { loadPipelineConfig } from './config.ts'
import { validatePipelineAcl } from './acl.ts'
import { STAGE_ORDER, type StageId } from './types.ts'
import { ingestKnowledgeFile } from './knowledge-import.ts'
import { MarkdownKnowledgeStore } from './stores/markdown.ts'
import { resolvePlatformRoots } from './platform-roots.ts'
import {
  buildGateEngine,
  createCheckpointHost,
  createPlatformHost,
  gateTaskStoreDir,
  type PlatformHost,
} from './runtime/platform-host.ts'
import { FileHumanGateTaskStore, type HumanGateTask, type HumanGateTaskStatus } from './runtime/persistence.ts'
import { HumanGateWaitAbortedError } from './runtime/persistent-human-gate.ts'

/** 退出码：0 完成 / 1 错误 / 3 停在人工门等裁决。 */
const EXIT_WAITING_HUMAN = 3

const GATE_ACTIONS = ['approved', 'changes-needed', 'rejected'] as const
const GATE_STATUSES = ['pending', 'claimed', 'approved', 'changes-needed', 'rejected', 'expired', 'cancelled'] as const

function argValue(args: readonly string[], flag: string): string | undefined {
  const index = args.indexOf(flag)
  return index >= 0 ? args[index + 1] : undefined
}

function requireArg(args: readonly string[], flag: string): string {
  const value = argValue(args, flag)
  if (value === undefined || value.trim() === '') throw new Error(`${flag} 必填`)
  return value
}

function optionalInteger(args: readonly string[], flag: string): number | undefined {
  const raw = argValue(args, flag)
  if (raw === undefined) return undefined
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${flag} 必须是非负整数`)
  return value
}

function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2))
}

// ── 只读检查通道 ────────────────────────────────────────────────────────────

async function validate(configPath: string): Promise<void> {
  const cfg = await loadPipelineConfig(configPath)
  buildGateEngine(cfg)
  console.log(`config OK: ${cfg.projectId} (${cfg.projectType}, scale ${cfg.scaleTier}, template ${cfg.templateVersion})`)
  for (const id of STAGE_ORDER) {
    const stage = cfg.stages[id]!
    const gatesForStage = Object.values(stage.gate).map(gate => gate.id).join(',')
    console.log(`  ${id}: gates=[${gatesForStage}] rules=${stage.rules.length} review=${stage.review.enabled} budget.steps=${stage.budget.maxSteps}`)
  }
  const acl = validatePipelineAcl(cfg)
  if (!acl.ok) {
    console.error('ACL invalid:')
    for (const error of acl.errors) console.error(`  - ${error}`)
    process.exitCode = 1
    return
  }
  console.log('ACL: valid（平台标准 + 项目 delta）')
  console.log(`Rules: valid (${STAGE_ORDER.reduce((sum, id) => sum + cfg.stages[id]!.rules.length, 0)} configured references)`)
}

async function importKnowledge(args: readonly string[]): Promise<void> {
  const input = requireArg(args, '--input')
  const storePath = requireArg(args, '--store')
  const project = requireArg(args, '--project')
  const result = await ingestKnowledgeFile(new MarkdownKnowledgeStore(storePath), input, {
    project,
    ...(argValue(args, '--source-pipeline') === undefined ? {} : { sourcePipeline: argValue(args, '--source-pipeline') }),
    ...(argValue(args, '--version') === undefined ? {} : { version: argValue(args, '--version') }),
  })
  printJson({ format: result.format, sourceRef: result.sourceRef, imported: result.entries.map(entry => ({ id: entry.id, title: entry.title, status: entry.status, sourceRefs: entry.sourceRefs })) })
}

/** 解析检查点目录：`--checkpoint-root` 优先，否则由 `--config` + `--data-root` 推导。 */
async function checkpointDirOf(args: readonly string[]): Promise<string> {
  const pipelineId = requireArg(args, '--pipeline-id')
  const explicit = argValue(args, '--checkpoint-root')
  if (explicit !== undefined) return join(explicit, pipelineId)
  const cfg = await loadPipelineConfig(requireArg(args, '--config'))
  const roots = resolvePlatformRoots(requireArg(args, '--data-root'), cfg)
  return join(roots.checkpointRoot, pipelineId)
}

async function status(args: readonly string[]): Promise<void> {
  const pipelineId = requireArg(args, '--pipeline-id')
  const checkpoint = await loadCheckpoint(await checkpointDirOf(args))
  if (checkpoint === null) {
    printJson({ pipelineId, status: 'not-found' })
    return
  }
  const stages = Object.fromEntries(STAGE_ORDER.map(id => {
    const state = checkpoint.stageStates[id]!
    return [id, {
      status: state.status,
      digest: state.digest,
      machine: state.gate.machine.status,
      attempts: state.gate.machine.attempts,
      human: state.gate.human.state,
      reviewDegraded: state.reviewDegraded,
    }]
  }))
  printJson({
    pipelineId: checkpoint.pipelineId,
    cursor: checkpoint.cursor,
    nextStage: STAGE_ORDER[checkpoint.cursor] ?? null,
    templateVersion: checkpoint.templateVersion,
    rulesetVersion: checkpoint.rulesetVersion,
    reentries: checkpoint.reentries.length,
    stages,
  })
}

// ── 无 Harness 运行通道 ─────────────────────────────────────────────────────

/** 用 CLI 参数装配无 Harness 宿主。 */
async function openHost(args: readonly string[], hooks: {
  readonly gateWaitTimeoutMs: number
  readonly pending: HumanGateTask[]
}): Promise<PlatformHost> {
  const cfg = await loadPipelineConfig(requireArg(args, '--config'))
  const providerName = argValue(args, '--provider')
  const rulesetVersion = argValue(args, '--ruleset-version')
  const maxGateRetries = optionalInteger(args, '--max-gate-retries')
  const receiveInput = argValue(args, '--input')
  // execute 阶段的 executor_run 需要真实被测服务基址；缺省时该工具拒绝执行（不伪造记录）。
  const targetBaseUrl = argValue(args, '--target-base-url')
  // env_diag 的固定探针白名单：只允许探测显式声明的环境变量，模型不能自行指定目标。
  const diagCredentials = (argValue(args, '--diag-credential') ?? '')
    .split(',').map(value => value.trim()).filter(value => value !== '')
  return createPlatformHost({
    config: cfg,
    dataRoot: requireArg(args, '--data-root'),
    pipelineId: requireArg(args, '--pipeline-id'),
    gateWaitTimeoutMs: hooks.gateWaitTimeoutMs,
    onGatePending: (task) => { hooks.pending.push(task) },
    ...(providerName === undefined ? {} : { providerName }),
    ...(rulesetVersion === undefined ? {} : { rulesetVersion }),
    ...(maxGateRetries === undefined ? {} : { maxGateRetries }),
    ...(receiveInput === undefined ? {} : { receiveInput }),
    ...(targetBaseUrl === undefined ? {} : { targetBaseUrl }),
    ...(diagCredentials.length === 0
      ? {}
      : { diagProbes: diagCredentials.map(target => ({ kind: 'credentials' as const, target })) }),
  })
}

function summarizeGateTask(task: HumanGateTask): Record<string, unknown> {
  return {
    gateTaskId: task.gateTaskId,
    stageId: task.stageId,
    status: task.status,
    artifactPath: task.artifactPath,
    machineStatus: task.machineStatus,
    machineViolations: task.machineViolations.map(v => `[${v.level}] ${v.rule}: ${v.detail}`),
    review: task.review === undefined ? null : { verdict: task.review.verdict, findings: task.review.findings },
    claimedBy: task.claimedBy ?? null,
    decision: task.decision ?? null,
    cancellation: task.cancellation ?? null,
    expiresAt: task.expiresAt === undefined ? null : new Date(task.expiresAt).toISOString(),
  }
}

async function run(args: readonly string[]): Promise<void> {
  const pipelineId = requireArg(args, '--pipeline-id')
  const configPath = requireArg(args, '--config')
  const dataRoot = requireArg(args, '--data-root')
  // 默认 0 = 只轮询一次就让出控制权（CLI 的挂起模式）；--wait-ms 可改为阻塞等待。
  const pending: HumanGateTask[] = []
  const host = await openHost(args, { gateWaitTimeoutMs: optionalInteger(args, '--wait-ms') ?? 0, pending })

  try {
    const outcome = await host.driver.run()
    printJson({
      outcome: outcome.outcome,
      ...('stageId' in outcome ? { stageId: outcome.stageId } : {}),
      checkpointRoot: host.checkpointRoot,
    })
  } catch (error) {
    if (error instanceof HumanGateWaitAbortedError && error.reason === 'timeout') {
      const open = await host.gateTasks.list({ pipelineId, status: 'pending' })
      printJson({
        outcome: 'waiting-human',
        stageId: error.stageId,
        gateTaskId: error.gateTaskId,
        checkpointRoot: host.checkpointRoot,
        hint: `裁决后重新执行 run 即从该门续跑；查看待办：node src/cli.ts gate-list --config ${configPath} --data-root ${dataRoot}`,
        pending: open.map(summarizeGateTask),
      })
      process.exitCode = EXIT_WAITING_HUMAN
      return
    }
    throw error
  }
}

async function reenter(args: readonly string[]): Promise<void> {
  const stageId = requireArg(args, '--stage') as StageId
  if (!STAGE_ORDER.includes(stageId)) throw new Error(`--stage 必须是 ${STAGE_ORDER.join(' | ')}`)
  // 只动检查点，不解析 provider：没有 API Key 的运维同学也要能登记重入。
  const host = createCheckpointHost({
    config: await loadPipelineConfig(requireArg(args, '--config')),
    dataRoot: requireArg(args, '--data-root'),
    pipelineId: requireArg(args, '--pipeline-id'),
    ...(argValue(args, '--ruleset-version') === undefined ? {} : { rulesetVersion: argValue(args, '--ruleset-version') }),
  })
  const checkpoint = await host.driver.reenter(stageId, requireArg(args, '--by'), requireArg(args, '--reason'))
  printJson({
    pipelineId: checkpoint.pipelineId,
    cursor: checkpoint.cursor,
    nextStage: STAGE_ORDER[checkpoint.cursor] ?? null,
    reentries: checkpoint.reentries.length,
    hint: '重入已登记；执行 run 即级联重跑该阶段及全部下游。',
  })
}

/** 解析人工门任务存储：`--gate-root` 直连，否则由 `--config` + `--data-root` 推导。 */
async function openGateStore(args: readonly string[]): Promise<FileHumanGateTaskStore> {
  const explicit = argValue(args, '--gate-root')
  if (explicit !== undefined) return new FileHumanGateTaskStore(explicit)
  const cfg = await loadPipelineConfig(requireArg(args, '--config'))
  const roots = resolvePlatformRoots(requireArg(args, '--data-root'), cfg)
  return new FileHumanGateTaskStore(gateTaskStoreDir(roots.projectRoot))
}

async function gateList(args: readonly string[]): Promise<void> {
  const store = await openGateStore(args)
  const status = argValue(args, '--status')
  if (status !== undefined && !GATE_STATUSES.includes(status as HumanGateTaskStatus)) {
    throw new Error(`--status 必须是 ${GATE_STATUSES.join(' | ')}`)
  }
  // 显式 --sweep 才改写状态：list 默认只读，不偷偷把过期任务落盘。
  const swept = args.includes('--sweep') ? (await store.expire()).length : 0
  const pipelineId = argValue(args, '--pipeline-id')
  const tasks = await store.list({
    ...(pipelineId === undefined ? {} : { pipelineId }),
    ...(status === undefined ? {} : { status: status as HumanGateTaskStatus }),
  })
  printJson({ count: tasks.length, swept, tasks: tasks.map(summarizeGateTask) })
}

async function gateClaim(args: readonly string[]): Promise<void> {
  const store = await openGateStore(args)
  const claimed = await store.claim(requireArg(args, '--task'), requireArg(args, '--actor'), optionalInteger(args, '--ttl-ms') ?? 300_000)
  printJson(summarizeGateTask(claimed))
}

async function gateDecide(args: readonly string[]): Promise<void> {
  const store = await openGateStore(args)
  const taskId = requireArg(args, '--task')
  const actor = requireArg(args, '--actor')
  const action = requireArg(args, '--action')
  if (!GATE_ACTIONS.includes(action as typeof GATE_ACTIONS[number])) {
    throw new Error(`--action 必须是 ${GATE_ACTIONS.join(' | ')}`)
  }
  // decide 要求当前持有 claim，因此先以同一 actor 认领（TTL 只覆盖本次操作）。
  await store.claim(taskId, actor, optionalInteger(args, '--ttl-ms') ?? 300_000)
  const decided = await store.decide(taskId, actor, action as typeof GATE_ACTIONS[number], argValue(args, '--note') ?? '')
  printJson(summarizeGateTask(decided))
}

async function gateCancel(args: readonly string[]): Promise<void> {
  const store = await openGateStore(args)
  if (store.cancel === undefined) throw new Error('当前门存储不支持 cancel')
  const cancelled = await store.cancel(requireArg(args, '--task'), requireArg(args, '--actor'), argValue(args, '--note') ?? '')
  printJson(summarizeGateTask(cancelled))
}

const USAGE = [
  '用法：',
  '  node src/cli.ts validate --config <pipeline.yaml>',
  '  node src/cli.ts run --config <pipeline.yaml> --data-root <dir> --pipeline-id <id> [--input <file>] [--wait-ms <n>] [--provider <name>] [--target-base-url <url>] [--diag-credential <ENV_VAR,...>]',
  '  node src/cli.ts status --config <pipeline.yaml> --data-root <dir> --pipeline-id <id>',
  '  node src/cli.ts status --checkpoint-root <dir> --pipeline-id <id>',
  '  node src/cli.ts reenter --config <pipeline.yaml> --data-root <dir> --pipeline-id <id> --stage <id> --by <actor> --reason <text>',
  '  node src/cli.ts gate-list --config <pipeline.yaml> --data-root <dir> [--pipeline-id <id>] [--status <s>] [--sweep]',
  '  node src/cli.ts gate-claim --config <pipeline.yaml> --data-root <dir> --task <id> --actor <actor> [--ttl-ms <n>]',
  '  node src/cli.ts gate-decide --config <pipeline.yaml> --data-root <dir> --task <id> --actor <actor> --action approved|changes-needed|rejected [--note <text>]',
  '  node src/cli.ts gate-cancel --config <pipeline.yaml> --data-root <dir> --task <id> --actor <actor> [--note <text>]',
  '  node src/cli.ts knowledge-import --input <doc.md|table.csv> --store <knowledge-dir> --project <projectId>',
  '（gate-* 也可用 --gate-root <dir> 直连任务目录，无需加载配置）',
].join('\n')

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const command = args[0]
  if (command === 'validate') { await validate(requireArg(args, '--config')); return }
  if (command === 'status') { await status(args); return }
  if (command === 'run') { await run(args); return }
  if (command === 'reenter') { await reenter(args); return }
  if (command === 'gate-list') { await gateList(args); return }
  if (command === 'gate-claim') { await gateClaim(args); return }
  if (command === 'gate-decide') { await gateDecide(args); return }
  if (command === 'gate-cancel') { await gateCancel(args); return }
  if (command === 'knowledge-import') { await importKnowledge(args); return }
  throw new Error(USAGE)
}

void main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
