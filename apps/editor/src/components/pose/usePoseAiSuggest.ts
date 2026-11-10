// AI 姿态建议共享 Hook（2026-11-01）：包装 generateCharacterPosePromptAi，
// 蓝图姿态需求编辑器的「AI 建议」与后续其它定义端入口共用（能力此前在锁定向导，随定义期前移迁入蓝图）。
import { useRef, useState } from 'react'
import { generateCharacterPosePromptAi } from '../../api'

export function usePoseAiSuggest(projectId: string) {
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const seq = useRef(0)

  const suggest = async (payload: {
    characterName: string
    fingerprintPrompt?: string
    sceneText?: string
    userHint?: string
  }): Promise<{ promptZh: string; promptEn: string } | null> => {
    if (busy) return null
    const mySeq = ++seq.current
    setBusy(true)
    setErr('')
    try {
      const res = await generateCharacterPosePromptAi(projectId, payload)
      if (mySeq !== seq.current) return null // 过期响应丢弃（用户连点防护）
      return res
    } catch (e) {
      if (mySeq === seq.current) setErr(e instanceof Error ? e.message : String(e))
      return null
    } finally {
      if (mySeq === seq.current) setBusy(false)
    }
  }

  return { suggest, busy, err }
}
