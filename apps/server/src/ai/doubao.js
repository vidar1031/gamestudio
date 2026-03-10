import { spawn } from 'node:child_process'
import { getProxyUrl } from '../net/proxy.js'

/*
  apps/server/src/ai/doubao.js

  说明：与“豆包/Volcengine Ark”相关的封装与适配代码。
  提供两类能力：
  - 文生图（Images API）与图像下载支持（generateImageViaDoubaoArkImages）
  - 文本/对话型 LLM 接口适配（generateStrictJsonViaDoubaoChat / generateScriptsViaDoubao / repairScriptsViaDoubao / generateBackgroundPromptViaDoubao）

  该文件包含若干工具函数用于：字符串规范化、尺寸解析与调整、调用远端 API（通过本地 curl 子进程）
  并对返回进行容错解析（提取 url / base64 / message content 等）。
*/

function clampInt(n, min, max, fallback) {
  const v = Number(n)
  if (!Number.isFinite(v)) return fallback
  return Math.max(min, Math.min(max, Math.floor(v)))
}

function clampFloat(n, min, max, fallback) {
  const v = Number(n)
  if (!Number.isFinite(v)) return fallback
  return Math.max(min, Math.min(max, v))
}

// clampInt/clampFloat: 用于限制输入数值的范围并提供回退值，常用于宽高、超时、步数等参数。

function normalizeArkImagesUrl(raw) {
  return String(raw || 'https://ark.cn-beijing.volces.com/api/v3/images/generations')
    .trim()
    .replace(/\/+$/, '')
    .replace(/\/api\/v3\/predict$/i, '/api/v3/images/generations')
}

function normalizeArkChatUrl(raw) {
  return String(raw || 'https://ark.cn-beijing.volces.com/api/v3/chat/completions')
    .trim()
    .replace(/\/+$/, '')
    .replace(/\/api\/v3\/predict$/i, '/api/v3/chat/completions')
}

// 规范化 Ark API 的 base URL，接受环境变量或用户传入的 url，并确保使用预期的 path。

const ARK_MIN_SHORT_SIDE = 720
const ARK_MIN_LONG_SIDE = 1280
const ARK_MIN_PIXELS = 3_686_400

function parseSizeWxH(size) {
  const s = String(size || '').trim().toLowerCase()
  const m = s.match(/^(\d{2,5})x(\d{2,5})$/)
  if (!m) return null
  const w = Number(m[1])
  const h = Number(m[2])
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return null
  return { w: Math.floor(w), h: Math.floor(h) }
}

function roundTo(n, step) {
  const v = Number(n)
  const st = Math.max(1, Math.floor(Number(step) || 1))
  if (!Number.isFinite(v)) return null
  return Math.max(st, Math.round(v / st) * st)
}

function ensureMinSides({ w, h }, { minShort, minLong }) {
  const ww = Math.max(1, Math.floor(Number(w) || 1))
  const hh = Math.max(1, Math.floor(Number(h) || 1))
  const long0 = Math.max(ww, hh)
  const short0 = Math.min(ww, hh)
  const minL = Math.max(1, Math.floor(Number(minLong) || 1))
  const minS = Math.max(1, Math.floor(Number(minShort) || 1))
  if (long0 >= minL && short0 >= minS) return { w: ww, h: hh, scaled: false, reason: '' }
  const scale = Math.max(minL / long0, minS / short0)
  const w2 = roundTo(Math.ceil(ww * scale), 64) || ww
  const h2 = roundTo(Math.ceil(hh * scale), 64) || hh
  return { w: w2, h: h2, scaled: true, reason: `minLong=${minL} minShort=${minS}` }
}

function ensureMinImageConstraints({ w, h }, { minShort, minLong, minPixels }) {
  const ww = Math.max(1, Math.floor(Number(w) || 1))
  const hh = Math.max(1, Math.floor(Number(h) || 1))
  const minPx = Math.max(1, Math.floor(Number(minPixels) || 1))
  const base = ensureMinSides({ w: ww, h: hh }, { minShort, minLong })
  let w2 = base.w
  let h2 = base.h
  let scaled = Boolean(base.scaled)
  const area = w2 * h2
  if (area < minPx) {
    const scale = Math.sqrt(minPx / Math.max(1, area))
    w2 = roundTo(Math.ceil(w2 * scale), 64) || w2
    h2 = roundTo(Math.ceil(h2 * scale), 64) || h2
    scaled = true
    return { w: w2, h: h2, scaled, reason: `${base.reason || 'minSides'} minPixels=${minPx}`.trim() }
  }
  return { w: w2, h: h2, scaled, reason: base.reason || '' }
}

export function getDoubaoImagesConfigSnapshot() {
  const apiUrl = normalizeArkImagesUrl(
    process.env.DOUBAO_ARK_IMAGES_URL || process.env.DOUBAO_ARK_API_URL || 'https://ark.cn-beijing.volces.com/api/v3/images/generations'
  )
  const model = String(process.env.DOUBAO_ARK_MODEL || 'doubao-seedream-4-0-250828').trim()
  const apiKeyPresent = Boolean(String(process.env.DOUBAO_ARK_API_KEY || process.env.ARK_API_KEY || process.env.DOUBAO_API_KEY || '').trim())
  const authHeaderPresent = Boolean(String(process.env.DOUBAO_ARK_AUTH_HEADER || process.env.DOUBAO_AUTH_HEADER || '').trim())
  const authMode = authHeaderPresent ? 'custom_header' : apiKeyPresent ? 'bearer' : 'missing'
  return { apiUrl, model, authMode }
}

