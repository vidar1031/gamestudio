import { Application, Container, Sprite } from 'pixi.js'
import {
  type NodeV1,
  type StageConfigV1
} from '../../../api'
import type { EditorDoc } from '../types'
import type { StageOverride } from '../orchestration/runtime'
import { computeStageViewport } from '../orchestration/stageViewport'
import { clamp01, numberOr, resolveAsset } from '../orchestration/utils'
import { hitPlacementSprite } from './hitTest'
import { loadTexture } from './textures'

export async function renderStage(args: {
  app: Application
  doc: EditorDoc
  node: NodeV1 | null
  stageOverride?: StageOverride | null
  isStale?: () => boolean
  // 场景编排器：画布内拖动/点选摆放（仅渲染真实节点 placements 时启用，stageOverride 只读）
  interaction?: {
    onSelect: (placementId: string) => void
    onCommitTransform: (placementId: string, patch: { x?: number; y?: number }) => void
  }
  // 场景编排器：视图变换（缩放以画布中心为基准 + 平移）与编辑/预览模式
  view?: {
    zoom?: number
    panX?: number
    panY?: number
    panTool?: boolean
    editable?: boolean
    onPanCommit?: (panX: number, panY: number) => void
  }
}) {
  const { app, doc, node, stageOverride, isStale, interaction, view } = args

  if (isStale && isStale()) return

  app.stage.removeChildren()
  if (!node || !doc.project || !doc.story) return

  const viewW = app.renderer.width
  const viewH = app.renderer.height
  if (!viewW || !viewH) return

  const stageCfg = (doc.project && (doc.project as any).stage) as StageConfigV1 | undefined
  const vp = computeStageViewport(stageCfg, viewW, viewH)

  const root = new Container()
  const zoom = Math.max(0.25, Math.min(4, Number(view?.zoom) || 1))
  const effScale = vp.scale * zoom
  const panX = Number(view?.panX) || 0
  const panY = Number(view?.panY) || 0
  const centerX = viewW / 2
  const centerY = viewH / 2
  // 缩放以画布中心为基准：rootPos = 中心 + (原 rootPos - 中心) × zoom + pan
  root.x = centerX + (vp.offsetX - centerX) * zoom + panX
  root.y = centerY + (vp.offsetY - centerY) * zoom + panY
  root.scale.set(effScale)
  app.stage.addChild(root)

  // 平移工具：开启后按住画布拖动平移舞台（移动中直接改 root，pointerup 一次性提交视图状态）
  try {
    const st: any = app.stage
    if (st.__panDown) {
      st.off('pointerdown', st.__panDown)
      st.__panDown = null
    }
    if (view?.panTool) {
      st.__panDown = (e: any) => {
        const startGx = e.global.x
        const startGy = e.global.y
        const baseX = root.x
        const baseY = root.y
        let latest: { x: number; y: number } | null = null
        const onMove = (ev: any) => {
          latest = { x: baseX + (ev.global.x - startGx), y: baseY + (ev.global.y - startGy) }
          root.x = latest.x
          root.y = latest.y
        }
        const onUp = () => {
          st.off('pointermove', onMove)
          st.off('pointerup', onUp)
          st.off('pointerupoutside', onUp)
          if (latest && view?.onPanCommit) {
            const baseRootX = centerX + (vp.offsetX - centerX) * zoom
            const baseRootY = centerY + (vp.offsetY - centerY) * zoom
            view.onPanCommit(latest.x - baseRootX, latest.y - baseRootY)
          }
        }
        st.on('pointermove', onMove)
        st.on('pointerup', onUp)
        st.on('pointerupoutside', onUp)
      }
      st.on('pointerdown', st.__panDown)
    }
  } catch {}

  // background
  try {
    const bgId = stageOverride?.backgroundAssetId ?? node.visuals?.backgroundAssetId
    if (bgId) {
      const a = (doc.project.assets || []).find((x) => x.id === bgId)
      if (a?.uri) {
        const url = resolveAsset(a.uri, doc.assetBase)
        const tex = await loadTexture(url)
        if (isStale && isStale()) return
        if (!tex) {
          try {
            console.warn('[talkscene] background texture missing:', url)
          } catch {}
        } else {
          const s = new Sprite(tex)
          s.x = 0
          s.y = 0
          s.width = vp.stageW
          s.height = vp.stageH
          root.addChild(s)
        }
      }
    }
  } catch {}

  // placements
  try {
    const placements = Array.isArray(stageOverride?.placements)
      ? stageOverride?.placements
      : Array.isArray(node.visuals?.placements)
        ? node.visuals?.placements
        : []
    const editable = view?.editable !== false
    const interactive = editable && Boolean(interaction) && !Array.isArray(stageOverride?.placements) && !view?.panTool
    if (interactive || view?.panTool) {
      try {
        app.stage.eventMode = 'static'
        app.stage.hitArea = app.screen
      } catch {}
    }
    const ordered = placements.slice().sort((a, b) => numberOr(a.zIndex, 0) - numberOr(b.zIndex, 0))
    // 像素级点选候选（渲染顺序 ascending，命中判定时从尾到头 = 从顶层到底层）
    const hitSprites: Array<{ sprite: Sprite; pid: string; origX: number; origY: number }> = []
    for (const p of ordered) {
      if (p.visible === false) continue
      const ch = (doc.project.characters || []).find((c) => c.id === p.characterId)
      const imageAssetId = String(p.imageAssetId || ch?.imageAssetId || '').trim()
      if (!imageAssetId) continue
      const a = (doc.project.assets || []).find((x) => x.id === imageAssetId)
      if (!a?.uri) continue

      const url = resolveAsset(a.uri, doc.assetBase)
      const tex = await loadTexture(url)
      if (isStale && isStale()) return
      if (!tex) continue
      const sp = new Sprite(tex)
      sp.anchor.set(0.5, 1)

      const x = clamp01(numberOr(p.transform?.x, 0.5))
      const y = clamp01(numberOr(p.transform?.y, 1))
      const scale = numberOr(p.transform?.scale, 1)
      const rot = numberOr(p.transform?.rotationDeg, 0)
      const flipX = Boolean((p.transform as any)?.flipX)
      const flipY = Boolean((p.transform as any)?.flipY)

      sp.x = vp.stageW * x
      sp.y = vp.stageH * y
      // anchor (0.5,1) 底中：水平反转围绕中心稳定（与导出运行时 storyPixi.js 同一语义）
      sp.scale.set(scale * (flipX ? -1 : 1), scale * (flipY ? -1 : 1))
      sp.rotation = (rot * Math.PI) / 180

      root.addChild(sp)

      // 选中高亮定位标记 + 像素级点选候选（标记不依赖交互开关，预览模式也可显示选中框）
      const pid = String(p.id || '').trim()
      if (pid && !Array.isArray(stageOverride?.placements)) {
        try { (sp as any).__placementId = pid } catch {}
        hitSprites.push({ sprite: sp, pid, origX: x, origY: y })
      }
    }

    // 像素级点选：stage 级 pointerdown 从顶到底逐摆放判定（透明像素穿透）；
    // 命中的摆放走原有点选+拖动链；该点所有摆放像素都透明则视为点击空白并取消选中
    try {
      const st: any = app.stage
      if (st.__pickDown) {
        st.off('pointerdown', st.__pickDown)
        st.__pickDown = null
      }
      if (interactive && interaction) {
        st.__pickDown = (e: any) => {
          const gx = e.global.x
          const gy = e.global.y
          for (let i = hitSprites.length - 1; i >= 0; i -= 1) {
            const hit = hitSprites[i]
            if (!hitPlacementSprite(hit.sprite, gx, gy)) continue
            const sp = hit.sprite
            interaction.onSelect(hit.pid)
            const startGx = gx
            const startGy = gy
            const origX = hit.origX
            const origY = hit.origY
            let latest: { x: number; y: number } | null = null
            const onMove = (ev: any) => {
              const nx = clamp01(origX + (ev.global.x - startGx) / (effScale * vp.stageW))
              const ny = clamp01(origY + (ev.global.y - startGy) / (effScale * vp.stageH))
              latest = { x: nx, y: ny }
              sp.x = vp.stageW * nx
              sp.y = vp.stageH * ny
            }
            const onUp = () => {
              st.off('pointermove', onMove)
              st.off('pointerup', onUp)
              st.off('pointerupoutside', onUp)
              if (latest) interaction.onCommitTransform(hit.pid, latest)
            }
            st.on('pointermove', onMove)
            st.on('pointerup', onUp)
            st.on('pointerupoutside', onUp)
            return
          }
          interaction.onSelect('')
        }
        st.on('pointerdown', st.__pickDown)
      }
    } catch {}
  } catch {}
}
