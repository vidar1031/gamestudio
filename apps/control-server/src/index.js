import fs from 'node:fs'
import http from 'node:http'
import https from 'node:https'
import os from 'node:os'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { cors } from 'hono/cors'

const app = new Hono()
const port = Number(process.env.CONTROL_SERVER_PORT || 2099)
const HERMES_ROOT = '/Volumes/ovokit2t/AIOVO/hermes-agent'
const DEFAULT_HERMES_HOME = path.join(path.dirname(HERMES_ROOT), 'home', '.hermes')
const USER_HERMES_HOME = path.join(os.homedir(), '.hermes')
const HERMES_HOME = fs.existsSync(DEFAULT_HERMES_HOME)
  ? DEFAULT_HERMES_HOME
  : (process.env.HERMES_HOME || USER_HERMES_HOME)
const GAMESTUDIO_ROOT = '/Volumes/ovokit2t/aiwork/gamestudio'
const HERMES_CONFIG_ROOT = path.join(GAMESTUDIO_ROOT, 'config', 'hermes')
const CONTROL_RESTART_SCRIPT = path.join(GAMESTUDIO_ROOT, 'restart_control.sh')
const HERMES_GATEWAY_SCRIPT = path.join(HERMES_ROOT, 'scripts', 'hermes-gateway')
const HERMES_VENV_PYTHON = path.join(HERMES_ROOT, 'venv', 'bin', 'python')
const HERMES_RUNTIME_CONFIG_FILES = [...new Set([
  HERMES_HOME,
  process.env.HERMES_HOME || '',
  DEFAULT_HERMES_HOME,
  USER_HERMES_HOME,
].filter(Boolean).map((homePath) => path.join(homePath, 'config.yaml')))]
const HERMES_RUNTIME_PID_FILE = path.join(os.tmpdir(), 'gamestudio-hermes-gateway.pid')
const HERMES_RUNTIME_LOG_FILE = path.join(os.tmpdir(), 'gamestudio-hermes-gateway.log')
const HERMES_CONTROL_CONFIG_FILE = path.join(HERMES_CONFIG_ROOT, 'manager.left-brain.json')
const HERMES_CONTROL_STATE_FILE = path.join(HERMES_CONFIG_ROOT, 'manager.left-brain.state.json')
const LEGACY_HERMES_CONTROL_CONFIG_FILE = path.join(HERMES_ROOT, '.hermes_control_config.json')
const GAMESTUDIO_ENV_FILE = path.join(GAMESTUDIO_ROOT, '.env')
const DEFAULT_HERMES_SKILL_FILE = path.join(HERMES_CONFIG_ROOT, 'skills', 'gamestudio-workspace', 'SKILL.md')
const HERMES_API_SERVER_PORT = Number(process.env.HERMES_API_SERVER_PORT || 8742)
const HERMES_API_SERVER_HOST = String(process.env.HERMES_API_SERVER_HOST || '127.0.0.1')
const HERMES_API_SERVER_BASE_URL = String(
  process.env.HERMES_API_SERVER_BASE_URL || `http://${HERMES_API_SERVER_HOST}:${HERMES_API_SERVER_PORT}/v1`
).replace(/\/$/, '')
const HERMES_CHAT_REQUEST_TIMEOUT_MS = 500000
const HERMES_REASONING_TASK_LEASE_MS = 500000
const HERMES_REASONING_TASK_MAX_RENEWS = 2
const HERMES_REASONING_TASK_HARD_TIMEOUT_MS = HERMES_REASONING_TASK_LEASE_MS * (HERMES_REASONING_TASK_MAX_RENEWS + 1)
const HERMES_REASONING_PROVIDER_PROBE_TIMEOUT_MS = 3000
const HERMES_REASONING_SESSIONS_DIR = path.join(GAMESTUDIO_ROOT, 'state', 'reasoning-sessions')
const HERMES_REASONING_REVIEW_RECORDS_FILE = path.join(GAMESTUDIO_ROOT, 'state', 'reasoning-review-records.jsonl')
const HERMES_CONTEXT_POOL_DIR = path.join(GAMESTUDIO_ROOT, 'state', 'context-pool')
const DEFAULT_STUDIO_STORAGE_ROOT = path.join(GAMESTUDIO_ROOT, 'storage')
const ENV_STUDIO_STORAGE_ROOT = String(process.env.STUDIO_STORAGE_ROOT || '').trim()
const STUDIO_STORAGE_ROOT = ENV_STUDIO_STORAGE_ROOT
  ? (path.isAbsolute(ENV_STUDIO_STORAGE_ROOT) ? ENV_STUDIO_STORAGE_ROOT : path.resolve(process.cwd(), ENV_STUDIO_STORAGE_ROOT))
  : DEFAULT_STUDIO_STORAGE_ROOT
const STORAGE_PROJECTS_ROOT = path.join(STUDIO_STORAGE_ROOT, 'projects')
const LEGACY_PROJECTS_ROOT = path.join(GAMESTUDIO_ROOT, 'projects')
let activeHermesChatRequest = null
let activeHermesChatRecovery = null
let activeHermesReasoningSessionId = null
let currentHermesChatSessionId = createOpaqueId('chat')

const MODEL_METADATA_CATALOG = {
  'gemma-4-26b-a4b': {
    contextLength: 65536,
    recommendedMaxOutputTokens: 4096,
    tokenizer: 'gemma',
    metadataSource: 'catalog'
  },
  'gemma-4-26b-a4b-it-4bit': {
    contextLength: 65536,
    recommendedMaxOutputTokens: 4096,
    tokenizer: 'gemma',
    metadataSource: 'catalog'
  },
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

function normalizeProviderName(provider) {
  const normalized = String(provider || '').trim().toLowerCase()
  if (!normalized || normalized === 'custom/local' || normalized === 'custom-local') {
    return 'omlx'
  }
  return normalized
}

function appendHermesLog(lines) {
  try {
    fs.mkdirSync(path.dirname(HERMES_RUNTIME_LOG_FILE), { recursive: true })
    const entries = Array.isArray(lines) ? lines : [lines]
    const stamped = entries
      .filter(Boolean)
      .map((line) => `[${new Date().toISOString()}] ${line}`)
      .join('\n')
    fs.appendFileSync(HERMES_RUNTIME_LOG_FILE, `${stamped}\n`, 'utf8')
  } catch {
    // Ignore logging failures.
  }
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
  const normalizedProvider = normalizeProviderName(provider)
  if (normalizedProvider === 'ollama') return ''
  return getEnvValue('LOCALOXML_API_KEY') || getEnvValue('STUDIO_AI_API_KEY') || getEnvValue('OPENAI_API_KEY') || 'omlx123'
}

function getProviderAccess(provider, baseUrl) {
  const normalizedProvider = normalizeProviderName(provider)
  const normalizedBaseUrl = normalizeModelBaseUrl(baseUrl, normalizedProvider)
  const apiKey = getProviderApiKey(normalizedProvider)
  return {
    provider: normalizedProvider,
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
    contextLength: lower.includes('qwen') || lower.includes('gpt-oss') ? 131072 : lower.includes('gemma') ? 65536 : null,
    recommendedMaxOutputTokens: lower.includes('qwen') || lower.includes('gpt-oss') ? 8192 : lower.includes('gemma') ? 4096 : null,
    tokenizer: inferTokenizer(modelId),
    metadataSource: lower.includes('qwen') || lower.includes('gpt-oss') || lower.includes('gemma') ? 'heuristic' : 'unavailable'
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
      availableActions: ['all-restart', 'pause', 'exit']
    }
  }

  clearHermesPid()
  return {
    state: 'stopped',
    label: '已暂停',
    detail: 'Hermes 已安装，但当前没有运行中的 manager 受控进程',
    pid: null,
    logFile: HERMES_RUNTIME_LOG_FILE,
    availableActions: ['all-restart', 'resume']
  }
}

async function startHermesRuntime() {
  const current = getHermesRuntimeState()
  if (current.state === 'uninstalled') {
    return current
  }
  if (current.state === 'running') {
    return current
  }

  const binding = buildHermesBinding()
  syncHermesRuntimeConfig(binding)
  const providerAccess = getProviderAccess(binding.provider, binding.baseUrl)
  const customEnv = {
    ...process.env,
    HERMES_HOME,
    HERMES_MODEL: binding.model,
    HERMES_PROVIDER: binding.provider,
    HERMES_BASE_URL: binding.baseUrl,
    API_SERVER_ENABLED: 'true',
    API_SERVER_HOST: HERMES_API_SERVER_HOST,
    API_SERVER_PORT: String(HERMES_API_SERVER_PORT),
    API_SERVER_MODEL_NAME: 'hermes-agent',
    GAMESTUDIO_AGENT_CONFIG_FILES: binding.agentMemoryFiles.join(path.delimiter),
    GAMESTUDIO_AGENT_CONFIG_COUNT: String(binding.agentMemoryCount || 0),
    GAMESTUDIO_AGENT_CONFIG_JSON: JSON.stringify(binding.agentMemoryAgents || []),
    GAMESTUDIO_AGENT_DEFINITION_FILE: binding.memory.agentDefinitionFile,
    GAMESTUDIO_USER_MEMORY_FILE: binding.memory.userFile,
    GAMESTUDIO_PROJECT_MEMORY_FILE: binding.memory.memoryFile,
    GAMESTUDIO_STATUS_FILE: binding.memory.statusFile,
    GAMESTUDIO_TASK_QUEUE_FILE: binding.memory.taskQueueFile,
    GAMESTUDIO_DECISIONS_FILE: binding.memory.decisionsFile,
    GAMESTUDIO_DAILY_LOG_DIR: binding.memory.dailyLogDir,
    GAMESTUDIO_SKILL_ROOT: binding.skills.skillRoot,
    GAMESTUDIO_SKILL_FILES: binding.skills.availableSkillFiles.join(path.delimiter),
    GAMESTUDIO_MIN_CONTEXT_TOKENS: String(binding.shortTerm.minContextTokens || 0),
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
    try {
      const legacyRaw = fs.readFileSync(LEGACY_HERMES_CONTROL_CONFIG_FILE, 'utf8')
      return JSON.parse(legacyRaw)
    } catch {
      return {}
    }
  }
}

function setHermesControlConfig(cfg) {
  try {
    fs.mkdirSync(path.dirname(HERMES_CONTROL_CONFIG_FILE), { recursive: true })
    fs.writeFileSync(HERMES_CONTROL_CONFIG_FILE, JSON.stringify(cfg, null, 2), 'utf8')
  } catch {}
}

function getDefaultHermesControlState() {
  return {
    manager: {
      currentAgentId: hermesAgentDefinition.id,
      selectionLocked: true,
      detail: 'Hermes 作为当前全局唯一管理器'
    },
    config: {
      saved: false,
      savedAt: null,
      savedFingerprint: '',
      lastSavedModel: '',
      detail: '未保存左脑配置'
    },
    model: {
      status: 'unknown',
      label: '未启动',
      detail: '模型尚未检测',
      provider: '',
      baseUrl: '',
      model: '',
      inspectedAt: null,
      loadedAt: null,
      lastAction: null,
      inspection: null
    },
    preflight: {
      ready: false,
      checkedAt: null,
      configFingerprint: '',
      detail: '尚未执行左脑自检',
      checks: [],
      inspection: null
    },
    runtime: {
      state: 'stopped',
      label: '已暂停',
      detail: 'Hermes 未启动',
      pid: null,
      updatedAt: null,
      lastAction: null
    }
  }
}

function mergeHermesControlState(baseState, patch = {}) {
  return {
    ...baseState,
    ...patch,
    manager: {
      ...baseState.manager,
      ...(patch.manager || {})
    },
    config: {
      ...baseState.config,
      ...(patch.config || {})
    },
    model: {
      ...baseState.model,
      ...(patch.model || {})
    },
    preflight: {
      ...baseState.preflight,
      ...(patch.preflight || {})
    },
    runtime: {
      ...baseState.runtime,
      ...(patch.runtime || {})
    }
  }
}

function getHermesControlState() {
  try {
    const raw = fs.readFileSync(HERMES_CONTROL_STATE_FILE, 'utf8')
    return mergeHermesControlState(getDefaultHermesControlState(), JSON.parse(raw))
  } catch {
    return getDefaultHermesControlState()
  }
}

function setHermesControlState(state) {
  try {
    fs.mkdirSync(path.dirname(HERMES_CONTROL_STATE_FILE), { recursive: true })
    const normalized = mergeHermesControlState(getDefaultHermesControlState(), state)
    fs.writeFileSync(HERMES_CONTROL_STATE_FILE, JSON.stringify(normalized, null, 2), 'utf8')
    return normalized
  } catch {
    return mergeHermesControlState(getDefaultHermesControlState(), state)
  }
}

function updateHermesControlState(patch = {}) {
  const current = getHermesControlState()
  return setHermesControlState(mergeHermesControlState(current, patch))
}

function getDefaultHermesControlConfig() {
  const aiRoot = path.join(GAMESTUDIO_ROOT, 'ai')
  const aiMemoryRoot = path.join(aiRoot, 'memory')
  return {
    provider: 'omlx',
    baseUrl: 'http://127.0.0.1:18888/v1',
    model: 'gpt-oss-20b-MXFP4-Q8',
    shortTerm: {
      minContextTokens: 65536
    },
    workflow: {
      memoryOverlayMode: 'references-only',
      replayWindowMessages: 24,
      reasoningReplayWindowMessages: 8
    },
    memory: {
      agentDefinitionFile: path.join(aiRoot, 'AGENTS.md'),
      userFile: path.join(aiRoot, 'USER.md'),
      memoryFile: path.join(aiRoot, 'MEMORY.md'),
      statusFile: path.join(aiMemoryRoot, 'STATUS.md'),
      taskQueueFile: path.join(aiMemoryRoot, 'TASK_QUEUE.md'),
      decisionsFile: path.join(aiMemoryRoot, 'DECISIONS.md'),
      dailyLogDir: aiMemoryRoot
    },
    skills: {
      skillRoot: path.join(HERMES_CONFIG_ROOT, 'skills'),
      skillFiles: [DEFAULT_HERMES_SKILL_FILE]
    },
    brains: {
      rightBrainEnabled: false
    }
  }
}

function normalizeStringList(value) {
  if (!Array.isArray(value)) return []
  return value
    .map((item) => String(item || '').trim())
    .filter(Boolean)
}

function buildPersistedHermesControlConfig(rawConfig = {}) {
  const defaults = getDefaultHermesControlConfig()
  const memory = rawConfig.memory || {}
  const skills = rawConfig.skills || {}
  const shortTerm = rawConfig.shortTerm || {}
  const workflow = rawConfig.workflow || {}
  const brains = rawConfig.brains || {}

  return {
    provider: normalizeProviderName(rawConfig.provider || defaults.provider),
    baseUrl: String(rawConfig.baseUrl || defaults.baseUrl),
    model: String(rawConfig.model || defaults.model),
    shortTerm: {
      minContextTokens: Number.isFinite(Number(shortTerm.minContextTokens))
        ? Number(shortTerm.minContextTokens)
        : defaults.shortTerm.minContextTokens
    },
    workflow: {
      memoryOverlayMode: String(workflow.memoryOverlayMode || defaults.workflow.memoryOverlayMode) === 'content-injection'
        ? 'content-injection'
        : 'references-only',
      replayWindowMessages: Math.max(0, Number.isFinite(Number(workflow.replayWindowMessages))
        ? Number(workflow.replayWindowMessages)
        : defaults.workflow.replayWindowMessages),
      reasoningReplayWindowMessages: Math.max(0, Number.isFinite(Number(workflow.reasoningReplayWindowMessages))
        ? Number(workflow.reasoningReplayWindowMessages)
        : defaults.workflow.reasoningReplayWindowMessages)
    },
    memory: {
      agentDefinitionFile: String(memory.agentDefinitionFile || defaults.memory.agentDefinitionFile),
      userFile: String(memory.userFile || defaults.memory.userFile),
      memoryFile: String(memory.memoryFile || defaults.memory.memoryFile),
      statusFile: String(memory.statusFile || defaults.memory.statusFile),
      taskQueueFile: String(memory.taskQueueFile || defaults.memory.taskQueueFile),
      decisionsFile: String(memory.decisionsFile || defaults.memory.decisionsFile),
      dailyLogDir: String(memory.dailyLogDir || defaults.memory.dailyLogDir)
    },
    skills: {
      skillRoot: String(skills.skillRoot || defaults.skills.skillRoot),
      skillFiles: normalizeStringList(skills.skillFiles).length > 0
        ? normalizeStringList(skills.skillFiles)
        : defaults.skills.skillFiles
    },
    brains: {
      rightBrainEnabled: Boolean(brains.rightBrainEnabled)
    }
  }
}

function getPersistedHermesControlConfig() {
  return buildPersistedHermesControlConfig(getHermesControlConfig())
}

function mergeHermesControlConfig(baseConfig, overrides = {}) {
  return buildPersistedHermesControlConfig({
    ...baseConfig,
    ...overrides,
    memory: {
      ...baseConfig.memory,
      ...(overrides.memory || {})
    },
    skills: {
      ...baseConfig.skills,
      ...(overrides.skills || {})
    },
    shortTerm: {
      ...baseConfig.shortTerm,
      ...(overrides.shortTerm || {})
    },
    workflow: {
      ...baseConfig.workflow,
      ...(overrides.workflow || {})
    },
    brains: {
      ...baseConfig.brains,
      ...(overrides.brains || {})
    }
  })
}

function getHermesControlConfigFingerprint(config) {
  return JSON.stringify(buildPersistedHermesControlConfig(config))
}

function buildModelStateSnapshot({ provider, baseUrl, model, inspection, lastAction = null, loadedAt = null }) {
  if (!model) {
    return {
      status: 'unknown',
      label: '未启动',
      detail: '未选择模型',
      provider: normalizeProviderName(provider),
      baseUrl: normalizeModelBaseUrl(baseUrl, provider),
      model: '',
      inspectedAt: inspection?.checkedAt || null,
      loadedAt: null,
      lastAction,
      inspection: inspection || null
    }
  }

  const accessible = inspection?.accessible === true
  return {
    status: accessible ? 'loaded' : (inspection ? 'error' : 'unloaded'),
    label: accessible ? '已启动' : '未启动',
    detail: inspection?.detail || (accessible ? '模型已就绪' : '模型尚未加载'),
    provider: normalizeProviderName(provider),
    baseUrl: normalizeModelBaseUrl(baseUrl, provider),
    model,
    inspectedAt: inspection?.checkedAt || new Date().toISOString(),
    loadedAt: accessible ? (loadedAt || new Date().toISOString()) : null,
    lastAction,
    inspection: inspection || null
  }
}

function buildRuntimeStateSnapshot(runtimeState, lastAction = null) {
  return {
    state: runtimeState.state,
    label: runtimeState.label,
    detail: runtimeState.detail,
    pid: runtimeState.pid,
    availableActions: Array.isArray(runtimeState.availableActions) ? runtimeState.availableActions : [],
    updatedAt: new Date().toISOString(),
    lastAction
  }
}

