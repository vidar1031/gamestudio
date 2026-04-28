import fs from 'node:fs'
import path from 'node:path'

import {
  GAMESTUDIO_ROOT,
} from '../../config/paths.js'
import {
  REASONING_ACTIONS,
  REASONING_ALLOWED_ACTION_NAMES,
  isReasoningAnswerAction,
  isReasoningWriteAction,
} from '../capabilities/actionRegistry.js'
import { resolveWorkspacePathFromInput } from '../workspace/inspectors.js'
import {
  inferWorkspaceDirectoryFromPrompt,
  inferWorkspaceDirectoriesFromPromptText,
  inferWorkspaceFilesFromPrompt,
  isBusinessServerLocationPrompt,
  isControlLocationPrompt,
  isDirectoryListingPrompt,
  isEditorLocationPrompt,
  isWorkspaceDirectoryQuestionPrompt,
  isWorkspaceFileQuestionPrompt,
  normalizeWorkspaceRelativePath,
} from './heuristics.js'
import {
  appendReasoningMemorySyncSteps,
  buildReasoningPlannerProjectMemory,
} from './memory.js'
import {
  buildHermesRuntimeSystemMessage,
  buildProjectMemorySystemMessage,
  collectReplayableHermesMessages,
  createOpaqueId,
  getMatchingReasoningIntentRules,
  inferReasoningStepSkipReview,
  inferWorkspaceDirectoriesFromRecentContext,
} from '../controlServerCore.js'

export function buildReasoningPlannerMessages(history, userPrompt, binding, correctionPrompt = '', contextSelection = {}) {
  const projectMemory = buildReasoningPlannerProjectMemory(binding, userPrompt, contextSelection)
  const replayWindowMessages = Math.max(0, Number(binding?.workflow?.reasoningReplayWindowMessages || 0))
  const replayableMessages = collectReplayableHermesMessages(history, {
    limit: replayWindowMessages
  })
  const allowedActionsText = REASONING_ALLOWED_ACTION_NAMES.join(', ')
  const matchedIntentRules = getMatchingReasoningIntentRules(userPrompt, history, binding, contextSelection)
  const hintedActionsText = [...new Set(matchedIntentRules.flatMap((rule) => [...(rule.requiredActions || []), rule.answerAction]).filter(Boolean))].join(', ')

  return {
    projectMemory,
    replayableMessages,
    messages: [
      {
        role: 'system',
        content: buildHermesRuntimeSystemMessage(binding)
      },
      {
        role: 'system',
        content: projectMemory.message
      },
      {
        role: 'system',
        content: [
          'You are the planning layer for the GameStudio observable reasoning pipeline.',
          'Return one strict JSON object only. Do not include markdown fences or extra commentary.',
          'Generate a short sequential execution plan for the current user request using the nearby conversation and injected markdown memory as the primary context.',
          `Allowed actions: ${allowedActionsText}.`,
          hintedActionsText ? `Selected skill and intent hints suggest these actions when relevant: ${hintedActionsText}.` : '',
          'Do not speculate about databases, APIs, or external folders when a local project-listing tool exists.',
          'Stay inside the GameStudio workspace and prefer observable tool results over generic assumptions.',
          'If the user asks what is inside a workspace directory, first identify the directory mentioned in the prompt and use list_directory_contents.',
          'Do not invent fixed file-specific scanners or templates. Use generic directory, file, and search actions that match the actual request.',
          'When the run changes project state, fixes runtime behavior, updates workflow rules, or advances a multi-step task, include memory sync steps before the final answer so STATUS, TASK_QUEUE, DECISIONS, and LONG_TASKS stay current when relevant.',
          'Use skipReview: true for pure read, routing, and evidence-gathering steps that may proceed automatically.',
          'Do not set skipReview: true on file-write steps.',
          'For write actions (edit_workspace_file, write_memory_file, update_task_queue), the step MUST include a "params" field with the required parameters.',
          'For edit_workspace_file: params must contain "filePath" (relative to workspace) and "content" (edit intent or desired content).',
          'For write_memory_file: params must contain "filePath" (relative to workspace, under ai/) and "content" (the full file content to write).',
          'For update_task_queue: params must contain "content" (the task entry text to append) and optionally "replaceAll" (boolean).',
          'For run_lifecycle_script: params must contain "scriptName" (one of: restart_control.sh, restart_server.sh, reporter.sh, openclaw_selfcheck.sh).',
          'For read_file_content: params must contain "filePath" (relative to workspace).',
          'For list_directory_contents: params must contain "dirPath" and may also use legacy "startDir" for compatibility.',
          'For search_workspace_text: params must contain "query" and may contain "startDir" and "maxResults".',
          'For create_workspace_file: params must contain "filePath" and "content".',
          'For rename_workspace_path: params must contain "fromPath" and "toPath".',
          'For delete_workspace_path: params must contain "targetPath".',
          'For run_workspace_script: params must contain "scriptPath" (workspace-relative and under allowed roots).',
          'Schema: {"goal": string, "strategy": "sequential", "steps": [{"title": string, "action": string, "params": object, "skipReview": boolean?}]}'
        ].join('\n')
      },
      ...replayableMessages,
      {
        role: 'user',
        content: [
          `当前用户问题：${userPrompt}`,
          correctionPrompt ? `审核修正条件：${correctionPrompt}` : '',
          '',
          '请基于最近上下文和已注入的 markdown 项目记忆，输出严格 JSON plan。'
        ].filter(Boolean).join('\n')
      }
    ]
  }
}

