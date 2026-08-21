/**
 * platform-pipeline CLI（I-3：宿主 CLI 子命令的前置——先提供本包自检命令）。
 * 当前：validate（加载 pipeline.yaml + ACL 校验 + 规则展开 + 阶段概览）；
 * run/reenter 需宿主注入 spawner/human（见 src/plugin.ts 集成点），宿主接线后由
 * `dsh pipeline run` 调用（I-3）。
 * @module platform-pipeline/cli
 */

import { loadPipelineConfig } from './config.ts'
import { validatePipelineAcl } from './acl.ts'
import { STAGE_ORDER } from './types.ts'

function argValue(args: readonly string[], flag: string): string | undefined {
  const index = args.indexOf(flag)
  return index >= 0 ? args[index + 1] : undefined
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const command = args[0]
  const configPath = argValue(args, '--config')

  if (command === 'validate' && configPath !== undefined) {
    const cfg = await loadPipelineConfig(configPath)
    console.log(`config OK: ${cfg.projectId} (${cfg.projectType}, scale ${cfg.scaleTier}, template ${cfg.templateVersion})`)
    for (const id of STAGE_ORDER) {
      const stage = cfg.stages[id]!
      const gates = Object.values(stage.gate).map(g => g.id).join(',')
      console.log(`  ${id}: gates=[${gates}] rules=${stage.rules.length} review=${stage.review.enabled} budget.steps=${stage.budget.maxSteps}`)
    }
    const acl = validatePipelineAcl(cfg)
    if (!acl.ok) {
      console.error('ACL invalid:')
      for (const error of acl.errors) console.error(`  - ${error}`)
      process.exit(1)
    }
    console.log('ACL: valid（平台标准 + 项目 delta）')
    return
  }

  if (command === 'run' || command === 'reenter') {
    console.error(`${command} 需要宿主注入 spawner/human（见 docs/09 验证点 4~5 与 src/plugin.ts 集成点）；`
      + '宿主接线后由 `dsh pipeline run` 调用（I-3）。当前仅支持 validate。')
    process.exit(1)
  }

  console.error('用法: node src/cli.ts validate --config <pipeline.yaml>')
  process.exit(1)
}

void main()