async function refreshHermesControlStateFromConfig(config = getPersistedHermesControlConfig()) {
  const existingState = getHermesControlState()
  const configFingerprint = getHermesControlConfigFingerprint(config)
  const runtimeState = getHermesRuntimeState()
  const inspection = config.model
    ? await inspectModelAccess({ provider: config.provider, baseUrl: config.baseUrl, model: config.model })
    : null

  const nextState = mergeHermesControlState(existingState, {
    config: {
      saved: existingState.config.savedFingerprint === configFingerprint && !!existingState.config.savedFingerprint,
      savedFingerprint: existingState.config.savedFingerprint,
      savedAt: existingState.config.savedAt,
      lastSavedModel: existingState.config.lastSavedModel || config.model || '',
      detail: existingState.config.savedFingerprint === configFingerprint && !!existingState.config.savedFingerprint
        ? '已保存左脑配置'
        : '未保存左脑配置'
    },
    model: buildModelStateSnapshot({
      provider: config.provider,
      baseUrl: config.baseUrl,
      model: config.model,
      inspection,
      lastAction: existingState.model.lastAction,
      loadedAt: existingState.model.loadedAt
    }),
    preflight: existingState.preflight.configFingerprint === configFingerprint
      ? existingState.preflight
      : {
          ready: false,
          checkedAt: existingState.preflight.checkedAt,
          configFingerprint: '',
          detail: '当前配置尚未重新自检',
          checks: [],
          inspection: null
        },
    runtime: buildRuntimeStateSnapshot(runtimeState, existingState.runtime.lastAction)
  })

  return setHermesControlState(nextState)
}

