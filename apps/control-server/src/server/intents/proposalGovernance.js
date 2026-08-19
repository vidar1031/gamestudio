/**
 * AUTO-F02：proposal 测试、审核、晋级与回滚治理。
 *
 * 生命周期状态机（持久化在 state/proposal-governance.json，
 * HERMES_PROPOSAL_GOVERNANCE_FILE 可覆盖，测试用）：
 *
 *   candidate（_inbox 候选，默认不可执行）
 *     → tested（通过确定性测试门禁）
 *     → approved（人工审核通过）
 *     → active（人工激活，写入 active intents 目录并注册）
 *   tested/approved --人工驳回--> rejected（保留快照与历史，不删审计）
 *   active --人工回滚/激活失败自动回滚--> 恢复上一已知版本或 rolled_back
 *
 * 硬规则（与仓库 AGENTS.md 安全边界一致）：
 * - _inbox proposal 只是候选数据，永远不会被 loadActiveJsonIntents 加载，
 *   也不存在任何自动晋级代码路径；激活只能经本模块的受控函数；
 * - 测试门禁、人工审核、人工激活顺序不可绕过（缺任一环节一律拒绝 + 审计）；
 * - actor 必填且必须是人类操作者；model/cron/agent 等自动路径身份调用
 *   审核/激活/回滚一律拒绝并写治理审计（自动晋级拒绝的证据）；
 * - 每次激活产生不可删除的版本记录（proposal 快照、版本号、actor、时间、
 *   证据指针）；回滚恢复上一版本快照，旧版本全程可追溯；
 * - 审计复用 H01 governanceAudit（action: proposal_test / proposal_review /
 *   proposal_activate / proposal_rollback / proposal_deactivate）。
 */

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { GAMESTUDIO_ROOT } from '../../config/paths.js'
import { appendGovernanceAudit } from '../reasoning/governanceAudit.js'
import { compileJsonIntent } from './jsonIntent.js'
import { registerIntent, unregisterIntent } from './registry.js'
import { getIntentsDir, getIntentsInboxDir, ensureIntentDirs } from './loadJsonIntents.js'

export const PROPOSAL_STATUS = Object.freeze({
  CANDIDATE: 'candidate',
  TESTED: 'tested',
  APPROVED: 'approved',
  ACTIVE: 'active',
  REJECTED: 'rejected',
  ROLLED_BACK: 'rolled_back'
})

// 自动路径身份前缀：这些 actor 一律视为非人类操作者（模型/cron/agent/系统自动调用）
const NON_HUMAN_ACTOR_PATTERN = /^(model|cron|agent|auto|hermes|system|bot)([:._\-]|$)/i

const TESTS_LIMIT = 20
const REVIEWS_LIMIT = 20
const ROLLBACKS_LIMIT = 50

export function getProposalGovernanceFile() {
  const override = process.env.HERMES_PROPOSAL_GOVERNANCE_FILE
  if (override && String(override).trim()) return String(override)
  return path.join(GAMESTUDIO_ROOT, 'state', 'proposal-governance.json')
}

function emptyGovernanceFile() {
  return { version: 1, proposals: {} }
}

function readGovernanceFile() {
  const file = getProposalGovernanceFile()
  try {
    if (!fs.existsSync(file)) return emptyGovernanceFile()
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (!raw || typeof raw.proposals !== 'object' || raw.proposals === null) {
      throw new Error('invalid_proposal_governance_file')
    }
    return raw
  } catch {
    // 损坏文件隔离留证后按空处理，不猜测内容（与 cron jobs 同一语义）
    try {
      fs.renameSync(file, `${file}.corrupt-${Date.now()}`)
    } catch {
      // 隔离失败不阻断读取
    }
    return emptyGovernanceFile()
  }
}

function writeGovernanceFile(data) {
  const file = getProposalGovernanceFile()
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf8')
  fs.renameSync(tmp, file)
}

