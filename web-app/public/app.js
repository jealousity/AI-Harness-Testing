/**
 * 流水线控制台前端（docs/10 §5.1「前端显示真实阶段状态、人工门任务、机器违规和审核 findings」）。
 *
 * 三条纪律：
 * 1. **只渲染服务端返回的字段**，不在浏览器里推断阶段状态、不缓存"上次看到的状态"；
 * 2. **不持有任何凭据**：没有 API Key 输入框，也不把 provider 信息写进请求；
 * 3. 每次渲染都整块重画（数据量小），避免增量更新与轮询结果不一致。
 *
 * 数据来源（全部是持久化事实的投影）：
 * - `GET /api/pipelines/:id` → 阶段状态、机器违规、审核 findings、失败摘要；
 * - `GET /api/pipelines/:id/gates` → 人工门任务；
 * - `GET /api/pipelines/:id/events` → 事件时间线；
 * - `GET /api/pipelines/:id/stages/:stageId/artifact` → 产物内容。
 */

const STAGE_LABELS = {
  receive: '需求接收',
  analyze: '需求分析',
  design: '测试设计',
  execute: '测试执行',
  report: '测试报告',
  archive: '产物归档',
}

const STATUS_LABELS = {
  queued: '排队中',
  running: '运行中',
  'waiting-human': '等待人工裁决',
  'needs-fix': '打回重跑中',
  'gate-failed': '机器门禁失败',
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

const $ = id => document.getElementById(id)

/** 当前页面正在看的流水线；为空表示还没打开任何流水线。 */
let current = null
let pollTimer = null
/** 当前展开的产物（用于渲染高亮与保留展开状态）。 */
let openArtifact = null

// ── 与服务端交互 ─────────────────────────────────────────────────────────────

/**
 * 统一的请求封装。
 *
 * 服务端错误体是 `{ error: { code, message, details, httpStatus } }`，
 * 这里把 code 也带进 Error，便于调用方按错误码分支（如 conflict 提示刷新）。
 */
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
    const error = new Error(detail.message ?? '请求失败')
    error.code = detail.code
    error.details = detail.details
    error.httpStatus = response.status
    throw error
  }
  return payload
}

function report(container, message, kind = 'info') {
  const node = $(container)
  node.hidden = false
  node.dataset.kind = kind
  node.textContent = typeof message === 'string' ? message : JSON.stringify(message, null, 2)
}

function showError(container, error) {
  report(container, `${error.code ? `[${error.code}] ` : ''}${error.message}`, 'error')
}

// ── 渲染：健康状态 ───────────────────────────────────────────────────────────

async function refreshHealth() {
  try {
    const health = await api('GET', '/health')
    $('health').textContent = `服务正常 · configRef=${health.configRef} · 运行中 ${health.running.length}`
    $('health').dataset.state = 'ok'
    if (health.trustActorHeaders) {
      $('credential-notice').textContent =
        '注意：本实例已开启 PLATFORM_TRUST_ACTOR_HEADERS，调用者身份取自请求头，必须由反向代理完成真实鉴权。'
      $('credential-notice').dataset.state = 'warn'
    }
  } catch (error) {
    $('health').textContent = `服务不可用：${error.message}`
    $('health').dataset.state = 'error'
  }
}

// ── 渲染：阶段表 ─────────────────────────────────────────────────────────────

function stageTimeText(stage) {
  if (stage.startedAt === null) return '—'
  const start = new Date(stage.startedAt).toLocaleString()
  return stage.finishedAt === null ? `${start} → 进行中` : `${start} → ${new Date(stage.finishedAt).toLocaleString()}`
}

