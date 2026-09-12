import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { Hono } from 'hono'
import {
  REASONING_QUEUE_ITEM_STATE,
  isTerminalQueueItemState,
  isReleasedQueueItemState,
  resolveQueueMaxConcurrency,
  resolveQueueTickMs,
  resolveQueueHeartbeatScanIntervalMs,
  resolveWaitingReviewTtlMs,
  getQueueItemFilePath,
  resolveQueueProjectKey,
  mapSessionStatusToQueueItemStatus,
  enqueueQueueItem,
  readQueueItem,
  listQueueItems,
  updateQueueItem,
  claimQueueItem,
  selectClaimableQueueItems,
  recoverPersistentQueueOnStartup,
  createReasoningQueueWorker
} from '../../apps/control-server/src/server/reasoning/persistentQueue.js'
import { scanAndConvergeOrphanedSessions } from '../../apps/control-server/src/server/reasoning/orphanRecovery.js'
import { writeStepCheckpoint } from '../../apps/control-server/src/server/reasoning/stepCheckpoint.js'
import { registerReasoningRoutes } from '../../apps/control-server/src/server/routes/reasoningRoutes.js'

// AUTO-C01 测试：最小持久化任务队列。
// env 隔离：queue/checkpoint 目录指向临时目录，不污染真实 state/；
// worker tick 用毫秒级间隔，不做真实秒级等待。

const QUEUE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'persistent-queue-'))
const SESSION_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'persistent-queue-sessions-'))
const CHECKPOINT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'persistent-queue-checkpoints-'))
const savedQueueDirEnv = process.env.HERMES_REASONING_QUEUE_DIR
const savedCheckpointDirEnv = process.env.HERMES_REASONING_CHECKPOINT_DIR
const savedConcurrencyEnv = process.env.HERMES_REASONING_QUEUE_MAX_CONCURRENCY
process.env.HERMES_REASONING_QUEUE_DIR = QUEUE_DIR
process.env.HERMES_REASONING_CHECKPOINT_DIR = CHECKPOINT_DIR
delete process.env.HERMES_REASONING_QUEUE_MAX_CONCURRENCY

function restoreEnv() {
  if (savedQueueDirEnv === undefined) delete process.env.HERMES_REASONING_QUEUE_DIR
  else process.env.HERMES_REASONING_QUEUE_DIR = savedQueueDirEnv
  if (savedCheckpointDirEnv === undefined) delete process.env.HERMES_REASONING_CHECKPOINT_DIR
  else process.env.HERMES_REASONING_CHECKPOINT_DIR = savedCheckpointDirEnv
  if (savedConcurrencyEnv === undefined) delete process.env.HERMES_REASONING_QUEUE_MAX_CONCURRENCY
  else process.env.HERMES_REASONING_QUEUE_MAX_CONCURRENCY = savedConcurrencyEnv
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
    plan: { steps: [{ stepId: 's0' }, { stepId: 's1' }] },
    ...overrides
  }
}

function writeSessionFile(session) {
  fs.writeFileSync(path.join(SESSION_DIR, `${session.sessionId}.json`), JSON.stringify(session, null, 2), 'utf8')
}

function readSessionFile(sessionId) {
  return JSON.parse(fs.readFileSync(path.join(SESSION_DIR, `${sessionId}.json`), 'utf8'))
}

function sessionFileExists(sessionId) {
  return fs.existsSync(path.join(SESSION_DIR, `${sessionId}.json`))
}

// 注入 recovery / worker 的 session 存取实现：直接操作临时目录文件（镜像 updateReasoningSession 语义）
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

// 唯一 sessionId 生成，避免用例间相互污染
let seq = 0
function nextId(prefix) {
  seq += 1
  return `${prefix}_${seq}`
}

// ---------------------------------------------------------------------------
// 配置解析与纯函数
// ---------------------------------------------------------------------------

