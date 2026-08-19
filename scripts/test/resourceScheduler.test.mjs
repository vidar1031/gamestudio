import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { Hono } from 'hono'
import {
  RESOURCE_SLOT_STATE,
  RESOURCE_KIND,
  createResourceScheduler,
  resolveActionResourceKind,
  isResourceSchedulerEnabled
} from '../../apps/control-server/src/server/reasoning/resourceScheduler.js'
import { registerResourceRoutes } from '../../apps/control-server/src/server/routes/resourceRoutes.js'
import {
  REASONING_QUEUE_ITEM_STATE,
  createReasoningQueueWorker,
  enqueueQueueItem,
  readQueueItem
} from '../../apps/control-server/src/server/reasoning/persistentQueue.js'

// AUTO-R01 测试：本地重负载资源互斥调度器。
// 隔离：state/events 文件指向临时目录；OMLX 全部走可编程 fake client；settle/超时用毫秒级真实时间。

const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'resource-scheduler-'))

const CONFIGURED_MODEL = 'Qwen3.6-27B-MLX-4bit'

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitFor(condition, timeoutMs = 3000) {
  const startedAt = Date.now()
  while (!condition()) {
    if (Date.now() - startedAt > timeoutMs) throw new Error('wait_for_timeout')
    await sleep(10)
  }
}

// 可编程 fake OMLX client：模型加载表 + 失败注入 + 调用记录
function createFakeOmlxClient({ models = {}, reachable = true } = {}) {
  const state = {
    reachable,
    models: new Map(Object.entries(models).map(([id, m]) => [id, { id, loaded: Boolean(m.loaded), isLoading: Boolean(m.isLoading) }])),
    failNextUnload: 0,
    failNextLoad: 0,
    unloadCalls: [],
    loadCalls: []
  }
  return {
    state,
    async getHealth() {
      if (!state.reachable) return { ok: false, reachable: false, loadedCount: null, currentModelMemory: null, finalCeiling: null, detail: 'connection_refused' }
      const loadedCount = [...state.models.values()].filter((m) => m.loaded || m.isLoading).length
      return { ok: true, reachable: true, loadedCount, currentModelMemory: loadedCount ? 16220220672 : 0, finalCeiling: 26800603136 }
    },
    async getModelStatus() {
      if (!state.reachable) return { ok: false, reachable: false, models: [], detail: 'connection_refused' }
      return { ok: true, reachable: true, models: [...state.models.values()].map((m) => ({ id: m.id, loaded: m.loaded, isLoading: m.isLoading })) }
    },
    async loadModel(id) {
      state.loadCalls.push(id)
      if (state.failNextLoad > 0) {
        state.failNextLoad -= 1
        return { ok: false, detail: 'load_http_500' }
      }
      const entry = state.models.get(id) || { id, loaded: false, isLoading: false }
      entry.loaded = true
      entry.isLoading = false
      state.models.set(id, entry)
      return { ok: true }
    },
    async unloadModel(id) {
      state.unloadCalls.push(id)
      if (state.failNextUnload > 0) {
        state.failNextUnload -= 1
        return { ok: false, detail: 'unload_http_500' }
      }
      const entry = state.models.get(id)
      if (entry) {
        entry.loaded = false
        entry.isLoading = false
      }
      return { ok: true }
    }
  }
}

let caseSeq = 0
// 测试用 sleep：必须是真实（极短）宏任务定时器——若注入已 resolve 的 Promise，
// 等待循环会持续产生微任务、饿死事件循环（真实 setTimeout 永远排不上），测试挂死
const testSleepFn = (ms) => new Promise((resolve) => setTimeout(resolve, Math.min(Number(ms) || 0, 2)))

function createTestScheduler(client, options = {}) {
  caseSeq += 1
  const dir = path.join(TMP_ROOT, `case-${caseSeq}`)
  fs.mkdirSync(dir, { recursive: true })
  const scheduler = createResourceScheduler({
    omlxClient: client,
    resolveConfiguredModel: () => ({ model: CONFIGURED_MODEL, provider: 'omlx', baseUrl: 'http://127.0.0.1:18888/v1' }),
    stateFile: path.join(dir, 'state.json'),
    eventsFile: path.join(dir, 'events.jsonl'),
    loadTimeoutMs: 400,
    unloadTimeoutMs: 400,
    gpuSettleMs: 40,
    waitPollMs: 5,
    sleepFn: testSleepFn,
    ...options
  })
  return { scheduler, dir }
}

