/**
 * 流水线控制台前端（docs/14 §3 W4）。
 *
 * 四条纪律：
 * 1. **只渲染服务端字段**：阶段状态、下一步动作、门任务种类全部来自服务端派生字段
 *    （`nextAction` / `gateKind` / `isEscalation`），浏览器**不自己推断**业务状态。
 * 2. **安全渲染**：所有服务端内容一律经 `textContent` 写入，**任何地方都不用 `innerHTML`
 *    拼数据**（产物内容、findings、violations 都可能含 `<script>` 之类）。
 * 3. **不打断用户**：轮询只更新事实，不覆盖正在查看的产物、也不覆盖正在输入的门任务说明。
 * 4. **不伪造**：拿不到的数据显示"—"或明确的错误，不编占位值；503 不显示成"没有流水线"。
 *
 * 不引入任何前端框架/外部资源：本地单机要能离线运行。
 */

// ── 标签映射（仅用于显示，不参与任何判断）────────────────────────────────────

const STAGE_LABELS = {
  receive: '需求接收',
  analyze: '需求分析',
  design: '测试设计',
  execute: '测试执行',
  report: '测试报告',
  archive: '产物归档',
}

const RUN_STATUS_LABELS = {
  queued: '排队中',
  running: '运行中',
  'waiting-human': '等待人工裁决',
  'needs-fix': '打回重跑中',
  'gate-failed': '机器门禁失败',
  'review-failed': '交叉检查未通过',
  rejected: '已被拒绝',
  completed: '已完成',
  failed: '失败',
  cancelled: '已取消',
}

const STAGE_STATUS_LABELS = {
  idle: '未开始',
  running: '运行中',
  produced: '已产出待门禁',
  'awaiting-gate': '等待人工裁决',
  'needs-fix': '需修复重跑',
  'needs-reentry': '待重入',
  done: '已完成',
  'gate-failed': '门禁失败',
  'review-failed': '交叉检查未通过',
}

const GATE_STATUS_LABELS = {
  pending: '待认领',
  claimed: '已认领',
  approved: '已批准',
  'changes-needed': '已打回',
  rejected: '已拒绝',
  expired: '已过期',
  cancelled: '已取消',
}

const EVENT_LABELS = {
  'gate-opened': '开门',
  'gate-claimed': '认领',
  'gate-decided': '裁决',
  'gate-cancelled': '取消',
  'gate-consumed': '消费裁决',
  'stage-failure': '阶段失败',
  reenter: '重入',
}

/** 服务端 `nextAction` → 主操作按钮文案。**不在这里做业务判断**，只做文案映射。 */
const ACTION_LABELS = {
  run: '触发运行',
  'view-artifact': '查看当前阶段产物',
  'claim-gate': '认领门任务',
  'decide-gate': '去裁决',
  reenter: '去登记重入',
  'retry-storage': '重试（存储暂不可用）',
  none: '暂无可用操作',
}

// ── 状态（只存**导航上下文**与本次会话的界面状态，不存业务状态）─────────────

const state = {
  /** 当前打开的流水线；唯一持久化到 URL 的东西。 */
  pipelineId: null,
  view: null,
  gates: [],
  usage: null,
  events: [],
  /** 产物查看器展开的阶段；跨刷新保留（不打断用户）。 */
  openArtifact: null,
  artifact: null,
  artifactError: null,
  /** 列表与筛选（纯界面状态）。 */
  list: [],
  filters: { projectId: '', status: '' },
  /** 左侧菜单当前选中项（未打开流水线时右侧显示什么）。 */
  nav: 'list',
  polling: true,
  busy: false,
  /** 最近一次刷新失败的原因；`null` 表示本次刷新成功。 */
  lastError: null,
}

// ── 安全 DOM 构造（**唯一**创建节点的方式；没有 innerHTML）────────────────────

function el(tag, options = {}, children = []) {
  const node = document.createElement(tag)
  if (options.className !== undefined) node.className = options.className
  // `text` 一律走 textContent —— 这是"服务端内容不进 HTML 解析器"的唯一保证。
  if (options.text !== undefined && options.text !== null) node.textContent = String(options.text)
  if (options.attrs !== undefined) {
    for (const [key, value] of Object.entries(options.attrs)) {
      if (value === null || value === undefined || value === false) continue
      node.setAttribute(key, value === true ? '' : String(value))
    }
  }
  if (options.on !== undefined) {
    for (const [type, handler] of Object.entries(options.on)) node.addEventListener(type, handler)
  }
  for (const child of children) if (child !== null && child !== undefined) node.append(child)
  return node
}

const $ = id => document.getElementById(id)

function chip(label, status) {
  return el('span', { className: 'chip', text: label, attrs: { 'data-status': status } })
}

function timeText(ms) {
  return typeof ms === 'number' && Number.isFinite(ms) ? new Date(ms).toLocaleString() : '—'
}

// ── 请求封装 ─────────────────────────────────────────────────────────────────

class ApiError extends Error {
  constructor(code, message, httpStatus, details) {
    super(message)
    this.code = code
    this.httpStatus = httpStatus
    this.details = details
  }
}

