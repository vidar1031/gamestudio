import dns from 'node:dns/promises'
import { spawn } from 'node:child_process'
import { getProxyInfo, getProxyUrl } from '../net/proxy.js'
import { getStudioSecret } from '../studio/secrets.js'

const OFFICIAL_OPENAI_BASE_URL = 'https://api.openai.com/v1'

function isLocalHost(hostname) {
  const h = String(hostname || '').trim().toLowerCase()
  if (!h) return false
  return h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '[::1]'
}

function shouldBypassProxyForTarget(url) {
  try {
    const u = new URL(String(url || ''))
    return isLocalHost(u.hostname)
  } catch (_) {
    return false
  }
}

function normalizeOpenAICompatibleProvider(provider) {
  const p = String(provider || '').trim().toLowerCase()
  return p === 'localoxml' ? 'localoxml' : 'openai'
}

export function isOpenAICompatibleProvider(provider) {
  const p = String(provider || '').trim().toLowerCase()
  return p === 'openai' || p === 'localoxml'
}

function stripJsonCodeFence(s) {
  const raw = String(s || '').trim()
  if (!raw) return ''
  // Handle ```json ... ``` or ``` ... ```
  const fenced = raw.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)
  return fenced ? String(fenced[1] || '').trim() : raw
}

export function extractResponseOutputText(respJson) {
  let raw = ''
  try {
    if (respJson && typeof respJson.output_text === 'string') {
      raw = respJson.output_text
    }
  } catch (_) {}

  if (!raw) {
    try {
      const out = Array.isArray(respJson && respJson.output) ? respJson.output : []
      const texts = []
      for (const item of out) {
        if (!item || typeof item !== 'object') continue
        if (String(item.type) !== 'message') continue
        const content = Array.isArray(item.content) ? item.content : []
        for (const c of content) {
          if (c && typeof c === 'object' && String(c.type) === 'output_text' && typeof c.text === 'string') {
            texts.push(c.text)
          }
        }
      }
      raw = texts.join('').trim()
    } catch (_) {
      return ''
    }
  }

  // Strip markdown code fences that some models output (e.g. ```json ... ```)
  return stripJsonCodeFence(raw)
}

function normalizeOpenAICompatibleBaseUrl(raw, provider = 'openai') {
  let s = String(raw || '').trim()
  if (!s) return OFFICIAL_OPENAI_BASE_URL
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s) && /^[a-z0-9_.-]+(?::\d{1,5})?(?:\/.*)?$/i.test(s)) {
    s = `http://${s}`
  }
  try {
    const u = new URL(s)
    if (!/^https?:$/i.test(String(u.protocol || ''))) return OFFICIAL_OPENAI_BASE_URL
    const pathname = String(u.pathname || '').replace(/\/+$/, '')
    if (!pathname || pathname === '/') u.pathname = '/v1'
    return u.toString().replace(/\/+$/, '')
  } catch (_) {
    return OFFICIAL_OPENAI_BASE_URL
  }
}

