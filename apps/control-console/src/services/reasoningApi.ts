export function getReasoningCapabilities(agentId = 'hermes-manager') {
  return fetch(`/api/control/agents/${agentId}/agent-runtime`)
}

export function listReasoningSessions(agentId = 'hermes-manager', params: { limit?: number; includeTerminal?: boolean } = {}) {
  const search = new URLSearchParams()
  if (params.limit != null) search.set('limit', String(params.limit))
  if (params.includeTerminal != null) search.set('includeTerminal', String(params.includeTerminal))
  return fetch(`/api/control/agents/${agentId}/reasoning-sessions?${search.toString()}`)
}

export function createReasoningSession(agentId: string, body: unknown, timeoutMs = 30000) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error('请求超时，Control Server 或 Hermes 未响应')), timeoutMs)
  return fetch(`/api/control/agents/${agentId}/agent-runtime-sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: controller.signal
  }).finally(() => clearTimeout(timer))
}

export function getReasoningSession(agentId: string, sessionId: string) {
  return fetch(`/api/control/agents/${agentId}/agent-runtime-sessions/${sessionId}`)
}

export function getActiveProductionTestSession(agentId = 'hermes-manager') {
  return fetch(`/api/control/agents/${agentId}/production-test-session`)
}

export function cancelReasoningSessionRequest(agentId: string, sessionId: string) {
  return fetch(`/api/control/agents/${agentId}/agent-runtime-sessions/${sessionId}/cancel`, {
    method: 'POST'
  })
}

export function clearReasoningSessionRecord(agentId: string, sessionId: string) {
  return fetch(`/api/control/agents/${agentId}/agent-runtime-sessions/${sessionId}`, {
    method: 'DELETE'
  })
}

export function recoverReasoningSession(agentId: string, sessionId: string) {
  return fetch(`/api/control/agents/${agentId}/reasoning-sessions/${sessionId}/recover`, {
    method: 'POST'
  })
}

// AUTO-D01：队列/task 运维入口（只读列表与详情 + 人工重试受控动作）
export function listReasoningQueueItems() {
  return fetch('/api/control/queue/items')
}

export function getReasoningQueueItemDetail(sessionId: string) {
  return fetch(`/api/control/queue/items/${sessionId}`)
}

export function retryReasoningSession(agentId: string, sessionId: string) {
  return fetch(`/api/control/agents/${agentId}/reasoning-sessions/${sessionId}/retry`, {
    method: 'POST'
  })
}

// HERMES-H01：治理闭环——待审核中心、治理操作审计、受控审核动作
export function listPendingReviews() {
  return fetch('/api/control/reviews/pending')
}

export function listGovernanceAudit(limit = 100) {
  return fetch(`/api/control/governance/audit?limit=${limit}`)
}

export function submitReasoningSessionReview(agentId: string, sessionId: string, body: { decision: 'approve' | 'reject' | 'back'; correctionPrompt?: string }) {
  return fetch(`/api/control/agents/${agentId}/reasoning-sessions/${sessionId}/review`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  })
}

// HERMES-H02：cron 受控生产触发治理（job 列表/状态操作/人工触发）
export function listCronJobs() {
  return fetch('/api/control/cron/jobs')
}

export function setCronJobStatus(jobId: string, action: 'pause' | 'resume' | 'disable') {
  return fetch(`/api/control/cron/jobs/${jobId}/status`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action })
  })
}

export function triggerCronJob(jobId: string) {
  return fetch(`/api/control/cron/jobs/${jobId}/trigger`, {
    method: 'POST'
  })
}

// HERMES-H03：右脑子 agent 受控监察（身份/白名单/模型可用性/运行记录、人工触发监察、建议审核）
export function getRightBrainSupervision() {
  return fetch('/api/control/supervision/right-brain')
}

export function runRightBrainSupervision(body: { focusSessionId?: string } = {}) {
  return fetch('/api/control/supervision/right-brain/run', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  })
}

export function reviewRightBrainSuggestion(runId: string, suggestionId: string, decision: 'approve' | 'reject') {
  return fetch(`/api/control/supervision/right-brain/runs/${runId}/suggestions/${suggestionId}/review`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ decision })
  })
}

// 学习循环技能治理：agent 自创技能候选扫描、内容审阅、人工审核、当前注入清单
export function listSkillCandidates() {
  return fetch('/api/control/skills/candidates')
}

export function getSkillCandidateContent(name: string) {
  return fetch(`/api/control/skills/candidates/${encodeURIComponent(name)}/content`)
}

export function reviewSkillCandidate(name: string, body: { actor: string; decision: 'approve' | 'reject'; note?: string }) {
  return fetch(`/api/control/skills/candidates/${encodeURIComponent(name)}/review`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  })
}

export function listActiveSkills() {
  return fetch('/api/control/skills/active')
}

// 历史会话检索（只读）：control 直接查 Hermes state.db FTS5，不经过网关推理
export function searchHermesSessionHistory(q: string, limit = 8) {
  const search = new URLSearchParams({ q, limit: String(limit) })
  return fetch(`/api/control/hermes/session-search?${search.toString()}`)
}
