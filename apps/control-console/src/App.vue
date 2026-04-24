<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch, nextTick } from 'vue'
import { Codemirror } from 'vue-codemirror'
import { json } from '@codemirror/lang-json'
import { markdown } from '@codemirror/lang-markdown'
import { oneDark } from '@codemirror/theme-one-dark'

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

type ChatMemoryFile = ChatMemoryFileSummary & {
  content: string
}

type ReasoningPlanStep = {
  stepId: string
  title: string
  action: string
  tool: string
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
  targetType: 'plan' | 'step'
  stepId?: string | null
  stepIndex?: number | null
  title: string
  summary: string
  correctionPrompt?: string | null
  iteration?: number
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
  agentId: string
  userPrompt: string
  status: 'planning' | 'running' | 'waiting_review' | 'completed' | 'failed'
  createdAt: string
  updatedAt: string
  plan: ReasoningPlan | null
  currentStepId: string | null
  review?: ReasoningReview | null
  events: ReasoningEvent[]
  artifacts: {
    projectRoot?: string
    storyIndex?: ReasoningStoryIndexItem[]
    finalAnswer?: string
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

type MemoryConfigAgent = {
  name: string
  title: string
  agentId: string
  role: string
  personality: string
  responsibilities: string[]
}

type MemoryConfig = {
  sourceFiles: string[]
  agentCount: number
  agents: MemoryConfigAgent[]
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

// 模型交互沙盒状态
const sandboxOpen = ref(false)
const sandboxPrompt = ref('')
const sandboxReply = ref('')
const sandboxBusy = ref(false)
const sandboxError = ref('')
const chatContextInfo = ref<ChatContextInfo | null>(null)
const chatUiStatus = ref<ChatUiStatus>({
  kind: 'idle',
  message: '',
  activeRequest: null,
  recovery: null,
})
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
const reasoningReviewBusy = ref(false)
const reasoningReviewDraft = ref('')
const reasoningAutoApproveEnabled = ref(true)
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
const selectedContextSourceId = ref('')
const selectedContextSource = ref<ContextSourceCandidate | null>(null)
const sourceEditorBusy = ref(false)
const sourceEditorError = ref('')
const sourceEditorSaveBusy = ref(false)
const sourceEditorSaveMessage = ref('')
const sourceEditorFile = ref<EditableFileRecord | null>(null)
const sourceEditorContent = ref('')
const contextPoolFile = ref<EditableFileRecord | null>(null)
const contextPoolFileContent = ref('')
const contextPoolFileSaveMessage = ref('')
const editorModalOpen = ref(false)
const editorModalKind = ref<'source' | 'context-pool' | null>(null)

const editorTheme = [oneDark]

function escapeHtml(value: string) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function sanitizeMarkdownUrl(rawUrl: string) {
  const value = String(rawUrl || '').trim()
  if (/^(https?:|mailto:)/i.test(value)) return value
  return ''
}

function renderInlineMarkdown(input: string) {
  const placeholders: string[] = []
  let output = escapeHtml(String(input || ''))

  output = output.replace(/`([^`]+)`/g, (_, code) => {
    const token = `@@MD_TOKEN_${placeholders.length}@@`
    placeholders.push(`<code>${escapeHtml(code)}</code>`)
    return token
  })

  output = output.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, label, url) => {
    const safeUrl = sanitizeMarkdownUrl(url)
    if (!safeUrl) return escapeHtml(label)
    const token = `@@MD_TOKEN_${placeholders.length}@@`
    placeholders.push(`<a href="${escapeHtml(safeUrl)}" target="_blank" rel="noreferrer">${escapeHtml(label)}</a>`)
    return token
  })

  output = output.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
  output = output.replace(/__([^_]+)__/g, '<strong>$1</strong>')
  output = output.replace(/(^|[^*])\*([^*]+)\*(?!\*)/g, '$1<em>$2</em>')
  output = output.replace(/(^|[^_])_([^_]+)_(?!_)/g, '$1<em>$2</em>')

  placeholders.forEach((replacement, index) => {
    output = output.replace(`@@MD_TOKEN_${index}@@`, replacement)
  })

  return output
}

function renderMarkdownBlock(block: string) {
  const trimmed = String(block || '').trim()
  if (!trimmed) return ''

  if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
    return '<hr />'
  }

  const codeFenceMatch = trimmed.match(/^```([\w-]+)?\n([\s\S]*?)\n```$/)
  if (codeFenceMatch) {
    const language = String(codeFenceMatch[1] || '').trim()
    const code = escapeHtml(codeFenceMatch[2] || '')
    const languageAttr = language ? ` data-language="${escapeHtml(language)}"` : ''
    return `<pre><code${languageAttr}>${code}</code></pre>`
  }

  const headingMatch = trimmed.match(/^(#{1,6})\s+(.+)$/)
  if (headingMatch && trimmed.split(/\r?\n/).length === 1) {
    const level = Math.min(6, headingMatch[1].length)
    return `<h${level}>${renderInlineMarkdown(headingMatch[2])}</h${level}>`
  }

  const lines = trimmed.split(/\r?\n/)
  if (lines.every((line) => /^>\s?/.test(line))) {
    return `<blockquote>${lines.map((line) => renderInlineMarkdown(line.replace(/^>\s?/, ''))).join('<br />')}</blockquote>`
  }

  if (lines.every((line) => /^[-*+]\s+/.test(line))) {
    return `<ul>${lines.map((line) => `<li>${renderInlineMarkdown(line.replace(/^[-*+]\s+/, '').trim())}</li>`).join('')}</ul>`
  }

  if (lines.every((line) => /^\d+\.\s+/.test(line))) {
    return `<ol>${lines.map((line) => `<li>${renderInlineMarkdown(line.replace(/^\d+\.\s+/, '').trim())}</li>`).join('')}</ol>`
  }

  return `<p>${lines.map((line) => renderInlineMarkdown(line)).join('<br />')}</p>`
}

function renderChatMessage(markdownText: string) {
  const source = String(markdownText || '').replace(/\r\n/g, '\n')
  if (!source.trim()) return '<p></p>'

  const blocks: string[] = []
  let current = ''
  let inCodeFence = false

  for (const line of source.split('\n')) {
    if (line.startsWith('```')) {
      current += `${current ? '\n' : ''}${line}`
      inCodeFence = !inCodeFence
      continue
    }

    if (!inCodeFence && !line.trim()) {
      if (current.trim()) {
        blocks.push(current)
        current = ''
      }
      continue
    }

    current += `${current ? '\n' : ''}${line}`
  }

  if (current.trim()) blocks.push(current)
  return blocks.map((block) => renderMarkdownBlock(block)).join('')
}

function formatDurationSeconds(totalSeconds: number) {
  const safeSeconds = Math.max(0, Math.round(Number(totalSeconds) || 0))
  const hours = Math.floor(safeSeconds / 3600)
  const minutes = Math.floor((safeSeconds % 3600) / 60)
  const seconds = safeSeconds % 60
  if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`
  if (minutes > 0) return `${minutes}m ${seconds}s`
  return `${seconds}s`
}

function getReasoningSessionElapsedSeconds(session: ReasoningSession | null, nowMs: number) {
  if (!session) return 0
  const startedAt = new Date(session.createdAt).getTime()
  if (Number.isNaN(startedAt)) return 0
  const isFinished = session.status === 'completed' || session.status === 'failed'
  const endAt = isFinished ? new Date(session.updatedAt).getTime() : nowMs
  if (Number.isNaN(endAt)) return 0
  return Math.max(0, Math.round((endAt - startedAt) / 1000))
}

function getReasoningEventData(event: ReasoningEvent) {
  return event.data && typeof event.data === 'object' ? event.data : null
}

function getReasoningEventMetaLines(event: ReasoningEvent) {
  const data = getReasoningEventData(event)
  if (!data) return [] as string[]

  const lines: string[] = []
  if (typeof data.tool === 'string' && data.tool.trim()) {
    lines.push(`工具: ${data.tool.trim()}`)
  }
  if (typeof data.action === 'string' && data.action.trim()) {
    lines.push(`动作: ${data.action.trim()}`)
  }
  if (Number.isInteger(data.stepIndex)) {
    lines.push(`步骤序号: #${Number(data.stepIndex) + 1}`)
  }
  return lines
}

function getReasoningEventOps(event: ReasoningEvent) {
  const data = getReasoningEventData(event)
  if (!data || !Array.isArray(data.observableOps)) return [] as string[]
  return data.observableOps.map((item) => String(item || '').trim()).filter(Boolean)
}

function formatReasoningEventTime(timestamp: string) {
  const value = new Date(timestamp)
  if (Number.isNaN(value.getTime())) return timestamp
  return value.toLocaleTimeString('zh-CN', { hour12: false })
}

const sourceEditorExtensions = computed(() => {
  const filePath = selectedContextSource.value?.filePath || ''
  if (/\.json$/i.test(filePath)) {
    return [...editorTheme, json()]
  }
  return [...editorTheme, markdown()]
})

const contextPoolEditorExtensions = computed(() => [...editorTheme, json()])

const sourceEditorDirty = computed(() => sourceEditorContent.value !== (sourceEditorFile.value?.content || ''))
const contextPoolFileDirty = computed(() => contextPoolFileContent.value !== (contextPoolFile.value?.content || ''))
const editorModalTitle = computed(() => {
  if (editorModalKind.value === 'source') {
    return selectedContextSource.value?.label || '原始上下文文件编辑器'
  }
  if (editorModalKind.value === 'context-pool') {
    return selectedContextPoolEntry.value?.title || '上下文池文件编辑器'
  }
  return '文件编辑器'
})
const activeEditorFilePath = computed(() => {
  if (editorModalKind.value === 'source') {
    return sourceEditorFile.value?.filePath || ''
  }
  if (editorModalKind.value === 'context-pool') {
    return contextPoolFile.value?.filePath || ''
  }
  return ''
})



const leftBrainRunning = ref(false)
const rightBrainRunning = ref(false)
const rawLiveLogs = ref('')
const clearedLogLineCount = ref(0)
const chatScrollContainer = ref<HTMLElement | null>(null)
let logInterval: any = null
let chatUiClockInterval: ReturnType<typeof setInterval> | null = null
let chatHistoryPollTimer: ReturnType<typeof setTimeout> | null = null
let reasoningPollTimer: ReturnType<typeof setTimeout> | null = null
const chatUiNow = ref(Date.now())


const visibleLogLines = computed(() => {
  const lines = rawLiveLogs.value ? rawLiveLogs.value.split('\n') : []
  return lines.slice(clearedLogLineCount.value).filter((line) => line.length > 0)
})

const logContainer = ref<HTMLElement | null>(null)
watch(visibleLogLines, async () => {
  if (logContainer.value) {
    await nextTick()
    logContainer.value.scrollTop = logContainer.value.scrollHeight
  }

})

onMounted(() => {
  logInterval = setInterval(fetchLogs, 1500)
  chatUiClockInterval = setInterval(() => {
    chatUiNow.value = Date.now()
  }, 1000)
  window.addEventListener('keydown', handleEditorModalWindowKeydown, true)
  void loadContextCandidates()
})

onUnmounted(() => {
  if (logInterval) {
    clearInterval(logInterval)
    logInterval = null
  }
  if (chatUiClockInterval) {
    clearInterval(chatUiClockInterval)
    chatUiClockInterval = null
  }
  stopChatHistoryPolling()
  stopReasoningPolling()
  window.removeEventListener('keydown', handleEditorModalWindowKeydown, true)
  document.body.style.overflow = ''
})

watch(editorModalOpen, (isOpen) => {
  document.body.style.overflow = isOpen ? 'hidden' : ''
  if (isOpen) {
    focusActiveEditorInModal()
  }
})

async function fetchLogs() {
  if (selectedAgentId.value) {
    try {
      const res = await fetch('/api/control/agents/' + selectedAgentId.value + '/logs')
      const data = await res.json()
      if (data.ok) {
        rawLiveLogs.value = data.logs
        const currentLineCount = rawLiveLogs.value ? rawLiveLogs.value.split('\n').filter((line: string) => line.length > 0).length : 0
        if (currentLineCount < clearedLogLineCount.value) {
          clearedLogLineCount.value = 0
        }
      }
    } catch(e) {}
  }
}

function clearVisibleLogs() {
  const lines = rawLiveLogs.value ? rawLiveLogs.value.split('\n').filter((line) => line.length > 0) : []
  clearedLogLineCount.value = lines.length
}

function getLogLineColor(line: string) {
  if (line.includes('[ERROR]') || line.includes('ERROR') || line.includes('失败') || line.includes('异常')) {
    return '#ff8a80'
  }
  if (line.includes('[OK]') || line.includes('OK')) {
    return '#9de2b0'
  }
  return '#d7e3d8'
}

async function actOnModel(side: 'left' | 'right', action: 'load'|'unload') {
  const brain = side === 'left' ? leftBrain.value : rightBrain.value
  if (!brain.model) return
  const isLeft = side === 'left'
  if (isLeft) inspectingLeft.value = true
  else inspectingRight.value = true

  try {
     const res = await fetch('/api/control/models/' + action, {
       method: 'POST',
       headers: { 'Content-Type': 'application/json' },
       body: JSON.stringify({ model: brain.model, provider: brain.provider, baseUrl: brain.baseUrl })
     })
     const payload = await res.json().catch(() => null)
     if (!res.ok) {
       throw new Error(payload?.error || `model_${action}_http_${res.status}`)
     }
     if (isLeft) applyControlState(payload?.state || null)
     // If unloaded, mark as not ready
     if (action === 'unload') {
       if (isLeft && leftInspection.value) leftInspection.value.accessible = false
       if (!isLeft && rightInspection.value) rightInspection.value.accessible = false
     } else {
       await inspectSelectedModel(side) // Re-inspect to set it ready
     }
     await fetchLogs()
  } catch(e) {
    if (isLeft) leftError.value = String(e)
    else rightError.value = String(e)
    await fetchLogs()
  }
  if (isLeft) inspectingLeft.value = false
  else inspectingRight.value = false
}

const leftBrain = ref({

  provider: 'omlx',
  baseUrl: 'http://127.0.0.1:18888/v1',
  model: '',
  contextLength: null as number | null,
  recommendedMaxOutputTokens: null as number | null,
  tokenizer: null as string | null,
  metadataSource: 'unavailable'
})
const rightBrain = ref({
  provider: 'omlx',
  baseUrl: 'http://127.0.0.1:18888/v1',
  model: '',
  contextLength: null as number | null,
  recommendedMaxOutputTokens: null as number | null,
  tokenizer: null as string | null,
  metadataSource: 'unavailable'
})

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







type LocalModelItem = {
  id: string
  created?: number | null
  ownedBy?: string | null
  contextLength?: number | null
  recommendedMaxOutputTokens?: number | null
  tokenizer?: string | null
  metadataSource?: string
}

const selectedAgent = computed(() => {
  return agentOptions.value.find((item) => item.definition.id === selectedAgentId.value) || null
})

const runtimeStatus = computed(() => {
  if (selectedAgent.value?.definition.runtime === 'openclaw') {
    return '待开放 (占位)'
  }
  return runtimeState.value?.label || '未选择'
})

const runtimePrimaryAction = computed<'start' | 'pause' | 'resume' | null>(() => {
  const actions = runtimeState.value?.availableActions || []
  if (actions.includes('pause')) return 'pause'
  if (actions.includes('resume')) return 'resume'
  if (actions.includes('start')) return 'start'
  return null
})

const runtimeActionLabel = computed(() => {
  if (!runtimePrimaryAction.value) return '启动引擎'
  if (runtimePrimaryAction.value === 'pause') return '暂停引擎'
  if (runtimePrimaryAction.value === 'resume') return '恢复引擎'
  if (runtimePrimaryAction.value === 'start') return '启动引擎'
  return '未安装'
})

const canAllRestartRuntime = computed(() => {
  return Boolean(runtimeState.value?.availableActions?.includes('all-restart'))
})

const selectedModelOption = computed(() => {
  return availableLeftModels.value.find((item: LocalModelItem) => item.id === leftBrain.value.model) || null
})

const persistedModelLoaded = computed(() => {
  return controlState.value?.model?.status === 'loaded'
    && controlState.value.model.model === leftBrain.value.model
    && controlState.value.model.provider === leftBrain.value.provider
    && controlState.value.model.baseUrl === leftBrain.value.baseUrl
})