async function api(method, path, body) {
  const response = await fetch(path, {
    method,
    cache: 'no-store',
    ...(body === undefined
      ? {}
      : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  })
  const text = await response.text()
  let payload = null
  try {
    payload = text === '' ? null : JSON.parse(text)
  } catch {
    payload = { error: { code: 'bad-response', message: text.slice(0, 300) } }
  }
  if (!response.ok) {
    const detail = payload?.error ?? { code: String(response.status), message: '请求失败' }
    throw new ApiError(detail.code ?? String(response.status), detail.message ?? '请求失败', response.status, detail.details)
  }
  return payload
}

/** 把错误渲染成"人话 + 下一步"，并区分 503（存储故障）与其它。 */
function describeError(error) {
  if (error instanceof ApiError && error.httpStatus === 503) {
    return `存储暂不可用（${error.code}）：${error.message}。这是基础设施故障，不是"没有数据"——请稍后重试。`
  }
  const code = error?.code ? `[${error.code}] ` : ''
  return `${code}${error?.message ?? String(error)}`
}

function showOut(id, message, kind = 'info') {
  const node = $(id)
  node.hidden = false
  node.dataset.kind = kind
  node.textContent = message
}

function clearOut(id) {
  const node = $(id)
  node.hidden = true
  node.textContent = ''
  delete node.dataset.kind
}

// ── 渲染：连接状态与轮询开关 ─────────────────────────────────────────────────

async function refreshHealth() {
  try {
    const health = await api('GET', '/health')
    $('conn').dataset.state = 'ok'
    $('conn').textContent = `服务正常 · configRef=${health.configRef}`
    if (health.trustActorHeaders) {
      $('notice').textContent =
        '注意：本实例已开启 PLATFORM_TRUST_ACTOR_HEADERS，调用者身份取自请求头，必须由反向代理完成真实鉴权并剥除同名头。'
      $('notice').dataset.state = 'warn'
    }
  } catch (error) {
    $('conn').dataset.state = 'error'
    $('conn').textContent = `服务不可用：${error.message}`
  }
}

/** 轮询开关 + "已暂停，数据可能过期"提示（要求 18）。 */
function renderPollingState() {
  const button = $('btn-poll')
  button.textContent = state.polling ? '暂停自动刷新' : '恢复自动刷新'
  button.setAttribute('aria-pressed', String(!state.polling))
  const base = state.polling ? '自动刷新中' : '已暂停，数据可能过期'
  if (state.lastError !== null) {
    $('conn').dataset.state = 'error'
    $('conn').textContent = `${base} · 最近一次刷新失败`
  }
}

// ── 渲染：向导与流水线列表 ───────────────────────────────────────────────────

/**
 * 视图切换（左侧菜单 → 右侧内容）。
 *
 * 三个视图**互斥**：通用配置 / 流水线列表 / 流水线详情。菜单项的选中态用
 * `aria-current="page"` 表达——不只靠颜色。
 */
function setView(view) {
  $('general-panel').hidden = view !== 'general'
  $('pipeline-list-panel').hidden = view !== 'list'
  $('workspace').hidden = view !== 'detail'
  const onList = view === 'list'
  const onGeneral = view === 'general'
  $('btn-nav-list').setAttribute('aria-current', onList ? 'page' : 'false')
  $('btn-nav-general').setAttribute('aria-current', onGeneral ? 'page' : 'false')
}

// ── 通用配置（左侧一级菜单）与新建对话框 ────────────────────────────────────

/**
 * 读取左侧「通用配置」。
 *
 * 这些值只活在**本次会话的内存里**（不写 localStorage）：运行状态一律来自服务端，
 * 浏览器不做第二份事实来源。刷新页面后需要重新填一次——这是刻意的取舍。
 */
function generalConfig() {
  const text = id => $(id).value.trim()
  const nonNegative = id => {
    const raw = text(id)
    if (raw === '') return undefined
    const value = Number(raw)
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new ApiError('invalid-request', `${id} 必须是非负整数`, 400, {})
    }
    return value
  }
  return {
    projectId: text('g-project'),
    providerName: text('g-provider'),
    rulesetVersion: text('g-ruleset'),
    maxGateRetries: nonNegative('g-retries'),
    gateWaitTimeoutMs: nonNegative('g-gatewait'),
    gateTaskTtlMs: nonNegative('g-ttl'),
  }
}

/** 把当前通用配置摘到对话框里，避免用户以为漏填了。 */
function renderCreateContext() {
  const general = generalConfig()
  const parts = [
    `项目 ${general.projectId === '' ? '（未填）' : general.projectId}`,
    `provider ${general.providerName === '' ? '默认' : general.providerName}`,
    `规则集 ${general.rulesetVersion === '' ? '默认' : general.rulesetVersion}`,
    `重试 ${general.maxGateRetries ?? '默认'}`,
    `门等待 ${general.gateWaitTimeoutMs ?? '默认'}`,
    `TTL ${general.gateTaskTtlMs ?? '默认'}`,
  ]
  $('create-context').textContent = `将使用：${parts.join(' · ')}`
}

function openCreateDialog() {
  clearOut('out-create')
  $('p-pipeline').value = ''
  $('p-requirement').value = ''
  $('p-target').value = ''
  $('p-diag').value = ''
  renderCreateContext()
  const dialog = $('create-dialog')
  if (typeof dialog.showModal === 'function') dialog.showModal()
  else dialog.setAttribute('open', '')
  $('p-pipeline').focus()
}

function closeCreateDialog() {
  const dialog = $('create-dialog')
  if (typeof dialog.close === 'function') dialog.close()
  else dialog.removeAttribute('open')
}

function renderList() {
  const body = $('pipeline-table')
  body.replaceChildren()
  const projectId = state.filters.projectId.trim()
  const status = state.filters.status
  const visible = state.list.filter(item =>
    (projectId === '' || item.projectId === projectId) && (status === '' || item.status === status))

  if (visible.length === 0) {
    const cell = el('td', {
      className: 'muted',
      text: state.list.length === 0 ? '还没有流水线。点右上角「＋ 新建流水线」创建一条。' : '当前筛选条件下没有匹配的流水线。',
    })
    cell.setAttribute('colspan', '5')
    body.append(el('tr', {}, [cell]))
    return
  }

  for (const item of visible) {
    body.append(el('tr', { attrs: { 'data-pipeline': item.pipelineId } }, [
      el('td', { className: 'mono', text: item.pipelineId }),
      el('td', { text: `${item.projectId}${item.tenantId === null ? '' : ` / ${item.tenantId}`}` }),
      el('td', {}, [chip(RUN_STATUS_LABELS[item.status] ?? item.status, item.status)]),
      el('td', { className: 'mono', text: item.nextStage ?? '终态' }),
      el('td', {}, [el('button', {
        className: 'primary',
        text: '打开',
        attrs: { type: 'button', 'aria-label': `打开流水线 ${item.pipelineId}` },
        on: { click: () => openPipeline(item.pipelineId) },
      })]),
    ]))
  }
}

// ── 渲染：概要 ───────────────────────────────────────────────────────────────

function renderSummary() {
  const view = state.view
  if (view === null) return
  $('s-pipeline').textContent = view.pipelineId
  $('s-project').textContent = `${view.projectId}${view.tenantId === null ? '' : ` / ${view.tenantId}`}`
  $('s-status').textContent = RUN_STATUS_LABELS[view.status] ?? view.status
  $('s-status').dataset.status = view.status
  $('s-stage').textContent = view.currentStage === null
    ? '（六阶段已全部完成）'
    : `${STAGE_LABELS[view.currentStage] ?? view.currentStage}（${view.currentStage}）`
  $('s-next').textContent = view.nextStage ?? '—'
  $('s-running').textContent = view.running ? '进行中' : '无'

  const reason = $('s-reason')
  reason.textContent = view.blockingReason === null ? '' : view.blockingReason
  reason.hidden = view.blockingReason === null

  // 主操作按钮完全由服务端 nextAction 驱动；终态不会出现"批准"。
  const primary = $('btn-primary')
  primary.textContent = ACTION_LABELS[view.nextAction] ?? view.nextAction
  primary.dataset.action = view.nextAction
  primary.disabled = state.busy || view.nextAction === 'none'
}

