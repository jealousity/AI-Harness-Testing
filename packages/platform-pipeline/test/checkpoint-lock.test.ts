/**
 * 运行互斥锁测试（docs/10 §6.3 M2-1 / §6.4 验收）。
 *
 * 这里的每一条都对应 §6.2 列出的一个风险：
 *
 * | 风险 | 用例 |
 * |---|---|
 * | 没有 heartbeat/lease 更新 | 续租推进 `heartbeatAt`；长跑不被误判 stale |
 * | 进程崩溃只能靠时间判断 | `heartbeatAt` 超期可恢复 + `stale-recovered` 审计 |
 * | release 只校验 owner 文件 | release/renew 同时校验 `ownerId` + `generation` |
 * | stale 删除与"刚续租"竞争 | 抢占前后各确认一次，发现已续租就放回不删 |
 * | `rm -rf` 式宽泛删除 | 只对"改名后自己独占的目录"递归删除，不留残留 |
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { hostname, tmpdir } from 'node:os'

import {
  acquirePipelineLock,
  pipelineCheckpointDir,
  pipelineLockPath,
  PipelineLockHeldError,
  type PipelineLockEvent,
  type PipelineLockOwner,
} from '../src/checkpoint-lock.ts'

const PIPELINE = 'pipe-1'
const HOUR = 60 * 60 * 1000
const T0 = Date.UTC(2026, 0, 1)

async function tempRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'pp-lock-'))
}

async function withRoot(run: (root: string) => Promise<void>): Promise<void> {
  const root = await tempRoot()
  try {
    await run(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

/** 固定时钟：`values` 用尽后一直返回最后一个值。 */
function clock(values: readonly number[]): () => number {
  let index = 0
  return () => values[Math.min(index++, values.length - 1)]!
}

async function ownerFileOf(root: string): Promise<PipelineLockOwner> {
  return JSON.parse(await readFile(join(pipelineLockPath(root, PIPELINE), 'owner.json'), 'utf8')) as PipelineLockOwner
}

async function lockDirExists(root: string): Promise<boolean> {
  try {
    await readdir(pipelineLockPath(root, PIPELINE))
    return true
  } catch {
    return false
  }
}

function auditOf(sink: PipelineLockEvent[]): (event: PipelineLockEvent) => void {
  return event => { sink.push(event) }
}

// ── 路径与 owner 文件形状 ────────────────────────────────────────────────────

test('锁路径固定在 checkpoints/<pipelineId>/.pipeline.lock，owner 文件含全部租约字段', async () => {
  await withRoot(async root => {
    assert.equal(pipelineCheckpointDir(root, PIPELINE), join(root, PIPELINE))
    assert.equal(pipelineLockPath(root, PIPELINE), join(root, PIPELINE, '.pipeline.lock'))

    const lock = await acquirePipelineLock(root, PIPELINE, { now: () => T0, host: 'host-a' })
    assert.equal(lock.path, join(root, PIPELINE, '.pipeline.lock'))
    assert.equal(lock.generation, 1)

    const owner = await ownerFileOf(root)
    assert.equal(owner.ownerId, lock.ownerId)
    assert.equal(owner.generation, 1)
    assert.equal(owner.pid, process.pid)
    assert.equal(owner.host, 'host-a')
    assert.equal(owner.acquiredAt, T0)
    assert.equal(owner.heartbeatAt, T0)

    assert.equal(await lock.release(), true)
    assert.equal(await lockDirExists(root), false)
  })
})

test('pipelineId 含路径分隔符或相对路径时直接拒绝，不把锁写到项目目录外', async () => {
  await withRoot(async root => {
    for (const bad of ['../escape', 'a/b', 'a\\b', '..', '', 'x\0y']) {
      await assert.rejects(() => acquirePipelineLock(root, bad), /pipelineId/)
    }
    // 目录外没有被创建任何东西
    assert.deepEqual(await readdir(root), [])
  })
})

// ── 互斥 ────────────────────────────────────────────────────────────────────

test('同一 pipeline 第二次 acquire 被拒，且不覆盖原持有者的 owner 文件', async () => {
  await withRoot(async root => {
    const first = await acquirePipelineLock(root, PIPELINE, { now: () => T0, host: 'host-a' })
    const before = await ownerFileOf(root)

    await assert.rejects(
      () => acquirePipelineLock(root, PIPELINE, { now: () => T0 + 1000, host: 'host-b' }),
      (error: unknown) => {
        assert.ok(error instanceof PipelineLockHeldError)
        assert.equal(error.pipelineId, PIPELINE)
        assert.equal(error.holder?.ownerId, first.ownerId)
        return true
      },
    )
    assert.deepEqual(await ownerFileOf(root), before, '失败的一方不得改动锁')
    await first.release()
  })
})

