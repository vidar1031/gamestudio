// 预演编排共享派生（G 波 2026-10-26）：渲染（PrevizPlayer）与保存装配（BlueprintStudio 逐幕写回）同源——
// 修"切幕竞态/跨幕串味"的根：非当前幕没有渲染快照，保存装配必须能不依赖渲染派生任意幕的全量编排。
// 纯函数：全部输入显式传入（含该幕 placements/overrides/subDrafts），不读全局。
import type { StoryAssetPlan } from '../../api'
import { computeElementMarks, elementGroupLabel } from './readiness'

/** 单块归一化编排值（x=块中心横向 0..1；y=块底边自上 0..1，与 placements transform.y 同语义；scale≈宽/40%；
 *  flipX/flipY=朝向（与合成层同语义）；stateKey=姿态/状态（锁定链变体选择键）；
 *  imageAssetId=占位预览图显式选择（项目资产 id：主参考或某锁定变体；2026-11-01 预演占位图预览）） */
export type PrevizLayoutValue = { x: number; y: number; scale: number; flipX?: boolean; flipY?: boolean; stateKey?: string; imageAssetId?: string }
/** 编排覆盖（按幕切片后下发 PrevizPlayer） */
export type PrevizLayoutOverrides = Record<string, PrevizLayoutValue>
/** 块现状快照（右栏属性显示/编辑/保存装配用；parentAssetId 非空=子元素块） */
export type PrevizBlockInfo = PrevizLayoutValue & { assetId: string; name: string; group: string; zIndex: number; unready: boolean; parentAssetId?: string }
/** F 波：组=对象种类——背景组（主背景+环境+背景子元素）/角色组/道具组 */
export type PrevizGroupScope = '背景' | '角色' | '道具'
export function previzGroupScopeOf(group: string): PrevizGroupScope {
  if (group === '背景' || group === '环境') return '背景'
  if (group === '角色') return '角色'
  return '道具'
}

/** 归一化编排块（渲染层自行转 CSS left/bottom/width） */
export type PrevizLayoutBlock = {
  assetId: string
  label: string
  group: '背景' | '角色' | '道具' | '其他' | '环境'
  draggable: boolean
  zIndex: number
  unready: boolean
  nx: number
  ny: number
  nscale: number
  flipX: boolean
  flipY: boolean
  stateKey: string
  imageAssetId: string
  parentAssetId?: string
}

export const scaleToWidth = (s: number) => Math.max(10, Math.min(46, s * 40))
export const widthToScale = (w: number) => w / 40

export type DeriveSceneLayoutInput = {
  nodeId: string
  nodes: { id: string; name?: string }[]
  plan: StoryAssetPlan | null
  /** 该幕 story.json 既有 placements（无 story 时传 []） */
  placements: any[]
  /** 本幕新建未落盘子元素注册表 */
  subDrafts: Record<string, { parentAssetId: string; subName: string }>
  /** 本幕编排覆盖 */
  overrides: PrevizLayoutOverrides
}

