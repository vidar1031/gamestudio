import {
  type NodeV1
} from '../../../api'

export function uid(prefix = 'id') {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}`
}

export function nodeKindLabel(kind: NodeV1['kind']) {
  return '场景'
}

export function scriptCardLabel(sc: any) {
  const order = Number(sc && sc.order) || 0
  const name = String(sc && sc.name || '').trim()
  if (order && name) return `#${order} ${name}`
  if (name) return name
  if (order) return `#${order}`
  return ''
}

export function clamp01(n: number) {
  if (!Number.isFinite(n)) return 0
  return Math.max(0, Math.min(1, n))
}

export function numberOr(v: unknown, fallback: number) {
  const n = Number(v)
  return Number.isFinite(n) ? n : fallback
}

export function resolveAsset(uri: string, assetBase: string) {
  const s = String(uri || '').trim()
  if (!s) return ''
  if (/^https?:\/\//i.test(s)) return s
  if (/^\//.test(s) && /^https?:\/\//i.test(assetBase || '')) {
    try {
      const origin = new URL(assetBase).origin
      return `${origin}${s}`
    } catch {}
  }
  if (!assetBase) return s
  return assetBase.replace(/\/+$/, '/') + s.replace(/^\/+/, '')
}

export function buildNodeTextSummary(textRaw: string) {
    const lines = String(textRaw || '')
      .split(/\r?\n/)
      .map((x) => x.trim())
      .filter(Boolean)
    const picked: string[] = []
    for (const ln of lines) {
      if (/^选项(?:\d{1,2}|[A-Z])\s*[:：]/i.test(ln)) break
      picked.push(ln)
      if (picked.length >= 8) break
    }
    return picked.join('，').replace(/\s+/g, ' ').trim()
  }

export function nowHms() {
    try {
      return new Date().toLocaleTimeString()
    } catch {
      return String(Date.now())
    }
  }

