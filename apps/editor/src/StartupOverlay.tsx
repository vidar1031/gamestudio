import { useEffect, useRef, useState } from 'react'
import { STARTUP_READY_EVENT } from './startupReady'

type Props = {
  onFinish?: () => void
}

// 2026-08-26 修复：原来写死 3000ms 定时关闭，与实际加载无关。
// 现按真实需求展示：
// 1) 内容工作室初始数据加载完成后发出 STARTUP_READY_EVENT 即收尾；
// 2) 加载在 400ms 内完成时覆盖层不绘制，避免快速加载下闪屏；
// 3) 15s 兜底仅用于请求异常挂死时防止覆盖层永久挡住界面。
const STARTUP_SHOW_DELAY_MS = 400
const STARTUP_FAILSAFE_MS = 15_000

export default function StartupOverlay({ onFinish }: Props) {
  const [visible, setVisible] = useState(true)
  const [painted, setPainted] = useState(false)
  const didFinish = useRef(false)

  useEffect(() => {
    function finish() {
      if (didFinish.current) return
      didFinish.current = true
      setVisible(false)
      onFinish?.()
    }

    window.addEventListener(STARTUP_READY_EVENT, finish, { once: true })
    const showTimer = window.setTimeout(() => setPainted(true), STARTUP_SHOW_DELAY_MS)
    const failsafe = window.setTimeout(finish, STARTUP_FAILSAFE_MS)

    return () => {
      window.removeEventListener(STARTUP_READY_EVENT, finish)
      window.clearTimeout(showTimer)
      window.clearTimeout(failsafe)
    }
  }, [onFinish])

  if (!visible || !painted) return null

  return (
    <div className="startup-overlay">
      <div className="startup-inner" aria-live="polite">
        <div className="startup-orb" />
        <div className="ovo">OVO</div>
        <div className="startup-caption">Interactive Story Studio</div>
      </div>
    </div>
  )
}
