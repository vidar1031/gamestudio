import { extractResponseOutputText, openaiResponsesJsonForTools, parseModelJsonLenient } from './openai.js'
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

const TRANSIENT_STATE_PATTERNS = [
  /受伤/g,
  /流血/g,
  /哭泣/g,
  /哭着/g,
  /害怕/g,
  /惊慌/g,
  / frightened /gi,
  / injured /gi,
  / wounded /gi,
  / bleeding /gi,
  / crying /gi,
  / scared /gi,
  / afraid /gi
]

const TRANSIENT_NAME_PREFIX_PATTERNS = [
  /^受伤的/u,
  /^流血的/u,
  /^哭泣的/u,
  /^哭着的/u,
  /^惊慌的/u,
  /^害怕的/u,
  /^injured\s+/i,
  /^wounded\s+/i,
  /^bleeding\s+/i,
  /^crying\s+/i,
  /^frightened\s+/i,
  /^scared\s+/i
]

const EVENT_ALIAS_PATTERNS = [
  /狼嚎/u,
  /喊声/u,
  /叫声/u,
  /哭声/u,
  /howl/i,
  /shout/i,
  /crying?/i,
  /scream/i
]

const GENERIC_ALIAS_SET = new Set(['大家', '众人', '人们', 'everyone', 'everybody'])

function normalizeLooseToken(s) {
  return String(s || '')
    .trim()
    .toLowerCase()
    .replace(/[\s_.-]+/g, '')
}

function matchesAnyPattern(input, patterns) {
  const text = String(input || '')
  if (!text) return false
  return patterns.some((pattern) => pattern.test(text))
}

function stripTransientNamePrefix(input) {
  let out = String(input || '').trim()
  for (const pattern of TRANSIENT_NAME_PREFIX_PATTERNS) {
    out = out.replace(pattern, '').trim()
  }
  return out
}

function sanitizeStablePrompt(input) {
  const segments = String(input || '')
    .split(',')
    .map((segment) => segment.trim())
    .filter(Boolean)
    .filter((segment) => !matchesAnyPattern(` ${segment} `, TRANSIENT_STATE_PATTERNS))
  return clampStr(segments.join(', '), 300)
}

function sanitizeAliases(name, aliases) {
  const stableName = stripTransientNamePrefix(name)
  const stableKey = normalizeLooseToken(stableName)
  const out = []
  const seen = new Set()
  for (const rawAlias of Array.isArray(aliases) ? aliases : []) {
    const stripped = stripTransientNamePrefix(rawAlias)
    const alias = String(stripped || '').trim()
    if (!alias) continue
    if (GENERIC_ALIAS_SET.has(alias)) continue
    if (matchesAnyPattern(alias, EVENT_ALIAS_PATTERNS)) continue
    if (matchesAnyPattern(` ${alias} `, TRANSIENT_STATE_PATTERNS)) continue
    const aliasKey = normalizeLooseToken(alias)
    if (!aliasKey || aliasKey === stableKey || seen.has(aliasKey)) continue
    seen.add(aliasKey)
    out.push(alias)
  }
  return out
}

function buildEntityUsageCounts(sceneRefs) {
  const characterCounts = new Map()
  const propCounts = new Map()
  const locationCounts = new Map()
  for (const value of Object.values(sceneRefs || {})) {
    const entry = value && typeof value === 'object' ? value : {}
    for (const id of uniqStrings(entry.characters, 200)) {
      characterCounts.set(id, (characterCounts.get(id) || 0) + 1)
    }
    for (const id of uniqStrings(entry.props, 200)) {
      propCounts.set(id, (propCounts.get(id) || 0) + 1)
    }
    for (const id of uniqStrings(entry.locations, 200)) {
      locationCounts.set(id, (locationCounts.get(id) || 0) + 1)
    }
  }
  return { characterCounts, propCounts, locationCounts }
}

function isTransientSingleSceneProp(prop, usageCount) {
  if (usageCount > 1) return false
  const hay = [prop?.name, ...(Array.isArray(prop?.aliases) ? prop.aliases : []), prop?.anchorPrompt].join(' ')
  return /包扎|伤口|绷带|止血|急救|bandage|wound|bleeding|first aid/i.test(hay)
}

