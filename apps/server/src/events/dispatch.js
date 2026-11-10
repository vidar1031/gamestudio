// TalkScene 事件接收端（/api/events/dispatch 域逻辑）。
// 守护台双向通信入口：control 侧把事件按信封 POST 到本端点，本模块解析注册表（apps/server/events/registry.v1.json）
// 并把事件映射到既有 REST 路由执行（Hono app.request 进程内调用，无端口/超时头问题），
// 返回与 control EventResult 对齐的信封；全部入站事件落盘 state/events/inbound-events.jsonl 留痕。
// transport.local 类事件由 control 在自己的 dispatcher 层拦截执行，不会到达本端点（到达即显式 501）。
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REGISTRY_PATH = process.env.TALKSCENE_EVENT_REGISTRY_FILE || path.resolve(__dirname, '../../events/registry.v1.json')
const INBOUND_LOG_FILE = process.env.TALKSCENE_EVENT_INBOUND_LOG_FILE || path.resolve(__dirname, '../../../../state/events/inbound-events.jsonl')

// registry 轻量缓存：mtime 变化才重读（守护台可高频批量发事件）
let registryCache = { mtimeMs: 0, registry: null }

function loadRegistry() {
  const stat = fs.statSync(REGISTRY_PATH)
  if (registryCache.registry && registryCache.mtimeMs === stat.mtimeMs) return registryCache.registry
  const registry = JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf8'))
  registryCache = { mtimeMs: stat.mtimeMs, registry }
  return registry
}

// 事件引用解析索引：eventId 精确 > code（TS-xx）> 中文别名（与守护台 eventRegistryClient 同语义）
function indexRegistry(registry) {
  const byEventId = new Map()
  const byCode = new Map()
  const byAlias = new Map()
  for (const event of registry.events || []) {
    if (event.eventId) byEventId.set(String(event.eventId).toLowerCase(), event)
    if (event.code) byCode.set(String(event.code).toLowerCase(), event)
    for (const alias of event.aliases || []) {
      if (alias) byAlias.set(String(alias).toLowerCase(), event)
    }
  }
  return { byEventId, byCode, byAlias }
}

function resolveEvent(index, ref) {
  const key = String(ref || '').trim().toLowerCase()
  if (!key) return null
  return index.byEventId.get(key) || index.byCode.get(key) || index.byAlias.get(key) || null
}

function validateRequiredPayload(event, payload) {
  const schema = event?.payloadSchema && typeof event.payloadSchema === 'object' ? event.payloadSchema : null
  const required = Array.isArray(schema?.required) ? schema.required : []
  return required.filter((field) => {
    const value = payload?.[field]
    if (value === undefined || value === null) return true
    if (typeof value === 'string' && value.trim() === '') return true
    return false
  })
}

// transport.http 映射：路径参数 :id/:sceneId 等从原始 payload 取值；
// transportPayload 仅承载守护台对旧 REST 的兼容转换，事件校验仍以原始 payload 为准。
function buildHttpRequest(event, payload, transportPayload) {
  const http = event?.transport?.http || {}
  let pathTemplate = String(http.path || '')
  const originalPayload = { ...(payload || {}) }
  const bodyPayload = transportPayload && typeof transportPayload === 'object' && !Array.isArray(transportPayload) ? { ...transportPayload } : { ...originalPayload }
  pathTemplate = pathTemplate.replace(/:([a-zA-Z][a-zA-Z0-9_]*)/g, (match, name) => {
    const key = name === 'id' ? 'projectId' : name
    const value = originalPayload[key]
    if (value === undefined || value === null || String(value) === '') return match
    delete bodyPayload[key]
    return encodeURIComponent(String(value))
  })
  const method = String(http.method || 'GET').toUpperCase()
  let body = null
  if (method !== 'GET') {
    body = bodyPayload
  } else {
    const qs = new URLSearchParams()
    for (const [key, value] of Object.entries(bodyPayload)) {
      if (value === undefined || value === null || String(value) === '') continue
      qs.set(key, String(value))
    }
    const query = qs.toString()
    if (query) pathTemplate = `${pathTemplate}${pathTemplate.includes('?') ? '&' : '?'}${query}`
  }
  return { method, endpoint: pathTemplate, body }
}

function summarizePayload(payload) {
  try {
    const text = JSON.stringify(payload || {})
    return text.length > 400 ? `${text.slice(0, 400)}...` : text
  } catch {
    return '[unserializable]'
  }
}

function appendInboundRecord(record) {
  try {
    fs.mkdirSync(path.dirname(INBOUND_LOG_FILE), { recursive: true })
    fs.appendFileSync(INBOUND_LOG_FILE, `${JSON.stringify(record)}\n`)
  } catch {
    // 留痕失败不阻断事件执行
  }
}

/**
 * 入站事件分发。
 * @param app Hono app 实例（进程内直接执行，与守护台走真实 HTTP 等价同路由）
 * @param input.body 消息信封：{ event, payload?, confirmed?, traceId?, caller? }
 * @returns { status, envelope } envelope 与守护台 EventResult 对齐
 */
