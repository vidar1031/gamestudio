// 故事资产画廊条目与提示词增强/评分/翻译（2026-10-20 index.js 拆分收尾迁出；函数体逐字未改）
import path from 'node:path'
import { readdir, rm } from 'node:fs/promises'
import { translatePromptText } from './translate.js'
import { buildStoryAssetReferenceNegativePrompt, buildStoryAssetReferencePrompt, summarizeStoryAssetPlan } from './storyAssets.js'
import { normalizeProjectDoc } from '../studio/projectState.js'
import { existsFile, readProjectBundle, writeJson } from '../studio/storeFs.js'
import { ANIMAL_ANCHOR_RE, buildStoryAssetUsageContext, containsStoryAssetMeaning, isManagedStoryAssetPathForAsset, isStoryAssetButterflyLike, isStoryAssetRodLike, normalizeStoryAssetUri, pickEnglishPrompt, sanitizeStoryAssetPromptZh, splitStoryAssetPromptParts, storyAssetStr, uniqStoryAssetPromptParts } from './storyAssetText.js'
import { saveStoryAssetPlan } from './storyAssetPlanStore.js'

export function labelForStoryAssetGalleryKind(kind) {
  if (kind === 'reference') return '参考图'
  if (kind === 'selected_white_bg') return '主参考立绘'
  if (kind === 'lineart_hint') return '线稿 Hint'
  if (kind === 'lineart_final') return '线稿成品'
  if (kind === 'pose_variant') return '姿势立绘'
  if (kind === 'pose_variant_green') return '姿势绿幕'
  if (kind === 'state_variant') return '状态立绘'
  if (kind === 'state_variant_green') return '状态绿幕'
  return '图片'
}

export function inferStoryAssetGalleryKind({ uri, ref, asset }) {
  const normalized = normalizeStoryAssetUri(uri)
  if (!normalized) return 'unknown'
  if (normalized === normalizeStoryAssetUri(asset && asset.lineartHintAssetUri)) return 'lineart_hint'
  if (normalized === normalizeStoryAssetUri(asset && asset.lineartFinalAssetUri)) return 'lineart_final'
  // 2026-09-16 姿势/状态变体：以变体记录的 green/cutout 判定（先于 postprocess/文件名启发式）
  for (const v of (Array.isArray(asset && asset.poseVariants) ? asset.poseVariants : [])) {
    if (normalized === normalizeStoryAssetUri(v && v.cutoutPath)) return 'pose_variant'
    if (normalized === normalizeStoryAssetUri(v && v.greenPath)) return 'pose_variant_green'
  }
  for (const v of (Array.isArray(asset && asset.stateVariants) ? asset.stateVariants : [])) {
    if (normalized === normalizeStoryAssetUri(v && v.cutoutPath)) return 'state_variant'
    if (normalized === normalizeStoryAssetUri(v && v.greenPath)) return 'state_variant_green'
  }
  // 选定主参考（抠图立绘）：历史白底 rmbg_white_bg 与现行透明 rmbg_alpha 共用同一 gallery 类别
  const refPostprocess = storyAssetStr(ref && ref.postprocess).trim()
  if (refPostprocess === 'rmbg_white_bg' || refPostprocess === 'rmbg_alpha') return 'selected_white_bg'
  const base = path.basename(normalized).toLowerCase()
  if (base.includes('selected_white') || base.includes('selected_cutout')) return 'selected_white_bg'
  if (base.includes('lineart_hint') || base.includes('_hint_')) return 'lineart_hint'
  if (base.includes('lineart_final') || base.includes('_lineart_') || base.includes('_final_')) return 'lineart_final'
  return 'reference'
}

export function storyAssetCreatedAtFallback(uri) {
  const normalized = normalizeStoryAssetUri(uri)
  const match = normalized.match(/(20\d{2})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})/)
  if (!match) return ''
  return `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}+08:00`
}