function sanitizeStoryBibleSemantics(obj) {
  const input = normalizeStoryBible(obj)
  const sceneRefs = Object.fromEntries(
    Object.entries(input.sceneRefs || {}).map(([sceneId, value]) => {
      const ref = value && typeof value === 'object' ? value : {}
      return [sceneId, {
        characters: uniqStrings(ref.characters, 40),
        props: uniqStrings(ref.props, 60),
        locations: uniqStrings(ref.locations, 40).slice(0, 1)
      }]
    })
  )
  const usage = buildEntityUsageCounts(sceneRefs)

  const characters = input.characters.map((character) => {
    const stableName = clampStr(stripTransientNamePrefix(character.name) || character.name, 80)
    return {
      ...character,
      name: stableName,
      aliases: sanitizeAliases(stableName, character.aliases),
      anchorPrompt: sanitizeStablePrompt(character.anchorPrompt),
      negativePrompt: clampStr(character.negativePrompt, 200)
    }
  })

  const droppedPropIds = new Set()
  const props = input.props
    .map((prop) => ({
      ...prop,
      aliases: sanitizeAliases(prop.name, prop.aliases),
      anchorPrompt: sanitizeStablePrompt(prop.anchorPrompt)
    }))
    .filter((prop) => {
      const usageCount = usage.propCounts.get(prop.id) || 0
      if (!isTransientSingleSceneProp(prop, usageCount)) return true
      droppedPropIds.add(prop.id)
      return false
    })

  const locations = input.locations.map((location) => ({
    ...location,
    aliases: sanitizeAliases(location.name, location.aliases)
  }))

  const sanitizedSceneRefs = Object.fromEntries(
    Object.entries(sceneRefs).map(([sceneId, value]) => {
      const ref = value && typeof value === 'object' ? value : {}
      return [sceneId, {
        characters: uniqStrings(ref.characters, 40),
        props: uniqStrings((ref.props || []).filter((id) => !droppedPropIds.has(id)), 60),
        locations: uniqStrings(ref.locations, 40).slice(0, 1)
      }]
    })
  )

  return {
    ...input,
    characters,
    props,
    locations,
    sceneRefs: sanitizedSceneRefs,
    forbiddenSubstitutes: uniqStrings([
      ...input.forbiddenSubstitutes,
      ...props.flatMap((prop) => Array.isArray(prop.forbiddenSubstitutes) ? prop.forbiddenSubstitutes : [])
    ], 120)
  }
}

function normalizeStoryBible(obj) {
  const input = obj && typeof obj === 'object' ? obj : {}
  // Some models output maps: { characters: { protagonist: {...} } }
  const charsIn = listEntriesFromMaybeMap(input.characters)
  const propsIn = listEntriesFromMaybeMap(input.props)
  const locsIn = listEntriesFromMaybeMap(input.locations)
  const scenesRaw = input.sceneRefs != null ? input.sceneRefs : input.scenes
  const scenesIn = Array.isArray(scenesRaw)
    ? scenesRaw
    : (scenesRaw && typeof scenesRaw === 'object' ? scenesRaw : {})

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
  if (Array.isArray(scenesIn)) {
    for (const raw of scenesIn) {
      const v = raw && typeof raw === 'object' ? raw : {}
      const sceneId = clampStr(v.sceneId || v.scene_id || v.id || v.key, 120)
      if (!sceneId) continue
      sceneRefs[sceneId] = {
        characters: uniqStrings(v.characters || v.characterId || v.characterIds || v.character_id || v.character_ids, 40),
        props: uniqStrings(v.props || v.propId || v.propIds || v.prop_id || v.prop_ids, 60),
        locations: uniqStrings(v.locations || v.locationId || v.locationIds || v.location_id || v.location_ids, 40)
      }
    }
  } else {
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
  }

  const eventChainIn = input.eventChain || input.event_chain || []
  const eventChain = Array.isArray(eventChainIn)
    ? uniqStrings(eventChainIn, 80)
    : uniqStrings(eventChainIn && typeof eventChainIn === 'object' ? Object.values(eventChainIn) : [], 80)

  return {
    schemaVersion: '1.0',
    worldAnchor: sanitizeWorldAnchorText(input.worldAnchor || input.world_anchor || ''),
    characters,
    props,
    locations,
    eventChain,
    forbiddenSubstitutes: uniqStrings(input.forbiddenSubstitutes || input.forbidden_substitutes || [], 120),
    sceneRefs
  }
}

// 2026-09-27 确定性兜底：worldAnchor 只允许纯风格锚点。
// LLM 可能无视指令写入时间/光照/天气变化描述（如 "Soft morning mist transitions to golden hour sunlight"），
// 该句会被拼进每个场景背景导致全场景光照自相矛盾；这里按句剔除，剔空则回退安全风格句。
const WORLD_ANCHOR_FORBIDDEN_CLAUSE = /\b(morning|sunrise|dawn|daybreak|noon|midday|afternoon|sunset|golden hour|evening|dusk|twilight|night|nightfall|lighting transitions?|transitions? to|weather|rain|rainy|snow|snowy|storm|stormy|mist|fog|foggy|overcast)\b/i
const WORLD_ANCHOR_SAFE_FALLBACK = 'warm pastel picture book illustration style, flat 2D cartoon, soft edges, consistent visual designs'
export function sanitizeWorldAnchorText(text) {
  const raw = clampStr(text || '', 600)
  if (!raw) return raw
  const sentences = raw.split(/(?<=[.!?。！？])\s+|\n+/)
  const kept = sentences.filter((s) => s.trim() && !WORLD_ANCHOR_FORBIDDEN_CLAUSE.test(s))
  const joined = kept.join(' ').replace(/\s{2,}/g, ' ').trim()
  return joined || WORLD_ANCHOR_SAFE_FALLBACK
}