export function getDoubaoTextConfigSnapshot() {
  const apiUrl = normalizeArkChatUrl(
    process.env.DOUBAO_ARK_CHAT_URL ||
      process.env.DOUBAO_ARK_TEXT_URL ||
      'https://ark.cn-beijing.volces.com/api/v3/chat/completions'
  )
  const model = String(
    process.env.DOUBAO_ARK_TEXT_MODEL ||
      process.env.DOUBAO_ARK_LLM_MODEL ||
      process.env.DOUBAO_LLM_MODEL ||
      'doubao-1-5-pro-32k-250115'
  ).trim()
  const apiKeyPresent = Boolean(String(process.env.DOUBAO_ARK_API_KEY || process.env.ARK_API_KEY || process.env.DOUBAO_API_KEY || '').trim())
  const authHeaderPresent = Boolean(String(process.env.DOUBAO_ARK_AUTH_HEADER || process.env.DOUBAO_AUTH_HEADER || '').trim())
  const authMode = authHeaderPresent ? 'custom_header' : apiKeyPresent ? 'bearer' : 'missing'
  return { apiUrl, model, authMode }
}

// getDoubaoImagesConfigSnapshot / getDoubaoTextConfigSnapshot:
// 从环境变量读取当前的 API URL / model / 验证配置，用于上层展示或运行时决策。

function curlRequestJson({ url, method, headers, body, timeoutMs, proxyUrl }) {
  // 使用本地 `curl` 发起 HTTP 请求并解析 JSON 响应。
  // 行为与 `background.js` 中的 curlRequestJson 类似：输出带有状态码 marker，解析并在非 2xx 时抛出带 status 的 Error。
  const marker = '__CURL_STATUS__'
  const args = [
    '-sS',
    '-X',
    String(method || 'POST').toUpperCase(),
    '--max-time',
    String(Math.max(1, Math.ceil((Number(timeoutMs || 0) || 20000) / 1000))),
    ...(proxyUrl ? ['--proxy', String(proxyUrl)] : []),
    '-w',
    `\\n${marker}:%{http_code}\\n`,
    ...Object.entries(headers || {}).flatMap(([k, v]) => ['-H', `${k}: ${v}`])
  ]
  if (body != null) args.push('--data-binary', '@-')
  args.push(String(url))

  return new Promise((resolve, reject) => {
    const p = spawn('curl', args, { stdio: ['pipe', 'pipe', 'pipe'] })
    const chunks = []
    const errChunks = []

    const killTimer = setTimeout(() => {
      try { p.kill('SIGKILL') } catch (_) {}
    }, Math.max(1000, Number(timeoutMs || 0) || 20000) + 1000)

    p.stdout.on('data', (d) => chunks.push(d))
    p.stderr.on('data', (d) => errChunks.push(d))
    p.on('error', (e) => {
      clearTimeout(killTimer)
      reject(e)
    })
    p.on('close', (code) => {
      clearTimeout(killTimer)
      const out = Buffer.concat(chunks).toString('utf-8')
      const errText = Buffer.concat(errChunks).toString('utf-8')
      const idx = out.lastIndexOf(`${marker}:`)
      const statusStr = idx >= 0 ? out.slice(idx + marker.length + 1).trim().split(/\s+/)[0] : ''
      const status = statusStr ? Number(statusStr) : NaN
      const jsonText = idx >= 0 ? out.slice(0, idx).trim() : out.trim()

      if (!Number.isFinite(status)) {
        const e = new Error(`curl_no_status${errText ? `: ${errText.trim()}` : ''}`)
        e.code = code
        reject(e)
        return
      }
      if (status === 0) {
        const e = new Error(errText && errText.trim() ? `curl_transport_error: ${errText.trim()}` : 'curl_transport_error')
        e.status = 0
        e.code = code
        reject(e)
        return
      }
      let json = null
      try {
        json = jsonText ? JSON.parse(jsonText) : null
      } catch (e) {
        const err = new Error('invalid_json_response')
        err.status = status
        err.body = jsonText
        reject(err)
        return
      }
      if (status < 200 || status >= 300) {
        const msg =
          json && typeof json === 'object'
            ? (json.error && (json.error.message || json.error)) || json.message || JSON.stringify(json)
            : `HTTP ${status}`
        const e = new Error(String(msg))
        e.status = status
        e.body = json
        reject(e)
        return
      }
      resolve(json)
    })

    if (body != null) {
      try {
        p.stdin.write(typeof body === 'string' ? body : JSON.stringify(body))
      } catch (_) {}
    }
    try { p.stdin.end() } catch (_) {}
  })
}

function extractFirstUrl(json) {
  try {
    const data = json && typeof json === 'object' ? json.data : null
    if (data && typeof data === 'object') {
      const u1 = Array.isArray(data.image_urls) ? data.image_urls.map(String).find(Boolean) : ''
      if (u1) return u1
      const u2 = Array.isArray(data.images) ? data.images.map((x) => (x && x.url ? String(x.url) : '')).find(Boolean) : ''
      if (u2) return u2
      if (typeof data.url === 'string' && data.url.trim()) return data.url.trim()
    }
  } catch (_) {}

  // fallback: deep scan (bounded)
  const stack = [{ v: json, depth: 0 }]
  while (stack.length) {
    const { v, depth } = stack.pop()
    if (depth > 4) continue
    if (!v) continue
    if (typeof v === 'string') {
      const s = v.trim()
      if (/^https?:\/\//i.test(s)) return s
      continue
    }
    if (Array.isArray(v)) {
      for (const it of v) stack.push({ v: it, depth: depth + 1 })
      continue
    }
    if (typeof v === 'object') {
      for (const it of Object.values(v)) stack.push({ v: it, depth: depth + 1 })
    }
  }
  return ''
}

function extractFirstBase64(json) {
  try {
    const data = json && typeof json === 'object' ? json.data : null
    if (data && typeof data === 'object') {
      const arr = Array.isArray(data.binary_data_base64) ? data.binary_data_base64 : null
      if (arr && arr.length && String(arr[0] || '').trim()) return String(arr[0]).trim()
    }
  } catch (_) {}
  return ''
}

function extractChatContent(json) {
  try {
    const choices = json && typeof json === 'object' ? json.choices : null
    const c0 = Array.isArray(choices) ? choices[0] : null
    const msg = c0 && typeof c0 === 'object' ? c0.message : null
    const content = msg && typeof msg === 'object' ? msg.content : null
    if (typeof content === 'string') return content.trim()
  } catch (_) {}
  return ''
}

function stripJsonCodeFence(s) {
  const raw = String(s || '').trim()
  if (!raw) return ''
  const fenced = raw.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)
  return fenced ? String(fenced[1] || '').trim() : raw
}