function getOpenAIConfig(provider = 'openai', overrides = null) {
  const p = normalizeOpenAICompatibleProvider(provider)
  const useLocalOxml = p === 'localoxml'
  const inOverrides = overrides && typeof overrides === 'object' ? overrides : {}
  const secretOverride = getStudioSecret(p)
  const apiKey = String(
    secretOverride ||
      (
        useLocalOxml
          ? (process.env.LOCALOXML_API_KEY || process.env.STUDIO_AI_API_KEY || process.env.OPENAI_API_KEY || '')
          : (process.env.OPENAI_API_KEY || '')
      )
  ).trim()
  const baseUrl = normalizeOpenAICompatibleBaseUrl(
    inOverrides.apiUrl ||
      (
        useLocalOxml
          ? (process.env.LOCALOXML_BASE_URL || process.env.STUDIO_AI_BASE_URL || OFFICIAL_OPENAI_BASE_URL)
          : (process.env.OPENAI_BASE_URL || OFFICIAL_OPENAI_BASE_URL)
      ),
    p
  )
  const model = String(
    inOverrides.model ||
      (useLocalOxml
      ? (process.env.LOCALOXML_MODEL || process.env.STUDIO_AI_MODEL || 'gpt-4o-mini')
      : (process.env.OPENAI_MODEL || 'gpt-4o-mini'))
  ).trim() || 'gpt-4o-mini'
  const timeoutMsEnv = String(
    useLocalOxml
      ? (process.env.LOCALOXML_TIMEOUT_MS || process.env.STUDIO_AI_TIMEOUT_MS || '')
      : (process.env.OPENAI_TIMEOUT_MS || '')
  ).trim()
  const timeoutMsRaw = timeoutMsEnv ? Number(timeoutMsEnv) : (model.startsWith('gpt-5') ? 60000 : 20000)
  const timeoutMs = Math.max(1000, Number.isFinite(timeoutMsRaw) ? timeoutMsRaw : 20000)
  return { provider: p, apiKey, baseUrl, timeoutMs, model }
}

// Small helper for other modules that want to use Responses API while preserving
// proxy behavior (curl) + timeouts implemented here.
export async function openaiResponsesJsonForTools({ body, provider, timeoutMs: callerTimeoutMs, apiUrl, model: modelOverride, proxyUrl }) {
  const cfg = getOpenAIConfig(provider, { apiUrl, model: modelOverride })
  const { model } = cfg
  // Prefer caller-supplied timeout over config default. timeoutMs <= 0 means no timeout.
  const timeoutMs = Number.isFinite(Number(callerTimeoutMs))
    ? Number(callerTimeoutMs)
    : cfg.timeoutMs
  const startedAt = Date.now()
  const merged = { ...(body || {}), model: String((body && body.model) || model) }
  const json = await openaiRequestJson({ method: 'POST', path: '/responses', body: merged, timeoutMs, provider: cfg.provider, apiUrl, proxyUrl })
  return {
    json,
    meta: { provider: cfg.provider, api: 'responses', model: merged.model, durationMs: Math.max(0, Date.now() - startedAt) }
  }
}

async function openaiRequestJson({ method, path: apiPath, body, timeoutMs, provider, apiUrl, model, proxyUrl: proxyUrlOverride }) {
  const cfg = getOpenAIConfig(provider, { apiUrl, model })
  const { apiKey, baseUrl } = cfg
  const allowMissingKey = cfg.provider === 'localoxml'
  if (!apiKey && !allowMissingKey) throw new Error('missing_openai_api_key')
  const url = `${baseUrl}${apiPath.startsWith('/') ? apiPath : `/${apiPath}`}`

  const proxyUrlRaw = String(proxyUrlOverride || getProxyUrl() || '').trim()
  const proxyUrl = shouldBypassProxyForTarget(url) ? '' : proxyUrlRaw
  const noTimeout = Number.isFinite(Number(timeoutMs)) && Number(timeoutMs) <= 0
  const controller = noTimeout ? null : new AbortController()
  const t = noTimeout ? null : setTimeout(() => controller.abort(), Math.max(1000, Number(timeoutMs || 0) || 20000))
  try {
    // If a proxy is configured, use curl to ensure proxy support even when Node fetch doesn't.
    // This avoids confusing "browser works but CLI fails" setups (e.g. Clash Verge).
    if (proxyUrl) {
      return await curlRequestJson({
        url,
        method,
        headers: {
          ...(body ? { 'Content-Type': 'application/json' } : {}),
          ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {})
        },
        body,
        timeoutMs,
        proxyUrl
      })
    }

    const resp = await fetch(url, {
      method: String(method || 'POST').toUpperCase(),
      headers: {
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {})
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      ...(controller ? { signal: controller.signal } : {})
    })
    const json = await resp.json().catch(() => null)
    if (!resp.ok) {
      const msg =
        json && typeof json === 'object'
          ? (json.error && (json.error.message || json.error)) || json.message || JSON.stringify(json)
          : `HTTP ${resp.status}`
      const err = new Error(String(msg))
      err.status = resp.status
      err.body = json
      throw err
    }
    return json
  } finally {
    if (t) clearTimeout(t)
  }
}