const leftSelectedModelLoaded = computed(() => {
  return persistedModelLoaded.value || (!!leftBrain.value.model && leftInspection.value?.model === leftBrain.value.model && leftInspection.value?.accessible === true)
})

const leftBrainSummary = computed(() => {
  const providerLabel = leftBrain.value.provider === 'ollama' ? 'Ollama' : 'OMLX (Local)'
  return {
    providerLabel,
    baseUrlLabel: leftBrain.value.baseUrl || '默认',
    modelLabel: leftBrain.value.model || '未选择模型',
    tokenLabel: leftInspection.value?.usage?.totalTokens ?? '-',
    statusLabel: leftSelectedModelLoaded.value ? '已启动' : '未启动'
  }
})

function buildLeftBrainConfigPayload() {
  return {
    provider: leftBrain.value.provider,
    baseUrl: leftBrain.value.baseUrl,
    model: leftBrain.value.model,
    shortTerm: {
      minContextTokens: shortTermMinContextTokens.value
    },
    memory: memoryConfig.value ? {
      agentDefinitionFile: memoryConfig.value.agentDefinitionFile,
      userFile: memoryConfig.value.userFile,
      memoryFile: memoryConfig.value.memoryFile,
      statusFile: memoryConfig.value.statusFile,
      taskQueueFile: memoryConfig.value.taskQueueFile,
      decisionsFile: memoryConfig.value.decisionsFile,
      dailyLogDir: memoryConfig.value.dailyLogDir
    } : null,
    skills: {
      skillRoot: skillConfig.value?.skillRoot || '',
      skillFiles: skillFilesText.value.split(/\r?\n/).map((item) => item.trim()).filter(Boolean)
    },
    brains: {
      rightBrainEnabled: false
    }
  }
}

function createLeftBrainConfigSignature(config: ReturnType<typeof buildLeftBrainConfigPayload>) {
  return JSON.stringify(config)
}

const leftBrainConfigSignature = computed(() => createLeftBrainConfigSignature(buildLeftBrainConfigPayload()))

const leftBrainConfigSaved = computed(() => {
  return !!persistedLeftBrainConfigSignature.value
    && leftBrainConfigSignature.value === persistedLeftBrainConfigSignature.value
    && controlState.value?.config?.saved === true
})

const effectivePreflightReady = computed(() => {
  if (preflightResult.value?.ready) return true
  return controlState.value?.preflight?.ready === true
    && controlState.value.preflight.configFingerprint === leftBrainConfigSignature.value
})

const startBlockedByModelInspection = computed(() => {
  if (selectedAgent.value?.definition.runtime !== 'hermes') return false
  return fetchingLeft.value || inspectingLeft.value || !leftSelectedModelLoaded.value
})

const leftBrainBlockedReason = computed(() => {
  if (memoryConfigBusy.value || configSaving.value || runtimeBusy.value) return '控制面处理中，请稍候。'
  if (!leftBrainConfigSaved.value) return '未保存左脑配置，请先保存。'
  if (!leftSelectedModelLoaded.value) return controlState.value?.model?.detail || '模型未启动，请先加载模型。'
  if (!configReadiness.value?.ready) return '左脑配置校验未通过，请先修复配置项。'
  if (!effectivePreflightReady.value) return controlState.value?.preflight?.detail || '尚未完成左脑自检。'
  return ''
})

const leftBrainStartBlocked = computed(() => {
  if (leftBrainRunning.value) return runtimeBusy.value
  return startBlockedByModelInspection.value || !leftBrainConfigSaved.value || !configReadiness.value?.ready || !effectivePreflightReady.value
})

const saveLeftBrainLabel = computed(() => {
  if (configSaving.value) return '保存中...'
  return leftBrainConfigSaved.value ? '已保存左脑配置' : '未保存左脑配置'
})

function applyControlState(state: HermesControlState | null | undefined) {
  if (!state) return
  controlState.value = state
  leftBrainRunning.value = state.runtime?.state === 'running'
  if (state.model?.inspection) {
    leftInspection.value = state.model.inspection
  } else if (state.preflight?.inspection) {
    leftInspection.value = state.preflight.inspection
  }
}

// 添加中文标签映射，使机器的 key 更易读
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
    'skills-files': '技能文件'
  }
  return map[key] || key
}

function resetPreflightState() {
  preflightResult.value = null
  preflightError.value = ''
}

watch(leftBrainConfigSignature, (nextValue, previousValue) => {
  if (!previousValue || loadingEngineConfig.value) return
  if (nextValue === previousValue) return
  configSaveMessage.value = ''
  configSaveError.value = ''
  resetPreflightState()
})

onMounted(async () => {
  const [healthResult, agentsResult] = await Promise.allSettled([
    fetch('/api/health'),
    fetch('/api/control/agents')
  ])

  if (healthResult.status === 'fulfilled') {
    if (healthResult.value.ok) {
      managerHealth.value = await healthResult.value.json()
      healthError.value = ''
    } else {
      healthError.value = `health_http_${healthResult.value.status}`
    }
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

      if (activeAgentId.value && agentOptions.value.find(item => item.definition.id === activeAgentId.value)) {
        selectedAgentId.value = activeAgentId.value
        await connectSelectedAgent()
      }
    } else {
      error.value = `agents_http_${agentsResult.value.status}`
    }
  } else {
    error.value = agentsResult.reason instanceof Error ? agentsResult.reason.message : String(agentsResult.reason)
  }
})

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
    resetPreflightState()
    error.value = ''
    return
  }

  await loadEngineConfig()
  await loadReasoningCapabilities()
  await loadChatHistory()
  await loadHermesRuntimeStatus()
  await restoreBufferedReasoningSession()
  if (runtimeState.value?.state === 'running') {
    await loadHermesSelfCheck()
  } else {
    selfCheck.value = null
  }
}

async function loadReasoningCapabilities() {
  reasoningCapabilitiesBusy.value = true
  reasoningCapabilitiesError.value = ''
  try {
    const response = await fetch('/api/control/agents/hermes-manager/reasoning-capabilities')
    const payload = await response.json().catch(() => null)
    if (!response.ok || !payload?.ok || !payload?.capabilities) {
      throw new Error(payload?.error || `reasoning_capabilities_http_${response.status}`)
    }
    reasoningCapabilities.value = payload.capabilities
  } catch (caught) {
    reasoningCapabilitiesError.value = caught instanceof Error ? caught.message : String(caught)
  } finally {
    reasoningCapabilitiesBusy.value = false
  }
}

async function loadHermesRuntimeStatus() {
  await refreshHermesRuntimeState()
}

async function refreshHermesRuntimeState() {
  const response = await fetch('/api/control/agents/hermes-manager/runtime-status')
  if (!response.ok) {
    throw new Error(`runtime_status_http_${response.status}`)
  }

  const payload = await response.json()
  runtimeState.value = payload.runtimeStatus
  applyControlState(payload.state)
}



async function loadEngineConfig() {
  memoryConfigBusy.value = true
  loadingEngineConfig.value = true
  try {
    const response = await fetch('/api/control/agents/' + selectedAgentId.value + '/config')
    if (response.ok) {
      const payload = await response.json()
      if (payload.ok) {
         // load into left
         leftBrain.value.provider = payload.config.provider
         leftBrain.value.baseUrl = payload.config.baseUrl
         leftBrain.value.model = payload.config.model
         memoryConfig.value = payload.config.memory || null
         skillConfig.value = payload.config.skills || null
         configReadiness.value = payload.config.readiness || null
        applyControlState(payload.config.state || null)
         shortTermMinContextTokens.value = payload.config.shortTerm?.minContextTokens || 65536
         skillFilesText.value = (payload.config.skills?.skillFiles || []).join('\n')
         persistedLeftBrainConfigSignature.value = createLeftBrainConfigSignature({
           provider: payload.config.provider,
           baseUrl: payload.config.baseUrl,
           model: payload.config.model,
           shortTerm: {
             minContextTokens: payload.config.shortTerm?.minContextTokens || 65536
           },
           memory: payload.config.memory ? {
             agentDefinitionFile: payload.config.memory.agentDefinitionFile,
             userFile: payload.config.memory.userFile,
             memoryFile: payload.config.memory.memoryFile,
             statusFile: payload.config.memory.statusFile,
             taskQueueFile: payload.config.memory.taskQueueFile,
             decisionsFile: payload.config.memory.decisionsFile,
             dailyLogDir: payload.config.memory.dailyLogDir
           } : null,
           skills: {
             skillRoot: payload.config.skills?.skillRoot || '',
             skillFiles: payload.config.skills?.skillFiles || []
           },
           brains: {
             rightBrainEnabled: false
           }
         })
         rightBrain.value.provider = payload.config.provider
         rightBrain.value.baseUrl = payload.config.baseUrl
         rightBrain.value.model = payload.config.model
         rightBrainRunning.value = false
         resetPreflightState()
         memoryConfigError.value = ''
         configSaveMessage.value = ''
         configSaveError.value = ''
         // init both
         await fetchLocalModels('left')
      }
    } else {
      controlState.value = null
      memoryConfig.value = null
      skillConfig.value = null
      configReadiness.value = null
      persistedLeftBrainConfigSignature.value = ''
      resetPreflightState()
      memoryConfigError.value = `config_http_${response.status}`
    }
  } catch(e) {
    controlState.value = null
    memoryConfig.value = null
    skillConfig.value = null
    configReadiness.value = null
    persistedLeftBrainConfigSignature.value = ''
    resetPreflightState()
    memoryConfigError.value = String(e)
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
    const payloadBody = buildLeftBrainConfigPayload()
    const response = await fetch('/api/control/agents/' + selectedAgentId.value + '/config', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payloadBody)
    })

    const payload = await response.json().catch(() => null)
    if (!response.ok || !payload?.ok) {
      throw new Error(payload?.error || `save_config_http_${response.status}`)
    }

    applyControlState(payload.state || null)
    await loadEngineConfig()
    configSaveMessage.value = '已保存左脑配置。'
    resetPreflightState()
  } catch (e) {
    configSaveError.value = String(e)
  } finally {
    configSaving.value = false
  }
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
    const backendParam = brain.value.provider === 'ollama' ? 'ollama' : 'omlx'
    const query = new URLSearchParams({
      provider: backendParam,
      baseUrl: brain.value.baseUrl
    })
    const resp = await fetch('/api/control/local-models?' + query.toString())
    if (resp.ok) {
      const data = await resp.json()
      if (data.ok) {
        avail.value = data.models as LocalModelItem[]
        if (data.models.length > 0 && !data.models.find((m: LocalModelItem) => m.id === brain.value.model)) {
          brain.value.model = data.models[0].id
        } else if (data.models.length === 0) {
          brain.value.model = ''
          err.value = '请启动推理模型（OMLX），然后刷新模型列表。'
        }
        syncEngineMetadataFromSelection(side)
        if (brain.value.model) {
          await inspectSelectedModel(side)
        } else {
          const inspection = side === 'left' ? leftInspection : rightInspection
          inspection.value = null
        }
      } else {
        avail.value = []
        err.value = data.error || '模型列表获取失败'
      }
    } else {
      avail.value = []
      err.value = 'http_' + resp.status
    }
  } catch (e) {
    avail.value = []
    err.value = String(e)
  } finally {
    fetching.value = false
  }
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



async function inspectSelectedModel(side: 'left' | 'right') {
  const brain = side === 'left' ? leftBrain : rightBrain
  const inspection = side === 'left' ? leftInspection : rightInspection
  const inspecting = side === 'left' ? inspectingLeft : inspectingRight

  if (!brain.value.model) {
    inspection.value = null
    return
  }

  inspecting.value = true
  try {
    const backendParam = brain.value.provider === 'ollama' ? 'ollama' : 'omlx'
    const query = new URLSearchParams({
      provider: backendParam,
      model: brain.value.model,
      baseUrl: brain.value.baseUrl
    })
    const response = await fetch('/api/control/local-models/inspect?' + query.toString())
    if (!response.ok) throw new Error('inspect_' + response.status)
    const payload = await response.json()
    inspection.value = payload.inspection || null
    if (side === 'left' && payload.state) applyControlState(payload.state)
  } catch (e) {
    inspection.value = {
      model: brain.value.model,
      accessible: false,
      status: 'error',
      detail: String(e),
      checkedAt: new Date().toISOString(),
      usage: { promptTokens: null, completionTokens: null, totalTokens: null },
      contextLength: brain.value.contextLength,
      recommendedMaxOutputTokens: brain.value.recommendedMaxOutputTokens,
      tokenizer: brain.value.tokenizer,
      metadataSource: brain.value.metadataSource
    } as any
  } finally {
    inspecting.value = false
  }
}

function handleProviderChange(side: 'left' | 'right') {
  const brain = side === 'left' ? leftBrain : rightBrain
  brain.value.baseUrl = brain.value.provider === 'ollama' ? 'http://127.0.0.1:11434/v1' : 'http://127.0.0.1:18888/v1'
  brain.value.model = ''
  if (side === 'left') resetPreflightState()
  if(side === 'left') { availableLeftModels.value = []; leftInspection.value = null }
  else { availableRightModels.value = []; rightInspection.value = null }
  fetchLocalModels(side)
}

function handleModelChange(side: 'left' | 'right') {
  if (side === 'left') resetPreflightState()
  syncEngineMetadataFromSelection(side)
  inspectSelectedModel(side)
}

async function runLeftBrainPreflight() {
  if (!selectedAgentId.value || !memoryConfig.value || !skillConfig.value) return

  preflightBusy.value = true
  preflightError.value = ''
  error.value = ''

  try {
    const response = await fetch('/api/control/agents/' + selectedAgentId.value + '/preflight-check', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        config: buildLeftBrainConfigPayload()
      })
    })

    const payload = await response.json().catch(() => null)
    if (!response.ok || !payload?.ok) {
      throw new Error(payload?.error || `preflight_http_${response.status}`)
    }

    applyControlState(payload.state || null)
    preflightResult.value = payload.preflight || null
    configReadiness.value = payload.preflight?.readiness || configReadiness.value
    if (payload.preflight?.selectedModel) {
      leftBrain.value.model = payload.preflight.selectedModel
    }
    if (Array.isArray(payload.preflight?.models)) {
      availableLeftModels.value = payload.preflight.models
      syncEngineMetadataFromSelection('left')
    }
    if (payload.preflight?.inspection) {
      leftInspection.value = payload.preflight.inspection
    }
    if (!payload.preflight?.ready) {
      preflightError.value = '左脑自检未通过，请先修复红色项后再启动。'
    }
    await fetchLogs()
  } catch (caught) {
    preflightResult.value = null
    preflightError.value = caught instanceof Error ? caught.message : String(caught)
  } finally {
    preflightBusy.value = false
  }
}

const chatHistory = ref<ChatHistoryEntry[]>([])
const chatMemoryDirty = computed(() => chatMemoryDraft.value !== chatMemoryLoadedContent.value)
const reasoningStatusLabel = computed(() => {
  if (!activeReasoningSession.value) return '未开始'
  if (activeReasoningSession.value.status === 'planning') return '规划中'
  if (activeReasoningSession.value.status === 'running') return '执行中'
  if (activeReasoningSession.value.status === 'waiting_review') return '待审核'
  if (activeReasoningSession.value.status === 'completed') return '已完成'
  return '失败'
})

const reasoningPendingReview = computed(() => {
  const review = activeReasoningSession.value?.review
  return activeReasoningSession.value?.status === 'waiting_review' && review ? review : null
})

const reasoningReviewTargetLabel = computed(() => {
  const review = reasoningPendingReview.value
  if (!review) return ''
  return review.targetType === 'plan' ? '计划审核' : `步骤审核${review.stepIndex != null ? ` #${review.stepIndex + 1}` : ''}`
})

const reasoningReviewEvidence = computed(() => reasoningPendingReview.value?.evidence || null)

