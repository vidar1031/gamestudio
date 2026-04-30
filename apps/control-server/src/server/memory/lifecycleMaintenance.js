import path from 'node:path'

import {
  createMemoryLifecycleMetadata,
  evaluateMemoryLifecycle,
  MEMORY_LIFECYCLE_STATES,
  MEMORY_RECORD_KINDS,
} from './lifecyclePolicy.js'

const DAY_MS = 24 * 60 * 60 * 1000
const MAX_CHAT_ENTRIES_PER_FILE = 120

export function normalizeMemoryLifecycleRecord(record, defaults = {}) {
  const now = new Date().toISOString()
  const existing = record && typeof record === 'object' ? record : {}
  if (existing.lifecycle && typeof existing.lifecycle === 'object') {
    return existing
  }
  return {
    ...existing,
    lifecycle: createMemoryLifecycleMetadata({
      kind: defaults.kind,
      state: defaults.state,
      importance: defaults.importance,
      confidence: defaults.confidence,
      createdAt: existing.createdAt || now,
      updatedAt: existing.updatedAt || now,
      wakePatterns: defaults.wakePatterns || [],
      relatedFiles: defaults.relatedFiles || [],
      relatedCaseIds: defaults.relatedCaseIds || [],
      relatedSessionIds: defaults.relatedSessionIds || []
    })
  }
}

export function runMemoryLifecycleMaintenance({ fs, rootDir, contextPoolDir, chatDir, sessionDir, now = new Date() }) {
  const report = {
    ranAt: now.toISOString(),
    contextPool: maintainContextPool({ fs, contextPoolDir, now }),
    chatHistory: maintainChatHistory({ fs, chatDir, rootDir, now }),
    reasoningSessions: indexReasoningSessions({ fs, rootDir, sessionDir, now })
  }
  writeMaintenanceReport({ fs, rootDir, report })
  return report
}

function maintainContextPool({ fs, contextPoolDir, now }) {
  const result = { scanned: 0, normalized: 0, sleeping: 0, archived: 0, deleted: 0, kept: 0, errors: [] }
  if (!contextPoolDir || !fs.existsSync(contextPoolDir)) return result

  for (const name of fs.readdirSync(contextPoolDir).filter((item) => item.endsWith('.json'))) {
    const filePath = path.join(contextPoolDir, name)
    result.scanned += 1
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'))
      const normalized = normalizeMemoryLifecycleRecord(parsed, {
        kind: MEMORY_RECORD_KINDS.CONTEXT_POOL,
        state: MEMORY_LIFECYCLE_STATES.SLEEPING,
        importance: 30,
        confidence: 60
      })
      const next = evaluateMemoryLifecycle(normalized, now)
      const nextEntry = {
        ...normalized,
        lifecycle: {
          ...normalized.lifecycle,
          state: next.state,
          updatedAt: normalized.lifecycle.updatedAt || normalized.updatedAt || normalized.createdAt || now.toISOString(),
          lifecycleReason: next.reason
        }
      }
      if (!parsed.lifecycle) result.normalized += 1
      if (next.state === MEMORY_LIFECYCLE_STATES.SLEEPING) result.sleeping += 1
      else if (next.state === MEMORY_LIFECYCLE_STATES.ARCHIVED) result.archived += 1
      else if (next.state === MEMORY_LIFECYCLE_STATES.DELETED) result.deleted += 1
      else result.kept += 1

      if (JSON.stringify(parsed) !== JSON.stringify(nextEntry)) {
        fs.writeFileSync(filePath, JSON.stringify(nextEntry, null, 2), 'utf8')
      }
    } catch (error) {
      result.errors.push(`${name}:${error instanceof Error ? error.message : String(error)}`)
    }
  }

  return result
}

