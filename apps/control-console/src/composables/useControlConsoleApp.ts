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
  getOverview,
  getRuntimeStatus,
  getSelfCheck,
  inspectLocalModel,
  listLocalModels,
  runModelAction,
  runPreflightCheck,
  runRuntimeAction,
  switchAgentModel,
  saveAgentConfig,
  saveAgentMemoryRecordFile,
} from '../services/controlApi'
import {
  cancelReasoningSessionRequest,
  clearReasoningSessionRecord,
  createReasoningSession,
  getActiveProductionTestSession,
  getReasoningCapabilities,
  getReasoningSession,
} from '../services/reasoningApi'
import {
  getChatHistory as getChatHistoryRequest,
  getChatHistoryFile,
  getContextCandidates,
  openChatHistoryFile,
  postAgentStream,
  saveChatHistoryFile,
} from '../services/chatApi'
import type { AgentStreamStep } from '../types/agentStream'
import { dispatchEvent, getEventRegistry } from '../services/eventsApi'

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

type OverviewAlert = {
  level: 'critical' | 'warning' | 'info'
  source: string
  message: string
}

type OverviewResponse = {
  ok: boolean
  HERMES_HOME: string
  alerts: OverviewAlert[]
  readyForProduction: boolean
  controlSystem: {
    status: string
    mode: string
    focus: string
  }
  primaryAgent: {
    id: string
    runtime: string
    availability: string
  }
  omlx: {
    reachable: boolean
    baseUrl?: string
    modelCount?: number
    detail: string
  }
  studio: {
    reachable: boolean
    detail: string
  }
  hermes: {
    state: string
    label: string
    detail: string
    pid: number | null
  }
  model: {
    name: string | null
    loaded: boolean
    detail: string
    provider: string | null
    baseUrl: string | null
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
    domains?: string[]
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
      [key: string]: string
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
  required?: boolean
  optionalMissingOk?: boolean
  usage?: string
  howToUse?: string
  contextRole?: string
  cleanupPolicy?: string
}

type MemoryClearTarget = {
  value: string
  label: string
  description: string
  impactLevel?: 'safe' | 'caution' | 'high' | 'critical'
  impactLabel?: string
  impactSummary?: string
  sizeBytes?: number
  sizeLabel?: string
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

type ReasoningWorkflowPhase = {
  phaseId: 'planning' | 'executing' | 'answering' | 'quality_review' | string
  title: string
  status: 'pending' | 'running' | 'waiting_review' | 'completed' | 'failed' | 'cancelled' | string
  summary?: string | null
  currentOperation?: string | null
  evidence?: string | null
}

type ChatHistoryEntry = {
  role: string
  content: string
  tokens?: any
  transient?: boolean
  sourceKey?: string
}

type EventChainRegistryEvent = {
  eventId: string
  version?: number
  category: string
  kind: 'command' | 'query' | string
  title: string
  description?: string
  reviewRequired?: boolean
  timeoutMs?: number
}

type EventChainRegistryCategory = {
  id: string
  title: string
}

type EventChainRegistry = {
  registryVersion: string
  provider?: {
    id?: string
    name?: string
    baseUrl?: string
  }
  categories?: EventChainRegistryCategory[]
  events: EventChainRegistryEvent[]
}

type EventChainChatArg = {
  name: string
  required?: boolean
  description?: string
}

type EventChainRegistryEventWithMeta = EventChainRegistryEvent & {
  code?: string
  aliases?: string[]
  chatArgs?: EventChainChatArg[]
}

type EventDispatchResult = {
  ok: boolean
  provider?: string
  eventId: string | null
  code?: string | null
  kind?: string
  traceId: string
  durationMs?: number
  transport?: {
    method?: string
    endpoint?: string
    status?: number
  }
  result?: unknown
  error?: string | null
  caller?: string
}

type EventConfirmPending = {
  event: EventChainRegistryEventWithMeta
  payload: Record<string, unknown>
  argsText: string
}

type ReasoningSelfReview = {
  verdict: 'approve' | 'repair' | 'human_review'
  summary: string
  issues: string[]
  strengths: string[]
  correctionPrompt: string
  reusableSections?: string[]
  promotableLesson?: {
    category: string
    summary: string
    candidateText: string
    recommendedActions: string[]
  } | null
}

type ReasoningReview = {
  status: 'pending'
  targetType: 'plan' | 'runtime_task_graph' | 'step' | 'completion' | 'answer'
  reviewPhase?: 'before_execution' | 'after_execution' | 'standard' | 'quality_override'
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
  workflowProgress?: ReasoningWorkflowPhase[]
  currentStepId: string | null
  review?: ReasoningReview | null
  events: ReasoningEvent[]
  artifacts: {
    projectRoot?: string
    storyIndex?: ReasoningStoryIndexItem[]
    finalAnswer?: string
    finalAnswerPersisted?: boolean
    workspaceStructure?: Record<string, unknown>
    writtenFiles?: Array<Record<string, unknown>>
    pendingWrites?: Record<string, unknown>
    tasks?: Record<string, unknown>
    qualityGateAttempt?: number
    latestAnswerAssessment?: {
      score: number
      passed: boolean
      source: string
      summary: string
      issues: string[]
      strengths: string[]
      correctionPrompt: string
    } | null
    latestSelfReview?: ReasoningSelfReview | null
  }
  error?: string | null
}

const ACTIVE_REASONING_SESSION_STORAGE_KEY = 'gamestudio.activeReasoningSessionId'
const REASONING_AUTO_APPROVE_STORAGE_KEY = 'gamestudio.reasoningAutoApproveEnabled'

type ModelInspection = {
  model: string
  accessible: boolean
  loaded?: boolean | null
  isLoading?: boolean | null
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
  longTasksFile: string
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
  const overview = ref<OverviewResponse | null>(null)
  const overviewError = ref('')
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
  const skillProposalsList = ref<any[]>([])
  const skillIntentsActive = ref<any[]>([])
  const skillProposalGovernance = ref<any[]>([])
  const skillProposalsBusy = ref(false)
  const skillProposalsError = ref('')
  const skillProposalsScanMessage = ref('')
  const skillProposalsActionBusy = ref('')
  const smartStartBusy = ref(false)
  const smartStartMessage = ref('')
  const omlxStartBusy = ref(false)
  const omlxStartMessage = ref('')
  const versions = ref<{ hermesVersion: string; omlxVersion: string | null; omlxServiceHealthy: boolean }>({ hermesVersion: 'unknown', omlxVersion: null, omlxServiceHealthy: false })
  const supervisionResult = ref<{ hasData: boolean; scorecard: any; correctionPlan: any; sessionId?: string; status?: string } | null>(null)
  const supervisionLoading = ref(false)
  const chatContextInfo = ref<ChatContextInfo | null>(null)
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
  const reasoningAutoApproveEnabled = ref(readPersistedReasoningAutoApproveEnabled())
  const memoryConfig = ref<MemoryConfig | null>(null)
  const memoryConfigBusy = ref(false)
  const memoryConfigError = ref('')
  const skillConfig = ref<SkillConfig | null>(null)
  const configReadiness = ref<ConfigReadiness | null>(null)
  const configSaving = ref(false)
  const configSaveMessage = ref('')
  const configSaveError = ref('')
  const modelSwitchBusy = ref(false)
  const modelSwitchMessage = ref('')
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
  const eventChainVisible = ref(false)
  const eventRegistry = ref<EventChainRegistry | null>(null)
  const eventRegistryBusy = ref(false)
  const eventRegistryError = ref('')
  const eventDispatchBusy = ref(false)
  const eventDispatchResult = ref<EventDispatchResult | null>(null)
  const eventConfirmPending = ref<EventConfirmPending | null>(null)
  const contextCandidatesBusy = ref(false)
  const contextCandidatesError = ref('')
  const contextSourceCandidates = ref<ContextSourceCandidate[]>([])
  const contextPoolEntries = ref<ContextPoolEntrySummary[]>([])
  const reasoningCapabilities = ref<ReasoningCapabilities | null>(null)
  const reasoningCapabilitiesBusy = ref(false)
  const reasoningCapabilitiesError = ref('')
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
  const rightBrainEnabled = ref(false)
  const rawLiveLogs = ref('')
  const clearedLogLineCount = ref(0)
  const chatScrollContainer = ref<HTMLElement | null>(null)
  const logContainer = ref<HTMLElement | null>(null)
  const reasoningTimelineRef = ref<HTMLElement | null>(null)
  const chatUiNow = ref(Date.now())
  const leftBrain = ref({ provider: 'omlx', baseUrl: 'http://127.0.0.1:18888/v1', model: '', contextLength: null as number | null, recommendedMaxOutputTokens: null as number | null, tokenizer: null as string | null, metadataSource: 'unavailable' })
  const rightBrain = ref({ provider: 'omlx', baseUrl: 'http://127.0.0.1:18888/v1', model: '', apiKey: '', contextLength: null as number | null, recommendedMaxOutputTokens: null as number | null, tokenizer: null as string | null, metadataSource: 'unavailable' })
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
  const logClearBusy = ref(false)
  const logClearMessage = ref('')
  const reasoningClearMessage = ref('')
  const chatHistory = ref<ChatHistoryEntry[]>([])
  const persistedChatHistory = ref<ChatHistoryEntry[]>([])
  const pendingReasoningUserPrompt = ref('')
  // 故事需求确认待办：服务端要求补充/确认字段时暂存，等待用户下一句话回应
  const pendingStoryRequirementConfirm = ref<{ prompt: string; requirement: Record<string, unknown> } | null>(null)
  // agent 流式咨询状态：steps 按 STEP 分组（思考/动作/结果），answerDraft 为流式回答草稿
  const agentStreamSteps = ref<AgentStreamStep[]>([])
  const agentStreamActive = ref(false)
  const agentStreamAnswerDraft = ref('')
  let logInterval: ReturnType<typeof setInterval> | null = null
  let chatUiClockInterval: ReturnType<typeof setInterval> | null = null
  let memoryRecordPollInterval: ReturnType<typeof setInterval> | null = null
  let overviewPollInterval: ReturnType<typeof setInterval> | null = null
  let reasoningPollTimer: ReturnType<typeof setTimeout> | null = null
  let productionTestPollInterval: ReturnType<typeof setInterval> | null = null
  let productionTestFollowPausedUntil = 0
  let logsRequestInFlight = false
  let memoryRecordsRequestInFlight = false
  let contextCandidatesRequestInFlight = false
  let chatHistoryRequestInFlight = false
  let productionTestRequestInFlight = false

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
  const runtimeStatus = computed(() => runtimeState.value?.label || '未选择')
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
  const leftSelectedModelLoaded = computed(() => persistedModelLoaded.value || (!!leftBrain.value.model && leftInspection.value?.model === leftBrain.value.model && leftInspection.value?.loaded === true))
  const leftBrainSummary = computed(() => ({ providerLabel: leftBrain.value.provider === 'ollama' ? 'Ollama' : 'OMLX (Local)', baseUrlLabel: leftBrain.value.baseUrl || '默认', modelLabel: leftBrain.value.model || '未选择模型', tokenLabel: leftInspection.value?.usage?.totalTokens ?? '-', statusLabel: leftSelectedModelLoaded.value ? '已启动' : '未启动' }))
  const rightBrainSummary = computed(() => {
    if (!rightBrainEnabled.value) return { providerLabel: '-', modelLabel: '未启用', statusLabel: '未启用', statusColor: 'var(--c-text-muted)' }
    const providerLabel = rightBrain.value.provider === 'moonshot' ? 'Moonshot' : (rightBrain.value.provider === 'ollama' ? 'Ollama' : 'OMLX')
    const modelLabel = rightBrain.value.model || '未选择模型'
    const accessible = rightInspection.value?.accessible === true
    const loaded = rightInspection.value?.loaded === true
    const statusLabel = loaded ? '已就绪' : (accessible ? '可连接' : '待探测')
    const statusColor = loaded ? 'var(--c-success-dim)' : (accessible ? 'var(--c-warn)' : 'var(--c-text-muted)')
    return { providerLabel, modelLabel, statusLabel, statusColor }
  })
  const rightBrainConfigSignature = computed(() => JSON.stringify({
    rightBrainEnabled: rightBrainEnabled.value,
    rightBrain: {
      provider: rightBrain.value.provider,
      baseUrl: rightBrain.value.baseUrl,
      model: rightBrain.value.model
    }
  }))
  const persistedRightBrainConfigSignature = ref('')
  const rightBrainConfigSaved = computed(() => {
    if (!rightBrainEnabled.value) return true
    return !!persistedRightBrainConfigSignature.value && rightBrainConfigSignature.value === persistedRightBrainConfigSignature.value
  })
  const leftBrainSwitchNeeded = computed(() => {
    if (!leftBrain.value.model) return false
    return String(controlState.value?.model?.provider || '') !== String(leftBrain.value.provider || '')
      || String(controlState.value?.model?.baseUrl || '') !== String(leftBrain.value.baseUrl || '')
      || String(controlState.value?.model?.model || '') !== String(leftBrain.value.model || '')
  })
  const leftBrainConfigSignature = computed(() => JSON.stringify(buildLeftBrainConfigPayload()))
  const leftBrainConfigSaved = computed(() => {
    // Hermes 已运行时，配置视为已保存（运行时配置必然有效）
    if (leftBrainRunning.value) return true
    return !!persistedLeftBrainConfigSignature.value && leftBrainConfigSignature.value === persistedLeftBrainConfigSignature.value && controlState.value?.config?.saved === true
  })
  const effectivePreflightReady = computed(() => Boolean(preflightResult.value?.ready) || (controlState.value?.preflight?.ready === true && controlState.value.preflight.configFingerprint === leftBrainConfigSignature.value))
  const leftBrainBlockedReason = computed(() => {
    if (memoryConfigBusy.value || configSaving.value || runtimeBusy.value) return '控制面处理中，请稍候。'
    // Hermes 已运行时，不再显示阻塞提示
    if (leftBrainRunning.value) return ''
    if (!leftBrainConfigSaved.value) return '未保存左脑配置，请先保存。'
    if (!leftSelectedModelLoaded.value) return controlState.value?.model?.detail || '模型未启动，请先加载模型。'
    if (!configReadiness.value?.ready) return '左脑配置校验未通过，请先修复配置项。'
    if (!effectivePreflightReady.value) return controlState.value?.preflight?.detail || '尚未完成左脑自检。'
    return ''
  })
  const reasoningSubmitBlockedReason = computed(() => {
    if (selectedAgent.value?.definition.runtime !== 'hermes') return ''
    if (runtimeBusy.value || memoryConfigBusy.value || configSaving.value || smartStartBusy.value) return '控制面处理中，请稍候。'
    if (!leftBrainRunning.value || runtimeState.value?.state !== 'running') return 'Hermes 未启动，请先启动引擎。'
    return ''
  })
  const chatMemoryDirty = computed(() => chatMemoryDraft.value !== chatMemoryLoadedContent.value)
  const reasoningStatusLabel = computed(() => !activeReasoningSession.value ? '未开始' : activeReasoningSession.value.status === 'planning' ? '制定任务中' : activeReasoningSession.value.status === 'running' ? '执行中' : activeReasoningSession.value.status === 'waiting_review' ? '待人工确认' : activeReasoningSession.value.status === 'completed' ? '已完成' : activeReasoningSession.value.status === 'cancelled' ? '已停止' : '失败')
  const reasoningPendingReview = computed(() => activeReasoningSession.value?.status === 'waiting_review' && activeReasoningSession.value.review ? activeReasoningSession.value.review : null)
  const reasoningReviewTargetLabel = computed(() => {
    const review = reasoningPendingReview.value
    if (!review) return ''
    return review.targetType === 'plan' || review.targetType === 'runtime_task_graph' ? '运行任务审核' : `步骤审核${review.stepIndex != null ? ` #${review.stepIndex + 1}` : ''}`
  })
  const canReasoningStepBack = computed(() => {
    const review = reasoningPendingReview.value
    if (!review) return false
    return Number.isInteger(review.stepIndex) && Number(review.stepIndex) > 0
  })
  const reasoningRejectActionLabel = computed(() => {
    const review = reasoningPendingReview.value
    if (!review) return '驳回并重新规划'
    if (review.targetType === 'plan' || review.targetType === 'runtime_task_graph' || review.reviewPhase === 'before_execution') {
      return '驳回并重新规划'
    }
    return '驳回并重跑当前步骤'
  })
  const reasoningApproveActionLabel = computed(() => {
    const review = reasoningPendingReview.value
    if (review?.reviewPhase === 'quality_override') return '通过并强化评分'
    return '通过并继续'
  })
  const reasoningReviewEvidence = computed(() => reasoningPendingReview.value?.evidence || null)
  const reasoningElapsedSeconds = computed(() => getReasoningSessionElapsedSeconds(activeReasoningSession.value, chatUiNow.value))
  const reasoningSessionInForeground = computed(() => ['planning', 'running', 'waiting_review'].includes(activeReasoningSession.value?.status || ''))
  // 清理按钮对所有已结束任务可用：终态（completed/blocked/cancelled/timeout）+ failed（重试耗尽的最终态）
  const canClearReasoningSession = computed(() => ['completed', 'failed', 'cancelled', 'blocked', 'timeout'].includes(activeReasoningSession.value?.status || ''))
  const reviewModeLabel = computed(() => reasoningAutoApproveEnabled.value ? '自动直跑模式' : '人工全审模式')
  const primaryComposerActionLabel = computed(() => reasoningBusy.value ? '执行中...' : reasoningAutoApproveEnabled.value ? '直接开始任务流' : '开始任务执行')
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
        longTasksFile: memoryConfig.value.longTasksFile,
        statusFile: memoryConfig.value.statusFile,
        taskQueueFile: memoryConfig.value.taskQueueFile,
        decisionsFile: memoryConfig.value.decisionsFile,
        dailyLogDir: memoryConfig.value.dailyLogDir,
      } : null,
      skills: { skillRoot: skillConfig.value?.skillRoot || '', skillFiles: skillFilesText.value.split(/\r?\n/).map((item) => item.trim()).filter(Boolean) },
      brains: {
        rightBrainEnabled: rightBrainEnabled.value,
        rightBrain: {
          provider: rightBrain.value.provider,
          baseUrl: rightBrain.value.baseUrl,
          model: rightBrain.value.model,
          apiKey: rightBrain.value.apiKey
        }
      }
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
      'memory-long-tasks-file': '长任务主线文件',
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

  function formatActionHintLine(hint: { keywords: string[]; requiredActions: string[]; answerAction: string }) { return `${hint.keywords.join(' | ')} => ${[...hint.requiredActions, hint.answerAction].filter(Boolean).join(', ')}` }
  function validateJsonEditorContent(filePath: string, content: string) { if (/\.json$/i.test(filePath)) JSON.parse(content) }
  function formatClearArchiveMessage(payload: any) {
    const archiveDir = String(payload?.archive?.archiveDir || '').trim()
    const archivedFileCount = Number(payload?.archive?.archivedFileCount || 0)
    if (!archiveDir) return '已完成清理分析；本次没有生成归档包。'
    return `已备份 ${archivedFileCount} 个文件到 ${archiveDir}。`
  }

  async function clearVisibleLogs() {
    if (logClearBusy.value || memoryClearBusy.value) return
    const lineCount = rawLiveLogs.value ? rawLiveLogs.value.split('\n').filter((line) => line.length > 0).length : 0
    const message = [
      '确认清空后台日志窗口吗？',
      '系统会先分析并归档 Hermes 运行日志和当日日志，然后清空日志文件。',
      '不会删除长期记忆、上下文池、项目文件或已归档 session。',
      lineCount > 0 ? `当前窗口约 ${lineCount} 行日志。` : '当前窗口没有可见日志。'
    ].join('\n')
    if (typeof window !== 'undefined' && !window.confirm(message)) return
    logClearBusy.value = true
    logClearMessage.value = ''
    memoryRecordsError.value = ''
    try {
      const response = await clearAgentMemoryRecords(selectedAgentId.value || 'hermes-manager', { targets: ['logs'], reason: 'manual-log-window-clear' })
      const payload = await response.json().catch(() => null)
      if (!response.ok || !payload?.ok) throw new Error(payload?.error || `clear_logs_http_${response.status}`)
      memoryRecords.value = Array.isArray(payload.records) ? payload.records : memoryRecords.value
      memoryClearTargets.value = Array.isArray(payload.clearTargets) ? payload.clearTargets : memoryClearTargets.value
      syncMemoryClearSelection()
      rawLiveLogs.value = ''
      clearedLogLineCount.value = 0
      await fetchLogs()
      logClearMessage.value = `日志窗口已安全清空；${formatClearArchiveMessage(payload)}`
    } catch (caught) {
      memoryRecordsError.value = caught instanceof Error ? caught.message : String(caught)
    } finally {
      logClearBusy.value = false
    }
  }
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
    if (!record.exists && record.optionalMissingOk) return '可选未创建'
    if (!record.exists) return '缺失'
    if (isMemoryRecordUpdated(record.key)) return '有更新'
    if (record.empty) return '空'
    if ((record.itemCount ?? 0) > 0 && record.scope !== 'long-term') return `${record.itemCount} 项`
    return '正常'
  }
  function getMemoryRecordStatusTone(record: MemoryRecordItem) {
    if (!record.exists && record.optionalMissingOk) return 'var(--c-text-muted)'
    if (!record.exists) return 'var(--c-error-dim)'
    if (isMemoryRecordUpdated(record.key)) return 'var(--c-accent)'
    if (record.empty) return 'var(--c-text-muted)'
    return 'var(--c-success-dim)'
  }
  function persistActiveReasoningSessionId(sessionId: string | null) {
    if (typeof window === 'undefined') return
    if (sessionId) window.localStorage.setItem(ACTIVE_REASONING_SESSION_STORAGE_KEY, sessionId)
    else window.localStorage.removeItem(ACTIVE_REASONING_SESSION_STORAGE_KEY)
  }
  function readPersistedActiveReasoningSessionId() { return typeof window === 'undefined' ? '' : (window.localStorage.getItem(ACTIVE_REASONING_SESSION_STORAGE_KEY) || '') }
  function persistReasoningAutoApproveEnabled(enabled: boolean) {
    if (typeof window === 'undefined') return
    window.localStorage.setItem(REASONING_AUTO_APPROVE_STORAGE_KEY, enabled ? 'true' : 'false')
  }
  function readPersistedReasoningAutoApproveEnabled() {
    if (typeof window === 'undefined') return true
    const raw = window.localStorage.getItem(REASONING_AUTO_APPROVE_STORAGE_KEY)
    if (raw === 'false') return false
    if (raw === 'true') return true
    return true
  }
  function normalizeChatContent(value: string) {
    return String(value || '').replace(/\s+/g, ' ').trim()
  }
  function buildChatEntryKey(role: string, content: string) {
    return `${role}:${normalizeChatContent(content).slice(0, 400)}`
  }
  function appendLocalChatEntry(entry: ChatHistoryEntry) {
    persistedChatHistory.value = [...persistedChatHistory.value, { ...entry, transient: false }]
    rebuildDisplayedChatHistory()
  }
  function buildReasoningTransientChatEntries(session: ReasoningSession | null, baseHistory: ChatHistoryEntry[]) {
    const entries: ChatHistoryEntry[] = []
    const seen = new Set(baseHistory.map((entry) => buildChatEntryKey(entry.role, entry.content)))
    const pushEntry = (role: string, content: string, sourceKey: string) => {
      const normalizedContent = String(content || '').trim()
      if (!normalizedContent) return
      const dedupeKey = buildChatEntryKey(role, normalizedContent)
      if (seen.has(dedupeKey)) return
      seen.add(dedupeKey)
      entries.push({ role, content: normalizedContent, transient: true, sourceKey })
    }

    if (pendingReasoningUserPrompt.value.trim()) {
      pushEntry('user', pendingReasoningUserPrompt.value.trim(), 'reasoning-pending-user')
    }
    if (!session) return entries

    if (session.userPrompt.trim() && !(session.status === 'completed' && session.artifacts?.finalAnswerPersisted)) {
      pushEntry('user', session.userPrompt.trim(), `reasoning-user:${session.sessionId}`)
    }
    if (session.status !== 'completed' || !session.artifacts?.finalAnswerPersisted) {
      const finalAnswer = String(session.artifacts?.finalAnswer || '').trim()
      if (finalAnswer) pushEntry('hermes', finalAnswer, `reasoning-answer:${session.sessionId}`)
    }
    if ((session.status === 'failed' || session.status === 'cancelled') && session.error) {
      pushEntry('error', session.error, `reasoning-error:${session.sessionId}`)
    }

    return entries
  }
  function rebuildDisplayedChatHistory() {
    const baseHistory = persistedChatHistory.value.map((entry) => ({ ...entry, transient: false }))
    chatHistory.value = [...baseHistory, ...buildReasoningTransientChatEntries(activeReasoningSession.value, baseHistory)]
  }
  function syncReasoningSessionUi(session: ReasoningSession | null) {
    const normalizedSession = session ? {
      ...session,
      runtimeSessionId: session.runtimeSessionId ?? session.sessionId,
      sessionKind: session.sessionKind ?? 'agent_runtime',
      runtimeTaskGraph: session.runtimeTaskGraph ?? session.plan,
      plan: session.runtimeTaskGraph ?? session.plan,
    } : null
    if (normalizedSession) pendingReasoningUserPrompt.value = ''
    activeReasoningSession.value = normalizedSession
    persistActiveReasoningSessionId(normalizedSession?.sessionId || null)
    reasoningBusy.value = Boolean(normalizedSession && isReasoningLiveStatus(normalizedSession.status))
    rebuildDisplayedChatHistory()
  }
  // queued/retry_wait 由队列 worker 推进，pausing/resuming 由生命周期驱动——这些状态都要持续轮询
  function isReasoningLiveStatus(status: string | null | undefined) {
    return status === 'planning' || status === 'running' || status === 'queued' || status === 'retry_wait' || status === 'pausing' || status === 'resuming'
  }
  function stopChatHistoryPolling() {}
  function stopReasoningPolling() { if (reasoningPollTimer) { clearTimeout(reasoningPollTimer); reasoningPollTimer = null } }
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
  function handleChatComposerKeydown(event: KeyboardEvent) {
    if (event.key !== 'Enter') return
    if (event.metaKey || event.ctrlKey) {
      event.preventDefault()
      void sendObservableReasoningChat()
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
    const distanceFromBottom = container.scrollHeight - container.scrollTop - container.clientHeight
    if (distanceFromBottom > 96) return
    container.scrollTop = container.scrollHeight
  }, { deep: true })
  watch(editorModalOpen, (isOpen) => { document.body.style.overflow = isOpen ? 'hidden' : ''; if (isOpen) focusActiveEditorInModal() })
  watch(reasoningAutoApproveEnabled, (enabled) => { persistReasoningAutoApproveEnabled(Boolean(enabled)) })
  watch(leftBrainConfigSignature, (nextValue, previousValue) => {
    if (!previousValue || loadingEngineConfig.value || nextValue === previousValue) return
    configSaveMessage.value = ''
    configSaveError.value = ''
    modelSwitchMessage.value = ''
    resetPreflightState()
  })

  async function fetchLogs() {
    if (!selectedAgentId.value) return
    if (logsRequestInFlight) return
    logsRequestInFlight = true
    try {
      const res = await getAgentLogs(selectedAgentId.value)
      const data = await res.json()
      if (data.ok) {
        rawLiveLogs.value = data.logs
        const currentLineCount = rawLiveLogs.value ? rawLiveLogs.value.split('\n').filter((line: string) => line.length > 0).length : 0
        if (currentLineCount < clearedLogLineCount.value) clearedLogLineCount.value = 0
      }
    } catch {}
    finally { logsRequestInFlight = false }
  }

  async function fetchOverview() {
    try {
      const res = await getOverview()
      const data = await res.json()
      if (data.ok) {
        overview.value = data
        overviewError.value = ''
      } else {
        overviewError.value = data.error || 'overview_failed'
      }
    } catch (caught) {
      overviewError.value = caught instanceof Error ? caught.message : String(caught)
    }
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
      const providerLabel = brain.value.provider === 'ollama' ? 'ollama' : (brain.value.provider === 'moonshot' ? 'moonshot' : 'omlx')
      const resp = await listLocalModels({ provider: providerLabel, baseUrl: brain.value.baseUrl })
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
      const providerLabel = brain.value.provider === 'ollama' ? 'ollama' : (brain.value.provider === 'moonshot' ? 'moonshot' : 'omlx')
      const response = await inspectLocalModel({ provider: providerLabel, model: brain.value.model, baseUrl: brain.value.baseUrl })
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
    if (brain.value.provider === 'ollama') brain.value.baseUrl = 'http://127.0.0.1:11434/v1'
    else if (brain.value.provider === 'moonshot') brain.value.baseUrl = 'https://api.kimi.com/coding/v1'
    else brain.value.baseUrl = 'http://127.0.0.1:18888/v1'
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
      const rb = payload.config.brains?.rightBrain
      if (rb && typeof rb === 'object') {
        rightBrain.value.provider = String(rb.provider || payload.config.provider)
        rightBrain.value.baseUrl = String(rb.baseUrl || payload.config.baseUrl)
        rightBrain.value.model = String(rb.model || '')
        rightBrain.value.apiKey = String(rb.apiKey || '')
      }
      rightBrainEnabled.value = Boolean(payload.config.brains?.rightBrainEnabled)
      rightBrainRunning.value = false
      memoryConfig.value = payload.config.memory || null
      skillConfig.value = payload.config.skills || null
      configReadiness.value = payload.config.readiness || null
      applyControlState(payload.config.state || null)
      shortTermMinContextTokens.value = payload.config.shortTerm?.minContextTokens || 65536
      skillFilesText.value = (payload.config.skills?.skillFiles || []).join('\n')
      persistedRightBrainConfigSignature.value = JSON.stringify({
        rightBrainEnabled: rightBrainEnabled.value,
        rightBrain: {
          provider: rightBrain.value.provider,
          baseUrl: rightBrain.value.baseUrl,
          model: rightBrain.value.model,
          apiKey: rightBrain.value.apiKey
        }
      })
      persistedLeftBrainConfigSignature.value = JSON.stringify({
        provider: payload.config.provider,
        baseUrl: payload.config.baseUrl,
        model: payload.config.model,
        shortTerm: { minContextTokens: payload.config.shortTerm?.minContextTokens || 65536 },
        memory: payload.config.memory ? {
          agentDefinitionFile: payload.config.memory.agentDefinitionFile,
          userFile: payload.config.memory.userFile,
          memoryFile: payload.config.memory.memoryFile,
          longTasksFile: payload.config.memory.longTasksFile,
          statusFile: payload.config.memory.statusFile,
          taskQueueFile: payload.config.memory.taskQueueFile,
          decisionsFile: payload.config.memory.decisionsFile,
          dailyLogDir: payload.config.memory.dailyLogDir
        } : null,
        skills: { skillRoot: payload.config.skills?.skillRoot || '', skillFiles: payload.config.skills?.skillFiles || [] },
        brains: {
          rightBrainEnabled: rightBrainEnabled.value,
          rightBrain: {
            provider: rightBrain.value.provider,
            baseUrl: rightBrain.value.baseUrl,
            model: rightBrain.value.model,
            apiKey: rightBrain.value.apiKey
          }
        }
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
    if (!selectedAgentId.value) {
      configSaveError.value = '未选择 Agent，无法保存配置。'
      return
    }
    if (!memoryConfig.value || !skillConfig.value) {
      configSaveMessage.value = '正在加载引擎配置...'
      await loadEngineConfig()
      if (!memoryConfig.value || !skillConfig.value) {
        configSaveError.value = '无法加载引擎配置，保存失败。请检查 Control Server 是否正常运行。'
        return
      }
    }
    configSaving.value = true
    configSaveError.value = ''
    configSaveMessage.value = ''
    try {
      const response = await saveAgentConfig(selectedAgentId.value, buildLeftBrainConfigPayload())
      const payload = await response.json().catch(() => null)
      if (!response.ok || !payload?.ok) throw new Error(payload?.error || `save_config_http_${response.status}`)
      applyControlState(payload.state || null)
      await loadEngineConfig()
      configSaveMessage.value = '配置已保存。'
      resetPreflightState()
    } catch (caught) {
      configSaveError.value = String(caught)
    } finally {
      configSaving.value = false
    }
  }

  async function loadMemoryRecords() {
    if (!selectedAgentId.value) return
    if (memoryRecordsRequestInFlight) return
    memoryRecordsRequestInFlight = true
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
      memoryRecordsRequestInFlight = false
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

  async function clearMemoryTarget(target: string) {
    await clearMemoryRecords([target])
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

  async function switchLeftBrainModel() {
    if (!selectedAgentId.value) return
    if (!leftBrain.value.model) {
      error.value = '请先选择要切换到的模型。'
      return
    }

    modelSwitchBusy.value = true
    modelSwitchMessage.value = ''
    leftError.value = ''
    error.value = ''
    try {
      const response = await switchAgentModel(selectedAgentId.value, { config: buildLeftBrainConfigPayload() })
      const payload = await response.json().catch(() => null)
      if (!response.ok || !payload?.ok) {
        if (payload?.state) applyControlState(payload.state)
        if (payload?.runtimeStatus) runtimeState.value = payload.runtimeStatus
        if (payload?.preflight) preflightResult.value = payload.preflight
        if (payload?.readiness) configReadiness.value = payload.readiness
        const activeExecutions = Array.isArray(payload?.activeExecutions)
          ? payload.activeExecutions.map((item: any) => `${item.sessionId}${item.phase ? ` / ${item.phase}` : ''}`).join('；')
          : ''
        throw new Error(activeExecutions || payload?.recoveryDetail || payload?.detail || payload?.error || `switch_model_http_${response.status}`)
      }

      if (payload?.state) applyControlState(payload.state)
      if (payload?.runtimeStatus) runtimeState.value = payload.runtimeStatus
      if (payload?.preflight) {
        preflightResult.value = payload.preflight
        configReadiness.value = payload.preflight?.readiness || configReadiness.value
        if (payload.preflight?.inspection) leftInspection.value = payload.preflight.inspection
      }
      modelSwitchMessage.value = payload?.detail || '左脑模型已切换。'
      configSaveMessage.value = payload?.detail || '左脑模型已切换。'
      if (payload?.runtimeStatus?.state === 'running') {
        leftBrainRunning.value = true
        await loadHermesSelfCheck()
      }
      await fetchLocalModels('left')
      await fetchLogs()
    } catch (caught) {
      leftError.value = caught instanceof Error ? caught.message : String(caught)
      await fetchLogs()
    } finally {
      modelSwitchBusy.value = false
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
    if (rightBrainEnabled.value && rightBrain.value.model) {
      await inspectSelectedModel('right')
    }
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
    if (contextCandidatesRequestInFlight) return
    contextCandidatesRequestInFlight = true
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
      contextCandidatesRequestInFlight = false
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

  function resetAgentStreamState() {
    agentStreamSteps.value = []
    agentStreamActive.value = false
    agentStreamAnswerDraft.value = ''
  }

  function findOrCreateAgentStreamStep(stepIndex: number) {
    const existing = agentStreamSteps.value.find((step) => step.stepIndex === stepIndex)
    if (existing) return existing
    const created: AgentStreamStep = { stepIndex, thinking: [], actions: [] }
    agentStreamSteps.value = [...agentStreamSteps.value, created]
    return created
  }

  // 应用一条 server 桥聚合后的流事件到步骤区（思考/动作/结果/回答草稿）
  function applyAgentStreamEvent(evt: Record<string, any>): string | null {
    const type = String(evt?.type || '')
    if (type === 'session') return String(evt.sessionId || '') || null
    if (type === 'thinking') {
      const step = findOrCreateAgentStreamStep(Number(evt.stepIndex) || 1)
      step.thinking.push(String(evt.text || ''))
      return null
    }
    if (type === 'action') {
      const step = findOrCreateAgentStreamStep(Number(evt.stepIndex) || 1)
      step.actions.push({
        actionId: String(evt.actionId || `act_${step.stepIndex}_${step.actions.length + 1}`),
        tool: String(evt.tool || ''),
        actionLabel: String(evt.actionLabel || evt.tool || '调用工具'),
        target: String(evt.target || ''),
        status: 'running',
      })
      return null
    }
    if (type === 'action_result') {
      const stepIndex = Number(evt.stepIndex) || 1
      const step = findOrCreateAgentStreamStep(stepIndex)
      const action = step.actions.find((item) => item.actionId === evt.actionId)
        || [...step.actions].reverse().find((item) => item.status === 'running')
      if (action) {
        action.status = evt.ok ? 'done' : 'failed'
        if (evt.error) action.error = String(evt.error)
      }
      return null
    }
    if (type === 'blocked') {
      // 只读边界拦截：以 blocked 动作卡呈现，后续 final 事件给出人话说明
      const lastStep = agentStreamSteps.value[agentStreamSteps.value.length - 1]
      const step = lastStep || findOrCreateAgentStreamStep(1)
      step.actions.push({
        actionId: `blocked_${step.actions.length + 1}`,
        tool: String(evt.tool || ''),
        actionLabel: String(evt.actionLabel || evt.tool || '调用工具'),
        target: String(evt.target || ''),
        status: 'blocked',
        error: '已拦截：超出咨询只读边界',
      })
      return null
    }
    if (type === 'answer_delta') {
      agentStreamAnswerDraft.value += String(evt.delta || '')
      return null
    }
    if (type === 'final') {
      agentStreamAnswerDraft.value = ''
      return null
    }
    return null
  }

  // 消费 control 桥透传的 SSE 流（fetch + ReadableStream，增量解析 event:/data: 帧）
  async function consumeAgentStreamResponse(response: Response) {
    if (!response.body) throw new Error('agent_stream_body_missing')
    const reader = response.body.getReader()
    const decoder = new TextDecoder('utf8')
    let buffer = ''
    let streamSessionId = ''
    const handleFrame = (frame: string) => {
      let eventName = 'message'
      const dataLines: string[] = []
      for (const line of frame.split('\n')) {
        if (!line || line.startsWith(':')) continue
        if (line.startsWith('event:')) eventName = line.slice('event:'.length).trim()
        else if (line.startsWith('data:')) dataLines.push(line.slice('data:'.length).replace(/^ /, ''))
      }
      if (!dataLines.length) return
      let evt: Record<string, any> = {}
      try {
        evt = JSON.parse(dataLines.join('\n'))
      } catch {
        return
      }
      const sessionId = applyAgentStreamEvent(evt)
      if (sessionId) {
        streamSessionId = sessionId
        // 附着到活跃 session：状态栏/停止按钮/执行日志照常工作，治理证据可视
        void loadReasoningSession(sessionId)
      }
      if (eventName === 'error' || evt.type === 'error') {
        reasoningError.value = String(evt.message || 'agent_stream_error')
      }
    }
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let index = buffer.indexOf('\n\n')
      while (index >= 0) {
        handleFrame(buffer.slice(0, index).replace(/\r/g, ''))
        buffer = buffer.slice(index + 2)
        index = buffer.indexOf('\n\n')
      }
    }
    if (buffer.trim()) handleFrame(buffer.replace(/\r/g, ''))
    agentStreamActive.value = false
    // 流结束后归位：同步 session 终态（任务状态/执行日志证据），并刷新聊天记录显示最终回答
    if (streamSessionId) await loadReasoningSession(streamSessionId)
    reasoningBusy.value = false
    await loadChatHistory()
  }

  // 咨询/问答类优先尝试 agent 流式路径；服务端分类为非咨询（not_consultative）时返回 false 回退确定性链
  async function tryAgentStreamSubmission(userText: string): Promise<boolean> {
    const response = await postAgentStream('hermes-manager', {
      prompt: userText,
      reviewMode: reasoningAutoApproveEnabled.value ? 'full-auto' : 'manual',
    })
    const contentType = String(response.headers.get('content-type') || '')
    if (response.ok && contentType.includes('text/event-stream')) {
      agentStreamActive.value = true
      await consumeAgentStreamResponse(response)
      return true
    }
    const payload = await response.json().catch(() => null)
    if (payload?.code === 'not_consultative') return false
    // 其它失败（runtime 未运行/左脑门禁未就绪）与既有路径同语义，直接抛给统一错误处理
    throw new Error(payload?.details || payload?.error || `agent_stream_http_${response.status}`)
  }

  async function performReasoningSubmission(userText: string, submissionContext: Record<string, unknown>) {
    if (reasoningSubmitBlockedReason.value) {
      reasoningError.value = reasoningSubmitBlockedReason.value
      return
    }
    reasoningBusy.value = true
    reasoningError.value = ''
    reasoningReviewDraft.value = ''
    sandboxPrompt.value = ''
    productionTestFollowPausedUntil = Date.now() + 10 * 60 * 1000
    stopChatHistoryPolling()
    stopReasoningPolling()
    pendingReasoningUserPrompt.value = userText
    syncReasoningSessionUi(null)
    resetAgentStreamState()
    try {
      // 咨询/问答类由服务端分流进 agent 流式路径；非咨询返回 not_consultative 后回退既有确定性链
      if (await tryAgentStreamSubmission(userText)) return
      const response = await createReasoningSession('hermes-manager', {
        prompt: userText,
        reviewMode: reasoningAutoApproveEnabled.value ? 'full-auto' : 'manual',
        ...submissionContext,
      })
      const payload = await response.json().catch(() => null)
      // 需求确认分支：服务端要求补充/确认字段，不是失败——以 hermes 回复呈现，等用户下一句话回应
      if (response.ok && payload?.ok && payload?.requirementConfirm) {
        reasoningBusy.value = false
        pendingReasoningUserPrompt.value = ''
        pendingStoryRequirementConfirm.value = payload.requirement?.complete ? { prompt: userText, requirement: payload.requirement } : null
        appendLocalChatEntry({ role: 'user', content: userText })
        appendLocalChatEntry({ role: 'hermes', content: String(payload.message || '') })
        return
      }
      if (!response.ok || !payload?.ok || !payload?.session) throw new Error(payload?.details || payload?.error || `reasoning_start_http_${response.status}`)
      pendingStoryRequirementConfirm.value = null
      syncReasoningSessionUi({ sessionId: payload.session.sessionId, runtimeSessionId: payload.session.runtimeSessionId ?? payload.session.sessionId, sessionKind: payload.session.sessionKind ?? 'agent_runtime', agentId: 'hermes-manager', userPrompt: userText, status: payload.session.status, createdAt: payload.session.createdAt, updatedAt: payload.session.createdAt, plan: payload.session.runtimeTaskGraph ?? payload.session.plan, runtimeTaskGraph: payload.session.runtimeTaskGraph ?? payload.session.plan, currentStepId: null, review: null, events: [], artifacts: {}, error: null })
      await loadReasoningSession(payload.session.sessionId)
      scheduleReasoningPolling()
    } catch (caught) {
      reasoningBusy.value = false
      reasoningError.value = caught instanceof Error ? caught.message : String(caught)
      pendingReasoningUserPrompt.value = ''
      appendLocalChatEntry({ role: 'user', content: userText })
      appendLocalChatEntry({ role: 'error', content: reasoningError.value })
    }
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

  // 恢复服务端最新未终结 session 为当前活跃任务链：
  // 让非本页面提交（API / cron / 其他客户端）创建的任务，也能在聊天页看到逐阶段进度
  async function restoreActiveReasoningSession() {
    if (activeReasoningSession.value) return
    try {
      const response = await fetch('/api/control/agents/hermes-manager/reasoning-sessions?limit=20&includeTerminal=false')
      const payload = await response.json().catch(() => null)
      if (!response.ok || !payload?.ok || !Array.isArray(payload.sessions)) return
      const sessions = payload.sessions as Array<{ sessionId?: string; updatedAt?: string; createdAt?: string }>
      const latest = sessions.slice().sort((a, b) => String(b.updatedAt || b.createdAt || '').localeCompare(String(a.updatedAt || a.createdAt || '')))[0]
      if (!latest?.sessionId) return
      const session = await loadReasoningSession(String(latest.sessionId))
      if (session && isReasoningLiveStatus(session.status)) {
        scheduleReasoningPolling(500)
      }
    } catch {
      // 恢复失败不影响聊天页其他初始化
    }
  }

  function scheduleReasoningPolling(delayMs = 1500) {
    stopReasoningPolling()
    const sessionId = activeReasoningSession.value?.sessionId
    if (!sessionId) return
    reasoningPollTimer = setTimeout(async () => {
      const session = await loadReasoningSession(sessionId)
      if (!session) return
      if (isReasoningLiveStatus(session.status)) { scheduleReasoningPolling(delayMs); return }
      if (session.status === 'waiting_review' && reasoningAutoApproveEnabled.value) {
        await submitReasoningReview('approve', { skipManualDraft: true })
        // 自动审核提交后延迟重新轮询，让后端有时间处理；避免审核失败或未被处理时永久卡住
        scheduleReasoningPolling(3000)
        return
      }
      reasoningBusy.value = false
      stopReasoningPolling()
      if (session.status === 'waiting_review') return
      await loadChatHistory()
    }, delayMs)
  }

  // 新建会话：脱离当前执行链、清空输入与对话内容（服务端聊天记录先归档再清空，可溯），
  // 让输入区回到干净起点；历史任务到会话列表查看。
  async function startNewChatSession() {
    stopReasoningPolling()
    resetAgentStreamState()
    syncReasoningSessionUi(null)
    sandboxPrompt.value = ''
    pendingReasoningUserPrompt.value = ''
    reasoningError.value = ''
    await clearMemoryRecords(['chat-history'])
  }

  async function clearReasoningSession() {
    const sessionId = activeReasoningSession.value?.sessionId
    if (!sessionId || !canClearReasoningSession.value || reasoningStopBusy.value) return
    if (typeof window !== 'undefined' && !window.confirm('确认清理当前可观测推理链记录吗？\n仅已结束任务可清理。后端会先备份 session JSON 和清理报告，再从当前时间线移除。')) return
    reasoningStopBusy.value = true
    reasoningError.value = ''
    reasoningClearMessage.value = ''
    try {
      const response = await clearReasoningSessionRecord('hermes-manager', sessionId)
      const payload = await response.json().catch(() => null)
      if (!response.ok || !payload?.ok) throw new Error(payload?.error || `reasoning_clear_http_${response.status}`)
      reasoningClearMessage.value = `推理链记录已归档清理；${formatClearArchiveMessage(payload)}`
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
    // 已结束的任务不在刷新后恢复附着（否则死任务反复回到当前执行链且无法摆脱）；
    // 终态（completed/blocked/cancelled/timeout）+ failed 一律清理本地记录，历史任务到会话列表查看
    if (['completed', 'failed', 'cancelled', 'blocked', 'timeout'].includes(session.status)) {
      activeReasoningSession.value = null
      persistActiveReasoningSessionId(null)
      rebuildDisplayedChatHistory()
      return
    }
    scheduleReasoningPolling()
  }

  async function loadActiveProductionTestSession() {
    try {
      if (Date.now() < productionTestFollowPausedUntil) return
      if (productionTestRequestInFlight) return
      productionTestRequestInFlight = true
      const response = await getActiveProductionTestSession('hermes-manager')
      const payload = await response.json().catch(() => null)
      if (!response.ok || !payload?.ok || !payload.activeSession?.sessionId) return
      const sessionId = String(payload.activeSession.sessionId)
      const currentSession = activeReasoningSession.value
      if (currentSession?.sessionId === sessionId) return
      if (currentSession && !['completed', 'failed', 'cancelled', 'blocked', 'timeout'].includes(currentSession.status)) return
      const session = await loadReasoningSession(sessionId)
      if (!session) return
      dashboardActiveTab.value = 'reasoning'
      if (session.status === 'planning' || session.status === 'running') scheduleReasoningPolling(500)
    } catch {
      // Production test polling is best-effort; normal control console use should not surface this as an error.
    } finally {
      productionTestRequestInFlight = false
    }
  }

  async function loadEventChain() {
    eventRegistryBusy.value = true
    eventRegistryError.value = ''
    try {
      const response = await getEventRegistry()
      const payload = await response.json().catch(() => null)
      if (!response.ok || !payload?.ok || !payload?.registry) {
        throw new Error(payload?.error || `event_registry_http_${response.status}`)
      }
      eventRegistry.value = payload.registry as EventChainRegistry
      eventChainVisible.value = true
    } catch (caught) {
      eventRegistryError.value = caught instanceof Error ? caught.message : String(caught)
      eventChainVisible.value = false
    } finally {
      eventRegistryBusy.value = false
    }
  }

  function closeEventChain() {
    eventChainVisible.value = false
  }

  function resolveEventByRef(ref: string): EventChainRegistryEventWithMeta | null {
    const raw = String(ref || '').trim()
    if (!raw) return null
    let key = raw.toLowerCase()
    if (key.startsWith('gamestudio.')) key = key.slice('gamestudio.'.length)
    const events = (eventRegistry.value?.events || []) as EventChainRegistryEventWithMeta[]
    return events.find((event) => String(event.eventId || '').toLowerCase() === key)
      || events.find((event) => String(event.code || '').toLowerCase() === key)
      || events.find((event) => (event.aliases || []).some((alias) => String(alias).toLowerCase() === key))
      || null
  }

  function buildEventPayloadFromArgs(event: EventChainRegistryEventWithMeta, argsText: string): Record<string, unknown> {
    const chatArgs = Array.isArray(event.chatArgs) ? event.chatArgs : []
    const payload: Record<string, unknown> = {}
    if (chatArgs.length === 0) return payload
    const tokens = argsText.split(/\s+/).map((item) => item.trim()).filter(Boolean)
    chatArgs.forEach((arg, index) => {
      if (!arg?.name) return
      if (chatArgs.length === 1 && arg.name === 'title') {
        // 单参数 title 取整段剩余输入，支持含空格标题
        payload[arg.name] = argsText.trim()
        return
      }
      if (tokens[index] !== undefined) payload[arg.name] = tokens[index]
    })
    return payload
  }

  async function dispatchEventFromChat(event: EventChainRegistryEventWithMeta, payload: Record<string, unknown>, confirmed: boolean) {
    eventDispatchBusy.value = true
    eventDispatchResult.value = null
    try {
      const response = await dispatchEvent({
        event: event.eventId,
        payload,
        caller: 'chat',
        confirmed
      })
      const result = await response.json().catch(() => null)
      if (!result || typeof result !== 'object') throw new Error(`event_dispatch_http_${response.status}`)
      eventDispatchResult.value = result as EventDispatchResult
      return result as EventDispatchResult
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught)
      eventDispatchResult.value = {
        ok: false,
        eventId: event.eventId,
        code: event.code || null,
        traceId: '',
        error: message
      }
      return null
    } finally {
      eventDispatchBusy.value = false
    }
  }

  async function confirmEventDispatch() {
    const pending = eventConfirmPending.value
    if (!pending || eventDispatchBusy.value) return
    eventConfirmPending.value = null
    appendLocalChatEntry({ role: 'assistant', content: `已确认执行事件：${pending.event.title}（${pending.event.eventId}）。` })
    const result = await dispatchEventFromChat(pending.event, pending.payload, true)
    if (result && !result.ok) {
      appendLocalChatEntry({ role: 'error', content: `事件执行失败：${result.error || 'unknown_error'}` })
    }
  }

  function cancelEventDispatch() {
    const pending = eventConfirmPending.value
    eventConfirmPending.value = null
    if (pending) {
      appendLocalChatEntry({ role: 'assistant', content: `已取消事件：${pending.event.title}（${pending.event.eventId}）。` })
    }
  }

  async function handleGameStudioEventCommand(prompt: string) {
    const body = prompt.replace(/^gamestudio\s*/i, '').trim()
    if (!body) {
      appendLocalChatEntry({ role: 'assistant', content: '已载入 GameStudio 事件链，见下方事件卡片。' })
      await loadEventChain()
      if (eventRegistryError.value) {
        appendLocalChatEntry({ role: 'error', content: `事件链载入失败：${eventRegistryError.value}` })
      }
      return
    }

    // 注册表未加载时先加载，便于解析事件引用
    if (!eventRegistry.value) {
      await loadEventChain()
      if (eventRegistryError.value) {
        appendLocalChatEntry({ role: 'error', content: `事件链载入失败：${eventRegistryError.value}` })
        return
      }
    }

    const [ref, ...restParts] = body.split(/\s+/)
    const argsText = restParts.join(' ')
    const event = resolveEventByRef(ref)
    if (!event) {
      appendLocalChatEntry({ role: 'error', content: `未找到事件：${ref}。输入 gamestudio 查看事件链。` })
      return
    }

    const payload = buildEventPayloadFromArgs(event, argsText)
    const missing = (event.chatArgs || []).filter((arg) => arg?.required && (payload[arg.name] === undefined || String(payload[arg.name] || '').trim() === ''))
    if (missing.length > 0) {
      appendLocalChatEntry({ role: 'error', content: `事件 ${event.title}（${event.eventId}）缺少必需参数：${missing.map((arg) => arg.name).join(', ')}` })
      return
    }

    if (event.kind === 'command' && event.reviewRequired === true) {
      eventConfirmPending.value = { event, payload, argsText }
      return
    }

    const result = await dispatchEventFromChat(event, payload, false)
    if (result && !result.ok) {
      appendLocalChatEntry({ role: 'error', content: `事件执行失败：${result.error || 'unknown_error'}` })
    }
  }

  async function sendObservableReasoningChat() {
    const prompt = sandboxPrompt.value.trim()
    if (!prompt) return
    // 对话激活事件链/事件调用：输入 gamestudio 载入事件链；
    // 输入 gamestudio <eventId|code|别名> [参数] 调用事件（query 直接执行，command 先经确认卡片）。
    if (/^gamestudio(\s|$)/i.test(prompt)) {
      sandboxPrompt.value = ''
      appendLocalChatEntry({ role: 'user', content: prompt })
      await handleGameStudioEventCommand(prompt)
      return
    }
    // 需求确认待办存在时，本句视为对上一次确认摘要的回应：带 skipRequirementConfirm 直接创建 session
    const pendingConfirm = pendingStoryRequirementConfirm.value
    if (pendingConfirm) {
      pendingStoryRequirementConfirm.value = null
      sandboxPrompt.value = ''
      appendLocalChatEntry({ role: 'user', content: prompt })
      await performReasoningSubmission(pendingConfirm.prompt, { skipRequirementConfirm: true, requirement: pendingConfirm.requirement })
      return
    }
    // 提交即创建任务：answer_only 由服务端分类器直跑，生产类步骤在执行链中由审核卡片承担（不再有提交前确认门）
    await performReasoningSubmission(prompt, {})
  }

  async function submitReasoningReview(decision: 'approve' | 'reject' | 'back', options: { skipManualDraft?: boolean } = {}) {
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
    if (chatHistoryRequestInFlight) return null
    chatHistoryRequestInFlight = true
    try {
      const response = await getChatHistoryRequest('hermes-manager')
      if (response.ok) {
        const payload = await response.json()
        if (payload.ok && Array.isArray(payload.history)) {
          persistedChatHistory.value = payload.history.map((message: any) => ({ role: message.role, content: message.content, tokens: message.tokens, transient: false }))
          rebuildDisplayedChatHistory()
          chatMemoryFile.value = payload.file || null
          if (payload.activeRequest?.contextSources) chatContextInfo.value = payload.activeRequest.contextSources
          return payload
        }
      }
    } catch (caught) {
      console.error('Failed to load chat history:', caught)
    } finally {
      chatHistoryRequestInFlight = false
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

  async function clearChatWindowHistory() {
    if (chatMemorySaveBusy.value || chatMemoryBusy.value) return
    if (typeof window !== 'undefined' && !window.confirm('确认清空当前 Hermes 回答窗口吗？\n系统会先分析并归档当天聊天缓冲 JSON，再清空窗口。\n不会删除长期记忆、状态/任务/决策、上下文池或项目文件。')) return
    chatMemorySaveBusy.value = true
    chatMemoryError.value = ''
    chatMemorySaveMessage.value = ''
    chatMemoryOpenMessage.value = ''
    try {
      productionTestFollowPausedUntil = Date.now() + 10 * 60 * 1000
      stopChatHistoryPolling()
      stopReasoningPolling()
      pendingReasoningUserPrompt.value = ''
      activeReasoningSession.value = null
      persistActiveReasoningSessionId(null)
      reasoningBusy.value = false
      reasoningError.value = ''
      reasoningReviewDraft.value = ''
      await fetch('/api/control/agents/hermes-manager/production-test-session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: '' })
      }).catch(() => null)
      const response = await clearAgentMemoryRecords(selectedAgentId.value || 'hermes-manager', { targets: ['chat-history'], reason: 'manual-answer-window-clear' })
      const payload = await response.json().catch(() => null)
      if (!response.ok || !payload?.ok) throw new Error(payload?.error || `clear_chat_history_http_${response.status}`)
      memoryRecords.value = Array.isArray(payload.records) ? payload.records : memoryRecords.value
      memoryClearTargets.value = Array.isArray(payload.clearTargets) ? payload.clearTargets : memoryClearTargets.value
      syncMemoryClearSelection()
      const chatRecord = Array.isArray(payload.records) ? payload.records.find((record: any) => record.key === 'chat-history') : null
      if (chatRecord) chatMemoryFile.value = { filePath: chatRecord.filePath, exists: chatRecord.exists, sizeChars: chatRecord.sizeChars, updatedAt: chatRecord.updatedAt }
      chatMemoryDraft.value = '[]\n'
      chatMemoryLoadedContent.value = chatMemoryDraft.value
      persistedChatHistory.value = []
      rebuildDisplayedChatHistory()
      chatMemorySaveMessage.value = `回答窗口已安全清空；${formatClearArchiveMessage(payload)} 长期记忆和上下文池未受影响。`
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
    overviewPollInterval = setInterval(() => { void fetchOverview() }, 3000)
    productionTestPollInterval = setInterval(() => { void loadActiveProductionTestSession() }, 1500)
    window.addEventListener('keydown', handleEditorModalWindowKeydown, true)
    void loadContextCandidates()
    void fetchOverview()
    void restoreActiveReasoningSession()
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
    if (overviewPollInterval) clearInterval(overviewPollInterval)
    if (productionTestPollInterval) clearInterval(productionTestPollInterval)
    stopChatHistoryPolling()
    stopReasoningPolling()
    window.removeEventListener('keydown', handleEditorModalWindowKeydown, true)
    document.body.style.overflow = ''
  })

  // ---------------------- Skill / intent proposals ----------------------
  async function loadSkillProposals() {
    skillProposalsBusy.value = true
    skillProposalsError.value = ''
    try {
      const response = await fetch('/api/control/skill-proposals')
      const payload = await response.json().catch(() => null)
      if (!response.ok || !payload?.ok) throw new Error(payload?.error || `skill_proposals_http_${response.status}`)
      skillProposalsList.value = Array.isArray(payload.proposals) ? payload.proposals : []
      skillIntentsActive.value = Array.isArray(payload.activeIntents) ? payload.activeIntents : []
      skillProposalGovernance.value = Array.isArray(payload.governance) ? payload.governance : []
    } catch (caught) {
      skillProposalsError.value = caught instanceof Error ? caught.message : String(caught)
    } finally {
      skillProposalsBusy.value = false
    }
  }

  async function scanSkillProposals(minOccurrence = 2) {
    skillProposalsBusy.value = true
    skillProposalsError.value = ''
    skillProposalsScanMessage.value = ''
    try {
      const response = await fetch('/api/control/skill-proposals/scan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ minOccurrence }),
      })
      const payload = await response.json().catch(() => null)
      if (!response.ok || !payload?.ok) throw new Error(payload?.error || `skill_proposals_scan_http_${response.status}`)
      const wrote = Array.isArray(payload.written) ? payload.written.length : 0
      const scanned = Number(payload.scannedRecords || 0)
      const groups = Number(payload.correctionGroups || 0)
      skillProposalsScanMessage.value = `扫描完成：审阅记录 ${scanned} 条，去重纠偏 ${groups} 组，新提案 ${wrote} 条。`
      await loadSkillProposals()
    } catch (caught) {
      skillProposalsError.value = caught instanceof Error ? caught.message : String(caught)
    } finally {
      skillProposalsBusy.value = false
    }
  }

  // AUTO-F02：proposal 治理动作统一携带人类操作者身份（console 为人工操作界面）；
  // 服务端对 model/cron 等自动路径身份一律拒绝并审计
  const SKILL_PROPOSAL_ACTOR = 'human:control-console'

  async function postSkillProposalAction(actionPrefix: string, url: string, body: Record<string, unknown>, errorLabel: string) {
    skillProposalsActionBusy.value = actionPrefix
    skillProposalsError.value = ''
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ actor: SKILL_PROPOSAL_ACTOR, ...body }),
      })
      const payload = await response.json().catch(() => null)
      if (!response.ok || !payload?.ok) throw new Error(payload?.detail || payload?.error || `${errorLabel}_http_${response.status}`)
      await loadSkillProposals()
      return payload
    } catch (caught) {
      skillProposalsError.value = caught instanceof Error ? caught.message : String(caught)
      return null
    } finally {
      skillProposalsActionBusy.value = ''
    }
  }

  async function testSkillProposal(id: string) {
    if (!id) return
    const payload = await postSkillProposalAction(
      `test:${id}`,
      `/api/control/skill-proposals/${encodeURIComponent(id)}/test`,
      {},
      'skill_proposal_test',
    )
    if (payload && payload.passed === false) {
      const failed = Array.isArray(payload.checks) ? payload.checks.filter((check: any) => !check.passed) : []
      skillProposalsError.value = `测试门禁未通过：${failed.map((check: any) => check.detail).join('；') || '未知原因'}`
    }
  }

  async function reviewSkillProposal(id: string, decision: 'approve' | 'reject') {
    if (!id) return
    await postSkillProposalAction(
      `review:${id}`,
      `/api/control/skill-proposals/${encodeURIComponent(id)}/review`,
      { decision },
      'skill_proposal_review',
    )
  }

  async function promoteSkillProposal(id: string) {
    if (!id) return
    await postSkillProposalAction(
      `promote:${id}`,
      `/api/control/skill-proposals/${encodeURIComponent(id)}/promote`,
      {},
      'skill_proposal_promote',
    )
  }

  async function rejectSkillProposal(id: string) {
    if (!id) return
    await postSkillProposalAction(
      `reject:${id}`,
      `/api/control/skill-proposals/${encodeURIComponent(id)}/reject`,
      {},
      'skill_proposal_reject',
    )
  }

  async function rollbackSkillIntent(id: string) {
    if (!id) return
    await postSkillProposalAction(
      `rollback:${id}`,
      `/api/control/skill-intents/${encodeURIComponent(id)}/rollback`,
      { reason: 'console 人工回滚' },
      'skill_intent_rollback',
    )
  }

  async function deactivateSkillIntent(id: string) {
    if (!id) return
    await postSkillProposalAction(
      `deactivate:${id}`,
      `/api/control/skill-intents/${encodeURIComponent(id)}/deactivate`,
      { reason: 'console 人工下线' },
      'skill_intent_deactivate',
    )
  }

  // ---------------------- Versions ----------------------
  async function loadVersions() {
    try {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), 3000)
      const response = await fetch('/api/control/versions', { signal: controller.signal })
      clearTimeout(timeout)
      if (!response.ok) return
      const payload = await response.json()
      if (payload.ok) {
        versions.value = {
          hermesVersion: payload.hermesVersion || 'unknown',
          omlxVersion: payload.omlxVersion || null,
          omlxServiceHealthy: payload.omlxServiceHealthy || false,
        }
      }
    } catch {
      // ignore
    }
  }

  // ---------------------- Supervision ----------------------
  async function loadSupervisionResult() {
    if (supervisionLoading.value) return
    supervisionLoading.value = true
    try {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), 5000)
      const response = await fetch('/api/control/supervision/latest', { signal: controller.signal })
      clearTimeout(timeout)
      if (!response.ok) return
      const payload = await response.json()
      if (payload.ok) {
        supervisionResult.value = payload
      }
    } catch {
      // ignore
    } finally {
      supervisionLoading.value = false
    }
  }

  // ---------------------- OMLX start helper ----------------------
  async function startOmlxApp() {
    if (omlxStartBusy.value) return
    omlxStartBusy.value = true
    omlxStartMessage.value = '正在启动 OMLX...'
    try {
      const controller = new AbortController()
      const timeoutId = setTimeout(() => controller.abort(), 35000)
      const response = await fetch('/api/control/omlx/start', { method: 'POST', signal: controller.signal })
      clearTimeout(timeoutId)
      const payload = await response.json().catch(() => null)
      if (!response.ok || !payload?.ok) {
        throw new Error(payload?.message || `OMLX 启动失败 (${response.status})`)
      }
      omlxStartMessage.value = payload.alreadyRunning ? 'OMLX 已在运行' : 'OMLX 启动成功，正在刷新模型列表...'
      // 刷新模型列表
      await fetchLocalModels('left')
    } catch (caught) {
      const msg = caught instanceof Error ? caught.message : String(caught)
      if (msg.includes('abort') || msg.includes('Abort')) {
        omlxStartMessage.value = 'OMLX 启动请求超时，请检查 OMLX App 是否正常运行'
      } else {
        omlxStartMessage.value = msg
      }
    } finally {
      omlxStartBusy.value = false
    }
  }

  // ---------------------- Smart start chain ----------------------
  // 一键启动的启动段：对两类已知瞬时失败自动恢复——
  // 1) config_not_saved：前端配置签名与服务端持久化不一致（常见于配置文件被外部修改或 SPA 会话签名陈旧），
  //    强制重新加载配置并保存一次后重试；
  // 2) runtime_action_busy：另一个 runtime 动作仍在执行，等待后重试。
  function delay(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }

  async function startHermesWithRecovery() {
    const busyRetryLimit = 3
    for (let configAttempt = 1; configAttempt <= 2; configAttempt++) {
      for (let busyRetry = 0; busyRetry < busyRetryLimit; busyRetry++) {
        error.value = ''
        await toggleHermesRuntime('left')
        if (leftBrainRunning.value) return { ok: true }
        const message = String(error.value || '')
        if (/runtime_action_busy/.test(message) && busyRetry < busyRetryLimit - 1) {
          smartStartMessage.value = `启动动作冲突，等待后重试（${busyRetry + 1}/${busyRetryLimit - 1}）...`
          await delay(2000)
          continue
        }
        if (/config_not_saved/.test(message) && configAttempt === 1) break
        return { ok: false, error: message || 'start_failed' }
      }
      if (configAttempt === 1) {
        smartStartMessage.value = '配置签名不一致，正在刷新配置并重新保存后重试...'
        await loadEngineConfig()
        await saveLeftBrainConfig()
        if (configSaveError.value) {
          return { ok: false, error: `config_resave_failed: ${configSaveError.value}` }
        }
      }
    }
    return { ok: false, error: error.value || 'start_failed' }
  }

  // 一键串起：保存配置 → 自检 → 启动左脑 → 探测右脑。
  // 这只是把现有三个独立按钮的步骤按正确顺序串起来，
  // 不替换原本的三个按钮，符合 control 非回归约束。
  async function smartStartHermes() {
    if (smartStartBusy.value || runtimeBusy.value) return
    if (selectedAgent.value?.definition.runtime !== 'hermes') return
    if (leftBrainRunning.value) {
      smartStartMessage.value = 'Hermes 已在运行，无需再次启动。'
      return
    }
    smartStartBusy.value = true
    smartStartMessage.value = '步骤 1/4：保存左脑配置...'
    try {
      if (!leftBrainConfigSaved.value) {
        await saveLeftBrainConfig()
        if (configSaveError.value) {
          smartStartMessage.value = `配置保存失败：${configSaveError.value}`
          return
        }
      }
      smartStartMessage.value = '步骤 2/4：运行左脑自检...'
      if (!effectivePreflightReady.value) {
        await runLeftBrainPreflight()
        if (preflightError.value) {
          smartStartMessage.value = `自检未通过：${preflightError.value}`
          return
        }
      }
      smartStartMessage.value = '步骤 3/4：启动 Hermes runtime...'
      const startResult = await startHermesWithRecovery()
      if (!startResult.ok) {
        smartStartMessage.value = `启动失败：${startResult.error}`
        return
      }
      // 步骤 4：如果右脑已启用，自动探测
      if (rightBrainEnabled.value && rightBrain.value.model) {
        smartStartMessage.value = '步骤 4/4：探测右脑连通性...'
        await inspectSelectedModel('right')
        const rightOk = rightInspection.value?.accessible
        smartStartMessage.value = rightOk
          ? '✅ 一键启动完成。左脑已就绪，右脑探测通过。'
          : '⚠️ 左脑已就绪，右脑探测未通过，请检查右脑配置。'
      } else {
        smartStartMessage.value = '✅ 一键启动完成，Hermes 智能体已就绪。'
      }
    } catch (caught) {
      smartStartMessage.value = caught instanceof Error ? caught.message : String(caught)
    } finally {
      smartStartBusy.value = false
    }
  }

  return {
    activeEditorFilePath,
    activeReasoningSession,
    actOnModel,
    agentOptions,
    agentSelectionLocked,
    agentStreamActive,
    agentStreamAnswerDraft,
    agentStreamSteps,
    availableLeftModels,
    availableRightModels,
    canAllRestartRuntime,
    canClearReasoningSession,
    cancelReasoningSession,
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
    clearChatWindowHistory,
    clearAllMemoryRecords,
    clearMemoryTarget,
    clearSelectedMemoryRecords,
    clearReasoningSession,
    clearVisibleLogs,
    closeEditorModal,
    closeEventChain,
    loadEventChain,
    confirmEventDispatch,
    cancelEventDispatch,
    eventChainVisible,
    eventRegistry,
    eventRegistryBusy,
    eventRegistryError,
    eventDispatchBusy,
    eventDispatchResult,
    eventConfirmPending,
    configReadiness,
    configSaveError,
    configSaveMessage,
    configSaving,
    modelSwitchBusy,
    modelSwitchMessage,
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
    getChineseCheckLabel,
    getLogLineColor,
    handleChatComposerKeydown,
    handleModelChange,
    handleProviderChange,
    healthError,
    inspectSelectedModel,
    inspectingLeft,
    inspectingRight,
    leftBrain,
    leftBrainBlockedReason,
    reasoningSubmitBlockedReason,
    leftBrainConfigSaved,
    leftBrainRunning,
    leftBrainSummary,
    leftBrainSwitchNeeded,
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
    logClearBusy,
    logClearMessage,
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
    overview,
    overviewError,
    fetchOverview,
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
    reasoningClearMessage,
    reasoningElapsedSeconds,
    reasoningError,
    reasoningPendingReview,
    canReasoningStepBack,
    reasoningApproveActionLabel,
    reasoningRejectActionLabel,
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
    rightBrainEnabled,
    rightBrainSummary,
    rightBrainConfigSaved,
    persistedRightBrainConfigSignature,
    rightError,
    rightInspection,
    runLeftBrainPreflight,
    switchLeftBrainModel,
    runtimeActionLabel,
    runtimeBusy,
    runtimePrimaryAction,
    runtimeState,
    runtimeStatus,
    sandboxPrompt,
    saveMemoryRecordFile,
    saveChatMemoryFile,
    saveContextPoolEntryEdits,
    saveContextSourceFile,
    saveLeftBrainConfig,
    selectedAgent,
    selectedAgentId,
    selectedAgentLabel,
    selectedContextPoolEntry,
    selectedContextPoolEntryId,
    selectedContextSource,
    selectedContextSourceId,
    selfCheck,
    sendObservableReasoningChat,
    startNewChatSession,
    getMemoryRecordStatusLabel,
    getMemoryRecordStatusTone,
    isMemoryRecordUpdated,
    shortTermMemoryHint,
    shortTermMinContextTokens,
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
    submitReasoningReview,
    syncReasoningSessionUi,
    toggleGlobalRuntime,
    toggleHermesRuntime,
    visibleLogLines,
    skillProposalsList,
    skillIntentsActive,
    skillProposalGovernance,
    skillProposalsBusy,
    skillProposalsError,
    skillProposalsScanMessage,
    skillProposalsActionBusy,
    loadSkillProposals,
    scanSkillProposals,
    testSkillProposal,
    reviewSkillProposal,
    promoteSkillProposal,
    rejectSkillProposal,
    rollbackSkillIntent,
    deactivateSkillIntent,
    smartStartHermes,
    smartStartBusy,
    smartStartMessage,
    startOmlxApp,
    omlxStartBusy,
    omlxStartMessage,
    versions,
    loadVersions,
    supervisionResult,
    supervisionLoading,
    loadSupervisionResult,
  }
}