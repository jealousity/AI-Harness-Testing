/**
 * 受限文件读取（docs/11 P2-02）。
 *
 * `readFile()` 会**无条件**把整个文件读进内存。因此"读了之后再判字节上限"等于没有上限：
 * 一份 10 GiB 的"文档"在判据生效之前就已经把进程打爆了。
 *
 * 本模块把顺序倒过来，两道判据缺一不可：
 *
 * 1. **`stat` 先判**：大小超限就直接返回，**一个字节都不读**。
 * 2. **读取本身有界**：最多读 `maxBytes + 1` 字节。因此"`stat` 与 `read` 之间文件变大"
 *    （TOCTOU）也越不过上限——`/dev/zero` 这种 `stat().size === 0` 却读不尽的对象
 *    同样被拦住。
 *
 * 读取上限取 `min(stat.size, maxBytes + 1)` 而不是"先分配整个文件大小"：
 * 既避免为一份 1 GiB 的文件白分配 1 GiB 缓冲区，也保证缓冲区的上界与判据一致。
 *
 * @module platform-pipeline/documents/file-reader
 */

import { open, stat } from 'node:fs/promises'

/** 读取失败的原因。**语义不同，调用方必须分开处理**。 */
export type LimitedReadFailure = 'missing' | 'unreadable' | 'too-large'

export type LimitedReadResult =
  | { readonly ok: true; readonly bytes: Uint8Array; readonly size: number }
  | {
    readonly ok: false
    readonly reason: LimitedReadFailure
    readonly detail: string
    /** 已知的文件大小（`too-large` 时必定有值，便于运维判断量级）。 */
    readonly size?: number
  }

/**
 * 单次读取的块大小：`[64 KiB, 4 MiB]`，随声明大小自适应。
 *
 * 为什么要分块而不是"按 stat 声明的大小一次读完"：声明大小可能小于真实内容
 * （`stat` 与 `read` 之间的竞态）。一次读完就会拿到一个**被静默截断的前缀**，
 * 而截断的文档最危险的地方在于它看起来是成功的——解析器会给出 `parsed`
 * 和一份不完整的内容。分块读到 EOF 才能同时满足两件事：
 * 拿到完整内容，且总量一旦超过上限立刻停。
 *
 * 上界因此是 `maxBytes + readChunkSize(statSize)`（最坏多读一个块）。
 * 单独抽成纯函数是为了让这个上界可被直接断言。
 */
export function readChunkSize(statSize: number): number {
  return Math.min(Math.max(statSize, 64 * 1024), 4 * 1024 * 1024)
}

/**
 * 按上限读取文件。
 *
 * 不抛异常：所有失败都编码在返回值里（调用方要把它映射成结构化诊断，
 * 而不是让一次读取失败冒泡成未处理异常）。
 */
export async function readFileWithinLimit(path: string, maxBytes: number): Promise<LimitedReadResult> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new Error(`file byte limit must be a positive integer: ${maxBytes}`)
  }

  let size: number
  try {
    const info = await stat(path)
    if (!info.isFile()) return { ok: false, reason: 'unreadable', detail: `${path} 不是普通文件` }
    size = info.size
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { ok: false, reason: 'missing', detail: `${path} 不存在` }
    }
    return { ok: false, reason: 'unreadable', detail: errorMessage(error) }
  }

  // 第一道判据：超限就直接返回，**不读内容**。
  if (size > maxBytes) {
    return { ok: false, reason: 'too-large', detail: `文档 ${size} 字节超过上限 ${maxBytes} 字节`, size }
  }

  // 第二道判据：读 `maxBytes + 1` 字节。多读的那 1 字节是**判据本身**——
  // 能读出第 maxBytes + 1 个字节就说明真实内容超限，而我们已经不需要再读更多。
  let handle: Awaited<ReturnType<typeof open>>
  try {
    handle = await open(path, 'r')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { ok: false, reason: 'missing', detail: `${path} 在读取前消失` }
    }
    return { ok: false, reason: 'unreadable', detail: errorMessage(error) }
  }

  try {
    const chunkSize = readChunkSize(size)
    const chunks: Buffer[] = []
    let total = 0
    for (;;) {
      const buffer = Buffer.allocUnsafe(chunkSize)
      const { bytesRead } = await handle.read(buffer, 0, chunkSize, null)
      if (bytesRead === 0) break
      total += bytesRead
      if (total > maxBytes) {
        // 真实内容超过上限：`stat` 没看出来（文件在两次调用之间变大）。
        // 停下并**显式失败**，绝不把已读到的前缀当成完整文档返回。
        return {
          ok: false, reason: 'too-large',
          detail: `文档实际内容超过上限 ${maxBytes} 字节（读取到 ${total} 字节）`,
          size: total,
        }
      }
      chunks.push(buffer.subarray(0, bytesRead))
    }
    return { ok: true, bytes: new Uint8Array(chunks.length === 1 ? chunks[0]! : Buffer.concat(chunks)), size: total }
  } catch (error) {
    return { ok: false, reason: 'unreadable', detail: errorMessage(error) }
  } finally {
    await handle.close().catch(() => undefined)
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
