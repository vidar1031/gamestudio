<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import {
  listPendingReviews,
  listGovernanceAudit,
  listReasoningQueueItems,
  submitReasoningSessionReview,
  listCronJobs,
  setCronJobStatus,
  triggerCronJob,
  getRightBrainSupervision,
  runRightBrainSupervision,
  reviewRightBrainSuggestion,
  listSkillCandidates,
  getSkillCandidateContent,
  reviewSkillCandidate,
  listActiveSkills,
  searchHermesSessionHistory
} from '../services/reasoningApi'
import { getHealth, getOverview, getRuntimeStatus, getSupervisionState, getResourcesState } from '../services/controlApi'

// HERMES-H01：守护台治理页——待审核中心、运行健康、操作审计三个视图。
// 所有数据刷新即重新拉取服务端，不做本地缓存臆测；操作结果直接展示 API 返回。

type PendingReviewItem = {
  sessionId: string
  title: string
  status: string
  updatedAt: string | null
  projectId: string | null
  review: {
    title: string | null
    summary: string | null
    targetType: string | null
    reviewPhase: string | null
    stepId: string | null
    stepIndex: number | null
  }
  queueItem: { taskId: string | null; status: string | null } | null
}

type AuditRecord = {
  ts: string
  action: string
  sessionId: string | null
  taskId: string | null
  jobId?: string
  result: 'ok' | 'blocked'
  detail: string | null
  decision?: string
}

// HERMES-H02：cron 定时任务视图模型
type CronTriggerRecord = {
  idempotencyKey: string
  triggeredAt: string
  result: 'submitted' | 'skipped_duplicate'
  reason?: string
  sessionId: string | null
  taskId: string | null
  manual?: boolean
}

type CronJobItem = {
  jobId: string
  name: string
  workflow: string
  prompt: string
  intervalMs: number
  reviewMode: string
  status: 'active' | 'paused' | 'disabled'
  lastTriggeredAt: string | null
  nextTriggerAt: string | null
  recentTriggers: CronTriggerRecord[]
}

type CronWorkflowInfo = { workflowId: string; label: string; source: string }

// HERMES-H03：右脑子 agent 监察视图模型
type SupervisionSuggestion = {
  suggestionId: string
  action: string | null
  params: Record<string, unknown>
  rationale: string
  evidenceRefs: string[]
  classification: 'read' | 'controlled' | 'rejected'
  status: 'allowed_read' | 'pending_review' | 'rejected' | 'approved_executed' | 'approved_blocked' | 'rejected_by_human'
  rejectReason?: string
  executionDetail?: string
}

type SupervisionRun = {
  runId: string
  supervisorId: string
  trigger: string
  focusSessionId: string | null
  ts: string
  model: { provider: string | null; model: string | null } | null
  status: 'completed' | 'evidence_unavailable' | 'model_unavailable' | 'model_error' | 'output_invalid'
  outputSummary: string | null
  error: string | null
  findings: { title: string; detail: string; severity: string }[]
  suggestions: SupervisionSuggestion[]
}

type RightBrainSupervision = {
  supervisor: {
    supervisorId: string
    readActions: { action: string; title: string; category: string }[]
    controlledActions: { action: string; title: string; description: string }[]
    model: { available: boolean; provider: string | null; model: string | null; unavailableReason: string | null }
  } | null
  runs: SupervisionRun[]
}

type QueueItemLite = {
  sessionId: string
  status: string
  nextAttemptAt: string | null
  session: { status: string } | null
}

// 学习循环技能治理视图模型：agent 自创技能候选与已决记录
type SkillCandidateItem = {
  name: string
  category: string
  description: string
  origin: 'agent_created' | 'bundled_patched'
  sourceDir: string
  contentHash: string
}

type SkillDecidedItem = SkillCandidateItem & {
  status: 'approved' | 'rejected'
  decidedAt: string | null
  actor: string | null
  note: string
  activatedSkillFile: string | null
  sourceMissing: boolean
  sourceChangedAfterDecision: boolean
}

type ActiveSkillItem = {
  name: string
  category: string
  description: string
  origin: string
  decidedAt: string | null
  actor: string | null
  note: string
  activatedSkillFile: string | null
  activatedExists: boolean
  injected: boolean
}

type SkillContentPayload = {
  content: string
  truncated: boolean
  files: string[]
}

const pendingReviews = ref<PendingReviewItem[]>([])
const auditRecords = ref<AuditRecord[]>([])
const queueItems = ref<QueueItemLite[]>([])
const health = ref<any>(null)
const overview = ref<any>(null)
const runtimeStatus = ref<any>(null)
const supervision = ref<any>(null)
const resources = ref<any>(null)
const cronJobs = ref<CronJobItem[]>([])
const cronWorkflows = ref<CronWorkflowInfo[]>([])
const cronScheduler = ref<{ running: boolean; tickMs: number } | null>(null)
const rightBrain = ref<RightBrainSupervision>({ supervisor: null, runs: [] })

// 学习循环技能治理状态：候选 / 已决 / 已激活注入清单
const skillCandidates = ref<SkillCandidateItem[]>([])
const skillDecided = ref<SkillDecidedItem[]>([])
const skillBundledPristine = ref(0)
const skillScanRoot = ref('')
const activeSkills = ref<ActiveSkillItem[]>([])
const skillAvailableFiles = ref<string[]>([])
const skillContents = ref<Record<string, SkillContentPayload | 'loading'>>({})
const skillNoteDrafts = ref<Record<string, string>>({})
const skillBusyId = ref('')

const busy = ref(false)
const reviewBusyId = ref('')
const cronBusyId = ref('')
const supervisionBusy = ref(false)
const evidencePacks = ref<Array<{ actionId: string; packId: string; generatedAt: string; capabilityId?: string; state?: string; filePath?: string }>>([])
const evidencePacksBusy = ref(false)
const evidencePacksError = ref('')
const suggestionBusyId = ref('')
const error = ref('')
const actionMessage = ref('')
const reviewDrafts = ref<Record<string, string>>({})

// 历史会话检索（只读）：control 直查 Hermes state.db FTS5，不经过网关推理
type SessionSearchHit = {
  messageId: number
  sessionId: string
  role: string
  source: string | null
  toolName: string | null
  timestamp: string | null
  sessionStartedAt: string | null
  snippet: string
  contentPreview: string
}
const sessionSearchQuery = ref('')
const sessionSearchHits = ref<SessionSearchHit[]>([])
const sessionSearchBusy = ref(false)
const sessionSearchSearched = ref(false)
const sessionSearchExpanded = ref<Record<number, boolean>>({})

const REVIEW_TARGET_LABELS: Record<string, string> = {
  plan: '任务计划',
  runtime_task_graph: '任务计划',
  step: '步骤结果',
  answer: '最终回答',
  write: '写入操作',
  command: '命令执行'
}

const REVIEW_PHASE_LABELS: Record<string, string> = {
  before_execution: '执行前确认',
  after_execution: '执行后确认',
  standard: '标准审核',
  quality_override: '最终确认'
}

const AUDIT_ACTION_LABELS: Record<string, string> = {
  cancel: '取消任务',
  recover: '恢复任务',
  retry: '重试任务',
  review: '审核',
  cron_job_create: '创建定时任务',
  cron_job_pause: '暂停定时任务',
  cron_job_resume: '恢复定时任务',
  cron_job_disable: '停用定时任务',
  cron_job_delete: '删除定时任务',
  cron_trigger: '定时任务触发',
  right_brain_supervision: '右脑监察',
  right_brain_suggestion_blocked: '右脑越权建议拦截',
  right_brain_suggestion_review: '右脑建议审核',
  skill_review: '技能审核'
}

const AUDIT_DECISION_LABELS: Record<string, string> = {
  approve: '批准',
  reject: '拒绝',
  back: '后退一步'
}

const QUEUE_STATUS_LABELS: Record<string, string> = {
  queued: '排队中',
  claimed: '已领取',
  running: '运行中',
  completed: '已完成',
  failed: '已失败',
  cancelled: '已取消',
  timeout: '已超时',
  blocked: '已阻断'
}