function validateStoryBible(obj) {
  const b = normalizeStoryBible(obj)
  if (!b.worldAnchor) return false
  // At least something to lock.
  if (!b.characters.length && !b.props.length && !b.locations.length) return false
  return true
}

function normalizeFallbackEntityEntry(input, kind) {
  const item = input && typeof input === 'object' ? input : {}
  const name = clampStr(item.name || item.title || item.label || item.__key || '', 80)
  const explicitId = clampStr(item.id || item[`${kind}Id`] || item[`${kind}_id`] || '', 80)
  const idPrefix = kind === 'location' ? 'loc' : (kind === 'prop' ? 'prop' : 'char')
  const anchorPrompt = clampStr(item.anchorPrompt || item.fingerprintPrompt || item.fingerprint_prompt || name || '', kind === 'location' ? 260 : 300)
  if (!name && !explicitId) return null
  return {
    id: explicitId || `${idPrefix}.${normalizeIdLike(name || explicitId).slice(0, 40)}`,
    name: name || explicitId,
    aliases: uniqStrings(item.aliases, 20),
    anchorPrompt,
    ...(kind === 'character'
      ? { negativePrompt: clampStr(item.negativePrompt || '', 200) }
      : kind === 'prop'
        ? { forbiddenSubstitutes: uniqStrings(item.forbiddenSubstitutes || item.forbidden_substitutes, 40) }
        : {}),
    locked: item.locked !== false
  }
}

function buildFallbackWorldAnchor(input, normalizedDraft) {
  const fromDraft = clampStr(normalizedDraft?.worldAnchor || '', 600)
  if (fromDraft) return fromDraft
  const hinted = clampStr(input?.candidateWorldHints?.worldAnchor || '', 600)
  if (hinted) return hinted
  const title = clampStr(input?.title || '互动故事', 120)
  const brief = clampStr(input?.brief || '', 220)
  const sceneNames = uniqStrings((input?.scenes || []).map((scene) => scene?.name || scene?.sceneId || '').filter(Boolean), 3).join(', ')
  return clampStr([title, brief, sceneNames].filter(Boolean).join(' | '), 600) || 'story world with stable visual continuity'
}

function buildDeterministicStoryBibleFallback(input, draft) {
  const normalizedDraft = normalizeStoryBible(draft)
  const candidateEntities = input?.candidateEntities && typeof input.candidateEntities === 'object' ? input.candidateEntities : {}
  const fallbackCharacters = listEntriesFromMaybeMap(candidateEntities.characters)
    .map((item) => normalizeFallbackEntityEntry(item, 'character'))
    .filter(Boolean)
  const fallbackProps = listEntriesFromMaybeMap(candidateEntities.props)
    .map((item) => normalizeFallbackEntityEntry(item, 'prop'))
    .filter(Boolean)
  const fallbackLocations = listEntriesFromMaybeMap(candidateEntities.locations)
    .map((item) => normalizeFallbackEntityEntry(item, 'location'))
    .filter(Boolean)

  const fallbackSceneName = clampStr((input?.scenes || []).map((scene) => scene?.name || scene?.nodeName || scene?.sceneId || scene?.nodeId || '').find(Boolean) || '', 80)
  const minimumLocation = fallbackSceneName
    ? [{ id: `loc.${normalizeIdLike(fallbackSceneName).slice(0, 40)}`, name: fallbackSceneName, aliases: [], anchorPrompt: fallbackSceneName, locked: true }]
    : []

  const candidate = sanitizeStoryBibleSemantics({
    ...normalizedDraft,
    worldAnchor: buildFallbackWorldAnchor(input, normalizedDraft),
    characters: normalizedDraft.characters.length > 0 ? normalizedDraft.characters : fallbackCharacters,
    props: normalizedDraft.props.length > 0 ? normalizedDraft.props : fallbackProps,
    locations: normalizedDraft.locations.length > 0 ? normalizedDraft.locations : (fallbackLocations.length > 0 ? fallbackLocations : minimumLocation),
    eventChain: normalizedDraft.eventChain.length > 0
      ? normalizedDraft.eventChain
      : uniqStrings(input?.candidateWorldHints?.eventChain || [], 80),
    forbiddenSubstitutes: uniqStrings([
      ...normalizedDraft.forbiddenSubstitutes,
      ...(Array.isArray(input?.candidateWorldHints?.forbiddenSubstitutes) ? input.candidateWorldHints.forbiddenSubstitutes : [])
    ], 120)
  })
  return candidate
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
          required: ['id', 'name', 'aliases', 'anchorPrompt', 'negativePrompt', 'locked']
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
          required: ['id', 'name', 'aliases', 'anchorPrompt', 'forbiddenSubstitutes', 'locked']
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
          required: ['id', 'name', 'aliases', 'anchorPrompt', 'locked']
        }
      },
      eventChain: { type: 'array', items: { type: 'string', maxLength: 160 }, maxItems: 80 },
      forbiddenSubstitutes: { type: 'array', items: { type: 'string', maxLength: 80 }, maxItems: 120 },
      sceneRefs: {
        type: 'array',
        maxItems: 200,
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            sceneId: { type: 'string', maxLength: 120 },
            characters: { type: 'array', items: { type: 'string', maxLength: 80 }, maxItems: 40 },
            props: { type: 'array', items: { type: 'string', maxLength: 80 }, maxItems: 60 },
            locations: { type: 'array', items: { type: 'string', maxLength: 80 }, maxItems: 40 }
          },
          required: ['sceneId', 'characters', 'props', 'locations']
        }
      }
    },
    // Structured Outputs requires required[] to include every key in properties.
    required: ['schemaVersion', 'worldAnchor', 'characters', 'props', 'locations', 'eventChain', 'forbiddenSubstitutes', 'sceneRefs']
  }
}

