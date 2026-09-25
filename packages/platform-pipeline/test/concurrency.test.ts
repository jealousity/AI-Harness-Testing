/**
 * 双进程与 kill/restart 并发测试（docs/10 §6.4 验收）。
 *
 * 为什么必须用**真实子进程**：`checkpoint-lock.ts` 的互斥原语是 `mkdir` + `owner.json`，
 * 它要回答的问题全是"另一个进程此刻在干什么"——同进程内的模拟（比如注入一个假的
 * `now()`）能验证判据的**逻辑**，但验证不了判据在真实进程生命周期下的行为：
 * `pid` 是否真的能探测到死亡、`generation` 是否真的跨进程单调、被 `SIGKILL` 的进程
 * 是否真的没机会释放锁。
 *
 * 覆盖的 §6.4 条目：
 *
 * | 验收 | 用例 |
 * |---|---|
 * | 两个进程同时 run 同一 pipeline，只有一个能推进 | `只有一个进程能推进` |
 * | kill -9 后重启可恢复或明确标记 stale，不会卡死永久 | `SIGKILL 后新进程立刻接管` |
 * | release 不会误删其他 owner 的锁 | `被抢锁后旧持有者的 release 被拒` |
 * | stale lock 可恢复但不删新进程刚取得的锁 | 同上（旧持有者 release 后锁仍属新持有者） |
 *
 * 工作进程脚本在运行时写入临时目录，通过 `PP_PKG_ROOT` 指回包根——
 * 这样它 import 的就是被测的**同一份**源码（Node 直接执行 `.ts`），不存在副本漂移。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

import { lockAuditPath, pipelineLockPath } from '../src/checkpoint-lock.ts'
import { resolvePlatformRoots } from '../src/platform-roots.ts'
import { baseConfig } from './web-fixtures.ts'

const PACKAGE_ROOT = fileURLToPath(new URL('..', import.meta.url))
const PIPELINE = 'pipe-1'
/** 子进程给足时间启动（Node 首次编译 `.ts` 要几秒）。 */
const WORKER_TIMEOUT_MS = 60_000

