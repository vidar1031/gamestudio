// 可交互占位预演（蓝图工作室 §4.2）。
// C1（2026-10-21）：蓝图唯一演示形态；三段同屏（上占位画框/中幕名+文本/下选择按钮组）。
// D1（2026-10-25 用户裁决）：中栏第三视图内嵌（左右栏同屏不割裂）；占位块可拖动编排。
// G 波（2026-10-26 用户裁决）：编排改「脏→保存」语义——拖动/编辑只进暂存置脏（onDragBlock/onDragCommit 由父级接管），
// 点顶栏「保存」逐幕落盘构图需求单草稿（plan.scenes[].composition，source=previz）；块派生走共享模块 previzLayout.ts
//（渲染与保存装配同源，修切幕竞态/跨幕串味）。
// 块位读序：父级编排覆盖（拖动/右栏数值）> 需求单草稿 > story.json 既有 placements > 确定性默认槽位。
// 只读运行结构（不写 blueprint/story 真相源）；走完任一幕结局即记预演完成（onPrevizDone 写 bp.previz.<pid> 标记）。
import { useEffect, useMemo, useRef, useState } from 'react'
import type { BlueprintDocV1, BlueprintNodeV1, ScriptDocV1, StoryAssetPlan } from '../../api'
import { applyStoryCompositionPlacements, runStoryCompositionAi } from '../../api'
import { deriveSceneLayout, previzGroupScopeOf, resolvePrevizBlockImageUri, scaleToWidth, type PrevizBlockInfo, type PrevizGroupScope, type PrevizLayoutOverrides, type PrevizLayoutValue } from './previzLayout'
import { toProjectAssetUrl } from '../../components/pose/assetUrl'

// 类型与组归属从共享派生模块 re-export（G 波：渲染与保存装配同源；既有调用处 import 路径不变）
export { previzGroupScopeOf } from './previzLayout'
export type { PrevizBlockInfo, PrevizGroupScope, PrevizLayoutOverrides, PrevizLayoutValue } from './previzLayout'

type Props = {
  projectId: string
  blueprint: BlueprintDocV1
  nodes: BlueprintNodeV1[]
  scriptCards: ScriptDocV1['cards']
  assetPlan: StoryAssetPlan | null
  project: any // getProject 包裹 { project, story }
  sceneId: string // 父级持有的当前幕（切幕受控）
  onSceneChange: (nodeId: string) => void
  layoutOverrides: PrevizLayoutOverrides
  onDragBlock: (assetId: string, v: PrevizLayoutValue) => void
  onDragCommit: () => void
  onBlocksChange: (nodeId: string, blocks: PrevizBlockInfo[]) => void
  selectedAssetId: string | null
  onSelectElement: (nodeId: string, assetId: string) => void
  onSelectScene: (nodeId: string) => void
  onFocusSceneText: (nodeId: string) => void // A 波：点文本区 → 回场景属性并聚焦文本草稿
  onPrevizDone: () => void
  onChanged: () => void // 构图写回后父级重拉
  // F 波：组编辑受控（双击块进该块所属组；null=退出）；右栏组管理面板据此联动
  groupEditGroup: PrevizGroupScope | null
  onGroupEditChange: (g: PrevizGroupScope | null) => void
  // F 波：本幕新建未落盘的子元素注册表（拆分即时出块，不等落盘回读；落盘后 draft 同 id 接管去重）
  subDrafts: Record<string, { parentAssetId: string; subName: string }>
  // G 波：当前幕有未保存编排（脏→保存语义；工具条亮黄字）
  dirtyScene: boolean
}

type PrevizBlock = {
  key: string
  assetId: string
  label: string
  group: '背景' | '角色' | '道具' | '其他' | '环境'
  draggable: boolean
  left: string
  bottom: string
  width: string
  zIndex: number
  unready: boolean
  nx: number
  ny: number
  nscale: number
  flipX: boolean
  flipY: boolean
  stateKey: string
  imageAssetId: string
  imageSrc: string
  parentAssetId?: string // F 波：非空=子元素块
}

