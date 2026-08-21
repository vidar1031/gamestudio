import { enqueueHumanCorrectionProposal } from '../intents/proposals.js'
import { REASONING_SESSION_STATE, applySessionTransition } from '../reasoning/sessionStateMachine.js'
import { applyCheckpointToSession } from '../reasoning/stepCheckpoint.js'
import { evaluateOrphanRecovery, buildOrphanBlockedTransition } from '../reasoning/orphanRecovery.js'
import { isTerminalQueueItemState, evaluateProjectQuota } from '../reasoning/persistentQueue.js'
import { appendGovernanceAudit, readGovernanceAudit } from '../reasoning/governanceAudit.js'
import { evaluateRegistryTriggerGate } from '../reasoning/projectWorkflowRegistry.js'

// AUTO-D01：队列详情视图返回的最近事件条数上限（证据索引，不全量回吐）
const QUEUE_DETAIL_RECENT_EVENTS_LIMIT = 20
// HERMES-H01：队列详情 artifact 证据索引中最终回答的预览长度上限
const QUEUE_DETAIL_FINAL_ANSWER_PREVIEW_LIMIT = 240

/**
 * 受控重试核心（守护台人工重试按钮与 HERMES-H03 右脑子 agent 审核后执行共用）。
 * 仅 failed session 可重试；阻断原因全部透传在 body 中：
 * 非失败状态 / item 仍在调度 / runtime 未运行 / 左脑门禁未就绪。
 * 成功与阻断都写治理审计（action='retry'），可追溯 sessionId/taskId。
 * @param {object} context controlServerCore 路由上下文
 * @param {string} sessionId
 * @returns {{ httpStatus: number, body: object }}
 */
export function executeGovernedSessionRetry(context, sessionId) {
  const {
    appendReasoningEvent,
    buildReasoningStartBlocker,
    dispatchReasoningSession,
    getHermesControlState,
    getHermesRuntimeState,
    readQueueItem,
    readReasoningSession,
    resetQueueItemForManualRetry,
    updateReasoningSession
  } = context

  const session = readReasoningSession(sessionId)
  if (!session) {
    return { httpStatus: 404, body: { ok: false, error: 'reasoning_session_not_found' } }
  }

  // HERMES-H01：治理审计——重试动作的成功与阻断都留证（可追溯 sessionId/taskId）
  // AUTO-F01：审计记录补 projectId，保证可按项目对照
  const existingItem = readQueueItem(sessionId)
  const auditRetry = (result, detail) => appendGovernanceAudit({
    action: 'retry',
    sessionId,
    taskId: existingItem?.taskId || null,
    projectId: existingItem?.projectId || session.submissionContext?.projectId || null,
    result,
    detail
  })

  if (session.status !== REASONING_SESSION_STATE.FAILED) {
    auditRetry('blocked', `reasoning_session_not_retryable:${session.status}`)
    return {
      httpStatus: 409,
      body: {
        ok: false,
        error: 'reasoning_session_not_retryable',
        status: session.status,
        detail: '仅失败状态的任务支持人工重试；重试等待中的任务会按计划自动执行，异常中断的任务请使用恢复。'
      }
    }
  }

  // 冲突预检：item 仍在调度中（未终结）时拒绝人工重试，避免重复执行
  const item = existingItem
  if (item && !isTerminalQueueItemState(item.status)) {
    auditRetry('blocked', `queue_item_active:${item.status}`)
    return { httpStatus: 409, body: { ok: false, error: 'queue_item_active', status: item.status, detail: '该任务仍在队列调度中，不能人工重试。' } }
  }

  const runtimeStatus = getHermesRuntimeState()
  if (runtimeStatus.state !== 'running') {
    auditRetry('blocked', 'runtime_not_running')
    return { httpStatus: 409, body: { ok: false, error: 'runtime_not_running', runtimeStatus } }
  }

  const startBlocker = buildReasoningStartBlocker()
  if (startBlocker) {
    auditRetry('blocked', startBlocker.error || 'start_blocker')
    return { httpStatus: 409, body: { ok: false, ...startBlocker, runtimeStatus, controlState: getHermesControlState() } }
  }

  // 先转移 session（failed -> queued），再重置 item：
  // 反向顺序会让 worker tick 把 queued item 按 failed session 镜像终结
  let transitioned = false
  updateReasoningSession(sessionId, (current) => {
    if (current.status !== REASONING_SESSION_STATE.FAILED) return current // 并发推进不覆盖
    transitioned = true
    const next = applySessionTransition(current, REASONING_SESSION_STATE.QUEUED, '人工重试：重新排队执行')
    return { ...next, error: null }
  })
  if (!transitioned) {
    const latest = readReasoningSession(sessionId)
    auditRetry('blocked', `reasoning_session_not_retryable:${latest?.status || 'unknown'}`)
    return { httpStatus: 409, body: { ok: false, error: 'reasoning_session_not_retryable', status: latest?.status || null, detail: '任务状态已变化，请刷新后重试。' } }
  }

  if (item) {
    resetQueueItemForManualRetry(sessionId, { reason: 'manual_retry' })
  }
  appendReasoningEvent(sessionId, 'queue_manual_retry', '人工重试已受理', '任务已重新排队，将由调度器领取执行；历史重试记录保留。', {
    data: { taskId: item?.taskId || sessionId, projectId: item?.projectId || session.submissionContext?.projectId || null }
  })
  // dispatch 幂等：item 已重置时直接复用不重复入队；缺失时（历史 session）创建新 item；
  // 统一负责唤醒 worker
  dispatchReasoningSession(sessionId)
  auditRetry('ok', '任务已重新排队')

  return { httpStatus: 200, body: { ok: true, session: readReasoningSession(sessionId), item: readQueueItem(sessionId) } }
}

