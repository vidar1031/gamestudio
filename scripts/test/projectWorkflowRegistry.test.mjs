import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { Hono } from 'hono'
import {
  evaluateRegistryTriggerGate,
  getRegistryProject,
  getRegistryWorkflow,
  listRegistryProjects,
  listRegistryWorkflows,
  registerRegistryProject,
  registerRegistryWorkflow,
  resolveRegistryProjectBinding,
  setRegistryEntryEnabled
} from '../../apps/control-server/src/server/reasoning/projectWorkflowRegistry.js'
import {
  getRegisteredWorkflowRun,
  listRegisteredWorkflowRuns,
  reviewRegisteredWorkflowRun,
  runRegisteredWorkflow
} from '../../apps/control-server/src/server/reasoning/registryWorkflowRunner.js'
import {
  CRON_WORKFLOW_REGISTRY,
  createCronJob,
  isCronWorkflowRegistered
} from '../../apps/control-server/src/server/reasoning/cronGovernance.js'
import { readGovernanceAudit } from '../../apps/control-server/src/server/reasoning/governanceAudit.js'
import { registerRegistryRoutes } from '../../apps/control-server/src/server/routes/registryRoutes.js'

// HERMES-H04 测试：项目与 workflow 注册表（总计划 S4-07）。
// 覆盖：内建条目对齐、受控注册（人类 actor + 校验矩阵 + 审计）、触发门禁
// （未注册/停用/跨项目/输入 schema）、第二个项目受控执行全链路（隔离证据）、
// cron 消费注册表（H02 语义不回归）、HTTP 路由全链路。
// env 隔离：注册表/审计/cron jobs 文件指向临时目录；demo 项目根目录在
// workspace .tmp 下（注册表边界要求 rootDir 在 workspace 内），用后即清理。

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'h04-registry-'))
const REGISTRY_FILE = path.join(TMP_DIR, 'project-workflow-registry.json')
const AUDIT_FILE = path.join(TMP_DIR, 'governance-audit.jsonl')
const CRON_JOBS_FILE = path.join(TMP_DIR, 'cron-jobs.json')

const WORKSPACE_TMP = path.join(process.cwd(), '.tmp', `h04-registry-test-${process.pid}`)
const DEMO_ROOT_REL = path.relative(process.cwd(), path.join(WORKSPACE_TMP, 'demo-image-site'))
const DEMO_ROOT_ABS = path.join(process.cwd(), DEMO_ROOT_REL)

const savedRegistryEnv = process.env.HERMES_PROJECT_WORKFLOW_REGISTRY_FILE
const savedAuditEnv = process.env.HERMES_GOVERNANCE_AUDIT_FILE
const savedCronJobsEnv = process.env.HERMES_CRON_JOBS_FILE
process.env.HERMES_PROJECT_WORKFLOW_REGISTRY_FILE = REGISTRY_FILE
process.env.HERMES_GOVERNANCE_AUDIT_FILE = AUDIT_FILE
process.env.HERMES_CRON_JOBS_FILE = CRON_JOBS_FILE

function restoreEnv() {
  if (savedRegistryEnv === undefined) delete process.env.HERMES_PROJECT_WORKFLOW_REGISTRY_FILE
  else process.env.HERMES_PROJECT_WORKFLOW_REGISTRY_FILE = savedRegistryEnv
  if (savedAuditEnv === undefined) delete process.env.HERMES_GOVERNANCE_AUDIT_FILE
  else process.env.HERMES_GOVERNANCE_AUDIT_FILE = savedAuditEnv
  if (savedCronJobsEnv === undefined) delete process.env.HERMES_CRON_JOBS_FILE
  else process.env.HERMES_CRON_JOBS_FILE = savedCronJobsEnv
}

process.on('exit', () => {
  restoreEnv()
  try { fs.rmSync(WORKSPACE_TMP, { recursive: true, force: true }) } catch { /* 清理失败不阻断退出 */ }
})

const FIXED_NOW = '2026-08-15T09:00:00.000Z'
const fixedNowFn = () => FIXED_NOW

