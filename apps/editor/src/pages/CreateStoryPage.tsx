// 新建互动故事页（2026-10-20，UI 设计规范 §7：主流程页内化，替代原全屏弹窗）。
// 结构：页首返回 / hero 引导 / 主输入（创意）+ 名称（可选，留空自动起名）+ 生成主按钮 /
// 高级选项折叠区（结构公式、AI 模板、提示词预检——既有逻辑从 Hub 创建弹窗逐行迁移）/
// 生成中进度卡（秒表 + 取消=AbortController）/ 成功态 / 失败态。
// 草稿「载入继续生成」经 sessionStorage prefill 回填（hub/draftHistory.ts）。
import { useEffect, useMemo, useRef, useState } from 'react'
import {
  confirmProjectDraft,
  createProjectWithAiDetailed,
  deleteProject,
  deleteStoryPromptTemplate,
  generateStoryPromptTemplateWithAi,
  getControlLink,
  getStudioSettings,
  listProjects,
  listStoryPromptTemplates,
  reviewStoryPrompt,
  saveStoryPromptTemplate,
  type ProjectV1,
  type StoryPromptTemplateItem,
  type StoryPromptReview
} from '../api'
import { consumeCreatePrefill, recordAiDraftHistory, removeAiDraftHistory } from '../hub/draftHistory'

// ---- 以下模块级助手自 Hub.tsx 创建弹窗逐行迁移（公式/模板/表单持久化），语义未改 ----
const AI_PROMPT_KEY = 'talkscene.ai.prompt'
const AI_TITLE_KEY = 'talkscene.ai.title'
const AI_CHOICE_POINTS_KEY = 'talkscene.ai.choicePoints'
const AI_OPTIONS_PER_CHOICE_KEY = 'talkscene.ai.optionsPerChoice'
const AI_ENDINGS_KEY = 'talkscene.ai.endings'

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

