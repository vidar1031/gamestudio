// Load JSON intent definitions from config/hermes/intents/*.json
// at server startup. Inbox files (config/hermes/intents/_inbox/*.json)
// are NOT auto-loaded — they wait for human / agent promotion.

import fs from 'node:fs'
import path from 'node:path'
import { HERMES_CONFIG_ROOT } from '../../config/paths.js'
import { compileJsonIntent } from './jsonIntent.js'
import { registerIntent } from './registry.js'

export const INTENTS_DIR = path.join(HERMES_CONFIG_ROOT, 'intents')
export const INTENTS_INBOX_DIR = path.join(INTENTS_DIR, '_inbox')

export function ensureIntentDirs() {
  for (const dir of [INTENTS_DIR, INTENTS_INBOX_DIR]) {
    try {
      fs.mkdirSync(dir, { recursive: true })
    } catch {
      // best effort
    }
  }
}

export function loadActiveJsonIntents() {
  ensureIntentDirs()
  const result = { loaded: 0, errors: [] }
  if (!fs.existsSync(INTENTS_DIR)) return result
  const entries = fs.readdirSync(INTENTS_DIR, { withFileTypes: true })
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue
    const filePath = path.join(INTENTS_DIR, entry.name)
    try {
      const raw = fs.readFileSync(filePath, 'utf8')
      const def = JSON.parse(raw)
      const intent = compileJsonIntent(def)
      registerIntent(intent)
      result.loaded += 1
    } catch (error) {
      result.errors.push({ filePath, error: error instanceof Error ? error.message : String(error) })
    }
  }
  return result
}
