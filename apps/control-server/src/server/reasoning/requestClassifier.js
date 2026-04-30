import {
  inferWorkspaceDirectoriesFromPromptText,
  inferWorkspaceFilesFromPrompt,
  isBusinessServerLocationPrompt,
  isControlLocationPrompt,
  isDirectoryListingPrompt,
  isEditorLocationPrompt,
  isProjectListingPrompt,
  isWorkspaceDirectoryQuestionPrompt,
  isWorkspaceFileQuestionPrompt,
} from './heuristics.js'
import { isProjectCapabilityStatusPrompt } from '../workflows/projectStatusWorkflows.js'

export const REASONING_REQUEST_DECISION_TYPES = [
  'project_listing',
  'directory_listing',
  'file_inspection',
  'directory_inspection',
  'surface_location',
  'capability_status_inspection',
  'story_workflow_execute',
  'write_or_invoke_review',
  'contextual_plan_answer',
  'answer_only'
]

const WRITE_OR_INVOKE_PATTERN = /写入|修改|编辑|删除|重命名|落盘|应用修改|执行脚本|运行脚本|重启|启动|停止|恢复|暂停|调用接口|run script|execute script|restart|start|stop|delete|rename|edit|write/i
const STORY_WORKFLOW_PATTERN = /创建.*故事|新建.*故事|生成.*故事|故事项目|互动故事|interactive story|story workflow|大纲|脚本|分镜|资产|出图|导出项目|export project|validate project/i
const CONTEXTUAL_PLAN_PATTERN = /继续|接着|按照|基于|根据|上面|之前|刚才|这个设计|这套方案|实施|推进|修复|落地|同步文档|计划|规划|方案|检查|分析/i
const ANSWER_ONLY_PATTERN = /是什么|为什么|解释|说明|区别|含义|原理|建议|是否合理|会不会有问题|对不对|what|why|explain|suggest|reasonable/i

function normalizePrompt(value) {
  return String(value || '').replace(/\s+/g, ' ').trim()
}

function makeDecision(type, confidence, reason, overrides = {}) {
  return {
    type,
    confidence,
    reason,
    route: overrides.route || inferRouteForType(type),
    needsContext: Boolean(overrides.needsContext),
    requiresHumanReview: Boolean(overrides.requiresHumanReview),
    deterministicPlan: Boolean(overrides.deterministicPlan),
    modelDecision: Boolean(overrides.modelDecision)
  }
}

function inferRouteForType(type) {
  if (type === 'capability_status_inspection') return 'inspect_then_answer'
  if (type === 'story_workflow_execute') return 'workflow_execute'
  if (type === 'write_or_invoke_review') return 'write_or_invoke_review'
  if (type === 'answer_only') return 'answer_only'
  return 'plan_then_answer'
}

export function classifyReasoningRequest(userPrompt, options = {}) {
  const prompt = normalizePrompt(userPrompt)
  if (!prompt) {
    return makeDecision('answer_only', 0.4, 'empty_prompt', { route: 'answer_only' })
  }

  const productionTest = Boolean(options.contextSelection?.productionTest)

  if (WRITE_OR_INVOKE_PATTERN.test(prompt) && !/是否|为什么|解释|说明|检查|分析|能否|可否/.test(prompt)) {
    return makeDecision('write_or_invoke_review', 0.95, 'explicit_mutation_or_invoke_request', {
      requiresHumanReview: true,
      needsContext: true
    })
  }

  if (STORY_WORKFLOW_PATTERN.test(prompt) && /创建|新建|生成|配置|校验|验证|导出|制作|产出|create|generate|configure|validate|export/i.test(prompt)) {
    return makeDecision('story_workflow_execute', 0.9, 'story_project_automation_request', {
      needsContext: true
    })
  }

  if (isProjectCapabilityStatusPrompt(prompt)) {
    return makeDecision('capability_status_inspection', 0.96, 'project_capability_status_prompt', {
      deterministicPlan: true,
      needsContext: false
    })
  }

  if (isProjectListingPrompt(prompt)) {
    return makeDecision('project_listing', 0.94, 'project_listing_prompt', {
      deterministicPlan: true
    })
  }

  if (isWorkspaceFileQuestionPrompt(prompt) || inferWorkspaceFilesFromPrompt(prompt).length > 0) {
    return makeDecision('file_inspection', 0.9, 'workspace_file_prompt', {
      deterministicPlan: true
    })
  }

  if (isWorkspaceDirectoryQuestionPrompt(prompt)) {
    return makeDecision('directory_inspection', 0.88, 'workspace_directory_question_prompt', {
      deterministicPlan: true
    })
  }

  if (isDirectoryListingPrompt(prompt) && inferWorkspaceDirectoriesFromPromptText(prompt).length > 0) {
    return makeDecision('directory_listing', 0.88, 'directory_listing_prompt', {
      deterministicPlan: true
    })
  }

  if (isControlLocationPrompt(prompt) || isEditorLocationPrompt(prompt) || isBusinessServerLocationPrompt(prompt)) {
    return makeDecision('surface_location', 0.86, 'workspace_surface_location_prompt', {
      deterministicPlan: true
    })
  }

  if (CONTEXTUAL_PLAN_PATTERN.test(prompt)) {
    return makeDecision('contextual_plan_answer', productionTest ? 0.78 : 0.62, 'contextual_or_planning_prompt', {
      needsContext: true
    })
  }

  if (ANSWER_ONLY_PATTERN.test(prompt)) {
    return makeDecision('answer_only', 0.72, 'general_explanation_prompt', {
      route: 'answer_only'
    })
  }

  return makeDecision('contextual_plan_answer', 0.5, 'unknown_prompt_shape', {
    needsContext: true
  })
}