export function extractJsonObjectString(text) {
  const raw = String(text || '').trim()
  if (!raw) return ''

  const fencedMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const candidate = fencedMatch ? fencedMatch[1].trim() : raw
  const firstBrace = candidate.indexOf('{')
  const lastBrace = candidate.lastIndexOf('}')
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    return candidate.slice(firstBrace, lastBrace + 1)
  }
  return candidate
}

export function buildReasoningFallbackPlan(userPrompt, history, binding, contextSelection = {}) {
  if (isEditorLocationPrompt(userPrompt) || isControlLocationPrompt(userPrompt) || isBusinessServerLocationPrompt(userPrompt)) {
    return {
      planId: createOpaqueId('plan'),
      goal: '定位 GameStudio 工作区中当前问题明确指定的应用目录',
      strategy: 'sequential',
      steps: [
        {
          stepId: 'step_locate_project',
          title: '定位 GameStudio 工作区结构',
          action: 'locate_project',
          tool: 'workspace.locateProject',
          params: {},
          skipReview: true,
          dependsOn: []
        },
        {
          stepId: 'step_generate_default_answer',
          title: '回答当前明确目录问题',
          action: 'generate_default_answer',
          tool: 'model.answer',
          params: {},
          skipReview: true,
          dependsOn: ['step_locate_project']
        }
      ]
    }
  }

  const inferredFilePaths = inferWorkspaceFilesFromPrompt(userPrompt)
  if (isWorkspaceFileQuestionPrompt(userPrompt) && inferredFilePaths.length > 0) {
    const readSteps = inferredFilePaths.map((filePath, index) => ({
      stepId: `step_read_file_content_${index + 1}`,
      title: `读取 ${filePath} 文件内容`,
      action: 'read_file_content',
      tool: REASONING_ACTIONS['read_file_content'].tool,
      params: { filePath },
      skipReview: true,
      dependsOn: index === 0 ? [] : [`step_read_file_content_${index}`]
    }))
    return {
      planId: createOpaqueId('plan'),
      goal: '基于指定工作区文件内容回答职责与作用问题',
      strategy: 'sequential',
      steps: [
        ...readSteps,
        {
          stepId: 'step_generate_default_answer',
          title: '基于文件内容生成回答',
          action: 'generate_default_answer',
          tool: 'model.answer',
          params: {},
          skipReview: true,
          dependsOn: [readSteps[readSteps.length - 1].stepId]
        }
      ]
    }
  }

  const inferredQuestionDirPaths = inferWorkspaceDirectoriesFromPromptText(userPrompt)
  if (isWorkspaceDirectoryQuestionPrompt(userPrompt) && inferredQuestionDirPaths.length > 0) {
    const steps = []
    const appendStep = (action, title, params, dependsOn = []) => {
      const stepId = `step_${action}_${steps.length + 1}`
      steps.push({
        stepId,
        title,
        action,
        tool: REASONING_ACTIONS[action]?.tool || 'workspace.tool',
        params,
        skipReview: true,
        dependsOn
      })
      return stepId
    }
    let previousStepId = ''
    for (const dirPath of inferredQuestionDirPaths) {
      const resolvedDirPath = resolveWorkspacePathFromInput(dirPath)
      if (!resolvedDirPath || !fs.existsSync(resolvedDirPath) || !fs.statSync(resolvedDirPath).isDirectory()) continue
      previousStepId = appendStep('list_directory_contents', `查看 ${dirPath} 目录结构`, { dirPath }, previousStepId ? [previousStepId] : [])

      const packagePath = normalizeWorkspaceRelativePath(path.join(dirPath, 'package.json'))
      if (fs.existsSync(path.resolve(GAMESTUDIO_ROOT, packagePath))) {
        previousStepId = appendStep('read_file_content', `读取 ${packagePath}`, { filePath: packagePath }, [previousStepId])
      }

      const srcDirPath = normalizeWorkspaceRelativePath(path.join(dirPath, 'src'))
      if (fs.existsSync(path.resolve(GAMESTUDIO_ROOT, srcDirPath)) && fs.statSync(path.resolve(GAMESTUDIO_ROOT, srcDirPath)).isDirectory()) {
        previousStepId = appendStep('list_directory_contents', `查看 ${srcDirPath} 目录结构`, { dirPath: srcDirPath }, [previousStepId])
      }

      const entryCandidates = ['src/index.js', 'src/index.ts', 'src/main.tsx', 'src/main.ts', 'src/App.tsx', 'src/App.vue']
      for (const candidate of entryCandidates) {
        const candidatePath = normalizeWorkspaceRelativePath(path.join(dirPath, candidate))
        const resolvedCandidatePath = path.resolve(GAMESTUDIO_ROOT, candidatePath)
        if (!fs.existsSync(resolvedCandidatePath) || !fs.statSync(resolvedCandidatePath).isFile()) continue
        previousStepId = appendStep('read_file_content', `读取 ${candidatePath}`, { filePath: candidatePath }, [previousStepId])
        break
      }
    }

    if (steps.length > 0) {
      steps.push({
        stepId: 'step_generate_default_answer',
        title: '基于目录与入口证据生成职责分析',
        action: 'generate_default_answer',
        tool: 'model.answer',
        params: {},
        skipReview: true,
        dependsOn: previousStepId ? [previousStepId] : []
      })
      return {
        planId: createOpaqueId('plan'),
        goal: '基于工作区目录、package 与入口文件证据分析模块职责',
        strategy: 'sequential',
        steps
      }
    }
  }

  const inferredDirPath = inferWorkspaceDirectoryFromPrompt(userPrompt)
  const inferredDirPaths = inferredDirPath
    ? [inferredDirPath]
    : inferWorkspaceDirectoriesFromRecentContext(userPrompt, history)
  if (isDirectoryListingPrompt(userPrompt) && inferredDirPaths.length > 0) {
    const listSteps = inferredDirPaths.map((dirPath, index) => ({
      stepId: `step_list_directory_contents_${index + 1}`,
      title: `列出 ${dirPath} 目录内容`,
      action: 'list_directory_contents',
      tool: 'workspace.listDirectory',
      params: { dirPath },
      skipReview: true,
      dependsOn: index === 0 ? [] : [`step_list_directory_contents_${index}`]
    }))
    return {
      planId: createOpaqueId('plan'),
      goal: `列出 ${inferredDirPaths.join('、')} 目录下的文件与子目录`,
      strategy: 'sequential',
      steps: [
        ...listSteps,
        {
          stepId: 'step_generate_default_answer',
          title: '生成目录清单回答',
          action: 'generate_default_answer',
          tool: 'model.answer',
          params: {},
          skipReview: true,
          dependsOn: [listSteps[listSteps.length - 1].stepId]
        }
      ]
    }
  }

  const matchedIntentRules = getMatchingReasoningIntentRules(userPrompt, history, binding, contextSelection)

  if (matchedIntentRules.length > 0) {
    const actions = []
    for (const rule of matchedIntentRules) {
      if (rule.prependContext !== false && !actions.includes('read_recent_context')) {
        actions.push('read_recent_context')
      }
      for (const action of Array.isArray(rule.requiredActions) ? rule.requiredActions : []) {
        if (!actions.includes(action)) actions.push(action)
      }
    }
    const preferredAnswerAction = matchedIntentRules.find((rule) => rule.answerAction)?.answerAction || 'generate_default_answer'
    if (!actions.includes(preferredAnswerAction)) actions.push(preferredAnswerAction)

    const steps = actions.map((action, index) => ({
      stepId: `step_${action}_${index + 1}`,
      title: REASONING_ACTIONS[action]?.title || action,
      action,
      tool: REASONING_ACTIONS[action]?.tool || 'planner.default',
      params: {},
      skipReview: !isReasoningWriteAction(action) && !isReasoningAnswerAction(action),
      dependsOn: index === 0 ? [] : [`step_${actions[index - 1]}_${index}`]
    }))

    return {
      planId: createOpaqueId('plan'),
      goal: matchedIntentRules[0]?.goal || '结合最近上下文生成结构化回答',
      strategy: 'sequential',
      steps
    }
  }

  return {
    planId: createOpaqueId('plan'),
    goal: '结合最近上下文生成结构化回答',
    strategy: 'sequential',
    steps: [
      {
        stepId: 'step_read_recent_context',
        title: '读取最近上下文',
        action: 'read_recent_context',
        tool: 'context.recent',
        params: {},
        skipReview: true,
        dependsOn: []
      },
      {
        stepId: 'step_answer',
        title: '生成最终回答',
        action: 'generate_default_answer',
        tool: 'model.answer',
        params: {},
        skipReview: false,
        dependsOn: ['step_read_recent_context']
      }
    ]
  }
}

