// 故事资产文本/命名/存储路径助手（2026-10-20 index.js 拆分收尾迁出；函数体逐字未改）
import path from 'node:path'
import { normalizeLocalPath } from '../studio/storeFs.js'
import { collectComfyCapabilities, normalizeComfyLoraKey, normalizeComfyModelKey, normalizeComfyModelName, normalizeComfyuiBaseUrl, pickCheckpointDir, resolveSdWebuiModelsBase, scanModelFiles } from './comfyScan.js'

export const ANIMAL_ANCHOR_RE = /兔|rabbit|猪|pig|狼|wolf|猫|cat|狗|dog|猴|monkey|龟|turtle|熊|bear|狐|fox|羊|sheep|鸟|bird|鸭|duck|鸡|chick|鼠|mouse|鹿|deer|马|horse|兽|毛/i

export function hasAnimalSignals(text) {
  const s = String(text || '').trim().toLowerCase()
  if (!s) return false
  if (/[猫狗兔狐狼虎狮熊鹿马牛羊猴鸟鼠]/.test(s)) return true
  return [
    'kitten', 'cat', 'feline', 'puppy', 'dog', 'canine', 'rabbit', 'bunny',
    'fox', 'wolf', 'bear', 'tiger', 'lion', 'mouse', 'rat', 'deer',
    'animal', 'furry', 'fur', 'anthropomorphic'
  ].some((token) => s.includes(token))
}

export function hasHumanSignals(text) {
  const s = String(text || '').trim().toLowerCase()
  if (!s) return false
  if (/[人物男孩女孩女人男人小孩儿童少女少年]/.test(s)) return true
  return [
    'human', 'person', 'girl', 'boy', 'woman', 'man', 'lady', 'child',
    'kid', 'people', 'portrait'
  ].some((token) => s.includes(token))
}

export function chooseStoryboardAssetLoras({ asset, requestedLoras, stylePreset }) {
  const category = String(asset && asset.category || '').trim().toLowerCase()
  const lockProfile = String(asset && asset.lockProfile || '').trim().toLowerCase()
  const rawExplicit = Array.isArray(requestedLoras) ? requestedLoras.map((x) => String(x || '').trim()).filter(Boolean) : []
  const isProtectedProp = category === 'prop' && ['wearable_prop', 'slender_prop', 'rigid_prop', 'soft_prop', 'ambient_prop', 'organic_prop'].includes(lockProfile)
  const isSafePropReferenceLora = (entry) => {
    const name = String(entry || '').trim().toLowerCase()
    if (!name) return false
    // 2026-09-27 收窄黑名单：只保留会把 prop 拟人化/生物化的条目——furry/portrait/character/face/animal
    // 风格的 LoRA 会把道具拉向生物体（按原注释意图保留 furry）；child/children/storybook/picturebook/
    // book_illustration/genrih 是绘本风格 LoRA 的名称特征，正是保护类 prop 需要的风格，原黑名单把它们
    // 误杀了（settings 配置的 flat_childrenXX.safetensors 即中招，保护类 prop 抽卡零风格 LoRA 全灭）。
    if (/(furry|portrait|character|face|animal)/i.test(name)) return false
    // 白名单：扁平/绘本/插画/物件类风格 LoRA
    if (/(flat|cutout|storybook|picturebook|book.?illustration|children|game.?props?|object|asset)/i.test(name)) return true
    return false
  }
  const explicit = isProtectedProp ? rawExplicit.filter(isSafePropReferenceLora) : rawExplicit
  const byKey = new Map()
  const push = (entry) => {
    const raw = String(entry || '').trim()
    if (!raw) return
    const key = normalizeComfyLoraKey(raw.split(':')[0] || '')
    if (!key || byKey.has(key)) return
    byKey.set(key, raw)
  }

  for (const item of explicit) push(item)

  // 2026-09-28 默认 LoRA 栈沉淀进 settings 风格预设（loras.defaultStyle/characterAnimal），缺省用内置兜底
  const presetLoras = (stylePreset && stylePreset.loras && typeof stylePreset.loras === 'object') ? stylePreset.loras : {}
  const styleDefault = String(presetLoras.defaultStyle || '').trim() || 'Childrens_book_illustration_by_Genrih_Valk.safetensors:0.7'
  const furryDefault = String(presetLoras.characterAnimal || '').trim() || 'Anime_Furry_Style_SDXL.safetensors:0.7'
  // 2026-09-27：prop 无可用显式 LoRA 时与 character 一样补默认绘本风格 LoRA，不留空
  // （保护类 prop 零风格 LoRA 会产出写实照片风候选，小猫钓鱼鱼竿/浮漂 11+18 张全灭）
  if (!explicit.length) push(styleDefault)
  const signalText = [
    String(asset && asset.name || '').trim(),
    String(asset && asset.anchorPrompt || '').trim(),
    Array.isArray(asset && asset.aliases) ? asset.aliases.map((x) => String(x || '').trim()).join(' ') : ''
  ].join(' ')
  const isAnimalCharacter = category === 'character' && hasAnimalSignals(signalText)
  const isHumanCharacter = category === 'character' && !isAnimalCharacter && hasHumanSignals(signalText)

  if (isAnimalCharacter) push(furryDefault)
  if (isHumanCharacter && !explicit.length) push(styleDefault)

  return Array.from(byKey.values())
}