function readEvents(dir) {
  const file = path.join(dir, 'events.jsonl')
  if (!fs.existsSync(file)) return []
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line))
}

test('资源分类：出图类 action 归 gpu，其余默认 llm', () => {
  assert.equal(resolveActionResourceKind('story_generate_lock_asset_references'), RESOURCE_KIND.GPU)
  assert.equal(resolveActionResourceKind('story_render_scene'), RESOURCE_KIND.GPU)
  assert.equal(resolveActionResourceKind('story_render_scene_backgrounds'), RESOURCE_KIND.GPU)
  assert.equal(resolveActionResourceKind('story_lock_test'), RESOURCE_KIND.GPU)
  assert.equal(resolveActionResourceKind('story_generate_asset_candidate'), RESOURCE_KIND.GPU)
  assert.equal(resolveActionResourceKind('story_create_bible'), RESOURCE_KIND.LLM)
  assert.equal(resolveActionResourceKind('story_validate_project'), RESOURCE_KIND.LLM)
  assert.equal(resolveActionResourceKind('generate_default_answer'), RESOURCE_KIND.LLM)
  assert.equal(resolveActionResourceKind(''), RESOURCE_KIND.LLM)
})

test('开关：HERMES_RESOURCE_SCHEDULER_ENABLED 默认开，false/0/off 关闭', () => {
  const saved = process.env.HERMES_RESOURCE_SCHEDULER_ENABLED
  try {
    delete process.env.HERMES_RESOURCE_SCHEDULER_ENABLED
    assert.equal(isResourceSchedulerEnabled(), true)
    process.env.HERMES_RESOURCE_SCHEDULER_ENABLED = 'false'
    assert.equal(isResourceSchedulerEnabled(), false)
    process.env.HERMES_RESOURCE_SCHEDULER_ENABLED = '0'
    assert.equal(isResourceSchedulerEnabled(), false)
    process.env.HERMES_RESOURCE_SCHEDULER_ENABLED = 'true'
    assert.equal(isResourceSchedulerEnabled(), true)
  } finally {
    if (saved === undefined) delete process.env.HERMES_RESOURCE_SCHEDULER_ENABLED
    else process.env.HERMES_RESOURCE_SCHEDULER_ENABLED = saved
  }
})

test('llm 准入：idle 状态触发配置模型加载并转 llm，事件落盘', async () => {
  const client = createFakeOmlxClient()
  const { scheduler, dir } = createTestScheduler(client)
  const admission = await scheduler.acquire(RESOURCE_KIND.LLM, 's1:step1')
  assert.equal(admission.admitted, true)
  assert.equal(scheduler.getSnapshot().state, RESOURCE_SLOT_STATE.LLM)
  assert.deepEqual(client.state.loadCalls, [CONFIGURED_MODEL])
  assert.equal(client.state.models.get(CONFIGURED_MODEL)?.loaded, true)
  const events = readEvents(dir)
  assert.ok(events.some((e) => e.type === 'swap_to_llm_ok' && Number.isFinite(e.load_ms)))
  scheduler.release(RESOURCE_KIND.LLM, 's1:step1')
  assert.deepEqual(scheduler.getSnapshot().llmHolders, [])
})

test('gpu 准入触发交换：卸载在线模型 -> health 确认 -> state=gpu，事件含 unload_ms', async () => {
  const client = createFakeOmlxClient({ models: { [CONFIGURED_MODEL]: { loaded: true } } })
  const { scheduler, dir } = createTestScheduler(client)
  const admission = await scheduler.acquire(RESOURCE_KIND.GPU, 's1:render')
  assert.equal(admission.admitted, true)
  const snapshot = scheduler.getSnapshot()
  assert.equal(snapshot.state, RESOURCE_SLOT_STATE.GPU)
  assert.equal(snapshot.gpuHolder, 's1:render')
  assert.equal(client.state.models.get(CONFIGURED_MODEL)?.loaded, false)
  const events = readEvents(dir)
  const swapOk = events.find((e) => e.type === 'swap_to_gpu_ok')
  assert.ok(swapOk, '缺少 swap_to_gpu_ok 事件')
  assert.ok(Number.isFinite(swapOk.unload_ms))
  assert.equal(swapOk.unloadedCount, 1)
  // 持久化状态含持有者与获取时间
  const persisted = JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'))
  assert.equal(persisted.state, 'gpu')
  assert.equal(persisted.gpuHolder.holder, 's1:render')
  assert.ok(persisted.gpuHolder.acquiredAt)
})

