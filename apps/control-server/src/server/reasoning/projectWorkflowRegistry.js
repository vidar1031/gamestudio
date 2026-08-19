/**
 * HERMES-H04：项目与 workflow 注册表（总计划 S4-07）。
 *
 * 把「哪些项目、哪些 workflow 可以被 Hermes/cron/人工触发」从硬编码白名单
 * 抽象为受治理的注册表：
 * - 项目条目：projectId、名称、根目录边界（rootDir，必须解析在 workspace 内）、
 *   启用状态；workflow 条目：workflowId、所属项目、输入 schema、允许 action 集、
 *   审核策略（reviewPolicy 必填且不允许 'none'）、证据要求、执行器与启用状态；
 * - GameStudio 既有 story/bootstrap/projectStatus 工作流登记为内建条目
 *   （代码级治理，不迁移不破坏；内建条目不可经 API 修改/停用/覆盖）；
 * - 新条目只能经受控 API 创建：actor 必须是人类操作者（复用 F02 isHumanActor），
 *   校验失败与治理动作全部写治理审计；条目只声明能力，不绕过任何既有审核门禁；
 * - 持久化 state/project-workflow-registry.json（HERMES_PROJECT_WORKFLOW_REGISTRY_FILE
 *   可覆盖，测试用），tmp+rename 原子写，损坏隔离留证；文件只保存非内建条目，
 *   内建条目始终在代码中合并进来，文件被清空也不影响既有 GameStudio workflow；
 * - 触发门禁（evaluateRegistryTriggerGate）：workflow 已注册且启用、所属项目
 *   已注册且启用、projectId 归属合法（注册项目本身或其实例子目录，其余一律
 *   cross_project_rejected）、输入满足 schema（required/类型/未知字段/path 字段
 *   必须解析在项目根目录内）。cron（H02）与 HTTP session 入口都消费同一门禁。
 */

import fs from 'node:fs'
import path from 'node:path'
import { GAMESTUDIO_ROOT } from '../../config/paths.js'
import { appendGovernanceAudit } from './governanceAudit.js'
import { isHumanActor } from '../intents/proposalGovernance.js'

// 允许的审核策略：'none' 明确禁止——注册表条目不得声明绕过审核
export const REGISTRY_REVIEW_POLICIES = Object.freeze(['manual', 'ai_assisted'])
// 已注册执行器：reasoning_chain 走既有 reasoning session 链路；dry_run 为受控干跑
// （受控执行 runner 承担，证据落在项目根目录内）；扩展需先在代码登记
export const REGISTRY_EXECUTORS = Object.freeze(['reasoning_chain', 'dry_run'])
// runner 可校验的证据种类（reasoning_chain 工作流的证据由 reasoning 链路自身校验）
export const REGISTRY_RUN_EVIDENCE_KINDS = Object.freeze(['run_log', 'artifact', 'audit'])

const PROJECT_ID_PATTERN = /^[a-zA-Z][a-zA-Z0-9_-]{1,63}$/
const WORKFLOW_ID_PATTERN = /^[a-z][a-z0-9_]{2,63}$/
const INPUT_SCHEMA_TYPES = new Set(['string', 'number', 'boolean', 'array', 'object'])

// 内建条目：GameStudio 既有工作流的注册元数据（只登记，不改变其执行语义）。
// rootDir 与 STORAGE_PROJECTS_ROOT 默认布局一致（storage/projects）。
const BUILTIN_PROJECTS = Object.freeze([
  Object.freeze({
    projectId: 'gamestudio',
    name: 'GameStudio 互动故事生产',
    rootDir: 'storage/projects',
    enabled: true,
    builtIn: true,
    description: '互动故事生产主项目，既有 story/bootstrap/projectStatus 工作流归属',
    createdBy: 'system:builtin',
    createdAt: null,
    updatedAt: null
  })
])

