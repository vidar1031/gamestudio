import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

import { GAMESTUDIO_ROOT } from '../../config/paths.js'
import { GAMESTUDIO_SERVER_BASE_URL } from '../services/gameStudioServerClient.js'
import {
  indexGameStudioEventRegistry,
  loadGameStudioEventRegistry,
  resolveGameStudioEventRef
} from './eventRegistryClient.js'

// GameStudio 事件分发器（Layer 2 适配器）。
// 职责：事件引用解析 -> payload 必填校验 -> transport.http 映射 -> HTTP 调用 ->
// 归一化 EventResult -> 追加 trace 记录到 state/events/events.jsonl（外挂数据，不进业务逻辑）。
// 过渡期 transport 仍为 REST；GameStudio /api/events/dispatch 落地后仅改 buildHttpRequest。

const EVENT_LOG_FILE = path.join(GAMESTUDIO_ROOT, 'state', 'events', 'events.jsonl')

function appendEventRecord(record) {
  try {
    fs.mkdirSync(path.dirname(EVENT_LOG_FILE), { recursive: true })
    fs.appendFileSync(EVENT_LOG_FILE, `${JSON.stringify(record)}\n`)
  } catch {
    // trace 记录失败不阻断事件执行
  }
}

// 事件特定 payload 转换：事件层干净 payload -> 现有 REST 端点所需 body。
const PAYLOAD_TRANSFORMS = {
  'project.configure': (payload) => {
    const config = payload?.config && typeof payload.config === 'object' ? payload.config : {}
    const updatedAt = new Date().toISOString()
    return {
      project: {
        generationConfig: { ...config, updatedAt },
        storyProduction: { generationConfig: config, updatedAt }
      }
    }
  }
}

// 事件特定 result 转换：保持与既有 gameStudioServerClient 适配行为一致。
const RESULT_TRANSFORMS = {
  'studio.ai.status': (body) => {
    if (body && typeof body === 'object' && body.ai && typeof body.ai === 'object') {
      const snap = body.ai
      if (!snap.effective || typeof snap.effective !== 'object') {
        const provider = String(snap.provider || 'local').toLowerCase()
        const hasTextProvider = ['local', 'localoxml', 'openai', 'ollama', 'doubao'].includes(provider)
        const hasImageProvider = ['local', 'localoxml', 'openai', 'doubao'].includes(provider)
        snap.effective = {
          enabled: {
            scripts: hasTextProvider,
            prompt: hasTextProvider,
            image: hasImageProvider,
            tts: false
          }
        }
      }
    }
    return body
  }
}

function validateRequiredPayload(event, payload) {
  const schema = event?.payloadSchema && typeof event.payloadSchema === 'object' ? event.payloadSchema : null
  const required = Array.isArray(schema?.required) ? schema.required : []
  const missing = required.filter((field) => {
    const value = payload?.[field]
    if (value === undefined || value === null) return true
    if (typeof value === 'string' && value.trim() === '') return true
    return false
  })
  return missing
}

function buildHttpRequest(event, payload) {
  const http = event?.transport?.http || {}
  let pathTemplate = String(http.path || '')
  const bodyPayload = { ...(payload || {}) }
  // 通用路径参数替换：:id / :sceneId / :reviewId 等一律从 payload 取值并移除
  pathTemplate = pathTemplate.replace(/:([a-zA-Z][a-zA-Z0-9_]*)/g, (match, name) => {
    const key = name === 'id' ? 'projectId' : name
    const value = bodyPayload[key]
    if (value === undefined || value === null || String(value) === '') return match
    delete bodyPayload[key]
    return encodeURIComponent(String(value))
  })
  const method = String(http.method || 'GET').toUpperCase()
  let body = null
  if (method !== 'GET') {
    const transform = PAYLOAD_TRANSFORMS[event.eventId]
    body = transform ? transform(payload || {}) : bodyPayload
  } else {
    // GET：剩余 payload 作为 query string（如 reviews 的 status 过滤）
    const qs = new URLSearchParams()
    for (const [key, value] of Object.entries(bodyPayload)) {
      if (value === undefined || value === null || String(value) === '') continue
      qs.set(key, String(value))
    }
    const query = qs.toString()
    if (query) pathTemplate = `${pathTemplate}${pathTemplate.includes('?') ? '&' : '?'}${query}`
  }
  return { method, url: `${GAMESTUDIO_SERVER_BASE_URL}${pathTemplate}`, path: pathTemplate, body }
}