// 队列概览：按展示态聚合（queued 且带重试窗口 = 重试等待，与任务队列页同一语义）
const queueSummary = computed(() => {
  const summary = { active: 0, retryWait: 0, waitingReview: 0, blocked: 0, failed: 0 }
  for (const entry of queueItems.value) {
    const display = entry.status === 'queued' && entry.nextAttemptAt ? 'retry_wait' : entry.status
    if (display === 'retry_wait') summary.retryWait += 1
    else if (display === 'blocked') summary.blocked += 1
    else if (display === 'failed') summary.failed += 1
    else if (display === 'queued' || display === 'claimed' || display === 'running') summary.active += 1
    if (entry.session?.status === 'waiting_review') summary.waitingReview += 1
  }
  return summary
})

const gatewaySupervision = computed(() => supervision.value?.gatewaySupervision || null)

const GATEWAY_STATUS_LABELS: Record<string, string> = {
  disabled: '未启用',
  monitoring: '监测中',
  backing_off: '退避等待',
  restarting: '重启中',
  blocked: '已阻断'
}

// AUTO-R01：资源互斥卡片视图模型（槽位/模型在线/内存水位/最近交换）
const RESOURCE_SLOT_LABELS: Record<string, string> = {
  idle: '空闲',
  llm: '模型在线',
  gpu: '出图占用',
  blocked: '已阻断'
}

const RESOURCE_EVENT_LABELS: Record<string, string> = {
  swap_to_gpu_start: '开始为出图腾内存',
  swap_to_gpu_ok: '模型已退出，放行出图',
  swap_to_gpu_failed: '出图前模型退出失败',
  swap_to_llm_start: '开始回载模型',
  swap_to_llm_ok: '模型已回载',
  swap_to_llm_failed: '模型回载失败',
  swap_unload_retry: '模型退出重试',
  swap_load_retry: '模型加载重试',
  guard_unload_foreign_model: '卸载非配置模型',
  gpu_release: '出图槽位释放'
}

const resourceSlot = computed(() => {
  const state = resources.value
  if (!state) return { label: '不可用', tone: 'warn' }
  if (state.enabled === false) return { label: '未启用', tone: 'info' }
  const slot = String(state.state || '')
  if (slot === 'blocked') return { label: RESOURCE_SLOT_LABELS.blocked, tone: 'error' }
  if (slot === 'gpu') return { label: RESOURCE_SLOT_LABELS.gpu, tone: 'warn' }
  if (slot === 'llm') return { label: RESOURCE_SLOT_LABELS.llm, tone: 'ok' }
  return { label: RESOURCE_SLOT_LABELS.idle, tone: 'info' }
})

const resourceMemoryText = computed(() => {
  const memory = resources.value?.memory
  if (!memory || !Number.isFinite(Number(memory.currentModelMemory))) return '内存水位未知'
  const usedGb = Number(memory.currentModelMemory) / 1024 ** 3
  const ceilingGb = Number(memory.finalCeiling) / 1024 ** 3
  const ceiling = Number.isFinite(ceilingGb) && ceilingGb > 0 ? ` / 上限 ${ceilingGb.toFixed(1)} GB` : ''
  return `模型内存 ${usedGb.toFixed(1)} GB${ceiling}`
})

const resourceModelText = computed(() => {
  const state = resources.value
  if (!state || state.enabled === false) return '-'
  const model = state.configuredModel || '-'
  const online = state.modelOnline
  if (!online) return model
  const status = online.loaded ? '在线' : (online.isLoading ? '加载中' : '未加载')
  const foreign = Array.isArray(online.otherLoaded) && online.otherLoaded.length ? ` · 非配置在线：${online.otherLoaded.join('、')}` : ''
  return `${model} · ${status}${foreign}`
})

const resourceRecentSwaps = computed(() => {
  const events = Array.isArray(resources.value?.recentEvents) ? resources.value.recentEvents : []
  return events
    .filter((event: any) => ['swap_to_gpu_ok', 'swap_to_gpu_failed', 'swap_to_llm_ok', 'swap_to_llm_failed', 'guard_unload_foreign_model'].includes(String(event?.type || '')))
    .slice(0, 5)
    .map((event: any) => {
      const type = String(event?.type || '')
      const direction = type.includes('to_gpu') ? '出图' : (type.includes('to_llm') ? '回载' : '守卫')
      const cost = Number.isFinite(Number(event?.unload_ms)) ? `${Math.round(Number(event.unload_ms) / 100) / 10}s`
        : (Number.isFinite(Number(event?.load_ms)) ? `${Math.round(Number(event.load_ms) / 100) / 10}s` : '-')
      return {
        at: event?.ts || null,
        label: RESOURCE_EVENT_LABELS[type] || type,
        direction,
        cost,
        ok: event?.result !== 'failed',
        detail: event?.detail || ''
      }
    })
})

async function loadPendingReviews() {
  const res = await listPendingReviews()
  const payload = await res.json().catch(() => null)
  if (!res.ok || !payload?.ok) throw new Error(payload?.error || `http_${res.status}`)
  pendingReviews.value = Array.isArray(payload.items) ? payload.items : []
}

async function loadAudit() {
  const res = await listGovernanceAudit(100)
  const payload = await res.json().catch(() => null)
  if (!res.ok || !payload?.ok) throw new Error(payload?.error || `http_${res.status}`)
  auditRecords.value = Array.isArray(payload.records) ? payload.records : []
}

async function loadQueue() {
  const res = await listReasoningQueueItems()
  const payload = await res.json().catch(() => null)
  if (!res.ok || !payload?.ok) throw new Error(payload?.error || `http_${res.status}`)
  queueItems.value = Array.isArray(payload.items) ? payload.items : []
}

// HERMES-H02：cron job 列表 + 调度器状态（单项失败不拖垮整页）
async function loadCronJobs() {
  try {
    const res = await listCronJobs()
    const payload = await res.json().catch(() => null)
    if (!res.ok || !payload?.ok) throw new Error(payload?.error || `http_${res.status}`)
    cronJobs.value = Array.isArray(payload.jobs) ? payload.jobs : []
    cronWorkflows.value = Array.isArray(payload.workflows) ? payload.workflows : []
    cronScheduler.value = payload.scheduler || null
  } catch {
    cronJobs.value = []
    cronScheduler.value = null
  }
}

// HERMES-H03：右脑监察状态（身份/白名单/模型可用性/运行记录），单项失败不拖垮整页
async function loadRightBrainSupervision() {
  try {
    const res = await getRightBrainSupervision()
    const payload = await res.json().catch(() => null)
    if (!res.ok || !payload?.ok) throw new Error(payload?.error || `http_${res.status}`)
    rightBrain.value = {
      supervisor: payload.supervisor || null,
      runs: Array.isArray(payload.runs) ? payload.runs : []
    }
  } catch {
    rightBrain.value = { supervisor: null, runs: [] }
  }
}

// 学习循环技能治理：候选扫描 + 当前注入清单（单项失败不拖垮整页）
async function loadSkillGovernance() {
  const [candidatesRes, activeRes] = await Promise.allSettled([listSkillCandidates(), listActiveSkills()])
  if (candidatesRes.status === 'fulfilled' && candidatesRes.value.ok) {
    const payload = await candidatesRes.value.json().catch(() => null)
    if (payload?.ok) {
      skillCandidates.value = Array.isArray(payload.candidates) ? payload.candidates : []
      skillDecided.value = Array.isArray(payload.decided) ? payload.decided : []
      skillBundledPristine.value = Number(payload.bundledPristine || 0)
      skillScanRoot.value = String(payload.root || '')
    }
  }
  if (activeRes.status === 'fulfilled' && activeRes.value.ok) {
    const payload = await activeRes.value.json().catch(() => null)
    if (payload?.ok) {
      activeSkills.value = Array.isArray(payload.approved) ? payload.approved : []
      skillAvailableFiles.value = Array.isArray(payload.availableSkillFiles) ? payload.availableSkillFiles : []
    }
  }
}