function pickAutoPromptTemplate(formula: { choicePoints: number; optionsPerChoice: number; endings: number }) {
  const f = normalizeAiFormula(formula)
  if (f.choicePoints === 1) return PROMPT_TEMPLATES.find((t) => t.key === 'fable') || PROMPT_TEMPLATES[0]
  if (f.choicePoints === 3 && f.optionsPerChoice === 3) return PROMPT_TEMPLATES.find((t) => t.key === 'mystery') || PROMPT_TEMPLATES[0]
  if (f.choicePoints === 3) return PROMPT_TEMPLATES.find((t) => t.key === 'fairy') || PROMPT_TEMPLATES[0]
  return PROMPT_TEMPLATES.find((t) => t.key === 'fable') || PROMPT_TEMPLATES[0]
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

function normalizeStoryTitle(value: string) {
  return String(value || '').trim().replace(/\s+/g, ' ')
}

function normalizePromptText(value: string) {
  return String(value || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim()
}

type Phase = 'form' | 'generating' | 'success' | 'error'

type Props = {
  onBack: () => void
  onCreated: (projectId: string) => void
  onOpenSettings?: () => void
}

export default function CreateStoryPage(props: Props) {
  const initial = useMemo(() => loadAiDraft(), [])
  const [phase, setPhase] = useState<Phase>('form')
  const [err, setErr] = useState('')
  const [notice, setNotice] = useState('')

  const [aiPrompt, setAiPrompt] = useState(initial.prompt)
  const [aiTitle, setAiTitle] = useState(initial.title)
  const [aiChoicePoints, setAiChoicePoints] = useState(initial.choicePoints)
  const [aiOptionsPerChoice, setAiOptionsPerChoice] = useState(initial.optionsPerChoice)
  const [aiEndings, setAiEndings] = useState(initial.endings)
  const [aiFormulaError, setAiFormulaError] = useState('')
  const [advancedOpen, setAdvancedOpen] = useState(false)

  const [projects, setProjects] = useState<ProjectV1[]>([])
  const [savedPromptTemplates, setSavedPromptTemplates] = useState<StoryPromptTemplateItem[]>([])
  const [savedTemplateId, setSavedTemplateId] = useState<string>('')
  const [templateGenBusy, setTemplateGenBusy] = useState(false)
  const [templateGenError, setTemplateGenError] = useState('')
  const [promptReview, setPromptReview] = useState<StoryPromptReview | null>(null)
  const [promptReviewBusy, setPromptReviewBusy] = useState(false)
  const [promptReviewError, setPromptReviewError] = useState('')
  const [promptReviewApplied, setPromptReviewApplied] = useState<'ai' | 'local' | ''>('')
  const [promptApplyNote, setPromptApplyNote] = useState('')

  const [aiElapsedMs, setAiElapsedMs] = useState<number>(0)
  const [genMeta, setGenMeta] = useState<any>(null)
  const [resultId, setResultId] = useState('')
  const [resultTitle, setResultTitle] = useState('')
  // 2026-10-20 执行路径（生成态进度卡显示）与守护台离线引导（失败态）
  const [execPath, setExecPath] = useState('')
  const [controlOffline, setControlOffline] = useState(false)

  const promptInputRef = useRef<HTMLTextAreaElement | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  const aiTimerIdRef = useRef<number | null>(null)
  const aiTimerStartedAtRef = useRef<number>(0)
  const lastAutoPromptRef = useRef<string>(initial.prompt.startsWith('模板：') ? initial.prompt : '')

  function stopAiTimer() {
    if (aiTimerIdRef.current != null) {
      window.clearInterval(aiTimerIdRef.current)
      aiTimerIdRef.current = null
    }
    aiTimerStartedAtRef.current = 0
  }

  function startAiTimer() {
    stopAiTimer()
    aiTimerStartedAtRef.current = Date.now()
    setAiElapsedMs(0)
    aiTimerIdRef.current = window.setInterval(() => {
      setAiElapsedMs(Math.max(0, Date.now() - aiTimerStartedAtRef.current))
    }, 200)
  }

  useEffect(
    () => () => {
      stopAiTimer()
      abortRef.current?.abort()
    },
    []
  )

  // 挂载：消费草稿 prefill（优先于 localStorage 表单记忆）；拉模板清单与项目列表（同名检测用）；主输入自动聚焦
  useEffect(() => {
    const pre = consumeCreatePrefill()
    if (pre) {
      setAiTitle(pre.title)
      setAiPrompt(pre.prompt)
      setAiChoicePoints(pre.choicePoints)
      setAiOptionsPerChoice(pre.optionsPerChoice)
      setAiEndings(pre.endings)
      persistAiDraft(pre.title, pre.prompt, pre.choicePoints, pre.optionsPerChoice, pre.endings)
      setNotice(pre.title ? `已载入草稿「${pre.title}」，点击生成将替换同名旧稿。` : '已载入草稿，点击生成将替换同名旧稿。')
    }
    void reloadTemplates()
    void listProjects()
      .then((items) => setProjects(items))
      .catch(() => {})
    try {
      promptInputRef.current?.focus()
    } catch {}
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function reloadTemplates() {
    try {
      const templates = await listStoryPromptTemplates()
      setSavedPromptTemplates(Array.isArray(templates) ? templates : [])
      setSavedTemplateId((prev) => {
        if (prev && Array.isArray(templates) && templates.some((x) => x.id === prev)) return prev
        return Array.isArray(templates) && templates[0] ? String(templates[0].id || '') : ''
      })
    } catch (_) {}
  }

  const autoTemplate = useMemo(
    () => pickAutoPromptTemplate({ choicePoints: aiChoicePoints, optionsPerChoice: aiOptionsPerChoice, endings: aiEndings }),
    [aiChoicePoints, aiOptionsPerChoice, aiEndings]
  )

  function deriveTitle(prompt: string) {
    const first = normalizeStoryTitle(String(prompt || '').split('\n')[0] || '')
    return first.slice(0, 12) || '未命名故事'
  }

  async function generate() {
    const prompt = aiPrompt.trim()
    if (!prompt) return
    const title = aiTitle.trim() || deriveTitle(aiPrompt)
    const formulaCheck = validateAiFormula({ choicePoints: aiChoicePoints, optionsPerChoice: aiOptionsPerChoice, endings: aiEndings })
    if (!formulaCheck.ok) {
      setAiFormulaError(formulaCheck.message)
      setPhase('form')
      return
    }
    const normalizedTitle = normalizeStoryTitle(title)
    const sameTitleProjects = projects.filter((p) => normalizeStoryTitle(String(p.title || '')) === normalizedTitle)
    if (sameTitleProjects.length) {
      // 沿用既有同名替换语义（原弹窗 inlineConfirm，页内用原生确认框）
      const ok = window.confirm(`已存在 ${sameTitleProjects.length} 个同名草稿“${title}”。继续后将删除旧草稿，并使用新生成内容替换。`)
      if (!ok) return
    }

    const controller = new AbortController()
    abortRef.current = controller
    setPhase('generating')
    setErr('')
    setNotice('')
    setControlOffline(false)
    startAiTimer()
    // 执行路径：进入生成前拉一次守护台关联 + 当前生效文本模型（失败不阻断生成）
    setExecPath('')
    void (async () => {
      try {
        const [link, st] = await Promise.all([getControlLink().catch(() => null), getStudioSettings().catch(() => null)])
        const sp = st?.effective?.scripts
        const modelText = sp && sp.provider ? `文本模型 ${sp.provider}${sp.model ? ` / ${sp.model}` : ''}` : ''
        const modeText = link ? (link.leaseEnabled ? '经守护台资源调度' : '独立直连（租约已关）') : ''
        setExecPath([modelText, modeText].filter(Boolean).join(' · '))
      } catch (_) {}
    })()
    try {
      const res = await createProjectWithAiDetailed(prompt, title, {
        choicePoints: aiChoicePoints,
        optionsPerChoice: aiOptionsPerChoice,
        endings: aiEndings,
        signal: controller.signal
      })
      if (controller.signal.aborted) return
      // 记录草稿历史（沿用既有结构，含结果快照）
      if (res?.project?.id) {
        recordAiDraftHistory({
          projectId: res.project.id,
          title,
          choicePoints: aiChoicePoints,
          optionsPerChoice: aiOptionsPerChoice,
          createdAt: new Date().toISOString(),
          result: res
        })
      }
      // 同名旧稿替换：沿用既有行为（删旧项目 + 清其草稿历史）
      if (sameTitleProjects.length) {
        await Promise.all(
          sameTitleProjects
            .filter((item) => item.id !== res.project?.id)
            .map(async (item) => {
              await deleteProject(item.id).catch(() => null)
              removeAiDraftHistory(item.id)
            })
        )
      }
      setGenMeta(res?.gen || null)
      setResultId(res?.project?.id || '')
      setResultTitle(title)
      setPhase('success')
    } catch (e) {
      if (controller.signal.aborted || (e instanceof DOMException && e.name === 'AbortError')) {
        setPhase('form')
        setNotice('已取消生成，输入内容已保留。')
        return
      }
      const msg = e instanceof Error ? e.message : String(e)
      // 守护台离线（租约开启且守护台不可达）给专门引导，其余原样报错
      setControlOffline(/resource_scheduler_unreachable/.test(msg))
      setErr(msg)
      setPhase('error')
    } finally {
      stopAiTimer()
      abortRef.current = null
    }
  }

  function cancelGenerate() {
    abortRef.current?.abort()
  }

  async function openCreatedProject() {
    const id = resultId
    if (!id) return
    // 打开项目 = 确认草稿毕业（沿用既有语义：进项目列表，出草稿箱）
    await confirmProjectDraft(id).catch(() => null)
    removeAiDraftHistory(id)
    props.onCreated(id)
  }

  function handleBack() {
    if (phase === 'generating') {
      if (!window.confirm('生成进行中，离开将中断生成。确定离开吗？')) return
      abortRef.current?.abort()
    }
    props.onBack()
  }

  // ---- 高级选项：AI 模板与提示词预检（自 Hub 弹窗迁移，逐行保留） ----
  async function runPromptReview(promptOverride?: string, appliedSource: 'ai' | 'local' | '' = '') {
    const title = aiTitle.trim() || deriveTitle(aiPrompt)
    const prompt = normalizePromptText(promptOverride != null ? promptOverride : aiPrompt)
    if (!prompt) {
      setErr('请先填写创意内容')
      return
    }
    const formulaCheck = validateAiFormula({ choicePoints: aiChoicePoints, optionsPerChoice: aiOptionsPerChoice, endings: aiEndings })
    if (!formulaCheck.ok) {
      setAiFormulaError(formulaCheck.message)
      return
    }
    setPromptReviewBusy(true)
    setPromptReviewError('')
    try {
      const review = await reviewStoryPrompt(prompt, title, {
        choicePoints: aiChoicePoints,
        optionsPerChoice: aiOptionsPerChoice,
        endings: aiEndings
      })
      setPromptReview(review)
      setPromptReviewApplied(appliedSource)
      if (appliedSource) setPromptApplyNote(`已应用${appliedSource === 'ai' ? ' AI 优化版' : '预检优化版'}，并完成重新分析。`)
    } catch (e) {
      setPromptReviewError(e instanceof Error ? e.message : String(e))
      if (appliedSource) setPromptApplyNote(`已应用${appliedSource === 'ai' ? ' AI 优化版' : '预检优化版'}，但重新分析失败。`)
    } finally {
      setPromptReviewBusy(false)
    }
  }

  async function saveCurrentPromptVersion(promptText: string, notes: string[], meta?: Record<string, any> | null) {
    const normalized = normalizePromptText(promptText)
    if (!normalized) return null
    try {
      const item = await saveStoryPromptTemplate({
        prompt: normalized,
        title: aiTitle.trim() || undefined,
        templateName: '提示词版本',
        templateSummary: '来自提示词编辑/修复流程的保存版本',
        notes,
        choicePoints: aiChoicePoints,
        optionsPerChoice: aiOptionsPerChoice,
        endings: aiEndings,
        meta: meta || null
      })
      await reloadTemplates()
      if (item?.id) setSavedTemplateId(String(item.id))
      return item
    } catch (e) {
      setPromptApplyNote(`版本保存失败：${e instanceof Error ? e.message : String(e)}`)
      return null
    }
  }

  async function applyReviewedPrompt(source: 'ai' | 'local') {
    const next = normalizePromptText(source === 'ai' ? promptReview?.ai?.optimizedPrompt || '' : promptReview?.local?.optimizedPrompt || '')
    if (!next) {
      setPromptApplyNote(source === 'ai' ? 'AI 没有返回可替换的优化版提示词。' : '预检没有生成可替换的优化版提示词。')
      return
    }
    const current = normalizePromptText(aiPrompt)
    if (current === next) {
      setPromptReviewApplied(source)
      setPromptApplyNote(`${source === 'ai' ? 'AI 优化版' : '预检优化版'}与当前提示词一致，没有可应用的差异。`)
      return
    }
    setAiPrompt(next)
    lastAutoPromptRef.current = ''
    setPromptReviewApplied(source)
    setPromptApplyNote(`已应用${source === 'ai' ? ' AI 优化版' : '预检优化版'}，正在重新分析。`)
    setPromptReviewError('')
    persistAiDraft(aiTitle, next, aiChoicePoints, aiOptionsPerChoice, aiEndings)
    await saveCurrentPromptVersion(next, [source === 'ai' ? 'AI 评审优化版' : '本地预检优化版'], {
      source,
      reviewMeta: promptReview?.meta || null
    })
    try {
      promptInputRef.current?.focus()
      promptInputRef.current?.scrollIntoView({ block: 'center', behavior: 'smooth' })
    } catch {}
    await runPromptReview(next, source)
  }

  async function deleteSelectedPromptTemplate() {
    const id = String(savedTemplateId || '').trim()
    if (!id) return
    const item = savedPromptTemplates.find((x) => String(x.id || '') === id)
    const ok = window.confirm(`确定删除“${String(item?.title || '未命名模板')}”这条提示词版本记录吗？此操作不可撤销。`)
    if (!ok) return
    try {
      const res = await deleteStoryPromptTemplate(id)
      const items = Array.isArray(res.items) ? res.items : []
      setSavedPromptTemplates(items)
      setSavedTemplateId(items[0] ? String(items[0].id || '') : '')
      setPromptApplyNote(res.removed ? '已删除提示词版本。' : '未找到要删除的提示词版本。')
    } catch (e) {
      setPromptApplyNote(`删除版本失败：${e instanceof Error ? e.message : String(e)}`)
    }
  }

  async function savePromptVersionManually() {
    const prompt = normalizePromptText(aiPrompt)
    if (!prompt) {
      setPromptApplyNote('当前提示文本为空，无法保存版本。')
      return
    }
    const item = await saveCurrentPromptVersion(prompt, ['手动保存版本'], { source: 'manual' })
    if (item) setPromptApplyNote('当前提示词已保存为新版本。')
  }

  async function generatePromptTemplateWithAi() {
    const title = aiTitle.trim() || deriveTitle(aiPrompt)
    if (!aiTitle.trim() && !aiPrompt.trim()) {
      setErr('请先填写创意内容')
      return
    }
    const template = pickAutoPromptTemplate({
      choicePoints: aiChoicePoints,
      optionsPerChoice: aiOptionsPerChoice,
      endings: aiEndings
    })
    setTemplateGenBusy(true)
    setTemplateGenError('')
    try {
      const res = await generateStoryPromptTemplateWithAi({
        title,
        templateKey: template.key,
        templateName: template.name,
        templateSummary: template.summary,
        fields: {},
        choicePoints: aiChoicePoints,
        optionsPerChoice: aiOptionsPerChoice,
        endings: aiEndings
      })
      const next = String(res.generated?.prompt || '').trim()
      if (next) {
        setAiPrompt(next)
        lastAutoPromptRef.current = next
        setPromptReview(null)
        setPromptReviewApplied('')
        setPromptApplyNote('')
        setPromptReviewError('')
        persistAiDraft(aiTitle, next, aiChoicePoints, aiOptionsPerChoice, aiEndings)
      }
      await reloadTemplates()
      if (res.item?.id) setSavedTemplateId(String(res.item.id))
    } catch (e) {
      setTemplateGenError(e instanceof Error ? e.message : String(e))
    } finally {
      setTemplateGenBusy(false)
    }
  }

  function openSavedTemplate() {
    const item = savedPromptTemplates.find((x) => String(x.id || '') === String(savedTemplateId || ''))
    if (!item) return
    const nextPrompt = String(item.prompt || '').trim()
    if (!nextPrompt) return
    setAiPrompt(nextPrompt)
    lastAutoPromptRef.current = ''
    setPromptReview(null)
    setPromptReviewApplied('')
    setPromptApplyNote('')
    setPromptReviewError('')
    setTemplateGenError('')
    if (item.title && String(item.title).trim()) setAiTitle(String(item.title).trim())
    const cp = Number(item.formula?.choicePoints || aiChoicePoints) || aiChoicePoints
    const op = Number(item.formula?.optionsPerChoice || aiOptionsPerChoice) === 3 ? 3 : 2
    const en = op
    setAiChoicePoints(cp)
    setAiOptionsPerChoice(op)
    setAiEndings(en)
    persistAiDraft(String(item.title || aiTitle || ''), nextPrompt, cp, op, en)
  }

  const busy = phase === 'generating'

  return (
    <div className="create-page">
      <div className="create-wrap">
        <div className="create-head">
          <button className="hub-icon-btn" type="button" onClick={handleBack}>
            ← 返回
          </button>
          <div className="create-title">新建互动故事</div>
        </div>

        {phase === 'form' ? (
          <>
            <div className="create-hero">
              <div className="create-hero-title">想讲一个什么故事？</div>
              <div className="hint">一句话创意，AI 生成可交互故事的脚本层草稿；生成后进入工作室继续制作。</div>
            </div>

            <textarea
              ref={promptInputRef}
              className="create-main-input"
              value={aiPrompt}
              onChange={(e) => {
                const v = e.target.value
                setAiPrompt(v)
                if (v !== lastAutoPromptRef.current) lastAutoPromptRef.current = ''
                setPromptReview(null)
                setPromptReviewApplied('')
                setPromptApplyNote('')
                setPromptReviewError('')
                setErr('')
                persistAiDraft(aiTitle, v, aiChoicePoints, aiOptionsPerChoice, aiEndings)
              }}
              placeholder="例如：小壁虎借尾巴——教孩子认识每种动物尾巴的用处"
              aria-label="创意输入"
            />

            <div className="create-row">
              <input
                className="create-title-input"
                value={aiTitle}
                onChange={(e) => {
                  const v = e.target.value
                  setAiTitle(v)
                  setPromptReview(null)
                  setPromptReviewApplied('')
                  setPromptApplyNote('')
                  setPromptReviewError('')
                  persistAiDraft(v, aiPrompt, aiChoicePoints, aiOptionsPerChoice, aiEndings)
                }}
                placeholder="故事名称（可选，留空自动起名）"
                aria-label="故事名称"
              />
              <button
                className="btn secondary"
                type="button"
                onClick={() => {
                  setAiPrompt('')
                  setAiTitle('')
                  setPromptReview(null)
                  setPromptReviewApplied('')
                  setPromptApplyNote('')
                  setPromptReviewError('')
                  setErr('')
                  persistAiDraft('', '', aiChoicePoints, aiOptionsPerChoice, aiEndings)
                }}
              >
                清空
              </button>
              <button className="create-generate-btn" type="button" onClick={() => void generate()} disabled={!aiPrompt.trim()}>
                生成
              </button>
            </div>

            {notice ? <div className="create-note">{notice}</div> : null}
            {err ? <div className="create-err">{err}</div> : null}

            <div className="create-adv">
              <button
                className="create-adv-head"
                type="button"
                aria-expanded={advancedOpen}
                onClick={() => setAdvancedOpen((v) => !v)}
              >
                <span>高级选项（结构公式 / AI 模板 / 提示词预检）</span>
                <span className="hint">{advancedOpen ? '收起' : '展开'}</span>
              </button>
              {advancedOpen ? (
                <div className="create-adv-body">
                  <div className="form-row">
                    <label>结构公式</label>
                    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                      <select
                        className="sel"
                        value={aiChoicePoints}
                        onChange={(e) => {
                          const v = Number(e.target.value) || 2
                          setAiFormulaError('')
                          setPromptReview(null)
                          setPromptReviewApplied('')
                          setPromptApplyNote('')
                          setPromptReviewError('')
                          setAiChoicePoints(v)
                          persistAiDraft(aiTitle, aiPrompt, v, aiOptionsPerChoice, aiEndings)
                        }}
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
                          setPromptReview(null)
                          setPromptReviewApplied('')
                          setPromptApplyNote('')
                          setPromptReviewError('')
                          // Keep formula valid by construction.
                          setAiOptionsPerChoice(v)
                          setAiEndings(v)
                          persistAiDraft(aiTitle, aiPrompt, aiChoicePoints, v, v)
                        }}
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
                          setPromptReview(null)
                          setPromptReviewApplied('')
                          setPromptApplyNote('')
                          setPromptReviewError('')
                          setAiEndings(v)
                          persistAiDraft(aiTitle, aiPrompt, aiChoicePoints, aiOptionsPerChoice, v)
                        }}
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
                        onClick={() => {
                          const r = randomAiFormula()
                          setAiFormulaError('')
                          setPromptReview(null)
                          setPromptReviewApplied('')
                          setPromptApplyNote('')
                          setPromptReviewError('')
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
                    <label>AI 模板</label>
                    <div style={{ display: 'grid', gap: 8 }}>
                      <div className="hint">
                        当前将按结构公式自动使用：{autoTemplate.name}（{autoTemplate.summary}）。不再手工填写模板字段，点击下方按钮由 AI 生成完整提示文本。
                      </div>
                      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                        <button className="btn secondary" type="button" disabled={templateGenBusy} onClick={() => void generatePromptTemplateWithAi()}>
                          {templateGenBusy ? '生成中…' : 'AI 一键生成提示文本'}
                        </button>
                        <select className="sel" value={savedTemplateId} onChange={(e) => setSavedTemplateId(String(e.target.value || ''))} disabled={templateGenBusy || !savedPromptTemplates.length}>
                          <option value="">已生成模板</option>
                          {savedPromptTemplates.map((item) => (
                            <option key={item.id} value={item.id}>
                              {(item.title || '未命名模板') + ' · ' + String(item.createdAt || '').slice(0, 16).replace('T', ' ')}
                            </option>
                          ))}
                        </select>
                        <button className="btn secondary" type="button" disabled={!savedTemplateId} onClick={() => openSavedTemplate()}>
                          打开模板
                        </button>
                        <button className="btn secondary" type="button" disabled={!aiPrompt.trim()} onClick={() => void savePromptVersionManually()}>
                          保存版本
                        </button>
                        <button className="btn secondary" type="button" disabled={!savedTemplateId} onClick={() => void deleteSelectedPromptTemplate()}>
                          删除模板
                        </button>
                      </div>
                      {templateGenError ? <div style={{ color: '#fca5a5' }}>{templateGenError}</div> : null}
                    </div>
                  </div>

                  <div className="form-row">
                    <label>提示词预检 / AI 分析</label>
                    <div style={{ display: 'grid', gap: 8 }}>
                      <div className="hint">提示文本与上方创意输入同源；模板生成 / 预检优化会直接改写主输入。</div>
                      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                        <button className="btn secondary" type="button" disabled={promptReviewBusy} onClick={() => void runPromptReview(undefined, '')}>
                          {promptReviewBusy ? '分析中…' : '分析提示词'}
                        </button>
                        {promptReview?.ai?.optimizedPrompt ? (
                          <button className="btn secondary" type="button" disabled={promptReviewBusy} onClick={() => void applyReviewedPrompt('ai')}>
                            AI 修复并替换
                          </button>
                        ) : null}
                        {promptReview?.local?.optimizedPrompt ? (
                          <button className="btn secondary" type="button" disabled={promptReviewBusy} onClick={() => void applyReviewedPrompt('local')}>
                            应用预检优化版
                          </button>
                        ) : null}
                      </div>

                      {promptReviewError ? <div style={{ color: '#fca5a5' }}>{promptReviewError}</div> : null}
                      {promptApplyNote ? <div style={{ color: '#93c5fd' }}>{promptApplyNote}</div> : null}

                      {promptReview ? (
                        <div
                          style={{
                            display: 'grid',
                            gap: 10,
                            padding: 12,
                            borderRadius: 12,
                            border: `1px solid ${promptReview.local.ok && promptReview.ai.verdict === 'ok' ? '#10b981' : '#f59e0b'}`,
                            background: promptReview.local.ok && promptReview.ai.verdict === 'ok' ? 'rgba(16,185,129,0.08)' : 'rgba(245,158,11,0.08)'
                          }}
                        >
                          <div className="hint" style={{ color: promptReview.local.ok && promptReview.ai.verdict === 'ok' ? '#a7f3d0' : '#fde68a' }}>
                            预检评分：{promptReview.local.score}/100 · {promptReview.local.summary}
                          </div>
                          {promptReviewApplied ? (
                            <div className="hint" style={{ color: '#93c5fd' }}>
                              已应用{promptReviewApplied === 'ai' ? ' AI 优化版' : '预检优化版'}提示词。当前评分仍对应应用前的分析结果；如需更新，请重新点击“分析提示词”。
                            </div>
                          ) : null}

                          <div>
                            <div className="hint" style={{ fontWeight: 700, marginBottom: 6 }}>本地预检</div>
                            <div style={{ display: 'grid', gap: 6 }}>
                              {promptReview.local.checks.map((c) => (
                                <div key={c.id} className="hint" style={{ color: c.ok ? '#a7f3d0' : c.severity === 'error' ? '#fca5a5' : '#fde68a' }}>
                                  {c.ok ? '✓' : '•'} {c.message}
                                </div>
                              ))}
                            </div>
                          </div>

                          <div>
                            <div className="hint" style={{ fontWeight: 700, marginBottom: 6 }}>
                              AI 评审
                              {promptReview.meta?.provider ? `：${promptReview.meta.provider}${promptReview.meta.model ? ` / ${promptReview.meta.model}` : ''}${promptReview.meta.durationMs != null ? ` / ${promptReview.meta.durationMs}ms` : ''}` : ''}
                            </div>
                            <div className="hint" style={{ color: promptReview.ai.verdict === 'ok' ? '#a7f3d0' : promptReview.ai.verdict === 'error' ? '#fca5a5' : '#fde68a', marginBottom: 6 }}>
                              {promptReview.ai.summary}
                            </div>
                            {promptReview.ai.strengths?.length ? (
                              <div style={{ display: 'grid', gap: 6, marginBottom: 8 }}>
                                {promptReview.ai.strengths.map((s, i) => (
                                  <div key={`strength-${i}`} className="hint" style={{ color: '#a7f3d0' }}>- {s}</div>
                                ))}
                              </div>
                            ) : null}
                            {promptReview.ai.risks?.length ? (
                              <div style={{ display: 'grid', gap: 6, marginBottom: 8 }}>
                                {promptReview.ai.risks.map((s, i) => (
                                  <div key={`risk-${i}`} className="hint" style={{ color: '#fde68a' }}>- {s}</div>
                                ))}
                              </div>
                            ) : null}
                            {promptReview.ai.suggestions?.length ? (
                              <div style={{ display: 'grid', gap: 6 }}>
                                {promptReview.ai.suggestions.map((s, i) => (
                                  <div key={`suggest-${i}`} className="hint">- {s}</div>
                                ))}
                              </div>
                            ) : null}
                            {promptReview.aiError?.message ? (
                              <div style={{ marginTop: 8, color: '#fca5a5' }}>AI 评审回退：{promptReview.aiError.message}</div>
                            ) : null}
                          </div>
                        </div>
                      ) : (
                        <div className="hint">点击“分析提示词”后，会先做结构预检，再用当前故事模型做一轮 AI 评审，并返回优化版提示词。</div>
                      )}
                    </div>
                  </div>
                </div>
              ) : null}
            </div>
          </>
        ) : null}

        {phase === 'generating' ? (
          <div className="create-progress">
            <span className="create-pulse" aria-hidden="true" />
            <div className="create-progress-title">正在生成脚本草稿</div>
            <div className="create-progress-elapsed">已用 {Math.floor(aiElapsedMs / 1000)} 秒</div>
            {execPath ? <div className="create-exec-path">{execPath}</div> : null}
            <div className="hint">本地模型约需 1–3 分钟，请勿关闭页面。</div>
            <div>
              <button className="btn secondary" type="button" onClick={cancelGenerate}>
                取消
              </button>
            </div>
          </div>
        ) : null}

        {phase === 'success' ? (
          <div className="create-result-card is-ok">
            <div className="create-result-head">
              <span className="create-result-dot" aria-hidden="true" />
              <div className="create-result-title">草稿已生成{resultTitle ? `：${resultTitle}` : ''}</div>
            </div>
            <div className="hint">
              {genMeta?.provider ? `${genMeta.provider}${genMeta.model ? ` / ${genMeta.model}` : ''}` : ''}
              {typeof genMeta?.durationMs === 'number' ? ` · 耗时 ${(genMeta.durationMs / 1000).toFixed(1)}s` : ''}
            </div>
            {genMeta?.ok === false ? (
              <div className="hint" style={{ color: '#fbbf24' }}>
                当前草稿未通过最终结构校验{genMeta.message ? `：${genMeta.message}` : ''}；可打开项目后在脚本层继续修复。
              </div>
            ) : null}
            <div className="create-result-actions">
              <button className="create-generate-btn" type="button" onClick={() => void openCreatedProject()}>
                打开项目继续制作
              </button>
              <button className="btn secondary" type="button" onClick={props.onBack}>
                返回首页
              </button>
            </div>
          </div>
        ) : null}

        {phase === 'error' ? (
          <div className="create-result-card is-err">
            <div className="create-result-head">
              <span className="create-result-dot is-err" aria-hidden="true" />
              <div className="create-result-title">生成失败</div>
            </div>
            {controlOffline ? (
              <div className="create-err">守护台离线且资源租约已启用。请启动守护台，或到 设置 → 守护台关联 关闭后重试。</div>
            ) : (
              <div className="create-err">{err || '未知原因'}</div>
            )}
            <div className="create-result-actions">
              <button className="create-generate-btn" type="button" onClick={() => void generate()}>
                重试
              </button>
              {controlOffline && props.onOpenSettings ? (
                <button className="btn secondary" type="button" onClick={props.onOpenSettings}>
                  打开设置
                </button>
              ) : null}
              <button className="btn secondary" type="button" onClick={props.onBack}>
                返回
              </button>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  )
}
