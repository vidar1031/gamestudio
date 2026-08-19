/**
 * 本地重负载资源互斥调度器（AUTO-R01）。
 *
 * 背景：OMLX 模型（LLM，如 Qwen3.6-27B 占 ~16GB）与 ComfyUI 出图（峰值 ~10GB）
 * 共享同一台 32G 机器内存（OMLX final_ceiling ~25GB），两者无法长期共存。
 * 靠 OMLX 内存超限被动报错会造成生产失败（实测 gpt-oss 被自动加载挤掉 Qwen），
 * 因此 control 侧做主动互斥调度：
 *
 * 语义约定：
 * - 槽位状态机：idle / llm / gpu / blocked。
 *   idle=无模型在线承诺；llm=配置模型在线服务文本类；gpu=出图占用中（模型已退出）；
 *   blocked=交换/回载失败后的显式阻断（事件与状态端点可见，不静默继续）。
 * - 资源分类：story workflow action -> 资源类别（默认 llm；出图类 gpu）。
 *   判定为纯函数 resolveActionResourceKind，队列层与 step 层共用同一张映射表。
 * - 交换编排（swap）：gpu 申请时若模型在线 -> 卸载全部已加载模型（含非配置模型，
 *   顺带执行单模型守卫）-> health 探测确认内存释放 -> 放行出图；gpu 批次终结后
 *   -> 回载配置模型（buildHermesBinding().model）-> 探测加载成功 -> 标记 llm 可用。
 *   交换失败必须显式：unload 失败 -> acquire 抛 resource_swap_unload_failed；
 *   reload 失败 -> 状态置 blocked 并落事件，由 llm 准入重试或 reconcile 自愈。
 * - 出图攒批：gpu release 时若仍有 gpu 申请在等待，直接交棒不 reload；
 *   最后一个 gpu release 后留 settle 窗口（HERMES_RESOURCE_GPU_SETTLE_MS 默认 3s），
 *   窗口内新 gpu 申请取消 reload，避免连续出图 step 之间反复装卸模型。
 * - 互斥模型（reader-writer，writer 优先）：llm 持有者可并发；gpu 独占。
 *   gpu 申请登记后新 llm 准入暂停（防饿死），但已在运行的 llm step 不受掐断——
 *   交换只发生在 step 边界，等 llm 持有者自然收尾后才卸载模型。
 * - 单模型守卫（reconcile，HERMES_RESOURCE_RECONCILE_INTERVAL_MS 默认 30s）：
 *   发现 OMLX 加载了非配置模型（如 default gpt-oss 被自动拉起）-> 卸载并记录；
 *   发现配置模型意外缺席且当前有 llm 需求（llm 持有者/等待者非空）-> 回载；
 *   状态漂移纠正（state=llm 但模型实际不在线 -> idle）；blocked 且有 llm 需求时重试回载。
 * - llm 在 gpu 占用期间不得执行：acquire 挂起等待（不动用 retry 预算，不产生失败），
 *   等待可被 shouldAbort（取消/超时）中断并显式返回未准入。
 * - 持久化：槽位状态+持有者+获取时间写 state/resource-scheduler.json（tmp+rename 原子写）；
 *   交换全程事件落 state/resource-scheduler-events.jsonl（who/when/unload_ms/load_ms/结果）。
 *   重启后持有者一律清空（无任何执行在飞行中），由 reconcile 对齐真实世界。
 * - env：HERMES_RESOURCE_SCHEDULER_ENABLED（默认开，'false' 关闭）；
 *   HERMES_RESOURCE_RECONCILE_INTERVAL_MS / HERMES_RESOURCE_OMLX_LOAD_TIMEOUT_MS /
 *   HERMES_RESOURCE_OMLX_UNLOAD_TIMEOUT_MS / HERMES_RESOURCE_GPU_SETTLE_MS /
 *   HERMES_RESOURCE_OP_RETRY_MAX / HERMES_RESOURCE_PROBE_TIMEOUT_MS /
 *   HERMES_RESOURCE_STATE_FILE / HERMES_RESOURCE_EVENTS_FILE（后两者供测试隔离）。
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..', '..')

export const RESOURCE_SLOT_STATE = Object.freeze({
  IDLE: 'idle',
  LLM: 'llm',
  GPU: 'gpu',
  BLOCKED: 'blocked'
})

export const RESOURCE_KIND = Object.freeze({
  LLM: 'llm',
  GPU: 'gpu'
})

// story workflow action -> 资源类别映射：默认 llm；出图类 gpu。
// 出图类动作的实际出图发生在 GameStudio Server + ComfyUI（control 只编排）。
// story_generate_asset_candidate 在 assetKind=background 且出图 provider 就绪时真实出图，归为 gpu。
const GPU_RESOURCE_ACTIONS = new Set([
  'story_generate_lock_asset_references',
  'story_render_scene',
  'story_render_scene_backgrounds',
  'story_lock_test',
  'story_generate_asset_candidate'
])

export function resolveActionResourceKind(action) {
  return GPU_RESOURCE_ACTIONS.has(String(action || '').trim()) ? RESOURCE_KIND.GPU : RESOURCE_KIND.LLM
}

const DEFAULT_RECONCILE_INTERVAL_MS = 30000
const DEFAULT_LOAD_TIMEOUT_MS = 300000
const DEFAULT_UNLOAD_TIMEOUT_MS = 60000
const DEFAULT_GPU_SETTLE_MS = 3000
const DEFAULT_OP_RETRY_MAX = 2
const DEFAULT_PROBE_TIMEOUT_MS = 3000
const DEFAULT_WAIT_POLL_MS = 500
const MAX_EVENT_READ_TAIL = 20

function resolveEnvInt(name, fallback, { min = 0 } = {}) {
  const raw = process.env[name]
  if (raw === undefined || raw === null || raw === '') return fallback
  const num = Number(raw)
  if (!Number.isFinite(num)) return fallback
  return Math.max(min, Math.floor(num))
}

export function isResourceSchedulerEnabled(value) {
  const raw = value ?? process.env.HERMES_RESOURCE_SCHEDULER_ENABLED
  if (raw === undefined || raw === null || String(raw).trim() === '') return true
  return !/^(false|0|off|no)$/i.test(String(raw).trim())
}

export function getResourceSchedulerStateFile() {
  return process.env.HERMES_RESOURCE_STATE_FILE || path.join(REPO_ROOT, 'state', 'resource-scheduler.json')
}

export function getResourceSchedulerEventsFile() {
  return process.env.HERMES_RESOURCE_EVENTS_FILE || path.join(REPO_ROOT, 'state', 'resource-scheduler-events.jsonl')
}

/**
 * 默认 OMLX client（生产实现）：GET /health、GET /v1/models/status、
 * POST /v1/models/{id}/load|unload（Bearer key）。
 * load/unload 只负责发指令，加载/卸载完成的确认由调度器轮询 status/health 完成，
 * 便于测试用 fake client 注入可编程行为。
 */