// 工具函数：从 API 返回中提取第一张图片的 URL / base64，或从 chat/completions 中提取 message 内容。
// stripJsonCodeFence: 如果输出包含 ```json ``` 代码块，则剥离代码围栏，返回内部文本，便于 JSON.parse。

function scriptDraftSchemaForValidation() {
  return {
    title: (v) => v == null || typeof v === 'string',
    cards: (arr) =>
      Array.isArray(arr) &&
      arr.length >= 3 &&
      arr.length <= 20 &&
      arr.every((c) => c && typeof c === 'object' && typeof c.name === 'string' && c.name.trim() && typeof c.text === 'string' && c.text.trim())
  }
}

function validateScriptDraft(draft) {
  const sch = scriptDraftSchemaForValidation()
  if (!draft || typeof draft !== 'object') return { ok: false, reason: 'not_object' }
  if (!('title' in draft) || !sch.title(draft.title)) return { ok: false, reason: 'invalid_title' }
  if (!('cards' in draft) || !sch.cards(draft.cards)) return { ok: false, reason: 'invalid_cards' }
  return { ok: true, reason: 'ok' }
}

function backgroundPromptSchemaForValidation() {
  const arOk = (x) => x === '9:16' || x === '16:9' || x === '1:1' || x === '9:1'
  const stOk = (x) => x === 'picture_book' || x === 'cartoon' || x === 'national_style' || x === 'watercolor'
  return {
    globalPrompt: (x) => x == null || typeof x === 'string',
    globalNegativePrompt: (x) => x == null || typeof x === 'string',
    scenePrompt: (x) => typeof x === 'string' && x.trim(),
    sceneNegativePrompt: (x) => x == null || typeof x === 'string',
    prompt: (x) => typeof x === 'string' && x.trim(),
    negativePrompt: (x) => x == null || typeof x === 'string',
    aspectRatio: (x) => typeof x === 'string' && arOk(x),
    style: (x) => typeof x === 'string' && stOk(x)
  }
}

function validateBackgroundPrompt(obj) {
  const sch = backgroundPromptSchemaForValidation()
  if (!obj || typeof obj !== 'object') return { ok: false, reason: 'not_object' }
  for (const [k, fn] of Object.entries(sch)) {
    if (!(k in obj) || !fn(obj[k])) return { ok: false, reason: `invalid_${k}` }
  }
  return { ok: true, reason: 'ok' }
}

// validateScriptDraft / validateBackgroundPrompt: 基于简单 schema 的轻量校验函数，
// 在调用生成/修复接口前验证 AI 输出是否满足最小结构要求。

async function doubaoChatCompletionsJson({ messages, model, temperature, timeoutMs, proxyUrl }) {
  const { apiUrl } = getDoubaoTextConfigSnapshot()

  const apiKey =
    String(process.env.DOUBAO_ARK_API_KEY || '').trim() ||
    String(process.env.ARK_API_KEY || '').trim() ||
    String(process.env.DOUBAO_API_KEY || '').trim()
  const authHeaderLine = String(process.env.DOUBAO_ARK_AUTH_HEADER || process.env.DOUBAO_AUTH_HEADER || '').trim()
  if (!apiKey && !authHeaderLine) {
    const e = new Error('doubao_not_configured: missing DOUBAO_ARK_API_KEY (Authorization: Bearer ...)')
    e.status = 501
    throw e
  }

  const headers = { 'Content-Type': 'application/json' }
  if (authHeaderLine) {
    const idx = authHeaderLine.indexOf(':')
    if (idx > 0) headers[authHeaderLine.slice(0, idx).trim()] = authHeaderLine.slice(idx + 1).trim()
  } else {
    headers.Authorization = `Bearer ${apiKey}`
  }

  const useModel = String(
    model ||
      process.env.DOUBAO_ARK_TEXT_MODEL ||
      process.env.DOUBAO_ARK_LLM_MODEL ||
      process.env.DOUBAO_LLM_MODEL ||
      'doubao-1-5-pro-32k-250115'
  ).trim()
  const payload = {
    model: useModel,
    messages: Array.isArray(messages) ? messages : [],
    temperature: Number.isFinite(Number(temperature)) ? Number(temperature) : 0.2
  }

  const startedAt = Date.now()
  const useTimeoutMs = clampInt(timeoutMs, 5_000, 120_000, 60_000)
  const useProxyUrl = String(proxyUrl || '').trim()
  try {
    const msgCount = Array.isArray(payload.messages) ? payload.messages.length : 0
    let chars = 0
    try {
      for (const m of payload.messages || []) chars += String(m && m.content != null ? m.content : '').length
    } catch (_) {}
    console.log(
      `[game_studio] doubao.llm:start api=${apiUrl} model=${useModel} msgs=${msgCount} chars=${chars} proxy=${useProxyUrl ? 'on' : 'off'} timeoutMs=${useTimeoutMs}`
    )
  } catch (_) {}

  try {
    const json = await curlRequestJson({
      url: apiUrl,
      method: 'POST',
      headers,
      body: payload,
      timeoutMs: useTimeoutMs,
      proxyUrl: useProxyUrl
    })
    try {
      const reqId =
        json && typeof json === 'object'
          ? String(json.request_id || json.requestId || (json.id != null ? json.id : '') || '').trim()
          : ''
      console.log(`[game_studio] doubao.llm:ok model=${useModel} ms=${Math.max(0, Date.now() - startedAt)}${reqId ? ` requestId=${reqId}` : ''}`)
    } catch (_) {}
    return {
      json,
      meta: { provider: 'doubao', api: 'chat.completions', model: useModel, durationMs: Math.max(0, Date.now() - startedAt) }
    }
  } catch (e) {
    try {
      const status = e && typeof e.status === 'number' ? e.status : null
      const body = e && typeof e === 'object' && e.body && typeof e.body === 'object' ? e.body : null
      const reqId = body ? String(body.request_id || body.requestId || body.id || '').trim() : ''
      const msg = e && e.message ? String(e.message) : String(e)
      console.log(
        `[game_studio] doubao.llm:fail model=${useModel} status=${status == null ? '-' : status} ms=${Math.max(0, Date.now() - startedAt)}${reqId ? ` requestId=${reqId}` : ''} err=${msg}`
      )
    } catch (_) {}
    throw e
  }
}

