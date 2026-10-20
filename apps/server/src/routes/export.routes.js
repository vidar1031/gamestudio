// ---------------------------------------------------------------------------
// registerExportRoutes（模块化拆分机械迁出，字义未改；协议层+族内编排，域算法引自 ../ai/*，index 本地辅助经 ctx 注入）
// ---------------------------------------------------------------------------
import path from 'node:path'
import { spawn } from 'node:child_process'
import { mkdir, readFile, readdir, rename, stat, writeFile, rm, copyFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import crypto from 'node:crypto'
import { storyInputGate } from '../middleware/storyInputGate.js'


export function registerExportRoutes(app, ctx) {
app.post('/api/projects/:id/export', storyInputGate('story.export.project', (c) => ({ projectId: c.req.param('id') })), async (c) => {
  await ctx.ensureDirs()
  const id = c.req.param('id')
  const dir = ctx.projectDir(id)
  if (!(await ctx.existsDir(dir))) return c.json({ success: false, error: 'not_found' }, 404)

  const { buildId } = await ctx.buildProjectDistForExport(id, dir)

  return c.json({
    success: true,
    buildId,
    distUrl: `/demos/${encodeURIComponent(id)}/${encodeURIComponent(buildId)}/dist/index.html`
  })
})

app.post('/api/projects/:id/export/publish', async (c) => {
  await ctx.ensureDirs()
  const id = c.req.param('id')
  const dir = ctx.projectDir(id)
  if (!(await ctx.existsDir(dir))) return c.json({ success: false, error: 'not_found' }, 404)

  const { buildId, out } = await ctx.buildProjectDistForExport(id, dir)
  const zipName = `h5_story_${String(id)}_${String(buildId)}.zip`
  const zipAbs = path.join(out, zipName)
  try {
    await ctx.packageDistAsZip(out, zipName)
  } catch (e) {
    return c.json({
      success: false,
      error: 'zip_failed',
      message: e && e.message ? String(e.message) : String(e),
      buildId,
      distUrl: `/demos/${encodeURIComponent(id)}/${encodeURIComponent(buildId)}/dist/index.html`
    }, 500)
  }
  return c.json({
    success: true,
    buildId,
    distUrl: `/demos/${encodeURIComponent(id)}/${encodeURIComponent(buildId)}/dist/index.html`,
    packageUrl: `/demos/${encodeURIComponent(id)}/${encodeURIComponent(buildId)}/${encodeURIComponent(zipName)}`,
    packageName: zipName,
    packageBytes: Number((await stat(zipAbs)).size || 0)
  })
})

app.get('/api/projects/:id/exports', async (c) => {
  await ctx.ensureDirs()
  const id = c.req.param('id')
  const dir = ctx.projectBuildsDir(id)
  const items = []
  const buildId = 'latest'
  const buildDir = path.join(dir, buildId)
  if (await ctx.existsDir(buildDir)) {
    const distIndex = path.join(buildDir, 'dist', 'index.html')
    const hasDist = await ctx.existsFile(distIndex)
    const files = await readdir(buildDir).catch(() => [])
    const zip = files.find((f) => /^h5_story_.*\.zip$/i.test(String(f || '')))
    const st = await stat(buildDir).catch(() => null)
    items.push({
      buildId,
      createdAt: st && st.mtime ? st.mtime.toISOString() : '',
      distUrl: hasDist ? `/demos/${encodeURIComponent(id)}/${encodeURIComponent(buildId)}/dist/index.html` : '',
      packageUrl: zip ? `/demos/${encodeURIComponent(id)}/${encodeURIComponent(buildId)}/${encodeURIComponent(zip)}` : '',
      packageName: zip || ''
    })
  }
  return c.json({ success: true, items })
})

app.delete('/api/projects/:id/exports/:buildId', async (c) => {
  await ctx.ensureDirs()
  const id = c.req.param('id')
  const buildId = String(c.req.param('buildId') || '').trim()
  if (!buildId) return c.json({ success: false, error: 'missing_buildId' }, 400)
  const dir = ctx.projectBuildDir(id, buildId)
  if (!(await ctx.existsDir(dir))) return c.json({ success: true, removed: false })
  try {
    await rm(dir, { recursive: true, force: true })
    return c.json({ success: true, removed: true })
  } catch (e) {
    return c.json({ success: false, error: 'delete_failed', message: e && e.message ? String(e.message) : String(e) }, 500)
  }
})

// 静态服务 demo 产物（P0：仅 demos）

// 静态服务 demo_library（手动拷贝的 demo 与素材）
}