const BUILTIN_WORKFLOWS = Object.freeze([
  Object.freeze({
    workflowId: 'story_production',
    projectId: 'gamestudio',
    label: '互动故事生产',
    source: 'workflows/storyProductionWorkflows.js',
    executor: 'reasoning_chain',
    inputSchema: Object.freeze({ prompt: Object.freeze({ type: 'string', required: true }) }),
    allowedActions: Object.freeze([
      'story_create_project', 'story_create_ai_project', 'story_configure_project', 'story_inspect_project',
      'story_generate_scripts_candidate', 'story_write_scripts', 'story_create_bible', 'story_analyze_scripts',
      'story_compile_blueprint', 'story_review_blueprint_agent', 'story_repair_blueprint_if_needed',
      'story_preflight_image_provider', 'story_compile_compose', 'story_validate_project', 'story_export_project',
      'story_create_asset_plan', 'story_generate_lock_asset_references', 'story_generate_asset_candidate',
      'story_lock_test', 'story_render_scene', 'story_render_scene_backgrounds', 'story_generate_scene_placements',
      'generate_default_answer'
    ]),
    reviewPolicy: 'manual',
    evidenceRequirements: Object.freeze(['session_events', 'queue_item', 'audit']),
    enabled: true,
    builtIn: true,
    createdBy: 'system:builtin',
    createdAt: null,
    updatedAt: null
  }),
  Object.freeze({
    workflowId: 'gamestudio_bootstrap',
    projectId: 'gamestudio',
    label: 'GameStudio 启动引导',
    source: 'workflows/gameStudioBootstrapWorkflows.js',
    executor: 'reasoning_chain',
    inputSchema: Object.freeze({ prompt: Object.freeze({ type: 'string', required: true }) }),
    allowedActions: Object.freeze([
      'gamestudio_ensure_running', 'gamestudio_open_editor', 'gamestudio_read_settings',
      'gamestudio_configure_local_production', 'gamestudio_self_check', 'gamestudio_bootstrap_answer'
    ]),
    reviewPolicy: 'manual',
    evidenceRequirements: Object.freeze(['session_events', 'audit']),
    enabled: true,
    builtIn: true,
    createdBy: 'system:builtin',
    createdAt: null,
    updatedAt: null
  }),
  Object.freeze({
    workflowId: 'project_status',
    projectId: 'gamestudio',
    label: '项目状态查询',
    source: 'workflows/projectStatusWorkflows.js',
    executor: 'reasoning_chain',
    inputSchema: Object.freeze({ prompt: Object.freeze({ type: 'string', required: true }) }),
    allowedActions: Object.freeze(['read_file_content', 'list_directory_contents', 'generate_default_answer']),
    reviewPolicy: 'manual',
    evidenceRequirements: Object.freeze(['session_events']),
    enabled: true,
    builtIn: true,
    createdBy: 'system:builtin',
    createdAt: null,
    updatedAt: null
  })
])

export function getProjectWorkflowRegistryFile() {
  const override = process.env.HERMES_PROJECT_WORKFLOW_REGISTRY_FILE
  if (override && String(override).trim()) return String(override)
  return path.join(GAMESTUDIO_ROOT, 'state', 'project-workflow-registry.json')
}

function emptyRegistryFile() {
  return { version: 1, projects: [], workflows: [] }
}

function readRegistryFile() {
  const file = getProjectWorkflowRegistryFile()
  try {
    if (!fs.existsSync(file)) return emptyRegistryFile()
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (!raw || !Array.isArray(raw.projects) || !Array.isArray(raw.workflows)) {
      throw new Error('invalid_project_workflow_registry_file')
    }
    return raw
  } catch {
    // 损坏文件隔离留证后按空处理，不猜测内容（与 cron jobs / proposal 治理同一语义）
    try {
      fs.renameSync(file, `${file}.corrupt-${Date.now()}`)
    } catch {
      // 隔离失败不阻断读取
    }
    return emptyRegistryFile()
  }
}

function writeRegistryFile(data) {
  const file = getProjectWorkflowRegistryFile()
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf8')
  fs.renameSync(tmp, file)
}

