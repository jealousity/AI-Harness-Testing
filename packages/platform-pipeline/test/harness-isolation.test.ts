/**
 * Harness 解耦边界的可执行断言（docs/10 §1「Harness 已从核心运行时解耦为可选适配层；
 * 核心 runtime 不依赖 `@deepseek-ai/*`」）。
 *
 * 为什么需要这组测试：解耦是一种**会随时间退化**的性质。只要有人图省事在
 * `src/runtime/` 或 `src/documents/` 里写一句 `import … from '@deepseek-ai/…'`，
 * 整个"harness-free"叙事就悄悄失效了，而 typecheck / build / 既有测试全都不会报错
 * （dsh 包在 devDependencies 里，本仓库内永远装得上）。
 *
 * 四条不变量：
 * 1. `src/harness/**` 与 `src/e2e/**` 之外，任何文件都不得引用 `@deepseek-ai/*`；
 * 2. `src/harness/**` 引用到的每个 `@deepseek-ai/*` 包都必须在 `peerDependencies`
 *    里声明且标记 `optional`（否则外部消费者装不上适配层，只能看到 module-not-found）；
 * 3. `src/e2e` 必须被 `tsconfig.build.json` 排除（测试宿主不该进发布物）；
 * 4. `package.json` 的 `files` 必须显式排除 `dist/e2e`。
 *
 * @module platform-pipeline/test/harness-isolation
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const packageRoot = fileURLToPath(new URL('..', import.meta.url))
const srcRoot = join(packageRoot, 'src')

/** 允许引用 `@deepseek-ai/*` 的目录（相对 `src/`）。 */
const ADAPTER_DIRS = ['harness', 'e2e']

/**
 * 去掉注释，保留字符串字面量。
 *
 * 必要性：说明性注释里经常**提到**包名（例如 `plugin.ts` 解释"为什么不再
 * `import type … from '@deepseek-ai/cordis'`"）。注释不是依赖，若不剥离，
 * 这条守卫会因为一句解释而永久失败，最后被人加 `skip` 关掉——那才是真损失。
 *
 * 反过来，字符串字面量必须**原样保留**，因为模块说明符本身就是字符串；
 * 同时要先识别字符串，否则 `'https://…'` 里的 `//` 会被误当行注释而吞掉后文。
 */
function stripComments(source: string): string {
  let out = ''
  let index = 0
  while (index < source.length) {
    const char = source[index]!
    const next = source[index + 1]

    if (char === "'" || char === '"' || char === '`') {
      out += char
      index += 1
      while (index < source.length) {
        const inner = source[index]!
        out += inner
        index += 1
        if (inner === '\\') {
          if (index < source.length) { out += source[index]!; index += 1 }
          continue
        }
        if (inner === char) break
      }
      continue
    }

    if (char === '/' && next === '/') {
      while (index < source.length && source[index] !== '\n') index += 1
      continue
    }
    if (char === '/' && next === '*') {
      index += 2
      while (index < source.length && !(source[index] === '*' && source[index + 1] === '/')) index += 1
      index += 2
      continue
    }

    out += char
    index += 1
  }
  return out
}

/** 从源码文本里抽出全部 `@deepseek-ai/<name>` 引用（忽略注释）。 */
function dshPackagesIn(source: string): Set<string> {
  const found = new Set<string>()
  for (const match of stripComments(source).matchAll(/@deepseek-ai\/([a-z0-9][a-z0-9-]*)/g)) {
    if (match[1] !== undefined) found.add(`@deepseek-ai/${match[1]}`)
  }
  return found
}

async function listTypeScriptFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true })
  const files: string[] = []
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) files.push(...await listTypeScriptFiles(full))
    else if (entry.name.endsWith('.ts')) files.push(full)
  }
  return files
}

test('核心源码（harness/e2e 之外）不引用任何 @deepseek-ai/* 包', async () => {
  const offenders: string[] = []
  for (const file of await listTypeScriptFiles(srcRoot)) {
    const rel = relative(srcRoot, file).replaceAll('\\', '/')
    if (ADAPTER_DIRS.some(dir => rel === dir || rel.startsWith(`${dir}/`))) continue
    const packages = dshPackagesIn(await readFile(file, 'utf8'))
    if (packages.size > 0) offenders.push(`${rel} → ${[...packages].join(', ')}`)
  }
  assert.deepEqual(
    offenders,
    [],
    `核心模块必须保持 harness-free；以下文件引入了 DeepSeek Harness 依赖：\n${offenders.join('\n')}`,
  )
})

test('harness 适配层引用到的每个 @deepseek-ai/* 包都在 peerDependencies 里声明为 optional', async () => {
  const pkg = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8')) as {
    peerDependencies?: Record<string, string>
    peerDependenciesMeta?: Record<string, { optional?: boolean }>
  }
  const declared = new Set(Object.keys(pkg.peerDependencies ?? {}))

  const referenced = new Set<string>()
  for (const file of await listTypeScriptFiles(join(srcRoot, 'harness'))) {
    for (const name of dshPackagesIn(await readFile(file, 'utf8'))) referenced.add(name)
  }
  assert.ok(referenced.size > 0, 'harness 适配层应当引用 @deepseek-ai/*；测试自身已失效，请检查扫描逻辑')

  const missing = [...referenced].filter(name => !declared.has(name)).sort()
  assert.deepEqual(
    missing,
    [],
    `harness 适配层引用了未声明的包，外部消费者会直接 module-not-found：${missing.join(', ')}`,
  )

  const notOptional = [...referenced].filter(name => pkg.peerDependenciesMeta?.[name]?.optional !== true).sort()
  assert.deepEqual(
    notOptional,
    [],
    `适配层依赖必须声明为 optional peer，否则 harness-free 消费者会被迫安装：${notOptional.join(', ')}`,
  )
})

test('src/e2e（测试宿主）被排除在构建产物之外', async () => {
  const buildConfig = JSON.parse(await readFile(join(packageRoot, 'tsconfig.build.json'), 'utf8')) as {
    exclude?: readonly string[]
  }
  assert.ok(
    (buildConfig.exclude ?? []).some(entry => entry.replace(/\/+$/, '') === 'src/e2e'),
    'tsconfig.build.json 必须排除 src/e2e：测试宿主依赖 10 个 harness 包，不属于发布面',
  )

  const pkg = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8')) as {
    files?: readonly string[]
  }
  assert.ok(
    (pkg.files ?? []).some(entry => entry === '!dist/e2e'),
    'package.json 的 files 必须显式排除 dist/e2e，避免历史构建残留被发布',
  )
})
