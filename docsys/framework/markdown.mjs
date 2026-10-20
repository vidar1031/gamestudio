// docsys 零依赖 Markdown 渲染器（构建期用，覆盖文档体系所需子集）：
// 标题/段落/表格/列表(有序无序)/代码围栏/行内代码/粗斜体/链接/图片/引用/分隔线/front-matter。
// 设计取舍：只支持文档写作常用子集，不追求 CommonMark 全兼容——体系文档作者自律使用子集语法。

import { renderChart } from './charts.mjs'

export function parseFrontMatter(src) {
  const text = String(src || '')
  if (!text.startsWith('---')) return { meta: {}, body: text }
  const end = text.indexOf('\n---', 3)
  if (end < 0) return { meta: {}, body: text }
  const meta = {}
  for (const line of text.slice(3, end).split('\n')) {
    const m = line.match(/^\s*([A-Za-z_\-\u4e00-\u9fff]+)\s*:\s*(.*)$/)
    if (m) meta[m[1]] = m[2].trim()
  }
  return { meta, body: text.slice(end + 4).replace(/^\r?\n/, '') }
}

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function inline(s) {
  let t = esc(s)
  t = t.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, '<img alt="$1" src="$2" loading="lazy">')
  t = t.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, txt, href) => {
    const safe = /^(\.\.?\/|\/|https?:)/.test(href) ? href : '#'
    return `<a href="${safe}">${txt}</a>`
  })
  t = t.replace(/`([^`]+)`/g, '<code>$1</code>')
  t = t.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
  t = t.replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, '<em>$1</em>')
  return t
}

function isTableSep(line) {
  return /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(line) && line.includes('-')
}

export function renderMarkdown(src) {
  const lines = String(src || '').replace(/\r\n/g, '\n').split('\n')
  const out = []
  let i = 0
  let listStack = null // 'ul' | 'ol'
  const closeList = () => {
    if (listStack) { out.push(`</${listStack}>`); listStack = null }
  }
  while (i < lines.length) {
    const line = lines[i]
    // 代码围栏
    if (/^```/.test(line)) {
      closeList()
      const fence = line.slice(3).trim().split(/\s+/)
      const lang = fence[0] || ''
      const buf = []
      i += 1
      while (i < lines.length && !/^```/.test(lines[i])) { buf.push(lines[i]); i += 1 }
      i += 1
      if (lang === 'chart') {
        // ```chart flow|org|layers：类型取围栏行第二词，DSL 正文为块内容
        out.push(`<figure class="chart-wrap">${renderChart(`${fence[1] || ''}\n${buf.join('\n')}`)}</figure>`)
      } else {
        out.push(`<pre class="code${lang ? ` lang-${esc(lang)}` : ''}"><code>${esc(buf.join('\n'))}</code></pre>`)
      }
      continue
    }
    // 表格：表头行 + 分隔行
    if (line.includes('|') && i + 1 < lines.length && isTableSep(lines[i + 1])) {
      closeList()
      const head = line.replace(/^\||\|$/g, '').split('|').map((c) => c.trim())
      const aligns = lines[i + 1].replace(/^\||\|$/g, '').split('|').map((c) => {
        const t = c.trim()
        return t.startsWith(':') && t.endsWith(':') ? 'center' : (t.endsWith(':') ? 'right' : 'left')
      })
      i += 2
      const rows = []
      while (i < lines.length && lines[i].includes('|') && lines[i].trim() !== '') {
        rows.push(lines[i].replace(/^\||\|$/g, '').split('|').map((c) => c.trim()))
        i += 1
      }
      const th = head.map((c, k) => `<th style="text-align:${aligns[k] || 'left'}">${inline(c)}</th>`).join('')
      const trs = rows.map((r) => `<tr>${r.map((c, k) => `<td style="text-align:${aligns[k] || 'left'}">${inline(c)}</td>`).join('')}</tr>`).join('')
      out.push(`<table><thead><tr>${th}</tr></thead><tbody>${trs}</tbody></table>`)
      continue
    }
    // 标题
    const h = line.match(/^(#{1,6})\s+(.*)$/)
    if (h) {
      closeList()
      const level = h[1].length
      out.push(`<h${level} id="h-${level}-${i}">${inline(h[2])}</h${level}>`)
      i += 1
      continue
    }
    // 分隔线
    if (/^\s*---+\s*$/.test(line)) { closeList(); out.push('<hr>'); i += 1; continue }
    // 引用
    if (/^>\s?/.test(line)) {
      closeList()
      const buf = []
      while (i < lines.length && /^>\s?/.test(lines[i])) { buf.push(lines[i].replace(/^>\s?/, '')); i += 1 }
      out.push(`<blockquote>${buf.map((b) => `<p>${inline(b)}</p>`).join('')}</blockquote>`)
      continue
    }
    // 列表
    const ul = line.match(/^\s*[-*+]\s+(.*)$/)
    const ol = line.match(/^\s*\d+[.、)]\s*(.*)$/)
    if (ul || ol) {
      const want = ul ? 'ul' : 'ol'
      if (listStack !== want) { closeList(); out.push(`<${want}>`); listStack = want }
      out.push(`<li>${inline((ul || ol)[1])}</li>`)
      i += 1
      continue
    }
    closeList()
    // 空行
    if (line.trim() === '') { i += 1; continue }
    // 段落（合并连续行）
    const buf = [line]
    i += 1
    while (i < lines.length && lines[i].trim() !== '' && !/^(#{1,6}\s|```|>|---+\s*$|\s*[-*+]\s|\s*\d+[.、)]\s)/.test(lines[i]) && !(lines[i].includes('|') && i + 1 < lines.length && isTableSep(lines[i + 1]))) {
      buf.push(lines[i]); i += 1
    }
    out.push(`<p>${inline(buf.join(' '))}</p>`)
  }
  closeList()
  return out.join('\n')
}