const WORKER_SOURCE = String.raw`
/**
 * 并发测试工作进程：在真实进程里拿锁 / 抢锁 / 跑 service，结果以 JSON 打到 stdout。
 * 由 test/concurrency.test.ts 写入临时目录后 spawn，argv[2] 是 JSON 载荷。
 */
import { appendFile, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const PKG = process.env.PP_PKG_ROOT
const payload = JSON.parse(process.argv[2])
const pipelineId = payload.pipelineId ?? 'pipe-1'
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

const lockMod = await import(PKG + '/src/checkpoint-lock.ts')
const rootsMod = await import(PKG + '/src/platform-roots.ts')
const fixtures = await import(PKG + '/test/web-fixtures.ts')
const serviceMod = await import(PKG + '/src/web/pipeline-run-service.ts')

function report(value) {
  process.stdout.write('__RESULT__' + JSON.stringify(value) + '\n')
}

/** 等到锁目录里出现 owner.json（= 某个进程真的进了临界区）。 */
async function waitForOwner(lockPath, attempts = 3000) {
  for (let i = 0; i < attempts; i += 1) {
    try { await readFile(join(lockPath, 'owner.json'), 'utf8'); return true } catch { await sleep(10) }
  }
  return false
}

async function waitForFile(path, attempts = 3000) {
  for (let i = 0; i < attempts; i += 1) {
    try { await readFile(path, 'utf8'); return true } catch { await sleep(10) }
  }
  return false
}

const lockOptions = extra => ({
  audit: lockMod.fileLockAudit(lockMod.lockAuditPath(payload.lockRoot)),
  ...extra,
})

try {
  if (payload.mode === 'lock-hold') {
    // 拿锁 → 亮明"我进了临界区" → 持有（等对方给出信号或固定时长）→ 记一条进展 → 释放
    const lock = await lockMod.acquirePipelineLock(payload.lockRoot, pipelineId, lockOptions({ staleMs: payload.staleMs }))
    await writeFile(payload.marker, String(process.pid), 'utf8')
    if (payload.releaseOnMarker !== undefined) {
      // 确定性握手：一直持有到对方报告完它的抢锁结果，而不是等一个固定时长
      // （并行跑全量测试时进程启动可能慢几十秒，固定时长会让重叠窗口消失）。
      await waitForFile(payload.releaseOnMarker, 12000)
    } else {
      await sleep(payload.holdMs)
    }
    await appendFile(payload.progressLog, process.pid + '\n')
    const released = await lock.release()
    report({ ok: true, acquired: true, ownerId: lock.ownerId, generation: lock.generation, released })
  } else if (payload.mode === 'lock-try') {
    // 等锁真的被持有，再抢：这样"抢不到"是确定的，而不是靠调度运气
    await waitForOwner(lockMod.pipelineLockPath(payload.lockRoot, pipelineId))
    try {
      const lock = await lockMod.acquirePipelineLock(payload.lockRoot, pipelineId, lockOptions({ staleMs: payload.staleMs }))
      if (payload.resultMarker !== undefined) await writeFile(payload.resultMarker, 'acquired', 'utf8')
      report({ ok: true, acquired: true, ownerId: lock.ownerId })
      await lock.release()
    } catch (error) {
      if (payload.resultMarker !== undefined) await writeFile(payload.resultMarker, 'refused', 'utf8')
      report({
        ok: false,
        acquired: false,
        conflict: error instanceof lockMod.PipelineLockHeldError,
        name: error && error.name ? error.name : String(error),
        holderPid: error && error.holder ? error.holder.pid : null,
      })
    }
  } else if (payload.mode === 'lock-hold-then-release') {
    // 不自动续租（heartbeatMs: 0），因此心跳会真的过期，可被另一个进程抢占。
    // 释放时机由对方的结果文件决定：必须等"对方已经抢到手"之后再释放，
    // 否则 release 会变成"释放自己的锁"（那样测不到"不得误删他人锁"）。
    const lock = await lockMod.acquirePipelineLock(
      payload.lockRoot, pipelineId, lockOptions({ staleMs: payload.staleMs, heartbeatMs: 0 }),
    )
    await writeFile(payload.marker, String(process.pid), 'utf8')
    if (payload.releaseOnMarker !== undefined) await waitForFile(payload.releaseOnMarker, 12000)
    else await sleep(payload.holdMs)
    const released = await lock.release()
    report({ ok: true, ownerId: lock.ownerId, generation: lock.generation, released })
  } else if (payload.mode === 'lock-steal') {
    // 抢锁后**不释放**：留给旧持有者去尝试 release，用它验证"不得误删他人锁"。
    if (payload.waitForFile !== undefined) await waitForFile(payload.waitForFile, 12000)
    const lock = await lockMod.acquirePipelineLock(payload.lockRoot, pipelineId, lockOptions({ staleMs: payload.staleMs }))
    if (payload.resultMarker !== undefined) await writeFile(payload.resultMarker, 'stolen', 'utf8')
    report({ ok: true, ownerId: lock.ownerId, generation: lock.generation, holderPid: lock.owner.pid })
  } else if (payload.mode === 'service-run') {
    const config = fixtures.baseConfig()
    // 卡住 receive 阶段：要么等另一个进程的信号（确定性握手），要么睡一个足够长的
    // 固定时长（SIGKILL 用例里进程会被杀掉，时长本身不参与断言）。
    const beforeStage = payload.waitForFile !== undefined
      ? async () => { await waitForFile(payload.waitForFile, 12000) }
      : payload.sleepMs !== undefined
        ? async () => { await sleep(payload.sleepMs) }
        : undefined
    const host = new fixtures.ScriptedHost(beforeStage === undefined ? {} : { beforeStage })
    const service = new serviceMod.FilePipelineRunService({
      dataRoot: payload.dataRoot,
      loadConfig: async () => config,
      createHost: host.factory,
    })
    await service.create(fixtures.CREATE, fixtures.REVIEWER)
    if (payload.marker !== undefined) await writeFile(payload.marker, '1', 'utf8')
    if (payload.waitForLock === true) {
      const lockRoot = rootsMod.resolvePlatformRoots(payload.dataRoot, config).checkpointRoot
      if (!(await waitForOwner(lockMod.pipelineLockPath(lockRoot, pipelineId)))) {
        report({ ok: false, reason: 'lock-never-appeared' })
        process.exit(4)
      }
    }
    try {
      const result = await service.run(pipelineId, fixtures.REVIEWER)
      if (payload.resultMarker !== undefined) await writeFile(payload.resultMarker, result.outcome, 'utf8')
      report({ ok: true, conflict: false, outcome: result.outcome, stages: [...host.stages] })
    } catch (error) {
      if (payload.resultMarker !== undefined) await writeFile(payload.resultMarker, 'refused', 'utf8')
      report({
        ok: false,
        conflict: error && error.code === 'conflict',
        errorCode: error && error.code ? error.code : null,
        stages: [...host.stages],
      })
    }
  } else {
    report({ ok: false, reason: 'unknown-mode' })
    process.exit(2)
  }
} catch (error) {
  report({ ok: false, reason: 'threw', message: error && error.message ? error.message : String(error) })
  process.exit(3)
}
`

