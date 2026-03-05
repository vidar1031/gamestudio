import crypto from 'node:crypto'

export const AI_ERROR = {
  USER_INVALID_INPUT: 'user_invalid_input',
  USER_PROVIDER_NOT_CONFIGURED: 'user_provider_not_configured',
  PROVIDER_TIMEOUT: 'provider_timeout',
  PROVIDER_UNAVAILABLE: 'provider_unavailable',
  PROVIDER_INVALID_OUTPUT: 'provider_invalid_output',
  PROVIDER_REQUEST_FAILED: 'provider_request_failed',
  SYSTEM_INTERNAL: 'system_internal'
}

export function createTraceId() {
  try {
    return crypto.randomUUID()
  } catch (_) {
    return `tr_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
  }
}

export function classifyAiError(err) {
  const msg = err && err.message ? String(err.message) : String(err || '')
  const status = err && Number.isFinite(Number(err.status)) ? Number(err.status) : null
  const lower = msg.toLowerCase()

  if (status === 501 || lower.includes('unsupported_provider') || lower.includes('provider_not_configured')) {
    return { code: AI_ERROR.USER_PROVIDER_NOT_CONFIGURED, httpStatus: 501 }
  }
  if (lower.includes('invalid_json') || lower.includes('invalid_json_response') || lower.includes('ollama_invalid_json_output')) {
    return { code: AI_ERROR.PROVIDER_INVALID_OUTPUT, httpStatus: 502 }
  }
  if (status === 400 || lower.includes('missing_') || lower.includes('invalid_')) {
    return { code: AI_ERROR.USER_INVALID_INPUT, httpStatus: 400 }
  }
  if (lower.includes('timeout') || lower.includes('timed out') || lower.includes('aborted') || status === 408 || status === 504) {
    return { code: AI_ERROR.PROVIDER_TIMEOUT, httpStatus: 502 }
  }
  if (
    lower.includes('failed to connect') ||
    lower.includes('curl_transport_error') ||
    lower.includes('http_404') ||
    lower.includes('http_502') ||
    status === 0
  ) {
    return { code: AI_ERROR.PROVIDER_UNAVAILABLE, httpStatus: 502 }
  }
  if (status && status >= 500) {
    return { code: AI_ERROR.PROVIDER_REQUEST_FAILED, httpStatus: 502 }
  }
  return { code: AI_ERROR.SYSTEM_INTERNAL, httpStatus: 500 }
}

export function logStage(fields) {
  const stage = String(fields && fields.stage ? fields.stage : 'unknown')
  const event = String(fields && fields.event ? fields.event : 'info')
  const keys = [
    'traceId',
    'project',
    'provider',
    'model',
    'item',
    'mode',
    'status',
    'ok',
    'durationMs',
    'err'
  ]
  const parts = [`stage=${stage}`, `event=${event}`]
  for (const key of keys) {
    if (!fields || !(key in fields)) continue
    const v = fields[key]
    if (v == null || v === '') continue
    parts.push(`${key}=${String(v)}`)
  }
  console.log(`[game_studio] ${parts.join(' ')}`)
}
