import fs from 'node:fs'
import path from 'node:path'
import {
  HERMES_API_SERVER_BASE_URL,
  HERMES_CHAT_REQUEST_TIMEOUT_MS,
} from '../../config/constants.js'
import { HERMES_HOME } from '../../config/paths.js'

function readHermesApiServerKey() {
  const envKey = String(process.env.API_SERVER_KEY || '').trim()
  if (envKey) return envKey
  try {
    const envPath = path.join(HERMES_HOME, '.env')
    if (!fs.existsSync(envPath)) return ''
    const content = fs.readFileSync(envPath, 'utf8')
    const match = content.match(/^API_SERVER_KEY\s*=\s*(.+)$/m)
    return match ? String(match[1]).trim() : ''
  } catch {
    return ''
  }
}

const HERMES_API_SERVER_KEY = readHermesApiServerKey()

const MAX_CONCURRENT_MODEL_TASKS = Math.max(1, Number(process.env.HERMES_MODEL_TASK_MAX_CONCURRENT || 1))
const MAX_MODEL_CALLS_PER_SESSION = Math.max(1, Number(process.env.HERMES_MODEL_TASK_MAX_CALLS_PER_SESSION || 16))
const MODEL_TASK_QUEUE_WAIT_TIMEOUT_MS = Math.max(1000, Number(process.env.HERMES_MODEL_TASK_QUEUE_WAIT_TIMEOUT_MS || 120000))

let activeCount = 0
const queue = []
const sessionCallCounts = new Map()

function normalizeSessionId(sessionId) {
  return String(sessionId || 'global').trim() || 'global'
}

function reserveSessionCall(sessionId) {
  const normalizedSessionId = normalizeSessionId(sessionId)
  const currentCount = Number(sessionCallCounts.get(normalizedSessionId) || 0)
  if (normalizedSessionId !== 'global' && currentCount >= MAX_MODEL_CALLS_PER_SESSION) {
    throw new Error(`model_task_budget_exceeded:${normalizedSessionId}:${currentCount}/${MAX_MODEL_CALLS_PER_SESSION}`)
  }
  sessionCallCounts.set(normalizedSessionId, currentCount + 1)
  return currentCount + 1
}

function scheduleNext() {
  while (activeCount < MAX_CONCURRENT_MODEL_TASKS && queue.length > 0) {
    const task = queue.shift()
    task.clearQueueWaitTimer?.()
    task.removeAbortListener?.()
    if (task.signal?.aborted) {
      task.reject(new Error(String(task.signal.reason || 'model_task_cancelled_before_start')))
      continue
    }

    activeCount += 1
    task.run()
      .then(task.resolve, task.reject)
      .finally(() => {
        activeCount -= 1
        scheduleNext()
      })
  }
}

function enqueueModelTask(run, options = {}) {
  const phase = String(options.phase || 'model').trim() || 'model'
  const sessionId = normalizeSessionId(options.sessionId)
  const queuedAt = Date.now()

  return new Promise((resolve, reject) => {
    let queueWaitTimer = null
    const removeFromQueue = () => {
      const index = queue.indexOf(task)
      if (index >= 0) queue.splice(index, 1)
    }
    const clearQueueWaitTimer = () => {
      if (queueWaitTimer) {
        clearTimeout(queueWaitTimer)
        queueWaitTimer = null
      }
    }
    const rejectQueuedTask = (reason) => {
      clearQueueWaitTimer()
      removeFromQueue()
      task.removeAbortListener?.()
      reject(new Error(String(reason || 'model_task_cancelled_before_start')))
      scheduleNext()
    }
    const abortQueuedTask = () => rejectQueuedTask(task.signal?.reason || 'model_task_cancelled_before_start')

    const task = {
      phase,
      sessionId,
      signal: options.signal || null,
      clearQueueWaitTimer,
      removeAbortListener: null,
      resolve,
      reject,
      run: async () => {
        const startedAt = Date.now()
        const callNumber = typeof options.reserveCall === 'function' ? options.reserveCall() : null
        options.onStatus?.({
          status: 'started',
          phase,
          sessionId,
          queuedForMs: startedAt - queuedAt,
          activeCount,
          queuedCount: queue.length,
          callNumber,
        })
        try {
          return await run()
        } finally {
          options.onStatus?.({
            status: 'finished',
            phase,
            sessionId,
            activeForMs: Date.now() - startedAt,
            activeCount: Math.max(0, activeCount - 1),
            queuedCount: queue.length,
            callNumber,
          })
        }
      }
    }

    if (task.signal) {
      if (task.signal.aborted) {
        reject(new Error(String(task.signal.reason || 'model_task_cancelled_before_start')))
        return
      }
      task.signal.addEventListener('abort', abortQueuedTask, { once: true })
      task.removeAbortListener = () => task.signal?.removeEventListener('abort', abortQueuedTask)
    }

    const queueWaitTimeoutMs = Math.max(1000, Number(options.queueWaitTimeoutMs || MODEL_TASK_QUEUE_WAIT_TIMEOUT_MS))
    queueWaitTimer = setTimeout(() => rejectQueuedTask('model_task_queue_wait_timeout'), queueWaitTimeoutMs)

    queue.push(task)
    options.onStatus?.({
      status: 'queued',
      phase,
      sessionId,
      activeCount,
      queuedCount: queue.length,
    })
    scheduleNext()
  })
}

