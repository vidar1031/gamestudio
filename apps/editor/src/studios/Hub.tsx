import { useEffect, useMemo, useRef, useState } from 'react'
import {
  analyzeProjectScripts,
  createProjectWithAiDetailed,
  deleteProject,
  getBlueprint,
  getProject,
  getScripts,
  getStudioSettings,
  getGlobalAiRules,
  listProjects,
  regenerateProjectScriptsWithAiDetailed,
  saveGlobalAiRules,
  type AiCreateResult,
  type AiScriptAnalysis,
  type ProjectV1,
  type StudioEffectiveConfig
} from '../api'

const AI_PROMPT_KEY = 'game_studio.ai.prompt'
const AI_TITLE_KEY = 'game_studio.ai.title'
const AI_CHOICE_POINTS_KEY = 'game_studio.ai.choicePoints'
const AI_OPTIONS_PER_CHOICE_KEY = 'game_studio.ai.optionsPerChoice'
const AI_ENDINGS_KEY = 'game_studio.ai.endings'
const AI_TEMPLATE_KEY = 'game_studio.ai.templateKey'
const AI_TEMPLATE_FIELDS_KEY = 'game_studio.ai.templateFields'

type PromptTemplate = {
  key: string
  name: string
  summary: string
  suggestedFormula: { choicePoints: number; optionsPerChoice: number; endings: number }
}

const PROMPT_TEMPLATES: PromptTemplate[] = [
  { key: 'fable', name: '寓言标准版', summary: '适合“寓意清晰 + 互动选择”', suggestedFormula: { choicePoints: 2, optionsPerChoice: 2, endings: 2 } },
  { key: 'fairy', name: '童话冒险版', summary: '适合“探索旅程 + 轻冲突”', suggestedFormula: { choicePoints: 3, optionsPerChoice: 2, endings: 2 } },
  { key: 'mystery', name: '悬念解谜版', summary: '适合“线索递进 + 反转”', suggestedFormula: { choicePoints: 3, optionsPerChoice: 3, endings: 3 } },
  { key: 'daily', name: '校园日常版', summary: '适合“情绪成长 + 人际关系”', suggestedFormula: { choicePoints: 2, optionsPerChoice: 2, endings: 2 } }
]

type TemplateFields = {
  theme: string
  moral: string
  world: string
  protagonist: string
  style: string
  tone: string
  constraints: string
  extra: string
}

type TemplateTagField = keyof Pick<TemplateFields, 'moral' | 'world' | 'protagonist' | 'style' | 'tone' | 'constraints'>

const TEMPLATE_COMMON_TAGS: Record<TemplateTagField, string[]> = {
  moral: ['诚实守信', '勇敢担当', '善良互助', '守诺负责', '尊重自然', '团结协作'],
  world: ['古代东方村镇', '山林与河谷', '四季分明', '晨雾与暖阳', '童话森林', '市井烟火'],
  protagonist: ['少年主角', '动物伙伴', '师徒同行', '兄妹组合', '旅人角色', '成长型人物'],
  style: ['绘本', '卡通', '国风', '水彩', '剪纸风', '扁平插画'],
  tone: ['温暖积极', '轻松幽默', '温柔治愈', '克制沉稳', '明快节奏', '悬念递进'],
  constraints: ['适合儿童阅读', '避免暴力血腥', '避免恐怖元素', '无现实品牌', '语言简洁易懂', '角色行为可演出']
}

function defaultTemplateFields(): TemplateFields {
  return {
    theme: '',
    moral: '诚实守信，勇敢担当',
    world: '古代东方村镇，山林与河谷，四季分明',
    protagonist: '少年主角，动物伙伴，成长型人物',
    style: '绘本',
    tone: '温暖、积极',
    constraints: '避免暴力血腥，适合儿童阅读',
    extra: ''
  }
}

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

function loadTemplateKey() {
  try {
    const raw = String(localStorage.getItem(AI_TEMPLATE_KEY) || '').trim()
    return PROMPT_TEMPLATES.some((t) => t.key === raw) ? raw : PROMPT_TEMPLATES[0].key
  } catch {
    return PROMPT_TEMPLATES[0].key
  }
}

function loadTemplateFields(): TemplateFields {
  try {
    const raw = localStorage.getItem(AI_TEMPLATE_FIELDS_KEY)
    if (!raw) return defaultTemplateFields()
    const json = JSON.parse(raw) as any
    return {
      theme: String(json?.theme || ''),
      moral: String(json?.moral || ''),
      world: String(json?.world || ''),
      protagonist: String(json?.protagonist || ''),
      style: String(json?.style || '绘本'),
      tone: String(json?.tone || '温暖、积极'),
      constraints: String(json?.constraints || '避免暴力血腥，适合儿童阅读'),
      extra: String(json?.extra || '')
    }
  } catch {
    return defaultTemplateFields()
  }
}

