import {
  CRON_WORKFLOW_REGISTRY,
  listCronJobs,
  createCronJob,
  setCronJobStatus,
  triggerCronJob
} from '../reasoning/cronGovernance.js'

// HERMES-H02：cron 受控生产触发 API。
// 全部为治理面端点：job 注册/查询/暂停/恢复/停用/删除 + 人工触发（走与调度 tick
// 相同的受控适配器）。写类端点受 AUTO-D02 访问边界保护（默认仅本机）；
// 触发链路与 HTTP session 入口一致：白名单 -> 启动门禁 -> 幂等 -> 创建 session -> 入队。
export function registerCronRoutes(app, context) {
  const {
    hermesAgentDefinition,
    createReasoningSession,
    dispatchReasoningSession,
    readReasoningSession,
    getHermesRuntimeState,
    buildReasoningStartBlocker,
    getCronSchedulerState
  } = context

  // 与调度 tick 共用的一套受控依赖：session 创建与入队都走 controlServerCore 既有入口
  const buildTriggerDeps = () => ({
    createSession: (prompt, submissionContext) => createReasoningSession(hermesAgentDefinition.id, prompt, submissionContext),
    dispatch: (sessionId) => dispatchReasoningSession(sessionId),
    readSession: (sessionId) => readReasoningSession(sessionId),
    checkStartAllowed: () => {
      const runtimeStatus = getHermesRuntimeState()
      if (runtimeStatus.state !== 'running') return { ok: false, reason: 'runtime_not_running' }
      const blocker = buildReasoningStartBlocker()
      if (blocker) return { ok: false, reason: blocker.error || 'start_blocked' }
      return { ok: true }
    }
  })

  app.get('/api/control/cron/jobs', (c) => {
    return c.json({
      ok: true,
      scheduler: typeof getCronSchedulerState === 'function' ? getCronSchedulerState() : null,
      workflows: Object.values(CRON_WORKFLOW_REGISTRY),
      jobs: listCronJobs()
    })
  })

  app.post('/api/control/cron/jobs', async (c) => {
    const body = await c.req.json().catch(() => ({}))
    const result = createCronJob({
      name: body.name,
      workflow: body.workflow,
      prompt: body.prompt,
      intervalMs: body.intervalMs,
      reviewMode: body.reviewMode
    })
    if (!result.ok) {
      return c.json({ ok: false, error: result.error, detail: result.detail }, 400)
    }
    return c.json({ ok: true, job: result.job })
  })

  app.post('/api/control/cron/jobs/:jobId/status', async (c) => {
    const { jobId } = c.req.param()
    const body = await c.req.json().catch(() => ({}))
    const action = String(body.action || '').trim()
    const result = setCronJobStatus(jobId, action)
    if (!result.ok) {
      if (result.error === 'cron_job_not_found') return c.json({ ok: false, error: result.error }, 404)
      return c.json({ ok: false, error: result.error, detail: result.detail }, 409)
    }
    return c.json({ ok: true, job: result.job })
  })

  app.delete('/api/control/cron/jobs/:jobId', (c) => {
    const { jobId } = c.req.param()
    const result = setCronJobStatus(jobId, 'delete')
    if (!result.ok) {
      return c.json({ ok: false, error: result.error }, result.error === 'cron_job_not_found' ? 404 : 409)
    }
    return c.json({ ok: true, jobId })
  })

  // 人工触发：守护台「立即触发」按钮与 S3-09 演练入口；与调度 tick 同一适配器，
  // 同样受白名单/状态/启动门禁/幂等约束，结果含 sessionId/taskId 可追溯
  app.post('/api/control/cron/jobs/:jobId/trigger', async (c) => {
    const { jobId } = c.req.param()
    const result = await triggerCronJob(jobId, buildTriggerDeps(), { manual: true })
    if (!result.ok) {
      if (result.error === 'cron_job_not_found') return c.json({ ok: false, error: result.error }, 404)
      return c.json({ ok: false, error: result.error, detail: result.detail }, 409)
    }
    return c.json({ ok: true, ...result })
  })
}