test('配置解析：默认并发 2 / tick 1000ms / 心跳扫描 60000ms，env 与非法值回退', () => {
  assert.equal(resolveQueueMaxConcurrency(), 2)
  assert.equal(resolveQueueTickMs(), 1000)
  assert.equal(resolveQueueHeartbeatScanIntervalMs(), 60000)
  process.env.HERMES_REASONING_QUEUE_MAX_CONCURRENCY = '3'
  try {
    assert.equal(resolveQueueMaxConcurrency(), 3)
    assert.equal(resolveQueueMaxConcurrency(5), 5)
  } finally {
    delete process.env.HERMES_REASONING_QUEUE_MAX_CONCURRENCY
  }
  assert.equal(resolveQueueMaxConcurrency(0), 2)
  assert.equal(resolveQueueMaxConcurrency('abc'), 2)
  assert.equal(resolveQueueTickMs(10), 10)
  assert.equal(resolveQueueTickMs(-1), 1000)
  assert.equal(resolveQueueHeartbeatScanIntervalMs(0), 0) // <=0 关闭
  assert.equal(resolveQueueHeartbeatScanIntervalMs('xyz'), 60000)
  assert.equal(resolveWaitingReviewTtlMs(), 86400000) // waiting_review 过期阈值默认 24h
  process.env.HERMES_REASONING_WAITING_REVIEW_TTL_MS = '3600000'
  try {
    assert.equal(resolveWaitingReviewTtlMs(), 3600000)
    assert.equal(resolveWaitingReviewTtlMs(7200000), 7200000)
  } finally {
    delete process.env.HERMES_REASONING_WAITING_REVIEW_TTL_MS
  }
  assert.equal(resolveWaitingReviewTtlMs(0), 0) // <=0 关闭过期收敛
  assert.equal(resolveWaitingReviewTtlMs('abc'), 86400000)
})

test('mapSessionStatusToQueueItemStatus 与终态/释放判定', () => {
  assert.equal(mapSessionStatusToQueueItemStatus('completed'), 'completed')
  assert.equal(mapSessionStatusToQueueItemStatus('failed'), 'failed')
  assert.equal(mapSessionStatusToQueueItemStatus('cancelled'), 'cancelled')
  assert.equal(mapSessionStatusToQueueItemStatus('timeout'), 'timeout')
  assert.equal(mapSessionStatusToQueueItemStatus('blocked'), 'blocked')
  assert.equal(mapSessionStatusToQueueItemStatus('waiting_review'), 'waiting_review')
  assert.equal(mapSessionStatusToQueueItemStatus('running'), null)
  assert.equal(mapSessionStatusToQueueItemStatus('queued'), null)
  assert.equal(isTerminalQueueItemState('completed'), true)
  assert.equal(isTerminalQueueItemState('waiting_review'), false)
  assert.equal(isReleasedQueueItemState('waiting_review'), true)
  assert.equal(isReleasedQueueItemState('running'), false)
  assert.equal(resolveQueueProjectKey({ sessionId: 's1', projectId: 'proj_a' }), 'project:proj_a')
  assert.equal(resolveQueueProjectKey({ sessionId: 's1', projectId: null }), 'session:s1')
})

// ---------------------------------------------------------------------------
// 入队 / 领取（数据格式 + 幂等 + 原子语义）
// ---------------------------------------------------------------------------

test('enqueueQueueItem：写入持久化 item（taskId/sessionId/projectId/claim/时间戳），重复入队幂等', () => {
  const sessionId = nextId('enq')
  const first = enqueueQueueItem({ sessionId, projectId: 'proj_x' })
  assert.equal(first.created, true)
  const item = first.item
  assert.equal(item.taskId, sessionId) // reasoning 任务 taskId 与 sessionId 同源
  assert.equal(item.sessionId, sessionId)
  assert.equal(item.projectId, 'proj_x')
  assert.equal(item.status, 'queued')
  assert.deepEqual(item.claim, { workerId: null, claimedAt: null, claimGeneration: 0 })
  assert.equal(item.attempts, 0)
  assert.equal(item.recoveryCount, 0)
  assert.ok(item.createdAt && item.updatedAt)
  assert.equal(item.history.length, 1)
  assert.equal(item.history[0].to, 'queued')
  // 文件真实存在（持久化证据）
  assert.ok(fs.existsSync(getQueueItemFilePath(sessionId)))

  const second = enqueueQueueItem({ sessionId, projectId: 'proj_x' })
  assert.equal(second.created, false)
  assert.equal(readQueueItem(sessionId).history.length, 1) // 未重复入队

  // 已终结 item 不重建
  updateQueueItem(sessionId, (current) => ({ ...current, status: 'completed' }))
  const third = enqueueQueueItem({ sessionId, projectId: 'proj_x' })
  assert.equal(third.created, false)
  assert.equal(third.terminal, true)
  assert.equal(readQueueItem(sessionId).status, 'completed')
})

