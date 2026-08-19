import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import {
  RETENTION_POLICY_DEFAULTS,
  resolveRetentionPolicies,
  pruneTtlCache,
  evictOldestCacheEntries,
  runReasoningRetentionCleanup
} from '../../apps/control-server/src/server/reasoning/retentionCleanup.js'
import { runMemoryLifecycleMaintenance } from '../../apps/control-server/src/server/memory/lifecycleMaintenance.js'
import {
  reserveSessionCall,
  pruneSessionCallCounts,
  getSessionCallCountsSnapshot
} from '../../apps/control-server/src/server/model/modelTaskQueue.js'

// AUTO-C03 测试：缓存、session 与日志保留清理（S3-03）。
// 覆盖：过期删除（先归档后删除）、活跃保护、pending review 保护、未归档证据保护、
// dry-run 零副作用、重复运行幂等、内存缓存 TTL/上限淘汰、chat history env 策略。
// 全部数据构造在临时目录，不污染真实 state/。

const DAY_MS = 24 * 60 * 60 * 1000
const NOW = new Date('2026-08-15T00:00:00.000Z')

function daysAgoIso(days) {
  return new Date(NOW.getTime() - days * DAY_MS).toISOString()
}

function makeDirs() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'retention-cleanup-'))
  const dirs = {
    root,
    runtime: path.join(root, 'agent-runtime-sessions'),
    legacy: path.join(root, 'reasoning-sessions'),
    queue: path.join(root, 'reasoning-queue'),
    checkpoints: path.join(root, 'reasoning-checkpoints'),
    archive: path.join(root, 'memory-archive', 'retention'),
    report: path.join(root, 'retention-cleanup')
  }
  for (const dir of [dirs.runtime, dirs.legacy, dirs.queue, dirs.checkpoints]) {
    fs.mkdirSync(dir, { recursive: true })
  }
  return dirs
}

function makeSession(sessionId, overrides = {}) {
  return {
    sessionId,
    status: 'completed',
    createdAt: daysAgoIso(40),
    updatedAt: daysAgoIso(40),
    review: null,
    plan: { steps: [] },
    events: [],
    artifacts: {},
    ...overrides
  }
}

function writeSession(dir, session) {
  const filePath = path.join(dir, `${session.sessionId}.json`)
  fs.writeFileSync(filePath, JSON.stringify(session, null, 2), 'utf8')
  return filePath
}

function writeQueueItem(dir, sessionId, overrides = {}) {
  const item = {
    version: '1',
    taskId: sessionId,
    sessionId,
    projectId: null,
    status: 'completed',
    claim: { workerId: null, claimedAt: null, claimGeneration: 0 },
    retryCount: 0,
    retryHistory: [],
    createdAt: daysAgoIso(41),
    updatedAt: daysAgoIso(40),
    finishedAt: daysAgoIso(40),
    history: [],
    ...overrides
  }
  const filePath = path.join(dir, `${sessionId}.json`)
  fs.writeFileSync(filePath, JSON.stringify(item, null, 2), 'utf8')
  return filePath
}

function writeCheckpoint(dir, sessionId, stepIndex, overrides = {}) {
  const checkpoint = {
    version: '1',
    sessionId,
    stepIndex,
    nextStepIndex: stepIndex + 1,
    createdAt: daysAgoIso(40),
    ...overrides
  }
  const filePath = path.join(dir, `${sessionId}_step_${stepIndex}.json`)
  fs.writeFileSync(filePath, JSON.stringify(checkpoint, null, 2), 'utf8')
  return filePath
}

function runCleanup(dirs, extra = {}) {
  return runReasoningRetentionCleanup({
    now: NOW,
    sessionDirs: [dirs.runtime, dirs.legacy],
    queueDir: dirs.queue,
    checkpointDir: dirs.checkpoints,
    archiveRootDir: dirs.archive,
    reportDir: dirs.report,
    ...extra
  })
}

function entriesById(report, category, id) {
  return report.entries.filter((entry) => entry.category === category && String(entry.id).startsWith(id))
}

