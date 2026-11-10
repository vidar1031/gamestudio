// 蓝图阶段步骤条（B2+）：固定在中间画布区域底部的六步拆解条（独立底栏，与内容区分开）。
// 用户语言六步：结构确认 → 场景元素分析 → 事物锁定 → 预演 → 占位演示 → 配音。
// 状态语义（2026-10-21 用户实测修正）：完成绿 / 部分完成黄（0<x<总） / 正在执行蓝脉冲（仅当台账真有任务在跑） / 未开始灰 / 跳过暗。
// 正在执行的任务在条内给「正在执行 + 已用秒数（走动）」明示——进度与任务提示不许含糊。
import type { StageStep } from './readiness'

export type StepLiveTask = { kind: string; message: string; createdAt: string; current: number; total: number }

// 任务 kind → 步骤 key（让对应步骤点变蓝脉冲）
const KIND_TO_STEP: Record<string, string> = {
  'story.scene.analyze_elements': 'analyze',
  'story.asset.reference_batch': 'lock',
  'story.lock_test': 'lock',
  'story.asset.lineart': 'lock'
}

type Props = {
  steps: StageStep[]
  onAction: (key: string) => void
  note?: string
  liveTasks?: StepLiveTask[]
}


export default function StageStepper(props: Props) {
  const liveTasks = props.liveTasks || []
  const runningKeys = new Set(liveTasks.map((t) => KIND_TO_STEP[t.kind]).filter(Boolean) as string[])
  return (
    <div className="bp-stepper" role="navigation" aria-label="蓝图阶段步骤">
      {props.steps.map((s, i) => {
        const status = runningKeys.has(s.key) ? 'running' : s.status
        return (
          <div key={s.key} className="bp-step-wrap">
            <button
              type="button"
              className={`bp-step st-${status}`}
              onClick={() => props.onAction(s.key)}
              title={s.count ? `${s.label} · ${s.count}` : s.label}
            >
              <span className="bp-step-dot" />
              <span className="bp-step-label">{s.label}</span>
              {s.count ? <span className="bp-step-count">{s.count}</span> : null}
            </button>
            {i < props.steps.length - 1 ? <span className="bp-step-sep" /> : null}
          </div>
        )
      })}
      {props.note ? <span className="bp-step-note">{props.note}</span> : null}
      {/* P5（2026-10-25 用户指令）：执行中提示统一进任务弹窗管理，步骤条不再内嵌"正在执行"条 */}
    </div>
  )
}