function resetFiles() {
  for (const file of [REGISTRY_FILE, AUDIT_FILE, CRON_JOBS_FILE]) {
    try { fs.rmSync(file) } catch { /* 不存在则忽略 */ }
  }
  fs.rmSync(WORKSPACE_TMP, { recursive: true, force: true })
  fs.mkdirSync(DEMO_ROOT_ABS, { recursive: true })
}

function auditRecords() {
  return readGovernanceAudit(500).records
}

function registerDemoProject(overrides = {}) {
  const result = registerRegistryProject({
    projectId: 'demo-image-site',
    name: 'Demo 图片站',
    rootDir: DEMO_ROOT_REL,
    description: 'H04 第二个项目：验证注册表可复用与项目间隔离',
    ...overrides
  }, { actor: 'human:test', nowFn: fixedNowFn })
  assert.equal(result.ok, true, result.detail)
  return result.project
}

function registerDemoWorkflow(overrides = {}) {
  const result = registerRegistryWorkflow({
    workflowId: 'demo_listing',
    projectId: 'demo-image-site',
    label: 'Demo 素材清单生成',
    executor: 'dry_run',
    inputSchema: {
      topic: { type: 'string', required: true },
      outputDir: { type: 'string', path: true }
    },
    allowedActions: ['workspace.list', 'workspace.write'],
    reviewPolicy: 'manual',
    evidenceRequirements: ['run_log', 'artifact', 'audit'],
    ...overrides
  }, { actor: 'human:test', nowFn: fixedNowFn })
  assert.equal(result.ok, true, result.detail)
  return result.workflow
}

test('S4-07：内建条目——GameStudio 项目与三个既有 workflow 已登记且元数据完整', () => {
  resetFiles()
  const projects = listRegistryProjects()
  const gamestudio = projects.find((entry) => entry.projectId === 'gamestudio')
  assert.ok(gamestudio, 'gamestudio 内建项目应始终存在')
  assert.equal(gamestudio.rootDir, 'storage/projects')
  assert.equal(gamestudio.enabled, true)
  assert.equal(gamestudio.builtIn, true)

  const workflows = listRegistryWorkflows({ projectId: 'gamestudio' })
  const ids = workflows.map((entry) => entry.workflowId).sort()
  assert.deepEqual(ids, ['gamestudio_bootstrap', 'project_status', 'story_production'])
  for (const workflow of workflows) {
    assert.ok(workflow.inputSchema && typeof workflow.inputSchema === 'object', `${workflow.workflowId} 应有输入 schema`)
    assert.ok(workflow.allowedActions.length > 0, `${workflow.workflowId} 应有允许 action 集`)
    assert.ok(['manual', 'ai_assisted'].includes(workflow.reviewPolicy), `${workflow.workflowId} 应有审核策略`)
    assert.ok(workflow.evidenceRequirements.length > 0, `${workflow.workflowId} 应有证据要求`)
    assert.equal(workflow.executor, 'reasoning_chain')
    assert.equal(workflow.builtIn, true)
  }
  // cron 内建视图与注册表内建条目对齐（H02 语义不回归）
  assert.deepEqual(Object.keys(CRON_WORKFLOW_REGISTRY).sort(), ids)
  for (const id of Object.keys(CRON_WORKFLOW_REGISTRY)) {
    assert.equal(isCronWorkflowRegistered(id), true, `${id} 应可触发`)
  }
})

test('S4-07：受控注册——人类 actor 注册项目与 workflow 成功、持久化并审计', () => {
  resetFiles()
  const project = registerDemoProject()
  assert.equal(project.enabled, true)
  assert.equal(project.builtIn, false)
  const workflow = registerDemoWorkflow()
  assert.equal(workflow.projectId, 'demo-image-site')

  // 持久化：重新读取仍可见
  assert.ok(getRegistryProject('demo-image-site'))
  assert.ok(getRegistryWorkflow('demo_listing'))
  const raw = JSON.parse(fs.readFileSync(REGISTRY_FILE, 'utf8'))
  assert.equal(raw.projects.length, 1)
  assert.equal(raw.workflows.length, 1)

  const projectAudit = auditRecords().find((entry) => entry.action === 'registry_project_register' && entry.result === 'ok')
  assert.ok(projectAudit, '应有项目注册审计')
  assert.equal(projectAudit.projectId, 'demo-image-site')
  assert.equal(projectAudit.actor, 'human:test')
  const workflowAudit = auditRecords().find((entry) => entry.action === 'registry_workflow_register' && entry.result === 'ok')
  assert.ok(workflowAudit, '应有 workflow 注册审计')
  assert.match(workflowAudit.detail, /demo_listing/)
})

