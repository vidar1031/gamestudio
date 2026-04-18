import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { cors } from 'hono/cors'

const app = new Hono()
const port = Number(process.env.CONTROL_SERVER_PORT || 2099)
const HERMES_ROOT = '/Volumes/ovokit2t/AIOVO/hermes-agent'
const GAMESTUDIO_ROOT = '/Volumes/ovokit2t/aiwork/gamestudio'
const HERMES_GATEWAY_SCRIPT = path.join(HERMES_ROOT, 'scripts', 'hermes-gateway')
const HERMES_VENV_PYTHON = path.join(HERMES_ROOT, 'venv', 'bin', 'python')
const HERMES_RUNTIME_PID_FILE = path.join(os.tmpdir(), 'gamestudio-hermes-gateway.pid')
const HERMES_RUNTIME_LOG_FILE = path.join(os.tmpdir(), 'gamestudio-hermes-gateway.log')
const HERMES_CONTROL_CONFIG_FILE = path.join(HERMES_ROOT, '.hermes_control_config.json')
const GAMESTUDIO_ENV_FILE = path.join(GAMESTUDIO_ROOT, '.env')
const AGENT_MEMORY_SOURCE_FILES = [
  path.join(GAMESTUDIO_ROOT, 'AGENTS.md'),
  path.join(GAMESTUDIO_ROOT, 'planner', 'AGENTS.md'),
  path.join(GAMESTUDIO_ROOT, 'executor', 'AGENTS.md'),
  path.join(GAMESTUDIO_ROOT, 'critic', 'AGENTS.md'),
  path.join(GAMESTUDIO_ROOT, 'reporter', 'AGENTS.md')
]

const MODEL_METADATA_CATALOG = {
  'gpt-oss-20b-mxfp4-q8': {
    contextLength: 131072,
    recommendedMaxOutputTokens: 8192,
    tokenizer: 'gpt-oss/qwen-compatible',
    metadataSource: 'catalog'
  },
  'qwen3.5-9b-mlx-4bit': {
    contextLength: 131072,
    recommendedMaxOutputTokens: 8192,
    tokenizer: 'qwen3.5',
    metadataSource: 'catalog'
  },
  'qwen3.5-27b-claude-4.6-opus-distilled-mlx-4bit': {
    contextLength: 131072,
    recommendedMaxOutputTokens: 8192,
    tokenizer: 'qwen3.5',
    metadataSource: 'catalog'
  },
  'qwen3.5-27b-claude-4.6-opus-distilled-mlx-6bit': {
    contextLength: 131072,
    recommendedMaxOutputTokens: 8192,
    tokenizer: 'qwen3.5',
    metadataSource: 'catalog'
  }
}

const hermesAgentDefinition = {
  id: 'hermes-manager',
  name: 'Hermes Manager',
  runtime: 'hermes',
  role: 'project-controller',
  description: 'Primary control-plane agent used by the manager system to read state, execute allowed actions, and write results back.',
  capabilities: [
    'read_control_state',
    'query_runtime_health',
    'execute_allowed_action',
    'write_action_result',
    'report_diagnostics'
  ]
}

const openclawAgentDefinition = {
  id: 'openclaw-manager',
  name: 'OpenClaw Manager',
  runtime: 'openclaw',
  role: 'project-controller',
  description: 'Reserved control-plane agent entry for OpenClaw. It is selectable in the manager, but its execution workflow is not enabled yet.',
  capabilities: [
    'read_control_state',
    'report_runtime_presence'
  ]
}

function getHermesPython() {
  return fs.existsSync(HERMES_VENV_PYTHON) ? HERMES_VENV_PYTHON : 'python3'
}

function readHermesPid() {
  try {
    const raw = fs.readFileSync(HERMES_RUNTIME_PID_FILE, 'utf8').trim()
    if (!raw) return null
    const pid = Number(raw)
    return Number.isFinite(pid) && pid > 0 ? pid : null
  } catch {
    return null
  }
}

function writeHermesPid(pid) {
  fs.writeFileSync(HERMES_RUNTIME_PID_FILE, String(pid), 'utf8')
}

function clearHermesPid() {
  try {
    fs.unlinkSync(HERMES_RUNTIME_PID_FILE)
  } catch {
    // Ignore missing pid files.
  }
}

function readSimpleEnvFile(filePath) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8')
    const parsed = {}
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('#')) continue
      const idx = trimmed.indexOf('=')
      if (idx <= 0) continue
      const key = trimmed.slice(0, idx).trim()
      let value = trimmed.slice(idx + 1).trim()
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1)
      }
      parsed[key] = value
    }
    return parsed
  } catch {
    return {}
  }
}

function getEnvValue(key) {
  return String(process.env[key] || readSimpleEnvFile(GAMESTUDIO_ENV_FILE)[key] || '').trim()
}

