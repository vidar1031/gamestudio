import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { Hono } from 'hono'

// 学习循环 + 技能治理桥测试：扫描分类（bundled pristine / agent 自创 / 被 patch 的 bundled）、
// 非人类 actor 拒绝+审计、approve 复制到可信根并登记注入清单、reject 不生效、
// 重复扫描幂等、HTTP 路由全链路。
// env 隔离：技能根 / 可信根 / 注入配置 / 治理文件 / 审计文件全部指向临时目录，
// 不触碰真实 HERMES_HOME、config/hermes 与 state。

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-governance-'))
const SCAN_ROOT = path.join(TMP_DIR, 'hermes-home', 'skills')
const TRUSTED_ROOT = path.join(TMP_DIR, 'trusted-skills')
const GOVERNANCE_FILE = path.join(TMP_DIR, 'skill-governance.json')
const AUDIT_FILE = path.join(TMP_DIR, 'governance-audit.jsonl')
const INJECTION_CONFIG_FILE = path.join(TMP_DIR, 'manager.left-brain.json')

const savedEnv = {
  HERMES_SKILL_SCAN_ROOT: process.env.HERMES_SKILL_SCAN_ROOT,
  HERMES_TRUSTED_SKILL_ROOT: process.env.HERMES_TRUSTED_SKILL_ROOT,
  HERMES_SKILL_GOVERNANCE_FILE: process.env.HERMES_SKILL_GOVERNANCE_FILE,
  HERMES_GOVERNANCE_AUDIT_FILE: process.env.HERMES_GOVERNANCE_AUDIT_FILE,
  HERMES_SKILL_INJECTION_CONFIG_FILE: process.env.HERMES_SKILL_INJECTION_CONFIG_FILE
}
process.env.HERMES_SKILL_SCAN_ROOT = SCAN_ROOT
process.env.HERMES_TRUSTED_SKILL_ROOT = TRUSTED_ROOT
process.env.HERMES_SKILL_GOVERNANCE_FILE = GOVERNANCE_FILE
process.env.HERMES_GOVERNANCE_AUDIT_FILE = AUDIT_FILE
process.env.HERMES_SKILL_INJECTION_CONFIG_FILE = INJECTION_CONFIG_FILE

function restoreEnv() {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
}
process.on('exit', restoreEnv)

// env 必须先于被测模块生效（模块内 getter 每次调用读取 env，动态 import 仅为时序保险）
const governance = await import('../../apps/control-server/src/server/intents/skillGovernance.js')
const { readGovernanceAudit } = await import('../../apps/control-server/src/server/reasoning/governanceAudit.js')
const { registerSkillGovernanceRoutes } = await import('../../apps/control-server/src/server/routes/skillGovernanceRoutes.js')

const FIXED_NOW = '2026-08-18T09:00:00.000Z'
const fixedNowFn = () => FIXED_NOW
const HUMAN = 'human:operator-chen'

function writeSkill(relativeDir, { name, description = '测试技能', extraFiles = {} }) {
  const dir = path.join(SCAN_ROOT, relativeDir)
  fs.mkdirSync(dir, { recursive: true })
  const content = `---\nname: ${name}\ndescription: "${description}"\n---\n\n# ${name}\n\n技能正文。\n`
  fs.writeFileSync(path.join(dir, 'SKILL.md'), content, 'utf8')
  for (const [file, body] of Object.entries(extraFiles)) {
    const target = path.join(dir, file)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, body, 'utf8')
  }
  return { dir, content }
}

function writeManifest(entries) {
  fs.mkdirSync(SCAN_ROOT, { recursive: true })
  fs.writeFileSync(
    path.join(SCAN_ROOT, '.bundled_manifest'),
    entries.map(([name, hash]) => `${name}:${hash}`).join('\n') + '\n',
    'utf8'
  )
}

function writeInjectionConfig() {
  // 既有注入清单：已有一个工作区技能（approve 必须追加而不是覆盖）
  const existingSkillFile = path.join(TRUSTED_ROOT, 'gamestudio-workspace', 'SKILL.md')
  fs.mkdirSync(path.dirname(existingSkillFile), { recursive: true })
  fs.writeFileSync(existingSkillFile, '# workspace\n', 'utf8')
  fs.mkdirSync(path.dirname(INJECTION_CONFIG_FILE), { recursive: true })
  fs.writeFileSync(INJECTION_CONFIG_FILE, JSON.stringify({
    provider: 'omlx',
    skills: { skillRoot: TRUSTED_ROOT, skillFiles: [existingSkillFile] }
  }, null, 2), 'utf8')
  return existingSkillFile
}

