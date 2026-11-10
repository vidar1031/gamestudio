/**
 * control 资源调度器租约客户端（AUTO-R01 统一互斥，2026-09-12 扩展）。
 *
 * 本机 32G 内存无法同时容纳多个大模型 / 大模型+ComfyUI 出图，所有本地重负载调用
 * （OMLX 文本模型、OMLX 视觉模型、ComfyUI 出图）必须先向 control 资源调度器申请租约，
 * 由调度器统一编排模型装卸（llm 同模型串行、按模型批次换入换出；gpu/vision 独占写卡）。
 *
 * 失败语义（显式，不静默）：
 * - control 不可达 -> resource_scheduler_unreachable（control 离线时无法保证内存安全，阻断调用）
 * - 交换失败/客户端取消 -> 透传调度器错误
 * 关闭开关：设置页「守护台关联」运行时关闭（storage/_config/studio_settings.json 的 control.leaseEnabled）；
 * env STUDIO_RESOURCE_LEASE_ENABLED 显式设定时优先（仅限无 control 的独立调试场景）。
 */

import { linkAiTaskAbort, throwIfAiTaskCancelled } from './taskCancellation.js'

const DEFAULT_CONTROL_BASE_URL = 'http://127.0.0.1:2099'
const DEFAULT_LEASE_TIMEOUT_MS = 45 * 60 * 1000

// 2026-10-20 守护台关联：设置值经装配处注册同步读取（readControlLinkSync），未注册时回退 env/默认。
let controlLinkResolver = null

export function registerControlLinkResolver(fn) {
  controlLinkResolver = typeof fn === 'function' ? fn : null
}

function settingsControlLink() {
  try {
    const v = controlLinkResolver ? controlLinkResolver() : null
    return v && typeof v === 'object' ? v : null
  } catch (_) {
    return null
  }
}

export function isResourceLeaseEnabled() {
  const raw = process.env.STUDIO_RESOURCE_LEASE_ENABLED
  // env 显式设定时优先（独立调试用语保留）
  if (raw !== undefined && raw !== null && String(raw).trim() !== '') return !/^(false|0|off|no)$/i.test(String(raw).trim())
  const fromSettings = settingsControlLink()
  if (fromSettings && typeof fromSettings.leaseEnabled === 'boolean') return fromSettings.leaseEnabled
  return true
}

export function controlBaseUrl() {
  const envUrl = String(process.env.STUDIO_CONTROL_BASE_URL || '').trim()
  if (envUrl) return envUrl.replace(/\/+$/, '')
  const fromSettings = settingsControlLink()
  if (fromSettings && fromSettings.baseUrl) return String(fromSettings.baseUrl).replace(/\/+$/, '')
  return DEFAULT_CONTROL_BASE_URL
}

// 接入守则 v1：携带客户端凭证（x-client-id + Bearer key）。
// key 经 .env 的 STUDIO_CONTROL_CLIENT_KEY 注入；未配置时按守护台本机操作员通道（console-local）兜底。
function leaseHeaders() {
  const clientId = String(process.env.STUDIO_CONTROL_CLIENT_ID || 'talkscene').trim()
  const key = String(process.env.STUDIO_CONTROL_CLIENT_KEY || '').trim()
  const headers = { 'Content-Type': 'application/json', Accept: 'application/json' }
  if (key) {
    headers['x-client-id'] = clientId
    headers.Authorization = `Bearer ${key}`
  }
  return headers
}

// O 波（2026-10-27 双向任务流）：凭证头导出给事件上报旁路（taskProgress.js）复用，与租约同一来源。
// hasControlClientKey 供上报侧判"未配置凭证"——未配置时静默跳过（不往守护台发必 401 的请求）。
export function controlClientHeaders() {
  return leaseHeaders()
}

export function hasControlClientKey() {
  return Boolean(String(process.env.STUDIO_CONTROL_CLIENT_KEY || '').trim())
}

let leaseSeq = 0

