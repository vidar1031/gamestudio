import fs from 'node:fs'
import path from 'node:path'

import { HERMES_CONFIG_ROOT } from '../../config/paths.js'
import {
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
} from './heuristics.js'
import { isProjectCapabilityStatusPrompt } from '../workflows/projectStatusWorkflows.js'

const RULE_TABLE_PATH = path.join(HERMES_CONFIG_ROOT, 'routing', 'request_classification_rules.json')

const WRITE_OR_INVOKE_PATTERN = /写入|修改|编辑|删除|重命名|落盘|应用修改|执行脚本|运行脚本|重启|启动|停止|恢复|暂停|调用接口|run script|execute script|restart|start|stop|delete|rename|edit|write/i
const WRITE_OR_INVOKE_NEGATIVE_PATTERN = /是否|为什么|解释|说明|检查|分析|能否|可否/i
const STORY_WORKFLOW_PATTERN = /创建.*故事|新建.*故事|生成.*故事|生产.*故事|故事项目|互动故事|项目配置|生成配置|配置.*落盘|生成结果|生成失败|写回|导出失败|导出成功|项目目录|导出产物|结构校验|资源引用|项目执行|interactive story|story workflow|一口气|完整.*故事|故事.*闭环|大纲|脚本|分镜|资产|出图|导出项目|export project|validate project|锁定测试|事物锁定测试|锁定.*事物|事物.*锁定|lock.?test|lock_test|编译|合成|blueprint|compose/i
const STORY_WORKFLOW_ACTION_PATTERN = /创建|新建|生成|生产|配置|写入|读取|检查|确认|说明|校验|验证|导出|制作|产出|转换|转成|构建|执行|运行|测试|create|generate|produce|configure|validate|export|convert|build|execute|run|test|编译|合成|compile|compose/i
const GAMESTUDIO_BOOTSTRAP_PATTERN = /(?:gamestudio|game studio|游戏工作室).*(?:启动|打开|界面|工作台|editor|workbench|ai[-_\s]?create[-_\s]?story|自检|检查|配置|comfyui|本地模型|local model|diagnose|preflight|bootstrap|settings)|(?:启动|打开|open|launch|自检|配置).*(?:gamestudio|game studio|游戏工作室)/i
const CONTEXTUAL_PLAN_PATTERN = /继续|接着|按照|基于|根据|上面|之前|刚才|这个设计|这套方案|实施|推进|修复|落地|同步文档|计划|规划|方案|检查|分析/i
const ANSWER_ONLY_PATTERN = /是什么|为什么|解释|说明|区别|含义|原理|建议|是否合理|会不会有问题|对不对|what|why|explain|suggest|reasonable|^在吗|^(hi|hello|hey|hiya)\b|^你好|^您好|^早上好|^下午好|^晚上好/i
// 咨询问句形态：吗/呢/么 结尾或带问号、能不能/能否/可以…吗/会不会/是不是/是什么/为什么/如何/先回答/先告诉我 等。
// 注意「吧」结尾多为祈使（如"创建故事吧"），不算咨询形态。
const CONSULTATIVE_QUESTION_PATTERN = /[吗呢么][？?]|[吗呢][？?！!。.…]*$|能不能|能否|可否|可不可以|会不会|该不该|是不是|是什么|为什么|为何|怎么样|如何|先回答|先告诉我|先说明|先解释/i

function normalizePrompt(value) {
  return String(value || '').replace(/\s+/g, ' ').trim()
}

// 问句形态判定（导出供单测与上层复用）。
export function isConsultativeQuestionPrompt(prompt) {
  const text = normalizePrompt(prompt)
  if (!text) return false
  return CONSULTATIVE_QUESTION_PATTERN.test(text)
}

function loadRuleTable() {
  const raw = fs.readFileSync(RULE_TABLE_PATH, 'utf8')
  const parsed = JSON.parse(raw)
  const rules = Array.isArray(parsed?.rules) ? parsed.rules.slice().sort((left, right) => Number(right.priority || 0) - Number(left.priority || 0)) : []
  return {
    rules,
    fallback: parsed?.fallback || {
      requestType: 'contextual_plan_answer',
      reason: 'rule_table_unmatched',
      needsContext: true,
      route: 'plan_then_answer'
    }
  }
}