export function normalizeReasoningPlan(rawPlan, userPrompt, history, binding, contextSelection = {}) {
  const fallbackPlan = buildReasoningFallbackPlan(userPrompt, history, binding, contextSelection)
  const plan = rawPlan && typeof rawPlan === 'object' && !Array.isArray(rawPlan) ? rawPlan : {}
  const rawSteps = Array.isArray(plan.steps) ? plan.steps : []
  const normalizedSteps = []

  for (const [index, rawStep] of rawSteps.entries()) {
    const action = String(rawStep?.action || '').trim()
    const metadata = REASONING_ACTIONS[action]
    if (!metadata) continue
    const rawParams = rawStep?.params && typeof rawStep.params === 'object' && !Array.isArray(rawStep.params)
      ? rawStep.params
      : {}
    const dependsOn = Array.isArray(rawStep?.dependsOn)
      ? rawStep.dependsOn.map((item) => String(item || '').trim()).filter(Boolean)
      : []
    const normalizedStep = {
      stepId: String(rawStep?.stepId || `step_${action}_${index + 1}`).trim(),
      title: String(rawStep?.title || metadata.title).trim() || metadata.title,
      action,
      tool: metadata.tool,
      params: rawParams,
      skipReview: typeof rawStep?.skipReview === 'boolean' ? rawStep.skipReview : inferReasoningStepSkipReview({ action }),
      dependsOn: dependsOn.length > 0 ? dependsOn : (normalizedSteps.length === 0 ? [] : [normalizedSteps[normalizedSteps.length - 1].stepId])
    }
    normalizedSteps.push(normalizedStep)
  }

  const steps = normalizedSteps.length > 0
    ? normalizedSteps
    : fallbackPlan.steps.map((step) => ({
      ...step,
      skipReview: typeof step.skipReview === 'boolean' ? step.skipReview : inferReasoningStepSkipReview(step)
    }))

  return {
    planId: String(plan.planId || createOpaqueId('plan')),
    goal: String(plan.goal || fallbackPlan.goal || '生成结构化回答').trim() || '生成结构化回答',
    strategy: 'sequential',
    steps: appendReasoningMemorySyncSteps(steps, userPrompt, binding)
  }
}