// ---------------------------------------------------------------------------
// 2026-11-09 租约调度态登记（用户裁决：AI 调用不止"生成中"，排队/换模/获准如实透出）。
// 租约等待期间每 3s 轮询守护台 resources/state，把本请求的调度态登记进进程内注册表；
// GET /api/ai/tasks 合并输出（leaseStatuses），编辑器任务指示器据此渲染。
// phase：requesting=提交申请 → queued=排队等待 → swapping=模型切换中 → waiting=等待调度 → acquired=已获准
// ---------------------------------------------------------------------------
const activeLeaseStatuses = new Map() // reqId → {reqId, kind, holder, model, projectId, phase, queuePosition, queueLength, swapInFlight, since, updatedAt}

const LEASE_PHASE_LABELS = {
  requesting: '提交租约申请',
  queued: '排队等待',
  swapping: '模型切换中',
  waiting: '等待调度',
  acquired: '已获准执行'
}

export function listActiveLeaseStatuses() {
  const now = Date.now()
  return [...activeLeaseStatuses.values()]
    // 等待中条目靠轮询保鲜（3s），90s 无更新视为陈旧兜底；已获准条目由 release 确定性移除，不按时间过滤
    // （长生成任务执行远超 60s，获准后停轮询，按时间过滤会让"已获准执行"中途消失）
    .filter((s) => s.phase === 'acquired' || now - Number(s.updatedAtMs || 0) < 90_000)
    .map((s) => ({ ...s, phaseLabel: LEASE_PHASE_LABELS[s.phase] || s.phase }))
}

async function pollLeaseStatusOnce(entry) {
  try {
    const res = await fetch(`${controlBaseUrl()}/api/control/resources/state`, { headers: leaseHeaders() })
    const payload = await res.json().catch(() => null)
    if (!payload) return
    const queue = Array.isArray(payload.llmQueue) ? payload.llmQueue : []
    const exclusiveQueue = Array.isArray(payload.exclusiveQueue) ? payload.exclusiveQueue : []
    const kind = String(entry.kind || 'llm')
    // gpu/vision 类同口径匹配独占队列（2026-11-09 用户裁决：出图排队也要可见第 N 位）
    const myIdx = entry.holder
      ? (kind === 'llm' ? queue : exclusiveQueue).findIndex((w) => String(w?.holder || '').includes(entry.holder))
      : -1
    const swap = Boolean(payload.swapInFlight)
    if (myIdx >= 0) {
      entry.phase = (kind === 'llm' ? queue : exclusiveQueue)[myIdx]?.starting ? 'swapping' : 'queued'
      entry.queuePosition = myIdx + 1
    } else {
      entry.phase = swap ? 'swapping' : 'waiting'
      entry.queuePosition = 0
    }
    entry.queueLength = kind === 'llm' ? (queue.length || Number(payload.llmWaiters) || 0) : (exclusiveQueue.length || Number(payload.exclusiveQueueLength) || 0)
    entry.swapInFlight = swap
    entry.updatedAt = new Date().toISOString()
    entry.updatedAtMs = Date.now()
  } catch { /* 状态轮询失败不阻断租约等待 */ }
}

function trackLeaseRequest(entry, controller) {
  const reqId = `lr_${++leaseSeq}_${Date.now().toString(36)}`
  const rec = { reqId, phase: 'requesting', queuePosition: 0, queueLength: 0, swapInFlight: false, since: entry.since, updatedAt: entry.since, updatedAtMs: Date.now(), ...entry }
  activeLeaseStatuses.set(reqId, rec)
  const timer = setInterval(() => { void pollLeaseStatusOnce(rec) }, 3000)
  timer.unref?.()
  const stop = (phase) => {
    clearInterval(timer)
    if (phase === 'acquired') {
      rec.phase = 'acquired'
      rec.queuePosition = 0
      rec.queueLength = 0
      rec.swapInFlight = false
      rec.updatedAt = new Date().toISOString()
      rec.updatedAtMs = Date.now()
      return // 获准后保留登记至 release（任务指示器可见"已获准执行"）
    }
    activeLeaseStatuses.delete(reqId)
  }
  return { reqId, stop }
}

