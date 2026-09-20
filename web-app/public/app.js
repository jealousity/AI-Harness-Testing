const stages = [
  { id: 'receive', label: '需求接收' },
  { id: 'analyze', label: '需求分析' },
  { id: 'design', label: '测试设计' },
  { id: 'execute', label: '测试执行' },
  { id: 'report', label: '测试报告' },
  { id: 'archive', label: '产物归档' },
]

const sample = `需求：登录功能改造
目标：支持手机号 + 验证码登录，同时保留原有密码登录。
变更点：新增 POST /api/login/sms；验证码错误返回 400；成功返回会话 token。
验收标准：
1. 有效手机号和验证码可以登录成功
2. 错误验证码返回 400 且不创建会话
3. 密码登录不受影响
4. 重复提交不会产生多个有效会话
优先级：P0`

const form = document.querySelector('#run-form')
const apiKeyInput = document.querySelector('#api-key')
const toggleKey = document.querySelector('#toggle-key')
const useSample = document.querySelector('#use-sample')
const formError = document.querySelector('#form-error')
const launchButton = document.querySelector('.launch-button')
const runState = document.querySelector('#run-state')
const artifactTitle = document.querySelector('#artifact-title')
const artifactEmpty = document.querySelector('#artifact-empty')
const artifactContent = document.querySelector('#artifact-content')
const copyButton = document.querySelector('#copy-artifact')
let currentRun = null
let currentArtifact = null
let pollTimer = null

const statusText = { queued: '排队中', running: '运行中', done: '已完成', failed: '失败' }

function setFormError(message = '') {
  formError.textContent = message
}

function setRunState(status, text) {
  runState.className = `run-state ${status || ''}`
  runState.innerHTML = `<span class="state-dot"></span><span>${text}</span>`
}

function renderStages(run) {
  for (const stage of stages) {
    const button = document.querySelector(`[data-stage="${stage.id}"]`)
    const state = run?.stages?.[stage.id] || { status: 'queued' }
    button.className = `stage-item ${state.status || ''} ${currentArtifact?.stageId === stage.id ? 'active' : ''}`
    const status = state.status === 'queued' ? '待开始' : (statusText[state.status] || state.status)
    button.querySelector('.stage-status').textContent = status
  }
}

function showArtifact(artifact) {
  currentArtifact = artifact
  if (!artifact) {
    artifactTitle.textContent = '阶段产物'
    artifactEmpty.classList.remove('hidden')
    artifactContent.classList.add('hidden')
    copyButton.disabled = true
    renderStages(currentRun)
    return
  }
  const stage = stages.find((item) => item.id === artifact.stageId)
  artifactTitle.textContent = `${stage?.label || artifact.stageId} · 产物`
  artifactEmpty.classList.add('hidden')
  artifactContent.classList.remove('hidden')
  artifactContent.textContent = artifact.content
  copyButton.disabled = false
  renderStages(currentRun)
}

function renderRun(run) {
  currentRun = run
  if (run.status === 'completed') setRunState('completed', '流水线已完成')
  else if (run.status === 'failed') setRunState('failed', '运行失败')
  else if (run.status === 'running') setRunState('running', '流水线运行中')
  else setRunState('', '等待运行')
  renderStages(run)
  const latest = run.artifacts?.[run.artifacts.length - 1]
  if (latest && !currentArtifact) showArtifact(latest)
  if (currentArtifact) {
    const fresh = run.artifacts?.find((item) => item.stageId === currentArtifact.stageId)
    if (fresh) showArtifact(fresh)
  }
}

async function pollRun(runId) {
  try {
    const response = await fetch(`/api/runs/${encodeURIComponent(runId)}`, { cache: 'no-store' })
    const data = await response.json()
    if (!response.ok) throw new Error(data.error || '无法读取运行状态')
    renderRun(data)
    if (data.status === 'completed' || data.status === 'failed') {
      clearInterval(pollTimer)
      pollTimer = null
      launchButton.disabled = false
      launchButton.querySelector('span:nth-child(2)').textContent = data.status === 'completed' ? '再次运行' : '重试流水线'
      if (data.error) setFormError(data.error)
    }
  } catch (error) {
    clearInterval(pollTimer)
    pollTimer = null
    launchButton.disabled = false
    setFormError(error.message)
    setRunState('failed', '状态读取失败')
  }
}

form.addEventListener('submit', async (event) => {
  event.preventDefault()
  setFormError('')
  currentArtifact = null
  showArtifact(null)
  launchButton.disabled = true
  launchButton.querySelector('span:nth-child(2)').textContent = '正在启动…'
  setRunState('running', '准备运行')
  renderStages(null)
  const data = Object.fromEntries(new FormData(form).entries())
  try {
    const response = await fetch('/api/runs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(data),
    })
    const result = await response.json()
    if (!response.ok) throw new Error(result.error || '无法启动流水线')
    currentRun = null
    launchButton.querySelector('span:nth-child(2)').textContent = '流水线运行中…'
    await pollRun(result.runId)
    if (currentRun?.status !== 'completed' && currentRun?.status !== 'failed') {
      pollTimer = setInterval(() => pollRun(result.runId), 1000)
    }
  } catch (error) {
    launchButton.disabled = false
    launchButton.querySelector('span:nth-child(2)').textContent = '运行测试流水线'
    setRunState('failed', '启动失败')
    setFormError(error.message)
  }
})

document.querySelectorAll('.stage-item').forEach((button) => {
  button.addEventListener('click', () => {
    const artifact = currentRun?.artifacts?.find((item) => item.stageId === button.dataset.stage)
    if (artifact) showArtifact(artifact)
  })
})

toggleKey.addEventListener('click', () => {
  const visible = apiKeyInput.type === 'text'
  apiKeyInput.type = visible ? 'password' : 'text'
  toggleKey.textContent = visible ? '显示' : '隐藏'
  toggleKey.setAttribute('aria-label', visible ? '显示 API Key' : '隐藏 API Key')
})

useSample.addEventListener('click', () => {
  document.querySelector('#requirement').value = sample
})

copyButton.addEventListener('click', async () => {
  if (!currentArtifact) return
  await navigator.clipboard.writeText(currentArtifact.content)
  const old = copyButton.textContent
  copyButton.textContent = '已复制'
  setTimeout(() => { copyButton.textContent = old }, 1200)
})
