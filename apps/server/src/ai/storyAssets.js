function asObj(v) {
  return v && typeof v === 'object' ? v : {}
}

function asList(v) {
  return Array.isArray(v) ? v : []
}

function asStr(v) {
  return typeof v === 'string' ? v : ''
}

function normalizePromptFingerprint(input) {
  return asStr(input)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function uniqStrings(input, max = 200) {
  const out = []
  const seen = new Set()
  for (const item of asList(input)) {
    const value = asStr(item).trim()
    if (!value) continue
    const key = value.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(value)
    if (out.length >= max) break
  }
  return out
}

function normalizeLooseKey(input) {
  return asStr(input)
    .trim()
    .toLowerCase()
    .replace(/[\s_\-.:：/\\]+/g, '')
}

function normalizeIdLike(input, fallback = 'item') {
  const s = asStr(input)
    .trim()
    .replace(/\s+/g, '_')
    .replace(/[^a-zA-Z0-9_.-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 80)
  return s || fallback
}

function slugify(input, fallback = 'item') {
  const s = asStr(input)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 60)
  return s || fallback
}

function lowerSet(items) {
  const out = new Set()
  for (const item of asList(items)) {
    const value = asStr(item).trim().toLowerCase()
    if (value) out.add(value)
  }
  return out
}

function splitCsvLike(input) {
  return asStr(input)
    .split(/[,\n，、|]/g)
    .map((x) => x.trim())
    .filter(Boolean)
}

function buildSceneCandidates(node, index) {
  const out = []
  const id = asStr(node && node.id).trim()
  const name = asStr(node && node.name).trim()
  const title = asStr(node && node.body && node.body.title).trim()
  if (id) out.push(id)
  // 蓝图编译会给脚本层节点 id 加 bn_ 前缀，bible.sceneRefs 仍用脚本层 id，需同时匹配去前缀形式
  if (id.startsWith('bn_')) out.push(id.slice(3))
  if (name) out.push(name)
  if (title) out.push(title)
  out.push(`scene${index + 1}`)
  out.push(`scene_${index + 1}`)
  out.push(`场景${index + 1}`)
  out.push(String(index + 1))
  return uniqStrings(out, 12)
}

function buildNodeSummary(node) {
  const title = asStr(node && node.body && node.body.title).trim() || asStr(node && node.name).trim()
  const text = asStr(node && node.body && node.body.text)
  const main = text
    .split(/\r?\n/)
    .map((x) => x.trim())
    .filter(Boolean)
    .filter((x) => !/^选项(?:\d{1,2}|[A-Z])\s*[:：]/i.test(x))
    .slice(0, 6)
    .join('，')
  return [title, main].filter(Boolean).join('：').slice(0, 500)
}

export function matchSceneRef(sceneRefsMap, node, index) {
  const candidates = buildSceneCandidates(node, index)
  for (const candidate of candidates) {
    const hit = sceneRefsMap.get(normalizeLooseKey(candidate))
    if (hit) return hit
  }
  return { key: asStr(node && node.id).trim() || `scene_${index + 1}`, value: { characters: [], props: [], locations: [] } }
}

function inferSceneIdsFromText(nodes, entity) {
  const names = [
    asStr(entity && entity.name).trim(),
    ...uniqStrings(entity && entity.aliases, 12)
  ].filter(Boolean)
  if (!names.length) return []
  // 2026-10-05 分词级模糊匹配：纯包含匹配漏掉"乒乓球馆 vs 乒乓球台"、"Running Shoes vs 跑鞋"这类
  // 名称变体——对每个名称取 2 字以上的连续中文/字母片段做兜底子串匹配，命中率显著提升（假日出游 4 资产 0 场景事件）。
  const looseFrags = []
  for (const nm of names) {
    const parts = String(nm).split(/[\s\-_，,、/（）()]+/).map((x) => x.trim()).filter((x) => x.length >= 2)
    looseFrags.push(...parts.map((x) => x.toLowerCase()))
    // 中文名取核心名词片段（去"馆/场/处/口"等尾缀）
    const trimmed = String(nm).replace(/[馆场口处]$/, '').trim().toLowerCase()
    if (trimmed.length >= 2 && trimmed !== String(nm).toLowerCase()) looseFrags.push(trimmed)
  }
  const out = []
  for (let i = 0; i < nodes.length; i += 1) {
    const node = nodes[i]
    const hay = `${asStr(node && node.name)} ${asStr(node && node.body && node.body.title)} ${asStr(node && node.body && node.body.text)}`.toLowerCase()
    if (names.some((x) => hay.includes(x.toLowerCase()))) {
      out.push(asStr(node && node.id).trim() || `scene_${i + 1}`)
      continue
    }
    if (looseFrags.length && looseFrags.some((frag) => hay.includes(frag))) out.push(asStr(node && node.id).trim() || `scene_${i + 1}`)
  }
  return uniqStrings(out, 80)
}

function inferCharacterSceneIdsFromPlacements(nodes, projectCharacterId) {
  if (!projectCharacterId) return []
  const out = []
  for (let i = 0; i < nodes.length; i += 1) {
    const placements = asList(nodes[i] && nodes[i].visuals && nodes[i].visuals.placements)
    if (placements.some((p) => asStr(p && p.characterId).trim() === projectCharacterId)) {
      out.push(asStr(nodes[i] && nodes[i].id).trim() || `scene_${i + 1}`)
    }
  }
  return uniqStrings(out, 80)
}

export function normalizeSceneRefs(storyBible) {
  const sceneRefsIn = asObj(storyBible && storyBible.sceneRefs)
  // 2026-09-27：LLM 常把实体引用写成 "id(名字)" 复合格式（违抗"只用 id"指令），
  // 归一化时剥掉括号尾巴，保证后续 id 解析命中
  const cleanRefs = (list, max) => uniqStrings(list, max)
    .map((x) => x.replace(/\s*[（(][^）)]*[）)]\s*$/, '').trim())
    .filter(Boolean)
  const out = new Map()
  for (const [key, raw] of Object.entries(sceneRefsIn)) {
    const value = asObj(raw)
    out.set(normalizeLooseKey(key), {
      key,
      value: {
        characters: cleanRefs(value.characters, 40),
        props: cleanRefs(value.props, 60),
        locations: cleanRefs(value.locations, 40)
      }
    })
  }
  return out
}

export function buildEntityIdResolver(items) {
  const lookup = new Map()
  for (const raw of asList(items)) {
    const item = asObj(raw)
    const id = asStr(item.id).trim()
    if (!id) continue
    const keys = uniqStrings([id, item.name, ...(item.aliases || [])], 30)
    for (const key of keys) {
      lookup.set(normalizeLooseKey(key), id)
    }
  }
  return (input) => lookup.get(normalizeLooseKey(input)) || asStr(input).trim()
}

function matchProjectCharacter(project, entity) {
  const characters = asList(project && project.characters)
  const idRaw = asStr(entity && entity.id).trim()
  const nameRaw = asStr(entity && entity.name).trim()
  const aliases = uniqStrings(entity && entity.aliases, 20)
  const keys = lowerSet([idRaw, nameRaw, ...aliases])
  for (const ch of characters) {
    const id = asStr(ch && ch.id).trim()
    const name = asStr(ch && ch.name).trim()
    const ownKeys = lowerSet([id, name])
    for (const key of keys) {
      if (ownKeys.has(key)) return ch
    }
  }
  return null
}

function lookupProjectAsset(project, assetId) {
  if (!assetId) return null
  return asList(project && project.assets).find((asset) => asStr(asset && asset.id).trim() === assetId) || null
}

function cleanupReferenceAnchorText(text) {
  // 通用清洗：只做空白与标点规整，不再内置任何特定故事（如钓鱼故事）的词替换
  const out = asStr(text)
    .replace(/\s{2,}/g, ' ')
    .replace(/\s+,/g, ',')
    .replace(/,,+/g, ',')
    .trim()
  return out.replace(/^[,;\s]+|[,;\s]+$/g, '')
}

function cleanupPropReferenceAnchorText(text) {
  // 通用清洗：道具锚点同样只做空白规整，穿戴/语境纠偏交给负向词与审核
  // 2026-10-07 升级：剥掉展示语境从句（hanging on rack / holding garments / worn by…）——
  // 负向词压不住锚点里的展示载体（公主穿衣：裙锚点"hanging on clothes rack"把衣架画进裙子参考图，
  // 衣架锚点"holding multiple garments"把两件 T 恤画进空衣架参考图），锚点只留物件本体。
  const out = asStr(text)
    .replace(/,?\s*\b(hanging|hung|displayed|presented|mounted|placed|shown)\s+(on|in|at|from|against)\s+[^,;]+/gi, '')
    .replace(/,?\s*\bholding\s+[^,;]+/gi, '')
    .replace(/,?\s*\b(worn|carried|held)\s+by\s+[^,;]+/gi, '')
    .replace(/,?\s*\b(on|on a|on the|from a|from the)\s+(clothes\s+)?(rack|hanger|mannequin|stand|display|hook)\b[^,;]*/gi, '')
    .replace(/(悬挂于|挂在|挂于|穿在|佩戴在|穿戴在|展示于|陈列于)[^，；,;]+/g, '')
    .replace(/\s{2,}/g, ' ')
    .replace(/\s+,/g, ',')
    .replace(/,,+/g, ',')
    .trim()
  return out.replace(/^[,;\s]+|[,;\s]+$/g, '')
}