test('gpu release 后 settle 窗口结束回载配置模型，事件含 load_ms', async () => {
  const client = createFakeOmlxClient({ models: { [CONFIGURED_MODEL]: { loaded: true } } })
  const { scheduler, dir } = createTestScheduler(client)
  await scheduler.acquire(RESOURCE_KIND.GPU, 's1:render')
  scheduler.release(RESOURCE_KIND.GPU, 's1:render')
  await waitFor(() => scheduler.getSnapshot().state === RESOURCE_SLOT_STATE.LLM)
  assert.equal(client.state.models.get(CONFIGURED_MODEL)?.loaded, true)
  const events = readEvents(dir)
  const reload = events.find((e) => e.type === 'swap_to_llm_ok' && e.trigger === 'gpu_batch_end')
  assert.ok(reload, '缺少 gpu_batch_end 回载事件')
  assert.ok(Number.isFinite(reload.load_ms))
})

test('出图攒批：gpu release 时仍有 gpu 等待者，直接交棒不 reload', async () => {
  const client = createFakeOmlxClient({ models: { [CONFIGURED_MODEL]: { loaded: true } } })
  const { scheduler, dir } = createTestScheduler(client)
  await scheduler.acquire(RESOURCE_KIND.GPU, 's1:render1')
  const second = scheduler.acquire(RESOURCE_KIND.GPU, 's2:render2')
  scheduler.release(RESOURCE_KIND.GPU, 's1:render1')
  const admission = await second
  assert.equal(admission.admitted, true)
  assert.equal(scheduler.getSnapshot().gpuHolder, 's2:render2')
  await sleep(120) // 超过 settle 窗口
  assert.equal(readEvents(dir).some((e) => e.type === 'swap_to_llm_start'), false, '攒批期间不应 reload')
  scheduler.release(RESOURCE_KIND.GPU, 's2:render2')
  await waitFor(() => scheduler.getSnapshot().state === RESOURCE_SLOT_STATE.LLM)
})

test('出图攒批：settle 窗口内新 gpu 申请取消待执行的 reload', async () => {
  const client = createFakeOmlxClient({ models: { [CONFIGURED_MODEL]: { loaded: true } } })
  const { scheduler, dir } = createTestScheduler(client)
  await scheduler.acquire(RESOURCE_KIND.GPU, 's1:render1')
  scheduler.release(RESOURCE_KIND.GPU, 's1:render1')
  const second = await scheduler.acquire(RESOURCE_KIND.GPU, 's1:render2') // settle 窗口内
  assert.equal(second.admitted, true)
  await sleep(120)
  assert.equal(readEvents(dir).some((e) => e.type === 'swap_to_llm_start'), false, '窗口内新 gpu 申请应取消 reload')
  scheduler.release(RESOURCE_KIND.GPU, 's1:render2')
  await waitFor(() => scheduler.getSnapshot().state === RESOURCE_SLOT_STATE.LLM)
})

test('交换编排：unload 首次失败按重试成功，事件记录重试', async () => {
  const client = createFakeOmlxClient({ models: { [CONFIGURED_MODEL]: { loaded: true } } })
  client.state.failNextUnload = 1
  const { scheduler, dir } = createTestScheduler(client)
  const admission = await scheduler.acquire(RESOURCE_KIND.GPU, 's1:render')
  assert.equal(admission.admitted, true)
  assert.equal(client.state.unloadCalls.length, 2)
  assert.ok(readEvents(dir).some((e) => e.type === 'swap_unload_retry'))
})

