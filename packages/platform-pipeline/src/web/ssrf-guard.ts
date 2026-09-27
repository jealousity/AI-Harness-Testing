/**
 * `targetBaseUrl` 的 SSRF 防线（docs/10 §5.3「不能默认访问本机和内网」、docs/11 P2-04）。
 *
 * 两道判据，**时机不同、职责不同，缺一不可**：
 *
 * | 判据 | 时机 | 做什么 |
 * |---|---|---|
 * | {@link assertTargetBaseUrlAllowed} | 创建流水线时 | 纯字面量校验：协议、本机名、内网后缀、私有/保留地址、userinfo。无副作用、不解析 DNS |
 * | {@link assertTargetResolvedAllowed} | **每次建连之前** | 先重跑字面量校验，再解析域名并复核**实际对端地址** |
 *
 * 为什么必须两道：创建时的校验只能证明"那个时刻那个字符串看起来安全"。域名可以
 * 在那之后解析到别处（DNS rebinding），清单又是磁盘文件、可能来自旧版本或被篡改。
 * 因此建连前必须**重新判一次**，而且这次要判解析结果。
 *
 * ## 错误消息不得回显原始 URL
 *
 * URL 里可能带凭据（`http://user:pass@host`）或令牌（`?access_token=…`），
 * 而错误消息会进日志、进 HTTP 响应、进 agent 上下文。因此所有消息都用
 * {@link safeTargetUrlForMessage} 重建：只保留 `协议//主机/路径`。
 * 同时 **userinfo 本身就直接拒绝**——凭据不该写进配置，更不该被原样落盘。
 *
 * @module platform-pipeline/web/ssrf-guard
 */

import { lookup } from 'node:dns/promises'

import { PipelineRunError } from './pipeline-run-types.ts'

/** 域名 → 地址列表。注入点：测试用受控替身，生产用 `node:dns`。 */
export type ResolveHost = (host: string) => Promise<readonly string[]>

/**
 * 把 URL 重建成可以安全写进消息/日志的形式：**丢掉 userinfo、查询串与片段**。
 *
 * 路径保留是为了让运维能定位到具体入口（`/api/login` 与 `/api/pay` 是不同的风险面），
 * 而查询串常常直接携带令牌，一律不保留。
 */
export function safeTargetUrlForMessage(url: URL): string {
  const path = url.pathname === '' ? '' : url.pathname
  return `${url.protocol}//${url.host}${path}`
}

/**
 * 字面量校验。**不解析 DNS**（因此它不能单独防 DNS rebinding，见模块注释）。
 *
 * 拒绝：非 http(s) 协议、userinfo、本机名、`.internal`/`.local` 后缀、
 * 回环/私有/链路本地/CGNAT/保留/组播地址（含 IPv4-mapped IPv6 形式）。
 */
export function assertTargetBaseUrlAllowed(rawUrl: string): void {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    // 连 URL 都解析不了时也不能回显原文：它同样可能带着凭据。
    throw new PipelineRunError('invalid-request', 'targetBaseUrl 不是合法 URL（不回显原文，避免泄露其中的凭据）')
  }
  const safe = safeTargetUrlForMessage(url)
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new PipelineRunError('invalid-request', `targetBaseUrl 只允许 http/https：${safe}`, { protocol: url.protocol })
  }
  // userinfo 直接拒绝，而不是"剥掉后继续"：写进配置就说明凭据已经在磁盘上了，
  // 静默剥掉只会让人以为它生效了。
  if (url.username !== '' || url.password !== '') {
    throw new PipelineRunError(
      'invalid-request',
      `targetBaseUrl 不允许携带 userinfo（凭据不得写进 URL）：${safe}；请改用宿主侧的环境变量注入`,
      { host: url.host },
    )
  }
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal') || host.endsWith('.local')) {
    throw new PipelineRunError('forbidden', `targetBaseUrl 不允许指向本机/内网：${safe}`, { host })
  }
  if (isPrivateAddress(host)) {
    throw new PipelineRunError('forbidden', `targetBaseUrl 不允许指向私有地址：${safe}`, { host })
  }
}

export interface AssertTargetResolvedOptions {
  readonly resolve?: ResolveHost
}

