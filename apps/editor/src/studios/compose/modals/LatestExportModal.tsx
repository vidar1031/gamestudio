import type { LatestExportAction } from '../types'

export type LatestExportModalProps = {
  latestExportModal: { open: boolean; mode: 'preview' | 'publish' }
  closeLatestExportModal: (action: LatestExportAction) => void
}

export function LatestExportModal(props: LatestExportModalProps) {
  const {
    latestExportModal,
    closeLatestExportModal
  } = props

  return (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            zIndex: 80,
            display: 'grid',
            placeItems: 'center',
            background: 'rgba(2,6,23,0.82)'
          }}
        >          <div
            style={{
              width: 'min(560px, calc(100vw - 32px))',
              background: 'linear-gradient(180deg, #07163a 0%, #061436 100%)',
              border: '1px solid rgba(96,165,250,0.35)',
              borderRadius: 16,
              boxShadow: '0 24px 60px rgba(0,0,0,0.45)',
              padding: 18
            }}
          >
            <div style={{ fontSize: 20, fontWeight: 700, color: '#e5e7eb', marginBottom: 8 }}>导出确认</div>
            <div style={{ fontSize: 14, color: '#cbd5e1', lineHeight: 1.6 }}>
              已存在 `latest` 导出，当前操作将覆盖之前的预览内容。请选择接下来的动作。
            </div>
            <div
              style={{
                marginTop: 14,
                padding: '10px 12px',
                borderRadius: 10,
                border: '1px solid rgba(148,163,184,0.25)',
                background: 'rgba(15,23,42,0.75)',
                color: '#bfdbfe',
                fontSize: 13
              }}
            >
              当前任务：{latestExportModal.mode === 'publish' ? '导出发布包(H5)' : '导出预览'}
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 16 }}>
              <button className="btn secondary" onClick={() => closeLatestExportModal('cancel')}>
                取消
              </button>
              <button className="btn secondary" onClick={() => closeLatestExportModal('delete')}>
                删除旧导出后继续
              </button>
              <button className="btn" onClick={() => closeLatestExportModal('overwrite')}>
                直接覆盖并继续
              </button>
            </div>
          </div>
        </div>
  )
}
