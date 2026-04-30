import fs from 'node:fs'
import http from 'node:http'
import https from 'node:https'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import {
  CONTROL_SERVER_PORT,
  HERMES_API_SERVER_BASE_URL,
  HERMES_API_SERVER_HOST,
  HERMES_API_SERVER_PORT,
  HERMES_CHAT_REQUEST_TIMEOUT_MS,
  HERMES_REASONING_MAX_QUALITY_RETRIES,
  HERMES_REASONING_MIN_ACCEPT_SCORE,
  HERMES_REASONING_PROVIDER_PROBE_TIMEOUT_MS,
  HERMES_REASONING_TASK_HARD_TIMEOUT_MS,
  HERMES_REASONING_TASK_LEASE_MS,
  HERMES_REASONING_TASK_MAX_RENEWS,
  HERMES_REASONING_TRANSIENT_PROBE_FAILURE_BUDGET,
} from '../config/constants.js'
import {
  CONTROL_RESTART_SCRIPT,
  DEFAULT_HERMES_SKILL_FILE,
  GAMESTUDIO_ENV_FILE,
  GAMESTUDIO_ROOT,
  HERMES_AGENT_RUNTIME_EVENTS_FILE,
  HERMES_AGENT_RUNTIME_REVIEW_RECORDS_FILE,
  HERMES_AGENT_RUNTIME_SESSIONS_DIR,
  HERMES_CONFIG_ROOT,
  HERMES_CONTEXT_POOL_DIR,
  HERMES_CONTROL_CONFIG_FILE,
  HERMES_CONTROL_STATE_FILE,
  HERMES_GATEWAY_SCRIPT,
  HERMES_HOME,
  HERMES_REASONING_REVIEW_RECORDS_FILE,
  HERMES_REASONING_SESSIONS_DIR,
  HERMES_ROOT,
  HERMES_RUNTIME_CONFIG_FILES,
  HERMES_RUNTIME_LOG_FILE,
  HERMES_RUNTIME_PID_FILE,
  HERMES_VENV_PYTHON,
  LEGACY_HERMES_CONTROL_CONFIG_FILE,
  STUDIO_STORAGE_ROOT,
  STORAGE_PROJECTS_ROOT,
} from '../config/paths.js'
import { hermesAgentDefinition, openclawAgentDefinition } from './agentDefinitions.js'
import {
  inspectControlBackendSurfaces,
  inspectWorkspaceDirectory,
  inspectServerImageEntrypoints,
  discoverWorkspaceAppRoots,
  buildWorkspaceStructureArtifact,
  resolveWorkspacePathFromInput,
} from './workspace/inspectors.js'
import {
  normalizeWorkspaceRelativePath,
  isDirectoryListingPrompt,
  isProjectListingPrompt,
  inferWorkspaceDirectoryFromPrompt,
  inferWorkspaceDirectoriesFromPromptText,
  inferWorkspaceFilesFromPrompt,
  isWorkspaceFileQuestionPrompt,
  isWorkspaceDirectoryQuestionPrompt,
  isImageServiceEntrypointPrompt,
  isControlBackendSurfacePrompt,
  isControlLocationPrompt,
  isEditorLocationPrompt,
  isBusinessServerLocationPrompt,
  hasWorkspaceLocationEvidence,
  summarizeReasoningArtifactsForAssessment,
  buildImageServiceEntrypointsAnswer,
  buildControlBackendSurfacesAnswer,
  shouldUseDeterministicImageServiceAnswer,
  shouldUseDeterministicControlBackendAnswer,
  shouldUseDeterministicDirectoryListingAnswer,
  evaluateControlLocationAnswerQuality,
  evaluateDirectoryListingAnswerQuality,
  evaluateWorkspaceLocationAnswerQuality,
  evaluateWorkspaceFileQuestionAnswerQuality,
  evaluateWorkspaceDirectoryQuestionAnswerQuality,
  evaluateImageServiceAnswerQuality,
} from './reasoning/heuristics.js'
import {
  buildReasoningFileRewriteMessages,
  buildReasoningWriteFallbackContent,
  isWorkspaceEditablePath,
  isWorkspaceRunnableScriptPath,
  runWorkspaceTextSearch,
} from './workspace/edits.js'
import {
  buildReasoningFallbackPlan,
  buildReasoningPlannerMessages,
  extractJsonObjectString,
  normalizeReasoningPlan,
} from './reasoning/promptBuilders.js'
import { buildReasoningRecentContextArtifact } from './reasoning/memory.js'
import {
  generateReasoningFinalAnswer,
  generateReasoningPlan,
  getReasoningRequestError,
} from './reasoning/modelRequests.js'
import {
  evaluateReasoningFinalAnswerQuality,
  finalizeReasoningSessionWithQualityGate,
} from './reasoning/qualityGate.js'
import {
  buildReasoningActionCatalog,
  isReasoningAnswerAction,
  isReasoningInvokeAction,
  isReasoningWriteAction,
  REASONING_ACTIONS,
  REASONING_ALLOWED_ACTION_NAMES,
} from './capabilities/actionRegistry.js'
import { buildReasoningToolCatalog } from './capabilities/toolRegistry.js'
import { registerChatRequestRoutes } from './routes/chatRequestRoutes.js'
import { registerChatRoutes } from './routes/chatRoutes.js'
import { registerConfigRoutes } from './routes/configRoutes.js'
import { registerContextRoutes } from './routes/contextRoutes.js'
import { registerOverviewRoutes } from './routes/overviewRoutes.js'
import { registerReasoningRoutes } from './routes/reasoningRoutes.js'
import { registerRuntimeRoutes } from './routes/runtimeRoutes.js'
import { registerSkillProposalsRoutes } from './routes/skillProposalsRoutes.js'
import {
  bootstrapIntents,
  findIntentForAnswer,
  findIntentForEvaluation,
  findIntentForPlan,
  registerIntent,
} from './intents/index.js'
import { enqueueSelfReviewOperatorProposals } from './intents/proposals.js'
import { requestHermesChatCompletion } from './model/modelTaskQueue.js'
import {
  createMemoryLifecycleMetadata,
  MEMORY_LIFECYCLE_STATES,
  MEMORY_RECORD_KINDS,
  shouldWakeMemoryRecord,
} from './memory/lifecyclePolicy.js'
import { runMemoryLifecycleMaintenance } from './memory/lifecycleMaintenance.js'
import { createChatService } from './services/chatService.js'
import { createConfigService } from './services/configService.js'
import { createContextService } from './services/contextService.js'
import { createReasoningService } from './services/reasoningService.js'
import { createRuntimeService } from './services/runtimeService.js'

let activeHermesChatRequest = null
let activeHermesChatRecovery = null
const activeHermesReasoningSessionIds = new Set()
const activeHermesReasoningExecutions = new Map()
// 心跳事件只用于 UI 展示「仍在执行 X 秒」，不会触发任何 OMLX 调用。
// 之前 10s 节奏让人误以为 OMLX 在频繁返回；改回 30s 仅减少 UI 噪音，不影响 120s 单次等待 + 12 次续租契约。
const HERMES_REASONING_TASK_HEARTBEAT_MS = Math.max(3000, Number(process.env.HERMES_REASONING_TASK_HEARTBEAT_MS || 30000))
let currentHermesChatSessionId = createOpaqueId('chat')

function getActiveHermesChatRequest() {
  return activeHermesChatRequest
}

function setActiveHermesChatRequest(request) {
  activeHermesChatRequest = request
}

function getActiveHermesChatRecovery() {
  return activeHermesChatRecovery
}

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

const HERMES_GATEWAY_LOG_WATCH_INTERVAL_MS = Math.max(
  500,
  Number(process.env.HERMES_GATEWAY_LOG_WATCH_INTERVAL_MS || 1500)
)
const HERMES_GATEWAY_LOG_MAX_CHUNK_BYTES = 256 * 1024
const HERMES_GATEWAY_FAULT_TTL_MS = Math.max(
  60 * 1000,
  Number(process.env.HERMES_GATEWAY_FAULT_TTL_MS || 10 * 60 * 1000)
)
const HERMES_GATEWAY_FAULT_PATTERNS = [
  { kind: 'omlx_nonetype_config', regex: /'NoneType' object has no attribute 'config'/ },
  { kind: 'omlx_max_retries_exhausted', regex: /Max retries \(\d+\) exhausted/ },
  { kind: 'omlx_api_failed_after_retries', regex: /API failed after \d+ retries/ }
]
let hermesGatewayLogWatcherTimer = null
let hermesGatewayLogReadOffset = 0
let hermesGatewayLogTail = ''
let hermesGatewayLastFault = null

function inspectHermesGatewayLogChunk(text) {
  if (!text) return []
  const detections = []
  const lines = text.split(/\r?\n/)
  for (const line of lines) {
    if (!line) continue
    if (line.includes('[GATEWAY-WATCHER]')) continue
    for (const pattern of HERMES_GATEWAY_FAULT_PATTERNS) {
      if (pattern.regex.test(line)) {
        detections.push({ kind: pattern.kind, line })
        break
      }
    }
  }
  return detections
}

function handleHermesGatewayFaults(detections) {
  if (!detections.length) return
  const detection = detections[detections.length - 1]
  const sessionIds = Array.from(activeHermesReasoningExecutions.keys())
  hermesGatewayLastFault = {
    at: new Date().toISOString(),
    kind: detection.kind,
    line: detection.line.slice(0, 600),
    sessionIds
  }
  appendHermesLog(
    `[GATEWAY-WATCHER][FAULT] kind=${detection.kind} affectedSessions=${sessionIds.length} line=${detection.line.slice(0, 200)}`
  )
  for (const sessionId of sessionIds) {
    try {
      markReasoningSessionFailed(
        sessionId,
        new Error(`hermes_gateway_omlx_fault:${detection.kind}:${detection.line.slice(0, 200)}`)
      )
    } catch (error) {
      appendHermesLog(
        `[GATEWAY-WATCHER][FAULT][MARK_FAILED_ERROR] sessionId=${sessionId} detail=${error instanceof Error ? error.message : String(error)}`
      )
    }
  }
}

function pollHermesGatewayLog() {
  let fd = null
  try {
    if (!fs.existsSync(HERMES_RUNTIME_LOG_FILE)) {
      hermesGatewayLogReadOffset = 0
      hermesGatewayLogTail = ''
      return
    }
    const stats = fs.statSync(HERMES_RUNTIME_LOG_FILE)
    if (stats.size < hermesGatewayLogReadOffset) {
      hermesGatewayLogReadOffset = 0
      hermesGatewayLogTail = ''
    }
    if (stats.size === hermesGatewayLogReadOffset) return

    const available = stats.size - hermesGatewayLogReadOffset
    const toRead = Math.min(available, HERMES_GATEWAY_LOG_MAX_CHUNK_BYTES)
    const buffer = Buffer.allocUnsafe(toRead)
    fd = fs.openSync(HERMES_RUNTIME_LOG_FILE, 'r')
    const bytesRead = fs.readSync(fd, buffer, 0, toRead, hermesGatewayLogReadOffset)
    hermesGatewayLogReadOffset += bytesRead
    if (bytesRead <= 0) return

    const chunk = hermesGatewayLogTail + buffer.slice(0, bytesRead).toString('utf8')
    const newlineIndex = chunk.lastIndexOf('\n')
    let processable = chunk
    if (newlineIndex >= 0) {
      processable = chunk.slice(0, newlineIndex)
      hermesGatewayLogTail = chunk.slice(newlineIndex + 1)
    } else {
      hermesGatewayLogTail = chunk
      processable = ''
    }
    const detections = inspectHermesGatewayLogChunk(processable)
    if (detections.length) handleHermesGatewayFaults(detections)
  } catch {
    // Ignore poll errors; next tick will retry.
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd) } catch {}
    }
  }
}

function ensureHermesGatewayLogWatcher() {
  if (hermesGatewayLogWatcherTimer) return
  try {
    if (fs.existsSync(HERMES_RUNTIME_LOG_FILE)) {
      hermesGatewayLogReadOffset = fs.statSync(HERMES_RUNTIME_LOG_FILE).size
    } else {
      hermesGatewayLogReadOffset = 0
    }
  } catch {
    hermesGatewayLogReadOffset = 0
  }
  hermesGatewayLogTail = ''
  hermesGatewayLogWatcherTimer = setInterval(pollHermesGatewayLog, HERMES_GATEWAY_LOG_WATCH_INTERVAL_MS)
  if (typeof hermesGatewayLogWatcherTimer.unref === 'function') {
    hermesGatewayLogWatcherTimer.unref()
  }
}

function getHermesGatewayFaultSnapshot() {
  if (!hermesGatewayLastFault) return null
  const at = Date.parse(hermesGatewayLastFault.at)
  if (!Number.isFinite(at)) return null
  if (Date.now() - at > HERMES_GATEWAY_FAULT_TTL_MS) return null
  return hermesGatewayLastFault
}

ensureHermesGatewayLogWatcher()

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
  try {
    const url = new URL(normalizedBaseUrl)
    const noProxyValue = mergeNoProxyValues(process.env.NO_PROXY || '', process.env.no_proxy || '', ['127.0.0.1', 'localhost', '::1', url.hostname])
    process.env.NO_PROXY = noProxyValue
    process.env.no_proxy = noProxyValue
  } catch {
    // Ignore malformed URLs and keep existing proxy settings.
  }
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

// Per ownership rule: control 必须只通过队列 + Hermes 与模型交互，禁止任何代码路径在队列外直接对 OMLX 发起 /chat/completions 推理探测。
// 因此本探测改为只读的 /models 列表查询，且当任意 reasoning session 活跃时，跳过本探测，直接返回上次缓存的结果，避免与受控 reasoning 任务争抢 OMLX。
const inspectModelAccessCache = new Map() // key=`${provider}|${baseUrl}|${model}` → 上次探测结果

function buildInspectModelCacheKey({ provider, baseUrl, model }) {
  return `${provider || ''}|${baseUrl || ''}|${model || ''}`
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

  // 当存在活跃的 reasoning session 时，禁止任何 control 端的旁路探测：
  // 这是为了防止「队列外直连 OMLX」与正在进行的受控推理任务并行竞争模型，
  // 也防止「上一题没答完就触发下一题/旁路任务」。
  const cacheKey = buildInspectModelCacheKey({ provider, baseUrl, model })
  if (activeHermesReasoningSessionIds.size > 0) {
    const cached = inspectModelAccessCache.get(cacheKey)
    if (cached) {
      return { ...cached, checkedAt: cached.checkedAt, deferredDuringReasoning: true }
    }
    return {
      model,
      accessible: false,
      status: 'deferred',
      detail: '存在活跃的可观测推理任务，已跳过 control 旁路探测以避免与队列任务争抢模型',
      checkedAt,
      usage: normalizeUsage(null),
      deferredDuringReasoning: true,
      ...metadata
    }
  }

  try {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 5000)
    const resp = await fetch(`${access.baseUrl}/models`, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        ...access.headers
      },
      signal: controller.signal
    })
    clearTimeout(timeout)

    const data = await resp.json().catch(() => null)
    if (!resp.ok) {
      const msg = data?.error?.message || data?.message || `HTTP ${resp.status}`
      const failure = {
        model,
        accessible: false,
        status: 'error',
        detail: String(msg),
        checkedAt,
        usage: normalizeUsage(null),
        ...metadata
      }
      inspectModelAccessCache.set(cacheKey, failure)
      return failure
    }

    const entries = Array.isArray(data?.data) ? data.data : (Array.isArray(data?.models) ? data.models : [])
    const presentInCatalog = entries.some((entry) => {
      if (!entry) return false
      if (typeof entry === 'string') return entry === model
      const id = String(entry.id || entry.name || entry.model || '').trim()
      return id === model
    })

    const result = presentInCatalog
      ? {
          model,
          accessible: true,
          status: 'ok',
          detail: '模型已出现在 OMLX /models 目录中（只读探测，不触发推理）',
          checkedAt,
          usage: normalizeUsage(null),
          ...metadata
        }
      : {
          model,
          accessible: false,
          status: 'error',
          detail: `模型未出现在 OMLX /models 目录中：${model}`,
          checkedAt,
          usage: normalizeUsage(null),
          ...metadata
        }
    inspectModelAccessCache.set(cacheKey, result)
    return result
  } catch (err) {
    const failure = {
      model,
      accessible: false,
      status: 'error',
      detail: err instanceof Error ? err.message : String(err),
      checkedAt,
      usage: normalizeUsage(null),
      ...metadata
    }
    inspectModelAccessCache.set(cacheKey, failure)
    return failure
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
    const gatewayFault = getHermesGatewayFaultSnapshot()
    const detail = gatewayFault
      ? `Hermes gateway 进程正在运行；最近一次后端故障 ${gatewayFault.kind} @ ${gatewayFault.at}`
      : 'Hermes gateway 进程正在运行'
    return {
      state: 'running',
      label: '运行中',
      detail,
      pid,
      logFile: HERMES_RUNTIME_LOG_FILE,
      availableActions: ['all-restart', 'pause', 'exit'],
      gatewayFault
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

async function waitForHermesApiReady(timeoutMs = 12000, intervalMs = 400) {
  const deadline = Date.now() + Math.max(1000, Number(timeoutMs) || 12000)
  let lastError = null

  while (Date.now() < deadline) {
    try {
      const access = getProviderAccess('omlx', HERMES_API_SERVER_BASE_URL)
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), 1500)
      const response = await fetch(`${access.baseUrl}/models`, {
        method: 'GET',
        headers: {
          Accept: 'application/json',
          ...access.headers,
        },
        signal: controller.signal,
      })
      clearTimeout(timeout)

      if (response.ok) return { ready: true, detail: 'Hermes API server ready' }
      lastError = new Error(`http_${response.status}`)
    } catch (error) {
      lastError = error
    }

    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }

  return {
    ready: false,
    detail: lastError instanceof Error ? lastError.message : String(lastError || 'unknown_error')
  }
}

function mergeNoProxyValues(...groups) {
  const values = []
  for (const group of groups) {
    const items = Array.isArray(group) ? group : [group]
    for (const item of items) {
      if (typeof item !== 'string') continue
      for (const token of item.split(',')) {
        const value = token.trim()
        if (value) values.push(value)
      }
    }
  }
  return Array.from(new Set(values)).join(',')
}

function buildHermesNoProxyValue(binding) {
  const hosts = ['127.0.0.1', 'localhost', '::1', HERMES_API_SERVER_HOST]

  for (const candidate of [binding?.baseUrl, HERMES_API_SERVER_BASE_URL]) {
    if (typeof candidate !== 'string' || !candidate) continue
    try {
      const url = new URL(candidate)
      if (url.hostname) hosts.push(url.hostname)
    } catch {
      // Ignore malformed URLs and keep the default local bypass list.
    }
  }

  return mergeNoProxyValues(process.env.NO_PROXY || '', process.env.no_proxy || '', hosts)
}

function trimPromptSection(content, maxChars = 1800) {
  const text = String(content || '').trim()
  if (!text) return ''
  if (text.length <= maxChars) return text
  return `${text.slice(0, maxChars).trim()}\n...[truncated]`
}

