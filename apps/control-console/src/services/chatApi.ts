export function getChatHistory(agentId = 'hermes-manager') {
  return fetch(`/api/control/agents/${agentId}/chat-history`)
}

export function openChatHistoryFile(agentId = 'hermes-manager') {
  return fetch(`/api/control/agents/${agentId}/chat-history-file/open`, {
    method: 'POST'
  })
}

export function getChatHistoryFile(agentId = 'hermes-manager') {
  return fetch(`/api/control/agents/${agentId}/chat-history-file`)
}

export function saveChatHistoryFile(agentId: string, content: string) {
  return fetch(`/api/control/agents/${agentId}/chat-history-file`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content })
  })
}

export function pingModel(agentId: string, body: unknown) {
  return fetch(`/api/control/agents/${agentId}/ping-model`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  })
}

export function getContextCandidates(agentId = 'hermes-manager') {
  return fetch(`/api/control/agents/${agentId}/context-candidates`)
}

export function getSubmissionPreview(agentId: string, body: unknown) {
  return fetch(`/api/control/agents/${agentId}/submission-preview`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  })
}

export function createContextDraft(agentId: string, body: unknown) {
  return fetch(`/api/control/agents/${agentId}/context-drafts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  })
}