export async function generateStrictJsonViaDoubaoChat({
  instructions,
  input,
  model,
  timeoutMs,
  maxRetries,
  validate,
  proxyUrl
}) {
  const proxyUrlUse = String(proxyUrl || '').trim() || getProxyUrl()
  const retries = clampInt(maxRetries, 0, 3, 2)

  const sys = String(instructions || '').trim()
  const user = String(input || '').trim()
  if (!sys || !user) throw new Error('missing_instructions_or_input')

  let lastText = ''
  let lastMeta = null

  function tryParseJsonLoose(rawText) {
    const content = stripJsonCodeFence(String(rawText || ''))
    if (!content) return null
    // 1) Try direct parse first.
    try {
      return JSON.parse(content)
    } catch (_) {}

    // 2) Try extracting the first JSON object by braces.
    const s = String(content)
    const a = s.indexOf('{')
    const b = s.lastIndexOf('}')
    if (a >= 0 && b > a) {
      let mid = s.slice(a, b + 1)
      // Remove trailing commas (common LLM mistake).
      mid = mid.replace(/,(\s*[}\]])/g, '$1')
      try {
        return JSON.parse(mid)
      } catch (_) {}
    }
    return null
  }

  for (let attempt = 0; attempt <= retries; attempt++) {
    const messages = [
      {
        role: 'system',
        content:
          sys +
          `\n` +
          `重要：只输出 JSON，对象必须能被 JSON.parse 解析；不要输出解释文字；不要使用 markdown 代码块。`
      }
    ]
    if (attempt > 0 && lastText) {
      messages.push({
        role: 'user',
        content:
          `上一次输出无法解析或不符合要求。请修复并重新输出“唯一的 JSON 对象”。\n` +
          `错误提示：${attempt === 1 ? 'invalid_json_or_schema' : 'still_invalid'}\n` +
          `上一次输出：\n${String(lastText).slice(0, 6000)}`
      })
    }
    messages.push({ role: 'user', content: user })

    const { json, meta } = await doubaoChatCompletionsJson({
      messages,
      model,
      temperature: 0.2,
      timeoutMs,
      proxyUrl: proxyUrlUse
    })
    lastMeta = meta
    const content = extractChatContent(json)
    lastText = content

    const cleaned = stripJsonCodeFence(content)
    const parsed = tryParseJsonLoose(cleaned)

    const ok = validate ? Boolean(validate(parsed)) : Boolean(parsed && typeof parsed === 'object')
    if (ok) return { parsed, text: cleaned, meta }
  }

  const e = new Error('doubao_invalid_json_output')
  e.status = 502
  e.meta = lastMeta
  e.output = lastText
  throw e
}

// doubaoChatCompletionsJson: 直接调用 Ark Chat/completions 接口并返回解析的 JSON 与 meta 信息，
// 包含日志记录与错误处理。
//
// generateStrictJsonViaDoubaoChat: 基于 chat 接口做“严格 JSON 输出”请求：
// - 将 instructions 与 input 包装到 system/user 消息中
// - 若 AI 输出无法被 JSON.parse 或不符合 validate，要进行多次重试并将上次输出反馈为上下文
// - 最终返回 parsed object（已 parse）和原始文本 meta


