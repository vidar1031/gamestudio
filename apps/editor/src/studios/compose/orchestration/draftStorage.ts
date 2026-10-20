import {
  type AiBackgroundRequest
} from '../../../api'
import type { StoryboardBatchState } from './storyboardPlan'
import { getDoubaoStoryboardDefaultSize } from './storyboardPlan'

export const HUB_TEMPLATE_FIELDS_KEY = 'talkscene.ai.templateFields'
export const loadAiBackgroundDraft = (key: string): Partial<AiBackgroundRequest> | null => {
    try {
      const raw = localStorage.getItem(key)
      if (!raw) return null
      const json = JSON.parse(raw)
      if (!json || typeof json !== 'object') return null
      const v: any = json
      const out: Partial<AiBackgroundRequest> = {}
      if (typeof v.userInput === 'string') out.userInput = v.userInput
      if (typeof v.globalPrompt === 'string') out.globalPrompt = v.globalPrompt
      if (typeof v.globalNegativePrompt === 'string') out.globalNegativePrompt = v.globalNegativePrompt
      if (typeof v.backgroundOnly === 'boolean') out.backgroundOnly = v.backgroundOnly
      if (typeof v.prompt === 'string') out.prompt = v.prompt
      if (typeof v.negativePrompt === 'string') out.negativePrompt = v.negativePrompt
      if (typeof v.aspectRatio === 'string') out.aspectRatio = v.aspectRatio as any
      if (typeof v.style === 'string') out.style = v.style as any
      if (v.width != null && Number.isFinite(Number(v.width))) out.width = Number(v.width)
      if (v.height != null && Number.isFinite(Number(v.height))) out.height = Number(v.height)
      if (typeof v.size === 'string') out.size = v.size
      if (v.responseFormat === 'b64_json' || v.responseFormat === 'url') out.responseFormat = v.responseFormat
      if (typeof v.watermark === 'boolean') out.watermark = v.watermark
      if (v.sequentialImageGeneration === 'auto' || v.sequentialImageGeneration === 'disabled') out.sequentialImageGeneration = v.sequentialImageGeneration
      if (Array.isArray(v.referenceSceneIds)) out.referenceSceneIds = v.referenceSceneIds.map((x: any) => String(x || '').trim()).filter(Boolean)
      if (v.steps != null && Number.isFinite(Number(v.steps))) out.steps = Number(v.steps)
      if (v.cfgScale != null && Number.isFinite(Number(v.cfgScale))) out.cfgScale = Number(v.cfgScale)
      if (v.seed != null && Number.isFinite(Number(v.seed))) out.seed = Number(v.seed)
      if (v.continuity && typeof v.continuity === 'object') {
        out.continuity = {
          ipadapterEnabled: Boolean((v.continuity as any).ipadapterEnabled),
          requireCharacterRefs: (v.continuity as any).requireCharacterRefs !== false,
          controlnetEnabled: Boolean((v.continuity as any).controlnetEnabled),
          seedMode: String((v.continuity as any).seedMode || '').trim() === 'fixed' ? 'fixed' : 'random'
        }
      }
      return out
    } catch {
      return null
    }
  }
export const saveAiBackgroundDraft = (key: string, draft: AiBackgroundRequest) => {
    try {
      localStorage.setItem(
        key,
        JSON.stringify({
          userInput: String(draft.userInput || ''),
          globalPrompt: String(draft.globalPrompt || ''),
          globalNegativePrompt: String(draft.globalNegativePrompt || ''),
          backgroundOnly: Boolean(draft.backgroundOnly),
          prompt: String(draft.prompt || ''),
          negativePrompt: String(draft.negativePrompt || ''),
          aspectRatio: draft.aspectRatio || '9:16',
          style: draft.style || 'picture_book',
          width: draft.width ?? 768,
          height: draft.height ?? 1024,
          size: String(draft.size || ''),
          responseFormat: draft.responseFormat === 'b64_json' ? 'b64_json' : 'url',
          watermark: Boolean(draft.watermark),
          sequentialImageGeneration: draft.sequentialImageGeneration === 'disabled' ? 'disabled' : 'auto',
          referenceSceneIds: Array.isArray(draft.referenceSceneIds) ? draft.referenceSceneIds.map((x: any) => String(x || '').trim()).filter(Boolean) : [],
          steps: draft.steps ?? 20,
          cfgScale: draft.cfgScale ?? 7,
          seed: draft.seed ?? null,
          continuity: draft.continuity || { ipadapterEnabled: true, requireCharacterRefs: false, controlnetEnabled: false, seedMode: 'random' },
          updatedAt: new Date().toISOString()
        })
      )
    } catch {}
  }