export function storyAssetCheckpointCandidates(asset) {
  const category = storyAssetStr(asset && asset.category).trim().toLowerCase()
  const lockProfile = storyAssetStr(asset && asset.lockProfile).trim().toLowerCase()
  const lockWorkflow = storyAssetStr(asset && asset.lockWorkflow).trim().toLowerCase()
  const signalText = [
    storyAssetStr(asset && asset.name),
    storyAssetStr(asset && asset.anchorPrompt),
    ...(Array.isArray(asset && asset.aliases) ? asset.aliases : [])
  ].join(' ').toLowerCase()

  const envCandidates = []
  const pushEnv = (name) => {
    const value = String(process.env[name] || '').trim()
    if (value) envCandidates.push(value)
  }
  pushEnv('STUDIO_ASSET_MODEL_DEFAULT')
  if (category === 'character') pushEnv('STUDIO_ASSET_MODEL_CHARACTER')
  if (category === 'location') pushEnv('STUDIO_ASSET_MODEL_LOCATION')
  if (lockProfile === 'wearable_prop') pushEnv('STUDIO_ASSET_MODEL_PROP_WEARABLE')
  if (lockProfile === 'slender_prop') pushEnv('STUDIO_ASSET_MODEL_PROP_SLENDER')
  if (lockProfile === 'rigid_prop') pushEnv('STUDIO_ASSET_MODEL_PROP_RIGID')
  if (lockProfile === 'soft_prop') pushEnv('STUDIO_ASSET_MODEL_PROP_SOFT')
  if (lockProfile === 'ambient_prop') pushEnv('STUDIO_ASSET_MODEL_PROP_AMBIENT')
  if (lockProfile === 'organic_prop') pushEnv('STUDIO_ASSET_MODEL_PROP_ORGANIC')
  if (category === 'prop') pushEnv('STUDIO_ASSET_MODEL_PROP_GENERIC')

  const byPriority = []
  const push = (...items) => byPriority.push(...items.filter(Boolean))
  push(...envCandidates)

  if (category === 'character' || category === 'location') {
    push('ivisionIllustration_ivision10.safetensors', 'ivisionIllustration', 'sd_xl_base_1.0.safetensors', 'sd_xl_base_1.0')
    return byPriority
  }
  if (lockProfile === 'wearable_prop' || lockProfile === 'soft_prop' || lockProfile === 'ambient_prop' || lockProfile === 'organic_prop') {
    push('ivisionIllustration_ivision10.safetensors', 'ivisionIllustration', 'sd_xl_base_1.0.safetensors', 'sd_xl_base_1.0')
    return byPriority
  }
  if (lockProfile === 'slender_prop') {
    // 2026-09-26：slender_prop 一律 ivision 优先——sd_xl_base 对绘本风细长道具稳定产出跑题图
    // （实测钓鱼线→女性铠甲角色线稿 score 2、鱼竿→多面板技术图解 score 14，AI 评审全灭）；
    // ivision 渲染的 organic/character 资产均通过评审。sd_xl_base 降为回退。
    push('ivisionIllustration_ivision10.safetensors', 'ivisionIllustration', 'sd_xl_base_1.0.safetensors', 'sd_xl_base_1.0')
    return byPriority
  }
  if (lockProfile === 'rigid_prop' || lockWorkflow === 'prop_product') {
    // 2026-09-26：rigid_prop 同样 ivision 优先——sd_xl_base 对绘本风道具稳定产出跑题/版图（与 slender_prop 同款失败）
    push('ivisionIllustration_ivision10.safetensors', 'ivisionIllustration', 'sd_xl_base_1.0.safetensors', 'sd_xl_base_1.0')
    return byPriority
  }
  if (category === 'prop') {
    push('ivisionIllustration_ivision10.safetensors', 'ivisionIllustration', 'sd_xl_base_1.0.safetensors', 'sd_xl_base_1.0')
    return byPriority
  }
  push('sd_xl_base_1.0.safetensors', 'sd_xl_base_1.0', 'ivisionIllustration_ivision10.safetensors', 'ivisionIllustration')
  return byPriority
}

