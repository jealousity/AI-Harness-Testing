/**
 * 共享测试 fixtures：各阶段合法产物内容（与 contracts/schemas.ts 一致，
 * 供 contracts/stage-rules/plugin 测试复用）。
 */

import type { StageId } from '../src/types.ts'

export type Content = Record<string, unknown>

export function receiveContent(): Content {
  return {
    requirements: [
      { id: 'REQ-1', title: '登录', background: '背景', goals: ['支持登录'], changePoints: ['登录改造'], acceptance: ['登录成功'], priority: 'P0', sourceRef: 'jira:PAY-1' },
      { id: 'REQ-2', title: '注册', background: '背景', goals: ['支持注册'], changePoints: ['注册改造'], acceptance: ['注册成功'], priority: 'P1', sourceRef: 'jira:PAY-2' },
    ],
    clarifications: [],
  }
}

export function analyzeContent(): Content {
  return {
    boundaries: { in: ['登录', '注册'], out: ['找回密码'] },
    scope: '账号模块',
    versionImpact: [{ version: '2026.08', impact: '登录改造', evidence: 'kb-pay-1' }],
    reuseSuggestions: [],
    openQuestions: [],
    riskNotes: ['低'],
    retrievalTruncated: false,
  }
}

export function designContent(requirements: readonly { id: string }[] = [{ id: 'REQ-1' }, { id: 'REQ-2' }]): Content {
  const coverageMatrix: Record<string, string[]> = {}
  const testCases: Record<string, unknown>[] = []
  requirements.forEach((requirement, index) => {
    const id = `TC-${String(index + 1).padStart(3, '0')}`
    coverageMatrix[requirement.id] = [id]
    testCases.push({
      id, title: `用例-${requirement.id}`,
      preconditions: ['无'],
      execution_level: 'auto',
      priority: 'P0',
      coverageRef: [requirement.id],
      steps: [{ action: 'POST /x' }],
      expected: ['200'],
    })
  })
  return { testCases, reusedCases: [], coverageMatrix, gaps: [] }
}

export function executeContent(design: { testCases: readonly { id: string }[] }): Content {
  return {
    plan: { env: ['test'], executors: [{ level: 'auto', impl: 'http' }], order: design.testCases.map(t => t.id) },
    results: design.testCases.map((t, i) => ({
      caseId: t.id, recordRef: String(i + 1), status: 'pass', evidence: [`ev-${i + 1}`], durationMs: 10, attempts: 1,
    })),
    envIssues: [],
    pendingManual: [],
    resumed: false,
  }
}

export function reportContent(): Content {
  return {
    stats: {
      total: 2, passed: 2, failed: 0, passRate: 1,
      byPriority: { P0: { total: 2, passed: 2 } },
      byModule: { m: { total: 2, passed: 2 } },
      bySource: { new: { total: 2, passed: 2, passRate: 1 }, reused: { total: 0, passed: 0, passRate: 0 } },
    },
    defectAnalysis: [],
    risks: [{ risk: 'none', level: 'low', evidence: '-' }],
    releaseRecommendation: 'approve',
    recommendationReason: '全部通过',
    unconfirmed: [],
  }
}

export function archiveContent(design: { testCases: readonly { id: string }[] }): Content {
  return {
    knowledgeEntries: [{
      id: 'kb-1', title: '账号模块', date: '2026-08-17', project: 'acme-pay', version: '2026.08',
      tags: ['账号'], entities: ['AccountService'], body: '账号模块测试结论', sourcePipeline: 'pipe-1',
    }],
    caseArchive: design.testCases.map(t => ({
      caseId: t.id, version: '2026.08', sourceRequirement: 'REQ-1', ticketRef: 'PAY-1', content: { title: t.id },
    })),
    versionArchive: [{ version: '2026.08', changeSummary: '账号模块' }],
    archiveReport: { entries: 1, cases: design.testCases.length, skipped: [], written: false },
  }
}

/** 按阶段生成合法产物内容（依赖上游内容对象）。 */
export function stageContent(stageId: StageId, upstreams: Readonly<Record<string, Content>>): Content {
  switch (stageId) {
    case 'receive': return receiveContent()
    case 'analyze': return analyzeContent()
    case 'design': return designContent((upstreams.receive?.requirements as readonly { id: string }[] | undefined) ?? [{ id: 'REQ-1' }, { id: 'REQ-2' }])
    case 'execute': return executeContent(upstreams.design as unknown as { testCases: readonly { id: string }[] })
    case 'report': return reportContent()
    case 'archive': return archiveContent(upstreams.design as unknown as { testCases: readonly { id: string }[] })
  }
}