function normalizeProjectEntry(entry) {
  return {
    projectId: String(entry.projectId),
    name: String(entry.name || entry.projectId),
    rootDir: String(entry.rootDir || ''),
    enabled: entry.enabled !== false,
    builtIn: entry.builtIn === true,
    description: String(entry.description || ''),
    createdBy: entry.createdBy || null,
    createdAt: entry.createdAt || null,
    updatedAt: entry.updatedAt || null
  }
}

function normalizeWorkflowEntry(entry) {
  return {
    workflowId: String(entry.workflowId),
    projectId: String(entry.projectId || ''),
    label: String(entry.label || entry.workflowId),
    source: entry.source ? String(entry.source) : null,
    executor: String(entry.executor || ''),
    inputSchema: entry.inputSchema && typeof entry.inputSchema === 'object' ? entry.inputSchema : {},
    allowedActions: Array.isArray(entry.allowedActions) ? entry.allowedActions.map(String) : [],
    reviewPolicy: String(entry.reviewPolicy || ''),
    evidenceRequirements: Array.isArray(entry.evidenceRequirements) ? entry.evidenceRequirements.map(String) : [],
    enabled: entry.enabled !== false,
    builtIn: entry.builtIn === true,
    createdBy: entry.createdBy || null,
    createdAt: entry.createdAt || null,
    updatedAt: entry.updatedAt || null
  }
}

// 内建条目始终合并进读取结果；文件条目不得使用内建 id（写入侧已拦截，读取侧再兜底过滤）
export function listRegistryProjects() {
  const fileProjects = readRegistryFile().projects
    .filter((entry) => entry && !BUILTIN_PROJECTS.some((builtin) => builtin.projectId === entry.projectId))
    .map(normalizeProjectEntry)
  return [...BUILTIN_PROJECTS.map(normalizeProjectEntry), ...fileProjects]
}

export function getRegistryProject(projectId) {
  const id = String(projectId || '').trim()
  return listRegistryProjects().find((entry) => entry.projectId === id) || null
}

export function listRegistryWorkflows({ projectId } = {}) {
  const fileWorkflows = readRegistryFile().workflows
    .filter((entry) => entry && !BUILTIN_WORKFLOWS.some((builtin) => builtin.workflowId === entry.workflowId))
    .map(normalizeWorkflowEntry)
  const all = [...BUILTIN_WORKFLOWS.map(normalizeWorkflowEntry), ...fileWorkflows]
  const filterId = String(projectId || '').trim()
  return filterId ? all.filter((entry) => entry.projectId === filterId) : all
}

export function getRegistryWorkflow(workflowId) {
  const id = String(workflowId || '').trim()
  return listRegistryWorkflows().find((entry) => entry.workflowId === id) || null
}

/** 项目根目录的绝对路径（rootDir 相对 GAMESTUDIO_ROOT 解析） */
export function resolveProjectRootDir(project) {
  return path.resolve(GAMESTUDIO_ROOT, String(project?.rootDir || ''))
}

/** workflow 已注册且启用、所属项目已注册且启用时才可被选择触发 */
export function isRegistryWorkflowTriggerable(workflowId) {
  const workflow = getRegistryWorkflow(workflowId)
  if (!workflow || workflow.enabled !== true) return false
  const project = getRegistryProject(workflow.projectId)
  return Boolean(project && project.enabled === true)
}

/**
 * projectId 归属判定：空（无归属，兼容既有行为）/ 注册项目本身 / 项目根目录下的
 * 实例子目录（如 story 项目 id 位于 gamestudio 的 storage/projects 下）均合法；
 * 命中其他已注册项目或解析越出根目录的一律 cross_project_rejected。
 */