test('S3-03：策略解析——默认值安全，env 可覆盖，enabled 布尔解析', () => {
  const defaults = resolveRetentionPolicies({})
  assert.deepEqual(defaults, RETENTION_POLICY_DEFAULTS)
  assert.equal(defaults.sessionTtlDays, 30)
  assert.equal(defaults.queueItemTtlDays, 30)
  assert.equal(defaults.checkpointTtlDays, 30)
  assert.equal(defaults.inspectModelCacheTtlMs, 24 * 60 * 60 * 1000)
  assert.equal(defaults.inspectModelCacheMaxEntries, 200)
  assert.equal(defaults.sessionCallCacheMaxEntries, 500)
  assert.equal(defaults.enabled, true)

  const overridden = resolveRetentionPolicies({
    HERMES_RETENTION_SESSION_TTL_DAYS: '7',
    HERMES_RETENTION_QUEUE_ITEM_TTL_DAYS: '14',
    HERMES_RETENTION_CHECKPOINT_TTL_DAYS: '10',
    HERMES_INSPECT_MODEL_CACHE_TTL_MS: '1000',
    HERMES_INSPECT_MODEL_CACHE_MAX_ENTRIES: '5',
    HERMES_MODEL_TASK_SESSION_CALL_CACHE_MAX_ENTRIES: '9',
    HERMES_RETENTION_CLEANUP_ENABLED: 'off'
  })
  assert.equal(overridden.sessionTtlDays, 7)
  assert.equal(overridden.queueItemTtlDays, 14)
  assert.equal(overridden.checkpointTtlDays, 10)
  assert.equal(overridden.inspectModelCacheTtlMs, 1000)
  assert.equal(overridden.inspectModelCacheMaxEntries, 5)
  assert.equal(overridden.sessionCallCacheMaxEntries, 9)
  assert.equal(overridden.enabled, false)

  // 非法值回退默认，不崩
  const garbage = resolveRetentionPolicies({ HERMES_RETENTION_SESSION_TTL_DAYS: 'abc', HERMES_RETENTION_CLEANUP_ENABLED: 'maybe' })
  assert.equal(garbage.sessionTtlDays, 30)
  assert.equal(garbage.enabled, true)
})

test('S3-03：过期终态 session 先归档后删除，checkpoint 与 queue item 随迁', () => {
  const dirs = makeDirs()
  const session = makeSession('s_old', { status: 'completed' })
  const runtimeFile = writeSession(dirs.runtime, session)
  const legacyFile = writeSession(dirs.legacy, session)
  const checkpointFile = writeCheckpoint(dirs.checkpoints, 's_old', 0)
  const itemFile = writeQueueItem(dirs.queue, 's_old', { status: 'completed' })

  const report = runCleanup(dirs)

  // 原件全部删除
  assert.equal(fs.existsSync(runtimeFile), false)
  assert.equal(fs.existsSync(legacyFile), false)
  assert.equal(fs.existsSync(checkpointFile), false)
  assert.equal(fs.existsSync(itemFile), false)
  // 归档副本存在且内容一致（含来源目录名，runtime/legacy 不互相覆盖）
  const archivedRuntime = path.join(dirs.archive, 'reasoningSessions', 'agent-runtime-sessions', 's_old.json')
  const archivedLegacy = path.join(dirs.archive, 'reasoningSessions', 'reasoning-sessions', 's_old.json')
  const archivedCheckpoint = path.join(dirs.archive, 'checkpoints', 'reasoning-checkpoints', 's_old_step_0.json')
  const archivedItem = path.join(dirs.archive, 'queueItems', 'reasoning-queue', 's_old.json')
  for (const archived of [archivedRuntime, archivedLegacy, archivedCheckpoint, archivedItem]) {
    assert.equal(fs.existsSync(archived), true, `归档副本缺失: ${archived}`)
  }
  assert.deepEqual(JSON.parse(fs.readFileSync(archivedRuntime, 'utf8')), session)
  // 统计与原因可追溯
  assert.equal(report.summary.deleted, 4)
  assert.equal(report.summary.archived, 4)
  assert.equal(report.categories.reasoningSessions.reasons.terminal_expired, 2)
  assert.equal(report.categories.checkpoints.reasons.session_cleaned, 1)
  assert.equal(report.categories.queueItems.reasons.terminal_expired, 1)
  // 可追溯报告落盘
  assert.equal(fs.existsSync(path.join(dirs.report, 'latest-report.json')), true)
  const historyLines = fs.readFileSync(path.join(dirs.report, 'history.jsonl'), 'utf8').trim().split('\n')
  assert.equal(historyLines.length, 1)
  assert.equal(JSON.parse(historyLines[0]).deleted, 4)
})

