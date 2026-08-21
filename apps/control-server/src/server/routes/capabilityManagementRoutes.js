import { discoverAndVerifyCapabilities } from '../services/capabilityDiscoveryService.js'
import { registerCapability, disableCapability, enableCapability, listRegisteredCapabilities } from '../services/capabilityRegistrationService.js'

// 能力管理路由：能力探测、注册、禁用、启用。
export function registerCapabilityManagementRoutes(app) {
  // 探测绑定项目的可用能力
  app.get('/api/control/capabilities/discover', async (c) => {
    const result = await discoverAndVerifyCapabilities()
    if (!result.ok) {
      return c.json({ ok: false, error: result.error }, 500)
    }
    return c.json({ ok: true, capabilities: result.capabilities })
  })

  // 获取已注册能力列表
  app.get('/api/control/capabilities/registered', (c) => {
    const capabilities = listRegisteredCapabilities()
    return c.json({ ok: true, capabilities })
  })

  // 注册能力
  app.post('/api/control/capabilities/register', async (c) => {
    const body = await c.req.json().catch(() => null)
    if (!body || typeof body !== 'object' || !body.capability) {
      return c.json({ ok: false, error: 'invalid_body' }, 400)
    }
    const actor = String(body.actor || 'console').trim()
    const result = registerCapability(body.capability, actor)
    if (!result.ok) {
      return c.json({ ok: false, error: result.error }, 500)
    }
    return c.json({ ok: true })
  })

  // 禁用能力
  app.post('/api/control/capabilities/:capabilityId/disable', async (c) => {
    const capabilityId = String(c.req.param('capabilityId') || '').trim()
    const body = await c.req.json().catch(() => ({}))
    const actor = String(body?.actor || 'console').trim()
    const result = disableCapability(capabilityId, actor)
    if (!result.ok) {
      return c.json({ ok: false, error: result.error }, 500)
    }
    return c.json({ ok: true })
  })

  // 启用能力
  app.post('/api/control/capabilities/:capabilityId/enable', async (c) => {
    const capabilityId = String(c.req.param('capabilityId') || '').trim()
    const body = await c.req.json().catch(() => ({}))
    const actor = String(body?.actor || 'console').trim()
    const result = enableCapability(capabilityId, actor)
    if (!result.ok) {
      return c.json({ ok: false, error: result.error }, 500)
    }
    return c.json({ ok: true })
  })
}