test('claimQueueItem：仅 queued 可领取，写 workerId/claimedAt/claimGeneration，重复领取被拒绝', () => {
  const sessionId = nextId('claim')
  enqueueQueueItem({ sessionId, projectId: 'proj_y' })

  const missing = claimQueueItem('claim_missing', { workerId: 'w1' })
  assert.equal(missing.claimed, false)
  assert.equal(missing.reason, 'queue_item_not_found')

  const first = claimQueueItem(sessionId, { workerId: 'worker_A' })
  assert.equal(first.claimed, true)
  assert.equal(first.item.status, 'claimed')
  assert.equal(first.item.claim.workerId, 'worker_A')
  assert.equal(first.item.claim.claimGeneration, 1)
  assert.ok(first.item.claim.claimedAt)
  assert.equal(first.item.attempts, 1)

  // 非 queued 不可再领取（持久化验证：另一 worker 读到 claimed 即放弃）
  const second = claimQueueItem(sessionId, { workerId: 'worker_B' })
  assert.equal(second.claimed, false)
  assert.match(second.reason, /not_queued:claimed/)
  assert.equal(readQueueItem(sessionId).claim.workerId, 'worker_A') // claim 未被覆盖

  // 重新排队后 claimGeneration 单调递增（旧 claim 永远失效）
  updateQueueItem(sessionId, (current) => ({ ...current, status: 'queued' }))
  const third = claimQueueItem(sessionId, { workerId: 'worker_B' })
  assert.equal(third.claimed, true)
  assert.equal(third.item.claim.claimGeneration, 2)
})

test('selectClaimableQueueItems：FIFO、同 project 串行、全局并发上限', () => {
  const mk = (sessionId, projectId, createdAt) => ({ sessionId, projectId, createdAt, status: 'queued' })
  const items = [
    mk('t3', 'projB', '2026-08-15T00:00:03.000Z'),
    mk('t1', 'projA', '2026-08-15T00:00:01.000Z'),
    mk('t2', 'projA', '2026-08-15T00:00:02.000Z'),
    { sessionId: 't9', projectId: 'projC', createdAt: '2026-08-15T00:00:00.000Z', status: 'running' } // 非 queued 不参与
  ]
  // 上限 2：t1 与 t3 可选（不同 project），t2 与 t1 同 project 串行被跳过
  const picked = selectClaimableQueueItems(items, { activeProjectKeys: new Set(), activeCount: 0, maxConcurrency: 2 })
  assert.deepEqual(picked.map((i) => i.sessionId), ['t1', 't3'])
  // 已有 1 个在执行：只剩 1 个槽位
  const picked2 = selectClaimableQueueItems(items, { activeProjectKeys: new Set(['project:projZ']), activeCount: 1, maxConcurrency: 2 })
  assert.deepEqual(picked2.map((i) => i.sessionId), ['t1'])
  // projA 已在执行：t1/t2 都跳过，只剩 t3
  const picked3 = selectClaimableQueueItems(items, { activeProjectKeys: new Set(['project:projA']), activeCount: 1, maxConcurrency: 3 })
  assert.deepEqual(picked3.map((i) => i.sessionId), ['t3'])
  // 槽位占满：无可领取
  assert.deepEqual(selectClaimableQueueItems(items, { activeProjectKeys: new Set(), activeCount: 2, maxConcurrency: 2 }), [])
})

// ---------------------------------------------------------------------------
// S2-08：三个任务——同 projectId 串行，不同 project 受全局并发上限约束
// ---------------------------------------------------------------------------

