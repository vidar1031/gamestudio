/**
 * Web Tools Service - 为 Control reasoning pipeline 提供 Web 搜索和网页提取能力。
 *
 * 支持后端（按优先级）：
 * 1. Tavily (TAVILY_API_KEY)
 * 2. Brave Search (BRAVE_SEARCH_API_KEY)
 * 3. DuckDuckGo (无需 API key，但稳定性较低)
 *
 * 设计原则：
 * - 与 Hermes Python 框架的 web_tools.py 能力对齐
 * - 纯 Node.js 实现，不依赖 Python 子进程
 * - 结果标准化为统一格式，便于 reasoning artifacts 消费
 */

const MAX_SEARCH_LIMIT = 20
const SEARCH_TIMEOUT_MS = 15000
const EXTRACT_TIMEOUT_MS = 20000

function getEnv(key) {
  return String(process.env[key] || '').trim()
}

function detectSearchBackend() {
  if (getEnv('TAVILY_API_KEY')) return { provider: 'tavily', apiKey: getEnv('TAVILY_API_KEY') }
  if (getEnv('BRAVE_SEARCH_API_KEY')) return { provider: 'brave', apiKey: getEnv('BRAVE_SEARCH_API_KEY') }
  return { provider: 'ddgs', apiKey: '' }
}

async function fetchWithTimeout(url, options = {}, timeoutMs = SEARCH_TIMEOUT_MS) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(url, { ...options, signal: controller.signal })
    return response
  } finally {
    clearTimeout(timer)
  }
}

// ─── Tavily Backend ─────────────────────────────────────────────────────────

async function tavilySearch({ query, limit = 5, searchDepth = 'basic' }) {
  const apiKey = getEnv('TAVILY_API_KEY')
  if (!apiKey) throw new Error('TAVILY_API_KEY not set')

  const response = await fetchWithTimeout(
    'https://api.tavily.com/search',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        query,
        max_results: Math.min(Math.max(1, Number(limit) || 5), MAX_SEARCH_LIMIT),
        search_depth: searchDepth,
        include_answer: false,
        include_raw_content: false,
        include_images: false
      })
    },
    SEARCH_TIMEOUT_MS
  )

  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new Error(`tavily_search_http_${response.status}: ${text.slice(0, 400)}`)
  }

  const payload = await response.json()
  const results = Array.isArray(payload?.results) ? payload.results : []

  return {
    provider: 'tavily',
    query,
    limit: Math.min(Math.max(1, Number(limit) || 5), MAX_SEARCH_LIMIT),
    results: results.map((r) => ({
      title: String(r.title || ''),
      url: String(r.url || ''),
      snippet: String(r.content || ''),
      score: Number(r.score) || null
    }))
  }
}

async function tavilyExtract({ urls }) {
  const apiKey = getEnv('TAVILY_API_KEY')
  if (!apiKey) throw new Error('TAVILY_API_KEY not set')

  const urlList = Array.isArray(urls) ? urls : [urls]
  if (urlList.length === 0) throw new Error('extract_urls_empty')

  const response = await fetchWithTimeout(
    'https://api.tavily.com/extract',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ urls: urlList.slice(0, 5), include_images: false })
    },
    EXTRACT_TIMEOUT_MS
  )

  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new Error(`tavily_extract_http_${response.status}: ${text.slice(0, 400)}`)
  }

  const payload = await response.json()
  const results = Array.isArray(payload?.results) ? payload.results : []

  return {
    provider: 'tavily',
    urls: urlList.slice(0, 5),
    results: results.map((r) => ({
      url: String(r.url || ''),
      title: String(r.title || ''),
      content: String(r.raw_content || r.content || ''),
      success: Boolean(r.success !== false)
    }))
  }
}

// ─── Brave Backend ──────────────────────────────────────────────────────────