test('S3-03：活跃保护——非终态 session 与非终态 queue item 超龄也不删（反向证据）', () => {
  const dirs = makeDirs()
  const activeStatuses = ['queued', 'running', 'waiting_review', 'retry_wait', 'orphaned', 'paused', 'pausing', 'resuming']
  for (const status of activeStatuses) {
    writeSession(dirs.runtime, makeSession(`s_${status}`, { status, updatedAt: daysAgoIso(90) }))
  }
  const activeItemStatuses = ['queued', 'claimed', 'running', 'waiting_review']
  for (const status of activeItemStatuses) {
    writeQueueItem(dirs.queue, `item_${status}`, { status, finishedAt: null, updatedAt: daysAgoIso(90) })
    // 活跃 item 对应的孤儿 checkpoint（session 文件不存在）同样受保护
    writeCheckpoint(dirs.checkpoints, `item_${status}`, 0, { createdAt: daysAgoIso(90) })
  }

  const report = runCleanup(dirs)

  assert.equal(report.summary.deleted, 0)
  for (const status of activeStatuses) {
    assert.equal(fs.existsSync(path.join(dirs.runtime, `s_${status}.json`)), true, `活跃 session 被误删: ${status}`)
  }
  for (const status of activeItemStatuses) {
    assert.equal(fs.existsSync(path.join(dirs.queue, `item_${status}.json`)), true, `活跃 queue item 被误删: ${status}`)
    assert.equal(fs.existsSync(path.join(dirs.checkpoints, `item_${status}_step_0.json`)), true, `活跃 item 的 checkpoint 被误删: ${status}`)
  }
  assert.equal(report.categories.reasoningSessions.reasons['active_status:running'], 1)
  assert.equal(report.categories.reasoningSessions.reasons.waiting_review, 1)
  assert.equal(report.categories.queueItems.reasons['active_status:claimed'], 1)
  assert.equal(report.categories.queueItems.reasons.waiting_review, 1)
  assert.equal(report.categories.checkpoints.reasons['queue_item_active:queued'], 1)
})

test('S3-03：pending review 硬保护——终态/failed 上残留未决审核也不删', () => {
  const dirs = makeDirs()
  writeSession(dirs.runtime, makeSession('s_review_terminal', {
    status: 'completed',
    updatedAt: daysAgoIso(90),
    review: { status: 'pending', targetType: 'step', title: '审核步骤' }
  }))
  writeSession(dirs.runtime, makeSession('s_review_failed', {
    status: 'failed',
    updatedAt: daysAgoIso(90),
    review: { status: 'pending', targetType: 'plan', title: '审核计划' }
  }))

  const report = runCleanup(dirs)

  assert.equal(report.summary.deleted, 0)
  assert.equal(report.categories.reasoningSessions.reasons.pending_review, 2)
  assert.equal(fs.existsSync(path.join(dirs.runtime, 's_review_terminal.json')), true)
  assert.equal(fs.existsSync(path.join(dirs.runtime, 's_review_failed.json')), true)
})

test('S3-03：protectedSessionIds 硬保护——进程内活跃句柄即使终态超龄也不删', () => {
  const dirs = makeDirs()
  writeSession(dirs.runtime, makeSession('s_protected', { status: 'completed', updatedAt: daysAgoIso(90) }))

  const report = runCleanup(dirs, { protectedSessionIds: new Set(['s_protected']) })

  assert.equal(report.summary.deleted, 0)
  assert.equal(report.categories.reasoningSessions.reasons.protected_active, 1)
  assert.equal(fs.existsSync(path.join(dirs.runtime, 's_protected.json')), true)
})

test('S3-03：failed session 保留重试证据——TTL 内不删，超 TTL 才删', () => {
  const dirs = makeDirs()
  writeSession(dirs.runtime, makeSession('s_failed_young', { status: 'failed', updatedAt: daysAgoIso(10) }))
  writeSession(dirs.runtime, makeSession('s_failed_old', { status: 'failed', updatedAt: daysAgoIso(40) }))

  const report = runCleanup(dirs)

  assert.equal(fs.existsSync(path.join(dirs.runtime, 's_failed_young.json')), true, 'TTL 内的 failed 重试证据被误删')
  assert.equal(fs.existsSync(path.join(dirs.runtime, 's_failed_old.json')), false, '超 TTL 的 failed 未被清理')
  assert.equal(report.categories.reasoningSessions.reasons.within_ttl, 1)
  assert.equal(report.categories.reasoningSessions.reasons.failed_expired, 1)
})

