// 草稿历史共享模块（2026-10-20，新建页独立化）：
// Hub 草稿条目与 CreateStoryPage 共用的草稿读写 + 草稿载入跳转的 prefill 通道（sessionStorage）。

export const AI_DRAFT_HISTORY_KEY = 'talkscene.ai.draftHistory'
export const AI_DRAFT_HISTORY_MAX = 8

export type AiDraftHistoryItem = {
  projectId: string
  title: string
  choicePoints: number
  optionsPerChoice: number
  createdAt: string
  // 生成结果快照（2026-10-05）：记录上限 8 条、单条约几十 KB
  result?: any
}

export function readAiDraftHistory(): AiDraftHistoryItem[] {
  try {
    const raw = JSON.parse(localStorage.getItem(AI_DRAFT_HISTORY_KEY) || '[]')
    return Array.isArray(raw) ? raw.filter((x) => x && x.projectId) : []
  } catch {
    return []
  }
}

export function recordAiDraftHistory(item: AiDraftHistoryItem) {
  const list = readAiDraftHistory().filter((x) => x.projectId !== item.projectId)
  list.unshift(item)
  try {
    localStorage.setItem(AI_DRAFT_HISTORY_KEY, JSON.stringify(list.slice(0, AI_DRAFT_HISTORY_MAX)))
  } catch {
    /* ignore */
  }
}

export function removeAiDraftHistory(projectId: string) {
  try {
    localStorage.setItem(AI_DRAFT_HISTORY_KEY, JSON.stringify(readAiDraftHistory().filter((x) => x.projectId !== projectId)))
  } catch {
    /* ignore */
  }
}

// 草稿「载入继续生成」→ 新建页 的交接通道（读后即清除）
export const CREATE_PREFILL_KEY = 'talkscene.create.prefill'

export type CreatePrefill = {
  title: string
  prompt: string
  choicePoints: number
  optionsPerChoice: number
  endings: number
}

export function writeCreatePrefill(p: CreatePrefill) {
  try {
    sessionStorage.setItem(CREATE_PREFILL_KEY, JSON.stringify(p))
  } catch {
    /* ignore */
  }
}

export function consumeCreatePrefill(): CreatePrefill | null {
  try {
    const raw = sessionStorage.getItem(CREATE_PREFILL_KEY)
    if (!raw) return null
    sessionStorage.removeItem(CREATE_PREFILL_KEY)
    const j = JSON.parse(raw)
    if (!j || typeof j !== 'object') return null
    return {
      title: String(j.title || ''),
      prompt: String(j.prompt || ''),
      choicePoints: Number(j.choicePoints) || 2,
      optionsPerChoice: Number(j.optionsPerChoice) === 3 ? 3 : 2,
      endings: Number(j.endings) || Number(j.optionsPerChoice) || 2
    }
  } catch {
    return null
  }
}
