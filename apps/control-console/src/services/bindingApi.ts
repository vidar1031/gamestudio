// 项目绑定 API：守护台「当前绑定项目」的读取与更新。
// 绑定决定项目事件注册表来源与项目页顶部卡片的展示对象。

export type ProjectBinding = {
  bound: boolean
  id: string
  label: string
  baseUrl: string
  source?: 'file' | 'default'
  updatedAt?: string | null
}

export type ProjectBindingProbe = {
  reachable: boolean
  detail?: string
  checkedAt?: string
}

export function getProjectBinding() {
  return fetch('/api/control/project-binding')
}

export function putProjectBinding(body: { label?: string; baseUrl?: string; bound?: boolean }) {
  return fetch('/api/control/project-binding', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  })
}
