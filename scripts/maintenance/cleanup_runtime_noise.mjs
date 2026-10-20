import fs from 'node:fs'
import path from 'node:path'

const rootDir = path.resolve(process.cwd())
const dryRun = process.argv.includes('--dry-run')

const report = {
  dryRun,
  chat: { scannedFiles: 0, removedEntries: 0, archivedFiles: 0, errors: [] },
  wrongMemory: { removedFiles: 0, archivedFiles: 0, errors: [] },
  stateSessions: { scannedFiles: 0, archivedFiles: 0, errors: [] }
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'))
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), 'utf8')
}

function listFiles(dirPath, predicate = () => true) {
  if (!fs.existsSync(dirPath)) return []
  return fs.readdirSync(dirPath)
    .filter(predicate)
    .map((name) => path.join(dirPath, name))
}

function archiveFile(sourcePath, archiveRoot) {
  const relativePath = path.relative(rootDir, sourcePath)
  const targetPath = path.join(archiveRoot, relativePath)
  if (!dryRun) {
    fs.mkdirSync(path.dirname(targetPath), { recursive: true })
    fs.copyFileSync(sourcePath, targetPath)
  }
  return targetPath
}

function isLowValueChatEntry(entry) {
  if (!entry || typeof entry !== 'object') return true
  const role = String(entry.role || '').trim().toLowerCase()
  const content = String(entry.content || '').trim()
  if (!role || !content) return true
  return /hermes_gateway_omlx_fault|omlx_api_failed_after_retries|API failed after \d+ retries/i.test(content)
    || /search_workspace_text_missing_query|Cannot free enough memory|model_task_timeout|chat_timeout/i.test(content)
    || /当前没有足够的可观测结构化结果可直接回答/i.test(content)
    || /docs\/CONTROL_HERMES_OMLX_STORY_PRODUCTION_PLAN\.md/i.test(content)
    || /docs\/AGENT_WORKFLOW_HARDENING_GUIDE\.md/i.test(content)
    || (/^```json\s*\{[\s\S]*"steps"\s*:/i.test(content) && content.length > 1200)
}

function cleanChatHistory() {
  const chatDir = path.join(rootDir, 'ai', 'chat')
  const archiveRoot = path.join(rootDir, 'state', 'memory-archive', 'chat-noise')
  for (const filePath of listFiles(chatDir, (name) => name.endsWith('.json'))) {
    report.chat.scannedFiles += 1
    try {
      const entries = readJson(filePath)
      if (!Array.isArray(entries)) continue
      const removed = entries.filter(isLowValueChatEntry)
      const kept = entries.filter((entry) => !isLowValueChatEntry(entry))
      if (removed.length === 0) continue
      const dateName = path.basename(filePath)
      const archivePath = path.join(archiveRoot, dateName)
      if (!dryRun) writeJson(archivePath, removed)
      if (!dryRun) writeJson(filePath, kept)
      report.chat.removedEntries += removed.length
      report.chat.archivedFiles += 1
    } catch (error) {
      report.chat.errors.push(`${path.relative(rootDir, filePath)}:${error instanceof Error ? error.message : String(error)}`)
    }
  }
}

function cleanWrongMemory() {
  const candidates = [path.join(rootDir, 'memory', '2026-05-06.md')]
  const archiveRoot = path.join(rootDir, 'state', 'memory-archive', 'wrong-memory')
  for (const filePath of candidates) {
    if (!fs.existsSync(filePath)) continue
    try {
      const raw = fs.readFileSync(filePath, 'utf8')
      const isWrong = /项目中不存在 `apps\/server` 目录/.test(raw)
        && /项目中不存在 `storage\/projects` 目录/.test(raw)
      if (!isWrong) continue
      archiveFile(filePath, archiveRoot)
      if (!dryRun) fs.unlinkSync(filePath)
      report.wrongMemory.removedFiles += 1
      report.wrongMemory.archivedFiles += 1
    } catch (error) {
      report.wrongMemory.errors.push(`${path.relative(rootDir, filePath)}:${error instanceof Error ? error.message : String(error)}`)
    }
  }
}

function isLowValueSession(session) {
  if (!session || typeof session !== 'object') return false
  const status = String(session.status || '').trim()
  const context = session.submissionContext && typeof session.submissionContext === 'object' ? session.submissionContext : {}
  const finalAnswer = String(session.artifacts?.finalAnswer || '').trim()
  const lastResult = JSON.stringify(session.artifacts?.storyProduction?.lastResult || {})
  const isTerminalFailure = status === 'failed' || status === 'cancelled'
  const isProductionTest = Boolean(context.productionTest || context.stageId || context.caseId)
  const hasLowValueAnswer = /当前没有足够的可观测结构化结果可直接回答|hermes_gateway_omlx_fault|omlx_api_failed_after_retries|search_workspace_text_missing_query/i.test(finalAnswer)
  const hasNoArtifactEvidence = !session.artifacts?.storyProduction && !session.artifacts?.talksceneBootstrap && !session.artifacts?.finalAnswer
  const isFailedStoryBoundary = /missing_project_id|image_provider_not_ready|model_task_timeout/i.test(lastResult) && !session.artifacts?.storyProduction?.currentProjectId
  return isProductionTest && (isTerminalFailure || hasLowValueAnswer || hasNoArtifactEvidence || isFailedStoryBoundary)
}

function cleanStateSessions() {
  const archiveRoot = path.join(rootDir, 'state', 'memory-archive', 'runtime-noise')
  const sessionDirs = [
    path.join(rootDir, 'state', 'agent-runtime-sessions'),
    path.join(rootDir, 'state', 'reasoning-sessions')
  ]
  for (const sessionDir of sessionDirs) {
    for (const filePath of listFiles(sessionDir, (name) => name.endsWith('.json'))) {
      report.stateSessions.scannedFiles += 1
      try {
        const session = readJson(filePath)
        if (!isLowValueSession(session)) continue
        archiveFile(filePath, archiveRoot)
        if (!dryRun) fs.unlinkSync(filePath)
        report.stateSessions.archivedFiles += 1
      } catch (error) {
        report.stateSessions.errors.push(`${path.relative(rootDir, filePath)}:${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }
}

cleanChatHistory()
cleanWrongMemory()
cleanStateSessions()

console.log(JSON.stringify(report, null, 2))