async function braveSearch({ query, limit = 5 }) {
  const apiKey = getEnv('BRAVE_SEARCH_API_KEY')
  if (!apiKey) throw new Error('BRAVE_SEARCH_API_KEY not set')

  const params = new URLSearchParams({
    q: query,
    count: String(Math.min(Math.max(1, Number(limit) || 5), MAX_SEARCH_LIMIT))
  })

  const response = await fetchWithTimeout(
    `https://api.search.brave.com/res/v1/web/search?${params.toString()}`,
    {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        'X-Subscription-Token': apiKey
      }
    },
    SEARCH_TIMEOUT_MS
  )

  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new Error(`brave_search_http_${response.status}: ${text.slice(0, 400)}`)
  }

  const payload = await response.json()
  const webResults = Array.isArray(payload?.web?.results) ? payload.web.results : []

  return {
    provider: 'brave',
    query,
    limit: Math.min(Math.max(1, Number(limit) || 5), MAX_SEARCH_LIMIT),
    results: webResults.map((r) => ({
      title: String(r.title || ''),
      url: String(r.url || ''),
      snippet: String(r.description || ''),
      score: null
    }))
  }
}

async function braveExtract({ urls }) {
  // Brave 没有独立的 extract API，fallback 到 fetch + html-to-text
  return genericFetchExtract({ urls })
}

// ─── Generic Fallback (fetch + simple html strip) ──────────────────────────

async function genericFetchExtract({ urls }) {
  const urlList = Array.isArray(urls) ? urls : [urls]
  if (urlList.length === 0) throw new Error('extract_urls_empty')

  const results = []
  for (const url of urlList.slice(0, 5)) {
    try {
      const response = await fetchWithTimeout(url, { method: 'GET' }, EXTRACT_TIMEOUT_MS)
      if (!response.ok) {
        results.push({ url, title: '', content: `HTTP ${response.status}`, success: false })
        continue
      }
      const html = await response.text()
      const titleMatch = html.match(/<title[^>]*>([^<]*)<\/title>/i)
      const title = titleMatch ? titleMatch[1].trim() : ''
      const text = htmlToPlainText(html)
      results.push({ url, title, content: text.slice(0, 8000), success: true })
    } catch (err) {
      results.push({ url, title: '', content: err instanceof Error ? err.message : String(err), success: false })
    }
  }

  return { provider: 'generic', urls: urlList.slice(0, 5), results }
}

function htmlToPlainText(html) {
  return html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, '')
    .replace(/<header[^>]*>[\s\S]*?<\/header>/gi, '')
    .replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim()
}

// ─── DuckDuckGo Backend (no API key) ───────────────────────────────────────

async function ddgsSearch({ query, limit = 5 }) {
  // DuckDuckGo HTML 端点不稳定，fallback 到 generic 并标记
  return {
    provider: 'ddgs',
    query,
    limit: Math.min(Math.max(1, Number(limit) || 5), MAX_SEARCH_LIMIT),
    results: [],
    error: 'DuckDuckGo backend not implemented in Node.js. Please set TAVILY_API_KEY or BRAVE_SEARCH_API_KEY for reliable web search.'
  }
}

// ─── Public API ─────────────────────────────────────────────────────────────

export async function performWebSearch({ query, limit = 5 }) {
  const backend = detectSearchBackend()
  if (backend.provider === 'tavily') {
    return tavilySearch({ query, limit })
  }
  if (backend.provider === 'brave') {
    return braveSearch({ query, limit })
  }
  return ddgsSearch({ query, limit })
}

export async function performWebExtract({ urls }) {
  const backend = detectSearchBackend()
  if (backend.provider === 'tavily') {
    return tavilyExtract({ urls })
  }
  if (backend.provider === 'brave') {
    return braveExtract({ urls })
  }
  return genericFetchExtract({ urls })
}

export function getWebToolsStatus() {
  const backend = detectSearchBackend()
  return {
    searchAvailable: backend.provider !== 'ddgs',
    extractAvailable: backend.provider !== 'ddgs',
    provider: backend.provider,
    detail: backend.provider === 'ddgs'
      ? '未配置 TAVILY_API_KEY 或 BRAVE_SEARCH_API_KEY，Web 搜索不可用。'
      : `已配置 ${backend.provider} 搜索后端。`
  }
}
