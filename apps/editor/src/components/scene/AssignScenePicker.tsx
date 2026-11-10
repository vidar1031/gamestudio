import { useState } from 'react'

// 幕分配快捷选择器（2026-11-10 用户裁决：背景元素/地点的分配在卡片上就地可增删，不再只读）。
// 只列"尚未分配"的幕；选定即调 onAssign（父级走三处同步写口），成功后清空选择。
type Props = {
  scenes: Array<{ id: string; name: string }>
  busy?: boolean
  onAssign: (sceneId: string) => void
}

export default function AssignScenePicker(props: Props) {
  const [sel, setSel] = useState('')
  if (!props.scenes.length) return null
  return (
    <span className="assign-scene-picker" style={{ display: 'inline-flex', gap: 4, alignItems: 'center' }}>
      <select
        value={sel}
        onChange={(e) => setSel(e.target.value)}
        disabled={props.busy}
        title="选择要分配到的幕"
        style={{ background: 'rgba(255,255,255,0.06)', color: 'inherit', border: '1px solid rgba(255,255,255,0.14)', borderRadius: 6, padding: '3px 6px', fontSize: 12, maxWidth: 150 }}
      >
        <option value="">分配到幕…</option>
        {props.scenes.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
      </select>
      <button
        type="button"
        className="btn secondary"
        style={{ padding: '3px 10px', fontSize: 12 }}
        disabled={!sel || props.busy}
        title="把本元素分配到选中的幕（场景出图与摆位随之纳入）"
        onClick={() => { if (sel) { props.onAssign(sel); setSel('') } }}
      >
        分配
      </button>
    </span>
  )
}
