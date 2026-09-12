// 出图总账（coverage）：从 plan.json / story.json / project.json / image_reviews.jsonl 与磁盘文件
// 确定性计算「需要多少图、完成多少、缺哪些」。只读聚合，无任何写副作用。
// 状态口径：
//   事物图（立绘/道具）：missing -> candidates（有抽卡）-> selected（已选定主参考）-> locked（lock_confirm 已批准，终态）
//   背景图（场景）：pending -> rendered（背景已写回且文件存在）-> bound（scene_bind 已批准，终态）
import { readdir, readFile, stat } from 'fs/promises'
import path from 'path'
import { listImageReviews } from '../review/imageReviewStore.js'

function asStr(v) {
  return typeof v === 'string' ? v.trim() : ''
}

async function readJsonSafe(file) {
  try {
    return JSON.parse(await readFile(file, 'utf-8'))
  } catch (_) {
    return null
  }
}

async function fileExists(file) {
  try {
    const s = await stat(file)
    return s.isFile() && s.size > 0
  } catch (_) {
    return false
  }
}

// 统计某资产的抽卡候选数：assets/ai/story_assets/<category>/<assetId>/<date>/reference_*.png
async function countReferenceImages(dir, assetId, category) {
  const root = path.join(dir, 'assets', 'ai', 'story_assets')
  const categories = category ? [category] : []
  // category 缺失时兜底扫描全部类别目录
  if (!categories.length) {
    try {
      const entries = await readdir(root, { withFileTypes: true })
      for (const e of entries) if (e.isDirectory()) categories.push(e.name)
    } catch (_) {
      return 0
    }
  }
  let count = 0
  for (const cat of categories) {
    const assetDir = path.join(root, cat, assetId)
    let dateDirs = []
    try {
      const entries = await readdir(assetDir, { withFileTypes: true })
      dateDirs = entries.filter((e) => e.isDirectory()).map((e) => e.name)
    } catch (_) {
      continue
    }
    for (const dateDir of dateDirs) {
      try {
        const files = await readdir(path.join(assetDir, dateDir))
        count += files.filter((f) => f.startsWith('reference_') && /\.(png|jpe?g|webp)$/i.test(f)).length
      } catch (_) { /* 单个日期目录不可读不影响整体 */ }
    }
  }
  return count
}

function latestApproved(reviews, phase, match) {
  // listImageReviews 已按 createdAt 倒序
  return reviews.find((r) => r && r.phase === phase && r.status === 'approved' && match(r)) || null
}

export async function getStoryImageCoverage(dir) {
  const [plan, story, project, reviews] = await Promise.all([
    readJsonSafe(path.join(dir, 'story-assets', 'plan.json')),
    readJsonSafe(path.join(dir, 'story.json')),
    readJsonSafe(path.join(dir, 'project.json')),
    listImageReviews(dir).catch(() => [])
  ])

  // ---- 事物图（资产立绘）----
  const assetItems = []
  const planAssets = Array.isArray(plan?.assets) ? plan.assets : []
  for (const asset of planAssets) {
    const assetId = asStr(asset && asset.id)
    if (!assetId) continue
    const primaryUri = asStr(asset && asset.primaryReferenceAssetUri).replace(/^\/+/, '')
    const primaryExists = primaryUri ? await fileExists(path.join(dir, primaryUri)) : false
    const referenceCount = await countReferenceImages(dir, assetId, asStr(asset && asset.category))
    const lock = latestApproved(reviews, 'lock_confirm', (r) => asStr(r.assetId) === assetId)
    // prompt_only 资产（如场景锚点地点）设计上不需要立绘引用：无引用且无候选时记 not_required，不计入需求总数
    const referenceNotRequired = asStr(asset && asset.renderStrategy) === 'prompt_only'
      && !primaryUri && referenceCount === 0
    const status = referenceNotRequired
      ? 'not_required'
      : lock && primaryExists
        ? 'locked'
        : primaryUri && primaryExists
          ? 'selected'
          : referenceCount > 0
            ? 'candidates'
            : 'missing'
    assetItems.push({
      id: assetId,
      name: asStr(asset && asset.name) || assetId,
      category: asStr(asset && asset.category),
      sceneCount: Number(asset && asset.sceneCount) || 0,
      referenceCount,
      primaryReferenceAssetUri: primaryUri,
      primaryExists,
      lockConfirmed: Boolean(lock),
      lockConfirmedAt: lock ? asStr(lock.decidedAt || lock.createdAt) : '',
      status
    })
  }

  // ---- 背景图（场景）----
  const projectAssets = Array.isArray(project?.assets) ? project.assets : []
  const storyNodes = Array.isArray(story?.nodes)
    ? story.nodes
    : (story?.nodes && typeof story.nodes === 'object' ? Object.values(story.nodes) : [])
  const sceneItems = []
  for (const node of storyNodes) {
    const sceneId = asStr(node && node.id)
    if (!sceneId) continue
    const backgroundAssetId = asStr(node && node.visuals && node.visuals.backgroundAssetId)
    const projectAsset = backgroundAssetId
      ? projectAssets.find((a) => asStr(a && a.id) === backgroundAssetId) || null
      : null
    const backgroundUri = asStr(projectAsset && projectAsset.uri).replace(/^\/+/, '')
    const backgroundExists = backgroundUri ? await fileExists(path.join(dir, backgroundUri)) : false
    const bind = latestApproved(reviews, 'scene_bind', (r) => asStr(r.sceneId) === sceneId)
    const status = bind && backgroundExists ? 'bound' : backgroundExists ? 'rendered' : 'pending'
    sceneItems.push({
      id: sceneId,
      name: asStr(node && (node.title || node.name)) || sceneId,
      backgroundAssetId,
      backgroundUri,
      backgroundExists,
      bindApproved: Boolean(bind),
      bindApprovedAt: bind ? asStr(bind.decidedAt || bind.createdAt) : '',
      status
    })
  }

  // ---- 总计 ----
  // not_required（prompt_only 且无需立绘）不计入需求总数
  const requiredAssets = assetItems.filter((item) => item.status !== 'not_required')
  const countBy = (items, status) => items.filter((item) => item.status === status).length
  const assetTotals = {
    total: requiredAssets.length,
    locked: countBy(requiredAssets, 'locked'),
    selected: countBy(requiredAssets, 'selected'),
    candidates: countBy(requiredAssets, 'candidates'),
    missing: countBy(requiredAssets, 'missing'),
    notRequired: countBy(assetItems, 'not_required')
  }
  const sceneTotals = {
    total: sceneItems.length,
    bound: countBy(sceneItems, 'bound'),
    rendered: countBy(sceneItems, 'rendered'),
    pending: countBy(sceneItems, 'pending')
  }
  const required = assetTotals.total + sceneTotals.total
  const done = assetTotals.locked + sceneTotals.bound
  const pendingReviews = reviews.filter((r) => r && r.status === 'pending').length

  return {
    schemaVersion: '1.0',
    generatedAt: new Date().toISOString(),
    hasPlan: Boolean(plan),
    assets: { ...assetTotals, items: assetItems },
    scenes: { ...sceneTotals, items: sceneItems },
    overall: {
      required,
      done,
      remaining: Math.max(0, required - done),
      percent: required > 0 ? Math.round((done / required) * 100) : 0,
      pendingReviews
    }
  }
}
