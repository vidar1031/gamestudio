import { useEffect, useMemo, useRef, useState } from 'react'
import {
  analyzeProjectScripts,
  createProjectWithAiDetailed,
  deleteProject,
  fixScriptsWithAi,
  generateStoryPromptTemplateWithAi,
  saveStoryPromptTemplate,
  deleteStoryPromptTemplate,
  getBlueprint,
  getProject,
  getScripts,
  getStudioSettings,
  getGlobalAiRules,
  listStoryPromptTemplates,
  listProjects,
  regenerateProjectScriptsWithAiDetailed,
  reviewStoryPrompt,
  reviewBlueprintWithAi,
  saveGlobalAiRules,
  type AiCreateResult,
  type AiBlueprintReview,
  type AiScriptAnalysis,
  type StoryPromptTemplateItem,
  type StoryPromptReview,
  type ProjectV1,
  type StudioEffectiveConfig
} from '../api'

const AI_PROMPT_KEY = 'gamestudio.ai.prompt'
const AI_TITLE_KEY = 'gamestudio.ai.title'
const AI_CHOICE_POINTS_KEY = 'gamestudio.ai.choicePoints'
const AI_OPTIONS_PER_CHOICE_KEY = 'gamestudio.ai.optionsPerChoice'
const AI_ENDINGS_KEY = 'gamestudio.ai.endings'

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

function clearAiDraft() {
  try {
    localStorage.removeItem(AI_TITLE_KEY)
    localStorage.removeItem(AI_PROMPT_KEY)
    localStorage.removeItem(AI_CHOICE_POINTS_KEY)
    localStorage.removeItem(AI_OPTIONS_PER_CHOICE_KEY)
    localStorage.removeItem(AI_ENDINGS_KEY)
  } catch {}
}

function normalizeStoryTitle(value: string) {
  return String(value || '').trim().replace(/\s+/g, ' ')
}

