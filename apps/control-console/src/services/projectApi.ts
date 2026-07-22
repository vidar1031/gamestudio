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