function isWearableProp(asset) {
  const hay = [
    asStr(asset && asset.name),
    asStr(asset && asset.anchorPrompt),
    ...asList(asset && asset.aliases)
  ].join(' ').toLowerCase()
  return /\b(hat|cap|helmet|hood|shoe|shoes|boot|boots|glove|gloves|sandal|sandals|bag|backpack|belt|scarf|robe|shirt|coat)\b/.test(hay)
}

function isHatLikeProp(asset) {
  const hay = [
    asStr(asset && asset.name),
    asStr(asset && asset.anchorPrompt),
    ...asList(asset && asset.aliases)
  ].join(' ').toLowerCase()
  return /\b(hat|cap|helmet|hood|草帽|帽子|帽)\b/.test(hay)
}

function assetSignalText(asset) {
  return [
    asStr(asset && asset.name),
    asStr(asset && asset.anchorPrompt),
    ...asList(asset && asset.aliases),
    ...asList(asset && asset.forbiddenSubstitutes)
  ]
    .join(' ')
    .toLowerCase()
}

function hasKeyword(text, patterns) {
  const hay = String(text || '').toLowerCase()
  return patterns.some((pattern) => {
    if (!pattern) return false
    if (pattern instanceof RegExp) return pattern.test(hay)
    return hay.includes(String(pattern).toLowerCase())
  })
}

function inferPropLockProfile(asset) {
  const hay = assetSignalText(asset)
  if (!hay) return 'generic_prop'
  if (isWearableProp(asset)) return 'wearable_prop'
  if (hasKeyword(hay, [
    'cloud', 'white cloud', 'fog', 'mist', 'smoke', 'steam', 'firefly glow', 'spark', 'glow', 'shadow blob',
    '白云', '云朵', '云', '雾', '烟', '蒸汽', '光斑', '火花', '闪光'
  ])) return 'ambient_prop'
  if (hasKeyword(hay, [
    'flute', 'recorder', 'whistle', 'rod', 'wand', 'sword', 'staff', 'stick', 'bamboo pole', 'pipe', 'key', 'needle',
    '笛', '笛子', '长笛', '短笛', '鱼竿', '杆', '棍', '棒', '魔杖', '剑', '钥匙', '针'
  ])) return 'slender_prop'
  if (hasKeyword(hay, [
    'toilet', 'toilet bowl', 'commode', 'chair', 'table', 'bucket', 'pail', 'cup', 'bottle', 'box', 'lamp', 'clock',
    'bobber', 'fishing float', 'cork float', 'fishing reel', 'reel',
    '马桶', '坐便器', '厕所', '椅子', '桌子', '水桶', '杯子', '瓶子', '箱子', '台灯', '闹钟', '浮漂', '浮标', '鱼漂'
  ])) return 'rigid_prop'
  if (hasKeyword(hay, [
    'pillow', 'blanket', 'quilt', 'balloon', 'cotton', 'fabric bundle', 'marshmallow',
    '枕头', '被子', '棉被', '气球', '棉花', '布团'
  ])) return 'soft_prop'
  // 2026-09-27：fish 必须整词匹配——"fishing float/reel" 里的 fish 是钓鱼修饰语，
  // 子串匹配会把浮漂/鱼线轮等人造物误归 organic_prop（标本模板诱导模型画鱼，实测 8/8 候选全画成鱼）
  if (/\bfish\b/.test(hay) || hasKeyword(hay, [
    'butterfly', 'flower', 'leaf', 'feather', 'shell', 'fruit', 'apple', 'pear',
    '鱼', '蝴蝶', '花', '叶子', '羽毛', '贝壳', '果子', '苹果', '梨'
  ])) return 'organic_prop'
  return 'generic_prop'
}

export function inferAssetLockProfile(asset) {
  const category = asStr(asset && asset.category).trim().toLowerCase()
  if (category === 'character') return 'character_core'
  if (category === 'location') return 'location_anchor'
  if (category === 'prop') return inferPropLockProfile(asset)
  return 'generic_asset'
}

export function lockWorkflowForAsset(asset) {
  const profile = asStr(asset && asset.lockProfile).trim() || inferAssetLockProfile(asset)
  if (profile === 'character_core') return 'character_sheet'
  if (profile === 'location_anchor') return 'location_anchor'
  if (profile === 'wearable_prop' && isHatLikeProp(asset)) return 'prop_hat'
  if (profile === 'wearable_prop') return 'prop_wearable'
  if (profile === 'slender_prop') return 'prop_slender'
  if (profile === 'soft_prop') return 'prop_soft'
  if (profile === 'ambient_prop') return 'prop_ambient'
  if (profile === 'organic_prop') return 'prop_specimen'
  return 'prop_product'
}

export function getStoryAssetRenderProfile(asset, stylePreset) {
  const profile = asStr(asset && asset.lockProfile).trim() || inferAssetLockProfile(asset)
  // 2026-09-28 尺寸预设（settings 风格预设 sizes[profile]），缺省用内置兜底
  const presetSizes = (stylePreset && stylePreset.sizes && typeof stylePreset.sizes === 'object') ? stylePreset.sizes : null
  const sizeOf = (key, w, h, workflowMode, suffixProfile) => {
    const hit = presetSizes && Array.isArray(presetSizes[key]) && presetSizes[key].length >= 2 ? presetSizes[key] : null
    return { width: Number(hit ? hit[0] : w), height: Number(hit ? hit[1] : h), workflowMode, profile: suffixProfile || profile }
  }
  if (profile === 'character_core') {
    return sizeOf('character_core', 768, 1152, 'story_asset_character_sheet')
  }
  if (profile === 'location_anchor') {
    return sizeOf('location_anchor', 960, 544, 'story_asset_location_anchor')
  }
  if (profile === 'slender_prop') {
    return sizeOf('slender_prop', 640, 1024, 'story_asset_prop_slender')
  }
  if (profile === 'ambient_prop') {
    return sizeOf('ambient_prop', 896, 896, 'story_asset_prop_ambient')
  }
  if (profile === 'soft_prop') {
    return sizeOf('soft_prop', 896, 896, 'story_asset_prop_soft')
  }
  if (profile === 'organic_prop') {
    return sizeOf('organic_prop', 768, 768, 'story_asset_prop_specimen')
  }
  if (profile === 'wearable_prop') {
    if (isHatLikeProp(asset)) {
      return sizeOf('wearable_prop_hat', 1024, 768, 'story_asset_prop_hat')
    }
    return sizeOf('wearable_prop', 768, 768, 'story_asset_prop_wearable')
  }
  return sizeOf('generic_prop', 832, 832, 'story_asset_prop_product')
}

function choosePropStrategy(sceneCount, lockProfile) {
  const profile = asStr(lockProfile).trim() || 'generic_prop'
  if (profile === 'wearable_prop' || profile === 'slender_prop' || profile === 'rigid_prop') {
    return { persistence: sceneCount >= 2 ? 'high' : 'medium', renderStrategy: 'ref_required' }
  }
  if (profile === 'organic_prop') {
    if (sceneCount >= 2) return { persistence: 'medium', renderStrategy: 'ref_required' }
    return { persistence: 'low', renderStrategy: 'optional_ref' }
  }
  if (profile === 'soft_prop') {
    if (sceneCount >= 2) return { persistence: 'medium', renderStrategy: 'optional_ref' }
    return { persistence: 'low', renderStrategy: 'prompt_only' }
  }
  if (profile === 'ambient_prop') {
    if (sceneCount >= 3) return { persistence: 'medium', renderStrategy: 'optional_ref' }
    return { persistence: 'low', renderStrategy: 'prompt_only' }
  }
  if (sceneCount >= 2) return { persistence: 'high', renderStrategy: 'ref_required' }
  return { persistence: 'low', renderStrategy: 'prompt_only' }
}

function chooseLocationStrategy(sceneCount) {
  if (sceneCount >= 2) return { persistence: 'medium', renderStrategy: 'optional_ref' }
  return { persistence: 'low', renderStrategy: 'prompt_only' }
}

function summarizePlan(assets, scenes) {
  const refRequired = assets.filter((x) => x.renderStrategy === 'ref_required')
  const refReady = refRequired.filter((x) => x.referenceStatus === 'ready')
  const refMissing = refRequired.filter((x) => x.referenceStatus !== 'ready')
  const workflows = {}
  for (const scene of scenes) {
    const key = asStr(scene && scene.workflow).trim() || 'unknown'
    workflows[key] = Number(workflows[key] || 0) + 1
  }
  return {
    assetCount: assets.length,
    sceneCount: scenes.length,
    refRequiredCount: refRequired.length,
    refReadyCount: refReady.length,
    refMissingCount: refMissing.length,
    workflows
  }
}

export function summarizeStoryAssetPlan(plan) {
  const safePlan = asObj(plan)
  const assets = asList(safePlan.assets).map((item) => asObj(item))
  const scenes = asList(safePlan.scenes).map((item) => asObj(item))
  return summarizePlan(assets, scenes)
}