export async function dispatchEventInbound(app, { body } = {}) {
  const startedAt = Date.now()
  const envelope = (overrides) => ({
    success: false,
    provider: 'talkscene',
    eventId: null,
    code: null,
    kind: null,
    reviewRequired: false,
    traceId: null,
    durationMs: Math.max(0, Date.now() - startedAt),
    transport: null,
    result: null,
    error: null,
    ...overrides
  })

  const message = body && typeof body === 'object' ? body : null
  const eventRef = String(message?.event || message?.eventId || message?.eventRef || '').trim()
  const payload = message?.payload && typeof message.payload === 'object' ? message.payload : {}
  const traceId = String(message?.traceId || '').trim() || crypto.randomUUID()
  const caller = String(message?.caller || '').trim() || 'unknown'
  const confirmed = message?.confirmed === true

  const fail = (status, error, extra = {}) => {
    const record = envelope({ error, traceId, caller, ...extra })
    appendInboundRecord({
      ts: new Date().toISOString(),
      direction: 'inbound',
      eventRef: eventRef || null,
      eventId: record.eventId,
      code: record.code,
      caller,
      traceId,
      ok: false,
      durationMs: record.durationMs,
      payloadSummary: summarizePayload(payload),
      error
    })
    return { status, envelope: record }
  }

  if (!message || !eventRef) return fail(400, 'malformed_envelope: missing event')

  let registry
  try {
    registry = loadRegistry()
  } catch (e) {
    return fail(500, `registry_not_available: ${e instanceof Error ? e.message : String(e)}`)
  }
  const event = resolveEvent(indexRegistry(registry), eventRef)
  if (!event) return fail(404, `event_not_found: ${eventRef}`)

  const withEvent = (extra) => ({ eventId: event.eventId, code: event.code || null, kind: event.kind || null, reviewRequired: Boolean(event.reviewRequired), ...extra })

  const missing = validateRequiredPayload(event, payload)
  if (missing.length > 0) return fail(400, `payload_missing_required: ${missing.join(', ')}`, withEvent({}))

  if (event.kind === 'command' && event.reviewRequired === true && !confirmed) {
    return fail(409, 'review_required', withEvent({}))
  }

  if (event.transport && typeof event.transport === 'object' && event.transport.local) {
    return fail(501, 'transport_local_not_supported: 生命周期类事件由守护台 dispatcher 本地执行，不经本端点', withEvent({}))
  }

  const http = event.transport?.http
  if (!http || !http.path) return fail(501, `transport_not_supported: ${event.eventId}`, withEvent({}))

  const request = buildHttpRequest(event, payload, message.transportPayload)
  const timeoutMs = Math.max(1000, Number(event.timeoutMs) || 30000)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs + 60000)
  try {
    const response = await app.request(request.endpoint, {
      method: request.method,
      headers: request.body ? { 'Content-Type': 'application/json' } : {},
      body: request.body ? JSON.stringify(request.body) : undefined,
      signal: controller.signal
    })
    const data = await response.json().catch(() => null)
    const ok = response.ok && (data?.success !== false)
    const record = envelope(withEvent({
      success: ok,
      traceId,
      caller,
      durationMs: Math.max(0, Date.now() - startedAt),
      transport: { method: request.method, endpoint: request.endpoint, status: response.status },
      result: data,
      error: ok ? null : (data?.error || data?.message || `http_${response.status}`)
    }))
    appendInboundRecord({
      ts: new Date().toISOString(),
      direction: 'inbound',
      eventRef,
      eventId: event.eventId,
      code: event.code || null,
      caller,
      traceId,
      ok,
      durationMs: record.durationMs,
      transport: record.transport,
      payloadSummary: summarizePayload(payload),
      error: record.error
    })
    // 执行层错误仍回 200：信封内 transport.status/result/error 已显式表达，由守护台按 EventResult 语义收敛
    return { status: 200, envelope: record }
  } catch (e) {
    return fail(502, e instanceof Error ? e.message : String(e), withEvent({
      transport: { method: request.method, endpoint: request.endpoint, status: 0 }
    }))
  } finally {
    clearTimeout(timer)
  }
}

// 自由消息接收（守护台下行通知/通信测试）：收到即打印 server 日志并落盘，证明接收侧监控活跃。
const INBOUND_MESSAGE_FILE = path.resolve(__dirname, '../../../../state/events/inbound-messages.jsonl')
let inboundMessageSeq = 0

export function receiveInboundMessage(body) {
  const value = Number(body?.value)
  const from = String(body?.from || body?.clientId || 'control').trim().slice(0, 60) || 'control'
  const note = String(body?.note || '').trim().slice(0, 200)
  const record = {
    ts: new Date().toISOString(),
    seq: ++inboundMessageSeq,
    value: Number.isFinite(value) ? value : null,
    from,
    note: note || null
  }
  try {
    fs.mkdirSync(path.dirname(INBOUND_MESSAGE_FILE), { recursive: true })
    fs.appendFileSync(INBOUND_MESSAGE_FILE, `${JSON.stringify(record)}\n`)
  } catch { /* 留痕失败不阻断 */ }
  console.log(`[inbound-message] #${record.seq} value=${record.value} from=${record.from}${record.note ? ` note=${record.note}` : ''}`)
  return { success: true, received: record }
}
