import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { TOOL_CATALOG } from '../src/tool-catalog.ts'
import {
  buildPlatformTools,
  executorEvidenceDir,
  executorSessionPath,
  loadExecutionSession,
  type ParseDocToolResult,
  type PlatformToolContext,
} from '../src/runtime/platform-tools.ts'
import type { ToolDefinition } from '../src/runtime/ports.ts'

let dir: string

test.beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'pp-platform-tools-')) })
test.afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

const signal = new AbortController().signal
const ctx = { signal }
const PIPELINE = 'p1'

function baseContext(overrides: Partial<PlatformToolContext> = {}): PlatformToolContext {
  return {
    projectRoot: dir,
    artifactsRoot: dir,
    pipelineId: PIPELINE,
    projectId: 'proj-a',
    ...overrides,
  }
}

function tool(context: PlatformToolContext, name: string): ToolDefinition {
  const found = buildPlatformTools(context).find(candidate => candidate.name === name)
  assert.ok(found !== undefined, `tool not found: ${name}`)
  return found
}

/**
 * 写 design 产物。
 *
 * `digest` 可显式指定：executor 的幂等键里包含 design 产物 digest（docs/10 §6.3 M2-3），
 * 因此"设计变了"这件事在测试里必须真的体现在 digest 上，否则重跑会被判成重复投递。
 */
async function writeDesign(content: unknown, digest = 'd'): Promise<void> {
  await mkdir(join(dir, 'artifacts', PIPELINE), { recursive: true })
  await writeFile(
    join(dir, 'artifacts', PIPELINE, 'design.json'),
    JSON.stringify({
      pipelineId: PIPELINE, stageId: 'design', version: 1, digest, inputs: {},
      path: `artifacts/${PIPELINE}/design.json`, content,
    }),
    'utf8',
  )
}

// ── 工具集完整性 ──────────────────────────────────────────────────────────────

test('the platform tool set covers every ACL-addressable tool it owns', () => {
  const provided = new Set(buildPlatformTools(baseContext()).map(entry => entry.name))
  // fs_read/fs_write 由 fs-tools 提供；subagent 是平台目录里的 DENY 项、由宿主真工具提供。
  // 其余工具名必须在本模块有实现，否则对应阶段的 allow 声明形同虚设。
  const owned = TOOL_CATALOG.map(entry => entry.id).filter(id => !['subagent', 'fs_read', 'fs_write'].includes(id))
  const missing = owned.filter(id => !provided.has(id))
  assert.deepEqual(missing, [], `平台 ACL 声明的工具缺少通用实现：${missing.join(', ')}`)
})

test('every platform tool declares a JSON schema and a description', () => {
  for (const entry of buildPlatformTools(baseContext())) {
    assert.ok(entry.description.trim() !== '', `${entry.name} 缺少描述`)
    assert.ok(entry.parameters !== undefined, `${entry.name} 缺少 parameters schema`)
  }
})

// ── parse_doc ────────────────────────────────────────────────────────────────

/**
 * `parse_doc` 的返回结构由 `documents/` 的 `ParsedDocument` 契约决定
 * （docs/10 §5.6.4 / §5.6.6）。这里只用类型断言读字段，不重复声明结构——
 * 结构一旦漂移，`ParseDocToolResult` 会先编译失败。
 */
type Parsed = ParseDocToolResult

async function parse(args: Record<string, unknown>, context = baseContext()): Promise<Parsed> {
  return await tool(context, 'parse_doc').execute(args, ctx) as Parsed
}

test('parse_doc 把 markdown 解析为带 heading sourceRef 的 sections，而不是只给一段纯文本', async () => {
  await writeFile(join(dir, 'kb.md'), '# 标题\n\n正文\n', 'utf8')
  const result = await parse({ path: 'kb.md' })

  assert.equal(result.available, true)
  assert.equal(result.status, 'parsed')
  assert.equal(result.format, 'markdown')
  assert.equal(result.confidence, 'structure-preserved')
  assert.equal(result.fileName, 'kb.md')
  assert.match(result.sha256 ?? '', /^[0-9a-f]{64}$/)

  assert.equal(result.sections.length, 1)
  assert.equal(result.sections[0]!.title, '标题')
  assert.equal(result.sections[0]!.level, 1)
  assert.match(result.sections[0]!.text, /正文/)
  assert.equal(result.sections[0]!.sourceRef, 'kb.md#heading=1')
  assert.deepEqual([...result.sourceRefs], ['kb.md#heading=1'])
})

