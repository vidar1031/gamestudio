// 项目边界保护（P0-4：项目边界保护）。
// 职责：
// - 校验所有写入路径必须位于绑定项目根目录内；
// - 防止路径穿透（../、绝对路径越界、符号链接逃逸）；
// - 拒绝跨项目写入；
// - 为 action executor 提供统一的路径安全判定。

import fs from 'node:fs'
import path from 'node:path'
import { GAMESTUDIO_ROOT } from '../../config/paths.js'

/**
 * 解析并校验目标路径是否在允许的项目根目录内。
 * @param {string} targetPath - 待校验的目标路径（相对或绝对）
 * @param {object} options
 * @param {string} options.projectRoot - 项目根目录（绝对路径）
 * @param {string[]} options.allowedRoots - 额外允许的根目录列表
 * @returns {{ ok: boolean, resolvedPath: string|null, error: string|null }}
 */
export function resolvePathWithinProject(targetPath, { projectRoot, allowedRoots = [] } = {}) {
  const root = String(projectRoot || GAMESTUDIO_ROOT).trim()
  if (!root) {
    return { ok: false, resolvedPath: null, error: 'project_root_missing' }
  }

  const input = String(targetPath || '').trim()
  if (!input) {
    return { ok: false, resolvedPath: null, error: 'path_missing' }
  }

  // 解析为绝对路径
  const resolved = path.resolve(root, input)

  // 收集允许的根目录（项目根 + 额外允许列表）
  const roots = [root, ...allowedRoots.map((r) => String(r || '').trim()).filter(Boolean)]
  const normalizedRoots = roots.map((r) => path.resolve(r))

  // 判定 resolved 是否位于任一 allowed root 之下
  const isInside = normalizedRoots.some((allowedRoot) => {
    const relative = path.relative(allowedRoot, resolved)
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
  })

  if (!isInside) {
    return { ok: false, resolvedPath: resolved, error: 'path_outside_project_root' }
  }

  // 符号链接检查：如果路径已存在，解析真实路径再次确认
  try {
    if (fs.existsSync(resolved)) {
      const real = fs.realpathSync(resolved)
      const realInside = normalizedRoots.some((allowedRoot) => {
        const relative = path.relative(allowedRoot, real)
        return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
      })
      if (!realInside) {
        return { ok: false, resolvedPath: real, error: 'symlink_escapes_project_root' }
      }
    }
  } catch {
    // 实时检查失败不阻断（路径可能尚不存在）
  }

  return { ok: true, resolvedPath: resolved, error: null }
}

/**
 * 从 action input 中提取所有疑似路径字段并校验。
 * 当前覆盖常见字段：projectId、path、file、dir、outputPath、targetPath、sceneId、assetId。
 * @param {object} input - action input
 * @param {object} options - { projectRoot, allowedRoots }
 * @returns {{ ok: boolean, errors: Array<{ field: string, path: string, error: string }> }}
 */
export function validateActionInputPaths(input, { projectRoot, allowedRoots = [] } = {}) {
  const errors = []
  if (!input || typeof input !== 'object') {
    return { ok: true, errors }
  }

  const pathFields = ['path', 'file', 'dir', 'outputPath', 'targetPath', 'rootDir', 'workdir']
  for (const field of pathFields) {
    const value = input[field]
    if (typeof value !== 'string' || !value.trim()) continue
    const result = resolvePathWithinProject(value, { projectRoot, allowedRoots })
    if (!result.ok) {
      errors.push({ field, path: value, error: result.error })
    }
  }

  // projectId 不允许包含路径分隔符或穿透符
  const projectId = String(input.projectId || '').trim()
  if (projectId && (projectId.includes('/') || projectId.includes('\\') || projectId.includes('..'))) {
    errors.push({ field: 'projectId', path: projectId, error: 'project_id_contains_path_traversal' })
  }

  return { ok: errors.length === 0, errors }
}

/**
 * 业务动作特定边界校验规则。
 * 每种业务动作除了通用路径字段校验外，还有自己的业务路径约束。
 */