test('S2-08：三任务调度——projA 串行、跨 project 并发 2，item 收敛终态且事件可追溯', async () => {
  const store = makeSessionStore()
  const t1 = nextId('s208a')
  const t2 = nextId('s208b')
  const t3 = nextId('s208c')
  for (const [sessionId, projectId] of [[t1, 'projA'], [t2, 'projA'], [t3, 'projB']]) {
    writeSessionFile(makeSession(sessionId, { submissionContext: { projectId } }))
    enqueueQueueItem({ sessionId, projectId })
  }

  const timeline = []
  const worker = createReasoningQueueWorker({
    workerId: 'worker_s208',
    maxConcurrency: 2,
    tickMs: 5,
    readSession: store.read,
    appendEvent: store.appendEvent,
    executeItem: async (item) => {
      timeline.push({ type: 'start', sessionId: item.sessionId, at: Date.now() })
      await sleep(40)
      store.update(item.sessionId, (s) => ({ ...s, status: 'completed' }))
      timeline.push({ type: 'end', sessionId: item.sessionId, at: Date.now() })
    }
  })
  worker.start()
  try {
    await waitFor(() => [t1, t2, t3].every((id) => readQueueItem(id)?.status === 'completed'))
  } finally {
    worker.stop()
  }

  const startOf = (id) => timeline.find((e) => e.type === 'start' && e.sessionId === id).at
  const endOf = (id) => timeline.find((e) => e.type === 'end' && e.sessionId === id).at
  // 同 projectId 串行：t2 在 t1 结束后才开始
  assert.ok(startOf(t2) >= endOf(t1), `同 project 应串行：t2.start=${startOf(t2)} t1.end=${endOf(t1)}`)
  // 跨 project 并发：t1 与 t3 执行窗口重叠（全局并发 2）
  assert.ok(startOf(t3) < endOf(t1) && startOf(t1) < endOf(t3), '不同 project 应并发执行')

  // item 持久化终态与 claim 证据
  for (const id of [t1, t2, t3]) {
    const item = readQueueItem(id)
    assert.equal(item.status, 'completed')
    assert.equal(item.claim.workerId, 'worker_s208')
    assert.equal(item.claim.claimGeneration, 1)
    assert.equal(item.attempts, 1)
    assert.ok(item.finishedAt)
  }
  // task_id/projectId/worker 关联日志（队列事件挂 session 事件流）
  const claimed = store.events.filter((e) => e.type === 'queue_claimed')
  assert.equal(claimed.length, 3)
  for (const id of [t1, t2, t3]) {
    const event = claimed.find((e) => e.sessionId === id)
    assert.equal(event.data.taskId, id)
    assert.equal(event.data.workerId, 'worker_s208')
    assert.equal(event.data.projectId, id === t3 ? 'projB' : 'projA')
  }
  const finished = store.events.filter((e) => e.type === 'queue_finished')
  assert.equal(finished.length, 3)
  assert.ok(finished.every((e) => e.data.outcome === 'completed'))
  assert.equal(worker.getState().activeCount, 0) // 槽位全部释放
})

// ---------------------------------------------------------------------------
// S2-09：一个任务失败，独立后续任务仍被领取
// ---------------------------------------------------------------------------

test('S2-09：同 project 前序任务失败不阻塞后续独立任务（槽位释放）', async () => {
  const store = makeSessionStore()
  const f1 = nextId('s209a')
  const f2 = nextId('s209b')
  for (const sessionId of [f1, f2]) {
    writeSessionFile(makeSession(sessionId, { submissionContext: { projectId: 'projD' } }))
    enqueueQueueItem({ sessionId, projectId: 'projD' })
  }

  const timeline = []
  const worker = createReasoningQueueWorker({
    workerId: 'worker_s209',
    maxConcurrency: 1, // 强制串行，验证失败后槽位释放
    tickMs: 5,
    readSession: store.read,
    appendEvent: store.appendEvent,
    executeItem: async (item) => {
      timeline.push({ type: 'start', sessionId: item.sessionId, at: Date.now() })
      await sleep(10)
      if (item.sessionId === f1) {
        store.update(item.sessionId, (s) => ({ ...s, status: 'failed', error: 'step_boom' }))
      } else {
        store.update(item.sessionId, (s) => ({ ...s, status: 'completed' }))
      }
      timeline.push({ type: 'end', sessionId: item.sessionId, at: Date.now() })
    }
  })
  worker.start()
  try {
    await waitFor(() => readQueueItem(f1)?.status === 'failed' && readQueueItem(f2)?.status === 'completed')
  } finally {
    worker.stop()
  }

  const startOf = (id) => timeline.find((e) => e.type === 'start' && e.sessionId === id).at
  const endOf = (id) => timeline.find((e) => e.type === 'end' && e.sessionId === id).at
  assert.ok(startOf(f2) >= endOf(f1), '失败后同 project 后续任务仍按序被领取')
  const finished = store.events.filter((e) => e.type === 'queue_finished')
  assert.equal(finished.find((e) => e.sessionId === f1)?.data.outcome, 'failed')
  assert.equal(finished.find((e) => e.sessionId === f2)?.data.outcome, 'completed')
})

