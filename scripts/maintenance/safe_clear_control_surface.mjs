#!/usr/bin/env node

const args = new Map(process.argv.slice(2).map((arg) => {
  const [key, ...rest] = arg.split('=')
  return [key, rest.length > 0 ? rest.join('=') : 'true']
}))

const baseUrl = String(args.get('--base-url') || 'http://127.0.0.1:2099').replace(/\/$/, '')
const agentId = String(args.get('--agent') || 'hermes-manager')
const apply = args.has('--apply')
const targets = String(args.get('--target') || args.get('--targets') || 'logs,chat-history')
  .split(',')
  .map((item) => item.trim())
  .filter(Boolean)

if (targets.length === 0) {
  console.error('No targets provided. Example: --target=logs,chat-history')
  process.exit(1)
}

async function readJson(response) {
  const payload = await response.json().catch(() => null)
  if (!response.ok || !payload?.ok) {
    throw new Error(payload?.error || `http_${response.status}`)
  }
  return payload
}

const recordsPayload = await readJson(await fetch(`${baseUrl}/api/control/agents/${agentId}/memory-records`))
const selectedTargets = (recordsPayload.clearTargets || []).filter((item) => targets.includes(item.value))
const missingTargets = targets.filter((target) => !selectedTargets.some((item) => item.value === target))

if (missingTargets.length > 0) {
  console.error(`Unknown clear target(s): ${missingTargets.join(', ')}`)
  process.exit(1)
}

console.log(JSON.stringify({
  mode: apply ? 'apply' : 'dry-run',
  baseUrl,
  agentId,
  targets: selectedTargets.map((item) => ({
    value: item.value,
    label: item.label,
    impactLabel: item.impactLabel,
    sizeLabel: item.sizeLabel,
    impactSummary: item.impactSummary
  }))
}, null, 2))

if (!apply) {
  console.log('Dry run only. Re-run with --apply to archive and clear selected targets.')
  process.exit(0)
}

const clearPayload = await readJson(await fetch(`${baseUrl}/api/control/agents/${agentId}/memory-records/clear`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ targets, reason: 'safe-clear-control-surface-script' })
}))

console.log(JSON.stringify({
  ok: true,
  cleared: clearPayload.cleared,
  archive: clearPayload.archive,
  message: clearPayload.message
}, null, 2))