export function shouldAskModelForRequestDecision(decision, options = {}) {
  if (options.contextSelection?.productionTest) return false
  if (!decision || decision.confidence >= 0.85) return false
  if (decision.type === 'write_or_invoke_review') return false
  return true
}

export function shouldUseDeterministicPlanForDecision(decision) {
  return Boolean(decision?.deterministicPlan)
}

export function buildReasoningRequestDecisionMessages(userPrompt) {
  return [
    {
      role: 'system',
      content: [
        'You are the request decision layer for the GameStudio Control Server.',
        'Classify the latest user request. Do not answer the user request. Do not plan tool steps.',
        'Use only the decision rules and the latest question. Do not require project context at this stage.',
        'Return one strict JSON object only.',
        `Allowed type values: ${REASONING_REQUEST_DECISION_TYPES.join(', ')}.`,
        'Rules:',
        '- project_listing: asks what projects exist under storage/projects.',
        '- directory_listing: asks what files/subdirectories exist in a workspace directory.',
        '- file_inspection: asks role/content/purpose of named workspace files.',
        '- directory_inspection: asks role/content/purpose of named workspace directories.',
        '- surface_location: asks where editor/control/server surfaces live.',
        '- capability_status_inspection: asks whether project capabilities, workflow registry, evaluator coverage, automation state machine, Hermes role, GameStudio Server role, tagging reliability, or short/mid-term gaps are complete/current/covered.',
        '- story_workflow_execute: asks to create/configure/generate/validate/export an interactive story project.',
        '- write_or_invoke_review: asks to write/edit/delete/rename files or run/restart/start/stop scripts/services.',
        '- contextual_plan_answer: needs prior context, plan reasoning, or current-session continuity before answer.',
        '- answer_only: ordinary conceptual explanation that does not need workspace evidence.',
        'Schema: {"type": string, "confidence": number, "reason": string}'
      ].join('\n')
    },
    {
      role: 'user',
      content: `Question: ${normalizePrompt(userPrompt)}`
    }
  ]
}

export function parseReasoningRequestDecision(rawText, fallbackDecision) {
  const raw = String(rawText || '').trim()
  const firstBrace = raw.indexOf('{')
  const lastBrace = raw.lastIndexOf('}')
  if (firstBrace < 0 || lastBrace <= firstBrace) return fallbackDecision

  try {
    const parsed = JSON.parse(raw.slice(firstBrace, lastBrace + 1))
    const type = String(parsed?.type || '').trim()
    if (!REASONING_REQUEST_DECISION_TYPES.includes(type)) return fallbackDecision
    const confidence = Math.max(0, Math.min(1, Number(parsed?.confidence || 0)))
    return makeDecision(type, confidence || 0.6, String(parsed?.reason || 'model_request_decision'), {
      needsContext: type === 'contextual_plan_answer' || type === 'story_workflow_execute',
      requiresHumanReview: type === 'write_or_invoke_review',
      deterministicPlan: type === 'capability_status_inspection',
      modelDecision: true
    })
  } catch {
    return fallbackDecision
  }
}