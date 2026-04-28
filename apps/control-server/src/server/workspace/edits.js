// Workspace edit / script / text-search helpers.
// Extracted from controlServerCore.js without behavior changes.

import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

import { GAMESTUDIO_ROOT } from '../../config/paths.js'
import { resolveWorkspacePathFromInput } from './inspectors.js'

export function buildReasoningWriteFallbackContent(step, currentContent) {
  if (step.action === 'update_task_queue') {
    const nextEntry = String(step.params?.content || '').trim()
    const replaceAll = Boolean(step.params?.replaceAll)
    if (replaceAll) return nextEntry
    const existing = String(currentContent || '')
    if (!existing.trim()) return `${nextEntry}\n`
    return `${existing}${existing.endsWith('\n') ? '' : '\n'}${nextEntry}\n`
  }
  return String(step.params?.content || '')
}

export function isWorkspaceEditablePath(resolvedPath) {
  if (!resolvedPath.startsWith(GAMESTUDIO_ROOT)) return false
  const blockedSegments = [
    `${path.sep}.git${path.sep}`,
    `${path.sep}node_modules${path.sep}`,
    `${path.sep}dist${path.sep}`,
    `${path.sep}.run${path.sep}`,
  ]
  return !blockedSegments.some((segment) => resolvedPath.includes(segment))
}

export function isWorkspaceRunnableScriptPath(resolvedPath) {
  if (!resolvedPath.startsWith(GAMESTUDIO_ROOT)) return false
  if (!fs.existsSync(resolvedPath)) return false
  const stat = fs.statSync(resolvedPath)
  if (!stat.isFile()) return false
  const ext = path.extname(resolvedPath).toLowerCase()
  const allowedExtensions = new Set(['.sh', '.js', '.mjs', '.cjs'])
  if (!allowedExtensions.has(ext)) return false
  const relativePath = path.relative(GAMESTUDIO_ROOT, resolvedPath)
  if (!relativePath || relativePath.startsWith('..')) return false
  return relativePath.startsWith(`scripts${path.sep}`) || !relativePath.includes(path.sep)
}

export function runWorkspaceTextSearch(query, options = {}) {
  const normalizedQuery = String(query || '').trim()
  if (!normalizedQuery) throw new Error('search_workspace_text_missing_query')
  const startDir = resolveWorkspacePathFromInput(options.startDir || GAMESTUDIO_ROOT)
  if (!startDir.startsWith(GAMESTUDIO_ROOT)) throw new Error('search_workspace_text_path_outside_workspace')
  const maxResults = Math.min(100, Math.max(1, Number(options.maxResults || 20)))
  const rgLookup = spawnSync('which', ['rg'], { encoding: 'utf8' })
  if (rgLookup.status === 0) {
    const result = spawnSync('rg', ['-n', '--no-heading', '--color', 'never', '-F', normalizedQuery, startDir, '-g', '!.git', '-g', '!node_modules', '-g', '!dist', '-g', '!.run'], {
      cwd: GAMESTUDIO_ROOT,
      encoding: 'utf8'
    })
    if (result.status !== 0 && result.status !== 1) {
      throw new Error(`search_workspace_text_failed: ${(result.stderr || result.stdout || '').trim() || 'rg_failed'}`)
    }
    const matches = String(result.stdout || '').split('\n').filter(Boolean).slice(0, maxResults).map((line) => {
      const [filePath, lineNumber, ...rest] = line.split(':')
      return {
        filePath,
        lineNumber: Number(lineNumber || 0),
        preview: rest.join(':').trim()
      }
    })
    return { query: normalizedQuery, startDir, count: matches.length, matches }
  }

  const matches = []
  const visit = (currentPath) => {
    if (matches.length >= maxResults) return
    const stat = fs.statSync(currentPath)
    if (stat.isDirectory()) {
      const base = path.basename(currentPath)
      if (base === '.git' || base === 'node_modules' || base === 'dist' || base === '.run') return
      for (const entry of fs.readdirSync(currentPath)) {
        visit(path.join(currentPath, entry))
        if (matches.length >= maxResults) return
      }
      return
    }
    const raw = fs.readFileSync(currentPath, 'utf8')
    const lines = raw.split('\n')
    for (let index = 0; index < lines.length; index++) {
      if (lines[index].includes(normalizedQuery)) {
        matches.push({ filePath: currentPath, lineNumber: index + 1, preview: lines[index].trim() })
        if (matches.length >= maxResults) return
      }
    }
  }
  visit(startDir)
  return { query: normalizedQuery, startDir, count: matches.length, matches }
}

export function buildReasoningFileRewriteMessages(step, userPrompt, filePath, currentContent, desiredContent) {
  return [
    {
      role: 'system',
      content: [
        step.action === 'edit_workspace_file'
          ? 'You rewrite GameStudio workspace files for the observable reasoning pipeline.'
          : 'You rewrite GameStudio workspace memory files for the observable reasoning pipeline.',
        'Return one strict JSON object only.',
        'Preserve valid file syntax or markdown structure and avoid unrelated edits.',
        'Schema: {"updatedContent": string, "summary": string}'
      ].join('\n')
    },
    {
      role: 'user',
      content: [
        `用户原始问题：${userPrompt}`,
        `步骤标题：${step.title}`,
        `目标文件：${filePath}`,
        '',
        '当前文件内容：',
        String(currentContent || ''),
        '',
        '目标内容或变更意图：',
        String(desiredContent || '')
      ].join('\n')
    }
  ]
}
