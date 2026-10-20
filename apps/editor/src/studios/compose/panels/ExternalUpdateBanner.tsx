import type { Dispatch, SetStateAction } from 'react'
import type { EditorDoc } from '../types'

export type ExternalUpdateBannerProps = {
  busy: boolean
  doc: EditorDoc
  externalNewerRev: number
  openProject: (id: string) => Promise<void>
  setExternalDismissedRev: Dispatch<SetStateAction<number>>
  setExternalNewerRev: Dispatch<SetStateAction<number>>
}

export function ExternalUpdateBanner(props: ExternalUpdateBannerProps) {
  const {
    busy,
    doc,
    externalNewerRev,
    openProject,
    setExternalDismissedRev,
    setExternalNewerRev
  } = props

  return (
        <div className="external-update-banner">
          <span>项目已在其他窗口或流程中更新（新版本 {externalNewerRev}）。为避免旧内容覆盖新变更，请刷新加载最新。</span>
          <div className="banner-actions">
            <button
              className="btn secondary"
              onClick={() => {
                // 2026-09-30 按用户指令：知道了=本会话内不再提示（含后续版本变化）；
                // 此前的打盹语义（新版本再提示）被否决——用户确认过即视为已知，只有「刷新加载最新」才复位。
                setExternalDismissedRev(Number.MAX_SAFE_INTEGER)
                setExternalNewerRev(0)
              }}
              title="本会话内不再提示（刷新加载最新后恢复检测）"
            >
              知道了
            </button>
            <button
              className="btn"
              disabled={busy}
              onClick={async () => {
                setExternalDismissedRev(0)
                setExternalNewerRev(0)
                try { await openProject(doc.id) } catch {}
              }}
            >
              刷新加载最新
            </button>
          </div>
        </div>
  )
}
