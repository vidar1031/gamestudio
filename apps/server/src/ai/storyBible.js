import { extractResponseOutputText, openaiResponsesJsonForTools } from './openai.js'
import { generateStrictJsonViaDoubaoChat } from './doubao.js'
import { generateStrictJsonViaOllamaChat } from './ollama.js'

function clampInt(n, min, max, fallback) {
  const x = Number(n)
  if (!Number.isFinite(x)) return fallback
  return Math.max(min, Math.min(max, Math.floor(x)))
}

function clampStr(s, maxLen) {
  const out = String(s || '').trim()
  if (!out) return ''
  return out.length <= maxLen ? out : out.slice(0, maxLen)
}

function uniqStrings(arr, max = 200) {
  const out = []
  const seen = new Set()
  const list = Array.isArray(arr) ? arr : []
  for (const x0 of list) {
    const x = String(x0 || '').trim()
    if (!x) continue
    const key = x.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(x)
    if (out.length >= max) break
  }
  return out
}

function listFromMaybeMap(v) {
  if (Array.isArray(v)) return v
  if (v && typeof v === 'object') return Object.values(v)
  return []
}

function listEntriesFromMaybeMap(v) {
  if (Array.isArray(v)) return v.map((item) => (item && typeof item === 'object' ? item : {}))
  if (v && typeof v === 'object') {
    return Object.entries(v).map(([key, value]) => {
      if (value && typeof value === 'object') return { __key: key, ...value }
      return { __key: key }
    })
  }
  return []
}

function normalizeIdLike(s) {
  const out = String(s || '').trim()
  if (!out) return ''
  return out.replace(/\s+/g, '_').replace(/[^a-zA-Z0-9_.-]+/g, '_').slice(0, 80)
}

function normalizeStoryBible(obj) {
  const input = obj && typeof obj === 'object' ? obj : {}
  // Some models output maps: { characters: { protagonist: {...} } }
  const charsIn = listEntriesFromMaybeMap(input.characters)
  const propsIn = listEntriesFromMaybeMap(input.props)
  const locsIn = listEntriesFromMaybeMap(input.locations)
  const scenesIn = input.sceneRefs && typeof input.sceneRefs === 'object' ? input.sceneRefs : (input.scenes && typeof input.scenes === 'object' ? input.scenes : {})

  const normChar = (x) => {
    const mapKey = clampStr(x && x.__key ? x.__key : '', 80)
    const idRaw = x && (x.id || x.characterId || x.character_id) ? (x.id || x.characterId || x.character_id) : mapKey
    const id = clampStr(idRaw, 80)
    const name = clampStr(x && (x.name || x.characterName || x.character_name) ? (x.name || x.characterName || x.character_name) : mapKey, 80)
    return {
      id: id || (name ? `char.${normalizeIdLike(name).slice(0, 40)}` : ''),
      name,
      aliases: uniqStrings(x && x.aliases, 20),
      // Some outputs use fingerprintPrompt instead of anchorPrompt; accept both.
      anchorPrompt: clampStr((x && (x.anchorPrompt || x.fingerprintPrompt || x.fingerprint_prompt)) ? (x.anchorPrompt || x.fingerprintPrompt || x.fingerprint_prompt) : '', 300),
      negativePrompt: clampStr(x && x.negativePrompt ? x.negativePrompt : '', 200),
      locked: Boolean(x && x.locked !== false)
    }
  }

  const normProp = (x) => {
    const mapKey = clampStr(x && x.__key ? x.__key : '', 80)
    const idRaw = x && (x.id || x.propId || x.prop_id) ? (x.id || x.propId || x.prop_id) : mapKey
    const id = clampStr(idRaw, 80)
    const name = clampStr(x && (x.name || x.propName || x.prop_name) ? (x.name || x.propName || x.prop_name) : mapKey, 80)
    return {
      id: id || (name ? `prop.${normalizeIdLike(name).slice(0, 40)}` : ''),
      name,
      aliases: uniqStrings(x && x.aliases, 20),
      anchorPrompt: clampStr(x && x.anchorPrompt ? x.anchorPrompt : '', 300),
      forbiddenSubstitutes: uniqStrings(x && (x.forbiddenSubstitutes || x.forbidden_substitutes), 40),
      locked: Boolean(x && x.locked !== false)
    }
  }

  const normLoc = (x) => {
    const mapKey = clampStr(x && x.__key ? x.__key : '', 80)
    const idRaw = x && (x.id || x.locationId || x.location_id) ? (x.id || x.locationId || x.location_id) : mapKey
    const id = clampStr(idRaw, 80)
    const name = clampStr(x && (x.name || x.locationName || x.location_name) ? (x.name || x.locationName || x.location_name) : mapKey, 80)
    return {
      id: id || (name ? `loc.${normalizeIdLike(name).slice(0, 40)}` : ''),
      name,
      aliases: uniqStrings(x && x.aliases, 20),
      anchorPrompt: clampStr(x && x.anchorPrompt ? x.anchorPrompt : '', 260),
      locked: Boolean(x && x.locked !== false)
    }
  }

  const characters = charsIn.map(normChar).filter((x) => x.id && x.name).slice(0, 60)
  const props = propsIn.map(normProp).filter((x) => x.id && x.name).slice(0, 120)
  const locations = locsIn.map(normLoc).filter((x) => x.id && x.name).slice(0, 80)

  const sceneRefs = {}
  for (const [k0, v0] of Object.entries(scenesIn || {})) {
    const k = clampStr(k0, 120)
    if (!k) continue
    const v = v0 && typeof v0 === 'object' ? v0 : {}
    sceneRefs[k] = {
      characters: uniqStrings(v.characters || v.characterId || v.characterIds || v.character_id || v.character_ids, 40),
      props: uniqStrings(v.props || v.propId || v.propIds || v.prop_id || v.prop_ids, 60),
      locations: uniqStrings(v.locations || v.locationId || v.locationIds || v.location_id || v.location_ids, 40)
    }
  }

  const eventChainIn = input.eventChain || input.event_chain || []
  const eventChain = Array.isArray(eventChainIn)
    ? uniqStrings(eventChainIn, 80)
    : uniqStrings(eventChainIn && typeof eventChainIn === 'object' ? Object.values(eventChainIn) : [], 80)

  return {
    schemaVersion: '1.0',
    worldAnchor: clampStr(input.worldAnchor || input.world_anchor || '', 600),
    characters,
    props,
    locations,
    eventChain,
    forbiddenSubstitutes: uniqStrings(input.forbiddenSubstitutes || input.forbidden_substitutes || [], 120),
    sceneRefs
  }
}

