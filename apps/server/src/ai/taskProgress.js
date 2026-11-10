// 轻量 AI 任务进度注册：让编辑器/控制面能感知长任务（锁定测试、场景渲染等）的真实阶段。
// 内存 Map 为主，按项目落盘 state/task-progress/<projectId>.json 作为重启后的兜底快照。
import { mkdir, readFile, readdir, writeFile } from 'fs/promises'
import path from 'path'
import { fileURLToPath } from 'url'
import { controlBaseUrl, controlClientHeaders, hasControlClientKey } from './resourceLease.js'
import { publishProjectEvent } from './projectEventBus.js'
import { activateAiTask, cancelAiTaskExecution, finishAiTaskExecution, throwIfAiTaskCancelled } from './taskCancellation.js'

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

// O 波（2026-10-27 双向任务流补齐）：aiTask 生命周期旁路上报守护台 POST /api/control/events/ingest。
// 定位是旁路不是主链：守护台离线/未配置凭证静默跳过，失败 console.warn 一次/任务，不重试不阻塞本地任务。
// 节流口径：created/done/failed 必报；running 仅 stage 或 message 变化时上报，且每任务每秒至多 1 条。
const reportState = new Map() // taskId -> { stage, message, lastAt, final, warned }

function reportTaskLifecycle(task, kind) {
  const tid = asStr(task && task.taskId)
  if (!tid || !hasControlClientKey()) return
  const now = Date.now()
  let st = reportState.get(tid)
  if (!st) {
    st = { stage: '', message: '', lastAt: 0, final: '', warned: false }
    reportState.set(tid, st)
  }
  if (st.final) return // 终态已报，后续补丁（如 done 后再改 stage）不重复上报
  const isFinal = kind === 'task_done' || kind === 'task_failed'
  if (kind === 'task_progress') {
    if (st.stage === task.stage && st.message === task.message) return
    if (now - st.lastAt < 1000) return // lastAt 只记 progress 上报时刻，created/终态不占用节流窗
  }
  st.stage = asStr(task.stage)
  st.message = asStr(task.message)
  if (kind === 'task_progress') st.lastAt = now
  if (isFinal) st.final = kind
  const parts = [`stage=${st.stage || '-'}`]
  if (Number(task.total) > 0) parts.push(`${Number(task.current) || 0}/${Number(task.total)}`)
  if (st.message) parts.push(st.message.slice(0, 120))
  if (kind === 'task_failed' && task.error) parts.push(`error=${asStr(task.error).slice(0, 160)}`)
  const body = {
    kind,
    taskId: tid,
    title: `${asStr(task.kind) || 'task'}（${asStr(task.projectId) || 'unknown'}）`,
    detail: parts.join(' · ')
  }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 3000)
  fetch(`${controlBaseUrl()}/api/control/events/ingest`, {
    method: 'POST',
    headers: controlClientHeaders(),
    body: JSON.stringify(body),
    signal: controller.signal
  }).catch(() => {
    if (!st.warned) {
      st.warned = true
      console.warn(`[taskProgress] 守护台任务上报失败（不重试不阻塞，本任务后续失败不再重复告警）：${tid}`)
    }
  }).finally(() => clearTimeout(timer))
}

function dropReportState(taskId) {
  reportState.delete(asStr(taskId))
}

