import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { Hono } from 'hono'

// AUTO-F02 测试：proposal 测试、审核、晋级与回滚（S4-06 全覆盖）。
// 覆盖：_inbox 默认不可执行/不可自动晋级、自动路径身份（model/cron）调用审核/激活/
// 回滚一律拒绝+审计、未测试/未审核激活拒绝、测试门禁（编译/样例命中/评估可达）、
// 审核后激活成功（版本记录+证据）、激活失败自动回滚、人工回滚恢复上一版本、
// 版本保留与追溯、驳回保留快照、HTTP 路由全链路。
// env 隔离：intents 目录 / 治理文件 / 审计文件全部指向临时目录，不污染真实 config/state。

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'proposal-governance-'))
const INTENTS_DIR = path.join(TMP_DIR, 'intents')
const INBOX_DIR = path.join(INTENTS_DIR, '_inbox')
const GOVERNANCE_FILE = path.join(TMP_DIR, 'proposal-governance.json')
const AUDIT_FILE = path.join(TMP_DIR, 'governance-audit.jsonl')

const savedIntentsDirEnv = process.env.HERMES_INTENTS_DIR
const savedGovernanceFileEnv = process.env.HERMES_PROPOSAL_GOVERNANCE_FILE
const savedAuditFileEnv = process.env.HERMES_GOVERNANCE_AUDIT_FILE
process.env.HERMES_INTENTS_DIR = INTENTS_DIR
process.env.HERMES_PROPOSAL_GOVERNANCE_FILE = GOVERNANCE_FILE
process.env.HERMES_GOVERNANCE_AUDIT_FILE = AUDIT_FILE

function restoreEnv() {
  if (savedIntentsDirEnv === undefined) delete process.env.HERMES_INTENTS_DIR
  else process.env.HERMES_INTENTS_DIR = savedIntentsDirEnv
  if (savedGovernanceFileEnv === undefined) delete process.env.HERMES_PROPOSAL_GOVERNANCE_FILE
  else process.env.HERMES_PROPOSAL_GOVERNANCE_FILE = savedGovernanceFileEnv
  if (savedAuditFileEnv === undefined) delete process.env.HERMES_GOVERNANCE_AUDIT_FILE
  else process.env.HERMES_GOVERNANCE_AUDIT_FILE = savedAuditFileEnv
}
process.on('exit', restoreEnv)

// env 必须先于被测模块生效（模块内惰性 getter 每次调用读取 env，动态 import 仅为时序保险）
const { clearIntents, listIntents, findIntentForEvaluation } = await import('../../apps/control-server/src/server/intents/registry.js')
const { loadActiveJsonIntents, ensureIntentDirs } = await import('../../apps/control-server/src/server/intents/loadJsonIntents.js')
const { enqueueHumanCorrectionProposal } = await import('../../apps/control-server/src/server/intents/proposals.js')
const governance = await import('../../apps/control-server/src/server/intents/proposalGovernance.js')
const { readGovernanceAudit } = await import('../../apps/control-server/src/server/reasoning/governanceAudit.js')
const { registerSkillProposalsRoutes } = await import('../../apps/control-server/src/server/routes/skillProposalsRoutes.js')

const FIXED_NOW = '2026-08-15T09:00:00.000Z'
const fixedNowFn = () => FIXED_NOW
const HUMAN = 'human:operator-chen'

function resetAll() {
  clearIntents()
  fs.rmSync(INTENTS_DIR, { recursive: true, force: true })
  for (const file of [GOVERNANCE_FILE, AUDIT_FILE]) {
    try { fs.rmSync(file) } catch { /* 不存在则忽略 */ }
  }
  ensureIntentDirs()
}

function auditRecords() {
  return readGovernanceAudit(500).records
}

