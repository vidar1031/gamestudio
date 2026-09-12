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

export function getContextCandidates(agentId = 'hermes-manager') {
  return fetch(`/api/control/agents/${agentId}/context-candidates`)
}

// 对话水位管理：用户确认后压缩早期对话为摘要，或归档清空重开
export function compactChatHistory(agentId: string, body: { action: 'compress' | 'clear'; keepRecentPairs?: number }) {
  return fetch(`/api/control/agents/${agentId}/chat-history/compact`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  })
}

// ============ 会话历史管理（文件存储） ============
export function listChatSessions(agentId = 'hermes-manager') {
  return fetch(`/api/control/agents/${agentId}/chat-sessions`)
}

export function archiveCurrentChatSession(agentId: string, title?: string) {
  return fetch(`/api/control/agents/${agentId}/chat-sessions/archive-current`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(title ? { title } : {})
  })
}

export function openChatSession(agentId: string, sessionId: string) {
  return fetch(`/api/control/agents/${agentId}/chat-sessions/${encodeURIComponent(sessionId)}/open`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}'
  })
}

export function deleteChatSession(agentId: string, sessionId: string) {
  return fetch(`/api/control/agents/${agentId}/chat-sessions/${encodeURIComponent(sessionId)}`, {
    method: 'DELETE'
  })
}

// 咨询/问答类聊天的 agent 流式路径（SSE 透传）：服务端分类为咨询才返回 text/event-stream，
// 否则返回 JSON（not_consultative → 调用方回退既有确定性执行链）。
export function postAgentStream(agentId: string, body: unknown) {
  return fetch(`/api/control/agents/${agentId}/agent-stream`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
    body: JSON.stringify(body)
  })
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