export function pickBestStoryboardAssetModel(models, asset) {
  const list = Array.isArray(models) ? models.map((x) => String(x || '').trim()).filter(Boolean) : []
  if (!list.length) return ''
  const exactMap = new Map(list.map((item) => [normalizeComfyModelKey(item), item]))
  for (const candidate of storyAssetCheckpointCandidates(asset)) {
    const key = normalizeComfyModelKey(candidate)
    if (key && exactMap.has(key)) return exactMap.get(key) || ''
  }
  for (const candidate of storyAssetCheckpointCandidates(asset)) {
    const key = normalizeComfyModelKey(candidate)
    if (!key) continue
    const hit = list.find((item) => normalizeComfyModelKey(item).includes(key) || key.includes(normalizeComfyModelKey(item)))
    if (hit) return hit
  }
  return list[0] || ''
}

export async function resolveStoryboardAssetModel({ studio, imgProvider, requestedModel, asset }) {
  const explicit = normalizeComfyModelName(requestedModel)
  if (explicit || String(imgProvider || '').trim().toLowerCase() !== 'comfyui') {
    return {
      model: explicit || String(studio?.effective?.image?.model || '').trim(),
      source: explicit ? 'explicit' : 'studio_default',
      availableModels: []
    }
  }
  const configured = normalizeComfyModelName(studio?.effective?.image?.model)
  const modelsRoot = normalizeLocalPath(studio?.effective?.image?.comfyuiModelsRoot)
  let availableModels = []
  if (modelsRoot) {
    const base = await resolveSdWebuiModelsBase(modelsRoot)
    const ckptDir = await pickCheckpointDir(base)
    availableModels = ckptDir ? await scanModelFiles(ckptDir, { exts: ['.safetensors', '.ckpt'], maxDepth: 4 }) : []
  }
  if (!availableModels.length) {
    const baseUrl = normalizeComfyuiBaseUrl(studio?.effective?.image?.comfyuiBaseUrl)
    const cap = await collectComfyCapabilities(baseUrl, 12_000, []).catch(() => null)
    availableModels = Array.isArray(cap?.models) ? cap.models : []
  }
  const chosen = pickBestStoryboardAssetModel(availableModels, asset)
  if (chosen) {
    return { model: chosen, source: 'asset_profile_auto', availableModels }
  }
  return { model: configured, source: configured ? 'studio_default' : 'provider_fallback', availableModels }
}

export function storyAssetStr(v) {
  return typeof v === 'string' ? v : ''
}

export function hasCjkText(v) {
  return /[\u3400-\u9fff]/.test(storyAssetStr(v))
}

export function looksLikeEnglishPrompt(v) {
  const s = storyAssetStr(v).trim()
  if (!s) return false
  if (hasCjkText(s)) return false
  return /[A-Za-z]{3,}/.test(s)
}

export function pickEnglishPrompt(candidate, ...fallbacks) {
  const preferred = storyAssetStr(candidate).trim()
  if (looksLikeEnglishPrompt(preferred)) return preferred
  for (const fallback of fallbacks) {
    const alt = storyAssetStr(fallback).trim()
    if (looksLikeEnglishPrompt(alt)) return alt
  }
  return preferred || storyAssetStr(fallbacks.find(Boolean)).trim()
}

export function splitStoryAssetPromptParts(input) {
  return storyAssetStr(input)
    .split(/[,\n，、|]/g)
    .map((x) => x.trim())
    .filter(Boolean)
}

export function uniqStoryAssetPromptParts(parts, max = 120) {
  const out = []
  const seen = new Set()
  for (const part of parts) {
    const value = storyAssetStr(part).trim()
    if (!value) continue
    const key = value.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(value)
    if (out.length >= max) break
  }
  return out
}

export function sanitizeStoryAssetPromptZh({ asset, promptZh }) {
  const category = storyAssetStr(asset && asset.category).trim().toLowerCase()
  const lockProfile = storyAssetStr(asset && asset.lockProfile).trim().toLowerCase()
  const raw = storyAssetStr(promptZh).trim()
  if (!raw) return ''
  const isPropLike = category === 'prop' || lockProfile.endsWith('_prop')
  if (!isPropLike) return raw
  const parts = splitStoryAssetPromptParts(raw)
  const out = []
  let seenRole = false
  let seenStructure = false
  for (const part of parts) {
    let value = storyAssetStr(part).trim()
    if (!value) continue
    if (/^(关联场景|常与这些元素同场)\s*[:：]/.test(value)) continue
    // 2026-10-07 提示词卫生：语境线标签前缀（叙事识别重点：/结构关注点：/故事职责：）是输入侧元信息，
    // AI 抄进正文会随翻译进入生图模型——剥前缀留内容（公主穿衣三资产实测）
    const hadStructure = /^结构关注点\s*[:：]/.test(value)
    const hadRole = /^故事职责\s*[:：]/.test(value)
    value = value.replace(/^(叙事识别重点|结构关注点|故事职责)\s*[:：]\s*/, '')
    if (!value) continue
    if (hadRole) {
      if (seenRole) continue
      seenRole = true
    }
    if (hadStructure) {
      if (seenStructure) continue
      seenStructure = true
    }
    out.push(value)
  }
  return uniqStoryAssetPromptParts(out, 64).join('，')
}