export async function generateScriptsViaDoubao({ prompt, title, rules, formula, model, proxyUrl, timeoutMs }) {
  const startedAt = Date.now()

  const rulesText = (() => {
    if (!rules) return ''
    try {
      if (typeof rules === 'string') return rules.trim().slice(0, 2500)
      if (typeof rules !== 'object') return ''
      const hard = Array.isArray(rules.hardRules) ? rules.hardRules.map(String).filter(Boolean) : []
      const soft = Array.isArray(rules.softPrefs) ? rules.softPrefs.map(String).filter(Boolean) : []
      const lines = []
      for (const r of hard.slice(0, 20)) lines.push(`- ${r}`)
      if (soft.length) {
        lines.push('')
        lines.push('偏好（尽量满足）：')
        for (const r of soft.slice(0, 20)) lines.push(`- ${r}`)
      }
      const out = lines.join('\n').trim()
      return out.slice(0, 2500)
    } catch (_) {
      return ''
    }
  })()

  const formulaText = (() => {
    if (!formula || typeof formula !== 'object') return ''
    try {
      const choicePoints = Number(formula.choicePoints || 0) || 0
      const optionsPerChoice = Number(formula.optionsPerChoice || 0) || 0
      const endings = Number(formula.endings || 0) || 0
      const fmt = String(formula.format || 'numeric')
      const lines = []
      if (choicePoints) lines.push(`- 选择点数量：${choicePoints}`)
      if (optionsPerChoice) lines.push(`- 每个选择点选项数：${optionsPerChoice}（使用“选项1..${optionsPerChoice}”）`)
      if (endings) lines.push(`- 结局数量：${endings}（name=结局1..结局${endings}）`)
      lines.push(`- 选项格式：${fmt}`)
      return lines.join('\n').trim().slice(0, 1200)
    } catch (_) {
      return ''
    }
  })()

  const instructions =
    `你是一个交互故事制作工具的编剧助手。\n` +
    `任务：根据用户提示，生成“第一层：脚本场景卡片”（交互式小故事的分镜草稿）。\n` +
    `输出为 JSON（必须严格符合 schema）：{"title": string|null, "cards":[{"name":string,"text":string}, ...]}。\n` +
    `要求（重要）：\n` +
    `- 只生成脚本层，不要生成蓝图结构（不要写 toNodeId / 节点ID / 分支图）。\n` +
    `- 输出卡片总数 <= 20。\n` +
    `- 每张卡片只包含：name（短标题）+ text（1~3 句发生了什么）。\n` +
    `- 叙事要逻辑严谨、因果紧凑：每张卡推进一个明确动作/结果，避免空泛总结与重复。\n` +
    `- 交互要更早出现：前 3~5 张卡内必须出现第 1 个“选择点”。\n` +
    `- 分支要清楚：至少 1 个“选择点”。每个选择点在 text 里用明确选项，必须换行，格式固定（数字格式，便于解析）：\n` +
    `  选项1：<一句话>\n` +
    `  选项2：<一句话>\n` +
    `  （可选 选项3/4/5）\n` +
    `- 后果卡命名规则（必须遵守，便于蓝图自动连线）：\n` +
    `  第 i 个选择点的第 k 个选项后果卡，name 必须为：i后果k（例如：1后果2）。注意这里的 i 是“第几个选择点”，不是卡片序号。\n` +
    `- 选择点之后要紧跟对应数量的后果卡（每个选项 1 张后果卡）。\n` +
    `- 结局卡：name 以“结局”开头（例如：结局1/结局2）。\n` +
    `- 结局与最后一次选择必须一一对应：如果本次结构公式指定结局数量 N，则“最后一个选择点”的每个选项后果应直接落到对应的结局卡（结局1..结局N），不要把多个结局顺序堆在最后却没有分支指向。\n` +
    `- 场景可演出：尽量包含动作/对话/环境变化，便于后续做蓝图与演出。\n` +
    `- 使用中文。\n` +
    (formulaText ? `\n本次结构公式（必须严格满足）：\n${formulaText}\n` : '') +
    (rulesText ? `\n全局规则（人工可编辑，必须遵守）：\n${rulesText}\n` : '')

  const user =
    `用户提示：\n${String(prompt || '').trim()}\n` +
    (title ? `\n用户指定标题：${String(title).trim()}\n` : '')

  const { parsed, meta } = await generateStrictJsonViaDoubaoChat({
    instructions,
    input: user,
    timeoutMs: clampInt(timeoutMs, 5_000, 180_000, clampInt(process.env.STUDIO_AI_TIMEOUT_MS, 5_000, 180_000, 90_000)),
    model: String(model || process.env.DOUBAO_ARK_TEXT_MODEL || '').trim() || undefined,
    proxyUrl,
    maxRetries: 2,
    validate: (obj) => validateScriptDraft(obj).ok
  })

  return {
    draft: parsed,
    meta: { ...meta, durationMs: Math.max(0, Date.now() - startedAt) }
  }
}

