// Hermes 历史会话检索（只读）：GET /api/control/hermes/session-search?q=...
// 直接查 state.db FTS5（见 hermesSessionSearchService 的设计决定），不经过网关推理。

import { searchHermesSessions } from '../services/hermesSessionSearchService.js'

export function registerHermesSessionSearchRoutes(app) {
  app.get('/api/control/hermes/session-search', (c) => {
    const q = c.req.query('q')
    const limit = c.req.query('limit')
    const result = searchHermesSessions({ query: q, limit })
    if (!result.ok) {
      const status = result.error === 'missing_query' ? 400 : 500
      return c.json(result, status)
    }
    return c.json(result)
  })
}
