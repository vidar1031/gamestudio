/**
 * HERMES-H03：右脑子 agent 受控监察。
 *
 * 让右脑强模型驱动的子 agent 对任务健康、失败证据和阻断原因进行监察，
 * 同时把它的能力收敛在「只读分析 + 建议 + 已注册受控动作」之内：
 * - 固定身份 RIGHT_BRAIN_SUPERVISOR_ID；每次监察（含模型不可用/输出非法）都落
 *   运行记录（state/right-brain-supervision.json，HERMES_RIGHT_BRAIN_SUPERVISION_FILE
 *   可覆盖，测试用）并写治理审计，输入摘要、模型、输出、时间可追溯；
 * - 模型路由走既有配置（manager.left-brain.json 的 actionRoutes.right_brain_supervision，
 *   与 meta_analysis 同为右脑 Kimi 路由）；路由缺失或 key 失效时显式记录
 *   model_unavailable / model_error，绝不伪造监察结果；
 * - 能力白名单两级：只读集（actionRegistry.RIGHT_BRAIN_SUPERVISION_READ_ACTIONS，
 *   与 REASONING_ACTIONS 注册表对齐）可直接调用；受控集
 *   （RIGHT_BRAIN_CONTROLLED_ACTIONS）只能「建议」，人 approve 后才经既有受控
 *   API（与守护台人工重试/取消同一路径）执行，子 agent 自己不执行；
 * - 越权 action（已注册但非只读、或完全未注册）一律拒绝、逐条审计；子 agent 运行
 *   全程异常隔离，任何失败只影响本次监察记录，不触碰生产任务与 session 状态机；
 * - 凭证安全：发给模型的证据与落盘的输入/输出摘要统一过 D02 redactSecrets，
 *   输入摘要只保留计数级 digest，不回吐证据原文。
 *
 * 安全边界（与 AGENTS.md 一致）：子 agent 不写项目文件、不改生产规则、不批准自身
 * 动作；审计写入 best-effort，不放大为生产故障。
 */

import fs from 'node:fs'
import path from 'node:path'
import { GAMESTUDIO_ROOT } from '../../config/paths.js'
import {
  REASONING_ACTIONS,
  RIGHT_BRAIN_SUPERVISION_READ_ACTIONS,
  isRightBrainSupervisionReadAction
} from '../capabilities/actionRegistry.js'
import { appendGovernanceAudit } from './governanceAudit.js'
import { redactSecrets } from '../security/redaction.js'

// 右脑子 agent 固定身份标识：运行记录、审计与守护台展示共用
export const RIGHT_BRAIN_SUPERVISOR_ID = 'hermes-right-brain-supervisor'

// 模型路由在 manager.left-brain.json actionRoutes 中的注册键（右脑 Kimi 路由）
export const RIGHT_BRAIN_SUPERVISION_ROUTE_ACTION = 'right_brain_supervision'

// 受控动作子集：子 agent 只能「建议」，人 approve 后由路由层注入的 executor
// 经既有受控 API 执行（retry 与守护台人工重试同一核心、cancel 复用既有受控函数）。
export const RIGHT_BRAIN_CONTROLLED_ACTIONS = Object.freeze({
  retry_session: Object.freeze({
    action: 'retry_session',
    title: '重试失败任务',
    description: '对 failed 状态的 reasoning session 重新排队，与守护台人工重试同一受控路径（含状态/队列/启动门禁校验）。',
    paramsSpec: ['sessionId: 目标 reasoning session 编号。']
  }),
  cancel_session: Object.freeze({
    action: 'cancel_session',
    title: '取消任务',
    description: '取消指定 reasoning session，与守护台取消同一受控路径。',
    paramsSpec: ['sessionId: 目标 reasoning session 编号。']
  })
})

// 运行记录保留上限（证据索引，不全量留存）
const SUPERVISION_RUNS_LIMIT = 50
// 发给模型的证据序列化长度上限（与 metaAnalysis 同一量级）
const EVIDENCE_PROMPT_MAX_LENGTH = 8000
// 落盘的模型原文预览长度上限
const OUTPUT_PREVIEW_MAX_LENGTH = 600

export function getRightBrainSupervisionFile() {
  const override = process.env.HERMES_RIGHT_BRAIN_SUPERVISION_FILE
  if (override && String(override).trim()) return String(override)
  return path.join(GAMESTUDIO_ROOT, 'state', 'right-brain-supervision.json')
}

function emptyStore() {
  return { version: 1, runs: [] }
}

