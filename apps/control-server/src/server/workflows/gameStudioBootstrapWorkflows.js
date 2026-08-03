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

export function isGameStudioBootstrapPrompt(userPrompt) {
  const prompt = normalizePrompt(userPrompt)
  if (!prompt) return false
  if (!/gamestudio|game studio|游戏工作室/i.test(prompt)) return false
  return /启动|打开|界面|工作台|editor|workbench|ai[-_\s]?create[-_\s]?story|自检|检查|配置|comfyui|本地模型|local model|diagnose|preflight|bootstrap|settings|open|launch/i.test(prompt)
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