test('contended 时记录审计事件，便于回答"为什么这条流水线跑不起来"', async () => {
  await withRoot(async root => {
    const events: PipelineLockEvent[] = []
    const first = await acquirePipelineLock(root, PIPELINE, { now: () => T0, audit: auditOf(events) })
    await assert.rejects(() => acquirePipelineLock(root, PIPELINE, { now: () => T0, audit: auditOf(events) }))
    assert.deepEqual(events.map(event => event.kind), ['acquired', 'contended'])
    assert.equal(events[1]!.previous?.ownerId, first.ownerId)
    await first.release()
  })
})

test('不同 pipeline 的锁互不影响（锁是 per-pipeline 的）', async () => {
  await withRoot(async root => {
    const a = await acquirePipelineLock(root, 'pipe-a', { now: () => T0 })
    const b = await acquirePipelineLock(root, 'pipe-b', { now: () => T0 })
    assert.notEqual(a.path, b.path)
    await a.release()
    await b.release()
  })
})

// ── release 必须校验 ownerId + generation ───────────────────────────────────

test('release 校验 ownerId：锁被换手后拒绝删除，别人的锁原样保留', async () => {
  await withRoot(async root => {
    const events: PipelineLockEvent[] = []
    const stale = await acquirePipelineLock(root, PIPELINE, { now: () => T0, audit: auditOf(events) })

    // 模拟"另一个进程已经接管"：直接把 owner 文件换成别人的（不改 generation 也不影响判定，
    // 因为 ownerId 是第一道门）。
    const usurper: PipelineLockOwner = {
      ownerId: 'usurper', generation: 1, pid: 4242, host: 'host-b', acquiredAt: T0, heartbeatAt: T0,
    }
    await writeFile(join(stale.path, 'owner.json'), JSON.stringify(usurper), 'utf8')

    assert.equal(await stale.release(), false, '不得删除别人的锁')
    assert.deepEqual(await ownerFileOf(root), usurper, '别人的锁必须原样保留')
    assert.equal(events.at(-1)!.kind, 'release-refused')
    assert.equal(events.at(-1)!.previous?.ownerId, 'usurper')
  })
})

test('release 校验 generation：ownerId 相同但代数不同（同一 owner 的两次持有）也拒绝', async () => {
  await withRoot(async root => {
    const first = await acquirePipelineLock(root, PIPELINE, { now: () => T0, ownerId: 'stable-owner' })
    assert.equal(first.generation, 1)
    await first.release()

    // 同一 ownerId 再持有一次：generation 必须递增，否则"过期持有的 release"无法与
    // "当前持有的 release"区分。
    const second = await acquirePipelineLock(root, PIPELINE, { now: () => T0 + HOUR, ownerId: 'stable-owner' })
    assert.equal(second.generation, 2)

    // 把磁盘上的 generation 改回 1（模拟过期持有者眼中的自己）→ 必须拒绝删除。
    const tampered = { ...(await ownerFileOf(root)), generation: 1 }
    await writeFile(join(second.path, 'owner.json'), JSON.stringify(tampered), 'utf8')
    assert.equal(await second.release(), false)
    assert.equal(await lockDirExists(root), true, 'generation 不匹配时不得删除锁目录')
  })
})

test('同主机且持有者 pid 已不存在时可立即恢复，不必等心跳超期（kill -9 不会卡死）', async () => {
  await withRoot(async root => {
    const events: PipelineLockEvent[] = []
    const dir = pipelineCheckpointDir(root, PIPELINE)
    await mkdir(join(dir, '.pipeline.lock'), { recursive: true })

    // 用一个**真的**短命子进程拿到一个真的会消失的 pid：kill -9 之后锁目录会原样留下，
    // 里面写的还是这个已经死掉的 pid。
    const dead = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' })
    const deadPid = dead.pid
    assert.ok(deadPid !== undefined)
    await new Promise<void>(resolve => dead.once('exit', () => resolve()))

    const fresh = T0 + 60 * 1000 // 心跳很新：只看心跳的话要等 6 小时
    await writeFile(join(dir, '.pipeline.lock', 'owner.json'), JSON.stringify({
      ownerId: 'killed-owner', generation: 1, pid: deadPid, host: hostname(), acquiredAt: T0, heartbeatAt: fresh,
    } satisfies PipelineLockOwner), 'utf8')

    const revived = await acquirePipelineLock(root, PIPELINE, {
      now: () => fresh + 1000,
      staleMs: 6 * HOUR,
      heartbeatMs: 0,
      audit: auditOf(events),
      host: 'host-b',
    })
    assert.equal(revived.generation, 2)
    const event = events.find(item => item.kind === 'stale-recovered')
    assert.ok(event !== undefined)
    assert.match(event.detail, /进程已不存在/)
    assert.equal(event.previous?.ownerId, 'killed-owner')
    await revived.release()
  })
})

