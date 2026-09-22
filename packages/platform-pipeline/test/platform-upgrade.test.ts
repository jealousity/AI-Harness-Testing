import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normalizeConfig } from '../src/config.ts'
import { providerRegistry } from '../src/provider-registry.ts'
import { assertScopeMatch, projectDataRoot, scopedPath } from '../src/platform-scope.ts'
import { resolvePlatformRoots } from '../src/platform-roots.ts'
import { parseDelimitedKnowledge, parseMarkdownKnowledge } from '../src/knowledge-import.ts'
import { resolveHarnessHostRuntime } from '../src/harness/runtime-config.ts'

const stores = {
  knowledge: { impl: 'markdown-fs', path: 'knowledge' },
  cases: { impl: 'markdown-fs', path: 'cases' },
  requirements: { primary: { impl: 'paste' } },
}

function baseConfig(extra: Record<string, unknown> = {}) {
  return normalizeConfig({
    projectId: 'demo',
    projectType: 'api-service',
    templateVersion: 'v1',
    scaleTier: 'S',
    stores,
    stages: {},
    ...extra,
  })
}

test('通用配置保留 llm provider 与平台 scope', () => {
  const config = baseConfig({
    scope: { tenantId: 'acme', environment: 'staging' },
    llm: {
      defaultProvider: 'primary',
      providers: {
        primary: {
          type: 'openai-compatible',
          baseUrl: 'https://llm.example.com/v1/',
          model: 'general-model',
          apiKeyEnv: 'LLM_API_KEY',
          capabilities: { tools: true, structuredOutput: true },
        },
      },
    },
  })
  assert.equal(config.scope?.tenantId, 'acme')
  assert.equal(config.llm?.providers.primary.baseUrl, 'https://llm.example.com/v1')
})

test('provider registry selects configured provider without exposing key', () => {
  const config = baseConfig({
    llm: {
      defaultProvider: 'primary',
      providers: {
        primary: { type: 'openai-compatible', baseUrl: 'https://llm.example.com', model: 'm', apiKeyEnv: 'LLM_API_KEY', capabilities: { tools: true } },
        backup: { type: 'openai-compatible', baseUrl: 'https://backup.example.com', model: 'm2', apiKeyEnv: 'BACKUP_KEY', capabilities: { tools: true } },
      },
    },
  }).llm!
  const selected = providerRegistry(config, { LLM_API_KEY: 'secret' }).resolve(undefined, { tools: true })
  assert.equal(selected.name, 'primary')
  assert.equal(selected.apiKey, 'secret')
  assert.deepEqual(new Set(providerRegistry(config, { BACKUP_KEY: 'backup' }).names()), new Set(['backup', 'primary']))
  assert.throws(() => providerRegistry(config, {}).resolve(), /LLM_API_KEY/)
})

test('scope rejects cross-project and unsafe path access', () => {
  const scope = { tenantId: 'acme', projectId: 'demo', environment: 'staging' }
  assert.doesNotThrow(() => assertScopeMatch({ ...scope }, scope))
  assert.throws(() => assertScopeMatch({ ...scope }, { ...scope, projectId: 'other' }), /project scope mismatch/)
  assert.match(projectDataRoot('/data', scope), /tenants[\\/]acme[\\/]projects[\\/]demo$/)
  assert.match(scopedPath('/data', scope, 'knowledge', 'doc.md'), /knowledge[\\/]doc\.md$/)
  assert.throws(() => scopedPath('/data', scope, '../other'), /stay inside/)
  const roots = resolvePlatformRoots('/data', { projectId: 'demo', scope: { tenantId: 'acme' }, stores })
  assert.match(roots.artifactsRoot, /projects[\\/]demo$/)
  assert.match(roots.knowledgeRoot ?? '', /projects[\\/]demo[\\/]knowledge$/)
})

test('Harness host runtime derives scoped roots and provider without exposing key', () => {
  const config = baseConfig({
    scope: { tenantId: 'acme' },
    llm: {
      defaultProvider: 'primary',
      providers: {
        primary: { type: 'openai-compatible', baseUrl: 'https://llm.example.com', model: 'm', apiKeyEnv: 'LLM_API_KEY', capabilities: { tools: true, structuredOutput: true } },
      },
    },
  })
  const runtime = resolveHarnessHostRuntime(config, { dataRoot: '/data', environment: { LLM_API_KEY: 'secret' } })
  assert.equal(runtime.providerName, 'primary')
  assert.match(runtime.roots.artifactsRoot, /projects[\\/]demo$/)
  assert.match(runtime.roots.checkpointRoot, /projects[\\/]demo[\\/]checkpoints$/)
  assert.equal(runtime.provider?.apiKey, 'secret')
})

test('Markdown 导入按章节生成 draft 知识并保留来源', () => {
  const entries = parseMarkdownKnowledge('# 支付服务\n\n## 幂等策略\n接口使用 requestId 去重。\n\n## 超时策略\n调用方需要重试。', 'docs/payment.md', { project: 'demo' })
  assert.equal(entries.length, 2)
  assert.equal(entries[0]?.status, 'draft')
  assert.equal(entries[0]?.sourceRefs?.[0], 'docs/payment.md')
  assert.match(entries[1]?.body ?? '', /重试/)
})

test('CSV/TSV 导入按行生成 draft 知识并提取标签实体', () => {
  const entries = parseDelimitedKnowledge('title,service,tags,rule\n重试策略,PaymentService,"retry,api",最多3次\n', 'csv', 'rules.csv', { project: 'demo' })
  assert.equal(entries.length, 1)
  assert.deepEqual(entries[0]?.entities, ['PaymentService'])
  assert.deepEqual(entries[0]?.tags, ['retry', 'api'])
  assert.match(entries[0]?.body ?? '', /最多3次/)
})