export function limitStoryAssetText(v, max = 160) {
  const s = storyAssetStr(v).trim()
  if (!s) return ''
  return s.length <= max ? s : `${s.slice(0, Math.max(0, max - 1)).trim()}…`
}

export function findStoryAssetScenes(plan, asset) {
  const wantedIds = new Set((Array.isArray(asset && asset.sceneIds) ? asset.sceneIds : []).map((item) => storyAssetStr(item).trim()).filter(Boolean))
  const scenes = Array.isArray(plan && plan.scenes) ? plan.scenes : []
  if (!wantedIds.size) return []
  return scenes.filter((scene) => {
    const sceneId = storyAssetStr(scene && scene.sceneId).trim()
    const fallbackId = storyAssetStr(scene && scene.id).trim()
    const sourceKey = storyAssetStr(scene && scene.sourceKey).trim()
    return wantedIds.has(sceneId) || wantedIds.has(fallbackId) || wantedIds.has(sourceKey)
  })
}

export function storyAssetSignalHay(asset) {
  return [
    storyAssetStr(asset && asset.name),
    storyAssetStr(asset && asset.anchorPrompt),
    ...(Array.isArray(asset && asset.aliases) ? asset.aliases : [])
  ].join(' ').toLowerCase()
}

export function isStoryAssetBobberLike(asset) {
  return /\b(bobber|float|fishing float)\b|浮漂|漂子/.test(storyAssetSignalHay(asset))
}

export function isStoryAssetRodLike(asset) {
  // 2026-10-07：裸 "pole" 过宽（衣架 alias "hanger pole" 串台成鱼竿，公主穿衣实测）——只认钓鱼语境词
  return /\b(bamboo fishing rod|bamboo rod|fishing rod|fishing pole)\b|竹鱼竿|鱼竿|竹竿/.test(storyAssetSignalHay(asset))
}

export function isStoryAssetBucketLike(asset) {
  return /\b(bucket|pail)\b|鱼桶|木桶|水桶|桶/.test(storyAssetSignalHay(asset))
}

export function isStoryAssetFishLike(asset) {
  return /\b(minnow|fish|silver fish)\b|小银鱼|小鱼|银鱼|鱼/.test(storyAssetSignalHay(asset))
}

export function isStoryAssetButterflyLike(asset) {
  return /\b(butterfly|swallowtail)\b|蝴蝶|彩蝶/.test(storyAssetSignalHay(asset))
}

