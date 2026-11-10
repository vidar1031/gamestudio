import { diagnoseOpenAI, getOpenAIConfigPublic } from './openai.js'
import { getProxyInfo } from '../net/proxy.js'
import { getEffectiveStudioConfig } from '../studio/settings.js'

const state = {
  lastCheckedAt: null,
  lastOk: null,
  lastResult: null
}

function nowIso() {
  try { return new Date().toISOString() } catch (_) { return String(Date.now()) }
}

export async function getAiStatusSnapshot(storageRoot) {
  const provider = String(process.env.STUDIO_AI_PROVIDER || 'local').toLowerCase()
  const openai = getOpenAIConfigPublic('openai')
  const localoxml = getOpenAIConfigPublic('localoxml')
  const proxy = getProxyInfo()
  let generation = null
  if (storageRoot) {
    try {
      const { settings, effective } = await getEffectiveStudioConfig(storageRoot)
      if (settings) {
        generation = {
          enabled: effective.enabled || null,
          ...Object.fromEntries(['scripts', 'prompt', 'translation'].map((key) => [key, {
            provider: effective[key]?.provider || null,
            model: effective[key]?.model || null
          }]))
        }
      }
    } catch { /* 配置不可读时明确 settingsLoaded=false，不伪造生效模型 */ }
  }
  return {
    provider,
    openai,
    localoxml,
    settingsLoaded: Boolean(generation),
    generation,
    effective: generation ? { enabled: generation.enabled } : undefined,
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