function makeProposal(id, overrides = {}) {
  return {
    id,
    version: 1,
    source: 'proposal',
    priority: 70,
    description: '测试提案：狼来了类问题评估',
    match: { anyRegex: ['狼来了'] },
    evaluation: {
      minScore: 60,
      scoreBase: 45,
      perRequiredHit: 15,
      mustInclude: ['证据'],
      optional: [],
      forbidden: [],
      evidenceRegex: [],
      correctionPrompt: '请基于证据修正答案。'
    },
    provenance: {
      sampleUserPrompt: '讲一个狼来了的故事并评估答案',
      generatedAt: FIXED_NOW
    },
    ...overrides
  }
}

function writeInboxProposal(def) {
  ensureIntentDirs()
  const filePath = path.join(INBOX_DIR, `${def.id}.json`)
  fs.writeFileSync(filePath, JSON.stringify(def, null, 2), 'utf8')
  return filePath
}

function readGovernanceRecord(id) {
  return governance.getProposalGovernanceRecord(id)
}

function activeFilePath(id) {
  return path.join(INTENTS_DIR, `${id}.json`)
}

/** 走完整治理流程激活一个提案（测试 → 审核 → 激活），返回各步结果 */
function fullyActivate(def, { actor = HUMAN } = {}) {
  writeInboxProposal(def)
  const tested = governance.runProposalTests(def.id, { actor, nowFn: fixedNowFn })
  assert.equal(tested.passed, true, `测试门禁应通过: ${JSON.stringify(tested.checks)}`)
  const reviewed = governance.reviewProposal(def.id, { actor, decision: 'approve', note: '样例命中，评估可达', nowFn: fixedNowFn })
  assert.equal(reviewed.ok, true, reviewed.detail)
  const activated = governance.activateProposal(def.id, { actor, nowFn: fixedNowFn })
  assert.equal(activated.ok, true, activated.detail)
  return { tested, reviewed, activated }
}

test('S4-06：_inbox proposal 默认不可执行——启动加载不注册、自动投递只写 inbox', () => {
  resetAll()
  writeInboxProposal(makeProposal('proposal_inbox_idle'))
  // 启动加载只读 active 目录，_inbox 绝不注册
  const result = loadActiveJsonIntents()
  assert.equal(result.loaded, 0)
  assert.equal(listIntents().length, 0)
  assert.equal(fs.existsSync(activeFilePath('proposal_inbox_idle')), false)

  // 人工纠偏自动投递：只写 _inbox，不进 active 目录、不注册
  const enqueue = enqueueHumanCorrectionProposal({
    userPrompt: '讲一个狼来了的故事',
    correctionPrompt: '回答必须引用证据',
    decision: 'correct',
    sessionId: 'sess_test'
  })
  assert.equal(enqueue.written.length, 1)
  assert.ok(enqueue.written[0].startsWith(INBOX_DIR), '提案只能落在 _inbox')
  assert.equal(listIntents().length, 0, '投递后 registry 仍为空，不存在自动晋级')
  assert.equal(fs.readdirSync(INTENTS_DIR).filter((name) => name.endsWith('.json')).length, 0, 'active 目录无文件')
})

test('S4-06：自动晋级拒绝——model/cron/缺失 actor 调用审核/激活/回滚一律拒绝并审计 blocked', () => {
  resetAll()
  writeInboxProposal(makeProposal('proposal_auto_block'))
  governance.runProposalTests('proposal_auto_block', { actor: HUMAN, nowFn: fixedNowFn })

  for (const actor of ['model:quality-gate', 'cron:job_daily', 'agent:hermes-manager', '', undefined]) {
    const reviewed = governance.reviewProposal('proposal_auto_block', { actor, decision: 'approve', nowFn: fixedNowFn })
    assert.equal(reviewed.ok, false)
    assert.equal(reviewed.error, 'actor_not_human')
    const activated = governance.activateProposal('proposal_auto_block', { actor, nowFn: fixedNowFn })
    assert.equal(activated.ok, false)
    assert.equal(activated.error, 'actor_not_human')
    const rolledBack = governance.rollbackActiveIntent('proposal_auto_block', { actor, nowFn: fixedNowFn })
    assert.equal(rolledBack.ok, false)
    assert.equal(rolledBack.error, 'actor_not_human')
  }

  // 状态未被自动路径推动：仍为 tested，inbox 文件仍在，active 目录仍为空
  assert.equal(readGovernanceRecord('proposal_auto_block').status, 'tested')
  assert.ok(fs.existsSync(path.join(INBOX_DIR, 'proposal_auto_block.json')))
  assert.equal(fs.existsSync(activeFilePath('proposal_auto_block')), false)
  // 审计：15 次拒绝全部 blocked 且带 actor 证据
  const blocked = auditRecords().filter((entry) => entry.result === 'blocked' && entry.detail?.includes('actor_not_human'))
  assert.equal(blocked.length, 15)
  assert.ok(blocked.every((entry) => ['proposal_review', 'proposal_activate', 'proposal_rollback'].includes(entry.action)))
})