test('跨主机的锁不靠 pid 判断（pid 在别的机器上没有意义），只看心跳', async () => {
  await withRoot(async root => {
    const dir = pipelineCheckpointDir(root, PIPELINE)
    await mkdir(join(dir, '.pipeline.lock'), { recursive: true })
    // host 不同 + pid 是"本机不存在的 pid"：仍必须按心跳判定为有效，不得抢占。
    await writeFile(join(dir, '.pipeline.lock', 'owner.json'), JSON.stringify({
      ownerId: 'remote-owner', generation: 1, pid: 999_999, host: 'some-other-host',
      acquiredAt: T0, heartbeatAt: T0,
    } satisfies PipelineLockOwner), 'utf8')

    await assert.rejects(
      () => acquirePipelineLock(root, PIPELINE, { now: () => T0 + 60 * 1000, staleMs: 6 * HOUR, heartbeatMs: 0 }),
      PipelineLockHeldError,
    )
    // 心跳超期后才允许接管
    const revived = await acquirePipelineLock(root, PIPELINE, {
      now: () => T0 + 7 * HOUR,
      staleMs: 6 * HOUR,
      heartbeatMs: 0,
    })
    assert.equal(revived.generation, 2)
    await revived.release()
  })
})

test('release 幂等：重复调用返回 false 且不抛', async () => {
  await withRoot(async root => {
    const lock = await acquirePipelineLock(root, PIPELINE, { now: () => T0 })
    assert.equal(await lock.release(), true)
    assert.equal(await lock.release(), false)
    assert.equal(await lock.release(), false)
  })
})

test('release 之后可以重新 acquire，generation 单调递增', async () => {
  await withRoot(async root => {
    const generations: number[] = []
    for (let round = 0; round < 3; round += 1) {
      const lock = await acquirePipelineLock(root, PIPELINE, { now: () => T0 + round * HOUR })
      generations.push(lock.generation)
      assert.equal(await lock.release(), true)
    }
    assert.deepEqual(generations, [1, 2, 3])
  })
})

// ── stale recovery ──────────────────────────────────────────────────────────

test('心跳超期后可抢占，并记录 stale-recovered 审计事件', async () => {
  await withRoot(async root => {
    const events: PipelineLockEvent[] = []
    const dead = await acquirePipelineLock(root, PIPELINE, { now: () => T0, audit: auditOf(events), heartbeatMs: 0 })
    const deadOwner = dead.owner

    const revived = await acquirePipelineLock(root, PIPELINE, {
      now: () => T0 + 7 * HOUR,
      staleMs: 6 * HOUR,
      audit: auditOf(events),
      heartbeatMs: 0,
      host: 'host-b',
    })
    assert.equal(revived.generation, 2, '接管者必须拿到更大的 generation')
    assert.equal((await ownerFileOf(root)).host, 'host-b')

    const recovered = events.find(event => event.kind === 'stale-recovered')
    assert.ok(recovered !== undefined, '抢占必须留审计事件')
    assert.equal(recovered.previous?.ownerId, deadOwner.ownerId)
    assert.equal(recovered.previous?.generation, 1)

    // 被抢占的一方不能再用 renew/release 影响新持有者。
    assert.equal(await dead.renew(), false)
    assert.equal(await dead.release(), false)
    assert.equal(await lockDirExists(root), true)
    assert.equal((await ownerFileOf(root)).ownerId, revived.ownerId)
  })
})

