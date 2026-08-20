import { buildEvidencePack, exportEvidencePack, listEvidencePacks } from '../services/evidenceCollector.js'

// 证据包路由：阶段 5 审计与治理的 HTTP 入口。
export function registerEvidenceRoutes(app) {
  // 获取动作证据包（内存构建）
  app.get('/api/control/evidence-packs/:actionId', (c) => {
    const pack = buildEvidencePack(c.req.param('actionId'))
    if (!pack) {
      return c.json({ ok: false, error: 'action_not_found' }, 404)
    }
    return c.json({ ok: true, pack })
  })

  // 导出证据包到文件
  app.post('/api/control/evidence-packs/:actionId/export', (c) => {
    const result = exportEvidencePack(c.req.param('actionId'))
    if (!result.ok) {
      return c.json({ ok: false, error: result.error }, 404)
    }
    return c.json({ ok: true, filePath: result.filePath })
  })

  // 列出已导出的证据包
  app.get('/api/control/evidence-packs', (c) => {
    const limit = Number(c.req.query('limit') || 50)
    const packs = listEvidencePacks(limit)
    return c.json({ ok: true, packs })
  })
}
