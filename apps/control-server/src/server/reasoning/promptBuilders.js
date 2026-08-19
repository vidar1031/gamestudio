import fs from 'node:fs'
import path from 'node:path'

import {
  GAMESTUDIO_ROOT,
} from '../../config/paths.js'
import {
  REASONING_ACTIONS,
  REASONING_ALLOWED_ACTION_NAMES,
  isReasoningAnswerAction,
  isReasoningInvokeAction,
  isReasoningStoryWorkflowAction,
  isReasoningWriteAction,
} from '../capabilities/actionRegistry.js'
import { resolveWorkspacePathFromInput } from '../workspace/inspectors.js'
import {
  buildGameStudioBootstrapPlan,
  isGameStudioBootstrapPrompt,
} from '../workflows/gameStudioBootstrapWorkflows.js'
import {
  buildProjectCapabilityStatusPlan,
  isProjectCapabilityStatusPrompt,
} from '../workflows/projectStatusWorkflows.js'
import { buildStoryWorkflowPlan } from '../workflows/storyProductionWorkflows.js'
import {
  inferWorkspaceDirectoryFromPrompt,
  inferWorkspaceDirectoriesFromPromptText,
  inferWorkspaceFilesFromPrompt,
  isBusinessServerLocationPrompt,
  isControlLocationPrompt,
  isDirectoryListingPrompt,
  isEditorLocationPrompt,
  isProjectListingPrompt,
  isProjectStructureInspectionPrompt,
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

function estimateTokensFromMessages(messages) {
  return messages.reduce((sum, m) => sum + Math.ceil(String(m.content || '').length / 2), 0)
}

function compressPlannerMessages(messages, contextLength) {
  if (!contextLength || contextLength <= 0) return messages
  const threshold = Math.floor(contextLength * 0.75)
  let tokens = estimateTokensFromMessages(messages)
  if (tokens <= threshold) return messages

  const systemMessages = messages.filter((m) => m.role === 'system')
  const historyMessages = messages.filter((m) => m.role !== 'system')

  while (tokens > threshold && historyMessages.length > 2) {
    const removed = historyMessages.shift()
    if (removed) tokens -= Math.ceil(String(removed.content || '').length / 2)
    if (historyMessages.length <= 1) break
  }

  return [...systemMessages, ...historyMessages]
}

export function buildReasoningPlannerMessages(history, userPrompt, binding, correctionPrompt = '', contextSelection = {}, priorArtifacts = null) {
  const projectMemory = buildReasoningPlannerProjectMemory(binding, userPrompt, contextSelection)
  const replayWindowMessages = Math.max(0, Number(binding?.workflow?.reasoningReplayWindowMessages || 0))
  const replayableMessages = collectReplayableHermesMessages(history, {
    limit: replayWindowMessages,
    userPrompt,
    forceCarryover: Boolean(contextSelection?.forceContextReplay || contextSelection?.requestDecision?.needsContext)
  })
  const allowedActionsText = REASONING_ALLOWED_ACTION_NAMES.join(', ')
  const matchedIntentRules = getMatchingReasoningIntentRules(userPrompt, history, binding, contextSelection)
  const hintedActionsText = [...new Set(matchedIntentRules.flatMap((rule) => [...(rule.requiredActions || []), rule.answerAction]).filter(Boolean))].join(', ')
  const previousDraft = buildPriorDraftSummary(priorArtifacts)

  const rawMessages = [
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
        'The latest user request is the source of truth for the plan goal. Treat replayed conversation as optional context, not as the task to execute.',
        'Before using replayed conversation, classify whether it is directly related to the latest user request. Use it only when the user explicitly continues, compares, repeats, corrects, or refers to prior work.',
        'If the latest request names a concrete module, directory, file, workflow, or test case, plan for that explicit target even if replayed history contains a different target.',
        'If the latest request repeats an earlier question, run the normal evidence-gathering workflow again; do not copy or drift from the earlier answer unless current artifacts support it.',
        contextSelection?.requestDecision?.needsContext ? 'The request classification layer has marked this request as context-dependent. You must use directly relevant replayed conversation and project memory when choosing the target object or scope.' : '',
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
        'For run_lifecycle_script: params must contain "scriptName" (one of: restart_control.sh, restart_server.sh, reporter.sh).',
        'For read_file_content: params must contain "filePath" (relative to workspace).',
        'For list_directory_contents: params must contain "dirPath" and may also use legacy "startDir" for compatibility.',
        'For search_workspace_text: params must contain "query" and may contain "startDir" and "maxResults".',
        'For create_workspace_file: params must contain "filePath" and "content".',
        'For rename_workspace_path: params must contain "fromPath" and "toPath".',
        'For delete_workspace_path: params must contain "targetPath".',
        'For run_workspace_script: params must contain "scriptPath" (workspace-relative and under allowed roots).',
        'For web_search: params must contain "query" (search keywords) and optionally "limit" (number of results, 1-20, default 5).',
        'For web_extract: params must contain "urls" (a string URL or an array of URLs, max 5).',
        'For shell_execute: params must contain "command" (shell command string) and optionally "timeoutMs" (default 30000, max 120000).',
        'For vision_analyze: params must contain "imagePath" (local path or URL) and optionally "question" (default "描述这张图片").',
        'For git_status: no params required.',
        'For git_diff: params may contain "filePath" (optional, default all changes).',
        'For git_log: params may contain "maxCount" (optional, default 10, max 50).',
        'For git_branch: no params required.',
        'For test_run: params may contain "command" (optional, auto-detects npm test / pytest / jest) and "timeoutMs" (default 60000).',
        'For mcp_call: params must contain "serverName" and "toolName", and optionally "args" (object).',
        'Schema: {"goal": string, "strategy": "sequential", "steps": [{"title": string, "action": string, "params": object, "skipReview": boolean?}]}'
      ].join('\n')
    },
    ...replayableMessages,
    {
      role: 'user',
      content: [
        `当前用户问题：${userPrompt}`,
        correctionPrompt ? `审核修正条件：${correctionPrompt}` : '',
        previousDraft ? `上一轮候选答案（仅作修订草稿，不能当作已验证事实）：\n${previousDraft}` : '',
        '',
        '请基于最近上下文和已注入的 markdown 项目记忆，输出严格 JSON plan。'
      ].filter(Boolean).join('\n')
    }
  ]

  const contextLength = Number(binding?.contextLength || 0)
  const messages = contextLength > 0 ? compressPlannerMessages(rawMessages, contextLength) : rawMessages

  return {
    projectMemory,
    replayableMessages,
    messages
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

function isMetaAnalysisPrompt(userPrompt) {
  const text = String(userPrompt || '').toLowerCase()
  return text.includes('元分析')
    || text.includes('meta analysis')
    || text.includes('meta-analysis')
    || text.includes('系统分析')
    || text.includes('分析系统')
    || text.includes('系统诊断')
    || text.includes('运行分析')
    || text.includes('系统健康')
    || text.includes('会话分析')
    || text.includes('错误分析')
    || text.includes('性能分析')
    || text.includes('性能瓶颈')
    || text.includes('性能诊断')
    || text.includes('会话统计')
    || text.includes('任务分析')
    || text.includes('运行状态')
    || text.includes('诊断系统')
}

function inferMetaAnalysisScope(userPrompt) {
  const text = String(userPrompt || '').toLowerCase()
  if (text.includes('错误') || text.includes('失败') || text.includes('error') || text.includes('fail')) return 'errors'
  if (text.includes('性能') || text.includes('performance') || text.includes('瓶颈') || text.includes('慢')) return 'performance'
  if (text.includes('会话') || text.includes('session') || text.includes('任务')) return 'sessions'
  return 'overview'
}

export function buildReasoningFallbackPlan(userPrompt, history, binding, contextSelection = {}) {
  if (isProjectCapabilityStatusPrompt(userPrompt)) {
    return buildProjectCapabilityStatusPlan(userPrompt)
  }

  if (isGameStudioBootstrapPrompt(userPrompt) || contextSelection?.requestDecision?.type === 'gamestudio_bootstrap_execute') {
    return buildGameStudioBootstrapPlan(userPrompt)
  }

  if (contextSelection?.requestDecision?.type === 'story_workflow_execute') {
    return buildStoryWorkflowPlan(userPrompt)
  }

  if (isProjectStructureInspectionPrompt(userPrompt)) {
    return {
      planId: createOpaqueId('plan'),
      goal: '先识别一个现有项目，再检查其顶层目录及配置、故事内容、资源、导出产物是否存在',
      strategy: 'sequential',
      steps: [
        {
          stepId: 'step_list_projects_directory',
          title: '列出 storage/projects 当前项目列表',
          action: 'list_directory_contents',
          tool: 'workspace.listDirectory',
          params: { dirPath: 'storage/projects' },
          skipReview: true,
          dependsOn: []
        },
        {
          stepId: 'step_generate_project_structure_answer',
          title: '基于项目列表与上下文生成项目结构检查回答',
          action: 'generate_default_answer',
          tool: 'model.answer',
          params: {},
          skipReview: true,
          dependsOn: ['step_list_projects_directory']
        }
      ]
    }
  }

  if (isProjectListingPrompt(userPrompt)) {
    return {
      planId: createOpaqueId('plan'),
      goal: '列出 storage/projects 当前已有项目',
      strategy: 'sequential',
      steps: [
        {
          stepId: 'step_list_projects_directory',
          title: '列出 storage/projects 目录内容',
          action: 'list_directory_contents',
          tool: 'workspace.listDirectory',
          params: { dirPath: 'storage/projects' },
          skipReview: true,
          dependsOn: []
        },
        {
          stepId: 'step_generate_projects_answer',
          title: '生成当前项目列表回答',
          action: 'generate_default_answer',
          tool: 'model.answer',
          params: {},
          skipReview: true,
          dependsOn: ['step_list_projects_directory']
        }
      ]
    }
  }

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

  if (isMetaAnalysisPrompt(userPrompt)) {
    const scope = inferMetaAnalysisScope(userPrompt)
    return {
      planId: createOpaqueId('plan'),
      goal: '对 Control 系统运行状态进行元分析',
      strategy: 'sequential',
      steps: [
        {
          stepId: 'step_meta_analysis',
          title: '系统元分析',
          action: 'meta_analysis',
          tool: 'model.metaAnalysis',
          params: { scope },
          skipReview: true,
          dependsOn: []
        }
      ]
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
  const constrainedSteps = sanitizeReasoningPlanSteps(steps, fallbackPlan.steps, userPrompt, contextSelection)
  const executableSteps = sanitizeProductionTestSteps(constrainedSteps, fallbackPlan.steps, contextSelection)

  return {
    planId: String(plan.planId || createOpaqueId('plan')),
    goal: String(plan.goal || fallbackPlan.goal || '生成结构化回答').trim() || '生成结构化回答',
    strategy: 'sequential',
    steps: appendReasoningMemorySyncSteps(executableSteps, userPrompt, binding, contextSelection)
  }
}

function sanitizeReasoningPlanSteps(steps, fallbackSteps, userPrompt, contextSelection = {}) {
  const readOnlyPrompt = isLikelyReadOnlyReasoningPrompt(userPrompt)
  const allowStoryWorkflow = contextSelection?.requestDecision?.type === 'story_workflow_execute'
  const filteredSteps = []

  for (const step of steps) {
    let normalizedStep = step

    if ((contextSelection?.productionTest || readOnlyPrompt)
      && (isReasoningWriteAction(normalizedStep.action) || isReasoningInvokeAction(normalizedStep.action))
      && !(allowStoryWorkflow && isReasoningStoryWorkflowAction(normalizedStep.action))) {
      continue
    }

    if (normalizedStep.action === 'list_directory_contents') {
      const dirPath = String(normalizedStep.params?.dirPath || normalizedStep.params?.startDir || '').trim()
      if (!isExistingWorkspaceDirectory(dirPath)) continue
    }

    if (normalizedStep.action === 'read_file_content') {
      const filePath = String(normalizedStep.params?.filePath || '').trim()
      if (!isExistingWorkspaceFile(filePath)) continue
      if (isProjectMemoryFile(filePath) && !shouldAllowProjectMemoryRead(userPrompt, filePath)) continue
    }

    if (normalizedStep.action === 'search_workspace_text') {
      const startDir = String(normalizedStep.params?.startDir || '').trim()
      if (startDir && !isExistingWorkspaceDirectory(startDir)) {
        normalizedStep = {
          ...normalizedStep,
          params: {
            ...normalizedStep.params,
            startDir: '.'
          }
        }
      }
    }

    filteredSteps.push(normalizedStep)
  }

  const safeSteps = filteredSteps.some((step) => isReasoningAnswerAction(step.action))
    ? filteredSteps
    : fallbackSteps.map((step) => ({
      ...step,
      skipReview: typeof step.skipReview === 'boolean' ? step.skipReview : inferReasoningStepSkipReview(step)
    }))

  return safeSteps.map((step, index) => ({
    ...step,
    dependsOn: index === 0 ? [] : [safeSteps[index - 1].stepId]
  }))
}

function sanitizeProductionTestSteps(steps, fallbackSteps, contextSelection = {}) {
  if (!contextSelection?.productionTest) return steps
  const allowStoryWorkflow = contextSelection?.requestDecision?.type === 'story_workflow_execute'
  const filteredSteps = steps.filter((step) => {
    if (allowStoryWorkflow && isReasoningStoryWorkflowAction(step.action)) return true
    return !isReasoningWriteAction(step.action) && !isReasoningInvokeAction(step.action)
  })
  const safeSteps = filteredSteps.some((step) => isReasoningAnswerAction(step.action))
    ? filteredSteps
    : fallbackSteps.map((step) => ({
      ...step,
      skipReview: typeof step.skipReview === 'boolean' ? step.skipReview : inferReasoningStepSkipReview(step)
    }))

  return safeSteps.map((step, index) => ({
    ...step,
    dependsOn: index === 0 ? [] : [safeSteps[index - 1].stepId]
  }))
}

export function isLikelyReadOnlyReasoningPrompt(userPrompt) {
  const text = String(userPrompt || '')
  if (!text.trim()) return true
  return !/(创建|新建|写入|修改|编辑|删除|重命名|导出|更新|写回|落盘|执行脚本|运行脚本|重启|启动|停止|恢复|暂停)/i.test(text)
}

function isExistingWorkspaceDirectory(targetPath) {
  const resolvedPath = resolveWorkspacePathFromInput(targetPath)
  return Boolean(resolvedPath)
    && resolvedPath.startsWith(GAMESTUDIO_ROOT)
    && fs.existsSync(resolvedPath)
    && fs.statSync(resolvedPath).isDirectory()
}

function isExistingWorkspaceFile(targetPath) {
  const resolvedPath = resolveWorkspacePathFromInput(targetPath)
  return Boolean(resolvedPath)
    && resolvedPath.startsWith(GAMESTUDIO_ROOT)
    && fs.existsSync(resolvedPath)
    && fs.statSync(resolvedPath).isFile()
}

function isProjectMemoryFile(filePath) {
  const normalizedPath = normalizeWorkspaceRelativePath(filePath)
  return /^ai\/memory\//.test(normalizedPath)
}

function shouldAllowProjectMemoryRead(userPrompt, filePath) {
  const normalizedPrompt = String(userPrompt || '')
  const normalizedPath = normalizeWorkspaceRelativePath(filePath)
  if (!normalizedPath) return false
  if (normalizedPrompt.includes(normalizedPath) || normalizedPrompt.includes(path.basename(normalizedPath))) return true
  return /项目状态|当前状态|当前进度|当前焦点|待办|任务队列|长任务|状态|进度|阻塞|决策|任务|下一步|memory|记忆/i.test(normalizedPrompt)
}

function compactPromptJson(value, maxLength = 1200) {
  const text = JSON.stringify(value, null, 2)
  if (text.length <= maxLength) return text
  return `${text.slice(0, maxLength)}\n...[truncated]`
}

function compactStoryWorkflowResult(result) {
  if (!result || typeof result !== 'object') return null
  const evidence = result.evidence && typeof result.evidence === 'object' ? result.evidence : null
  const snapshot = result.snapshot && typeof result.snapshot === 'object' ? result.snapshot : null
  const evaluator = result.evaluator && typeof result.evaluator === 'object' ? result.evaluator : null
  return {
    action: result.action || null,
    ok: Boolean(result.ok),
    status: result.status || null,
    summary: result.summary || null,
    projectId: result.projectId || evidence?.projectId || snapshot?.projectId || null,
    endpoint: result.endpoint || null,
    serverStatus: result.serverStatus || null,
    failedStage: result.failedStage || null,
    retryable: Boolean(result.retryable),
    evidence: evidence ? {
      projectDirRelative: evidence.projectDirRelative || null,
      fileNames: Array.isArray(evidence.fileNames) ? evidence.fileNames : [],
      distUrl: evidence.distUrl || null,
      distPathRelative: evidence.distPathRelative || null,
      distExists: Boolean(evidence.distExists),
      exportedAt: evidence.exportedAt || evidence.distMtime || null
    } : null,
    evaluator: evaluator ? {
      name: evaluator.name || null,
      passed: Boolean(evaluator.passed),
      checks: evaluator.checks || null,
      missing: Array.isArray(evaluator.missing) ? evaluator.missing : undefined
    } : null,
    snapshot: snapshot ? {
      projectDirRelative: snapshot.projectDirRelative || null,
      fileNames: Array.isArray(snapshot.fileNames) ? snapshot.fileNames : [],
      title: snapshot.project?.title || snapshot.meta?.title || null,
      generationConfig: snapshot.project?.generationConfig || null,
      assetCount: Number(snapshot.project?.assetCount || 0),
      characterCount: Number(snapshot.project?.characterCount || 0),
      scriptCards: Number(snapshot.scripts?.cardCount || 0),
      blueprintNodes: Number(snapshot.blueprint?.nodeCount || 0),
      placeholderCount: Number(snapshot.blueprint?.placeholderCount || 0),
      storyNodes: Number(snapshot.story?.nodeCount || 0),
      latestDistRelative: snapshot.exports?.latestDistRelative || null,
      latestDistExists: Boolean(snapshot.exports?.latestDistExists),
      latestDistMtime: snapshot.exports?.latestDistMtime || null
    } : null
  }
}

export function buildStoryWorkflowDeterministicAnswer(userPrompt, artifacts) {
  const storyProduction = artifacts?.storyProduction && typeof artifacts.storyProduction === 'object'
    ? artifacts.storyProduction
    : null
  if (!storyProduction) return ''
  const lastResult = compactStoryWorkflowResult(storyProduction.lastResult)
  const steps = storyProduction.steps && typeof storyProduction.steps === 'object'
    ? Object.entries(storyProduction.steps).map(([stepId, result]) => ({ stepId, result: compactStoryWorkflowResult(result) }))
    : []
  const projectId = lastResult?.projectId || storyProduction.currentProjectId || storyProduction.lastProjectId || 'unknown'
  const evidence = lastResult?.evidence || {}
  const snapshot = lastResult?.snapshot || {}
  const evaluator = lastResult?.evaluator || {}
  const failedSteps = steps.filter((item) => item.result && item.result.ok === false)
  const stepLines = steps.length
    ? steps.map((item) => `- ${item.stepId}: ${item.result?.ok ? 'PASS' : 'FAIL'} ${item.result?.summary || ''}${item.result?.failedStage ? `；failedStage=${item.result.failedStage}` : ''}`).join('\n')
    : '- 当前没有记录到 story workflow step。'
  const exportLine = evidence.distUrl || snapshot.latestDistRelative
    ? [
        `- 导出 URL: ${evidence.distUrl || '未返回'}`,
        `- 导出路径: ${evidence.distPathRelative || snapshot.latestDistRelative || '未返回'}`,
        `- 导出存在: ${evidence.distExists || snapshot.latestDistExists ? '是' : '否'}`,
        `- 导出时间: ${evidence.exportedAt || snapshot.latestDistMtime || '未返回'}`
      ].join('\n')
    : '- 导出证据: 当前步骤未返回导出产物。'
  return [
    `结论：${lastResult?.ok ? '本次 story workflow 步骤已通过。' : '本次 story workflow 返回了明确失败边界。'}`,
    '',
    '项目证据：',
    `- projectId: ${projectId}`,
    `- 项目目录: ${evidence.projectDirRelative || snapshot.projectDirRelative || '未返回'}`,
    `- 顶层子项: ${Array.isArray(evidence.fileNames) && evidence.fileNames.length ? evidence.fileNames.join(', ') : (Array.isArray(snapshot.fileNames) ? snapshot.fileNames.join(', ') : '未返回')}`,
    `- scripts 卡片数: ${snapshot.scriptCards ?? '未返回'}`,
    `- blueprint 节点数: ${snapshot.blueprintNodes ?? '未返回'}`,
    `- story 节点数: ${snapshot.storyNodes ?? '未返回'}`,
    `- 资源数: ${snapshot.assetCount ?? '未返回'}；角色数: ${snapshot.characterCount ?? '未返回'}`,
    '',
    '执行步骤：',
    stepLines,
    '',
    '校验摘要：',
    `- evaluator: ${evaluator.name || '未返回'}`,
    `- passed: ${evaluator.passed ? 'true' : 'false'}`,
    lastResult?.failedStage ? `- failedStage: ${lastResult.failedStage}` : '- failedStage: 无',
    `- retryable: ${lastResult?.retryable ? 'true' : 'false'}`,
    '',
    '导出证据：',
    exportLine,
    '',
    failedSteps.length
      ? `失败边界：${failedSteps.map((item) => `${item.stepId}/${item.result?.failedStage || 'unknown'}`).join('；')}`
      : '失败边界：未发现失败步骤。',
    '',
    `回答依据：Control story workflow artifacts。用户问题：${String(userPrompt || '').trim()}`
  ].join('\n')
}

function compactGameStudioBootstrapResult(result) {
  if (!result || typeof result !== 'object') return null
  return {
    action: result.action || null,
    ok: Boolean(result.ok),
    summary: result.summary || '',
    failedStage: result.failedStage || null,
    retryable: Boolean(result.retryable),
    evaluator: result.evaluator ? {
      name: result.evaluator.name || null,
      passed: Boolean(result.evaluator.passed),
      checks: result.evaluator.checks || null
    } : null,
    data: result.data ? {
      editorUrl: result.data.editorUrl || result.data?.editorHealth?.url || null,
      serverBaseUrl: result.data.serverBaseUrl || null,
      healthOk: result.data?.health?.ok ?? result.data?.serverHealth?.ok ?? null,
      imageProvider: result.data?.settings?.effective?.image?.provider || result.data?.preflight?.checks?.provider || null,
      preflightReason: result.data?.preflight?.checks?.reason || null
    } : null
  }
}

export function buildGameStudioBootstrapDeterministicAnswer(userPrompt, artifacts) {
  const bootstrap = artifacts?.gameStudioBootstrap && typeof artifacts.gameStudioBootstrap === 'object'
    ? artifacts.gameStudioBootstrap
    : null
  if (!bootstrap) return ''
  const lastResult = compactGameStudioBootstrapResult(bootstrap.lastResult)
  const steps = bootstrap.steps && typeof bootstrap.steps === 'object'
    ? Object.entries(bootstrap.steps).map(([stepId, result]) => ({ stepId, result: compactGameStudioBootstrapResult(result) }))
    : []
  const failedSteps = steps.filter((item) => item.result && item.result.ok === false)
  const stepLines = steps.length
    ? steps.map((item) => `- ${item.stepId}: ${item.result?.ok ? 'PASS' : 'FAIL'} ${item.result?.summary || ''}${item.result?.failedStage ? `；failedStage=${item.result.failedStage}` : ''}`).join('\n')
    : '- 当前没有记录到 GameStudio bootstrap step。'
  const selfCheck = steps.find((item) => item.result?.action === 'gamestudio_self_check')?.result || lastResult
  const checks = selfCheck?.evaluator?.checks || {}
  return [
    `结论：${selfCheck?.ok ? 'GameStudio 启动与自检已通过。' : 'GameStudio 启动或自检返回明确阻断。'}`,
    '',
    '界面与服务：',
    `- Editor URL: ${steps.find((item) => item.result?.data?.editorUrl)?.result?.data?.editorUrl || 'http://localhost:8868'}`,
    `- Server URL: ${steps.find((item) => item.result?.data?.serverBaseUrl)?.result?.data?.serverBaseUrl || 'http://127.0.0.1:1999'}`,
    '',
    '执行步骤：',
    stepLines,
    '',
    '自检摘要：',
    `- healthOk: ${checks.healthOk === undefined ? '未返回' : String(Boolean(checks.healthOk))}`,
    `- settingsOk: ${checks.settingsOk === undefined ? '未返回' : String(Boolean(checks.settingsOk))}`,
    `- diagnoseOk: ${checks.diagnoseOk === undefined ? '未返回' : String(Boolean(checks.diagnoseOk))}`,
    `- imagePreflightOk: ${checks.imagePreflightOk === undefined ? '未返回' : String(Boolean(checks.imagePreflightOk))}`,
    `- imageProvider: ${checks.imageProvider || '未返回'}`,
    checks.preflightReason ? `- preflightReason: ${checks.preflightReason}` : '- preflightReason: 无',
    '',
    failedSteps.length
      ? `失败边界：${failedSteps.map((item) => `${item.stepId}/${item.result?.failedStage || 'unknown'}`).join('；')}`
      : '失败边界：未发现失败步骤。',
    '',
    `回答依据：Control gameStudioBootstrap artifacts。用户问题：${String(userPrompt || '').trim()}`
  ].join('\n')
}

function getProductionTestExpectationTerms(contextSelection = {}) {
  const explicitTerms = contextSelection?.expectations && typeof contextSelection.expectations === 'object'
    ? [
        ...(Array.isArray(contextSelection.expectations.requireAll) ? contextSelection.expectations.requireAll : []),
        ...(Array.isArray(contextSelection.expectations.requireAny) ? contextSelection.expectations.requireAny.slice(0, 2) : [])
      ]
    : []
  if (explicitTerms.length > 0) return explicitTerms

  const caseId = String(contextSelection?.caseId || '').trim()
  if (caseId === 'L1-21') return ['用户目标', 'story workflow', 'artifact', 'evaluator', '达标程度', 'Hermes', 'OMLX', '未达标', '部分达标']
  if (caseId === 'L1-22') return ['heartbeat', 'orphan', 'recover', 'UI', '达标程度', 'Hermes', 'OMLX', '部分达标', '未达标']
  if (caseId === 'L1-23') return ['correctionPrompt', '_inbox', 'proposal', '人工', '达标程度', 'Hermes', 'OMLX', '不会', '不得']
  return []
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
    limit: Math.max(0, Number(binding?.workflow?.reasoningReplayWindowMessages || 0)),
    userPrompt
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
  const workspaceSearches = artifacts?.workspaceSearches && typeof artifacts.workspaceSearches === 'object'
    ? artifacts.workspaceSearches
    : (artifacts?.workspaceSearch && typeof artifacts.workspaceSearch === 'object' ? { workspaceSearch: artifacts.workspaceSearch } : null)
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
  const workspaceSearchSummary = workspaceSearches
    ? Object.entries(workspaceSearches).map(([searchName, search]) => {
        const matches = Array.isArray(search.matches) ? search.matches : []
        return [
          `搜索: ${searchName}`,
          `query: ${search.query || ''}`,
          `startDir: ${search.startDir || ''}`,
          `命中数量: ${Number(search.count || matches.length || 0)}`,
          ...matches.slice(0, 16).map((match) => `  - ${match.filePath}:${match.lineNumber || 0} ${String(match.preview || match.line || '').trim()}`)
        ].filter(Boolean).join('\n')
      }).join('\n\n')
    : ''
  const storyProduction = artifacts?.storyProduction && typeof artifacts.storyProduction === 'object'
    ? artifacts.storyProduction
    : null
  const storyProductionSummary = storyProduction
    ? [
        `Story workflow currentProjectId: ${storyProduction.currentProjectId || storyProduction.lastProjectId || 'unknown'}`,
        storyProduction.lastResult ? `Last result: ${compactPromptJson(compactStoryWorkflowResult(storyProduction.lastResult), 1800)}` : '',
        storyProduction.steps && typeof storyProduction.steps === 'object'
          ? `Step results:\n${Object.entries(storyProduction.steps).map(([stepId, result]) => `- ${stepId}: ${result?.ok ? 'PASS' : 'FAIL'} ${result?.summary || ''}${result?.failedStage ? ` failedStage=${result.failedStage}` : ''}`).join('\n')}`
          : '',
        storyProduction.scriptsCandidate
          ? `Scripts candidate cards: ${Array.isArray(storyProduction.scriptsCandidate.cards) ? storyProduction.scriptsCandidate.cards.length : 0}`
          : ''
      ].filter(Boolean).join('\n')
    : ''
  const gameStudioBootstrap = artifacts?.gameStudioBootstrap && typeof artifacts.gameStudioBootstrap === 'object'
    ? artifacts.gameStudioBootstrap
    : null
  const gameStudioBootstrapSummary = gameStudioBootstrap
    ? [
        'GameStudio bootstrap:',
        gameStudioBootstrap.lastResult ? `Last result: ${compactPromptJson(compactGameStudioBootstrapResult(gameStudioBootstrap.lastResult), 1800)}` : '',
        gameStudioBootstrap.steps && typeof gameStudioBootstrap.steps === 'object'
          ? `Step results:\n${Object.entries(gameStudioBootstrap.steps).map(([stepId, result]) => `- ${stepId}: ${result?.ok ? 'PASS' : 'FAIL'} ${result?.summary || ''}${result?.failedStage ? ` failedStage=${result.failedStage}` : ''}`).join('\n')}`
          : ''
      ].filter(Boolean).join('\n')
    : ''
  const latestEvidenceSummary = !directorySummary && !imageEntrypointSummary && !controlBackendSummary && artifacts?.latestStepReviewEvidence?.rawResponsePreview
    ? String(artifacts.latestStepReviewEvidence.rawResponsePreview)
    : ''
  const observableBlocks = [workspaceSummary, directoryListingsSummary || directorySummary, imageEntrypointSummary, controlBackendSummary, fileContentsSummary, workspaceSearchSummary, storyProductionSummary, gameStudioBootstrapSummary, latestEvidenceSummary].filter(Boolean)
  const previousDraft = correctionPrompt ? buildPriorDraftSummary(artifacts) : ''
  const requireModelAnswer = Boolean(contextSelection?.requireModelAnswer || contextSelection?.requireHermesModelAnswer)
  const productionCaseId = String(contextSelection?.caseId || '').trim()
  const expectationTerms = contextSelection?.expectations && typeof contextSelection.expectations === 'object'
    ? [
        ...(Array.isArray(contextSelection.expectations.requireAll) ? contextSelection.expectations.requireAll : []),
        ...(Array.isArray(contextSelection.expectations.requireAny) ? contextSelection.expectations.requireAny.slice(0, 2) : [])
      ].map((item) => String(item || '').trim()).filter(Boolean)
    : []
  const l1ProductionKeywords = expectationTerms.length > 0
    ? `本次是 ${productionCaseId || 'production'} 门禁。最终回答必须自然包含这些字面词：${[...new Set(expectationTerms)].join('、')}。这些是术语覆盖要求，不代表新增事实。`
    : ''
  const runtimeFactBlock = requireModelAnswer
    ? [
        '当前运行事实（这是本次回答必须遵守的硬约束，不得否认）：',
        `- 当前正在为 runtime session ${sessionId} 生成最终回答。`,
        `- 当前回答由 Hermes Manager 在 control 内生成，并通过 ${String(binding?.provider || 'unknown').trim() || 'unknown'} / ${String(binding?.model || 'unknown').trim() || 'unknown'} 路由执行。`,
        '- 如果当前回答成功返回，它本身就是本次 agent-runtime session 的可观测最终回答。',
        '- 你必须区分两件事：',
        '  1. 本次回答链路是否已经经过 Hermes / OMLX。',
        '  2. 整个系统是否已经实现从用户目标到 story workflow 交付的生产闭环。',
        '- 允许判断系统整体仍未达标，但不得否认本次回答已经通过当前 runtime session 调用 Hermes / OMLX 的事实。'
      ].join('\n')
    : ''

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
        'The latest user request is the answer target. Replayed conversation may explain context, but it must not override the latest request or the latest structured artifacts.',
        'Only carry facts forward from history when the latest user request explicitly refers to prior work, repeats the same target, asks for comparison, or asks to continue. Otherwise, answer from current artifacts and project memory.',
        'When history and current artifacts conflict, trust current artifacts and state the current evidence plainly.',
        'If the latest user request corrects an earlier wrong answer, prefer the newest request and the latest observable artifacts.',
        'If a previous draft answer is provided, treat it as a reusable draft only. Keep any useful structure, but remove or rewrite claims that are not supported by the current observable artifacts.',
        'Do not claim hidden reasoning. Summarize the observable steps and then answer directly in Chinese.',
        'If the latest user request contains Chinese, the final answer must be written in Chinese. Do not use English section headings or opening sentences.',
        requireModelAnswer ? 'This request requires a model-backed final answer. Do not claim that the current answer did not pass through the current runtime session, Hermes, or the configured provider/model unless the request actually failed.' : '',
        l1ProductionKeywords,
        'Only say a file was read, inspected, or used as evidence if it appears in the current structured file contents below.',
        'Directory listings prove direct child names only; they do not prove unread file contents inside those child directories.',
        'Do not mention previous versions, retries, quality scoring, calibration samples, or internal review loops in the final answer unless the user explicitly asked about those internals.',
        'Do not ask to read, scan, inspect, or verify again when the executed artifacts already contain the result.',
        'If the artifacts include a project list or story index, enumerate the projects directly with concrete IDs and available titles/counts.',
        'Do not say "让我继续读取" or any equivalent defer/next-step phrasing unless the artifacts are genuinely missing.',
        `Workspace root: ${projectRoot}`,
        runtimeFactBlock,
        correctionPrompt ? `Review correction: ${correctionPrompt}` : '',
        'If the tool result is empty, say so plainly.'
      ].filter(Boolean).join('\n')
    },
    ...replayableMessages,
    {
      role: 'user',
      content: [
        `用户问题: ${userPrompt}`,
        '输出语言要求：中文。不要用英文标题或英文开场。',
        '最终回答必须完整写入回复正文；不要只输出思考过程。引用的记忆文件无法直接读取时，基于已注入的信息直接作答。',
        l1ProductionKeywords,
        previousDraft ? `上一轮候选答案（仅可复用其结构，不可直接视为证据）:\n${previousDraft}` : '',
        '',
        '可观测工具结果：',
        observableBlocks.length > 0 ? observableBlocks.join('\n\n') : '- 当前没有可用的结构化工具结果。'
      ].join('\n')
    }
  ]
}

