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

function normalizePrompt(value) {
  return String(value || '').replace(/\s+/g, ' ').trim()
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