test('S4-07：注册表条目创建/变更拒绝非人类 actor 并审计 blocked', () => {
  resetFiles()
  for (const actor of [undefined, '', 'model:omlx', 'cron:scheduler', 'agent:hermes', 'system:auto']) {
    const projectResult = registerRegistryProject({ projectId: 'ghost-proj', name: 'x', rootDir: DEMO_ROOT_REL }, { actor, nowFn: fixedNowFn })
    assert.equal(projectResult.ok, false, `actor=${actor} 应被拒绝`)
    assert.equal(projectResult.error, 'actor_not_human')
  }
  registerDemoProject()
  for (const actor of [undefined, 'model:omlx', 'cron:scheduler']) {
    const workflowResult = registerRegistryWorkflow({
      workflowId: 'ghost_flow', projectId: 'demo-image-site', label: 'x', executor: 'dry_run',
      inputSchema: {}, allowedActions: ['a'], reviewPolicy: 'manual', evidenceRequirements: ['run_log']
    }, { actor, nowFn: fixedNowFn })
    assert.equal(workflowResult.ok, false)
    assert.equal(workflowResult.error, 'actor_not_human')
  }
  const blocked = auditRecords().filter((entry) => entry.result === 'blocked' && /actor_not_human/.test(entry.detail || ''))
  assert.ok(blocked.length >= 8, `应有至少 8 条 actor 阻断审计（实际 ${blocked.length}）`)
})

test('S4-07：非法条目校验矩阵——审核策略/action 集/证据/执行器/根目录/内建保护', () => {
  resetFiles()
  registerDemoProject()
  const base = {
    workflowId: 'bad_flow', projectId: 'demo-image-site', label: 'x', executor: 'dry_run',
    inputSchema: {}, allowedActions: ['a'], reviewPolicy: 'manual', evidenceRequirements: ['run_log']
  }
  const cases = [
    [{ reviewPolicy: null }, 'review_policy_required'],
    [{ reviewPolicy: 'none' }, 'review_policy_not_allowed'],
    [{ reviewPolicy: 'full_auto' }, 'review_policy_not_allowed'],
    [{ allowedActions: [] }, 'allowed_actions_required'],
    [{ evidenceRequirements: [] }, 'evidence_requirements_required'],
    [{ executor: 'direct_write' }, 'executor_not_registered'],
    [{ projectId: 'ghost-project' }, 'project_not_registered'],
    [{ workflowId: 'story_production' }, 'builtin_entry_protected'],
    [{ inputSchema: { topic: { type: 'text' } } }, 'input_schema_invalid']
  ]
  for (const [patch, expected] of cases) {
    const input = { ...base, ...patch }
    if (patch.reviewPolicy === null) delete input.reviewPolicy
    const result = registerRegistryWorkflow(input, { actor: 'human:test', nowFn: fixedNowFn })
    assert.equal(result.ok, false, `${JSON.stringify(patch)} 应被拒绝`)
    assert.equal(result.error, expected, `${JSON.stringify(patch)} -> ${result.error}`)
  }
  // 项目侧：绝对路径/越界/与内建项目根目录嵌套/重复/内建覆盖
  assert.equal(registerRegistryProject({ projectId: 'p_abs', name: 'x', rootDir: '/etc/x' }, { actor: 'human:test', nowFn: fixedNowFn }).error, 'root_dir_outside_workspace')
  assert.equal(registerRegistryProject({ projectId: 'p_escape', name: 'x', rootDir: '../outside' }, { actor: 'human:test', nowFn: fixedNowFn }).error, 'root_dir_outside_workspace')
  assert.equal(registerRegistryProject({ projectId: 'p_nested', name: 'x', rootDir: 'storage/projects/demo' }, { actor: 'human:test', nowFn: fixedNowFn }).error, 'project_root_conflict')
  assert.equal(registerRegistryProject({ projectId: 'demo-image-site', name: 'x', rootDir: DEMO_ROOT_REL }, { actor: 'human:test', nowFn: fixedNowFn }).error, 'project_already_registered')
  assert.equal(registerRegistryProject({ projectId: 'gamestudio', name: 'x', rootDir: DEMO_ROOT_REL }, { actor: 'human:test', nowFn: fixedNowFn }).error, 'builtin_entry_protected')
  // 全部拒绝都有 blocked 审计
  assert.ok(auditRecords().filter((entry) => entry.result === 'blocked').length >= cases.length + 5)
})