interface WorkerResult {
  readonly ok?: boolean
  readonly acquired?: boolean
  readonly conflict?: boolean
  readonly released?: boolean
  readonly generation?: number
  readonly ownerId?: string
  readonly holderPid?: number | null
  readonly outcome?: string
  readonly stages?: readonly string[]
  readonly errorCode?: string | null
  readonly reason?: string
  readonly message?: string
  readonly name?: string
}

/** 已结束的子进程：结果 + 退出码（供断言"以非零退出"这类性质）。 */
interface Worker extends WorkerResult {
  readonly code: number | null
  readonly killed: boolean
}

let dir: string
let workerPath: string

test.beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'pp-concurrency-'))
  workerPath = join(dir, 'worker.mjs')
  await writeFile(workerPath, WORKER_SOURCE, 'utf8')
})
test.afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

/** 起一个工作进程并等它结束；解析 stdout 里的 `__RESULT__` 行。 */
function startWorker(payload: Record<string, unknown>): {
  readonly child: ReturnType<typeof spawn>
  readonly done: Promise<Worker>
} {
  const child = spawn(process.execPath, [workerPath, JSON.stringify(payload)], {
    env: { ...process.env, PP_PKG_ROOT: PACKAGE_ROOT },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let out = ''
  let err = ''
  child.stdout?.on('data', chunk => { out += String(chunk) })
  child.stderr?.on('data', chunk => { err += String(chunk) })
  const done = new Promise<Worker>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error(`工作进程超时未结束（${WORKER_TIMEOUT_MS}ms）：${payload.mode}\n${out}\n${err}`))
    }, WORKER_TIMEOUT_MS)
    child.once('exit', (code, signal) => {
      clearTimeout(timer)
      const line = out.split('\n').filter(entry => entry.startsWith('__RESULT__')).pop()
      if (line === undefined) {
        reject(new Error(`工作进程没有产出结果：code=${code} signal=${signal}\nstdout=${out}\nstderr=${err}`))
        return
      }
      resolve({
        ...(JSON.parse(line.slice('__RESULT__'.length)) as WorkerResult),
        code,
        killed: signal !== null,
      })
    })
  })
  return { child, done }
}

/** 起一个工作进程并等它结束。 */
async function runWorker(payload: Record<string, unknown>): Promise<Worker> {
  return await startWorker(payload).done
}