export function resolveRegistryProjectBinding(workflow, requestedProjectId) {
  const requested = String(requestedProjectId || '').trim()
  if (!requested) return { ok: true, binding: 'unbound' }
  if (requested === workflow.projectId) return { ok: true, binding: 'project' }
  const project = getRegistryProject(workflow.projectId)
  if (!project) return { ok: false, error: 'project_not_registered', detail: `workflow=${workflow.workflowId} 所属项目 ${workflow.projectId} 未注册` }
  // 请求指向另一个已注册项目——明确的跨项目请求，拒绝
  const requestedAsProject = getRegistryProject(requested)
  if (requestedAsProject) {
    return {
      ok: false,
      error: 'cross_project_rejected',
      detail: `projectId=${requested} 是已注册项目，不属于 workflow=${workflow.workflowId} 的注册项目 ${workflow.projectId}`
    }
  }
  const rootDir = resolveProjectRootDir(project)
  const resolved = path.resolve(rootDir, requested)
  if (resolved.startsWith(rootDir + path.sep)) {
    return { ok: true, binding: 'instance', resolvedPath: resolved }
  }
  return {
    ok: false,
    error: 'cross_project_rejected',
    detail: `projectId=${requested} 不属于 workflow=${workflow.workflowId} 的注册项目 ${workflow.projectId}（根目录 ${project.rootDir}）`
  }
}

function validateInputValueType(value, type) {
  if (type === 'array') return Array.isArray(value)
  if (type === 'object') return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
  return typeof value === type
}

/**
 * 输入 schema 校验：required 必填、类型匹配、未知字段拒绝（严格模式）；
 * 声明 path:true 的字段必须解析在所属项目根目录内（跨项目路径拒绝）。
 */
export function validateWorkflowInput(workflow, input = {}) {
  const schema = workflow.inputSchema && typeof workflow.inputSchema === 'object' ? workflow.inputSchema : {}
  const value = input && typeof input === 'object' && !Array.isArray(input) ? input : {}
  const project = getRegistryProject(workflow.projectId)
  const rootDir = project ? resolveProjectRootDir(project) : null
  for (const key of Object.keys(value)) {
    if (!Object.prototype.hasOwnProperty.call(schema, key)) {
      return { ok: false, error: 'input_invalid', detail: `输入字段 ${key} 未在 workflow=${workflow.workflowId} 的 inputSchema 中声明` }
    }
  }
  for (const [field, spec] of Object.entries(schema)) {
    const fieldValue = value[field]
    if (fieldValue === undefined || fieldValue === null || fieldValue === '') {
      if (spec.required === true) {
        return { ok: false, error: 'input_invalid', detail: `workflow=${workflow.workflowId} 缺少必填输入字段 ${field}` }
      }
      continue
    }
    if (!validateInputValueType(fieldValue, spec.type)) {
      return { ok: false, error: 'input_invalid', detail: `输入字段 ${field} 类型应为 ${spec.type}（实际 ${Array.isArray(fieldValue) ? 'array' : typeof fieldValue}）` }
    }
    if (spec.path === true) {
      if (!rootDir) return { ok: false, error: 'project_not_registered', detail: `workflow=${workflow.workflowId} 所属项目未注册，无法校验路径边界` }
      const resolved = path.resolve(rootDir, String(fieldValue))
      if (resolved !== rootDir && !resolved.startsWith(rootDir + path.sep)) {
        return { ok: false, error: 'input_invalid', detail: `输入字段 ${field} 路径越出项目 ${workflow.projectId} 根目录（跨项目路径拒绝）` }
      }
    }
  }
  return { ok: true }
}

/**
 * 触发门禁（纯函数，不审计；审计由调用方按自身语义留证）。
 * @returns { ok: true, workflow, project } | { ok: false, error, detail }
 */
export function evaluateRegistryTriggerGate({ workflowId, projectId, input } = {}) {
  const workflow = getRegistryWorkflow(workflowId)
  if (!workflow) {
    return { ok: false, error: 'workflow_not_registered', detail: `workflow=${String(workflowId || '') || '-'} 未在注册表登记` }
  }
  if (workflow.enabled !== true) {
    return { ok: false, error: 'workflow_disabled', detail: `workflow=${workflow.workflowId} 已停用` }
  }
  const project = getRegistryProject(workflow.projectId)
  if (!project) {
    return { ok: false, error: 'project_not_registered', detail: `workflow=${workflow.workflowId} 所属项目 ${workflow.projectId} 未注册` }
  }
  if (project.enabled !== true) {
    return { ok: false, error: 'project_disabled', detail: `项目 ${project.projectId} 已停用` }
  }
  const binding = resolveRegistryProjectBinding(workflow, projectId)
  if (!binding.ok) return { ok: false, error: binding.error, detail: binding.detail }
  const inputCheck = validateWorkflowInput(workflow, input || {})
  if (!inputCheck.ok) return { ok: false, error: inputCheck.error, detail: inputCheck.detail }
  return { ok: true, workflow, project, binding: binding.binding }
}

