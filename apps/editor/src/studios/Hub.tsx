import { useEffect, useMemo, useRef, useState } from 'react'
import {
  analyzeProjectScripts,
  createProject,
  createProjectWithAiDetailed,
  deleteProject,
  getGlobalAiRules,
  listProjects,
  regenerateProjectScriptsWithAiDetailed,
  saveGlobalAiRules,
  type AiCreateResult,
  type AiScriptAnalysis,
  type ProjectV1
} from '../api'

const AI_PROMPT_KEY = 'game_studio.ai.prompt'
const AI_TITLE_KEY = 'game_studio.ai.title'
const AI_CHOICE_POINTS_KEY = 'game_studio.ai.choicePoints'
const AI_OPTIONS_PER_CHOICE_KEY = 'game_studio.ai.optionsPerChoice'
const AI_ENDINGS_KEY = 'game_studio.ai.endings'

function clampInt(n: any, min: number, max: number, fallback: number) {
  const v = Number(n)
  if (!Number.isFinite(v)) return fallback
  return Math.max(min, Math.min(max, Math.floor(v)))
}

function normalizeAiFormula(input: { choicePoints: number; optionsPerChoice: number; endings: number }) {
  const choicePoints = clampInt(input.choicePoints, 1, 3, 2)
  const optionsPerChoice = Number(input.optionsPerChoice) === 3 ? 3 : 2
  // Formula rule: endings must equal optionsPerChoice.
  const endings = optionsPerChoice
  return { choicePoints, optionsPerChoice, endings }
}

function validateAiFormula(input: { choicePoints: number; optionsPerChoice: number; endings: number }) {
  const f = normalizeAiFormula(input)
  const ok = f.endings === f.optionsPerChoice && (f.optionsPerChoice === 2 || f.optionsPerChoice === 3)
  return {
    ok,
    message: ok ? '' : '结构公式不合法：当前仅支持每点2或3选，且结局数必须等于每点选项数。'
  }
}

function randomAiFormula() {
  const choicePoints = [1, 2, 3][Math.floor(Math.random() * 3)]
  const optionsPerChoice = [2, 3][Math.floor(Math.random() * 2)]
  const endings = optionsPerChoice
  return { choicePoints, optionsPerChoice, endings }
}

function loadAiDraft(): { title: string; prompt: string; choicePoints: number; optionsPerChoice: number; endings: number } {
  try {
    const f = normalizeAiFormula({
      choicePoints: Number(localStorage.getItem(AI_CHOICE_POINTS_KEY) || 2) || 2,
      optionsPerChoice: Number(localStorage.getItem(AI_OPTIONS_PER_CHOICE_KEY) || 2) || 2,
      endings: Number(localStorage.getItem(AI_ENDINGS_KEY) || 2) || 2
    })
    return {
      title: localStorage.getItem(AI_TITLE_KEY) || '',
      prompt: localStorage.getItem(AI_PROMPT_KEY) || '',
      choicePoints: f.choicePoints,
      optionsPerChoice: f.optionsPerChoice,
      endings: f.endings
    }
  } catch {
    return { title: '', prompt: '', choicePoints: 2, optionsPerChoice: 2, endings: 2 }
  }
}

function persistAiDraft(title: string, prompt: string, choicePoints: number, optionsPerChoice: number, endings: number) {
  try {
    localStorage.setItem(AI_TITLE_KEY, title)
    localStorage.setItem(AI_PROMPT_KEY, prompt)
    localStorage.setItem(AI_CHOICE_POINTS_KEY, String(choicePoints))
    localStorage.setItem(AI_OPTIONS_PER_CHOICE_KEY, String(optionsPerChoice))
    localStorage.setItem(AI_ENDINGS_KEY, String(endings))
  } catch {}
}

function clearAiDraft() {
  try {
    localStorage.removeItem(AI_TITLE_KEY)
    localStorage.removeItem(AI_PROMPT_KEY)
    localStorage.removeItem(AI_CHOICE_POINTS_KEY)
    localStorage.removeItem(AI_OPTIONS_PER_CHOICE_KEY)
    localStorage.removeItem(AI_ENDINGS_KEY)
  } catch {}
}

type Props = {
  onOpenProject: (projectId: string) => void
}

