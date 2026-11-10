// ---------------------------------------------------------------------------
// GET /api/projects/:id/ai/events —— 项目 AI 进度 SSE 推送（替代编辑器 1.5s 轮询）
// 信号语义：服务端在任务台账 / 图片审核 / 出图总账发生变化时推 { type, at }，
// 客户端收到后按类型重拉对应只读接口。连接建立即推三条 sync 信号驱动首次全量同步，
// 断线重连天然补齐丢失事件，无需服务端缓存事件队列。
// ---------------------------------------------------------------------------
import { subscribeProjectEvents } from '../ai/projectEventBus.js'

const PING_INTERVAL_MS = 25000

export function registerProjectEventsRoutes(app, ctx) {
  app.get('/api/projects/:id/ai/events', async (c) => {
    const id = c.req.param('id')
    const dir = ctx.projectDir(id)
    if (!(await ctx.existsDir(dir))) return c.json({ success: false, error: 'not_found' }, 404)

    const encoder = new TextEncoder()
    let closed = false

    const stream = new ReadableStream({
      start(controller) {
        const send = (payload) => {
          if (closed) return
          try {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`))
          } catch (_) {
            closed = true
          }
        }
        const nowIso = () => new Date().toISOString()
        // 建立即全量同步（等价于打开页面首轮轮询）
        send({ type: 'tasks', at: nowIso() })
        send({ type: 'reviews', at: nowIso() })
        send({ type: 'coverage', at: nowIso() })
        const unsubscribe = subscribeProjectEvents(dir, (signal) => send(signal))
        const pingTimer = setInterval(() => {
          if (closed) return
          try {
            controller.enqueue(encoder.encode(': ping\n\n'))
          } catch (_) {
            closed = true
          }
        }, PING_INTERVAL_MS)
        // 挂到 controller 便于 cancel 时清理（客户端断开或服务端关闭流）
        this._cleanup = () => {
          clearInterval(pingTimer)
          unsubscribe()
        }
      },
      cancel() {
        closed = true
        if (typeof this._cleanup === 'function') this._cleanup()
      }
    })

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no'
      }
    })
  })
}
