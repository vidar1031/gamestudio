// 存储与路径真相源（2026-10-20 index.js 拆分收尾迁出；函数体逐字未改，仅按新文件深度修正相对层级）。
// 注意：本文件在 src/studio/（比原 index.js 深一层），所有 ../ 相对解析多上一档。
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { normalizeProjectDoc } from './projectState.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
export const PROJECT_ROOT = path.resolve(__dirname, '../../../..')
export const EDITOR_DIST = path.resolve(__dirname, '..', '..', '..', 'editor', 'dist')
export const DEFAULT_ROOT = path.resolve(__dirname, '../../../../storage')
export const ENV_ROOT = String(process.env.STUDIO_STORAGE_ROOT || '').trim()
export const ROOT = ENV_ROOT
  ? (path.isAbsolute(ENV_ROOT) ? ENV_ROOT : path.resolve(process.cwd(), ENV_ROOT))
  : DEFAULT_ROOT
export const PROJECTS_DIR = path.join(ROOT, 'projects')
export const DEMO_LIBRARY_DIR = path.join(ROOT, 'demo_library')
export const TOOL_VERSION = '0.1.0'

export async function ensureDirs() {
  await mkdir(PROJECTS_DIR, { recursive: true })
  await mkdir(DEMO_LIBRARY_DIR, { recursive: true })
}

export function projectDir(id) {
  return path.join(PROJECTS_DIR, String(id))
}

export function projectBuildsDir(id) {
  return path.join(projectDir(id), 'builds')
}

export function projectBuildDir(projectId, buildId) {
  return path.join(projectBuildsDir(projectId), String(buildId))
}

export function projectStoryAssetsDir(id) {
  return path.join(projectDir(id), 'story-assets')
}

export function projectStoryAssetsPlanPath(id) {
  return path.join(projectStoryAssetsDir(id), 'plan.json')
}

export function demoLibDir(demoId) {
  return path.join(DEMO_LIBRARY_DIR, String(demoId))
}

export async function readJson(p) {
  return JSON.parse(await readFile(p, 'utf-8'))
}

export async function probeHttpOk(url, timeoutMs = 3000) {
  try {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), Math.max(500, Number(timeoutMs || 3000)))
    const res = await fetch(url, { signal: controller.signal })
    clearTimeout(timeout)
    return res.ok
  } catch (_) {
    return false
  }
}

export async function writeJson(p, obj) {
  await mkdir(path.dirname(p), { recursive: true })
  // 2026-08-29 修复：改为临时文件 + 原子重命名。原先直接覆写目标路径，
  // 并发写入（自动保存/批量任务/外部修补）会把两个版本拼接成坏档（实测 project.json 损毁、批量中断）。
  const tmp = `${p}.tmp-${process.pid}-${Date.now()}`
  await writeFile(tmp, JSON.stringify(obj, null, 2), 'utf-8')
  await rename(tmp, p)
}

export async function readProjectBundle(id) {
  const dir = projectDir(id)
  const rawProject = await readJson(path.join(dir, 'project.json'))
  const story = await readJson(path.join(dir, 'story.json'))
  return {
    dir,
    rawProject,
    project: normalizeProjectDoc(rawProject),
    story
  }
}

export function parseJsonObjectText(raw) {
  const text = String(raw || '').trim()
  if (!text) return null
  try {
    const parsed = JSON.parse(text)
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch (_) {
    return null
  }
}

export function readStoryBibleFromProjectDoc(project) {
  const state = project && project.state && typeof project.state === 'object' ? project.state : {}
  const aiBg = state && state.aiBackground && typeof state.aiBackground === 'object' ? state.aiBackground : {}
  if (aiBg.storyBible && typeof aiBg.storyBible === 'object') return aiBg.storyBible
  return parseJsonObjectText(aiBg.storyBibleJson)
}

export async function existsDir(p) {
  try {
    const st = await stat(p)
    return st.isDirectory()
  } catch (_) {
    return false
  }
}

export async function existsFile(p) {
  try {
    const st = await stat(p)
    return st.isFile()
  } catch (_) {
    return false
  }
}

export function normalizeLocalPath(raw) {
  let s = String(raw || '').trim()
  if (!s) return ''
  // Strip surrounding quotes copied from shell/GUI.
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    s = s.slice(1, -1).trim()
  }
  // Drop trailing slashes to reduce join surprises.
  s = s.replace(/[\\/]+$/, '')
  return s
}

export function nowIso() {
  try { return new Date().toISOString() } catch (_) { return String(Date.now()) }
}