export function createAiTask(projectId, kind, { total = 0, message = '', sceneId = '', assetId = '' } = {}) {
  const taskId = `task_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
  const task = {
    taskId,
    projectId: asStr(projectId),
    sceneId: asStr(sceneId),
    // 2026-11-10：可选资产维度——参考图抽卡等按事物匹配任务（UI 状态提示 + 同资产并发护栏）
    assetId: asStr(assetId),
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
  activateAiTask(taskId)
  schedulePersist(task.projectId)
  // SSE 信号：任务台账变更，订阅的编辑器面板据此重拉 /ai/tasks
  publishProjectEvent(task.projectId, { type: 'tasks', at: nowIso() })
  reportTaskLifecycle(task, 'task_started')
  return task
}

export function updateAiTask(taskId, patch = {}) {
  const task = tasks.get(taskId)
  if (!task) return null
  if (task.done && task.stage === 'cancelled') return task
  if (patch.stage !== 'cancelled') throwIfAiTaskCancelled(task.taskId)
  if (patch.stage !== undefined) task.stage = asStr(patch.stage)
  if (patch.message !== undefined) task.message = asStr(patch.message)
  if (patch.current !== undefined && Number.isFinite(Number(patch.current))) task.current = Number(patch.current)
  if (patch.total !== undefined && Number.isFinite(Number(patch.total))) task.total = Number(patch.total)
  if (patch.done !== undefined) task.done = Boolean(patch.done)
  if (patch.error !== undefined) task.error = asStr(patch.error)
  if (patch.result !== undefined) task.result = patch.result
  task.updatedAt = nowIso()
  schedulePersist(task.projectId)
  // SSE 信号：台账变更必推 tasks；终态（完成/失败）会写回出图结果，连带刷新出图总账
  publishProjectEvent(task.projectId, { type: 'tasks', at: nowIso() })
  if (task.done || task.stage === 'failed') {
    publishProjectEvent(task.projectId, { type: 'coverage', at: nowIso() })
  }
  // 生命周期上报映射：done:true 或 stage='failed' 视终态（失败看 error/stage）；否则 stage/message 变化报 progress
  if (task.done || task.stage === 'failed') {
    reportTaskLifecycle(task, task.stage !== 'cancelled' && (task.error || task.stage === 'failed') ? 'task_failed' : 'task_done')
  } else if (patch.stage !== undefined || patch.message !== undefined) {
    reportTaskLifecycle(task, 'task_progress')
  }
  if (task.done) finishAiTaskExecution(task.taskId)
  return task
}

export function cancelAiTask(taskId, projectId = '') {
  const task = getAiTask(taskId)
  if (!task || (asStr(projectId) && task.projectId !== asStr(projectId))) return { ok: false, code: 'not_found' }
  if (task.done) return { ok: false, code: 'task_already_done', task }
  const cancelledIds = cancelAiTaskExecution(task.taskId)
  for (const id of [task.taskId, ...cancelledIds]) {
    const current = getAiTask(id)
    if (current && !current.done) updateAiTask(id, { done: true, stage: 'cancelled', error: 'task_cancelled_by_user', message: '已由用户停止；已完成内容保留' })
  }
  return { ok: true, task }
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

// 2026-10-20 全局任务台账：跨项目聚合（用户指令——talkscene 独立运行时任何任务都要有界面进度提示，不经守护台）。
export function listAllAiTasks({ includeDone = true } = {}) {
  gcTasks()
  return Array.from(tasks.values())
    .filter((t) => includeDone || !t.done)
    .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
}

export async function loadAllAiTasksFromDisk() {
  try {
    const files = await readdir(STATE_DIR).catch(() => [])
    for (const f of files) {
      if (!f.endsWith('.json')) continue
      try {
        const parsed = JSON.parse(await readFile(path.join(STATE_DIR, f), 'utf-8'))
        for (const t of Array.isArray(parsed?.tasks) ? parsed.tasks : []) {
          if (t && t.taskId && !tasks.has(t.taskId)) {
            tasks.set(t.taskId, t.done ? t : { ...t, done: true, error: t.error || 'interrupted_by_restart', stage: 'interrupted' })
          }
        }
      } catch (_) { /* 单个快照损坏可忽略 */ }
    }
  } catch (_) { /* 无目录可忽略 */ }
}

// 任务管理（2026-10-25 用户指令：任务可删除/可清理已结束，不许堆着删不掉）：
// 纪律——只有已结束（done）的任务可删；进行中的任务禁止删除（409），防误删在跑任务。
// 删除必须立即落盘（实测缺陷：防抖延迟+快照回填会让已删任务复活），不走 schedulePersist。
export async function deleteAiTask(taskId) {
  const t = tasks.get(asStr(taskId))
  if (!t) return { ok: false, code: 'not_found' }
  if (!t.done) return { ok: false, code: 'task_running' }
  tasks.delete(t.taskId)
  dropReportState(t.taskId)
  publishProjectEvent(t.projectId, { type: 'tasks', at: nowIso() })
  if (t.projectId) await persistProjectTasks(t.projectId).catch(() => {})
  return { ok: true }
}

export async function clearFinishedAiTasks() {
  let removed = 0
  const affectedProjects = new Set()
  for (const [id, t] of tasks) {
    if (t.done) {
      tasks.delete(id)
      dropReportState(id)
      removed += 1
      if (t.projectId) affectedProjects.add(t.projectId)
    }
  }
  for (const pid of affectedProjects) {
    publishProjectEvent(pid, { type: 'tasks', at: nowIso() })
    await persistProjectTasks(pid).catch(() => {})
  }
  return removed
}

function gcTasks() {
  const now = Date.now()
  for (const [id, t] of tasks) {
    if (t.done && now - Date.parse(t.updatedAt) > MAX_AGE_MS) {
      tasks.delete(id)
      dropReportState(id)
    }
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
