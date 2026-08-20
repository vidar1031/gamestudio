// 项目绑定 API：守护台「当前绑定项目」的读取与更新。
// 绑定决定项目事件注册表来源与项目页顶部卡片的展示对象。

export type ProjectCapability = {
  id: string
  type: 'read' | 'write'
  label: string
  description?: string
  requiresReview: boolean
  reviewPolicy?: string
  inputSchema?: Record<string, unknown> | null
  outputSchema?: Record<string, unknown> | null
  artifacts?: string[]
  timeoutMs?: number
  event?: {
    code?: string
    eventId?: string
    kind?: string
    aliases?: string[]
  }
}

export type ProjectRuntimeDescriptor = {
  projectId?: string
  kind?: string
  displayName?: string
  rootDir?: string
  boundaries?: {
    allowedRoots?: string[]
    disallowOutsideWorkspace?: boolean
  }
  events?: string[]
  workflows?: string[]
  categories?: Array<{ id?: string; title?: string }>
  sourcePath?: string | null
}

export type ProjectBinding = {
  bound: boolean
  id: string
  label: string
  baseUrl: string
  repoPath?: string
  source?: 'file' | 'default'
  updatedAt?: string | null
}

export type ProjectBindingProbe = {
  reachable: boolean
  detail?: string
  checkedAt?: string
}

export type ProjectBindingResponse = {
  ok: boolean
  binding: ProjectBinding | null
  probe: ProjectBindingProbe | null
  capabilities?: ProjectCapability[]
  runtimeDescriptor?: ProjectRuntimeDescriptor | null
  capabilitySource?: string
  capabilityError?: string | null
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
