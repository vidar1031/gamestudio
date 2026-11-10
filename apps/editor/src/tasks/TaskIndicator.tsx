// 全局任务指示器（2026-10-20 用户指令）：talkscene 独立运行时，任何长任务都在界面上可见——
// 进度条/阶段文案/失败原因，不依赖守护台。数据经 /api/ai/tasks 全局台账轮询（活动 3s / 空闲 15s，页面隐藏时暂停）。
// 2026-10-25 任务管理能力：进行中可停止；已结束任务可逐条删除/一键清除（进行中禁止删除，服务端 409 兜底）。
// 每行显示 任务名（中文）/项目归属/进度/已用秒数/耗时/失败原因——信息齐全可管理。
import { useEffect, useRef, useState } from 'react'
import { clearFinishedAiTasks, deleteAiTaskById, listAllAiTasksWithLease, listProjectSummaries, type AiLeaseStatus, type AiTaskProgress, type ControlTaskStatus } from '../api'
import './taskIndicator.css'
import { stopAiTask } from './stopTask'

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
  'story.asset.lineart': '线稿生成',
  'story.asset.model_sheet': '标准系三视图',
  'story.scene.analyze_elements': '场景元素分析',
  'studio.tool.launch': '启动本地服务',
  // 2026-10-27 黑盒治理：文本链入台账（圣经分块/提示词增强/翻译/全局稿）
  'story.bible.generate': '圣经生成',
  'story.pose_states.extract': '姿势需求提取',
  'story.prop_states.extract': '道具状态需求提取',
  'story.assets.normalize_names': '元素名补齐',
  'story.asset.prompt_enhance': '提示词增强',
  'story.prompt.translate': '提示词翻译',
  'story.global_prompt.generate': '全局提示词生成',
  'story.scene.voice': '场景配音',
  'story.background.prompt': '场景提示词生成',
  'story.background.generate': '场景背景出图',
  'story.storyboard.prompt_review': '场景提示词评分',
  'story.blueprint.review': '蓝图 AI 解释',
  'story.pose.prompt': '姿态提示词建议'
}

function kindLabel(kind: string) {
  return KIND_LABELS[kind] || kind || '任务'
}

// 错误码 → 用户语言（2026-10-25 文案纪律：任务面板禁止裸错误码）
const ERR_LABELS: Record<string, string> = {
  missing_story_scene: '该场景还没有故事内容，请先在脚本层解析生成蓝图',
  missing_scene: '该场景不在蓝图结构里',
  resource_scheduler_unreachable: '守护台离线且代理通道已启用：请启动守护台，或到设置把调用通道切为直连',
  tts_disabled: '语音能力未启用（设置 → 语音 TTS）',
  missing_plan: '还没有资产计划，请先做一次场景元素分析'
}
function errorLabel(err: string) {
  const raw = String(err || '')
  for (const [code, label] of Object.entries(ERR_LABELS)) {
    if (raw === code || raw.startsWith(code + ':') || raw.includes(code)) return raw.replace(code, label)
  }
  return raw
}

function progressOf(t: AiTaskProgress): number | null {
  if (!Number.isFinite(t.total) || t.total <= 0) return null
  return Math.max(0, Math.min(1, t.current / t.total))
}

// §13 七态 → 中文/三色（绿=成功 / 黄=排队与等待 / 红=失败与取消 / 蓝=受理与执行中）
const CONTROL_STATE_LABELS: Record<string, string> = {
  received: '已受理', queued: '排队中', processing: '执行中', blocked: '等待外部',
  succeeded: '已成功', failed: '已失败', cancelled: '已取消'
}
const CONTROL_STATE_TONES: Record<string, string> = {
  received: 'pending', queued: 'warn', processing: 'pending', blocked: 'warn',
  succeeded: 'ok', failed: 'bad', cancelled: 'bad'
}
const CONTROL_REASON_LABELS: Record<string, string> = {
  model_switch_required: '等待模型切换', gpu_occupied: '出图独占中', vision_occupied: '视觉评审独占中',
  waiting_review: '等待人工审核', waiting_operator: '等待操作员处置', waiting_project_input: '等待项目补料',
  client_aborted: '客户端取消', operator_cancelled: '操作员取消', superseded: '被取代',
  model_not_approved: '模型未核准', invalid_request: '请求不合法', timeout: '超时',
  resource_swap_unload_failed: '换模卸载失败', resource_swap_load_failed: '换模装载失败'
}