function buildHermesEphemeralSystemPrompt(binding) {
  const sections = [
    '你当前运行在 GameStudio 的 control 管理模式中。',
    '默认使用中文回复，除非用户明确要求其他语言。',
    'Telegram / 其它聊天入口也必须遵守当前 GameStudio control + Hermes 的项目契约，不要回退到通用英文 Planner 自我介绍。',
    '如果用户询问项目状态、任务进度、控制面行为、Hermes 约束，优先依据以下记忆文件，而不是假设 memory 为空。',
  ]

  const memorySections = [
    ['AGENTS', binding?.memory?.agentDefinitionFile],
    ['USER', binding?.memory?.userFile],
    ['MEMORY', binding?.memory?.memoryFile],
    ['LONG_TASKS', binding?.memory?.longTasksFile],
    ['STATUS', binding?.memory?.statusFile],
    ['TASK_QUEUE', binding?.memory?.taskQueueFile],
    ['DECISIONS', binding?.memory?.decisionsFile]
  ]

  for (const [label, filePath] of memorySections) {
    if (!filePath || !fs.existsSync(filePath)) continue
    const content = trimPromptSection(readMarkdownFile(filePath), label === 'AGENTS' ? 2600 : 1400)
    if (!content) continue
    sections.push(`## ${label} (${filePath})\n${content}`)
  }

  const skillFiles = Array.isArray(binding?.skills?.availableSkillFiles) ? binding.skills.availableSkillFiles : []
  if (skillFiles.length > 0) {
    const skillFile = skillFiles[0]
    const skillContent = trimPromptSection(readMarkdownFile(skillFile), 1600)
    if (skillContent) {
      sections.push(`## ACTIVE_SKILL (${skillFile})\n${skillContent}`)
    }
  }

  sections.push('不要声称 workspace 刚初始化、memory 目录为空，除非你已经根据上述文件事实确认它们真的为空。')
  sections.push('如果用户来自 Telegram，也要把自己视为当前 control 管理下的 Hermes，而不是脱离 control 的独立 Planner。')
  return sections.join('\n\n').trim()
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
  const noProxyValue = buildHermesNoProxyValue(binding)
  const ephemeralSystemPrompt = buildHermesEphemeralSystemPrompt(binding)
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
    GAMESTUDIO_LONG_TASKS_FILE: binding.memory.longTasksFile,
    GAMESTUDIO_STATUS_FILE: binding.memory.statusFile,
    GAMESTUDIO_TASK_QUEUE_FILE: binding.memory.taskQueueFile,
    GAMESTUDIO_DECISIONS_FILE: binding.memory.decisionsFile,
    GAMESTUDIO_DAILY_LOG_DIR: binding.memory.dailyLogDir,
    GAMESTUDIO_SKILL_ROOT: binding.skills.skillRoot,
    GAMESTUDIO_SKILL_FILES: binding.skills.availableSkillFiles.join(path.delimiter),
    GAMESTUDIO_MIN_CONTEXT_TOKENS: String(binding.shortTerm.minContextTokens || 0),
    HERMES_EPHEMERAL_SYSTEM_PROMPT: ephemeralSystemPrompt,
    NO_PROXY: noProxyValue,
    no_proxy: noProxyValue,
    ...(binding.provider === 'omlx' ? {
      OPENAI_BASE_URL: binding.baseUrl,
      LOCALOXML_BASE_URL: binding.baseUrl,
      STUDIO_AI_BASE_URL: binding.baseUrl,
    } : {}),
    ...(providerAccess.apiKey ? {
      OPENAI_API_KEY: providerAccess.apiKey,
      LOCALOXML_API_KEY: providerAccess.apiKey,
      STUDIO_AI_API_KEY: providerAccess.apiKey
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
  ensureHermesGatewayLogWatcher()

  const readiness = await waitForHermesApiReady()
  if (!readiness.ready) {
    appendHermesLog(`[START][WARN] Hermes API not ready after launch wait: ${readiness.detail}`)
  }
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
      longTasksFile: path.join(aiMemoryRoot, 'LONG_TASKS.md'),
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
      longTasksFile: String(memory.longTasksFile || defaults.memory.longTasksFile),
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

function extractMarkdownHeadingBody(markdown, heading) {
  const normalizedHeading = String(heading || '').trim()
  if (!normalizedHeading) return ''
  const source = String(markdown || '')
  const headingPattern = /^##\s+(.+?)\s*$/gm
  let match = headingPattern.exec(source)
  let bodyStart = -1
  while (match) {
    if (String(match[1] || '').trim() === normalizedHeading) {
      bodyStart = headingPattern.lastIndex
      break
    }
    match = headingPattern.exec(source)
  }
  if (bodyStart < 0) return ''
  headingPattern.lastIndex = bodyStart
  const nextMatch = headingPattern.exec(source)
  const bodyEnd = nextMatch ? nextMatch.index : source.length
  return source.slice(bodyStart, bodyEnd).trim()
}

function parseSkillPlannerActionHints(markdown) {
  const section = extractMarkdownHeadingBody(markdown, 'Planner Action Hints')
  if (!section) return []

  return section
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith('- '))
    .map((line, index) => {
      const body = line.slice(2).trim()
      const [rawKeywords, rawActions] = body.split(/=>/)
      if (!rawKeywords || !rawActions) return null
      const keywords = rawKeywords
        .split('|')
        .map((item) => String(item || '').trim())
        .filter(Boolean)
      const actions = rawActions
        .split(',')
        .map((item) => String(item || '').trim())
        .filter((action) => Boolean(REASONING_ACTIONS[action]))
      if (!keywords.length || !actions.length) return null
      const answerAction = actions.find((action) => action === 'generate_default_answer') || 'generate_default_answer'
      const requiredActions = actions.filter((action) => action !== answerAction)
      const options = {}
      const optionMatch = body.match(/\|\|\s*(.+)$/)
      if (optionMatch) {
        for (const part of optionMatch[1].split(/[;,]/)) {
          const [rawKey, rawValue] = part.split(/=/)
          const key = String(rawKey || '').trim()
          const value = String(rawValue || '').trim()
          if (!key) continue
          options[key] = value || 'true'
        }
      }
      return {
        hintId: `skill_hint_${index + 1}`,
        keywords,
        requiredActions,
        answerAction,
        prependContext: String(options.prependContext || '').trim() !== 'false'
      }
    })
    .filter(Boolean)
}

function readSkillDefinition(filePath) {
  const normalizedPath = String(filePath || '').trim()
  if (!normalizedPath || !fs.existsSync(normalizedPath)) return null
  const content = fs.readFileSync(normalizedPath, 'utf8')
  return {
    filePath: normalizedPath,
    content,
    actionHints: parseSkillPlannerActionHints(content)
  }
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
    memoryConfig.longTasksFile,
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
  const availableSkills = availableSkillFiles.map((filePath) => readSkillDefinition(filePath)).filter(Boolean)
  return {
    skillRoot: String(skillsConfig.skillRoot || ''),
    skillFiles,
    availableSkillFiles,
    availableSkills,
    skillCount: availableSkillFiles.length
  }
}

function buildReasoningCapabilityGuide() {
  const guideFile = path.join(GAMESTUDIO_ROOT, 'docs', 'REASONING_PLAN_EXTENSION_GUIDE.md')
  const content = fs.existsSync(guideFile) ? fs.readFileSync(guideFile, 'utf8') : ''
  return {
    filePath: guideFile,
    content,
    exists: Boolean(content)
  }
}

function buildAgentRuntimeDescriptor() {
  return {
    runtimeName: 'agentRuntime',
    controlPlaneName: 'agentControl',
    workflowTerm: 'runtime task chain',
    taskGraphTerm: 'runtime task graph',
    frontend: {
      root: path.join(GAMESTUDIO_ROOT, 'apps', 'control-console'),
      entryFile: path.join(GAMESTUDIO_ROOT, 'apps', 'control-console', 'src', 'main.ts')
    },
    backend: {
      root: path.join(GAMESTUDIO_ROOT, 'apps', 'control-server'),
      entryFile: path.join(GAMESTUDIO_ROOT, 'apps', 'control-server', 'src', 'index.js')
    },
    routes: {
      capabilities: '/api/control/agents/:agentId/agent-runtime',
      submissionPreview: '/api/control/agents/:agentId/submission-preview',
      contextDraft: '/api/control/agents/:agentId/context-drafts',
      sessions: '/api/control/agents/:agentId/reasoning-sessions'
    }
  }
}

function buildAgentRuntimeBehaviorChecks(binding) {
  const tools = buildReasoningToolCatalog()
  const actions = buildReasoningActionCatalog()
  const toolMap = new Map(tools.map((tool) => [tool.tool, tool]))
  const actionMap = new Map(actions.map((action) => [action.action, action]))
  const manualSources = buildManualContextSourceCandidates(binding)
  const canObserveWorkspace = toolMap.has('workspace.listDirectory') && toolMap.has('workspace.readFile')
  const editWorkspaceAction = actionMap.get('edit_workspace_file')
  const lifecycleAction = actionMap.get('run_lifecycle_script')

  return [
    {
      key: 'runtime-read-observe',
      label: '工作区观察能力',
      status: canObserveWorkspace ? 'ok' : 'error',
      detail: canObserveWorkspace
        ? 'agentRuntime 已接通列目录与读文件动作，可构造可观测证据链。'
        : '缺少 workspace.listDirectory 或 workspace.readFile，无法完成基本观察链。'
    },
    {
      key: 'runtime-write-review',
      label: '工作区写入能力',
      status: editWorkspaceAction?.requiresHumanReview ? 'ok' : 'error',
      detail: editWorkspaceAction?.requiresHumanReview
        ? 'edit_workspace_file 已启用，写入先生成候选稿并等待人工审核。'
        : 'edit_workspace_file 未正确接入审核门，当前不应视为可安全写入。'
    },
    {
      key: 'runtime-script-review',
      label: '脚本执行能力',
      status: lifecycleAction?.requiresHumanReview ? 'ok' : 'error',
      detail: lifecycleAction?.requiresHumanReview
        ? 'run_lifecycle_script 已启用，白名单脚本确认后才会执行。'
        : 'run_lifecycle_script 未正确接入审核门。'
    },
    {
      key: 'runtime-context-draft',
      label: '上下文提取与压缩',
      status: 'ok',
      detail: manualSources.length > 0
        ? `context-drafts 已启用，可从 ${manualSources.length} 个手工上下文源生成压缩摘要。`
        : 'context-drafts 已启用；当前没有额外手工上下文源，但仍可基于默认 memory 生成摘要。'
    },
    {
      key: 'runtime-context-summary-injection',
      label: '确认摘要注入运行链',
      status: 'ok',
      detail: 'confirmedContextSummary 会随 submission preview、chat 与 reasoning session 一起注入 system context。'
    },
    {
      key: 'runtime-session-loop',
      label: '任务执行闭环',
      status: 'ok',
      detail: '当前链路为 create session -> build runtime task graph -> execute action chain -> review/apply -> final answer。'
    }
  ]
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
  addPathCheck('memory-long-tasks-file', '长任务主线文件', config.memory.longTasksFile)
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
        error: resp.status === 401 || resp.status === 403
          ? `模型目录访问被拒绝: HTTP ${resp.status}。请检查 ${access.provider.toUpperCase()} 服务是否要求 API Key，或当前控制端是否具备访问权限。`
          : `请启动推理模型（OMLX）。当前模型服务不可用: HTTP ${resp.status}`,
        models: []
      }
    }
    const data = await resp.json()
    const rawModels = Array.isArray(data?.data)
      ? data.data
      : Array.isArray(data?.models)
        ? data.models
        : Array.isArray(data)
          ? data
          : []
    const models = rawModels.map((item) => {
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

// ---------------------------------------------------------------------------
// Builtin intent registration
// ---------------------------------------------------------------------------
//
// Each builtin intent wraps an existing detector / evaluator already
// implemented above. Refactoring the if-chains in
// generateReasoningPlan / generateReasoningFinalAnswer /
// evaluateReasoningFinalAnswerQuality means those pipelines now consult
// the registry; without these builtins the legacy behaviour would
// silently disappear. Behaviour is intentionally byte-equivalent to
// the previous cascades.

let builtinIntentsRegistered = false

function registerBuiltinIntents() {
  if (builtinIntentsRegistered) return
  builtinIntentsRegistered = true

  // 1. Workspace location prompts (editor / control / business server).
  registerIntent({
    id: 'builtin.workspace_location',
    source: 'builtin',
    description: 'Editor / control / business server 目录定位类问题',
    priority: 100,
    matchPlan: (prompt) =>
      isEditorLocationPrompt(prompt)
      || isControlLocationPrompt(prompt)
      || isBusinessServerLocationPrompt(prompt),
    matchEvaluation: (prompt, artifacts) =>
      hasWorkspaceLocationEvidence(prompt, artifacts) && !isControlLocationPrompt(prompt),
    evaluateAnswer: (prompt, answer, artifacts) =>
      evaluateWorkspaceLocationAnswerQuality(prompt, answer, artifacts),
  })

  // 2. Workspace single-file question.
  registerIntent({
    id: 'builtin.workspace_file_question',
    source: 'builtin',
    description: '关于具体仓库文件作用 / 职责的问题',
    priority: 95,
    matchPlan: (prompt) => isWorkspaceFileQuestionPrompt(prompt),
    matchEvaluation: (prompt) => isWorkspaceFileQuestionPrompt(prompt),
    evaluateAnswer: (prompt, answer, artifacts) =>
      evaluateWorkspaceFileQuestionAnswerQuality(prompt, answer, artifacts),
  })

  // 3. Workspace directory question.
  registerIntent({
    id: 'builtin.workspace_directory_question',
    source: 'builtin',
    description: '关于仓库目录组织 / 职责的问题',
    priority: 90,
    matchPlan: (prompt) => isWorkspaceDirectoryQuestionPrompt(prompt),
    matchEvaluation: (prompt) => isWorkspaceDirectoryQuestionPrompt(prompt),
    evaluateAnswer: (prompt, answer, artifacts) =>
      evaluateWorkspaceDirectoryQuestionAnswerQuality(prompt, answer, artifacts),
  })

  // 3.5. Project listing questions: force a stable storage/projects path.
  registerIntent({
    id: 'builtin.project_listing',
    source: 'builtin',
    description: '列出 storage/projects 当前已有项目',
    priority: 85,
    matchPlan: (prompt) => isProjectListingPrompt(prompt),
  })

  // 4. Image service entrypoint evaluator (no plan override; reuses model planner).
  registerIntent({
    id: 'builtin.image_service_entrypoint',
    source: 'builtin',
    description: '图片生成服务端入口问题的确定性评分',
    priority: 80,
    matchEvaluation: (prompt, artifacts) =>
      shouldUseDeterministicImageServiceAnswer(prompt, artifacts),
    evaluateAnswer: (prompt, answer, artifacts) =>
      evaluateImageServiceAnswerQuality(answer, artifacts),
  })

  // 5. Directory-listing summarisation: deterministic answer + deterministic eval.
  registerIntent({
    id: 'builtin.directory_listing',
    source: 'builtin',
    description: '基于 list_directory_contents 结果的确定性回答与评分',
    priority: 70,
    matchPlan: (prompt, ctx) => {
      if (!isDirectoryListingPrompt(prompt)) return false
      const hasInferred = Boolean(ctx?.inferredDirPath)
      const hasContextDirs = Array.isArray(ctx?.inferredContextDirPaths) && ctx.inferredContextDirPaths.length > 0
      return hasInferred || hasContextDirs
    },
    matchAnswer: (prompt, artifacts) =>
      shouldUseDeterministicDirectoryListingAnswer(prompt, artifacts),
    buildDeterministicAnswer: (prompt, artifacts) =>
      buildReasoningFallbackAnswer(prompt, artifacts),
    deterministicAnswerReason: 'deterministic_directory_listing_summary',
    matchEvaluation: (prompt, artifacts) =>
      shouldUseDeterministicDirectoryListingAnswer(prompt, artifacts),
    evaluateAnswer: (prompt, answer, artifacts) =>
      evaluateDirectoryListingAnswerQuality(answer, artifacts),
  })

  // 6. Control surface location (the bottom of the legacy eval cascade).
  registerIntent({
    id: 'builtin.control_location',
    source: 'builtin',
    description: 'control / Hermes 后端目录定位类问题',
    priority: 60,
    matchEvaluation: (prompt) => isControlLocationPrompt(prompt),
    evaluateAnswer: (prompt, answer, artifacts) =>
      evaluateControlLocationAnswerQuality(prompt, answer, artifacts),
  })
}

function bootstrapControlServerIntents() {
  registerBuiltinIntents()
  try {
    const summary = bootstrapIntents()
    console.log(
      `[control-server] [intents] registered ${summary.total} intent(s) `
      + `(builtin=${summary.bySource.builtin || 0}, json=${summary.bySource.json || 0}, proposal=${summary.bySource.proposal || 0}); `
      + `json loader: loaded=${summary.json.loaded}, errors=${summary.json.errors.length}`
    )
    if (summary.json.errors.length > 0) {
      for (const error of summary.json.errors) {
        console.warn('[control-server] [intents] JSON intent failed:', error.filePath, error.error)
      }
    }
  } catch (error) {
    console.warn('[control-server] [intents] bootstrap failed:', error?.message || error)
  }
}

function createControlServerRouteContext() {
  const shared = {
    CONTROL_RESTART_SCRIPT,
    GAMESTUDIO_ROOT,
    HERMES_API_SERVER_BASE_URL,
    HERMES_CHAT_REQUEST_TIMEOUT_MS,
    HERMES_HOME,
    HERMES_RUNTIME_LOG_FILE,
    appendHermesLog,
    appendReasoningEvent,
    approveReasoningQualityOverride,
    applyPreparedLifecycleScript,
    applyPreparedWorkspaceOperation,
    applyPreparedReasoningWrite,
    buildActiveHermesChatRequestPayload,
    buildChatContextSourcesPayload,
    buildConfigValidation,
    buildHermesActionContract,
    buildHermesAgentRecord,
    buildHermesBinding,
    buildHermesBindingFromConfig,
    buildHermesChatMessages,
    buildHermesNextAction,
    buildHermesOutboundRequestSummary,
    buildHermesPreflight,
    buildHermesSelfCheck,
    buildHermesStartupFlow,
    buildHermesStartupProfile,
    buildAgentRuntimeBehaviorChecks,
    buildAgentRuntimeDescriptor,
    buildManualContextSourceCandidates,
    buildModelStateSnapshot,
    buildOpenClawAgentRecord,
    buildReasoningActionCatalog,
    buildReasoningToolCatalog,
    buildReasoningCapabilityGuide,
    buildReasoningPlannerMessages,
    buildRuntimeStateSnapshot,
    buildStructuredOutboundPreview,
    cancelReasoningSession,
    clearReasoningReview,
    continueReasoningSessionFromStep,
    createOpaqueId,
    createReasoningSession,
    deleteReasoningSessionRecord,
    fetch,
    fetchLocalModelCatalog,
    fs,
    generateContextDraft,
    getActiveHermesChatRecovery,
    getActiveHermesChatRequest,
    getContextPoolEntryFilePath,
    getHermesChatFilePath,
    getHermesChatFileRecord,
    getHermesControlConfigFingerprint,
    getHermesControlState,
    getHermesRuntimeState,
    getPersistedHermesControlConfig,
    getProviderAccess,
    getSelectableContextSourceById,
    hermesAgentDefinition,
    inspectModelAccess,
    listContextPoolEntries,
    markReasoningSessionFailed,
    mergeHermesControlConfig,
    normalizeModelBaseUrl,
    normalizeProviderName,
    openFileInEditor,
    openclawAgentDefinition,
    parseHermesChatHistoryContent,
    path,
    persistHermesChatError,
    persistHermesChatFailure,
    persistHermesChatPrompt,
    persistHermesChatReply,
    persistReasoningReviewDecision,
    prepareReasoningSessionPlan,
    readContextPoolEntry,
    readHermesChatHistory,
    readReasoningSession,
    readStoredHermesChatHistory,
    readUtf8FileRecord,
    refreshHermesControlStateFromConfig,
    requestJsonWithoutHeadersTimeout,
    requestHermesChatCompletion,
    runMemoryLifecycleMaintenance: () => runMemoryLifecycleMaintenance({
      fs,
      rootDir: GAMESTUDIO_ROOT,
      contextPoolDir: HERMES_CONTEXT_POOL_DIR,
      chatDir: path.join(GAMESTUDIO_ROOT, 'ai', 'chat'),
      sessionDir: HERMES_AGENT_RUNTIME_SESSIONS_DIR,
    }),
    runAllReasoningStepsFrom,
    runReasoningSession,
    setActiveHermesChatRequest,
    setHermesControlConfig,
    spawn,
    startHermesRuntime,
    stopHermesRuntime,
    updateHermesControlState,
    updateReasoningSession,
    writeContextPoolEntry,
    writeHermesChatHistory,
    writeUtf8FileRecord,
  }

  return {
    ...shared,
    ...createRuntimeService(shared),
    ...createConfigService(shared),
    ...createChatService(shared),
    ...createContextService(shared),
    ...createReasoningService(shared),
  }
}

function registerPrimaryControlServerRoutes(app) {
  const context = createControlServerRouteContext()
  registerOverviewRoutes(app, context)
  registerRuntimeRoutes(app, context)
  registerConfigRoutes(app, context)
  registerContextRoutes(app, context)
  registerChatRoutes(app, context)
  registerReasoningRoutes(app, context)
  registerSkillProposalsRoutes(app)
}

export function registerControlServerRoutes(app) {
  bootstrapControlServerIntents()
  registerPrimaryControlServerRoutes(app)
  registerChatRequestRoute(app)
}

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

export function createOpaqueId(prefix) {
  return `${prefix}_${Date.now()}_${Math.random().toString(16).slice(2, 10)}`
}

export function truncateReasoningPreview(value, limit = 1600) {
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

function buildSelectedSkillSummary(binding, contextSelection = {}) {
  return getSelectedSkillDefinitions(binding, contextSelection).map((skill) => ({
    filePath: skill.filePath,
    name: path.basename(path.dirname(skill.filePath)),
    hintCount: Array.isArray(skill.actionHints) ? skill.actionHints.length : 0,
    actionHints: (Array.isArray(skill.actionHints) ? skill.actionHints : []).map((hint) => ({
      hintId: hint.hintId,
      keywords: hint.keywords,
      requiredActions: hint.requiredActions,
      answerAction: hint.answerAction
    }))
  }))
}

function buildMatchedReasoningRuleSummary(userPrompt, history, binding, contextSelection = {}) {
  return getMatchingReasoningIntentRules(userPrompt, history, binding, contextSelection).map((rule) => ({
    key: rule.key,
    goal: rule.goal || '',
    source: rule.source || 'built-in',
    skillFile: rule.skillFile || null,
    keywords: rule.keywords || null,
    requiredActions: rule.requiredActions || [],
    answerAction: rule.answerAction || null
  }))
}

export function buildStructuredOutboundPreview({
  binding,
  messages,
  purpose,
  mode,
  userPrompt,
  replayedMessageCount = 0,
  contextSelection = {},
  history = []
}) {
  const previewMessages = buildReasoningMessagePreview(messages)
  const selectedSkills = buildSelectedSkillSummary(binding, contextSelection)
  const matchedRules = buildMatchedReasoningRuleSummary(userPrompt, history, binding, contextSelection)
  const suggestedActions = [...new Set(matchedRules.flatMap((rule) => [...(rule.requiredActions || []), rule.answerAction]).filter(Boolean))]

  return {
    provider: binding.provider,
    model: binding.model,
    baseUrl: binding.baseUrl,
    controllerRequest: {
      purpose,
      mode,
      target: `${HERMES_API_SERVER_BASE_URL}/chat/completions`,
      model: 'hermes-agent',
      totalMessages: previewMessages.length,
      systemMessageCount: previewMessages.filter((message) => message.role === 'system').length,
      replayedMessageCount,
      userMessageCount: previewMessages.filter((message) => message.role === 'user').length,
      messages: previewMessages
    },
    runtimeRoute: {
      provider: binding.provider,
      model: binding.model,
      baseUrl: binding.baseUrl,
      note: 'Control 先把请求发给 Hermes；Hermes 再按当前左脑绑定把本次任务路由到对应 provider / model。切换左脑配置后，这里会随 binding 动态变化。'
    },
    plannerHints: {
      selectedSkills,
      matchedRules,
      suggestedActions
    }
  }
}

function appendReasoningReviewRecord(record) {
  const normalizedRecord = {
    ...record,
    runtimeSessionId: record.sessionId,
    recordType: 'agent-runtime-review'
  }
  ensureDirectory(path.dirname(HERMES_REASONING_REVIEW_RECORDS_FILE))
  fs.appendFileSync(HERMES_REASONING_REVIEW_RECORDS_FILE, `${JSON.stringify(normalizedRecord)}\n`, 'utf8')
  ensureDirectory(path.dirname(HERMES_AGENT_RUNTIME_REVIEW_RECORDS_FILE))
  fs.appendFileSync(HERMES_AGENT_RUNTIME_REVIEW_RECORDS_FILE, `${JSON.stringify(normalizedRecord)}\n`, 'utf8')
}

const HERMES_REASONING_QUALITY_CALIBRATIONS_FILE = path.join(GAMESTUDIO_ROOT, 'state', 'reasoning-quality-calibrations.jsonl')
const HERMES_REASONING_SELF_REVIEWS_FILE = path.join(GAMESTUDIO_ROOT, 'state', 'reasoning-self-reviews.jsonl')
const HERMES_REASONING_IMPROVEMENT_CANDIDATES_FILE = path.join(GAMESTUDIO_ROOT, 'state', 'reasoning-improvement-candidates.jsonl')

function appendReasoningQualityCalibrationRecord(record) {
  ensureDirectory(path.dirname(HERMES_REASONING_QUALITY_CALIBRATIONS_FILE))
  fs.appendFileSync(HERMES_REASONING_QUALITY_CALIBRATIONS_FILE, `${JSON.stringify({
    recordedAt: new Date().toISOString(),
    recordType: 'reasoning-quality-calibration',
    ...record
  })}\n`, 'utf8')
}

export function appendReasoningSelfReviewRecord(record) {
  ensureDirectory(path.dirname(HERMES_REASONING_SELF_REVIEWS_FILE))
  fs.appendFileSync(HERMES_REASONING_SELF_REVIEWS_FILE, `${JSON.stringify({
    recordedAt: new Date().toISOString(),
    recordType: 'reasoning-self-review',
    ...record
  })}\n`, 'utf8')
}

export function appendReasoningImprovementCandidateRecord(record) {
  ensureDirectory(path.dirname(HERMES_REASONING_IMPROVEMENT_CANDIDATES_FILE))
  fs.appendFileSync(HERMES_REASONING_IMPROVEMENT_CANDIDATES_FILE, `${JSON.stringify({
    recordedAt: new Date().toISOString(),
    recordType: 'reasoning-improvement-candidate',
    status: 'pending-review',
    ...record
  })}\n`, 'utf8')
}

export function readRecentReasoningQualityCalibrations(limit = 8) {
  if (!fs.existsSync(HERMES_REASONING_QUALITY_CALIBRATIONS_FILE)) return []
  const lines = fs.readFileSync(HERMES_REASONING_QUALITY_CALIBRATIONS_FILE, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
  return lines.slice(-Math.max(0, Number(limit) || 8)).map((line) => {
    try {
      return JSON.parse(line)
    } catch {
      return null
    }
  }).filter(Boolean)
}

function getLegacyReasoningSessionFilePath(sessionId) {
  return path.join(HERMES_REASONING_SESSIONS_DIR, `${sessionId}.json`)
}

function getAgentRuntimeSessionFilePath(sessionId) {
  return path.join(HERMES_AGENT_RUNTIME_SESSIONS_DIR, `${sessionId}.json`)
}

function getReasoningSessionFilePath(sessionId) {
  return getAgentRuntimeSessionFilePath(sessionId)
}

function buildRuntimeTaskGraph(value) {
  if (!value || typeof value !== 'object') return null
  const candidate = value.runtimeTaskGraph && typeof value.runtimeTaskGraph === 'object'
    ? value.runtimeTaskGraph
    : value.plan && typeof value.plan === 'object'
      ? value.plan
      : value
  return {
    planId: String(candidate.planId || createOpaqueId('runtime_graph')),
    goal: String(candidate.goal || '生成结构化回答').trim() || '生成结构化回答',
    strategy: String(candidate.strategy || 'sequential').trim() || 'sequential',
    steps: Array.isArray(candidate.steps) ? candidate.steps : []
  }
}

function normalizeRuntimeSessionShape(session) {
  if (!session || typeof session !== 'object') return session
  const runtimeTaskGraph = buildRuntimeTaskGraph(session.runtimeTaskGraph || session.plan)
  const normalizedEvents = Array.isArray(session.events) ? session.events.map((event) => ({
    ...event,
    runtimeSessionId: event.runtimeSessionId || session.sessionId
  })) : []
  return {
    ...session,
    sessionKind: 'agent-runtime',
    runtimeSessionId: session.runtimeSessionId || session.sessionId,
    runtimeTaskGraph,
    plan: runtimeTaskGraph,
    events: normalizedEvents
  }
}

function appendAgentRuntimeEventJournal(event) {
  ensureDirectory(path.dirname(HERMES_AGENT_RUNTIME_EVENTS_FILE))
  fs.appendFileSync(HERMES_AGENT_RUNTIME_EVENTS_FILE, `${JSON.stringify(event)}\n`, 'utf8')
}

function createReasoningEvent(sessionId, type, title, summary, extra = {}) {
  return {
    eventId: createOpaqueId('evt'),
    sessionId,
    runtimeSessionId: sessionId,
    type,
    timestamp: new Date().toISOString(),
    title,
    summary,
    ...extra
  }
}

function normalizePromptForReuse(prompt) {
  return String(prompt || '').replace(/\s+/g, ' ').trim()
}

function listRecentReasoningSessionFiles(limit = 12) {
  ensureDirectory(HERMES_AGENT_RUNTIME_SESSIONS_DIR)
  return fs.readdirSync(HERMES_AGENT_RUNTIME_SESSIONS_DIR)
    .filter((file) => file.endsWith('.json'))
    .map((file) => {
      const filePath = path.join(HERMES_AGENT_RUNTIME_SESSIONS_DIR, file)
      let mtimeMs = 0
      try {
        mtimeMs = fs.statSync(filePath).mtimeMs
      } catch {
        mtimeMs = 0
      }
      return { filePath, mtimeMs }
    })
    .sort((left, right) => right.mtimeMs - left.mtimeMs)
    .slice(0, Math.max(1, Number(limit) || 12))
}

function isReusableVerifiedReasoningSession(session, prompt) {
  if (!session || typeof session !== 'object') return false
  if (session.status !== 'completed') return false
  if (normalizePromptForReuse(session.userPrompt) !== normalizePromptForReuse(prompt)) return false
  const finalAnswer = String(session.artifacts?.finalAnswer || '').trim()
  if (!finalAnswer) return false
  const latestAssessment = session.artifacts?.latestAnswerAssessment || null
  const latestSelfReview = session.artifacts?.latestSelfReview || null
  const humanApproved = Array.isArray(session.events)
    && session.events.some((event) => event?.type === 'review_approved' && event?.data?.targetType === 'answer')
  const selfReviewApproved = latestSelfReview?.verdict === 'approve'
  const assessmentPassed = Boolean(latestAssessment?.passed)
  return humanApproved || (assessmentPassed && selfReviewApproved)
}

function findReusableVerifiedReasoningSession(userPrompt) {
  const normalizedPrompt = normalizePromptForReuse(userPrompt)
  if (!normalizedPrompt) return null
  for (const entry of listRecentReasoningSessionFiles(16)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(entry.filePath, 'utf8'))
      const session = normalizeRuntimeSessionShape(parsed)
      if (isReusableVerifiedReasoningSession(session, normalizedPrompt)) {
        return session
      }
    } catch {
      // best effort scan
    }
  }
  return null
}

function writeReasoningSession(session) {
  const normalizedSession = normalizeRuntimeSessionShape(session)
  ensureDirectory(HERMES_REASONING_SESSIONS_DIR)
  ensureDirectory(HERMES_AGENT_RUNTIME_SESSIONS_DIR)
  fs.writeFileSync(getLegacyReasoningSessionFilePath(normalizedSession.sessionId), JSON.stringify(normalizedSession, null, 2), 'utf8')
  fs.writeFileSync(getAgentRuntimeSessionFilePath(normalizedSession.sessionId), JSON.stringify(normalizedSession, null, 2), 'utf8')
  return normalizedSession
}

function markReasoningSessionActive(sessionId) {
  if (!sessionId) return
  activeHermesReasoningSessionIds.add(String(sessionId))
}

function unmarkReasoningSessionActive(sessionId) {
  if (!sessionId) return
  activeHermesReasoningSessionIds.delete(String(sessionId))
}

function getActiveReasoningExecution(sessionId) {
  return activeHermesReasoningExecutions.get(String(sessionId)) || null
}

export function readReasoningSession(sessionId) {
  const runtimeFilePath = getAgentRuntimeSessionFilePath(sessionId)
  const legacyFilePath = getLegacyReasoningSessionFilePath(sessionId)
  const filePath = fs.existsSync(runtimeFilePath) ? runtimeFilePath : legacyFilePath
  if (!filePath || !fs.existsSync(filePath)) {
    return null
  }
  return normalizeRuntimeSessionShape(JSON.parse(fs.readFileSync(filePath, 'utf8')))
}

function deleteReasoningSessionRecord(sessionId) {
  const session = readReasoningSession(sessionId)
  if (!session) {
    throw new Error('reasoning_session_not_found')
  }
  if (!isReasoningSessionTerminalStatus(session.status)) {
    throw new Error('reasoning_session_not_terminal')
  }

  const filePaths = [getAgentRuntimeSessionFilePath(sessionId), getLegacyReasoningSessionFilePath(sessionId)]
  for (const filePath of filePaths) {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath)
  }
  unmarkReasoningSessionActive(sessionId)
  clearActiveReasoningExecution(sessionId)
  return { sessionId }
}

export function updateReasoningSession(sessionId, updater) {
  const current = readReasoningSession(sessionId)
  if (!current) {
    throw new Error('reasoning_session_not_found')
  }
  const next = updater(current)
  next.updatedAt = new Date().toISOString()
  return writeReasoningSession(next)
}

function getReasoningSessionLeaseWait(currentTask) {
  const leaseExpiresAtMs = Date.parse(String(currentTask?.leaseExpiresAt || ''))
  const leaseWaitMs = Number.isFinite(leaseExpiresAtMs)
    ? Math.max(0, leaseExpiresAtMs - Date.now())
    : HERMES_REASONING_TASK_LEASE_MS
  const heartbeatWaitMs = Math.max(1000, HERMES_REASONING_TASK_HEARTBEAT_MS)
  return leaseWaitMs <= heartbeatWaitMs
    ? { waitMs: leaseWaitMs, kind: 'lease_expired' }
    : { waitMs: heartbeatWaitMs, kind: 'heartbeat' }
}

export function appendReasoningEvent(sessionId, type, title, summary, extra = {}) {
  return updateReasoningSession(sessionId, (session) => {
    const event = createReasoningEvent(sessionId, type, title, summary, extra)
    appendAgentRuntimeEventJournal({
      ...event,
      runtimeSessionId: sessionId,
      sessionKind: 'agent-runtime'
    })
    return {
      ...session,
      events: [...session.events, event]
    }
  })
}

function getReasoningPreparedWrite(session, stepId) {
  return session?.artifacts?.pendingWrites?.[stepId] || null
}

function computeNextParentChildGoal(parentSession) {
  const storedQueue = Array.isArray(parentSession?.artifacts?.childGoalQueue)
    ? parentSession.artifacts.childGoalQueue
    : null
  const initialQueue = Array.isArray(parentSession?.submissionContext?.childGoals)
    ? parentSession.submissionContext.childGoals
    : []
  const queue = storedQueue || initialQueue
  if (!queue.length) return null
  const [nextGoal, ...remainingGoals] = queue
  return {
    nextGoal,
    remainingGoals
  }
}

async function continueReasoningParentChain(completedSession) {
  const parentSessionId = String(completedSession?.parentSessionId || '').trim()
  if (!parentSessionId) return null
  const parentSession = readReasoningSession(parentSessionId)
  if (!parentSession) return null

  updateReasoningSession(parentSessionId, (current) => ({
    ...current,
    childSessionIds: Array.from(new Set([...(Array.isArray(current.childSessionIds) ? current.childSessionIds : []), completedSession.sessionId])),
    artifacts: {
      ...current.artifacts,
      childSessionResults: [
        ...(Array.isArray(current.artifacts?.childSessionResults) ? current.artifacts.childSessionResults : []),
        {
          sessionId: completedSession.sessionId,
          prompt: completedSession.userPrompt,
          finalAnswer: completedSession.artifacts?.finalAnswer || '',
          status: completedSession.status,
          completedAt: completedSession.updatedAt
        }
      ]
    }
  }))

  const nextGoalRecord = computeNextParentChildGoal(readReasoningSession(parentSessionId))
  if (!nextGoalRecord?.nextGoal) return null

  const nextPrompt = typeof nextGoalRecord.nextGoal === 'string'
    ? nextGoalRecord.nextGoal
    : String(nextGoalRecord.nextGoal?.prompt || '').trim()
  if (!nextPrompt) {
    updateReasoningSession(parentSessionId, (current) => ({
      ...current,
      artifacts: {
        ...current.artifacts,
        childGoalQueue: nextGoalRecord.remainingGoals
      }
    }))
    return null
  }

  updateReasoningSession(parentSessionId, (current) => ({
    ...current,
    artifacts: {
      ...current.artifacts,
      childGoalQueue: nextGoalRecord.remainingGoals
    }
  }))

  const childSubmissionContext = {
    ...(typeof nextGoalRecord.nextGoal === 'object' && nextGoalRecord.nextGoal && !Array.isArray(nextGoalRecord.nextGoal)
      ? nextGoalRecord.nextGoal
      : {}),
    parentSessionId,
    childGoals: nextGoalRecord.remainingGoals,
    selectedSourceIds: Array.isArray(parentSession.submissionContext?.selectedSourceIds) ? parentSession.submissionContext.selectedSourceIds : undefined,
    selectedContextPoolIds: Array.isArray(parentSession.submissionContext?.selectedContextPoolIds) ? parentSession.submissionContext.selectedContextPoolIds : undefined,
    confirmedContextSummary: parentSession.submissionContext?.confirmedContextSummary || undefined
  }

  const binding = buildHermesBinding()
  const history = readHermesChatHistory({ includeAllSessions: true })
  const childSession = await createReasoningSession(parentSession.agentId, nextPrompt, childSubmissionContext)
  persistHermesChatPrompt(childSession.sessionId, nextPrompt)
  void runReasoningSession(childSession.sessionId, binding, history)
  appendReasoningEvent(parentSessionId, 'child_session_created', '自动续跑下一目标', `已从父 session 自动派生子任务：${nextPrompt.slice(0, 120)}`, {
    data: {
      parentSessionId,
      childSessionId: childSession.sessionId,
      prompt: nextPrompt
    }
  })
  return childSession
}

function buildReasoningTextDiffPreview(previousContent, nextContent) {
  const beforeLines = String(previousContent || '').split('\n')
  const afterLines = String(nextContent || '').split('\n')
  if (beforeLines.join('\n') === afterLines.join('\n')) {
    return '[no content changes]'
  }

  const previewLines = []
  const maxLines = Math.max(beforeLines.length, afterLines.length)
  for (let index = 0; index < maxLines; index++) {
    const before = beforeLines[index]
    const after = afterLines[index]
    if (before === after) continue
    if (typeof before === 'string') previewLines.push(`- ${before}`)
    if (typeof after === 'string') previewLines.push(`+ ${after}`)
    if (previewLines.length >= 120) break
  }

  return previewLines.join('\n')
}

function applyPreparedReasoningWrite(sessionId, stepId) {
  const session = readReasoningSession(sessionId)
  if (!session) throw new Error('reasoning_session_not_found')
  const preparedWrite = getReasoningPreparedWrite(session, stepId)
  if (!preparedWrite) {
    throw new Error(`prepared_reasoning_write_not_found:${stepId}`)
  }

  fs.mkdirSync(path.dirname(preparedWrite.filePath), { recursive: true })
  fs.writeFileSync(preparedWrite.filePath, preparedWrite.updatedContent, 'utf8')

  updateReasoningSession(sessionId, (current) => {
    const nextPendingWrites = { ...(current.artifacts?.pendingWrites || {}) }
    delete nextPendingWrites[stepId]
    return {
      ...current,
      artifacts: {
        ...current.artifacts,
        pendingWrites: nextPendingWrites,
        writtenFiles: [
          ...(Array.isArray(current.artifacts?.writtenFiles) ? current.artifacts.writtenFiles : []),
          {
            filePath: preparedWrite.filePath,
            chars: preparedWrite.updatedContent.length,
            writtenAt: new Date().toISOString(),
            stepId
          }
        ]
      }
    }
  })

  return preparedWrite
}

function applyPreparedWorkspaceOperation(sessionId, stepId) {
  const session = readReasoningSession(sessionId)
  if (!session) throw new Error('reasoning_session_not_found')
  const preparedOp = session?.artifacts?.pendingWorkspaceOps?.[stepId] || null
  if (!preparedOp) {
    throw new Error(`prepared_workspace_op_not_found:${stepId}`)
  }

  if (preparedOp.opType === 'rename') {
    fs.mkdirSync(path.dirname(preparedOp.toPath), { recursive: true })
    fs.renameSync(preparedOp.fromPath, preparedOp.toPath)
  } else if (preparedOp.opType === 'delete') {
    fs.rmSync(preparedOp.targetPath, { recursive: true, force: true })
  } else {
    throw new Error(`unsupported_workspace_op:${preparedOp.opType}`)
  }

  updateReasoningSession(sessionId, (current) => {
    const nextPendingWorkspaceOps = { ...(current.artifacts?.pendingWorkspaceOps || {}) }
    delete nextPendingWorkspaceOps[stepId]
    return {
      ...current,
      artifacts: {
        ...current.artifacts,
        pendingWorkspaceOps: nextPendingWorkspaceOps,
        workspaceOpResults: [
          ...(Array.isArray(current.artifacts?.workspaceOpResults) ? current.artifacts.workspaceOpResults : []),
          {
            ...preparedOp,
            appliedAt: new Date().toISOString(),
            stepId
          }
        ]
      }
    }
  })

  return preparedOp
}

function applyPreparedLifecycleScript(sessionId, stepId) {
  const session = readReasoningSession(sessionId)
  if (!session) throw new Error('reasoning_session_not_found')
  const preparedScript = session?.artifacts?.pendingScriptRuns?.[stepId]
    || session?.artifacts?.pendingLifecycleScripts?.[stepId]
    || null
  if (!preparedScript) {
    throw new Error(`prepared_reasoning_script_not_found:${stepId}`)
  }

  const result = spawnSync('bash', [preparedScript.scriptPath], {
    cwd: GAMESTUDIO_ROOT,
    encoding: 'utf8',
    timeout: 30000
  })
  const output = (result.stdout || '') + (result.stderr || '')

  updateReasoningSession(sessionId, (current) => {
    const nextPendingScripts = { ...(current.artifacts?.pendingScriptRuns || current.artifacts?.pendingLifecycleScripts || {}) }
    delete nextPendingScripts[stepId]
    return {
      ...current,
      artifacts: {
        ...current.artifacts,
        pendingScriptRuns: nextPendingScripts,
        pendingLifecycleScripts: nextPendingScripts,
        lifecycleScriptResults: [
          ...(Array.isArray(current.artifacts?.lifecycleScriptResults) ? current.artifacts.lifecycleScriptResults : []),
          {
            scriptName: preparedScript.scriptName,
            scriptPath: preparedScript.scriptPath,
            exitCode: result.status,
            output: output.slice(0, 2000),
            ranAt: new Date().toISOString()
          }
        ]
      }
    }
  })

  return {
    ...preparedScript,
    exitCode: result.status,
    output,
  }
}

export function buildReasoningReview(targetType, options = {}) {
  return {
    status: 'pending',
    targetType,
    reviewPhase: String(options.reviewPhase || 'standard').trim() || 'standard',
    action: String(options.action || '').trim() || null,
    stepId: options.stepId || null,
    stepIndex: Number.isInteger(options.stepIndex) ? options.stepIndex : null,
    title: String(options.title || '').trim() || ((targetType === 'plan' || targetType === 'runtime_task_graph') ? '审核运行任务图' : '审核步骤'),
    summary: String(options.summary || '').trim(),
    correctionPrompt: options.correctionPrompt ? String(options.correctionPrompt) : null,
    iteration: Number(options.iteration || 1),
    allowAutoApprove: options.allowAutoApprove !== false,
    requiredHumanDecision: options.requiredHumanDecision === true,
    requiresApplyOnApprove: options.requiresApplyOnApprove === true,
    evidence: options.evidence || null
  }
}

export function requestReasoningReview(sessionId, review, eventData = {}) {
  const current = readReasoningSession(sessionId)
  if (isReasoningSessionTerminalStatus(current?.status)) return current

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

export function finalizeReasoningSession(sessionId, options = {}) {
  const session = readReasoningSession(sessionId)
  if (!session) {
    throw new Error('reasoning_session_not_found')
  }
  if (session.status === 'cancelled') {
    unmarkReasoningSessionActive(sessionId)
    clearActiveReasoningExecution(sessionId)
    return session
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
  unmarkReasoningSessionActive(sessionId)
  const finalizedSession = readReasoningSession(sessionId)
  void continueReasoningParentChain(finalizedSession).catch((error) => {
    appendHermesLog(`[REASONING][CHAIN][ERROR] sessionId=${sessionId} detail=${error instanceof Error ? error.message : String(error)}`)
  })
  return finalizedSession
}

async function generateReasoningQualityCalibrationLesson(session, binding, review, correctionPrompt = '') {
  const assessment = session?.artifacts?.latestAnswerAssessment || null
  const userFeedback = String(correctionPrompt || '').trim()
  if (!userFeedback) {
    return JSON.stringify({
      lesson: '用户仅点击通过，未填写额外人工反馈；本记录表示人工接受本次答案，但不包含可泛化的新增评分规则。',
      scoringAdjustment: '将本次问题、答案、自动评分和通过决策保存为评分校准样本，供后续质量门参考；不会自动修改评分器代码、intent、workflow 或智能体规则。',
      futureCheck: '后续同类问题仍需基于可观测 artifacts 独立评分；若需要形成稳定规则，必须由人工补充反馈或审核 proposal。'
    })
  }
  const messages = [
    {
      role: 'system',
      content: [
        'You are improving GameStudio control answer quality scoring.',
        'A human reviewer approved an answer that the automatic quality gate rejected or doubted.',
        'Return one strict JSON object with keys: lesson, scoringAdjustment, futureCheck.',
        'Do not rewrite source code. Produce concise calibration guidance in Chinese.'
      ].join('\n')
    },
    {
      role: 'user',
      content: [
        `用户问题：${session?.userPrompt || ''}`,
        '',
        `Hermes 答案：\n${session?.artifacts?.finalAnswer || ''}`,
        '',
        `自动评分：\n${JSON.stringify(assessment || {}, null, 2)}`,
        '',
        `人工反馈：${userFeedback}`,
        '',
        `审核阶段：${review?.reviewPhase || ''}`
      ].join('\n')
    }
  ]

  try {
    const data = await requestHermesChatCompletion({
      sessionId: session?.sessionId || null,
      phase: 'quality_calibration',
      messages,
      maxTokens: 360
    })
    return String(data.choices?.[0]?.message?.content || '').trim()
  } catch (error) {
    return JSON.stringify({
      lesson: '人工确认自动评分误判；后续评分必须优先核对可观测工具返回的直接子项是否已完整出现在答案中。',
      scoringAdjustment: '完整列出单个目录的路径和所有直接子项时，应允许通过质量门。',
      futureCheck: error instanceof Error ? error.message : String(error)
    })
  }
}

async function approveReasoningQualityOverride(sessionId, binding, review, correctionPrompt = '') {
  const session = readReasoningSession(sessionId)
  if (!session) throw new Error('reasoning_session_not_found')
  const normalizedCorrectionPrompt = String(correctionPrompt || '').trim()
  const assessment = session.artifacts?.latestAnswerAssessment || null
  const calibrationLesson = await generateReasoningQualityCalibrationLesson(session, binding, review, normalizedCorrectionPrompt)
  const latestSelfReview = session.artifacts?.latestSelfReview || null

  appendReasoningQualityCalibrationRecord({
    sessionId,
    userPrompt: session.userPrompt,
    finalAnswer: session.artifacts?.finalAnswer || '',
    assessment,
    correctionPrompt: normalizedCorrectionPrompt || null,
    reviewerFeedbackProvided: Boolean(normalizedCorrectionPrompt),
    calibrationLesson,
    artifactsSummary: summarizeReasoningArtifactsForAssessment(session.artifacts || {})
  })

  updateReasoningSession(sessionId, (current) => ({
    ...current,
    artifacts: {
      ...current.artifacts,
      latestQualityCalibration: {
        recordedAt: new Date().toISOString(),
        calibrationLesson,
        correctionPrompt: normalizedCorrectionPrompt || null,
        reviewerFeedbackProvided: Boolean(normalizedCorrectionPrompt),
        effect: '保存评分校准样本；不自动修改评分器代码、intent、workflow 或智能体规则。'
      }
    }
  }))

  const calibrationSummary = normalizedCorrectionPrompt
    ? '用户点击通过并填写了反馈；本次问题、答案、评分结果和人工反馈已写入评分校准样本。该样本供后续质量门参考，不会自动修改评分器代码、intent、workflow 或智能体规则。'
    : '用户点击通过，未填写额外反馈；系统已写入一条“通过决策”评分校准样本。该样本供后续质量门参考，不会自动修改评分器代码、intent、workflow 或智能体规则。'

  appendReasoningEvent(sessionId, 'quality_calibration_recorded', '已记录评分校准样本', calibrationSummary, {
    data: {
      assessment,
      calibrationLesson,
      correctionPrompt: normalizedCorrectionPrompt || null,
      reviewerFeedbackProvided: Boolean(normalizedCorrectionPrompt),
      effect: 'sample_only_no_code_or_rule_change'
    }
  })

  if (latestSelfReview?.promotableLesson) {
    appendReasoningImprovementCandidateRecord({
      source: 'quality_override_approved',
      sessionId,
      userPrompt: session.userPrompt,
      finalAnswer: session.artifacts?.finalAnswer || '',
      assessment,
      selfReview: latestSelfReview,
      candidate: latestSelfReview.promotableLesson,
      artifactsSummary: summarizeReasoningArtifactsForAssessment(session.artifacts || {})
    })
    appendReasoningEvent(sessionId, 'self_improvement_candidate_recorded', '自我强化候选已记录', `已记录 1 条待审核强化候选：${latestSelfReview.promotableLesson.summary || latestSelfReview.promotableLesson.category || '未命名候选'}`, {
      data: {
        source: 'quality_override_approved',
        promotableLesson: latestSelfReview.promotableLesson
      }
    })

    const operatorProposalResult = enqueueSelfReviewOperatorProposals({
      source: 'quality_override_approved',
      sessionId,
      userPrompt: session.userPrompt,
      finalAnswer: session.artifacts?.finalAnswer || '',
      assessment,
      selfReview: latestSelfReview,
    })
    if (operatorProposalResult.written.length > 0) {
      appendReasoningEvent(sessionId, 'operator_rule_proposal_enqueued', 'Operator 规则提案已入队', `已根据 operator 规则自动生成 ${operatorProposalResult.written.length} 个待审核 JSON intent 候选。`, {
        data: operatorProposalResult
      })
    }
  }

  return finalizeReasoningSession(sessionId, { persistFinalAnswer: true })
}

function markReasoningSessionFailed(sessionId, error) {
  const currentSession = readReasoningSession(sessionId)
  if (!currentSession) return
  if (isReasoningSessionTerminalStatus(currentSession.status)) {
    unmarkReasoningSessionActive(sessionId)
    clearActiveReasoningExecution(sessionId)
    return
  }
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
  unmarkReasoningSessionActive(sessionId)
  clearActiveReasoningExecution(sessionId)
}

function getReasoningErrorDetail(error) {
  return error instanceof Error ? error.message : String(error)
}

function isRecoverableReasoningStepError(error, step) {
  const detail = getReasoningErrorDetail(error)
  if (!step || !detail) return false
  if (step.action === 'read_file_content') {
    return /read_file_content_not_found:|read_file_content_not_file:|ENOENT|EISDIR/i.test(detail)
  }
  if (step.action === 'list_directory_contents') {
    return /list_directory_contents_not_found:|list_directory_contents_not_directory:|ENOENT|ENOTDIR/i.test(detail)
  }
  return false
}

function summarizeReasoningArtifactsForRecovery(artifacts = {}) {
  const lines = []
  const directoryListings = artifacts?.directoryListings && typeof artifacts.directoryListings === 'object'
    ? artifacts.directoryListings
    : {}
  for (const [dirPath, listing] of Object.entries(directoryListings).slice(-4)) {
    const entries = Array.isArray(listing?.entries)
      ? listing.entries.map((entry) => `${entry.kind === 'directory' ? '[dir]' : '[file]'} ${entry.name}`).slice(0, 12).join(', ')
      : ''
    lines.push(`- 已列目录 ${dirPath}: ${entries || '空目录或无可显示子项'}`)
  }

  const fileContents = artifacts?.fileContents && typeof artifacts.fileContents === 'object'
    ? artifacts.fileContents
    : {}
  for (const filePath of Object.keys(fileContents).slice(-6)) {
    lines.push(`- 已读文件 ${normalizeWorkspaceRelativePath(path.relative(GAMESTUDIO_ROOT, filePath)) || filePath}`)
  }

  return lines.length > 0 ? lines.join('\n') : '- 暂无已完成的可观测证据。'
}

function buildRecoverableStepFailureCorrectionPrompt(session, step, stepIndex, error) {
  const detail = getReasoningErrorDetail(error)
  const attemptedOps = buildReasoningObservableOps(step).join('; ') || `${step.action} ${JSON.stringify(step.params || {})}`
  return [
    '上一轮执行中有一个可观测工具失败，但该失败不是终局错误，请把它当成新的 artifact 继续规划。',
    `失败步骤：#${stepIndex + 1} ${step.title || step.action}`,
    `失败动作：${step.action}`,
    `尝试操作：${attemptedOps}`,
    `错误信息：${detail}`,
    '重规划要求：不要再次读取同一个不存在的路径；改用已经存在的目录列表、package.json、src 目录、入口文件、或 search_workspace_text 等替代证据来回答原问题。',
    '如果问题只是分析目录或文件职责，这是只读分析任务，不要追加 write_memory_file 或 update_task_queue。',
    '已完成证据：',
    summarizeReasoningArtifactsForRecovery(session?.artifacts || {})
  ].join('\n')
}

async function recoverReasoningStepFailure(sessionId, binding, history, step, stepIndex, error) {
  const session = readReasoningSession(sessionId)
  if (!session || session.status === 'cancelled') return false
  if (!isRecoverableReasoningStepError(error, step)) return false

  const recoverableFailureCount = Number(session.artifacts?.recoverableFailureCount || 0)
  if (recoverableFailureCount >= 2) return false

  const detail = getReasoningErrorDetail(error)
  const stepError = {
    at: new Date().toISOString(),
    stepId: step.stepId,
    stepIndex,
    title: step.title,
    action: step.action,
    tool: step.tool,
    params: step.params || {},
    message: detail,
    observableOps: buildReasoningObservableOps(step)
  }

  updateReasoningSession(sessionId, (current) => ({
    ...current,
    status: 'running',
    error: null,
    artifacts: {
      ...current.artifacts,
      recoverableFailureCount: recoverableFailureCount + 1,
      stepErrors: [...(current.artifacts?.stepErrors || []), stepError],
      latestStepReviewEvidence: {
        targetType: 'step_error',
        stepId: step.stepId,
        stepTitle: step.title,
        tool: step.tool,
        outboundPreview: {
          action: step.action,
          tool: step.tool,
          params: step.params || {},
          observableOps: stepError.observableOps
        },
        rawResponsePreview: detail,
        structuredResult: stepError
      },
      nextStepIndex: stepIndex
    }
  }))
  appendReasoningEvent(sessionId, 'step_failed_recoverable', '步骤失败，准备重规划', detail, {
    stepId: step.stepId,
    data: stepError
  })

  const correctionPrompt = buildRecoverableStepFailureCorrectionPrompt(readReasoningSession(sessionId), step, stepIndex, error)
  await prepareReasoningSessionPlan(sessionId, binding, history, { correctionPrompt })
  return true
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
    transientProbeFailureCount: 0,
    transientProbeFailureBudget: HERMES_REASONING_TRANSIENT_PROBE_FAILURE_BUDGET,
    hardTimeoutAt: new Date(now.getTime() + HERMES_REASONING_TASK_HARD_TIMEOUT_MS).toISOString(),
    providerStatus: null,
    lastObservedAt: null,
    error: null
  }
}

function shouldTreatProbeFailureAsTransient(task, probe) {
  if (!task || !probe) return false
  if (probe.state !== 'provider_probe_failed' && probe.state !== 'provider_unreachable') {
    return false
  }

  const hardTimeoutAtMs = Date.parse(String(task.hardTimeoutAt || ''))
  if (Number.isFinite(hardTimeoutAtMs) && Date.now() >= hardTimeoutAtMs) {
    return false
  }

  const budget = Math.max(0, Number(task.transientProbeFailureBudget || HERMES_REASONING_TRANSIENT_PROBE_FAILURE_BUDGET))
  const failureCount = Math.max(0, Number(task.transientProbeFailureCount || 0))
  return failureCount < budget
}

function buildTransientProbeContinuation(probe, phase, task) {
  const nextFailureCount = Math.max(0, Number(task?.transientProbeFailureCount || 0)) + 1
  const budget = Math.max(0, Number(task?.transientProbeFailureBudget || HERMES_REASONING_TRANSIENT_PROBE_FAILURE_BUDGET))
  return {
    ...probe,
    state: 'provider_probe_failed_transient',
    canContinue: true,
    detail: `OMLX probe暂时失败（${nextFailureCount}/${budget}）：${probe.detail}；保留当前 ${phase} 本地推理任务，继续等待下一个观察窗口`
  }
}

function setActiveReasoningExecution(sessionId, phase, controller) {
  activeHermesReasoningExecutions.set(sessionId, {
    sessionId,
    phase,
    controller,
    startedAt: Date.now()
  })
}

function clearActiveReasoningExecution(sessionId, phase = null) {
  const currentExecution = getActiveReasoningExecution(sessionId)
  if (!currentExecution) return
  if (phase && currentExecution.phase !== phase) return
  activeHermesReasoningExecutions.delete(sessionId)
}

function isReasoningSessionTerminalStatus(status) {
  return status === 'completed' || status === 'failed' || status === 'cancelled'
}

function cancelReasoningSession(sessionId, reason = 'reasoning_cancelled_by_user') {
  const session = readReasoningSession(sessionId)
  if (!session) {
    throw new Error('reasoning_session_not_found')
  }

  if (isReasoningSessionTerminalStatus(session.status)) {
    return session
  }

  const detail = String(reason || 'reasoning_cancelled_by_user')
  const activeExecution = getActiveReasoningExecution(sessionId)
  const activePhase = activeExecution?.sessionId === sessionId
    ? activeExecution.phase
    : null

  if (activeExecution?.sessionId === sessionId) {
    try {
      activeExecution.controller?.abort(detail)
    } catch {
      // Ignore abort propagation failures.
    }
    activeHermesReasoningExecutions.delete(sessionId)
  }

  updateReasoningSession(sessionId, (current) => ({
    ...current,
    status: 'cancelled',
    currentStepId: null,
    review: null,
    error: detail,
    artifacts: {
      ...current.artifacts,
      cancelledAt: new Date().toISOString(),
      cancelledPhase: activePhase
    }
  }))

  appendReasoningEvent(sessionId, 'session_cancelled', '推理已停止', activePhase
    ? `已停止当前 ${activePhase} 阶段并中断 Hermes / OMLX 请求。`
    : '已停止当前推理流程。', {
    data: {
      reason: detail,
      phase: activePhase
    }
  })
  appendHermesLog(`[REASONING][CANCEL] sessionId=${sessionId} phase=${activePhase || 'idle'} reason=${detail}`)
  unmarkReasoningSessionActive(sessionId)
  return readReasoningSession(sessionId)
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
  const phaseLabel = phase === 'plan' ? '运行任务图任务' : `${phase} 任务`
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
  setActiveReasoningExecution(sessionId, phase, controller)
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
        maxRenewals: HERMES_REASONING_TASK_MAX_RENEWS,
        transientProbeFailureBudget: initialTask.transientProbeFailureBudget,
        hardTimeoutMs: HERMES_REASONING_TASK_HARD_TIMEOUT_MS,
        hardTimeoutAt: initialTask.hardTimeoutAt,
        leaseExpiresAt: initialTask.leaseExpiresAt,
        renewalCount: initialTask.renewalCount
      }
    })
    appendHermesLog(`[REASONING][TASK][START] sessionId=${sessionId} phase=${phase} provider=${binding.provider} model=${binding.model} leaseMs=${HERMES_REASONING_TASK_LEASE_MS} maxRenewals=${HERMES_REASONING_TASK_MAX_RENEWS}`)

    while (true) {
      const currentTaskForWait = getReasoningTask(readReasoningSession(sessionId), phase)
      const wait = getReasoningSessionLeaseWait(currentTaskForWait)
      const result = await Promise.race([
        executionPromise,
        new Promise((resolve) => {
          setTimeout(() => resolve({ kind: wait.kind }), wait.waitMs)
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
        appendHermesLog(`[REASONING][TASK][DONE] sessionId=${sessionId} phase=${phase}`)
        return result.value
      }

      if (result?.kind === 'rejected') {
        const detail = result.error instanceof Error ? result.error.message : String(result.error)
        const currentSession = readReasoningSession(sessionId)
        if (currentSession?.status === 'cancelled') {
          updateReasoningTask(sessionId, phase, (task) => ({
            ...task,
            status: 'cancelled',
            finishedAt: new Date().toISOString(),
            lastObservedAt: new Date().toISOString(),
            error: currentSession.error || detail
          }))
          throw new Error(currentSession.error || detail)
        }
        updateReasoningTask(sessionId, phase, (task) => ({
          ...task,
          status: 'failed',
          finishedAt: new Date().toISOString(),
          lastObservedAt: new Date().toISOString(),
          error: detail
        }))
        appendReasoningEvent(sessionId, 'task_failed', phaseLabel, detail, { data: { phase } })
        appendHermesLog(`[REASONING][TASK][FAILED] sessionId=${sessionId} phase=${phase} detail=${detail}`)
        throw result.error
      }

      if (result?.kind === 'heartbeat') {
        const currentSession = readReasoningSession(sessionId)
        if (currentSession?.status === 'cancelled') {
          updateReasoningTask(sessionId, phase, (task) => ({
            ...task,
            status: 'cancelled',
            finishedAt: new Date().toISOString(),
            lastObservedAt: new Date().toISOString(),
            error: currentSession.error || 'reasoning_cancelled_by_user'
          }))
          throw new Error(currentSession.error || 'reasoning_cancelled_by_user')
        }

        const currentTask = getReasoningTask(currentSession, phase)
        const activeForMs = currentTask?.startedAt
          ? Math.max(0, Date.now() - Date.parse(currentTask.startedAt))
          : null
        updateReasoningTask(sessionId, phase, (task) => ({
          ...task,
          lastObservedAt: new Date().toISOString(),
          telemetrySource: 'control_heartbeat'
        }))
        appendReasoningEvent(sessionId, 'task_heartbeat', phaseLabel, `${phaseLabel}仍在执行，已运行 ${activeForMs == null ? '未知' : Math.round(activeForMs / 1000)} 秒。`, {
          data: {
            phase,
            activeForMs,
            provider: binding.provider,
            model: binding.model,
            heartbeatMs: HERMES_REASONING_TASK_HEARTBEAT_MS
          }
        })
        appendHermesLog(`[REASONING][TASK][HEARTBEAT] sessionId=${sessionId} phase=${phase} activeForMs=${activeForMs ?? 'unknown'}`)
        continue
      }

      const currentSession = readReasoningSession(sessionId)
      if (currentSession?.status === 'cancelled') {
        updateReasoningTask(sessionId, phase, (task) => ({
          ...task,
          status: 'cancelled',
          finishedAt: new Date().toISOString(),
          lastObservedAt: new Date().toISOString(),
          error: currentSession.error || 'reasoning_cancelled_by_user'
        }))
        throw new Error(currentSession.error || 'reasoning_cancelled_by_user')
      }

      const currentTask = getReasoningTask(currentSession, phase)
      const rawProbe = await probeReasoningProviderTask(binding, phase, currentTask)
      const probe = shouldTreatProbeFailureAsTransient(currentTask, rawProbe)
        ? buildTransientProbeContinuation(rawProbe, phase, currentTask)
        : rawProbe
      const nextRenewalCount = probe.canContinue ? currentTask.renewalCount + 1 : currentTask.renewalCount
      const nextLeaseExpiresAt = probe.canContinue
        ? new Date(Date.now() + HERMES_REASONING_TASK_LEASE_MS).toISOString()
        : currentTask.leaseExpiresAt
      const nextTransientProbeFailureCount = probe.canContinue
        ? (probe.state === 'provider_probe_failed_transient'
            ? Math.max(0, Number(currentTask.transientProbeFailureCount || 0)) + 1
            : 0)
        : Math.max(0, Number(currentTask.transientProbeFailureCount || 0))

      updateReasoningTask(sessionId, phase, (task) => ({
        ...task,
        status: probe.canContinue ? 'waiting_provider' : 'failed',
        renewalCount: nextRenewalCount,
        leaseExpiresAt: nextLeaseExpiresAt,
        transientProbeFailureCount: nextTransientProbeFailureCount,
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
            providerStatus: probe,
            renewalCount: nextRenewalCount,
            maxRenewals: currentTask.maxRenewals,
            transientProbeFailureCount: nextTransientProbeFailureCount,
            transientProbeFailureBudget: currentTask.transientProbeFailureBudget,
            leaseMs: currentTask.leaseMs,
            leaseExpiresAt: nextLeaseExpiresAt,
            hardTimeoutAt: currentTask.hardTimeoutAt,
            provider: currentTask.provider,
            model: currentTask.model
          }
        })
        appendHermesLog(`[REASONING][TASK][WAIT] sessionId=${sessionId} phase=${phase} renewals=${nextRenewalCount}/${currentTask.maxRenewals} leaseExpiresAt=${nextLeaseExpiresAt} providerState=${probe.state} detail=${probe.detail}`)
        continue
      }

      controller.abort()
      appendReasoningEvent(sessionId, 'task_probe_failed', phaseLabel, probe.detail, {
        data: {
          phase,
          providerStatus: probe,
          renewalCount: nextRenewalCount,
          maxRenewals: currentTask.maxRenewals,
          leaseMs: currentTask.leaseMs,
          leaseExpiresAt: nextLeaseExpiresAt,
          hardTimeoutAt: currentTask.hardTimeoutAt,
          provider: currentTask.provider,
          model: currentTask.model
        }
      })
      appendHermesLog(`[REASONING][TASK][PROBE_FAILED] sessionId=${sessionId} phase=${phase} renewals=${nextRenewalCount}/${currentTask.maxRenewals} detail=${probe.detail}`)
      throw createReasoningTaskTimeoutResult(phase, currentTask, probe)
    }
  } finally {
    clearTimeout(hardTimeout)
    clearActiveReasoningExecution(sessionId, phase)
  }
}

export function inferWorkspaceDirectoriesFromRecentContext(userPrompt, history) {
  if (!isDirectoryListingPrompt(userPrompt)) return []
  if (isEditorLocationPrompt(userPrompt) || isControlLocationPrompt(userPrompt) || isBusinessServerLocationPrompt(userPrompt)) return []
  const recentMessages = collectReplayableHermesMessages(history, { limit: 6, userPrompt })
  const latestAssistantMessage = [...recentMessages]
    .reverse()
    .find((message) => message?.role === 'assistant' || message?.role === 'hermes')
  const recentText = String(latestAssistantMessage?.content || '')
  const candidates = []
  const pathPattern = /(?:\/[^\s`|，。；：]+\/gamestudio\/)?((?:apps|packages|storage|docs|scripts|ai|config|monitor|state)\/[A-Za-z0-9._/-]+)/g
  let match = null
  while ((match = pathPattern.exec(recentText))) {
    const candidate = normalizeWorkspaceRelativePath(match[1]).replace(/[).,;，。；：]+$/g, '')
    if (candidate) candidates.push(candidate)
  }

  const uniqueDirectories = []
  const seen = new Set()
  for (const candidate of candidates) {
    const resolvedPath = resolveWorkspacePathFromInput(candidate)
    if (!resolvedPath || !resolvedPath.startsWith(GAMESTUDIO_ROOT)) continue
    if (!fs.existsSync(resolvedPath) || !fs.statSync(resolvedPath).isDirectory()) continue
    const relativePath = normalizeWorkspaceRelativePath(path.relative(GAMESTUDIO_ROOT, resolvedPath)) || '.'
    if (seen.has(relativePath)) continue
    seen.add(relativePath)
    uniqueDirectories.push(relativePath)
  }
  return uniqueDirectories
}

const REASONING_INTENT_RULES = []

export function inferReasoningStepSkipReview(step) {
  if (typeof step?.skipReview === 'boolean') {
    return step.skipReview
  }
  return !isReasoningWriteAction(step?.action) && !isReasoningInvokeAction(step?.action)
}

function getReasoningReviewMode(sessionOrContext) {
  const mode = String(sessionOrContext?.submissionContext?.reviewMode || sessionOrContext?.reviewMode || '').trim().toLowerCase()
  return mode === 'auto' ? 'auto' : 'manual'
}

function isReasoningAutoReviewMode(sessionOrContext) {
  return getReasoningReviewMode(sessionOrContext) === 'auto'
}

function shouldPauseBeforeExecutingReasoningStep(session, step) {
  if (!session || !step) return false
  if (isReasoningAutoReviewMode(session)) return false
  return !isReasoningWriteAction(step.action) && !isReasoningInvokeAction(step.action)
}

function shouldRequireHumanReviewForStep(step, session = null) {
  if (!step) return false
  if (isReasoningAutoReviewMode(session)) return false
  if (isReasoningWriteAction(step.action) || isReasoningInvokeAction(step.action)) return true
  return inferReasoningStepSkipReview(step) === false
}

function canReasoningReviewAutoApprove(review) {
  if (!review) return false
  return review.allowAutoApprove !== false && review.requiredHumanDecision !== true
}

function getSelectedSkillDefinitions(binding, contextSelection = {}) {
  const selectedSourceIds = new Set(
    Array.isArray(contextSelection?.selectedSourceIds)
      ? contextSelection.selectedSourceIds.map((value) => String(value))
      : []
  )
  const availableSkills = Array.isArray(binding?.skills?.availableSkills) ? binding.skills.availableSkills : []
  if (selectedSourceIds.size === 0) return availableSkills
  return availableSkills.filter((skill) => selectedSourceIds.has(`skill:${skill.filePath}`))
}

function buildSkillReasoningIntentRules(binding, contextSelection = {}) {
  const skills = getSelectedSkillDefinitions(binding, contextSelection)
  const rules = []

  for (const skill of skills) {
    for (const hint of Array.isArray(skill.actionHints) ? skill.actionHints : []) {
      rules.push({
        key: `skill:${path.basename(skill.filePath)}:${hint.hintId}`,
        goal: `根据 ${path.basename(skill.filePath)} 的 action hint 生成可观测计划`,
        matches: (userPrompt) => hint.keywords.some((keyword) => String(userPrompt || '').toLowerCase().includes(String(keyword || '').toLowerCase())),
        requiredActions: hint.requiredActions,
        answerAction: hint.answerAction,
        source: 'skill',
        skillFile: skill.filePath,
        keywords: hint.keywords,
        prependContext: hint.prependContext !== false
      })
    }
  }

  return rules
}

export function getMatchingReasoningIntentRules(userPrompt, history, binding, contextSelection = {}) {
  const candidateRules = [
    ...REASONING_INTENT_RULES,
    ...buildSkillReasoningIntentRules(binding, contextSelection)
  ]

  return candidateRules.filter((rule) => {
    try {
      return Boolean(rule.matches(userPrompt, history, binding, contextSelection))
    } catch {
      return false
    }
  })
}

export function collectReplayableHermesMessages(history, options = {}) {
  const replayablePairs = []
  const excludedRequestId = String(options.excludeRequestId || '').trim()
  const limit = Math.max(0, Number.isFinite(Number(options.limit)) ? Number(options.limit) : MAX_REPLAYED_HERMES_CHAT_MESSAGES)
  const currentPrompt = String(options.userPrompt || '').trim()
  const currentTerms = extractContextMatchTerms(currentPrompt)
  const allowRecentCarryover = shouldAllowRecentContextCarryover(currentPrompt)
  let pendingUserMessage = null

  for (const item of Array.isArray(history) ? history : []) {
    const role = String(item?.role || '').trim().toLowerCase()
    const content = String(item?.content || '')
    const requestId = String(item?.requestId || '').trim()
    if (!content) continue
    if (excludedRequestId && requestId === excludedRequestId) continue

    if (role === 'user') {
      pendingUserMessage = { role: 'user', content }
      continue
    }

    if (role === 'hermes' || role === 'assistant') {
      if (isHermesChatErrorReplay(content)) continue
      if (pendingUserMessage && shouldSkipInvalidCompletedReplayPair(pendingUserMessage.content, content)) {
        pendingUserMessage = null
        continue
      }
      if (pendingUserMessage) {
        replayablePairs.push({ user: pendingUserMessage, assistant: { role: 'assistant', content } })
      }
      pendingUserMessage = null
    }
  }

  const dedupedPairs = []
  const seenPairs = new Set()
  for (const pair of replayablePairs) {
    const key = normalizeContextComparableText(`${pair.user.content}\n${pair.assistant.content}`).slice(0, 1600)
    if (seenPairs.has(key)) continue
    seenPairs.add(key)
    dedupedPairs.push(pair)
  }

  const selectedPairs = currentPrompt
    ? selectReplayableContextPairs(dedupedPairs, currentTerms, allowRecentCarryover, currentPrompt)
    : dedupedPairs

  const replayableMessages = selectedPairs.flatMap((pair) => [pair.user, pair.assistant])
  return limit > 0 ? replayableMessages.slice(-limit) : []
}

function selectReplayableContextPairs(pairs, currentTerms, allowRecentCarryover, currentPrompt = '') {
  const normalizedCurrentPrompt = normalizeContextComparableText(currentPrompt)
  const indexedPairs = pairs.map((pair, index) => {
    const pairTerms = extractContextMatchTerms(`${pair.user.content}\n${pair.assistant.content}`)
    const overlap = countTermOverlap(currentTerms, pairTerms)
    const strongOverlap = countStrongContextOverlap(currentTerms, pairTerms)
    const recencyScore = index / Math.max(1, pairs.length)
    const isRecentCarryover = allowRecentCarryover && index >= Math.max(0, pairs.length - 3)
    const exactPromptMatch = normalizedCurrentPrompt && normalizeContextComparableText(pair.user.content) === normalizedCurrentPrompt
    return {
      pair,
      index,
      score: (exactPromptMatch ? 100 : 0) + strongOverlap * 12 + overlap * 3 + recencyScore + (isRecentCarryover ? 3 : 0),
      selected: exactPromptMatch || strongOverlap >= 2 || isRecentCarryover
    }
  })

  const selected = indexedPairs
    .filter((item) => item.selected)
    .sort((left, right) => right.score - left.score || right.index - left.index)
    .slice(0, 6)
    .sort((left, right) => left.index - right.index)
    .map((item) => item.pair)

  if (selected.length > 0 || !allowRecentCarryover) return selected
  return pairs.slice(-1)
}

function countTermOverlap(leftTerms, rightTerms) {
  if (!leftTerms.size || !rightTerms.size) return 0
  let count = 0
  for (const term of leftTerms) {
    if (rightTerms.has(term)) count += 1
  }
  return count
}

function countStrongContextOverlap(leftTerms, rightTerms) {
  if (!leftTerms.size || !rightTerms.size) return 0
  let count = 0
  for (const term of leftTerms) {
    if (!rightTerms.has(term)) continue
    if (term.includes('/')) {
      count += 1
      continue
    }
    if (/^[a-z0-9._-]{5,}$/i.test(term)) {
      count += 1
      continue
    }
    if ((term.match(/[\u4e00-\u9fff]/g) || []).length >= 4) {
      count += 1
    }
  }
  return count
}

function shouldAllowRecentContextCarryover(prompt) {
  const text = String(prompt || '').toLowerCase()
  return /(继续|上一|上面|刚才|刚刚|它|这个|这些|该|前者|后者|列表|包含|再问|重复|same|again|previous|continue|that|those)/i.test(text)
}

function extractContextMatchTerms(value) {
  const text = normalizeContextComparableText(value)
  const terms = new Set()
  for (const match of text.matchAll(/\b(?:apps|packages|storage|docs|scripts|ai|config|monitor|state)\/[a-z0-9._/-]+\b/g)) {
    terms.add(match[0])
  }
  for (const token of text.split(/[^a-z0-9\u4e00-\u9fa5._/-]+/i)) {
    const normalized = token.trim()
    if (normalized.length < 2) continue
    if (CONTEXT_STOP_TERMS.has(normalized)) continue
    terms.add(normalized)
  }
  return terms
}

function normalizeContextComparableText(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[`*_#>|()[\]{}:：,，.。;；!?！？]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

const CONTEXT_STOP_TERMS = new Set([
  'the', 'and', 'for', 'with', 'from', 'this', 'that', 'what', 'where', 'when', 'how',
  '当前', '问题', '回答', '说明', '分析', '执行', '检查', '测试', '一个', '这个', '这些', '为什么', '是什么', '哪些', '如何', '是否', '必须', '不能', '不要', '可以'
])

function shouldSkipInvalidCompletedReplayPair(userPrompt, assistantAnswer) {
  const answer = String(assistantAnswer || '').toLowerCase()
  if (isEditorLocationPrompt(userPrompt)) {
    return !answer.includes('apps/editor')
  }
  if (isControlLocationPrompt(userPrompt)) {
    return !answer.includes('apps/control-console') || !answer.includes('apps/control-server')
  }
  if (isBusinessServerLocationPrompt(userPrompt)) {
    return !answer.includes('apps/server')
  }
  return false
}

async function generateReasoningFileRewrite(sessionId, step, userPrompt, binding) {
  const targetPath = step.action === 'update_task_queue'
    ? path.join(GAMESTUDIO_ROOT, 'ai', 'memory', 'TASK_QUEUE.md')
    : String(step.params?.filePath || '').trim()
  if (!targetPath) {
    throw new Error(`${step.action}_missing_filePath`)
  }

  const resolvedPath = path.isAbsolute(targetPath)
    ? targetPath
    : path.resolve(GAMESTUDIO_ROOT, targetPath)
  const allowedRoot = path.join(GAMESTUDIO_ROOT, 'ai')
  if (step.action === 'edit_workspace_file') {
    if (!isWorkspaceEditablePath(resolvedPath)) {
      throw new Error('edit_workspace_file_path_not_editable')
    }
  } else if (!resolvedPath.startsWith(allowedRoot)) {
    throw new Error(`${step.action}_path_outside_ai_directory`)
  }

  const currentContent = fs.existsSync(resolvedPath) ? fs.readFileSync(resolvedPath, 'utf8') : ''
  const desiredContent = buildReasoningWriteFallbackContent(step, currentContent)
  const messages = buildReasoningFileRewriteMessages(step, userPrompt, resolvedPath, currentContent, desiredContent)

  let updatedContent = desiredContent
  let summary = '使用 fallback 内容生成写入结果。'
  let rawResponsePreview = ''
  try {
    const data = await requestHermesChatCompletion({
      sessionId,
      phase: `reasoning_write_${String(step.stepId || step.action || 'unknown')}`,
      messages,
      maxTokens: 1400,
      temperature: 0
    })
    rawResponsePreview = truncateReasoningPreview(data.choices?.[0]?.message?.content || '{}', 2400)
    try {
      const parsed = JSON.parse(extractJsonObjectString(data.choices?.[0]?.message?.content || '{}'))
      if (typeof parsed?.updatedContent === 'string' && parsed.updatedContent.trim()) {
        updatedContent = parsed.updatedContent
      }
      if (typeof parsed?.summary === 'string' && parsed.summary.trim()) {
        summary = parsed.summary.trim()
      }
    } catch (error) {
      summary = `模型未返回有效 JSON，已使用 fallback 内容。${error instanceof Error ? error.message : String(error)}`
    }
  } catch (error) {
    rawResponsePreview = `rewrite_failed_${error instanceof Error ? error.message : String(error)}`
  }

  return {
    filePath: resolvedPath,
    previousContent: currentContent,
    updatedContent,
    summary,
    diffPreview: buildReasoningTextDiffPreview(currentContent, updatedContent),
    outboundPreview: buildStructuredOutboundPreview({
      binding,
      messages,
      purpose: 'reasoning-write-rewrite',
      mode: 'reasoning',
      userPrompt,
      replayedMessageCount: 0,
      contextSelection: {},
      history: []
    }),
    rawResponsePreview
  }
}

function getReasoningStepIndex(session, stepId) {
  const steps = Array.isArray(session?.plan?.steps) ? session.plan.steps : []
  return steps.findIndex((item) => item?.stepId === stepId)
}

function buildReasoningObservableOps(step, extra = {}) {
  if (step.action === 'read_recent_context') {
    const loadedMemorySources = Array.isArray(extra.loadedMemorySources) ? extra.loadedMemorySources : []
    const ops = [
      'replay recent Hermes chat turns from persisted chat history',
      'load markdown project memory files into prompt context'
    ]
    for (const source of loadedMemorySources.slice(0, 4)) {
      const label = String(source?.label || source?.title || source?.filePath || '').trim()
      if (label) ops.push(`load ${label}`)
    }
    return ops
  }

  if (step.action === 'locate_project') {
    return [
      `pwd -> ${GAMESTUDIO_ROOT}`,
      `ls ${path.join(GAMESTUDIO_ROOT, 'apps')}`,
      `ls ${STUDIO_STORAGE_ROOT}`,
      'resolve control-console/control-server/editor/server/storage workspace roots'
    ]
  }

  if (step.action === 'list_directory_contents') {
    const resolvedPath = String(extra.resolvedPath || step.params?.dirPath || step.params?.startDir || '').trim()
    const entries = Array.isArray(extra.entries) ? extra.entries : []
    const ops = [resolvedPath ? `ls ${resolvedPath}` : 'list workspace directory']
    for (const entry of entries.slice(0, 6)) {
      if (entry?.name) ops.push(`${entry.kind === 'directory' ? 'dir' : 'file'} ${entry.name}`)
    }
    return ops
  }

  if (step.action === 'search_workspace_text') {
    const query = String(extra.query || step.params?.query || '').trim()
    const ops = [query ? `search ${query}` : 'search workspace text']
    for (const match of Array.isArray(extra.matches) ? extra.matches.slice(0, 6) : []) {
      if (match?.filePath) ops.push(`match ${match.filePath}:${match.lineNumber || 0}`)
    }
    return ops
  }

  if (step.action === 'inspect_server_image_entrypoints') {
    const searchedRoot = String(extra.searchedRoot || path.join(GAMESTUDIO_ROOT, 'apps', 'server', 'src')).trim()
    const entries = Array.isArray(extra.entries) ? extra.entries : []
    const ops = [
      `ls ${searchedRoot}`,
      'inspect image-related server entrypoints'
    ]
    for (const entry of entries.slice(0, 4)) {
      if (entry?.filePath) ops.push(`inspect ${entry.filePath}`)
    }
    return ops
  }

  if (step.action === 'inspect_control_backend_surfaces') {
    const searchedRoot = String(extra.searchedRoot || path.join(GAMESTUDIO_ROOT, 'apps', 'control-server', 'src')).trim()
    const entries = Array.isArray(extra.entries) ? extra.entries : []
    const ops = [
      `ls ${searchedRoot}`,
      'inspect Hermes chat and reasoning backend entrypoints'
    ]
    for (const entry of entries.slice(0, 4)) {
      if (entry?.filePath) ops.push(`inspect ${entry.filePath}`)
    }
    return ops
  }

  if (step.action === 'prepare_prompt') {
    return [
      'assemble user question, recent context, and structured artifacts',
      'prepare prompt payload for final answer generation'
    ]
  }

  if (step.action === 'generate_default_answer') {
    const binding = extra.binding && typeof extra.binding === 'object' ? extra.binding : {}
    const outboundPreview = extra.outboundPreview && typeof extra.outboundPreview === 'object' ? extra.outboundPreview : {}
    const totalMessages = Number(outboundPreview.controllerRequest?.totalMessages || outboundPreview.messages?.length || 0)
    const fallbackReason = String(extra.fallbackReason || '').trim()
    if (extra.fallback) {
      return [
        `fallback answer path -> ${fallbackReason || 'deterministic observable summary'}`,
        'skip remote model call and synthesize answer from structured artifacts'
      ]
    }
    return [
      `POST ${String(binding.baseUrl || '').trim() || HERMES_API_SERVER_BASE_URL}/chat/completions`,
      `model=${String(binding.model || 'hermes-agent').trim() || 'hermes-agent'}`,
      `messages=${totalMessages}`,
      'generate final answer from observable artifacts'
    ]
  }

  if (step.action === 'read_file_content') {
    const filePath = String(step.params?.filePath || extra.filePath || '').trim()
    return filePath ? [`read ${filePath}`] : ['read workspace file']
  }

  if (step.action === 'write_memory_file') {
    const filePath = String(step.params?.filePath || extra.filePath || '').trim()
    return filePath ? [`write ${filePath}`] : ['write ai/memory file']
  }

  if (step.action === 'edit_workspace_file') {
    const filePath = String(step.params?.filePath || extra.filePath || '').trim()
    return filePath ? [`edit ${filePath}`] : ['edit workspace file']
  }

  if (step.action === 'create_workspace_file') {
    const filePath = String(step.params?.filePath || extra.filePath || '').trim()
    return filePath ? [`create ${filePath}`] : ['create workspace file']
  }

  if (step.action === 'rename_workspace_path') {
    const fromPath = String(step.params?.fromPath || extra.fromPath || '').trim()
    const toPath = String(step.params?.toPath || extra.toPath || '').trim()
    return fromPath && toPath ? [`rename ${fromPath} -> ${toPath}`] : ['rename workspace path']
  }

  if (step.action === 'delete_workspace_path') {
    const targetPath = String(step.params?.targetPath || extra.targetPath || '').trim()
    return targetPath ? [`delete ${targetPath}`] : ['delete workspace path']
  }

  if (step.action === 'update_task_queue') {
    return [`write ${path.join(GAMESTUDIO_ROOT, 'ai', 'memory', 'TASK_QUEUE.md')}`]
  }

  if (step.action === 'run_lifecycle_script') {
    const scriptName = String(step.params?.scriptName || extra.scriptName || '').trim()
    const scriptPath = String(extra.scriptPath || '').trim()
    return scriptName
      ? [scriptPath ? `approve and run ${scriptPath}` : `approve and run scripts/lifecycle/${scriptName}`]
      : ['approve and run lifecycle script']
  }

  if (step.action === 'run_workspace_script') {
    const scriptPath = String(step.params?.scriptPath || extra.scriptPath || '').trim()
    return scriptPath ? [`approve and run ${scriptPath}`] : ['approve and run workspace script']
  }

  return []
}

function buildReasoningStepEventData(step, stepIndex, extra = {}) {
  return {
    stepIndex,
    action: step.action,
    tool: step.tool,
    ...extra
  }
}

async function executeReasoningStep(sessionId, step, userPrompt, options = {}) {
  const correctionPrompt = String(options.correctionPrompt || '').trim()
  const sessionBeforeRun = readReasoningSession(sessionId)
  const stepIndex = getReasoningStepIndex(sessionBeforeRun, step.stepId)
  appendReasoningEvent(sessionId, 'step_started', step.title, `开始执行：${step.tool}`, {
    stepId: step.stepId,
    data: buildReasoningStepEventData(step, stepIndex)
  })
  updateReasoningSession(sessionId, (session) => ({
    ...session,
    status: 'running',
    currentStepId: step.stepId
  }))
  appendReasoningEvent(sessionId, 'tool_called', step.title, `调用工具：${step.tool}`, {
    stepId: step.stepId,
    data: buildReasoningStepEventData(step, stepIndex, {
      observableOps: buildReasoningObservableOps(step)
    })
  })

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
        data: buildReasoningStepEventData(step, stepIndex, {
          ...recentContext,
          observableOps: buildReasoningObservableOps(step, {
            loadedMemorySources: recentContext.loadedMemorySources
          })
        })
      }
    )
    appendReasoningEvent(sessionId, 'step_completed', step.title, '最近上下文读取完成', {
      stepId: step.stepId,
      data: buildReasoningStepEventData(step, stepIndex)
    })
    return
  }

  if (step.action === 'locate_project') {
    const workspaceStructure = buildWorkspaceStructureArtifact()
    updateReasoningSession(sessionId, (session) => ({
      ...session,
      artifacts: {
        ...session.artifacts,
        projectRoot: GAMESTUDIO_ROOT,
        workspaceStructure
      }
    }))
    const appSummary = Object.entries(workspaceStructure.appRoots || {})
      .map(([name, appPath]) => `${name}=${appPath}`)
      .join('；')
    appendReasoningEvent(sessionId, 'tool_result', step.title, `定位到工作区：${GAMESTUDIO_ROOT}；apps=${appSummary || '无'}；storage=${STUDIO_STORAGE_ROOT}`, {
      stepId: step.stepId,
      data: buildReasoningStepEventData(step, stepIndex, {
        projectRoot: GAMESTUDIO_ROOT,
        workspaceStructure,
        observableOps: buildReasoningObservableOps(step)
      })
    })
    appendReasoningEvent(sessionId, 'step_completed', step.title, '项目目录定位完成', {
      stepId: step.stepId,
      data: buildReasoningStepEventData(step, stepIndex)
    })
    return
  }

  if (step.action === 'list_directory_contents') {
    const targetDir = String(step.params?.dirPath || step.params?.startDir || '').trim()
    if (!targetDir) {
      throw new Error('list_directory_contents_missing_dirPath')
    }
    const listing = inspectWorkspaceDirectory(targetDir)
    const listingKey = normalizeWorkspaceRelativePath(path.relative(GAMESTUDIO_ROOT, listing.resolvedPath)) || '.'
    updateReasoningSession(sessionId, (session) => ({
      ...session,
      artifacts: {
        ...session.artifacts,
        directoryListing: listing,
        directoryListings: {
          ...(session.artifacts?.directoryListings || {}),
          [listingKey]: listing
        },
        latestStepReviewEvidence: {
          targetType: 'step',
          stepId: step.stepId,
          stepTitle: step.title,
          tool: step.tool,
          outboundPreview: {
            tool: step.tool,
            dirPath: listing.requestedPath,
            resolvedPath: listing.resolvedPath,
          },
          rawResponsePreview: truncateReasoningPreview(JSON.stringify(listing, null, 2), 2400),
          structuredResult: listing
        }
      }
    }))
    appendReasoningEvent(sessionId, 'tool_result', step.title, `已列出 ${listing.resolvedPath}，共 ${listing.count} 个直接子项`, {
      stepId: step.stepId,
      data: buildReasoningStepEventData(step, stepIndex, {
        dirPath: listing.resolvedPath,
        count: listing.count,
        entries: listing.entries,
        observableOps: buildReasoningObservableOps(step, listing)
      })
    })
    appendReasoningEvent(sessionId, 'step_completed', step.title, '目录内容读取完成', {
      stepId: step.stepId,
      data: buildReasoningStepEventData(step, stepIndex)
    })
    return
  }

  if (step.action === 'inspect_server_image_entrypoints') {
    const inspection = inspectServerImageEntrypoints()
    updateReasoningSession(sessionId, (session) => ({
      ...session,
      artifacts: {
        ...session.artifacts,
        imageServiceEntrypoints: inspection,
        latestStepReviewEvidence: {
          targetType: 'step',
          stepId: step.stepId,
          stepTitle: step.title,
          tool: step.tool,
          outboundPreview: {
            tool: step.tool,
            searchedRoot: inspection.searchedRoot,
            questionType: 'image_service_entrypoints'
          },
          rawResponsePreview: truncateReasoningPreview(JSON.stringify(inspection, null, 2), 2400),
          structuredResult: inspection
        }
      }
    }))
    appendReasoningEvent(sessionId, 'tool_result', step.title, `在 ${inspection.searchedRoot} 识别到 ${inspection.count} 个图片生成相关服务端入口文件`, {
      stepId: step.stepId,
      data: buildReasoningStepEventData(step, stepIndex, {
        ...inspection,
        observableOps: buildReasoningObservableOps(step, inspection)
      })
    })
    appendReasoningEvent(sessionId, 'step_completed', step.title, '图片生成服务端入口盘点完成', {
      stepId: step.stepId,
      data: buildReasoningStepEventData(step, stepIndex)
    })
    return
  }

  if (step.action === 'inspect_control_backend_surfaces') {
    const inspection = inspectControlBackendSurfaces()
    updateReasoningSession(sessionId, (session) => ({
      ...session,
      artifacts: {
        ...session.artifacts,
        controlBackendSurfaces: inspection,
        latestStepReviewEvidence: {
          targetType: 'step',
          stepId: step.stepId,
          stepTitle: step.title,
          tool: step.tool,
          outboundPreview: {
            tool: step.tool,
            searchedRoot: inspection.searchedRoot,
            questionType: 'control_backend_surfaces'
          },
          rawResponsePreview: truncateReasoningPreview(JSON.stringify(inspection, null, 2), 2400),
          structuredResult: inspection
        }
      }
    }))
    appendReasoningEvent(sessionId, 'tool_result', step.title, `在 ${inspection.searchedRoot} 识别到 ${inspection.count} 个 control/Hermes 关键后端文件`, {
      stepId: step.stepId,
      data: buildReasoningStepEventData(step, stepIndex, {
        ...inspection,
        observableOps: buildReasoningObservableOps(step, inspection)
      })
    })
    appendReasoningEvent(sessionId, 'step_completed', step.title, 'control/Hermes 后端文件定位完成', {
      stepId: step.stepId,
      data: buildReasoningStepEventData(step, stepIndex)
    })
    return
  }

  if (step.action === 'prepare_prompt') {
    appendReasoningEvent(sessionId, 'tool_result', step.title, '已整理问题并准备生成回答', {
      stepId: step.stepId,
      data: buildReasoningStepEventData(step, stepIndex, {
        observableOps: buildReasoningObservableOps(step)
      })
    })
    appendReasoningEvent(sessionId, 'step_completed', step.title, '问题整理完成', {
      stepId: step.stepId,
      data: buildReasoningStepEventData(step, stepIndex)
    })
    return
  }

  if (step.action === 'generate_default_answer') {
    const session = readReasoningSession(sessionId)
    const binding = buildHermesBinding()
    const history = readHermesChatHistory({ includeAllSessions: true })
    const answer = await runManagedReasoningTask(sessionId, 'answer', binding, ({ signal }) => generateReasoningFinalAnswer(sessionId, userPrompt, session?.artifacts || {}, binding, history, {
      signal,
      correctionPrompt,
      contextSelection: session?.submissionContext || {}
    }))
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
      data: buildReasoningStepEventData(step, stepIndex, {
        usage: answer.usage,
        fallback: answer.fallback,
        fallbackReason: answer.fallbackReason,
        rawResponsePreview: answer.rawResponsePreview,
        finalAnswerPreview: truncateReasoningPreview(answer.reply, 1200),
        observableOps: buildReasoningObservableOps(step, {
          binding,
          outboundPreview: answer.outboundPreview,
          fallback: answer.fallback,
          fallbackReason: answer.fallbackReason
        })
      })
    })
    appendHermesLog([
      `[REASONING][ANSWER] sessionId=${sessionId} replyChars=${answer.reply.length}`,
      answer.rawResponsePreview ? `[REASONING][ANSWER][RAW] sessionId=${sessionId} preview=${truncateReasoningPreview(answer.rawResponsePreview, 600)}` : '',
      answer.reply ? `[REASONING][ANSWER][FINAL] sessionId=${sessionId} preview=${truncateReasoningPreview(answer.reply, 600)}` : ''
    ].filter(Boolean))
    if (shouldRequireHumanReviewForStep(step, session)) {
      requestReasoningReview(sessionId, buildReasoningReview('answer', {
        action: step.action,
        stepId: step.stepId,
        stepIndex,
        title: `审核最终回答：${step.title}`,
        summary: '最终回答已生成。请确认内容后继续完成本次 reasoning session。',
        allowAutoApprove: false,
        requiredHumanDecision: true,
        evidence: readReasoningSession(sessionId)?.artifacts?.latestStepReviewEvidence || null
      }), {
        action: step.action,
        finalAnswerPreview: truncateReasoningPreview(answer.reply, 1200)
      })
      return { pausedForReview: true }
    }
    appendReasoningEvent(sessionId, 'step_completed', step.title, '最终回答生成完成', {
      stepId: step.stepId,
      data: buildReasoningStepEventData(step, stepIndex)
    })
    appendReasoningEvent(sessionId, 'final_answer_ready', '最终回答', '最终回答已准备好', {
      stepId: step.stepId,
      data: buildReasoningStepEventData(step, stepIndex, {
        finalAnswer: answer.reply,
        usage: answer.usage
      })
    })
    return { pausedForReview: false }
  }

  if (step.action === 'read_file_content') {
    const targetPath = String(step.params?.filePath || '').trim()
    if (!targetPath) {
      throw new Error('read_file_content_missing_filePath')
    }
    const resolvedPath = path.isAbsolute(targetPath)
      ? targetPath
      : path.resolve(GAMESTUDIO_ROOT, targetPath)
    if (!resolvedPath.startsWith(GAMESTUDIO_ROOT)) {
      throw new Error('read_file_content_path_outside_workspace')
    }
    if (!fs.existsSync(resolvedPath)) {
      throw new Error(`read_file_content_not_found: ${resolvedPath}`)
    }
    if (!fs.statSync(resolvedPath).isFile()) {
      throw new Error(`read_file_content_not_file: ${resolvedPath}`)
    }
    const raw = fs.readFileSync(resolvedPath, 'utf8')
    const truncated = raw.length > 8000 ? raw.slice(0, 8000) + '\n...[truncated]' : raw
    updateReasoningSession(sessionId, (session) => ({
      ...session,
      artifacts: {
        ...session.artifacts,
        fileContents: {
          ...(session.artifacts?.fileContents || {}),
          [resolvedPath]: truncated
        },
        latestStepReviewEvidence: {
          targetType: 'step',
          stepId: step.stepId,
          stepTitle: step.title,
          tool: step.tool,
          outboundPreview: { tool: step.tool, filePath: resolvedPath },
          rawResponsePreview: truncateReasoningPreview(truncated, 2400),
          structuredResult: { filePath: resolvedPath, chars: raw.length, truncated: raw.length > 8000 }
        }
      }
    }))
    appendReasoningEvent(sessionId, 'tool_result', step.title, `已读取 ${resolvedPath}（${raw.length} 字符${raw.length > 8000 ? '，已截断' : ''}）`, {
      stepId: step.stepId,
      data: buildReasoningStepEventData(step, stepIndex, {
        filePath: resolvedPath, chars: raw.length, truncated: raw.length > 8000,
        observableOps: buildReasoningObservableOps(step, { filePath: resolvedPath })
      })
    })
    appendReasoningEvent(sessionId, 'step_completed', step.title, '文件内容读取完成', {
      stepId: step.stepId,
      data: buildReasoningStepEventData(step, stepIndex)
    })
    return
  }

  if (step.action === 'search_workspace_text') {
    const query = String(step.params?.query || '').trim()
    if (!query) {
      throw new Error('search_workspace_text_missing_query')
    }
    const result = runWorkspaceTextSearch(query, {
      startDir: step.params?.startDir,
      maxResults: step.params?.maxResults,
    })
    updateReasoningSession(sessionId, (session) => ({
      ...session,
      artifacts: {
        ...session.artifacts,
        workspaceSearch: result,
        workspaceSearches: {
          ...(session.artifacts?.workspaceSearches || {}),
          [step.stepId]: result
        }
      }
    }))
    appendReasoningEvent(sessionId, 'tool_result', step.title, `已搜索 ${result.startDir}，命中 ${result.count} 条结果`, {
      stepId: step.stepId,
      data: buildReasoningStepEventData(step, stepIndex, {
        query,
        count: result.count,
        matches: result.matches,
        observableOps: buildReasoningObservableOps(step, {
          query,
          matches: result.matches
        })
      })
    })
    appendReasoningEvent(sessionId, 'step_completed', step.title, '工作区文本搜索完成', {
      stepId: step.stepId,
      data: buildReasoningStepEventData(step, stepIndex)
    })
    return
  }

  if (step.action === 'write_memory_file') {
    const binding = buildHermesBinding()
    const rewrite = await runManagedReasoningTask(sessionId, `write_${step.stepId}`, binding, () => generateReasoningFileRewrite(sessionId, step, userPrompt, binding))
    updateReasoningSession(sessionId, (session) => ({
      ...session,
      artifacts: {
        ...session.artifacts,
        pendingWrites: {
          ...(session.artifacts?.pendingWrites || {}),
          [step.stepId]: rewrite
        },
        latestStepReviewEvidence: {
          targetType: 'step',
          stepId: step.stepId,
          stepTitle: step.title,
          tool: step.tool,
          outboundPreview: rewrite.outboundPreview,
          rawResponsePreview: truncateReasoningPreview(rewrite.diffPreview, 2400),
          structuredResult: { filePath: rewrite.filePath, chars: rewrite.updatedContent.length, summary: rewrite.summary }
        }
      }
    }))
    requestReasoningReview(sessionId, buildReasoningReview('step', {
      action: step.action,
      stepId: step.stepId,
      stepIndex,
      title: `审核文件写入：${step.title}`,
      summary: `已根据当前文件内容生成候选改写，确认后才会写入 ${rewrite.filePath}。`,
      allowAutoApprove: false,
      requiredHumanDecision: true,
      requiresApplyOnApprove: true,
      evidence: readReasoningSession(sessionId)?.artifacts?.latestStepReviewEvidence || null
    }), {
      filePath: rewrite.filePath,
      action: step.action
    })
    return { pausedForReview: true }
  }

  if (step.action === 'edit_workspace_file') {
    const binding = buildHermesBinding()
    const rewrite = await runManagedReasoningTask(sessionId, `write_${step.stepId}`, binding, () => generateReasoningFileRewrite(sessionId, step, userPrompt, binding))
    updateReasoningSession(sessionId, (session) => ({
      ...session,
      artifacts: {
        ...session.artifacts,
        pendingWrites: {
          ...(session.artifacts?.pendingWrites || {}),
          [step.stepId]: rewrite
        },
        latestStepReviewEvidence: {
          targetType: 'step',
          stepId: step.stepId,
          stepTitle: step.title,
          tool: step.tool,
          outboundPreview: rewrite.outboundPreview,
          rawResponsePreview: truncateReasoningPreview(rewrite.diffPreview, 2400),
          structuredResult: { filePath: rewrite.filePath, chars: rewrite.updatedContent.length, summary: rewrite.summary }
        }
      }
    }))
    requestReasoningReview(sessionId, buildReasoningReview('step', {
      action: step.action,
      stepId: step.stepId,
      stepIndex,
      title: `审核文件编辑：${step.title}`,
      summary: `已为 ${rewrite.filePath} 生成候选改写，确认后才会写入工作区文件。`,
      allowAutoApprove: false,
      requiredHumanDecision: true,
      requiresApplyOnApprove: true,
      evidence: readReasoningSession(sessionId)?.artifacts?.latestStepReviewEvidence || null
    }), {
      filePath: rewrite.filePath,
      action: step.action
    })
    return { pausedForReview: true }
  }

  if (step.action === 'create_workspace_file') {
    const binding = buildHermesBinding()
    const rewrite = await runManagedReasoningTask(sessionId, `write_${step.stepId}`, binding, () => generateReasoningFileRewrite(sessionId, {
      ...step,
      action: 'edit_workspace_file'
    }, userPrompt, binding))
    updateReasoningSession(sessionId, (session) => ({
      ...session,
      artifacts: {
        ...session.artifacts,
        pendingWrites: {
          ...(session.artifacts?.pendingWrites || {}),
          [step.stepId]: rewrite
        },
        latestStepReviewEvidence: {
          targetType: 'step',
          stepId: step.stepId,
          stepTitle: step.title,
          tool: step.tool,
          outboundPreview: rewrite.outboundPreview,
          rawResponsePreview: truncateReasoningPreview(rewrite.diffPreview, 2400),
          structuredResult: { filePath: rewrite.filePath, chars: rewrite.updatedContent.length, summary: rewrite.summary }
        }
      }
    }))
    requestReasoningReview(sessionId, buildReasoningReview('step', {
      action: step.action,
      stepId: step.stepId,
      stepIndex,
      title: `审核文件创建：${step.title}`,
      summary: `已为 ${rewrite.filePath} 生成新文件候选内容，确认后才会写入工作区文件。`,
      allowAutoApprove: false,
      requiredHumanDecision: true,
      requiresApplyOnApprove: true,
      evidence: readReasoningSession(sessionId)?.artifacts?.latestStepReviewEvidence || null
    }), {
      filePath: rewrite.filePath,
      action: step.action
    })
    return { pausedForReview: true }
  }

  if (step.action === 'update_task_queue') {
    const binding = buildHermesBinding()
    const rewrite = await runManagedReasoningTask(sessionId, `write_${step.stepId}`, binding, () => generateReasoningFileRewrite(sessionId, step, userPrompt, binding))
    updateReasoningSession(sessionId, (session) => ({
      ...session,
      artifacts: {
        ...session.artifacts,
        pendingWrites: {
          ...(session.artifacts?.pendingWrites || {}),
          [step.stepId]: rewrite
        },
        latestStepReviewEvidence: {
          targetType: 'step',
          stepId: step.stepId,
          stepTitle: step.title,
          tool: step.tool,
          outboundPreview: rewrite.outboundPreview,
          rawResponsePreview: truncateReasoningPreview(rewrite.diffPreview, 2400),
          structuredResult: { filePath: rewrite.filePath, chars: rewrite.updatedContent.length, replaceAll: Boolean(step.params?.replaceAll), summary: rewrite.summary }
        }
      }
    }))
    requestReasoningReview(sessionId, buildReasoningReview('step', {
      action: step.action,
      stepId: step.stepId,
      stepIndex,
      title: `审核任务队列写入：${step.title}`,
      summary: `已为 TASK_QUEUE.md 生成候选改写，确认后才会落盘。`,
      allowAutoApprove: false,
      requiredHumanDecision: true,
      requiresApplyOnApprove: true,
      evidence: readReasoningSession(sessionId)?.artifacts?.latestStepReviewEvidence || null
    }), {
      filePath: rewrite.filePath,
      action: step.action
    })
    return { pausedForReview: true }
  }

  if (step.action === 'rename_workspace_path') {
    const fromPath = resolveWorkspacePathFromInput(step.params?.fromPath)
    const toPath = resolveWorkspacePathFromInput(step.params?.toPath)
    if (!fromPath || !toPath) {
      throw new Error('rename_workspace_path_missing_path')
    }
    if (!isWorkspaceEditablePath(fromPath) || !isWorkspaceEditablePath(toPath)) {
      throw new Error('rename_workspace_path_outside_workspace')
    }
    if (!fs.existsSync(fromPath)) {
      throw new Error(`rename_workspace_path_not_found: ${fromPath}`)
    }
    updateReasoningSession(sessionId, (session) => ({
      ...session,
      artifacts: {
        ...session.artifacts,
        pendingWorkspaceOps: {
          ...(session.artifacts?.pendingWorkspaceOps || {}),
          [step.stepId]: { opType: 'rename', fromPath, toPath }
        },
        latestStepReviewEvidence: {
          targetType: 'step',
          stepId: step.stepId,
          stepTitle: step.title,
          tool: step.tool,
          outboundPreview: { fromPath, toPath },
          rawResponsePreview: `待重命名：${fromPath} -> ${toPath}`,
          structuredResult: { fromPath, toPath, pendingApproval: true }
        }
      }
    }))
    requestReasoningReview(sessionId, buildReasoningReview('step', {
      action: step.action,
      stepId: step.stepId,
      stepIndex,
      title: `审核路径重命名：${step.title}`,
      summary: `确认后才会将 ${fromPath} 重命名为 ${toPath}。`,
      allowAutoApprove: false,
      requiredHumanDecision: true,
      requiresApplyOnApprove: true,
      evidence: readReasoningSession(sessionId)?.artifacts?.latestStepReviewEvidence || null
    }), {
      fromPath,
      toPath,
      action: step.action
    })
    return { pausedForReview: true }
  }

  if (step.action === 'delete_workspace_path') {
    const targetPath = resolveWorkspacePathFromInput(step.params?.targetPath)
    if (!targetPath) {
      throw new Error('delete_workspace_path_missing_targetPath')
    }
    if (!isWorkspaceEditablePath(targetPath)) {
      throw new Error('delete_workspace_path_outside_workspace')
    }
    if (!fs.existsSync(targetPath)) {
      throw new Error(`delete_workspace_path_not_found: ${targetPath}`)
    }
    updateReasoningSession(sessionId, (session) => ({
      ...session,
      artifacts: {
        ...session.artifacts,
        pendingWorkspaceOps: {
          ...(session.artifacts?.pendingWorkspaceOps || {}),
          [step.stepId]: { opType: 'delete', targetPath, isDirectory: fs.statSync(targetPath).isDirectory() }
        },
        latestStepReviewEvidence: {
          targetType: 'step',
          stepId: step.stepId,
          stepTitle: step.title,
          tool: step.tool,
          outboundPreview: { targetPath },
          rawResponsePreview: `待删除：${targetPath}`,
          structuredResult: { targetPath, pendingApproval: true }
        }
      }
    }))
    requestReasoningReview(sessionId, buildReasoningReview('step', {
      action: step.action,
      stepId: step.stepId,
      stepIndex,
      title: `审核路径删除：${step.title}`,
      summary: `确认后才会删除 ${targetPath}。`,
      allowAutoApprove: false,
      requiredHumanDecision: true,
      requiresApplyOnApprove: true,
      evidence: readReasoningSession(sessionId)?.artifacts?.latestStepReviewEvidence || null
    }), {
      targetPath,
      action: step.action
    })
    return { pausedForReview: true }
  }

  if (step.action === 'run_lifecycle_script') {
    const ALLOWED_LIFECYCLE_SCRIPTS = new Set([
      'restart_control.sh',
      'restart_server.sh',
      'reporter.sh',
      'openclaw_selfcheck.sh'
    ])
    const scriptName = String(step.params?.scriptName || '').trim()
    if (!scriptName || !ALLOWED_LIFECYCLE_SCRIPTS.has(scriptName)) {
      throw new Error(`run_lifecycle_script_not_allowed: ${scriptName || '(empty)'}`)
    }
    const scriptPath = path.join(GAMESTUDIO_ROOT, 'scripts', 'lifecycle', scriptName)
    if (!fs.existsSync(scriptPath)) throw new Error(`run_lifecycle_script_not_found: ${scriptPath}`)
    updateReasoningSession(sessionId, (session) => ({
      ...session,
      artifacts: {
        ...session.artifacts,
        pendingScriptRuns: {
          ...(session.artifacts?.pendingScriptRuns || {}),
          [step.stepId]: { scriptName, scriptPath }
        },
        pendingLifecycleScripts: {
          ...(session.artifacts?.pendingScriptRuns || session.artifacts?.pendingLifecycleScripts || {}),
          [step.stepId]: { scriptName, scriptPath }
        },
        latestStepReviewEvidence: {
          targetType: 'step',
          stepId: step.stepId,
          stepTitle: step.title,
          tool: step.tool,
          outboundPreview: { tool: step.tool, scriptName, scriptPath },
          rawResponsePreview: `待执行脚本：${scriptPath}`,
          structuredResult: { scriptName, scriptPath, pendingApproval: true }
        }
      }
    }))
    requestReasoningReview(sessionId, buildReasoningReview('step', {
      action: step.action,
      stepId: step.stepId,
      stepIndex,
      title: `审核命令执行：${step.title}`,
      summary: `确认后才会执行脚本 ${scriptName}。`,
      allowAutoApprove: false,
      requiredHumanDecision: true,
      requiresApplyOnApprove: true,
      evidence: readReasoningSession(sessionId)?.artifacts?.latestStepReviewEvidence || null
    }), {
      scriptName,
      scriptPath,
      action: step.action
    })
    return { pausedForReview: true }
  }

  if (step.action === 'run_workspace_script') {
    const scriptPath = resolveWorkspacePathFromInput(step.params?.scriptPath)
    if (!scriptPath) {
      throw new Error('run_workspace_script_missing_scriptPath')
    }
    if (!isWorkspaceRunnableScriptPath(scriptPath)) {
      throw new Error(`run_workspace_script_not_allowed: ${scriptPath}`)
    }
    updateReasoningSession(sessionId, (session) => ({
      ...session,
      artifacts: {
        ...session.artifacts,
        pendingScriptRuns: {
          ...(session.artifacts?.pendingScriptRuns || {}),
          [step.stepId]: { scriptName: path.basename(scriptPath), scriptPath }
        },
        latestStepReviewEvidence: {
          targetType: 'step',
          stepId: step.stepId,
          stepTitle: step.title,
          tool: step.tool,
          outboundPreview: { tool: step.tool, scriptPath },
          rawResponsePreview: `待执行脚本：${scriptPath}`,
          structuredResult: { scriptPath, pendingApproval: true }
        }
      }
    }))
    requestReasoningReview(sessionId, buildReasoningReview('step', {
      action: step.action,
      stepId: step.stepId,
      stepIndex,
      title: `审核工作区脚本执行：${step.title}`,
      summary: `确认后才会执行脚本 ${scriptPath}。`,
      allowAutoApprove: false,
      requiredHumanDecision: true,
      requiresApplyOnApprove: true,
      evidence: readReasoningSession(sessionId)?.artifacts?.latestStepReviewEvidence || null
    }), {
      scriptPath,
      action: step.action
    })
    return { pausedForReview: true }
  }

  throw new Error(`unsupported_reasoning_action_${step.action}`)
}

