/**
 * `PipelineRunRegistry` 测试（docs/10 §5.2「进程内运行句柄，非事实存储」）。
 *
 * 重点验证两件事：
 * - **互斥**：同一 pipeline 运行期间不会被重复启动（M2 的 pipeline lock 落地前
 *   这是唯一的并发防线，重复启动会两份检查点互相覆盖）；
 * - **不吞异常**：`work` 抛出的异常既不逃逸成未处理拒绝，也不被静默丢弃，
 *   而是完整装进 `RunSettlement` 交回调用方。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { PipelineRunRegistry } from '../src/web/pipeline-run-registry.ts'

/** 可手动放行的 Promise，用于精确控制 work 的结束时刻。 */
function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>(r => { resolve = r })
  return { promise, resolve }
}

/** 让出一轮微任务，使 registry 内部的 async 包装体开始执行。 */
const tick = (): Promise<void> => new Promise(resolve => { setImmediate(resolve) })

test('start 登记句柄，work 结束后立刻释放（释放发生在结束之后，不提前）', async () => {
  const registry = new PipelineRunRegistry()
  const gate = deferred()
  const seen: boolean[] = []

  const handle = registry.start('pipe-1', async () => {
    seen.push(registry.has('pipe-1'))
    await gate.promise
  })
  assert.ok(handle !== null)

  assert.equal(registry.size, 1)
  assert.deepEqual(registry.ids(), ['pipe-1'])
  assert.equal(registry.get('pipe-1'), handle)

  await tick()
  // work 正在执行中：句柄必须仍然在册，否则第二次触发会并发写同一份检查点。
  assert.equal(seen[0], true)
  assert.equal(registry.has('pipe-1'), true)

  gate.resolve()
  assert.deepEqual(await handle.settled, { ok: true })
  assert.equal(registry.size, 0)
  assert.equal(registry.has('pipe-1'), false)
  assert.equal(registry.get('pipe-1'), undefined)
})

test('同一 pipeline 运行期间重复 start 返回 null，不排队也不并发', async () => {
  const registry = new PipelineRunRegistry()
  const gate = deferred()
  let started = 0

  const first = registry.start('pipe-1', async () => {
    started += 1
    await gate.promise
  })
  assert.ok(first !== null)

  const second = registry.start('pipe-1', async () => { started += 1 })
  assert.equal(second, null, '运行中的 pipeline 不应被重复启动')
  assert.equal(registry.size, 1)

  gate.resolve()
  await first.settled
  // 释放之后可以重新启动（例如人工裁决后再次触发）。
  const third = registry.start('pipe-1', async () => { started += 1 })
  assert.ok(third !== null)
  await third.settled

  assert.equal(started, 2)
})

test('不同 pipeline 之间互不阻塞', async () => {
  const registry = new PipelineRunRegistry()
  const gate = deferred()
  const a = registry.start('pipe-a', async () => { await gate.promise })
  const b = registry.start('pipe-b', async () => { await gate.promise })
  assert.ok(a !== null)
  assert.ok(b !== null)
  assert.equal(registry.size, 2)
  assert.deepEqual([...registry.ids()].sort(), ['pipe-a', 'pipe-b'])

  gate.resolve()
  await Promise.all([a.settled, b.settled])
  assert.equal(registry.size, 0)
})

test('cancel 中止传给 work 的信号，且不触碰任何持久化事实', async () => {
  const registry = new PipelineRunRegistry()
  let observed: unknown = null

  const handle = registry.start('pipe-1', async signal => {
    await new Promise<void>((_resolve, reject) => {
      signal.addEventListener('abort', () => { observed = signal.reason; reject(signal.reason) }, { once: true })
    })
  })
  assert.ok(handle !== null)

  assert.equal(registry.cancel('pipe-1', '运维取消'), true)
  const settlement = await handle.settled
  assert.equal(settlement.ok, false)
  assert.ok(observed instanceof Error)
  assert.equal((observed as Error).message, '运维取消')
  // 取消后句柄释放；重复取消返回 false（幂等，不报错）。
  assert.equal(registry.has('pipe-1'), false)
  assert.equal(registry.cancel('pipe-1'), false)
})

test('cancelAll 中止全部运行并返回被中止的 id', async () => {
  const registry = new PipelineRunRegistry()
  const mk = (id: string) => registry.start(id, async signal => {
    await new Promise<void>((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true })
    })
  })
  const a = mk('pipe-a')
  const b = mk('pipe-b')
  assert.ok(a !== null && b !== null)

  assert.deepEqual([...registry.cancelAll()].sort(), ['pipe-a', 'pipe-b'])
  const settlements = await Promise.all([a.settled, b.settled])
  assert.deepEqual(settlements.map(s => s.ok), [false, false])
  assert.equal(registry.size, 0)
})

test('work 抛出的异常不逃逸成未处理拒绝，完整装进 RunSettlement', async () => {
  const registry = new PipelineRunRegistry()
  const boom = new Error('阶段运行器爆炸')

  const handle = registry.start('pipe-1', async () => { throw boom })
  assert.ok(handle !== null)

  const settlement = await handle.settled
  assert.equal(settlement.ok, false)
  if (settlement.ok) throw new Error('unreachable: 期望失败收敛')
  // 必须是同一个对象：调用方要能拿到 message 之外的字段（如 cause、code）。
  assert.equal(settlement.error, boom)
  assert.equal(registry.has('pipe-1'), false, '异常路径也必须释放句柄')
})

test('settled(pipelineId) 无句柄时立即返回成功，不挂住调用方', async () => {
  const registry = new PipelineRunRegistry()
  assert.deepEqual(await registry.settled('never-started'), { ok: true })
})

test('allSettled 循环等待，能收敛 work 内部新触发的运行', async () => {
  const registry = new PipelineRunRegistry()
  let innerDone = false

  registry.start('pipe-outer', async () => {
    await tick()
    registry.start('pipe-inner', async () => {
      await tick()
      innerDone = true
    })
  })

  const settlements = await registry.allSettled()
  assert.equal(innerDone, true, 'allSettled 必须等到 work 内部触发的新运行也结束')
  assert.equal(settlements.length, 2)
  assert.deepEqual(settlements.map(s => s.ok), [true, true])
  assert.equal(registry.size, 0)
})

test('空 pipelineId 立即报错，不把空 id 写进注册表', () => {
  const registry = new PipelineRunRegistry()
  assert.throws(() => registry.start('', async () => {}), /非空 pipelineId/)
  assert.equal(registry.size, 0)
})

test('句柄暴露的 signal 是只读视图：取消只能走 cancel 入口', async () => {
  const registry = new PipelineRunRegistry()
  const handle = registry.start('pipe-1', async signal => {
    await new Promise<void>((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true })
    })
  })
  assert.ok(handle !== null)
  // AbortSignal 上没有 abort()：持有者无法绕过注册表直接中止。
  assert.equal((handle.signal as unknown as { abort?: unknown }).abort, undefined)
  registry.cancel('pipe-1')
  assert.equal((await handle.settled).ok, false)
})
