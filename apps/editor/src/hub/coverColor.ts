// 色卡封面（首页定义 §3.6：缺图用占位纹）：按标题哈希确定性出双色渐变，同色标题恒同色。
// 配色纪律：深色基底 + 单一强调色 #5eccff 的冷色系 tonal 变体，不引入第二种强调色。
const PAIRS: [string, string][] = [
  ['#0b2a3f', '#104862'],
  ['#0d2338', '#1a3a5c'],
  ['#0a1f33', '#143a4f'],
  ['#10263b', '#1c4b66'],
  ['#0b1e30', '#155072'],
  ['#0e2436', '#0f4258'],
  ['#091c2c', '#1b4360'],
  ['#0f2b40', '#12506e']
]

export function coverColor(title: string): { background: string; fg: string } {
  const s = String(title || '')
  let h = 0
  for (const ch of s) {
    h = (h * 31 + (ch.codePointAt(0) || 0)) >>> 0
  }
  const [a, b] = PAIRS[h % PAIRS.length]
  const angle = h % 2 ? '135deg' : '160deg'
  return { background: `linear-gradient(${angle}, ${a}, ${b})`, fg: 'rgba(255,255,255,0.82)' }
}