test('交换编排：unload 持续失败 -> acquire 显式 reject resource_swap_unload_failed，不静默放行', async () => {
  const client = createFakeOmlxClient({ models: { [CONFIGURED_MODEL]: { loaded: true } } })
  client.state.failNextUnload = 99
  const { scheduler, dir } = createTestScheduler(client)
  await assert.rejects(() => scheduler.acquire(RESOURCE_KIND.GPU, 's1:render'), /resource_swap_unload_failed/)
  assert.equal(scheduler.getSnapshot().state !== RESOURCE_SLOT_STATE.GPU, true)
  assert.ok(readEvents(dir).some((e) => e.type === 'swap_to_gpu_failed'))
})

test('装载失败显式 blocked：reload 持续失败 -> state=blocked + 事件，llm 准入重试仍显式失败', async () => {
  const client = createFakeOmlxClient({ models: { [CONFIGURED_MODEL]: { loaded: true } } })
  const { scheduler, dir } = createTestScheduler(client)
  await scheduler.acquire(RESOURCE_KIND.GPU, 's1:render')
  client.state.failNextLoad = 99
  scheduler.release(RESOURCE_KIND.GPU, 's1:render')
  await waitFor(() => scheduler.getSnapshot().state === RESOURCE_SLOT_STATE.BLOCKED)
  const snapshot = scheduler.getSnapshot()
  assert.equal(snapshot.blocked?.reason, 'resource_swap_load_failed')
  assert.ok(readEvents(dir).some((e) => e.type === 'swap_to_llm_failed'))
  // llm 准入在 blocked 下重试加载，仍失败则显式抛出（不静默继续）
  await assert.rejects(() => scheduler.acquire(RESOURCE_KIND.LLM, 's2:step'), /resource_swap_load_failed/)
})

test('单模型守卫：reconcile 卸载非配置模型并记录事件', async () => {
  const client = createFakeOmlxClient({
    models: {
      [CONFIGURED_MODEL]: { loaded: true },
      'gpt-oss-20b-MXFP4-Q8': { loaded: true }
    }
  })
  const { scheduler, dir } = createTestScheduler(client)
  // 先让调度器进入 llm（配置模型在线）
  const admission = await scheduler.acquire(RESOURCE_KIND.LLM, 's1:step')
  assert.equal(admission.admitted, true)
  const result = await scheduler.reconcile({ trigger: 'test' })
  assert.equal(result.result, 'ok')
  assert.equal(client.state.models.get('gpt-oss-20b-MXFP4-Q8')?.loaded, false)
  assert.equal(client.state.models.get(CONFIGURED_MODEL)?.loaded, true, '配置模型不得被误卸')
  assert.ok(readEvents(dir).some((e) => e.type === 'guard_unload_foreign_model' && e.model === 'gpt-oss-20b-MXFP4-Q8'))
  assert.deepEqual(client.state.unloadCalls, ['gpt-oss-20b-MXFP4-Q8'])
})

test('单模型守卫：配置模型意外缺席且有 llm 需求 -> reconcile 回载；漂移纠正 llm->idle', async () => {
  const client = createFakeOmlxClient({ models: { [CONFIGURED_MODEL]: { loaded: true } } })
  const { scheduler, dir } = createTestScheduler(client)
  await scheduler.acquire(RESOURCE_KIND.LLM, 's1:step')
  assert.equal(scheduler.getSnapshot().state, RESOURCE_SLOT_STATE.LLM)
  // 模拟外部把配置模型卸了（llm 持有者仍在 -> 有 llm 需求）
  client.state.models.get(CONFIGURED_MODEL).loaded = false
  client.state.loadCalls.length = 0
  const result = await scheduler.reconcile({ trigger: 'test' })
  assert.equal(result.result, 'ok')
  assert.equal(client.state.loadCalls.length > 0, true, '有 llm 需求时应回载配置模型')
  assert.equal(scheduler.getSnapshot().state, RESOURCE_SLOT_STATE.LLM)
  assert.ok(readEvents(dir).some((e) => e.type === 'swap_to_llm_ok'))
})

