import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HttpExecutor, type HttpCase } from '../src/executor/http.ts'
import { verifyChain } from '../src/executor/records.ts'
import { reconcile, verifyEvidence } from '../src/executor/verify.ts'

let server: Server
let baseUrl: string
let dir: string

const cases: HttpCase[] = [
  {
    id: 'TC-OK',
    steps: [
      { kind: 'http-request', name: 'login', method: 'POST', url: '/api/login', body: { user: 'u1' }, expectedStatus: 200, expectedContains: 'token' },
    ],
  },
  {
    id: 'TC-FAIL',
    steps: [
      { kind: 'http-request', name: 'boom', method: 'GET', url: '/api/boom', expectedStatus: 200 },
    ],
  },
]

test.before(async () => {
  server = createServer((req, res) => {
    if (req.url === '/api/login') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ token: 'abc' }))
      return
    }
    if (req.url === '/api/boom') {
      res.writeHead(500, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'server exploded' }))
      return
    }
    res.writeHead(404)
    res.end('not found')
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('no port')
  baseUrl = `http://127.0.0.1:${address.port}`
})

test.after(async () => {
  await new Promise(resolve => server.close(resolve))
})

test.beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'pp-http-'))
})

test.afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

function makeExecutor(): HttpExecutor {
  return new HttpExecutor({
    resolveCase: async id => cases.find(c => c.id === id),
    writeEvidence: async (path, content) => {
      const { writeFile, mkdir } = await import('node:fs/promises')
      await mkdir(join(dir, 'evidence'), { recursive: true })
      await writeFile(join(dir, 'evidence', path.split('/').pop() ?? 'x'), content)
    },
    request: async (url, init) => {
      const response = await fetch(new URL(url, baseUrl), init)
      return { status: response.status, text: () => response.text() }
    },
  })
}

test('HttpExecutor runs cases, builds a valid chain, and captures anchored evidence', async () => {
  const executor = makeExecutor()
  const session = await executor.run(['TC-OK', 'TC-FAIL'], {
    designArtifactPath: 'x',
    evidenceDir: join(dir, 'evidence'),
    invocationId: 'inv-1',
  })

  assert.equal(session.records.length, 2)
  assert.equal(session.records[0]!.status, 'pass')
  assert.equal(session.records[1]!.status, 'fail')

  // R4-09 链完整
  assert.deepEqual(verifyChain(session.records), [])

  // R4-10 证据锚定（executor 身份 + 记录时间窗内）
  assert.deepEqual(verifyEvidence(session.evidence, session.records), [])
  assert.ok(session.evidence.every(e => e.capturedBy === 'executor:inv-1'))

  // R4-08 对账：records 覆盖计划、results 引用 records → 通过
  const results = session.records.map(r => ({ caseId: r.caseId, recordRef: String(r.seq) }))
  const reconciled = reconcile(session.records, ['TC-OK', 'TC-FAIL'], results)
  assert.equal(reconciled.ok, true)

  // side-effect 留痕（ET-03）：wire 文件真实落盘且 digest 可重算
  for (const entry of session.evidence) {
    const file = join(dir, 'evidence', entry.file)
    const content = await readFile(file, 'utf8')
    const { createHash } = await import('node:crypto')
    assert.equal(createHash('sha256').update(content).digest('hex'), entry.digest)
  }
  // 失败用例有证据（R4-02 前置）
  assert.ok(session.records[1]!.evidenceRefs.length > 0)
})

test('HttpExecutor records missing case as fail with diagnostic evidence', async () => {
  const executor = makeExecutor()
  const session = await executor.run(['TC-NOPE'], {
    designArtifactPath: 'x', evidenceDir: join(dir, 'evidence'), invocationId: 'inv-2',
  })
  assert.equal(session.records[0]!.status, 'fail')
  assert.ok(session.records[0]!.evidenceRefs.length > 0)
  const content = await readFile(join(dir, 'evidence', session.evidence[0]!.file), 'utf8')
  assert.ok(content.includes('TC-NOPE'))
})