async function requestHttpJson({ method, url, body, timeoutMs }) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), Math.max(1000, Number(timeoutMs || 30000)))
  const startedAt = Date.now()
  try {
    const res = await fetch(url, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal
    })
    const durationMs = Date.now() - startedAt
    const data = await res.json().catch(() => null)
    return { ok: res.ok, status: res.status, data, durationMs }
  } catch (error) {
    return {
      ok: false,
      status: 0,
      data: null,
      durationMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error)
    }
  } finally {
    clearTimeout(timeout)
  }
}

function summarizePayload(payload) {
  try {
    const text = JSON.stringify(payload || {})
    return text.length > 400 ? `${text.slice(0, 400)}...` : text
  } catch {
    return '[unserializable]'
  }
}

// 高阶 dispatch：返回归一化 EventResult 信封。
// options.caller: 'chat' | 'testcase' | 'cron' | 'workflow'
// options.confirmed: command + reviewRequired 事件必须显式 confirmed=true 才执行
// options.sessionId: 关联的 reasoning session（可选，用于溯源）
export async function dispatchGameStudioEvent(eventRef, payload = {}, options = {}) {
  const registry = await loadGameStudioEventRegistry()
  const index = indexGameStudioEventRegistry(registry)
  const event = resolveGameStudioEventRef(index, eventRef)
  const caller = String(options.caller || 'unknown')
  const traceId = crypto.randomUUID()

  if (!event) {
    return {
      ok: false,
      provider: 'gamestudio',
      eventId: null,
      code: null,
      traceId,
      durationMs: 0,
      error: `event_not_found: ${String(eventRef || '')}`,
      caller
    }
  }

  const missing = validateRequiredPayload(event, payload)
  if (missing.length > 0) {
    return {
      ok: false,
      provider: 'gamestudio',
      eventId: event.eventId,
      code: event.code || null,
      traceId,
      durationMs: 0,
      error: `payload_missing_required: ${missing.join(', ')}`,
      caller,
      event
    }
  }

  if (event.kind === 'command' && event.reviewRequired === true && options.confirmed !== true) {
    return {
      ok: false,
      provider: 'gamestudio',
      eventId: event.eventId,
      code: event.code || null,
      traceId,
      durationMs: 0,
      error: 'review_required',
      reviewRequired: true,
      caller,
      event
    }
  }

  const request = buildHttpRequest(event, payload)
  const response = await requestHttpJson({
    method: request.method,
    url: request.url,
    body: request.body,
    timeoutMs: event.timeoutMs || 30000
  })

  const resultTransform = RESULT_TRANSFORMS[event.eventId]
  const resultData = resultTransform ? resultTransform(response.data) : response.data
  const ok = response.ok && (resultData?.success !== false)
  const result = {
    ok,
    provider: 'gamestudio',
    eventId: event.eventId,
    code: event.code || null,
    kind: event.kind,
    reviewRequired: Boolean(event.reviewRequired),
    traceId,
    durationMs: response.durationMs,
    transport: {
      method: request.method,
      endpoint: request.path,
      status: response.status
    },
    result: resultData,
    error: ok ? null : (response.error || resultData?.error || resultData?.message || `http_${response.status}`),
    caller
  }

  appendEventRecord({
    traceId,
    ts: new Date().toISOString(),
    provider: result.provider,
    eventId: result.eventId,
    code: result.code,
    kind: result.kind,
    caller,
    sessionId: options.sessionId || null,
    caseId: options.caseId || null,
    ok: result.ok,
    durationMs: result.durationMs,
    transport: result.transport,
    payloadSummary: summarizePayload(payload),
    error: result.error
  })

  return result
}

// 低阶适配：返回与既有 gameStudioServerClient 调用点兼容的形状，便于存量调用点最小改动迁移。
export async function dispatchGameStudioEventLegacy(eventRef, payload = {}, options = {}) {
  const result = await dispatchGameStudioEvent(eventRef, payload, {
    ...options,
    caller: options.caller || 'workflow',
    confirmed: true
  })
  return {
    ok: result.ok,
    status: result.transport?.status ?? (result.ok ? 200 : 500),
    endpoint: result.transport?.endpoint || '',
    data: result.result,
    error: result.error,
    message: result.error,
    retryable: false,
    traceId: result.traceId
  }
}
