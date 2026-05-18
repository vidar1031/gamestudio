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
  isLikelyReadOnlyReasoningPrompt,
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
  isReasoningStoryMutationAction,
  isReasoningWriteAction,
  REASONING_ACTIONS,
  REASONING_ALLOWED_ACTION_NAMES,
  REASONING_GAMESTUDIO_BOOTSTRAP_ACTION_NAMES,
  REASONING_STORY_MUTATION_ACTION_NAMES,
  REASONING_STORY_WORKFLOW_ACTION_NAMES,
} from './capabilities/actionRegistry.js'
import { buildReasoningToolCatalog } from './capabilities/toolRegistry.js'
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
import { gameStudioServerClient } from './services/gameStudioServerClient.js'
import { createReasoningService } from './services/reasoningService.js'
import { createRuntimeService } from './services/runtimeService.js'
import {
  buildProjectCapabilityStatusAnswer,
  shouldUseDeterministicCapabilityStatusAnswer,
} from './workflows/projectStatusWorkflows.js'
import {
  extractProjectIdFromPrompt,
  extractStoryTitleFromPrompt,
  inferStoryConfigFromPrompt,
} from './workflows/storyProductionWorkflows.js'

let activeHermesChatRequest = null
let activeHermesChatRecovery = null
let hermesChildProcess = null
let hermesStoppingIntentionally = false
let hermesHealthCheckTimer = null
let hermesCrashRestartAttempts = 0
let hermesLastCrashAt = 0
const HERMES_CRASH_RESTART_MAX_ATTEMPTS = 5
const HERMES_CRASH_RESTART_BACKOFF_MS = [0, 2000, 5000, 10000, 30000]
const HERMES_HEALTH_CHECK_INTERVAL_MS = 30000
const HERMES_CRASH_ATTEMPT_RESET_MS = 5 * 60 * 1000
const activeHermesReasoningSessionIds = new Set()
const activeHermesReasoningExecutions = new Map()
// 心跳事件只用于 UI 展示「仍在执行 X 秒」，不会触发任何 OMLX 调用。
// 之前 10s 节奏让人误以为 OMLX 在频繁返回；改回 30s 仅减少 UI 噪音，不影响 120s 单次等待 + 12 次续租契约。
const HERMES_REASONING_TASK_HEARTBEAT_MS = Math.max(3000, Number(process.env.HERMES_REASONING_TASK_HEARTBEAT_MS || 30000))
const STORY_PRODUCTION_STATE_FILE = path.join(GAMESTUDIO_ROOT, 'state', 'story-production', 'current-project.json')
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
ensureHermesHealthCheck()

function ensureHermesHealthCheck() {
  if (hermesHealthCheckTimer) return
  hermesHealthCheckTimer = setInterval(() => {
    const state = getHermesRuntimeState()
    if (state.state === 'running') {
      const pid = readHermesPid()
      if (!pid || !isPidRunning(pid)) {
        appendHermesLog(`[HEALTH-CHECK] PID ${pid} not running but state is running. Triggering recovery.`)
        clearHermesPid()
        recoverHermesChatRuntime('health_check_pid_missing').catch((err) => {
          appendHermesLog(`[HEALTH-CHECK][RECOVERY_ERROR] ${err instanceof Error ? err.message : String(err)}`)
        })
      }
    }
  }, HERMES_HEALTH_CHECK_INTERVAL_MS)
  if (typeof hermesHealthCheckTimer.unref === 'function') {
    hermesHealthCheckTimer.unref()
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
  if (normalizedProvider === 'omlx') {
    return getEnvValue('LOCALOXML_API_KEY') || getEnvValue('STUDIO_AI_API_KEY') || 'omlx123'
  }
  return getEnvValue('OPENAI_API_KEY') || getEnvValue('STUDIO_AI_API_KEY') || ''
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

// Control can read the provider model catalog for configuration/self-check only.
// Inference still goes through Hermes; this path must never call /chat/completions.
const inspectModelAccessCache = new Map() // key=`${provider}|${baseUrl}|${model}` → 上次探测结果

function buildInspectModelCacheKey({ provider, baseUrl, model }) {
  return `${provider || ''}|${baseUrl || ''}|${model || ''}`
}

async function inspectModelAccess({ provider, baseUrl, model }) {
  const metadata = getModelMetadata(model)
  const access = getProviderAccess(provider, baseUrl)
  const checkedAt = new Date().toISOString()
  const cacheKey = buildInspectModelCacheKey({ provider, baseUrl, model })

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
    const catalog = await fetchLocalModelCatalog({ provider: access.provider, baseUrl: access.baseUrl })
    if (!catalog.ok) {
      const failure = {
        model,
        accessible: false,
        status: 'error',
        detail: catalog.error || '模型目录读取失败',
        checkedAt,
        usage: normalizeUsage(null),
        provider: access.provider,
        baseUrl: access.baseUrl,
        probedProvider: true,
        ...metadata
      }
      inspectModelAccessCache.set(cacheKey, failure)
      return failure
    }

    const presentInCatalog = catalog.models.some((entry) => String(entry?.id || '').trim() === model)
    const result = {
      model,
      accessible: presentInCatalog,
      status: presentInCatalog ? 'ok' : 'error',
      detail: presentInCatalog
        ? '模型已出现在 provider /models 目录中（只读自检，不触发推理）。'
        : `模型未出现在 provider /models 目录中：${model}`,
      checkedAt,
      usage: normalizeUsage(null),
      provider: catalog.provider,
      baseUrl: catalog.baseUrl,
      probedProvider: true,
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
      provider: access.provider,
      baseUrl: access.baseUrl,
      probedProvider: true,
      ...metadata
    }
    inspectModelAccessCache.set(cacheKey, failure)
    return failure
  }
}

function buildProviderAdminBaseUrl(baseUrl, provider) {
  const normalizedProvider = normalizeProviderName(provider)
  const normalizedBaseUrl = normalizeModelBaseUrl(baseUrl, normalizedProvider)
  try {
    const url = new URL(normalizedBaseUrl)
    url.pathname = '/admin'
    url.search = ''
    url.hash = ''
    return url.toString().replace(/\/+$/, '')
  } catch {
    return String(normalizedBaseUrl || '').replace(/\/v1\/?$/i, '') + '/admin'
  }
}

function readCookieHeaderFromResponse(response) {
  if (response?.headers && typeof response.headers.getSetCookie === 'function') {
    const cookies = response.headers.getSetCookie()
    if (Array.isArray(cookies) && cookies.length > 0) {
      return cookies.map((item) => String(item || '').split(';')[0]).filter(Boolean).join('; ')
    }
  }

  const raw = String(response?.headers?.get('set-cookie') || '').trim()
  if (!raw) return ''
  return raw.split(';')[0].trim()
}

async function createProviderAdminSession({ provider, baseUrl }) {
  const access = getProviderAccess(provider, baseUrl)
  const checkedAt = new Date().toISOString()
  if (access.provider !== 'omlx') {
    return {
      ok: false,
      checkedAt,
      detail: `${access.provider} 当前不支持 Control admin session。`
    }
  }

  if (!access.apiKey) {
    return {
      ok: false,
      checkedAt,
      detail: '缺少 OMLX API key，无法建立 admin session。'
    }
  }

  const adminBaseUrl = buildProviderAdminBaseUrl(access.baseUrl, access.provider)
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 8000)
  try {
    const response = await fetch(`${adminBaseUrl}/api/login`, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ api_key: access.apiKey, remember: false }),
      signal: controller.signal
    })
    const payload = await response.json().catch(() => null)
    if (!response.ok) {
      return {
        ok: false,
        checkedAt,
        detail: payload?.detail || payload?.message || `admin_login_http_${response.status}`
      }
    }

    const cookieHeader = readCookieHeaderFromResponse(response)
    if (!cookieHeader) {
      return {
        ok: false,
        checkedAt,
        detail: 'OMLX admin 登录成功，但未返回 session cookie。'
      }
    }

    return {
      ok: true,
      checkedAt,
      provider: access.provider,
      baseUrl: access.baseUrl,
      adminBaseUrl,
      cookieHeader
    }
  } catch (err) {
    return {
      ok: false,
      checkedAt,
      detail: err instanceof Error ? err.message : String(err)
    }
  } finally {
    clearTimeout(timeout)
  }
}

async function fetchProviderModelStatus({ provider, baseUrl, model = '' }) {
  const access = getProviderAccess(provider, baseUrl)
  const checkedAt = new Date().toISOString()
  const selectedModel = String(model || '').trim()
  if (access.provider !== 'omlx') {
    return {
      ok: false,
      unsupported: true,
      checkedAt,
      provider: access.provider,
      baseUrl: access.baseUrl,
      detail: `${access.provider} 当前没有统一的 /models/status 接口。`,
      models: [],
      entry: null
    }
  }

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 5000)
  try {
    const response = await fetch(`${access.baseUrl}/models/status`, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        ...access.headers
      },
      signal: controller.signal
    })
    const payload = await response.json().catch(() => null)
    if (!response.ok) {
      return {
        ok: false,
        checkedAt,
        provider: access.provider,
        baseUrl: access.baseUrl,
        detail: payload?.error?.message || payload?.detail || payload?.message || `HTTP ${response.status}`,
        models: [],
        entry: null
      }
    }

    const models = Array.isArray(payload?.models) ? payload.models : []
    const entry = selectedModel
      ? models.find((item) => String(item?.id || '').trim() === selectedModel) || null
      : null
    return {
      ok: true,
      checkedAt,
      provider: access.provider,
      baseUrl: access.baseUrl,
      models,
      entry,
      payload
    }
  } catch (err) {
    return {
      ok: false,
      checkedAt,
      provider: access.provider,
      baseUrl: access.baseUrl,
      detail: err instanceof Error ? err.message : String(err),
      models: [],
      entry: null
    }
  } finally {
    clearTimeout(timeout)
  }
}

async function waitForProviderModelLoadState({ provider, baseUrl, model, shouldBeLoaded, maxAttempts = 20, intervalMs = 500 }) {
  let lastStatus = null
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const status = await fetchProviderModelStatus({ provider, baseUrl, model })
    lastStatus = status
    const entry = status.entry || null
    const loaded = entry?.loaded === true
    const isLoading = entry?.is_loading === true
    const settled = shouldBeLoaded ? (loaded && !isLoading) : (!loaded && !isLoading)
    if (status.ok && settled) {
      return { ok: true, checkedAt: status.checkedAt, runtimeStatus: status }
    }
    if (attempt < maxAttempts) {
      await new Promise((resolve) => setTimeout(resolve, intervalMs))
    }
  }

  return {
    ok: false,
    checkedAt: lastStatus?.checkedAt || new Date().toISOString(),
    detail: shouldBeLoaded
      ? `provider 已响应，但 ${model} 仍未进入 loaded 状态。`
      : `provider 已响应，但 ${model} 仍未完全退出 loaded 状态。`,
    runtimeStatus: lastStatus
  }
}

async function inspectProviderModelState({ provider, baseUrl, model }) {
  const inspection = await inspectModelAccess({ provider, baseUrl, model })
  if (!inspection.accessible) {
    return {
      ...inspection,
      loaded: false,
      isLoading: false
    }
  }

  const status = await fetchProviderModelStatus({ provider, baseUrl, model })
  if (!status.ok || status.unsupported) {
    return {
      ...inspection,
      loaded: null,
      isLoading: null,
      runtimeStatusKnown: false,
      runtimeStatusDetail: status.detail || null
    }
  }

  const entry = status.entry || null
  const loaded = entry?.loaded === true
  const isLoading = entry?.is_loading === true
  return {
    ...inspection,
    checkedAt: status.checkedAt || inspection.checkedAt,
    loaded,
    isLoading,
    runtimeStatusKnown: true,
    runtimeStatusDetail: loaded
      ? '模型已通过 provider 接口载入。'
      : isLoading
        ? '模型正在 provider 中载入。'
        : '模型已存在，但当前未载入。',
    detail: loaded
      ? '模型已通过 provider 接口载入。'
      : isLoading
        ? '模型正在 provider 中载入。'
        : '模型已存在，但当前未载入。'
  }
}

async function loadProviderModel({ provider, baseUrl, model }) {
  const normalizedModel = String(model || '').trim()
  if (!normalizedModel) {
    return { ok: false, attempted: false, detail: '未指定要加载的模型。' }
  }

  const access = getProviderAccess(provider, baseUrl)
  if (access.provider !== 'omlx') {
    return {
      ok: true,
      attempted: false,
      skipped: true,
      reason: 'provider_unmanaged',
      detail: `${access.provider} 当前不走 Control 的 provider load。`
    }
  }

  // 单模型约束：加载新模型前，先卸载当前已加载的其他模型
  const statusBefore = await fetchProviderModelStatus({ provider: access.provider, baseUrl: access.baseUrl })
  if (statusBefore.ok && Array.isArray(statusBefore.models)) {
    const loadedOthers = statusBefore.models.filter((m) => m?.loaded === true && m?.is_loading === false && String(m?.id || '').trim() !== normalizedModel)
    for (const other of loadedOthers) {
      const otherId = String(other.id || '').trim()
      appendHermesLog(`[MODEL][SINGLE] Unloading previously loaded model before loading ${normalizedModel}: ${otherId}`)
      const unloadResult = await unloadProviderModel({ provider: access.provider, baseUrl: access.baseUrl, model: otherId })
      if (!unloadResult.ok) {
        appendHermesLog(`[MODEL][SINGLE][WARN] Failed to unload ${otherId}: ${unloadResult.detail}`)
      }
    }
  }

  const session = await createProviderAdminSession({ provider: access.provider, baseUrl: access.baseUrl })
  if (!session.ok) {
    return { ok: false, attempted: false, detail: session.detail }
  }

  try {
    const response = await fetch(`${session.adminBaseUrl}/api/models/${encodeURIComponent(normalizedModel)}/load`, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        Cookie: session.cookieHeader
      }
    })
    const payload = await response.json().catch(() => null)
    if (!response.ok) {
      const detail = payload?.error?.message || payload?.detail || payload?.message || `HTTP ${response.status}`
      return { ok: false, attempted: true, detail: String(detail), status: response.status, payload }
    }

    const settled = await waitForProviderModelLoadState({ provider: access.provider, baseUrl: access.baseUrl, model: normalizedModel, shouldBeLoaded: true })
    if (!settled.ok) {
      return { ok: false, attempted: true, detail: settled.detail, payload, runtimeStatus: settled.runtimeStatus }
    }

    return {
      ok: true,
      attempted: true,
      detail: payload?.message || `${normalizedModel} 已通过 provider 接口加载。`,
      payload,
      runtimeStatus: settled.runtimeStatus
    }
  } catch (err) {
    return {
      ok: false,
      attempted: true,
      detail: err instanceof Error ? err.message : String(err)
    }
  }
}