test('S4-07：触发门禁——未注册/输入 schema/跨项目路径与归属拒绝', () => {
  resetFiles()
  registerDemoProject()
  registerDemoWorkflow()

  // 未注册 workflow
  assert.equal(evaluateRegistryTriggerGate({ workflowId: 'ghost_flow', input: {} }).error, 'workflow_not_registered')
  // 合法触发（注册项目本身 + 合法输入）
  const okGate = evaluateRegistryTriggerGate({ workflowId: 'demo_listing', projectId: 'demo-image-site', input: { topic: '风景', outputDir: 'out' } })
  assert.equal(okGate.ok, true, okGate.detail)
  assert.equal(okGate.workflow.workflowId, 'demo_listing')
  // 输入 schema：缺 required / 未知字段 / 类型错误
  assert.match(evaluateRegistryTriggerGate({ workflowId: 'demo_listing', input: {} }).detail || '', /必填/)
  assert.match(evaluateRegistryTriggerGate({ workflowId: 'demo_listing', input: { topic: 'x', ghost: 1 } }).detail || '', /未在 .* inputSchema 中声明/)
  assert.match(evaluateRegistryTriggerGate({ workflowId: 'demo_listing', input: { topic: 123 } }).detail || '', /类型应为 string/)
  // 跨项目路径：path 字段越出项目根目录（含指向 GameStudio 项目目录）
  const crossPath = evaluateRegistryTriggerGate({ workflowId: 'demo_listing', input: { topic: 'x', outputDir: '../../storage/projects/victim' } })
  assert.equal(crossPath.ok, false)
  assert.equal(crossPath.error, 'input_invalid')
  assert.match(crossPath.detail, /跨项目路径拒绝/)
  // 跨项目归属：projectId 指向另一个已注册项目
  const crossProject = evaluateRegistryTriggerGate({ workflowId: 'demo_listing', projectId: 'gamestudio', input: { topic: 'x' } })
  assert.equal(crossProject.error, 'cross_project_rejected')
  // 实例子目录归属合法（项目根目录下的实例 id）
  const workflow = getRegistryWorkflow('demo_listing')
  const instance = resolveRegistryProjectBinding(workflow, 'batch-2026-08')
  assert.equal(instance.ok, true)
  assert.equal(instance.binding, 'instance')
  // gamestudio 侧：任意 story 项目 id 是其实例；指向 demo 项目则跨项目拒绝
  const storyWorkflow = getRegistryWorkflow('story_production')
  assert.equal(resolveRegistryProjectBinding(storyWorkflow, 'proj_any_story').binding, 'instance')
  assert.equal(resolveRegistryProjectBinding(storyWorkflow, 'demo-image-site').error, 'cross_project_rejected')
})