test('parse_doc 把 markdown 表格转成带行级 rowRefs 的 tables', async () => {
  await writeFile(join(dir, 'spec.md'), '# 接口\n\n| 字段 | 必填 |\n| --- | --- |\n| token | 是 |\n', 'utf8')
  const result = await parse({ path: 'spec.md' })

  assert.equal(result.tables.length, 1)
  const table = result.tables[0]!
  assert.deepEqual([...table.headers], ['字段', '必填'])
  assert.deepEqual(table.rows.map(row => [...row]), [['token', '是']])
  assert.equal(table.sourceRef, 'spec.md#heading=1,table=1')
  // 行级 ref 是知识投影把「表格行」追溯到原始位置的唯一依据（docs/10 §5.6.7）。
  assert.deepEqual([...(table.rowRefs ?? [])], ['spec.md#heading=1,table=1,row=1'])
})

test('parse_doc 结构化 csv/tsv：引号、内嵌分隔符、CRLF 与行级 sourceRef', async () => {
  await writeFile(join(dir, 'cases.csv'), 'id,title,expect\r\nc1,"登录, 成功",200\r\nc2,"含""引号""",404\r\n', 'utf8')
  const csv = await parse({ path: 'cases.csv' })

  assert.equal(csv.status, 'parsed')
  assert.equal(csv.format, 'csv')
  const table = csv.tables[0]!
  assert.deepEqual([...table.headers], ['id', 'title', 'expect'])
  assert.deepEqual(table.rows.map(row => [...row]), [['c1', '登录, 成功', '200'], ['c2', '含"引号"', '404']])
  assert.equal(table.sourceRef, 'cases.csv#table=1')
  assert.deepEqual([...(table.rowRefs ?? [])], ['cases.csv#table=1,row=1', 'cases.csv#table=1,row=2'])

  await writeFile(join(dir, 'cases.tsv'), 'id\ttitle\nc1\t登录\n', 'utf8')
  const tsv = await parse({ path: 'cases.tsv' })
  assert.equal(tsv.format, 'tsv')
  assert.deepEqual(tsv.tables[0]!.rows.map(row => [...row]), [['c1', '登录']])
})

test('parse_doc 对 json：合法时规范化，非法时降为 partial 而不是假装解析成功', async () => {
  await writeFile(join(dir, 'ok.json'), '{"b":1,"a":2}', 'utf8')
  const ok = await parse({ path: 'ok.json' })
  assert.equal(ok.status, 'parsed')
  assert.equal(ok.format, 'json')
  assert.equal(ok.plainText, '{\n  "b": 1,\n  "a": 2\n}')
  assert.equal(ok.metadata?.valid, true)

  await writeFile(join(dir, 'broken.json'), '{"a":', 'utf8')
  const broken = await parse({ path: 'broken.json' })
  assert.equal(broken.status, 'partial')
  assert.equal(broken.metadata?.valid, false)
  assert.ok(broken.diagnostics.some(item => item.code === 'STRUCTURED_PARSE_FAILED'))
})

test('parse_doc 对 ZIP 签名与扩展名冲突的容器按扩展名消歧，损坏时不返回假内容', async () => {
  // 截断的 ZIP：签名在、结构不在。关键断言是 format 必须是 xlsx——ZIP 签名同时属于
  // docx 与 xlsx，只能由扩展名消歧（documents/document-detect.ts 的 resolveContainerFormat）。
  // 判错格式会把工作簿路由到 Word 解析器。
  await writeFile(join(dir, 'spec.xlsx'), Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00, 0x00, 0x00]))
  const xlsx = await parse({ path: 'spec.xlsx' })
  assert.equal(xlsx.available, true)
  assert.equal(xlsx.status, 'parse-failed')
  assert.equal(xlsx.format, 'xlsx')
  assert.equal(xlsx.plainText, '')
  assert.deepEqual([...xlsx.sections], [])
  assert.ok(xlsx.diagnostics.some(item => item.code === 'STRUCTURED_PARSE_FAILED' && item.severity === 'error'))
})

test('parse_doc 对未配置适配器的老格式返回 unsupported，并给出定向转换提示', async () => {
  const ole2 = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0x00, 0x00])

  await writeFile(join(dir, 'old.doc'), ole2)
  const doc = await parse({ path: 'old.doc' })
  assert.equal(doc.available, true)
  assert.equal(doc.status, 'unsupported')
  assert.equal(doc.format, 'doc')
  assert.equal(doc.plainText, '')
  assert.ok(doc.diagnostics.some(item => item.code === 'FORMAT_NOT_SUPPORTED' && item.severity === 'error'))
  // docs/10 §5.6.5 B：.doc 必须明确 unsupported 并提示转换为 .docx。
  assert.match(doc.diagnostics.map(item => item.message).join(' '), /转换为 \.docx/)

  await writeFile(join(dir, 'old.xls'), ole2)
  const xls = await parse({ path: 'old.xls' })
  assert.equal(xls.status, 'unsupported')
  assert.equal(xls.format, 'xls')
  // OLE2 是 .doc/.xls 共享容器：判错会把提示引到错误的转换目标。
  assert.match(xls.diagnostics.map(item => item.message).join(' '), /转换为 \.xlsx/)
})