function readStore() {
  const file = getRightBrainSupervisionFile()
  try {
    if (!fs.existsSync(file)) return emptyStore()
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (!raw || !Array.isArray(raw.runs)) throw new Error('invalid_supervision_file')
    return raw
  } catch {
    // 损坏文件隔离留证后按空处理，不猜测内容（与 cron jobs 同一语义）
    try {
      fs.renameSync(file, `${file}.corrupt-${Date.now()}`)
    } catch {
      // 隔离失败不阻断读取
    }
    return emptyStore()
  }
}

function writeStore(store) {
  const file = getRightBrainSupervisionFile()
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`
  fs.writeFileSync(tmp, `${JSON.stringify(store, null, 2)}\n`, 'utf8')
  fs.renameSync(tmp, file)
}

function persistRun(run) {
  const store = readStore()
  store.runs = [run, ...(store.runs || [])].slice(0, SUPERVISION_RUNS_LIMIT)
  writeStore(store)
  return run
}

/**
 * 读取最近 limit 条监察运行记录（新的在前）。
 */
export function listSupervisionRuns(limit = 20) {
  const max = Math.max(1, Math.min(100, Number(limit) || 20))
  return readStore().runs.slice(0, max)
}

export function readSupervisionRun(runId) {
  return readStore().runs.find((run) => run.runId === String(runId || '')) || null
}

/**
 * 对子 agent 建议的 action 做白名单分级。
 * @returns {{ tier: 'read' | 'controlled' | 'rejected', reason?: string }}
 */
export function classifySupervisionAction(action) {
  const name = String(action || '').trim()
  if (!name) return { tier: 'rejected', reason: 'action_empty' }
  if (Object.prototype.hasOwnProperty.call(RIGHT_BRAIN_CONTROLLED_ACTIONS, name)) {
    return { tier: 'controlled' }
  }
  if (isRightBrainSupervisionReadAction(name) && REASONING_ACTIONS[name]) {
    return { tier: 'read' }
  }
  if (REASONING_ACTIONS[name]) {
    // 已注册但未列入子 agent 白名单：越权（写入/调用/生产 mutation 等）
    return { tier: 'rejected', reason: 'over_privileged' }
  }
  return { tier: 'rejected', reason: 'unregistered' }
}

/**
 * 守护台展示用能力清单：只读集（带注册表元数据）+ 受控集。
 */
export function getRightBrainSupervisionCapabilities() {
  const readActions = RIGHT_BRAIN_SUPERVISION_READ_ACTIONS
    .filter((action) => REASONING_ACTIONS[action])
    .map((action) => ({
      action,
      title: REASONING_ACTIONS[action].title,
      category: REASONING_ACTIONS[action].category || 'general'
    }))
  return {
    supervisorId: RIGHT_BRAIN_SUPERVISOR_ID,
    readActions,
    controlledActions: Object.values(RIGHT_BRAIN_CONTROLLED_ACTIONS)
  }
}

function truncateText(value, maxLength) {
  const text = String(value || '')
  return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text
}

function safeErrorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

// 输入摘要只保留计数级 digest：可追溯「这次监察看到了什么规模的数据」，
// 不向记录/日志回吐证据原文（证据全文可在 session/queue/audit 源头按 id 互查）
function buildEvidenceDigest(evidence) {
  const sessions = evidence?.sessions && typeof evidence.sessions === 'object' ? evidence.sessions : {}
  const queue = evidence?.queue && typeof evidence.queue === 'object' ? evidence.queue : {}
  const failedSessions = Array.isArray(evidence?.failedSessions) ? evidence.failedSessions : []
  const auditTail = Array.isArray(evidence?.auditTail) ? evidence.auditTail : []
  return {
    runtimeState: sessions.runtimeState || evidence?.runtime?.state || null,
    sessionsByStatus: sessions.byStatus || null,
    queueByStatus: queue.byStatus || null,
    failedSessionCount: failedSessions.length,
    failedSessionIds: failedSessions.map((item) => item?.sessionId).filter(Boolean).slice(0, 10),
    auditTailCount: auditTail.length
  }
}

/**
 * 构建发给右脑模型的监察 prompt。
 * 证据序列化先过 D02 脱敏再截断，保证 env/key 材料不进入模型上下文。
 */
export function buildSupervisionMessages(evidence, { focusSessionId = null } = {}) {
  const readList = RIGHT_BRAIN_SUPERVISION_READ_ACTIONS.join(', ')
  const controlledList = Object.keys(RIGHT_BRAIN_CONTROLLED_ACTIONS).join(', ')
  const systemMessage = [
    `你是 Hermes 的右脑子 agent（身份：${RIGHT_BRAIN_SUPERVISOR_ID}），负责对 Control 系统的任务健康、失败证据和阻断原因进行受控监察。`,
    '',
    '## 能力边界（必须严格遵守）',
    `1. 你只能读取系统提供的证据，可以直接调用的只读 action 仅限：${readList}。`,
    `2. 你可以建议执行的受控 action 仅限：${controlledList}；这些动作由人工审核后执行，你不能自己执行。`,
    '3. 除上述两类之外的任何 action（写文件、执行脚本、生产 mutation、导出、删除等）都属于越权，禁止建议。',
    '4. 建议必须引用证据（sessionId / taskId / 审计记录），不得编造未观测到的事实。',
    '',
    '## 输出格式（严格 JSON，不要输出任何其他内容）',
    '{',
    '  "summary": "一段中文总体结论",',
    '  "findings": [{ "title": "发现", "detail": "依据与影响", "severity": "info|warning|critical" }],',
    '  "suggestions": [{',
    '    "action": "action 名称（仅限白名单）",',
    '    "params": { "sessionId": "..." },',
    '    "rationale": "为什么建议这样做",',
    '    "evidenceRefs": ["sessionId 或证据指针"]',
    '  }]',
    '}',
    '没有需要建议的动作时 suggestions 返回空数组。'
  ].join('\n')

  const serialized = redactSecrets(JSON.stringify(evidence || {}, null, 2))
  const truncated = serialized.length > EVIDENCE_PROMPT_MAX_LENGTH
    ? `${serialized.slice(0, EVIDENCE_PROMPT_MAX_LENGTH)}\n...（证据已截断）`
    : serialized
  const userMessage = [
    focusSessionId ? `本次重点监察 session：${focusSessionId}` : '本次为全系统例行监察。',
    '',
    '## 证据快照（已脱敏）',
    '```json',
    truncated,
    '```'
  ].join('\n')

  return [
    { role: 'system', content: systemMessage },
    { role: 'user', content: userMessage }
  ]
}