test('S4-07：启停治理——停用项目/workflow 后触发拒绝；内建条目受保护', () => {
  resetFiles()
  registerDemoProject()
  registerDemoWorkflow()

  const disabled = setRegistryEntryEnabled('workflow', 'demo_listing', false, { actor: 'human:test', nowFn: fixedNowFn })
  assert.equal(disabled.ok, true)
  assert.equal(evaluateRegistryTriggerGate({ workflowId: 'demo_listing', input: { topic: 'x' } }).error, 'workflow_disabled')
  setRegistryEntryEnabled('workflow', 'demo_listing', true, { actor: 'human:test', nowFn: fixedNowFn })

  setRegistryEntryEnabled('project', 'demo-image-site', false, { actor: 'human:test', nowFn: fixedNowFn })
  assert.equal(evaluateRegistryTriggerGate({ workflowId: 'demo_listing', input: { topic: 'x' } }).error, 'project_disabled')
  setRegistryEntryEnabled('project', 'demo-image-site', true, { actor: 'human:test', nowFn: fixedNowFn })

  // 内建条目不可停用/变更（既有 GameStudio workflow 可用性不被注册表操作破坏）
  assert.equal(setRegistryEntryEnabled('workflow', 'story_production', false, { actor: 'human:test', nowFn: fixedNowFn }).error, 'builtin_entry_protected')
  assert.equal(setRegistryEntryEnabled('project', 'gamestudio', false, { actor: 'human:test', nowFn: fixedNowFn }).error, 'builtin_entry_protected')
  // 非人类 actor 与未注册条目
  assert.equal(setRegistryEntryEnabled('workflow', 'demo_listing', false, { actor: 'model:omlx', nowFn: fixedNowFn }).error, 'actor_not_human')
  assert.equal(setRegistryEntryEnabled('workflow', 'ghost_flow', false, { actor: 'human:test', nowFn: fixedNowFn }).error, 'workflow_not_registered')
  // 恢复后触发正常
  assert.equal(evaluateRegistryTriggerGate({ workflowId: 'demo_listing', input: { topic: 'x' } }).ok, true)
  assert.ok(auditRecords().some((entry) => entry.action === 'registry_entry_status' && entry.result === 'ok'))
})

test('S4-07：第二个项目完成受控 workflow——task/artifact/日志与 GameStudio 隔离', async () => {
  resetFiles()
  registerDemoProject()
  registerDemoWorkflow()

  // GameStudio 真相源快照（顶层条目清单），用于隔离对照
  const storageProjectsDir = path.join(process.cwd(), 'storage', 'projects')
  const beforeListing = fs.readdirSync(storageProjectsDir).sort()

  const result = await runRegisteredWorkflow({
    workflowId: 'demo_listing',
    projectId: 'demo-image-site',
    input: { topic: '风景', outputDir: 'out' },
    actor: 'human:test',
    nowFn: fixedNowFn
  })
  assert.equal(result.ok, true, result.detail)
  const run = result.run
  assert.equal(run.status, 'waiting_review')
  assert.equal(run.projectId, 'demo-image-site')

  // 证据落在 demo 项目根目录内（task=run.json、日志=run.log、artifact=artifact.json）
  const runDir = path.join(DEMO_ROOT_ABS, '.workflow-runs', 'demo_listing', run.runId)
  assert.ok(fs.existsSync(path.join(runDir, 'run.json')), 'run.json 应存在')
  assert.ok(fs.existsSync(path.join(runDir, 'run.log')), 'run.log 应存在')
  assert.ok(fs.existsSync(path.join(runDir, 'artifact.json')), 'artifact.json 应存在')
  const persisted = JSON.parse(fs.readFileSync(path.join(runDir, 'run.json'), 'utf8'))
  assert.equal(persisted.status, 'waiting_review')
  const artifact = JSON.parse(fs.readFileSync(path.join(runDir, 'artifact.json'), 'utf8'))
  assert.equal(artifact.kind, 'dry_run_echo')
  assert.equal(artifact.input.topic, '风景')
  assert.ok(fs.readFileSync(path.join(runDir, 'run.log'), 'utf8').includes('demo_listing'))

  // 隔离对照：GameStudio 真相源零写入，demo 证据不出现在 storage/projects 下
  assert.deepEqual(fs.readdirSync(storageProjectsDir).sort(), beforeListing, 'storage/projects 不应有任何变化')
  assert.ok(!runDir.startsWith(storageProjectsDir), 'demo run 目录不得在 GameStudio 项目根内')

  // 审计可按项目对照
  const runAudit = auditRecords().find((entry) => entry.action === 'registry_workflow_run' && entry.result === 'ok')
  assert.ok(runAudit)
  assert.equal(runAudit.projectId, 'demo-image-site')

  // 人工审核（人类 actor）→ completed，review 记录落 run.json
  const review = reviewRegisteredWorkflowRun(run.runId, { decision: 'approve', actor: 'human:reviewer', note: '干跑证据齐全', nowFn: fixedNowFn })
  assert.equal(review.ok, true, review.detail)
  assert.equal(review.run.status, 'completed')
  const afterReview = getRegisteredWorkflowRun(run.runId)
  assert.equal(afterReview.review.actor, 'human:reviewer')
  assert.equal(afterReview.review.decision, 'approve')
  const reviewAudit = auditRecords().find((entry) => entry.action === 'registry_run_review' && entry.result === 'ok')
  assert.ok(reviewAudit)
  assert.equal(reviewAudit.projectId, 'demo-image-site')
  assert.equal(reviewAudit.decision, 'approve')

  // 列表与 GameStudio 项目 run 列表互不污染
  const demoRuns = listRegisteredWorkflowRuns({ projectId: 'demo-image-site' })
  assert.equal(demoRuns.length, 1)
  assert.equal(listRegisteredWorkflowRuns({ projectId: 'gamestudio' }).length, 0)
})