function renderStages(view) {
  const tbody = $('stage-rows')
  tbody.replaceChildren()

  for (const stage of view.stages) {
    const row = document.createElement('tr')
    row.dataset.status = stage.status

    const name = document.createElement('td')
    name.innerHTML = `<strong>${STAGE_LABELS[stage.stageId] ?? stage.stageId}</strong><br><small class="muted">${stage.stageId}</small>`

    const status = document.createElement('td')
    status.innerHTML = `<span class="chip" data-status="${stage.status}">${STAGE_STATUS_LABELS[stage.status] ?? stage.status}</span>`
    if (stage.failure !== null) {
      const failure = document.createElement('div')
      failure.className = 'fail'
      failure.textContent = `${stage.failure.kind}${stage.failure.rule ? ` · ${stage.failure.rule}` : ''}${stage.failure.detail ? `：${stage.failure.detail}` : ''}`
      status.append(failure)
    }

    const machine = document.createElement('td')
    machine.innerHTML = `<span class="chip" data-status="${stage.machineStatus}">${stage.machineStatus === 'passed' ? '通过' : '未通过'}</span>`
    if (stage.machineViolations.length > 0) {
      const list = document.createElement('ul')
      list.className = 'violations'
      for (const violation of stage.machineViolations) {
        const item = document.createElement('li')
        item.dataset.level = violation.level
        item.textContent = `[${violation.level}] ${violation.rule}：${violation.detail}`
        list.append(item)
      }
      machine.append(list)
    }

    const review = document.createElement('td')
    if (stage.reviewVerdict === null) {
      review.innerHTML = '<span class="muted">—</span>'
    } else {
      review.innerHTML = `<span class="chip" data-status="review">${stage.reviewVerdict}</span>`
      if (stage.reviewFindings.length > 0) {
        const list = document.createElement('ul')
        list.className = 'findings'
        for (const finding of stage.reviewFindings) {
          const item = document.createElement('li')
          item.textContent = finding
          list.append(item)
        }
        review.append(list)
      }
    }

    const digest = document.createElement('td')
    digest.className = 'mono'
    digest.textContent = stage.digest === '' ? '—' : stage.digest.slice(0, 16)

    const time = document.createElement('td')
    time.className = 'mono small'
    time.textContent = stageTimeText(stage)

    const actions = document.createElement('td')
    const openButton = document.createElement('button')
    openButton.textContent = openArtifact === stage.stageId ? '收起产物' : '查看产物'
    openButton.addEventListener('click', () => toggleArtifact(stage.stageId))
    actions.append(openButton)
    if (stage.humanGateTaskId !== null) {
      const gateButton = document.createElement('button')
      gateButton.textContent = '定位门任务'
      gateButton.addEventListener('click', () => {
        const target = document.querySelector(`[data-gate="${stage.humanGateTaskId}"]`)
        if (target !== null) target.scrollIntoView({ block: 'center', behavior: 'smooth' })
      })
      actions.append(gateButton)
    }

    row.append(name, status, machine, review, digest, time, actions)
    tbody.append(row)
  }

  // 重入表单的 digest 自动填充：用当前阶段的真实 digest，避免用户手抄错。
  const select = $('reenter-stage')
  if (select.options.length === 0) {
    for (const stage of view.stages) {
      const option = document.createElement('option')
      option.value = stage.stageId
      option.textContent = `${STAGE_LABELS[stage.stageId] ?? stage.stageId}（${stage.stageId}）`
      select.append(option)
    }
    select.addEventListener('change', () => syncReenterDigest())
  }
  syncReenterDigest()
}

function syncReenterDigest() {
  const stageId = $('reenter-stage').value
  const stage = current?.stages.find(item => item.stageId === stageId)
  $('reenter-digest').value = stage?.digest ?? ''
}