function runPrimaryAction() {
  const action = $('btn-primary').dataset.action
  switch (action) {
    case 'run':
      return triggerRun()
    case 'view-artifact':
      return state.view?.currentStage === null || state.view?.currentStage === undefined
        ? Promise.resolve()
        : toggleArtifact(state.view.currentStage, true)
    case 'decide-gate':
    case 'claim-gate':
      $('gates-title')?.scrollIntoView({ block: 'start', behavior: 'smooth' })
      $('gate-workspace').querySelector('button')?.focus()
      return Promise.resolve()
    case 'reenter':
      document.querySelector('details.advanced')?.setAttribute('open', '')
      $('f-reenter-reason')?.focus()
      return Promise.resolve()
    case 'retry-storage':
      return refresh()
    default:
      return Promise.resolve()
  }
}

// ── 渲染：六阶段 Stepper ─────────────────────────────────────────────────────

function renderStepper() {
  const stepper = $('stepper')
  stepper.replaceChildren()
  const view = state.view
  if (view === null) return

  for (const stage of view.stages) {
    const isCurrent = view.currentStage === stage.stageId
    const item = el('li', {
      attrs: {
        'data-status': stage.status,
        'data-current': isCurrent ? 'true' : 'false',
        // 颜色不是唯一信息：aria-current 让读屏也知道"当前阶段"。
        ...(isCurrent ? { 'aria-current': 'step' } : {}),
      },
    })
    item.append(
      el('div', { className: 'step-name', text: STAGE_LABELS[stage.stageId] ?? stage.stageId }),
      el('div', { className: 'step-id', text: stage.stageId }),
      el('div', {}, [chip(STAGE_STATUS_LABELS[stage.status] ?? stage.status, stage.status)]),
      el('div', {
        className: 'step-meta',
        text: `机器门禁 ${stage.machineStatus === 'passed' ? '通过' : '未通过'}`
          + ` · digest ${stage.digest === '' ? '—' : stage.digest.slice(0, 12)}`,
      }),
      el('div', { className: 'step-meta', text: `${timeText(stage.startedAt)} → ${timeText(stage.finishedAt)}` }),
    )
    if (stage.failure !== null) {
      item.append(el('div', {
        className: 'step-meta',
        text: `失败 ${stage.failure.kind}${stage.failure.rule === null ? '' : ` · ${stage.failure.rule}`}`,
      }))
    }
    item.append(el('button', {
      text: state.openArtifact === stage.stageId ? '收起产物' : '查看产物',
      attrs: { type: 'button', 'aria-label': `查看 ${STAGE_LABELS[stage.stageId] ?? stage.stageId} 的产物` },
      on: { click: () => toggleArtifact(stage.stageId) },
    }))
    if (stage.humanGateTaskId !== null) {
      const gateTaskId = stage.humanGateTaskId
      item.append(el('button', {
        text: '定位门任务',
        attrs: { type: 'button' },
        on: {
          click: () => {
            const target = document.querySelector(`[data-gate="${CSS.escape(gateTaskId)}"]`)
            if (target !== null) {
              target.scrollIntoView({ block: 'center', behavior: 'smooth' })
              target.focus?.()
            }
          },
        },
      }))
    }
    stepper.append(item)
  }
}

// ── 渲染：当前任务卡 ─────────────────────────────────────────────────────────

function renderTask() {
  const body = $('task-body')
  body.replaceChildren()
  const view = state.view
  if (view === null) return

  body.append(el('p', { className: 'task-headline', text: ACTION_LABELS[view.nextAction] ?? view.nextAction }))
  if (view.blockingReason !== null) body.append(el('p', { className: 'reason', text: view.blockingReason }))

  if (view.failure !== null) {
    body.append(el('p', {
      className: 'reason',
      text: `流水线失败：${view.failure.kind}`
        + (view.failure.stageId === null ? '' : `（阶段 ${view.failure.stageId}）`)
        + ` — ${view.failure.detail}`,
    }))
  }
  if (view.nextAction === 'none') {
    body.append(el('p', { className: 'muted', text: '后台运行进行中：等它结束或停在人工门后再操作。' }))
  }
}

// ── 渲染：人工门 ─────────────────────────────────────────────────────────────

/**
 * 用户是否正在门任务面板里输入？
 *
 * 要求 7：轮询不能覆盖用户正在查看/输入的内容。只要有输入框被聚焦或已填入内容，
 * 就**冻结**该面板的自动重绘，并提示"有新变化"。
 */
function gatesFrozen() {
  const root = $('gate-workspace')
  const active = document.activeElement
  if (active !== null && root.contains(active)) return true
  return [...root.querySelectorAll('textarea, input')].some(node => node.value.trim() !== '')
}

