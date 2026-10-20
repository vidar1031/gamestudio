// 卡片统一部件契约（ui_设置定义.md §5）：启用开关 / 状态灯 / 折叠；
// Provider、模型记忆、地址、连通动作由各能力卡在 children 内按同一部件序组装。
import { useState, type ReactNode } from 'react'
import { IconChevron } from './icons'
import type { ServiceTestResult } from './settingsApi'

export type StatusLevel = 'ok' | 'warn' | 'checking' | 'error' | 'off'

export const STATUS_TEXT: Record<StatusLevel, string> = {
  ok: '已配置',
  warn: '未配置',
  checking: '检测中',
  error: '不可用',
  off: '已停用'
}

export function StatusLight(props: { level: StatusLevel }) {
  return <span className={`settings-light settings-light-${props.level}`} aria-label={STATUS_TEXT[props.level]} />
}

// 任务A：测试连接内联结果行（成功绿/失败红含色点；失败文案含原因+下一步建议，禁止静默失败）
export function TestResultLine(props: { result: ServiceTestResult | null }) {
  const r = props.result
  if (!r) return null
  return (
    <div className={`settings-test-result ${r.ok ? 'is-ok' : 'is-err'}`} role="status">
      <span className={`settings-light settings-light-${r.ok ? 'ok' : 'error'}`} style={{ marginTop: 6 }} />
      <span>{r.note}</span>
    </div>
  )
}

export default function SectionCard(props: {
  title: string
  icon?: ReactNode
  summary?: string
  status?: StatusLevel
  statusText?: string
  enabled?: boolean | null
  onToggleEnabled?: (v: boolean) => void
  defaultOpen?: boolean
  children?: ReactNode
}) {
  const [open, setOpen] = useState(Boolean(props.defaultOpen))
  const status = props.status || 'ok'
  const hasSwitch = props.enabled !== null && props.enabled !== undefined
  const disabled = props.enabled === false
  return (
    <div className={`settings-card${disabled ? ' is-off' : ''}${open ? ' is-open' : ''}`}>
      <div className="settings-card-head" onClick={() => setOpen((v) => !v)}>
        <StatusLight level={status} />
        {props.icon ? <span className="settings-card-icon">{props.icon}</span> : null}
        <div className="settings-card-title">{props.title}</div>
        {props.summary ? <div className="settings-card-summary">{props.summary}</div> : null}
        <div className="settings-card-head-right" onClick={(e) => e.stopPropagation()}>
          {/* 开关已表达启用/停用时，状态文字只在有额外信息（未配置/检测中/不可用）时显示，避免重复 */}
          {hasSwitch && (status === 'off' || status === 'ok') ? null : (
            <span className={`settings-status-text settings-status-${status}`}>{props.statusText || STATUS_TEXT[status]}</span>
          )}
          {hasSwitch ? (
            <button
              type="button"
              role="switch"
              aria-checked={!disabled}
              className={`settings-switch${disabled ? '' : ' is-on'}`}
              onClick={() => {
                props.onToggleEnabled && props.onToggleEnabled(!props.enabled)
                // 启用即展开：让配置项立即可见（停用收起场景下用户找不到设置的实测投诉）
                if (disabled && !open) setOpen(true)
              }}
            >
              <span className="settings-switch-dot" />
              {disabled ? '已停用' : '已启用'}
            </button>
          ) : null}
          {/* 展开/收起必须是真按钮：此前放在 stopPropagation 容器里，点击被吞（实测缺陷） */}
          <button
            type="button"
            className="settings-fold-btn"
            aria-expanded={open}
            onClick={() => setOpen((v) => !v)}
          >
            <IconChevron className={`settings-fold-chevron${open ? ' is-open' : ''}`} />
            {open ? '收起' : '展开'}
          </button>
        </div>
      </div>
      {/* 折叠只是视觉收起（display:none），组件保持挂载以保留编辑态；未启用时灰显但保留值（§5） */}
      <div className="settings-card-body" style={open ? undefined : { display: 'none' }}>
        <fieldset className="settings-card-fieldset" disabled={disabled}>
          {props.children}
        </fieldset>
      </div>
    </div>
  )
}

export function SettingsZone(props: { title: string; icon?: ReactNode; defaultOpen?: boolean; children?: ReactNode }) {
  const [open, setOpen] = useState(Boolean(props.defaultOpen))
  return (
    <section className="settings-zone">
      <div className="settings-zone-head" onClick={() => setOpen((v) => !v)}>
        {props.icon ? <span className="settings-zone-icon">{props.icon}</span> : null}
        <div className="settings-zone-title">{props.title}</div>
        <button
          type="button"
          className="settings-fold-btn"
          aria-expanded={open}
          onClick={(e) => {
            e.stopPropagation()
            setOpen((v) => !v)
          }}
        >
          <IconChevron className={`settings-fold-chevron${open ? ' is-open' : ''}`} />
          {open ? '收起' : '展开'}
        </button>
      </div>
      <div className="settings-zone-body" style={open ? undefined : { display: 'none' }}>
        {props.children}
      </div>
    </section>
  )
}