export function buildStoryAssetGalleryEntries({ projectId, project, plan, asset }) {
  const projectAssets = Array.isArray(project && project.assets) ? project.assets : []
  const projectAssetByUri = new Map()
  for (const item of projectAssets) {
    const uri = normalizeStoryAssetUri(item && item.uri)
    if (uri) projectAssetByUri.set(uri, item)
  }
  const generatedRefs = Array.isArray(asset && asset.generatedRefs) ? asset.generatedRefs : []
  const latestBatch = Array.isArray(asset && asset.latestReferenceBatch) ? asset.latestReferenceBatch : []
  const refByUri = new Map()
  for (const ref of generatedRefs) {
    const uri = normalizeStoryAssetUri(ref && ref.projectAssetUri)
    if (uri) refByUri.set(uri, ref)
  }
  const batchByUri = new Map()
  for (const item of latestBatch) {
    const uri = normalizeStoryAssetUri(item && item.assetPath)
    if (uri) batchByUri.set(uri, item)
  }
  const seen = new Set()
  const rows = []
  const candidateUris = new Set()
  for (const ref of generatedRefs) {
    const uri = normalizeStoryAssetUri(ref && ref.projectAssetUri)
    if (uri) candidateUris.add(uri)
  }
  for (const item of latestBatch) {
    const uri = normalizeStoryAssetUri(item && item.assetPath)
    if (uri) candidateUris.add(uri)
  }
  for (const projectAsset of projectAssets) {
    const uri = normalizeStoryAssetUri(projectAsset && projectAsset.uri)
    if (uri && isManagedStoryAssetPathForAsset(asset, uri)) candidateUris.add(uri)
  }
  const specialUris = [
    normalizeStoryAssetUri(asset && asset.primaryReferenceAssetUri),
    normalizeStoryAssetUri(asset && asset.lineartHintAssetUri),
    normalizeStoryAssetUri(asset && asset.lineartFinalAssetUri)
  ].filter(Boolean)
  for (const uri of specialUris) candidateUris.add(uri)
  // 2026-09-16 姿势/状态变体图纳入图库（绿幕+立绘），按变体记录补充元数据
  const variantByUri = new Map()
  for (const v of (Array.isArray(asset && asset.poseVariants) ? asset.poseVariants : [])) {
    for (const [field, kind] of [['greenPath', 'green'], ['cutoutPath', 'cutout']]) {
      const uri = normalizeStoryAssetUri(v && v[field])
      if (uri) {
        candidateUris.add(uri)
        variantByUri.set(uri, { variantId: v.id, variantName: v.name, score: v.score, composite: v.composite, part: kind })
      }
    }
  }
  for (const v of (Array.isArray(asset && asset.stateVariants) ? asset.stateVariants : [])) {
    for (const [field, kind] of [['greenPath', 'green'], ['cutoutPath', 'cutout']]) {
      const uri = normalizeStoryAssetUri(v && v[field])
      if (uri) {
        candidateUris.add(uri)
        variantByUri.set(uri, { variantId: v.id, variantName: v.name, score: v.score, composite: v.composite, part: kind })
      }
    }
  }

  for (const uri of candidateUris) {
    if (!uri || !isManagedStoryAssetPathForAsset(asset, uri) || seen.has(uri)) continue
    seen.add(uri)
    const ref = refByUri.get(uri) || null
    const batch = batchByUri.get(uri) || null
    const projectAsset = projectAssetByUri.get(uri) || null
    const variantMeta = variantByUri.get(uri) || null
    const kind = inferStoryAssetGalleryKind({ uri, ref, asset })
    const analysis = batch && batch.analysis && typeof batch.analysis === 'object'
      ? batch.analysis
      : (normalizeStoryAssetUri(asset && asset.primaryReferenceAssetUri) === uri && asset && asset.latestReferenceReview && typeof asset.latestReferenceReview === 'object'
        ? asset.latestReferenceReview
        : null)
    const createdAt = storyAssetStr(ref && ref.createdAt).trim() || storyAssetCreatedAtFallback(uri)
    const refSeedValue = ref && typeof ref === 'object' ? ref.seed : undefined
    const projectAssetSource = projectAsset && projectAsset.source && typeof projectAsset.source === 'object'
      ? projectAsset.source
      : null
    const projectAssetSeedValue = projectAssetSource ? projectAssetSource.seed : undefined
    rows.push({
      assetPath: uri,
      url: `/project-assets/${encodeURIComponent(String(projectId || ''))}/${uri}`,
      kind,
      label: labelForStoryAssetGalleryKind(kind),
      createdAt: createdAt || undefined,
      seed: Number.isFinite(Number(refSeedValue)) ? Number(refSeedValue) : (Number.isFinite(Number(projectAssetSeedValue)) ? Number(projectAssetSeedValue) : undefined),
      provider: storyAssetStr(ref && ref.provider).trim() || storyAssetStr(projectAssetSource && projectAssetSource.provider).trim() || undefined,
      prompt: storyAssetStr(ref && ref.prompt).trim() || storyAssetStr(projectAssetSource && projectAssetSource.prompt).trim() || undefined,
      negativePrompt: storyAssetStr(ref && ref.negativePrompt).trim() || storyAssetStr(projectAssetSource && projectAssetSource.negativePrompt).trim() || undefined,
      isPrimary: normalizeStoryAssetUri(asset && asset.primaryReferenceAssetUri) === uri,
      isCurrentLineart: (
        normalizeStoryAssetUri(asset && asset.lineartHintAssetUri) === uri ||
        normalizeStoryAssetUri(asset && asset.lineartFinalAssetUri) === uri
      ),
      recommended: Boolean(
        normalizeStoryAssetUri(asset && asset.latestRecommendedReferenceAssetUri) === uri ||
        (batch && batch.recommended)
      ),
      inLatestBatch: batchByUri.has(uri),
      ...(variantMeta ? {
        variantId: variantMeta.variantId,
        variantName: variantMeta.variantName,
        variantScore: Number.isFinite(Number(variantMeta.score)) ? Number(variantMeta.score) : undefined,
        variantComposite: variantMeta.composite || undefined,
        variantPart: variantMeta.part
      } : {}),
      analysis
    })
  }
  rows.sort((a, b) => {
    const priorityA = a.isPrimary ? 30 : (a.isCurrentLineart ? 20 : 0)
    const priorityB = b.isPrimary ? 30 : (b.isCurrentLineart ? 20 : 0)
    if (priorityA !== priorityB) return priorityB - priorityA
    const timeA = Date.parse(String(a.createdAt || ''))
    const timeB = Date.parse(String(b.createdAt || ''))
    if (Number.isFinite(timeA) && Number.isFinite(timeB) && timeA !== timeB) return timeB - timeA
    return String(a.assetPath || '').localeCompare(String(b.assetPath || ''))
  })
  return rows
}

export async function pruneMissingStoryAssetGalleryEntries({ id, dir, plan, asset }) {
  let currentPlan = plan
  let currentAsset = asset
  let currentProject = null
  let items = []

  while (true) {
    const bundle = await readProjectBundle(id)
    currentProject = normalizeProjectDoc(bundle.rawProject)
    items = buildStoryAssetGalleryEntries({ projectId: id, project: currentProject, plan: currentPlan, asset: currentAsset })
    const missing = []
    for (const item of items) {
      const uri = normalizeStoryAssetUri(item && item.assetPath)
      if (!uri) continue
      const abs = path.join(dir, uri)
      if (!(await existsFile(abs))) missing.push(uri)
    }
    if (!missing.length) break
    for (const missingUri of missing) {
      const liveAsset = (Array.isArray(currentPlan && currentPlan.assets)
        ? currentPlan.assets.find((entry) => storyAssetStr(entry && entry.id).trim() === storyAssetStr(currentAsset && currentAsset.id).trim())
        : null) || currentAsset
      const cleaned = await deleteStoryAssetManagedFile({
        id,
        dir,
        plan: currentPlan,
        asset: liveAsset,
        targetAssetPath: missingUri
      })
      currentPlan = cleaned.plan
      currentAsset = cleaned.asset
    }
  }

  return {
    plan: currentPlan,
    asset: currentAsset,
    project: currentProject,
    items
  }
}

