// docsys 构建器：读 content/<产品册>/manifest.json + markdown 内容 → dist/ 纯静态站点。
// 框架/数据分离铁律：本文件不得出现任何项目专属内容；产品册数据全在 content/ 下。
// 用法：node docsys/framework/render.mjs [--scaffold]
//   --scaffold：content 册中 manifest 声明而文件缺失的文档，从 framework/templates/ 对应骨架生成初始实例。

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseFrontMatter, renderMarkdown } from './markdown.mjs'

const DOCSYS_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const CONTENT_DIR = path.join(DOCSYS_ROOT, 'content')
const TEMPLATE_DIR = path.join(DOCSYS_ROOT, 'framework', 'templates')
const DIST_DIR = path.join(DOCSYS_ROOT, 'dist')
const SCAFFOLD = process.argv.includes('--scaffold')

const read = (p) => fs.readFileSync(p, 'utf8')
const write = (p, s) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, s) }
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

function wordCount(md) {
  return (String(md).replace(/[#>*`|\-\[\]()`!]/g, '').match(/[\u4e00-\u9fff]|[A-Za-z0-9_]+/g) || []).length
}

function loadBook(bookDir) {
  const manifestPath = path.join(bookDir, 'manifest.json')
  if (!fs.existsSync(manifestPath)) return null
  const manifest = JSON.parse(read(manifestPath))
  const docs = []
  for (const group of manifest.groups || []) {
    for (const doc of group.docs || []) {
      const file = path.resolve(bookDir, String(doc.file || ''))
      let meta = {}
      let body = ''
      let missing = true
      if (doc.file && fs.existsSync(file)) {
        const parsed = parseFrontMatter(read(file))
        meta = parsed.meta
        body = parsed.body
        missing = false
      } else if (SCAFFOLD && doc.template) {
        const tpl = path.join(TEMPLATE_DIR, String(doc.template))
        if (fs.existsSync(tpl)) {
          const skeleton = read(tpl).replaceAll('{{标题}}', doc.title || doc.id || '未命名')
          write(file, skeleton)
          console.log(`[scaffold] 生成骨架：${path.relative(DOCSYS_ROOT, file)}`)
          const parsed = parseFrontMatter(skeleton)
          meta = parsed.meta
          body = parsed.body
          missing = false
        }
      }
      const status = String(meta.status || doc.status || '未开始').trim()
      docs.push({
        id: String(doc.id || docs.length),
        group: group.name || '未分组',
        title: String(doc.title || doc.id || '未命名'),
        standard: String(doc.standard || '').trim(),
        status,
        owner: String(meta.owner || doc.owner || '').trim(),
        version: String(meta.version || '').trim(),
        updated: String(meta.updated || '').trim(),
        file: missing ? '' : path.relative(bookDir, file),
        words: missing ? 0 : wordCount(body),
        missing
      })
    }
  }
  return { manifest, docs, dir: bookDir, slug: path.basename(bookDir) }
}

const STATUS_ORDER = ['完成', '评审中', '编写中', '未开始']
const STATUS_CLASS = { 完成: 'done', 评审中: 'review', 编写中: 'writing', 未开始: 'todo' }

function statusBadge(status) {
  return `<span class="badge st-${STATUS_CLASS[status] || 'todo'}">${esc(status)}</span>`
}

function pageShell({ title, bookTitle, nav, body, subtitle }) {
  return `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} · ${esc(bookTitle)}</title><link rel="stylesheet" href="assets/style.css"></head>
<body><header class="topbar"><a class="brand" href="index.html">${esc(bookTitle)}</a><span class="sub">${esc(subtitle || '')}</span></header>
<div class="layout">${nav}<main class="content">${body}</main></div>
<footer class="foot">docsys · GB/T 8567 文档体系 · 框架与数据分离，可整体拷贝复用</footer></body></html>`
}

function navHtml(book, activeId) {
  const groups = []
  let cur = null
  for (const d of book.docs) {
    if (!cur || cur.name !== d.group) { cur = { name: d.group, docs: [] }; groups.push(cur) }
    cur.docs.push(d)
  }
  const items = groups.map((g) => `<div class="nav-group"><div class="nav-group-name">${esc(g.name)}</div>${g.docs.map((d) => `<a class="nav-item${d.id === activeId ? ' active' : ''}" href="doc_${encodeURIComponent(d.id)}.html">${statusBadge(d.status)}<span class="nav-title">${esc(d.title)}</span></a>`).join('')}</div>`).join('')
  return `<nav class="sidenav"><a class="nav-home" href="index.html">体系目录</a>${items}</nav>`
}

function renderBook(book) {
  const outDir = path.join(DIST_DIR, book.slug)
  const total = book.docs.length
  const done = book.docs.filter((d) => d.status === '完成').length
  const active = book.docs.filter((d) => d.status !== '未开始').length
  const wordsTotal = book.docs.reduce((n, d) => n + d.words, 0)
  const nav = navHtml(book, '')

  const groups = []
  let cur = null
  for (const d of book.docs) {
    if (!cur || cur.name !== d.group) { cur = { name: d.group, docs: [] }; groups.push(cur) }
    cur.docs.push(d)
  }
  const cards = groups.map((g) => `
<section class="group"><h2>${esc(g.name)}</h2><div class="cards">${g.docs.map((d) => `
<a class="card${d.missing ? ' missing' : ''}" href="doc_${encodeURIComponent(d.id)}.html">
<div class="card-head">${statusBadge(d.status)}<span class="std">${esc(d.standard)}</span></div>
<div class="card-title">${esc(d.title)}</div>
<div class="card-meta">${d.words} 字${d.updated ? ` · ${esc(d.updated)}` : ''}${d.owner ? ` · ${esc(d.owner)}` : ''}</div>
</a>`).join('')}</div></section>`).join('')

  const home = pageShell({
    title: '体系目录',
    bookTitle: book.manifest.product || book.slug,
    subtitle: 'GB/T 8567 文档体系',
    nav,
    body: `
<h1>${esc(book.manifest.product || book.slug)}</h1>
<p class="lead">${esc(book.manifest.description || '')}</p>
<div class="progress"><div class="progress-bar"><div class="progress-fill" style="width:${total ? Math.round((done / total) * 100) : 0}%"></div></div>
<div class="progress-text">${done}/${total} 完成 · ${active} 进行中 · 共 ${wordsTotal} 字</div></div>
${cards}`
  })
  write(path.join(outDir, 'index.html'), home)

  for (const d of book.docs) {
    const file = d.file ? path.join(book.dir, d.file) : ''
    const body = file && fs.existsSync(file) ? renderMarkdown(parseFrontMatter(read(file)).body) : '<p class="empty">本文档尚未建立内容文件。</p>'
    const idx = book.docs.findIndex((x) => x.id === d.id)
    const prev = idx > 0 ? book.docs[idx - 1] : null
    const next = idx < book.docs.length - 1 ? book.docs[idx + 1] : null
    const page = pageShell({
      title: d.title,
      bookTitle: book.manifest.product || book.slug,
      subtitle: `${d.group} · ${d.standard || '扩展'}`,
      nav: navHtml(book, d.id),
      body: `
<div class="doc-head">${statusBadge(d.status)}<h1>${esc(d.title)}</h1>
<div class="doc-meta">${d.standard ? `标准：${esc(d.standard)} · ` : ''}${d.owner ? `负责人：${esc(d.owner)} · ` : ''}${d.version ? `版本：${esc(d.version)} · ` : ''}${d.words} 字${d.updated ? ` · 更新：${esc(d.updated)}` : ''}</div></div>
<article class="doc-body">${body}</article>
<div class="doc-nav">${prev ? `<a href="doc_${encodeURIComponent(prev.id)}.html">← ${esc(prev.title)}</a>` : '<span></span>'}${next ? `<a href="doc_${encodeURIComponent(next.id)}.html">${esc(next.title)} →</a>` : ''}</div>`
    })
    write(path.join(outDir, `doc_${d.id}.html`), page)
  }
  return { slug: book.slug, total, done, active, wordsTotal }
}

function main() {
  if (!fs.existsSync(CONTENT_DIR)) { console.error('缺少 content/ 目录'); process.exit(1) }
  const books = fs.readdirSync(CONTENT_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => loadBook(path.join(CONTENT_DIR, e.name)))
    .filter(Boolean)
  if (!books.length) { console.error('content/ 下没有任何产品册（缺 manifest.json）'); process.exit(1) }
  fs.rmSync(DIST_DIR, { recursive: true, force: true })
  fs.mkdirSync(DIST_DIR, { recursive: true })
  fs.cpSync(path.join(DOCSYS_ROOT, 'framework', 'assets'), path.join(DIST_DIR, 'assets'), { recursive: true })
  const summaries = books.map((b) => renderBook(b))
  // 样式同步进每个产品册目录：书页用相对路径 assets/style.css，保证任意子路径/file:// 部署都能找到
  for (const s of summaries) {
    fs.cpSync(path.join(DOCSYS_ROOT, 'framework', 'assets'), path.join(DIST_DIR, s.slug, 'assets'), { recursive: true })
  }
  const rootIndex = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>文档体系 · docsys</title><link rel="stylesheet" href="assets/style.css"></head><body>
<header class="topbar"><span class="brand">docsys 文档体系</span><span class="sub">GB/T 8567</span></header>
<main class="home"><h1>产品册</h1><div class="cards">${summaries.map((s) => {
    const b = books.find((x) => x.slug === s.slug)
    return `<a class="card" href="${s.slug}/index.html"><div class="card-title">${esc(b.manifest.product || s.slug)}</div>
<div class="card-meta">${s.done}/${s.total} 完成 · ${s.wordsTotal} 字</div></a>`
  }).join('')}</div></main></body></html>`
  write(path.join(DIST_DIR, 'index.html'), rootIndex)
  for (const s of summaries) console.log(`[build] ${s.slug}: ${s.done}/${s.total} 完成，${s.wordsTotal} 字`)
  console.log(`[build] 站点输出：${path.relative(process.cwd(), DIST_DIR)}/（preview: npm run docsys:serve）`)
}

main()
