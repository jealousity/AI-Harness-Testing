/**
 * `targetBaseUrl` 的 SSRF 防线（docs/10 §5.3、docs/11 P2-04）。
 *
 * 两道判据，**时机不同、职责不同**：
 * - {@link assertTargetBaseUrlAllowed}：**创建时**的字面量校验（快、无副作用）；
 * - {@link assertTargetResolvedAllowed}：**建连前**的解析后复核（防 DNS rebinding）。
 *
 * 修复前缺的三件事：
 * 1. URL 里的 userinfo（`http://user:pass@host`）没被拒——凭据会被写进配置并原样落盘；
 * 2. 错误消息直接回显 `rawUrl`，于是密码随错误响应/日志一起出网；
 * 3. `::ffff:127.0.0.1` 这类 IPv4-mapped IPv6 绕过了私有地址判定，
 *    以及"域名解析到内网"完全没有复核。
 *
 * @module test/ssrf-guard
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { assertTargetBaseUrlAllowed, assertTargetResolvedAllowed, isPrivateAddress } from '../src/web/index.ts'

/** 静态校验必须拒绝的输入（含"必须不回显密码"的检查）。 */
function rejects(rawUrl: string): void {
  assert.throws(() => assertTargetBaseUrlAllowed(rawUrl), `应当拒绝：${rawUrl}`)
}

test('拒绝 URL 里的 userinfo，且错误消息不回显凭据', () => {
  const secret = 'sup3r-s3cret'
  let message = ''
  try {
    assertTargetBaseUrlAllowed(`https://alice:${secret}@sut.example/api`)
    assert.fail('携带 userinfo 的 URL 必须被拒绝')
  } catch (error) {
    message = error instanceof Error ? error.message : String(error)
  }
  assert.ok(!message.includes(secret), `错误消息不得回显密码：${message}`)
  assert.match(message, /userinfo/)
})

test('错误消息不回显查询串（令牌常放在 query 里）', () => {
  const token = 'tok_live_abc123'
  let message = ''
  try {
    assertTargetBaseUrlAllowed(`http://127.0.0.1/api?access_token=${token}`)
    assert.fail('私有地址必须被拒绝')
  } catch (error) {
    message = error instanceof Error ? error.message : String(error)
  }
  assert.ok(!message.includes(token), `错误消息不得回显查询串：${message}`)
  assert.match(message, /127\.0\.0\.1/, '但仍要报出主机，否则运维无法定位')
})

test('IPv4-mapped IPv6 形式的私有地址必须被识别（不能绕过）', () => {
  for (const host of [
    '::ffff:127.0.0.1',
    '::ffff:7f00:1',
    '[::ffff:127.0.0.1]',
    '[::ffff:10.0.0.5]',
    '::ffff:192.168.1.1',
    '::127.0.0.1',
  ]) {
    assert.equal(isPrivateAddress(host.replace(/^\[|\]$/g, '').toLowerCase()), true, `${host} 应判为私有`)
  }
})

test('IPv6 回环/唯一本地/链路本地仍然被识别', () => {
  for (const host of ['::1', '::', 'fc00::1', 'fd12:3456::1', 'fe80::1', 'fe90::1', 'feb0::1']) {
    assert.equal(isPrivateAddress(host), true, `${host} 应判为私有`)
  }
})

test('保留网段与组播也被拦下，公网地址不误杀', () => {
  for (const host of ['0.0.0.0', '10.1.2.3', '127.0.0.1', '169.254.1.1', '172.16.0.1', '172.31.255.255',
    '192.168.0.1', '100.64.0.1', '192.0.0.1', '198.18.0.1', '198.19.1.1', '224.0.0.1', '240.0.0.1']) {
    assert.equal(isPrivateAddress(host), true, `${host} 应判为私有/保留`)
  }
  for (const host of ['8.8.8.8', '1.1.1.1', '172.32.0.1', '192.169.0.1', '100.128.0.1', 'sut.example']) {
    assert.equal(isPrivateAddress(host), false, `${host} 不应被判为私有`)
  }
})

test('静态校验仍然拦下本机名、内网后缀与非 http(s) 协议', () => {
  rejects('http://localhost:8080')
  rejects('http://api.internal/')
  rejects('http://printer.local/')
  rejects('ftp://sut.example/')
  rejects('file:///etc/passwd')
})

// ── 建连前复核（DNS rebinding）────────────────────────────────────────────────

const resolverOf = (addresses: readonly string[]) => async (): Promise<readonly string[]> => addresses

test('域名解析到私有地址时建连前复核拒绝（DNS rebinding）', async () => {
  await assert.rejects(
    () => assertTargetResolvedAllowed('https://evil.example/api', { resolve: resolverOf(['127.0.0.1']) }),
    /私有地址/,
  )
  await assert.rejects(
    () => assertTargetResolvedAllowed('https://evil.example/api', { resolve: resolverOf(['::ffff:10.0.0.5']) }),
    /私有地址/,
  )
})

test('解析结果里只要有一个私有地址就拒绝（失败关闭）', async () => {
  await assert.rejects(
    () => assertTargetResolvedAllowed('https://mixed.example/api', { resolve: resolverOf(['93.184.216.34', '10.0.0.1']) }),
    /私有地址/,
    '公网与内网混合解析是典型的 rebinding 手法，必须整体拒绝',
  )
})

test('全部解析到公网地址时放行', async () => {
  await assert.doesNotReject(
    () => assertTargetResolvedAllowed('https://sut.example/api', { resolve: resolverOf(['93.184.216.34', '2606:2800:220:1::1']) }),
  )
})

test('字面量地址不做 DNS 解析（静态校验已经判过）', async () => {
  let called = 0
  const resolve = async (): Promise<readonly string[]> => { called += 1; return [] }
  await assertTargetResolvedAllowed('https://93.184.216.34/api', { resolve })
  await assertTargetResolvedAllowed('https://[2606:2800:220:1::1]/api', { resolve })
  assert.equal(called, 0, '字面量地址解析它只会多一次无意义的 DNS 查询')
})

test('解析失败不当作"禁止"：连接会自然失败，报 forbidden 会误导运维', async () => {
  const failing = async (): Promise<readonly string[]> => { throw new Error('ENOTFOUND') }
  await assert.doesNotReject(() => assertTargetResolvedAllowed('https://nope.example/api', { resolve: failing }))
})

test('解析结果为空也不当作"禁止"（与解析失败同理）', async () => {
  await assert.doesNotReject(() => assertTargetResolvedAllowed('https://empty.example/api', { resolve: resolverOf([]) }))
})

test('建连前复核也会重跑静态校验（清单可能来自旧版本或已被篡改）', async () => {
  await assert.rejects(
    () => assertTargetResolvedAllowed('http://127.0.0.1/api', { resolve: resolverOf(['93.184.216.34']) }),
    /私有地址/,
    '静态判据必须一起跑，不能只信"创建时校验过一次"',
  )
})
