/**
 * Web UI 契约测试（`docs/14` §3 W4 的交互要求）。
 *
 * 为什么需要它：前端没有框架、没有构建步骤，因此**没有任何东西会在编译期拦住**
 * "app.js 引用了 index.html 里不存在的 id"、"用 innerHTML 拼服务端数据"这类错误——
 * 它们只会在用户打开页面时表现为白屏或 XSS。这里把 W4 的结构性要求变成可回归的断言。
 *
 * 它**不替代**浏览器验证：这里只检查静态结构，不执行 JS。真正的交互仍由
 * `docs/14` W6 的浏览器验收覆盖。
 *
 * @module platform-pipeline/test/web-ui-contract
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const PUBLIC_DIR = join(here, '..', '..', '..', 'web-app', 'public')

async function readPublic(name: string): Promise<string> {
  return readFile(join(PUBLIC_DIR, name), 'utf8')
}

/**
 * 去掉 CSS 注释后再断言。
 *
 * **必须做这一步**：注释里会写"不要用 `outline: none`"这类**反面说明**，
 * 直接扫全文会把自己的注释当成违规（本文件第一版就踩了这个）。
 * 同类教训在 `test/harness-isolation.test.ts` 里也有：扫描源码时必须剥离注释。
 */
function stripCssComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, '')
}

