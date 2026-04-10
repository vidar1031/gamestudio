import { spawn } from 'node:child_process'

function clampInt(n, min, max, fallback) {
  const v = Number(n)
  if (!Number.isFinite(v)) return fallback
  return Math.max(min, Math.min(max, Math.floor(v)))
}

function stripJsonCodeFence(s) {
  const raw = String(s || '').trim()
  if (!raw) return ''
  const fenced = raw.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)
  return fenced ? String(fenced[1] || '').trim() : raw
}

function extractFirstJsonObject(s) {
  const text = String(s || '')
  let start = -1
  let depth = 0
  let inStr = false
  let escaped = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (inStr) {
      if (escaped) {
        escaped = false
        continue
      }
      if (ch === '\\') {
        escaped = true
        continue
      }
      if (ch === '"') inStr = false
      continue
    }
    if (ch === '"') {
      inStr = true
      continue
    }
    if (ch === '{') {
      if (depth === 0) start = i
      depth += 1
      continue
    }
    if (ch === '}') {
      if (depth <= 0) continue
      depth -= 1
      if (depth === 0 && start >= 0) return text.slice(start, i + 1).trim()
    }
  }
  return ''
}

function sanitizeUrl(v) {
  const s = String(v || '').trim()
  if (!s) return ''
  try {
    const u = new URL(s)
    if (!/^https?:$/i.test(String(u.protocol || ''))) return ''
    return u.toString().replace(/\/+$/, '')
  } catch (_) {
    return ''
  }
}

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

function getOllamaBaseUrl(raw) {
  const fromEnv =
    String(raw || '').trim() ||
    String(process.env.STUDIO_OLLAMA_URL || '').trim() ||
    String(process.env.OLLAMA_HOST || '').trim() ||
    String(process.env.OLLAMA_URL || '').trim()
  const normalized = sanitizeUrl(fromEnv)
  return normalized || 'http://127.0.0.1:11434'
}

function getOllamaDefaultModel() {
  return (
    String(process.env.STUDIO_OLLAMA_MODEL || '').trim() ||
    String(process.env.OLLAMA_MODEL || '').trim() ||
    'qwen3:8b'
  )
}

export function getOllamaTextConfigSnapshot({ apiUrl, model } = {}) {
  const baseUrl = getOllamaBaseUrl(apiUrl)
  const useModel = String(model || '').trim() || getOllamaDefaultModel()
  return { provider: 'ollama', api: 'chat', baseUrl, model: useModel }
}