function normalizeRecord(record, id) {
  return {
    id,
    status: String(record?.status || PROPOSAL_STATUS.CANDIDATE),
    currentVersion: Number(record?.currentVersion || 0),
    createdAt: record?.createdAt || null,
    updatedAt: record?.updatedAt || null,
    tests: Array.isArray(record?.tests) ? record.tests : [],
    reviews: Array.isArray(record?.reviews) ? record.reviews : [],
    versions: Array.isArray(record?.versions) ? record.versions : [],
    rollbacks: Array.isArray(record?.rollbacks) ? record.rollbacks : [],
    rejectedSnapshot: record?.rejectedSnapshot || null
  }
}

function getOrCreateRecord(data, id, nowFn) {
  if (!data.proposals[id]) {
    data.proposals[id] = normalizeRecord({ createdAt: nowFn() }, id)
  }
  return normalizeRecord(data.proposals[id], id)
}

function saveRecord(data, record, nowFn) {
  record.updatedAt = nowFn()
  record.tests = record.tests.slice(-TESTS_LIMIT)
  record.reviews = record.reviews.slice(-REVIEWS_LIMIT)
  record.rollbacks = record.rollbacks.slice(-ROLLBACKS_LIMIT)
  data.proposals[record.id] = record
  writeGovernanceFile(data)
}

/**
 * 判定 actor 是否为人类操作者。空 actor 与 model/cron/agent 等自动路径身份
 * 一律判定非人类（安全默认），调用方据此处返回拒绝并审计。
 */
export function isHumanActor(actor) {
  const text = String(actor || '').trim()
  if (!text) return false
  return !NON_HUMAN_ACTOR_PATTERN.test(text)
}

function blockedActorResult(action, id, actor) {
  appendGovernanceAudit({
    action,
    result: 'blocked',
    actor: actor || null,
    detail: `actor_not_human:${String(actor || '').trim() || 'missing'} proposal=${id}`
  })
  return { ok: false, error: 'actor_not_human', detail: '审核/激活/回滚必须由人类操作者执行，自动路径身份一律拒绝' }
}

function safeProposalId(rawId) {
  const cleaned = String(rawId || '').replace(/[^A-Za-z0-9_.\-]/g, '_')
  return cleaned.slice(0, 80)
}

function resolveInboxProposal(id) {
  const safeId = safeProposalId(id)
  if (!safeId) return { safeId: null, sourcePath: null }
  const inboxDir = getIntentsInboxDir()
  const sourcePath = path.join(inboxDir, `${safeId}.json`)
  if (!sourcePath.startsWith(inboxDir + path.sep)) {
    return { safeId: null, sourcePath: null }
  }
  return { safeId, sourcePath }
}

function readInboxProposalDef(id) {
  const { safeId, sourcePath } = resolveInboxProposal(id)
  if (!safeId || !fs.existsSync(sourcePath)) return null
  const raw = fs.readFileSync(sourcePath, 'utf8')
  return { safeId, sourcePath, raw, def: JSON.parse(raw) }
}

function snapshotHash(raw) {
  return crypto.createHash('sha1').update(String(raw || '')).digest('hex').slice(0, 10)
}

// 与 jsonIntent matchPrompt 同一语义的本地匹配（用于无 evaluation 配置的提案样例验证）
function matchDefRegexes(def, text) {
  const source = String(text || '')
  if (!source) return false
  const anyList = Array.isArray(def?.match?.anyRegex) ? def.match.anyRegex : []
  const allList = Array.isArray(def?.match?.allRegex) ? def.match.allRegex : []
  const noneList = Array.isArray(def?.match?.noneRegex) ? def.match.noneRegex : []
  if (anyList.length > 0 && !anyList.some((item) => new RegExp(item, 'i').test(source))) return false
  if (!allList.every((item) => new RegExp(item, 'i').test(source))) return false
  if (!noneList.every((item) => !new RegExp(item, 'i').test(source))) return false
  return true
}

