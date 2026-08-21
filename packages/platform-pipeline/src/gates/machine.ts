/**
 * 机器门禁引擎（docs/01）：规则表驱动，全量重判，判定留痕。
 * 本模块实现平台标准通用规则 G-01~G-08；阶段特定 R 系列规则由宿主按规则表注册
 * （同一 judge 管道，同一留痕格式）。
 * @module platform-pipeline/gates/machine
 */

import { createHash } from 'node:crypto'
import { validateSubset, type SubsetSchema } from './schema.ts'
import type { ExecutionSession } from '../executor/executor.ts'
import type { StageArtifact, StageId, Violation } from '../types.ts'

/** 规则判定上下文：产物 + 上游产物 + （execute 阶段）executor 执行数据。 */
export interface RuleContext {
  readonly stageId: StageId
  readonly artifact: StageArtifact
  /** 上游产物（传递性：当前阶段之前全部产物，由 driver 组装）。 */
  readonly upstreams: Readonly<Record<string, StageArtifact>>
  /** executor 自产执行数据（R4-08/09/10 用；execute 阶段必须提供）。 */
  readonly execution?: ExecutionSession
}

export interface GateRule {
  readonly id: string
  readonly level: 'BLOCKING' | 'WARNING'
  /** 'all' = 全部阶段（G 系列）；阶段列表 = 特定阶段（R 系列）。 */
  readonly stages: 'all' | readonly StageId[]
  readonly judge: (ctx: RuleContext) => readonly Violation[]
}

export interface JudgeResult {
  readonly status: 'passed' | 'failed'
  readonly violations: readonly Violation[]
}

/** 计算产物 digest（内容 + 摘要锁的 sha256；G-04）。 */
export function computeArtifactDigest(artifact: Pick<StageArtifact, 'content' | 'inputs' | 'pipelineId' | 'stageId' | 'version'>): string {
  const payload = JSON.stringify({
    pipelineId: artifact.pipelineId,
    stageId: artifact.stageId,
    version: artifact.version,
    inputs: artifact.inputs,
    content: artifact.content,
  })
  return createHash('sha256').update(payload).digest('hex')
}

const PLACEHOLDER_RE = /TODO|待补充|同上|TBD|\.\.\./i
const EVIDENCE_KEY_RE = /evidence|diagnosis/i

/** 内部引用键白名单（G-07 只查产物内部可解析的引用；sourceRef/recordRef 是外部引用不查）。 */
const INTERNAL_REF_KEYS = new Set(['caseId', 'requirementId', 'related', 'coverageRef'])

/** 遍历产物，收集 id 集合与内部引用（collectRefs=false 时只收 id，用于上游产物）。 */
function collectIdsAndRefs(
  value: unknown,
  key: string | undefined,
  ids: Set<string>,
  refs: Array<{ ref: string; path: string }>,
  path: string,
  collectRefs = true,
): void {
  if (typeof value === 'string') {
    if (key === 'id' || key === 'sourceCaseId') ids.add(value)
    else if (collectRefs && key !== undefined && INTERNAL_REF_KEYS.has(key)) refs.push({ ref: value, path })
    return
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => collectIdsAndRefs(item, key, ids, refs, `${path}[${index}]`, collectRefs))
    return
  }
  if (value !== null && typeof value === 'object') {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      collectIdsAndRefs(v, k, ids, refs, `${path}.${k}`, collectRefs)
    }
  }
}

