// AUTO-R01：本地重负载资源互斥调度的状态端点 + 跨进程租约端点。
// GET  /api/control/resources/state：槽位状态、持有者、配置模型在线状态、
//   OMLX 内存水位（final_ceiling/current_model_memory）、最近交换事件（20 条）、reconcile 状态。
//   数据全部来自 resourceScheduler 的只读视图（实时 probe 失败回落 reconcile 缓存），
//   不发起任何写操作；守护台「运行健康」资源互斥卡片消费。
// POST /api/control/resources/lease {kind, holder}：申请租约（长等待直到准入或客户端断连），
//   供 apps/server 等外部进程在任何本地模型/出图调用前接入互斥（统一调度唯一入口）。
// POST /api/control/resources/lease/release {leaseId}：释放租约（幂等）。
export function registerResourceRoutes(app, context) {
  const { getResourceSchedulerState, acquireResourceLease, releaseResourceLease } = context

  app.get('/api/control/resources/state', async (c) => {
    try {
      const state = typeof getResourceSchedulerState === 'function'
        ? await getResourceSchedulerState()
        : { enabled: false, detail: 'resource_scheduler_not_wired' }
      return c.json({ ok: true, ...state })
    } catch (error) {
      return c.json({ ok: false, error: error instanceof Error ? error.message : String(error) }, 500)
    }
  })

  app.post('/api/control/resources/lease', async (c) => {
    if (typeof acquireResourceLease !== 'function') return c.json({ ok: false, error: 'resource_lease_not_wired' }, 501)
    const body = await c.req.json().catch(() => null)
    const kind = String(body?.kind || '').trim()
    const holder = String(body?.holder || '').trim()
    if (!kind) return c.json({ ok: false, error: 'missing_kind' }, 400)
    try {
      const result = await acquireResourceLease({ kind, holder, signal: c.req.raw.signal })
      if (!result.ok) {
        const status = result.error === 'invalid_kind' ? 400 : result.error === 'resource_scheduler_disabled' ? 503 : 409
        return c.json(result, status)
      }
      return c.json(result)
    } catch (error) {
      // 交换失败（resource_swap_*）显式 502，调用方必须按失败收敛，不得静默继续
      const message = error instanceof Error ? error.message : String(error)
      return c.json({ ok: false, error: message }, 502)
    }
  })

  app.post('/api/control/resources/lease/release', async (c) => {
    if (typeof releaseResourceLease !== 'function') return c.json({ ok: false, error: 'resource_lease_not_wired' }, 501)
    const body = await c.req.json().catch(() => null)
    const leaseId = String(body?.leaseId || '').trim()
    if (!leaseId) return c.json({ ok: false, error: 'missing_leaseId' }, 400)
    return c.json(releaseResourceLease(leaseId))
  })
}
