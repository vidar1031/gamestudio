/**
 * 学习循环 + 技能治理桥：hermes agent 自创技能的人工审核与受控激活。
 *
 * 背景：hermes 的学习循环会在 HERMES_HOME/skills 下自动创建/修补技能
 * （程序性记忆）。该目录是不可信来源——agent 自创技能不能自动成为生产规则。
 *
 * 本模块的治理语义（与仓库 AGENTS.md 安全边界一致）：
 * - 扫描 HERMES_HOME/skills，用 .bundled_manifest 的 origin hash 区分
 *   「捆绑未改（pristine）/ 捆绑被 agent patch（hash 不匹配）/ 非捆绑来源
 *   （agent 自创或外部安装）」；仅后两类进入候选；
 * - 生命周期：candidate → approved / rejected（简洁两态）；candidate 由
 *   「扫描到且治理文件中无决定」派生，治理文件只持久化已决项与审核历史，
 *   重复扫描天然幂等（已决项不重复进候选）；
 * - 审核/激活必须由人类操作者执行：复用 proposalGovernance 的 isHumanActor
 *   闸门，model/cron/agent 等自动路径身份一律拒绝并写治理审计（blocked）；
 * - approved = 生效：把技能目录整体复制到 control 可信根
 *   （config/hermes/skills/<category>/<name>/，内容为审阅时快照），并把
 *   SKILL.md 路径登记进注入配置（manager.left-brain.json 的 skills.skillFiles，
 *   buildHermesBinding 下次构建注入清单自然包含）；rejected = 不生效，留档；
 * - 学习产物绝不自动生效：本模块不存在任何自动审核/自动同步代码路径；
 *   approved 后源目录再被 agent 修改也不会自动同步（只在扫描视图中标记
 *   sourceChangedAfterDecision 供人工感知）。
 *
 * 持久化：state/skill-governance.json（原子写；HERMES_SKILL_GOVERNANCE_FILE 可覆盖）。
 * 审计：复用 H01 governanceAudit（action: skill_review）。
 * 测试隔离：技能根 HERMES_SKILL_SCAN_ROOT、可信根 HERMES_TRUSTED_SKILL_ROOT、
 * 注入配置 HERMES_SKILL_INJECTION_CONFIG_FILE、治理文件、审计文件全部 env 可覆盖。
 */

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { GAMESTUDIO_ROOT, HERMES_HOME, HERMES_CONFIG_ROOT, HERMES_CONTROL_CONFIG_FILE } from '../../config/paths.js'
import { isHumanActor } from './proposalGovernance.js'
import { appendGovernanceAudit } from '../reasoning/governanceAudit.js'

export const SKILL_DECISION_STATUS = Object.freeze({
  APPROVED: 'approved',
  REJECTED: 'rejected'
})

// 技能内容展示上限：防止超大 SKILL.md 撑爆审核界面响应
const SKILL_CONTENT_LIMIT = 64 * 1024
const REVIEWS_LIMIT = 20

export function getSkillScanRoot() {
  const override = process.env.HERMES_SKILL_SCAN_ROOT
  if (override && String(override).trim()) return String(override)
  return path.join(HERMES_HOME, 'skills')
}

export function getTrustedSkillRoot() {
  const override = process.env.HERMES_TRUSTED_SKILL_ROOT
  if (override && String(override).trim()) return String(override)
  return path.join(HERMES_CONFIG_ROOT, 'skills')
}

export function getSkillGovernanceFile() {
  const override = process.env.HERMES_SKILL_GOVERNANCE_FILE
  if (override && String(override).trim()) return String(override)
  return path.join(GAMESTUDIO_ROOT, 'state', 'skill-governance.json')
}

export function getSkillInjectionConfigFile() {
  const override = process.env.HERMES_SKILL_INJECTION_CONFIG_FILE
  if (override && String(override).trim()) return String(override)
  return HERMES_CONTROL_CONFIG_FILE
}

/**
 * 与 hermes skills_sync._dir_hash 完全一致的目录 hash：
 * md5 over sorted（相对路径 utf8 + 文件内容），用于与 .bundled_manifest 的
 * origin hash 比对，判断捆绑技能是否被 agent patch 过。
 */
export function computeSkillDirHash(dir) {
  const hasher = crypto.createHash('md5')
  const files = []
  const walk = (current) => {
    let entries = []
    try {
      entries = fs.readdirSync(current, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.isFile()) files.push(full)
    }
  }
  walk(dir)
  files.sort()
  for (const file of files) {
    try {
      hasher.update(Buffer.from(path.relative(dir, file), 'utf8'))
      hasher.update(fs.readFileSync(file))
    } catch {
      // 读取失败的文件跳过（与 hermes 容忍 OSError 语义一致）
    }
  }
  return hasher.digest('hex')
}