async function acquireLease(kind, holder, timeoutMs, { model, projectId } = {}) {
  const controller = new AbortController()
  linkAiTaskAbort(controller)
  const tracker = trackLeaseRequest({ kind, holder, model: String(model || '').trim(), projectId: String(projectId || '').trim(), since: new Date().toISOString() }, controller)
  const timer = setTimeout(() => controller.abort(), Math.max(5000, Number(timeoutMs) || DEFAULT_LEASE_TIMEOUT_MS))
  try {
    const res = await fetch(`${controlBaseUrl()}/api/control/resources/lease`, {
      method: 'POST',
      body: JSON.stringify({ kind, holder, model: model || undefined, projectId: projectId || undefined }),
      headers: leaseHeaders(),
      signal: controller.signal
    })
    const payload = await res.json().catch(() => null)
    if (!res.ok || !payload?.ok || !payload?.leaseId) {
      const detail = payload?.error || `http_${res.status}`
      const err = new Error(`resource_lease_denied:${kind}:${detail}`)
      err.code = 'resource_lease_denied'
      throw err
    }
    tracker.stop('acquired')
    return { leaseId: payload.leaseId, reqId: tracker.reqId }
  } catch (error) {
    tracker.stop()
    if (error?.code === 'resource_lease_denied') throw error
    if (error?.code === 'AI_TASK_CANCELLED') throw error
    if (error?.name === 'AbortError') {
      const err = new Error(`resource_lease_timeout:${kind}`)
      err.code = 'resource_lease_timeout'
      throw err
    }
    const err = new Error(`resource_scheduler_unreachable:${error instanceof Error ? error.message : String(error)}（control-server 离线，本地算力互斥不可用，已阻断本次调用）`)
    err.code = 'resource_scheduler_unreachable'
    throw err
  } finally {
    clearTimeout(timer)
  }
}

async function releaseLease(leaseId, reqId) {
  if (reqId) activeLeaseStatuses.delete(reqId)
  try {
    await fetch(`${controlBaseUrl()}/api/control/resources/lease/release`, {
      method: 'POST',
      headers: leaseHeaders(),
      body: JSON.stringify({ leaseId })
    })
  } catch {
    // 释放失败不阻断业务：租约 TTL（45min）由 control 侧清扫兜底
  }
}

/**
 * 在租约保护下执行 fn。kind: 'llm' | 'vision' | 'gpu'；holder: 调用方标识（日志/事件用）。
 * 租约未开启时直接执行（保持无 control 的最小调试能力）。
 */
export async function withResourceLease(kind, holder, fn, { timeoutMs, model, projectId } = {}) {
  throwIfAiTaskCancelled()
  if (!isResourceLeaseEnabled()) return fn()
  const k = String(kind || '').trim() || 'llm'
  const { leaseId, reqId } = await acquireLease(k, String(holder || `ts:${++leaseSeq}`), timeoutMs, { model, projectId })
  try {
    throwIfAiTaskCancelled()
    return await fn()
  } finally {
    await releaseLease(leaseId, reqId)
  }
}

export function isPrefillMemoryGuardError(error) {
  const text = String(error?.message || error || '')
  return /prefill memory guard|prefill_memory_exceeded|metal_cap ceiling/i.test(text)
}

export async function resetLocalModelPrefillPool() {
  const controller = new AbortController()
  linkAiTaskAbort(controller)
  const timer = setTimeout(() => controller.abort(), 30_000)
  try {
    const response = await fetch(`${controlBaseUrl()}/api/control/resources/model/prefill-reset`, {
      method: 'POST',
      headers: controlClientHeaders(),
      body: '{}',
      signal: controller.signal
    })
    const payload = await response.json().catch(() => null)
    if (!response.ok || !payload?.ok) throw new Error(payload?.detail || payload?.error || `prefill_reset_http_${response.status}`)
    return payload
  } finally {
    clearTimeout(timer)
  }
}

/** 判定一个模型调用目标是否为本机 OMLX（远程 provider 不需要租约） */
export function isLocalOmlxUrl(apiUrl) {
  const u = String(apiUrl || '').trim()
  if (!u) return false
  return /^(https?:\/\/)?(127\.0\.0\.1|localhost)(:\d+)?\//.test(u) && u.includes('18888')
}
