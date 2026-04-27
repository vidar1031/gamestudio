import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { json } from '@codemirror/lang-json'
import { markdown } from '@codemirror/lang-markdown'
import { oneDark } from '@codemirror/theme-one-dark'
import { getReasoningSessionElapsedSeconds } from '../lib/reasoning'
import {
  clearAgentMemoryRecords,
  getAgentConfig,
  getAgentMemoryRecordFile,
  getAgentMemoryRecords,
  getAgentLogs,
  getAgents,
  getHealth,
  getRuntimeStatus,
  getSelfCheck,
  inspectLocalModel,
  listLocalModels,
  runModelAction,
  runPreflightCheck,
  runRuntimeAction,
  saveAgentConfig,
  saveAgentMemoryRecordFile,
} from '../services/controlApi'
import {
  cancelReasoningSessionRequest,
  clearReasoningSessionRecord,
  createReasoningSession,
  getReasoningCapabilities,
  getReasoningSession,
} from '../services/reasoningApi'
import {
  createContextDraft,
  getChatHistory as getChatHistoryRequest,
  getChatHistoryFile,
  getContextCandidates,
  getSubmissionPreview,
  openChatHistoryFile,
  pingModel,
  saveChatHistoryFile,
} from '../services/chatApi'

type HealthResponse = {
  ok: boolean
  service: string
  version: string
  now: string
}

type AgentListItem = {
  definition: {
    id: string
    name: string
    runtime: string
    role: string
  }
  status: {
    availability: string
  }
}

type RuntimeState = {
  state: 'uninstalled' | 'stopped' | 'running'
  label: string
  detail: string
  pid: number | null
  logFile: string
  availableActions: Array<'start' | 'stop' | 'pause' | 'resume' | 'exit' | 'all-restart'>
}

type SelfCheckResponse = {
  agentId: string
  runtimeStatus: string
  summary: string
  checkedAt: string
  checks: Array<{
    key: string
    label: string
    status: string
    detail: string
  }>
  info: {
    model: string
    provider: string
    baseUrl: string
    contextLength?: number | null
    recommendedMaxOutputTokens?: number | null
    tokenizer?: string | null
    metadataSource?: string | null
    workspace: string
    command: string
    interactionMode: string
  }
}

type TokenUsage = {
  promptTokens: number | null
  completionTokens: number | null
  totalTokens: number | null
}

type ChatContextSource = {
  label: string
  filePath: string
  exists: boolean
  totalChars: number
  loadedChars: number
  truncated: boolean
}

type ChatContextInfo = {
  runtime: {
    provider: string
    model: string
    baseUrl: string
    timeoutMs: number
  }
  replayedMessageCount: number
  selectedSourceCount: number
  loadedSourceCount: number
  sources: ChatContextSource[]
  contextPoolEntryCount?: number
  confirmedContextSummary?: string
  contextPoolEntries?: Array<{
    entryId: string
    title: string
    filePath: string
  }>
}

type ContextSourceCandidate = {
  sourceId: string
  kind: string
  label: string
  filePath: string
  exists: boolean
  totalChars: number
  loadedChars: number
  truncated: boolean
}

type ContextPoolEntrySummary = {
  entryId: string
  title: string
  summary: string
  createdAt: string
  updatedAt: string
  filePath: string
}

type ContextPoolEntryDetail = ContextPoolEntrySummary & {
  prompt?: string
  selectedSourceIds?: string[]
  selectedContextPoolIds?: string[]
}

type ContextDraftResult = {
  summary: string
  usage?: TokenUsage | null
  outboundPreview?: unknown
  rawResponsePreview?: string
  contextSources?: ChatContextInfo | null
}

type OutboundPreviewMessage = {
  index: number
  role: string
  content: string
}

type StructuredOutboundPreview = {
  provider: string
  model: string
  baseUrl: string
  messages?: OutboundPreviewMessage[]
  controllerRequest?: {
    purpose: string
    mode: string
    target: string
    model: string
    totalMessages: number
    systemMessageCount: number
    replayedMessageCount: number
    userMessageCount: number
    messages: OutboundPreviewMessage[]
  }
  runtimeRoute?: {
    provider: string
    model: string
    baseUrl: string
    note?: string
  }
  plannerHints?: {
    selectedSkills?: Array<{
      filePath: string
      name: string
      hintCount: number
      actionHints: Array<{
        hintId: string
        keywords: string[]
        requiredActions: string[]
        answerAction: string
      }>
    }>
    matchedRules?: Array<{
      key: string
      goal: string
      source: string
      skillFile?: string | null
      keywords?: string[] | null
      requiredActions: string[]
      answerAction?: string | null
    }>
    suggestedActions?: string[]
  }
}

type ReasoningActionCapability = {
  action: string
  title: string
  tool: string
  category: string
  description: string
  paramsSpec: string[]
  defaultSkipReview: boolean
  requiresHumanReview: boolean
}

type ReasoningToolCapability = {
  tool: string
  title: string
  category: string
  executionMode: string
  reviewPolicy: string
  description: string
  routes: string[]
}

type ReasoningCapabilitySkill = {
  filePath: string
  name: string
  hintCount: number
  actionHints: Array<{
    hintId: string
    keywords: string[]
    requiredActions: string[]
    answerAction: string
  }>
}

type ReasoningCapabilityGuide = {
  filePath: string
  content: string
  exists: boolean
}

type ReasoningCapabilities = {
  runtime: {
    runtimeName: string
    controlPlaneName: string
    workflowTerm: string
    taskGraphTerm: string
    frontend: {
      root: string
      entryFile: string
    }
    backend: {
      root: string
      entryFile: string
    }
    routes: {
      capabilities: string
      submissionPreview: string
      contextDraft: string
      sessions: string
    }
  }
  behaviorChecks: Array<{
    key: string
    label: string
    status: string
    detail: string
  }>
  tools: ReasoningToolCapability[]
  actions: ReasoningActionCapability[]
  skills: ReasoningCapabilitySkill[]
  guide: ReasoningCapabilityGuide
}

type EditableFileRecord = {
  filePath: string
  exists: boolean
  content: string
  sizeChars: number
  updatedAt: string | null
}

type ChatActiveRequest = {
  requestId?: string
  startedAt: string
  activeForMs: number
  promptChars: number
  contextSources?: ChatContextInfo | null
  outboundRequest?: {
    totalMessages: number
    systemMessageCount: number
    replayedMessageCount: number
    userMessageCount: number
    userPromptChars: number
  } | null
}

type ChatRecoveryInfo = {
  attempted: boolean
  ok: boolean
  reason: string
  durationMs?: number
  detail?: string
}

type ChatUiStatus = {
  kind: 'idle' | 'pending' | 'busy' | 'recovering' | 'timeout' | 'error'
  message: string
  activeRequest: ChatActiveRequest | null
  recovery: ChatRecoveryInfo | null
}

type ChatMemoryFileSummary = {
  filePath: string
  exists: boolean
  sizeChars: number
  updatedAt: string | null
}

type MemoryRecordItem = {
  key: string
  label: string
  scope: 'short-term' | 'long-term' | 'context-pool'
  kind: string
  filePath: string
  exists: boolean
  sizeChars: number
  updatedAt: string | null
  lineCount: number
  preview: string
  empty: boolean
  itemCount: number | null
  canOpen: boolean
}

type MemoryClearTarget = {
  value: string
  label: string
  description: string
}

type ReasoningPlanStep = {
  stepId: string
  title: string
  action: string
  tool: string
  params?: Record<string, unknown>
  skipReview?: boolean
  dependsOn: string[]
}

type ReasoningPlan = {
  planId: string
  goal: string
  strategy: string
  steps: ReasoningPlanStep[]
}

type ReasoningEvent = {
  eventId: string
  sessionId: string
  type: string
  timestamp: string
  stepId?: string
  title: string
  summary: string
  data?: Record<string, unknown>
}

type ChatHistoryEntry = {
  role: string
  content: string
  tokens?: any
}

type ReasoningReview = {
  status: 'pending'
  targetType: 'plan' | 'runtime_task_graph' | 'step' | 'completion' | 'answer'
  action?: string | null
  stepId?: string | null
  stepIndex?: number | null
  title: string
  summary: string
  correctionPrompt?: string | null
  iteration?: number
  allowAutoApprove?: boolean
  requiredHumanDecision?: boolean
  requiresApplyOnApprove?: boolean
  evidence?: {
    outboundPreview?: unknown
    rawResponsePreview?: string | null
    structuredResult?: unknown
  } | null
}

type ReasoningStoryIndexItem = {
  projectId: string
  filePath: string
  nodeCount: number
  nodeNames: string[]
}

type ReasoningSession = {
  sessionId: string
  runtimeSessionId?: string | null
  sessionKind?: 'reasoning' | 'agent_runtime'
  agentId: string
  userPrompt: string
  parentSessionId?: string | null
  childSessionIds?: string[]
  status: 'planning' | 'running' | 'waiting_review' | 'completed' | 'failed' | 'cancelled'
  createdAt: string
  updatedAt: string
  plan: ReasoningPlan | null
  runtimeTaskGraph?: ReasoningPlan | null
  currentStepId: string | null
  review?: ReasoningReview | null
  events: ReasoningEvent[]
  artifacts: {
    projectRoot?: string
    storyIndex?: ReasoningStoryIndexItem[]
    finalAnswer?: string
    workspaceStructure?: Record<string, unknown>
    writtenFiles?: Array<Record<string, unknown>>
    pendingWrites?: Record<string, unknown>
    tasks?: Record<string, unknown>
  }
  error?: string | null
}

const ACTIVE_REASONING_SESSION_STORAGE_KEY = 'gamestudio.activeReasoningSessionId'

type ModelInspection = {
  model: string
  accessible: boolean
  status: 'ok' | 'error'
  detail: string
  checkedAt: string
  usage: TokenUsage
  contextLength: number | null
  recommendedMaxOutputTokens: number | null
  tokenizer: string | null
  metadataSource: string
}

type MemoryConfig = {
  sourceFiles: string[]
  agentCount: number
  agents: Array<{
    name: string
    title: string
    agentId: string
    role: string
    personality: string
    responsibilities: string[]
  }>
  agentDefinitionFile: string
  userFile: string
  memoryFile: string
  statusFile: string
  taskQueueFile: string
  decisionsFile: string
  dailyLogDir: string
}

type SkillConfig = {
  skillRoot: string
  skillFiles: string[]
  availableSkillFiles: string[]
  skillCount: number
}

type ConfigReadinessItem = {
  key: string
  label: string
  status: string
  detail: string
}

type ConfigReadiness = {
  ready: boolean
  items: ConfigReadinessItem[]
}

type PreflightCheckItem = {
  key: string
  label: string
  status: string
  detail: string
}

type LocalModelItem = {
  id: string
  created?: number | null
  ownedBy?: string | null
  contextLength?: number | null
  recommendedMaxOutputTokens?: number | null
  tokenizer?: string | null
  metadataSource?: string
}

type PreflightResult = {
  ready: boolean
  checkedAt: string
  checks: PreflightCheckItem[]
  readiness: ConfigReadiness
  logs: string[]
  selectedModel: string
  models: LocalModelItem[]
  provider: string
  baseUrl: string
  inspection?: ModelInspection | null
}

type HermesControlState = {
  config: {
    saved: boolean
    savedAt: string | null
    savedFingerprint: string
    lastSavedModel: string
    detail: string
  }
  model: {
    status: 'unknown' | 'loaded' | 'unloaded' | 'error'
    label: string
    detail: string
    provider: string
    baseUrl: string
    model: string
    inspectedAt: string | null
    loadedAt: string | null
    lastAction: string | null
    inspection: ModelInspection | null
  }
  preflight: {
    ready: boolean
    checkedAt: string | null
    configFingerprint: string
    detail: string
    checks: PreflightCheckItem[]
    inspection: ModelInspection | null
  }
  runtime: {
    state: string
    label: string
    detail: string
    pid: number | null
    updatedAt: string | null
    lastAction: string | null
  }
}