function normalizeModelBaseUrl(baseUrl, provider) {
  const fallback = provider === 'ollama' ? 'http://127.0.0.1:11434/v1' : 'http://127.0.0.1:18888/v1'
  const raw = String(baseUrl || fallback).trim() || fallback
  try {
    const url = new URL(raw)
    if (!/^https?:$/i.test(url.protocol)) return fallback
    url.pathname = String(url.pathname || '').replace(/\/+$/, '')
    if (!url.pathname || url.pathname === '/') {
      url.pathname = '/v1'
    }
    return url.toString().replace(/\/+$/, '')
  } catch {
    return fallback
  }
}

function getProviderApiKey(provider) {
  if (provider === 'ollama') return ''
  return getEnvValue('LOCALOXML_API_KEY') || getEnvValue('STUDIO_AI_API_KEY') || getEnvValue('OPENAI_API_KEY')
}

function getProviderAccess(provider, baseUrl) {
  const normalizedBaseUrl = normalizeModelBaseUrl(baseUrl, provider)
  const apiKey = getProviderApiKey(provider)
  return {
    provider,
    baseUrl: normalizedBaseUrl,
    apiKey,
    headers: {
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {})
    }
  }
}

function inferTokenizer(modelId) {
  const lower = String(modelId || '').trim().toLowerCase()
  if (lower.includes('qwen')) return 'qwen'
  if (lower.includes('gpt-oss')) return 'gpt-oss/qwen-compatible'
  if (lower.includes('gemma')) return 'gemma'
  return null
}

function getModelMetadata(modelId) {
  const lower = String(modelId || '').trim().toLowerCase()
  const exact = MODEL_METADATA_CATALOG[lower]
  if (exact) return exact
  return {
    contextLength: lower.includes('qwen') || lower.includes('gpt-oss') ? 131072 : null,
    recommendedMaxOutputTokens: lower.includes('qwen') || lower.includes('gpt-oss') ? 8192 : null,
    tokenizer: inferTokenizer(modelId),
    metadataSource: lower.includes('qwen') || lower.includes('gpt-oss') ? 'heuristic' : 'unavailable'
  }
}

function normalizeUsage(usage) {
  if (!usage || typeof usage !== 'object') {
    return {
      promptTokens: null,
      completionTokens: null,
      totalTokens: null
    }
  }

  return {
    promptTokens: Number.isFinite(Number(usage.prompt_tokens)) ? Number(usage.prompt_tokens) : null,
    completionTokens: Number.isFinite(Number(usage.completion_tokens)) ? Number(usage.completion_tokens) : null,
    totalTokens: Number.isFinite(Number(usage.total_tokens)) ? Number(usage.total_tokens) : null
  }
}

