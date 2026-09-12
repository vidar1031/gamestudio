export function listProjects() {
  return fetch('/api/control/projects')
}

export function createProject(title: string) {
  return fetch('/api/control/projects', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title })
  })
}

export function getProject(projectId: string) {
  return fetch(`/api/control/projects/${encodeURIComponent(projectId)}`)
}

export function deleteProject(projectId: string) {
  return fetch(`/api/control/projects/${encodeURIComponent(projectId)}`, {
    method: 'DELETE'
  })
}

// 出图总账：经 control-server 代理读取 GameStudio 的只读出图聚合
export function getAiCoverage(projectId: string) {
  return fetch(`/api/control/gamestudio/projects/${encodeURIComponent(projectId)}/ai/coverage`)
}