function formatReasoningEvidence(value: unknown) {
  if (value == null) return ''
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

function parseStructuredOutboundPreview(value: unknown): StructuredOutboundPreview | null {
  if (!value || typeof value !== 'object') return null
  const preview = value as StructuredOutboundPreview
  if (!preview.controllerRequest && !preview.runtimeRoute && !preview.plannerHints) return null
  return preview
}

function getPreviewControllerRequest(value: unknown) {
  return parseStructuredOutboundPreview(value)?.controllerRequest || null
}

function getPreviewRuntimeRoute(value: unknown) {
  return parseStructuredOutboundPreview(value)?.runtimeRoute || null
}

function getPreviewPlannerHints(value: unknown) {
  return parseStructuredOutboundPreview(value)?.plannerHints || null
}

function formatActionHintLine(hint: { keywords: string[]; requiredActions: string[]; answerAction: string }) {
  return `${hint.keywords.join(' | ')} => ${[...hint.requiredActions, hint.answerAction].filter(Boolean).join(', ')}`
}

function validateJsonEditorContent(filePath: string, content: string) {
  if (!/\.json$/i.test(filePath)) return
  JSON.parse(content)
}

const chatRuntimeTimeoutSeconds = computed(() => {
  return Math.round((chatContextInfo.value?.runtime.timeoutMs || 0) / 1000)
})

const chatActiveRequestElapsedSeconds = computed(() => {
  const activeRequest = chatUiStatus.value.activeRequest
  if (!activeRequest) return 0

  const startedAtMs = new Date(activeRequest.startedAt).getTime()
  if (Number.isNaN(startedAtMs)) {
    return Math.max(0, Math.round(activeRequest.activeForMs / 1000))
  }

  return Math.max(0, Math.round((chatUiNow.value - startedAtMs) / 1000))
})

const reasoningElapsedSeconds = computed(() => getReasoningSessionElapsedSeconds(activeReasoningSession.value, chatUiNow.value))

const shortTermMemoryHint = computed(() => {
  const modelId = String(leftBrain.value.model || '').trim().toLowerCase()
  if (modelId.includes('gemma-4-26b-a4b')) {
    return 'Gemma-4-26B-A4B 当前 OMLX 配置应填写为：短期记忆最小窗口 65536。该项只校验上下文窗口；最大输出 token 4096 由模型服务配置控制，不在这里填写。'
  }
  return '这里填写的是模型最小上下文窗口要求。要通过自检，模型的上下文窗口必须大于等于该值；最大输出 token 由模型服务自身配置控制。'
})

watch(chatHistory, async () => {
  if (chatScrollContainer.value) {
    await nextTick()
    chatScrollContainer.value.scrollTop = chatScrollContainer.value.scrollHeight
  }
}, { deep: true })

function handleChatComposerKeydown(event: KeyboardEvent) {
  if (event.key !== 'Enter') return
  if (event.metaKey || event.ctrlKey) {
    event.preventDefault()
    sendChat()
  }
}

function focusActiveEditorInModal() {
  void nextTick(() => {
    const editor = document.querySelector('.editor-modal-shell .cm-content') as HTMLElement | null
    if (editor) {
      editor.focus()
      return
    }
    const fallback = document.querySelector('.editor-modal-shell') as HTMLElement | null
    fallback?.focus()
  })
}

function openEditorModal(kind: 'source' | 'context-pool') {
  editorModalKind.value = kind
  editorModalOpen.value = true
  focusActiveEditorInModal()
}

function closeEditorModal() {
  editorModalOpen.value = false
  editorModalKind.value = null
}

async function saveActiveEditorModal() {
  if (editorModalKind.value === 'source') {
    await saveContextSourceFile()
    return
  }
  if (editorModalKind.value === 'context-pool') {
    await saveContextPoolEntryEdits()
  }
}

function handleEditorModalWindowKeydown(event: KeyboardEvent) {
  if (!editorModalOpen.value) return

  const target = event.target as HTMLElement | null
  const inModal = Boolean(target?.closest('.editor-modal-shell'))
  if (!inModal) return

  const lowerKey = String(event.key || '').toLowerCase()
  const metaCombo = event.metaKey || event.ctrlKey

  if (event.key === 'Tab' && !target?.closest('.cm-editor')) {
    event.preventDefault()
    event.stopPropagation()
    focusActiveEditorInModal()
    return
  }

  if (!metaCombo) return

  if (['s', 'w', 'p', 'l'].includes(lowerKey)) {
    event.preventDefault()
    event.stopPropagation()
  }

  if (lowerKey === 's') {
    void saveActiveEditorModal()
    return
  }

  if (lowerKey === 'w') {
    closeEditorModal()
  }
}

function resetSubmitGateState() {
  submitDraftBusy.value = false
  submitDraftError.value = ''
  submitDraftResult.value = null
  submitConfirmedSummary.value = ''
  contextPoolSaveBusy.value = false
  contextPoolSaveMessage.value = ''
}

function persistActiveReasoningSessionId(sessionId: string | null) {
  if (typeof window === 'undefined') return
  if (sessionId) {
    window.localStorage.setItem(ACTIVE_REASONING_SESSION_STORAGE_KEY, sessionId)
    return
  }
  window.localStorage.removeItem(ACTIVE_REASONING_SESSION_STORAGE_KEY)
}

function readPersistedActiveReasoningSessionId() {
  if (typeof window === 'undefined') return ''
  return window.localStorage.getItem(ACTIVE_REASONING_SESSION_STORAGE_KEY) || ''
}

function syncReasoningSessionUi(session: ReasoningSession | null) {
  activeReasoningSession.value = session
  persistActiveReasoningSessionId(session?.sessionId || null)
  reasoningBusy.value = Boolean(session && (session.status === 'planning' || session.status === 'running'))
}

async function loadContextCandidates() {
  contextCandidatesBusy.value = true
  contextCandidatesError.value = ''
  try {
    const response = await fetch('/api/control/agents/hermes-manager/context-candidates')
    const payload = await response.json().catch(() => null)
    if (!response.ok || !payload?.ok) {
      throw new Error(payload?.error || `context_candidates_http_${response.status}`)
    }
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

function closeSubmitGate() {
  submitGateOpen.value = false
  submitGateMode.value = null
}

async function generateSubmitContextDraft() {
  if (!submitPromptDraft.value.trim()) return
  if (!submitGateMode.value) return

  submitDraftBusy.value = true
  submitDraftError.value = ''
  contextPoolSaveMessage.value = ''
  try {
    const response = await fetch('/api/control/agents/hermes-manager/submission-preview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        mode: submitGateMode.value,
        prompt: submitPromptDraft.value,
        selectedSourceIds: submitSelectedSourceIds.value,
        selectedContextPoolIds: submitSelectedContextPoolIds.value,
      })
    })
    const payload = await response.json().catch(() => null)
    if (!response.ok || !payload?.ok || !payload?.preview) {
      throw new Error(payload?.error || `submission_preview_http_${response.status}`)
    }
    submitDraftResult.value = payload.preview
    submitConfirmedSummary.value = ''
    if (payload.preview.contextSources) {
      chatContextInfo.value = payload.preview.contextSources
    }
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
      body: JSON.stringify({
        title: submitPromptDraft.value.trim().slice(0, 60) || 'Confirmed Context',
        prompt: submitPromptDraft.value,
        summary: submitConfirmedSummary.value,
        selectedSourceIds: submitSelectedSourceIds.value,
        selectedContextPoolIds: submitSelectedContextPoolIds.value,
      })
    })
    const payload = await response.json().catch(() => null)
    if (!response.ok || !payload?.ok || !payload?.entry) {
      throw new Error(payload?.error || `context_pool_create_http_${response.status}`)
    }
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
    if (!response.ok || !payload?.ok || !payload?.file || !payload?.source) {
      throw new Error(payload?.error || `context_source_get_http_${response.status}`)
    }
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
    const response = await fetch('/api/control/agents/hermes-manager/context-source-content', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sourceId: selectedContextSourceId.value,
        content: sourceEditorContent.value,
      })
    })
    const payload = await response.json().catch(() => null)
    if (!response.ok || !payload?.ok || !payload?.file || !payload?.source) {
      throw new Error(payload?.error || `context_source_put_http_${response.status}`)
    }
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
    if (!response.ok || !payload?.ok || !payload?.entry) {
      throw new Error(payload?.error || `context_pool_get_http_${response.status}`)
    }
    selectedContextPoolEntry.value = payload.entry
    const fileResponse = await fetch(`/api/control/agents/hermes-manager/context-pool/${entryId}/file`)
    const filePayload = await fileResponse.json().catch(() => null)
    if (!fileResponse.ok || !filePayload?.ok || !filePayload?.file) {
      throw new Error(filePayload?.error || `context_pool_file_get_http_${fileResponse.status}`)
    }
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
    const response = await fetch(`/api/control/agents/hermes-manager/context-pool/${selectedContextPoolEntryId.value}/file`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content: contextPoolFileContent.value,
      })
    })
    const payload = await response.json().catch(() => null)
    if (!response.ok || !payload?.ok || !payload?.file) {
      throw new Error(payload?.error || `context_pool_file_put_http_${response.status}`)
    }
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
  if (typeof window !== 'undefined' && !window.confirm('确认删除这条上下文池记录吗？删除后不可恢复。')) {
    return
  }

  contextPoolDeleteBusy.value = true
  contextPoolEditorError.value = ''
  contextPoolFileSaveMessage.value = ''
  try {
    const response = await fetch(`/api/control/agents/hermes-manager/context-pool/${entryId}`, {
      method: 'DELETE'
    })
    const payload = await response.json().catch(() => null)
    if (!response.ok || !payload?.ok) {
      throw new Error(payload?.error || `context_pool_delete_http_${response.status}`)
    }

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
    const response = await fetch(`/api/control/agents/hermes-manager/context-pool/${selectedContextPoolEntryId.value}/open`, {
      method: 'POST'
    })
    const payload = await response.json().catch(() => null)
    if (!response.ok || !payload?.ok) {
      throw new Error(payload?.error || `context_pool_open_http_${response.status}`)
    }
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
  stopReasoningPolling()
  chatHistory.value.push({ role: 'user', content: userText })
  syncReasoningSessionUi(null)

  try {
    const response = await fetch('/api/control/agents/hermes-manager/reasoning-sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: userText, ...submissionContext })
    })
    const payload = await response.json().catch(() => null)
    if (!response.ok || !payload?.ok || !payload?.session) {
      throw new Error(payload?.details || payload?.error || `reasoning_start_http_${response.status}`)
    }

    syncReasoningSessionUi({
      sessionId: payload.session.sessionId,
      agentId: 'hermes-manager',
      userPrompt: userText,
      status: payload.session.status,
      createdAt: payload.session.createdAt,
      updatedAt: payload.session.createdAt,
      plan: payload.session.plan,
      currentStepId: null,
      review: null,
      events: [],
      artifacts: {},
      error: null,
    })
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
  chatUiStatus.value = {
    kind: 'pending',
    message: '请求已发出，等待 Hermes / OMLX 返回。',
    activeRequest: {
      startedAt: new Date().toISOString(),
      activeForMs: 0,
      promptChars: userText.length,
      contextSources: chatContextInfo.value,
      outboundRequest: null,
    },
    recovery: null,
  }
  scheduleChatHistoryPolling(500)

  try {
    const response = await fetch('/api/control/agents/hermes-manager/ping-model', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: userText, ...submissionContext })
    })
    const payload = await response.json()
    if (payload.ok) {
      chatContextInfo.value = payload.contextSources || null
      stopChatHistoryPolling()
      chatUiStatus.value = {
        kind: 'idle',
        message: '',
        activeRequest: null,
        recovery: null,
      }
      chatHistory.value.push({
        role: 'hermes',
        content: payload.reply,
        tokens: payload.raw?.usage
      })
    } else {
      chatContextInfo.value = payload.contextSources || chatContextInfo.value
      const recovery = payload.recovery || null
      const activeRequest = payload.activeRequest || null
      const statusKind = payload.error === 'chat_busy'
        ? 'busy'
        : payload.error === 'chat_timeout'
          ? 'timeout'
          : recovery?.attempted
            ? 'recovering'
            : 'error'
      const parts = [payload.error]
      if (payload.details) {
        parts.push(payload.details)
      }
      if (activeRequest?.activeForMs != null) {
        parts.push(`当前请求已运行 ${Math.round(activeRequest.activeForMs / 1000)} 秒`)
      }
      if (recovery?.detail) {
        parts.push(recovery.detail)
      }
      chatUiStatus.value = {
        kind: statusKind,
        message: parts.filter(Boolean).join(' | '),
        activeRequest,
        recovery,
      }
      shouldPollHistory = payload.error === 'chat_timeout' || Boolean(payload.pending)
      if (payload.error !== 'chat_timeout') {
        chatHistory.value.push({ role: 'error', content: parts.filter(Boolean).join('\n') })
      }
    }
  } catch (e) {
    chatUiStatus.value = {
      kind: 'error',
      message: e instanceof Error ? e.message : String(e),
      activeRequest: null,
      recovery: null,
    }
    chatHistory.value.push({ role: 'error', content: chatUiStatus.value.message })
  } finally {
    sandboxBusy.value = false
    if (!shouldPollHistory) {
      stopChatHistoryPolling()
    }
  }
}

async function confirmSubmitGate() {
  if (!submitGateMode.value) return
  if (!submitPromptDraft.value.trim()) return

  const mode = submitGateMode.value
  const prompt = submitPromptDraft.value
  const submissionContext: Record<string, unknown> = {
    selectedSourceIds: submitSelectedSourceIds.value,
    selectedContextPoolIds: submitSelectedContextPoolIds.value,
  }
  if (submitConfirmedSummary.value.trim()) {
    submissionContext.confirmedContextSummary = submitConfirmedSummary.value
  }

  closeSubmitGate()
  if (mode === 'reasoning') {
    await performReasoningSubmission(prompt, submissionContext)
    return
  }
  await performChatSubmission(prompt, submissionContext)
}

function stopChatHistoryPolling() {
  if (!chatHistoryPollTimer) return
  clearTimeout(chatHistoryPollTimer)
  chatHistoryPollTimer = null
}

function stopReasoningPolling() {
  if (!reasoningPollTimer) return
  clearTimeout(reasoningPollTimer)
  reasoningPollTimer = null
}

function scheduleChatHistoryPolling(delayMs = 4000) {
  stopChatHistoryPolling()
  chatHistoryPollTimer = setTimeout(async () => {
    const payload = await loadChatHistory()
    if (payload?.activeRequest) {
      if (payload.activeRequest.contextSources) {
        chatContextInfo.value = payload.activeRequest.contextSources
      }
      if (chatUiStatus.value.kind === 'timeout' || chatUiStatus.value.kind === 'pending') {
        chatUiStatus.value = {
          kind: chatUiStatus.value.kind,
          message: chatUiStatus.value.message,
          activeRequest: payload.activeRequest,
          recovery: null,
        }
      }
      scheduleChatHistoryPolling(delayMs)
      return
    }

    if (chatUiStatus.value.kind === 'timeout' || chatUiStatus.value.kind === 'pending') {
      chatUiStatus.value = {
        kind: 'idle',
        message: '',
        activeRequest: null,
        recovery: null,
      }
    }
  }, delayMs)
}

async function loadReasoningSession(sessionId: string) {
  try {
    const response = await fetch(`/api/control/agents/hermes-manager/reasoning-sessions/${sessionId}`)
    const payload = await response.json().catch(() => null)
    if (!response.ok || !payload?.ok || !payload?.session) {
      throw new Error(payload?.error || `reasoning_session_http_${response.status}`)
    }
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
    if (!session) {
      return
    }

    if (session.status === 'planning' || session.status === 'running') {
      scheduleReasoningPolling(delayMs)
      return
    }

    if (session.status === 'waiting_review' && reasoningAutoApproveEnabled.value) {
      await submitReasoningReview('approve', { skipManualDraft: true })
      return
    }

    reasoningBusy.value = false
    if (session.status === 'waiting_review') {
      return
    }
    await loadChatHistory()
  }, delayMs)
}

async function restoreBufferedReasoningSession() {
  const sessionId = readPersistedActiveReasoningSessionId()
  if (!sessionId) return

  const session = await loadReasoningSession(sessionId)
  if (!session) {
    persistActiveReasoningSessionId(null)
    return
  }

  if (session.status === 'planning' || session.status === 'running') {
    scheduleReasoningPolling()
  }
}

async function sendObservableReasoningChat() {
  await openSubmitGate('reasoning')
}