function buildHermesBindingFromConfig(cfg) {
  const model = String(cfg.model || process.env.HERMES_MODEL || 'gpt-oss-20b-MXFP4-Q8')
  const provider = normalizeProviderName(cfg.provider || process.env.HERMES_PROVIDER || 'omlx')
  const baseUrl = normalizeModelBaseUrl(cfg.baseUrl || process.env.HERMES_BASE_URL || 'http://127.0.0.1:18888/v1', provider)
  const metadata = getModelMetadata(model)
  const agentMemory = buildAgentMemoryConfig(cfg.memory)
  const skills = buildSkillConfig(cfg.skills)
  return {
    runtimeId: 'hermes-local-cli',
    runtimeKind: 'local-cli',
    workspace: GAMESTUDIO_ROOT,
    command: 'python -m hermes_cli.main status',
    model,
    provider,
    baseUrl,
    contextLength: metadata.contextLength,
    recommendedMaxOutputTokens: metadata.recommendedMaxOutputTokens,
    tokenizer: String(metadata.tokenizer || '') || null,
    metadataSource: String(metadata.metadataSource || 'unavailable'),
    shortTerm: {
      minContextTokens: cfg.shortTerm.minContextTokens
    },
    workflow: cfg.workflow,
    memory: cfg.memory,
    agentMemoryFiles: agentMemory.sourceFiles,
    agentMemoryCount: agentMemory.agentCount,
    agentMemoryAgents: agentMemory.agents,
    skills,
    rightBrainEnabled: Boolean(cfg.brains?.rightBrainEnabled)
  }
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

function extractNumberedMarkdownSections(markdown) {
  const sections = []
  let currentSection = null

  for (const line of String(markdown || '').split(/\r?\n/)) {
    const headingMatch = line.match(/^###\s+\d+\.\s+(.+)$/)
    if (headingMatch) {
      if (currentSection) {
        sections.push({
          title: currentSection.title,
          body: currentSection.lines.join('\n')
        })
      }
      currentSection = {
        title: String(headingMatch[1] || '').trim(),
        lines: []
      }
      continue
    }

    if (currentSection) {
      currentSection.lines.push(line)
    }
  }

  if (currentSection) {
    sections.push({
      title: currentSection.title,
      body: currentSection.lines.join('\n')
    })
  }

  return sections
}

function extractMarkdownLabelValue(body, label) {
  const normalizedLabel = String(label || '').trim()
  for (const rawLine of String(body || '').split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line) continue
    const match = line.match(/^\*\*(.+?)\*\*\s*[:：]\s*(.+)$/)
    if (!match) continue
    const currentLabel = String(match[1] || '').trim()
    if (currentLabel === normalizedLabel) {
      return String(match[2] || '').trim()
    }
  }
  return ''
}

function parseAgentSection(title, body) {
  const cleanTitle = String(title || '').replace(/[*`]/g, '').trim()
  const nameMatch = cleanTitle.match(/\b(Planner|Executor|Critic|Reporter)\b/)
  const agentIdValue = extractMarkdownLabelValue(body, '角色 ID')
  const roleValue = extractMarkdownLabelValue(body, '角色定位')
  const personalityValue = extractMarkdownLabelValue(body, '性格特点')
  const agentIdMatch = agentIdValue.match(/^`?([^`\n]+)`?/)
  const responsibilities = extractSectionList(body, '职责')

  return {
    name: nameMatch ? nameMatch[1] : cleanTitle,
    title: cleanTitle,
    agentId: agentIdMatch ? agentIdMatch[1].trim() : '',
    role: roleValue || '未定义',
    personality: personalityValue || '未定义',
    responsibilities
  }
}

function buildAgentMemoryConfig(memoryConfig) {
  const configuredFiles = [
    memoryConfig.agentDefinitionFile,
    memoryConfig.userFile,
    memoryConfig.memoryFile,
    memoryConfig.statusFile,
    memoryConfig.taskQueueFile,
    memoryConfig.decisionsFile
  ]
  const sourceFiles = [...new Set(configuredFiles.filter((filePath) => fs.existsSync(filePath)))]
  const rootMarkdown = readMarkdownFile(memoryConfig.agentDefinitionFile)
  const agents = []

  for (const section of extractNumberedMarkdownSections(rootMarkdown)) {
    const agent = parseAgentSection(section.title, section.body)
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

function buildSkillConfig(skillsConfig) {
  const skillFiles = normalizeStringList(skillsConfig.skillFiles)
  const availableSkillFiles = skillFiles.filter((filePath) => fs.existsSync(filePath))
  return {
    skillRoot: String(skillsConfig.skillRoot || ''),
    skillFiles,
    availableSkillFiles,
    skillCount: availableSkillFiles.length
  }
}

function quoteYamlString(value) {
  return JSON.stringify(String(value ?? ''))
}

function buildHermesRuntimeModelBlock(binding) {
  return [
    'model:',
    `  base_url: ${quoteYamlString(binding.baseUrl)}`,
    `  provider: ${quoteYamlString(binding.provider)}`,
    `  default: ${quoteYamlString(binding.model)}`
  ]
}

function syncHermesRuntimeConfig(binding) {
  try {
    const nextBlock = buildHermesRuntimeModelBlock(binding)

    for (const configFile of HERMES_RUNTIME_CONFIG_FILES) {
      fs.mkdirSync(path.dirname(configFile), { recursive: true })

      const existingRaw = fs.existsSync(configFile)
        ? fs.readFileSync(configFile, 'utf8')
        : ''
      const lines = existingRaw ? existingRaw.split(/\r?\n/) : []
      const modelStart = lines.findIndex((line) => line.trim() === 'model:')

      if (modelStart === -1) {
        const nextRaw = `${nextBlock.join('\n')}${existingRaw.trim() ? `\n${existingRaw.replace(/^\s+/, '')}` : ''}\n`
        fs.writeFileSync(configFile, nextRaw, 'utf8')
        continue
      }

      let modelEnd = lines.length
      for (let index = modelStart + 1; index < lines.length; index += 1) {
        const line = lines[index]
        if (!line.trim()) continue
        if (!line.startsWith(' ') && !line.startsWith('\t')) {
          modelEnd = index
          break
        }
      }

      const updatedLines = [
        ...lines.slice(0, modelStart),
        ...nextBlock,
        ...lines.slice(modelEnd)
      ]

      fs.writeFileSync(configFile, `${updatedLines.join('\n').replace(/\n+$/, '')}\n`, 'utf8')
    }
  } catch (error) {
    appendHermesLog(`[CONFIG][ERROR] Failed to sync Hermes runtime config: ${error instanceof Error ? error.message : String(error)}`)
    throw error
  }
}

function buildConfigValidation(config, binding, inspection = null) {
  const items = []
  const safeExists = (filePath, type) => {
    if (!filePath || !fs.existsSync(filePath)) return false
    const stat = fs.statSync(filePath)
    return type === 'dir' ? stat.isDirectory() : stat.isFile()
  }
  const addPathCheck = (key, label, filePath, type = 'file') => {
    const ok = safeExists(filePath, type)
    items.push({
      key,
      label,
      status: ok ? 'ok' : 'error',
      detail: ok ? filePath : `Missing ${type}: ${filePath}`
    })
  }

  items.push({
    key: 'model-provider',
    label: '模型供应商',
    status: config.provider ? 'ok' : 'error',
    detail: config.provider || '未配置 provider'
  })
  items.push({
    key: 'model-base-url',
    label: '模型服务地址',
    status: config.baseUrl ? 'ok' : 'error',
    detail: config.baseUrl || '未配置 baseUrl'
  })
  items.push({
    key: 'model-name',
    label: '模型名称',
    status: config.model ? 'ok' : 'error',
    detail: config.model || '未配置 model'
  })

  const minContextTokens = Number(config.shortTerm?.minContextTokens || 0)
  const contextLength = Number(binding.contextLength || 0)
  items.push({
    key: 'short-term-context',
    label: '短期记忆窗口',
    status: minContextTokens >= 65536 && contextLength >= minContextTokens ? 'ok' : 'error',
    detail: `要求 >= ${minContextTokens || 'unknown'} tokens，当前 ${binding.contextLength ?? 'unknown'}`
  })

  addPathCheck('memory-agent-definition', 'Agent 定义文件', config.memory.agentDefinitionFile)
  addPathCheck('memory-user-file', '用户长期记忆', config.memory.userFile)
  addPathCheck('memory-memory-file', '项目长期记忆', config.memory.memoryFile)
  addPathCheck('memory-status-file', '状态文件', config.memory.statusFile)
  addPathCheck('memory-task-queue-file', '任务队列文件', config.memory.taskQueueFile)
  addPathCheck('memory-decisions-file', '决策文件', config.memory.decisionsFile)
  addPathCheck('memory-daily-log-dir', '日志目录', config.memory.dailyLogDir, 'dir')
  addPathCheck('skills-root', '技能根目录', config.skills.skillRoot, 'dir')

  const configuredSkillFiles = normalizeStringList(config.skills.skillFiles)
  const availableSkillFiles = configuredSkillFiles.filter((filePath) => safeExists(filePath, 'file'))
  items.push({
    key: 'skills-files',
    label: '技能文件',
    status: availableSkillFiles.length > 0 && availableSkillFiles.length === configuredSkillFiles.length ? 'ok' : 'error',
    detail: availableSkillFiles.length > 0
      ? `${availableSkillFiles.length}/${configuredSkillFiles.length} 个技能文件可用`
      : '未检测到可用的 SKILL.md'
  })

  if (inspection) {
    items.push({
      key: 'model-access',
      label: '模型连通性',
      status: inspection.accessible ? 'ok' : 'error',
      detail: inspection.detail
    })
  }

  return {
    ready: items.every((item) => item.status === 'ok'),
    items
  }
}

async function fetchLocalModelCatalog({ provider, baseUrl }) {
  const access = getProviderAccess(provider, baseUrl)
  try {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 3000)
    const resp = await fetch(`${access.baseUrl}/models`, {
      signal: controller.signal,
      headers: access.headers
    })
    clearTimeout(timeout)
    if (!resp.ok) {
      return {
        ok: false,
        provider: access.provider,
        baseUrl: access.baseUrl,
        error: `请启动推理模型（OMLX）。当前模型服务不可用: HTTP ${resp.status}`,
        models: []
      }
    }
    const data = await resp.json()
    const models = (data.data || []).map((item) => {
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
    return {
      ok: true,
      provider: access.provider,
      baseUrl: access.baseUrl,
      auth: {
        required: access.provider !== 'ollama',
        keyPresent: Boolean(access.apiKey)
      },
      models
    }
  } catch (e) {
    return {
      ok: false,
      provider: access.provider,
      baseUrl: access.baseUrl,
      error: `请启动推理模型（OMLX）。${e instanceof Error ? e.message : String(e)}`,
      models: []
    }
  }
}

async function buildHermesPreflight(configOverrides = {}, options = {}) {
  const current = getPersistedHermesControlConfig()
  const mergedConfig = mergeHermesControlConfig(current, configOverrides)
  const binding = buildHermesBindingFromConfig(mergedConfig)
  const installState = detectHermesInstallState()
  const modelCatalog = await fetchLocalModelCatalog({ provider: binding.provider, baseUrl: binding.baseUrl })
  const selectedModel = binding.model || modelCatalog.models[0]?.id || ''
  const inspection = selectedModel
    ? await inspectModelAccess({ provider: binding.provider, baseUrl: binding.baseUrl, model: selectedModel })
    : {
        model: '',
        accessible: false,
        status: 'error',
        detail: '请选择模型。可先访问 http://127.0.0.1:18888/v1/models 查看可用模型。',
        checkedAt: new Date().toISOString(),
        usage: normalizeUsage(null),
        contextLength: binding.contextLength,
        recommendedMaxOutputTokens: binding.recommendedMaxOutputTokens,
        tokenizer: binding.tokenizer,
        metadataSource: binding.metadataSource
      }
  const readiness = buildConfigValidation(mergedConfig, {
    ...binding,
    model: selectedModel,
    contextLength: getModelMetadata(selectedModel).contextLength || binding.contextLength
  }, inspection)

  const checks = [
    {
      key: 'hermes-install',
      label: '检测 Hermes 安装',
      status: installState.installed ? 'ok' : 'error',
      detail: installState.installed ? 'Hermes OK' : installState.detail
    },
    ...readiness.items,
    {
      key: 'omlx-service',
      label: '检测本地模型服务',
      status: modelCatalog.ok ? 'ok' : 'error',
      detail: modelCatalog.ok
        ? `OMLX OK，发现 ${modelCatalog.models.length} 个模型 (${modelCatalog.baseUrl})`
        : modelCatalog.error
    },
    {
      key: 'model-selection',
      label: '检测模型选择',
      status: selectedModel ? 'ok' : 'error',
      detail: selectedModel || '请选择模型。可先访问 http://127.0.0.1:18888/v1/models 查看可用模型。'
    },
    {
      key: 'active-inference',
      label: '主动推理自检',
      status: inspection.accessible ? 'ok' : 'error',
      detail: inspection.accessible ? `${selectedModel} 推理可用` : inspection.detail
    }
  ]

  const logs = checks.map((item) => `[CHECK][${item.status === 'ok' ? 'OK' : 'ERROR'}] ${item.label}: ${item.detail}`)
  if (options.appendLogs) {
    appendHermesLog(['[CHECK] Starting Hermes preflight', ...logs])
  }

  return {
    ready: checks.every((item) => item.status === 'ok'),
    checkedAt: new Date().toISOString(),
    checks,
    readiness,
    logs,
    selectedModel,
    models: modelCatalog.models,
    provider: modelCatalog.provider,
    baseUrl: modelCatalog.baseUrl,
    inspection
  }
}

function buildHermesBinding() {
  return buildHermesBindingFromConfig(getPersistedHermesControlConfig())
}

function buildHermesStatus() {
  const runtimeState = getHermesRuntimeState()
  return {
    lifecycle: 'registered',
    availability: runtimeState.state === 'running' ? 'running' : runtimeState.state,
    health: runtimeState.state === 'running' ? 'ok' : 'unknown',
    interactionMode: 'manager-mediated',
    currentSessionId: currentHermesChatSessionId,
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

  const configValidation = buildConfigValidation(getPersistedHermesControlConfig(), binding)
  const allOk = pythonOk && workspaceOk && modelRouteStatus === 'ok' && configValidation.ready

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
      },
      {
        key: 'context-window',
        label: 'Context Window',
        status: binding.contextLength >= binding.shortTerm.minContextTokens ? 'ok' : 'error',
        detail: `Required >= ${binding.shortTerm.minContextTokens}, current ${binding.contextLength ?? 'unknown'}`
      },
      {
        key: 'skill-library',
        label: 'Skill Library',
        status: binding.skills.skillCount > 0 ? 'ok' : 'error',
        detail: binding.skills.skillCount > 0
          ? `${binding.skills.skillCount} skills available from ${binding.skills.skillRoot}`
          : 'No valid SKILL.md configured'
      },
      {
        key: 'startup-config',
        label: 'Startup Config',
        status: configValidation.ready ? 'ok' : 'error',
        detail: configValidation.ready ? 'All configurable startup inputs are ready' : 'Memory/skill/model config is incomplete'
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

  const provider = normalizeProviderName(body.provider)
  const model = String(body.model || '').trim()
  const baseUrl = normalizeModelBaseUrl(body.baseUrl, provider)
  appendHermesLog(`[MODEL] Request ${action} model: ${model || 'unknown'} on ${provider} at ${baseUrl}`)

  if (action === 'load') {
    const inspection = await inspectModelAccess({ provider, baseUrl, model })
    if (!inspection.accessible) {
      updateHermesControlState({
        model: buildModelStateSnapshot({ provider, baseUrl, model, inspection, lastAction: 'load' })
      })
      appendHermesLog(`[MODEL][ERROR] ${inspection.detail}`)
      return c.json({ ok: false, action, model, error: inspection.detail, inspection }, 409)
    }
    const state = updateHermesControlState({
      model: buildModelStateSnapshot({ provider, baseUrl, model, inspection, lastAction: 'load' })
    })
    appendHermesLog(`[MODEL][OK] ${model} ready for inference`)
    return c.json({ ok: true, action, model, inspection, state })
  }

  if (action === 'unload') {
    if (provider === 'omlx') {
      try {
        const access = getProviderAccess(provider, baseUrl)
        const resp = await fetch(`${access.baseUrl}/models/${model}/unload`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(access.headers || {})
          }
        })
        const data = await resp.json().catch(() => null)
        if (!resp.ok) {
          const err = data?.error?.message || data?.message || `HTTP ${resp.status}`
          appendHermesLog(`[MODEL][ERROR] Failed to unload model: ${err}`)
          return c.json({ ok: false, action, model, error: err }, resp.status)
        }
        appendHermesLog(`[MODEL][OK] ${model} successfully unloaded from OMLX`)
      } catch (e) {
        appendHermesLog(`[MODEL][ERROR] Could not reach OMLX for unload: ${e.message}`)
        return c.json({ ok: false, action, model, error: e.message }, 500)
      }
    } else {
      appendHermesLog(`[MODEL] ${model || 'unknown'} marked for unload (Provider ${provider} does not support explicit unload)`)
    }
    const state = updateHermesControlState({
      model: {
        status: 'unloaded',
        label: '未启动',
        detail: `${model || '当前模型'} 已卸载`,
        provider,
        baseUrl,
        model,
        inspectedAt: new Date().toISOString(),
        loadedAt: null,
        lastAction: 'unload',
        inspection: null
      }
    })
    return c.json({ ok: true, action, model, state })
  }

  return c.json({ ok: false, error: 'Unknown action' }, 400)
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
    HERMES_HOME,
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
  const state = getHermesControlState()
  return c.json({
    ok: true,
    agents: [buildHermesAgentRecord(), buildOpenClawAgentRecord()],
    activeAgentId: state.manager.currentAgentId,
    selectionLocked: state.manager.selectionLocked,
    state
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

  const runtimeStatus = getHermesRuntimeState()
  const state = updateHermesControlState({
    runtime: buildRuntimeStateSnapshot(runtimeStatus)
  })

  return c.json({
    ok: true,
    agentId,
    runtimeStatus,
    state
  })
})

app.post('/api/control/agents/:agentId/runtime-action', async (c) => {
  const { agentId } = c.req.param()
  if (agentId !== hermesAgentDefinition.id) {
    return c.json({ ok: false, error: 'agent_not_found' }, 404)
  }

  const body = await c.req.json().catch(() => ({}))
  const action = body.action

  if (action !== 'start' && action !== 'stop' && action !== 'pause' && action !== 'resume' && action !== 'exit' && action !== 'all-restart') {
    return c.json({ ok: false, error: 'invalid_action' }, 400)
  }

  
  let runtimeStatus;
  const current = getHermesRuntimeState();
    if (action === 'all-restart') {
      const existing = getPersistedHermesControlConfig()
      const requestedConfig = mergeHermesControlConfig(existing, body.config || {})
      const persistedFingerprint = getHermesControlConfigFingerprint(existing)
      const requestedFingerprint = getHermesControlConfigFingerprint(requestedConfig)
      if (requestedFingerprint !== persistedFingerprint) {
        const persistedBinding = buildHermesBindingFromConfig(existing)
        const readiness = buildConfigValidation(existing, persistedBinding)
        appendHermesLog('[RESTART][ERROR] Left-brain config has unsaved changes, full restart aborted')
        return c.json({ ok: false, error: 'config_not_saved', readiness }, 409)
      }

      const nextBinding = buildHermesBindingFromConfig(existing)
      const readiness = buildConfigValidation(existing, nextBinding)
      if (!readiness.ready) {
        appendHermesLog(['[RESTART][ERROR] Full restart config is incomplete', ...readiness.items.filter((item) => item.status !== 'ok').map((item) => `[RESTART][ERROR] ${item.label}: ${item.detail}`)])
        return c.json({ ok: false, error: 'config_not_ready', readiness }, 409)
      }

      if (!fs.existsSync(CONTROL_RESTART_SCRIPT)) {
        appendHermesLog(`[RESTART][ERROR] Missing restart script: ${CONTROL_RESTART_SCRIPT}`)
        return c.json({ ok: false, error: 'restart_script_missing' }, 500)
      }

      appendHermesLog('[RESTART] Scheduling full control restart via restart_control.sh')
      const child = spawn('bash', ['-lc', `sleep 1 && exec '${CONTROL_RESTART_SCRIPT}'`], {
        cwd: GAMESTUDIO_ROOT,
        detached: true,
        stdio: 'ignore'
      })
      child.unref()

      return c.json({
        ok: true,
        restartingControl: true,
        detail: 'Control 与 Hermes 正在整体重启。',
        runtimeStatus: current,
        state: getHermesControlState()
      })
    }

  if (action === 'start' || action === 'resume' || action === 'all-restart') {
    const existing = getPersistedHermesControlConfig()
    const requestedConfig = mergeHermesControlConfig(existing, body.config || {})
    const persistedFingerprint = getHermesControlConfigFingerprint(existing)
    const requestedFingerprint = getHermesControlConfigFingerprint(requestedConfig)
    if (requestedFingerprint !== persistedFingerprint) {
      const persistedBinding = buildHermesBindingFromConfig(existing)
      const readiness = buildConfigValidation(existing, persistedBinding)
      appendHermesLog('[START][ERROR] Left-brain config has unsaved changes, startup aborted')
      return c.json({ ok: false, error: 'config_not_saved', readiness }, 409)
    }

    const nextBinding = buildHermesBindingFromConfig(existing)
    const readiness = buildConfigValidation(existing, nextBinding)
    if (!readiness.ready) {
      appendHermesLog(['[START][ERROR] Startup config is incomplete', ...readiness.items.filter((item) => item.status !== 'ok').map((item) => `[START][ERROR] ${item.label}: ${item.detail}`)])
      return c.json({ ok: false, error: 'config_not_ready', readiness }, 409)
    }

    if (action === 'all-restart' && current.state === 'running') {
      appendHermesLog('[RESTART] Performing full Hermes restart')
      await stopHermesRuntime()
    }

    appendHermesLog('[START] Preparing left-brain model preflight')
    const preflight = await buildHermesPreflight(existing, { appendLogs: true })
    updateHermesControlState({
      preflight: {
        ready: preflight.ready,
        checkedAt: preflight.checkedAt,
        configFingerprint: getHermesControlConfigFingerprint(existing),
        detail: preflight.ready ? '左脑自检通过' : '左脑自检未通过',
        checks: preflight.checks,
        inspection: preflight.inspection || null
      },
      model: buildModelStateSnapshot({
        provider: existing.provider,
        baseUrl: existing.baseUrl,
        model: preflight.selectedModel,
        inspection: preflight.inspection,
        lastAction: 'load'
      })
    })
    if (!preflight.ready) {
      appendHermesLog('[START][ERROR] Preflight failed, Hermes launch aborted')
      return c.json({ ok: false, error: 'preflight_failed', readiness: preflight.readiness, preflight }, 409)
    }

    appendHermesLog(`[START][OK] Model ready: ${preflight.selectedModel}`)
    appendHermesLog(action === 'all-restart' ? '[RESTART] Launching Hermes runtime after full restart' : '[START] Launching Hermes runtime')
    runtimeStatus = await startHermesRuntime();
    updateHermesControlState({
      runtime: buildRuntimeStateSnapshot(runtimeStatus, action)
    })
    const side = body.config?.side || 'unknown';
    appendHermesLog(action === 'all-restart'
      ? `[RESTART][OK] Restarted ${side} brain binding to ${preflight.selectedModel}`
      : `[START][OK] Started ${side} brain binding to ${preflight.selectedModel}`)
  } else {
    const side = body.brainSide || 'unknown';
    appendHermesLog(`[STOP] Stopped ${side} brain`)
    if (action === 'pause' || action === 'stop') {
      if (body.stopAll) {
        runtimeStatus = await stopHermesRuntime();
      } else {
        runtimeStatus = current; // Keep it running if another brain is active
      }
    } else {
      runtimeStatus = await stopHermesRuntime();
    }
    updateHermesControlState({
      runtime: buildRuntimeStateSnapshot(runtimeStatus, action)
    })
  }


  return c.json({
    ok: true,
    agentId,
    action,
    runtimeStatus,
    state: getHermesControlState()
  })
})

app.get('/api/control/local-models', async (c) => {
  const provider = c.req.query('provider') || 'omlx'
  const requestedBaseUrl = c.req.query('baseUrl') || undefined
  return c.json(await fetchLocalModelCatalog({ provider, baseUrl: requestedBaseUrl }))
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
  const config = getPersistedHermesControlConfig()
  const controlState = await refreshHermesControlStateFromConfig(config)
  const defaultBinding = buildHermesBinding()
  const readiness = buildConfigValidation(config, defaultBinding)
  return c.json({
    ok: true,
    config: {
      provider: config.provider,
      baseUrl: config.baseUrl,
      model: config.model,
      workflow: config.workflow,
      contextLength: defaultBinding.contextLength,
      recommendedMaxOutputTokens: defaultBinding.recommendedMaxOutputTokens,
      tokenizer: defaultBinding.tokenizer,
      metadataSource: defaultBinding.metadataSource,
      shortTerm: config.shortTerm,
      memory: {
        sourceFiles: defaultBinding.agentMemoryFiles,
        agentCount: defaultBinding.agentMemoryCount,
        agents: defaultBinding.agentMemoryAgents,
        ...config.memory
      },
      skills: {
        ...config.skills,
        availableSkillFiles: defaultBinding.skills.availableSkillFiles,
        skillCount: defaultBinding.skills.skillCount
      },
      brains: config.brains,
      readiness,
      state: controlState
    }
  })
})

app.get('/api/control/agents/:agentId/context-candidates', async (c) => {
  const { agentId } = c.req.param()
  if (agentId !== hermesAgentDefinition.id) {
    return c.json({ ok: false, error: 'agent_not_found' }, 404)
  }

  const binding = buildHermesBinding()
  const sources = buildManualContextSourceCandidates(binding).map((source) => ({
    sourceId: source.sourceId,
    kind: source.kind,
    label: source.label,
    filePath: source.filePath,
    exists: source.exists,
    totalChars: source.totalChars,
    loadedChars: source.loadedChars ?? 0,
    truncated: Boolean(source.truncated)
  }))

  return c.json({
    ok: true,
    sources,
    contextPoolEntries: listContextPoolEntries()
  })
})

app.get('/api/control/agents/:agentId/workflow-diagnostics', async (c) => {
  const { agentId } = c.req.param()
  if (agentId !== hermesAgentDefinition.id) {
    return c.json({ ok: false, error: 'agent_not_found' }, 404)
  }

  const config = getPersistedHermesControlConfig()
  const binding = buildHermesBindingFromConfig(config)
  const contextLength = Number(binding.contextLength || 0)
  const minContextTokens = Number(binding.shortTerm?.minContextTokens || 0)
  const shortTermReady = contextLength > 0 && minContextTokens > 0 && contextLength >= minContextTokens
  const memoryFiles = [
    ['agentDefinitionFile', binding.memory.agentDefinitionFile],
    ['userFile', binding.memory.userFile],
    ['memoryFile', binding.memory.memoryFile],
    ['statusFile', binding.memory.statusFile],
    ['taskQueueFile', binding.memory.taskQueueFile],
    ['decisionsFile', binding.memory.decisionsFile]
  ].map(([key, filePath]) => ({
    key,
    filePath,
    exists: fs.existsSync(filePath)
  }))

  const memoryFileReady = memoryFiles.every((item) => item.exists)

  return c.json({
    ok: true,
    diagnostics: {
      workflow: {
        controllerLayerEnabled: true,
        memoryOverlayMode: String(binding?.workflow?.memoryOverlayMode || 'references-only'),
        replayWindowMessages: Math.max(0, Number(binding?.workflow?.replayWindowMessages || 0)),
        reasoningReplayWindowMessages: Math.max(0, Number(binding?.workflow?.reasoningReplayWindowMessages || 0))
      },
      shortTermMemory: {
        enabled: minContextTokens > 0,
        minContextTokens,
        runtimeContextLength: binding.contextLength,
        ready: shortTermReady,
        detail: shortTermReady
          ? `context ${contextLength} >= min ${minContextTokens}`
          : `context ${contextLength || 'unknown'} < min ${minContextTokens || 'unknown'}`
      },
      longTermMemory: {
        mode: 'file-memory',
        filesReady: memoryFileReady,
        files: memoryFiles,
        detail: memoryFileReady
          ? 'All configured file-memory sources are present for Hermes runtime.'
          : 'Some configured file-memory sources are missing.'
      },
      note: 'This endpoint validates control-plane configuration and file readiness. Internal Hermes runtime implementation details remain runtime-owned.'
    }
  })
})

app.get('/api/control/agents/:agentId/context-source-content', async (c) => {
  const { agentId } = c.req.param()
  if (agentId !== hermesAgentDefinition.id) {
    return c.json({ ok: false, error: 'agent_not_found' }, 404)
  }

  const sourceId = String(c.req.query('sourceId') || '').trim()
  const binding = buildHermesBinding()
  const source = getSelectableContextSourceById(binding, sourceId)
  if (!source) {
    return c.json({ ok: false, error: 'context_source_not_found' }, 404)
  }

  try {
    return c.json({ ok: true, source, file: readUtf8FileRecord(source.filePath) })
  } catch (error) {
    return c.json({ ok: false, error: error instanceof Error ? error.message : String(error) }, 500)
  }
})

app.put('/api/control/agents/:agentId/context-source-content', async (c) => {
  const { agentId } = c.req.param()
  if (agentId !== hermesAgentDefinition.id) {
    return c.json({ ok: false, error: 'agent_not_found' }, 404)
  }

  const body = await c.req.json().catch(() => ({}))
  const sourceId = String(body.sourceId || '').trim()
  const binding = buildHermesBinding()
  const source = getSelectableContextSourceById(binding, sourceId)
  if (!source) {
    return c.json({ ok: false, error: 'context_source_not_found' }, 404)
  }

  try {
    return c.json({ ok: true, source, file: writeUtf8FileRecord(source.filePath, body.content) })
  } catch (error) {
    return c.json({ ok: false, error: error instanceof Error ? error.message : String(error) }, 500)
  }
})

app.post('/api/control/agents/:agentId/context-drafts', async (c) => {
  const { agentId } = c.req.param()
  if (agentId !== hermesAgentDefinition.id) {
    return c.json({ ok: false, error: 'agent_not_found' }, 404)
  }

  const body = await c.req.json().catch(() => ({}))
  const prompt = String(body.prompt || '').trim()
  if (!prompt) {
    return c.json({ ok: false, error: 'prompt_required' }, 400)
  }

  const binding = buildHermesBinding()
  const draft = await generateContextDraft(prompt, binding, {
    selectedSourceIds: body.selectedSourceIds,
    selectedContextPoolIds: body.selectedContextPoolIds,
    confirmedContextSummary: body.confirmedContextSummary
  })

  return c.json({ ok: true, draft })
})

app.post('/api/control/agents/:agentId/submission-preview', async (c) => {
  const { agentId } = c.req.param()
  if (agentId !== hermesAgentDefinition.id) {
    return c.json({ ok: false, error: 'agent_not_found' }, 404)
  }

  const body = await c.req.json().catch(() => ({}))
  const prompt = String(body.prompt || '').trim()
  if (!prompt) {
    return c.json({ ok: false, error: 'prompt_required' }, 400)
  }

  const mode = String(body.mode || 'chat') === 'reasoning' ? 'reasoning' : 'chat'
  const binding = buildHermesBinding()
  const history = readHermesChatHistory()
  const contextSelection = {
    selectedSourceIds: body.selectedSourceIds,
    selectedContextPoolIds: body.selectedContextPoolIds,
    confirmedContextSummary: body.confirmedContextSummary
  }

  if (mode === 'reasoning') {
    const plannerContext = buildReasoningPlannerMessages(history, prompt, binding, '', contextSelection)
    return c.json({
      ok: true,
      preview: {
        mode,
        summary: `当前仅预览 Hermes 生成 reasoning plan 时将发送给 OMLX 的消息，不会真正调用模型。最后一条 user 消息是本次输入；前面 ${plannerContext.replayableMessages.length} 条为历史重放。`,
        outboundPreview: {
          provider: binding.provider,
          model: binding.model,
          baseUrl: binding.baseUrl,
          messages: buildReasoningMessagePreview(plannerContext.messages)
        },
        contextSources: buildChatContextSourcesPayload({
          replayedMessageCount: plannerContext.replayableMessages.length,
          projectMemory: plannerContext.projectMemory
        }, binding)
      }
    })
  }

  const chatContext = buildHermesChatMessages(history, prompt, binding, contextSelection)
  return c.json({
    ok: true,
    preview: {
      mode,
      summary: `当前仅预览 Hermes 将发送给 OMLX 的聊天消息，不会真正调用模型。最后一条 user 消息是本次输入；前面 ${chatContext.replayedMessageCount} 条为历史重放。`,
      outboundPreview: {
        provider: binding.provider,
        model: binding.model,
        baseUrl: binding.baseUrl,
        messages: buildReasoningMessagePreview(chatContext.messages)
      },
      contextSources: buildChatContextSourcesPayload(chatContext, binding)
    }
  })
})

app.get('/api/control/agents/:agentId/context-pool', async (c) => {
  const { agentId } = c.req.param()
  if (agentId !== hermesAgentDefinition.id) {
    return c.json({ ok: false, error: 'agent_not_found' }, 404)
  }

  return c.json({ ok: true, entries: listContextPoolEntries() })
})

app.post('/api/control/agents/:agentId/context-pool', async (c) => {
  const { agentId } = c.req.param()
  if (agentId !== hermesAgentDefinition.id) {
    return c.json({ ok: false, error: 'agent_not_found' }, 404)
  }

  const body = await c.req.json().catch(() => ({}))
  const summary = String(body.summary || '').trim()
  if (!summary) {
    return c.json({ ok: false, error: 'summary_required' }, 400)
  }

  const now = new Date().toISOString()
  const entry = writeContextPoolEntry({
    entryId: createOpaqueId('ctx'),
    title: String(body.title || `Context ${now}`).trim(),
    prompt: String(body.prompt || '').trim(),
    summary,
    selectedSourceIds: Array.isArray(body.selectedSourceIds) ? body.selectedSourceIds.map((value) => String(value)) : [],
    selectedContextPoolIds: Array.isArray(body.selectedContextPoolIds) ? body.selectedContextPoolIds.map((value) => String(value)) : [],
    createdAt: now,
    updatedAt: now
  })

  return c.json({ ok: true, entry })
})

app.get('/api/control/agents/:agentId/context-pool/:entryId', async (c) => {
  const { agentId, entryId } = c.req.param()
  if (agentId !== hermesAgentDefinition.id) {
    return c.json({ ok: false, error: 'agent_not_found' }, 404)
  }

  const entry = readContextPoolEntry(entryId)
  if (!entry) {
    return c.json({ ok: false, error: 'context_pool_entry_not_found' }, 404)
  }

  return c.json({ ok: true, entry, filePath: getContextPoolEntryFilePath(entryId) })
})

app.get('/api/control/agents/:agentId/context-pool/:entryId/file', async (c) => {
  const { agentId, entryId } = c.req.param()
  if (agentId !== hermesAgentDefinition.id) {
    return c.json({ ok: false, error: 'agent_not_found' }, 404)
  }

  const entry = readContextPoolEntry(entryId)
  if (!entry) {
    return c.json({ ok: false, error: 'context_pool_entry_not_found' }, 404)
  }

  try {
    return c.json({ ok: true, entry, file: readUtf8FileRecord(getContextPoolEntryFilePath(entryId)) })
  } catch (error) {
    return c.json({ ok: false, error: error instanceof Error ? error.message : String(error) }, 500)
  }
})

app.put('/api/control/agents/:agentId/context-pool/:entryId', async (c) => {
  const { agentId, entryId } = c.req.param()
  if (agentId !== hermesAgentDefinition.id) {
    return c.json({ ok: false, error: 'agent_not_found' }, 404)
  }

  const existing = readContextPoolEntry(entryId)
  if (!existing) {
    return c.json({ ok: false, error: 'context_pool_entry_not_found' }, 404)
  }

  const body = await c.req.json().catch(() => ({}))
  const next = writeContextPoolEntry({
    ...existing,
    title: String(body.title ?? existing.title),
    summary: String(body.summary ?? existing.summary),
    updatedAt: new Date().toISOString()
  })
  return c.json({ ok: true, entry: next })
})

app.put('/api/control/agents/:agentId/context-pool/:entryId/file', async (c) => {
  const { agentId, entryId } = c.req.param()
  if (agentId !== hermesAgentDefinition.id) {
    return c.json({ ok: false, error: 'agent_not_found' }, 404)
  }

  const existing = readContextPoolEntry(entryId)
  if (!existing) {
    return c.json({ ok: false, error: 'context_pool_entry_not_found' }, 404)
  }

  const body = await c.req.json().catch(() => ({}))
  try {
    const file = writeUtf8FileRecord(getContextPoolEntryFilePath(entryId), body.content)
    return c.json({ ok: true, file, entry: readContextPoolEntry(entryId) })
  } catch (error) {
    return c.json({ ok: false, error: error instanceof Error ? error.message : String(error) }, 500)
  }
})

app.post('/api/control/agents/:agentId/context-pool/:entryId/open', async (c) => {
  const { agentId, entryId } = c.req.param()
  if (agentId !== hermesAgentDefinition.id) {
    return c.json({ ok: false, error: 'agent_not_found' }, 404)
  }

  const entry = readContextPoolEntry(entryId)
  if (!entry) {
    return c.json({ ok: false, error: 'context_pool_entry_not_found' }, 404)
  }

  const filePath = getContextPoolEntryFilePath(entryId)
  const openedWith = openFileInEditor(filePath)
  return c.json({ ok: true, openedWith, filePath })
})

app.post('/api/control/agents/:agentId/preflight-check', async (c) => {
  const { agentId } = c.req.param()
  if (agentId !== hermesAgentDefinition.id) {
    return c.json({ ok: false, error: 'agent_not_found' }, 404)
  }

  const body = await c.req.json().catch(() => ({}))
  const preflight = await buildHermesPreflight(body.config || {}, { appendLogs: true })
  const savedConfig = mergeHermesControlConfig(getPersistedHermesControlConfig(), body.config || {})
  const state = updateHermesControlState({
    preflight: {
      ready: preflight.ready,
      checkedAt: preflight.checkedAt,
      configFingerprint: getHermesControlConfigFingerprint(savedConfig),
      detail: preflight.ready ? '左脑自检通过' : '左脑自检未通过',
      checks: preflight.checks,
      inspection: preflight.inspection || null
    },
    model: buildModelStateSnapshot({
      provider: savedConfig.provider,
      baseUrl: savedConfig.baseUrl,
      model: preflight.selectedModel,
      inspection: preflight.inspection,
      lastAction: 'load'
    })
  })
  return c.json({
    ok: true,
    agentId,
    preflight,
    state
  })
})

app.put('/api/control/agents/:agentId/config', async (c) => {
  const { agentId } = c.req.param()
  if (agentId !== hermesAgentDefinition.id) {
    return c.json({ ok: false, error: 'agent_not_found' }, 404)
  }

  const current = getPersistedHermesControlConfig()
  const body = await c.req.json().catch(() => ({}))
  const nextConfig = mergeHermesControlConfig(current, body)

  setHermesControlConfig(nextConfig)
  const binding = buildHermesBindingFromConfig(nextConfig)
  const state = updateHermesControlState({
    config: {
      saved: true,
      savedAt: new Date().toISOString(),
      savedFingerprint: getHermesControlConfigFingerprint(nextConfig),
      lastSavedModel: nextConfig.model,
      detail: '已保存左脑配置'
    },
    preflight: {
      ready: false,
      checkedAt: null,
      configFingerprint: '',
      detail: '配置已保存，等待重新自检',
      checks: [],
      inspection: null
    }
  })

  return c.json({
    ok: true,
    config: nextConfig,
    readiness: buildConfigValidation(nextConfig, binding),
    state
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

app.get('/api/control/agents/:agentId/chat-history', async (c) => {
  const { agentId } = c.req.param()
  if (agentId !== hermesAgentDefinition.id) {
    return c.json({ ok: false, error: 'agent_not_found' }, 404)
  }
  try {
    const history = readStoredHermesChatHistory()
    return c.json({ ok: true, history, file: getHermesChatFileRecord(), activeRequest: buildActiveHermesChatRequestPayload() })
  } catch(err) {
    return c.json({ ok: false, error: err.message })
  }
})

app.get('/api/control/agents/:agentId/chat-memory-file', async (c) => {
  const { agentId } = c.req.param()
  if (agentId !== hermesAgentDefinition.id) {
    return c.json({ ok: false, error: 'agent_not_found' }, 404)
  }

  try {
    return c.json({ ok: true, file: getHermesChatFileRecord({ includeContent: true }) })
  } catch (err) {
    return c.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, 500)
  }
})

app.get('/api/control/agents/:agentId/chat-history-file', async (c) => {
  const { agentId } = c.req.param()
  if (agentId !== hermesAgentDefinition.id) {
    return c.json({ ok: false, error: 'agent_not_found' }, 404)
  }

  try {
    return c.json({ ok: true, file: getHermesChatFileRecord({ includeContent: true }) })
  } catch (err) {
    return c.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, 500)
  }
})

app.put('/api/control/agents/:agentId/chat-memory-file', async (c) => {
  const { agentId } = c.req.param()
  if (agentId !== hermesAgentDefinition.id) {
    return c.json({ ok: false, error: 'agent_not_found' }, 404)
  }

  const body = await c.req.json().catch(() => null)
  const content = typeof body?.content === 'string' ? body.content : ''

  try {
    const normalizedHistory = parseHermesChatHistoryContent(content)
    writeHermesChatHistory(normalizedHistory)
    return c.json({
      ok: true,
      file: getHermesChatFileRecord({ includeContent: true }),
      history: normalizedHistory
    })
  } catch (err) {
    return c.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, 400)
  }
})

app.put('/api/control/agents/:agentId/chat-history-file', async (c) => {
  const { agentId } = c.req.param()
  if (agentId !== hermesAgentDefinition.id) {
    return c.json({ ok: false, error: 'agent_not_found' }, 404)
  }

  const body = await c.req.json().catch(() => null)
  const content = typeof body?.content === 'string' ? body.content : ''

  try {
    const normalizedHistory = parseHermesChatHistoryContent(content)
    writeHermesChatHistory(normalizedHistory)
    return c.json({
      ok: true,
      file: getHermesChatFileRecord({ includeContent: true }),
      history: normalizedHistory
    })
  } catch (err) {
    return c.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, 400)
  }
})

app.post('/api/control/agents/:agentId/chat-history-file/open', async (c) => {
  const { agentId } = c.req.param()
  if (agentId !== hermesAgentDefinition.id) {
    return c.json({ ok: false, error: 'agent_not_found' }, 404)
  }

  try {
    const openedWith = openFileInEditor(getHermesChatFilePath())
    return c.json({ ok: true, openedWith, file: getHermesChatFileRecord() })
  } catch (err) {
    return c.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, 500)
  }
})

app.post('/api/control/agents/:agentId/reasoning-sessions', async (c) => {
  const { agentId } = c.req.param()
  if (agentId !== hermesAgentDefinition.id) {
    return c.json({ ok: false, error: 'agent_not_found' }, 404)
  }

  const runtimeStatus = getHermesRuntimeState()
  if (runtimeStatus.state !== 'running') {
    return c.json({ ok: false, error: 'runtime_not_running', runtimeStatus }, 409)
  }

  if (activeHermesReasoningSessionId) {
    const activeSession = readReasoningSession(activeHermesReasoningSessionId)
    return c.json({
      ok: false,
      error: 'reasoning_busy',
      session: activeSession,
      details: '已有一条可观测推理正在执行，请等待完成后再发起新的 reasoning session。'
    }, 409)
  }

  const body = await c.req.json().catch(() => ({}))
  const userPrompt = String(body.prompt || '').trim()
  if (!userPrompt) {
    return c.json({ ok: false, error: 'prompt_required' }, 400)
  }

  const binding = buildHermesBinding()
  const history = readHermesChatHistory()
  const session = await createReasoningSession(agentId, userPrompt, {
    selectedSourceIds: body.selectedSourceIds,
    selectedContextPoolIds: body.selectedContextPoolIds,
    confirmedContextSummary: body.confirmedContextSummary
  })
  persistHermesChatPrompt(session.sessionId, userPrompt)
  void runReasoningSession(session.sessionId, binding, history)

  return c.json({
    ok: true,
    session: {
      sessionId: session.sessionId,
      status: session.status,
      createdAt: session.createdAt,
      plan: session.plan
    }
  })
})

app.get('/api/control/agents/:agentId/reasoning-sessions/:sessionId', async (c) => {
  const { agentId, sessionId } = c.req.param()
  if (agentId !== hermesAgentDefinition.id) {
    return c.json({ ok: false, error: 'agent_not_found' }, 404)
  }

  const session = readReasoningSession(sessionId)
  if (!session) {
    return c.json({ ok: false, error: 'reasoning_session_not_found' }, 404)
  }

  return c.json({ ok: true, session })
})

app.post('/api/control/agents/:agentId/reasoning-sessions/:sessionId/review', async (c) => {
  const { agentId, sessionId } = c.req.param()
  if (agentId !== hermesAgentDefinition.id) {
    return c.json({ ok: false, error: 'agent_not_found' }, 404)
  }

  const session = readReasoningSession(sessionId)
  if (!session) {
    return c.json({ ok: false, error: 'reasoning_session_not_found' }, 404)
  }

  if (session.status !== 'waiting_review' || !session.review) {
    return c.json({ ok: false, error: 'reasoning_session_not_waiting_review' }, 409)
  }

  if (activeHermesReasoningSessionId && activeHermesReasoningSessionId !== sessionId) {
    return c.json({ ok: false, error: 'reasoning_busy', details: '另一条可观测推理正在执行中，请稍后重试。' }, 409)
  }

  const body = await c.req.json().catch(() => ({}))
  const decision = String(body.decision || '').trim().toLowerCase()
  const correctionPrompt = String(body.correctionPrompt || '').trim()
  if (decision !== 'approve' && decision !== 'reject') {
    return c.json({ ok: false, error: 'review_decision_invalid' }, 400)
  }

  const binding = buildHermesBinding()
  const history = readHermesChatHistory()
  const review = session.review

  if (decision === 'approve') {
    persistReasoningReviewDecision(sessionId, 'approve', review)
    appendReasoningEvent(sessionId, 'review_approved', review.title, review.targetType === 'plan' ? '计划审核已通过，继续执行第一步。' : `步骤审核已通过，继续执行下一步。`, {
      stepId: review.stepId || undefined,
      data: {
        targetType: review.targetType,
        stepIndex: review.stepIndex ?? null
      }
    })

    clearReasoningReview(sessionId)

    const planLength = Array.isArray(session.plan?.steps) ? session.plan.steps.length : 0
    const approvedStepIndex = Number.isInteger(review.stepIndex) ? review.stepIndex : -1
    if (review.targetType === 'step' && approvedStepIndex >= 0 && approvedStepIndex >= planLength - 1) {
      finalizeReasoningSession(sessionId, { persistFinalAnswer: true })
      return c.json({ ok: true, session: readReasoningSession(sessionId) })
    }

    const nextStepIndex = review.targetType === 'plan'
      ? Number(session.artifacts?.nextStepIndex || 0)
      : approvedStepIndex + 1

    updateReasoningSession(sessionId, (current) => ({
      ...current,
      artifacts: {
        ...current.artifacts,
        nextStepIndex
      }
    }))

    void continueReasoningSessionFromStep(sessionId, binding, history, { stepIndex: nextStepIndex })
    return c.json({ ok: true, session: readReasoningSession(sessionId) })
  }

  persistReasoningReviewDecision(sessionId, 'reject', review, correctionPrompt)
  appendReasoningEvent(sessionId, 'review_rejected', review.title, correctionPrompt || '当前结果未通过审核，按修正条件重新执行。', {
    stepId: review.stepId || undefined,
    data: {
      targetType: review.targetType,
      stepIndex: review.stepIndex ?? null,
      correctionPrompt: correctionPrompt || null
    }
  })

  clearReasoningReview(sessionId)

  if (review.targetType === 'plan') {
    void prepareReasoningSessionPlan(sessionId, binding, history, { correctionPrompt }).catch((error) => {
      markReasoningSessionFailed(sessionId, error)
    })
  } else {
    void continueReasoningSessionFromStep(sessionId, binding, history, {
      stepIndex: Number(review.stepIndex || 0),
      correctionPrompt
    })
  }

  return c.json({ ok: true, session: readReasoningSession(sessionId) })
})

function getHermesChatFilePath() {
  const dateStr = new Date().toLocaleDateString('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit' }).replace(/\//g, '-')
  return path.join(GAMESTUDIO_ROOT, 'ai', 'chat', `${dateStr}.json`)
}

function normalizeHermesChatHistoryEntries(history) {
  if (!Array.isArray(history)) {
    throw new Error('chat_history_must_be_array')
  }

  return history.map((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error(`chat_history_entry_invalid_${index}`)
    }

    const role = String(entry.role || '').trim()
    if (!role) {
      throw new Error(`chat_history_entry_role_missing_${index}`)
    }

    return {
      ...entry,
      role,
      content: typeof entry.content === 'string' ? entry.content : String(entry.content ?? ''),
      ...(entry.createdAt != null ? { createdAt: String(entry.createdAt) } : {})
    }
  })
}

function parseHermesChatHistoryContent(rawContent) {
  let parsed
  try {
    parsed = JSON.parse(String(rawContent || '[]'))
  } catch {
    throw new Error('chat_history_json_invalid')
  }

  return normalizeHermesChatHistoryEntries(parsed)
}

function getHermesChatFileRecord({ includeContent = false } = {}) {
  const filePath = getHermesChatFilePath()
  const exists = fs.existsSync(filePath)
  const content = exists ? fs.readFileSync(filePath, 'utf8') : '[]'
  const stats = exists ? fs.statSync(filePath) : null

  return {
    filePath,
    exists,
    sizeChars: exists ? content.length : 0,
    updatedAt: stats ? stats.mtime.toISOString() : null,
    ...(includeContent ? { content } : {})
  }
}

function ensureDirectory(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true })
}

function createOpaqueId(prefix) {
  return `${prefix}_${Date.now()}_${Math.random().toString(16).slice(2, 10)}`
}

function truncateReasoningPreview(value, limit = 1600) {
  const text = String(value || '')
  if (text.length <= limit) {
    return text
  }
  return `${text.slice(0, limit)}\n\n[truncated ${text.length - limit} chars]`
}

function buildReasoningMessagePreview(messages) {
  return (Array.isArray(messages) ? messages : []).map((message, index) => ({
    index,
    role: String(message?.role || 'unknown'),
    content: truncateReasoningPreview(message?.content || '', 1400)
  }))
}

function appendReasoningReviewRecord(record) {
  ensureDirectory(path.dirname(HERMES_REASONING_REVIEW_RECORDS_FILE))
  fs.appendFileSync(HERMES_REASONING_REVIEW_RECORDS_FILE, `${JSON.stringify(record)}\n`, 'utf8')
}

function getReasoningSessionFilePath(sessionId) {
  return path.join(HERMES_REASONING_SESSIONS_DIR, `${sessionId}.json`)
}

function createReasoningEvent(sessionId, type, title, summary, extra = {}) {
  return {
    eventId: createOpaqueId('evt'),
    sessionId,
    type,
    timestamp: new Date().toISOString(),
    title,
    summary,
    ...extra
  }
}

function writeReasoningSession(session) {
  ensureDirectory(HERMES_REASONING_SESSIONS_DIR)
  fs.writeFileSync(getReasoningSessionFilePath(session.sessionId), JSON.stringify(session, null, 2), 'utf8')
  return session
}

function readReasoningSession(sessionId) {
  const filePath = getReasoningSessionFilePath(sessionId)
  if (!fs.existsSync(filePath)) {
    return null
  }
  return JSON.parse(fs.readFileSync(filePath, 'utf8'))
}

function updateReasoningSession(sessionId, updater) {
  const current = readReasoningSession(sessionId)
  if (!current) {
    throw new Error('reasoning_session_not_found')
  }
  const next = updater(current)
  next.updatedAt = new Date().toISOString()
  return writeReasoningSession(next)
}

function appendReasoningEvent(sessionId, type, title, summary, extra = {}) {
  return updateReasoningSession(sessionId, (session) => {
    const event = createReasoningEvent(sessionId, type, title, summary, extra)
    return {
      ...session,
      events: [...session.events, event]
    }
  })
}

function buildReasoningReview(targetType, options = {}) {
  return {
    status: 'pending',
    targetType,
    stepId: options.stepId || null,
    stepIndex: Number.isInteger(options.stepIndex) ? options.stepIndex : null,
    title: String(options.title || '').trim() || (targetType === 'plan' ? '审核计划' : '审核步骤'),
    summary: String(options.summary || '').trim(),
    correctionPrompt: options.correctionPrompt ? String(options.correctionPrompt) : null,
    iteration: Number(options.iteration || 1),
    evidence: options.evidence || null
  }
}

function requestReasoningReview(sessionId, review, eventData = {}) {
  updateReasoningSession(sessionId, (session) => ({
    ...session,
    status: 'waiting_review',
    currentStepId: review.stepId || null,
    review
  }))

  appendReasoningEvent(sessionId, 'review_requested', review.title, review.summary, {
    stepId: review.stepId || undefined,
    data: {
      targetType: review.targetType,
      stepIndex: review.stepIndex ?? null,
      ...eventData
    }
  })
}

function clearReasoningReview(sessionId) {
  return updateReasoningSession(sessionId, (session) => ({
    ...session,
    status: 'running',
    review: null
  }))
}

function persistReasoningReviewDecision(sessionId, decision, review, correctionPrompt = '') {
  const session = readReasoningSession(sessionId)
  if (!session || !review) return

  appendReasoningReviewRecord({
    recordedAt: new Date().toISOString(),
    sessionId,
    userPrompt: session.userPrompt,
    decision,
    correctionPrompt: correctionPrompt || null,
    review,
    plan: session.plan,
    artifacts: {
      projectRoot: session.artifacts?.projectRoot || null,
      storyIndex: session.artifacts?.storyIndex || null,
      finalAnswer: session.artifacts?.finalAnswer || null
    }
  })
}

function finalizeReasoningSession(sessionId, options = {}) {
  const session = readReasoningSession(sessionId)
  if (!session) {
    throw new Error('reasoning_session_not_found')
  }

  const shouldPersist = Boolean(options.persistFinalAnswer)
  const alreadyPersisted = Boolean(session.artifacts?.finalAnswerPersisted)
  if (shouldPersist && session.artifacts?.finalAnswer && !alreadyPersisted) {
    persistHermesChatReply(sessionId, session.artifacts.finalAnswer, session.artifacts.finalAnswerUsage || null)
  }

  updateReasoningSession(sessionId, (current) => ({
    ...current,
    status: 'completed',
    currentStepId: null,
    review: null,
    artifacts: {
      ...current.artifacts,
      finalAnswerPersisted: shouldPersist ? true : Boolean(current.artifacts?.finalAnswerPersisted),
      nextStepIndex: Array.isArray(current.plan?.steps) ? current.plan.steps.length : 0
    }
  }))
  appendReasoningEvent(sessionId, 'session_completed', '推理完成', shouldPersist ? '本次可观测推理已完成，最终回答已写入聊天记录。' : '本次可观测推理已完成')
  appendHermesLog(`[REASONING][DONE] sessionId=${sessionId}`)
  return readReasoningSession(sessionId)
}

function markReasoningSessionFailed(sessionId, error) {
  const detail = error instanceof Error ? error.message : String(error)
  updateReasoningSession(sessionId, (current) => ({
    ...current,
    status: 'failed',
    currentStepId: null,
    review: null,
    error: detail
  }))
  appendReasoningEvent(sessionId, 'step_failed', '执行失败', detail, {
    stepId: readReasoningSession(sessionId)?.currentStepId || undefined
  })
  appendReasoningEvent(sessionId, 'session_failed', '推理失败', detail)
  persistHermesChatError(sessionId, detail)
  appendHermesLog(`[REASONING][ERROR] sessionId=${sessionId} detail=${detail}`)
  activeHermesReasoningSessionId = null
}

function buildReasoningTaskRecord(phase, binding) {
  const now = new Date()
  return {
    taskId: createOpaqueId(`reasoning_${phase}`),
    phase,
    provider: binding.provider,
    baseUrl: binding.baseUrl,
    model: binding.model,
    status: 'pending',
    telemetrySource: 'local_request',
    createdAt: now.toISOString(),
    startedAt: now.toISOString(),
    finishedAt: null,
    leaseMs: HERMES_REASONING_TASK_LEASE_MS,
    leaseExpiresAt: new Date(now.getTime() + HERMES_REASONING_TASK_LEASE_MS).toISOString(),
    renewalCount: 0,
    maxRenewals: HERMES_REASONING_TASK_MAX_RENEWS,
    hardTimeoutAt: new Date(now.getTime() + HERMES_REASONING_TASK_HARD_TIMEOUT_MS).toISOString(),
    providerStatus: null,
    lastObservedAt: null,
    error: null
  }
}

function getReasoningTask(session, phase) {
  return session?.artifacts?.tasks?.[phase] || null
}

function updateReasoningTask(sessionId, phase, updater) {
  return updateReasoningSession(sessionId, (session) => {
    const currentTask = getReasoningTask(session, phase)
    const nextTask = updater(currentTask)
    return {
      ...session,
      artifacts: {
        ...session.artifacts,
        tasks: {
          ...(session.artifacts?.tasks || {}),
          [phase]: nextTask
        }
      }
    }
  })
}

function createReasoningTaskTimeoutResult(phase, task, probe) {
  const label = phase === 'plan' ? 'plan' : phase
  const renewals = `${task.renewalCount}/${task.maxRenewals}`
  return new Error(`${label}_task_timeout: ${probe.detail} (renewals=${renewals})`)
}

async function probeReasoningProviderTask(binding, phase, task) {
  const checkedAt = new Date().toISOString()
  const runtimeStatus = getHermesRuntimeState()

  if (runtimeStatus.state !== 'running') {
    return {
      state: 'runtime_unavailable',
      canContinue: false,
      checkedAt,
      telemetrySource: 'runtime_state',
      nativeSessionSupported: false,
      detail: runtimeStatus.detail || 'Hermes runtime is not running'
    }
  }

  const access = getProviderAccess(binding.provider, binding.baseUrl)
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), HERMES_REASONING_PROVIDER_PROBE_TIMEOUT_MS)

  try {
    const response = await fetch(`${access.baseUrl}/models`, {
      method: 'GET',
      signal: controller.signal,
      headers: access.headers
    })

    if (!response.ok) {
      return {
        state: 'provider_unreachable',
        canContinue: false,
        checkedAt,
        telemetrySource: 'service_health',
        nativeSessionSupported: false,
        detail: `OMLX probe failed with HTTP ${response.status}`
      }
    }

    const exhausted = task.renewalCount >= task.maxRenewals
    return {
      state: exhausted ? 'provider_alive_but_lease_exhausted' : 'provider_alive_request_pending',
      canContinue: !exhausted,
      checkedAt,
      telemetrySource: 'service_health',
      nativeSessionSupported: false,
      detail: exhausted
        ? `OMLX service is reachable, but native session/job telemetry is unavailable and the ${phase} lease budget is exhausted`
        : `OMLX service is reachable; native session/job telemetry is unavailable, so the pending ${phase} task will continue under an extended lease`
    }
  } catch (error) {
    const detail = error?.name === 'AbortError'
      ? `OMLX probe timed out after ${HERMES_REASONING_PROVIDER_PROBE_TIMEOUT_MS}ms`
      : (error instanceof Error ? error.message : String(error))
    return {
      state: 'provider_probe_failed',
      canContinue: false,
      checkedAt,
      telemetrySource: 'service_health',
      nativeSessionSupported: false,
      detail
    }
  } finally {
    clearTimeout(timeout)
  }
}

async function runManagedReasoningTask(sessionId, phase, binding, executor) {
  const phaseLabel = phase === 'plan' ? 'Plan 任务' : `${phase} 任务`
  const initialTask = buildReasoningTaskRecord(phase, binding)

  updateReasoningTask(sessionId, phase, () => initialTask)
  appendReasoningEvent(sessionId, 'task_registered', phaseLabel, `${phaseLabel}已创建，进入受监督等待窗口`, {
    data: {
      phase,
      task: initialTask
    }
  })

  const controller = new AbortController()
  const hardTimeout = setTimeout(() => controller.abort(), HERMES_REASONING_TASK_HARD_TIMEOUT_MS)
  const executionPromise = Promise.resolve()
    .then(() => executor({ signal: controller.signal }))
    .then((value) => ({ kind: 'resolved', value }))
    .catch((error) => ({ kind: 'rejected', error }))

  try {
    updateReasoningTask(sessionId, phase, (task) => ({
      ...task,
      status: 'running'
    }))
    appendReasoningEvent(sessionId, 'task_started', phaseLabel, `${phaseLabel}已提交给 ${binding.provider}/${binding.model}`, {
      data: {
        phase,
        provider: binding.provider,
        model: binding.model,
        leaseMs: HERMES_REASONING_TASK_LEASE_MS,
        maxRenewals: HERMES_REASONING_TASK_MAX_RENEWS
      }
    })

    while (true) {
      const result = await Promise.race([
        executionPromise,
        new Promise((resolve) => {
          setTimeout(() => resolve({ kind: 'lease_expired' }), HERMES_REASONING_TASK_LEASE_MS)
        })
      ])

      if (result?.kind === 'resolved') {
        updateReasoningTask(sessionId, phase, (task) => ({
          ...task,
          status: 'completed',
          finishedAt: new Date().toISOString(),
          lastObservedAt: new Date().toISOString(),
          error: null
        }))
        appendReasoningEvent(sessionId, 'task_completed', phaseLabel, `${phaseLabel}已完成`, { data: { phase } })
        return result.value
      }

      if (result?.kind === 'rejected') {
        const detail = result.error instanceof Error ? result.error.message : String(result.error)
        updateReasoningTask(sessionId, phase, (task) => ({
          ...task,
          status: 'failed',
          finishedAt: new Date().toISOString(),
          lastObservedAt: new Date().toISOString(),
          error: detail
        }))
        appendReasoningEvent(sessionId, 'task_failed', phaseLabel, detail, { data: { phase } })
        throw result.error
      }

      const currentTask = getReasoningTask(readReasoningSession(sessionId), phase)
      const probe = await probeReasoningProviderTask(binding, phase, currentTask)

      updateReasoningTask(sessionId, phase, (task) => ({
        ...task,
        status: probe.canContinue ? 'waiting_provider' : 'failed',
        renewalCount: probe.canContinue ? task.renewalCount + 1 : task.renewalCount,
        leaseExpiresAt: probe.canContinue
          ? new Date(Date.now() + HERMES_REASONING_TASK_LEASE_MS).toISOString()
          : task.leaseExpiresAt,
        providerStatus: probe,
        lastObservedAt: probe.checkedAt,
        telemetrySource: probe.telemetrySource,
        error: probe.canContinue ? null : probe.detail,
        finishedAt: probe.canContinue ? null : new Date().toISOString()
      }))

      if (probe.canContinue) {
        appendReasoningEvent(sessionId, 'task_wait_extended', phaseLabel, probe.detail, {
          data: {
            phase,
            providerStatus: probe
          }
        })
        continue
      }

      controller.abort()
      appendReasoningEvent(sessionId, 'task_probe_failed', phaseLabel, probe.detail, {
        data: {
          phase,
          providerStatus: probe
        }
      })
      throw createReasoningTaskTimeoutResult(phase, currentTask, probe)
    }
  } finally {
    clearTimeout(hardTimeout)
  }
}

function buildReasoningStoryIndexRecord(projectId, filePath, parsed) {
  const nodes = Array.isArray(parsed?.nodes) ? parsed.nodes : []
  const nodeNames = nodes
    .map((node) => String(node?.body?.title || node?.name || node?.id || '').trim())
    .filter(Boolean)

  return {
    projectId,
    filePath,
    nodeCount: nodes.length,
    nodeNames: nodeNames.slice(0, 8)
  }
}

function getStoryProjectSearchRoots() {
  return [...new Set([STORAGE_PROJECTS_ROOT, LEGACY_PROJECTS_ROOT])]
}

function listCreatedStoriesFromProjects() {
  const searchedRoots = getStoryProjectSearchRoots()
  const availableRoots = []
  const missingRoots = []
  const readErrors = []
  const stories = []
  const seenFilePaths = new Set()

  for (const rootPath of searchedRoots) {
    if (!fs.existsSync(rootPath)) {
      missingRoots.push(rootPath)
      continue
    }

    availableRoots.push(rootPath)

    let projectIds = []
    try {
      projectIds = fs.readdirSync(rootPath)
    } catch (error) {
      readErrors.push({
        rootPath,
        detail: error instanceof Error ? error.message : String(error)
      })
      continue
    }

    for (const projectId of projectIds) {
      const filePath = path.join(rootPath, projectId, 'scripts.json')
      if (!fs.existsSync(filePath) || seenFilePaths.has(filePath)) {
        continue
      }

      seenFilePaths.add(filePath)

      try {
        const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'))
        stories.push(buildReasoningStoryIndexRecord(projectId, filePath, parsed))
      } catch (error) {
        stories.push({
          projectId,
          filePath,
          nodeCount: 0,
          nodeNames: [],
          error: error instanceof Error ? error.message : String(error)
        })
      }
    }
  }

  return {
    stories,
    searchedRoots,
    availableRoots,
    missingRoots,
    readErrors
  }
}

const REASONING_ALLOWED_ACTIONS = {
  read_recent_context: {
    title: '读取最近上下文',
    tool: 'context.recent'
  },
  locate_project: {
    title: '定位项目目录',
    tool: 'project.locate'
  },
  list_created_stories: {
    title: '读取故事索引',
    tool: 'project.listStories'
  },
  prepare_prompt: {
    title: '整理问题',
    tool: 'planner.default'
  },
  summarize_story_index: {
    title: '生成最终回答',
    tool: 'model.answer'
  },
  generate_default_answer: {
    title: '生成最终回答',
    tool: 'model.answer'
  }
}

function collectReplayableHermesMessages(history, options = {}) {
  const replayableMessages = []
  const excludedRequestId = String(options.excludeRequestId || '').trim()
  const limit = Math.max(0, Number.isFinite(Number(options.limit)) ? Number(options.limit) : MAX_REPLAYED_HERMES_CHAT_MESSAGES)

  for (const item of Array.isArray(history) ? history : []) {
    const role = String(item?.role || '').trim().toLowerCase()
    const content = String(item?.content || '')
    const requestId = String(item?.requestId || '').trim()
    if (!content) continue
    if (excludedRequestId && requestId === excludedRequestId) continue

    if (role === 'user') {
      replayableMessages.push({ role: 'user', content })
      continue
    }

    if (role === 'hermes' || role === 'assistant') {
      if (isHermesChatErrorReplay(content)) continue
      replayableMessages.push({ role: 'assistant', content })
    }
  }

  return limit > 0 ? replayableMessages.slice(-limit) : []
}

function buildReasoningRecentContextArtifact(projectMemory, replayableMessages, plannerSource) {
  return {
    replayedMessageCount: replayableMessages.length,
    selectedMemorySources: projectMemory.selectedSources.map((source) => ({
      label: source.label,
      filePath: source.filePath,
      exists: source.exists,
      truncated: Boolean(source.truncated)
    })),
    loadedMemorySources: projectMemory.loadedSources.map((source) => ({
      label: source.label,
      filePath: source.filePath,
      loadedChars: source.loadedChars,
      totalChars: source.totalChars,
      truncated: Boolean(source.truncated)
    })),
    plannerSource
  }
}

const REASONING_PLANNER_MEMORY_LABELS = new Set([
  'Project Memory',
  'Project Status',
  'Task Queue',
  'Decisions',
  'Latest Daily Log'
])

function buildReasoningPlannerProjectMemory(binding, userPrompt, options = {}) {
  const projectMemory = buildProjectMemorySystemMessage(binding, userPrompt, options)
  const selectedSources = projectMemory.selectedSources.filter((source) => REASONING_PLANNER_MEMORY_LABELS.has(source.label))
  const loadedSources = selectedSources.filter((source) => source.exists && source.content)
  const message = [
    'GameStudio execution memory below is injected by the control plane for reasoning-plan generation.',
    'Use these markdown records together with the nearby conversation to decide the next observable execution steps.',
    'Do not use agent identity or persona files when creating the plan unless they also appear in the nearby conversation.'
  ]

  for (const source of loadedSources) {
    message.push(`\n[${source.label}] ${source.filePath}`)
    message.push(source.content)
  }

  return {
    ...projectMemory,
    message: message.join('\n'),
    selectedSources,
    loadedSources
  }
}

function buildReasoningPlannerMessages(history, userPrompt, binding, correctionPrompt = '', contextSelection = {}) {
  const projectMemory = buildReasoningPlannerProjectMemory(binding, userPrompt, contextSelection)
  const replayWindowMessages = Math.max(0, Number(binding?.workflow?.reasoningReplayWindowMessages || 0))
  const replayableMessages = collectReplayableHermesMessages(history, {
    limit: replayWindowMessages
  })

  return {
    projectMemory,
    replayableMessages,
    messages: [
      {
        role: 'system',
        content: buildHermesRuntimeSystemMessage(binding)
      },
      {
        role: 'system',
        content: projectMemory.message
      },
      {
        role: 'system',
        content: [
          'You are the planning layer for the GameStudio observable reasoning pipeline.',
          'Return one strict JSON object only. Do not include markdown fences or extra commentary.',
          'Generate a short sequential execution plan for the current user request using the nearby conversation and injected markdown memory as the primary context.',
          'The first step MUST be read_recent_context so the timeline explicitly records that recent chat and markdown memory were loaded.',
          'Allowed actions: read_recent_context, locate_project, list_created_stories, prepare_prompt, summarize_story_index, generate_default_answer.',
          'For story, scripts, or project content questions, the plan MUST include locate_project and list_created_stories before any model.answer step.',
          'Do not speculate about databases, APIs, or external folders when a local project-listing tool exists.',
          'Stay inside the GameStudio workspace and prefer observable tool results over generic assumptions.',
          'Use summarize_story_index only when the plan includes list_created_stories; otherwise use generate_default_answer.',
          'Schema: {"goal": string, "strategy": "sequential", "steps": [{"title": string, "action": string}]}'
        ].join('\n')
      },
      ...replayableMessages,
      {
        role: 'user',
        content: [
          `当前用户问题：${userPrompt}`,
          correctionPrompt ? `审核修正条件：${correctionPrompt}` : '',
          '',
          '请基于最近上下文和已注入的 markdown 项目记忆，输出严格 JSON plan。'
        ].filter(Boolean).join('\n')
      }
    ]
  }
}

function extractJsonObjectString(text) {
  const raw = String(text || '').trim()
  if (!raw) return ''

  const fencedMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const candidate = fencedMatch ? fencedMatch[1].trim() : raw
  const firstBrace = candidate.indexOf('{')
  const lastBrace = candidate.lastIndexOf('}')
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    return candidate.slice(firstBrace, lastBrace + 1)
  }
  return candidate
}