function buildStoryBibleGenerationInstructions() {
  return (
    `你是“交互故事制作工具”的连续分镜一致性助手。\n` +
    `任务：基于输入的故事脚本、场景文本和候选实体提示，产出一个 Story Bible（严格 JSON）。\n` +
    `目标：让后续每个场景生图都能稳定复用角色/道具/地点，避免变脸、换装、道具替换、时代跳变，同时避免把“文字提及”误当成“画面必现”。\n` +
    `要求：\n` +
    `- 输出必须是唯一 JSON 对象，不要解释文字。\n` +
    `- candidateWorldHints、candidateEntities、scenePresenceRules 只是候选与提示，不是真相源；你必须以 scenes / scripts 的实际内容为准，可以丢弃错误候选。\n` +
    `- worldAnchor：纯视觉风格锚点（英文，≤60 词）：只写画风/色彩体系/笔触/镜头感（如 flat 2D 绘本插画、暖色柔和、粗描边、柔和镜头）。禁止写时间、光照变化、天气变化类描述（如 morning、sunset、lighting transitions、rain、snow）——光照与天气归各场景 location 锚点表达，写进 worldAnchor 会让所有场景光照自相矛盾。\n` +
    `- characters：只保留后续连续出图真正需要稳定复用的角色核心身份。anchorPrompt 只写“角色本体 + 稳定基础穿着/物种特征”，不要把临时状态、姿势、情绪、受伤、流血、拿着某物写成核心身份。\n` +
    `- 如果故事里某角色只在单一事件里以临时状态出现，例如“受伤的狼”，角色核心仍应是“狼”本体；受伤属于单场景状态，不应固化进角色 id、name 或 anchorPrompt。\n` +
    `- 群体对象只有在后续场景确实需要稳定复用视觉身份时才保留。例如固定羊群、固定村民群像；否则可以弱化或不纳入核心锁定。\n` +
    `- props：逐道具输出 anchorPrompt（英文，一行，结构级描述：部件/材质/形状/尺寸感/连接方式/典型摆放方式）。只保留“会在后续场景反复作为独立视觉对象出现”的道具，不要把一次性动作或伤口状态误当成长期道具。\n` +
    `- 对可穿戴但可拆卸的道具（hat, cap, bag, shoes, glasses, scarf 等），必须把它们定义为 props，而不是角色外观的一部分；描述应以“物件本身”为中心，不要写人物佩戴状态。\n` +
    `- locations：只输出可复用地点锚点。sceneRefs 里通常每个场景只放一个主地点；除非同一画面内确实同时看到两个地点空间，否则不要混绑多个 location。\n` +
    `- sceneRefs：输出数组。每一项必须包含 sceneId、characters、props、locations；用 id 引用，不要用名字。\n` +
    `- 只有“画面里应实际出现”的对象才能进入 sceneRefs。仅被提到、被怀疑、被呼喊、被回忆、被远处听见，不等于要画进该场景。\n` +
    `- 选择点场景只能绑定在做选择前画面中已存在的对象，不能把未来分支结果提前绑进去。\n` +
    `- eventChain：按场景编号列出可见动作与状态变化（英文短句），用于连续性对齐。\n` +
    `- forbiddenSubstitutes：汇总全局容易误画的替代物（英文短词）。\n`
  )
}