function nodeTitle(n: BlueprintNodeV1, scriptCards: ScriptDocV1['cards']) {
  if (n.kind === 'ending') return n.name || n.id
  const sc = (scriptCards || []).find((c) => c.id === (n as any).scriptCardId)
  return sc ? `#${sc.order} ${sc.name || sc.id}` : n.name || n.id
}


export default function PrevizPlayer(props: Props) {
  const nodes = props.nodes || []
  const startId = String(props.blueprint.startNodeId || '')

  const node = useMemo(() => nodes.find((n) => n.id === props.sceneId) || nodes[0] || null, [nodes, props.sceneId])
  const idx = node ? nodes.findIndex((n) => n.id === node.id) : 0
  const [playing, setPlaying] = useState(false)
  const [compBusy, setCompBusy] = useState(false)
  const [compErr, setCompErr] = useState('')
  const [compNote, setCompNote] = useState('')
  // 2026-11-10 修复（用户实测：环境块无法放大图片）：环境/其他块无 aspect-ratio 定高，
  // 高度塌成标签条（img 绝对定位 out-of-flow 不撑高）——按图片天然宽高比撑块，缩放才会带着图片走
  const [imgAspects, setImgAspects] = useState<Record<string, number>>({})

  const noteImgAspect = (key: string, img: HTMLImageElement) => {
    const w = img.naturalWidth
    const h = img.naturalHeight
    if (!w || !h) return
    const ratio = w / h
    setImgAspects((prev) => (Math.abs((prev[key] || 0) - ratio) < 0.001 ? prev : { ...prev, [key]: ratio }))
  }
  // F 波：组编辑态提升受控（双击块进该块所属组：背景组/角色组/道具组；E 波「双击只进背景组」已纠正）
  const groupEdit = props.groupEditGroup !== null
  const groupEditGroup = props.groupEditGroup
  const frameRef = useRef<HTMLDivElement | null>(null)

  const gotoIdx = (i: number) => {
    const t = nodes[Math.max(0, Math.min(nodes.length - 1, i))]
    if (t) props.onSceneChange(t.id)
  }

  // 自动播放（约 2.5s/幕，播完即停）
  useEffect(() => {
    if (!playing) return
    const t = window.setInterval(() => {
      const i = nodes.findIndex((n) => n.id === (node?.id || ''))
      if (i >= nodes.length - 1) {
        setPlaying(false)
        return
      }
      gotoIdx(i + 1)
    }, 2500)
    return () => window.clearInterval(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing, nodes, node?.id])

  // 预演出块：元素归属不受「已分析才出徽标」口径限制（占位块=演示数据，未分析场景如实空态由 empty 提示承接）
  const storyNode = useMemo(() => {
    const nodes0 = Array.isArray(props.project?.story?.nodes) ? (props.project.story.nodes as any[]) : []
    return nodes0.find((x) => String(x?.id || '') === String(node?.id || '')) || null
  }, [props.project, node])

  const placements = useMemo(() => (Array.isArray(storyNode?.visuals?.placements) ? storyNode.visuals.placements : []), [storyNode])
  const hasStory = Boolean(Array.isArray(props.project?.story?.nodes) && props.project.story.nodes.length)
  const canCompose = hasStory && Boolean(props.assetPlan)

  // 2026-11-02 该幕已绑定场景背景：story.visuals.backgroundAssetId → 项目资产 uri
  // （地点类资产不出立绘、主参考为空；预演主背景应以已绑定成品背景呈现，供用户确认）
  const sceneBoundBgUri = useMemo(() => {
    const bgId = String(storyNode?.visuals?.backgroundAssetId || '').trim()
    if (!bgId) return ''
    const assets = Array.isArray(props.project?.project?.assets) ? props.project.project.assets : []
    const hit = assets.find((a: any) => String(a?.id || '') === bgId) || null
    return String(hit?.uri || hit?.assetPath || '').trim()
  }, [storyNode, props.project?.project?.assets])

  const stage = props.project?.project?.stage
  const frameW = Number(stage?.width) > 0 ? Number(stage.width) : 720
  const frameH = Number(stage?.height) > 0 ? Number(stage.height) : 1280
  // 三段同屏硬约束：画框高 ≤50vh（宽 = 50vh × 真实比例，横屏故事再由容器宽收敛），文本/选择组不挤出首屏
  const frameRatio = frameW / frameH

  // G 波：块派生走共享模块（与保存装配同源——修"切幕竞态/跨幕串味"的根：任意幕可不依赖渲染派生全量编排）
  const blocks = useMemo((): PrevizBlock[] => {
    if (!node) return []
    return deriveSceneLayout({
      nodeId: node.id,
      nodes,
      plan: props.assetPlan,
      placements,
      subDrafts: props.subDrafts || {},
      overrides: props.layoutOverrides
    }).map((b) => {
      const w = b.group === '背景' ? 100 : b.parentAssetId ? Math.max(6, Math.min(20, b.nscale * 40 * 0.55)) : scaleToWidth(b.nscale)
      // 2026-11-01 占位预览图：显式 imageAssetId > stateKey 变体 > 主参考（子元素无资产不接图）
      const imageUri = resolvePrevizBlockImageUri(props.assetPlan, { ...b, group: b.group }, sceneBoundBgUri)
      return {
        key: `${b.parentAssetId ? 'sub' : b.group}_${b.assetId}`,
        assetId: b.assetId,
        label: b.label,
        group: b.group,
        draggable: b.draggable,
        left: b.group === '背景' ? '0%' : `calc(${b.nx * 100}% - ${w / 2}%)`,
        bottom: b.group === '背景' ? '0%' : `${(1 - b.ny) * 100}%`,
        width: `${w}%`,
        zIndex: b.zIndex,
        unready: b.unready,
        nx: b.nx,
        ny: b.ny,
        nscale: b.nscale,
        flipX: b.flipX,
        flipY: b.flipY,
        stateKey: b.stateKey,
        imageAssetId: b.imageAssetId,
        imageSrc: imageUri ? toProjectAssetUrl(props.projectId, imageUri) : '',
        parentAssetId: b.parentAssetId
      }
    })
  }, [node, nodes, placements, props.layoutOverrides, props.assetPlan, props.subDrafts, props.projectId])


  // 渲染后上报块现状快照（右栏属性显示/数值编辑用；E 波含朝向/姿态，F 波含子元素 parentAssetId，2026-11-01 含预览图 imageAssetId）
  useEffect(() => {
    if (!node) return
    props.onBlocksChange(
      node.id,
      blocks.map((b) => ({ assetId: b.assetId, name: b.label, group: b.group, x: b.nx, y: b.ny, scale: b.nscale, flipX: b.flipX, flipY: b.flipY, stateKey: b.stateKey, imageAssetId: b.imageAssetId, zIndex: b.zIndex, unready: b.unready, parentAssetId: b.parentAssetId }))
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [node?.id, blocks])

  // 走完任一幕结局即记预演完成（原弹窗退出写标记的语义内嵌化）
  const isEnding = node?.kind === 'ending'
  useEffect(() => {
    if (isEnding) props.onPrevizDone()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isEnding])

  async function runCompositionLayout() {
    if (compBusy) return
    setCompBusy(true)
    setCompErr('')
    setCompNote('')
    try {
      // 既有链路：构图需求单（persist 写 plan.scenes[].composition）→ 摆位按需求单刷新（applyComposition 幂等写 story placements）
      await runStoryCompositionAi(props.projectId, { persist: true })
      await applyStoryCompositionPlacements(props.projectId, { applyComposition: true })
      setCompNote('构图预排已应用：占位块已按需求单重排')
      props.onChanged()
    } catch (e) {
      setCompErr(e instanceof Error ? e.message : String(e))
    } finally {
      setCompBusy(false)
    }
  }

  // D1 拖动编排：位移阈值 4px 防误触点选；超阈值进入拖动（实时上报覆盖值），抬起提交写回
  function onBlockPointerDown(e: React.PointerEvent, b: PrevizBlock) {
    e.stopPropagation()
    if (!b.draggable) {
      props.onSelectElement(node!.id, b.assetId)
      return
    }
    const frame = frameRef.current
    const rect = frame?.getBoundingClientRect()
    const startX = e.clientX
    const startY = e.clientY
    const origin = { x: b.nx, y: b.ny, scale: b.nscale, flipX: b.flipX, flipY: b.flipY, stateKey: b.stateKey }
    let moved = false
    const target = e.currentTarget as HTMLElement
    try {
      target.setPointerCapture(e.pointerId)
    } catch {}
    let lastNx = origin.x
    let lastNy = origin.y
    const onMove = (ev: PointerEvent) => {
      const dx = ev.clientX - startX
      const dy = ev.clientY - startY
      if (!moved && Math.hypot(dx, dy) < 4) return
      moved = true
      if (!rect || rect.width <= 0 || rect.height <= 0) return
      const nx = Math.max(0, Math.min(1, origin.x + dx / rect.width))
      const ny = Math.max(0, Math.min(1, origin.y + dy / rect.height))
      lastNx = nx
      lastNy = ny
      props.onDragBlock(b.assetId, { x: nx, y: ny, scale: origin.scale, flipX: origin.flipX, flipY: origin.flipY, stateKey: origin.stateKey })
    }
    const onUp = () => {
      target.removeEventListener('pointermove', onMove)
      target.removeEventListener('pointerup', onUp)
      target.removeEventListener('pointercancel', onUp)
      if (moved) {
        // 2026-10-26 用户指令：背景组编辑模式下松手吸附九宫格（上中下=远中近 × 左中右，格心 1/6|1/2|5/6）
        if (groupEdit) {
          const snap = (v: number) => (v < 1 / 3 ? 1 / 6 : v < 2 / 3 ? 1 / 2 : 5 / 6)
          props.onDragBlock(b.assetId, { x: snap(lastNx), y: snap(lastNy), scale: origin.scale, flipX: origin.flipX, flipY: origin.flipY, stateKey: origin.stateKey })
          // 吸附值先落父级 state，下一拍再提交（提交读 ref，立即提交会写入吸附前旧值——实测踩坑）
          window.setTimeout(() => props.onDragCommit(), 0)
        } else {
          props.onDragCommit()
        }
      } else {
        props.onSelectElement(node!.id, b.assetId)
      }
    }
    target.addEventListener('pointermove', onMove)
    target.addEventListener('pointerup', onUp)
    target.addEventListener('pointercancel', onUp)
  }

  // 2026-11-10（用户实测：背景元素太小且无法放大）：组编辑内块右下角缩放手柄——
  // 拖拽改 scale（实时覆盖值），松手提交（与拖动同源的脏→保存链，顶栏「保存」落盘需求单草稿）。
  function onBlockResizeStart(e: React.PointerEvent, b: PrevizBlock) {
    e.stopPropagation()
    e.preventDefault()
    const frame = frameRef.current
    const rect = frame?.getBoundingClientRect()
    if (!rect || rect.width <= 0) return
    const startX = e.clientX
    const origin = { x: b.nx, y: b.ny, scale: b.nscale, flipX: b.flipX, flipY: b.flipY, stateKey: b.stateKey }
    const target = e.currentTarget as HTMLElement
    try {
      target.setPointerCapture(e.pointerId)
    } catch {}
    let lastScale = origin.scale
    const onMove = (ev: PointerEvent) => {
      const dx = ev.clientX - startX
      // 块宽% = scale×40（scaleToWidth 同源）：dx 像素 → 宽% 增量 → scale 增量（×100/40 = ×2.5），与摆位 clamp 同口径
      const next = Math.max(0.1, Math.min(2.5, origin.scale + (dx / rect.width) * 2.5))
      lastScale = next
      props.onDragBlock(b.assetId, { x: origin.x, y: origin.y, scale: next, flipX: origin.flipX, flipY: origin.flipY, stateKey: origin.stateKey })
    }
    const onUp = () => {
      target.removeEventListener('pointermove', onMove)
      target.removeEventListener('pointerup', onUp)
      target.removeEventListener('pointercancel', onUp)
      if (Math.abs(lastScale - origin.scale) > 0.005) {
        // 缩放值先落父级 state，下一拍再提交（与吸附提交同款竞态规避）
        window.setTimeout(() => props.onDragCommit(), 0)
      }
    }
    target.addEventListener('pointermove', onMove)
    target.addEventListener('pointerup', onUp)
    target.addEventListener('pointercancel', onUp)
  }

  const choices = node && !isEnding ? node.choices || [] : []

  return (
    <div
      className="bp-previz-embed"
      aria-label="占位预演"
      onPointerDown={(e) => {
        // A 波：点画框外空白区（预演中栏 padding 区）→ 右栏回场景属性
        const t = e.target as HTMLElement
        if (t.closest('.bp-previz-block, .bp-previz-frame, .bp-previz-storyline, .bp-playtest-choices, .bp-playtest-actions, button, input, select, textarea, a')) return
        if (node) props.onSelectScene(node.id)
      }}
    >
      {/* 上：幕序条（翻页/自动播放/AI 构图预排原位保留；退出语义=切回其他视图，不再单设按钮） */}
      <div className="bp-previz-toolbar">
        <div className="bp-previz-toolbar-title">占位预演</div>
        {props.dirtyScene ? (
          <span className="hint" style={{ color: '#fde68a' }}>编排未保存 · 点顶栏「保存」落盘</span>
        ) : null}
        <div className="hint">第 {nodes.length ? idx + 1 : 0} / 共 {nodes.length} 幕</div>
        <button className="btn secondary" type="button" onClick={() => gotoIdx(idx - 1)} disabled={idx <= 0}>
          上一幕
        </button>
        <button className="btn secondary" type="button" onClick={() => gotoIdx(idx + 1)} disabled={idx >= nodes.length - 1}>
          下一幕
        </button>
        <button className="btn secondary" type="button" onClick={() => setPlaying((v) => !v)}>
          {playing ? '暂停' : '自动播放'}
        </button>
        <button
          className="btn secondary"
          type="button"
          disabled={!canCompose || compBusy}
          title={!props.assetPlan ? '需先生成资产计划' : !hasStory ? '需先进入合成生成一次' : 'AI 提取构图需求单并按其重排占位块（写回既有摆位，幂等）'}
          onClick={() => void runCompositionLayout()}
        >
          {compBusy ? '预排中…' : 'AI 构图预排'}
        </button>
      </div>

      {compErr ? <div className="bp-playtest-err" style={{ marginBottom: 12 }}>{compErr}</div> : null}
      {compNote ? <div className="hint" style={{ marginBottom: 12, color: '#86efac' }}>{compNote}</div> : null}
      {!node ? (
        <div className="bp-playtest-err">蓝图还没有任何幕。</div>
      ) : (
        <div className="bp-previz-stack">
          {/* 中：占位画框（点空白=选场景看属性；点块=选元素；拖块=编排写回需求单草稿） */}
          <div
            ref={frameRef}
            className="bp-previz-frame"
            style={{ aspectRatio: `${frameW} / ${frameH}`, ['--bp-frame-ratio' as any]: String(frameRatio) }}
            onPointerDown={(e) => {
              if ((e.target as HTMLElement).closest('.bp-previz-block')) return
              props.onSelectScene(node.id)
            }}
            onDoubleClick={(e) => {
              if ((e.target as HTMLElement).closest('.bp-previz-block')) return
              if (groupEdit) props.onGroupEditChange(null) // 双击空白退出组编辑
            }}
          >
            {blocks.map((b) => (
              <div
                key={b.key}
                className={`bp-previz-block g-${b.group}${b.parentAssetId ? ' is-sub' : ''}${b.unready ? ' is-unready' : ''}${b.draggable ? ' is-draggable' : ''}${props.selectedAssetId === b.assetId ? ' is-selected' : ''}${groupEditGroup && previzGroupScopeOf(b.group) !== groupEditGroup ? ' is-dimmed' : ''}${b.flipX ? ' is-flipx' : ''}${b.flipY ? ' is-flipy' : ''}`}
                style={{
                  left: b.left,
                  bottom: b.bottom,
                  width: b.width,
                  zIndex: b.zIndex,
                  // 2026-11-10 修复（用户实测：环境元素图片无法放大）：环境/其他块无定高，块高塌成标签条——
                  // 按图片天然宽高比撑块（img onLoad 实测），缩放/拖动手柄才带着图片走
                  ...((b.group === '环境' || b.group === '其他') && imgAspects[b.key] ? { aspectRatio: String(imgAspects[b.key]) } : {})
                }}
                onPointerDown={(e) => onBlockPointerDown(e, b)}
                onDoubleClick={(e) => {
                  e.stopPropagation()
                  // F 波（2026-10-26 用户裁决）：双击块进入**该块所属组**编辑（背景→背景组/角色→角色组/道具→道具组）
                  // 2026-11-10 修复（用户实测）：主背景块满框铺满，"双击空白退出"永远点到背景块——
                  // 组编辑中双击本组元素=退出（toggle）；双击别组元素=切到该组
                  const scope = previzGroupScopeOf(b.group)
                  props.onGroupEditChange(groupEdit && groupEditGroup === scope ? null : scope)
                }}
                title={`双击进入${previzGroupScopeOf(b.group)}组编辑（仅本组元素可动，松手吸附九宫格）`}
              >
                {/* 状态圆点（2026-10-26 用户指令：未锁定不用文字遮挡内容，红/绿圆点表达） */}
                <span className={`bp-previz-state-dot ${b.unready ? 'is-unready' : 'is-ready'}`} title={b.unready ? '未锁定' : '已锁定'} />
                {/* 2026-11-01 占位预览图：元素已出图时以真实透明图渲染（随拖动/缩放/翻转/纵深带；选择写编排草稿 imageAssetId） */}
                {b.imageSrc ? <img className="bp-previz-block-img" src={b.imageSrc} alt="" draggable={false} onLoad={(e) => noteImgAspect(b.key, e.currentTarget)} /> : null}
                <span className="bp-previz-label">{b.label}</span>
                {/* 2026-11-10（用户实测）：组编辑中本组可动块给右下角缩放手柄——此前只能移动不能放大 */}
                {groupEdit && previzGroupScopeOf(b.group) === groupEditGroup && b.draggable ? (
                  <span
                    className="bp-previz-resize-handle"
                    title="拖动调整大小（松手写回编排；点顶栏「保存」落盘）"
                    onPointerDown={(e) => onBlockResizeStart(e, b)}
                    onDoubleClick={(e) => e.stopPropagation()}
                  />
                ) : null}
              </div>
            ))}
            {/* 深度带参考线（2026-10-26 用户指令：竖屏分上/中/下=远/中/近，编辑元素位置有参照） */}
            <div className="bp-previz-zones" aria-hidden="true">
              <span style={{ top: '2%' }}>远</span>
              <span style={{ top: '35.3%' }}>中</span>
              <span style={{ top: '68.6%' }}>近</span>
              <i style={{ top: '33.3%' }} />
              <i style={{ top: '66.6%' }} />
            </div>
            {/* 组编辑九宫格（2026-10-26 用户指令：背景布局编辑内 上中下×左中右 落格，松手吸附格心） */}
            {groupEdit ? (
              <div className="bp-previz-grid" aria-hidden="true">
                {[33.33, 66.66].map((x) => (
                  <i key={`v${x}`} style={{ left: `${x}%`, top: 0, bottom: 0, borderLeft: '1px dashed rgba(94,204,255,0.22)' }} />
                ))}
                {[33.33, 66.66].map((y) => (
                  <i key={`h${y}`} style={{ top: `${y}%`, left: 0, right: 0, borderTop: '1px dashed rgba(94,204,255,0.22)' }} />
                ))}
                {[
                  ['远', '左', '4%', '2%'], ['远', '中', '46%', '2%'], ['远', '右', '86%', '2%'],
                  ['中', '左', '4%', '35.3%'], ['中', '中', '46%', '35.3%'], ['中', '右', '86%', '35.3%'],
                  ['近', '左', '4%', '68.6%'], ['近', '中', '46%', '68.6%'], ['近', '右', '86%', '68.6%']
                ].map(([d, h, left, top]) => (
                  <b key={`${d}${h}`} style={{ left, top }}>{`${d}·${h}`}</b>
                ))}
              </div>
            ) : null}
            {groupEdit ? (
              <div className="bp-previz-group-tip">
                {groupEditGroup}组编辑中（仅本组元素可动，右下角手柄调大小）· 双击本组元素或空白退出
              </div>
            ) : null}
            {!blocks.length ? <div className="bp-previz-empty hint">本幕无元素标记（元素分析后这里出现占位块）</div> : null}
          </div>
          {/* 下：该幕文本 + 选择按钮组 / 结局操作（A 波：点文本区 → 回场景属性并聚焦文本草稿） */}
          <div
            className="bp-previz-storyline"
            style={{ cursor: 'pointer' }}
            title="点击回到场景属性（聚焦文本草稿）"
            onPointerDown={(e) => {
              const t = e.target as HTMLElement
              if (t.closest('button, a')) return
              props.onFocusSceneText(node.id)
            }}
          >
            <div className="bp-previz-caption-title">
              {nodeTitle(node, props.scriptCards)}
              {isEnding ? <span className="bp-playtest-ending-badge">结局</span> : null}
            </div>
            <div className="bp-previz-caption-text">{String(node.textDraft || '').trim() || '（本幕无文本草稿）'}</div>
          </div>
          {isEnding ? (
            <div className="bp-playtest-actions">
              <button
                className="btn"
                type="button"
                onClick={() => {
                  setPlaying(false)
                  const startIdx = Math.max(0, nodes.findIndex((n) => n.id === startId))
                  gotoIdx(startIdx >= 0 ? startIdx : 0)
                }}
              >
                再走一遍
              </button>
            </div>
          ) : choices.length ? (
            <div className="bp-playtest-choices">
              {choices.map((c) => {
                const to = String((c as any)?.toNodeId || '')
                const target = nodes.find((n) => n.id === to)
                const broken = !to || !target
                return (
                  <button
                    key={c.id}
                    className="bp-playtest-choice"
                    type="button"
                    disabled={broken}
                    title={broken ? '该分支没有接后续场景' : ''}
                    onClick={() => {
                      setPlaying(false)
                      if (target) props.onSceneChange(target.id)
                    }}
                  >
                    {String((c as any)?.text || '').trim() || '（未命名选项）'}
                    {broken ? <span className="bp-playtest-broken">该分支没有接后续场景</span> : null}
                  </button>
                )
              })}
            </div>
          ) : (
            <div className="bp-playtest-err">本幕没有选项，也不是结局——结构不完整（请在蓝图中补齐分支）。</div>
          )}
        </div>
      )}
    </div>
  )
}
