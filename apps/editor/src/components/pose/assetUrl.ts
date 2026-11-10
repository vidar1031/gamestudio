// 项目资产/运行时图片 URL 解析（2026-11-01 从 StoryboardLockWorkspace 抽出为公共模块）：
// 锁定向导 / 蓝图预演占位图 / 姿态组件共用同一套解析，避免各写一份。
import { resolveUrl } from '../../api'

export function toProjectAssetUrl(projectId: string, rawUri: string) {
  const uri = String(rawUri || '').trim()
  if (!uri || !projectId) return ''
  if (/^https?:\/\//i.test(uri) || uri.startsWith('data:')) return uri
  return resolveUrl(`/project-assets/${encodeURIComponent(String(projectId))}/${uri.replace(/^\/+/, '')}`)
}

export function toRuntimeUrl(rawUrl: string) {
  const value = String(rawUrl || '').trim()
  if (!value) return ''
  if (/^https?:\/\//i.test(value) || value.startsWith('data:')) return value
  return resolveUrl(value.startsWith('/') ? value : `/${value}`)
}
