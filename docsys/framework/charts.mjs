// docsys 图形引擎：把 ```chart 围栏块渲染为内联 SVG。零依赖、构建期生成、深色主题。
// 支持三类（DSL 行式文本）：
//   flow   流程图：节点 `id: 标签`，判定节点标签以 ? 结尾（菱形）；连线 `a -> b` 或 `a -> b: 边标签`
//   org    组织结构/树：每行一个节点，两个空进阶一层缩进；**从左向右**布局（根在左，层深向右，叶子纵向排）
//   layers 逻辑分层：一行一层，`|` 或换行分隔
// 尺寸约定：SVG 带固有 width/height（紧凑自然尺寸），超宽时 CSS 等比缩小。
const C = { box: '#161b22', line: '#262d38', fg: '#dbe3ec', dim: '#8b98a8', accent: '#5eccff' }
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
// 估算文本宽度（单位 em）：全角按 1、半角按 0.56
function textEm(s) {
  let n = 0
  for (const ch of String(s)) n += ch.charCodeAt(0) > 255 ? 1 : 0.56
  return Math.max(n, 1)
}
// 盒内字号自适应：以盒宽可容纳为准，区间 9–12px
function fitFs(label, w) {
  return Math.max(9, Math.min(12, Math.floor((w - 16) / textEm(label))))
}

function box(x, y, w, h, label) {
  return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="7" fill="${C.box}" stroke="${C.line}"/><text x="${x + w / 2}" y="${y + h / 2}" fill="${C.fg}" font-size="${fitFs(label, w)}" text-anchor="middle" dominant-baseline="central">${esc(label)}</text>`
}

function diamond(cx, cy, w, h, label) {
  const pts = `${cx},${cy - h / 2} ${cx + w},${cy} ${cx},${cy + h / 2} ${cx - w},${cy}`
  return `<polygon points="${pts}" fill="${C.box}" stroke="${C.accent}"/><text x="${cx}" y="${cy}" fill="${C.fg}" font-size="${fitFs(label, w * 1.4)}" text-anchor="middle" dominant-baseline="central">${esc(label)}</text>`
}

function arrow(x1, y1, x2, y2, label) {
  const mx = (x1 + x2) / 2
  const my = (y1 + y2) / 2
  const ang = Math.atan2(y2 - y1, x2 - x1)
  const ah = 7
  const ax = x2 - ah * Math.cos(ang)
  const ay = y2 - ah * Math.sin(ang)
  const head = `<polygon points="${x2},${y2} ${x2 - 8 * Math.cos(ang - 0.45)},${y2 - 8 * Math.sin(ang - 0.45)} ${x2 - 8 * Math.cos(ang + 0.45)},${y2 - 8 * Math.sin(ang + 0.45)}" fill="${C.accent}"/>`
  const lbl = label ? `<text x="${mx + 5}" y="${my - 3}" fill="${C.dim}" font-size="10">${esc(label)}</text>` : ''
  return `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${C.accent}" stroke-width="1.2"/>${head}${lbl}`
}

function svg(type, w, h, parts) {
  return `<svg class="chart chart-${type}" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" xmlns="http://www.w3.org/2000/svg">${parts.join('')}</svg>`
}