function buildSceneWorkflow(sceneAssets) {
  const refReady = sceneAssets.filter((x) => x.renderStrategy !== 'prompt_only' && x.referenceStatus === 'ready')
  const readyCharacters = refReady.filter((x) => x.category === 'character')
  const readyProps = refReady.filter((x) => x.category === 'prop')
  const readyLocations = refReady.filter((x) => x.category === 'location')
  const missingRequired = sceneAssets.filter((x) => x.renderStrategy === 'ref_required' && x.referenceStatus !== 'ready')

  if (!refReady.length) return missingRequired.length ? 'scene_prompt_only_fallback' : 'scene_prompt_only'
  if (readyCharacters.length && readyProps.length) return 'scene_with_multi_refs'
  if (readyCharacters.length > 1) return 'scene_with_character_refs'
  if (readyCharacters.length === 1) return 'scene_with_single_character_ref'
  if (readyLocations.length) return 'scene_with_location_ref'
  if (readyProps.length) return 'scene_with_prop_refs'
  return 'scene_prompt_only'
}

function mergePrevAssetState(asset, prevAsset) {
  if (!prevAsset || typeof prevAsset !== 'object') return asset
  const generatedRefs = Array.isArray(prevAsset.generatedRefs) ? prevAsset.generatedRefs.filter((x) => x && typeof x === 'object') : []
  const latestReferenceBatch = Array.isArray(prevAsset.latestReferenceBatch) ? prevAsset.latestReferenceBatch.filter((x) => x && typeof x === 'object') : []
  const primaryReferenceAssetId = asStr(prevAsset.primaryReferenceAssetId).trim()
  const primaryReferenceAssetUri = asStr(prevAsset.primaryReferenceAssetUri).trim()
  let referenceStatus = asStr(prevAsset.referenceStatus).trim()
  if (primaryReferenceAssetUri) referenceStatus = 'ready'
  else if (!referenceStatus && (latestReferenceBatch.length || generatedRefs.length)) referenceStatus = 'candidates_ready'
  else if (!referenceStatus) referenceStatus = asset.referenceStatus
  const lineartFinalAssetUri = asStr(prevAsset.lineartFinalAssetUri).trim()
  const lineartStatus = lineartFinalAssetUri ? 'ready' : (asStr(prevAsset.lineartStatus).trim() || 'missing')
  return {
    ...asset,
    generatedRefs,
    latestReferenceBatch,
    latestReferenceReview: prevAsset.latestReferenceReview && typeof prevAsset.latestReferenceReview === 'object' ? prevAsset.latestReferenceReview : null,
    latestRecommendedReferenceAssetUri: asStr(prevAsset.latestRecommendedReferenceAssetUri).trim(),
    primaryReferenceAssetId: primaryReferenceAssetId || asset.primaryReferenceAssetId || '',
    primaryReferenceAssetUri: primaryReferenceAssetUri || asset.primaryReferenceAssetUri || '',
    primaryReferenceSelectedAt: asStr(prevAsset.primaryReferenceSelectedAt).trim(),
    referenceStatus,
    lineartHintAssetId: asStr(prevAsset.lineartHintAssetId).trim(),
    lineartHintAssetUri: asStr(prevAsset.lineartHintAssetUri).trim(),
    lineartFinalAssetId: asStr(prevAsset.lineartFinalAssetId).trim(),
    lineartFinalAssetUri: lineartFinalAssetUri || '',
    lineartStatus,
    lineartPrompt: asStr(prevAsset.lineartPrompt),
    lineartNegativePrompt: asStr(prevAsset.lineartNegativePrompt),
    lineartMeta: prevAsset.lineartMeta && typeof prevAsset.lineartMeta === 'object' ? prevAsset.lineartMeta : null,
    lineartGeneratedAt: asStr(prevAsset.lineartGeneratedAt).trim(),
    // V1.1 重建保留（63MB 孤儿文件事故：重建清空锁定/变体状态）——状态变体、姿势草稿、
    // 向导提示词草稿（referencePrompt*）非空时一律继承，新构建默认值仅作缺省
    stateVariants: Array.isArray(prevAsset.stateVariants) ? prevAsset.stateVariants : asset.stateVariants,
    stateRequirements: Array.isArray(prevAsset.stateRequirements) ? prevAsset.stateRequirements : asset.stateRequirements,
    stateMergeInto: prevAsset.stateMergeInto && typeof prevAsset.stateMergeInto === 'object' ? prevAsset.stateMergeInto : asset.stateMergeInto,
    poseDraft: prevAsset.poseDraft && typeof prevAsset.poseDraft === 'object' ? prevAsset.poseDraft : asset.poseDraft,
    referencePromptEn: asStr(prevAsset.referencePromptEn).trim() || asset.referencePromptEn || '',
    referencePromptZh: asStr(prevAsset.referencePromptZh).trim() || asset.referencePromptZh || '',
    referenceNegativePromptZh: asStr(prevAsset.referenceNegativePromptZh).trim() || asset.referenceNegativePromptZh || '',
    referenceNegativePrompt: asStr(prevAsset.referenceNegativePrompt).trim() || asset.referenceNegativePrompt || ''
  }
}

const CJK_RE = /[\u4e00-\u9fff]/

// 2026-10-13 字段对齐（青蛙王子实测错位）：向导「锁定事物」读写的 referencePromptEn/
// referencePromptZh 由生产侧在计划构建时填齐——英文稿与出图锚点 anchorPrompt 同源；
// 中文稿以圣经中文名/中文别名为种子（圣经无实体级中文描述，进一步润色走向导的
// 「AI 生成提示词」/人工编辑，不在这里编造内容）。
function chinesePromptSeedForEntity(entity) {
  const parts = []
  const name = asStr(entity && entity.name).trim()
  if (name && CJK_RE.test(name)) parts.push(name)
  for (const alias of asList(entity && entity.aliases)) {
    const text = asStr(alias).trim()
    if (text && CJK_RE.test(text) && !parts.includes(text)) parts.push(text)
  }
  return parts.join('、')
}

// 2026-10-13 计划去重合并（bible_qc 质检重写圣经后，同一事物可能被不同 id 双建档——
// 实测 characters.frog「青蛙」与 props.frog_char_01「The Frog」(aliases 含 frog) 并存）：
// 按规范化名称/别名交集判同一事物，合并进类别优先级高的条目（character > location > prop），
// sceneIds/aliases/提示词/主参考/生成态并入保留条目；被合并 id 经返回 idMap 改写到场景引用。
const CATEGORY_MERGE_PRIORITY = { character: 0, location: 1, prop: 2 }

function normalizeEntityToken(text) {
  return asStr(text).trim().toLowerCase().replace(/\s+/g, ' ').replace(/^(?:the|a|an)\s+/i, '')
}

function mergeAssetInto(target, source) {
  target.sceneIds = uniqStrings([...asList(target.sceneIds), ...asList(source.sceneIds)], 80)
  target.sceneCount = target.sceneIds.length
  target.aliases = uniqStrings([...asList(target.aliases), ...asList(source.aliases)], 20)
  const prevEvidence = target.sceneEvidence && typeof target.sceneEvidence === 'object' ? target.sceneEvidence : {}
  const srcEvidence = source.sceneEvidence && typeof source.sceneEvidence === 'object' ? source.sceneEvidence : {}
  target.sceneEvidence = {
    bibleRefs: uniqStrings([...asList(prevEvidence.bibleRefs), ...asList(srcEvidence.bibleRefs)], 80),
    placements: uniqStrings([...asList(prevEvidence.placements), ...asList(srcEvidence.placements)], 80),
    text: uniqStrings([...asList(prevEvidence.text), ...asList(srcEvidence.text)], 80)
  }
  if (!asStr(target.anchorPrompt).trim()) target.anchorPrompt = asStr(source.anchorPrompt).trim()
  if (!asStr(target.negativePrompt).trim()) target.negativePrompt = asStr(source.negativePrompt).trim()
  if (!asStr(target.referencePromptEn).trim()) target.referencePromptEn = asStr(source.referencePromptEn).trim()
  if (!asStr(target.referencePromptZh).trim()) target.referencePromptZh = asStr(source.referencePromptZh).trim()
  // 主参考与生成态：保留条目缺失时继承被合并条目（不覆盖已有真相）
  if (!asStr(target.primaryReferenceAssetUri).trim() && asStr(source.primaryReferenceAssetUri).trim()) {
    target.primaryReferenceAssetId = asStr(source.primaryReferenceAssetId).trim()
    target.primaryReferenceAssetUri = asStr(source.primaryReferenceAssetUri).trim()
    target.referenceStatus = asStr(source.referenceStatus).trim() || 'ready'
  }
  const seenRefs = new Set(asList(target.generatedRefs).map((x) => asStr(x && (x.assetId || x.uri || x.assetPath)).trim()).filter(Boolean))
  for (const ref of asList(source.generatedRefs)) {
    const key = asStr(ref && (ref.assetId || ref.uri || ref.assetPath)).trim()
    if (key && seenRefs.has(key)) continue
    if (key) seenRefs.add(key)
    target.generatedRefs = [...asList(target.generatedRefs), ref]
  }
  if (!asList(target.latestReferenceBatch).length && asList(source.latestReferenceBatch).length) {
    target.latestReferenceBatch = source.latestReferenceBatch
  }
  return target
}

