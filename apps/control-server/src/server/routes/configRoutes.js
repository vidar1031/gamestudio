function buildTextPreview(content, mode = 'head', maxChars = 220) {
  const text = String(content || '')
  const normalized = text.replace(/\s+/g, ' ').trim()
  if (!normalized) return ''
  if (normalized.length <= maxChars) return normalized
  return mode === 'tail'
    ? `...${normalized.slice(Math.max(0, normalized.length - maxChars))}`
    : `${normalized.slice(0, maxChars)}...`
}

function countNonEmptyLines(content) {
  return String(content || '').split(/\r?\n/).filter((line) => line.trim().length > 0).length
}

function ensureParentDirectory(fs, path, filePath) {
  const directory = path.dirname(String(filePath || '').trim())
  if (directory && !fs.existsSync(directory)) {
    fs.mkdirSync(directory, { recursive: true })
  }
}

function getTodayDailyLogPath(memoryConfig, fs, path) {
  const dailyLogDir = String(memoryConfig?.dailyLogDir || '').trim()
  if (!dailyLogDir) return ''
  if (!fs.existsSync(dailyLogDir)) {
    fs.mkdirSync(dailyLogDir, { recursive: true })
  }
  return path.join(dailyLogDir, `${new Date().toISOString().slice(0, 10)}.md`)
}

function listDailyLogFiles(memoryConfig, fs, path) {
  const dailyLogDir = String(memoryConfig?.dailyLogDir || '').trim()
  if (!dailyLogDir || !fs.existsSync(dailyLogDir)) return []
  return fs.readdirSync(dailyLogDir)
    .map((name) => path.join(dailyLogDir, name))
    .filter((filePath) => {
      try {
        return fs.statSync(filePath).isFile()
      } catch {
        return false
      }
    })
    .sort((left, right) => {
      try {
        return fs.statSync(right).mtimeMs - fs.statSync(left).mtimeMs
      } catch {
        return 0
      }
    })
}

function buildMemoryRecord(readUtf8FileRecord, options) {
  const file = readUtf8FileRecord(options.filePath)
  const previewSource = typeof options.previewContent === 'string' ? options.previewContent : file.content
  return {
    key: options.key,
    label: options.label,
    scope: options.scope,
    kind: options.kind || 'file',
    filePath: file.filePath,
    exists: file.exists,
    sizeChars: file.sizeChars,
    updatedAt: file.updatedAt,
    lineCount: countNonEmptyLines(file.content),
    preview: buildTextPreview(previewSource, options.previewMode || 'head'),
    empty: !file.exists || file.sizeChars === 0 || countNonEmptyLines(file.content) === 0,
    itemCount: Number.isFinite(Number(options.itemCount)) ? Number(options.itemCount) : null,
    canOpen: true
  }
}