function persistTemplateState(templateKey: string, fields: TemplateFields) {
  try {
    localStorage.setItem(AI_TEMPLATE_KEY, templateKey)
    localStorage.setItem(AI_TEMPLATE_FIELDS_KEY, JSON.stringify(fields))
  } catch {}
}

function buildTemplatePrompt(
  template: PromptTemplate,
  title: string,
  fields: TemplateFields,
  formula: { choicePoints: number; optionsPerChoice: number; endings: number }
) {
  // 故事主题以“故事名称”为唯一来源，避免被历史 theme 缓存覆盖。
  const topic = String(title || '').trim()
  const lines = [
    `模板：${template.name}（${template.summary}）`,
    `故事主题：${topic || '请根据标题和寓意补全'}`,
    `核心寓意：${fields.moral || '在结局明确体现寓意差异'}`,
    `世界观锚点：${fields.world || '请明确时代、地点、季节、天气、建筑风格'}`,
    `主角设定：${fields.protagonist || '请补全主角外观、关键道具、身份动机'}`,
    `视觉风格：${fields.style || '绘本'}`,
    `叙事语气：${fields.tone || '温暖、积极'}`,
    `限制条件：${fields.constraints || '避免暴力血腥，适合儿童阅读'}`,
    `互动结构：选择点 ${formula.choicePoints}，每点 ${formula.optionsPerChoice} 选，结局 ${formula.endings}`,
    `分镜要求：每卡 1-3 句，必须包含可演出动作/环境变化；选择必须有真实后果，不要伪选择`,
    `可视化约束：禁止只写“面临选择/关键节点/后果总结”，必须写可见画面（人物动作、景别、道具、光线）`,
    `生图友好：每个场景可提炼出“主体+动作+场景+光线+镜头+情绪”，并保持角色外观前后一致`,
    `一致性锚点：主角外观（服装/发型/年龄感/关键道具）在所有场景不漂移`,
    `命名约束：选项使用“选项1..N”，后果卡使用“i后果k”，结局使用“结局1..结局N”`,
    `补充说明：${fields.extra || '无'}`
  ]
  return lines.join('\n')
}

type Props = {
  onOpenProject: (projectId: string, stage?: 'script' | 'blueprint' | 'compose') => void
}

type ProjectProgress = {
  scriptsReady: boolean
  blueprintReady: boolean
  composeReady: boolean
  previewReady: boolean
}