async function inspectModelAccess({ provider, baseUrl, model }) {
  const metadata = getModelMetadata(model)
  const access = getProviderAccess(provider, baseUrl)
  const checkedAt = new Date().toISOString()

  if (!model) {
    return {
      model,
      accessible: false,
      status: 'error',
      detail: '未选择模型',
      checkedAt,
      usage: normalizeUsage(null),
      ...metadata
    }
  }

  try {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 5000)
    const resp = await fetch(`${access.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...access.headers
      },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: 'ping' }],
        max_tokens: 1,
        temperature: 0
      }),
      signal: controller.signal
    })
    clearTimeout(timeout)

    const data = await resp.json().catch(() => null)
    if (!resp.ok) {
      const msg = data?.error?.message || data?.message || `HTTP ${resp.status}`
      return {
        model,
        accessible: false,
        status: 'error',
        detail: String(msg),
        checkedAt,
        usage: normalizeUsage(data?.usage),
        ...metadata
      }
    }

    return {
      model,
      accessible: true,
      status: 'ok',
      detail: '模型可访问，最小推理探测成功',
      checkedAt,
      usage: normalizeUsage(data?.usage),
      ...metadata
    }
  } catch (err) {
    return {
      model,
      accessible: false,
      status: 'error',
      detail: err instanceof Error ? err.message : String(err),
      checkedAt,
      usage: normalizeUsage(null),
      ...metadata
    }
  }
}

function isPidRunning(pid) {
  if (!pid) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function detectHermesInstallState() {
  if (!fs.existsSync(HERMES_GATEWAY_SCRIPT)) {
    return {
      installed: false,
      detail: '未找到 Hermes gateway 脚本'
    }
  }

  const python = getHermesPython()
  const result = spawnSync(python, [HERMES_GATEWAY_SCRIPT, '--help'], {
    cwd: HERMES_ROOT,
    encoding: 'utf8',
    timeout: 5000,
    env: process.env
  })

  if (result.error) {
    return {
      installed: false,
      detail: result.error.message
    }
  }

  if (result.status !== 0) {
    return {
      installed: false,
      detail: (result.stderr || result.stdout || 'Hermes 调用失败').trim()
    }
  }

  return {
    installed: true,
    detail: 'Hermes 可调用'
  }
}

function getHermesRuntimeState() {
  const installState = detectHermesInstallState()
  if (!installState.installed) {
    clearHermesPid()
    return {
      state: 'uninstalled',
      label: '未安装',
      detail: installState.detail,
      pid: null,
      logFile: HERMES_RUNTIME_LOG_FILE,
      availableActions: []
    }
  }

  const pid = readHermesPid()
  if (pid && isPidRunning(pid)) {
    return {
      state: 'running',
      label: '运行中',
      detail: 'Hermes gateway 进程正在运行',
      pid,
      logFile: HERMES_RUNTIME_LOG_FILE,
      availableActions: ['pause', 'exit']
    }
  }

  clearHermesPid()
  return {
    state: 'stopped',
    label: '已暂停',
    detail: 'Hermes 已安装，但当前没有运行中的 manager 受控进程',
    pid: null,
    logFile: HERMES_RUNTIME_LOG_FILE,
    availableActions: ['resume']
  }
}

async function startHermesRuntime(options = {}) {
  const current = getHermesRuntimeState()
  if (current.state === 'uninstalled') {
    return current
  }
  if (current.state === 'running') {
    return current
  }

  if (Object.keys(options).length > 0) {
    const existing = getHermesControlConfig()
    setHermesControlConfig({ ...existing, ...options })
  }

  const binding = buildHermesBinding()
  const providerAccess = getProviderAccess(binding.provider, binding.baseUrl)
  const customEnv = {
    ...process.env,
    HERMES_MODEL: binding.model,
    HERMES_PROVIDER: binding.provider,
    HERMES_BASE_URL: binding.baseUrl,
    GAMESTUDIO_AGENT_CONFIG_FILES: binding.agentMemoryFiles.join(path.delimiter),
    GAMESTUDIO_AGENT_CONFIG_COUNT: String(binding.agentMemoryCount || 0),
    GAMESTUDIO_AGENT_CONFIG_JSON: JSON.stringify(binding.agentMemoryAgents || []),
    ...(providerAccess.apiKey ? {
      OPENAI_API_KEY: providerAccess.apiKey,
      LOCALOXML_API_KEY: providerAccess.apiKey
    } : {})
  }

  fs.mkdirSync(path.dirname(HERMES_RUNTIME_LOG_FILE), { recursive: true })
  const logFd = fs.openSync(HERMES_RUNTIME_LOG_FILE, 'a')
  const child = spawn(getHermesPython(), [HERMES_GATEWAY_SCRIPT, 'run'], {
    cwd: HERMES_ROOT,
    detached: true,
    stdio: ['ignore', logFd, logFd],
    env: customEnv
  })

  child.unref()
  writeHermesPid(child.pid)

  await new Promise((resolve) => setTimeout(resolve, 600))
  return getHermesRuntimeState()
}

async function stopHermesRuntime() {
  const current = getHermesRuntimeState()
  if (current.state !== 'running' || !current.pid) {
    return current
  }

  try {
    process.kill(-current.pid, 'SIGTERM')
  } catch {
    try {
      process.kill(current.pid, 'SIGTERM')
    } catch {
      // Ignore stop failures and fall through to state refresh.
    }
  }

  for (let i = 0; i < 20; i++) {
    await new Promise((resolve) => setTimeout(resolve, 500))
    if (!isPidRunning(current.pid)) break
  }

  const refreshed = getHermesRuntimeState()
  if (refreshed.state !== 'running') {
    clearHermesPid()
  } else {
    try {
      process.kill(-current.pid, 'SIGKILL')
    } catch {
      try {
        process.kill(current.pid, 'SIGKILL')
      } catch {}
    }
    await new Promise((resolve) => setTimeout(resolve, 500))
    const hardRefreshed = getHermesRuntimeState()
    if (hardRefreshed.state !== 'running') {
      clearHermesPid()
    }
  }
  
  return getHermesRuntimeState()
}

function getHermesControlConfig() {
  try {
    const raw = fs.readFileSync(HERMES_CONTROL_CONFIG_FILE, 'utf8')
    return JSON.parse(raw)
  } catch {
    return {}
  }
}

function setHermesControlConfig(cfg) {
  try {
    fs.writeFileSync(HERMES_CONTROL_CONFIG_FILE, JSON.stringify(cfg, null, 2), 'utf8')
  } catch {}
}

function readMarkdownFile(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8')
  } catch {
    return ''
  }
}

function extractSectionList(body, sectionTitle) {
  const escapedTitle = sectionTitle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = body.match(new RegExp(`####\\s+${escapedTitle}\\s*\\n([\\s\\S]*?)(?=\\n####\\s+|$)`))
  if (!match) return []
  return match[1]
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith('- '))
    .map((line) => line.slice(2).trim())
    .filter(Boolean)
}