async function submitReasoningReview(decision: 'approve' | 'reject', options: { skipManualDraft?: boolean } = {}) {
  const sessionId = activeReasoningSession.value?.sessionId
  if (!sessionId || !reasoningPendingReview.value) return
  if (reasoningReviewBusy.value) return

  reasoningReviewBusy.value = true
  reasoningError.value = ''
  const correctionPrompt = options.skipManualDraft ? '' : reasoningReviewDraft.value.trim()

  try {
    const response = await fetch(`/api/control/agents/hermes-manager/reasoning-sessions/${sessionId}/review`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        decision,
        correctionPrompt
      })
    })
    const payload = await response.json().catch(() => null)
    if (!response.ok || !payload?.ok || !payload?.session) {
      throw new Error(payload?.details || payload?.error || `reasoning_review_http_${response.status}`)
    }

    syncReasoningSessionUi(payload.session)
    reasoningReviewDraft.value = ''
    if (payload.session.status === 'planning' || payload.session.status === 'running') {
      reasoningBusy.value = true
      scheduleReasoningPolling(500)
    } else {
      reasoningBusy.value = false
      stopReasoningPolling()
      await loadChatHistory()
    }
  } catch (caught) {
    reasoningError.value = caught instanceof Error ? caught.message : String(caught)
  } finally {
    reasoningReviewBusy.value = false
  }
}

async function sendChat() {
  if (!sandboxPrompt.value.trim()) return
  
  const userText = sandboxPrompt.value
    await openSubmitGate('chat')
}

async function loadChatHistory() {
  try {
    const response = await fetch('/api/control/agents/hermes-manager/chat-history')
    if (response.ok) {
      const payload = await response.json()
      if (payload.ok && Array.isArray(payload.history)) {
        chatHistory.value = payload.history.map((m: any) => ({ 
          role: m.role, 
          content: m.content, 
          tokens: m.tokens 
        }))
        chatMemoryFile.value = payload.file || null
        if (payload.activeRequest?.contextSources) {
          chatContextInfo.value = payload.activeRequest.contextSources
        }
        return payload
      }
    }
  } catch (e) {
    console.error('Failed to load chat history:', e)
  }
  return null
}

async function openChatMemoryEditor() {
  chatMemoryEditorOpen.value = true
  await loadChatMemoryFile()
}

async function openChatHistoryFileInEditor() {
  chatMemoryOpenBusy.value = true
  chatMemoryError.value = ''
  chatMemoryOpenMessage.value = ''

  try {
    const response = await fetch('/api/control/agents/hermes-manager/chat-history-file/open', {
      method: 'POST'
    })
    const payload = await response.json().catch(() => null)
    if (!response.ok || !payload?.ok) {
      throw new Error(payload?.error || `open_chat_history_http_${response.status}`)
    }

    chatMemoryFile.value = payload.file || chatMemoryFile.value
    chatMemoryOpenMessage.value = `已在编辑器打开：${payload.openedWith || 'editor'}`
  } catch (e) {
    chatMemoryError.value = e instanceof Error ? e.message : String(e)
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
    const response = await fetch('/api/control/agents/hermes-manager/chat-history-file')
    const payload = await response.json().catch(() => null)
    if (!response.ok || !payload?.ok || !payload?.file) {
      throw new Error(payload?.error || `chat_history_file_http_${response.status}`)
    }

    chatMemoryFile.value = {
      filePath: payload.file.filePath,
      exists: payload.file.exists,
      sizeChars: payload.file.sizeChars,
      updatedAt: payload.file.updatedAt,
    }
    chatMemoryDraft.value = payload.file.content || '[]'
    chatMemoryLoadedContent.value = chatMemoryDraft.value
  } catch (e) {
    chatMemoryError.value = e instanceof Error ? e.message : String(e)
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
    const response = await fetch('/api/control/agents/hermes-manager/chat-history-file', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: chatMemoryDraft.value })
    })
    const payload = await response.json().catch(() => null)
    if (!response.ok || !payload?.ok || !payload?.file) {
      throw new Error(payload?.error || `save_chat_history_http_${response.status}`)
    }

    chatMemoryFile.value = {
      filePath: payload.file.filePath,
      exists: payload.file.exists,
      sizeChars: payload.file.sizeChars,
      updatedAt: payload.file.updatedAt,
    }
    chatMemoryDraft.value = payload.file.content || '[]'
    chatMemoryLoadedContent.value = chatMemoryDraft.value
    chatHistory.value = Array.isArray(payload.history)
      ? payload.history.map((m: any) => ({ role: m.role, content: m.content, tokens: m.tokens }))
      : chatHistory.value
    chatMemorySaveMessage.value = '聊天记录文件已保存。'
  } catch (e) {
    chatMemoryError.value = e instanceof Error ? e.message : String(e)
  } finally {
    chatMemorySaveBusy.value = false
  }
}

async function loadHermesSelfCheck() {
  connecting.value = true
  error.value = ''

  try {
    const response = await fetch('/api/control/agents/hermes-manager/self-check')
    if (!response.ok) {
      if (response.status === 409) {
        const payload = await response.json()
        runtimeState.value = payload.runtimeStatus || runtimeState.value
      }
      throw new Error(`self_check_http_${response.status}`)
    }

    const payload = await response.json()
    selfCheck.value = payload.selfCheck
  } catch (caught) {
    selfCheck.value = null
    error.value = caught instanceof Error ? caught.message : String(caught)
  } finally {
    connecting.value = false
  }
}



async function toggleHermesRuntime(side: 'left' | 'right') {
  if (!selectedAgent.value || selectedAgent.value.definition.runtime !== 'hermes') return
  if (side === 'right') return

  if (!leftBrainRunning.value && !leftBrainConfigSaved.value) {
    error.value = leftBrainBlockedReason.value || '请先保存左脑配置，保存生效后再启动 Hermes。'
    return
  }
  if (!leftBrainRunning.value && !leftSelectedModelLoaded.value) {
    error.value = leftBrainBlockedReason.value || '请先成功加载并探测左脑模型后再启动 Hermes。'
    return
  }
  if (!leftBrainRunning.value && !effectivePreflightReady.value) {
    error.value = leftBrainBlockedReason.value || '请先完成左脑自检，再启动 Hermes。'
    return
  }

  runtimeBusy.value = true
  error.value = ''

  try {
    const isRunningNow = leftBrainRunning.value
    const action = isRunningNow ? 'stop' : 'start'

    const willStopBoth = action === 'stop'

    const payloadBody: any = { action, brainSide: side, stopAll: willStopBoth }
    if (action === 'start') {
       payloadBody.config = {
         side,
         ...buildLeftBrainConfigPayload()
       }
    }
    const response = await fetch('/api/control/agents/hermes-manager/runtime-action', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payloadBody)
    })

    const payload = await response.json().catch(() => null)
    if (!response.ok) {
       if (payload?.preflight) preflightResult.value = payload.preflight
       if (payload?.readiness) configReadiness.value = payload.readiness
       if (payload?.state) applyControlState(payload.state)
       const readinessMessage = payload?.readiness?.items
         ?.filter((item: ConfigReadinessItem) => item.status !== 'ok')
         .map((item: ConfigReadinessItem) => `${item.label}: ${item.detail}`)
         .join(' | ')
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

  if (runtimeState.value.state === 'uninstalled') {
    error.value = runtimeState.value.detail
    return
  }

  runtimeBusy.value = true
  error.value = ''

  try {
    if ((action === 'start' || action === 'resume' || action === 'all-restart') && !leftBrainConfigSaved.value) {
      error.value = leftBrainBlockedReason.value || '请先保存左脑配置，保存生效后再启动 Hermes。'
      return
    }
    if ((action === 'start' || action === 'resume' || action === 'all-restart') && !leftSelectedModelLoaded.value) {
      error.value = leftBrainBlockedReason.value || '请先成功加载并探测左脑模型后再启动 Hermes。'
      return
    }
    if ((action === 'start' || action === 'resume' || action === 'all-restart') && !effectivePreflightReady.value) {
      error.value = leftBrainBlockedReason.value || '请先完成左脑自检，再启动 Hermes。'
      return
    }
    
    const payloadBody: any = { action, brainSide: 'left', stopAll: true }
    if (action === 'start' || action === 'resume' || action === 'all-restart') {
       payloadBody.config = {
         side: 'left',
         ...buildLeftBrainConfigPayload()
       }
    }
    const response = await fetch('/api/control/agents/hermes-manager/runtime-action', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payloadBody)
    })

    const payload = await response.json().catch(() => null)
    if (!response.ok) {
       if (payload?.preflight) preflightResult.value = payload.preflight
       if (payload?.readiness) configReadiness.value = payload.readiness
       if (payload?.state) applyControlState(payload.state)
       const readinessMessage = payload?.readiness?.items
         ?.filter((item: ConfigReadinessItem) => item.status !== 'ok')
         .map((item: ConfigReadinessItem) => `${item.label}: ${item.detail}`)
         .join(' | ')
       throw new Error(readinessMessage || payload?.error || `runtime_action_http_${response.status}`)
    }

     if (action === 'all-restart' && payload?.ok && payload?.restartingControl) {
       runtimeState.value = payload.runtimeStatus || runtimeState.value
       applyControlState(payload.state || null)
       error.value = 'Control 与 Hermes 正在整体重启，页面会短暂断开并自动恢复。'
       globalThis.setTimeout(() => {
        window.location.reload()
       }, 4000)
       return
     }

    if (payload?.ok) {
       runtimeState.value = payload.runtimeStatus
     applyControlState(payload.state || null)
       if (action === 'start' || action === 'resume') {
           leftBrainRunning.value = true
           await loadHermesSelfCheck()
       } else {
           leftBrainRunning.value = false
           rightBrainRunning.value = false
           selfCheck.value = null
       }
    }
    await fetchLogs()
  } catch (caught) {
    error.value = String(caught)
    await fetchLogs()
  } finally {
    runtimeBusy.value = false
  }
}

async function toggleGlobalRuntime() {
  const action = runtimePrimaryAction.value
  if (!action) {
    error.value = 'runtime_action_unavailable'
    return
  }
  await executeGlobalRuntimeAction(action)
}

async function restartGlobalRuntime() {
  await executeGlobalRuntimeAction('all-restart')
}

</script>

<template>
  <main class="shell">
    <header class="console-header">
      <h1>智能体网关 (Agent Gateway)</h1>
      
      <div class="agent-controls">
        <div class="agent-selector-bar">
          <label for="agent-select">全局管理器：</label>
          <div class="select-wrapper">
            <select id="agent-select" v-model="selectedAgentId" @change="connectSelectedAgent" :disabled="agentSelectionLocked">
              <option
                v-for="agent in agentOptions"
                :key="agent.definition.id"
                :value="agent.definition.id"
              >
                {{ agent.definition.name }} ({{ agent.definition.runtime }})
              </option>
            </select>
          </div>
          <div style="font-size: 12px; color: #9fb0c3; margin-top: 4px;">
            {{ agentSelectionLocked ? '所有标签页共享同一个 Hermes 全局管理器状态。' : '当前允许手动切换管理器。' }}
          </div>
        </div>
        
        <!-- 仅当选择 Hermes 时显示状态与控制按钮，在一排紧凑显示 -->
        <div class="runtime-controls" v-if="selectedAgent?.definition.runtime === 'hermes'">
          <div class="status-badge" :data-state="runtimeState?.state || 'unknown'">
            <span class="status-dot"></span>
            {{ runtimeState?.label || '检测中...' }}
          </div>

          <button
            v-if="canAllRestartRuntime"
            class="action-btn outline"
            :disabled="runtimeBusy || runtimeState?.state === 'uninstalled'"
            @click="restartGlobalRuntime"
          >
            {{ runtimeBusy ? '处理中...' : '重启引擎 runtime' }}
          </button>
          
          <button
            class="action-btn"
            :disabled="runtimeBusy || runtimeState?.state === 'uninstalled' || !runtimePrimaryAction"
            @click="toggleGlobalRuntime"
          >
            {{ runtimeBusy ? '处理中...' : runtimeActionLabel }}
          </button>

        </div>
        <div
          v-if="selectedAgent?.definition.runtime === 'hermes'"
          style="margin-top: 6px; font-size: 12px; line-height: 1.5; color: #8fa0b2;"
        >
          `重启引擎 runtime` 只会重启 Hermes runtime，不会重载 control-server 代码；如果刚修改了控制台后端流程，请执行 `sh restart_control.sh`。
        </div>
        
        <div class="runtime-controls" v-else-if="selectedAgent">
          <div class="status-badge" data-state="unknown">
            <span class="status-dot"></span>
            {{ runtimeStatus }}
          </div>
        </div>
      </div>
    </header>

    <section class="console-body" v-if="selectedAgentId">
        <!-- 提示信息横幅视图 -->
        <div class="message-banner error" v-if="healthError">
          <span>❌</span> 控制面健康检查失败: {{ healthError }}
        </div>
        
        <div class="message-banner tip" v-else-if="selectedAgent?.definition.runtime === 'openclaw'">
          <span>ℹ️</span> 提示：OpenClaw 目前仅为功能预留的占位节点。现阶段请切换回 Hermes 工作流进行系统调度。
        </div>

        <div class="message-banner error" v-else-if="runtimeState?.state === 'uninstalled'">
          <span>⚠️</span> 引擎缺失：Hermes 环境未就绪或受控网关丢失，请检查底层依赖 ({{ runtimeState?.detail }})。
        </div>
        
        <div class="message-banner tip" v-else-if="runtimeState?.state === 'stopped'">
          <span>💤</span> 智能体已休眠：Hermes 引擎已就绪，但受控服务未启动。请点击右上方的「启动引擎」按钮进行唤醒。
        </div>
        <div class="message-banner tip" v-if="selectedAgent?.definition.runtime === 'hermes' && runtimePrimaryAction && (runtimePrimaryAction === 'start' || runtimePrimaryAction === 'resume') && leftBrainBlockedReason">
          <span>ℹ️</span> 当前无法启动 Hermes：{{ leftBrainBlockedReason }}
        </div>

        <div class="feature-panels" v-if="selectedAgent?.definition.runtime === 'hermes'">
          

        <details class="panel" open style="margin-bottom: 8px; border: 1px solid #444;">
          <summary class="panel-header" style="display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 8px; background: rgba(100,100,100,0.2); padding: 4px 8px; min-height: 28px;">
            <div class="panel-title" style="font-size: 13px;">📜 后台日志与决策轨 (Real-time Logs & Trajectory)</div>
            <div style="display: flex; justify-content: flex-end;">
              <button class="action-btn outline" @click="clearVisibleLogs" style="padding: 2px 10px; font-size: 12px;">清空窗口</button>
            </div>
          </summary>
          <div class="panel-content" style="padding: 0;">
            <div ref="logContainer" style="width:100%; height: 350px; background: #111; font-family: monospace; font-size: 11px; padding: 4px; border-top: 1px solid #333; resize: vertical; outline: none; overflow: auto; white-space: pre-wrap; word-break: break-all;">
              <div v-if="visibleLogLines.length === 0" style="color: #7f8c8d;">等待日志回放...</div>
              <div v-for="(line, index) in visibleLogLines" :key="`${index}-${line}`" :style="{ color: getLogLineColor(line), marginBottom: '1px', lineHeight: '1.2' }">{{ line }}</div>
            </div>
          </div>
        </details>

        
