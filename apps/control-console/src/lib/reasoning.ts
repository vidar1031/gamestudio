import type { ReasoningEvent, ReasoningSession } from '../types/reasoning'

export function formatDurationSeconds(totalSeconds: number) {
  const safeSeconds = Math.max(0, Math.round(Number(totalSeconds) || 0))
  const hours = Math.floor(safeSeconds / 3600)
  const minutes = Math.floor((safeSeconds % 3600) / 60)
  const seconds = safeSeconds % 60
  if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`
  if (minutes > 0) return `${minutes}m ${seconds}s`
  return `${seconds}s`
}

export function getReasoningSessionElapsedSeconds(session: ReasoningSession | null, nowMs: number) {
  if (!session) return 0
  const startedAt = new Date(session.createdAt).getTime()
  if (Number.isNaN(startedAt)) return 0
  const isFinished = session.status === 'completed' || session.status === 'failed'
  const endAt = isFinished ? new Date(session.updatedAt).getTime() : nowMs
  if (Number.isNaN(endAt)) return 0
  return Math.max(0, Math.round((endAt - startedAt) / 1000))
}

export function getReasoningEventData(event: ReasoningEvent) {
  return event.data && typeof event.data === 'object' ? event.data : null
}

export function getReasoningEventMetaLines(event: ReasoningEvent) {
  const data = getReasoningEventData(event)
  if (!data) return [] as string[]

  const lines: string[] = []
  if (typeof data.tool === 'string' && data.tool.trim()) {
    lines.push(`工具: ${data.tool.trim()}`)
  }
  if (typeof data.action === 'string' && data.action.trim()) {
    lines.push(`动作: ${data.action.trim()}`)
  }
  if (Number.isInteger(data.stepIndex)) {
    lines.push(`步骤序号: #${Number(data.stepIndex) + 1}`)
  }
  return lines
}

export function getReasoningEventOps(event: ReasoningEvent) {
  const data = getReasoningEventData(event)
  if (!data || !Array.isArray(data.observableOps)) return [] as string[]
  return data.observableOps.map((item) => String(item || '').trim()).filter(Boolean)
}

export function formatReasoningEventTime(timestamp: string) {
  const value = new Date(timestamp)
  if (Number.isNaN(value.getTime())) return timestamp
  return value.toLocaleTimeString('zh-CN', { hour12: false })
}