/**
 * platform-pipeline CLI：配置验证 + 检查点状态查看。
 * run/reenter 仍由宿主接线（需要 spawner/human），本 CLI 不伪造无宿主运行能力。
 * @module platform-pipeline/cli
 */

import { loadCheckpoint } from './checkpoint.ts'
import { loadPipelineConfig } from './config.ts'
import { validatePipelineAcl } from './acl.ts'
import { MachineGateEngine, platformGenericRules } from './gates/machine.ts'
import { stageRules } from './gates/stage-rules.ts'
import { pipelineContractSchemas } from './contracts/schemas.ts'
import { STAGE_ORDER } from './types.ts'

function argValue(args: readonly string[], flag: string): string | undefined {
  const index = args.indexOf(flag)
  return index >= 0 ? args[index + 1] : undefined
}

function requireArg(args: readonly string[], flag: string): string {
  const value = argValue(args, flag)
  if (value === undefined || value.trim() === '') throw new Error(`${flag} 必填`)
  return value
}

async function validate(configPath: string): Promise<void> {
  const cfg = await loadPipelineConfig(configPath)
  const gates = new MachineGateEngine(
    [...platformGenericRules(pipelineContractSchemas()), ...stageRules({ maxManualClaimedRatio: cfg.releasePolicy.maxManualClaimedRatio })],
    cfg.templateVersion,
  )
  const missingRules = STAGE_ORDER.flatMap(id => gates.validateRuleIds(cfg.stages[id]!.rules).map(rule => `${id}:${rule}`))
  if (missingRules.length > 0) throw new Error(`配置引用未实现规则：${missingRules.join(', ')}`)
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

async function status(args: readonly string[]): Promise<void> {
  const checkpointRoot = requireArg(args, '--checkpoint-root')
  const pipelineId = requireArg(args, '--pipeline-id')
  const checkpoint = await loadCheckpoint(`${checkpointRoot}/${pipelineId}`)
  if (checkpoint === null) {
    console.log(JSON.stringify({ pipelineId, status: 'not-found' }, null, 2))
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
  console.log(JSON.stringify({
    pipelineId: checkpoint.pipelineId,
    cursor: checkpoint.cursor,
    nextStage: STAGE_ORDER[checkpoint.cursor] ?? null,
    templateVersion: checkpoint.templateVersion,
    rulesetVersion: checkpoint.rulesetVersion,
    reentries: checkpoint.reentries.length,
    stages,
  }, null, 2))
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const command = args[0]
  if (command === 'validate') {
    await validate(requireArg(args, '--config'))
    return
  }
  if (command === 'status') {
    await status(args)
    return
  }
  if (command === 'run' || command === 'reenter') {
    throw new Error(`${command} 需要宿主注入 spawner/human；请通过宿主的 pipeline_run 接线执行。`)
  }
  throw new Error('用法：node src/cli.ts validate --config <pipeline.yaml> 或 status --checkpoint-root <dir> --pipeline-id <id>')
}

void main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