export function buildStoryAssetPromptEnhancement({ asset, plan, globalPromptZh, globalNegativePromptZh, currentPromptZh, currentPromptEn, currentNegativePromptZh, currentNegativePrompt }) {
  const category = storyAssetStr(asset && asset.category).trim()
  const lockProfile = storyAssetStr(asset && asset.lockProfile).trim()
  const name = storyAssetStr(asset && asset.name).trim() || '当前资产'
  const anchor = storyAssetStr(asset && asset.anchorPrompt).trim()
  const hint = storyAssetStr(asset && asset.referencePromptHint).trim()
  const zhBase = sanitizeStoryAssetPromptZh({ asset, promptZh: currentPromptZh })
  const enBase = storyAssetStr(currentPromptEn).trim()
  const zhNegBase = storyAssetStr(currentNegativePromptZh).trim()
  const enNegBase = storyAssetStr(currentNegativePrompt).trim()
  const worldAnchor = storyAssetStr(plan && plan.worldAnchor).trim()
  const globalZh = storyAssetStr(globalPromptZh).trim()
  const globalNegZh = storyAssetStr(globalNegativePromptZh).trim()
  const usageContext = buildStoryAssetUsageContext({ asset, plan })
  const usageLines = [
    usageContext.roleLineZh,
    usageContext.plotCueLineZh,
    usageContext.structureLineZh
  ].filter(Boolean)
  const propExclusionNames = usageContext.coAssetNames.slice(0, 8)

  let promptZh = ''
  if (zhBase && category === 'prop') {
    promptZh = uniqStoryAssetPromptParts([
      ...splitStoryAssetPromptParts(zhBase),
      ...usageLines,
      '仅画物件本身',
      '纯白背景',
      '不把共现角色或地点画进去'
    ], 32).join('，')
  } else if (zhBase) {
    promptZh = zhBase
  }
  if (!promptZh) {
    if (lockProfile === 'character_core' || category === 'character') {
      promptZh = [
        `${name}角色参考表，单主体，全身，正面站姿，居中构图`,
        // 2026-10-12 灰姑娘事故：模板丢失身份锚点（anchor 读了没用）→ checkpoint 默认兔耳娘占位图；
        // 身份锚点必须进模板。且"耳朵/毛色花纹"仅对动物角色有意义——人类角色按发型发色写。
        anchor ? `角色身份特征：${anchor}` : '',
        ANIMAL_ANCHOR_RE.test(anchor)
          ? '重点锁定脸型、耳朵、眼睛颜色、毛色花纹、服装版型、腰带、鞋子和整体比例'
          : '重点锁定脸型、发型发色、眼睛颜色、服装版型、腰带、鞋子和整体比例',
        '纯白无缝背景，无地面线，无投影，无场景环境',
        '双手自然下垂且空手，不拿任何道具，不戴帽子',
        '卡通童话绘本风格，扁平 2D 卡通插画，粗净轮廓线，赛璐璐上色，配色温暖柔和，不能画成真人小孩或拟人猫娘，不能写实'
      ].filter(Boolean).join('，')
    } else if (lockProfile === 'wearable_prop') {
      promptZh = [
        `${name}道具设计图，单一物件，居中展示，仅画物件本身`,
        usageLines.join('，'),
        '纯白背景，无手持，无人物，无头部，无模特，无佩戴展示，无场景，无头模',
        '清楚表现材质、结构、尺寸比例、开口、边缘轮廓和独立摆放关系',
        '强调这是可穿戴但未佩戴的独立物件，必要时开口或内部结构可见',
        '卡通童话绘本风格设计参考插画，扁平 2D 卡通，粗净轮廓线，便于后续连续场景复用'
      ].filter(Boolean).join('，')
    } else if (lockProfile === 'slender_prop') {
      promptZh = [
        `${name}细长道具锁定图，单一物件，完整显示全长，居中展示`,
        usageLines.join('，'),
        '纯白背景，无人物，无手持，无场景，不允许两端裁切，不允许透视缩短',
        '清楚表现长度比例、端头结构、孔位或节点细节，轮廓笔直可读',
        '卡通童话绘本风格设计参考图，扁平 2D 卡通，粗净轮廓线，便于后续连续场景复用'
      ].filter(Boolean).join('，')
    } else if (lockProfile === 'rigid_prop') {
      promptZh = [
        `${name}硬结构道具参考图，单一物件，稳定透视，居中展示，仅画物件本身`,
        usageLines.join('，'),
        '纯白背景，无人物，无场景，无额外杂物，不把共现角色或地点画进去',
        '清楚表现主要结构部件、体块关系、材质和比例，不能塌陷变形',
        '卡通童话绘本风格设计参考插画，扁平 2D 卡通，粗净轮廓线，便于后续连续场景复用'
      ].filter(Boolean).join('，')
    } else if (lockProfile === 'ambient_prop') {
      promptZh = [
        `${name}氛围元素参考图，单一元素，居中展示`,
        usageContext.sceneLineZh,
        '干净浅色背景，不要整张大场景，不要地平线，不要树木建筑人物',
        '清楚表现该元素自身轮廓、体积和内部层次，便于在不同场景中稳定复用',
        '卡通童话绘本风格参考插画，扁平 2D 卡通，粗净轮廓线，便于后续连续场景复用'
      ].filter(Boolean).join('，')
    } else if (lockProfile === 'organic_prop') {
      if (isStoryAssetButterflyLike(asset)) {
        promptZh = [
          `${name}昆虫参考图，单一物件，居中展示，仅画物件本身`,
          usageLines.join('，'),
          '纯白背景，无人物，无手持，无场景，无花枝，无草地，无栖息地，不把共现角色或地点画进去',
          '清楚表现左右双翅轮廓、翅脉、尾突、细长身体、成对触角和配色分区',
          '必须是单只独立蝴蝶，不要飞蛾，不要蜻蜓，不要小鸟，不要昆虫标本针插展示',
          '卡通童话绘本风格设计参考图，扁平 2D 卡通，粗净轮廓线，便于后续连续场景复用'
        ].filter(Boolean).join('，')
      } else {
        promptZh = [
          `${name}自然标本道具锁定图，单一物件，居中展示，仅画物件本身`,
          usageLines.join('，'),
          '纯白背景，无人物，无手持，无场景，无水面，无栖息地，不把共现角色或地点画进去',
          '清楚表现整体轮廓、头尾比例、眼睛、鳍、表面纹理和尺寸关系',
          '必须是单个自然标本或单个小鱼，不要夸张表情，不要观赏鱼摆拍，不要生态展示缸',
          '卡通童话绘本风格设计参考图，扁平 2D 卡通，粗净轮廓线，便于后续连续场景复用'
        ].filter(Boolean).join('，')
      }
    } else if (category === 'prop') {
      promptZh = [
        `${name}道具设计图，单一物件，居中展示，仅画物件本身`,
        usageLines.join('，'),
        '纯白背景，无手持，无人物，无头部，无模特，无佩戴展示，无场景，不把共现角色或地点画进去',
        '清楚表现材质、结构、尺寸比例、开口、边缘轮廓和正反面造型关系',
        '卡通童话绘本风格设计参考插画，扁平 2D 卡通，粗净轮廓线，便于后续连续场景复用'
      ].filter(Boolean).join('，')
    } else {
      promptZh = [
        `${name}地点参考图，稳定构图，统一环境语言`,
        '突出建筑、地形、植被、水体和光线关系',
        // 2026-08-28：H5 文本叠加在场景图上，下部留安静区保证可读
        '画面下部约三分之一保持低细节低对比的安静区域，便于 H5 文本叠加阅读',
        '卡通童话绘本风格，扁平 2D 卡通插画，适合作为连续场景统一地点锚点'
      ].join('，')
    }
  }

  const fallbackPromptEn = buildStoryAssetReferencePrompt({
    plan,
    asset,
    style: 'picture_book',
    globalPrompt: category === 'location' ? worldAnchor : '',
    assetPrompt: hint
  })
  let promptEn = pickEnglishPrompt(enBase, storyAssetStr(asset && asset.referencePromptEn).trim(), hint, fallbackPromptEn)

  const summary = (lockProfile === 'character_core' || category === 'character')
    ? `已强化为角色锁定参考图提示词：去掉场景环境与道具干扰，保留白底、正面全身、空手和外观锁定。`
    : category === 'prop'
      ? `已强化为道具锁定参考图提示词：补入故事职责、结构关注点和共现场景约束，同时保持单物件白底。`
      : `已强化为地点锁定提示词：突出环境构图和统一世界观。`

  // 2026-08-26 去跨故事污染：角色默认反向词删掉钓鱼故事专属的"鱼竿/水桶/水面/桥"，保持故事中立
  // 2026-08-29 统一画风负向：全类别追加反写实排除（用户指令：杜绝写实/卡通混杂）
  const antiRealismZh = '写实，照片级真实，3D渲染，CGI，油画，厚涂，超写实，摄影感'
  const defaultNegativePromptZh = (
    category === 'character'
      ? `多人，多主体，人物脸，真人小孩，拟人猫娘，帽子，场景背景，树木，草地，侧面，背面，三分之二侧面，投影，地面线，文字，水印，${antiRealismZh}`
      : category === 'prop'
        ? ['人物', '角色', '儿童', '女孩', '男孩', '头部', '脸部', '半身像', '上半身', '手持', '佩戴展示', '戴在头上', '模特', '人体穿戴关系', '场景背景', '树木', '草地', '水面', '文字', '水印', '写实', '照片级真实', '3D渲染', 'CGI', '油画', '厚涂', '超写实', '摄影感', ...propExclusionNames].join('，')
        : `人物特写，人群，文字，水印，${antiRealismZh}`
  )
  const negativePromptZh = (
    zhNegBase && category === 'prop'
      ? uniqStoryAssetPromptParts([
        ...splitStoryAssetPromptParts(zhNegBase),
        ...propExclusionNames
      ], 40).join('，')
      : zhNegBase
  ) || defaultNegativePromptZh

  return {
    promptZh,
    promptEn,
    negativePromptZh,
    negativePrompt: enNegBase || buildStoryAssetReferenceNegativePrompt({
      plan,
      asset,
      globalNegativePrompt: globalNegZh
    }),
    summary,
    context: {
      anchor,
      hint,
      worldAnchor,
      globalPromptZh: globalZh,
      usageContext
    }
  }
}

