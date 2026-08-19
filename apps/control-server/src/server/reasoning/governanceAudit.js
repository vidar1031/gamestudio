/**
 * HERMES-H01：治理操作审计。
 *
 * 守护台治理动作（取消/恢复/重试/审核）的统一审计轨迹：
 * - 每个受控端点在得出确定结果（成功 ok / 阻断 blocked）后追加一条 JSONL，
 *   记录 action、sessionId、taskId、结果与原因，供守护台「操作审计」视图追溯；
 * - 审计写入是 best-effort：落盘失败不影响受控动作本身的结果（动作语义已由
 *   session 状态机与事件留证），避免审计故障放大为生产故障；
 * - 与既有留证的分工：session events 记录任务内部过程，review-records 记录审核
 *   决定细节，本文件记录「谁在何时对哪个任务做了什么治理动作、结果如何」的
 *   跨任务索引，证据可按 sessionId/taskId 互查。
 *
 * 文件位置：state/governance-audit.jsonl（HERMES_GOVERNANCE_AUDIT_FILE 可覆盖，测试用）。
 */

import fs from 'node:fs'
import path from 'node:path'
import { GAMESTUDIO_ROOT } from '../../config/paths.js'

export function getGovernanceAuditFile() {
  const override = process.env.HERMES_GOVERNANCE_AUDIT_FILE
  if (override && String(override).trim()) return String(override)
  return path.join(GAMESTUDIO_ROOT, 'state', 'governance-audit.jsonl')
}

/**
 * 追加一条治理审计记录。
 * @param {object} record { action, sessionId, taskId?, jobId?, projectId?, result: 'ok'|'blocked', detail?, decision?, actor? }
 *   jobId 为 HERMES-H02 cron 定时任务编号（非 cron 动作为 null）。
 *   projectId 为 AUTO-F01 补充的项目归属（无项目归属的动作为 null），保证审计可按项目对照。
 *   actor 为 AUTO-F02 补充的操作者身份（proposal 审核/激活/回滚等治理动作必填）。
 * @returns 写入的记录；落盘失败返回 null（不抛出）。
 */
export function appendGovernanceAudit(record, { nowFn = () => new Date().toISOString() } = {}) {
  const entry = {
    ts: nowFn(),
    action: String(record?.action || 'unknown'),
    sessionId: record?.sessionId || null,
    taskId: record?.taskId || null,
    projectId: record?.projectId ? String(record.projectId) : null,
    result: record?.result === 'blocked' ? 'blocked' : 'ok',
    detail: record?.detail ? String(record.detail).slice(0, 500) : null,
    ...(record?.jobId ? { jobId: String(record.jobId) } : {}),
    ...(record?.decision ? { decision: String(record.decision) } : {}),
    ...(record?.actor ? { actor: String(record.actor).slice(0, 120) } : {})
  }
  try {
    const file = getGovernanceAuditFile()
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.appendFileSync(file, `${JSON.stringify(entry)}\n`, 'utf8')
    return entry
  } catch {
    // 审计落盘失败不阻断受控动作（动作结果已由状态机/事件留证）
    return null
  }
}

/**
 * 读取最近 limit 条审计记录（新的在前）；损坏行跳过并计数，不猜测内容。
 */
export function readGovernanceAudit(limit = 100) {
  const max = Math.max(1, Math.min(500, Number(limit) || 100))
  const file = getGovernanceAuditFile()
  const records = []
  let skipped = 0
  try {
    if (fs.existsSync(file)) {
      const lines = fs.readFileSync(file, 'utf8').split('\n')
      for (let index = lines.length - 1; index >= 0 && records.length < max; index -= 1) {
        const line = lines[index].trim()
        if (!line) continue
        try {
          records.push(JSON.parse(line))
        } catch {
          skipped += 1
        }
      }
    }
  } catch {
    // 读取失败按空处理，由调用方以空列表呈现
  }
  return { records, skipped }
}