function dedupeStoryAssetDefs(defs) {
  const kept = []
  const idMap = new Map()
  const tokenIndex = new Map()
  for (const asset of Array.isArray(defs) ? defs : []) {
    // token 集 = id（含去序号变体）+ 名称 + 别名（规范化）：
    // id 必入集——bible_qc 重写后 prop 的 aliases 常含角色 id（实测 prop frog_char_01 aliases 含 'frog'）
    const rawId = asStr(asset && asset.id).trim()
    const tokens = [rawId, rawId.replace(/_\d+$/, ''), asset && asset.name, ...asList(asset && asset.aliases)]
      .map(normalizeEntityToken)
      .filter(Boolean)
    let hitIdx = -1
    for (const token of tokens) {
      if (tokenIndex.has(token)) { hitIdx = tokenIndex.get(token); break }
    }
    if (hitIdx === -1) {
      for (const token of tokens) tokenIndex.set(token, kept.length)
      kept.push(asset)
      continue
    }
    const target = kept[hitIdx]
    const targetPriority = CATEGORY_MERGE_PRIORITY[asStr(target.category).trim()] ?? 3
    const sourcePriority = CATEGORY_MERGE_PRIORITY[asStr(asset.category).trim()] ?? 3
    // 新条目类别优先级更高时换保留身份（id/name/category/提示词以新条目为准，旧条目状态并入）
    const winner = sourcePriority < targetPriority ? asset : target
    const loser = winner === asset ? target : asset
    mergeAssetInto(winner, loser)
    if (winner === asset) kept[hitIdx] = asset
    for (const token of tokens) tokenIndex.set(token, hitIdx)
    if (asStr(loser.id).trim() && asStr(loser.id).trim() !== asStr(winner.id).trim()) {
      idMap.set(asStr(loser.id).trim(), asStr(winner.id).trim())
    }
  }
  return { assets: kept, idMap }
}

function referenceHintForCategory(category) {
  if (category === 'character') {
    return 'single full-body front view of one adult character only, pure white background, centered single view, stable face and outfit, one single pose'
  }
  if (category === 'prop') {
    return 'single prop product reference, exactly one object only, pure white background, centered single view, full silhouette visible, clear material and structure, isolated object shown alone'
  }
  if (category === 'location') {
    return 'environment concept art, no characters, stable layout, clear architecture language, reusable location reference'
  }
  return 'clean reference image'
}

function referenceHintForAsset(asset) {
  const profile = asStr(asset && asset.lockProfile).trim() || inferAssetLockProfile(asset)
  if (profile === 'character_core') return referenceHintForCategory('character')
  if (profile === 'location_anchor') return referenceHintForCategory('location')
  if (profile === 'wearable_prop') {
    if (isHatLikeProp(asset)) {
      return 'single hat reference, exactly one detached hat only, pure white background, centered single view, full silhouette visible, opening under the hat visible, brim contour fully unobstructed, no wearer, no mannequin, no head, no shoulders, no portrait'
    }
    return 'single wearable prop reference, exactly one detached object only, pure white background, centered single view, full silhouette visible, opening/interior visible if applicable, no wearer, no mannequin, no head, no body'
  }
  if (profile === 'slender_prop') {
    return 'single slender prop reference, full length visible from end to end, centered isolated object, stable single view, no foreshortening, no hand, no person, pure white background'
  }
  if (profile === 'rigid_prop') {
    return 'single rigid object reference, stable perspective, exactly one object only, centered composition, clear major structural parts, pure white background, no people, no environment'
  }
  if (profile === 'soft_prop') {
    return 'single soft-form object reference, isolated on clean light background, stable contour and readable volume, no wearer, no person, no environment clutter'
  }
  if (profile === 'ambient_prop') {
    return 'single atmospheric motif reference, isolated simple form, clean pale background, no landscape, no horizon, no characters, no complex scene'
  }
  if (profile === 'organic_prop') {
    return 'single natural specimen reference, isolated subject, centered composition, full silhouette visible, clean background, no habitat scene, no extra objects'
  }
  return referenceHintForCategory(asStr(asset && asset.category).trim())
}