test('UI：app.js 引用的每个元素 id 都存在于 index.html（否则页面一启动就 null 崩溃）', async () => {
  const js = await readPublic('app.js')
  const html = await readPublic('index.html')
  const referenced = [...new Set([...js.matchAll(/\$\('([A-Za-z0-9_-]+)'\)/g)].map(match => match[1]))]
  const declared = new Set([...html.matchAll(/id="([^"]+)"/g)].map(match => match[1]))

  assert.ok(referenced.length > 20, `应当引用足够多的元素，实际 ${referenced.length}`)
  const missing = referenced.filter(id => !declared.has(id))
  assert.deepEqual(missing, [], `index.html 缺少这些 id：${missing.join(', ')}`)
})

test('UI：app.js 不得用 innerHTML / insertAdjacentHTML 拼服务端内容（安全渲染）', async () => {
  const js = await readPublic('app.js')
  // 产物内容、findings、violations 都由 agent 生成，可能含 `<script>`。
  // 唯一允许的写入通道是 `el()` 里的 textContent。
  assert.equal(/\.innerHTML\s*=/.test(js), false, 'app.js 出现 .innerHTML 赋值：服务端内容会进入 HTML 解析器')
  assert.equal(/insertAdjacentHTML/.test(js), false, 'app.js 出现 insertAdjacentHTML')
  assert.equal(/document\.write/.test(js), false, 'app.js 出现 document.write')
  // 正向：确实在用 textContent。
  assert.match(js, /textContent/, 'app.js 必须通过 textContent 渲染文本')
})

test('UI：必须消费服务端的派生字段，而不是自己推断业务状态', async () => {
  const js = await readPublic('app.js')
  for (const field of ['nextAction', 'blockingReason', 'gateKind', 'isEscalation', 'currentStage']) {
    assert.match(js, new RegExp(field), `app.js 必须消费派生字段 ${field}`)
  }
  // 反向：不得在前端重写状态机（例如自己把 gate-failed 映射成可批准）。
  assert.equal(/status\s*===\s*'gate-failed'\s*\?\s*'approved'/.test(js), false,
    '前端不得自行把终态映射成批准')
})

test('UI：index.html 不含任何 API Key 输入，且有凭据说明', async () => {
  const html = await readPublic('index.html')

  // 只检查**表单控件**：凭据说明里出现 `apiKeyEnv` 是**应该的**（那是在解释注入方式），
  // 用全文正则会把正确的说明文字判成违规。
  const controls = [...html.matchAll(/<(input|textarea|select)\b[^>]*>/g)].map(match => match[0])
  assert.ok(controls.length > 5, `应当有多个表单控件，实际 ${controls.length}`)
  for (const tag of controls) {
    assert.equal(/api[-_]?key/i.test(tag), false, `表单控件不得与 apiKey 相关：${tag}`)
  }

  assert.match(html, /id="notice"/, '必须有凭据说明区域')
  assert.match(html, /apiKeyEnv/, '凭据说明要点明注入方式')
})

test('UI：可访问性结构（跳过链接 / aria-live / 表单标签 / 当前阶段 aria-current）', async () => {
  const html = await readPublic('index.html')
  assert.match(html, /class="skip-link"/, '需要"跳到主内容"链接')
  assert.match(html, /aria-live="polite"/, '状态变化必须能被读屏播报')
  assert.match(html, /<main id="main">/, '需要 main 地标')
  // 表单控件必须有 label（用 for 关联或 aria-label）。
  const inputs = [...html.matchAll(/<(input|select|textarea)\b[^>]*id="([^"]+)"[^>]*>/g)]
  assert.ok(inputs.length > 5, `表单控件应当有多个，实际 ${inputs.length}`)
  for (const [, , id] of inputs) {
    const labelled = html.includes(`for="${id}"`) || new RegExp(`<[^>]*id="${id}"[^>]*aria-label=`).test(html)
    assert.ok(labelled, `控件 ${id} 缺少 label 或 aria-label`)
  }
  const js = await readPublic('app.js')
  assert.match(js, /aria-current/, '当前阶段必须用 aria-current 表达（不能只靠颜色）')
})

test('UI：自动刷新可暂停，且暂停后明确提示"数据可能过期"', async () => {
  const js = await readPublic('app.js')
  const html = await readPublic('index.html')
  assert.match(html, /id="btn-poll"/, '需要暂停自动刷新的入口')
  assert.match(js, /已暂停，数据可能过期/, '暂停后必须明确告知数据可能过期（不能静默停摆）')
  assert.match(js, /state\.polling/, '轮询必须受开关控制')
})

test('UI：轮询不得覆盖用户正在输入的门任务面板', async () => {
  const js = await readPublic('app.js')
  assert.match(js, /function gatesFrozen\(/, '需要"用户正在输入则冻结面板"的判断')
  assert.match(js, /门任务有新变化，但你正在输入/, '冻结时必须提示"有新变化"')
})

test('UI：503 必须显示为基础设施故障并提供重试，不得显示成"没有数据"', async () => {
  const js = await readPublic('app.js')
  assert.match(js, /httpStatus === 503/, '必须单独识别 503')
  assert.match(js, /存储暂不可用/, '503 的文案必须点明是存储故障')
  assert.match(js, /retry-storage/, '需要把 retry-storage 动作接上重试')
})

test('UI：升级任务与阶段门在文案与样式上都能区分', async () => {
  const js = await readPublic('app.js')
  const css = await readPublic('styles.css')
  assert.match(js, /升级任务（非阶段门）/, '必须在文案上写明种类，不能只靠底色')
  assert.match(css, /\[data-escalation="true"\]/, '升级任务需要独立样式')
  assert.match(css, /\[data-escalation="false"\]/, '阶段门需要独立样式')
})

test('UI：六阶段 Stepper 在窄屏可横向滚动', async () => {
  const css = await readPublic('styles.css')
  assert.match(css, /\.stepper\s*\{[^}]*overflow-x:\s*auto/s, 'Stepper 必须能横向滚动（窄屏不溢出）')
  assert.match(css, /@media\s*\(max-width/, '需要窄屏媒体查询')
})

test('UI：焦点可见（不得用 outline: none 抹掉焦点环）', async () => {
  const css = stripCssComments(await readPublic('styles.css'))
  assert.match(css, /:focus-visible/, '需要 :focus-visible 样式')
  assert.equal(/outline:\s*none/.test(css), false, '不得用 outline: none 抹掉焦点可见性')
})

test('UI：按钮有明确禁用态（不只靠鼠标指针）', async () => {
  const css = await readPublic('styles.css')
  assert.match(css, /button:disabled/, '禁用态必须有视觉表达')
})

test('UI：刷新后能恢复同一条流水线（pipelineId 只进 URL，不作状态缓存）', async () => {
  const js = await readPublic('app.js')
  // 启动时从 hash 还原；hashchange 时跟随。
  assert.match(js, /location\.hash/, '必须把 pipelineId 写进 URL')
  assert.match(js, /hashchange/, '需要监听 hashchange（浏览器前进/后退、手改 URL）')
  assert.match(js, /#pipeline=|pipeline=\(\[\^&\]\+\)/, 'URL 里要能解析出 pipelineId')
  // 反向：不得把运行状态存进 localStorage/sessionStorage（那会成为第二份事实来源）。
  assert.equal(/localStorage|sessionStorage/.test(js), false,
    'app.js 不得使用 localStorage/sessionStorage 缓存运行状态')
})

test('UI：主要操作都有 loading / error / success 三种结果表达', async () => {
  const js = await readPublic('app.js')
  const css = stripCssComments(await readPublic('styles.css'))
  // 结果区按 kind 区分样式，且三种 kind 都被用到。
  for (const kind of ['ok', 'warn', 'error']) {
    assert.match(js, new RegExp(`'${kind}'`), `app.js 必须用到 ${kind} 结果类型`)
    assert.match(css, new RegExp(`\\.out\\[data-kind="${kind}"\\]`), `styles.css 必须为 ${kind} 定义样式`)
  }
  // loading：请求期间禁用按钮（`state.busy`）。
  assert.match(js, /state\.busy/, '请求期间必须有忙碌态')
  assert.match(js, /disabled\s*=/, '忙碌态必须体现为按钮禁用')
})