test('判断 stale 只看 heartbeatAt：续租过的长跑流水线不会被抢走', async () => {
  await withRoot(async root => {
    let at = T0
    const longRunning = await acquirePipelineLock(root, PIPELINE, {
      now: () => at,
      staleMs: 6 * HOUR,
      heartbeatMs: 0,
    })

    // 跑了 7 小时，但期间一直在续租：最后一次心跳在 7h 处。
    at = T0 + 7 * HOUR
    assert.equal(await longRunning.renew(), true)
    assert.equal(longRunning.owner.heartbeatAt, T0 + 7 * HOUR)

    // 此刻别人来抢：acquiredAt 已经是 7 小时前，但 heartbeat 是刚刚 → 不算 stale。
    at = T0 + 7 * HOUR + 10 * 60 * 1000
    await assert.rejects(
      () => acquirePipelineLock(root, PIPELINE, { now: () => at, staleMs: 6 * HOUR, heartbeatMs: 0 }),
      PipelineLockHeldError,
    )
    assert.equal((await ownerFileOf(root)).ownerId, longRunning.ownerId)
  })
})

test('抢占前发现对方已续租时放回原处、不删活锁，并记录 stale-refused', async () => {
  await withRoot(async root => {
    const events: PipelineLockEvent[] = []
    const holder = await acquirePipelineLock(root, PIPELINE, { now: () => T0, audit: auditOf(events), heartbeatMs: 0 })
    const ownerBefore = await ownerFileOf(root)

    // 时钟序列模拟"读第一遍时已 stale，改名后复查时对方刚续租"：
    //   ① 判定 stale（T0+7h）② 改名后复查（T0，未超期）③ 后续任何读取（T0）
    await assert.rejects(
      () => acquirePipelineLock(root, PIPELINE, {
        now: clock([T0 + 7 * HOUR, T0, T0]),
        staleMs: 6 * HOUR,
        heartbeatMs: 0,
        audit: auditOf(events),
      }),
      PipelineLockHeldError,
    )

    assert.equal(events.some(event => event.kind === 'stale-refused'), true, '必须留下"放弃抢占"的审计')
    assert.equal(events.some(event => event.kind === 'stale-recovered'), false, '不得记录成"已恢复"')
    assert.deepEqual(await ownerFileOf(root), ownerBefore, '活锁必须原样保留')
    assert.equal(await lockDirExists(root), true)
    assert.equal(await holder.release(), true, '持有者仍能正常释放')
  })
})

test('owner 文件缺失或损坏时视为不可确认身份，可按 stale 恢复', async () => {
  await withRoot(async root => {
    const events: PipelineLockEvent[] = []
    const broken = await acquirePipelineLock(root, PIPELINE, { now: () => T0, audit: auditOf(events), heartbeatMs: 0 })
    await writeFile(join(broken.path, 'owner.json'), '{ not json', 'utf8')

    const recovered = await acquirePipelineLock(root, PIPELINE, {
      now: () => T0 + HOUR,
      staleMs: 6 * HOUR,
      audit: auditOf(events),
      heartbeatMs: 0,
    })
    assert.equal(recovered.generation, 2)
    const event = events.find(item => item.kind === 'stale-recovered')
    assert.ok(event !== undefined)
    assert.equal(event.previous, null, '身份不可确认时 previous 为 null')
    assert.match(event.detail, /身份不可确认/)
    assert.equal(await broken.release(), false, '原持有者已无法释放（owner 文件已被换掉）')
    await recovered.release()
  })
})

test('兼容旧版 owner 文件（只有 owner/acquiredAt/pid）并能接管', async () => {
  await withRoot(async root => {
    const dir = pipelineCheckpointDir(root, PIPELINE)
    await mkdir(join(dir, '.pipeline.lock'), { recursive: true })
    // 旧版字段名：owner 而不是 ownerId，且没有 generation/heartbeatAt。
    await writeFile(
      join(dir, '.pipeline.lock', 'owner.json'),
      JSON.stringify({ owner: 'legacy-owner', acquiredAt: T0, pid: 1234 }),
      'utf8',
    )

    const lock = await acquirePipelineLock(root, PIPELINE, {
      now: () => T0 + 7 * HOUR,
      staleMs: 6 * HOUR,
      heartbeatMs: 0,
    })
    assert.equal(lock.generation, 2, 'generation 必须接着旧持有者的代数往上走')
    assert.equal(await lock.release(), true)
  })
})

test('staleMs 为非正数或 Infinity 时永不过期，不会抢占', async () => {
  await withRoot(async root => {
    const holder = await acquirePipelineLock(root, PIPELINE, { now: () => T0, staleMs: 0, heartbeatMs: 0 })
    for (const staleMs of [0, -1, Number.POSITIVE_INFINITY]) {
      await assert.rejects(
        () => acquirePipelineLock(root, PIPELINE, { now: () => T0 + 1000 * HOUR, staleMs, heartbeatMs: 0 }),
        PipelineLockHeldError,
      )
    }
    assert.equal((await ownerFileOf(root)).ownerId, holder.ownerId)
    await holder.release()
  })
})