export function buildStoryAssetUsageContext({ asset, plan }) {
  const name = storyAssetStr(asset && asset.name).trim()
  const aliases = uniqStoryAssetPromptParts(Array.isArray(asset && asset.aliases) ? asset.aliases : [], 12)
  const sceneEntries = findStoryAssetScenes(plan, asset)
  const eventChain = Array.isArray(plan && plan.eventChain) ? plan.eventChain : []
  const sceneNames = uniqStoryAssetPromptParts(sceneEntries.map((scene) => storyAssetStr(scene && scene.sceneName).trim()).filter(Boolean), 8)
  const sceneSummaries = uniqStoryAssetPromptParts(sceneEntries.map((scene) => storyAssetStr(scene && scene.summary).trim()).filter(Boolean), 8)
  const eventMentions = uniqStoryAssetPromptParts(sceneEntries.map((scene) => {
    const index = Number(scene && scene.sceneIndex)
    if (!Number.isFinite(index) || index <= 0) return ''
    return storyAssetStr(eventChain[index - 1]).trim()
  }).filter(Boolean), 8)
  const coAssetNames = uniqStoryAssetPromptParts(sceneEntries.flatMap((scene) => {
    const promptAssets = Array.isArray(scene && scene.promptAssets) ? scene.promptAssets : []
    return promptAssets
      .map((item) => storyAssetStr(item && item.name).trim())
      .filter((item) => item && item !== name && !aliases.includes(item))
  }), 12)
  const contextBlobZh = `${sceneSummaries.join('；')}；${sceneNames.join('；')}`
  const contextBlobEn = eventMentions.join(' ; ').toLowerCase()
  const roleHints = []
  if (/(背着|背在|背负|携带|随身|肩带)/.test(contextBlobZh) || /\b(back-carry|carrying|carry|carried)\b/.test(contextBlobEn)) {
    roleHints.push('是角色外出时会随身背携的道具')
  }
  if (/(装鱼|放进桶|放入桶|盛鱼|盛放|收纳)/.test(contextBlobZh) || /\b(place[ds]? into the bucket|fish is placed into the bucket|hold[s]? fish|carry small fish)\b/.test(contextBlobEn)) {
    roleHints.push('承担盛放钓到的小鱼或收纳渔获的剧情职责')
  }
  if (/(湖边|柳树|草地|水面|钓鱼|钓竿|浮漂)/.test(contextBlobZh) || /\b(lakeside|shore|lake|willow|water|fishing|rod|bobber)\b/.test(contextBlobEn)) {
    roleHints.push('属于乡村湖边垂钓语境中的朴素儿童道具')
  }
  if (/(回家|出发|回来|路上)/.test(contextBlobZh) || /\b(arrives?|walks home|path home|returns?)\b/.test(contextBlobEn)) {
    roleHints.push('会跟随角色往返场景，适合做成轻便耐用的小型随行物件')
  }
  const plotCueHints = []
  const fullNarrativeZh = `${sceneSummaries.join('；')}；${eventMentions.join('；')}`
  const signalText = `${storyAssetStr(asset && asset.anchorPrompt)} ${storyAssetStr(asset && asset.name)} ${(Array.isArray(asset && asset.aliases) ? asset.aliases.join(' ') : '')}`.toLowerCase()
  if (/(盯着|观察|看着|等待|远远看|远看|一眼认出|watch|waiting|watching|visible from afar|recognize at a glance)/i.test(`${fullNarrativeZh} ${contextBlobEn}`)) {
    plotCueHints.push('在中远景里也要一眼认出主要色块和外轮廓')
  }
  if (/(摇晃|晃动|下沉|浮在水面|浮起来|watch the bobber|bobber|tremble|sinks?|upright on calm water)/i.test(`${fullNarrativeZh} ${signalText} ${contextBlobEn}`)) {
    plotCueHints.push('要清楚表现直立浮姿、上下配色分区和远看可辨的顶端标记')
  }
  if (/(提着|背着|挂着|拿着|带着|系在|shoulder|carry|carried|hang|hung|held|tied to)/i.test(`${fullNarrativeZh} ${signalText} ${contextBlobEn}`)) {
    plotCueHints.push('连接点、提握点、挂点或绑缚点要清楚')
  }
  if (/(装进|放入|收纳|盛放|开口|容量|placed into|put into|holds?|contain|storage)/i.test(`${fullNarrativeZh} ${signalText} ${contextBlobEn}`)) {
    plotCueHints.push('开口、内部容积或收纳方式要明确')
  }
  if (/(戴着|戴上|佩戴|wearing|worn)/i.test(`${fullNarrativeZh} ${signalText} ${contextBlobEn}`)) {
    plotCueHints.push('虽然会被佩戴使用，但锁定图必须保留独立物件的开口和内侧结构')
  }
  const structureHints = []
  if (/(肩带|strap)/i.test(`${storyAssetStr(asset && asset.anchorPrompt)} ${contextBlobZh} ${contextBlobEn}`)) structureHints.push('肩带连接方式要清楚')
  if (/(提梁|提手|bail|handle)/i.test(`${storyAssetStr(asset && asset.anchorPrompt)} ${contextBlobZh} ${contextBlobEn}`)) structureHints.push('提梁和挂点结构要可读')
  if (/(开口|装鱼|盛放|bucket|pail|桶)/i.test(`${storyAssetStr(asset && asset.anchorPrompt)} ${contextBlobZh} ${contextBlobEn}`)) structureHints.push('开口、桶沿和内部容量感要明确')
  if (/(木|wood|woven|staves|iron band|金属箍|箍)/i.test(`${storyAssetStr(asset && asset.anchorPrompt)} ${contextBlobZh} ${contextBlobEn}`)) structureHints.push('材质分区和连接关系要稳定')

  if (isStoryAssetBucketLike(asset)) {
    roleHints.length = 0
    plotCueHints.length = 0
    structureHints.length = 0
    roleHints.push('是角色外出时会随身背携的小鱼桶')
    roleHints.push('承担盛放钓到的小鱼或临时收纳渔获的剧情职责')
    roleHints.push('属于乡村湖边垂钓语境中的朴素儿童道具')
    plotCueHints.push('在中远景里也要一眼认出桶身轮廓、提梁和肩带连接点')
    plotCueHints.push('要清楚表现开口、桶沿和内部容量感，避免被画成封闭盒子或普通花盆')
    structureHints.push('肩带连接方式要清楚')
    structureHints.push('提梁和挂点结构要可读')
    structureHints.push('开口、桶沿和内部容量感要明确')
    structureHints.push('材质分区和连接关系要稳定')
  } else if (isStoryAssetRodLike(asset)) {
    roleHints.length = 0
    plotCueHints.length = 0
    structureHints.length = 0
    roleHints.push('是角色在湖边垂钓时使用的单根竹制鱼竿')
    roleHints.push('承担抛线、等待、提竿和收鱼这些关键动作的剧情职责')
    roleHints.push('属于乡村湖边垂钓语境中的朴素儿童渔具')
    plotCueHints.push('在中远景里也要一眼认出细长竹竿轮廓和竹节分段')
    plotCueHints.push('要清楚表现无渔轮单竿、竿梢绑线点、末端细线与小钩')
    structureHints.push('竹节分段和由粗到细的渐细关系要清楚')
    structureHints.push('竿梢绑线点、细线和小钩结构要明确')
    structureHints.push('必须保持完整全长，不能裁切两端，不能透视缩短')
  } else if (isStoryAssetBobberLike(asset)) {
    roleHints.length = 0
    plotCueHints.length = 0
    structureHints.length = 0
    roleHints.push('是钓线末端用来观察鱼讯的小型浮漂')
    roleHints.push('承担轻微晃动、直立漂浮和突然下沉这些关键剧情提示职责')
    roleHints.push('属于乡村湖边垂钓语境中的朴素儿童渔具')
    plotCueHints.push('在中远景里也要一眼认出红白配色、葫芦形轮廓和顶部标记')
    plotCueHints.push('要清楚表现直立浮姿、细黑中心针和上下两个小环')
    structureHints.push('红上白下的配色分区要明确')
    structureHints.push('葫芦形软木本体、细黑中心针和上下小环都要完整可读')
    structureHints.push('必须是独立单个浮漂，不连水面、不连人物、不连整根鱼线场景')
  } else if (isStoryAssetFishLike(asset)) {
    roleHints.length = 0
    plotCueHints.length = 0
    structureHints.length = 0
    roleHints.push('是故事里最终钓上来的小型银色小鱼')
    roleHints.push('承担“提竿成功、收获成果、放进鱼桶”这些关键剧情结果展示职责')
    roleHints.push('属于乡村湖边垂钓语境中的朴素自然小鱼，不是观赏鱼或大型鱼类')
    plotCueHints.push('在中近景里要一眼认出银色细长鱼身、叉形尾和小黑眼')
    plotCueHints.push('要清楚表现纺锤形身体轮廓、反光鳞片和简洁小鳍，不要夸张卡通表情')
    structureHints.push('细长纺锤形身体、叉形尾和小黑珠眼要完整可读')
    structureHints.push('背鳍、胸鳍和腹部轮廓要简洁明确')
    structureHints.push('必须是单条独立小鱼，不连钓钩、桶、手、角色或水面环境')
  } else if (isStoryAssetButterflyLike(asset)) {
    roleHints.length = 0
    plotCueHints.length = 0
    structureHints.length = 0
    roleHints.push('是故事里吸引角色分心、飞向野花丛的彩色蝴蝶')
    roleHints.push('承担“短暂停落、绕飞、引向花丛”这些关键剧情触发职责')
    roleHints.push('属于乡村湖边春日环境中的轻盈自然昆虫，不是飞蛾、蜻蜓或小鸟')
    plotCueHints.push('在中近景里要一眼认出鲜艳多彩双翅、黑色翅脉和细长触角')
    plotCueHints.push('要清楚表现停落或展翅时的蝴蝶轮廓，不要被画成鱼、叶子或标本针插展示')
    structureHints.push('左右双翅外轮廓、翅脉分区和尾突形态要明确')
    structureHints.push('细长身体、成对触角和翅膀配色层次要完整可读')
    structureHints.push('必须是单只独立蝴蝶，不连花枝、不连人物、不连场景底座')
  }

  const roleLineZh = roleHints.length ? limitStoryAssetText(`故事职责：${roleHints.join('；')}`, 220) : ''
  const sceneLineZh = sceneNames.length ? limitStoryAssetText(`关联场景：${sceneNames.join('、')}`, 120) : ''
  const coAssetLineZh = coAssetNames.length ? limitStoryAssetText(`常与这些元素同场：${coAssetNames.join('、')}，但它们只用于校准身份，不要画进单资产参考图`, 180) : ''
  const structureLineZh = structureHints.length ? limitStoryAssetText(`结构关注点：${structureHints.join('；')}`, 160) : ''
  const plotCueLineZh = plotCueHints.length ? limitStoryAssetText(`叙事识别重点：${plotCueHints.join('；')}`, 180) : ''

  return {
    sceneNames,
    sceneSummaries,
    eventMentions,
    coAssetNames,
    roleHints,
    plotCueHints,
    structureHints,
    roleLineZh,
    plotCueLineZh,
    sceneLineZh,
    coAssetLineZh,
    structureLineZh
  }
}

