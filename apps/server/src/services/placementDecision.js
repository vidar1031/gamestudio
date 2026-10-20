// ---------------------------------------------------------------------------
// placementDecision（W2 摆位决策管线化）
// POST /api/projects/:id/ai/story/scenes/placements 的逐场景计算体从
// routes/storyScenes.routes.js 原样迁入（字义未改，求值顺序与原代码完全一致）。
// 纯计算服务：不读写盘、不触网络；index 本地辅助经 deps 注入，域算法引自 ../ai/*。
// 内部按四组规则组织为带名字的决策段，每段命中记录 decisions: [{ rule, detail }] 随结果返回，
// 供台账/日志可观测：
//   决策段 A1       冗余撤除（included_in_character_variant / baked_in_location_anchor）
//   决策段 CARRIER  工艺载体消费（covered_by_carrier / covered_by_carrier_pair）
//   决策段 STATE    剧情状态承载（covered_by_state_variant）
//   决策段 REMOVAL  确定性撤除历史摆位（covered_prop_removal）
// ---------------------------------------------------------------------------
import { genId } from '../ai/scripts.js'
import { logStage } from '../ai/runtime.js'
import { resolveCarrierPlacementPlan } from '../ai/craftLibrary.js'

// deps（index 本地辅助，经 routes ctx 注入）：
//   resolvePropPlacementImageAsset / associatedPropProjectAssetIds / findProjectCharacterForStoryAsset
//   defaultPlacementX / defaultPlacementScale / propPlacementProfile / propPlacementTransform
//   BUCKET_PROP_PATTERN / propAssetSignalText
// input：{ sceneId, node, dir, projectId, traceId, planScenes, planAssets, characterAssets, propAssets,
//          compositionByScene, applyComposition, characters, projectAssets }
//   characters / projectAssets 为跨场景共享可变数组，本函数按原语义原地改（push / 按位替换）。
// 返回：{ nextPlacements, skippedCharacters, skippedProps, placeable, placeableProps,
//         charactersChanged, projectAssetsChanged, newCharacters, newProjectAssets,
//         counts: { created, updated, removed, charactersCreated, charactersUpdated, propsPlaced },
//         characterIdPatches, propAssetIdPatches, decisions }
export async function computeScenePlacements(deps, input) {
  const {
    resolvePropPlacementImageAsset,
    associatedPropProjectAssetIds,
    findProjectCharacterForStoryAsset,
    defaultPlacementX,
    defaultPlacementScale,
    propPlacementProfile,
    BUCKET_PROP_PATTERN,
    propAssetSignalText,
    propPlacementTransform
  } = deps
  const {
    sceneId, node, dir, projectId, traceId,
    planScenes, planAssets, characterAssets, propAssets,
    compositionByScene, applyComposition,
    characters, projectAssets
  } = input

  const decisions = []
  let charactersChanged = false
  let projectAssetsChanged = false
  const characterIdPatches = new Map() // planAssetId → projectCharacterId（新建/补链时写回计划）
  const propAssetIdPatches = new Map() // planAssetId → primaryReferenceAssetId（补登记项目资产时写回计划）
  const skippedCharacters = []
  const skippedProps = []
  let placementsCreated = 0
  let placementsUpdated = 0
  let placementsRemoved = 0
  let charactersCreated = 0
  let charactersUpdated = 0
  let propsPlaced = 0
  let nextPlacements = null

  const assetSceneIds = (asset) => (Array.isArray(asset?.sceneIds) ? asset.sceneIds : []).map((x) => String(x || '').trim())
  const compTransformFor = (sceneId, subjectId) => {
    const item = compositionByScene.get(String(sceneId || '').trim())?.get(String(subjectId || '').trim()) || null
    if (!item) return null
    return {
      transform: {
        x: Math.max(0, Math.min(1, Number(item.x) || 0.5)),
        y: Math.max(0, Math.min(1, Number(item.y) || 0.9)),
        scale: Math.max(0.1, Math.min(2.5, Number(item.scale) || 1)),
        rotationDeg: 0,
        ...(item.flipH === true ? { flipX: true } : {})
      },
      zIndex: Math.max(1, Math.min(99, Math.round(Number(item.zIndex) || 3))),
      stateKey: String(item.stateKey || '').trim()
    }
  }

  // ── 决策段 A1：冗余撤除 ──
  // 2026-10-11 A1 冗余摆位确定性规则（四个故事手工清理同款垃圾的沉淀）：
  // ① 道具已被本场景角色变体穿/含（变体提示词含道具名）→ 跳过（穿着西服又摆一件西服事故）
  // ② 道具已被本场景地点锚点烘进背景（锚点含道具名）→ 跳过（背景有软垫又摆软垫事故）
  const sceneVariantTexts = []
  for (const ca of characterAssets) {
    const pool = [...(Array.isArray(ca.poseVariants) ? ca.poseVariants : []), ...(Array.isArray(ca.stateVariants) ? ca.stateVariants : [])]
    for (const v of pool) {
      const inScene = String(v?.sceneId || '').trim() === sceneId || (Array.isArray(v?.sceneIds) && v.sceneIds.map((x) => String(x || '').trim()).includes(sceneId))
      if (inScene) sceneVariantTexts.push(`${String(v?.name || '')} ${String(v?.posePrompt || '')} ${String(v?.promptEn || '')}`.toLowerCase())
    }
  }
  const scenePlanEntry = (Array.isArray(planScenes) ? planScenes : []).find((s) => String(s && s.sceneId || '').trim() === sceneId)
  const sceneLocAnchors = (Array.isArray(scenePlanEntry?.promptAssets) ? scenePlanEntry.promptAssets : [])
    .filter((pa) => String(pa?.category || '') === 'location')
    .map((pa) => String(pa?.anchorPrompt || '').toLowerCase())
  const isRedundantProp = (propName) => {
    const words = String(propName || '').toLowerCase().split(/[^a-z]+/).filter((w) => w.length >= 4)
    if (!words.length) return null
    const hitIn = (text) => words.every((w) => text.includes(w))
    if (sceneVariantTexts.some(hitIn)) return 'included_in_character_variant'
    if (sceneLocAnchors.some(hitIn)) return 'baked_in_location_anchor'
    return null
  }
  // ── 决策段 CARRIER：工艺载体消费 ──
  // V1.3 工艺库载体消费：构图项带 carrier 类 skillIds 且资产已注册同 skillId 载体变体时——
  // 角色摆位用载体变体；被承载道具不再独立摆位（skip reason='covered_by_carrier'，非阻断语义同
  // included_in_character_variant）；双人载体（replace_both_with_pair）另一端角色不再独立摆位。
  // 无技能件的场景行为零变化。
  const carrierVariantByAssetId = new Map()
  const carrierCoveredPropIds = new Set()
  const carrierPairSkipAssetIds = new Set()
  {
    const compItems = compositionByScene.get(sceneId)
    if (compItems && compItems.size) {
      const presentNow = characterAssets.filter((a) => assetSceneIds(a).includes(sceneId))
      const carrierPlan = resolveCarrierPlacementPlan({ compItems, presentAssets: presentNow })
      carrierPlan.variantByAssetId.forEach((variant, assetId) => carrierVariantByAssetId.set(assetId, variant))
      carrierPlan.coveredPropIds.forEach((propId) => carrierCoveredPropIds.add(propId))
      carrierPlan.pairSkipAssetIds.forEach((assetId) => carrierPairSkipAssetIds.add(assetId))
    }
  }
  // ── 决策段 STATE：剧情状态承载 ──
  // prop 分层合成（2026-09-27 F6）：已锁定（referenceStatus=ready 且有主参考）prop 生成确定性默认摆位；
  // 未锁定或引用不可解析（文件缺失/无法登记项目资产）仍跳过并如实进 skippedProps。
  const stateCoveredPropIds = new Set()
  for (const prop of propAssets.filter((a) => assetSceneIds(a).includes(sceneId))) {
    const reqs = Array.isArray(prop?.stateRequirements) ? prop.stateRequirements : []
    const hitReq = reqs.find((r) => Array.isArray(r?.sceneIds) && r.sceneIds.map((x) => String(x || '').trim()).includes(sceneId)) || null
    const relatedIds = Array.isArray(hitReq?.relatedAssetIds) ? hitReq.relatedAssetIds.map((x) => String(x || '').trim()).filter(Boolean) : []
    if (!hitReq || !relatedIds.length) continue
    const stateKey = String(hitReq.stateKey || '').trim()
    const hasStateVariant = (Array.isArray(prop.stateVariants) ? prop.stateVariants : []).some((v) => (
      String(v?.stateKey || '').trim() === stateKey && (String(v?.projectAssetId || '').trim() || String(v?.projectAssetUri || '').trim())
    ))
    if (hasStateVariant) relatedIds.forEach((rid) => stateCoveredPropIds.add(rid))
  }
  const placeableProps = []
  for (const prop of propAssets.filter((a) => assetSceneIds(a).includes(sceneId))) {
    const assetId = String(prop.id || '').trim()
    const assetName = String(prop.name || assetId).trim()
    // V1.3 载体覆盖分支在 isRedundantProp 之前：被承载道具不再独立摆位
    if (carrierCoveredPropIds.has(assetId)) {
      decisions.push({ rule: 'covered_by_carrier', detail: { sceneId, assetId, name: assetName } })
      skippedProps.push({ sceneId, assetId, name: assetName, reason: 'covered_by_carrier' })
      continue
    }
    if (stateCoveredPropIds.has(assetId)) {
      decisions.push({ rule: 'covered_by_state_variant', detail: { sceneId, assetId, name: assetName } })
      skippedProps.push({ sceneId, assetId, name: assetName, reason: 'covered_by_state_variant' })
      continue
    }
    const redundantReason = isRedundantProp(assetName)
    if (redundantReason) {
      decisions.push({ rule: redundantReason, detail: { sceneId, assetId, name: assetName } })
      skippedProps.push({ sceneId, assetId, name: assetName, reason: redundantReason })
      continue
    }
    const locked = String(prop.referenceStatus || '').trim() === 'ready' && Boolean(String(prop.primaryReferenceAssetUri || '').trim())
    if (!locked) {
      skippedProps.push({ sceneId, assetId, name: assetName, reason: 'prop_reference_missing' })
      continue
    }
    const resolved = await resolvePropPlacementImageAsset({ dir, asset: prop, projectAssets, sceneId })
    if (!resolved) {
      skippedProps.push({ sceneId, assetId, name: assetName, reason: 'prop_reference_missing' })
      continue
    }
    if (resolved.createdAsset) {
      projectAssets.push(resolved.createdAsset)
      projectAssetsChanged = true
    }
    if (resolved.patchedPrimaryId) propAssetIdPatches.set(assetId, resolved.patchedPrimaryId)
    placeableProps.push({ assetId, name: assetName, imageAssetId: resolved.imageAssetId, associatedIds: associatedPropProjectAssetIds(prop), asset: prop })
  }

  const present = characterAssets.filter((a) => assetSceneIds(a).includes(sceneId))
  const placeable = []
  for (const asset of present) {
    const assetId = String(asset.id || '').trim()
    const assetName = String(asset.name || assetId).trim()
    // V1.3 双人载体：载体对另一端角色不再独立摆位（合并在载体对摆位里）
    if (carrierPairSkipAssetIds.has(assetId)) {
      decisions.push({ rule: 'covered_by_carrier_pair', detail: { sceneId, assetId, name: assetName } })
      skippedCharacters.push({ sceneId, assetId, name: assetName, reason: 'covered_by_carrier_pair' })
      continue
    }
    let character = findProjectCharacterForStoryAsset(characters, asset)
    // 立绘 asset id 来源：select 后计划资产的 primaryReferenceAssetId → 角色 ai.referenceAssetId → 角色 imageAssetId
    // 角色主档写回（创建/回填）始终用主参考 id，姿势变体只影响本场景摆位
    const baseImageAssetId =
      String(asset.primaryReferenceAssetId || '').trim() ||
      String(character?.ai?.referenceAssetId || '').trim() ||
      String(character?.imageAssetId || '').trim()
    // 2026-09-30 剧情姿势上场：该场景已生成姿势/状态变体（poseVariants 或 stateVariants 的
    // sceneId/sceneIds 命中）时，本场景摆位用变体图而非主参考——口渴/衔石/喝水随情节表达。
    const variantPool = [
      ...(Array.isArray(asset.poseVariants) ? asset.poseVariants : []),
      ...(Array.isArray(asset.stateVariants) ? asset.stateVariants : [])
    ]
    const poseHit = variantPool
      .filter((v) => {
        if (!String(v?.projectAssetId || '').trim()) return false
        const one = String(v?.sceneId || '').trim()
        if (one && one === sceneId) return true
        const many = Array.isArray(v?.sceneIds) ? v.sceneIds.map((x) => String(x || '').trim()) : []
        return many.includes(sceneId)
      })
      .pop()
    // 2026-10-04 构图 stateKey 优先：需求单指定本场景状态（如 pushing/crushed）时按状态键选变体，
    // 不再仅靠 sceneIds 命中——同一角色多状态在同场景区的正确性由构图规格保证
    const comp = compTransformFor(sceneId, assetId)
    const compStateHit = comp && comp.stateKey
      ? variantPool.find((v) => String(v?.stateKey || '').trim() === comp.stateKey && String(v?.projectAssetId || '').trim()) || null
      : null
    // 2026-10-06 简谱演绎·表情差分：无场景姿势变体时，按本场景剧情表情（poseRequirements[].expression）
    // 匹配命名约定「表情·{expression}」的表情差分变体——立绘情绪随场景切换，零全身姿势重绘成本
    let expressionHit = null
    if (!compStateHit && !poseHit) {
      const reqs = Array.isArray(asset.poseRequirements) ? asset.poseRequirements : []
      const sceneReq = reqs.find((r) => String(r?.sceneId || '').trim() === sceneId)
      const expr = String(sceneReq?.expression || '').trim()
      if (expr) {
        expressionHit = variantPool.find((v) => {
          if (!String(v?.projectAssetId || '').trim()) return false
          const nm = String(v?.name || '').trim()
          return nm === `表情·${expr}` || nm === `表情:${expr}` || nm === expr
        }) || null
      }
    }
    // V1.3 载体变体优先：构图项带 carrier skillIds 且已注册同 skillId 变体时，摆位用载体变体
    const carrierHit = carrierVariantByAssetId.get(assetId) || null
    const imageAssetId = carrierHit
      ? String(carrierHit.projectAssetId || '').trim()
      : (compStateHit
        ? String(compStateHit.projectAssetId || '').trim()
        : (poseHit ? String(poseHit.projectAssetId || '').trim()
          : (expressionHit ? String(expressionHit.projectAssetId || '').trim() : baseImageAssetId)))
    if (!imageAssetId) {
      skippedCharacters.push({ sceneId, assetId, name: assetName, reason: 'reference_not_locked' })
      continue
    }
    if (!character) {
      // 项目缺少该角色条目：按真实计划数据补建最小角色记录，并回写计划链接
      // 2026-08-30 修复：同步补 ai.referenceAssetId——体检的连续性绑定检查依赖它（缺了会报"缺少角色参考图"）
      character = { id: genId('char'), name: assetName, imageAssetId: baseImageAssetId, ai: { referenceAssetId: baseImageAssetId } }
      characters.push(character)
      charactersChanged = true
      charactersCreated += 1
    } else {
      const needsImage = String(character.imageAssetId || '').trim() !== baseImageAssetId
      // 2026-08-30 修复：referenceAssetId 缺失时回填（锁定在角色建立前完成时，select 的写回找不到角色条目）
      const needsRef = !String((character.ai && character.ai.referenceAssetId) || '').trim()
      if (needsImage || needsRef) {
        const idx = characters.findIndex((ch) => String(ch && ch.id || '').trim() === String(character.id || '').trim())
        if (idx >= 0) {
          characters[idx] = {
            ...characters[idx],
            ...(needsImage ? { imageAssetId: baseImageAssetId } : {}),
            ai: {
              ...((characters[idx].ai && typeof characters[idx].ai === 'object') ? characters[idx].ai : {}),
              referenceAssetId: baseImageAssetId
            }
          }
          character = characters[idx]
          charactersChanged = true
          charactersUpdated += 1
        }
      }
    }
    if (!String(asset.projectCharacterId || '').trim()) characterIdPatches.set(assetId, String(character.id || '').trim())
    placeable.push({ assetId, name: assetName, characterId: String(character.id || '').trim(), imageAssetId })
  }

  if (placeable.length || placeableProps.length) {
    const existing = Array.isArray(node.visuals?.placements) ? node.visuals.placements : []
    nextPlacements = existing.map((p) => ({ ...p }))
    // ── 决策段 REMOVAL：确定性撤除历史摆位 ──
    // 2026-10-18 确定性撤除：被状态变体/载体承载的道具（梨已合成进"剩两梨"盘子变体）若残留
    // 历史摆位必须移除——否则盘内梨与盘外独立梨双重影像同屏（孔融让梨场景2实测事故）。
    const coveredPropRemovalIds = new Set([...carrierCoveredPropIds, ...stateCoveredPropIds])
    if (coveredPropRemovalIds.size) {
      for (let i = nextPlacements.length - 1; i >= 0; i--) {
        const p = nextPlacements[i]
        if (!p || String(p.characterId || '').trim()) continue
        const pProp = String(p.propAssetId || '').trim()
        const img = String(p.imageAssetId || '').trim()
        const pa = projectAssets.find((a) => String(a && a.id || '').trim() === img)
        const puri = String(pa && pa.uri || '').trim()
        const hitCovered = [...coveredPropRemovalIds].some((cid) => (
          (pProp && pProp === cid) || (cid && puri && puri.includes(`/${cid}/`))
        ))
        if (hitCovered) {
          nextPlacements.splice(i, 1)
          placementsRemoved += 1
          decisions.push({ rule: 'covered_prop_removal', detail: { sceneId, propAssetId: pProp, imageUri: puri } })
          logStage({ stage: 'story.scenes.placements', event: 'remove_covered_prop', traceId, project: projectId, item: `${sceneId} / ${pProp || puri}` })
        }
      }
    }
    placeable.forEach((entry, index) => {
      const comp = compTransformFor(sceneId, entry.assetId)
      const existingIdx = nextPlacements.findIndex((p) => String(p && p.characterId || '').trim() === entry.characterId)
      if (existingIdx >= 0) {
        // 幂等/人工站位保护：保留既有 transform/zIndex/visible，仅刷新立绘引用；
        // applyComposition=true 时按构图需求单刷新 transform/zIndex（人工编辑器摆位不走本接口）
        const refresh = applyComposition && comp ? { transform: comp.transform, zIndex: comp.zIndex } : {}
        nextPlacements[existingIdx] = { ...nextPlacements[existingIdx], characterId: entry.characterId, imageAssetId: entry.imageAssetId, ...refresh }
        placementsUpdated += 1
      } else {
        const planAsset = planAssets.find((a) => String(a && a.id || '').trim() === entry.assetId)
        nextPlacements.push({
          characterId: entry.characterId,
          imageAssetId: entry.imageAssetId,
          transform: comp ? comp.transform : { x: defaultPlacementX(index, placeable.length), y: 1, scale: defaultPlacementScale(planAsset), rotationDeg: 0 },
          zIndex: comp ? comp.zIndex : index + 1,
          visible: true
        })
        placementsCreated += 1
      }
    })

    // prop 摆位写入（characterId 置空 + imageAssetId + propAssetId 链接，与编辑器手工拖入的道具摆位同构；
    // 编辑器预览与 storyPixi 导出均按 p.imageAssetId || ch.imageAssetId 解析，运行态无需扩展）
    if (placeableProps.length) {
      const isEndingScene = String(node.kind || '').trim() === 'ending'
      const characterXs = nextPlacements
        .filter((p) => String(p && p.characterId || '').trim())
        .map((p) => Number(p && p.transform && p.transform.x))
        .filter((x) => Number.isFinite(x))
      // 已摆道具（含人工摆位）信号池：供 fish_near_bucket 确定性找桶
      const placedPropSignals = []
      for (const p of nextPlacements) {
        if (String(p && p.characterId || '').trim()) continue
        const img = String(p && p.imageAssetId || '').trim()
        const pa = projectAssets.find((a) => String(a && a.id || '').trim() === img)
        const signal = [pa && pa.name, pa && pa.uri].map((x) => String(x || '')).join(' ')
        if (signal.trim()) placedPropSignals.push({ signal, transform: (p && p.transform && typeof p.transform === 'object') ? p.transform : {} })
      }
      // 结局场景的鱼最后放，保证桶位姿已确定
      const orderedProps = placeableProps.slice().sort((a, b) => {
        const pa = propPlacementProfile(a.asset, { isEndingScene }) === 'fish_near_bucket' ? 1 : 0
        const pb = propPlacementProfile(b.asset, { isEndingScene }) === 'fish_near_bucket' ? 1 : 0
        return pa - pb
      })
      let propIndex = 0
      for (const entry of orderedProps) {
        const existingIdx = nextPlacements.findIndex((p) => {
          if (!p || typeof p !== 'object') return false
          if (String(p.propAssetId || '').trim() && String(p.propAssetId || '').trim() === entry.assetId) return true
          if (String(p.characterId || '').trim()) return false
          const img = String(p.imageAssetId || '').trim()
          if (img && entry.associatedIds.has(img)) return true
          // 人工摆位归队：摆位图片资产 uri 含计划资产 id 路径段（如 /prop.tool_bag/），确定性子串匹配
          const pa = projectAssets.find((a) => String(a && a.id || '').trim() === img)
          const puri = String(pa && pa.uri || '').trim()
          return Boolean(puri && entry.assetId && puri.includes(`/${entry.assetId}/`))
        })
        if (existingIdx >= 0) {
          // 幂等/人工站位保护：保留既有 transform/zIndex/visible，仅刷新立绘引用与 propAssetId 链接；
          // applyComposition=true 时按构图需求单刷新 transform/zIndex
          const comp = compTransformFor(sceneId, entry.assetId)
          const refresh = applyComposition && comp ? { transform: comp.transform, zIndex: comp.zIndex } : {}
          nextPlacements[existingIdx] = { ...nextPlacements[existingIdx], characterId: '', propAssetId: entry.assetId, imageAssetId: entry.imageAssetId, ...refresh }
          placedPropSignals.push({ signal: propAssetSignalText(entry.asset), transform: (nextPlacements[existingIdx].transform && typeof nextPlacements[existingIdx].transform === 'object') ? nextPlacements[existingIdx].transform : {} })
          placementsUpdated += 1
          continue
        }
        let profile = propPlacementProfile(entry.asset, { isEndingScene })
        let bucketTransform = null
        if (profile === 'fish_near_bucket') {
          const hit = placedPropSignals.find((x) => BUCKET_PROP_PATTERN.test(x.signal))
          if (hit) bucketTransform = hit.transform
          else profile = 'ground' // 找不到桶：退化为地面道具默认位
        }
        // 2026-10-04 构图规格优先：需求单指定了道具位置/大小/前后关系时按需求单摆放
        const comp = compTransformFor(sceneId, entry.assetId)
        const transform = comp ? comp.transform : propPlacementTransform({ profile, index: propIndex, characterXs, bucketTransform })
        const zBase = nextPlacements.reduce((acc, p) => Math.max(acc, Number(p && p.zIndex) || 0), 0)
        nextPlacements.push({
          id: `pl_${sceneId}_${entry.assetId}`,
          characterId: '',
          propAssetId: entry.assetId,
          imageAssetId: entry.imageAssetId,
          transform,
          zIndex: comp ? comp.zIndex : zBase + 1,
          visible: true
        })
        placedPropSignals.push({ signal: propAssetSignalText(entry.asset), transform })
        propIndex += 1
        placementsCreated += 1
        propsPlaced += 1
      }
    }
  }

  return {
    nextPlacements,
    skippedCharacters,
    skippedProps,
    placeable,
    placeableProps,
    charactersChanged,
    projectAssetsChanged,
    newCharacters: characters,
    newProjectAssets: projectAssets,
    counts: {
      created: placementsCreated,
      updated: placementsUpdated,
      removed: placementsRemoved,
      charactersCreated,
      charactersUpdated,
      propsPlaced
    },
    characterIdPatches,
    propAssetIdPatches,
    decisions
  }
}