export function scoreStoryAssetPromptCandidate({ asset, promptZh, promptEn, negativePromptZh, negativePrompt, context }) {
  const name = storyAssetStr(asset && asset.name).trim()
  const category = storyAssetStr(asset && asset.category).trim().toLowerCase()
  const lockProfile = storyAssetStr(asset && asset.lockProfile).trim().toLowerCase()
  const promptZhText = storyAssetStr(promptZh).trim()
  const promptEnText = storyAssetStr(promptEn).trim()
  const negZhText = storyAssetStr(negativePromptZh).trim()
  const negEnText = storyAssetStr(negativePrompt).trim()
  const combinedZh = `${promptZhText}，${negZhText}`
  const combinedEn = `${promptEnText}, ${negEnText}`.toLowerCase()
  const strengths = []
  const risks = []
  const suggestions = []
  let score = 0

  const hasPositive = Boolean(promptZhText || promptEnText)
  const hasNegative = Boolean(negZhText || negEnText)
  if (hasPositive) {
    score += 12
    strengths.push('已生成正向提示词。')
  } else {
    risks.push('缺少正向提示词。')
    suggestions.push('必须先明确这个事物是什么，再补白底和单物件约束。')
  }
  if (hasNegative) {
    score += 8
    strengths.push('已生成负向提示词。')
  } else {
    risks.push('缺少负向提示词。')
    suggestions.push('补齐容易混淆的替代物、人物、场景和多物件排除项。')
  }

  // 2026-10-07 单物件约束同义词拓宽：AI 常写"单独悬挂/单件展示/单物展示"而非白名单原词（白裙、全身镜实测漏分）
  if (/(单一物件|仅画物件本身|单独(一|的|悬挂|展示|呈现)?|单件|单物|独件|独立物件|单个|仅一件|仅展示|single object|isolated object|exactly one object|single item|one object only)/i.test(`${promptZhText} ${promptEnText}`)) {
    score += 8
    strengths.push('单物件约束明确。')
  } else if (category === 'prop') {
    risks.push('单物件约束不足。')
    suggestions.push('明确写“单一物件、仅画物件本身、不要重复件”。')
  }

  if (/(纯白背景|白底|pure white background)/i.test(`${promptZhText} ${promptEnText}`)) {
    score += 6
    strengths.push('白底参考图约束明确。')
  } else if (category === 'prop' || category === 'character') {
    risks.push('白底参考图约束不足。')
    suggestions.push('补充纯白背景/无场景背景约束，避免混入故事场景。')
  }

  if (/(无人物|无人|no person|no character|no portrait|无手持|no hand|无场景|no environment)/i.test(`${combinedZh} ${combinedEn}`)) {
    score += 8
    strengths.push('人物和场景排除项明确。')
  } else if (category === 'prop') {
    risks.push('人物/场景排除项不足。')
    suggestions.push('补充无人物、无手持、无场景、无环境杂项。')
  }

  // 2026-10-07：三条语境线（故事职责/叙事识别重点/结构关注点）词表全部来自道具语境，
  // 角色提示词永远命中不了——角色跳过道具语境块，走下方专属评分线（公主穿衣 34 分误报根修）
  if (category !== 'character' && context && typeof context === 'object') {
    const roleLineZh = storyAssetStr(context.roleLineZh).trim()
    const plotCueLineZh = storyAssetStr(context.plotCueLineZh).trim()
    const structureLineZh = storyAssetStr(context.structureLineZh).trim()
    if (roleLineZh && containsStoryAssetMeaning(promptZhText, roleLineZh)) {
      score += 10
      strengths.push('提示词吸收了故事职责。')
    } else if (roleLineZh) {
      risks.push('提示词没有明显吸收故事职责。')
      suggestions.push('让提示词体现它在故事里的用途，而不是只剩通用商品图模板。')
    }
    if (plotCueLineZh && containsStoryAssetMeaning(promptZhText, plotCueLineZh)) {
      score += 10
      strengths.push('提示词体现了全文叙事识别重点。')
    } else if (plotCueLineZh) {
      risks.push('提示词没有体现全文情节里的识别重点。')
      suggestions.push('把“远看可辨、浮姿/下沉、连接点、开口/容积”等叙事识别点写进正向词。')
    }
    if (structureLineZh && containsStoryAssetMeaning(promptZhText, structureLineZh)) {
      score += 10
      strengths.push('提示词体现了结构关注点。')
    } else if (structureLineZh) {
      risks.push('提示词缺少结构关注点。')
      suggestions.push('把关键结构部位、连接关系、端头/孔位/节点写清楚。')
    }
  }

  // 2026-10-07 角色评分公平性根修：上面三条语境线的词表全部来自道具语境（浮漂/连接点/开口容积），
  // 角色提示词永远命中不了——角色被钉死在 34 分基线并误报"推倒重生"（公主穿衣佳佳/艾莉实测）。
  // 角色改走专属评分线：身份特征吸收 / 参考图构图约束 / 神态可读性。
  if (category === 'character') {
    // 角色语境线不适用道具词表——补偿分：角色专属三条线（各 10 分，对齐道具的 30 分语境权重）
    const anchorText = storyAssetStr(asset && asset.anchorPrompt)
    const featureTokens = (anchorText.match(/[一-鿿]{2,8}/g) || [])
      .filter((t) => !/^(的|了|与|和|或在|是|有|无|不|单一|纯白|背景|居中|全身|正面|站姿|角色|年轻|一个)/.test(t))
      .slice(0, 12)
    const nameTokens = [name, ...(Array.isArray(asset && asset.aliases) ? asset.aliases : [])]
      .map((x) => storyAssetStr(x).trim())
      .filter((t) => t.length >= 2)
    const identityHits = [...nameTokens, ...featureTokens].filter((t) => promptZhText.includes(t) || combinedEn.includes(t.toLowerCase()))
    if (identityHits.length >= 2) {
      score += 10
      strengths.push('提示词吸收了角色身份特征。')
    } else {
      risks.push('提示词缺少角色身份特征（名字/发型/服装等锚点词）。')
      suggestions.push('把角色的发型、服装、体型等身份锚点特征写进正向词。')
    }
    const frameText = `${promptZhText} ${promptEnText}`
    if (/(全身|full.?body|head to toe)/i.test(frameText) && /(正面|front)/i.test(frameText) && /(单[一个两]?[角色人]|single character|one character|居中)/i.test(frameText)) {
      score += 10
      strengths.push('全身正面单角色构图约束明确。')
    } else {
      risks.push('参考图构图约束不足（全身/正面/单角色）。')
      suggestions.push('补充"全身、正面、单角色、居中、纯白背景"的参考图构图约束。')
    }
    if (/(表情|神态|微笑|开朗|温柔|灵动|眼神|气质)/.test(promptZhText) || /(expression|smile|gentle|cheerful|demeanor)/i.test(promptEnText)) {
      score += 10
      strengths.push('神态/气质可读性约束明确。')
    } else {
      risks.push('缺少神态/气质约束（角色表情是锁定身份的一部分）。')
      suggestions.push('补充角色的神态或气质关键词（如 友好开朗/温柔/眼神灵动）。')
    }
  }

  const forbidden = Array.isArray(asset && asset.forbiddenSubstitutes) ? asset.forbiddenSubstitutes.map((x) => storyAssetStr(x).trim()).filter(Boolean) : []
  const forbiddenMentioned = forbidden.filter((item) => combinedZh.includes(item) || combinedEn.includes(item.toLowerCase()))
  if (forbiddenMentioned.length) {
    score += Math.min(12, forbiddenMentioned.length * 3)
    strengths.push(`已排除 ${forbiddenMentioned.length} 个已知易混替代物。`)
  } else if (forbidden.length) {
    risks.push('未明显排除已知易混替代物。')
    suggestions.push(`至少补进这些高风险替代项：${forbidden.slice(0, 4).join('、')}。`)
  }

  if (lockProfile === 'slender_prop' && /(完整显示全长|full length|end to end|两端|孔位|节点|foreshortening|透视缩短)/i.test(`${promptZhText} ${promptEnText} ${combinedZh} ${combinedEn}`)) {
    score += 10
    strengths.push('细长道具的长度与端头约束明确。')
  } else if (lockProfile === 'slender_prop') {
    risks.push('细长道具缺少全长/端头/孔位约束。')
    suggestions.push('补充“完整显示全长、两端不可裁切、孔位或节点清楚、避免透视缩短”。')
  }

  const signalText = [name, storyAssetStr(asset && asset.anchorPrompt), ...(Array.isArray(asset && asset.aliases) ? asset.aliases : [])].join(' ').toLowerCase()
  if (/\b(bobber|float)\b|浮漂|漂子/.test(signalText)) {
    const bobberSignals = /(红白|红色.*白色|red-and-white|gourd|葫芦|cork|软木|center pin|中心针|eyelet|小环)/i.test(`${promptZhText} ${promptEnText} ${combinedZh} ${combinedEn}`)
    const badSignals = /(glass|玻璃|aquarium|rectangular box|box|beaker|plastic ball bobber|clip-on|slot|side slit|透明中段|球形)/i.test(`${promptZhText} ${promptEnText} ${combinedZh} ${combinedEn}`)
    if (bobberSignals) {
      score += 14
      strengths.push('已经钉住浮漂的关键身份特征。')
    } else {
      score -= 18
      risks.push('还没有把“红白葫芦形软木漂、中心针、上下小环”钉死。')
      suggestions.push('明确写红上白下、葫芦形软木本体、细黑中心针、顶部和底部小环。')
    }
    if (badSignals) {
      score -= 18
      risks.push('提示词里仍保留会把浮漂引向玻璃盒、球漂或夹扣漂的风险。')
    }
    if (/(鱼竿|竹鱼竿|bucket|pail|开口|容积|肩带|提梁|bamboo rod|handle|strap)/i.test(`${promptZhText} ${promptEnText} ${combinedZh} ${combinedEn}`)) {
      score -= 24
      risks.push('浮漂提示词混入了鱼竿/桶类结构语义。')
      suggestions.push('浮漂只能保留红白葫芦形、中心针、上下小环和独立单物件约束。')
    }
  }

  if (/\b(minnow|fish|silver fish)\b|小银鱼|银鱼/.test(signalText)) {
    const fishSignals = /(银色|silver|细长|纺锤|torpedo|叉形尾|forked tail|鳞片|scales|黑珠眼|bead eye|小鳍|fin)/i.test(`${promptZhText} ${promptEnText} ${combinedZh} ${combinedEn}`)
    const badFishSignals = /(开口|容积|桶沿|肩带|提梁|bucket|pail|strap|handle|佩戴|模特|wearing|portrait|human|手持|钓竿|鱼竿|hooked on line|aquarium|fish tank|观赏鱼|goldfish|koi|carp|trout|crab)/i.test(`${promptZhText} ${promptEnText} ${combinedZh} ${combinedEn}`)
    if (fishSignals) {
      score += 14
      strengths.push('已经钉住小银鱼的关键形体特征。')
    } else {
      score -= 18
      risks.push('还没有把“小型银色鱼身、叉形尾、鳞片、小黑眼”钉死。')
      suggestions.push('明确写细长银色小鱼、纺锤形身体、叉形尾、反光鳞片和小黑珠眼。')
    }
    if (badFishSignals) {
      score -= 24
      risks.push('小银鱼提示词混入了鱼桶/人物/钓具/观赏鱼语义。')
      suggestions.push('小银鱼只能保留单条自然小鱼的身体结构，不要写开口、容积、佩戴、手持、鱼竿或观赏鱼场景。')
    }
  }

  if (/\b(butterfly|swallowtail)\b|蝴蝶|彩蝶/.test(signalText)) {
    const butterflySignals = /(蝴蝶|butterfly|swallowtail|双翅|wings|翅脉|veins|触角|antennae|尾突|彩色|cyan|magenta|yellow)/i.test(`${promptZhText} ${promptEnText} ${combinedZh} ${combinedEn}`)
    const badButterflySignals = /(鱼|小鱼|minnow|fish|叉形尾|forked tail|鳍|fin|水面|aquarium|标本针|specimen pin|蜻蜓|dragonfly|飞蛾|moth|bird|小鸟)/i.test(`${promptZhText} ${promptEnText} ${combinedZh} ${combinedEn}`)
    if (butterflySignals) {
      score += 14
      strengths.push('已经钉住蝴蝶的关键形体特征。')
    } else {
      score -= 18
      risks.push('还没有把“彩色双翅、黑色翅脉、细长触角、蝴蝶轮廓”钉死。')
      suggestions.push('明确写单只彩色蝴蝶、双翅轮廓、黑色翅脉、细长触角和轻盈昆虫姿态。')
    }
    if (badButterflySignals) {
      score -= 24
      risks.push('蝴蝶提示词混入了小鱼/标本针/飞蛾/蜻蜓等错误语义。')
      suggestions.push('蝴蝶只能保留双翅、翅脉、触角和配色，不要写鱼身、鱼鳍、水面、标本针或其它昆虫。')
    }
  }

  // 2026-10-07：裸 pole 串台修复（与 isStoryAssetRodLike 同步）——衣架"hanger pole"不再命中鱼竿分支
  if (/\b(bamboo fishing rod|bamboo rod|fishing rod|fishing pole)\b|竹鱼竿|鱼竿|竹竿/.test(signalText)) {
    const rodSignals = /(竹节|竹制|bamboo|nodes?|竿梢|tip|no reel|无渔轮|棉线|cotton line|hook|鱼钩)/i.test(`${promptZhText} ${promptEnText} ${combinedZh} ${combinedEn}`)
    const badRodSignals = /(开口|容积|桶沿|肩带|提梁|bucket|pail|strap|handle|红白|葫芦|bobber|float|center pin|eyelet)/i.test(`${promptZhText} ${promptEnText} ${combinedZh} ${combinedEn}`)
    if (rodSignals) {
      score += 14
      strengths.push('已经钉住竹鱼竿的关键身份特征。')
    } else {
      score -= 18
      risks.push('还没有把“竹节、无渔轮、竿梢绑线点、末端细线和小钩”钉死。')
      suggestions.push('明确写单根竹制鱼竿、清楚竹节、无渔轮、竿梢绑线、末端细线与小钩。')
    }
    if (badRodSignals) {
      score -= 24
      risks.push('竹鱼竿提示词混入了鱼桶/浮漂类结构语义。')
      suggestions.push('竹鱼竿只能保留全长、竹节、绑线点、细线和小钩，不要写开口、容积、红白配色或浮姿。')
    }
  }

  if (/(关联场景[:：]|常与这些元素同场[:：])/.test(promptZhText)) {
    score -= 20
    risks.push('正向词仍混入关联场景/共现元素文本。')
    suggestions.push('不要把“关联场景”原样写进正向词，只把它转成结构和识别要求。')
  }

  // 2026-10-07 否定盲修复：先剥掉"无/不含/没有/不出现/禁止 X"否定片段再测危险词——
  // 否则"无任何人物，模特或衣架出现"这类正确排除句被误判为混入人物语义（公主穿衣白裙 29 分实测）
  const promptZhPositiveOnly = promptZhText.replace(/(无任何|无|没有|不含|不包括|不出现|禁止|不要|避免|排除|去除)[^，。；,;、]{0,20}/g, '，')
  const dangerousHumanCue =
    /(女孩|男孩|头部|脸部|模特|佩戴展示|戴在头上|girl|boy|portrait|wearing|worn on head|model)/i.test(promptZhPositiveOnly)
  const explicitPersonCue =
    /(人物|角色)/.test(promptZhPositiveOnly) &&
    !/(无人物|无人|非人物|不出现人物|仅画物件本身|无角色|不出现角色)/.test(promptZhPositiveOnly)
  const childCue =
    /儿童/.test(promptZhPositiveOnly) &&
    !/(儿童道具|儿童故事|儿童绘本|storybook|picture book)/i.test(promptZhPositiveOnly)
  if ((dangerousHumanCue || explicitPersonCue || childCue) && category === 'prop') {
    score -= 18
    risks.push('道具正向词混入人物/佩戴展示语义。')
    suggestions.push('道具锁定词必须是独立物件，不要出现人物、佩戴、模特或头部。')
  }

  score = Math.max(0, Math.min(100, Math.round(score)))
  const passed = score >= 50
  const summary = passed
    ? `提示词评分 ${score}/100，已达到保留阈值。`
    : `提示词评分 ${score}/100，低于保留阈值，需要推倒重生。`
  return {
    passed,
    score,
    summary,
    strengths: uniqStoryAssetPromptParts(strengths, 8),
    risks: uniqStoryAssetPromptParts(risks, 10),
    suggestions: uniqStoryAssetPromptParts(suggestions, 8)
  }
}