export function buildStoryAssetPlan({ project, story, storyBible, prevManifest }) {
  const safeProject = asObj(project)
  const safeStory = asObj(story)
  const safeBible = asObj(storyBible)
  const nodes = asList(safeStory.nodes)
    .map((node) => asObj(node))
    .filter((node) => {
      const kind = asStr(node.kind).trim()
      return kind === 'scene' || kind === 'ending'
    })

  const sceneRefsMap = normalizeSceneRefs(safeBible)
  const resolveCharacterId = buildEntityIdResolver(safeBible.characters)
  const resolvePropId = buildEntityIdResolver(safeBible.props)
  const resolveLocationId = buildEntityIdResolver(safeBible.locations)
  const sceneUsage = {
    characters: new Map(),
    props: new Map(),
    locations: new Map()
  }
  for (let index = 0; index < nodes.length; index += 1) {
    const node = nodes[index]
    const matched = matchSceneRef(sceneRefsMap, node, index)
    const sceneId = asStr(node && node.id).trim() || `scene_${index + 1}`
    for (const entityId0 of uniqStrings(matched && matched.value && matched.value.characters, 40)) {
      const entityId = resolveCharacterId(entityId0)
      const list = sceneUsage.characters.get(entityId) || []
      list.push(sceneId)
      sceneUsage.characters.set(entityId, list)
    }
    for (const entityId0 of uniqStrings(matched && matched.value && matched.value.props, 60)) {
      const entityId = resolvePropId(entityId0)
      const list = sceneUsage.props.get(entityId) || []
      list.push(sceneId)
      sceneUsage.props.set(entityId, list)
    }
    for (const entityId0 of uniqStrings(matched && matched.value && matched.value.locations, 40)) {
      const entityId = resolveLocationId(entityId0)
      const list = sceneUsage.locations.get(entityId) || []
      list.push(sceneId)
      sceneUsage.locations.set(entityId, list)
    }
  }
  const prevAssetsById = new Map(
    asList(prevManifest && prevManifest.assets)
      .map((item) => asObj(item))
      .filter((item) => asStr(item.id).trim())
      .map((item) => [asStr(item.id).trim(), item])
  )
  const excludedAssetIds = new Set(
    uniqStrings(prevManifest && prevManifest.excludedAssetIds, 200)
      .map((item) => asStr(item).trim())
      .filter(Boolean)
  )

  const assetDefs = []

  for (const raw of asList(safeBible.characters)) {
    const entity = asObj(raw)
    const id = asStr(entity.id).trim() || `char.${normalizeIdLike(entity.name, 'character')}`
    const projectCharacter = matchProjectCharacter(safeProject, entity)
    const bibleRefScenes = sceneUsage.characters.get(id) || []
    const placementScenes = inferCharacterSceneIdsFromPlacements(nodes, asStr(projectCharacter && projectCharacter.id).trim())
    const textScenes = inferSceneIdsFromText(nodes, entity)
    const sceneIds = uniqStrings([...bibleRefScenes, ...placementScenes, ...textScenes], 80)
    const refAssetId =
      asStr(projectCharacter && projectCharacter.ai && projectCharacter.ai.referenceAssetId).trim() ||
      asStr(projectCharacter && projectCharacter.imageAssetId).trim()
    const refAsset = lookupProjectAsset(safeProject, refAssetId)
    const lockProfile = inferAssetLockProfile({ category: 'character', ...entity })
    const lockWorkflow = lockWorkflowForAsset({ category: 'character', lockProfile, ...entity })
    const asset = {
      id,
      name: asStr(entity.name).trim() || id,
      category: 'character',
      lockProfile,
      lockWorkflow,
      persistence: 'high',
      renderStrategy: 'ref_required',
      anchorPrompt: asStr(entity.anchorPrompt).trim(),
      negativePrompt: asStr(entity.negativePrompt).trim(),
      // 2026-10-13 字段对齐：向导可见可编字段与生产同源填齐（英文稿=出图锚点；中文稿=中文名/别名种子）
      referencePromptEn: asStr(entity.anchorPrompt).trim(),
      referencePromptZh: chinesePromptSeedForEntity(entity),
      aliases: uniqStrings(entity.aliases, 20),
      forbiddenSubstitutes: [],
      sceneIds,
      sceneCount: sceneIds.length,
      // 2026-10-06 分配证据：三路来源各自的场景命中（圣经绑定/摆位记录/正文文本），供编辑器日志向用户解释分配依据
      sceneEvidence: {
        bibleRefs: uniqStrings(bibleRefScenes, 80),
        placements: uniqStrings(placementScenes, 80),
        text: uniqStrings(textScenes, 80)
      },
      projectCharacterId: asStr(projectCharacter && projectCharacter.id).trim() || '',
      primaryReferenceAssetId: refAsset ? asStr(refAsset.id).trim() : '',
      primaryReferenceAssetUri: refAsset ? asStr(refAsset.uri).trim() : '',
      referenceStatus: refAsset && asStr(refAsset.uri).trim() ? 'ready' : 'missing',
      generatedRefs: [],
      referencePromptHint: referenceHintForAsset({ category: 'character', lockProfile, ...entity })
    }
    if (!excludedAssetIds.has(id)) assetDefs.push(mergePrevAssetState(asset, prevAssetsById.get(id)))
  }

  for (const raw of asList(safeBible.props)) {
    const entity = asObj(raw)
    const id = asStr(entity.id).trim() || `prop.${normalizeIdLike(entity.name, 'prop')}`
    const bibleRefScenes = sceneUsage.props.get(id) || []
    const textScenes = inferSceneIdsFromText(nodes, entity)
    const sceneIds = uniqStrings([...bibleRefScenes, ...textScenes], 80)
    const lockProfile = inferAssetLockProfile({ category: 'prop', ...entity })
    const lockWorkflow = lockWorkflowForAsset({ category: 'prop', lockProfile, ...entity })
    const strategy = choosePropStrategy(sceneIds.length, lockProfile)
    const asset = {
      id,
      name: asStr(entity.name).trim() || id,
      category: 'prop',
      lockProfile,
      lockWorkflow,
      persistence: strategy.persistence,
      renderStrategy: strategy.renderStrategy,
      anchorPrompt: asStr(entity.anchorPrompt).trim(),
      negativePrompt: '',
      // 2026-10-13 字段对齐：向导可见可编字段与生产同源填齐
      referencePromptEn: asStr(entity.anchorPrompt).trim(),
      referencePromptZh: chinesePromptSeedForEntity(entity),
      aliases: uniqStrings(entity.aliases, 20),
      forbiddenSubstitutes: uniqStrings(entity.forbiddenSubstitutes, 40),
      sceneIds,
      sceneCount: sceneIds.length,
      sceneEvidence: {
        bibleRefs: uniqStrings(bibleRefScenes, 80),
        text: uniqStrings(textScenes, 80)
      },
      projectCharacterId: '',
      primaryReferenceAssetId: '',
      primaryReferenceAssetUri: '',
      referenceStatus: 'missing',
      generatedRefs: [],
      referencePromptHint: referenceHintForAsset({ category: 'prop', lockProfile, ...entity })
    }
    if (!excludedAssetIds.has(id)) assetDefs.push(mergePrevAssetState(asset, prevAssetsById.get(id)))
  }

  for (const raw of asList(safeBible.locations)) {
    const entity = asObj(raw)
    const id = asStr(entity.id).trim() || `loc.${normalizeIdLike(entity.name, 'location')}`
    const bibleRefScenes = sceneUsage.locations.get(id) || []
    const textScenes = inferSceneIdsFromText(nodes, entity)
    const sceneIds = uniqStrings([...bibleRefScenes, ...textScenes], 80)
    const strategy = chooseLocationStrategy(sceneIds.length)
    const lockProfile = inferAssetLockProfile({ category: 'location', ...entity })
    const lockWorkflow = lockWorkflowForAsset({ category: 'location', lockProfile, ...entity })
    const asset = {
      id,
      name: asStr(entity.name).trim() || id,
      category: 'location',
      lockProfile,
      lockWorkflow,
      persistence: strategy.persistence,
      renderStrategy: strategy.renderStrategy,
      anchorPrompt: asStr(entity.anchorPrompt).trim(),
      negativePrompt: '',
      // 2026-10-13 字段对齐：向导可见可编字段与生产同源填齐
      referencePromptEn: asStr(entity.anchorPrompt).trim(),
      referencePromptZh: chinesePromptSeedForEntity(entity),
      aliases: uniqStrings(entity.aliases, 20),
      forbiddenSubstitutes: [],
      sceneIds,
      sceneCount: sceneIds.length,
      sceneEvidence: {
        bibleRefs: uniqStrings(bibleRefScenes, 80),
        text: uniqStrings(textScenes, 80)
      },
      projectCharacterId: '',
      primaryReferenceAssetId: '',
      primaryReferenceAssetUri: '',
      referenceStatus: 'missing',
      generatedRefs: [],
      referencePromptHint: referenceHintForAsset({ category: 'location', lockProfile, ...entity })
    }
    if (!excludedAssetIds.has(id)) assetDefs.push(mergePrevAssetState(asset, prevAssetsById.get(id)))
  }

  // 2026-10-13 去重合并：同一事物（名称/别名规范化后相交）不得双建档；
  // 被合并 id 经 dedupeIdMap 改写到场景资产引用，场景不缺资产
  const deduped = dedupeStoryAssetDefs(assetDefs)
  const dedupeIdMap = deduped.idMap
  const assetDefsFinal = deduped.assets

  const assetsById = new Map(assetDefsFinal.map((asset) => [asset.id, asset]))
  const scenes = nodes.map((node, index) => {
    const matched = matchSceneRef(sceneRefsMap, node, index)
    const ref = asObj(matched.value)
    const placements = asList(node && node.visuals && node.visuals.placements)
    const placementCharacterIds = uniqStrings(placements.map((p) => asStr(p && p.characterId).trim()).filter(Boolean), 20)
    const characterIds = uniqStrings([...(ref.characters || []).map(resolveCharacterId), ...placementCharacterIds], 40)
    const propIds = uniqStrings((ref.props || []).map(resolvePropId), 60)
    const locationIds = uniqStrings((ref.locations || []).map(resolveLocationId), 40)
    const assetIds = uniqStrings([...characterIds, ...propIds, ...locationIds].map((assetId) => dedupeIdMap.get(asStr(assetId).trim()) || assetId), 120)
      .filter((assetId) => !excludedAssetIds.has(asStr(assetId).trim()))
    const sceneAssets = assetIds.map((assetId) => assetsById.get(assetId)).filter(Boolean)
    const workflow = buildSceneWorkflow(sceneAssets)
    return {
      sceneId: asStr(node.id).trim() || `scene_${index + 1}`,
      sceneIndex: index + 1,
      sceneName: asStr(node && node.body && node.body.title).trim() || asStr(node && node.name).trim() || `场景${index + 1}`,
      summary: buildNodeSummary(node),
      sourceKey: matched.key,
      workflow,
      missingRequiredAssetIds: sceneAssets.filter((x) => x.renderStrategy === 'ref_required' && x.referenceStatus !== 'ready').map((x) => x.id),
      readyReferenceAssetIds: sceneAssets.filter((x) => x.referenceStatus === 'ready' && x.primaryReferenceAssetUri).map((x) => x.id),
      assetIds,
      promptAssets: sceneAssets.map((asset) => ({
        id: asset.id,
        name: asset.name,
        category: asset.category,
        lockProfile: asset.lockProfile || inferAssetLockProfile(asset),
        lockWorkflow: asset.lockWorkflow || lockWorkflowForAsset(asset),
        renderStrategy: asset.renderStrategy,
        referenceStatus: asset.referenceStatus,
        primaryReferenceAssetId: asset.primaryReferenceAssetId || '',
        primaryReferenceAssetUri: asset.primaryReferenceAssetUri || '',
        anchorPrompt: asset.anchorPrompt,
        negativePrompt: asset.negativePrompt || '',
        forbiddenSubstitutes: uniqStrings(asset.forbiddenSubstitutes, 20)
      }))
    }
  })

  const assets = assetDefsFinal
    .map((asset) => {
      const sceneIds = uniqStrings(asset.sceneIds, 80)
      return {
        ...asset,
        sceneIds,
        sceneCount: sceneIds.length,
        generatedRefs: asList(asset.generatedRefs).map((item) => asObj(item))
      }
    })
    .sort((a, b) => {
      const pa = a.persistence === 'high' ? 0 : (a.persistence === 'medium' ? 1 : 2)
      const pb = b.persistence === 'high' ? 0 : (b.persistence === 'medium' ? 1 : 2)
      if (pa !== pb) return pa - pb
      if (a.category !== b.category) return a.category.localeCompare(b.category)
      return a.name.localeCompare(b.name, 'en')
    })

  const worldAnchor = asStr(safeBible.worldAnchor).trim()
  const forbiddenSubstitutes = uniqStrings(safeBible.forbiddenSubstitutes, 120)
  const eventChain = uniqStrings(safeBible.eventChain, 120)

  return {
    schemaVersion: '1.0',
    generatedAt: new Date().toISOString(),
    worldAnchor,
    forbiddenSubstitutes,
    eventChain,
    excludedAssetIds: Array.from(excludedAssetIds),
    assets,
    scenes,
    summary: summarizePlan(assets, scenes)
  }
}

// 2026-09-28 出图风格预设：读取 settings.image.stylePresets[activeStylePreset]（《小猫钓鱼》样本沉淀，物理记录在设置中）。
// 所有消费端均以代码内置值为兜底——预设缺失或字段缺失时，行为与此前完全一致（向后兼容）。
export function resolveStoryStylePreset(studio) {
  const img = (studio && (studio.effective?.image || studio.image)) || {}
  const presets = img.stylePresets && typeof img.stylePresets === 'object' ? img.stylePresets : null
  const key = asStr(img.activeStylePreset).trim()
  if (!presets || !key) return null
  const preset = presets[key]
  return preset && typeof preset === 'object' ? preset : null
}