// 展开/收起技能内容（SKILL.md 全文），懒加载一次后本地缓存
async function toggleSkillContent(name: string) {
  if (skillContents.value[name]) {
    const next = { ...skillContents.value }
    delete next[name]
    skillContents.value = next
    return
  }
  skillContents.value = { ...skillContents.value, [name]: 'loading' }
  try {
    const res = await getSkillCandidateContent(name)
    const payload = await res.json().catch(() => null)
    if (!res.ok || !payload?.ok) throw new Error(payload?.detail || payload?.error || `http_${res.status}`)
    skillContents.value = {
      ...skillContents.value,
      [name]: { content: String(payload.content || ''), truncated: Boolean(payload.truncated), files: Array.isArray(payload.files) ? payload.files : [] }
    }
  } catch (e) {
    const next = { ...skillContents.value }
    delete next[name]
    skillContents.value = next
    error.value = String(e)
  }
}

// 人工审核技能候选：approve 复制到可信根并加入注入清单；reject 留档不生效
async function reviewSkill(name: string, decision: 'approve' | 'reject') {
  if (skillBusyId.value) return
  skillBusyId.value = name
  error.value = ''
  actionMessage.value = ''
  try {
    const res = await reviewSkillCandidate(name, {
      actor: 'human:control-console',
      decision,
      note: (skillNoteDrafts.value[name] || '').trim()
    })
    const payload = await res.json().catch(() => null)
    if (!res.ok || !payload?.ok) {
      throw new Error(payload?.detail || payload?.error || `http_${res.status}`)
    }
    actionMessage.value = decision === 'approve'
      ? `技能「${name}」已通过审核，加入技能注入清单，下次任务生效。`
      : `技能「${name}」已拒绝，不会进入注入清单。`
    skillNoteDrafts.value = { ...skillNoteDrafts.value, [name]: '' }
    const next = { ...skillContents.value }
    delete next[name]
    skillContents.value = next
    await loadAll()
  } catch (e) {
    error.value = String(e)
    await loadAll()
  } finally {
    skillBusyId.value = ''
  }
}

const SKILL_ORIGIN_LABELS: Record<string, string> = {
  agent_created: '非捆绑来源（agent 自创或外部安装）',
  bundled_patched: '捆绑技能被 agent 修改'
}

const SKILL_STATUS_LABELS: Record<string, string> = {
  approved: '已通过',
  rejected: '已拒绝'
}

// 历史会话检索：命中展示会话与时间，点击可展开消息摘要
async function runSessionSearch() {
  const q = sessionSearchQuery.value.trim()
  if (!q || sessionSearchBusy.value) return
  sessionSearchBusy.value = true
  error.value = ''
  try {
    const res = await searchHermesSessionHistory(q)
    const payload = await res.json().catch(() => null)
    if (!res.ok || !payload?.ok) throw new Error(payload?.detail || payload?.error || `http_${res.status}`)
    sessionSearchHits.value = Array.isArray(payload.hits) ? payload.hits : []
    sessionSearchSearched.value = true
    sessionSearchExpanded.value = {}
  } catch (e) {
    error.value = String(e)
  } finally {
    sessionSearchBusy.value = false
  }
}

function toggleSessionSearchHit(messageId: number) {
  sessionSearchExpanded.value = {
    ...sessionSearchExpanded.value,
    [messageId]: !sessionSearchExpanded.value[messageId]
  }
}

// HERMES-H03：人工触发一次右脑监察；模型不可用时服务端显式降级留证，结果直接展示
async function triggerRightBrainSupervision() {
  if (supervisionBusy.value) return
  supervisionBusy.value = true
  error.value = ''
  actionMessage.value = ''
  try {
    const res = await runRightBrainSupervision()
    const payload = await res.json().catch(() => null)
    if (!res.ok || !payload?.ok) throw new Error(payload?.error || `http_${res.status}`)
    const run = payload.run
    actionMessage.value = run?.status === 'completed'
      ? `监察完成：${run.findings?.length || 0} 条发现、${run.suggestions?.length || 0} 条建议。`
      : `监察未产出结果（${SUPERVISION_RUN_STATUS_LABELS[run?.status] || run?.status || '未知状态'}），已留证。`
    await loadAll()
  } catch (e) {
    error.value = String(e)
    await loadAll()
  } finally {
    supervisionBusy.value = false
  }
}

// HERMES-H03：审核子 agent 的受控建议；approve 后经既有受控 API 执行，结果直接展示
async function reviewSupervisionSuggestion(runId: string, suggestionId: string, decision: 'approve' | 'reject') {
  if (suggestionBusyId.value) return
  suggestionBusyId.value = suggestionId
  error.value = ''
  actionMessage.value = ''
  try {
    const res = await reviewRightBrainSuggestion(runId, suggestionId, decision)
    const payload = await res.json().catch(() => null)
    if (!res.ok || !payload?.ok) {
      throw new Error(payload?.detail || payload?.error || `http_${res.status}`)
    }
    actionMessage.value = decision === 'approve' ? '建议已批准并经受控路径执行。' : '建议已驳回。'
    await loadAll()
  } catch (e) {
    error.value = String(e)
    await loadAll()
  } finally {
    suggestionBusyId.value = ''
  }
}

const SUPERVISION_RUN_STATUS_LABELS: Record<string, string> = {
  completed: '已完成',
  evidence_unavailable: '证据不可用',
  model_unavailable: '右脑模型不可用',
  model_error: '模型调用失败',
  output_invalid: '输出无法解析'
}

const SUGGESTION_STATUS_LABELS: Record<string, string> = {
  allowed_read: '只读放行',
  pending_review: '待人工审核',
  rejected: '越权已拒绝',
  approved_executed: '已批准执行',
  approved_blocked: '执行被阻断',
  rejected_by_human: '已人工驳回'
}

const CONTROLLED_ACTION_LABELS: Record<string, string> = {
  retry_session: '重试失败任务',
  cancel_session: '取消任务'
}

function suggestionActionLabel(suggestion: SupervisionSuggestion) {
  if (!suggestion.action) return '(空动作)'
  if (suggestion.classification === 'controlled') return CONTROLLED_ACTION_LABELS[suggestion.action] || suggestion.action
  return suggestion.action
}

// 健康视图：单项失败不拖垮整页（逐项 allSettled，失败项显示不可用）
async function loadHealth() {
  const [healthRes, overviewRes, runtimeRes, supervisionRes, resourcesRes] = await Promise.allSettled([
    getHealth(),
    getOverview(),
    getRuntimeStatus('hermes-manager'),
    getSupervisionState(),
    getResourcesState()
  ])
  health.value = healthRes.status === 'fulfilled' && healthRes.value.ok ? await healthRes.value.json().catch(() => null) : null
  overview.value = overviewRes.status === 'fulfilled' && overviewRes.value.ok ? await overviewRes.value.json().catch(() => null) : null
  const runtimePayload = runtimeRes.status === 'fulfilled' && runtimeRes.value.ok ? await runtimeRes.value.json().catch(() => null) : null
  runtimeStatus.value = runtimePayload?.runtimeStatus || null
  supervision.value = supervisionRes.status === 'fulfilled' && supervisionRes.value.ok ? await supervisionRes.value.json().catch(() => null) : null
  resources.value = resourcesRes.status === 'fulfilled' && resourcesRes.value.ok ? await resourcesRes.value.json().catch(() => null) : null
}

// 刷新 = 重新拉取服务端状态
async function loadAll() {
  busy.value = true
  error.value = ''
  try {
    await Promise.all([loadPendingReviews(), loadAudit(), loadQueue(), loadHealth(), loadCronJobs(), loadRightBrainSupervision(), loadSkillGovernance(), loadEvidencePacks()])
  } catch (e) {
    error.value = String(e)
  } finally {
    busy.value = false
  }
}

async function loadEvidencePacks() {
  evidencePacksBusy.value = true
  evidencePacksError.value = ''
  try {
    const res = await fetch('/api/control/evidence-packs?limit=50')
    const payload = await res.json().catch(() => null)
    if (!res.ok || !payload?.ok) throw new Error(payload?.error || `http_${res.status}`)
    evidencePacks.value = Array.isArray(payload.packs) ? payload.packs : []
  } catch (e) {
    evidencePacksError.value = e instanceof Error ? e.message : String(e)
  } finally {
    evidencePacksBusy.value = false
  }
}

