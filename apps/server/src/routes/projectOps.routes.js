// ---------------------------------------------------------------------------
// registerProjectOpsRoutes（模块化拆分机械迁出，字义未改；协议层+族内编排，域算法引自 ../ai/*，index 本地辅助经 ctx 注入）
// ---------------------------------------------------------------------------
import path from 'node:path'
import { spawn } from 'node:child_process'
import { mkdir, readFile, readdir, rename, stat, writeFile, rm, copyFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import crypto from 'node:crypto'
import { classifyAiError, createTraceId, logStage } from '../ai/runtime.js'
import { createAiTask, getAiTask, listAiTasks, listAllAiTasks, loadAiTasksFromDisk, loadAllAiTasksFromDisk } from '../ai/taskProgress.js'
import { generateBackgroundImage } from '../ai/background.js'
import { optimizeGeneratedImage, optimizeDirectoryTree, IMAGE_KIND } from '../ai/imageOptimize.js'
import { sniffImageMetaFromBytes } from '../ai/storyAssetReferenceGate.js'
import { COMPLETENESS_TASK_KIND, createNodeVisualReviewer, createPuppeteerBrowserLauncher, loadLatestCompletenessReport, resolveChromeExecutablePath, resolveReviewConfig, runStoryCompletenessCheck } from '../ai/storyCompleteness.js'
import { translatePromptText } from '../ai/translate.js'
import { generateBackgroundPrompt } from '../ai/imagePrompt.js'
import { getStoryImageCoverage } from '../ai/storyCoverage.js'
import { withResourceLease } from '../ai/resourceLease.js'
import { readStudioModelDialogs } from '../ai/modelDialogs.js'
import { getEffectiveStudioConfig } from '../studio/settings.js'
import { storyInputGate } from '../middleware/storyInputGate.js'

export function registerProjectOpsRoutes(app, ctx) {
app.get('/api/demos', async (c) => {
  await ctx.ensureDirs()
  const items = []
  const dirs = await readdir(ctx.DEMO_LIBRARY_DIR).catch(() => [])
  for (const id of dirs) {
    const dir = ctx.demoLibDir(id)
    if (!(await ctx.existsDir(dir))) continue
    try {
      const story = await ctx.readJson(path.join(dir, 'story.json'))
      const nodes = Array.isArray(story && story.nodes) ? story.nodes : []
      let title = String(id)
      let demoProject = null
      try { demoProject = await ctx.readJson(path.join(dir, 'project.json')) } catch (_) {}
      try {
        const meta = await ctx.readJson(path.join(dir, 'demo.json'))
        if (meta && typeof meta.title === 'string' && meta.title.trim()) title = meta.title.trim()
      } catch (_) {}
      items.push({ id: String(id), title: (demoProject && demoProject.title) ? String(demoProject.title) : title, nodesCount: nodes.length })
    } catch (_) {}
  }
  items.sort((a, b) => String(a.id).localeCompare(String(b.id)))
  return c.json({ success: true, items })
})

app.get('/api/demos/:id', async (c) => {
  await ctx.ensureDirs()
  const id = c.req.param('id')
  const dir = ctx.demoLibDir(id)
  if (!(await ctx.existsDir(dir))) return c.json({ success: false, error: 'not_found' }, 404)
  const story = await ctx.readJson(path.join(dir, 'story.json'))
  let title = String(id)
  let demoProject = null
  try { demoProject = await ctx.readJson(path.join(dir, 'project.json')) } catch (_) {}
  try {
    const meta = await ctx.readJson(path.join(dir, 'demo.json'))
    if (meta && typeof meta.title === 'string' && meta.title.trim()) title = meta.title.trim()
  } catch (_) {}
  return c.json({
    success: true,
    demo: { id: String(id), title: (demoProject && demoProject.title) ? String(demoProject.title) : title, assetBase: `/demo-library/${encodeURIComponent(String(id))}/` },
    project: demoProject || null,
    story
  })
})

// [拆分] POST /api/projects/:id/ai/story/walkthrough 已迁至 apps/server/src/routes/storyScenes.routes.js
// [拆分] POST /api/projects/:id/ai/story/scene-review 已迁至 apps/server/src/routes/storyScenes.routes.js
// [拆分] GET /api/projects/:id/ai/story/scene-review 已迁至 apps/server/src/routes/storyScenes.routes.js
// [拆分] POST /api/projects/:id/ai/story/scene-review/feedback 已迁至 apps/server/src/routes/storyScenes.routes.js
app.get('/demo-library/:demoId/:rest{.*}', async (c) => {
  await ctx.ensureDirs()
  const demoId = c.req.param('demoId')
  let rest = String(c.req.param('rest') || '')
  try {
    rest = decodeURIComponent(rest)
  } catch (_) {}
  rest = rest.replace(/\\/g, '/').replace(/^\/+/, '')
  if (!rest || rest.split('/').some((seg) => seg === '..')) return c.text('Not Found', 404)
  const filePath = path.join(ctx.demoLibDir(demoId), rest)
  try {
    const buf = await readFile(filePath)
    const ext = path.extname(filePath).toLowerCase()
    const ct =
      ext === '.html' ? 'text/html; charset=utf-8' :
      ext === '.json' ? 'application/json; charset=utf-8' :
      ext === '.js' ? 'application/javascript; charset=utf-8' :
      ext === '.css' ? 'text/css; charset=utf-8' :
      ext in {'.png':1,'.jpg':1,'.jpeg':1,'.gif':1,'.webp':1} ? 'image/' + ext.slice(1) :
      'application/octet-stream'
    c.header('Content-Type', ct)
    return c.body(buf)
  } catch (_) {
    return c.text('Not Found', 404)
  }
})

app.get('/demos/:projectId/:buildId/:rest{.*}', async (c) => {
  await ctx.ensureDirs()
  const projectId = c.req.param('projectId')
  const buildId = c.req.param('buildId')
  let rest = String(c.req.param('rest') || '')
  try {
    rest = decodeURIComponent(rest)
  } catch (_) {}
  rest = rest.replace(/\\/g, '/').replace(/^\/+/, '')
  if (!rest || rest.split('/').some((seg) => seg === '..')) return c.text('Not Found', 404)
  const baseDir = ctx.projectBuildDir(projectId, buildId)
  const filePath = path.join(baseDir, rest)
  try {
    const buf = await readFile(filePath)
    // 简单 content-type
    const ext = path.extname(filePath).toLowerCase()
    const ct =
      ext === '.html' ? 'text/html; charset=utf-8' :
      ext === '.json' ? 'application/json; charset=utf-8' :
      ext === '.js' || ext === '.mjs' ? 'application/javascript; charset=utf-8' :
      ext === '.css' ? 'text/css; charset=utf-8' :
      ext === '.zip' ? 'application/zip' :
      'application/octet-stream'
    if (ext === '.zip') c.header('Content-Disposition', `attachment; filename="${path.basename(filePath)}"`)
    c.header('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0')
    c.header('Pragma', 'no-cache')
    c.header('Expires', '0')
    c.header('Content-Type', ct)
    return c.body(buf)
  } catch (_) {
    return c.text('Not Found', 404)
  }
})

// 静态服务 project assets（用于编辑器预览 assets/...）
// 兼容：/project-assets/<pid>/assets/uploads/<file>
app.get('/project-assets/:projectId/assets/uploads/:file', async (c) => {
  await ctx.ensureDirs()
  // Ensure cross-origin image loading works in editor (Pixi/WebGL needs CORS-enabled images).
  c.header('Access-Control-Allow-Origin', '*')
  c.header('Cross-Origin-Resource-Policy', 'cross-origin')
  const projectId = c.req.param('projectId')
  const file = path.basename(String(c.req.param('file') || ''))
  if (!file) return c.text('Not Found', 404)
  const filePath = path.join(ctx.projectDir(projectId), 'assets', 'uploads', file)
  try {
    const buf = await readFile(filePath)
    const ext = path.extname(filePath).toLowerCase()
    const ct =
      ext === '.png' ? 'image/png' :
      ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' :
      ext === '.webp' ? 'image/webp' :
      ext === '.gif' ? 'image/gif' :
      'application/octet-stream'
    c.header('Content-Type', ct)
    return c.body(buf)
  } catch (_) {
    return c.text('Not Found', 404)
  }
})

app.on('HEAD', '/project-assets/:projectId/assets/uploads/:file', async (c) => {
  await ctx.ensureDirs()
  c.header('Access-Control-Allow-Origin', '*')
  c.header('Cross-Origin-Resource-Policy', 'cross-origin')
  const projectId = c.req.param('projectId')
  const file = path.basename(String(c.req.param('file') || ''))
  if (!file) return c.text('Not Found', 404)
  const filePath = path.join(ctx.projectDir(projectId), 'assets', 'uploads', file)
  if (!(await ctx.existsFile(filePath))) return c.text('Not Found', 404)
  const ext = path.extname(filePath).toLowerCase()
  const ct =
    ext === '.png' ? 'image/png' :
    ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' :
    ext === '.webp' ? 'image/webp' :
    ext === '.gif' ? 'image/gif' :
    'application/octet-stream'
  c.header('Content-Type', ct)
  return c.text('', 200)
})

app.get('/project-assets/:projectId/:rest{.*}', async (c) => {
  await ctx.ensureDirs()
  // Ensure cross-origin image loading works in editor (Pixi/WebGL needs CORS-enabled images).
  c.header('Access-Control-Allow-Origin', '*')
  c.header('Cross-Origin-Resource-Policy', 'cross-origin')
  const projectId = c.req.param('projectId')
  let rest = String(c.req.param('rest') || '')
  try {
    rest = decodeURIComponent(rest)
  } catch (_) {}
  rest = rest.replace(/\\/g, '/').replace(/^\/+/, '')
  if (!rest || rest.split('/').some((seg) => seg === '..')) return c.text('Not Found', 404)
  const base = ctx.projectDir(projectId)
  const candidates = [path.join(base, rest)]
  if (!rest.startsWith('assets/')) candidates.push(path.join(base, 'assets', rest))
  let filePath = ''
  for (const cand of candidates) {
    if (await ctx.existsFile(cand)) {
      filePath = cand
      break
    }
  }
  if (!filePath) return c.text('Not Found', 404)
  try {
    const buf = await readFile(filePath)
    const ext = path.extname(filePath).toLowerCase()
    let ct =
      ext === '.png' ? 'image/png' :
      ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' :
      ext === '.webp' ? 'image/webp' :
      ext === '.gif' ? 'image/gif' :
      ext === '.json' ? 'application/json; charset=utf-8' :
      'application/octet-stream'
    const sniff = ct.startsWith('image/') ? sniffImageMetaFromBytes(buf) : null
    if (sniff && sniff.contentType) ct = sniff.contentType
    c.header('Content-Type', ct)
    return c.body(buf)
  } catch (_) {
    return c.text('Not Found', 404)
  }
})

app.on('HEAD', '/project-assets/:projectId/:rest{.*}', async (c) => {
  await ctx.ensureDirs()
  c.header('Access-Control-Allow-Origin', '*')
  c.header('Cross-Origin-Resource-Policy', 'cross-origin')
  const projectId = c.req.param('projectId')
  let rest = String(c.req.param('rest') || '')
  try {
    rest = decodeURIComponent(rest)
  } catch (_) {}
  rest = rest.replace(/\\/g, '/').replace(/^\/+/, '')
  if (!rest || rest.split('/').some((seg) => seg === '..')) return c.text('Not Found', 404)
  const base = ctx.projectDir(projectId)
  const candidates = [path.join(base, rest)]
  if (!rest.startsWith('assets/')) candidates.push(path.join(base, 'assets', rest))
  let filePath = ''
  for (const cand of candidates) {
    if (await ctx.existsFile(cand)) {
      filePath = cand
      break
    }
  }
  if (!filePath) return c.text('Not Found', 404)
  const ext = path.extname(filePath).toLowerCase()
  const ct =
    ext === '.png' ? 'image/png' :
    ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' :
    ext === '.webp' ? 'image/webp' :
    ext === '.gif' ? 'image/gif' :
    ext === '.json' ? 'application/json; charset=utf-8' :
    'application/octet-stream'
  c.header('Content-Type', ct)
  return c.text('', 200)
})

// 查看 AI 背景图输出目录（浏览器可打开，便于确认生成位置）
app.get('/api/projects/:id/assets/ai', async (c) => {
  await ctx.ensureDirs()
  const id = c.req.param('id')
  const dir = ctx.projectDir(id)
  if (!(await ctx.existsDir(dir))) return c.text('Not Found', 404)

  const relDir = path.join('assets', 'ai')
  const outDir = path.join(dir, relDir)
  const items = await readdir(outDir).catch(() => [])
  const files = items
    .map((x) => String(x))
    .filter((x) => /\.(png|jpg|jpeg|webp|gif)$/i.test(x))
    .sort((a, b) => (a < b ? 1 : -1))

  const rows = files
    .map((f) => {
      const safe = encodeURIComponent(f)
      const url = `/project-assets/${encodeURIComponent(String(id))}/${relDir.replace(/\\/g, '/')}/${safe}`
      return `<li><a href="${url}" target="_blank" rel="noopener noreferrer">${f}</a></li>`
    })
    .join('\n')

  const html =
    `<!doctype html><html><head><meta charset="utf-8" />` +
    `<title>AI 背景输出目录</title>` +
    `<style>body{font-family:ui-sans-serif,system-ui;max-width:920px;margin:24px auto;padding:0 16px;line-height:1.6}code{background:#0b1220;color:#e5e7eb;padding:2px 6px;border-radius:6px}a{color:#2563eb;text-decoration:none}a:hover{text-decoration:underline}</style>` +
    `</head><body>` +
    `<h2>AI 背景输出目录</h2>` +
    `<div>项目：<code>${String(id)}</code></div>` +
    `<div>相对路径：<code>${relDir.replace(/\\/g, '/')}</code></div>` +
    `<div>绝对路径：<code>${outDir}</code></div>` +
    `<hr />` +
    (files.length ? `<ol>${rows}</ol>` : `<div>暂无文件（请先生成背景图）。</div>`) +
    `</body></html>`

  c.header('Content-Type', 'text/html; charset=utf-8')
  return c.body(html)
})

// [拆分回收] 辅助定义 已回 index.js

// [拆分回收] 辅助定义 已回 index.js

// [拆分回收] 辅助定义 已回 index.js

// [拆分回收] 辅助定义 已回 index.js

// [拆分回收] 辅助定义 已回 index.js

app.post('/api/projects/:id/assets/open-folder', async (c) => {
  await ctx.ensureDirs()
  const id = c.req.param('id')
  const dir = ctx.projectDir(id)
  if (!(await ctx.existsDir(dir))) return c.json({ success: false, error: 'not_found' }, 404)

  const body = await c.req.json().catch(() => ({}))
  const uri = String(body?.uri || '').trim()
  // 2026-09-09：不传 uri 时打开项目 AI 素材根目录（assets/ai，不存在退回 assets）——
  // 编辑器顶栏「素材目录」入口，直接管理全部 AI 生成图
  if (!uri) {
    const aiDir = path.join(dir, 'assets', 'ai')
    const target = (await ctx.existsDir(aiDir)) ? aiDir : path.join(dir, 'assets')
    try {
      await ctx.openFolderOnHost(target)
      return c.json({ success: true, folder: target })
    } catch (e) {
      return c.json({ success: false, error: 'open_folder_failed', message: e && e.message ? e.message : String(e), folder: target }, 500)
    }
  }
  const abs = ctx.resolveAssetPathFromUri(id, uri)
  if (!abs) return c.json({ success: false, error: 'invalid_uri', message: '无法从 URI 解析到项目资源路径' }, 400)
  const folder = path.dirname(abs)
  try {
    await ctx.openFolderOnHost(folder)
    return c.json({ success: true, folder })
  } catch (e) {
    return c.json({ success: false, error: 'open_folder_failed', message: e && e.message ? String(e.message) : String(e), folder }, 500)
  }
})

// 上传本地资源（P0：仅图片，保存到 projects/<id>/assets/uploads）
app.post('/api/projects/:id/assets/upload', async (c) => {
  await ctx.ensureDirs()
  const id = c.req.param('id')
  const dir = ctx.projectDir(id)
  if (!(await ctx.existsDir(dir))) return c.json({ success: false, error: 'not_found' }, 404)

  let file = null
  try {
    const form = await c.req.parseBody()
    file = form && (form.file || form.image || form.asset) ? (form.file || form.image || form.asset) : null
  } catch (_) {
    file = null
  }

  const isFileLike = (v) => {
    try {
      return v && typeof v === 'object' && typeof v.arrayBuffer === 'function'
    } catch (_) {
      return false
    }
  }
  if (!isFileLike(file)) {
    return c.json({ success: false, error: 'missing_file', message: '请使用 multipart/form-data 上传字段 file' }, 400)
  }

  const name = String(file.name || 'image.png')
  const ext = path.extname(name).toLowerCase()
  const allowed = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif'])
  if (!allowed.has(ext)) {
    return c.json({ success: false, error: 'unsupported_type', message: `仅支持图片：${Array.from(allowed).join(', ')}` }, 415)
  }

  try {
    const relDir = path.join('assets', 'uploads')
    const outDir = path.join(dir, relDir)
    await mkdir(outDir, { recursive: true })
    const safeBase = path.basename(name, ext).replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 48) || 'image'
    const fname = `${safeBase}_${Date.now()}${ext}`
    const abs = path.join(outDir, fname)
    const buf = Buffer.from(await file.arrayBuffer())
    await writeFile(abs, buf)
    const assetPath = `${relDir}/${fname}`.replace(/\\/g, '/')
    return c.json({ success: true, assetPath, url: `/project-assets/${encodeURIComponent(String(id))}/${assetPath}` })
  } catch (e) {
    return c.json({ success: false, error: 'save_failed', message: e && e.message ? e.message : String(e) }, 500)
  }
})

// 2026-09-09 素材复用：跨项目素材库（只读聚合，扫描 storage/projects 各项目的图片资产）。
// 用途：故事多了以后，已生成的角色/道具/背景可以直接导入新项目复用，不必重复抽卡。
app.get('/api/assets-library', async (c) => {
  await ctx.ensureDirs()
  const excludeProjectId = String(c.req.query('excludeProjectId') || '').trim()
  const items = []
  const projects = await readdir(ctx.PROJECTS_DIR).catch(() => [])
  for (const pid of projects) {
    if (pid === excludeProjectId) continue
    const pdir = path.join(ctx.PROJECTS_DIR, pid)
    if (!(await ctx.existsDir(pdir))) continue
    let proj = null
    try { proj = await ctx.readJson(path.join(pdir, 'project.json')) } catch (_) { continue }
    const title = String(proj?.title || pid)
    const list = Array.isArray(proj?.assets) ? proj.assets : []
    for (const a of list) {
      if (!a || String(a.kind || '') !== 'image') continue
      const uri = String(a.uri || '').trim()
      if (!uri.startsWith('assets/')) continue
      const abs = path.join(pdir, uri)
      if (!(await ctx.existsFile(abs))) continue
      items.push({ projectId: pid, projectTitle: title, assetId: String(a.id || ''), name: String(a.name || ''), uri, source: a.source ? { type: a.source.type, prompt: String(a.source.prompt || '').slice(0, 160) } : null })
    }
  }
  return c.json({ success: true, count: items.length, items })
})

// 2026-09-09 存量素材批压（用户指令：故事多了图片爆涨，大图必须全部压缩）。
// 扫描 assets/ai 全部 PNG/JPG：场景背景→JPEG q90；立绘/cutout/主参考→无损 WebP（零质量损失）；
// 候选/绿幕/线稿/测试图→WebP q92。扩展名变化同步改写 project.json 与 story-assets/plan.json 的 uri 引用
// （文本级替换，文件路径唯一不会误伤；reviews 等历史记录不改）。幂等，可复跑。
app.post('/api/projects/:id/assets/compress', async (c) => {
  await ctx.ensureDirs()
  const id = c.req.param('id')
  const dir = ctx.projectDir(id)
  if (!(await ctx.existsDir(dir))) return c.json({ success: false, error: 'not_found' }, 404)
  const aiDir = path.join(dir, 'assets', 'ai')
  if (!(await ctx.existsDir(aiDir))) return c.json({ success: true, stats: null, message: '无 assets/ai 目录' })

  const stats = await optimizeDirectoryTree(aiDir)
  // uri 重写：绝对路径 → 项目内相对路径对
  const uriPairs = (stats.rewrites || [])
    .filter((r) => r && r.from && r.to && !r.error)
    .map((r) => ({
      from: path.relative(dir, r.from).replace(/\\/g, '/'),
      to: path.relative(dir, r.to).replace(/\\/g, '/')
    }))
    .filter((p) => p.from !== p.to)
  let refsRewritten = 0
  if (uriPairs.length) {
    for (const rel of ['project.json', path.join('story-assets', 'plan.json')]) {
      const abs = path.join(dir, rel)
      if (!(await ctx.existsFile(abs))) continue
      let text = await readFile(abs, 'utf8')
      let changed = 0
      for (const p of uriPairs) {
        if (text.includes(p.from)) {
          text = text.split(p.from).join(p.to)
          changed += 1
        }
      }
      if (changed > 0) {
        await writeFile(abs, text, 'utf8')
        refsRewritten += changed
      }
    }
  }
  return c.json({
    success: stats.failed === 0,
    stats: {
      total: stats.total,
      compressed: stats.compressed,
      skipped: stats.skipped,
      failed: stats.failed,
      srcMB: Math.round((stats.srcBytes / 1e6) * 10) / 10,
      dstMB: Math.round((stats.dstBytes / 1e6) * 10) / 10,
      refsRewritten,
      failures: (stats.rewrites || []).filter((r) => r.error).slice(0, 10)
    }
  })
})

// 2026-09-09 素材导入：把其他项目（或本项目历史）的图片资产复制进当前项目并登记为新资产。
// 复制到 assets/ai/imported/，source 留痕 {type:'import', fromProject, fromAssetId}。
app.post('/api/projects/:id/assets/import', async (c) => {
  await ctx.ensureDirs()
  const id = c.req.param('id')
  const dir = ctx.projectDir(id)
  if (!(await ctx.existsDir(dir))) return c.json({ success: false, error: 'not_found' }, 404)
  const body = await c.req.json().catch(() => ({}))
  const sourceProjectId = String(body?.sourceProjectId || '').trim()
  const assetIds = Array.isArray(body?.assetIds) ? body.assetIds.map((x) => String(x || '').trim()).filter(Boolean) : []
  if (!sourceProjectId || !assetIds.length) {
    return c.json({ success: false, error: 'missing_params', message: 'sourceProjectId 与 assetIds 必填' }, 400)
  }
  const srcDir = ctx.projectDir(sourceProjectId)
  if (!(await ctx.existsDir(srcDir))) return c.json({ success: false, error: 'source_not_found' }, 404)
  const srcProj = await ctx.readJson(path.join(srcDir, 'project.json')).catch(() => null)
  if (!srcProj) return c.json({ success: false, error: 'source_project_invalid' }, 400)
  const dstProj = await ctx.readJson(path.join(dir, 'project.json'))
  const dstAssets = Array.isArray(dstProj.assets) ? dstProj.assets : []
  const imported = []
  const errors = []
  for (const aid of assetIds) {
    const srcAsset = (Array.isArray(srcProj.assets) ? srcProj.assets : []).find((a) => String(a?.id || '') === aid)
    const uri = String(srcAsset?.uri || '').trim()
    if (!srcAsset || !uri.startsWith('assets/')) { errors.push({ assetId: aid, error: 'asset_not_found' }); continue }
    const srcAbs = path.join(srcDir, uri)
    if (!srcAbs.startsWith(srcDir) || !(await ctx.existsFile(srcAbs))) { errors.push({ assetId: aid, error: 'file_not_found' }); continue }
    try {
      const ext = path.extname(uri) || '.png'
      const relDir = path.join('assets', 'ai', 'imported')
      await mkdir(path.join(dir, relDir), { recursive: true })
      const fname = `${path.basename(uri, ext)}_${Date.now()}${ext}`
      const dstAbs = path.join(dir, relDir, fname)
      await copyFile(srcAbs, dstAbs)
      const rel = `${relDir}/${fname}`.replace(/\\/g, '/')
      const newAsset = {
        id: `asset_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`,
        kind: 'image',
        name: String(srcAsset.name || '导入素材'),
        uri: rel,
        source: { type: 'import', fromProject: sourceProjectId, fromAssetId: aid, prompt: String(srcAsset?.source?.prompt || '').slice(0, 1800) }
      }
      dstAssets.push(newAsset)
      imported.push(newAsset)
    } catch (e) {
      errors.push({ assetId: aid, error: String(e && e.message ? e.message : e) })
    }
  }
  if (imported.length) {
    dstProj.assets = dstAssets
    dstProj.updatedAt = new Date().toISOString()
    await ctx.writeJson(path.join(dir, 'project.json'), dstProj)
  }
  return c.json({ success: errors.length === 0, imported, errors })
})

// AI 生成背景图（P0：默认对接 SDWebUI txt2img；ComfyUI 预留）
// 说明：此功能只用于制作阶段生成素材，最终产物仍需通过 app_system 导入。
app.post('/api/projects/:id/ai/background', storyInputGate('story.background.generate', (c, body) => ({ projectId: c.req.param('id'), ...body })), async (c) => {
  await ctx.ensureDirs()
  const id = c.req.param('id')
  const dir = ctx.projectDir(id)
  if (!(await ctx.existsDir(dir))) return c.json({ success: false, error: 'not_found' }, 404)

	const body = await c.req.json().catch(() => ({}))
	const scenePrompt = String(body?.prompt || '').trim()
	const sceneNegative = String(body?.negativePrompt || '').trim()
	const globalPrompt = String(body?.globalPrompt || '').trim()
	const globalNegativePrompt = String(body?.globalNegativePrompt || '').trim()
  const requestedModel = String(body?.model || '').trim()
  const requestedLoras = Array.isArray(body?.loras) ? body.loras.map((x) => String(x || '').trim()).filter(Boolean) : []
  const continuity = body && body.continuity && typeof body.continuity === 'object' ? body.continuity : null
	const width = Number(body?.width || 768)
	const height = Number(body?.height || 1024)
	if (!scenePrompt) return c.json({ success: false, error: 'missing_prompt' }, 400)

  const studio = await getEffectiveStudioConfig(ctx.ROOT)
  if (!studio.effective.enabled.image) {
    return c.json({ success: false, error: 'disabled', message: '“出图（背景图生成）”已在设置中关闭' }, 503)
  }
	const bgProvider = String(studio.effective.image.provider || process.env.STUDIO_BG_PROVIDER || 'sdwebui').toLowerCase()
  if (!bgProvider || bgProvider === 'none') {
    return c.json({ success: false, error: 'user_provider_not_configured', message: '请先在设置中启用“出图（背景图）”并选择 Provider/Model' }, 400)
  }
  const timeoutRaw = body?.timeoutMs
  const bgTimeoutMs = (Number.isFinite(Number(timeoutRaw)) && Number(timeoutRaw) <= 0)
    ? 0
    : ctx.clampInt(timeoutRaw, 5_000, 300_000, ctx.clampInt(process.env.STUDIO_BG_TIMEOUT_MS, 5_000, 300_000, 180_000))
	const startedAt = Date.now()
  const traceId = createTraceId()
  const promptJoiner = (bgProvider === 'sdwebui' || bgProvider === 'comfyui') ? ', ' : '，'
	const effectivePrompt = [globalPrompt, scenePrompt].map((s) => String(s || '').replace(/\s+/g, ' ').trim()).filter(Boolean).join(promptJoiner)
	const effectiveNegative = [globalNegativePrompt, sceneNegative].map((s) => String(s || '').replace(/\s+/g, ' ').trim()).filter(Boolean).join(', ')
  const referenceImageUrls = Array.isArray(body?.referenceImageUrls)
    ? body.referenceImageUrls.map((x) => String(x || '').trim()).filter((x) => ctx.isExternallyReachableReferenceUrl(x))
    : []
  const requestedReferenceCount = Array.isArray(body?.referenceImageUrls)
    ? body.referenceImageUrls.map((x) => String(x || '').trim()).filter(Boolean).length
    : 0
  if (requestedReferenceCount > 0 && referenceImageUrls.length === 0) {
    return c.json({ success: false, error: 'reference_image_unreachable', message: '所选参考图链接仅本机可访问，Doubao 云端无法下载。请改用带 remoteUrl 的参考场景图。' }, 400)
  }
  const characterRefsIn = Array.isArray(body?.characterRefs) ? body.characterRefs : []
  const assetRefsIn = Array.isArray(body?.assetRefs) ? body.assetRefs : []
  const referenceImages = []
  for (const item of characterRefsIn) {
    if (!item || typeof item !== 'object') continue
    const characterId = String(item.characterId || '').trim()
    if (!characterId) continue
    const assetAbs = ctx.resolveAssetPathFromUri(id, item.assetUri || item.assetPath || '')
    if (!assetAbs || !(await ctx.existsFile(assetAbs))) continue
    try {
      const bytes = await readFile(assetAbs)
      referenceImages.push({
        role: 'character',
        characterId,
        characterName: String(item.characterName || characterId).trim() || characterId,
        assetId: String(item.assetId || '').trim() || undefined,
        filename: path.basename(assetAbs),
        bytes,
        weight: Number.isFinite(Number(item.weight)) ? Number(item.weight) : undefined,
        fingerprintPrompt: String(item.fingerprintPrompt || '').trim() || undefined
      })
    } catch (_) {}
  }
  for (const item of assetRefsIn) {
    if (!item || typeof item !== 'object') continue
    const assetId = String(item.assetId || '').trim()
    const assetName = String(item.assetName || item.name || assetId || 'reference').trim()
    const assetAbs = ctx.resolveAssetPathFromUri(id, item.assetUri || item.assetPath || '')
    if (!assetAbs || !(await ctx.existsFile(assetAbs))) continue
    try {
      const bytes = await readFile(assetAbs)
      referenceImages.push({
        role: String(item.assetType || item.category || 'asset').trim() || 'asset',
        assetId: assetId || undefined,
        assetName,
        filename: path.basename(assetAbs),
        bytes,
        weight: Number.isFinite(Number(item.weight)) ? Number(item.weight) : undefined
      })
    } catch (_) {}
  }
  logStage({
    stage: 'bg.create',
    event: 'start',
    traceId,
    project: id,
    provider: bgProvider,
    model: requestedModel || studio.effective.image.model || '-',
    item: `w${Math.floor(width || 0)}h${Math.floor(height || 0)} refs:${referenceImages.length}`
  })

	try {
	  const gen = await generateBackgroundImage({
	    prompt: effectivePrompt,
	    negativePrompt: effectiveNegative,
	    aspectRatio: body?.aspectRatio,
	    style: body?.style,
	    size: body?.size || studio.effective.image.size,
	    responseFormat: body?.responseFormat,
      watermark: body?.watermark,
      guidanceScale: body?.guidanceScale,
      sequentialImageGeneration: body?.sequentialImageGeneration,
      width,
      height,
      steps: body?.steps,
      cfgScale: body?.cfgScale,
      sampler: body?.sampler,
	      scheduler: body?.scheduler,
        seed: body?.seed,
        continuity,
          referenceImageUrls,
        referenceImages,
      workflowMode: String(body?.workflowMode || '').trim() || undefined,
      lockProfile: String(body?.lockProfile || '').trim() || undefined,
      provider: bgProvider,
      sdwebuiBaseUrl: studio.effective.image.sdwebuiBaseUrl,
      comfyuiBaseUrl: studio.effective.image.comfyuiBaseUrl,
      apiUrl: studio.effective.image.apiUrl,
      model: requestedModel || studio.effective.image.model,
      loras: requestedLoras.length ? requestedLoras : studio.effective.image.loras,
      proxyUrl: studio.effective.network.proxyUrl,
      timeoutMs: bgTimeoutMs
	    })
	    const buf = gen.bytes
	    const ext0 = String(gen.ext || 'png').replace(/[^a-z0-9]+/gi, '') || 'png'
	    const sniff = sniffImageMetaFromBytes(buf)
	    const ext = (sniff && sniff.ext ? sniff.ext : ext0) || 'png'
	    const relDir = path.join('assets', 'ai')
	    const outDir = path.join(dir, relDir)
	    await mkdir(outDir, { recursive: true })
      const existingAssetUri = String(body?.existingAssetUri || '').trim()
      const existingAssetAbs = existingAssetUri ? ctx.resolveAssetPathFromUri(id, existingAssetUri) : null
      let abs = ''
      let assetPath = ''
      if (existingAssetAbs && await ctx.existsFile(existingAssetAbs)) {
        const archived = await ctx.archiveExistingAssetForReplacement(id, existingAssetUri)
        abs = existingAssetAbs
        await writeFile(abs, buf)
        assetPath = String(ctx.assetPathFromAbsolute(id, abs) || '')
        if (!assetPath) throw new Error('invalid_replacement_asset_path')
        console.log(`[talkscene] bg replace archived=${archived ? path.basename(archived) : '-'} restored=${path.basename(abs)}`)
      } else {
        const fname = `bg_${Date.now()}.${ext}`
        abs = path.join(outDir, fname)
        await writeFile(abs, buf)
        assetPath = `${relDir}/${fname}`.replace(/\\/g, '/')
      }
      { // 2026-09-09 出图即压：背景 JPEG q90（用户指令：源头治理大图爆涨）
        const opt = await optimizeGeneratedImage(abs, IMAGE_KIND.SCENE_BG).catch(() => null)
        if (opt && opt.outPath && opt.outPath !== abs) assetPath = String(ctx.assetPathFromAbsolute(id, opt.outPath) || assetPath)
      }
		    const provider = (gen && gen.meta && gen.meta.provider) ? String(gen.meta.provider) : String(process.env.STUDIO_BG_PROVIDER || 'sdwebui')
		    const remoteUrl = (gen && gen.meta && typeof gen.meta.url === 'string' && gen.meta.url.trim()) ? String(gen.meta.url).trim() : ''
        logStage({
          stage: 'bg.create',
          event: 'ok',
          traceId,
          project: id,
          provider,
          model: studio.effective.image.model || '-',
          ok: true,
          durationMs: Math.max(0, Date.now() - startedAt),
          item: `${ext}:${buf.length}`
        })
		    return c.json({
          success: true,
          provider,
          assetPath,
          url: `/project-assets/${encodeURIComponent(String(id))}/${assetPath}`,
          remoteUrl,
          traceId,
          seed: gen && gen.meta ? gen.meta.seed : undefined,
          continuityUsed: Boolean(gen && gen.meta && gen.meta.continuityUsed)
        })
		  } catch (e) {
		    const msg = e && e.message ? String(e.message) : String(e)
        const mapped = classifyAiError(e)
        logStage({
          stage: 'bg.create',
          event: 'fail',
          traceId,
          project: id,
          provider: bgProvider,
          model: studio.effective.image.model || '-',
          status: mapped.httpStatus,
          ok: false,
          durationMs: Math.max(0, Date.now() - startedAt),
          err: msg
        })
        return c.json({ success: false, error: mapped.code, message: msg, traceId }, mapped.httpStatus)
	  }
})

// AI 解析用户描述 -> 生成标准生图提示词（用于豆包/Seedream）
app.post('/api/projects/:id/ai/background/prompt', async (c) => {
  await ctx.ensureDirs()
  const id = c.req.param('id')
  const dir = ctx.projectDir(id)
  if (!(await ctx.existsDir(dir))) return c.json({ success: false, error: 'not_found' }, 404)

	const body = await c.req.json().catch(() => ({}))
	const userInput = String(body?.userInput || '').trim()
	const globalPrompt = String(body?.globalPrompt || '').trim()
	const globalNegativePrompt = String(body?.globalNegativePrompt || '').trim()
	const aspectRatio = String(body?.aspectRatio || '').trim()
	const style = String(body?.style || '').trim()
  const outputLanguage = String(body?.outputLanguage || '').trim().toLowerCase() || 'en'
  const promptTimeoutMs = ctx.clampInt(
    body?.timeoutMs,
    5_000,
    180_000,
    ctx.clampInt(process.env.STUDIO_PROMPT_TIMEOUT_MS, 5_000, 180_000, 90_000)
  )
	if (!userInput) return c.json({ success: false, error: 'missing_userInput' }, 400)

  const studio = await getEffectiveStudioConfig(ctx.ROOT)
  if (!studio.effective.enabled.prompt) {
    return c.json({ success: false, error: 'disabled', message: '“提示词生成”已在设置中关闭' }, 503)
  }
  if (!studio.effective.prompt.provider || studio.effective.prompt.provider === 'none') {
    return c.json({ success: false, error: 'user_provider_not_configured', message: '请先在设置中启用“提示词生成”并选择 Provider/Model' }, 400)
  }

	const startedAt = Date.now()
  const traceId = createTraceId()
  logStage({
    stage: 'bg.prompt',
    event: 'start',
    traceId,
    project: id,
    provider: studio.effective.prompt.provider || 'localoxml',
    model: studio.effective.prompt.model || '-',
    item: `chars:${userInput.length}`
  })
	try {
	  const { result, meta } = await generateBackgroundPrompt({
      userInput,
      globalPrompt,
      globalNegativePrompt,
      aspectRatio,
      style,
      outputLanguage,
      timeoutMs: promptTimeoutMs,
      targetImageProvider: studio.effective.image.provider,
      provider: studio.effective.prompt.provider,
      model: studio.effective.prompt.model,
      apiUrl: studio.effective.prompt.apiUrl,
      proxyUrl: studio.effective.network.proxyUrl
    })
    logStage({
      stage: 'bg.prompt',
      event: 'ok',
      traceId,
      project: id,
      provider: meta && meta.provider ? meta.provider : studio.effective.prompt.provider || 'localoxml',
      model: meta && meta.model ? meta.model : studio.effective.prompt.model || '-',
      ok: true,
      durationMs: Math.max(0, Date.now() - startedAt)
    })
	  return c.json({ success: true, result, meta, traceId })
  } catch (e) {
    const msg = e && e.message ? String(e.message) : String(e)
    const mapped = classifyAiError(e)
    logStage({
      stage: 'bg.prompt',
      event: 'fail',
      traceId,
      project: id,
      provider: studio.effective.prompt.provider || 'localoxml',
      model: studio.effective.prompt.model || '-',
      status: mapped.httpStatus,
      ok: false,
      durationMs: Math.max(0, Date.now() - startedAt),
      err: msg
    })
    return c.json({ success: false, error: mapped.code, message: msg, traceId }, mapped.httpStatus)
  }
})

// AI：生成 Story Bible（角色/道具/地点锁定，用于连续分镜）

app.post('/api/projects/:id/ai/translate', async (c) => {
  await ctx.ensureDirs()
  const id = c.req.param('id')
  const dir = ctx.projectDir(id)
  if (!(await ctx.existsDir(dir))) return c.json({ success: false, error: 'not_found' }, 404)

  const body = await c.req.json().catch(() => ({}))
  const textIn = String(body?.text || '').trim()
  if (!textIn) return c.json({ success: false, error: 'missing_text', message: 'text 不能为空' }, 400)

  const timeoutRaw = Number(body?.timeoutMs)
  const timeoutMs = (Number.isFinite(timeoutRaw) && timeoutRaw <= 0)
    ? 0
    : ctx.clampInt(body?.timeoutMs, 5_000, 180_000, ctx.clampInt(process.env.STUDIO_PROMPT_TIMEOUT_MS, 5_000, 180_000, 60_000))

  const studio = await getEffectiveStudioConfig(ctx.ROOT)
  const translationCfg = studio.effective.translation || {}
  const promptCfg = studio.effective.prompt || {}
  const providers = [
    { provider: String(translationCfg.provider || '').trim().toLowerCase(), model: translationCfg.model, apiUrl: translationCfg.apiUrl, note: null },
    { provider: String(promptCfg.provider || '').trim().toLowerCase(), model: promptCfg.model, apiUrl: promptCfg.apiUrl, note: 'translation_fallback_to_prompt_provider' }
  ].filter((item, index, list) => item.provider && item.provider !== 'none' && list.findIndex((entry) => entry.provider === item.provider && String(entry.apiUrl || '') === String(item.apiUrl || '')) === index)

  if (!providers.length) {
    return c.json({ success: false, error: 'user_provider_not_configured', message: '请先在设置中配置“提示词翻译接口”' }, 400)
  }

  const startedAt = Date.now()
  const traceId = createTraceId()
  const primaryProvider = providers[0]
  logStage({ stage: 'prompt.translate', event: 'start', traceId, project: id, provider: primaryProvider.provider || 'localoxml', model: primaryProvider.model || '-' })
  try {
    let translated = null
    let lastError = null
    for (const candidate of providers) {
      try {
        translated = await translatePromptText({
          provider: candidate.provider,
          model: candidate.model,
          apiUrl: candidate.apiUrl,
          proxyUrl: studio.effective.network.proxyUrl,
          timeoutMs,
          text: textIn,
          sourceLang: body?.sourceLang,
          targetLang: body?.targetLang,
          mode: body?.mode
        })
        if (translated && candidate.note) {
          translated.meta = { ...(translated.meta || {}), note: candidate.note }
        }
        break
      } catch (e) {
        lastError = e
      }
    }
    if (!translated) throw lastError || new Error('translation_failed')
    const { result, meta } = translated
    logStage({ stage: 'prompt.translate', event: 'ok', traceId, project: id, provider: meta && meta.provider ? meta.provider : primaryProvider.provider || 'localoxml', model: meta && meta.model ? meta.model : primaryProvider.model || '-', ok: true, durationMs: Math.max(0, Date.now() - startedAt) })
    return c.json({ success: true, result, meta, traceId })
  } catch (e) {
    const msg = e && e.message ? String(e.message) : String(e)
    const mapped = classifyAiError(e)
    logStage({ stage: 'prompt.translate', event: 'fail', traceId, project: id, provider: primaryProvider.provider || 'localoxml', model: primaryProvider.model || '-', status: mapped.httpStatus, ok: false, durationMs: Math.max(0, Date.now() - startedAt), err: msg })
    return c.json({ success: false, error: mapped.code, message: msg, traceId }, mapped.httpStatus)
  }

})

// [拆分] POST /api/projects/:id/ai/story/composition 已迁至 apps/server/src/routes/storyScenes.routes.js

// [拆分] GET /api/projects/:id/ai/reviews 已迁至 apps/server/src/routes/review.routes.js
// [拆分] POST /api/projects/:id/ai/reviews/:reviewId/approve 已迁至 apps/server/src/routes/review.routes.js
// [拆分] POST /api/projects/:id/ai/reviews/:reviewId/reject 已迁至 apps/server/src/routes/review.routes.js
// [拆分] POST /api/projects/:id/ai/reviews/approve-all 已迁至 apps/server/src/routes/review.routes.js
// 全局任务台账（2026-10-20）：跨项目聚合只读，供编辑器全局任务指示器——talkscene 独立运行（无守护台）时任务进度也全程可见。
app.get('/api/ai/tasks', async (c) => {
  await loadAllAiTasksFromDisk()
  const includeDone = String(c.req.query('includeDone') || '1') !== '0'
  return c.json({ success: true, tasks: listAllAiTasks({ includeDone }) })
})

app.get('/api/projects/:id/ai/tasks', async (c) => {
  const id = c.req.param('id')
  await loadAiTasksFromDisk(id)
  const includeDone = String(c.req.query('includeDone') || '1') !== '0'
  return c.json({ success: true, tasks: listAiTasks(id, { includeDone }) })
})

// 模型对话明细（只读，2026-10-12）：本地 oMLX 调用按日落盘（state/model-dialogs/），
// 守护台「模型交互」视图经 control 代理合并消费；记录不带项目归属，按时间窗返回最近 N 条
app.get('/api/projects/:id/ai/model-dialogs', async (c) => {
  const id = c.req.param('id')
  const dir = ctx.projectDir(id)
  if (!(await ctx.existsDir(dir))) return c.json({ success: false, error: 'not_found' }, 404)
  const { entries, scope, note } = readStudioModelDialogs({ limit: Number(c.req.query('limit') || 50) })
  return c.json({ success: true, projectId: id, scope, note, entries })
})

app.get('/api/projects/:id/ai/tasks/:taskId', async (c) => {
  const id = c.req.param('id')
  await loadAiTasksFromDisk(id)
  const task = getAiTask(c.req.param('taskId'))
  if (!task || task.projectId !== id) return c.json({ success: false, error: 'not_found' }, 404)
  return c.json({ success: true, task })
})

// 出图总账：需要多少图/完成多少/缺哪些，从 plan/story/project/reviews+磁盘确定性聚合（只读）
app.get('/api/projects/:id/ai/coverage', async (c) => {
  const id = c.req.param('id')
  const dir = ctx.projectDir(id)
  if (!(await ctx.existsDir(dir))) return c.json({ success: false, error: 'not_found' }, 404)
  const coverage = await getStoryImageCoverage(dir)
  return c.json({ success: true, coverage })
})

// 创作过程缓冲查询（只读）：日志尾部 + 快照列表。恢复时手工把快照目录里的文件复制回项目根即可。
app.get('/api/projects/:id/creation-buffer', async (c) => {
  const id = c.req.param('id')
  const dir = ctx.projectDir(id)
  if (!(await ctx.existsDir(dir))) return c.json({ success: false, error: 'not_found' }, 404)
  const bufDir = path.join(dir, 'creation-buffer')
  const journalFile = path.join(bufDir, 'journal.jsonl')
  let journal = []
  try {
    const raw = await readFile(journalFile, 'utf-8')
    journal = raw.split('\n').map((l) => l.trim()).filter(Boolean).slice(-50).map((l) => { try { return JSON.parse(l) } catch (_) { return null } }).filter(Boolean).reverse()
  } catch (_) { /* 尚无日志 */ }
  const snapRoot = path.join(bufDir, 'snapshots')
  const snapEntries = await readdir(snapRoot, { withFileTypes: true }).catch(() => [])
  const snapshots = snapEntries.filter((e) => e.isDirectory()).map((e) => e.name).sort().reverse().slice(0, 20)
  return c.json({ success: true, journal, snapshots })
})

// [拆分] POST /api/projects/:id/ai/story/scenes/:sceneId/render 已迁至 apps/server/src/routes/storyScenes.routes.js
// [拆分] POST /api/projects/:id/ai/story/scenes/render-all 已迁至 apps/server/src/routes/storyScenes.routes.js

// [拆分] GET /api/projects/:id/ai/story/scenes/:sceneId/images 已迁至 apps/server/src/routes/storyScenes.routes.js
// [拆分] POST /api/projects/:id/ai/story/scenes/:sceneId/bind 已迁至 apps/server/src/routes/storyScenes.routes.js
// [拆分] POST /api/projects/:id/ai/story/scenes/:sceneId/images/delete 已迁至 apps/server/src/routes/storyScenes.routes.js
// ---------------------------------------------------------------------------
// AUTO-E05：故事完整度核实——真实浏览器逐节点走查导出的可玩 H5，
// 确定性检查（console 错误/背景/立绘/文本/选项/可达性）+ Kimi 视觉评审 + 截图留证。
// 只读 QA（不生成任何资产），故不挂出图审核门禁；长任务经 /ai/tasks 暴露进度（仓库硬规则）。
// ---------------------------------------------------------------------------
app.post('/api/projects/:id/ai/story/completeness-check', async (c) => {
  await ctx.ensureDirs()
  const id = c.req.param('id')
  const dir = ctx.projectDir(id)
  if (!(await ctx.existsDir(dir))) return c.json({ success: false, error: 'not_found' }, 404)

  // 前置确定性校验：无导出产物 / 无 Chrome / 空故事都直接失败，不进异步任务
  const distIndex = path.join(ctx.projectBuildDir(id, 'latest'), 'dist', 'index.html')
  if (!(await ctx.existsFile(distIndex))) {
    return c.json({ success: false, error: 'missing_dist', message: '未找到导出产物 builds/latest/dist/index.html，请先导出。' }, 400)
  }
  if (!resolveChromeExecutablePath()) {
    return c.json({ success: false, error: 'chrome_not_found', message: '未找到本机 Chrome（可设 STUDIO_CHROME_PATH 指定）。' }, 400)
  }
  const bundle = await ctx.readProjectBundle(id)
  const storyNodes = Array.isArray(bundle.story?.nodes) ? bundle.story.nodes : []
  if (!storyNodes.length) {
    return c.json({ success: false, error: 'empty_story', message: 'story.json 无节点，无法走查。' }, 400)
  }

  const active = listAiTasks(id, { includeDone: false }).find((t) => t.kind === COMPLETENESS_TASK_KIND)
  if (active) {
    return c.json({ success: false, error: 'completeness_check_running', message: '完整度核实正在进行中', taskId: active.taskId }, 409)
  }

  // 评审模型：body 覆盖 > studio settings review 段 > 环境默认（moonshot/kimi-for-coding）
  const body = await c.req.json().catch(() => ({}))
  const studio = await getEffectiveStudioConfig(ctx.ROOT)
  const reviewConfig = resolveReviewConfig({ studioEffective: studio.effective, body })

  const port = Number(process.env.PORT || 1999)
  const distUrl = `http://127.0.0.1:${port}/demos/${encodeURIComponent(id)}/latest/dist/index.html`
  const task = createAiTask(id, COMPLETENESS_TASK_KIND, { total: storyNodes.length, message: `完整度核实：${storyNodes.length} 个节点` })
  ;(async () => {
    // 评审器任何配置问题都如实记 review_unavailable（unsupported/missing key），不伪造评审
    const reviewer = createNodeVisualReviewer({
      provider: reviewConfig.provider,
      model: reviewConfig.model,
      apiUrl: reviewConfig.apiUrl,
      timeoutMs: Number(body?.reviewTimeoutMs) || undefined
    })
    // 本地视觉评审全程持 vision 独占租约（一次性换入 gemma，避免逐节点装卸抖动）；
    // 走查浏览器阶段也在租约内——全程只有几分钟，且 llm 等待语义与出图互斥一致
    const runCheck = () => runStoryCompletenessCheck({
      projectId: id,
      dir,
      story: bundle.story,
      project: bundle.project,
      distUrl,
      launchBrowser: createPuppeteerBrowserLauncher(),
      reviewer,
      reviewMeta: reviewConfig,
      onProgress: ({ index, total, nodeId }) => {
        updateAiTask(task.taskId, { stage: 'walking', current: index, total, message: `走查节点 ${index}/${total}：${nodeId}` })
      }
    })
    const { report, reportPath } = reviewConfig.provider === 'omlx'
      ? await withResourceLease('vision', `gs:completeness:${id}`, runCheck)
      : await runCheck()
    updateAiTask(task.taskId, {
      stage: report.verdict === 'pass' ? 'done' : 'failed',
      done: true,
      current: report.summary.total,
      message: `完整度核实完成：${report.verdict}（${report.summary.passed}/${report.summary.total} 通过，AI 评审 ${report.aiReviewStatus}）`,
      result: {
        verdict: report.verdict,
        aiReviewStatus: report.aiReviewStatus,
        summary: report.summary,
        failedNodes: report.failedNodes,
        reportFile: path.relative(dir, reportPath)
      }
    })
  })().catch((e) => {
    updateAiTask(task.taskId, { stage: 'error', done: true, error: e && e.message ? String(e.message) : String(e) })
  })

  return c.json({ success: true, taskId: task.taskId, total: storyNodes.length }, 202)
})

app.get('/api/projects/:id/ai/story/completeness-check/latest', async (c) => {
  await ctx.ensureDirs()
  const id = c.req.param('id')
  const dir = ctx.projectDir(id)
  if (!(await ctx.existsDir(dir))) return c.json({ success: false, error: 'not_found' }, 404)
  const latest = await loadLatestCompletenessReport(dir)
  if (!latest) return c.json({ success: false, error: 'no_report', message: '暂无完整度报告，请先执行核实。' }, 404)
  return c.json({ success: true, file: latest.file, report: latest.report })
})
}