export function buildReasoningAnswerMessages(history, sessionId, userPrompt, artifacts, binding, correctionPrompt = '', contextSelection = {}) {
  const directoryListing = artifacts?.directoryListing && typeof artifacts.directoryListing === 'object'
    ? artifacts.directoryListing
    : null
  const imageServiceEntrypoints = artifacts?.imageServiceEntrypoints && typeof artifacts.imageServiceEntrypoints === 'object'
    ? artifacts.imageServiceEntrypoints
    : null
  const controlBackendSurfaces = artifacts?.controlBackendSurfaces && typeof artifacts.controlBackendSurfaces === 'object'
    ? artifacts.controlBackendSurfaces
    : null
  const projectRoot = artifacts?.projectRoot || GAMESTUDIO_ROOT
  const workspaceStructure = artifacts?.workspaceStructure && typeof artifacts.workspaceStructure === 'object'
    ? artifacts.workspaceStructure
    : null
  const directoryListings = artifacts?.directoryListings && typeof artifacts.directoryListings === 'object'
    ? artifacts.directoryListings
    : null
  const projectMemory = buildProjectMemorySystemMessage(binding, userPrompt, contextSelection)
  const replayableMessages = collectReplayableHermesMessages(history, {
    excludeRequestId: sessionId,
    limit: Math.max(0, Number(binding?.workflow?.reasoningReplayWindowMessages || 0))
  })
  const workspaceSummary = workspaceStructure
    ? [
        `- 工作区根目录: ${projectRoot}`,
        workspaceStructure.appsRoot ? `- Apps 根目录: ${workspaceStructure.appsRoot}` : '',
        workspaceStructure.appRoots && typeof workspaceStructure.appRoots === 'object'
          ? `- 已发现应用目录: ${Object.entries(workspaceStructure.appRoots).map(([name, appPath]) => `${name}=${appPath}`).join(' ; ')}`
          : '',
        workspaceStructure.controlConsoleRoot ? `- Control 前端目录: ${workspaceStructure.controlConsoleRoot}` : '',
        workspaceStructure.controlServerRoot ? `- Control 后端目录: ${workspaceStructure.controlServerRoot}` : '',
        workspaceStructure.editorAppRoot ? `- Editor 应用目录: ${workspaceStructure.editorAppRoot}` : '',
        workspaceStructure.serverAppRoot ? `- 业务后端目录: ${workspaceStructure.serverAppRoot}` : '',
        workspaceStructure.storageRoot ? `- Storage 目录: ${workspaceStructure.storageRoot}` : ''
      ].filter(Boolean).join('\n')
    : ''
  const directorySummary = directoryListing
    ? [
        `- 目录路径: ${directoryListing.resolvedPath || directoryListing.dirPath || 'unknown'}`,
        `- 直接子项数量: ${Number(directoryListing.count || 0)}`,
        ...(Array.isArray(directoryListing.entries) && directoryListing.entries.length > 0
          ? directoryListing.entries.map((entry) => `  - ${entry.kind === 'directory' ? '[dir]' : '[file]'} ${entry.name}`)
          : ['  - 当前目录为空'])
      ].join('\n')
    : ''
  const directoryListingsSummary = directoryListings
    ? Object.entries(directoryListings).map(([listingName, listing]) => [
        `- 目录键: ${listingName}`,
        `  路径: ${listing.resolvedPath || listing.dirPath || 'unknown'}`,
        `  直接子项数量: ${Number(listing.count || 0)}`,
        ...(Array.isArray(listing.entries) && listing.entries.length > 0
          ? listing.entries.slice(0, 20).map((entry) => `    - ${entry.kind === 'directory' ? '[dir]' : '[file]'} ${entry.name}`)
          : ['    - 当前目录为空'])
      ].join('\n')).join('\n\n')
    : ''
  const imageEntrypointSummary = imageServiceEntrypoints
    ? [
        `- 检查目录: ${imageServiceEntrypoints.searchedRoot || 'unknown'}`,
        `- 命中入口数量: ${Number(imageServiceEntrypoints.count || 0)}`,
        ...(Array.isArray(imageServiceEntrypoints.entries)
          ? imageServiceEntrypoints.entries.slice(0, 8).map((entry) => `  - ${entry.filePath} | ${entry.role}`)
          : [])
      ].join('\n')
    : ''
  const controlBackendSummary = controlBackendSurfaces
    ? [
        `- 检查目录: ${controlBackendSurfaces.searchedRoot || 'unknown'}`,
        `- 命中入口数量: ${Number(controlBackendSurfaces.count || 0)}`,
        ...(Array.isArray(controlBackendSurfaces.entries)
          ? controlBackendSurfaces.entries.slice(0, 8).map((entry) => `  - ${entry.filePath} | ${entry.role}`)
          : [])
      ].join('\n')
    : ''
  const fileContents = artifacts?.fileContents && typeof artifacts.fileContents === 'object'
    ? artifacts.fileContents
    : null
  const fileContentsSummary = fileContents
    ? Object.entries(fileContents).map(([filePath, content]) => {
        const relativePath = normalizeWorkspaceRelativePath(path.relative(GAMESTUDIO_ROOT, filePath)) || normalizeWorkspaceRelativePath(filePath)
        return [
          `文件: ${relativePath}`,
          '内容:',
          String(content || '')
        ].join('\n')
      }).join('\n\n')
    : ''
  const latestEvidenceSummary = !directorySummary && !imageEntrypointSummary && !controlBackendSummary && artifacts?.latestStepReviewEvidence?.rawResponsePreview
    ? String(artifacts.latestStepReviewEvidence.rawResponsePreview)
    : ''
  const observableBlocks = [workspaceSummary, directoryListingsSummary || directorySummary, imageEntrypointSummary, controlBackendSummary, fileContentsSummary, latestEvidenceSummary].filter(Boolean)

  return [
    {
      role: 'system',
      content: buildHermesRuntimeSystemMessage(binding)
    },
    {
      role: 'system',
      content: projectMemory.message
    },
    {
      role: 'system',
      content: [
        'You are Hermes Manager inside GameStudio control.',
        'Use the nearby conversation and injected markdown project memory together with the structured execution artifacts below.',
        'If the latest user request corrects an earlier wrong answer, prefer the newest request and the latest observable artifacts.',
        'Do not claim hidden reasoning. Summarize the observable steps and then answer directly in Chinese.',
        'Do not ask to read, scan, inspect, or verify again when the executed artifacts already contain the result.',
        'If the artifacts include a project list or story index, enumerate the projects directly with concrete IDs and available titles/counts.',
        'Do not say "让我继续读取" or any equivalent defer/next-step phrasing unless the artifacts are genuinely missing.',
        `Workspace root: ${projectRoot}`,
        correctionPrompt ? `Review correction: ${correctionPrompt}` : '',
        'If the tool result is empty, say so plainly.'
      ].filter(Boolean).join('\n')
    },
    ...replayableMessages,
    {
      role: 'user',
      content: [
        `用户问题: ${userPrompt}`,
        '',
        '可观测工具结果：',
        observableBlocks.length > 0 ? observableBlocks.join('\n\n') : '- 当前没有可用的结构化工具结果。'
      ].join('\n')
    }
  ]
}