/** 平台标准通用规则 G-01~G-08（docs/01 第 3 节；不可删、不可降级）。 */
export function platformGenericRules(schemaByStage: Readonly<Partial<Record<StageId, SubsetSchema>>>): readonly GateRule[] {
  return [
    {
      id: 'G-01',
      level: 'BLOCKING',
      stages: 'all',
      judge: ({ stageId, artifact }) => {
        const schema = schemaByStage[stageId]
        if (schema === undefined) return [] // 未声明契约的部署由宿主保证 schema 表完整
        return validateSubset(artifact.content, schema).map(detail => ({ rule: 'G-01', level: 'BLOCKING' as const, detail, at: Date.now() }))
      },
    },
    {
      id: 'G-02',
      level: 'BLOCKING',
      stages: 'all',
      judge: ({ stageId, artifact }) => {
        const schema = schemaByStage[stageId]
        if (schema === undefined) return [] // 未声明契约的部署由宿主保证 schema 表完整
        const violations: Violation[] = []
        // 递归：按 schema 的 required 检查空值（必填字符串非空；必填数组按 minItems）
        const check = (value: unknown, sub: SubsetSchema, path: string): void => {
          if (sub.type === 'object' && value !== null && typeof value === 'object' && !Array.isArray(value)) {
            const obj = value as Record<string, unknown>
            for (const key of sub.required ?? []) {
              const v = obj[key]
              if (v === undefined) continue // 缺失由 G-01 报告
              if (typeof v === 'string' && v === '') {
                violations.push({ rule: 'G-02', level: 'BLOCKING', detail: `${path}.${key}: required string is empty`, at: Date.now() })
              } else if (Array.isArray(v) && (sub.properties?.[key]?.minItems ?? 0) > 0 && v.length === 0) {
                violations.push({ rule: 'G-02', level: 'BLOCKING', detail: `${path}.${key}: required array is empty`, at: Date.now() })
              }
            }
            for (const [key, subSub] of Object.entries(sub.properties ?? {})) {
              if (key in obj) check(obj[key], subSub, `${path}.${key}`)
            }
          } else if (sub.type === 'array' && Array.isArray(value) && sub.items !== undefined) {
            value.forEach((item, i) => check(item, sub.items as SubsetSchema, `${path}[${i}]`))
          }
        }
        check(artifact.content, schema, '$')
        return violations
      },
    },
    {
      id: 'G-03',
      level: 'BLOCKING',
      stages: 'all',
      judge: ({ artifact }) => {
        const violations: Violation[] = []
        const walk = (value: unknown, key: string | undefined, path: string): void => {
          if (Array.isArray(value)) {
            if (key !== undefined && EVIDENCE_KEY_RE.test(key) && value.length === 0) {
              violations.push({ rule: 'G-03', level: 'BLOCKING', detail: `${path}: evidence field is empty`, at: Date.now() })
            }
            value.forEach((item, i) => walk(item, key, `${path}[${i}]`))
            return
          }
          if (value !== null && typeof value === 'object') {
            for (const [k, v] of Object.entries(value as Record<string, unknown>)) walk(v, k, `${path}.${k}`)
          }
        }
        walk(artifact.content, undefined, '$')
        return violations
      },
    },
    {
      id: 'G-04',
      level: 'BLOCKING',
      stages: 'all',
      judge: ({ artifact }) => {
        const expected = computeArtifactDigest(artifact)
        if (artifact.digest !== expected) {
          return [{ rule: 'G-04', level: 'BLOCKING', detail: `digest mismatch: declared ${artifact.digest}, recomputed ${expected}`, at: Date.now() }]
        }
        return []
      },
    },
    {
      id: 'G-05',
      level: 'WARNING',
      stages: 'all',
      judge: ({ artifact }) => {
        const budget = (artifact.content as Record<string, unknown>).budgetExceeded
        if (budget === undefined) return []
        if (typeof budget !== 'boolean') {
          return [{ rule: 'G-05', level: 'BLOCKING', detail: 'budgetExceeded must be a boolean', at: Date.now() }]
        }
        return budget
          ? [{ rule: 'G-05', level: 'WARNING', detail: 'stage reported budgetExceeded: true — 人工门应关注未完成原因', at: Date.now() }]
          : []
      },
    },
    {
      id: 'G-06',
      level: 'BLOCKING',
      stages: 'all',
      judge: ({ artifact }) => {
        const violations: Violation[] = []
        const walk = (value: unknown, path: string): void => {
          if (typeof value === 'string') {
            if (PLACEHOLDER_RE.test(value)) {
              violations.push({ rule: 'G-06', level: 'BLOCKING', detail: `${path}: contains placeholder`, at: Date.now() })
            }
            return
          }
          if (Array.isArray(value)) value.forEach((item, i) => walk(item, `${path}[${i}]`))
          else if (value !== null && typeof value === 'object') {
            for (const [k, v] of Object.entries(value as Record<string, unknown>)) walk(v, `${path}.${k}`)
          }
        }
        walk(artifact.content, '$')
        return violations
      },
    },
    {
      id: 'G-07',
      level: 'BLOCKING',
      stages: 'all',
      judge: ({ artifact, upstreams }) => {
        const ids = new Set<string>()
        const refs: Array<{ ref: string; path: string }> = []
        collectIdsAndRefs(artifact.content, undefined, ids, refs, '$')
        // 上游产物的 id 也纳入解析（如 design 的 coverageRef 引用上游 receive 的需求 id）
        for (const upstream of Object.values(upstreams)) {
          collectIdsAndRefs(upstream.content, undefined, ids, refs, `upstream:${upstream.stageId}`, false)
        }
        if (ids.size === 0) return []
        const violations: Violation[] = []
        for (const { ref, path } of refs) {
          if (!ids.has(ref)) violations.push({ rule: 'G-07', level: 'BLOCKING', detail: `${path}: ref "${ref}" does not resolve within the artifact or its upstreams`, at: Date.now() })
        }
        return violations
      },
    },
    {
      id: 'G-08',
      level: 'BLOCKING',
      stages: 'all',
      judge: ({ artifact, upstreams }) => {
        const violations: Violation[] = []
        for (const [upstream, expected] of Object.entries(artifact.inputs)) {
          const actual = upstreams[upstream]?.digest
          if (actual === undefined) {
            violations.push({ rule: 'G-08', level: 'BLOCKING', detail: `upstream "${upstream}" not provided to gate`, at: Date.now() })
          } else if (actual !== expected) {
            violations.push({
              rule: 'G-08', level: 'BLOCKING',
              detail: `upstream "${upstream}" changed (${expected} → ${actual}); this artifact is stale`,
              at: Date.now(),
            })
          }
        }
        return violations
      },
    },
  ]
}

/** 机器门禁引擎：规则表驱动，全量重判（docs/01 第 4/6 节）。 */
export class MachineGateEngine {
  private readonly rules: readonly GateRule[]
  private readonly rulesetVersion: string

  constructor(rules: readonly GateRule[], rulesetVersion: string) {
    this.rules = rules
    this.rulesetVersion = rulesetVersion
  }

  /** 全量重判（不增量）；留痕由 driver 写入检查点。 */
  judge(
    stageId: StageId,
    artifact: StageArtifact,
    upstreams: Readonly<Record<string, StageArtifact>>,
    attempts: number,
    execution?: ExecutionSession,
  ): JudgeResult {
    const violations: Violation[] = []
    for (const rule of this.rules) {
      if (rule.stages !== 'all' && !rule.stages.includes(stageId)) continue
      violations.push(...rule.judge({ stageId, artifact, upstreams, ...(execution === undefined ? {} : { execution }) }))
    }
    const status = violations.some(v => v.level === 'BLOCKING') ? 'failed' : 'passed'
    return { status, violations }
  }

  /** 规则集版本（判定留痕，docs/01 第 6 节 / D-03 独立版本化）。 */
  version(): string {
    return this.rulesetVersion
  }
}
