// task.status 收件箱（接入协议 §13.5 项目侧义务：按 requestId+version 幂等落库，供台账/UI 消费）。
// 设计：内存 Map<requestId, latest> 为权威最新态；jsonl 追加仅当 version 更大（去重/乱序收敛）；
// 重启后惰性从文件尾部回暖（幂等键在进程重启后仍生效，守护台重放 stale 记录不会重复入账）。
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import path from 'node:path'

const latestByRequestId = new Map() // requestId → record（迄今最大 version）
let warmedFrom = '' // 已回暖的文件路径（路径确定后只暖一次）
let filePathRef = ''

function warmFromDisk() {
  try {
    if (!filePathRef || warmedFrom === filePathRef || !existsSync(filePathRef)) return
    const lines = readFileSync(filePathRef, 'utf8').trim().split('\n').filter(Boolean)
    for (const line of lines.slice(-500)) {
      try {
        const r = JSON.parse(line)
        const rid = String(r?.requestId || '')
        if (!rid) continue
        const prev = latestByRequestId.get(rid)
        if (!prev || Number(r.version) > Number(prev.version)) latestByRequestId.set(rid, r)
      } catch { /* 单行损坏跳过 */ }
    }
    warmedFrom = filePathRef
  } catch { /* 回暖失败不阻断接收 */ }
}

/**
 * 幂等接收一条 task.status。返回 { accepted, reason }：
 * version 大于既有记录才入账（追加 jsonl + 更新最新态）；否则丢弃（重复/乱序旧件）。
 */
export function recordTaskStatus(record, { stateDir }) {
  filePathRef = path.join(stateDir, 'inbound-task-status.jsonl')
  warmFromDisk()
  const rid = String(record?.requestId || '')
  if (!rid) return { accepted: false, reason: 'missing_request_id' }
  const version = Number(record?.version) || 0
  const prev = latestByRequestId.get(rid)
  if (prev && version <= Number(prev.version)) {
    return { accepted: false, reason: `duplicate_or_stale(v${version}<=v${Number(prev.version)})`, latest: prev }
  }
  const next = { ...record, requestId: rid, version }
  latestByRequestId.set(rid, next)
  try {
    mkdirSync(path.dirname(filePathRef), { recursive: true })
    appendFileSync(filePathRef, `${JSON.stringify(next)}\n`, 'utf8')
  } catch (e) {
    console.log(`[task.status] 落盘失败: ${e instanceof Error ? e.message : String(e)}`)
  }
  return { accepted: true, latest: next }
}

/**
 * 供台账/UI 消费的最新态清单。
 * activeWindowMin：只看最近 N 分钟有更新的请求（终态超过窗口默认隐藏，除非 withDone）。
 */
export function listTaskStatusInbox({ limit = 20, activeWindowMin = 30, withDone = false } = {}) {
  const now = Date.now()
  const rows = [...latestByRequestId.values()]
    .filter((r) => {
      if (withDone) return true
      const t = Date.parse(String(r.updatedAt || r.ts || ''))
      if (!Number.isFinite(t)) return true
      const terminal = ['succeeded', 'failed', 'cancelled'].includes(String(r.state))
      return terminal ? now - t < activeWindowMin * 60_000 : true
    })
    .sort((a, b) => String(b.updatedAt || b.ts || '').localeCompare(String(a.updatedAt || a.ts || '')))
  return rows.slice(0, Math.max(1, Number(limit) || 20))
}