function collectSamplePrompts(def) {
  const samples = []
  const single = String(def?.provenance?.sampleUserPrompt || '').trim()
  if (single) samples.push(single)
  const list = Array.isArray(def?.provenance?.sampleUserPrompts) ? def.provenance.sampleUserPrompts : []
  for (const item of list) {
    const text = String(item || '').trim()
    if (text) samples.push(text)
  }
  return samples.slice(0, 5)
}

/**
 * 确定性测试门禁（最小可行集，按仓库现状的 JSON intent 提案类型）：
 * 1. compile：提案可被 compileJsonIntent 编译（正则合法、match 非空）；
 * 2. sample_match：provenance 中的真实样例 prompt 必须被 match 规则命中
 *    （intent 分类准确率样例；无样例视为证据不足，门禁不通过）；
 * 3. evaluation_reachable：评估配置的理论最高得分必须可达 minScore，
 *    否则该 intent 永远不可能通过评估，属于不可激活的死规则。
 */
export function evaluateProposalTestGate(def) {
  const checks = []

  let compiled = null
  try {
    compiled = compileJsonIntent(def)
    checks.push({ name: 'compile', passed: true, detail: 'proposal 编译通过' })
  } catch (error) {
    checks.push({ name: 'compile', passed: false, detail: error instanceof Error ? error.message : String(error) })
  }

  const samples = collectSamplePrompts(def)
  if (samples.length === 0) {
    checks.push({ name: 'sample_match', passed: false, detail: 'no_sample_prompt: provenance 缺少真实样例 prompt，无法验证分类命中率' })
  } else {
    const missed = samples.filter((sample) => !matchDefRegexes(def, sample))
    checks.push(missed.length === 0
      ? { name: 'sample_match', passed: true, detail: `${samples.length} 条样例 prompt 全部命中 match 规则` }
      : { name: 'sample_match', passed: false, detail: `${missed.length}/${samples.length} 条样例未命中 match 规则` })
  }

  if (def?.evaluation) {
    const ev = def.evaluation
    const scoreBase = Number.isFinite(Number(ev.scoreBase)) ? Number(ev.scoreBase) : 45
    const perRequired = Number.isFinite(Number(ev.perRequiredHit)) ? Number(ev.perRequiredHit) : 15
    const perOptional = Number.isFinite(Number(ev.perOptionalHit)) ? Number(ev.perOptionalHit) : 8
    const perEvidence = Number.isFinite(Number(ev.perEvidenceHit)) ? Number(ev.perEvidenceHit) : 10
    const mustCount = Array.isArray(ev.mustInclude) ? ev.mustInclude.length : 0
    const optionalCount = Array.isArray(ev.optional) ? ev.optional.length : 0
    const evidenceCount = Array.isArray(ev.evidenceRegex) ? ev.evidenceRegex.length : 0
    const maxScore = Math.max(0, Math.min(100,
      scoreBase + perRequired * mustCount + perOptional * optionalCount + perEvidence * evidenceCount))
    const minScore = Number.isFinite(Number(ev.minScore)) ? Number(ev.minScore) : 70
    checks.push(maxScore >= minScore
      ? { name: 'evaluation_reachable', passed: true, detail: `理论最高 ${maxScore} 分可达 minScore=${minScore}` }
      : { name: 'evaluation_reachable', passed: false, detail: `理论最高 ${maxScore} 分低于 minScore=${minScore}，该规则永远不可能通过评估` })
  }

  return { compiled, checks, passed: checks.every((check) => check.passed) }
}

/**
 * 测试门禁：对 _inbox 候选提案执行确定性测试，证据落治理记录。
 * 通过后状态 candidate → tested；失败保持 candidate，证据同样留痕。
 */