<details class="panel" open style="margin-bottom: 16px; border: 1px solid #444;">
  <summary class="panel-header" style="display: flex; align-items: center; justify-content: space-between; background: rgba(0,200,255,0.1)">
    <div style="display: flex; flex: 1; min-width: 0; align-items: center; gap: 12px; flex-wrap: wrap;">
      <div class="panel-title" style="flex: 0 0 auto;">🧠 引擎配置 (Brain Configuration)</div>
      <div style="display: flex; align-items: center; gap: 10px; min-width: 0; font-size: 12px; color: #cfe8ef; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; flex-wrap: wrap;">
        <span>运行模型: {{ leftBrainSummary.modelLabel }}</span>
        <span :style="{ color: leftBrainConfigSaved ? '#9de2b0' : '#ffb3a7' }">{{ leftBrainConfigSaved ? '已保存左脑配置' : '未保存左脑配置' }}</span>
        <span :style="{ color: leftSelectedModelLoaded ? '#9de2b0' : '#ffb3a7' }">{{ leftBrainSummary.statusLabel }}</span>
      </div>
    </div>
    <div style="display: flex; gap: 8px;">
      <button class="action-btn outline" :disabled="preflightBusy || memoryConfigBusy || configSaving" @click.stop="runLeftBrainPreflight" style="padding: 2px 10px; font-size: 12px;">
        {{ preflightBusy ? '自检中...' : '🔎 自检' }}
      </button>
      <button class="action-btn" :disabled="runtimeBusy || memoryConfigBusy || configSaving" @click.stop="toggleHermesRuntime('left')" style="padding: 2px 10px; font-size: 12px;">
        {{ runtimeBusy ? '处理中...' : (leftBrainRunning ? '🔴 停止左脑' : '🚀 启动左脑') }}
      </button>
    </div>
  </summary>
  <div class="panel-content" style="padding: 0;">
    <div class="dual-brain-container" style="display: flex; flex-wrap: wrap; gap: 16px; width: 100%; padding: 12px;">
      
      <!-- Left Brain Content -->
      <div style="flex: 1; min-width: 300px; border: 1px solid #444; border-radius: 6px; padding: 12px; background: rgba(0,0,0,0.1);">
        <h3 style="margin-top: 0; margin-bottom: 12px; color: #cfe8ef; font-size: 14px;">左脑 (Left Brain)</h3>
        
      <div style="display: flex; flex-wrap: wrap; gap: 16px; align-items: center; padding: 12px; background: rgba(0,0,0,0.2); border-radius: 6px;">
        <div style="flex: 1; min-width: 140px; display: flex; flex-direction: column; gap: 4px;">
          <label>推理平台</label>
          <select v-model="leftBrain.provider" @change="handleProviderChange('left')">
            <option value="omlx">OMLX (Local)</option>
            <option value="ollama">Ollama</option>
          </select>
        </div>
        <div style="flex: 1; min-width: 140px; display: flex; flex-direction: column; gap: 4px;">
          <label>服务地址</label>
          <input type="text" v-model="leftBrain.baseUrl" />
        </div>
      </div>
      <div style="display: flex; flex-direction: column; gap: 4px; margin-top: 12px; padding: 12px; background: rgba(0,0,0,0.2); border-radius: 6px;">
        <label>运行模型</label>
        <div style="display: flex; flex-wrap: wrap; gap: 8px;">
          <select v-model="leftBrain.model" @change="handleModelChange('left')" style="flex: 1; min-width: 160px;">
            <option value="">请选择模型</option>
            <option v-for="mod in availableLeftModels" :key="mod.id" :value="mod.id">{{ mod.id }}</option>
          </select>
          <div style="display: flex; gap: 8px;">
            <button @click="fetchLocalModels('left')" :disabled="fetchingLeft">{{ fetchingLeft ? '...' : '刷新' }}</button>
            <button
              @click="actOnModel('left', 'load')"
              :disabled="!leftBrain.model || fetchingLeft || inspectingLeft || leftSelectedModelLoaded"
              :style="{
                border: '1px solid #4caf50',
                background: 'transparent',
                color: !leftBrain.model || fetchingLeft || inspectingLeft || leftSelectedModelLoaded ? '#5d7e63' : '#4caf50',
                opacity: !leftBrain.model || fetchingLeft || inspectingLeft || leftSelectedModelLoaded ? '0.45' : '1',
                cursor: !leftBrain.model || fetchingLeft || inspectingLeft || leftSelectedModelLoaded ? 'not-allowed' : 'pointer'
              }"
            >➕加载</button>
            <button
              @click="actOnModel('left', 'unload')"
              :disabled="!leftBrain.model || fetchingLeft || inspectingLeft || !leftSelectedModelLoaded"
              :style="{
                border: '1px solid #f44336',
                background: 'transparent',
                color: !leftBrain.model || fetchingLeft || inspectingLeft || !leftSelectedModelLoaded ? '#8d6767' : '#f44336',
                opacity: !leftBrain.model || fetchingLeft || inspectingLeft || !leftSelectedModelLoaded ? '0.45' : '1',
                cursor: !leftBrain.model || fetchingLeft || inspectingLeft || !leftSelectedModelLoaded ? 'not-allowed' : 'pointer'
              }"
            >➖卸载</button>
          </div>
        </div>
      </div>
      <div v-if="leftInspection" style="margin-top: 12px; font-size: 12px; color: #aaa;">
         状态: <span :style="{color: leftInspection.accessible ? '#7CFC9A' : '#FF8A80'}">{{ leftInspection.accessible ? '就绪' : '异常' }}</span>
         | 窗口: {{ leftInspection.contextLength || '-' }}
         | 探测Tokens: {{ leftInspection.usage?.totalTokens || '-' }}
      </div>
      <div v-if="leftBrainBlockedReason && !leftBrainRunning" style="margin-top: 12px; font-size: 12px; color: #ffb3a7;">{{ leftBrainBlockedReason }}</div>

      <template v-if="memoryConfig && skillConfig">
      <div style="display: flex; flex-direction: column; gap: 4px; margin-top: 12px; padding: 12px; background: rgba(0,0,0,0.2); border-radius: 6px;">
        <label>短期记忆最小窗口 Token</label>
        <input type="number" min="65536" step="1024" v-model="shortTermMinContextTokens" />
        <div style="font-size: 12px; line-height: 1.5; color: #aebdca;">
          {{ shortTermMemoryHint }}
        </div>
      </div>

      <div style="display: flex; flex-direction: column; gap: 8px; margin-top: 12px; padding: 12px; background: rgba(0,0,0,0.2); border-radius: 6px;">
        <div style="font-size: 13px; color: #ddd; font-weight: 600;">长期记忆文件</div>
        <label>Agent 定义文件</label>
        <input type="text" v-model="memoryConfig.agentDefinitionFile" />
        <label>用户记忆文件</label>
        <input type="text" v-model="memoryConfig.userFile" />
        <label>项目记忆文件</label>
        <input type="text" v-model="memoryConfig.memoryFile" />
        <label>状态文件</label>
        <input type="text" v-model="memoryConfig.statusFile" />
        <label>任务队列文件</label>
        <input type="text" v-model="memoryConfig.taskQueueFile" />
        <label>决策文件</label>
        <input type="text" v-model="memoryConfig.decisionsFile" />
        <label>日志目录</label>
        <input type="text" v-model="memoryConfig.dailyLogDir" />
      </div>

      <div style="display: flex; flex-direction: column; gap: 8px; margin-top: 12px; padding: 12px; background: rgba(0,0,0,0.2); border-radius: 6px;">
        <div style="font-size: 13px; color: #ddd; font-weight: 600;">技能库配置</div>
        <label>技能根目录</label>
        <input type="text" v-model="skillConfig.skillRoot" />
        <label>技能文件清单（每行一个 SKILL.md）</label>
        <textarea v-model="skillFilesText" style="min-height: 96px; resize: vertical;"></textarea>
        <div style="font-size: 12px; color: #888;">当前可用技能文件：{{ skillConfig?.skillCount ?? 0 }}</div>
      </div>

      <div style="display: flex; flex-wrap: wrap; align-items: center; gap: 12px; margin-top: 12px;">
        <button class="action-btn" @click="saveLeftBrainConfig" :disabled="configSaving || memoryConfigBusy">
          {{ saveLeftBrainLabel }}
        </button>
        <button class="action-btn outline" @click="loadEngineConfig" :disabled="memoryConfigBusy || configSaving">{{ memoryConfigBusy ? '读取中...' : '刷新配置' }}</button>
        <span v-if="configSaveMessage" style="font-size: 12px; color: #7CFC9A;">{{ configSaveMessage }}</span>
      </div>
      </template>
      <div v-else style="margin-top: 12px; font-size: 12px; color: #888;">左脑启动配置读取中。</div>
      <div v-if="memoryConfigError" class="text-error" style="margin-top: 8px;">{{ memoryConfigError }}</div>
      <div v-if="configSaveError" class="text-error" style="margin-top: 8px;">{{ configSaveError }}</div>
      </div>

      <!-- Right Brain Content -->
      <div style="flex: 1; min-width: 300px; border: 1px solid #444; border-radius: 6px; padding: 12px; background: rgba(255,200,0,0.05); opacity: 0.6;">
        <h3 style="margin-top: 0; margin-bottom: 12px; color: #f5d76e; font-size: 14px;">右脑 (Right Brain) <span style="font-size: 12px; color: #aaa; margin-left: 8px;">[未开放]</span></h3>
        <div style="display: flex; flex-wrap: wrap; gap: 16px; align-items: center; padding: 12px; background: rgba(0,0,0,0.2); border-radius: 6px;">
          <div style="flex: 1; min-width: 140px; display: flex; flex-direction: column; gap: 4px;">
            <label>推理平台</label>
            <select v-model="rightBrain.provider" disabled>
              <option value="omlx">OMLX (Local)</option>
              <option value="ollama">Ollama</option>
            </select>
          </div>
          <div style="flex: 1; min-width: 140px; display: flex; flex-direction: column; gap: 4px;">
            <label>服务地址</label>
            <input type="text" v-model="rightBrain.baseUrl" disabled />
          </div>
        </div>
        <div style="display: flex; flex-direction: column; gap: 4px; margin-top: 12px; padding: 12px; background: rgba(0,0,0,0.2); border-radius: 6px;">
          <label>运行模型</label>
          <div style="display: flex; gap: 8px;">
            <select v-model="rightBrain.model" style="flex: 1;" disabled>
              <option v-for="mod in availableRightModels" :key="mod.id" :value="mod.id">{{ mod.id }}</option>
            </select>
            <button disabled>未开放</button>
          </div>
        </div>
        <div style="margin-top: 12px; font-size: 12px; color: #bbb;">右脑当前保持置灰，只作为后续扩展占位，不参与 HermesManager 启动。</div>
        <div v-if="rightInspection" style="margin-top: 12px; font-size: 12px; color: #aaa;">
           状态: <span :style="{color: rightInspection.accessible ? '#7CFC9A' : '#FF8A80'}">{{ rightInspection.accessible ? '就绪' : '异常' }}</span>
           | 窗口: {{ rightInspection.contextLength || '-' }}
           | 探测Tokens: {{ rightInspection.usage?.totalTokens || '-' }}
        </div>
      </div>
    
    </div>
  </div>
</details>