function renderGates() {
  const root = $('gate-workspace')
  root.replaceChildren()
  if (state.gates.length === 0) {
    root.append(el('p', { className: 'muted', text: '当前没有人工门任务。' }))
    return
  }

  for (const task of state.gates) {
    const escalation = task.isEscalation === true
    const box = el('div', {
      className: 'gate',
      attrs: {
        'data-gate': task.gateTaskId,
        'data-status': task.status,
        'data-escalation': escalation ? 'true' : 'false',
        tabindex: '-1',
      },
    })

    box.append(el('div', { className: 'gate-head' }, [
      el('strong', { text: STAGE_LABELS[task.stageId] ?? task.stageId }),
      // 种类必须写出来，不能只靠底色区分。
      el('span', {
        className: 'chip',
        text: escalation ? '升级任务（非阶段门）' : '阶段门',
        attrs: { 'data-status': escalation ? 'gate-failed' : 'pending' },
      }),
      chip(GATE_STATUS_LABELS[task.status] ?? task.status, task.status),
      el('span', { className: 'mono small', text: task.gateTaskId }),
    ]))

    box.append(el('p', {
      className: 'gate-meta',
      text: escalation
        ? '该任务由机器门禁失败或预算超限产生，不对应产物，永远不会被当作阶段批准。处置方式：修正原因后登记重入。'
        : `产物 ${task.artifactPath} · 机器门禁 ${task.machineStatus}`,
    }))
    if (task.claimedBy !== undefined) {
      box.append(el('p', {
        className: 'gate-meta',
        text: `认领人 ${task.claimedBy}${task.lease === undefined ? '' : `（租约至 ${timeText(task.lease.expiresAt)}）`}`,
      }))
    }
    if (task.decision !== undefined) {
      box.append(el('p', { className: 'gate-meta', text: `裁决 ${task.decision.action} by ${task.decision.by}：${task.decision.note}` }))
    }
    if (task.cancellation !== undefined) {
      box.append(el('p', { className: 'gate-meta', text: `已取消 by ${task.cancellation.by}：${task.cancellation.note}` }))
    }

    if (task.machineViolations.length > 0) {
      box.append(el('ul', { className: 'violations' }, task.machineViolations.map(v =>
        el('li', { text: `[${v.level}] ${v.rule}：${v.detail}`, attrs: { 'data-level': v.level } }))))
    }
    if (task.review !== undefined) {
      box.append(el('div', {}, [
        chip(task.review.verdict, 'review'),
        el('ul', { className: 'findings' }, task.review.findings.map(f => el('li', { text: f }))),
      ]))
    }

    // 只有"可裁决"的状态才给按钮：终态任务点不了，避免"点了就能改"的错觉。
    const decidable = task.status === 'pending' || task.status === 'claimed'
    if (decidable) {
      const note = el('textarea', {
        attrs: {
          'aria-label': `对 ${task.gateTaskId} 的裁决说明（打回 / 拒绝 / 取消时必填）`,
          placeholder: '裁决说明（打回 / 拒绝 / 取消时必填）',
        },
      })
      const row = el('div', { className: 'actions' })
      // 幂等：同一 (任务, 动作, 说明) 沿用同一个 decisionId，双击/重试只会重放首次结果。
      const decisionIds = new Map()
      const decisionIdFor = action => {
        const intent = `${task.gateTaskId}\u0000${action}\u0000${note.value}`
        let id = decisionIds.get(intent)
        if (id === undefined) {
          id = newDecisionId()
          decisionIds.set(intent, id)
        }
        return id
      }
      for (const [action, label] of [['approved', '批准'], ['changes-needed', '打回重跑'], ['rejected', '拒绝']]) {
        row.append(el('button', {
          // 升级任务上的"批准"不是阶段批准，因此不标成 primary，避免误导。
          className: action === 'approved' ? (escalation ? 'danger' : 'primary') : '',
          text: label,
          attrs: { type: 'button' },
          on: { click: () => decideGate(task, action, note.value, decisionIdFor(action)) },
        }))
      }
      row.append(el('button', {
        text: '取消任务',
        attrs: { type: 'button' },
        on: { click: () => cancelGate(task, note.value) },
      }))
      box.append(note, row)
    }

    root.append(box)
  }
}

