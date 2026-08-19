/**
 * HERMES-H04：注册表 workflow 的受控执行 runner（总计划 S4-07）。
 *
 * 为注册表中新项目的 workflow 提供与 GameStudio 生产同一治理模型的最小执行链：
 * - 触发先过注册表门禁（evaluateRegistryTriggerGate）：未注册/停用/跨项目归属/
 *   输入不合法一律拒绝并审计，不产生任何写入；
 * - 执行器白名单来自注册表条目；dry_run 执行器只做确定性干跑（回显输入与计划
 *   摘要，不触碰 workspace 外任何资源）；测试可注入自定义 executor；
 *   reasoning_chain 工作流不在此执行（走既有 reasoning session 链路）；
 * - 每个 run 的全部证据（run.json / run.log / artifact.json）只写在所属项目的
 *   注册根目录内（<rootDir>/.workflow-runs/<workflowId>/<runId>/），项目之间
 *   物理隔离；治理审计带 projectId 可按项目对照；
 * - 审核策略与注册表条目一致：执行完成进入 waiting_review，人类 actor 经
 *   reviewRegisteredWorkflowRun 批准/驳回；批准前逐项校验证据要求
 *   （run_log/artifact/audit），缺证据显式 blocked，不静默放行。
 */

import fs from 'node:fs'
import path from 'node:path'
import { appendGovernanceAudit } from './governanceAudit.js'
import { isHumanActor } from '../intents/proposalGovernance.js'
import {
  evaluateRegistryTriggerGate,
  listRegistryProjects,
  resolveProjectRootDir
} from './projectWorkflowRegistry.js'

export const REGISTRY_RUN_STATUS = Object.freeze({
  RUNNING: 'running',
  WAITING_REVIEW: 'waiting_review',
  COMPLETED: 'completed',
  REJECTED: 'rejected',
  FAILED: 'failed'
})

const RUNS_DIR_NAME = '.workflow-runs'
const RUN_ID_PATTERN = /^wfrun_[a-z0-9]+_[a-z0-9]+$/

function createRunId() {
  return `wfrun_${Date.now().toString(36)}_${Math.random().toString(16).slice(2, 8)}`
}

function runsRootDir(project) {
  return path.join(resolveProjectRootDir(project), RUNS_DIR_NAME)
}

function runDirFor(project, workflowId, runId) {
  return path.join(runsRootDir(project), String(workflowId), String(runId))
}

function writeRunRecord(runDir, record) {
  fs.mkdirSync(runDir, { recursive: true })
  const file = path.join(runDir, 'run.json')
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`
  fs.writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`, 'utf8')
  fs.renameSync(tmp, file)
}

function appendRunLog(runDir, message, now) {
  fs.mkdirSync(runDir, { recursive: true })
  fs.appendFileSync(path.join(runDir, 'run.log'), `[${now}] ${message}\n`, 'utf8')
}

function readRunRecord(runDir) {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(runDir, 'run.json'), 'utf8'))
    return raw && typeof raw === 'object' ? raw : null
  } catch {
    return null
  }
}

/** 在全部已注册项目的 runs 目录中定位 run（runId 全局唯一，目录名受模式约束） */
function locateRunDir(runId) {
  const id = String(runId || '').trim()
  if (!RUN_ID_PATTERN.test(id)) return null
  for (const project of listRegistryProjects()) {
    const base = runsRootDir(project)
    let workflowDirs = []
    try {
      workflowDirs = fs.readdirSync(base, { withFileTypes: true })
    } catch {
      continue
    }
    for (const dirent of workflowDirs) {
      if (!dirent.isDirectory()) continue
      const candidate = runDirFor(project, dirent.name, id)
      if (fs.existsSync(path.join(candidate, 'run.json'))) return candidate
    }
  }
  return null
}

export function getRegisteredWorkflowRun(runId) {
  const runDir = locateRunDir(runId)
  if (!runDir) return null
  const record = readRunRecord(runDir)
  return record ? { ...record, runDir } : null
}

export function listRegisteredWorkflowRuns({ projectId, workflowId } = {}) {
  const runs = []
  for (const project of listRegistryProjects()) {
    if (projectId && project.projectId !== projectId) continue
    const base = runsRootDir(project)
    let workflowDirs = []
    try {
      workflowDirs = fs.readdirSync(base, { withFileTypes: true })
    } catch {
      continue
    }
    for (const dirent of workflowDirs) {
      if (!dirent.isDirectory()) continue
      if (workflowId && dirent.name !== workflowId) continue
      let runDirs = []
      try {
        runDirs = fs.readdirSync(path.join(base, dirent.name), { withFileTypes: true })
      } catch {
        continue
      }
      for (const runDirent of runDirs) {
        if (!runDirent.isDirectory() || !RUN_ID_PATTERN.test(runDirent.name)) continue
        const record = readRunRecord(path.join(base, dirent.name, runDirent.name))
        if (record) runs.push(record)
      }
    }
  }
  return runs.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')))
}

