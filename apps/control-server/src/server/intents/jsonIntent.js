// Compile a JSON intent definition into a runtime intent object.
//
// JSON schema (all fields optional unless marked):
//   {
//     "id": "image_service_entrypoint",          // REQUIRED
//     "version": 1,
//     "description": "...",
//     "match": {
//       "anyRegex": ["..."],                      // OR-group
//       "allRegex": ["..."],                      // AND-group
//       "noneRegex": ["..."]                      // negation
//     },
//     "evaluation": {
//       "requireArtifactKey": "imageServiceEntrypoints",
//       "minScore": 70,
//       "scoreBase": 45,
//       "perRequiredHit": 15,
//       "perOptionalHit": 8,
//       "perEvidenceHit": 10,
//       "perForbiddenHit": -25,
//       "mustInclude": ["..."],
//       "optional": ["..."],
//       "evidenceRegex": ["..."],
//       "forbidden": ["..."],
//       "correctionPrompt": "..."
//     }
//   }
//
// We deliberately keep the JSON declarative (data only). Regex sources
// are validated at compile time so a malformed proposal cannot crash
// the host process at runtime.

import { HERMES_REASONING_MIN_ACCEPT_SCORE } from '../../config/constants.js'

const MAX_REGEX_SOURCE_LENGTH = 400
const MAX_LIST_LENGTH = 64

function compileRegexList(list, label) {
  if (!Array.isArray(list)) return []
  if (list.length > MAX_LIST_LENGTH) {
    throw new Error(`intent_${label}_too_long`)
  }
  return list.map((source) => {
    const text = String(source || '')
    if (!text || text.length > MAX_REGEX_SOURCE_LENGTH) {
      throw new Error(`intent_${label}_invalid_regex`)
    }
    return new RegExp(text, 'i')
  })
}

function normalizeStringList(list, label) {
  if (!Array.isArray(list)) return []
  if (list.length > MAX_LIST_LENGTH) {
    throw new Error(`intent_${label}_too_long`)
  }
  return list.map((value) => String(value || '').trim()).filter(Boolean)
}

function matchAny(regs, text) {
  if (regs.length === 0) return true
  return regs.some((regex) => regex.test(text))
}

function matchAll(regs, text) {
  return regs.every((regex) => regex.test(text))
}

function matchNone(regs, text) {
  return regs.every((regex) => !regex.test(text))
}

export function compileJsonIntent(def) {
  if (!def || typeof def !== 'object') {
    throw new Error('intent_def_invalid')
  }
  const id = String(def.id || '').trim()
  if (!id || !/^[A-Za-z0-9_.\-]+$/.test(id)) {
    throw new Error('intent_id_invalid')
  }

  const matchAnyRegs = compileRegexList(def?.match?.anyRegex, 'match.anyRegex')
  const matchAllRegs = compileRegexList(def?.match?.allRegex, 'match.allRegex')
  const matchNoneRegs = compileRegexList(def?.match?.noneRegex, 'match.noneRegex')

  if (matchAnyRegs.length === 0 && matchAllRegs.length === 0) {
    throw new Error('intent_match_empty')
  }

  function matchPrompt(prompt) {
    const text = String(prompt || '')
    if (!text) return false
    if (!matchAny(matchAnyRegs, text)) return false
    if (!matchAll(matchAllRegs, text)) return false
    if (!matchNone(matchNoneRegs, text)) return false
    return true
  }

  const evalCfg = def.evaluation || null
  const requireArtifactKey = String(evalCfg?.requireArtifactKey || '').trim()
  const requiredAll = normalizeStringList(evalCfg?.mustInclude, 'evaluation.mustInclude')
  const optionalAll = normalizeStringList(evalCfg?.optional, 'evaluation.optional')
  const forbiddenAll = normalizeStringList(evalCfg?.forbidden, 'evaluation.forbidden')
  const evidenceRegs = compileRegexList(evalCfg?.evidenceRegex, 'evaluation.evidenceRegex')
  const minScore = Number.isFinite(Number(evalCfg?.minScore))
    ? Math.max(0, Math.min(100, Number(evalCfg?.minScore)))
    : HERMES_REASONING_MIN_ACCEPT_SCORE
  const scoreBase = Number.isFinite(Number(evalCfg?.scoreBase)) ? Number(evalCfg.scoreBase) : 45
  const perRequired = Number.isFinite(Number(evalCfg?.perRequiredHit)) ? Number(evalCfg.perRequiredHit) : 15
  const perOptional = Number.isFinite(Number(evalCfg?.perOptionalHit)) ? Number(evalCfg.perOptionalHit) : 8
  const perEvidence = Number.isFinite(Number(evalCfg?.perEvidenceHit)) ? Number(evalCfg.perEvidenceHit) : 10
  const perForbidden = Number.isFinite(Number(evalCfg?.perForbiddenHit)) ? Number(evalCfg.perForbiddenHit) : -25
  const correctionPromptText = String(evalCfg?.correctionPrompt || '').trim()
    || '请严格基于当前 observable artifacts 修正答案，不要引入仓库外路径或工具。'

  const hasEvaluation = Boolean(evalCfg)

  function artifactPresent(artifacts) {
    if (!requireArtifactKey) return true
    if (!artifacts || typeof artifacts !== 'object') return false
    return Boolean(artifacts[requireArtifactKey])
  }

  function evaluateAnswer(prompt, answer /* , artifacts */) {
    const text = String(answer || '')
    const lower = text.toLowerCase()
    let score = scoreBase
    const strengths = []
    const issues = []

    for (const needle of requiredAll) {
      if (lower.includes(needle.toLowerCase())) {
        score += perRequired
        strengths.push(`命中必备项 ${needle}`)
      } else {
        issues.push(`缺少必备项 ${needle}`)
      }
    }
    for (const needle of optionalAll) {
      if (lower.includes(needle.toLowerCase())) {
        score += perOptional
        strengths.push(`命中可选项 ${needle}`)
      }
    }
    for (const regex of evidenceRegs) {
      if (regex.test(text)) {
        score += perEvidence
        strengths.push(`命中证据正则 ${regex}`)
      } else {
        issues.push(`缺少证据正则 ${regex}`)
      }
    }
    for (const needle of forbiddenAll) {
      if (lower.includes(needle.toLowerCase())) {
        score += perForbidden
        issues.push(`出现禁词 ${needle}`)
      }
    }

    score = Math.max(0, Math.min(100, score))
    const passed = score >= minScore
    return {
      score,
      passed,
      source: 'json-intent',
      summary: passed
        ? `JSON intent ${id} 评分 ${score}/100，已通过。`
        : `JSON intent ${id} 评分 ${score}/100，未达 ${minScore} 分。`,
      strengths,
      issues,
      correctionPrompt: passed ? '当前答案已通过质量门槛。' : correctionPromptText
    }
  }

  return {
    id,
    source: def.source || 'json',
    description: String(def.description || '').slice(0, 280),
    priority: Number(def.priority || 0),
    rawDef: def,
    matchEvaluation: hasEvaluation
      ? (prompt, artifacts) => matchPrompt(prompt) && artifactPresent(artifacts)
      : null,
    evaluateAnswer: hasEvaluation ? evaluateAnswer : null
  }
}
