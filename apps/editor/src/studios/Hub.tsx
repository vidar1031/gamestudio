import { useEffect, useMemo, useRef, useState } from 'react'
import { markStartupReady } from '../startupReady'
import { projectStatus, matchStatusFilter, type HubStatusFilter } from '../hub/projectStatus'
import { formatRelativeTime } from '../hub/relativeTime'
import { coverColor } from '../hub/coverColor'
// 2026-10-20 新建页独立化：草稿历史读写/载入跳转 prefill 抽到 hub/draftHistory.ts 共享
import { AI_DRAFT_HISTORY_KEY, readAiDraftHistory, removeAiDraftHistory, writeCreatePrefill, type AiDraftHistoryItem } from '../hub/draftHistory'
import {
  deleteProject,
  confirmProjectDraft,
  getBlueprint,
  getProject,
  getScripts,
  getStudioSettings,
  listProjects,
  listProjectSummaries,
  resolveUrl,
  type ProjectV1,
  type ProjectSummary,
  type StudioEffectiveConfig
} from '../api'

type Props = {
  onOpenProject: (projectId: string, stage?: 'script' | 'blueprint' | 'compose') => void
  onOpenSettings?: () => void
  onCreateStory?: () => void
}

type ProjectProgress = {
  scriptsReady: boolean
  blueprintReady: boolean
  composeReady: boolean
  previewReady: boolean
}

type InlineConfirmState = {
  open: boolean
  title: string
  message: string
  confirmLabel: string
  cancelLabel: string
  danger: boolean
}