async function toggleArtifact(stageId) {
  if (openArtifact === stageId) {
    openArtifact = null
    $('stage-detail').replaceChildren()
    renderStages(current)
    return
  }
  openArtifact = stageId
  const container = $('stage-detail')
  container.replaceChildren()
  const loading = document.createElement('p')
  loading.className = 'muted'
  loading.textContent = `正在读取 ${stageId} 的产物…`
  container.append(loading)
  try {
    const artifact = await api('GET', `/api/pipelines/${encodeURIComponent(current.pipelineId)}/stages/${encodeURIComponent(stageId)}/artifact`)
    const head = document.createElement('p')
    head.className = 'mono small'
    head.textContent = `${artifact.artifactPath} · v${artifact.version} · digest ${artifact.digest.slice(0, 16)}`
    const body = document.createElement('pre')
    body.className = 'artifact'
    body.textContent = JSON.stringify(artifact.content, null, 2)
    container.replaceChildren(head, body)
  } catch (error) {
    const failed = document.createElement('p')
    failed.className = 'muted'
    // 404 = 该阶段尚未产出（服务端不编造空产物），如实展示。
    failed.textContent = `${error.code === 'not-found' ? '该阶段尚无产物' : `读取产物失败：${error.message}`}`
    container.replaceChildren(failed)
  }
  renderStages(current)
}

// ── 渲染：人工门 ─────────────────────────────────────────────────────────────

function renderGates(gates) {
  const container = $('gate-list')
  container.replaceChildren()
  if (gates.length === 0) {
    const empty = document.createElement('p')
    empty.className = 'muted'
    empty.textContent = '当前没有人工门任务。'
    container.append(empty)
    return
  }

  for (const task of gates) {
    const box = document.createElement('div')
    box.className = 'gate'
    box.dataset.gate = task.gateTaskId
    box.dataset.status = task.status

    const head = document.createElement('div')
    head.className = 'gate-head'
    head.innerHTML = `<strong>${STAGE_LABELS[task.stageId] ?? task.stageId}</strong>
      <span class="chip" data-status="${task.status}">${GATE_STATUS_LABELS[task.status] ?? task.status}</span>
      <span class="mono small">${task.gateTaskId}</span>`
    box.append(head)

    const meta = document.createElement('p')
    meta.className = 'mono small'
    meta.textContent = `产物 ${task.artifactPath} · 机器门禁 ${task.machineStatus}`
      + (task.claimedBy ? ` · 认领人 ${task.claimedBy}` : '')
      + (task.decision ? ` · 裁决 ${task.decision.action} by ${task.decision.by}：${task.decision.note}` : '')
      + (task.cancellation ? ` · 已取消 by ${task.cancellation.by}：${task.cancellation.note}` : '')
      + (task.consumedAt ? ' · 裁决已被消费' : '')
    box.append(meta)

    if (task.machineViolations.length > 0) {
      const list = document.createElement('ul')
      list.className = 'violations'
      for (const violation of task.machineViolations) {
        const item = document.createElement('li')
        item.dataset.level = violation.level
        item.textContent = `[${violation.level}] ${violation.rule}：${violation.detail}`
        list.append(item)
      }
      box.append(list)
    }
    if (task.review !== undefined) {
      const review = document.createElement('div')
      review.className = 'review'
      review.innerHTML = `<span class="chip" data-status="review">${task.review.verdict}</span>`
      const list = document.createElement('ul')
      list.className = 'findings'
      for (const finding of task.review.findings) {
        const item = document.createElement('li')
        item.textContent = finding
        list.append(item)
      }
      review.append(list)
      box.append(review)
    }

    // 已终态的任务只读展示：再次裁决会被服务端以 gate-not-decidable 拒绝，
    // 因此前端也不提供按钮，避免制造"点了就能改"的错觉。
    const decidable = task.status === 'pending' || task.status === 'claimed'
    if (decidable) {
      const note = document.createElement('input')
      note.placeholder = '裁决说明（打回/拒绝时必填）'
      const row = document.createElement('div')
      row.className = 'actions'
      for (const [action, label] of [['approved', '批准'], ['changes-needed', '打回重跑'], ['rejected', '拒绝']]) {
        const button = document.createElement('button')
        button.textContent = label
        if (action === 'approved') button.className = 'primary'
        button.addEventListener('click', () => decideGate(task, action, note.value, box))
        row.append(button)
      }
      const cancelButton = document.createElement('button')
      cancelButton.textContent = '取消任务'
      cancelButton.addEventListener('click', () => cancelGate(task, note.value, box))
      row.append(cancelButton)
      box.append(note, row)
    }

    container.append(box)
  }
}