test('S4-06：未测试激活拒绝——无治理记录与 candidate 状态均不可激活', () => {
  resetAll()
  writeInboxProposal(makeProposal('proposal_no_test'))
  // 无治理记录（未走测试门禁）
  const direct = governance.activateProposal('proposal_no_test', { actor: HUMAN, nowFn: fixedNowFn })
  assert.equal(direct.ok, false)
  assert.equal(direct.error, 'proposal_not_found')
  // 测试失败保持 candidate，同样不可激活
  const unreachable = makeProposal('proposal_unreachable', {
    evaluation: { minScore: 95, scoreBase: 45, perRequiredHit: 15, mustInclude: ['证据'] }
  })
  writeInboxProposal(unreachable)
  const gate = governance.runProposalTests('proposal_unreachable', { actor: HUMAN, nowFn: fixedNowFn })
  assert.equal(gate.passed, false)
  assert.match(gate.checks.find((check) => check.name === 'evaluation_reachable').detail, /低于 minScore/)
  assert.equal(readGovernanceRecord('proposal_unreachable').status, 'candidate')
  const activateCandidate = governance.activateProposal('proposal_unreachable', { actor: HUMAN, nowFn: fixedNowFn })
  assert.equal(activateCandidate.ok, false)
  assert.equal(activateCandidate.error, 'proposal_not_approved')
  // 未审核（tested 但无 approve）同样拒绝
  writeInboxProposal(makeProposal('proposal_no_review'))
  const tested = governance.runProposalTests('proposal_no_review', { actor: HUMAN, nowFn: fixedNowFn })
  assert.equal(tested.passed, true)
  const activateTested = governance.activateProposal('proposal_no_review', { actor: HUMAN, nowFn: fixedNowFn })
  assert.equal(activateTested.ok, false)
  assert.equal(activateTested.error, 'proposal_not_approved')
  const blockedAudit = auditRecords().filter((entry) => entry.action === 'proposal_activate' && entry.result === 'blocked')
  assert.equal(blockedAudit.length, 2)
})

test('S4-06：测试门禁——编译失败/无样例/样例不命中均不通过且证据留痕', () => {
  resetAll()
  // 编译失败（match 为空）
  writeInboxProposal(makeProposal('proposal_bad_compile', { match: {} }))
  const badCompile = governance.runProposalTests('proposal_bad_compile', { actor: HUMAN, nowFn: fixedNowFn })
  assert.equal(badCompile.passed, false)
  assert.equal(badCompile.checks.find((check) => check.name === 'compile').passed, false)
  // 无真实样例 prompt（证据不足）
  writeInboxProposal(makeProposal('proposal_no_sample', { provenance: { generatedAt: FIXED_NOW } }))
  const noSample = governance.runProposalTests('proposal_no_sample', { actor: HUMAN, nowFn: fixedNowFn })
  assert.equal(noSample.passed, false)
  assert.match(noSample.checks.find((check) => check.name === 'sample_match').detail, /no_sample_prompt/)
  // 样例不命中 match 规则
  writeInboxProposal(makeProposal('proposal_miss_sample', { provenance: { sampleUserPrompt: '完全无关的问题', generatedAt: FIXED_NOW } }))
  const missSample = governance.runProposalTests('proposal_miss_sample', { actor: HUMAN, nowFn: fixedNowFn })
  assert.equal(missSample.passed, false)
  assert.match(missSample.checks.find((check) => check.name === 'sample_match').detail, /未命中/)
  // 失败证据全部落治理记录与审计，状态保持 candidate
  for (const id of ['proposal_bad_compile', 'proposal_no_sample', 'proposal_miss_sample']) {
    const record = readGovernanceRecord(id)
    assert.equal(record.status, 'candidate')
    assert.equal(record.tests.length, 1)
    assert.equal(record.tests[0].passed, false)
    assert.equal(record.tests[0].actor, HUMAN)
    assert.equal(record.tests[0].ts, FIXED_NOW)
  }
  const testAudits = auditRecords().filter((entry) => entry.action === 'proposal_test')
  assert.equal(testAudits.length, 3)
  assert.ok(testAudits.every((entry) => entry.result === 'blocked' && entry.actor === HUMAN))
})

