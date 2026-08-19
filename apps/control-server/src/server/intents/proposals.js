// Skill / intent proposal pipeline.
//
// Reads agent runtime review records (state/agent-runtime-review-records.jsonl
// and the legacy state/reasoning-review-records.jsonl), groups recurring
// human "correct" decisions by their correctionPrompt fingerprint, and
// drops a JSON proposal into config/hermes/intents/_inbox/.
//
// Promotion (human-approved) moves the file from _inbox/ into the
// active intents directory and registers it on the live registry.
// Proposals are pure data; never executable code.

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import {
  HERMES_AGENT_RUNTIME_REVIEW_RECORDS_FILE,
  HERMES_REASONING_REVIEW_RECORDS_FILE,
} from '../../config/paths.js'
import { compileJsonIntent } from './jsonIntent.js'
import { getIntentsDir, getIntentsInboxDir, ensureIntentDirs } from './loadJsonIntents.js'

const MAX_RECORDS_SCAN = 1000
const MAX_KEYWORDS_PER_PROPOSAL = 8
const MIN_KEYWORD_LENGTH = 3

const SELF_REVIEW_OPERATOR_RULES = [
  {
    ruleId: 'operator.workflow_registry_status',
    matches(record) {
      const prompt = String(record?.userPrompt || '')
      return /(workflow\s*registry|intent\s*registry|完整\s*workflow\s*registry|config\/hermes\/intents)/i.test(prompt)
    },
    build(record) {
      const sessionId = String(record?.sessionId || '').trim()
      return {
        id: 'operator.workflow_registry_status',
        version: 1,
        source: 'proposal',
        priority: 82,
        description: 'Operator rule: workflow registry answers must distinguish builtin infrastructure from missing active JSON intent instances.',
        match: {
          anyRegex: [
            'workflow\\s*registry',
            'intent\\s*registry',
            '完整\\s*workflow\\s*registry',
            'config/hermes/intents'
          ]
        },
        evaluation: {
          minScore: 82,
          scoreBase: 18,
          perRequiredHit: 14,
          perOptionalHit: 6,
          perEvidenceHit: 16,
          perForbiddenHit: -30,
          mustInclude: ['builtin', '_inbox'],
          optional: ['json intent', '未完成', '基础设施', 'activeintentfiles'],
          evidenceRegex: [
            'config/hermes/intents',
            '/api/control/intents|/api/control/skill-proposals',
            '未.*建立|未完成|只有基础设施|0 个 json'
          ],
          forbidden: ['已完整建立', '已经建立', '完整的 workflow registry 已经建立', '已经完全建立', '完整 workflow registry 已建立', '可以直接新增并立即生效'],
          correctionPrompt: '回答 workflow registry / intents registry 相关问题时，必须明确区分 builtin intents、活动中的 JSON intents、以及 _inbox proposal。若 activeIntentFiles 为空或 config/hermes/intents 下没有活动 JSON intent，应明确说明只有基础设施已建立，完整 workflow registry 仍未建立。'
        },
        provenance: {
          sourceType: 'self_review_operator_rule',
          operatorRuleId: 'operator.workflow_registry_status',
          sessionId: sessionId || null,
          generatedAt: new Date().toISOString()
        }
      }
    }
  }
]

function readJsonlTail(filePath, limit) {
  if (!fs.existsSync(filePath)) return []
  try {
    const raw = fs.readFileSync(filePath, 'utf8')
    const lines = raw.split('\n').filter(Boolean)
    const tail = lines.slice(-limit)
    const parsed = []
    for (const line of tail) {
      try {
        parsed.push(JSON.parse(line))
      } catch {
        // skip corrupt line
      }
    }
    return parsed
  } catch {
    return []
  }
}

function readReviewRecords() {
  return [
    ...readJsonlTail(HERMES_AGENT_RUNTIME_REVIEW_RECORDS_FILE, MAX_RECORDS_SCAN),
    ...readJsonlTail(HERMES_REASONING_REVIEW_RECORDS_FILE, MAX_RECORDS_SCAN),
  ]
}

function shortHash(text) {
  return crypto.createHash('sha1').update(String(text || '')).digest('hex').slice(0, 10)
}

