import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { renderReport, type ReportContent } from '../src/report/render.ts'
import { MarkdownCaseStore, MarkdownKnowledgeStore, type KnowledgeEntry, type VersionedCase } from '../src/stores/markdown.ts'

let dir: string

test.beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'pp-md-'))
})

test.afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

// ── 报告渲染器 ───────────────────────────────────────────────────────────────

const report: ReportContent = {
  pipelineId: 'pipe-1',
  project: 'acme-pay',
  version: '2026.08',
  stats: {
    total: 10, passed: 8, failed: 2, passRate: 0.8,
    byPriority: { P0: { total: 4, passed: 4 }, P1: { total: 6, passed: 4 } },
    byModule: { payment: { total: 10, passed: 8 } },
    bySource: {
      new: { total: 6, passed: 4, passRate: 0.667 },
      reused: { total: 4, passed: 4, passRate: 1 },
    },
  },
  defectAnalysis: [
    { caseId: 'TC-1', defect: '幂等键失效', severity: 'critical', evidence: ['ev-1'], classification: 'defect' },
    { caseId: 'TC-2', defect: '疑似超时', severity: 'minor', evidence: [], classification: 'suspected' },
  ],
  risks: [{ risk: '依赖升级未验证', level: 'high', evidence: 'TC-9' }],
  releaseRecommendation: 'conditional',
  recommendationReason: '2 条失败需确认；1 条疑似问题无证据。',
  unconfirmed: ['WARNING: REQ-003 覆盖 gaps', '重入 1 次（analyze）'],
}

test('renderReport produces all six sections with data', () => {
  const md = renderReport(report, [{ id: 'ev-1', file: 'evidence/1.log', digest: 'abc123' }])
  for (const heading of ['## 1. 执行概况', '## 2. 缺陷分析', '## 3. 风险', '## 4. 发布建议', '## 5. 未确认项', '## 6. 证据附录']) {
    assert.ok(md.includes(heading), `missing ${heading}`)
  }
  assert.ok(md.includes('总用例 10 / 通过 8 / 失败 2 / 通过率 80.0%'))
  assert.ok(md.includes('复用用例 4（通过率 100.0%）'))
  assert.ok(md.includes('| TC-1 | 幂等键失效 | critical | defect | ev-1 |'))
  assert.ok(md.includes('**疑似问题（无证据，待人工确认）**'))
  assert.ok(md.includes('**conditional**'))
  assert.ok(md.includes('【审批人签字】'))
  assert.ok(md.includes('| ev-1 | evidence/1.log | abc123… |'))
})

test('renderReport renders empty sections explicitly as 无', () => {
  const empty: ReportContent = {
    ...report,
    defectAnalysis: [],
    risks: [],
    unconfirmed: [],
  }
  const md = renderReport(empty)
  assert.ok(md.includes('## 2. 缺陷分析\n\n无'))
  assert.ok(md.includes('## 3. 风险\n\n无'))
  assert.ok(md.includes('## 5. 未确认项\n\n无'))
  assert.ok(md.includes('## 6. 证据附录\n\n无'))
})

// ── markdown-fs 知识库 ───────────────────────────────────────────────────────

const entry1: KnowledgeEntry = {
  id: 'kb-pay-1', title: '支付幂等规范', date: '2026-08-17', project: 'acme-pay', version: '2026.08',
  tags: ['接口'], entities: ['PaymentService', 'idempotency-key'], body: '正文一', sourcePipeline: 'pipe-1',
}
const entry2: KnowledgeEntry = {
  id: 'kb-pay-2', title: '结算对账', date: '2026-08-10', project: 'acme-pay', version: '2026.08',
  tags: ['结算'], entities: ['SettlementService'], body: '正文二', sourcePipeline: 'pipe-1',
}

test('MarkdownKnowledgeStore write→read round-trips and filters by entity/project', async () => {
  const kb = new MarkdownKnowledgeStore(dir)
  await kb.write(entry1)
  await kb.write(entry2)

  const hit = await kb.read({ entities: ['idempotency-key'], limit: 10 })
  assert.equal(hit.length, 1)
  assert.equal(hit[0]?.id, 'kb-pay-1')

  const otherProject = await kb.read({ entities: ['PaymentService'], project: 'other', limit: 10 })
  assert.equal(otherProject.length, 0)

  const limit = await kb.read({ entities: ['PaymentService', 'SettlementService'], limit: 1 })
  assert.equal(limit.length, 1)
  // 按 date 降序：entry1 (08-17) 优先
  assert.equal(limit[0]?.id, 'kb-pay-1')
})

test('MarkdownKnowledgeStore write is idempotent by id', async () => {
  const kb = new MarkdownKnowledgeStore(dir)
  await kb.write(entry1)
  await kb.write({ ...entry1, body: '更新正文' })
  const hit = await kb.read({ entities: ['PaymentService'], limit: 10 })
  assert.equal(hit.length, 1)
})

// ── markdown-fs 用例库 ───────────────────────────────────────────────────────

const caseV1: VersionedCase = {
  caseId: 'TC-001', version: '2026.01', project: 'acme-pay',
  sourceRequirement: 'REQ-1', ticketRef: 'PAY-1', content: { title: '登录-正确', steps: [] },
}

test('MarkdownCaseStore query returns latest version and filters by requirement', async () => {
  const cases = new MarkdownCaseStore(dir)
  await cases.archive(caseV1)
  await cases.archive({ ...caseV1, version: '2026.08', ticketRef: 'PAY-9' })

  const all = await cases.query({ project: 'acme-pay' })
  assert.equal(all.length, 1)
  assert.equal(all[0]?.version, '2026.08')

  const byReq = await cases.query({ project: 'acme-pay', requirement: 'REQ-1' })
  assert.equal(byReq.length, 1)

  const byVersion = await cases.query({ project: 'acme-pay', version: '2026.01' })
  assert.equal(byVersion.length, 0) // 查询的是最新版本，2026.01 已被覆盖

  const other = await cases.query({ project: 'other' })
  assert.equal(other.length, 0)
})

test('MarkdownCaseStore archive same version replaces, different versions append', async () => {
  const cases = new MarkdownCaseStore(dir)
  await cases.archive(caseV1)
  await cases.archive({ ...caseV1, version: '2026.08' })
  await cases.archive({ ...caseV1, version: '2026.08', content: { title: '登录-更新' } })
  const metas = await cases.query({ project: 'acme-pay' })
  assert.equal(metas.length, 1)
  assert.equal(metas[0]?.version, '2026.08')
})