test('S4-06：人工审核——未测试禁止 approve；tested 经 approve 进入 approved', () => {
  resetAll()
  writeInboxProposal(makeProposal('proposal_review_flow'))
  // candidate 直接审核通过 → 拒绝
  const earlyApprove = governance.reviewProposal('proposal_review_flow', { actor: HUMAN, decision: 'approve', nowFn: fixedNowFn })
  assert.equal(earlyApprove.ok, false)
  assert.equal(earlyApprove.error, 'proposal_not_tested')
  // 通过测试门禁后 approve 成功
  governance.runProposalTests('proposal_review_flow', { actor: HUMAN, nowFn: fixedNowFn })
  const approved = governance.reviewProposal('proposal_review_flow', { actor: HUMAN, decision: 'approve', note: '人工确认样例与评估配置', nowFn: fixedNowFn })
  assert.equal(approved.ok, true)
  assert.equal(approved.status, 'approved')
  const record = readGovernanceRecord('proposal_review_flow')
  assert.equal(record.reviews.length, 1)
  assert.equal(record.reviews[0].actor, HUMAN)
  assert.equal(record.reviews[0].decision, 'approve')
  assert.equal(record.reviews[0].note, '人工确认样例与评估配置')
  const audit = auditRecords().find((entry) => entry.action === 'proposal_review' && entry.result === 'ok')
  assert.ok(audit)
  assert.equal(audit.actor, HUMAN)
  assert.equal(audit.decision, 'approve')
})

test('S4-06：审核后激活成功——写 active 文件、注册 registry、版本记录含快照/actor/证据', () => {
  resetAll()
  const def = makeProposal('proposal_activate_ok')
  fullyActivate(def)
  // active 文件写入、inbox 移除、registry 可消费（evaluator 生效）
  assert.ok(fs.existsSync(activeFilePath(def.id)))
  assert.equal(fs.existsSync(path.join(INBOX_DIR, `${def.id}.json`)), false)
  const intent = findIntentForEvaluation('讲一个狼来了的故事并评估答案', {})
  assert.ok(intent, '激活后 intent 应被评估路由命中')
  assert.equal(intent.id, def.id)
  // 版本记录：v1 快照与原提案一致，actor/时间/证据齐全
  const record = readGovernanceRecord(def.id)
  assert.equal(record.status, 'active')
  assert.equal(record.currentVersion, 1)
  assert.equal(record.versions.length, 1)
  const v1 = record.versions[0]
  assert.deepEqual(v1.snapshot, def)
  assert.equal(v1.actor, HUMAN)
  assert.equal(v1.activatedAt, FIXED_NOW)
  assert.ok(v1.snapshotHash)
  assert.equal(v1.evidence.testRef, FIXED_NOW)
  assert.equal(v1.evidence.reviewRef, FIXED_NOW)
  assert.ok(v1.evidence.activatedPath.endsWith(`${def.id}.json`))
  const audit = auditRecords().find((entry) => entry.action === 'proposal_activate' && entry.result === 'ok')
  assert.ok(audit)
  assert.match(audit.detail, /version=1/)
})

