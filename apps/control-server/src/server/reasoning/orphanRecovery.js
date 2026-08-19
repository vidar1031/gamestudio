/**
 * orphan 判定与恢复资格。
 *
 * AUTO-B03：重启或心跳过期的非终结 session 经状态机收敛为 orphaned；
 * 证据完整（最新 checkpoint 合法且恢复次数未超限）的 orphan 只允许从
 * checkpoint 的 nextStepIndex 恢复，已成功 step 不重跑；
 * checkpoint 缺失、损坏或恢复次数超限的 orphan 转 blocked，不猜测继续。
 *
 * 旧的「failed + orphaned by server restart」语义由本模块的 orphaned 状态替代。
 */

import fs from 'node:fs'
import path from 'node:path'
import {
  REASONING_SESSION_STATE,
  isTerminalSessionState,
  applySessionTransition,
  normalizeLegacySessionStatus
} from './sessionStateMachine.js'
import { listStepCheckpoints } from './stepCheckpoint.js'

// orphan 判定原因
export const ORPHAN_REASON_SERVER_RESTART = 'server_restart'
export const ORPHAN_REASON_HEARTBEAT_EXPIRED = 'heartbeat_expired'

// orphan 不可恢复的阻断原因
export const ORPHAN_BLOCK_REASON = Object.freeze({
  CHECKPOINT_MISSING: 'checkpoint_missing',
  CHECKPOINT_CORRUPT: 'checkpoint_corrupt',
  RECOVERY_LIMIT_EXCEEDED: 'recovery_limit_exceeded'
})

// 恢复次数上限：HERMES_REASONING_MAX_RECOVERY_COUNT 可覆盖，默认 3
const DEFAULT_MAX_RECOVERY_COUNT = 3
// 心跳过期阈值：HERMES_REASONING_ORPHAN_HEARTBEAT_TIMEOUT_MS 可覆盖，默认 60000ms
const DEFAULT_ORPHAN_HEARTBEAT_TIMEOUT_MS = 60000

const ORPHAN_REASON_SUMMARY = Object.freeze({
  [ORPHAN_REASON_SERVER_RESTART]: '服务器重启时本 session 仍为非终结状态，已收敛为 orphaned，等待恢复资格评估。',
  [ORPHAN_REASON_HEARTBEAT_EXPIRED]: 'session 心跳超过阈值未更新，已收敛为 orphaned，等待恢复资格评估。'
})

export function resolveMaxRecoveryCount(value) {
  const raw = value ?? process.env.HERMES_REASONING_MAX_RECOVERY_COUNT
  const num = Number(raw)
  if (!Number.isFinite(num) || num <= 0) return DEFAULT_MAX_RECOVERY_COUNT
  return Math.floor(num)
}

function resolveHeartbeatTimeoutMs(value) {
  const raw = value ?? process.env.HERMES_REASONING_ORPHAN_HEARTBEAT_TIMEOUT_MS
  const num = Number(raw)
  if (!Number.isFinite(num) || num <= 0) return DEFAULT_ORPHAN_HEARTBEAT_TIMEOUT_MS
  return num
}

/**
 * 判定 session 是否为 orphan。
 * - 终态、failed（已有失败证据与 retry 路径）、已 orphaned 的 session 不重复判定；
 * - assumeRestart=true（进程启动扫描）时，其余非终结状态一律视为被进程中断；
 * - 否则仅当存在心跳证据（artifacts.lastHeartbeatAt / lastHeartbeatAt / updatedAt）
 *   且超过 heartbeatTimeoutMs 未更新时判定 heartbeat_expired，无证据不猜测。
 * 返回 { orphan, reason }。
 */
export function determineOrphanReason(session, options = {}) {
  const status = normalizeLegacySessionStatus(session?.status)
  if (isTerminalSessionState(status)) return { orphan: false, reason: null }
  if (status === REASONING_SESSION_STATE.FAILED) return { orphan: false, reason: null }
  if (status === REASONING_SESSION_STATE.ORPHANED) return { orphan: false, reason: null }
  if (options.assumeRestart) return { orphan: true, reason: ORPHAN_REASON_SERVER_RESTART }

  const heartbeatAt = Date.parse(String(
    session?.artifacts?.lastHeartbeatAt || session?.lastHeartbeatAt || session?.updatedAt || ''
  ))
  if (!Number.isFinite(heartbeatAt)) return { orphan: false, reason: null }
  const timeoutMs = resolveHeartbeatTimeoutMs(options.heartbeatTimeoutMs)
  const nowMs = Number.isFinite(options.nowMs) ? options.nowMs : Date.now()
  if (nowMs - heartbeatAt > timeoutMs) {
    return { orphan: true, reason: ORPHAN_REASON_HEARTBEAT_EXPIRED }
  }
  return { orphan: false, reason: null }
}

