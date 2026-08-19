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
        return /^\d{4}-\d{2}-\d{2}\.md$/.test(path.basename(filePath)) && fs.statSync(filePath).isFile()
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

function getFileSizeBytes(fs, filePath) {
  try {
    return fs.existsSync(filePath) && fs.statSync(filePath).isFile()
      ? fs.statSync(filePath).size
      : 0
  } catch {
    return 0
  }
}

function getDirectorySizeBytes(fs, path, directoryPath) {
  try {
    if (!directoryPath || !fs.existsSync(directoryPath)) return 0
    const stat = fs.statSync(directoryPath)
    if (stat.isFile()) return stat.size
    if (!stat.isDirectory()) return 0
    return fs.readdirSync(directoryPath).reduce((total, name) => {
      return total + getDirectorySizeBytes(fs, path, path.join(directoryPath, name))
    }, 0)
  } catch {
    return 0
  }
}

function formatBytes(bytes) {
  const value = Math.max(0, Number(bytes) || 0)
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`
  return `${(value / 1024 / 1024).toFixed(1)} MB`
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
    canOpen: true,
    required: Boolean(options.required),
    optionalMissingOk: Boolean(options.optionalMissingOk),
    usage: String(options.usage || ''),
    howToUse: String(options.howToUse || ''),
    contextRole: String(options.contextRole || ''),
    cleanupPolicy: String(options.cleanupPolicy || '')
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
  const stateRoot = path.join(context.GAMESTUDIO_ROOT, 'state')
  const agentRuntimeSessionsDir = path.join(stateRoot, 'agent-runtime-sessions')
  const legacyReasoningSessionsDir = path.join(stateRoot, 'reasoning-sessions')
  const runtimeTraceFiles = [
    path.join(stateRoot, 'agent-runtime-events.jsonl'),
    path.join(stateRoot, 'agent-runtime-review-records.jsonl'),
    path.join(stateRoot, 'reasoning-review-records.jsonl'),
    path.join(stateRoot, 'reasoning-quality-calibrations.jsonl'),
    path.join(stateRoot, 'reasoning-self-reviews.jsonl'),
    path.join(stateRoot, 'reasoning-improvement-candidates.jsonl'),
    path.join(stateRoot, 'reasoning-quality-calibrations.jsonl')
  ]
  const uniqueRuntimeTraceFiles = [...new Set(runtimeTraceFiles)]
  const chatHistoryFilePath = getHermesChatFileRecord({ includeContent: true }).filePath
  const logsSizeBytes = getFileSizeBytes(fs, HERMES_RUNTIME_LOG_FILE)
    + dailyLogFiles.reduce((total, filePath) => total + getFileSizeBytes(fs, filePath), 0)
  const runtimeTracesSizeBytes = getDirectorySizeBytes(fs, path, agentRuntimeSessionsDir)
    + getDirectorySizeBytes(fs, path, legacyReasoningSessionsDir)
    + uniqueRuntimeTraceFiles.reduce((total, filePath) => total + getFileSizeBytes(fs, filePath), 0)
  const contextPoolSizeBytes = contextPoolEntries.reduce((total, entry) => total + getFileSizeBytes(fs, entry.filePath), 0)
  const longTermMemorySizeBytes = [memoryConfig.userFile, memoryConfig.memoryFile]
    .reduce((total, filePath) => total + getFileSizeBytes(fs, filePath), 0)
  const stateRecordsSizeBytes = [memoryConfig.statusFile, memoryConfig.taskQueueFile, memoryConfig.decisionsFile]
    .reduce((total, filePath) => total + getFileSizeBytes(fs, filePath), 0)

  const records = [
    buildMemoryRecord(readUtf8FileRecord, {
      key: 'chat-history',
      label: '会话缓冲记录',
      scope: 'short-term',
      filePath: chatHistoryFilePath,
      previewContent: getHermesChatFileRecord({ includeContent: true }).content,
      usage: '保存当前回答窗口的用户输入、最终回答和错误信息。',
      howToUse: '生产任务前可清空，避免旧对话被历史重放带入本轮；清空会先归档。',
      contextRole: '会作为短期历史重放参与 Hermes 规划与回答上下文。',
      cleanupPolicy: '可按任务轮次清空，不影响长期记忆。',
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
      previewMode: 'tail',
      usage: '记录 Control 与 Hermes runtime 的启动、自检、模型、错误和清理动作。',
      howToUse: '用于排障和确认按钮动作是否真正执行；生产任务前可归档清空。',
      contextRole: '不进入 Hermes 任务上下文，只用于实时观测和故障复盘。',
      cleanupPolicy: '安全清空项，会先归档。'
    }),
    buildMemoryRecord(readUtf8FileRecord, {
      key: 'daily-log',
      label: '当日日志（可选）',
      scope: 'short-term',
      filePath: todayDailyLogFile,
      previewMode: 'tail',
      optionalMissingOk: true,
      usage: '当天人工补充的工作日记，不由系统自动写入。',
      howToUse: '需要把当天人工结论带入任务时再创建并编辑；不需要时保持未创建即可。',
      contextRole: '只有文件存在时，才作为 Latest Daily Log 注入项目状态、任务、进度类问题。',
      cleanupPolicy: '属于日志清空项；未创建不是错误。',
      itemCount: dailyLogFiles.length
    }),
    buildMemoryRecord(readUtf8FileRecord, {
      key: 'agent-definition',
      label: 'Agent 定义',
      scope: 'long-term',
      filePath: memoryConfig.agentDefinitionFile,
      required: true,
      usage: '定义 Hermes/Control 的身份、边界、职责和协作规则。',
      howToUse: '只在稳定规则变化时编辑；不要放一次性任务流水。',
      contextRole: '会进入基础项目记忆，影响模型对自身职责和边界的理解。',
      cleanupPolicy: '不应清空。'
    }),
    buildMemoryRecord(readUtf8FileRecord, {
      key: 'user-memory',
      label: '用户长期记忆',
      scope: 'long-term',
      filePath: memoryConfig.userFile,
      required: true,
      usage: '保存用户偏好、协作约定和长期目标。',
      howToUse: '只保存可长期复用的偏好与规则；错误信息应修正或归档。',
      contextRole: '会进入基础项目记忆，影响回答风格和任务取舍。',
      cleanupPolicy: '严重影响项，仅明确重置时清空。'
    }),
    buildMemoryRecord(readUtf8FileRecord, {
      key: 'project-memory',
      label: '项目长期记忆',
      scope: 'long-term',
      filePath: memoryConfig.memoryFile,
      required: true,
      usage: '保存 GameStudio 的稳定架构、目录、生产闭环和能力边界。',
      howToUse: '记录稳定事实；不要写临时测试日志或过期阶段口径。',
      contextRole: '会进入基础项目记忆，影响工作流和工具选择。',
      cleanupPolicy: '严重影响项，仅明确重置时清空。'
    }),
      buildMemoryRecord(readUtf8FileRecord, {
        key: 'long-tasks',
        label: '长任务主线',
        scope: 'long-term',
        filePath: memoryConfig.longTasksFile,
        required: true,
        usage: '保存跨多轮的端到端生产主线和验收目标。',
        howToUse: '用于判断下一步该推进哪条长期链路；保持短而稳定。',
        contextRole: '任务、进度、闭环类问题会优先读取。',
        cleanupPolicy: '不建议清空，可人工整理。'
      }),
    buildMemoryRecord(readUtf8FileRecord, {
      key: 'project-status',
      label: '项目状态记录',
      scope: 'long-term',
      filePath: memoryConfig.statusFile,
      required: true,
      usage: '保存当前系统状态、已完成能力、缺口和阻塞。',
      howToUse: '每次生产级推进后更新事实状态，避免模型沿用旧判断。',
      contextRole: '状态、进度、缺口类问题会优先读取。',
      cleanupPolicy: '严重影响项，仅明确重置时清空。'
    }),
    buildMemoryRecord(readUtf8FileRecord, {
      key: 'task-queue',
      label: '任务队列记录',
      scope: 'long-term',
      filePath: memoryConfig.taskQueueFile,
      required: true,
      usage: '保存下一步任务、验收项和待处理工作。',
      howToUse: '生产任务结束后保留下一步，不堆历史流水。',
      contextRole: '任务、下一步、排期类问题会优先读取。',
      cleanupPolicy: '严重影响项，仅明确重置时清空。'
    }),
    buildMemoryRecord(readUtf8FileRecord, {
      key: 'decisions',
      label: '决策记录',
      scope: 'long-term',
      filePath: memoryConfig.decisionsFile,
      required: true,
      usage: '保存已经生效的架构和产品决策。',
      howToUse: '只写稳定决策和原因，避免重复争论已定方向。',
      contextRole: '决策、边界、取舍类问题会优先读取。',
      cleanupPolicy: '严重影响项，仅明确重置时清空。'
    }),
    ...contextPoolEntries.map((entry) => buildMemoryRecord(readUtf8FileRecord, {
      key: `context-pool:${entry.entryId}`,
      label: entry.title || entry.entryId,
      scope: 'context-pool',
      kind: 'context-pool-entry',
      filePath: entry.filePath,
      previewContent: entry.summary,
      usage: '保存用户确认过的上下文摘要。',
      howToUse: '提交任务前可手选注入，避免重复解释同一背景。',
      contextRole: '只有被用户选择时才进入本轮提交上下文。',
      cleanupPolicy: '高影响项，清空会影响后续任务复用。'
    }))
  ]

  return {
    records,
    clearTargets: [
      {
        value: 'logs',
        label: '清空日志',
        description: '清空 Hermes 运行日志和当日日志目录。不会删除长期记忆、上下文池或任务状态。',
        impactLevel: 'safe',
        impactLabel: '可删除',
        impactSummary: '仅影响排障回看，不影响 control + 智能体记忆。',
        sizeBytes: logsSizeBytes,
        sizeLabel: formatBytes(logsSizeBytes)
      },
      {
        value: 'runtime-traces',
        label: '清空运行轨迹/测试会话记录',
        description: '删除已结束的 reasoning/agent-runtime session 文件，并重置事件、审核、自评和质量校准 JSONL。',
        impactLevel: 'caution',
        impactLabel: '谨慎删除',
        impactSummary: '不删除长期记忆；会丢失 plan、任务行为、审核复盘和提案学习证据。',
        sizeBytes: runtimeTracesSizeBytes,
        sizeLabel: formatBytes(runtimeTracesSizeBytes)
      },
      {
        value: 'chat-history',
        label: '清空会话缓冲记录',
        description: '重置 Hermes 聊天缓冲 JSON。',
        impactLevel: 'caution',
        impactLabel: '谨慎删除',
        impactSummary: '影响短期对话上下文；不删除长期记忆文件。',
        sizeBytes: getFileSizeBytes(fs, chatHistoryFilePath),
        sizeLabel: formatBytes(getFileSizeBytes(fs, chatHistoryFilePath))
      },
      {
        value: 'context-pool',
        label: '清空上下文记忆',
        description: '删除全部已确认上下文池条目。',
        impactLevel: 'high',
        impactLabel: '高影响',
        impactSummary: '会删除人工确认过的上下文材料，影响后续任务复用。',
        sizeBytes: contextPoolSizeBytes,
        sizeLabel: formatBytes(contextPoolSizeBytes)
      },
      {
        value: 'long-term-memory',
        label: '清空长期记忆',
        description: '重置用户长期记忆与项目长期记忆文件。',
        impactLevel: 'critical',
        impactLabel: '严重影响',
        impactSummary: '会直接削弱 control + 智能体的长期记忆。仅在明确重置时使用。',
        sizeBytes: longTermMemorySizeBytes,
        sizeLabel: formatBytes(longTermMemorySizeBytes)
      },
      {
        value: 'state-records',
        label: '清空状态/任务/决策',
        description: '重置状态、任务队列和决策记录。',
        impactLevel: 'critical',
        impactLabel: '严重影响',
        impactSummary: '会丢失项目状态、任务队列和决策依据。仅在明确重置时使用。',
        sizeBytes: stateRecordsSizeBytes,
        sizeLabel: formatBytes(stateRecordsSizeBytes)
      }
    ]
  }
}

function clearTerminalRuntimeSessionFiles(fs, path, directoryPath) {
  if (!directoryPath || !fs.existsSync(directoryPath)) return 0
  let clearedCount = 0
  for (const fileName of fs.readdirSync(directoryPath)) {
    if (!fileName.endsWith('.json')) continue
    const filePath = path.join(directoryPath, fileName)
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'))
      if (parsed?.status === 'completed' || parsed?.status === 'failed' || parsed?.status === 'cancelled' || parsed?.status === 'blocked' || parsed?.status === 'timeout') {
        fs.unlinkSync(filePath)
        clearedCount += 1
      }
    } catch {
      // Keep unreadable session files for manual inspection.
    }
  }
  return clearedCount
}

function countNonTerminalRuntimeSessionFiles(fs, path, directoryPath) {
  if (!directoryPath || !fs.existsSync(directoryPath)) return 0
  let activeCount = 0
  for (const fileName of fs.readdirSync(directoryPath)) {
    if (!fileName.endsWith('.json')) continue
    const filePath = path.join(directoryPath, fileName)
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'))
      if (parsed?.status !== 'completed' && parsed?.status !== 'failed' && parsed?.status !== 'cancelled') {
        activeCount += 1
      }
    } catch {
      activeCount += 1
    }
  }
  return activeCount
}

function assertRuntimeTracesClearable(fs, path, stateRoot) {
  const agentActive = countNonTerminalRuntimeSessionFiles(fs, path, path.join(stateRoot, 'agent-runtime-sessions'))
  const legacyActive = countNonTerminalRuntimeSessionFiles(fs, path, path.join(stateRoot, 'reasoning-sessions'))
  const activeCount = agentActive + legacyActive
  if (activeCount > 0) {
    throw new Error(`runtime_traces_have_active_sessions:${activeCount}`)
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

function toRelativeArchivePath(path, rootDir, filePath) {
  const relative = path.relative(rootDir, filePath)
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    return path.basename(filePath)
  }
  return relative
}

function createManualClearArchive(context, targets, targetDetails) {
  const timestamp = new Date().toISOString()
  const safeTimestamp = timestamp.replace(/[:.]/g, '-')
  const archiveDir = context.path.join(context.GAMESTUDIO_ROOT, 'state', 'memory-archive', 'manual-clear', `clear_${safeTimestamp}`)
  context.fs.mkdirSync(context.path.join(archiveDir, 'files'), { recursive: true })
  return {
    archiveDir,
    createdAt: timestamp,
    targets,
    targetDetails,
    files: []
  }
}

function archiveFileForManualClear(fs, path, rootDir, archive, filePath, kind) {
  if (!filePath || !fs.existsSync(filePath)) return false
  let stat = null
  try {
    stat = fs.statSync(filePath)
  } catch {
    return false
  }
  if (!stat.isFile()) return false
  const relativeSource = toRelativeArchivePath(path, rootDir, filePath)
  const targetPath = path.join(archive.archiveDir, 'files', relativeSource)
  ensureParentDirectory(fs, path, targetPath)
  fs.copyFileSync(filePath, targetPath)
  archive.files.push({
    kind,
    source: relativeSource,
    archivePath: toRelativeArchivePath(path, rootDir, targetPath),
    sizeBytes: stat.size
  })
  return true
}

function archiveAndClearTerminalRuntimeSessionFiles(fs, path, rootDir, directoryPath, archive) {
  if (!directoryPath || !fs.existsSync(directoryPath)) return 0
  let clearedCount = 0
  for (const fileName of fs.readdirSync(directoryPath)) {
    if (!fileName.endsWith('.json')) continue
    const filePath = path.join(directoryPath, fileName)
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'))
      if (parsed?.status === 'completed' || parsed?.status === 'failed' || parsed?.status === 'cancelled' || parsed?.status === 'blocked' || parsed?.status === 'timeout') {
        archiveFileForManualClear(fs, path, rootDir, archive, filePath, 'runtime-session')
        fs.unlinkSync(filePath)
        clearedCount += 1
      }
    } catch {
      // Keep unreadable session files for manual inspection.
    }
  }
  return clearedCount
}

function writeManualClearReport(fs, path, rootDir, archive, extra = {}) {
  const reportPath = path.join(archive.archiveDir, 'clear-report.json')
  const report = {
    createdAt: archive.createdAt,
    completedAt: new Date().toISOString(),
    targets: archive.targets,
    targetDetails: archive.targetDetails,
    archivedFileCount: archive.files.length,
    archivedFiles: archive.files,
    ...extra
  }
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  return {
    archiveDir: toRelativeArchivePath(path, rootDir, archive.archiveDir),
    reportFile: toRelativeArchivePath(path, rootDir, reportPath),
    archivedFileCount: archive.files.length
  }
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

    // strict 路由可见性：声明 hermes+strict 但当前不可满足（模型与绑定不一致）的路由
    // 必须在诊断面暴露，运行期会显式失败（route_unavailable），不再是静默降级。
    const modelRouting = binding?.workflow?.modelRouting || {}
    const routingEntries = [
      ...Object.entries(modelRouting.phaseRoutes || {}).map(([key, route]) => [`phase:${key}`, route]),
      ...Object.entries(modelRouting.actionRoutes || {}).map(([key, route]) => [`action:${key}`, route])
    ]
    const strictRoutes = routingEntries
      .filter(([, route]) => route && route.strict === true)
      .map(([routeId, route]) => ({
        routeId,
        transport: route.transport,
        requestedTransport: route.requestedTransport || route.transport,
        model: route.model || '',
        satisfiable: !route.unavailableReason,
        unavailableReason: route.unavailableReason || null
      }))
    const degradedRoutes = routingEntries
      .filter(([, route]) => route && route.degradedFrom)
      .map(([routeId, route]) => ({
        routeId,
        requestedTransport: route.degradedFrom,
        transport: route.transport,
        model: route.model || '',
        detail: '非 strict 路由声明与左脑绑定不一致，已按既有 best-effort 语义显式直连（非静默）。'
      }))

    return c.json({
      ok: true,
      diagnostics: {
        workflow: {
          controllerLayerEnabled: true,
          memoryOverlayMode: String(binding?.workflow?.memoryOverlayMode || 'references-only'),
          replayWindowMessages: Math.max(0, Number(binding?.workflow?.replayWindowMessages || 0)),
          reasoningReplayWindowMessages: Math.max(0, Number(binding?.workflow?.reasoningReplayWindowMessages || 0)),
          modelRouting: {
            strictRoutes,
            degradedRoutes,
            strictRouteRequiredPhases: Array.isArray(modelRouting.strictRouteRequiredPhases)
              ? modelRouting.strictRouteRequiredPhases.map((value) => String(value)).filter(Boolean)
              : []
          }
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

    if (typeof nextConfig.model !== 'string' || !String(nextConfig.model).trim()) {
      return c.json({ ok: false, error: 'invalid_model', detail: 'model 必须是字符串且不能为空。' }, 400)
    }
    if (typeof nextConfig.provider !== 'string' || !String(nextConfig.provider).trim()) {
      return c.json({ ok: false, error: 'invalid_provider', detail: 'provider 必须是字符串且不能为空。' }, 400)
    }
    if (typeof nextConfig.baseUrl !== 'string' || !String(nextConfig.baseUrl).trim()) {
      return c.json({ ok: false, error: 'invalid_base_url', detail: 'baseUrl 必须是字符串且不能为空。' }, 400)
    }

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

    const rb = nextConfig.brains?.rightBrain
    appendHermesLog(`[CONFIG][SAVE] model=${nextConfig.model || 'unknown'} provider=${nextConfig.provider || 'unknown'} rightBrainEnabled=${nextConfig.brains?.rightBrainEnabled || false} rightBrainProvider=${rb?.provider || '-'} rightBrainModel=${rb?.model || '-'} rightBrainApiKeyPresent=${Boolean(rb?.apiKey)}`)

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
    const targets = Array.from(new Set(requestedTargets))
    if (targets.includes('all-test-records')) {
      return c.json({ ok: false, error: 'memory_clear_all_target_disabled' }, 400)
    }

    const binding = buildHermesBinding()
    const memoryConfig = binding.memory
    const beforePayload = buildMemoryRecordsPayload(context, binding)
    const targetDetails = beforePayload.clearTargets.filter((item) => targets.includes(item.value))
    const archive = createManualClearArchive(context, targets, targetDetails)
    const dailyLogFiles = listDailyLogFiles(memoryConfig, context.fs, path)
    const stateRoot = path.join(context.GAMESTUDIO_ROOT, 'state')
    const runtimeTraceFiles = [...new Set([
      path.join(stateRoot, 'agent-runtime-events.jsonl'),
      path.join(stateRoot, 'agent-runtime-review-records.jsonl'),
      path.join(stateRoot, 'reasoning-review-records.jsonl'),
      path.join(stateRoot, 'reasoning-quality-calibrations.jsonl'),
      path.join(stateRoot, 'reasoning-self-reviews.jsonl'),
      path.join(stateRoot, 'reasoning-improvement-candidates.jsonl')
    ])]
    const cleared = []

    const clearChatHistory = () => {
      archiveFileForManualClear(context.fs, path, context.GAMESTUDIO_ROOT, archive, getHermesChatFilePath(), 'chat-history')
      resetFile(context.fs, path, getHermesChatFilePath(), '[]\n')
      cleared.push('chat-history')
    }
    const clearContextPool = () => {
      for (const entry of listContextPoolEntries()) {
        if (context.fs.existsSync(entry.filePath)) {
          archiveFileForManualClear(context.fs, path, context.GAMESTUDIO_ROOT, archive, entry.filePath, 'context-pool')
          context.fs.unlinkSync(entry.filePath)
        }
      }
      cleared.push('context-pool')
    }
    const clearLongTermMemory = () => {
      archiveFileForManualClear(context.fs, path, context.GAMESTUDIO_ROOT, archive, memoryConfig.userFile, 'long-term-memory')
      archiveFileForManualClear(context.fs, path, context.GAMESTUDIO_ROOT, archive, memoryConfig.memoryFile, 'long-term-memory')
      resetFile(context.fs, path, memoryConfig.userFile, '# User Preferences\n\n')
      resetFile(context.fs, path, memoryConfig.memoryFile, '# Project Memory\n\n')
      cleared.push('long-term-memory')
    }
    const clearStateRecords = () => {
      archiveFileForManualClear(context.fs, path, context.GAMESTUDIO_ROOT, archive, memoryConfig.statusFile, 'state-record')
      archiveFileForManualClear(context.fs, path, context.GAMESTUDIO_ROOT, archive, memoryConfig.taskQueueFile, 'state-record')
      archiveFileForManualClear(context.fs, path, context.GAMESTUDIO_ROOT, archive, memoryConfig.decisionsFile, 'state-record')
      resetFile(context.fs, path, memoryConfig.statusFile, '# Project Status\n\n')
      resetFile(context.fs, path, memoryConfig.taskQueueFile, '# Task Queue\n\n')
      resetFile(context.fs, path, memoryConfig.decisionsFile, '# Decisions\n\n')
      cleared.push('state-records')
    }
    const clearLogs = () => {
      archiveFileForManualClear(context.fs, path, context.GAMESTUDIO_ROOT, archive, HERMES_RUNTIME_LOG_FILE, 'runtime-log')
      resetFile(context.fs, path, HERMES_RUNTIME_LOG_FILE, '')
      for (const filePath of dailyLogFiles) {
        archiveFileForManualClear(context.fs, path, context.GAMESTUDIO_ROOT, archive, filePath, 'daily-log')
        resetFile(context.fs, path, filePath, '')
      }
      if (dailyLogFiles.length === 0) {
        const todayLogPath = getTodayDailyLogPath(memoryConfig, context.fs, path)
        if (todayLogPath) resetFile(context.fs, path, todayLogPath, '')
      }
      cleared.push('logs')
    }
    const clearRuntimeTraces = () => {
      assertRuntimeTracesClearable(context.fs, path, stateRoot)
      const agentSessionsCleared = archiveAndClearTerminalRuntimeSessionFiles(context.fs, path, context.GAMESTUDIO_ROOT, path.join(stateRoot, 'agent-runtime-sessions'), archive)
      const legacySessionsCleared = archiveAndClearTerminalRuntimeSessionFiles(context.fs, path, context.GAMESTUDIO_ROOT, path.join(stateRoot, 'reasoning-sessions'), archive)
      for (const filePath of runtimeTraceFiles) {
        archiveFileForManualClear(context.fs, path, context.GAMESTUDIO_ROOT, archive, filePath, 'runtime-trace')
        resetFile(context.fs, path, filePath, '')
      }
      cleared.push(`runtime-traces:${agentSessionsCleared + legacySessionsCleared}`)
    }

    try {
      for (const target of targets) {
        if (target === 'chat-history') clearChatHistory()
        else if (target === 'context-pool') clearContextPool()
        else if (target === 'long-term-memory') clearLongTermMemory()
        else if (target === 'state-records') clearStateRecords()
        else if (target === 'logs') clearLogs()
        else if (target === 'runtime-traces') clearRuntimeTraces()
        else {
          return c.json({ ok: false, error: 'memory_clear_target_invalid' }, 400)
        }
      }

      const payload = buildMemoryRecordsPayload(context, buildHermesBinding())
      const archiveSummary = writeManualClearReport(context.fs, path, context.GAMESTUDIO_ROOT, archive, { cleared })
      return c.json({
        ok: true,
        target: targets[0],
        targets,
        cleared,
        archive: archiveSummary,
        analysis: { targets: targetDetails },
        message: targets.length > 1
            ? `已归档并清空 ${targets.length} 类记录。`
            : '已归档并清空所选记录。',
        ...payload
      })
    } catch (error) {
      return c.json({ ok: false, error: error instanceof Error ? error.message : String(error) }, 500)
    }
  })
}