function buildStoryBibleRepairInstructions() {
  return (
    `你是“故事锁定规则审查器”。\n` +
    `任务：审查并修正一个已经生成出来的 Story Bible，使其更符合连续出图的现实需求。输出必须仍然是完整 Story Bible JSON。\n` +
    `修正规则：\n` +
    `- 删除或修正任何把“提及/呼喊/传闻/听到声音”误写成“画面必现”的 sceneRefs 绑定。\n` +
    `- 删除或修正任何把“临时状态”误写成“核心锁定物”的情况，例如 injured, bleeding, crying, wet, broken, frightened。\n` +
    `- 如果 sceneRefs 给一个场景绑定了多个地点，但脚本里并不要求同画面看到这些地点，保留唯一主地点。\n` +
    `- 对群体对象（villagers, flock, crowd 等），只有当后续需要稳定复用群体视觉身份时才保留；否则不要把它们过度绑定到所有场景。\n` +
    `- 不要为了“提到过”就把狼、村民、羊群、道具塞进 sceneRefs；只有画面需要看见它们时才保留。\n` +
    `- 你的目标不是多绑定，而是让后续场景绘制稳定、最小、准确。\n` +
    `- 输出必须是修正后的完整 JSON，不要解释。\n`
  )
}

async function requestStoryBibleStructuredOutput({
  provider,
  model,
  apiUrl,
  proxyUrl,
  timeoutMs,
  instructions,
  input,
  maxRetriesOpenAi = 2,
  maxRetriesOther = 2
}) {
  const p = String(provider || '').trim().toLowerCase()
  const t = Number.isFinite(Number(timeoutMs)) ? Number(timeoutMs) : 90_000
  const schema = storyBibleSchema()
  const user = JSON.stringify(input || {}, null, 2)

  if (p === 'openai' || p === 'localoxml') {
    let lastErr = null
    for (let attempt = 0; attempt < maxRetriesOpenAi; attempt += 1) {
      const attemptInstructions = attempt === 0
        ? instructions
        : `${instructions}\n再次强调：不要输出分析过程、不要输出 markdown、不要输出代码块。只输出一个可直接 JSON.parse 的 JSON 对象。`
      const body = {
        instructions: attemptInstructions,
        input: user,
        ...(model ? { model: String(model).trim() } : {}),
        // prefill 护栏：8K 窗口 prompt+max_tokens 需留 KV 余量，整本圣经输出给 4096
        max_output_tokens: 4096,
        text: {
          format: {
            type: 'json_schema',
            name: 'story_bible',
            strict: true,
            schema
          }
        }
      }
      const { json, meta } = await openaiResponsesJsonForTools({ body, provider: p, apiUrl, proxyUrl, timeoutMs: t })
      const outText = extractResponseOutputText(json)
      try {
        const parsed = parseStoryBibleJsonText(outText)
        const normalized = sanitizeStoryBibleSemantics(parsed)
        if (!validateStoryBible(normalized)) {
          const salvaged = buildDeterministicStoryBibleFallback(input, normalized)
          if (!validateStoryBible(salvaged)) throw new Error('invalid_story_bible')
          return { result: salvaged, meta: { ...(meta || {}), salvageApplied: true } }
        }
        return { result: normalized, meta }
      } catch (e) {
        lastErr = e
        if (attempt === maxRetriesOpenAi - 1) throw e
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
      maxRetries: maxRetriesOther,
      validate: validateStoryBible,
      proxyUrl
    })
    const normalized = sanitizeStoryBibleSemantics(parsed)
    if (!validateStoryBible(normalized)) {
      const salvaged = buildDeterministicStoryBibleFallback(input, normalized)
      if (!validateStoryBible(salvaged)) throw new Error('invalid_story_bible')
      return { result: salvaged, meta: { ...(meta || {}), salvageApplied: true } }
    }
    return { result: normalized, meta }
  }

  if (p === 'ollama') {
    const { parsed, meta } = await generateStrictJsonViaOllamaChat({
      instructions,
      input: user,
      model: model || undefined,
      timeoutMs: t,
      maxRetries: Math.max(1, Math.min(2, maxRetriesOther)),
      validate: validateStoryBible,
      proxyUrl
    })
    const normalized = sanitizeStoryBibleSemantics(parsed)
    if (!validateStoryBible(normalized)) {
      const salvaged = buildDeterministicStoryBibleFallback(input, normalized)
      if (!validateStoryBible(salvaged)) throw new Error('invalid_story_bible')
      return { result: salvaged, meta: { ...(meta || {}), salvageApplied: true } }
    }
    return { result: normalized, meta }
  }

  const e = new Error(`unsupported_provider:${p || 'none'}`)
  e.status = 400
  throw e
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

  // 模型在字符串字面量内输出裸控制字符（Qwen 实测）时，做转义修复再试
  try {
    return parseModelJsonLenient(raw)
  } catch (_) {}

  const preview = raw.slice(0, 120).replace(/\s+/g, ' ').trim()
  const e = new Error(`invalid_json_response:${preview}`)
  e.code = 'invalid_json_response'
  throw e
}

// ============ 本地小内存机：Story Bible 分块生成路径（2026-08-25） ============
// 实测：27B/4bit + 8K 上下文 + Metal cap ~24GB 下，单发大 schema 调用的 prefill 工作区（~4.4GB）
// 必撞 OMLX prefill 内存闸（权重+KV 已占 ~23GB）。分块后每次调用 prefill ~1GB 可通过。
// 仅 localoxml 默认走此路径（云端 doubao 等保持单发）；分块失败再回退单发。