test('S4-06：激活失败自动回滚——写入故障时恢复上一已知版本并留证', () => {
  resetAll()
  // v1 正常激活
  const defV1 = makeProposal('proposal_activate_fail')
  fullyActivate(defV1)
  assert.ok(findIntentForEvaluation('讲一个狼来了的故事并评估答案', {}))

  // 构造 v2 待激活：同名提案回 inbox，治理记录置回 approved（模拟新一轮测试+审核已通过）
  const defV2 = makeProposal('proposal_activate_fail', { priority: 88, description: 'v2 更新' })
  writeInboxProposal(defV2)
  const raw = JSON.parse(fs.readFileSync(GOVERNANCE_FILE, 'utf8'))
  raw.proposals['proposal_activate_fail'].status = 'approved'
  fs.writeFileSync(GOVERNANCE_FILE, JSON.stringify(raw, null, 2), 'utf8')

  // 注入写入故障：active 目录只读 + v1 active 文件只读 → 写 active 文件失败，
  // 且自动回滚的 unlink 同样失败（验证故障下现场保持激活前状态）
  fs.chmodSync(INTENTS_DIR, 0o555)
  fs.chmodSync(activeFilePath('proposal_activate_fail'), 0o444)
  let activated
  try {
    activated = governance.activateProposal('proposal_activate_fail', { actor: HUMAN, nowFn: fixedNowFn })
  } finally {
    fs.chmodSync(INTENTS_DIR, 0o755)
    fs.chmodSync(activeFilePath('proposal_activate_fail'), 0o644)
  }
  assert.equal(activated.ok, false)
  assert.equal(activated.error, 'proposal_activation_failed')
  assert.match(activated.detail, /自动回滚/)

  // v1 原状保持：active 文件仍是 v1 内容，registry 仍命中 v1
  const activeDef = JSON.parse(fs.readFileSync(activeFilePath('proposal_activate_fail'), 'utf8'))
  assert.equal(activeDef.description, '测试提案：狼来了类问题评估')
  assert.equal(findIntentForEvaluation('讲一个狼来了的故事并评估答案', {}).id, 'proposal_activate_fail')
  // 版本记录未产生 v2；rollbacks 留下 activation_failed 证据；审计 blocked
  const record = readGovernanceRecord('proposal_activate_fail')
  assert.equal(record.versions.length, 1)
  assert.equal(record.currentVersion, 1)
  assert.equal(record.rollbacks.at(-1).reason, 'activation_failed')
  const audit = auditRecords().find((entry) => entry.action === 'proposal_activate' && entry.result === 'blocked' && entry.detail?.includes('自动回滚'))
  assert.ok(audit)
  assert.equal(audit.actor, HUMAN)
})

