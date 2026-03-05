import { useEffect, useRef, useState } from 'react'

type Props = {
  onFinish?: () => void
}

export default function StartupOverlay({ onFinish }: Props) {
  const [visible, setVisible] = useState(true)
  const didFinish = useRef(false)

  useEffect(() => {
    const timer = window.setTimeout(() => finish(), 3000)

    function finish() {
      if (didFinish.current) return
      didFinish.current = true
      setVisible(false)
      onFinish?.()
    }

    return () => {
      window.clearTimeout(timer)
    }
  }, [onFinish])

  if (!visible) return null

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
