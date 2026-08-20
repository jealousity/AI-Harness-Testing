/**
 * 配置解析：pipeline.yaml / pipeline.json → PipelineConfig（docs/02 第 2 节）。
 * 装载时校验 + 填充默认值（默认预算/门/规则/交叉检查 = 02 默认模板）。
 * @module platform-pipeline/config
 */

import { readFile } from 'node:fs/promises'
import YAML from 'yaml'
import {
  STAGE_ORDER,
  type HumanGateConfig,
  type PipelineConfig,
  type ProjectType,
  type ReviewConfig,
  type ScaleTier,
  type StageBudget,
  type StageConfig,
  type StageId,
} from './types.ts'

/** 发布建议信任约束默认值（docs/08 ET-05：默认 0.3）。 */
export const DEFAULT_MAX_MANUAL_CLAIMED_RATIO = 0.3

/** 各阶段默认预算（docs/02 第 3 节默认模板）。 */
const DEFAULT_BUDGET: Readonly<Record<StageId, StageBudget>> = {
  receive: { maxSteps: 20, timeoutMs: 600000, maxRetries: 2 },
  analyze: { maxSteps: 30, timeoutMs: 900000, maxRetries: 2 },
  design: { maxSteps: 40, timeoutMs: 1200000, maxRetries: 2, maxTestCases: 200 },
  execute: { maxSteps: 100, timeoutMs: 0, maxRetries: 2 },
  report: { maxSteps: 20, timeoutMs: 600000, maxRetries: 2 },
  archive: { maxSteps: 20, timeoutMs: 600000, maxRetries: 2 },
}

/** 各阶段默认机器门禁规则引用（docs/01：G 系列通用 + 阶段特定 R 系列）。 */
const DEFAULT_RULES: Readonly<Record<StageId, readonly string[]>> = {
  receive: ['G-01', 'G-02', 'G-03', 'G-04', 'G-05', 'G-06', 'G-07', 'G-08', 'R1-01', 'R1-02', 'R1-03', 'R1-04'],
  analyze: ['G-01', 'G-02', 'G-03', 'G-04', 'G-05', 'G-06', 'G-07', 'G-08', 'R2-01', 'R2-02', 'R2-03', 'R2-04', 'R2-05'],
  design: ['G-01', 'G-02', 'G-03', 'G-04', 'G-05', 'G-06', 'G-07', 'G-08', 'R3-01', 'R3-02', 'R3-03', 'R3-04', 'R3-05', 'R3-06', 'R3-07'],
  execute: ['G-01', 'G-02', 'G-03', 'G-04', 'G-05', 'G-06', 'G-07', 'G-08', 'R4-01', 'R4-02', 'R4-03', 'R4-04', 'R4-05', 'R4-06', 'R4-07', 'R4-08', 'R4-09', 'R4-10', 'R4-11'],
  report: ['G-01', 'G-02', 'G-03', 'G-04', 'G-05', 'G-06', 'G-07', 'G-08', 'R5-01', 'R5-02', 'R5-03', 'R5-04', 'R5-05', 'R5-06'],
  archive: ['G-01', 'G-02', 'G-03', 'G-04', 'G-05', 'G-06', 'G-07', 'G-08', 'R6-01', 'R6-02', 'R6-03', 'R6-04', 'R6-05'],
}

/** 各阶段默认人工门（docs/02 第 5 节 A~G；analyze 双门 B/C）。 */
const DEFAULT_GATES: Readonly<Record<StageId, StageConfig['gate']>> = {
  receive: { human: { id: 'A', block: true } },
  analyze: { human: { id: 'B', block: true }, human2: { id: 'C', block: true } },
  design: { human: { id: 'D', block: true } },
  execute: { human: { id: 'E', block: true } },
  report: { human: { id: 'F', block: true } },
  archive: { human: { id: 'G', block: true } },
}

/** 各阶段默认交叉检查开关（docs/03 第 7.2 节：analyze/design/execute/report 开）。 */
const DEFAULT_REVIEW: Readonly<Record<StageId, ReviewConfig>> = {
  receive: { enabled: false },
  analyze: { enabled: true },
  design: { enabled: true },
  execute: { enabled: true },
  report: { enabled: true },
  archive: { enabled: false },
}