async function downloadEvidencePack(actionId: string) {
  try {
    const res = await fetch(`/api/control/evidence-packs/${encodeURIComponent(actionId)}`)
    const payload = await res.json().catch(() => null)
    if (!res.ok || !payload?.ok) throw new Error(payload?.error || `http_${res.status}`)
    const blob = new Blob([JSON.stringify(payload.pack, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `evidence-pack-${actionId}.json`
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
  } catch (e) {
    evidencePacksError.value = e instanceof Error ? e.message : String(e)
  }
}

// 审核动作：走受控 review API；成功显示结果，失败/阻断直接展示 API 返回的原因
async function submitReview(sessionId: string, decision: 'approve' | 'reject') {
  if (reviewBusyId.value) return
  reviewBusyId.value = sessionId
  error.value = ''
  actionMessage.value = ''
  try {
    const res = await submitReasoningSessionReview('hermes-manager', sessionId, {
      decision,
      correctionPrompt: (reviewDrafts.value[sessionId] || '').trim()
    })
    const payload = await res.json().catch(() => null)
    if (!res.ok || !payload?.ok) {
      throw new Error(payload?.detail || payload?.details || payload?.error || `http_${res.status}`)
    }
    actionMessage.value = decision === 'approve' ? '已批准，任务继续执行。' : '已拒绝，按修正意见处理。'
    reviewDrafts.value = { ...reviewDrafts.value, [sessionId]: '' }
    await loadAll()
  } catch (e) {
    error.value = String(e)
    await loadAll()
  } finally {
    reviewBusyId.value = ''
  }
}

// HERMES-H02：cron 治理动作（暂停/恢复/停用/人工触发），全部走受控 API，结果直接展示
async function runCronAction(jobId: string, action: 'pause' | 'resume' | 'disable' | 'trigger') {
  if (cronBusyId.value) return
  cronBusyId.value = jobId
  error.value = ''
  actionMessage.value = ''
  try {
    const res = action === 'trigger'
      ? await triggerCronJob(jobId)
      : await setCronJobStatus(jobId, action)
    const payload = await res.json().catch(() => null)
    if (!res.ok || !payload?.ok) {
      throw new Error(payload?.detail || payload?.error || `http_${res.status}`)
    }
    if (action === 'trigger') {
      actionMessage.value = payload.result === 'skipped_duplicate'
        ? '本周期已有未终结任务，按幂等规则跳过。'
        : `已提交受控任务：会话 ${payload.sessionId || '-'}。`
    } else {
      actionMessage.value = { pause: '定时任务已暂停。', resume: '定时任务已恢复。', disable: '定时任务已停用。' }[action]
    }
    await loadAll()
  } catch (e) {
    error.value = String(e)
    await loadAll()
  } finally {
    cronBusyId.value = ''
  }
}

const CRON_STATUS_LABELS: Record<string, string> = {
  active: '运行中',
  paused: '已暂停',
  disabled: '已停用'
}

function cronWorkflowLabel(workflow: string) {
  return cronWorkflows.value.find((entry) => entry.workflowId === workflow)?.label || workflow || '-'
}

function cronIntervalLabel(intervalMs: number) {
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) return '-'
  if (intervalMs % 3600000 === 0) return `每 ${intervalMs / 3600000} 小时`
  if (intervalMs % 60000 === 0) return `每 ${intervalMs / 60000} 分钟`
  return `每 ${Math.round(intervalMs / 1000)} 秒`
}

function cronTriggerLabel(trigger: CronTriggerRecord) {
  if (trigger.result === 'skipped_duplicate') return '跳过（同周期任务未终结）'
  return trigger.manual ? '已提交（人工触发）' : '已提交'
}

function reviewTargetLabel(item: PendingReviewItem) {  const target = REVIEW_TARGET_LABELS[item.review.targetType || ''] || item.review.targetType || '任务'
  const phase = REVIEW_PHASE_LABELS[item.review.reviewPhase || ''] || ''
  const step = item.review.stepIndex != null ? `第 ${item.review.stepIndex + 1} 步` : ''
  return [target, phase, step].filter(Boolean).join(' · ')
}

function queueStatusLabel(status: string | null) {
  if (!status) return '-'
  return QUEUE_STATUS_LABELS[status] || status
}

function auditActionLabel(record: AuditRecord) {
  const action = AUDIT_ACTION_LABELS[record.action] || record.action
  const decision = record.decision ? AUDIT_DECISION_LABELS[record.decision] || record.decision : ''
  return decision ? `${action}（${decision}）` : action
}

function formatTime(iso: string | null | undefined) {
  if (!iso) return '-'
  const d = new Date(iso)
  return isNaN(d.getTime()) ? String(iso) : `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`
}

onMounted(loadAll)
</script>

<template>
  <div class="page-governance">
    <!-- 待审核中心 -->
    <section class="page-section">
      <div class="section-header">
        <h2>待审核</h2>
        <button class="action-btn" :disabled="busy" @click="loadAll">刷新</button>
      </div>
      <p class="section-hint">等待人工确认的任务集中在此处理；批准或拒绝（可附修正意见）后立即生效，并写入审核记录与操作审计。</p>

      <div v-if="error" class="error-banner">{{ error }}</div>
      <div v-if="actionMessage" class="success-banner">{{ actionMessage }}</div>

      <div v-if="!pendingReviews.length && !busy" class="empty-state">当前没有等待审核的任务</div>
      <div v-for="item in pendingReviews" :key="item.sessionId" class="review-card">
        <div class="review-card-head">
          <div class="review-card-title">{{ item.title || item.sessionId }}</div>
          <span class="status-badge" data-status="waiting_review">等待审核</span>
        </div>
        <div class="review-card-meta">
          <span>{{ reviewTargetLabel(item) }}</span>
          <span v-if="item.review.title"> · {{ item.review.title }}</span>
        </div>
        <div v-if="item.review.summary" class="review-card-summary">{{ item.review.summary }}</div>
        <div class="review-card-ids">
          <span>会话 {{ item.sessionId }}</span>
          <span v-if="item.queueItem?.taskId"> · 任务 {{ item.queueItem.taskId }}</span>
          <span v-if="item.projectId"> · 项目 {{ item.projectId }}</span>
          <span v-if="item.queueItem?.status"> · 队列 {{ queueStatusLabel(item.queueItem.status) }}</span>
          <span> · {{ formatTime(item.updatedAt) }}</span>
        </div>
        <textarea
          v-model="reviewDrafts[item.sessionId]"
          class="review-draft"
          rows="2"
          placeholder="修正意见（可选）：拒绝时按此重新执行，批准时作为后续约束"
        ></textarea>
        <div class="review-card-actions">
          <button
            class="action-btn primary"
            :disabled="reviewBusyId !== ''"
            @click="submitReview(item.sessionId, 'approve')"
          >
            {{ reviewBusyId === item.sessionId ? '提交中...' : '批准' }}
          </button>
          <button
            class="action-btn danger"
            :disabled="reviewBusyId !== ''"
            @click="submitReview(item.sessionId, 'reject')"
          >
            拒绝
          </button>
        </div>
      </div>
    </section>

    <!-- 运行健康 -->
    <section class="page-section">
      <div class="section-header">
        <h2>运行健康</h2>
        <button class="action-btn" :disabled="busy" @click="loadAll">刷新</button>
      </div>
      <p class="section-hint">服务健康、模型与 gateway 监督、队列 worker 状态集中可视；异常项请先处理再发起生产任务。</p>

      <div class="health-grid">
        <div class="health-card">
          <div class="health-label">Control Server</div>
          <div class="health-value" :data-tone="health?.ok ? 'ok' : 'error'">{{ health?.ok ? '正常' : '不可用' }}</div>
          <div class="health-detail">{{ health?.service || '-' }} {{ health?.version || '' }}</div>
        </div>
        <div class="health-card">
          <div class="health-label">Hermes 运行时</div>
          <div class="health-value" :data-tone="runtimeStatus?.state === 'running' ? 'ok' : 'warn'">
            {{ runtimeStatus?.label || runtimeStatus?.state || '不可用' }}
          </div>
          <div class="health-detail">{{ runtimeStatus?.detail || '-' }}</div>
        </div>
        <div class="health-card">
          <div class="health-label">模型服务</div>
          <div class="health-value" :data-tone="overview?.omlx?.reachable ? 'ok' : 'error'">
            {{ overview?.omlx?.reachable ? '可访问' : '不可达' }}
          </div>
          <div class="health-detail">{{ overview?.model?.provider || '-' }} / {{ overview?.model?.name || '-' }}{{ overview?.model?.loaded ? ' · 已加载' : ' · 未加载' }}</div>
        </div>
        <div class="health-card">
          <div class="health-label">Studio 编辑器</div>
          <div class="health-value" :data-tone="overview?.studio?.reachable ? 'ok' : 'warn'">
            {{ overview?.studio?.reachable ? '可访问' : '不可达' }}
          </div>
          <div class="health-detail">{{ overview?.studio?.detail || '-' }}</div>
        </div>
        <div class="health-card">
          <div class="health-label">Gateway 监督</div>
          <div class="health-value" :data-tone="gatewaySupervision?.status === 'blocked' ? 'error' : (gatewaySupervision?.enabled ? 'ok' : 'info')">
            {{ gatewaySupervision ? (GATEWAY_STATUS_LABELS[gatewaySupervision.status] || gatewaySupervision.status) : '不可用' }}
          </div>
          <div class="health-detail">
            <template v-if="gatewaySupervision?.enabled">
              重启 {{ gatewaySupervision.restartAttempts }} / {{ gatewaySupervision.maxAttempts }} 次
              <span v-if="gatewaySupervision.blocked"> · 已阻断：{{ gatewaySupervision.blocked.reason || '-' }}</span>
              <span v-else-if="gatewaySupervision.lastRecovery"> · 最近恢复 {{ formatTime(gatewaySupervision.lastRecovery.at) }}</span>
            </template>
            <template v-else>进程异常退出监测未启用</template>
          </div>
        </div>
        <div class="health-card">
          <div class="health-label">任务队列</div>
          <div class="health-value" :data-tone="queueSummary.failed > 0 || queueSummary.blocked > 0 ? 'warn' : 'ok'">
            {{ queueSummary.active > 0 ? `${queueSummary.active} 个进行中` : '空闲' }}
          </div>
          <div class="health-detail">
            重试等待 {{ queueSummary.retryWait }} · 待审核 {{ queueSummary.waitingReview }} · 已阻断 {{ queueSummary.blocked }} · 已失败 {{ queueSummary.failed }}
          </div>
        </div>
        <div class="health-card">
          <div class="health-label">资源互斥</div>
          <div class="health-value" :data-tone="resourceSlot.tone">{{ resourceSlot.label }}</div>
          <div class="health-detail">
            <template v-if="resources && resources.enabled !== false">
              <div>{{ resourceModelText }}</div>
              <div>{{ resourceMemoryText }}</div>
              <div v-if="resources?.blocked" class="resource-blocked">阻断原因：{{ resources.blocked.detail || resources.blocked.reason || '-' }}</div>
              <div v-else-if="resources?.gpuHolder">出图持有者：{{ resources.gpuHolder.holder }}</div>
              <div v-else-if="(resources?.llmWaiters || 0) > 0">等待出图释放的文本任务：{{ resources.llmWaiters }} 个</div>
            </template>
            <template v-else>互斥调度未启用</template>
          </div>
          <div v-if="resourceRecentSwaps.length" class="resource-swap-list">
            <div v-for="(swap, index) in resourceRecentSwaps" :key="index" class="resource-swap-item" :data-ok="swap.ok ? 'true' : 'false'">
              <span class="time-cell">{{ formatTime(swap.at) }}</span>
              <span> · {{ swap.label }}</span>
              <span> · 耗时 {{ swap.cost }}</span>
              <span v-if="!swap.ok"> · 失败：{{ swap.detail || '-' }}</span>
            </div>
          </div>
        </div>
      </div>

      <div v-if="overview?.alerts?.length" class="alert-list">
        <div v-for="(alert, index) in overview.alerts" :key="index" class="alert-item" :data-level="alert.level">
          {{ alert.message }}
        </div>
      </div>
    </section>

    <!-- 定时任务（HERMES-H02：cron 受控生产触发） -->
    <section class="page-section">
      <div class="section-header">
        <h2>定时任务</h2>
        <button class="action-btn" :disabled="busy" @click="loadAll">刷新</button>
      </div>
      <p class="section-hint">
        cron 定时生产任务只能提交已注册工作流的受控任务，每次触发都会创建可追溯的会话与队列任务（不匿名调用模型、不直接写项目目录）。
        暂停/恢复/停用立即生效并写入操作审计；「立即触发」与到点触发走同一条受控链路与幂等规则。
      </p>

      <div class="cron-scheduler" :data-running="cronScheduler?.running ? 'true' : 'false'">
        调度器：{{ cronScheduler?.running ? `运行中（每 ${Math.round(cronScheduler.tickMs / 1000)} 秒检查到点任务）` : '未运行' }}
      </div>

      <div v-if="!cronJobs.length && !busy" class="empty-state">当前没有已注册的定时任务</div>
      <div v-for="job in cronJobs" :key="job.jobId" class="cron-card">
        <div class="cron-card-head">
          <div class="cron-card-title">{{ job.name }}</div>
          <span class="status-badge" :data-status="job.status">{{ CRON_STATUS_LABELS[job.status] || job.status }}</span>
        </div>
        <div class="cron-card-meta">
          <span>工作流 {{ cronWorkflowLabel(job.workflow) }}</span>
          <span> · {{ cronIntervalLabel(job.intervalMs) }}</span>
          <span> · 审核模式 {{ job.reviewMode }}</span>
        </div>
        <div class="cron-card-prompt">{{ job.prompt }}</div>
        <div class="cron-card-ids">
          <span>任务编号 {{ job.jobId }}</span>
          <span v-if="job.lastTriggeredAt"> · 最近触发 {{ formatTime(job.lastTriggeredAt) }}</span>
          <span v-if="job.status === 'active' && job.nextTriggerAt"> · 下次触发 {{ formatTime(job.nextTriggerAt) }}</span>
        </div>
        <div class="cron-card-actions">
          <button
            v-if="job.status === 'active'"
            class="action-btn"
            :disabled="cronBusyId !== ''"
            @click="runCronAction(job.jobId, 'pause')"
          >
            暂停
          </button>
          <button
            v-if="job.status === 'paused'"
            class="action-btn primary"
            :disabled="cronBusyId !== ''"
            @click="runCronAction(job.jobId, 'resume')"
          >
            恢复
          </button>
          <button
            v-if="job.status !== 'disabled'"
            class="action-btn danger"
            :disabled="cronBusyId !== ''"
            @click="runCronAction(job.jobId, 'disable')"
          >
            停用
          </button>
          <button
            v-if="job.status === 'active'"
            class="action-btn"
            :disabled="cronBusyId !== ''"
            @click="runCronAction(job.jobId, 'trigger')"
          >
            {{ cronBusyId === job.jobId ? '提交中...' : '立即触发' }}
          </button>
        </div>
        <div v-if="job.recentTriggers.length" class="cron-trigger-list">
          <div v-for="(trigger, index) in job.recentTriggers.slice(0, 5)" :key="index" class="cron-trigger-item">
            <span class="time-cell">{{ formatTime(trigger.triggeredAt) }}</span>
            <span> · {{ cronTriggerLabel(trigger) }}</span>
            <template v-if="trigger.sessionId">
              <span> · 会话 </span>
              <router-link class="cron-session-link" to="/sessions">{{ trigger.sessionId }}</router-link>
            </template>
            <span v-if="trigger.taskId"> · 任务 {{ trigger.taskId }}</span>
          </div>
        </div>
      </div>
    </section>

    <!-- 右脑监察（HERMES-H03：右脑子 agent 受控监察） -->
    <section class="page-section">
      <div class="section-header">
        <h2>右脑监察</h2>
        <div class="section-header-actions">
          <button class="action-btn primary" :disabled="busy || supervisionBusy" @click="triggerRightBrainSupervision">
            {{ supervisionBusy ? '监察中...' : '执行监察' }}
          </button>
          <button class="action-btn" :disabled="busy" @click="loadAll">刷新</button>
        </div>
      </div>
      <p class="section-hint">
        右脑子 agent（{{ rightBrain.supervisor?.supervisorId || 'hermes-right-brain-supervisor' }}）只读取任务健康、失败证据与治理日志并给出带依据的建议；
        只能调用白名单内的只读动作，受控建议（{{ (rightBrain.supervisor?.controlledActions || []).map((a) => a.title).join(' / ') || '重试失败任务 / 取消任务' }}）必须人工批准后才会经既有受控 API 执行，越权建议会被拒绝并记入操作审计。
      </p>

      <div class="cron-scheduler" :data-running="rightBrain.supervisor?.model?.available ? 'true' : 'false'">
        右脑模型：{{ rightBrain.supervisor?.model?.available
          ? `${rightBrain.supervisor?.model?.provider || '-'} / ${rightBrain.supervisor?.model?.model || '-'}`
          : `不可用（${rightBrain.supervisor?.model?.unavailableReason || '未配置或密钥失效'}）` }}
      </div>

      <div v-if="!rightBrain.runs.length && !busy" class="empty-state">暂无监察记录，点击「执行监察」发起一次</div>
      <div v-for="run in rightBrain.runs" :key="run.runId" class="cron-card">
        <div class="cron-card-head">
          <div class="cron-card-title">
            {{ formatTime(run.ts) }} · {{ run.model?.provider || '-' }} / {{ run.model?.model || '-' }}
          </div>
          <span class="status-badge" :data-status="run.status === 'completed' ? 'active' : 'disabled'">
            {{ SUPERVISION_RUN_STATUS_LABELS[run.status] || run.status }}
          </span>
        </div>
        <div class="cron-card-ids">
          <span>监察编号 {{ run.runId }}</span>
          <span v-if="run.focusSessionId"> · 重点会话 {{ run.focusSessionId }}</span>
          <span v-if="run.error"> · {{ run.error }}</span>
        </div>
        <div v-if="run.outputSummary" class="cron-card-prompt">{{ run.outputSummary }}</div>
        <div v-if="run.findings.length" class="supervision-finding-list">
          <div v-for="(finding, index) in run.findings" :key="index" class="supervision-finding" :data-severity="finding.severity">
            <span class="supervision-finding-title">{{ finding.title }}</span>
            <span v-if="finding.detail"> · {{ finding.detail }}</span>
          </div>
        </div>
        <div v-if="run.suggestions.length" class="supervision-suggestion-list">
          <div v-for="suggestion in run.suggestions" :key="suggestion.suggestionId" class="supervision-suggestion">
            <div class="supervision-suggestion-head">
              <span class="supervision-finding-title">{{ suggestionActionLabel(suggestion) }}</span>
              <span class="status-badge" :data-status="suggestion.status === 'pending_review' ? 'paused' : (suggestion.status === 'rejected' || suggestion.status === 'rejected_by_human' || suggestion.status === 'approved_blocked' ? 'disabled' : 'active')">
                {{ SUGGESTION_STATUS_LABELS[suggestion.status] || suggestion.status }}
              </span>
            </div>
            <div class="cron-card-meta">
              <span v-if="suggestion.params?.sessionId">目标会话 {{ suggestion.params.sessionId }}</span>
              <span v-if="suggestion.rejectReason"> · 拒绝原因 {{ suggestion.rejectReason }}</span>
              <span v-if="suggestion.executionDetail"> · {{ suggestion.executionDetail }}</span>
            </div>
            <div v-if="suggestion.rationale" class="cron-card-prompt">{{ suggestion.rationale }}</div>
            <div v-if="suggestion.evidenceRefs.length" class="cron-card-ids">
              依据：{{ suggestion.evidenceRefs.join('、') }}
            </div>
            <div v-if="suggestion.status === 'pending_review'" class="cron-card-actions">
              <button
                class="action-btn primary"
                :disabled="suggestionBusyId !== ''"
                @click="reviewSupervisionSuggestion(run.runId, suggestion.suggestionId, 'approve')"
              >
                批准并执行
              </button>
              <button
                class="action-btn danger"
                :disabled="suggestionBusyId !== ''"
                @click="reviewSupervisionSuggestion(run.runId, suggestion.suggestionId, 'reject')"
              >
                驳回
              </button>
            </div>
          </div>
        </div>
      </div>
    </section>

    <!-- 技能学习（学习循环治理桥：agent 自创技能经人工审核后才进入注入清单） -->
    <section class="page-section">
      <div class="section-header">
        <h2>技能学习</h2>
        <button class="action-btn" :disabled="busy" @click="loadAll">刷新</button>
      </div>
      <p class="section-hint">
        Hermes 在任务中自创或修改的技能只会先成为候选，不会自动生效；人工查看内容并「通过」后才会复制到可信技能目录并加入注入清单（下次任务生效），「拒绝」则留档不生效。
        当前捆绑技能 {{ skillBundledPristine }} 个保持原样，不进入候选。扫描目录：{{ skillScanRoot || '-' }}
      </p>

      <div v-if="!skillCandidates.length && !busy" class="empty-state">当前没有待审核的学习技能</div>
      <div v-for="skill in skillCandidates" :key="skill.name" class="cron-card">
        <div class="cron-card-head">
          <div class="cron-card-title">{{ skill.name }}</div>
          <span class="status-badge" data-status="paused">待审核</span>
        </div>
        <div class="cron-card-meta">
          <span>类别 {{ skill.category || '未分类' }}</span>
          <span> · 来源 {{ SKILL_ORIGIN_LABELS[skill.origin] || skill.origin }}</span>
        </div>
        <div v-if="skill.description" class="cron-card-prompt">{{ skill.description }}</div>
        <div class="cron-card-ids">
          <span>目录 {{ skill.sourceDir }}</span>
          <span> · 内容指纹 {{ skill.contentHash.slice(0, 10) }}</span>
        </div>
        <div>
          <button class="action-btn" @click="toggleSkillContent(skill.name)">
            {{ skillContents[skill.name] ? '收起内容' : '查看内容' }}
          </button>
        </div>
        <div v-if="skillContents[skill.name] === 'loading'" class="cron-card-meta">内容加载中...</div>
        <div v-else-if="skillContents[skill.name]" class="skill-content">
          <div class="cron-card-ids">文件：{{ (skillContents[skill.name] as SkillContentPayload).files.join('、') || 'SKILL.md' }}</div>
          <pre class="skill-content-pre">{{ (skillContents[skill.name] as SkillContentPayload).content }}</pre>
          <div v-if="(skillContents[skill.name] as SkillContentPayload).truncated" class="cron-card-meta">内容过长，已截断展示</div>
        </div>
        <textarea
          v-model="skillNoteDrafts[skill.name]"
          class="review-draft"
          rows="2"
          placeholder="审核附注（可选）：写入治理记录与操作审计"
        ></textarea>
        <div class="cron-card-actions">
          <button
            class="action-btn primary"
            :disabled="skillBusyId !== ''"
            @click="reviewSkill(skill.name, 'approve')"
          >
            {{ skillBusyId === skill.name ? '提交中...' : '通过并激活' }}
          </button>
          <button
            class="action-btn danger"
            :disabled="skillBusyId !== ''"
            @click="reviewSkill(skill.name, 'reject')"
          >
            拒绝
          </button>
        </div>
      </div>

      <template v-if="activeSkills.length || skillAvailableFiles.length">
        <h3 class="skill-subtitle">已激活技能（注入清单 {{ skillAvailableFiles.length }} 个文件）</h3>
        <div v-for="skill in activeSkills" :key="skill.name" class="cron-card">
          <div class="cron-card-head">
            <div class="cron-card-title">{{ skill.name }}</div>
            <span class="status-badge" :data-status="skill.injected && skill.activatedExists ? 'active' : 'disabled'">
              {{ skill.injected && skill.activatedExists ? '生效中' : '清单异常' }}
            </span>
          </div>
          <div class="cron-card-meta">
            <span>类别 {{ skill.category || '未分类' }}</span>
            <span> · 通过时间 {{ formatTime(skill.decidedAt) }}</span>
            <span v-if="skill.actor"> · 审核人 {{ skill.actor }}</span>
          </div>
          <div v-if="skill.note" class="cron-card-prompt">附注：{{ skill.note }}</div>
          <div class="cron-card-ids">
            <span>{{ skill.activatedSkillFile || '-' }}</span>
          </div>
        </div>
      </template>

      <template v-if="skillDecided.length">
        <h3 class="skill-subtitle">已处理记录</h3>
        <div v-for="skill in skillDecided" :key="skill.name" class="cron-card">
          <div class="cron-card-head">
            <div class="cron-card-title">{{ skill.name }}</div>
            <span class="status-badge" :data-status="skill.status === 'approved' ? 'active' : 'disabled'">
              {{ SKILL_STATUS_LABELS[skill.status] || skill.status }}
            </span>
          </div>
          <div class="cron-card-meta">
            <span>类别 {{ skill.category || '未分类' }}</span>
            <span> · 来源 {{ SKILL_ORIGIN_LABELS[skill.origin] || skill.origin }}</span>
            <span> · {{ formatTime(skill.decidedAt) }}</span>
            <span v-if="skill.actor"> · 审核人 {{ skill.actor }}</span>
          </div>
          <div v-if="skill.note" class="cron-card-prompt">附注：{{ skill.note }}</div>
          <div class="cron-card-ids">
            <span v-if="skill.sourceMissing">源目录已移除（记录留档）</span>
            <span v-else-if="skill.sourceChangedAfterDecision">源目录在审核后又有改动；已激活副本保持审核时内容，不会自动同步</span>
            <span v-else>目录 {{ skill.sourceDir }}</span>
          </div>
        </div>
      </template>
    </section>

    <!-- 历史检索：只读直查 Hermes state.db FTS5，不经过网关推理 -->
    <section class="page-section">
      <div class="section-header">
        <h2>历史检索</h2>
      </div>
      <p class="section-hint">
        在 Hermes 全部历史会话中检索关键词（与 agent 的 session_search 工具同一数据源，只读零推理成本）。
        输入关键词后显示命中会话与时间，点击命中项可展开消息摘要。
      </p>
      <div class="session-search-bar">
        <input
          v-model="sessionSearchQuery"
          class="session-search-input"
          type="text"
          placeholder="检索关键词，例如：狼来了"
          @keyup.enter="runSessionSearch"
        />
        <button class="action-btn primary" :disabled="sessionSearchBusy || !sessionSearchQuery.trim()" @click="runSessionSearch">
          {{ sessionSearchBusy ? '检索中...' : '检索' }}
        </button>
      </div>
      <div v-if="sessionSearchSearched && !sessionSearchHits.length && !sessionSearchBusy" class="empty-state">没有命中的历史会话</div>
      <div v-for="hit in sessionSearchHits" :key="hit.messageId" class="cron-card">
        <div class="cron-card-head">
          <div class="cron-card-title mono-cell">{{ hit.sessionId }}</div>
          <span class="status-badge" data-status="active">{{ hit.role }}</span>
        </div>
        <div class="cron-card-meta">
          <span>{{ formatTime(hit.timestamp) }}</span>
          <span v-if="hit.source"> · 来源 {{ hit.source }}</span>
          <span v-if="hit.toolName"> · 工具 {{ hit.toolName }}</span>
        </div>
        <div class="cron-card-prompt">{{ hit.snippet }}</div>
        <div>
          <button class="action-btn" @click="toggleSessionSearchHit(hit.messageId)">
            {{ sessionSearchExpanded[hit.messageId] ? '收起摘要' : '展开摘要' }}
          </button>
        </div>
        <div v-if="sessionSearchExpanded[hit.messageId]" class="skill-content">
          <pre class="skill-content-pre">{{ hit.contentPreview }}</pre>
        </div>
      </div>
    </section>

    <!-- 操作审计 -->
    <section class="page-section">
      <div class="section-header">
        <h2>操作审计</h2>
        <button class="action-btn" :disabled="busy" @click="loadAll">刷新</button>
      </div>
      <p class="section-hint">取消、恢复、重试与审核动作的执行记录（最近 100 条），可按会话与任务编号追溯。</p>

      <div class="audit-table-wrap">
        <table class="audit-table">
          <thead>
            <tr>
              <th>时间</th>
              <th>动作</th>
              <th>结果</th>
              <th>会话</th>
              <th>任务</th>
              <th>说明</th>
            </tr>
          </thead>
          <tbody>
            <tr v-if="!auditRecords.length && !busy">
              <td colspan="6" class="empty-cell">暂无治理操作记录</td>
            </tr>
            <tr v-for="(record, index) in auditRecords" :key="index">
              <td class="time-cell">{{ formatTime(record.ts) }}</td>
              <td>{{ auditActionLabel(record) }}</td>
              <td><span class="result-badge" :data-ok="record.result === 'ok'">{{ record.result === 'ok' ? '成功' : '阻断' }}</span></td>
              <td class="mono-cell muted">{{ record.sessionId || '-' }}</td>
              <td class="mono-cell muted">{{ record.taskId || '-' }}</td>
              <td class="reason-cell">{{ record.detail || '-' }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>

    <!-- 动作证据包 -->
    <section class="page-section">
      <div class="section-header">
        <h2>动作证据包</h2>
        <button class="action-btn" :disabled="busy" @click="loadEvidencePacks">刷新</button>
      </div>
      <p class="section-hint">项目动作的完整执行证据包，包含输入、输出、审核记录、状态转移与 traceId，可用于回溯与导出。</p>

      <div v-if="evidencePacksError" class="error-banner">{{ evidencePacksError }}</div>

      <div class="audit-table-wrap">
        <table class="audit-table">
          <thead>
            <tr>
              <th>生成时间</th>
              <th>动作 ID</th>
              <th>能力</th>
              <th>状态</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-if="!evidencePacks.length && !evidencePacksBusy">
              <td colspan="5" class="empty-cell">暂无证据包</td>
            </tr>
            <tr v-for="pack in evidencePacks" :key="pack.actionId">
              <td class="time-cell">{{ formatTime(pack.generatedAt) }}</td>
              <td class="mono-cell muted">{{ pack.actionId }}</td>
              <td>{{ pack.capabilityId || '-' }}</td>
              <td><span class="result-badge" :data-ok="pack.state === 'completed'">{{ pack.state || '-' }}</span></td>
              <td>
                <button class="action-btn small" @click="downloadEvidencePack(pack.actionId)">下载</button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>
  </div>
</template>

<style scoped>
.page-governance {
  display: flex;
  flex-direction: column;
  gap: 24px;
}

.page-section h2 {
  margin: 0;
  font-size: 18px;
  color: var(--c-text-inv);
}

.section-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 6px;
}

.section-hint {
  margin: 0 0 14px;
  color: var(--c-text-sub);
  font-size: 13px;
}

.error-banner {
  margin-bottom: 14px;
  padding: 10px 12px;
  border-radius: 8px;
  background: rgba(255, 107, 107, 0.14);
  border: 1px solid rgba(255, 107, 107, 0.28);
  color: var(--c-error);
  font-size: 13px;
}

.success-banner {
  margin-bottom: 14px;
  padding: 10px 12px;
  border-radius: 8px;
  background: rgba(77, 214, 140, 0.12);
  border: 1px solid rgba(77, 214, 140, 0.28);
  color: var(--c-success);
  font-size: 13px;
}

.empty-state {
  padding: 28px;
  text-align: center;
  color: var(--c-text-muted);
  border: 1px solid var(--c-border);
  border-radius: 10px;
  background: var(--c-bg-panel);
}

.review-card {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 14px 16px;
  border-radius: 10px;
  border: 1px solid var(--c-border);
  background: var(--c-bg-panel);
  margin-bottom: 12px;
}

.review-card-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.review-card-title {
  font-weight: 700;
  color: var(--c-text-inv);
}

.review-card-meta {
  font-size: 13px;
  color: var(--c-text);
}

.review-card-summary {
  font-size: 12px;
  color: var(--c-text-sub);
  line-height: 1.5;
  word-break: break-all;
}

.review-card-ids {
  font-size: 11px;
  color: var(--c-text-muted);
  font-family: SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  word-break: break-all;
}

.review-draft {
  width: 100%;
  padding: 8px 10px;
  border-radius: 8px;
  border: 1px solid var(--c-border-mid);
  background: var(--c-bg-input);
  color: var(--c-text);
  font: inherit;
  font-size: 13px;
  resize: vertical;
}

.session-search-bar {
  display: flex;
  gap: 10px;
  align-items: center;
}

.session-search-input {
  flex: 1;
  padding: 8px 10px;
  border-radius: 8px;
  border: 1px solid var(--c-border-mid);
  background: var(--c-bg-input);
  color: var(--c-text);
  font: inherit;
  font-size: 13px;
}

.review-card-actions {
  display: flex;
  gap: 10px;
}

.health-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: 12px;
}

.health-card {
  padding: 14px;
  border-radius: 10px;
  background: var(--c-bg-panel);
  border: 1px solid var(--c-border);
}

.health-label {
  font-size: 12px;
  color: var(--c-text-muted);
  margin-bottom: 6px;
}

.health-value {
  font-size: 16px;
  font-weight: 700;
  color: var(--c-text);
}

.health-value[data-tone='ok'] { color: var(--c-success); }
.health-value[data-tone='warn'] { color: var(--c-warn); }
.health-value[data-tone='error'] { color: var(--c-error); }

.health-detail {
  margin-top: 6px;
  font-size: 12px;
  color: var(--c-text-sub);
  line-height: 1.5;
  word-break: break-all;
}

.resource-blocked {
  color: var(--c-error);
}

.resource-swap-list {
  margin-top: 8px;
  padding-top: 8px;
  border-top: 1px dashed var(--c-border);
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.resource-swap-item {
  font-size: 12px;
  color: var(--c-text-sub);
  line-height: 1.5;
  word-break: break-all;
}

.resource-swap-item[data-ok='false'] {
  color: var(--c-error);
}

.alert-list {
  margin-top: 14px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.alert-item {
  padding: 10px 12px;
  border-radius: 8px;
  font-size: 13px;
  background: rgba(246, 201, 78, 0.1);
  border: 1px solid rgba(246, 201, 78, 0.26);
  color: var(--c-warn);
}

.alert-item[data-level='critical'] {
  background: rgba(255, 107, 107, 0.12);
  border-color: rgba(255, 107, 107, 0.3);
  color: var(--c-error);
}

.audit-table-wrap {
  overflow-x: auto;
  border-radius: 10px;
  border: 1px solid var(--c-border);
  background: var(--c-bg-panel);
}

.audit-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
}

.audit-table th,
.audit-table td {
  padding: 10px 12px;
  text-align: left;
  border-bottom: 1px solid var(--c-border);
  vertical-align: top;
}

.audit-table th {
  color: var(--c-text-sub);
  font-weight: 700;
  background: rgba(255, 255, 255, 0.03);
}

.empty-cell {
  text-align: center;
  color: var(--c-text-muted);
  padding: 28px;
}

.status-badge {
  display: inline-block;
  padding: 3px 8px;
  border-radius: 999px;
  font-size: 11px;
  font-weight: 700;
  background: rgba(246, 201, 78, 0.16);
  color: var(--c-warn);
}

.status-badge[data-status='active'] {
  background: rgba(77, 214, 140, 0.16);
  color: var(--c-success);
}

.status-badge[data-status='disabled'] {
  background: rgba(148, 163, 184, 0.16);
  color: var(--c-text-muted);
}

.cron-scheduler {
  margin-bottom: 14px;
  font-size: 12px;
  color: var(--c-text-sub);
}

.cron-scheduler[data-running='false'] {
  color: var(--c-warn);
}

.cron-card {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 14px 16px;
  border-radius: 10px;
  border: 1px solid var(--c-border);
  background: var(--c-bg-panel);
  margin-bottom: 12px;
}

.cron-card-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.cron-card-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--c-text-inv);
}