function extractJsonObject(text) {
  const raw = String(text || '').trim()
  if (!raw) return null
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/)
  const candidate = fenced ? fenced[1].trim() : raw
  const start = candidate.indexOf('{')
  const end = candidate.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try {
    return JSON.parse(candidate.slice(start, end + 1))
  } catch {
    return null
  }
}

function normalizeSuggestions(parsed, runId, nowIso) {
  const rawSuggestions = Array.isArray(parsed?.suggestions) ? parsed.suggestions.slice(0, 10) : []
  return rawSuggestions.map((item, index) => {
    const action = String(item?.action || '').trim()
    const classification = classifySupervisionAction(action)
    const base = {
      suggestionId: `${runId}_s${index + 1}`,
      action: action || null,
      params: item?.params && typeof item.params === 'object' ? item.params : {},
      rationale: truncateText(item?.rationale, 500),
      evidenceRefs: Array.isArray(item?.evidenceRefs) ? item.evidenceRefs.map((ref) => truncateText(ref, 200)).slice(0, 10) : [],
      classification: classification.tier,
      createdAt: nowIso
    }
    if (classification.tier === 'read') {
      return { ...base, status: 'allowed_read' }
    }
    if (classification.tier === 'controlled') {
      return { ...base, status: 'pending_review' }
    }
    return { ...base, status: 'rejected', rejectReason: classification.reason }
  })
}

/**
 * 执行一次右脑监察。全程异常隔离：任何失败只收敛为本次运行记录的显式状态，
 * 不抛出、不触碰生产任务与 session 状态机。
 *
 * @param {object} options
 * @param {string} options.trigger 触发来源：manual / periodic / post_startup
 * @param {string|null} options.focusSessionId 重点监察的 session
 * @param {object} options.deps 注入依赖（测试可全部 fake）：
 *   - collectEvidence({ focusSessionId }) => 证据对象（任务健康/失败证据/审计尾部）
 *   - resolveRoute() => null | { unavailableReason? , provider, baseUrl, model, apiKey, headers, transport }
 *   - requestModel({ route, messages, runId }) => { content, usage? }
 * @returns {Promise<object>} 运行记录（status: completed | evidence_unavailable |
 *   model_unavailable | model_error | output_invalid）
 */