function validateStoryBible(obj) {
  const b = normalizeStoryBible(obj)
  if (!b.worldAnchor) return false
  // At least something to lock.
  if (!b.characters.length && !b.props.length && !b.locations.length) return false
  return true
}

function storyBibleSchema() {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      schemaVersion: { type: 'string' },
      worldAnchor: { type: 'string', minLength: 1, maxLength: 600 },
      characters: {
        type: 'array',
        maxItems: 60,
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            id: { type: 'string', maxLength: 80 },
            name: { type: 'string', maxLength: 80 },
            aliases: { type: 'array', items: { type: 'string', maxLength: 80 }, maxItems: 20 },
            anchorPrompt: { type: 'string', maxLength: 300 },
            negativePrompt: { type: ['string', 'null'], maxLength: 200 },
            locked: { type: ['boolean', 'null'] }
          },
          required: ['id', 'name', 'anchorPrompt']
        }
      },
      props: {
        type: 'array',
        maxItems: 120,
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            id: { type: 'string', maxLength: 80 },
            name: { type: 'string', maxLength: 80 },
            aliases: { type: 'array', items: { type: 'string', maxLength: 80 }, maxItems: 20 },
            anchorPrompt: { type: 'string', maxLength: 300 },
            forbiddenSubstitutes: { type: 'array', items: { type: 'string', maxLength: 80 }, maxItems: 40 },
            locked: { type: ['boolean', 'null'] }
          },
          required: ['id', 'name', 'anchorPrompt']
        }
      },
      locations: {
        type: 'array',
        maxItems: 80,
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            id: { type: 'string', maxLength: 80 },
            name: { type: 'string', maxLength: 80 },
            aliases: { type: 'array', items: { type: 'string', maxLength: 80 }, maxItems: 20 },
            anchorPrompt: { type: 'string', maxLength: 260 },
            locked: { type: ['boolean', 'null'] }
          },
          required: ['id', 'name', 'anchorPrompt']
        }
      },
      eventChain: { type: 'array', items: { type: 'string', maxLength: 160 }, maxItems: 80 },
      forbiddenSubstitutes: { type: 'array', items: { type: 'string', maxLength: 80 }, maxItems: 120 },
      sceneRefs: {
        type: 'object',
        additionalProperties: {
          type: 'object',
          additionalProperties: false,
          properties: {
            characters: { type: 'array', items: { type: 'string', maxLength: 80 }, maxItems: 40 },
            props: { type: 'array', items: { type: 'string', maxLength: 80 }, maxItems: 60 },
            locations: { type: 'array', items: { type: 'string', maxLength: 80 }, maxItems: 40 }
          },
          required: ['characters', 'props', 'locations']
        }
      }
    },
    required: ['worldAnchor', 'characters', 'props', 'locations', 'eventChain', 'forbiddenSubstitutes', 'sceneRefs']
  }
}

function extractFirstJsonObjectText(raw) {
  const s = String(raw || '').trim()
  if (!s) return ''
  const start = s.indexOf('{')
  if (start < 0) return ''
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = start; i < s.length; i += 1) {
    const ch = s[i]
    if (inString) {
      if (escaped) {
        escaped = false
        continue
      }
      if (ch === '\\') {
        escaped = true
        continue
      }
      if (ch === '"') inString = false
      continue
    }
    if (ch === '"') {
      inString = true
      continue
    }
    if (ch === '{') depth += 1
    else if (ch === '}') {
      depth -= 1
      if (depth === 0) return s.slice(start, i + 1)
    }
  }
  return ''
}