export function getModelTaskQueueSnapshot() {
  return {
    maxConcurrent: MAX_CONCURRENT_MODEL_TASKS,
    activeCount,
    queuedCount: queue.length,
    maxCallsPerSession: MAX_MODEL_CALLS_PER_SESSION,
    queueWaitTimeoutMs: MODEL_TASK_QUEUE_WAIT_TIMEOUT_MS,
  }
}

export async function requestHermesChatCompletion({
  sessionId,
  phase,
  messages,
  maxTokens,
  temperature,
  route,
  signal,
  timeoutMs = HERMES_CHAT_REQUEST_TIMEOUT_MS,
  onStatus,
}) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort('model_task_timeout'), timeoutMs)
  const abortFromExternalSignal = () => controller.abort(signal?.reason || 'model_task_cancelled')

  if (signal) {
    if (signal.aborted) {
      clearTimeout(timeout)
      throw new Error(String(signal.reason || 'model_task_cancelled'))
    }
    signal.addEventListener('abort', abortFromExternalSignal, { once: true })
  }

  try {
    return await enqueueModelTask(async () => {
      const directRoute = route && route.transport === 'direct' ? route : null
      const targetUrl = directRoute
        ? `${String(directRoute.baseUrl || '').replace(/\/+$/, '')}/chat/completions`
        : `${HERMES_API_SERVER_BASE_URL}/chat/completions`
      const targetModel = directRoute ? String(directRoute.model || '').trim() : 'hermes-agent'
      const transportLabel = directRoute ? 'direct' : 'hermes'
      console.log(`[MODEL_TASK] phase=${phase || 'model'} transport=${transportLabel} model=${targetModel}`)
      if (!targetModel) {
        throw new Error(`model_route_missing_model:${String(phase || 'model')}`)
      }
      const requestBody = JSON.stringify({
        model: targetModel,
        messages,
        max_tokens: maxTokens,
        ...(temperature === undefined ? {} : { temperature })
      })
      const MAX_RETRIES = 3
      const RETRY_DELAY_MS = 2000
      let lastError = null
      let response = null
      for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        try {
          response = await fetch(targetUrl, {
            method: 'POST',
            signal: controller.signal,
            headers: {
              'Content-Type': 'application/json',
              ...(!directRoute && HERMES_API_SERVER_KEY ? { Authorization: `Bearer ${HERMES_API_SERVER_KEY}` } : {}),
              ...(directRoute?.headers || {})
            },
            body: requestBody
          })
          if (response.ok) {
            break
          }
          const status = response.status
          const retryable = status === 503 || status === 504 || status === 429 || status === 408 || status === 502
          lastError = new Error(`model_task_http_${status}_${response.statusText}`)
          if (!retryable || attempt >= MAX_RETRIES) {
            throw lastError
          }
          const delay = RETRY_DELAY_MS * Math.pow(2, attempt)
          console.log(`[MODEL_TASK][RETRY] phase=${phase || 'model'} attempt=${attempt + 1}/${MAX_RETRIES + 1} status=${status} delay=${delay}ms`)
          await new Promise((resolve) => setTimeout(resolve, delay))
        } catch (fetchErr) {
          lastError = fetchErr
          if (attempt >= MAX_RETRIES) throw fetchErr
          const delay = RETRY_DELAY_MS * Math.pow(2, attempt)
          console.log(`[MODEL_TASK][RETRY] phase=${phase || 'model'} attempt=${attempt + 1}/${MAX_RETRIES + 1} error=${fetchErr.message} delay=${delay}ms`)
          await new Promise((resolve) => setTimeout(resolve, delay))
        }
      }
      if (!response || !response.ok) {
        throw lastError || new Error('model_task_unknown_error')
      }
      return response.json()
    }, {
      sessionId,
      phase,
      signal: controller.signal,
      queueWaitTimeoutMs: Math.min(timeoutMs, MODEL_TASK_QUEUE_WAIT_TIMEOUT_MS),
      reserveCall: () => reserveSessionCall(sessionId),
      onStatus
    })
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error(String(controller.signal.reason || 'model_task_aborted'))
    }
    throw error
  } finally {
    clearTimeout(timeout)
    if (signal && !signal.aborted) {
      signal.removeEventListener('abort', abortFromExternalSignal)
    }
  }
}