function bibleEntityMiniItem(kind) {
  const base = {
    id: { type: 'string', maxLength: 80 },
    name: { type: 'string', maxLength: 80 },
    aliases: { type: 'array', items: { type: 'string', maxLength: 80 }, maxItems: 20 },
    anchorPrompt: { type: 'string', maxLength: kind === 'location' ? 260 : 300 },
    locked: { type: ['boolean', 'null'] }
  }
  if (kind === 'character') base.negativePrompt = { type: ['string', 'null'], maxLength: 200 }
  if (kind === 'prop') base.forbiddenSubstitutes = { type: 'array', items: { type: 'string', maxLength: 80 }, maxItems: 40 }
  return {
    type: 'object',
    additionalProperties: false,
    properties: base,
    required: Object.keys(base)
  }
}

function bibleChunkSchema(kind) {
  if (kind === 'global') {
    return {
      type: 'object',
      additionalProperties: false,
      properties: {
        worldAnchor: { type: 'string', minLength: 1, maxLength: 600 },
        eventChain: { type: 'array', items: { type: 'string', maxLength: 160 }, maxItems: 80 },
        forbiddenSubstitutes: { type: 'array', items: { type: 'string', maxLength: 80 }, maxItems: 120 }
      },
      required: ['worldAnchor', 'eventChain', 'forbiddenSubstitutes']
    }
  }
  if (kind === 'sceneRefs') {
    return {
      type: 'object',
      additionalProperties: false,
      properties: {
        sceneRefs: {
          type: 'array',
          maxItems: 200,
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              sceneId: { type: 'string', maxLength: 120 },
              characters: { type: 'array', items: { type: 'string', maxLength: 80 }, maxItems: 40 },
              props: { type: 'array', items: { type: 'string', maxLength: 80 }, maxItems: 60 },
              locations: { type: 'array', items: { type: 'string', maxLength: 80 }, maxItems: 40 }
            },
            required: ['sceneId', 'characters', 'props', 'locations']
          }
        }
      },
      required: ['sceneRefs']
    }
  }
  // characters / props / locations
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      [kind]: { type: 'array', maxItems: kind === 'characters' ? 60 : kind === 'props' ? 120 : 80, items: bibleEntityMiniItem(kind.slice(0, -1)) }
    },
    required: [kind]
  }
}

function buildBibleChunkInstructions(kind) {
  const common = '你是"交互故事制作工具"的连续分镜一致性助手。输出必须是唯一 JSON 对象，不要解释文字、不要 markdown。候选实体只是提示不是真相源，以场景实际内容为准。'
  if (kind === 'global') {
    return `${common}\n本块任务：产出全局锚定。worldAnchor：一句到两句英文纯视觉风格锚点，只写画风/色彩体系/笔触/镜头感；禁止时间、光照变化、天气类描述（morning/sunset/lighting transitions/rain 等）——光照归各场景 location 锚点表达。eventChain：按场景编号列出可见动作与状态变化（英文短句）。forbiddenSubstitutes：全局容易误画的替代物（英文短词）。`
  }
  if (kind === 'characters') {
    return `${common}\n本块任务：只保留后续连续出图真正需要稳定复用的角色核心身份。anchorPrompt 只写"角色本体 + 稳定基础穿着/物种特征"，不要把临时状态、姿势、情绪、受伤、拿着某物写成核心身份。单一事件里的临时状态（如受伤的狼）不固化进 id/name/anchorPrompt。群体对象只有确实需要稳定复用视觉身份才保留。每个角色输出 id（英文短横线小写）、name、aliases、anchorPrompt、negativePrompt（可为 null）、locked（默认 true）。`
  }
  if (kind === 'props') {
    return `${common}\n本块任务：逐道具输出结构级 anchorPrompt（英文一行：部件/材质/形状/尺寸感/连接方式）。只保留会在后续场景反复作为独立视觉对象出现的道具；一次性动作/伤口状态不算长期道具。可穿戴可拆卸物（hat/bag/shoes 等）必须是 props 而不是角色外观的一部分，描述以物件本身为中心。anchorPrompt 只写物件本体——禁止写展示方式与载体（悬挂/穿戴/衣架/模特/底座等，如 hanging on rack / worn by / on mannequin），参考图按纯白底独立物件出图。每个道具输出 id、name、aliases、anchorPrompt、forbiddenSubstitutes（易误替代物）、locked（默认 true）。`
  }
  if (kind === 'locations') {
    return `${common}\n本块任务：只输出可复用地点锚点（时代/地域/建筑风格/光照一句英文 anchorPrompt）。每个地点输出 id、name、aliases、anchorPrompt、locked（默认 true）。`
  }
  // sceneRefs
  return `${common}\n本块任务：为每个场景绑定画面中实际应出现的实体（用给定 id 引用，不要用名字）。只有画面里应实际出现的对象才能进入；被提到/呼喊/回忆/远处听见不等于要画进场景。选择点场景只能绑定做选择前画面中已存在的对象。每个场景通常只放一个主地点。对每条场景输出 sceneId、characters、props、locations（数组可空）。`
}