export async function repairScriptsViaDoubao({
  projectTitle,
  scripts,
  rules,
  formula,
  report,
  validation,
  model,
  proxyUrl
}) {
  const startedAt = Date.now()

  const rulesText = (() => {
    if (!rules) return ''
    try {
      if (typeof rules === 'string') return rules.trim().slice(0, 2500)
      if (typeof rules !== 'object') return ''
      const hard = Array.isArray(rules.hardRules) ? rules.hardRules.map(String).filter(Boolean) : []
      const soft = Array.isArray(rules.softPrefs) ? rules.softPrefs.map(String).filter(Boolean) : []
      const lines = []
      for (const r of hard.slice(0, 20)) lines.push(`- ${r}`)
      if (soft.length) {
        lines.push('')
        lines.push('偏好（尽量满足）：')
        for (const r of soft.slice(0, 20)) lines.push(`- ${r}`)
      }
      const out = lines.join('\n').trim()
      return out.slice(0, 2500)
    } catch (_) {
      return ''
    }
  })()

  const formulaText = (() => {
    if (!formula || typeof formula !== 'object') return ''
    try {
      const choicePoints = Number(formula.choicePoints || 0) || 0
      const optionsPerChoice = Number(formula.optionsPerChoice || 0) || 0
      const endings = Number(formula.endings || 0) || 0
      const fmt = String(formula.format || 'numeric')
      const lines = []
      if (choicePoints) lines.push(`- 选择点数量：${choicePoints}`)
      if (optionsPerChoice) lines.push(`- 每个选择点选项数：${optionsPerChoice}（使用“选项1..${optionsPerChoice}”）`)
      if (endings) lines.push(`- 结局数量：${endings}（name=结局1..结局${endings}）`)
      lines.push(`- 选项格式：${fmt}`)
      return lines.join('\n').trim().slice(0, 1200)
    } catch (_) {
      return ''
    }
  })()

  const diagText = (() => {
    const lines = []
    try {
      const ws = report && typeof report === 'object' && Array.isArray(report.warnings) ? report.warnings : []
      if (ws.length) {
        lines.push('编译提示：')
        for (const w of ws.slice(0, 20)) lines.push(`- ${String(w && (w.message || w.code) ? (w.message || w.code) : w)}`)
        lines.push('')
      }
    } catch (_) {}
    try {
      const ok = validation && typeof validation === 'object' ? validation.ok : null
      if (ok === false) {
        const es = Array.isArray(validation.errors) ? validation.errors : []
        lines.push('校验失败：')
        for (const e of es.slice(0, 20)) lines.push(`- ${String(e && (e.message || e.code) ? (e.message || e.code) : e)}`)
        lines.push('')
      }
      const ws = validation && typeof validation === 'object' && Array.isArray(validation.warnings) ? validation.warnings : []
      if (ws.length) {
        lines.push('校验提示：')
        for (const w of ws.slice(0, 20)) lines.push(`- ${String(w && (w.message || w.code) ? (w.message || w.code) : w)}`)
        lines.push('')
      }
    } catch (_) {}
    return lines.join('\n').trim().slice(0, 4000)
  })()

  const cardsText = (() => {
    try {
      const cards = scripts && typeof scripts === 'object' && Array.isArray(scripts.cards) ? scripts.cards : []
      const lines = []
      for (const c of cards.slice(0, 40)) {
        const name = c && c.name ? String(c.name) : ''
        const text = c && c.text ? String(c.text) : ''
        if (!name && !text) continue
        lines.push(`【${name || '未命名'}】`)
        lines.push(text.trim())
        lines.push('')
      }
      return lines.join('\n').trim().slice(0, 16000)
    } catch (_) {
      return ''
    }
  })()

  const instructions =
    `你是一个交互故事制作工具的“脚本修复助手”。\n` +
    `任务：根据“当前脚本”+“结构公式”+“编译/校验反馈”，修复脚本，使其更容易被工具解析并生成可达、闭合的蓝图。\n` +
    `输出为 JSON（必须严格符合 schema）：{"title": string|null, "cards":[{"name":string,"text":string}, ...]}。\n` +
    `要求（重要）：\n` +
    `- 以“修复”为主：尽量保留原有剧情/人物/时代背景；不要重写成完全不同的故事。\n` +
    `- 只输出脚本层，不要输出蓝图结构（不要写 toNodeId / 节点ID / 分支图）。\n` +
    `- 严格满足结构公式：选择点数量、每个选择点的选项数、结局数量。\n` +
    `- 每个选择点在 text 中必须换行列出固定格式（数字格式，便于解析）：\n` +
    `  选项1：<一句话>\n` +
    `  选项2：<一句话>\n` +
    `  …（直到 optionsPerChoice）\n` +
    `- 后果卡命名规则（必须遵守）：第 i 个选择点的第 k 个选项后果卡，name 必须为 i后果k（例如：1后果2）。\n` +
    `- 选择点之后要紧跟对应数量的后果卡（每个选项 1 张后果卡）。\n` +
    `- 结局卡：name 以“结局”开头（例如：结局1/结局2）。\n` +
    `- 结局与最后一次选择必须一一对应：最后一个选择点的每个选项后果应直接落到对应的结局卡（结局1..结局N）。\n` +
    `- 控制长度：卡片总数 <= 20；每张卡 text 1~4 句即可。\n` +
    `- 使用中文。\n` +
    (formulaText ? `\n本次结构公式（必须严格满足）：\n${formulaText}\n` : '') +
    (rulesText ? `\n全局规则（人工可编辑，必须遵守）：\n${rulesText}\n` : '')

  const user =
    (projectTitle ? `故事名（全局锁定）：《${String(projectTitle).trim()}》\n\n` : '') +
    (diagText ? `当前编译/校验反馈（用来修复问题）：\n${diagText}\n\n` : '') +
    `当前脚本（需要你修复）：\n${cardsText}\n`

  const { parsed, meta } = await generateStrictJsonViaDoubaoChat({
    instructions,
    input: user,
    timeoutMs: clampInt(process.env.STUDIO_AI_TIMEOUT_MS, 5_000, 120_000, 60_000),
    model: String(model || process.env.DOUBAO_ARK_TEXT_MODEL || '').trim() || undefined,
    proxyUrl,
    maxRetries: 2,
    validate: (obj) => validateScriptDraft(obj).ok
  })

  return {
    draft: parsed,
    meta: { ...meta, durationMs: Math.max(0, Date.now() - startedAt) }
  }
}