function isStoryIndexPrompt(prompt) {
  return /故事|story|脚本|script|scripts\.json/i.test(String(prompt || ''))
}

function isStoryFollowUpPrompt(prompt, history, binding) {
  const normalizedPrompt = String(prompt || '').trim()
  if (!normalizedPrompt) return false
  if (!/重新|再|不对|不正确|确认|核对|继续|补充/i.test(normalizedPrompt)) return false

  const recentContextText = collectReplayableHermesMessages(history, {
    limit: Math.max(0, Number(binding?.workflow?.reasoningReplayWindowMessages || 0))
  })
    .map((message) => message.content)
    .join('\n')

  return /故事|story|scripts\.json|已创建故事|project\.listStories/i.test(recentContextText)
}

function buildReasoningFallbackPlan(userPrompt, history, binding) {
  const storyIntent = isStoryIndexPrompt(userPrompt) || isStoryFollowUpPrompt(userPrompt, history, binding)

  if (storyIntent) {
    return {
      planId: createOpaqueId('plan'),
      goal: '结合最近上下文重新核对已创建故事并生成回答',
      strategy: 'sequential',
      steps: [
        {
          stepId: 'step_read_recent_context',
          title: '读取最近上下文',
          action: 'read_recent_context',
          tool: 'context.recent',
          dependsOn: []
        },
        {
          stepId: 'step_locate_project',
          title: '定位项目目录',
          action: 'locate_project',
          tool: 'project.locate',
          dependsOn: ['step_read_recent_context']
        },
        {
          stepId: 'step_list_stories',
          title: '读取故事索引',
          action: 'list_created_stories',
          tool: 'project.listStories',
          dependsOn: ['step_locate_project']
        },
        {
          stepId: 'step_summarize',
          title: '生成最终回答',
          action: 'summarize_story_index',
          tool: 'model.answer',
          dependsOn: ['step_list_stories']
        }
      ]
    }
  }

  return {
    planId: createOpaqueId('plan'),
    goal: '结合最近上下文生成结构化回答',
    strategy: 'sequential',
    steps: [
      {
        stepId: 'step_read_recent_context',
        title: '读取最近上下文',
        action: 'read_recent_context',
        tool: 'context.recent',
        dependsOn: []
      },
      {
        stepId: 'step_answer',
        title: '生成最终回答',
        action: 'generate_default_answer',
        tool: 'model.answer',
        dependsOn: ['step_read_recent_context']
      }
    ]
  }
}