function failedOf(t: AiTaskProgress) {
  if (t.stage === 'cancelled') return false
  return Boolean(t.done && (t.error || t.stage === 'failed' || t.stage === 'interrupted'))
}

function elapsedText(t: AiTaskProgress) {
  const created = Date.parse(t.createdAt)
  if (!Number.isFinite(created)) return ''
  if (!t.done) return `已用 ${Math.max(0, Math.round((Date.now() - created) / 1000))} 秒`
  const end = Date.parse(t.updatedAt)
  return Number.isFinite(end) ? `用时 ${Math.max(0, Math.round((end - created) / 1000))} 秒` : ''
}

export default function TaskIndicator(props: { onOpenProject?: (projectId: string) => void }) {
  const [tasks, setTasks] = useState<AiTaskProgress[]>([])
  const [leaseStatuses, setLeaseStatuses] = useState<AiLeaseStatus[]>([])
  const [controlStatuses, setControlStatuses] = useState<ControlTaskStatus[]>([])
  const [titles, setTitles] = useState<Record<string, string>>({})
  const [open, setOpen] = useState(false)
  const timerRef = useRef(0)
  const stoppingRef = useRef(new Set<string>())
  // 按钮可拖动换位（2026-10-25 用户指令：浮动按钮自由拖放，位置记忆 localStorage）
  const [pos, setPos] = useState<{ right: number; bottom: number }>(() => {
    try {
      const p = JSON.parse(localStorage.getItem('talkscene.taskIndicator.pos') || 'null')
      if (p && Number.isFinite(p.right) && Number.isFinite(p.bottom)) return p
    } catch {}
    return { right: 16, bottom: 16 }
  })
  const dragRef = useRef<{ startX: number; startY: number; right: number; bottom: number; moved: boolean } | null>(null)
  const bodyRef = useRef<HTMLDivElement>(null)
  const topScrollRef = useRef<HTMLDivElement>(null)
  const [needXScroll, setNeedXScroll] = useState(false)
  const [topScrollWidth, setTopScrollWidth] = useState(0)

  async function pollOnce() {
    const { tasks: list, leaseStatuses: leases, controlTaskStatuses: cts } = await listAllAiTasksWithLease(true)
    setTasks(list.slice(0, 30))
    setLeaseStatuses(leases)
    setControlStatuses(cts)
    return list.some((t) => !t.done) || leases.length > 0
  }

  useEffect(() => {
    let alive = true
    async function poll() {
      if (!alive || document.hidden) return
      try {
        const hasActive = await pollOnce()
        if (alive) timerRef.current = window.setTimeout(poll, hasActive ? 3000 : 15000)
      } catch {
        if (alive) timerRef.current = window.setTimeout(poll, 15000)
      }
    }
    void poll()
    listProjectSummaries()
      .then((sums) => {
        if (!alive) return
        const map: Record<string, string> = {}
        for (const s of sums) map[s.id] = s.title || s.id
        setTitles(map)
      })
      .catch(() => {})
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

  async function removeTask(taskId: string) {
    try {
      await deleteAiTaskById(taskId)
      await pollOnce()
    } catch (e) {
      // 进行中任务删除被服务端 409 拒绝——如实提示
      window.alert(e instanceof Error ? e.message : String(e))
    }
  }

  async function stopTask(task: AiTaskProgress) {
    if (stoppingRef.current.has(task.taskId)) return
    stoppingRef.current.add(task.taskId)
    try {
      await stopAiTask(task.taskId, task.projectId)
      await pollOnce()
    } catch (e) {
      window.alert(e instanceof Error ? e.message : String(e))
    } finally {
      stoppingRef.current.delete(task.taskId)
    }
  }

  async function clearFinished() {
    await clearFinishedAiTasks().catch(() => 0)
    await pollOnce()
  }

  const active = tasks.filter((t) => !t.done)
  const failed = tasks.filter((t) => failedOf(t))
  const recentDone = tasks.filter((t) => t.done && !failedOf(t))

  // 拖动：位移 >4px 视为拖动（不触发开合）；松手记忆位置
  function onButtonPointerDown(e: React.PointerEvent) {
    dragRef.current = { startX: e.clientX, startY: e.clientY, right: pos.right, bottom: pos.bottom, moved: false }
    const onMove = (ev: PointerEvent) => {
      const d = dragRef.current
      if (!d) return
      const dx = ev.clientX - d.startX
      const dy = ev.clientY - d.startY
      if (!d.moved && Math.abs(dx) + Math.abs(dy) < 4) return
      d.moved = true
      const next = {
        right: Math.max(0, Math.min(window.innerWidth - 40, d.right - dx)),
        bottom: Math.max(0, Math.min(window.innerHeight - 40, d.bottom - dy))
      }
      setPos(next)
    }
    const onUp = (ev: PointerEvent) => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      const d = dragRef.current
      dragRef.current = null
      if (!d) return
      if (!d.moved) {
        setOpen((v) => !v)
      } else {
        const next = {
          right: Math.max(0, Math.min(window.innerWidth - 40, d.right - (ev.clientX - d.startX))),
          bottom: Math.max(0, Math.min(window.innerHeight - 40, d.bottom - (ev.clientY - d.startY)))
        }
        setPos(next)
        try { localStorage.setItem('talkscene.taskIndicator.pos', JSON.stringify(next)) } catch {}
      }
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  // 面板内容横向溢出检测（顶部同步滚动条用）
  useEffect(() => {
    if (!open) return
    const body = bodyRef.current
    if (!body) return
    const check = () => {
      setNeedXScroll(body.scrollWidth > body.clientWidth + 2)
      setTopScrollWidth(body.scrollWidth)
    }
    check()
    const t = window.setTimeout(check, 300)
    return () => window.clearTimeout(t)
  }, [open, tasks.length])

  if (!tasks.length) return null

  function projectLabel(pid: string) {
    return titles[pid] || (pid === 'studio' ? '（全局）' : '')
  }

  function rowActions(t: AiTaskProgress) {
    if (!t.done) return null
    return (
      <button
        type="button"
        className="task-row-delete"
        title="删除该任务记录"
        aria-label="删除该任务记录"
        onClick={(e) => {
          e.stopPropagation()
          void removeTask(t.taskId)
        }}
      >
        ✕
      </button>
    )
  }

  return (
    <>
      <button
        type="button"
        className={`task-indicator${failed.length ? ' has-failed' : ''}`}
        style={{ right: pos.right, bottom: pos.bottom }}
        onPointerDown={onButtonPointerDown}
        aria-label="任务进度"
        title="任务进度（可拖动换位）"
      >
        <span className={`task-indicator-dot${active.length ? ' is-active' : ''}`} />
        任务{active.length ? ` ${active.length}` : ''}
      </button>
      {open ? (
        <>
          <div className="task-panel-mask" onClick={() => setOpen(false)} />
          <div className="task-panel" role="dialog" aria-label="任务进度" style={{ right: pos.right, bottom: pos.bottom + 44 }}>
            <div className="task-panel-head">
              <span>任务进度</span>
              <span className="task-panel-head-actions">
                {failed.length + recentDone.length ? (
                  <button type="button" className="task-panel-clear" onClick={() => void clearFinished()}>
                    清除已结束
                  </button>
                ) : null}
                <button type="button" className="task-panel-close" onClick={() => setOpen(false)} aria-label="关闭">
                  ✕
                </button>
              </span>
            </div>
            {/* 顶部横向滚动条（2026-10-25 用户指令：内容显示不全时滚动条在上方，不在底部） */}
            {needXScroll ? (
              <div
                className="task-panel-xscroll"
                ref={topScrollRef}
                onScroll={(e) => {
                  if (bodyRef.current) bodyRef.current.scrollLeft = (e.target as HTMLDivElement).scrollLeft
                }}
              >
                <div style={{ width: topScrollWidth, height: 1 }} />
              </div>
            ) : null}
            <div
              className="task-panel-body"
              ref={bodyRef}
              onScroll={(e) => {
                if (topScrollRef.current) topScrollRef.current.scrollLeft = (e.target as HTMLDivElement).scrollLeft
              }}
            >
              {/* 2026-11-09 租约调度态条（守护台资源调度实时态）：排队/换模/获准——三色语义同 §11.6 */}
              {leaseStatuses.length ? (
                <div className="task-lease-strip">
                  {leaseStatuses.map((s) => {
                    const tone = s.phase === 'acquired' ? 'ok' : s.phase === 'queued' ? 'warn' : 'pending'
                    const waitSec = Math.max(0, Math.round((Date.now() - Date.parse(s.since)) / 1000))
                    const pos = s.phase === 'queued' && s.queuePosition > 0 ? ` 第 ${s.queuePosition}/${s.queueLength || s.queuePosition} 位` : ''
                    return (
                      <div key={s.reqId} className="task-lease-row" title={`租约持有者：${s.holder}`}>
                        <span className={`task-lease-badge ${tone}`}>{s.phaseLabel || s.phase}{pos}</span>
                        <span className="task-lease-model">{s.model || s.kind}</span>
                        <span className="task-row-time">已等 {waitSec}s</span>
                      </div>
                    )
                  })}
                </div>
              ) : null}
              {/* 2026-11-09 §13 守护台统一任务状态（七态+reason；租约/需求/求助类请求的受理→终态） */}
              {controlStatuses.length ? (
                <div className="task-lease-strip">
                  {controlStatuses.slice(0, 5).map((s) => {
                    const tone = CONTROL_STATE_TONES[String(s.state)] || 'pending'
                    const label = CONTROL_STATE_LABELS[String(s.state)] || String(s.state)
                    const reason = s.reason ? (CONTROL_REASON_LABELS[String(s.reason)] || String(s.reason)) : ''
                    const prog = s.progress && s.progress.total > 0 ? ` ${s.progress.step}/${s.progress.total}` : ''
                    const staleTag = s.stale ? '（最后已知）' : ''
                    return (
                      <div key={`${s.requestId}-v${s.version}`} className="task-lease-row" title={`${s.requestId} · v${s.version}${s.message ? ` · ${s.message}` : ''}${s.resultRef ? ` · ${s.resultRef}` : ''}`}>
                        <span className={`task-lease-badge ${tone}`}>{label}{reason ? ` · ${reason}` : ''}{prog}{staleTag}</span>
                        <span className="task-lease-model">{s.type || '请求'}{s.model ? ` · ${s.model}` : ''}</span>
                      </div>
                    )
                  })}
                </div>
              ) : null}
              {active.map((t) => {
                const p = progressOf(t)
                return (
                  <div key={t.taskId} className="task-row" onClick={() => props.onOpenProject?.(t.projectId)} role={props.onOpenProject ? 'button' : undefined}>
                    <div className="task-row-top">
                      <span className="task-row-kind">
                        {kindLabel(t.kind)}
                        {projectLabel(t.projectId) ? <span className="task-row-project"> · {projectLabel(t.projectId)}</span> : null}
                      </span>
                      <span className="task-row-stage">
                        {t.stage || '进行中'}
                        <button
                          type="button"
                          className="task-panel-clear"
                          style={{ marginLeft: 8 }}
                          aria-label={`停止${kindLabel(t.kind)}`}
                          title="停止当前任务，并阻止后续队列继续"
                          onClick={(e) => {
                            e.stopPropagation()
                            void stopTask(t)
                          }}
                        >
                          停止
                        </button>
                      </span>
                    </div>
                    {p !== null ? (
                      <div className="task-row-bar" aria-hidden="true">
                        <div className="task-row-bar-fill" style={{ width: `${Math.round(p * 100)}%` }} />
                      </div>
                    ) : null}
                    <div className="task-row-msg">
                      {t.message || '进行中…'}
                      {p !== null ? `（${t.current}/${t.total}）` : ''}
                      <span className="task-row-time">{` · ${elapsedText(t)}`}</span>
                    </div>
                  </div>
                )
              })}
              {failed.map((t) => (
                <div key={t.taskId} className="task-row is-failed" onClick={() => props.onOpenProject?.(t.projectId)} role={props.onOpenProject ? 'button' : undefined}>
                  <div className="task-row-top">
                    <span className="task-row-kind">
                      {kindLabel(t.kind)}
                      {projectLabel(t.projectId) ? <span className="task-row-project"> · {projectLabel(t.projectId)}</span> : null}
                    </span>
                    <span className="task-row-stage">
                      失败{rowActions(t)}
                    </span>
                  </div>
                  <div className="task-row-msg">
                    {t.error ? errorLabel(t.error) : t.message || '失败'}
                    <span className="task-row-time">{` · ${elapsedText(t)}`}</span>
                  </div>
                </div>
              ))}
              {recentDone.slice(0, 5).map((t) => (
                <div key={t.taskId} className="task-row is-done" onClick={() => props.onOpenProject?.(t.projectId)} role={props.onOpenProject ? 'button' : undefined}>
                  <div className="task-row-top">
                    <span className="task-row-kind">
                      {kindLabel(t.kind)}
                      {projectLabel(t.projectId) ? <span className="task-row-project"> · {projectLabel(t.projectId)}</span> : null}
                    </span>
                    <span className="task-row-stage">
                      {t.stage === 'cancelled' ? '已停止' : '完成'}{rowActions(t)}
                    </span>
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
