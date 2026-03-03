// Minimal local test for scripts (story cards) generation via Ollama.
// Usage:
//   STUDIO_AI_PROVIDER=ollama node apps/server/scripts/test_ollama_scripts.mjs "一个在月球垃圾场捡到会说话的机器人"
//
// Env (in .env.local at repo root):
//   STUDIO_AI_PROVIDER=ollama
//   STUDIO_OLLAMA_URL=http://127.0.0.1:11434
//   STUDIO_OLLAMA_MODEL=qwen3:8b

import { loadEnv } from '../src/env.js'
import { generateScriptDraft } from '../src/ai/scripts.js'

loadEnv({ startDirs: [process.cwd()], maxHops: 2 })

const prompt = String(process.argv.slice(2).join(' ') || '').trim()
if (!prompt) {
  console.error('Missing prompt. Example:')
  console.error('  STUDIO_AI_PROVIDER=ollama node apps/server/scripts/test_ollama_scripts.mjs "一个在月球垃圾场捡到会说话的机器人"')
  process.exit(1)
}

process.env.STUDIO_AI_PROVIDER = process.env.STUDIO_AI_PROVIDER || 'ollama'

const startedAt = Date.now()
const gen = await generateScriptDraft({
  prompt,
  title: '',
  rules: null,
  formula: { schemaVersion: '1.0', format: 'numeric', choicePoints: 2, optionsPerChoice: 2, endings: 2 }
})

console.log('[ok] provider=', gen?.meta?.provider || 'unknown', 'model=', gen?.meta?.model || '-', 'ms=', Date.now() - startedAt)
console.log(JSON.stringify(gen?.draft || null, null, 2))