export function buildStoryAssetReferencePrompt({ plan, asset, style, globalPrompt, assetPrompt, stylePreset }) {
  const safePlan = asObj(plan)
  const safeAsset = asObj(asset)
  const category = asStr(safeAsset.category).trim()
  const lockProfile = asStr(safeAsset.lockProfile).trim() || inferAssetLockProfile(safeAsset)
  const protectedPropProfiles = new Set(['wearable_prop', 'slender_prop', 'rigid_prop', 'soft_prop', 'ambient_prop', 'organic_prop'])
  const hintText = asStr(safeAsset.referencePromptHint).trim()
  const assetPromptText = asStr(assetPrompt).trim()
  const useAssetPrompt = normalizePromptFingerprint(assetPromptText) &&
    normalizePromptFingerprint(assetPromptText) !== normalizePromptFingerprint(hintText)
    ? assetPromptText
    : ''
  const protectedPropPromptOnly = category === 'prop' && protectedPropProfiles.has(lockProfile)
  const baseParts = []
  if (category === 'location') {
    baseParts.push(asStr(safePlan.worldAnchor).trim())
  }
  if (category === 'character' || category === 'location') {
    baseParts.push(`style lock: ${asStr(style).trim() || asStr(stylePreset && stylePreset.styleLock).trim() || 'picture_book'}`)
  } else if (category === 'prop') {
    baseParts.push(
      // 2026-08-29 统一画风：卡通童话绘本（用户指令：杜绝写实/卡通混杂）
      // 2026-09-28 该风格句沉淀进 settings 风格预设（propStylePrompt/propStyleSuffix），预设缺省时用内置兜底
      asStr(stylePreset && stylePreset.propStylePrompt).trim() || 'reference render style: cartoon fairy tale picture book illustration, flat 2D cartoon, bold clean outlines, cel shading, warm soft colors',
      ...(Array.isArray(stylePreset && stylePreset.propStyleSuffix) && stylePreset.propStyleSuffix.length
        ? stylePreset.propStyleSuffix.map((x) => asStr(x).trim()).filter(Boolean)
        : ['object-lock workflow, not a story scene', 'not a character illustration', 'not a portrait'])
    )
  }
  const cleanedAnchorPrompt = category === 'character'
    ? cleanupReferenceAnchorText(safeAsset.anchorPrompt)
    : category === 'prop'
      ? cleanupPropReferenceAnchorText(safeAsset.anchorPrompt)
      : asStr(safeAsset.anchorPrompt).trim()
  // 2026-08-28 修复（P0）：保护道具原先"hint 压过 anchor 且只取其一"，主体直接丢失——
  // 参考图拼装词只剩 single slender prop reference 这类通用约束而没有事物本身，道具图全崩。
  // 主体必须始终在场：第 4 步 AI 英文稿优先，其次锚点描述；hint 降级为约束补充
  if (protectedPropPromptOnly) {
    baseParts.push(useAssetPrompt || cleanedAnchorPrompt || hintText)
    baseParts.push(hintText)
  } else {
    baseParts.push(cleanedAnchorPrompt)
    baseParts.push(hintText)
    baseParts.push(useAssetPrompt)
  }
  if (lockProfile === 'character_core') {
    baseParts.push(
      // 2026-08-29 统一画风：卡通童话绘本（用户指令：杜绝写实/卡通混杂）
      'cartoon fairy tale picture book single character key art, flat 2D cartoon illustration, bold clean outlines, cel shading',
      'one adult character only',
      'single full-body front view',
      'one single pose',
      'centered composition',
      'pure white seamless studio background',
      'neutral relaxed pose',
      'non-human animal character if described as animal',
      'visible animal ears',
      'fur-covered face if animal',
      'empty hands',
      'pure white background'
    )
  } else if (lockProfile === 'wearable_prop') {
    baseParts.push(
      'single prop product reference',
      'exactly one object only',
      'single isolated object only',
      'single view only',
      'pure white background',
      'centered product-style product shot',
      'show the object alone',
      'full object fully visible in frame',
      'clear silhouette and material structure',
      'no collage',
      'no contact sheet',
      'no multi-view layout',
      'no duplicate objects',
      'not being worn',
      'no wearer context',
      'no holder',
      'no hand',
      'no person',
      'no character',
      'no mannequin',
      'no head',
      'no face',
      'no upper body'
    )
    baseParts.push(
      'detached wearable accessory reference',
      'unworn wearable item shown alone',
      'object-only merchandise illustration',
      'no body inside the object',
      'interior opening visible if applicable',
      'single product angle only',
      'laid-flat or floating merchandise reference',
      'not on a head',
      'not on a body',
      'detached from any outfit',
      'no scalp',
      'no hair',
      'no ears',
      'no child model',
      'no mannequin head',
      'chin cord fully visible if applicable'
    )
    const wearableHay = [
      asStr(safeAsset.name),
      asStr(safeAsset.anchorPrompt),
      ...asList(safeAsset.aliases)
    ].join(' ').toLowerCase()
    if (/\b(hat|cap|helmet|hood)\b/.test(wearableHay)) {
      baseParts.push(
        'hat shown as a standalone object',
        'brim contour fully unobstructed',
        'crown shape clearly readable',
        'opening under the hat visible',
        'chin cord attached to the brim, not around a wearer',
        'hat placed alone on a white surface or floating alone',
        'horizontal object layout',
        'no portrait framing',
        'no shoulders or neckline',
        'object-only hat catalog reference',
        'no pedestal',
        'no display base'
      )
    }
  } else if (lockProfile === 'slender_prop') {
    baseParts.push(
      'single slender object reference',
      'exactly one object only',
      'show the object alone',
      'full length visible from end to end',
      'full object fully visible in frame',
      'centered isolated object',
      'stable single view',
      'minimal foreshortening',
      'straight readable silhouette',
      'clear ends, openings, holes or joints if applicable',
      'pure white background',
      'no duplicate objects',
      'no collage',
      'no multi-view layout',
      'not in use',
      'not attached to any character',
      'not attached to any holder or ground',
      'no hand',
      'no person',
      'no environment'
    )
  } else if (lockProfile === 'rigid_prop') {
    baseParts.push(
      'single rigid object design reference',
      'stable perspective',
      'major structural parts fully readable',
      'clear front and side volume relationship',
      'exactly one object only',
      'pure white background',
      'no person',
      'no environment clutter',
      'no deformation'
    )
  } else if (lockProfile === 'soft_prop') {
    baseParts.push(
      'single soft-form object reference',
      'isolated object only',
      'stable outer contour',
      'readable volume and surface folds',
      'clean light background',
      'no wearer',
      'no person',
      'no scene composition'
    )
  } else if (lockProfile === 'ambient_prop') {
    baseParts.push(
      'single atmospheric motif reference',
      'isolated simple shape',
      'clean pale background',
      'no horizon',
      'no landscape',
      'no character',
      'no scene environment',
      'focus on silhouette and internal soft structure'
    )
  } else if (lockProfile === 'organic_prop') {
    baseParts.push(
      'single natural specimen reference',
      'isolated subject only',
      'clear biological silhouette',
      'surface pattern and anatomy readable',
      'clean background',
      'no habitat',
      'no person',
      'no extra objects'
    )
  } else if (category === 'prop') {
    baseParts.push(
      'single prop product reference',
      'exactly one object only',
      'single isolated object only',
      'single view only',
      'pure white background',
      'centered product-style product shot',
      'show the object alone',
      'full object fully visible in frame',
      'clear silhouette and material structure',
      'no collage',
      'no contact sheet',
      'no multi-view layout',
      'no duplicate objects',
      'no hand',
      'no person',
      'no environment'
    )
  }
  const parts = baseParts
  return uniqStrings(parts.flatMap(splitCsvLike), 80).join(', ')
}

