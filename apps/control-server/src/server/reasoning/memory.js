import path from 'node:path'

import { GAMESTUDIO_ROOT } from '../../config/paths.js'
import {
  isReasoningAnswerAction,
  isReasoningInvokeAction,
  isReasoningWriteAction,
  REASONING_ACTIONS,
} from '../capabilities/actionRegistry.js'
import {
  isWorkspaceDirectoryQuestionPrompt,
  isWorkspaceFileQuestionPrompt,
} from './heuristics.js'
import { buildProjectMemorySystemMessage } from '../controlServerCore.js'

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
  if (isWorkspaceFileQuestionPrompt(normalizedPrompt)) return false
  if (isWorkspaceDirectoryQuestionPrompt(normalizedPrompt)) return false
  const asksForWorkflowClosure = /修复|fix|更新|rewrite|重写|整理|补全|闭环|同步|写回|写入|落盘|维护|清理|迁移|删除|创建|生成|配置|执行|运行|run|create|write|edit|delete|rename/i.test(normalizedPrompt)
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
        content: 'Refresh ai/memory/STATUS.md after this run. Keep sections 当前目标 / 当前结果 / 当前阻塞 / 下一步. Remove stale items and summarize the latest observable project state plus this run\'s completed fixes and remaining verification work.'
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
        content: 'Rewrite ai/memory/TASK_QUEUE.md so it keeps only active short tasks after this run. Remove completed items, keep the next concrete verification and follow-up tasks, and preserve concise acceptance criteria.'
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
        content: 'Refresh ai/memory/DECISIONS.md with only stable rules validated by this run. Remove temporary progress notes. Keep decisions about runtime memory injection, daily log selection, review boundaries, and control/Hermes workflow behavior when they are newly established or corrected.'
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
        content: 'Refresh ai/memory/LONG_TASKS.md so it reflects the current long-running end-to-end workflow closure. Keep only stable multi-session tracks, update milestones and completion standards, and remove obsolete long-horizon items.'
      },
      skipReview: false,
      dependsOn: []
    })
  }

  if (syncSteps.length === 0) return steps

  let answerIndex = -1
  for (let index = 0; index < steps.length; index += 1) {
    if (isReasoningAnswerAction(steps[index].action)) {
      answerIndex = index
      break
    }
  }

  const beforeAnswer = answerIndex >= 0 ? steps.slice(0, answerIndex) : [...steps]
  const answerAndAfter = answerIndex >= 0 ? steps.slice(answerIndex) : []
  let previousStepId = beforeAnswer.length > 0 ? beforeAnswer[beforeAnswer.length - 1].stepId : ''
  const chainedSyncSteps = syncSteps.map((step) => {
    const nextStep = {
      ...step,
      dependsOn: previousStepId ? [previousStepId] : []
    }
    previousStepId = nextStep.stepId
    return nextStep
  })

  if (answerAndAfter.length > 0) {
    answerAndAfter[0] = {
      ...answerAndAfter[0],
      dependsOn: previousStepId ? [previousStepId] : answerAndAfter[0].dependsOn
    }
  }

  return [...beforeAnswer, ...chainedSyncSteps, ...answerAndAfter]
}
