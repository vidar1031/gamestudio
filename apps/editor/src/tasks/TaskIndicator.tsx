// 全局任务指示器（2026-10-20 用户指令）：talkscene 独立运行时，任何长任务都在界面上可见——
// 进度条/阶段文案/失败原因，不依赖守护台。数据经 /api/ai/tasks 全局台账轮询（活动 3s / 空闲 15s，页面隐藏时暂停）。
import { useEffect, useRef, useState } from 'react'
import { listAllAiTasks, type AiTaskProgress } from '../api'
import './taskIndicator.css'

const KIND_LABELS: Record<string, string> = {
  'story.create': '故事生成',
  'story.scenes.batch': '批量场景出图',
  'story.scenes.render_all': '全量场景渲染',
  'story.scene.render': '场景出图',
  'story.scene.review': '场景图审核',
  'story.scene.layered_produce': '分层出图',
  'story.walkthrough': '走查核实',
  'story.states.generate': '状态变体生成',
  'story.states.extract': '状态提取',
  'story.prop.state_variant': '道具状态变体',
  'story.pose_variants.auto': '姿势变体生成',
  'story.lock_test': '锁定测试',
  'story.craft.carrier_variant': '载体变体生成',
  'story.bible.qc': '圣经质检',
  'story.assets.inherit': '资产继承',
  'story.asset.reference_batch': '参考图抽卡',
  'story.asset.lineart': '线稿生成'
}

function kindLabel(kind: string) {
  return KIND_LABELS[kind] || kind || '任务'
}

function progressOf(t: AiTaskProgress): number | null {
  if (!Number.isFinite(t.total) || t.total <= 0) return null
  return Math.max(0, Math.min(1, t.current / t.total))
}

function failedOf(t: AiTaskProgress) {
  return Boolean(t.done && (t.error || t.stage === 'failed' || t.stage === 'interrupted'))
}

export default function TaskIndicator(props: { onOpenProject?: (projectId: string) => void }) {
  const [tasks, setTasks] = useState<AiTaskProgress[]>([])
  const [open, setOpen] = useState(false)
  const timerRef = useRef(0)

  useEffect(() => {
    let alive = true
    async function poll() {
      if (!alive || document.hidden) return
      try {
        const list = await listAllAiTasks(true)
        if (!alive) return
        setTasks(list.slice(0, 30))
        const hasActive = list.some((t) => !t.done)
        timerRef.current = window.setTimeout(poll, hasActive ? 3000 : 15000)
      } catch {
        if (alive) timerRef.current = window.setTimeout(poll, 15000)
      }
    }
    void poll()
    const onVis = () => {
      if (!document.hidden) void poll()
    }
    document.addEventListener('visibilitychange', onVis)
    return () => {
      alive = false
      window.clearTimeout(timerRef.current)
      document.removeEventListener('visibilitychange', onVis)
    }
  }, [])

  const active = tasks.filter((t) => !t.done)
  const failed = tasks.filter((t) => failedOf(t))
  const recentDone = tasks.filter((t) => t.done && !failedOf(t))
  if (!tasks.length) return null

  return (
    <>
      <button
        type="button"
        className={`task-indicator${failed.length ? ' has-failed' : ''}`}
        onClick={() => setOpen((v) => !v)}
        aria-label="任务进度"
        title="任务进度"
      >
        <span className={`task-indicator-dot${active.length ? ' is-active' : ''}`} />
        任务{active.length ? ` ${active.length}` : ''}
      </button>
      {open ? (
        <>
          <div className="task-panel-mask" onClick={() => setOpen(false)} />
          <div className="task-panel" role="dialog" aria-label="任务进度">
            <div className="task-panel-head">
              <span>任务进度</span>
              <button type="button" className="task-panel-close" onClick={() => setOpen(false)} aria-label="关闭">
                ✕
              </button>
            </div>
            <div className="task-panel-body">
              {active.map((t) => {
                const p = progressOf(t)
                return (
                  <div key={t.taskId} className="task-row" onClick={() => props.onOpenProject?.(t.projectId)} role={props.onOpenProject ? 'button' : undefined}>
                    <div className="task-row-top">
                      <span className="task-row-kind">{kindLabel(t.kind)}</span>
                      <span className="task-row-stage">{t.stage || '进行中'}</span>
                    </div>
                    {p !== null ? (
                      <div className="task-row-bar" aria-hidden="true">
                        <div className="task-row-bar-fill" style={{ width: `${Math.round(p * 100)}%` }} />
                      </div>
                    ) : null}
                    <div className="task-row-msg">
                      {t.message || '进行中…'}
                      {p !== null ? `（${t.current}/${t.total}）` : ''}
                    </div>
                  </div>
                )
              })}
              {failed.map((t) => (
                <div key={t.taskId} className="task-row is-failed" onClick={() => props.onOpenProject?.(t.projectId)} role={props.onOpenProject ? 'button' : undefined}>
                  <div className="task-row-top">
                    <span className="task-row-kind">{kindLabel(t.kind)}</span>
                    <span className="task-row-stage">失败</span>
                  </div>
                  <div className="task-row-msg">{t.error || t.message || '失败'}</div>
                </div>
              ))}
              {recentDone.slice(0, 5).map((t) => (
                <div key={t.taskId} className="task-row is-done" onClick={() => props.onOpenProject?.(t.projectId)} role={props.onOpenProject ? 'button' : undefined}>
                  <div className="task-row-top">
                    <span className="task-row-kind">{kindLabel(t.kind)}</span>
                    <span className="task-row-stage">完成</span>
                  </div>
                </div>
              ))}
              {!active.length && !failed.length && !recentDone.length ? <div className="task-empty">暂无任务</div> : null}
            </div>
          </div>
        </>
      ) : null}
    </>
  )
}