function escapeRegex(text) {
  return String(text || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function extractKeywords(prompt) {
  const tokens = String(prompt || '').match(/[\u4e00-\u9fffA-Za-z0-9_./\-]+/g) || []
  const filtered = tokens.filter((token) => token.length >= MIN_KEYWORD_LENGTH)
  return Array.from(new Set(filtered))
}

function safeProposalId(rawId) {
  const cleaned = String(rawId || '').replace(/[^A-Za-z0-9_.\-]/g, '_')
  return cleaned.slice(0, 80) || `proposal_${shortHash(String(Date.now()))}`
}

function proposalAlreadyExists(id) {
  const safeId = safeProposalId(id)
  return fs.existsSync(path.join(getIntentsDir(), `${safeId}.json`)) || fs.existsSync(path.join(getIntentsInboxDir(), `${safeId}.json`))
}

export function enqueueSelfReviewOperatorProposals(record) {
  ensureIntentDirs()
  const written = []
  const skipped = []

  for (const rule of SELF_REVIEW_OPERATOR_RULES) {
    if (!rule.matches(record)) continue
    const proposal = rule.build(record)
    const safeId = safeProposalId(proposal.id || rule.ruleId)
    const target = path.join(getIntentsInboxDir(), `${safeId}.json`)

    if (proposalAlreadyExists(safeId)) {
      skipped.push(`${safeId}:exists`)
      continue
    }

    try {
      compileJsonIntent(proposal)
    } catch (error) {
      skipped.push(`${safeId}:invalid:${error instanceof Error ? error.message : String(error)}`)
      continue
    }

    try {
      fs.writeFileSync(target, JSON.stringify(proposal, null, 2), 'utf8')
      written.push(target)
    } catch (error) {
      skipped.push(`${safeId}:write_failed:${error instanceof Error ? error.message : String(error)}`)
    }
  }

  return { written, skipped }
}

export function enqueueHumanCorrectionProposal(record) {
  ensureIntentDirs()
  const correctionPrompt = String(record?.correctionPrompt || '').trim()
  const userPrompt = String(record?.userPrompt || record?.prompt || '').trim()
  if (!correctionPrompt || !userPrompt) return { written: [], skipped: ['missing_prompt_or_correction'] }

  const keywords = extractKeywords(userPrompt).slice(0, MAX_KEYWORDS_PER_PROPOSAL)
  if (keywords.length === 0) return { written: [], skipped: ['missing_keywords'] }

  const id = safeProposalId(`human_correction_${shortHash(`${userPrompt}\n${correctionPrompt}`)}`)
  if (proposalAlreadyExists(id)) return { written: [], skipped: [`${id}:exists`] }

  const proposal = {
    id,
    version: 1,
    source: 'proposal',
    priority: 70,
    description: 'Auto-generated from one human review correction. Requires human promotion before it can affect runtime behavior.',
    match: {
      anyRegex: keywords.slice(0, 6).map((kw) => escapeRegex(kw))
    },
    evaluation: {
      minScore: 75,
      scoreBase: 40,
      perRequiredHit: 12,
      perOptionalHit: 6,
      perEvidenceHit: 10,
      perForbiddenHit: -25,
      mustInclude: [],
      optional: [],
      forbidden: [],
      evidenceRegex: [],
      correctionPrompt
    },
    provenance: {
      sourceType: 'human_review_correction',
      sessionId: String(record?.sessionId || '').trim() || null,
      decision: String(record?.decision || '').trim() || null,
      targetType: String(record?.review?.targetType || '').trim() || null,
      reviewPhase: String(record?.review?.reviewPhase || '').trim() || null,
      sampleUserPrompt: userPrompt.slice(0, 240),
      generatedAt: new Date().toISOString()
    }
  }

  const target = path.join(getIntentsInboxDir(), `${id}.json`)
  try {
    compileJsonIntent(proposal)
  } catch (error) {
    return { written: [], skipped: [`${id}:invalid:${error instanceof Error ? error.message : String(error)}`] }
  }

  try {
    fs.writeFileSync(target, JSON.stringify(proposal, null, 2), 'utf8')
    return { written: [target], skipped: [] }
  } catch (error) {
    return { written: [], skipped: [`${id}:write_failed:${error instanceof Error ? error.message : String(error)}`] }
  }
}

export function scanProposals({ minOccurrence = 2 } = {}) {
  ensureIntentDirs()
  const records = readReviewRecords()
  const corrections = []
  for (const record of records) {
    if (!record || typeof record !== 'object') continue
    const decision = String(record.decision || '').toLowerCase()
    const correctionPrompt = String(record.correctionPrompt || '').trim()
    if (!correctionPrompt) continue
    if (decision !== 'correct' && decision !== 'rework' && decision !== 'reject') continue
    corrections.push({
      userPrompt: String(record.userPrompt || record.prompt || ''),
      correctionPrompt,
      finalAnswer: String(record.finalAnswer || record.answer || '')
    })
  }

  const groups = new Map()
  for (const item of corrections) {
    const key = shortHash(item.correctionPrompt)
    if (!groups.has(key)) {
      groups.set(key, { key, correctionPrompt: item.correctionPrompt, samples: [] })
    }
    groups.get(key).samples.push(item)
  }

  const proposals = []
  for (const group of groups.values()) {
    if (group.samples.length < minOccurrence) continue
    const allKeywords = group.samples.flatMap((sample) => extractKeywords(sample.userPrompt))
    const ranked = Array.from(new Set(allKeywords)).slice(0, MAX_KEYWORDS_PER_PROPOSAL)
    if (ranked.length === 0) continue
    const id = safeProposalId(`proposal_${group.key}`)
    proposals.push({
      id,
      version: 1,
      source: 'proposal',
      description: `Auto-generated from ${group.samples.length} matching review corrections.`,
      match: {
        anyRegex: ranked.slice(0, 6).map((kw) => escapeRegex(kw))
      },
      evaluation: {
        minScore: 65,
        scoreBase: 45,
        perRequiredHit: 12,
        perOptionalHit: 6,
        perEvidenceHit: 10,
        perForbiddenHit: -25,
        mustInclude: [],
        optional: [],
        forbidden: [],
        evidenceRegex: [],
        correctionPrompt: group.correctionPrompt
      },
      provenance: {
        sampleUserPrompts: group.samples.slice(0, 3).map((sample) => sample.userPrompt.slice(0, 200)),
        occurrence: group.samples.length,
        generatedAt: new Date().toISOString()
      }
    })
  }

  const written = []
  const skipped = []
  for (const proposal of proposals) {
    const target = path.join(getIntentsInboxDir(), `${proposal.id}.json`)
    if (fs.existsSync(target)) {
      skipped.push(target)
      continue
    }
    // Validate before writing — refuse to persist a proposal we cannot compile.
    try {
      compileJsonIntent(proposal)
    } catch (error) {
      skipped.push(`${target}:invalid:${error.message}`)
      continue
    }
    try {
      fs.writeFileSync(target, JSON.stringify(proposal, null, 2), 'utf8')
      written.push(target)
    } catch {
      skipped.push(`${target}:write_failed`)
    }
  }
  return {
    scannedRecords: records.length,
    correctionGroups: groups.size,
    candidates: proposals.length,
    written,
    skipped
  }
}

export function listProposals() {
  ensureIntentDirs()
  if (!fs.existsSync(getIntentsInboxDir())) return []
  const files = fs.readdirSync(getIntentsInboxDir()).filter((name) => name.endsWith('.json'))
  return files.map((file) => {
    const filePath = path.join(getIntentsInboxDir(), file)
    try {
      const def = JSON.parse(fs.readFileSync(filePath, 'utf8'))
      return {
        id: def.id || path.basename(file, '.json'),
        filePath,
        def
      }
    } catch (error) {
      return {
        id: path.basename(file, '.json'),
        filePath,
        error: error instanceof Error ? error.message : String(error)
      }
    }
  })
}

export function listActiveIntentFiles() {
  ensureIntentDirs()
  if (!fs.existsSync(getIntentsDir())) return []
  return fs
    .readdirSync(getIntentsDir(), { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
    .map((entry) => path.join(getIntentsDir(), entry.name))
}

// AUTO-F02：原 promoteProposal / rejectProposal / deactivateActiveIntent 已移除。
// 晋级、驳回、下线全部改由 proposalGovernance.js 的受控函数承担
// （测试门禁 → 人工审核 → 人工激活 → 版本记录/回滚，自动路径身份一律拒绝）。
// 提案不再存在绕过治理的直接晋级路径。
