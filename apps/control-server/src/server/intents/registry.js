// Intent registry — single source of truth for prompt-routed
// planning / answering / evaluation handlers.
//
// An intent is a plain object with optional hooks:
//   {
//     id: string,                                  // unique
//     source: 'builtin' | 'json' | 'proposal',     // provenance label
//     description?: string,
//     priority?: number,                           // higher wins on tie
//     // -------- planning ---------
//     matchPlan?(prompt, ctx) -> boolean
//     buildDeterministicPlan?(prompt, ctx) -> plan|null
//     // -------- answering --------
//     matchAnswer?(prompt, artifacts) -> boolean
//     buildDeterministicAnswer?(prompt, artifacts) -> string|null
//     deterministicAnswerReason?: string
//     // -------- evaluation -------
//     matchEvaluation?(prompt, artifacts) -> boolean
//     evaluateAnswer?(prompt, answer, artifacts) -> { score, passed, source, summary, issues, strengths, correctionPrompt }
//   }
//
// Order of registration only matters as a tie-breaker (priority then
// insertion order). Builtin intents register first so JSON / proposal
// intents can override them by reusing the same id.

const intents = []

function compareIntents(left, right) {
  const leftPriority = Number(left.priority || 0)
  const rightPriority = Number(right.priority || 0)
  if (leftPriority !== rightPriority) return rightPriority - leftPriority
  return 0
}

export function registerIntent(intent) {
  if (!intent || typeof intent !== 'object') {
    throw new Error('intent_definition_required')
  }
  const id = String(intent.id || '').trim()
  if (!id) {
    throw new Error('intent_id_required')
  }
  const existingIndex = intents.findIndex((entry) => entry.id === id)
  if (existingIndex >= 0) {
    intents[existingIndex] = intent
  } else {
    intents.push(intent)
  }
  intents.sort(compareIntents)
}

export function unregisterIntent(id) {
  const index = intents.findIndex((entry) => entry.id === id)
  if (index >= 0) intents.splice(index, 1)
}

export function listIntents() {
  return intents.slice()
}

function safeCall(fn, args, fallback) {
  try {
    return fn(...args)
  } catch (error) {
    // Intent matchers must not throw the host pipeline.
    if (process?.env?.DEBUG_INTENTS === '1') {
      console.warn('[intents] matcher threw:', error?.message || error)
    }
    return fallback
  }
}

export function findIntentForPlan(prompt, ctx = {}) {
  for (const intent of intents) {
    if (typeof intent.matchPlan !== 'function') continue
    if (safeCall(intent.matchPlan, [prompt, ctx], false)) return intent
  }
  return null
}

export function findIntentForAnswer(prompt, artifacts = {}) {
  for (const intent of intents) {
    if (typeof intent.matchAnswer !== 'function') continue
    if (safeCall(intent.matchAnswer, [prompt, artifacts], false)) return intent
  }
  return null
}

export function findIntentForEvaluation(prompt, artifacts = {}) {
  for (const intent of intents) {
    if (typeof intent.matchEvaluation !== 'function') continue
    if (safeCall(intent.matchEvaluation, [prompt, artifacts], false)) return intent
  }
  return null
}

export function clearIntents() {
  intents.length = 0
}
