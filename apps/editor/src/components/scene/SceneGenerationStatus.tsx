import type { AiTaskProgress } from '../../api'

type Props = {
  task?: AiTaskProgress | null
  batchDone?: number | null
  batchActive?: boolean
  now: number
}

function stageLabel(stage: string) {
  if (stage === 'queued') return '排队中'
  if (stage === 'loading_refs') return '加载参考图'
  if (stage === 'generating') return 'ComfyUI 出图中'
  if (stage === 'ai_review') return 'AI 视觉评审中'
  if (stage === 'writing') return '写回项目中'
  if (stage === 'waiting_review') return '等待审核'
  if (stage === 'done') return '已完成'
  if (stage === 'cancelled') return '已停止'
  if (stage === 'blocked') return '已阻断'
  if (stage === 'error' || stage === 'failed') return '生成失败'
  return '处理中'
}

function elapsedLabel(task: AiTaskProgress, now: number) {
  const started = Date.parse(task.createdAt)
  if (!Number.isFinite(started)) return ''
  const ended = task.done ? Date.parse(task.updatedAt) : now
  if (!Number.isFinite(ended)) return ''
  const seconds = Math.max(0, Math.round((ended - started) / 1000))
  return seconds < 60 ? `${seconds}秒` : `${Math.floor(seconds / 60)}分${seconds % 60}秒`
}

export default function SceneGenerationStatus(props: Props) {
  const task = props.task || null
  const batchDone = props.batchDone ?? null
  if (!task && batchDone === null) return null
  const error = task && (task.stage === 'error' || task.stage === 'failed' || task.stage === 'blocked' || task.stage === 'cancelled')
  const pending = task && !error && (task.stage === 'waiting_review' || !task.done)
  const tone = error ? 'bad' : pending ? 'pending' : 'ok'
  const label = props.batchActive ? '四张候选出图中' : task ? stageLabel(task.stage) : '准备出图'
  const total = Math.max(0, Number(task?.total || 0))
  const current = Math.max(0, Number(task?.current || 0))
  const percent = total > 0 ? Math.min(100, Math.max(0, Math.round((current / total) * 100))) : 0
  const elapsed = task ? elapsedLabel(task, props.now) : ''
  return (
    <div className={`scene-generation-progress ${tone}`} data-testid="scene-generation-progress" aria-live="polite">
      <div className="scene-generation-progress-head">
        <span className={`ai-storyboard-status ${tone}`}>{label}</span>
        <span className="scene-generation-progress-message">{task?.message || '正在准备第一张候选图'}</span>
        {total > 0 ? <span className="scene-generation-progress-count">{current}/{total}</span> : null}
        {elapsed ? <span className="scene-generation-progress-time">{elapsed}</span> : null}
      </div>
      {batchDone !== null ? (
        <div className="scene-generation-progress-batch">
          四张候选：已完成 {batchDone}/4{props.batchActive ? `，正在处理第 ${Math.min(4, batchDone + 1)} 张` : '，本轮结束'}
        </div>
      ) : null}
      {task && !task.done && total > 0 ? (
        <div className="scene-generation-progress-track" role="progressbar" aria-label="场景出图进度" aria-valuemin={0} aria-valuemax={total} aria-valuenow={current}>
          <span style={{ width: `${percent}%` }} />
        </div>
      ) : null}
    </div>
  )
}