<details class="panel" open style="margin-bottom: 24px;">
  <summary class="panel-header" style="display: flex; align-items: center; justify-content: space-between;">
    <div class="panel-title">💬 Hermes 直连对话 (Chat & Token Monitor)</div>
  </summary>
  <div class="panel-content chat-panel-shell">
    <div v-if="chatUiStatus.kind !== 'idle'" class="message-banner" :class="chatUiStatus.kind === 'error' ? 'error' : 'tip'" style="margin-bottom: 12px; font-size: 12px; line-height: 1.5;">
      <div>
        <strong>
          {{ chatUiStatus.kind === 'pending' ? '聊天请求进行中' : chatUiStatus.kind === 'busy' ? '聊天请求排队保护' : chatUiStatus.kind === 'recovering' ? '聊天超时自动恢复' : chatUiStatus.kind === 'timeout' ? '聊天等待超时，后台继续处理' : '聊天请求异常' }}
        </strong>
      </div>
      <div style="margin-top: 4px; color: #c9d4de;">{{ chatUiStatus.message }}</div>
      <div v-if="chatUiStatus.activeRequest" style="margin-top: 4px; color: #aebdca;">
        活动请求: 已运行 {{ chatActiveRequestElapsedSeconds }} 秒 · 提示长度 {{ chatUiStatus.activeRequest.promptChars }} 字符
      </div>
      <div v-if="chatUiStatus.activeRequest?.outboundRequest" style="margin-top: 4px; color: #aebdca;">
        已发送给 OMLX: 共 {{ chatUiStatus.activeRequest.outboundRequest.totalMessages }} 条消息，其中 system {{ chatUiStatus.activeRequest.outboundRequest.systemMessageCount }} 条，历史重放 {{ chatUiStatus.activeRequest.outboundRequest.replayedMessageCount }} 条，user {{ chatUiStatus.activeRequest.outboundRequest.userMessageCount }} 条
      </div>
      <div v-if="chatUiStatus.recovery?.attempted && chatUiStatus.recovery.durationMs != null" style="margin-top: 4px; color: #aebdca;">
        自动恢复耗时 {{ Math.round(chatUiStatus.recovery.durationMs / 1000) }} 秒 · {{ chatUiStatus.recovery.ok ? '恢复完成，可重新发送' : '恢复失败，请检查运行时日志' }}
      </div>
    </div>
    <div ref="chatScrollContainer" class="chat-thread-resizable">
      <div class="chat-thread">
        <div v-if="chatHistory.length === 0" class="chat-empty-state">
          <div class="chat-empty-title">Hermes 对话已就绪</div>
          <div class="chat-empty-copy">输入消息后使用 Cmd/Ctrl + Enter 发送，Enter 可直接换行。单次最长等待 {{ chatRuntimeTimeoutSeconds || 500 }} 秒。</div>
        </div>
        <div v-for="(msg, i) in chatHistory" :key="i" class="chat-row" :data-role="msg.role">
          <div class="chat-bubble" :data-role="msg.role">
            <div class="chat-role">{{ msg.role.toUpperCase() }}</div>
            <div class="chat-message-text" v-html="renderChatMessage(msg.content)"></div>
            <div v-if="msg.tokens" class="chat-token-usage">
              Token 消耗: 提示词 {{ msg.tokens.prompt_tokens }} | 输出 {{ msg.tokens.completion_tokens }} | 总计 {{ msg.tokens.total_tokens }}
            </div>
          </div>
        </div>
      </div>
    </div>
    <div class="chat-composer">
      <textarea
        v-model="sandboxPrompt"
        class="chat-composer-input"
        rows="3"
        @keydown="handleChatComposerKeydown"
        placeholder="直接发送指令给 Hermes..."
      />
      <div class="chat-composer-footer">
        <div class="chat-composer-hint">Enter 换行，Cmd/Ctrl + Enter 发送，最长等待 {{ chatRuntimeTimeoutSeconds || 500 }} 秒</div>
        <div class="chat-composer-actions">
          <label class="reasoning-auto-approve-toggle">
            <input v-model="reasoningAutoApproveEnabled" type="checkbox" />
            <span>可观测执行自动通过审核</span>
          </label>
          <button class="action-btn outline" @click="sendObservableReasoningChat" :disabled="sandboxBusy || reasoningBusy || !sandboxPrompt.trim()">{{ reasoningBusy ? '推理中...' : '可观测执行' }}</button>
          <button class="action-btn" @click="sendChat" :disabled="sandboxBusy || reasoningBusy || !sandboxPrompt.trim()">{{ sandboxBusy ? '发送中...' : '发送' }}</button>
        </div>
      </div>
    </div>
    <div v-if="submitGateOpen" class="chat-context-panel submit-gate-panel">
      <div class="chat-context-summary-line">
        <strong>提交前确认</strong>
        <span>{{ submitGateMode === 'reasoning' ? '可观测执行' : '直接发送' }}</span>
        <span>可先预览 Control 提交包、Hermes 当前运行时路由和命中的 skill/action hints，再决定是否发送</span>
      </div>
      <div class="submit-gate-block">
        <div class="chat-memory-title">本次问题</div>
        <textarea v-model="submitPromptDraft" class="chat-memory-editor" rows="3" spellcheck="false" />
      </div>
      <div class="submit-gate-grid">
        <div class="submit-gate-block">
          <div class="chat-memory-title">手工附加上下文源</div>
          <div v-if="contextCandidatesBusy" class="chat-memory-desc">读取中...</div>
          <div v-else class="submit-source-list">
            <label v-for="source in contextSourceCandidates" :key="source.sourceId" class="submit-source-item">
              <div class="submit-source-item-header">
                <label class="submit-source-checkbox-line">
                  <input v-model="submitSelectedSourceIds" type="checkbox" :value="source.sourceId" :disabled="!source.exists" />
                  <span>{{ source.label }}</span>
                </label>
                <button class="action-btn outline submit-source-open-btn" type="button" @click.stop="loadContextSourceFile(source.sourceId)" :disabled="sourceEditorBusy">{{ selectedContextSourceId === source.sourceId ? '已打开' : '查看/编辑' }}</button>
              </div>
              <span class="chat-context-source-meta">{{ source.exists ? `载入 ${source.loadedChars} / ${source.totalChars} 字符` : '当前文件缺失' }}</span>
            </label>
            <div v-if="contextSourceCandidates.length === 0" class="chat-memory-desc">当前没有需要手工附加的原始上下文源；Hermes 启动后会自行读取默认 memory 文件。</div>
          </div>
        </div>
        <div class="submit-gate-block">
          <div class="chat-memory-title">已确认上下文池</div>
          <div v-if="contextCandidatesBusy" class="chat-memory-desc">读取中...</div>
          <div v-else class="submit-source-list">
            <label v-for="entry in contextPoolEntries" :key="entry.entryId" class="submit-source-item">
              <input v-model="submitSelectedContextPoolIds" type="checkbox" :value="entry.entryId" />
              <span>{{ entry.title }}</span>
              <span class="chat-memory-desc">{{ entry.updatedAt }}</span>
            </label>
            <div v-if="contextPoolEntries.length === 0" class="chat-memory-desc">当前还没有已确认的上下文池记录。</div>
          </div>
        </div>
      </div>
      <div class="submit-gate-block" style="margin-top: 12px;">
        <div class="chat-memory-title">原始上下文文件编辑器</div>
        <div v-if="sourceEditorError" class="message-banner error" style="font-size: 12px;">{{ sourceEditorError }}</div>
        <div v-if="selectedContextSource && sourceEditorFile" class="chat-memory-desc">
          当前已选择 {{ selectedContextSource.label }}。点击上方“查看/编辑”会用弹窗打开编辑器，快捷键将锁定在编辑器内。
        </div>
        <div v-else class="chat-memory-desc">如有手工附加源，点击上方“查看/编辑”即可在弹窗中在线打开文件。</div>
      </div>
      <div class="reasoning-review-actions" style="margin-top: 12px;">
        <button class="action-btn outline" @click="generateSubmitContextDraft" :disabled="submitDraftBusy || contextCandidatesBusy || !submitPromptDraft.trim()">{{ submitDraftBusy ? '预览中...' : '查看发送预览' }}</button>
        <button class="action-btn outline" @click="closeSubmitGate" :disabled="submitDraftBusy || contextPoolSaveBusy">取消</button>
        <button class="action-btn" @click="confirmSubmitGate" :disabled="submitDraftBusy || contextPoolSaveBusy || !submitPromptDraft.trim()">确认发送</button>
      </div>
      <div v-if="contextCandidatesError || submitDraftError" class="message-banner error" style="margin-top: 8px; font-size: 12px;">
        {{ contextCandidatesError || submitDraftError }}
      </div>
      <div v-if="submitDraftResult" class="reasoning-review-box" style="margin-top: 12px;">
        <div class="reasoning-plan-title">提交流程预览</div>
        <div v-if="submitDraftResult.summary" class="chat-memory-desc" style="margin-bottom: 10px; white-space: pre-wrap;">{{ submitDraftResult.summary }}</div>
        <div v-if="getPreviewControllerRequest(submitDraftResult.outboundPreview) || getPreviewRuntimeRoute(submitDraftResult.outboundPreview) || getPreviewPlannerHints(submitDraftResult.outboundPreview)" class="transport-preview-grid">
          <div v-if="getPreviewControllerRequest(submitDraftResult.outboundPreview)" class="transport-preview-card controller">
            <div class="transport-preview-card-title">Control 提交给 Hermes</div>
            <div class="transport-preview-meta">目标 {{ getPreviewControllerRequest(submitDraftResult.outboundPreview)?.target }}</div>
            <div class="transport-preview-meta">调度模型 hermes-agent · 共 {{ getPreviewControllerRequest(submitDraftResult.outboundPreview)?.totalMessages }} 条消息 · system {{ getPreviewControllerRequest(submitDraftResult.outboundPreview)?.systemMessageCount }} · 历史重放 {{ getPreviewControllerRequest(submitDraftResult.outboundPreview)?.replayedMessageCount }} · user {{ getPreviewControllerRequest(submitDraftResult.outboundPreview)?.userMessageCount }}</div>
            <pre class="reasoning-evidence-pre transport-preview-pre">{{ formatReasoningEvidence(getPreviewControllerRequest(submitDraftResult.outboundPreview)?.messages || []) }}</pre>
          </div>
          <div v-if="getPreviewRuntimeRoute(submitDraftResult.outboundPreview)" class="transport-preview-card route">
            <div class="transport-preview-card-title">Hermes 当前运行时路由</div>
            <div class="transport-preview-meta">运行时 {{ getPreviewRuntimeRoute(submitDraftResult.outboundPreview)?.provider }} / {{ getPreviewRuntimeRoute(submitDraftResult.outboundPreview)?.model }}</div>
            <div class="transport-preview-meta">Base URL {{ getPreviewRuntimeRoute(submitDraftResult.outboundPreview)?.baseUrl }}</div>
            <div class="chat-memory-desc" style="white-space: pre-wrap;">{{ getPreviewRuntimeRoute(submitDraftResult.outboundPreview)?.note }}</div>
          </div>
          <div v-if="getPreviewPlannerHints(submitDraftResult.outboundPreview)" class="transport-preview-card hints">
            <div class="transport-preview-card-title">命中的 skill / action hints</div>
            <div v-if="getPreviewPlannerHints(submitDraftResult.outboundPreview)?.suggestedActions?.length" class="transport-preview-meta">建议动作 {{ getPreviewPlannerHints(submitDraftResult.outboundPreview)?.suggestedActions?.join(', ') }}</div>
            <div v-if="getPreviewPlannerHints(submitDraftResult.outboundPreview)?.selectedSkills?.length" class="chat-context-sources-list" style="margin-top: 8px;">
              <div v-for="skill in getPreviewPlannerHints(submitDraftResult.outboundPreview)?.selectedSkills || []" :key="skill.filePath" class="chat-context-source-line">
                <strong class="chat-context-source-label">{{ skill.name }}</strong>
                <span class="chat-context-source-ok">{{ skill.hintCount }} 条 hint</span>
                <span>{{ skill.filePath }}</span>
              </div>
            </div>
            <div v-if="getPreviewPlannerHints(submitDraftResult.outboundPreview)?.matchedRules?.length" class="chat-context-sources-list" style="margin-top: 8px;">
              <div v-for="rule in getPreviewPlannerHints(submitDraftResult.outboundPreview)?.matchedRules || []" :key="rule.key" class="chat-context-source-line transport-hint-line">
                <strong class="chat-context-source-label">{{ rule.source === 'skill' ? 'Skill Hint' : 'Built-in Rule' }}</strong>
                <span class="chat-context-source-ok">{{ [...rule.requiredActions, rule.answerAction].filter(Boolean).join(', ') }}</span>
                <span>{{ rule.goal }}</span>
              </div>
            </div>
          </div>
        </div>
        <div v-else-if="submitDraftResult.outboundPreview" class="reasoning-evidence-block">
          <div class="reasoning-evidence-title">提交预览</div>
          <pre class="reasoning-evidence-pre">{{ formatReasoningEvidence(submitDraftResult.outboundPreview) }}</pre>
        </div>
      </div>
    </div>
    <div v-if="chatContextInfo" class="chat-context-panel">
      <div class="chat-context-summary-line">
        <strong>本次上下文</strong>
        <span>已加载 {{ chatContextInfo.loadedSourceCount }}/{{ chatContextInfo.selectedSourceCount }}</span>
        <span v-if="chatContextInfo.contextPoolEntryCount">上下文池 {{ chatContextInfo.contextPoolEntryCount }} 条</span>
        <span>重放历史 {{ chatContextInfo.replayedMessageCount }} 条</span>
        <span>运行时 {{ chatContextInfo.runtime.provider }} / {{ chatContextInfo.runtime.model }}</span>
        <span>超时 {{ Math.round(chatContextInfo.runtime.timeoutMs / 1000) }} 秒</span>
        <span v-if="chatUiStatus.kind === 'pending' && chatUiStatus.activeRequest">本次请求已运行 {{ chatActiveRequestElapsedSeconds }} 秒</span>
      </div>
      <div v-if="chatContextInfo.confirmedContextSummary" class="reasoning-review-summary" style="margin-bottom: 10px; white-space: pre-wrap;">{{ chatContextInfo.confirmedContextSummary }}</div>
      <div class="chat-context-sources-list">
        <div v-for="source in chatContextInfo.sources" :key="source.label + source.filePath" class="chat-context-source-line">
          <strong class="chat-context-source-label">{{ source.label }}</strong>
          <span :class="source.exists ? 'chat-context-source-ok' : 'chat-context-source-missing'">{{ source.exists ? '已加载' : '缺失' }}</span>
          <span v-if="source.exists" class="chat-context-source-meta">载入 {{ source.loadedChars }} / {{ source.totalChars }} 字符<span v-if="source.truncated"> · 已截断</span></span>
        </div>
      </div>
      <div v-if="chatContextInfo.contextPoolEntries?.length" class="chat-context-sources-list" style="margin-top: 8px;">
        <div v-for="entry in chatContextInfo.contextPoolEntries" :key="entry.entryId" class="chat-context-source-line">
          <strong class="chat-context-source-label">确认上下文</strong>
          <span class="chat-context-source-ok">已注入</span>
          <span>{{ entry.title }}</span>
        </div>
      </div>
    </div>
    <details v-if="reasoningCapabilities || reasoningCapabilitiesBusy || reasoningCapabilitiesError" class="chat-context-panel capability-panel" open>
      <summary class="chat-context-summary-line capability-summary">
        <strong>Plan 能力注册表</strong>
        <span v-if="reasoningCapabilities">action {{ reasoningCapabilities.actions.length }}</span>
        <span v-if="reasoningCapabilities">skill {{ reasoningCapabilities.skills.length }}</span>
        <span v-if="reasoningCapabilities?.guide?.exists">附带扩展示例</span>
      </summary>
      <div v-if="reasoningCapabilitiesError" class="message-banner error" style="margin-top: 8px; font-size: 12px;">{{ reasoningCapabilitiesError }}</div>
      <div v-else-if="reasoningCapabilitiesBusy" class="chat-memory-desc" style="margin-top: 8px;">读取中...</div>
      <template v-else-if="reasoningCapabilities">
        <div class="capability-section">
          <div class="chat-memory-title">已注册 action</div>
          <div class="chat-context-sources-list">
            <div v-for="action in reasoningCapabilities.actions" :key="action.action" class="chat-context-source-line capability-action-line">
              <strong class="chat-context-source-label">{{ action.action }}</strong>
              <span class="chat-context-source-ok">{{ action.tool }}</span>
              <span>{{ action.description }}</span>
            </div>
          </div>
        </div>
        <div class="capability-section" v-if="reasoningCapabilities.skills.length">
          <div class="chat-memory-title">当前 skill 与 hints</div>
          <div class="chat-context-sources-list">
            <div v-for="skill in reasoningCapabilities.skills" :key="skill.filePath" class="chat-context-source-line capability-skill-line">
              <strong class="chat-context-source-label">{{ skill.name }}</strong>
              <span class="chat-context-source-ok">{{ skill.hintCount }} 条 hint</span>
              <span>{{ skill.filePath }}</span>
            </div>
          </div>
          <div v-for="skill in reasoningCapabilities.skills" :key="`${skill.filePath}-hints`" class="capability-hint-group">
            <div class="chat-memory-desc">{{ skill.name }}</div>
            <div v-for="hint in skill.actionHints" :key="hint.hintId" class="reasoning-event-meta-chip capability-hint-chip">{{ formatActionHintLine(hint) }}</div>
          </div>
        </div>
        <div class="capability-section" v-if="reasoningCapabilities.guide?.exists">
          <div class="chat-memory-title">扩展示例</div>
          <div class="chat-memory-desc" style="margin-bottom: 8px;">{{ reasoningCapabilities.guide.filePath }}</div>
          <pre class="reasoning-evidence-pre transport-preview-pre capability-guide-pre">{{ reasoningCapabilities.guide.content }}</pre>
        </div>
      </template>
    </details>
    <div class="chat-memory-panel">
      <div class="chat-memory-header-row">
        <div>
          <div class="chat-memory-title">上下文池</div>
          <div class="chat-memory-desc">这里只保存人工确认后的上下文理解；未确认内容不会落盘，也不会复用。</div>
        </div>
        <div class="chat-memory-actions">
          <button class="action-btn outline" @click="loadContextCandidates" :disabled="contextCandidatesBusy || contextPoolEditorBusy">{{ contextCandidatesBusy ? '刷新中...' : '刷新列表' }}</button>
        </div>
      </div>
      <div class="chat-memory-meta">
        <span>记录数 {{ contextPoolEntries.length }}</span>
      </div>
      <div class="submit-gate-grid" style="margin-top: 10px;">
        <div class="submit-gate-block">
          <div class="chat-memory-title">已保存记录</div>
          <div class="submit-source-list">
            <div
              v-for="entry in contextPoolEntries"
              :key="entry.entryId"
              class="context-pool-list-row"
            >
              <button
                class="action-btn outline context-pool-list-btn"
                @click="selectedContextPoolEntryId = entry.entryId; loadContextPoolEntry(entry.entryId)"
              >{{ entry.title }}</button>
              <button class="action-btn outline mini-danger-btn" @click.stop="deleteContextPoolEntry(entry.entryId)" :disabled="contextPoolDeleteBusy || contextPoolEditorBusy">{{ contextPoolDeleteBusy ? '删除中...' : '删除' }}</button>
            </div>
            <div v-if="contextPoolEntries.length === 0" class="chat-memory-desc">还没有上下文池文件。</div>
          </div>
        </div>
        <div class="submit-gate-block">
          <div class="chat-memory-title">记录内容</div>
          <div v-if="contextPoolEditorError" class="message-banner error" style="margin-bottom: 8px; font-size: 12px;">{{ contextPoolEditorError }}</div>
          <div v-if="selectedContextPoolEntry && contextPoolFile" class="chat-memory-desc">
            当前已选择 {{ selectedContextPoolEntry.title }}。点击左侧记录会用弹窗打开 JSON 编辑器，`Ctrl/Cmd+S` 会保存到文件。
          </div>
          <div v-else class="chat-memory-desc">选择左侧记录后会在弹窗中查看和编辑。</div>
        </div>
      </div>
    </div>
    <div v-if="editorModalOpen" class="editor-modal-backdrop" @click.self="closeEditorModal">
      <div class="editor-modal-shell" tabindex="-1" role="dialog" aria-modal="true" :aria-label="editorModalTitle">
        <div class="editor-modal-header">
          <div>
            <div class="chat-memory-title">{{ editorModalTitle }}</div>
            <div class="chat-memory-desc">{{ activeEditorFilePath }}</div>
          </div>
          <div class="editor-modal-actions">
            <button v-if="editorModalKind === 'context-pool'" class="action-btn outline" @click="openContextPoolEntryInEditor" :disabled="contextPoolEditorBusy">{{ contextPoolEditorBusy ? '处理中...' : '在编辑器打开' }}</button>
            <button class="action-btn outline" @click="closeEditorModal">关闭</button>
          </div>
        </div>
        <div v-if="editorModalKind === 'source' && selectedContextSource && sourceEditorFile" class="context-file-editor-shell">
          <div class="chat-memory-meta">
            <span>{{ selectedContextSource.label }}</span>
            <span>字符数 {{ sourceEditorFile.sizeChars }}</span>
            <span>更新时间 {{ sourceEditorFile.updatedAt || '未写入' }}</span>
            <span>快捷键已锁定：Tab / Ctrl+S / Ctrl+W</span>
          </div>
          <Codemirror v-model="sourceEditorContent" class="context-file-codemirror" :extensions="sourceEditorExtensions" :style="{ height: '60vh' }" />
          <div class="reasoning-review-actions" style="margin-top: 8px;">
            <button class="action-btn" @click="saveContextSourceFile" :disabled="sourceEditorSaveBusy || !sourceEditorDirty">{{ sourceEditorSaveBusy ? '保存中...' : '保存源文件' }}</button>
          </div>
          <div v-if="sourceEditorSaveMessage" class="chat-memory-desc">{{ sourceEditorSaveMessage }}</div>
        </div>
        <div v-else-if="editorModalKind === 'context-pool' && selectedContextPoolEntry && contextPoolFile" class="context-file-editor-shell">
          <div class="chat-memory-meta">
            <span>{{ selectedContextPoolEntry.title }}</span>
            <span>字符数 {{ contextPoolFile.sizeChars }}</span>
            <span>更新时间 {{ contextPoolFile.updatedAt || '未写入' }}</span>
            <span>快捷键已锁定：Tab / Ctrl+S / Ctrl+W</span>
          </div>
          <Codemirror v-model="contextPoolFileContent" class="context-file-codemirror" :extensions="contextPoolEditorExtensions" :style="{ height: '60vh' }" />
          <div class="reasoning-review-actions" style="margin-top: 8px;">
            <button class="action-btn" @click="saveContextPoolEntryEdits" :disabled="contextPoolEditorBusy || !contextPoolFileDirty">{{ contextPoolEditorBusy ? '保存中...' : '保存修改' }}</button>
            <button class="action-btn outline mini-danger-btn" @click="deleteContextPoolEntry(selectedContextPoolEntry.entryId)" :disabled="contextPoolDeleteBusy || contextPoolEditorBusy">{{ contextPoolDeleteBusy ? '删除中...' : '删除记录' }}</button>
          </div>
          <div v-if="contextPoolFileSaveMessage" class="chat-memory-desc">{{ contextPoolFileSaveMessage }}</div>
        </div>
      </div>
    </div>
    <div v-if="activeReasoningSession || reasoningError" class="reasoning-panel">
      <div class="reasoning-panel-header">
        <div>
          <div class="chat-memory-title">可观测推理链</div>
          <div class="reasoning-subtitle">状态 {{ reasoningStatusLabel }}<span v-if="activeReasoningSession"> · Session {{ activeReasoningSession.sessionId }} · 总计时 {{ formatDurationSeconds(reasoningElapsedSeconds) }}</span></div>
        </div>
        <label class="reasoning-auto-approve-toggle panel">
          <input v-model="reasoningAutoApproveEnabled" type="checkbox" />
          <span>{{ reasoningAutoApproveEnabled ? '自动审核已开启' : '人工审核模式' }}</span>
        </label>
      </div>
      <div v-if="activeReasoningSession?.plan" class="reasoning-plan-box">
        <div class="reasoning-plan-title">PLAN</div>
        <div class="reasoning-plan-goal">{{ activeReasoningSession.plan.goal }}</div>
        <div class="reasoning-plan-steps">
          <div v-for="step in activeReasoningSession.plan.steps" :key="step.stepId" class="reasoning-plan-step" :class="{ active: activeReasoningSession.currentStepId === step.stepId, review: activeReasoningSession.review?.stepId === step.stepId }">
            <strong>{{ step.title }}</strong>
            <span class="reasoning-plan-step-chip">{{ step.action }}</span>
            <span class="reasoning-plan-step-chip">{{ step.tool }}</span>
          </div>
        </div>
      </div>
      <div v-if="reasoningPendingReview" class="reasoning-review-box">
        <div class="reasoning-plan-title">{{ reasoningReviewTargetLabel }}</div>
        <div class="reasoning-review-title">{{ reasoningPendingReview.title }}</div>
        <div class="reasoning-review-summary">{{ reasoningPendingReview.summary }}</div>
        <div v-if="reasoningAutoApproveEnabled" class="chat-memory-desc" style="margin-bottom: 10px;">当前已开启自动审核，检测到待审核步骤后会自动通过并继续执行。</div>
        <div v-if="reasoningReviewEvidence?.outboundPreview" class="reasoning-evidence-block">
          <div class="reasoning-evidence-title">本轮提交流程</div>
          <div v-if="getPreviewControllerRequest(reasoningReviewEvidence.outboundPreview) || getPreviewRuntimeRoute(reasoningReviewEvidence.outboundPreview) || getPreviewPlannerHints(reasoningReviewEvidence.outboundPreview)" class="transport-preview-grid review">
            <div v-if="getPreviewControllerRequest(reasoningReviewEvidence.outboundPreview)" class="transport-preview-card controller">
              <div class="transport-preview-card-title">Control 提交给 Hermes</div>
              <div class="transport-preview-meta">目标 {{ getPreviewControllerRequest(reasoningReviewEvidence.outboundPreview)?.target }}</div>
              <div class="transport-preview-meta">调度模型 hermes-agent · 共 {{ getPreviewControllerRequest(reasoningReviewEvidence.outboundPreview)?.totalMessages }} 条消息 · system {{ getPreviewControllerRequest(reasoningReviewEvidence.outboundPreview)?.systemMessageCount }} · 历史重放 {{ getPreviewControllerRequest(reasoningReviewEvidence.outboundPreview)?.replayedMessageCount }} · user {{ getPreviewControllerRequest(reasoningReviewEvidence.outboundPreview)?.userMessageCount }}</div>
              <pre class="reasoning-evidence-pre transport-preview-pre">{{ formatReasoningEvidence(getPreviewControllerRequest(reasoningReviewEvidence.outboundPreview)?.messages || []) }}</pre>
            </div>
            <div v-if="getPreviewRuntimeRoute(reasoningReviewEvidence.outboundPreview)" class="transport-preview-card route">
              <div class="transport-preview-card-title">Hermes 当前运行时路由</div>
              <div class="transport-preview-meta">运行时 {{ getPreviewRuntimeRoute(reasoningReviewEvidence.outboundPreview)?.provider }} / {{ getPreviewRuntimeRoute(reasoningReviewEvidence.outboundPreview)?.model }}</div>
              <div class="transport-preview-meta">Base URL {{ getPreviewRuntimeRoute(reasoningReviewEvidence.outboundPreview)?.baseUrl }}</div>
              <div class="chat-memory-desc" style="white-space: pre-wrap;">{{ getPreviewRuntimeRoute(reasoningReviewEvidence.outboundPreview)?.note }}</div>
            </div>
            <div v-if="getPreviewPlannerHints(reasoningReviewEvidence.outboundPreview)" class="transport-preview-card hints">
              <div class="transport-preview-card-title">命中的 skill / action hints</div>
              <div v-if="getPreviewPlannerHints(reasoningReviewEvidence.outboundPreview)?.suggestedActions?.length" class="transport-preview-meta">建议动作 {{ getPreviewPlannerHints(reasoningReviewEvidence.outboundPreview)?.suggestedActions?.join(', ') }}</div>
              <div v-if="getPreviewPlannerHints(reasoningReviewEvidence.outboundPreview)?.matchedRules?.length" class="chat-context-sources-list" style="margin-top: 8px;">
                <div v-for="rule in getPreviewPlannerHints(reasoningReviewEvidence.outboundPreview)?.matchedRules || []" :key="rule.key" class="chat-context-source-line transport-hint-line">
                  <strong class="chat-context-source-label">{{ rule.source === 'skill' ? 'Skill Hint' : 'Built-in Rule' }}</strong>
                  <span class="chat-context-source-ok">{{ [...rule.requiredActions, rule.answerAction].filter(Boolean).join(', ') }}</span>
                  <span>{{ rule.goal }}</span>
                </div>
              </div>
            </div>
          </div>
          <pre v-else class="reasoning-evidence-pre">{{ formatReasoningEvidence(reasoningReviewEvidence.outboundPreview) }}</pre>
        </div>
        <div v-if="reasoningReviewEvidence?.rawResponsePreview" class="reasoning-evidence-block">
          <div class="reasoning-evidence-title">模型首先返回的结果</div>
          <pre class="reasoning-evidence-pre">{{ reasoningReviewEvidence.rawResponsePreview }}</pre>
        </div>
        <div v-if="reasoningReviewEvidence?.structuredResult" class="reasoning-evidence-block">
          <div class="reasoning-evidence-title">结构化结果摘要</div>
          <pre class="reasoning-evidence-pre">{{ formatReasoningEvidence(reasoningReviewEvidence.structuredResult) }}</pre>
        </div>
        <textarea
          v-model="reasoningReviewDraft"
          class="chat-memory-editor reasoning-review-editor"
          rows="4"
          spellcheck="false"
          placeholder="驳回时填写修正条件，例如：必须调用 project.listStories，不要猜数据库。"
          :disabled="reasoningAutoApproveEnabled"
        />
        <div class="reasoning-review-actions">
          <button class="action-btn outline" @click="submitReasoningReview('reject')" :disabled="reasoningReviewBusy || reasoningAutoApproveEnabled">{{ reasoningReviewBusy ? '提交中...' : '驳回并重跑当前目标' }}</button>
          <button class="action-btn" @click="submitReasoningReview('approve')" :disabled="reasoningReviewBusy || reasoningAutoApproveEnabled">{{ reasoningReviewBusy ? '提交中...' : '通过并继续' }}</button>
        </div>
      </div>
      <div v-if="activeReasoningSession?.artifacts?.storyIndex?.length" class="reasoning-artifact-box">
        <div class="reasoning-plan-title">RESULT</div>
        <div v-for="story in activeReasoningSession.artifacts.storyIndex" :key="story.projectId + story.filePath" class="reasoning-artifact-item">
          <strong>{{ story.projectId }}</strong>
          <span>{{ story.nodeCount }} 个节点</span>
          <span class="reasoning-artifact-path">{{ story.filePath }}</span>
        </div>
      </div>
      <div v-if="activeReasoningSession?.events?.length" class="reasoning-timeline">
        <div v-for="event in activeReasoningSession.events" :key="event.eventId" class="reasoning-event-row">
          <div class="reasoning-event-type">{{ event.type }}</div>
          <div class="reasoning-event-body">
            <div class="reasoning-event-title">{{ event.title }}</div>
            <div class="reasoning-event-summary">{{ event.summary }}</div>
            <div v-if="getReasoningEventMetaLines(event).length" class="reasoning-event-meta-list">
              <span v-for="line in getReasoningEventMetaLines(event)" :key="`${event.eventId}-${line}`" class="reasoning-event-meta-chip">{{ line }}</span>
            </div>
            <div v-if="getReasoningEventOps(event).length" class="reasoning-event-ops">
              <div class="reasoning-event-ops-title">可观测调用</div>
              <div v-for="line in getReasoningEventOps(event)" :key="`${event.eventId}-${line}`" class="reasoning-event-op-line">{{ line }}</div>
            </div>
          </div>
          <div class="reasoning-event-time">{{ formatReasoningEventTime(event.timestamp) }}</div>
        </div>
      </div>
      <div v-if="activeReasoningSession?.error || reasoningError" class="message-banner error" style="font-size: 12px; line-height: 1.5;">
        {{ activeReasoningSession?.error || reasoningError }}
      </div>
    </div>
    <div class="chat-memory-panel">
      <div class="chat-memory-header-row">
        <div>
          <div class="chat-memory-title">聊天记录存档</div>
          <div class="chat-memory-desc">按日期持续写入的长期聊天记录，用于回看、整理和人工提取信息；它不等同于 Agent 记忆文件。</div>
        </div>
        <div class="chat-memory-actions">
          <button class="action-btn outline" @click="openChatHistoryFileInEditor" :disabled="chatMemoryOpenBusy || chatMemoryBusy || chatMemorySaveBusy">{{ chatMemoryOpenBusy ? '打开中...' : '在编辑器打开' }}</button>
          <button class="action-btn outline" @click="openChatMemoryEditor" :disabled="chatMemoryBusy || chatMemorySaveBusy || chatMemoryOpenBusy">{{ chatMemoryBusy ? '读取中...' : '内嵌查看' }}</button>
          <button class="action-btn outline" @click="loadChatHistory" :disabled="chatMemoryBusy || chatMemorySaveBusy || chatMemoryOpenBusy">刷新路径</button>
        </div>
      </div>
      <div v-if="chatMemoryFile" class="chat-memory-meta">
        <span :style="{ color: chatMemoryFile.exists ? '#9de2b0' : '#ffb3a7' }">{{ chatMemoryFile.exists ? '文件已存在' : '今日文件尚未生成，保存后会创建' }}</span>
        <span>字符数 {{ chatMemoryFile.sizeChars }}</span>
        <span>更新时间 {{ chatMemoryFile.updatedAt || '未写入' }}</span>
      </div>
      <div v-if="chatMemoryEditorOpen" class="chat-memory-editor-shell">
        <textarea
          v-model="chatMemoryDraft"
          class="chat-memory-editor"
          spellcheck="false"
          placeholder="这里显示 ai/chat 下当天聊天记录 JSON，可直接编辑后保存。"
        />
        <div class="chat-memory-editor-footer">
          <div class="chat-memory-editor-hint">服务端保存前会校验 JSON 数组结构，避免写坏聊天历史。</div>
          <div class="chat-memory-actions">
            <button class="action-btn outline" @click="loadChatMemoryFile" :disabled="chatMemoryBusy || chatMemorySaveBusy">{{ chatMemoryBusy ? '刷新中...' : '重新加载' }}</button>
            <button class="action-btn" @click="saveChatMemoryFile" :disabled="chatMemorySaveBusy || chatMemoryBusy || !chatMemoryDirty">{{ chatMemorySaveBusy ? '保存中...' : '保存文件' }}</button>
          </div>
        </div>
      </div>
      <div v-if="chatMemoryOpenMessage" class="message-banner tip" style="font-size: 12px; line-height: 1.5;">{{ chatMemoryOpenMessage }}</div>
      <div v-if="chatMemorySaveMessage" class="message-banner tip" style="font-size: 12px; line-height: 1.5;">{{ chatMemorySaveMessage }}</div>
      <div v-if="chatMemoryError" class="message-banner error" style="font-size: 12px; line-height: 1.5;">{{ chatMemoryError }}</div>
    </div>
  </div>
