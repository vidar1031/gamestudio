// Bootstrap entry point for the intents subsystem.
//
// `bootstrapIntents()` is invoked once during server startup AFTER
// builtin intents have been registered from controlServerCore.js. It
// loads any JSON intents the operator has placed under
// config/hermes/intents/, then returns a summary the caller can log.

import { listIntents } from './registry.js'
import { ensureIntentDirs, loadActiveJsonIntents } from './loadJsonIntents.js'

export {
  registerIntent,
  unregisterIntent,
  listIntents,
  findIntentForAnswer,
  findIntentForEvaluation,
  findIntentForPlan,
} from './registry.js'

export {
  INTENTS_DIR,
  INTENTS_INBOX_DIR,
  ensureIntentDirs,
  loadActiveJsonIntents,
} from './loadJsonIntents.js'

export function bootstrapIntents() {
  ensureIntentDirs()
  const jsonResult = loadActiveJsonIntents()
  const all = listIntents()
  return {
    total: all.length,
    bySource: all.reduce((acc, intent) => {
      const key = intent.source || 'unknown'
      acc[key] = (acc[key] || 0) + 1
      return acc
    }, {}),
    json: jsonResult
  }
}
