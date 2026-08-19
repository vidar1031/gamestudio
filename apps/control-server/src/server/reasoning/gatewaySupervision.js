/**
 * Hermes gateway 进程监督恢复。
 *
 * AUTO-C04：当 Hermes gateway 异常退出时，Control 能识别原因、记录事件、
 * 按有限退避尝试恢复，并在达到上限或不可恢复时把状态传播给受影响任务。
 *
 * 语义约定：
 * - 与 HERMES-G02 分工：G02 管 supervision 定时任务的 401 收敛；本模块管
 *   gateway 进程异常退出的监测与有限恢复。认证失败分类复用 G02 同一套规则
 *   （core 接线时注入 isAuthFailureError，模块内置同源默认实现）。
 * - 生命周期硬边界：由 stop/pause/exit/all-restart 发起的关停
 *   （wasStoppingIntentionally()=true）只记录 manual_lifecycle 事件，
 *   绝不自动拉起，绝不做任务传播——生命周期控制语义不可被监督器替代。
 * - exit 分类是确定性规则：manual > auth（401/Unauthorized）> config（未安装）
 *   > crash（其余一律按可恢复崩溃处理，但受重启上限约束，绝不无限循环）。
 * - 任务传播复用阶段 2 设施，不新造恢复通道：
 *   - 可恢复退出：受影响 running/pausing/resuming session 标 failed
 *     （错误文本命中 C02 retryPolicy 的临时故障模式），由队列 worker 按
 *     retryPolicy 调度 retry_wait 退避重试；
 *   - 达上限/不可恢复：受影响 running/retry_wait session 直接转 blocked
 *     （终态），队列 item 由 worker tick 镜像终结，不无限循环；
 *   - 恢复成功：不主动改任何任务状态——retry_wait 到点后因 canExecute
 *     恢复通过而重新可领取；仅挑选合法、未取消的等待任务写入恢复事件
 *     并 kick 队列。已 cancelled/终态任务绝不动。
 * - 默认关闭（HERMES_GATEWAY_SUPERVISION_ENABLED=true 启用），与 G02 一致的
 *   安全默认；关闭时既有 health-check 恢复行为完全不变。
 * - 本模块不直接碰文件系统与真实进程：probe/restart/会话操作全部注入，
 *   事件经 onEvent 外发（core 落 JSONL + 结构化日志），便于毫秒级时钟测试。
 */

import {
  REASONING_SESSION_STATE,
  isTerminalSessionState,
  normalizeLegacySessionStatus
} from './sessionStateMachine.js'
import { listQueueItems, isTerminalQueueItemState } from './persistentQueue.js'

// gateway exit 分类
export const GATEWAY_EXIT_CATEGORY = Object.freeze({
  MANUAL_LIFECYCLE: 'manual_lifecycle',
  UNRECOVERABLE_AUTH: 'unrecoverable_auth',
  UNRECOVERABLE_CONFIG: 'unrecoverable_config',
  RECOVERABLE_CRASH: 'recoverable_crash'
})

// 监督器状态
export const GATEWAY_SUPERVISION_STATUS = Object.freeze({
  DISABLED: 'disabled',
  MONITORING: 'monitoring',
  BACKING_OFF: 'backing_off',
  RESTARTING: 'restarting',
  BLOCKED: 'blocked'
})

// 重启次数上限：HERMES_GATEWAY_RESTART_MAX_ATTEMPTS 可覆盖，默认 3 次；0 = 不自动重启
const DEFAULT_RESTART_MAX_ATTEMPTS = 3
// 退避基数：HERMES_GATEWAY_RESTART_BASE_MS 可覆盖，默认 2000ms
const DEFAULT_RESTART_BASE_MS = 2000
// 退避上限：HERMES_GATEWAY_RESTART_MAX_DELAY_MS 可覆盖，默认 30000ms
const DEFAULT_RESTART_MAX_DELAY_MS = 30000
// 健康窗口：持续健康超过该时长后重启次数归零，HERMES_GATEWAY_HEALTHY_RESET_MS 可覆盖，默认 5 分钟
const DEFAULT_HEALTHY_RESET_MS = 5 * 60 * 1000
// 监测轮询间隔：HERMES_GATEWAY_SUPERVISION_POLL_MS 可覆盖，默认 5000ms
const DEFAULT_POLL_MS = 5000
// 内存事件历史上限
const MAX_RECENT_EVENTS = 20

