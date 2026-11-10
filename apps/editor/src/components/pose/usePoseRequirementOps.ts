// 姿态需求写口共享 Hook（2026-11-01）：蓝图定义端「整单保存」语义——
// busy/err/note 状态与成功提示计时统一收口，调用方只给 upsert 适配器与保存后回调。
import { useRef, useState } from 'react'

export function usePoseRequirementOps(opts: {
  upsertAll: (assetId: string, requirements: any[]) => Promise<boolean>
  onSaved?: (assetId: string) => void | Promise<void>
}) {
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [note, setNote] = useState('')
  const noteTimer = useRef<number | null>(null)

  const flashNote = (text: string, ms = 2500) => {
    setNote(text)
    if (noteTimer.current) window.clearTimeout(noteTimer.current)
    noteTimer.current = window.setTimeout(() => setNote(''), ms)
  }

  const save = async (assetId: string, requirements: any[], okNote: string) => {
    if (busy) return
    setBusy(true)
    setErr('')
    setNote('')
    try {
      const ok = await opts.upsertAll(assetId, requirements)
      if (!ok) throw new Error('保存失败')
      flashNote(okNote)
      await opts.onSaved?.(assetId)
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return { save, busy, err, note, flashNote, setErr }
}