test('parse_doc 对四类必支持格式都能成功解析并给出可定位的 sourceRef', async () => {
  // docs/10 §5.6.11 第 1、4 条：四类格式都有实际 fixture 与成功解析测试，
  // 且所有知识条目带可定位 sourceRefs。
  const { buildDocx, buildPdf, buildXlsx } = await import('./document-fixtures.ts')

  await writeFile(join(dir, 'req.pdf'), buildPdf({ pages: [{ lines: ['PDF requirement'] }] }))
  await writeFile(join(dir, 'spec.docx'), buildDocx({
    body: [{ kind: 'heading', level: 1, text: 'Word 需求' }, { kind: 'paragraph', text: '正文。' }],
  }))
  await writeFile(join(dir, 'cases.xlsx'), buildXlsx({
    sheets: [{ name: '接口', rows: [['用例ID', '接口'], ['TC-1', '/api/login']] }],
  }))
  await writeFile(join(dir, 'kb.md'), '# Markdown 需求\n\n正文。\n', 'utf8')

  const expected: readonly (readonly [string, string])[] = [
    ['req.pdf', 'req.pdf#page=1'],
    ['spec.docx', 'spec.docx#heading=1'],
    // XLSX 的表级 sourceRef 覆盖整片已用区域；行级位置在 tables[].rowRefs 上（见下）。
    ['cases.xlsx', 'cases.xlsx#sheet=接口!A1:B2'],
    ['kb.md', 'kb.md#heading=1'],
  ]

  for (const [path, ref] of expected) {
    const result = await parse({ path })
    assert.equal(result.available, true, `${path} 应当可用`)
    assert.equal(result.status, 'parsed', `${path} 应当解析成功`)
    assert.equal(result.plainText.trim() === '', false, `${path} 应当有可检索正文`)
    // sourceRefs 是知识投影能回读原文的唯一依据。
    assert.ok(result.sourceRefs.includes(ref), `${path} 缺少 sourceRef ${ref}，实际 ${result.sourceRefs.join(', ')}`)
    assert.match(result.sha256 ?? '', /^[0-9a-f]{64}$/)
  }

  // 表格行必须能追溯到原始位置（§5.6.7），行级 ref 挂在 rowRefs 上。
  const xlsx = await parse({ path: 'cases.xlsx' })
  assert.deepEqual(xlsx.tables[0]!.rowRefs, ['cases.xlsx#sheet=接口!A2:B2'])
  const docx = await parse({ path: 'spec.docx' })
  assert.deepEqual([...docx.sections.map(section => section.sourceRef)], ['spec.docx#heading=1'])
})

test('parse_doc 的路径越界与文件缺失返回结构化失败，而不是抛出或返回空结果', async () => {
  const escaped = await parse({ path: '../outside.md' })
  assert.equal(escaped.available, false)
  assert.equal(escaped.status, 'parse-failed')
  assert.equal(escaped.plainText, '')
  assert.match(escaped.error ?? '', /escapes the workspace root/)

  const absolute = await parse({ path: '/etc/hosts' })
  assert.equal(absolute.available, false)
  assert.match(absolute.error ?? '', /must be relative/)

  const missing = await parse({ path: 'nope.md' })
  assert.equal(missing.available, false)
  assert.match(missing.error ?? '', /does not exist/)
})

test('parse_doc 超出字节上限时返回 limit-exceeded，不返回被截断的假内容', async () => {
  await writeFile(join(dir, 'big.txt'), 'x'.repeat(2048), 'utf8')
  const result = await parse({ path: 'big.txt' }, baseContext({ maxDocumentBytes: 128 }))
  assert.equal(result.available, true)
  assert.equal(result.status, 'limit-exceeded')
  assert.equal(result.plainText, '')
  assert.ok(result.diagnostics.some(item => item.code === 'LIMIT_EXCEEDED'))
})

test('parse_doc 不回传原始字节，且 projectKnowledge 只产出 draft、绝不写知识库', async () => {
  await writeFile(join(dir, 'req.md'), '# 需求\n\n同一手机号 60s 内只能发一次验证码。\n', 'utf8')
  const context = baseContext({ knowledgeRoot: join(dir, 'kb') })

  const plain = await parse({ path: 'req.md' }, context) as Parsed & { rawSource?: string }
  // docs/10 §5.6.8：默认不向模型发送原始二进制/原文副本。
  assert.equal(plain.rawSource, undefined)
  assert.equal(plain.draftEntries, undefined)

  const projected = await parse({ path: 'req.md', projectKnowledge: true }, context)
  assert.equal(projected.draftEntries?.length, 1)
  const draft = projected.draftEntries![0]!
  // docs/10 §5.6.7：解析只能产出 draft，且不得直接是 verified/reviewed。
  assert.equal(draft.status, 'draft')
  assert.equal(draft.confidence, 'unverified')
  assert.equal(draft.project, 'proj-a')
  assert.equal(draft.sourcePipeline, PIPELINE)
  assert.deepEqual([...(draft.sourceRefs ?? [])], ['req.md#heading=1'])

  // active 写入必须仍走 kb_write + 人工门：解析本身不得落盘任何知识条目。
  const kbFiles = await readdir(join(dir, 'kb')).catch(() => [] as string[])
  assert.deepEqual(kbFiles, [])
})