export async function translateStoryAssetPromptPair({ studio, promptZh, negativePromptZh, fallbackPromptEn, fallbackNegativePrompt, timeoutMs = 60_000 }) {
  const translationCfg = studio?.effective?.translation || {}
  const promptCfg = studio?.effective?.prompt || {}
  const providers = [
    {
      provider: storyAssetStr(translationCfg.provider).trim().toLowerCase(),
      model: translationCfg.model || undefined,
      apiUrl: translationCfg.apiUrl || undefined,
      note: null
    },
    {
      provider: storyAssetStr(promptCfg.provider).trim().toLowerCase(),
      model: promptCfg.model || undefined,
      apiUrl: promptCfg.apiUrl || undefined,
      note: 'translation_fallback_to_prompt_provider'
    }
  ].filter((item, index, list) => item.provider && item.provider !== 'none' && list.findIndex((entry) => entry.provider === item.provider && String(entry.apiUrl || '') === String(item.apiUrl || '')) === index)

  if (!providers.length) {
    return {
      promptEn: storyAssetStr(fallbackPromptEn).trim(),
      negativePrompt: storyAssetStr(fallbackNegativePrompt).trim(),
      meta: { provider: 'fallback', model: null, api: null, note: 'translation_provider_missing' }
    }
  }
  const proxyUrl = studio?.effective?.network?.proxyUrl || undefined
  let promptRes = null
  let negativeRes = null
  let providerMeta = null
  let lastError = null
  for (const candidate of providers) {
    try {
      // 2026-08-26 修复：串行执行两次翻译；本地 27B 并发 prefill 会把 KV 峰值翻倍，实测触发 oMLX 内存护栏
      promptRes = await translatePromptText({
        provider: candidate.provider,
        model: candidate.model,
        apiUrl: candidate.apiUrl,
        proxyUrl,
        timeoutMs,
        text: storyAssetStr(promptZh).trim(),
        sourceLang: 'zh',
        targetLang: 'en',
        mode: 'prompt'
      })
      negativeRes = await translatePromptText({
        provider: candidate.provider,
        model: candidate.model,
        apiUrl: candidate.apiUrl,
        proxyUrl,
        timeoutMs,
        text: storyAssetStr(negativePromptZh).trim(),
        sourceLang: 'zh',
        targetLang: 'en',
        mode: 'prompt'
      })
      providerMeta = {
        provider: promptRes?.meta?.provider || candidate.provider,
        model: promptRes?.meta?.model || candidate.model || null,
        api: promptRes?.meta?.api || candidate.apiUrl || null,
        note: candidate.note
      }
      break
    } catch (e) {
      lastError = e
    }
  }
  if (!promptRes || !negativeRes) throw lastError || new Error('translation_failed')
  return {
    promptEn: pickEnglishPrompt(storyAssetStr(promptRes?.result?.translatedText).trim(), fallbackPromptEn),
    negativePrompt: storyAssetStr(negativeRes?.result?.translatedText).trim() || storyAssetStr(fallbackNegativePrompt).trim(),
    meta: providerMeta || null
  }
}