export function runProposalTests(id, { actor = 'human:console', nowFn = () => new Date().toISOString() } = {}) {
  ensureIntentDirs()
  let loaded = null
  try {
    loaded = readInboxProposalDef(id)
  } catch (error) {
    return { ok: false, error: 'proposal_parse_failed', detail: error instanceof Error ? error.message : String(error) }
  }
  if (!loaded) return { ok: false, error: 'proposal_not_found' }

  const gate = evaluateProposalTestGate(loaded.def)
  const data = readGovernanceFile()
  const record = getOrCreateRecord(data, loaded.safeId, nowFn)
  record.tests.push({ ts: nowFn(), actor: String(actor || ''), passed: gate.passed, checks: gate.checks })
  // candidate 首轮晋级；active 表示同 id 新版本的再晋级（currentVersion 不动，
  // active 文件与注册在新版本激活前保持在线，status 只跟踪候选的治理流程）
  if (gate.passed && [PROPOSAL_STATUS.CANDIDATE, PROPOSAL_STATUS.ACTIVE].includes(record.status)) {
    record.status = PROPOSAL_STATUS.TESTED
  }
  saveRecord(data, record, nowFn)
  appendGovernanceAudit({
    action: 'proposal_test',
    result: gate.passed ? 'ok' : 'blocked',
    actor: String(actor || ''),
    detail: `proposal=${loaded.safeId} passed=${gate.passed}`
  })
  return { ok: true, id: loaded.safeId, passed: gate.passed, checks: gate.checks, status: record.status }
}

/**
 * 人工审核：approve 要求已通过测试门禁（tested）；reject 可在激活前任意状态执行。
 * 非人类 actor 一律拒绝并审计（自动晋级防护的一环）。
 */
export function reviewProposal(id, { actor, decision, note = '', nowFn = () => new Date().toISOString() } = {}) {
  if (!isHumanActor(actor)) return blockedActorResult('proposal_review', id, actor)
  const normalizedDecision = String(decision || '').trim().toLowerCase()
  if (normalizedDecision !== 'approve' && normalizedDecision !== 'reject') {
    return { ok: false, error: 'decision_invalid', detail: 'decision 仅支持 approve / reject' }
  }
  ensureIntentDirs()
  const data = readGovernanceFile()
  const { safeId } = resolveInboxProposal(id)
  let record = data.proposals[safeId] ? normalizeRecord(data.proposals[safeId], safeId) : null
  if (!record) {
    // 无治理记录：inbox 文件存在则按 candidate 建档（approve 会因未测试被拦截）；
    // 文件也不存在才是真的 not_found
    if (!fs.existsSync(path.join(getIntentsInboxDir(), `${safeId}.json`))) {
      return { ok: false, error: 'proposal_not_found', detail: '无治理记录且 _inbox 中不存在该提案' }
    }
    record = getOrCreateRecord(data, safeId, nowFn)
  }

  if (normalizedDecision === 'approve') {
    if (record.status !== PROPOSAL_STATUS.TESTED) {
      appendGovernanceAudit({
        action: 'proposal_review', result: 'blocked', actor, decision: normalizedDecision,
        detail: `proposal=${safeId} status=${record.status} 未通过测试门禁，禁止审核通过`
      })
      return { ok: false, error: 'proposal_not_tested', detail: `当前状态 ${record.status}，须先通过测试门禁` }
    }
    record.status = PROPOSAL_STATUS.APPROVED
  } else {
    if (![PROPOSAL_STATUS.CANDIDATE, PROPOSAL_STATUS.TESTED, PROPOSAL_STATUS.APPROVED].includes(record.status)) {
      return { ok: false, error: 'illegal_status_transition', detail: `当前状态 ${record.status} 不可驳回` }
    }
    // 驳回保留提案快照与全部历史（不删除历史规则），仅从 _inbox 移除候选文件
    let loaded = null
    try {
      loaded = readInboxProposalDef(safeId)
    } catch {
      loaded = null
    }
    if (loaded) {
      record.rejectedSnapshot = loaded.def
      try {
        fs.unlinkSync(loaded.sourcePath)
      } catch {
        // 移除失败不阻断驳回记录（状态与快照已留痕）
      }
    }
    record.status = PROPOSAL_STATUS.REJECTED
  }

  record.reviews.push({ ts: nowFn(), actor: String(actor), decision: normalizedDecision, note: String(note || '').slice(0, 280) })
  saveRecord(data, record, nowFn)
  appendGovernanceAudit({
    action: 'proposal_review', result: 'ok', actor, decision: normalizedDecision,
    detail: `proposal=${safeId} status=${record.status}`
  })
  return { ok: true, id: safeId, status: record.status, decision: normalizedDecision }
}

