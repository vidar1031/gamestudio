import path from 'node:path'

function normalizePrompt(value) {
  return String(value || '').replace(/\s+/g, ' ').trim()
}

function createPlanId() {
  return `gamestudio_bootstrap_plan_${Date.now()}_${Math.random().toString(16).slice(2, 10)}`
}

function makeStep(stepId, title, action, params = {}, dependsOn = [], options = {}) {
  return {
    stepId,
    title,
    action,
    tool: options.tool || inferToolForBootstrapAction(action),
    params,
    skipReview: options.skipReview !== false,
    dependsOn
  }
}

function inferToolForBootstrapAction(action) {
  if (action === 'gamestudio_ensure_running') return 'gamestudio.bootstrap.ensureRunning'
  if (action === 'gamestudio_open_editor') return 'gamestudio.bootstrap.openEditor'
  if (action === 'gamestudio_read_settings') return 'gamestudio.bootstrap.readSettings'
  if (action === 'gamestudio_configure_local_production') return 'gamestudio.bootstrap.configureLocalProduction'
  if (action === 'gamestudio_self_check') return 'gamestudio.bootstrap.selfCheck'
  if (action === 'gamestudio_bootstrap_answer') return 'gamestudio.bootstrap.answer'
  return 'planner.default'
}

// 短编辑距离：容忍 gamestudio 的常见拼写错误（如 gamesutdio 两个相邻字母颠倒，2026-08-28 实测用户输入未命中路由）
function editDistanceWithin(a, b, max) {
  const al = a.length
  const bl = b.length
  if (Math.abs(al - bl) > max) return max + 1
  let prev = Array.from({ length: bl + 1 }, (_, j) => j)
  for (let i = 1; i <= al; i += 1) {
    const cur = [i]
    let rowMin = cur[0]
    for (let j = 1; j <= bl; j += 1) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
      if (cur[j] < rowMin) rowMin = cur[j]
    }
    if (rowMin > max) return max + 1
    prev = cur
  }
  return prev[bl]
}

function mentionsGameStudio(prompt) {
  if (/gamestudio|game studio|游戏工作室|start_project\.sh/i.test(prompt)) return true
  // 容错：gam 开头、长度相近的拉丁 token，与 gamestudio 编辑距离 ≤2 视为同一目标
  const tokens = prompt.toLowerCase().split(/[^a-z]+/).filter(Boolean)
  return tokens.some((t) => t.length >= 8 && t.length <= 12 && t.startsWith('gam') && editDistanceWithin(t, 'gamestudio', 2) <= 2)
}

export function isGameStudioBootstrapPrompt(userPrompt) {
  const prompt = normalizePrompt(userPrompt)
  if (!prompt) return false
  // 2026-09-08：ComfyUI 单独启动请求直认 bootstrap 链——ensureComfyUiRunning 经 Terminal.app 可见窗口拉起
  // 是项目规定的唯一正确启动方式。此前必须带 gamestudio 字样才命中，裸「启动 ComfyUI」/「sh start.sh」
  // 会落到 shell_execute 并被只读判定静默剥光（2026-09-08 实测现场）。
  if (/comfyui/i.test(prompt) && /启动|打开|拉起|运行|执行|launch|start/i.test(prompt)) return true
  if (!mentionsGameStudio(prompt)) return false
  return /启动|打开|界面|工作台|editor|workbench|ai[-_\s]?create[-_\s]?story|自检|检查|配置|comfyui|本地模型|local model|diagnose|preflight|bootstrap|settings|open|launch|start_project/i.test(prompt)
}

export function buildGameStudioBootstrapPlan(userPrompt) {
  const prompt = normalizePrompt(userPrompt)
  const steps = []
  const add = (stepId, title, action, params = {}, options = {}) => {
    const previous = steps[steps.length - 1]
    const step = makeStep(stepId, title, action, params, previous ? [previous.stepId] : [], options)
    steps.push(step)
    return step
  }

  const shouldConfigure = /配置|comfyui|本地模型|local model|omlx|生产|settings/i.test(prompt)
  const shouldOpenAiCreateStory = /AI\s*创建故事|AI\s*生成.*故事|创建故事|生成新故事|脚本层草稿|ai[-_\s]?create[-_\s]?story/i.test(prompt)
  const shouldRunHealthChecks = shouldConfigure || /自检|检查|diagnose|preflight|settings/i.test(prompt)

  add('step_gamestudio_ensure_running', '启动或确认 GameStudio Server/Editor', 'gamestudio_ensure_running', {
    startIfNeeded: true,
    serverUrl: 'http://127.0.0.1:1999',
    editorUrl: 'http://localhost:8868',
    comfyuiCheck: true
  })
  add('step_gamestudio_open_editor', '打开或返回 GameStudio Editor 界面', 'gamestudio_open_editor', {
    editorUrl: 'http://localhost:8868',
    openBrowser: true,
    ...(shouldOpenAiCreateStory ? { openNewTabFallback: false } : {}),
    ...(shouldOpenAiCreateStory ? { openTarget: 'ai-create-story' } : {})
  })
  if (shouldRunHealthChecks) {
    add('step_gamestudio_read_settings', '读取 GameStudio 当前 Studio Settings', 'gamestudio_read_settings', {})
  }
  if (shouldConfigure) {
    add('step_gamestudio_configure_local_production', '写入本地 OMLX 与 ComfyUI 生产默认配置', 'gamestudio_configure_local_production', {
      model: 'gpt-oss-20b-MXFP4-Q8',
      localModelBaseUrl: 'http://127.0.0.1:18888/v1',
      comfyuiBaseUrl: 'http://127.0.0.1:8188',
      comfyuiModelsRoot: process.env.COMFYUI_MODELS_ROOT || (process.env.COMFYUI_ROOT ? path.join(process.env.COMFYUI_ROOT, 'models') : '/Volumes/ovokit2t/ComfyUI/models'),
      imageModel: 'ivisionIllustration_ivision10.safetensors',
      imageSize: '1024x1024'
    })
  }
  if (shouldRunHealthChecks) {
    add('step_gamestudio_self_check', '执行 GameStudio 自检并反馈给 Control', 'gamestudio_self_check', {
      imagePreflight: true,
      imagePreflightMode: 'storyboard',
      ensureComfyUi: true,
      timeoutMs: 15000
    })
  }
  add('step_gamestudio_bootstrap_answer', '汇总 GameStudio 启动与打开结论', 'gamestudio_bootstrap_answer', {})

  return {
    planId: createPlanId(),
    goal: '启动或确认 GameStudio，打开界面，执行 settings/diagnose/preflight 自检并把结果反馈给 Control',
    strategy: 'sequential',
    steps
  }
}
