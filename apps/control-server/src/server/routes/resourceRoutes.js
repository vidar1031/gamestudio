// AUTO-R01：本地重负载资源互斥调度的只读状态端点。
// GET /api/control/resources/state：槽位状态、持有者、配置模型在线状态、
// OMLX 内存水位（final_ceiling/current_model_memory）、最近交换事件（20 条）、reconcile 状态。
// 数据全部来自 resourceScheduler 的只读视图（实时 probe 失败回落 reconcile 缓存），
// 不发起任何写操作；守护台「运行健康」资源互斥卡片消费。
export function registerResourceRoutes(app, context) {
  const { getResourceSchedulerState } = context

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
}
