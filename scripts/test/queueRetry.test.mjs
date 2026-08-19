import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import {
  REASONING_QUEUE_ITEM_STATE,
  enqueueQueueItem,
  readQueueItem,
  updateQueueItem,
  claimQueueItem,
  selectClaimableQueueItems,
  recoverPersistentQueueOnStartup,
  createReasoningQueueWorker
} from '../../apps/control-server/src/server/reasoning/persistentQueue.js'

// AUTO-C02 测试：task 级失败的队列重试调度（S3-01/S3-02）。
// env 隔离：queue 目录指向临时目录，不污染真实 state/；
// 退避用毫秒级注入参数（retryBaseMs/retryMaxDelayMs），tick 用毫秒级间隔，不做真实秒级等待。

const QUEUE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'queue-retry-'))
const SESSION_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'queue-retry-sessions-'))
const savedQueueDirEnv = process.env.HERMES_REASONING_QUEUE_DIR
process.env.HERMES_REASONING_QUEUE_DIR = QUEUE_DIR

function restoreEnv() {
  if (savedQueueDirEnv === undefined) delete process.env.HERMES_REASONING_QUEUE_DIR
  else process.env.HERMES_REASONING_QUEUE_DIR = savedQueueDirEnv
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitFor(condition, timeoutMs = 3000) {
  const startedAt = Date.now()
  while (!condition()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error('waitFor_timeout')
    }
    await sleep(5)
  }
}

function makeSession(sessionId, overrides = {}) {
  return {
    sessionId,
    status: 'queued',
    submissionContext: { projectId: null },
    artifacts: {},
    events: [],
    stateTransitions: [],
    plan: { steps: [{ stepId: 's0' }] },
    ...overrides
  }
}

function writeSessionFile(session) {
  fs.writeFileSync(path.join(SESSION_DIR, `${session.sessionId}.json`), JSON.stringify(session, null, 2), 'utf8')
}

function readSessionFile(sessionId) {
  return JSON.parse(fs.readFileSync(path.join(SESSION_DIR, `${sessionId}.json`), 'utf8'))
}

// 注入 worker / 恢复的 session 存取实现：直接操作临时目录文件（镜像 updateReasoningSession 语义）
function makeSessionStore() {
  const events = []
  return {
    events,
    read(sessionId) {
      try {
        return readSessionFile(sessionId)
      } catch {
        return null
      }
    },
    update(sessionId, updater) {
      const current = readSessionFile(sessionId)
      const next = { ...updater(current), updatedAt: new Date().toISOString() }
      writeSessionFile(next)
      return next
    },
    appendEvent(sessionId, type, title, summary, extra = {}) {
      events.push({ sessionId, type, title, summary, ...extra })
    }
  }
}

let seq = 0
function nextId(prefix) {
  seq += 1
  return `${prefix}_${seq}`
}

// ---------------------------------------------------------------------------
// 调度选择：nextAttemptAt 门禁（纯函数）
// ---------------------------------------------------------------------------

test('selectClaimableQueueItems：nextAttemptAt 未到点的 retry_wait item 不参与领取，到点恢复可领取', () => {
  const items = [
    { sessionId: 'wait_1', status: 'queued', createdAt: '2026-01-01T00:00:00.000Z', nextAttemptAt: '2026-01-01T00:10:00.000Z' },
    { sessionId: 'wait_2', status: 'queued', createdAt: '2026-01-01T00:00:01.000Z', nextAttemptAt: '2026-01-01T00:00:30.000Z' },
    { sessionId: 'wait_3', status: 'queued', createdAt: '2026-01-01T00:00:02.000Z', nextAttemptAt: null }
  ]
  const nowMs = Date.parse('2026-01-01T00:01:00.000Z')
  // wait_1（10 分钟后）不可领取；wait_2 到点可领取；wait_3 无重试窗口可领取
  const picked = selectClaimableQueueItems(items, { maxConcurrency: 5, nowMs })
  assert.deepEqual(picked.map((item) => item.sessionId), ['wait_2', 'wait_3'])
  // 全部到点后按 FIFO 领取
  const later = Date.parse('2026-01-01T00:11:00.000Z')
  const pickedLater = selectClaimableQueueItems(items, { maxConcurrency: 5, nowMs: later })
  assert.deepEqual(pickedLater.map((item) => item.sessionId), ['wait_1', 'wait_2', 'wait_3'])
})

// ---------------------------------------------------------------------------
// S3-01：临时故障进入 retry_wait 并按退避重试，恢复成功
// ---------------------------------------------------------------------------