async function waitForFile(path: string, attempts = 3000): Promise<void> {
  for (let index = 0; index < attempts; index += 1) {
    if (existsSync(path)) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error(`等待文件出现超时：${path}`)
}

async function waitForLock(lockPath: string, attempts = 3000): Promise<void> {
  await waitForFile(join(lockPath, 'owner.json'), attempts)
}

/** 解析锁审计 JSONL（只落盘异常/需解释事件，见 `checkpoint-lock.ts` 的 AUDITED_LOCK_EVENTS）。 */
interface LockAuditEvent {
  readonly kind: string
  readonly owner: { readonly ownerId: string; readonly pid: number; readonly generation: number }
  readonly previous: { readonly ownerId: string; readonly pid: number; readonly generation: number } | null
  readonly detail: string
}

async function lockAuditEvents(checkpointRoot: string): Promise<readonly LockAuditEvent[]> {
  return (await readFile(lockAuditPath(checkpointRoot), 'utf8'))
    .split('\n')
    .filter(line => line.trim() !== '')
    .map(line => JSON.parse(line) as LockAuditEvent)
}

function lockRootOf(dataRoot: string): string {
  return resolvePlatformRoots(dataRoot, baseConfig()).checkpointRoot
}

// ── 双进程互斥 ───────────────────────────────────────────────────────────────

test('两个进程同时抢同一把锁：只有一个进入临界区，另一个明确拿到 PipelineLockHeldError', async () => {
  const lockRoot = join(dir, 'checkpoints')
  await mkdir(lockRoot, { recursive: true })
  const progressLog = join(dir, 'progress.log')
  const marker = join(dir, 'holder.marker')
  const bResult = join(dir, 'b.result')

  // 确定性握手：A 拿到锁后一直持有，直到 B 报告完自己的抢锁结果。
  // 不依赖任何时间余量——并行跑全量测试时子进程启动可能慢几十秒。
  const a = startWorker({
    mode: 'lock-hold', lockRoot, marker, progressLog, staleMs: 60_000, releaseOnMarker: bResult,
  })
  await waitForFile(marker)
  const b = await runWorker({ mode: 'lock-try', lockRoot, staleMs: 60_000, resultMarker: bResult })
  const ra = await a.done

  assert.equal(ra.acquired, true)
  assert.equal(ra.released, true, '持有者应能正常释放自己的锁')
  assert.equal(b.acquired, false)
  assert.equal(b.conflict, true, `应明确报 PipelineLockHeldError，实际：${JSON.stringify(b)}`)
  assert.ok(typeof b.holderPid === 'number' && b.holderPid > 0, '冲突里必须带上持有者 pid，便于运维定位')

  // 临界区只被进入过一次：进展日志恰好一行，且锁最终被释放。
  assert.equal((await readFile(progressLog, 'utf8')).trim().split('\n').length, 1)
  assert.equal(existsSync(pipelineLockPath(lockRoot, PIPELINE)), false, '正常释放后锁目录必须消失')

  // 审计必须解释"为什么这个进程没抢到"：锁仍有效时记 contended，并指向真正的持有者。
  const holderPid = Number((await readFile(marker, 'utf8')).trim())
  const events = await lockAuditEvents(lockRoot)
  const contended = events.filter(event => event.kind === 'contended')
  assert.equal(contended.length, 1, `应恰好记录一条 contended：${JSON.stringify(events)}`)
  assert.equal(contended[0]?.previous?.pid, holderPid, 'contended 必须指向当时的持有者')
  assert.match(contended[0]?.detail ?? '', /锁仍有效/)
})

test('两个进程同时 run 同一 pipeline：只有一个推进，另一个 conflict(409) 且一个阶段都不 spawn', async () => {
  const dataRoot = join(dir, 'data')
  const marker = join(dir, 'runner.marker')
  const bResult = join(dir, 'b.result')

  // A 的 receive 阶段卡住直到 B 报告结果，把"临界区"变成一个确定存在的窗口。
  const a = startWorker({ mode: 'service-run', dataRoot, marker, waitForFile: bResult })
  await waitForFile(marker)
  // B 等 A 真的拿到运行锁再跑：它必须被拒，而不是排队或并行。
  const b = startWorker({ mode: 'service-run', dataRoot, waitForLock: true, resultMarker: bResult })
  const rb = await b.done
  const ra = await a.done

  assert.equal(ra.ok, true, `A 应正常收敛：${JSON.stringify(ra)}`)
  assert.equal(ra.outcome, 'waiting-human')
  assert.deepEqual(ra.stages, ['receive'])

  assert.equal(rb.conflict, true, `B 应被运行锁拒掉：${JSON.stringify(rb)}`)
  assert.equal(rb.errorCode, 'conflict')
  assert.deepEqual(rb.stages, [], '被拒的进程不得 spawn 任何阶段')

  // 持久化事实上只有一条流水线在推进：receive 已产出并等人工门，没有第二份进展。
  const checkpoint = JSON.parse(
    await readFile(join(lockRootOf(dataRoot), PIPELINE, 'checkpoint.json'), 'utf8'),
  ) as { cursor: number; stageStates: Record<string, { status: string }> }
  assert.equal(checkpoint.cursor, 0)
  assert.equal(checkpoint.stageStates.receive?.status, 'awaiting-gate')
})

// ── kill -9 与跨进程抢占 ─────────────────────────────────────────────────────

test('SIGKILL 后新进程立刻接管：不靠 6 小时心跳超时，且审计留下 stale-recovered/dead-holder', async () => {
  const dataRoot = join(dir, 'data')
  const marker = join(dir, 'runner.marker')
  const lockPath = pipelineLockPath(lockRootOf(dataRoot), PIPELINE)

  // A 进入 receive 阶段后卡住（模拟长跑中的进程），拿到锁后被杀。
  const a = startWorker({ mode: 'service-run', dataRoot, marker, sleepMs: 60000 })
  await waitForFile(marker)
  await waitForLock(lockPath)
  const killed = JSON.parse(await readFile(join(lockPath, 'owner.json'), 'utf8')) as {
    ownerId: string; pid: number; generation: number
  }
  a.child.kill('SIGKILL')
  await a.done.catch(() => undefined)

  // 被 -9 的进程没有机会释放锁：锁目录仍在，持有者 pid 已不存在。
  assert.equal(existsSync(join(lockPath, 'owner.json')), true, 'SIGKILL 后锁应仍留在磁盘上')

  // B 立刻跑，不需要等 6 小时：同主机 + pid 不存在 → dead-holder → 立即接管。
  const b = await runWorker({ mode: 'service-run', dataRoot })
  assert.equal(b.ok, true, `B 应能接管并推进：${JSON.stringify(b)}`)
  assert.equal(b.outcome, 'waiting-human')
  assert.deepEqual(b.stages, ['receive'])

  const events = await lockAuditEvents(lockRootOf(dataRoot))
  // 抢占成功时**不该**有 contended：那条事件专指"锁仍有效，拒绝抢占"（见下一条用例）。
  assert.deepEqual(events.map(event => event.kind), ['stale-recovered'])

  const recovered = events.find(event => event.kind === 'stale-recovered')
  assert.ok(recovered !== undefined, `应记录 stale-recovered：${JSON.stringify(events)}`)
  assert.equal(recovered.previous?.ownerId, killed.ownerId, '必须记录被清除的锁归谁所有')
  assert.equal(recovered.previous?.generation, killed.generation)
  // 判据是"同主机且持有者进程已不存在"，而不是心跳超期（否则要等 6 小时）。
  assert.match(recovered.detail, /持有者进程已不存在/)
})

test('心跳过期的锁被另一进程抢占后，旧持有者的 release 被拒且不会删掉新持有者的锁', async () => {
  const lockRoot = join(dir, 'checkpoints')
  await mkdir(lockRoot, { recursive: true })
  const marker = join(dir, 'holder.marker')
  const goMarker = join(dir, 'steal.go')
  const stolenMarker = join(dir, 'stolen.marker')
  const lockPath = pipelineLockPath(lockRoot, PIPELINE)

  // A 不自动续租（heartbeatMs: 0），一直持有到 B 抢到手并报告之后再尝试释放。
  const a = startWorker({
    mode: 'lock-hold-then-release', lockRoot, marker, staleMs: 300, releaseOnMarker: stolenMarker,
  })
  await waitForFile(marker)
  // 由父进程等待心跳过期（staleMs=300）：子进程启动快慢都不影响这个判定的成立。
  await new Promise(resolve => setTimeout(resolve, 700))
  await writeFile(goMarker, '1', 'utf8')
  const b = await runWorker({
    mode: 'lock-steal', lockRoot, staleMs: 300, waitForFile: goMarker, resultMarker: stolenMarker,
  })

  assert.equal(b.ok, true, `B 应能抢占过期锁：${JSON.stringify(b)}`)
  assert.ok((b.generation ?? 0) > 0)
  const ownerAfterSteal = JSON.parse(await readFile(join(lockPath, 'owner.json'), 'utf8')) as { ownerId: string; generation: number }
  assert.equal(ownerAfterSteal.ownerId, b.ownerId, '抢占后锁归 B 所有')

  // A 醒来后 release：ownerId/generation 都不匹配 → 必须被拒，且不得动 B 的锁。
  const ra = await a.done
  assert.equal(ra.released, false, '过期持有者的 release 必须被拒绝（否则会删掉新持有者的锁）')
  assert.ok((b.generation ?? 0) > (ra.generation ?? 0), 'generation 必须跨进程单调递增')
  assert.equal(existsSync(join(lockPath, 'owner.json')), true, 'release 被拒后锁必须原样留在磁盘上')
  const ownerAfterRelease = JSON.parse(await readFile(join(lockPath, 'owner.json'), 'utf8')) as { ownerId: string }
  assert.equal(ownerAfterRelease.ownerId, b.ownerId, 'release 被拒后锁的归属不得改变')

  const events = await lockAuditEvents(lockRoot)
  const recovered = events.find(event => event.kind === 'stale-recovered')
  assert.ok(recovered !== undefined, `应记录 stale-recovered：${JSON.stringify(events)}`)
  // 判据是心跳超期（A 活着但没续租），而不是"进程已死"。
  assert.match(recovered.detail, /心跳超期/)

  const refused = events.find(event => event.kind === 'release-refused')
  assert.ok(refused !== undefined, `应记录 release-refused：${JSON.stringify(events)}`)
  // 被拒的一方正是 A：它的 ownerId 就是刚被抢走的那把锁的持有者。
  assert.equal(refused.owner.ownerId, recovered.previous?.ownerId)
  assert.equal(refused.previous?.ownerId, b.ownerId, '拒绝原因必须指向当前的真正持有者 B')
})

test('抢占不留残留：stale 锁被接管后目录里只有当前 owner，没有 .stale-* 墓碑', async () => {
  const dataRoot = join(dir, 'data')
  const marker = join(dir, 'runner.marker')
  const lockPath = pipelineLockPath(lockRootOf(dataRoot), PIPELINE)

  const a = startWorker({ mode: 'service-run', dataRoot, marker, sleepMs: 60000 })
  await waitForFile(marker)
  await waitForLock(lockPath)
  a.child.kill('SIGKILL')
  await a.done.catch(() => undefined)

  const b = await runWorker({ mode: 'service-run', dataRoot })
  assert.equal(b.ok, true)

  // 锁已被 B 正常释放（run 结束），因此整个锁目录应当消失——
  // 若抢占时把墓碑留在原地，这里会看到 `.pipeline.lock.stale-*` 残留。
  assert.equal(existsSync(lockPath), false)
  const names = await readdir(lockRootOf(dataRoot))
  assert.deepEqual(names.filter(name => name.includes('.stale-')), [])
})
