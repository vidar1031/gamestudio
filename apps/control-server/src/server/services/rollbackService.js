// 回滚与备份服务（P1-2：rollback + backup）。
// 职责：
// - 写入类 action 执行前，备份将被修改的项目文件；
// - 执行失败或验证失败时，恢复备份并标记 action 为 rolled_back；
// - 记录 rollback 原因、时间戳与恢复的文件清单。

import fs from 'node:fs'
import path from 'node:path'
import { GAMESTUDIO_ROOT } from '../../config/paths.js'
import { transitionAction, ACTION_STATE } from './actionExecutionService.js'
import { appendGovernanceAudit } from '../reasoning/governanceAudit.js'

const DEFAULT_BACKUP_DIR = path.join(GAMESTUDIO_ROOT, 'state', 'action-backups')

function getBackupDir() {
  const override = process.env.HERMES_ACTION_BACKUP_DIR
  if (override && String(override).trim()) return String(override)
  return DEFAULT_BACKUP_DIR
}

function backupFilePath(actionId, relPath) {
  const safeName = String(relPath || '').replace(/[^a-zA-Z0-9._-]/g, '_')
  return path.join(getBackupDir(), actionId, safeName)
}

/**
 * 备份 action 可能修改的文件。
 * @param {string} actionId
 * @param {object} action
 * @param {object} capability
 * @param {object} runtimeDescriptor
 * @returns {{ ok: boolean, backups: Array<{ relPath: string, backupPath: string }>, error: string|null }}
 */
export function backupActionArtifacts(actionId, action, capability, runtimeDescriptor) {
  const projectRoot = String(runtimeDescriptor?.rootDir || GAMESTUDIO_ROOT).trim()
  const artifacts = Array.isArray(capability?.artifacts) ? capability.artifacts : []
  const backups = []

  for (const artifact of artifacts) {
    // 只备份文件，不备份目录
    if (String(artifact).endsWith('/')) continue
    const relPath = String(artifact).trim()
    const absPath = path.resolve(projectRoot, relPath)
    if (!fs.existsSync(absPath)) continue
    try {
      const stat = fs.statSync(absPath)
      if (!stat.isFile()) continue
      const backupPath = backupFilePath(actionId, relPath)
      fs.mkdirSync(path.dirname(backupPath), { recursive: true })
      fs.copyFileSync(absPath, backupPath)
      backups.push({ relPath, backupPath })
    } catch (error) {
      return { ok: false, backups, error: error instanceof Error ? error.message : String(error) }
    }
  }

  return { ok: true, backups, error: null }
}

/**
 * 恢复 action 的备份文件。
 * @param {string} actionId
 * @param {Array<{ relPath: string, backupPath: string }>} backups
 * @param {object} runtimeDescriptor
 * @param {string} reason
 * @returns {{ ok: boolean, restored: string[], error: string|null }}
 */
export function restoreActionArtifacts(actionId, backups, runtimeDescriptor, reason) {
  const projectRoot = String(runtimeDescriptor?.rootDir || GAMESTUDIO_ROOT).trim()
  const restored = []

  for (const backup of backups) {
    try {
      const absPath = path.resolve(projectRoot, backup.relPath)
      fs.mkdirSync(path.dirname(absPath), { recursive: true })
      fs.copyFileSync(backup.backupPath, absPath)
      restored.push(backup.relPath)
    } catch (error) {
      return { ok: false, restored, error: error instanceof Error ? error.message : String(error) }
    }
  }

  appendGovernanceAudit({
    action: 'action_rollback',
    result: 'ok',
    detail: `动作 ${actionId} 回滚：${reason}，恢复文件 ${restored.join(', ') || '无'}`,
    actor: 'system',
    data: { actionId, reason, restored }
  })

  return { ok: true, restored, error: null }
}

/**
 * 执行 action 回滚。
 * @param {string} actionId
 * @param {string} reason
 * @returns {{ ok: boolean, action: object|null, restored: string[] }}
 */
export function rollbackAction(actionId, reason) {
  const action = getAction(actionId)
  if (!action) {
    return { ok: false, action: null, restored: [] }
  }

  // 从 evidence 中查找备份记录
  const backupEvidence = Array.isArray(action.evidence)
    ? action.evidence.find((item) => item.type === 'artifact_backup')
    : null
  const backups = Array.isArray(backupEvidence?.backups) ? backupEvidence.backups : []

  if (!backups.length) {
    // 无备份可回滚，直接标记 rolled_back
    const updated = transitionAction(actionId, ACTION_STATE.ROLLED_BACK, reason, {
      type: 'rollback',
      reason,
      restored: []
    })
    return { ok: true, action: updated, restored: [] }
  }

  const binding = getProjectBinding()
  const capabilitySummary = getProjectCapabilities(binding)
  const result = restoreActionArtifacts(actionId, backups, capabilitySummary.runtimeDescriptor, reason)
  const updated = transitionAction(actionId, ACTION_STATE.ROLLED_BACK, reason, {
    type: 'rollback',
    reason,
    restored: result.restored
  })

  return { ok: result.ok, action: updated, restored: result.restored }
}

// 延迟引入避免循环依赖
import { getAction } from './actionExecutionService.js'
import { getProjectBinding } from './projectBindingService.js'
import { getProjectCapabilities } from './projectCapabilityService.js'
