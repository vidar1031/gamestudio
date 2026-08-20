// 项目能力声明协议（P0-1：项目真实能力声明层）。
// 职责：
// - 读取绑定项目的 project-manifest.v1.json（真实能力声明，非 registry 推导）；
// - 提供 capability registry：id -> capability 的完整定义；
// - 支持按 projectId 查询能力清单；
// - 与 projectCapabilityService 互补：manifest 优先，registry 推导兜底。

import fs from 'node:fs'
import path from 'node:path'
import { GAMESTUDIO_ROOT } from '../../config/paths.js'

const DEFAULT_MANIFEST_REL_PATH = path.join('apps', 'server', 'events', 'project-manifest.v1.json')

function readManifestFile(repoPath) {
  const root = String(repoPath || '').trim()
  if (!root) return null
  const file = path.resolve(root, DEFAULT_MANIFEST_REL_PATH)
  try {
    if (!fs.existsSync(file)) return null
    const content = fs.readFileSync(file, 'utf8')
    if (!content.trim()) return null
    const manifest = JSON.parse(content)
    if (!manifest || typeof manifest !== 'object' || !Array.isArray(manifest.capabilities)) return null
    return { manifest, filePath: file }
  } catch {
    return null
  }
}

/**
 * 读取项目能力声明 manifest。
 * @param {string} repoPath - 项目仓库根目录
 * @returns {{ ok: boolean, manifest: object|null, filePath: string|null, error: string|null }}
 */
export function readProjectCapabilityManifest(repoPath) {
  const result = readManifestFile(repoPath)
  if (!result) {
    return { ok: false, manifest: null, filePath: null, error: 'manifest_not_found' }
  }
  return { ok: true, manifest: result.manifest, filePath: result.filePath, error: null }
}

/**
 * 从 manifest 构建 capability registry。
 * @param {object} manifest
 * @returns {Map<string, object>} capabilityId -> capability
 */
export function buildCapabilityRegistry(manifest) {
  const registry = new Map()
  const capabilities = Array.isArray(manifest?.capabilities) ? manifest.capabilities : []
  for (const cap of capabilities) {
    const id = String(cap?.id || '').trim()
    if (!id) continue
    registry.set(id, {
      id,
      type: String(cap?.type || 'read').trim(),
      label: String(cap?.label || id).trim(),
      description: String(cap?.description || '').trim(),
      requiresReview: Boolean(cap?.requiresReview),
      reviewPolicy: String(cap?.reviewPolicy || (cap?.requiresReview ? 'manual_before_write' : 'auto_allowed')).trim(),
      inputSchema: cap?.inputSchema && typeof cap.inputSchema === 'object' ? cap.inputSchema : null,
      outputSchema: cap?.outputSchema && typeof cap.outputSchema === 'object' ? cap.outputSchema : null,
      artifacts: Array.isArray(cap?.artifacts) ? cap.artifacts : [],
      timeoutMs: Number(cap?.timeoutMs) || 30000,
      event: cap?.event && typeof cap.event === 'object' ? cap.event : null
    })
  }
  return registry
}

/**
 * 获取项目能力清单（manifest 优先）。
 * @param {object} binding - projectBindingService.getProjectBinding() 返回值
 * @returns {{ ok: boolean, available: boolean, capabilities: Array, runtimeDescriptor: object|null, source: string, error: string|null }}
 */
export function getProjectCapabilitiesFromManifest(binding) {
  if (!binding || binding.bound !== true) {
    return { ok: true, available: false, capabilities: [], runtimeDescriptor: null, source: 'none', error: 'project_not_bound' }
  }

  const { manifest, filePath, error } = readProjectCapabilityManifest(binding.repoPath)
  if (!manifest) {
    return { ok: true, available: false, capabilities: [], runtimeDescriptor: null, source: 'none', error: error || 'manifest_not_found' }
  }

  const registry = buildCapabilityRegistry(manifest)
  const capabilities = Array.from(registry.values())

  const runtimeDescriptor = {
    projectId: String(manifest.projectId || binding.id || 'gamestudio').trim(),
    kind: String(manifest.kind || 'gamestudio-story-project').trim(),
    displayName: String(manifest.displayName || binding.label || 'GameStudio 交互故事').trim(),
    rootDir: String(manifest.rootDir || binding.repoPath || GAMESTUDIO_ROOT).trim(),
    boundaries: manifest.boundaries && typeof manifest.boundaries === 'object' ? manifest.boundaries : {
      allowedRoots: [String(binding.repoPath || GAMESTUDIO_ROOT).trim()],
      disallowOutsideWorkspace: true
    },
    events: Array.isArray(manifest.events) ? manifest.events : [],
    workflows: Array.isArray(manifest.workflows) ? manifest.workflows : [],
    sourcePath: filePath
  }

  return {
    ok: true,
    available: true,
    capabilities,
    runtimeDescriptor,
    source: 'project_manifest',
    error: null
  }
}