function curlRequestJson({ url, method, headers, body, timeoutMs, proxyUrl }) {
  const marker = '__CURL_STATUS__'
  const noTimeout = Number.isFinite(Number(timeoutMs)) && Number(timeoutMs) <= 0
  const args = [
    '-sS',
    '-X',
    String(method || 'POST').toUpperCase(),
    '--proxy',
    String(proxyUrl),
    '-w',
    `\\n${marker}:%{http_code}\\n`,
    ...Object.entries(headers || {}).flatMap(([k, v]) => ['-H', `${k}: ${v}`])
  ]
  if (!noTimeout) {
    args.splice(3, 0, '--max-time', String(Math.max(1, Math.ceil((Number(timeoutMs || 0) || 20000) / 1000))))
  }
  if (body != null) args.push('--data-binary', '@-')
  args.push(String(url))

  return new Promise((resolve, reject) => {
    const p = spawn('curl', args, { stdio: ['pipe', 'pipe', 'pipe'] })
    const chunks = []
    const errChunks = []

    const killTimer = noTimeout ? null : setTimeout(() => {
      try { p.kill('SIGKILL') } catch (_) {}
    }, Math.max(1000, Number(timeoutMs || 0) || 20000) + 1000)

    p.stdout.on('data', (d) => chunks.push(d))
    p.stderr.on('data', (d) => errChunks.push(d))
    p.on('error', (e) => {
      if (killTimer) clearTimeout(killTimer)
      reject(e)
    })
    p.on('close', (code) => {
      if (killTimer) clearTimeout(killTimer)
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

      // curl can return http_code "000" for transport failures (timeout/proxy/TLS/etc).
      // Map those to a clearer error so callers can decide whether to retry/fallback.
      if (status === 0) {
        const isTimeout = Number(code) === 28 || /\b(?:Operation timed out|timeout)\b/i.test(errText)
        const e = new Error(isTimeout ? 'curl_timeout' : `curl_transport_error${errText ? `: ${errText.trim()}` : ''}`)
        e.status = 0
        e.code = code
        reject(e)
        return
      }

      const json = jsonText ? JSON.parse(jsonText) : null
      if (status < 200 || status >= 300) {
        const msg =
          json && typeof json === 'object'
            ? (json.error && (json.error.message || json.error)) || json.message || JSON.stringify(json)
            : `HTTP ${status}`
        const e = new Error(String(msg))
        e.status = status
        e.body = json
        e.code = code
        reject(e)
        return
      }

      resolve(json)
    })

    try {
      if (body != null) p.stdin.write(JSON.stringify(body))
    } catch (_) {}
    try { p.stdin.end() } catch (_) {}
  })
}

function scriptDraftSchema() {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      // NOTE: OpenAI Structured Outputs currently requires `required` to include
      // every key in `properties` (even if conceptually "optional").
      // We keep `title` required but allow null/empty to represent "not provided".
      title: { type: ['string', 'null'], description: '可选：故事标题（不超过 20 字）。未提供时可为 null 或空字符串。' },
      cards: {
        type: 'array',
        minItems: 3,
        maxItems: 20,
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            name: { type: 'string', minLength: 1, maxLength: 24 },
            text: { type: 'string', minLength: 1, maxLength: 600 }
          },
          required: ['name', 'text']
        }
      }
    },
    required: ['title', 'cards']
  }
}