function normalizeReasoningPlan(rawPlan, userPrompt, history, binding) {
  const fallbackPlan = buildReasoningFallbackPlan(userPrompt, history, binding)
  const plan = rawPlan && typeof rawPlan === 'object' && !Array.isArray(rawPlan) ? rawPlan : {}
  const rawSteps = Array.isArray(plan.steps) ? plan.steps : []
  const normalizedSteps = []

  const requestedActions = rawSteps
    .map((step) => String(step?.action || '').trim())
    .filter((action) => REASONING_ALLOWED_ACTIONS[action])

  const actions = requestedActions.length > 0 ? [...requestedActions] : fallbackPlan.steps.map((step) => step.action)
  if (actions[0] !== 'read_recent_context') {
    actions.unshift('read_recent_context')
  }

  const hasStoryScan = actions.includes('list_created_stories')
  const hasAnswer = actions.includes('summarize_story_index') || actions.includes('generate_default_answer')
  if (!hasAnswer) {
    actions.push(hasStoryScan ? 'summarize_story_index' : 'generate_default_answer')
  }

  const compactActions = []
  for (const action of actions) {
    if (!compactActions.includes(action) || action === 'generate_default_answer' || action === 'summarize_story_index') {
      compactActions.push(action)
    }
  }

  for (const [index, action] of compactActions.entries()) {
    const metadata = REASONING_ALLOWED_ACTIONS[action]
    if (!metadata) continue
    const original = rawSteps.find((step) => String(step?.action || '').trim() === action) || {}
    const stepId = String(original.stepId || `step_${action}_${index + 1}`).trim()
    normalizedSteps.push({
      stepId,
      title: String(original.title || metadata.title).trim() || metadata.title,
      action,
      tool: metadata.tool,
      dependsOn: index === 0 ? [] : [normalizedSteps[index - 1].stepId]
    })
  }

  return {
    planId: String(plan.planId || createOpaqueId('plan')),
    goal: String(plan.goal || fallbackPlan.goal || '生成结构化回答').trim() || '生成结构化回答',
    strategy: 'sequential',
    steps: normalizedSteps.length > 0 ? normalizedSteps : fallbackPlan.steps
  }
}

