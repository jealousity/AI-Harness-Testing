/**
 * 幂等键与幂等台账测试（docs/10 §6.3 M2-3 / §6.4 验收）。
 *
 * 这里的每一条都对应 §6.3 或 §6.4 的一句要求：
 *
 * | 要求 | 用例 |
 * |---|---|
 * | 键稳定、与调用顺序无关 | 同字段恒等；字段顺序由调用方固定，时间/进程不参与 |
 * | 命名空间参与哈希 | 不同命名空间同字段不撞键 |
 * | 重复键返回首次结果 | 第二次调用不执行 `produce`，结果与首次逐字相同 |
 * | 重复不产生副作用 | `produce` 调用次数恒为 1 |
 * | 同键不同内容 | 抛 `IdempotencyConflictError`，不静默重放 |
 * | 先写者胜 | 并发的第二个执行者拿到先写者的结果 |
 * | 坏记录不锁死键 | 记录损坏按"无记录"处理，可被覆盖 |
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import {
  IDEMPOTENCY_NAMESPACES,
  IdempotencyConflictError,
  fileIdempotencyLedger,
  idempotencyDir,
  idempotencyFingerprint,
  idempotencyKey,
  type IdempotencyRecord,
} from '../src/idempotency.ts'

const NS = IDEMPOTENCY_NAMESPACES.pipelineCreate

async function withDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'pp-idem-'))
  try {
    await run(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

// ── 键的构造 ────────────────────────────────────────────────────────────────

test('幂等键是字段的纯函数：同一组字段恒等，与调用次数无关', () => {
  const a = idempotencyKey(NS, ['acme', 'demo', 'pipe-1'])
  const b = idempotencyKey(NS, ['acme', 'demo', 'pipe-1'])
  assert.equal(a, b)
  assert.match(a, /^[0-9a-f]{64}$/)

  // 字段值变化必须换键，否则幂等会退化成"永远命中"。
  assert.notEqual(a, idempotencyKey(NS, ['acme', 'demo', 'pipe-2']))
  assert.notEqual(a, idempotencyKey(NS, ['acme', 'other', 'pipe-1']))
  assert.notEqual(a, idempotencyKey(NS, ['other', 'demo', 'pipe-1']))
})

test('命名空间参与哈希：同字段在不同操作下不撞键', () => {
  const fields = ['acme', 'demo', 'pipe-1']
  const keys = Object.values(IDEMPOTENCY_NAMESPACES).map(namespace => idempotencyKey(namespace, fields))
  assert.equal(new Set(keys).size, keys.length)
})

test('字段分隔不可伪造：["ab","c"] 与 ["a","bc"] 不撞键', () => {
  // 若用字符串拼接而不是 JSON 数组，这两组会拼成同一个 "abc"。
  assert.notEqual(idempotencyKey(NS, ['ab', 'c']), idempotencyKey(NS, ['a', 'bc']))
})

test('数字字段规范化：-0 与 0 同键，数字与同值字符串也同键', () => {
  assert.equal(idempotencyKey(NS, [-0]), idempotencyKey(NS, [0]))
  // 数字统一成十进制字面量，所以 1 与 '1' 是同一个字段值——这是刻意的：
  // 同一个业务值被两个调用方分别以数字/字符串传入时不该算出两个键。
  assert.equal(idempotencyKey(NS, [1]), idempotencyKey(NS, ['1']))
  assert.notEqual(idempotencyKey(NS, [1]), idempotencyKey(NS, ['01']))
  // 非有限值也有稳定的字面量，不会退化成 'NaN' 之外的随机串。
  assert.equal(idempotencyKey(NS, [Number.POSITIVE_INFINITY]), idempotencyKey(NS, [Number.POSITIVE_INFINITY]))
})

test('指纹是可读的规范化 JSON，与键一一对应', () => {
  const fingerprint = idempotencyFingerprint(NS, ['acme', 'demo'])
  assert.equal(fingerprint, JSON.stringify([NS, 'acme', 'demo']))
})

test('idempotencyDir 落在项目根下，三个入口共用同一路径', () => {
  assert.equal(idempotencyDir('/data/acme/demo'), join('/data/acme/demo', 'idempotency'))
})

// ── 台账语义 ────────────────────────────────────────────────────────────────

test('首次执行落盘，重复调用重放首次结果且不再执行 produce', async () => {
  await withDir(async dir => {
    const ledger = fileIdempotencyLedger(dir)
    const key = idempotencyKey(NS, ['acme', 'demo', 'pipe-1'])
    const fingerprint = idempotencyFingerprint(NS, ['demo', 'pipe-1', 'pipeline.yaml', 'v1'])
    let calls = 0
    const produce = async () => ({ calls: ++calls, summary: 'queued' })

    const first = await ledger.run({ namespace: NS, key, fingerprint, produce })
    assert.equal(first.replayed, false)
    assert.deepEqual(first.result, { calls: 1, summary: 'queued' })

    const second = await ledger.run({ namespace: NS, key, fingerprint, produce })
    assert.equal(second.replayed, true)
    assert.deepEqual(second.result, { calls: 1, summary: 'queued' })
    // §6.4「重试不产生副作用」：produce 只能被执行一次。
    assert.equal(calls, 1)
  })
})

test('重放返回的是首次结果本身，不是重新推导出来的值', async () => {
  await withDir(async dir => {
    const ledger = fileIdempotencyLedger(dir)
    const key = idempotencyKey(NS, ['acme', 'demo', 'pipe-1'])
    const fingerprint = idempotencyFingerprint(NS, ['demo', 'pipe-1'])
    let n = 0

    const first = await ledger.run({ namespace: NS, key, fingerprint, produce: async () => ++n })
    const second = await ledger.run({ namespace: NS, key, fingerprint, produce: async () => 999 })
    assert.equal(first.result, 1)
    assert.equal(second.result, 1)
  })
})

test('记录按命名空间分目录落盘，内容含 key/namespace/fingerprint/createdAt/result', async () => {
  await withDir(async dir => {
    const ledger = fileIdempotencyLedger(dir, { now: () => 1735689600000 })
    const key = idempotencyKey(NS, ['acme', 'demo', 'pipe-1'])
    const fingerprint = idempotencyFingerprint(NS, ['demo', 'pipe-1'])
    await ledger.run({ namespace: NS, key, fingerprint, produce: async () => ({ ok: true }) })

    const raw = await readFile(join(dir, NS, `${key}.json`), 'utf8')
    const record = JSON.parse(raw) as IdempotencyRecord
    assert.equal(record.key, key)
    assert.equal(record.namespace, NS)
    assert.equal(record.fingerprint, fingerprint)
    assert.equal(record.createdAt, 1735689600000)
    assert.deepEqual(record.result, { ok: true })
  })
})

test('同一把键上换了内容 → conflict，绝不静默重放', async () => {
  await withDir(async dir => {
    const ledger = fileIdempotencyLedger(dir)
    const key = idempotencyKey(NS, ['acme', 'demo', 'pipe-1'])
    const first = idempotencyFingerprint(NS, ['demo', 'pipe-1', 'pipeline.yaml'])
    const other = idempotencyFingerprint(NS, ['demo', 'pipe-1', 'other.yaml'])

    await ledger.run({ namespace: NS, key, fingerprint: first, produce: async () => 'first' })
    await assert.rejects(
      () => ledger.run({ namespace: NS, key, fingerprint: other, produce: async () => 'other' }),
      (error: unknown) => {
        assert.ok(error instanceof IdempotencyConflictError)
        assert.equal(error.key, key)
        assert.equal(error.namespace, NS)
        assert.equal(error.recordedFingerprint, first)
        assert.equal(error.requestedFingerprint, other)
        return true
      },
    )
  })
})

test('lookup 对缺失与损坏的记录都返回 null（损坏不锁死键）', async () => {
  await withDir(async dir => {
    const ledger = fileIdempotencyLedger(dir)
    const key = idempotencyKey(NS, ['acme', 'demo', 'pipe-1'])
    assert.equal(await ledger.lookup(NS, key), null)

    // 半截写入 / 被手工改坏的记录：按"无记录"处理，而不是抛错或重放残缺数据。
    await mkdir(join(dir, NS), { recursive: true })
    await writeFile(join(dir, NS, `${key}.json`), '{"key":"x"', 'utf8')
    assert.equal(await ledger.lookup(NS, key), null)

    // 形状不完整（缺 fingerprint）同样视作无效。
    await writeFile(join(dir, NS, `${key}.json`), JSON.stringify({ key, namespace: NS }), 'utf8')
    assert.equal(await ledger.lookup(NS, key), null)

    // 因此这个键仍然可用：会被原子覆盖成一条完整记录。
    const fingerprint = idempotencyFingerprint(NS, ['demo', 'pipe-1'])
    const outcome = await ledger.run({ namespace: NS, key, fingerprint, produce: async () => 'recovered' })
    assert.equal(outcome.replayed, false)
    assert.equal((await ledger.lookup(NS, key))?.result, 'recovered')
  })
})

test('先写者胜：并发执行时第二个执行者重放先写者的结果', async () => {
  await withDir(async dir => {
    const ledger = fileIdempotencyLedger(dir)
    const key = idempotencyKey(NS, ['acme', 'demo', 'pipe-1'])
    const fingerprint = idempotencyFingerprint(NS, ['demo', 'pipe-1'])

    // 手工模拟"另一个进程刚刚写完"：在 produce 执行期间把记录写进去。
    await mkdir(join(dir, NS), { recursive: true })
    const outcome = await ledger.run({
      namespace: NS,
      key,
      fingerprint,
      produce: async () => {
        await writeFile(
          join(dir, NS, `${key}.json`),
          JSON.stringify({ key, namespace: NS, fingerprint, createdAt: 1, result: 'winner' }),
          'utf8',
        )
        return 'loser'
      },
    })
    assert.equal(outcome.replayed, true)
    assert.equal(outcome.result, 'winner')
    // 先写者的记录不被覆盖。
    assert.equal((await ledger.lookup(NS, key))?.result, 'winner')
  })
})

test('不同键互不影响，各自独立落盘', async () => {
  await withDir(async dir => {
    const ledger = fileIdempotencyLedger(dir)
    const a = idempotencyKey(NS, ['acme', 'demo', 'pipe-1'])
    const b = idempotencyKey(NS, ['acme', 'demo', 'pipe-2'])
    const fingerprint = idempotencyFingerprint(NS, ['demo'])
    await ledger.run({ namespace: NS, key: a, fingerprint, produce: async () => 'a' })
    await ledger.run({ namespace: NS, key: b, fingerprint, produce: async () => 'b' })

    assert.equal((await ledger.lookup(NS, a))?.result, 'a')
    assert.equal((await ledger.lookup(NS, b))?.result, 'b')
    assert.deepEqual((await readdir(join(dir, NS))).sort(), [`${a}.json`, `${b}.json`].sort())
  })
})

test('produce 抛错时不落盘：失败的操作不留"已完成"的假记录', async () => {
  await withDir(async dir => {
    const ledger = fileIdempotencyLedger(dir)
    const key = idempotencyKey(NS, ['acme', 'demo', 'pipe-1'])
    const fingerprint = idempotencyFingerprint(NS, ['demo', 'pipe-1'])

    await assert.rejects(
      () => ledger.run({ namespace: NS, key, fingerprint, produce: async () => { throw new Error('装配失败') } }),
      /装配失败/,
    )
    assert.equal(await ledger.lookup(NS, key), null)

    // 重试可以正常执行：失败的第一次没有把键占住。
    const retry = await ledger.run({ namespace: NS, key, fingerprint, produce: async () => 'ok' })
    assert.equal(retry.replayed, false)
    assert.equal(retry.result, 'ok')
  })
})

test('落盘是原子写：目录里不会残留 tmp 文件', async () => {
  await withDir(async dir => {
    const ledger = fileIdempotencyLedger(dir)
    const key = idempotencyKey(NS, ['acme', 'demo', 'pipe-1'])
    await ledger.run({
      namespace: NS, key, fingerprint: idempotencyFingerprint(NS, ['demo']), produce: async () => 'x',
    })
    const entries = await readdir(join(dir, NS))
    assert.deepEqual(entries, [`${key}.json`])
  })
})