export default function Hub(props: Props) {
  const draft = loadAiDraft()
  const [projects, setProjects] = useState<ProjectV1[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [selectedId, setSelectedId] = useState<string>('')
  const [aiModalOpen, setAiModalOpen] = useState(false)
  const [aiPrompt, setAiPrompt] = useState(draft.prompt)
  const [aiTitle, setAiTitle] = useState(draft.title)
  const [aiChoicePoints, setAiChoicePoints] = useState(draft.choicePoints)
  const [aiOptionsPerChoice, setAiOptionsPerChoice] = useState(draft.optionsPerChoice)
  const [aiEndings, setAiEndings] = useState(draft.endings)
  const [aiResult, setAiResult] = useState<AiCreateResult | null>(null)
  const [aiTab, setAiTab] = useState<'preview' | 'analysis'>('preview')
  const [analysis, setAnalysis] = useState<AiScriptAnalysis | null>(null)
  const [analysisBusy, setAnalysisBusy] = useState(false)
  const [rulesText, setRulesText] = useState('')
  const [rulesError, setRulesError] = useState('')
  const [aiFormulaError, setAiFormulaError] = useState('')
  const [aiElapsedMs, setAiElapsedMs] = useState<number>(0)
  const aiTimerIdRef = useRef<number | null>(null)
  const aiTimerStartedAtRef = useRef<number>(0)
  const aiRequestLockRef = useRef(false)

  function stopAiTimer() {
    if (aiTimerIdRef.current != null) {
      window.clearInterval(aiTimerIdRef.current)
      aiTimerIdRef.current = null
    }
    aiTimerStartedAtRef.current = 0
  }

  function startAiTimer() {
    stopAiTimer()
    const started = Date.now()
    aiTimerStartedAtRef.current = started
    setAiElapsedMs(0)
    aiTimerIdRef.current = window.setInterval(() => {
      setAiElapsedMs(Math.max(0, Date.now() - aiTimerStartedAtRef.current))
    }, 200)
  }

  useEffect(() => () => stopAiTimer(), [])

  const selected = useMemo(() => projects.find((p) => p.id === selectedId) || null, [projects, selectedId])

  async function refresh() {
    setBusy(true)
    setError('')
    try {
      setProjects(await listProjects())
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  useEffect(() => {
    void refresh()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function createNew() {
    const title = window.prompt('新故事名称', '未命名故事')
    if (!title) return

    setBusy(true)
    setError('')
    try {
      const p = await createProject(title)
      await refresh()
      props.onOpenProject(p.id)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  async function createNewWithAi() {
    if (aiRequestLockRef.current) {
      setError('已有生成请求进行中，请等待当前请求返回后再试。')
      return
    }
    const prompt = aiPrompt.trim()
    if (!prompt) {
      setError('请输入提示文本')
      return
    }
    const formulaCheck = validateAiFormula({ choicePoints: aiChoicePoints, optionsPerChoice: aiOptionsPerChoice, endings: aiEndings })
    if (!formulaCheck.ok) {
      setAiFormulaError(formulaCheck.message)
      return
    }

    aiRequestLockRef.current = true
    setBusy(true)
    startAiTimer()
    setError('')
    try {
      const res = await createProjectWithAiDetailed(prompt, aiTitle.trim() || undefined, {
        choicePoints: aiChoicePoints,
        optionsPerChoice: aiOptionsPerChoice,
        endings: aiEndings
      })
      setAiResult(res)
      setAiTab('preview')
      setAnalysis(null)
      setRulesText('')
      setRulesError('')
      await refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
      stopAiTimer()
      aiRequestLockRef.current = false
    }
  }

  async function regenerateAiOverwrite() {
    if (aiRequestLockRef.current) {
      setError('已有生成请求进行中，请等待当前请求返回后再试。')
      return
    }
    const prompt = aiPrompt.trim()
    const pid = aiResult?.project?.id
    if (!pid) return
    if (!prompt) {
      setError('请输入提示文本')
      return
    }
    const formulaCheck = validateAiFormula({ choicePoints: aiChoicePoints, optionsPerChoice: aiOptionsPerChoice, endings: aiEndings })
    if (!formulaCheck.ok) {
      setAiFormulaError(formulaCheck.message)
      return
    }
    const ok = window.confirm(`重新生成将覆盖当前草稿（故事ID：${pid}）的脚本内容，确定继续？`)
    if (!ok) return

    aiRequestLockRef.current = true
    setBusy(true)
    startAiTimer()
    setError('')
    try {
      const res = await regenerateProjectScriptsWithAiDetailed(pid, prompt, aiTitle.trim() || undefined, {
        choicePoints: aiChoicePoints,
        optionsPerChoice: aiOptionsPerChoice,
        endings: aiEndings
      })
      setAiResult(res)
      setAiTab('preview')
      setAnalysis(null)
      setRulesText('')
      setRulesError('')
      await refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
      stopAiTimer()
      aiRequestLockRef.current = false
    }
  }

  async function runAnalysis() {
    const pid = aiResult?.project?.id
    if (!pid) return
    setAnalysisBusy(true)
    setRulesError('')
    try {
      const res = await analyzeProjectScripts(pid)
      setAnalysis(res)
      if (res?.proposedRules) {
        setRulesText(JSON.stringify(res.proposedRules, null, 2))
      } else {
        setRulesText('')
      }
    } catch (e) {
      setRulesError(e instanceof Error ? e.message : String(e))
    } finally {
      setAnalysisBusy(false)
    }
  }

  async function loadCurrentGlobalRules() {
    setAnalysisBusy(true)
    setRulesError('')
    try {
      const r = await getGlobalAiRules()
      setRulesText(r ? JSON.stringify(r, null, 2) : '')
    } catch (e) {
      setRulesError(e instanceof Error ? e.message : String(e))
    } finally {
      setAnalysisBusy(false)
    }
  }

  async function adoptRules() {
    setRulesError('')
    let obj: any = null
    try {
      obj = rulesText.trim() ? JSON.parse(rulesText) : null
    } catch (e) {
      setRulesError(`规则不是合法 JSON：${e instanceof Error ? e.message : String(e)}`)
      return
    }
    if (!obj) {
      setRulesError('规则为空，无法采纳')
      return
    }

    setAnalysisBusy(true)
    try {
      await saveGlobalAiRules(obj)
    } catch (e) {
      setRulesError(e instanceof Error ? e.message : String(e))
    } finally {
      setAnalysisBusy(false)
    }
  }

  async function removeProject(id: string) {
    if (!id) return
    const ok = window.confirm('确定删除该故事草稿？（不可恢复）')
    if (!ok) return

    setBusy(true)
    setError('')
    try {
      await deleteProject(id)
      if (selectedId === id) setSelectedId('')
      await refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="app">
      <div className="topbar">
        <div className="left">
          <div className="title">game_studio · 工作台</div>
          <button className="btn secondary" onClick={() => refresh()} disabled={busy}>
            刷新
          </button>
        </div>
        <div className="right">
          <div className="hint">第一层：脚本 → 第二层：蓝图 → 第三层：合成</div>
        </div>
      </div>

      <div className="main">
        <div className="panel">
          <div className="section">
            <div style={{ fontWeight: 700, marginBottom: 8 }}>故事草稿</div>
            <div className="hint">点击草稿进入脚本层继续编辑。</div>

            <div className="hr" />

            <div className="list">
              {projects.map((p) => (
                <div
                  key={p.id}
                  className={`item ${selectedId === p.id ? 'active' : ''}`}
                  onClick={() => {
                    setSelectedId(p.id)
                    props.onOpenProject(p.id)
                  }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, alignItems: 'center' }}>
                    <div style={{ minWidth: 0 }}>
                      <div style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                        {p.title || p.id}
                      </div>
                      <div className="meta">{p.updatedAt || ''}</div>
                    </div>
                    <button
                      className="btn secondary"
                      style={{ padding: '6px 10px' }}
                      onClick={(e) => {
                        e.stopPropagation()
                        void removeProject(p.id)
                      }}
                      disabled={busy}
                      title="删除草稿"
                    >
                      删除
                    </button>
                  </div>
                </div>
              ))}
              {!projects.length ? <div className="hint">暂无草稿</div> : null}
            </div>

            {error ? <div style={{ marginTop: 10, color: '#fca5a5' }}>{error}</div> : null}
          </div>
        </div>

        <div className="canvas">
          <div className="canvas-wrap">
            <div style={{ width: 'min(860px, calc(100vw - 24px))', padding: 12 }}>
              <div className="hub-card" role="button" tabIndex={0} onClick={() => createNew()}>
                <div className="hub-card-title">+ 创建新故事</div>
                <div className="hub-card-sub">从脚本层开始：写分镜文本 → 生成蓝图 → 合成导出</div>
              </div>

              <div
                className="hub-card"
                role="button"
                tabIndex={0}
                style={{ marginTop: 12, opacity: busy ? 0.7 : 1 }}
                onClick={() => {
                  if (busy) return
                  setAiModalOpen(true)
                  setError('')
                  const d = loadAiDraft()
                  setAiPrompt(d.prompt)
                  setAiTitle(d.title)
                  setAiChoicePoints(d.choicePoints)
                  setAiOptionsPerChoice(d.optionsPerChoice)
                  setAiEndings(d.endings)
                  setAiResult(null)
                  setAiTab('preview')
                  setAnalysis(null)
                  setRulesText('')
                  setRulesError('')
                }}
              >
                <div className="hub-card-title">+ AI 生成新故事（脚本层）</div>
                <div className="hub-card-sub">输入一句提示：自动生成场景脚本草稿（可人工修改）</div>
              </div>

              {selected ? (
                <div style={{ marginTop: 12 }} className="hint">
                  最近选择：{selected.title}（{selected.id}）
                </div>
              ) : null}
            </div>
          </div>
        </div>

        <div className="panel right">
          <div className="section">
            <div style={{ fontWeight: 700, marginBottom: 8 }}>说明</div>
            <div className="hint">
              这是入口层，不编辑内容。请点击“创建新故事”或左侧草稿进入脚本层。
            </div>
            <div className="hr" />
            <div className="hint">P0 重点：脚本 → 蓝图（含 choices + Event 要素）→ 合成（Pixi 预览/导出）。</div>
          </div>
        </div>
      </div>

      {aiModalOpen ? (
        <div className="ai-modal" role="dialog" aria-modal="true" aria-label="AI 生成新故事">
          <div className="ai-modal-card" style={{ width: 860 }}>
            <div className="ai-modal-title">AI 生成新故事（脚本层草稿）</div>
            {!aiResult ? (
                <div className="form">
                  <div className="form-row">
                    <label>故事名称（可选）</label>
                    <input
                      className="input"
                      value={aiTitle}
                      onChange={(e) => {
                        const v = e.target.value
                        setAiTitle(v)
                        persistAiDraft(v, aiPrompt, aiChoicePoints, aiOptionsPerChoice, aiEndings)
                      }}
                      placeholder="留空则自动命名"
                      disabled={busy}
                    />
                  </div>

                  <div className="form-row">
                    <label>结构公式</label>
                    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                      <select
                        className="sel"
                        value={aiChoicePoints}
                        onChange={(e) => {
                          const v = Number(e.target.value) || 2
                          setAiFormulaError('')
                          setAiChoicePoints(v)
                          persistAiDraft(aiTitle, aiPrompt, v, aiOptionsPerChoice, aiEndings)
                        }}
                        disabled={busy}
                        title="选择点数量"
                      >
                        {[1, 2, 3].map((n) => (
                          <option key={n} value={n}>
                            选择点 {n}
                          </option>
                        ))}
                      </select>
                      <select
                        className="sel"
                        value={aiOptionsPerChoice}
                        onChange={(e) => {
                          const v = Number(e.target.value) === 3 ? 3 : 2
                          setAiFormulaError('')
                          // Keep formula valid by construction.
                          setAiOptionsPerChoice(v)
                          setAiEndings(v)
                          persistAiDraft(aiTitle, aiPrompt, aiChoicePoints, v, v)
                        }}
                        disabled={busy}
                        title="每个选择点的选项数"
                      >
                        {[2, 3].map((n) => (
                          <option key={n} value={n}>
                            每点 {n} 选
                          </option>
                        ))}
                      </select>
                      <select
                        className="sel"
                        value={aiEndings}
                        onChange={(e) => {
                          const v = Number(e.target.value) || 2
                          if (v !== aiOptionsPerChoice) {
                            setAiFormulaError('不可设置：结局数量必须等于“每点选项数”。')
                            return
                          }
                          setAiFormulaError('')
                          setAiEndings(v)
                          persistAiDraft(aiTitle, aiPrompt, aiChoicePoints, aiOptionsPerChoice, v)
                        }}
                        disabled={busy}
                        title="结局数量"
                      >
                        {[2, 3].map((n) => (
                          <option key={n} value={n} disabled={n !== aiOptionsPerChoice}>
                            结局 {n}
                          </option>
                        ))}
                      </select>
                      <button
                        className="btn secondary"
                        type="button"
                        disabled={busy}
                        onClick={() => {
                          const r = randomAiFormula()
                          setAiFormulaError('')
                          setAiChoicePoints(r.choicePoints)
                          setAiOptionsPerChoice(r.optionsPerChoice)
                          setAiEndings(r.endings)
                          persistAiDraft(aiTitle, aiPrompt, r.choicePoints, r.optionsPerChoice, r.endings)
                        }}
                        title="随机一个合法结构公式"
                      >
                        随机公式
                      </button>
                      <div className="hint" style={{ alignSelf: 'center' }}>
                        输出格式：选项1..N + i后果k（规则：结局数 = 每点选项数）
                      </div>
                    </div>
                    {aiFormulaError ? <div style={{ marginTop: 8, color: '#fca5a5' }}>{aiFormulaError}</div> : null}
                  </div>

                  <div className="form-row">
                    <label>提示文本</label>
                    <textarea
                      className="textarea"
                      value={aiPrompt}
                      onChange={(e) => {
                        const v = e.target.value
                        setAiPrompt(v)
                        persistAiDraft(aiTitle, v, aiChoicePoints, aiOptionsPerChoice, aiEndings)
                      }}
                      placeholder="例如：写一个《狼来了》风格的互动故事，包含 3 个关键选择点和多个结局（先生成脚本大纲）"
                      style={{ minHeight: 160 }}
                      disabled={busy}
                    />
                  </div>
                </div>
            ) : (
              <>
                <div className="hint" style={{ marginBottom: 10 }}>
                  生成完成：{aiResult.gen?.provider}
                  {aiResult.gen?.model ? ` / ${aiResult.gen.model}` : ''}
                  {typeof aiResult.gen?.durationMs === 'number' ? ` / ${aiResult.gen.durationMs}ms` : ''}
                </div>
                {aiResult.gen?.requestedProvider && aiResult.gen.requestedProvider !== aiResult.gen.provider ? (
                  <div className="hint" style={{ marginBottom: 10, color: '#fde68a' }}>
                    已请求：{aiResult.gen.requestedProvider}，但实际使用：{aiResult.gen.provider}（通常是设置尚未“保存并应用”、未读到环境变量，或 AI 调用失败后回退）。
                  </div>
                ) : null}
                {aiResult.gen?.error && aiResult.gen.error.message ? (
                  <div className="hint" style={{ marginBottom: 10, color: '#fca5a5' }}>
                    AI 调用错误：{aiResult.gen.error.message}
                    {aiResult.gen.error.code ? `（${aiResult.gen.error.code}）` : ''}
                  </div>
                ) : null}
                <div className="hr" />
                <div className="tabs" style={{ paddingLeft: 0, paddingRight: 0 }}>
                  <div className={`tab ${aiTab === 'preview' ? 'active' : ''}`} onClick={() => setAiTab('preview')}>
                    脚本预览
                  </div>
                  <div
                    className={`tab ${aiTab === 'analysis' ? 'active' : ''}`}
                    onClick={() => {
                      setAiTab('analysis')
                      if (!analysis && !analysisBusy) void runAnalysis()
                    }}
                  >
                    结构分析
                  </div>
                </div>

                {aiTab === 'preview' ? (
                  <div className="mini-scroll" style={{ maxHeight: '46vh', overflow: 'auto' }}>
                    {(aiResult.scripts?.cards || []).map((c, idx) => (
                      <div key={c.id || idx} className="card" style={{ marginBottom: 10 }}>
                        <div className="card-title">
                          {idx + 1}. {c.name || '（未命名场景）'}
                        </div>
                        <div className="mini-readonly-text">{c.text || ''}</div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="mini-scroll" style={{ maxHeight: '46vh', overflow: 'auto' }}>
                    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 10 }}>
                      <button className="btn secondary" onClick={() => void runAnalysis()} disabled={analysisBusy}>
                        {analysisBusy ? '分析中…' : '重新分析'}
                      </button>
                      <button className="btn secondary" onClick={() => void loadCurrentGlobalRules()} disabled={analysisBusy} title="加载当前全局规则到编辑框">
                        载入全局规则
                      </button>
                      <button className="btn" onClick={() => void adoptRules()} disabled={analysisBusy || !rulesText.trim()} title="将编辑框中的规则保存为全局规则">
                        采纳为全局规则
                      </button>
                    </div>

                    {rulesError ? <div style={{ marginBottom: 10, color: '#fca5a5' }}>{rulesError}</div> : null}

                    {analysis ? (
                      <>
                        <div className="hint" style={{ marginBottom: 10, color: analysis.ok ? '#a7f3d0' : '#fde68a' }}>
                          {analysis.summary}
                          {analysis.stats ? (
                            <span style={{ opacity: 0.9 }}>
                              {' '}
                              （卡片 {analysis.stats.cardCount ?? '-'} · 选择点 {analysis.stats.choiceCount ?? '-'} · 首选点 {analysis.stats.firstChoiceCard ?? '-'} · 结局{' '}
                              {analysis.stats.endingCount ?? '-'}）
                            </span>
                          ) : null}
                        </div>
                        <div style={{ display: 'grid', gap: 6, marginBottom: 10 }}>
                          {(analysis.checks || []).map((c) => (
                            <div key={c.id} className="hint" style={{ color: c.ok ? '#a7f3d0' : c.severity === 'error' ? '#fca5a5' : '#fde68a' }}>
                              {c.ok ? '✓' : '•'} {c.message}
                            </div>
                          ))}
                        </div>
                        {analysis.suggestions && analysis.suggestions.length ? (
                          <>
                            <div className="hint" style={{ fontWeight: 700, marginBottom: 6 }}>
                              建议
                            </div>
                            <div style={{ display: 'grid', gap: 6, marginBottom: 10 }}>
                              {analysis.suggestions.map((s, i) => (
                                <div key={i} className="hint">
                                  - {s}
                                </div>
                              ))}
                            </div>
                          </>
                        ) : null}
                      </>
                    ) : (
                      <div className="hint">{analysisBusy ? '分析中…' : '暂无分析结果'}</div>
                    )}

                    <div className="hint" style={{ fontWeight: 700, marginBottom: 6 }}>
                      全局规则（JSON，可编辑）
                    </div>
                    <textarea className="textarea" value={rulesText} onChange={(e) => setRulesText(e.target.value)} style={{ minHeight: 220 }} disabled={analysisBusy} />
                  </div>
                )}
              </>
            )}

            {!aiResult && busy ? (
              <div className="hint" style={{ marginBottom: 8 }}>
                生成计时：{(aiElapsedMs / 1000).toFixed(1)}s（等待服务端返回）
              </div>
            ) : null}

            <div className="ai-modal-actions">
              <button
                className="btn secondary"
                onClick={() => {
                  if (aiResult) {
                    setAiResult(null)
                    return
                  }
                  setAiModalOpen(false)
                }}
                disabled={busy}
              >
                {aiResult ? '返回修改提示' : '取消'}
              </button>
              {!aiResult ? (
                <button
                  className="btn secondary"
                  onClick={() => {
                    setAiTitle('')
                    setAiPrompt('')
                    setAiChoicePoints(2)
                    setAiOptionsPerChoice(2)
                    setAiEndings(2)
                    setAiResult(null)
                    clearAiDraft()
                  }}
                  disabled={busy}
                >
                  清空
                </button>
              ) : null}
              {!aiResult ? (
                <button className="btn" onClick={() => void createNewWithAi()} disabled={busy}>
                  {busy ? '生成中…' : '生成'}
                </button>
              ) : (
                <>
                  <button className="btn secondary" onClick={() => void regenerateAiOverwrite()} disabled={busy} title="用当前提示重新生成并覆盖脚本">
                    {busy ? '生成中…' : '重新生成（覆盖）'}
                  </button>
                  <button
                    className="btn"
                    onClick={() => {
                      const id = aiResult.project?.id
                      setAiModalOpen(false)
                      // Keep draft by default (user may want to generate variations).
                      setAiResult(null)
                      if (id) props.onOpenProject(id)
                    }}
                  >
                    进入脚本
                  </button>
                </>
              )}
            </div>
          </div>
        </div>
      ) : null}
    </div>
  )
}