export async function generateScriptsViaOpenAI({ prompt, title, rules, formula, model, timeoutMs, provider, apiUrl, proxyUrl }) {
  const cfg = getOpenAIConfig(provider, { apiUrl, model })
  const useModel = String(model || cfg.model).trim() || cfg.model
  const useTimeoutMs = Math.max(1_000, Number.isFinite(Number(timeoutMs)) ? Number(timeoutMs) : cfg.timeoutMs)
  const startedAt = Date.now()

  const rulesText = formatRulesForInstructions(rules)
  const formulaText = formatFormulaForInstructions(formula)

  const instructions =
    `你是一个交互故事制作工具的编剧助手。\n` +
    `任务：根据用户提示，生成“第一层：脚本场景卡片”（交互式小故事的分镜草稿）。\n` +
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
    `- 分支连续性必须自洽：如果多个分支会重新合流到同一张卡，这张合流卡只能描述“所有上游分支都成立的共同事实”；若某个状态只属于单一路径（例如已经钓到鱼、鱼竿丢了、受了伤、拿到了道具），就不能写进共享合流卡，必须拆成不同承接卡或不同选择点。\n` +
    `- 结局不能引用不属于当前路径的历史。只有当某条路径必然发生过某件事时，结局才能明确提到它。\n` +
    `- 结构顺序必须可编译：不要写游离场景卡。普通场景如果不是选择点、后果卡或结局卡，就必须处于清晰的线性主链上，不能插成不可达节点。
- 当 choicePoints=1 时，必须严格按这个可编译顺序输出：铺垫场景（可有 1~4 张） -> 1选择点 -> 1后果1 -> 结局1 -> 1后果2 -> 结局2（若为 3 选则继续 1后果3 -> 结局3）。
- 当 choicePoints=1 时，不允许在 1后果k 和 结局k 之间再插入一个普通命名场景；若需要表现“钓到大鱼”“再次分心”这类过程，必须直接写进对应的 1后果k 或 结局k 的 text。
- 当 choicePoints>1 时，每个选择点之后都必须先紧跟该选择点自己的全部后果卡；只有在这些后果卡都写完后，才能进入下一轮共享场景或下一选择点。
- 不要夹杂英文单词、英文拟声词或中英混写描述；全部用自然中文表达。
` +
    `- text 中必须使用真实换行，不要输出字面量 \\n。\n` +
    `- 场景可演出：尽量包含动作/对话/环境变化，便于后续做蓝图与演出。\n` +
    `- 使用中文。\n` +
    (formulaText ? `\n本次结构公式（必须严格满足）：\n${formulaText}\n` : '') +
    (rulesText ? `\n全局规则（人工可编辑，必须遵守）：\n${rulesText}\n` : '')

  const user =
    `用户提示：\n${String(prompt || '').trim()}\n` +
    (title ? `\n用户指定标题：${String(title).trim()}\n` : '')

  const schema = scriptDraftSchema()

  // Prefer Responses API with Structured Outputs
  const bodyResponses = {
    model: useModel,
    instructions,
    input: user,
    text: {
      format: {
        type: 'json_schema',
        name: 'script_draft',
        strict: true,
        schema
      }
    }
  }

  try {
    const resp = await openaiRequestJson({ method: 'POST', path: '/responses', body: bodyResponses, timeoutMs: useTimeoutMs, provider: cfg.provider, apiUrl, proxyUrl })
    const text = extractResponseOutputText(resp)
    if (!text) throw new Error('empty_ai_output')
    return {
      draft: JSON.parse(text),
      meta: { provider: cfg.provider, api: 'responses', model: useModel, durationMs: Math.max(0, Date.now() - startedAt) }
    }
  } catch (e) {
    // Do not fallback on transport/timeouts; chat.completions won't help and just doubles latency.
    const code = e && typeof e === 'object' && 'code' in e ? e.code : null
    const msg = e instanceof Error ? e.message : String(e)
    if (Number(code) === 28 || String(msg).includes('curl_timeout')) throw e

    // Fallback: Chat Completions API shape if needed
    const bodyChat = {
      model: useModel,
      messages: [
        { role: 'system', content: instructions },
        { role: 'user', content: user }
      ],
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'script_draft',
          strict: true,
          schema
        }
      }
    }
    const resp2 = await openaiRequestJson({ method: 'POST', path: '/chat/completions', body: bodyChat, timeoutMs: useTimeoutMs, provider: cfg.provider, apiUrl, proxyUrl })
    const content = resp2 && resp2.choices && resp2.choices[0] && resp2.choices[0].message && resp2.choices[0].message.content
    const text = typeof content === 'string' ? content.trim() : ''
    if (!text) throw new Error('empty_ai_output')
    return {
      draft: JSON.parse(text),
      meta: { provider: cfg.provider, api: 'chat.completions', model: useModel, durationMs: Math.max(0, Date.now() - startedAt) }
    }
  }
}

