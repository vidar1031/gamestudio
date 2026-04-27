export function getReasoningCapabilities(agentId = 'hermes-manager') {
  return fetch(`/api/control/agents/${agentId}/agent-runtime`)
}

export function createReasoningSession(agentId: string, body: unknown) {
  return fetch(`/api/control/agents/${agentId}/agent-runtime-sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  })
}

export function getReasoningSession(agentId: string, sessionId: string) {
  return fetch(`/api/control/agents/${agentId}/agent-runtime-sessions/${sessionId}`)
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