/** 默认 dry_run 执行器：确定性干跑，回显输入与执行计划摘要，不写项目根目录外任何内容 */
async function dryRunExecutor({ input, workflow }) {
  return {
    ok: true,
    summary: `dry_run 完成：workflow=${workflow.workflowId}，未执行真实生产动作`,
    artifact: {
      kind: 'dry_run_echo',
      workflowId: workflow.workflowId,
      projectId: workflow.projectId,
      allowedActions: workflow.allowedActions,
      input
    }
  }
}

function auditRun(action, { run, actor = null, result, detail }, nowFn) {
  appendGovernanceAudit({
    action,
    projectId: run?.projectId || null,
    actor,
    result,
    detail
  }, { nowFn })
}

/**
 * 受控触发一个注册表 workflow run。
 * @param {object} options { workflowId, projectId?, input?, actor?, executor?, nowFn? }
 *   executor 仅测试注入用；缺省按注册表条目声明的执行器（当前仅 dry_run 可在此执行）。
 * @returns { ok: true, run } | { ok: false, error, detail }
 */
export async function runRegisteredWorkflow({ workflowId, projectId, input = {}, actor = null, executor, nowFn = () => new Date().toISOString() } = {}) {
  const gate = evaluateRegistryTriggerGate({ workflowId, projectId, input })
  if (!gate.ok) {
    auditRun('registry_workflow_run', { run: { projectId: projectId || null }, actor, result: 'blocked', detail: `${gate.error}:${gate.detail} workflow=${workflowId || '-'}` }, nowFn)
    return { ok: false, error: gate.error, detail: gate.detail }
  }
  const { workflow, project } = gate

  const executorFn = typeof executor === 'function'
    ? executor
    : (workflow.executor === 'dry_run' ? dryRunExecutor : null)
  if (!executorFn) {
    const detail = `workflow=${workflow.workflowId} 声明的 executor=${workflow.executor} 不在此 runner 执行（reasoning_chain 走 reasoning session 链路）`
    auditRun('registry_workflow_run', { run: { projectId: project.projectId }, actor, result: 'blocked', detail }, nowFn)
    return { ok: false, error: 'executor_not_runnable', detail }
  }

  const now = nowFn()
  const runId = createRunId()
  const runDir = runDirFor(project, workflow.workflowId, runId)
  const run = {
    runId,
    workflowId: workflow.workflowId,
    projectId: project.projectId,
    reviewPolicy: workflow.reviewPolicy,
    evidenceRequirements: workflow.evidenceRequirements,
    status: REGISTRY_RUN_STATUS.RUNNING,
    input,
    createdBy: actor || null,
    createdAt: now,
    updatedAt: now,
    review: null,
    error: null
  }
  writeRunRecord(runDir, run)
  appendRunLog(runDir, `run 创建：workflow=${workflow.workflowId} project=${project.projectId} executor=${workflow.executor}${actor ? ` actor=${actor}` : ''}`, now)

  try {
    const result = await executorFn({ input, workflow, project, runDir })
    if (result && result.artifact !== undefined) {
      fs.writeFileSync(path.join(runDir, 'artifact.json'), `${JSON.stringify(result.artifact, null, 2)}\n`, 'utf8')
    }
    if (!result || result.ok !== true) {
      const message = String(result?.error || 'executor_returned_failure')
      run.status = REGISTRY_RUN_STATUS.FAILED
      run.error = message
      run.updatedAt = nowFn()
      writeRunRecord(runDir, run)
      appendRunLog(runDir, `executor 失败：${message}`, run.updatedAt)
      auditRun('registry_workflow_run', { run, actor, result: 'blocked', detail: `executor_failed:${message} runId=${runId}` }, nowFn)
      return { ok: false, error: 'executor_failed', detail: message, run }
    }
    run.status = REGISTRY_RUN_STATUS.WAITING_REVIEW
    run.updatedAt = nowFn()
    writeRunRecord(runDir, run)
    appendRunLog(runDir, `executor 完成：${String(result.summary || 'ok')}；按审核策略 ${workflow.reviewPolicy} 进入 waiting_review`, run.updatedAt)
    auditRun('registry_workflow_run', { run, actor, result: 'ok', detail: `submitted:runId=${runId} workflow=${workflow.workflowId} status=waiting_review` }, nowFn)
    return { ok: true, run }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    run.status = REGISTRY_RUN_STATUS.FAILED
    run.error = message
    run.updatedAt = nowFn()
    writeRunRecord(runDir, run)
    appendRunLog(runDir, `executor 异常：${message}`, run.updatedAt)
    auditRun('registry_workflow_run', { run, actor, result: 'blocked', detail: `executor_error:${message} runId=${runId}` }, nowFn)
    return { ok: false, error: 'executor_error', detail: message, run }
  }
}

