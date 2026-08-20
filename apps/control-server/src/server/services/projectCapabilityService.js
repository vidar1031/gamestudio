// 项目能力协议服务（阶段 1：能力协议与绑定增强）。
// 职责：
// - 从绑定项目的本地事件注册表（apps/server/events/registry.v1.json）动态生成 capability summary；
// - 为 agent / 控制台提供统一的项目能力视图，避免 agent 依赖大段通用上下文猜测；
// - 未来支持项目根目录 .studio/project-capabilities.json 作为覆盖（当前优先 registry 推导）。
//
// 能力推导规则：
// - event.kind = command -> capability.type = write（需要 review 与否看 reviewRequired）
// - event.kind = query   -> capability.type = read
// - payloadSchema -> inputSchema；resultSchema -> outputSchema
// - transport.http 作为底层执行映射保留，但不直接暴露给 agent 作为调用凭证

import fs from 'node:fs'
import path from 'node:path'
import { GAMESTUDIO_ROOT } from '../../config/paths.js'
import { getProjectCapabilitiesFromManifest } from './projectCapabilityManifest.js'

const DEFAULT_REGISTRY_REL_PATH = path.join('apps', 'server', 'events', 'registry.v1.json')

function readLocalRegistry(repoPath) {
  const root = String(repoPath || '').trim()
  if (!root) return null
  const file = path.resolve(root, DEFAULT_REGISTRY_REL_PATH)
  try {
    if (!fs.existsSync(file)) return null
    const content = fs.readFileSync(file, 'utf8')
    if (!content.trim()) return null
    const registry = JSON.parse(content)
    if (!registry || typeof registry !== 'object' || !Array.isArray(registry.events)) return null
    return { registry, filePath: file }
  } catch {
    return null
  }
}

function mapEventToCapability(event) {
  const kind = String(event?.kind || '').trim().toLowerCase()
  const type = kind === 'command' ? 'write' : 'read'
  return {
    id: String(event?.eventId || '').trim(),
    type,
    label: String(event?.title || '').trim() || String(event?.eventId || '').trim(),
    description: String(event?.description || '').trim(),
    requiresReview: Boolean(event?.reviewRequired),
    reviewPolicy: event?.reviewRequired ? 'manual_before_write' : 'auto_allowed',
    inputSchema: event?.payloadSchema && typeof event.payloadSchema === 'object' ? event.payloadSchema : null,
    outputSchema: event?.resultSchema && typeof event.resultSchema === 'object' ? event.resultSchema : null,
    artifacts: Array.isArray(event?.sideEffects) ? event.sideEffects.filter((item) => String(item || '').startsWith('fs:write:')) : [],
    timeoutMs: Number(event?.timeoutMs) || 30000,
    event: {
      code: String(event?.code || '').trim(),
      eventId: String(event?.eventId || '').trim(),
      kind,
      aliases: Array.isArray(event?.aliases) ? event.aliases : []
    }
  }
}

function buildRuntimeDescriptor(registry, binding, sourcePath) {
  const projectId = String(binding?.id || 'gamestudio').trim()
  const rootDir = String(binding?.repoPath || GAMESTUDIO_ROOT).trim()
  const events = Array.isArray(registry?.events) ? registry.events : []
  const workflows = []
  const categories = Array.isArray(registry?.categories) ? registry.categories : []
  return {
    projectId,
    kind: 'gamestudio-story-project',
    displayName: String(binding?.label || 'GameStudio 交互故事').trim(),
    rootDir,
    boundaries: {
      allowedRoots: [rootDir],
      disallowOutsideWorkspace: true
    },
    events: events.map((item) => String(item?.eventId || '').trim()).filter(Boolean),
    workflows,
    categories,
    sourcePath: sourcePath || null
  }
}

/**
 * 获取当前绑定项目的能力摘要。
 * manifest 是唯一可信源；registry 推导仅在 manifest 缺失时作为显式兜底，并在 source 中明确标记。
 * @param {object} binding - projectBindingService.getProjectBinding() 返回值
 * @returns {{ok:boolean, available:boolean, capabilities:Array, runtimeDescriptor:object|null, source:string, error:string|null}}
 */
export function getProjectCapabilities(binding) {
  if (!binding || binding.bound !== true) {
    return {
      ok: true,
      available: false,
      capabilities: [],
      runtimeDescriptor: null,
      source: 'none',
      error: 'project_not_bound'
    }
  }

  // 1) 唯一可信源：项目能力声明 manifest
  const manifestResult = getProjectCapabilitiesFromManifest(binding)
  if (manifestResult.available) {
    return {
      ...manifestResult,
      source: 'project_manifest',
      runtimeDescriptor: {
        ...manifestResult.runtimeDescriptor,
        manifestRequired: true,
        manifestFound: true,
        registryFallback: false
      }
    }
  }

  // 2) manifest 缺失：明确拒绝，不得隐式生成伪能力
  return {
    ok: true,
    available: false,
    capabilities: [],
    runtimeDescriptor: null,
    source: 'none',
    error: 'project_manifest_required',
    detail: '项目能力声明 manifest 缺失，无法提供可信能力列表。请在绑定项目根目录创建 apps/server/events/project-manifest.v1.json。'
  }
}