export function sanitizeProtectedAssetPrompt({ asset, promptEn, negativePrompt }) {
  const lockProfile = storyAssetStr(asset && asset.lockProfile).trim().toLowerCase()
  const lockWorkflow = storyAssetStr(asset && asset.lockWorkflow).trim().toLowerCase()
  const protectedProfiles = new Set(['wearable_prop', 'slender_prop', 'rigid_prop', 'soft_prop', 'ambient_prop', 'organic_prop'])
  const rawPositive = storyAssetStr(promptEn).trim()
  const rawNegative = storyAssetStr(negativePrompt).trim()
  if (!protectedProfiles.has(lockProfile)) {
    return { promptEn: rawPositive, negativePrompt: rawNegative }
  }
  const bannedPositive = [
    /\bchildren'?s?\b/i, /\bchild\b/i, /\bgirl\b/i, /\bboy\b/i, /\bkid\b/i, /\bwoman\b/i, /\bman\b/i,
    /\bportrait\b/i, /\bupper body\b/i, /\bhalf[-\s]?length\b/i, /\bface\b/i, /\bhead\b/i, /\bmodel\b/i,
    /\bwearing\b/i, /\bworn\b/i, /\bon (?:a|the) head\b/i, /\bunder chin\b/i, /\boutfit\b/i, /\bdress\b/i,
    /\bshirt\b/i, /\bskirt\b/i, /\bbook illustration style\b/i, /\bstorybook\b/i, /\bfashion editorial\b/i
  ]
  const positiveParts = splitStoryAssetPromptParts(rawPositive).filter((part) => !bannedPositive.some((re) => re.test(part)))
  const safePositive = uniqStoryAssetPromptParts(positiveParts, 80).join(', ')
  const extraNegative = lockProfile === 'wearable_prop'
    ? ['person', 'girl', 'boy', 'child', 'portrait', 'head', 'face', 'upper body', 'model', 'wearing display', 'worn on head', 'mannequin', 'hair', 'scalp', 'ears']
    : ['person', 'portrait', 'character', 'environment']
  if (lockWorkflow === 'prop_hat') {
    extraNegative.push('woman', 'female body', 'shoulders', 'collarbone', 'neckline', 'bust', 'statue', 'sculpture', 'figurine', 'pedestal', 'display base')
  }
  return {
    promptEn: safePositive,
    negativePrompt: uniqStoryAssetPromptParts([...splitStoryAssetPromptParts(rawNegative), ...extraNegative], 120).join(', ')
  }
}