// ── 知识库 ────────────────────────────────────────────────────────────────────

test('kb_query reports unconfigured instead of pretending the knowledge base is empty', async () => {
  const result = await tool(baseContext(), 'kb_query').execute({ text: '登录' }, ctx) as { available: boolean; source: string; entries: unknown[] }
  assert.equal(result.available, false)
  assert.equal(result.source, 'unconfigured')
  assert.deepEqual(result.entries, [])
})

test('kb_query without criteria says so rather than reporting an empty knowledge base', async () => {
  const result = await tool(baseContext({ knowledgeRoot: join(dir, 'kb') }), 'kb_query').execute({}, ctx) as { available: boolean; hint?: string }
  assert.equal(result.available, true)
  assert.match(result.hint ?? '', /未提供检索条件/)
})

test('kb_write then kb_query round-trips a structured entry', async () => {
  const context = baseContext({ knowledgeRoot: join(dir, 'kb') })
  const written = await tool(context, 'kb_write').execute({
    entry: { id: 'k1', title: '登录接口限流', version: '1.0.0', body: '同一手机号 60s 内只能发一次验证码', entities: ['登录'], tags: ['限流'] },
  }, ctx) as { id?: string; conflict?: boolean; error?: string }
  assert.equal(written.error, undefined)
  assert.equal(written.id, 'k1')

  const queried = await tool(context, 'kb_query').execute({ entities: ['登录'], limit: 5 }, ctx) as {
    available: boolean
    entries: Array<{ id: string; project: string; sourcePipeline: string; score: number; matchedBy: string[] }>
  }
  assert.equal(queried.available, true)
  assert.equal(queried.entries.length, 1)
  assert.equal(queried.entries[0]!.id, 'k1')
  // 身份字段由宿主补全，模型不能改写成别的项目/流水线
  assert.equal(queried.entries[0]!.project, 'proj-a')
  assert.equal(queried.entries[0]!.sourcePipeline, PIPELINE)
  assert.ok(queried.entries[0]!.score > 0)
  assert.ok(queried.entries[0]!.matchedBy.includes('entity'))
})

test('kb_write rejects incomplete entries and identity-field rewrites', async () => {
  const context = baseContext({ knowledgeRoot: join(dir, 'kb') })
  const entry = tool(context, 'kb_write')
  const missing = await entry.execute({ entry: { id: 'k2', title: 't' } }, ctx) as { error?: string }
  assert.match(missing.error ?? '', /缺少必填字段：version, body/)
  const wrongProject = await entry.execute({ entry: { id: 'k3', title: 't', version: '1', body: 'b', project: 'proj-b' } }, ctx) as { error?: string }
  assert.match(wrongProject.error ?? '', /必须等于当前项目 proj-a/)
  const wrongPipeline = await entry.execute({ entry: { id: 'k4', title: 't', version: '1', body: 'b', sourcePipeline: 'other' } }, ctx) as { error?: string }
  assert.match(wrongPipeline.error ?? '', /必须等于当前流水线 p1/)
  const badDate = await entry.execute({ entry: { id: 'k5', title: 't', version: '1', body: 'b', date: '2026/01/01' } }, ctx) as { error?: string }
  assert.match(badDate.error ?? '', /YYYY-MM-DD/)
})

test('kb_write surfaces a conflict instead of silently overwriting a divergent conclusion', async () => {
  const context = baseContext({ knowledgeRoot: join(dir, 'kb') })
  const entry = tool(context, 'kb_write')
  await entry.execute({ entry: { id: 'k1', title: '限流策略', version: '1.0.0', body: '60s 一次', entities: ['限流'] } }, ctx)
  const conflict = await entry.execute({ entry: { id: 'k2', title: '限流策略', version: '1.0.0', body: '30s 一次', entities: ['限流'] } }, ctx) as {
    conflict?: boolean
    conflicts?: Array<{ existingId: string }>
  }
  assert.equal(conflict.conflict, true)
  assert.equal(conflict.conflicts?.[0]?.existingId, 'k1')
})

// ── 用例库 ────────────────────────────────────────────────────────────────────