export function isGatewaySupervisionEnabled(value) {
  const raw = value ?? process.env.HERMES_GATEWAY_SUPERVISION_ENABLED
  return String(raw || '').trim() === 'true'
}

export function resolveGatewayRestartMaxAttempts(value) {
  const raw = value ?? process.env.HERMES_GATEWAY_RESTART_MAX_ATTEMPTS
  if (raw === undefined || raw === null || raw === '') return DEFAULT_RESTART_MAX_ATTEMPTS
  const num = Number(raw)
  if (!Number.isFinite(num) || num < 0) return DEFAULT_RESTART_MAX_ATTEMPTS
  return Math.floor(num)
}

export function resolveGatewayRestartBaseMs(value) {
  const raw = value ?? process.env.HERMES_GATEWAY_RESTART_BASE_MS
  const num = Number(raw)
  if (!Number.isFinite(num) || num <= 0) return DEFAULT_RESTART_BASE_MS
  return Math.floor(num)
}

export function resolveGatewayRestartMaxDelayMs(value) {
  const raw = value ?? process.env.HERMES_GATEWAY_RESTART_MAX_DELAY_MS
  const num = Number(raw)
  if (!Number.isFinite(num) || num <= 0) return DEFAULT_RESTART_MAX_DELAY_MS
  return Math.floor(num)
}

export function resolveGatewayHealthyResetMs(value) {
  const raw = value ?? process.env.HERMES_GATEWAY_HEALTHY_RESET_MS
  const num = Number(raw)
  if (!Number.isFinite(num) || num <= 0) return DEFAULT_HEALTHY_RESET_MS
  return Math.floor(num)
}

export function resolveGatewaySupervisionPollMs(value) {
  const raw = value ?? process.env.HERMES_GATEWAY_SUPERVISION_POLL_MS
  const num = Number(raw)
  if (!Number.isFinite(num) || num <= 0) return DEFAULT_POLL_MS
  return Math.max(10, Math.floor(num))
}

/**
 * 指数退避：第 1 次重启 = baseMs，之后每次翻倍，封顶 maxDelayMs。
 * 与 retryPolicy.computeRetryBackoffMs 同一语义，独立实现避免跨关注点耦合。
 */
export function computeGatewayRestartBackoffMs(attempt, { baseMs, maxDelayMs } = {}) {
  const base = Math.max(1, Number(baseMs) || DEFAULT_RESTART_BASE_MS)
  const cap = Math.max(base, Number(maxDelayMs) || DEFAULT_RESTART_MAX_DELAY_MS)
  const n = Math.max(1, Math.floor(Number(attempt) || 1))
  return Math.min(cap, base * 2 ** (n - 1))
}

// 与 G02 isAuthFailureError 同源的默认认证失败判定；
// core 接线时应显式注入 G02 的 isAuthFailureError 保证单一事实源。
function defaultIsAuthFailureLike(message) {
  return /\b401\b|Unauthorized|unauthorized|认证失败|auth/i.test(String(message || ''))
}

/**
 * 确定性 exit 分类（纯函数）。输入：
 * - intentionalStop：生命周期控制发起的关停（最高优先级，硬边界）
 * - installed：Hermes 是否已安装（未安装 = 配置缺失，不可恢复）
 * - detail：退出相关错误文本（故障快照/日志尾/重启失败 detail）
 * - isAuthFailure：认证失败判定（注入，默认 G02 同源规则）
 * 输出：{ category, reason, recoverable }
 */
export function classifyGatewayExit({ intentionalStop = false, installed = true, detail = '', isAuthFailure = defaultIsAuthFailureLike } = {}) {
  if (intentionalStop) {
    return {
      category: GATEWAY_EXIT_CATEGORY.MANUAL_LIFECYCLE,
      reason: 'manual_lifecycle_stop',
      recoverable: false,
      detail: '生命周期控制发起的关停（stop/pause/exit/all-restart），监督器不自动拉起。'
    }
  }
  const text = String(detail || '')
  if (text && isAuthFailure(text)) {
    return {
      category: GATEWAY_EXIT_CATEGORY.UNRECOVERABLE_AUTH,
      reason: 'gateway_auth_failure',
      recoverable: false,
      detail: `gateway 退出与认证失败相关（${text.slice(0, 200)}），重启必现，不自动重启。`
    }
  }
  if (!installed) {
    return {
      category: GATEWAY_EXIT_CATEGORY.UNRECOVERABLE_CONFIG,
      reason: 'gateway_uninstalled_or_config_missing',
      recoverable: false,
      detail: 'Hermes 未安装或配置缺失，无法自动恢复。'
    }
  }
  return {
    category: GATEWAY_EXIT_CATEGORY.RECOVERABLE_CRASH,
    reason: 'gateway_unexpected_exit',
    recoverable: true,
    detail: text ? `gateway 异常退出（${text.slice(0, 200)}），按有限退避尝试恢复。` : 'gateway 异常退出（进程消失，无更多错误文本），按有限退避尝试恢复。'
  }
}