export async function repairScriptsViaOpenAI({
  projectTitle,
  scripts,
  rules,
  formula,
  report,
  validation,
  model,
  provider,
  apiUrl,
  proxyUrl,
  timeoutMs: callerTimeoutMs
}) {
  const cfg = getOpenAIConfig(provider, { apiUrl, model })
  const useModel = String(model || cfg.model).trim() || cfg.model
  const timeoutMs = Number.isFinite(Number(callerTimeoutMs))
    ? Number(callerTimeoutMs)
    : cfg.timeoutMs
  const startedAt = Date.now()

  const rulesText = formatRulesForInstructions(rules)
  const formulaText = formatFormulaForInstructions(formula)

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
    `- 分支连续性必须自洽：如果多个分支重新合流到同一张卡，这张卡只能写所有分支都共同成立的事实；若引用了某一条路径专属状态，必须拆成不同承接卡，不得硬合流。\n` +
    `- 结局只能引用当前路径真实发生过的事件，不能偷用其他分支的记忆。\n` +
    `- 结构顺序必须可编译：不要写游离场景卡。普通场景如果不是选择点、后果卡或结局卡，就必须处于清晰的线性主链上，不能插成不可达节点。
- 当 choicePoints=1 时，必须严格按这个可编译顺序输出：铺垫场景（可有 1~4 张） -> 1选择点 -> 1后果1 -> 结局1 -> 1后果2 -> 结局2（若为 3 选则继续 1后果3 -> 结局3）。
- 当 choicePoints=1 时，不允许在 1后果k 和 结局k 之间再插入一个普通命名场景；若需要表现“钓到大鱼”“再次分心”这类过程，必须直接写进对应的 1后果k 或 结局k 的 text。
- 当 choicePoints>1 时，每个选择点之后都必须先紧跟该选择点自己的全部后果卡；只有在这些后果卡都写完后，才能进入下一轮共享场景或下一选择点。
- 不要夹杂英文单词、英文拟声词或中英混写描述；全部用自然中文表达。
` +
    `- text 中必须使用真实换行，不要输出字面量 \\n。\n` +
    `- 控制长度：卡片总数 <= 20；每张卡 text 1~4 句即可。\n` +
    `- 使用中文。\n` +
    (formulaText ? `\n本次结构公式（必须严格满足）：\n${formulaText}\n` : '') +
    (rulesText ? `\n全局规则（人工可编辑，必须遵守）：\n${rulesText}\n` : '')

  const user =
    (projectTitle ? `故事名（全局锁定）：《${String(projectTitle).trim()}》\n\n` : '') +
    (diagText ? `当前编译/校验反馈（用来修复问题）：\n${diagText}\n\n` : '') +
    `当前脚本（需要你修复）：\n${cardsText}\n`

  const schema = scriptDraftSchema()
  const bodyResponses = {
    model: useModel,
    instructions,
    input: user,
    text: {
      format: {
        type: 'json_schema',
        name: 'script_draft_repair',
        strict: true,
        schema
      }
    }
  }

  const resp = await openaiRequestJson({ method: 'POST', path: '/responses', body: bodyResponses, timeoutMs, provider: cfg.provider, apiUrl, proxyUrl })
  const text = extractResponseOutputText(resp)
  if (!text) throw new Error('empty_ai_output')
  return {
    draft: JSON.parse(text),
    meta: { provider: cfg.provider, api: 'responses', model: useModel, durationMs: Math.max(0, Date.now() - startedAt) }
  }
}

