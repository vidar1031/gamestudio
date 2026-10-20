/**
 * control 资源调度器租约客户端（AUTO-R01 统一互斥，2026-09-12 扩展）。
 *
 * 本机 32G 内存无法同时容纳多个大模型 / 大模型+ComfyUI 出图，所有本地重负载调用
 * （OMLX 文本模型、OMLX 视觉模型、ComfyUI 出图）必须先向 control 资源调度器申请租约，
 * 由调度器统一编排模型装卸（llm 共享读卡；gpu/vision 独占写卡，换入换出）。
 *
 * 失败语义（显式，不静默）：
 * - control 不可达 -> resource_scheduler_unreachable（control 离线时无法保证内存安全，阻断调用）
 * - 交换失败/客户端取消 -> 透传调度器错误
 * 关闭开关：设置页「守护台关联」运行时关闭（storage/_config/studio_settings.json 的 control.leaseEnabled）；
 * env STUDIO_RESOURCE_LEASE_ENABLED 显式设定时优先（仅限无 control 的独立调试场景）。
 */

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

let leaseSeq = 0

async function acquireLease(kind, holder, timeoutMs) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), Math.max(5000, Number(timeoutMs) || DEFAULT_LEASE_TIMEOUT_MS))
  try {
    const res = await fetch(`${controlBaseUrl()}/api/control/resources/lease`, {
      method: 'POST',
      body: JSON.stringify({ kind, holder }),
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
    return payload.leaseId
  } catch (error) {
    if (error?.code === 'resource_lease_denied') throw error
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

async function releaseLease(leaseId) {
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
export async function withResourceLease(kind, holder, fn, { timeoutMs } = {}) {
  if (!isResourceLeaseEnabled()) return fn()
  const k = String(kind || '').trim() || 'llm'
  const leaseId = await acquireLease(k, String(holder || `gs:${++leaseSeq}`), timeoutMs)
  try {
    return await fn()
  } finally {
    await releaseLease(leaseId)
  }
}

/** 判定一个模型调用目标是否为本机 OMLX（远程 provider 不需要租约） */
export function isLocalOmlxUrl(apiUrl) {
  const u = String(apiUrl || '').trim()
  if (!u) return false
  return /^(https?:\/\/)?(127\.0\.0\.1|localhost)(:\d+)?\//.test(u) && u.includes('18888')
}
