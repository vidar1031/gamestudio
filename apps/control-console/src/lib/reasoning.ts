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
  const isFinished = session.status === 'completed' || session.status === 'failed' || session.status === 'cancelled'
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
  if (typeof data.phase === 'string' && data.phase.trim()) {
    lines.push(`阶段: ${data.phase.trim()}`)
  }
  if (typeof data.tool === 'string' && data.tool.trim()) {
    lines.push(`工具: ${data.tool.trim()}`)
  }
  if (typeof data.action === 'string' && data.action.trim()) {
    lines.push(`动作: ${data.action.trim()}`)
  }
  if (typeof data.provider === 'string' && data.provider.trim()) {
    lines.push(`Provider: ${data.provider.trim()}`)
  }
  if (typeof data.model === 'string' && data.model.trim()) {
    lines.push(`模型: ${data.model.trim()}`)
  }
  if (Number.isInteger(data.stepIndex)) {
    lines.push(`步骤序号: #${Number(data.stepIndex) + 1}`)
  }
  if (Number.isInteger(data.renewalCount) && Number.isInteger(data.maxRenewals)) {
    lines.push(`续租: ${Number(data.renewalCount)}/${Number(data.maxRenewals)}`)
  }
  if (typeof data.leaseMs === 'number' && Number.isFinite(data.leaseMs)) {
    lines.push(`租约: ${Math.round(Number(data.leaseMs) / 1000)}s`)
  }
  if (typeof data.leaseExpiresAt === 'string' && data.leaseExpiresAt.trim()) {
    lines.push(`下次检查: ${formatReasoningEventTime(data.leaseExpiresAt.trim())}`)
  }
  if (typeof data.hardTimeoutAt === 'string' && data.hardTimeoutAt.trim()) {
    lines.push(`硬超时: ${formatReasoningEventTime(data.hardTimeoutAt.trim())}`)
  }
  const providerStatus = data.providerStatus && typeof data.providerStatus === 'object' ? data.providerStatus as Record<string, unknown> : null
  if (providerStatus) {
    if (typeof providerStatus.state === 'string' && providerStatus.state.trim()) {
      lines.push(`Provider状态: ${providerStatus.state.trim()}`)
    }
    if (typeof providerStatus.telemetrySource === 'string' && providerStatus.telemetrySource.trim()) {
      lines.push(`遥测来源: ${providerStatus.telemetrySource.trim()}`)
    }
    if (typeof providerStatus.checkedAt === 'string' && providerStatus.checkedAt.trim()) {
      lines.push(`最近探测: ${formatReasoningEventTime(providerStatus.checkedAt.trim())}`)
    }
    if (typeof providerStatus.nativeSessionSupported === 'boolean') {
      lines.push(`原生任务遥测: ${providerStatus.nativeSessionSupported ? '支持' : '不支持'}`)
    }
  }
  return lines
}

export function getReasoningEventOps(event: ReasoningEvent) {
  const data = getReasoningEventData(event)
  if (!data || !Array.isArray(data.observableOps)) return [] as string[]
  return data.observableOps.map((item) => String(item || '').trim()).filter(Boolean)
}

export function getReasoningEventPreviewBlocks(event: ReasoningEvent) {
  const data = getReasoningEventData(event)
  if (!data) return [] as Array<{ title: string, content: string }>

  const blocks: Array<{ title: string, content: string }> = []
  const rawResponsePreview = typeof data.rawResponsePreview === 'string' ? data.rawResponsePreview.trim() : ''
  const finalAnswerPreview = typeof data.finalAnswerPreview === 'string' ? data.finalAnswerPreview.trim() : ''
  const finalAnswer = typeof data.finalAnswer === 'string' ? data.finalAnswer.trim() : ''

  if (rawResponsePreview) {
    blocks.push({ title: 'Hermes 原始返回', content: rawResponsePreview })
  }
  if (finalAnswerPreview) {
    blocks.push({ title: 'Hermes 最终回答预览', content: finalAnswerPreview })
  } else if (finalAnswer) {
    blocks.push({ title: 'Hermes 最终回答预览', content: finalAnswer })
  }

  return blocks
}

export function formatReasoningEventTime(timestamp: string) {
  const value = new Date(timestamp)
  if (Number.isNaN(value.getTime())) return timestamp
  return value.toLocaleTimeString('zh-CN', { hour12: false })
}