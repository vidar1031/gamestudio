import path from 'node:path'

import { GAMESTUDIO_ROOT } from '../../config/paths.js'
import {
  isReasoningInvokeAction,
  isReasoningWriteAction,
  REASONING_ACTIONS,
} from '../capabilities/actionRegistry.js'
import {
  isWorkspaceDirectoryQuestionPrompt,
  isWorkspaceFileQuestionPrompt,
} from './heuristics.js'
import { buildProjectMemorySystemMessage } from '../controlServerCore.js'

// 权威记忆文件拒绝写入的内容模式：指令/模板/空白/刷新请求
const MEMORY_GARBAGE_PATTERNS = [
  /^[\s]*$/,
  /刷新本文件|Refresh this file|Rewrite this file|refresh this file|rewrite this file/i,
  /^[\s]*Refresh\s+/i,
  /^[\s]*Rewrite\s+/i,
  /^[\s]*请刷新/i,
  /^[\s]*请重写/i,
  /^(#+\s*)?(Refresh|Rewrite|刷新|重写)/i
]

export function isGarbageMemoryContent(content) {
  const text = String(content || '')
  if (!text.trim()) return true
  return MEMORY_GARBAGE_PATTERNS.some((pattern) => pattern.test(text))
}

export function assertAuthoritativeMemoryContent(content, context = '') {
  if (isGarbageMemoryContent(content)) {
    throw new Error(`authoritative_memory_rejected_garbage:${context || 'unknown'}`)
  }
}

export function buildReasoningRecentContextArtifact(projectMemory, replayableMessages, plannerSource) {
  return {
    replayedMessageCount: replayableMessages.length,
    selectedMemorySources: projectMemory.selectedSources.map((source) => ({
      label: source.label,
      filePath: source.filePath,
      exists: source.exists,
      truncated: Boolean(source.truncated)
    })),
    loadedMemorySources: projectMemory.loadedSources.map((source) => ({
      label: source.label,
      filePath: source.filePath,
      loadedChars: source.loadedChars,
      totalChars: source.totalChars,
      truncated: Boolean(source.truncated)
    })),
    plannerSource
  }
}

const REASONING_PLANNER_DEFAULT_MEMORY_LABELS = new Set([
  'Project Memory',
  'Long Tasks',
  'Project Status',
  'Task Queue',
  'Decisions',
  'Latest Daily Log'
])

export function selectReasoningPlannerSources(projectMemory) {
  const selectedSources = Array.isArray(projectMemory?.selectedSources) ? projectMemory.selectedSources : []
  return selectedSources.filter((source) => {
    if (!source) return false
    if (source.kind === 'skill') return true
    return REASONING_PLANNER_DEFAULT_MEMORY_LABELS.has(source.label)
  })
}

export function buildReasoningPlannerProjectMemory(binding, userPrompt, options = {}) {
  const projectMemory = buildProjectMemorySystemMessage(binding, userPrompt, options)
  const selectedSources = selectReasoningPlannerSources(projectMemory)
  const loadedSources = selectedSources.filter((source) => source.exists && source.content)
  const message = [
    'GameStudio execution memory below is injected by the control plane for reasoning-plan generation.',
    'Use these markdown records together with the nearby conversation to decide the next observable execution steps.',
    'Treat explicitly selected skills as planner rules for routing, review, and observable constraints.',
    'Do not use agent identity or persona files when creating the plan unless they also appear in the nearby conversation.'
  ]

  for (const source of loadedSources) {
    message.push(`\n[${source.label}] ${source.filePath}`)
    message.push(source.content)
  }

  return {
    ...projectMemory,
    message: message.join('\n'),
    selectedSources,
    loadedSources
  }
}

export function shouldAppendReasoningMemorySync(steps, userPrompt, options = {}) {
  if (options?.disableMemorySync || options?.productionTest) return false
  const normalizedPrompt = String(userPrompt || '').trim()
  const hasMutatingWork = steps.some((step) => isReasoningWriteAction(step.action) || isReasoningInvokeAction(step.action))
  if (hasMutatingWork) return true
  const requestType = String(options?.requestDecision?.type || '').trim()
  if ([
    'project_listing',
    'project_structure_inspection',
    'directory_listing',
    'file_inspection',
    'directory_inspection',
    'surface_location',
    'capability_status_inspection'
  ].includes(requestType)) {
    return false
  }
  if (isWorkspaceFileQuestionPrompt(normalizedPrompt)) return false
  if (isWorkspaceDirectoryQuestionPrompt(normalizedPrompt)) return false
  const readOnlyCapabilityQuestion = /包含哪些|有哪些|是什么|是否|当前|说明|分析|解释|列出|查看|检查/i.test(normalizedPrompt)
    && /workflow|工作流|能力链条|目标能力|evaluator|评估器|registry|intent|状态机|自动化|Hermes|GameStudio Server|关键词|打标签|可靠性/i.test(normalizedPrompt)
  if (readOnlyCapabilityQuestion) return false
  const asksForWorkflowClosure = /修复|fix|更新|rewrite|重写|整理|补全|闭环|同步|写回|写入|落盘|维护|清理|迁移|删除|配置/i.test(normalizedPrompt)
  return hasMutatingWork || asksForWorkflowClosure
}

export function appendReasoningMemorySyncSteps(steps, userPrompt, binding, options = {}) {
  if (!shouldAppendReasoningMemorySync(steps, userPrompt, options)) return steps

  const normalizedPrompt = String(userPrompt || '').trim()
  const existingTaskQueueSync = steps.some((step) => step.action === 'update_task_queue')
  const existingStatusSync = steps.some((step) => step.action === 'write_memory_file' && String(step.params?.filePath || '').includes('STATUS.md'))
  const existingDecisionSync = steps.some((step) => step.action === 'write_memory_file' && String(step.params?.filePath || '').includes('DECISIONS.md'))
  const existingLongTaskSync = steps.some((step) => step.action === 'write_memory_file' && String(step.params?.filePath || '').includes('LONG_TASKS.md'))
  const needsDecisionSync = /规则|决策|约束|配置|修复|闭环|runtime|control|hermes|日志|注入/i.test(normalizedPrompt)
  const needsLongTaskSync = /长任务|主线|长期|workflow|闭环|端到端|故事项目|资产|配置|交付/i.test(normalizedPrompt)

  const syncSteps = []
  if (!existingStatusSync) {
    syncSteps.push({
      stepId: 'step_sync_status_memory',
      title: '同步当前状态记录',
      action: 'write_memory_file',
      tool: REASONING_ACTIONS['write_memory_file'].tool,
      params: {
        filePath: path.relative(GAMESTUDIO_ROOT, binding.memory.statusFile),
        content: '根据本次会话的观察结果，生成并更新 ai/memory/STATUS.md 的完整内容。必须包含：当前目标、当前结果、当前阻塞、下一步。只写入可观测事实，不得只返回刷新指令。'
      },
      skipReview: false,
      dependsOn: []
    })
  }
  if (!existingTaskQueueSync) {
    syncSteps.push({
      stepId: 'step_sync_task_queue_memory',
      title: '同步短任务队列',
      action: 'update_task_queue',
      tool: REASONING_ACTIONS['update_task_queue'].tool,
      params: {
        replaceAll: true,
        content: '根据本次会话的完成情况，生成并更新 ai/memory/TASK_QUEUE.md 的完整内容。保留未完成的活跃短任务和后续验证项，移除已完成项，不得只返回重写指令。'
      },
      skipReview: false,
      dependsOn: []
    })
  }
  if (needsDecisionSync && !existingDecisionSync) {
    syncSteps.push({
      stepId: 'step_sync_decisions_memory',
      title: '同步稳定决策记录',
      action: 'write_memory_file',
      tool: REASONING_ACTIONS['write_memory_file'].tool,
      params: {
        filePath: path.relative(GAMESTUDIO_ROOT, binding.memory.decisionsFile),
        content: '如果本次会话确立了新的稳定决策，生成并更新 ai/memory/DECISIONS.md 的完整内容；否则保持原有决策不变。只写入已验证的规则，不得只返回刷新指令。'
      },
      skipReview: false,
      dependsOn: []
    })
  }
  if (needsLongTaskSync && !existingLongTaskSync) {
    syncSteps.push({
      stepId: 'step_sync_long_tasks_memory',
      title: '同步长任务主线',
      action: 'write_memory_file',
      tool: REASONING_ACTIONS['write_memory_file'].tool,
      params: {
        filePath: path.relative(GAMESTUDIO_ROOT, binding.memory.longTasksFile),
        content: '根据本次会话进展，生成并更新 ai/memory/LONG_TASKS.md 的完整内容。保留稳定的多 session 长任务主线，更新里程碑和验收标准，移除已过时项，不得只返回刷新指令。'
      },
      skipReview: false,
      dependsOn: []
    })
  }

  if (syncSteps.length === 0) return steps

  // 2026-08-24 修复（多轮交互"卡住"根因）：记忆同步是辅助簿记，不得作为回答的前置闸门。
  // 旧实现把同步步骤插在回答之前，模型重写挂起/失败会让用户连回答都拿不到；
  // 现改为追加在回答之后执行，并标记 bestEffort——超时/失败只留证据，session 仍以回答正常完成。
  const nextSteps = [...steps]
  let previousStepId = nextSteps.length > 0 ? nextSteps[nextSteps.length - 1].stepId : ''
  for (const step of syncSteps) {
    const chained = {
      ...step,
      bestEffort: true,
      dependsOn: previousStepId ? [previousStepId] : []
    }
    nextSteps.push(chained)
    previousStepId = chained.stepId
  }
  return nextSteps
}