export async function runRightBrainSupervision({ trigger = 'manual', focusSessionId = null, deps = {}, nowFn, idFn } = {}) {
  const now = nowFn || (() => new Date().toISOString())
  const makeId = idFn || (() => `rbs_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`)
  const runId = makeId()
  const auditBase = { action: 'right_brain_supervision', sessionId: focusSessionId || null }

  const baseRecord = {
    runId,
    supervisorId: RIGHT_BRAIN_SUPERVISOR_ID,
    trigger: String(trigger || 'manual'),
    focusSessionId: focusSessionId || null,
    ts: now(),
    model: null,
    status: 'completed',
    inputSummary: null,
    outputSummary: null,
    findings: [],
    suggestions: [],
    usage: null,
    error: null
  }

  try {
    // 1. 证据装配（只读；失败显式降级，不带病调用模型）
    let evidence = null
    try {
      evidence = typeof deps.collectEvidence === 'function'
        ? await deps.collectEvidence({ focusSessionId })
        : null
    } catch (error) {
      const record = persistRun({
        ...baseRecord,
        status: 'evidence_unavailable',
        error: redactSecrets(truncateText(safeErrorMessage(error), 300))
      })
      appendGovernanceAudit({ ...auditBase, result: 'blocked', detail: `runId=${runId} evidence_unavailable` })
      return record
    }
    if (!evidence || typeof evidence !== 'object') {
      const record = persistRun({ ...baseRecord, status: 'evidence_unavailable', error: 'evidence_empty' })
      appendGovernanceAudit({ ...auditBase, result: 'blocked', detail: `runId=${runId} evidence_unavailable` })
      return record
    }
    baseRecord.inputSummary = buildEvidenceDigest(evidence)

    // 2. 模型路由：缺失或 key 失效时显式降级，不伪造监察结果
    const route = typeof deps.resolveRoute === 'function' ? await deps.resolveRoute() : null
    if (!route || !route.apiKey) {
      const record = persistRun({
        ...baseRecord,
        status: 'model_unavailable',
        model: route ? { provider: route.provider || null, model: route.model || null } : null,
        error: route?.unavailableReason || 'right_brain_route_unavailable'
      })
      appendGovernanceAudit({ ...auditBase, result: 'blocked', detail: `runId=${runId} model_unavailable:${record.error}` })
      return record
    }
    baseRecord.model = { provider: route.provider || null, model: route.model || null }

    // 3. 调用右脑模型
    const messages = buildSupervisionMessages(evidence, { focusSessionId })
    let response = null
    try {
      response = await deps.requestModel({ route, messages, runId })
    } catch (error) {
      const record = persistRun({
        ...baseRecord,
        status: 'model_error',
        error: redactSecrets(truncateText(safeErrorMessage(error), 300))
      })
      appendGovernanceAudit({ ...auditBase, result: 'blocked', detail: `runId=${runId} model_error` })
      return record
    }

    // 4. 解析输出：非 JSON 不猜测内容，显式标记 output_invalid
    const content = String(response?.content || '')
    const parsed = extractJsonObject(content)
    if (!parsed) {
      const record = persistRun({
        ...baseRecord,
        status: 'output_invalid',
        outputSummary: redactSecrets(truncateText(content, OUTPUT_PREVIEW_MAX_LENGTH)),
        usage: response?.usage || null,
        error: 'model_output_not_json'
      })
      appendGovernanceAudit({ ...auditBase, result: 'blocked', detail: `runId=${runId} output_invalid` })
      return record
    }

    // 5. 建议校验：只读放行 / 受控进人工审核 / 越权拒绝并逐条审计
    const nowIso = now()
    const suggestions = normalizeSuggestions(parsed, runId, nowIso)
    for (const suggestion of suggestions) {
      if (suggestion.status === 'rejected') {
        appendGovernanceAudit({
          action: 'right_brain_suggestion_blocked',
          sessionId: suggestion.params?.sessionId ? String(suggestion.params.sessionId) : null,
          result: 'blocked',
          detail: `runId=${runId} action=${suggestion.action || '(empty)'} reason=${suggestion.rejectReason}`
        })
      }
    }

    const findings = Array.isArray(parsed.findings)
      ? parsed.findings.slice(0, 10).map((item) => ({
          title: truncateText(item?.title, 200),
          detail: truncateText(item?.detail, 500),
          severity: ['info', 'warning', 'critical'].includes(item?.severity) ? item.severity : 'info'
        }))
      : []

    const record = persistRun({
      ...baseRecord,
      status: 'completed',
      outputSummary: redactSecrets(truncateText(parsed.summary, OUTPUT_PREVIEW_MAX_LENGTH)),
      findings,
      suggestions,
      usage: response?.usage || null
    })
    appendGovernanceAudit({
      ...auditBase,
      result: 'ok',
      detail: `runId=${runId} completed findings=${findings.length} suggestions=${suggestions.length}`
    })
    return record
  } catch (error) {
    // 兜底隔离：任何未预期异常都只影响本次监察记录
    try {
      const record = persistRun({
        ...baseRecord,
        status: 'model_error',
        error: redactSecrets(truncateText(`unexpected:${safeErrorMessage(error)}`, 300))
      })
      appendGovernanceAudit({ ...auditBase, result: 'blocked', detail: `runId=${runId} unexpected_error` })
      return record
    } catch {
      return { ...baseRecord, status: 'model_error', error: 'unexpected_persist_failure' }
    }
  }
}