test('S3-01：503 临时故障 -> retry_wait 退避调度 -> 到点重试 -> 恢复成功', async () => {
  const store = makeSessionStore()
  const sessionId = nextId('s301a')
  writeSessionFile(makeSession(sessionId, { submissionContext: { projectId: 'projR1' } }))
  enqueueQueueItem({ sessionId, projectId: 'projR1' })

  const executed = []
  const worker = createReasoningQueueWorker({
    workerId: 'worker_s301a',
    maxConcurrency: 1,
    tickMs: 5,
    readSession: store.read,
    updateSession: store.update,
    appendEvent: store.appendEvent,
    retryMaxAttempts: 3,
    retryBaseMs: 60,
    retryMaxDelayMs: 500,
    executeItem: async (item) => {
      executed.push({ sessionId: item.sessionId, attempt: item.attempts, at: Date.now() })
      if (executed.length === 1) {
        // 首次执行：GameStudio 返回 503（显式信号 + 内嵌状态码双通道）
        store.update(item.sessionId, (s) => ({
          ...s,
          status: 'failed',
          error: 'story_workflow_evaluator_failed:failedSteps=story_create_ai_project:create_ai_project_api',
          artifacts: {
            ...s.artifacts,
            storyProduction: {
              lastResult: { ok: false, retryable: true, failedStage: 'create_ai_project_api', serverStatus: 503, message: 'Service Unavailable' }
            }
          }
        }))
      } else {
        // 重试执行：恢复成功
        store.update(item.sessionId, (s) => ({ ...s, status: 'completed', error: null }))
      }
    }
  })
  worker.start()
  try {
    // 首次失败 -> session retry_wait + item 回 queued 落 nextAttemptAt
    await waitFor(() => readSessionFile(sessionId).status === 'retry_wait')
    const waiting = readQueueItem(sessionId)
    assert.equal(waiting.status, 'queued')
    assert.equal(waiting.retryCount, 1)
    assert.ok(waiting.nextAttemptAt, 'retry_wait item 必须落 nextAttemptAt')
    assert.equal(waiting.retryHistory.length, 1)
    assert.equal(waiting.retryHistory[0].attempt, 1)
    assert.equal(waiting.retryHistory[0].backoffMs, 60)
    assert.equal(waiting.retryHistory[0].category, 'retryable')
    assert.equal(waiting.retryHistory[0].rule, 'explicit_retryable_signal')
    assert.ok(waiting.retryHistory[0].scheduledAt)
    // 退避窗口 = nextAttemptAt - scheduledAt ≈ baseMs
    const windowMs = Date.parse(waiting.nextAttemptAt) - Date.parse(waiting.retryHistory[0].scheduledAt)
    assert.equal(windowMs, 60)
    // session artifacts 镜像重试计划
    const retryPolicy = readSessionFile(sessionId).artifacts?.retryPolicy
    assert.equal(retryPolicy.retryCount, 1)
    assert.equal(retryPolicy.maxAttempts, 3)
    assert.equal(retryPolicy.nextAttemptAt, waiting.nextAttemptAt)
    // stateTransitions 记录 failed -> retry_wait
    assert.ok(readSessionFile(sessionId).stateTransitions.some((t) => t.from === 'failed' && t.to === 'retry_wait'))

    // 退避未到点：等待窗口内不会被重新领取
    await sleep(30)
    assert.equal(executed.length, 1, 'nextAttemptAt 未到点前不得重新领取')

    // 到点后重新领取并恢复成功
    await waitFor(() => readQueueItem(sessionId)?.status === 'completed')
  } finally {
    worker.stop()
  }

  assert.equal(executed.length, 2, '首次失败 + 第 1 次重试，共执行 2 次')
  assert.equal(readSessionFile(sessionId).status, 'completed')
  const item = readQueueItem(sessionId)
  assert.equal(item.status, 'completed')
  assert.equal(item.attempts, 2)
  assert.equal(item.retryCount, 1)
  assert.equal(item.nextAttemptAt, null, '领取后清空 nextAttemptAt')
  // 事件可追溯：重试调度 + 两次领取 + 终结
  assert.equal(store.events.filter((e) => e.type === 'queue_retry_scheduled').length, 1)
  assert.ok(store.events.find((e) => e.type === 'queue_retry_scheduled')?.data.nextAttemptAt)
  assert.equal(store.events.filter((e) => e.type === 'queue_claimed').length, 2)
  assert.equal(store.events.find((e) => e.type === 'queue_finished')?.data.outcome, 'completed')
})

// ---------------------------------------------------------------------------
// S3-01：schema / 权限 / 确定性业务错误不重试；审核类收敛 blocked
// ---------------------------------------------------------------------------

