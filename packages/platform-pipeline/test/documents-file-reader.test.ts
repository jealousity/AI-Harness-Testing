/**
 * 受限文件读取（docs/11 P2-02）。
 *
 * 被验证的性质：字节上限必须在**读取之前**生效。修复前 `parse_doc` 是
 * `readFile()` 之后再判限额——一份 10 GiB 的"文档"在判据生效之前就已经把进程打爆了，
 * 限额形同虚设。
 *
 * 三条判据：
 * 1. `stat` 先判：超限直接返回，**一个字节都不读**；
 * 2. 读取本身有界：最多读 `maxBytes + 1` 字节，因此"声明大小与真实内容不一致"
 *    （TOCTOU）也越不过上限；
 * 3. 边界是 `>` 而不是 `>=`：恰好等于上限的文件必须能通过。
 *
 * @module test/documents-file-reader
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { readChunkSize, readFileWithinLimit } from '../src/documents/index.ts'

let dir: string

test.beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'pp-file-reader-')) })
test.afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

test('上限内的文件原样读出，并报告实际字节数', async () => {
  const path = join(dir, 'small.txt')
  await writeFile(path, 'hello world', 'utf8')

  const result = await readFileWithinLimit(path, 1024)
  assert.equal(result.ok, true)
  assert.equal(result.size, 11)
  assert.equal(Buffer.from(result.bytes).toString('utf8'), 'hello world')
})

test('恰好等于上限的文件通过（边界是 > 而不是 >=）', async () => {
  const path = join(dir, 'exact.txt')
  await writeFile(path, 'x'.repeat(64), 'utf8')

  const result = await readFileWithinLimit(path, 64)
  assert.equal(result.ok, true, '等于上限必须放行，否则"刚好卡在上限"的文档会被误杀')
  assert.equal(result.size, 64)
})

test('stat 判定超限时**不读内容**：文件不可读也必须给出 too-large', async () => {
  // 关键手法：把文件设为不可读。若实现是"先 readFile 再判限额"，这里会撞上 EACCES
  // 并返回 unreadable；只有"先 stat 再判"的实现才能给出 too-large。
  // 因此这条断言真正区分了两种实现，而不是只看最终状态码。
  const path = join(dir, 'huge.txt')
  await writeFile(path, 'x'.repeat(4096), 'utf8')
  await chmod(path, 0o000)
  try {
    const result = await readFileWithinLimit(path, 64)
    assert.equal(result.ok, false)
    assert.equal(result.reason, 'too-large', `必须先 stat 再判：${JSON.stringify(result)}`)
    assert.equal(result.size, 4096, '要报出真实大小，便于运维判断')
  } finally {
    await chmod(path, 0o600)
  }
})

test('读取块大小自适应且有界，不随声明大小膨胀（TOCTOU 防线）', async () => {
  // 分块读取存在的唯一理由是"stat 与 read 之间文件变大"。那种竞态无法确定性复现，
  // 因此把不变量本身钉住：块大小落在 [64 KiB, 4 MiB]，因此读取上界是
  // `maxBytes + 一个块`，而绝不会是"按声明大小分配整个缓冲区"。
  assert.equal(readChunkSize(0), 64 * 1024, '声明为空也要留一个最小块，否则小文件读不全')
  assert.equal(readChunkSize(11), 64 * 1024)
  assert.equal(readChunkSize(1024 * 1024), 1024 * 1024, '中等文件按声明大小一块读完')
  assert.equal(readChunkSize(1024 * 1024 * 1024), 4 * 1024 * 1024, '声明 1 GiB 也只分配 4 MiB 的块')
})

test('文件不存在返回 missing，不抛异常', async () => {
  const result = await readFileWithinLimit(join(dir, 'nope.txt'), 1024)
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'missing')
})

test('上限必须是正整数，非法值直接报错而不静默放宽', async () => {
  const path = join(dir, 'any.txt')
  await writeFile(path, 'x', 'utf8')
  await assert.rejects(() => readFileWithinLimit(path, 0), /positive integer/)
  await assert.rejects(() => readFileWithinLimit(path, -1), /positive integer/)
})