let existingInjectedFile = ''

function resetAll() {
  fs.rmSync(TMP_DIR, { recursive: true, force: true })
  fs.mkdirSync(SCAN_ROOT, { recursive: true })
  // bundled pristine：manifest hash 用与 hermes 相同的目录 hash 算法生成
  writeSkill('devops/bundled-skill', { name: 'bundled-skill', description: '捆绑未改技能' })
  const pristineHash = governance.computeSkillDirHash(path.join(SCAN_ROOT, 'devops', 'bundled-skill'))
  // bundled patched：manifest 里登记的是旧 hash，与当前目录不一致
  writeSkill('devops/patched-skill', { name: 'patched-skill', description: '被 agent 修改的捆绑技能', extraFiles: { 'notes.md': 'agent 补充\n' } })
  writeManifest([['bundled-skill', pristineHash], ['patched-skill', '0'.repeat(32)]])
  // 非捆绑来源（agent 自创或外部安装）：带类别与不待类别各一
  writeSkill('custom/my-learned-skill', { name: 'my-learned-skill', description: 'agent 学习产出的技能', extraFiles: { 'refs/guide.md': '参考\n' } })
  writeSkill('top-level-skill', { name: 'top-level-skill', description: '顶层技能' })
  existingInjectedFile = writeInjectionConfig()
}

function auditRecords() {
  return readGovernanceAudit(500).records
}

function candidateNames(scan) {
  return scan.candidates.map((item) => item.name).sort()
}

test('扫描分类：bundled pristine 不进候选；agent 自创与被 patch 的 bundled 进候选', () => {
  resetAll()
  const scan = governance.scanHermesSkills()
  assert.equal(scan.root, SCAN_ROOT)
  assert.equal(scan.manifestExists, true)
  assert.equal(scan.scannedTotal, 4)
  assert.equal(scan.bundledPristine, 1)
  assert.deepEqual(candidateNames(scan), ['my-learned-skill', 'patched-skill', 'top-level-skill'])
  const byName = Object.fromEntries(scan.candidates.map((item) => [item.name, item]))
  assert.equal(byName['my-learned-skill'].origin, 'agent_created')
  assert.equal(byName['my-learned-skill'].category, 'custom')
  assert.equal(byName['my-learned-skill'].description, 'agent 学习产出的技能')
  assert.equal(byName['patched-skill'].origin, 'bundled_patched')
  assert.equal(byName['patched-skill'].category, 'devops')
  assert.equal(byName['top-level-skill'].category, '')
  assert.equal(scan.decided.length, 0)
  // 重复扫描幂等
  const again = governance.scanHermesSkills()
  assert.deepEqual(candidateNames(again), candidateNames(scan))
  assert.equal(fs.existsSync(GOVERNANCE_FILE), false, '纯扫描不写治理文件')
})

test('非人类 actor 审核一律拒绝并审计 blocked，状态不被推动', () => {
  resetAll()
  for (const actor of ['model:skill-manage', 'cron:job_daily', 'agent:hermes-manager', '', undefined]) {
    const result = governance.reviewLearnedSkill('my-learned-skill', { actor, decision: 'approve', nowFn: fixedNowFn })
    assert.equal(result.ok, false)
    assert.equal(result.error, 'actor_not_human')
  }
  // 未生效：可信根无文件、注入配置未变、治理记录不存在
  assert.equal(fs.existsSync(path.join(TRUSTED_ROOT, 'custom')), false)
  const config = JSON.parse(fs.readFileSync(INJECTION_CONFIG_FILE, 'utf8'))
  assert.deepEqual(config.skills.skillFiles, [existingInjectedFile])
  assert.equal(fs.existsSync(GOVERNANCE_FILE), false)
  const blocked = auditRecords().filter((entry) => entry.action === 'skill_review' && entry.result === 'blocked')
  assert.equal(blocked.length, 5)
  assert.ok(blocked.every((entry) => entry.detail?.includes('actor_not_human') && entry.detail?.includes('skill=my-learned-skill')))
})

