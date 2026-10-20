import type { Dispatch, MutableRefObject, SetStateAction } from 'react'

export type StoryboardOverrideModalProps = {
  sbOverrideModal: { open: boolean; message: string }
  setSbOverrideModal: Dispatch<SetStateAction<{ open: boolean; message: string }>>
  sbOverrideResolverRef: MutableRefObject<((ok: boolean) => void) | null>
}

export function StoryboardOverrideModal(props: StoryboardOverrideModalProps) {
  const {
    sbOverrideModal,
    setSbOverrideModal,
    sbOverrideResolverRef
  } = props

  return (
        <div
          role="dialog"
          aria-modal="true"
          style={{
            position: 'fixed',
            inset: 0,
            zIndex: 200,
            display: 'grid',
            placeItems: 'center',
            background: 'rgba(2,6,23,0.82)'
          }}
        >
          <div
            style={{
              width: 'min(560px, calc(100vw - 32px))',
              background: 'linear-gradient(180deg, #07163a 0%, #061436 100%)',
              border: '1px solid rgba(96,165,250,0.35)',
              borderRadius: 16,
              boxShadow: '0 24px 60px rgba(0,0,0,0.45)',
              padding: 18
            }}
          >
            <div style={{ fontSize: 20, fontWeight: 700, color: '#e5e7eb', marginBottom: 8 }}>人工特批确认</div>
            <div
              style={{
                padding: '10px 12px',
                borderRadius: 10,
                border: '1px solid rgba(248,113,113,0.35)',
                background: 'rgba(15,23,42,0.75)',
                color: '#fca5a5',
                fontSize: 13,
                lineHeight: 1.6
              }}
            >
              {sbOverrideModal.message}
            </div>
            <div style={{ fontSize: 14, color: '#cbd5e1', lineHeight: 1.6, marginTop: 12 }}>
              AI 评审未通过该候选图。是否人工确认，仍将该图设为主参考？此操作会记录人工特批。
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 16 }}>
              <button
                className="btn secondary"
                onClick={() => {
                  const resolver = sbOverrideResolverRef.current
                  sbOverrideResolverRef.current = null
                  setSbOverrideModal({ open: false, message: '' })
                  if (resolver) resolver(false)
                }}
              >
                取消
              </button>
              <button
                className="btn"
                onClick={() => {
                  const resolver = sbOverrideResolverRef.current
                  sbOverrideResolverRef.current = null
                  setSbOverrideModal({ open: false, message: '' })
                  if (resolver) resolver(true)
                }}
              >
                人工确认，设为主参考
              </button>
            </div>
          </div>
        </div>
  )
}
