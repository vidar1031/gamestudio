import { getProjectBinding } from '../services/projectBindingService.js'
import { getProjectCapabilities } from '../services/projectCapabilityService.js'

// 项目能力路由：agent 发现能力的标准入口。
export function registerProjectCapabilityRoutes(app) {
  // 获取当前绑定项目的能力总表
  app.get('/api/control/project-capabilities', (c) => {
    const binding = getProjectBinding()
    const summary = getProjectCapabilities(binding)
    return c.json({
      ok: true,
      available: summary.available,
      capabilities: summary.capabilities,
      runtimeDescriptor: summary.runtimeDescriptor,
      source: summary.source,
      error: summary.error,
      detail: summary.detail || null
    })
  })

  // 按 projectId 获取能力（当前实现与绑定项目一致，预留多项目扩展）
  app.get('/api/control/project-capabilities/:projectId', (c) => {
    const projectId = String(c.req.param('projectId') || '').trim()
    const binding = getProjectBinding()
    if (!binding.bound) {
      return c.json({ ok: false, error: 'project_not_bound' }, 404)
    }
    const summary = getProjectCapabilities(binding)
    if (!summary.available) {
      return c.json({ ok: false, error: summary.error || 'capabilities_unavailable' }, 404)
    }
    // 当前绑定项目与请求 projectId 不匹配时返回 404（未来支持多项目注册表）
    const boundProjectId = String(summary.runtimeDescriptor?.projectId || binding.id || '').trim()
    if (projectId && boundProjectId && projectId !== boundProjectId) {
      return c.json({ ok: false, error: 'project_not_found', projectId }, 404)
    }
    return c.json({
      ok: true,
      available: true,
      capabilities: summary.capabilities,
      runtimeDescriptor: summary.runtimeDescriptor,
      source: summary.source
    })
  })
}