/** 派生一幕的全量编排块（读序：编排覆盖 > 需求单草稿 > story placements > 确定性默认槽位；子元素并集草稿+注册表） */
export function deriveSceneLayout(input: DeriveSceneLayoutInput): PrevizLayoutBlock[] {
  const { nodeId, nodes, plan, placements, subDrafts, overrides } = input
  const marksByNode = computeElementMarks(plan, nodes, { requireAnalyzed: false }).byNode
  const marks = marksByNode.get(nodeId) || []
  const assetByName = new Map<string, any>()
  for (const a of Array.isArray(plan?.assets) ? (plan!.assets as any[]) : []) {
    assetByName.set(String(a?.name || ''), a)
  }
  // 本幕需求单草稿（plan.scenes[].composition；D1 起编排落盘点，source=previz/ai 同构消费）
  const scenes = Array.isArray(plan?.scenes) ? (plan!.scenes as any[]) : []
  const sc = scenes.find((s) => String(s?.sceneId || '') === String(nodeId))
  const draftItems = Array.isArray(sc?.composition?.items) ? sc.composition.items : []
  const draftBySubject = new Map<string, any>()
  for (const it of draftItems) draftBySubject.set(String(it?.subjectId || ''), it)

  const backgrounds = marks.filter((m) => elementGroupLabel(m.category) === '背景')
  const characters = marks.filter((m) => elementGroupLabel(m.category) === '角色')
  const propMarks = marks.filter((m) => elementGroupLabel(m.category) === '道具')
  const others = marks.filter((m) => elementGroupLabel(m.category) === '其他')
  // 2026-11-06 背景元素（scenery）：独立成块，永不占主背景位（主背景只从 location/背景族取第一个）
  const sceneryMarks = marks.filter((m) => elementGroupLabel(m.category) === '环境')

  const out: PrevizLayoutBlock[] = []
  // 一幕只有一个主背景（满框）；多出的背景类元素=环境块
  const extraBgs: typeof marks = []
  backgrounds.forEach((m, i) => {
    if (i > 0) {
      extraBgs.push(m)
      return
    }
    const bd = draftBySubject.get(m.id)
    out.push({
      assetId: m.id,
      label: m.name,
      group: '背景',
      draggable: false,
      zIndex: i,
      unready: m.state === 'marked',
      nx: 0.5,
      ny: 1,
      nscale: 1,
      flipX: bd ? bd.flipX === true || bd.flipH === true : false,
      flipY: bd ? bd.flipY === true : false,
      stateKey: bd ? String(bd.stateKey || '').trim() : '',
      imageAssetId: bd ? String(bd.imageAssetId || '').trim() : ''
    })
  })
  const placementFor = (m: (typeof marks)[number]) => {
    const a = assetByName.get(m.name)
    if (!a) return null
    const charId = String(a?.projectCharacterId || '')
    const refId = String(a?.primaryReferenceAssetId || '')
    return placements.find((p: any) => (charId && String(p?.characterId || '') === charId) || (refId && String(p?.imageAssetId || '') === refId)) || null
  }
  const placeBlock = (m: (typeof marks)[number], i: number, n: number, group: '角色' | '道具' | '其他' | '环境', defaultY: number, baseWidth: number) => {
    const unready = m.state === 'marked'
    let nx = (i + 1) / (n + 1)
    let ny = 1 - defaultY
    let nscale = widthToScale(baseWidth)
    let zIndex = group === '角色' ? 3 : 2
    let flipX = false
    let flipY = false
    let stateKey = ''
    let imageAssetId = ''
    const pl = placementFor(m)
    const t = pl?.transform
    if (t && Number.isFinite(Number(t.x)) && Number.isFinite(Number(t.y))) {
      nx = Math.max(0, Math.min(1, Number(t.x)))
      ny = Math.max(0, Math.min(1, Number(t.y)))
      nscale = Number.isFinite(Number(t.scale)) ? Number(t.scale) : 0.5
      zIndex = Number(pl?.zIndex) || 3
      flipX = t.flipX === true
      flipY = (t as any).flipY === true
    }
    const draft = draftBySubject.get(m.id)
    if (draft && Number.isFinite(Number(draft.x)) && Number.isFinite(Number(draft.y))) {
      nx = Math.max(0, Math.min(1, Number(draft.x)))
      ny = Math.max(0, Math.min(1, Number(draft.y)))
      nscale = Number.isFinite(Number(draft.scale)) ? Number(draft.scale) : nscale
      zIndex = Number.isFinite(Number(draft.zIndex)) ? Number(draft.zIndex) : zIndex
      flipX = draft.flipX === true || draft.flipH === true
      flipY = draft.flipY === true
      stateKey = String(draft.stateKey || '').trim()
      imageAssetId = String(draft.imageAssetId || '').trim()
    }
    const ov = overrides[m.id]
    if (ov) {
      nx = ov.x
      ny = ov.y
      nscale = ov.scale
      if (ov.flipX !== undefined) flipX = ov.flipX
      if (ov.flipY !== undefined) flipY = ov.flipY
      if (ov.stateKey !== undefined) stateKey = ov.stateKey
      if (ov.imageAssetId !== undefined) imageAssetId = String(ov.imageAssetId || '').trim()
    }
    out.push({
      assetId: m.id,
      label: m.name,
      group,
      draggable: true,
      zIndex,
      unready,
      nx,
      ny,
      nscale,
      flipX,
      flipY,
      stateKey,
      imageAssetId
    })
  }
  characters.forEach((m, i) => placeBlock(m, i, characters.length, '角色', 0.14, 18))
  extraBgs.forEach((m, i) => placeBlock(m, i, extraBgs.length, '环境', 0.62, 14))
  // 背景元素贴地面（defaultY 0.18 → 块底贴近画框下部），默认占宽 22%（地形块/材料堆比手持道具大）
  sceneryMarks.forEach((m, i) => placeBlock(m, i, sceneryMarks.length, '环境', 0.18, 22))
  propMarks.forEach((m, i) => placeBlock(m, i, propMarks.length, '道具', 0.42, 12))
  others.forEach((m, i) => placeBlock(m, i, others.length, '其他', 0.42, 12))

  // 子元素块（草稿带 parentAssetId 项 ∪ 未落盘注册表；组随父元素；父不在本幕则不出块）
  const subEntries: Array<{ sid: string; parentAssetId: string; subName: string; src: any }> = []
  for (const [subjectId, it] of draftBySubject) {
    const parentAssetId = String(it?.parentAssetId || '').trim()
    const subName = String(it?.subName || '').trim()
    if (parentAssetId && subName) subEntries.push({ sid: subjectId, parentAssetId, subName, src: it })
  }
  for (const [sid, r] of Object.entries(subDrafts || {})) {
    if (!subEntries.some((e) => e.sid === sid)) subEntries.push({ sid, parentAssetId: r.parentAssetId, subName: r.subName, src: {} })
  }
  for (const { sid, parentAssetId, subName, src } of subEntries) {
    if (out.some((b) => b.assetId === sid)) continue
    const parent = out.find((b) => b.assetId === parentAssetId)
    if (!parent) continue
    const ov = overrides[sid]
    out.push({
      assetId: sid,
      label: subName,
      group: parent.group,
      draggable: true,
      zIndex: (parent.zIndex ?? 2) + 1,
      unready: false,
      nx: Math.max(0, Math.min(1, Number(ov?.x ?? src.x ?? 0.5))),
      ny: Math.max(0, Math.min(1, Number(ov?.y ?? src.y ?? 0.6))),
      nscale: Number.isFinite(Number(ov?.scale ?? src.scale)) ? Number(ov?.scale ?? src.scale) : 0.2,
      flipX: ov?.flipX ?? (src.flipX === true || src.flipH === true),
      flipY: ov?.flipY ?? src.flipY === true,
      stateKey: String(ov?.stateKey ?? src.stateKey ?? ''),
      imageAssetId: '',
      parentAssetId
    })
  }
  return out
}