export const loadStoryboardContinuityBackup = (key: string): { storyBibleJson?: string; entitySpec?: string; continuity?: any } | null => {
    try {
      const raw = localStorage.getItem(key)
      if (!raw) return null
      const json = JSON.parse(raw) as any
      if (!json || typeof json !== 'object') return null
      return {
        storyBibleJson: typeof json.storyBibleJson === 'string' ? json.storyBibleJson : undefined,
        entitySpec: typeof json.entitySpec === 'string' ? json.entitySpec : undefined,
        continuity: json.continuity && typeof json.continuity === 'object' ? json.continuity : undefined
      }
    } catch {
      return null
    }
  }

export const saveStoryboardContinuityBackup = (key: string, payload: { storyBibleJson?: string; entitySpec?: string; continuity?: any }) => {
    try {
      localStorage.setItem(
        key,
        JSON.stringify({
          storyBibleJson: String(payload.storyBibleJson || ''),
          entitySpec: String(payload.entitySpec || ''),
          continuity: payload.continuity || null,
          updatedAt: new Date().toISOString()
        })
      )
    } catch {}
  }

export const readHubTemplateFields = (): {
    theme: string
    moral: string
    world: string
    protagonist: string
    style: string
    tone: string
    constraints: string
    extra: string
  } | null => {
    try {
      const raw = localStorage.getItem(HUB_TEMPLATE_FIELDS_KEY)
      if (!raw) return null
      const json = JSON.parse(raw) as any
      if (!json || typeof json !== 'object') return null
      return {
        theme: String(json.theme || '').trim(),
        moral: String(json.moral || '').trim(),
        world: String(json.world || '').trim(),
        protagonist: String(json.protagonist || '').trim(),
        style: String(json.style || '').trim(),
        tone: String(json.tone || '').trim(),
        constraints: String(json.constraints || '').trim(),
        extra: String(json.extra || '').trim()
      }
    } catch {
      return null
    }
  }

export const mapTemplateStyleToStoryboardStyle = (
    styleText: string
  ): StoryboardBatchState['style'] => {
    const s = String(styleText || '').toLowerCase()
    if (s.includes('国风') || s.includes('national')) return 'national_style'
    if (s.includes('卡通') || s.includes('cartoon') || s.includes('动漫')) return 'cartoon'
    if (s.includes('水彩') || s.includes('watercolor')) return 'watercolor'
    return 'picture_book'
  }

export const buildGlobalNegativeFromTemplate = (tpl: ReturnType<typeof readHubTemplateFields>) => {
    const base = ['text', 'watermark', 'low quality', 'blurry', 'deformed']
    const c = String(tpl?.constraints || '')
    if (/暴力|血腥/.test(c)) base.push('gore', 'blood')
    if (/恐怖/.test(c)) base.push('horror')
    return Array.from(new Set(base)).join(', ')
  }

export const defaultAiReq: AiBackgroundRequest = {
    userInput: '',
    globalPrompt: '',
    globalNegativePrompt: '',
    backgroundOnly: false,
    prompt: '',
    negativePrompt: '',
    aspectRatio: '9:16',
    style: 'picture_book',
    width: 768,
    height: 1344,
    model: '',
    loras: [],
    size: getDoubaoStoryboardDefaultSize('9:16'),
    responseFormat: 'url',
    watermark: false,
    sequentialImageGeneration: 'auto',
    referenceSceneIds: [],
    steps: 20,
    cfgScale: 7,
    seed: undefined,
    continuity: { ipadapterEnabled: true, requireCharacterRefs: false, controlnetEnabled: false, seedMode: 'random' },
    characterRefs: []
  }