export function useControlConsoleApp() {
  const managerHealth = ref<HealthResponse | null>(null)
  const agentOptions = ref<AgentListItem[]>([])
  const selectedAgentId = ref('')
  const activeAgentId = ref('hermes-manager')
  const agentSelectionLocked = ref(true)
  const selectedAgentLabel = ref('')
  const selfCheck = ref<SelfCheckResponse | null>(null)
  const connecting = ref(false)
  const runtimeBusy = ref(false)
  const error = ref('')
  const healthError = ref('')
  const runtimeState = ref<RuntimeState | null>(null)
  const sandboxPrompt = ref('')
  const dashboardActiveTab = ref('reasoning')
  const brainActiveTab = ref<'left' | 'right'>('left')
  const sandboxBusy = ref(false)
  const chatContextInfo = ref<ChatContextInfo | null>(null)
  const chatUiStatus = ref<ChatUiStatus>({ kind: 'idle', message: '', activeRequest: null, recovery: null })
  const chatMemoryFile = ref<ChatMemoryFileSummary | null>(null)
  const chatMemoryEditorOpen = ref(false)
  const chatMemoryDraft = ref('[]')
  const chatMemoryLoadedContent = ref('[]')
  const chatMemoryBusy = ref(false)
  const chatMemorySaveBusy = ref(false)
  const chatMemoryError = ref('')
  const chatMemorySaveMessage = ref('')
  const chatMemoryOpenBusy = ref(false)
  const chatMemoryOpenMessage = ref('')
  const activeReasoningSession = ref<ReasoningSession | null>(null)
  const reasoningBusy = ref(false)
  const reasoningError = ref('')
  const reasoningStopBusy = ref(false)
  const reasoningReviewBusy = ref(false)
  const reasoningReviewDraft = ref('')
  const reasoningAutoApproveEnabled = ref(false)
  const memoryConfig = ref<MemoryConfig | null>(null)
  const memoryConfigBusy = ref(false)
  const memoryConfigError = ref('')
  const skillConfig = ref<SkillConfig | null>(null)
  const configReadiness = ref<ConfigReadiness | null>(null)
  const configSaving = ref(false)
  const configSaveMessage = ref('')
  const configSaveError = ref('')
  const skillFilesText = ref('')
  const shortTermMinContextTokens = ref(65536)
  const controlState = ref<HermesControlState | null>(null)
  const memoryRecords = ref<MemoryRecordItem[]>([])
  const memoryClearTargets = ref<MemoryClearTarget[]>([])
  const memoryRecordsBusy = ref(false)
  const memoryRecordsError = ref('')
  const memoryClearBusy = ref(false)
  const memoryClearSelection = ref<string[]>([])
  const memoryClearMessage = ref('')
  const memoryRecordBaseline = ref<Record<string, string>>({})
  const memoryRecordUpdatedKeys = ref<Record<string, boolean>>({})
  const persistedLeftBrainConfigSignature = ref('')
  const loadingEngineConfig = ref(false)
  const preflightBusy = ref(false)
  const preflightResult = ref<PreflightResult | null>(null)
  const preflightError = ref('')
  const submitGateOpen = ref(false)
  const submitGateMode = ref<'chat' | 'reasoning' | null>(null)
  const submitPromptDraft = ref('')
  const contextCandidatesBusy = ref(false)
  const contextCandidatesError = ref('')
  const contextSourceCandidates = ref<ContextSourceCandidate[]>([])
  const contextPoolEntries = ref<ContextPoolEntrySummary[]>([])
  const submitSelectedSourceIds = ref<string[]>([])
  const submitSelectedContextPoolIds = ref<string[]>([])
  const submitDraftBusy = ref(false)
  const submitDraftError = ref('')
  const submitDraftResult = ref<ContextDraftResult | null>(null)
  const reasoningCapabilities = ref<ReasoningCapabilities | null>(null)
  const reasoningCapabilitiesBusy = ref(false)
  const reasoningCapabilitiesError = ref('')
  const submitConfirmedSummary = ref('')
  const contextPoolSaveBusy = ref(false)
  const contextPoolSaveMessage = ref('')
  const contextPoolEditorBusy = ref(false)
  const contextPoolEditorError = ref('')
  const contextPoolDeleteBusy = ref(false)
  const selectedContextPoolEntryId = ref('')
  const selectedContextPoolEntry = ref<ContextPoolEntryDetail | null>(null)
  const selectedMemoryRecordKey = ref('')
  const selectedMemoryRecord = ref<MemoryRecordItem | null>(null)
  const selectedContextSourceId = ref('')
  const selectedContextSource = ref<ContextSourceCandidate | null>(null)
  const sourceEditorBusy = ref(false)
  const sourceEditorError = ref('')
  const sourceEditorSaveBusy = ref(false)
  const sourceEditorSaveMessage = ref('')
  const sourceEditorFile = ref<EditableFileRecord | null>(null)
  const sourceEditorContent = ref('')
  const memoryRecordEditorBusy = ref(false)
  const memoryRecordEditorError = ref('')
  const memoryRecordSaveBusy = ref(false)
  const memoryRecordSaveMessage = ref('')
  const memoryRecordFile = ref<EditableFileRecord | null>(null)
  const memoryRecordContent = ref('')
  const contextPoolFile = ref<EditableFileRecord | null>(null)
  const contextPoolFileContent = ref('')
  const contextPoolFileSaveMessage = ref('')
  const editorModalOpen = ref(false)
  const editorModalKind = ref<'source' | 'context-pool' | 'memory-record' | null>(null)
  const editorTheme = [oneDark]
  const leftBrainRunning = ref(false)
  const rightBrainRunning = ref(false)
  const rawLiveLogs = ref('')
  const clearedLogLineCount = ref(0)
  const chatScrollContainer = ref<HTMLElement | null>(null)
  const logContainer = ref<HTMLElement | null>(null)
  const reasoningTimelineRef = ref<HTMLElement | null>(null)
  const chatUiNow = ref(Date.now())
  const leftBrain = ref({ provider: 'omlx', baseUrl: 'http://127.0.0.1:18888/v1', model: '', contextLength: null as number | null, recommendedMaxOutputTokens: null as number | null, tokenizer: null as string | null, metadataSource: 'unavailable' })
  const rightBrain = ref({ provider: 'omlx', baseUrl: 'http://127.0.0.1:18888/v1', model: '', contextLength: null as number | null, recommendedMaxOutputTokens: null as number | null, tokenizer: null as string | null, metadataSource: 'unavailable' })
  const availableLeftModels = ref<any[]>([])
  const availableRightModels = ref<any[]>([])
  const fetchingLeft = ref(false)
  const fetchingRight = ref(false)
  const leftError = ref('')
  const rightError = ref('')
  const leftInspection = ref<ModelInspection | null>(null)
  const rightInspection = ref<ModelInspection | null>(null)
  const inspectingLeft = ref(false)
  const inspectingRight = ref(false)
  const chatHistory = ref<ChatHistoryEntry[]>([])
  let logInterval: ReturnType<typeof setInterval> | null = null
  let chatUiClockInterval: ReturnType<typeof setInterval> | null = null
  let memoryRecordPollInterval: ReturnType<typeof setInterval> | null = null
  let chatHistoryPollTimer: ReturnType<typeof setTimeout> | null = null
  let reasoningPollTimer: ReturnType<typeof setTimeout> | null = null

  const sourceEditorExtensions = computed(() => /\.json$/i.test(selectedContextSource.value?.filePath || '') ? [...editorTheme, json()] : [...editorTheme, markdown()])
  const memoryRecordEditorExtensions = computed(() => /\.json$/i.test(memoryRecordFile.value?.filePath || '') ? [...editorTheme, json()] : [...editorTheme, markdown()])
  const contextPoolEditorExtensions = computed(() => [...editorTheme, json()])
  const sourceEditorDirty = computed(() => sourceEditorContent.value !== (sourceEditorFile.value?.content || ''))
  const memoryRecordDirty = computed(() => memoryRecordContent.value !== (memoryRecordFile.value?.content || ''))
  const contextPoolFileDirty = computed(() => contextPoolFileContent.value !== (contextPoolFile.value?.content || ''))
  const editorModalTitle = computed(() => editorModalKind.value === 'source'
    ? (selectedContextSource.value?.label || '原始上下文文件编辑器')
    : editorModalKind.value === 'context-pool'
      ? (selectedContextPoolEntry.value?.title || '上下文池文件编辑器')
      : editorModalKind.value === 'memory-record'
        ? (selectedMemoryRecord.value?.label || '记忆记录编辑器')
        : '文件编辑器')
  const activeEditorFilePath = computed(() => editorModalKind.value === 'source'
    ? (sourceEditorFile.value?.filePath || '')
    : editorModalKind.value === 'context-pool'
      ? (contextPoolFile.value?.filePath || '')
      : editorModalKind.value === 'memory-record'
        ? (memoryRecordFile.value?.filePath || '')
        : '')
  const visibleLogLines = computed(() => (rawLiveLogs.value ? rawLiveLogs.value.split('\n') : []).slice(clearedLogLineCount.value).filter((line) => line.length > 0))
  const selectedAgent = computed(() => agentOptions.value.find((item) => item.definition.id === selectedAgentId.value) || null)
  const runtimeStatus = computed(() => selectedAgent.value?.definition.runtime === 'openclaw' ? '待开放 (占位)' : runtimeState.value?.label || '未选择')
  const runtimePrimaryAction = computed<'start' | 'pause' | 'resume' | null>(() => {
    const actions = runtimeState.value?.availableActions || []
    if (actions.includes('pause')) return 'pause'
    if (actions.includes('resume')) return 'resume'
    if (actions.includes('start')) return 'start'
    return null
  })
  const runtimeActionLabel = computed(() => runtimePrimaryAction.value === 'pause' ? '暂停引擎' : runtimePrimaryAction.value === 'resume' ? '恢复引擎' : runtimePrimaryAction.value === 'start' ? '启动引擎' : '启动引擎')
  const canAllRestartRuntime = computed(() => Boolean(runtimeState.value?.availableActions?.includes('all-restart')))
  const persistedModelLoaded = computed(() => controlState.value?.model?.status === 'loaded' && controlState.value.model.model === leftBrain.value.model && controlState.value.model.provider === leftBrain.value.provider && controlState.value.model.baseUrl === leftBrain.value.baseUrl)
  const leftSelectedModelLoaded = computed(() => persistedModelLoaded.value || (!!leftBrain.value.model && leftInspection.value?.model === leftBrain.value.model && leftInspection.value?.accessible === true))
  const leftBrainSummary = computed(() => ({ providerLabel: leftBrain.value.provider === 'ollama' ? 'Ollama' : 'OMLX (Local)', baseUrlLabel: leftBrain.value.baseUrl || '默认', modelLabel: leftBrain.value.model || '未选择模型', tokenLabel: leftInspection.value?.usage?.totalTokens ?? '-', statusLabel: leftSelectedModelLoaded.value ? '已启动' : '未启动' }))
  const leftBrainConfigSignature = computed(() => JSON.stringify(buildLeftBrainConfigPayload()))
  const leftBrainConfigSaved = computed(() => !!persistedLeftBrainConfigSignature.value && leftBrainConfigSignature.value === persistedLeftBrainConfigSignature.value && controlState.value?.config?.saved === true)
  const effectivePreflightReady = computed(() => Boolean(preflightResult.value?.ready) || (controlState.value?.preflight?.ready === true && controlState.value.preflight.configFingerprint === leftBrainConfigSignature.value))
  const leftBrainBlockedReason = computed(() => {
    if (memoryConfigBusy.value || configSaving.value || runtimeBusy.value) return '控制面处理中，请稍候。'
    if (!leftBrainConfigSaved.value) return '未保存左脑配置，请先保存。'
    if (!leftSelectedModelLoaded.value) return controlState.value?.model?.detail || '模型未启动，请先加载模型。'
    if (!configReadiness.value?.ready) return '左脑配置校验未通过，请先修复配置项。'
    if (!effectivePreflightReady.value) return controlState.value?.preflight?.detail || '尚未完成左脑自检。'
    return ''
  })
  const chatMemoryDirty = computed(() => chatMemoryDraft.value !== chatMemoryLoadedContent.value)
  const reasoningStatusLabel = computed(() => !activeReasoningSession.value ? '未开始' : activeReasoningSession.value.status === 'planning' ? '构建运行任务中' : activeReasoningSession.value.status === 'running' ? '执行中' : activeReasoningSession.value.status === 'waiting_review' ? '待审核' : activeReasoningSession.value.status === 'completed' ? '已完成' : activeReasoningSession.value.status === 'cancelled' ? '已停止' : '失败')
  const reasoningPendingReview = computed(() => activeReasoningSession.value?.status === 'waiting_review' && activeReasoningSession.value.review ? activeReasoningSession.value.review : null)
  const reasoningReviewTargetLabel = computed(() => {
    const review = reasoningPendingReview.value
    if (!review) return ''
    return review.targetType === 'plan' || review.targetType === 'runtime_task_graph' ? '运行任务审核' : `步骤审核${review.stepIndex != null ? ` #${review.stepIndex + 1}` : ''}`
  })
  const reasoningReviewEvidence = computed(() => reasoningPendingReview.value?.evidence || null)
  const chatActiveRequestElapsedSeconds = computed(() => {
    const activeRequest = chatUiStatus.value.activeRequest
    if (!activeRequest) return 0
    const startedAtMs = new Date(activeRequest.startedAt).getTime()
    if (Number.isNaN(startedAtMs)) return Math.max(0, Math.round(activeRequest.activeForMs / 1000))
    return Math.max(0, Math.round((chatUiNow.value - startedAtMs) / 1000))
  })
  const reasoningElapsedSeconds = computed(() => getReasoningSessionElapsedSeconds(activeReasoningSession.value, chatUiNow.value))
  const reasoningSessionInForeground = computed(() => ['planning', 'running', 'waiting_review'].includes(activeReasoningSession.value?.status || ''))
  const canClearReasoningSession = computed(() => ['completed', 'failed', 'cancelled'].includes(activeReasoningSession.value?.status || ''))
  const showChatStatusBanner = computed(() => chatUiStatus.value.kind !== 'idle' && !reasoningSessionInForeground.value)
  const composerPrefersReasoning = computed(() => dashboardActiveTab.value === 'reasoning')
  const reviewModeLabel = computed(() => reasoningAutoApproveEnabled.value ? '自动审核已开启' : '人工审核模式')
  const primaryComposerActionLabel = computed(() => composerPrefersReasoning.value ? (reasoningBusy.value ? '推理中...' : '开始可观测执行') : (sandboxBusy.value ? '发送中...' : '直接聊天'))
  const secondaryComposerActionLabel = computed(() => composerPrefersReasoning.value ? (sandboxBusy.value ? '直接聊天中...' : '直接聊天') : (reasoningBusy.value ? '推理中...' : '可观测执行'))
  const shortTermMemoryHint = computed(() => String(leftBrain.value.model || '').trim().toLowerCase().includes('gemma-4-26b-a4b') ? 'Gemma-4-26B-A4B 当前 OMLX 配置应填写为：短期记忆最小窗口 65536。该项只校验上下文窗口；最大输出 token 4096 由模型服务配置控制，不在这里填写。' : '这里填写的是模型最小上下文窗口要求。要通过自检，模型的上下文窗口必须大于等于该值；最大输出 token 由模型服务自身配置控制。')

  function buildLeftBrainConfigPayload() {
    return {
      provider: leftBrain.value.provider,
      baseUrl: leftBrain.value.baseUrl,
      model: leftBrain.value.model,
      shortTerm: { minContextTokens: shortTermMinContextTokens.value },
      memory: memoryConfig.value ? {
        agentDefinitionFile: memoryConfig.value.agentDefinitionFile,
        userFile: memoryConfig.value.userFile,
        memoryFile: memoryConfig.value.memoryFile,
        statusFile: memoryConfig.value.statusFile,
        taskQueueFile: memoryConfig.value.taskQueueFile,
        decisionsFile: memoryConfig.value.decisionsFile,
        dailyLogDir: memoryConfig.value.dailyLogDir,
      } : null,
      skills: { skillRoot: skillConfig.value?.skillRoot || '', skillFiles: skillFilesText.value.split(/\r?\n/).map((item) => item.trim()).filter(Boolean) },
      brains: { rightBrainEnabled: false }
    }
  }

  function applyControlState(state: HermesControlState | null | undefined) {
    if (!state) return
    controlState.value = state
    leftBrainRunning.value = state.runtime?.state === 'running'
    if (state.model?.inspection) leftInspection.value = state.model.inspection
    else if (state.preflight?.inspection) leftInspection.value = state.preflight.inspection
  }

  function resetPreflightState() {
    preflightResult.value = null
    preflightError.value = ''
  }

  function getChineseCheckLabel(key: string) {
    const map: Record<string, string> = {
      'hermes-install': 'Hermes 安装检测',
      'mcp-connection': 'MCP 协议连接池',
      'python-env': 'Python 运行时环境',
      'workspace-access': '工作区读写权限',
      'model-route': 'LLM 模型路由',
      'agent-memory': 'Agent 记忆配置',
      'context-window': '短期记忆窗口',
      'skill-library': '技能库配置',
      'startup-config': '启动配置完整性',
      'omlx-service': 'OMLX 服务检测',
      'model-selection': '模型选择检测',
      'active-inference': '主动推理检测',
      'model-provider': '推理平台',
      'model-base-url': '服务地址',
      'model-name': '模型名称',
      'short-term-context': '短期记忆窗口',
      'memory-agent-definition': 'Agent 定义文件',
      'memory-user-file': '用户记忆文件',
      'memory-memory-file': '项目记忆文件',
      'memory-status-file': '状态文件',
      'memory-task-queue-file': '任务队列文件',
      'memory-decisions-file': '决策文件',
      'memory-daily-log-dir': '日志目录',
      'skills-root': '技能根目录',
      'skills-files': '技能文件',
      'runtime-read-observe': '工作区观察能力',
      'runtime-write-review': '工作区写入能力',
      'runtime-script-review': '脚本执行能力',
      'runtime-context-draft': '上下文提取与压缩',
      'runtime-context-summary-injection': '确认摘要注入运行链',
      'runtime-session-loop': '任务执行闭环'
    }
    return map[key] || key
  }

  function getLogLineColor(line: string) {
    if (line.includes('[ERROR]') || line.includes('ERROR') || line.includes('失败') || line.includes('异常')) return 'var(--c-error-dim)'
    if (line.includes('[OK]') || line.includes('OK')) return 'var(--c-success-dim)'
    return '#d7e3d8'
  }

  function syncEngineMetadataFromSelection(side: 'left' | 'right') {
    const brain = side === 'left' ? leftBrain : rightBrain
    const avail = side === 'left' ? availableLeftModels : availableRightModels
    const selected = avail.value.find((item: LocalModelItem) => item.id === brain.value.model) || null
    if (!selected) {
      brain.value.contextLength = null
      brain.value.recommendedMaxOutputTokens = null
      brain.value.tokenizer = null
      brain.value.metadataSource = 'unavailable'
      return
    }
    brain.value.contextLength = selected.contextLength ?? null
    brain.value.recommendedMaxOutputTokens = selected.recommendedMaxOutputTokens ?? null
    brain.value.tokenizer = selected.tokenizer ?? null
    brain.value.metadataSource = selected.metadataSource || 'unavailable'
  }

  function formatReasoningEvidence(value: unknown) {
    if (value == null) return ''
    if (typeof value === 'string') return value
    try { return JSON.stringify(value, null, 2) } catch { return String(value) }
  }

  function parseStructuredOutboundPreview(value: unknown): StructuredOutboundPreview | null {
    if (!value || typeof value !== 'object') return null
    const preview = value as StructuredOutboundPreview
    if (!preview.controllerRequest && !preview.runtimeRoute && !preview.plannerHints) return null
    return preview
  }

  function getPreviewControllerRequest(value: unknown) { return parseStructuredOutboundPreview(value)?.controllerRequest || null }
  function getPreviewRuntimeRoute(value: unknown) { return parseStructuredOutboundPreview(value)?.runtimeRoute || null }
  function getPreviewPlannerHints(value: unknown) { return parseStructuredOutboundPreview(value)?.plannerHints || null }
  function formatActionHintLine(hint: { keywords: string[]; requiredActions: string[]; answerAction: string }) { return `${hint.keywords.join(' | ')} => ${[...hint.requiredActions, hint.answerAction].filter(Boolean).join(', ')}` }
  function validateJsonEditorContent(filePath: string, content: string) { if (/\.json$/i.test(filePath)) JSON.parse(content) }
  function clearVisibleLogs() { clearedLogLineCount.value = (rawLiveLogs.value ? rawLiveLogs.value.split('\n').filter((line) => line.length > 0) : []).length }
  function getMemoryRecordVersion(record: MemoryRecordItem) { return `${record.exists ? '1' : '0'}:${record.updatedAt || 'null'}:${record.sizeChars}:${record.itemCount ?? ''}` }
  function resetMemoryRecordState() {
    memoryRecords.value = []
    memoryClearTargets.value = []
    memoryRecordsError.value = ''
    memoryClearMessage.value = ''
    memoryRecordUpdatedKeys.value = {}
    memoryRecordBaseline.value = {}
    memoryClearSelection.value = []
  }
  function syncMemoryClearSelection() {
    const availableValues = new Set(memoryClearTargets.value.map((item) => item.value))
    const nextSelection = memoryClearSelection.value.filter((value) => availableValues.has(value))
    memoryClearSelection.value = nextSelection
  }
  function applyMemoryRecords(records: MemoryRecordItem[]) {
    const baseline = { ...memoryRecordBaseline.value }
    const updatedKeys: Record<string, boolean> = {}
    for (const record of records) {
      const version = getMemoryRecordVersion(record)
      if (!(record.key in baseline)) baseline[record.key] = version
      updatedKeys[record.key] = baseline[record.key] !== version
    }
    memoryRecordBaseline.value = baseline
    memoryRecordUpdatedKeys.value = updatedKeys
    memoryRecords.value = records
  }
  function isMemoryRecordUpdated(recordKey: string) { return Boolean(memoryRecordUpdatedKeys.value[recordKey]) }
  function getMemoryRecordStatusLabel(record: MemoryRecordItem) {
    if (!record.exists) return '缺失'
    if (isMemoryRecordUpdated(record.key)) return '有更新'
    if (record.empty) return '空'
    if ((record.itemCount ?? 0) > 0 && record.scope !== 'long-term') return `${record.itemCount} 项`
    return '正常'
  }
  function getMemoryRecordStatusTone(record: MemoryRecordItem) {
    if (!record.exists) return 'var(--c-error-dim)'
    if (isMemoryRecordUpdated(record.key)) return 'var(--c-accent)'
    if (record.empty) return 'var(--c-text-muted)'
    return 'var(--c-success-dim)'
  }
  function resetChatUiStatus() { chatUiStatus.value = { kind: 'idle', message: '', activeRequest: null, recovery: null } }
  function persistActiveReasoningSessionId(sessionId: string | null) {
    if (typeof window === 'undefined') return
    if (sessionId) window.localStorage.setItem(ACTIVE_REASONING_SESSION_STORAGE_KEY, sessionId)
    else window.localStorage.removeItem(ACTIVE_REASONING_SESSION_STORAGE_KEY)
  }
  function readPersistedActiveReasoningSessionId() { return typeof window === 'undefined' ? '' : (window.localStorage.getItem(ACTIVE_REASONING_SESSION_STORAGE_KEY) || '') }
  function syncReasoningSessionUi(session: ReasoningSession | null) {
    const normalizedSession = session ? {
      ...session,
      runtimeSessionId: session.runtimeSessionId ?? session.sessionId,
      sessionKind: session.sessionKind ?? 'agent_runtime',
      runtimeTaskGraph: session.runtimeTaskGraph ?? session.plan,
      plan: session.runtimeTaskGraph ?? session.plan,
    } : null
    activeReasoningSession.value = normalizedSession
    persistActiveReasoningSessionId(normalizedSession?.sessionId || null)
    reasoningBusy.value = Boolean(normalizedSession && (normalizedSession.status === 'planning' || normalizedSession.status === 'running'))
  }
  function stopChatHistoryPolling() { if (chatHistoryPollTimer) { clearTimeout(chatHistoryPollTimer); chatHistoryPollTimer = null } }
  function stopReasoningPolling() { if (reasoningPollTimer) { clearTimeout(reasoningPollTimer); reasoningPollTimer = null } }
  function closeSubmitGate() { submitGateOpen.value = false; submitGateMode.value = null }
  function closeEditorModal() { editorModalOpen.value = false; editorModalKind.value = null }
  function focusActiveEditorInModal() {
    void nextTick(() => {
      const editor = document.querySelector('.editor-modal-shell .cm-content') as HTMLElement | null
      if (editor) editor.focus()
      else (document.querySelector('.editor-modal-shell') as HTMLElement | null)?.focus()
    })
  }
  function openEditorModal(kind: 'source' | 'context-pool' | 'memory-record') { editorModalKind.value = kind; editorModalOpen.value = true; focusActiveEditorInModal() }
  async function saveActiveEditorModal() {
    if (editorModalKind.value === 'source') await saveContextSourceFile()
    else if (editorModalKind.value === 'memory-record') await saveMemoryRecordFile()
    else if (editorModalKind.value === 'context-pool') await saveContextPoolEntryEdits()
  }
  function handleEditorModalWindowKeydown(event: KeyboardEvent) {
    if (!editorModalOpen.value) return
    const target = event.target as HTMLElement | null
    if (!target?.closest('.editor-modal-shell')) return
    const lowerKey = String(event.key || '').toLowerCase()
    const metaCombo = event.metaKey || event.ctrlKey
    if (event.key === 'Tab' && !target?.closest('.cm-editor')) {
      event.preventDefault(); event.stopPropagation(); focusActiveEditorInModal(); return
    }
    if (!metaCombo) return
    if (['s', 'w', 'p', 'l'].includes(lowerKey)) { event.preventDefault(); event.stopPropagation() }
    if (lowerKey === 's') void saveActiveEditorModal()
    if (lowerKey === 'w') closeEditorModal()
  }
  function resetSubmitGateState() {
    submitDraftBusy.value = false
    submitDraftError.value = ''
    submitDraftResult.value = null
    submitConfirmedSummary.value = ''
    contextPoolSaveBusy.value = false
    contextPoolSaveMessage.value = ''
  }
  function handleChatComposerKeydown(event: KeyboardEvent) {
    if (event.key !== 'Enter') return
    if (event.metaKey || event.ctrlKey) {
      event.preventDefault()
      if (composerPrefersReasoning.value) void sendObservableReasoningChat()
      else void sendChat()
    }
  }

  watch(visibleLogLines, async () => {
    if (!logContainer.value) return
    await nextTick()
    const container = logContainer.value
    if (!container) return
    container.scrollTop = container.scrollHeight
  })
  watch(() => activeReasoningSession.value?.events?.length, async () => {
    if (!reasoningTimelineRef.value) return
    await nextTick()
    const timeline = reasoningTimelineRef.value
    if (!timeline) return
    timeline.scrollTop = timeline.scrollHeight
  })
  watch(chatHistory, async () => {
    if (!chatScrollContainer.value) return
    await nextTick()
    const container = chatScrollContainer.value
    if (!container) return
    container.scrollTop = container.scrollHeight
  }, { deep: true })
  watch(editorModalOpen, (isOpen) => { document.body.style.overflow = isOpen ? 'hidden' : ''; if (isOpen) focusActiveEditorInModal() })
  watch(leftBrainConfigSignature, (nextValue, previousValue) => { if (!previousValue || loadingEngineConfig.value || nextValue === previousValue) return; configSaveMessage.value = ''; configSaveError.value = ''; resetPreflightState() })

  async function fetchLogs() {
    if (!selectedAgentId.value) return
    try {
      const res = await getAgentLogs(selectedAgentId.value)
      const data = await res.json()
      if (data.ok) {
        rawLiveLogs.value = data.logs
        const currentLineCount = rawLiveLogs.value ? rawLiveLogs.value.split('\n').filter((line: string) => line.length > 0).length : 0
        if (currentLineCount < clearedLogLineCount.value) clearedLogLineCount.value = 0
      }
    } catch {}
  }

  async function actOnModel(side: 'left' | 'right', action: 'load' | 'unload') {
    const brain = side === 'left' ? leftBrain.value : rightBrain.value
    if (!brain.model) return
    const isLeft = side === 'left'
    if (isLeft) inspectingLeft.value = true
    else inspectingRight.value = true
    try {
      const res = await runModelAction(action, { model: brain.model, provider: brain.provider, baseUrl: brain.baseUrl })
      const payload = await res.json().catch(() => null)
      if (!res.ok) throw new Error(payload?.error || `model_${action}_http_${res.status}`)
      if (isLeft) applyControlState(payload?.state || null)
      if (action === 'unload') {
        if (isLeft && leftInspection.value) leftInspection.value.accessible = false
        if (!isLeft && rightInspection.value) rightInspection.value.accessible = false
      } else {
        await inspectSelectedModel(side)
      }
      await fetchLogs()
    } catch (caught) {
      if (isLeft) leftError.value = String(caught)
      else rightError.value = String(caught)
      await fetchLogs()
    }
    if (isLeft) inspectingLeft.value = false
    else inspectingRight.value = false
  }

  async function fetchLocalModels(side: 'left' | 'right') {
    const brain = side === 'left' ? leftBrain : rightBrain
    const fetching = side === 'left' ? fetchingLeft : fetchingRight
    const avail = side === 'left' ? availableLeftModels : availableRightModels
    const err = side === 'left' ? leftError : rightError
    fetching.value = true
    err.value = ''
    if (side === 'left') resetPreflightState()
    try {
      const resp = await listLocalModels({ provider: brain.value.provider === 'ollama' ? 'ollama' : 'omlx', baseUrl: brain.value.baseUrl })
      if (resp.ok) {
        const data = await resp.json()
        if (data.ok) {
          avail.value = data.models as LocalModelItem[]
          if (data.models.length > 0 && !data.models.find((model: LocalModelItem) => model.id === brain.value.model)) brain.value.model = data.models[0].id
          else if (data.models.length === 0) { brain.value.model = ''; err.value = '请启动推理模型（OMLX），然后刷新模型列表。' }
          syncEngineMetadataFromSelection(side)
          if (brain.value.model) await inspectSelectedModel(side)
          else (side === 'left' ? leftInspection : rightInspection).value = null
        } else {
          avail.value = []
          err.value = data.error || '模型列表获取失败'
        }
      } else {
        avail.value = []
        err.value = 'http_' + resp.status
      }
    } catch (caught) {
      avail.value = []
      err.value = String(caught)
    } finally {
      fetching.value = false
    }
  }

  async function inspectSelectedModel(side: 'left' | 'right') {
    const brain = side === 'left' ? leftBrain : rightBrain
    const inspection = side === 'left' ? leftInspection : rightInspection
    const inspecting = side === 'left' ? inspectingLeft : inspectingRight
    if (!brain.value.model) { inspection.value = null; return }
    inspecting.value = true
    try {
      const response = await inspectLocalModel({ provider: brain.value.provider === 'ollama' ? 'ollama' : 'omlx', model: brain.value.model, baseUrl: brain.value.baseUrl })
      if (!response.ok) throw new Error('inspect_' + response.status)
      const payload = await response.json()
      inspection.value = payload.inspection || null
      if (side === 'left' && payload.state) applyControlState(payload.state)
    } catch (caught) {
      inspection.value = {
        model: brain.value.model,
        accessible: false,
        status: 'error',
        detail: String(caught),
        checkedAt: new Date().toISOString(),
        usage: { promptTokens: null, completionTokens: null, totalTokens: null },
        contextLength: brain.value.contextLength,
        recommendedMaxOutputTokens: brain.value.recommendedMaxOutputTokens,
        tokenizer: brain.value.tokenizer,
        metadataSource: brain.value.metadataSource
      }
    } finally {
      inspecting.value = false
    }
  }

  function handleProviderChange(side: 'left' | 'right') {
    const brain = side === 'left' ? leftBrain : rightBrain
    brain.value.baseUrl = brain.value.provider === 'ollama' ? 'http://127.0.0.1:11434/v1' : 'http://127.0.0.1:18888/v1'
    brain.value.model = ''
    if (side === 'left') { resetPreflightState(); availableLeftModels.value = []; leftInspection.value = null }
    else { availableRightModels.value = []; rightInspection.value = null }
    void fetchLocalModels(side)
  }

  function handleModelChange(side: 'left' | 'right') {
    if (side === 'left') resetPreflightState()
    syncEngineMetadataFromSelection(side)
    void inspectSelectedModel(side)
  }

  async function loadEngineConfig() {
    memoryConfigBusy.value = true
    loadingEngineConfig.value = true
    try {
      const response = await getAgentConfig(selectedAgentId.value)
      if (!response.ok) {
        controlState.value = null
        memoryConfig.value = null
        skillConfig.value = null
        configReadiness.value = null
        persistedLeftBrainConfigSignature.value = ''
        resetPreflightState()
        memoryConfigError.value = `config_http_${response.status}`
        return
      }
      const payload = await response.json()
      if (!payload.ok) {
        memoryConfigError.value = payload.error || 'config_payload_not_ok'
        return
      }
      leftBrain.value.provider = payload.config.provider
      leftBrain.value.baseUrl = payload.config.baseUrl
      leftBrain.value.model = payload.config.model
      rightBrain.value.provider = payload.config.provider
      rightBrain.value.baseUrl = payload.config.baseUrl
      rightBrain.value.model = payload.config.model
      rightBrainRunning.value = false
      memoryConfig.value = payload.config.memory || null
      skillConfig.value = payload.config.skills || null
      configReadiness.value = payload.config.readiness || null
      applyControlState(payload.config.state || null)
      shortTermMinContextTokens.value = payload.config.shortTerm?.minContextTokens || 65536
      skillFilesText.value = (payload.config.skills?.skillFiles || []).join('\n')
      persistedLeftBrainConfigSignature.value = JSON.stringify({
        provider: payload.config.provider,
        baseUrl: payload.config.baseUrl,
        model: payload.config.model,
        shortTerm: { minContextTokens: payload.config.shortTerm?.minContextTokens || 65536 },
        memory: payload.config.memory ? {
          agentDefinitionFile: payload.config.memory.agentDefinitionFile,
          userFile: payload.config.memory.userFile,
          memoryFile: payload.config.memory.memoryFile,
          statusFile: payload.config.memory.statusFile,
          taskQueueFile: payload.config.memory.taskQueueFile,
          decisionsFile: payload.config.memory.decisionsFile,
          dailyLogDir: payload.config.memory.dailyLogDir
        } : null,
        skills: { skillRoot: payload.config.skills?.skillRoot || '', skillFiles: payload.config.skills?.skillFiles || [] },
        brains: { rightBrainEnabled: false }
      })
      resetPreflightState()
      memoryConfigError.value = ''
      configSaveMessage.value = ''
      configSaveError.value = ''
      await fetchLocalModels('left')
      try {
        await loadMemoryRecords()
      } catch {
        // Keep the already loaded left-brain config visible even if record diagnostics fail.
      }
    } catch (caught) {
      controlState.value = null
      memoryConfig.value = null
      skillConfig.value = null
      configReadiness.value = null
      persistedLeftBrainConfigSignature.value = ''
      resetMemoryRecordState()
      resetPreflightState()
      memoryConfigError.value = String(caught)
    } finally {
      loadingEngineConfig.value = false
      memoryConfigBusy.value = false
    }
  }

  async function saveLeftBrainConfig() {
    if (!memoryConfig.value || !skillConfig.value || !selectedAgentId.value) return
    configSaving.value = true
    configSaveError.value = ''
    configSaveMessage.value = ''
    try {
      const response = await saveAgentConfig(selectedAgentId.value, buildLeftBrainConfigPayload())
      const payload = await response.json().catch(() => null)
      if (!response.ok || !payload?.ok) throw new Error(payload?.error || `save_config_http_${response.status}`)
      applyControlState(payload.state || null)
      await loadEngineConfig()
      configSaveMessage.value = '已保存左脑配置。'
      resetPreflightState()
    } catch (caught) {
      configSaveError.value = String(caught)
    } finally {
      configSaving.value = false
    }
  }

  async function loadMemoryRecords() {
    if (!selectedAgentId.value) return
    const showBusy = memoryRecords.value.length === 0
    if (showBusy) memoryRecordsBusy.value = true
    try {
      const response = await getAgentMemoryRecords(selectedAgentId.value)
      const payload = await response.json().catch(() => null)
      if (!response.ok || !payload?.ok) throw new Error(payload?.error || `memory_records_http_${response.status}`)
      applyMemoryRecords(Array.isArray(payload.records) ? payload.records : [])
      memoryClearTargets.value = Array.isArray(payload.clearTargets) ? payload.clearTargets : []
      syncMemoryClearSelection()
      memoryRecordsError.value = ''
    } catch (caught) {
      memoryRecordsError.value = caught instanceof Error ? caught.message : String(caught)
    } finally {
      memoryRecordsBusy.value = false
    }
  }

  async function openMemoryRecordInEditor(recordKey: string) {
    if (!selectedAgentId.value || !recordKey) return
    memoryRecordEditorBusy.value = true
    memoryRecordsError.value = ''
    memoryRecordEditorError.value = ''
    memoryRecordSaveMessage.value = ''
    try {
      const response = await getAgentMemoryRecordFile(selectedAgentId.value, recordKey)
      const payload = await response.json().catch(() => null)
      if (!response.ok || !payload?.ok || !payload?.file) throw new Error(payload?.error || `memory_record_file_get_http_${response.status}`)
      selectedMemoryRecordKey.value = recordKey
      selectedMemoryRecord.value = memoryRecords.value.find((item) => item.key === recordKey) || payload.record || null
      memoryRecordFile.value = payload.file
      memoryRecordContent.value = payload.file.content || ''
      openEditorModal('memory-record')
    } catch (caught) {
      memoryRecordEditorError.value = caught instanceof Error ? caught.message : String(caught)
    } finally {
      memoryRecordEditorBusy.value = false
    }
  }

  async function saveMemoryRecordFile() {
    if (!selectedAgentId.value || !selectedMemoryRecordKey.value || !memoryRecordFile.value) return
    memoryRecordSaveBusy.value = true
    memoryRecordEditorError.value = ''
    memoryRecordSaveMessage.value = ''
    try {
      validateJsonEditorContent(memoryRecordFile.value.filePath || '', memoryRecordContent.value)
      const response = await saveAgentMemoryRecordFile(selectedAgentId.value, { recordKey: selectedMemoryRecordKey.value, content: memoryRecordContent.value })
      const payload = await response.json().catch(() => null)
      if (!response.ok || !payload?.ok || !payload?.file) throw new Error(payload?.error || `memory_record_file_put_http_${response.status}`)
      selectedMemoryRecord.value = memoryRecords.value.find((item) => item.key === selectedMemoryRecordKey.value) || payload.record || selectedMemoryRecord.value
      memoryRecordFile.value = payload.file
      memoryRecordContent.value = payload.file.content || ''
      memoryRecordSaveMessage.value = '记忆记录已保存。'
      await loadMemoryRecords()
    } catch (caught) {
      memoryRecordEditorError.value = caught instanceof Error ? caught.message : String(caught)
    } finally {
      memoryRecordSaveBusy.value = false
    }
  }

  async function clearMemoryRecords(targets: string[]) {
    const normalizedTargets = Array.from(new Set(targets.map((item) => String(item || '').trim()).filter(Boolean)))
    if (!selectedAgentId.value || normalizedTargets.length === 0 || memoryClearBusy.value) return
    memoryClearBusy.value = true
    memoryRecordsError.value = ''
    memoryClearMessage.value = ''
    try {
      const response = await clearAgentMemoryRecords(selectedAgentId.value, { targets: normalizedTargets })
      const payload = await response.json().catch(() => null)
      if (!response.ok || !payload?.ok) throw new Error(payload?.error || `clear_memory_records_http_${response.status}`)
      applyMemoryRecords(Array.isArray(payload.records) ? payload.records : [])
      memoryClearTargets.value = Array.isArray(payload.clearTargets) ? payload.clearTargets : memoryClearTargets.value
      syncMemoryClearSelection()
      memoryClearMessage.value = payload.message || '已清空所选记录。'
      if (normalizedTargets.includes('context-pool') || normalizedTargets.includes('all-test-records')) {
        selectedContextPoolEntryId.value = ''
        selectedContextPoolEntry.value = null
        contextPoolFile.value = null
        contextPoolFileContent.value = ''
        contextPoolFileSaveMessage.value = ''
        contextPoolEditorError.value = ''
      }
      if (normalizedTargets.includes('all-test-records')) {
        selectedMemoryRecordKey.value = ''
        selectedMemoryRecord.value = null
        memoryRecordFile.value = null
        memoryRecordContent.value = ''
        memoryRecordSaveMessage.value = ''
        memoryRecordEditorError.value = ''
      }
      await Promise.all([
        loadChatHistory(),
        loadContextCandidates(),
        fetchLogs(),
        chatMemoryEditorOpen.value ? loadChatMemoryFile() : Promise.resolve(),
      ])
    } catch (caught) {
      memoryRecordsError.value = caught instanceof Error ? caught.message : String(caught)
    } finally {
      memoryClearBusy.value = false
    }
  }

  async function clearSelectedMemoryRecords() {
    await clearMemoryRecords(memoryClearSelection.value)
  }

  async function clearAllMemoryRecords() {
    await clearMemoryRecords(['all-test-records'])
  }

  async function runLeftBrainPreflight() {
    if (!selectedAgentId.value) return
    preflightBusy.value = true
    preflightError.value = ''
    error.value = ''
    try {
      const response = await runPreflightCheck(selectedAgentId.value, { config: buildLeftBrainConfigPayload() })
      const payload = await response.json().catch(() => null)
      if (!response.ok || !payload?.ok) throw new Error(payload?.error || `preflight_http_${response.status}`)
      applyControlState(payload.state || null)
      preflightResult.value = payload.preflight || null
      configReadiness.value = payload.preflight?.readiness || configReadiness.value
      if (payload.preflight?.selectedModel) leftBrain.value.model = payload.preflight.selectedModel
      if (Array.isArray(payload.preflight?.models)) { availableLeftModels.value = payload.preflight.models; syncEngineMetadataFromSelection('left') }
      if (payload.preflight?.inspection) leftInspection.value = payload.preflight.inspection
      if (!payload.preflight?.ready) preflightError.value = '左脑自检未通过，请先修复红色项后再启动。'
      await fetchLogs()
    } catch (caught) {
      preflightResult.value = null
      preflightError.value = caught instanceof Error ? caught.message : String(caught)
    } finally {
      preflightBusy.value = false
    }
  }

  async function refreshHermesRuntimeState() {
    const response = await getRuntimeStatus('hermes-manager')
    if (!response.ok) throw new Error(`runtime_status_http_${response.status}`)
    const payload = await response.json()
    runtimeState.value = payload.runtimeStatus
    applyControlState(payload.state)
  }
  async function loadHermesRuntimeStatus() { await refreshHermesRuntimeState() }

  async function loadReasoningCapabilities() {
    reasoningCapabilitiesBusy.value = true
    reasoningCapabilitiesError.value = ''
    try {
      const response = await getReasoningCapabilities('hermes-manager')
      const payload = await response.json().catch(() => null)
      if (!response.ok || !payload?.ok || !payload?.capabilities) throw new Error(payload?.error || `reasoning_capabilities_http_${response.status}`)
      reasoningCapabilities.value = payload.capabilities
    } catch (caught) {
      reasoningCapabilitiesError.value = caught instanceof Error ? caught.message : String(caught)
    } finally {
      reasoningCapabilitiesBusy.value = false
    }
  }

  async function loadHermesSelfCheck() {
    connecting.value = true
    error.value = ''
    try {
      const response = await getSelfCheck('hermes-manager')
      if (!response.ok) {
        if (response.status === 409) runtimeState.value = (await response.json()).runtimeStatus || runtimeState.value
        throw new Error(`self_check_http_${response.status}`)
      }
      selfCheck.value = (await response.json()).selfCheck
    } catch (caught) {
      selfCheck.value = null
      error.value = caught instanceof Error ? caught.message : String(caught)
    } finally {
      connecting.value = false
    }
  }

  async function connectSelectedAgent() {
    if (agentSelectionLocked.value && activeAgentId.value && selectedAgentId.value !== activeAgentId.value) {
      selectedAgentId.value = activeAgentId.value
      error.value = '当前 control 已锁定全局管理器为 Hermes，不能在新标签页重新创建另一个管理器。'
    }
    if (!selectedAgentId.value) {
      selfCheck.value = null
      runtimeState.value = null
      controlState.value = null
      memoryConfig.value = null
      skillConfig.value = null
      configReadiness.value = null
      memoryConfigError.value = ''
      configSaveMessage.value = ''
      configSaveError.value = ''
      reasoningCapabilities.value = null
      reasoningCapabilitiesError.value = ''
      resetMemoryRecordState()
      skillFilesText.value = ''
      resetPreflightState()
      selectedAgentLabel.value = ''
      error.value = ''
      return
    }
    const agent = agentOptions.value.find((item) => item.definition.id === selectedAgentId.value)
    selectedAgentLabel.value = agent?.definition.name || selectedAgentId.value
    if (agent?.definition.runtime !== 'hermes') {
      selfCheck.value = null
      runtimeState.value = null
      controlState.value = null
      memoryConfig.value = null
      skillConfig.value = null
      configReadiness.value = null
      memoryConfigError.value = ''
      reasoningCapabilities.value = null
      reasoningCapabilitiesError.value = ''
      resetMemoryRecordState()
      resetPreflightState()
      error.value = ''
      return
    }
    await loadEngineConfig()
    await loadMemoryRecords()
    await loadReasoningCapabilities()
    await loadChatHistory()
    await loadHermesRuntimeStatus()
    await restoreBufferedReasoningSession()
    if (runtimeState.value?.state === 'running') await loadHermesSelfCheck()
    else selfCheck.value = null
  }

  async function toggleHermesRuntime(side: 'left' | 'right') {
    if (!selectedAgent.value || selectedAgent.value.definition.runtime !== 'hermes' || side === 'right') return
    if (!leftBrainRunning.value && !leftBrainConfigSaved.value) { error.value = leftBrainBlockedReason.value || '请先保存左脑配置，保存生效后再启动 Hermes。'; return }
    if (!leftBrainRunning.value && !leftSelectedModelLoaded.value) { error.value = leftBrainBlockedReason.value || '请先成功加载并探测左脑模型后再启动 Hermes。'; return }
    if (!leftBrainRunning.value && !effectivePreflightReady.value) { error.value = leftBrainBlockedReason.value || '请先完成左脑自检，再启动 Hermes。'; return }
    runtimeBusy.value = true
    error.value = ''
    try {
      const action = leftBrainRunning.value ? 'stop' : 'start'
      const payloadBody: any = { action, brainSide: side, stopAll: action === 'stop' }
      if (action === 'start') payloadBody.config = { side, ...buildLeftBrainConfigPayload() }
      const response = await runRuntimeAction('hermes-manager', payloadBody)
      const payload = await response.json().catch(() => null)
      if (!response.ok) {
        if (payload?.preflight) preflightResult.value = payload.preflight
        if (payload?.readiness) configReadiness.value = payload.readiness
        if (payload?.state) applyControlState(payload.state)
        const readinessMessage = payload?.readiness?.items?.filter((item: ConfigReadinessItem) => item.status !== 'ok').map((item: ConfigReadinessItem) => `${item.label}: ${item.detail}`).join(' | ')
        throw new Error(readinessMessage || payload?.error || `runtime_action_http_${response.status}`)
      }
      if (payload?.ok) {
        runtimeState.value = payload.runtimeStatus
        applyControlState(payload.state || null)
        leftBrainRunning.value = payload.runtimeStatus?.state === 'running'
      }
      await fetchLogs()
    } catch (caught) {
      error.value = String(caught)
      await fetchLogs()
    } finally {
      runtimeBusy.value = false
    }
  }

  async function executeGlobalRuntimeAction(action: 'start' | 'pause' | 'resume' | 'all-restart') {
    if (!selectedAgent.value || selectedAgent.value.definition.runtime !== 'hermes' || !runtimeState.value) return
    if (runtimeState.value.state === 'uninstalled') { error.value = runtimeState.value.detail; return }
    runtimeBusy.value = true
    error.value = ''
    try {
      if ((action === 'start' || action === 'resume' || action === 'all-restart') && !leftBrainConfigSaved.value) { error.value = leftBrainBlockedReason.value || '请先保存左脑配置，保存生效后再启动 Hermes。'; return }
      if ((action === 'start' || action === 'resume' || action === 'all-restart') && !leftSelectedModelLoaded.value) { error.value = leftBrainBlockedReason.value || '请先成功加载并探测左脑模型后再启动 Hermes。'; return }
      if ((action === 'start' || action === 'resume' || action === 'all-restart') && !effectivePreflightReady.value) { error.value = leftBrainBlockedReason.value || '请先完成左脑自检，再启动 Hermes。'; return }
      const payloadBody: any = { action, brainSide: 'left', stopAll: true }
      if (action === 'start' || action === 'resume' || action === 'all-restart') payloadBody.config = { side: 'left', ...buildLeftBrainConfigPayload() }
      const response = await runRuntimeAction('hermes-manager', payloadBody)
      const payload = await response.json().catch(() => null)
      if (!response.ok) {
        if (payload?.preflight) preflightResult.value = payload.preflight
        if (payload?.readiness) configReadiness.value = payload.readiness
        if (payload?.state) applyControlState(payload.state)
        const readinessMessage = payload?.readiness?.items?.filter((item: ConfigReadinessItem) => item.status !== 'ok').map((item: ConfigReadinessItem) => `${item.label}: ${item.detail}`).join(' | ')
        throw new Error(readinessMessage || payload?.error || `runtime_action_http_${response.status}`)
      }
      if (action === 'all-restart' && payload?.ok && payload?.restartingControl) {
        runtimeState.value = payload.runtimeStatus || runtimeState.value
        applyControlState(payload.state || null)
        error.value = 'Control 与 Hermes 正在整体重启，页面会短暂断开并自动恢复。'
        globalThis.setTimeout(() => { window.location.reload() }, 4000)
        return
      }
      if (payload?.ok) {
        runtimeState.value = payload.runtimeStatus
        applyControlState(payload.state || null)
        if (action === 'start' || action === 'resume') { leftBrainRunning.value = true; await loadHermesSelfCheck() }
        else { leftBrainRunning.value = false; rightBrainRunning.value = false; selfCheck.value = null }
      }
      await fetchLogs()
    } catch (caught) {
      error.value = String(caught)
      await fetchLogs()
    } finally {
      runtimeBusy.value = false
    }
  }
  async function toggleGlobalRuntime() { if (!runtimePrimaryAction.value) { error.value = 'runtime_action_unavailable'; return }; await executeGlobalRuntimeAction(runtimePrimaryAction.value) }
  async function restartGlobalRuntime() { await executeGlobalRuntimeAction('all-restart') }

  async function loadContextCandidates() {
    contextCandidatesBusy.value = true
    contextCandidatesError.value = ''
    try {
      const response = await getContextCandidates('hermes-manager')
      const payload = await response.json().catch(() => null)
      if (!response.ok || !payload?.ok) throw new Error(payload?.error || `context_candidates_http_${response.status}`)
      contextSourceCandidates.value = Array.isArray(payload.sources) ? payload.sources : []
      contextPoolEntries.value = Array.isArray(payload.contextPoolEntries) ? payload.contextPoolEntries : []
    } catch (caught) {
      contextCandidatesError.value = caught instanceof Error ? caught.message : String(caught)
    } finally {
      contextCandidatesBusy.value = false
    }
  }

  async function openSubmitGate(mode: 'chat' | 'reasoning') {
    const prompt = sandboxPrompt.value.trim()
    if (!prompt) return
    submitGateOpen.value = true
    submitGateMode.value = mode
    submitPromptDraft.value = sandboxPrompt.value
    resetSubmitGateState()
    await loadContextCandidates()
    if (contextPoolEntries.value.length > 0) {
      submitSelectedContextPoolIds.value = contextPoolEntries.value.map((entry) => entry.entryId)
      submitSelectedSourceIds.value = []
    } else {
      submitSelectedSourceIds.value = contextSourceCandidates.value.filter((source) => source.exists).map((source) => source.sourceId)
      submitSelectedContextPoolIds.value = []
    }
  }

  async function generateSubmitContextDraft() {
    if (!submitPromptDraft.value.trim() || !submitGateMode.value) return
    submitDraftBusy.value = true
    submitDraftError.value = ''
    contextPoolSaveMessage.value = ''
    try {
      const response = await getSubmissionPreview('hermes-manager', { mode: submitGateMode.value, prompt: submitPromptDraft.value, selectedSourceIds: submitSelectedSourceIds.value, selectedContextPoolIds: submitSelectedContextPoolIds.value })
      const payload = await response.json().catch(() => null)
      if (!response.ok || !payload?.ok || !payload?.preview) throw new Error(payload?.error || `submission_preview_http_${response.status}`)
      submitDraftResult.value = payload.preview
      if (payload.preview.contextSources) chatContextInfo.value = payload.preview.contextSources

      const draftResponse = await createContextDraft('hermes-manager', {
        prompt: submitPromptDraft.value,
        selectedSourceIds: submitSelectedSourceIds.value,
        selectedContextPoolIds: submitSelectedContextPoolIds.value,
        confirmedContextSummary: submitConfirmedSummary.value
      })
      const draftPayload = await draftResponse.json().catch(() => null)
      if (!draftResponse.ok || !draftPayload?.ok || !draftPayload?.draft) {
        throw new Error(draftPayload?.error || `context_draft_http_${draftResponse.status}`)
      }
      submitConfirmedSummary.value = String(draftPayload.draft.summary || '').trim()
      if (draftPayload.draft.contextSources) chatContextInfo.value = draftPayload.draft.contextSources
    } catch (caught) {
      submitDraftError.value = caught instanceof Error ? caught.message : String(caught)
    } finally {
      submitDraftBusy.value = false
    }
  }

  async function saveConfirmedContextPoolEntry() {
    if (!submitConfirmedSummary.value.trim()) return
    contextPoolSaveBusy.value = true
    contextPoolSaveMessage.value = ''
    try {
      const response = await fetch('/api/control/agents/hermes-manager/context-pool', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: submitPromptDraft.value.trim().slice(0, 60) || 'Confirmed Context', prompt: submitPromptDraft.value, summary: submitConfirmedSummary.value, selectedSourceIds: submitSelectedSourceIds.value, selectedContextPoolIds: submitSelectedContextPoolIds.value })
      })
      const payload = await response.json().catch(() => null)
      if (!response.ok || !payload?.ok || !payload?.entry) throw new Error(payload?.error || `context_pool_create_http_${response.status}`)
      contextPoolSaveMessage.value = '已保存到上下文池。'
      await loadContextCandidates()
      submitSelectedContextPoolIds.value = Array.from(new Set([...submitSelectedContextPoolIds.value, payload.entry.entryId]))
      selectedContextPoolEntryId.value = payload.entry.entryId
      await loadContextPoolEntry(payload.entry.entryId)
    } catch (caught) {
      contextPoolSaveMessage.value = caught instanceof Error ? caught.message : String(caught)
    } finally {
      contextPoolSaveBusy.value = false
    }
  }

  async function loadContextSourceFile(sourceId: string) {
    if (!sourceId) return
    sourceEditorBusy.value = true
    sourceEditorError.value = ''
    sourceEditorSaveMessage.value = ''
    try {
      const response = await fetch(`/api/control/agents/hermes-manager/context-source-content?sourceId=${encodeURIComponent(sourceId)}`)
      const payload = await response.json().catch(() => null)
      if (!response.ok || !payload?.ok || !payload?.file || !payload?.source) throw new Error(payload?.error || `context_source_get_http_${response.status}`)
      selectedContextSourceId.value = sourceId
      selectedContextSource.value = payload.source
      sourceEditorFile.value = payload.file
      sourceEditorContent.value = payload.file.content || ''
      openEditorModal('source')
    } catch (caught) {
      sourceEditorError.value = caught instanceof Error ? caught.message : String(caught)
    } finally {
      sourceEditorBusy.value = false
    }
  }

  async function saveContextSourceFile() {
    if (!selectedContextSourceId.value) return
    sourceEditorSaveBusy.value = true
    sourceEditorError.value = ''
    sourceEditorSaveMessage.value = ''
    try {
      validateJsonEditorContent(sourceEditorFile.value?.filePath || '', sourceEditorContent.value)
      const response = await fetch('/api/control/agents/hermes-manager/context-source-content', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sourceId: selectedContextSourceId.value, content: sourceEditorContent.value }) })
      const payload = await response.json().catch(() => null)
      if (!response.ok || !payload?.ok || !payload?.file || !payload?.source) throw new Error(payload?.error || `context_source_put_http_${response.status}`)
      selectedContextSource.value = payload.source
      sourceEditorFile.value = payload.file
      sourceEditorContent.value = payload.file.content || ''
      sourceEditorSaveMessage.value = '源文件已保存。'
      await loadContextCandidates()
    } catch (caught) {
      sourceEditorError.value = caught instanceof Error ? caught.message : String(caught)
    } finally {
      sourceEditorSaveBusy.value = false
    }
  }

  async function loadContextPoolEntry(entryId: string) {
    if (!entryId) return
    contextPoolEditorBusy.value = true
    contextPoolEditorError.value = ''
    try {
      const response = await fetch(`/api/control/agents/hermes-manager/context-pool/${entryId}`)
      const payload = await response.json().catch(() => null)
      if (!response.ok || !payload?.ok || !payload?.entry) throw new Error(payload?.error || `context_pool_get_http_${response.status}`)
      selectedContextPoolEntry.value = payload.entry
      const fileResponse = await fetch(`/api/control/agents/hermes-manager/context-pool/${entryId}/file`)
      const filePayload = await fileResponse.json().catch(() => null)
      if (!fileResponse.ok || !filePayload?.ok || !filePayload?.file) throw new Error(filePayload?.error || `context_pool_file_get_http_${fileResponse.status}`)
      contextPoolFile.value = filePayload.file
      contextPoolFileContent.value = filePayload.file.content || ''
      openEditorModal('context-pool')
    } catch (caught) {
      contextPoolEditorError.value = caught instanceof Error ? caught.message : String(caught)
    } finally {
      contextPoolEditorBusy.value = false
    }
  }

  async function saveContextPoolEntryEdits() {
    if (!selectedContextPoolEntryId.value) return
    contextPoolEditorBusy.value = true
    contextPoolEditorError.value = ''
    contextPoolFileSaveMessage.value = ''
    try {
      validateJsonEditorContent(contextPoolFile.value?.filePath || '', contextPoolFileContent.value)
      const response = await fetch(`/api/control/agents/hermes-manager/context-pool/${selectedContextPoolEntryId.value}/file`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: contextPoolFileContent.value }) })
      const payload = await response.json().catch(() => null)
      if (!response.ok || !payload?.ok || !payload?.file) throw new Error(payload?.error || `context_pool_file_put_http_${response.status}`)
      contextPoolFile.value = payload.file
      contextPoolFileContent.value = payload.file.content || ''
      selectedContextPoolEntry.value = payload.entry || selectedContextPoolEntry.value
      contextPoolFileSaveMessage.value = '上下文池文件已保存。'
      await loadContextCandidates()
    } catch (caught) {
      contextPoolEditorError.value = caught instanceof Error ? caught.message : String(caught)
    } finally {
      contextPoolEditorBusy.value = false
    }
  }

  async function deleteContextPoolEntry(entryId: string) {
    if (!entryId || contextPoolDeleteBusy.value) return
    if (typeof window !== 'undefined' && !window.confirm('确认删除这条上下文池记录吗？删除后不可恢复。')) return
    contextPoolDeleteBusy.value = true
    contextPoolEditorError.value = ''
    contextPoolFileSaveMessage.value = ''
    try {
      const response = await fetch(`/api/control/agents/hermes-manager/context-pool/${entryId}`, { method: 'DELETE' })
      const payload = await response.json().catch(() => null)
      if (!response.ok || !payload?.ok) throw new Error(payload?.error || `context_pool_delete_http_${response.status}`)
      if (selectedContextPoolEntryId.value === entryId) {
        selectedContextPoolEntryId.value = ''
        selectedContextPoolEntry.value = null
        contextPoolFile.value = null
        contextPoolFileContent.value = ''
        closeEditorModal()
      }
      submitSelectedContextPoolIds.value = submitSelectedContextPoolIds.value.filter((value) => value !== entryId)
      await loadContextCandidates()
    } catch (caught) {
      contextPoolEditorError.value = caught instanceof Error ? caught.message : String(caught)
    } finally {
      contextPoolDeleteBusy.value = false
    }
  }

  async function openContextPoolEntryInEditor() {
    if (!selectedContextPoolEntryId.value) return
    contextPoolEditorBusy.value = true
    contextPoolEditorError.value = ''
    try {
      const response = await fetch(`/api/control/agents/hermes-manager/context-pool/${selectedContextPoolEntryId.value}/open`, { method: 'POST' })
      const payload = await response.json().catch(() => null)
      if (!response.ok || !payload?.ok) throw new Error(payload?.error || `context_pool_open_http_${response.status}`)
    } catch (caught) {
      contextPoolEditorError.value = caught instanceof Error ? caught.message : String(caught)
    } finally {
      contextPoolEditorBusy.value = false
    }
  }

  async function performReasoningSubmission(userText: string, submissionContext: Record<string, unknown>) {
    reasoningBusy.value = true
    reasoningError.value = ''
    reasoningReviewDraft.value = ''
    sandboxPrompt.value = ''
    stopChatHistoryPolling()
    resetChatUiStatus()
    stopReasoningPolling()
    chatHistory.value.push({ role: 'user', content: userText })
    syncReasoningSessionUi(null)
    try {
      const response = await createReasoningSession('hermes-manager', { prompt: userText, ...submissionContext })
      const payload = await response.json().catch(() => null)
      if (!response.ok || !payload?.ok || !payload?.session) throw new Error(payload?.details || payload?.error || `reasoning_start_http_${response.status}`)
      syncReasoningSessionUi({ sessionId: payload.session.sessionId, runtimeSessionId: payload.session.runtimeSessionId ?? payload.session.sessionId, sessionKind: payload.session.sessionKind ?? 'agent_runtime', agentId: 'hermes-manager', userPrompt: userText, status: payload.session.status, createdAt: payload.session.createdAt, updatedAt: payload.session.createdAt, plan: payload.session.runtimeTaskGraph ?? payload.session.plan, runtimeTaskGraph: payload.session.runtimeTaskGraph ?? payload.session.plan, currentStepId: null, review: null, events: [], artifacts: {}, error: null })
      await loadReasoningSession(payload.session.sessionId)
      scheduleReasoningPolling()
    } catch (caught) {
      reasoningBusy.value = false
      reasoningError.value = caught instanceof Error ? caught.message : String(caught)
      chatHistory.value.push({ role: 'error', content: reasoningError.value })
    }
  }

  async function performChatSubmission(userText: string, submissionContext: Record<string, unknown>) {
    let shouldPollHistory = false
    chatHistory.value.push({ role: 'user', content: userText })
    sandboxPrompt.value = ''
    sandboxBusy.value = true
    stopChatHistoryPolling()
    chatUiStatus.value = { kind: 'pending', message: '请求已发出，等待 Hermes / OMLX 返回。', activeRequest: { startedAt: new Date().toISOString(), activeForMs: 0, promptChars: userText.length, contextSources: chatContextInfo.value, outboundRequest: null }, recovery: null }
    scheduleChatHistoryPolling(500)
    try {
      const response = await pingModel('hermes-manager', { prompt: userText, ...submissionContext })
      const payload = await response.json()
      if (payload.ok) {
        chatContextInfo.value = payload.contextSources || null
        stopChatHistoryPolling()
        chatUiStatus.value = { kind: 'idle', message: '', activeRequest: null, recovery: null }
        chatHistory.value.push({ role: 'hermes', content: payload.reply, tokens: payload.raw?.usage })
      } else {
        chatContextInfo.value = payload.contextSources || chatContextInfo.value
        const recovery = payload.recovery || null
        const activeRequest = payload.activeRequest || null
        const statusKind = payload.error === 'chat_busy' ? 'busy' : payload.error === 'chat_timeout' ? 'timeout' : recovery?.attempted ? 'recovering' : 'error'
        const parts = [payload.error]
        if (payload.details) parts.push(payload.details)
        if (activeRequest?.activeForMs != null) parts.push(`当前请求已运行 ${Math.round(activeRequest.activeForMs / 1000)} 秒`)
        if (recovery?.detail) parts.push(recovery.detail)
        chatUiStatus.value = { kind: statusKind, message: parts.filter(Boolean).join(' | '), activeRequest, recovery }
        shouldPollHistory = payload.error === 'chat_timeout' || Boolean(payload.pending)
        if (payload.error !== 'chat_timeout') chatHistory.value.push({ role: 'error', content: parts.filter(Boolean).join('\n') })
      }
    } catch (caught) {
      chatUiStatus.value = { kind: 'error', message: caught instanceof Error ? caught.message : String(caught), activeRequest: null, recovery: null }
      chatHistory.value.push({ role: 'error', content: chatUiStatus.value.message })
    } finally {
      sandboxBusy.value = false
      if (!shouldPollHistory) stopChatHistoryPolling()
    }
  }

  async function confirmSubmitGate() {
    if (!submitGateMode.value || !submitPromptDraft.value.trim()) return
    const submissionContext: Record<string, unknown> = { selectedSourceIds: submitSelectedSourceIds.value, selectedContextPoolIds: submitSelectedContextPoolIds.value }
    if (submitConfirmedSummary.value.trim()) submissionContext.confirmedContextSummary = submitConfirmedSummary.value
    const mode = submitGateMode.value
    const prompt = submitPromptDraft.value
    closeSubmitGate()
    if (mode === 'reasoning') await performReasoningSubmission(prompt, submissionContext)
    else await performChatSubmission(prompt, submissionContext)
  }

  function scheduleChatHistoryPolling(delayMs = 4000) {
    stopChatHistoryPolling()
    chatHistoryPollTimer = setTimeout(async () => {
      const payload = await loadChatHistory()
      if (payload?.activeRequest) {
        if (payload.activeRequest.contextSources) chatContextInfo.value = payload.activeRequest.contextSources
        if (chatUiStatus.value.kind === 'timeout' || chatUiStatus.value.kind === 'pending') {
          chatUiStatus.value = { kind: chatUiStatus.value.kind, message: chatUiStatus.value.message, activeRequest: payload.activeRequest, recovery: null }
        }
        scheduleChatHistoryPolling(delayMs)
        return
      }
      if (chatUiStatus.value.kind === 'timeout' || chatUiStatus.value.kind === 'pending') {
        chatUiStatus.value = { kind: 'idle', message: '', activeRequest: null, recovery: null }
      }
    }, delayMs)
  }

  async function loadReasoningSession(sessionId: string) {
    try {
      const response = await getReasoningSession('hermes-manager', sessionId)
      const payload = await response.json().catch(() => null)
      if (!response.ok || !payload?.ok || !payload?.session) throw new Error(payload?.error || `reasoning_session_http_${response.status}`)
      const session = payload.session as ReasoningSession
      syncReasoningSessionUi(session)
      return session
    } catch (caught) {
      reasoningError.value = caught instanceof Error ? caught.message : String(caught)
      return null
    }
  }

  function scheduleReasoningPolling(delayMs = 1500) {
    stopReasoningPolling()
    const sessionId = activeReasoningSession.value?.sessionId
    if (!sessionId) return
    reasoningPollTimer = setTimeout(async () => {
      const session = await loadReasoningSession(sessionId)
      if (!session) return
      if (session.status === 'planning' || session.status === 'running') { scheduleReasoningPolling(delayMs); return }
      if (session.status === 'waiting_review' && reasoningAutoApproveEnabled.value && session.review?.allowAutoApprove !== false && session.review?.requiredHumanDecision !== true) { await submitReasoningReview('approve', { skipManualDraft: true }); return }
      reasoningBusy.value = false
      stopReasoningPolling()
      if (session.status === 'waiting_review') return
      await loadChatHistory()
    }, delayMs)
  }

  async function clearReasoningSession() {
    const sessionId = activeReasoningSession.value?.sessionId
    if (!sessionId || !canClearReasoningSession.value || reasoningStopBusy.value) return
    if (typeof window !== 'undefined' && !window.confirm('确认清理当前可观测推理链记录吗？清理后当前时间线和结果将不再保留。')) return
    reasoningStopBusy.value = true
    reasoningError.value = ''
    try {
      const response = await clearReasoningSessionRecord('hermes-manager', sessionId)
      const payload = await response.json().catch(() => null)
      if (!response.ok || !payload?.ok) throw new Error(payload?.error || `reasoning_clear_http_${response.status}`)
      stopReasoningPolling()
      syncReasoningSessionUi(null)
      reasoningReviewDraft.value = ''
    } catch (caught) {
      reasoningError.value = caught instanceof Error ? caught.message : String(caught)
    } finally {
      reasoningStopBusy.value = false
    }
  }

  async function restoreBufferedReasoningSession() {
    const sessionId = readPersistedActiveReasoningSessionId()
    if (!sessionId) return
    const session = await loadReasoningSession(sessionId)
    if (!session) { persistActiveReasoningSessionId(null); return }
    if (session.status === 'planning' || session.status === 'running') scheduleReasoningPolling()
  }

  async function sendObservableReasoningChat() { if (sandboxPrompt.value.trim()) await openSubmitGate('reasoning') }
  async function sendChat() { if (sandboxPrompt.value.trim()) await openSubmitGate('chat') }

  async function submitReasoningReview(decision: 'approve' | 'reject', options: { skipManualDraft?: boolean } = {}) {
    const sessionId = activeReasoningSession.value?.sessionId
    if (!sessionId || !reasoningPendingReview.value || reasoningReviewBusy.value) return
    reasoningReviewBusy.value = true
    reasoningError.value = ''
    try {
      const response = await fetch(`/api/control/agents/hermes-manager/reasoning-sessions/${sessionId}/review`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ decision, correctionPrompt: options.skipManualDraft ? '' : reasoningReviewDraft.value.trim() }) })
      const payload = await response.json().catch(() => null)
      if (!response.ok || !payload?.ok || !payload?.session) throw new Error(payload?.details || payload?.error || `reasoning_review_http_${response.status}`)
      syncReasoningSessionUi(payload.session)
      reasoningReviewDraft.value = ''
      if (payload.session.status === 'planning' || payload.session.status === 'running') { reasoningBusy.value = true; scheduleReasoningPolling(500) }
      else { reasoningBusy.value = false; stopReasoningPolling(); await loadChatHistory() }
    } catch (caught) {
      reasoningError.value = caught instanceof Error ? caught.message : String(caught)
    } finally {
      reasoningReviewBusy.value = false
    }
  }

  async function cancelReasoningSession() {
    const sessionId = activeReasoningSession.value?.sessionId
    if (!sessionId || reasoningStopBusy.value) return
    reasoningStopBusy.value = true
    reasoningError.value = ''
    try {
      const response = await cancelReasoningSessionRequest('hermes-manager', sessionId)
      const payload = await response.json().catch(() => null)
      if (!response.ok || !payload?.ok || !payload?.session) throw new Error(payload?.error || `reasoning_cancel_http_${response.status}`)
      syncReasoningSessionUi(payload.session)
      reasoningBusy.value = false
      reasoningReviewDraft.value = ''
      stopReasoningPolling()
      await loadChatHistory()
    } catch (caught) {
      reasoningError.value = caught instanceof Error ? caught.message : String(caught)
    } finally {
      reasoningStopBusy.value = false
    }
  }

  async function loadChatHistory() {
    try {
      const response = await getChatHistoryRequest('hermes-manager')
      if (response.ok) {
        const payload = await response.json()
        if (payload.ok && Array.isArray(payload.history)) {
          chatHistory.value = payload.history.map((message: any) => ({ role: message.role, content: message.content, tokens: message.tokens }))
          chatMemoryFile.value = payload.file || null
          if (payload.activeRequest?.contextSources) chatContextInfo.value = payload.activeRequest.contextSources
          return payload
        }
      }
    } catch (caught) {
      console.error('Failed to load chat history:', caught)
    }
    return null
  }

  async function openChatMemoryEditor() { chatMemoryEditorOpen.value = true; await loadChatMemoryFile() }

  async function openChatHistoryFileInEditor() {
    chatMemoryOpenBusy.value = true
    chatMemoryError.value = ''
    chatMemoryOpenMessage.value = ''
    try {
      const response = await openChatHistoryFile('hermes-manager')
      const payload = await response.json().catch(() => null)
      if (!response.ok || !payload?.ok) throw new Error(payload?.error || `open_chat_history_http_${response.status}`)
      chatMemoryFile.value = payload.file || chatMemoryFile.value
      chatMemoryOpenMessage.value = `已在编辑器打开：${payload.openedWith || 'editor'}`
    } catch (caught) {
      chatMemoryError.value = caught instanceof Error ? caught.message : String(caught)
    } finally {
      chatMemoryOpenBusy.value = false
    }
  }

  async function loadChatMemoryFile() {
    chatMemoryBusy.value = true
    chatMemoryError.value = ''
    chatMemorySaveMessage.value = ''
    chatMemoryOpenMessage.value = ''
    try {
      const response = await getChatHistoryFile('hermes-manager')
      const payload = await response.json().catch(() => null)
      if (!response.ok || !payload?.ok || !payload?.file) throw new Error(payload?.error || `chat_history_file_http_${response.status}`)
      chatMemoryFile.value = { filePath: payload.file.filePath, exists: payload.file.exists, sizeChars: payload.file.sizeChars, updatedAt: payload.file.updatedAt }
      chatMemoryDraft.value = payload.file.content || '[]'
      chatMemoryLoadedContent.value = chatMemoryDraft.value
    } catch (caught) {
      chatMemoryError.value = caught instanceof Error ? caught.message : String(caught)
    } finally {
      chatMemoryBusy.value = false
    }
  }

  async function saveChatMemoryFile() {
    chatMemorySaveBusy.value = true
    chatMemoryError.value = ''
    chatMemorySaveMessage.value = ''
    chatMemoryOpenMessage.value = ''
    try {
      const response = await saveChatHistoryFile('hermes-manager', chatMemoryDraft.value)
      const payload = await response.json().catch(() => null)
      if (!response.ok || !payload?.ok || !payload?.file) throw new Error(payload?.error || `save_chat_history_http_${response.status}`)
      chatMemoryFile.value = { filePath: payload.file.filePath, exists: payload.file.exists, sizeChars: payload.file.sizeChars, updatedAt: payload.file.updatedAt }
      chatMemoryDraft.value = payload.file.content || '[]'
      chatMemoryLoadedContent.value = chatMemoryDraft.value
      chatHistory.value = Array.isArray(payload.history) ? payload.history.map((message: any) => ({ role: message.role, content: message.content, tokens: message.tokens })) : chatHistory.value
      chatMemorySaveMessage.value = '聊天记录文件已保存。'
    } catch (caught) {
      chatMemoryError.value = caught instanceof Error ? caught.message : String(caught)
    } finally {
      chatMemorySaveBusy.value = false
    }
  }

  onMounted(() => {
    logInterval = setInterval(fetchLogs, 1500)
    chatUiClockInterval = setInterval(() => { chatUiNow.value = Date.now() }, 1000)
    memoryRecordPollInterval = setInterval(() => { void loadMemoryRecords() }, 5000)
    window.addEventListener('keydown', handleEditorModalWindowKeydown, true)
    void loadContextCandidates()
    void (async () => {
      const [healthResult, agentsResult] = await Promise.allSettled([getHealth(), getAgents()])
      if (healthResult.status === 'fulfilled') {
        if (healthResult.value.ok) { managerHealth.value = await healthResult.value.json(); healthError.value = '' }
        else healthError.value = `health_http_${healthResult.value.status}`
      } else {
        healthError.value = healthResult.reason instanceof Error ? healthResult.reason.message : String(healthResult.reason)
      }
      if (agentsResult.status === 'fulfilled') {
        if (agentsResult.value.ok) {
          const payload = await agentsResult.value.json()
          agentOptions.value = payload.agents || []
          activeAgentId.value = payload.activeAgentId || 'hermes-manager'
          agentSelectionLocked.value = payload.selectionLocked !== false
          applyControlState(payload.state || null)
          error.value = ''
          if (activeAgentId.value && agentOptions.value.find((item) => item.definition.id === activeAgentId.value)) {
            selectedAgentId.value = activeAgentId.value
            await connectSelectedAgent()
          }
        } else {
          error.value = `agents_http_${agentsResult.value.status}`
        }
      } else {
        error.value = agentsResult.reason instanceof Error ? agentsResult.reason.message : String(agentsResult.reason)
      }
    })()
  })

  onUnmounted(() => {
    if (logInterval) clearInterval(logInterval)
    if (chatUiClockInterval) clearInterval(chatUiClockInterval)
    if (memoryRecordPollInterval) clearInterval(memoryRecordPollInterval)
    stopChatHistoryPolling()
    stopReasoningPolling()
    window.removeEventListener('keydown', handleEditorModalWindowKeydown, true)
    document.body.style.overflow = ''
  })

  return {
    activeEditorFilePath,
    activeReasoningSession,
    actOnModel,
    agentOptions,
    agentSelectionLocked,
    availableLeftModels,
    availableRightModels,
    canAllRestartRuntime,
    canClearReasoningSession,
    cancelReasoningSession,
    chatActiveRequestElapsedSeconds,
    chatMemoryBusy,
    chatContextInfo,
    chatHistory,
    chatMemoryDirty,
    chatMemoryDraft,
    chatMemoryEditorOpen,
    chatMemoryError,
    chatMemoryFile,
    chatMemoryLoadedContent,
    chatMemoryOpenBusy,
    chatMemoryOpenMessage,
    chatMemorySaveBusy,
    chatMemorySaveMessage,
    chatScrollContainer,
    chatUiStatus,
    clearAllMemoryRecords,
    clearSelectedMemoryRecords,
    clearReasoningSession,
    clearVisibleLogs,
    closeEditorModal,
    closeSubmitGate,
    composerPrefersReasoning,
    configReadiness,
    configSaveError,
    configSaveMessage,
    configSaving,
    confirmSubmitGate,
    connectSelectedAgent,
    connecting,
    contextCandidatesBusy,
    contextCandidatesError,
    contextSourceCandidates,
    contextPoolDeleteBusy,
    contextPoolEditorBusy,
    contextPoolEditorError,
    contextPoolEntries,
    contextPoolFile,
    contextPoolFileContent,
    contextPoolFileDirty,
    contextPoolFileSaveMessage,
    contextPoolEditorExtensions,
    contextPoolSaveBusy,
    contextPoolSaveMessage,
    brainActiveTab,
    dashboardActiveTab,
    deleteContextPoolEntry,
    editorModalKind,
    editorModalOpen,
    editorModalTitle,
    effectivePreflightReady,
    error,
    executeGlobalRuntimeAction,
    fetchLocalModels,
    fetchLogs,
    fetchingLeft,
    fetchingRight,
    formatActionHintLine,
    formatReasoningEvidence,
    generateSubmitContextDraft,
    getChineseCheckLabel,
    getLogLineColor,
    getPreviewControllerRequest,
    getPreviewPlannerHints,
    getPreviewRuntimeRoute,
    handleChatComposerKeydown,
    handleModelChange,
    handleProviderChange,
    healthError,
    inspectSelectedModel,
    inspectingLeft,
    inspectingRight,
    leftBrain,
    leftBrainBlockedReason,
    leftBrainConfigSaved,
    leftBrainRunning,
    leftBrainSummary,
    leftError,
    leftInspection,
    leftSelectedModelLoaded,
    loadChatHistory,
    loadChatMemoryFile,
    loadContextCandidates,
    loadContextPoolEntry,
    loadContextSourceFile,
    loadEngineConfig,
    loadHermesSelfCheck,
    loadMemoryRecords,
    loadReasoningCapabilities,
    logContainer,
    managerHealth,
    memoryClearBusy,
    memoryClearMessage,
    memoryClearSelection,
    memoryClearTargets,
    memoryConfig,
    memoryConfigBusy,
    memoryConfigError,
    memoryRecordContent,
    memoryRecordDirty,
    memoryRecordEditorBusy,
    memoryRecordEditorError,
    memoryRecordEditorExtensions,
    memoryRecordFile,
    memoryRecordSaveBusy,
    memoryRecordSaveMessage,
    memoryRecords,
    memoryRecordsBusy,
    memoryRecordsError,
    openChatHistoryFileInEditor,
    openChatMemoryEditor,
    openContextPoolEntryInEditor,
    openMemoryRecordInEditor,
    openEditorModal,
    openSubmitGate,
    preflightBusy,
    preflightError,
    preflightResult,
    primaryComposerActionLabel,
    rawLiveLogs,
    reasoningAutoApproveEnabled,
    reasoningBusy,
    reasoningCapabilities,
    reasoningCapabilitiesBusy,
    reasoningCapabilitiesError,
    reasoningElapsedSeconds,
    reasoningError,
    reasoningPendingReview,
    reasoningReviewBusy,
    reasoningReviewDraft,
    reasoningReviewEvidence,
    reasoningReviewTargetLabel,
    reasoningStatusLabel,
    reasoningStopBusy,
    reasoningTimelineRef,
    restartGlobalRuntime,
    reviewModeLabel,
    rightBrain,
    rightBrainRunning,
    rightError,
    rightInspection,
    runLeftBrainPreflight,
    runtimeActionLabel,
    runtimeBusy,
    runtimePrimaryAction,
    runtimeState,
    runtimeStatus,
    sandboxBusy,
    sandboxPrompt,
    saveMemoryRecordFile,
    saveChatMemoryFile,
    saveConfirmedContextPoolEntry,
    saveContextPoolEntryEdits,
    saveContextSourceFile,
    saveLeftBrainConfig,
    secondaryComposerActionLabel,
    selectedAgent,
    selectedAgentId,
    selectedAgentLabel,
    selectedContextPoolEntry,
    selectedContextPoolEntryId,
    selectedContextSource,
    selectedContextSourceId,
    selfCheck,
    sendChat,
    sendObservableReasoningChat,
    getMemoryRecordStatusLabel,
    getMemoryRecordStatusTone,
    isMemoryRecordUpdated,
    shortTermMemoryHint,
    shortTermMinContextTokens,
    showChatStatusBanner,
    skillConfig,
    skillFilesText,
    sourceEditorBusy,
    sourceEditorContent,
    sourceEditorDirty,
    sourceEditorError,
    sourceEditorExtensions,
    sourceEditorFile,
    sourceEditorSaveBusy,
    sourceEditorSaveMessage,
    submitConfirmedSummary,
    submitDraftBusy,
    submitDraftError,
    submitDraftResult,
    submitGateMode,
    submitGateOpen,
    submitPromptDraft,
    submitReasoningReview,
    submitSelectedContextPoolIds,
    submitSelectedSourceIds,
    syncReasoningSessionUi,
    toggleGlobalRuntime,
    toggleHermesRuntime,
    visibleLogLines,
  }
}