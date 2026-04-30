export function registerReasoningRoutes(app, context) {
  let activeProductionTestSession = null

  const {
    appendReasoningEvent,
    approveReasoningQualityOverride,
    applyPreparedLifecycleScript,
    applyPreparedWorkspaceOperation,
    applyPreparedReasoningWrite,
    buildHermesBinding,
    cancelReasoningSession,
    clearReasoningReview,
    continueReasoningSessionFromStep,
    createReasoningSession,
    deleteReasoningSessionRecord,
    getHermesRuntimeState,
    hermesAgentDefinition,
    markReasoningSessionFailed,
    persistHermesChatPrompt,
    persistHermesChatReply,
    persistReasoningReviewDecision,
    prepareReasoningSessionPlan,
    readHermesChatHistory,
    readReasoningSession,
    runAllReasoningStepsFrom,
    runReasoningSession,
    updateReasoningSession,
  } = context

  const isTerminalSession = (session) => session?.status === 'completed' || session?.status === 'failed' || session?.status === 'cancelled'

  const getCurrentProductionTestSession = () => {
    if (!activeProductionTestSession?.sessionId) return null
    const session = readReasoningSession(activeProductionTestSession.sessionId)
    if (!session || isTerminalSession(session)) {
      activeProductionTestSession = null
      return null
    }
    return activeProductionTestSession
  }

  const createRuntimeSession = async (c) => {
    const { agentId } = c.req.param()
    if (agentId !== hermesAgentDefinition.id) {
      return c.json({ ok: false, error: 'agent_not_found' }, 404)
    }

    const runtimeStatus = getHermesRuntimeState()
    if (runtimeStatus.state !== 'running') {
      return c.json({ ok: false, error: 'runtime_not_running', runtimeStatus }, 409)
    }

    const body = await c.req.json().catch(() => ({}))
    const userPrompt = String(body.prompt || '').trim()
    const parentSessionId = String(body.parentSessionId || '').trim()
    if (!userPrompt) {
      return c.json({ ok: false, error: 'prompt_required' }, 400)
    }
    if (parentSessionId && !readReasoningSession(parentSessionId)) {
      return c.json({ ok: false, error: 'parent_reasoning_session_not_found' }, 404)
    }

    const binding = buildHermesBinding()
    const history = readHermesChatHistory({ includeAllSessions: true })
    const session = await createReasoningSession(agentId, userPrompt, {
      parentSessionId,
      childGoals: body.childGoals,
      selectedSourceIds: body.selectedSourceIds,
      selectedContextPoolIds: body.selectedContextPoolIds,
      confirmedContextSummary: body.confirmedContextSummary,
      productionTest: Boolean(body.productionTest || body.submissionContext?.productionTest),
      disableMemorySync: Boolean(body.disableMemorySync || body.submissionContext?.disableMemorySync),
      disableQualityAutoRetry: Boolean(body.disableQualityAutoRetry || body.submissionContext?.disableQualityAutoRetry),
      stageId: String(body.stageId || body.submissionContext?.stageId || '').trim() || null,
      caseId: String(body.caseId || body.submissionContext?.caseId || '').trim() || null,
      title: String(body.title || body.submissionContext?.title || '').trim() || userPrompt,
      forceFreshRun: Boolean(body.forceFreshRun || body.submissionContext?.forceFreshRun)
    })
    persistHermesChatPrompt(session.sessionId, userPrompt)
    if (session.status === 'completed' && session.artifacts?.finalAnswer) {
      persistHermesChatReply(session.sessionId, session.artifacts.finalAnswer, session.artifacts.finalAnswerUsage || null)
    } else {
      void runReasoningSession(session.sessionId, binding, history).catch((error) => {
        markReasoningSessionFailed(session.sessionId, error)
      })
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
    if (isTerminalSession(session)) {
      activeProductionTestSession = null
      return c.json({ ok: false, error: 'production_test_session_terminal' }, 409)
    }

    activeProductionTestSession = {
      sessionId,
      caseId: String(body.caseId || '').trim() || null,
      stageId: String(body.stageId || '').trim() || null,
      title: String(body.title || '').trim() || session.userPrompt || '',
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

  const reviewRuntimeSession = async (c) => {
    const { agentId, sessionId } = c.req.param()
    if (agentId !== hermesAgentDefinition.id) {
      return c.json({ ok: false, error: 'agent_not_found' }, 404)
    }

    const session = readReasoningSession(sessionId)
    if (!session) {
      return c.json({ ok: false, error: 'reasoning_session_not_found' }, 404)
    }

    if (session.status !== 'waiting_review' || !session.review) {
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

    if (decision === 'approve') {
      if (review.targetType === 'answer' && review.reviewPhase === 'quality_override') {
        clearReasoningReview(sessionId)
        persistReasoningReviewDecision(sessionId, 'approve', review, correctionPrompt)
        const finalizedSession = await approveReasoningQualityOverride(sessionId, binding, review, correctionPrompt)
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

      persistReasoningReviewDecision(sessionId, 'approve', review)
      appendReasoningEvent(sessionId, 'review_approved', review.title, '用户已确认，继续执行。', {
        stepId: review.stepId || undefined,
        data: { targetType: review.targetType, stepIndex: review.stepIndex ?? null }
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
        correctionPrompt: review.correctionPrompt || ''
      })
      return c.json({ ok: true, session: readReasoningSession(sessionId) })
    }

    if (decision === 'back') {
      if (!Number.isInteger(review.stepIndex) || Number(review.stepIndex) <= 0) {
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

    return c.json({ ok: true, session: readReasoningSession(sessionId) })
  }

  app.post('/api/control/agents/:agentId/reasoning-sessions/:sessionId/review', reviewRuntimeSession)
  app.post('/api/control/agents/:agentId/agent-runtime-sessions/:sessionId/review', reviewRuntimeSession)
}
