import { openaiResponsesJsonForTools } from './openai.js'
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

function normalizeIdLike(s) {
  const out = String(s || '').trim()
  if (!out) return ''
  return out.replace(/\s+/g, '_').replace(/[^a-zA-Z0-9_.-]+/g, '_').slice(0, 80)
}

function normalizeStoryBible(obj) {
  const input = obj && typeof obj === 'object' ? obj : {}
  // Some models output maps: { characters: { protagonist: {...} } }
  const charsIn = listFromMaybeMap(input.characters)
  const propsIn = listFromMaybeMap(input.props)
  const locsIn = listFromMaybeMap(input.locations)
  const scenesIn = input.sceneRefs && typeof input.sceneRefs === 'object' ? input.sceneRefs : (input.scenes && typeof input.scenes === 'object' ? input.scenes : {})

  const normChar = (x) => {
    const idRaw = x && (x.id || x.characterId || x.character_id) ? (x.id || x.characterId || x.character_id) : ''
    const id = clampStr(idRaw, 80)
    const name = clampStr(x && x.name ? x.name : '', 80)
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
    const idRaw = x && (x.id || x.propId || x.prop_id) ? (x.id || x.propId || x.prop_id) : ''
    const id = clampStr(idRaw, 80)
    const name = clampStr(x && x.name ? x.name : '', 80)
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
    const idRaw = x && (x.id || x.locationId || x.location_id) ? (x.id || x.locationId || x.location_id) : ''
    const id = clampStr(idRaw, 80)
    const name = clampStr(x && x.name ? x.name : '', 80)
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
      characters: uniqStrings(v.characters, 40),
      props: uniqStrings(v.props, 60),
      locations: uniqStrings(v.locations, 40)
    }
  }

  return {
    schemaVersion: '1.0',
    worldAnchor: clampStr(input.worldAnchor || input.world_anchor || '', 600),
    characters,
    props,
    locations,
    eventChain: uniqStrings(input.eventChain || input.event_chain || [], 80),
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

export async function generateStoryBible({
  provider,
  model,
  proxyUrl,
  timeoutMs,
  input
}) {
  const p = String(provider || '').trim().toLowerCase()
  const t = clampInt(timeoutMs, 5_000, 180_000, 90_000)
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

  if (p === 'openai') {
    const body = {
      instructions,
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
    const { json, meta } = await openaiResponsesJsonForTools({ body, proxyUrl })
    const outText = typeof json.output_text === 'string' ? json.output_text : ''
    if (!outText) throw new Error('empty_ai_output')
    const parsed = JSON.parse(outText)
    const normalized = normalizeStoryBible(parsed)
    if (!validateStoryBible(normalized)) throw new Error('invalid_story_bible')
    return { result: normalized, meta }
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
