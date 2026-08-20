// 回滚与备份服务（P1-2：rollback + backup，生产级事务模型）。
// 职责：
// - 写入类 action 执行前，备份将被修改的项目文件，并记录相关目录快照；
// - 执行失败或验证失败时，恢复备份、删除新增文件、清理空目录；
// - 记录 rollback 原因、时间戳、恢复清单与删除清单。

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

function snapshotFilePath(actionId) {
  return path.join(getBackupDir(), actionId, '__snapshot__.json')
}

/**
 * 递归收集目录下的文件列表（相对路径）。
 */
function collectFiles(dir, baseDir = dir) {
  const files = []
  if (!fs.existsSync(dir)) return files
  const entries = fs.readdirSync(dir, { withFileTypes: true })
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      files.push(...collectFiles(fullPath, baseDir))
    } else if (entry.isFile()) {
      files.push(path.relative(baseDir, fullPath))
    }
  }
  return files
}

/**
 * 备份 action 可能修改的文件，并记录相关目录快照。
 * @param {string} actionId
 * @param {object} action
 * @param {object} capability
 * @param {object} runtimeDescriptor
 * @returns {{ ok: boolean, backups: Array, snapshotDirs: string[], error: string|null }}
 */
export function backupActionArtifacts(actionId, action, capability, runtimeDescriptor) {
  const projectRoot = String(runtimeDescriptor?.rootDir || GAMESTUDIO_ROOT).trim()
  const artifacts = Array.isArray(capability?.artifacts) ? capability.artifacts : []
  const backups = []
  const snapshotDirs = new Set()

  // 1) 备份已存在的 artifacts 文件
  for (const artifact of artifacts) {
    const relPath = String(artifact).trim()
    if (!relPath) continue
    const absPath = path.resolve(projectRoot, relPath)
    const parentDir = path.dirname(absPath)
    snapshotDirs.add(parentDir)

    if (!fs.existsSync(absPath)) continue
    try {
      const stat = fs.statSync(absPath)
      if (stat.isFile()) {
        const backupPath = backupFilePath(actionId, relPath)
        fs.mkdirSync(path.dirname(backupPath), { recursive: true })
        fs.copyFileSync(absPath, backupPath)
        backups.push({ relPath, backupPath, existed: true })
      } else if (stat.isDirectory()) {
        // 目录不直接备份，但记录快照
        snapshotDirs.add(absPath)
      }
    } catch (error) {
      return { ok: false, backups, snapshotDirs: Array.from(snapshotDirs), error: error instanceof Error ? error.message : String(error) }
    }
  }

  // 2) 记录相关目录的文件快照（用于回滚时识别新增文件）
  const snapshot = {}
  for (const dir of snapshotDirs) {
    const relDir = path.relative(projectRoot, dir)
    try {
      snapshot[relDir] = collectFiles(dir, projectRoot)
    } catch {
      snapshot[relDir] = []
    }
  }

  try {
    const snapFile = snapshotFilePath(actionId)
    fs.mkdirSync(path.dirname(snapFile), { recursive: true })
    fs.writeFileSync(snapFile, JSON.stringify({ projectRoot, snapshot, createdAt: new Date().toISOString() }, null, 2), 'utf8')
  } catch (error) {
    return { ok: false, backups, snapshotDirs: Array.from(snapshotDirs), error: error instanceof Error ? error.message : String(error) }
  }

  return { ok: true, backups, snapshotDirs: Array.from(snapshotDirs), error: null }
}

/**
 * 恢复 action 的备份文件，并删除快照之后新增的文件。
 * @param {string} actionId
 * @param {Array<{ relPath: string, backupPath: string, existed?: boolean }>} backups
 * @param {object} runtimeDescriptor
 * @param {string} reason
 * @returns {{ ok: boolean, restored: string[], deleted: string[], error: string|null }}
 */
export function restoreActionArtifacts(actionId, backups, runtimeDescriptor, reason) {
  const projectRoot = String(runtimeDescriptor?.rootDir || GAMESTUDIO_ROOT).trim()
  const restored = []
  const deleted = []

  // 1) 恢复已备份的文件
  for (const backup of backups) {
    try {
      const absPath = path.resolve(projectRoot, backup.relPath)
      fs.mkdirSync(path.dirname(absPath), { recursive: true })
      fs.copyFileSync(backup.backupPath, absPath)
      restored.push(backup.relPath)
    } catch (error) {
      return { ok: false, restored, deleted, error: error instanceof Error ? error.message : String(error) }
    }
  }

  // 2) 读取快照，删除新增文件
  try {
    const snapFile = snapshotFilePath(actionId)
    if (fs.existsSync(snapFile)) {
      const snapData = JSON.parse(fs.readFileSync(snapFile, 'utf8'))
      const snapshot = snapData?.snapshot || {}
      for (const [relDir, beforeFiles] of Object.entries(snapshot)) {
        const absDir = path.resolve(projectRoot, relDir)
        if (!fs.existsSync(absDir)) continue
        const afterFiles = collectFiles(absDir, projectRoot)
        const beforeSet = new Set(beforeFiles)
        for (const file of afterFiles) {
          if (!beforeSet.has(file)) {
            // 新增文件：删除
            const absFile = path.resolve(projectRoot, file)
            try {
              fs.unlinkSync(absFile)
              deleted.push(file)
            } catch {
              // 删除失败不阻断
            }
          }
        }
        // 清理空目录
        try {
          const remaining = collectFiles(absDir, projectRoot)
          if (!remaining.length) {
            fs.rmdirSync(absDir, { recursive: true })
          }
        } catch {
          // 忽略
        }
      }
    }
  } catch {
    // 快照读取失败不阻断恢复
  }

  appendGovernanceAudit({
    action: 'action_rollback',
    result: 'ok',
    detail: `动作 ${actionId} 回滚：${reason}，恢复文件 ${restored.join(', ') || '无'}，删除新增 ${deleted.join(', ') || '无'}`,
    actor: 'system',
    data: { actionId, reason, restored, deleted }
  })

  return { ok: true, restored, deleted, error: null }
}

/**
 * 执行 action 回滚。
 * @param {string} actionId
 * @param {string} reason
 * @returns {{ ok: boolean, action: object|null, restored: string[], deleted: string[] }}
 */
export function rollbackAction(actionId, reason) {
  const action = getAction(actionId)
  if (!action) {
    return { ok: false, action: null, restored: [], deleted: [] }
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
      restored: [],
      deleted: []
    })
    return { ok: true, action: updated, restored: [], deleted: [] }
  }

  const binding = getProjectBinding()
  const capabilitySummary = getProjectCapabilities(binding)
  const result = restoreActionArtifacts(actionId, backups, capabilitySummary.runtimeDescriptor, reason)
  const updated = transitionAction(actionId, ACTION_STATE.ROLLED_BACK, reason, {
    type: 'rollback',
    reason,
    restored: result.restored,
    deleted: result.deleted
  })

  return { ok: result.ok, action: updated, restored: result.restored, deleted: result.deleted }
}

// 延迟引入避免循环依赖
import { getAction } from './actionExecutionService.js'
import { getProjectBinding } from './projectBindingService.js'
import { getProjectCapabilities } from './projectCapabilityService.js'