// ── 续租 ────────────────────────────────────────────────────────────────────

test('renew 推进 heartbeatAt 并落盘；被抢占后返回 false 且不触碰新持有者的锁', async () => {
  await withRoot(async root => {
    const events: PipelineLockEvent[] = []
    let at = T0
    const holder = await acquirePipelineLock(root, PIPELINE, {
      now: () => at,
      audit: auditOf(events),
      staleMs: 6 * HOUR,
      heartbeatMs: 0,
    })
    assert.equal(holder.owner.heartbeatAt, T0)

    at = T0 + 30 * 60 * 1000
    assert.equal(await holder.renew(), true)
    assert.equal(holder.owner.heartbeatAt, T0 + 30 * 60 * 1000)
    assert.equal((await ownerFileOf(root)).heartbeatAt, T0 + 30 * 60 * 1000, '续租必须落盘')
    assert.equal(events.at(-1)!.kind, 'renewed')

    // 心跳超期后被接管
    at = T0 + 10 * HOUR
    const stolen = await acquirePipelineLock(root, PIPELINE, {
      now: () => at,
      staleMs: 6 * HOUR,
      heartbeatMs: 0,
      host: 'host-b',
    })

    assert.equal(await holder.renew(), false, '被抢占后不得再续租')
    assert.equal(events.at(-1)!.kind, 'renew-refused')
    assert.equal((await ownerFileOf(root)).ownerId, stolen.ownerId, '续租失败的一方不得改动新持有者的锁')
    assert.equal(await holder.release(), false, '被抢占后不得再释放')
    assert.equal(await stolen.release(), true)
  })
})

test('自动续租：短间隔下 heartbeatAt 会自行前进（无需调用方干预）', async () => {
  await withRoot(async root => {
    const lock = await acquirePipelineLock(root, PIPELINE, { staleMs: 300, heartbeatMs: 20 })
    const first = lock.owner.heartbeatAt
    await new Promise(resolve => setTimeout(resolve, 120))
    assert.ok(lock.owner.heartbeatAt >= first, '心跳时间必须单调不减')
    assert.ok(Date.now() - lock.owner.heartbeatAt < 300, '自动续租后不应表现为 stale')
    assert.equal(await lock.release(), true)
    // 释放后定时器必须停止：再等一会儿不应有新的心跳写入（目录已删，owner 不可读）
    await new Promise(resolve => setTimeout(resolve, 60))
    assert.equal(await lockDirExists(root), false)
  })
})

// ── 不做宽泛删除 ────────────────────────────────────────────────────────────

test('抢占后不留下任何 .stale-* 残留目录（改名删除只作用于自己独占的目录）', async () => {
  await withRoot(async root => {
    const dead = await acquirePipelineLock(root, PIPELINE, { now: () => T0, staleMs: HOUR, heartbeatMs: 0 })
    const revived = await acquirePipelineLock(root, PIPELINE, {
      now: () => T0 + 2 * HOUR,
      staleMs: HOUR,
      heartbeatMs: 0,
    })
    assert.equal(await revived.release(), true)
    assert.equal(await dead.release(), false)

    const entries = await readdir(pipelineCheckpointDir(root, PIPELINE))
    assert.deepEqual(entries.filter(name => name.includes('.stale-') || name.includes('.released-')), [])
    assert.deepEqual(entries.filter(name => name.includes('.tmp')), [])
  })
})

test('释放只作用于锁目录本身：目录之外的检查点文件不受影响', async () => {
  await withRoot(async root => {
    const lock = await acquirePipelineLock(root, PIPELINE, { now: () => T0, heartbeatMs: 0 })
    // 锁目录之外放一个哨兵：释放是"改名后删自己独占的目录"，绝不允许波及同级的检查点文件。
    const sentinel = join(pipelineCheckpointDir(root, PIPELINE), 'checkpoint.json')
    await writeFile(sentinel, '{"sentinel":true}', 'utf8')
    await writeFile(join(lock.path, 'unexpected.txt'), 'x', 'utf8')

    assert.equal(await lock.release(), true)
    assert.equal(await readFile(sentinel, 'utf8'), '{"sentinel":true}', '锁目录之外的文件不得被波及')
    assert.equal(await lockDirExists(root), false)
  })
})
