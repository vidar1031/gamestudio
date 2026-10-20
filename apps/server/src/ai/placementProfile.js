// 道具/角色摆放画像（2026-10-20 index.js 拆分收尾迁出；函数体逐字未改）
import { genId } from './scripts.js'
import { verifyStoryAssetReferenceFile } from './storyAssetReferenceGate.js'

// 默认站位：1 人 0.5；2 人 0.3/0.7；3 人 0.25/0.5/0.75；>3 人兜底横向均分
export function defaultPlacementX(index, count) {
  if (count <= 1) return 0.5
  if (count === 2) return [0.3, 0.7][index]
  if (count === 3) return [0.25, 0.5, 0.75][index]
  return Number(((index + 1) / (count + 1)).toFixed(4))
}

// 立绘默认缩放：运行时按「原始像素 × scale」渲染，1024px 立绘在千像素级舞台上 scale=1 会铺满舞台。
// 按立绘实际像素高度收敛到约 62% 舞台高（参考舞台高 1024px），无尺寸信息时回退 0.62。
export function defaultPlacementScale(asset) {
  const refs = Array.isArray(asset?.generatedRefs) ? asset.generatedRefs : []
  const withSize = refs.find((r) => Number(r && r.height) > 0)
  const heightPx = Number(withSize && withSize.height) || 0
  if (!heightPx) return 0.62
  return Math.min(1, Math.max(0.25, Number((640 / heightPx).toFixed(3))))
}

// 为计划中的角色资产匹配 project.json 角色：优先 projectCharacterId，其次名字/别名（不区分大小写）
export function findProjectCharacterForStoryAsset(characters, asset) {
  const list = Array.isArray(characters) ? characters : []
  const wantedId = String(asset?.projectCharacterId || '').trim()
  if (wantedId) {
    const hit = list.find((ch) => String(ch && ch.id || '').trim() === wantedId)
    if (hit) return hit
  }
  const keys = new Set(
    [asset?.name, ...(Array.isArray(asset?.aliases) ? asset.aliases : [])]
      .map((x) => String(x || '').trim().toLowerCase())
      .filter(Boolean)
  )
  if (!keys.size) return null
  return list.find((ch) => keys.has(String(ch && ch.id || '').trim().toLowerCase()) || keys.has(String(ch && ch.name || '').trim().toLowerCase())) || null
}

// ---------------------------------------------------------------------------
// prop 分层合成默认位姿（2026-09-27 F6）：确定性规则，不做语义猜测。
// flying：飞虫类（butterfly/dragonfly 等 slender/small prop）放画面上三分之一、scale 0.10-0.18、x 错开角色；
// ground：桶/盆类地面道具放角色侧前方、scale 0.15-0.25；
// fish_near_bucket：结局场景的鱼放桶位置附近（找不到桶退化为 ground）。
// ---------------------------------------------------------------------------
export const FLYING_PROP_PATTERN = /(butterfly|dragonfly|bee|beetle|firefl|insect|bug|moth|蝴蝶|蜻蜓|蜜蜂|甲虫|萤火|昆虫|飞蛾)/i

export const FISH_PROP_PATTERN = /(fish|鱼)/i

export const BUCKET_PROP_PATTERN = /(bucket|tub|barrel|pail|basin|木桶|水桶|桶|盆)/i

export function propAssetSignalText(asset) {
  return [asset?.name, asset?.anchorPrompt, ...(Array.isArray(asset?.aliases) ? asset.aliases : [])].map((x) => String(x || '')).join(' ')
}

export function propPlacementProfile(asset, { isEndingScene } = {}) {
  const signal = propAssetSignalText(asset)
  if (FLYING_PROP_PATTERN.test(signal)) return 'flying'
  if (isEndingScene && FISH_PROP_PATTERN.test(signal)) return 'fish_near_bucket'
  return 'ground'
}

export function propPlacementTransform({ profile, index, characterXs, bucketTransform }) {
  if (profile === 'flying') {
    // 上三分之一（y≈0.30），x 从候选位中取与所有角色水平距离 ≥0.15 的第一个；都太近时取距离最远的
    const xs = Array.isArray(characterXs) ? characterXs : []
    const candidates = [0.2, 0.8, 0.35, 0.65, 0.5]
    let best = candidates[0]
    let bestDist = -1
    for (const cx of candidates) {
      const d = xs.length ? Math.min(...xs.map((x) => Math.abs(x - cx))) : 1
      if (d >= 0.15) { best = cx; break }
      if (d > bestDist) { best = cx; bestDist = d }
    }
    return { x: best, y: Number((0.3 + (index % 2) * 0.06).toFixed(3)), scale: 0.14, rotationDeg: 0 }
  }
  if (profile === 'fish_near_bucket' && bucketTransform) {
    return {
      x: Math.max(0.06, Math.min(0.94, Number((Number(bucketTransform.x) + 0.07 || 0.57).toFixed(3)))),
      y: Math.max(0.3, Math.min(0.95, Number((Number(bucketTransform.y) - 0.05 || 0.83).toFixed(3)))),
      scale: 0.12,
      rotationDeg: 0
    }
  }
  // ground：首个角色侧前方（交替向两侧错开），无角色时从左起横向铺开
  const xs = Array.isArray(characterXs) ? characterXs : []
  if (!xs.length) return { x: Math.max(0.15, Math.min(0.85, Number((0.3 + index * 0.2).toFixed(3)))), y: 0.88, scale: 0.2, rotationDeg: 0 }
  const dir = index % 2 === 0 ? 1 : -1
  const step = 0.16 * (Math.floor(index / 2) + 1)
  return { x: Math.max(0.08, Math.min(0.92, Number((xs[0] + dir * step).toFixed(3)))), y: 0.88, scale: 0.2, rotationDeg: 0 }
}

