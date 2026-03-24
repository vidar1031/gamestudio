import { diagnoseOpenAI, getOpenAIConfigPublic } from './openai.js'
import { getProxyInfo } from '../net/proxy.js'

const state = {
  lastCheckedAt: null,
  lastOk: null,
  lastResult: null
}

function nowIso() {
  try { return new Date().toISOString() } catch (_) { return String(Date.now()) }
}

export function getAiStatusSnapshot() {
  const provider = String(process.env.STUDIO_AI_PROVIDER || 'local').toLowerCase()
  const openai = getOpenAIConfigPublic('openai')
  const localoxml = getOpenAIConfigPublic('localoxml')
  const proxy = getProxyInfo()
  return {
    provider,
    openai,
    localoxml,
    proxy,
    diagnostics: {
      lastCheckedAt: state.lastCheckedAt,
      lastOk: state.lastOk,
      lastResult: state.lastResult
    }
  }
}

export async function runAiDiagnostics({ force } = {}) {
  const provider = String(process.env.STUDIO_AI_PROVIDER || 'local').toLowerCase()
  const cfg = getOpenAIConfigPublic(provider === 'localoxml' ? 'localoxml' : 'openai')

  // Cache within a short window unless forced.
  const last = state.lastResult
  if (!force && last && state.lastCheckedAt) {
    const ageMs = Math.max(0, Date.now() - Date.parse(state.lastCheckedAt))
    if (Number.isFinite(ageMs) && ageMs < 60_000) return last
  }

  state.lastCheckedAt = nowIso()
  state.lastOk = null
  state.lastResult = null

  if (provider !== 'openai' && provider !== 'localoxml') {
    const res = { ok: true, provider, note: 'provider_not_openai' }
    state.lastOk = true
    state.lastResult = res
    return res
  }

  if (!cfg.keyPresent) {
    const res = {
      ok: false,
      provider,
      error: { message: 'missing_openai_api_key' }
    }
    state.lastOk = false
    state.lastResult = res
    return res
  }

  const res = await diagnoseOpenAI({ provider })
  state.lastOk = Boolean(res && res.ok)
  state.lastResult = res
  return res
}