function normalizePromptText(value: string) {
  return String(value || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim()
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

type InlineConfirmState = {
  open: boolean
  title: string
  message: string
  confirmLabel: string
  cancelLabel: string
  danger: boolean
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
  const [aiChoicePoints, setAiChoicePoints] = useState(draft.choicePoints)
  const [aiOptionsPerChoice, setAiOptionsPerChoice] = useState(draft.optionsPerChoice)
  const [aiEndings, setAiEndings] = useState(draft.endings)
  const [aiResult, setAiResult] = useState<AiCreateResult | null>(null)
  const [aiTab, setAiTab] = useState<'preview' | 'analysis'>('preview')
  const [analysis, setAnalysis] = useState<AiScriptAnalysis | null>(null)
  const [analysisBusy, setAnalysisBusy] = useState(false)
  const [blueprintReview, setBlueprintReview] = useState<AiBlueprintReview | null>(null)
  const [blueprintReviewMeta, setBlueprintReviewMeta] = useState<{ provider?: string; model?: string; api?: string; durationMs?: number } | null>(null)
  const [selfCheckBusy, setSelfCheckBusy] = useState(false)
  const [selfCheckError, setSelfCheckError] = useState('')
  const [selfFixBusy, setSelfFixBusy] = useState(false)
  const [selfFixNote, setSelfFixNote] = useState('')
  const [rulesText, setRulesText] = useState('')
  const [rulesError, setRulesError] = useState('')
  const [aiFormulaError, setAiFormulaError] = useState('')
  const [promptReview, setPromptReview] = useState<StoryPromptReview | null>(null)
  const [promptReviewBusy, setPromptReviewBusy] = useState(false)
  const [promptReviewError, setPromptReviewError] = useState('')
  const [promptReviewApplied, setPromptReviewApplied] = useState<'ai' | 'local' | ''>('')
  const [promptApplyNote, setPromptApplyNote] = useState('')
  const [savedPromptTemplates, setSavedPromptTemplates] = useState<StoryPromptTemplateItem[]>([])
  const [savedTemplateId, setSavedTemplateId] = useState<string>('')
  const [templateGenBusy, setTemplateGenBusy] = useState(false)
  const [templateGenError, setTemplateGenError] = useState('')
  const [aiElapsedMs, setAiElapsedMs] = useState<number>(0)
  const [inlineConfirm, setInlineConfirm] = useState<InlineConfirmState>({
    open: false,
    title: '',
    message: '',
    confirmLabel: '确定',
    cancelLabel: '取消',
    danger: false
  })
  const aiTimerIdRef = useRef<number | null>(null)
  const promptInputRef = useRef<HTMLTextAreaElement | null>(null)
  const aiTimerStartedAtRef = useRef<number>(0)
  const aiRequestLockRef = useRef(false)
  const lastAutoPromptRef = useRef<string>(draft.prompt.startsWith('模板：') ? draft.prompt : '')
  const inlineConfirmResolverRef = useRef<((ok: boolean) => void) | null>(null)

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
      const [items, st, templates] = await Promise.all([listProjects(), getStudioSettings().catch(() => null), listStoryPromptTemplates().catch(() => [])])
      setProjects(items)
      if (st && st.effective) setEffectiveAi(st.effective)
      setSavedPromptTemplates(Array.isArray(templates) ? templates : [])
      setSavedTemplateId((prev) => {
        if (prev && Array.isArray(templates) && templates.some((x) => x.id === prev)) return prev
        return Array.isArray(templates) && templates[0] ? String(templates[0].id || '') : ''
      })
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

    const normalizedTitle = normalizeStoryTitle(title)
    const sameTitleProjects = projects.filter((p) => normalizeStoryTitle(String(p.title || '')) === normalizedTitle)
    if (sameTitleProjects.length) {
      const ok = await askInlineConfirm({
        title: '替换同名草稿',
        message: `已存在 ${sameTitleProjects.length} 个同名草稿“${title}”。继续后将删除旧草稿，并使用新生成内容替换。`,
        confirmLabel: '删除旧稿并生成',
        cancelLabel: '取消',
        danger: true
      })
      if (!ok) return
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
      setPromptReview(null)
      setPromptReviewError('')
      setBlueprintReview(null)
      setBlueprintReviewMeta(null)
      setSelfCheckError('')
      setSelfFixNote('')
      setRulesText('')
      setRulesError('')
      if (sameTitleProjects.length) {
        await Promise.all(
          sameTitleProjects
            .filter((item) => item.id !== res.project?.id)
            .map(async (item) => {
              await deleteProject(item.id).catch(() => null)
              if (selectedId === item.id) setSelectedId('')
            })
        )
      }
      await refresh()
      if (res?.project?.id) setSelectedId(res.project.id)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
      stopAiTimer()
      aiRequestLockRef.current = false
    }
  }

  async function runPromptReview(promptOverride?: string, appliedSource: 'ai' | 'local' | '' = '') {
    const title = aiTitle.trim()
    const prompt = normalizePromptText(promptOverride != null ? promptOverride : aiPrompt)
    if (!title) {
      setError('请输入故事名称')
      return
    }
    if (!prompt) {
      setError('请输入提示文本')
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
      await refresh()
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
    const ok = await askInlineConfirm({
      title: '删除提示词版本',
      message: `确定删除“${String(item?.title || '未命名模板')}”这条提示词版本记录吗？此操作不可撤销。`,
      confirmLabel: '删除版本',
      cancelLabel: '取消',
      danger: true
    })
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
    const title = aiTitle.trim()
    if (!title) {
      setError('请输入故事名称')
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
      await refresh()
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
    const ok = await askInlineConfirm({
      title: '覆盖当前草稿',
      message: `重新生成将覆盖当前草稿（故事ID：${pid}）的脚本内容。`,
      confirmLabel: '覆盖并生成',
      cancelLabel: '取消',
      danger: true
    })
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
      setPromptReview(null)
      setPromptReviewError('')
      setBlueprintReview(null)
      setBlueprintReviewMeta(null)
      setSelfCheckError('')
      setSelfFixNote('')
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
      setRulesText('')
    } catch (e) {
      setRulesError(e instanceof Error ? e.message : String(e))
    } finally {
      setAnalysisBusy(false)
    }
  }

  async function runSelfCheck(projectId?: string) {
    const pid = projectId || aiResult?.project?.id
    if (!pid) return
    setSelfCheckBusy(true)
    setSelfCheckError('')
    try {
      const [analysisRes, reviewRes] = await Promise.all([
        analyzeProjectScripts(pid),
        reviewBlueprintWithAi(pid)
      ])
      setAnalysis(analysisRes)
      setRulesText('')
      setBlueprintReview(reviewRes.review || null)
      setBlueprintReviewMeta(reviewRes.meta || null)
    } catch (e) {
      setSelfCheckError(e instanceof Error ? e.message : String(e))
    } finally {
      setSelfCheckBusy(false)
      setAnalysisBusy(false)
    }
  }

  async function continueAiSelfFix() {
    const pid = aiResult?.project?.id
    if (!pid) return
    const ok = await askInlineConfirm({
      title: '继续 AI 修复',
      message: '将基于本轮自检结果继续调用 AI 修复脚本，并重新生成自检报告。',
      confirmLabel: '继续修复',
      cancelLabel: '取消',
      danger: false
    })
    if (!ok) return

    setSelfFixBusy(true)
    setSelfFixNote('')
    setSelfCheckError('')
    try {
      const fixed = await fixScriptsWithAi(pid)
      setAiResult((prev) => {
        if (!prev) return prev
        return {
          ...prev,
          scripts: fixed.scripts,
          blueprint: fixed.after?.blueprint || prev.blueprint,
          gen: {
            ...prev.gen,
            repaired: true,
            before: fixed.before || prev.gen.before || null,
            after: fixed.after || prev.gen.after || null
          }
        }
      })
      setSelfFixNote(`已完成一轮 AI 修复：${fixed.meta?.provider || 'unknown'}${fixed.meta?.model ? ` / ${fixed.meta.model}` : ''}${fixed.meta?.durationMs != null ? ` / ${fixed.meta.durationMs}ms` : ''}`)
      await runSelfCheck(pid)
      await refresh()
    } catch (e) {
      setSelfCheckError(e instanceof Error ? e.message : String(e))
    } finally {
      setSelfFixBusy(false)
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
    const ok = await askInlineConfirm({
      title: '删除故事草稿',
      message: '确定删除该故事草稿？此操作不可恢复。',
      confirmLabel: '删除',
      cancelLabel: '取消',
      danger: true
    })
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

  const autoTemplate = useMemo(
    () => pickAutoPromptTemplate({ choicePoints: aiChoicePoints, optionsPerChoice: aiOptionsPerChoice, endings: aiEndings }),
    [aiChoicePoints, aiOptionsPerChoice, aiEndings]
  )

  useEffect(() => {
    const pid = aiResult?.project?.id
    if (!pid) return
    setSelfFixNote('')
    setSelfCheckError('')
    setBlueprintReview(null)
    setBlueprintReviewMeta(null)
    void runSelfCheck(pid)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [aiResult?.project?.id])

  const blueprintReviewIsFallback = useMemo(() => {
    const summary = String(blueprintReview?.summary || '').trim()
    return summary.includes('AI 分析失败（已回退为本地提示）')
  }, [blueprintReview])

  const selfCheckNeedsAttention = useMemo(() => {
    if (aiResult?.gen?.ok === false) return true
    if (analysis && analysis.ok === false) return true
    if (blueprintReview && blueprintReview.verdict === 'error') return true
    if (blueprintReview && blueprintReview.verdict === 'warn' && !blueprintReviewIsFallback) return true
    if (aiResult?.gen?.after && Array.isArray(aiResult.gen.after.issues) && aiResult.gen.after.issues.length) return true
    return false
  }, [analysis, blueprintReview, blueprintReviewIsFallback, aiResult])

  return (
    <div className="app">
      <div className="topbar">
        <div className="left">
          <div className="title">gamestudio · 工作台</div>
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
                  setAiChoicePoints(d.choicePoints)
                  setAiOptionsPerChoice(d.optionsPerChoice)
                  setAiEndings(d.endings)
                  setAiResult(null)
                  setPromptReview(null)
                  setPromptReviewError('')
                  setAiTab('preview')
                  setAnalysis(null)
                  setBlueprintReview(null)
                  setBlueprintReviewMeta(null)
                  setSelfCheckError('')
                  setSelfFixNote('')
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
          <div className="ai-modal-card" style={{ width: 'min(1180px, calc(100vw - 32px))', maxHeight: 'calc(100vh - 24px)' }}>
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
                        setPromptReview(null)
                        setPromptReviewApplied('')
                        setPromptApplyNote('')
                        setPromptReviewError('')
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
                          setPromptReview(null)
                          setPromptReviewApplied('')
                          setPromptApplyNote('')
                          setPromptReviewError('')
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
                          setPromptReview(null)
                          setPromptReviewApplied('')
                          setPromptApplyNote('')
                          setPromptReviewError('')
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
                          setPromptReview(null)
                          setPromptReviewApplied('')
                          setPromptApplyNote('')
                          setPromptReviewError('')
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
                    <label>提示文本</label>
                    <textarea
                      ref={promptInputRef}
                      className="textarea"
                      value={aiPrompt}
                      onChange={(e) => {
                        const v = e.target.value
                        setAiPrompt(v)
                        if (v !== lastAutoPromptRef.current) lastAutoPromptRef.current = ''
                        setPromptReview(null)
                        setPromptReviewApplied('')
                        setPromptApplyNote('')
                        setPromptReviewError('')
                        persistAiDraft(aiTitle, v, aiChoicePoints, aiOptionsPerChoice, aiEndings)
                      }}
                      placeholder="例如：写一个《狼来了》风格的互动故事，包含 3 个关键选择点和多个结局（先生成脚本大纲）"
                      style={{ minHeight: 160 }}
                      disabled={busy}
                    />
                  </div>

                  <div className="form-row">
                    <label>AI 模板</label>
                    <div style={{ display: 'grid', gap: 8 }}>
                      <div className="hint">
                        当前将按结构公式自动使用：{autoTemplate.name}（{autoTemplate.summary}）。不再手工填写模板字段，点击下方按钮由 AI 生成完整提示文本。
                      </div>
                      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                        <button className="btn secondary" type="button" disabled={busy || templateGenBusy} onClick={() => void generatePromptTemplateWithAi()}>
                          {templateGenBusy ? '生成中…' : 'AI 一键生成提示文本'}
                        </button>
                        <select className="sel" value={savedTemplateId} onChange={(e) => setSavedTemplateId(String(e.target.value || ''))} disabled={busy || templateGenBusy || !savedPromptTemplates.length}>
                          <option value="">已生成模板</option>
                          {savedPromptTemplates.map((item) => (
                            <option key={item.id} value={item.id}>
                              {(item.title || '未命名模板') + ' · ' + String(item.createdAt || '').slice(0, 16).replace('T', ' ')}
                            </option>
                          ))}
                        </select>
                        <button className="btn secondary" type="button" disabled={busy || !savedTemplateId} onClick={() => openSavedTemplate()}>
                          打开模板
                        </button>
                        <button className="btn secondary" type="button" disabled={busy || !aiPrompt.trim()} onClick={() => void savePromptVersionManually()}>
                          保存版本
                        </button>
                        <button className="btn secondary" type="button" disabled={busy || !savedTemplateId} onClick={() => void deleteSelectedPromptTemplate()}>
                          删除模板
                        </button>
                      </div>
                      {templateGenError ? <div style={{ color: '#fca5a5' }}>{templateGenError}</div> : null}
                    </div>
                  </div>

                  <div className="form-row">
                    <label>提示词预检 / AI 分析</label>
                    <div style={{ display: 'grid', gap: 8 }}>
                      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                        <button className="btn secondary" type="button" disabled={busy || promptReviewBusy} onClick={() => void runPromptReview(undefined, '')}>
                          {promptReviewBusy ? '分析中…' : '分析提示词'}
                        </button>
                        {promptReview?.ai?.optimizedPrompt ? (
                          <button
                            className="btn secondary"
                            type="button"
                            disabled={busy || promptReviewBusy}
                            onClick={() => void applyReviewedPrompt('ai')}
                          >
                            AI 修复并替换
                          </button>
                        ) : null}
                        {promptReview?.local?.optimizedPrompt ? (
                          <button
                            className="btn secondary"
                            type="button"
                            disabled={busy || promptReviewBusy}
                            onClick={() => void applyReviewedPrompt('local')}
                          >
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
            ) : (
              <>
                <div className="hint" style={{ marginBottom: 10 }}>
                  {aiResult.gen?.ok === false ? '已保存可修正草稿' : '生成完成'}：{aiResult.gen?.provider}
                  {aiResult.gen?.model ? ` / ${aiResult.gen.model}` : ''}
                  {typeof aiResult.gen?.durationMs === 'number' ? ` / ${aiResult.gen.durationMs}ms` : ''}
                </div>
                {aiResult.gen?.ok === false && aiResult.gen?.message ? (
                  <div className="hint" style={{ marginBottom: 10, color: '#fde68a' }}>
                    当前草稿未通过最终结构校验：{aiResult.gen.message}
                  </div>
                ) : null}
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
                <div
                  style={{
                    marginBottom: 10,
                    padding: 10,
                    borderRadius: 10,
                    border: `1px solid ${selfCheckBusy ? '#3b82f6' : selfCheckNeedsAttention ? '#f59e0b' : '#10b981'}`,
                    background: selfCheckBusy ? 'rgba(59,130,246,0.08)' : selfCheckNeedsAttention ? 'rgba(245,158,11,0.08)' : 'rgba(16,185,129,0.08)'
                  }}
                >
                  <div style={{ fontWeight: 700, marginBottom: 4 }}>生成后自检</div>
                  <div className="hint" style={{ color: selfCheckBusy ? '#93c5fd' : selfCheckNeedsAttention ? '#fde68a' : '#a7f3d0' }}>
                    {selfCheckBusy
                      ? '正在执行结构分析 + AI 自检，请先确认结果。'
                      : selfCheckNeedsAttention
                        ? '发现需要确认或修改的风险。当前草稿已保留，建议先看“结构分析”，再决定继续 AI 修复或进入脚本人工修改。'
                        : blueprintReviewIsFallback
                          ? '结构分析已通过。AI 自检本轮暂不可用，但不影响继续进入后续处理。'
                          : '本轮自检未发现明显风险。你仍可查看分析结果后再进入脚本。'}
                  </div>
                  {aiResult.gen?.repaired ? <div className="hint" style={{ marginTop: 4 }}>本轮生成已包含自动修复。</div> : null}
                  {selfFixNote ? <div className="hint" style={{ marginTop: 4, color: '#a7f3d0' }}>{selfFixNote}</div> : null}
                  {selfCheckError ? <div style={{ marginTop: 6, color: '#fca5a5' }}>{selfCheckError}</div> : null}
                </div>
                <div className="hr" />
                <div className="tabs" style={{ paddingLeft: 0, paddingRight: 0 }}>
                  <div className={`tab ${aiTab === 'preview' ? 'active' : ''}`} onClick={() => setAiTab('preview')}>
                    脚本预览
                  </div>
                  <div
                    className={`tab ${aiTab === 'analysis' ? 'active' : ''}`}
                    onClick={() => {
                      setAiTab('analysis')
                      if ((!analysis || !blueprintReview) && !analysisBusy && !selfCheckBusy) void runSelfCheck()
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
                      <button className="btn secondary" onClick={() => void runSelfCheck()} disabled={analysisBusy || selfCheckBusy || selfFixBusy}>
                        {analysisBusy || selfCheckBusy ? '自检中…' : '重新自检'}
                      </button>
                      <button className="btn secondary" onClick={() => void continueAiSelfFix()} disabled={selfCheckBusy || selfFixBusy}>
                        {selfFixBusy ? '修复中…' : '继续 AI 修复'}
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
                      <div className="hint">{analysisBusy || selfCheckBusy ? '分析中…' : '暂无分析结果'}</div>
                    )}

                    <div className="hr" />
                    <div className="hint" style={{ fontWeight: 700, marginBottom: 6 }}>
                      AI 自检结论
                    </div>
                    {blueprintReview ? (
                      <>
                        <div className="hint" style={{ marginBottom: 10, color: blueprintReviewIsFallback ? 'rgba(226,232,240,0.78)' : blueprintReview.verdict === 'ok' ? '#a7f3d0' : blueprintReview.verdict === 'error' ? '#fca5a5' : '#fde68a' }}>
                          {blueprintReviewIsFallback ? 'AI 自检暂不可用（已回退本地提示，不影响当前结构结论）。' : blueprintReview.summary}
                          {blueprintReviewMeta?.provider ? `（${blueprintReviewMeta.provider}${blueprintReviewMeta.model ? ` / ${blueprintReviewMeta.model}` : ''}${blueprintReviewMeta.durationMs != null ? ` / ${blueprintReviewMeta.durationMs}ms` : ''}）` : ''}
                        </div>
                        {blueprintReview.rootCauses?.length ? (
                          <div style={{ display: 'grid', gap: 6, marginBottom: 10 }}>
                            {blueprintReview.rootCauses.map((s, i) => (
                              <div key={`root-${i}`} className="hint" style={{ color: '#fde68a' }}>
                                - {s}
                              </div>
                            ))}
                          </div>
                        ) : null}
                        {blueprintReview.suggestedEdits?.length ? (
                          <div style={{ display: 'grid', gap: 6, marginBottom: 10 }}>
                            {blueprintReview.suggestedEdits.map((s, i) => (
                              <div key={`edit-${i}`} className="hint">
                                - {s.target}：{s.change}{s.example ? ` 例：${s.example}` : ''}
                              </div>
                            ))}
                          </div>
                        ) : null}
                      </>
                    ) : (
                      <div className="hint">{selfCheckBusy ? 'AI 自检中…' : '暂无 AI 自检结论'}</div>
                    )}

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
                    setBlueprintReview(null)
                    setBlueprintReviewMeta(null)
                    setSelfCheckError('')
                    setSelfFixNote('')
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
                    setAiPrompt('')
                    setAiResult(null)
                    setBlueprintReview(null)
                    setBlueprintReviewMeta(null)
                    setSelfCheckError('')
                    setSelfFixNote('')
                    setPromptReview(null)
                    setPromptReviewApplied('')
                    setPromptApplyNote('')
                    setPromptReviewError('')
                    persistAiDraft(aiTitle, '', aiChoicePoints, aiOptionsPerChoice, aiEndings)
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
                  <button className="btn secondary" onClick={() => void continueAiSelfFix()} disabled={selfCheckBusy || selfFixBusy} title="基于当前自检结果继续让 AI 修复脚本">
                    {selfFixBusy ? '修复中…' : '继续 AI 修复'}
                  </button>
                  <button
                    className="btn"
                    onClick={() => {
                      const id = aiResult.project?.id
                      setAiModalOpen(false)
                      // Keep draft by default (user may want to generate variations).
                      setAiResult(null)
                      setBlueprintReview(null)
                      setBlueprintReviewMeta(null)
                      setSelfCheckError('')
                      setSelfFixNote('')
                      if (id) props.onOpenProject(id, 'script')
                    }}
                  >
                    进入脚本人工修改
                  </button>
                </>
              )}
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