test('S3-01：schema 与权限错误不重试，直接 failed；审核拒绝收敛 blocked', async () => {
  const store = makeSessionStore()
  const schemaTask = nextId('s301b')
  const permTask = nextId('s301c')
  const reviewTask = nextId('s301d')
  const errors = {
    [schemaTask]: 'invalid_scripts_candidate: 脚本候选未通过 schema 验证',
    [permTask]: 'gamestudio_registry_http_403',
    [reviewTask]: 'story_review_rejected: 人工审核未通过'
  }
  for (const sessionId of [schemaTask, permTask, reviewTask]) {
    writeSessionFile(makeSession(sessionId))
    enqueueQueueItem({ sessionId })
  }

  const executed = []
  const worker = createReasoningQueueWorker({
    workerId: 'worker_s301b',
    maxConcurrency: 3,
    tickMs: 5,
    readSession: store.read,
    updateSession: store.update,
    appendEvent: store.appendEvent,
    retryMaxAttempts: 3,
    retryBaseMs: 20,
    retryMaxDelayMs: 100,
    executeItem: async (item) => {
      executed.push(item.sessionId)
      store.update(item.sessionId, (s) => ({ ...s, status: 'failed', error: errors[item.sessionId] }))
    }
  })
  worker.start()
  try {
    await waitFor(() => readQueueItem(schemaTask)?.status === 'failed'
      && readQueueItem(permTask)?.status === 'failed'
      && readQueueItem(reviewTask)?.status === 'blocked')
    // 留出数倍退避窗口：非重试错误绝不重新调度
    await sleep(150)
  } finally {
    worker.stop()
  }

  assert.equal(executed.filter((id) => id === schemaTask).length, 1, 'schema 错误不重试')
  assert.equal(executed.filter((id) => id === permTask).length, 1, '权限错误不重试')
  assert.equal(executed.filter((id) => id === reviewTask).length, 1, '审核拒绝不重试')

  const schemaItem = readQueueItem(schemaTask)
  assert.equal(schemaItem.status, 'failed')
  assert.equal(schemaItem.retryCount, 0)
  assert.equal(schemaItem.retryHistory.length, 0)
  assert.equal(readSessionFile(schemaTask).status, 'failed')
  assert.equal(readSessionFile(schemaTask).error, errors[schemaTask])

  const permItem = readQueueItem(permTask)
  assert.equal(permItem.status, 'failed')
  assert.equal(permItem.retryCount, 0)
  assert.equal(readSessionFile(permTask).status, 'failed')

  // 审核类：session failed -> blocked（需人工处理），item blocked，事件可追溯
  const reviewItem = readQueueItem(reviewTask)
  assert.equal(reviewItem.status, 'blocked')
  assert.equal(reviewItem.retryCount, 0)
  const reviewSession = readSessionFile(reviewTask)
  assert.equal(reviewSession.status, 'blocked')
  assert.ok(reviewSession.stateTransitions.some((t) => t.from === 'failed' && t.to === 'blocked'))
  const blockedEvent = store.events.find((e) => e.type === 'queue_blocked_needs_review' && e.sessionId === reviewTask)
  assert.ok(blockedEvent)
  assert.equal(blockedEvent.data.classification.category, 'needs_review')
  assert.equal(blockedEvent.data.classification.rule, 'review_rejection')

  // 无任何重试调度事件
  assert.equal(store.events.filter((e) => e.type === 'queue_retry_scheduled').length, 0)
})

// ---------------------------------------------------------------------------
// S3-02：达到重试上限稳定收敛 failed，记录每次原因与时间
// ---------------------------------------------------------------------------

