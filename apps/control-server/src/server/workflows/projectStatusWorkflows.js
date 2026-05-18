import { REASONING_ACTIONS } from '../capabilities/actionRegistry.js'
import { isProjectListingPrompt, isProjectStructureInspectionPrompt } from '../reasoning/heuristics.js'

const CAPABILITY_STATUS_JUDGMENT_KEYWORDS = /是否|已经|完整|建立|具备|承担|缺口|达标|闭环|可观测|可取消|可恢复|覆盖|未完成|未达标|部分达标|尚未/i
const CAPABILITY_STATUS_TARGETS = /workflow|工作流|evaluator|评估器|deterministic|registry|intent|状态机|自动化|Hermes|Control Server|关键词|打标签|可靠性|能力链条|短期缺口|中期.*缺口|correctionPrompt|_inbox|proposal|人工审核|纠偏|晋级|运行规则|生产闭环|用户目标|OMLX|服务器重启/i

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
  if (isProjectListingPrompt(prompt) || isProjectStructureInspectionPrompt(prompt)) return false
  if (!CAPABILITY_STATUS_JUDGMENT_KEYWORDS.test(prompt)) return false
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
  if (/correctionPrompt|纠偏|人工审核|_inbox|proposal|晋级|运行规则/i.test(prompt)) explicitTerms.push('correctionPrompt', '_inbox', 'proposal', '人工审核', '晋级', '运行规则')
  if (/达标|生产闭环|用户目标|可观测|可取消|可恢复|OMLX|服务器重启/i.test(prompt)) explicitTerms.push('达标', '生产闭环', '用户目标', '可观测', '可取消', '可恢复', 'OMLX', '服务器重启')

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
    makeStep('step_read_agent_workflow_doc', '读取系统生产级推进方案', 'read_file_content', {
      filePath: 'docs/系统生产级推进方案.md'
    }),
    makeStep('step_read_control_system_doc', '读取 Control 系统边界说明', 'read_file_content', {
      filePath: 'docs/系统生产级推进方案.md'
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

export function shouldUseDeterministicCapabilityStatusAnswer(userPrompt, artifacts = {}) {
  if (!isProjectCapabilityStatusPrompt(userPrompt)) return false
  return Boolean(
    artifacts?.directoryListings?.['config/hermes/intents']
    || artifacts?.directoryListing?.requestedPath === 'config/hermes/intents'
    || artifacts?.workspaceSearches?.step_search_project_docs
    || artifacts?.workspaceSearches?.step_search_control_code
  )
}

export function buildProjectCapabilityStatusAnswer(userPrompt, artifacts = {}) {
  const prompt = normalizePrompt(userPrompt)
  const intentListing = artifacts?.directoryListings?.['config/hermes/intents'] || artifacts?.directoryListing || null
  const intentEntries = Array.isArray(intentListing?.entries) ? intentListing.entries.map((entry) => entry.name).join(', ') : ''
  const evidenceLine = intentEntries
    ? `证据：config/hermes/intents 当前直接子项为 ${intentEntries}。`
    : '证据：本次已执行能力状态检查 workflow，包含文档、intent 目录和 control-server 实现搜索。'

  if (/中期|结构性缺口|状态机|memory lifecycle/i.test(prompt)) {
    return [
      '中期最大的结构性缺口是：Control 的状态机尚未把 story workflow registry、deterministic evaluator 和 memory lifecycle 串成统一闭环。',
      '没有状态机，workflow 只能是零散路由/计划，不能稳定表达阶段、输入、产物和转移条件。',
      '没有完整 story workflow registry，create/generate/validate/export 无法作为可重复业务能力被调度。',
      '没有覆盖到 workflow 的 deterministic evaluator，完成率只能依赖回答文本或人工判断，不能成为生产门禁。',
      'memory lifecycle 已有规则，但还需要和状态机阶段、任务证据、复盘 proposal 建立因果关系。',
      evidenceLine
    ].join('\n')
  }

  if (/workflow\s*registry|intent\s*registry|config\/hermes\/intents|活动\s*JSON\s*intent/i.test(prompt)) {
    return [
      '结论：当前 workflow registry 还没有进入完整可执行闭环。',
      'builtin intents 已在 control-server 内提供基础路由、计划和部分 deterministic answer/evaluator。',
      '_inbox proposal 只是待审核提案入口，不会自动成为运行规则。',
      '活动 JSON intent 目前只有 operator.workflow_registry_status.json 这类边界规则，不能等同于完整 story workflow registry。',
      '缺口：create/configure/generate/validate/export 等 story workflow 仍缺少成套 JSON intent、固定 action、artifact 和 evaluator。',
      evidenceLine
    ].join('\n')
  }

  if (/用户目标|生产闭环|create_story_project|export_project|story workflow|故事.*workflow/i.test(prompt)) {
    return [
      '结论：当前智能控制系统尚未实现从用户目标到 story workflow 交付的完整生产闭环。',
      '证据：Control 已具备受控 action、审核、artifact 记录、模型队列和部分 evaluator；但 config/hermes/intents 仍主要是基础设施与 operator 边界规则。',
      '达标程度：控制平面与事实检查部分达标，故事交付闭环未达标。',
      '未达标缺口：create/configure/generate/validate/export 等 story workflow 尚未全部固定 action、artifact、输入 contract 和 deterministic evaluator。',
      '下一步门禁：必须先让 story workflow registry、artifact 验收和 evaluator 成套通过，再谈生产放行。',
      evidenceLine
    ].join('\n')
  }

  if (/heartbeat|长任务|OMLX|orphan|服务器重启|恢复|recover|可观测|可取消|可恢复/i.test(prompt)) {
    return [
      '结论：Control 已具备可观测和可取消基础，但模型长任务、服务器重启、OMLX 异常后的自动恢复闭环仍未完全达标。',
      '证据：长任务会写 heartbeat；cancel 可中断等待链路；orphaned session 会被标记；recover 后端路由可按 artifacts.nextStepIndex 继续。',
      '达标程度：可观测/可取消部分达标，自动恢复与 UI 操作闭环未达标。',
      '未达标缺口：Control Console 仍缺恢复入口，错误分类、自动恢复动作和状态机绑定还没有完整实现。',
      '下一步门禁：恢复 UI、错误分类、状态机阶段绑定和 recover 回归测试必须通过。',
      evidenceLine
    ].join('\n')
  }

  if (/correctionPrompt|纠偏|人工审核|_inbox|proposal|晋级/i.test(prompt)) {
    return [
      '结论：人工审核纠偏不会直接修改运行规则，当前自我强化闭环是安全的 proposal-only 形态。',
      '证据：correctionPrompt 影响当前 session 的后续重跑/回答，并被记录为审核证据；有价值的纠偏写入 config/hermes/intents/_inbox proposal。',
      '达标程度：安全边界部分达标，自动学习闭环未完全达标。',
      '未达标缺口：_inbox proposal 不会自动生效，必须人工晋级后才可能成为 active intent、workflow 或 evaluator 规则。',
      '下一步门禁：需要 proposal 审核、晋级、回滚和效果回归测试都可观测后，才算安全自我强化闭环。',
      evidenceLine
    ].join('\n')
  }

  if (/短期|生产放行/i.test(prompt)) {
    return [
      '短期缺口优先级：1. story workflow registry 没有形成可执行闭环。',
      '2. create/configure/generate/validate/export 仍缺固定 action、artifact、deterministic evaluator 的成套验收。',
      '3. orphan/recover 已有后端接口，但 UI 恢复入口、自动错误分类和自动恢复动作仍缺。',
      '4. 事件日志已存在，但还没有和状态机/阶段机绑定成可追踪任务单。',
      '5. 因此生产放行前应先补 workflow + evaluator + 恢复链路，而不是扩大自由聊天能力。',
      evidenceLine
    ].join('\n')
  }

  return [
    '结论：当前能力状态仍应按“基础设施可用、业务 workflow 未完全闭环”判断。',
    'Control Server 已承担路由、审核、artifact、模型队列和部分 evaluator。',
    '未完成项集中在状态机、story workflow registry、deterministic evaluator、恢复动作和 memory lifecycle 绑定。',
    evidenceLine
  ].join('\n')
}