function newDecisionId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  return `dec-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

// ── 渲染：产物（可折叠）──────────────────────────────────────────────────────

/**
 * 递归渲染任意 JSON（要求 13）。
 *
 * 折叠策略：数组/对象/长字符串用 `<details>`，短值直接文本。
 * **所有文本走 textContent**（要求 14）——产物是 agent 写的，可能含 HTML。
 */
function renderValue(value, key, depth = 0) {
  const label = key === null || key === undefined ? '' : `${key}: `

  if (value === null || value === undefined) {
    return el('div', { className: 'mono small muted', text: `${label}—` })
  }
  if (typeof value !== 'object') {
    const text = typeof value === 'string' ? value : JSON.stringify(value)
    if (typeof value === 'string' && text.length > 160) {
      return el('details', { className: 'node' }, [
        el('summary', { text: `${label}文本（${text.length} 字符）` }),
        el('pre', { className: 'artifact', text }),
      ])
    }
    return el('div', { className: 'mono small', text: `${label}${text}` })
  }

  const isArray = Array.isArray(value)
  const entries = isArray ? value.map((item, index) => [String(index), item]) : Object.entries(value)
  const summary = `${label}${isArray ? `数组（${entries.length} 项）` : `对象（${entries.length} 字段）`}`

  // 浅层小对象直接展开，避免层层点击。
  const shallow = depth === 0 && entries.length <= 6
    && entries.every(([, item]) => item === null || typeof item !== 'object')
  const body = entries.map(([childKey, child]) => renderValue(child, isArray ? null : childKey, depth + 1))
  if (shallow) return el('div', {}, [el('div', { className: 'small muted', text: summary }), ...body])

  return el('details', { className: 'node', attrs: depth === 0 ? { open: true } : {} }, [
    el('summary', { text: summary }),
    ...body,
  ])
}

function renderArtifact() {
  const root = $('artifact-viewer')
  root.replaceChildren()
  if (state.openArtifact === null) {
    root.append(el('p', { className: 'muted', text: '在上方阶段卡片或「当前任务」里点击「查看产物」。' }))
    return
  }
  if (state.artifactError !== null) {
    root.append(el('p', { className: 'muted', text: state.artifactError }))
    return
  }
  const artifact = state.artifact
  if (artifact === null) {
    root.append(el('p', { className: 'muted', text: '正在读取产物…' }))
    return
  }
  root.append(el('p', {
    className: 'mono small',
    text: `${artifact.artifactPath} · v${artifact.version} · digest ${artifact.digest.slice(0, 16)}`,
  }))
  root.append(renderValue(artifact.content, null))
}

async function toggleArtifact(stageId, keepOpen = false) {
  if (state.openArtifact === stageId && !keepOpen) {
    state.openArtifact = null
    state.artifact = null
    state.artifactError = null
    renderArtifact()
    renderStepper()
    return
  }
  state.openArtifact = stageId
  state.artifact = null
  state.artifactError = null
  renderArtifact()
  renderStepper()
  try {
    state.artifact = await api('GET',
      `/api/pipelines/${encodeURIComponent(state.pipelineId)}/stages/${encodeURIComponent(stageId)}/artifact`)
  } catch (error) {
    // 404 = 该阶段尚未产出（服务端不编造空产物），如实展示。
    state.artifactError = error instanceof ApiError && error.httpStatus === 404
      ? '该阶段尚无产物（服务端不返回空对象）。'
      : describeError(error)
  }
  renderArtifact()
}

// ── 渲染：用量 / 事件 / 高级 ─────────────────────────────────────────────────

function renderUsage() {
  const root = $('usage-panel')
  root.replaceChildren()
  const usage = state.usage
  if (usage === null) {
    root.append(el('p', { className: 'muted', text: '尚未加载。' }))
    return
  }
  if (usage.skippedLines > 0) {
    root.append(el('p', {
      className: 'reason',
      text: `注意：用量日志有 ${usage.skippedLines} 行无法解析，计量不完整——不能把下面的数字读成"用量为 0"。`,
    }))
  }
  if (usage.budgetFailures > 0) {
    root.append(el('p', {
      className: 'reason',
      text: `预算强制停止 ${usage.budgetFailures} 次（来自检查点：运行器当场停止并落盘的事实）。`,
    }))
  }

  const rows = usage.stages.map(stage => el('tr', {}, [
    el('td', { text: `${STAGE_LABELS[stage.stageId] ?? stage.stageId}（${stage.stageId}）` }),
    el('td', { className: 'mono', text: String(stage.totals.llmCalls) }),
    el('td', { className: 'mono', text: `${stage.totals.toolSteps} / ${stage.budget.maxSteps}` }),
    el('td', { className: 'mono', text: String(stage.totals.reviewCalls) }),
    el('td', { className: 'mono', text: String(stage.totals.executorCases) }),
    el('td', {
      text: stage.exceeded.length === 0 && stage.budgetFailures === 0
        ? '否'
        : `是（${stage.exceeded.map(item => `${item.kind} ${item.used}>${item.limit}`).join('；')}`
          + `${stage.budgetFailures > 0 ? `；强制停止 ${stage.budgetFailures} 次` : ''}）`,
    }),
  ]))

  root.append(el('table', { className: 'usage' }, [
    el('thead', {}, [el('tr', {}, [
      el('th', { text: '阶段' }),
      el('th', { text: '模型调用' }),
      el('th', { text: '工具步数 / 上限' }),
      el('th', { text: '审核调用' }),
      el('th', { text: '执行用例' }),
      el('th', { text: '超限' }),
    ])]),
    el('tbody', {}, rows),
  ]))

  const totals = usage.totals
  root.append(el('p', {
    className: 'small muted',
    text: `合计：模型调用 ${totals.llmCalls} · 工具步数 ${totals.toolSteps} · 执行用例 ${totals.executorCases}`
      + `（失败 ${totals.executorFailures}）· 墙钟跨度 ${totals.wallClockMs}ms · `
      + (totals.tokensAvailable
        ? `tokens ${totals.inputTokens}/${totals.outputTokens}`
        : 'tokens 不可用（provider 未完整返回用量，不能当成 0）'),
  }))
}

function renderEvents() {
  const list = $('events-list')
  list.replaceChildren()
  if (state.events.length === 0) {
    list.append(el('li', { className: 'muted', text: '尚无事件。' }))
    return
  }
  for (const event of state.events) {
    list.append(el('li', {}, [
      el('span', { className: 'mono small', text: timeText(event.at) }),
      chip(EVENT_LABELS[event.kind] ?? event.kind, 'event'),
      el('span', {
        text: (event.stageId === null ? '' : `${STAGE_LABELS[event.stageId] ?? event.stageId} · `) + event.detail,
      }),
      event.actorId === null ? null : el('span', { className: 'muted small', text: `by ${event.actorId}` }),
    ]))
  }
}

function renderAdvanced() {
  const root = $('advanced-violations')
  root.replaceChildren()
  const view = state.view
  if (view === null) return

  for (const stage of view.stages) {
    if (stage.machineViolations.length === 0 && stage.reviewFindings.length === 0 && stage.failure === null) continue
    const body = []
    if (stage.failure !== null) {
      body.push(el('p', {
        className: 'reason',
        text: `失败：${stage.failure.kind}`
          + (stage.failure.rule === null ? '' : ` · ${stage.failure.rule}`)
          + (stage.failure.detail === null ? '' : `：${stage.failure.detail}`)
          + `（${timeText(stage.failure.at)}）`,
      }))
    }
    if (stage.machineViolations.length > 0) {
      body.push(el('ul', { className: 'violations' }, stage.machineViolations.map(v =>
        el('li', { text: `[${v.level}] ${v.rule}：${v.detail}`, attrs: { 'data-level': v.level } }))))
    }
    if (stage.reviewFindings.length > 0) {
      body.push(el('ul', { className: 'findings' }, stage.reviewFindings.map(f => el('li', { text: f }))))
    }
    root.append(el('details', { className: 'node' }, [
      el('summary', { text: `${STAGE_LABELS[stage.stageId] ?? stage.stageId}（${stage.stageId}）` }),
      ...body,
    ]))
  }
  if (root.childElementCount === 0) {
    root.append(el('p', { className: 'muted', text: '没有机器违规或审核 findings。' }))
  }

  // 重入表单：digest 用当前阶段的真实值，避免手抄错。
  const select = $('f-reenter-stage')
  if (select.options.length === 0) {
    for (const stage of view.stages) {
      select.append(el('option', {
        text: `${STAGE_LABELS[stage.stageId] ?? stage.stageId}（${stage.stageId}）`,
        attrs: { value: stage.stageId },
      }))
    }
    select.addEventListener('change', syncReenterDigest)
  }
  syncReenterDigest()

  $('raw-view').textContent = JSON.stringify(view, null, 2)
}

function syncReenterDigest() {
  const stageId = $('f-reenter-stage').value
  const stage = state.view?.stages.find(item => item.stageId === stageId)
  $('f-reenter-digest').value = stage?.digest ?? ''
}

// ── 编辑 / 移除流水线 ────────────────────────────────────────────────────────

/** 打开编辑对话框，按 `view.params` **预填**（没有预填就只能让用户盲填）。 */
function openEditDialog() {
  const params = state.view?.params ?? {}
  $('e-requirement').value = params.requirementInput ?? ''
  $('e-provider').value = params.providerName ?? ''
  $('e-target').value = params.targetBaseUrl ?? ''
  $('e-ruleset').value = params.rulesetVersion ?? ''
  $('e-retries').value = params.maxGateRetries ?? ''
  $('e-gatewait').value = params.gateWaitTimeoutMs ?? ''
  $('e-ttl').value = params.gateTaskTtlMs ?? ''
  $('e-diag').value = (params.diagCredentials ?? []).join(', ')
  $('edit-context').textContent = `流水线 ${state.pipelineId}`
    + (params.updatedAt === undefined ? '（从未编辑过）' : `（上次编辑 ${timeText(params.updatedAt)}）`)
  clearOut('out-edit')
  const dialog = $('edit-dialog')
  if (typeof dialog.showModal === 'function') dialog.showModal()
  else dialog.setAttribute('open', '')
}

function closeEditDialog() {
  const dialog = $('edit-dialog')
  if (typeof dialog.close === 'function') dialog.close()
  else dialog.removeAttribute('open')
}

async function submitEdit() {
  const pipelineId = state.pipelineId
  // 字符串：**原样提交**（清空即清掉该字段）。数字：留空 = 不修改——因为契约里
  // `undefined` 表示"不修改"，没有"清掉数字"的语义，UI 不假装有。
  const body = {
    requirementInput: $('e-requirement').value.trim(),
    providerName: $('e-provider').value.trim(),
    targetBaseUrl: $('e-target').value.trim(),
    rulesetVersion: $('e-ruleset').value.trim(),
    diagCredentials: $('e-diag').value.split(',').map(item => item.trim()).filter(item => item !== ''),
  }
  for (const [field, id] of [['maxGateRetries', 'e-retries'], ['gateWaitTimeoutMs', 'e-gatewait'], ['gateTaskTtlMs', 'e-ttl']]) {
    const raw = $(id).value.trim()
    if (raw === '') continue
    const value = Number(raw)
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new ApiError('invalid-request', `${field} 必须是非负整数`, 400, {})
    }
    body[field] = value
  }

  const result = await api('PATCH', `/api/pipelines/${encodeURIComponent(pipelineId)}`, body)
  closeEditDialog()
  const changed = result.changedFields.length === 0 ? '（没有字段变化）' : `已保存：${result.changedFields.join('、')}`
  showOut('out-main', result.warning === null ? changed : `${changed}\n\n${result.warning}`,
    result.warning === null ? 'ok' : 'warn')
  await refresh()
}

/**
 * 移除流水线。
 *
 * **语义必须说清**：当前实现只从索引摘掉，数据（产物/检查点/审计）仍留在数据根。
 * 用户点"移除"时最怕的是"我以为是删掉，其实数据还在"或者反过来——所以确认框里
 * 直接写明会发生什么，返回值也如实显示。
 */
async function removePipeline() {
  const pipelineId = state.pipelineId
  const ok = window.confirm(
    `确定移除流水线 ${pipelineId}？\n\n`
    + '只会从列表里摘掉索引：产物 / 检查点 / 门任务 / 审计**仍保留在数据根**，'
    + '可用同一流水线 ID 重新创建找回。真删需要运维在数据根上清理。',
  )
  if (!ok) return
  const result = await api('DELETE', `/api/pipelines/${encodeURIComponent(pipelineId)}`)
  showOut('out-main', `已移除 ${result.pipelineId}。${result.dataRetained ? `\n\n${result.dataRetainedReason}` : ''}`, 'warn')
  closePipeline()
}

// ── 渲染：数据根体检（docs/14 W5 第 9 条）─────────────────────────────────────

function renderDiagnostics(report) {
  const root = $('diagnostics-panel')
  root.replaceChildren()
  if (report === null) {
    root.append(el('p', { className: 'muted', text: '点「体检数据根」运行一次只读检查。' }))
    return
  }

  root.append(el('p', {
    className: 'reason',
    text: report.attentionNeeded
      ? '体检发现需要处置的项（见下）。'
      : '体检未发现需要处置的项。',
  }))

  root.append(el('ul', { className: 'events' }, [
    el('li', {}, [el('span', { className: 'muted small', text: '后端' }),
      el('span', { className: 'mono small', text: `${report.backend.name} · schemaVersion ${report.backend.schemaVersion} · ok=${report.backend.ok}` })]),
    el('li', {}, [el('span', { className: 'muted small', text: '索引' }),
      el('span', { className: 'mono small', text: `${report.index.entries} 条，不可读 ${report.index.unreadable.length} 条` })]),
    el('li', {}, [el('span', { className: 'muted small', text: '用量坏行' }),
      el('span', { className: 'mono small', text: String(report.usageSkippedLines) })]),
    el('li', {}, [el('span', { className: 'muted small', text: '创建状态' }),
      el('span', { className: 'mono small', text: report.creationState })]),
    // L1 事实模型迁移现状（docs/19 §4.3）。**必须显示**：只报在响应里而页面看不见，
    // 就等于"记了但没人看得到"——那正是审计白名单那类坑的另一种形态。
    el('li', {}, [el('span', { className: 'muted small', text: 'L1 迁移' }),
      el('span', {
        className: 'mono small',
        text: `${report.migration.state}（revisions ${report.migration.revisions} · runs ${report.migration.runs}）`,
      })]),
    el('li', {}, [el('span', { className: 'muted small', text: '运行锁' }),
      el('span', {
        className: 'mono small',
        text: report.lock.present
          ? `存在（owner ${report.lock.ownerId ?? '不可确认'}`
            + `${report.lock.ageMs === null ? '' : `，心跳距今 ${report.lock.ageMs}ms`}）`
          : '不存在',
      })]),
  ]))

  if (report.creationState === 'creating') {
    root.append(el('p', {
      className: 'reason',
      text: '创建未完成：索引已写但检查点未确认。用同一 pipelineId 重新创建即可接管。',
    }))
  }

  if (report.storage.length > 0) {
    root.append(el('ul', { className: 'violations' }, report.storage.map(item =>
      el('li', {
        text: `[${item.code}] ${item.kind} ${item.ref}：${item.detail}`
          + (item.recoverable ? '（可被 migrate 修复）' : ''),
        attrs: { 'data-level': item.recoverable ? 'WARNING' : 'BLOCKING' },
      }))))
  }
  if (report.index.unreadable.length > 0) {
    root.append(el('ul', { className: 'violations' }, report.index.unreadable.map(item =>
      el('li', { text: `索引不可读 ${item.file}：${item.reason}`, attrs: { 'data-level': 'BLOCKING' } }))))
  }

  // L1 迁移诊断（docs/19 §4.3）。`migration-needed` 是可自愈的（下次访问自动补），
  // 因此按 `recoverable` 分成 WARNING / BLOCKING，不一律报红。
  if (report.migration.diagnostics.length > 0) {
    root.append(el('ul', { className: 'violations' }, report.migration.diagnostics.map(item =>
      el('li', {
        text: `[${item.code}] ${item.ref}：${item.detail}`,
        attrs: { 'data-level': item.recoverable ? 'WARNING' : 'BLOCKING' },
      }))))
  }
}

async function runDiagnostics() {
  const root = $('diagnostics-panel')
  root.replaceChildren(el('p', { className: 'muted', text: '正在体检…' }))
  try {
    const report = await api('GET', `/api/pipelines/${encodeURIComponent(state.pipelineId)}/diagnostics`)
    renderDiagnostics(report)
  } catch (error) {
    root.replaceChildren(el('p', { className: 'muted', text: describeError(error) }))
  }
}

// ── 刷新 ─────────────────────────────────────────────────────────────────────

/**
 * 刷新当前流水线的全部事实。
 *
 * 关键取舍（要求 7）：门任务面板在用户正在输入时**冻结**，只提示"有新变化"；
 * 产物查看器保留展开状态。这两处是"用户正在看/改的东西"，被轮询冲掉最恼人。
 */
async function refresh() {
  if (state.busy) return
  state.busy = true
  try {
    if (state.pipelineId === null) {
      setView(state.nav)
      state.list = (await api('GET', '/api/pipelines')).pipelines
      renderList()
      state.lastError = null
      return
    }

    const id = encodeURIComponent(state.pipelineId)
    const [view, gates, usage, events] = await Promise.all([
      api('GET', `/api/pipelines/${id}`),
      api('GET', `/api/pipelines/${id}/gates`),
      api('GET', `/api/pipelines/${id}/usage`),
      api('GET', `/api/pipelines/${id}/events`),
    ])
    const previousStage = state.view?.currentStage ?? null
    state.view = view
    state.gates = gates.gates
    state.usage = usage
    state.events = events.events
    state.lastError = null

    setView('detail')

    renderSummary()
    renderStepper()
    renderTask()
    if (gatesFrozen()) {
      // 不重绘门面板；明确告诉用户"页面上的门任务可能已过期"。
      showOut('gate-notice', '门任务有新变化，但你正在输入：已暂停更新该面板。清空输入或移开焦点后会自动刷新。', 'warn')
    } else {
      clearOut('gate-notice')
      renderGates()
    }
    renderUsage()
    renderEvents()
    renderAdvanced()

    // 产物：保持展开状态；阶段推进后重新拉一次（内容可能已变）。
    if (state.openArtifact !== null) {
      const stillExists = view.stages.some(stage => stage.stageId === state.openArtifact)
      if (!stillExists) {
        state.openArtifact = null
        state.artifact = null
      } else if (previousStage !== view.currentStage || state.artifact === null) {
        await toggleArtifact(state.openArtifact, true)
      }
    }
    renderArtifact()
  } catch (error) {
    state.lastError = error
    // 503 不显示成"没有流水线"：给出明确的基础设施提示 + 重试入口。
    if (state.pipelineId === null) {
      showOut('out-main', describeError(error), 'error')
    } else {
      $('conn').dataset.state = 'error'
      $('conn').textContent = '读取失败'
      $('task-body').replaceChildren(el('p', { className: 'reason', text: describeError(error) }))
    }
  } finally {
    state.busy = false
    renderPollingState()
  }
}

// ── 动作 ─────────────────────────────────────────────────────────────────────

function openPipeline(pipelineId) {
  state.pipelineId = pipelineId
  state.view = null
  state.gates = []
  state.usage = null
  state.events = []
  state.openArtifact = null
  state.artifact = null
  state.artifactError = null
  clearOut('out-wizard')
  // 体检报告是**手动触发**的快照：换流水线时必须清掉，否则会显示上一条的结论。
  renderDiagnostics(null)
  // 导航上下文进 URL（只存 pipelineId，不存任何运行状态）；刷新后能回到同一条流水线。
  location.hash = `pipeline=${encodeURIComponent(pipelineId)}`
  void refresh()
}

function closePipeline() {
  state.pipelineId = null
  state.view = null
  // 回左侧菜单当前选中的视图（列表或通用配置）；清掉 hash（视图不占 URL）。
  history.replaceState(null, '', location.pathname)
  void refresh()
}

async function createPipeline(form) {
  const general = generalConfig()
  if (general.projectId === '') {
    throw new ApiError('invalid-request', '请先在左侧「通用配置」里填项目 ID', 400, {})
  }

  const data = new FormData(form)
  const pipelineId = String(data.get('pipelineId') ?? '').trim()
  if (pipelineId === '') throw new ApiError('invalid-request', '流水线 ID 必填', 400, {})

  // 通用配置来自左侧一级菜单；这里只补**每条流水线特有**的字段。
  const body = {
    pipelineId,
    ...(general.providerName === '' ? {} : { providerName: general.providerName }),
    ...(general.rulesetVersion === '' ? {} : { rulesetVersion: general.rulesetVersion }),
    ...(general.maxGateRetries === undefined ? {} : { maxGateRetries: general.maxGateRetries }),
    ...(general.gateWaitTimeoutMs === undefined ? {} : { gateWaitTimeoutMs: general.gateWaitTimeoutMs }),
    ...(general.gateTaskTtlMs === undefined ? {} : { gateTaskTtlMs: general.gateTaskTtlMs }),
  }
  for (const field of ['requirementInput', 'targetBaseUrl']) {
    const value = String(data.get(field) ?? '').trim()
    if (value !== '') body[field] = value
  }
  const diag = String(data.get('diagCredentials') ?? '').split(',').map(item => item.trim()).filter(item => item !== '')
  if (diag.length > 0) body.diagCredentials = diag

  const summary = await api('POST', `/api/projects/${encodeURIComponent(general.projectId)}/pipelines`, body)
  closeCreateDialog()
  showOut('out-main', `已创建并打开：${summary.pipelineId}（status=${summary.status}）`, 'ok')
  // 创建成功自动打开该流水线（要求 4）。
  openPipeline(summary.pipelineId)
}

async function triggerRun() {
  try {
    const result = await api('POST', `/api/pipelines/${encodeURIComponent(state.pipelineId)}/run`)
    if (result.started) {
      showOut('out-main',
        '已在后台触发运行。人工门等待超时后本次运行以 waiting-human 结束；裁决后再次触发即续跑。', 'ok')
    } else if (result.reason === 'already-running') {
      showOut('out-main', '该流水线已有后台运行在进行，等它结束或停在人工门后再操作。', 'warn')
    } else {
      // **前置校验失败**：服务端在启动后台任务之前就拦下了它。
      // 这是配置/环境问题——重复点击不会变好，必须说清楚，否则用户只会反复点。
      showOut('out-main',
        `未启动运行：${result.reason}\n\n`
        + '这是配置或环境问题（例如 provider 凭据环境变量没设），重复点击不会变好；'
        + '请先按上面的提示修好再重试。', 'error')
    }
    await refresh()
  } catch (error) {
    showOut('out-main', describeError(error), 'error')
    if (error instanceof ApiError && error.httpStatus === 409) await refresh()
  }
}

async function cancelRun() {
  try {
    const result = await api('POST', `/api/pipelines/${encodeURIComponent(state.pipelineId)}/cancel`)
    showOut('out-main', result.cancelled
      ? '已发送取消信号（后台运行会在下一个安全点退出）。'
      : '当前没有本进程内的后台运行可取消。', 'warn')
    await refresh()
  } catch (error) {
    showOut('out-main', describeError(error), 'error')
  }
}

async function recover() {
  try {
    const { outcomes } = await api('POST', '/api/admin/recover')
    showOut('out-main', outcomes.length === 0
      ? '没有需要恢复的流水线。'
      : outcomes.map(item => `${item.pipelineId} → ${item.action}`
        + `${item.started ? '（已续跑）' : ''}`
        + `${item.detail === null ? '' : `：${item.detail}`}`).join('\n'), 'ok')
    await refresh()
  } catch (error) {
    showOut('out-main', describeError(error), 'error')
  }
}

async function reenter() {
  const stageId = $('f-reenter-stage').value
  const reason = $('f-reenter-reason').value.trim()
  const digest = $('f-reenter-digest').value
  try {
    const checkpoint = await api('POST', `/api/pipelines/${encodeURIComponent(state.pipelineId)}/reenter`, {
      stageId,
      reason,
      ...(digest === '' ? {} : { expectedCurrentDigest: digest }),
    })
    showOut('out-reenter',
      `重入已登记：cursor ${checkpoint.cursor}，累计 ${checkpoint.reentries.length} 次。触发运行即级联重跑。`, 'ok')
    await refresh()
  } catch (error) {
    showOut('out-reenter', describeError(error), 'error')
    if (error instanceof ApiError && error.httpStatus === 409) await refresh()
  }
}

async function decideGate(task, action, note, decisionId) {
  try {
    await api('POST', `/api/gates/${encodeURIComponent(task.gateTaskId)}/decide`, {
      pipelineId: state.pipelineId,
      action,
      note,
      expectedUpdatedAt: task.updatedAt,
      decisionId,
    })
    showOut('out-main', `已裁决 ${task.stageId} → ${action}；再次触发运行即消费该裁决。`, 'ok')
    await refresh()
  } catch (error) {
    showOut('out-main', describeError(error), 'error')
    if (error instanceof ApiError && error.httpStatus === 409) await refresh()
  }
}

async function cancelGate(task, note) {
  try {
    const result = await api('POST', `/api/gates/${encodeURIComponent(task.gateTaskId)}/cancel`, {
      pipelineId: state.pipelineId,
      note,
    })
    showOut('out-main', result.cancelled ? `已取消门任务 ${result.task.gateTaskId}。` : '取消未生效。', 'warn')
    await refresh()
  } catch (error) {
    showOut('out-main', describeError(error), 'error')
  }
}

// ── 事件绑定 ─────────────────────────────────────────────────────────────────

$('create-form').addEventListener('submit', async event => {
  // `method="dialog"` 会在提交时自动关闭对话框；这里必须拦下来，
  // 否则创建失败时错误提示会随对话框一起消失。
  event.preventDefault()
  try {
    await createPipeline(event.target)
  } catch (error) {
    showOut('out-create', describeError(error), 'error')
  }
})

$('btn-new-pipeline').addEventListener('click', () => { openCreateDialog() })
// 左侧一级菜单项：点它在**右侧**显示对应内容。
$('btn-nav-list').addEventListener('click', () => {
  state.nav = 'list'
  if (state.pipelineId === null) void refresh()
  else closePipeline()
})
$('btn-nav-general').addEventListener('click', () => {
  state.nav = 'general'
  // 通用配置与流水线无关：若正开着详情，先关掉（避免"菜单选中项"与"右侧内容"不一致）。
  if (state.pipelineId !== null) closePipeline()
  else { setView('general'); void refresh() }
})
$('btn-create-cancel').addEventListener('click', () => { closeCreateDialog() })
// 通用配置变化时同步对话框里的摘要。
for (const id of ['g-project', 'g-provider', 'g-ruleset', 'g-retries', 'g-gatewait', 'g-ttl']) {
  $(id).addEventListener('input', () => { renderCreateContext() })
}

$('btn-list').addEventListener('click', async () => {
  try {
    state.list = (await api('GET', '/api/pipelines')).pipelines
    renderList()
  } catch (error) {
    showOut('out-main', describeError(error), 'error')
  }
})

$('f-filter-project').addEventListener('input', event => {
  state.filters.projectId = event.target.value
  renderList()
})
$('f-filter-status').addEventListener('change', event => {
  state.filters.status = event.target.value
  renderList()
})

$('btn-primary').addEventListener('click', () => { void runPrimaryAction() })
$('btn-cancel-run').addEventListener('click', () => { void cancelRun() })
$('btn-recover').addEventListener('click', () => { void recover() })
$('btn-close').addEventListener('click', () => { closePipeline() })
$('btn-edit').addEventListener('click', () => { openEditDialog() })
$('btn-remove').addEventListener('click', async () => {
  try { await removePipeline() } catch (error) { showOut('out-main', describeError(error), 'error') }
})
$('btn-edit-cancel').addEventListener('click', () => { closeEditDialog() })
$('edit-form').addEventListener('submit', async event => {
  // `method="dialog"` 会自动关闭对话框；拦下来，否则保存失败时错误提示会随对话框消失。
  event.preventDefault()
  try { await submitEdit() } catch (error) { showOut('out-edit', describeError(error), 'error') }
})
$('btn-reenter').addEventListener('click', () => { void reenter() })
$('btn-diagnostics').addEventListener('click', () => { void runDiagnostics() })
$('btn-refresh').addEventListener('click', () => { void refresh() })

$('btn-poll').addEventListener('click', () => {
  state.polling = !state.polling
  renderPollingState()
  // 恢复时立刻补一次，避免"刚恢复就看到旧数据"。
  if (state.polling) void refresh()
})

window.addEventListener('hashchange', () => {
  const match = /pipeline=([^&]+)/.exec(location.hash)
  const id = match === null ? null : decodeURIComponent(match[1])
  if (id !== state.pipelineId) {
    if (id === null) closePipeline()
    else openPipeline(id)
  }
})

// ── 启动 ─────────────────────────────────────────────────────────────────────

setInterval(() => { if (state.polling) void refresh() }, 2000)

void (async () => {
  await refreshHealth()
  // 要求 11：刷新页面后恢复到同一条流水线（pipelineId 来自 URL，不是本地缓存的状态）。
  const match = /pipeline=([^&]+)/.exec(location.hash)
  if (match !== null) state.pipelineId = decodeURIComponent(match[1])
  renderPollingState()
  renderCreateContext()
  renderDiagnostics(null)
  await refresh()
})()