export default function Hub(props: Props) {
  const draft = loadAiDraft()
  const [projects, setProjects] = useState<ProjectV1[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [effectiveAi, setEffectiveAi] = useState<StudioEffectiveConfig | null>(null)
  const [aiSettingLogs, setAiSettingLogs] = useState<string[]>([])
  const [selectedId, setSelectedId] = useState<string>('')
  const [selectedProgress, setSelectedProgress] = useState<ProjectProgress | null>(null)
  const [selectedProgressLoading, setSelectedProgressLoading] = useState(false)
  const [aiModalOpen, setAiModalOpen] = useState(false)
  const [aiPrompt, setAiPrompt] = useState(draft.prompt)
  const [aiTitle, setAiTitle] = useState(draft.title)
  const [aiTemplateKey, setAiTemplateKey] = useState(loadTemplateKey())
  const [aiTemplateFields, setAiTemplateFields] = useState<TemplateFields>(loadTemplateFields())
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
  const [templateTagPickers, setTemplateTagPickers] = useState<Record<TemplateTagField, string>>({
    moral: '',
    world: '',
    protagonist: '',
    style: '',
    tone: '',
    constraints: ''
  })
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

  useEffect(() => {
    persistTemplateState(aiTemplateKey, aiTemplateFields)
  }, [aiTemplateKey, aiTemplateFields])

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
      const [items, st] = await Promise.all([listProjects(), getStudioSettings().catch(() => null)])
      setProjects(items)
      if (st && st.effective) setEffectiveAi(st.effective)
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

  async function createNewWithAi() {
    if (aiRequestLockRef.current) {
      setError('已有生成请求进行中，请等待当前请求返回后再试。')
      return
    }
    const title = aiTitle.trim()
    if (!title) {
      setError('请输入故事名称')
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
      const res = await createProjectWithAiDetailed(prompt, title, {
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
    const title = aiTitle.trim()
    if (!title) {
      setError('请输入故事名称')
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
      const res = await regenerateProjectScriptsWithAiDetailed(pid, prompt, title, {
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

  useEffect(() => {
    if (effectiveAi) pushAiSettingLog(effectiveAi, '当前生效')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [effectiveAi])

  const aiTemplate = useMemo(
    () => PROMPT_TEMPLATES.find((t) => t.key === aiTemplateKey) || PROMPT_TEMPLATES[0],
    [aiTemplateKey]
  )

  function applyTemplateToPrompt(nextFormula?: { choicePoints: number; optionsPerChoice: number; endings: number }) {
    const f = normalizeAiFormula(nextFormula || { choicePoints: aiChoicePoints, optionsPerChoice: aiOptionsPerChoice, endings: aiEndings })
    const text = buildTemplatePrompt(aiTemplate, aiTitle, aiTemplateFields, f)
    setAiPrompt(text)
    persistAiDraft(aiTitle, text, f.choicePoints, f.optionsPerChoice, f.endings)
  }

  function mergeTemplateTagValue(raw: string, tag: string) {
    const base = String(raw || '').trim()
    const existing = base
      .split(/[，,]/)
      .map((s) => s.trim())
      .filter(Boolean)
    if (existing.includes(tag)) return base
    return base ? `${base}，${tag}` : tag
  }

  function appendTemplateTag(field: TemplateTagField, tag: string) {
    setAiTemplateFields((prev) => ({
      ...prev,
      [field]: mergeTemplateTagValue(String(prev[field] || ''), tag)
    }))
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
          <div className="hint">分镜 → 蓝图 → 合成</div>
          {selected ? (
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginLeft: 12, flexWrap: 'wrap' }}>
              <button className="btn secondary" disabled={busy} onClick={() => props.onOpenProject(selected.id, 'script')}>
                激活分镜
              </button>
              <button
                className="btn secondary"
                disabled={busy || selectedProgressLoading || !(selectedProgress && selectedProgress.scriptsReady)}
                onClick={() => props.onOpenProject(selected.id, 'blueprint')}
              >
                激活蓝图
              </button>
              <button
                className="btn secondary"
                disabled={busy || selectedProgressLoading || !(selectedProgress && selectedProgress.blueprintReady)}
                onClick={() => props.onOpenProject(selected.id, 'compose')}
              >
                激活合成
              </button>
              <button
                className="btn secondary"
                disabled={busy || selectedProgressLoading || !(selectedProgress && selectedProgress.previewReady)}
                onClick={() => props.onOpenProject(selected.id, 'compose')}
              >
                激活预览
              </button>
              <div className="hint">
                {selectedProgressLoading
                  ? '进度检查中...'
                  : selectedProgress
                    ? `分镜:${selectedProgress.scriptsReady ? '√' : '×'} 蓝图:${selectedProgress.blueprintReady ? '√' : '×'} 合成:${selectedProgress.composeReady ? '√' : '×'}`
                    : ''}
              </div>
            </div>
          ) : null}
        </div>
      </div>

      <div className="main">
        <div className="panel">
          <div className="section">
            <div style={{ fontWeight: 700, marginBottom: 8 }}>故事草稿</div>
            <div className="hint">点击草稿后，可在顶部激活进入分镜/蓝图/合成/预览。</div>

            <div className="hr" />

            <div className="list">
              {projects.map((p) => (
                <div
                  key={p.id}
                  className={`item ${selectedId === p.id ? 'active' : ''}`}
                  onClick={() => {
                    setSelectedId(p.id)
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
            <div style={{ width: 'min(860px, calc(100vw - 24px))', padding: 12, display: 'grid', gap: 12 }}>
              <div
                className="hub-card"
                role="button"
                tabIndex={0}
                style={{ opacity: busy ? 0.7 : 1 }}
                onClick={() => {
                  if (busy) return
                  setAiModalOpen(true)
                  setError('')
                  const d = loadAiDraft()
                  setAiPrompt(d.prompt)
                  setAiTitle(d.title)
                  setAiTemplateKey(loadTemplateKey())
                  setAiTemplateFields(loadTemplateFields())
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
                <div className="hub-card-title">+ AI 创建故事</div>
                <div className="hub-card-sub">基于当前设置的模型生成脚本层分镜草稿</div>
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
            <div className="hint" style={{ fontWeight: 700, marginBottom: 6 }}>设置日志</div>
            <textarea
              readOnly
              value={aiSettingLogs.length ? aiSettingLogs.join('\n') : '(暂无日志)'}
              style={{ minHeight: 130, resize: 'none', width: '100%' }}
            />
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
                    <label>故事名称</label>
                    <input
                      className="input"
                      value={aiTitle}
                      onChange={(e) => {
                        const v = e.target.value
                        setAiTitle(v)
                        persistAiDraft(v, aiPrompt, aiChoicePoints, aiOptionsPerChoice, aiEndings)
                      }}
                      placeholder="请输入故事名称（必填）"
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
                          const text = buildTemplatePrompt(aiTemplate, aiTitle, aiTemplateFields, r)
                          setAiPrompt(text)
                          persistAiDraft(aiTitle, text, r.choicePoints, r.optionsPerChoice, r.endings)
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

                  <div className="form-row">
                    <label>提示模板</label>
                    <div style={{ display: 'grid', gap: 8 }}>
                      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                        <select
                          className="sel"
                          value={aiTemplateKey}
                          onChange={(e) => {
                            const key = e.target.value
                            setAiTemplateKey(key)
                            const t = PROMPT_TEMPLATES.find((x) => x.key === key) || PROMPT_TEMPLATES[0]
                            setAiChoicePoints(t.suggestedFormula.choicePoints)
                            setAiOptionsPerChoice(t.suggestedFormula.optionsPerChoice)
                            setAiEndings(t.suggestedFormula.endings)
                            persistAiDraft(
                              aiTitle,
                              aiPrompt,
                              t.suggestedFormula.choicePoints,
                              t.suggestedFormula.optionsPerChoice,
                              t.suggestedFormula.endings
                            )
                          }}
                          disabled={busy}
                        >
                          {PROMPT_TEMPLATES.map((t) => (
                            <option key={t.key} value={t.key}>
                              {t.name}
                            </option>
                          ))}
                        </select>
                        <button className="btn secondary" type="button" disabled={busy} onClick={() => applyTemplateToPrompt()}>
                          一键生成提示文本
                        </button>
                      </div>
                      <div className="hint">{aiTemplate.summary}</div>
                      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                        <div style={{ display: 'grid', gridTemplateColumns: '1fr 180px', gap: 8 }}>
                          <input
                            className="input"
                            placeholder="核心寓意，如 诚实比聪明更重要"
                            value={aiTemplateFields.moral}
                            onChange={(e) => setAiTemplateFields((v) => ({ ...v, moral: e.target.value }))}
                            disabled={busy}
                          />
                          <select
                            className="sel"
                            value={templateTagPickers.moral}
                            onChange={(e) => {
                              const v = String(e.target.value || '').trim()
                              setTemplateTagPickers((prev) => ({ ...prev, moral: v }))
                              if (!v) return
                              appendTemplateTag('moral', v)
                              setTemplateTagPickers((prev) => ({ ...prev, moral: '' }))
                            }}
                            disabled={busy}
                          >
                            <option value="">寓意标签</option>
                            {TEMPLATE_COMMON_TAGS.moral.map((tag) => (
                              <option key={`moral-${tag}`} value={tag}>
                                {tag}
                              </option>
                            ))}
                          </select>
                        </div>
                        <div style={{ display: 'grid', gridTemplateColumns: '1fr 180px', gap: 8 }}>
                          <input
                            className="input"
                            placeholder="世界观，如 古代山村、秋季、阴天"
                            value={aiTemplateFields.world}
                            onChange={(e) => setAiTemplateFields((v) => ({ ...v, world: e.target.value }))}
                            disabled={busy}
                          />
                          <select
                            className="sel"
                            value={templateTagPickers.world}
                            onChange={(e) => {
                              const v = String(e.target.value || '').trim()
                              setTemplateTagPickers((prev) => ({ ...prev, world: v }))
                              if (!v) return
                              appendTemplateTag('world', v)
                              setTemplateTagPickers((prev) => ({ ...prev, world: '' }))
                            }}
                            disabled={busy}
                          >
                            <option value="">世界观标签</option>
                            {TEMPLATE_COMMON_TAGS.world.map((tag) => (
                              <option key={`world-${tag}`} value={tag}>
                                {tag}
                              </option>
                            ))}
                          </select>
                        </div>
                        <div style={{ display: 'grid', gridTemplateColumns: '1fr 180px', gap: 8 }}>
                          <input
                            className="input"
                            placeholder="主角设定，如 牧童、草帽、竹笛"
                            value={aiTemplateFields.protagonist}
                            onChange={(e) => setAiTemplateFields((v) => ({ ...v, protagonist: e.target.value }))}
                            disabled={busy}
                          />
                          <select
                            className="sel"
                            value={templateTagPickers.protagonist}
                            onChange={(e) => {
                              const v = String(e.target.value || '').trim()
                              setTemplateTagPickers((prev) => ({ ...prev, protagonist: v }))
                              if (!v) return
                              appendTemplateTag('protagonist', v)
                              setTemplateTagPickers((prev) => ({ ...prev, protagonist: '' }))
                            }}
                            disabled={busy}
                          >
                            <option value="">主角标签</option>
                            {TEMPLATE_COMMON_TAGS.protagonist.map((tag) => (
                              <option key={`protagonist-${tag}`} value={tag}>
                                {tag}
                              </option>
                            ))}
                          </select>
                        </div>
                        <div style={{ display: 'grid', gridTemplateColumns: '1fr 180px', gap: 8 }}>
                          <input
                            className="input"
                            placeholder="视觉风格，如 绘本/卡通/国风"
                            value={aiTemplateFields.style}
                            onChange={(e) => setAiTemplateFields((v) => ({ ...v, style: e.target.value }))}
                            disabled={busy}
                          />
                          <select
                            className="sel"
                            value={templateTagPickers.style}
                            onChange={(e) => {
                              const v = String(e.target.value || '').trim()
                              setTemplateTagPickers((prev) => ({ ...prev, style: v }))
                              if (!v) return
                              appendTemplateTag('style', v)
                              setTemplateTagPickers((prev) => ({ ...prev, style: '' }))
                            }}
                            disabled={busy}
                          >
                            <option value="">风格标签</option>
                            {TEMPLATE_COMMON_TAGS.style.map((tag) => (
                              <option key={`style-${tag}`} value={tag}>
                                {tag}
                              </option>
                            ))}
                          </select>
                        </div>
                        <div style={{ display: 'grid', gridTemplateColumns: '1fr 180px', gap: 8 }}>
                          <input
                            className="input"
                            placeholder="叙事语气，如 温暖、幽默"
                            value={aiTemplateFields.tone}
                            onChange={(e) => setAiTemplateFields((v) => ({ ...v, tone: e.target.value }))}
                            disabled={busy}
                          />
                          <select
                            className="sel"
                            value={templateTagPickers.tone}
                            onChange={(e) => {
                              const v = String(e.target.value || '').trim()
                              setTemplateTagPickers((prev) => ({ ...prev, tone: v }))
                              if (!v) return
                              appendTemplateTag('tone', v)
                              setTemplateTagPickers((prev) => ({ ...prev, tone: '' }))
                            }}
                            disabled={busy}
                          >
                            <option value="">语气标签</option>
                            {TEMPLATE_COMMON_TAGS.tone.map((tag) => (
                              <option key={`tone-${tag}`} value={tag}>
                                {tag}
                              </option>
                            ))}
                          </select>
                        </div>
                      </div>
                      <div style={{ display: 'grid', gridTemplateColumns: '1fr 180px', gap: 8 }}>
                        <input
                          className="input"
                          placeholder="限制条件，如 避免恐怖与血腥"
                          value={aiTemplateFields.constraints}
                          onChange={(e) => setAiTemplateFields((v) => ({ ...v, constraints: e.target.value }))}
                          disabled={busy}
                        />
                        <select
                          className="sel"
                          value={templateTagPickers.constraints}
                          onChange={(e) => {
                            const v = String(e.target.value || '').trim()
                            setTemplateTagPickers((prev) => ({ ...prev, constraints: v }))
                            if (!v) return
                            appendTemplateTag('constraints', v)
                            setTemplateTagPickers((prev) => ({ ...prev, constraints: '' }))
                          }}
                          disabled={busy}
                        >
                          <option value="">限制标签</option>
                          {TEMPLATE_COMMON_TAGS.constraints.map((tag) => (
                            <option key={`constraints-${tag}`} value={tag}>
                              {tag}
                            </option>
                          ))}
                        </select>
                      </div>
                      <textarea
                        className="textarea"
                        placeholder="补充说明（可选）：可写你希望突出的人物关系、关键道具、镜头偏好"
                        value={aiTemplateFields.extra}
                        onChange={(e) => setAiTemplateFields((v) => ({ ...v, extra: e.target.value }))}
                        style={{ minHeight: 70 }}
                        disabled={busy}
                      />
                    </div>
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
                    setAiTemplateKey(PROMPT_TEMPLATES[0].key)
                    setAiTemplateFields(defaultTemplateFields())
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
                      if (id) props.onOpenProject(id, 'script')
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