function errToPlain(e) {
  const out = {}
  try {
    if (!e) return { message: 'unknown_error' }
    if (typeof e === 'string') return { message: e }
    out.message = e.message ? String(e.message) : String(e)
    if (e.status != null) out.status = Number(e.status)
    if (e.code != null) out.code = String(e.code)
    if (e.name != null) out.name = String(e.name)
    if (e.cause) {
      const c = e.cause
      out.cause = typeof c === 'string' ? c : (c && c.message ? String(c.message) : String(c))
      if (c && c.code != null) out.causeCode = String(c.code)
    }
  } catch (_) {}
  return out
}

function explainOpenAICompatibleDiagnoseFailure(cfg, apiKey, err) {
  const provider = String(cfg && cfg.provider || '').trim().toLowerCase()
  const message = err && err.message ? String(err.message) : String(err || '')
  const status = err && typeof err.status === 'number' ? Number(err.status) : null
  if (provider === 'localoxml' && !apiKey && status === 401) {
    return 'API key required; admin/chat may work via browser session, but Game Studio needs a Bearer API key'
  }
  if (provider === 'localoxml' && status === 401) {
    return 'unauthorized_api_key'
  }
  return message || 'request_failed'
}

function blueprintReviewSchema() {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      verdict: { type: 'string', enum: ['ok', 'warn', 'error'] },
      summary: { type: 'string', minLength: 1, maxLength: 400 },
      rootCauses: {
        type: 'array',
        minItems: 0,
        maxItems: 12,
        items: { type: 'string', minLength: 1, maxLength: 200 }
      },
      userFacingExplanation: {
        type: 'array',
        minItems: 0,
        maxItems: 12,
        items: { type: 'string', minLength: 1, maxLength: 220 }
      },
      suggestedEdits: {
        type: 'array',
        minItems: 0,
        maxItems: 24,
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            target: { type: 'string', description: '要修改的卡片/节点名称（尽量用 name，不用 id）' },
            change: { type: 'string', minLength: 1, maxLength: 240 },
            example: { type: ['string', 'null'], maxLength: 500 }
          },
          required: ['target', 'change', 'example']
        }
      }
    },
    required: ['verdict', 'summary', 'rootCauses', 'userFacingExplanation', 'suggestedEdits']
  }
}

export async function reviewBlueprintViaOpenAI({ projectTitle, formula, scripts, report, validation, provider, apiUrl, model: modelOverride, proxyUrl }) {
  const cfg = getOpenAIConfig(provider, { apiUrl, model: modelOverride })
  const { model, timeoutMs } = cfg
  const startedAt = Date.now()

  const instructions =
    `你是交互式故事工具的“蓝图解析审查助手”。\n` +
    `输入包含：脚本卡片、结构公式、编译提示、图校验结果。\n` +
    `任务：用中文解释“为什么会出现这些提示/不可达节点/结构不匹配”，并给出可操作的脚本修改建议。\n` +
    `要求：\n` +
    `- 只分析与修正脚本层（cards.name/text），不要要求用户手工改蓝图 ID。\n` +
    `- 用“卡片名称/选择点名称/结局名称”描述问题，不要输出 nodeId。\n` +
    `- 若出现“不可达结局”，说明哪个分支没有指向它，并给出 1~2 种修正方式（例如把最后一次选择的某个后果卡改名为结局2，或在后果卡后加“继续→结局2”的承接卡）。\n` +
    `- 若出现“后果卡编号不匹配”，强调 i 是“第几个选择点”，不是卡片序号，并指出应改成 i后果k。\n`

  const inputObj = {
    projectTitle: String(projectTitle || ''),
    formula: formula || null,
    scripts: scripts || null,
    report: report || null,
    validation: validation || null
  }

  const schema = blueprintReviewSchema()
  const body = {
    model,
    instructions,
    input: JSON.stringify(inputObj),
    text: {
      format: {
        type: 'json_schema',
        name: 'blueprint_review',
        strict: true,
        schema
      }
    }
  }

  try {
    const resp = await openaiRequestJson({ method: 'POST', path: '/responses', body, timeoutMs, provider: cfg.provider, apiUrl, proxyUrl })
    const text = extractResponseOutputText(resp)
    if (!text) throw new Error('empty_ai_output')
    return {
      review: JSON.parse(text),
      meta: { provider: cfg.provider, api: 'responses', model, durationMs: Math.max(0, Date.now() - startedAt) }
    }
  } catch (e) {
    return {
      review: {
        verdict: 'warn',
        summary: 'AI 分析失败（已回退为本地提示）。',
        rootCauses: [e instanceof Error ? e.message : String(e)],
        userFacingExplanation: [],
        suggestedEdits: []
      },
      meta: { provider: cfg.provider, api: 'responses', model, durationMs: Math.max(0, Date.now() - startedAt), error: errToPlain(e) }
    }
  }
}