/**
 * 评估 orphaned session 的恢复资格（确定性，不猜测）。
 * 返回 { recoverable: true, nextStepIndex, checkpointStepIndex, checkpointFile, checkpoint, recoveryCount, maxRecoveryCount }
 * 或 { recoverable: false, reason, detail }。
 * 最新 checkpoint 损坏时不回退到更早 checkpoint（无法证明其间 step 未成功），直接阻断。
 */
export function evaluateOrphanRecovery(session, options = {}) {
  const sessionId = session?.sessionId
  if (!sessionId) {
    return { recoverable: false, reason: ORPHAN_BLOCK_REASON.CHECKPOINT_MISSING, detail: 'session 缺少 sessionId，无法定位 checkpoint。' }
  }

  const files = listStepCheckpoints(sessionId)
  if (files.length === 0) {
    return {
      recoverable: false,
      reason: ORPHAN_BLOCK_REASON.CHECKPOINT_MISSING,
      detail: '未找到 step checkpoint，无法确定安全恢复点，禁止猜测继续。'
    }
  }

  const latestFile = files[files.length - 1]
  let checkpoint = null
  try {
    checkpoint = JSON.parse(fs.readFileSync(latestFile.filePath, 'utf8'))
  } catch {
    return {
      recoverable: false,
      reason: ORPHAN_BLOCK_REASON.CHECKPOINT_CORRUPT,
      detail: `最新 checkpoint 无法解析：${latestFile.file}，禁止猜测继续。`
    }
  }

  const stepIndex = checkpoint?.stepIndex
  const nextStepIndex = checkpoint?.nextStepIndex
  if (!Number.isInteger(stepIndex) || stepIndex < 0 || !Number.isInteger(nextStepIndex) || nextStepIndex !== stepIndex + 1) {
    return {
      recoverable: false,
      reason: ORPHAN_BLOCK_REASON.CHECKPOINT_CORRUPT,
      detail: `最新 checkpoint 结构不完整（stepIndex/nextStepIndex 非法）：${latestFile.file}，禁止猜测继续。`
    }
  }

  const maxRecoveryCount = resolveMaxRecoveryCount(options.maxRecoveryCount)
  // 恢复次数取 session 与 checkpoint 两侧较大值：恢复成功后可能尚未写入新 checkpoint，
  // 此时只有 session 侧的 checkpointRecoveryCount 被递增，取大值避免超限恢复。
  const recoveryCount = Math.max(
    Number(session?.artifacts?.checkpointRecoveryCount || 0) || 0,
    Number(checkpoint?.recoveryCount || 0) || 0
  )
  if (recoveryCount >= maxRecoveryCount) {
    return {
      recoverable: false,
      reason: ORPHAN_BLOCK_REASON.RECOVERY_LIMIT_EXCEEDED,
      detail: `恢复次数 ${recoveryCount} 已达上限 ${maxRecoveryCount}，禁止猜测继续。`
    }
  }

  return {
    recoverable: true,
    sessionId,
    nextStepIndex,
    checkpointStepIndex: stepIndex,
    checkpointFile: latestFile.filePath,
    checkpoint,
    recoveryCount,
    maxRecoveryCount
  }
}

/**
 * 构造 -> orphaned 的转移结果（纯函数，不落盘）。
 * 旧状态先经 normalizeLegacySessionStatus 归一，保证状态机校验可通过。
 */
export function buildOrphanedTransition(session, reason, now = new Date().toISOString()) {
  const normalized = { ...session, status: normalizeLegacySessionStatus(session?.status) }
  const transitioned = applySessionTransition(normalized, REASONING_SESSION_STATE.ORPHANED, reason)
  return {
    ...transitioned,
    currentStepId: null,
    artifacts: {
      ...transitioned.artifacts,
      orphanReason: reason,
      orphanedAt: now
    }
  }
}

/**
 * 构造 orphaned -> blocked 的转移结果（纯函数，不落盘）。
 */
export function buildOrphanBlockedTransition(session, qualification, now = new Date().toISOString()) {
  const reason = qualification?.reason || 'unknown'
  const transitioned = applySessionTransition(session, REASONING_SESSION_STATE.BLOCKED, reason)
  return {
    ...transitioned,
    currentStepId: null,
    error: qualification?.detail || reason,
    artifacts: {
      ...transitioned.artifacts,
      orphanBlockedReason: reason,
      orphanBlockedAt: now
    }
  }
}