function summarizeInputForBibleChunks(input) {
  // 2026-10-06 字段别名容忍：编辑器发 {nodeId, nodeName, summary}，control 链发 {sceneId, name, text}。
  // 此前只认 sceneId/name/text，编辑器形状被 filter 全灭——所有分块零场景上下文，
  // sceneRefs 必空、实体名英文化（假日出游圣经两次重生均空 sceneRefs 的确定性根因）。
  const sceneSummaries = (Array.isArray(input?.scenes) ? input.scenes : []).map((scene) => ({
    sceneId: String(scene?.sceneId || scene?.nodeId || scene?.id || scene?.key || '').trim(),
    name: String(scene?.name || scene?.nodeName || scene?.title || '').trim(),
    summary: clampStr(scene?.text || scene?.summary || '', 200)
  })).filter((scene) => scene.sceneId)
  const candidateEntities = input?.candidateEntities && typeof input.candidateEntities === 'object' ? input.candidateEntities : {}
  const slimEntity = (item) => ({
    id: String(item?.id || '').trim(),
    name: String(item?.name || '').trim(),
    anchorPrompt: clampStr(item?.anchorPrompt || item?.fingerprintPrompt || '', 200)
  })
  return {
    title: clampStr(input?.title || '', 120),
    brief: clampStr(input?.brief || '', 400),
    sceneSummaries,
    candidateWorldHints: input?.candidateWorldHints || {},
    candidateCharacters: (Array.isArray(candidateEntities.characters) ? candidateEntities.characters : []).map(slimEntity),
    candidateProps: (Array.isArray(candidateEntities.props) ? candidateEntities.props : []).map(slimEntity),
    candidateLocations: (Array.isArray(candidateEntities.locations) ? candidateEntities.locations : []).map(slimEntity)
  }
}

async function callStoryBibleChunk({ provider, model, apiUrl, proxyUrl, timeoutMs, kind, input }) {
  const body = {
    instructions: buildBibleChunkInstructions(kind),
    input: JSON.stringify(input || {}, null, 2),
    ...(model ? { model: String(model).trim() } : {}),
    // 2026-10-13 prefill 护栏实测：8K 窗口下 prompt+max_tokens 必须留 KV 余量，
    // 圣经分块输出有界（单块 1-2K tokens），给 4096 保过闸（丑小鸭圣经 400 根修）
    max_output_tokens: 4096,
    text: {
      format: {
        type: 'json_schema',
        name: `story_bible_${kind}`,
        strict: true,
        schema: bibleChunkSchema(kind)
      }
    }
  }
  const { json } = await openaiResponsesJsonForTools({ body, provider, apiUrl, proxyUrl, timeoutMs })
  const outText = extractResponseOutputText(json)
  const parsed = parseStoryBibleJsonText(outText)
  return parsed && typeof parsed === 'object' ? parsed : {}
}

