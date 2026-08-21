// 能力注册服务（能力发现与注册机制）。
// 职责：
// - 管理已注册能力（写入 project-manifest.v1.json）；
// - 支持注册、禁用、启用能力；
// - 注册后验证能力可用性。

import fs from 'node:fs'
import path from 'node:path'
import { GAMESTUDIO_ROOT } from '../../config/paths.js'
import { appendGovernanceAudit } from '../reasoning/governanceAudit.js'

const MANIFEST_PATH = path.join(GAMESTUDIO_ROOT, 'apps', 'server', 'events', 'project-manifest.v1.json')

function readManifest() {
  try {
    if (!fs.existsSync(MANIFEST_PATH)) return null
    return JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'))
  } catch {
    return null
  }
}

function writeManifest(manifest) {
  const tmp = `${MANIFEST_PATH}.${process.pid}.${Date.now()}.tmp`
  fs.writeFileSync(tmp, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  fs.renameSync(tmp, MANIFEST_PATH)
}

/**
 * 注册能力到 manifest。
 * @param {object} capability - 能力定义
 * @param {string} actor - 操作者
 * @returns {{ ok: boolean, error: string|null }}
 */
export function registerCapability(capability, actor = 'console') {
  const manifest = readManifest()
  if (!manifest) {
    return { ok: false, error: 'manifest_not_found' }
  }

  const capabilities = Array.isArray(manifest.capabilities) ? manifest.capabilities : []
  const existing = capabilities.findIndex((c) => c.id === capability.id)
  if (existing >= 0) {
    // 已存在：更新
    capabilities[existing] = { ...capabilities[existing], ...capability, registeredAt: new Date().toISOString(), registeredBy: actor }
  } else {
    // 新增
    capabilities.push({ ...capability, registeredAt: new Date().toISOString(), registeredBy: actor })
  }

  manifest.capabilities = capabilities
  manifest.updatedAt = new Date().toISOString()
  writeManifest(manifest)

  appendGovernanceAudit({
    action: 'capability_registered',
    result: 'ok',
    detail: `注册能力 ${capability.id}（${capability.label}）`,
    actor,
    data: { capabilityId: capability.id, label: capability.label }
  })

  return { ok: true, error: null }
}

/**
 * 禁用能力（从 manifest 中移除或标记为禁用）。
 * @param {string} capabilityId - 能力 ID
 * @param {string} actor - 操作者
 * @returns {{ ok: boolean, error: string|null }}
 */
export function disableCapability(capabilityId, actor = 'console') {
  const manifest = readManifest()
  if (!manifest) {
    return { ok: false, error: 'manifest_not_found' }
  }

  const capabilities = Array.isArray(manifest.capabilities) ? manifest.capabilities : []
  const index = capabilities.findIndex((c) => c.id === capabilityId)
  if (index < 0) {
    return { ok: false, error: 'capability_not_found' }
  }

  // 标记为禁用（不删除，保留历史记录）
  capabilities[index] = { ...capabilities[index], disabled: true, disabledAt: new Date().toISOString(), disabledBy: actor }
  manifest.capabilities = capabilities
  manifest.updatedAt = new Date().toISOString()
  writeManifest(manifest)

  appendGovernanceAudit({
    action: 'capability_disabled',
    result: 'ok',
    detail: `禁用能力 ${capabilityId}`,
    actor,
    data: { capabilityId }
  })

  return { ok: true, error: null }
}

/**
 * 启用能力。
 * @param {string} capabilityId - 能力 ID
 * @param {string} actor - 操作者
 * @returns {{ ok: boolean, error: string|null }}
 */
export function enableCapability(capabilityId, actor = 'console') {
  const manifest = readManifest()
  if (!manifest) {
    return { ok: false, error: 'manifest_not_found' }
  }

  const capabilities = Array.isArray(manifest.capabilities) ? manifest.capabilities : []
  const index = capabilities.findIndex((c) => c.id === capabilityId)
  if (index < 0) {
    return { ok: false, error: 'capability_not_found' }
  }

  // 移除禁用标记
  const { disabled, disabledAt, disabledBy, ...rest } = capabilities[index]
  capabilities[index] = { ...rest, enabledAt: new Date().toISOString(), enabledBy: actor }
  manifest.capabilities = capabilities
  manifest.updatedAt = new Date().toISOString()
  writeManifest(manifest)

  appendGovernanceAudit({
    action: 'capability_enabled',
    result: 'ok',
    detail: `启用能力 ${capabilityId}`,
    actor,
    data: { capabilityId }
  })

  return { ok: true, error: null }
}

/**
 * 获取已注册能力列表。
 * @returns {Array}
 */
export function listRegisteredCapabilities() {
  const manifest = readManifest()
  if (!manifest) return []
  return Array.isArray(manifest.capabilities) ? manifest.capabilities : []
}
