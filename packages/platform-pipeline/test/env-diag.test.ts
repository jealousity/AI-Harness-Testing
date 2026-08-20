import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { diagCredential, diagDisk, diagNetwork, diagService, runDiag } from '../src/executor/env-diag.ts'

let server: Server
let baseUrl: string
let dir: string

test.before(async () => {
  server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' })
    res.end('ok')
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('no port')
  baseUrl = `http://127.0.0.1:${address.port}`
  const port = address.port
  void port
})

test.after(async () => {
  await new Promise(resolve => server.close(resolve))
})

test.beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'pp-diag-'))
})

test.afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

test('disk probe reports free space on a real path', async () => {
  const probe = await diagDisk(dir, 1) // 阈值 1 byte：必有剩余
  assert.equal(probe.kind, 'disk')
  assert.equal(probe.ok, true)
  assert.match(probe.detail, /free \d+MB/)
})

test('disk probe fails on a missing path', async () => {
  const probe = await diagDisk(join(dir, 'no-such-dir'), 1)
  assert.equal(probe.ok, false)
})

test('network probe reaches a listening local server', async () => {
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('no port')
  const probe = await diagNetwork('127.0.0.1', address.port)
  assert.equal(probe.ok, true)
  assert.match(probe.detail, /reachable/)
})

test('network probe fails on a closed port', async () => {
  const probe = await diagNetwork('127.0.0.1', 1, 500) // port 1 基本必闭
  assert.equal(probe.ok, false)
})

test('service probe ok on 2xx, fails on unreachable', async () => {
  const ok = await diagService(baseUrl, 3000)
  assert.equal(ok.ok, true)
  assert.match(ok.detail, /http 200/)
  const down = await diagService('http://127.0.0.1:1/health', 1000)
  assert.equal(down.ok, false)
})

test('credential probe reports presence without leaking value', async () => {
  const env: NodeJS.ProcessEnv = { TEST_SECRET: 's3cr3t' }
  const present = diagCredential('TEST_SECRET', env)
  assert.equal(present.ok, true)
  assert.equal(present.detail, 'present')
  assert.ok(!present.detail.includes('s3cr3t'))
  const missing = diagCredential('TEST_SECRET_NOPE', env)
  assert.equal(missing.ok, false)
  assert.equal(missing.detail, 'missing')
})

test('runDiag batches mixed probes in parallel', async () => {
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('no port')
  const probes = await runDiag([
    { kind: 'disk', target: dir },
    { kind: 'network', target: '127.0.0.1', port: address.port },
    { kind: 'service', target: baseUrl },
    { kind: 'credentials', target: 'PP_TEST_ENV' },
  ], { env: { PP_TEST_ENV: 'x' } })
  assert.equal(probes.length, 4)
  assert.deepEqual(probes.map(p => p.kind), ['disk', 'network', 'service', 'credentials'])
  assert.equal(probes.every(p => p.ok), true)
})