test('S4-07：审核治理——reject 流转、非人类 actor 拒绝、非法状态拒绝', async () => {
  resetFiles()
  registerDemoProject()
  registerDemoWorkflow()

  const rejected = await runRegisteredWorkflow({ workflowId: 'demo_listing', input: { topic: '城市' }, actor: 'human:test', nowFn: fixedNowFn })
  assert.equal(rejected.ok, true)
  // 非人类 actor 审核拒绝 + 审计 blocked，run 保持 waiting_review
  const actorBlock = reviewRegisteredWorkflowRun(rejected.run.runId, { decision: 'approve', actor: 'model:omlx', nowFn: fixedNowFn })
  assert.equal(actorBlock.ok, false)
  assert.equal(actorBlock.error, 'actor_not_human')
  assert.equal(getRegisteredWorkflowRun(rejected.run.runId).status, 'waiting_review')
  // reject 决策
  const review = reviewRegisteredWorkflowRun(rejected.run.runId, { decision: 'reject', actor: 'human:reviewer', note: '不符合预期', nowFn: fixedNowFn })
  assert.equal(review.ok, true)
  assert.equal(review.run.status, 'rejected')
  // 终态后重复审核 → illegal_run_status
  const again = reviewRegisteredWorkflowRun(rejected.run.runId, { decision: 'approve', actor: 'human:reviewer', nowFn: fixedNowFn })
  assert.equal(again.ok, false)
  assert.equal(again.error, 'illegal_run_status')
  // 不存在的 run
  assert.equal(reviewRegisteredWorkflowRun('wfrun_ghost_0000', { decision: 'approve', actor: 'human:reviewer', nowFn: fixedNowFn }).error, 'registry_run_not_found')
})

test('S4-07：证据要求强制——缺 artifact 的 run 批准被 evidence_missing 阻断', async () => {
  resetFiles()
  registerDemoProject()
  registerDemoWorkflow()
  // 注入不产 artifact 的 executor（模拟执行器未按证据要求产出）
  const result = await runRegisteredWorkflow({
    workflowId: 'demo_listing',
    input: { topic: '静物' },
    actor: 'human:test',
    executor: async () => ({ ok: true, summary: '无 artifact 输出' }),
    nowFn: fixedNowFn
  })
  assert.equal(result.ok, true)
  const approve = reviewRegisteredWorkflowRun(result.run.runId, { decision: 'approve', actor: 'human:reviewer', nowFn: fixedNowFn })
  assert.equal(approve.ok, false)
  assert.equal(approve.error, 'evidence_missing')
  assert.match(approve.detail, /artifact/)
  // run 保持 waiting_review，可补齐证据后重审
  assert.equal(getRegisteredWorkflowRun(result.run.runId).status, 'waiting_review')
  const blockedAudit = auditRecords().find((entry) => entry.action === 'registry_run_review' && entry.result === 'blocked' && /evidence_missing/.test(entry.detail || ''))
  assert.ok(blockedAudit, '缺证据阻断应审计')
})