function curlRequestJson({ url, method, headers, body, timeoutMs, proxyUrl }) {
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

async function ollamaChat({ messages, model, temperature, timeoutMs, proxyUrl, apiUrl, think = false }) {
  const cfg = getOllamaTextConfigSnapshot({ apiUrl, model })
  const url = `${cfg.baseUrl}/api/chat`

  const payload = {
    model: cfg.model,
    stream: false,
    think,
    messages: Array.isArray(messages) ? messages : [],
    options: {
      temperature: Number.isFinite(Number(temperature)) ? Number(temperature) : 0.2
    },
    // Ask Ollama to enforce JSON output where possible.
    format: 'json'
  }

  const startedAt = Date.now()
  const useTimeoutMs = clampInt(timeoutMs, 5_000, 180_000, 60_000)
  const useProxyUrl = shouldBypassProxyForTarget(url) ? '' : String(proxyUrl || '').trim()
  try {
    const msgCount = Array.isArray(payload.messages) ? payload.messages.length : 0
    let chars = 0
    try {
      for (const m of payload.messages || []) chars += String(m && m.content != null ? m.content : '').length
    } catch (_) {}
    console.log(
      `[gamestudio] ollama.llm:start api=${url} model=${cfg.model} msgs=${msgCount} chars=${chars} proxy=${useProxyUrl ? 'on' : 'off'} timeoutMs=${useTimeoutMs}`
    )
  } catch (_) {}

  const json = await curlRequestJson({
    url,
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: payload,
    timeoutMs: useTimeoutMs,
    proxyUrl: useProxyUrl
  })

  let content = ''
  try {
    const msg = json && typeof json === 'object' ? json.message : null
    content = msg && typeof msg === 'object' && typeof msg.content === 'string' ? msg.content.trim() : ''
  } catch (_) {
    content = ''
  }

  return {
    json,
    content,
    meta: {
      provider: 'ollama',
      api: 'chat',
      model: cfg.model,
      baseUrl: cfg.baseUrl,
      durationMs: Math.max(0, Date.now() - startedAt)
    }
  }
}

export async function generateTextViaOllamaChat({
  instructions,
  input,
  model,
  apiUrl,
  timeoutMs,
  proxyUrl,
  think = false
}) {
  const messages = [
    { role: 'system', content: String(instructions || '').trim() },
    { role: 'user', content: String(input || '').trim() }
  ]
  const { content, meta } = await ollamaChat({ messages, model, apiUrl, timeoutMs, proxyUrl, think })
  return { text: String(content || '').trim(), meta }
}

function validateScriptDraft(draft) {
  if (!draft || typeof draft !== 'object') return { ok: false, reason: 'not_object' }
  const titleOk = (v) => v == null || typeof v === 'string'
  const cardsOk = (arr) =>
    Array.isArray(arr) &&
    arr.length >= 3 &&
    arr.length <= 20 &&
    arr.every((c) => c && typeof c === 'object' && typeof c.name === 'string' && c.name.trim() && typeof c.text === 'string' && c.text.trim())
  if (!('title' in draft) || !titleOk(draft.title)) return { ok: false, reason: 'invalid_title' }
  if (!('cards' in draft) || !cardsOk(draft.cards)) return { ok: false, reason: 'invalid_cards' }
  return { ok: true, reason: 'ok' }
}

export async function generateStrictJsonViaOllamaChat({
  instructions,
  input,
  model,
  apiUrl,
  timeoutMs,
  proxyUrl,
  maxRetries,
  validate,
  think = false
}) {
  const retries = clampInt(maxRetries, 0, 4, 1)
  const useValidate = typeof validate === 'function' ? validate : (obj) => Boolean(obj && typeof obj === 'object')

  let lastText = ''
  let lastMeta = null

  for (let i = 0; i <= retries; i++) {
    const messages = [
      { role: 'system', content: String(instructions || '').trim() },
      { role: 'user', content: String(input || '').trim() }
    ]
    if (i > 0 && lastText) {
      messages.push({
        role: 'user',
        content:
          `上一次输出无法解析为符合要求的 JSON（可能包含解释文字/多余字段/格式错误）。\n` +
          `请你只输出严格 JSON（不要加任何解释），并修正上次问题。\n` +
          `上一次输出如下：\n` +
          `${String(lastText).slice(0, 8000)}`
      })
    }

    const { content, meta } = await ollamaChat({ messages, model, apiUrl, timeoutMs, proxyUrl, think })
    lastMeta = meta
    lastText = content

    const cleaned = stripJsonCodeFence(content)
    const candidates = [
      cleaned,
      extractFirstJsonObject(cleaned),
      extractFirstJsonObject(content)
    ].filter(Boolean)

    let parsed = null
    for (const cand of candidates) {
      try {
        parsed = cand ? JSON.parse(cand) : null
      } catch (_) {
        parsed = null
      }
      if (parsed && typeof parsed === 'object') break
    }

    const ok = Boolean(useValidate(parsed))
    if (ok) return { parsed, text: cleaned, meta }
  }

  const e = new Error('ollama_invalid_json_output')
  e.status = 502
  e.meta = lastMeta
  e.output = lastText
  throw e
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
    return lines.join('\n').trim().slice(0, 2500)
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

export async function generateScriptsViaOllama({ prompt, title, rules, formula, model, apiUrl, proxyUrl, timeoutMs }) {
  const startedAt = Date.now()
  const rulesText = formatRulesForInstructions(rules)
  const formulaText = formatFormulaForInstructions(formula)

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
    `- 分支连续性必须自洽：如果多个分支会重新合流到同一张卡，这张合流卡只能描述“所有上游分支都成立的共同事实”；若某个状态只属于单一路径，就不能写进共享合流卡，必须拆成不同承接卡或不同选择点。\n` +
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

  const { parsed, meta } = await generateStrictJsonViaOllamaChat({
    instructions,
    input: user,
    model: String(model || '').trim() || undefined,
    apiUrl,
    proxyUrl,
    timeoutMs: clampInt(timeoutMs, 5_000, 180_000, clampInt(process.env.STUDIO_AI_TIMEOUT_MS, 5_000, 180_000, 90_000)),
    maxRetries: 2,
    validate: (obj) => validateScriptDraft(obj).ok
  })

  return { draft: parsed, meta: { ...meta, durationMs: Math.max(0, Date.now() - startedAt) } }
}

export async function repairScriptsViaOllama({
  projectTitle,
  scripts,
  rules,
  formula,
  report,
  validation,
  model,
  apiUrl,
  proxyUrl,
  timeoutMs
}) {
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
    `- 分支连续性必须自洽：如果多个分支重新合流到同一张卡，这张卡只能写所有分支都共同成立的事实；若引用了某一条路径专属状态，必须拆成不同承接卡，不得硬合流。\n` +
    `- 结局只能引用当前路径真实发生过的事件，不能偷用其他分支的记忆。\n` +
    `- text 中必须使用真实换行，不要输出字面量 \\n。\n` +
    `- 控制长度：卡片总数 <= 20；每张卡 text 1~4 句即可。\n` +
    `- 使用中文。\n` +
    (formulaText ? `\n本次结构公式（必须严格满足）：\n${formulaText}\n` : '') +
    (rulesText ? `\n全局规则（人工可编辑，必须遵守）：\n${rulesText}\n` : '')

  const user =
    (projectTitle ? `故事名（全局锁定）：《${String(projectTitle).trim()}》\n\n` : '') +
    (diagText ? `当前编译/校验反馈（用来修复问题）：\n${diagText}\n\n` : '') +
    `当前脚本（需要你修复）：\n${cardsText}\n`

  const { parsed, meta } = await generateStrictJsonViaOllamaChat({
    instructions,
    input: user,
    model: String(model || '').trim() || undefined,
    apiUrl,
    proxyUrl,
    timeoutMs: clampInt(timeoutMs, 5_000, 180_000, clampInt(process.env.STUDIO_AI_TIMEOUT_MS, 5_000, 180_000, 90_000)),
    maxRetries: 2,
    validate: (obj) => validateScriptDraft(obj).ok
  })

  return { draft: parsed, meta: { ...meta, durationMs: Math.max(0, Date.now() - startedAt) } }
}

export async function diagnoseOllamaText({ model, apiUrl, timeoutMs, proxyUrl, deepText } = {}) {
  const cfg = getOllamaTextConfigSnapshot({ apiUrl, model })
  const url = `${cfg.baseUrl}/api/version`
  const useProxyUrl = shouldBypassProxyForTarget(url) ? '' : String(proxyUrl || '').trim()
  try {
    if (!deepText) {
      // Lightweight check: service reachable + model exists (without running full generation).
      await curlRequestJson({
        url: `${cfg.baseUrl}/api/show`,
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: { model: cfg.model },
        timeoutMs: clampInt(timeoutMs, 1_000, 30_000, 8_000),
        proxyUrl: useProxyUrl
      })
      return { ok: true, note: 'configured_model_ok', ...cfg }
    }

    const { parsed, meta } = await generateStrictJsonViaOllamaChat({
      instructions: '输出一个 JSON：{"ok":true}，只输出 JSON。',
      input: '请输出 {"ok":true}',
      model: cfg.model,
      apiUrl: cfg.baseUrl,
      proxyUrl: useProxyUrl,
      timeoutMs: clampInt(timeoutMs, 1_000, 60_000, 12_000),
      maxRetries: 1,
      validate: (x) => Boolean(x && typeof x === 'object' && x.ok === true)
    })
    return { ok: Boolean(parsed && parsed.ok === true), note: 'verified', meta, ...cfg }
  } catch (e) {
    return { ok: false, note: e && e.message ? String(e.message) : String(e), ...cfg }
  }
}
