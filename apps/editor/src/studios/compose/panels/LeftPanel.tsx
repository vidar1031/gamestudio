import type { Dispatch, SetStateAction } from 'react'
import { type NodeV1 } from '../../../api'
import type { EditorDoc, LeftTab, Selection } from '../types'
import { nodeKindLabel } from '../orchestration/utils'

export type LeftPanelProps = {
  doc: EditorDoc
  leftTab: LeftTab
  setLeftTab: Dispatch<SetStateAction<LeftTab>>
  selection: Selection
  setSelection: Dispatch<SetStateAction<Selection>>
  nodesForList: NodeV1[]
  nodeLabel: (n: any) => string
  addCharacter: () => void
  addAsset: () => void
  stageMaterials: Array<{ key: string; name: string; kind: string; characterId?: string; imageAssetId: string }>
}

export function ComposeLeftPanel(props: LeftPanelProps) {
  const {
    doc,
    leftTab,
    setLeftTab,
    selection,
    setSelection,
    nodesForList,
    nodeLabel,
    addCharacter,
    addAsset,
    stageMaterials
  } = props

  return (
        <div className="panel">
          <div className="tabs">
            <div className={`tab ${leftTab === 'nodes' ? 'active' : ''}`} onClick={() => setLeftTab('nodes')}>节点</div>
            <div className={`tab ${leftTab === 'characters' ? 'active' : ''}`} onClick={() => setLeftTab('characters')}>角色</div>
            <div className={`tab ${leftTab === 'assets' ? 'active' : ''}`} onClick={() => setLeftTab('assets')}>资源</div>
            <div className={`tab ${leftTab === 'materials' ? 'active' : ''}`} onClick={() => setLeftTab('materials')}>素材</div>
          </div>

	          <div className="section">
	            {doc.project && doc.story ? null : null}

	            {leftTab === 'nodes' && doc.story ? (
	              <>
	                <div className="list">
	                  {nodesForList.map((n) => (
	                    <div
	                      key={n.id}
                      className={`item ${selection.type === 'node' && selection.id === n.id ? 'active' : ''}`}
                      onClick={() => setSelection({ type: 'node', id: n.id })}
                    >
                      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                        <div>{nodeLabel(n as any) || n.id}</div>
                        <div className="meta">{nodeKindLabel((n as any).kind)}</div>
                      </div>
                    </div>
                  ))}
                </div>
              </>
            ) : null}

            {leftTab === 'characters' && doc.project ? (
              <>
                <div className="hr" />
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  <button className="btn secondary" onClick={() => addCharacter()} disabled={doc.readonly}>+ 角色</button>
                </div>
                <div className="hr" />
                <div className="list">
                  {doc.project.characters.map((c) => (
                    <div
                      key={c.id}
                      className={`item ${selection.type === 'character' && selection.id === c.id ? 'active' : ''}`}
                      onClick={() => setSelection({ type: 'character', id: c.id })}
                    >
                      <div>{c.name || c.id}</div>
                      <div className="meta">id: {c.id}</div>
                    </div>
                  ))}
                </div>
              </>
            ) : null}

            {leftTab === 'assets' && doc.project ? (
              <>
                <div className="hr" />
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  <button className="btn secondary" onClick={() => addAsset()} disabled={doc.readonly}>+ 资源</button>
                </div>
                <div className="hr" />
                <div className="list">
                  {doc.project.assets.map((a) => (
                    <div
                      key={a.id}
                      className={`item ${selection.type === 'asset' && selection.id === a.id ? 'active' : ''}`}
                      onClick={() => setSelection({ type: 'asset', id: a.id })}
                    >
                      <div>{a.name || a.id}</div>
                      <div className="meta">id: {a.id}</div>
                    </div>
                  ))}
                </div>
              </>
            ) : null}

            {leftTab === 'materials' && doc.project ? (
              <>
                <div className="hr" />
                <div className="hint">把素材拖到中间画布即可在当前场景摆放；同一素材可摆放多个。</div>
                <div className="hr" />
                <div className="list">
                  {stageMaterials.map((m) => (
                    <div
                      key={m.key}
                      className="item stage-material-item"
                      draggable
                      onDragStart={(e) => {
                        e.dataTransfer.setData('application/x-talkscene-asset', JSON.stringify({
                          characterId: m.characterId || '',
                          imageAssetId: m.imageAssetId,
                          name: m.name
                        }))
                        e.dataTransfer.effectAllowed = 'copy'
                      }}
                      title="拖入中间画布摆放"
                    >
                      <div>{m.name}</div>
                      <div className="meta">{m.kind}</div>
                    </div>
                  ))}
                  {stageMaterials.length === 0 ? (
                    <div className="hint">暂无可摆放素材：请先在「角色」生成角色图，或完成锁定事物主参考。</div>
                  ) : null}
                </div>
              </>
            ) : null}
          </div>
        </div>
  )
}