export function normalizeStoryAssetUri(raw) {
  return storyAssetStr(raw).trim().replace(/\\/g, '/').replace(/^\/+/, '')
}

export function storyAssetCategoryFolder(category) {
  const value = storyAssetStr(category).trim().toLowerCase()
  if (value === 'character' || value === 'prop' || value === 'location') return value
  return 'asset'
}

export function storyAssetSlug(asset) {
  const raw = storyAssetStr(asset && asset.id).trim() || storyAssetStr(asset && asset.name).trim() || 'asset'
  return raw
    .replace(/[^a-zA-Z0-9_.-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 80) || 'asset'
}

export function getStoryAssetTimeZone() {
  return storyAssetStr(process.env.STUDIO_ASSET_TIMEZONE).trim() || 'Asia/Shanghai'
}

export function getDatePartsForStoryAssets(date = new Date()) {
  try {
    const fmt = new Intl.DateTimeFormat('en-CA', {
      timeZone: getStoryAssetTimeZone(),
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false
    })
    const parts = Object.fromEntries(fmt.formatToParts(date).map((part) => [part.type, part.value]))
    return {
      year: storyAssetStr(parts.year).trim() || String(date.getFullYear()),
      month: storyAssetStr(parts.month).trim() || String(date.getMonth() + 1).padStart(2, '0'),
      day: storyAssetStr(parts.day).trim() || String(date.getDate()).padStart(2, '0'),
      hour: storyAssetStr(parts.hour).trim() || String(date.getHours()).padStart(2, '0'),
      minute: storyAssetStr(parts.minute).trim() || String(date.getMinutes()).padStart(2, '0'),
      second: storyAssetStr(parts.second).trim() || String(date.getSeconds()).padStart(2, '0')
    }
  } catch (_) {
    const iso = new Date(date.getTime() - (date.getTimezoneOffset() * 60_000)).toISOString()
    return {
      year: iso.slice(0, 4),
      month: iso.slice(5, 7),
      day: iso.slice(8, 10),
      hour: iso.slice(11, 13),
      minute: iso.slice(14, 16),
      second: iso.slice(17, 19)
    }
  }
}

export function getStoryAssetDateFolder(date = new Date()) {
  const parts = getDatePartsForStoryAssets(date)
  return `${parts.year}-${parts.month}-${parts.day}`
}

export function getStoryAssetTimestampToken(date = new Date()) {
  const parts = getDatePartsForStoryAssets(date)
  return `${parts.year}${parts.month}${parts.day}_${parts.hour}${parts.minute}${parts.second}`
}

export function buildStoryAssetStorageInfo(asset, date = new Date()) {
  const category = storyAssetCategoryFolder(asset && asset.category)
  const slug = storyAssetSlug(asset)
  const dateFolder = getStoryAssetDateFolder(date)
  const relDir = path.join('assets', 'ai', 'story_assets', category, slug, dateFolder)
  return { category, slug, dateFolder, relDir }
}

export function buildStoryAssetFileTarget({ dir, asset, prefix, ext, seed, date = new Date() }) {
  const storage = buildStoryAssetStorageInfo(asset, date)
  const safeExt = storyAssetStr(ext).replace(/[^a-z0-9]+/gi, '') || 'png'
  const stamp = getStoryAssetTimestampToken(date)
  const safePrefix = storyAssetStr(prefix).trim().replace(/[^a-z0-9_.-]+/gi, '_') || 'asset'
  const seedPart = Number.isFinite(Number(seed)) ? `_seed_${Math.max(0, Math.floor(Number(seed)))}` : ''
  const filename = `${safePrefix}${seedPart}_${stamp}.${safeExt}`
  return {
    ...storage,
    filename,
    outDir: path.join(dir, storage.relDir),
    absPath: path.join(dir, storage.relDir, filename),
    assetPath: `${storage.relDir}/${filename}`.replace(/\\/g, '/')
  }
}

export function buildStoryAssetComfyPrefix(asset, variant, date = new Date()) {
  const storage = buildStoryAssetStorageInfo(asset, date)
  const safeVariant = storyAssetStr(variant).trim().replace(/[^a-z0-9_.-]+/gi, '_') || 'asset'
  return path.posix.join('talkscene_story_lock', storage.dateFolder, storage.category, storage.slug, safeVariant)
}

export function getManagedStoryAssetPrefixes(asset) {
  const category = storyAssetCategoryFolder(asset && asset.category)
  const slug = storyAssetSlug(asset)
  return {
    current: `assets/ai/story_assets/${category}/${slug}/`,
    legacyRefs: `assets/ai/story_assets/${slug}_`,
    legacyLineart: `assets/ai/story_lineart/${slug}_`,
    legacyLineartDir: `assets/ai/story_lineart/${category}/${slug}/`
  }
}

export function isManagedStoryAssetPathForAsset(asset, rawPath) {
  const uri = normalizeStoryAssetUri(rawPath)
  if (!uri) return false
  const prefixes = getManagedStoryAssetPrefixes(asset)
  if (
    uri.startsWith(prefixes.current) ||
    uri.startsWith(prefixes.legacyRefs) ||
    uri.startsWith(prefixes.legacyLineart) ||
    uri.startsWith(prefixes.legacyLineartDir)
  ) return true
  // 2026-09-16 姿势/状态变体图（assets/ai/characters 共享目录）按变体记录归属纳入图库管理
  for (const v of (Array.isArray(asset && asset.poseVariants) ? asset.poseVariants : [])) {
    if (uri === normalizeStoryAssetUri(v && v.cutoutPath) || uri === normalizeStoryAssetUri(v && v.greenPath)) return true
  }
  for (const v of (Array.isArray(asset && asset.stateVariants) ? asset.stateVariants : [])) {
    if (uri === normalizeStoryAssetUri(v && v.cutoutPath) || uri === normalizeStoryAssetUri(v && v.greenPath)) return true
  }
  return false
}

export function containsStoryAssetMeaning(promptZh, ruleLineZh) {
  const promptParts = splitStoryAssetPromptParts(promptZh)
  const ruleParts = splitStoryAssetPromptParts(ruleLineZh.replace(/^[^:：]+[:：]\s*/, ''))
  if (!promptParts.length || !ruleParts.length) return false
  const promptText = promptParts.join('，')
  return ruleParts.some((part) => {
    const needle = storyAssetStr(part).trim()
    return needle && (promptText.includes(needle) || promptText.includes(needle.replace(/[；。]/g, '')))
  })
}
