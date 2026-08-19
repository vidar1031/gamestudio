// 轻量 AI 任务进度注册：让编辑器/控制面能感知长任务（锁定测试、场景渲染等）的真实阶段。
// 内存 Map 为主，按项目落盘 state/task-progress/<projectId>.json 作为重启后的兜底快照。
import { mkdir, readFile, writeFile } from 'fs/promises'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const STATE_DIR = path.resolve(__dirname, '../../../../state/task-progress')

const tasks = new Map() // taskId -> task
const persistTimers = new Map() // projectId -> timer
const MAX_AGE_MS = 6 * 60 * 60 * 1000 // 完成/失败的任务保留 6 小时

function nowIso() {
  return new Date().toISOString()
}

function asStr(v) {
  return typeof v === 'string' ? v.trim() : ''
}

export function createAiTask(projectId, kind, { total = 0, message = '' } = {}) {
  const taskId = `task_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
  const task = {
    taskId,
    projectId: asStr(projectId),
    kind: asStr(kind),
    stage: 'queued',
    current: 0,
    total: Number.isFinite(Number(total)) ? Number(total) : 0,
    message: asStr(message),
    createdAt: nowIso(),
    updatedAt: nowIso(),
    done: false,
    error: ''
  }
  tasks.set(taskId, task)
  schedulePersist(task.projectId)
  return task
}

export function updateAiTask(taskId, patch = {}) {
  const task = tasks.get(taskId)
  if (!task) return null
  if (patch.stage !== undefined) task.stage = asStr(patch.stage)
  if (patch.message !== undefined) task.message = asStr(patch.message)
  if (patch.current !== undefined && Number.isFinite(Number(patch.current))) task.current = Number(patch.current)
  if (patch.total !== undefined && Number.isFinite(Number(patch.total))) task.total = Number(patch.total)
  if (patch.done !== undefined) task.done = Boolean(patch.done)
  if (patch.error !== undefined) task.error = asStr(patch.error)
  if (patch.result !== undefined) task.result = patch.result
  task.updatedAt = nowIso()
  schedulePersist(task.projectId)
  return task
}

export function getAiTask(taskId) {
  return tasks.get(asStr(taskId)) || null
}

export function listAiTasks(projectId, { includeDone = true } = {}) {
  const pid = asStr(projectId)
  gcTasks()
  return Array.from(tasks.values())
    .filter((t) => t.projectId === pid)
    .filter((t) => includeDone || !t.done)
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
}

function gcTasks() {
  const now = Date.now()
  for (const [id, t] of tasks) {
    if (t.done && now - Date.parse(t.updatedAt) > MAX_AGE_MS) tasks.delete(id)
  }
}

function schedulePersist(projectId) {
  const pid = asStr(projectId)
  if (!pid || persistTimers.has(pid)) return
  const timer = setTimeout(() => {
    persistTimers.delete(pid)
    persistProjectTasks(pid).catch(() => {})
  }, 800)
  persistTimers.set(pid, timer)
}

async function persistProjectTasks(projectId) {
  const list = listAiTasks(projectId)
  await mkdir(STATE_DIR, { recursive: true })
  const file = path.join(STATE_DIR, `${projectId.replace(/[^a-z0-9_.-]+/gi, '_')}.json`)
  await writeFile(file, JSON.stringify({ schemaVersion: '1.0', updatedAt: nowIso(), tasks: list }, null, 2))
}

export async function loadAiTasksFromDisk(projectId) {
  try {
    const file = path.join(STATE_DIR, `${asStr(projectId).replace(/[^a-z0-9_.-]+/gi, '_')}.json`)
    const parsed = JSON.parse(await readFile(file, 'utf-8'))
    for (const t of Array.isArray(parsed?.tasks) ? parsed.tasks : []) {
      if (t && t.taskId && !tasks.has(t.taskId)) {
        // 重启后未完成的任务标记为中断，避免 UI 误以为仍在运行
        tasks.set(t.taskId, t.done ? t : { ...t, done: true, error: t.error || 'interrupted_by_restart', stage: 'interrupted' })
      }
    }
  } catch (_) { /* 无快照或解析失败均可忽略 */ }
}
