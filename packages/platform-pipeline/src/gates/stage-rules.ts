/**
 * 阶段特定机器门禁规则 R 系列（docs/01 第 4 节）。
 * 需要 artifact + 上游产物（driver 提供传递性上游，R3-01 可读 receive 需求清单）。
 * 执行可信规则 R4-08/09/10 需要 executor 执行数据（记录+证据），由宿主经
 * RuleContext 扩展注入（后续接线）；本模块先实现仅依赖产物/上游的规则。
 * @module platform-pipeline/gates/stage-rules
 */

import type { GateRule, RuleContext } from './machine.ts'
import { reconcile, verifyEvidence } from '../executor/verify.ts'
import { verifyChain } from '../executor/records.ts'
import type { Violation } from '../types.ts'

export interface StageRulesOptions {
  /** R5-06：manual 占比阈值（默认 0.3，docs/08 ET-05）。 */
  readonly maxManualClaimedRatio?: number
}

const at = (): number => Date.now()

function v(rule: string, detail: string): Violation {
  return { rule, level: 'BLOCKING', detail, at: at() }
}

type Content = Record<string, unknown>
type Obj = Record<string, unknown>

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function asObj(value: unknown): Obj {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Obj : {}
}

/** 阶段特定规则（docs/01 R1/R2/R3/R4/R5/R6 中可仅凭产物+上游判定的核心集）。 */
export function stageRules(options: StageRulesOptions = {}): readonly GateRule[] {
  const maxManualClaimedRatio = options.maxManualClaimedRatio ?? 0.3
  return [
    // R1-03 receive：缺失必填字段集合 ≡ clarifications 集合
    {
      id: 'R1-03', level: 'BLOCKING', stages: ['receive'],
      judge: ({ artifact }) => {
        const content = artifact.content as Content
        const missing = new Set<string>()
        const clarified = new Set<string>()
        for (const raw of asArray(content.requirements)) {
          const requirement = asObj(raw)
          const id = String(requirement.id ?? '')
          for (const field of RECEIVE_REQUIRED) {
            const value = requirement[field]
            const absent = value === undefined || (typeof value === 'string' && value === '')
              || (Array.isArray(value) && value.length === 0)
            if (absent) missing.add(`${id}:${field}`)
          }
        }
        for (const raw of asArray(content.clarifications)) {
          const entry = asObj(raw)
          clarified.add(`${String(entry.requirementId ?? '')}:${String(entry.field ?? '')}`)
        }
        const violations: Violation[] = []
        for (const key of missing) {
          if (!clarified.has(key)) violations.push(v('R1-03', `requirement ${key} is missing but has no clarification`))
        }
        for (const key of clarified) {
          if (!missing.has(key)) violations.push(v('R1-03', `clarification ${key} does not correspond to any missing field`))
        }
        return violations
      },
    },

    // R2-03 analyze：versionImpact 每条带依据引用（引用样串，无空白）
    {
      id: 'R2-03', level: 'BLOCKING', stages: ['analyze'],
      judge: ({ artifact }) => {
        const content = artifact.content as Content
        const violations: Violation[] = []
        for (const raw of asArray(content.versionImpact)) {
          const entry = asObj(raw)
          const evidence = String(entry.evidence ?? '')
          if (evidence.trim() === '' || /\s/.test(evidence) || evidence.length < 3) {
            violations.push(v('R2-03', `versionImpact entry "${String(entry.version ?? '')}" evidence must be a reference (got "${evidence}")`))
          }
        }
        return violations
      },
    },

    // R3-01 design：覆盖矩阵完备——每个上游需求点 ≥1 条用例，且矩阵 caseId 存在于 testCases ∪ reusedCases
    {
      id: 'R3-01', level: 'BLOCKING', stages: ['design'],
      judge: ({ artifact, upstreams }) => {
        const content = artifact.content as Content
        const matrix = asObj(content.coverageMatrix)
        const caseIds = new Set<string>([
          ...asArray(content.testCases).map(raw => String(asObj(raw).id ?? '')),
          ...asArray(content.reusedCases).map(raw => String(asObj(raw).id ?? '')),
        ])
        const violations: Violation[] = []
        const upstreamReceive = upstreams.receive
        if (upstreamReceive !== undefined) {
          const requirements = asArray((upstreamReceive.content as Content).requirements)
          for (const raw of requirements) {
            const id = String(asObj(raw).id ?? '')
            const covered = asArray(matrix[id])
            if (covered.length === 0) violations.push(v('R3-01', `requirement "${id}" has no test case in coverageMatrix`))
          }
        }
        for (const [requirementId, rawIds] of Object.entries(matrix)) {
          if (requirementId === '') violations.push(v('R3-01', 'coverageMatrix has an empty requirement key'))
          for (const rawId of asArray(rawIds)) {
            if (!caseIds.has(String(rawId))) {
              violations.push(v('R3-01', `coverageMatrix["${requirementId}"] references unknown case "${String(rawId)}"`))
            }
          }
        }
        return violations
      },
    },

    // R3-02 design：testCases ∪ reusedCases id 唯一
    {
      id: 'R3-02', level: 'BLOCKING', stages: ['design'],
      judge: ({ artifact }) => {
        const content = artifact.content as Content
        const seen = new Set<string>()
        const violations: Violation[] = []
        for (const raw of [...asArray(content.testCases), ...asArray(content.reusedCases)]) {
          const id = String(asObj(raw).id ?? '')
          if (seen.has(id)) violations.push(v('R3-02', `duplicate case id "${id}"`))
          seen.add(id)
        }
        return violations
      },
    },

    // R3-04 design：gaps 自洽——列出的需求点确实是零用例（矩阵未覆盖）
    {
      id: 'R3-04', level: 'BLOCKING', stages: ['design'],
      judge: ({ artifact }) => {
        const content = artifact.content as Content
        const matrix = asObj(content.coverageMatrix)
        const violations: Violation[] = []
        for (const raw of asArray(content.gaps)) {
          const requirementId = String(asObj(raw).requirementId ?? '')
          const covered = asArray(matrix[requirementId])
          if (covered.length > 0) {
            violations.push(v('R3-04', `gaps lists "${requirementId}" but coverageMatrix covers it (${covered.join(', ')})`))
          }
        }
        return violations
      },
    },

    // R3-07 design：reusedCases 的 sourceCaseId 必须来自上游 analyze 的复用建议清单
    {
      id: 'R3-07', level: 'BLOCKING', stages: ['design'],
      judge: ({ artifact, upstreams }) => {
        const content = artifact.content as Content
        const upstreamAnalyze = upstreams.analyze
        if (upstreamAnalyze === undefined) return []
        const suggested = new Set(
          asArray((upstreamAnalyze.content as Content).reuseSuggestions).map(raw => String(asObj(raw).caseId ?? '')),
        )
        const violations: Violation[] = []
        for (const raw of asArray(content.reusedCases)) {
          const sourceCaseId = String(asObj(raw).sourceCaseId ?? '')
          if (sourceCaseId !== '' && suggested.size > 0 && !suggested.has(sourceCaseId)) {
            violations.push(v('R3-07', `reused case "${sourceCaseId}" is not in the confirmed reuse suggestion list`))
          }
        }
        return violations
      },
    },

    // R4-01 execute：results 覆盖上游 design 全部用例 id
    {
      id: 'R4-01', level: 'BLOCKING', stages: ['execute'],
      judge: ({ artifact, upstreams }) => {
        const content = artifact.content as Content
        const upstreamDesign = upstreams.design
        if (upstreamDesign === undefined) return []
        const planned = new Set<string>([
          ...asArray((upstreamDesign.content as Content).testCases).map(raw => String(asObj(raw).id ?? '')),
          ...asArray((upstreamDesign.content as Content).reusedCases).map(raw => String(asObj(raw).id ?? '')),
        ])
        const executed = new Set(asArray(content.results).map(raw => String(asObj(raw).caseId ?? '')))
        const violations: Violation[] = []
        for (const id of planned) {
          if (!executed.has(id)) violations.push(v('R4-01', `planned case "${id}" has no result (缺跑)`))
        }
        for (const id of executed) {
          if (!planned.has(id)) violations.push(v('R4-01', `result for unplanned case "${id}" (多余)`))
        }
        return violations
      },
    },

    // R4-03 execute：results 的 envIssueId 必须存在于 envIssues
    {
      id: 'R4-03', level: 'BLOCKING', stages: ['execute'],
      judge: ({ artifact }) => {
        const content = artifact.content as Content
        const envIssueIds = new Set(asArray(content.envIssues).map(raw => String(asObj(raw).id ?? '')))
        const violations: Violation[] = []
        for (const raw of asArray(content.results)) {
          const result = asObj(raw)
          const envIssueId = result.envIssueId
          if (envIssueId !== undefined && !envIssueIds.has(String(envIssueId))) {
            violations.push(v('R4-03', `result "${String(result.caseId ?? '')}" references unknown envIssue "${String(envIssueId)}"`))
          }
        }
        return violations
      },
    },

    // R4-08 execute：执行-产物对账（防空跑/漏跑/伪造，docs/08 防线 1）
    {
      id: 'R4-08', level: 'BLOCKING', stages: ['execute'],
      judge: ({ artifact, upstreams, execution }) => {
        if (execution === undefined) {
          return [v('R4-08', 'executor execution data not provided — executor 必须真实执行并自产记录')]
        }
        const content = artifact.content as Content
        const upstreamDesign = upstreams.design
        if (upstreamDesign === undefined) return []
        const planned = [
          ...asArray((upstreamDesign.content as Content).testCases).map(raw => String(asObj(raw).id ?? '')),
          ...asArray((upstreamDesign.content as Content).reusedCases).map(raw => String(asObj(raw).id ?? '')),
        ]
        const results = asArray(content.results).map(raw => {
          const result = asObj(raw)
          return { caseId: String(result.caseId ?? ''), recordRef: String(result.recordRef ?? '') }
        })
        const reconciled = reconcile(execution.records, planned, results)
        const violations: Violation[] = []
        for (const id of reconciled.missingRecords) violations.push(v('R4-08', `planned case "${id}" has no executor record (漏跑)`))
        for (const ref of reconciled.phantomResults) violations.push(v('R4-08', `result "${ref}" references no executor record (伪造结果)`))
        for (const seq of reconciled.unclaimedRecords) violations.push(v('R4-08', `executor record seq ${seq} is unreferenced (多余执行)`))
        return violations
      },
    },

    // R4-09 execute：时序链校验（防删改记录，docs/08 防线 2）
    {
      id: 'R4-09', level: 'BLOCKING', stages: ['execute'],
      judge: ({ execution }) => {
        if (execution === undefined) return [v('R4-09', 'executor execution data not provided')]
        return verifyChain(execution.records).map(chain => v('R4-09', chain.detail))
      },
    },

    // R4-10 execute：证据指纹与来源锚定（防虚假产物，docs/08 防线 3）
    {
      id: 'R4-10', level: 'BLOCKING', stages: ['execute'],
      judge: ({ execution }) => {
        if (execution === undefined) return [v('R4-10', 'executor execution data not provided')]
        return verifyEvidence(execution.evidence, execution.records).map(entry => v('R4-10', entry.detail))
      },
    },

    // R5-01 report：stats 数字与源一致（passRate ≈ passed/total；total === passed + failed）
    {
      id: 'R5-01', level: 'BLOCKING', stages: ['report'],
      judge: ({ artifact }) => {
        const content = artifact.content as Content
        const stats = asObj(content.stats)
        const total = Number(stats.total ?? NaN)
        const passed = Number(stats.passed ?? NaN)
        const failed = Number(stats.failed ?? NaN)
        const passRate = Number(stats.passRate ?? NaN)
        const violations: Violation[] = []
        if (!Number.isFinite(total) || !Number.isFinite(passed) || !Number.isFinite(failed)) {
          return [v('R5-01', 'stats total/passed/failed must be numbers')]
        }
        if (total !== passed + failed) {
          violations.push(v('R5-01', `stats inconsistent: total ${total} !== passed ${passed} + failed ${failed}`))
        }
        if (total > 0) {
          const recomputed = passed / total
          if (Math.abs(recomputed - passRate) > 0.001) {
            violations.push(v('R5-01', `passRate ${passRate} != recomputed ${recomputed.toFixed(4)} (LLM 不得自算数字)`))
          }
        }
        return violations
      },
    },

    // R5-06 report：manual-claimed 占比超阈值时不得 approve
    {
      id: 'R5-06', level: 'BLOCKING', stages: ['report'],
      judge: ({ artifact, upstreams }) => {
        const content = artifact.content as Content
        const upstreamExecute = upstreams.execute
        if (upstreamExecute === undefined) return []
        const results = asArray((upstreamExecute.content as Content).results)
        if (results.length === 0) return []
        const manualCount = results.filter(raw => asObj(raw).manualClaimed === true).length
        const ratio = manualCount / results.length
        if (ratio > maxManualClaimedRatio && content.releaseRecommendation === 'approve') {
          return [v('R5-06', `manual-claimed ratio ${ratio.toFixed(2)} exceeds ${maxManualClaimedRatio}; approve is not allowed`)]
        }
        return []
      },
    },

    // R6-02 archive：caseArchive 用例 id 覆盖上游 design 全部用例（版本化回流完整性）
    {
      id: 'R6-02', level: 'BLOCKING', stages: ['archive'],
      judge: ({ artifact, upstreams }) => {
        const content = artifact.content as Content
        const upstreamDesign = upstreams.design
        if (upstreamDesign === undefined) return []
        const planned = new Set<string>([
          ...asArray((upstreamDesign.content as Content).testCases).map(raw => String(asObj(raw).id ?? '')),
          ...asArray((upstreamDesign.content as Content).reusedCases).map(raw => String(asObj(raw).id ?? '')),
        ])
        const archived = new Set(asArray(content.caseArchive).map(raw => String(asObj(raw).caseId ?? '')))
        const violations: Violation[] = []
        for (const id of planned) {
          if (!archived.has(id)) violations.push(v('R6-02', `designed case "${id}" not archived (回流缺失)`))
        }
        return violations
      },
    },
  ]
}

const RECEIVE_REQUIRED = ['background', 'goals', 'changePoints', 'acceptance', 'priority', 'sourceRef']
