// Load JSON intent definitions from config/hermes/intents/*.json
// at server startup. Inbox files (config/hermes/intents/_inbox/*.json)
// are NOT auto-loaded — they wait for human / agent promotion.

import fs from 'node:fs'
import path from 'node:path'
import { HERMES_CONFIG_ROOT } from '../../config/paths.js'
import { compileJsonIntent } from './jsonIntent.js'
import { registerIntent } from './registry.js'

// AUTO-F02：目录解析改为惰性 getter（HERMES_INTENTS_DIR 可覆盖，测试隔离用）；
// INTENTS_DIR / INTENTS_INBOX_DIR 常量保留导出以兼容既有引用，新代码一律用 getter。
export function getIntentsDir() {
  const override = String(process.env.HERMES_INTENTS_DIR || '').trim()
  return override || path.join(HERMES_CONFIG_ROOT, 'intents')
}

export function getIntentsInboxDir() {
  return path.join(getIntentsDir(), '_inbox')
}

export const INTENTS_DIR = path.join(HERMES_CONFIG_ROOT, 'intents')
export const INTENTS_INBOX_DIR = path.join(INTENTS_DIR, '_inbox')

export function ensureIntentDirs() {
  for (const dir of [getIntentsDir(), getIntentsInboxDir()]) {
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
  const intentsDir = getIntentsDir()
  if (!fs.existsSync(intentsDir)) return result
  const entries = fs.readdirSync(intentsDir, { withFileTypes: true })
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue
    const filePath = path.join(intentsDir, entry.name)
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