function auditRegistry(action, { projectId = null, actor = null, result, detail }, nowFn) {
  appendGovernanceAudit({ action, projectId, actor, result, detail }, { nowFn })
}

function requireHumanActor(action, id, actor, nowFn) {
  if (isHumanActor(actor)) return null
  auditRegistry(action, { actor, result: 'blocked', detail: `actor_not_human:${String(actor || '').trim() || 'missing'} entry=${id}` }, nowFn)
  return { ok: false, error: 'actor_not_human', detail: '注册表条目的创建与变更必须由人类操作者执行，自动路径身份一律拒绝' }
}

/** 校验项目根目录边界：必须解析在 workspace 内，且不与任何已注册项目根目录互相嵌套 */
function validateProjectRootDir(projectId, rootDir) {
  const text = String(rootDir || '').trim()
  if (!text) return { ok: false, error: 'root_dir_required', detail: '项目条目必须声明根目录边界 rootDir' }
  if (path.isAbsolute(text)) {
    return { ok: false, error: 'root_dir_outside_workspace', detail: `rootDir 必须是相对 workspace 的相对路径（收到绝对路径 ${text}）` }
  }
  const resolved = path.resolve(GAMESTUDIO_ROOT, text)
  if (resolved === GAMESTUDIO_ROOT || !resolved.startsWith(GAMESTUDIO_ROOT + path.sep)) {
    return { ok: false, error: 'root_dir_outside_workspace', detail: `rootDir=${text} 解析后越出 workspace 边界` }
  }
  for (const existing of listRegistryProjects()) {
    if (existing.projectId === projectId) continue
    const existingRoot = resolveProjectRootDir(existing)
    if (resolved === existingRoot || resolved.startsWith(existingRoot + path.sep) || existingRoot.startsWith(resolved + path.sep)) {
      return { ok: false, error: 'project_root_conflict', detail: `rootDir=${text} 与已注册项目 ${existing.projectId} 的根目录 ${existing.rootDir} 重叠（项目根目录不得互相嵌套）` }
    }
  }
  return { ok: true }
}

function validateInputSchemaSpec(inputSchema) {
  if (!inputSchema || typeof inputSchema !== 'object' || Array.isArray(inputSchema)) {
    return { ok: false, error: 'input_schema_invalid', detail: 'inputSchema 必须是对象（字段名 -> { type, required?, path? }）' }
  }
  for (const [field, spec] of Object.entries(inputSchema)) {
    if (!spec || typeof spec !== 'object' || !INPUT_SCHEMA_TYPES.has(spec.type)) {
      return { ok: false, error: 'input_schema_invalid', detail: `输入字段 ${field} 的 type 必须是 ${[...INPUT_SCHEMA_TYPES].join('/')}` }
    }
  }
  return { ok: true }
}

/**
 * 注册新项目条目（受控：人类 actor + 全量校验 + 审计）。
 * @returns { ok: true, project } | { ok: false, error, detail }
 */