export function createOmlxClient({ resolveAccess, fetchImpl = fetch, probeTimeoutMs } = {}) {
  if (typeof resolveAccess !== 'function') throw new Error('omlx_client_requires_resolveAccess')
  const timeoutMs = Math.max(500, Number(probeTimeoutMs) || DEFAULT_PROBE_TIMEOUT_MS)

  const buildUrl = (pathname) => {
    const access = resolveAccess()
    const base = String(access?.baseUrl || 'http://127.0.0.1:18888/v1').replace(/\/+$/, '')
    return `${base}${pathname}`
  }
  const buildOriginUrl = (pathname) => {
    const access = resolveAccess()
    const base = String(access?.baseUrl || 'http://127.0.0.1:18888/v1').replace(/\/+$/, '')
    return `${base.replace(/\/v1$/i, '')}${pathname}`
  }
  const buildHeaders = () => {
    const access = resolveAccess()
    const apiKey = String(access?.apiKey || '').trim()
    return {
      Accept: 'application/json',
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {})
    }
  }
  const request = async (url, { method = 'GET', opTimeoutMs } = {}) => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), Math.max(500, Number(opTimeoutMs) || timeoutMs))
    try {
      const res = await fetchImpl(url, { method, headers: buildHeaders(), signal: controller.signal })
      const payload = await res.json().catch(() => null)
      return { ok: res.ok, status: res.status, payload }
    } finally {
      clearTimeout(timer)
    }
  }

  return {
    // GET /health：engine_pool.loaded_count / current_model_memory / final_ceiling
    async getHealth() {
      try {
        const res = await request(buildOriginUrl('/health'))
        const pool = res.payload?.engine_pool || {}
        return {
          ok: res.ok,
          reachable: res.ok,
          loadedCount: Number.isFinite(Number(pool.loaded_count)) ? Number(pool.loaded_count) : null,
          currentModelMemory: Number.isFinite(Number(pool.current_model_memory)) ? Number(pool.current_model_memory) : null,
          finalCeiling: Number.isFinite(Number(pool.final_ceiling)) ? Number(pool.final_ceiling) : null,
          detail: res.ok ? null : `http_${res.status}`,
          raw: res.payload || null
        }
      } catch (error) {
        return { ok: false, reachable: false, loadedCount: null, currentModelMemory: null, finalCeiling: null, detail: error instanceof Error ? error.message : String(error), raw: null }
      }
    },
    // GET /v1/models/status：模型加载状态目录
    async getModelStatus() {
      try {
        const res = await request(buildUrl('/models/status'), { opTimeoutMs: Math.max(timeoutMs, 5000) })
        const models = Array.isArray(res.payload?.models) ? res.payload.models : []
        return {
          ok: res.ok,
          reachable: res.ok,
          models: models.map((m) => ({ id: String(m?.id || '').trim(), loaded: m?.loaded === true, isLoading: m?.is_loading === true })),
          detail: res.ok ? null : `http_${res.status}`
        }
      } catch (error) {
        return { ok: false, reachable: false, models: [], detail: error instanceof Error ? error.message : String(error) }
      }
    },
    // POST /v1/models/{id}/load：只发指令，确认由调度器轮询完成。
    // 指令超时给 45s：OMLX 忙于长推理收尾时 HTTP 响应会阻塞（实测 bible 10min 推理后
    // 15s 内无法响应 unload 指令），指令阶段太短会把可恢复的繁忙误判成交换失败
    async loadModel(model) {
      const id = String(model || '').trim()
      if (!id) return { ok: false, detail: 'missing_model' }
      try {
        const res = await request(buildUrl(`/models/${encodeURIComponent(id)}/load`), { method: 'POST', opTimeoutMs: Math.max(timeoutMs, 45000) })
        if (!res.ok) {
          const detail = res.payload?.error?.message || res.payload?.detail || res.payload?.message || `http_${res.status}`
          return { ok: false, detail: String(detail) }
        }
        return { ok: true, detail: res.payload?.message || null }
      } catch (error) {
        return { ok: false, detail: error instanceof Error ? error.message : String(error) }
      }
    },
    // POST /v1/models/{id}/unload：只发指令，确认由调度器轮询完成（指令超时同理给 45s）
    async unloadModel(model) {
      const id = String(model || '').trim()
      if (!id) return { ok: true, skipped: true, detail: 'missing_model' }
      try {
        const res = await request(buildUrl(`/models/${encodeURIComponent(id)}/unload`), { method: 'POST', opTimeoutMs: Math.max(timeoutMs, 45000) })
        if (!res.ok) {
          const detail = res.payload?.error?.message || res.payload?.detail || res.payload?.message || `http_${res.status}`
          if (/not loaded/i.test(String(detail))) return { ok: true, skipped: true, detail: String(detail) }
          return { ok: false, detail: String(detail) }
        }
        return { ok: true, detail: res.payload?.message || null }
      } catch (error) {
        return { ok: false, detail: error instanceof Error ? error.message : String(error) }
      }
    }
  }
}

