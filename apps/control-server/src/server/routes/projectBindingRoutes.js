import { appendGovernanceAudit } from '../reasoning/governanceAudit.js'
import { getProjectBinding, setProjectBinding, probeProjectBinding } from '../services/projectBindingService.js'

// 项目绑定路由：守护台「当前绑定项目」的读写入口。
// GET 只读并附带活性探测；PUT 是写动作（D02 访问边界自动覆盖），
// 无论成功/拒绝都写治理审计（governanceAudit），供治理页追溯。
export function registerProjectBindingRoutes(app) {
  app.get('/api/control/project-binding', async (c) => {
    const binding = getProjectBinding()
    const probe = binding.bound
      ? await probeProjectBinding(binding.baseUrl)
      : { reachable: false, detail: '尚未绑定项目', checkedAt: new Date().toISOString() }
    return c.json({ ok: true, binding, probe })
  })

  app.put('/api/control/project-binding', async (c) => {
    const body = await c.req.json().catch(() => null)
    if (!body || typeof body !== 'object') {
      appendGovernanceAudit({ action: 'project_binding_update', result: 'blocked', detail: 'invalid_body', actor: 'console' })
      return c.json({ ok: false, error: 'invalid_body' }, 400)
    }
    try {
      const binding = setProjectBinding(body)
      const detail = binding.bound
        ? `绑定更新为 ${binding.label}（${binding.baseUrl}）`
        : '解除项目绑定'
      appendGovernanceAudit({ action: 'project_binding_update', result: 'ok', detail, actor: 'console' })
      return c.json({ ok: true, binding })
    } catch (error) {
      const code = error?.code || 'invalid_binding'
      appendGovernanceAudit({ action: 'project_binding_update', result: 'blocked', detail: code, actor: 'console' })
      return c.json({ ok: false, error: code }, 400)
    }
  })
}