.cron-card-meta {
  font-size: 12px;
  color: var(--c-text-sub);
}

.cron-card-prompt {
  font-size: 12px;
  color: var(--c-text-muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.cron-card-ids {
  font-size: 11px;
  color: var(--c-text-muted);
  font-family: SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  word-break: break-all;
}

.cron-card-actions {
  display: flex;
  gap: 8px;
}

.cron-trigger-list {
  border-top: 1px dashed var(--c-border);
  padding-top: 8px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.cron-trigger-item {
  font-size: 11px;
  color: var(--c-text-sub);
  word-break: break-all;
}

.cron-session-link {
  color: var(--c-accent, #5eccff);
  font-family: SFMono-Regular, Menlo, Monaco, Consolas, monospace;
}

.result-badge {
  display: inline-block;
  padding: 3px 8px;
  border-radius: 6px;
  font-size: 11px;
  font-weight: 700;
  background: rgba(255, 107, 107, 0.16);
  color: var(--c-error);
}

.result-badge[data-ok='true'] {
  background: rgba(77, 214, 140, 0.16);
  color: var(--c-success);
}

.time-cell {
  color: var(--c-text-sub);
  white-space: nowrap;
}

.mono-cell {
  font-family: SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  font-size: 11px;
  word-break: break-all;
}

.mono-cell.muted {
  color: var(--c-text-muted);
}

.reason-cell {
  max-width: 320px;
  color: var(--c-text-sub);
  word-break: break-all;
}

.action-btn {
  padding: 8px 14px;
  border-radius: 8px;
  border: 1px solid var(--c-border-mid);
  background: rgba(255, 255, 255, 0.06);
  color: var(--c-text);
  font: inherit;
  font-size: 13px;
  cursor: pointer;
}

.action-btn:hover {
  background: rgba(255, 255, 255, 0.1);
}

.action-btn:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}

.action-btn.primary {
  background: var(--c-accent);
  color: #081018;
  border-color: transparent;
}

.action-btn.danger {
  background: rgba(255, 107, 107, 0.18);
  border-color: rgba(255, 107, 107, 0.34);
  color: var(--c-error);
}

.section-header-actions {
  display: flex;
  gap: 8px;
}

.supervision-finding-list {
  border-top: 1px dashed var(--c-border);
  padding-top: 8px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.supervision-finding {
  font-size: 12px;
  color: var(--c-text-sub);
  word-break: break-all;
}

.supervision-finding[data-severity='critical'] {
  color: var(--c-error);
}

.supervision-finding[data-severity='warning'] {
  color: var(--c-warn);
}

.supervision-finding-title {
  font-weight: 600;
  color: var(--c-text-inv);
}

.supervision-suggestion-list {
  border-top: 1px dashed var(--c-border);
  padding-top: 8px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.supervision-suggestion {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 10px 12px;
  border-radius: 8px;
  border: 1px solid var(--c-border);
  background: rgba(255, 255, 255, 0.03);
}

.supervision-suggestion-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.skill-subtitle {
  margin: 18px 0 4px;
  font-size: 14px;
  color: var(--c-text-inv);
}

.skill-content {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.skill-content-pre {
  margin: 0;
  padding: 10px 12px;
  border-radius: 8px;
  border: 1px solid var(--c-border);
  background: rgba(0, 0, 0, 0.28);
  color: var(--c-text);
  font-size: 12px;
  line-height: 1.5;
  max-height: 320px;
  overflow: auto;
  white-space: pre-wrap;
  word-break: break-all;
}
</style>
