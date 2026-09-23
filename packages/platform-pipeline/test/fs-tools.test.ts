import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { FsToolPathError, fsReadTool, fsWriteTool } from '../src/runtime/fs-tools.ts'

let dir: string

test.beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'pp-fs-tools-')) })
test.afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

const signal = new AbortController().signal
const ctx = { signal }

test('fs_read returns file content inside the workspace root', async () => {
  await mkdir(join(dir, 'artifacts', 'p1'), { recursive: true })
  await writeFile(join(dir, 'artifacts', 'p1', 'analyze.json'), '{"ok":true}', 'utf8')
  const tool = fsReadTool({ root: dir })
  assert.equal(await tool.execute({ path: 'artifacts/p1/analyze.json' }, ctx), '{"ok":true}')
})

test('fs_read rejects absolute paths and parent-directory escapes', async () => {
  const tool = fsReadTool({ root: dir })
  await assert.rejects(() => tool.execute({ path: '/etc/passwd' }, ctx), FsToolPathError)
  await assert.rejects(() => tool.execute({ path: '../outside.txt' }, ctx), /escapes the workspace root/)
  await assert.rejects(() => tool.execute({ path: 'a/../../outside.txt' }, ctx), /escapes the workspace root/)
  await assert.rejects(() => tool.execute({ path: '' }, ctx), /non-empty string/)
  await assert.rejects(() => tool.execute({ path: 42 }, ctx), /non-empty string/)
})

test('fs_read refuses a symlink that points outside the workspace root', async () => {
  const outside = await mkdtemp(join(tmpdir(), 'pp-fs-outside-'))
  try {
    await writeFile(join(outside, 'secret.txt'), 'secret', 'utf8')
    await symlink(join(outside, 'secret.txt'), join(dir, 'link.txt'))
    const tool = fsReadTool({ root: dir })
    await assert.rejects(() => tool.execute({ path: 'link.txt' }, ctx), /escapes the workspace root/)
  } finally {
    await rm(outside, { recursive: true, force: true })
  }
})

test('fs_read reports missing files instead of leaking an ENOENT code', async () => {
  const tool = fsReadTool({ root: dir })
  await assert.rejects(() => tool.execute({ path: 'nope.json' }, ctx), /does not exist/)
})

test('fs_write writes only inside the declared writable prefixes', async () => {
  const tool = fsWriteTool({ root: dir, writablePrefixes: ['artifacts/p1'] })
  const result = await tool.execute({ path: 'artifacts/p1/report.json', content: '{"a":1}' }, ctx)
  assert.deepEqual(result, { ok: true, path: 'artifacts/p1/report.json', bytes: 7 })
  assert.equal(await readFile(join(dir, 'artifacts', 'p1', 'report.json'), 'utf8'), '{"a":1}')

  // 同前缀的兄弟目录不算命中（artifacts/p10 不在 artifacts/p1 之内）
  await assert.rejects(() => tool.execute({ path: 'artifacts/p10/report.json', content: 'x' }, ctx), /outside the writable scope/)
  // `artifacts/p1/../../escape.json` 归一化后仍在工作区内，但已不在可写前缀里 → 同样拒绝
  await assert.rejects(() => tool.execute({ path: 'artifacts/p1/../../escape.json', content: 'x' }, ctx), /outside the writable scope/)
  await assert.rejects(() => tool.execute({ path: '../../escape.json', content: 'x' }, ctx), /escapes the workspace root/)
  await assert.rejects(() => tool.execute({ path: 'checkpoints/checkpoint.json', content: 'x' }, ctx), /outside the writable scope/)
  await assert.rejects(() => tool.execute({ path: 'artifacts/p1/a.json', content: 5 }, ctx), /content must be a string/)
})

test('fs_write is fully disabled when no writable prefix is declared', async () => {
  const tool = fsWriteTool({ root: dir })
  await assert.rejects(() => tool.execute({ path: 'artifacts/p1/a.json', content: 'x' }, ctx), /not enabled/)
})

test('a blank writable prefix never degrades into "whole workspace is writable"', async () => {
  const tool = fsWriteTool({ root: dir, writablePrefixes: ['/'] })
  await assert.rejects(() => tool.execute({ path: 'anything.json', content: 'x' }, ctx), /not enabled/)
})

test('fs tools refuse to run on an aborted signal', async () => {
  const controller = new AbortController()
  controller.abort()
  const read = fsReadTool({ root: dir })
  await assert.rejects(() => read.execute({ path: 'a.json' }, { signal: controller.signal }), /aborted/)
  const write = fsWriteTool({ root: dir, writablePrefixes: ['artifacts/p1'] })
  await assert.rejects(
    () => write.execute({ path: 'artifacts/p1/a.json', content: 'x' }, { signal: controller.signal }),
    /aborted/,
  )
})