test('S4-07：executor 失败显式 FAILED 并审计；reasoning_chain 不在 runner 执行', async () => {
  resetFiles()
  registerDemoProject()
  registerDemoWorkflow()
  const failed = await runRegisteredWorkflow({
    workflowId: 'demo_listing',
    input: { topic: '人物' },
    actor: 'human:test',
    executor: async () => ({ ok: false, error: 'deterministic_failure' }),
    nowFn: fixedNowFn
  })
  assert.equal(failed.ok, false)
  assert.equal(failed.error, 'executor_failed')
  assert.equal(getRegisteredWorkflowRun(failed.run.runId).status, 'failed')
  assert.ok(auditRecords().some((entry) => entry.action === 'registry_workflow_run' && entry.result === 'blocked' && /deterministic_failure/.test(entry.detail || '')))

  // 内建 story_production 走 reasoning 链路，runner 显式拒绝（门禁通过但 executor 不可在此执行）
  const chainRun = await runRegisteredWorkflow({ workflowId: 'story_production', input: { prompt: '生产一个故事' }, actor: 'human:test', nowFn: fixedNowFn })
  assert.equal(chainRun.ok, false)
  assert.equal(chainRun.error, 'executor_not_runnable')
})

test('S4-07：cron 消费注册表——新 workflow 可被选择，停用/跨项目归属拒绝（H02 语义不回归）', () => {
  resetFiles()
  registerDemoProject()
  registerDemoWorkflow()

  // 注册后即可被 cron 选择（无需改代码）
  assert.equal(isCronWorkflowRegistered('demo_listing'), true)
  const job = createCronJob({ workflow: 'demo_listing', prompt: '每日生成素材清单', intervalMs: 60000, projectId: 'demo-image-site' }, { nowFn: fixedNowFn })
  assert.equal(job.ok, true, job.detail)
  assert.equal(job.job.projectId, 'demo-image-site')

  // 停用 workflow 后 cron 创建拒绝（注册时校验）
  setRegistryEntryEnabled('workflow', 'demo_listing', false, { actor: 'human:test', nowFn: fixedNowFn })
  const disabledJob = createCronJob({ workflow: 'demo_listing', prompt: 'x', intervalMs: 60000 }, { nowFn: fixedNowFn })
  assert.equal(disabledJob.ok, false)
  assert.equal(disabledJob.error, 'workflow_not_registered')
  setRegistryEntryEnabled('workflow', 'demo_listing', true, { actor: 'human:test', nowFn: fixedNowFn })

  // 跨项目归属拒绝 + 审计
  const crossJob = createCronJob({ workflow: 'demo_listing', prompt: 'x', intervalMs: 60000, projectId: 'gamestudio' }, { nowFn: fixedNowFn })
  assert.equal(crossJob.ok, false)
  assert.equal(crossJob.error, 'cross_project_rejected')
  const crossAudit = auditRecords().find((entry) => entry.action === 'cron_job_create' && entry.result === 'blocked' && /cross_project_rejected/.test(entry.detail || ''))
  assert.ok(crossAudit, '跨项目 cron job 拒绝应审计')

  // H02 语义不回归：未注册 workflow 拒绝；story 实例 projectId 合法
  assert.equal(createCronJob({ workflow: 'ghost_workflow', prompt: 'x', intervalMs: 60000 }, { nowFn: fixedNowFn }).error, 'workflow_not_registered')
  const storyJob = createCronJob({ workflow: 'story_production', prompt: '生产一个故事', intervalMs: 60000, projectId: 'proj_story_instance' }, { nowFn: fixedNowFn })
  assert.equal(storyJob.ok, true, storyJob.detail)
})