test('llm 在 gpu 占用期等待：不产生失败、不消耗重试预算；release 后自动放行', async () => {
  const client = createFakeOmlxClient({ models: { [CONFIGURED_MODEL]: { loaded: true } } })
  const { scheduler } = createTestScheduler(client)
  await scheduler.acquire(RESOURCE_KIND.GPU, 's1:render')
  let waits = 0
  const llmAdmission = scheduler.acquire(RESOURCE_KIND.LLM, 's2:step', {
    onWaitChange: (waiting) => {
      if (waiting) waits += 1
    }
  })
  await sleep(30)
  assert.equal(scheduler.getSnapshot().llmWaiters, 1)
  assert.equal(waits, 1)
  scheduler.release(RESOURCE_KIND.GPU, 's1:render')
  const admission = await llmAdmission // release -> settle -> reload -> 放行
  assert.equal(admission.admitted, true)
  assert.equal(scheduler.getSnapshot().state, RESOURCE_SLOT_STATE.LLM)
  scheduler.release(RESOURCE_KIND.LLM, 's2:step')
})

test('llm 等待可被取消中断：返回未准入而非失败（不动 retry 预算）', async () => {
  const client = createFakeOmlxClient({ models: { [CONFIGURED_MODEL]: { loaded: true } } })
  const { scheduler } = createTestScheduler(client)
  await scheduler.acquire(RESOURCE_KIND.GPU, 's1:render')
  let abortAfter = 3
  const admission = await scheduler.acquire(RESOURCE_KIND.LLM, 's2:step', {
    shouldAbort: () => {
      abortAfter -= 1
      return abortAfter <= 0 ? { aborted: true, reason: 'cancelled' } : { aborted: false }
    }
  })
  assert.equal(admission.admitted, false)
  assert.equal(admission.reason, 'cancelled')
  scheduler.release(RESOURCE_KIND.GPU, 's1:render')
  await waitFor(() => scheduler.getSnapshot().state === RESOURCE_SLOT_STATE.LLM)
})

test('writer 优先：gpu 申请登记后新 llm 准入等待，已在运行的 llm 持有者收尾后才交换', async () => {
  const client = createFakeOmlxClient({ models: { [CONFIGURED_MODEL]: { loaded: true } } })
  const { scheduler } = createTestScheduler(client)
  await scheduler.acquire(RESOURCE_KIND.LLM, 's1:step') // 运行中的 llm step
  const gpuAdmission = scheduler.acquire(RESOURCE_KIND.GPU, 's2:render')
  await sleep(20)
  assert.equal(scheduler.getSnapshot().state, RESOURCE_SLOT_STATE.LLM, 'llm 持有者未收尾前不得交换')
  assert.equal(client.state.models.get(CONFIGURED_MODEL)?.loaded, true, '不掐断运行中的推理')
  // gpu 已排队，新 llm 准入必须等待（writer 优先）
  let llmAdmitted = false
  const lateLlm = scheduler.acquire(RESOURCE_KIND.LLM, 's3:step').then((a) => {
    llmAdmitted = a.admitted
    return a
  })
  await sleep(20)
  assert.equal(llmAdmitted, false)
  scheduler.release(RESOURCE_KIND.LLM, 's1:step') // llm 收尾 -> 交换放行 gpu
  const admission = await gpuAdmission
  assert.equal(admission.admitted, true)
  assert.equal(scheduler.getSnapshot().state, RESOURCE_SLOT_STATE.GPU)
  scheduler.release(RESOURCE_KIND.GPU, 's2:render')
  const late = await lateLlm
  assert.equal(late.admitted, true)
})

test('gpu 等待者的取消看守：长占用期间取消即时生效', async () => {
  const client = createFakeOmlxClient({ models: { [CONFIGURED_MODEL]: { loaded: true } } })
  const { scheduler } = createTestScheduler(client)
  await scheduler.acquire(RESOURCE_KIND.GPU, 's1:render1')
  let cancel = false
  const admissionPromise = scheduler.acquire(RESOURCE_KIND.GPU, 's2:render2', {
    shouldAbort: () => (cancel ? { aborted: true, reason: 'cancelled' } : { aborted: false })
  })
  await sleep(20)
  cancel = true
  const admission = await admissionPromise // 无需等 s1 release
  assert.equal(admission.admitted, false)
  assert.equal(admission.reason, 'cancelled')
  scheduler.release(RESOURCE_KIND.GPU, 's1:render1')
  await waitFor(() => scheduler.getSnapshot().state === RESOURCE_SLOT_STATE.LLM)
})