test('S4-06：人工回滚到上一已知版本，再次回滚完全下线；版本记录全程保留可追溯', () => {
  resetAll()
  // v1 激活
  const defV1 = makeProposal('proposal_rollback')
  fullyActivate(defV1)
  // v2：同 id 新一轮（重新投递 + 测试 + 审核 + 激活）
  const defV2 = makeProposal('proposal_rollback', { priority: 88, description: 'v2 收紧评估', evaluation: { minScore: 60, scoreBase: 50, perRequiredHit: 10, mustInclude: ['证据'], correctionPrompt: 'v2 修正' } })
  writeInboxProposal(defV2)
  assert.equal(governance.runProposalTests('proposal_rollback', { actor: HUMAN, nowFn: fixedNowFn }).passed, true)
  assert.equal(governance.reviewProposal('proposal_rollback', { actor: HUMAN, decision: 'approve', nowFn: fixedNowFn }).ok, true)
  const activatedV2 = governance.activateProposal('proposal_rollback', { actor: HUMAN, nowFn: fixedNowFn })
  assert.equal(activatedV2.ok, true)
  assert.equal(activatedV2.version, 2)
  assert.equal(JSON.parse(fs.readFileSync(activeFilePath('proposal_rollback'), 'utf8')).description, 'v2 收紧评估')

  // 回滚 v2 → v1：文件与 registry 恢复 v1 快照
  const rolledBack = governance.rollbackActiveIntent('proposal_rollback', { actor: HUMAN, reason: 'v2 评审误放', nowFn: fixedNowFn })
  assert.equal(rolledBack.ok, true)
  assert.equal(rolledBack.fromVersion, 2)
  assert.equal(rolledBack.restoredVersion, 1)
  assert.equal(JSON.parse(fs.readFileSync(activeFilePath('proposal_rollback'), 'utf8')).description, '测试提案：狼来了类问题评估')
  const restoredIntent = findIntentForEvaluation('讲一个狼来了的故事并评估答案', {})
  assert.equal(restoredIntent.id, 'proposal_rollback')
  assert.equal(restoredIntent.rawDef.description, '测试提案：狼来了类问题评估')

  // 再回滚 → 无上一版本，完全下线
  const rolledOff = governance.rollbackActiveIntent('proposal_rollback', { actor: HUMAN, reason: '整体下线', nowFn: fixedNowFn })
  assert.equal(rolledOff.ok, true)
  assert.equal(rolledOff.restoredVersion, null)
  assert.equal(fs.existsSync(activeFilePath('proposal_rollback')), false)
  assert.equal(findIntentForEvaluation('讲一个狼来了的故事并评估答案', {}), null)

  // 版本记录 2 条全部保留（旧规则可追溯），rollbacks 两条，状态 rolled_back
  const record = readGovernanceRecord('proposal_rollback')
  assert.equal(record.status, 'rolled_back')
  assert.equal(record.currentVersion, 0)
  assert.equal(record.versions.length, 2)
  assert.deepEqual(record.versions[0].snapshot, defV1)
  assert.deepEqual(record.versions[1].snapshot, defV2)
  assert.equal(record.rollbacks.length, 2)
  assert.equal(record.rollbacks[0].reason, 'v2 评审误放')
  assert.equal(record.rollbacks[0].fromVersion, 2)
  assert.equal(record.rollbacks[0].toVersion, 1)
  assert.equal(record.rollbacks[1].toVersion, null)
  const rollbackAudits = auditRecords().filter((entry) => entry.action === 'proposal_rollback' && entry.result === 'ok')
  assert.equal(rollbackAudits.length, 2)
  assert.ok(rollbackAudits.every((entry) => entry.actor === HUMAN))
})

test('S4-06：驳回保留快照与历史，不删除治理记录；active 不可驳回', () => {
  resetAll()
  const def = makeProposal('proposal_reject')
  writeInboxProposal(def)
  governance.runProposalTests('proposal_reject', { actor: HUMAN, nowFn: fixedNowFn })
  const rejected = governance.reviewProposal('proposal_reject', { actor: HUMAN, decision: 'reject', note: '规则过宽', nowFn: fixedNowFn })
  assert.equal(rejected.ok, true)
  assert.equal(rejected.status, 'rejected')
  // inbox 文件移除，但快照与测试/审核历史全部保留
  assert.equal(fs.existsSync(path.join(INBOX_DIR, 'proposal_reject.json')), false)
  const record = readGovernanceRecord('proposal_reject')
  assert.equal(record.status, 'rejected')
  assert.deepEqual(record.rejectedSnapshot, def)
  assert.equal(record.tests.length, 1)
  assert.equal(record.reviews.at(-1).decision, 'reject')
  // active 状态不可驳回
  const defActive = makeProposal('proposal_reject_active')
  fullyActivate(defActive)
  const rejectActive = governance.reviewProposal('proposal_reject_active', { actor: HUMAN, decision: 'reject', nowFn: fixedNowFn })
  assert.equal(rejectActive.ok, false)
  assert.equal(rejectActive.error, 'illegal_status_transition')
})