/**
 * 读取 .bundled_manifest：v2 格式 name:hash；v1 纯名称迁移为空 hash
 * （空 hash 无法证明 pristine，分类时保守按 bundled_patched 进候选）。
 */
function readBundledManifest(scanRoot) {
  const manifestFile = path.join(scanRoot, '.bundled_manifest')
  const manifest = new Map()
  let raw = ''
  try {
    raw = fs.readFileSync(manifestFile, 'utf8')
  } catch {
    return { manifest, exists: false }
  }
  for (const line of raw.split('\n')) {
    const text = line.trim()
    if (!text) continue
    const sep = text.indexOf(':')
    if (sep >= 0) manifest.set(text.slice(0, sep).trim(), text.slice(sep + 1).trim())
    else manifest.set(text, '')
  }
  return { manifest, exists: true }
}

/**
 * 轻量解析 SKILL.md YAML frontmatter 的 name / description（单行值，可带引号）。
 * name 缺失时回退目录名（与 hermes _read_skill_name 语义一致）。
 */
function parseSkillFrontmatter(content, fallbackName) {
  const result = { name: fallbackName, description: '' }
  const head = String(content || '').slice(0, 8000)
  let inFrontmatter = false
  for (const line of head.split('\n')) {
    const stripped = line.trim()
    if (stripped === '---') {
      if (inFrontmatter) break
      inFrontmatter = true
      continue
    }
    if (!inFrontmatter) continue
    const nameMatch = stripped.match(/^name:\s*(.+)$/)
    if (nameMatch) {
      const value = nameMatch[1].trim().replace(/^["']|["']$/g, '')
      if (value) result.name = value
      continue
    }
    const descMatch = stripped.match(/^description:\s*(.+)$/)
    if (descMatch) {
      result.description = descMatch[1].trim().replace(/^["']|["']$/g, '')
    }
  }
  return result
}

function listSkillFilesRecursive(dir) {
  const files = []
  const walk = (current) => {
    let entries = []
    try {
      entries = fs.readdirSync(current, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.isFile()) files.push(path.relative(dir, full).split(path.sep).join('/'))
    }
  }
  walk(dir)
  return files.sort()
}

function emptyGovernanceData() {
  return { version: 1, skills: {} }
}

function readGovernanceData() {
  const file = getSkillGovernanceFile()
  try {
    if (!fs.existsSync(file)) return emptyGovernanceData()
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (!raw || typeof raw.skills !== 'object' || raw.skills === null) {
      throw new Error('invalid_skill_governance_file')
    }
    return raw
  } catch {
    // 损坏文件隔离留证后按空处理，不猜测内容（与 proposal 治理同一语义）
    try {
      fs.renameSync(file, `${file}.corrupt-${Date.now()}`)
    } catch {
      // 隔离失败不阻断读取
    }
    return emptyGovernanceData()
  }
}

function writeGovernanceData(data) {
  const file = getSkillGovernanceFile()
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf8')
  fs.renameSync(tmp, file)
}

function normalizeDecisionRecord(record, name) {
  return {
    name,
    status: String(record?.status || ''),
    origin: String(record?.origin || ''),
    category: String(record?.category || ''),
    description: String(record?.description || ''),
    sourceDir: String(record?.sourceDir || ''),
    sourceHash: String(record?.sourceHash || ''),
    decidedAt: record?.decidedAt || null,
    actor: record?.actor ? String(record.actor) : null,
    note: String(record?.note || ''),
    reviews: Array.isArray(record?.reviews) ? record.reviews : [],
    activatedPath: record?.activatedPath ? String(record.activatedPath) : null,
    activatedSkillFile: record?.activatedSkillFile ? String(record.activatedSkillFile) : null
  }
}

/**
 * 扫描 hermes 技能根并分类。只读文件系统与治理文件，不写任何状态。
 * 返回候选（未决）与已决两列；同名重复技能在 duplicates 留证（按目录序首个生效）。
 */
export function scanHermesSkills() {
  const scanRoot = getSkillScanRoot()
  const { manifest, exists: manifestExists } = readBundledManifest(scanRoot)
  const governance = readGovernanceData()

  const skillMds = []
  const walk = (current, depth) => {
    let entries = []
    try {
      entries = fs.readdirSync(current, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) walk(full, depth + 1)
      else if (entry.isFile() && entry.name === 'SKILL.md') skillMds.push(full)
    }
  }
  if (fs.existsSync(scanRoot)) walk(scanRoot, 0)
  skillMds.sort()

  const candidates = []
  const decided = []
  const duplicates = []
  const seen = new Set()
  let bundledPristine = 0

  for (const skillMd of skillMds) {
    const sourceDir = path.dirname(skillMd)
    // 防御：技能必须位于扫描根内（符号链接等越界一律跳过）
    if (sourceDir !== scanRoot && !sourceDir.startsWith(scanRoot + path.sep)) continue
    const relDir = path.relative(scanRoot, sourceDir).split(path.sep).join('/')
    const parts = relDir.split('/').filter(Boolean)
    const dirName = parts.at(-1) || ''
    const category = parts.length > 1 ? parts.slice(0, -1).join('/') : ''

    let frontmatter = { name: dirName, description: '' }
    let content = ''
    try {
      content = fs.readFileSync(skillMd, 'utf8')
      frontmatter = parseSkillFrontmatter(content, dirName)
    } catch {
      // SKILL.md 读不出来：name 回退目录名，照常进入分类（由人审决定）
    }
    const name = frontmatter.name
    if (seen.has(name)) {
      duplicates.push({ name, sourceDir: relDir })
      continue
    }
    seen.add(name)

    const contentHash = computeSkillDirHash(sourceDir)
    const originHash = manifest.has(name) ? manifest.get(name) : null
    // 分类：manifest 无记录 = 非捆绑来源（agent 自创或外部安装）；
    // 有记录但 hash 对不上（或 v1 空 hash 无法证明）= 捆绑被 patch；
    // 完全一致 = pristine 捆绑，不进候选
    let origin = null
    if (originHash === null) origin = 'agent_created'
    else if (!originHash || originHash !== contentHash) origin = 'bundled_patched'
    else {
      bundledPristine += 1
      continue
    }

    const base = {
      name,
      category,
      description: frontmatter.description,
      origin,
      sourceDir: relDir,
      contentHash
    }
    const record = governance.skills[name] ? normalizeDecisionRecord(governance.skills[name], name) : null
    if (record && [SKILL_DECISION_STATUS.APPROVED, SKILL_DECISION_STATUS.REJECTED].includes(record.status)) {
      decided.push({
        ...record,
        sourceMissing: false,
        // 决定后源目录是否又被改动（approved 的激活副本保持审阅时快照，不自动同步）
        sourceChangedAfterDecision: Boolean(record.sourceHash) && record.sourceHash !== contentHash
      })
    } else {
      candidates.push(base)
    }
  }

  // 已决但源目录已消失的技能：保留在已决列表并标记，不假装还扫描得到
  for (const [name, rawRecord] of Object.entries(governance.skills)) {
    const record = normalizeDecisionRecord(rawRecord, name)
    if (![SKILL_DECISION_STATUS.APPROVED, SKILL_DECISION_STATUS.REJECTED].includes(record.status)) continue
    if (seen.has(name)) continue
    decided.push({ ...record, sourceMissing: true, sourceChangedAfterDecision: false })
  }

  return {
    root: scanRoot,
    manifestExists,
    scannedTotal: skillMds.length,
    bundledPristine,
    candidates,
    decided,
    duplicates
  }
}

/**
 * 读取单个技能的 SKILL.md 全文（供人工审阅），含目录文件清单。
 * 候选与已决技能均可读（已决项供追溯核对）。
 */
export function getSkillCandidateContent(name) {
  const scan = scanHermesSkills()
  const entry = [...scan.candidates, ...scan.decided.filter((item) => !item.sourceMissing)]
    .find((item) => item.name === name)
  if (!entry) return { ok: false, error: 'skill_not_found', detail: '当前扫描中不存在该技能（可能已被移除）' }
  const skillMd = path.join(scan.root, entry.sourceDir, 'SKILL.md')
  let content = ''
  let truncated = false
  try {
    content = fs.readFileSync(skillMd, 'utf8')
    if (Buffer.byteLength(content, 'utf8') > SKILL_CONTENT_LIMIT) {
      content = Buffer.from(content, 'utf8').subarray(0, SKILL_CONTENT_LIMIT).toString('utf8')
      truncated = true
    }
  } catch (error) {
    return { ok: false, error: 'skill_content_unreadable', detail: error instanceof Error ? error.message : String(error) }
  }
  return {
    ok: true,
    name: entry.name,
    category: entry.category,
    origin: entry.origin,
    sourceDir: entry.sourceDir,
    contentHash: entry.contentHash,
    files: listSkillFilesRecursive(path.join(scan.root, entry.sourceDir)),
    content,
    truncated
  }
}

function sanitizePathSegment(segment) {
  const cleaned = String(segment || '').replace(/[^A-Za-z0-9_.\-]/g, '_')
  if (!cleaned || cleaned === '.' || cleaned === '..') return '_'
  return cleaned.slice(0, 80)
}

/**
 * 把 approved 技能的 SKILL.md 路径登记进注入配置（skills.skillFiles，去重）。
 * 与 buildSkillConfig 同一真相源：persisted config 的显式列表即注入清单。
 */
function registerSkillInjection(activatedSkillFile) {
  const configFile = getSkillInjectionConfigFile()
  let config = {}
  try {
    if (fs.existsSync(configFile)) {
      config = JSON.parse(fs.readFileSync(configFile, 'utf8')) || {}
    }
  } catch (error) {
    return { ok: false, error: 'skill_injection_config_unreadable', detail: error instanceof Error ? error.message : String(error) }
  }
  const skills = config.skills && typeof config.skills === 'object' ? config.skills : {}
  const skillFiles = Array.isArray(skills.skillFiles) ? skills.skillFiles.map((item) => String(item)) : []
  if (!skillFiles.includes(activatedSkillFile)) skillFiles.push(activatedSkillFile)
  const next = {
    ...config,
    skills: {
      ...skills,
      skillRoot: String(skills.skillRoot || getTrustedSkillRoot()),
      skillFiles
    }
  }
  try {
    fs.mkdirSync(path.dirname(configFile), { recursive: true })
    const tmp = `${configFile}.tmp-${process.pid}-${Date.now()}`
    fs.writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
    fs.renameSync(tmp, configFile)
  } catch (error) {
    return { ok: false, error: 'skill_injection_config_unwritable', detail: error instanceof Error ? error.message : String(error) }
  }
  return { ok: true, configFile }
}

function blockedActorResult(name, actor) {
  appendGovernanceAudit({
    action: 'skill_review',
    result: 'blocked',
    actor: actor || null,
    detail: `actor_not_human:${String(actor || '').trim() || 'missing'} skill=${name}`
  })
  return { ok: false, error: 'actor_not_human', detail: '技能审核必须由人类操作者执行，自动路径身份一律拒绝' }
}

/**
 * 人工审核技能候选：approve 复制到可信根并登记注入清单；reject 仅留档。
 * 全程基于当前文件事实（审核时重新扫描定位），非人类 actor 一律 403 + 审计。
 */
export function reviewLearnedSkill(name, { actor, decision, note = '', nowFn = () => new Date().toISOString() } = {}) {
  if (!isHumanActor(actor)) return blockedActorResult(name, actor)
  const normalizedDecision = String(decision || '').trim().toLowerCase()
  if (normalizedDecision !== 'approve' && normalizedDecision !== 'reject') {
    return { ok: false, error: 'decision_invalid', detail: 'decision 仅支持 approve / reject' }
  }

  // 审核必须基于当前文件事实：重新扫描定位技能（不用调用方传来的路径）
  const scan = scanHermesSkills()
  const governance = readGovernanceData()
  const existing = governance.skills[name] ? normalizeDecisionRecord(governance.skills[name], name) : null
  if (existing && [SKILL_DECISION_STATUS.APPROVED, SKILL_DECISION_STATUS.REJECTED].includes(existing.status)) {
    appendGovernanceAudit({
      action: 'skill_review', result: 'blocked', actor, decision: normalizedDecision,
      detail: `skill=${name} 已有决定 status=${existing.status}，重复审核拒绝`
    })
    return { ok: false, error: 'illegal_status_transition', detail: `该技能已完成审核（${existing.status}），不重复审核` }
  }

  const candidate = scan.candidates.find((item) => item.name === name)
  if (!candidate) {
    return { ok: false, error: 'skill_not_found', detail: '当前扫描的候选中不存在该技能（可能已被移除或已是捆绑原始状态）' }
  }

  const record = {
    name: candidate.name,
    status: normalizedDecision === 'approve' ? SKILL_DECISION_STATUS.APPROVED : SKILL_DECISION_STATUS.REJECTED,
    origin: candidate.origin,
    category: candidate.category,
    description: candidate.description,
    sourceDir: candidate.sourceDir,
    sourceHash: candidate.contentHash,
    decidedAt: nowFn(),
    actor: String(actor),
    note: String(note || '').slice(0, 280),
    reviews: [...(existing?.reviews || []), { ts: nowFn(), actor: String(actor), decision: normalizedDecision, note: String(note || '').slice(0, 280) }].slice(-REVIEWS_LIMIT),
    activatedPath: null,
    activatedSkillFile: null
  }

  if (normalizedDecision === 'approve') {
    // 复制到可信根：<trustedRoot>/<category>/<dirName>/（逐段 sanitize，防路径越界）
    const trustedRoot = getTrustedSkillRoot()
    const segments = candidate.sourceDir.split('/').filter(Boolean).map(sanitizePathSegment)
    const targetDir = path.join(trustedRoot, ...segments)
    if (targetDir !== trustedRoot && !targetDir.startsWith(trustedRoot + path.sep)) {
      return { ok: false, error: 'skill_activation_path_unsafe', detail: '激活目标路径越界，已阻断' }
    }
    const sourceAbs = path.join(scan.root, candidate.sourceDir)
    try {
      fs.rmSync(targetDir, { recursive: true, force: true })
      fs.mkdirSync(path.dirname(targetDir), { recursive: true })
      fs.cpSync(sourceAbs, targetDir, { recursive: true })
    } catch (error) {
      appendGovernanceAudit({
        action: 'skill_review', result: 'blocked', actor, decision: normalizedDecision,
        detail: `skill=${name} 复制到可信根失败：${error instanceof Error ? error.message : String(error)}`
      })
      return { ok: false, error: 'skill_activation_copy_failed', detail: error instanceof Error ? error.message : String(error) }
    }
    const activatedSkillFile = path.join(targetDir, 'SKILL.md')
    // 登记注入清单失败不标 approved（保持候选可重试；复制幂等，重试安全）
    const injection = registerSkillInjection(activatedSkillFile)
    if (!injection.ok) {
      appendGovernanceAudit({
        action: 'skill_review', result: 'blocked', actor, decision: normalizedDecision,
        detail: `skill=${name} 登记注入清单失败：${injection.detail || injection.error}`
      })
      return { ok: false, error: injection.error, detail: `技能已复制到可信根，但登记注入清单失败：${injection.detail || injection.error}` }
    }
    record.activatedPath = targetDir
    record.activatedSkillFile = activatedSkillFile
  }

  governance.skills[name] = record
  writeGovernanceData(governance)
  appendGovernanceAudit({
    action: 'skill_review', result: 'ok', actor, decision: normalizedDecision,
    detail: `skill=${name} origin=${candidate.origin} status=${record.status}${record.activatedPath ? ` activated=${record.activatedPath}` : ''}`
  })
  return { ok: true, name, status: record.status, decision: normalizedDecision, record }
}

/**
 * 当前注入清单视图：persisted config 的 skills.skillFiles（filter 存在）
 * 与 buildSkillConfig 同一语义；附治理文件中 approved 技能清单供对照。
 */
export function listActiveSkills() {
  const configFile = getSkillInjectionConfigFile()
  let config = {}
  let configReadable = true
  try {
    if (fs.existsSync(configFile)) {
      config = JSON.parse(fs.readFileSync(configFile, 'utf8')) || {}
    }
  } catch {
    configReadable = false
  }
  const skills = config.skills && typeof config.skills === 'object' ? config.skills : {}
  const skillFiles = Array.isArray(skills.skillFiles) ? skills.skillFiles.map((item) => String(item)).filter(Boolean) : []
  const availableSkillFiles = skillFiles.filter((filePath) => fs.existsSync(filePath))

  const governance = readGovernanceData()
  const approved = Object.entries(governance.skills)
    .map(([name, record]) => normalizeDecisionRecord(record, name))
    .filter((record) => record.status === SKILL_DECISION_STATUS.APPROVED)
    .map((record) => ({
      name: record.name,
      category: record.category,
      description: record.description,
      origin: record.origin,
      decidedAt: record.decidedAt,
      actor: record.actor,
      note: record.note,
      activatedSkillFile: record.activatedSkillFile,
      activatedExists: record.activatedSkillFile ? fs.existsSync(record.activatedSkillFile) : false,
      injected: record.activatedSkillFile ? availableSkillFiles.includes(record.activatedSkillFile) : false
    }))

  return {
    ok: true,
    configFile,
    configReadable,
    skillRoot: String(skills.skillRoot || getTrustedSkillRoot()),
    skillFiles,
    availableSkillFiles,
    approved
  }
}