export function registerRegistryProject(input = {}, { actor, nowFn = () => new Date().toISOString() } = {}) {
  const projectId = String(input.projectId || '').trim()
  const reject = (error, detail) => {
    auditRegistry('registry_project_register', { projectId, actor, result: 'blocked', detail: `${error}:${detail}` }, nowFn)
    return { ok: false, error, detail }
  }
  const actorBlock = requireHumanActor('registry_project_register', projectId || '-', actor, nowFn)
  if (actorBlock) return actorBlock
  if (!PROJECT_ID_PATTERN.test(projectId)) {
    return reject('project_id_invalid', `projectId=${projectId || '-'} 须匹配 ${PROJECT_ID_PATTERN}`)
  }
  if (BUILTIN_PROJECTS.some((entry) => entry.projectId === projectId)) {
    return reject('builtin_entry_protected', `projectId=${projectId} 是内建条目，不可经注册表覆盖`)
  }
  if (getRegistryProject(projectId)) {
    return reject('project_already_registered', `projectId=${projectId} 已注册`)
  }
  if (!String(input.name || '').trim()) {
    return reject('project_name_required', '项目条目必须声明名称 name')
  }
  const rootCheck = validateProjectRootDir(projectId, input.rootDir)
  if (!rootCheck.ok) return reject(rootCheck.error, rootCheck.detail)

  const now = nowFn()
  const entry = normalizeProjectEntry({
    projectId,
    name: String(input.name).trim(),
    rootDir: String(input.rootDir).trim(),
    enabled: input.enabled !== false,
    builtIn: false,
    description: String(input.description || '').slice(0, 280),
    createdBy: String(actor),
    createdAt: now,
    updatedAt: now
  })
  const data = readRegistryFile()
  data.projects.push(entry)
  writeRegistryFile(data)
  auditRegistry('registry_project_register', { projectId, actor, result: 'ok', detail: `rootDir=${entry.rootDir} name=${entry.name}` }, nowFn)
  return { ok: true, project: entry }
}

/**
 * 注册新 workflow 条目（受控：人类 actor + 全量校验 + 审计）。
 * reviewPolicy 必填且不允许 'none'——注册表条目不得声明绕过审核。
 * @returns { ok: true, workflow } | { ok: false, error, detail }
 */
export function registerRegistryWorkflow(input = {}, { actor, nowFn = () => new Date().toISOString() } = {}) {
  const workflowId = String(input.workflowId || '').trim()
  const projectId = String(input.projectId || '').trim()
  const reject = (error, detail) => {
    auditRegistry('registry_workflow_register', { projectId: projectId || null, actor, result: 'blocked', detail: `${error}:${detail}` }, nowFn)
    return { ok: false, error, detail }
  }
  const actorBlock = requireHumanActor('registry_workflow_register', workflowId || '-', actor, nowFn)
  if (actorBlock) return actorBlock
  if (!WORKFLOW_ID_PATTERN.test(workflowId)) {
    return reject('workflow_id_invalid', `workflowId=${workflowId || '-'} 须匹配 ${WORKFLOW_ID_PATTERN}`)
  }
  if (BUILTIN_WORKFLOWS.some((entry) => entry.workflowId === workflowId)) {
    return reject('builtin_entry_protected', `workflowId=${workflowId} 是内建条目，不可经注册表覆盖`)
  }
  if (getRegistryWorkflow(workflowId)) {
    return reject('workflow_already_registered', `workflowId=${workflowId} 已注册`)
  }
  if (!getRegistryProject(projectId)) {
    return reject('project_not_registered', `workflow 所属项目 ${projectId || '-'} 未注册，须先注册项目`)
  }
  if (!String(input.label || '').trim()) {
    return reject('workflow_label_required', 'workflow 条目必须声明 label')
  }
  const schemaCheck = validateInputSchemaSpec(input.inputSchema)
  if (!schemaCheck.ok) return reject(schemaCheck.error, schemaCheck.detail)
  const allowedActions = Array.isArray(input.allowedActions) ? input.allowedActions.map((item) => String(item || '').trim()).filter(Boolean) : []
  if (allowedActions.length === 0) {
    return reject('allowed_actions_required', 'workflow 条目必须声明非空允许 action 集 allowedActions')
  }
  const reviewPolicy = String(input.reviewPolicy || '').trim()
  if (!reviewPolicy) {
    return reject('review_policy_required', 'workflow 条目必须声明审核策略 reviewPolicy')
  }
  if (!REGISTRY_REVIEW_POLICIES.includes(reviewPolicy)) {
    return reject('review_policy_not_allowed', `reviewPolicy=${reviewPolicy} 不允许（可选 ${REGISTRY_REVIEW_POLICIES.join('/')}；'none' 明确禁止，条目不得绕过审核）`)
  }
  const evidenceRequirements = Array.isArray(input.evidenceRequirements) ? input.evidenceRequirements.map((item) => String(item || '').trim()).filter(Boolean) : []
  if (evidenceRequirements.length === 0) {
    return reject('evidence_requirements_required', 'workflow 条目必须声明非空证据要求 evidenceRequirements')
  }
  const executor = String(input.executor || '').trim()
  if (!REGISTRY_EXECUTORS.includes(executor)) {
    return reject('executor_not_registered', `executor=${executor || '-'} 未登记（可选 ${REGISTRY_EXECUTORS.join('/')}）`)
  }

  const now = nowFn()
  const entry = normalizeWorkflowEntry({
    workflowId,
    projectId,
    label: String(input.label).trim(),
    executor,
    inputSchema: input.inputSchema,
    allowedActions,
    reviewPolicy,
    evidenceRequirements,
    enabled: input.enabled !== false,
    builtIn: false,
    createdBy: String(actor),
    createdAt: now,
    updatedAt: now
  })
  const data = readRegistryFile()
  data.workflows.push(entry)
  writeRegistryFile(data)
  auditRegistry('registry_workflow_register', { projectId, actor, result: 'ok', detail: `workflow=${workflowId} executor=${executor} reviewPolicy=${reviewPolicy}` }, nowFn)
  return { ok: true, workflow: entry }
}