export function registerReasoningRoutes(app, context) {
  let activeProductionTestSession = null
  // AUTO-B03：恢复进行中的 sessionId 集合，保证重复恢复幂等安全（不重复触发执行）
  const orphanRecoveryInFlight = new Set()

  const {
    appendReasoningEvent,
    approveReasoningQualityOverride,
    applyPreparedLifecycleScript,
    applyPreparedWorkspaceOperation,
    applyPreparedReasoningWrite,
    buildHermesBinding,
    buildReasoningStartBlocker,
    cancelReasoningSession,
    clearReasoningReview,
    continueReasoningSessionFromStep,
    createReasoningSession,
    deleteReasoningSessionRecord,
    dispatchReasoningSession,
    getHermesRuntimeState,
    getHermesControlState,
    hermesAgentDefinition,
    listReasoningSessions,
    listQueueItems,
    readQueueItem,
    resetQueueItemForManualRetry,
    listStepCheckpoints,
    readLatestStepCheckpoint,
    markReasoningSessionFailed,
    persistHermesChatPrompt,
    persistHermesChatReply,
    persistReasoningReviewDecision,
    prepareReasoningSessionPlan,
    readHermesChatHistory,
    readReasoningSession,
    runAllReasoningStepsFrom,
    updateReasoningSession,
  } = context

  // 与状态机终态对齐（completed/blocked/cancelled/timeout）+ failed（重试耗尽后的最终态）
  const isTerminalSession = (session) => session?.status === 'completed' || session?.status === 'failed' || session?.status === 'cancelled' || session?.status === 'blocked' || session?.status === 'timeout'

  const getCurrentProductionTestSession = () => {
    if (!activeProductionTestSession?.sessionId) return null
    const session = readReasoningSession(activeProductionTestSession.sessionId)
    if (!session || isTerminalSession(session)) {
      activeProductionTestSession = null
      return null
    }
    return activeProductionTestSession
  }

  const enqueueHumanCorrectionIfUseful = (sessionId, decision, review, correctionPrompt) => {
    const correction = String(correctionPrompt || '').trim()
    if (!correction) return null
    const session = readReasoningSession(sessionId)
    if (!session) return null
    const result = enqueueHumanCorrectionProposal({
      sessionId,
      decision,
      userPrompt: session.userPrompt,
      correctionPrompt: correction,
      review,
      finalAnswer: session.artifacts?.finalAnswer || null
    })
    appendReasoningEvent(sessionId, 'review_correction_proposal', review.title || '人工修正', result.written.length > 0 ? '人工修正已整理为待审核强化提案。' : '人工修正已记录，未生成新的强化提案。', {
      stepId: review.stepId || undefined,
      data: {
        decision,
        targetType: review.targetType,
        reviewPhase: review.reviewPhase,
        written: result.written,
        skipped: result.skipped
      }
    })
    return result
  }

  const createRuntimeSession = async (c) => {
    const { agentId } = c.req.param()
    if (agentId !== hermesAgentDefinition.id) {
      return c.json({ ok: false, error: 'agent_not_found' }, 404)
    }

    const body = await c.req.json().catch(() => ({}))
    const userPrompt = String(body.prompt || '').trim()
    const parentSessionId = String(body.parentSessionId || '').trim()
    if (!userPrompt) {
      return c.json({ ok: false, error: 'prompt_required' }, 400)
    }

    // 会话恢复：用户输入"继续"时，恢复最近的未完成 session
    const isContinueRequest = /^继续|^接着|^继续创建|^恢复|^接着之前/i.test(userPrompt)
    if (isContinueRequest && !parentSessionId) {
      const activeSessions = listReasoningSessions({ limit: 10, includeTerminal: false })
      const resumable = activeSessions.find((s) => s.status === 'waiting_review' || s.status === 'running' || s.status === 'paused')
      if (resumable) {
        return c.json({
          ok: true,
          resumed: true,
          session: {
            sessionId: resumable.sessionId,
            status: resumable.status,
            currentStepId: resumable.currentStepId,
            title: resumable.title,
            userPrompt: resumable.userPrompt
          },
          message: `已恢复未完成任务：${resumable.title || resumable.userPrompt}（当前状态：${resumable.status}）`
        })
      }
      return c.json({
        ok: true,
        resumed: false,
        message: '没有正在进行的任务。请告诉我您要创建什么故事。'
      })
    }

    // 故事需求确认拦截：创建故事类请求先整理需求规格，用户确认后再执行
    const isStoryCreation = /创建.*故事|生成.*故事|AI.*创建.*故事/i.test(userPrompt)
    const skipRequirementConfirm = Boolean(body.skipRequirementConfirm || body.submissionContext?.skipRequirementConfirm)
    if (isStoryCreation && !skipRequirementConfirm) {
      const { compileStoryRequirement } = await import('../services/storyRequirementCompiler.js')
      const requirement = compileStoryRequirement(userPrompt)
      if (!requirement.complete) {
        // 有缺失字段：返回已提取信息 + 追问
        const extracted = []
        if (requirement.fields.title) extracted.push(`标题：${requirement.fields.title}`)
        if (requirement.fields.brief) extracted.push(`简介：${requirement.fields.brief}`)
        const lines = []
        if (extracted.length) {
          lines.push('已提取信息：')
          lines.push(...extracted)
          lines.push('')
        }
        lines.push('请补充以下信息：')
        lines.push(...requirement.missing.map((m) => m.question))
        return c.json({
          ok: true,
          requirementConfirm: true,
          requirement,
          message: lines.join('\n')
        })
      }
      // 字段完整：返回需求规格确认
      return c.json({
        ok: true,
        requirementConfirm: true,
        requirement,
        message: `请确认故事需求规格：\n${requirement.summary}\n\n确认后我将开始创建故事。`
      })
    }

    const productionTest = Boolean(body.productionTest || body.submissionContext?.productionTest)
    const requireModelAnswer = Boolean(body.requireModelAnswer || body.requireHermesModelAnswer || body.submissionContext?.requireModelAnswer || body.submissionContext?.requireHermesModelAnswer)

    // 系统级硬 gate：模型未就绪不得进行任何 story 生产工作，禁止 deterministic bypass
    const runtimeStatus = getHermesRuntimeState()
    if (runtimeStatus.state !== 'running') {
      return c.json({ ok: false, error: 'runtime_not_running', runtimeStatus }, 409)
    }

    const startBlocker = buildReasoningStartBlocker()
    if (startBlocker) {
      return c.json({ ok: false, ...startBlocker, runtimeStatus, controlState: getHermesControlState() }, 409)
    }

    if (parentSessionId && !readReasoningSession(parentSessionId)) {
      return c.json({ ok: false, error: 'parent_reasoning_session_not_found' }, 404)
    }

    // AUTO-F01：每项目在制配额前置校验——同 project 调度中任务达上限时同步拒绝（429），
    // 不创建 session；拒绝原因与用量证据（limit/activeCount/activeSessionIds）透传并留审计。
    // 子目标 session 属父任务图，不占独立项目配额（仍受同 project 串行约束）。
    const submitProjectId = String(body.projectId || body.submissionContext?.projectId || '').trim() || null
    if (submitProjectId && !parentSessionId) {
      const quota = evaluateProjectQuota({ projectId: submitProjectId })
      if (!quota.ok) {
        const detail = `projectId=${submitProjectId} 在制任务 ${quota.activeCount}/${quota.limit}（${quota.activeSessionIds.join(', ') || '-'}），超出每项目配额`
        appendGovernanceAudit({ action: 'session_submit', projectId: submitProjectId, result: 'blocked', detail: `project_quota_exceeded: ${detail}` })
        return c.json({
          ok: false,
          error: 'project_quota_exceeded',
          projectId: submitProjectId,
          limit: quota.limit,
          activeCount: quota.activeCount,
          activeSessionIds: quota.activeSessionIds,
          detail
        }, 429)
      }
    }

    // HERMES-H04：显式指定 workflow 的触发必须经过项目/workflow 注册表门禁——
    // workflow 已注册且启用、所属项目启用、projectId 归属合法（跨项目拒绝）、
    // 输入满足注册表声明的 inputSchema；未携带 workflow 的普通会话保持既有行为。
    const submitWorkflow = String(body.workflow || body.submissionContext?.workflow || '').trim()
    if (submitWorkflow) {
      const gate = evaluateRegistryTriggerGate({
        workflowId: submitWorkflow,
        projectId: submitProjectId,
        input: { prompt: userPrompt, ...(body.input && typeof body.input === 'object' && !Array.isArray(body.input) ? body.input : {}) }
      })
      if (!gate.ok) {
        appendGovernanceAudit({ action: 'session_submit', projectId: submitProjectId, result: 'blocked', detail: `registry_gate:${gate.error} workflow=${submitWorkflow} ${gate.detail || ''}` })
        return c.json({ ok: false, error: gate.error, detail: gate.detail, workflow: submitWorkflow }, 403)
      }
    }

    const disableQualityAutoRetry = body.disableQualityAutoRetry ?? body.submissionContext?.disableQualityAutoRetry

    // 用户确认后的需求规格：如果携带了确认的需求规格，使用它构建 story workflow
    const confirmedRequirement = body.requirement || body.submissionContext?.requirement
    const effectivePrompt = confirmedRequirement
      ? `创建故事：${confirmedRequirement.fields?.title || ''}。${confirmedRequirement.fields?.brief || ''}`
      : userPrompt

    const session = await createReasoningSession(agentId, effectivePrompt, {
      parentSessionId,
      reviewMode: String(body.reviewMode || body.submissionContext?.reviewMode || '').trim().toLowerCase() || 'manual',
      childGoals: body.childGoals,
      selectedSourceIds: body.selectedSourceIds,
      selectedContextPoolIds: body.selectedContextPoolIds,
      confirmedContextSummary: body.confirmedContextSummary,
      productionTest,
      requireModelAnswer,
      disableMemorySync: Boolean(body.disableMemorySync || body.submissionContext?.disableMemorySync),
      ...(disableQualityAutoRetry === undefined ? {} : { disableQualityAutoRetry: Boolean(disableQualityAutoRetry) }),
      stageId: String(body.stageId || body.submissionContext?.stageId || '').trim() || null,
      caseId: String(body.caseId || body.submissionContext?.caseId || '').trim() || null,
      // HERMES-H04：显式 workflow 归属透传（已过注册表门禁），供队列/审计对照
      ...(submitWorkflow ? { workflow: submitWorkflow } : {}),
      title: String(body.title || body.submissionContext?.title || confirmedRequirement?.fields?.title || '').trim() || effectivePrompt,
      // AUTO-C01：projectId 透传进 submissionContext，队列按它做同 project 串行
      projectId: String(body.projectId || body.submissionContext?.projectId || '').trim() || null,
      expectations: body.expectations && typeof body.expectations === 'object'
        ? body.expectations
        : (body.submissionContext?.expectations && typeof body.submissionContext.expectations === 'object' ? body.submissionContext.expectations : null),
      forceFreshRun: Boolean(body.forceFreshRun || body.submissionContext?.forceFreshRun),
      // 确认的需求规格透传
      confirmedRequirement: confirmedRequirement || null
    })
    persistHermesChatPrompt(session.sessionId, userPrompt)
    if (session.status === 'completed' && session.artifacts?.finalAnswer) {
      persistHermesChatReply(session.sessionId, session.artifacts.finalAnswer, session.artifacts.finalAnswerUsage || null)
    } else {
      // AUTO-C01：创建后先入队（queued），由持久化队列 worker 领取执行；
      // API 形状不变，调用方不感知
      dispatchReasoningSession(session.sessionId)
    }

    return c.json({
      ok: true,
      session: {
        sessionId: session.sessionId,
        runtimeSessionId: session.runtimeSessionId || session.sessionId,
        status: session.status,
        createdAt: session.createdAt,
        runtimeTaskGraph: session.runtimeTaskGraph || session.plan,
        plan: session.plan
      }
    })
  }

  app.post('/api/control/agents/:agentId/reasoning-sessions', createRuntimeSession)
  app.post('/api/control/agents/:agentId/agent-runtime-sessions', createRuntimeSession)

  app.get('/api/control/agents/:agentId/reasoning-sessions', async (c) => {
    const { agentId } = c.req.param()
    if (agentId !== hermesAgentDefinition.id) {
      return c.json({ ok: false, error: 'agent_not_found' }, 404)
    }
    const limit = Math.min(200, Math.max(1, parseInt(c.req.query('limit') || '50', 10)))
    const includeTerminal = c.req.query('includeTerminal') !== 'false'
    try {
      const sessions = listReasoningSessions({ limit, includeTerminal })
      return c.json({ ok: true, sessions, count: sessions.length })
    } catch (error) {
      return c.json({ ok: false, error: error instanceof Error ? error.message : String(error) }, 500)
    }
  })

  // ---------------------------------------------------------------------------
  // AUTO-D01：队列/task 只读运维视图 + 人工重试（受控）
  // 只读端点不改任何状态；人工重试是显式动作，与 C02 自动重试语义区分。
  // ---------------------------------------------------------------------------

  // 列表视图：queue item 摘要 join session 摘要（当前 step、状态原因、审核状态）
  const buildQueueItemSummaryView = (item) => {
    const session = readReasoningSession(item.sessionId)
    return {
      sessionId: item.sessionId,
      taskId: item.taskId,
      projectId: item.projectId || session?.submissionContext?.projectId || null,
      status: item.status,
      retryCount: Number(item.retryCount || 0),
      nextAttemptAt: item.nextAttemptAt || null,
      lastError: item.lastError || null,
      attempts: Number(item.attempts || 0),
      recoveryCount: Number(item.recoveryCount || 0),
      createdAt: item.createdAt || null,
      updatedAt: item.updatedAt || null,
      startedAt: item.startedAt || null,
      finishedAt: item.finishedAt || null,
      session: session
        ? {
            status: session.status,
            title: session.title || session.userPrompt || '',
            error: session.error || null,
            currentStepId: session.currentStepId || null,
            currentStepIndex: session.currentStepIndex ?? null,
            stepCount: Array.isArray(session.plan?.steps) ? session.plan.steps.length : 0,
            review: session.review
              ? { title: session.review.title || null, targetType: session.review.targetType || null, reviewPhase: session.review.reviewPhase || null }
              : null
          }
        : null
    }
  }

  app.get('/api/control/queue/items', (c) => {
    try {
      const { items, errors } = listQueueItems()
      const views = items.map((item) => buildQueueItemSummaryView(item))
      // 非终态在前（运维关注活跃任务），同组按 updatedAt 倒序
      views.sort((a, b) => {
        const terminalDiff = Number(isTerminalQueueItemState(a.status)) - Number(isTerminalQueueItemState(b.status))
        if (terminalDiff !== 0) return terminalDiff
        return String(b.updatedAt || '').localeCompare(String(a.updatedAt || ''))
      })
      return c.json({ ok: true, items: views, errors, count: views.length })
    } catch (error) {
      return c.json({ ok: false, error: error instanceof Error ? error.message : String(error) }, 500)
    }
  })

  // 详情视图：item 全量（含 retryHistory/history）+ session 切片 + 证据索引
  // （checkpoint 指针、重试计划镜像、最近事件），不猜测缺失 session 的内容
  app.get('/api/control/queue/items/:sessionId', (c) => {
    const { sessionId } = c.req.param()
    try {
      const item = readQueueItem(sessionId)
      if (!item) {
        return c.json({ ok: false, error: 'queue_item_not_found' }, 404)
      }
      const session = readReasoningSession(sessionId)
      const checkpoints = listStepCheckpoints(sessionId).map(({ file, stepIndex }) => ({ file, stepIndex }))
      const latestCheckpoint = readLatestStepCheckpoint(sessionId)
      const currentStepIndex = session?.currentStepIndex ?? null
      const currentStep = session && Number.isInteger(currentStepIndex) && Array.isArray(session.plan?.steps)
        ? session.plan.steps[currentStepIndex] || null
        : null
      const recentEvents = (Array.isArray(session?.events) ? session.events : [])
        .slice(-QUEUE_DETAIL_RECENT_EVENTS_LIMIT)
        .map((event) => ({
          type: event.type || null,
          title: event.title || null,
          summary: event.summary || null,
          timestamp: event.timestamp || null,
          stepId: event.stepId || null
        }))
      return c.json({
        ok: true,
        item,
        session: session
          ? {
              sessionId: session.sessionId,
              status: session.status,
              title: session.title || session.userPrompt || '',
              error: session.error || null,
              currentStepId: session.currentStepId || null,
              currentStepIndex,
              stepCount: Array.isArray(session.plan?.steps) ? session.plan.steps.length : 0,
              currentStep: currentStep
                ? { stepId: currentStep.stepId || null, title: currentStep.title || null, action: currentStep.action || null }
                : null,
              review: session.review
                ? { title: session.review.title || null, targetType: session.review.targetType || null, reviewPhase: session.review.reviewPhase || null }
                : null,
              projectId: session.submissionContext?.projectId || null
            }
          : null,
        evidence: {
          checkpoints,
          latestCheckpoint: latestCheckpoint
            ? { stepIndex: latestCheckpoint.stepIndex, nextStepIndex: latestCheckpoint.nextStepIndex, completedAt: latestCheckpoint.completedAt || null }
            : null,
          retryPolicy: session?.artifacts?.retryPolicy || null,
          // HERMES-H01：artifact 证据索引（只挑可追溯字段 + 最终回答预览，不全量回吐）
          artifacts: session
            ? {
                projectRoot: session.artifacts?.projectRoot || null,
                storyIndex: session.artifacts?.storyIndex ?? null,
                finalAnswerPreview: typeof session.artifacts?.finalAnswer === 'string'
                  ? session.artifacts.finalAnswer.slice(0, QUEUE_DETAIL_FINAL_ANSWER_PREVIEW_LIMIT)
                  : null
              }
            : null,
          recentEvents
        }
      })
    } catch (error) {
      return c.json({ ok: false, error: error instanceof Error ? error.message : String(error) }, 500)
    }
  })

  // ---------------------------------------------------------------------------
  // HERMES-H01：治理闭环只读视图
  // - 待审核中心：waiting_review session 集中呈现（散在聊天页的审核入口不变）；
  // - 操作审计：取消/恢复/重试/审核动作的跨任务索引（成功与阻断都留证）。
  // 只读端点不改任何状态。
  // ---------------------------------------------------------------------------

  // 待审核任务列表：session waiting_review + review 详情 + 队列 item 状态
  app.get('/api/control/reviews/pending', (c) => {
    try {
      const sessions = listReasoningSessions({ limit: 200, includeTerminal: true })
      const items = []
      for (const summary of sessions) {
        if (summary.status !== 'waiting_review') continue
        const session = readReasoningSession(summary.sessionId)
        if (!session || !session.review) continue
        const item = readQueueItem(summary.sessionId)
        items.push({
          sessionId: session.sessionId,
          title: session.title || session.userPrompt || '',
          status: session.status,
          updatedAt: session.updatedAt || summary.updatedAt || null,
          projectId: session.submissionContext?.projectId || item?.projectId || null,
          review: {
            title: session.review.title || null,
            summary: session.review.summary || null,
            targetType: session.review.targetType || null,
            reviewPhase: session.review.reviewPhase || null,
            stepId: session.review.stepId || null,
            stepIndex: session.review.stepIndex ?? null
          },
          queueItem: item ? { taskId: item.taskId || null, status: item.status || null } : null
        })
      }
      // 最近更新的在前（操作者先看到最新等待）
      items.sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')))
      return c.json({ ok: true, items, count: items.length })
    } catch (error) {
      return c.json({ ok: false, error: error instanceof Error ? error.message : String(error) }, 500)
    }
  })

  // 治理操作审计：跨任务的取消/恢复/重试/审核动作索引（新的在前）
  app.get('/api/control/governance/audit', (c) => {
    try {
      const limit = Math.max(1, Math.min(500, Number(c.req.query('limit') || 100)))
      const { records, skipped } = readGovernanceAudit(limit)
      return c.json({ ok: true, records, skipped, count: records.length })
    } catch (error) {
      return c.json({ ok: false, error: error instanceof Error ? error.message : String(error) }, 500)
    }
  })

  // 人工重试：仅 failed session 可重试（显式动作，与 C02 自动重试区分）。
  // 阻断原因全部透传：非失败状态 / item 仍在调度 / runtime 未运行 / 左脑门禁未就绪。
  const retryRuntimeSession = async (c) => {
    const { agentId, sessionId } = c.req.param()
    if (agentId !== hermesAgentDefinition.id) {
      return c.json({ ok: false, error: 'agent_not_found' }, 404)
    }
    const result = executeGovernedSessionRetry(context, sessionId)
    return c.json(result.body, result.httpStatus)
  }

  app.post('/api/control/agents/:agentId/reasoning-sessions/:sessionId/retry', retryRuntimeSession)
  app.post('/api/control/agents/:agentId/agent-runtime-sessions/:sessionId/retry', retryRuntimeSession)

  app.get('/api/control/agents/:agentId/production-test-session', (c) => {
    const { agentId } = c.req.param()
    if (agentId !== hermesAgentDefinition.id) {
      return c.json({ ok: false, error: 'agent_not_found' }, 404)
    }
    return c.json({ ok: true, activeSession: getCurrentProductionTestSession() })
  })

  app.post('/api/control/agents/:agentId/production-test-session', async (c) => {
    const { agentId } = c.req.param()
    if (agentId !== hermesAgentDefinition.id) {
      return c.json({ ok: false, error: 'agent_not_found' }, 404)
    }

    const body = await c.req.json().catch(() => ({}))
    const sessionId = String(body.sessionId || '').trim()
    if (!sessionId) {
      activeProductionTestSession = null
      return c.json({ ok: true, activeSession: null })
    }

    const session = readReasoningSession(sessionId)
    if (!session) {
      return c.json({ ok: false, error: 'reasoning_session_not_found' }, 404)
    }
    // 终态 session 同样允许登记为观察对象：快速完成的题（即时事实回答）与安全题（cancelled 即预期拒绝）
    // 需要在注册后被 runner 观察判定，409 会让这些案例无法收官
    const terminal = isTerminalSession(session)

    activeProductionTestSession = {
      sessionId,
      caseId: String(body.caseId || '').trim() || null,
      stageId: String(body.stageId || '').trim() || null,
      title: String(body.title || '').trim() || session.userPrompt || '',
      terminal,
      updatedAt: new Date().toISOString()
    }
    return c.json({ ok: true, activeSession: activeProductionTestSession })
  })

  const getRuntimeSession = async (c) => {
    const { agentId, sessionId } = c.req.param()
    if (agentId !== hermesAgentDefinition.id) {
      return c.json({ ok: false, error: 'agent_not_found' }, 404)
    }

    const session = readReasoningSession(sessionId)
    if (!session) {
      return c.json({ ok: false, error: 'reasoning_session_not_found' }, 404)
    }

    return c.json({ ok: true, session })
  }

  app.get('/api/control/agents/:agentId/reasoning-sessions/:sessionId', getRuntimeSession)
  app.get('/api/control/agents/:agentId/agent-runtime-sessions/:sessionId', getRuntimeSession)

  const deleteRuntimeSession = async (c) => {
    const { agentId, sessionId } = c.req.param()
    if (agentId !== hermesAgentDefinition.id) {
      return c.json({ ok: false, error: 'agent_not_found' }, 404)
    }

    try {
      const result = deleteReasoningSessionRecord(sessionId)
      return c.json({ ok: true, ...result })
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      if (detail === 'reasoning_session_not_found') {
        return c.json({ ok: false, error: detail }, 404)
      }
      if (detail === 'reasoning_session_not_terminal') {
        return c.json({ ok: false, error: detail }, 409)
      }
      return c.json({ ok: false, error: detail }, 500)
    }
  }

  app.delete('/api/control/agents/:agentId/reasoning-sessions/:sessionId', deleteRuntimeSession)
  app.delete('/api/control/agents/:agentId/agent-runtime-sessions/:sessionId', deleteRuntimeSession)

  const cancelRuntimeSession = async (c) => {
    const { agentId, sessionId } = c.req.param()
    if (agentId !== hermesAgentDefinition.id) {
      return c.json({ ok: false, error: 'agent_not_found' }, 404)
    }

    try {
      const session = cancelReasoningSession(sessionId)
      // HERMES-H01：治理审计——取消动作留证（终态幂等返回同样记录，与结果语义一致）
      // AUTO-F01：审计记录补 projectId，保证可按项目对照
      appendGovernanceAudit({
        action: 'cancel',
        sessionId,
        taskId: readQueueItem(sessionId)?.taskId || null,
        projectId: readQueueItem(sessionId)?.projectId || session?.submissionContext?.projectId || null,
        result: 'ok',
        detail: `session_status:${session?.status || 'unknown'}`
      })
      return c.json({ ok: true, session })
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      if (detail === 'reasoning_session_not_found') {
        return c.json({ ok: false, error: detail }, 404)
      }
      return c.json({ ok: false, error: detail }, 500)
    }
  }

  app.post('/api/control/agents/:agentId/reasoning-sessions/:sessionId/cancel', cancelRuntimeSession)
  app.post('/api/control/agents/:agentId/agent-runtime-sessions/:sessionId/cancel', cancelRuntimeSession)

  const recoverRuntimeSession = async (c) => {
    const { agentId, sessionId } = c.req.param()
    if (agentId !== hermesAgentDefinition.id) {
      return c.json({ ok: false, error: 'agent_not_found' }, 404)
    }

    const session = readReasoningSession(sessionId)
    if (!session) {
      return c.json({ ok: false, error: 'reasoning_session_not_found' }, 404)
    }

    // HERMES-H01：治理审计——恢复动作的成功与阻断都留证
    // AUTO-F01：审计记录补 projectId，保证可按项目对照
    const auditRecover = (result, detail) => appendGovernanceAudit({
      action: 'recover',
      sessionId,
      taskId: readQueueItem(sessionId)?.taskId || null,
      projectId: readQueueItem(sessionId)?.projectId || session.submissionContext?.projectId || null,
      result,
      detail
    })

    const body = await c.req.json().catch(() => ({}))

    // AUTO-B03：重复恢复幂等安全——恢复进行中的 session 直接返回当前状态，不重复触发执行。
    if (orphanRecoveryInFlight.has(sessionId)) {
      auditRecover('ok', '恢复已在进行中（幂等返回）')
      return c.json({ ok: true, idempotent: true, session: readReasoningSession(sessionId), detail: '恢复已在进行中，未重复触发。' })
    }

    // AUTO-B03：仅 orphaned 状态可经本路由恢复；
    // 旧的「failed + orphaned by server restart」语义已由 orphaned 状态替代，不再支持。
    if (session.status !== REASONING_SESSION_STATE.ORPHANED) {
      auditRecover('blocked', `reasoning_session_not_recoverable:${session.status}`)
      return c.json({ ok: false, error: 'reasoning_session_not_recoverable', status: session.status, detail: session.error || null }, 409)
    }

    // AUTO-B03：恢复资格判定——checkpoint 缺失/损坏/恢复次数超限一律转 blocked，不猜测继续。
    const qualification = evaluateOrphanRecovery(session)
    if (!qualification.recoverable) {
      updateReasoningSession(sessionId, (current) => buildOrphanBlockedTransition(current, qualification))
      appendReasoningEvent(sessionId, 'session_orphan_blocked', 'orphan 不可恢复，已阻断', qualification.detail, {
        data: { reason: qualification.reason }
      })
      auditRecover('blocked', `reasoning_session_not_recoverable:${qualification.reason}`)
      return c.json({ ok: false, error: 'reasoning_session_not_recoverable', reason: qualification.reason, detail: qualification.detail, session: readReasoningSession(sessionId) }, 409)
    }

    const runtimeStatus = getHermesRuntimeState()
    if (runtimeStatus.state !== 'running') {
      auditRecover('blocked', 'runtime_not_running')
      return c.json({ ok: false, error: 'runtime_not_running', runtimeStatus }, 409)
    }

    const startBlocker = buildReasoningStartBlocker()
    if (startBlocker) {
      auditRecover('blocked', startBlocker.error || 'start_blocker')
      return c.json({ ok: false, ...startBlocker, runtimeStatus, controlState: getHermesControlState() }, 409)
    }

    // AUTO-B03：证据完整的 orphan 仅从 checkpoint 的 nextStepIndex 恢复，已成功 step 不重跑；
    // 客户端不得指定其他 stepIndex 越过或回退 checkpoint。
    const stepIndex = qualification.nextStepIndex
    const requestedStepIndex = Number(body.stepIndex)
    if (body.stepIndex !== undefined && body.stepIndex !== null && body.stepIndex !== ''
      && (!Number.isInteger(requestedStepIndex) || requestedStepIndex !== stepIndex)) {
      auditRecover('blocked', 'step_index_not_allowed')
      return c.json({ ok: false, error: 'step_index_not_allowed', detail: `orphan 恢复只能从 checkpoint 的 nextStepIndex=${stepIndex} 继续，已成功 step 不重跑。`, nextStepIndex: stepIndex }, 409)
    }
    const correctionPrompt = String(body.correctionPrompt || '').trim()
    const binding = buildHermesBinding()
    const history = readHermesChatHistory({ includeAllSessions: true })

    orphanRecoveryInFlight.add(sessionId)
    try {
      clearReasoningReview(sessionId)
      updateReasoningSession(sessionId, (current) => {
        const recovered = applyCheckpointToSession(current, qualification.checkpoint)
        return {
          ...recovered,
          error: null,
          artifacts: {
            ...recovered.artifacts,
            recoveredFromOrphanAt: new Date().toISOString(),
            recoveredFromOrphanReason: current.artifacts?.orphanReason || null
          }
        }
      })
      appendReasoningEvent(sessionId, 'session_recovered', '恢复孤儿任务', `orphan session 已从 checkpoint 的 nextStepIndex=${stepIndex} 继续，已成功 step 不重跑。`, {
        data: { stepIndex, checkpointStepIndex: qualification.checkpointStepIndex, correctionPrompt: correctionPrompt || null }
      })

      void runAllReasoningStepsFrom(sessionId, binding, history, stepIndex, { correctionPrompt })
        .catch((error) => {
          markReasoningSessionFailed(sessionId, error)
        })
        .finally(() => {
          orphanRecoveryInFlight.delete(sessionId)
        })
    } catch (error) {
      orphanRecoveryInFlight.delete(sessionId)
      throw error
    }

    auditRecover('ok', `已从断点恢复（nextStepIndex=${stepIndex}）`)
    return c.json({ ok: true, session: readReasoningSession(sessionId), stepIndex })
  }

  app.post('/api/control/agents/:agentId/reasoning-sessions/:sessionId/recover', recoverRuntimeSession)
  app.post('/api/control/agents/:agentId/agent-runtime-sessions/:sessionId/recover', recoverRuntimeSession)

  const reviewRuntimeSession = async (c) => {
    const { agentId, sessionId } = c.req.param()
    if (agentId !== hermesAgentDefinition.id) {
      return c.json({ ok: false, error: 'agent_not_found' }, 404)
    }

    const session = readReasoningSession(sessionId)
    if (!session) {
      return c.json({ ok: false, error: 'reasoning_session_not_found' }, 404)
    }

    // HERMES-H01：治理审计——审核动作的成功与阻断都留证（decision 可追溯）
    // AUTO-F01：审计记录补 projectId，保证可按项目对照
    const auditReview = (result, detail, decision) => appendGovernanceAudit({
      action: 'review',
      sessionId,
      taskId: readQueueItem(sessionId)?.taskId || null,
      projectId: readQueueItem(sessionId)?.projectId || session.submissionContext?.projectId || null,
      result,
      detail,
      decision
    })

    if (session.status !== 'waiting_review' || !session.review) {
      auditReview('blocked', `reasoning_session_not_waiting_review:${session.status}`)
      return c.json({ ok: false, error: 'reasoning_session_not_waiting_review' }, 409)
    }

    const body = await c.req.json().catch(() => ({}))
    const decision = String(body.decision || '').trim().toLowerCase()
    const correctionPrompt = String(body.correctionPrompt || '').trim()
    if (decision !== 'approve' && decision !== 'reject' && decision !== 'back') {
      return c.json({ ok: false, error: 'review_decision_invalid' }, 400)
    }

    const binding = buildHermesBinding()
    const history = readHermesChatHistory({ includeAllSessions: true })
    const review = session.review
    enqueueHumanCorrectionIfUseful(sessionId, decision, review, correctionPrompt)

    if (decision === 'approve') {
      if (review.targetType === 'answer' && review.reviewPhase === 'quality_override') {
        clearReasoningReview(sessionId)
        persistReasoningReviewDecision(sessionId, 'approve', review, correctionPrompt)
        const finalizedSession = await approveReasoningQualityOverride(sessionId, binding, review, correctionPrompt)
        auditReview('ok', '最终答案人工确认通过', 'approve')
        return c.json({ ok: true, session: finalizedSession })
      }

      if (review.reviewPhase === 'before_execution' && review.stepId) {
        updateReasoningSession(sessionId, (current) => ({
          ...current,
          artifacts: {
            ...current.artifacts,
            approvedStepRuns: {
              ...(current.artifacts?.approvedStepRuns || {}),
              [review.stepId]: true
            }
          }
        }))
      }

      if (review.requiresApplyOnApprove && review.stepId) {
        if (review.action === 'run_lifecycle_script' || review.action === 'run_workspace_script') {
          const preparedScript = applyPreparedLifecycleScript(sessionId, review.stepId)
          appendReasoningEvent(sessionId, 'tool_result', review.title, `脚本 ${preparedScript.scriptName} 已执行，退出码 ${preparedScript.exitCode}，输出 ${preparedScript.output.length} 字符`, {
            stepId: review.stepId || undefined,
            data: {
              targetType: review.targetType,
              stepIndex: review.stepIndex ?? null,
              scriptName: preparedScript.scriptName,
              scriptPath: preparedScript.scriptPath,
              exitCode: preparedScript.exitCode,
              observableOps: [`run ${preparedScript.scriptPath}`]
            }
          })
          appendReasoningEvent(sessionId, 'step_completed', review.title, '审核通过后已完成命令执行', {
            stepId: review.stepId || undefined,
            data: {
              targetType: review.targetType,
              stepIndex: review.stepIndex ?? null
            }
          })
        } else if (review.action === 'rename_workspace_path' || review.action === 'delete_workspace_path') {
          const preparedOp = applyPreparedWorkspaceOperation(sessionId, review.stepId)
          const summary = preparedOp.opType === 'rename'
            ? `已重命名 ${preparedOp.fromPath} -> ${preparedOp.toPath}`
            : `已删除 ${preparedOp.targetPath}`
          appendReasoningEvent(sessionId, 'tool_result', review.title, summary, {
            stepId: review.stepId || undefined,
            data: {
              targetType: review.targetType,
              stepIndex: review.stepIndex ?? null,
              opType: preparedOp.opType,
              fromPath: preparedOp.fromPath,
              toPath: preparedOp.toPath,
              targetPath: preparedOp.targetPath,
              observableOps: preparedOp.opType === 'rename'
                ? [`rename ${preparedOp.fromPath} -> ${preparedOp.toPath}`]
                : [`delete ${preparedOp.targetPath}`]
            }
          })
          appendReasoningEvent(sessionId, 'step_completed', review.title, '审核通过后已完成路径操作', {
            stepId: review.stepId || undefined,
            data: {
              targetType: review.targetType,
              stepIndex: review.stepIndex ?? null
            }
          })
        } else {
          const preparedWrite = applyPreparedReasoningWrite(sessionId, review.stepId)
          appendReasoningEvent(sessionId, 'tool_result', review.title, `已写入 ${preparedWrite.filePath}（${preparedWrite.updatedContent.length} 字符）`, {
            stepId: review.stepId || undefined,
            data: {
              targetType: review.targetType,
              stepIndex: review.stepIndex ?? null,
              filePath: preparedWrite.filePath,
              chars: preparedWrite.updatedContent.length,
              observableOps: [`write ${preparedWrite.filePath}`]
            }
          })
          appendReasoningEvent(sessionId, 'step_completed', review.title, '审核通过后已完成写入', {
            stepId: review.stepId || undefined,
            data: {
              targetType: review.targetType,
              stepIndex: review.stepIndex ?? null
            }
          })
        }
      }

      if (review.targetType === 'answer' && review.stepId) {
        appendReasoningEvent(sessionId, 'step_completed', review.title, '最终回答审核通过', {
          stepId: review.stepId,
          data: {
            targetType: review.targetType,
            stepIndex: review.stepIndex ?? null
          }
        })
        appendReasoningEvent(sessionId, 'final_answer_ready', '最终回答', '最终回答已通过人工审核', {
          stepId: review.stepId,
          data: {
            targetType: review.targetType,
            stepIndex: review.stepIndex ?? null,
            finalAnswer: readReasoningSession(sessionId)?.artifacts?.finalAnswer || ''
          }
        })
      }

      persistReasoningReviewDecision(sessionId, 'approve', review, correctionPrompt)
      appendReasoningEvent(sessionId, 'review_approved', review.title, correctionPrompt ? '用户已确认，并提供后续修正条件。' : '用户已确认，继续执行。', {
        stepId: review.stepId || undefined,
        data: { targetType: review.targetType, stepIndex: review.stepIndex ?? null, correctionPrompt: correctionPrompt || null }
      })
      clearReasoningReview(sessionId)
      const approvedStepIndex = Number.isInteger(review.stepIndex) ? review.stepIndex : -1
      const nextStepIndex = review.targetType === 'plan' || review.targetType === 'runtime_task_graph'
        ? Number(session.artifacts?.nextStepIndex || 0)
        : review.reviewPhase === 'before_execution'
          ? approvedStepIndex
        : approvedStepIndex + 1
      updateReasoningSession(sessionId, (current) => ({
        ...current,
        artifacts: { ...current.artifacts, nextStepIndex }
      }))
      void runAllReasoningStepsFrom(sessionId, binding, history, nextStepIndex, {
        correctionPrompt: correctionPrompt || review.correctionPrompt || ''
      })
      auditReview('ok', correctionPrompt ? '审核通过（含修正意见）' : '审核通过', 'approve')
      return c.json({ ok: true, session: readReasoningSession(sessionId) })
    }

    if (decision === 'back') {
      if (!Number.isInteger(review.stepIndex) || Number(review.stepIndex) <= 0) {
        auditReview('blocked', 'reasoning_review_back_unavailable', 'back')
        return c.json({ ok: false, error: 'reasoning_review_back_unavailable' }, 409)
      }

      const previousStepIndex = Math.max(0, Number(review.stepIndex) - 1)
      persistReasoningReviewDecision(sessionId, 'back', review, correctionPrompt)
      appendReasoningEvent(sessionId, 'review_backtracked', review.title, correctionPrompt || '用户选择后退一步，从前一个步骤重新进入执行链。', {
        stepId: review.stepId || undefined,
        data: {
          targetType: review.targetType,
          stepIndex: review.stepIndex ?? null,
          previousStepIndex,
          correctionPrompt: correctionPrompt || null
        }
      })

      clearReasoningReview(sessionId)
      updateReasoningSession(sessionId, (current) => ({
        ...current,
        artifacts: {
          ...current.artifacts,
          nextStepIndex: previousStepIndex
        }
      }))

      void continueReasoningSessionFromStep(sessionId, binding, history, {
        stepIndex: previousStepIndex,
        correctionPrompt
      })

      auditReview('ok', `后退到第 ${previousStepIndex + 1} 步重新执行`, 'back')
      return c.json({ ok: true, session: readReasoningSession(sessionId) })
    }

    persistReasoningReviewDecision(sessionId, 'reject', review, correctionPrompt)
    appendReasoningEvent(sessionId, 'review_rejected', review.title, correctionPrompt || (review.reviewPhase === 'quality_override' ? '当前最终答案未通过人工确认，本轮结束，不自动重跑。' : '当前结果未通过审核，按修正条件重新执行。'), {
      stepId: review.stepId || undefined,
      data: {
        targetType: review.targetType,
        stepIndex: review.stepIndex ?? null,
        correctionPrompt: correctionPrompt || null
      }
    })

    clearReasoningReview(sessionId)

    if (review.reviewPhase === 'quality_override') {
      updateReasoningSession(sessionId, (current) => ({
        ...current,
        status: 'failed',
        currentStepId: null,
        error: 'quality_override_rejected',
        artifacts: {
          ...current.artifacts,
          qualityOverrideRejectedAt: new Date().toISOString(),
          qualityOverrideCorrectionPrompt: correctionPrompt || null
        }
      }))
      appendReasoningEvent(sessionId, 'quality_gate_rejected', '最终答案人工驳回', '一轮制质检已结束；系统不会自动重新规划或重新执行。', {
        data: {
          targetType: review.targetType,
          reviewPhase: review.reviewPhase,
          correctionPrompt: correctionPrompt || null
        }
      })
      auditReview('ok', '最终答案未通过人工确认，本轮结束', 'reject')
      return c.json({ ok: true, session: readReasoningSession(sessionId) })
    }

    if (review.targetType === 'plan' || review.targetType === 'runtime_task_graph' || review.reviewPhase === 'before_execution') {
      void prepareReasoningSessionPlan(sessionId, binding, history, { correctionPrompt }).catch((error) => {
        markReasoningSessionFailed(sessionId, error)
      })
    } else {
      void continueReasoningSessionFromStep(sessionId, binding, history, {
        stepIndex: Number(review.stepIndex || 0),
        correctionPrompt
      })
    }

    auditReview('ok', correctionPrompt ? '审核拒绝，按修正意见重新执行' : '审核拒绝', 'reject')
    return c.json({ ok: true, session: readReasoningSession(sessionId) })
  }

  app.post('/api/control/agents/:agentId/reasoning-sessions/:sessionId/review', reviewRuntimeSession)
  app.post('/api/control/agents/:agentId/agent-runtime-sessions/:sessionId/review', reviewRuntimeSession)
}