function writeActiveIntentFile(safeId, raw) {
  const targetPath = path.join(getIntentsDir(), `${safeId}.json`)
  fs.writeFileSync(targetPath, raw, 'utf8')
  return targetPath
}

function removeActiveIntentFile(safeId) {
  const targetPath = path.join(getIntentsDir(), `${safeId}.json`)
  if (fs.existsSync(targetPath)) fs.unlinkSync(targetPath)
}

/**
 * 恢复到上一已知版本（或完全下线）：版本记录永不删除，只移动 currentVersion 指针。
 * 全程不抛异常：先写文件再动注册表，任一步失败保持原状并返回 ok:false，
 * 由调用方决定如何留证（激活失败自动回滚 / 人工回滚共用）。
 * @returns {{ ok: boolean, restoredVersion: number|null, error?: string }}
 */
function restorePreviousVersion(record) {
  const currentIndex = record.versions.findIndex((entry) => entry.version === record.currentVersion)
  const previous = currentIndex > 0 ? record.versions[currentIndex - 1] : null
  if (!previous) {
    // 无上一版本：完全下线（先移文件再注销，失败保持原状）
    try {
      removeActiveIntentFile(record.id)
    } catch (error) {
      return { ok: false, restoredVersion: null, error: error instanceof Error ? error.message : String(error) }
    }
    unregisterIntent(record.id)
    record.currentVersion = 0
    record.status = PROPOSAL_STATUS.ROLLED_BACK
    return { ok: true, restoredVersion: null }
  }
  try {
    const raw = `${JSON.stringify(previous.snapshot, null, 2)}\n`
    const intent = compileJsonIntent(previous.snapshot)
    writeActiveIntentFile(record.id, raw)
    registerIntent(intent)
  } catch (error) {
    return { ok: false, restoredVersion: null, error: error instanceof Error ? error.message : String(error) }
  }
  record.currentVersion = previous.version
  record.status = PROPOSAL_STATUS.ACTIVE
  return { ok: true, restoredVersion: previous.version }
}

/**
 * 人工激活：仅 approved 状态可激活；激活产生不可删除的版本记录
 * （快照 + 版本号 + actor + 时间 + 证据指针）。激活过程中失败自动回滚到
 * 上一已知版本（无上一版本则完全下线），治理记录与审计双双留痕。
 */