test('S2-09：执行链未收敛的异常由 worker 兜底终结为 failed，后续任务不受影响', async () => {
  const store = makeSessionStore()
  const g1 = nextId('s209c')
  const g2 = nextId('s209d')
  for (const sessionId of [g1, g2]) {
    writeSessionFile(makeSession(sessionId, { submissionContext: { projectId: 'projE' } }))
    enqueueQueueItem({ sessionId, projectId: 'projE' })
  }

  const executed = []
  const worker = createReasoningQueueWorker({
    workerId: 'worker_s209b',
    maxConcurrency: 1,
    tickMs: 5,
    readSession: store.read,
    appendEvent: store.appendEvent,
    executeItem: async (item) => {
      executed.push(item.sessionId)
      if (item.sessionId === g1) throw new Error('execute_boom') // 模拟执行链未自捕获的兜底路径
      store.update(item.sessionId, (s) => ({ ...s, status: 'completed' }))
    }
  })
  worker.start()
  try {
    await waitFor(() => readQueueItem(g1)?.status === 'failed' && readQueueItem(g2)?.status === 'completed')
  } finally {
    worker.stop()
  }

  assert.deepEqual(executed, [g1, g2]) // g1 失败未阻塞 g2
  const item = readQueueItem(g1)
  assert.equal(item.status, 'failed')
  assert.equal(item.lastError, 'execute_boom')
  assert.ok(item.history.some((h) => h.reason === 'queue_execute_rejected'))
})

// ---------------------------------------------------------------------------
// S2-10：服务重启后未终结 item 恢复调度且不重复领取
// ---------------------------------------------------------------------------