const SCALE_TIERS: readonly ScaleTier[] = ['S', 'M', 'L']
const PROJECT_TYPES: readonly ProjectType[] = ['api-service', 'web-ui', 'desktop-client', 'mixed']

function fail(message: string): never {
  throw new Error(`pipeline config invalid: ${message}`)
}

function asRecord(value: unknown, where: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail(`${where} must be an object`)
  }
  return value as Record<string, unknown>
}

function asString(value: unknown, where: string): string {
  if (typeof value !== 'string' || value.length === 0) fail(`${where} must be a non-empty string`)
  return value
}

function asNumber(value: unknown, where: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    fail(`${where} must be a non-negative safe integer`)
  }
  return value
}

function asBoolean(value: unknown, where: string): boolean {
  if (typeof value !== 'boolean') fail(`${where} must be a boolean`)
  return value
}

/** 展开 "G-01..G-07" / "R4-01..R4-11" 范围记号为显式列表（设计稿 shorthand，docs/02 第 2 节注释）。 */
export function expandRuleList(rules: unknown): string[] {
  if (rules === undefined) return []
  if (!Array.isArray(rules)) fail('rules must be an array of rule ids')
  const out: string[] = []
  for (const entry of rules) {
    if (typeof entry !== 'string') fail('rules entries must be strings')
    const match = /^([A-Z]+\d*)-(\d+)\.\.([A-Z]+\d*)-(\d+)$/.exec(entry)
    if (match === null) {
      out.push(entry)
      continue
    }
    const [, prefixA, startStr, prefixB, endStr] = match
    if (prefixA !== prefixB) fail(`rule range "${entry}" spans different prefixes`)
    const start = Number(startStr)
    const end = Number(endStr)
    if (start > end) fail(`rule range "${entry}" is descending`)
    for (let n = start; n <= end; n++) out.push(`${prefixA}-${String(n).padStart(2, '0')}`)
  }
  return out
}

/**
 * 从原始对象归一化为 PipelineConfig：校验必填 + 填充阶段默认（预算/门/规则/交叉检查）。
 * 阶段必须完整覆盖 STAGE_ORDER（固定六阶段，docs/02 决策）。
 */