test('S3-03：queue item——session 仍保留时 item 作为证据保留；session 缺失才可删', () => {
  const dirs = makeDirs()
  // session 在 TTL 内保留 -> 对应 item 即使终态超龄也保留
  writeSession(dirs.runtime, makeSession('s_kept', { status: 'completed', updatedAt: daysAgoIso(10) }))
  writeQueueItem(dirs.queue, 's_kept', { status: 'completed', finishedAt: daysAgoIso(60) })
  // session 不存在 -> 终态超龄 item 可删
  writeQueueItem(dirs.queue, 's_gone', { status: 'failed', finishedAt: daysAgoIso(60) })

  const report = runCleanup(dirs)

  assert.equal(fs.existsSync(path.join(dirs.queue, 's_kept.json')), true, 'session 保留中的 item 被误删')
  assert.equal(fs.existsSync(path.join(dirs.queue, 's_gone.json')), false, 'session 缺失的终态超龄 item 未清理')
  assert.equal(report.categories.queueItems.reasons.session_retained, 1)
  assert.equal(report.categories.queueItems.reasons.terminal_expired, 1)
})

test('S3-03：孤儿 checkpoint——TTL 内保护；queue item 活跃保护；终态/缺席才可删', () => {
  const dirs = makeDirs()
  writeCheckpoint(dirs.checkpoints, 'cp_young', 0, { createdAt: daysAgoIso(10) })
  writeCheckpoint(dirs.checkpoints, 'cp_active_item', 0, { createdAt: daysAgoIso(40) })
  writeQueueItem(dirs.queue, 'cp_active_item', { status: 'queued', finishedAt: null, updatedAt: daysAgoIso(40) })
  writeCheckpoint(dirs.checkpoints, 'cp_terminal_item', 0, { createdAt: daysAgoIso(40) })
  writeQueueItem(dirs.queue, 'cp_terminal_item', { status: 'completed', finishedAt: daysAgoIso(5) })
  writeCheckpoint(dirs.checkpoints, 'cp_free', 0, { createdAt: daysAgoIso(40) })

  const report = runCleanup(dirs)

  assert.equal(fs.existsSync(path.join(dirs.checkpoints, 'cp_young_step_0.json')), true, 'TTL 内孤儿 checkpoint 被误删')
  assert.equal(fs.existsSync(path.join(dirs.checkpoints, 'cp_active_item_step_0.json')), true, 'queue item 活跃的孤儿 checkpoint 被误删')
  assert.equal(fs.existsSync(path.join(dirs.checkpoints, 'cp_terminal_item_step_0.json')), false, 'queue item 终态的超龄孤儿 checkpoint 未清理')
  assert.equal(fs.existsSync(path.join(dirs.checkpoints, 'cp_free_step_0.json')), false, '无 item 的超龄孤儿 checkpoint 未清理')
  // item 本身在 TTL 内，保留
  assert.equal(fs.existsSync(path.join(dirs.queue, 'cp_terminal_item.json')), true)
  assert.equal(report.categories.checkpoints.reasons.orphan_within_ttl, 1)
  assert.equal(report.categories.checkpoints.reasons['queue_item_active:queued'], 1)
  assert.equal(report.categories.checkpoints.reasons.orphan_expired, 2)
})

test('S3-03：dry-run 零副作用——只出将删/将留清单，不落任何删除与报告', () => {
  const dirs = makeDirs()
  const sessionFile = writeSession(dirs.runtime, makeSession('s_dry', { status: 'completed' }))
  const checkpointFile = writeCheckpoint(dirs.checkpoints, 's_dry', 0)
  const itemFile = writeQueueItem(dirs.queue, 's_dry', { status: 'completed' })

  const report = runCleanup(dirs, { dryRun: true })

  // 预览到全部删除候选
  assert.equal(report.dryRun, true)
  assert.equal(report.summary.deleted, 3)
  const deleteEntries = report.entries.filter((entry) => entry.action === 'delete')
  assert.equal(deleteEntries.length, 3)
  // 零副作用：原件都在，归档目录与报告目录均未创建
  assert.equal(fs.existsSync(sessionFile), true)
  assert.equal(fs.existsSync(checkpointFile), true)
  assert.equal(fs.existsSync(itemFile), true)
  assert.equal(fs.existsSync(dirs.archive), false, 'dry-run 创建了归档目录')
  assert.equal(fs.existsSync(dirs.report), false, 'dry-run 写入了报告目录')
})

