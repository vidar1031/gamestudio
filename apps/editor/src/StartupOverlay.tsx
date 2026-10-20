import { useEffect, useRef, useState } from 'react'
import { STARTUP_READY_EVENT, startupReadyFired } from './startupReady'
import { getStudioSettings, resolveUrl } from './api'

type StepState = 'pending' | 'active' | 'done' | 'error'
type Step = { key: string; label: string; state: StepState; detail: string }

// 2026-10-20 启动屏重做（用户指令）：不再是固定假 loading——逐步展示真实加载项与进度。
// 1) 四步真实探测：连接业务服务(健康检查,带重试) → 加载设置 → 恢复上次现场 → 工作室初始数据(STARTUP_READY_EVENT)；
// 2) 每步独立状态（等待/进行中/完成/失败）与耗时/详情，总进度条 = 完成步数/总步数；
// 3) 服务连接失败不自动放行：红字原因 + 「重试连接」（禁止静默失败）；其余步骤失败标红但继续（Hub 自身有错误态）；
// 4) 400ms 内完成则不绘制（防闪屏）；15s 兜底仅用于请求挂死防永久遮挡。
const STARTUP_SHOW_DELAY_MS = 400
const STARTUP_FAILSAFE_MS = 15_000
const HEALTH_RETRY_INTERVAL_MS = 1_000
const HEALTH_RETRY_LIMIT = 10
const DONE_HOLD_MS = 350

const STEP_DEFS: Array<{ key: string; label: string }> = [
  { key: 'server', label: '连接业务服务' },
  { key: 'settings', label: '加载设置与环境' },
  { key: 'session', label: '恢复上次工作现场' },
  { key: 'workspace', label: '加载项目与工作室数据' }
]

const STAGE_LABELS: Record<string, string> = {
  script: '脚本工作室',
  blueprint: '蓝图工作室',
  compose: '合成工作室'
}

export default function StartupOverlay({ onFinish }: { onFinish?: () => void }) {
  const [visible, setVisible] = useState(true)
  const [painted, setPainted] = useState(false)
  const [steps, setSteps] = useState<Step[]>(STEP_DEFS.map((d) => ({ ...d, state: 'pending' as StepState, detail: '' })))
  const [runId, setRunId] = useState(0)
  const didFinish = useRef(false)

  function patchStep(key: string, patch: Partial<Step>) {
    setSteps((list) => list.map((s) => (s.key === key ? { ...s, ...patch } : s)))
  }

  function finish() {
    if (didFinish.current) return
    didFinish.current = true
    setVisible(false)
    onFinish?.()
  }

  useEffect(() => {
    let cancelled = false

    async function probeServer(): Promise<boolean> {
      patchStep('server', { state: 'active', detail: '' })
      for (let attempt = 1; attempt <= HEALTH_RETRY_LIMIT; attempt++) {
        const startedAt = Date.now()
        try {
          const controller = new AbortController()
          const timer = window.setTimeout(() => controller.abort(), 2500)
          const res = await fetch(resolveUrl('/api/health'), { signal: controller.signal })
          window.clearTimeout(timer)
          if (res.ok) {
            patchStep('server', { state: 'done', detail: `已连接 · ${Date.now() - startedAt}ms` })
            return true
          }
          throw new Error(`http_${res.status}`)
        } catch {
          patchStep('server', {
            state: attempt === HEALTH_RETRY_LIMIT ? 'error' : 'active',
            detail: attempt === HEALTH_RETRY_LIMIT ? '连接失败：服务未启动或仍在启动' : `第 ${attempt} 次尝试…`
          })
        }
        await new Promise((r) => window.setTimeout(r, HEALTH_RETRY_INTERVAL_MS))
        if (cancelled) return false
      }
      return false
    }

    async function run() {
      const serverOk = await probeServer()
      if (cancelled) return
      if (!serverOk) return // 停在失败态等待用户点「重试连接」

      patchStep('settings', { state: 'active' })
      try {
        const { effective } = await getStudioSettings()
        const scripts = effective?.scripts
        patchStep('settings', {
          state: 'done',
          detail: scripts && scripts.provider ? `分镜 ${scripts.provider}${scripts.model ? ` / ${scripts.model}` : ''}` : '配置已加载'
        })
      } catch (e) {
        patchStep('settings', { state: 'error', detail: e instanceof Error ? e.message : String(e) })
      }
      if (cancelled) return

      patchStep('session', { state: 'active' })
      try {
        const stage = localStorage.getItem('talkscene.stage')
        const projectId = localStorage.getItem('talkscene.projectId')
        patchStep('session', {
          state: 'done',
          detail: projectId && stage && STAGE_LABELS[stage] ? `回到${STAGE_LABELS[stage]}` : '回到项目库'
        })
      } catch {
        patchStep('session', { state: 'done', detail: '回到项目库' })
      }

      patchStep('workspace', { state: 'active' })
      const startedAt = Date.now()
      if (startupReadyFired()) {
        patchStep('workspace', { state: 'done', detail: `耗时 ${Date.now() - startedAt}ms` })
      } else {
        await new Promise<void>((resolve) => {
          window.addEventListener(STARTUP_READY_EVENT, () => resolve(), { once: true })
        })
        if (cancelled) return
        patchStep('workspace', { state: 'done', detail: `耗时 ${Date.now() - startedAt}ms` })
      }

      window.setTimeout(() => {
        if (!cancelled) finish()
      }, DONE_HOLD_MS)
    }

    void run()

    const showTimer = window.setTimeout(() => setPainted(true), STARTUP_SHOW_DELAY_MS)
    const failsafe = window.setTimeout(() => {
      // 服务连接失败时保持在场（等用户重试）；其余挂死场景兜底放行并如实标注超时
      setSteps((list) => {
        if (list.find((s) => s.key === 'server')?.state === 'error') return list
        window.setTimeout(finish, 0)
        return list.map((s) => (s.state === 'done' || s.state === 'error' ? s : { ...s, state: 'error' as StepState, detail: '超时' }))
      })
    }, STARTUP_FAILSAFE_MS)

    return () => {
      cancelled = true
      window.clearTimeout(showTimer)
      window.clearTimeout(failsafe)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onFinish, runId])

  if (!visible || !painted) return null

  const doneCount = steps.filter((s) => s.state === 'done').length
  const serverFailed = steps.find((s) => s.key === 'server')?.state === 'error'

  return (
    <div className="startup-overlay">
      <div className="startup-inner" aria-live="polite">
        <div className="startup-orb" />
        <div className="startup-brand">TalkScene</div>
        <div className="startup-sub">织话智坊 · 互动故事生产工具</div>
        <div className="startup-progress" aria-hidden="true">
          <div className="startup-progress-fill" style={{ width: `${(doneCount / steps.length) * 100}%` }} />
        </div>
        <div className="startup-steps">
          {steps.map((s) => (
            <div key={s.key} className={`startup-step is-${s.state}`}>
              <span className="startup-dot" />
              <span className="startup-step-label">{s.label}</span>
              <span className="startup-step-detail">
                {s.detail || (s.state === 'active' ? '进行中…' : s.state === 'pending' ? '等待' : '')}
              </span>
            </div>
          ))}
        </div>
        {serverFailed ? (
          <button className="startup-retry" type="button" onClick={() => setRunId((v) => v + 1)}>
            重试连接
          </button>
        ) : null}
      </div>
    </div>
  )
}