/**
 * 建连前的**解析后**复核（防 DNS rebinding）。
 *
 * 语义要点：
 * - **先重跑字面量校验**：清单是磁盘文件，不能只信"创建时校验过一次"；
 * - **字面量地址不解析**：它已经在静态校验里判过了，再查一次 DNS 只是白花钱；
 * - **只要有一个解析结果是私有地址就拒绝**（失败关闭）：公网 + 内网混合解析
 *   正是 rebinding 的典型手法，逐个挑公网的放行等于没防；
 * - **解析失败 / 结果为空不当作"禁止"**：那种情况下根本连不上，
 *   报 `forbidden` 会把一次 DNS 抖动说成"这个目标不允许访问"，误导运维。
 */
export async function assertTargetResolvedAllowed(
  rawUrl: string,
  options: AssertTargetResolvedOptions = {},
): Promise<void> {
  assertTargetBaseUrlAllowed(rawUrl)
  const url = new URL(rawUrl)
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (isIpLiteral(host)) return

  const resolve = options.resolve ?? defaultResolve
  let addresses: readonly string[]
  try {
    addresses = await resolve(host)
  } catch {
    // 解析不了就连不上；让连接自己失败并给出真实的网络错误。
    return
  }
  for (const address of addresses) {
    if (isPrivateAddress(address.toLowerCase())) {
      throw new PipelineRunError(
        'forbidden',
        `targetBaseUrl 的域名解析到私有地址，拒绝建连：${safeTargetUrlForMessage(url)} → ${address}`,
        { host, address },
      )
    }
  }
}

async function defaultResolve(host: string): Promise<readonly string[]> {
  const records = await lookup(host, { all: true })
  return records.map(record => record.address)
}

/** 是不是 IP 字面量（v4 点分或 v6 含冒号）。 */
function isIpLiteral(host: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(':')
}

/**
 * 私有/保留地址判定。
 *
 * **必须覆盖 IPv4-mapped IPv6**（`::ffff:127.0.0.1`、`::ffff:7f00:1`）：它是 v6 写法，
 * 但连的是 v4 回环地址。只按"含冒号 = v6"去匹配 `fc00::/7`、`fe80::/10` 会漏掉它，
 * 于是 `http://[::ffff:127.0.0.1]/` 就成了绕过 SSRF 的现成写法。
 */
export function isPrivateAddress(host: string): boolean {
  const normalized = host.toLowerCase().replace(/^\[|\]$/g, '')
  // IPv4-mapped（::ffff:x）与已废弃的 IPv4-compatible（::x）：剥出内嵌的 v4 再判。
  const embedded = embeddedIpv4(normalized)
  if (embedded !== null) return isPrivateAddress(embedded)

  if (normalized === '::1' || normalized === '::' || normalized === '0.0.0.0') return true
  // IPv6 唯一本地 fc00::/7 与链路本地 fe80::/10
  if (/^f[cd][0-9a-f]{0,2}:/i.test(normalized) || /^fe[89ab][0-9a-f]?:/i.test(normalized)) return true

  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(normalized)
  if (match === null) return false
  const octets = [Number(match[1]), Number(match[2]), Number(match[3]), Number(match[4])]
  if (octets.some(value => value > 255)) return false
  const [a, b] = octets as [number, number, number, number]
  if (a === 0 || a === 10 || a === 127) return true
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 192 && b === 168) return true
  if (a === 192 && b === 0) return true // 192.0.0.0/24（含 192.0.0.1 之类的特殊用途）
  if (a === 169 && b === 254) return true
  if (a === 100 && b >= 64 && b <= 127) return true
  if (a === 198 && (b === 18 || b === 19)) return true // 基准测试网段
  if (a >= 224) return true // 组播 224/4 与保留 240/4
  return false
}

/** 从 IPv4-mapped/compatible 的 v6 写法里剥出内嵌的 v4 点分地址。 */
function embeddedIpv4(host: string): string | null {
  const dotted = /^::(?:ffff:)?(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(host)
  if (dotted !== null) return dotted[1]!
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(host)
  if (hex === null) return null
  const high = Number.parseInt(hex[1]!, 16)
  const low = Number.parseInt(hex[2]!, 16)
  return [high >> 8, high & 0xff, low >> 8, low & 0xff].join('.')
}