</details>
<details class="panel" open v-if="runtimeState?.state === 'running'" style="margin-bottom: 24px;">
  <summary class="panel-header" style="display: flex; align-items: center; justify-content: space-between;">
    <div class="panel-title">🩺 运行时自检诊断 (Runtime Diagnostics)</div>
    <span class="indicator" v-if="connecting">🔄 自检流转中...</span>
  </summary>
  <div class="panel-content">
    <p v-if="error" class="text-error">{{ error }}</p>
    <p v-else-if="!selfCheck && !connecting" class="text-muted">未能获取诊断快照，请重新启动引擎拉取。</p>
    <div v-else-if="selfCheck" class="diagnostics-grid">
      <div class="diagnostics-summary">
        <strong>诊断综合汇报:</strong> {{ selfCheck.summary }}
      </div>
      <div class="info-columns">
        <div class="info-block">
          <h3>💡 核心配置追踪 (Context Setup)</h3>
          <dl class="prop-list">
            <dt>驱动模型</dt><dd>{{ selfCheck.info.model }}</dd>
            <dt>接口路由</dt><dd>{{ selfCheck.info.provider }}</dd>
            <dt>服务地址</dt><dd class="code">{{ selfCheck.info.baseUrl }}</dd>
            <dt>上下文窗口</dt><dd>{{ selfCheck.info.contextLength ?? 'unknown' }}</dd>
            <dt>建议单轮输出</dt><dd>{{ selfCheck.info.recommendedMaxOutputTokens ?? 'unknown' }}</dd>
            <dt>Tokenizer</dt><dd>{{ selfCheck.info.tokenizer || 'unknown' }}</dd>
            <dt>持载区(CWD)</dt><dd class="code">{{ selfCheck.info.workspace }}</dd>
            <dt>交互策略</dt><dd>{{ selfCheck.info.interactionMode }}</dd>
            <dt>时间戳</dt><dd>{{ selfCheck.checkedAt }}</dd>
          </dl>
        </div>
        <div class="info-block">
          <h3>🔌 能力校验钩子 (Capabilities Check)</h3>
          <ul class="capability-list">
            <li v-for="item in selfCheck.checks" :key="item.key">
              <span class="status-icon">{{ item.status === 'ok' ? '✅' : '⚠️' }}</span>
              <div class="cap-text">
                <strong>{{ getChineseCheckLabel(item.key) }}</strong>
                <span class="cap-detail">{{ item.detail }}</span>
              </div>
            </li>
          </ul>
        </div>
      </div>
    </div>
  </div>
</details>
        </div>

        <!-- 管理器功能面板区（处于运行态时全部展开展示） -->
        <div class="feature-panels" v-if="runtimeState?.state === 'running'">
          <!-- 项目状态与任务栈看板 (占位/规划区) -->
          <details class="panel" open>
            <summary class="panel-header" style="display: flex; align-items: center; justify-content: space-between;">
              <div class="panel-title">📋 调度任务栈看板 (Project status & Queues)</div>
            </summary>
            <div class="panel-content placeholder-mode">
              <p class="placeholder-desc">功能插槽：未来将直读内存文件 <code>STATUS.md</code> 与 <code>TASK_QUEUE.md</code>，可视化当前项目进度、阻塞项与堆积任务。</p>
              <div class="mock-grid">
                <div class="mock-card">
                  <div class="mock-icon">🟢</div>
                  <div class="mock-body">
                    <strong>全局服务健康</strong>
                    <span>Engine: http/1999 | Editor: http/8868</span>
                  </div>
                </div>
                <div class="mock-card">
                  <div class="mock-icon">📦</div>
                  <div class="mock-body">
                    <strong>原子任务队列排期</strong>
                    <span>当前积压：3 项待执行批次</span>
                  </div>
                </div>
              </div>
              <div class="panel-footer">
                <button class="action-btn outline" disabled>拉取工作区快照</button>
              </div>
            </div>
          </details>

          

        </div>
    </section>
  </main>

