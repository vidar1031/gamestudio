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

function matchSceneRef(sceneRefsMap, node, index) {
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
  const out = []
  for (let i = 0; i < nodes.length; i += 1) {
    const node = nodes[i]
    const hay = `${asStr(node && node.name)} ${asStr(node && node.body && node.body.title)} ${asStr(node && node.body && node.body.text)}`.toLowerCase()
    if (names.some((x) => hay.includes(x.toLowerCase()))) out.push(asStr(node && node.id).trim() || `scene_${i + 1}`)
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

function normalizeSceneRefs(storyBible) {
  const sceneRefsIn = asObj(storyBible && storyBible.sceneRefs)
  const out = new Map()
  for (const [key, raw] of Object.entries(sceneRefsIn)) {
    const value = asObj(raw)
    out.set(normalizeLooseKey(key), {
      key,
      value: {
        characters: uniqStrings(value.characters, 40),
        props: uniqStrings(value.props, 60),
        locations: uniqStrings(value.locations, 40)
      }
    })
  }
  return out
}

function buildEntityIdResolver(items) {
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
  let out = asStr(text).trim()
  if (!out) return ''
  out = out
    .replace(/wearing\s+a\s+small\s+round\s+flat-brim\s+straw\s+hat\s+with\s+green\s+chin\s+cord,?\s*/gi, '')
    .replace(/small\s+wooden\s+fish\s+bucket,?\s*/gi, '')
    .replace(/slender\s+bamboo\s+fishing\s+rod,?\s*/gi, '')
    .replace(/\bwith\s+green\s+chin\s+cord\b,?\s*/gi, '')
    .replace(/\s{2,}/g, ' ')
    .replace(/\s+,/g, ',')
    .replace(/,,+/g, ',')
    .trim()
  return out.replace(/^[,;\s]+|[,;\s]+$/g, '')
}

function cleanupPropReferenceAnchorText(text) {
  let out = asStr(text).trim()
  if (!out) return ''
  out = out
    .replace(/tied\s+under\s+chin/gi, 'attached to the brim with the chin cord hanging loose')
    .replace(/under\s+chin/gi, 'below the brim')
    .replace(/\bchild\s+size\b/gi, 'small product size')
    .replace(/\bchild-sized\b/gi, 'small product-sized')
    .replace(/\bon\s+head\b/gi, 'as an unworn object')
    .replace(/\bwear(?:ing|er)\b/gi, 'object')
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
    '马桶', '坐便器', '厕所', '椅子', '桌子', '水桶', '杯子', '瓶子', '箱子', '台灯', '闹钟'
  ])) return 'rigid_prop'
  if (hasKeyword(hay, [
    'pillow', 'blanket', 'quilt', 'balloon', 'cotton', 'fabric bundle', 'marshmallow',
    '枕头', '被子', '棉被', '气球', '棉花', '布团'
  ])) return 'soft_prop'
  if (hasKeyword(hay, [
    'fish', 'butterfly', 'flower', 'leaf', 'feather', 'shell', 'fruit', 'apple', 'pear',
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

export function getStoryAssetRenderProfile(asset) {
  const profile = asStr(asset && asset.lockProfile).trim() || inferAssetLockProfile(asset)
  if (profile === 'character_core') {
    return { width: 768, height: 1152, workflowMode: 'story_asset_character_sheet', profile }
  }
  if (profile === 'location_anchor') {
    return { width: 960, height: 544, workflowMode: 'story_asset_location_anchor', profile }
  }
  if (profile === 'slender_prop') {
    return { width: 640, height: 1024, workflowMode: 'story_asset_prop_slender', profile }
  }
  if (profile === 'ambient_prop') {
    return { width: 896, height: 896, workflowMode: 'story_asset_prop_ambient', profile }
  }
  if (profile === 'soft_prop') {
    return { width: 896, height: 896, workflowMode: 'story_asset_prop_soft', profile }
  }
  if (profile === 'organic_prop') {
    return { width: 768, height: 768, workflowMode: 'story_asset_prop_specimen', profile }
  }
  if (profile === 'wearable_prop') {
    if (isHatLikeProp(asset)) {
      return { width: 1024, height: 768, workflowMode: 'story_asset_prop_hat', profile }
    }
    return { width: 768, height: 768, workflowMode: 'story_asset_prop_wearable', profile }
  }
  return { width: 832, height: 832, workflowMode: 'story_asset_prop_product', profile }
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
    lineartGeneratedAt: asStr(prevAsset.lineartGeneratedAt).trim()
  }
}

function referenceHintForCategory(category) {
  if (category === 'character') {
    return 'single subject character reference sheet, pure white background, full body, centered front view, empty hands, no props, no hat, no scene environment, stable face and outfit'
  }
  if (category === 'prop') {
    return 'single prop product reference, exactly one object only, pure white background, centered single view, full silhouette visible, clear material and structure, no person, no head, no hand, not being worn, no collage, no multi-view sheet, no environment'
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
      return 'single hat reference, exactly one detached straw hat only, pure white background, centered single view, full silhouette visible, opening under the hat visible, brim contour fully unobstructed, no wearer, no mannequin, no head, no shoulders, no portrait'
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

  const assetDefs = []

  for (const raw of asList(safeBible.characters)) {
    const entity = asObj(raw)
    const id = asStr(entity.id).trim() || `char.${normalizeIdLike(entity.name, 'character')}`
    const projectCharacter = matchProjectCharacter(safeProject, entity)
    const placementScenes = inferCharacterSceneIdsFromPlacements(nodes, asStr(projectCharacter && projectCharacter.id).trim())
    const textScenes = inferSceneIdsFromText(nodes, entity)
    const sceneIds = uniqStrings([...(sceneUsage.characters.get(id) || []), ...placementScenes, ...textScenes], 80)
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
      aliases: uniqStrings(entity.aliases, 20),
      forbiddenSubstitutes: [],
      sceneIds,
      sceneCount: sceneIds.length,
      projectCharacterId: asStr(projectCharacter && projectCharacter.id).trim() || '',
      primaryReferenceAssetId: refAsset ? asStr(refAsset.id).trim() : '',
      primaryReferenceAssetUri: refAsset ? asStr(refAsset.uri).trim() : '',
      referenceStatus: refAsset && asStr(refAsset.uri).trim() ? 'ready' : 'missing',
      generatedRefs: [],
      referencePromptHint: referenceHintForAsset({ category: 'character', lockProfile, ...entity })
    }
    assetDefs.push(mergePrevAssetState(asset, prevAssetsById.get(id)))
  }

  for (const raw of asList(safeBible.props)) {
    const entity = asObj(raw)
    const id = asStr(entity.id).trim() || `prop.${normalizeIdLike(entity.name, 'prop')}`
    const sceneIds = uniqStrings([...(sceneUsage.props.get(id) || []), ...inferSceneIdsFromText(nodes, entity)], 80)
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
      aliases: uniqStrings(entity.aliases, 20),
      forbiddenSubstitutes: uniqStrings(entity.forbiddenSubstitutes, 40),
      sceneIds,
      sceneCount: sceneIds.length,
      projectCharacterId: '',
      primaryReferenceAssetId: '',
      primaryReferenceAssetUri: '',
      referenceStatus: 'missing',
      generatedRefs: [],
      referencePromptHint: referenceHintForAsset({ category: 'prop', lockProfile, ...entity })
    }
    assetDefs.push(mergePrevAssetState(asset, prevAssetsById.get(id)))
  }

  for (const raw of asList(safeBible.locations)) {
    const entity = asObj(raw)
    const id = asStr(entity.id).trim() || `loc.${normalizeIdLike(entity.name, 'location')}`
    const sceneIds = uniqStrings([...(sceneUsage.locations.get(id) || []), ...inferSceneIdsFromText(nodes, entity)], 80)
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
      aliases: uniqStrings(entity.aliases, 20),
      forbiddenSubstitutes: [],
      sceneIds,
      sceneCount: sceneIds.length,
      projectCharacterId: '',
      primaryReferenceAssetId: '',
      primaryReferenceAssetUri: '',
      referenceStatus: 'missing',
      generatedRefs: [],
      referencePromptHint: referenceHintForAsset({ category: 'location', lockProfile, ...entity })
    }
    assetDefs.push(mergePrevAssetState(asset, prevAssetsById.get(id)))
  }

  const assetsById = new Map(assetDefs.map((asset) => [asset.id, asset]))
  const scenes = nodes.map((node, index) => {
    const matched = matchSceneRef(sceneRefsMap, node, index)
    const ref = asObj(matched.value)
    const placements = asList(node && node.visuals && node.visuals.placements)
    const placementCharacterIds = uniqStrings(placements.map((p) => asStr(p && p.characterId).trim()).filter(Boolean), 20)
    const characterIds = uniqStrings([...(ref.characters || []).map(resolveCharacterId), ...placementCharacterIds], 40)
    const propIds = uniqStrings((ref.props || []).map(resolvePropId), 60)
    const locationIds = uniqStrings((ref.locations || []).map(resolveLocationId), 40)
    const assetIds = uniqStrings([...characterIds, ...propIds, ...locationIds], 120)
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

  const assets = assetDefs
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
    assets,
    scenes,
    summary: summarizePlan(assets, scenes)
  }
}

export function buildStoryAssetReferencePrompt({ plan, asset, style, globalPrompt, assetPrompt }) {
  const safePlan = asObj(plan)
  const safeAsset = asObj(asset)
  const category = asStr(safeAsset.category).trim()
  const lockProfile = asStr(safeAsset.lockProfile).trim() || inferAssetLockProfile(safeAsset)
  const hintText = asStr(safeAsset.referencePromptHint).trim()
  const assetPromptText = asStr(assetPrompt).trim()
  const useAssetPrompt = normalizePromptFingerprint(assetPromptText) && normalizePromptFingerprint(assetPromptText) !== normalizePromptFingerprint(hintText)
    ? assetPromptText
    : ''
  const baseParts = []
  if (category === 'location') {
    baseParts.push(asStr(safePlan.worldAnchor).trim())
    baseParts.push(asStr(globalPrompt).trim())
  }
  if (category === 'character' || category === 'location') {
    baseParts.push(`style lock: ${asStr(style).trim() || 'picture_book'}`)
  } else if (category === 'prop') {
    baseParts.push(
      'reference render style: neutral isolated design-sheet illustration',
      'object-lock workflow, not a story scene',
      'not a character illustration',
      'not a portrait'
    )
  }
  baseParts.push(
    category === 'character'
      ? cleanupReferenceAnchorText(safeAsset.anchorPrompt)
      : category === 'prop'
        ? cleanupPropReferenceAnchorText(safeAsset.anchorPrompt)
        : asStr(safeAsset.anchorPrompt).trim()
  )
  baseParts.push(hintText)
  baseParts.push(useAssetPrompt)
  if (lockProfile === 'character_core') {
    baseParts.push(
      'children picture book character turnaround key art',
      'full body',
      'front view',
      'centered composition',
      'pure white seamless studio background',
      'no floor line',
      'no cast shadow',
      'neutral relaxed pose',
      'non-human animal child if described as animal',
      'visible animal ears',
      'visible cat nose and short feline muzzle if cat',
      'fur-covered face if animal',
      'empty hands',
      'no props',
      'without hat',
      'without fishing rod',
      'without bucket',
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
      'full length visible from end to end',
      'centered isolated object',
      'stable single view',
      'minimal foreshortening',
      'straight readable silhouette',
      'clear ends, openings, holes or joints if applicable',
      'pure white background',
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
    ...uniqStrings(splitCsvLike(asStr(globalNegativePrompt).trim()), 80),
    ...uniqStrings(splitCsvLike(asStr(assetNegativePrompt).trim()), 80),
    ...uniqStrings(safePlan.forbiddenSubstitutes, 40),
    ...uniqStrings(safeAsset.forbiddenSubstitutes, 20)
  ]
  const category = asStr(safeAsset.category).trim()
  if (lockProfile === 'character_core') {
    base.push(
      'crowd', 'multiple characters', 'complex background', 'busy environment', 'text', 'watermark',
      'human child', 'human face', 'catgirl', 'kemonomimi', 'anime human ears', 'decorative background',
      'ground shadow', 'floor shadow', 'scenery', 'background', 'trees', 'grass', 'plants', 'water', 'shore', 'bridge',
      'hat', 'straw hat', 'bucket', 'fishing rod', 'basket', 'wood stick', 'side view', 'three quarter view', 'back view'
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
      'hand holding', 'person', 'character', 'environment', 'multiple objects', 'collage', 'multi view',
      'text', 'watermark', 'broken parts'
    )
  } else if (lockProfile === 'rigid_prop') {
    base.push(
      'deformed structure', 'warped perspective', 'melted object', 'collapsed shape', 'extra attachments',
      'person', 'character', 'environment', 'clutter', 'multiple objects', 'collage', 'cut off',
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
      'multiple clouds', 'storm scene', 'rain scene', 'sunset landscape', 'text', 'watermark'
    )
  } else if (lockProfile === 'organic_prop') {
    base.push(
      'habitat scene', 'person holding', 'multiple specimens', 'crowd', 'background plants', 'environment',
      'text', 'watermark', 'cropped anatomy'
    )
  } else if (category === 'prop') {
    base.push(
      'person', 'character', 'environment', 'multiple objects', 'collage', 'text', 'watermark'
    )
  } else if (category === 'location') {
    base.push('character close-up', 'crowd', 'text', 'watermark')
  }
  return uniqStrings(base, 120).join(', ')
}

export function buildStorySceneRenderSpec({ plan, sceneId }) {
  const safePlan = asObj(plan)
  const scenes = asList(safePlan.scenes)
  const scene = scenes.find((item) => asStr(item && item.sceneId).trim() === asStr(sceneId).trim()) || null
  if (!scene) return null
  const assetsById = new Map(asList(safePlan.assets).map((item) => [asStr(item && item.id).trim(), asObj(item)]))
  const promptAssets = asList(scene.promptAssets)
    .map((item) => {
      const live = assetsById.get(asStr(item && item.id).trim())
      return live || asObj(item)
    })
    .filter(Boolean)
  const referenceAssets = promptAssets.filter((asset) => asStr(asset.primaryReferenceAssetUri).trim())
  const promptLocks = promptAssets
    .map((asset) => `${asStr(asset.name).trim()}: ${asStr(asset.anchorPrompt).trim()}`)
    .filter((line) => !/: $/.test(line))
    .slice(0, 30)
  const negativeParts = uniqStrings([
    ...uniqStrings(safePlan.forbiddenSubstitutes, 40),
    ...promptAssets.flatMap((asset) => uniqStrings(asset.forbiddenSubstitutes, 12))
  ], 120)
  return {
    sceneId: asStr(scene.sceneId).trim(),
    sceneIndex: Number(scene.sceneIndex || 0),
    sceneName: asStr(scene.sceneName).trim(),
    workflow: asStr(scene.workflow).trim() || 'scene_prompt_only',
    summary: asStr(scene.summary).trim(),
    promptLocks,
    negativePrompt: negativeParts.join(', '),
    referenceAssets: referenceAssets.map((asset) => ({
      id: asStr(asset.id).trim(),
      name: asStr(asset.name).trim(),
      category: asStr(asset.category).trim(),
      lockProfile: asStr(asset.lockProfile).trim() || inferAssetLockProfile(asset),
      lockWorkflow: asStr(asset.lockWorkflow).trim() || lockWorkflowForAsset(asset),
      assetId: asStr(asset.primaryReferenceAssetId).trim(),
      assetUri: asStr(asset.primaryReferenceAssetUri).trim(),
      weight: asStr(asset.category).trim() === 'character' ? 0.9 : 0.8
    })),
    missingRequiredAssetIds: uniqStrings(scene.missingRequiredAssetIds, 60)
  }
}

export function defaultStoryAssetPlanFilename(projectId) {
  return `story_asset_plan_${slugify(projectId, 'project')}.json`
}