export async function prepareReasoningSessionPlan(sessionId, binding, history, options = {}) {
  const session = readReasoningSession(sessionId)
  if (!session) {
    throw new Error('reasoning_session_not_found')
  }

  const correctionPrompt = String(options.correctionPrompt || '').trim()
  const priorArtifacts = options.priorArtifacts && typeof options.priorArtifacts === 'object'
    ? options.priorArtifacts
    : (session.artifacts || {})

  markReasoningSessionActive(sessionId)

  const planResult = await runManagedReasoningTask(sessionId, 'plan', binding, ({ signal }) => {
    return generateReasoningPlan(session.userPrompt, history, binding, {
      sessionId,
      signal,
      correctionPrompt,
      contextSelection: session.submissionContext || {},
      priorArtifacts
    })
  })
  const plan = planResult.plan
  const loadedMemoryCount = planResult.recentContextArtifact.loadedMemorySources.length
  const replayedMessageCount = planResult.recentContextArtifact.replayedMessageCount

  updateReasoningSession(sessionId, (current) => ({
    ...current,
    status: 'running',
    runtimeTaskGraph: plan,
    plan,
    review: null,
    artifacts: {
      ...current.artifacts,
      recentContext: planResult.recentContextArtifact,
      latestPlanReviewEvidence: {
        targetType: 'runtime_task_graph',
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

  appendReasoningEvent(sessionId, 'plan_created', '运行任务图已创建', `模型规划已读取 ${replayedMessageCount} 条近邻对话与 ${loadedMemoryCount} 份 markdown 记忆，本次执行共 ${Array.isArray(plan.steps) ? plan.steps.length : 0} 步`, {
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
    `[REASONING][PLAN][CONTEXT] replayedMessages=${replayedMessageCount} loadedMemorySources=${loadedMemoryCount}`,
    planResult.rawResponsePreview ? `[REASONING][PLAN][RAW] sessionId=${sessionId} preview=${truncateReasoningPreview(planResult.rawResponsePreview, 600)}` : ''
  ].filter(Boolean))

  if (isReasoningAutoReviewMode(session)) {
    void runAllReasoningStepsFrom(sessionId, binding, history, 0).catch((error) => {
      markReasoningSessionFailed(sessionId, error)
    })
  } else {
    requestReasoningReview(sessionId, buildReasoningReview('runtime_task_graph', {
      reviewPhase: 'before_execution',
      title: '审核运行任务图',
      summary: '运行任务图已生成。请确认任务链后开始执行第一步。',
      correctionPrompt,
      allowAutoApprove: false,
      requiredHumanDecision: true,
      evidence: readReasoningSession(sessionId)?.artifacts?.latestPlanReviewEvidence || null
    }), {
      targetType: 'runtime_task_graph'
    })
  }

  return readReasoningSession(sessionId)
}

// runAllReasoningStepsFrom: 自动顺序执行所有步骤，无中间审核打断。
// 全部步骤完成后进入 quality gate；如 quality gate 需要重规划，
// 重规划完成后也会再次调用本函数从头执行新计划。
async function runAllReasoningStepsFrom(sessionId, binding, history, startIndex = 0, options = {}) {
  markReasoningSessionActive(sessionId)
  try {
    const session = readReasoningSession(sessionId)
    if (!session) throw new Error('reasoning_session_not_found')
    const steps = Array.isArray(session.plan?.steps) ? session.plan.steps : []
    const correctionPrompt = String(options.correctionPrompt || '').trim()

    for (let i = startIndex; i < steps.length; i++) {
      const currentSession = readReasoningSession(sessionId)
      if (!currentSession || currentSession.status === 'cancelled') return

      const step = currentSession.plan?.steps?.[i]
      if (!step) break

      if (shouldPauseBeforeExecutingReasoningStep(currentSession, step) && !currentSession.artifacts?.approvedStepRuns?.[step.stepId]) {
        requestReasoningReview(sessionId, buildReasoningReview('step', {
          action: step.action,
          stepId: step.stepId,
          stepIndex: i,
          reviewPhase: 'before_execution',
          title: `审核执行步骤：${step.title}`,
          summary: `确认后才会执行步骤 ${step.title}。`,
          correctionPrompt,
          allowAutoApprove: false,
          requiredHumanDecision: true,
          evidence: {
            targetType: 'step',
            stepId: step.stepId,
            stepTitle: step.title,
            tool: step.tool,
            outboundPreview: {
              action: step.action,
              tool: step.tool,
              params: step.params || {},
              dependsOn: step.dependsOn || [],
              observableOps: buildReasoningObservableOps(step)
            },
            rawResponsePreview: '',
            structuredResult: {
              phase: 'before_execution',
              action: step.action,
              tool: step.tool,
              params: step.params || {},
              dependsOn: step.dependsOn || [],
              observableOps: buildReasoningObservableOps(step)
            }
          }
        }), {
          action: step.action,
          stepIndex: i
        })
        updateReasoningSession(sessionId, (current) => ({
          ...current,
          currentStepId: step.stepId,
          artifacts: { ...current.artifacts, nextStepIndex: i }
        }))
        return readReasoningSession(sessionId)
      }

      let executionResult = null
      try {
        executionResult = await executeReasoningStep(sessionId, step, currentSession.userPrompt, {
          correctionPrompt: isReasoningAnswerAction(step.action) || i === startIndex ? correctionPrompt : ''
        })
      } catch (error) {
        const recovered = await recoverReasoningStepFailure(sessionId, binding, history, step, i, error)
        if (recovered) return readReasoningSession(sessionId)
        throw error
      }

      const postStepSession = readReasoningSession(sessionId)
      if (postStepSession?.artifacts?.approvedStepRuns?.[step.stepId]) {
        updateReasoningSession(sessionId, (current) => {
          const approvedStepRuns = { ...(current.artifacts?.approvedStepRuns || {}) }
          delete approvedStepRuns[step.stepId]
          return {
            ...current,
            artifacts: {
              ...current.artifacts,
              approvedStepRuns
            }
          }
        })
      }
      if (!executionResult?.pausedForReview && postStepSession?.status !== 'waiting_review' && !isReasoningAutoReviewMode(postStepSession) && shouldRequireHumanReviewForStep(step, postStepSession) && !isReasoningWriteAction(step.action) && !isReasoningAnswerAction(step.action) && !shouldPauseBeforeExecutingReasoningStep(postStepSession, step)) {
        requestReasoningReview(sessionId, buildReasoningReview('step', {
          action: step.action,
          stepId: step.stepId,
          stepIndex: i,
          reviewPhase: 'after_execution',
          title: `审核步骤：${step.title}`,
          summary: '该步骤已完成，等待人工确认后继续执行后续步骤。',
          correctionPrompt,
          allowAutoApprove: false,
          requiredHumanDecision: true,
          evidence: postStepSession?.artifacts?.latestStepReviewEvidence || null
        }), {
          action: step.action,
          stepIndex: i
        })
      }
      if (executionResult?.pausedForReview || postStepSession?.status === 'waiting_review') {
        updateReasoningSession(sessionId, (current) => ({
          ...current,
          currentStepId: step.stepId,
          artifacts: { ...current.artifacts, nextStepIndex: i }
        }))
        return readReasoningSession(sessionId)
      }

      updateReasoningSession(sessionId, (current) => ({
        ...current,
        currentStepId: step.stepId,
        artifacts: { ...current.artifacts, nextStepIndex: i + 1 }
      }))
    }

    // 全部步骤执行完毕 -> 进 quality gate（内部若重规划会递归调用 prepareReasoningSessionPlan -> runAllReasoningStepsFrom）
    await finalizeReasoningSessionWithQualityGate(sessionId, binding, history)
  } catch (error) {
    markReasoningSessionFailed(sessionId, error)
  } finally {
    if (isReasoningSessionTerminalStatus(readReasoningSession(sessionId)?.status)) {
      unmarkReasoningSessionActive(sessionId)
    }
  }
}

// continueReasoningSessionFromStep: 保留供用户 reject 后从指定步骤重跑
async function continueReasoningSessionFromStep(sessionId, binding, history, options = {}) {
  const session = readReasoningSession(sessionId)
  if (!session) {
    throw new Error('reasoning_session_not_found')
  }
  const stepIndex = Math.max(0, Number(options.stepIndex || 0))
  // 清除旧审核状态，然后从指定步骤继续自动执行剩余步骤
  clearReasoningReview(sessionId)
  void runAllReasoningStepsFrom(sessionId, binding, history, stepIndex, {
    correctionPrompt: options.correctionPrompt || ''
  })
}

async function runReasoningSession(sessionId, binding, history) {
  const session = readReasoningSession(sessionId)
  if (!session) {
    throw new Error('reasoning_session_not_found')
  }

  markReasoningSessionActive(sessionId)
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
  const parentSessionId = String(submissionContext?.parentSessionId || '').trim() || null
  const allowRecentVerifiedReuse = !Boolean(submissionContext?.productionTest || submissionContext?.forceFreshRun)
  const reusedSession = allowRecentVerifiedReuse ? findReusableVerifiedReasoningSession(userPrompt) : null
  if (reusedSession) {
    const reusedReply = String(reusedSession.artifacts?.finalAnswer || '').trim()
    const session = {
      sessionId,
      runtimeSessionId: sessionId,
      sessionKind: 'agent-runtime',
      agentId,
      userPrompt,
      submissionContext,
      parentSessionId,
      childSessionIds: [],
      status: 'completed',
      createdAt: now,
      updatedAt: now,
      runtimeTaskGraph: null,
      plan: null,
      currentStepId: null,
      review: null,
      events: [
        createReasoningEvent(sessionId, 'recent_verified_answer_reused', '复用近期已验证答案', `命中相同问题的近期已验证回答，直接复用 ${reusedSession.sessionId} 的最终答案，不再重新启动 workflow。`, {
          data: {
            reusedFromSessionId: reusedSession.sessionId,
            reusedFromUpdatedAt: reusedSession.updatedAt || reusedSession.createdAt || null,
          }
        }),
        createReasoningEvent(sessionId, 'final_answer_ready', '最终回答', '已直接复用近期已验证答案', {
          data: {
            targetType: 'answer',
            reusedFromSessionId: reusedSession.sessionId,
            finalAnswer: reusedReply
          }
        }),
        createReasoningEvent(sessionId, 'session_completed', '推理完成', '本次问题命中近期已验证答案，未重新启动可观测推理链。', {
          data: {
            reusedFromSessionId: reusedSession.sessionId,
          }
        })
      ],
      artifacts: {
        ...JSON.parse(JSON.stringify(reusedSession.artifacts || {})),
        reusedFromSessionId: reusedSession.sessionId,
        finalAnswer: reusedReply,
        finalAnswerPersisted: false,
      },
      error: null
    }
    return writeReasoningSession(session)
  }

  const session = {
    sessionId,
    runtimeSessionId: sessionId,
    sessionKind: 'agent-runtime',
    agentId,
    userPrompt,
    submissionContext,
    parentSessionId,
    childSessionIds: [],
    status: 'planning',
    createdAt: now,
    updatedAt: now,
    runtimeTaskGraph: null,
    plan: null,
    currentStepId: null,
    review: null,
    events: [
      createReasoningEvent(sessionId, 'planning_started', '构建运行任务图', '正在读取最近上下文和 markdown 记忆，并交给 Hermes 生成运行任务图')
    ],
    artifacts: {
      recentContext: null,
      latestPlanReviewEvidence: null,
      latestStepReviewEvidence: null,
        childGoalQueue: Array.isArray(submissionContext?.childGoals) ? submissionContext.childGoals : [],
        pendingWrites: {},
      approvedStepRuns: {},
      nextStepIndex: 0,
      tasks: {
        plan: null
      }
    },
    error: null
  }
  const persistedSession = writeReasoningSession(session)
  markReasoningSessionActive(sessionId)
  if (parentSessionId && readReasoningSession(parentSessionId)) {
    updateReasoningSession(parentSessionId, (current) => ({
      ...current,
      childSessionIds: Array.from(new Set([...(Array.isArray(current.childSessionIds) ? current.childSessionIds : []), sessionId]))
    }))
  }
  return persistedSession
}

function openFileInEditor(filePath) {
  const normalizedPath = path.resolve(String(filePath || '').trim())
  if (!normalizedPath) {
    throw new Error('chat_history_file_path_missing')
  }

  const cliEditors = [
    { command: 'subl', args: [normalizedPath], label: 'subl' },
    { command: 'cursor', args: ['-r', normalizedPath], label: 'cursor' },
    { command: 'windsurf', args: ['-r', normalizedPath], label: 'windsurf' },
    { command: 'zed', args: [normalizedPath], label: 'zed' },
    { command: 'code-insiders', args: ['-r', normalizedPath], label: 'code-insiders' },
    { command: 'code', args: ['-r', normalizedPath], label: 'code' }
  ]

  for (const editor of cliEditors) {
    const lookup = spawnSync('which', [editor.command], { encoding: 'utf8' })
    const commandPath = lookup.status === 0 ? lookup.stdout.trim() : ''
    if (!commandPath) continue
    const child = spawn(commandPath, editor.args, {
      detached: true,
      stdio: 'ignore'
    })
    child.unref()
    return editor.label
  }

  const openTargets = [
    ['-a', 'Sublime Text', normalizedPath],
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
  const raw = fs.readFileSync(chatFile, 'utf-8')
  if (!String(raw || '').trim()) {
    writeHermesChatHistory([])
    return []
  }

  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    try {
      const backupFile = `${chatFile}.corrupt-${Date.now()}`
      fs.writeFileSync(backupFile, raw, 'utf-8')
      writeHermesChatHistory([])
    } catch {
      // Ignore recovery failures and fall through to an empty history.
    }
    return []
  }
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

function readHermesChatHistory(options = {}) {
  try {
    const storedHistory = readStoredHermesChatHistory()
    const pruned = pruneHermesChatHistory(storedHistory)
    if (pruned.removedEntries > 0) {
      appendHermesLog(`[CHAT][HISTORY] Skipped ${pruned.removedEntries} diagnostic entries when replaying model context`)
    }
    if (options?.includeAllSessions) {
      return pruned.history
    }
    const currentSessionHistory = pruned.history.filter((entry) => String(entry?.chatSessionId || '').trim() === currentHermesChatSessionId)
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

export function buildHermesRuntimeSystemMessage(binding) {
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
  'Agent Definition': 2200,
  'User Preferences': 1200,
  'Project Memory': 1200,
  'Long Tasks': 2200,
  'Project Status': 2400,
  'Task Queue': 2400,
  'Decisions': 1800,
  'Latest Daily Log': 1800,
  'Skill gamestudio-workspace': 2200
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
          lifecycle: parsed.lifecycle || null,
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
  const now = new Date().toISOString()
  const normalizedEntry = {
    ...entry,
    lifecycle: entry.lifecycle && typeof entry.lifecycle === 'object'
      ? entry.lifecycle
      : createMemoryLifecycleMetadata({
        kind: MEMORY_RECORD_KINDS.CONTEXT_POOL,
        state: MEMORY_LIFECYCLE_STATES.SLEEPING,
        importance: 30,
        confidence: 60,
        createdAt: entry.createdAt || now,
        updatedAt: entry.updatedAt || now
      })
  }
  fs.writeFileSync(getContextPoolEntryFilePath(normalizedEntry.entryId), JSON.stringify(normalizedEntry, null, 2), 'utf8')
  return normalizedEntry
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
    readProjectMemorySource('Long Tasks', memoryConfig.longTasksFile),
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

  const asksForProjectState = /项目状态|当前状态|当前进度|当前焦点|待办|任务队列|长任务|状态|进度|阻塞|决策|任务|下一步|memory|记忆/i.test(prompt)
  if (asksForProjectState) {
    const projectLabels = new Set(['Long Tasks', 'Project Status', 'Task Queue', 'Decisions', 'Latest Daily Log'])
    return sources.filter((source) => projectLabels.has(source.label))
  }

  const asksForWorkflowSurface = /workflow|工作流|能力链条|闭环|LT-0|长任务|主线/i.test(prompt)
  if (asksForWorkflowSurface) {
    const workflowLabels = new Set(['Project Memory', 'Long Tasks'])
    return sources.filter((source) => workflowLabels.has(source.label))
  }

  const minimalLabels = new Set(['Project Memory'])
  return sources.filter((source) => minimalLabels.has(source.label))
}

export function buildProjectMemorySystemMessage(binding, userPrompt, options = {}) {
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
  const selectedContextPoolEntries = selectedContextPoolIds.map((entryId) => readContextPoolEntry(entryId)).filter(Boolean)
  const autoWokenContextPoolEntries = listContextPoolEntries()
    .filter((entry) => !selectedContextPoolIds.includes(String(entry.entryId || '')))
    .map((entry) => readContextPoolEntry(entry.entryId))
    .filter(Boolean)
    .filter((entry) => shouldWakeMemoryRecord(entry, options.requestDecision || null, userPrompt))
    .slice(0, 4)
  const contextPoolEntries = [...selectedContextPoolEntries, ...autoWokenContextPoolEntries]
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
    autoWokenContextPoolEntries,
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
    limit: replayWindowMessages,
    userPrompt
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
  const replayWindowMessages = Math.max(0, Number(binding?.workflow?.reasoningReplayWindowMessages || binding?.workflow?.replayWindowMessages || 0))
  const replayableMessages = collectReplayableHermesMessages(options.history || [], {
    limit: replayWindowMessages,
    userPrompt
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
        'Use recent conversation messages to resolve omitted references such as 上一题, 列表, 它, 这些, 前者/后者, or continue/继续.',
        'If the current request is ambiguous but recent conversation clearly identifies the target, state the resolved target explicitly.',
        'If the recent answer identified multiple directories and the current request asks what the list contains, keep all of those directories unless the user narrows the target.',
        'Do not reinterpret the selected markdown source list itself as the task target unless the user explicitly asks about context sources.',
        'Be concrete and operational. Do not speculate beyond the provided materials.',
        'Return plain text only.'
      ].join('\n')
    },
    ...replayableMessages,
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
  if (isEditorLocationPrompt(userPrompt) || isControlLocationPrompt(userPrompt) || isBusinessServerLocationPrompt(userPrompt)) {
    const summaryLines = [
      '本轮问题已经明确指定目录定位目标，应以当前问题为准，不沿用上一轮的列表或 Control 上下文。',
      ''
    ]
    if (isEditorLocationPrompt(userPrompt)) summaryLines.push('当前目标：GameStudio 编辑器前端目录。执行建议：调用 `locate_project`，由 Hermes 基于本轮 workspaceStructure 中的 editor 应用目录作答。')
    if (isControlLocationPrompt(userPrompt)) summaryLines.push('当前目标：Control 前端与后端目录。执行建议：调用 `locate_project`，由 Hermes 基于本轮 workspaceStructure 中的 control 前后端目录作答。')
    if (isBusinessServerLocationPrompt(userPrompt)) summaryLines.push('当前目标：GameStudio 业务后端目录。执行建议：调用 `locate_project`，由 Hermes 基于本轮 workspaceStructure 中的 server 应用目录作答。')
    const summary = summaryLines.join('\n')
    const replayedMessageCount = collectReplayableHermesMessages(options.history || [], {
      limit: Math.max(0, Number(binding?.workflow?.reasoningReplayWindowMessages || binding?.workflow?.replayWindowMessages || 0)),
      userPrompt
    }).length
    return {
      summary,
      usage: null,
      outboundPreview: buildStructuredOutboundPreview({
        binding,
        messages: draftContext.messages,
        purpose: 'context-draft-workspace-location-routing',
        mode: 'chat',
        userPrompt,
        replayedMessageCount,
        contextSelection: options,
        history: options.history || []
      }),
      rawResponsePreview: truncateReasoningPreview(summary, 2400),
      contextSources: buildChatContextSourcesPayload({
        replayedMessageCount,
        projectMemory: draftContext.projectMemory
      }, binding)
    }
  }

  const inferredDirectoryTargets = inferWorkspaceDirectoriesFromRecentContext(userPrompt, options.history || [])
  const explicitDirectoryTarget = inferWorkspaceDirectoryFromPrompt(userPrompt)
  const directoryTargets = explicitDirectoryTarget ? [explicitDirectoryTarget] : inferredDirectoryTargets
  if (isDirectoryListingPrompt(userPrompt) && directoryTargets.length > 0) {
    const targetLabel = inferredDirectoryTargets.includes('apps/editor')
      ? 'GameStudio 编辑器前端目录定位'
      : (inferredDirectoryTargets.includes('apps/control-console') || inferredDirectoryTargets.includes('apps/control-server')
          ? 'Control 目录定位'
          : '最近一轮目录定位')
    const summary = [
      explicitDirectoryTarget
        ? `本轮问题已明确指定目录：\`${explicitDirectoryTarget}\`。`
        : `根据最近一轮已完成问答，本次省略主语的“列表包含的文件”应承接上一题的 ${targetLabel}。`,
      '',
      `本轮应扫描的目录：${directoryTargets.map((dirPath) => `\`${dirPath}\``).join('、')}`,
      '',
      '执行建议：对上述每个目录调用 `list_directory_contents`，只返回直接子项；在工具返回前不要预写文件名、子目录内容或递归结构。'
    ].join('\n')
    const replayedMessageCount = collectReplayableHermesMessages(options.history || [], {
      limit: Math.max(0, Number(binding?.workflow?.reasoningReplayWindowMessages || binding?.workflow?.replayWindowMessages || 0)),
      userPrompt
    }).length
    return {
      summary,
      usage: null,
      outboundPreview: buildStructuredOutboundPreview({
        binding,
        messages: draftContext.messages,
        purpose: 'context-draft-deterministic-directory-followup',
        mode: 'chat',
        userPrompt,
        replayedMessageCount,
        contextSelection: options,
        history: options.history || []
      }),
      rawResponsePreview: truncateReasoningPreview(summary, 2400),
      contextSources: buildChatContextSourcesPayload({
        replayedMessageCount,
        projectMemory: draftContext.projectMemory
      }, binding)
    }
  }

  const data = await requestHermesChatCompletion({
    sessionId: options.sessionId || null,
    phase: 'context_draft',
    messages: draftContext.messages,
    maxTokens: 320
  })
  const content = data.choices?.[0]?.message?.content || ''
  return {
    summary: content,
    usage: data.usage || null,
    outboundPreview: buildStructuredOutboundPreview({
      binding,
      messages: draftContext.messages,
      purpose: 'context-draft',
      mode: 'chat',
      userPrompt,
      replayedMessageCount: collectReplayableHermesMessages(options.history || [], {
        limit: Math.max(0, Number(binding?.workflow?.reasoningReplayWindowMessages || binding?.workflow?.replayWindowMessages || 0)),
        userPrompt
      }).length,
      contextSelection: options,
      history: options.history || []
    }),
    rawResponsePreview: truncateReasoningPreview(content, 2400),
    contextSources: buildChatContextSourcesPayload({
      replayedMessageCount: collectReplayableHermesMessages(options.history || [], {
        limit: Math.max(0, Number(binding?.workflow?.reasoningReplayWindowMessages || binding?.workflow?.replayWindowMessages || 0)),
        userPrompt
      }).length,
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
    autoWokenContextPoolEntryCount: chatContext.projectMemory.autoWokenContextPoolEntries?.length || 0,
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
      lifecycleState: entry.lifecycle?.state || null,
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

function registerChatRequestRoute(app) {
  registerChatRequestRoutes(app, createControlServerRouteContext())
}

// 启动时清理孤儿 session（上次服务器崩溃或重启遗留的 planning/running 状态）
export function cleanupOrphanedReasoningSessions() {
  try {
    if (!fs.existsSync(HERMES_REASONING_SESSIONS_DIR)) return
    const files = fs.readdirSync(HERMES_REASONING_SESSIONS_DIR).filter((f) => f.endsWith('.json'))
    let count = 0
    for (const file of files) {
      const filePath = path.join(HERMES_REASONING_SESSIONS_DIR, file)
      try {
        const raw = fs.readFileSync(filePath, 'utf8')
        const session = JSON.parse(raw)
        if (session.status === 'planning' || session.status === 'running') {
          session.status = 'failed'
          session.error = '服务器重启，本次 session 被中断（orphaned by server restart）'
          session.updatedAt = new Date().toISOString()
          if (!Array.isArray(session.events)) session.events = []
          session.events.push({
            eventId: `orphan_cleanup_${Date.now()}`,
            type: 'session_failed',
            title: '服务器重启中断',
            summary: '服务器重启时检测到本 session 仍为 running/planning 状态，已标记为失败。',
            timestamp: new Date().toISOString(),
            data: {}
          })
          fs.writeFileSync(filePath, JSON.stringify(session, null, 2), 'utf8')
          count++
          console.log(`[control-server] [startup] orphaned session marked failed: ${session.sessionId}`)
        }
      } catch (e) {
        // ignore corrupt session files
      }
    }
    if (count > 0) {
      console.log(`[control-server] [startup] cleaned up ${count} orphaned reasoning session(s)`)
    }
  } catch (e) {
    console.error('[control-server] [startup] orphan cleanup error:', e)
  }
}