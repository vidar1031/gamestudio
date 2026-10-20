import type { Dispatch, SetStateAction } from 'react'
import {
  type AiTaskProgress,
  type StoryCompletenessReport
} from '../../../api'

export type CompletenessModalProps = {
  ccBusy: boolean
  ccError: string
  ccReport: StoryCompletenessReport | null
  ccReportFile: string
  ccTask: AiTaskProgress | null
  setCcOpen: Dispatch<SetStateAction<boolean>>
  runCompletenessCheck: () => Promise<void>
  ccScreenshotUrl: (screenshotDir: string, file: string) => string
}

export function CompletenessModal(props: CompletenessModalProps) {
  const {
    ccBusy,
    ccError,
    ccReport,
    ccReportFile,
    ccTask,
    setCcOpen,
    runCompletenessCheck,
    ccScreenshotUrl
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
              <div style={{ fontSize: 18, fontWeight: 700, color: '#e5e7eb' }}>完整度核实</div>
              <button className="btn secondary" onClick={() => setCcOpen(false)}>关闭</button>
            </div>

            {ccError ? <div className="hint" style={{ color: '#fca5a5', marginBottom: 10 }}>{ccError}</div> : null}

            {ccTask && !ccTask.done ? (
              <div style={{ padding: '10px 12px', borderRadius: 10, border: '1px solid rgba(148,163,184,0.25)', background: 'rgba(15,23,42,0.75)', color: '#bfdbfe', fontSize: 13, marginBottom: 10 }}>
                正在核实：{ccTask.message || '准备中'}（{ccTask.current}/{ccTask.total}）
              </div>
            ) : null}

            {ccReport ? (
              <>
                <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap', marginBottom: 6 }}>
                  <div style={{ fontSize: 15, fontWeight: 700, color: ccReport.verdict === 'pass' ? '#86efac' : '#fca5a5' }}>
                    总判定：{ccReport.verdict === 'pass' ? '通过' : '未通过'}
                  </div>
                  <div className="hint">
                    节点 {ccReport.summary.passed}/{ccReport.summary.total} 通过 · 视觉评审{ccAiReviewStatusText(ccReport.aiReviewStatus)}
                    {ccReport.review && ccReport.review.provider ? `（${ccReport.review.provider}${ccReport.review.model ? ` / ${ccReport.review.model}` : ''}）` : ''}
                  </div>
                </div>
                <div className="hint" style={{ marginBottom: 10 }}>
                  核实时间：{ccReport.checkedAt}{ccReportFile ? ` · 报告文件：${ccReportFile}` : ''}
                </div>
                <div style={{ display: 'grid', gap: 10 }}>
                  {(ccReport.nodes || []).map((node) => (
                    <div
                      key={node.nodeId}
                      style={{ display: 'flex', gap: 12, padding: '10px 12px', borderRadius: 10, border: '1px solid rgba(148,163,184,0.25)', background: 'rgba(15,23,42,0.75)' }}
                    >
                      {node.screenshot && ccReport.screenshotDir ? (
                        <img
                          src={ccScreenshotUrl(ccReport.screenshotDir, node.screenshot)}
                          alt={node.name || node.nodeId}
                          title="点击在新窗口查看大图"
                          style={{ width: 96, height: 128, objectFit: 'cover', borderRadius: 8, cursor: 'pointer', flexShrink: 0, border: '1px solid rgba(148,163,184,0.2)' }}
                          onClick={() => window.open(ccScreenshotUrl(ccReport.screenshotDir, node.screenshot), '_blank', 'noopener,noreferrer')}
                        />
                      ) : null}
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                          <span style={{ fontWeight: 700, color: '#e5e7eb' }}>{node.name || node.nodeId}</span>
                          <span className="hint">{node.kind === 'ending' ? '结局' : '场景'}</span>
                          <span className="hint">{node.reachable ? '已到达' : '不可达'}</span>
                          {node.aiReview && node.aiReview.status === 'completed' ? (
                            <span style={{ color: node.aiReview.passed ? '#86efac' : '#fca5a5', fontWeight: 700 }}>
                              视觉评审{node.aiReview.passed ? '通过' : '未通过'}{Number.isFinite(Number(node.aiReview.score)) ? ` ${node.aiReview.score} 分` : ''}
                            </span>
                          ) : (
                            <span className="hint">视觉评审未执行{node.aiReview && node.aiReview.reason ? `：${node.aiReview.reason}` : ''}</span>
                          )}
                        </div>
                        {Array.isArray(node.issues) && node.issues.length ? (
                          <div style={{ marginTop: 6, fontSize: 12, color: '#fca5a5', lineHeight: 1.6 }}>
                            {node.issues.map((issue, idx) => (
                              <div key={idx}>· {issue.message}</div>
                            ))}
                          </div>
                        ) : null}
                        {node.aiReview && node.aiReview.status === 'completed' && Array.isArray(node.aiReview.issues) && node.aiReview.issues.length ? (
                          <div style={{ marginTop: 4, fontSize: 12, color: '#cbd5e1', lineHeight: 1.6 }}>
                            {node.aiReview.issues.map((issue, idx) => (
                              <div key={idx}>· {issue}</div>
                            ))}
                          </div>
                        ) : null}
                        {node.aiReview && node.aiReview.status === 'completed' && node.aiReview.summary ? (
                          <div className="hint" style={{ marginTop: 4 }}>{node.aiReview.summary}</div>
                        ) : null}
                      </div>
                    </div>
                  ))}
                </div>
              </>
            ) : null}
            {!ccReport && !(ccTask && !ccTask.done) && !ccError ? (
              <div className="hint">暂无报告。点击「重新核实」开始一次走查。</div>
            ) : null}

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 14 }}>
              <button className="btn secondary" onClick={() => runCompletenessCheck()} disabled={ccBusy || Boolean(ccTask && !ccTask.done)}>
                {ccTask && !ccTask.done ? '核实中…' : '重新核实'}
              </button>
            </div>
          </div>
        </div>
  )
}

function ccAiReviewStatusText(s: string) {
    if (s === 'completed') return '完成'
    if (s === 'partial') return '部分完成'
    if (s === 'unavailable') return '不可用'
    return '未执行'
  }