test('case_query reports unconfigured and case_archive refuses to write', async () => {
  const queried = await tool(baseContext(), 'case_query').execute({}, ctx) as { available: boolean; cases: unknown[] }
  assert.equal(queried.available, false)
  assert.deepEqual(queried.cases, [])
  const archived = await tool(baseContext(), 'case_archive').execute({ case: { caseId: 'c1', version: '1.0.0', content: {} } }, ctx) as { available: boolean; error?: string }
  assert.equal(archived.available, false)
  assert.match(archived.error ?? '', /未配置 markdown-fs 用例库/)
})

test('case_archive keeps versions append-only and case_query returns the latest version', async () => {
  const context = baseContext({ casesRoot: join(dir, 'cases') })
  const archive = tool(context, 'case_archive')
  await archive.execute({ case: { caseId: 'c1', version: '1.0.0', content: { title: '登录成功' }, sourceRequirement: 'REQ-1', ticketRef: 'PAY-1' } }, ctx)
  await archive.execute({ case: { caseId: 'c1', version: '1.1.0', content: { title: '登录成功（含限流）' }, sourceRequirement: 'REQ-1', ticketRef: 'PAY-2' } }, ctx)

  const stored = JSON.parse(await readFile(join(dir, 'cases', 'c1.json'), 'utf8')) as { versions: Array<{ version: string }> }
  assert.deepEqual(stored.versions.map(entry => entry.version).sort(), ['1.0.0', '1.1.0'])

  const queried = await tool(context, 'case_query').execute({ requirement: 'REQ-1' }, ctx) as {
    available: boolean
    cases: Array<{ caseId: string; version: string; title: string; project: string }>
  }
  assert.equal(queried.available, true)
  assert.equal(queried.cases.length, 1)
  assert.equal(queried.cases[0]!.version, '1.1.0')
  assert.equal(queried.cases[0]!.title, '登录成功（含限流）')
  assert.equal(queried.cases[0]!.project, 'proj-a')
})

test('case_archive rejects missing identity fields and foreign projects', async () => {
  const context = baseContext({ casesRoot: join(dir, 'cases') })
  const archive = tool(context, 'case_archive')
  const missing = await archive.execute({ case: { content: {} } }, ctx) as { error?: string }
  assert.match(missing.error ?? '', /缺少必填字段：caseId, version/)
  const noContent = await archive.execute({ case: { caseId: 'c2', version: '1.0.0' } }, ctx) as { error?: string }
  assert.match(noContent.error ?? '', /缺少 content/)
  const foreign = await archive.execute({ case: { caseId: 'c3', version: '1.0.0', project: 'proj-b', content: {} } }, ctx) as { error?: string }
  assert.match(foreign.error ?? '', /必须等于当前项目 proj-a/)
})

// ── req_pull / gate_check ────────────────────────────────────────────────────

test('req_pull reports a missing input path instead of returning empty requirements', async () => {
  const unconfigured = await tool(baseContext(), 'req_pull').execute({}, ctx) as { error?: string }
  assert.match(unconfigured.error ?? '', /未配置 receive 输入路径/)

  await mkdir(join(dir, 'inputs'), { recursive: true })
  await writeFile(join(dir, 'inputs', 'req.md'), '需求：短信验证码登录', 'utf8')
  const result = await tool(baseContext({ receiveInput: 'inputs/req.md' }), 'req_pull').execute({}, ctx) as { text?: string }
  assert.match(result.text ?? '', /短信验证码登录/)
})

test('gate_check reads the pipeline checkpoint and rejects a foreign pipelineId', async () => {
  const checkpointRoot = join(dir, 'checkpoints', PIPELINE)
  await mkdir(checkpointRoot, { recursive: true })
  await writeFile(join(checkpointRoot, 'checkpoint.json'), JSON.stringify({ pipelineId: PIPELINE, cursor: 0, stageStates: {} }), 'utf8')

  const context = baseContext({ checkpointRoot })
  const ok = await tool(context, 'gate_check').execute({}, ctx) as { text?: string }
  assert.match(ok.text ?? '', new RegExp(`"pipelineId": "${PIPELINE}"`))
  const foreign = await tool(context, 'gate_check').execute({ pipelineId: 'p2' }, ctx) as { error?: string }
  assert.match(foreign.error ?? '', /pipelineId 不匹配/)
})

// ── env_diag ─────────────────────────────────────────────────────────────────

test('env_diag reports unconfigured probes instead of implying a healthy environment', async () => {
  const result = await tool(baseContext(), 'env_diag').execute({}, ctx) as { available: boolean; probes: unknown[]; hint?: string }
  assert.equal(result.available, false)
  assert.deepEqual(result.probes, [])
  assert.match(result.hint ?? '', /未配置 env_diag 探针白名单/)
})