export function normalizeConfig(input: unknown): PipelineConfig {
  const raw = asRecord(input, 'root')
  const projectId = asString(raw.projectId, 'projectId')
  const projectType = asString(raw.projectType, 'projectType') as ProjectType
  if (!PROJECT_TYPES.includes(projectType)) fail(`projectType must be one of ${PROJECT_TYPES.join('/')}`)
  const templateVersion = asString(raw.templateVersion, 'templateVersion')
  const scaleTier = asString(raw.scaleTier ?? 'M', 'scaleTier') as ScaleTier
  if (!SCALE_TIERS.includes(scaleTier)) fail(`scaleTier must be one of ${SCALE_TIERS.join('/')}`)

  const releaseRaw = asRecord(raw.releasePolicy ?? {}, 'releasePolicy')
  const maxManualClaimedRatio = releaseRaw.maxManualClaimedRatio === undefined
    ? DEFAULT_MAX_MANUAL_CLAIMED_RATIO
    : (() => {
      const v = releaseRaw.maxManualClaimedRatio
      if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 1) fail('releasePolicy.maxManualClaimedRatio must be a number in [0,1]')
      return v
    })()

  const storesRaw = asRecord(raw.stores, 'stores')
  const stores = {
    knowledge: asRecord(storesRaw.knowledge, 'stores.knowledge') as PipelineConfig['stores']['knowledge'],
    cases: asRecord(storesRaw.cases, 'stores.cases') as PipelineConfig['stores']['cases'],
    requirements: {
      primary: asRecord(
        (asRecord(storesRaw.requirements, 'stores.requirements').primary),
        'stores.requirements.primary',
      ) as PipelineConfig['stores']['requirements']['primary'],
      ...(() => {
        const req = asRecord(storesRaw.requirements, 'stores.requirements')
        return req.fallback === undefined ? {} : { fallback: req.fallback as PipelineConfig['stores']['requirements']['fallback'] }
      })(),
    },
  }

  const stagesRaw = asRecord(raw.stages, 'stages')
  const stages = {} as Record<StageId, StageConfig>
  for (const id of STAGE_ORDER) {
    const stageRaw = stagesRaw[id] === undefined ? {} : asRecord(stagesRaw[id], `stages.${id}`)
    const budgetRaw = asRecord(stageRaw.budget ?? {}, `stages.${id}.budget`)
    const budget: StageBudget = {
      maxSteps: budgetRaw.maxSteps === undefined ? DEFAULT_BUDGET[id].maxSteps : asNumber(budgetRaw.maxSteps, `stages.${id}.budget.maxSteps`),
      timeoutMs: budgetRaw.timeoutMs === undefined ? DEFAULT_BUDGET[id].timeoutMs : asNumber(budgetRaw.timeoutMs, `stages.${id}.budget.timeoutMs`),
      maxRetries: budgetRaw.maxRetries === undefined ? DEFAULT_BUDGET[id].maxRetries : asNumber(budgetRaw.maxRetries, `stages.${id}.budget.maxRetries`),
      ...budgetRaw.maxTestCases === undefined ? {} : { maxTestCases: asNumber(budgetRaw.maxTestCases, `stages.${id}.budget.maxTestCases`) },
    }
    const gateRaw = stageRaw.gate === undefined ? DEFAULT_GATES[id] : asRecord(stageRaw.gate, `stages.${id}.gate`)
    const gateEntries: Record<string, HumanGateConfig> = {}
    for (const [key, value] of Object.entries(gateRaw)) {
      const g = asRecord(value, `stages.${id}.gate.${key}`)
      gateEntries[key] = { id: asString(g.id, `stages.${id}.gate.${key}.id`), block: asBoolean(g.block, `stages.${id}.gate.${key}.block`) }
    }
    const reviewRaw = asRecord(stageRaw.review ?? {}, `stages.${id}.review`)
    const review: ReviewConfig = {
      enabled: reviewRaw.enabled === undefined ? DEFAULT_REVIEW[id].enabled : asBoolean(reviewRaw.enabled, `stages.${id}.review.enabled`),
    }
    const rules = stageRaw.rules === undefined ? DEFAULT_RULES[id] : expandRuleList(stageRaw.rules)
    const tools = stageRaw.tools === undefined ? undefined : (() => {
      const t = asRecord(stageRaw.tools, `stages.${id}.tools`)
      const filter: { allow?: string[]; deny?: string[] } = {}
      if (t.allow !== undefined) {
        if (!Array.isArray(t.allow) || t.allow.some(v => typeof v !== 'string')) fail(`stages.${id}.tools.allow must be string[]`)
        filter.allow = t.allow as string[]
      }
      if (t.deny !== undefined) {
        if (!Array.isArray(t.deny) || t.deny.some(v => typeof v !== 'string')) fail(`stages.${id}.tools.deny must be string[]`)
        filter.deny = t.deny as string[]
      }
      return filter
    })()
    stages[id] = { id, gate: gateEntries, budget, rules, review, ...tools === undefined ? {} : { tools } }
  }

  return {
    projectId,
    projectType,
    templateVersion,
    ...raw.displayName === undefined ? {} : { displayName: asString(raw.displayName, 'displayName') },
    ...raw.executionPolicy === undefined ? {} : { executionPolicy: raw.executionPolicy as PipelineConfig['executionPolicy'] },
    scaleTier,
    releasePolicy: { maxManualClaimedRatio },
    stores,
    stages,
  }
}

/** 从字符串解析配置（yaml 或 json）。 */
export function parsePipelineConfig(raw: string, format: 'yaml' | 'json' = 'json'): PipelineConfig {
  let data: unknown
  try {
    data = format === 'yaml' ? YAML.parse(raw) : JSON.parse(raw)
  } catch (error) {
    throw new Error(`pipeline config parse failed: ${error instanceof Error ? error.message : String(error)}`)
  }
  return normalizeConfig(data)
}

/** 从文件加载配置：扩展名 .yaml/.yml 走 YAML，否则按 JSON。 */
export async function loadPipelineConfig(path: string): Promise<PipelineConfig> {
  const raw = await readFile(path, 'utf8')
  const format: 'yaml' | 'json' = /\.ya?ml$/i.test(path) ? 'yaml' : 'json'
  return parsePipelineConfig(raw, format)
}
