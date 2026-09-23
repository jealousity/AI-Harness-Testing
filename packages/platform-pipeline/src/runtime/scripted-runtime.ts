import type { ArtifactStore, HumanDecision, HumanGatePort, ReviewOutcome, ReviewRunner } from '../driver.ts'
import { computeArtifactDigest, type JudgeResult } from '../gates/machine.ts'
import { resolveStageAcl, type SpawnRequest, type SpawnedRun, type StageSpawner } from '../stage-spawner.ts'
import type { PipelineConfig, StageArtifact, StageId } from '../types.ts'

export type ScriptedContentFactory = (input: {
  readonly request: SpawnRequest
  readonly upstream: Readonly<Record<string, unknown>>
}) => unknown | Promise<unknown>

/**
 * 无 Harness 的确定性阶段运行器。
 *
 * 它不是生产 LLM runner，而是方案一的最小可运行宿主：用回调生成阶段产物，
 * 让 PipelineDriver、机器门禁、检查点、重入和存储可以完全脱离 DeepSeek Harness 验证。
 */
export class ScriptedStageRunner implements StageSpawner {
  private readonly artifacts: ArtifactStore
  private readonly makeContent: ScriptedContentFactory

  constructor(artifacts: ArtifactStore, makeContent: ScriptedContentFactory) {
    this.artifacts = artifacts
    this.makeContent = makeContent
  }

  async runStage(request: SpawnRequest, cfg: PipelineConfig): Promise<SpawnedRun> {
    const acl = resolveStageAcl(request.stageId, cfg)
    if (!acl.ok) throw new Error(`stage "${request.stageId}" ACL invalid: ${acl.errors.join('; ')}`)
    const upstream: Record<string, unknown> = {}
    const inputs: Record<string, string> = {}
    for (const [stageId, path] of Object.entries(request.inputPaths)) {
      const artifact = await this.artifacts.read(path)
      if (artifact === null) throw new Error(`missing upstream artifact for ${stageId}: ${path}`)
      upstream[stageId] = artifact.content
      inputs[stageId] = artifact.digest
    }
    const content = await this.makeContent({ request, upstream })
    const base: StageArtifact = {
      pipelineId: request.pipelineId,
      stageId: request.stageId,
      version: 1,
      inputs,
      content,
      digest: '',
      path: request.artifactPath,
    }
    const artifact = { ...base, digest: computeArtifactDigest(base) }
    if (this.artifacts.write === undefined) throw new Error('ScriptedStageRunner requires an ArtifactStore.write implementation')
    await this.artifacts.write(artifact)
    return { stageId: request.stageId, artifactPath: request.artifactPath }
  }
}

export type HumanDecisionFactory = (input: {
  readonly stageId: StageId
  readonly artifact: StageArtifact
  readonly gate: JudgeResult
  readonly review?: ReviewOutcome
}) => HumanDecision | Promise<HumanDecision>

export class CallbackHumanGate implements HumanGatePort {
  private readonly decide: HumanDecisionFactory

  constructor(decide: HumanDecisionFactory) {
    this.decide = decide
  }

  gate(stageId: StageId, artifact: StageArtifact, gate: JudgeResult, review?: ReviewOutcome): Promise<HumanDecision> {
    return Promise.resolve(this.decide({ stageId, artifact, gate, ...(review === undefined ? {} : { review }) }))
  }

  async gateFailed(stageId: StageId, gate: JudgeResult): Promise<void> {
    throw new Error(`machine gate failed after retries at ${stageId}: ${gate.violations.map(v => v.rule).join(', ')}`)
  }
}

export class CallbackReviewRunner implements ReviewRunner {
  private readonly review: (stageId: StageId, artifact: StageArtifact, gate: JudgeResult) => ReviewOutcome | Promise<ReviewOutcome>

  constructor(review: (stageId: StageId, artifact: StageArtifact, gate: JudgeResult) => ReviewOutcome | Promise<ReviewOutcome>) {
    this.review = review
  }

  run(stageId: StageId, artifact: StageArtifact, gate: JudgeResult): Promise<ReviewOutcome> {
    return Promise.resolve(this.review(stageId, artifact, gate))
  }
}
