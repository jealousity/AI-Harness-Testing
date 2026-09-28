/**
 * 后台运行**前置校验**的测试（`docs/14` W5）。
 *
 * 这一组精确复现 W4 冒烟时实测到的缺口：
 *
 * ```text
 * 缺 PLATFORM_LLM_API_KEY 时
 *   POST /api/pipelines/:id/run  → 202（已受理）
 *   服务端日志：运行前置失败 provider-unavailable
 *   视图：status=queued，页面显示"尚未开始：触发运行"
 * ```
 *
 * 用户看到的是"点了没反应"，只能反复点同一个按钮。修法是**把前置校验前移到启动
 * 后台任务之前**：失败以 `started: false` + 明确 reason 同步返回。
 *
 * 这里用**真实宿主**（不注入 `createHost`）：`baseConfig()` 的 provider 声明了
 * `apiKeyEnv: PLATFORM_SERVICE_TEST_KEY`，测试进程里没有这个环境变量，因此
 * `createPlatformHost` 会真的抛 `provider-unavailable`——不是打桩。
 *
 * @module platform-pipeline/test/web-preflight
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import type { PipelineConfig } from '../src/types.ts'
import { AsyncPipelineRunner } from '../src/web/async-runner.ts'
import { FilePipelineRunService } from '../src/web/pipeline-run-service.ts'
import { PipelineRunError } from '../src/web/pipeline-run-types.ts'
import { CREATE, REVIEWER, ScriptedHost, baseConfig } from './web-fixtures.ts'

let dir: string
let config: PipelineConfig

test.beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'pp-preflight-'))
  config = baseConfig()
})
test.afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

/** 用**真实宿主**的服务：`createHost` 不注入，因此 provider 解析会真的发生。 */
function realHostService(): FilePipelineRunService {
  return new FilePipelineRunService({ dataRoot: dir, loadConfig: async () => config })
}

test('W5：provider 缺 Key 时，preflight 同步抛 provider-unavailable（不再等后台任务）', async () => {
  // 先确认这个环境确实没有配置 provider 凭据——否则本用例的前提不成立。
  assert.equal(process.env.PLATFORM_SERVICE_TEST_KEY, undefined,
    '测试进程里不应存在 provider 凭据，否则本用例测不到"缺 Key"这条路径')

  const service = realHostService()
  await service.create(CREATE, REVIEWER)

  const error = await service.preflight('pipe-1', REVIEWER).then(() => null, (thrown: unknown) => thrown)
  assert.ok(error instanceof PipelineRunError, `期望 PipelineRunError，实际 ${String(error)}`)
  assert.equal(error.code, 'provider-unavailable',
    '前置校验必须把 provider 缺 Key 报出来，而不是留到后台任务里')
  assert.match(error.message, /PLATFORM_SERVICE_TEST_KEY/,
    '错误消息必须点出缺的是哪个环境变量，否则运维无从下手')
})

test('W5：trigger 在前置校验失败时返回 started=false + 原因，且**不启动后台任务**', async () => {
  const service = realHostService()
  await service.create(CREATE, REVIEWER)
  const runner = new AsyncPipelineRunner({
    service, dataRoot: dir, actor: { actorId: 'runner', tenantId: 'acme' },
  })

  const trigger = await runner.trigger('pipe-1', REVIEWER)
  assert.equal(trigger.started, false, '注定失败的后台任务不该被启动')
  assert.equal(trigger.handle, null)
  assert.match(String(trigger.reason), /provider-unavailable/,
    '必须把错误码带给调用者，页面才能显示"为什么点了没反应"')
  assert.match(String(trigger.reason), /PLATFORM_SERVICE_TEST_KEY/)

  // 关键：没有后台任务在跑，也没有留下"运行中"的假象。
  assert.equal(runner.isRunning('pipe-1'), false)
  const view = await service.get('pipe-1', REVIEWER)
  assert.equal(view.status, 'queued', '前置失败不得把流水线推进成任何中间态')
  // 注意：`running` 是 **HTTP 层**在响应里合并的字段（来自进程内 registry），
  // service 视图里没有它——这里只断言 service 能断言的事实。
  assert.equal(view.nextStage, 'receive')
  await runner.idle()
})

test('W5：前置校验通过时照常启动后台任务（不能因为加了校验就不跑了）', async () => {
  // 注入脚本化宿主：它不解析 provider，因此前置校验通过。
  const host = new ScriptedHost()
  const service = new FilePipelineRunService({
    dataRoot: dir, loadConfig: async () => config, createHost: host.factory,
  })
  await service.create(CREATE, REVIEWER)
  const runner = new AsyncPipelineRunner({
    service, dataRoot: dir, actor: { actorId: 'runner', tenantId: 'acme' },
  })

  const trigger = await runner.trigger('pipe-1', REVIEWER)
  assert.equal(trigger.started, true, `前置校验通过就必须真的启动：${String(trigger.reason)}`)
  assert.equal(trigger.reason, null)
  await runner.idle()
})

test('W5：请求级错误（不存在 / 越权）仍按原状态码冒泡，不被降级成 started=false', async () => {
  const service = realHostService()
  await service.create(CREATE, REVIEWER)
  const runner = new AsyncPipelineRunner({
    service, dataRoot: dir, actor: { actorId: 'runner', tenantId: 'acme' },
  })

  // 不存在 → not-found(404)：调用方要拿到 404，而不是"运行起不来"。
  const missing = await runner.trigger('nope', REVIEWER).then(() => null, (error: unknown) => error)
  assert.ok(missing instanceof PipelineRunError, `期望 PipelineRunError，实际 ${String(missing)}`)
  assert.equal(missing.code, 'not-found')

  // 跨租户 → 按"不存在"回应（防枚举），同样不能被降级。
  const foreign = await runner
    .trigger('pipe-1', { actorId: 'mallory', tenantId: 'other', roles: ['reviewer'] })
    .then(() => null, (error: unknown) => error)
  assert.ok(foreign instanceof PipelineRunError, `期望 PipelineRunError，实际 ${String(foreign)}`)
  assert.equal(foreign.code, 'not-found')
})

test('W5：preflight 不取运行锁（否则会把锁持有到后台运行结束）', async () => {
  const service = realHostService()
  await service.create(CREATE, REVIEWER)
  // 前置校验失败也必须**释放**它可能持有的任何东西：调用后立刻再跑一次仍应得到同样结论，
  // 而不是"第二次被锁挡住"（那说明锁泄漏了）。
  const first = await service.preflight('pipe-1', REVIEWER).then(() => null, (error: unknown) => error)
  const second = await service.preflight('pipe-1', REVIEWER).then(() => null, (error: unknown) => error)
  assert.equal((first as PipelineRunError)?.code, 'provider-unavailable')
  assert.equal((second as PipelineRunError)?.code, 'provider-unavailable',
    '第二次必须还是 provider-unavailable（不是 conflict/锁冲突）')
})