async function generateStoryBibleChunked({ provider, model, apiUrl, proxyUrl, timeoutMs, input }) {
  const slim = summarizeInputForBibleChunks(input)
  // 2026-10-13 prefill 护栏实测：KV 由 prompt 驱动（~1MB/token），整块 slim 仍有 4-6KB → 丑小鸭圣经四连 400。
  // 每个分块只给该块需要的字段（实体清单+场景名），prompt 压到 ~1-2K tokens 保过闸；global 块摘要再压 120 字。
  const sceneLite = slim.sceneSummaries.map((scene) => ({ sceneId: scene.sceneId, name: scene.name, summary: clampStr(scene.summary, 120) }))
  const sceneNames = sceneLite.map((scene) => scene.name).filter(Boolean)
  const base = { title: slim.title, brief: slim.brief, candidateWorldHints: slim.candidateWorldHints }
  const globalPart = await callStoryBibleChunk({ provider, model, apiUrl, proxyUrl, timeoutMs, kind: 'global', input: { ...base, sceneSummaries: sceneLite } })
  const characterPart = await callStoryBibleChunk({ provider, model, apiUrl, proxyUrl, timeoutMs, kind: 'characters', input: { ...base, candidateCharacters: slim.candidateCharacters, sceneNames } })
  const propPart = await callStoryBibleChunk({ provider, model, apiUrl, proxyUrl, timeoutMs, kind: 'props', input: { ...base, candidateProps: slim.candidateProps, sceneNames } })
  const locationPart = await callStoryBibleChunk({ provider, model, apiUrl, proxyUrl, timeoutMs, kind: 'locations', input: { ...base, candidateLocations: slim.candidateLocations, sceneNames } })
  const sceneRefsPart = await callStoryBibleChunk({
    provider, model, apiUrl, proxyUrl, timeoutMs, kind: 'sceneRefs',
    input: {
      scenes: slim.sceneSummaries.map((scene) => ({ sceneId: scene.sceneId, name: scene.name })),
      chosenEntityIds: {
        characters: (Array.isArray(characterPart?.characters) ? characterPart.characters : []).map((item) => `${item?.id}(${item?.name})`),
        props: (Array.isArray(propPart?.props) ? propPart.props : []).map((item) => `${item?.id}(${item?.name})`),
        locations: (Array.isArray(locationPart?.locations) ? locationPart.locations : []).map((item) => `${item?.id}(${item?.name})`)
      }
    }
  })

  const merged = sanitizeStoryBibleSemantics({
    schemaVersion: '1.0',
    worldAnchor: String(globalPart?.worldAnchor || '').trim(),
    characters: Array.isArray(characterPart?.characters) ? characterPart.characters : [],
    props: Array.isArray(propPart?.props) ? propPart.props : [],
    locations: Array.isArray(locationPart?.locations) ? locationPart.locations : [],
    eventChain: Array.isArray(globalPart?.eventChain) ? globalPart.eventChain : [],
    forbiddenSubstitutes: Array.isArray(globalPart?.forbiddenSubstitutes) ? globalPart.forbiddenSubstitutes : [],
    sceneRefs: Array.isArray(sceneRefsPart?.sceneRefs) ? sceneRefsPart.sceneRefs : []
  })
  if (!validateStoryBible(merged)) {
    const salvaged = buildDeterministicStoryBibleFallback(input, merged)
    if (!validateStoryBible(salvaged)) throw new Error('invalid_chunked_story_bible')
    return salvaged
  }
  return merged
}

export async function generateStoryBible({
  provider,
  model,
  apiUrl,
  proxyUrl,
  timeoutMs,
  input
}) {
  const p = String(provider || '').trim().toLowerCase()
  const timeoutRaw = Number(timeoutMs)
  const t = (Number.isFinite(timeoutRaw) && timeoutRaw <= 0) ? 0 : clampInt(timeoutMs, 5_000, 600_000, 90_000)

  // 本地 27B/8K 小内存机：单发大结构调用的 prefill 工作区必撞 OMLX 内存闸（2026-08-25 四次实测），
  // 默认分块生成（每次调用 prefill ~1GB 可过闸）；分块失败再回退单发旧路径。
  let legacyFallbackChunkError = null
  if (p === 'localoxml') {
    try {
      const chunkStart = Date.now()
      const chunked = await generateStoryBibleChunked({ provider: p, model, apiUrl, proxyUrl, timeoutMs: t, input })
      try {
        const repaired = await requestStoryBibleStructuredOutput({
          provider: p,
          model,
          apiUrl,
          proxyUrl,
          timeoutMs: t,
          instructions: buildStoryBibleRepairInstructions(),
          input: {
            draftStoryBible: chunked,
            sceneIds: (Array.isArray(input?.scenes) ? input.scenes : []).map((scene) => String(scene?.sceneId || scene?.nodeId || scene?.key || '')).filter(Boolean)
          },
          maxRetriesOpenAi: 1,
          maxRetriesOther: 1
        })
        return {
          result: repaired.result,
          meta: { ...(repaired.meta || {}), chunked: true, chunkDurationMs: Date.now() - chunkStart }
        }
      } catch (_) {
        return { result: chunked, meta: { chunked: true, chunkDurationMs: Date.now() - chunkStart, repairSkipped: true } }
      }
    } catch (chunkError) {
      // 分块失败：落到既有单发路径（保底语义不变），并把分块失败原因写进 meta 便于排查
      legacyFallbackChunkError = chunkError instanceof Error ? chunkError.message : String(chunkError)
    }
  }

  const initial = await requestStoryBibleStructuredOutput({
    provider: p,
    model,
    apiUrl,
    proxyUrl,
    timeoutMs: t,
    instructions: buildStoryBibleGenerationInstructions(),
    input,
    maxRetriesOpenAi: 2,
    maxRetriesOther: 2
  })

  try {
    const repaired = await requestStoryBibleStructuredOutput({
      provider: p,
      model,
      apiUrl,
      proxyUrl,
      timeoutMs: t,
      instructions: buildStoryBibleRepairInstructions(),
      input: {
        originalInput: input || {},
        draftStoryBible: initial.result
      },
      maxRetriesOpenAi: 1,
      maxRetriesOther: 1
    })
    return {
      result: repaired.result,
      meta: {
        ...(initial.meta || {}),
        repair: repaired.meta || null,
        ...(legacyFallbackChunkError ? { chunkFallbackReason: legacyFallbackChunkError } : {})
      }
    }
  } catch (_) {
    return initial
  }
}