/** 证据逐项校验：缺证据显式返回缺失清单，不静默放行 */
export function evaluateRunEvidence(run) {
  const runDir = locateRunDir(run.runId) || run.runDir
  const missing = []
  for (const kind of run.evidenceRequirements || []) {
    if (kind === 'run_log') {
      const file = path.join(runDir, 'run.log')
      if (!fs.existsSync(file) || fs.statSync(file).size === 0) missing.push('run_log')
    } else if (kind === 'artifact') {
      const file = path.join(runDir, 'artifact.json')
      if (!fs.existsSync(file) || fs.statSync(file).size === 0) missing.push('artifact')
    } else if (kind === 'audit') {
      // 审核动作本身必写审计（见下），该要求恒可满足
      continue
    } else {
      // runner 无法校验的证据种类（如 session_events/queue_item 属 reasoning 链路）按缺失处理
      missing.push(kind)
    }
  }
  return missing.length === 0 ? { ok: true } : { ok: false, error: 'evidence_missing', detail: `证据缺失：${missing.join(', ')}` }
}

/**
 * 人工审核一个 waiting_review 的 run（与注册表条目声明的审核策略一致：
 * 必须人类 actor；approve 前逐项校验证据要求）。
 * @param {object} options { decision: 'approve' | 'reject', actor, note?, nowFn? }
 */
export function reviewRegisteredWorkflowRun(runId, { decision, actor, note = '', nowFn = () => new Date().toISOString() } = {}) {
  const normalizedDecision = String(decision || '').trim().toLowerCase()
  const runDir = locateRunDir(runId)
  const run = runDir ? readRunRecord(runDir) : null
  const auditProjectId = run?.projectId || null
  const reject = (error, detail) => {
    appendGovernanceAudit({ action: 'registry_run_review', projectId: auditProjectId, actor: actor || null, result: 'blocked', detail: `${error}:${detail} runId=${runId || '-'}` }, { nowFn })
    return { ok: false, error, detail }
  }
  if (!isHumanActor(actor)) {
    return reject('actor_not_human', '注册表 run 的审核必须由人类操作者执行，自动路径身份一律拒绝')
  }
  if (!run) {
    return { ok: false, error: 'registry_run_not_found', detail: `runId=${runId || '-'} 不存在` }
  }
  if (run.status !== REGISTRY_RUN_STATUS.WAITING_REVIEW) {
    return reject('illegal_run_status', `当前状态 ${run.status}，仅 waiting_review 可审核`)
  }
  if (!['approve', 'reject'].includes(normalizedDecision)) {
    return reject('unknown_decision', `decision=${decision || '-'} 仅支持 approve/reject`)
  }

  const now = nowFn()
  if (normalizedDecision === 'approve') {
    const evidence = evaluateRunEvidence({ ...run, runDir })
    if (!evidence.ok) {
      return reject(evidence.error, evidence.detail)
    }
  }

  run.status = normalizedDecision === 'approve' ? REGISTRY_RUN_STATUS.COMPLETED : REGISTRY_RUN_STATUS.REJECTED
  run.review = { decision: normalizedDecision, actor: String(actor), note: String(note || '').slice(0, 280), at: now }
  run.updatedAt = now
  writeRunRecord(runDir, run)
  appendRunLog(runDir, `人工审核 ${normalizedDecision}：actor=${actor}${note ? ` note=${String(note).slice(0, 120)}` : ''} -> ${run.status}`, now)
  appendGovernanceAudit({
    action: 'registry_run_review',
    projectId: run.projectId,
    actor: String(actor),
    result: 'ok',
    decision: normalizedDecision,
    detail: `runId=${run.runId} workflow=${run.workflowId} -> ${run.status}`
  }, { nowFn })
  return { ok: true, run }
}