test('env_diag runs only the host allowlist and never leaks credential values', async () => {
  const context = baseContext({
    diagProbes: [{ kind: 'credentials', target: 'PP_PRESENT' }, { kind: 'credentials', target: 'PP_MISSING' }],
    env: { PP_PRESENT: 'super-secret' },
  })
  const result = await tool(context, 'env_diag').execute({}, ctx) as { available: boolean; probes: Array<{ kind: string; target: string; ok: boolean; detail: string }> }
  assert.equal(result.available, true)
  assert.deepEqual(result.probes.map(probe => [probe.target, probe.ok]), [['PP_PRESENT', true], ['PP_MISSING', false]])
  assert.equal(JSON.stringify(result.probes).includes('super-secret'), false)
})

// ── executor_run ─────────────────────────────────────────────────────────────

test('executor_run refuses to run without a target base url (no forged execution records)', async () => {
  await writeDesign({ testCases: [{ id: 'c1', steps: [{ action: 'GET /health' }] }] })
  const result = await tool(baseContext(), 'executor_run').execute({}, ctx) as { error?: string; records?: unknown[] }
  assert.match(result.error ?? '', /未配置被测服务基址/)
  assert.equal(result.records, undefined)
})

test('executor_run 在建连前再次校验 targetBaseUrl：清单被篡改成内网地址也不能发请求（docs/11 P1-01）', async () => {
  await writeDesign({ testCases: [{ id: 'c1', steps: [{ action: 'GET /health' }] }] })
  let sent = 0
  const context = baseContext({
    targetBaseUrl: 'http://127.0.0.1:9',
    // 宿主注入的校验器：与 `assertTargetBaseUrlAllowed` 同一份判据，这里用受控替身
    // 观察"是否真的在发请求前被调用过"。
    assertTargetBaseUrl: url => {
      sent += 1
      throw new Error(`targetBaseUrl 不允许指向私有地址：${url}`)
    },
  })
  const result = await tool(context, 'executor_run').execute({}, ctx) as { error?: string; records?: unknown[] }
  assert.equal(sent, 1, '建连前必须调用一次宿主校验器')
  assert.match(result.error ?? '', /不允许指向私有地址/)
  assert.equal(result.records, undefined, '被拒时不得产出任何执行记录')
})

test('executor_run rejects a foreign pipelineId and an unknown caseId', async () => {
  await writeDesign({ testCases: [{ id: 'c1', steps: [{ action: 'GET /health' }] }] })
  const context = baseContext({ targetBaseUrl: 'http://127.0.0.1:1' })
  const foreign = await tool(context, 'executor_run').execute({ pipelineId: 'p2' }, ctx) as { error?: string }
  assert.match(foreign.error ?? '', /pipelineId 不匹配/)
  const unknown = await tool(context, 'executor_run').execute({ caseIds: ['c9'] }, ctx) as { error?: string }
  assert.match(unknown.error ?? '', /不在 design 产物中：c9/)
})

test('executor_run reports a missing design artifact instead of executing nothing', async () => {
  const result = await tool(baseContext({ targetBaseUrl: 'http://127.0.0.1:1' }), 'executor_run').execute({}, ctx) as { error?: string }
  assert.match(result.error ?? '', /未找到 design 产物/)
})

test('executor_run really executes cases, writes evidence and a resumable session', async () => {
  const server = await startServer((url) => {
    if (url === '/health') return { status: 200, body: 'ok' }
    return { status: 404, body: 'missing' }
  })
  try {
    await writeDesign({
      testCases: [
        { id: 'c1', steps: [{ action: 'GET /health', expected: ['200'] }] },
        { id: 'c2', steps: [{ action: 'GET /nope', expected: ['200'] }] },
      ],
    })
    const context = baseContext({ targetBaseUrl: server.baseUrl })
    const entry = tool(context, 'executor_run')

    const first = await entry.execute({}, ctx) as { records: Array<{ seq: number; caseId: string; status: string; evidenceRefs: string[] }> }
    assert.deepEqual(first.records.map(record => [record.caseId, record.status]), [['c1', 'pass'], ['c2', 'fail']])
    assert.deepEqual(first.records.map(record => record.seq), [1, 2])
    assert.ok(first.records.every(record => record.evidenceRefs.length > 0), '每条记录必须带证据引用（R4-02）')

    // 会话与证据落盘在宿主指定目录
    const session = JSON.parse(await readFile(executorSessionPath(dir, PIPELINE), 'utf8')) as { records: unknown[]; evidenceDir: string }
    assert.equal(session.records.length, 2)
    assert.equal(session.evidenceDir, executorEvidenceDir(dir, PIPELINE))
    const evidenceFiles = await readdir(executorEvidenceDir(dir, PIPELINE))
    assert.equal(evidenceFiles.length, 2)

    // 第二次调用续接链尾，而不是覆盖（覆盖会让先前批次被判"漏跑"）。
    // 先推进 design 产物 digest：`inputDigest` 变了才算**新的一轮执行**，
    // 否则同一批用例会被幂等台账判成重复投递而重放（见下面 executor_run 幂等用例）。
    await writeDesign({
      testCases: [
        { id: 'c1', steps: [{ action: 'GET /health', expected: ['200'] }] },
        { id: 'c2', steps: [{ action: 'GET /nope', expected: ['200'] }] },
        { id: 'c3', steps: [{ action: 'GET /health', expected: ['200'] }] },
      ],
    }, 'd2')
    const second = await entry.execute({ caseIds: ['c1'] }, ctx) as { records: Array<{ seq: number }> }
    assert.equal(second.records[0]!.seq, 3)
    const merged = JSON.parse(await readFile(executorSessionPath(dir, PIPELINE), 'utf8')) as { records: unknown[] }
    assert.equal(merged.records.length, 3)

    const loaded = await loadExecutionSession(executorSessionPath(dir, PIPELINE), executorEvidenceDir(dir, PIPELINE))
    assert.equal(loaded?.records.length, 3)
    assert.equal(loaded?.evidenceDir, executorEvidenceDir(dir, PIPELINE))
  } finally {
    await server.close()
  }
})