export async function generateBackgroundPromptViaDoubao({
  userInput,
  globalPrompt,
  globalNegativePrompt,
  aspectRatio,
  style,
  model,
  proxyUrl,
  outputLanguage
}) {
  function normalizeAspectRatio(v) {
    const s = String(v || '').trim()
    return s === '9:16' || s === '16:9' || s === '1:1' || s === '9:1' ? s : null
  }

  function normalizeStyle(v) {
    const s = String(v || '').trim()
    return s === 'picture_book' || s === 'cartoon' || s === 'national_style' || s === 'watercolor' ? s : null
  }

  const ar = String(aspectRatio || '').trim() || '9:16'
  const st = String(style || '').trim() || 'picture_book'
  const lang = String(outputLanguage || '').trim().toLowerCase() === 'en' ? 'en' : 'zh'
  const langLabel = lang === 'en' ? '英文（English）' : '中文'
  const lineJoinHint = lang === 'en' ? '逗号分隔（英文）' : '逗号分隔（中文）'
  const oneLineHint = lang === 'en' ? 'prompt/negativePrompt 必须是一行英文，不要换行。' : 'prompt/negativePrompt 必须是一行中文，不要换行。'
  const worldAnchorHint =
    lang === 'en'
      ? `- globalPrompt 必须包含“WORLD_ANCHOR”段落：明确时代/地理/建筑、色彩与光照、镜头语言、角色外观锁定（服装/发型/配饰/色彩），并要求所有场景保持连续一致。\n`
      : `- globalPrompt 必须包含“世界观锚点”段落：明确时代/地理/建筑、色彩与光照、镜头语言、角色外观锁定（服装/发型/配饰/色彩），并要求所有场景保持连续一致。\n`

  const instructions =
    `你是“交互故事制作工具”的美术提示词助手。\n` +
    `任务：把用户的自然语言描述，改写成适用于文生图模型的标准提示词。\n` +
    `输出为 JSON（必须严格符合 schema）：\n` +
    `{"globalPrompt":string|null,"globalNegativePrompt":string|null,"scenePrompt":string,"sceneNegativePrompt":string|null,"prompt":string,"negativePrompt":string|null,"aspectRatio":"9:16"|"16:9"|"1:1"|"9:1","style":"picture_book"|"cartoon"|"national_style"|"watercolor"}\n` +
    `要求（重要）：\n` +
    `- 输出语言固定为：${langLabel}。\n` +
    `- 你需要维护“全局设定”（globalPrompt/globalNegativePrompt），用于锁定整个故事的时代/环境/美术风格/禁用元素，避免后续场景跑偏。\n` +
    worldAnchorHint +
    `- 如果 globalPrompt 尚未包含明确的“角色设定”，且本场景出现人物/动物/关键物体：请在 globalPrompt 中补充一段简短“角色设定/外观指纹”（衣着、发型、面部特征、颜色、配饰等），供后续场景复用以保持一致。\n` +
    `- 当用户提到“锁定/同一人物/保持一致/沿用上一张/同一个角色/同一只动物”等一致性要求时：你必须在 globalPrompt 中新增“角色设定/一致性锁定”段落，明确列出主要角色与关键物体的固定外观（脸型/发型/服饰/颜色/配饰等），并要求后续所有场景保持同一角色与同一只动物（避免变脸/换装/变色/数量变化）。\n` +
    `- 如果场景中出现动物/道具（例如兔子），请明确数量（例如“仅一只兔子（唯一）”），避免模型画出多只。\n` +
    `- 如果用户已提供全局设定：不得改变其含义，只能做“补全/精炼/结构化”；不要把故事内容写成剧情，只写视觉设定。\n` +
    `- scenePrompt/sceneNegativePrompt 只描述“本场景的增量”，不要重复全局设定。\n` +
    `- prompt/negativePrompt 是最终提交给生图服务的合并结果（全局 + 本场景），${oneLineHint}\n` +
    `- prompt 要包含：画面主体 + 场景/动作 + 氛围/光线/镜头 + 细节；并显式写出风格与比例。\n` +
    `- style 使用枚举值：picture_book/cartoon/national_style/watercolor。\n` +
    `- 比例使用枚举值：9:16/16:9/1:1/9:1。\n` +
    `- negativePrompt/globalNegativePrompt/sceneNegativePrompt 以${lineJoinHint}的短词为主；默认补充：text, watermark, logo, qr code, low quality, blurry, deformed, photorealistic。\n` +
    `- 用户要求中出现“不要/避免/无…”的内容必须反映到 prompt 或 negativePrompt。\n` +
    `- 不要输出解释文字，只输出 JSON。`

  const user =
    `固定参数：style=${st}, aspectRatio=${ar}\n` +
    `全局设定（可为空）：${String(globalPrompt || '').trim()}\n` +
    `全局负面（可为空）：${String(globalNegativePrompt || '').trim()}\n` +
    `本场景描述：${String(userInput || '').trim()}\n`

  const { parsed, meta } = await generateStrictJsonViaDoubaoChat({
    instructions,
    input: user,
    timeoutMs: clampInt(process.env.STUDIO_PROMPT_TIMEOUT_MS, 5_000, 120_000, 60_000),
    model: String(model || process.env.DOUBAO_ARK_TEXT_MODEL || '').trim() || undefined,
    proxyUrl,
    maxRetries: 2,
    validate: (obj) => validateBackgroundPrompt(obj).ok
  })

  return {
    result: {
      globalPrompt: parsed.globalPrompt == null ? '' : String(parsed.globalPrompt || '').trim(),
      globalNegativePrompt: parsed.globalNegativePrompt == null ? '' : String(parsed.globalNegativePrompt || '').trim(),
      prompt: String(parsed.scenePrompt || parsed.prompt || '').trim(),
      negativePrompt: parsed.sceneNegativePrompt == null ? '' : String(parsed.sceneNegativePrompt || '').trim(),
      finalPrompt: String(parsed.prompt || '').trim(),
      finalNegativePrompt: parsed.negativePrompt == null ? '' : String(parsed.negativePrompt || '').trim(),
      aspectRatio: normalizeAspectRatio(parsed.aspectRatio) || normalizeAspectRatio(ar) || '9:16',
      style: normalizeStyle(parsed.style) || normalizeStyle(st) || 'picture_book'
    },
    meta
  }
}

