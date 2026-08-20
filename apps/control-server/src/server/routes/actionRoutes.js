import { getProjectBinding } from '../services/projectBindingService.js'
import { getProjectCapabilities } from '../services/projectCapabilityService.js'
import {
  createAction,
  getAction,
  listActions,
  transitionAction,
  recordActionReview,
  ACTION_STATE
} from '../services/actionExecutionService.js'
import { executeAction } from '../services/projectActionExecutor.js'
import { runOptimizationLoop } from '../services/optimizationLoopService.js'

// 项目动作路由：阶段 2 受控执行状态机的 HTTP 入口。
// 动作是 capability 的受控实例，具备独立状态机、traceId、证据链与审核记录。
export function registerActionRoutes(app) {
  // 创建动作
  app.post('/api/control/actions', async (c) => {
    const body = await c.req.json().catch(() => null)
    if (!body || typeof body !== 'object') {
      return c.json({ ok: false, error: 'invalid_body' }, 400)
    }
    const capabilityId = String(body.capabilityId || '').trim()
    const input = body.input && typeof body.input === 'object' ? body.input : {}
    const actor = ['chat', 'console', 'cron', 'workflow', 'testcase'].includes(String(body.actor || '')) ? String(body.actor) : 'unknown'
    const sessionId = body.sessionId ? String(body.sessionId) : null
    if (!capabilityId) {
      return c.json({ ok: false, error: 'missing_capability_id' }, 400)
    }

    // 校验 capability 是否存在于当前绑定项目
    const binding = getProjectBinding()
    const capabilitySummary = getProjectCapabilities(binding)
    if (!capabilitySummary.available) {
      return c.json({ ok: false, error: 'capability_unavailable', detail: capabilitySummary.error }, 409)
    }
    const capability = capabilitySummary.capabilities.find((item) => item.id === capabilityId)
    if (!capability) {
      return c.json({ ok: false, error: 'capability_not_found', capabilityId }, 404)
    }

    // 输入 schema 必填校验
    const required = Array.isArray(capability.inputSchema?.required) ? capability.inputSchema.required : []
    const missing = required.filter((key) => input[key] === undefined || input[key] === null || String(input[key]).trim() === '')
    if (missing.length) {
      return c.json({ ok: false, error: 'missing_required_input', missing }, 400)
    }

    const action = createAction({ sessionId, capabilityId, input, actor, projectId: input.projectId || null })
    // 创建后自动进入 ready（已具备执行条件）
    const readyAction = transitionAction(action.actionId, ACTION_STATE.READY, 'input_validated', {
      type: 'capability_bound',
      capability: { id: capability.id, type: capability.type, requiresReview: capability.requiresReview }
    })
    return c.json({ ok: true, action: readyAction }, 201)
  })

  // 列出动作
  app.get('/api/control/actions', (c) => {
    const sessionId = c.req.query('sessionId') || null
    const status = c.req.query('status') || null
    const projectId = c.req.query('projectId') || null
    const limit = Number(c.req.query('limit') || 50)
    const actions = listActions({ sessionId, status, projectId, limit })
    return c.json({ ok: true, actions })
  })

  // 获取动作详情
  app.get('/api/control/actions/:actionId', (c) => {
    const action = getAction(c.req.param('actionId'))
    if (!action) {
      return c.json({ ok: false, error: 'action_not_found' }, 404)
    }
    return c.json({ ok: true, action })
  })

  // 执行动作
  app.post('/api/control/actions/:actionId/execute', async (c) => {
    const actionId = c.req.param('actionId')
    const body = await c.req.json().catch(() => ({}))
    const dryRun = body?.dryRun === true
    const confirmed = body?.confirmed === true
    const result = await executeAction(actionId, { dryRun, confirmed })
    if (result.error === 'review_required') {
      return c.json({ ok: false, error: 'review_required', action: result.action }, 409)
    }
    if (!result.ok) {
      return c.json({ ok: false, error: result.error, action: result.action, validation: result.validation }, 502)
    }
    return c.json({ ok: true, action: result.action, validation: result.validation })
  })

  // 多轮优化闭环
  app.post('/api/control/actions/:actionId/optimize', async (c) => {
    const actionId = c.req.param('actionId')
    const body = await c.req.json().catch(() => ({}))
    const maxRounds = Math.max(1, Math.min(10, Number(body?.maxRounds) || 3))
    const confirmed = body?.confirmed === true
    const result = await runOptimizationLoop(actionId, { maxRounds, confirmed })
    if (!result.ok) {
      return c.json({ ok: false, error: result.error, finalAction: result.finalAction, rounds: result.rounds, bestAction: result.bestAction }, 502)
    }
    return c.json({ ok: true, finalAction: result.finalAction, rounds: result.rounds, bestAction: result.bestAction })
  })

  // 人工触发状态转移（如 approve/reject/retry）
  app.post('/api/control/actions/:actionId/transition', async (c) => {
    const actionId = c.req.param('actionId')
    const body = await c.req.json().catch(() => null)
    if (!body || typeof body !== 'object') {
      return c.json({ ok: false, error: 'invalid_body' }, 400)
    }
    const toState = String(body.toState || '').trim()
    const reason = String(body.reason || 'manual_transition').trim()
    const actor = String(body.actor || 'console').trim()
    const note = String(body.note || '').trim()

    const action = getAction(actionId)
    if (!action) {
      return c.json({ ok: false, error: 'action_not_found' }, 404)
    }

    // 审核决策记录
    if (toState === ACTION_STATE.APPROVED || toState === ACTION_STATE.FAILED) {
      const decision = toState === ACTION_STATE.APPROVED ? 'approve' : 'reject'
      recordActionReview(actionId, { decision, actor, note })
    }

    const updated = transitionAction(actionId, toState, reason, {
      type: 'manual_transition',
      actor,
      note
    })
    return c.json({ ok: true, action: updated })
  })
}