export function buildReasoningFallbackAnswer(userPrompt, artifacts) {
  const directoryListings = artifacts?.directoryListings && typeof artifacts.directoryListings === 'object'
    ? artifacts.directoryListings
    : null
  if (directoryListings && Object.keys(directoryListings).length > 0) {
    const blocks = Object.entries(directoryListings).map(([listingName, listing]) => {
      const entries = Array.isArray(listing.entries) ? listing.entries : []
      const lines = entries.length > 0
        ? entries.map((entry, index) => `${index + 1}. ${entry.kind === 'directory' ? '[dir]' : '[file]'} ${entry.name}`)
        : ['当前目录为空。']
      return [
        `## ${listingName}`,
        `路径：${listing.resolvedPath || listing.dirPath || listingName}`,
        `直接子项数量：${entries.length}`,
        lines.join('\n')
      ].join('\n')
    })
    return [
      '根据当前可观测目录扫描结果，列表包含以下直接子项：',
      blocks.join('\n\n'),
      '以上只包含已执行 list_directory_contents 返回的直接子项，不包含递归展开。',
      `本次问题：${userPrompt}`
    ].join('\n\n')
  }

  const directoryListing = artifacts?.directoryListing && typeof artifacts.directoryListing === 'object'
    ? artifacts.directoryListing
    : null
  if (directoryListing?.resolvedPath) {
    const entries = Array.isArray(directoryListing.entries) ? directoryListing.entries : []
    const lines = entries.length > 0
      ? entries.map((entry, index) => `${index + 1}. ${entry.kind === 'directory' ? '[dir]' : '[file]'} ${entry.name}`)
      : ['当前目录为空。']
    return [
      `根据当前工作区可观测结果，${directoryListing.resolvedPath} 下共有 ${entries.length} 个直接子项：`,
      lines.join('\n'),
      '这是目录直接子项清单，不包含递归扫描结果。'
    ].join('\n\n')
  }

  if (artifacts?.latestStepReviewEvidence?.rawResponsePreview) {
    return [
      '当前使用本地可观测结果生成直接回答。',
      String(artifacts.latestStepReviewEvidence.rawResponsePreview),
      `本次问题：${userPrompt}`
    ].filter(Boolean).join('\n\n')
  }

  return [
    '当前没有足够的可观测结构化结果可直接回答。',
    `本次问题：${userPrompt}`
  ].join('\n\n')
}