function parseStoryBibleJsonText(rawText) {
  const raw = String(rawText || '').trim()
  if (!raw) {
    const e = new Error('empty_ai_output')
    e.code = 'empty_ai_output'
    throw e
  }
  try {
    return JSON.parse(raw)
  } catch (_) {}

  const objText = extractFirstJsonObjectText(raw)
  if (objText) {
    try {
      return JSON.parse(objText)
    } catch (_) {}
  }

  const preview = raw.slice(0, 120).replace(/\s+/g, ' ').trim()
  const e = new Error(`invalid_json_response:${preview}`)
  e.code = 'invalid_json_response'
  throw e
}

export async function generateStoryBible({
  provider,
  model,
  proxyUrl,
  timeoutMs,
  input
}) {
  const p = String(provider || '').trim().toLowerCase()
  const timeoutRaw = Number(timeoutMs)
  const t = (Number.isFinite(timeoutRaw) && timeoutRaw <= 0) ? 0 : clampInt(timeoutMs, 5_000, 180_000, 90_000)
  const schema = storyBibleSchema()

  const instructions =
    `你是“交互故事制作工具”的连续分镜一致性助手。\n` +
    `任务：基于输入的“故事摘要 + 角色指纹 + 场景出现关系”，产出一个 Story Bible（严格 JSON）。\n` +
    `目标：让后续每个场景生图都能稳定复用角色/道具/地点，避免变脸、换装、道具替换、时代跳变。\n` +
    `要求：\n` +
    `- 输出必须是唯一 JSON 对象，不要解释文字。\n` +
    `- worldAnchor：一句到两句英文，包含时代/地域/建筑语言/光照色调/镜头语言。\n` +
    `- characters：逐角色输出 anchorPrompt（英文，一行，稳定外观指纹：年龄段、脸型、发型、服装、配饰、配色）。如果输入里给了 fingerprintPrompt，优先沿用并精炼。\n` +
    `- props：逐道具输出 anchorPrompt（英文，一行，结构级描述：部件/材质/形状/尺寸感/拿法），并列出 forbiddenSubstitutes。\n` +
    `- locations：可复用地点（市场/宫廷/街道等）输出 anchorPrompt。\n` +
    `- sceneRefs：为每个场景输出它引用的 characterId/propId/locationId（用 id）。\n` +
    `- eventChain：按场景编号列出“可见动作与状态变化”（英文短句），用于连续性对齐。\n` +
    `- forbiddenSubstitutes：汇总全局容易误画的替代物（英文短词）。\n`

  const user = JSON.stringify(input || {}, null, 2)

  if (p === 'openai' || p === 'localoxml') {
    let lastErr = null
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const attemptInstructions =
        attempt === 0
          ? instructions
          : (
              `${instructions}\n` +
              `再次强调：不要输出分析过程、不要输出 markdown、不要输出代码块。` +
              `只输出一个可直接 JSON.parse 的 JSON 对象。`
            )
      const body = {
        instructions: attemptInstructions,
        input: user,
        ...(model ? { model: String(model).trim() } : {}),
        text: {
          format: {
            type: 'json_schema',
            name: 'story_bible',
            strict: true,
            schema
          }
        }
      }
      const { json, meta } = await openaiResponsesJsonForTools({ body, provider: p, proxyUrl, timeoutMs: t })
      const outText = extractResponseOutputText(json)
      try {
        const parsed = parseStoryBibleJsonText(outText)
        const normalized = normalizeStoryBible(parsed)
        if (!validateStoryBible(normalized)) throw new Error('invalid_story_bible')
        return { result: normalized, meta }
      } catch (e) {
        lastErr = e
        if (attempt === 1) throw e
      }
    }
    throw lastErr || new Error('invalid_json_response')
  }

  if (p === 'doubao') {
    const { parsed, meta } = await generateStrictJsonViaDoubaoChat({
      instructions,
      input: user,
      model: model || undefined,
      timeoutMs: t,
      maxRetries: 2,
      validate: validateStoryBible,
      proxyUrl
    })
    const normalized = normalizeStoryBible(parsed)
    if (!validateStoryBible(normalized)) throw new Error('invalid_story_bible')
    return { result: normalized, meta }
  }

  if (p === 'ollama') {
    const { parsed, meta } = await generateStrictJsonViaOllamaChat({
      instructions,
      input: user,
      model: model || undefined,
      timeoutMs: t,
      maxRetries: 1,
      validate: validateStoryBible,
      proxyUrl
    })
    const normalized = normalizeStoryBible(parsed)
    if (!validateStoryBible(normalized)) throw new Error('invalid_story_bible')
    return { result: normalized, meta }
  }

  const e = new Error(`unsupported_provider:${p || 'none'}`)
  e.status = 400
  throw e
}