test('S3-02：持续临时故障达到重试上限 -> 稳定 failed，retryHistory 记录每次原因与时间', async () => {
  const store = makeSessionStore()
  const sessionId = nextId('s302a')
  writeSessionFile(makeSession(sessionId, { submissionContext: { projectId: 'projR2' } }))
  enqueueQueueItem({ sessionId, projectId: 'projR2' })

  const executed = []
  const worker = createReasoningQueueWorker({
    workerId: 'worker_s302a',
    maxConcurrency: 1,
    tickMs: 5,
    readSession: store.read,
    updateSession: store.update,
    appendEvent: store.appendEvent,
    retryMaxAttempts: 2,
    retryBaseMs: 20,
    retryMaxDelayMs: 500,
    executeItem: async (item) => {
      executed.push(item.attempts)
      store.update(item.sessionId, (s) => ({ ...s, status: 'failed', error: 'connect ECONNREFUSED 127.0.0.1:18888' }))
    }
  })
  worker.start()
  try {
    await waitFor(() => readQueueItem(sessionId)?.status === 'failed')
    // 收敛后留出数倍退避窗口：终结后绝不重新调度
    await sleep(150)
  } finally {
    worker.stop()
  }

  // 首次执行 + 2 次重试 = 3 次执行；达上限后不再调度
  assert.deepEqual(executed, [1, 2, 3])

  const item = readQueueItem(sessionId)
  assert.equal(item.status, 'failed')
  assert.equal(item.retryCount, 2)
  assert.match(item.lastError, /ECONNREFUSED/)
  assert.ok(item.history.some((h) => h.reason === 'queue_retry_exhausted'))
  // 每次重试的原因与时间：backoff 20 -> 40 指数递增
  assert.equal(item.retryHistory.length, 2)
  assert.equal(item.retryHistory[0].attempt, 1)
  assert.equal(item.retryHistory[0].backoffMs, 20)
  assert.equal(item.retryHistory[0].rule, 'transient_network_pattern')
  assert.ok(item.retryHistory[0].scheduledAt && item.retryHistory[0].nextAttemptAt && item.retryHistory[0].error)
  assert.equal(item.retryHistory[1].attempt, 2)
  assert.equal(item.retryHistory[1].backoffMs, 40)
  assert.ok(Date.parse(item.retryHistory[1].scheduledAt) > Date.parse(item.retryHistory[0].scheduledAt))

  // session 稳定 failed（终态），artifacts 记录 exhausted 与全部历史
  const session = readSessionFile(sessionId)
  assert.equal(session.status, 'failed')
  const retryPolicy = session.artifacts?.retryPolicy
  assert.equal(retryPolicy.exhausted, true)
  assert.equal(retryPolicy.retryCount, 2)
  assert.equal(retryPolicy.maxAttempts, 2)
  assert.equal(retryPolicy.history.length, 2)
  assert.ok(retryPolicy.exhaustedAt)

  // 事件链：2 次调度 + 1 次上限收敛 + 终态 failed
  assert.equal(store.events.filter((e) => e.type === 'queue_retry_scheduled').length, 2)
  assert.equal(store.events.filter((e) => e.type === 'queue_retry_exhausted').length, 1)
  assert.equal(store.events.find((e) => e.type === 'queue_finished')?.data.outcome, 'failed')
})

// ---------------------------------------------------------------------------
// S3-02：retry_wait 中取消 -> 不得重新调度
// ---------------------------------------------------------------------------

test('S3-02：retry_wait 等待中取消 -> item 镜像 cancelled 终结，绝不重新领取', async () => {
  const store = makeSessionStore()
  const sessionId = nextId('s302b')
  writeSessionFile(makeSession(sessionId))
  enqueueQueueItem({ sessionId })

  const executed = []
  const worker = createReasoningQueueWorker({
    workerId: 'worker_s302b',
    maxConcurrency: 1,
    tickMs: 5,
    readSession: store.read,
    updateSession: store.update,
    appendEvent: store.appendEvent,
    retryMaxAttempts: 3,
    retryBaseMs: 30,
    retryMaxDelayMs: 100,
    executeItem: async (item) => {
      executed.push(item.sessionId)
      store.update(item.sessionId, (s) => ({ ...s, status: 'failed', error: 'HTTP 503 Service Unavailable' }))
    }
  })
  worker.start()
  try {
    // 首次失败 -> retry_wait（退避 30ms，窗口内取消）
    await waitFor(() => readSessionFile(sessionId).status === 'retry_wait')
    assert.equal(readQueueItem(sessionId).status, 'queued')
    assert.ok(readQueueItem(sessionId).nextAttemptAt)

    // 取消（等价 cancelReasoningSession 的状态收敛结果：retry_wait -> cancelled）
    store.update(sessionId, (s) => ({
      ...s,
      status: 'cancelled',
      stateTransitions: [...s.stateTransitions, { from: 'retry_wait', to: 'cancelled', reason: 'reasoning_cancelled_by_user', timestamp: new Date().toISOString() }]
    }))

    // item 被镜像终结为 cancelled（不领取、不占槽）
    await waitFor(() => readQueueItem(sessionId)?.status === 'cancelled')
    // 留出数倍退避窗口：取消后绝不重新调度
    await sleep(150)
  } finally {
    worker.stop()
  }

  assert.equal(executed.length, 1, '取消后不得重新领取 retry_wait task')
  const item = readQueueItem(sessionId)
  assert.equal(item.status, 'cancelled')
  assert.equal(item.attempts, 1)
  assert.equal(item.retryCount, 1) // 重试曾被调度一次，但取消阻断了执行
  assert.equal(store.events.filter((e) => e.type === 'queue_retry_scheduled').length, 1)
  assert.equal(store.events.find((e) => e.type === 'queue_finished')?.data.outcome, 'cancelled')
})

