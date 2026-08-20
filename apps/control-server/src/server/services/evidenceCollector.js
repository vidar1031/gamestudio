// 证据收集器（阶段 5：审计与治理完善）。
// 职责：
// - 聚合 action 的完整证据链为单一 evidence pack；
// - 支持导出到 state/evidence-packs/ 供下载与审计；
// - 与 governanceAudit、events.jsonl、review records 互补。

import fs from 'node:fs'
import path from 'node:path'
import { GAMESTUDIO_ROOT } from '../../config/paths.js'
import { getAction } from './actionExecutionService.js'
import { getProjectBinding } from './projectBindingService.js'
import { getProjectCapabilities } from './projectCapabilityService.js'

const DEFAULT_EVIDENCE_PACKS_DIR = path.join(GAMESTUDIO_ROOT, 'state', 'evidence-packs')

function getEvidencePacksDir() {
  const override = process.env.HERMES_EVIDENCE_PACKS_DIR
  if (override && String(override).trim()) return String(override)
  return DEFAULT_EVIDENCE_PACKS_DIR
}

function atomicWriteJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf8')
  fs.renameSync(tmp, file)
}

/**
 * 构建动作证据包。
 * @param {string} actionId
 * @returns {object|null} evidence pack
 */
export function buildEvidencePack(actionId) {
  const action = getAction(actionId)
  if (!action) return null

  const binding = getProjectBinding()
  const capabilitySummary = getProjectCapabilities(binding)
  const capability = capabilitySummary.capabilities.find((item) => item.id === action.capabilityId) || null

  return {
    version: '1.0',
    packId: `evidence_${actionId}`,
    actionId,
    traceId: action.traceId,
    generatedAt: new Date().toISOString(),
    binding: binding?.bound ? {
      id: binding.id,
      label: binding.label,
      baseUrl: binding.baseUrl,
      repoPath: binding.repoPath
    } : null,
    capability: capability ? {
      id: capability.id,
      type: capability.type,
      label: capability.label,
      requiresReview: capability.requiresReview,
      reviewPolicy: capability.reviewPolicy
    } : null,
    action: {
      actionId: action.actionId,
      sessionId: action.sessionId,
      capabilityId: action.capabilityId,
      projectId: action.projectId,
      input: action.input,
      actor: action.actor,
      state: action.state,
      retryCount: action.retryCount,
      maxRetries: action.maxRetries,
      createdAt: action.createdAt,
      updatedAt: action.updatedAt
    },
    stateTransitions: action.stateTransitions || [],
    evidence: action.evidence || [],
    review: action.review || null,
    result: action.result || null,
    error: action.error || null,
    optimization: action.optimization || null
  }
}

/**
 * 导出证据包到文件。
 * @param {string} actionId
 * @returns {{ ok: boolean, filePath?: string, error?: string }}
 */
export function exportEvidencePack(actionId) {
  const pack = buildEvidencePack(actionId)
  if (!pack) {
    return { ok: false, error: 'action_not_found' }
  }
  const file = path.join(getEvidencePacksDir(), `${actionId}.json`)
  try {
    atomicWriteJson(file, pack)
    return { ok: true, filePath: file }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * 列出已导出的证据包。
 */
export function listEvidencePacks(limit = 50) {
  const dir = getEvidencePacksDir()
  if (!fs.existsSync(dir)) return []
  const files = fs.readdirSync(dir).filter((name) => name.endsWith('.json'))
  const packs = []
  for (const name of files) {
    try {
      const pack = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'))
      packs.push({
        actionId: pack.actionId,
        packId: pack.packId,
        generatedAt: pack.generatedAt,
        capabilityId: pack.action?.capabilityId,
        state: pack.action?.state,
        filePath: path.join(dir, name)
      })
    } catch {
      // 跳过损坏文件
    }
  }
  packs.sort((a, b) => String(b.generatedAt || '').localeCompare(String(a.generatedAt || '')))
  return packs.slice(0, Math.max(1, Math.min(200, Number(limit) || 50)))
}