function buildMemoryRecordsPayload(context, binding) {
  const {
    fs,
    path,
    HERMES_RUNTIME_LOG_FILE,
    getHermesChatFileRecord,
    listContextPoolEntries,
    readUtf8FileRecord,
  } = context
  const memoryConfig = binding.memory
  const dailyLogFiles = listDailyLogFiles(memoryConfig, fs, path)
  const todayDailyLogFile = getTodayDailyLogPath(memoryConfig, fs, path)
  const contextPoolEntries = listContextPoolEntries()

  const records = [
    buildMemoryRecord(readUtf8FileRecord, {
      key: 'chat-history',
      label: '会话缓冲记录',
      scope: 'short-term',
      filePath: getHermesChatFileRecord({ includeContent: true }).filePath,
      previewContent: getHermesChatFileRecord({ includeContent: true }).content,
      itemCount: (() => {
        try {
          const parsed = JSON.parse(getHermesChatFileRecord({ includeContent: true }).content || '[]')
          return Array.isArray(parsed) ? parsed.length : 0
        } catch {
          return 0
        }
      })()
    }),
    buildMemoryRecord(readUtf8FileRecord, {
      key: 'runtime-log',
      label: 'Hermes 运行日志',
      scope: 'short-term',
      filePath: HERMES_RUNTIME_LOG_FILE,
      previewMode: 'tail'
    }),
    buildMemoryRecord(readUtf8FileRecord, {
      key: 'daily-log',
      label: '当日日志',
      scope: 'short-term',
      filePath: todayDailyLogFile,
      previewMode: 'tail',
      itemCount: dailyLogFiles.length
    }),
    buildMemoryRecord(readUtf8FileRecord, {
      key: 'agent-definition',
      label: 'Agent 定义',
      scope: 'long-term',
      filePath: memoryConfig.agentDefinitionFile
    }),
    buildMemoryRecord(readUtf8FileRecord, {
      key: 'user-memory',
      label: '用户长期记忆',
      scope: 'long-term',
      filePath: memoryConfig.userFile
    }),
    buildMemoryRecord(readUtf8FileRecord, {
      key: 'project-memory',
      label: '项目长期记忆',
      scope: 'long-term',
      filePath: memoryConfig.memoryFile
    }),
      buildMemoryRecord(readUtf8FileRecord, {
        key: 'long-tasks',
        label: '长任务主线',
        scope: 'long-term',
        filePath: memoryConfig.longTasksFile
      }),
    buildMemoryRecord(readUtf8FileRecord, {
      key: 'project-status',
      label: '项目状态记录',
      scope: 'long-term',
      filePath: memoryConfig.statusFile
    }),
    buildMemoryRecord(readUtf8FileRecord, {
      key: 'task-queue',
      label: '任务队列记录',
      scope: 'long-term',
      filePath: memoryConfig.taskQueueFile
    }),
    buildMemoryRecord(readUtf8FileRecord, {
      key: 'decisions',
      label: '决策记录',
      scope: 'long-term',
      filePath: memoryConfig.decisionsFile
    }),
    ...contextPoolEntries.map((entry) => buildMemoryRecord(readUtf8FileRecord, {
      key: `context-pool:${entry.entryId}`,
      label: entry.title || entry.entryId,
      scope: 'context-pool',
      kind: 'context-pool-entry',
      filePath: entry.filePath,
      previewContent: entry.summary,
    }))
  ]

  return {
    records,
    clearTargets: [
      { value: 'chat-history', label: '清空缓冲记录', description: '重置 Hermes 聊天缓冲 JSON。' },
      { value: 'context-pool', label: '清空上下文记忆', description: '删除全部已确认上下文池条目。' },
      { value: 'long-term-memory', label: '清空长期记忆', description: '重置用户长期记忆与项目长期记忆文件。' },
      { value: 'state-records', label: '清空状态/任务/决策', description: '重置状态、任务队列和决策记录。' },
      { value: 'logs', label: '清空日志', description: '清空 Hermes 运行日志和项目日志目录。' },
      { value: 'all-test-records', label: '清空全部测试记录', description: '一次性重置缓冲、上下文池、长期记忆、状态记录和日志。' }
    ]
  }
}

function resolveMemoryRecordPath(context, binding, recordKey) {
  const { HERMES_RUNTIME_LOG_FILE, getHermesChatFilePath, listContextPoolEntries, path, fs } = context
  const memoryConfig = binding.memory
  const normalizedKey = String(recordKey || '').trim()
  if (!normalizedKey) {
    throw new Error('memory_record_key_required')
  }
  if (normalizedKey === 'chat-history') return getHermesChatFilePath()
  if (normalizedKey === 'runtime-log') return HERMES_RUNTIME_LOG_FILE
  if (normalizedKey === 'daily-log') return getTodayDailyLogPath(memoryConfig, fs, path)
  if (normalizedKey === 'agent-definition') return memoryConfig.agentDefinitionFile
  if (normalizedKey === 'user-memory') return memoryConfig.userFile
  if (normalizedKey === 'project-memory') return memoryConfig.memoryFile
  if (normalizedKey === 'long-tasks') return memoryConfig.longTasksFile
  if (normalizedKey === 'project-status') return memoryConfig.statusFile
  if (normalizedKey === 'task-queue') return memoryConfig.taskQueueFile
  if (normalizedKey === 'decisions') return memoryConfig.decisionsFile
  if (normalizedKey.startsWith('context-pool:')) {
    const entryId = normalizedKey.slice('context-pool:'.length)
    const entry = listContextPoolEntries().find((item) => item.entryId === entryId)
    if (!entry) throw new Error('context_pool_entry_not_found')
    return entry.filePath
  }
  throw new Error('memory_record_not_found')
}

