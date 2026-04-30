export const MEMORY_LIFECYCLE_STATES = Object.freeze({
  EPHEMERAL: 'ephemeral',
  AWAKE: 'awake',
  SLEEPING: 'sleeping',
  ARCHIVED: 'archived',
  DELETED: 'deleted'
})

export const MEMORY_RECORD_KINDS = Object.freeze({
  CHAT_TURN: 'chat_turn',
  CONTEXT_POOL: 'context_pool',
  REASONING_SESSION: 'reasoning_session',
  DAILY_LOG: 'daily_log',
  PROJECT_MEMORY: 'project_memory',
  DECISION: 'decision',
  TASK_QUEUE: 'task_queue',
  LONG_TASK: 'long_task',
  STATUS: 'status'
})

const DAY_MS = 24 * 60 * 60 * 1000

const DEFAULT_RETENTION_DAYS = Object.freeze({
  [MEMORY_RECORD_KINDS.CHAT_TURN]: 7,
  [MEMORY_RECORD_KINDS.CONTEXT_POOL]: 30,
  [MEMORY_RECORD_KINDS.REASONING_SESSION]: 7,
  [MEMORY_RECORD_KINDS.DAILY_LOG]: 7,
  [MEMORY_RECORD_KINDS.PROJECT_MEMORY]: null,
  [MEMORY_RECORD_KINDS.DECISION]: null,
  [MEMORY_RECORD_KINDS.TASK_QUEUE]: null,
  [MEMORY_RECORD_KINDS.LONG_TASK]: null,
  [MEMORY_RECORD_KINDS.STATUS]: null
})

const DEFAULT_ARCHIVE_DAYS = Object.freeze({
  [MEMORY_RECORD_KINDS.CHAT_TURN]: 30,
  [MEMORY_RECORD_KINDS.CONTEXT_POOL]: 90,
  [MEMORY_RECORD_KINDS.REASONING_SESSION]: 30,
  [MEMORY_RECORD_KINDS.DAILY_LOG]: 30
})

export function createMemoryLifecycleMetadata({
  kind,
  state,
  importance = 0,
  confidence = 0,
  createdAt = new Date().toISOString(),
  updatedAt = createdAt,
  wakePatterns = [],
  relatedFiles = [],
  relatedCaseIds = [],
  relatedSessionIds = [],
  source = 'control-server'
} = {}) {
  const normalizedKind = String(kind || MEMORY_RECORD_KINDS.CONTEXT_POOL).trim()
  const retentionDays = DEFAULT_RETENTION_DAYS[normalizedKind]
  const archiveDays = DEFAULT_ARCHIVE_DAYS[normalizedKind]
  const createdTime = Date.parse(createdAt)
  const validCreatedTime = Number.isFinite(createdTime) ? createdTime : Date.now()

  return {
    state: state || inferDefaultLifecycleState(normalizedKind),
    kind: normalizedKind,
    importance: clampScore(importance),
    confidence: clampScore(confidence),
    source,
    createdAt: new Date(validCreatedTime).toISOString(),
    updatedAt,
    lastAccessedAt: null,
    expiresAt: retentionDays == null ? null : new Date(validCreatedTime + retentionDays * DAY_MS).toISOString(),
    staleAfter: archiveDays == null ? null : new Date(validCreatedTime + archiveDays * DAY_MS).toISOString(),
    wakePatterns: normalizeStringArray(wakePatterns),
    relatedFiles: normalizeStringArray(relatedFiles),
    relatedCaseIds: normalizeStringArray(relatedCaseIds),
    relatedSessionIds: normalizeStringArray(relatedSessionIds),
    supersedes: [],
    supersededBy: null,
    deleteReason: null
  }
}

export function inferDefaultLifecycleState(kind) {
  if (kind === MEMORY_RECORD_KINDS.PROJECT_MEMORY) return MEMORY_LIFECYCLE_STATES.AWAKE
  if (kind === MEMORY_RECORD_KINDS.DECISION) return MEMORY_LIFECYCLE_STATES.AWAKE
  if (kind === MEMORY_RECORD_KINDS.STATUS) return MEMORY_LIFECYCLE_STATES.AWAKE
  if (kind === MEMORY_RECORD_KINDS.TASK_QUEUE) return MEMORY_LIFECYCLE_STATES.AWAKE
  if (kind === MEMORY_RECORD_KINDS.LONG_TASK) return MEMORY_LIFECYCLE_STATES.AWAKE
  if (kind === MEMORY_RECORD_KINDS.REASONING_SESSION) return MEMORY_LIFECYCLE_STATES.EPHEMERAL
  return MEMORY_LIFECYCLE_STATES.SLEEPING
}

