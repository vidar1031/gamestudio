export function getStorageOverview() {
  return fetch('/api/control/maintenance/storage-overview')
}

export function runRetention() {
  return fetch('/api/control/maintenance/retention/run', { method: 'POST' })
}

export function runMaintenanceReset(category: string) {
  return fetch('/api/control/maintenance/reset', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ category, confirm: true })
  })
}

export function getEventHistory(limit = 100) {
  return fetch(`/api/control/events/history?limit=${limit}`)
}

export function getReviewRecords(limit = 100) {
  return fetch(`/api/control/review-records?limit=${limit}`)
}

export function getLogPrefixes() {
  return fetch('/api/control/maintenance/log-prefixes')
}