// ── executor_run 幂等（docs/10 §6.3 M2-3 / §6.4）──────────────────────────────

/** 起一个本地被测服务并写一份两用例的 design 产物。 */
async function executorFixture() {
  const server = await startServer((url) => {
    if (url === '/health') return { status: 200, body: 'ok' }
    return { status: 404, body: 'missing' }
  })
  await writeDesign({
    testCases: [
      { id: 'c1', steps: [{ action: 'GET /health', expected: ['200'] }] },
      { id: 'c2', steps: [{ action: 'GET /nope', expected: ['200'] }] },
    ],
  })
  return {
    server,
    context: baseContext({ targetBaseUrl: server.baseUrl }),
    sessionFile: executorSessionPath(dir, PIPELINE),
    evidenceDir: executorEvidenceDir(dir, PIPELINE),
  }
}

test('executor_run 幂等：同一批用例重复投递重放首次记录，不重复执行、不改会话', async () => {
  const fixture = await executorFixture()
  try {
    const entry = tool(fixture.context, 'executor_run')
    const first = await entry.execute({}, ctx) as {
      records: Array<{ seq: number; caseId: string; status: string; evidenceRefs: string[] }>
      replayedCaseIds?: string[]
    }
    assert.equal(first.replayedCaseIds, undefined)
    const sessionAfterFirst = await readFile(fixture.sessionFile, 'utf8')
    const evidenceAfterFirst = (await readdir(fixture.evidenceDir)).length

    // §6.4「同一 executor invocation 重试不会重复产生不可对账记录」。
    const again = await entry.execute({}, ctx) as typeof first
    assert.deepEqual(again.records, first.records)
    assert.deepEqual(again.replayedCaseIds, ['c1', 'c2'])
    // 会话与证据一个字节都没变：没有第二条 c1/c2 记录 → R4-08 不会判"多余执行"。
    assert.equal(await readFile(fixture.sessionFile, 'utf8'), sessionAfterFirst)
    assert.equal((await readdir(fixture.evidenceDir)).length, evidenceAfterFirst)

    // 会话里确实只有两条记录，且 seq 仍是 1、2（没有续接出新记录）。
    const session = JSON.parse(sessionAfterFirst) as { records: Array<{ seq: number; caseId: string }> }
    assert.deepEqual(session.records.map(record => [record.seq, record.caseId]), [[1, 'c1'], [2, 'c2']])
  } finally {
    await fixture.server.close()
  }
})

test('executor_run 幂等只对"同一输入"生效：design 产物 digest 变了就重新执行', async () => {
  const fixture = await executorFixture()
  try {
    const entry = tool(fixture.context, 'executor_run')
    await entry.execute({ caseIds: ['c1'] }, ctx)
    await writeDesign({
      testCases: [
        { id: 'c1', steps: [{ action: 'GET /health', expected: ['200'] }] },
        { id: 'c2', steps: [{ action: 'GET /nope', expected: ['200'] }] },
      ],
    }, 'd2')

    const rerun = await entry.execute({ caseIds: ['c1'] }, ctx) as { records: Array<{ seq: number }>; replayedCaseIds?: string[] }
    assert.equal(rerun.replayedCaseIds, undefined)
    // 续接链尾：新记录 seq = 2，会话累计 2 条——说明确实重新执行了。
    assert.equal(rerun.records[0]!.seq, 2)
    const session = JSON.parse(await readFile(fixture.sessionFile, 'utf8')) as { records: unknown[] }
    assert.equal(session.records.length, 2)
  } finally {
    await fixture.server.close()
  }
})

