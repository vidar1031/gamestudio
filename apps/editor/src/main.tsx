import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './style.css'

// 2026-10-05 界面自动更新探针：轮询业务后端 /api/health 的 buildId（每次服务启动生成），
// 与页面加载时的值不一致说明服务端已重启/升级——自动刷新页面，用户无需手动强刷。
// 注意：比较的是"页面加载时"的 buildId，不是上次轮询值——避免服务连续重启时错过跳变。
;(function autoReloadOnBackendRestart() {
  let initialBuildId: string | null = null
  let failures = 0
  const tick = async () => {
    try {
      const res = await fetch('http://127.0.0.1:1999/api/health', { cache: 'no-store' })
      if (!res.ok) return
      const data = await res.json().catch(() => null)
      const bid = data && typeof data === 'object' ? String((data as any).buildId || '') : ''
      if (!bid) return
      failures = 0
      if (initialBuildId === null) {
        initialBuildId = bid
        return
      }
      if (bid !== initialBuildId) {
        window.location.reload()
      }
    } catch {
      // 后端暂时不可达（重启中）：容忍 3 次后若恢复会重新同步 initialBuildId
      failures += 1
      if (failures > 3) initialBuildId = null
    }
  }
  void tick()
  window.setInterval(tick, 15000)
})()

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)

