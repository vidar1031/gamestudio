import type { Dispatch, SetStateAction } from 'react'
import { type CharacterPlacementV1 } from '../../../api'

export type StageToolbarProps = {
  editMode: boolean
  setEditMode: Dispatch<SetStateAction<boolean>>
  stageZoom: number
  setStageZoom: Dispatch<SetStateAction<number>>
  setStagePan: Dispatch<SetStateAction<{ x: number; y: number }>>
  panToolActive: boolean
  setPanToolActive: Dispatch<SetStateAction<boolean>>
  undoCount: number
  undoPlacementChange: () => void
  toolbarPlacement: CharacterPlacementV1 | null
  togglePlacementFlip: (axis: 'flipX' | 'flipY') => void
  bumpPlacementZ: (delta: number) => void
  deleteToolbarPlacement: () => void
}

export function StageToolbar(props: StageToolbarProps) {
  const {
    editMode,
    setEditMode,
    stageZoom,
    setStageZoom,
    setStagePan,
    panToolActive,
    setPanToolActive,
    undoCount,
    undoPlacementChange,
    toolbarPlacement,
    togglePlacementFlip,
    bumpPlacementZ,
    deleteToolbarPlacement
  } = props

  return (
            <div className="stage-toolbar">
              <button
                type="button"
                className={`stage-mode-badge ${editMode ? 'edit' : 'preview'}`}
                onClick={() => setEditMode((v) => !v)}
                title={editMode ? '当前为编辑模式：可拖动/摆放/编辑元素；点击切换到预览模式' : '当前为预览模式：画布只读；点击切换到编辑模式'}
              >
                {editMode ? '编辑模式' : '预览模式'}
              </button>
              <span className="stage-toolbar-sep" />
              <button type="button" className="stage-tool-btn" onClick={() => setStageZoom((z) => Math.max(0.25, Math.round((z / 1.2) * 100) / 100))} title="缩小">−</button>
              <span className="stage-toolbar-zoom">{Math.round(stageZoom * 100)}%</span>
              <button type="button" className="stage-tool-btn" onClick={() => setStageZoom((z) => Math.min(4, Math.round(z * 1.2 * 100) / 100))} title="放大">＋</button>
              <button type="button" className="stage-tool-btn" onClick={() => { setStageZoom(1); setStagePan({ x: 0, y: 0 }) }} title="适应窗口（重置缩放与平移）">适应窗口</button>
              <button type="button" className={`stage-tool-btn ${panToolActive ? 'active' : ''}`} onClick={() => setPanToolActive((v) => !v)} title="平移工具：开启后拖动画布平移视图">平移</button>
              <span className="stage-toolbar-sep" />
              <button type="button" className="stage-tool-btn" disabled={!undoCount} onClick={undoPlacementChange} title="撤销上一次摆放操作（Ctrl/Cmd+Z）">撤销</button>
              {/* 2026-10-20 外壳升级：选择簇仅在选中摆放且编辑模式时出现（淡入）；handler 与 disabled 语义不变 */}
              {toolbarPlacement && editMode ? (
                <span className="stage-toolbar-selection">
                  <span className="stage-toolbar-sep" />
                  <button type="button" className="stage-tool-btn" disabled={!toolbarPlacement || !editMode} onClick={() => togglePlacementFlip('flipX')} title="左右反转选中元素">左右反转</button>
                  <button type="button" className="stage-tool-btn" disabled={!toolbarPlacement || !editMode} onClick={() => togglePlacementFlip('flipY')} title="上下反转选中元素">上下反转</button>
                  <button type="button" className="stage-tool-btn" disabled={!toolbarPlacement || !editMode} onClick={() => bumpPlacementZ(1)} title="选中元素上移一层">前移</button>
                  <button type="button" className="stage-tool-btn" disabled={!toolbarPlacement || !editMode} onClick={() => bumpPlacementZ(-1)} title="选中元素下移一层">后移</button>
                  <button type="button" className="stage-tool-btn" disabled={!toolbarPlacement || !editMode} onClick={deleteToolbarPlacement} title="删除选中摆放">删除</button>
                </span>
              ) : null}
            </div>
  )
}
