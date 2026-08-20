// 生产意图编译器（阶段 2：生产意图编译）。
// 职责：
// - 把用户自然语言目标编译为结构化生产意图（ProductionIntent）；
// - 根据已绑定项目的能力目录选择动作序列；
// - 为每个动作补齐参数（prompt、结构参数、模型路由等）；
// - 输出 ProductionPlan：{ steps: [{ eventId, input, validator, reviewRequired }] }。
//
// 核心原则：
// - 能力由 GameStudio 声明，不由模型臆测；
// - 守护台可以自动新增"编排"，不能未经验证自动新增"生产能力"；
// - 成功由产物验证，不由聊天文本判定。

import { getProjectBinding } from './projectBindingService.js'
import { getProjectCapabilities } from './projectCapabilityService.js'

/**
 * 从用户输入中提取故事标题。
 */
function extractStoryTitle(prompt) {
  const text = String(prompt || '').trim()
  const match = text.match(/创建[一个|个]?(.+?)的?故事/i) || text.match(/(.+?)的故事/i)
  if (match && match[1]) return match[1].trim()
  return ''
}

/**
 * 判断用户是否要求生成场景图/分镜。
 */
function wantsSceneRender(prompt) {
  return /场景图|分镜|出图|渲染|图片|插画|场景|画面/i.test(String(prompt || ''))
}

/**
 * 判断用户是否要求导出。
 */
function wantsExport(prompt) {
  return /导出|export|产物|交付|发布/i.test(String(prompt || ''))
}

/**
 * 判断用户是否要求完整生产闭环。
 */
function wantsFullProduction(prompt) {
  return /完整|闭环|端到端|一口气|全链路|生产|交付|从.*到/i.test(String(prompt || ''))
}

/**
 * 编译生产意图。
 * @param {string} userPrompt - 用户输入
 * @returns {{ ok: boolean, plan: object|null, error: string|null }}
 */
export function compileProductionIntent(userPrompt) {
  const binding = getProjectBinding()
  const capabilitySummary = getProjectCapabilities(binding)
  if (!capabilitySummary.available) {
    return { ok: false, plan: null, error: 'capabilities_unavailable' }
  }

  const capabilities = capabilitySummary.capabilities || []
  const capabilityMap = new Map(capabilities.map((cap) => [cap.id, cap]))

  const title = extractStoryTitle(userPrompt) || '未命名互动故事'
  const prompt = String(userPrompt || '').trim()
  const needScene = wantsSceneRender(prompt)
  const needExport = wantsExport(prompt)
  const needFull = wantsFullProduction(prompt)

  const steps = []

  // 1) AI 创建故事（必须）
  if (capabilityMap.has('story.create_ai')) {
    steps.push({
      stepId: 'step_create_ai_story',
      eventId: 'story.create_ai',
      title: 'AI 创建故事项目',
      input: {
        prompt: prompt,
        title,
        choicePoints: 2,
        optionsPerChoice: 2,
        endings: 2
      },
      reviewRequired: true,
      resourceKind: 'llm'
    })
  } else if (capabilityMap.has('story.create')) {
    // 兜底：无 AI 创建能力时创建空白项目
    steps.push({
      stepId: 'step_create_story',
      eventId: 'story.create',
      title: '创建故事项目',
      input: { title },
      reviewRequired: true,
      resourceKind: 'none'
    })
  }

  // 2) 编译蓝图（必须）
  if (capabilityMap.has('story.compile_blueprint')) {
    steps.push({
      stepId: 'step_compile_blueprint',
      eventId: 'story.compile_blueprint',
      title: '编译蓝图',
      input: {},
      reviewRequired: false,
      resourceKind: 'none'
    })
  }

  // 3) 场景图生成（可选）
  if (needScene || needFull) {
    if (capabilityMap.has('story.generate_asset_plan')) {
      steps.push({
        stepId: 'step_generate_asset_plan',
        eventId: 'story.generate_asset_plan',
        title: '生成资产计划',
        input: {},
        reviewRequired: true,
        resourceKind: 'none'
      })
    }
    if (capabilityMap.has('scene.render')) {
      steps.push({
        stepId: 'step_render_scenes',
        eventId: 'scene.render',
        title: '批量渲染场景图',
        input: { onlyMissing: true },
        reviewRequired: true,
        resourceKind: 'gpu'
      })
    }
  }

  // 4) 校验（必须）
  if (capabilityMap.has('story.validate')) {
    steps.push({
      stepId: 'step_validate_project',
      eventId: 'story.validate',
      title: '校验项目',
      input: {},
      reviewRequired: false,
      resourceKind: 'none'
    })
  }

  // 5) 导出（可选）
  if (needExport || needFull) {
    if (capabilityMap.has('story.export')) {
      steps.push({
        stepId: 'step_export_project',
        eventId: 'story.export',
        title: '导出项目',
        input: {},
        reviewRequired: true,
        resourceKind: 'none'
      })
    }
  }

  if (!steps.length) {
    return { ok: false, plan: null, error: 'no_available_actions' }
  }

  return {
    ok: true,
    plan: {
      planId: `plan_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`,
      goal: `创建故事：${title}`,
      userPrompt: prompt,
      steps,
      createdAt: new Date().toISOString()
    },
    error: null
  }
}