function matchesDetector(detector, prompt) {
  if (!prompt) return false
  switch (detector) {
    case 'write_or_invoke_review':
      return WRITE_OR_INVOKE_PATTERN.test(prompt) && !WRITE_OR_INVOKE_NEGATIVE_PATTERN.test(prompt)
    case 'story_workflow_execute':
      return STORY_WORKFLOW_PATTERN.test(prompt) && STORY_WORKFLOW_ACTION_PATTERN.test(prompt)
    case 'gamestudio_bootstrap_execute':
      return GAMESTUDIO_BOOTSTRAP_PATTERN.test(prompt)
    case 'contextual_plan_answer':
      return CONTEXTUAL_PLAN_PATTERN.test(prompt)
    case 'project_structure_inspection':
      return isProjectStructureInspectionPrompt(prompt)
    case 'project_listing':
      return isProjectListingPrompt(prompt)
    case 'file_inspection':
      return isWorkspaceFileQuestionPrompt(prompt) || inferWorkspaceFilesFromPrompt(prompt).length > 0
    case 'directory_inspection':
      return isWorkspaceDirectoryQuestionPrompt(prompt)
    case 'directory_listing':
      return isDirectoryListingPrompt(prompt) && inferWorkspaceDirectoriesFromPromptText(prompt).length > 0
    case 'surface_location':
      return isControlLocationPrompt(prompt) || isEditorLocationPrompt(prompt) || isBusinessServerLocationPrompt(prompt)
    case 'capability_status_inspection':
      return isProjectCapabilityStatusPrompt(prompt)
    case 'answer_only':
      return ANSWER_ONLY_PATTERN.test(prompt)
    default:
      return false
  }
}

export function inferRouteForType(type) {
  if (type === 'capability_status_inspection') return 'inspect_then_answer'
  if (type === 'gamestudio_bootstrap_execute') return 'workflow_execute'
  if (type === 'story_workflow_execute') return 'workflow_execute'
  if (type === 'write_or_invoke_review') return 'write_or_invoke_review'
  if (type === 'answer_only') return 'answer_only'
  return 'plan_then_answer'
}

export function listRequestClassificationRules() {
  return loadRuleTable().rules
}

export function classifyReasoningRequestFromRuleTable(userPrompt, options = {}) {
  const prompt = normalizePrompt(userPrompt)
  const productionTest = Boolean(options.contextSelection?.productionTest)
  const { rules, fallback } = loadRuleTable()

  if (!prompt) {
    return {
      type: 'answer_only',
      confidence: 0.4,
      reason: 'empty_prompt',
      route: 'answer_only',
      needsContext: false,
      requiresHumanReview: false,
      deterministicPlan: false,
      modelDecision: false,
      ruleId: null,
    }
  }

  if (isProjectCapabilityStatusPrompt(prompt)) {
    return {
      type: 'capability_status_inspection',
      confidence: 0.98,
      reason: 'project_capability_status_prompt',
      route: 'inspect_then_answer',
      needsContext: false,
      requiresHumanReview: false,
      deterministicPlan: true,
      modelDecision: false,
      ruleId: 'R009_capability_status_inspection',
    }
  }

  // 问句形态优先于关键词强制（2026-08-19 用户明确指令，取舍记录见 ai/memory/DECISIONS.md）：
  // 咨询问句即使命中 story/bootstrap 工作流关键词（如"可以使用gamestudio创建故事…吗？"），
  // 也先走 answer_only 咨询路径（滚动压缩探索），不触发生产副作用；
  // 祈使句（"创建/生成/开始/执行…"）维持 ai/AGENTS.md 硬性生产规则第 2 条的强制工作流不变。
  if (isConsultativeQuestionPrompt(prompt)) {
    const forcedWorkflowType = matchesDetector('story_workflow_execute', prompt)
      ? 'story_workflow_execute'
      : (matchesDetector('gamestudio_bootstrap_execute', prompt) ? 'gamestudio_bootstrap_execute' : null)
    if (forcedWorkflowType) {
      return {
        type: 'answer_only',
        confidence: 0.97,
        reason: `consultative_question_form_overrides_${forcedWorkflowType}`,
        route: 'answer_only',
        needsContext: false,
        requiresHumanReview: false,
        deterministicPlan: false,
        modelDecision: false,
        ruleId: 'R013_consultative_question_form',
      }
    }
  }

  for (const rule of rules) {
    if (!matchesDetector(String(rule.detector || ''), prompt)) continue
    const type = String(rule.requestType || '').trim()
    return {
      type,
      confidence: productionTest && type === 'contextual_plan_answer' ? 0.78 : 0.96,
      reason: String(rule.reason || `${rule.ruleId || 'rule'}_matched`),
      route: String(rule.route || inferRouteForType(type)),
      needsContext: Boolean(rule.needsContext),
      requiresHumanReview: Boolean(rule.requiresHumanReview),
      deterministicPlan: Boolean(rule.deterministicPlan),
      modelDecision: false,
      ruleId: String(rule.ruleId || '').trim() || null,
    }
  }

  return {
    type: String(fallback.requestType || 'contextual_plan_answer'),
    confidence: productionTest ? 0.78 : 0.5,
    reason: String(fallback.reason || 'rule_table_unmatched'),
    route: String(fallback.route || 'plan_then_answer'),
    needsContext: Boolean(fallback.needsContext),
    requiresHumanReview: false,
    deterministicPlan: false,
    modelDecision: false,
    ruleId: null,
  }
}