export function activateProposal(id, { actor, nowFn = () => new Date().toISOString() } = {}) {
  if (!isHumanActor(actor)) return blockedActorResult('proposal_activate', id, actor)
  ensureIntentDirs()
  const data = readGovernanceFile()
  const { safeId } = resolveInboxProposal(id)
  const record = data.proposals[safeId] ? normalizeRecord(data.proposals[safeId], safeId) : null
  if (!record) return { ok: false, error: 'proposal_not_found', detail: '无治理记录：请先执行测试门禁与人工审核' }
  if (record.status !== PROPOSAL_STATUS.APPROVED) {
    appendGovernanceAudit({
      action: 'proposal_activate', result: 'blocked', actor,
      detail: `proposal=${safeId} status=${record.status} 未经测试+人工审核，禁止激活`
    })
    return { ok: false, error: 'proposal_not_approved', detail: `当前状态 ${record.status}，激活前须通过测试门禁并获得人工审核通过` }
  }

  let loaded = null
  try {
    loaded = readInboxProposalDef(safeId)
  } catch (error) {
    return { ok: false, error: 'proposal_parse_failed', detail: error instanceof Error ? error.message : String(error) }
  }
  if (!loaded) return { ok: false, error: 'proposal_not_found', detail: '_inbox 中不存在该提案文件' }

  let intent = null
  try {
    intent = compileJsonIntent(loaded.def)
  } catch (error) {
    appendGovernanceAudit({
      action: 'proposal_activate', result: 'blocked', actor,
      detail: `proposal=${safeId} 编译失败：${error instanceof Error ? error.message : String(error)}`
    })
    return { ok: false, error: 'proposal_compile_failed', detail: error instanceof Error ? error.message : String(error) }
  }

  const lastTest = record.tests.filter((entry) => entry.passed).at(-1) || null
  const lastApprove = record.reviews.filter((entry) => entry.decision === 'approve').at(-1) || null
  const version = record.currentVersion + 1
  const versionRecord = {
    version,
    snapshot: loaded.def,
    snapshotHash: snapshotHash(loaded.raw),
    activatedAt: nowFn(),
    actor: String(actor),
    evidence: {
      testRef: lastTest ? lastTest.ts : null,
      reviewRef: lastApprove ? lastApprove.ts : null,
      activatedPath: path.join(getIntentsDir(), `${safeId}.json`)
    }
  }

  // 激活写入：任一步失败 → 自动回滚到上一已知版本（或完全下线）
  try {
    writeActiveIntentFile(safeId, loaded.raw)
    fs.unlinkSync(loaded.sourcePath)
    registerIntent(intent)
  } catch (error) {
    const rollback = restorePreviousVersion(record)
    const errorText = error instanceof Error ? error.message : String(error)
    const rollbackText = !rollback.ok
      ? `自动回滚失败（${rollback.error}），现场保持激活前状态`
      : rollback.restoredVersion !== null
        ? `已自动回滚到版本 ${rollback.restoredVersion}`
        : '已自动回滚（无上一版本，完全下线）'
    record.rollbacks.push({
      ts: nowFn(), actor: String(actor), fromVersion: version, toVersion: rollback.restoredVersion,
      reason: 'activation_failed', detail: rollback.ok ? errorText : `${errorText}；rollback_error=${rollback.error}`
    })
    saveRecord(data, record, nowFn)
    appendGovernanceAudit({
      action: 'proposal_activate', result: 'blocked', actor,
      detail: `proposal=${safeId} 激活失败：${errorText}；${rollbackText}`
    })
    return {
      ok: false, error: 'proposal_activation_failed',
      detail: `${errorText}；${rollbackText}`,
      rolledBackTo: rollback.restoredVersion
    }
  }

  record.versions.push(versionRecord)
  record.currentVersion = version
  record.status = PROPOSAL_STATUS.ACTIVE
  saveRecord(data, record, nowFn)
  appendGovernanceAudit({
    action: 'proposal_activate', result: 'ok', actor,
    detail: `proposal=${safeId} version=${version} hash=${versionRecord.snapshotHash}`
  })
  return { ok: true, id: safeId, version, activatedPath: versionRecord.evidence.activatedPath, status: record.status }
}

/**
 * 人工回滚：active 版本回退到上一已知版本；无上一版本时完全下线（rolled_back）。
 * 版本记录与回滚事件全部保留，旧规则可追溯。
 */
