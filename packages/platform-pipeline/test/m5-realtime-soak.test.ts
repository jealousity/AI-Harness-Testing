/**
 * M5 门槛 8b 的**真实时钟**部分（docs/11 §9 批次 E 第 7 项、docs/13 门槛8b）。
 *
 * 为什么注入时钟的测试覆盖不了它：`checkpoint-lock.test.ts` 用注入的 `now()` 验证
 * "心跳过期后可恢复"，那证明的是**判据**正确。而生产上真正会失效的是**定时器**本身：
 *
 * - 自动续租跑在真实的 `setInterval` 上（`staleMs / 3`）。注入时钟不会让
 *   `setInterval` 触发，因此"长跑不被误抢"这件事从未被真正验证过——
 *   只要定时器没装上、被 `unref` 掉了、或回调里抛错被吞，长跑就会被别人抢走锁，
 *   而所有单元测试仍然全绿。
 * - 反过来，"崩溃之后真的能被接管"依赖**真实经过的时间**，注入时钟同样测不到。
 *
 * 因此这一组**故意使用真实时间**（毫秒级的 `staleMs` + 真实等待），把两类行为钉住：
 * 1. 续租定时器真的在跑 → 超过 `staleMs` 之后仍然抢不走；
 * 2. 没有续租时真实经过的时间确实让它可被接管（`stale-recovered`）；
 * 3. **真实进程**被杀（不释放锁）之后可被接管——这是 docs/12 §4.1/§4.4 的恢复路径。
 *
 * 仍然**未覆盖**：真实跨天（wall-clock 数天）的运行。那一项需要真实时间尺度，
 * 本轮只能覆盖"真实时钟的定时器与接管"，两者不要混为一谈。
 *
 * @module test/m5-realtime-soak
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'

import {
  acquirePipelineLock,
  pipelineLockPath,
  PipelineLockHeldError,
  type PipelineLockEvent,
} from '../src/checkpoint-lock.ts'

const here = dirname(fileURLToPath(import.meta.url))
const PACKAGE_ROOT = join(here, '..')
const PIPELINE = 'pipe-1'
/** 毫秒级的 stale 窗口：让"真实经过的时间"在测试里可用，而不是等 6 小时。 */
const STALE_MS = 400
const RENEW_MS = 60

let root: string
let childDir: string

test.beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'pp-realtime-'))
  childDir = await mkdtemp(join(tmpdir(), 'pp-realtime-child-'))
})
test.afterEach(async () => {
  await rm(root, { recursive: true, force: true })
  await rm(childDir, { recursive: true, force: true })
})

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => { setTimeout(resolve, ms) })
}

/** 读 owner 文件里的 `heartbeatAt`（真实时钟行为必须看落盘值，不能看内存）。 */
async function heartbeatOf(): Promise<number> {
  const raw = JSON.parse(await readFile(join(pipelineLockPath(root, PIPELINE), 'owner.json'), 'utf8')) as {
    readonly heartbeatAt: number
  }
  return raw.heartbeatAt
}

test('门槛8b：真实续租定时器让长跑锁不被误抢（超过 staleMs 仍然抢不走）', async () => {
  const events: PipelineLockEvent[] = []
  const lock = await acquirePipelineLock(root, PIPELINE, {
    staleMs: STALE_MS,
    heartbeatMs: RENEW_MS,
    audit: event => { events.push(event) },
  })

  const first = await heartbeatOf()
  // 真实等待：远超 staleMs，也足以让续租定时器跑好几轮。
  await sleep(STALE_MS * 3)
  const later = await heartbeatOf()
  assert.ok(later > first,
    `续租定时器必须真的在推进 heartbeatAt（${first} → ${later}）：注入时钟测不到这一点`)

  // 竞争者用同样的 staleMs：因为持有者在真实续租，它必须抢不走。
  await assert.rejects(
    () => acquirePipelineLock(root, PIPELINE, { staleMs: STALE_MS }),
    (error: unknown) => {
      assert.ok(error instanceof PipelineLockHeldError, `必须是"锁被持有"，实际 ${(error as Error)?.name}`)
      return true
    },
    '长跑中的锁不得因为"取得时间久了"被抢走——判据是心跳，不是取得时间',
  )

  assert.ok(events.some(event => event.kind === 'renewed'), '续租必须留下审计事件')
  assert.equal(events.some(event => event.kind === 'stale-recovered'), false, '未被抢占就不该有恢复事件')

  await lock.release()
})

test('门槛8b：没有续租时，真实经过的时间确实让它可被接管', async () => {
  const events: PipelineLockEvent[] = []
  // heartbeatMs: 0 = 关掉自动续租，模拟"持有者已经不再推进心跳"。
  await acquirePipelineLock(root, PIPELINE, {
    staleMs: STALE_MS,
    heartbeatMs: 0,
    audit: event => { events.push(event) },
  })

  await sleep(STALE_MS * 2)
  const taken = await acquirePipelineLock(root, PIPELINE, {
    staleMs: STALE_MS,
    heartbeatMs: 0,
    audit: event => { events.push(event) },
  })

  assert.ok(events.some(event => event.kind === 'stale-recovered'),
    `真实超期之后必须走恢复路径并留下审计：${JSON.stringify(events.map(event => event.kind))}`)
  await taken.release()
})

test('门槛8b：真实进程被杀（未释放锁）之后，真实等待即可接管', async () => {
  // 子进程取得锁后**直接退出**，不调用 release——等价于被 SIGKILL。
  const worker = join(childDir, 'holder.ts')
  await writeFile(worker, `
const { acquirePipelineLock } = await import(${JSON.stringify(join(PACKAGE_ROOT, 'src/checkpoint-lock.ts'))})
const [root, pipelineId, staleMs] = process.argv.slice(2)
await acquirePipelineLock(root, pipelineId, { staleMs: Number(staleMs), heartbeatMs: 0 })
process.stdout.write('LOCKED\\n')
// 不 release：让进程带着锁死掉。
process.exit(0)
`, 'utf8')

  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, [worker, root, PIPELINE, String(STALE_MS)], { cwd: PACKAGE_ROOT })
    let out = ''
    child.stdout.on('data', chunk => { out += chunk.toString('utf8') })
    child.on('error', reject)
    child.on('close', code => {
      if (code === 0 && out.includes('LOCKED')) resolve()
      else reject(new Error(`子进程没有成功取得锁：code=${code} out=${JSON.stringify(out)}`))
    })
  })

  // 真实等待一小段：让"持有者已死"这件事在真实时间上成立。
  await sleep(100)
  const events: PipelineLockEvent[] = []
  const recovered = await acquirePipelineLock(root, PIPELINE, {
    staleMs: STALE_MS,
    heartbeatMs: 0,
    audit: event => { events.push(event) },
  })

  assert.ok(
    events.some(event => event.kind === 'stale-recovered' || event.detail.includes('已死')),
    `接管死进程留下的锁必须留下审计：${JSON.stringify(events.map(event => [event.kind, event.detail]))}`,
  )
  await recovered.release()
})