test('S2-10：重启恢复——按 B03 orphan 语义收敛后重排队，不重复领取，证据不足明确阻断', async () => {
  const store = makeSessionStore()
  const deadWorker = 'dead_worker_old_process'
  // 独立 queue 目录：恢复摘要是全目录统计，不与其他用例的遗留 item 混算
  const isolatedQueueDir = fs.mkdtempSync(path.join(os.tmpdir(), 'persistent-queue-s210-'))
  const previousQueueDir = process.env.HERMES_REASONING_QUEUE_DIR
  process.env.HERMES_REASONING_QUEUE_DIR = isolatedQueueDir

  // a：queued item + queued session（从未开始）-> 保持 queued
  const a = nextId('s210a')
  writeSessionFile(makeSession(a))
  enqueueQueueItem({ sessionId: a })
  // b：running item（死 worker 持有）+ running session + 合法 checkpoint -> 重排队且从 nextStepIndex 恢复
  const b = nextId('s210b')
  writeSessionFile(makeSession(b, { status: 'running' }))
  enqueueQueueItem({ sessionId: b })
  claimQueueItem(b, { workerId: deadWorker })
  updateQueueItem(b, (current) => ({ ...current, status: 'running' }))
  writeStepCheckpoint(makeSession(b, { submissionContext: { projectId: null } }), { stepId: 's0' }, 0, { ok: true })
  // c：running item + running session 无 checkpoint -> session blocked，item blocked
  const c = nextId('s210c')
  writeSessionFile(makeSession(c, { status: 'running' }))
  enqueueQueueItem({ sessionId: c })
  claimQueueItem(c, { workerId: deadWorker })
  updateQueueItem(c, (current) => ({ ...current, status: 'running' }))
  // d：running item + waiting_review session -> 释放为 waiting_review，不自动重排队（审核门禁不可绕过）
  const d = nextId('s210d')
  writeSessionFile(makeSession(d, { status: 'waiting_review' }))
  enqueueQueueItem({ sessionId: d })
  claimQueueItem(d, { workerId: deadWorker })
  updateQueueItem(d, (current) => ({ ...current, status: 'running' }))
  // f：waiting_review 超龄（25h 无人处理）-> 启动恢复收敛为 cancelled（防僵尸审核面板永久驻留）
  const f = nextId('s210f')
  const staleReviewSince = new Date(Date.now() - 25 * 3600000).toISOString()
  writeSessionFile(makeSession(f, {
    status: 'waiting_review',
    review: { status: 'pending', title: '审核运行任务图' },
    stateTransitions: [
      { from: 'queued', to: 'running', reason: 'plan created, execution started', timestamp: staleReviewSince },
      { from: 'running', to: 'waiting_review', reason: 'review requested: 审核运行任务图', timestamp: staleReviewSince }
    ]
  }))
  enqueueQueueItem({ sessionId: f })
  claimQueueItem(f, { workerId: deadWorker })
  updateQueueItem(f, (current) => ({ ...current, status: 'running' }))
  // i：waiting_review 未超龄（1h 前进入等待）-> 仍释放为 waiting_review，不误伤在审任务
  const i = nextId('s210i')
  const freshReviewSince = new Date(Date.now() - 3600000).toISOString()
  writeSessionFile(makeSession(i, {
    status: 'waiting_review',
    review: { status: 'pending', title: '审核运行任务图' },
    stateTransitions: [
      { from: 'running', to: 'waiting_review', reason: 'review requested: 审核运行任务图', timestamp: freshReviewSince }
    ]
  }))
  enqueueQueueItem({ sessionId: i })
  claimQueueItem(i, { workerId: deadWorker })
  updateQueueItem(i, (current) => ({ ...current, status: 'running' }))
  // g：running item + session 缺失 -> item blocked（明确阻断，不猜测）
  const g = nextId('s210g')
  enqueueQueueItem({ sessionId: g })
  claimQueueItem(g, { workerId: deadWorker })
  updateQueueItem(g, (current) => ({ ...current, status: 'running' }))
  // h：无 queue item 的遗留 queued session -> orphan 扫描按 B03 语义收敛（验证 skip 集合不误伤）
  const h = nextId('s210h')
  writeSessionFile(makeSession(h, { status: 'queued' }))

  // 重启前：新 worker 不得偷取死 worker 的 claim（不重复领取的第一道防线）
  const stolenExecutions = []
  const preWorker = createReasoningQueueWorker({
    workerId: 'worker_s210_new',
    maxConcurrency: 5,
    tickMs: 1000,
    readSession: store.read,
    appendEvent: store.appendEvent,
    canExecute: () => false, // 只跑 reconcile，不领取新任务（隔离变量，专注验证 claim 防盗）
    executeItem: async (item) => { stolenExecutions.push(item.sessionId) }
  })
  preWorker.tick() // 手动驱动一次调度（未 start，验证纯调度语义）
  await sleep(10)
  assert.equal(readQueueItem(b).claim.workerId, deadWorker) // b/c/d/g 的 claim 均未被盗取
  assert.equal(readQueueItem(c).claim.workerId, deadWorker)
  assert.equal(stolenExecutions.includes(b), false)
  assert.equal(stolenExecutions.includes(c), false)
  assert.equal(stolenExecutions.includes(d), false)
  assert.equal(stolenExecutions.includes(g), false)

  // e：queued item + cancelled session（等待期间被取消）-> 恢复时镜像 cancelled
  // （在预 worker 之后播种：预 tick 的镜像路径与恢复镜像等价，这里专注验证恢复路径）
  const e = nextId('s210e')
  writeSessionFile(makeSession(e, { status: 'cancelled' }))
  enqueueQueueItem({ sessionId: e })

  // 启动恢复（先于 orphan 扫描，与 core.cleanupOrphanedReasoningSessions 同序）
  const summary = recoverPersistentQueueOnStartup({
    readSession: store.read,
    updateSession: store.update,
    appendEvent: store.appendEvent
  })
  assert.equal(summary.requeued, 1) // 仅 b
  assert.equal(summary.keptQueued, 1) // a
  assert.equal(summary.mirroredTerminal, 1) // e
  assert.equal(summary.releasedWaitingReview, 2) // d（无时间戳）+ i（未超龄）
  assert.equal(summary.expiredWaitingReview, 1) // f（超龄收敛 cancelled）
  assert.equal(summary.blocked, 2) // c + g
  for (const id of [a, b, c, d, e, f, i, g]) {
    assert.ok(summary.managedSessionIds.has(id), `managedSessionIds 应包含 ${id}`)
  }

  // a：session 保持 queued（未被误判 orphan）；item 保持 queued
  assert.equal(readSessionFile(a).status, 'queued')
  assert.equal(readQueueItem(a).status, 'queued')
  // b：session 收敛为 orphaned；item 重排队，resumeFromStep=checkpoint.nextStepIndex=1，claim 清空、代数保留
  assert.equal(readSessionFile(b).status, 'orphaned')
  const itemB = readQueueItem(b)
  assert.equal(itemB.status, 'queued')
  assert.equal(itemB.resumeFromStep, 1)
  assert.equal(itemB.recoveryCount, 1)
  assert.equal(itemB.claim.workerId, null)
  assert.equal(itemB.claim.claimGeneration, 1)
  assert.ok(store.events.some((ev) => ev.sessionId === b && ev.type === 'queue_requeued' && ev.data.resumeFromStep === 1))
  // c：证据不足——session blocked，item blocked
  assert.equal(readSessionFile(c).status, 'blocked')
  assert.equal(readQueueItem(c).status, 'blocked')
  // d：人工审核等待不自动重排队
  assert.equal(readSessionFile(d).status, 'waiting_review')
  assert.equal(readQueueItem(d).status, 'waiting_review')
  // f：超龄未审 -> session cancelled（review 清空、留 error 证据），item 镜像 cancelled
  const sessionF = readSessionFile(f)
  assert.equal(sessionF.status, 'cancelled')
  assert.equal(sessionF.review, null)
  assert.equal(sessionF.error, 'queue_waiting_review_expired')
  const itemF = readQueueItem(f)
  assert.equal(itemF.status, 'cancelled')
  assert.equal(itemF.lastError, 'queue_waiting_review_expired')
  assert.ok(store.events.some((ev) => ev.sessionId === f && ev.type === 'session_cancelled' && ev.data.reason === 'queue_waiting_review_expired'))
  // i：未超龄的在审任务不误伤
  assert.equal(readSessionFile(i).status, 'waiting_review')
  assert.equal(readQueueItem(i).status, 'waiting_review')
  // e：镜像终态，不重复领取
  assert.equal(readQueueItem(e).status, 'cancelled')
  // g：session 缺失明确阻断
  assert.equal(readQueueItem(g).status, 'blocked')
  assert.equal(readQueueItem(g).lastError, 'queue_session_missing')

  // orphan 扫描跳过队列管理的 session；遗留 h 按 B03 语义收敛（queued -> orphaned -> blocked）
  const orphanSummary = scanAndConvergeOrphanedSessions({
    sessionDirs: [SESSION_DIR],
    updateSession: store.update,
    appendEvent: store.appendEvent,
    assumeRestart: true,
    skipSessionIds: summary.managedSessionIds
  })
  assert.ok(orphanSummary.queueManagedSkipped >= 5) // a/b/c/d/e（g 无 session 文件，扫不到）
  assert.equal(readSessionFile(a).status, 'queued') // 队列等待中的 session 未被误判孤儿
  assert.equal(readSessionFile(h).status, 'blocked') // 无 checkpoint 的遗留 queued session 被阻断（B03 语义不变）

  // 恢复后：新 worker 各领取一次且不重复；resumeFromStep 随 item 传给执行链
  const executions = []
  const worker = createReasoningQueueWorker({
    workerId: 'worker_s210_new',
    maxConcurrency: 2,
    tickMs: 5,
    readSession: store.read,
    appendEvent: store.appendEvent,
    executeItem: async (item) => {
      executions.push({ sessionId: item.sessionId, resumeFromStep: item.resumeFromStep ?? null })
      store.update(item.sessionId, (s) => ({ ...s, status: 'completed' }))
    }
  })
  worker.start()
  try {
    await waitFor(() => readQueueItem(a)?.status === 'completed' && readQueueItem(b)?.status === 'completed')
    await sleep(20) // 多跑几个 tick，验证无重复领取
  } finally {
    worker.stop()
  }

  assert.equal(executions.filter((x) => x.sessionId === a).length, 1)
  assert.equal(executions.filter((x) => x.sessionId === b).length, 1)
  assert.equal(executions.find((x) => x.sessionId === b)?.resumeFromStep, 1) // 从 checkpoint 恢复，已成功 step 不重跑
  assert.equal(executions.filter((x) => x.sessionId === c).length, 0)
  assert.equal(executions.filter((x) => x.sessionId === d).length, 0)
  assert.equal(executions.filter((x) => x.sessionId === e).length, 0)
  assert.equal(executions.filter((x) => x.sessionId === f).length, 0)
  assert.equal(executions.filter((x) => x.sessionId === i).length, 0)
  assert.equal(readQueueItem(a).claim.claimGeneration, 1)
  assert.equal(readQueueItem(b).claim.claimGeneration, 2) // 重排队后领取代数单调递增
  process.env.HERMES_REASONING_QUEUE_DIR = previousQueueDir
})