test('S3-03：重复运行幂等——第二轮零删除，归档副本不被改写', () => {
  const dirs = makeDirs()
  writeSession(dirs.runtime, makeSession('s_idem', { status: 'completed' }))
  writeCheckpoint(dirs.checkpoints, 's_idem', 0)
  writeQueueItem(dirs.queue, 's_idem', { status: 'completed' })

  const first = runCleanup(dirs)
  assert.equal(first.summary.deleted, 3)
  const archivedFile = path.join(dirs.archive, 'reasoningSessions', 'agent-runtime-sessions', 's_idem.json')
  const archivedContent = fs.readFileSync(archivedFile, 'utf8')
  const archiveListingBefore = fs.readdirSync(dirs.archive, { recursive: true }).map(String).sort()

  const second = runCleanup(dirs)
  assert.equal(second.summary.deleted, 0)
  assert.equal(second.summary.archived, 0)
  assert.equal(fs.readFileSync(archivedFile, 'utf8'), archivedContent, '归档副本被第二轮运行改写')
  const archiveListingAfter = fs.readdirSync(dirs.archive, { recursive: true }).map(String).sort()
  assert.deepEqual(archiveListingAfter, archiveListingBefore)
  // 报告可追溯：两轮各追加一行历史
  const historyLines = fs.readFileSync(path.join(dirs.report, 'history.jsonl'), 'utf8').trim().split('\n')
  assert.equal(historyLines.length, 2)
  assert.equal(JSON.parse(historyLines[1]).deleted, 0)
})

test('S3-03：未归档证据保护——归档失败时原件保留并记 error，绝不硬删', () => {
  const dirs = makeDirs()
  // 用文件占用归档根路径，使 mkdir/copy 必然失败
  fs.mkdirSync(path.dirname(dirs.archive), { recursive: true })
  fs.writeFileSync(dirs.archive, 'occupied')
  const sessionFile = writeSession(dirs.runtime, makeSession('s_noarchive', { status: 'completed' }))

  const report = runCleanup(dirs)

  assert.equal(fs.existsSync(sessionFile), true, '归档失败的原件被硬删')
  assert.equal(report.summary.deleted, 0)
  assert.equal(report.summary.errors, 1)
  assert.equal(report.categories.reasoningSessions.reasons.archive_failed_kept, 1)
  const errorEntry = report.entries.find((entry) => entry.action === 'error')
  assert.equal(errorEntry.reason, 'archive_failed_kept')
})

test('S3-03：损坏文件保护——无法解析的 session 保留并记 error，不猜测内容', () => {
  const dirs = makeDirs()
  const corruptFile = path.join(dirs.runtime, 's_corrupt.json')
  fs.writeFileSync(corruptFile, 'not-json{{{')

  const report = runCleanup(dirs)

  assert.equal(fs.existsSync(corruptFile), true, '损坏文件被误删')
  assert.equal(report.summary.deleted, 0)
  assert.equal(report.summary.errors, 1)
  assert.equal(report.categories.reasoningSessions.reasons.parse_failed_kept, 1)
})

test('S3-03：内存缓存——pruneTtlCache 按 TTL 过期与上限淘汰（插入序最旧优先）', () => {
  const nowMs = Date.now()
  const cache = new Map()
  cache.set('stale', { checkedAt: new Date(nowMs - 2 * 60 * 60 * 1000).toISOString() })
  cache.set('fresh', { checkedAt: new Date(nowMs - 1000).toISOString() })
  const ttlResult = pruneTtlCache(cache, {
    now: nowMs,
    ttlMs: 60 * 60 * 1000,
    maxEntries: 100,
    getTimestamp: (entry) => entry?.checkedAt
  })
  assert.deepEqual(ttlResult.evicted, ['stale'])
  assert.equal(cache.has('stale'), false)
  assert.equal(cache.has('fresh'), true)

  // 上限淘汰：超出后按插入顺序淘汰最旧
  cache.set('k1', { checkedAt: new Date(nowMs).toISOString() })
  cache.set('k2', { checkedAt: new Date(nowMs).toISOString() })
  cache.set('k3', { checkedAt: new Date(nowMs).toISOString() })
  const capResult = pruneTtlCache(cache, { now: nowMs, ttlMs: 0, maxEntries: 2, getTimestamp: (entry) => entry?.checkedAt })
  assert.equal(cache.size, 2)
  assert.deepEqual(capResult.evicted, ['fresh', 'k1'])
  assert.deepEqual(Array.from(cache.keys()), ['k2', 'k3'])
})

