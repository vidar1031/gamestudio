type QueryValue = string | number | boolean | null | undefined

function buildQuery(params: Record<string, QueryValue>) {
  const search = new URLSearchParams()
  Object.entries(params).forEach(([key, value]) => {
    if (value == null || value === '') return
    search.set(key, String(value))
  })
  return search.toString()
}

export function getHealth() {
  return fetch('/api/health')
}

export function getAgents() {
  return fetch('/api/control/agents')
}

export function getAgentLogs(agentId: string) {
  return fetch(`/api/control/agents/${agentId}/logs`)
}

export function getRuntimeStatus(agentId: string) {
  return fetch(`/api/control/agents/${agentId}/runtime-status`)
}

export function getAgentConfig(agentId: string) {
  return fetch(`/api/control/agents/${agentId}/config`)
}

export function saveAgentConfig(agentId: string, body: unknown) {
  return fetch(`/api/control/agents/${agentId}/config`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  })
}

export function getAgentMemoryRecords(agentId: string) {
  return fetch(`/api/control/agents/${agentId}/memory-records`)
}

export function clearAgentMemoryRecords(agentId: string, body: unknown) {
  return fetch(`/api/control/agents/${agentId}/memory-records/clear`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  })
}

export function getAgentMemoryRecordFile(agentId: string, recordKey: string) {
  return fetch(`/api/control/agents/${agentId}/memory-records/file?${buildQuery({ recordKey })}`)
}

export function saveAgentMemoryRecordFile(agentId: string, body: unknown) {
  return fetch(`/api/control/agents/${agentId}/memory-records/file`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  })
}

export function listLocalModels(params: { provider: string; baseUrl: string }) {
  return fetch(`/api/control/local-models?${buildQuery(params)}`)
}

export function inspectLocalModel(params: { provider: string; model: string; baseUrl: string }) {
  return fetch(`/api/control/local-models/inspect?${buildQuery(params)}`)
}

export function runPreflightCheck(agentId: string, body: unknown) {
  return fetch(`/api/control/agents/${agentId}/preflight-check`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  })
}

export function getSelfCheck(agentId: string) {
  return fetch(`/api/control/agents/${agentId}/self-check`)
}

export function runRuntimeAction(agentId: string, body: unknown) {
  return fetch(`/api/control/agents/${agentId}/runtime-action`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  })
}

export function runModelAction(action: 'load' | 'unload', body: unknown) {
  return fetch(`/api/control/models/${action}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  })
}