</template>

<style scoped>
.chat-panel-shell {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.chat-thread {
  display: flex;
  flex-direction: column;
  gap: 14px;
  min-height: 100%;
  max-height: none;
  overflow-y: auto;
  padding: 16px;
  background:
    linear-gradient(180deg, rgba(18, 22, 28, 0.96) 0%, rgba(26, 31, 38, 0.92) 100%);
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 12px;
}

.chat-thread-resizable {
  min-height: 320px;
  max-height: min(72vh, 860px);
  resize: vertical;
  overflow: auto;
}

.chat-empty-state {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin: auto 0;
  color: #c7d2dd;
}

.chat-empty-title {
  font-size: 16px;
  font-weight: 700;
  color: #f5f7fb;
}

.chat-empty-copy {
  font-size: 13px;
  color: #a9b7c6;
}

.chat-row {
  display: flex;
}

.chat-row[data-role='user'] {
  justify-content: flex-end;
}

.chat-row[data-role='hermes'],
.chat-row[data-role='error'] {
  justify-content: flex-start;
}

.chat-bubble {
  width: fit-content;
  max-width: min(78ch, 82%);
  padding: 12px 14px;
  border-radius: 16px;
  box-shadow: 0 10px 30px rgba(0, 0, 0, 0.16);
}

.chat-bubble[data-role='user'] {
  background: linear-gradient(135deg, #2a7dd6 0%, #1f5ea8 100%);
  color: #f5fbff;
  border-bottom-right-radius: 6px;
}

.chat-bubble[data-role='hermes'] {
  background: linear-gradient(135deg, #222a33 0%, #161d26 100%);
  color: #f3f7fb;
  border: 1px solid rgba(142, 196, 255, 0.18);
  border-bottom-left-radius: 6px;
}

.chat-bubble[data-role='error'] {
  background: linear-gradient(135deg, #6d1f28 0%, #54161d 100%);
  color: #fff1f1;
  border: 1px solid rgba(255, 160, 160, 0.22);
  border-bottom-left-radius: 6px;
}

.chat-role {
  margin-bottom: 6px;
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.08em;
  opacity: 0.72;
}

.chat-message-text {
  font-size: 15px;
  line-height: 1.6;
  word-break: break-word;
}

.chat-message-text :deep(h1),
.chat-message-text :deep(h2),
.chat-message-text :deep(h3),
.chat-message-text :deep(h4),
.chat-message-text :deep(h5),
.chat-message-text :deep(h6) {
  margin: 0 0 10px;
  line-height: 1.35;
  color: #ffffff;
}

.chat-message-text :deep(h1) {
  font-size: 20px;
}

.chat-message-text :deep(h2) {
  font-size: 18px;
}

.chat-message-text :deep(h3) {
  font-size: 16px;
}

.chat-message-text :deep(p),
.chat-message-text :deep(ul),
.chat-message-text :deep(ol),
.chat-message-text :deep(blockquote),
.chat-message-text :deep(pre) {
  margin: 0;
}

.chat-message-text :deep(p + p),
.chat-message-text :deep(p + ul),
.chat-message-text :deep(p + ol),
.chat-message-text :deep(ul + p),
.chat-message-text :deep(ol + p),
.chat-message-text :deep(blockquote + p),
.chat-message-text :deep(pre + p),
.chat-message-text :deep(p + blockquote),
.chat-message-text :deep(p + pre) {
  margin-top: 10px;
}

.chat-message-text :deep(ul),
.chat-message-text :deep(ol) {
  padding-left: 20px;
}

.chat-message-text :deep(li + li) {
  margin-top: 4px;
}

.chat-message-text :deep(blockquote) {
  padding-left: 12px;
  border-left: 3px solid rgba(143, 191, 255, 0.45);
  color: #c8d8e8;
}

.chat-message-text :deep(code) {
  padding: 1px 5px;
  border-radius: 6px;
  background: rgba(255, 255, 255, 0.08);
  font: 12px/1.5 SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', monospace;
}

.chat-message-text :deep(pre) {
  padding: 12px;
  border-radius: 10px;
  background: rgba(4, 8, 14, 0.72);
  overflow: auto;
}

.chat-message-text :deep(pre code) {
  display: block;
  padding: 0;
  background: transparent;
}

.chat-message-text :deep(a) {
  color: #8fc4ff;
  text-decoration: underline;
}

.chat-message-text :deep(hr) {
  margin: 12px 0;
  border: none;
  border-top: 1px solid rgba(255, 255, 255, 0.12);
}

.chat-token-usage {
  margin-top: 10px;
  padding-top: 8px;
  border-top: 1px solid rgba(255, 255, 255, 0.08);
  font-size: 11px;
  color: #95e62b;
}

.chat-composer {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px;
  background: rgba(15, 18, 23, 0.72);
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 12px;
}

.chat-composer-input {
  width: 100%;
  min-height: 88px;
  max-height: 220px;
  padding: 12px 14px;
  resize: vertical;
  border-radius: 10px;
  background: #12161c;
  border: 1px solid #45515f;
  color: #f5f7fb;
  font: inherit;
  line-height: 1.5;
}

.chat-composer-input:focus {
  outline: none;
  border-color: #59a7ff;
  box-shadow: 0 0 0 3px rgba(89, 167, 255, 0.16);
}

.chat-composer-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.chat-composer-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.chat-composer-hint {
  font-size: 12px;
  color: #8fa0b2;
}

.chat-context-panel {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px 12px;
  background: rgba(15, 18, 23, 0.62);
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 12px;
}

.chat-context-summary-line {
  display: flex;
  flex-wrap: wrap;
  gap: 8px 14px;
  font-size: 12px;
  line-height: 1.5;
  color: #c9d4de;
}

.chat-context-sources-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.chat-context-source-line {
  display: flex;
  flex-wrap: wrap;
  gap: 8px 12px;
  padding-top: 6px;
  border-top: 1px solid rgba(255, 255, 255, 0.06);
  font-size: 12px;
  line-height: 1.5;
  color: #aebdca;
}

.chat-context-source-line:first-child {
  padding-top: 0;
  border-top: none;
}

.chat-context-source-label {
  color: #f5f7fb;
}

.chat-context-source-ok {
  color: #7cfc9a;
}

.chat-context-source-missing {
  color: #ff8a80;
}

.chat-context-source-path {
  word-break: break-all;
}

.chat-context-source-meta {
  color: #8ea1b3;
}

.chat-memory-panel {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 12px;
  background: rgba(15, 18, 23, 0.72);
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 12px;
}

.submit-gate-panel {
  border-color: rgba(89, 167, 255, 0.24);
}

.submit-gate-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
  gap: 12px;
}

.submit-gate-block {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.submit-source-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
  max-height: 220px;
  overflow: auto;
}

.submit-source-item {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 8px 10px;
  background: rgba(9, 12, 18, 0.56);
  border: 1px solid rgba(255, 255, 255, 0.06);
  border-radius: 10px;
  font-size: 12px;
  color: #d7e1ea;
}

.submit-source-item-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.submit-source-checkbox-line {
  display: inline-flex;
  align-items: center;
  gap: 8px;
}

.submit-source-open-btn {
  padding: 4px 8px;
  font-size: 11px;
}

.context-pool-list-btn {
  flex: 1;
  justify-content: flex-start;
  text-align: left;
}

.context-pool-list-row {
  display: flex;
  align-items: center;
  gap: 8px;
}

.mini-danger-btn {
  flex: 0 0 auto;
  padding: 4px 8px;
  font-size: 11px;
  color: #ffb3a7;
  border-color: rgba(255, 140, 120, 0.35);
}

.context-file-editor-shell {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.editor-modal-backdrop {
  position: fixed;
  inset: 0;
  z-index: 1200;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  background: rgba(5, 8, 12, 0.76);
  backdrop-filter: blur(4px);
}

.editor-modal-shell {
  width: min(1120px, 100%);
  max-height: calc(100vh - 48px);
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 16px;
  background: #10151c;
  border: 1px solid rgba(89, 167, 255, 0.24);
  border-radius: 14px;
  box-shadow: 0 24px 80px rgba(0, 0, 0, 0.45);
}

.editor-modal-shell:focus {
  outline: none;
}

.editor-modal-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}

.editor-modal-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.context-file-codemirror {
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 10px;
  overflow: hidden;
}

.context-file-codemirror :deep(.cm-editor) {
  height: 100%;
  font-size: 12px;
}

.context-file-codemirror :deep(.cm-scroller) {
  font-family: 'SFMono-Regular', 'Menlo', 'Monaco', monospace;
}

.reasoning-panel {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 12px;
  background: rgba(15, 18, 23, 0.72);
  border: 1px solid rgba(89, 167, 255, 0.22);
  border-radius: 12px;
}

.reasoning-panel-header {
  display: flex;
  justify-content: space-between;
  gap: 12px;
}

.reasoning-subtitle {
  margin-top: 4px;
  font-size: 12px;
  line-height: 1.5;
  color: #8fa0b2;
  word-break: break-all;
}

.reasoning-plan-box,
.reasoning-artifact-box,
.reasoning-timeline {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px 12px;
  background: rgba(9, 12, 18, 0.56);
  border: 1px solid rgba(255, 255, 255, 0.06);
  border-radius: 10px;
}

.transport-preview-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
  gap: 10px;
}

.transport-preview-card {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px 12px;
  border-radius: 10px;
  background: rgba(9, 12, 18, 0.56);
  border: 1px solid rgba(255, 255, 255, 0.06);
}

.transport-preview-card.controller {
  border-color: rgba(89, 167, 255, 0.32);
  background: rgba(13, 24, 38, 0.72);
}

.transport-preview-card.route {
  border-color: rgba(255, 184, 107, 0.28);
  background: rgba(36, 24, 10, 0.62);
}

.transport-preview-card.hints {
  border-color: rgba(124, 252, 154, 0.24);
  background: rgba(12, 28, 20, 0.62);
}

.transport-preview-card-title {
  font-size: 12px;
  font-weight: 700;
  letter-spacing: 0.06em;
  color: #f5f7fb;
}

.transport-preview-meta {
  font-size: 12px;
  line-height: 1.5;
  color: #aebdca;
}

.transport-preview-pre {
  max-height: 320px;
}

.transport-hint-line {
  align-items: flex-start;
}

.capability-panel {
  margin-top: 12px;
}

.capability-summary {
  cursor: pointer;
}

.capability-section {
  margin-top: 10px;
}

.capability-action-line,
.capability-skill-line {
  align-items: flex-start;
}

.capability-hint-group {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 8px;
}

.capability-hint-chip {
  white-space: normal;
}

.capability-guide-pre {
  max-height: 360px;
}

.reasoning-plan-title {
  font-size: 12px;
  font-weight: 700;
  letter-spacing: 0.08em;
  color: #8fbfff;
}

.reasoning-plan-goal {
  font-size: 13px;
  color: #f5f7fb;
}

.reasoning-plan-steps {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.reasoning-plan-step,
.reasoning-artifact-item,
.reasoning-event-row {
  display: flex;
  flex-wrap: wrap;
  gap: 8px 12px;
  align-items: flex-start;
  padding-top: 6px;
  border-top: 1px solid rgba(255, 255, 255, 0.06);
  font-size: 12px;
  line-height: 1.5;
  color: #aebdca;
}

.reasoning-plan-step:first-child,
.reasoning-artifact-item:first-child,
.reasoning-event-row:first-child {
  padding-top: 0;
  border-top: none;
}

.reasoning-plan-step.active {
  color: #f5f7fb;
}

.reasoning-plan-step.review {
  color: #f6e7aa;
}

.reasoning-plan-step-chip {
  padding: 2px 8px;
  border-radius: 999px;
  background: rgba(143, 191, 255, 0.12);
  border: 1px solid rgba(143, 191, 255, 0.18);
  color: #cfe5ff;
}

.reasoning-review-box {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 10px 12px;
  background: rgba(56, 46, 14, 0.26);
  border: 1px solid rgba(255, 214, 102, 0.28);
  border-radius: 10px;
}

.reasoning-review-title {
  font-size: 14px;
  font-weight: 600;
  color: #f6e7aa;
}

.reasoning-review-summary {
  font-size: 12px;
  line-height: 1.6;
  color: #d7dee6;
}

.reasoning-evidence-block {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.reasoning-evidence-title {
  font-size: 12px;
  font-weight: 600;
  color: #f5f7fb;
}

.reasoning-evidence-pre {
  margin: 0;
  padding: 10px 12px;
  border-radius: 8px;
  background: rgba(9, 12, 18, 0.72);
  border: 1px solid rgba(255, 255, 255, 0.08);
  color: #cfd8e3;
  font-size: 12px;
  line-height: 1.55;
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 280px;
  overflow: auto;
}

.reasoning-review-editor {
  min-height: 96px;
}

.reasoning-review-actions {
  display: flex;
  justify-content: flex-end;
  gap: 12px;
}

.reasoning-artifact-path {
  word-break: break-all;
  color: #8fa0b2;
}

.reasoning-event-type {
  min-width: 118px;
  color: #8fbfff;
  text-transform: uppercase;
}

.reasoning-event-body {
  flex: 1;
  min-width: 180px;
}

.reasoning-event-title {
  color: #f5f7fb;
}

.reasoning-event-summary {
  color: #aebdca;
}

.reasoning-event-meta-list {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 8px;
}

.reasoning-event-meta-chip {
  padding: 2px 8px;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.05);
  border: 1px solid rgba(255, 255, 255, 0.08);
  color: #d7e1ea;
}

.reasoning-event-ops {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-top: 8px;
  padding: 8px 10px;
  border-radius: 8px;
  background: rgba(5, 8, 12, 0.32);
  border: 1px solid rgba(255, 255, 255, 0.06);
}

.reasoning-event-ops-title {
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.06em;
  color: #8fbfff;
}

.reasoning-event-op-line {
  font: 12px/1.5 SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', monospace;
  color: #d7e1ea;
  word-break: break-word;
}

.reasoning-event-time {
  color: #7f91a2;
}

.chat-memory-header-row {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}

.chat-memory-title {
  font-size: 13px;
  font-weight: 700;
  color: #f5f7fb;
}

.chat-memory-path {
  margin-top: 4px;
  font-size: 12px;
  line-height: 1.5;
  color: #a9b7c6;
  word-break: break-all;
}

.chat-memory-desc {
  margin-top: 6px;
  font-size: 12px;
  line-height: 1.5;
  color: #8fa0b2;
}

.chat-memory-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 8px 16px;
  font-size: 12px;
  color: #8fa0b2;
}

.chat-memory-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.chat-memory-editor-shell {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.chat-memory-editor {
  width: 100%;
  min-height: 220px;
  padding: 12px 14px;
  resize: vertical;
  border-radius: 10px;
  background: #12161c;
  border: 1px solid #45515f;
  color: #f5f7fb;
  font: 12px/1.6 SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', monospace;
}

.chat-memory-editor:focus {
  outline: none;
  border-color: #59a7ff;
  box-shadow: 0 0 0 3px rgba(89, 167, 255, 0.16);
}

.chat-memory-editor-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.chat-memory-editor-hint {
  font-size: 12px;
  color: #8fa0b2;
}

@media (max-width: 820px) {
  .chat-thread-resizable {
    min-height: 260px;
    max-height: 60vh;
  }

  .chat-thread {
    padding: 12px;
  }

  .chat-bubble {
    max-width: 92%;
  }

  .chat-composer {
    padding: 10px;
  }

  .chat-composer-footer {
    flex-direction: column;
    align-items: stretch;
  }

  .chat-composer-hint {
    text-align: left;
  }

  .chat-memory-header-row,
  .chat-memory-editor-footer {
    flex-direction: column;
    align-items: stretch;
  }
}
</style>