/**
 * 人工审核子 agent 的受控建议。approve 后经注入的 executor（既有受控 API）执行；
 * 子 agent 自身永远没有 executor，无法自批准。
 *
 * @param {string} runId
 * @param {string} suggestionId
 * @param {'approve'|'reject'} decision
 * @param {object} deps { executors: { [action]: (params) => Promise<{ok, ...}> | {ok, ...} } }
 */
export async function reviewSupervisionSuggestion(runId, suggestionId, decision, deps = {}) {
  const store = readStore()
  const run = store.runs.find((item) => item.runId === String(runId || ''))
  if (!run) return { ok: false, error: 'supervision_run_not_found' }
  const suggestion = (run.suggestions || []).find((item) => item.suggestionId === String(suggestionId || ''))
  if (!suggestion) return { ok: false, error: 'supervision_suggestion_not_found' }
  if (decision !== 'approve' && decision !== 'reject') return { ok: false, error: 'invalid_decision' }
  if (suggestion.status !== 'pending_review') {
    return { ok: false, error: 'supervision_suggestion_not_pending', status: suggestion.status }
  }

  const auditBase = {
    action: 'right_brain_suggestion_review',
    sessionId: suggestion.params?.sessionId ? String(suggestion.params.sessionId) : null
  }
  const nowIso = new Date().toISOString()

  if (decision === 'reject') {
    suggestion.status = 'rejected_by_human'
    suggestion.decidedAt = nowIso
    writeStore(store)
    appendGovernanceAudit({ ...auditBase, result: 'ok', decision: 'reject', detail: `runId=${runId} suggestion=${suggestionId} action=${suggestion.action}` })
    return { ok: true, suggestion }
  }

  // approve：必须已注册 executor，且目标 action 属于受控集（双重校验，防记录被篡改）
  const classification = classifySupervisionAction(suggestion.action)
  if (classification.tier !== 'controlled') {
    appendGovernanceAudit({ ...auditBase, result: 'blocked', decision: 'approve', detail: `runId=${runId} suggestion=${suggestionId} action_not_controlled` })
    return { ok: false, error: 'supervision_action_not_controlled' }
  }
  const executor = deps.executors?.[suggestion.action]
  if (typeof executor !== 'function') {
    appendGovernanceAudit({ ...auditBase, result: 'blocked', decision: 'approve', detail: `runId=${runId} suggestion=${suggestionId} executor_not_registered` })
    return { ok: false, error: 'supervision_executor_not_registered' }
  }

  try {
    const result = await executor(suggestion.params || {})
    if (!result || result.ok !== true) {
      const reason = result?.detail || result?.error || 'executor_blocked'
      suggestion.status = 'approved_blocked'
      suggestion.decidedAt = nowIso
      suggestion.executionDetail = redactSecrets(truncateText(String(reason), 300))
      writeStore(store)
      appendGovernanceAudit({ ...auditBase, result: 'blocked', decision: 'approve', detail: `runId=${runId} suggestion=${suggestionId} ${truncateText(String(reason), 200)}` })
      return { ok: false, error: 'supervision_execution_blocked', detail: suggestion.executionDetail, suggestion }
    }
    suggestion.status = 'approved_executed'
    suggestion.decidedAt = nowIso
    suggestion.executionDetail = redactSecrets(truncateText(result.detail || 'executed', 300))
    writeStore(store)
    appendGovernanceAudit({ ...auditBase, result: 'ok', decision: 'approve', detail: `runId=${runId} suggestion=${suggestionId} action=${suggestion.action} executed` })
    return { ok: true, suggestion }
  } catch (error) {
    // executor 异常隔离：建议保持待审核，不污染生产状态
    const message = redactSecrets(truncateText(safeErrorMessage(error), 300))
    appendGovernanceAudit({ ...auditBase, result: 'blocked', decision: 'approve', detail: `runId=${runId} suggestion=${suggestionId} executor_error` })
    return { ok: false, error: 'supervision_executor_error', detail: message }
  }
}
