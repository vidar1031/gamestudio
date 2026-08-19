import {
  getResetCategories,
  getStorageOverview,
  listLogPrefixes,
  loadRetentionPolicy,
  readEventHistory,
  readReviewRecords,
  runMaintenanceReset,
  runRetentionCleanup
} from '../maintenance/retention.js'

// 维护与审计路由：存储概览、保留策略、清理重置、事件/审核历史、日志前缀。
// 清理一律先归档后清空；reset 必须 confirm=true。
export function registerMaintenanceRoutes(app) {
  app.get('/api/control/maintenance/storage-overview', (c) => {
    try {
      const { overview, categories } = getStorageOverview()
      return c.json({ ok: true, overview, categories, policy: loadRetentionPolicy(), resetCategories: getResetCategories() })
    } catch (error) {
      return c.json({ ok: false, error: error instanceof Error ? error.message : String(error) }, 500)
    }
  })

  app.post('/api/control/maintenance/retention/run', async (c) => {
    try {
      const report = runRetentionCleanup({ trigger: 'manual' })
      return c.json({ ok: true, report })
    } catch (error) {
      return c.json({ ok: false, error: error instanceof Error ? error.message : String(error) }, 500)
    }
  })

  app.post('/api/control/maintenance/reset', async (c) => {
    const body = await c.req.json().catch(() => null)
    const category = String(body?.category || '').trim()
    if (!category) {
      return c.json({ ok: false, error: 'missing_category' }, 400)
    }
    if (body?.confirm !== true) {
      return c.json({ ok: false, error: 'confirm_required' }, 409)
    }
    try {
      const report = runMaintenanceReset(category, { confirm: true })
      return c.json({ ok: true, report })
    } catch (error) {
      return c.json({ ok: false, error: error instanceof Error ? error.message : String(error) }, 500)
    }
  })

  app.get('/api/control/events/history', (c) => {
    const limit = Math.max(1, Math.min(500, Number(c.req.query('limit') || 100)))
    try {
      return c.json({ ok: true, events: readEventHistory(limit) })
    } catch (error) {
      return c.json({ ok: false, error: error instanceof Error ? error.message : String(error) }, 500)
    }
  })

  app.get('/api/control/review-records', (c) => {
    const limit = Math.max(1, Math.min(500, Number(c.req.query('limit') || 100)))
    try {
      return c.json({ ok: true, records: readReviewRecords(limit) })
    } catch (error) {
      return c.json({ ok: false, error: error instanceof Error ? error.message : String(error) }, 500)
    }
  })

  app.get('/api/control/maintenance/log-prefixes', (c) => {
    try {
      return c.json({ ok: true, ...listLogPrefixes() })
    } catch (error) {
      return c.json({ ok: false, error: error instanceof Error ? error.message : String(error) }, 500)
    }
  })
}
