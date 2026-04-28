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
import { registerIntent, unregisterIntent } from './registry.js'
import { INTENTS_DIR, INTENTS_INBOX_DIR, ensureIntentDirs } from './loadJsonIntents.js'

const MAX_RECORDS_SCAN = 1000
const MAX_KEYWORDS_PER_PROPOSAL = 8
const MIN_KEYWORD_LENGTH = 3

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
    const target = path.join(INTENTS_INBOX_DIR, `${proposal.id}.json`)
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
  if (!fs.existsSync(INTENTS_INBOX_DIR)) return []
  const files = fs.readdirSync(INTENTS_INBOX_DIR).filter((name) => name.endsWith('.json'))
  return files.map((file) => {
    const filePath = path.join(INTENTS_INBOX_DIR, file)
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
  if (!fs.existsSync(INTENTS_DIR)) return []
  return fs
    .readdirSync(INTENTS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
    .map((entry) => path.join(INTENTS_DIR, entry.name))
}

function resolveProposalPath(id) {
  const safeId = safeProposalId(id)
  const sourcePath = path.join(INTENTS_INBOX_DIR, `${safeId}.json`)
  if (!sourcePath.startsWith(INTENTS_INBOX_DIR + path.sep) && sourcePath !== INTENTS_INBOX_DIR) {
    throw new Error('proposal_path_invalid')
  }
  return { safeId, sourcePath }
}

export function promoteProposal(id) {
  ensureIntentDirs()
  const { safeId, sourcePath } = resolveProposalPath(id)
  if (!fs.existsSync(sourcePath)) throw new Error('proposal_not_found')
  const raw = fs.readFileSync(sourcePath, 'utf8')
  const def = JSON.parse(raw)
  const intent = compileJsonIntent(def)
  const targetPath = path.join(INTENTS_DIR, `${safeId}.json`)
  fs.writeFileSync(targetPath, raw, 'utf8')
  fs.unlinkSync(sourcePath)
  registerIntent(intent)
  return { id: safeId, activatedPath: targetPath }
}

export function rejectProposal(id) {
  ensureIntentDirs()
  const { safeId, sourcePath } = resolveProposalPath(id)
  if (!fs.existsSync(sourcePath)) throw new Error('proposal_not_found')
  fs.unlinkSync(sourcePath)
  return { id: safeId, removed: true }
}

export function deactivateActiveIntent(id) {
  const safeId = safeProposalId(id)
  const activePath = path.join(INTENTS_DIR, `${safeId}.json`)
  if (!fs.existsSync(activePath)) throw new Error('intent_not_found')
  fs.unlinkSync(activePath)
  unregisterIntent(safeId)
  return { id: safeId, removed: true }
}