function maintainChatHistory({ fs, chatDir, rootDir, now }) {
  const result = { scanned: 0, prunedEntries: 0, archivedFiles: 0, keptFiles: 0, errors: [] }
  if (!chatDir || !fs.existsSync(chatDir)) return result

  const archiveDir = path.join(rootDir, 'state', 'memory-archive', 'chat')
  for (const name of fs.readdirSync(chatDir).filter((item) => item.endsWith('.json'))) {
    const filePath = path.join(chatDir, name)
    result.scanned += 1
    try {
      const ageDays = getFileAgeDays(fs, filePath, now)
      if (ageDays >= 30) {
        fs.mkdirSync(archiveDir, { recursive: true })
        const targetPath = path.join(archiveDir, name)
        if (!fs.existsSync(targetPath)) fs.copyFileSync(filePath, targetPath)
        fs.unlinkSync(filePath)
        result.archivedFiles += 1
        continue
      }

      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'))
      const entries = Array.isArray(parsed) ? parsed : []
      const compacted = compactChatEntries(entries)
      const limited = compacted.length > MAX_CHAT_ENTRIES_PER_FILE
        ? compacted.slice(-MAX_CHAT_ENTRIES_PER_FILE)
        : compacted
      result.prunedEntries += Math.max(0, entries.length - limited.length)
      result.keptFiles += 1
      if (limited.length !== entries.length || JSON.stringify(limited) !== JSON.stringify(entries)) {
        fs.writeFileSync(filePath, JSON.stringify(limited, null, 2), 'utf8')
      }
    } catch (error) {
      result.errors.push(`${name}:${error instanceof Error ? error.message : String(error)}`)
    }
  }
  return result
}

function indexReasoningSessions({ fs, rootDir, sessionDir, now }) {
  const result = { scanned: 0, indexed: 0, sleeping: 0, archived: 0, errors: [] }
  if (!sessionDir || !fs.existsSync(sessionDir)) return result
  const index = []

  for (const name of fs.readdirSync(sessionDir).filter((item) => item.endsWith('.json'))) {
    const filePath = path.join(sessionDir, name)
    result.scanned += 1
    try {
      const session = JSON.parse(fs.readFileSync(filePath, 'utf8'))
      const lifecycleRecord = normalizeMemoryLifecycleRecord({
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
        lifecycle: session.lifecycle,
      }, {
        kind: MEMORY_RECORD_KINDS.REASONING_SESSION,
        state: MEMORY_LIFECYCLE_STATES.EPHEMERAL,
        importance: session.status === 'completed' ? 50 : 30,
        confidence: session.status === 'completed' ? 70 : 40,
        relatedCaseIds: [session.submissionContext?.caseId].filter(Boolean),
        relatedSessionIds: [session.sessionId].filter(Boolean)
      })
      const next = evaluateMemoryLifecycle(lifecycleRecord, now)
      if (next.state === MEMORY_LIFECYCLE_STATES.SLEEPING) result.sleeping += 1
      if (next.state === MEMORY_LIFECYCLE_STATES.ARCHIVED) result.archived += 1
      index.push({
        sessionId: session.sessionId,
        status: session.status,
        userPrompt: session.userPrompt,
        caseId: session.submissionContext?.caseId || null,
        stageId: session.submissionContext?.stageId || null,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
        lifecycleState: next.state,
        lifecycleReason: next.reason,
        finalAnswerChars: String(session.artifacts?.finalAnswer || '').length,
        filePath
      })
      result.indexed += 1
    } catch (error) {
      result.errors.push(`${name}:${error instanceof Error ? error.message : String(error)}`)
    }
  }

  const targetDir = path.join(rootDir, 'state', 'memory-lifecycle')
  fs.mkdirSync(targetDir, { recursive: true })
  fs.writeFileSync(path.join(targetDir, 'reasoning-session-index.json'), JSON.stringify({ updatedAt: now.toISOString(), sessions: index }, null, 2), 'utf8')
  return result
}

function writeMaintenanceReport({ fs, rootDir, report }) {
  const targetDir = path.join(rootDir, 'state', 'memory-lifecycle')
  fs.mkdirSync(targetDir, { recursive: true })
  fs.writeFileSync(path.join(targetDir, 'latest-report.json'), JSON.stringify(report, null, 2), 'utf8')
}

function compactChatEntries(entries) {
  const result = []
  const seen = new Set()
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (!entry || typeof entry !== 'object') continue
    const role = String(entry.role || '').trim().toLowerCase()
    const content = String(entry.content || '').trim()
    if (!role || !content) continue
    if (isLowValueChatEntry(role, content)) continue
    const key = `${role}:${content.replace(/\s+/g, ' ').slice(0, 600)}`
    if (seen.has(key)) continue
    seen.add(key)
    result.push(entry)
  }
  return result
}

function isLowValueChatEntry(role, content) {
  if (role === 'error' && /chat_timeout|HTTP 507|Cannot free enough memory|model_task_timeout/i.test(content)) return true
  return /根据对话开始时的元数据信息/i.test(content)
    || /根据当前运行时元数据/i.test(content)
    || /^#\s*我是谁/m.test(content)
    || /API call failed after \d+ retries/i.test(content)
}

function getFileAgeDays(fs, filePath, now) {
  const stat = fs.statSync(filePath)
  return Math.max(0, (now.getTime() - stat.mtimeMs) / DAY_MS)
}