test('S3-03：内存缓存——evictOldestCacheEntries 跳过受保护 key', () => {
  const cache = new Map()
  for (const key of ['k1', 'k2', 'k3', 'k4', 'k5']) cache.set(key, 1)
  const result = evictOldestCacheEntries(cache, { maxEntries: 2, protectedKeys: new Set(['k1']) })
  assert.deepEqual(result.evicted, ['k2', 'k3', 'k4'])
  assert.deepEqual(Array.from(cache.keys()), ['k1', 'k5'])
})

test('S3-03：sessionCallCounts 上限淘汰——global 与活跃 session 预算不被重置', () => {
  reserveSessionCall('global')
  for (const sessionId of ['cache_a', 'cache_b', 'cache_c', 'cache_d']) {
    reserveSessionCall(sessionId)
  }
  const before = getSessionCallCountsSnapshot().map((entry) => entry.sessionId)
  assert.ok(before.includes('cache_a') && before.includes('cache_d'))

  const result = pruneSessionCallCounts({ maxEntries: 2, protectedSessionIds: ['cache_a'] })
  const after = getSessionCallCountsSnapshot().map((entry) => entry.sessionId)
  assert.deepEqual(after, ['global', 'cache_a'], `淘汰后应只剩 global 与受保护 session，实际: ${after.join(',')}`)
  assert.ok(result.evicted.includes('cache_b') && result.evicted.includes('cache_d'))
  // 受保护条目的预算计数保留
  const protectedEntry = getSessionCallCountsSnapshot().find((entry) => entry.sessionId === 'cache_a')
  assert.equal(protectedEntry.count, 1)
})

test('S3-03：chat history 保留策略 env 可配——超期归档 + 单文件条目上限截断', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'retention-chat-'))
  const chatDir = path.join(root, 'ai', 'chat')
  fs.mkdirSync(chatDir, { recursive: true })
  const oldFile = path.join(chatDir, '2026-06-01.json')
  fs.writeFileSync(oldFile, JSON.stringify([{ role: 'user', content: '旧消息', createdAt: daysAgoIso(60) }]), 'utf8')
  const twoDaysAgo = new Date(Date.now() - 2 * DAY_MS)
  fs.utimesSync(oldFile, twoDaysAgo, twoDaysAgo)
  const youngFile = path.join(chatDir, '2026-08-15.json')
  const entries = [1, 2, 3, 4, 5].map((index) => ({ role: index % 2 ? 'user' : 'assistant', content: `第 ${index} 条消息`, createdAt: daysAgoIso(0) }))
  fs.writeFileSync(youngFile, JSON.stringify(entries, null, 2), 'utf8')

  const savedArchiveDays = process.env.HERMES_CHAT_ARCHIVE_AFTER_DAYS
  const savedMaxEntries = process.env.HERMES_CHAT_MAX_ENTRIES_PER_FILE
  process.env.HERMES_CHAT_ARCHIVE_AFTER_DAYS = '1'
  process.env.HERMES_CHAT_MAX_ENTRIES_PER_FILE = '3'
  try {
    const report = runMemoryLifecycleMaintenance({
      fs,
      rootDir: root,
      contextPoolDir: path.join(root, 'no-context-pool'),
      chatDir,
      sessionDirs: [],
      now: new Date()
    })
    // 超期文件先归档再移除
    assert.equal(fs.existsSync(oldFile), false)
    assert.equal(fs.existsSync(path.join(root, 'state', 'memory-archive', 'chat', '2026-06-01.json')), true)
    assert.equal(report.chatHistory.archivedFiles, 1)
    // 单文件条目上限截断（保留最新 3 条）
    const limited = JSON.parse(fs.readFileSync(youngFile, 'utf8'))
    assert.equal(limited.length, 3)
    assert.equal(limited[0].content, '第 3 条消息')
    assert.equal(report.chatHistory.prunedEntries, 2)
  } finally {
    if (savedArchiveDays === undefined) delete process.env.HERMES_CHAT_ARCHIVE_AFTER_DAYS
    else process.env.HERMES_CHAT_ARCHIVE_AFTER_DAYS = savedArchiveDays
    if (savedMaxEntries === undefined) delete process.env.HERMES_CHAT_MAX_ENTRIES_PER_FILE
    else process.env.HERMES_CHAT_MAX_ENTRIES_PER_FILE = savedMaxEntries
  }
})
