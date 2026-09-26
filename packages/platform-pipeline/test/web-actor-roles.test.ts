/**
 * 运维动作的角色边界（docs/11 P1-02）。
 *
 * 类型契约（`pipeline-run-types.ts` 的 `ActorRole` 文档）早已写明：
 * `claimGate`/`decideGate` 要求 `reviewer`/`admin`，`reenter`/`cancelGate` 要求
 * `operator`/`admin`。修复前只有人工门裁决真的校验了角色，`reenter` 与
 * `cancelGate` 只要求"actorId 非空"——于是任何只读调用者都能回退 cursor、
 * 取消人工门任务，改变流水线的持久化事实。
 *
 * 判定必须**失败关闭**：缺少 `roles` 即无特权，不因字段缺省而放行。
 *
 * @module platform-pipeline/test/web-actor-roles
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { loadCheckpoint } from '../src/checkpoint.ts'
import { resolvePlatformRoots } from '../src/platform-roots.ts'
import type { PipelineConfig } from '../src/types.ts'
import { FilePipelineRunService } from '../src/web/pipeline-run-service.ts'
import { PipelineRunError, type ActorContext } from '../src/web/pipeline-run-types.ts'
import { REVIEWER, SCOPE, ScriptedHost, baseConfig } from './web-fixtures.ts'

let dir: string
let config: PipelineConfig

test.beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'pp-roles-'))
  config = baseConfig()
})
test.afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

function serviceOf(host = new ScriptedHost()): FilePipelineRunService {
  return new FilePipelineRunService({
    dataRoot: dir,
    loadConfig: async () => config,
    createHost: host.factory,
  })
}

/** 无任何角色的身份：`roles` 字段缺省即失败关闭。 */
const NO_ROLES: ActorContext = { actorId: 'nobody', tenantId: 'acme' }
const VIEWER: ActorContext = { actorId: 'viewer-1', tenantId: 'acme', roles: ['viewer'] }
const REVIEWER_ONLY: ActorContext = { actorId: 'rev-1', tenantId: 'acme', roles: ['reviewer'] }
const OPERATOR: ActorContext = { actorId: 'ops-1', tenantId: 'acme', roles: ['operator'] }
const ADMIN: ActorContext = { actorId: 'admin-1', tenantId: 'acme', roles: ['admin'] }

function isCode(code: string) {
  return (error: unknown): boolean => error instanceof PipelineRunError && error.code === code
}

/** 创建 + 跑到 receive 人工门（用 ADMIN，避免创建路径本身的角色问题干扰断言）。 */
async function parkedAtGate(): Promise<{ service: FilePipelineRunService; gateTaskId: string }> {
  const service = serviceOf()
  await service.create({ projectId: 'demo', pipelineId: 'pipe-1', configRef: 'pipeline.yaml' }, ADMIN)
  const result = await service.run('pipe-1', ADMIN)
  assert.equal(result.outcome, 'waiting-human')
  if (result.outcome !== 'waiting-human') throw new Error('unreachable')
  return { service, gateTaskId: result.gateTaskId }
}

// ── reenter 需要 operator/admin ───────────────────────────────────────────────

test('reenter 需要 operator/admin：viewer 与无角色身份一律 403', async () => {
  const { service } = await parkedAtGate()
  for (const actor of [VIEWER, NO_ROLES, REVIEWER_ONLY]) {
    await assert.rejects(
      () => service.reenter({ ...SCOPE, stageId: 'receive', reason: '想回退' }, actor),
      isCode('forbidden'),
      `${actor.actorId}(${JSON.stringify(actor.roles ?? [])}) 不得 reenter`,
    )
  }
})

test('reenter 允许 operator 与 admin', async () => {
  const { service } = await parkedAtGate()
  const byOperator = await service.reenter({ ...SCOPE, stageId: 'receive', reason: '运维回退' }, OPERATOR)
  assert.equal(byOperator.reentries.length, 1)
  assert.equal(byOperator.reentries[0]!.by, 'ops-1', '审计记录必须记下真正的操作者')

  const byAdmin = await service.reenter({ ...SCOPE, stageId: 'receive', reason: '管理员再回退' }, ADMIN)
  assert.equal(byAdmin.reentries.length, 2)
  assert.equal(byAdmin.reentries[1]!.by, 'admin-1')
})

