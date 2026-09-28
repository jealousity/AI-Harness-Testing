/**
 * 流水线「编辑 / 移除」的测试（`docs/14` W5 后续）。
 *
 * 两条设计的边界要在测试里钉住，否则很容易被后来的改动磨掉：
 * 1. **编辑不改状态、不改作用域**：它只改运行参数；已有产物时只给提醒，
 *    不自动重入。作用域字段（projectId/tenantId/configRef）改了就不是同一条流水线。
 * 2. **移除只摘索引、数据保留**：`dataRetained` 恒为 true，且**磁盘上的检查点确实还在**。
 *    真删需要给四个存储端口加 `remove` 能力，属独立工作（见 docs/15 §8.5）。
 *
 * @module platform-pipeline/test/web-pipeline-edit
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import type { PipelineConfig } from '../src/types.ts'
import { resolvePlatformRoots } from '../src/platform-roots.ts'
import { createFileStorageBackendFromRoots } from '../src/storage/file/index.ts'
import { FilePipelineRunService } from '../src/web/pipeline-run-service.ts'
import { PipelineRunError } from '../src/web/pipeline-run-types.ts'
import { CREATE, REVIEWER, SCOPE, ScriptedHost, baseConfig } from './web-fixtures.ts'

const OPERATOR = { actorId: 'ops-1', tenantId: 'acme', roles: ['operator'] as const }
const VIEWER = { actorId: 'viewer-1', tenantId: 'acme', roles: ['viewer'] as const }

let dir: string
let config: PipelineConfig

test.beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'pp-edit-'))
  config = baseConfig()
})
test.afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

function serviceOf(host: ScriptedHost): FilePipelineRunService {
  return new FilePipelineRunService({ dataRoot: dir, loadConfig: async () => config, createHost: host.factory })
}

function projectRoot(): string {
  return resolvePlatformRoots(dir, config).projectRoot
}

// ── 编辑 ─────────────────────────────────────────────────────────────────────

test('W5：编辑运行参数写进索引，并如实报告变更字段', async () => {
  const service = serviceOf(new ScriptedHost())
  await service.create(CREATE, REVIEWER)

  const result = await service.update({
    pipelineId: 'pipe-1',
    targetBaseUrl: 'https://staging.example.com',
    maxGateRetries: 5,
  }, OPERATOR)
  assert.deepEqual([...result.changedFields].sort(), ['maxGateRetries', 'targetBaseUrl'])
  assert.ok(result.updatedAt > 0)

  // 索引里真的变了（不是只在返回值里变了）。
  const raw = JSON.parse(await (await import('node:fs/promises')).readFile(join(dir, 'pipelines', 'pipe-1.json'), 'utf8'))
  assert.equal(raw.targetBaseUrl, 'https://staging.example.com')
  assert.equal(raw.maxGateRetries, 5)
  assert.equal(raw.createdAt !== undefined, true, 'createdAt 不能被编辑冲掉')
})

test('W5：没传的字段保持不变；无字段变化时 changedFields 为空', async () => {
  const service = serviceOf(new ScriptedHost())
  await service.create(CREATE, REVIEWER)

  await service.update({ pipelineId: 'pipe-1', providerName: 'primary' }, OPERATOR)
  const second = await service.update({ pipelineId: 'pipe-1', providerName: 'primary' }, OPERATOR)
  assert.deepEqual(second.changedFields, [], '值没变就不该报成"变更过"')
  assert.equal(second.warning, null, '从未运行过的流水线不需要"产物已过期"提醒')
})

test('W5：编辑已产出产物的流水线时给出提醒，但**不自动改状态**', async () => {
  const service = serviceOf(new ScriptedHost())
  await service.create(CREATE, REVIEWER)
  await service.run('pipe-1', REVIEWER) // 产出 receive 并停在人工门
  const before = await service.get('pipe-1', REVIEWER)

  const result = await service.update({ pipelineId: 'pipe-1', maxGateRetries: 1 }, OPERATOR)
  assert.match(String(result.warning), /旧参数/, '必须提醒产物是在旧参数下产生的')
  assert.match(String(result.warning), /重入/, '要告诉运维怎么重做')

  const after = await service.get('pipe-1', REVIEWER)
  assert.equal(after.status, before.status, '编辑不得改变流水线状态')
  assert.equal(after.currentStage, before.currentStage)
  assert.equal(after.nextAction, before.nextAction, '编辑不得改变下一步动作')
})

test('W5：编辑要求 operator（viewer 被拒）', async () => {
  const service = serviceOf(new ScriptedHost())
  await service.create(CREATE, REVIEWER)
  const denied = await service.update({ pipelineId: 'pipe-1', maxGateRetries: 1 }, VIEWER)
    .then(() => null, (error: unknown) => error)
  assert.ok(denied instanceof PipelineRunError)
  assert.equal(denied.code, 'forbidden')
})

test('W5：编辑的 targetBaseUrl 也要过 SSRF 判据（不能借编辑绕过）', async () => {
  const service = serviceOf(new ScriptedHost())
  await service.create(CREATE, REVIEWER)
  const error = await service.update({ pipelineId: 'pipe-1', targetBaseUrl: 'http://127.0.0.1:9999' }, OPERATOR)
    .then(() => null, (thrown: unknown) => thrown)
  assert.ok(error instanceof PipelineRunError, `期望 PipelineRunError，实际 ${String(error)}`)
  assert.match(String(error.code), /invalid-request|forbidden/)
})

test('W5：有运行在进行中时拒绝编辑（避免"这次运行按哪套参数"不可解释）', async () => {
  const service = serviceOf(new ScriptedHost())
  await service.create(CREATE, REVIEWER)

  // 造一把未释放的运行锁：等价于"另一个进程正在跑"。
  const backend = createFileStorageBackendFromRoots(resolvePlatformRoots(dir, config))
  assert.ok(backend.ports.lock !== undefined)
  const lock = await backend.ports.lock('pipe-1', { ownerId: 'someone-else' })

  const error = await service.update({ pipelineId: 'pipe-1', maxGateRetries: 1 }, OPERATOR)
    .then(() => null, (thrown: unknown) => thrown)
  assert.ok(error instanceof PipelineRunError)
  assert.equal(error.code, 'conflict')
  await lock.release()

  // 锁释放后即可编辑。
  const ok = await service.update({ pipelineId: 'pipe-1', maxGateRetries: 1 }, OPERATOR)
  assert.deepEqual(ok.changedFields, ['maxGateRetries'])
})

// ── 移除 ─────────────────────────────────────────────────────────────────────

test('W5：移除只摘索引（get 变 404），**数据仍留在数据根**', async () => {
  const service = serviceOf(new ScriptedHost())
  await service.create(CREATE, REVIEWER)
  await service.run('pipe-1', REVIEWER)
  const checkpoint = join(projectRoot(), 'checkpoints', 'pipe-1', 'checkpoint.json')
  const artifact = join(projectRoot(), 'artifacts', 'pipe-1', 'receive.json')
  assert.equal(existsSync(checkpoint), true, '前置：检查点应当存在')
  assert.equal(existsSync(artifact), true, '前置：产物应当存在')

  const removed = await service.remove('pipe-1', { ...OPERATOR, roles: ['admin'] })
  assert.equal(removed.removed, true)
  assert.equal(removed.dataRetained, true)
  assert.match(removed.dataRetainedReason, /remove/, '理由里要说清真删需要什么')

  // 索引没了 → 看不见了。
  const gone = await service.get('pipe-1', OPERATOR).then(() => null, (error: unknown) => error)
  assert.equal((gone as PipelineRunError)?.code, 'not-found')
  assert.deepEqual((await service.list(OPERATOR)).map(item => item.pipelineId), [])

  // 但数据还在——这是"可恢复、可取证"的实质。
  assert.equal(existsSync(checkpoint), true, '移除不得删掉检查点（数据保留是承诺）')
  assert.equal(existsSync(artifact), true, '移除不得删掉产物')
})

test('W5：移除要求 admin（operator 被拒），且有运行在进行中时拒绝', async () => {
  const service = serviceOf(new ScriptedHost())
  await service.create(CREATE, REVIEWER)

  const denied = await service.remove('pipe-1', OPERATOR).then(() => null, (error: unknown) => error)
  assert.ok(denied instanceof PipelineRunError)
  assert.equal(denied.code, 'forbidden', '移除是破坏性动作，要求 admin')

  const backend = createFileStorageBackendFromRoots(resolvePlatformRoots(dir, config))
  const lock = await backend.ports.lock!('pipe-1', { ownerId: 'runner' })
  const busy = await service.remove('pipe-1', { ...OPERATOR, roles: ['admin'] })
    .then(() => null, (error: unknown) => error)
  assert.equal((busy as PipelineRunError)?.code, 'conflict')
  await lock.release()
})

test('W5：编辑与移除都写审计事件（可取证）', async () => {
  const service = serviceOf(new ScriptedHost())
  await service.create(CREATE, REVIEWER)
  await service.update({ pipelineId: 'pipe-1', maxGateRetries: 2 }, OPERATOR)
  await service.remove('pipe-1', { ...OPERATOR, roles: ['admin'] })

  const backend = createFileStorageBackendFromRoots(resolvePlatformRoots(dir, config))
  const audit = await backend.ports.audit.read({ pipelineId: 'pipe-1' })
  const kinds = audit.events.map(event => event.kind)
  assert.ok(kinds.includes('pipeline-updated'), `必须有编辑审计：${kinds.join(',')}`)
  assert.ok(kinds.includes('pipeline-removed'), `必须有移除审计：${kinds.join(',')}`)
  const updated = audit.events.find(event => event.kind === 'pipeline-updated')
  assert.equal(updated?.actor, 'ops-1', '审计要记触发者')
})