// 受 gateway 退出影响的 session 状态：活跃执行中 + 重试等待。
// queued（未开始）只是延迟、waiting_review 等人工、paused 由人控制，均不传播。
const GATEWAY_EXIT_AFFECTED_STATUSES = new Set([
  REASONING_SESSION_STATE.RUNNING,
  REASONING_SESSION_STATE.PAUSING,
  REASONING_SESSION_STATE.RESUMING,
  REASONING_SESSION_STATE.RETRY_WAIT
])

export function isGatewayExitAffectedSession(session) {
  const status = normalizeLegacySessionStatus(session?.status)
  return GATEWAY_EXIT_AFFECTED_STATUSES.has(status)
}

/**
 * 恢复成功后「仅恢复合法、未取消的等待任务」的挑选（纯函数）：
 * - session 处于 retry_wait / queued（等待调度）；
 * - 对应 queue item 存在且非终态（已 cancelled/failed/blocked 等终态绝不恢复）；
 * - session 本身非终态、非 cancelled（防御：normalize 后不可能但显式排除）。
 * 返回 [{ sessionId, status, taskId, projectId }]。真正的恢复由队列 worker
 * 到点领取完成（canExecute 随 runtime 恢复通过），本函数只产出证据清单。
 */
export function selectGatewayRestorableWaitingTasks(sessions, items) {
  const itemBySession = new Map(
    (Array.isArray(items) ? items : [])
      .filter((item) => item && item.sessionId)
      .map((item) => [item.sessionId, item])
  )
  const restorable = []
  for (const session of Array.isArray(sessions) ? sessions : []) {
    const status = normalizeLegacySessionStatus(session?.status)
    if (status !== REASONING_SESSION_STATE.RETRY_WAIT && status !== REASONING_SESSION_STATE.QUEUED) continue
    if (isTerminalSessionState(status) || status === REASONING_SESSION_STATE.CANCELLED) continue
    const item = itemBySession.get(session.sessionId)
    if (!item || isTerminalQueueItemState(item.status)) continue
    restorable.push({
      sessionId: session.sessionId,
      status,
      taskId: item.taskId || session.sessionId,
      projectId: item.projectId || null
    })
  }
  return restorable
}

/**
 * 创建 gateway 监督器（依赖全注入，便于毫秒级时钟测试）。
 * - probe() -> { installed, running, pid }（同步）
 * - wasStoppingIntentionally() -> boolean：生命周期关停硬边界
 * - restart(attempt) -> Promise<{ ok, state, detail }>
 * - getFaultDetail() -> string|null：最近故障快照/日志尾（进事件与分类）
 * - isAuthFailure(message) -> boolean：注入 G02 isAuthFailureError
 * - listAffectedSessions() -> [{ sessionId, status, ... }]
 * - failSession(sessionId, error)：可恢复退出时传播（retryable 分类消息）
 * - blockSession(sessionId, reason)：达上限/不可恢复时收敛 blocked
 * - appendSessionEvent(sessionId, type, title, summary, extra)
 * - kickQueue()：恢复成功后唤醒队列 worker
 * - listQueueItemsFn() -> { items }：恢复资格判定（默认真实队列）
 * - onEvent(event)：监督事件 sink（core 落 JSONL + 结构化日志）
 * - pollMs/maxAttempts/baseMs/maxDelayMs/healthyResetMs：时序参数（可毫秒级注入）
 * - enabled：默认取 HERMES_GATEWAY_SUPERVISION_ENABLED
 */
