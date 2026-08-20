/**
 * HTTP 执行器（docs/08：executor 唯一执行者；side-effect 留痕契约 ET-03）。
 * - 入参只传 caseId；用例定义经注入的 resolveCase 自读（不信任调用方传入内容）；
 * - 每一步真实发请求并抓取 wire 数据（方法/URL/状态/响应片段）作为证据留痕；
 * - 断言（expectedStatus / expectedContains）决定 pass/fail；
 * - 产出时序链记录（R4-09）与锚定证据（R4-10，capturedBy = executor:<invocationId>）。
 * @module platform-pipeline/executor/http
 */

import { createHash } from 'node:crypto'
import { makeRecord, type ExecutionRecord } from './records.ts'
import type { EvidenceEntry } from './verify.ts'
import type { Executor, ExecutorContext, ExecutionSession } from './executor.ts'

export interface HttpStep {
  readonly kind: 'http-request'
  readonly name: string
  readonly method: string
  readonly url: string
  readonly body?: unknown
  readonly expectedStatus?: number
  readonly expectedContains?: string
}

export interface HttpCase {
  readonly id: string
  readonly steps: readonly HttpStep[]
}

/** fetch 面抽象（测试注入本地服务器；默认 globalThis.fetch）。 */
export interface HttpResponse {
  readonly status: number
  text(): Promise<string>
}
export type HttpRequestFn = (url: string, init: {
  readonly method: string
  readonly headers: Readonly<Record<string, string>>
  readonly body?: string
}) => Promise<HttpResponse>

export interface HttpExecutorOptions {
  /** 用例定义来源（宿主从 design 产物注入）。 */
  readonly resolveCase: (caseId: string) => Promise<HttpCase | undefined>
  /** 证据写入（宿主实现为写 evidenceDir 文件）。 */
  readonly writeEvidence: (path: string, content: string) => Promise<void>
  readonly request?: HttpRequestFn
}

/** wire 留痕内容（ET-03：接口类记录真实请求/响应）。 */
function wireCapture(step: HttpStep, status: number, bodySnippet: string): string {
  return JSON.stringify({
    kind: 'http-request',
    name: step.name,
    method: step.method,
    url: step.url,
    status,
    responseSnippet: bodySnippet.slice(0, 2048),
    capturedAt: Date.now(),
  }, null, 2)
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

export class HttpExecutor implements Executor {
  private readonly options: HttpExecutorOptions
  private readonly request: HttpRequestFn

  constructor(options: HttpExecutorOptions) {
    this.options = options
    this.request = options.request ?? ((url, init) => globalThis.fetch(url, init) as Promise<HttpResponse>)
  }

  async run(caseIds: readonly string[], ctx: ExecutorContext): Promise<ExecutionSession> {
    const records: ExecutionRecord[] = []
    const evidence: EvidenceEntry[] = []
    let prevHash = ''
    let prevCapturedAt = 0

    for (const caseId of caseIds) {
      const testCase = await this.options.resolveCase(caseId)
      if (testCase === undefined) {
        // 用例缺失 = 执行器无法运行：记 fail + 诊断证据（R4-02 fail 必带证据）
        const capturedAt = Math.max(Date.now(), prevCapturedAt + 1)
        const entry = await this.capture(
          ctx, `${caseId}-missing`, `{"error":"case ${caseId} not found in design artifact"}`, capturedAt, records.length + 1,
        )
        evidence.push(entry)
        const record = makeRecord({
          seq: records.length + 1, caseId, capturedAt, durationMs: 0,
          status: 'fail', evidenceRefs: [entry.id], prevHash, segment: 1,
        })
        records.push(record)
        prevHash = record.ownHash
        prevCapturedAt = capturedAt
        continue
      }

      const start = Date.now()
      let passed = true
      const refs: string[] = []
      for (const step of testCase.steps) {
        const capturedAt = Math.max(Date.now(), prevCapturedAt + 1)
        try {
          const response = await this.request(step.url, {
            method: step.method,
            headers: { 'content-type': 'application/json' },
            ...(step.body === undefined ? {} : { body: JSON.stringify(step.body) }),
          })
          const body = await response.text()
          const ok = (step.expectedStatus === undefined || response.status === step.expectedStatus)
            && (step.expectedContains === undefined || body.includes(step.expectedContains))
          const entry = await this.capture(ctx, `${caseId}-${step.name}`, wireCapture(step, response.status, body), capturedAt, records.length + 1)
          evidence.push(entry)
          refs.push(entry.id)
          if (!ok) { passed = false; break }
        } catch (error) {
          const entry = await this.capture(
            ctx, `${caseId}-${step.name}-error`,
            JSON.stringify({ error: error instanceof Error ? error.message : String(error), step: step.name }),
            capturedAt, records.length + 1,
          )
          evidence.push(entry)
          refs.push(entry.id)
          passed = false
          break
        }
      }
      const end = Date.now()
      const capturedAt = Math.max(start, prevCapturedAt + 1)
      const record = makeRecord({
        seq: records.length + 1, caseId,
        capturedAt, durationMs: end - start,
        status: passed ? 'pass' : 'fail',
        evidenceRefs: refs, prevHash, segment: 1,
      })
      records.push(record)
      prevHash = record.ownHash
      prevCapturedAt = capturedAt
    }

    return { records, evidence }
  }

  private async capture(
    ctx: ExecutorContext,
    id: string,
    content: string,
    capturedAt: number,
    recordId: number,
  ): Promise<EvidenceEntry> {
    const file = `${id}-${sha256(content).slice(0, 8)}.json`
    await this.options.writeEvidence(`${ctx.evidenceDir}/${file}`, content)
    return {
      id, recordId, file,
      digest: sha256(content),
      capturedBy: `executor:${ctx.invocationId}`,
      capturedAt,
    }
  }
}