export async function generateImageViaDoubaoArkImages(input) {
  // New API (Seedream 4.x):
  // POST https://ark.cn-beijing.volces.com/api/v3/images/generations
  const apiUrl = normalizeArkImagesUrl(
    input && input.apiUrl ? String(input.apiUrl) : (process.env.DOUBAO_ARK_IMAGES_URL || process.env.DOUBAO_ARK_API_URL) ||
      'https://ark.cn-beijing.volces.com/api/v3/images/generations'
  )

  const apiKey =
    String(process.env.DOUBAO_ARK_API_KEY || '').trim() ||
    String(process.env.ARK_API_KEY || '').trim() ||
    String(process.env.DOUBAO_API_KEY || '').trim()
  const authHeaderLine = String(process.env.DOUBAO_ARK_AUTH_HEADER || process.env.DOUBAO_AUTH_HEADER || '').trim()
  if (!apiKey && !authHeaderLine) {
    const e = new Error('doubao_not_configured: missing DOUBAO_ARK_API_KEY (Authorization: Bearer ...)')
    e.status = 501
    throw e
  }

  const model = String((input && input.model ? input.model : process.env.DOUBAO_ARK_MODEL) || 'doubao-seedream-4-0-250828').trim()
  const timeoutRaw = Number(input && input.timeoutMs)
  const timeoutMs = (Number.isFinite(timeoutRaw) && timeoutRaw <= 0)
    ? 300_000
    : clampInt(input.timeoutMs, 5_000, 300_000, 60_000)
  const proxyUrl = String(input.proxyUrl || '').trim()

  const promptIn = String(input.prompt || '').trim()
  if (!promptIn) {
    const e = new Error('missing_prompt')
    e.status = 400
    throw e
  }

  // Ark images API doesn't have negativePrompt; convert negatives into natural constraints
  // instead of raw keywords (e.g. "text/watermark"), which can otherwise be drawn literally.
  let prompt = promptIn
  try {
    const neg = String(input.negativePrompt || '').trim()
    if (neg) {
      const tokens = String(neg)
        .split(/[,\n，、]+/g)
        .map((x) => x.trim())
        .filter(Boolean)
      const reqSet = new Set()
      const avoidSet = new Set()
      for (const t of tokens) {
        if (!t) continue
        const raw = String(t).trim()
        if (!raw) continue
        const low = raw.toLowerCase()
        if (
          /(text|watermark|logo|subtitle|caption|speech\s*bubble|dialogue|二维码)/i.test(low) ||
          /(文字|水印|字幕|对白|对话框|气泡|标识|logo|二维码)/.test(raw)
        ) {
          reqSet.add('no text, no subtitle, no speech bubble, no watermark, no logo, no QR code')
          continue
        }
        if (/(non[-\s]?human|non[-\s]?real|real[-\s]?person|photorealistic\s*face)/i.test(low) || /(非真人|真人|写实人脸)/.test(raw)) {
          reqSet.add('illustration style only, avoid photorealistic face')
          continue
        }
        if (/(gore|blood|violent|violence)/i.test(low) || /(血腥|暴力)/.test(raw)) {
          avoidSet.add('gore and blood')
          continue
        }
        if (/(low\s*quality|blurry|deformed|artifact|grid)/i.test(low) || /(低质量|模糊|变形|网格|格子)/.test(raw)) {
          avoidSet.add('low quality, blurry, deformed, grid artifacts')
          continue
        }
        if (/^(无|非|禁止|不要)/.test(raw)) {
          // Skip unknown CN neg token to avoid injecting literal Chinese terms into image prompt.
          continue
        }
        avoidSet.add(raw)
      }
      const req = Array.from(reqSet)
      const avoid = Array.from(avoidSet)
      if (req.length) prompt = `${prompt}, requirements: ${req.join(', ')}`
      if (avoid.length) prompt = `${prompt}, avoid: ${avoid.join(', ')}`
    }
  } catch (_) {}

  // Prefer explicit WxH from current request to preserve runtime aspect ratio.
  const widthIn = Number(input.width)
  const heightIn = Number(input.height)
  const hasWH = Number.isFinite(widthIn) && Number.isFinite(heightIn) && widthIn > 0 && heightIn > 0
  let size =
    (hasWH ? `${Math.floor(widthIn)}x${Math.floor(heightIn)}` : '') ||
    String(input.size || '').trim() ||
    String(process.env.DOUBAO_IMAGE_SIZE || '').trim() ||
    '1024x1024'

  // Some Ark image models enforce minimum dimensions (e.g. >=1280x720 in either orientation).
  // If we got a WxH size below that threshold, scale up (rounded to multiples of 64) to avoid hard errors.
  try {
    const parsed = parseSizeWxH(size)
    if (parsed) {
      const next = ensureMinImageConstraints(parsed, {
        minShort: ARK_MIN_SHORT_SIDE,
        minLong: ARK_MIN_LONG_SIDE,
        minPixels: ARK_MIN_PIXELS
      })
      if (next.scaled) {
        const nextSize = `${next.w}x${next.h}`
        console.log(`[game_studio] doubao.images:resize size=${size} -> ${nextSize} (${next.reason})`)
        size = nextSize
      }
    }
  } catch (_) {}

  const responseFormat = String(input.responseFormat || '').trim() || 'url' // url | b64_json
  const watermark = typeof input.watermark === 'boolean' ? Boolean(input.watermark) : String(process.env.DOUBAO_WATERMARK || 'false').toLowerCase() === 'true'
  const sequential = String(input.sequentialImageGeneration || 'disabled') // disabled | auto
  const guidanceScale = clampFloat(input.guidanceScale ?? input.cfgScale, 1, 10, 5)

  const payload = {
    model,
    prompt,
    response_format: responseFormat,
    size,
    watermark,
    sequential_image_generation: sequential,
    guidance_scale: guidanceScale
  }

  const headers = { 'Content-Type': 'application/json' }
  if (authHeaderLine) {
    const idx = authHeaderLine.indexOf(':')
    if (idx > 0) headers[authHeaderLine.slice(0, idx).trim()] = authHeaderLine.slice(idx + 1).trim()
  } else {
    headers.Authorization = `Bearer ${apiKey}`
  }

  try {
    const proxyOn = Boolean(proxyUrl)
    console.log(`[game_studio] doubao.images:start api=${apiUrl} model=${model} size=${size} format=${responseFormat} watermark=${watermark} seq=${sequential} proxy=${proxyOn ? 'on' : 'off'} timeoutMs=${timeoutMs}`)
  } catch (_) {}

  const json = await curlRequestJson({
    url: apiUrl,
    method: 'POST',
    headers,
    body: payload,
    timeoutMs,
    proxyUrl
  })

  try {
    const created = json && typeof json === 'object' && json.created ? String(json.created) : '-'
    const imgs = json && typeof json === 'object' && Array.isArray(json.data) ? json.data.length : 0
    console.log(`[game_studio] doubao.images:ok created=${created} images=${imgs}`)
  } catch (_) {}

  const d0 = json && typeof json === 'object' && Array.isArray(json.data) ? json.data[0] : null
  const b64 = d0 && (d0.b64_json || d0.base64) ? String(d0.b64_json || d0.base64) : ''
  if (b64) return { mode: 'base64', bytes: Buffer.from(b64, 'base64'), ext: 'jpg', raw: json }
  const url = d0 && d0.url ? String(d0.url) : ''
  if (url) return { mode: 'url', url, raw: json }

  const e = new Error('doubao_invalid_response: missing data[0].url/b64_json')
  e.status = 502
  e.body = json
  throw e
}

// generateScriptsViaDoubao: 请求 LLM 生成脚本草稿（用于第一层脚本），要求严格输出 JSON 草稿并返回 parsed 与 meta。
// repairScriptsViaDoubao: 根据当前脚本、编译/校验反馈与规则，要求 LLM 修复脚本以满足结构公式与可达性要求。
// generateBackgroundPromptViaDoubao: 将用户的自然语言美术描述转换为适配 Doubao 图像生成的标准提示词（JSON 格式）。
// generateImageViaDoubaoArkImages: 调用 Ark Images API 生成图片，支持两种返回模式（url 或 base64），并处理最小尺寸约束、负面词合并等。
