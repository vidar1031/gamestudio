// 双稿翻译共享 Hook（2026-11-01）：包装 translateStoryboardPromptText（zh→en，prompt 模式），
// 蓝图姿态需求编辑器「翻译为英文」与合成层翻译链同一条服务端通道。
import { useRef, useState } from 'react'
import { translateStoryboardPromptText } from '../../storyboardPromptTranslate'

export function usePromptTranslate(projectId: string) {
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const seq = useRef(0)

  const translate = async (zh: string): Promise<string | null> => {
    const text = String(zh || '').trim()
    if (!text || busy) return null
    const mySeq = ++seq.current
    setBusy(true)
    setErr('')
    try {
      const res = await translateStoryboardPromptText(projectId, { text, sourceLang: 'zh', targetLang: 'en', mode: 'prompt', timeoutMs: 60_000 })
      const en = String(res?.result?.translatedText || '').trim()
      if (mySeq !== seq.current) return null
      if (!en) throw new Error('翻译结果为空')
      return en
    } catch (e) {
      if (mySeq === seq.current) setErr(e instanceof Error ? e.message : String(e))
      return null
    } finally {
      if (mySeq === seq.current) setBusy(false)
    }
  }

  return { translate, busy, err }
}