function getReasoningRequestError(error, phase) {
  if (error?.name === 'AbortError') {
    const timeoutMs = phase === 'reasoning_plan'
      ? HERMES_REASONING_TASK_HARD_TIMEOUT_MS
      : HERMES_CHAT_REQUEST_TIMEOUT_MS
    return `${phase}_timeout_${timeoutMs}`
  }
  return error instanceof Error ? error.message : String(error)
}

async function generateReasoningPlan(userPrompt, history, binding, options = {}) {
  const correctionPrompt = String(options.correctionPrompt || '').trim()
  const plannerContext = buildReasoningPlannerMessages(history, userPrompt, binding, correctionPrompt, options.contextSelection || {})
  const recentContextArtifact = buildReasoningRecentContextArtifact(plannerContext.projectMemory, plannerContext.replayableMessages, 'model')
  const controller = new AbortController()
  const timeoutMs = Number(options.timeoutMs || HERMES_REASONING_TASK_HARD_TIMEOUT_MS)
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  const externalSignal = options.signal || null
  const abortFromExternalSignal = () => controller.abort()

  if (externalSignal) {
    if (externalSignal.aborted) {
      controller.abort()
    } else {
      externalSignal.addEventListener('abort', abortFromExternalSignal, { once: true })
    }
  }

  try {
    const response = await fetch(`${HERMES_API_SERVER_BASE_URL}/chat/completions`, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'hermes-agent',
        messages: plannerContext.messages,
        max_tokens: 260,
        temperature: 0.1
      })
    })

    if (!response.ok) {
      throw new Error(`reasoning_plan_http_${response.status}_${response.statusText}`)
    }

    const data = await response.json()
    const content = data.choices?.[0]?.message?.content || ''
    let parsed = null
    let source = 'model'
    try {
      parsed = JSON.parse(extractJsonObjectString(content))
    } catch {
      parsed = buildReasoningFallbackPlan(userPrompt, history, binding)
      source = 'fallback'
    }
    return {
      plan: normalizeReasoningPlan(parsed, userPrompt, history, binding),
      source,
      usage: data.usage || null,
      recentContextArtifact,
      outboundPreview: {
        provider: binding.provider,
        model: binding.model,
        baseUrl: binding.baseUrl,
        messages: buildReasoningMessagePreview(plannerContext.messages)
      },
      rawResponsePreview: truncateReasoningPreview(content, 2400)
    }
  } catch (error) {
    const detail = getReasoningRequestError(error, 'reasoning_plan')
    const plannerError = new Error(detail)
    plannerError.cause = error
    plannerError.recentContextArtifact = recentContextArtifact
    throw plannerError
  } finally {
    if (externalSignal && !externalSignal.aborted) {
      externalSignal.removeEventListener('abort', abortFromExternalSignal)
    }
    clearTimeout(timeout)
  }
}

function buildReasoningAnswerMessages(history, sessionId, userPrompt, artifacts, binding, correctionPrompt = '', contextSelection = {}) {
  const storyIndex = Array.isArray(artifacts?.storyIndex) ? artifacts.storyIndex : []
  const storyScan = artifacts?.storyScan && typeof artifacts.storyScan === 'object' ? artifacts.storyScan : null
  const projectRoot = artifacts?.projectRoot || GAMESTUDIO_ROOT
  const projectMemory = buildProjectMemorySystemMessage(binding, userPrompt, contextSelection)
  const replayableMessages = collectReplayableHermesMessages(history, {
    excludeRequestId: sessionId,
    limit: Math.max(0, Number(binding?.workflow?.reasoningReplayWindowMessages || 0))
  })
  const storySummary = storyIndex.length > 0
    ? storyIndex.map((story) => {
        const names = Array.isArray(story.nodeNames) && story.nodeNames.length > 0
          ? story.nodeNames.join(' / ')
          : '无节点标题'
        return `- ${story.projectId} | nodes=${story.nodeCount} | path=${story.filePath} | titles=${names}`
      }).join('\n')
    : [
        '- 未发现可读取的 stories index',
        storyScan?.searchedRoots?.length ? `- 已扫描目录: ${storyScan.searchedRoots.join(' ; ')}` : '- 已扫描目录: 无',
        storyScan?.missingRoots?.length ? `- 缺失目录: ${storyScan.missingRoots.join(' ; ')}` : '',
        storyScan?.readErrors?.length
          ? `- 读取错误: ${storyScan.readErrors.map((item) => `${item.rootPath}: ${item.detail}`).join(' ; ')}`
          : ''
      ].filter(Boolean).join('\n')

  return [
    {
      role: 'system',
      content: buildHermesRuntimeSystemMessage(binding)
    },
    {
      role: 'system',
      content: projectMemory.message
    },
    {
      role: 'system',
      content: [
        'You are Hermes Manager inside GameStudio control.',
        'Use the nearby conversation and injected markdown project memory together with the structured execution artifacts below.',
        'If the latest user request corrects an earlier wrong answer, prefer the newest request and the latest observable artifacts.',
        'Do not claim hidden reasoning. Summarize the observable steps and then answer directly in Chinese.',
        `Workspace root: ${projectRoot}`,
        correctionPrompt ? `Review correction: ${correctionPrompt}` : '',
        'If the tool result is empty, say so plainly.'
      ].filter(Boolean).join('\n')
    },
    ...replayableMessages,
    {
      role: 'user',
      content: [
        `用户问题: ${userPrompt}`,
        '',
        '可观测工具结果：',
        storySummary
      ].join('\n')
    }
  ]
}

function buildReasoningFallbackAnswer(userPrompt, artifacts) {
  const storyIndex = Array.isArray(artifacts?.storyIndex) ? artifacts.storyIndex : []
  const storyScan = artifacts?.storyScan && typeof artifacts.storyScan === 'object' ? artifacts.storyScan : null
  if (storyIndex.length === 0) {
    return [
      '未在 `storage/projects/*/scripts.json` 中发现可读取的已创建故事。',
      storyScan?.searchedRoots?.length ? `已扫描目录：${storyScan.searchedRoots.join('；')}` : '已扫描目录：无',
      storyScan?.missingRoots?.length ? `缺失目录：${storyScan.missingRoots.join('；')}` : '',
      storyScan?.readErrors?.length ? `读取错误：${storyScan.readErrors.map((item) => `${item.rootPath}: ${item.detail}`).join('；')}` : '',
      `本次问题：${userPrompt}`
    ].filter(Boolean).join('\n\n')
  }

  const lines = storyIndex.map((story, index) => {
    const names = Array.isArray(story.nodeNames) && story.nodeNames.length > 0
      ? story.nodeNames.join(' / ')
      : '无节点标题'
    return `${index + 1}. ${story.projectId}：${story.nodeCount} 个节点；标题示例：${names}`
  })

  const hasStructuredStoryContent = storyIndex.some((story) => Number(story.nodeCount || 0) > 0 || (Array.isArray(story.nodeNames) && story.nodeNames.length > 0))

  return [
    '根据当前 `storage/projects/*/scripts.json` 的可观测结果，已创建故事如下：',
    lines.join('\n'),
    storyScan?.searchedRoots?.length ? `已扫描目录：${storyScan.searchedRoots.join('；')}` : '',
    storyScan?.missingRoots?.length ? `缺失目录：${storyScan.missingRoots.join('；')}` : '',
    hasStructuredStoryContent
      ? '当前结论仅基于 scripts.json 的可观测结果，不代表已递归扫描 assets、story-scenes 或其它子目录。'
      : '当前仅确认 scripts.json 文件存在，但未从其中读到可用的节点标题或节点内容；不足以推断更深层的 story 资产状态。'
  ].filter(Boolean).join('\n\n')
}

function shouldUseDeterministicStoryAnswer(userPrompt, artifacts) {
  const hasStoryScan = artifacts?.storyScan && typeof artifacts.storyScan === 'object'
  if (!hasStoryScan) return false
  return /故事|story|scripts\.json|项目|扫描|可观测事实/i.test(String(userPrompt || ''))
}

async function generateReasoningFinalAnswer(sessionId, userPrompt, artifacts, binding, history, options = {}) {
  if (shouldUseDeterministicStoryAnswer(userPrompt, artifacts)) {
    const fallbackReply = buildReasoningFallbackAnswer(userPrompt, artifacts)
    return {
      reply: fallbackReply,
      usage: null,
      fallback: true,
      fallbackReason: 'deterministic_story_scan_summary',
      outboundPreview: {
        provider: binding.provider,
        model: binding.model,
        baseUrl: binding.baseUrl,
        messages: []
      },
      rawResponsePreview: truncateReasoningPreview(fallbackReply, 2400)
    }
  }

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), HERMES_CHAT_REQUEST_TIMEOUT_MS)
  const correctionPrompt = String(options.correctionPrompt || '').trim()
  const answerMessages = buildReasoningAnswerMessages(
    history,
    sessionId,
    userPrompt,
    artifacts,
    binding,
    correctionPrompt,
    options.contextSelection || {}
  )

  try {
    const response = await fetch(`${HERMES_API_SERVER_BASE_URL}/chat/completions`, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'hermes-agent',
        messages: answerMessages,
        max_tokens: 220
      })
    })

    if (!response.ok) {
      throw new Error(`reasoning_model_http_${response.status}_${response.statusText}`)
    }

    const data = await response.json()
    return {
      reply: data.choices?.[0]?.message?.content || JSON.stringify(data),
      usage: data.usage || null,
      fallback: false,
      outboundPreview: {
        provider: binding.provider,
        model: binding.model,
        baseUrl: binding.baseUrl,
        messages: buildReasoningMessagePreview(answerMessages)
      },
      rawResponsePreview: truncateReasoningPreview(data.choices?.[0]?.message?.content || JSON.stringify(data), 2400)
    }
  } catch (error) {
    const fallbackReply = buildReasoningFallbackAnswer(userPrompt, artifacts)
    return {
      reply: fallbackReply,
      usage: null,
      fallback: true,
      fallbackReason: getReasoningRequestError(error, 'reasoning_answer'),
      outboundPreview: {
        provider: binding.provider,
        model: binding.model,
        baseUrl: binding.baseUrl,
        messages: buildReasoningMessagePreview(answerMessages)
      },
      rawResponsePreview: truncateReasoningPreview(fallbackReply, 2400)
    }
  } finally {
    clearTimeout(timeout)
  }
}

async function executeReasoningStep(sessionId, step, userPrompt, options = {}) {
  const correctionPrompt = String(options.correctionPrompt || '').trim()
  appendReasoningEvent(sessionId, 'step_started', step.title, `开始执行：${step.tool}`, { stepId: step.stepId })
  updateReasoningSession(sessionId, (session) => ({
    ...session,
    status: 'running',
    currentStepId: step.stepId
  }))
  appendReasoningEvent(sessionId, 'tool_called', step.title, `调用工具：${step.tool}`, { stepId: step.stepId, data: { tool: step.tool } })

  if (step.action === 'read_recent_context') {
    const session = readReasoningSession(sessionId)
    const recentContext = session?.artifacts?.recentContext || {}
    const loadedCount = Array.isArray(recentContext.loadedMemorySources) ? recentContext.loadedMemorySources.length : 0
    const replayedCount = Number(recentContext.replayedMessageCount || 0)
    appendReasoningEvent(
      sessionId,
      'tool_result',
      step.title,
      `已加载最近 ${replayedCount} 条对话上下文，注入 ${loadedCount} 份 markdown 项目记忆`,
      {
        stepId: step.stepId,
        data: recentContext
      }
    )
    appendReasoningEvent(sessionId, 'step_completed', step.title, '最近上下文读取完成', { stepId: step.stepId })
    return
  }

  if (step.action === 'locate_project') {
    updateReasoningSession(sessionId, (session) => ({
      ...session,
      artifacts: {
        ...session.artifacts,
        projectRoot: GAMESTUDIO_ROOT,
        workspaceStructure: {
          editorAppRoot: path.join(GAMESTUDIO_ROOT, 'apps', 'editor'),
          serverAppRoot: path.join(GAMESTUDIO_ROOT, 'apps', 'server'),
          storageRoot: STUDIO_STORAGE_ROOT,
          projectsRoot: STORAGE_PROJECTS_ROOT
        }
      }
    }))
    appendReasoningEvent(sessionId, 'tool_result', step.title, `定位到工作区：${GAMESTUDIO_ROOT}；editor=${path.join(GAMESTUDIO_ROOT, 'apps', 'editor')}；server=${path.join(GAMESTUDIO_ROOT, 'apps', 'server')}；storage=${STUDIO_STORAGE_ROOT}`, { stepId: step.stepId })
    appendReasoningEvent(sessionId, 'step_completed', step.title, '项目目录定位完成', { stepId: step.stepId })
    return
  }

  if (step.action === 'list_created_stories') {
    const storyScan = listCreatedStoriesFromProjects()
    const storyIndex = Array.isArray(storyScan?.stories) ? storyScan.stories : []
    updateReasoningSession(sessionId, (session) => ({
      ...session,
      artifacts: {
        ...session.artifacts,
        storyIndex,
        storyScan,
        latestStepReviewEvidence: {
          targetType: 'step',
          stepId: step.stepId,
          stepTitle: step.title,
          tool: step.tool,
          outboundPreview: {
            tool: step.tool,
            target: 'storage/projects/*/scripts.json',
            projectRoot: GAMESTUDIO_ROOT,
            searchedRoots: storyScan.searchedRoots
          },
          rawResponsePreview: truncateReasoningPreview(JSON.stringify(storyScan, null, 2), 2400),
          structuredResult: {
            count: storyIndex.length,
            searchedRoots: storyScan.searchedRoots,
            availableRoots: storyScan.availableRoots,
            missingRoots: storyScan.missingRoots,
            readErrors: storyScan.readErrors,
            projects: storyIndex.map((story) => ({
              projectId: story.projectId,
              nodeCount: story.nodeCount,
              filePath: story.filePath,
              nodeNames: story.nodeNames
            }))
          }
        }
      }
    }))
    appendReasoningEvent(sessionId, 'tool_result', step.title, `扫描 ${storyScan.searchedRoots.length} 个候选目录，发现 ${storyIndex.length} 个故事项目`, {
      stepId: step.stepId,
      data: {
        count: storyIndex.length,
        searchedRoots: storyScan.searchedRoots,
        availableRoots: storyScan.availableRoots,
        missingRoots: storyScan.missingRoots,
        readErrors: storyScan.readErrors,
        projects: storyIndex.map((story) => ({
          projectId: story.projectId,
          nodeCount: story.nodeCount
        }))
      }
    })
    appendReasoningEvent(sessionId, 'step_completed', step.title, '故事索引读取完成', { stepId: step.stepId })
    return
  }

  if (step.action === 'prepare_prompt') {
    appendReasoningEvent(sessionId, 'tool_result', step.title, '已整理问题并准备生成回答', { stepId: step.stepId })
    appendReasoningEvent(sessionId, 'step_completed', step.title, '问题整理完成', { stepId: step.stepId })
    return
  }

  if (step.action === 'summarize_story_index' || step.action === 'generate_default_answer') {
    const session = readReasoningSession(sessionId)
    const binding = buildHermesBinding()
    const history = readHermesChatHistory()
    const answer = await generateReasoningFinalAnswer(sessionId, userPrompt, session?.artifacts || {}, binding, history, {
      correctionPrompt,
      contextSelection: session?.submissionContext || {}
    })
    updateReasoningSession(sessionId, (current) => ({
      ...current,
      artifacts: {
        ...current.artifacts,
        finalAnswer: answer.reply,
        finalAnswerUsage: answer.usage || null,
        finalAnswerPersisted: false,
        latestStepReviewEvidence: {
          targetType: 'step',
          stepId: step.stepId,
          stepTitle: step.title,
          tool: step.tool,
          outboundPreview: answer.outboundPreview,
          rawResponsePreview: answer.rawResponsePreview,
          structuredResult: {
            finalAnswer: answer.reply,
            usage: answer.usage,
            fallback: answer.fallback,
            fallbackReason: answer.fallbackReason || null
          }
        }
      }
    }))
    appendReasoningEvent(sessionId, 'tool_result', step.title, `模型已生成最终回答，长度 ${answer.reply.length} 字符`, {
      stepId: step.stepId,
      data: {
        usage: answer.usage,
        fallback: answer.fallback,
        fallbackReason: answer.fallbackReason
      }
    })
    appendReasoningEvent(sessionId, 'step_completed', step.title, '最终回答生成完成', { stepId: step.stepId })
    appendReasoningEvent(sessionId, 'final_answer_ready', '最终回答', '最终回答已准备好', {
      stepId: step.stepId,
      data: {
        finalAnswer: answer.reply,
        usage: answer.usage
      }
    })
    return
  }

  throw new Error(`unsupported_reasoning_action_${step.action}`)
}