function resetFile(fs, path, filePath, content) {
  ensureParentDirectory(fs, path, filePath)
  fs.writeFileSync(filePath, String(content ?? ''), 'utf8')
}

export function registerConfigRoutes(app, context) {
  const {
    HERMES_RUNTIME_LOG_FILE,
    appendHermesLog,
    buildConfigValidation,
    buildHermesBinding,
    buildHermesBindingFromConfig,
    buildHermesPreflight,
    buildModelStateSnapshot,
    buildAgentRuntimeBehaviorChecks,
    buildAgentRuntimeDescriptor,
    buildReasoningActionCatalog,
    buildReasoningToolCatalog,
    buildReasoningCapabilityGuide,
    getHermesControlConfigFingerprint,
    getPersistedHermesControlConfig,
    getHermesChatFilePath,
    getHermesChatFileRecord,
    hermesAgentDefinition,
    listContextPoolEntries,
    mergeHermesControlConfig,
    openFileInEditor,
    path,
    readUtf8FileRecord,
    refreshHermesControlStateFromConfig,
    setHermesControlConfig,
    updateHermesControlState,
    writeHermesChatHistory,
    writeUtf8FileRecord,
  } = context

  app.get('/api/control/agents/:agentId/config', async (c) => {
    const { agentId } = c.req.param()
    if (agentId !== hermesAgentDefinition.id) {
      return c.json({ ok: false, error: 'agent_not_found' }, 404)
    }
    const config = getPersistedHermesControlConfig()
    const controlState = await refreshHermesControlStateFromConfig(config)
    const defaultBinding = buildHermesBinding()
    const readiness = buildConfigValidation(config, defaultBinding)
    return c.json({
      ok: true,
      config: {
        provider: config.provider,
        baseUrl: config.baseUrl,
        model: config.model,
        workflow: config.workflow,
        contextLength: defaultBinding.contextLength,
        recommendedMaxOutputTokens: defaultBinding.recommendedMaxOutputTokens,
        tokenizer: defaultBinding.tokenizer,
        metadataSource: defaultBinding.metadataSource,
        shortTerm: config.shortTerm,
        memory: {
          sourceFiles: defaultBinding.agentMemoryFiles,
          agentCount: defaultBinding.agentMemoryCount,
          agents: defaultBinding.agentMemoryAgents,
          ...config.memory
        },
        skills: {
          ...config.skills,
          availableSkillFiles: defaultBinding.skills.availableSkillFiles,
          skillCount: defaultBinding.skills.skillCount
        },
        brains: config.brains,
        readiness,
        state: controlState
      }
    })
  })

  app.get('/api/control/agents/:agentId/workflow-diagnostics', async (c) => {
    const { agentId } = c.req.param()
    if (agentId !== hermesAgentDefinition.id) {
      return c.json({ ok: false, error: 'agent_not_found' }, 404)
    }

    const config = getPersistedHermesControlConfig()
    const binding = buildHermesBindingFromConfig(config)
    const contextLength = Number(binding.contextLength || 0)
    const minContextTokens = Number(binding.shortTerm?.minContextTokens || 0)
    const shortTermReady = contextLength > 0 && minContextTokens > 0 && contextLength >= minContextTokens
    const memoryFiles = [
      ['agentDefinitionFile', binding.memory.agentDefinitionFile],
      ['userFile', binding.memory.userFile],
      ['memoryFile', binding.memory.memoryFile],
      ['longTasksFile', binding.memory.longTasksFile],
      ['statusFile', binding.memory.statusFile],
      ['taskQueueFile', binding.memory.taskQueueFile],
      ['decisionsFile', binding.memory.decisionsFile]
    ].map(([key, filePath]) => ({
      key,
      filePath,
      exists: context.fs.existsSync(filePath)
    }))

    const memoryFileReady = memoryFiles.every((item) => item.exists)

    return c.json({
      ok: true,
      diagnostics: {
        workflow: {
          controllerLayerEnabled: true,
          memoryOverlayMode: String(binding?.workflow?.memoryOverlayMode || 'references-only'),
          replayWindowMessages: Math.max(0, Number(binding?.workflow?.replayWindowMessages || 0)),
          reasoningReplayWindowMessages: Math.max(0, Number(binding?.workflow?.reasoningReplayWindowMessages || 0))
        },
        shortTermMemory: {
          enabled: minContextTokens > 0,
          minContextTokens,
          runtimeContextLength: binding.contextLength,
          ready: shortTermReady,
          detail: shortTermReady
            ? `context ${contextLength} >= min ${minContextTokens}`
            : `context ${contextLength || 'unknown'} < min ${minContextTokens || 'unknown'}`
        },
        longTermMemory: {
          mode: 'file-memory',
          filesReady: memoryFileReady,
          files: memoryFiles,
          detail: memoryFileReady
            ? 'All configured file-memory sources are present for Hermes runtime.'
            : 'Some configured file-memory sources are missing.'
        },
        note: 'This endpoint validates control-plane configuration and file readiness. Internal Hermes runtime implementation details remain runtime-owned.'
      }
    })
  })

  const sendAgentRuntimeCapabilities = async (c) => {
    const { agentId } = c.req.param()
    if (agentId !== hermesAgentDefinition.id) {
      return c.json({ ok: false, error: 'agent_not_found' }, 404)
    }

    const binding = buildHermesBinding()
    const guide = buildReasoningCapabilityGuide()
    const runtime = buildAgentRuntimeDescriptor()
    const behaviorChecks = buildAgentRuntimeBehaviorChecks(binding)

    return c.json({
      ok: true,
      capabilities: {
        runtime,
        behaviorChecks,
        tools: buildReasoningToolCatalog(),
        actions: buildReasoningActionCatalog(),
        skills: binding.skills.availableSkills.map((skill) => ({
          filePath: skill.filePath,
          name: path.basename(path.dirname(skill.filePath)),
          hintCount: Array.isArray(skill.actionHints) ? skill.actionHints.length : 0,
          actionHints: Array.isArray(skill.actionHints) ? skill.actionHints : []
        })),
        guide
      }
    })
  }

  app.get('/api/control/agents/:agentId/reasoning-capabilities', sendAgentRuntimeCapabilities)
  app.get('/api/control/agents/:agentId/agent-runtime', sendAgentRuntimeCapabilities)

  app.post('/api/control/agents/:agentId/preflight-check', async (c) => {
    const { agentId } = c.req.param()
    if (agentId !== hermesAgentDefinition.id) {
      return c.json({ ok: false, error: 'agent_not_found' }, 404)
    }

    const body = await c.req.json().catch(() => ({}))
    const preflight = await buildHermesPreflight(body.config || {}, { appendLogs: true })
    const savedConfig = mergeHermesControlConfig(getPersistedHermesControlConfig(), body.config || {})
    const state = updateHermesControlState({
      preflight: {
        ready: preflight.ready,
        checkedAt: preflight.checkedAt,
        configFingerprint: getHermesControlConfigFingerprint(savedConfig),
        detail: preflight.ready ? '左脑自检通过' : '左脑自检未通过',
        checks: preflight.checks,
        inspection: preflight.inspection || null
      },
      model: buildModelStateSnapshot({
        provider: savedConfig.provider,
        baseUrl: savedConfig.baseUrl,
        model: preflight.selectedModel,
        inspection: preflight.inspection,
        lastAction: 'load'
      })
    })
    return c.json({ ok: true, agentId, preflight, state })
  })

  app.put('/api/control/agents/:agentId/config', async (c) => {
    const { agentId } = c.req.param()
    if (agentId !== hermesAgentDefinition.id) {
      return c.json({ ok: false, error: 'agent_not_found' }, 404)
    }

    const current = getPersistedHermesControlConfig()
    const body = await c.req.json().catch(() => ({}))
    const nextConfig = mergeHermesControlConfig(current, body)

    setHermesControlConfig(nextConfig)
    const binding = buildHermesBindingFromConfig(nextConfig)
    const state = updateHermesControlState({
      config: {
        saved: true,
        savedAt: new Date().toISOString(),
        savedFingerprint: getHermesControlConfigFingerprint(nextConfig),
        lastSavedModel: nextConfig.model,
        detail: '已保存左脑配置'
      },
      preflight: {
        ready: false,
        checkedAt: null,
        configFingerprint: '',
        detail: '配置已保存，等待重新自检',
        checks: [],
        inspection: null
      }
    })

    appendHermesLog(`[CONFIG][SAVE] model=${nextConfig.model || 'unknown'} provider=${nextConfig.provider || 'unknown'}`)

    return c.json({
      ok: true,
      config: nextConfig,
      readiness: buildConfigValidation(nextConfig, binding),
      state
    })
  })

  app.get('/api/control/agents/:agentId/memory-records', async (c) => {
    const { agentId } = c.req.param()
    if (agentId !== hermesAgentDefinition.id) {
      return c.json({ ok: false, error: 'agent_not_found' }, 404)
    }

    try {
      const binding = buildHermesBinding()
      return c.json({ ok: true, ...buildMemoryRecordsPayload(context, binding) })
    } catch (error) {
      return c.json({ ok: false, error: error instanceof Error ? error.message : String(error) }, 500)
    }
  })

  app.post('/api/control/agents/:agentId/memory-records/open', async (c) => {
    const { agentId } = c.req.param()
    if (agentId !== hermesAgentDefinition.id) {
      return c.json({ ok: false, error: 'agent_not_found' }, 404)
    }

    const body = await c.req.json().catch(() => ({}))

    try {
      const binding = buildHermesBinding()
      const filePath = resolveMemoryRecordPath(context, binding, body.recordKey)
      const openedWith = context.openFileInEditor(filePath)
      return c.json({ ok: true, filePath, openedWith, file: readUtf8FileRecord(filePath) })
    } catch (error) {
      return c.json({ ok: false, error: error instanceof Error ? error.message : String(error) }, 400)
    }
  })

  app.get('/api/control/agents/:agentId/memory-records/file', async (c) => {
    const { agentId } = c.req.param()
    if (agentId !== hermesAgentDefinition.id) {
      return c.json({ ok: false, error: 'agent_not_found' }, 404)
    }

    try {
      const binding = buildHermesBinding()
      const recordKey = c.req.query('recordKey')
      const filePath = resolveMemoryRecordPath(context, binding, recordKey)
      const recordsPayload = buildMemoryRecordsPayload(context, binding)
      return c.json({
        ok: true,
        filePath,
        record: recordsPayload.records.find((item) => item.key === String(recordKey || '').trim()) || null,
        file: readUtf8FileRecord(filePath)
      })
    } catch (error) {
      return c.json({ ok: false, error: error instanceof Error ? error.message : String(error) }, 400)
    }
  })

  app.put('/api/control/agents/:agentId/memory-records/file', async (c) => {
    const { agentId } = c.req.param()
    if (agentId !== hermesAgentDefinition.id) {
      return c.json({ ok: false, error: 'agent_not_found' }, 404)
    }

    const body = await c.req.json().catch(() => ({}))

    try {
      const binding = buildHermesBinding()
      const filePath = resolveMemoryRecordPath(context, binding, body.recordKey)
      const file = writeUtf8FileRecord(filePath, body.content || '')
      const recordsPayload = buildMemoryRecordsPayload(context, binding)
      return c.json({
        ok: true,
        filePath,
        record: recordsPayload.records.find((item) => item.key === String(body.recordKey || '').trim()) || null,
        file
      })
    } catch (error) {
      return c.json({ ok: false, error: error instanceof Error ? error.message : String(error) }, 400)
    }
  })

  app.post('/api/control/agents/:agentId/memory-records/clear', async (c) => {
    const { agentId } = c.req.param()
    if (agentId !== hermesAgentDefinition.id) {
      return c.json({ ok: false, error: 'agent_not_found' }, 404)
    }

    const body = await c.req.json().catch(() => ({}))
    const requestedTargets = Array.isArray(body.targets)
      ? body.targets.map((item) => String(item || '').trim()).filter(Boolean)
      : [String(body.target || '').trim()].filter(Boolean)
    if (requestedTargets.length === 0) {
      return c.json({ ok: false, error: 'memory_clear_target_required' }, 400)
    }
    const targets = requestedTargets.includes('all-test-records') ? ['all-test-records'] : Array.from(new Set(requestedTargets))

    const binding = buildHermesBinding()
    const memoryConfig = binding.memory
    const dailyLogFiles = listDailyLogFiles(memoryConfig, context.fs, path)
    const cleared = []

    const clearChatHistory = () => {
      resetFile(context.fs, path, getHermesChatFilePath(), '[]\n')
      cleared.push('chat-history')
    }
    const clearContextPool = () => {
      for (const entry of listContextPoolEntries()) {
        if (context.fs.existsSync(entry.filePath)) {
          context.fs.unlinkSync(entry.filePath)
        }
      }
      cleared.push('context-pool')
    }
    const clearLongTermMemory = () => {
      resetFile(context.fs, path, memoryConfig.userFile, '# User Preferences\n\n')
      resetFile(context.fs, path, memoryConfig.memoryFile, '# Project Memory\n\n')
      cleared.push('long-term-memory')
    }
    const clearStateRecords = () => {
      resetFile(context.fs, path, memoryConfig.statusFile, '# Project Status\n\n')
      resetFile(context.fs, path, memoryConfig.taskQueueFile, '# Task Queue\n\n')
      resetFile(context.fs, path, memoryConfig.decisionsFile, '# Decisions\n\n')
      cleared.push('state-records')
    }
    const clearLogs = () => {
      resetFile(context.fs, path, HERMES_RUNTIME_LOG_FILE, '')
      for (const filePath of dailyLogFiles) {
        resetFile(context.fs, path, filePath, '')
      }
      if (dailyLogFiles.length === 0) {
        const todayLogPath = getTodayDailyLogPath(memoryConfig, context.fs, path)
        if (todayLogPath) resetFile(context.fs, path, todayLogPath, '')
      }
      cleared.push('logs')
    }

    try {
      for (const target of targets) {
        if (target === 'chat-history') clearChatHistory()
        else if (target === 'context-pool') clearContextPool()
        else if (target === 'long-term-memory') clearLongTermMemory()
        else if (target === 'state-records') clearStateRecords()
        else if (target === 'logs') clearLogs()
        else if (target === 'all-test-records') {
          clearChatHistory()
          clearContextPool()
          clearLongTermMemory()
          clearStateRecords()
          clearLogs()
        } else {
          return c.json({ ok: false, error: 'memory_clear_target_invalid' }, 400)
        }
      }

      const payload = buildMemoryRecordsPayload(context, buildHermesBinding())
      return c.json({
        ok: true,
        target: targets[0],
        targets,
        cleared,
        message: targets[0] === 'all-test-records'
          ? '已清空全部测试记录。'
          : targets.length > 1
            ? `已清空 ${targets.length} 类记录。`
            : '已清空所选记录。',
        ...payload
      })
    } catch (error) {
      return c.json({ ok: false, error: error instanceof Error ? error.message : String(error) }, 500)
    }
  })
}
