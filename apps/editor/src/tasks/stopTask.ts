import { cancelAiTaskById, listAllAiTasks } from '../api'

export const TASK_STOP_EVENT = 'talkscene.stopTask'

export type TaskStopDetail = { taskId?: string; projectId?: string }

export function notifyTaskStop(detail: TaskStopDetail) {
  window.dispatchEvent(new CustomEvent<TaskStopDetail>(TASK_STOP_EVENT, { detail }))
}

export async function stopAiTask(taskId: string, projectId = '') {
  notifyTaskStop({ taskId, projectId })
  return cancelAiTaskById(taskId)
}

export async function stopActiveAiTasks(projectId: string) {
  const tasks = await listAllAiTasks(false)
  const active = tasks.filter((task) => !projectId || task.projectId === projectId)
  notifyTaskStop({ projectId })
  await Promise.all(active.map((task) => cancelAiTaskById(task.taskId).catch(() => false)))
}

export function onTaskStop(listener: (detail: TaskStopDetail) => void) {
  const handler = (event: Event) => listener((event as CustomEvent<TaskStopDetail>).detail || {})
  window.addEventListener(TASK_STOP_EVENT, handler)
  return () => window.removeEventListener(TASK_STOP_EVENT, handler)
}
