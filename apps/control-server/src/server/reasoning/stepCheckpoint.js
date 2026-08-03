/**
 * step checkpoint 持久化与恢复。
 *
 * AUTO-B02：每个成功 step 后写入 checkpoint，支持从 nextStepIndex 恢复，
 * 并保证已完成 step 不重复执行。
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  REASONING_SESSION_STATE,
  applySessionTransition
} from './sessionStateMachine.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..', '..')
const DEFAULT_CHECKPOINT_DIR = path.join(REPO_ROOT, 'state', 'reasoning-checkpoints')

function getCheckpointDir() {
  return process.env.HERMES_REASONING_CHECKPOINT_DIR || DEFAULT_CHECKPOINT_DIR
}

function ensureCheckpointDir() {
  const dir = getCheckpointDir()
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

function getCheckpointFilePath(sessionId, stepIndex) {
  const dir = ensureCheckpointDir()
  return path.join(dir, `${sessionId}_step_${stepIndex}.json`)
}

function summarizeStepInput(step) {
  return {
    action: step?.action || null,
    tool: step?.tool || null,
    title: step?.title || null,
    params: step?.params || null,
    dependsOn: step?.dependsOn || null
  }
}

function summarizeStepResult(result) {
  if (!result || typeof result !== 'object') {
    return { ok: true, status: 'completed', summary: 'no result object' }
  }
  return {
    ok: Boolean(result.ok),
    status: result.status || 'completed',
    summary: result.summary || null,
    failedStage: result.failedStage || null,
    retryable: Boolean(result.retryable)
  }
}

function collectArtifactEvidence(session, step) {
  const artifacts = session?.artifacts || {}
  const keys = [
    'projectRoot',
    'workspaceStructure',
    'directoryListing',
    'storyProduction',
    'latestStepReviewEvidence',
    'recentContext',
    'latestAnswerAssessment'
  ]
  const evidence = {}
  for (const key of keys) {
    if (artifacts[key] != null) {
      evidence[key] = artifacts[key]
    }
  }
  return evidence
}

/**
 * 写入 step checkpoint。
 */
export function writeStepCheckpoint(session, step, stepIndex, result = null, options = {}) {
  const sessionId = session?.sessionId
  if (!sessionId) throw new Error('checkpoint_requires_session_id')
  if (!step?.stepId) throw new Error('checkpoint_requires_step_id')

  const now = new Date().toISOString()
  const checkpoint = {
    version: '1',
    taskId: sessionId,
    sessionId,
    projectId: session?.submissionContext?.projectId || null,
    stepId: step.stepId,
    stepIndex,
    nextStepIndex: stepIndex + 1,
    inputSummary: summarizeStepInput(step),
    resultSummary: summarizeStepResult(result),
    artifacts: collectArtifactEvidence(session, step),
    startedAt: options.startedAt || now,
    completedAt: now,
    lastHeartbeat: now,
    errorCategory: options.errorCategory || null,
    retryCount: Number(session?.artifacts?.recoverableFailureCount || 0),
    recoveryCount: Number(session?.artifacts?.checkpointRecoveryCount || 0),
    createdAt: now
  }

  const filePath = getCheckpointFilePath(sessionId, stepIndex)
  fs.writeFileSync(filePath, JSON.stringify(checkpoint, null, 2), 'utf8')
  return checkpoint
}

/**
 * 读取某 session 的最新 checkpoint。
 */
export function readLatestStepCheckpoint(sessionId) {
  if (!sessionId) return null
  const dir = getCheckpointDir()
  if (!fs.existsSync(dir)) return null
  const files = fs.readdirSync(dir)
    .filter((f) => f.startsWith(`${sessionId}_step_`) && f.endsWith('.json'))
    .map((f) => {
      const match = f.match(/_step_(\d+)\.json$/)
      return { file: f, stepIndex: match ? Number(match[1]) : -1 }
    })
    .filter((item) => item.stepIndex >= 0)
    .sort((a, b) => b.stepIndex - a.stepIndex)

  if (files.length === 0) return null
  try {
    const filePath = path.join(dir, files[0].file)
    const content = fs.readFileSync(filePath, 'utf8')
    return JSON.parse(content)
  } catch {
    return null
  }
}

/**
 * 列出某 session 的所有 checkpoint。
 */
export function listStepCheckpoints(sessionId) {
  if (!sessionId) return []
  const dir = getCheckpointDir()
  if (!fs.existsSync(dir)) return []
  return fs.readdirSync(dir)
    .filter((f) => f.startsWith(`${sessionId}_step_`) && f.endsWith('.json'))
    .map((f) => {
      const match = f.match(/_step_(\d+)\.json$/)
      return {
        file: f,
        stepIndex: match ? Number(match[1]) : -1,
        filePath: path.join(dir, f)
      }
    })
    .filter((item) => item.stepIndex >= 0)
    .sort((a, b) => a.stepIndex - b.stepIndex)
}

/**
 * 清理某 session 的 checkpoint 文件。
 */
export function clearStepCheckpoints(sessionId) {
  if (!sessionId) return 0
  const files = listStepCheckpoints(sessionId)
  let removed = 0
  for (const item of files) {
    try {
      fs.unlinkSync(item.filePath)
      removed++
    } catch {}
  }
  return removed
}

/**
 * 从 checkpoint 恢复 session 的 nextStepIndex 与 artifacts 摘要。
 */
export function applyCheckpointToSession(session, checkpoint) {
  if (!session || !checkpoint) return session
  let transitioned = session
  // 如果当前状态不是 running，尝试合法转移到 running
  if (session.status !== REASONING_SESSION_STATE.RUNNING) {
    try {
      transitioned = applySessionTransition(session, REASONING_SESSION_STATE.RUNNING, `checkpoint recovery from step ${checkpoint.stepIndex}`)
    } catch {
      // 如果直接转移失败（如 failed -> running 不合法），先转到 retry_wait 再转 running
      if (session.status === REASONING_SESSION_STATE.FAILED || session.status === REASONING_SESSION_STATE.ORPHANED) {
        transitioned = applySessionTransition(session, REASONING_SESSION_STATE.RETRY_WAIT, 'checkpoint recovery retry wait')
        transitioned = applySessionTransition(transitioned, REASONING_SESSION_STATE.RUNNING, 'checkpoint recovery continue')
      }
    }
  }
  return {
    ...transitioned,
    currentStepId: null,
    artifacts: {
      ...(transitioned.artifacts || {}),
      ...(checkpoint.artifacts || {}),
      checkpointRecoveryCount: Number(transitioned.artifacts?.checkpointRecoveryCount || 0) + 1,
      nextStepIndex: checkpoint.nextStepIndex
    }
  }
}
