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

export function getAgent(agentId: string) {
  return fetch(`/api/control/agents/${agentId}`)
}

export function getAgentLogs(agentId: string) {
  return fetch(`/api/control/agents/${agentId}/logs`)
}

export function getAgentContract(agentId: string) {
  return fetch(`/api/control/agents/${agentId}/contract`)
}

export function getAgentStartupProfile(agentId: string) {
  return fetch(`/api/control/agents/${agentId}/startup-profile`)
}

export function getAgentStartupFlow(agentId: string) {
  return fetch(`/api/control/agents/${agentId}/startup-flow`)
}

export function getAgentNextAction(agentId: string) {
  return fetch(`/api/control/agents/${agentId}/next-action`)
}

export function getAgentWorkflowDiagnostics(agentId: string) {
  return fetch(`/api/control/agents/${agentId}/workflow-diagnostics`)
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

export function switchAgentModel(agentId: string, body: unknown) {
  return fetch(`/api/control/agents/${agentId}/switch-model`, {
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

export function getOverview() {
  return fetch('/api/control/overview')
}

export function getBootstrap() {
  return fetch('/api/control/bootstrap')
}

export function runMemoryLifecycleMaintenance(agentId: string, body: unknown = {}) {
  return fetch(`/api/control/agents/${agentId}/memory-lifecycle/maintenance`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  })
}

export function getMemoryLifecycleReport(agentId: string) {
  return fetch(`/api/control/agents/${agentId}/memory-lifecycle/report`)
}

export function triggerSupervision(body: unknown = {}) {
  return fetch('/api/control/supervision/trigger', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  })
}

// HERMES-H01：治理页健康视图——监督状态（含 gateway 进程监督）
export function getSupervisionState() {
  return fetch('/api/control/supervision/state')
}

// AUTO-R01：本地重负载资源互斥调度状态（槽位/模型在线/内存水位/最近交换）
export function getResourcesState() {
  return fetch('/api/control/resources/state')
}

export function recoverReasoningSession(agentId: string, sessionId: string) {
  return fetch(`/api/control/agents/${agentId}/reasoning-sessions/${sessionId}/recover`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({})
  })
}

export function getStructuredLogs(prefix: string, lines = 100) {
  return fetch(`/api/control/logs/${encodeURIComponent(prefix)}?${buildQuery({ lines })}`)
}
