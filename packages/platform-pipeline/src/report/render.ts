/**
 * 报告渲染器（docs/02 第 12 节）：report.json → 人读 markdown 报告。
 * 确定性代码渲染（D-08：mainAgent/宿主代码执行，report agent 只出 report.json）。
 * 六段固定章节；空章节显式写"无"而非省略。
 * @module platform-pipeline/report/render
 */

export interface PriorityBucket {
  readonly total: number
  readonly passed: number
}

export interface SourceBucket {
  readonly total: number
  readonly passed: number
  readonly passRate: number
}

export interface ReportStats {
  readonly total: number
  readonly passed: number
  readonly failed: number
  readonly passRate: number
  readonly byPriority: Readonly<Record<string, PriorityBucket>>
  readonly byModule: Readonly<Record<string, PriorityBucket>>
  readonly bySource: {
    readonly new: SourceBucket
    readonly reused: SourceBucket
  }
}

export type DefectClassification = 'defect' | 'case-issue' | 'env-issue' | 'suspected'
export type DefectSeverity = 'critical' | 'major' | 'minor'

export interface DefectAnalysisEntry {
  readonly caseId: string
  readonly defect: string
  readonly severity: DefectSeverity
  readonly evidence: readonly string[]
  readonly classification: DefectClassification
}

export interface RiskEntry {
  readonly risk: string
  readonly level: 'high' | 'medium' | 'low'
  readonly evidence: string
}

export interface EvidenceIndexEntry {
  readonly id: string
  readonly file: string
  readonly digest: string
}

export interface ReportContent {
  readonly pipelineId: string
  readonly project: string
  readonly version?: string
  readonly stats: ReportStats
  readonly defectAnalysis: readonly DefectAnalysisEntry[]
  readonly risks: readonly RiskEntry[]
  readonly releaseRecommendation: 'approve' | 'conditional' | 'reject'
  readonly recommendationReason: string
  readonly unconfirmed: readonly string[]
}

function pct(rate: number): string {
  return `${(rate * 100).toFixed(1)}%`
}

function bucketTable(buckets: Readonly<Record<string, PriorityBucket>>): string {
  const rows = Object.entries(buckets).map(([key, b]) =>
    `| ${key} | ${b.total} | ${b.passed} | ${b.total === 0 ? '-' : pct(b.passed / b.total)} |`,
  )
  return rows.length === 0 ? '（无）' : `| 维度 | 总数 | 通过 | 通过率 |\n|---|---|---|---|\n${rows.join('\n')}`
}

/** 渲染六段人读报告（02 第 12 节模板）。 */
export function renderReport(report: ReportContent, evidenceIndex: readonly EvidenceIndexEntry[] = []): string {
  const { stats } = report
  const lines: string[] = []

  lines.push(`# 测试报告：${report.project}${report.version === undefined ? '' : ` ${report.version}`}（pipeline: ${report.pipelineId}）`)
  lines.push('')

  // 1. 执行概况 ← stats
  lines.push('## 1. 执行概况')
  lines.push('')
  lines.push(`- 总用例 ${stats.total} / 通过 ${stats.passed} / 失败 ${stats.failed} / 通过率 ${pct(stats.passRate)}`)
  lines.push(`- 新用例 ${stats.bySource.new.total}（通过率 ${pct(stats.bySource.new.passRate)}）；复用用例 ${stats.bySource.reused.total}（通过率 ${pct(stats.bySource.reused.passRate)}）`)
  lines.push('')
  lines.push('### 按优先级')
  lines.push(bucketTable(stats.byPriority))
  lines.push('')
  lines.push('### 按模块')
  lines.push(bucketTable(stats.byModule))
  lines.push('')

  // 2. 缺陷分析 ← defectAnalysis
  lines.push('## 2. 缺陷分析')
  lines.push('')
  if (report.defectAnalysis.length === 0) {
    lines.push('无')
  } else {
    lines.push('| 用例 | 缺陷描述 | 严重级 | 定性 | 证据 |')
    lines.push('|---|---|---|---|---|')
    for (const d of report.defectAnalysis) {
      lines.push(`| ${d.caseId} | ${d.defect} | ${d.severity} | ${d.classification} | ${d.evidence.join(', ')} |`)
    }
    const suspected = report.defectAnalysis.filter(d => d.classification === 'suspected')
    if (suspected.length > 0) {
      lines.push('')
      lines.push('**疑似问题（无证据，待人工确认）**')
      for (const d of suspected) lines.push(`- ${d.caseId}: ${d.defect}`)
    }
  }
  lines.push('')

  // 3. 风险 ← risks
  lines.push('## 3. 风险')
  lines.push('')
  if (report.risks.length === 0) {
    lines.push('无')
  } else {
    for (const r of report.risks) lines.push(`- **[${r.level}]** ${r.risk}（证据：${r.evidence}）`)
  }
  lines.push('')

  // 4. 发布建议 ← releaseRecommendation + reason
  lines.push('## 4. 发布建议')
  lines.push('')
  lines.push(`- 结论：**${report.releaseRecommendation}**`)
  lines.push(`- 理由：${report.recommendationReason}`)
  lines.push('- 【审批人签字】← 人工门 F 在此落款')
  lines.push('')

  // 5. 未确认项 ← unconfirmed
  lines.push('## 5. 未确认项')
  lines.push('')
  lines.push(report.unconfirmed.length === 0 ? '无' : report.unconfirmed.map(u => `- ${u}`).join('\n'))
  lines.push('')

  // 6. 证据附录 ← evidence 索引
  lines.push('## 6. 证据附录')
  lines.push('')
  if (evidenceIndex.length === 0) {
    lines.push('无')
  } else {
    lines.push('| 证据 | 文件 | digest |')
    lines.push('|---|---|---|')
    for (const e of evidenceIndex) lines.push(`| ${e.id} | ${e.file} | ${e.digest.slice(0, 12)}… |`)
  }
  lines.push('')

  return lines.join('\n')
}
