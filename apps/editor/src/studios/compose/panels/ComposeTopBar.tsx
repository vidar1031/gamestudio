import type { Dispatch, SetStateAction } from 'react'
import {
  openProjectAiAssetsFolder,
  type NodeV1,
  type ProjectV1
} from '../../../api'
import type { EditorDoc, Selection } from '../types'

export type ComposeTopBarProps = {
  props: { projectId?: string | null; onBack?: () => void; onBackToHub?: () => void }
  showProjectManager: boolean
  busy: boolean
  dirty: boolean
  doc: EditorDoc
  projects: ProjectV1[]
  problems: string[]
  openMenu: '' | 'export' | 'produce'
  runtimeStartNodeId: string
  nodesForList: NodeV1[]
  nodeLabel: (n: any) => string
  refreshProjects: () => Promise<void>
  createNewProject: () => Promise<void>
  openProject: (id: string) => Promise<void>
  saveIfDirty: () => Promise<boolean>
  saveCurrent: () => Promise<boolean>
  restartRuntime: () => void
  exportCurrent: () => Promise<void>
  exportPublishCurrent: () => Promise<void>
  openCompletenessModal: () => void
  openSceneReviewPanel: () => Promise<void>
  runStoryboardOpenChecks: () => Promise<void>
  initStoryboardBatchFromDoc: () => Promise<void>
  setOpenMenu: Dispatch<SetStateAction<'' | 'export' | 'produce'>>
  setRuntimeStartNodeId: Dispatch<SetStateAction<string>>
  setSelection: Dispatch<SetStateAction<Selection>>
  setSbOpen: Dispatch<SetStateAction<boolean>>
  setSbRenderOpen: Dispatch<SetStateAction<boolean>>
  setSbPoseFocusAssetId: Dispatch<SetStateAction<string>>
  setToast: Dispatch<SetStateAction<string>>
}