export function shouldWakeMemoryRecord(record, requestDecision, userPrompt) {
  const lifecycle = record?.lifecycle || {}
  if (lifecycle.state === MEMORY_LIFECYCLE_STATES.DELETED) return false
  if (lifecycle.state === MEMORY_LIFECYCLE_STATES.ARCHIVED) return false

  const type = String(requestDecision?.type || '').trim()
  const prompt = String(userPrompt || '').toLowerCase()
  const kind = String(lifecycle.kind || '').trim()

  if (lifecycle.state === MEMORY_LIFECYCLE_STATES.AWAKE) {
    return shouldUseAwakeKindForRequest(kind, type)
  }

  const directTerms = [
    ...normalizeStringArray(lifecycle.relatedFiles),
    ...normalizeStringArray(lifecycle.relatedCaseIds),
    ...normalizeStringArray(lifecycle.relatedSessionIds),
    ...normalizeStringArray(lifecycle.wakePatterns)
  ]
  return directTerms.some((term) => prompt.includes(term.toLowerCase()))
}

export function evaluateMemoryLifecycle(record, now = new Date()) {
  const lifecycle = record?.lifecycle || {}
  const state = String(lifecycle.state || '').trim() || inferDefaultLifecycleState(lifecycle.kind)
  if (state === MEMORY_LIFECYCLE_STATES.DELETED) return { state, reason: lifecycle.deleteReason || 'already_deleted' }
  if (state === MEMORY_LIFECYCLE_STATES.AWAKE && isDeepMemoryKind(lifecycle.kind)) return { state, reason: 'deep_memory_awake' }
  if (lifecycle.supersededBy) return { state: MEMORY_LIFECYCLE_STATES.ARCHIVED, reason: 'superseded' }

  const nowMs = now instanceof Date ? now.getTime() : Date.parse(String(now))
  const expiresAtMs = lifecycle.expiresAt ? Date.parse(lifecycle.expiresAt) : null
  const staleAfterMs = lifecycle.staleAfter ? Date.parse(lifecycle.staleAfter) : null

  if (Number.isFinite(staleAfterMs) && nowMs >= staleAfterMs) {
    return { state: MEMORY_LIFECYCLE_STATES.ARCHIVED, reason: 'stale_after_elapsed' }
  }
  if (Number.isFinite(expiresAtMs) && nowMs >= expiresAtMs) {
    return { state: MEMORY_LIFECYCLE_STATES.SLEEPING, reason: 'retention_elapsed' }
  }
  return { state, reason: 'within_retention' }
}

function shouldUseAwakeKindForRequest(kind, requestType) {
  if (requestType === 'project_listing' || requestType === 'directory_listing') return false
  if (requestType === 'capability_status_inspection') {
    return kind === MEMORY_RECORD_KINDS.PROJECT_MEMORY
      || kind === MEMORY_RECORD_KINDS.DECISION
      || kind === MEMORY_RECORD_KINDS.LONG_TASK
      || kind === MEMORY_RECORD_KINDS.STATUS
  }
  if (requestType === 'story_workflow_execute') {
    return kind === MEMORY_RECORD_KINDS.LONG_TASK
      || kind === MEMORY_RECORD_KINDS.STATUS
      || kind === MEMORY_RECORD_KINDS.DECISION
  }
  if (requestType === 'write_or_invoke_review') return kind === MEMORY_RECORD_KINDS.DECISION
  if (requestType === 'answer_only') return kind === MEMORY_RECORD_KINDS.PROJECT_MEMORY
  return true
}

function isDeepMemoryKind(kind) {
  return kind === MEMORY_RECORD_KINDS.PROJECT_MEMORY
    || kind === MEMORY_RECORD_KINDS.DECISION
    || kind === MEMORY_RECORD_KINDS.STATUS
    || kind === MEMORY_RECORD_KINDS.TASK_QUEUE
    || kind === MEMORY_RECORD_KINDS.LONG_TASK
}

function clampScore(value) {
  const number = Number(value)
  if (!Number.isFinite(number)) return 0
  return Math.max(0, Math.min(100, number))
}

function normalizeStringArray(value) {
  return Array.isArray(value)
    ? value.map((item) => String(item || '').trim()).filter(Boolean)
    : []
}