const BUSINESS_BOUNDARY_RULES = {
  'story.create': (input, errors) => {
    // story.create 只允许 title/template，不允许任何路径字段
    const forbidden = ['path', 'file', 'dir', 'outputPath', 'targetPath', 'rootDir', 'workdir']
    for (const field of forbidden) {
      if (input[field] !== undefined) {
        errors.push({ field, path: String(input[field]), error: 'field_not_allowed_for_story_create' })
      }
    }
  },
  'story.configure': (input, errors) => {
    if (!input.projectId || String(input.projectId).includes('..') || String(input.projectId).includes('/')) {
      errors.push({ field: 'projectId', path: String(input.projectId || ''), error: 'invalid_project_id' })
    }
  },
  'story.generate_scripts': (input, errors) => {
    if (!input.projectId || String(input.projectId).includes('..') || String(input.projectId).includes('/')) {
      errors.push({ field: 'projectId', path: String(input.projectId || ''), error: 'invalid_project_id' })
    }
    if (!input.brief || String(input.brief).trim().length < 1) {
      errors.push({ field: 'brief', path: '', error: 'brief_required' })
    }
  },
  'story.validate': (input, errors) => {
    if (!input.projectId || String(input.projectId).includes('..') || String(input.projectId).includes('/')) {
      errors.push({ field: 'projectId', path: String(input.projectId || ''), error: 'invalid_project_id' })
    }
  },
  'story.compile_blueprint': (input, errors) => {
    if (!input.projectId || String(input.projectId).includes('..') || String(input.projectId).includes('/')) {
      errors.push({ field: 'projectId', path: String(input.projectId || ''), error: 'invalid_project_id' })
    }
  },
  'story.generate_asset_plan': (input, errors) => {
    if (!input.projectId || String(input.projectId).includes('..') || String(input.projectId).includes('/')) {
      errors.push({ field: 'projectId', path: String(input.projectId || ''), error: 'invalid_project_id' })
    }
  },
  'story.lock_asset': (input, errors) => {
    if (!input.projectId || String(input.projectId).includes('..') || String(input.projectId).includes('/')) {
      errors.push({ field: 'projectId', path: String(input.projectId || ''), error: 'invalid_project_id' })
    }
    if (!input.assetId || String(input.assetId).includes('..') || String(input.assetId).includes('/')) {
      errors.push({ field: 'assetId', path: String(input.assetId || ''), error: 'invalid_asset_id' })
    }
  },
  'scene.render': (input, errors) => {
    if (!input.projectId || String(input.projectId).includes('..') || String(input.projectId).includes('/')) {
      errors.push({ field: 'projectId', path: String(input.projectId || ''), error: 'invalid_project_id' })
    }
    if (!input.sceneId || String(input.sceneId).includes('..') || String(input.sceneId).includes('/')) {
      errors.push({ field: 'sceneId', path: String(input.sceneId || ''), error: 'invalid_scene_id' })
    }
  },
  'story.export': (input, errors) => {
    if (!input.projectId || String(input.projectId).includes('..') || String(input.projectId).includes('/')) {
      errors.push({ field: 'projectId', path: String(input.projectId || ''), error: 'invalid_project_id' })
    }
  },
  'project.review': (input, errors) => {
    if (!input.projectId || String(input.projectId).includes('..') || String(input.projectId).includes('/')) {
      errors.push({ field: 'projectId', path: String(input.projectId || ''), error: 'invalid_project_id' })
    }
  }
}

/**
 * 校验 action 是否允许在当前项目边界内执行。
 * @param {object} action - action 记录
 * @param {object} capability - capability 定义
 * @param {object} runtimeDescriptor - 项目运行时描述（含 boundaries）
 * @returns {{ ok: boolean, errors: Array }}
 */
export function enforceActionBoundary(action, capability, runtimeDescriptor) {
  const projectRoot = String(runtimeDescriptor?.rootDir || GAMESTUDIO_ROOT).trim()
  const allowedRoots = Array.isArray(runtimeDescriptor?.boundaries?.allowedRoots)
    ? runtimeDescriptor.boundaries.allowedRoots
    : [projectRoot]

  const errors = []

  // 1) input 中的通用路径字段校验
  const pathCheck = validateActionInputPaths(action?.input, { projectRoot, allowedRoots })
  if (!pathCheck.ok) {
    errors.push(...pathCheck.errors)
  }

  // 2) 业务动作特定边界校验
  const businessRule = BUSINESS_BOUNDARY_RULES[capability?.id]
  if (businessRule) {
    businessRule(action?.input || {}, errors)
  }

  // 3) 写入类动作必须声明 artifacts，且 artifacts 必须在项目根目录内
  if (capability?.type === 'write') {
    const artifacts = Array.isArray(capability?.artifacts) ? capability.artifacts : []
    for (const artifact of artifacts) {
      const result = resolvePathWithinProject(artifact, { projectRoot, allowedRoots })
      if (!result.ok) {
        errors.push({ field: 'artifacts', path: artifact, error: result.error })
      }
    }
  }

  return { ok: errors.length === 0, errors }
}
