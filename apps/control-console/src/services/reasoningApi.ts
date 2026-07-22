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
