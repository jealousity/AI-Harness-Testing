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

async function writeDesign(content: unknown): Promise<void> {
  await mkdir(join(dir, 'artifacts', PIPELINE), { recursive: true })
  await writeFile(
    join(dir, 'artifacts', PIPELINE, 'design.json'),
    JSON.stringify({
      pipelineId: PIPELINE, stageId: 'design', version: 1, digest: 'd', inputs: {},
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

test('parse_doc returns markdown and text documents as-is', async () => {
  await writeFile(join(dir, 'kb.md'), '# 标题\n\n正文\n', 'utf8')
  const result = await tool(baseContext(), 'parse_doc').execute({ path: 'kb.md' }, ctx) as { format: string; text: string }
  assert.equal(result.format, 'text')
  assert.match(result.text, /# 标题/)
})

test('parse_doc structures csv and tsv into rows (quotes, embedded delimiters, CRLF)', async () => {
  await writeFile(join(dir, 'cases.csv'), 'id,title,expect\r\nc1,"登录, 成功",200\r\nc2,"含""引号""",404\r\n', 'utf8')
  const csv = await tool(baseContext(), 'parse_doc').execute({ path: 'cases.csv' }, ctx) as { format: string; rows: string[][] }
  assert.equal(csv.format, 'table')
  assert.deepEqual(csv.rows, [['id', 'title', 'expect'], ['c1', '登录, 成功', '200'], ['c2', '含"引号"', '404']])

  await writeFile(join(dir, 'cases.tsv'), 'id\ttitle\nc1\t登录\n', 'utf8')
  const tsv = await tool(baseContext(), 'parse_doc').execute({ path: 'cases.tsv' }, ctx) as { format: string; rows: string[][] }
  assert.deepEqual(tsv.rows, [['id', 'title'], ['c1', '登录']])
})

test('parse_doc normalizes valid JSON and flags invalid JSON without pretending success', async () => {
  await writeFile(join(dir, 'ok.json'), '{"b":1,"a":2}', 'utf8')
  const ok = await tool(baseContext(), 'parse_doc').execute({ path: 'ok.json' }, ctx) as { format: string; text: string }
  assert.equal(ok.format, 'json')
  assert.equal(ok.text, '{\n  "b": 1,\n  "a": 2\n}')

  await writeFile(join(dir, 'broken.json'), '{"a":', 'utf8')
  const broken = await tool(baseContext(), 'parse_doc').execute({ path: 'broken.json' }, ctx) as { format: string; error?: string }
  assert.equal(broken.format, 'text')
  assert.match(broken.error ?? '', /不是合法 JSON/)
})

test('parse_doc refuses binary formats explicitly instead of returning mojibake', async () => {
  await writeFile(join(dir, 'spec.xlsx'), 'PK\u0003\u0004binary', 'utf8')
  const result = await tool(baseContext(), 'parse_doc').execute({ path: 'spec.xlsx' }, ctx) as { format: string; error?: string }
  assert.equal(result.format, 'unsupported')
  assert.match(result.error ?? '', /不支持解析 \.xlsx/)
})

test('parse_doc honours the same workspace path boundary as fs_read', async () => {
  const entry = tool(baseContext(), 'parse_doc')
  await assert.rejects(() => entry.execute({ path: '../outside.md' }, ctx), /escapes the workspace root/)
  await assert.rejects(() => entry.execute({ path: '/etc/hosts' }, ctx), /must be relative/)
})

test('parse_doc marks truncation instead of silently dropping content', async () => {
  await writeFile(join(dir, 'big.txt'), 'x'.repeat(2048), 'utf8')
  const result = await tool(baseContext({ maxDocumentBytes: 128 }), 'parse_doc')
    .execute({ path: 'big.txt' }, ctx) as { truncated?: boolean; text: string }
  assert.equal(result.truncated, true)
  assert.equal(result.text.length, 128)
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

    // 第二次调用续接链尾，而不是覆盖（覆盖会让先前批次被判"漏跑"）
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