/**
 * 创建资源调度器（依赖全注入，便于测试隔离）。
 * - omlxClient：{ getHealth, getModelStatus, loadModel, unloadModel }
 * - resolveConfiguredModel() -> { model, provider, baseUrl }：配置模型真相源（buildHermesBinding）
 * - sleepFn(ms)：测试可注入 0 延迟；nowFn()：ISO 时间
 */
export function createResourceScheduler({
  omlxClient,
  resolveConfiguredModel,
  stateFile,
  eventsFile,
  reconcileIntervalMs,
  loadTimeoutMs,
  unloadTimeoutMs,
  gpuSettleMs,
  opRetryMax,
  waitPollMs,
  sleepFn = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  nowFn = () => new Date().toISOString(),
  logger = () => {}
} = {}) {
  if (!omlxClient) throw new Error('resource_scheduler_requires_omlxClient')
  if (typeof resolveConfiguredModel !== 'function') throw new Error('resource_scheduler_requires_resolveConfiguredModel')

  const STATE_FILE = stateFile || getResourceSchedulerStateFile()
  const EVENTS_FILE = eventsFile || getResourceSchedulerEventsFile()
  const reconcileEveryMs = Math.max(1000, Number(reconcileIntervalMs) || resolveEnvInt('HERMES_RESOURCE_RECONCILE_INTERVAL_MS', DEFAULT_RECONCILE_INTERVAL_MS, { min: 1000 }))
  const loadTimeout = Math.max(1000, Number(loadTimeoutMs) || resolveEnvInt('HERMES_RESOURCE_OMLX_LOAD_TIMEOUT_MS', DEFAULT_LOAD_TIMEOUT_MS, { min: 1000 }))
  const unloadTimeout = Math.max(1000, Number(unloadTimeoutMs) || resolveEnvInt('HERMES_RESOURCE_OMLX_UNLOAD_TIMEOUT_MS', DEFAULT_UNLOAD_TIMEOUT_MS, { min: 1000 }))
  const settleMs = Math.max(0, Number(gpuSettleMs ?? resolveEnvInt('HERMES_RESOURCE_GPU_SETTLE_MS', DEFAULT_GPU_SETTLE_MS, { min: 0 })))
  const retryMax = Math.max(0, Number(opRetryMax ?? resolveEnvInt('HERMES_RESOURCE_OP_RETRY_MAX', DEFAULT_OP_RETRY_MAX, { min: 0 })))
  const pollMs = Math.max(20, Number(waitPollMs) || DEFAULT_WAIT_POLL_MS)

  // ---- 内存态（持久化子集：state/holders/blocked/lastSwapAt） ----
  let slotState = RESOURCE_SLOT_STATE.IDLE
  let gpuHolderKey = null
  let gpuAcquiredAt = null
  const llmHolderKeys = new Set()
  let llmWaiterCount = 0
  let blockedInfo = null // { reason, detail, at }
  let lastSwap = null // { direction, at, unloadMs, loadMs, result, holder }
  const gpuWaitQueue = [] // [{ holderKey, resolve, reject, shouldAbort }]
  let swapInFlight = null // 交换/加载互斥锁（Promise）
  let gpuPumping = false
  let settleTimer = null
  let reconcileTimer = null
  let stopped = true
  let memorySnapshot = null // reconcile/probe 刷新的内存水位缓存
  let lastReconcile = null // { at, result, detail }

  const resolveModel = () => String(resolveConfiguredModel()?.model || '').trim()

  // ---- 持久化（原子写） ----
  const persistState = () => {
    try {
      fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true })
      const doc = {
        version: '1',
        state: slotState,
        gpuHolder: gpuHolderKey ? { holder: gpuHolderKey, acquiredAt: gpuAcquiredAt } : null,
        llmHolders: [...llmHolderKeys],
        configuredModel: resolveModel() || null,
        blocked: blockedInfo,
        lastSwap,
        updatedAt: nowFn()
      }
      const tmpPath = `${STATE_FILE}.tmp-${process.pid}-${Date.now()}`
      fs.writeFileSync(tmpPath, JSON.stringify(doc, null, 2), 'utf8')
      fs.renameSync(tmpPath, STATE_FILE)
    } catch (error) {
      logger(`[RESOURCE][PERSIST][ERROR] detail=${error instanceof Error ? error.message : String(error)}`)
    }
  }

  const loadPersistedState = () => {
    try {
      if (!fs.existsSync(STATE_FILE)) return
      const doc = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'))
      // 重启后持有者一律清空（无任何执行在飞行中）；gpu 状态回落 idle，由 reconcile 对齐真实世界
      if (Object.values(RESOURCE_SLOT_STATE).includes(doc?.state)) {
        slotState = doc.state === RESOURCE_SLOT_STATE.GPU ? RESOURCE_SLOT_STATE.IDLE : doc.state
      }
      blockedInfo = doc?.blocked && typeof doc.blocked === 'object' ? doc.blocked : null
      lastSwap = doc?.lastSwap && typeof doc.lastSwap === 'object' ? doc.lastSwap : null
    } catch (error) {
      logger(`[RESOURCE][LOAD][ERROR] detail=${error instanceof Error ? error.message : String(error)}`)
    }
  }

  const appendEvent = (type, payload = {}) => {
    const event = { ts: nowFn(), type, ...payload }
    try {
      fs.mkdirSync(path.dirname(EVENTS_FILE), { recursive: true })
      fs.appendFileSync(EVENTS_FILE, `${JSON.stringify(event)}\n`, 'utf8')
    } catch (error) {
      logger(`[RESOURCE][EVENT][ERROR] detail=${error instanceof Error ? error.message : String(error)}`)
    }
    logger(`[RESOURCE][EVENT] type=${type} holder=${payload.holder || '-'} result=${payload.result || '-'} detail=${payload.detail || ''}`)
    return event
  }

  const readRecentEvents = (limit = MAX_EVENT_READ_TAIL) => {
    try {
      if (!fs.existsSync(EVENTS_FILE)) return []
      const lines = fs.readFileSync(EVENTS_FILE, 'utf8').split('\n').filter(Boolean)
      const tail = lines.slice(-Math.max(1, limit))
      const events = []
      for (const line of tail) {
        try {
          events.push(JSON.parse(line))
        } catch {
          // 损坏行跳过，不猜测
        }
      }
      return events.reverse()
    } catch {
      return []
    }
  }

  // ---- 交换互斥锁：任何 load/unload 编排串行执行 ----
  const withSwapLock = async (fn) => {
    while (swapInFlight) {
      await swapInFlight.catch(() => {})
    }
    const run = (async () => fn())()
    swapInFlight = run
    try {
      return await run
    } finally {
      if (swapInFlight === run) swapInFlight = null
    }
  }

  // 轮询直到条件满足或超时；cond 为 async 探测
  const waitUntil = async (cond, timeoutMsValue, label) => {
    const deadline = Date.now() + timeoutMsValue
    let lastDetail = ''
    for (;;) {
      try {
        const probe = await cond()
        if (probe?.ok) return { ok: true }
        lastDetail = probe?.detail || ''
      } catch (error) {
        lastDetail = error instanceof Error ? error.message : String(error)
      }
      if (Date.now() >= deadline) {
        return { ok: false, detail: `${label}_timeout${lastDetail ? `:${lastDetail}` : ''}` }
      }
      await sleepFn(pollMs)
    }
  }

  // 带重试的 unload：默认重试 2 次（共 3 次尝试），仍失败抛显式错误
  const unloadModelWithRetry = async (modelId, holder) => {
    let lastDetail = ''
    for (let attempt = 0; attempt <= retryMax; attempt += 1) {
      const result = await omlxClient.unloadModel(modelId)
      if (result?.ok) {
        // unload 指令已接受，确认模型真正退出 loaded 状态
        const settled = await waitUntil(async () => {
          const status = await omlxClient.getModelStatus()
          if (!status.ok) return { ok: false, detail: status.detail || 'status_unreachable' }
          const entry = status.models.find((m) => m.id === modelId)
          const gone = !entry || (entry.loaded !== true && entry.isLoading !== true)
          return gone ? { ok: true } : { ok: false, detail: 'still_loaded' }
        }, unloadTimeout, 'unload_settle')
        if (settled.ok) return { ok: true, attempt }
        lastDetail = settled.detail
      } else {
        lastDetail = result?.detail || 'unload_request_failed'
      }
      if (attempt < retryMax) {
        appendEvent('swap_unload_retry', { holder, model: modelId, attempt: attempt + 1, detail: lastDetail })
        await sleepFn(pollMs)
      }
    }
    return { ok: false, detail: lastDetail || 'unload_failed' }
  }

  // 交换到 gpu：卸载全部已加载模型（含非配置模型，顺带单模型守卫）-> health 确认释放
  const swapToGpu = (holder) => withSwapLock(async () => {
    const startedAt = Date.now()
    appendEvent('swap_to_gpu_start', { holder, configuredModel: resolveModel() || null })
    const status = await omlxClient.getModelStatus()
    if (!status.ok) {
      appendEvent('swap_to_gpu_failed', { holder, result: 'failed', detail: `status_unreachable:${status.detail || 'unknown'}` })
      throw new Error(`resource_swap_unload_failed:omlx_status_unreachable:${status.detail || 'unknown'}`)
    }
    const loaded = status.models.filter((m) => m.id && (m.loaded || m.isLoading))
    for (const entry of loaded) {
      const unloaded = await unloadModelWithRetry(entry.id, holder)
      if (!unloaded.ok) {
        appendEvent('swap_to_gpu_failed', { holder, model: entry.id, result: 'failed', detail: unloaded.detail })
        throw new Error(`resource_swap_unload_failed:${entry.id}:${unloaded.detail}`)
      }
    }
    // health 探测确认内存释放（loaded_count 归零；OMLX 不可达视为已释放以外的显式失败）
    if (loaded.length > 0) {
      const released = await waitUntil(async () => {
        const health = await omlxClient.getHealth()
        if (!health.ok) return { ok: false, detail: health.detail || 'health_unreachable' }
        return Number(health.loadedCount) === 0 ? { ok: true } : { ok: false, detail: `loaded_count=${health.loadedCount}` }
      }, unloadTimeout, 'memory_release')
      if (!released.ok) {
        appendEvent('swap_to_gpu_failed', { holder, result: 'failed', detail: released.detail })
        throw new Error(`resource_swap_unload_failed:memory_release:${released.detail}`)
      }
    }
    const unloadMs = Date.now() - startedAt
    lastSwap = { direction: 'to_gpu', at: nowFn(), unloadMs, loadMs: null, result: 'ok', holder }
    appendEvent('swap_to_gpu_ok', { holder, result: 'ok', unloadedCount: loaded.length, unload_ms: unloadMs })
  })

  // 交换到 llm：回载配置模型 -> 探测加载成功；失败显式置 blocked
  const swapToLlm = (holder, { trigger } = {}) => withSwapLock(async () => {
    const model = resolveModel()
    if (!model) {
      const detail = 'configured_model_missing'
      appendEvent('swap_to_llm_failed', { holder, trigger: trigger || null, result: 'failed', detail })
      slotState = RESOURCE_SLOT_STATE.BLOCKED
      blockedInfo = { reason: 'resource_swap_load_failed', detail, at: nowFn() }
      persistState()
      throw new Error(`resource_swap_load_failed:${detail}`)
    }
    const startedAt = Date.now()
    appendEvent('swap_to_llm_start', { holder, trigger: trigger || null, model })
    let lastDetail = ''
    for (let attempt = 0; attempt <= retryMax; attempt += 1) {
      const loadResult = await omlxClient.loadModel(model)
      if (loadResult?.ok) {
        const settled = await waitUntil(async () => {
          const status = await omlxClient.getModelStatus()
          if (!status.ok) return { ok: false, detail: status.detail || 'status_unreachable' }
          const entry = status.models.find((m) => m.id === model)
          return entry?.loaded === true && entry.isLoading !== true ? { ok: true } : { ok: false, detail: 'not_loaded_yet' }
        }, loadTimeout, 'model_load')
        if (settled.ok) {
          const loadMs = Date.now() - startedAt
          slotState = RESOURCE_SLOT_STATE.LLM
          blockedInfo = null
          lastSwap = { direction: 'to_llm', at: nowFn(), unloadMs: null, loadMs, result: 'ok', holder }
          persistState()
          appendEvent('swap_to_llm_ok', { holder, trigger: trigger || null, model, result: 'ok', load_ms: loadMs })
          return { ok: true, loadMs }
        }
        lastDetail = settled.detail
      } else {
        lastDetail = loadResult?.detail || 'load_request_failed'
      }
      if (attempt < retryMax) {
        appendEvent('swap_load_retry', { holder, model, attempt: attempt + 1, detail: lastDetail })
        await sleepFn(pollMs)
      }
    }
    // 装载失败：显式 blocked，不静默继续
    slotState = RESOURCE_SLOT_STATE.BLOCKED
    blockedInfo = { reason: 'resource_swap_load_failed', detail: `${model}:${lastDetail || 'load_failed'}`, at: nowFn() }
    persistState()
    appendEvent('swap_to_llm_failed', { holder, trigger: trigger || null, model, result: 'failed', detail: lastDetail || 'load_failed' })
    throw new Error(`resource_swap_load_failed:${model}:${lastDetail || 'load_failed'}`)
  })

  // gpu 批次终结后的 settle 窗口：窗口内新 gpu 申请取消 reload（出图攒批）
  const scheduleSwapBackToLlm = (holder) => {
    if (settleTimer) {
      clearTimeout(settleTimer)
      settleTimer = null
    }
    settleTimer = setTimeout(() => {
      settleTimer = null
      if (gpuHolderKey !== null || gpuWaitQueue.length > 0) return // 已有新 gpu 占用/等待，不 reload
      void swapToLlm(holder, { trigger: 'gpu_batch_end' }).catch((error) => {
        // swapToLlm 内部已置 blocked + 落事件，这里只留日志
        logger(`[RESOURCE][SWAP_BACK][ERROR] detail=${error instanceof Error ? error.message : String(error)}`)
      })
    }, settleMs)
  }

  // gpu 等待队列驱动：writer 优先，等 llm 持有者自然收尾（step 边界，不掐断运行中推理）
  const pumpGpuQueue = async () => {
    if (gpuPumping) return
    gpuPumping = true
    try {
      for (;;) {
        const next = gpuWaitQueue[0]
        if (!next) break
        const aborted = typeof next.shouldAbort === 'function' ? next.shouldAbort() : null
        if (aborted?.aborted) {
          gpuWaitQueue.shift()
          next.resolve({ admitted: false, reason: aborted.reason || 'aborted' })
          continue
        }
        if (gpuHolderKey !== null) break // 他人持有 gpu，等 release 触发 pump
        if (llmHolderKeys.size > 0) {
          await sleepFn(pollMs) // 等运行中的 llm step 收尾
          continue
        }
        try {
          await swapToGpu(next.holderKey)
          gpuHolderKey = next.holderKey
          gpuAcquiredAt = nowFn()
          slotState = RESOURCE_SLOT_STATE.GPU
          blockedInfo = null
          persistState()
          gpuWaitQueue.shift()
          next.resolve({ admitted: true })
        } catch (error) {
          gpuWaitQueue.shift()
          next.reject(error) // 交换失败显式抛出，由 step 失败语义收敛
        }
      }
    } finally {
      gpuPumping = false
    }
  }

  const acquireGpu = (holderKey, { shouldAbort } = {}) => new Promise((resolve, reject) => {
    if (settleTimer) {
      clearTimeout(settleTimer) // 攒批：窗口内新 gpu 申请取消待执行的 reload
      settleTimer = null
    }
    // 等待中的取消/超时看守：gpu 批次可能很长，等待者必须在 abort 时显式退出，
    // 不能把 B04 取消/超时语义拖延到他人 release 之后
    const waiter = {
      holderKey,
      shouldAbort,
      resolve: (value) => {
        clearInterval(abortWatch)
        resolve(value)
      },
      reject: (error) => {
        clearInterval(abortWatch)
        reject(error)
      }
    }
    const abortWatch = setInterval(() => {
      const aborted = typeof shouldAbort === 'function' ? shouldAbort() : null
      if (!aborted?.aborted) return
      const idx = gpuWaitQueue.indexOf(waiter)
      if (idx < 0) return // 已被 pump 取出（交换进行中或已放行），交换不中断，由竞速点收敛取消
      gpuWaitQueue.splice(idx, 1)
      waiter.resolve({ admitted: false, reason: aborted.reason || 'aborted' })
    }, pollMs)
    gpuWaitQueue.push(waiter)
    if (!gpuPumping && gpuHolderKey === null) void pumpGpuQueue()
  })

  const acquireLlm = async (holderKey, { shouldAbort, onWaitChange } = {}) => {
    llmWaiterCount += 1
    let waiting = false
    try {
      for (;;) {
        const aborted = typeof shouldAbort === 'function' ? shouldAbort() : null
        if (aborted?.aborted) return { admitted: false, reason: aborted.reason || 'aborted' }
        const gpuBusy = gpuHolderKey !== null || gpuWaitQueue.length > 0 || gpuPumping
        if (!gpuBusy) {
          if (slotState === RESOURCE_SLOT_STATE.LLM) {
            llmHolderKeys.add(holderKey)
            persistState()
            return { admitted: true }
          }
          // idle/blocked：确保配置模型在线（交换锁串行；装载失败显式抛出）
          if (!swapInFlight) {
            if (settleTimer) {
              clearTimeout(settleTimer) // llm 需求优先：取消 gpu 批次 settle 窗口的延迟 reload，立即加载
              settleTimer = null
            }
            try {
              await swapToLlm(holderKey, { trigger: slotState === RESOURCE_SLOT_STATE.BLOCKED ? 'llm_acquire_blocked_retry' : 'llm_acquire' })
            } catch (error) {
              throw error // 显式：resource_swap_load_failed
            }
          } else {
            await swapInFlight.catch(() => {})
            continue
          }
          if (slotState === RESOURCE_SLOT_STATE.LLM) {
            llmHolderKeys.add(holderKey)
            persistState()
            return { admitted: true }
          }
          continue
        }
        if (!waiting) {
          waiting = true
          onWaitChange?.(true, 'gpu_occupied')
        }
        await sleepFn(pollMs)
      }
    } finally {
      llmWaiterCount -= 1
      if (waiting) onWaitChange?.(false, null)
    }
  }

  // ---- 对外 API ----

  const acquire = async (kind, holder, options = {}) => {
    const holderKey = String(holder || '').trim()
    if (!holderKey) throw new Error('resource_acquire_requires_holder')
    if (kind === RESOURCE_KIND.GPU) return acquireGpu(holderKey, options)
    return acquireLlm(holderKey, options)
  }

  const release = (kind, holder) => {
    const holderKey = String(holder || '').trim()
    if (!holderKey) return { released: false }
    if (kind === RESOURCE_KIND.GPU) {
      if (gpuHolderKey !== holderKey) return { released: false }
      const heldSince = gpuAcquiredAt
      gpuHolderKey = null
      gpuAcquiredAt = null
      persistState()
      appendEvent('gpu_release', { holder: holderKey, heldSince, gpuQueueLength: gpuWaitQueue.length })
      if (gpuWaitQueue.length > 0) {
        void pumpGpuQueue() // 攒批：直接交棒下一个 gpu 申请，不 reload
      } else {
        scheduleSwapBackToLlm(holderKey)
      }
      return { released: true }
    }
    const removed = llmHolderKeys.delete(holderKey)
    if (removed) persistState()
    return { released: removed }
  }

  // 单模型守卫 + 漂移纠正 + 内存水位刷新（周期 reconcile）
  const reconcile = async ({ trigger = 'interval' } = {}) => {
    if (swapInFlight) {
      lastReconcile = { at: nowFn(), result: 'skipped', detail: 'swap_in_flight', trigger }
      return lastReconcile
    }
    const configuredModel = resolveModel()
    const status = await omlxClient.getModelStatus()
    const actions = []
    if (status.ok) {
      // 1. 单模型守卫：卸载非配置模型（如 default gpt-oss 被 OMLX 自动拉起）
      const foreign = status.models.filter((m) => m.id && m.id !== configuredModel && (m.loaded || m.isLoading))
      for (const entry of foreign) {
        const unloaded = await unloadModelWithRetry(entry.id, `reconcile:${trigger}`)
        actions.push({ action: 'guard_unload_foreign_model', model: entry.id, ok: unloaded.ok, detail: unloaded.ok ? null : unloaded.detail })
        appendEvent('guard_unload_foreign_model', { holder: `reconcile:${trigger}`, model: entry.id, result: unloaded.ok ? 'ok' : 'failed', detail: unloaded.ok ? null : unloaded.detail })
      }
      // 2. 漂移纠正：state=llm 但配置模型实际不在线 -> idle；
      //    反向：配置模型在线且槽位空闲（如启动后首次对齐）-> llm
      const configuredEntry = status.models.find((m) => m.id === configuredModel)
      const configuredLoaded = configuredEntry?.loaded === true && configuredEntry?.isLoading !== true
      if (slotState === RESOURCE_SLOT_STATE.LLM && !configuredLoaded) {
        slotState = RESOURCE_SLOT_STATE.IDLE
        persistState()
        actions.push({ action: 'drift_corrected', detail: 'configured_model_offline_while_llm' })
      } else if (slotState === RESOURCE_SLOT_STATE.IDLE && configuredLoaded && !blockedInfo) {
        slotState = RESOURCE_SLOT_STATE.LLM
        persistState()
        actions.push({ action: 'drift_corrected', detail: 'configured_model_online_while_idle' })
      }
      // 3. 配置模型缺席且有 llm 需求（或 blocked 自愈）-> 回载
      const llmDemand = llmHolderKeys.size > 0 || llmWaiterCount > 0
      if (!configuredLoaded && slotState !== RESOURCE_SLOT_STATE.GPU && configuredModel && (llmDemand || slotState === RESOURCE_SLOT_STATE.BLOCKED)) {
        try {
          await swapToLlm(`reconcile:${trigger}`, { trigger: slotState === RESOURCE_SLOT_STATE.BLOCKED ? 'guard_blocked_retry' : 'guard_reload_configured' })
          actions.push({ action: 'guard_reload_configured', model: configuredModel, ok: true })
        } catch (error) {
          actions.push({ action: 'guard_reload_configured', model: configuredModel, ok: false, detail: error instanceof Error ? error.message : String(error) })
        }
      }
    } else {
      actions.push({ action: 'status_unreachable', detail: status.detail || 'unknown' })
    }
    // 4. 内存水位缓存（供状态端点，不阻塞 reconcile 主流程）
    const health = await omlxClient.getHealth()
    if (health.ok) {
      memorySnapshot = {
        loadedCount: health.loadedCount,
        currentModelMemory: health.currentModelMemory,
        finalCeiling: health.finalCeiling,
        probedAt: nowFn()
      }
    }
    lastReconcile = {
      at: nowFn(),
      result: actions.some((a) => a.ok === false) ? 'error' : 'ok',
      detail: actions.length ? actions : null,
      trigger,
      reachable: status.ok === true
    }
    return lastReconcile
  }

  const getState = async ({ probe = true } = {}) => {
    let live = null
    if (probe) {
      // 状态端点实时探测：失败回落 reconcile 缓存，绝不抛错
      const health = await omlxClient.getHealth()
      if (health.ok) {
        live = {
          loadedCount: health.loadedCount,
          currentModelMemory: health.currentModelMemory,
          finalCeiling: health.finalCeiling,
          probedAt: nowFn()
        }
        memorySnapshot = live
      }
    }
    let modelOnline = null
    if (probe) {
      const status = await omlxClient.getModelStatus()
      if (status.ok) {
        const configuredModel = resolveModel()
        const entry = status.models.find((m) => m.id === configuredModel)
        modelOnline = {
          configuredModel: configuredModel || null,
          loaded: entry?.loaded === true && entry?.isLoading !== true,
          isLoading: entry?.isLoading === true,
          otherLoaded: status.models.filter((m) => m.id && m.id !== configuredModel && (m.loaded || m.isLoading)).map((m) => m.id)
        }
      }
    }
    const memory = live || memorySnapshot
    return {
      enabled: true,
      state: slotState,
      gpuHolder: gpuHolderKey ? { holder: gpuHolderKey, acquiredAt: gpuAcquiredAt } : null,
      llmHolders: [...llmHolderKeys],
      llmWaiters: llmWaiterCount,
      gpuQueueLength: gpuWaitQueue.length,
      swapInFlight: Boolean(swapInFlight),
      configuredModel: resolveModel() || null,
      modelOnline,
      memory: memory ? { ...memory, source: live ? 'live' : 'cache' } : null,
      blocked: blockedInfo,
      lastSwap,
      recentEvents: readRecentEvents(MAX_EVENT_READ_TAIL),
      reconcile: { intervalMs: reconcileEveryMs, running: !stopped, last: lastReconcile }
    }
  }

  loadPersistedState()

  return {
    acquire,
    release,
    reconcile,
    getState,
    resolveActionResourceKind,
    start() {
      if (!stopped) return
      stopped = false
      reconcileTimer = setInterval(() => {
        void reconcile({ trigger: 'interval' }).catch((error) => {
          logger(`[RESOURCE][RECONCILE][ERROR] detail=${error instanceof Error ? error.message : String(error)}`)
        })
      }, reconcileEveryMs)
      // 启动即跑一次守卫：对齐真实世界（含崩溃残留的 gpu 状态纠正）
      void reconcile({ trigger: 'startup' }).catch((error) => {
        logger(`[RESOURCE][RECONCILE][ERROR] detail=${error instanceof Error ? error.message : String(error)}`)
      })
    },
    stop() {
      stopped = true
      if (reconcileTimer) {
        clearInterval(reconcileTimer)
        reconcileTimer = null
      }
      if (settleTimer) {
        clearTimeout(settleTimer)
        settleTimer = null
      }
    },
    // 测试与运维只读快照（不触发 probe）
    getSnapshot() {
      return {
        state: slotState,
        gpuHolder: gpuHolderKey,
        llmHolders: [...llmHolderKeys],
        llmWaiters: llmWaiterCount,
        gpuQueueLength: gpuWaitQueue.length,
        blocked: blockedInfo,
        lastSwap
      }
    }
  }
}