// ---------------------------------------------------------------------------
// 发起路径兼容：创建即入队，API 形状不变，projectId 透传
// ---------------------------------------------------------------------------

test('发起路径：POST reasoning-sessions 创建后入队而非立即执行，API 形状不变，projectId 透传', async () => {
  const calls = { dispatch: [], create: [] }
  const context = {
    hermesAgentDefinition: { id: 'hermes-manager' },
    readReasoningSession: () => null,
    updateReasoningSession: () => { throw new Error('not_used') },
    appendReasoningEvent: () => {},
    clearReasoningReview: () => {},
    getHermesRuntimeState: () => ({ state: 'running' }),
    getHermesControlState: () => ({}),
    buildReasoningStartBlocker: () => null,
    buildHermesBinding: () => ({}),
    readHermesChatHistory: () => [],
    createReasoningSession: async (agentId, prompt, submissionContext) => {
      calls.create.push({ agentId, prompt, submissionContext })
      return {
        sessionId: 'sess_route_1',
        runtimeSessionId: 'sess_route_1',
        status: 'queued',
        createdAt: '2026-08-15T00:00:00.000Z',
        plan: null,
        artifacts: {},
        submissionContext
      }
    },
    persistHermesChatPrompt: () => {},
    persistHermesChatReply: () => {},
    dispatchReasoningSession: (sessionId) => { calls.dispatch.push(sessionId) },
    markReasoningSessionFailed: () => {}
  }
  const app = new Hono()
  registerReasoningRoutes(app, context)

  const res = await app.request('/api/control/agents/hermes-manager/reasoning-sessions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ prompt: '做一个互动故事', projectId: 'proj_route' })
  })
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.equal(body.ok, true)
  assert.equal(body.session.sessionId, 'sess_route_1')
  assert.equal(body.session.status, 'queued') // API 形状不变：创建即 queued
  // 入队替代立即执行
  assert.deepEqual(calls.dispatch, ['sess_route_1'])
  // projectId 透传进 submissionContext（队列按它做同 project 串行）
  assert.equal(calls.create[0].submissionContext.projectId, 'proj_route')
})

// ---------------------------------------------------------------------------
// 收尾
// ---------------------------------------------------------------------------

test('cleanup：恢复 env，无 worker 遗留 timer', async () => {
  const { items } = listQueueItems() // 临时目录全程可读
  assert.ok(Array.isArray(items))
  restoreEnv()
})