test('被拒的 viewer 不改变任何持久化事实（检查点原样）', async () => {
  const { service } = await parkedAtGate()
  const roots = resolvePlatformRoots(dir, config)
  const checkpointRoot = join(roots.checkpointRoot, 'pipe-1')
  const before = await loadCheckpoint(checkpointRoot)

  await assert.rejects(
    () => service.reenter({ ...SCOPE, stageId: 'receive', reason: '偷偷回退' }, VIEWER),
    isCode('forbidden'),
  )

  const after = await loadCheckpoint(checkpointRoot)
  assert.deepEqual(after, before, '被拒的请求不得留下任何痕迹')
})

// ── cancelGate 需要 operator/admin ───────────────────────────────────────────

test('cancelGate 需要 operator/admin：viewer 与无角色身份一律 403', async () => {
  const { service, gateTaskId } = await parkedAtGate()
  for (const actor of [VIEWER, NO_ROLES, REVIEWER_ONLY]) {
    await assert.rejects(
      () => service.cancelGate({ ...SCOPE, gateTaskId }, actor),
      isCode('forbidden'),
      `${actor.actorId}(${JSON.stringify(actor.roles ?? [])}) 不得 cancelGate`,
    )
  }
  const [task] = await service.listGateTasks(SCOPE, REVIEWER)
  assert.equal(task!.status, 'pending', '被拒的取消不得改动门任务状态')
})

test('cancelGate 允许 operator 与 admin', async () => {
  const { service, gateTaskId } = await parkedAtGate()
  const cancelled = await service.cancelGate({ ...SCOPE, gateTaskId, note: '重复门' }, OPERATOR)
  assert.equal(cancelled.status, 'cancelled')
  assert.equal(cancelled.cancellation!.by, 'ops-1')
})

// ── 人工门裁决仍是 reviewer/admin（回归） ─────────────────────────────────────

test('claimGate/decideGate 只接受 reviewer/admin：operator 与 viewer 都被拒', async () => {
  const { service, gateTaskId } = await parkedAtGate()
  for (const actor of [VIEWER, NO_ROLES, OPERATOR]) {
    await assert.rejects(
      () => service.claimGate({ ...SCOPE, gateTaskId }, actor),
      isCode('forbidden'),
      `${actor.actorId} 不得 claimGate`,
    )
    await assert.rejects(
      () => service.decideGate({ ...SCOPE, gateTaskId, action: 'approved' }, actor),
      isCode('forbidden'),
      `${actor.actorId} 不得 decideGate`,
    )
  }
  const [task] = await service.listGateTasks(SCOPE, REVIEWER)
  assert.equal(task!.status, 'pending')
})

test('admin 具备全部运维与裁决能力', async () => {
  const { service, gateTaskId } = await parkedAtGate()
  await service.claimGate({ ...SCOPE, gateTaskId }, ADMIN)
  const decided = await service.decideGate({ ...SCOPE, gateTaskId, action: 'approved' }, ADMIN)
  assert.equal(decided.status, 'approved')
  const checkpoint = await service.reenter({ ...SCOPE, stageId: 'receive', reason: '再跑一次' }, ADMIN)
  assert.equal(checkpoint.reentries.length, 1)
})

test('只读动作（get/list/listGateTasks）不需要运维角色，但仍需要非空身份', async () => {
  const { service } = await parkedAtGate()
  for (const actor of [VIEWER, NO_ROLES]) {
    await service.get('pipe-1', actor)
    await service.list(actor)
    await service.listGateTasks(SCOPE, actor)
  }
  await assert.rejects(() => service.get('pipe-1', { actorId: '  ' }), isCode('unauthenticated'))
})