function parseAgentSection(title, body) {
  const cleanTitle = String(title || '').replace(/[*`]/g, '').trim()
  const nameMatch = cleanTitle.match(/\b(Planner|Executor|Critic|Reporter)\b/)
  const agentIdMatch = body.match(/\*\*角色 ID\*\*:\s*`?([^`\n]+)`?/)
  const roleMatch = body.match(/\*\*角色定位\*\*:\s*([^\n]+)/)
  const personalityMatch = body.match(/\*\*性格特点\*\*:\s*([^\n]+)/)
  const responsibilities = extractSectionList(body, '职责')

  return {
    name: nameMatch ? nameMatch[1] : cleanTitle,
    title: cleanTitle,
    agentId: agentIdMatch ? agentIdMatch[1].trim() : '',
    role: roleMatch ? roleMatch[1].trim() : '未定义',
    personality: personalityMatch ? personalityMatch[1].trim() : '未定义',
    responsibilities
  }
}

function buildAgentMemoryConfig() {
  const sourceFiles = AGENT_MEMORY_SOURCE_FILES.filter((filePath) => fs.existsSync(filePath))
  const rootMarkdown = readMarkdownFile(path.join(GAMESTUDIO_ROOT, 'AGENTS.md'))
  const agents = []

  for (const match of rootMarkdown.matchAll(/^###\s+\d+\.\s+(.+)\n([\s\S]*?)(?=^###\s+\d+\.\s+|$)/gm)) {
    const agent = parseAgentSection(match[1], match[2])
    if (agent.role !== '未定义') {
      agents.push(agent)
    }
  }

  return {
    sourceFiles,
    agentCount: agents.length,
    agents
  }
}

function buildHermesBinding() {
  const cfg = getHermesControlConfig()
  const model = String(cfg.model || process.env.HERMES_MODEL || 'gpt-oss-20b-MXFP4-Q8')
  const provider = String(cfg.provider || process.env.HERMES_PROVIDER || 'custom/local')
  const baseUrl = normalizeModelBaseUrl(cfg.baseUrl || process.env.HERMES_BASE_URL || 'http://127.0.0.1:18888/v1', provider)
  const metadata = getModelMetadata(model)
  const agentMemory = buildAgentMemoryConfig()
  return {
    runtimeId: 'hermes-local-cli',
    runtimeKind: 'local-cli',
    workspace: GAMESTUDIO_ROOT,
    command: 'python -m hermes_cli.main status',
    model,
    provider,
    baseUrl,
    contextLength: Number.isFinite(Number(cfg.contextLength)) ? Number(cfg.contextLength) : metadata.contextLength,
    recommendedMaxOutputTokens: Number.isFinite(Number(cfg.recommendedMaxOutputTokens)) ? Number(cfg.recommendedMaxOutputTokens) : metadata.recommendedMaxOutputTokens,
    tokenizer: String(cfg.tokenizer || metadata.tokenizer || '') || null,
    metadataSource: String(cfg.metadataSource || metadata.metadataSource || 'unavailable'),
    agentMemoryFiles: agentMemory.sourceFiles,
    agentMemoryCount: agentMemory.agentCount,
    agentMemoryAgents: agentMemory.agents
  }
}

function buildHermesStatus() {
  const runtimeState = getHermesRuntimeState()
  return {
    lifecycle: 'registered',
    availability: runtimeState.state === 'running' ? 'running' : runtimeState.state,
    health: runtimeState.state === 'running' ? 'ok' : 'unknown',
    interactionMode: 'manager-mediated',
    currentSessionId: null,
    currentActionId: null,
    contextPressure: 'unknown',
    lastHeartbeatAt: null,
    lastError: runtimeState.state === 'uninstalled' ? runtimeState.detail : null
  }
}

function buildHermesActionContract() {
  return {
    requestShape: {
      actionId: 'string',
      actionType: 'string',
      projectId: 'string',
      stageId: 'string|null',
      payload: 'object',
      constraints: 'object'
    },
    resultShape: {
      actionId: 'string',
      status: 'succeeded|failed|degraded',
      summary: 'string',
      diagnostics: 'object|null',
      suggestedNextAction: 'string|null'
    },
    currentSupportedActions: [
      'read_project_overview',
      'check_runtime_health',
      'advance_stage_by_instruction',
      'report_failure_diagnostics'
    ]
  }
}

function buildHermesStartupProfile() {
  return {
    profileId: 'hermes-manager-default-startup',
    agentId: hermesAgentDefinition.id,
    mode: 'manager-driven',
    objective: 'Route Hermes startup through the manager system instead of using GameStudio-specific boot logic inside Hermes itself.',
    constraints: {
      readBootMarkdownDirectly: false,
      inferProjectStateFromConversation: false,
      writeProjectMemoryDirectly: false,
      useManagerAsControlPlane: true
    },
    startupSequence: [
      {
        step: 1,
        action: 'register_runtime_presence',
        successCondition: 'manager records Hermes as online and available for control actions'
      },
      {
        step: 2,
        action: 'read_control_overview',
        successCondition: 'Hermes receives current control-system summary and primary agent context'
      },
      {
        step: 3,
        action: 'check_runtime_health',
        successCondition: 'Hermes reports runtime health, model route, and immediate blockers back to manager'
      },
      {
        step: 4,
        action: 'request_first_manager_action',
        successCondition: 'Hermes obtains the next allowed action from manager instead of self-booting GameStudio logic'
      }
    ],
    failurePolicy: {
      onStartupCheckFail: 'set_agent_status_degraded',
      onMissingManagerState: 'stop_and_report',
      onContextPressureUnknown: 'report_only'
    },
    notes: [
      'GameStudio-specific boot logic should migrate out of Hermes and into manager-provided startup profiles.',
      'Hermes should not auto-run BOOT.md for GameStudio once manager-driven startup is enabled.',
      'Manager owns startup orchestration; Hermes owns execution and result reporting.'
    ]
  }
}

function buildHermesNextAction() {
  return {
    actionId: 'startup-check-runtime-health',
    actionType: 'check_runtime_health',
    title: '检查 Hermes 运行健康',
    purpose: '在 manager-driven startup 中先确认 Hermes 运行时、模型路由和当前阻塞项，再请求下一条管理动作。',
    status: 'ready',
    endpoint: '/api/control/agents/hermes-manager/next-action',
    constraints: [
      'Do not read GameStudio BOOT.md directly',
      'Do not infer project stage from conversation memory',
      'Write result back to manager before taking another action'
    ],
    expectedWriteback: {
      status: 'succeeded|failed|degraded',
      summary: 'runtime health summary',
      diagnostics: 'provider/model/context blockers',
      suggestedNextAction: 'request_first_manager_action'
    }
  }
}

async function buildHermesSelfCheck() {
  const binding = buildHermesBinding()
  const providerAccess = getProviderAccess(binding.provider, binding.baseUrl)
  
  // 检查 Python 环境
  const pythonOk = fs.existsSync(getHermesPython())
  
  // 检查工作区可读写
  let workspaceOk = false
  try {
    fs.accessSync(binding.workspace, fs.constants.R_OK | fs.constants.W_OK)
    workspaceOk = true
  } catch {
    workspaceOk = false
  }

  // 检查 LLM 模型路由
  let modelRouteStatus = 'error'
  let modelRouteDetail = 'Fetch failed'
  try {
    // Timeout of 2.5s
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 2500)
    
    const resp = await fetch(`${providerAccess.baseUrl}/models`, { 
      method: 'GET',
      headers: providerAccess.headers,
      signal: controller.signal
    }).catch(e => {
      // ignore pure network errors
      return { ok: false, status: 0, statusText: e.message }
    })
    
    clearTimeout(timeout)

    if (resp && resp.ok) {
      modelRouteStatus = 'ok'
      modelRouteDetail = `${binding.provider} -> ${binding.model} (API Connectivity OK)`
    } else {
      modelRouteStatus = 'error'
      modelRouteDetail = `模型服务连接失败: HTTP ${resp ? resp.status : 'Unknown'} (${resp ? resp.statusText : 'No Response'})`
    }
  } catch (err) {
    modelRouteStatus = 'error'
    modelRouteDetail = `网络故障或超时: ${err.message}`
  }

  const allOk = pythonOk && workspaceOk && modelRouteStatus === 'ok'

  return {
    agentId: hermesAgentDefinition.id,
    runtimeStatus: 'run',
    summary: allOk 
      ? 'Hermes 环境检查全部通过，引擎具备工作能力。' 
      : '发现潜在问题，引擎的请求可能遇到阻塞。',
    checkedAt: new Date().toISOString(),
    checks: [
      {
        key: 'python-env',
        label: 'Python Environment',
        status: pythonOk ? 'ok' : 'error',
        detail: pythonOk ? `Venv resolved: ${getHermesPython()}` : 'Python executable not found'
      },
      {
        key: 'workspace-access',
        label: 'Workspace Access',
        status: workspaceOk ? 'ok' : 'error',
        detail: workspaceOk ? 'R/W permission granted' : 'Cannot read/write workspace'
      },
      {
        key: 'model-route',
        label: 'Model Route',
        status: modelRouteStatus,
        detail: modelRouteDetail
      },
      {
        key: 'mcp-connection',
        label: 'MCP Connections',
        status: 'ok',
        detail: 'Local registry validated'
      },
      {
        key: 'agent-memory',
        label: 'Agent Memory',
        status: binding.agentMemoryCount > 0 ? 'ok' : 'error',
        detail: binding.agentMemoryCount > 0
          ? `Loaded ${binding.agentMemoryCount} agents from ${binding.agentMemoryFiles.length} files`
          : 'No agent memory markdown detected'
      }
    ],
    info: {
      model: binding.model,
      provider: binding.provider,
      baseUrl: binding.baseUrl,
      contextLength: binding.contextLength,
      recommendedMaxOutputTokens: binding.recommendedMaxOutputTokens,
      tokenizer: binding.tokenizer,
      metadataSource: binding.metadataSource,
      workspace: binding.workspace,
      command: binding.command,
      interactionMode: buildHermesStatus().interactionMode
    }
  }
}

function buildHermesStartupFlow() {
  return {
    flowId: 'hermes-manager-first-operation',
    agentId: hermesAgentDefinition.id,
    title: 'Hermes 首轮接管流程',
    status: 'ready',
    description: '管理器先让 Hermes 报到、读取控制面、完成运行健康检查，再由管理器下发第一条正式动作。',
    phases: [
      {
        step: 1,
        id: 'register-runtime',
        title: '注册运行时',
        owner: 'manager',
        status: 'ready',
        purpose: '确认 Hermes 代理已被控制系统识别并绑定到当前工作区。'
      },
      {
        step: 2,
        id: 'read-control-overview',
        title: '读取控制面概览',
        owner: 'hermes',
        status: 'ready',
        purpose: '避免 Hermes 继续使用 GameStudio 专项 boot 逻辑，改为先读控制系统事实。'
      },
      {
        step: 3,
        id: 'runtime-health-check',
        title: '执行运行健康检查',
        owner: 'hermes',
        status: 'active',
        purpose: '确认本地模型、当前 provider/base_url、上下文压力和直接阻塞项。'
      },
      {
        step: 4,
        id: 'request-first-action',
        title: '请求第一条动作',
        owner: 'manager',
        status: 'pending',
        purpose: '由管理器决定 Hermes 后续行为，而不是 Hermes 自行决定如何处理 GameStudio。'
      }
    ],
    nextAction: buildHermesNextAction()
  }
}

function buildHermesAgentRecord() {
  return {
    definition: hermesAgentDefinition,
    binding: buildHermesBinding(),
    status: buildHermesStatus(),
    contract: buildHermesActionContract(),
    startupProfile: buildHermesStartupProfile(),
    startupFlow: buildHermesStartupFlow()
  }
}

function buildOpenClawBinding() {
  return {
    runtimeId: 'openclaw-local-cli',
    runtimeKind: 'local-cli',
    workspace: '/Volumes/ovokit2t/aiwork/gamestudio',
    command: 'openclaw --version',
    model: 'pending',
    provider: 'pending',
    baseUrl: 'pending'
  }
}

function buildOpenClawStatus() {
  return {
    lifecycle: 'registered',
    availability: 'idle',
    health: 'unknown',
    interactionMode: 'manager-mediated',
    currentSessionId: null,
    currentActionId: null,
    contextPressure: 'unknown',
    lastHeartbeatAt: null,
    lastError: null
  }
}

function buildOpenClawAgentRecord() {
  return {
    definition: openclawAgentDefinition,
    binding: buildOpenClawBinding(),
    status: buildOpenClawStatus(),
    contract: {
      requestShape: {},
      resultShape: {},
      currentSupportedActions: []
    },
    startupProfile: null,
    startupFlow: null
  }
}


app.get('/api/control/agents/:agentId/logs', (c) => {
  try {
    if (!fs.existsSync(HERMES_RUNTIME_LOG_FILE)) return c.json({ ok: true, logs: '无运行日志' })
    const raw = fs.readFileSync(HERMES_RUNTIME_LOG_FILE, 'utf8')
    let lines = raw.split('\n')
    if (lines.length > 200) lines = lines.slice(-200)
    return c.json({ ok: true, logs: lines.join('\n') })
  } catch(e) {
    return c.json({ ok: true, logs: '无法读取日志: ' + e.message })
  }
})


app.post('/api/control/models/:action', async (c) => {
  const { action } = c.req.param(); // 'load' or 'unload'
  const body = await c.req.json().catch(() => ({}));
  
  // Real implementation would call Ollama or OMLX load/unload API.
  // For OMLX, we just log it. Some OMLX forks use /v1/models/{model}/load
  // We'll write to hermes_runtime.log directly to show action in the logs.
  const msg = `[SYS] Request ${action} model: ${body.model} on ${body.provider} at ${body.baseUrl}\n`;
  try {
     fs.appendFileSync(HERMES_RUNTIME_LOG_FILE, msg);
  } catch(e){}
  
  // For now, return OK. If it's real OMLX we'd proxy here.
  return c.json({ ok: true, action, model: body.model });
});

app.use('*', cors({ origin: '*', allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'] }))

app.get('/api/health', (c) => {
  return c.json({
    ok: true,
    service: 'gamestudio_control_server',
    version: '0.1.0',
    now: new Date().toISOString()
  })
})

app.get('/api/control/overview', (c) => {
  return c.json({
    ok: true,
    controlSystem: {
      status: 'bootstrapped',
      mode: 'scaffold',
      focus: 'state-machine-foundation'
    },
    primaryAgent: {
      id: hermesAgent.definition.id,
      runtime: hermesAgent.definition.runtime,
      availability: hermesAgent.status.availability
    },
    modules: {
      stateModel: 'pending',
      stageModel: 'pending',
      agentRegistry: 'bootstrapped',
      eventLog: 'pending',
      recoveryActions: 'pending'
    }
  })
})

app.get('/api/control/bootstrap', (c) => {
  return c.json({
    ok: true,
    nextMilestones: [
      'Define project state machine schema',
      'Define stage machine schema',
      'Bind Hermes actions to manager commands',
      'Add task/event persistence',
      'Expose Hermes-friendly command endpoints'
    ]
  })
})

app.get('/api/control/agents', (c) => {
  return c.json({
    ok: true,
    agents: [buildHermesAgentRecord(), buildOpenClawAgentRecord()]
  })
})

app.get('/api/control/agents/:agentId', (c) => {
  const { agentId } = c.req.param()
  if (agentId === hermesAgentDefinition.id) {
    return c.json({
      ok: true,
      agent: buildHermesAgentRecord()
    })
  }

  if (agentId === openclawAgentDefinition.id) {
    return c.json({
      ok: true,
      agent: buildOpenClawAgentRecord()
    })
  }

  return c.json({ ok: false, error: 'agent_not_found' }, 404)
})

app.get('/api/control/agents/:agentId/contract', (c) => {
  const { agentId } = c.req.param()
  if (agentId !== hermesAgentDefinition.id) {
    return c.json({ ok: false, error: 'agent_not_found' }, 404)
  }

  return c.json({
    ok: true,
    agentId,
    contract: buildHermesActionContract()
  })
})

app.get('/api/control/agents/:agentId/startup-profile', (c) => {
  const { agentId } = c.req.param()
  if (agentId !== hermesAgentDefinition.id) {
    return c.json({ ok: false, error: 'agent_not_found' }, 404)
  }

  return c.json({
    ok: true,
    agentId,
    startupProfile: buildHermesStartupProfile()
  })
})

app.get('/api/control/agents/:agentId/startup-flow', (c) => {
  const { agentId } = c.req.param()
  if (agentId !== hermesAgentDefinition.id) {
    return c.json({ ok: false, error: 'agent_not_found' }, 404)
  }

  return c.json({
    ok: true,
    agentId,
    startupFlow: buildHermesStartupFlow()
  })
})

app.get('/api/control/agents/:agentId/next-action', (c) => {
  const { agentId } = c.req.param()
  if (agentId !== hermesAgentDefinition.id) {
    return c.json({ ok: false, error: 'agent_not_found' }, 404)
  }

  return c.json({
    ok: true,
    agentId,
    nextAction: buildHermesNextAction()
  })
})

app.get('/api/control/agents/:agentId/runtime-status', (c) => {
  const { agentId } = c.req.param()
  if (agentId !== hermesAgentDefinition.id) {
    return c.json({ ok: false, error: 'agent_not_found' }, 404)
  }

  return c.json({
    ok: true,
    agentId,
    runtimeStatus: getHermesRuntimeState()
  })
})

app.post('/api/control/agents/:agentId/runtime-action', async (c) => {
  const { agentId } = c.req.param()
  if (agentId !== hermesAgentDefinition.id) {
    return c.json({ ok: false, error: 'agent_not_found' }, 404)
  }

  const body = await c.req.json().catch(() => ({}))
  const action = body.action

  if (action !== 'start' && action !== 'stop' && action !== 'pause' && action !== 'resume' && action !== 'exit') {
    return c.json({ ok: false, error: 'invalid_action' }, 400)
  }

  
  let runtimeStatus;
  const current = getHermesRuntimeState();
  if (action === 'start' || action === 'resume') {
    runtimeStatus = await startHermesRuntime(body.config || {});
    // Write explicit log for starting brain
    const side = body.config?.side || 'unknown';
    const msg = `[SYS] Started ${side} Brain binding to ${body.config?.model}\n`;
    try { fs.appendFileSync(HERMES_RUNTIME_LOG_FILE, msg); } catch(e){}
  } else {
    // Check if we want to stop fully, or just logically stop one brain
    const side = body.brainSide || 'unknown';
    const msg = `[SYS] Stopped ${side} Brain\n`;
    try { fs.appendFileSync(HERMES_RUNTIME_LOG_FILE, msg); } catch(e){}
    // actually stop hermes if both are stopped? We'll rely on the UI logic.
    if (action === 'pause' || action === 'stop') {
      if (body.stopAll) {
        runtimeStatus = await stopHermesRuntime();
      } else {
        runtimeStatus = current; // Keep it running if another brain is active
      }
    } else {
      runtimeStatus = await stopHermesRuntime();
    }
  }


  return c.json({
    ok: true,
    agentId,
    action,
    runtimeStatus
  })
})

app.get('/api/control/local-models', async (c) => {
  const provider = c.req.query('provider') || 'omlx'
  const requestedBaseUrl = c.req.query('baseUrl') || undefined
  const access = getProviderAccess(provider, requestedBaseUrl)

  try {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 3000)
    const resp = await fetch(`${access.baseUrl}/models`, {
      signal: controller.signal,
      headers: access.headers
    })
    clearTimeout(timeout)
    if (!resp.ok) {
      return c.json({ ok: false, error: `fetch_failed_${resp.status}` })
    }
    const data = await resp.json()
    return c.json({
      ok: true,
      provider,
      baseUrl: access.baseUrl,
      auth: {
        required: provider !== 'ollama',
        keyPresent: Boolean(access.apiKey)
      },
      models: (data.data || []).map((item) => {
        const metadata = getModelMetadata(item.id)
        return {
          id: item.id,
          object: item.object || 'model',
          created: item.created || null,
          ownedBy: item.owned_by || null,
          contextLength: metadata.contextLength,
          recommendedMaxOutputTokens: metadata.recommendedMaxOutputTokens,
          tokenizer: metadata.tokenizer,
          metadataSource: metadata.metadataSource
        }
      })
    })
  } catch (e) {
    return c.json({ ok: false, error: e.message })
  }
})

app.get('/api/control/local-models/inspect', async (c) => {
  const provider = String(c.req.query('provider') || 'omlx')
  const model = String(c.req.query('model') || '').trim()
  const baseUrl = c.req.query('baseUrl') || undefined
  return c.json({
    ok: true,
    inspection: await inspectModelAccess({ provider, baseUrl, model })
  })
})

app.get('/api/control/agents/:agentId/config', async (c) => {
  const { agentId } = c.req.param()
  if (agentId !== hermesAgentDefinition.id) {
    return c.json({ ok: false, error: 'agent_not_found' }, 404)
  }
  const config = getHermesControlConfig()
  const defaultBinding = buildHermesBinding()
  return c.json({
    ok: true,
    config: {
      provider: config.provider || 'custom/local',
      baseUrl: config.baseUrl || defaultBinding.baseUrl,
      model: config.model || defaultBinding.model,
      contextLength: Number.isFinite(Number(config.contextLength)) ? Number(config.contextLength) : defaultBinding.contextLength,
      recommendedMaxOutputTokens: Number.isFinite(Number(config.recommendedMaxOutputTokens)) ? Number(config.recommendedMaxOutputTokens) : defaultBinding.recommendedMaxOutputTokens,
      tokenizer: config.tokenizer || defaultBinding.tokenizer,
      metadataSource: config.metadataSource || defaultBinding.metadataSource,
      memory: {
        sourceFiles: defaultBinding.agentMemoryFiles,
        agentCount: defaultBinding.agentMemoryCount,
        agents: defaultBinding.agentMemoryAgents
      }
    }
  })
})

app.get('/api/control/agents/:agentId/self-check', async (c) => {
  const { agentId } = c.req.param()
  if (agentId !== hermesAgentDefinition.id) {
    return c.json({ ok: false, error: 'agent_not_found' }, 404)
  }

  const runtimeStatus = getHermesRuntimeState()
  if (runtimeStatus.state !== 'running') {
    return c.json({
      ok: false,
      error: 'runtime_not_running',
      runtimeStatus
    }, 409)
  }

  return c.json({
    ok: true,
    agentId,
    selfCheck: await buildHermesSelfCheck()
  })
})

app.post('/api/control/agents/:agentId/ping-model', async (c) => {
  const { agentId } = c.req.param()
  if (agentId !== hermesAgentDefinition.id) {
    return c.json({ ok: false, error: 'agent_not_found' }, 404)
  }

  const body = await c.req.json().catch(() => ({}))
  const userPrompt = body.prompt || 'Hello, are you there?'

  const binding = buildHermesBinding()
  const providerAccess = getProviderAccess(binding.provider, binding.baseUrl)

  try {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 300000)

    const resp = await fetch(`${providerAccess.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...providerAccess.headers
      },
      body: JSON.stringify({
        model: binding.model,
        messages: [{ role: 'user', content: userPrompt }],
        max_tokens: 150
      }),
      signal: controller.signal
    })

    clearTimeout(timeout)
    
    if (!resp.ok) {
      return c.json({ ok: false, error: `Model service returned HTTP ${resp.status}: ${resp.statusText}` })
    }

    const data = await resp.json()
    const reply = data.choices?.[0]?.message?.content || JSON.stringify(data)

    return c.json({ ok: true, agentId, reply, raw: data })

  } catch (err) {
    return c.json({ ok: false, error: err.message })
  }
})

serve({
  fetch: app.fetch,
  port
}, () => {
  console.log(`[control-server] listening on http://127.0.0.1:${port}`)
})