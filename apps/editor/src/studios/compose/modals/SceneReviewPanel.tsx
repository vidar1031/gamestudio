import type { Dispatch, SetStateAction } from 'react'
import {
  type AiTaskProgress,
  type SceneReviewRecord,
  type SceneReviewRound
} from '../../../api'

export type SceneReviewPanelProps = {
  srBusy: boolean
  srError: string
  srRound: SceneReviewRound | null
  srTask: AiTaskProgress | null
  srReworkBusy: string
  setSrOpen: Dispatch<SetStateAction<boolean>>
  runSceneReview: () => Promise<void>
  reworkScene: (record: SceneReviewRecord) => Promise<void>
  confirmScenePass: (record: SceneReviewRecord) => Promise<void>
  srFeedbackStatusOf: (sceneId: string) => string
}

export function SceneReviewPanel(props: SceneReviewPanelProps) {
  const {
    srBusy,
    srError,
    srRound,
    srTask,
    srReworkBusy,
    setSrOpen,
    runSceneReview,
    reworkScene,
    confirmScenePass,
    srFeedbackStatusOf
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
        >
          <div
            style={{
              width: 'min(980px, calc(100vw - 32px))',
              maxHeight: 'calc(100vh - 64px)',
              overflow: 'auto',
              background: 'linear-gradient(180deg, #07163a 0%, #061436 100%)',
              border: '1px solid rgba(96,165,250,0.35)',
              borderRadius: 16,
              boxShadow: '0 24px 60px rgba(0,0,0,0.45)',
              padding: 18
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
              <div style={{ fontSize: 18, fontWeight: 700, color: '#e5e7eb' }}>场景图审核</div>
              <div style={{ display: 'flex', gap: 8 }}>
                <button className="btn secondary" disabled={srBusy || Boolean(srTask && !srTask.done)} onClick={() => void runSceneReview()}>
                  {srBusy ? '提交中…' : '重新审核全部场景'}
                </button>
                <button className="btn secondary" onClick={() => setSrOpen(false)}>关闭</button>
              </div>
            </div>

            {srError ? <div className="hint" style={{ color: '#fca5a5', marginBottom: 10 }}>{srError}</div> : null}

            {srTask && !srTask.done ? (
              <div style={{ padding: '10px 12px', borderRadius: 10, border: '1px solid rgba(148,163,184,0.25)', background: 'rgba(15,23,42,0.75)', color: '#bfdbfe', fontSize: 13, marginBottom: 10 }}>
                正在审核：{srTask.message || '准备中…'}
              </div>
            ) : null}

            {!srRound && !(srTask && !srTask.done) ? (
              <div className="hint" style={{ marginBottom: 10 }}>
                暂无审核记录。点「重新审核全部场景」把每个场景的整图提交守护台审图中心评审（走查截图优先，无走查用绑定背景图）。
              </div>
            ) : null}

            {srRound ? (
              <>
                <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap', marginBottom: 10 }}>
                  <div style={{ fontSize: 14, fontWeight: 700, color: '#e5e7eb' }}>
                    最新一轮：通过 {srRound.summary?.pass ?? 0} · 存疑 {srRound.summary?.suspect ?? 0} · 不合格 {srRound.summary?.fail ?? 0}
                  </div>
                  <div className="hint">{srRound.at ? `评审时间：${srRound.at}` : ''}</div>
                </div>
                <div style={{ display: 'grid', gap: 10 }}>
                  {(srRound.records || []).map((record) => {
                    const feedbackStatus = srFeedbackStatusOf(record.sceneId)
                    return (
                      <div
                        key={record.sceneId}
                        style={{ display: 'flex', gap: 12, padding: '10px 12px', borderRadius: 10, border: '1px solid rgba(148,163,184,0.25)', background: 'rgba(15,23,42,0.75)' }}
                      >
                        {record.thumbnailDataUrl ? (
                          <img
                            src={record.thumbnailDataUrl}
                            alt={record.sceneName || record.sceneId}
                            style={{ width: 96, height: 128, objectFit: 'cover', borderRadius: 8, flexShrink: 0, border: '1px solid rgba(148,163,184,0.2)' }}
                          />
                        ) : (
                          <div style={{ width: 96, height: 128, borderRadius: 8, border: '1px dashed rgba(148,163,184,0.35)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#64748b', fontSize: 11, flexShrink: 0, textAlign: 'center' }}>
                            无缩略图
                          </div>
                        )}
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                            <span style={{ fontWeight: 700, color: '#e5e7eb' }}>{record.sceneName || record.sceneId}</span>
                            <span style={{ color: srVerdictColor(record.verdict), fontWeight: 700 }}>
                              {srVerdictLabel(record.verdict)}{Number.isFinite(Number(record.score)) ? ` ${record.score} 分` : ''}
                            </span>
                            {record.imageSource === 'background_only' ? <span className="hint">背景图（未合成摆位）</span> : null}
                            {feedbackStatus === 'feedback_pending' ? <span style={{ color: '#fbbf24', fontSize: 12 }}>已打回，重出中/待重出</span> : null}
                            {feedbackStatus === 'human_confirmed' ? <span style={{ color: '#86efac', fontSize: 12 }}>已人工确认通过</span> : null}
                          </div>
                          {(record.issues || []).length ? (
                            <div style={{ marginTop: 6 }}>
                              <div style={{ fontSize: 12, fontWeight: 700, color: '#94a3b8', marginBottom: 2 }}>问题清单</div>
                              {(record.issues || []).map((issue, i) => (
                                <div key={i} style={{ fontSize: 12, color: '#fca5a5', lineHeight: 1.6 }}>{issue}</div>
                              ))}
                            </div>
                          ) : null}
                          {(record.suggestions || []).length ? (
                            <div style={{ marginTop: 6 }}>
                              <div style={{ fontSize: 12, fontWeight: 700, color: '#94a3b8', marginBottom: 2 }}>改图建议</div>
                              {(record.suggestions || []).map((suggestion, i) => (
                                <div key={i} style={{ fontSize: 12, color: '#93c5fd', lineHeight: 1.6 }}>{suggestion}</div>
                              ))}
                            </div>
                          ) : null}
                          <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                            {record.verdict !== 'pass' ? (
                              <button
                                className="btn secondary"
                                style={{ fontSize: 12, padding: '4px 10px' }}
                                disabled={Boolean(srReworkBusy)}
                                title="把改图建议合入重出提示词，重新渲染该场景"
                                onClick={() => void reworkScene(record)}
                              >
                                {srReworkBusy === record.sceneId ? '处理中…' : '打回重出'}
                              </button>
                            ) : null}
                            {record.verdict !== 'pass' || feedbackStatus !== 'human_confirmed' ? (
                              <button
                                className="btn secondary"
                                style={{ fontSize: 12, padding: '4px 10px' }}
                                disabled={Boolean(srReworkBusy)}
                                title="人工确认该场景图通过验收"
                                onClick={() => void confirmScenePass(record)}
                              >
                                {srReworkBusy === record.sceneId ? '处理中…' : '确认通过'}
                              </button>
                            ) : null}
                          </div>
                        </div>
                      </div>
                    )
                  })}
                </div>
              </>
            ) : null}
          </div>
        </div>
  )
}

function srVerdictColor(verdict?: string) {
    if (verdict === 'pass') return '#86efac'
    if (verdict === 'suspect') return '#fbbf24'
    return '#fca5a5'
  }

function srVerdictLabel(verdict?: string) {
    if (verdict === 'pass') return '通过'
    if (verdict === 'suspect') return '存疑'
    return '不合格'
  }

