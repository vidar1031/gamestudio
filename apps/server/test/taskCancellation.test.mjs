import assert from 'node:assert/strict'
import { test } from 'node:test'
import http from 'node:http'
import { once } from 'node:events'
import { rm } from 'node:fs/promises'
import { activateAiTask, cancelAiTaskExecution, currentAiTaskIds, finishAiTaskExecution, linkAiTaskAbort, throwIfAiTaskCancelled } from '../src/ai/taskCancellation.js'
import { createAiTask, cancelAiTask, getAiTask, updateAiTask } from '../src/ai/taskProgress.js'
import { runComfyuiPromptWorkflow } from '../src/ai/background.js'

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

test('取消父任务会级联子任务，且终态不被后续进度覆盖', async () => {
  const projectId = `test_cancel_${process.pid}`
  const parent = createAiTask(projectId, 'test.parent')
  const child = createAiTask(projectId, 'test.child')
  assert.deepEqual(currentAiTaskIds(), [parent.taskId, child.taskId])
  const result = cancelAiTask(parent.taskId, projectId)
  assert.equal(result.ok, true)
  assert.equal(getAiTask(parent.taskId).stage, 'cancelled')
  assert.equal(getAiTask(child.taskId).stage, 'cancelled')
  assert.equal(getAiTask(parent.taskId).done, true)
  updateAiTask(parent.taskId, { done: true, stage: 'done', message: 'late success' })
  assert.equal(getAiTask(parent.taskId).stage, 'cancelled')
  assert.equal(cancelAiTask(parent.taskId, projectId).code, 'task_already_done')
  await wait(900)
  await rm(new URL(`../../../state/task-progress/${projectId}.json`, import.meta.url), { force: true })
})

test('取消信号会中止进行中的请求', async () => {
  const id = `test_signal_${process.pid}`
  activateAiTask(id)
  const controller = new AbortController()
  linkAiTaskAbort(controller)
  cancelAiTaskExecution(id)
  assert.equal(controller.signal.aborted, true)
  assert.throws(() => throwIfAiTaskCancelled(), { code: 'AI_TASK_CANCELLED' })
  finishAiTaskExecution(id)
})

test('ComfyUI 停止会删除本任务排队项并请求中断', async () => {
  const oldLease = process.env.STUDIO_RESOURCE_LEASE_ENABLED
  process.env.STUDIO_RESOURCE_LEASE_ENABLED = '0'
  const calls = []
  let polling
  const pollingPromise = new Promise((resolve) => { polling = resolve })
  const server = http.createServer(async (req, res) => {
    calls.push(`${req.method} ${req.url}`)
    if (req.method === 'POST' && req.url === '/prompt') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ prompt_id: 'mock-prompt-id' }))
      return
    }
    if (req.method === 'POST' && (req.url === '/queue' || req.url === '/interrupt')) {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end('{}')
      return
    }
    if (req.method === 'GET' && req.url === '/history/mock-prompt-id') {
      polling()
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end('{}')
      return
    }
    res.writeHead(404).end()
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const id = `test_comfy_${process.pid}`
  try {
    activateAiTask(id)
    const baseUrl = `http://127.0.0.1:${server.address().port}`
    const running = runComfyuiPromptWorkflow({ workflow: { 1: { class_type: 'Mock', inputs: {} } }, comfyuiBaseUrl: baseUrl, timeoutMs: 10_000 })
    await pollingPromise
    cancelAiTaskExecution(id)
    await assert.rejects(running, { code: 'AI_TASK_CANCELLED' })
    await wait(50)
    assert.ok(calls.includes('POST /queue'))
    assert.ok(calls.includes('POST /interrupt'))
  } finally {
    finishAiTaskExecution(id)
    server.close()
    await once(server, 'close')
    if (oldLease === undefined) delete process.env.STUDIO_RESOURCE_LEASE_ENABLED
    else process.env.STUDIO_RESOURCE_LEASE_ENABLED = oldLease
  }
})