// prop 摆位所需的「已关联项目资产 id」集合（幂等匹配用）：主参考 + 全部抽卡候选的 projectAssetId
export function associatedPropProjectAssetIds(asset) {
  return new Set(
    [
      String(asset?.primaryReferenceAssetId || '').trim(),
      ...(Array.isArray(asset?.generatedRefs) ? asset.generatedRefs : []).map((r) => String(r && r.projectAssetId || '').trim())
    ].filter(Boolean)
  )
}

// 解析 prop 摆位所需的项目图片资产 id：
// primaryReferenceAssetId → 项目资产按 uri 反查 → generatedRefs 按 uri 反查；
// 都解析不到但主参考文件真实存在时，登记一条项目资产（与 select 链路「故事资产立绘」登记同形），
// 并由调用方回写计划 primaryReferenceAssetId。文件不真实返回 null（调用方跳过，不伪造引用）。
export async function resolvePropPlacementImageAsset({ dir, asset, projectAssets, sceneId }) {
  const assetId = String(asset?.id || '').trim()
  const assets = Array.isArray(projectAssets) ? projectAssets : []
  const hasAsset = (aid) => Boolean(aid) && assets.some((a) => String(a && a.id || '').trim() === aid)

  // 2026-09-30 状态变体优先：当前场景命中该资产的状态需求（stateRequirements[].sceneIds）
  // 且对应 stateKey 已生成变体图时，摆位用变体而非主参考——乌鸦喝水「瓶水位低→渐升→满」
  // 这类剧情状态由此上场（此前变体生成了却永远不上画布，全场景一张主参考图）。
  const sid = String(sceneId || '').trim()
  if (sid) {
    const reqs = Array.isArray(asset?.stateRequirements) ? asset.stateRequirements : []
    const hitReq = reqs.find((r) => Array.isArray(r?.sceneIds) && r.sceneIds.map((x) => String(x || '').trim()).includes(sid)) || null
    if (hitReq) {
      const stateKey = String(hitReq.stateKey || '').trim()
      const variant = (Array.isArray(asset?.stateVariants) ? asset.stateVariants : [])
        .find((v) => String(v?.stateKey || '').trim() === stateKey && (String(v?.projectAssetId || '').trim() || String(v?.projectAssetUri || '').trim())) || null
      if (variant) {
        const variantAssetId = String(variant.projectAssetId || '').trim()
        if (hasAsset(variantAssetId)) return { imageAssetId: variantAssetId, viaStateKey: stateKey }
        const vUri = String(variant.projectAssetUri || '').trim().replace(/^\/+/, '')
        const byUri = vUri ? assets.find((a) => String(a && a.uri || '').trim().replace(/^\/+/, '') === vUri) : null
        if (byUri) return { imageAssetId: String(byUri.id || '').trim(), viaStateKey: stateKey }
      }
    }
  }

  const uri = String(asset?.primaryReferenceAssetUri || '').trim().replace(/^\/+/, '')
  const primaryId = String(asset?.primaryReferenceAssetId || '').trim()
  if (hasAsset(primaryId)) return { imageAssetId: primaryId }
  if (uri) {
    const byUri = assets.find((a) => String(a && a.uri || '').trim().replace(/^\/+/, '') === uri)
    if (byUri) return { imageAssetId: String(byUri.id || '').trim(), patchedPrimaryId: primaryId ? '' : String(byUri.id || '').trim() }
  }
  const refs = Array.isArray(asset?.generatedRefs) ? asset.generatedRefs : []
  const refHit = refs.find((r) => String(r && r.projectAssetUri || '').trim().replace(/^\/+/, '') === uri && hasAsset(String(r && r.projectAssetId || '').trim()))
  if (refHit) return { imageAssetId: String(refHit.projectAssetId || '').trim(), patchedPrimaryId: primaryId ? '' : String(refHit.projectAssetId || '').trim() }
  if (!uri) return null
  const fileGate = await verifyStoryAssetReferenceFile({ dir, assetPath: uri })
  if (!fileGate.ok) return null
  const created = { id: genId('asset'), kind: 'image', name: `故事资产立绘 ${String(asset?.name || assetId).trim()}`, uri, source: { type: 'ai', via: 'placements_prop_registration' } }
  return { imageAssetId: created.id, createdAsset: created, patchedPrimaryId: created.id }
}

// [拆分] POST /api/projects/:id/ai/story/scenes/placements 已迁至 apps/server/src/routes/storyScenes.routes.js
// ---------------------------------------------------------------------------
// V1.3 工艺库载体变体生成（持物关系的根治）：
// 技能件（carrier 类）的 generation.promptTemplate 填 {characterAnchor}/{propOnTray}/{propAnchor} 等占位，
// 取角色主参考做身份锁定，经既有姿势变体生成链（骨架不必须：空白骨架+低控制强度，提示词驱动）
// 生成绿幕图，走 layered-produce 登记（抠图/评审/计划写回同 GS-51），回写 poseKey=skillId。
// 幂等：该资产已有同 skillId 变体且已登记项目资产时直接返回。进度经 /ai/tasks。
// ---------------------------------------------------------------------------
// 空白骨架（载体变体纯提示词驱动：低控制强度下骨架不主导姿势，仅为满足通道输入）
export const BLANK_SKELETON_PNG_BYTES = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64')