/** 占位块预览图解析（2026-11-01）：显式 imageAssetId（主参考/锁定变体的项目资产 id）优先，
 * 回退 stateKey 对应变体，再回退主参考；子元素无资产不接图。返回项目内相对/绝对 uri（调用方转 URL）。
 * 2026-11-02 主背景块额外回退：该幕已绑定场景背景（story.visuals.backgroundAssetId 对应项目资产 uri）——
 * 地点类资产不出立绘，其主参考为空，预演主背景应以已绑定成品背景呈现。 */
export function resolvePrevizBlockImageUri(
  plan: StoryAssetPlan | null,
  block: { assetId: string; stateKey: string; imageAssetId: string; parentAssetId?: string; group?: string },
  sceneBoundUri = ''
): string {
  if (block.parentAssetId) return ''
  const a = (Array.isArray(plan?.assets) ? (plan!.assets as any[]) : []).find((x) => String(x?.id || '') === String(block.assetId || ''))
  if (!a) return ''
  const primaryId = String(a?.primaryReferenceAssetId || '').trim()
  const primaryUri = String(a?.primaryReferenceAssetUri || '').trim()
  const pool = [...(Array.isArray(a?.poseVariants) ? a.poseVariants : []), ...(Array.isArray(a?.stateVariants) ? a.stateVariants : [])]
  const uriOf = (v: any) => String(v?.projectAssetUri || v?.cutoutPath || '').trim()
  const imageAssetId = String(block.imageAssetId || '').trim()
  if (imageAssetId) {
    if (primaryId && imageAssetId === primaryId && primaryUri) return primaryUri
    const hit = pool.find((v: any) => String(v?.projectAssetId || '').trim() === imageAssetId && uriOf(v))
    if (hit) return uriOf(hit)
    // 未命中（资产已改/变体被删）：向下回退 stateKey/主参考，占位不裸奔
  }
  // 主背景块：该幕已绑定场景背景优先于姿态变体/空主参考
  if (block.group === '背景' && sceneBoundUri) return sceneBoundUri
  const stateKey = String(block.stateKey || '').trim()
  if (stateKey) {
    const v = pool.find((x: any) => String(x?.stateKey || '').trim() === stateKey && uriOf(x))
    if (v) return uriOf(v)
  }
  return primaryUri
}

/** 保存装配：派生块 → composition-draft items（主背景满框不进；子元素带 parentAssetId/subName；excludeIds=暂存剔除；
 * imageAssetId 恒下发——空串=清除显式预览图选择，服务端按 subjectId 合并时覆盖旧值） */
export function layoutToCompositionItems(blocks: PrevizLayoutBlock[], excludeIds?: Set<string>) {
  return blocks
    .filter((b) => (b.group !== '背景' || Boolean(b.parentAssetId)) && !(excludeIds && excludeIds.has(b.assetId)))
    .map((b) => ({
      subjectId: b.assetId,
      x: b.nx,
      y: b.ny,
      scale: b.nscale,
      zIndex: b.zIndex,
      flipX: b.flipX,
      flipY: b.flipY,
      stateKey: b.stateKey,
      imageAssetId: b.imageAssetId || '',
      ...(b.parentAssetId ? { parentAssetId: b.parentAssetId, subName: b.label } : {})
    }))
}
