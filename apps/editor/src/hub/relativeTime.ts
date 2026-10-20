// 相对时间（UI 设计规范 §3.4：时间一律相对化，悬停才给精确时间）
export function formatRelativeTime(iso: string): string {
  const t = Date.parse(String(iso || ''))
  if (!Number.isFinite(t)) return ''
  const diff = Date.now() - t
  if (diff < 0) return '刚刚'
  if (diff < 60_000) return '刚刚'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`
  const d = new Date(t)
  const now = new Date()
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  if (d >= new Date(todayStart.getTime() - 86_400_000)) return '昨天'
  const days = Math.floor(diff / 86_400_000)
  if (days <= 30) return `${days} 天前`
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}
