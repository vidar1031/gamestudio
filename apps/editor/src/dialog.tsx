// 2026-09-16 统一 div 弹窗服务：替代 window.confirm/alert/prompt 等系统原生弹窗。
// 用法：dlgAlert/dlgConfirm/dlgPrompt 返回 Promise；<DialogHost/> 已在 App 根部挂载一次。
import { useEffect, useState, type CSSProperties } from 'react'

type DialogKind = 'alert' | 'confirm' | 'prompt'

type DialogRequest = {
  id: number
  kind: DialogKind
  title: string
  message: string
  okText: string
  cancelText: string
  danger: boolean
  placeholder: string
  defaultValue: string
  resolve: (value: unknown) => void
}

type DialogOptions = {
  title?: string
  okText?: string
  cancelText?: string
  danger?: boolean
  placeholder?: string
  defaultValue?: string
}

let seq = 0
let current: DialogRequest | null = null
const listeners = new Set<(req: DialogRequest | null) => void>()

function emit() {
  for (const fn of listeners) fn(current)
}

function openDialog(kind: DialogKind, message: string, opts: DialogOptions): Promise<unknown> {
  return new Promise((resolve) => {
    current = {
      id: ++seq,
      kind,
      title: String(opts.title || (kind === 'confirm' ? '确认操作' : kind === 'prompt' ? '请输入' : '提示')),
      message: String(message || ''),
      okText: String(opts.okText || '确定'),
      cancelText: String(opts.cancelText || '取消'),
      danger: opts.danger === true,
      placeholder: String(opts.placeholder || ''),
      defaultValue: String(opts.defaultValue || ''),
      resolve
    }
    emit()
  })
}

function closeWith(value: unknown) {
  const req = current
  current = null
  emit()
  req?.resolve(value)
}

/** 提示框（替代 window.alert）：确定关闭 */
export function dlgAlert(message: string, opts: DialogOptions = {}): Promise<void> {
  return openDialog('alert', message, opts) as Promise<void>
}

/** 确认框（替代 window.confirm）：确定=true 取消=false */
export function dlgConfirm(message: string, opts: DialogOptions = {}): Promise<boolean> {
  return openDialog('confirm', message, opts) as Promise<boolean>
}

/** 输入框（替代 window.prompt）：确定返回文本，取消返回 null */
export function dlgPrompt(message: string, opts: DialogOptions = {}): Promise<string | null> {
  return openDialog('prompt', message, opts) as Promise<string | null>
}

const maskStyle: CSSProperties = {
  position: 'fixed',
  inset: 0,
  zIndex: 9999,
  background: 'rgba(2, 6, 23, 0.62)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  padding: 24
}

const cardStyle: CSSProperties = {
  width: 440,
  maxWidth: '100%',
  background: '#0f172a',
  border: '1px solid rgba(148, 163, 184, 0.24)',
  borderRadius: 12,
  boxShadow: '0 18px 50px rgba(0, 0, 0, 0.55)',
  color: '#e2e8f0',
  padding: '18px 20px 16px'
}

const titleStyle: CSSProperties = { fontSize: 15, fontWeight: 600, marginBottom: 10 }

const messageStyle: CSSProperties = {
  fontSize: 13,
  lineHeight: 1.7,
  color: '#cbd5e1',
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word',
  maxHeight: '40vh',
  overflowY: 'auto',
  marginBottom: 14
}

const inputStyle: CSSProperties = {
  width: '100%',
  boxSizing: 'border-box',
  background: '#1e293b',
  border: '1px solid rgba(148, 163, 184, 0.35)',
  borderRadius: 8,
  color: '#e2e8f0',
  fontSize: 13,
  padding: '8px 10px',
  marginBottom: 14,
  outline: 'none'
}

const rowStyle: CSSProperties = { display: 'flex', justifyContent: 'flex-end', gap: 10 }

const btnBase: CSSProperties = {
  minWidth: 76,
  padding: '7px 16px',
  fontSize: 13,
  borderRadius: 8,
  border: '1px solid rgba(148, 163, 184, 0.35)',
  background: '#1e293b',
  color: '#cbd5e1',
  cursor: 'pointer'
}

const btnPrimary: CSSProperties = {
  ...btnBase,
  border: '1px solid rgba(94, 204, 255, 0.55)',
  background: 'rgba(94, 204, 255, 0.16)',
  color: '#5eccff',
  fontWeight: 600
}

const btnDanger: CSSProperties = {
  ...btnBase,
  border: '1px solid rgba(248, 113, 113, 0.55)',
  background: 'rgba(248, 113, 113, 0.14)',
  color: '#f87171',
  fontWeight: 600
}

/** 弹窗宿主：在 App 根部挂载一次；同一时间只展示一个弹窗（与系统弹窗语义一致） */
export function DialogHost() {
  const [req, setReq] = useState<DialogRequest | null>(null)
  const [text, setText] = useState('')

  useEffect(() => {
    const fn = (next: DialogRequest | null) => {
      setReq(next)
      setText(next ? next.defaultValue : '')
    }
    listeners.add(fn)
    return () => {
      listeners.delete(fn)
    }
  }, [])

  useEffect(() => {
    if (!req) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        closeWith(req.kind === 'confirm' ? false : req.kind === 'prompt' ? null : undefined)
      } else if (e.key === 'Enter' && req.kind !== 'prompt') {
        e.stopPropagation()
        closeWith(req.kind === 'confirm' ? true : undefined)
      } else if (e.key === 'Enter' && req.kind === 'prompt') {
        e.stopPropagation()
        closeWith(text)
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [req, text])

  if (!req) return null
  return (
    <div style={maskStyle} onMouseDown={(e) => {
      if (e.target === e.currentTarget) closeWith(req.kind === 'confirm' ? false : req.kind === 'prompt' ? null : undefined)
    }}>
      <div style={cardStyle} role="dialog" aria-modal="true" aria-label={req.title}>
        <div style={titleStyle}>{req.title}</div>
        <div style={messageStyle}>{req.message}</div>
        {req.kind === 'prompt' ? (
          <input
            style={inputStyle}
            value={text}
            placeholder={req.placeholder}
            autoFocus
            onChange={(e) => setText(e.target.value)}
          />
        ) : null}
        <div style={rowStyle}>
          {req.kind !== 'alert' ? (
            <button type="button" style={btnBase} onClick={() => closeWith(req.kind === 'confirm' ? false : null)}>
              {req.cancelText}
            </button>
          ) : null}
          <button
            type="button"
            style={req.danger ? btnDanger : btnPrimary}
            autoFocus={req.kind !== 'prompt'}
            onClick={() => closeWith(req.kind === 'prompt' ? text : req.kind === 'confirm' ? true : undefined)}
          >
            {req.okText}
          </button>
        </div>
      </div>
    </div>
  )
}