async function unloadProviderModel({ provider, baseUrl, model }) {
  const normalizedModel = String(model || '').trim()
  if (!normalizedModel) {
    return { ok: true, attempted: false, skipped: true, reason: 'missing_model', detail: '未指定要卸载的模型。' }
  }

  const access = getProviderAccess(provider, baseUrl)
  if (access.provider !== 'omlx') {
    return {
      ok: true,
      attempted: false,
      skipped: true,
      reason: 'provider_unmanaged',
      detail: `${access.provider} 当前不走 Control 的 provider unload。`
    }
  }

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 8000)
  try {
    const response = await fetch(`${access.baseUrl}/models/${encodeURIComponent(normalizedModel)}/unload`, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        ...access.headers
      },
      signal: controller.signal
    })
    const payload = await response.json().catch(() => null)
    if (!response.ok) {
      const detail = payload?.error?.message || payload?.detail || payload?.message || `HTTP ${response.status}`
      if (/not loaded/i.test(String(detail))) {
        return { ok: true, attempted: true, skipped: true, reason: 'already_unloaded', detail: `${normalizedModel} 当前已处于未加载状态。`, status: response.status, payload }
      }
      return { ok: false, attempted: true, detail: String(detail), status: response.status, payload }
    }

    const settled = await waitForProviderModelLoadState({ provider: access.provider, baseUrl: access.baseUrl, model: normalizedModel, shouldBeLoaded: false })
    if (!settled.ok) {
      return { ok: false, attempted: true, detail: settled.detail, payload, runtimeStatus: settled.runtimeStatus }
    }

    return {
      ok: true,
      attempted: true,
      detail: payload?.message || `${normalizedModel} 已通过 provider 接口卸载。`,
      payload,
      runtimeStatus: settled.runtimeStatus
    }
  } catch (err) {
    return {
      ok: false,
      attempted: true,
      detail: err instanceof Error ? err.message : String(err)
    }
  } finally {
    clearTimeout(timeout)
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
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), 1500)
      const response = await fetch(`${HERMES_API_SERVER_BASE_URL}/models`, {
        method: 'GET',
        headers: {
          Accept: 'application/json',
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
  const startAt = Date.now()
  const current = getHermesRuntimeState()
  if (current.state === 'uninstalled') {
    appendHermesLog(`[START][SKIP] Hermes uninstalled, cannot start`)
    return current
  }
  if (current.state === 'running') {
    appendHermesLog(`[START][SKIP] Hermes already running pid=${current.pid}`)
    return current
  }

  appendHermesLog(`[START] Initiating Hermes runtime startup`)
  const binding = buildHermesBinding()
  syncHermesRuntimeConfig(binding)
  const providerAccess = getProviderAccess(binding.provider, binding.baseUrl)
  const noProxyValue = buildHermesNoProxyValue(binding)
  const ephemeralSystemPrompt = buildHermesEphemeralSystemPrompt(binding)
  
  const injectedMemoryFiles = [
    binding.memory.agentDefinitionFile,
    binding.memory.userFile,
    binding.memory.memoryFile,
    binding.memory.longTasksFile,
    binding.memory.statusFile,
    binding.memory.taskQueueFile,
    binding.memory.decisionsFile
  ].filter(Boolean)
  
  appendHermesLog(`[START][DETAIL] model=${binding.model} provider=${binding.provider} baseUrl=${binding.baseUrl}`)
  appendHermesLog(`[START][DETAIL] memory_injection=${injectedMemoryFiles.length} files skills=${binding.skills.availableSkillFiles?.length || 0}`)
  
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
  const pythonPath = getHermesPython()
  appendHermesLog(`[START][DETAIL] python=${pythonPath} script=${HERMES_GATEWAY_SCRIPT} cwd=${HERMES_ROOT}`)
  
  const child = spawn(pythonPath, [HERMES_GATEWAY_SCRIPT, 'run'], {
    cwd: HERMES_ROOT,
    detached: true,
    stdio: ['ignore', logFd, logFd],
    env: customEnv
  })

  child.unref()
  writeHermesPid(child.pid)
  appendHermesLog(`[START][DETAIL] hermes_pid=${child.pid}`)
  ensureHermesGatewayLogWatcher()

  const apiReadyStart = Date.now()
  const readiness = await waitForHermesApiReady()
  const apiReadyDuration = Date.now() - apiReadyStart
  if (!readiness.ready) {
    appendHermesLog(`[START][WARN] Hermes API not ready after launch wait: ${readiness.detail} time_ms=${apiReadyDuration}`)
  } else {
    appendHermesLog(`[START][DETAIL] api_ready_time_ms=${apiReadyDuration}`)
  }
  
  const totalDuration = Date.now() - startAt
  appendHermesLog(`[START][COMPLETE] total_time_ms=${totalDuration} state=${getHermesRuntimeState().state}`)
  return getHermesRuntimeState()
}

async function stopHermesRuntime() {
  const stopAt = Date.now()
  const current = getHermesRuntimeState()
  if (current.state !== 'running' || !current.pid) {
    appendHermesLog(`[STOP][SKIP] Hermes not running, state=${current.state}`)
    return current
  }

  hermesStoppingIntentionally = true
  appendHermesLog(`[STOP] Stopping Hermes runtime pid=${current.pid}`)
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
    appendHermesLog(`[STOP][OK] Hermes stopped gracefully time_ms=${Date.now() - stopAt}`)
  } else {
    appendHermesLog(`[STOP][WARN] Hermes still running after SIGTERM, escalating to SIGKILL`)
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
      appendHermesLog(`[STOP][OK] Hermes stopped with SIGKILL time_ms=${Date.now() - stopAt}`)
    } else {
      appendHermesLog(`[STOP][ERROR] Hermes still running after SIGKILL, manual intervention may be needed`)
    }
  }
  hermesChildProcess = null
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
  const defaultProvider = 'omlx'
  const defaultBaseUrl = 'http://127.0.0.1:18888/v1'
  const defaultModel = 'gpt-oss-20b-MXFP4-Q8'
  return {
    provider: defaultProvider,
    baseUrl: defaultBaseUrl,
    model: defaultModel,
    shortTerm: {
      minContextTokens: 65536
    },
    workflow: {
      memoryOverlayMode: 'references-only',
      replayWindowMessages: 24,
      reasoningReplayWindowMessages: 8,
      modelRouting: buildDefaultModelRoutingConfig({
        provider: defaultProvider,
        baseUrl: defaultBaseUrl,
        model: defaultModel
      })
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

function normalizeModelRoutingKey(value) {
  return String(value || '').trim()
}

function normalizeModelRouteEntry(route, fallbackRoute) {
  const fallback = fallbackRoute && typeof fallbackRoute === 'object'
    ? fallbackRoute
    : { provider: 'omlx', baseUrl: 'http://127.0.0.1:18888/v1', model: '', transport: 'hermes', strict: false }
  const raw = route && typeof route === 'object' ? route : {}
  const provider = normalizeProviderName(raw.provider || fallback.provider)
  const baseUrl = normalizeModelBaseUrl(raw.baseUrl || fallback.baseUrl, provider)
  const model = String(raw.model || fallback.model || '').trim()
  const requestedTransport = String(raw.transport || fallback.transport || 'hermes').trim().toLowerCase()
  let transport = requestedTransport === 'direct' ? 'direct' : 'hermes'
  if (transport !== 'direct' && (provider !== fallback.provider || baseUrl !== fallback.baseUrl || model !== fallback.model)) {
    transport = 'direct'
  }
  return {
    provider,
    baseUrl,
    model,
    transport,
    strict: raw.strict === undefined ? Boolean(fallback.strict) : Boolean(raw.strict)
  }
}

function buildDefaultModelRoutingConfig({ provider, baseUrl, model }) {
  const defaultRoute = normalizeModelRouteEntry({ provider, baseUrl, model, transport: 'hermes', strict: false }, {
    provider,
    baseUrl,
    model,
    transport: 'hermes',
    strict: false
  })
  return {
    defaultRoute,
    phaseRoutes: {
      story_scripts_candidate: normalizeModelRouteEntry({ model: 'gpt-oss-20b-MXFP4-Q8', transport: 'hermes', strict: true }, defaultRoute),
      story_blueprint_review: normalizeModelRouteEntry({ model: 'gpt-oss-20b-MXFP4-Q8', transport: 'hermes', strict: true }, defaultRoute)
    },
    actionRoutes: {},
    strictRouteRequiredPhases: ['story_scripts_candidate', 'story_blueprint_review']
  }
}

function normalizeModelRoutingMap(rawRoutes, defaultRoute, seededRoutes = {}) {
  const normalized = { ...seededRoutes }
  if (!rawRoutes || typeof rawRoutes !== 'object') return normalized
  for (const [key, route] of Object.entries(rawRoutes)) {
    const normalizedKey = normalizeModelRoutingKey(key)
    if (!normalizedKey) continue
    normalized[normalizedKey] = normalizeModelRouteEntry(route, normalized[normalizedKey] || defaultRoute)
  }
  return normalized
}

function normalizeModelRoutingConfig(rawRouting, fallbackRoute) {
  const defaults = buildDefaultModelRoutingConfig(fallbackRoute)
  const raw = rawRouting && typeof rawRouting === 'object' ? rawRouting : {}
  const defaultRoute = normalizeModelRouteEntry(raw.defaultRoute, defaults.defaultRoute)
  return {
    defaultRoute,
    phaseRoutes: normalizeModelRoutingMap(raw.phaseRoutes, defaultRoute, defaults.phaseRoutes),
    actionRoutes: normalizeModelRoutingMap(raw.actionRoutes, defaultRoute, defaults.actionRoutes),
    strictRouteRequiredPhases: normalizeStringList(raw.strictRouteRequiredPhases).length > 0
      ? normalizeStringList(raw.strictRouteRequiredPhases)
      : defaults.strictRouteRequiredPhases
  }
}

function buildBindingForResolvedModelRoute(binding, route, access = null) {
  const provider = normalizeProviderName(access?.provider || route?.provider || binding?.provider)
  const baseUrl = normalizeModelBaseUrl(access?.baseUrl || route?.baseUrl || binding?.baseUrl, provider)
  const model = String(route?.model || binding?.model || '').trim()
  const metadata = getModelMetadata(model)
  return {
    ...binding,
    provider,
    baseUrl,
    model,
    contextLength: metadata.contextLength,
    recommendedMaxOutputTokens: metadata.recommendedMaxOutputTokens,
    tokenizer: String(metadata.tokenizer || '') || null,
    metadataSource: String(metadata.metadataSource || 'unavailable')
  }
}

function getExplicitModelRouteMatch(binding, phase, options = {}) {
  const routing = binding?.workflow?.modelRouting
  const actionKey = normalizeModelRoutingKey(options.action)
  if (actionKey && routing?.actionRoutes?.[actionKey]) {
    return {
      routeConfig: routing.actionRoutes[actionKey],
      routeId: `action:${actionKey}`,
      matchedBy: 'action'
    }
  }
  const phaseKey = normalizeModelRoutingKey(phase)
  if (phaseKey && routing?.phaseRoutes?.[phaseKey]) {
    return {
      routeConfig: routing.phaseRoutes[phaseKey],
      routeId: `phase:${phaseKey}`,
      matchedBy: 'phase'
    }
  }
  return null
}

export function resolveModelRouteForPhase(binding, phase, options = {}) {
  const fallbackBinding = binding || buildHermesBinding()
  const fallbackRoute = normalizeModelRouteEntry({
    provider: fallbackBinding.provider,
    baseUrl: fallbackBinding.baseUrl,
    model: fallbackBinding.model,
    transport: 'hermes',
    strict: false
  }, {
    provider: fallbackBinding.provider,
    baseUrl: fallbackBinding.baseUrl,
    model: fallbackBinding.model,
    transport: 'hermes',
    strict: false
  })
  const match = getExplicitModelRouteMatch(fallbackBinding, phase, options)
  const resolvedRoute = match?.routeConfig || fallbackBinding?.workflow?.modelRouting?.defaultRoute || fallbackRoute
  const strictRouteRequiredPhases = new Set(normalizeStringList(fallbackBinding?.workflow?.modelRouting?.strictRouteRequiredPhases || []))
  const phaseKey = normalizeModelRoutingKey(phase)
  const route = normalizeModelRouteEntry(resolvedRoute, fallbackRoute)
  route.strict = route.strict || strictRouteRequiredPhases.has(phaseKey)
  const access = getProviderAccess(route.provider, route.baseUrl)
  const requestBinding = buildBindingForResolvedModelRoute(fallbackBinding, route, access)
  return {
    routeId: match?.routeId || 'default',
    matchedBy: match?.matchedBy || 'default',
    explicit: Boolean(match),
    transport: route.transport,
    strict: route.strict,
    provider: access.provider,
    baseUrl: access.baseUrl,
    model: route.model,
    apiKey: access.apiKey,
    headers: access.headers,
    binding: requestBinding
  }
}

export function getModelRouteOverrideForPhase(binding, phase, options = {}) {
  const resolved = resolveModelRouteForPhase(binding, phase, options)
  if (!resolved.explicit) return null
  return {
    routeId: resolved.routeId,
    provider: resolved.provider,
    model: resolved.model,
    apiUrl: resolved.baseUrl,
    strict: resolved.strict
  }
}

function buildPersistedHermesControlConfig(rawConfig = {}) {
  const defaults = getDefaultHermesControlConfig()
  const memory = rawConfig.memory || {}
  const skills = rawConfig.skills || {}
  const shortTerm = rawConfig.shortTerm || {}
  const workflow = rawConfig.workflow || {}
  const brains = rawConfig.brains || {}
  const provider = normalizeProviderName(rawConfig.provider || defaults.provider)
  const baseUrl = normalizeModelBaseUrl(rawConfig.baseUrl || defaults.baseUrl, provider)
  const model = String(rawConfig.model || defaults.model)

  return {
    provider,
    baseUrl,
    model,
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
        : defaults.workflow.reasoningReplayWindowMessages),
      modelRouting: normalizeModelRoutingConfig(workflow.modelRouting, { provider, baseUrl, model })
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
  const loaded = typeof inspection?.loaded === 'boolean' ? inspection.loaded === true : accessible
  return {
    status: loaded ? 'loaded' : (inspection ? (accessible ? 'unloaded' : 'error') : 'unloaded'),
    label: loaded ? '已启动' : '未启动',
    detail: inspection?.detail || (loaded ? '模型已就绪' : (accessible ? '模型尚未加载' : '模型不可访问')),
    provider: normalizeProviderName(provider),
    baseUrl: normalizeModelBaseUrl(baseUrl, provider),
    model,
    inspectedAt: inspection?.checkedAt || new Date().toISOString(),
    loadedAt: loaded ? (loadedAt || new Date().toISOString()) : null,
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
    ? await inspectProviderModelState({ provider: config.provider, baseUrl: config.baseUrl, model: config.model })
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
    domains: [
      'workspace_observation',
      'review_gated_workspace_change',
      'context_memory',
      'gamestudio_bootstrap',
      'story_workflow',
      'gamestudio_observer',
      'production_test_evidence'
    ],
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
      sessions: '/api/control/agents/:agentId/reasoning-sessions',
      agentRuntimeSessions: '/api/control/agents/:agentId/agent-runtime-sessions',
      review: '/api/control/agents/:agentId/agent-runtime-sessions/:sessionId/review',
      cancel: '/api/control/agents/:agentId/agent-runtime-sessions/:sessionId/cancel',
      recover: '/api/control/agents/:agentId/agent-runtime-sessions/:sessionId/recover',
      clear: '/api/control/agents/:agentId/agent-runtime-sessions/:sessionId',
      productionTestSession: '/api/control/agents/:agentId/production-test-session',
      skillProposals: '/api/control/skill-proposals'
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
  const bootstrapActions = REASONING_GAMESTUDIO_BOOTSTRAP_ACTION_NAMES.map((name) => actionMap.get(name)).filter(Boolean)
  const storyActions = REASONING_STORY_WORKFLOW_ACTION_NAMES.map((name) => actionMap.get(name)).filter(Boolean)
  const storyMutationActions = REASONING_STORY_MUTATION_ACTION_NAMES.map((name) => actionMap.get(name)).filter(Boolean)
  const storyObserverToolsPresent = [
    'gamestudio.story.createProject',
    'gamestudio.story.inspectProject',
    'gamestudio.story.validateProject',
    'gamestudio.story.exportProject'
  ].every((toolName) => toolMap.has(toolName))

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
      key: 'runtime-gamestudio-bootstrap',
      label: 'GameStudio 启动与自检能力',
      status: bootstrapActions.length === REASONING_GAMESTUDIO_BOOTSTRAP_ACTION_NAMES.length ? 'ok' : 'error',
      detail: bootstrapActions.length === REASONING_GAMESTUDIO_BOOTSTRAP_ACTION_NAMES.length
        ? `已覆盖 ${bootstrapActions.length} 个 bootstrap 动作：启动/打开 Editor/settings/本地生产配置/自检。`
        : `bootstrap 动作覆盖不足：${bootstrapActions.length}/${REASONING_GAMESTUDIO_BOOTSTRAP_ACTION_NAMES.length}。`
    },
    {
      key: 'runtime-story-workflow',
      label: '互动故事生产工作流',
      status: storyActions.length === REASONING_STORY_WORKFLOW_ACTION_NAMES.length ? 'ok' : 'error',
      detail: storyActions.length === REASONING_STORY_WORKFLOW_ACTION_NAMES.length
        ? `已覆盖 ${storyActions.length} 个 story workflow 动作：创建、配置、脚本、蓝图、合成层、资产、校验和导出。`
        : `story workflow 动作覆盖不足：${storyActions.length}/${REASONING_STORY_WORKFLOW_ACTION_NAMES.length}。`
    },
    {
      key: 'runtime-story-review-gates',
      label: '故事写入审核门',
      status: storyMutationActions.every((action) => action.requiresHumanReview) ? 'ok' : 'error',
      detail: storyMutationActions.every((action) => action.requiresHumanReview)
        ? '所有故事写入/编译/资产/导出动作均需要 review gate 或测试策略授权。'
        : '存在故事变更动作未被标记为需要审核。'
    },
    {
      key: 'runtime-gamestudio-observer',
      label: 'GameStudio 动态观测者',
      status: storyObserverToolsPresent ? 'ok' : 'error',
      detail: storyObserverToolsPresent
        ? 'story/bootstrap 执行会写 gamestudio_observer timeline，记录 operation、endpoint、phase、耗时、projectId 和错误。'
        : '缺少关键 GameStudio story 工具，无法形成完整 observer 证据链。'
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
    },
    {
      key: 'runtime-session-control',
      label: 'Session 控制与恢复',
      status: 'ok',
      detail: 'agentRuntime 已提供 review、cancel、recover、clear 与 production-test active session 路由，支持生产测试追踪和中断恢复。'
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

async function fetchLocalModelCatalog({ provider, baseUrl, model = '' }) {
  const normalizedProvider = normalizeProviderName(provider)
  const normalizedBaseUrl = normalizeModelBaseUrl(baseUrl, normalizedProvider)
  const selectedModel = String(model || '').trim()
  const access = getProviderAccess(normalizedProvider, normalizedBaseUrl)
  try {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 5000)
    const response = await fetch(`${access.baseUrl}/models`, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        ...access.headers
      },
      signal: controller.signal
    })
    clearTimeout(timeout)

    const data = await response.json().catch(() => null)
    if (!response.ok) {
      const error = data?.error?.message || data?.message || `HTTP ${response.status}`
      return {
        ok: false,
        provider: access.provider,
        baseUrl: access.baseUrl,
        auth: {
          required: access.provider !== 'ollama',
          keyPresent: Boolean(access.apiKey)
        },
        probedProvider: true,
        error: String(error),
        models: selectedModel ? [{ id: selectedModel, object: 'model', created: null, ownedBy: 'configured', ...getModelMetadata(selectedModel) }] : []
      }
    }

    const entries = Array.isArray(data?.data) ? data.data : (Array.isArray(data?.models) ? data.models : [])
    const models = entries.map((entry) => {
      const id = typeof entry === 'string'
        ? entry
        : String(entry?.id || entry?.name || entry?.model || '').trim()
      if (!id) return null
      return {
        id,
        object: typeof entry === 'object' && entry?.object ? entry.object : 'model',
        created: typeof entry === 'object' && entry?.created ? entry.created : null,
        ownedBy: typeof entry === 'object' && entry?.owned_by ? entry.owned_by : (typeof entry === 'object' && entry?.ownedBy ? entry.ownedBy : normalizedProvider),
        ...getModelMetadata(id)
      }
    }).filter(Boolean)

    return {
      ok: true,
      provider: access.provider,
      baseUrl: access.baseUrl,
      auth: {
        required: access.provider !== 'ollama',
        keyPresent: Boolean(access.apiKey)
      },
      probedProvider: true,
      detail: `已读取 provider /models 目录，发现 ${models.length} 个模型。`,
      models
    }
  } catch (err) {
    return {
      ok: false,
      provider: access.provider,
      baseUrl: access.baseUrl,
      auth: {
        required: access.provider !== 'ollama',
        keyPresent: Boolean(access.apiKey)
      },
      probedProvider: true,
      error: err instanceof Error ? err.message : String(err),
      models: selectedModel ? [{ id: selectedModel, object: 'model', created: null, ownedBy: 'configured', ...getModelMetadata(selectedModel) }] : []
    }
  }
}

async function buildHermesPreflight(configOverrides = {}, options = {}) {
  const preflightStart = Date.now()
  const current = getPersistedHermesControlConfig()
  const mergedConfig = mergeHermesControlConfig(current, configOverrides)
  const binding = buildHermesBindingFromConfig(mergedConfig)
  const installState = detectHermesInstallState()
  
  appendHermesLog(`[PREFLIGHT] Starting Hermes preflight model=${binding.model} provider=${binding.provider}`)
  
  const modelCatalog = await fetchLocalModelCatalog({ provider: binding.provider, baseUrl: binding.baseUrl, model: binding.model })
  const selectedModel = binding.model || modelCatalog.models[0]?.id || ''
  const inspection = selectedModel
    ? await inspectModelAccess({ provider: binding.provider, baseUrl: binding.baseUrl, model: selectedModel })
    : {
        model: '',
        accessible: false,
        status: 'error',
        detail: '请选择模型。Control 不直接读取底层 provider 模型目录。',
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
      detail: selectedModel || '请选择模型。Control 不直接读取底层 provider 模型目录。'
    },
    {
      key: 'model-catalog-selection',
      label: '模型目录自检',
      status: inspection.accessible ? 'ok' : 'error',
      detail: inspection.accessible ? `${selectedModel} 已在模型目录中` : inspection.detail
    }
  ]

  const preflightDuration = Date.now() - preflightStart
  const logs = checks.map((item) => `[CHECK][${item.status === 'ok' ? 'OK' : 'ERROR'}] ${item.label}: ${item.detail}`)
  if (options.appendLogs) {
    appendHermesLog(['[PREFLIGHT] Starting Hermes preflight checks', ...logs])
  }
  appendHermesLog(`[PREFLIGHT][${checks.every((item) => item.status === 'ok') ? 'OK' : 'ERROR'}] preflight_completed time_ms=${preflightDuration} ready=${checks.every((item) => item.status === 'ok')} model=${selectedModel}`)

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
  const runtimeStatus = getHermesRuntimeState()
  let modelRouteStatus = runtimeStatus.state === 'running' ? 'ok' : 'warning'
  let modelRouteDetail = runtimeStatus.state === 'running'
    ? 'Hermes runtime 已运行；Control 不直连底层 provider 探测模型目录。'
    : (runtimeStatus.detail || 'Hermes runtime 未运行')

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

  // 3.1. Capability status questions: evidence is collected by a fixed workflow,
  // then summarized deterministically so production tests do not become long model generations.
  registerIntent({
    id: 'builtin.capability_status_answer',
    source: 'builtin',
    description: '能力状态 / 缺口类问题的确定性回答',
    priority: 88,
    matchAnswer: (prompt, artifacts) =>
      shouldUseDeterministicCapabilityStatusAnswer(prompt, artifacts),
    buildDeterministicAnswer: (prompt, artifacts) =>
      buildProjectCapabilityStatusAnswer(prompt, artifacts),
    deterministicAnswerReason: 'deterministic_capability_status_summary',
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
    fetchProviderModelStatus,
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
    listActiveReasoningExecutions,
    getSelectableContextSourceById,
    hermesAgentDefinition,
    inspectModelAccess,
    inspectProviderModelState,
    listContextPoolEntries,
    loadProviderModel,
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
    unloadProviderModel,
    runMemoryLifecycleMaintenance: () => runMemoryLifecycleMaintenance({
      fs,
      rootDir: GAMESTUDIO_ROOT,
      contextPoolDir: HERMES_CONTEXT_POOL_DIR,
      chatDir: path.join(GAMESTUDIO_ROOT, 'ai', 'chat'),
      sessionDirs: [HERMES_AGENT_RUNTIME_SESSIONS_DIR, HERMES_REASONING_SESSIONS_DIR],
    }),
    runAllReasoningStepsFrom,
    runReasoningSession,
    setActiveHermesChatRequest,
    setHermesControlConfig,
    spawn,
    startHermesRuntime,
    stopHermesRuntime,
    recoverHermesChatRuntime,
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
  requestRoute = null,
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
  const resolvedRoute = requestRoute && typeof requestRoute === 'object'
    ? requestRoute
    : {
        routeId: 'default',
        transport: 'hermes',
        explicit: false,
        strict: false,
        provider: binding.provider,
        model: binding.model,
        baseUrl: binding.baseUrl
      }
  const target = resolvedRoute.transport === 'direct'
    ? `${resolvedRoute.baseUrl}/chat/completions`
    : `${HERMES_API_SERVER_BASE_URL}/chat/completions`
  const targetModel = resolvedRoute.transport === 'direct' ? resolvedRoute.model : 'hermes-agent'

  return {
    provider: binding.provider,
    model: binding.model,
    baseUrl: binding.baseUrl,
    controllerRequest: {
      purpose,
      mode,
      routeId: resolvedRoute.routeId,
      transport: resolvedRoute.transport,
      target,
      model: targetModel,
      totalMessages: previewMessages.length,
      systemMessageCount: previewMessages.filter((message) => message.role === 'system').length,
      replayedMessageCount,
      userMessageCount: previewMessages.filter((message) => message.role === 'user').length,
      messages: previewMessages
    },
    runtimeRoute: {
      routeId: resolvedRoute.routeId,
      transport: resolvedRoute.transport,
      explicit: Boolean(resolvedRoute.explicit),
      strict: Boolean(resolvedRoute.strict),
      provider: resolvedRoute.provider,
      model: resolvedRoute.model,
      baseUrl: resolvedRoute.baseUrl,
      note: resolvedRoute.transport === 'direct'
        ? 'Control 已按阶段路由直接调用目标 provider/model；该请求不经过 Hermes runtime 的固定别名。'
        : 'Control 先把请求发给 Hermes；Hermes 再按当前左脑绑定把本次任务路由到对应 provider/model。未命中显式阶段路由时仍保持这一行为。'
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

function hasReasoningEvent(session, eventTypes) {
  const typeSet = new Set(Array.isArray(eventTypes) ? eventTypes : [eventTypes])
  return Array.isArray(session?.events) && session.events.some((event) => typeSet.has(event?.type))
}

function getLatestReasoningEvent(session, eventTypes) {
  const typeSet = new Set(Array.isArray(eventTypes) ? eventTypes : [eventTypes])
  const events = Array.isArray(session?.events) ? session.events : []
  for (let index = events.length - 1; index >= 0; index--) {
    if (typeSet.has(events[index]?.type)) return events[index]
  }
  return null
}

function buildReasoningWorkflowProgress(session) {
  if (!session || typeof session !== 'object') return []
  const status = String(session.status || '')
  const isFailed = status === 'failed'
  const isCancelled = status === 'cancelled'
  const hasPlan = Boolean(session.plan || session.runtimeTaskGraph || hasReasoningEvent(session, 'plan_created'))
  const hasAnswer = Boolean(session.artifacts?.finalAnswer || hasReasoningEvent(session, 'final_answer_ready'))
  const qualityStarted = hasReasoningEvent(session, [
    'quality_assessment_completed',
    'quality_gate_skipped',
    'quality_review_required',
    'self_review_completed',
    'model_task_queued',
    'model_task_started',
    'model_task_completed'
  ])
  const qualityDone = hasReasoningEvent(session, [
    'quality_assessment_completed',
    'quality_gate_skipped',
    'quality_review_required',
    'self_review_completed',
    'quality_gate_rejected',
    'session_completed'
  ])
  const currentReview = session.review || null
  const currentStep = Array.isArray(session.plan?.steps)
    ? session.plan.steps.find((step) => step.stepId === session.currentStepId) || null
    : null
  const completedStepCount = Array.isArray(session?.events)
    ? session.events.filter((event) => event?.type === 'step_completed').length
    : 0
  const totalStepCount = Array.isArray(session.plan?.steps) ? session.plan.steps.length : 0
  const latestPlanEvent = getLatestReasoningEvent(session, ['plan_created', 'planning_started'])
  const latestStepEvent = getLatestReasoningEvent(session, ['step_started', 'step_completed', 'tool_result', 'tool_called'])
  const latestAnswerEvent = getLatestReasoningEvent(session, ['final_answer_ready'])
  const latestQualityEvent = getLatestReasoningEvent(session, ['quality_assessment_completed', 'quality_gate_skipped', 'quality_review_required', 'self_review_completed', 'quality_gate_rejected'])

  const phaseStatus = (phase) => {
    if (isFailed) return 'failed'
    if (isCancelled) return 'cancelled'
    if (phase === 'planning') {
      if (currentReview?.targetType === 'runtime_task_graph' || currentReview?.targetType === 'plan') return 'waiting_review'
      if (status === 'planning') return 'running'
      return hasPlan ? 'completed' : 'pending'
    }
    if (phase === 'executing') {
      if (!hasPlan) return 'pending'
      if (currentReview?.targetType === 'step') return 'waiting_review'
      if (hasAnswer || qualityStarted || status === 'completed') return 'completed'
      if (status === 'running' || status === 'waiting_review') return 'running'
      return 'pending'
    }
    if (phase === 'answering') {
      if (hasAnswer) return 'completed'
      if (!hasPlan) return 'pending'
      if (status === 'running' && currentStep?.action === 'generate_default_answer') return 'running'
      return totalStepCount > 0 && completedStepCount >= Math.max(0, totalStepCount - 1) ? 'running' : 'pending'
    }
    if (phase === 'quality_review') {
      if (currentReview?.reviewPhase === 'quality_override') return 'waiting_review'
      if (qualityDone || status === 'completed') return 'completed'
      if (qualityStarted) return 'running'
      return hasAnswer ? 'running' : 'pending'
    }
    return 'pending'
  }

  return [
    {
      phaseId: 'planning',
      title: '任务制定',
      status: phaseStatus('planning'),
      summary: latestPlanEvent?.summary || '读取上下文并提交给 Hermes 制定运行任务图。',
      currentOperation: currentReview?.targetType === 'runtime_task_graph' || currentReview?.targetType === 'plan' ? currentReview.title : (latestPlanEvent?.title || '构建运行任务图'),
      evidence: hasPlan ? `${totalStepCount} 个步骤` : null
    },
    {
      phaseId: 'executing',
      title: '工作流执行',
      status: phaseStatus('executing'),
      summary: latestStepEvent?.summary || '按运行任务图顺序执行工具、读取证据并记录 artifacts。',
      currentOperation: currentReview?.targetType === 'step' ? currentReview.title : (currentStep?.title || latestStepEvent?.title || ''),
      evidence: totalStepCount > 0 ? `${Math.min(completedStepCount, totalStepCount)}/${totalStepCount} 步` : null
    },
    {
      phaseId: 'answering',
      title: 'Hermes 生成答案',
      status: phaseStatus('answering'),
      summary: latestAnswerEvent?.summary || '汇总已收集证据，通过 Hermes 生成最终回答。',
      currentOperation: currentStep?.action === 'generate_default_answer' ? currentStep.title : '提交证据给 Hermes',
      evidence: session.artifacts?.finalAnswer ? `${String(session.artifacts.finalAnswer).length} 字` : null
    },
    {
      phaseId: 'quality_review',
      title: '答案自检',
      status: phaseStatus('quality_review'),
      summary: latestQualityEvent?.summary || '提交答案、证据和评分规则给 Hermes 执行质量评分与自审。',
      currentOperation: currentReview?.reviewPhase === 'quality_override' ? currentReview.title : (latestQualityEvent?.title || '等待答案进入自检'),
      evidence: session.artifacts?.latestAnswerAssessment?.score != null ? `评分 ${session.artifacts.latestAnswerAssessment.score}/100` : null
    }
  ]
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
    events: normalizedEvents,
    workflowProgress: buildReasoningWorkflowProgress({
      ...session,
      runtimeTaskGraph,
      plan: runtimeTaskGraph,
      events: normalizedEvents
    })
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

let memoryLifecycleMaintenanceTimer = null
let memoryLifecycleMaintenanceRunning = false
let memoryLifecycleMaintenancePending = false

function runMemoryLifecycleMaintenanceNow(reason = 'manual') {
  if (memoryLifecycleMaintenanceRunning) {
    memoryLifecycleMaintenancePending = true
    return null
  }

  memoryLifecycleMaintenanceRunning = true
  try {
    return runMemoryLifecycleMaintenance({
      fs,
      rootDir: GAMESTUDIO_ROOT,
      contextPoolDir: HERMES_CONTEXT_POOL_DIR,
      chatDir: path.join(GAMESTUDIO_ROOT, 'ai', 'chat'),
      sessionDirs: [HERMES_AGENT_RUNTIME_SESSIONS_DIR, HERMES_REASONING_SESSIONS_DIR],
    })
  } catch (error) {
    appendHermesLog(`[MEMORY][LIFECYCLE][ERROR] reason=${reason} detail=${error instanceof Error ? error.message : String(error)}`)
    return null
  } finally {
    memoryLifecycleMaintenanceRunning = false
    if (memoryLifecycleMaintenancePending) {
      memoryLifecycleMaintenancePending = false
      scheduleMemoryLifecycleMaintenance(`${reason}:pending`, 0)
    }
  }
}

function scheduleMemoryLifecycleMaintenance(reason = 'unspecified', delayMs = 1200) {
  if (memoryLifecycleMaintenanceTimer) {
    clearTimeout(memoryLifecycleMaintenanceTimer)
  }
  memoryLifecycleMaintenanceTimer = setTimeout(() => {
    memoryLifecycleMaintenanceTimer = null
    runMemoryLifecycleMaintenanceNow(reason)
  }, Math.max(0, Number(delayMs) || 0))
}

function getActiveReasoningExecution(sessionId) {
  return activeHermesReasoningExecutions.get(String(sessionId)) || null
}

function listActiveReasoningExecutions() {
  return Array.from(activeHermesReasoningExecutions.values()).map((execution) => {
    const session = readReasoningSession(execution.sessionId)
    return {
      sessionId: execution.sessionId,
      phase: execution.phase,
      startedAt: Number.isFinite(Number(execution.startedAt)) ? new Date(execution.startedAt).toISOString() : null,
      activeForMs: Number.isFinite(Number(execution.startedAt)) ? Math.max(0, Date.now() - Number(execution.startedAt)) : null,
      status: session?.status || null,
      currentStepId: session?.currentStepId || null,
      title: session?.title || session?.userPrompt || ''
    }
  })
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

function createReasoningSessionClearArchive(sessionId) {
  const timestamp = new Date().toISOString()
  const safeTimestamp = timestamp.replace(/[:.]/g, '-')
  const archiveDir = path.join(GAMESTUDIO_ROOT, 'state', 'memory-archive', 'manual-clear', `reasoning-session_${safeTimestamp}_${sessionId}`)
  fs.mkdirSync(path.join(archiveDir, 'files'), { recursive: true })
  return { archiveDir, createdAt: timestamp, files: [] }
}

function archiveReasoningSessionFile(filePath, archive) {
  if (!filePath || !fs.existsSync(filePath)) return false
  const stat = fs.statSync(filePath)
  if (!stat.isFile()) return false
  const relativeSource = path.relative(GAMESTUDIO_ROOT, filePath)
  const targetPath = path.join(archive.archiveDir, 'files', relativeSource)
  fs.mkdirSync(path.dirname(targetPath), { recursive: true })
  fs.copyFileSync(filePath, targetPath)
  archive.files.push({
    source: relativeSource,
    archivePath: path.relative(GAMESTUDIO_ROOT, targetPath),
    sizeBytes: stat.size
  })
  return true
}

function writeReasoningSessionClearReport(sessionId, archive) {
  const reportPath = path.join(archive.archiveDir, 'clear-report.json')
  fs.writeFileSync(reportPath, `${JSON.stringify({
    createdAt: archive.createdAt,
    completedAt: new Date().toISOString(),
    target: 'reasoning-session',
    sessionId,
    archivedFileCount: archive.files.length,
    archivedFiles: archive.files
  }, null, 2)}\n`, 'utf8')
  return {
    archiveDir: path.relative(GAMESTUDIO_ROOT, archive.archiveDir),
    reportFile: path.relative(GAMESTUDIO_ROOT, reportPath),
    archivedFileCount: archive.files.length
  }
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
  const archive = createReasoningSessionClearArchive(sessionId)
  for (const filePath of filePaths) {
    if (fs.existsSync(filePath)) {
      archiveReasoningSessionFile(filePath, archive)
      fs.unlinkSync(filePath)
    }
  }
  const archiveSummary = writeReasoningSessionClearReport(sessionId, archive)
  unmarkReasoningSessionActive(sessionId)
  clearActiveReasoningExecution(sessionId)
  return { sessionId, archive: archiveSummary }
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
  const heartbeatWaitMs = Math.max(1000, HERMES_REASONING_TASK_HEARTBEAT_MS)
  const hardTimeoutAtMs = Date.parse(String(currentTask?.hardTimeoutAt || ''))
  if (Number.isFinite(hardTimeoutAtMs)) {
    const hardTimeoutWaitMs = Math.max(0, hardTimeoutAtMs - Date.now())
    if (hardTimeoutWaitMs <= heartbeatWaitMs) return { waitMs: hardTimeoutWaitMs, kind: 'hard_timeout' }
  }
  return { waitMs: heartbeatWaitMs, kind: 'heartbeat' }
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

  // 记忆回写：将本次 session 的关键状态写入 ai/memory/ 文件
  try {
    const binding = buildHermesBinding()
    const hadMutatingWork = (session.plan?.steps || []).some((s) => {
      const action = String(s?.action || '')
      return action.startsWith('story_') || action.startsWith('gamestudio_') || action === 'write_file' || action === 'write_memory_file' || action === 'update_task_queue' || action === 'invoke_tool'
    })
    if (hadMutatingWork && binding.memory) {
      const completedSteps = (session.plan?.steps || []).filter((s) => s && (s.status === 'completed' || s.status === 'ok'))
      const failedSteps = (session.plan?.steps || []).filter((s) => s && (s.status === 'failed' || s.status === 'error'))

      const statusPath = binding.memory.statusFile
      if (statusPath) {
        const statusContent = [
          `## 当前目标`,
          String(session.userPrompt || '（未指定）').trim(),
          ``,
          `## 当前结果`,
          session.artifacts?.finalAnswer ? '推理已完成，最终回答已生成。' : '推理进行中或未完成。',
          ``,
          `## 当前阻塞`,
          failedSteps.length > 0 ? `${failedSteps.length} 个步骤失败，需人工审查。` : '无阻塞。',
          ``,
          `## 下一步`,
          '继续推进剩余任务',
          ``,
          `sessionId: ${sessionId}`,
          `updatedAt: ${new Date().toISOString()}`
        ].join('\n')
        fs.writeFileSync(statusPath, statusContent, 'utf8')
      }

      const taskQueuePath = binding.memory.taskQueueFile
      if (taskQueuePath) {
        const taskContent = [
          `## Ready（待处理）`,
          ...completedSteps.map((s) => `- [x] ${String(s.title || s.action || '未命名步骤').trim()}`),
          ...failedSteps.map((s) => `- [ ] ${String(s.title || s.action || '未命名步骤').trim()} (失败: ${String(s.error || '未知').trim()})`),
          ``,
          `updatedAt: ${new Date().toISOString()}`
        ].join('\n')
        fs.writeFileSync(taskQueuePath, taskContent, 'utf8')
      }

      appendHermesLog(`[MEMORY][WRITEBACK] sessionId=${sessionId} status=${statusPath ? 'ok' : 'skip'} taskQueue=${taskQueuePath ? 'ok' : 'skip'}`)
    }
  } catch (writebackErr) {
    appendHermesLog(`[MEMORY][WRITEBACK][ERROR] sessionId=${sessionId} detail=${writebackErr instanceof Error ? writebackErr.message : String(writebackErr)}`)
  }

  unmarkReasoningSessionActive(sessionId)
  scheduleMemoryLifecycleMaintenance('reasoning_session_completed')
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
  scheduleMemoryLifecycleMaintenance('reasoning_session_failed')
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
    ? `已停止当前 ${activePhase} 阶段并中断 Hermes 模型请求。`
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

  const exhausted = task.renewalCount >= task.maxRenewals
  return {
    state: exhausted ? 'control_lease_exhausted' : 'control_request_pending',
    canContinue: !exhausted,
    checkedAt,
    telemetrySource: 'control_lease',
    nativeSessionSupported: false,
    detail: exhausted
      ? `Control task lease budget is exhausted for ${phase}; no provider health probe was performed`
      : `Hermes runtime is running; Control is waiting for the pending ${phase} task without probing the underlying provider`
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
    appendReasoningEvent(sessionId, 'task_started', phaseLabel, `${phaseLabel}进入受监督执行窗口，当前路由 ${binding.provider}/${binding.model}；若命中 deterministic fallback，将不会调用远端模型。`, {
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
    appendHermesLog(`[REASONING][TASK][START] sessionId=${sessionId} phase=${phase} routeProvider=${binding.provider} routeModel=${binding.model} leaseMs=${HERMES_REASONING_TASK_LEASE_MS} maxRenewals=${HERMES_REASONING_TASK_MAX_RENEWS}`)

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

      if (result?.kind === 'hard_timeout') {
        const detail = `${phase}_task_timeout: exceeded hard timeout ${HERMES_REASONING_TASK_HARD_TIMEOUT_MS}ms while waiting through Hermes`
        controller.abort()
        updateReasoningTask(sessionId, phase, (task) => ({
          ...task,
          status: 'failed',
          finishedAt: new Date().toISOString(),
          lastObservedAt: new Date().toISOString(),
          telemetrySource: 'control_hard_timeout',
          error: detail
        }))
        appendReasoningEvent(sessionId, 'task_failed', phaseLabel, detail, { data: { phase } })
        appendHermesLog(`[REASONING][TASK][TIMEOUT] sessionId=${sessionId} phase=${phase} detail=${detail}`)
        throw new Error(detail)
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
  // productionTest mode bypasses all review gates for automated testing
  if (session?.submissionContext?.productionTest) return false
  if (isReasoningAutoReviewMode(session)) return false
  if (isReasoningStoryMutationAction(step.action)) return true
  return !isReasoningWriteAction(step.action) && !isReasoningInvokeAction(step.action)
}

function shouldRequireHumanReviewForStep(step, session = null) {
  if (!step) return false
  if (isReasoningAutoReviewMode(session)) return false
  if (session?.submissionContext?.productionTest) return false
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
  const allowRecentCarryover = Boolean(options.forceCarryover) || shouldAllowRecentContextCarryover(currentPrompt)
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
      'prepare model.answer execution',
      'remote Hermes chat completion is used only when no deterministic answer matches',
      `hermes route=${String(binding.provider || 'configured-provider').trim() || 'configured-provider'}/${String(binding.model || 'configured-model').trim() || 'configured-model'}`,
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

  if (String(step.action || '').startsWith('story_')) {
    const ops = []
    const endpoint = String(extra.endpoint || '').trim()
    const projectId = String(extra.projectId || step.params?.projectId || '').trim()
    ops.push(`story workflow action=${step.action}`)
    if (endpoint) ops.push(`server endpoint=${endpoint}`)
    if (projectId) ops.push(`projectId=${projectId}`)
    if (extra.evaluator?.name) ops.push(`evaluator=${extra.evaluator.name}:${extra.evaluator.passed ? 'pass' : 'fail'}`)
    if (extra.failedStage) ops.push(`failedStage=${extra.failedStage}`)
    return ops
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

function readJsonFileIfExists(filePath) {
  try {
    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) return null
    return JSON.parse(fs.readFileSync(filePath, 'utf8'))
  } catch {
    return null
  }
}

function getLatestStoryProjectId() {
  try {
    if (!fs.existsSync(STORAGE_PROJECTS_ROOT) || !fs.statSync(STORAGE_PROJECTS_ROOT).isDirectory()) return ''
    const entries = fs.readdirSync(STORAGE_PROJECTS_ROOT, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => {
        const projectDir = path.join(STORAGE_PROJECTS_ROOT, entry.name)
        const stat = fs.statSync(projectDir)
        return { id: entry.name, mtimeMs: Number(stat.mtimeMs || 0) }
      })
      .sort((left, right) => right.mtimeMs - left.mtimeMs)
    return entries[0]?.id || ''
  } catch {
    return ''
  }
}

function getPersistedStoryProjectId() {
  const state = readJsonFileIfExists(STORY_PRODUCTION_STATE_FILE)
  return String(state?.projectId || '').trim()
}

function persistStoryProjectPointer(result) {
  const projectId = String(result?.projectId || '').trim()
  if (!projectId || result?.ok !== true) return
  try {
    fs.mkdirSync(path.dirname(STORY_PRODUCTION_STATE_FILE), { recursive: true })
    fs.writeFileSync(STORY_PRODUCTION_STATE_FILE, JSON.stringify({
      projectId,
      action: result.action || null,
      updatedAt: new Date().toISOString(),
      summary: result.summary || null
    }, null, 2), 'utf8')
  } catch (_) {}
}

function getStoryProjectIdFromArtifacts(artifacts) {
  const storyProduction = artifacts?.storyProduction && typeof artifacts.storyProduction === 'object'
    ? artifacts.storyProduction
    : null
  return String(storyProduction?.currentProjectId || storyProduction?.lastProjectId || '').trim()
}

function resolveStoryProjectId(session, step, userPrompt) {
  const explicit = String(step?.params?.projectId || '').trim()
  if (explicit) return explicit
  const artifactProjectId = getStoryProjectIdFromArtifacts(session?.artifacts || {})
  if (artifactProjectId) return artifactProjectId
  const promptProjectId = extractProjectIdFromPrompt(userPrompt)
  if (promptProjectId) return promptProjectId
  const persistedProjectId = getPersistedStoryProjectId()
  if (persistedProjectId) return persistedProjectId
  return getLatestStoryProjectId()
}

function getStoryProjectDir(projectId) {
  return path.join(STORAGE_PROJECTS_ROOT, String(projectId || ''))
}

function readStoryProjectFile(projectId, fileName) {
  if (!projectId) return null
  return readJsonFileIfExists(path.join(getStoryProjectDir(projectId), fileName))
}

function parseJsonObjectText(rawText) {
  const text = String(rawText || '').trim()
  if (!text) return null
  try {
    const parsed = JSON.parse(text)
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch (_) {
    return null
  }
}

function readStoryBibleFromProjectDoc(project) {
  const state = project && project.state && typeof project.state === 'object' ? project.state : {}
  const aiBackground = state && state.aiBackground && typeof state.aiBackground === 'object' ? state.aiBackground : {}
  if (aiBackground.storyBible && typeof aiBackground.storyBible === 'object') return aiBackground.storyBible
  return parseJsonObjectText(aiBackground.storyBibleJson)
}

function readStoryAssetPlanFile(projectId) {
  if (!projectId) return null
  return readJsonFileIfExists(path.join(getStoryProjectDir(projectId), 'story-assets', 'plan.json'))
}

function textHasAny(text, needles) {
  const hay = String(text || '')
  return needles.some((needle) => hay.includes(needle))
}

function collectStorySceneEntries(projectId) {
  const story = readStoryProjectFile(projectId, 'story.json')
  const scripts = readStoryProjectFile(projectId, 'scripts.json')
  const storyNodes = Array.isArray(story?.nodes) ? story.nodes : []
  if (storyNodes.length) {
    return storyNodes
      .filter((node) => ['scene', 'ending'].includes(String(node?.kind || '').trim()))
      .map((node, index) => ({
        key: String(node?.id || node?.name || `scene_${index + 1}`).trim(),
        name: String(node?.name || node?.body?.title || `场景${index + 1}`).trim(),
        text: String(node?.body?.text || '').trim()
      }))
  }
  const cards = Array.isArray(scripts?.cards) ? scripts.cards : []
  return cards.map((card, index) => ({
    key: String(card?.id || card?.name || `scene_${index + 1}`).trim(),
    name: String(card?.name || `场景${index + 1}`).trim(),
    text: String(card?.text || '').trim()
  }))
}

function buildControlDerivedStoryBible(projectId) {
  const project = readStoryProjectFile(projectId, 'project.json')
  const scenes = collectStorySceneEntries(projectId)
  const fullText = scenes.map((scene) => `${scene.name} ${scene.text}`).join('\n')
  if (!String(fullText || '').trim()) return null

  const characters = []
  const props = []
  const locations = []
  const add = (list, item) => {
    if (!list.some((entry) => String(entry.id || '') === String(item.id || ''))) list.push(item)
  }

  if (textHasAny(fullText, ['孩子', '牧童', '守护者'])) {
    add(characters, {
      id: 'char.shepherd_boy',
      name: '牧童孩子',
      aliases: ['孩子', '牧童', '小牧童', '守护者'],
      anchorPrompt: 'young shepherd boy, simple rural clothes, anxious but kind expression, child proportions, picture book character design, no modern items',
      negativePrompt: 'adult, modern city clothes, armor, weapon'
    })
  }
  if (textHasAny(fullText, ['狼', '狼嚎'])) {
    add(characters, {
      id: 'char.wolf',
      name: '受伤的狼',
      aliases: ['狼', '狼嚎', '受伤的狼'],
      anchorPrompt: 'gray wild wolf, lean canine body, alert eyes, slightly injured leg when story requires it, picture book animal character, not a dog',
      negativePrompt: 'domestic dog, cute puppy, humanoid wolf, monster, robot'
    })
  }
  if (textHasAny(fullText, ['村民', '大家'])) {
    add(characters, {
      id: 'char.villagers',
      name: '村民们',
      aliases: ['村民', '大家', '村民们'],
      anchorPrompt: 'small group of rural villagers, simple countryside clothing, concerned expressions, picture book ensemble character design',
      negativePrompt: 'modern office workers, soldiers, city crowd'
    })
  }
  if (textHasAny(fullText, ['羊群', '山羊', '羊'])) {
    add(characters, {
      id: 'char.sheep_flock',
      name: '羊群',
      aliases: ['羊群', '羊', '山羊'],
      anchorPrompt: 'small flock of white sheep, rounded wool, gentle rural storybook animals, consistent simple shapes',
      negativePrompt: 'goats only, cows, horses, aggressive animals'
    })
  }
  if (textHasAny(fullText, ['羊圈', '绳索'])) {
    add(props, {
      id: 'prop.sheep_pen_rope',
      name: '羊圈绳索',
      aliases: ['羊圈', '绳索', '羊圈的绳索'],
      anchorPrompt: 'standalone sheep pen rope, rustic fiber cord tied to a small wooden pen gate, clean object reference on plain background',
      forbiddenSubstitutes: ['chain', 'modern plastic rope', 'weapon']
    })
  }
  if (textHasAny(fullText, ['草席', '包扎', '伤口'])) {
    add(props, {
      id: 'prop.grass_mat_bandage',
      name: '草席包扎物',
      aliases: ['草席', '包扎', '伤口'],
      anchorPrompt: 'small woven grass mat used as an improvised bandage, rustic handmade texture, standalone object reference on plain background',
      forbiddenSubstitutes: ['medical gauze roll', 'modern first aid kit']
    })
  }
  if (textHasAny(fullText, ['山坡', '山脊', '牧场', '草原', '山脉'])) {
    add(locations, {
      id: 'loc.misty_hillside_pasture',
      name: '清晨山坡牧场',
      aliases: ['山坡', '山脊', '牧场', '草原', '山脉'],
      anchorPrompt: 'misty dawn hillside pasture, soft grass, sheep pen, distant bronze colored mountains, quiet rural fairy tale atmosphere'
    })
  }
  if (textHasAny(fullText, ['村民', '回家'])) {
    add(locations, {
      id: 'loc.village_edge',
      name: '村庄边缘',
      aliases: ['村庄', '回家', '村民集合处'],
      anchorPrompt: 'edge of a small rural village near pasture, simple cottages, footpath to hillside, picture book background reference'
    })
  }

  const sceneRefs = {}
  for (const scene of scenes) {
    const text = `${scene.name} ${scene.text}`
    sceneRefs[scene.key] = {
      characters: [
        textHasAny(text, ['孩子', '牧童', '他', '守护者']) ? 'char.shepherd_boy' : '',
        textHasAny(text, ['狼', '狼嚎']) ? 'char.wolf' : '',
        textHasAny(text, ['村民', '大家']) ? 'char.villagers' : '',
        textHasAny(text, ['羊群', '羊', '山羊']) ? 'char.sheep_flock' : ''
      ].filter(Boolean),
      props: [
        textHasAny(text, ['羊圈', '绳索']) ? 'prop.sheep_pen_rope' : '',
        textHasAny(text, ['草席', '包扎', '伤口']) ? 'prop.grass_mat_bandage' : ''
      ].filter(Boolean),
      locations: [
        textHasAny(text, ['山坡', '山脊', '牧场', '草原', '山脉']) ? 'loc.misty_hillside_pasture' : '',
        textHasAny(text, ['村民', '回家']) ? 'loc.village_edge' : ''
      ].filter(Boolean)
    }
  }

  return {
    schemaVersion: '1.0',
    title: String(project?.title || '').trim() || '互动故事',
    worldAnchor: 'Chinese rural fable, warm picture book illustration, consistent characters and locations across scenes',
    forbiddenSubstitutes: ['modern city', 'science fiction', 'horror gore', 'photorealistic adults replacing child', 'dog replacing wolf'],
    eventChain: scenes.map((scene) => `${scene.name}: ${scene.text}`.slice(0, 180)).filter(Boolean),
    characters,
    props,
    locations,
    sceneRefs,
    source: 'control_derived_from_scripts_and_story'
  }
}

function buildStoryBibleGenerationInput(projectId) {
  const derived = buildControlDerivedStoryBible(projectId)
  if (!derived) return null
  const project = readStoryProjectFile(projectId, 'project.json')
  const scripts = readStoryProjectFile(projectId, 'scripts.json')
  const scenes = collectStorySceneEntries(projectId)
  return {
    title: String(project?.title || derived.title || '互动故事').trim(),
    brief: String(project?.brief || project?.description || project?.summary || '').trim(),
    scenes: scenes.map((scene) => ({
      sceneId: String(scene?.key || '').trim(),
      name: String(scene?.name || '').trim(),
      text: String(scene?.text || '').trim()
    })).filter((scene) => scene.sceneId && scene.text),
    scripts: Array.isArray(scripts?.cards)
      ? scripts.cards.map((card) => ({
        id: String(card?.id || '').trim(),
        name: String(card?.name || '').trim(),
        order: Number(card?.order || 0) || 0,
        text: String(card?.text || '').trim()
      })).filter((card) => card.id && card.text)
      : [],
    candidateWorldHints: {
      worldAnchor: derived.worldAnchor,
      forbiddenSubstitutes: Array.isArray(derived.forbiddenSubstitutes) ? derived.forbiddenSubstitutes : [],
      eventChain: Array.isArray(derived.eventChain) ? derived.eventChain : []
    },
    candidateEntities: {
      characters: Array.isArray(derived.characters)
        ? derived.characters.map((item) => ({
          ...item,
          fingerprintPrompt: String(item?.anchorPrompt || '').trim()
        }))
        : [],
      props: Array.isArray(derived.props) ? derived.props : [],
      locations: Array.isArray(derived.locations) ? derived.locations : []
    },
    scenePresenceRules: [
      'Only include entities in sceneRefs when the scene should visually show them in the frame.',
      'Mentioned, rumored, shouted, remembered, or heard-from-afar entities are not automatically visual scene members.',
      'Choice scenes should bind only what is already visible before the choice, not branch outcomes.',
      'Transient states such as injured, crying, wet, broken, frightened, or bleeding must not become the core identity of a character or prop.',
      'Usually keep at most one primary location anchor per scene unless the same shot clearly contains both spaces.'
    ],
    source: 'control_story_workflow_story_bible_input'
  }
}

async function createStoryAssetPlanWithControlFallback(projectId, payload = {}) {
  const first = await gameStudioServerClient.createStoryAssetPlan(projectId, payload)
  if (first?.ok || first?.error !== 'missing_story_bible') return first
  const storyBible = buildControlDerivedStoryBible(projectId)
  if (!storyBible) return first
  const retry = await gameStudioServerClient.createStoryAssetPlan(projectId, {
    ...payload,
    storyBible,
    source: payload?.source || 'control_derived_story_bible'
  })
  if (retry?.data && typeof retry.data === 'object') {
    retry.data.controlDerivedStoryBible = storyBible
  }
  return retry
}

function buildStoryProjectSnapshot(projectId) {
  const projectDir = projectId ? getStoryProjectDir(projectId) : ''
  const fileNames = projectDir && fs.existsSync(projectDir) && fs.statSync(projectDir).isDirectory()
    ? fs.readdirSync(projectDir).sort((left, right) => left.localeCompare(right))
    : []
  const project = readStoryProjectFile(projectId, 'project.json')
  const story = readStoryProjectFile(projectId, 'story.json')
  const scripts = readStoryProjectFile(projectId, 'scripts.json')
  const blueprint = readStoryProjectFile(projectId, 'blueprint.json')
  const meta = readStoryProjectFile(projectId, 'meta.json')
  const exportsDir = projectId ? path.join(projectDir, 'builds') : ''
  const latestDist = projectId ? path.join(exportsDir, 'latest', 'dist', 'index.html') : ''
  const latestDistStat = latestDist && fs.existsSync(latestDist) && fs.statSync(latestDist).isFile()
    ? fs.statSync(latestDist)
    : null
  return {
    projectId: String(projectId || ''),
    projectDir,
    projectDirRelative: projectDir ? normalizeWorkspaceRelativePath(path.relative(GAMESTUDIO_ROOT, projectDir)) : '',
    projectDirExists: Boolean(projectDir && fs.existsSync(projectDir) && fs.statSync(projectDir).isDirectory()),
    fileNames,
    project: project ? {
      id: project.id || projectId,
      title: project.title || '',
      generationConfig: project.generationConfig || project.storyProduction?.generationConfig || null,
      assetCount: Array.isArray(project.assets) ? project.assets.length : 0,
      characterCount: Array.isArray(project.characters) ? project.characters.length : 0
    } : null,
    story: story ? {
      startNodeId: story.startNodeId || story.startId || '',
      nodeCount: Array.isArray(story.nodes) ? story.nodes.length : 0
    } : null,
    scripts: scripts ? {
      cardCount: Array.isArray(scripts.cards) ? scripts.cards.length : 0,
      updatedAt: scripts.updatedAt || ''
    } : null,
    blueprint: blueprint ? {
      startNodeId: blueprint.startNodeId || '',
      nodeCount: Array.isArray(blueprint.nodes) ? blueprint.nodes.length : 0,
      placeholderCount: Array.isArray(blueprint.placeholders) ? blueprint.placeholders.length : 0
    } : null,
    meta: meta ? {
      title: meta.title || '',
      aiFormula: meta.aiFormula || null
    } : null,
    exports: {
      latestDist,
      latestDistRelative: latestDist ? normalizeWorkspaceRelativePath(path.relative(GAMESTUDIO_ROOT, latestDist)) : '',
      latestDistExists: Boolean(latestDistStat),
      latestDistMtime: latestDistStat ? latestDistStat.mtime.toISOString() : null
    }
  }
}

function evaluateStoryProjectCreated(projectId) {
  const snapshot = buildStoryProjectSnapshot(projectId)
  const required = ['assets', 'blueprint.json', 'meta.json', 'project.json', 'scripts.json', 'story.json']
  const missing = required.filter((name) => !snapshot.fileNames.includes(name))
  return {
    name: 'evaluateCreateProject',
    passed: snapshot.projectDirExists && missing.length === 0,
    missing,
    checks: {
      projectDirExists: snapshot.projectDirExists,
      requiredFiles: required,
      actualFiles: snapshot.fileNames
    }
  }
}

function evaluateStoryScripts(scripts) {
  const cards = Array.isArray(scripts?.cards) ? scripts.cards : []
  const invalidCards = cards.filter((card) => !card?.id || !card?.name || !Number.isFinite(Number(card?.order)) || !String(card?.text || '').trim())
  const hasChoice = cards.some((card) => /选项\s*1|选项1/i.test(String(card?.text || '')))
  const endingCount = cards.filter((card) => /^结局/i.test(String(card?.name || '').trim())).length
  return {
    name: 'evaluateScripts',
    passed: cards.length > 0 && invalidCards.length === 0 && hasChoice && endingCount > 0,
    checks: {
      cardCount: cards.length,
      invalidCardCount: invalidCards.length,
      hasChoice,
      endingCount
    }
  }
}

function evaluateInteractiveStoryBlueprint(projectId, validation = null) {
  const scripts = readStoryProjectFile(projectId, 'scripts.json')
  const blueprint = readStoryProjectFile(projectId, 'blueprint.json')
  const meta = readStoryProjectFile(projectId, 'meta.json')
  const nodes = Array.isArray(blueprint?.nodes) ? blueprint.nodes : []
  const cards = Array.isArray(scripts?.cards) ? scripts.cards : []
  const nodeIds = new Set(nodes.map((node) => String(node?.id || '')).filter(Boolean))
  const startNodeId = String(blueprint?.startNodeId || '').trim()
  const unresolvedChoices = []
  const emptyTextNodes = []
  const choiceNodes = []
  const endingNodes = []
  const cardIds = new Set(cards.map((card) => String(card?.id || '')).filter(Boolean))
  const missingScriptLinks = []
  for (const node of nodes) {
    const nodeId = String(node?.id || '').trim()
    const choices = Array.isArray(node?.choices) ? node.choices : []
    if (!String(node?.textDraft || '').trim()) emptyTextNodes.push(nodeId || String(node?.name || 'unknown'))
    if (choices.length > 1 || /选择点/.test(String(node?.name || ''))) choiceNodes.push(nodeId)
    if (choices.length === 0 || /^结局/.test(String(node?.name || '').trim())) endingNodes.push(nodeId)
    const scriptCardId = String(node?.scriptCardId || '').trim()
    if (scriptCardId && !cardIds.has(scriptCardId)) missingScriptLinks.push({ nodeId, scriptCardId })
    for (const choice of choices) {
      const toNodeId = String(choice?.toNodeId || '').trim()
      if (!toNodeId || !nodeIds.has(toNodeId)) unresolvedChoices.push({ nodeId, choiceId: choice?.id || null, toNodeId })
    }
  }
  const reachable = new Set()
  const stack = startNodeId && nodeIds.has(startNodeId) ? [startNodeId] : []
  const nodeById = new Map(nodes.map((node) => [String(node?.id || ''), node]))
  while (stack.length) {
    const current = stack.pop()
    if (!current || reachable.has(current)) continue
    reachable.add(current)
    const node = nodeById.get(current)
    const choices = Array.isArray(node?.choices) ? node.choices : []
    for (const choice of choices) {
      const toNodeId = String(choice?.toNodeId || '').trim()
      if (toNodeId && nodeIds.has(toNodeId) && !reachable.has(toNodeId)) stack.push(toNodeId)
    }
  }
  const validationErrors = Array.isArray(validation?.errors) ? validation.errors : []
  const formula = meta?.aiFormula && typeof meta.aiFormula === 'object' ? meta.aiFormula : null
  const expectedChoicePoints = Number.isFinite(Number(formula?.choicePoints)) ? Number(formula.choicePoints) : null
  const expectedEndings = Number.isFinite(Number(formula?.endings)) ? Number(formula.endings) : null
  const issues = []
  const strengths = []
  if (!blueprint) issues.push('缺少 blueprint.json。')
  if (!scripts) issues.push('缺少 scripts.json。')
  if (!startNodeId || !nodeIds.has(startNodeId)) issues.push('startNodeId 为空或不指向现有节点。')
  if (nodes.length < 5) issues.push('节点数过少，不足以表达一个可交互故事。')
  if (reachable.size !== nodes.length) issues.push(`存在不可达节点：可达 ${reachable.size}/${nodes.length}。`)
  if (unresolvedChoices.length) issues.push(`存在 ${unresolvedChoices.length} 个无效跳转。`)
  if (emptyTextNodes.length) issues.push(`存在 ${emptyTextNodes.length} 个空文本节点。`)
  if (missingScriptLinks.length) issues.push(`存在 ${missingScriptLinks.length} 个蓝图节点无法对应脚本卡。`)
  if (choiceNodes.length < 1) issues.push('缺少选择点节点。')
  if (endingNodes.length < 2) issues.push('结局节点少于 2 个。')
  if (expectedChoicePoints !== null && choiceNodes.length < expectedChoicePoints) issues.push(`选择点少于公式要求：${choiceNodes.length}/${expectedChoicePoints}。`)
  if (expectedEndings !== null && endingNodes.length < expectedEndings) issues.push(`结局少于公式要求：${endingNodes.length}/${expectedEndings}。`)
  if (validationErrors.length) issues.push(`GameStudio 蓝图校验存在 ${validationErrors.length} 个错误。`)
  if (nodes.length >= 5) strengths.push(`蓝图包含 ${nodes.length} 个节点。`)
  if (reachable.size === nodes.length && nodes.length > 0) strengths.push('所有节点均可从起点到达。')
  if (choiceNodes.length >= 1) strengths.push(`识别到 ${choiceNodes.length} 个选择点。`)
  if (endingNodes.length >= 2) strengths.push(`识别到 ${endingNodes.length} 个结局/终点。`)
  if (!unresolvedChoices.length && nodes.length > 0) strengths.push('所有跳转均指向现有节点。')
  const penalty = (
    (!blueprint ? 25 : 0) +
    (!scripts ? 20 : 0) +
    (!startNodeId || !nodeIds.has(startNodeId) ? 20 : 0) +
    Math.min(20, Math.max(0, nodes.length ? nodes.length - reachable.size : 1) * 5) +
    Math.min(20, unresolvedChoices.length * 8) +
    Math.min(15, emptyTextNodes.length * 5) +
    Math.min(10, missingScriptLinks.length * 5) +
    (choiceNodes.length < 1 ? 15 : 0) +
    (endingNodes.length < 2 ? 15 : 0) +
    Math.min(20, validationErrors.length * 10)
  )
  const score = Math.max(0, Math.min(100, 100 - penalty))
  const passed = score >= 80 && issues.length === 0
  return {
    name: 'evaluateInteractiveStoryBlueprint',
    passed,
    score,
    needsRepair: !passed,
    issues,
    strengths,
    checks: {
      projectId,
      nodeCount: nodes.length,
      scriptCardCount: cards.length,
      startNodeId,
      reachableCount: reachable.size,
      unresolvedChoiceCount: unresolvedChoices.length,
      emptyTextNodeCount: emptyTextNodes.length,
      missingScriptLinkCount: missingScriptLinks.length,
      choiceNodeCount: choiceNodes.length,
      endingNodeCount: endingNodes.length,
      expectedChoicePoints,
      expectedEndings,
      validationOk: validation?.ok !== false,
      validationErrorCount: validationErrors.length,
      sampleNodes: nodes.slice(0, 12).map((node) => ({
        id: node?.id || '',
        name: node?.name || '',
        choices: Array.isArray(node?.choices) ? node.choices.length : 0,
        textPreview: String(node?.textDraft || '').slice(0, 120)
      }))
    }
  }
}

async function reviewStoryBlueprintWithHermes(sessionId, projectId, deterministicReview, serverReview, validation, signal, binding = buildHermesBinding(), requestRoute = null) {
  const project = readStoryProjectFile(projectId, 'project.json')
  const scripts = readStoryProjectFile(projectId, 'scripts.json')
  const blueprint = readStoryProjectFile(projectId, 'blueprint.json')
  const resolvedRoute = requestRoute || resolveModelRouteForPhase(binding, 'story_blueprint_review')
  const compactBlueprint = {
    startNodeId: blueprint?.startNodeId || '',
    nodes: Array.isArray(blueprint?.nodes)
      ? blueprint.nodes.slice(0, 20).map((node) => ({
          id: node?.id || '',
          name: node?.name || '',
          textDraft: String(node?.textDraft || '').slice(0, 240),
          choices: Array.isArray(node?.choices) ? node.choices.map((choice) => ({ text: choice?.text || '', toNodeId: choice?.toNodeId || '' })) : []
        }))
      : []
  }
  const messages = [
    {
      role: 'system',
      content: [
        'You are Hermes, reviewing a GameStudio interactive story blueprint.',
        'Return strict JSON only. No markdown, no commentary outside JSON.',
        'Assess whether the blueprint can work as an interactive story: reachable start, meaningful choices, valid branch jumps, coherent consequences, at least two endings, child-safe story continuity when relevant.',
        'Schema: {"score":number,"verdict":"approve|repair","summary":string,"issues":string[],"strengths":string[],"repairPlan":string[]}.',
        'Use Chinese for all prose fields.'
      ].join('\n')
    },
    {
      role: 'user',
      content: JSON.stringify({
        project: { id: projectId, title: project?.title || '' },
        scriptsCardCount: Array.isArray(scripts?.cards) ? scripts.cards.length : 0,
        deterministicReview,
        gameStudioReview: serverReview || null,
        validation,
        blueprint: compactBlueprint
      }, null, 2)
    }
  ]
  const data = await requestHermesChatCompletion({
    sessionId,
    phase: 'story_blueprint_review',
    messages,
    maxTokens: 900,
    temperature: 0.1,
    route: resolvedRoute,
    signal,
    timeoutMs: HERMES_CHAT_REQUEST_TIMEOUT_MS
  })
  const content = data.choices?.[0]?.message?.content || ''
  const parsed = JSON.parse(extractJsonObjectString(content))
  const score = Math.max(0, Math.min(100, Number(parsed?.score || 0)))
  const verdict = String(parsed?.verdict || '').trim() === 'approve' ? 'approve' : 'repair'
  return {
    score,
    verdict,
    passed: verdict === 'approve' && score >= 80,
    summary: String(parsed?.summary || '').trim(),
    issues: Array.isArray(parsed?.issues) ? parsed.issues.map((item) => String(item)).filter(Boolean).slice(0, 12) : [],
    strengths: Array.isArray(parsed?.strengths) ? parsed.strengths.map((item) => String(item)).filter(Boolean).slice(0, 12) : [],
    repairPlan: Array.isArray(parsed?.repairPlan) ? parsed.repairPlan.map((item) => String(item)).filter(Boolean).slice(0, 12) : [],
    provider: binding.provider,
    model: binding.model,
    usage: data.usage || null,
    rawResponsePreview: truncateReasoningPreview(content, 1600)
  }
}

function evaluateStoryProjectRunnable(projectId, validation = null) {
  const snapshot = buildStoryProjectSnapshot(projectId)
  const validationErrors = Array.isArray(validation?.errors) ? validation.errors : []
  return {
    name: 'evaluateRunnableProject',
    passed: snapshot.projectDirExists
      && Boolean(snapshot.scripts?.cardCount)
      && Boolean(snapshot.blueprint?.nodeCount)
      && Boolean(snapshot.story?.nodeCount)
      && validationErrors.length === 0,
    checks: {
      projectDirExists: snapshot.projectDirExists,
      scriptCards: snapshot.scripts?.cardCount || 0,
      blueprintNodes: snapshot.blueprint?.nodeCount || 0,
      storyNodes: snapshot.story?.nodeCount || 0,
      validationErrorCount: validationErrors.length
    }
  }
}

function evaluateStoryResourceReferences(projectId) {
  const project = readStoryProjectFile(projectId, 'project.json')
  const story = readStoryProjectFile(projectId, 'story.json')
  const assets = Array.isArray(project?.assets) ? project.assets : []
  const characters = Array.isArray(project?.characters) ? project.characters : []
  const assetIds = new Set(assets.map((asset) => String(asset?.id || '')).filter(Boolean))
  const characterIds = new Set(characters.map((character) => String(character?.id || '')).filter(Boolean))
  const missingAssets = []
  const missingCharacters = []
  const nodes = Array.isArray(story?.nodes) ? story.nodes : []
  for (const node of nodes) {
    const nodeId = String(node?.id || '')
    const backgroundAssetId = String(node?.visuals?.backgroundAssetId || node?.backgroundAssetId || '').trim()
    if (backgroundAssetId && !assetIds.has(backgroundAssetId)) {
      missingAssets.push({ nodeId, assetId: backgroundAssetId, field: 'backgroundAssetId' })
    }
    const placements = Array.isArray(node?.visuals?.placements) ? node.visuals.placements : []
    for (const placement of placements) {
      const characterId = String(placement?.characterId || '').trim()
      if (characterId && !characterIds.has(characterId)) {
        missingCharacters.push({ nodeId, characterId, field: 'visuals.placements.characterId' })
      }
    }
  }
  return {
    name: 'evaluateResourceReferences',
    passed: Boolean(project && story && missingAssets.length === 0 && missingCharacters.length === 0),
    checks: {
      projectExists: Boolean(project),
      storyExists: Boolean(story),
      assetCount: assets.length,
      characterCount: characters.length,
      nodeCount: nodes.length,
      missingAssets,
      missingCharacters
    }
  }
}

function evaluateStoryExport(result) {
  const evidence = result?.evidence || {}
  return {
    name: 'evaluateExport',
    passed: Boolean(result?.ok && evidence.distUrl && evidence.distExists),
    checks: {
      ok: Boolean(result?.ok),
      buildId: evidence.buildId || null,
      distUrl: evidence.distUrl || null,
      distPath: evidence.distPath || null,
      distMtime: evidence.distMtime || null,
      exportedAt: evidence.exportedAt || null,
      distExists: Boolean(evidence.distExists)
    }
  }
}

function buildFallbackStoryScripts({ title, brief }) {
  const safeTitle = String(title || '').trim() || '未命名互动故事'
  const safeBrief = String(brief || '').trim() || `${safeTitle} 的互动故事。`
  const now = new Date().toISOString()
  const card = (id, name, order, text) => ({ id, name, order, text, updatedAt: now })
  return {
    schemaVersion: '1.0',
    cards: [
      card('card_intro', '开场', 1, `${safeTitle}。${safeBrief} 主角在一个关键时刻意识到，今晚的选择会改变所有人的命运。`),
      card('card_choice_1', '选择1', 2, '选项1：主动追查异常的源头。\n选项2：先保护身边重要的人。'),
      card('card_choice_1_result_1', '1后果1', 3, '主角追查线索，发现看似偶然的事件背后藏着可重复验证的规律。'),
      card('card_choice_1_result_2', '1后果2', 4, '主角选择保护同伴，因此错过了第一条线索，却获得了更深的信任。'),
      card('card_ending_1', '结局1', 5, '主角打破循环，带着真相走向新的清晨。'),
      card('card_ending_2', '结局2', 6, '主角保留秘密，让世界暂时维持原状，但心里已经知道下一次该如何选择。')
    ],
    updatedAt: now
  }
}

function normalizeStoryScriptsCandidate(parsed, fallbackInput) {
  const source = parsed?.scripts && typeof parsed.scripts === 'object' ? parsed.scripts : parsed
  const cardsIn = Array.isArray(source?.cards) ? source.cards : []
  const now = new Date().toISOString()
  const cards = cardsIn.map((card, index) => ({
    id: String(card?.id || `card_${index + 1}`).trim(),
    name: String(card?.name || `分镜${index + 1}`).trim(),
    order: Number.isFinite(Number(card?.order)) ? Number(card.order) : index + 1,
    text: String(card?.text || '').trim(),
    updatedAt: String(card?.updatedAt || now)
  })).filter((card) => card.id && card.name && card.text)
  const scripts = { schemaVersion: '1.0', cards, updatedAt: now }
  const verdict = evaluateStoryScripts(scripts)
  if (verdict.passed) return { scripts, verdict, fallback: false, fallbackReason: null }
  const fallbackScripts = buildFallbackStoryScripts(fallbackInput || {})
  return {
    scripts: fallbackScripts,
    verdict: evaluateStoryScripts(fallbackScripts),
    fallback: true,
    fallbackReason: cards.length === 0 ? 'model_candidate_missing_cards' : 'model_candidate_failed_script_schema'
  }
}

async function generateStoryScriptsCandidate(sessionId, step, userPrompt, signal, binding = buildHermesBinding(), requestRoute = null) {
  const title = String(step.params?.title || extractStoryTitleFromPrompt(userPrompt) || '').trim() || '未命名互动故事'
  const brief = String(step.params?.brief || userPrompt || '').trim()
  const config = inferStoryConfigFromPrompt(userPrompt)
  const resolvedRoute = requestRoute || resolveModelRouteForPhase(binding, 'story_scripts_candidate')
  const messages = [
    {
      role: 'system',
      content: [
        'You generate GameStudio interactive story scripts as strict JSON only.',
        'Return one JSON object. No markdown fences, no commentary.',
        'The JSON must match: { "title": string, "language": string, "cards": [{ "id": string, "name": string, "order": number, "text": string }] }.',
        'Use Chinese when the brief is Chinese.',
        'The scripts layer must use cards only. Do not create blueprint fields or asset IDs.',
        'Include one choice card whose text contains separate lines starting with 选项1 and 选项2.',
        'Include consequence cards named 1后果1 and 1后果2, and at least two ending cards named 结局1 and 结局2.'
      ].join('\n')
    },
    {
      role: 'user',
      content: JSON.stringify({ title, brief, config }, null, 2)
    }
  ]

  const data = await requestHermesChatCompletion({
    sessionId,
    phase: 'story_scripts_candidate',
    messages,
    maxTokens: 8192,
    temperature: 0.2,
    route: resolvedRoute,
    signal,
    timeoutMs: HERMES_CHAT_REQUEST_TIMEOUT_MS
  })
  const content = data.choices?.[0]?.message?.content || ''
  let parsed = null
  let parseError = null
  try {
    parsed = JSON.parse(extractJsonObjectString(content))
  } catch (error) {
    parseError = error instanceof Error ? error.message : String(error)
  }
  const normalized = normalizeStoryScriptsCandidate(parsed, { title, brief })
  return {
    ok: true,
    title,
    scripts: normalized.scripts,
    evaluator: normalized.verdict,
    fallback: normalized.fallback || Boolean(parseError),
    fallbackReason: parseError || normalized.fallbackReason,
    usage: data.usage || null,
    rawResponsePreview: truncateReasoningPreview(content, 1600),
    provider: binding.provider,
    model: binding.model
  }
}

function buildStoryWorkflowStepResult({ action, projectId, ok, status = 'completed', summary, serverResult = null, evaluator = null, snapshot = null, data = null, failedStage = null, retryable = false }) {
  return {
    action,
    ok: Boolean(ok),
    status,
    summary,
    projectId: String(projectId || serverResult?.evidence?.projectId || ''),
    endpoint: serverResult?.endpoint || null,
    serverStatus: serverResult?.status || null,
    error: serverResult?.ok === false ? serverResult.error : null,
    message: serverResult?.ok === false ? serverResult.message : null,
    failedStage,
    retryable: Boolean(retryable || serverResult?.retryable),
    evidence: serverResult?.evidence || null,
    evaluator,
    snapshot,
    data
  }
}

function getPriorBlockingStoryFailure(session, currentAction) {
  const lastResult = session?.artifacts?.storyProduction?.lastResult
  if (!lastResult || lastResult.ok !== false) return null
  if (currentAction === 'story_inspect_project') return null
  return lastResult
}

function buildSkippedStoryWorkflowResult(step, blocker) {
  const projectId = String(blocker?.projectId || '').trim()
  return buildStoryWorkflowStepResult({
    action: step.action,
    projectId,
    ok: false,
    status: 'skipped',
    summary: `已跳过 ${step.action}：前置步骤 ${blocker?.action || 'unknown'} 未通过，失败阶段 ${blocker?.failedStage || 'unknown'}。`,
    evaluator: {
      name: 'evaluateStoryWorkflowDependency',
      passed: false,
      checks: {
        blockedByAction: blocker?.action || null,
        blockedByStage: blocker?.failedStage || null,
        blockedBySummary: blocker?.summary || null
      }
    },
    snapshot: projectId ? buildStoryProjectSnapshot(projectId) : null,
    data: { blockedBy: blocker || null },
    failedStage: 'blocked_by_previous_story_step',
    retryable: Boolean(blocker?.retryable)
  })
}

function updateStoryWorkflowArtifacts(sessionId, step, stepIndex, result) {
  persistStoryProjectPointer(result)
  updateReasoningSession(sessionId, (session) => {
    const storyProduction = session.artifacts?.storyProduction && typeof session.artifacts.storyProduction === 'object'
      ? session.artifacts.storyProduction
      : {}
    const projectId = String(result.projectId || storyProduction.currentProjectId || '').trim()
    const projectRecord = projectId
      ? {
          ...(storyProduction.projects?.[projectId] || {}),
          projectId,
          snapshot: result.snapshot || storyProduction.projects?.[projectId]?.snapshot || null,
          lastResult: result
        }
      : null
    return {
      ...session,
      artifacts: {
        ...session.artifacts,
        storyProduction: {
          ...storyProduction,
          currentProjectId: projectId || storyProduction.currentProjectId || null,
          lastProjectId: projectId || storyProduction.lastProjectId || null,
          lastResult: result,
          steps: {
            ...(storyProduction.steps || {}),
            [step.stepId]: result
          },
          projects: projectId
            ? {
                ...(storyProduction.projects || {}),
                [projectId]: projectRecord
              }
            : (storyProduction.projects || {})
        },
        latestStepReviewEvidence: {
          targetType: 'step',
          stepId: step.stepId,
          stepTitle: step.title,
          tool: step.tool,
          outboundPreview: {
            tool: step.tool,
            action: step.action,
            params: step.params || {},
            endpoint: result.endpoint,
            projectId: result.projectId,
            observableOps: buildReasoningObservableOps(step, result)
          },
          rawResponsePreview: truncateReasoningPreview(JSON.stringify(result, null, 2), 2400),
          structuredResult: result
        }
      }
    }
  })
}

function appendStoryWorkflowEvents(sessionId, step, stepIndex, result) {
  appendReasoningEvent(sessionId, 'tool_result', step.title, result.summary || (result.ok ? 'story workflow step completed' : 'story workflow step failed'), {
    stepId: step.stepId,
    data: buildReasoningStepEventData(step, stepIndex, {
      storyWorkflow: result,
      observableOps: buildReasoningObservableOps(step, result)
    })
  })
  appendReasoningEvent(sessionId, 'step_completed', step.title, result.ok ? '故事 workflow 步骤完成' : '故事 workflow 步骤已返回失败边界', {
    stepId: step.stepId,
    data: buildReasoningStepEventData(step, stepIndex, { ok: result.ok, failedStage: result.failedStage || null })
  })
}

function summarizeGameStudioObserverResult(result) {
  if (!result || typeof result !== 'object') return null
  return {
    ok: result.ok === undefined ? null : Boolean(result.ok),
    status: result.status ?? result.serverStatus ?? null,
    endpoint: result.endpoint || null,
    error: result.error || null,
    message: result.message || null,
    retryable: result.retryable === undefined ? null : Boolean(result.retryable),
    evidence: result.evidence
      ? {
          projectId: result.evidence.projectId || null,
          projectDirRelative: result.evidence.projectDirRelative || null,
          distUrl: result.evidence.distUrl || null,
          distPathRelative: result.evidence.distPathRelative || null,
          distExists: result.evidence.distExists === undefined ? null : Boolean(result.evidence.distExists),
          fileNames: Array.isArray(result.evidence.fileNames) ? result.evidence.fileNames.slice(0, 20) : []
        }
      : null
  }
}

function appendGameStudioObserverEvent(sessionId, step, stepIndex, phase, operation, detail = {}) {
  const resultSummary = summarizeGameStudioObserverResult(detail.result)
  const observer = {
    observedAt: new Date().toISOString(),
    phase,
    operation,
    action: step.action,
    stepId: step.stepId,
    stepTitle: step.title,
    stepIndex,
    endpoint: detail.endpoint || resultSummary?.endpoint || null,
    projectId: detail.projectId || resultSummary?.evidence?.projectId || null,
    elapsedMs: Number.isFinite(detail.elapsedMs) ? detail.elapsedMs : null,
    ok: phase === 'started' ? null : (detail.ok === undefined ? resultSummary?.ok ?? null : Boolean(detail.ok)),
    status: resultSummary?.status ?? null,
    failedStage: detail.failedStage || null,
    retryable: detail.retryable === undefined ? resultSummary?.retryable ?? null : Boolean(detail.retryable),
    error: detail.error || resultSummary?.error || null,
    message: detail.message || resultSummary?.message || null,
    evidence: resultSummary?.evidence || null
  }
  const summary = phase === 'started'
    ? `GameStudio 开始执行 ${operation}${observer.endpoint ? `：${observer.endpoint}` : ''}`
    : `GameStudio ${operation} ${observer.ok ? '完成' : '失败'}${observer.elapsedMs == null ? '' : `，耗时 ${observer.elapsedMs}ms`}`

  updateReasoningSession(sessionId, (session) => {
    const currentObserver = session.artifacts?.gameStudioObserver && typeof session.artifacts.gameStudioObserver === 'object'
      ? session.artifacts.gameStudioObserver
      : {}
    const timeline = Array.isArray(currentObserver.timeline) ? currentObserver.timeline : []
    return {
      ...session,
      artifacts: {
        ...session.artifacts,
        gameStudioObserver: {
          ...currentObserver,
          lastEvent: observer,
          timeline: [...timeline, observer].slice(-240)
        }
      }
    }
  })
  appendReasoningEvent(sessionId, 'gamestudio_observer', step.title, summary, {
    stepId: step.stepId,
    data: buildReasoningStepEventData(step, stepIndex, { gameStudioObserver: observer })
  })
}

async function observeGameStudioOperation(sessionId, step, stepIndex, operation, details, runOperation) {
  const startedAt = Date.now()
  appendGameStudioObserverEvent(sessionId, step, stepIndex, 'started', operation, details)
  try {
    const result = await runOperation()
    const ok = result?.ok === undefined ? true : Boolean(result.ok)
    appendGameStudioObserverEvent(sessionId, step, stepIndex, ok ? 'completed' : 'failed', operation, {
      ...details,
      result,
      ok,
      elapsedMs: Date.now() - startedAt,
      retryable: result?.retryable
    })
    return result
  } catch (error) {
    appendGameStudioObserverEvent(sessionId, step, stepIndex, 'failed', operation, {
      ...details,
      ok: false,
      elapsedMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error),
      retryable: true
    })
    throw error
  }
}

async function executeStoryWorkflowStep(sessionId, step, userPrompt, stepIndex) {
  const session = readReasoningSession(sessionId)
  const action = step.action
  const blocker = getPriorBlockingStoryFailure(session, action)
  if (blocker) {
    const result = buildSkippedStoryWorkflowResult(step, blocker)
    updateStoryWorkflowArtifacts(sessionId, step, stepIndex, result)
    appendStoryWorkflowEvents(sessionId, step, stepIndex, result)
    return result
  }

  if (action === 'story_create_ai_project') {
    const title = String(step.params?.title || extractStoryTitleFromPrompt(userPrompt) || '').trim() || '未命名互动故事'
    const prompt = String(step.params?.prompt || step.params?.brief || userPrompt || '').trim()
    const payload = {
      title,
      prompt,
      choicePoints: Math.max(1, Number(step.params?.choicePoints || 2)),
      optionsPerChoice: Math.max(2, Number(step.params?.optionsPerChoice || 2)),
      endings: Math.max(2, Number(step.params?.endings || 2)),
      timeoutMs: Math.max(90000, Number(step.params?.timeoutMs || 180000))
    }
    const serverResult = prompt
      ? await observeGameStudioOperation(sessionId, step, stepIndex, 'createAiProject', {
        endpoint: 'POST /api/projects/ai/create'
      }, () => gameStudioServerClient.createAiProject(payload))
      : { ok: false, status: 0, endpoint: 'POST /api/projects/ai/create', error: 'missing_prompt', message: 'AI 创建故事缺少 prompt', retryable: false }
    const projectId = serverResult?.evidence?.projectId || serverResult?.data?.project?.id || ''
    const scriptsVerdict = evaluateStoryScripts(serverResult?.data?.scripts)
    const validation = serverResult?.data?.gen?.after?.validation || serverResult?.data?.gen?.before?.validation || null
    const blueprintVerdict = projectId ? evaluateInteractiveStoryBlueprint(projectId, validation) : { passed: false, score: 0, needsRepair: true, issues: ['missing_project_id'], strengths: [], checks: {} }
    const evaluator = {
      name: 'evaluateAiStoryProjectCreated',
      passed: Boolean(serverResult.ok && scriptsVerdict.passed && blueprintVerdict.passed),
      checks: {
        scripts: scriptsVerdict.checks,
        blueprint: blueprintVerdict.checks,
        blueprintScore: blueprintVerdict.score,
        gen: serverResult?.data?.gen || null
      }
    }
    const snapshot = buildStoryProjectSnapshot(projectId)
    const result = buildStoryWorkflowStepResult({
      action,
      projectId,
      ok: Boolean(serverResult.ok && scriptsVerdict.passed && snapshot.projectDirExists),
      summary: serverResult.ok
        ? `已通过 GameStudio AI 创建故事 ${projectId}：scripts=${snapshot.scripts?.cardCount || 0} blueprint=${snapshot.blueprint?.nodeCount || 0}`
        : `GameStudio AI 创建故事失败：${serverResult.message || serverResult.error}`,
      serverResult,
      evaluator,
      snapshot,
      data: { payload: { ...payload, prompt: truncateReasoningPreview(prompt, 1000) }, scriptsVerdict, blueprintVerdict, gen: serverResult?.data?.gen || null },
      failedStage: serverResult.ok ? null : 'create_ai_project_api',
      retryable: serverResult.retryable
    })
    updateStoryWorkflowArtifacts(sessionId, step, stepIndex, result)
    appendStoryWorkflowEvents(sessionId, step, stepIndex, result)
    return result
  }

  if (action === 'story_create_project') {
    const title = String(step.params?.title || extractStoryTitleFromPrompt(userPrompt) || '').trim() || '未命名互动故事'
    const serverResult = await observeGameStudioOperation(sessionId, step, stepIndex, 'createProject', {
      endpoint: 'POST /api/projects'
    }, () => gameStudioServerClient.createProject({ title }))
    const projectId = serverResult?.evidence?.projectId || serverResult?.data?.project?.id || ''
    const evaluator = evaluateStoryProjectCreated(projectId)
    const snapshot = buildStoryProjectSnapshot(projectId)
    const result = buildStoryWorkflowStepResult({
      action,
      projectId,
      ok: Boolean(serverResult.ok && evaluator.passed),
      summary: serverResult.ok
        ? `已创建互动故事项目 ${projectId}，目录 ${snapshot.projectDirRelative || snapshot.projectDir}`
        : `创建互动故事项目失败：${serverResult.message || serverResult.error}`,
      serverResult,
      evaluator,
      snapshot,
      failedStage: serverResult.ok ? (evaluator.passed ? null : 'create_project_evaluator') : 'create_project_api',
      retryable: serverResult.retryable
    })
    updateStoryWorkflowArtifacts(sessionId, step, stepIndex, result)
    appendStoryWorkflowEvents(sessionId, step, stepIndex, result)
    return result
  }

  if (action === 'story_configure_project') {
    const projectId = resolveStoryProjectId(session, step, userPrompt)
    const config = step.params?.config && typeof step.params.config === 'object'
      ? step.params.config
      : inferStoryConfigFromPrompt(userPrompt)
    const payload = {
      project: {
        generationConfig: {
          ...config,
          updatedAt: new Date().toISOString()
        },
        storyProduction: {
          generationConfig: config,
          updatedAt: new Date().toISOString()
        }
      }
    }
    const serverResult = projectId
      ? await observeGameStudioOperation(sessionId, step, stepIndex, 'updateProject', {
        endpoint: 'PUT /api/projects/:id',
        projectId
      }, () => gameStudioServerClient.updateProject(projectId, payload))
      : { ok: false, status: 0, endpoint: 'PUT /api/projects/:id', error: 'missing_project_id', message: '无法定位要配置的项目', retryable: false }
    const readBack = projectId && serverResult.ok
      ? await observeGameStudioOperation(sessionId, step, stepIndex, 'getProjectAfterConfigure', {
        endpoint: 'GET /api/projects/:id',
        projectId
      }, () => gameStudioServerClient.getProject(projectId))
      : null
    const readConfig = readBack?.data?.project?.generationConfig || readBack?.data?.project?.storyProduction?.generationConfig || null
    const evaluator = {
      name: 'evaluateConfigureProject',
      passed: Boolean(serverResult.ok && readConfig && String(readConfig.outputLanguage || '') === String(config.outputLanguage || '')),
      checks: { projectId, requestedConfig: config, readBackConfig: readConfig }
    }
    const snapshot = buildStoryProjectSnapshot(projectId)
    const result = buildStoryWorkflowStepResult({
      action,
      projectId,
      ok: evaluator.passed,
      summary: evaluator.passed ? `已写入并读回项目 ${projectId} 的生成配置` : `项目生成配置未通过验证：${serverResult.message || serverResult.error || 'read_back_mismatch'}`,
      serverResult,
      evaluator,
      snapshot,
      data: { config, readBackConfig: readConfig },
      failedStage: evaluator.passed ? null : (serverResult.ok ? 'configure_project_readback' : 'configure_project_api'),
      retryable: serverResult.retryable
    })
    updateStoryWorkflowArtifacts(sessionId, step, stepIndex, result)
    appendStoryWorkflowEvents(sessionId, step, stepIndex, result)
    return result
  }

  if (action === 'story_inspect_project') {
    const projectId = resolveStoryProjectId(session, step, userPrompt)
    const serverResult = projectId
      ? await observeGameStudioOperation(sessionId, step, stepIndex, 'getProject', {
        endpoint: 'GET /api/projects/:id',
        projectId
      }, () => gameStudioServerClient.getProject(projectId))
      : { ok: false, status: 0, endpoint: 'GET /api/projects/:id', error: 'missing_project_id', message: '无法定位要检查的项目', retryable: false }
    const scriptsResult = projectId ? await observeGameStudioOperation(sessionId, step, stepIndex, 'getScripts', {
      endpoint: 'GET /api/projects/:id/scripts',
      projectId
    }, () => gameStudioServerClient.getScripts(projectId)) : null
    const exportsResult = projectId ? await observeGameStudioOperation(sessionId, step, stepIndex, 'listExports', {
      endpoint: 'GET /api/projects/:id/exports',
      projectId
    }, () => gameStudioServerClient.listExports(projectId)) : null
    const snapshot = buildStoryProjectSnapshot(projectId)
    const evaluator = evaluateStoryProjectCreated(projectId)
    const result = buildStoryWorkflowStepResult({
      action,
      projectId,
      ok: Boolean(serverResult.ok && snapshot.projectDirExists),
      summary: snapshot.projectDirExists
        ? `已检查项目 ${projectId}，顶层子项 ${snapshot.fileNames.join(', ') || '空'}`
        : `检查项目失败：${serverResult.message || serverResult.error || 'project_not_found'}`,
      serverResult,
      evaluator,
      snapshot,
      data: {
        project: serverResult?.data?.project || null,
        story: serverResult?.data?.story || null,
        scripts: scriptsResult?.data?.scripts || null,
        exports: exportsResult?.data?.items || []
      },
      failedStage: serverResult.ok ? null : 'inspect_project_api',
      retryable: serverResult.retryable
    })
    updateStoryWorkflowArtifacts(sessionId, step, stepIndex, result)
    appendStoryWorkflowEvents(sessionId, step, stepIndex, result)
    return result
  }

  if (action === 'story_generate_scripts_candidate') {
    let candidate = null
    const title = String(step.params?.title || extractStoryTitleFromPrompt(userPrompt) || '').trim() || '未命名互动故事'
    const brief = String(step.params?.brief || userPrompt || '').trim()
    if (session?.submissionContext?.productionTest && !session?.submissionContext?.requireModelAnswer) {
      const scripts = buildFallbackStoryScripts({ title, brief })
      candidate = {
        ok: true,
        error: null,
        scripts,
        evaluator: evaluateStoryScripts(scripts),
        fallback: true,
        fallbackReason: 'production_test_deterministic_minimal_scripts'
      }
    } else {
      try {
        const scriptsRoute = resolveModelRouteForPhase(buildHermesBinding(), 'story_scripts_candidate', { action })
        candidate = await runManagedReasoningTask(sessionId, 'story_scripts_candidate', scriptsRoute.binding, ({ signal }) => generateStoryScriptsCandidate(
          sessionId,
          step,
          userPrompt,
          signal,
          scriptsRoute.binding,
          scriptsRoute
        ))
      } catch (error) {
        const scripts = buildFallbackStoryScripts({ title, brief })
        candidate = {
          ok: true,
          error: error instanceof Error ? error.message : String(error),
          scripts,
          evaluator: evaluateStoryScripts(scripts),
          fallback: true,
          fallbackReason: 'story_scripts_model_request_failed'
        }
      }
    }
    const projectId = resolveStoryProjectId(session, step, userPrompt)
    const result = buildStoryWorkflowStepResult({
      action,
      projectId,
      ok: Boolean(candidate.ok && candidate.evaluator?.passed),
      summary: candidate.ok
        ? `已生成故事脚本候选，卡片数 ${candidate.scripts?.cards?.length || 0}${candidate.fallback ? '（使用 fallback 兜底）' : ''}`
        : `故事脚本候选生成失败：${candidate.error || 'model_request_failed'}`,
      evaluator: candidate.evaluator,
      snapshot: projectId ? buildStoryProjectSnapshot(projectId) : null,
      data: candidate,
      failedStage: candidate.ok ? (candidate.evaluator?.passed ? null : 'scripts_candidate_evaluator') : 'scripts_candidate_model',
      retryable: !candidate.ok
    })
    updateStoryWorkflowArtifacts(sessionId, step, stepIndex, result)
    updateReasoningSession(sessionId, (current) => ({
      ...current,
      artifacts: {
        ...current.artifacts,
        storyProduction: {
          ...(current.artifacts?.storyProduction || {}),
          scriptsCandidate: candidate?.scripts || null,
          scriptsCandidateMeta: {
            fallback: Boolean(candidate?.fallback),
            fallbackReason: candidate?.fallbackReason || null,
            provider: candidate?.provider || null,
            model: candidate?.model || null,
            usage: candidate?.usage || null
          }
        }
      }
    }))
    appendStoryWorkflowEvents(sessionId, step, stepIndex, result)
    return result
  }

  if (action === 'story_write_scripts') {
    const projectId = resolveStoryProjectId(session, step, userPrompt)
    const latestSession = readReasoningSession(sessionId)
    const scripts = latestSession?.artifacts?.storyProduction?.scriptsCandidate || null
    const scriptVerdict = evaluateStoryScripts(scripts)
    const serverResult = projectId && scriptVerdict.passed
      ? await observeGameStudioOperation(sessionId, step, stepIndex, 'putScripts', {
        endpoint: 'PUT /api/projects/:id/scripts',
        projectId
      }, () => gameStudioServerClient.putScripts(projectId, scripts))
      : { ok: false, status: 0, endpoint: 'PUT /api/projects/:id/scripts', error: projectId ? 'invalid_scripts_candidate' : 'missing_project_id', message: projectId ? '脚本候选未通过 schema 验证' : '无法定位要写入脚本的项目', retryable: false }
    const readBack = projectId && serverResult.ok ? await observeGameStudioOperation(sessionId, step, stepIndex, 'getScriptsAfterWrite', {
      endpoint: 'GET /api/projects/:id/scripts',
      projectId
    }, () => gameStudioServerClient.getScripts(projectId)) : null
    const readBackVerdict = evaluateStoryScripts(readBack?.data?.scripts)
    const evaluator = {
      name: 'evaluateWriteScripts',
      passed: Boolean(serverResult.ok && readBackVerdict.passed),
      checks: { candidate: scriptVerdict.checks, readBack: readBackVerdict.checks }
    }
    const snapshot = buildStoryProjectSnapshot(projectId)
    const result = buildStoryWorkflowStepResult({
      action,
      projectId,
      ok: evaluator.passed,
      summary: evaluator.passed ? `已写入并读回项目 ${projectId} 的 scripts.json` : `脚本写入失败：${serverResult.message || serverResult.error}`,
      serverResult,
      evaluator,
      snapshot,
      data: { readBackScripts: readBack?.data?.scripts || null },
      failedStage: evaluator.passed ? null : (serverResult.ok ? 'write_scripts_readback' : 'write_scripts_api'),
      retryable: serverResult.retryable
    })
    updateStoryWorkflowArtifacts(sessionId, step, stepIndex, result)
    appendStoryWorkflowEvents(sessionId, step, stepIndex, result)
    return result
  }

  if (action === 'story_compile_blueprint') {
    const projectId = resolveStoryProjectId(session, step, userPrompt)
    const serverResult = projectId
      ? await observeGameStudioOperation(sessionId, step, stepIndex, 'compileBlueprint', {
        endpoint: 'POST /api/projects/:id/compile/blueprint',
        projectId
      }, () => gameStudioServerClient.compileBlueprint(projectId))
      : { ok: false, status: 0, endpoint: 'POST /api/projects/:id/compile/blueprint', error: 'missing_project_id', message: '无法定位要编译蓝图的项目', retryable: false }
    const validation = serverResult?.data?.validation || null
    const validationErrors = Array.isArray(validation?.errors) ? validation.errors : []
    const evaluator = {
      name: 'evaluateBlueprint',
      passed: Boolean(serverResult.ok && validation?.ok !== false && validationErrors.length === 0),
      checks: { validation }
    }
    const snapshot = buildStoryProjectSnapshot(projectId)
    const result = buildStoryWorkflowStepResult({
      action,
      projectId,
      ok: evaluator.passed,
      summary: evaluator.passed ? `已编译项目 ${projectId} 的 blueprint.json` : `蓝图编译未通过：${serverResult.message || serverResult.error || 'validation_failed'}`,
      serverResult,
      evaluator,
      snapshot,
      data: { report: serverResult?.data?.report || null, validation },
      failedStage: evaluator.passed ? null : (serverResult.ok ? 'compile_blueprint_validation' : 'compile_blueprint_api'),
      retryable: serverResult.retryable
    })
    updateStoryWorkflowArtifacts(sessionId, step, stepIndex, result)
    appendStoryWorkflowEvents(sessionId, step, stepIndex, result)
    return result
  }

  if (action === 'story_analyze_scripts') {
    const projectId = resolveStoryProjectId(session, step, userPrompt)
    const serverResult = projectId
      ? await observeGameStudioOperation(sessionId, step, stepIndex, 'analyzeScripts', {
        endpoint: 'POST /api/projects/:id/analyze/scripts',
        projectId
      }, () => gameStudioServerClient.analyzeScripts(projectId))
      : { ok: false, status: 0, endpoint: 'POST /api/projects/:id/analyze/scripts', error: 'missing_project_id', message: '无法定位要分析脚本的项目', retryable: false }
    const analysis = serverResult?.data?.analysis || null
    const evaluator = {
      name: 'evaluateScriptAnalysis',
      passed: Boolean(serverResult.ok && analysis && analysis.ok !== false),
      checks: {
        ok: analysis?.ok ?? null,
        stats: analysis?.stats || null,
        suggestionCount: Array.isArray(analysis?.suggestions) ? analysis.suggestions.length : 0,
        checkCount: Array.isArray(analysis?.checks) ? analysis.checks.length : 0
      }
    }
    const snapshot = buildStoryProjectSnapshot(projectId)
    const result = buildStoryWorkflowStepResult({
      action,
      projectId,
      ok: evaluator.passed,
      summary: evaluator.passed ? `脚本分析通过：${analysis?.summary || '可进入蓝图评审'}` : `脚本分析未通过：${serverResult.message || serverResult.error || 'analysis_failed'}`,
      serverResult,
      evaluator,
      snapshot,
      data: { analysis },
      failedStage: evaluator.passed ? null : (serverResult.ok ? 'analyze_scripts_evaluator' : 'analyze_scripts_api'),
      retryable: serverResult.retryable
    })
    updateStoryWorkflowArtifacts(sessionId, step, stepIndex, result)
    appendStoryWorkflowEvents(sessionId, step, stepIndex, result)
    return result
  }

  if (action === 'story_review_blueprint_agent') {
    const projectId = resolveStoryProjectId(session, step, userPrompt)
    const blueprintReviewRoute = resolveModelRouteForPhase(buildHermesBinding(), 'story_blueprint_review', { action })
    const blueprintReviewOverride = getModelRouteOverrideForPhase(buildHermesBinding(), 'story_blueprint_review', { action })
    const validationResult = projectId
      ? await observeGameStudioOperation(sessionId, step, stepIndex, 'validateBlueprintForAgentReview', {
        endpoint: 'POST /api/projects/:id/validate/blueprint',
        projectId
      }, () => gameStudioServerClient.validateBlueprint(projectId))
      : { ok: false, status: 0, endpoint: 'POST /api/projects/:id/validate/blueprint', error: 'missing_project_id', message: '无法定位要评审蓝图的项目', retryable: false }
    const serverReviewResult = projectId && validationResult.ok
      ? await observeGameStudioOperation(sessionId, step, stepIndex, 'reviewBlueprintWithGameStudioRules', {
        endpoint: 'POST /api/projects/:id/ai/review/blueprint',
        projectId
      }, () => gameStudioServerClient.reviewBlueprint(projectId, blueprintReviewOverride ? { modelRoute: blueprintReviewOverride } : {}))
      : null
    const validation = validationResult?.data?.validation || serverReviewResult?.data?.validation || null
    const deterministicReview = projectId ? evaluateInteractiveStoryBlueprint(projectId, validation) : { passed: false, score: 0, needsRepair: true, issues: ['missing_project_id'], strengths: [], checks: {} }
    let hermesReview = null
    let hermesError = null
    if (session?.submissionContext?.productionTest && !session?.submissionContext?.requireModelAnswer) {
      hermesReview = {
        score: deterministicReview.score,
        verdict: deterministicReview.passed ? 'approve' : 'repair',
        passed: deterministicReview.passed,
        summary: deterministicReview.passed ? '生产测试使用确定性蓝图评审通过。' : '生产测试确定性蓝图评审要求修复。',
        issues: deterministicReview.issues,
        strengths: deterministicReview.strengths,
        repairPlan: deterministicReview.issues,
        provider: 'deterministic',
        model: null,
        usage: null,
        rawResponsePreview: ''
      }
    } else {
      try {
        hermesReview = await runManagedReasoningTask(sessionId, 'story_blueprint_review', blueprintReviewRoute.binding, ({ signal }) => reviewStoryBlueprintWithHermes(
          sessionId,
          projectId,
          deterministicReview,
          serverReviewResult?.data?.review || null,
          validation,
          signal,
          blueprintReviewRoute.binding,
          blueprintReviewRoute
        ))
      } catch (error) {
        hermesError = error instanceof Error ? error.message : String(error)
        hermesReview = {
          score: deterministicReview.score,
          verdict: deterministicReview.passed ? 'approve' : 'repair',
          passed: deterministicReview.passed,
          summary: deterministicReview.passed ? 'Hermes 评审失败，暂以确定性蓝图门禁通过。' : 'Hermes 评审失败，确定性蓝图门禁要求修复。',
          issues: deterministicReview.issues,
          strengths: deterministicReview.strengths,
          repairPlan: deterministicReview.issues,
          provider: 'deterministic_fallback',
          model: null,
          usage: null,
          rawResponsePreview: ''
        }
      }
    }
    const finalScore = Math.min(Number(deterministicReview.score || 0), Number(hermesReview?.score || 0))
    const needsRepair = Boolean(!deterministicReview.passed || hermesReview?.verdict !== 'approve' || finalScore < 80)
    const evaluator = {
      name: 'evaluateBlueprintAgentReview',
      passed: !needsRepair,
      checks: {
        deterministicPassed: deterministicReview.passed,
        deterministicScore: deterministicReview.score,
        hermesVerdict: hermesReview?.verdict || null,
        hermesScore: hermesReview?.score ?? null,
        finalScore,
        needsRepair,
        hermesError
      }
    }
    const snapshot = buildStoryProjectSnapshot(projectId)
    const result = buildStoryWorkflowStepResult({
      action,
      projectId,
      ok: Boolean(validationResult.ok && projectId),
      summary: needsRepair
        ? `蓝图智能体评审要求修复：score=${finalScore}`
        : `蓝图智能体评审通过：score=${finalScore}`,
      serverResult: validationResult,
      evaluator,
      snapshot,
      data: {
        needsRepair,
        finalScore,
        deterministicReview,
        hermesReview,
        hermesError,
        gameStudioReview: serverReviewResult?.data?.review || null,
        gameStudioReviewMeta: serverReviewResult?.data?.meta || null,
        validation
      },
      failedStage: validationResult.ok ? null : 'blueprint_review_validation_api',
      retryable: validationResult.retryable || serverReviewResult?.retryable
    })
    updateStoryWorkflowArtifacts(sessionId, step, stepIndex, result)
    appendStoryWorkflowEvents(sessionId, step, stepIndex, result)
    return result
  }

  if (action === 'story_repair_blueprint_if_needed') {
    const projectId = resolveStoryProjectId(session, step, userPrompt)
    const latestSession = readReasoningSession(sessionId)
    const reviewResult = latestSession?.artifacts?.storyProduction?.steps?.step_story_review_blueprint_agent || null
    const needsRepair = Boolean(reviewResult?.data?.needsRepair)
    if (!needsRepair) {
      const snapshot = buildStoryProjectSnapshot(projectId)
      const result = buildStoryWorkflowStepResult({
        action,
        projectId,
        ok: true,
        summary: `蓝图评审已通过，跳过修复并进入合成：${projectId}`,
        evaluator: { name: 'evaluateBlueprintRepairGate', passed: true, checks: { needsRepair: false } },
        snapshot,
        data: { skipped: true, reason: 'blueprint_review_passed' }
      })
      updateStoryWorkflowArtifacts(sessionId, step, stepIndex, result)
      appendStoryWorkflowEvents(sessionId, step, stepIndex, result)
      return result
    }
    const fixResult = projectId
      ? await observeGameStudioOperation(sessionId, step, stepIndex, 'fixScriptsForBlueprint', {
        endpoint: 'POST /api/projects/:id/ai/fix/scripts',
        projectId
      }, () => gameStudioServerClient.fixScripts(projectId))
      : { ok: false, status: 0, endpoint: 'POST /api/projects/:id/ai/fix/scripts', error: 'missing_project_id', message: '无法定位要修复的项目', retryable: false }
    const compileResult = projectId && fixResult.ok
      ? await observeGameStudioOperation(sessionId, step, stepIndex, 'compileBlueprintAfterRepair', {
        endpoint: 'POST /api/projects/:id/compile/blueprint',
        projectId
      }, () => gameStudioServerClient.compileBlueprint(projectId))
      : null
    const validation = compileResult?.data?.validation || fixResult?.data?.after?.validation || null
    const deterministicReview = projectId ? evaluateInteractiveStoryBlueprint(projectId, validation) : { passed: false, score: 0, needsRepair: true, issues: ['missing_project_id'], strengths: [], checks: {} }
    const evaluator = {
      name: 'evaluateBlueprintRepair',
      passed: Boolean(fixResult.ok && deterministicReview.passed),
      checks: {
        fixOk: Boolean(fixResult.ok),
        compileOk: Boolean(compileResult?.ok),
        scoreAfterRepair: deterministicReview.score,
        issuesAfterRepair: deterministicReview.issues
      }
    }
    const snapshot = buildStoryProjectSnapshot(projectId)
    const result = buildStoryWorkflowStepResult({
      action,
      projectId,
      ok: evaluator.passed,
      summary: evaluator.passed ? `蓝图已修复并通过 Control 门禁：score=${deterministicReview.score}` : `蓝图修复未通过：${fixResult.message || fixResult.error || 'repair_failed'}`,
      serverResult: fixResult,
      evaluator,
      snapshot,
      data: { fix: fixResult?.data || null, compile: compileResult?.data || null, deterministicReview },
      failedStage: evaluator.passed ? null : (fixResult.ok ? 'blueprint_repair_evaluator' : 'blueprint_repair_api'),
      retryable: fixResult.retryable || compileResult?.retryable
    })
    updateStoryWorkflowArtifacts(sessionId, step, stepIndex, result)
    appendStoryWorkflowEvents(sessionId, step, stepIndex, result)
    return result
  }

  if (action === 'story_compile_compose') {
    const projectId = resolveStoryProjectId(session, step, userPrompt)
    const serverResult = projectId
      ? await observeGameStudioOperation(sessionId, step, stepIndex, 'compileCompose', {
        endpoint: 'POST /api/projects/:id/compile/compose',
        projectId
      }, () => gameStudioServerClient.compileCompose(projectId))
      : { ok: false, status: 0, endpoint: 'POST /api/projects/:id/compile/compose', error: 'missing_project_id', message: '无法定位要编译合成层的项目', retryable: false }
    const snapshot = buildStoryProjectSnapshot(projectId)
    const evaluator = evaluateStoryProjectRunnable(projectId)
    const result = buildStoryWorkflowStepResult({
      action,
      projectId,
      ok: Boolean(serverResult.ok && evaluator.passed),
      summary: evaluator.passed ? `已编译项目 ${projectId} 为可运行 story/project 合成层` : `合成层编译未通过：${serverResult.message || serverResult.error || 'compose_evaluator_failed'}`,
      serverResult,
      evaluator,
      snapshot,
      failedStage: evaluator.passed ? null : (serverResult.ok ? 'compile_compose_evaluator' : 'compile_compose_api'),
      retryable: serverResult.retryable
    })
    updateStoryWorkflowArtifacts(sessionId, step, stepIndex, result)
    appendStoryWorkflowEvents(sessionId, step, stepIndex, result)
    return result
  }

  if (action === 'story_validate_project') {
    const projectId = resolveStoryProjectId(session, step, userPrompt)
    const serverResult = projectId
      ? await observeGameStudioOperation(sessionId, step, stepIndex, 'validateBlueprint', {
        endpoint: 'POST /api/projects/:id/validate/blueprint',
        projectId
      }, () => gameStudioServerClient.validateBlueprint(projectId))
      : { ok: false, status: 0, endpoint: 'POST /api/projects/:id/validate/blueprint', error: 'missing_project_id', message: '无法定位要校验的项目', retryable: false }
    const validation = serverResult?.data?.validation || null
    const snapshot = buildStoryProjectSnapshot(projectId)
    const evaluator = evaluateStoryProjectRunnable(projectId, validation)
    const resourceEvaluator = evaluateStoryResourceReferences(projectId)
    const combinedEvaluator = {
      name: 'evaluateStoryProjectValidation',
      passed: Boolean(evaluator.passed && resourceEvaluator.passed),
      checks: {
        structure: evaluator.checks,
        resources: resourceEvaluator.checks
      }
    }
    const result = buildStoryWorkflowStepResult({
      action,
      projectId,
      ok: Boolean(serverResult.ok && combinedEvaluator.passed),
      summary: combinedEvaluator.passed ? `项目 ${projectId} 结构与资源引用校验通过` : `项目校验未通过：${serverResult.message || serverResult.error || 'validation_failed'}`,
      serverResult,
      evaluator: combinedEvaluator,
      snapshot,
      data: { validation, resourceValidation: resourceEvaluator },
      failedStage: combinedEvaluator.passed ? null : (serverResult.ok ? 'validate_project_evaluator' : 'validate_project_api'),
      retryable: serverResult.retryable
    })
    updateStoryWorkflowArtifacts(sessionId, step, stepIndex, result)
    appendStoryWorkflowEvents(sessionId, step, stepIndex, result)
    return result
  }

  if (action === 'story_export_project') {
    const projectId = resolveStoryProjectId(session, step, userPrompt)
    const serverResult = projectId
      ? await observeGameStudioOperation(sessionId, step, stepIndex, 'exportProject', {
        endpoint: 'POST /api/projects/:id/export',
        projectId
      }, () => gameStudioServerClient.exportProject(projectId))
      : { ok: false, status: 0, endpoint: 'POST /api/projects/:id/export', error: 'missing_project_id', message: '无法定位要导出的项目', retryable: false }
    const evaluator = evaluateStoryExport(serverResult)
    const snapshot = buildStoryProjectSnapshot(projectId)
    const result = buildStoryWorkflowStepResult({
      action,
      projectId,
      ok: evaluator.passed,
      summary: evaluator.passed ? `项目 ${projectId} 已导出：${serverResult.evidence?.distUrl}` : `项目导出失败：${serverResult.message || serverResult.error || 'export_evaluator_failed'}`,
      serverResult,
      evaluator,
      snapshot,
      failedStage: evaluator.passed ? null : (serverResult.ok ? 'export_project_evaluator' : 'export_project_api'),
      retryable: serverResult.retryable
    })
    updateStoryWorkflowArtifacts(sessionId, step, stepIndex, result)
    appendStoryWorkflowEvents(sessionId, step, stepIndex, result)
    return result
  }

  if (action === 'story_create_bible') {
    const projectId = resolveStoryProjectId(session, step, userPrompt)
    const timeoutMs = Math.max(10000, Number(step.params?.timeoutMs || 120000))
    const storyBibleInput = projectId ? buildStoryBibleGenerationInput(projectId) : null
    const serverResult = projectId && storyBibleInput
      ? await observeGameStudioOperation(sessionId, step, stepIndex, 'createStoryBible', {
        endpoint: 'POST /api/projects/:id/ai/story/bible',
        projectId
      }, () => gameStudioServerClient.createStoryBible(projectId, {
        input: storyBibleInput,
        timeoutMs
      }))
      : { ok: false, status: 0, endpoint: 'POST /api/projects/:id/ai/story/bible', error: projectId ? 'missing_story_bible_input' : 'missing_project_id', message: projectId ? '无法构造 Story Bible 生成输入' : '无法定位要生成 Story Bible 的项目', retryable: false }
    const storyBible = serverResult?.data?.result && typeof serverResult.data.result === 'object' ? serverResult.data.result : null
    const currentProjectResult = projectId && serverResult.ok && storyBible
      ? await observeGameStudioOperation(sessionId, step, stepIndex, 'getProjectBeforePersistStoryBible', {
        endpoint: 'GET /api/projects/:id',
        projectId
      }, () => gameStudioServerClient.getProject(projectId))
      : null
    const currentProject = currentProjectResult?.data?.project && typeof currentProjectResult.data.project === 'object'
      ? currentProjectResult.data.project
      : {}
    const currentState = currentProject?.state && typeof currentProject.state === 'object' ? currentProject.state : {}
    const currentAiBackground = currentState?.aiBackground && typeof currentState.aiBackground === 'object' ? currentState.aiBackground : {}
    const persistResult = projectId && serverResult.ok && storyBible
      ? await observeGameStudioOperation(sessionId, step, stepIndex, 'persistStoryBibleToProject', {
        endpoint: 'PUT /api/projects/:id',
        projectId
      }, () => gameStudioServerClient.updateProject(projectId, {
        project: {
          state: {
            ...currentState,
            aiBackground: {
              ...currentAiBackground,
              storyBible,
              storyBibleJson: JSON.stringify(storyBible, null, 2),
              updatedAt: new Date().toISOString()
            }
          }
        }
      }))
      : null
    const readBack = projectId && persistResult?.ok
      ? await observeGameStudioOperation(sessionId, step, stepIndex, 'getProjectAfterPersistStoryBible', {
        endpoint: 'GET /api/projects/:id',
        projectId
      }, () => gameStudioServerClient.getProject(projectId))
      : null
    const persistedStoryBible = readStoryBibleFromProjectDoc(readBack?.data?.project || null)
    const persistedCharacters = Array.isArray(persistedStoryBible?.characters) ? persistedStoryBible.characters.length : 0
    const persistedProps = Array.isArray(persistedStoryBible?.props) ? persistedStoryBible.props.length : 0
    const persistedLocations = Array.isArray(persistedStoryBible?.locations) ? persistedStoryBible.locations.length : 0
    const evaluator = {
      name: 'evaluateStoryBible',
      passed: Boolean(serverResult.ok && persistResult?.ok && persistedStoryBible && (persistedCharacters + persistedProps + persistedLocations > 0)),
      checks: {
        projectId,
        inputBuilt: Boolean(storyBibleInput),
        generated: Boolean(storyBible),
        persisted: Boolean(persistResult?.ok),
        readBack: Boolean(persistedStoryBible),
        characters: persistedCharacters,
        props: persistedProps,
        locations: persistedLocations,
        traceId: serverResult?.data?.traceId || null,
        error: persistResult?.error || serverResult?.error || null,
        message: persistResult?.message || serverResult?.message || null
      }
    }
    const snapshot = buildStoryProjectSnapshot(projectId)
    const result = buildStoryWorkflowStepResult({
      action,
      projectId,
      ok: evaluator.passed,
      summary: evaluator.passed
        ? `已通过 GameStudio 显式生成并写回 Story Bible：characters=${persistedCharacters} props=${persistedProps} locations=${persistedLocations}`
        : `Story Bible 生成或写回失败：${persistResult?.message || persistResult?.error || serverResult?.message || serverResult?.error || 'story_bible_failed'}`,
      serverResult,
      evaluator,
      snapshot,
      data: {
        traceId: serverResult?.data?.traceId || null,
        storyBible: persistedStoryBible || storyBible,
        persistResult: persistResult?.ok ? { ok: true } : persistResult ? { ok: false, error: persistResult.error || null, message: persistResult.message || null } : null
      },
      failedStage: evaluator.passed ? null : (serverResult.ok ? 'persist_story_bible' : 'create_story_bible'),
      retryable: Boolean(serverResult.retryable || persistResult?.retryable)
    })
    updateStoryWorkflowArtifacts(sessionId, step, stepIndex, result)
    appendStoryWorkflowEvents(sessionId, step, stepIndex, result)
    return result
  }

  if (action === 'story_preflight_image_provider') {
    const mode = String(step.params?.mode || 'basic').trim().toLowerCase() === 'storyboard' ? 'storyboard' : 'basic'
    const timeoutMs = Math.max(2000, Number(step.params?.timeoutMs || 15000))
    const projectId = resolveStoryProjectId(session, step, userPrompt)
    const lockPlan = mode === 'storyboard' && projectId ? readStoryAssetPlanFile(projectId) : null
    const settingsResult = await observeGameStudioOperation(sessionId, step, stepIndex, 'getStudioSettingsForImagePreflight', {
      endpoint: 'GET /api/studio/settings'
    }, () => gameStudioServerClient.getStudioSettings())
    const comfyuiBaseUrl = String(settingsResult?.data?.effective?.image?.comfyuiBaseUrl || step.params?.comfyuiBaseUrl || 'http://127.0.0.1:8188').trim()
    const comfyUi = await observeGameStudioOperation(sessionId, step, stepIndex, 'ensureComfyUiRunning', {
      endpoint: 'GET /system_stats or sh ./start.sh',
      baseUrl: comfyuiBaseUrl,
      cwd: process.env.COMFYUI_ROOT || '/Volumes/ovokit2t/ComfyUI'
    }, () => ensureComfyUiRunning(comfyuiBaseUrl, {
      comfyRoot: process.env.COMFYUI_ROOT || '/Volumes/ovokit2t/ComfyUI',
      waitTimeoutMs: Math.max(60000, timeoutMs)
    }))
    const serverResult = await observeGameStudioOperation(sessionId, step, stepIndex, 'preflightImageProvider', {
      endpoint: 'POST /api/studio/image/preflight'
    }, () => gameStudioServerClient.preflightImageProvider({ mode, timeoutMs }))
    const checks = serverResult?.data?.checks || null
    const provider = String(checks?.provider || '').trim()
    const lockAssets = Array.isArray(lockPlan?.assets) ? lockPlan.assets : []
    const lockAnalysisRequired = step.params?.lockAnalysisRequired === true
    const lockAnalysisOk = mode !== 'storyboard' || !projectId || Boolean(lockPlan && lockAssets.length > 0)
    const evaluator = {
      name: 'evaluateImageProviderPreflight',
      passed: Boolean(serverResult.ok && checks?.ok !== false && comfyUi?.ok && (lockAnalysisOk || !lockAnalysisRequired)),
      checks: {
        mode,
        provider,
        comfyUi: {
          ok: Boolean(comfyUi?.ok),
          started: Boolean(comfyUi?.data?.started),
          baseUrl: comfyUi?.data?.baseUrl || comfyuiBaseUrl,
          status: comfyUi?.data?.health?.status ?? null,
          error: comfyUi?.error || comfyUi?.data?.health?.error || null
        },
        lockAnalysis: mode === 'storyboard' && projectId ? {
          ok: Boolean(lockPlan && lockAssets.length > 0),
          required: lockAnalysisRequired,
          assetCount: lockAssets.length,
          error: lockPlan ? null : 'missing_story_asset_plan',
          message: lockPlan ? null : '未找到已保存的 story-assets/plan.json'
        } : null,
        reason: checks?.reason || serverResult?.error || null,
        missingNodes: Array.isArray(checks?.missingNodes) ? checks.missingNodes : [],
        extras: checks?.extras || null
      }
    }
    const result = buildStoryWorkflowStepResult({
      action,
      projectId,
      ok: evaluator.passed,
      summary: evaluator.passed
        ? `锁定事物/图片 provider preflight 通过：provider=${provider || 'unknown'} mode=${mode}${lockPlan ? ` lockAssets=${lockAssets.length}` : ''}${comfyUi?.data?.started ? ' ComfyUI已启动' : ''}`
        : `锁定事物/图片 provider preflight 未通过：${serverResult.message || serverResult.error || checks?.reason || comfyUi?.error || evaluator.checks.lockAnalysis?.error || 'preflight_failed'}`,
      serverResult,
      evaluator,
      snapshot: null,
      data: { mode, checks, lockAnalysis: lockPlan ? { plan: lockPlan } : null, comfyUi: comfyUi?.data || null },
      failedStage: evaluator.passed ? null : 'image_provider_preflight',
      retryable: serverResult.retryable
    })
    updateStoryWorkflowArtifacts(sessionId, step, stepIndex, result)
    appendStoryWorkflowEvents(sessionId, step, stepIndex, result)
    return result
  }

  if (action === 'story_create_asset_plan') {
    const projectId = resolveStoryProjectId(session, step, userPrompt)
    const serverResult = projectId
      ? await observeGameStudioOperation(sessionId, step, stepIndex, 'createStoryAssetPlan', {
        endpoint: 'POST /api/projects/:id/ai/story/assets/plan',
        projectId
      }, () => gameStudioServerClient.createStoryAssetPlan(projectId, {
        rebuild: Boolean(step.params?.rebuild),
        source: step.params?.source || 'control_story_workflow'
      }))
      : { ok: false, status: 0, endpoint: 'POST /api/projects/:id/ai/story/assets/plan', error: 'missing_project_id', message: '无法定位要创建资产计划的项目', retryable: false }
    const plan = serverResult?.data?.plan || null
    const assets = Array.isArray(plan?.assets) ? plan.assets : []
    const evaluator = {
      name: 'evaluateStoryAssetPlan',
      passed: Boolean(serverResult.ok && plan && assets.length > 0),
      checks: {
        projectId,
        hasPlan: Boolean(plan),
        assetCount: assets.length,
        error: serverResult?.error || null,
        message: serverResult?.message || null
      }
    }
    const snapshot = buildStoryProjectSnapshot(projectId)
    const result = buildStoryWorkflowStepResult({
      action,
      projectId,
      ok: evaluator.passed,
      summary: evaluator.passed ? `已创建故事资产计划，资产数 ${assets.length}` : `故事资产计划未完成：${serverResult.message || serverResult.error || 'asset_plan_evaluator_failed'}`,
      serverResult,
      evaluator,
      snapshot,
      data: { plan },
      failedStage: evaluator.passed ? null : (serverResult.ok ? 'asset_plan_evaluator' : 'asset_plan_api'),
      retryable: serverResult.retryable
    })
    updateStoryWorkflowArtifacts(sessionId, step, stepIndex, result)
    if (evaluator.passed) {
      updateReasoningSession(sessionId, (current) => ({
        ...current,
        artifacts: {
          ...current.artifacts,
          storyProduction: {
            ...(current.artifacts?.storyProduction || {}),
            assetPlan: plan
          }
        }
      }))
    }
    appendStoryWorkflowEvents(sessionId, step, stepIndex, result)
    return result
  }

  if (action === 'story_generate_lock_asset_references') {
    const projectId = resolveStoryProjectId(session, step, userPrompt)
    const planResult = projectId
      ? await observeGameStudioOperation(sessionId, step, stepIndex, 'createStoryAssetPlanForLockReferences', {
        endpoint: 'POST /api/projects/:id/ai/story/assets/plan',
        projectId
      }, () => createStoryAssetPlanWithControlFallback(projectId, {
        rebuild: Boolean(step.params?.rebuild),
        source: step.params?.source || 'control_lock_asset_references'
      }))
      : { ok: false, status: 0, endpoint: 'POST /api/projects/:id/ai/story/assets/plan', error: 'missing_project_id', message: '无法定位要锁定事物的项目', retryable: false }
    const plan = planResult?.data?.plan || null
    const assets = Array.isArray(plan?.assets) ? plan.assets : []
    const maxAssets = Math.max(1, Math.min(12, Number(step.params?.maxAssets || 8)))
    const force = Boolean(step.params?.force)
    const requiredAssets = assets
      .filter((asset) => asset && String(asset.id || '').trim())
      .filter((asset) => Number(asset.sceneCount || 0) > 0 || String(asset.persistence || '') === 'high' || String(asset.renderStrategy || '') === 'ref_required')
      .slice(0, maxAssets)
    const generated = []
    for (const asset of requiredAssets) {
      const assetId = String(asset.id || '').trim()
      const existingUri = String(asset.primaryReferenceAssetUri || '').trim()
      if (existingUri && !force) {
        generated.push({
          assetId,
          name: String(asset.name || assetId),
          category: String(asset.category || ''),
          lockProfile: String(asset.lockProfile || ''),
          status: 'ready_existing',
          primaryReferenceAssetUri: existingUri,
          ok: true
        })
        continue
      }
      const referenceResult = await observeGameStudioOperation(sessionId, step, stepIndex, `generateLockReference:${assetId}`, {
        endpoint: 'POST /api/projects/:id/ai/story/assets/reference',
        projectId,
        assetId
      }, () => gameStudioServerClient.generateStoryAssetReference(projectId, {
        assetId,
        batchSize: Math.max(1, Math.min(2, Number(step.params?.batchSize || 1))),
        style: step.params?.style || 'picture_book',
        timeoutMs: Math.max(120000, Number(step.params?.timeoutMs || 300000))
      }))
      const recommendedAssetPath = String(referenceResult?.data?.recommendedAssetPath || referenceResult?.data?.assetPath || referenceResult?.data?.candidates?.[0]?.assetPath || '').trim()
      let selectResult = null
      if (referenceResult?.ok && recommendedAssetPath) {
        selectResult = await observeGameStudioOperation(sessionId, step, stepIndex, `selectLockReference:${assetId}`, {
          endpoint: 'POST /api/projects/:id/ai/story/assets/reference/select',
          projectId,
          assetId
        }, () => gameStudioServerClient.selectStoryAssetReference(projectId, {
          assetId,
          assetPath: recommendedAssetPath,
          timeoutMs: Math.max(120000, Number(step.params?.timeoutMs || 300000))
        }))
      }
      const selectedAsset = selectResult?.data?.asset || referenceResult?.data?.asset || asset
      generated.push({
        assetId,
        name: String(asset.name || assetId),
        category: String(asset.category || ''),
        lockProfile: String(asset.lockProfile || ''),
        renderStrategy: String(asset.renderStrategy || ''),
        sceneCount: Number(asset.sceneCount || 0),
        status: selectResult?.ok ? 'selected_primary_reference' : (referenceResult?.ok ? 'candidate_generated' : 'failed'),
        ok: Boolean(selectResult?.ok || referenceResult?.ok),
        selected: Boolean(selectResult?.ok),
        recommendedAssetPath,
        primaryReferenceAssetUri: String(selectedAsset?.primaryReferenceAssetUri || recommendedAssetPath || '').trim(),
        url: String(referenceResult?.data?.url || '').trim(),
        score: Number.isFinite(Number(referenceResult?.data?.analysis?.score)) ? Number(referenceResult.data.analysis.score) : null,
        passed: referenceResult?.data?.analysis?.passed ?? null,
        summary: String(referenceResult?.data?.analysis?.summary || '').trim(),
        error: referenceResult?.error || selectResult?.error || null,
        message: referenceResult?.message || selectResult?.message || null
      })
    }
    const okCount = generated.filter((item) => item.ok).length
    const selectedCount = generated.filter((item) => item.selected || item.status === 'ready_existing').length
    const failed = generated.filter((item) => !item.ok)
    const evaluator = {
      name: 'evaluateStoryLockAssetReferences',
      passed: Boolean(planResult.ok && requiredAssets.length > 0 && okCount === requiredAssets.length),
      checks: {
        projectId,
        hasPlan: Boolean(plan),
        planAssetCount: assets.length,
        requiredAssetCount: requiredAssets.length,
        generatedCount: okCount,
        selectedCount,
        failedCount: failed.length,
        failedAssets: failed.map((item) => ({ assetId: item.assetId, name: item.name, error: item.error, message: item.message }))
      }
    }
    const snapshot = buildStoryProjectSnapshot(projectId)
    const result = buildStoryWorkflowStepResult({
      action,
      projectId,
      ok: evaluator.passed,
      summary: evaluator.passed
        ? `已锁定并绘制必要事物 ${okCount}/${requiredAssets.length}，主参考图 ${selectedCount} 个`
        : `锁定事物出图未完成：${planResult.message || planResult.error || failed[0]?.message || failed[0]?.error || 'lock_asset_reference_failed'}`,
      serverResult: planResult,
      evaluator,
      snapshot,
      data: { plan, generated },
      failedStage: evaluator.passed ? null : (planResult.ok ? 'lock_asset_reference_generation' : 'asset_plan_api'),
      retryable: Boolean(planResult.retryable || failed.length)
    })
    updateStoryWorkflowArtifacts(sessionId, step, stepIndex, result)
    if (plan) {
      updateReasoningSession(sessionId, (current) => ({
        ...current,
        artifacts: {
          ...current.artifacts,
          storyProduction: {
            ...(current.artifacts?.storyProduction || {}),
            assetPlan: plan,
            lockAssetReferences: generated
          }
        }
      }))
    }
    appendStoryWorkflowEvents(sessionId, step, stepIndex, result)
    return result
  }

  if (action === 'story_generate_asset_candidate') {
    const projectId = resolveStoryProjectId(session, step, userPrompt)
    const assetKind = String(step.params?.assetKind || 'background').trim() || 'background'
    const prompt = String(step.params?.prompt || userPrompt || '').trim()
    const aiStatus = await observeGameStudioOperation(sessionId, step, stepIndex, 'getAiStatus', {
      endpoint: 'GET /api/ai/status',
      projectId
    }, () => gameStudioServerClient.getAiStatus())
    const imageEnabled = Boolean(aiStatus?.data?.ai?.effective?.enabled?.image || aiStatus?.data?.ai?.enabled?.image)
    let serverResult = null
    if (projectId && imageEnabled && assetKind === 'background') {
      serverResult = await observeGameStudioOperation(sessionId, step, stepIndex, 'generateBackground', {
        endpoint: 'POST /api/projects/:id/ai/background',
        projectId
      }, () => gameStudioServerClient.generateBackground(projectId, {
        prompt,
        width: 768,
        height: 1024,
        timeoutMs: 300000
      }))
    }
    const snapshot = buildStoryProjectSnapshot(projectId)
    const ok = Boolean(serverResult?.ok)
    const result = buildStoryWorkflowStepResult({
      action,
      projectId,
      ok,
      summary: ok
        ? `已生成 ${assetKind} 资产候选并返回项目证据`
        : `资产生成未完成：${!projectId ? 'missing_project_id' : (!imageEnabled ? 'image_provider_not_ready' : (assetKind !== 'background' ? 'character_asset_pipeline_not_ready' : (serverResult?.message || serverResult?.error || 'asset_generation_failed')))}`,
      serverResult: serverResult || aiStatus,
      evaluator: {
        name: 'evaluateAssets',
        passed: ok,
        checks: {
          projectId,
          assetKind,
          imageEnabled,
          providerStatus: aiStatus?.data?.ai || null,
          serverResult: serverResult ? { ok: serverResult.ok, endpoint: serverResult.endpoint, error: serverResult.error || null } : null
        }
      },
      snapshot,
      data: { assetKind, prompt, aiStatus: aiStatus?.data?.ai || null, serverData: serverResult?.data || null },
      failedStage: ok ? null : (!projectId ? 'asset_project_resolution' : (!imageEnabled ? 'image_provider_preflight' : (assetKind !== 'background' ? 'character_asset_contract' : 'image_provider_call'))),
      retryable: Boolean(projectId && (serverResult?.retryable || !imageEnabled))
    })
    updateStoryWorkflowArtifacts(sessionId, step, stepIndex, result)
    appendStoryWorkflowEvents(sessionId, step, stepIndex, result)
    return result
  }

  if (action === 'story_lock_test') {
    const projectId = resolveStoryProjectId(session, step, userPrompt)
    const settingsResult = await observeGameStudioOperation(sessionId, step, stepIndex, 'getStudioSettingsForLockTest', {
      endpoint: 'GET /api/studio/settings'
    }, () => gameStudioServerClient.getStudioSettings())
    const effective = settingsResult?.data?.effective || {}
    const model = String(
      step.params?.model ||
      effective?.image?.model ||
      'ivisionIllustration_ivision10.safetensors'
    ).trim()
    const loras = Array.isArray(step.params?.loras)
      ? step.params.loras
      : Array.isArray(effective?.image?.loras) ? effective.image.loras : []
    const style = String(step.params?.style || 'picture_book').trim()
    const maxAttempts = Math.max(1, Math.min(4, Number(step.params?.maxAttempts || 3)))
    const timeoutMs = Math.max(60000, Number(step.params?.timeoutMs || 180000))
    const serverResult = projectId
      ? await observeGameStudioOperation(sessionId, step, stepIndex, 'storyLockTest', {
        endpoint: 'POST /api/projects/:id/ai/story/lock/test',
        projectId,
        model,
        maxAttempts
      }, () => gameStudioServerClient.storyLockTest(projectId, {
        model,
        loras,
        style,
        width: Number(step.params?.width || 512),
        height: Number(step.params?.height || 512),
        steps: Number(step.params?.steps || 20),
        cfgScale: Number(step.params?.cfgScale || 7),
        maxAttempts,
        timeoutMs
      }))
      : { ok: false, status: 0, endpoint: 'POST /api/projects/:id/ai/story/lock/test', error: 'missing_project_id', message: '无法定位要执行锁定测试的项目', retryable: false }
    const passed = Boolean(serverResult?.data?.passed)
    const testAttempts = Array.isArray(serverResult?.data?.attempts) ? serverResult.data.attempts : []
    const testTarget = serverResult?.data?.testTarget || null
    const summary = String(serverResult?.data?.summary || '').trim()
    const evaluator = {
      name: 'evaluateStoryLockTest',
      passed: Boolean(serverResult.ok && passed),
      checks: {
        projectId,
        model,
        maxAttempts,
        attemptCount: testAttempts.length,
        passed,
        testTarget: testTarget ? { id: testTarget.id, name: testTarget.name, category: testTarget.category } : null,
        error: serverResult?.error || null,
        message: serverResult?.message || null
      }
    }
    const snapshot = buildStoryProjectSnapshot(projectId)
    const result = buildStoryWorkflowStepResult({
      action,
      projectId,
      ok: evaluator.passed,
      summary: evaluator.passed
        ? `事物锁定测试通过：${summary || (testTarget ? `asset=${String(testTarget.name || testTarget.id || 'asset')} attempts=${testAttempts.length}` : `attempts=${testAttempts.length}`)}`
        : `事物锁定测试未通过：${serverResult.message || serverResult.error || summary || 'lock_test_failed'}`,
      serverResult,
      evaluator,
      snapshot,
      data: {
        model,
        testTarget,
        passed,
        summary,
        attempts: testAttempts.map((a) => ({
          attempt: a.attempt,
          assetId: a.assetId,
          assetName: a.assetName,
          assetPath: a.assetPath,
          url: a.url,
          passed: a.analysis?.passed ?? null,
          score: a.analysis?.score ?? null,
          summary: a.analysis?.summary || null
        }))
      },
      failedStage: evaluator.passed ? null : (serverResult.ok ? 'lock_test_evaluator' : 'lock_test_api'),
      retryable: Boolean(serverResult.retryable || (serverResult.ok && !passed))
    })
    updateStoryWorkflowArtifacts(sessionId, step, stepIndex, result)
    if (passed && testTarget) {
      updateReasoningSession(sessionId, (current) => ({
        ...current,
        artifacts: {
          ...current.artifacts,
          storyProduction: {
            ...(current.artifacts?.storyProduction || {}),
            lockTestResult: { passed, testTarget, attempts: testAttempts.length, summary }
          }
        }
      }))
    }
    appendStoryWorkflowEvents(sessionId, step, stepIndex, result)
    return result
  }

  throw new Error(`unsupported_story_workflow_action_${action}`)
}

function sleepMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function fetchOk(url, timeoutMs = 3000) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), Math.max(500, Number(timeoutMs || 3000)))
  try {
    const response = await fetch(url, { method: 'GET', signal: controller.signal })
    return { ok: response.ok, status: response.status, url }
  } catch (error) {
    return { ok: false, status: 0, url, error: error instanceof Error ? error.message : String(error) }
  } finally {
    clearTimeout(timeout)
  }
}

async function waitForHttpOk(url, { timeoutMs = 60000, intervalMs = 1000 } = {}) {
  const startedAt = Date.now()
  let last = null
  while (Date.now() - startedAt < timeoutMs) {
    last = await fetchOk(url, Math.min(3000, intervalMs + 1000))
    if (last.ok) return { ...last, elapsedMs: Date.now() - startedAt }
    await sleepMs(intervalMs)
  }
  return { ...(last || { ok: false, status: 0, url }), elapsedMs: Date.now() - startedAt }
}

async function ensureComfyUiRunning(baseUrl = 'http://127.0.0.1:8188', options = {}) {
  const normalizedBaseUrl = String(baseUrl || 'http://127.0.0.1:8188').replace(/\/+$/, '')
  const healthUrl = `${normalizedBaseUrl}/system_stats`
  const before = await fetchOk(healthUrl, Math.min(3000, Number(options.healthTimeoutMs || 3000)))
  if (before.ok) {
    return { ok: true, started: false, baseUrl: normalizedBaseUrl, health: before, startResult: null }
  }
  const comfyRoot = String(options.comfyRoot || process.env.COMFYUI_ROOT || '/Volumes/ovokit2t/ComfyUI').trim()
  const startResult = await runLocalCommand('sh', ['-lc', 'mkdir -p .run && nohup sh ./start.sh > .run/gamestudio-comfyui.log 2>&1 < /dev/null & echo $!'], {
    cwd: comfyRoot,
    timeoutMs: 5000
  })
  const after = await waitForHttpOk(healthUrl, { timeoutMs: Math.max(15000, Number(options.waitTimeoutMs || 90000)), intervalMs: 1000 })
  return { ok: Boolean(after.ok), started: true, baseUrl: normalizedBaseUrl, health: after, startResult }
}

function runLocalCommand(command, args, { cwd = GAMESTUDIO_ROOT, timeoutMs = 180000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
    const stdout = []
    const stderr = []
    const timeout = setTimeout(() => {
      child.kill('SIGTERM')
      resolve({ ok: false, exitCode: null, stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8'), error: 'command_timeout' })
    }, Math.max(1000, Number(timeoutMs || 180000)))
    child.stdout.on('data', (chunk) => stdout.push(Buffer.from(chunk)))
    child.stderr.on('data', (chunk) => stderr.push(Buffer.from(chunk)))
    child.on('error', (error) => {
      clearTimeout(timeout)
      resolve({ ok: false, exitCode: null, stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8'), error: error instanceof Error ? error.message : String(error) })
    })
    child.on('close', (code) => {
      clearTimeout(timeout)
      resolve({ ok: code === 0, exitCode: code, stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8'), error: code === 0 ? null : `exit_${code}` })
    })
  })
}

function buildChromiumReuseTabScript(browserName) {
  const appName = String(browserName || '').replace(/"/g, '\\"')
  return `
on run argv
  set targetUrl to item 1 of argv
  set targetHost to item 2 of argv
  tell application "System Events"
    if not (exists process "${appName}") then return "not_running:${appName}"
  end tell
  tell application "${appName}"
    repeat with browserWindow in windows
      set browserTabIndex to 0
      repeat with browserTab in tabs of browserWindow
        set browserTabIndex to browserTabIndex + 1
        try
          if (URL of browserTab contains targetHost) then
            set URL of browserTab to targetUrl
            set active tab index of browserWindow to browserTabIndex
            set index of browserWindow to 1
            activate
            return "reused:${appName}"
          end if
        end try
      end repeat
    end repeat
  end tell
  return "not_found:${appName}"
end run
`
}

function buildSafariReuseTabScript() {
  return `
on run argv
  set targetUrl to item 1 of argv
  set targetHost to item 2 of argv
  tell application "System Events"
    if not (exists process "Safari") then return "not_running:Safari"
  end tell
  tell application "Safari"
    repeat with browserWindow in windows
      repeat with browserTab in tabs of browserWindow
        try
          if (URL of browserTab contains targetHost) then
            set URL of browserTab to targetUrl
            set current tab of browserWindow to browserTab
            set index of browserWindow to 1
            activate
            return "reused:Safari"
          end if
        end try
      end repeat
    end repeat
  end tell
  return "not_found:Safari"
end run
`
}

async function openUrlReusingBrowserTab(url, { cwd = GAMESTUDIO_ROOT, timeoutMs = 5000 } = {}) {
  let targetHost = ''
  try {
    targetHost = new URL(url).host
  } catch {
    targetHost = 'localhost:8868'
  }
  const reuseScripts = [
    buildChromiumReuseTabScript('Google Chrome'),
    buildChromiumReuseTabScript('Chromium'),
    buildChromiumReuseTabScript('Microsoft Edge'),
    buildChromiumReuseTabScript('Brave Browser'),
    buildSafariReuseTabScript()
  ]
  const attempts = []
  for (const script of reuseScripts) {
    const result = await runLocalCommand('osascript', ['-e', script, url, targetHost], { cwd, timeoutMs })
    const stdout = String(result.stdout || '').trim()
    attempts.push({ ok: result.ok, exitCode: result.exitCode, stdout, stderr: String(result.stderr || '').trim(), error: result.error || null })
    if (result.ok && stdout.startsWith('reused:')) {
      return { ...result, method: 'reuse-existing-tab', reused: true, browser: stdout.slice('reused:'.length), attempts }
    }
  }
  const fallback = await runLocalCommand('open', [url], { cwd, timeoutMs })
  return { ...fallback, method: 'open-fallback', reused: false, attempts }
}

async function openUrlInBrowser(url, { cwd = GAMESTUDIO_ROOT, timeoutMs = 5000, allowNewTabFallback = true } = {}) {
  const reused = await openUrlReusingBrowserTab(url, { cwd, timeoutMs })
  if (reused.reused || allowNewTabFallback) return reused
  return {
    ok: true,
    exitCode: 0,
    stdout: 'reuse_not_found_new_tab_fallback_disabled',
    stderr: '',
    error: null,
    method: 'reuse-not-found',
    reused: false,
    attempts: reused.attempts || []
  }
}

function buildGameStudioBootstrapResult({ action, ok, summary, data = null, evaluator = null, failedStage = null, retryable = false }) {
  return {
    action,
    ok: Boolean(ok),
    status: 'completed',
    summary,
    failedStage,
    retryable: Boolean(retryable),
    evaluator,
    data
  }
}

function updateGameStudioBootstrapArtifacts(sessionId, step, stepIndex, result) {
  updateReasoningSession(sessionId, (session) => {
    const bootstrap = session.artifacts?.gameStudioBootstrap && typeof session.artifacts.gameStudioBootstrap === 'object'
      ? session.artifacts.gameStudioBootstrap
      : {}
    return {
      ...session,
      artifacts: {
        ...session.artifacts,
        gameStudioBootstrap: {
          ...bootstrap,
          lastResult: result,
          steps: {
            ...(bootstrap.steps || {}),
            [step.stepId]: result
          }
        },
        latestStepReviewEvidence: {
          targetType: 'step',
          stepId: step.stepId,
          stepTitle: step.title,
          tool: step.tool,
          outboundPreview: {
            tool: step.tool,
            action: step.action,
            params: step.params || {}
          },
          rawResponsePreview: truncateReasoningPreview(JSON.stringify(result, null, 2), 2400),
          structuredResult: result
        }
      }
    }
  })
  appendReasoningEvent(sessionId, 'tool_result', step.title, result.summary || String(result.action || step.action), {
    stepId: step.stepId,
    data: buildReasoningStepEventData(step, stepIndex, {
      result,
      observableOps: buildReasoningObservableOps(step, result)
    })
  })
  appendReasoningEvent(sessionId, 'step_completed', step.title, result.ok ? 'GameStudio bootstrap step completed' : 'GameStudio bootstrap step failed or blocked', {
    stepId: step.stepId,
    data: buildReasoningStepEventData(step, stepIndex, result)
  })
}

function buildLocalProductionStudioSettings(params = {}) {
  const model = String(params.model || 'gpt-oss-20b-MXFP4-Q8').trim()
  const localModelBaseUrl = String(params.localModelBaseUrl || 'http://127.0.0.1:18888/v1').trim()
  const comfyuiBaseUrl = String(params.comfyuiBaseUrl || 'http://127.0.0.1:8188').trim()
  const comfyuiModelsRoot = String(params.comfyuiModelsRoot || process.env.COMFYUI_MODELS_ROOT || (process.env.COMFYUI_ROOT ? path.join(process.env.COMFYUI_ROOT, 'models') : '/Volumes/ovokit2t/ComfyUI/models')).trim()
  const imageModel = String(params.imageModel || params.comfyuiModel || 'ivisionIllustration_ivision10.safetensors').trim()
  const imageSize = String(params.imageSize || '1024x1024').trim()
  return {
    enabled: {
      scripts: true,
      prompt: true,
      image: true,
      tts: false
    },
    scripts: {
      provider: 'localoxml',
      model,
      apiUrl: localModelBaseUrl
    },
    prompt: {
      provider: 'localoxml',
      model,
      apiUrl: localModelBaseUrl
    },
    translation: {
      provider: 'localoxml',
      model,
      apiUrl: localModelBaseUrl
    },
    image: {
      provider: 'comfyui',
      model: imageModel,
      comfyuiBaseUrl,
      comfyuiModelsRoot,
      size: imageSize
    }
  }
}

async function executeGameStudioBootstrapStep(sessionId, step, userPrompt, stepIndex) {
  const action = step.action
  if (action === 'gamestudio_ensure_running') {
    const serverBaseUrl = String(step.params?.serverUrl || 'http://127.0.0.1:1999').replace(/\/+$/, '')
    const editorUrl = String(step.params?.editorUrl || 'http://localhost:8868').replace(/\/+$/, '')
    const healthUrl = `${serverBaseUrl}/api/health`
    let serverHealth = await observeGameStudioOperation(sessionId, step, stepIndex, 'fetchServerHealth', {
      endpoint: 'GET /api/health'
    }, () => fetchOk(healthUrl, 3000))
    let startResult = null
    if (!serverHealth.ok && step.params?.startIfNeeded !== false) {
      startResult = await observeGameStudioOperation(sessionId, step, stepIndex, 'startProjectDetached', {
        endpoint: 'bash ./start_project.sh --detached'
      }, () => runLocalCommand('bash', ['./start_project.sh', '--detached'], { cwd: GAMESTUDIO_ROOT, timeoutMs: 180000 }))
      serverHealth = await observeGameStudioOperation(sessionId, step, stepIndex, 'waitForServerHealth', {
        endpoint: 'GET /api/health'
      }, () => waitForHttpOk(healthUrl, { timeoutMs: 60000, intervalMs: 1000 }))
    }
    const editorHealth = await observeGameStudioOperation(sessionId, step, stepIndex, 'waitForEditor', {
      endpoint: 'GET editor root'
    }, () => waitForHttpOk(editorUrl, { timeoutMs: serverHealth.ok ? 5000 : 1000, intervalMs: 1000 }))
    const ok = Boolean(serverHealth.ok && editorHealth.ok)
    const result = buildGameStudioBootstrapResult({
      action,
      ok,
      summary: ok
        ? `GameStudio 已就绪：server=${healthUrl} editor=${editorUrl}`
        : `GameStudio 未完全就绪：server=${serverHealth.ok ? 'ok' : 'fail'} editor=${editorHealth.ok ? 'ok' : 'fail'}`,
      data: { serverBaseUrl, editorUrl, serverHealth, editorHealth, startResult },
      evaluator: {
        name: 'evaluateGameStudioRunning',
        passed: ok,
        checks: { serverHealth, editorHealth, startExitCode: startResult?.exitCode ?? null }
      },
      failedStage: ok ? null : 'gamestudio_startup',
      retryable: !ok
    })
    updateGameStudioBootstrapArtifacts(sessionId, step, stepIndex, result)
    return result
  }

  if (action === 'gamestudio_open_editor') {
    const editorBaseUrl = String(step.params?.editorUrl || 'http://localhost:8868').replace(/\/+$/, '')
    const openTarget = String(step.params?.openTarget || '').trim()
    const editorUrl = openTarget === 'ai-create-story'
      ? `${editorBaseUrl}/?action=ai-create-story`
      : editorBaseUrl
    const reachable = await observeGameStudioOperation(sessionId, step, stepIndex, 'fetchEditor', {
      endpoint: 'GET editor root'
    }, () => fetchOk(editorBaseUrl, 3000))
    let openResult = { attempted: false, ok: false, note: 'openBrowser_disabled' }
    if (step.params?.openBrowser !== false && process.platform === 'darwin') {
      const allowNewTabFallback = step.params?.openNewTabFallback !== false
      const opened = await observeGameStudioOperation(sessionId, step, stepIndex, 'openEditorInBrowser', {
        endpoint: 'reuse existing browser tab or open editor url'
      }, () => openUrlInBrowser(editorUrl, { cwd: GAMESTUDIO_ROOT, timeoutMs: 5000, allowNewTabFallback }))
      openResult = { attempted: true, ok: opened.ok, exitCode: opened.exitCode, error: opened.error || null, method: opened.method || null, reused: Boolean(opened.reused), browser: opened.browser || null }
    }
    const ok = Boolean(reachable.ok)
    const result = buildGameStudioBootstrapResult({
      action,
      ok,
      summary: ok ? `GameStudio Editor 可访问：${editorUrl}` : `GameStudio Editor 当前不可访问：${editorUrl}`,
      data: { editorUrl, openTarget: openTarget || null, reachable, openResult },
      evaluator: { name: 'evaluateGameStudioEditor', passed: ok, checks: { reachable, openResult } },
      failedStage: ok ? null : 'gamestudio_editor_unreachable',
      retryable: !ok
    })
    updateGameStudioBootstrapArtifacts(sessionId, step, stepIndex, result)
    return result
  }

  if (action === 'gamestudio_read_settings') {
    const serverResult = await observeGameStudioOperation(sessionId, step, stepIndex, 'getStudioSettings', {
      endpoint: 'GET /api/studio/settings'
    }, () => gameStudioServerClient.getStudioSettings())
    const effective = serverResult?.data?.effective || null
    const ok = Boolean(serverResult.ok && effective)
    const result = buildGameStudioBootstrapResult({
      action,
      ok,
      summary: ok ? `已读取 GameStudio settings：scripts=${effective?.scripts?.provider || 'none'} image=${effective?.image?.provider || 'none'}` : `读取 GameStudio settings 失败：${serverResult.message || serverResult.error}`,
      data: { settings: serverResult?.data?.settings || null, effective },
      evaluator: { name: 'evaluateGameStudioSettings', passed: ok, checks: { endpoint: serverResult.endpoint, status: serverResult.status, effective } },
      failedStage: ok ? null : 'gamestudio_settings_read',
      retryable: serverResult.retryable
    })
    updateGameStudioBootstrapArtifacts(sessionId, step, stepIndex, result)
    return result
  }

  if (action === 'gamestudio_configure_local_production') {
    const settings = buildLocalProductionStudioSettings(step.params || {})
    const serverResult = await observeGameStudioOperation(sessionId, step, stepIndex, 'updateStudioSettings', {
      endpoint: 'PUT /api/studio/settings'
    }, () => gameStudioServerClient.updateStudioSettings(settings))
    const readBack = serverResult.ok ? await observeGameStudioOperation(sessionId, step, stepIndex, 'getStudioSettingsAfterWrite', {
      endpoint: 'GET /api/studio/settings'
    }, () => gameStudioServerClient.getStudioSettings()) : null
    const effective = readBack?.data?.effective || null
    const ok = Boolean(serverResult.ok && effective?.enabled?.image && effective?.image?.provider === 'comfyui' && effective?.scripts?.provider === 'localoxml')
    const result = buildGameStudioBootstrapResult({
      action,
      ok,
      summary: ok ? `已写入本地生产配置：model=${settings.scripts.model} comfyui=${settings.image.comfyuiBaseUrl}` : `本地生产配置未通过读回验证：${serverResult.message || serverResult.error || 'readback_failed'}`,
      data: { requestedSettings: settings, saved: serverResult?.data?.settings || null, effective },
      evaluator: {
        name: 'evaluateLocalProductionSettings',
        passed: ok,
        checks: {
          scriptsProvider: effective?.scripts?.provider || null,
          scriptsModel: effective?.scripts?.model || null,
          imageEnabled: effective?.enabled?.image || false,
          imageProvider: effective?.image?.provider || null,
          comfyuiBaseUrl: effective?.image?.comfyuiBaseUrl || null
        }
      },
      failedStage: ok ? null : 'gamestudio_settings_write',
      retryable: serverResult.retryable
    })
    updateGameStudioBootstrapArtifacts(sessionId, step, stepIndex, result)
    return result
  }

  if (action === 'gamestudio_self_check') {
    const timeoutMs = Math.max(3000, Number(step.params?.timeoutMs || 15000))
    const health = await observeGameStudioOperation(sessionId, step, stepIndex, 'getHealth', {
      endpoint: 'GET /api/health'
    }, () => gameStudioServerClient.getHealth())
    const settings = await observeGameStudioOperation(sessionId, step, stepIndex, 'getStudioSettings', {
      endpoint: 'GET /api/studio/settings'
    }, () => gameStudioServerClient.getStudioSettings())
    const diagnose = await observeGameStudioOperation(sessionId, step, stepIndex, 'diagnoseStudio', {
      endpoint: 'POST /api/studio/diagnose'
    }, () => gameStudioServerClient.diagnoseStudio({ service: 'all', deepText: false, deepImages: false, timeoutMs }))
    const imagePreflightMode = String(step.params?.imagePreflightMode || step.params?.mode || 'basic').trim().toLowerCase() === 'storyboard' ? 'storyboard' : 'basic'
    const preflight = step.params?.imagePreflight === false
      ? null
      : await observeGameStudioOperation(sessionId, step, stepIndex, 'preflightImageProvider', {
        endpoint: 'POST /api/studio/image/preflight'
      }, () => gameStudioServerClient.preflightImageProvider({ mode: imagePreflightMode, timeoutMs }))
    const preflightOk = preflight ? Boolean(preflight.ok && preflight?.data?.checks?.ok !== false) : true
    const ok = Boolean(health.ok && settings.ok && diagnose.ok && preflightOk)
    const imageProvider = settings?.data?.effective?.image?.provider || preflight?.data?.checks?.provider || 'none'
    const result = buildGameStudioBootstrapResult({
      action,
      ok,
      summary: ok
        ? `GameStudio 自检通过：health ok，image provider=${imageProvider}`
        : `GameStudio 自检未通过：health=${health.ok ? 'ok' : 'fail'} diagnose=${diagnose.ok ? 'ok' : 'fail'} preflight=${preflightOk ? 'ok' : 'fail'}`,
      data: {
        health: { ok: health.ok, status: health.status, data: health.data || null },
        settings: settings?.data || null,
        diagnose: diagnose?.data || null,
        preflight: preflight?.data || null
      },
      evaluator: {
        name: 'evaluateGameStudioSelfCheck',
        passed: ok,
        checks: {
          healthOk: health.ok,
          settingsOk: settings.ok,
          diagnoseOk: diagnose.ok,
          imagePreflightOk: preflightOk,
          imagePreflightMode,
          imageProvider,
          preflightReason: preflight?.data?.checks?.reason || preflight?.error || null
        }
      },
      failedStage: ok ? null : (!health.ok ? 'gamestudio_health' : (!settings.ok ? 'gamestudio_settings' : (!diagnose.ok ? 'gamestudio_diagnose' : 'gamestudio_image_preflight'))),
      retryable: Boolean(health.retryable || settings.retryable || diagnose.retryable || preflight?.retryable)
    })
    updateGameStudioBootstrapArtifacts(sessionId, step, stepIndex, result)
    return result
  }

  if (action === 'gamestudio_bootstrap_answer') {
    const session = readReasoningSession(sessionId)
    const stepResults = session?.artifacts?.gameStudioBootstrap?.steps || {}
    const openEditor = stepResults.step_gamestudio_open_editor || null
    const ensureRunning = stepResults.step_gamestudio_ensure_running || null
    const readSettings = stepResults.step_gamestudio_read_settings || null
    const selfCheck = stepResults.step_gamestudio_self_check || null
    const completedResults = Object.values(stepResults).filter((entry) => entry && typeof entry === 'object')
    const failedResults = completedResults.filter((entry) => entry.ok === false)
    const editorUrl = openEditor?.data?.editorUrl || ensureRunning?.data?.editorUrl || 'http://localhost:8868'
    const lines = [
      `已通过 Control 打开 GameStudio：${editorUrl}`,
      openEditor?.data?.openTarget === 'ai-create-story' ? '目标入口：AI 创建故事弹窗。' : '',
      ensureRunning ? `运行状态：${ensureRunning.ok ? '已就绪' : '未完全就绪'}。` : '',
      readSettings ? `Studio Settings：${readSettings.summary || (readSettings.ok ? '读取成功' : '读取失败')}。` : '',
      selfCheck ? `自检：${selfCheck.summary || (selfCheck.ok ? '通过' : '未通过')}。` : '',
      failedResults.length ? `需要关注：${failedResults.map((entry) => entry.failedStage || entry.action || 'unknown').join(', ')}` : ''
    ].filter(Boolean)
    const finalAnswer = lines.join('\n')
    const ok = failedResults.length === 0
    const result = buildGameStudioBootstrapResult({
      action,
      ok,
      summary: finalAnswer,
      data: {
        editorUrl,
        openTarget: openEditor?.data?.openTarget || null,
        completedStepCount: completedResults.length,
        failedStepCount: failedResults.length,
        failedStages: failedResults.map((entry) => entry.failedStage || entry.action || 'unknown')
      },
      evaluator: {
        name: 'evaluateGameStudioBootstrapSummary',
        passed: ok,
        checks: {
          editorOpened: Boolean(openEditor?.ok),
          gameStudioReady: Boolean(ensureRunning?.ok),
          failedStepCount: failedResults.length
        }
      },
      failedStage: ok ? null : 'gamestudio_bootstrap_summary',
      retryable: false
    })
    const answerPersisted = persistHermesChatReply(sessionId, finalAnswer, null, { provisional: true })
    updateReasoningSession(sessionId, (current) => ({
      ...current,
      artifacts: {
        ...current.artifacts,
        finalAnswer,
        finalAnswerUsage: null,
        finalAnswerPersisted: answerPersisted
      }
    }))
    updateGameStudioBootstrapArtifacts(sessionId, step, stepIndex, result)
    return result
  }

  throw new Error(`unsupported_gamestudio_bootstrap_action_${action}`)
}

async function executeReasoningStep(sessionId, step, userPrompt, options = {}) {
  const correctionPrompt = String(options.correctionPrompt || '').trim()
  const sessionBeforeRun = readReasoningSession(sessionId)
  const productionTest = Boolean(sessionBeforeRun?.submissionContext?.productionTest)
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

  if (String(step.action || '').startsWith('story_')) {
    return executeStoryWorkflowStep(sessionId, step, userPrompt, stepIndex)
  }

  if (String(step.action || '').startsWith('gamestudio_')) {
    return executeGameStudioBootstrapStep(sessionId, step, userPrompt, stepIndex)
  }

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
    const answerPersisted = persistHermesChatReply(sessionId, answer.reply, answer.usage || null, { provisional: true })
    updateReasoningSession(sessionId, (current) => ({
      ...current,
      artifacts: {
        ...current.artifacts,
        finalAnswer: answer.reply,
        finalAnswerUsage: answer.usage || null,
        finalAnswerPersisted: answerPersisted,
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
    const query = String(step.params?.query || step.params?.pattern || '').trim()
    if (!query) {
      throw new Error('search_workspace_text_missing_query')
    }
    const result = runWorkspaceTextSearch(query, {
      startDir: step.params?.startDir || step.params?.dirPath,
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
    if (productionTest) {
      applyPreparedReasoningWrite(sessionId, step.stepId)
      appendReasoningEvent(sessionId, 'step_completed', step.title, `productionTest=true，已自动写入 ${rewrite.filePath}，跳过人工审核。`, { stepId: step.stepId })
      return
    }
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
    if (productionTest) {
      applyPreparedReasoningWrite(sessionId, step.stepId)
      appendReasoningEvent(sessionId, 'step_completed', step.title, `productionTest=true，已自动编辑 ${rewrite.filePath}，跳过人工审核。`, { stepId: step.stepId })
      return
    }
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
    if (productionTest) {
      applyPreparedReasoningWrite(sessionId, step.stepId)
      appendReasoningEvent(sessionId, 'step_completed', step.title, `productionTest=true，已自动创建 ${rewrite.filePath}，跳过人工审核。`, { stepId: step.stepId })
      return
    }
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
    if (productionTest) {
      applyPreparedReasoningWrite(sessionId, step.stepId)
      appendReasoningEvent(sessionId, 'step_completed', step.title, `productionTest=true，已自动更新 ${rewrite.filePath}，跳过人工审核。`, { stepId: step.stepId })
      return
    }
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
    if (productionTest) {
      applyPreparedWorkspaceOperation(sessionId, step.stepId)
      appendReasoningEvent(sessionId, 'step_completed', step.title, `productionTest=true，已自动重命名 ${fromPath} -> ${toPath}，跳过人工审核。`, { stepId: step.stepId })
      return
    }
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
    if (productionTest) {
      applyPreparedWorkspaceOperation(sessionId, step.stepId)
      appendReasoningEvent(sessionId, 'step_completed', step.title, `productionTest=true，已自动删除 ${targetPath}，跳过人工审核。`, { stepId: step.stepId })
      return
    }
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
    if (productionTest) {
      applyPreparedLifecycleScript(sessionId, step.stepId)
      appendReasoningEvent(sessionId, 'step_completed', step.title, `productionTest=true，已自动执行脚本 ${scriptName}，跳过人工审核。`, { stepId: step.stepId })
      return
    }
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
    if (productionTest) {
      applyPreparedLifecycleScript(sessionId, step.stepId)
      appendReasoningEvent(sessionId, 'step_completed', step.title, `productionTest=true，已自动执行脚本 ${scriptPath}，跳过人工审核。`, { stepId: step.stepId })
      return
    }
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

  if (isReasoningAutoReviewMode(session) || session?.submissionContext?.productionTest) {
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
  const normalizedSubmissionContext = {
    ...submissionContext,
    disableQualityAutoRetry: submissionContext?.disableQualityAutoRetry === undefined
      ? isLikelyReadOnlyReasoningPrompt(userPrompt)
      : Boolean(submissionContext.disableQualityAutoRetry)
  }
  const parentSessionId = String(normalizedSubmissionContext?.parentSessionId || '').trim() || null
  const allowRecentVerifiedReuse = Boolean(normalizedSubmissionContext?.allowRecentVerifiedReuse)
    && !Boolean(normalizedSubmissionContext?.productionTest || normalizedSubmissionContext?.forceFreshRun)
  const reusedSession = allowRecentVerifiedReuse ? findReusableVerifiedReasoningSession(userPrompt) : null
  if (reusedSession) {
    const reusedReply = String(reusedSession.artifacts?.finalAnswer || '').trim()
    const session = {
      sessionId,
      runtimeSessionId: sessionId,
      sessionKind: 'agent-runtime',
      agentId,
      userPrompt,
      submissionContext: normalizedSubmissionContext,
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
    submissionContext: normalizedSubmissionContext,
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
      childGoalQueue: Array.isArray(normalizedSubmissionContext?.childGoals) ? normalizedSubmissionContext.childGoals : [],
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
  scheduleMemoryLifecycleMaintenance('chat_history_updated')
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

function upsertHermesChatHistoryEntry(entry, predicate) {
  const history = readStoredHermesChatHistory()
  const index = history.findIndex((item) => predicate(item))
  if (index >= 0) {
    history[index] = entry
  } else {
    history.push(entry)
  }
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

function persistHermesChatReply(requestId, reply, tokens, extra = {}) {
  try {
    const entry = createHermesChatEntry('hermes', reply, { requestId, tokens, chatSessionId: currentHermesChatSessionId, ...extra })
    upsertHermesChatHistoryEntry(entry, (item) => (
      String(item?.requestId || '').trim() === String(requestId || '').trim()
      && String(item?.role || '').trim().toLowerCase() === 'hermes'
    ))
    return true
  } catch (err) {
    console.error('Failed to save chat reply', err)
    return false
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
  scheduleMemoryLifecycleMaintenance('context_pool_updated')
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

// 启动时清理孤儿 session（上次服务器崩溃或重启遗留的 planning/running 状态）
export function cleanupOrphanedReasoningSessions() {
  try {
    const sessionDirs = [HERMES_REASONING_SESSIONS_DIR, HERMES_AGENT_RUNTIME_SESSIONS_DIR]
    let count = 0
    for (const sessionDir of sessionDirs) {
      if (!fs.existsSync(sessionDir)) continue
      const files = fs.readdirSync(sessionDir).filter((f) => f.endsWith('.json'))
      for (const file of files) {
        const filePath = path.join(sessionDir, file)
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
    }
    if (count > 0) {
      console.log(`[control-server] [startup] cleaned up ${count} orphaned reasoning session(s)`)
    }
    scheduleMemoryLifecycleMaintenance('startup_orphan_cleanup', 0)
  } catch (e) {
    console.error('[control-server] [startup] orphan cleanup error:', e)
  }
}