export function createGatewaySupervisor({
  probe,
  wasStoppingIntentionally = () => false,
  restart,
  getFaultDetail = () => null,
  isAuthFailure = defaultIsAuthFailureLike,
  listAffectedSessions = () => [],
  failSession = () => {},
  blockSession = () => {},
  appendSessionEvent = () => {},
  kickQueue = () => {},
  listQueueItemsFn = listQueueItems,
  onEvent = () => {},
  pollMs,
  maxAttempts,
  baseMs,
  maxDelayMs,
  healthyResetMs,
  nowFn = () => Date.now(),
  logger = () => {},
  enabled
} = {}) {
  if (typeof probe !== 'function') throw new Error('gateway_supervisor_requires_probe')
  if (typeof restart !== 'function') throw new Error('gateway_supervisor_requires_restart')

  const isEnabled = enabled !== undefined ? Boolean(enabled) : isGatewaySupervisionEnabled()
  const intervalMs = resolveGatewaySupervisionPollMs(pollMs)
  const restartLimit = resolveGatewayRestartMaxAttempts(maxAttempts)
  const backoffBaseMs = resolveGatewayRestartBaseMs(baseMs)
  const backoffMaxMs = resolveGatewayRestartMaxDelayMs(maxDelayMs)
  const healthyWindowMs = resolveGatewayHealthyResetMs(healthyResetMs)

  let status = isEnabled ? GATEWAY_SUPERVISION_STATUS.MONITORING : GATEWAY_SUPERVISION_STATUS.DISABLED
  let pollTimer = null
  let restartTimer = null
  let restartInFlight = false
  let restartAttempts = 0
  let wasRunning = false
  let healthySince = null
  let lastExit = null
  let lastRecovery = null
  let blockedInfo = null
  const recentEvents = []
  // 本次故障窗口内被监督器主动标 failed 的 session：达上限/不可恢复时
  // 它们同样要收敛 blocked（否则卡在非终态 failed，无人负责收敛）
  const gatewayMarkedFailed = new Set()

  const emitEvent = (type, data = {}) => {
    const event = {
      type,
      at: new Date(nowFn()).toISOString(),
      restartAttempts,
      ...data
    }
    recentEvents.push(event)
    if (recentEvents.length > MAX_RECENT_EVENTS) recentEvents.shift()
    try {
      onEvent(event)
    } catch (error) {
      logger(`[GATEWAY-SUPERVISION][EVENT][ERROR] type=${type} detail=${error instanceof Error ? error.message : String(error)}`)
    }
    return event
  }

  const collectAffectedTasks = () => {
    try {
      return listAffectedSessions()
        .filter((session) => isGatewayExitAffectedSession(session))
        .map((session) => ({ sessionId: session.sessionId, status: normalizeLegacySessionStatus(session.status) }))
    } catch (error) {
      logger(`[GATEWAY-SUPERVISION][AFFECTED][ERROR] detail=${error instanceof Error ? error.message : String(error)}`)
      return []
    }
  }

  // 阻断传播目标 = 当前受影响任务 ∪ 本窗口内被标 failed 且仍停在 failed 的任务
  const collectPropagationTargets = () => {
    const targets = collectAffectedTasks()
    if (gatewayMarkedFailed.size === 0) return targets
    const seen = new Set(targets.map((task) => task.sessionId))
    try {
      for (const session of listAffectedSessions()) {
        if (!gatewayMarkedFailed.has(session.sessionId) || seen.has(session.sessionId)) continue
        if (normalizeLegacySessionStatus(session.status) !== REASONING_SESSION_STATE.FAILED) continue
        seen.add(session.sessionId)
        targets.push({ sessionId: session.sessionId, status: REASONING_SESSION_STATE.FAILED })
      }
    } catch {
      // 收集失败退化为仅当前受影响集合
    }
    return targets
  }

  // 达上限/不可恢复：受影响 session 收敛 blocked（终态），队列 item 由 worker tick 镜像终结
  const propagateBlocked = (affectedTasks, reason) => {
    for (const task of affectedTasks) {
      try {
        blockSession(task.sessionId, reason)
        appendSessionEvent(
          task.sessionId,
          'session_gateway_blocked',
          'gateway 不可恢复，任务已阻断',
          `gateway 监督收敛：${reason}`,
          { data: { reason, source: 'gateway_supervision' } }
        )
      } catch (error) {
        logger(`[GATEWAY-SUPERVISION][BLOCK][ERROR] sessionId=${task.sessionId} detail=${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }

  const enterBlocked = (kind, reason) => {
    const targets = collectPropagationTargets()
    status = GATEWAY_SUPERVISION_STATUS.BLOCKED
    blockedInfo = { reason, at: new Date(nowFn()).toISOString() }
    propagateBlocked(targets, reason)
    gatewayMarkedFailed.clear()
    emitEvent(kind, { reason, affectedTasks: targets })
    logger(`[GATEWAY-SUPERVISION][BLOCKED] kind=${kind} reason=${reason} affected=${targets.length}`)
  }

  const scheduleRestart = () => {
    if (restartAttempts >= restartLimit) {
      enterBlocked(
        'gateway_restart_exhausted',
        `gateway_restart_exhausted:attempts=${restartAttempts}/${restartLimit}`
      )
      return
    }
    restartAttempts += 1
    const backoffMs = computeGatewayRestartBackoffMs(restartAttempts, { baseMs: backoffBaseMs, maxDelayMs: backoffMaxMs })
    status = GATEWAY_SUPERVISION_STATUS.BACKING_OFF
    emitEvent('gateway_restart_scheduled', { attempt: restartAttempts, maxAttempts: restartLimit, backoffMs })
    logger(`[GATEWAY-SUPERVISION][RESTART][SCHEDULED] attempt=${restartAttempts}/${restartLimit} backoffMs=${backoffMs}`)
    restartTimer = setTimeout(() => {
      restartTimer = null
      void runRestartAttempt()
    }, backoffMs)
    if (typeof restartTimer.unref === 'function') restartTimer.unref()
  }

  const runRestartAttempt = async () => {
    if (restartInFlight) return
    restartInFlight = true
    status = GATEWAY_SUPERVISION_STATUS.RESTARTING
    try {
      const result = await restart(restartAttempts)
      if (result && result.ok) {
        status = GATEWAY_SUPERVISION_STATUS.MONITORING
        blockedInfo = null
        wasRunning = true
        healthySince = nowFn()
        lastRecovery = new Date(nowFn()).toISOString()
        // 恢复成功：仅挑选合法、未取消的等待任务写入证据；实际恢复由队列
        // worker 到点领取完成（canExecute 随 runtime 恢复通过），不新造通道
        let restorable = []
        try {
          const sessions = listAffectedSessions()
          const { items } = listQueueItemsFn()
          restorable = selectGatewayRestorableWaitingTasks(sessions, items)
        } catch (error) {
          logger(`[GATEWAY-SUPERVISION][RESTORE][ERROR] detail=${error instanceof Error ? error.message : String(error)}`)
        }
        emitEvent('gateway_recovered', {
          attempt: restartAttempts,
          restoredTasks: restorable,
          detail: `gateway 第 ${restartAttempts} 次重启恢复成功，${restorable.length} 个等待任务恢复可调度。`
        })
        logger(`[GATEWAY-SUPERVISION][RECOVERED] attempt=${restartAttempts} restored=${restorable.length}`)
        gatewayMarkedFailed.clear()
        kickQueue()
        return
      }
      // 重启失败：按 detail 再分类——认证/配置类不可恢复立即收敛，其余继续退避
      const detail = String(result?.detail || 'restart_failed')
      const classification = classifyGatewayExit({ intentionalStop: false, installed: true, detail, isAuthFailure })
      if (!classification.recoverable) {
        enterBlocked('gateway_unrecoverable', `${classification.reason}:${detail.slice(0, 160)}`)
        return
      }
      emitEvent('gateway_restart_failed', { attempt: restartAttempts, maxAttempts: restartLimit, detail: detail.slice(0, 300) })
      logger(`[GATEWAY-SUPERVISION][RESTART][FAILED] attempt=${restartAttempts}/${restartLimit} detail=${detail.slice(0, 200)}`)
      scheduleRestart()
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      emitEvent('gateway_restart_failed', { attempt: restartAttempts, maxAttempts: restartLimit, detail: detail.slice(0, 300) })
      logger(`[GATEWAY-SUPERVISION][RESTART][ERROR] attempt=${restartAttempts}/${restartLimit} detail=${detail.slice(0, 200)}`)
      scheduleRestart()
    } finally {
      restartInFlight = false
    }
  }

  const handleGatewayExit = (probeResult) => {
    const affectedTasks = collectAffectedTasks()
    const faultDetail = (() => {
      try {
        return getFaultDetail()
      } catch {
        return null
      }
    })()
    const classification = classifyGatewayExit({
      intentionalStop: Boolean(wasStoppingIntentionally()),
      installed: probeResult.installed !== false,
      detail: faultDetail ? String(faultDetail) : '',
      isAuthFailure
    })
    lastExit = {
      at: new Date(nowFn()).toISOString(),
      pid: probeResult.pid ?? null,
      category: classification.category,
      reason: classification.reason,
      affectedTasks
    }
    emitEvent('gateway_exit', {
      pid: probeResult.pid ?? null,
      category: classification.category,
      reason: classification.reason,
      detail: classification.detail,
      affectedTasks
    })
    logger(`[GATEWAY-SUPERVISION][EXIT] category=${classification.category} reason=${classification.reason} pid=${probeResult.pid ?? '-'} affected=${affectedTasks.length}`)

    // 硬边界：生命周期关停只记录事件，绝不自动拉起、绝不传播任务状态
    if (classification.category === GATEWAY_EXIT_CATEGORY.MANUAL_LIFECYCLE) {
      status = GATEWAY_SUPERVISION_STATUS.MONITORING
      return
    }
    if (!classification.recoverable) {
      enterBlocked('gateway_unrecoverable', `${classification.reason}`)
      return
    }
    // 可恢复退出：受影响活跃 session 标 failed，错误文本命中 C02 retryPolicy
    // 临时故障模式（service unavailable），由队列 worker 调度 retry_wait 退避重试；
    // 被标 failed 的 session 记入本故障窗口集合，达上限/不可恢复时一并收敛 blocked
    for (const task of affectedTasks) {
      if (normalizeLegacySessionStatus(task.status) === REASONING_SESSION_STATE.RETRY_WAIT) continue
      try {
        failSession(task.sessionId, new Error(`hermes_gateway_exit:${classification.reason}:gateway service unavailable`))
        gatewayMarkedFailed.add(task.sessionId)
      } catch (error) {
        logger(`[GATEWAY-SUPERVISION][FAIL][ERROR] sessionId=${task.sessionId} detail=${error instanceof Error ? error.message : String(error)}`)
      }
    }
    scheduleRestart()
  }

  const tick = () => {
    if (!isEnabled) return
    let probeResult
    try {
      probeResult = probe() || {}
    } catch (error) {
      logger(`[GATEWAY-SUPERVISION][PROBE][ERROR] detail=${error instanceof Error ? error.message : String(error)}`)
      return
    }
    const running = Boolean(probeResult.running)
    if (running) {
      // 人工恢复（blocked 后 resume）：回到监测，重启次数待健康窗口后归零
      if (status === GATEWAY_SUPERVISION_STATUS.BLOCKED) {
        status = GATEWAY_SUPERVISION_STATUS.MONITORING
        blockedInfo = null
        emitEvent('gateway_supervision_resumed', { detail: '人工恢复后 gateway 重新健康，监督器回到监测状态。' })
        logger('[GATEWAY-SUPERVISION][RESUMED] gateway healthy again after blocked')
      }
      if (!wasRunning) healthySince = nowFn()
      if (restartAttempts > 0 && healthySince !== null && nowFn() - healthySince >= healthyWindowMs) {
        logger(`[GATEWAY-SUPERVISION][RESET] healthy window ${healthyWindowMs}ms reached, restartAttempts ${restartAttempts} -> 0`)
        restartAttempts = 0
      }
      wasRunning = true
      return
    }
    healthySince = null
    if (!wasRunning) return // 从未观测到运行（如启动初期），不把初始 down 当 exit
    wasRunning = false
    if (restartInFlight || restartTimer) return // 重启流程已接管，避免重复判 exit
    handleGatewayExit(probeResult)
  }

  return {
    start() {
      if (!isEnabled || pollTimer) return
      // 初始观测：以当前 probe 为基线，不把启动初期的 down 误判为 exit
      try {
        const initial = probe() || {}
        wasRunning = Boolean(initial.running)
        if (wasRunning) healthySince = nowFn()
      } catch {
        wasRunning = false
      }
      pollTimer = setInterval(tick, intervalMs)
      if (typeof pollTimer.unref === 'function') pollTimer.unref()
      logger(`[GATEWAY-SUPERVISION][START] pollMs=${intervalMs} maxAttempts=${restartLimit} backoff=${backoffBaseMs}/${backoffMaxMs}ms`)
    },
    stop() {
      if (pollTimer) { clearInterval(pollTimer); pollTimer = null }
      if (restartTimer) { clearTimeout(restartTimer); restartTimer = null }
    },
    // 手动 tick：测试与运维的显式驱动入口
    tick,
    getState() {
      return {
        enabled: isEnabled,
        status,
        restartAttempts,
        maxAttempts: restartLimit,
        backoffBaseMs,
        backoffMaxMs,
        healthyWindowMs,
        pollMs: intervalMs,
        lastExit,
        lastRecovery,
        blocked: blockedInfo,
        healthySince: healthySince === null ? null : new Date(healthySince).toISOString(),
        recentEvents: [...recentEvents]
      }
    }
  }
}
