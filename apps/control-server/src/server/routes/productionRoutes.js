import { compileProductionIntent } from '../services/productionIntentCompiler.js'
import { orchestrateProduction } from '../services/workflowOrchestrator.js'

// 生产工作流路由：能力声明驱动编排的 HTTP 入口。
export function registerProductionRoutes(app) {
  // 编译生产意图（不执行）
  app.post('/api/control/production/compile', async (c) => {
    const body = await c.req.json().catch(() => null)
    const prompt = String(body?.prompt || '').trim()
    if (!prompt) {
      return c.json({ ok: false, error: 'prompt_required' }, 400)
    }
    const result = compileProductionIntent(prompt)
    if (!result.ok) {
      return c.json({ ok: false, error: result.error }, 400)
    }
    return c.json({ ok: true, plan: result.plan })
  })

  // 执行生产计划
  app.post('/api/control/production/execute', async (c) => {
    const body = await c.req.json().catch(() => null)
    const prompt = String(body?.prompt || '').trim()
    const confirmed = body?.confirmed === true
    const sessionId = body?.sessionId ? String(body.sessionId) : null
    if (!prompt) {
      return c.json({ ok: false, error: 'prompt_required' }, 400)
    }

    const compileResult = compileProductionIntent(prompt)
    if (!compileResult.ok) {
      return c.json({ ok: false, error: compileResult.error }, 400)
    }

    const execResult = await orchestrateProduction(compileResult.plan, {
      sessionId,
      actor: 'console',
      confirmed
    })

    if (!execResult.ok) {
      return c.json({
        ok: false,
        error: 'production_failed',
        plan: execResult.plan,
        results: execResult.results,
        failedStep: execResult.failedStep || null
      }, 502)
    }

    return c.json({
      ok: true,
      plan: execResult.plan,
      results: execResult.results,
      evidencePack: execResult.evidencePack,
      projectId: execResult.projectId
    })
  })
}