function renderFlow(body) {
  const nodes = new Map()
  const edges = []
  for (const raw of body.split('\n')) {
    const line = raw.trim()
    if (!line) continue
    // 连线（支持链式 a -> b -> c）；尾段可带 ": 边标签"
    if (line.includes('->')) {
      const segs = line.split('->').map((s) => s.trim()).filter(Boolean)
      for (let k = 0; k + 1 < segs.length; k++) {
        let to = segs[k + 1]
        let label = ''
        const lm = to.match(/^([A-Za-z0-9_一-龥]+)\s*[:：]\s*(.+)$/)
        if (lm) { to = lm[1].trim(); label = lm[2].trim() }
        edges.push({ from: segs[k], to, label })
      }
      continue
    }
    const nodeM = line.match(/^([A-Za-z0-9_一-龥]+)\s*[:：]\s*(.+)$/)
    if (nodeM) nodes.set(nodeM[1], nodeM[2].trim())
  }
  for (const e of edges) {
    if (!nodes.has(e.from)) nodes.set(e.from, e.from)
    if (!nodes.has(e.to)) nodes.set(e.to, e.to)
  }
  if (!nodes.size) return '<p class="empty">空流程图</p>'
  // 层级：入度 0 为根，BFS 分层；图含回边（环）时无入度 0 节点，以首个声明节点为根
  const indeg = new Map([...nodes.keys()].map((k) => [k, 0]))
  for (const e of edges) indeg.set(e.to, (indeg.get(e.to) || 0) + 1)
  const level = new Map()
  let queue = [...nodes.keys()].filter((k) => (indeg.get(k) || 0) === 0)
  if (!queue.length) queue = [[...nodes.keys()][0]]
  for (const r of queue) level.set(r, 0)
  const seen = new Set(queue)
  let guard = 0
  // 只按首次访问分层：回边不改写已见节点的层号，避免环形塌陷
  while (queue.length && guard++ < 500) {
    const cur = queue.shift()
    for (const e of edges.filter((x) => x.from === cur)) {
      if (!seen.has(e.to)) {
        level.set(e.to, (level.get(cur) || 0) + 1)
        seen.add(e.to)
        queue.push(e.to)
      }
    }
  }
  for (const k of nodes.keys()) if (!level.has(k)) level.set(k, 0)
  const byLevel = new Map()
  for (const [k, lv] of level) {
    if (!byLevel.has(lv)) byLevel.set(lv, [])
    byLevel.get(lv).push(k)
  }
  const XSP = 168
  const YSP = 72
  const pos = new Map()
  let maxW = 0
  for (const [lv, ids] of byLevel) {
    ids.forEach((id, i) => {
      pos.set(id, { x: i * XSP + 20, y: lv * YSP + 20, w: 136, h: 32, decision: String(nodes.get(id)).includes('?') || String(nodes.get(id)).includes('？') })
    })
    maxW = Math.max(maxW, ids.length * XSP + 40)
  }
  const H = (Math.max(...level.values()) + 1) * YSP + 24
  const parts = []
  for (const e of edges) {
    const a = pos.get(e.from)
    const b = pos.get(e.to)
    parts.push(arrow(a.x + a.w / 2, a.y + a.h, b.x + b.w / 2, b.y, e.label))
  }
  for (const [id, p] of pos) {
    parts.push(p.decision ? diamond(p.x + p.w / 2, p.y + p.h / 2, p.w / 2 + 8, p.h / 2 + 8, nodes.get(id)) : box(p.x, p.y, p.w, p.h, nodes.get(id)))
  }
  return svg('flow', maxW, H, parts)
}

// 组织树：从左向右——层深 d 决定列（x = d·XSP），叶子顺序占行（y = 槽位·YSP），父节点垂直居中于子节点
function renderOrg(body) {
  const lines = body.split('\n').filter((l) => l.trim())
  const items = lines.map((l) => ({ depth: Math.floor((l.match(/^\s*/)[0].length) / 2), label: l.trim() }))
  const W = 150
  const H = 30
  const XSP = 216
  const YSP = 40
  const pos = new Array(items.length)
  let leafSlot = 0
  const childIdx = items.map((_, i) => {
    const d = items[i].depth
    const kids = []
    for (let j = i + 1; j < items.length; j++) {
      if (items[j].depth === d + 1) kids.push(j)
      if (items[j].depth <= d) break
    }
    return kids
  })
  const place = (i) => {
    const kids = childIdx[i]
    if (!kids.length) { pos[i] = { x: items[i].depth * XSP + 20, y: leafSlot * YSP + 16 }; leafSlot += 1; return }
    kids.forEach(place)
    pos[i] = { x: items[i].depth * XSP + 20, y: (pos[kids[0]].y + pos[kids[kids.length - 1]].y) / 2 }
  }
  place(0)
  const maxDepth = Math.max(...items.map((x) => x.depth))
  const width = maxDepth * XSP + W + 60
  const height = Math.max(1, leafSlot) * YSP + 24
  const parts = []
  items.forEach((it, i) => {
    for (const k of childIdx[i]) {
      const x1 = pos[i].x + W
      const y1 = pos[i].y + H / 2
      const x2 = pos[k].x
      const y2 = pos[k].y + H / 2
      const mx = (x1 + x2) / 2
      parts.push(`<path d="M ${x1} ${y1} H ${mx} V ${y2} H ${x2}" fill="none" stroke="${C.accent}" stroke-width="1.2"/>`)
    }
  })
  items.forEach((it, i) => parts.push(box(pos[i].x, pos[i].y, W, H, it.label)))
  return svg('org', width, height, parts)
}

function renderLayers(body) {
  const names = body.split(/[|\n]/).map((s) => s.trim()).filter(Boolean)
  const W = 520
  const H = 34
  const GAP = 8
  const parts = names.map((n, i) => box(20, i * (H + GAP) + 10, W - 40, H, n))
  return svg('layers', W, names.length * (H + GAP) + 12, parts)
}

export function renderChart(spec) {
  const nl = String(spec || '').indexOf('\n')
  const type = (nl < 0 ? spec : spec.slice(0, nl)).trim().toLowerCase()
  const body = nl < 0 ? '' : spec.slice(nl + 1)
  if (type === 'flow') return renderFlow(body)
  if (type === 'org') return renderOrg(body)
  if (type === 'layers') return renderLayers(body)
  return `<p class="empty">未知图形类型：${esc(type)}（支持 flow/org/layers）</p>`
}
