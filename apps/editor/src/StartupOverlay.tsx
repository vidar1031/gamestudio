import { useEffect, useRef, useState } from 'react'

type Props = {
  onFinish?: () => void
}

export default function StartupOverlay({ onFinish }: Props) {
  const [visible, setVisible] = useState(true)
  const [err, setErr] = useState<string | null>(null)
  const minElapsed = useRef(false)
  const didFinish = useRef(false)

  useEffect(() => {
    let aborted = false
    const start = Date.now()

    const minTimer = setTimeout(() => {
      minElapsed.current = true
    }, 3000)

    const ac = new AbortController()
    const timeout = setTimeout(() => ac.abort(), 8000)

    async function check() {
      try {
        const envBase = (import.meta as any).env?.VITE_STUDIO_API_BASE
        const baseUrl = envBase || 'http://localhost:1999'
        const url = `${baseUrl}/api/projects`
        const resp = await fetch(url, { method: 'HEAD', signal: ac.signal })
        if (aborted) return
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`)

        const elapsed = Date.now() - start
        // If connected within 3s -> close immediately
        if (elapsed <= 3000) {
          finish()
          return
        }
        // If min display elapsed -> close; otherwise wait until min elapsed
        if (minElapsed.current) {
          finish()
        } else {
          const when = setInterval(() => {
            if (minElapsed.current) {
              clearInterval(when)
              finish()
            }
          }, 100)
        }
      } catch (e: any) {
        if (ac.signal.aborted) {
          // timeout -> show error and keep overlay
          setErr('网络连接失败，请重试')
          setVisible(true)
          return
        }
        setErr(e?.message ? String(e.message) : '网络错误，请重试')
        setVisible(true)
      } finally {
        clearTimeout(minTimer)
        clearTimeout(timeout)
      }
    }

    check()

    function finish() {
      if (didFinish.current) return
      didFinish.current = true
      setVisible(false)
      onFinish?.()
    }

    return () => {
      aborted = true
      ac.abort()
      clearTimeout(minTimer)
      clearTimeout(timeout)
    }
  }, [onFinish])

  function handleRetry() {
    setErr(null)
    // re-mount by toggling visible true and re-running effect via key change in parent is simpler,
    // but to keep this self-contained we force a reload by reloading the page.
    // This keeps behavior deterministic for startup network checks.
    window.location.reload()
  }

  if (!visible && !err) return null

  return (
    <div className="startup-overlay">
      <div className="startup-inner" aria-live="polite">
        <div className="ovo">oVo</div>
        {err ? (
          <div className="startup-err">
            <div>{err}</div>
            <div style={{ marginTop: 12 }}>
              <button className="btn" onClick={handleRetry}>
                重试
              </button>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  )
}