function formatRulesForInstructions(rules) {
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
}

function formatFormulaForInstructions(formula) {
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
}

export async function diagnoseOpenAI({ timeoutMs, provider = 'openai', apiUrl, model, proxyUrl } = {}) {
  const startedAt = Date.now()
  const cfg = getOpenAIConfig(provider, { apiUrl, model })
  const { apiKey, baseUrl, model: resolvedModel, timeoutMs: cfgTimeout } = cfg
  const useTimeout = Number(timeoutMs || cfgTimeout || 20000)

  const url = new URL(baseUrl.endsWith('/v1') ? baseUrl : `${baseUrl}/v1`)
  const hostname = url.hostname

  let dnsInfo = null
  try {
    const ips = await dns.lookup(hostname, { all: true })
    dnsInfo = { ok: true, hostname, ips: ips.map((x) => x.address).slice(0, 10) }
  } catch (e) {
    dnsInfo = { ok: false, hostname, error: errToPlain(e) }
  }

  const proxy = getProxyInfo()
  if (!apiKey && cfg.provider !== 'localoxml') {
    return {
      ok: false,
      provider: cfg.provider,
      baseUrl,
      model: resolvedModel,
      keyPresent: false,
      proxy,
      dns: dnsInfo,
      error: { message: 'missing_openai_api_key' },
      durationMs: Math.max(0, Date.now() - startedAt)
    }
  }

  try {
    const json = await openaiRequestJson({ method: 'GET', path: '/models', timeoutMs: useTimeout, provider: cfg.provider, apiUrl, proxyUrl })
    const ids = Array.isArray(json && json.data) ? json.data.map((m) => m && m.id).filter(Boolean) : []
    const hasModel = ids.includes(resolvedModel)
    return {
      ok: hasModel,
      provider: cfg.provider,
      baseUrl,
      model: resolvedModel,
      keyPresent: Boolean(apiKey),
      proxy,
      dns: dnsInfo,
      note: hasModel ? 'verified' : 'model_not_found',
      models: { count: ids.length, ids: ids.slice(0, 5000), hasModel },
      error: hasModel ? null : { message: `configured model not found: ${resolvedModel}`, code: 'model_not_found' },
      durationMs: Math.max(0, Date.now() - startedAt)
    }
  } catch (e) {
    return {
      ok: false,
      provider: cfg.provider,
      baseUrl,
      model: resolvedModel,
      keyPresent: Boolean(apiKey),
      proxy,
      dns: dnsInfo,
      note: explainOpenAICompatibleDiagnoseFailure(cfg, apiKey, e),
      error: errToPlain(e),
      durationMs: Math.max(0, Date.now() - startedAt)
    }
  }
}

export function getOpenAIConfigPublic(provider = 'openai', options = null) {
  const cfg = getOpenAIConfig(provider, options)
  const { apiKey, baseUrl, timeoutMs, model } = cfg
  return { provider: cfg.provider, baseUrl, timeoutMs, model, keyPresent: Boolean(apiKey) }
}
