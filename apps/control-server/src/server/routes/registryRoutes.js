import {
  getRegistryProject,
  getRegistryWorkflow,
  listRegistryProjects,
  listRegistryWorkflows,
  registerRegistryProject,
  registerRegistryWorkflow,
  setRegistryEntryEnabled
} from '../reasoning/projectWorkflowRegistry.js'
import {
  getRegisteredWorkflowRun,
  listRegisteredWorkflowRuns,
  reviewRegisteredWorkflowRun,
  runRegisteredWorkflow
} from '../reasoning/registryWorkflowRunner.js'

// HERMES-H04：项目/workflow 注册表 API（总计划 S4-07）。
// - GET 概览是 Hermes/cron/守护台的统一能力发现面：只能看到注册表中登记的能力；
// - 写类端点（注册/启停/触发/审核）全部受控：人类 actor + 审计，受 AUTO-D02
//   访问边界保护（默认仅本机）；注册表条目只声明能力，不绕过任何既有审核门禁。
export function registerRegistryRoutes(app) {
  app.get('/api/control/registry/overview', (c) => {
    const projects = listRegistryProjects()
    const workflows = listRegistryWorkflows()
    return c.json({ ok: true, projects, workflows })
  })

  app.get('/api/control/registry/projects', (c) => {
    return c.json({ ok: true, projects: listRegistryProjects() })
  })

  app.get('/api/control/registry/workflows', (c) => {
    const projectId = String(c.req.query('projectId') || '').trim() || undefined
    return c.json({ ok: true, workflows: listRegistryWorkflows({ projectId }) })
  })

  app.post('/api/control/registry/projects', async (c) => {
    const body = await c.req.json().catch(() => ({}))
    const result = registerRegistryProject(body, { actor: body.actor })
    if (!result.ok) {
      const status = result.error === 'actor_not_human' ? 403 : (result.error === 'project_already_registered' || result.error === 'builtin_entry_protected' ? 409 : 400)
      return c.json({ ok: false, error: result.error, detail: result.detail }, status)
    }
    return c.json({ ok: true, project: result.project })
  })

  app.post('/api/control/registry/workflows', async (c) => {
    const body = await c.req.json().catch(() => ({}))
    const result = registerRegistryWorkflow(body, { actor: body.actor })
    if (!result.ok) {
      const status = result.error === 'actor_not_human' ? 403 : (['workflow_already_registered', 'builtin_entry_protected'].includes(result.error) ? 409 : 400)
      return c.json({ ok: false, error: result.error, detail: result.detail }, status)
    }
    return c.json({ ok: true, workflow: result.workflow })
  })

  app.post('/api/control/registry/projects/:projectId/status', async (c) => {
    const { projectId } = c.req.param()
    const body = await c.req.json().catch(() => ({}))
    const result = setRegistryEntryEnabled('project', projectId, body.enabled === true, { actor: body.actor })
    if (!result.ok) {
      const status = result.error === 'actor_not_human' ? 403 : (result.error === 'project_not_registered' ? 404 : 409)
      return c.json({ ok: false, error: result.error, detail: result.detail }, status)
    }
    return c.json({ ok: true, project: result.project })
  })

  app.post('/api/control/registry/workflows/:workflowId/status', async (c) => {
    const { workflowId } = c.req.param()
    const body = await c.req.json().catch(() => ({}))
    const result = setRegistryEntryEnabled('workflow', workflowId, body.enabled === true, { actor: body.actor })
    if (!result.ok) {
      const status = result.error === 'actor_not_human' ? 403 : (result.error === 'workflow_not_registered' ? 404 : 409)
      return c.json({ ok: false, error: result.error, detail: result.detail }, status)
    }
    return c.json({ ok: true, workflow: result.workflow })
  })

  // 受控触发：注册表门禁（未注册/停用/跨项目归属/输入不合法）未过一律 403，
  // 不产生任何写入；通过后按注册表条目声明的执行器与审核策略执行
  app.post('/api/control/registry/workflows/:workflowId/runs', async (c) => {
    const { workflowId } = c.req.param()
    const body = await c.req.json().catch(() => ({}))
    const result = await runRegisteredWorkflow({
      workflowId,
      projectId: body.projectId,
      input: body.input && typeof body.input === 'object' ? body.input : {},
      actor: body.actor
    })
    if (!result.ok) {
      const status = result.error === 'workflow_not_registered' || result.error === 'project_not_registered' ? 404
        : (['workflow_disabled', 'project_disabled', 'cross_project_rejected', 'input_invalid', 'executor_not_runnable'].includes(result.error) ? 403 : 409)
      return c.json({ ok: false, error: result.error, detail: result.detail }, status)
    }
    return c.json({ ok: true, run: result.run })
  })

  app.get('/api/control/registry/runs', (c) => {
    const projectId = String(c.req.query('projectId') || '').trim() || undefined
    const workflowId = String(c.req.query('workflowId') || '').trim() || undefined
    return c.json({ ok: true, runs: listRegisteredWorkflowRuns({ projectId, workflowId }) })
  })

  app.get('/api/control/registry/runs/:runId', (c) => {
    const { runId } = c.req.param()
    const run = getRegisteredWorkflowRun(runId)
    if (!run) return c.json({ ok: false, error: 'registry_run_not_found' }, 404)
    return c.json({ ok: true, run })
  })

  app.post('/api/control/registry/runs/:runId/review', async (c) => {
    const { runId } = c.req.param()
    const body = await c.req.json().catch(() => ({}))
    const result = reviewRegisteredWorkflowRun(runId, { decision: body.decision, actor: body.actor, note: body.note })
    if (!result.ok) {
      const status = result.error === 'registry_run_not_found' ? 404 : (result.error === 'actor_not_human' ? 403 : 409)
      return c.json({ ok: false, error: result.error, detail: result.detail }, status)
    }
    return c.json({ ok: true, run: result.run })
  })

  // 单条项目/workflow 详情（404 语义与列表一致）
  app.get('/api/control/registry/projects/:projectId', (c) => {
    const project = getRegistryProject(c.req.param('projectId'))
    if (!project) return c.json({ ok: false, error: 'project_not_registered' }, 404)
    return c.json({ ok: true, project })
  })

  app.get('/api/control/registry/workflows/:workflowId', (c) => {
    const workflow = getRegistryWorkflow(c.req.param('workflowId'))
    if (!workflow) return c.json({ ok: false, error: 'workflow_not_registered' }, 404)
    return c.json({ ok: true, workflow })
  })
}
