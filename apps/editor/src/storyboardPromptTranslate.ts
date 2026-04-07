import { translatePromptTextAi } from './api'

export async function translateStoryboardPromptText(
  projectId: string,
  payload: {
    text: string
    sourceLang?: 'auto' | 'zh' | 'en'
    targetLang: 'zh' | 'en'
    mode?: 'prompt' | 'plain'
    timeoutMs?: number
  }
) {
  return translatePromptTextAi(projectId, payload)
}