function buildPriorDraftSummary(artifacts) {
  const previousAnswer = String(artifacts?.finalAnswer || '').trim()
  if (!previousAnswer) return ''

  const assessment = artifacts?.latestAnswerAssessment && typeof artifacts.latestAnswerAssessment === 'object'
    ? artifacts.latestAnswerAssessment
    : null
  const assessmentSummary = assessment
    ? [
        assessment.summary ? `上一轮质检摘要：${String(assessment.summary).trim()}` : '',
        Array.isArray(assessment.issues) && assessment.issues.length > 0
          ? `上一轮主要问题：${assessment.issues.map((item) => String(item || '').trim()).filter(Boolean).slice(0, 4).join('；')}`
          : ''
      ].filter(Boolean).join('\n')
    : ''

  const draft = previousAnswer.length > 1800
    ? `${previousAnswer.slice(0, 1800)}\n...[truncated]`
    : previousAnswer

  return [assessmentSummary, draft].filter(Boolean).join('\n\n')
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

export function buildSupervisionPrompt(data, scorecard) {
  const systemMessage = `你是一名 Control 系统监督专家。你的职责是：
1. 评估左脑（本地 OMLX 模型）的任务执行质量
2. 识别失败模式和根因
3. 生成具体、可执行的修正建议
4. 判断哪些修正可以自动执行，哪些需要人工确认

评分标准：
- 系统自检（20%）：基础服务可用性（OMLX、GameStudio Server、Control Server、ComfyUI）
- 故事生产（30%）：核心业务功能完整性（项目存在、ComfyUI 可达）
- 推理执行（25%）：任务分解与执行成功率（reasoning sessions 成功比例）
- 记忆管理（10%）：状态文件维护质量（STATUS.md、TASK_QUEUE.md 等时效性）
- 配置路由（10%）：架构配置正确性（默认路由=omlx、meta_analysis 路由存在）
- 可观测性（5%）：日志与事件完整性（agent-runtime-events、服务日志时效性）

修正指令格式要求（必须在返回的 JSON 代码块中）：
{
  "correctionId": "corr-xxx",
  "priority": "P0|P1|P2",
  "category": "对应失败类别id",
  "issue": "问题描述",
  "rootCause": "根因分析",
  "actions": [
    { "step": 1, "type": "command|verify|retry_task|review", "description": "...", "command": "...", "reviewRequired": false }
  ],
  "estimatedFixTime": "x 分钟",
  "rollbackPlan": "..."
}

重要规则：
- 只读操作（检查状态、读取日志）reviewRequired = false，可自动执行
- 修改配置、删除文件、重启服务等 reviewRequired = true，必须人工确认
- 如果评分 >= 90 且全部通过，只返回简短结论，不生成修正指令`

  const userContent = `请基于以下系统运行数据生成监督评估报告和修正指令：

## 评分卡
${JSON.stringify(scorecard, null, 2)}

## 原始数据摘要
- 服务探测: OMLX=${data.services.omlx.ok}, Server=${data.services.gamestudioServer.ok}, Control=${data.services.controlServer.ok}, ComfyUI=${data.services.comfyui.ok}
- Sessions: 总计${data.sessions.totalCount}, 成功${data.sessions.successCount}, 失败${data.sessions.failedCount}, 最近24h=${data.sessions.last24hCount}
- 记忆文件: ${Object.entries(data.memory).map(([k,v]) => `${k}=${v.exists ? '存在' : '缺失'}(${Math.round(v.ageHours)}h)`).join(', ')}
- 配置: 默认路由=${data.config.defaultRoute}, meta_analysis路由=${data.config.hasMetaAnalysisRoute}, 右脑启用=${data.config.rightBrainEnabled}
- 项目数: ${data.projects.count}

请输出：
1. 总体评估结论（2-3句话）
2. 失败项的根因分析
3. 可执行的修正指令（JSON 代码块格式）`

  return [
    { role: 'system', content: systemMessage },
    { role: 'user', content: userContent },
  ]
}