export async function cleanupEmptyStoryAssetDirs(startDir, stopDir) {
  const stop = path.resolve(stopDir)
  let current = path.resolve(startDir)
  while (current.startsWith(stop) && current !== stop) {
    const items = await readdir(current).catch(() => null)
    if (!Array.isArray(items) || items.length > 0) break
    await rm(current, { recursive: true, force: true }).catch(() => null)
    current = path.dirname(current)
  }
}

export async function deleteStoryAssetManagedFile({ id, dir, plan, asset, targetAssetPath }) {
  const targetUri = normalizeStoryAssetUri(targetAssetPath)
  if (!targetUri) {
    const e = new Error('missing_asset_path')
    e.status = 400
    throw e
  }
  if (!isManagedStoryAssetPathForAsset(asset, targetUri)) {
    const e = new Error('story_asset_delete_forbidden')
    e.status = 403
    throw e
  }

  const bundle = await readProjectBundle(id)
  const projectAssets = Array.isArray(bundle.rawProject && bundle.rawProject.assets) ? bundle.rawProject.assets : []
  const removedProjectAssets = projectAssets.filter((item) => normalizeStoryAssetUri(item && item.uri) === targetUri)
  const removedProjectAssetIds = new Set(removedProjectAssets.map((item) => storyAssetStr(item && item.id).trim()).filter(Boolean))

  // 2026-09-16 摆位引用守卫：图被 story.json 任一摆位引用时禁止删除（与场景图 bound_image 同款语义，防画布白洞）
  if (removedProjectAssetIds.size) {
    const storyDoc = bundle.story && typeof bundle.story === 'object' ? bundle.story : null
    const boundHit = (Array.isArray(storyDoc && storyDoc.nodes) ? storyDoc.nodes : []).find((node) =>
      (Array.isArray(node && node.visuals && node.visuals.placements) ? node.visuals.placements : [])
        .some((p) => removedProjectAssetIds.has(storyAssetStr(p && p.imageAssetId).trim()))
    )
    if (boundHit) {
      const e = new Error(`该图片正被场景「${storyAssetStr(boundHit.name || boundHit.id) || '未命名'}」的摆位引用，请先在合成层解除摆位后再删除`)
      e.code = 'bound_image'
      e.status = 409
      throw e
    }
  }

  const abs = path.join(dir, targetUri)
  await rm(abs, { force: true }).catch(() => null)
  await cleanupEmptyStoryAssetDirs(path.dirname(abs), path.join(dir, 'assets', 'ai'))

  const nextProject = {
    ...bundle.rawProject,
    assets: projectAssets.filter((item) => normalizeStoryAssetUri(item && item.uri) !== targetUri),
    characters: Array.isArray(bundle.rawProject && bundle.rawProject.characters)
      ? bundle.rawProject.characters.map((ch) => {
          const refId = storyAssetStr(ch && ch.ai && ch.ai.referenceAssetId).trim()
          if (!refId || !removedProjectAssetIds.has(refId)) return ch
          return {
            ...ch,
            ai: {
              ...((ch && ch.ai && typeof ch.ai === 'object') ? ch.ai : {}),
              referenceAssetId: ''
            }
          }
        })
      : bundle.rawProject.characters,
    updatedAt: new Date().toISOString()
  }
  await writeJson(path.join(dir, 'project.json'), nextProject)

  const deletingPrimary = normalizeStoryAssetUri(asset && asset.primaryReferenceAssetUri) === targetUri
  const deletingHint = normalizeStoryAssetUri(asset && asset.lineartHintAssetUri) === targetUri
  const deletingFinal = normalizeStoryAssetUri(asset && asset.lineartFinalAssetUri) === targetUri
  const nextPlan = {
    ...plan,
    generatedAt: new Date().toISOString(),
    assets: Array.isArray(plan && plan.assets) ? plan.assets.map((item) => {
      if (storyAssetStr(item && item.id).trim() !== storyAssetStr(asset && asset.id).trim()) return item
      const nextGeneratedRefs = Array.isArray(item && item.generatedRefs)
        ? item.generatedRefs.filter((ref) => normalizeStoryAssetUri(ref && ref.projectAssetUri) !== targetUri)
        : []
      const nextBatch = Array.isArray(item && item.latestReferenceBatch)
        ? item.latestReferenceBatch.filter((entry) => normalizeStoryAssetUri(entry && entry.assetPath) !== targetUri)
        : []
      // 2026-09-16 姿势/状态变体记录联动：立绘被删整条移除；仅绿幕被删则清空 greenPath 保留变体
      const cleanVariants = (variants) => Array.isArray(variants)
        ? variants
            .filter((v) => normalizeStoryAssetUri(v && v.cutoutPath) !== targetUri)
            .map((v) => (normalizeStoryAssetUri(v && v.greenPath) === targetUri ? { ...v, greenPath: '' } : v))
        : variants
      const nextPoseVariants = cleanVariants(item && item.poseVariants)
      const nextStateVariants = cleanVariants(item && item.stateVariants)
      const primaryReferenceAssetUri = deletingPrimary ? '' : storyAssetStr(item && item.primaryReferenceAssetUri).trim()
      const primaryReferenceAssetId = deletingPrimary ? '' : storyAssetStr(item && item.primaryReferenceAssetId).trim()
      const lineartHintAssetUri = deletingHint || deletingPrimary ? '' : storyAssetStr(item && item.lineartHintAssetUri).trim()
      const lineartHintAssetId = deletingHint || deletingPrimary ? '' : storyAssetStr(item && item.lineartHintAssetId).trim()
      const lineartFinalAssetUri = deletingFinal || deletingPrimary ? '' : storyAssetStr(item && item.lineartFinalAssetUri).trim()
      const lineartFinalAssetId = deletingFinal || deletingPrimary ? '' : storyAssetStr(item && item.lineartFinalAssetId).trim()
      const lineartReady = Boolean(lineartHintAssetUri && lineartFinalAssetUri)
      let referenceStatus = primaryReferenceAssetUri ? 'ready' : (nextBatch.length || nextGeneratedRefs.length ? 'candidates_ready' : 'missing')
      if (!primaryReferenceAssetUri && storyAssetStr(item && item.renderStrategy).trim() === 'prompt_only') referenceStatus = 'missing'
      return {
        ...item,
        generatedRefs: nextGeneratedRefs,
        latestReferenceBatch: nextBatch,
        ...(Array.isArray(nextPoseVariants) ? { poseVariants: nextPoseVariants } : {}),
        ...(Array.isArray(nextStateVariants) ? { stateVariants: nextStateVariants } : {}),
        latestRecommendedReferenceAssetUri: normalizeStoryAssetUri(item && item.latestRecommendedReferenceAssetUri) === targetUri
          ? ''
          : storyAssetStr(item && item.latestRecommendedReferenceAssetUri).trim(),
        primaryReferenceAssetUri,
        primaryReferenceAssetId,
        primaryReferenceSelectedAt: primaryReferenceAssetUri ? storyAssetStr(item && item.primaryReferenceSelectedAt).trim() : '',
        latestReferenceReview: (
          item && item.latestReferenceReview && typeof item.latestReferenceReview === 'object' &&
          normalizeStoryAssetUri(item.latestReferenceReview.targetAssetUri) === targetUri
        )
          ? null
          : (item.latestReferenceReview || null),
        referenceStatus,
        lineartHintAssetUri,
        lineartHintAssetId,
        lineartFinalAssetUri,
        lineartFinalAssetId,
        lineartStatus: lineartReady ? 'ready' : 'missing',
        lineartPrompt: lineartReady ? storyAssetStr(item && item.lineartPrompt).trim() : '',
        lineartNegativePrompt: lineartReady ? storyAssetStr(item && item.lineartNegativePrompt).trim() : '',
        lineartMeta: lineartReady ? (item && item.lineartMeta && typeof item.lineartMeta === 'object' ? item.lineartMeta : null) : null,
        lineartGeneratedAt: lineartReady ? storyAssetStr(item && item.lineartGeneratedAt).trim() : ''
      }
    }) : plan.assets
  }
  nextPlan.summary = summarizeStoryAssetPlan(nextPlan)
  await saveStoryAssetPlan(id, nextPlan)
  return {
    plan: nextPlan,
    asset: (Array.isArray(nextPlan.assets) ? nextPlan.assets.find((item) => storyAssetStr(item && item.id).trim() === storyAssetStr(asset && asset.id).trim()) : null) || null,
    items: buildStoryAssetGalleryEntries({ projectId: id, project: normalizeProjectDoc(nextProject), plan: nextPlan, asset: (Array.isArray(nextPlan.assets) ? nextPlan.assets.find((item) => storyAssetStr(item && item.id).trim() === storyAssetStr(asset && asset.id).trim()) : null) || asset }),
    deleted: true
  }
}