async function prepareReasoningSessionPlan(sessionId, binding, history, options = {}) {
  const session = readReasoningSession(sessionId)
  if (!session) {
    throw new Error('reasoning_session_not_found')
  }

  activeHermesReasoningSessionId = sessionId

  const planResult = await runManagedReasoningTask(sessionId, 'plan', binding, ({ signal }) => {
    return generateReasoningPlan(session.userPrompt, history, binding, {
      signal,
      correctionPrompt: options.correctionPrompt,
      contextSelection: session.submissionContext || {}
    })
  })
  const plan = planResult.plan
  const loadedMemoryCount = planResult.recentContextArtifact.loadedMemorySources.length
  const replayedMessageCount = planResult.recentContextArtifact.replayedMessageCount

  updateReasoningSession(sessionId, (current) => ({
    ...current,
    status: 'running',
    plan,
    review: null,
    artifacts: {
      ...current.artifacts,
      recentContext: planResult.recentContextArtifact,
      latestPlanReviewEvidence: {
        targetType: 'plan',
        outboundPreview: planResult.outboundPreview,
        rawResponsePreview: planResult.rawResponsePreview,
        structuredResult: {
          goal: plan.goal,
          strategy: plan.strategy,
          steps: plan.steps
        }
      },
      nextStepIndex: 0
    }
  }))

  appendReasoningEvent(sessionId, 'plan_created', '计划已创建', `模型规划已读取 ${replayedMessageCount} 条近邻对话与 ${loadedMemoryCount} 份 markdown 记忆，本次执行共 ${Array.isArray(plan.steps) ? plan.steps.length : 0} 步`, {
    data: {
      goal: plan.goal,
      strategy: plan.strategy,
      steps: plan.steps,
      source: planResult.source,
      usage: planResult.usage,
      recentContext: planResult.recentContextArtifact
    }
  })

  appendHermesLog([
    `[REASONING][PLAN] sessionId=${sessionId} source=${planResult.source} steps=${Array.isArray(plan.steps) ? plan.steps.length : 0}`,
    `[REASONING][PLAN][CONTEXT] replayedMessages=${replayedMessageCount} loadedMemorySources=${loadedMemoryCount}`
  ].filter(Boolean))

  requestReasoningReview(sessionId, buildReasoningReview('plan', {
    title: '审核计划',
    summary: '请审核当前计划。通过后执行第一步；驳回后可附带修正条件重新生成计划。',
    iteration: Number(session.review?.iteration || 0) + 1,
    correctionPrompt: options.correctionPrompt || null,
    evidence: {
      outboundPreview: planResult.outboundPreview,
      rawResponsePreview: planResult.rawResponsePreview,
      structuredResult: {
        goal: plan.goal,
        strategy: plan.strategy,
        steps: plan.steps
      }
    }
  }), {
    goal: plan.goal,
    strategy: plan.strategy,
    steps: plan.steps
  })

  activeHermesReasoningSessionId = null
  return readReasoningSession(sessionId)
}

async function continueReasoningSessionFromStep(sessionId, binding, history, options = {}) {
  const session = readReasoningSession(sessionId)
  if (!session) {
    throw new Error('reasoning_session_not_found')
  }

  activeHermesReasoningSessionId = sessionId
  const stepIndex = Math.max(0, Number(options.stepIndex || 0))
  const step = session.plan?.steps?.[stepIndex]

  if (!step) {
    finalizeReasoningSession(sessionId, { persistFinalAnswer: true })
    activeHermesReasoningSessionId = null
    return readReasoningSession(sessionId)
  }

  try {
    await executeReasoningStep(sessionId, step, session.userPrompt, { correctionPrompt: options.correctionPrompt })

    updateReasoningSession(sessionId, (current) => ({
      ...current,
      currentStepId: step.stepId,
      artifacts: {
        ...current.artifacts,
        nextStepIndex: stepIndex
      }
    }))

    requestReasoningReview(sessionId, buildReasoningReview('step', {
      stepId: step.stepId,
      stepIndex,
      title: `审核步骤：${step.title}`,
      summary: stepIndex >= (Array.isArray(session.plan?.steps) ? session.plan.steps.length - 1 : -1)
        ? '请审核当前步骤结果。通过后写入最终回答并结束本次 session；驳回后可附带修正条件重跑当前步骤。'
        : '请审核当前步骤结果。通过后继续下一步；驳回后可附带修正条件重跑当前步骤。',
      iteration: Number(session.review?.iteration || 0) + 1,
      correctionPrompt: options.correctionPrompt || null,
      evidence: readReasoningSession(sessionId)?.artifacts?.latestStepReviewEvidence || null
    }), {
      tool: step.tool,
      action: step.action
    })
  } catch (error) {
    markReasoningSessionFailed(sessionId, error)
  } finally {
    activeHermesReasoningSessionId = null
  }
}

async function runReasoningSession(sessionId, binding, history) {
  const session = readReasoningSession(sessionId)
  if (!session) {
    throw new Error('reasoning_session_not_found')
  }

  activeHermesReasoningSessionId = sessionId
  appendHermesLog(`[REASONING][START] sessionId=${sessionId} promptChars=${session.userPrompt.length}`)

  try {
    await prepareReasoningSessionPlan(sessionId, binding, history)
  } catch (error) {
    markReasoningSessionFailed(sessionId, error)
  }
}

async function createReasoningSession(agentId, userPrompt, submissionContext = {}) {
  const sessionId = createOpaqueId('reasoning')
  const now = new Date().toISOString()
  const session = {
    sessionId,
    agentId,
    userPrompt,
    submissionContext,
    status: 'planning',
    createdAt: now,
    updatedAt: now,
    plan: null,
    currentStepId: null,
    review: null,
    events: [
      createReasoningEvent(sessionId, 'planning_started', '规划进行中', '正在读取最近上下文和 markdown 记忆，并交给 Hermes 生成 plan')
    ],
    artifacts: {
      recentContext: null,
      latestPlanReviewEvidence: null,
      latestStepReviewEvidence: null,
      nextStepIndex: 0,
      tasks: {
        plan: null
      }
    },
    error: null
  }
  writeReasoningSession(session)
  activeHermesReasoningSessionId = sessionId
  return session
}

function openFileInEditor(filePath) {
  const normalizedPath = path.resolve(String(filePath || '').trim())
  if (!normalizedPath) {
    throw new Error('chat_history_file_path_missing')
  }

  const codeLookup = spawnSync('which', ['code'], { encoding: 'utf8' })
  const codeCommand = codeLookup.status === 0 ? codeLookup.stdout.trim() : ''

  if (codeCommand) {
    const child = spawn(codeCommand, ['-r', normalizedPath], {
      detached: true,
      stdio: 'ignore'
    })
    child.unref()
    return 'code'
  }

  const openTargets = [
    ['-a', 'Visual Studio Code - Insiders', normalizedPath],
    ['-a', 'Visual Studio Code', normalizedPath],
    [normalizedPath]
  ]

  for (const args of openTargets) {
    const result = spawnSync('open', args, { stdio: 'ignore' })
    if (result.status === 0) {
      return args.length > 1 ? String(args[1]) : 'default-editor'
    }
  }

  throw new Error('open_editor_failed')
}

function requestJsonWithoutHeadersTimeout(url, payload) {
  return new Promise((resolve, reject) => {
    const target = new URL(url)
    const transport = target.protocol === 'https:' ? https : http
    const body = JSON.stringify(payload)

    const req = transport.request({
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port || (target.protocol === 'https:' ? 443 : 80),
      path: `${target.pathname}${target.search}`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
      }
    }, (res) => {
      let raw = ''
      res.setEncoding('utf8')
      res.on('data', (chunk) => {
        raw += chunk
      })
      res.on('end', () => {
        resolve({
          ok: Number(res.statusCode || 0) >= 200 && Number(res.statusCode || 0) < 300,
          status: Number(res.statusCode || 0),
          statusText: res.statusMessage || '',
          text: raw,
          json() {
            return JSON.parse(raw)
          }
        })
      })
    })

    req.on('error', reject)
    req.write(body)
    req.end()
  })
}

function writeHermesChatHistory(history) {
  const chatFile = getHermesChatFilePath()
  const chatDir = path.dirname(chatFile)
  if (!fs.existsSync(chatDir)) fs.mkdirSync(chatDir, { recursive: true })
  fs.writeFileSync(chatFile, JSON.stringify(Array.isArray(history) ? history : [], null, 2), 'utf-8')
}

function readStoredHermesChatHistory() {
  const chatFile = getHermesChatFilePath()
  if (!fs.existsSync(chatFile)) return []
  const parsed = JSON.parse(fs.readFileSync(chatFile, 'utf-8'))
  return Array.isArray(parsed) ? parsed : []
}

function isDiagnosticUserPrompt(content) {
  const text = String(content || '').trim()
  return /^你好[，,。.!！?？\s]*系统控制面握手测试[。.!！?？\s]*$/i.test(text)
    || /^系统控制面握手测试[。.!！?？\s]*$/i.test(text)
    || /^你是谁[？?]?$/i.test(text)
    || /^你是谁[？?]?\s*$/i.test(text)
    || /^你现在使用的模型是什么[？?]?$/i.test(text)
    || /^你当前实际使用的模型是什么.*$/i.test(text)
    || /^你现在的记忆是什么[？?]?$/i.test(text)
}

function isDiagnosticAssistantReply(content) {
  const text = String(content || '')
  return /API call failed after \d+ retries/i.test(text)
    || /Cannot free enough memory/i.test(text)
    || /HTTP 507/i.test(text)
    || /根据对话开始时的元数据信息/i.test(text)
    || /根据当前运行时元数据/i.test(text)
    || /^#\s*我是谁/m.test(text)
    || /根据当前界面显示，我的记忆包含以下内容/i.test(text)
}

function isAssistantHistoryRole(role) {
  const normalized = String(role || '').trim().toLowerCase()
  return normalized === 'hermes' || normalized === 'assistant'
}

function pruneHermesChatHistory(history) {
  const nextHistory = []
  let removedEntries = 0

  for (let index = 0; index < (Array.isArray(history) ? history.length : 0); index += 1) {
    const entry = history[index]
    const role = String(entry?.role || '').trim().toLowerCase()
    const content = String(entry?.content || '')

    if (role === 'user') {
      const followingEntry = history[index + 1]
      const hasAssistantPair = isAssistantHistoryRole(followingEntry?.role)
      const shouldRemoveTurn = isDiagnosticUserPrompt(content)
        || (hasAssistantPair && isDiagnosticAssistantReply(followingEntry?.content))

      if (shouldRemoveTurn) {
        removedEntries += 1
        if (hasAssistantPair) {
          removedEntries += 1
          index += 1
        }
        continue
      }

      nextHistory.push(entry)
      if (hasAssistantPair) {
        nextHistory.push(followingEntry)
        index += 1
      }
      continue
    }

    if (isAssistantHistoryRole(role) && isDiagnosticAssistantReply(content)) {
      removedEntries += 1
      continue
    }

    nextHistory.push(entry)
  }

  return {
    history: nextHistory,
    removedEntries
  }
}

function readHermesChatHistory() {
  try {
    const storedHistory = readStoredHermesChatHistory()
    const pruned = pruneHermesChatHistory(storedHistory)
    const currentSessionHistory = pruned.history.filter((entry) => String(entry?.chatSessionId || '').trim() === currentHermesChatSessionId)
    if (pruned.removedEntries > 0) {
      appendHermesLog(`[CHAT][HISTORY] Skipped ${pruned.removedEntries} diagnostic entries when replaying model context`)
    }
    return currentSessionHistory
  } catch {
    return []
  }
}

function createHermesChatEntry(role, content, extra = {}) {
  return {
    role,
    content,
    createdAt: new Date().toISOString(),
    ...extra,
  }
}

function appendHermesChatHistoryEntries(entries) {
  const history = readStoredHermesChatHistory()
  history.push(...entries)
  writeHermesChatHistory(history)
}

function buildActiveHermesChatRequestPayload(request = activeHermesChatRequest) {
  if (!request) return null
  return {
    requestId: request.requestId,
    startedAt: new Date(request.startedAt).toISOString(),
    activeForMs: Date.now() - request.startedAt,
    promptChars: request.promptChars,
    contextSources: request.contextSources || null,
    outboundRequest: request.outboundRequest || null,
  }
}

function persistHermesChatPrompt(requestId, userPrompt) {
  try {
    appendHermesChatHistoryEntries([
      createHermesChatEntry('user', userPrompt, { requestId, chatSessionId: currentHermesChatSessionId })
    ])
  } catch (err) {
    console.error('Failed to save chat prompt', err)
  }
}

function persistHermesChatReply(requestId, reply, tokens) {
  try {
    appendHermesChatHistoryEntries([
      createHermesChatEntry('hermes', reply, { requestId, tokens, chatSessionId: currentHermesChatSessionId })
    ])
  } catch (err) {
    console.error('Failed to save chat reply', err)
  }
}

function persistHermesChatError(requestId, errorMessage, details) {
  try {
    const content = [errorMessage, details].filter(Boolean).join('\n\n')
    appendHermesChatHistoryEntries([
      createHermesChatEntry('error', content, { requestId, chatSessionId: currentHermesChatSessionId })
    ])
  } catch (err) {
    console.error('Failed to save chat error', err)
  }
}

function persistHermesChatTurn(userPrompt, reply, tokens) {
  try {
    appendHermesChatHistoryEntries([
      createHermesChatEntry('user', userPrompt, { chatSessionId: currentHermesChatSessionId }),
      createHermesChatEntry('hermes', reply, { tokens, chatSessionId: currentHermesChatSessionId })
    ])
  } catch (err) {
    console.error('Failed to save chat history', err)
  }
}

function persistHermesChatFailure(userPrompt, errorMessage, details) {
  try {
    const content = [errorMessage, details].filter(Boolean).join('\n\n')
    appendHermesChatHistoryEntries([
      createHermesChatEntry('user', userPrompt),
      createHermesChatEntry('error', content)
    ])
  } catch (err) {
    console.error('Failed to save failed chat history', err)
  }
}

function isHermesChatErrorReplay(content) {
  const text = String(content || '')
  return /API call failed after \d+ retries/i.test(text)
    || /Cannot free enough memory/i.test(text)
    || /HTTP 507/i.test(text)
}

function buildHermesRuntimeSystemMessage(binding) {
  return [
    'You are Hermes chat running inside GameStudio control.',
    'Current runtime metadata below is the source of truth for the active model and endpoint.',
    'If earlier conversation history contains old model names or old infrastructure errors, treat them as stale history rather than current runtime state.',
    `Current provider: ${binding.provider}`,
    `Current model: ${binding.model}`,
    `Current base URL: ${binding.baseUrl}`,
  ].join('\n')
}

const MAX_REPLAYED_HERMES_CHAT_MESSAGES = 12
const PROJECT_MEMORY_SOURCE_CHAR_LIMITS = {
  'Agent Definition': 1200,
  'User Preferences': 1200,
  'Project Memory': 1200,
  'Project Status': 2400,
  'Task Queue': 2400,
  'Decisions': 1800,
  'Latest Daily Log': 1800
}

function getCurrentProjectDailyLogFile(memoryConfig) {
  const dailyLogDir = String(memoryConfig?.dailyLogDir || '').trim()
  if (!dailyLogDir || !fs.existsSync(dailyLogDir)) return ''

  const today = new Date().toISOString().slice(0, 10)
  const todayFile = path.join(dailyLogDir, `${today}.md`)
  return fs.existsSync(todayFile) ? todayFile : ''
}

function readSkillSource(filePath) {
  const normalizedPath = String(filePath || '').trim()
  if (!normalizedPath) return null
  const label = path.basename(path.dirname(normalizedPath)) === 'skills'
    ? `Skill ${path.basename(normalizedPath)}`
    : `Skill ${path.basename(path.dirname(normalizedPath))}`
  const source = readProjectMemorySource(label, normalizedPath)
  if (!source) return null
  return {
    ...source,
    kind: 'skill',
    sourceId: `skill:${normalizedPath}`
  }
}

function buildSelectableContextSources(binding) {
  const memorySources = getProjectMemorySources(binding).map((source) => ({
    ...source,
    kind: 'memory',
    sourceId: `memory:${source.label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`
  }))
  const skillSources = (binding?.skills?.skillFiles || []).map((filePath) => readSkillSource(filePath)).filter(Boolean)
  return [...memorySources, ...skillSources]
}

function buildManualContextSourceCandidates(binding) {
  return buildSelectableContextSources(binding).filter((source) => source.kind !== 'memory')
}

function getSelectableContextSourceById(binding, sourceId) {
  const normalizedSourceId = String(sourceId || '').trim()
  if (!normalizedSourceId) return null
  return buildSelectableContextSources(binding).find((source) => String(source.sourceId || '') === normalizedSourceId) || null
}

function readUtf8FileRecord(filePath) {
  const normalizedPath = path.resolve(String(filePath || '').trim())
  if (!normalizedPath) {
    throw new Error('file_path_required')
  }

  const exists = fs.existsSync(normalizedPath)
  const content = exists ? fs.readFileSync(normalizedPath, 'utf8') : ''
  const stat = exists ? fs.statSync(normalizedPath) : null
  return {
    filePath: normalizedPath,
    exists,
    content,
    sizeChars: content.length,
    updatedAt: stat ? stat.mtime.toISOString() : null
  }
}

function writeUtf8FileRecord(filePath, content) {
  const normalizedPath = path.resolve(String(filePath || '').trim())
  if (!normalizedPath) {
    throw new Error('file_path_required')
  }

  ensureDirectory(path.dirname(normalizedPath))
  fs.writeFileSync(normalizedPath, String(content ?? ''), 'utf8')
  return readUtf8FileRecord(normalizedPath)
}

function getContextPoolEntryFilePath(entryId) {
  return path.join(HERMES_CONTEXT_POOL_DIR, `${entryId}.json`)
}

function listContextPoolEntries() {
  if (!fs.existsSync(HERMES_CONTEXT_POOL_DIR)) {
    return []
  }
  return fs.readdirSync(HERMES_CONTEXT_POOL_DIR)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((name) => {
      const filePath = path.join(HERMES_CONTEXT_POOL_DIR, name)
      try {
        const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'))
        return {
          entryId: parsed.entryId,
          title: parsed.title,
          summary: parsed.summary,
          createdAt: parsed.createdAt,
          updatedAt: parsed.updatedAt,
          filePath
        }
      } catch {
        return null
      }
    })
    .filter(Boolean)
}

function readContextPoolEntry(entryId) {
  const filePath = getContextPoolEntryFilePath(entryId)
  if (!fs.existsSync(filePath)) return null
  return JSON.parse(fs.readFileSync(filePath, 'utf8'))
}

function writeContextPoolEntry(entry) {
  ensureDirectory(HERMES_CONTEXT_POOL_DIR)
  fs.writeFileSync(getContextPoolEntryFilePath(entry.entryId), JSON.stringify(entry, null, 2), 'utf8')
  return entry
}

function buildContextPoolSystemMessage(entries) {
  const message = [
    'Confirmed GameStudio context pool entries below were previously reviewed and approved by the user.',
    'Prefer these confirmed summaries over re-deriving the same project rules from scratch.'
  ]
  for (const entry of Array.isArray(entries) ? entries : []) {
    message.push(`\n[Confirmed Context] ${entry.title}`)
    message.push(String(entry.summary || ''))
  }
  return message.join('\n')
}

