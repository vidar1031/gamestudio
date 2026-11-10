import { AsyncLocalStorage } from 'node:async_hooks'

const taskContext = new AsyncLocalStorage()
const controllers = new Map()
const parentTaskIds = new Map()

function cleanId(value) {
  return String(value || '').trim()
}

export function createTaskCancelError() {
  const error = new Error('task_cancelled_by_user')
  error.name = 'AbortError'
  error.code = 'AI_TASK_CANCELLED'
  return error
}

export function activateAiTask(taskId) {
  const id = cleanId(taskId)
  if (!id) return
  const previous = taskContext.getStore()
  const parentTaskId = previous?.taskIds?.[previous.taskIds.length - 1] || ''
  const taskIds = [...new Set([...(previous?.taskIds || []), id])]
  const context = previous || { taskIds: [] }
  context.taskIds = taskIds
  if (!controllers.has(id)) controllers.set(id, new AbortController())
  if (parentTaskId && !parentTaskIds.has(id)) parentTaskIds.set(id, parentTaskId)
  taskContext.enterWith(context)
}

export function currentAiTaskIds() {
  return taskContext.getStore()?.taskIds || []
}

export function isAiTaskCancellation(error) {
  return error?.code === 'AI_TASK_CANCELLED' || error?.message === 'task_cancelled_by_user'
}

export function throwIfAiTaskCancelled(taskId) {
  const ids = taskId ? [cleanId(taskId)] : currentAiTaskIds()
  if (ids.some((id) => controllers.get(id)?.signal.aborted)) throw createTaskCancelError()
}

export function linkAiTaskAbort(controller, taskId) {
  const ids = taskId ? [cleanId(taskId)] : currentAiTaskIds()
  const signals = ids.map((id) => controllers.get(id)?.signal).filter(Boolean)
  const abort = (signal) => {
    if (!controller.signal.aborted) controller.abort(signal.reason || createTaskCancelError())
  }
  for (const signal of signals) {
    if (signal.aborted) abort(signal)
    else signal.addEventListener('abort', () => abort(signal), { once: true })
  }
  throwIfAiTaskCancelled(taskId)
}

export function onAiTaskCancel(handler) {
  const registrations = currentAiTaskIds().map((id) => {
    const controller = controllers.get(id)
    if (!controller) return null
    if (controller.signal.aborted) {
      handler()
      return null
    }
    const wrapped = () => handler()
    controller.signal.addEventListener('abort', wrapped, { once: true })
    return { controller, wrapped }
  }).filter(Boolean)
  return () => {
    for (const { controller, wrapped } of registrations) controller.signal.removeEventListener('abort', wrapped)
  }
}

export function cancelAiTaskExecution(taskId) {
  const id = cleanId(taskId)
  const cancelled = []
  const controller = controllers.get(id)
  if (controller && !controller.signal.aborted) {
    controller.abort(createTaskCancelError())
    cancelled.push(id)
  }
  for (const [childId, parentId] of parentTaskIds) {
    if (parentId === id) cancelled.push(...cancelAiTaskExecution(childId))
  }
  return cancelled
}

export function finishAiTaskExecution(taskId) {
  const id = cleanId(taskId)
  controllers.delete(id)
  parentTaskIds.delete(id)
}
