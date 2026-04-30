import { REASONING_ACTIONS } from '../capabilities/actionRegistry.js'

const CAPABILITY_STATUS_KEYWORDS = /当前|是否|已经|覆盖|完整|建立|具备|承担|缺口|目标能力|能力链条|可靠性主体|状态机|workflow|evaluator|registry|intent|Hermes|Control Server|GameStudio Server|关键词/i
const CAPABILITY_STATUS_TARGETS = /workflow|工作流|evaluator|评估器|deterministic|registry|intent|状态机|自动化|Hermes|候选计划|候选解释|GameStudio Server|项目读写|导出|关键词|打标签|可靠性|能力链条|短期缺口|中期.*缺口/i

const STORY_WORKFLOW_TERMS = [
  'create_story_project',
  'configure_story_project',
  'generate_story_outline',
  'generate_story_scripts',
  'generate_story_assets',
  'validate_project',
  'export_project',
  'deterministic evaluator',
  'workflow registry'
]

function createPlanId() {
  return `plan_${Date.now()}_${Math.random().toString(16).slice(2, 10)}`
}

function makeStep(stepId, title, action, params = {}, dependsOn = []) {
  return {
    stepId,
    title,
    action,
    tool: REASONING_ACTIONS[action]?.tool || 'workspace.tool',
    params,
    skipReview: true,
    dependsOn
  }
}

function normalizePrompt(value) {
  return String(value || '').replace(/\s+/g, ' ').trim()
}

export function isProjectCapabilityStatusPrompt(userPrompt) {
  const prompt = normalizePrompt(userPrompt)
  if (!prompt) return false
  if (!CAPABILITY_STATUS_KEYWORDS.test(prompt)) return false
  return CAPABILITY_STATUS_TARGETS.test(prompt)
}

function buildCapabilitySearchQuery(userPrompt) {
  const prompt = normalizePrompt(userPrompt)
  const explicitTerms = []

  if (/workflow|工作流|能力链条|闭环/i.test(prompt)) explicitTerms.push('workflow', 'story workflow', ...STORY_WORKFLOW_TERMS)
  if (/evaluator|评估器|deterministic|覆盖/i.test(prompt)) explicitTerms.push('deterministic evaluator', 'evaluateReasoning', 'evaluateAnswer', 'workflow')
  if (/registry|intent|建立/i.test(prompt)) explicitTerms.push('workflow registry', 'intent registry', 'config/hermes/intents', 'activeIntentFiles')
  if (/状态机|自动化/i.test(prompt)) explicitTerms.push('Control Server', '状态机', 'project automation', 'agent-runtime-sessions')
  if (/Hermes|候选计划|候选解释/i.test(prompt)) explicitTerms.push('Hermes', '候选计划', '候选答案', 'candidate')
  if (/GameStudio Server|项目读写|导出|apps\/server/i.test(prompt)) explicitTerms.push('GameStudio Server', '项目读写', '导出', 'apps/server')
  if (/关键词|打标签|可靠性主体/i.test(prompt)) explicitTerms.push('关键词', '打标签', '可靠性主体', 'action schema', 'artifact')
  if (/缺口|短期|中期/i.test(prompt)) explicitTerms.push('缺口', '未完成', 'BLOCKED', 'workflow registry')

  const compactPromptTerms = prompt
    .split(/[^A-Za-z0-9_\-/\u4e00-\u9fff]+/)
    .map((item) => item.trim())
    .filter((item) => item.length >= 3)
    .slice(0, 8)

  return [...new Set([...explicitTerms, ...compactPromptTerms])].slice(0, 18).join('|') || prompt
}

export function buildProjectCapabilityStatusPlan(userPrompt) {
  const query = buildCapabilitySearchQuery(userPrompt)
  const steps = [
    makeStep('step_read_agent_workflow_doc', '读取交互故事智能体工作流说明', 'read_file_content', {
      filePath: 'docs/GAMESTUDIO_INTERACTIVE_STORY_AGENT.md'
    }),
    makeStep('step_read_control_system_doc', '读取 Control 系统边界说明', 'read_file_content', {
      filePath: 'docs/CONTROL_SYSTEM.md'
    }, ['step_read_agent_workflow_doc']),
    makeStep('step_list_intent_registry', '列出 Hermes intent 配置目录', 'list_directory_contents', {
      dirPath: 'config/hermes/intents'
    }, ['step_read_control_system_doc']),
    makeStep('step_search_project_docs', '搜索项目文档中的能力状态证据', 'search_workspace_text', {
      query,
      startDir: 'docs',
      maxResults: 30
    }, ['step_list_intent_registry']),
    makeStep('step_search_control_code', '搜索 control-server 中的实现证据', 'search_workspace_text', {
      query,
      startDir: 'apps/control-server/src/server',
      maxResults: 30
    }, ['step_search_project_docs']),
    makeStep('step_generate_capability_answer', '基于能力状态证据生成回答', 'generate_default_answer', {}, ['step_search_control_code'])
  ]

  return {
    planId: createPlanId(),
    goal: '检查 GameStudio 智能体能力、workflow、evaluator、状态机或可靠性缺口的当前事实状态',
    strategy: 'sequential',
    steps
  }
}