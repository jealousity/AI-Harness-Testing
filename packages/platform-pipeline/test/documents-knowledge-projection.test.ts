/**
 * 知识投影样本（docs/10 §5.6.10「知识投影样本」、§5.6.7、§5.6.11 第 4/5/6 条）。
 *
 * 这一组回答的是"解析结果能不能安全地变成知识"：
 * - 每类格式的 `sourceRef` 都能回读到原始位置（页码 / 表格行 / sheet-range / heading）；
 * - 投影只出 `draft`，OCR/布局推断结果只能是 `inferred`，永不 `verified`；
 * - 解析失败不生成任何条目；
 * - 同一份文档重复导入幂等，内容变更不按文件名覆盖；
 * - active 写入仍走 `kb_write` 的冲突治理与人工门，`parse_doc` 绕不过去。
 *
 * @module test/documents-knowledge-projection
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import {
  defaultParserRegistry,
  projectKnowledge,
  type ParsedDocument,
} from '../src/documents/index.ts'
import {
  buildDocx,
  buildPdf,
  buildScannedPdf,
  buildXlsx,
} from './document-fixtures.ts'

const signal = new AbortController().signal

function parse(path: string, content: string | Uint8Array): Promise<ParsedDocument> {
  const bytes = typeof content === 'string' ? new TextEncoder().encode(content) : content
  return defaultParserRegistry().parse({ path, absolutePath: `/w/${path}`, bytes, signal })
}

// ── sourceRef 回读 ───────────────────────────────────────────────────────────

test('PDF：页码 sourceRef 能回读，条目是 draft + unverified', async () => {
  const doc = await parse('requirements.pdf', buildPdf({
    pages: [{ lines: ['Login requirement'] }, { lines: ['Reset requirement'] }],
  }))
  const result = projectKnowledge(doc, { project: 'proj-a' })

  assert.equal(result.documentSha256, doc.sha256)
  assert.equal(result.entries.length, 2)
  assert.deepEqual(result.entries.map(entry => [...(entry.sourceRefs ?? [])]), [
    ['requirements.pdf#page=1'],
    ['requirements.pdf#page=2'],
  ])
  for (const entry of result.entries) {
    // §5.6.7：投影只能出 draft，active 必须走机器校验 + 人工门 + 冲突治理。
    assert.equal(entry.status, 'draft')
    assert.equal(entry.confidence, 'unverified')
    assert.equal(entry.project, 'proj-a')
    assert.match(entry.version, /^doc-[0-9a-f]{12}$/)
  }
})

test('Word：表格行 sourceRef 能回读到具体行', async () => {
  const doc = await parse('api.docx', buildDocx({
    body: [
      { kind: 'heading', level: 1, text: '接口' },
      {
        kind: 'table',
        rows: [['字段', '必填'], ['token', '是'], ['expires', '否']],
      },
    ],
  }))
  const result = projectKnowledge(doc, { project: 'proj-a' })

  const rowEntries = result.entries.filter(entry => (entry.sourceRefs ?? []).some(ref => ref.includes(',row=')))
  assert.equal(rowEntries.length, 2)
  assert.deepEqual(rowEntries.map(entry => [...(entry.sourceRefs ?? [])]), [
    ['api.docx#heading=1,table=1,row=1'],
    ['api.docx#heading=1,table=1,row=2'],
  ])
  // 行正文用「表头: 值」，让每条行知识自带字段语义。
  assert.equal(rowEntries[0]!.body, '字段: token\n必填: 是')
  assert.equal(rowEntries[0]!.title, 'token')

  // 叙述型文档同时产出章节条目与行条目，两种粒度都是独立知识单元。
  assert.equal(result.entries.length, 3)
  assert.deepEqual([...(result.entries[0]!.sourceRefs ?? [])], ['api.docx#heading=1'])
})

test('Excel：sheet/range sourceRef 能回读到行区域，且只出行级条目', async () => {
  const doc = await parse('cases.xlsx', buildXlsx({
    sheets: [{
      name: '接口',
      rows: [
        ['用例ID', '接口'],
        ['TC-1', '/api/login'],
        ['TC-2', '/api/reset'],
      ],
    }],
  }))
  const result = projectKnowledge(doc, { project: 'proj-a' })

  // CSV/TSV/XLSX 是"表格即内容"的格式：再产出一个整表章节条目只会重复。
  assert.equal(result.entries.length, 2)
  assert.deepEqual(result.entries.map(entry => [...(entry.sourceRefs ?? [])]), [
    ['cases.xlsx#sheet=接口!A2:B2'],
    ['cases.xlsx#sheet=接口!A3:B3'],
  ])
  assert.equal(result.entries[0]!.body, '用例ID: TC-1\n接口: /api/login')
})

test('Markdown：heading sourceRef 能回读', async () => {
  const doc = await parse('guide.md', '# 登录\n\n同一手机号 60s 内只能发一次验证码。\n\n## 重置\n\n重置链接一次性有效。\n')
  const result = projectKnowledge(doc, { project: 'proj-a' })

  assert.deepEqual(result.entries.map(entry => [...(entry.sourceRefs ?? [])]), [
    ['guide.md#heading=1'],
    ['guide.md#heading=1.1'],
  ])
  assert.deepEqual(result.entries.map(entry => entry.title), ['登录', '重置'])
})

// ── 置信度与失败语义 ─────────────────────────────────────────────────────────

test('扫描 PDF（partial）产出零条目，并说明 partial 的复核要求', async () => {
  const doc = await parse('scan.pdf', buildScannedPdf(2))
  assert.equal(doc.status, 'partial')

  const result = projectKnowledge(doc, { project: 'proj-a' })
  assert.deepEqual(result.entries, [])
  assert.match(result.warnings.join(' '), /只被部分解析（partial）/)
  assert.equal(result.status, 'partial')
  assert.equal(result.confidence, 'unverified')
})

test('OCR/布局推断结果只能是 inferred，永不 verified', () => {
  // 手工构造一份"OCR 出来"的文档：解析器层已经标了 ocr-derived，投影不得提升它。
  const ocr: ParsedDocument = {
    status: 'partial',
    format: 'pdf',
    fileName: 'scan.pdf',
    sha256: 'a'.repeat(64),
    sections: [{ id: 'section-1', title: '第 1 页', order: 0, text: 'OCR 出的文字', sourceRef: 'scan.pdf#page=1' }],
    tables: [],
    metadata: {},
    plainText: 'OCR 出的文字',
    diagnostics: [],
    confidence: 'ocr-derived',
    limits: { truncated: false },
  }

  const result = projectKnowledge(ocr, { project: 'proj-a' })
  assert.equal(result.confidence, 'inferred')
  assert.equal(result.entries[0]!.confidence, 'inferred')
  assert.notEqual(result.entries[0]!.confidence, 'verified')
  assert.notEqual(result.entries[0]!.confidence, 'reviewed')
  assert.match(result.warnings.join(' '), /不得当作原文事实/)
})

test('解析失败/不支持/超限的文档不生成任何条目', async () => {
  const cases: readonly (readonly [string, Uint8Array])[] = [
    ['old.doc', new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])],
    ['broken.pdf', new TextEncoder().encode('not a pdf at all')],
  ]
  for (const [path, bytes] of cases) {
    const doc = await parse(path, bytes)
    const result = projectKnowledge(doc, { project: 'proj-a' })
    assert.deepEqual(result.entries, [], `${path} 不该产出条目`)
    assert.match(result.warnings.join(' '), new RegExp(`文档状态为 ${doc.status}`))
  }
})

// ── 幂等与版本策略 ───────────────────────────────────────────────────────────

test('同一份文档重复导入幂等：条目 id 完全一致', async () => {
  const bytes = buildDocx({
    body: [{ kind: 'heading', level: 1, text: '需求' }, { kind: 'paragraph', text: '业务事实。' }],
  })
  const first = projectKnowledge(await parse('req.docx', bytes), { project: 'proj-a' })
  const second = projectKnowledge(await parse('req.docx', bytes), { project: 'proj-a' })

  assert.deepEqual(first.entries.map(entry => entry.id), second.entries.map(entry => entry.id))
})

test('内容变更后得到新 id，绝不按文件名覆盖旧条目', async () => {
  const before = projectKnowledge(
    await parse('req.docx', buildDocx({ body: [{ kind: 'paragraph', text: '版本一。' }] })),
    { project: 'proj-a' },
  )
  const after = projectKnowledge(
    await parse('req.docx', buildDocx({ body: [{ kind: 'paragraph', text: '版本二。' }] })),
    { project: 'proj-a' },
  )

  assert.notEqual(before.entries[0]!.id, after.entries[0]!.id)
  // 默认不 supersede：由人工门决定是否替代，解析层不自作主张。
  assert.equal(after.entries[0]!.supersedes, undefined)
  // 调用方显式声明时才会带上替代关系。
  const explicit = projectKnowledge(
    await parse('req.docx', buildDocx({ body: [{ kind: 'paragraph', text: '版本二。' }] })),
    { project: 'proj-a', supersedes: [before.entries[0]!.id] },
  )
  assert.deepEqual([...explicit.entries[0]!.supersedes!], [before.entries[0]!.id])
})

// ── 端到端：parse_doc 不能绕过人工门 ─────────────────────────────────────────

test('parse_doc 只产出 draft，绝不落盘；active 写入仍走 kb_write 的冲突治理', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pp-kb-projection-'))
  try {
    const { buildPlatformTools } = await import('../src/runtime/platform-tools.ts')
    const context = {
      projectRoot: dir,
      artifactsRoot: dir,
      pipelineId: 'p1',
      projectId: 'proj-a',
      knowledgeRoot: join(dir, 'kb'),
    }
    const tools = buildPlatformTools(context)
    const parseDoc = tools.find(entry => entry.name === 'parse_doc')!
    const kbWrite = tools.find(entry => entry.name === 'kb_write')!

    await writeFile(
      join(dir, 'req.md'),
      '# 限流\n\n同一手机号 60s 内只能发一次验证码。\n',
      'utf8',
    )

    const projected = await parseDoc.execute({ path: 'req.md', projectKnowledge: true }, { signal }) as {
      draftEntries?: readonly { id: string; status: string; confidence: string; title: string; body: string; version: string }[]
      available: boolean
    }
    assert.equal(projected.available, true)
    assert.equal(projected.draftEntries?.length, 1)
    const draft = projected.draftEntries![0]!
    // §5.6.7：解析只能产出 draft；active 必须经过人工门。
    assert.equal(draft.status, 'draft')
    assert.equal(draft.confidence, 'unverified')

    // 解析本身不得在知识库目录里留下任何文件。
    const kbFiles = await readdir(join(dir, 'kb')).catch(() => [] as string[])
    assert.deepEqual(kbFiles, [])

    // 人工门通过后由 kb_write 落盘（draft → active 是人工裁决的结果，不是解析器的行为）。
    const accepted = await kbWrite.execute({
      entry: {
        id: draft.id, title: draft.title, version: draft.version, body: draft.body,
        status: 'active', confidence: 'unverified', sourceRefs: ['req.md#heading=1'],
      },
    }, { signal }) as { id?: string; error?: string; conflict?: boolean }
    assert.equal(accepted.error, undefined)
    assert.equal(accepted.id, draft.id)

    // 再写一份标题相同但结论不同的 active 条目 → 必须报冲突，而不是静默覆盖。
    const conflict = await kbWrite.execute({
      entry: {
        id: `${draft.id}-b`, title: draft.title, version: draft.version,
        body: '同一手机号 30s 内只能发一次验证码。', status: 'active',
        sourceRefs: ['req.md#heading=1'],
      },
    }, { signal }) as { conflict?: boolean; conflicts?: readonly { existingId: string }[] }
    assert.equal(conflict.conflict, true)
    assert.equal(conflict.conflicts?.[0]?.existingId, draft.id)

    // 但 draft 之间不算冲突：未裁决的内容不具权威性，解析产物可以并存待审。
    const draftOnly = await kbWrite.execute({
      entry: {
        id: `${draft.id}-c`, title: draft.title, version: draft.version,
        body: '同一手机号 45s 内只能发一次验证码。', status: 'draft',
        sourceRefs: ['req.md#heading=1'],
      },
    }, { signal }) as { error?: string; conflict?: boolean }
    assert.equal(draftOnly.error, undefined)
    assert.equal(draftOnly.conflict, false)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('projectKnowledge 拒绝空项目名，避免产出无归属的知识条目', async () => {
  const doc = await parse('guide.md', '# 标题\n\n正文\n')
  assert.throws(() => projectKnowledge(doc, { project: '  ' }), /non-empty project/)
})

test('条目数量上限生效并给出明确警告，不静默截断', async () => {
  const doc = await parse('cases.csv', 'id,value\n1,a\n2,b\n3,c\n4,d\n')
  const result = projectKnowledge(doc, { project: 'proj-a', maxEntries: 2 })

  assert.equal(result.entries.length, 2)
  assert.match(result.warnings.join(' '), /候选条目超过上限 2/)
})