test('状态持久化与重启恢复：gpu 崩溃残留回落 idle，持有者清空', async () => {
  const client = createFakeOmlxClient({ models: { [CONFIGURED_MODEL]: { loaded: true } } })
  const { scheduler, dir } = createTestScheduler(client)
  await scheduler.acquire(RESOURCE_KIND.GPU, 's1:render')
  // 模拟进程崩溃：直接用同一 state 文件重建实例
  const revived = createResourceScheduler({
    omlxClient: client,
    resolveConfiguredModel: () => ({ model: CONFIGURED_MODEL, provider: 'omlx', baseUrl: 'http://127.0.0.1:18888/v1' }),
    stateFile: path.join(dir, 'state.json'),
    eventsFile: path.join(dir, 'events.jsonl'),
    sleepFn: testSleepFn
  })
  const snapshot = revived.getSnapshot()
  assert.equal(snapshot.state, RESOURCE_SLOT_STATE.IDLE, 'gpu 崩溃残留应回落 idle，由 reconcile 对齐')
  assert.equal(snapshot.gpuHolder, null)
  assert.deepEqual(snapshot.llmHolders, [])
})

test('状态端点：/api/control/resources/state 返回槽位/内存/事件/守卫状态', async () => {
  const client = createFakeOmlxClient({ models: { [CONFIGURED_MODEL]: { loaded: true } } })
  const { scheduler } = createTestScheduler(client)
  await scheduler.acquire(RESOURCE_KIND.LLM, 's1:step')
  const app = new Hono()
  registerResourceRoutes(app, { getResourceSchedulerState: () => scheduler.getState({ probe: true }) })
  const res = await app.request('http://test/api/control/resources/state')
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.equal(body.ok, true)
  assert.equal(body.enabled, true)
  assert.equal(body.state, 'llm')
  assert.equal(body.configuredModel, CONFIGURED_MODEL)
  assert.equal(body.modelOnline.loaded, true)
  assert.equal(body.memory.loadedCount, 1)
  assert.equal(body.memory.finalCeiling, 26800603136)
  assert.ok(Array.isArray(body.recentEvents))
  assert.ok(body.recentEvents.some((e) => e.type === 'swap_to_llm_ok'))
  assert.equal(typeof body.reconcile.intervalMs, 'number')
  scheduler.release(RESOURCE_KIND.LLM, 's1:step')
})

test('队列门禁集成：claimGate 返回 ok:false 时 item 保持 queued 不领取，恢复后正常执行', async () => {
  const queueDir = fs.mkdtempSync(path.join(os.tmpdir(), 'resource-gate-queue-'))
  const savedDir = process.env.HERMES_REASONING_QUEUE_DIR
  process.env.HERMES_REASONING_QUEUE_DIR = queueDir
  try {
    const session = { sessionId: 'sess-gate-1', status: 'queued' }
    enqueueQueueItem({ sessionId: session.sessionId, projectId: null })
    let gateOpen = false
    let executed = 0
    const worker = createReasoningQueueWorker({
      workerId: 'test-worker',
      maxConcurrency: 1,
      tickMs: 20,
      readSession: () => session,
      executeItem: async () => {
        executed += 1
        session.status = 'completed'
      },
      canExecute: () => true,
      // AUTO-R01：gpu 占用期 llm 任务保持 queued（模拟调度器门禁语义）
      claimGate: () => (gateOpen ? { ok: true } : { ok: false, reason: 'resource_gpu_occupied' })
    })
    worker.tick()
    worker.tick()
    assert.equal(readQueueItem(session.sessionId).status, REASONING_QUEUE_ITEM_STATE.QUEUED, '门禁关闭时必须保持 queued')
    assert.equal(executed, 0)
    gateOpen = true
    worker.tick()
    await waitFor(() => executed === 1)
    worker.tick() // 执行完成后由 tick  reconcile 镜像 session 终态到 item
    await waitFor(() => readQueueItem(session.sessionId).status === REASONING_QUEUE_ITEM_STATE.COMPLETED)
    worker.stop()
  } finally {
    if (savedDir === undefined) delete process.env.HERMES_REASONING_QUEUE_DIR
    else process.env.HERMES_REASONING_QUEUE_DIR = savedDir
  }
})