export default function Hub(props: Props) {
  const [projects, setProjects] = useState<ProjectV1[]>([])
  const [summaries, setSummaries] = useState<ProjectSummary[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [effectiveAi, setEffectiveAi] = useState<StudioEffectiveConfig | null>(null)
  const [aiSettingLogs, setAiSettingLogs] = useState<string[]>([])
  const [selectedId, setSelectedId] = useState<string>('')
  const [selectedProgress, setSelectedProgress] = useState<ProjectProgress | null>(null)
  const [selectedProgressLoading, setSelectedProgressLoading] = useState(false)
  const [aiDraftHistory, setAiDraftHistory] = useState<AiDraftHistoryItem[]>([])
  const [draftsBoxOpen, setDraftsBoxOpen] = useState(false)
  // 2026-10-20 画廊版首页：搜索 / 排序 / 状态筛选 / 系统状态抽屉 / 卡片角标菜单
  const [search, setSearch] = useState('')
  const [sortBy, setSortBy] = useState<'updated' | 'title'>('updated')
  const [statusFilter, setStatusFilter] = useState<HubStatusFilter>('all')
  const [railOpen, setRailOpen] = useState(false)
  const [menuForId, setMenuForId] = useState('')
  // 双视图（画廊卡/简洁卡），选择持久化
  const [view, setView] = useState<'gallery' | 'compact'>(() => {
    try {
      return localStorage.getItem('talkscene.hub.view') === 'compact' ? 'compact' : 'gallery'
    } catch {
      return 'gallery'
    }
  })
  const [inlineConfirm, setInlineConfirm] = useState<InlineConfirmState>({
    open: false,
    title: '',
    message: '',
    confirmLabel: '确定',
    cancelLabel: '取消',
    danger: false
  })
  const inlineConfirmResolverRef = useRef<((ok: boolean) => void) | null>(null)

  // 草稿历史在 Hub 挂载时即加载（草稿条目常显）
  useEffect(() => {
    setAiDraftHistory(readAiDraftHistory())
  }, [])

  // 2026-10-05 死条目自动清理：项目列表加载后，草稿历史里 projectId 已不存在的条目直接 prune
  // （覆盖"项目被外部删除/换库"等草稿箱与列表脱耦的情况）
  useEffect(() => {
    if (!projects.length) return
    const alive = new Set(projects.map((p) => p.id))
    const pruned = readAiDraftHistory().filter((x) => alive.has(x.projectId))
    if (pruned.length !== readAiDraftHistory().length) {
      try { localStorage.setItem(AI_DRAFT_HISTORY_KEY, JSON.stringify(pruned)) } catch { /* ignore */ }
      setAiDraftHistory(pruned)
    }
  }, [projects])

  useEffect(() => {
    return () => {
      if (inlineConfirmResolverRef.current) {
        inlineConfirmResolverRef.current(false)
        inlineConfirmResolverRef.current = null
      }
    }
  }, [])

  function askInlineConfirm(input: Partial<InlineConfirmState> & { message: string }) {
    return new Promise<boolean>((resolve) => {
      inlineConfirmResolverRef.current = resolve
      setInlineConfirm({
        open: true,
        title: String(input.title || '请确认'),
        message: String(input.message || '').trim(),
        confirmLabel: String(input.confirmLabel || '确定'),
        cancelLabel: String(input.cancelLabel || '取消'),
        danger: Boolean(input.danger)
      })
    })
  }

  function closeInlineConfirm(ok: boolean) {
    const resolver = inlineConfirmResolverRef.current
    inlineConfirmResolverRef.current = null
    setInlineConfirm((prev) => ({ ...prev, open: false }))
    if (resolver) resolver(ok)
  }

  // 2026-10-20 新建页独立化：?action=ai-create-story 深链改为跳新建页（原为打开弹窗）
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const action = params.get('action') || params.get('open') || ''
    if (!/^ai[-_]?create[-_]?story$/i.test(action)) return
    props.onCreateStory?.()
    params.delete('action')
    params.delete('open')
    const nextSearch = params.toString()
    const nextUrl = `${window.location.pathname}${nextSearch ? `?${nextSearch}` : ''}${window.location.hash}`
    window.history.replaceState(null, '', nextUrl)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const selected = useMemo(() => projects.find((p) => p.id === selectedId) || null, [projects, selectedId])

  useEffect(() => {
    if (!selectedId) {
      setSelectedProgress(null)
      setSelectedProgressLoading(false)
      return
    }
    let cancelled = false
    setSelectedProgressLoading(true)
    ;(async () => {
      try {
        const [proj, scripts, blueprint] = await Promise.all([
          getProject(selectedId),
          getScripts(selectedId),
          getBlueprint(selectedId)
        ])
        if (cancelled) return
        const scriptsReady = Array.isArray(scripts?.cards) && scripts.cards.length > 0
        const blueprintReady = Boolean(
          blueprint &&
            Array.isArray((blueprint as any).nodes) &&
            (blueprint as any).nodes.length > 0 &&
            String((blueprint as any).startNodeId || '').trim()
        )
        const composeReady = Boolean(
          proj &&
            proj.story &&
            Array.isArray((proj.story as any).nodes) &&
            (proj.story as any).nodes.length > 0 &&
            String((proj.story as any).startNodeId || '').trim()
        )
        setSelectedProgress({
          scriptsReady,
          blueprintReady,
          composeReady,
          previewReady: composeReady
        })
      } catch {
        if (!cancelled) {
          setSelectedProgress({
            scriptsReady: false,
            blueprintReady: false,
            composeReady: false,
            previewReady: false
          })
        }
      } finally {
        if (!cancelled) setSelectedProgressLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [selectedId])

  async function refresh() {
    setBusy(true)
    setError('')
    try {
      const [items, st, sums] = await Promise.all([listProjects(), getStudioSettings().catch(() => null), listProjectSummaries().catch(() => [])])
      setProjects(items)
      setSummaries(Array.isArray(sums) ? sums : [])
      if (st && st.effective) setEffectiveAi(st.effective)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
      markStartupReady() // 启动覆盖层按真实加载收尾（重复调用安全）
    }
  }

  useEffect(() => {
    void refresh()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function nowLabel() {
    try {
      return new Date().toLocaleTimeString()
    } catch {
      return String(Date.now())
    }
  }

  function pushAiSettingLog(eff: StudioEffectiveConfig | null | undefined, source = '设置应用') {
    if (!eff) return
    const lines = [
      `${source}：故事分镜=${eff.enabled?.scripts ? `${eff.scripts?.provider || 'none'} / ${eff.scripts?.model || '-'}` : 'none'}`,
      `图像提示词=${eff.enabled?.prompt ? `${eff.prompt?.provider || 'none'} / ${eff.prompt?.model || '-'}` : 'none'}`,
      `图像生成=${eff.enabled?.image ? `${eff.image?.provider || 'none'} / ${eff.image?.model || '-'}` : 'none'}`
    ].join('；')
    const row = `[${nowLabel()}] ${lines}`
    setAiSettingLogs((prev) => [row, ...prev].slice(0, 12))
  }

  useEffect(() => {
    const onUpdated = (ev: Event) => {
      const e = ev as CustomEvent
      const eff = e && e.detail && e.detail.effective ? (e.detail.effective as StudioEffectiveConfig) : null
      if (!eff) return
      setEffectiveAi(eff)
      pushAiSettingLog(eff, '保存并应用成功')
    }
    window.addEventListener('studio-settings-updated', onUpdated as EventListener)
    return () => window.removeEventListener('studio-settings-updated', onUpdated as EventListener)
  }, [])

  // 2026-10-20 新建页独立化：创建/模板/预检逻辑已迁移至 pages/CreateStoryPage.tsx（逐行保留，语义未改）

  // 2026-10-20 新建页独立化：草稿「载入继续生成」改为写 prefill（sessionStorage）后跳新建页；
  // 生成时走同名替换语义（新页内确认后删旧稿），覆盖重出的效果不变。
  async function loadDraftAndJump(item: AiDraftHistoryItem) {
    setError('')
    setBusy(true)
    try {
      let prompt = ''
      try {
        const scriptsData = await getScripts(item.projectId)
        const cards = Array.isArray((scriptsData as any)?.cards) ? (scriptsData as any).cards : []
        prompt = cards.map((c: any) => String(c?.text || '').trim()).filter(Boolean).join('\n')
      } catch (_) { /* getScripts 不可用时回退 story 节点 */ }
      if (!prompt) {
        const data = await getProject(item.projectId)
        prompt = ((data?.story?.nodes || []) as any[])
          .map((n) => String(n?.body?.text || '').trim())
          .filter(Boolean)
          .join('\n')
      }
      writeCreatePrefill({
        title: item.title,
        prompt,
        choicePoints: item.choicePoints,
        optionsPerChoice: item.optionsPerChoice,
        endings: item.optionsPerChoice
      })
      setDraftsBoxOpen(false)
      props.onCreateStory?.()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  // 草稿行渲染：草稿箱弹窗使用
  function renderAiDraftRows() {
    return (
      <div style={{ display: 'grid', gap: 6 }}>
        {aiDraftHistory.map((item) => {
          const alive = projects.some((p) => p.id === item.projectId)
          return (
            <div key={item.projectId} style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <span style={{ color: alive ? '#e5e7eb' : '#94a3b8', fontSize: 13, minWidth: 0, flex: 1 }}>
                {item.title || '（未命名）'}
                <span className="hint" style={{ marginLeft: 8 }}>
                  {item.choicePoints}选点/{item.optionsPerChoice}选 · {String(item.createdAt || '').slice(5, 16).replace('T', ' ')}
                  {alive ? '' : ' · 项目已删除'}
                </span>
              </span>
              {alive ? (
                <>
                  <button className="btn secondary" style={{ padding: '4px 10px', fontSize: 12 }} disabled={busy} onClick={() => void loadDraftAndJump(item)}>
                    载入继续生成
                  </button>
                  <button
                    className="btn secondary"
                    style={{ padding: '4px 10px', fontSize: 12 }}
                    disabled={busy}
                    onClick={() => {
                      // 打开项目 = 用户确认草稿毕业：之后出现在工作台项目列表，同时从草稿箱毕业
                      void confirmProjectDraft(item.projectId)
                        .catch(() => null)
                        .then(() => { removeAiDraftHistory(item.projectId); setAiDraftHistory(readAiDraftHistory()) })
                        .finally(() => { void refresh() })
                      setDraftsBoxOpen(false)
                      props.onOpenProject(item.projectId, 'script')
                    }}
                  >
                    打开项目
                  </button>
                </>
              ) : null}
              <button className="btn secondary" style={{ padding: '4px 10px', fontSize: 12 }} disabled={busy} onClick={() => { removeAiDraftHistory(item.projectId); setAiDraftHistory(readAiDraftHistory()) }}>
                移除
              </button>
            </div>
          )
        })}
      </div>
    )
  }

  async function removeProject(id: string, title?: string) {
    if (!id) return
    // 2026-10-20 缺陷修复：删项目确认文案与对象一致（原来错写"删除故事草稿"）
    const ok = await askInlineConfirm({
      title: '删除项目',
      message: `确定删除项目「${String(title || '').trim() || id}」？此操作不可恢复。`,
      confirmLabel: '删除',
      cancelLabel: '取消',
      danger: true
    })
    if (!ok) return

    setBusy(true)
    setError('')
    try {
      await deleteProject(id)
      // 2026-10-05 删除项目同步清理草稿历史：否则草稿箱留下死条目，且"从列表删了草稿就打不开"的耦合 BUG
      removeAiDraftHistory(id)
      setAiDraftHistory(readAiDraftHistory())
      if (selectedId === id) setSelectedId('')
      await refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  useEffect(() => {
    if (effectiveAi) pushAiSettingLog(effectiveAi, '当前生效')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [effectiveAi])

  // 画廊版首页：搜索/筛选/排序后的可见项目（服务端已按 updatedAt 降序）
  const visibleSummaries = useMemo(() => {
    const q = search.trim().toLowerCase()
    let list = summaries.filter((s) => (s as any).aiDraftStatus !== 'pending')
    if (q) list = list.filter((s) => String(s.title || s.id).toLowerCase().includes(q))
    list = list.filter((s) => matchStatusFilter(s, statusFilter))
    if (sortBy === 'title') list = [...list].sort((a, b) => String(a.title || a.id).localeCompare(String(b.title || b.id), 'zh-Hans-CN'))
    return list
  }, [summaries, search, statusFilter, sortBy])

  // 卡片角标菜单：点击外部收起
  useEffect(() => {
    if (!menuForId) return
    const close = () => setMenuForId('')
    window.addEventListener('click', close)
    return () => window.removeEventListener('click', close)
  }, [menuForId])

  useEffect(() => {
    try {
      localStorage.setItem('talkscene.hub.view', view)
    } catch {}
  }, [view])

  // 封面比例跟随故事横/竖模式（stageConfig.width/height）；缺省竖向 3/4，横屏无尺寸按 16/9
  function coverAspectOf(s: ProjectSummary): string {
    const sc = s.stageConfig
    const w = Number(sc?.width)
    const h = Number(sc?.height)
    if (Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0) return `${w} / ${h}`
    if (String(sc?.orientation || '') === 'landscape') return '16 / 9'
    return '3 / 4'
  }

  function stageTargetOf(s: ProjectSummary): 'script' | 'blueprint' | 'compose' {
    if (s.stage === 'script') return 'script'
    if (s.stage === 'blueprint') return 'blueprint'
    return 'compose'
  }

  return (
    <div className="app">
      <div className="topbar hub-topbar">
        <div className="left">
          <span className="hub-brand-dot" aria-hidden="true" />
          <div className="title">TalkScene · 工作台</div>
        </div>
        <div className="hub-topbar-center">
          <input
            className="hub-search"
            value={search}
            placeholder="搜索故事…"
            onChange={(e) => setSearch(e.target.value)}
            autoComplete="off"
            spellCheck={false}
          />
        </div>
        <div className="right">
          <button className="hub-icon-btn" type="button" title="刷新" onClick={() => refresh()} disabled={busy}>
            ⟳
          </button>
          <button className="hub-icon-btn" type="button" title="系统状态" onClick={() => setRailOpen(true)}>
            ≡
          </button>
          <button className="hub-icon-btn" type="button" title="设置" onClick={() => props.onOpenSettings?.()}>
            设置
          </button>
        </div>
      </div>

      <div className="hub-main">
        <div className="hub-gallery-wrap">
          <div
            className="hub-drafts-row"
            role="button"
            tabIndex={0}
            onClick={() => {
              setAiDraftHistory(readAiDraftHistory())
              setDraftsBoxOpen(true)
            }}
          >
            {aiDraftHistory.length ? (
              <>
                🗂 草稿箱（{aiDraftHistory.length}）<span className="hub-drafts-latest">· 最近：{aiDraftHistory[0]?.title || '（未命名）'}</span>
              </>
            ) : (
              <span className="hub-drafts-empty">🗂 草稿箱 · 暂无草稿</span>
            )}
          </div>

          <div className="hub-toolbar">
            <div className="hub-pills">
              {(
                [
                  ['all', '全部'],
                  ['making', '制作中'],
                  ['done', '已完成'],
                  ['exported', '已导出']
                ] as [HubStatusFilter, string][]
              ).map(([key, label]) => (
                <button
                  key={key}
                  type="button"
                  className={`hub-pill${statusFilter === key ? ' is-active' : ''}`}
                  onClick={() => setStatusFilter(key)}
                >
                  {label}
                </button>
              ))}
            </div>
            <div className="hub-toolbar-right">
              <select className="sel hub-sort" value={sortBy} onChange={(e) => setSortBy(e.target.value === 'title' ? 'title' : 'updated')}>
                <option value="updated">按更新时间</option>
                <option value="title">按名称</option>
              </select>
              <div className="hub-view-switch" role="group" aria-label="视图切换">
                <button
                  type="button"
                  className={`hub-pill${view === 'gallery' ? ' is-active' : ''}`}
                  onClick={() => setView('gallery')}
                >
                  画廊
                </button>
                <button
                  type="button"
                  className={`hub-pill${view === 'compact' ? ' is-active' : ''}`}
                  onClick={() => setView('compact')}
                >
                  简洁
                </button>
              </div>
            </div>
          </div>

          <div className={`hub-gallery${view === 'compact' ? ' hub-gallery--compact' : ''}`}>
            <div
              className={`hub-proj hub-hero-card${view === 'compact' ? ' hub-hero-card--compact' : ''}`}
              role="button"
              tabIndex={0}
              style={{ opacity: busy ? 0.7 : 1 }}
              onClick={() => {
                if (busy) return
                props.onCreateStory?.()
              }}
            >
              <div className="hub-hero-plus">＋</div>
              <div className="hub-hero-card-text">
                <div className="hub-hero-card-title">新建互动故事</div>
                <div className="hub-hero-card-sub">一句话创意，AI 生成可交互故事</div>
              </div>
            </div>
            {visibleSummaries.map((s, idx) => {
              const st = projectStatus(s)
              const cc = coverColor(s.title || s.id)
              const openIt = () => props.onOpenProject(s.id, stageTargetOf(s))
              const menu = (
                <>
                  <button
                    className="hub-proj-menu-btn"
                    type="button"
                    title="更多操作"
                    onClick={(e) => {
                      e.stopPropagation()
                      setMenuForId(menuForId === s.id ? '' : s.id)
                    }}
                  >
                    ⋯
                  </button>
                  {menuForId === s.id ? (
                    <div className="hub-proj-menu" onClick={(e) => e.stopPropagation()}>
                      <button
                        type="button"
                        onClick={() => {
                          setMenuForId('')
                          openIt()
                        }}
                      >
                        打开
                      </button>
                      {s.distUrl ? (
                        <button
                          type="button"
                          onClick={() => {
                            setMenuForId('')
                            window.open(resolveUrl(String(s.distUrl)), '_blank')
                          }}
                        >
                          导出 H5
                        </button>
                      ) : null}
                      <button
                        type="button"
                        className="is-danger"
                        disabled={busy}
                        onClick={() => {
                          setMenuForId('')
                          void removeProject(s.id, s.title)
                        }}
                      >
                        删除
                      </button>
                    </div>
                  ) : null}
                </>
              )
              if (view === 'compact') {
                // 简洁卡：无封面，标题+状态+进度+时间，信息密度近似旧版但更规范
                return (
                  <article
                    key={s.id}
                    className="hub-proj hub-proj--compact"
                    style={{ animationDelay: `${Math.min(idx * 30, 300)}ms` }}
                    role="button"
                    tabIndex={0}
                    onClick={openIt}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') openIt()
                    }}
                  >
                    <div className="hub-proj-compact-head">
                      <div className="hub-proj-title">{s.title || s.id}</div>
                      <span className={`hub-status-pill tone-${st.tone} is-static`}>{st.label}</span>
                      {menu}
                    </div>
                    <div className="hub-proj-time" title={String(s.updatedAt || '').replace('T', ' ').slice(0, 16)}>
                      {formatRelativeTime(s.updatedAt)}
                    </div>
                  </article>
                )
              }
              const coverUrl = s.cover ? resolveUrl(`/project-assets/${s.id}/${s.cover}`) : ''
              return (
                <article
                  key={s.id}
                  className="hub-proj"
                  style={{ animationDelay: `${Math.min(idx * 30, 300)}ms` }}
                  role="button"
                  tabIndex={0}
                  onClick={openIt}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') openIt()
                  }}
                >
                  <div className="hub-proj-cover" style={{ aspectRatio: coverAspectOf(s) }}>
                    {coverUrl ? (
                      <img src={coverUrl} loading="lazy" alt="" style={{ background: cc.background }} />
                    ) : (
                      <div className="hub-proj-colorcover" style={{ background: cc.background }}>
                        <span style={{ color: cc.fg }}>{(s.title || s.id || '？').slice(0, 1)}</span>
                      </div>
                    )}
                    <span className={`hub-status-pill tone-${st.tone}`}>{st.label}</span>
                    {menu}
                    <div className="hub-proj-cta">
                      <span>继续制作</span>
                    </div>
                  </div>
                  <div className="hub-proj-body">
                    <div className="hub-proj-title">{s.title || s.id}</div>
                    <div className="hub-proj-time" title={String(s.updatedAt || '').replace('T', ' ').slice(0, 16)}>
                      {formatRelativeTime(s.updatedAt)}
                    </div>
                  </div>
                </article>
              )
            })}
          </div>
          {!visibleSummaries.length && !busy ? (
            <div className="hint" style={{ marginTop: 12 }}>
              {summaries.length ? '没有匹配的故事，调整搜索或筛选。' : '暂无故事项目，从「新建互动故事」开始。'}
            </div>
          ) : null}
          {error ? <div style={{ marginTop: 10, color: '#fca5a5' }}>{error}</div> : null}
        </div>
      </div>

      {railOpen ? (
        <>
          <div className="hub-drawer-mask" onClick={() => setRailOpen(false)} />
          <aside className="hub-drawer" aria-label="系统状态">
            <div className="hub-drawer-head">
              <span>系统状态</span>
              <button className="hub-icon-btn" type="button" title="关闭" onClick={() => setRailOpen(false)}>
                ✕
              </button>
            </div>
            <div className="hub-drawer-body">
              <div className="hub-rail-section">
                <div className="hint" style={{ fontWeight: 700, marginBottom: 6 }}>
                  环境状态
                </div>
                {effectiveAi ? (
                  <div className="hub-rail-kv">
                    <div>
                      文本模型 {effectiveAi.enabled?.scripts ? '✓' : '✗'}
                      <span>{effectiveAi.enabled?.scripts ? `${effectiveAi.scripts?.provider || 'none'} / ${effectiveAi.scripts?.model || '-'}` : '未配置'}</span>
                    </div>
                    <div>
                      图像服务 {effectiveAi.enabled?.image ? '✓' : '✗'}
                      <span>{effectiveAi.enabled?.image ? `${effectiveAi.image?.provider || 'none'}` : '未配置'}</span>
                    </div>
                  </div>
                ) : (
                  <div className="hint">读取中…</div>
                )}
              </div>
              <div className="hub-rail-section">
                <div className="hint" style={{ fontWeight: 700, marginBottom: 6 }}>
                  最近动态
                </div>
                <div className="hub-activity">
                  {summaries.slice(0, 5).map((s) => (
                    <div
                      key={s.id}
                      role="button"
                      tabIndex={0}
                      style={{ cursor: 'pointer' }}
                      onClick={() => {
                        setRailOpen(false)
                        props.onOpenProject(s.id, stageTargetOf(s))
                      }}
                    >
                      {s.title || s.id} · {projectStatus(s).label}
                    </div>
                  ))}
                  {!summaries.length ? <div className="hint">暂无动态</div> : null}
                </div>
              </div>
              <div className="hub-rail-section">
                <details>
                  <summary className="hint" style={{ cursor: 'pointer', fontWeight: 700 }}>
                    诊断日志
                  </summary>
                  {/* 2026-10-20 缺陷修复：诊断日志 textarea 深色样式（原来白底破相） */}
                  <textarea className="hub-diag-log" readOnly value={aiSettingLogs.length ? aiSettingLogs.join('\n') : '（暂无日志）'} />
                </details>
              </div>
            </div>
          </aside>
        </>
      ) : null}

      {draftsBoxOpen ? (
        <div className="ai-modal" role="dialog" aria-modal="true" aria-label="草稿箱">
          <div className="ai-modal-card" style={{ width: 'min(760px, calc(100vw - 32px))', maxHeight: 'calc(100vh - 24px)' }}>
            <div className="ai-modal-title">草稿箱（{aiDraftHistory.length}）</div>
            <div className="hint" style={{ marginBottom: 10 }}>
              AI 生成中途放弃或待确认的故事都收在这里：载入继续生成（覆盖重出）或打开项目（确认毕业进项目列表）。
            </div>
            {aiDraftHistory.length ? (
              renderAiDraftRows()
            ) : (
              <div className="hint">暂无草稿。生成后未确认的故事会自动收进草稿箱。</div>
            )}
            <div className="ai-modal-actions">
              <button className="btn secondary" onClick={() => setDraftsBoxOpen(false)} disabled={busy}>
                关闭
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {inlineConfirm.open ? (
        <div
          className="ai-modal"
          role="dialog"
          aria-modal="true"
          aria-label={inlineConfirm.title || '请确认'}
          style={{ zIndex: 80, background: 'rgba(3, 7, 18, 0.74)' }}
        >
          <div
            className="ai-modal-card"
            style={{
              width: 520,
              maxWidth: 'calc(100vw - 32px)',
              borderColor: inlineConfirm.danger ? 'rgba(239, 68, 68, 0.35)' : undefined
            }}
          >
            <div className="ai-modal-title" style={{ marginBottom: 10 }}>
              {inlineConfirm.title}
            </div>
            <div className="hint" style={{ whiteSpace: 'pre-wrap', lineHeight: 1.7, marginBottom: 16 }}>
              {inlineConfirm.message}
            </div>
            <div className="ai-modal-actions">
              <button className="btn secondary" type="button" onClick={() => closeInlineConfirm(false)}>
                {inlineConfirm.cancelLabel}
              </button>
              <button
                className="btn"
                type="button"
                onClick={() => closeInlineConfirm(true)}
                style={inlineConfirm.danger ? { background: '#dc2626' } : undefined}
              >
                {inlineConfirm.confirmLabel}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  )
}