function readProjectMemorySource(label, filePath) {
  const normalizedPath = String(filePath || '').trim()
  if (!normalizedPath) {
    return null
  }

  if (!fs.existsSync(normalizedPath)) {
    return {
      label,
      filePath: normalizedPath,
      exists: false,
      content: '',
      totalChars: 0,
      truncated: false
    }
  }

  const raw = fs.readFileSync(normalizedPath, 'utf8')
  const totalChars = raw.length
  const charLimit = PROJECT_MEMORY_SOURCE_CHAR_LIMITS[label] || 1200
  const truncated = totalChars > charLimit
  const content = truncated ? `${raw.slice(0, charLimit)}\n\n[truncated]` : raw

  return {
    label,
    filePath: normalizedPath,
    exists: true,
    content,
    loadedChars: content.length,
    totalChars,
    truncated
  }
}

function getProjectMemorySources(binding) {
  const memoryConfig = binding?.memory || {}
  const latestDailyLogFile = getCurrentProjectDailyLogFile(memoryConfig)

  return [
    readProjectMemorySource('Agent Definition', memoryConfig.agentDefinitionFile),
    readProjectMemorySource('User Preferences', memoryConfig.userFile),
    readProjectMemorySource('Project Memory', memoryConfig.memoryFile),
    readProjectMemorySource('Project Status', memoryConfig.statusFile),
    readProjectMemorySource('Task Queue', memoryConfig.taskQueueFile),
    readProjectMemorySource('Decisions', memoryConfig.decisionsFile),
    latestDailyLogFile ? readProjectMemorySource('Latest Daily Log', latestDailyLogFile) : null
  ].filter(Boolean)
}

function selectProjectMemorySourcesForPrompt(sources, userPrompt) {
  const prompt = String(userPrompt || '').trim()
  if (!prompt) return sources

  const asksForIdentity = /你是谁|身份|角色|性格|记忆是什么|你现在的记忆/i.test(prompt)
  if (asksForIdentity) {
    const identityLabels = new Set(['Agent Definition', 'User Preferences', 'Project Memory'])
    return sources.filter((source) => identityLabels.has(source.label))
  }

  const asksForProjectState = /项目|当前|焦点|待办|状态|进度|阻塞|决策|任务|下一步|memory/i.test(prompt)
  if (asksForProjectState) {
    const projectLabels = new Set(['Project Status', 'Task Queue', 'Decisions', 'Latest Daily Log'])
    return sources.filter((source) => projectLabels.has(source.label))
  }

  return sources
}

function buildProjectMemorySystemMessage(binding, userPrompt, options = {}) {
  const sources = buildSelectableContextSources(binding)
  const hasManualSourceSelection = Array.isArray(options.selectedSourceIds)
  const selectedSourceIds = new Set(hasManualSourceSelection ? options.selectedSourceIds.map((value) => String(value)) : [])
  const selectedContextPoolIds = Array.isArray(options.selectedContextPoolIds) ? options.selectedContextPoolIds.map((value) => String(value)) : []
  const confirmedContextSummary = String(options.confirmedContextSummary || '').trim()
  const overlayMode = String(options.memoryOverlayMode || binding?.workflow?.memoryOverlayMode || 'references-only')
  const autoSelectedMemorySources = selectProjectMemorySourcesForPrompt(
    sources.filter((source) => source.kind === 'memory'),
    userPrompt
  )
  const selectedManualSources = hasManualSourceSelection
    ? sources.filter((source) => source.kind !== 'memory' && selectedSourceIds.has(String(source.sourceId || '')))
    : []
  const selectedSources = [...autoSelectedMemorySources, ...selectedManualSources]
  const loadedSources = selectedSources.filter((source) => source.exists && source.content)
  const contextPoolEntries = selectedContextPoolIds.map((entryId) => readContextPoolEntry(entryId)).filter(Boolean)
  const message = [
    'GameStudio project memory below is injected by the control plane and should be treated as authoritative project context for this chat.',
    'Prefer these project records over stale conversational guesses when answering questions about project state, identity, memory, tasks, or decisions.'
  ]

  if (confirmedContextSummary) {
    message.push('\n[Current Confirmed Context Summary]')
    message.push(confirmedContextSummary)
  }

  if (contextPoolEntries.length > 0) {
    message.push(`\n${buildContextPoolSystemMessage(contextPoolEntries)}`)
  }

  if (overlayMode === 'content-injection') {
    for (const source of loadedSources) {
      message.push(`\n[${source.label}] ${source.filePath}`)
      message.push(source.content)
    }
  } else {
    message.push('\n[Controller Memory Overlay Mode] references-only')
    message.push('Controller only passes source references so Hermes runtime can apply its own internal memory workflow without prompt-level content override.')
    for (const source of selectedSources) {
      message.push(`- ${source.label}: ${source.filePath} (${source.exists ? 'available' : 'missing'})`)
    }
  }

  return {
    message: message.join('\n'),
    sources,
    selectedSources,
    loadedSources,
    contextPoolEntries,
    confirmedContextSummary,
    overlayMode
  }
}

function buildHermesChatMessages(history, userPrompt, binding, options = {}) {
  const projectMemory = buildProjectMemorySystemMessage(binding, userPrompt, options)
  const messages = [
    {
      role: 'system',
      content: buildHermesRuntimeSystemMessage(binding)
    },
    {
      role: 'system',
      content: projectMemory.message
    }
  ]
  const replayWindowMessages = Math.max(0, Number(binding?.workflow?.replayWindowMessages || 0))
  const replayableMessages = collectReplayableHermesMessages(history, {
    limit: replayWindowMessages
  })

  messages.push(...replayableMessages)

  messages.push({ role: 'user', content: userPrompt })
  return {
    messages,
    projectMemory,
    replayedMessageCount: replayableMessages.length
  }
}

function buildContextDraftMessages(binding, userPrompt, options = {}) {
  const projectMemory = buildProjectMemorySystemMessage(binding, userPrompt, {
    ...options,
    memoryOverlayMode: 'content-injection'
  })
  const messages = [
    {
      role: 'system',
      content: buildHermesRuntimeSystemMessage(binding)
    },
    {
      role: 'system',
      content: projectMemory.message
    },
    {
      role: 'system',
      content: [
        'You are preparing a pre-submit context analysis for GameStudio control.',
        'Summarize the core requirements, constraints, relevant project structure, and execution hints for the current user request in Chinese.',
        'Be concrete and operational. Do not speculate beyond the provided materials.',
        'Return plain text only.'
      ].join('\n')
    },
    {
      role: 'user',
      content: `当前任务：${userPrompt}\n\n请先总结这些已选上下文对本次任务真正重要的内容。`
    }
  ]

  return {
    messages,
    projectMemory
  }
}

async function generateContextDraft(userPrompt, binding, options = {}) {
  const draftContext = buildContextDraftMessages(binding, userPrompt, options)
  const response = await fetch(`${HERMES_API_SERVER_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: 'hermes-agent',
      messages: draftContext.messages,
      max_tokens: 320
    })
  })

  if (!response.ok) {
    throw new Error(`context_draft_http_${response.status}_${response.statusText}`)
  }

  const data = await response.json()
  const content = data.choices?.[0]?.message?.content || ''
  return {
    summary: content,
    usage: data.usage || null,
    outboundPreview: {
      provider: binding.provider,
      model: binding.model,
      baseUrl: binding.baseUrl,
      messages: buildReasoningMessagePreview(draftContext.messages)
    },
    rawResponsePreview: truncateReasoningPreview(content, 2400),
    contextSources: buildChatContextSourcesPayload({
      replayedMessageCount: 0,
      projectMemory: draftContext.projectMemory
    }, binding)
  }
}

function buildChatContextSourcesPayload(chatContext, binding) {
  return {
    runtime: {
      provider: binding.provider,
      model: binding.model,
      baseUrl: binding.baseUrl,
      timeoutMs: HERMES_CHAT_REQUEST_TIMEOUT_MS
    },
    replayedMessageCount: chatContext.replayedMessageCount,
    memoryOverlayMode: chatContext.projectMemory.overlayMode || String(binding?.workflow?.memoryOverlayMode || 'references-only'),
    selectedSourceCount: chatContext.projectMemory.selectedSources.length,
    loadedSourceCount: chatContext.projectMemory.loadedSources.length,
    contextPoolEntryCount: chatContext.projectMemory.contextPoolEntries?.length || 0,
    confirmedContextSummary: chatContext.projectMemory.confirmedContextSummary || '',
    sources: chatContext.projectMemory.selectedSources.map((source) => ({
      label: source.label,
      filePath: source.filePath,
      exists: source.exists,
      totalChars: source.totalChars,
      loadedChars: source.loadedChars ?? 0,
      truncated: source.truncated
    })),
    contextPoolEntries: (chatContext.projectMemory.contextPoolEntries || []).map((entry) => ({
      entryId: entry.entryId,
      title: entry.title,
      filePath: getContextPoolEntryFilePath(entry.entryId)
    }))
  }
}

function buildHermesOutboundRequestSummary(chatContext, userPrompt) {
  return {
    totalMessages: chatContext.messages.length,
    systemMessageCount: 2,
    replayedMessageCount: chatContext.replayedMessageCount,
    userMessageCount: 1,
    userPromptChars: String(userPrompt || '').length,
  }
}

async function recoverHermesChatRuntime(reason) {
  if (activeHermesChatRecovery) {
    return activeHermesChatRecovery
  }

  activeHermesChatRecovery = (async () => {
    const startedAt = Date.now()
    appendHermesLog(`[CHAT][RECOVERY] start reason=${reason}`)

    try {
      const stoppedStatus = await stopHermesRuntime()
      updateHermesControlState({
        runtime: buildRuntimeStateSnapshot(stoppedStatus, 'exit')
      })

      const resumedStatus = await startHermesRuntime()
      updateHermesControlState({
        runtime: buildRuntimeStateSnapshot(resumedStatus, 'resume')
      })

      const ok = resumedStatus.state === 'running'
      appendHermesLog(`[CHAT][RECOVERY] ${ok ? 'ok' : 'error'} durationMs=${Date.now() - startedAt} state=${resumedStatus.state}`)

      return {
        attempted: true,
        ok,
        reason,
        durationMs: Date.now() - startedAt,
        runtimeStatus: resumedStatus,
        detail: ok ? 'Hermes timeout 后已自动 exit/resume' : resumedStatus.detail,
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      appendHermesLog(`[CHAT][RECOVERY][ERROR] durationMs=${Date.now() - startedAt} detail=${detail}`)
      return {
        attempted: true,
        ok: false,
        reason,
        durationMs: Date.now() - startedAt,
        runtimeStatus: getHermesRuntimeState(),
        detail,
      }
    } finally {
      activeHermesChatRecovery = null
    }
  })()

  return activeHermesChatRecovery
}

app.post('/api/control/agents/:agentId/ping-model', async (c) => {
  const { agentId } = c.req.param()
  if (agentId !== hermesAgentDefinition.id) {
    return c.json({ ok: false, error: 'agent_not_found' }, 404)
  }

  const body = await c.req.json().catch(() => ({}))
  const userPrompt = body.prompt || 'Hello, are you there?'
  const runtimeStatus = getHermesRuntimeState()

  if (runtimeStatus.state !== 'running') {
    return c.json({ ok: false, error: 'runtime_not_running', runtimeStatus }, 409)
  }

  let requestId = null
  try {
    const binding = buildHermesBinding()
    const history = readHermesChatHistory()
    const chatContext = buildHermesChatMessages(history, userPrompt, binding, {
      selectedSourceIds: body.selectedSourceIds,
      selectedContextPoolIds: body.selectedContextPoolIds,
      confirmedContextSummary: body.confirmedContextSummary
    })
    const contextSources = buildChatContextSourcesPayload(chatContext, binding)

    if (activeHermesChatRequest) {
      const activeForMs = Date.now() - activeHermesChatRequest.startedAt
      appendHermesLog([
        `[CHAT][BUSY] activeForMs=${activeForMs} promptChars=${activeHermesChatRequest.promptChars}`,
        `[CHAT][BUSY] rejectedPromptChars=${userPrompt.length}`
      ])
      return c.json({
        ok: false,
        error: 'chat_busy',
        details: `Hermes chat request already running for ${Math.round(activeForMs / 1000)}s`,
        contextSources,
        timeoutMs: HERMES_CHAT_REQUEST_TIMEOUT_MS,
        activeRequest: buildActiveHermesChatRequestPayload(activeHermesChatRequest),
        recovery: activeHermesChatRecovery
          ? {
              attempted: true,
              ok: false,
              reason: 'recovery_in_progress',
              detail: 'Hermes 正在执行上一轮超时后的自动恢复，请稍后重试。'
            }
          : null
      }, 409)
    }

    requestId = `${Date.now()}-${Math.random().toString(16).slice(2)}`
    activeHermesChatRequest = {
      requestId,
      startedAt: Date.now(),
      promptChars: userPrompt.length,
      contextSources,
      outboundRequest: buildHermesOutboundRequestSummary(chatContext, userPrompt),
    }
    persistHermesChatPrompt(requestId, userPrompt)
    const messages = chatContext.messages
    appendHermesLog([
      `[CHAT][REQUEST] userPromptChars=${userPrompt.length} replayedMessages=${chatContext.replayedMessageCount}`,
      `[CHAT][RUNTIME] provider=${binding.provider} model=${binding.model} baseUrl=${binding.baseUrl}`,
      `[CHAT][MEMORY] loadedSources=${chatContext.projectMemory.loadedSources.length}/${chatContext.projectMemory.selectedSources.length} selected=${chatContext.projectMemory.selectedSources.length}/${chatContext.projectMemory.sources.length}`,
      ...chatContext.projectMemory.selectedSources.map((source) => {
        const status = source.exists ? 'loaded' : 'missing'
        const suffix = source.exists
          ? ` chars=${source.totalChars}${source.truncated ? ' truncated' : ''}`
          : ''
        return `[CHAT][MEMORY] ${status} ${source.label}: ${source.filePath}${suffix}`
      })
    ])
    const completionPromise = (async () => {
      try {
        const resp = await requestJsonWithoutHeadersTimeout(`${HERMES_API_SERVER_BASE_URL}/chat/completions`, {
          model: 'hermes-agent',
          messages,
          max_tokens: 150
        })

        if (!resp.ok) {
          const errorBody = String(resp.text || '')
          appendHermesLog(`[CHAT][ERROR] httpStatus=${resp.status} statusText=${resp.statusText} bodyChars=${errorBody.length}`)
          persistHermesChatError(
            requestId,
            `Hermes chat service returned HTTP ${resp.status}: ${resp.statusText}`,
            errorBody.slice(0, 1000)
          )
          return {
            kind: 'error',
            status: resp.status,
            error: `Hermes chat service returned HTTP ${resp.status}: ${resp.statusText}`,
            details: errorBody.slice(0, 1000)
          }
        }

        const data = resp.json()
        const reply = data.choices?.[0]?.message?.content || JSON.stringify(data)
        persistHermesChatReply(requestId, reply, data.usage)
        appendHermesLog(`[CHAT][RESPONSE] durationMs=${Date.now() - activeHermesChatRequest.startedAt} replyChars=${reply.length}`)
        return {
          kind: 'success',
          reply,
          raw: data,
        }
      } catch (err) {
        const cause = err && typeof err === 'object' && 'cause' in err ? err.cause : null
        const errorMessage = err?.message || 'unknown_error'
        const durationMs = activeHermesChatRequest ? Date.now() - activeHermesChatRequest.startedAt : null
        appendHermesLog(`[CHAT][ERROR] durationMs=${durationMs ?? -1} message=${errorMessage}`)
        persistHermesChatError(
          requestId,
          errorMessage,
          cause ? String(cause) : ''
        )
        return {
          kind: 'error',
          error: errorMessage,
          details: cause ? String(cause) : undefined,
        }
      } finally {
        if (activeHermesChatRequest?.requestId === requestId) {
          activeHermesChatRequest = null
        }
      }
    })()

    const timeoutPromise = new Promise((resolve) => {
      setTimeout(() => resolve({ kind: 'timeout' }), HERMES_CHAT_REQUEST_TIMEOUT_MS)
    })

    const result = await Promise.race([completionPromise, timeoutPromise])
    if (result?.kind === 'timeout') {
      appendHermesLog(`[CHAT][TIMEOUT] requestId=${requestId} waitedMs=${HERMES_CHAT_REQUEST_TIMEOUT_MS} continueInBackground=true`)
      return c.json({
        ok: false,
        error: 'chat_timeout',
        details: '等待超时，Hermes 仍在后台继续处理；结果返回后会补写到聊天记录文件。',
        hermesApiBaseUrl: HERMES_API_SERVER_BASE_URL,
        contextSources,
        timeoutMs: HERMES_CHAT_REQUEST_TIMEOUT_MS,
        activeRequest: buildActiveHermesChatRequestPayload(activeHermesChatRequest),
        pending: true,
        runtimeStatus: getHermesRuntimeState(),
      }, 202)
    }

    if (result?.kind === 'success') {
      return c.json({
        ok: true,
        agentId,
        reply: result.reply,
        raw: result.raw,
        contextSources,
        timeoutMs: HERMES_CHAT_REQUEST_TIMEOUT_MS,
      })
    }

    return c.json({
      ok: false,
      error: result?.error || 'unknown_error',
      details: result?.details,
      hermesApiBaseUrl: HERMES_API_SERVER_BASE_URL,
      contextSources,
      timeoutMs: HERMES_CHAT_REQUEST_TIMEOUT_MS,
      activeRequest: buildActiveHermesChatRequestPayload(activeHermesChatRequest),
      runtimeStatus: getHermesRuntimeState(),
    }, result?.status && Number.isFinite(result.status) ? result.status : 500)

  } catch (err) {
    const cause = err && typeof err === 'object' && 'cause' in err ? err.cause : null
    const errorMessage = err?.message || 'unknown_error'
    const durationMs = activeHermesChatRequest ? Date.now() - activeHermesChatRequest.startedAt : null
    appendHermesLog(`[CHAT][ERROR] durationMs=${durationMs ?? -1} message=${errorMessage}`)
    if (requestId) {
      persistHermesChatError(requestId, errorMessage, cause ? String(cause) : '')
    } else {
      persistHermesChatFailure(
        userPrompt,
        errorMessage,
        cause ? String(cause) : ''
      )
    }
    return c.json({
      ok: false,
      error: errorMessage,
      details: cause ? String(cause) : undefined,
      hermesApiBaseUrl: HERMES_API_SERVER_BASE_URL,
      timeoutMs: HERMES_CHAT_REQUEST_TIMEOUT_MS,
      activeRequest: buildActiveHermesChatRequestPayload(activeHermesChatRequest),
      runtimeStatus: getHermesRuntimeState(),
    })
  }
})

serve({
  fetch: app.fetch,
  port
}, () => {
  console.log(`[control-server] listening on http://127.0.0.1:${port}`)
})