export function buildStoryAssetReferenceNegativePrompt({ plan, asset, globalNegativePrompt, assetNegativePrompt }) {
  const safePlan = asObj(plan)
  const safeAsset = asObj(asset)
  const lockProfile = asStr(safeAsset.lockProfile).trim() || inferAssetLockProfile(safeAsset)
  const base = [
    ...uniqStrings(splitCsvLike(asStr(assetNegativePrompt).trim()), 80),
    ...uniqStrings(safePlan.forbiddenSubstitutes, 40),
    ...uniqStrings(safeAsset.forbiddenSubstitutes, 20)
  ]
  const category = asStr(safeAsset.category).trim()
  // 2026-08-29 全项目统一画风：卡通童话绘本；负向统一排除写实系（用户指令：杜绝写实/卡通混杂）
  base.push(
    'photorealistic', 'realistic', 'hyperrealistic', 'semi-realistic', 'photograph', 'photo',
    '3d render', 'cgi', 'octane render', 'unreal engine', 'oil painting', 'thick impasto', 'acrylic painting'
  )
  if (lockProfile === 'character_core') {
    base.push(
      'crowd', 'multiple characters', 'multiple views', 'turnaround sheet', 'reference sheet', 'multi-view sheet', 'collage',
      'front and back views', 'three views', 'complex background', 'busy environment', 'text', 'watermark',
      'child', 'kid', 'baby', 'toddler', 'young child', 'little boy', 'little girl',
      'catgirl', 'kemonomimi', 'anime human ears', 'decorative background',
      'ground shadow', 'floor shadow', 'scenery', 'background', 'trees', 'grass', 'plants', 'water', 'shore', 'bridge',
      'side view', 'three quarter view', 'back view'
    )
  } else if (lockProfile === 'wearable_prop') {
    base.push(
      'hands', 'holding hand', 'person', 'character', 'human', 'child', 'girl', 'boy',
      'head', 'face', 'portrait', 'upper body', 'torso', 'wearing', 'worn on head', 'model wearing object', 'mannequin',
      'body inside object', 'occupied interior', 'hanger', 'hat rack', 'display stand',
      'complex background', 'scene background', 'environment', 'trees', 'grass', 'water',
      'multiple hats', 'duplicate objects', 'collage', 'contact sheet', 'multi view', 'triptych', 'grid layout',
      'mannequin head', 'head model', 'child model', 'fashion editorial', 'lookbook', 'scalp', 'hair', 'ears through hat',
      'text', 'watermark', 'shadow-heavy scene'
    )
    const wearableHay = [
      asStr(safeAsset.name),
      asStr(safeAsset.anchorPrompt),
      ...asList(safeAsset.aliases)
    ].join(' ').toLowerCase()
    if (/\b(hat|cap|helmet|hood)\b/.test(wearableHay)) {
      base.push(
        'woman', 'female body', 'beauty shot', 'collarbone', 'neckline', 'shoulders',
        'statue', 'sculpture', 'bust', 'figurine', 'doll', 'pedestal', 'display base',
        'adult sunhat model', 'fashion hat portrait'
      )
    }
  } else if (lockProfile === 'slender_prop') {
    base.push(
      'cropped object', 'cut-off tip', 'foreshortening', 'bent object', 'curved object', 'twisted object',
      'hand holding', 'holding pose', 'paws holding', 'person', 'character', 'animal', 'child', 'girl', 'boy',
      'environment', 'scene background', 'multiple objects', 'collage', 'multi view',
      'multiple views', 'design sheet', 'multi-view layout', 'multiple houses', 'vertical layout', 'concept sheet',
      'water surface', 'shore', 'grass', 'soil', 'ground contact',
      'text', 'watermark', 'broken parts'
    )
  } else if (lockProfile === 'rigid_prop') {
    base.push(
      'deformed structure', 'warped perspective', 'melted object', 'collapsed shape', 'extra attachments',
      'person', 'character', 'environment', 'clutter', 'multiple objects', 'collage', 'cut off',
      'multiple views', 'design sheet', 'multi-view layout', 'concept sheet', 'trees', 'grass',
      'text', 'watermark'
    )
  } else if (lockProfile === 'soft_prop') {
    base.push(
      'person', 'character', 'wearing display', 'environment', 'complex background', 'multiple objects',
      'collage', 'text', 'watermark', 'hard rigid structure'
    )
  } else if (lockProfile === 'ambient_prop') {
    base.push(
      'landscape', 'horizon', 'full sky scene', 'mountains', 'trees', 'buildings', 'character', 'person',
      'multiple clouds', 'storm scene', 'rain scene', 'sunset landscape', 'text', 'watermark',
      'multiple views', 'design sheet', 'multi-view layout', 'concept sheet',
      'house', 'roof', 'room interior', 'bushes', 'shrubs', 'ground', 'floor', 'shadows'
    )
  } else if (lockProfile === 'organic_prop') {
    base.push(
      'habitat scene', 'person holding', 'multiple specimens', 'crowd', 'background plants', 'environment',
      'text', 'watermark', 'cropped anatomy'
    )
  } else if (category === 'prop') {
    base.push(
      'person', 'character', 'environment', 'multiple objects', 'collage', 'text', 'watermark',
      'multiple views', 'design sheet', 'multi-view layout', 'concept sheet', 'trees', 'grass',
      'bushes', 'shrubs', 'ground', 'floor', 'shadows'
    )
  } else if (category === 'location') {
    base.push('character close-up', 'crowd', 'text', 'watermark')
  }
  return uniqStrings(base, 120).join(', ')
}

// 背景-only 模式（背景+立绘分层合成方向）：人物/事物由独立透明立绘经运行时 placements 合成，
// 场景图只出背景。以下为背景图负提示词的通用人物/事物排除词（不含具体故事专有词）。
// 2026-09-27：移除三只小猪时期遗留的 pig/piglet/wolf 动物名硬编码（项目级污染，改由 plan.forbiddenSubstitutes 驱动）；
// 但保留 open book/book/pages——"picture book" 风格词会诱导模型画出实体书本（项目无关的风格词副作用，实测 3/10 场景中招被 AI 评审拦下）。
const BACKGROUND_ONLY_SUBJECT_EXCLUSIONS = [
  'person', 'people', 'human', 'character', 'portrait', 'face',
  'man', 'woman', 'boy', 'girl', 'child', 'kid', 'crowd', 'figure',
  'animal', 'open book', 'book', 'pages', 'readable text'
]

// 从场景描述文本中剥离出场角色/道具的名字与别名（立绘层承担人物事物，背景图不再描述）。
// 长名优先替换，避免短名先删造成的残留碎片；只做确定性字符串剔除，不做语义改写。
export function stripSubjectMentionsFromSceneText(text, subjects) {
  let out = asStr(text)
  const names = []
  for (const subject of asList(subjects)) {
    names.push(asStr(subject && subject.name))
    for (const alias of asList(subject && subject.aliases)) names.push(asStr(alias))
  }
  const uniq = uniqStrings(names, 60).filter(Boolean).sort((a, b) => b.length - a.length)
  for (const name of uniq) out = out.split(name).join('')
  return cleanupReferenceAnchorText(out)
}