async function decideGate(task, action, note, box) {
  try {
    await api('POST', `/api/gates/${encodeURIComponent(task.gateTaskId)}/decide`, {
      pipelineId: current.pipelineId,
      action,
      note,
      // 乐观并发：带上页面看到的 updatedAt，避免覆盖他人在同一页面上完成的裁决。
      expectedUpdatedAt: task.updatedAt,
    })
    report('out-run', `已裁决 ${task.stageId} → ${action}；再次触发运行即消费该裁决。`)
    await refresh()
  } catch (error) {
    showError('out-run', error)
    if (error.code === 'conflict') await refresh()
  }
}

async function cancelGate(task, note, box) {
  try {
    await api('POST', `/api/gates/${encodeURIComponent(task.gateTaskId)}/cancel`, {
      pipelineId: current.pipelineId,
      note,
    })
    report('out-run', `已取消门任务 ${task.gateTaskId}。`)
    await refresh()
  } catch (error) {
    showError('out-run', error)
  }
}

// ── 渲染：事件 ───────────────────────────────────────────────────────────────

function renderEvents(events) {
  const list = $('event-list')
  list.replaceChildren()
  if (events.length === 0) {
    const empty = document.createElement('li')
    empty.className = 'muted'
    empty.textContent = '尚无事件。'
    list.append(empty)
    return
  }
  for (const event of events) {
    const item = document.createElement('li')
    item.innerHTML = `<span class="mono small">${new Date(event.at).toLocaleString()}</span>
      <span class="chip" data-status="event">${EVENT_LABELS[event.kind] ?? event.kind}</span>
      <span>${event.stageId === null ? '' : `${STAGE_LABELS[event.stageId] ?? event.stageId} · `}${escapeHtml(event.detail)}</span>
      ${event.actorId === null ? '' : `<span class="muted small">by ${escapeHtml(event.actorId)}</span>`}`
    list.append(item)
  }
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, char => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]
  ))
}

// ── 刷新与轮询 ───────────────────────────────────────────────────────────────

async function refresh() {
  const pipelineId = $('pipelineId').value.trim()
  if (pipelineId === '') return
  try {
    const view = await api('GET', `/api/pipelines/${encodeURIComponent(pipelineId)}`)
    current = view
    $('run-status').textContent = STATUS_LABELS[view.status] ?? view.status
    $('run-status').dataset.status = view.status
    $('run-meta').textContent = `cursor ${view.cursor} · 下一阶段 ${view.nextStage ?? '—'}`
      + ` · 后台运行中 ${view.running ? '是' : '否'}`
      + ` · 模板 ${view.templateVersion} · 规则集 ${view.rulesetVersion}`
      + (view.openGateTaskId === null ? '' : ` · 待裁决 ${view.openGateTaskId}`)
    renderStages(view)

    const [gates, events] = await Promise.all([
      api('GET', `/api/pipelines/${encodeURIComponent(pipelineId)}/gates`),
      api('GET', `/api/pipelines/${encodeURIComponent(pipelineId)}/events`),
    ])
    renderGates(gates.gates)
    renderEvents(events.events)
  } catch (error) {
    showError('out-run', error)
    $('run-status').textContent = '读取失败'
    $('run-status').dataset.status = 'failed'
    $('run-meta').textContent = error.message
  }
}

function setPolling(enabled) {
  if (pollTimer !== null) {
    clearInterval(pollTimer)
    pollTimer = null
  }
  if (enabled) pollTimer = setInterval(() => { void refresh() }, 2000)
}

// ── 事件绑定 ─────────────────────────────────────────────────────────────────

