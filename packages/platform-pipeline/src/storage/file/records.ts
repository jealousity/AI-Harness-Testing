/**
 * 项目级键值记录的文件实现（docs/11 §二「事实来源统一」）。
 *
 * 落盘布局：`<baseDir>/<collection>/<id>.json`。集合名允许一层 `/`
 * （幂等台账用 `idempotency/<namespace>` 才能保持既有布局不变），但每一段都必须是
 * 安全标识符，且**拒绝 `..` 与绝对路径**——否则一个来自请求的 collection 就能把记录
 * 写到项目目录之外。
 *
 * 三条硬性质（与端口注释一致）：
 * - 缺失 → `null`；**损坏 → 抛 `StorageCorruptError`**（不降级成"没有记录"）；
 * - `write` 原子（tmp → rename）：任何时刻要么没有记录，要么是一条完整记录；
 * - `createIfAbsent` 用 `wx` 独占创建：**先写者胜**，已存在返回 false。
 *
 * @module platform-pipeline/storage/file/records
 */

import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'

import {
  StorageCorruptError,
  assertHostRecordKey,
  StorageUnavailableError,
  checkAndStripSchemaVersion,
  withSchemaVersion,
  type HostRecord,
  type HostRecordStore,
} from '../ports.ts'

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function createFileHostRecordStore(baseDir: string): HostRecordStore {
  // 坐标校验走**共享**校验器（`assertHostRecordKey`），保证文件后端与内存后端
  // 对"哪些 collection/id 合法"给出同一答案。
  const pathOf = (collection: string, id: string): string => {
    assertHostRecordKey(collection, id)
    return join(baseDir, collection, `${id}.json`)
  }

  return {
    async read(collection, id) {
      const path = pathOf(collection, id)
      let raw: string
      try {
        raw = await readFile(path, 'utf8')
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
        throw new StorageUnavailableError('file', `read ${collection}/${id}`, errorMessage(error), { cause: error })
      }
      let parsed: unknown
      try {
        parsed = JSON.parse(raw)
      } catch (error) {
        throw new StorageCorruptError(`${collection}/${id}`, 'record', `不是合法 JSON（${errorMessage(error)}）`)
      }
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new StorageCorruptError(`${collection}/${id}`, 'record', '顶层不是对象')
      }
      return checkAndStripSchemaVersion(`${collection}/${id}`, 'record', parsed as Record<string, unknown>)
    },

    async write(collection, id, value) {
      const target = pathOf(collection, id)
      await mkdir(dirname(target), { recursive: true })
      const temp = `${target}.${process.pid}.${randomUUID()}.tmp`
      await writeFile(temp, `${JSON.stringify(withSchemaVersion(value as Record<string, unknown>), null, 2)}\n`, 'utf8')
      await rename(temp, target)
    },

    async createIfAbsent(collection, id, value) {
      const target = pathOf(collection, id)
      await mkdir(dirname(target), { recursive: true })
      try {
        await writeFile(target, `${JSON.stringify(withSchemaVersion(value as Record<string, unknown>), null, 2)}\n`, {
          encoding: 'utf8',
          flag: 'wx',
        })
        return true
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false
        throw new StorageUnavailableError('file', `create ${collection}/${id}`, errorMessage(error), { cause: error })
      }
    },

    async listIds(collection) {
      assertHostRecordKey(collection, 'collection-probe')
      let names: string[]
      try {
        names = await readdir(join(baseDir, collection))
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
        throw new StorageUnavailableError('file', `list ${collection}`, errorMessage(error), { cause: error })
      }
      return names.filter(name => name.endsWith('.json')).map(name => name.replace(/\.json$/, '')).sort()
    },

    async list(collection) {
      const records: HostRecord[] = []
      for (const id of await this.listIds(collection)) {
        records.push({ id, value: await this.read(collection, id) })
      }
      return records
    },

    async remove(collection, id) {
      await rm(pathOf(collection, id), { force: true })
    },
  }
}
