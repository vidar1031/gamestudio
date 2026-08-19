import { GAMESTUDIO_SERVER_BASE_URL } from '../services/gameStudioServerClient.js'

// GameStudio 事件注册表客户端：拉取、缓存、索引。
// 注册表真相源：GameStudio apps/server/events/registry.v1.json（经 /api/events/registry 暴露）。

let cachedRegistry = null
let cachedAt = 0
const CACHE_TTL_MS = 60000

export async function loadGameStudioEventRegistry({ force = false } = {}) {
  if (!force && cachedRegistry && Date.now() - cachedAt < CACHE_TTL_MS) return cachedRegistry
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 10000)
  try {
    const res = await fetch(`${GAMESTUDIO_SERVER_BASE_URL}/api/events/registry`, { signal: controller.signal })
    const payload = await res.json().catch(() => null)
    if (!res.ok || !payload || payload.success !== true || !payload.registry) {
      throw new Error(payload?.error || `gamestudio_registry_http_${res.status}`)
    }
    cachedRegistry = payload.registry
    cachedAt = Date.now()
    return cachedRegistry
  } finally {
    clearTimeout(timeout)
  }
}

export function indexGameStudioEventRegistry(registry) {
  const byEventId = new Map()
  const byCode = new Map()
  const byAlias = new Map()
  for (const event of registry?.events || []) {
    byEventId.set(String(event.eventId || '').toLowerCase(), event)
    if (event.code) byCode.set(String(event.code).toLowerCase(), event)
    for (const alias of event.aliases || []) {
      byAlias.set(String(alias).toLowerCase(), event)
    }
  }
  return { byEventId, byCode, byAlias }
}

// 解析聊天/测试用例中的事件引用：支持全限定名（gamestudio.project.create）、
// eventId（project.create）、短编号（GS-02）、中文别名（创建故事）。
export function resolveGameStudioEventRef(index, ref) {
  const raw = String(ref || '').trim()
  if (!raw) return null
  let key = raw.toLowerCase()
  if (key.startsWith('gamestudio.')) key = key.slice('gamestudio.'.length)
  return index.byEventId.get(key) || index.byCode.get(key) || index.byAlias.get(key) || null
}
