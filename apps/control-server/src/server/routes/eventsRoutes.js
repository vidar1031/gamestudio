import { dispatchGameStudioEvent } from '../events/eventDispatcher.js'
import { readGameStudioEventRuns } from '../events/eventRunsReader.js'
import { getProjectBinding } from '../services/projectBindingService.js'

// 事件层路由：注册表透传 + 事件分发入口 + 执行历史只读查询。
// 注册表所有权属于 GameStudio（apps/server/events/registry.v1.json），此处只做透传与错误归一。
// 注册表来源跟随「当前绑定项目」（projectBindingService），未绑定/不可达时返回明确 unavailable，绝不 500。
// /dispatch 是聊天激活与外挂测试 runner 共用的唯一事件执行入口。
export function registerEventsRoutes(app) {
  app.get('/api/control/events/registry', async (c) => {
    const binding = getProjectBinding()
    if (!binding.bound) {
      return c.json({ ok: true, available: false, reason: 'project_not_bound', error: 'project_not_bound', binding })
    }
    const baseUrl = binding.baseUrl
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 10000)
    try {
      const res = await fetch(`${baseUrl}/api/events/registry`, {
        signal: controller.signal
      })
      const payload = await res.json().catch(() => null)
      if (!res.ok || !payload || payload.success !== true || !payload.registry) {
        return c.json({
          ok: true,
          available: false,
          reason: 'registry_invalid_response',
          error: payload?.error || `gamestudio_registry_http_${res.status}`,
          binding
        })
      }
      return c.json({ ok: true, available: true, registry: payload.registry, binding, source: `${baseUrl}/api/events/registry` })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return c.json({ ok: true, available: false, reason: 'registry_unreachable', error: `gamestudio_registry_unreachable: ${message}`, binding })
    } finally {
      clearTimeout(timeout)
    }
  })

  // 事件执行历史（只读）：按 eventId/code 过滤，返回最近 N 条（新的在前）。
  app.get('/api/control/events/runs', (c) => {
    const eventRef = String(c.req.query('event') || '').trim()
    const limit = Math.max(1, Math.min(50, Number(c.req.query('limit') || 10)))
    const runs = readGameStudioEventRuns({ eventRef, limit })
    return c.json({ ok: true, runs })
  })

  app.post('/api/control/events/dispatch', async (c) => {
    const body = await c.req.json().catch(() => null)
    const eventRef = String(body?.event || '').trim()
    const payload = body?.payload && typeof body.payload === 'object' ? body.payload : {}
    const caller = ['chat', 'console', 'testcase', 'cron', 'workflow'].includes(String(body?.caller || '')) ? String(body.caller) : 'unknown'
    if (!eventRef) {
      return c.json({ ok: false, error: 'missing_event' }, 400)
    }
    try {
      const result = await dispatchGameStudioEvent(eventRef, payload, {
        caller,
        confirmed: body?.confirmed === true,
        sessionId: body?.sessionId || null,
        caseId: body?.caseId || null
      })
      if (result.error === 'review_required') {
        return c.json({ ok: false, error: 'review_required', event: result.event ? {
          eventId: result.event.eventId,
          code: result.event.code || null,
          kind: result.event.kind,
          title: result.event.title,
          reviewRequired: result.event.reviewRequired === true
        } : null, traceId: result.traceId }, 409)
      }
      if (!result.eventId) {
        return c.json({ ok: false, error: result.error, traceId: result.traceId }, 404)
      }
      if (String(result.error || '').startsWith('payload_missing_required')) {
        return c.json({ ok: false, error: result.error, eventId: result.eventId, traceId: result.traceId }, 400)
      }
      return c.json(result, result.ok ? 200 : 502)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return c.json({ ok: false, error: `event_dispatch_failed: ${message}` }, 500)
    }
  })
}
