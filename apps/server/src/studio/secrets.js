// In-memory secret store used to avoid leaking API keys to the editor UI.
// Sources:
// - studio_settings.json (preferred)
// - process.env fallback (legacy)

const state = {
  openaiApiKey: '',
  localoxmlApiKey: '',
  doubaoArkApiKey: '',
  updatedAt: null
}

function normalizeSecret(v) {
  const s = String(v || '').trim()
  if (!s) return ''
  // Keep it strict-ish: avoid accidental multi-line values.
  return s.replace(/\r?\n/g, '').slice(0, 512)
}

function maskKey(v) {
  const s = normalizeSecret(v)
  if (!s) return null
  const tail = s.slice(-4)
  return `****${tail}`
}

export function setStudioSecrets(next) {
  const obj = next && typeof next === 'object' ? next : {}
  state.openaiApiKey = normalizeSecret(obj.openaiApiKey)
  state.localoxmlApiKey = normalizeSecret(obj.localoxmlApiKey)
  state.doubaoArkApiKey = normalizeSecret(obj.doubaoArkApiKey)
  try { state.updatedAt = new Date().toISOString() } catch (_) { state.updatedAt = String(Date.now()) }
}

export function getStudioSecret(provider) {
  const p = String(provider || '').trim().toLowerCase()
  if (p === 'openai') return state.openaiApiKey
  if (p === 'localoxml') return state.localoxmlApiKey
  if (p === 'doubao') return state.doubaoArkApiKey
  return ''
}

export function getStudioSecretsPublicSnapshot() {
  const openai = state.openaiApiKey
  const localoxml = state.localoxmlApiKey
  const doubao = state.doubaoArkApiKey
  return {
    updatedAt: state.updatedAt,
    openai: { present: Boolean(openai), masked: maskKey(openai) },
    localoxml: { present: Boolean(localoxml), masked: maskKey(localoxml) },
    doubao: { present: Boolean(doubao), masked: maskKey(doubao) }
  }
}

