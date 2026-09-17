import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

export interface PipelineLock {
  readonly path: string
  readonly owner: string
  readonly acquiredAt: number
  release(): Promise<void>
}

const DEFAULT_STALE_MS = 6 * 60 * 60 * 1000

/** Cross-process best-effort pipeline lock backed by an exclusive directory. */
export async function acquirePipelineLock(
  checkpointRoot: string,
  pipelineId: string,
  staleMs = DEFAULT_STALE_MS,
): Promise<PipelineLock> {
  const path = join(checkpointRoot, pipelineId, '.pipeline.lock')
  const owner = randomUUID()
  const acquiredAt = Date.now()
  await mkdir(join(checkpointRoot, pipelineId), { recursive: true })
  try {
    await mkdir(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    let stale = false
    try {
      const raw = await readFile(join(path, 'owner.json'), 'utf8')
      const info = JSON.parse(raw) as { acquiredAt?: number }
      stale = typeof info.acquiredAt !== 'number' || Date.now() - info.acquiredAt > staleMs
    } catch {
      stale = true
    }
    if (!stale) throw new Error(`pipeline ${pipelineId} is locked by another process`)
    await rm(path, { recursive: true, force: true })
    await mkdir(path)
  }
  await writeFile(join(path, 'owner.json'), JSON.stringify({ owner, acquiredAt, pid: process.pid }))
  let released = false
  return {
    path,
    owner,
    acquiredAt,
    async release() {
      if (released) return
      released = true
      try {
        const raw = await readFile(join(path, 'owner.json'), 'utf8')
        const info = JSON.parse(raw) as { owner?: string }
        if (info.owner === owner) await rm(path, { recursive: true, force: true })
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    },
  }
}