export function rollbackActiveIntent(id, { actor, reason = '', nowFn = () => new Date().toISOString() } = {}) {
  if (!isHumanActor(actor)) return blockedActorResult('proposal_rollback', id, actor)
  ensureIntentDirs()
  const safeId = safeProposalId(id)
  const data = readGovernanceFile()
  const record = data.proposals[safeId] ? normalizeRecord(data.proposals[safeId], safeId) : null
  if (!record || record.versions.length === 0) {
    return { ok: false, error: 'governance_record_not_found', detail: '无版本记录，无法回滚（仅治理激活的 intent 支持回滚）' }
  }
  if (record.status !== PROPOSAL_STATUS.ACTIVE) {
    return { ok: false, error: 'illegal_status_transition', detail: `当前状态 ${record.status}，仅 active 可回滚` }
  }

  const fromVersion = record.currentVersion
  const rollback = restorePreviousVersion(record)
  if (!rollback.ok) {
    appendGovernanceAudit({
      action: 'proposal_rollback', result: 'blocked', actor,
      detail: `proposal=${safeId} 回滚恢复失败：${rollback.error}`
    })
    return { ok: false, error: 'proposal_rollback_failed', detail: rollback.error }
  }
  record.rollbacks.push({
    ts: nowFn(), actor: String(actor), fromVersion, toVersion: rollback.restoredVersion,
    reason: String(reason || 'manual_rollback').slice(0, 280), detail: null
  })
  saveRecord(data, record, nowFn)
  appendGovernanceAudit({
    action: 'proposal_rollback', result: 'ok', actor,
    detail: `proposal=${safeId} ${fromVersion} -> ${rollback.restoredVersion ?? 'none'}`
  })
  return { ok: true, id: safeId, fromVersion, restoredVersion: rollback.restoredVersion, status: record.status }
}

/**
 * 受控下线：移除 active 文件并注销注册；版本记录保留可追溯（不删除历史规则）。
 */
export function deactivateGovernedIntent(id, { actor, reason = '', nowFn = () => new Date().toISOString() } = {}) {
  if (!isHumanActor(actor)) return blockedActorResult('proposal_deactivate', id, actor)
  ensureIntentDirs()
  const safeId = safeProposalId(id)
  const activePath = path.join(getIntentsDir(), `${safeId}.json`)
  if (!fs.existsSync(activePath)) return { ok: false, error: 'intent_not_found' }
  fs.unlinkSync(activePath)
  unregisterIntent(safeId)

  const data = readGovernanceFile()
  const record = data.proposals[safeId] ? normalizeRecord(data.proposals[safeId], safeId) : null
  if (record && record.versions.length > 0) {
    record.rollbacks.push({
      ts: nowFn(), actor: String(actor), fromVersion: record.currentVersion, toVersion: null,
      reason: String(reason || 'deactivated').slice(0, 280), detail: null
    })
    record.currentVersion = 0
    record.status = PROPOSAL_STATUS.ROLLED_BACK
    saveRecord(data, record, nowFn)
  }
  appendGovernanceAudit({
    action: 'proposal_deactivate', result: 'ok', actor,
    detail: `proposal=${safeId} 已下线，版本记录保留 ${record ? record.versions.length : 0} 条`
  })
  return { ok: true, id: safeId, removed: true }
}

/**
 * 治理视图：返回全部治理记录（版本快照不展开，避免响应过大；快照在治理文件中可追溯）。
 */
export function listProposalGovernance() {
  const data = readGovernanceFile()
  return Object.values(data.proposals).map((record) => {
    const normalized = normalizeRecord(record, record.id)
    return {
      id: normalized.id,
      status: normalized.status,
      currentVersion: normalized.currentVersion,
      versionCount: normalized.versions.length,
      lastTest: normalized.tests.at(-1) || null,
      lastReview: normalized.reviews.at(-1) || null,
      lastRollback: normalized.rollbacks.at(-1) || null,
      updatedAt: normalized.updatedAt
    }
  })
}

/**
 * 单条治理记录全量读取（含版本快照，供追溯/审计核对）。
 */
export function getProposalGovernanceRecord(id) {
  const safeId = safeProposalId(id)
  const data = readGovernanceFile()
  if (!data.proposals[safeId]) return null
  return normalizeRecord(data.proposals[safeId], safeId)
}