test('reject：不复制、不进注入清单，留档后不再进候选，重复审核 409', () => {
  resetAll()
  const rejected = governance.reviewLearnedSkill('top-level-skill', { actor: HUMAN, decision: 'reject', note: '与生产无关', nowFn: fixedNowFn })
  assert.equal(rejected.ok, true)
  assert.equal(rejected.status, 'rejected')
  assert.equal(fs.existsSync(path.join(TRUSTED_ROOT, 'top-level-skill')), false)
  const config = JSON.parse(fs.readFileSync(INJECTION_CONFIG_FILE, 'utf8'))
  assert.deepEqual(config.skills.skillFiles, [existingInjectedFile])
  // 再次扫描：已决项不重复进候选，出现在 decided
  const scan = governance.scanHermesSkills()
  assert.deepEqual(candidateNames(scan), ['my-learned-skill', 'patched-skill'])
  const decided = scan.decided.find((item) => item.name === 'top-level-skill')
  assert.equal(decided.status, 'rejected')
  assert.equal(decided.actor, HUMAN)
  assert.equal(decided.note, '与生产无关')
  assert.equal(decided.decidedAt, FIXED_NOW)
  // 重复审核拒绝 + 审计 blocked
  const again = governance.reviewLearnedSkill('top-level-skill', { actor: HUMAN, decision: 'approve', nowFn: fixedNowFn })
  assert.equal(again.ok, false)
  assert.equal(again.error, 'illegal_status_transition')
  const audits = auditRecords().filter((entry) => entry.action === 'skill_review')
  assert.equal(audits.filter((entry) => entry.result === 'ok' && entry.decision === 'reject').length, 1)
  assert.equal(audits.filter((entry) => entry.result === 'blocked' && entry.detail?.includes('重复审核')).length, 1)
})

test('approve：复制到可信根并登记注入清单，已决后不再进候选', () => {
  resetAll()
  const approved = governance.reviewLearnedSkill('my-learned-skill', { actor: HUMAN, decision: 'approve', note: '内容已审阅', nowFn: fixedNowFn })
  assert.equal(approved.ok, true)
  assert.equal(approved.status, 'approved')
  // 复制到可信根 <trustedRoot>/<category>/<dirName>/，含附加文件，内容一致
  const activatedDir = path.join(TRUSTED_ROOT, 'custom', 'my-learned-skill')
  const activatedSkillFile = path.join(activatedDir, 'SKILL.md')
  assert.ok(fs.existsSync(activatedSkillFile))
  assert.ok(fs.readFileSync(activatedSkillFile, 'utf8').includes('name: my-learned-skill'))
  assert.equal(fs.readFileSync(path.join(activatedDir, 'refs', 'guide.md'), 'utf8'), '参考\n')
  // 注入清单追加而非覆盖
  const config = JSON.parse(fs.readFileSync(INJECTION_CONFIG_FILE, 'utf8'))
  assert.deepEqual(config.skills.skillFiles, [existingInjectedFile, activatedSkillFile])
  // 当前注入清单视图：availableSkillFiles 与 approved 记录互相印证
  const active = governance.listActiveSkills()
  assert.deepEqual(active.availableSkillFiles, [existingInjectedFile, activatedSkillFile])
  const approvedEntry = active.approved.find((item) => item.name === 'my-learned-skill')
  assert.equal(approvedEntry.injected, true)
  assert.equal(approvedEntry.activatedExists, true)
  assert.equal(approvedEntry.actor, HUMAN)
  // 再次扫描：进 decided 不进候选
  const scan = governance.scanHermesSkills()
  assert.deepEqual(candidateNames(scan), ['patched-skill', 'top-level-skill'])
  const decided = scan.decided.find((item) => item.name === 'my-learned-skill')
  assert.equal(decided.status, 'approved')
  assert.equal(decided.sourceChangedAfterDecision, false)
  // 审计 ok 且含决策证据
  const audit = auditRecords().find((entry) => entry.action === 'skill_review' && entry.result === 'ok' && entry.decision === 'approve')
  assert.ok(audit)
  assert.equal(audit.actor, HUMAN)
  assert.match(audit.detail, /skill=my-learned-skill/)
  assert.match(audit.detail, /origin=agent_created/)
})

test('approve 后源目录再被 agent 修改：激活副本保持审阅时快照，扫描标记 sourceChangedAfterDecision', () => {
  resetAll()
  const approved = governance.reviewLearnedSkill('my-learned-skill', { actor: HUMAN, decision: 'approve', nowFn: fixedNowFn })
  assert.equal(approved.ok, true)
  const activatedSkillFile = path.join(TRUSTED_ROOT, 'custom', 'my-learned-skill', 'SKILL.md')
  const snapshot = fs.readFileSync(activatedSkillFile, 'utf8')
  // agent 继续 patch 源目录：激活副本绝不同步（学习产物不自动生效）
  fs.writeFileSync(path.join(SCAN_ROOT, 'custom', 'my-learned-skill', 'SKILL.md'), `${snapshot}\n新增段落。\n`, 'utf8')
  assert.equal(fs.readFileSync(activatedSkillFile, 'utf8'), snapshot)
  const scan = governance.scanHermesSkills()
  const decided = scan.decided.find((item) => item.name === 'my-learned-skill')
  assert.equal(decided.sourceChangedAfterDecision, true)
  const active = governance.listActiveSkills()
  assert.equal(active.availableSkillFiles.includes(activatedSkillFile), true)
})

