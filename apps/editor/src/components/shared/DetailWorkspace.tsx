import type { ReactNode } from 'react'

export type DetailWorkspaceNavItem = {
  key: string
  label: string
  active?: boolean
  onClick: () => void
}

type Props = {
  ariaLabel: string
  title: ReactNode
  badges?: ReactNode
  navItems?: DetailWorkspaceNavItem[]
  previousDisabled?: boolean
  nextDisabled?: boolean
  onPrevious: () => void
  onNext: () => void
  onClose: () => void
  className?: string
  bodyClassName?: string
  children: ReactNode
}

export default function DetailWorkspace(props: Props) {
  return (
    <div className="story-lock-detail-overlay detail-workspace" role="dialog" aria-modal="true" aria-label={props.ariaLabel}>
      <div className={`story-lock-detail-card ${props.className || ''}`}>
        <div className="story-lock-detail-head">
          <div className="detail-workspace-heading">
            <div className="detail-workspace-title">{props.title}</div>
            {props.badges}
          </div>
          <div className="detail-workspace-actions">
            <button className="btn secondary" type="button" onClick={props.onPrevious} disabled={props.previousDisabled}>← 上一个</button>
            <button className="btn secondary" type="button" onClick={props.onNext} disabled={props.nextDisabled}>下一个 →</button>
            <button type="button" className="icon-btn" onClick={props.onClose} aria-label="关闭工作区" title="关闭">✕</button>
          </div>
        </div>
        {props.navItems?.length ? (
          <div className="story-lock-detail-nav" role="tablist" aria-label="工作区分区">
            {props.navItems.map((item) => (
              <button key={item.key} type="button" role="tab" aria-selected={Boolean(item.active)} className={`story-lock-view-toggle-btn ${item.active ? 'active' : ''}`} onClick={item.onClick}>
                {item.label}
              </button>
            ))}
          </div>
        ) : null}
        <div className={`story-lock-detail-body ${props.bodyClassName || ''}`}>{props.children}</div>
      </div>
    </div>
  )
}
