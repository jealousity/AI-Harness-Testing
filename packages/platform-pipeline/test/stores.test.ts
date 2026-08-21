import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FsArtifactStore, FsCheckpointPort } from '../src/stores/fs.ts'
import { initialCheckpoint } from '../src/checkpoint.ts'
import { computeArtifactDigest } from '../src/gates/machine.ts'
import type { StageArtifact } from '../src/types.ts'

let dir: string

test.beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'pp-stores-'))
})

test.afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

function artifact(): StageArtifact {
  const base: StageArtifact = {
    pipelineId: 'pipe-1',
    stageId: 'receive',
    version: 1,
    inputs: {},
    content: { requirements: [], clarifications: [] },
    digest: '',
    path: 'receive.json',
  }
  return { ...base, digest: computeArtifactDigest(base) }
}

test('FsArtifactStore persists content and read wraps it (disk = bare content)', async () => {
  const store = new FsArtifactStore(join(dir, 'artifacts'))
  const art = artifact()
  await store.write(art)
  // 磁盘只存 content（无 wrapper 字段）
  const raw = await readFile(join(dir, 'artifacts', 'receive.json'), 'utf8')
  assert.deepEqual(JSON.parse(raw), art.content)
  // read 返回包装后的 wrapper（stageId 从路径派生；digest 由 content 重算）
  const loaded = await store.read('receive.json')
  assert.ok(loaded !== null)
  assert.equal(loaded.stageId, 'receive')
  assert.deepEqual(loaded.content, art.content)
  assert.ok(loaded.digest.length === 64)
})

test('FsArtifactStore read missing returns null', async () => {
  const store = new FsArtifactStore(join(dir, 'artifacts'))
  assert.equal(await store.read('receive.json'), null)
})

test('FsArtifactStore rejects path escape', async () => {
  const store = new FsArtifactStore(join(dir, 'artifacts'))
  await assert.rejects(() => store.read('../outside.json'), /escapes artifact base/)
  await assert.rejects(() => store.write({ ...artifact(), path: '../../etc/passwd' }), /escapes artifact base/)
})

test('FsCheckpointPort load/save round-trips', async () => {
  const port = new FsCheckpointPort()
  const root = join(dir, 'artifacts', 'pipe-1')
  const cp = initialCheckpoint('pipe-1', 'v1', 'rules-v1')
  await port.save(root, cp)
  const loaded = await port.load(root)
  assert.ok(loaded !== null)
  assert.equal(loaded.pipelineId, 'pipe-1')
  assert.equal(loaded.cursor, 0)
})