test('S4-06：受控下线保留版本记录；非人类 actor 下线被拒绝', () => {
  resetAll()
  const def = makeProposal('proposal_deactivate')
  fullyActivate(def)
  const denied = governance.deactivateGovernedIntent('proposal_deactivate', { actor: 'model:auto-cleaner', nowFn: fixedNowFn })
  assert.equal(denied.ok, false)
  assert.equal(denied.error, 'actor_not_human')
  assert.ok(fs.existsSync(activeFilePath('proposal_deactivate')))
  const deactivated = governance.deactivateGovernedIntent('proposal_deactivate', { actor: HUMAN, reason: '规则废弃', nowFn: fixedNowFn })
  assert.equal(deactivated.ok, true)
  assert.equal(fs.existsSync(activeFilePath('proposal_deactivate')), false)
  assert.equal(findIntentForEvaluation('讲一个狼来了的故事并评估答案', {}), null)
  const record = readGovernanceRecord('proposal_deactivate')
  assert.equal(record.status, 'rolled_back')
  assert.equal(record.versions.length, 1, '版本记录保留下线后可追溯')
  assert.equal(record.rollbacks.at(-1).reason, '规则废弃')
})

// --- HTTP 路由全链路 ---

function makeApp() {
  const app = new Hono()
  registerSkillProposalsRoutes(app)
  return app
}

function postJson(app, url, body) {
  return app.request(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {})
  })
}

test('S4-06 路由：测试 → 审核 → 激活 → 回滚全链路受控，治理视图可查', async () => {
  resetAll()
  const app = makeApp()
  writeInboxProposal(makeProposal('proposal_route_flow'))

  // 缺 actor：测试可匿名（只读性检查），审核/激活一律 403
  const reviewNoActor = await postJson(app, '/api/control/skill-proposals/proposal_route_flow/review', { decision: 'approve' })
  assert.equal(reviewNoActor.status, 403)
  assert.equal((await reviewNoActor.json()).error, 'actor_not_human')
  // model actor 激活 403（自动晋级拒绝）
  const promoteModel = await postJson(app, '/api/control/skill-proposals/proposal_route_flow/promote', { actor: 'model:self-promote' })
  assert.equal(promoteModel.status, 403)
  // 未测试直接激活 404（无治理记录）
  const promoteEarly = await postJson(app, '/api/control/skill-proposals/proposal_route_flow/promote', { actor: HUMAN })
  assert.equal(promoteEarly.status, 404)
  assert.equal((await promoteEarly.json()).error, 'proposal_not_found')
  // 测试门禁
  const tested = await postJson(app, '/api/control/skill-proposals/proposal_route_flow/test', { actor: HUMAN })
  assert.equal(tested.status, 200)
  assert.equal((await tested.json()).passed, true)
  // 审核 → 激活
  const reviewed = await postJson(app, '/api/control/skill-proposals/proposal_route_flow/review', { actor: HUMAN, decision: 'approve', note: 'ok' })
  assert.equal(reviewed.status, 200)
  const promoted = await postJson(app, '/api/control/skill-proposals/proposal_route_flow/promote', { actor: HUMAN })
  assert.equal(promoted.status, 200)
  assert.equal((await promoted.json()).version, 1)
  // 治理视图：列表含状态，单条含版本快照
  const list = await (await app.request('/api/control/skill-proposals')).json()
  const govEntry = list.governance.find((entry) => entry.id === 'proposal_route_flow')
  assert.equal(govEntry.status, 'active')
  assert.equal(govEntry.currentVersion, 1)
  const detail = await (await app.request('/api/control/skill-proposals/proposal_route_flow/governance')).json()
  assert.equal(detail.ok, true)
  assert.equal(detail.record.versions.length, 1)
  assert.equal(detail.record.versions[0].actor, HUMAN)
  // 回滚到完全下线
  const rolledBack = await postJson(app, '/api/control/skill-intents/proposal_route_flow/rollback', { actor: HUMAN, reason: '观察后回退' })
  assert.equal(rolledBack.status, 200)
  assert.equal((await rolledBack.json()).restoredVersion, null)
  // 已下线后重复回滚 409
  const reRollback = await postJson(app, '/api/control/skill-intents/proposal_route_flow/rollback', { actor: HUMAN })
  assert.equal(reRollback.status, 409)
})
