// 导出构建与打包（2026-10-20 index.js 拆分收尾迁出；函数体逐字未改）
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { spawn } from 'node:child_process'
import pluginStoryPixi from '../plugins/storyPixi.js'
import { projectBuildDir, projectDir, TOOL_VERSION } from './storeFs.js'

export function runCommand(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], ...(opts || {}) })
    const out = []
    const err = []
    p.stdout.on('data', (d) => out.push(d))
    p.stderr.on('data', (d) => err.push(d))
    p.on('error', (e) => reject(e))
    p.on('close', (code) => {
      if (code === 0) {
        resolve({ stdout: Buffer.concat(out).toString('utf-8'), stderr: Buffer.concat(err).toString('utf-8') })
        return
      }
      const msg = Buffer.concat(err).toString('utf-8') || `command_failed: ${cmd} exit=${code}`
      reject(new Error(msg))
    })
  })
}

export async function packageDistAsZip(outDir, zipName) {
  const attempts = [
    async () => runCommand('zip', ['-qr', zipName, 'dist'], { cwd: outDir }),
    async () => runCommand('7z', ['a', '-tzip', zipName, 'dist'], { cwd: outDir }),
    async () => runCommand('ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', 'dist', zipName], { cwd: outDir }),
    async () =>
      runCommand(
        'powershell',
        ['-NoProfile', '-Command', `Compress-Archive -Path "dist\\*" -DestinationPath "${zipName}" -Force`],
        { cwd: outDir }
      )
  ]
  let lastErr = null
  for (const fn of attempts) {
    try {
      await fn()
      return
    } catch (e) {
      lastErr = e
    }
  }
  throw lastErr || new Error('zip_failed')
}

export async function sanitizeExportIndexHtml(indexPath) {
  try {
    let html = await readFile(indexPath, 'utf-8')
    let next = html
    // Fix broken regex emitted by older template versions.
    next = next.replaceAll("replace(/^/+/, '')", "replace(/^\\\\/+/, '')")
    // Remove export-only topbar.
    next = next.replace(
      /<div id="topbar">[\s\S]*?<\/div>\s*<div id="stageUI">/m,
      '<div id="stageUI">'
    )
    // Ensure runtime text removes duplicated choice lines (e.g. "选项1: xxx", "Option 1: xxx").
    next = next.replace(
      /const displayText = showEnding[\s\S]*?if \(dialogTextEl\) dialogTextEl\.textContent = hasText \? String\(displayText\) : ''/m,
      `const displayText = showEnding
            ? (String(endingText || '').trim() ? String(endingText) : fallback)
            : (String(text || '').trim() ? String(text) : fallback)
          const filtered = String(displayText)
            .split(/\\r?\\n/)
            .filter((original) => !/^\\s*(?:选项|option)\\s*(?:\\d{1,2}|[A-Z]|[一二三四五六七八九十])\\s*[:：]/i.test(original))
            .map((ln) => ln.trim())
            .filter(Boolean)
            .join('\\n')
          const finalText = filtered || displayText
          const hasText = String(finalText || '').trim().length > 0
          if (dialogTextEl) dialogTextEl.textContent = hasText ? String(finalText) : ''`
    )
    if (next !== html) await writeFile(indexPath, next, 'utf-8')
  } catch (_) {}
}

export async function buildProjectDistForExport(id, dir) {
  const buildId = 'latest'
  const out = projectBuildDir(id, buildId)
  try {
    await rm(out, { recursive: true, force: true })
  } catch (_) {}
  const dist = path.join(out, 'dist')
  await mkdir(dist, { recursive: true })
  const logger = { info: () => {}, warn: () => {}, error: () => {} }
  await pluginStoryPixi.build({ projectId: id, projectDir: dir, outDir: dist, toolVersion: TOOL_VERSION, logger })
  await sanitizeExportIndexHtml(path.join(dist, 'index.html'))
  return { buildId, out, dist }
}