export function buildStorySceneRenderSpec({ plan, sceneId, mode, stylePreset }) {
  const safePlan = asObj(plan)
  const scenes = asList(safePlan.scenes)
  const scene = scenes.find((item) => asStr(item && item.sceneId).trim() === asStr(sceneId).trim()) || null
  if (!scene) return null
  const backgroundOnly = asStr(mode).trim() === 'background'
  const assetsById = new Map(asList(safePlan.assets).map((item) => [asStr(item && item.id).trim(), asObj(item)]))
  // 场景→资产关联双源：优先 scene.promptAssets；为空时从资产侧 sceneIds 反推
  // （2026-08-30 缺陷修复：计划生成器只写了资产侧 sceneIds，scene.promptAssets 全空，
  //  导致场景渲染 prompt 只剩 worldAnchor，出图同质跑题）
  const sceneAssetRefs = asList(scene.promptAssets)
  const derivedFromAssets = sceneAssetRefs.length
    ? []
    : asList(safePlan.assets).filter((asset) => asList(asset && asset.sceneIds).some((sid) => asStr(sid) === asStr(sceneId).trim()))
  const allPromptAssets = [...sceneAssetRefs, ...derivedFromAssets]
    .map((item) => {
      const live = assetsById.get(asStr(item && item.id).trim())
      return live || asObj(item)
    })
    .filter(Boolean)
  // 背景-only（2026-08-30 修正）：只剔除「角色」——角色由立绘 placements 合成（placements 仅 character，
  // prop 不合成属已知限制），道具（房屋/锅/烟囱/壁炉等）必须画进背景图，其锚点进 promptLocks、
  // 已锁定参考图进 referenceAssets 指导画面。此前连道具一起剔除，导致场景图丢房屋等关键内容。
  // 2026-09-09 分层合成工艺接管：scene.layeredComposition=true 时道具改为透明立绘分层摆入（同角色），
  // 背景只画环境——道具从 promptLocks 与叙事剥离对象中一并剔除，禁止锚点把道具烘进背景
  // （乌鸦喝水实测：玻璃瓶锚点经 promptLocks+worldAnchor 烘进全部 11 张背景，分层失效的根因）。
  const isCharacterAsset = (asset) => asStr(asset && asset.category).trim() === 'character'
  const layeredComposition = asObj(scene).layeredComposition === true
  const excludedSubjects = backgroundOnly
    ? (layeredComposition ? allPromptAssets : allPromptAssets.filter(isCharacterAsset))
    : []
  const promptAssets = backgroundOnly
    ? (layeredComposition ? [] : allPromptAssets.filter((asset) => !isCharacterAsset(asset)))
    : allPromptAssets
  // 2026-08-30 实测：背景-only 喂透明抠图作图像参考会把整图洗白（4 张参考压过 prompt），
  // 背景图只用文字锚点（promptLocks）保证一致性，不喂图像参考、不做 ref_required 硬门禁。
  const referenceAssets = backgroundOnly ? [] : promptAssets.filter((asset) => asStr(asset.primaryReferenceAssetUri).trim())
  // S4-02：必须参考图的资产（ref_required）按当前计划状态实时判定。
  // 场景条目里存量的 missingRequiredAssetIds 是建计划时的快照，锁定写回后不会更新，
  // 因此这里以 live 资产记录为准，避免「已锁定仍误判缺失」或「引用被清空仍误判就绪」。
  // 背景-only 模式不喂图像参考（见上注释），ref_required 门禁也随之不适用于背景图。
  const requiredAssets = backgroundOnly ? [] : promptAssets.filter((asset) => asStr(asset.renderStrategy).trim() === 'ref_required')
  // 2026-10-07 门禁硬化：以 primaryReferenceAssetUri 为唯一真相——referenceStatus 是派生缓存，
  // 会被过期合并写回脏（公主穿衣 7 资产已锁仍被拦事故）。uri 在=已锁，uri 空=未锁。
  const missingRequiredAssets = requiredAssets
    .filter((asset) => !asStr(asset.primaryReferenceAssetUri).trim())
    .map((asset) => ({
      id: asStr(asset.id).trim(),
      name: asStr(asset.name).trim(),
      category: asStr(asset.category).trim(),
      referenceStatus: asStr(asset.referenceStatus).trim() || 'missing',
      reason: 'reference_not_locked'
    }))
  const promptLocks = promptAssets
    .map((asset) => `${asStr(asset.name).trim()}: ${asStr(asset.anchorPrompt).trim()}`)
    .filter((line) => !/: $/.test(line))
    .slice(0, 30)
  // 2026-09-27 背景 prompt 环境化：location 锚点与 prop/character 锚点分流。
  // 背景图只拼 environmentLocks（纯环境）；prop/character 锚点（subjectLocks，仅留痕）不进背景 prompt——
  // 道具/角色由分层立绘合成提供，锚点进背景会把主体烘进背景图（还会与负面词打架）。
  // 注意：背景-only + layeredComposition 时 promptAssets 已被清空（道具全剥离），
  // 环境锚点必须从 allPromptAssets 取——地点永远属于背景层。
  const isLocationAsset = (asset) => asStr(asset && asset.category).trim() === 'location'
  const environmentLocks = (backgroundOnly ? allPromptAssets : promptAssets)
    .filter(isLocationAsset)
    .map((asset) => `${asStr(asset.name).trim()}: ${asStr(asset.anchorPrompt).trim()}`)
    .filter((line) => !/: $/.test(line))
    .slice(0, 20)
  const subjectLocks = promptAssets
    .filter((asset) => !isLocationAsset(asset))
    .map((asset) => `${asStr(asset.name).trim()}: ${asStr(asset.anchorPrompt).trim()}`)
    .filter((line) => !/: $/.test(line))
    .slice(0, 30)
  // 2026-08-30 缺陷修复：全局 forbiddenSubstitutes 里含 wood_house/brick_house/straw_house 等资产词条，
  // 原样塞进 negative 会把本场景需要的房子全部禁掉（出图没有任何房屋的直接原因）。
  // 这里剔除与「本场景所需资产」的 id 末段/名称/别名精确匹配的条目（替代品如 wooden_door 仍保留）。
  const neededTokens = new Set()
  for (const asset of promptAssets) {
    const rawId = asStr(asset && asset.id)
    const idTail = rawId.includes('.') ? rawId.split('.').pop() : rawId
    for (const tok of [rawId, idTail, asStr(asset && asset.name), ...asList(asset && asset.aliases).map((x) => asStr(x))]) {
      const t = asStr(tok).toLowerCase()
      if (t) {
        neededTokens.add(t)
        neededTokens.add(t.replace(/\s+/g, '_'))
        neededTokens.add(t.replace(/_+/g, ' '))
      }
    }
  }
  const globalForbidden = uniqStrings(safePlan.forbiddenSubstitutes, 40)
    .filter((entry) => !neededTokens.has(asStr(entry).toLowerCase()))
  const negativeParts = uniqStrings([
    ...globalForbidden,
    ...promptAssets.flatMap((asset) => uniqStrings(asset.forbiddenSubstitutes, 12)),
    ...(backgroundOnly
      ? (Array.isArray(stylePreset && stylePreset.backgroundSubjectExclusions) && stylePreset.backgroundSubjectExclusions.length
          ? stylePreset.backgroundSubjectExclusions.map((x) => asStr(x).trim()).filter(Boolean)
          : BACKGROUND_ONLY_SUBJECT_EXCLUSIONS)
      : [])
  ], 120)
  const summary = asStr(scene.summary).trim()
  return {
    sceneId: asStr(scene.sceneId).trim(),
    sceneIndex: Number(scene.sceneIndex || 0),
    sceneName: asStr(scene.sceneName).trim(),
    workflow: asStr(scene.workflow).trim() || 'scene_prompt_only',
    mode: backgroundOnly ? 'background' : 'full',
    summary,
    // 背景-only：剔除人物/事物名称后的场景描述，路由直接作为出图 prompt 使用
    backgroundPrompt: backgroundOnly ? stripSubjectMentionsFromSceneText(summary, excludedSubjects) : '',
    // 背景-only 被剔除的人物/事物资产（证据留痕，便于审核与排查）
    excludedSubjects: excludedSubjects.map((asset) => ({
      id: asStr(asset.id).trim(),
      name: asStr(asset.name).trim(),
      category: asStr(asset.category).trim()
    })),
    promptLocks,
    environmentLocks,
    subjectLocks,
    negativePrompt: negativeParts.join(', '),
    // 2026-09-09 分层场景：worldAnchor 同样剥离道具/角色提及（乌鸦喝水实测 worldAnchor 含"玻璃瓶内水面倒影"
    // 导致瓶子烘进全部背景）；非分层场景保持原锚点不动
    worldAnchor: layeredComposition ? stripSubjectMentionsFromSceneText(safePlan.worldAnchor, allPromptAssets) : String(safePlan.worldAnchor || '').trim(),
    referenceAssets: referenceAssets.flatMap((asset) => {
      const primary = {
        id: asStr(asset.id).trim(),
        name: asStr(asset.name).trim(),
        category: asStr(asset.category).trim(),
        lockProfile: asStr(asset.lockProfile).trim() || inferAssetLockProfile(asset),
        lockWorkflow: asStr(asset.lockWorkflow).trim() || lockWorkflowForAsset(asset),
        assetId: asStr(asset.primaryReferenceAssetId).trim(),
        assetUri: asStr(asset.primaryReferenceAssetUri).trim(),
        weight: asStr(asset.category).trim() === 'character' ? 0.9 : 0.8
      }
      // 线稿成品作为附加参考（低权重）：让锁定线稿真实参与场景出图
      const lineartUri = asStr(asset.lineartFinalAssetUri).trim()
      if (!lineartUri) return [primary]
      return [primary, { ...primary, assetId: asStr(asset.lineartFinalAssetId).trim() || primary.assetId, assetUri: lineartUri, weight: 0.5 }]
    }),
    missingRequiredAssetIds: missingRequiredAssets.map((asset) => asset.id),
    missingRequiredAssets,
    requiredAssetIds: requiredAssets.map((asset) => asStr(asset.id).trim()).filter(Boolean)
  }
}

export function defaultStoryAssetPlanFilename(projectId) {
  return `story_asset_plan_${slugify(projectId, 'project')}.json`
}

// 确定性场景↦资产关联修复：用资产名称/别名（+调用方提供的证据别名 aliasOverrides）在场景文本
//（sceneName + summary）中做子串匹配，重建 scene.promptAssets 与 asset.sceneIds/sceneCount。
// 不做语义猜测：匹配不到就为空；幂等，可重复执行。
export function repairStoryAssetPlanSceneLinks(plan, { aliasOverrides = {} } = {}) {
  const safePlan = asObj(plan)
  const scenes = asList(safePlan.scenes)
  const assets = asList(safePlan.assets)
  const overrides = asObj(aliasOverrides)
  const sceneIdsByAsset = new Map(assets.map((asset) => [asStr(asset && asset.id), []]))
  const changes = []

  const nextScenes = scenes.map((scene) => {
    const sceneId = asStr(scene && scene.sceneId)
    const text = `${asStr(scene && scene.sceneName)} ${asStr(scene && scene.summary)}`
    // 2026-09-09 分层合成工艺：layeredComposition=true 的场景，道具由立绘分层摆入、不进背景图，
    // promptAssets 只保留角色（背景-only 渲染会按 promptAssets 组成锚点，道具锚点会把房子画进背景）；
    // 道具的 sceneIds 关联仍照常记录（姿势场景选项等消费它）。
    const layered = asObj(scene).layeredComposition === true
    const matched = []
    for (const asset of assets) {
      const assetId = asStr(asset && asset.id)
      if (!assetId) continue
      const tokens = uniqStrings([
        asStr(asset && asset.name),
        ...asList(asset && asset.aliases).map((x) => asStr(x)),
        ...asList(overrides[assetId]).map((x) => asStr(x))
      ], 40).filter(Boolean)
      if (tokens.some((tok) => text.includes(tok))) {
        const category = asStr(asset && asset.category)
        if (!layered || category === 'character') {
          matched.push({ id: assetId, name: asStr(asset && asset.name), category })
        }
        const list = sceneIdsByAsset.get(assetId)
        if (list && sceneId) list.push(sceneId)
      }
    }
    const before = asList(scene && scene.promptAssets).map((x) => asStr(x && x.id)).filter(Boolean)
    const after = matched.map((x) => x.id)
    if (before.join(',') !== after.join(',')) changes.push({ sceneId, before, after })
    return { ...asObj(scene), promptAssets: matched }
  })

  const nextAssets = assets.map((asset) => {
    const assetId = asStr(asset && asset.id)
    const sceneIds = sceneIdsByAsset.get(assetId) || []
    return { ...asObj(asset), sceneIds, sceneCount: sceneIds.length }
  })

  return { plan: { ...safePlan, scenes: nextScenes, assets: nextAssets }, changes }
}