test('S4-07：HTTP 全链路——注册/发现/触发/审核/拒绝语义', async () => {
  resetFiles()
  const app = new Hono()
  registerRegistryRoutes(app)

  // 能力发现面：内建条目可见
  const overview = await app.request('/api/control/registry/overview')
  assert.equal(overview.status, 200)
  const overviewBody = await overview.json()
  assert.ok(overviewBody.projects.some((entry) => entry.projectId === 'gamestudio'))
  assert.equal(overviewBody.workflows.filter((entry) => entry.builtIn).length, 3)

  // 非人类 actor 注册 403
  const badActor = await app.request('/api/control/registry/projects', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ projectId: 'p1', name: 'x', rootDir: DEMO_ROOT_REL, actor: 'model:omlx' })
  })
  assert.equal(badActor.status, 403)
  assert.equal((await badActor.json()).error, 'actor_not_human')

  // 注册项目 + workflow
  const projectResp = await app.request('/api/control/registry/projects', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ projectId: 'demo-image-site', name: 'Demo 图片站', rootDir: DEMO_ROOT_REL, actor: 'human:console' })
  })
  assert.equal(projectResp.status, 200)
  const workflowResp = await app.request('/api/control/registry/workflows', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      workflowId: 'demo_listing', projectId: 'demo-image-site', label: 'Demo 素材清单生成', executor: 'dry_run',
      inputSchema: { topic: { type: 'string', required: true } }, allowedActions: ['workspace.list'],
      reviewPolicy: 'manual', evidenceRequirements: ['run_log', 'artifact', 'audit'], actor: 'human:console'
    })
  })
  assert.equal(workflowResp.status, 200)
  // reviewPolicy 'none' 拒绝
  const nonePolicy = await app.request('/api/control/registry/workflows', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      workflowId: 'demo_none', projectId: 'demo-image-site', label: 'x', executor: 'dry_run',
      inputSchema: {}, allowedActions: ['a'], reviewPolicy: 'none', evidenceRequirements: ['run_log'], actor: 'human:console'
    })
  })
  assert.equal(nonePolicy.status, 400)
  assert.equal((await nonePolicy.json()).error, 'review_policy_not_allowed')

  // 触发：未注册 workflow 404；跨项目归属 403；合法触发 waiting_review
  const notRegistered = await app.request('/api/control/registry/workflows/ghost_flow/runs', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ input: {} })
  })
  assert.equal(notRegistered.status, 404)
  assert.equal((await notRegistered.json()).error, 'workflow_not_registered')
  const crossProject = await app.request('/api/control/registry/workflows/demo_listing/runs', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ projectId: 'gamestudio', input: { topic: 'x' } })
  })
  assert.equal(crossProject.status, 403)
  assert.equal((await crossProject.json()).error, 'cross_project_rejected')
  const inputInvalid = await app.request('/api/control/registry/workflows/demo_listing/runs', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ input: {} })
  })
  assert.equal(inputInvalid.status, 403)
  assert.equal((await inputInvalid.json()).error, 'input_invalid')

  const runResp = await app.request('/api/control/registry/workflows/demo_listing/runs', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ projectId: 'demo-image-site', input: { topic: '风景' }, actor: 'human:console' })
  })
  assert.equal(runResp.status, 200)
  const runBody = await runResp.json()
  assert.equal(runBody.run.status, 'waiting_review')

  // 审核：approve → completed；GET 详情；未知 run 404
  const reviewResp = await app.request(`/api/control/registry/runs/${runBody.run.runId}/review`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ decision: 'approve', actor: 'human:reviewer' })
  })
  assert.equal(reviewResp.status, 200)
  assert.equal((await reviewResp.json()).run.status, 'completed')
  const runDetail = await app.request(`/api/control/registry/runs/${runBody.run.runId}`)
  assert.equal(runDetail.status, 200)
  const ghostRun = await app.request('/api/control/registry/runs/wfrun_ghost_0000')
  assert.equal(ghostRun.status, 404)

  // 内建条目停用 409（保护既有 GameStudio workflow）
  const disableBuiltin = await app.request('/api/control/registry/workflows/story_production/status', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled: false, actor: 'human:console' })
  })
  assert.equal(disableBuiltin.status, 409)
  assert.equal((await disableBuiltin.json()).error, 'builtin_entry_protected')
})