$('btn-create').addEventListener('click', async () => {
  const projectId = $('projectId').value.trim()
  const pipelineId = $('pipelineId').value.trim()
  try {
    // 只发可公开字段：没有 apiKey，configRef 由服务端决定。
    const body = { pipelineId }
    for (const [field, id] of [['requirementInput', 'requirementInput'], ['providerName', 'providerName'], ['targetBaseUrl', 'targetBaseUrl']]) {
      const value = $(id).value.trim()
      if (value !== '') body[field] = value
    }
    const summary = await api('POST', `/api/projects/${encodeURIComponent(projectId)}/pipelines`, body)
    report('out-create', summary)
    await refresh()
  } catch (error) {
    showError('out-create', error)
  }
})

$('btn-refresh').addEventListener('click', () => { void refresh() })

$('btn-list').addEventListener('click', async () => {
  try {
    const { pipelines } = await api('GET', '/api/pipelines')
    const list = $('pipeline-list')
    list.replaceChildren()
    for (const item of pipelines) {
      const node = document.createElement('li')
      const button = document.createElement('button')
      button.className = 'link'
      button.textContent = `${item.pipelineId} · ${item.projectId} · ${STATUS_LABELS[item.status] ?? item.status}`
      button.addEventListener('click', () => {
        $('pipelineId').value = item.pipelineId
        $('projectId').value = item.projectId
        openArtifact = null
        void refresh()
      })
      node.append(button)
      list.append(node)
    }
    if (pipelines.length === 0) list.innerHTML = '<li class="muted">没有可见的流水线。</li>'
  } catch (error) {
    showError('out-create', error)
  }
})

$('btn-run').addEventListener('click', async () => {
  const pipelineId = $('pipelineId').value.trim()
  try {
    const result = await api('POST', `/api/pipelines/${encodeURIComponent(pipelineId)}/run`)
    report('out-run', result.started
      ? '已在后台触发运行（202）。人工门等待超时后本次运行以 waiting-human 结束，裁决后再次触发即续跑。'
      : `未启动新运行：${result.reason === 'already-running' ? '该流水线已有后台运行在进行' : result.reason}`)
    // 后台运行不是同步的：稍等再刷新，避免读到触发前的状态。
    setTimeout(() => { void refresh() }, 500)
  } catch (error) {
    showError('out-run', error)
  }
})

$('btn-cancel-run').addEventListener('click', async () => {
  const pipelineId = $('pipelineId').value.trim()
  try {
    const result = await api('POST', `/api/pipelines/${encodeURIComponent(pipelineId)}/cancel`)
    report('out-run', result.cancelled ? '已发送取消信号。' : '当前没有本进程内的后台运行可取消。')
    await refresh()
  } catch (error) {
    showError('out-run', error)
  }
})

$('btn-recover').addEventListener('click', async () => {
  try {
    const { outcomes } = await api('POST', '/api/admin/recover')
    report('out-run', outcomes.length === 0
      ? '没有需要恢复的流水线。'
      : outcomes.map(item => `${item.pipelineId} → ${item.action}${item.started ? '（已续跑）' : ''}${item.detail ? `：${item.detail}` : ''}`).join('\n'))
    setTimeout(() => { void refresh() }, 500)
  } catch (error) {
    showError('out-run', error)
  }
})

$('btn-reenter').addEventListener('click', async () => {
  const pipelineId = $('pipelineId').value.trim()
  const stageId = $('reenter-stage').value
  const reason = $('reenter-reason').value.trim()
  const expectedCurrentDigest = $('reenter-digest').value
  try {
    const result = await api('POST', `/api/pipelines/${encodeURIComponent(pipelineId)}/reenter`, {
      stageId,
      reason,
      ...(expectedCurrentDigest === '' ? {} : { expectedCurrentDigest }),
    })
    report('out-reenter', `重入已登记：cursor ${result.cursor}，累计 ${result.reentries.length} 次。触发运行即级联重跑。`)
    await refresh()
  } catch (error) {
    showError('out-reenter', error)
    if (error.code === 'conflict') await refresh()
  }
})

$('auto-poll').addEventListener('change', event => setPolling(event.target.checked))

void (async () => {
  await refreshHealth()
  await refresh()
  setPolling($('auto-poll').checked)
})()
