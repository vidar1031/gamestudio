// 产物验证器（阶段 3：产物验证）。
// 职责：
// - 每个事件执行后验证真实产物，而不是相信模型口头宣称；
// - 验证规则从 GameStudio 实际行为提取；
// - 验证失败时返回结构化缺失信息，供修复闭环使用。

import fs from 'node:fs'
import path from 'node:path'
import { GAMESTUDIO_ROOT } from '../../config/paths.js'

function getProjectDir(projectId) {
  return path.join(GAMESTUDIO_ROOT, 'storage', 'projects', String(projectId || ''))
}

function readJsonFile(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null
    return JSON.parse(fs.readFileSync(filePath, 'utf8'))
  } catch {
    return null
  }
}

function countFiles(dir, predicate = () => true) {
  if (!fs.existsSync(dir)) return 0
  let count = 0
  const entries = fs.readdirSync(dir, { withFileTypes: true })
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      count += countFiles(fullPath, predicate)
    } else if (entry.isFile() && predicate(entry.name)) {
      count += 1
    }
  }
  return count
}

/**
 * 验证事件执行后的产物。
 * @param {string} eventId - 事件 ID
 * @param {string} projectId - 项目 ID
 * @param {object} options - 额外选项
 * @returns {{ ok: boolean, missing: string[], expected: object, actual: object }}
 */
export function validateArtifact(eventId, projectId, options = {}) {
  const projectDir = getProjectDir(projectId)
  const missing = []
  const expected = {}
  const actual = {}

  if (!projectId || !fs.existsSync(projectDir)) {
    return { ok: false, missing: ['project_dir_not_found'], expected, actual }
  }

  switch (eventId) {
    case 'story.project.create_ai':
    case 'project.create': {
      // 验证 scripts.json 和 blueprint.json
      const scripts = readJsonFile(path.join(projectDir, 'scripts.json'))
      const blueprint = readJsonFile(path.join(projectDir, 'blueprint.json'))
      expected.scriptsCards = 1
      expected.blueprintNodes = 1
      actual.scriptsCards = Array.isArray(scripts?.cards) ? scripts.cards.length : 0
      actual.blueprintNodes = Array.isArray(blueprint?.nodes) ? blueprint.nodes.length : 0
      if (actual.scriptsCards < expected.scriptsCards) missing.push('scripts_cards_empty')
      if (actual.blueprintNodes < expected.blueprintNodes) missing.push('blueprint_nodes_empty')
      break
    }

    case 'story.blueprint.compile': {
      const blueprint = readJsonFile(path.join(projectDir, 'blueprint.json'))
      expected.blueprintNodes = 1
      actual.blueprintNodes = Array.isArray(blueprint?.nodes) ? blueprint.nodes.length : 0
      if (actual.blueprintNodes < expected.blueprintNodes) missing.push('blueprint_nodes_empty')
      break
    }

    case 'story.asset.plan.generate': {
      const project = readJsonFile(path.join(projectDir, 'project.json'))
      const assetPlan = project?.state?.aiBackground?.assetPlan || project?.state?.storyProduction?.assetPlan
      expected.assetPlanExists = true
      actual.assetPlanExists = Boolean(assetPlan)
      if (!actual.assetPlanExists) missing.push('asset_plan_missing')
      break
    }

    case 'scene.render':
    case 'asset.scene.render':
    case 'asset.scene.renderAll': {
      const story = readJsonFile(path.join(projectDir, 'story.json'))
      const assetsDir = path.join(projectDir, 'assets')
      expected.sceneImages = 1
      actual.sceneImages = countFiles(assetsDir, (name) => /\.(png|jpg|jpeg|webp)$/i.test(name))
      actual.storyNodesWithImage = Array.isArray(story?.nodes)
        ? story.nodes.filter((node) => node?.visuals?.imageAssetId || node?.imageAssetId).length
        : 0
      if (actual.sceneImages < expected.sceneImages) missing.push('scene_images_missing')
      break
    }

    case 'project.export': {
      const distDir = path.join(projectDir, 'builds', 'latest', 'dist')
      expected.distIndexExists = true
      actual.distIndexExists = fs.existsSync(path.join(distDir, 'index.html'))
      if (!actual.distIndexExists) missing.push('dist_index_missing')
      break
    }

    case 'project.validate': {
      // 校验类事件不验证产物，只验证项目存在
      expected.projectExists = true
      actual.projectExists = fs.existsSync(path.join(projectDir, 'project.json'))
      if (!actual.projectExists) missing.push('project_json_missing')
      break
    }

    default:
      // 未知事件：只验证项目目录存在
      expected.projectExists = true
      actual.projectExists = true
      break
  }

  return {
    ok: missing.length === 0,
    missing,
    expected,
    actual
  }
}

/**
 * 从 action result 中提取 projectId。
 */
export function extractProjectIdFromResult(result) {
  if (!result || typeof result !== 'object') return ''
  return String(
    result?.project?.id ||
    result?.data?.project?.id ||
    result?.projectId ||
    result?.evidence?.projectId ||
    ''
  ).trim()
}
