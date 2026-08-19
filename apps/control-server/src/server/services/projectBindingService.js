// 项目绑定配置服务（守护台「当前绑定项目」）。
// 语义：
// - 绑定决定「项目事件」注册表与项目页卡片的来源 GameStudio 实例；
// - 默认绑定本机 GameStudio（label「GameStudio 交互故事」，baseUrl http://127.0.0.1:1999），
//   未写入绑定文件时回落默认；env GAMESTUDIO_SERVER_BASE_URL 可作为默认 baseUrl 覆盖（兼容既有部署）；
// - 绑定持久化到 state/project-binding.json（小 state 文件，原子写：tmp + rename）；
// - 仅接受本机 http(s) 地址（localhost/127.0.0.1/::1），拒绝任意外部地址；
// - 支持 bound=false 的显式解绑状态，供事件页呈现明确空态。
// 文件位置可用 HERMES_PROJECT_BINDING_FILE 覆盖（测试用）。

import fs from 'node:fs'
import path from 'node:path'
import { GAMESTUDIO_ROOT } from '../../config/paths.js'

const DEFAULT_BASE_URL = String(
  process.env.GAMESTUDIO_SERVER_BASE_URL || process.env.SERVER_BASE_URL || 'http://127.0.0.1:1999'
).replace(/\/$/, '')

export const DEFAULT_PROJECT_BINDING = Object.freeze({
  id: 'gamestudio',
  label: 'GameStudio 交互故事'
})

const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1', '[::1]'])

export function getProjectBindingFile() {
  const override = process.env.HERMES_PROJECT_BINDING_FILE
  if (override && String(override).trim()) return String(override)
  return path.join(GAMESTUDIO_ROOT, 'state', 'project-binding.json')
}

// 校验并归一化 baseUrl：仅接受本机 http(s) 地址，去掉路径与结尾斜杠。
export function normalizeBindingBaseUrl(raw) {
  const text = String(raw || '').trim()
  if (!text) return { ok: false, error: 'missing_base_url' }
  let url
  try {
    url = new URL(text)
  } catch {
    return { ok: false, error: 'invalid_base_url' }
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, error: 'invalid_base_url_protocol' }
  }
  if (!LOCAL_HOSTNAMES.has(String(url.hostname || '').toLowerCase())) {
    return { ok: false, error: 'base_url_not_local' }
  }
  return { ok: true, baseUrl: url.origin }
}

// 读取当前绑定。文件缺失/损坏/非法时回落默认绑定（source 标记来源）。
export function getProjectBinding() {
  const file = getProjectBindingFile()
  try {
    if (fs.existsSync(file)) {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
      if (parsed && parsed.bound === false) {
        return { bound: false, id: '', label: '', baseUrl: '', source: 'file', updatedAt: parsed.updatedAt || null }
      }
      const normalized = normalizeBindingBaseUrl(parsed?.baseUrl)
      if (normalized.ok) {
        return {
          bound: true,
          id: String(parsed?.id || DEFAULT_PROJECT_BINDING.id),
          label: String(parsed?.label || DEFAULT_PROJECT_BINDING.label),
          baseUrl: normalized.baseUrl,
          source: 'file',
          updatedAt: parsed?.updatedAt || null
        }
      }
    }
  } catch {
    // 读取失败按默认绑定回落，不阻断只读查询
  }
  return {
    bound: true,
    id: DEFAULT_PROJECT_BINDING.id,
    label: DEFAULT_PROJECT_BINDING.label,
    baseUrl: DEFAULT_BASE_URL,
    source: 'default',
    updatedAt: null
  }
}

function atomicWriteJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf8')
  fs.renameSync(tmp, file)
}

// 写入绑定。input.bound === false 表示解绑；否则校验 baseUrl 后写入。
// 非法输入抛出带 code 的 Error，由路由层归一为 400。
export function setProjectBinding(input = {}) {
  const file = getProjectBindingFile()
  const updatedAt = new Date().toISOString()
  if (input.bound === false) {
    atomicWriteJson(file, { bound: false, updatedAt })
    return { bound: false, id: '', label: '', baseUrl: '', source: 'file', updatedAt }
  }
  const normalized = normalizeBindingBaseUrl(input.baseUrl)
  if (!normalized.ok) {
    const error = new Error(normalized.error)
    error.code = normalized.error
    throw error
  }
  const label = String(input.label || '').trim() || DEFAULT_PROJECT_BINDING.label
  const id = String(input.id || '').trim() || DEFAULT_PROJECT_BINDING.id
  const record = { bound: true, id, label, baseUrl: normalized.baseUrl, updatedAt }
  atomicWriteJson(file, record)
  return { ...record, source: 'file' }
}

// 活性探测：请求绑定项目的 /api/health，短超时，失败不抛出。
export async function probeProjectBinding(baseUrl, timeoutMs = 3000) {
  const checkedAt = new Date().toISOString()
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), Math.max(500, Number(timeoutMs) || 3000))
  try {
    const res = await fetch(`${String(baseUrl || '').replace(/\/$/, '')}/api/health`, { signal: controller.signal })
    if (res.ok) return { reachable: true, detail: '服务在线', checkedAt }
    return { reachable: false, detail: `服务返回 HTTP ${res.status}`, checkedAt }
  } catch (error) {
    return { reachable: false, detail: error instanceof Error ? error.message : String(error), checkedAt }
  } finally {
    clearTimeout(timeout)
  }
}