// ---------------------------------------------------------------------------
// 重启恢复：retry_wait 等待中的重试计划不丢失、不收敛 orphan
// ---------------------------------------------------------------------------

test('重启恢复：retry_wait session 保持等待调度，stale claim 重置且重试元数据保留', () => {
  const store = makeSessionStore()
  const isolatedQueueDir = fs.mkdtempSync(path.join(os.tmpdir(), 'queue-retry-restart-'))
  const previousQueueDir = process.env.HERMES_REASONING_QUEUE_DIR
  process.env.HERMES_REASONING_QUEUE_DIR = isolatedQueueDir
  try {
    // a：retry_wait session + queued item（重试等待中崩溃）-> 保持 queued，元数据不动
    const a = nextId('s302c')
    writeSessionFile(makeSession(a, {
      status: 'retry_wait',
      stateTransitions: [{ from: 'failed', to: 'retry_wait', reason: 'queue retry #1/3', timestamp: new Date().toISOString() }]
    }))
    enqueueQueueItem({ sessionId: a })
    const nextAttemptAtA = new Date(Date.now() + 60000).toISOString()
    updateQueueItem(a, (current) => ({
      ...current,
      retryCount: 1,
      nextAttemptAt: nextAttemptAtA,
      retryHistory: [{ attempt: 1, scheduledAt: new Date().toISOString(), nextAttemptAt: nextAttemptAtA, backoffMs: 60000, category: 'retryable', rule: 'transient_network_pattern', reason: 'r', error: 'e' }]
    }))
    // b：retry_wait session + running item（崩溃在领取与执行之间）-> 重置回 queued，保留重试计划
    const b = nextId('s302d')
    writeSessionFile(makeSession(b, { status: 'retry_wait' }))
    enqueueQueueItem({ sessionId: b })
    claimQueueItem(b, { workerId: 'dead_worker_retry' })
    const nextAttemptAtB = new Date(Date.now() + 30000).toISOString()
    updateQueueItem(b, (current) => ({
      ...current,
      status: 'running',
      retryCount: 2,
      nextAttemptAt: nextAttemptAtB,
      retryHistory: [
        { attempt: 1, scheduledAt: new Date().toISOString(), nextAttemptAt: null, backoffMs: 100, category: 'retryable', rule: 'r1', reason: 'r', error: 'e' },
        { attempt: 2, scheduledAt: new Date().toISOString(), nextAttemptAt: nextAttemptAtB, backoffMs: 200, category: 'retryable', rule: 'r2', reason: 'r', error: 'e' }
      ]
    }))

    const summary = recoverPersistentQueueOnStartup({
      readSession: store.read,
      updateSession: store.update,
      appendEvent: store.appendEvent
    })
    assert.equal(summary.keptQueued, 1)
    assert.equal(summary.requeued, 1)
    assert.equal(summary.blocked, 0)
    assert.equal(summary.errors.length, 0)

    // a：item 与 session 均不触碰
    const itemA = readQueueItem(a)
    assert.equal(itemA.status, 'queued')
    assert.equal(itemA.retryCount, 1)
    assert.equal(itemA.nextAttemptAt, nextAttemptAtA)
    assert.equal(itemA.retryHistory.length, 1)
    assert.equal(readSessionFile(a).status, 'retry_wait')

    // b：claim 重置回 queued，retryCount/nextAttemptAt/retryHistory 保留，recoveryCount 不消耗
    const itemB = readQueueItem(b)
    assert.equal(itemB.status, 'queued')
    assert.equal(itemB.claim.workerId, null)
    assert.equal(itemB.retryCount, 2)
    assert.equal(itemB.nextAttemptAt, nextAttemptAtB)
    assert.equal(itemB.retryHistory.length, 2)
    assert.equal(itemB.recoveryCount, 0)
    assert.ok(itemB.history.some((h) => h.reason === 'queue_restart_while_retry_wait'))
    assert.equal(readSessionFile(b).status, 'retry_wait')
  } finally {
    if (previousQueueDir === undefined) delete process.env.HERMES_REASONING_QUEUE_DIR
    else process.env.HERMES_REASONING_QUEUE_DIR = previousQueueDir
  }
})

test('cleanup：恢复 env', () => {
  restoreEnv()
  assert.ok(true)
})