test('executor_run 幂等把被测基址算进输入：换了 targetBaseUrl 就是新的一轮执行', async () => {
  const fixture = await executorFixture()
  const other = await startServer(() => ({ status: 200, body: 'ok' }))
  try {
    await tool(fixture.context, 'executor_run').execute({ caseIds: ['c1'] }, ctx)
    // 同一用例、同一 design、但打向另一个被测服务 → 不能复用上一轮记录。
    const moved = await tool(baseContext({ targetBaseUrl: other.baseUrl }), 'executor_run')
      .execute({ caseIds: ['c1'] }, ctx) as { records: Array<{ seq: number }>; replayedCaseIds?: string[] }
    assert.equal(moved.replayedCaseIds, undefined)
    assert.equal(moved.records[0]!.seq, 2)
  } finally {
    await other.close()
    await fixture.server.close()
  }
})

test('executor_run 混合批次：只执行未命中的用例，命中项按请求顺序重放', async () => {
  const fixture = await executorFixture()
  try {
    const entry = tool(fixture.context, 'executor_run')
    await entry.execute({ caseIds: ['c1'] }, ctx)
    const evidenceBefore = (await readdir(fixture.evidenceDir)).length

    // c1 命中（重放），c2 未命中（执行）；顺序按请求给的顺序回。
    const mixed = await entry.execute({ caseIds: ['c1', 'c2'] }, ctx) as {
      records: Array<{ seq: number; caseId: string }>
      replayedCaseIds?: string[]
    }
    assert.deepEqual(mixed.records.map(record => record.caseId), ['c1', 'c2'])
    assert.deepEqual(mixed.replayedCaseIds, ['c1'])
    // c1 重放的是 seq 1 的旧记录；c2 是新执行的 seq 2。
    assert.equal(mixed.records[0]!.seq, 1)
    assert.equal(mixed.records[1]!.seq, 2)
    // 只新增了 c2 的证据。
    assert.equal((await readdir(fixture.evidenceDir)).length, evidenceBefore + 1)
  } finally {
    await fixture.server.close()
  }
})

test('executor_run 对重复的 caseId 去重：同一次调用里同一个用例不会执行两次', async () => {
  const fixture = await executorFixture()
  try {
    const result = await tool(fixture.context, 'executor_run').execute({ caseIds: ['c1', 'c1', 'c2'] }, ctx) as {
      records: Array<{ caseId: string }>
    }
    assert.deepEqual(result.records.map(record => record.caseId), ['c1', 'c2'])
    const session = JSON.parse(await readFile(fixture.sessionFile, 'utf8')) as { records: unknown[] }
    assert.equal(session.records.length, 2)
  } finally {
    await fixture.server.close()
  }
})

test('executor_run 会话落盘是原子写：目录里不残留 tmp 文件', async () => {
  const fixture = await executorFixture()
  try {
    await tool(fixture.context, 'executor_run').execute({}, ctx)
    const entries = await readdir(join(dir, 'executor', PIPELINE))
    assert.deepEqual(entries.filter(name => name.includes('.tmp')), [])
  } finally {
    await fixture.server.close()
  }
})

test('executor_run refuses evidence paths that escape the evidence directory', async () => {
  await writeDesign({ testCases: [{ id: '../escape', steps: [{ action: 'GET /health' }] }] })
  const context = baseContext({ targetBaseUrl: 'http://127.0.0.1:1' })
  await assert.rejects(
    () => tool(context, 'executor_run').execute({}, ctx),
    /escapes the workspace root/,
  )
})

test('loadExecutionSession returns undefined when the pipeline never executed', async () => {
  const loaded = await loadExecutionSession(executorSessionPath(dir, 'p9'), executorEvidenceDir(dir, 'p9'))
  assert.equal(loaded, undefined)
})

test('loadExecutionSession refuses to launder a corrupted session into an empty one', async () => {
  const sessionPath = executorSessionPath(dir, PIPELINE)
  await mkdir(join(dir, 'executor', PIPELINE), { recursive: true })
  await writeFile(sessionPath, '{"pipelineId":"p1"}', 'utf8')
  await assert.rejects(() => loadExecutionSession(sessionPath, executorEvidenceDir(dir, PIPELINE)), /缺少 records 数组/)
})

// ── 本地被测服务 ──────────────────────────────────────────────────────────────

async function startServer(handler: (url: string) => { status: number; body: string }): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const server: Server = createServer((request, response) => {
    const result = handler(request.url ?? '/')
    response.writeHead(result.status, { 'content-type': 'application/json' })
    response.end(result.body)
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert.ok(address !== null && typeof address === 'object')
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve, reject) => server.close(error => (error === undefined ? resolve() : reject(error)))),
  }
}