test('patched bundled 也可经人工审核激活；内容端点返回全文与文件清单', () => {
  resetAll()
  const content = governance.getSkillCandidateContent('patched-skill')
  assert.equal(content.ok, true)
  assert.equal(content.origin, 'bundled_patched')
  assert.match(content.content, /name: patched-skill/)
  assert.deepEqual(content.files, ['SKILL.md', 'notes.md'])
  const approved = governance.reviewLearnedSkill('patched-skill', { actor: HUMAN, decision: 'approve', nowFn: fixedNowFn })
  assert.equal(approved.ok, true)
  assert.ok(fs.existsSync(path.join(TRUSTED_ROOT, 'devops', 'patched-skill', 'notes.md')))
  const config = JSON.parse(fs.readFileSync(INJECTION_CONFIG_FILE, 'utf8'))
  assert.ok(config.skills.skillFiles.includes(path.join(TRUSTED_ROOT, 'devops', 'patched-skill', 'SKILL.md')))
  // 不存在的技能 404 语义
  const missing = governance.getSkillCandidateContent('no-such-skill')
  assert.equal(missing.ok, false)
  assert.equal(missing.error, 'skill_not_found')
})

// --- HTTP 路由全链路 ---

function makeApp() {
  const app = new Hono()
  registerSkillGovernanceRoutes(app)
  return app
}

function postJson(app, url, body) {
  return app.request(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {})
  })
}

test('路由：候选列表/内容/审核 403 与 200 语义/注入清单全链路', async () => {
  resetAll()
  const app = makeApp()

  // 候选列表
  const list = await (await app.request('/api/control/skills/candidates')).json()
  assert.equal(list.ok, true)
  assert.deepEqual(list.candidates.map((item) => item.name).sort(), ['my-learned-skill', 'patched-skill', 'top-level-skill'])
  assert.equal(list.bundledPristine, 1)

  // 内容查看
  const contentRes = await app.request(`/api/control/skills/candidates/${encodeURIComponent('my-learned-skill')}/content`)
  assert.equal(contentRes.status, 200)
  const content = await contentRes.json()
  assert.match(content.content, /agent 学习产出的技能/)
  const missingRes = await app.request('/api/control/skills/candidates/no-such/content')
  assert.equal(missingRes.status, 404)

  // 无 actor / model actor 审核 403
  const noActor = await postJson(app, '/api/control/skills/candidates/my-learned-skill/review', { decision: 'approve' })
  assert.equal(noActor.status, 403)
  assert.equal((await noActor.json()).error, 'actor_not_human')
  const modelActor = await postJson(app, '/api/control/skills/candidates/my-learned-skill/review', { actor: 'model:self-promote', decision: 'approve' })
  assert.equal(modelActor.status, 403)
  // 不存在技能 404
  const notFound = await postJson(app, '/api/control/skills/candidates/no-such/review', { actor: HUMAN, decision: 'approve' })
  assert.equal(notFound.status, 404)
  // decision 非法 409
  const badDecision = await postJson(app, '/api/control/skills/candidates/my-learned-skill/review', { actor: HUMAN, decision: 'maybe' })
  assert.equal(badDecision.status, 409)

  // 人类 approve 200
  const reviewed = await postJson(app, '/api/control/skills/candidates/my-learned-skill/review', { actor: HUMAN, decision: 'approve', note: 'ok' })
  assert.equal(reviewed.status, 200)
  assert.equal((await reviewed.json()).status, 'approved')
  // 重复审核 409
  const duplicate = await postJson(app, '/api/control/skills/candidates/my-learned-skill/review', { actor: HUMAN, decision: 'approve' })
  assert.equal(duplicate.status, 409)

  // 注入清单
  const active = await (await app.request('/api/control/skills/active')).json()
  assert.equal(active.ok, true)
  const activatedSkillFile = path.join(TRUSTED_ROOT, 'custom', 'my-learned-skill', 'SKILL.md')
  assert.ok(active.availableSkillFiles.includes(activatedSkillFile))
  assert.ok(active.availableSkillFiles.includes(existingInjectedFile))
  assert.equal(active.approved.find((item) => item.name === 'my-learned-skill').injected, true)

  // 审核后候选列表收缩
  const after = await (await app.request('/api/control/skills/candidates')).json()
  assert.deepEqual(after.candidates.map((item) => item.name).sort(), ['patched-skill', 'top-level-skill'])
})