/**
 * 启动/定时扫描入口：收敛孤儿 session。
 * 对 sessionDirs 下的 session 文件按 sessionId 去重后逐个处理：
 * - 终态与 failed session 不触碰；
 * - 判定为 orphan 的经状态机转 orphaned 并记录原因与事件；
 * - 已 orphaned 的不重复转移，但重新评估恢复资格；
 * - 恢复资格不足（checkpoint 缺失/损坏/超限）的再转 blocked 并记录原因与事件。
 *
 * 通过注入 updateSession / appendEvent 与持久化解耦，便于测试隔离。
 * AUTO-C01：skipSessionIds（可选）用于跳过由持久化队列全权管理的 session——
 * 队列等待中（queued）的 session 不是孤儿，其收敛由队列启动恢复负责。
 * 返回扫描摘要 { scannedFiles, sessions, orphaned, alreadyOrphaned, blocked, terminalSkipped, failedSkipped, notOrphan, queueManagedSkipped, errors }。
 */
export function scanAndConvergeOrphanedSessions({
  sessionDirs = [],
  updateSession,
  appendEvent = () => {},
  assumeRestart = true,
  nowFn = () => new Date().toISOString(),
  heartbeatTimeoutMs,
  maxRecoveryCount,
  skipSessionIds = null
} = {}) {
  if (typeof updateSession !== 'function') throw new Error('orphan_scan_requires_updateSession')

  const summary = {
    scannedFiles: 0,
    sessions: 0,
    orphaned: 0,
    alreadyOrphaned: 0,
    blocked: 0,
    terminalSkipped: 0,
    failedSkipped: 0,
    notOrphan: 0,
    queueManagedSkipped: 0,
    errors: []
  }
  const seen = new Set()

  for (const dir of sessionDirs) {
    if (!dir || !fs.existsSync(dir)) continue
    let files = []
    try {
      files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'))
    } catch {
      continue
    }
    for (const file of files) {
      summary.scannedFiles += 1
      let session = null
      try {
        session = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'))
      } catch {
        continue // 损坏的 session 文件跳过（保持旧行为）
      }
      const sessionId = session?.sessionId
      if (!sessionId || seen.has(sessionId)) continue
      seen.add(sessionId)
      // AUTO-C01：队列管理的 session 由队列恢复/worker 全权收敛，跳过孤儿判定
      if (skipSessionIds && typeof skipSessionIds.has === 'function' && skipSessionIds.has(sessionId)) {
        summary.queueManagedSkipped += 1
        continue
      }
      summary.sessions += 1

      try {
        const outcome = convergeOneSession(session, {
          updateSession,
          appendEvent,
          assumeRestart,
          nowFn,
          heartbeatTimeoutMs,
          maxRecoveryCount
        })
        if (Object.prototype.hasOwnProperty.call(summary, outcome)) {
          summary[outcome] += 1
        }
      } catch (error) {
        summary.errors.push({ sessionId, error: error instanceof Error ? error.message : String(error) })
      }
    }
  }
  return summary
}

function convergeOneSession(session, deps) {
  const sessionId = session.sessionId
  const status = normalizeLegacySessionStatus(session?.status)
  if (isTerminalSessionState(status)) return 'terminalSkipped'
  if (status === REASONING_SESSION_STATE.FAILED) return 'failedSkipped'

  let current = session
  if (status !== REASONING_SESSION_STATE.ORPHANED) {
    const orphan = determineOrphanReason(current, deps)
    if (!orphan.orphan) return 'notOrphan'
    current = deps.updateSession(sessionId, (latest) => buildOrphanedTransition(latest, orphan.reason, deps.nowFn()))
    deps.appendEvent(
      sessionId,
      'session_orphaned',
      'session 被判定为孤儿',
      ORPHAN_REASON_SUMMARY[orphan.reason] || orphan.reason,
      { data: { reason: orphan.reason, fromStatus: status } }
    )
  }

  const qualification = evaluateOrphanRecovery(current, { maxRecoveryCount: deps.maxRecoveryCount })
  if (qualification.recoverable) {
    return status === REASONING_SESSION_STATE.ORPHANED ? 'alreadyOrphaned' : 'orphaned'
  }

  deps.updateSession(sessionId, (latest) => buildOrphanBlockedTransition(latest, qualification, deps.nowFn()))
  deps.appendEvent(
    sessionId,
    'session_orphan_blocked',
    'orphan 不可恢复，已阻断',
    qualification.detail,
    { data: { reason: qualification.reason } }
  )
  return 'blocked'
}