/**
 * 启用/停用注册表条目（受控）。内建条目受保护不可变更——既有 GameStudio
 * workflow 的可用性不被注册表操作破坏。
 * @param {string} kind 'project' | 'workflow'
 */
export function setRegistryEntryEnabled(kind, id, enabled, { actor, nowFn = () => new Date().toISOString() } = {}) {
  const entryId = String(id || '').trim()
  const targetEnabled = enabled === true
  const reject = (error, detail, projectId = null) => {
    auditRegistry('registry_entry_status', { projectId, actor, result: 'blocked', detail: `${error}:${detail}` }, nowFn)
    return { ok: false, error, detail }
  }
  const actorBlock = requireHumanActor('registry_entry_status', entryId || '-', actor, nowFn)
  if (actorBlock) return actorBlock

  const data = readRegistryFile()
  if (kind === 'project') {
    if (BUILTIN_PROJECTS.some((entry) => entry.projectId === entryId)) {
      return reject('builtin_entry_protected', `项目 ${entryId} 是内建条目，不可停用/变更`)
    }
    const index = data.projects.findIndex((entry) => entry.projectId === entryId)
    if (index < 0) return reject('project_not_registered', `项目 ${entryId || '-'} 未注册`)
    data.projects[index] = { ...normalizeProjectEntry(data.projects[index]), enabled: targetEnabled, updatedAt: nowFn() }
    writeRegistryFile(data)
    auditRegistry('registry_entry_status', { projectId: entryId, actor, result: 'ok', detail: `project=${entryId} enabled=${targetEnabled}` }, nowFn)
    return { ok: true, project: normalizeProjectEntry(data.projects[index]) }
  }
  if (kind === 'workflow') {
    if (BUILTIN_WORKFLOWS.some((entry) => entry.workflowId === entryId)) {
      return reject('builtin_entry_protected', `workflow ${entryId} 是内建条目，不可停用/变更`)
    }
    const index = data.workflows.findIndex((entry) => entry.workflowId === entryId)
    if (index < 0) return reject('workflow_not_registered', `workflow ${entryId || '-'} 未注册`)
    data.workflows[index] = { ...normalizeWorkflowEntry(data.workflows[index]), enabled: targetEnabled, updatedAt: nowFn() }
    writeRegistryFile(data)
    auditRegistry('registry_entry_status', { projectId: data.workflows[index].projectId, actor, result: 'ok', detail: `workflow=${entryId} enabled=${targetEnabled}` }, nowFn)
    return { ok: true, workflow: normalizeWorkflowEntry(data.workflows[index]) }
  }
  return reject('unknown_entry_kind', `kind=${kind || '-'} 仅支持 project/workflow`)
}