export function ComposeTopBar(p: ComposeTopBarProps) {
  const {
    props,
    showProjectManager,
    busy,
    dirty,
    doc,
    projects,
    problems,
    openMenu,
    runtimeStartNodeId,
    nodesForList,
    nodeLabel,
    refreshProjects,
    createNewProject,
    openProject,
    saveIfDirty,
    saveCurrent,
    restartRuntime,
    exportCurrent,
    exportPublishCurrent,
    openCompletenessModal,
    openSceneReviewPanel,
    runStoryboardOpenChecks,
    initStoryboardBatchFromDoc,
    setOpenMenu,
    setRuntimeStartNodeId,
    setSelection,
    setSbOpen,
    setSbRenderOpen,
    setSbPoseFocusAssetId,
    setToast
  } = p

  return (
      <div className="topbar">
        <div className="left">
          <div className="title">talkscene · 节点式交互故事编辑器</div>
          {showProjectManager ? (
            <>
              <button className="btn secondary" onClick={() => refreshProjects()} disabled={busy}>
                刷新
              </button>
              <button className="btn" onClick={() => createNewProject()} disabled={busy}>
                新建项目
              </button>
              <select
                className="sel"
                value={doc.mode === 'project' ? doc.id : ''}
                onChange={(e) => {
                  const id = e.target.value
                  if (!id) return
                  void openProject(id)
                }}
              >
                <option value="">打开项目…</option>
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.title || p.id}
                  </option>
                ))}
              </select>
            </>
          ) : null}
          {/* 2026-10-20 外壳升级：返回/场景起点/当前项目归入左簇（quiet 次级），右簇只留动作 */}
          {props.onBackToHub ? (
            <button
              className="btn secondary compose-quiet"
              onClick={async () => {
                const ok = await saveIfDirty()
                if (!ok) return
                props.onBackToHub?.()
              }}
              disabled={busy}
            >
              返回工作台
            </button>
          ) : null}

          {props.onBack ? (
            <button
              className="btn secondary compose-quiet"
              onClick={async () => {
                const ok = await saveIfDirty()
                if (!ok) return
                props.onBack?.()
              }}
              disabled={busy}
            >
              返回蓝图
            </button>
          ) : null}

          {doc.story ? (
            <select
              className="sel"
              value={runtimeStartNodeId || doc.story.startNodeId}
              onChange={(e) => setRuntimeStartNodeId(e.target.value)}
              title="播放起点（不影响蓝图结构/导出）"
            >
              {nodesForList.map((n) => (
                <option key={n.id} value={n.id}>
                  {nodeLabel(n as any) || '（未命名）'}
                </option>
              ))}
            </select>
          ) : null}

          {doc.mode !== 'none' ? <div className="hint compose-current">当前：{doc.title}</div> : null}
        </div>

	        <div className="right">
          {/* 2026-10-20 外壳升级：右簇 = 校验徽标 + 播放 + 保存 + 导出菜单 + 制作菜单 + 全局设置 */}
          {problems.length ? (
            <span className="compose-check-chip is-bad" title="校验发现问题">
              <span className="compose-check-dot" />
              {problems.length} 个问题
            </span>
          ) : (
            <span className="compose-check-chip is-ok" title="校验通过">
              <span className="compose-check-dot" />
              校验通过
            </span>
          )}
          <button className="btn secondary" onClick={() => restartRuntime()} disabled={!doc.story}>播放</button>
          <button className="btn" onClick={() => saveCurrent()} disabled={busy || doc.mode !== 'project' || !dirty}>保存</button>

          <div className="compose-menu-wrap">
            <button
              type="button"
              className={`btn secondary${openMenu === 'export' ? ' is-open' : ''}`}
              disabled={busy || doc.mode !== 'project'}
              aria-expanded={openMenu === 'export'}
              onClick={(e) => {
                e.stopPropagation()
                setOpenMenu(openMenu === 'export' ? '' : 'export')
              }}
            >
              导出 ▾
            </button>
            {openMenu === 'export' ? (
              <div className="compose-menu" role="menu" onClick={(e) => e.stopPropagation()}>
                <button
                  type="button"
                  disabled={busy || doc.mode !== 'project'}
                  onClick={() => {
                    setOpenMenu('')
                    void exportCurrent()
                  }}
                >
                  <span>导出预览</span>
                  <span className="compose-menu-desc">导出并打开预览页</span>
                </button>
                <button
                  type="button"
                  disabled={busy || doc.mode !== 'project'}
                  onClick={() => {
                    setOpenMenu('')
                    void exportPublishCurrent()
                  }}
                >
                  <span>导出发布包（H5）</span>
                  <span className="compose-menu-desc">打包可分享的成品 H5（zip）</span>
                </button>
              </div>
            ) : null}
          </div>

          {doc.mode === 'project' ? (
            <div className="compose-menu-wrap">
              <button
                type="button"
                className={`btn secondary${openMenu === 'produce' ? ' is-open' : ''}`}
                disabled={busy}
                aria-expanded={openMenu === 'produce'}
                onClick={(e) => {
                  e.stopPropagation()
                  setOpenMenu(openMenu === 'produce' ? '' : 'produce')
                }}
              >
                制作 ▾
              </button>
              {openMenu === 'produce' ? (
                <div className="compose-menu compose-menu--wide" role="menu" onClick={(e) => e.stopPropagation()}>
                  {doc.mode === 'project' && doc.story ? (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={async () => {
                        setOpenMenu('')
                        await initStoryboardBatchFromDoc()
                        setSbPoseFocusAssetId('')
                        setSbRenderOpen(false)
                        setSbOpen(true)
                        void runStoryboardOpenChecks()
                      }}
                    >
                      <span>锁定事物</span>
                      <span className="compose-menu-desc">打开锁定事物向导</span>
                    </button>
                  ) : null}
                  {doc.mode === 'project' && doc.story ? (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={async () => {
                        setOpenMenu('')
                        // 2026-09-01 场景出图直接入口（用户需求：调背景不必每次穿 7 步向导）
                        await initStoryboardBatchFromDoc()
                        const ok = await saveIfDirty()
                        if (!ok) return
                        setSbOpen(false)
                        setSbRenderOpen(true)
                        void runStoryboardOpenChecks()
                      }}
                    >
                      <span>场景出图</span>
                      <span className="compose-menu-desc">直达正式场景出图（背景生产车间）：编辑场景提示词、重新出图、批量重渲、待审核处理，无需穿过锁定向导</span>
                    </button>
                  ) : null}
                  {doc.mode === 'project' && doc.story ? (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => {
                        setOpenMenu('')
                        void openSceneReviewPanel()
                      }}
                    >
                      <span>场景图审核</span>
                      <span className="compose-menu-desc">把每个场景的整图提交守护台审图中心评审（分数/问题/改图建议），不合格可一键打回重出</span>
                    </button>
                  ) : null}
                  {doc.mode === 'project' ? (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => {
                        setOpenMenu('')
                        void openProjectAiAssetsFolder(doc.id).catch((e) => setToast(`打开素材目录失败：${e instanceof Error ? e.message : String(e)}`))
                      }}
                    >
                      <span>素材目录</span>
                      <span className="compose-menu-desc">在 Finder 中打开本项目 AI 素材目录（assets/ai），直接管理全部 AI 生成图</span>
                    </button>
                  ) : null}
                  <button
                    type="button"
                    disabled={busy || doc.mode !== 'project'}
                    onClick={() => {
                      setOpenMenu('')
                      openCompletenessModal()
                    }}
                  >
                    <span>完整度核实</span>
                    <span className="compose-menu-desc">查看完整度核实报告；用真实浏览器逐节点走查导出的可玩 H5 并做视觉评审</span>
                  </button>
                </div>
              ) : null}
            </div>
          ) : null}

          {doc.mode !== 'none' ? (
            <button className="btn secondary" onClick={() => setSelection({ type: 'none' })} disabled={busy}>
              全局设置
            </button>
          ) : null}
        </div>
	      </div>
  )
}
