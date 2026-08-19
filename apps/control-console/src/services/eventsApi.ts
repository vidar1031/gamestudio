export function getEventRegistry() {
  return fetch('/api/control/events/registry')
}

// 事件执行历史（只读）：按 eventId/code 过滤，返回最近 limit 条（新的在前）
export function getEventRuns(event: string, limit = 10) {
  const params = new URLSearchParams({ event, limit: String(limit) })
  return fetch(`/api/control/events/runs?${params.toString()}`)
}

export function dispatchEvent(body: {
  event: string
  payload?: Record<string, unknown>
  caller?: 'chat' | 'console' | 'testcase' | 'cron' | 'workflow'
  confirmed?: boolean
  sessionId?: string | null
  caseId?: string | null
}) {
  return fetch('/api/control/events/dispatch', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  })
}
