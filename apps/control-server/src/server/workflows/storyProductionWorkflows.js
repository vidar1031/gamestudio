function createPlanId() {
  return `plan_story_${Date.now()}_${Math.random().toString(16).slice(2, 10)}`
}

function normalizePrompt(value) {
  return String(value || '').replace(/\s+/g, ' ').trim()
}

function makeStep(stepId, title, action, params = {}, dependsOn = [], options = {}) {
  return {
    stepId,
    title,
    action,
    tool: options.tool || inferToolForStoryAction(action),
    params,
    skipReview: options.skipReview === true,
    dependsOn
  }
}

function inferToolForStoryAction(action) {
  if (action === 'story_create_project') return 'gamestudio.story.createProject'
  if (action === 'story_create_ai_project') return 'gamestudio.story.createAiProject'
  if (action === 'story_configure_project') return 'gamestudio.story.configureProject'
  if (action === 'story_inspect_project') return 'gamestudio.story.inspectProject'
  if (action === 'story_generate_scripts_candidate') return 'gamestudio.story.generateScriptsCandidate'
  if (action === 'story_write_scripts') return 'gamestudio.story.writeScripts'
  if (action === 'story_compile_blueprint') return 'gamestudio.story.compileBlueprint'
  if (action === 'story_analyze_scripts') return 'gamestudio.story.analyzeScripts'
  if (action === 'story_review_blueprint_agent') return 'gamestudio.story.reviewBlueprintAgent'
  if (action === 'story_repair_blueprint_if_needed') return 'gamestudio.story.repairBlueprintIfNeeded'
  if (action === 'story_compile_compose') return 'gamestudio.story.compileCompose'
  if (action === 'story_validate_project') return 'gamestudio.story.validateProject'
  if (action === 'story_export_project') return 'gamestudio.story.exportProject'
  if (action === 'story_preflight_image_provider') return 'gamestudio.story.preflightImageProvider'
  if (action === 'story_create_bible') return 'gamestudio.story.createBible'
  if (action === 'story_create_asset_plan') return 'gamestudio.story.createAssetPlan'
  if (action === 'story_generate_lock_asset_references') return 'gamestudio.story.generateLockAssetReferences'
  if (action === 'story_generate_asset_candidate') return 'gamestudio.story.generateAssetCandidate'
  if (action === 'story_lock_test') return 'gamestudio.story.lockTest'
  if (action === 'story_render_scene') return 'gamestudio.story.renderScene'
  return `gamestudio.${action}`
}

export function extractStoryTitleFromPrompt(userPrompt) {
  const prompt = normalizePrompt(userPrompt)
  const patterns = [
    /题目(?:为|是)\s*[“"]([^”"]+)[”"]/,
    /标题(?:为|是)\s*[“"]([^”"]+)[”"]/,
    /名为\s*[“"]([^”"]+)[”"]/,
    /题目(?:为|是)\s*([^。；;,.，]+?)(?:。|；|;|,|，|$)/,
    /标题(?:为|是)\s*([^。；;,.，]+?)(?:。|；|;|,|，|$)/,
    /名为\s*([^。；;,.，]+?)(?:。|；|;|,|，|$)/
  ]
  for (const pattern of patterns) {
    const match = prompt.match(pattern)
    const title = String(match?.[1] || '').trim()
    if (title) return title
  }
  return '未命名互动故事'
}

export function extractProjectIdFromPrompt(userPrompt) {
  const prompt = normalizePrompt(userPrompt)
  const uuidMatch = prompt.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i)
  if (uuidMatch) return uuidMatch[0]
  const compactMatch = prompt.match(/\bproject[_-]?[0-9a-z]{6,}\b/i)
  return compactMatch ? compactMatch[0] : ''
}

export function inferStoryConfigFromPrompt(userPrompt) {
  const prompt = normalizePrompt(userPrompt)
  const pick = (labels, fallback) => {
    for (const label of labels) {
      const pattern = new RegExp(`${label}[：:]?\\s*([^，。；;]+)`, 'i')
      const match = prompt.match(pattern)
      const value = String(match?.[1] || '').trim()
      if (value) return value
    }
    return fallback
  }
  return {
    genre: pick(['题材', '类型', 'genre'], /时间循环|雨夜|咖啡馆/.test(prompt) ? '悬疑时间循环' : '互动剧情'),
    style: pick(['风格', 'style'], /雨夜|咖啡馆/.test(prompt) ? '电影感、轻悬疑、温暖霓虹' : '清晰、可互动、适合 H5'),
    targetAudience: pick(['目标受众', '受众', 'audience'], '泛娱乐互动故事读者'),
    outputLanguage: pick(['输出语言', '语言', 'language'], /英文|英语|en-US/i.test(prompt) ? 'en-US' : 'zh-CN'),
    choicePoints: /选择点/.test(prompt) ? null : 1,
    optionsPerChoice: 2,
    endings: /结局/.test(prompt) ? null : 2
  }
}

function appendAnswerStep(steps, options = {}) {
  const previous = steps[steps.length - 1]
  const skipReview = options && typeof options === 'object' ? Boolean(options.skipReview) : false
  steps.push(makeStep('step_story_answer', '基于故事生产 artifacts 生成最终回答', 'generate_default_answer', {}, previous ? [previous.stepId] : [], {
    tool: 'model.answer',
    skipReview
  }))
}

function appendFullP0Steps(add, { projectId, title, config, prompt }) {
  add('step_story_create_project', '创建互动故事项目', 'story_create_project', { title })
  add('step_story_configure_project', '写入故事生成配置', 'story_configure_project', { projectId, config })
  add('step_story_generate_scripts_candidate', '生成故事脚本候选', 'story_generate_scripts_candidate', { projectId, brief: prompt, title })
  add('step_story_write_scripts', '写入故事脚本到项目', 'story_write_scripts', { projectId })
  add('step_story_create_bible', '生成 Story Bible', 'story_create_bible', { projectId, timeoutMs: 600000 })
  add('step_story_compile_blueprint', '编译脚本为蓝图', 'story_compile_blueprint', { projectId })
  add('step_story_review_blueprint_agent', '智能体评审交互蓝图', 'story_review_blueprint_agent', { projectId })
  add('step_story_repair_blueprint_if_needed', '按评审结果修复蓝图', 'story_repair_blueprint_if_needed', { projectId })
  appendPreComposeImagePreflight(add, { projectId })
  add('step_story_compile_compose', '编译蓝图为可运行故事', 'story_compile_compose', { projectId })
  add('step_story_validate_project', '校验互动故事项目', 'story_validate_project', { projectId })
  add('step_story_export_project', '导出互动故事项目', 'story_export_project', { projectId })
}

function appendAiStoryToComposeSteps(add, { projectId, title, prompt }) {
  add('step_story_create_ai_project', '通过 GameStudio AI 创建故事草稿', 'story_create_ai_project', {
    title,
    prompt,
    choicePoints: 2,
    optionsPerChoice: 2,
    endings: 2,
    timeoutMs: 600000
  })
  add('step_story_analyze_scripts', '分析脚本并生成蓝图建议', 'story_analyze_scripts', { projectId })
  add('step_story_review_blueprint_agent', '智能体评审交互蓝图', 'story_review_blueprint_agent', { projectId })
  add('step_story_repair_blueprint_if_needed', '按评审结果修复蓝图', 'story_repair_blueprint_if_needed', { projectId })
  appendPreComposeImagePreflight(add, { projectId })
  add('step_story_compile_compose', '编译蓝图为可运行故事', 'story_compile_compose', { projectId })
  add('step_story_validate_project', '校验互动故事项目', 'story_validate_project', { projectId })
}

function appendPreComposeImagePreflight(add, { projectId }) {
  add('step_story_preflight_image_provider', '检查锁定事物与连续分镜出图前置条件', 'story_preflight_image_provider', {
    projectId,
    mode: 'storyboard',
    timeoutMs: 15000
  })
}

function appendP1AssetSteps(add, { projectId }) {
  add('step_story_create_asset_plan', '基于 Story Bible 创建资产计划', 'story_create_asset_plan', {
    projectId,
    rebuild: false,
    source: 'control_production_delivery'
  })
  add('step_story_preflight_image_provider', '检查图片 Provider 生产前置条件', 'story_preflight_image_provider', {
    projectId,
    mode: 'storyboard',
    timeoutMs: 15000
  })
  add('step_story_generate_lock_asset_references', '绘制锁定事物参考图', 'story_generate_lock_asset_references', {
    projectId,
    maxAssets: 8,
    batchSize: 1,
    style: 'picture_book',
    timeoutMs: 600000,
    source: 'control_production_delivery'
  })
  add('step_story_render_scene', '渲染首个故事场景图', 'story_render_scene', {
    projectId,
    width: 768,
    height: 1024,
    timeoutMs: 600000
  })
  add('step_story_validate_project', '校验锁定资产引用和项目结构', 'story_validate_project', { projectId })
  add('step_story_export_project', '重新导出带资产的互动故事项目', 'story_export_project', { projectId })
}

export function buildStoryWorkflowPlan(userPrompt) {
  const prompt = normalizePrompt(userPrompt)
  const projectId = extractProjectIdFromPrompt(prompt)
  const title = extractStoryTitleFromPrompt(prompt)
  const config = inferStoryConfigFromPrompt(prompt)
  const steps = []
  const add = (stepId, titleText, action, params = {}, options = {}) => {
    const previous = steps[steps.length - 1]
    const step = makeStep(stepId, titleText, action, params, previous ? [previous.stepId] : [], options)
    steps.push(step)
    return step
  }

  const referencesCreateOutcome = /创建.*失败|如果创建失败/i.test(prompt)
  const wantsProductionDelivery = /生产交付|完整交付|端到端交付|生产级|补齐.*生产|补齐.*交付|全链路交付/i.test(prompt)
  const wantsCreate = !wantsProductionDelivery && !referencesCreateOutcome && /创建|新建|制作|产出|create/i.test(prompt) && /故事|互动故事|项目|story/i.test(prompt)
  const wantsReadConfig = /读取项目配置|确认写入|配置.*一致/i.test(prompt)
  const wantsConfig = !wantsReadConfig && /配置|生成配置|题材|风格|目标受众|输出语言|configure/i.test(prompt)
  const wantsConfigFailureAnalysis = wantsConfig && /如果.*(?:不能|失败)|还不能.*落盘|配置.*(?:不能|失败)|落盘.*(?:不能|失败)/i.test(prompt)
  const wantsOutlineOrScripts = /大纲|脚本|分镜|scripts?|outline|brief/i.test(prompt)
  const wantsWriteBack = /写回|转换|最小 story|最小 scripts|项目目录|落盘/i.test(prompt)
  const wantsLockTest = /事物锁定测试|锁定测试|lock.?test|lock_test|测试.*锁定/i.test(prompt)
  const wantsLockAssets = !wantsLockTest && /锁定事物|必须包括|必要事物|主参考|参考图|锁定.*图|绘制.*锁定|lock(?:ed)?\s*(?:asset|reference)|asset\s*reference/i.test(prompt)
  const forbidsAssets = /不画.*背景图|不要.*背景图|不画.*图|不要.*图|不出图|不生成.*图|不制作.*图|no\s*background|no\s*image|no\s*asset/i.test(prompt)
  const wantsAssets = !forbidsAssets && (wantsLockAssets || /资产|背景图|角色|立绘|图片|出图|asset|image|sprite/i.test(prompt))
  const wantsStoryBibleOnly = /story\s*bible|圣经|故事圣经/i.test(prompt) && /只执行|仅执行|只生成|仅生成|只做|仅做|只跑|仅跑/i.test(prompt)
  const forbidsAssetPlan = /不执行\s*asset\s*plan|不做\s*asset\s*plan|不要\s*asset\s*plan|不执行\s*资产计划|不做\s*资产计划|不要\s*资产计划/i.test(prompt)
  const forbidsLockTest = /不执行\s*lock\s*test|不做\s*lock\s*test|不要\s*lock\s*test|不执行\s*锁定测试|不做\s*锁定测试|不要\s*锁定测试/i.test(prompt)
  const wantsValidate = !wantsConfig && /校验|验证|validate|结构校验|资源引用/i.test(prompt)
  const wantsExport = /导出|export|dist|产物/i.test(prompt)
  const wantsInspect = /列出|读取|检查|说明|判断|是否|哪些部分|目录|直接子项/i.test(prompt)
  const wantsFullP0 = wantsCreate && /完整|闭环|端到端|一口气|全链路|生产|P0|导出|交付|从.*到/i.test(prompt)
  const wantsAiStoryToCompose = /AI\s*创建故事|AI\s*生成.*故事|生成.*故事|蓝图|合成|交互故事|ai[-_\s]?create[-_\s]?story/i.test(prompt)
  const wantsCompileOnly = !wantsCreate && /将|把/i.test(prompt) && /编译|合成/i.test(prompt) && /blueprint|compose|story/i.test(prompt)
  const wantsBlueprintReviewToCompose = !wantsCompileOnly && /蓝图|合成|评审|评分|修复|交互故事/i.test(prompt) && !wantsCreate

  if (wantsCompileOnly) {
    add('step_story_compile_blueprint', '编译脚本为蓝图', 'story_compile_blueprint', { projectId })
    add('step_story_compile_compose', '编译蓝图为可运行故事', 'story_compile_compose', { projectId })
    add('step_story_validate_project', '校验互动故事项目', 'story_validate_project', { projectId })
    appendAnswerStep(steps)
    return {
      planId: createPlanId(),
      goal: '编译脚本为蓝图并编译为可运行故事',
      strategy: 'sequential',
      steps
    }
  }

  if (wantsBlueprintReviewToCompose) {
    add('step_story_analyze_scripts', '分析脚本并生成蓝图建议', 'story_analyze_scripts', { projectId })
    add('step_story_review_blueprint_agent', '智能体评审交互蓝图', 'story_review_blueprint_agent', { projectId })
    add('step_story_repair_blueprint_if_needed', '按评审结果修复蓝图', 'story_repair_blueprint_if_needed', { projectId })
    appendPreComposeImagePreflight(add, { projectId })
    add('step_story_compile_compose', '编译蓝图为可运行故事', 'story_compile_compose', { projectId })
    add('step_story_validate_project', '校验互动故事项目', 'story_validate_project', { projectId })
    appendAnswerStep(steps)
    return {
      planId: createPlanId(),
      goal: '通过 Control 托管现有故事项目的蓝图评审、必要修复和合成校验',
      strategy: 'sequential',
      steps
    }
  }

  if (wantsCreate && wantsAiStoryToCompose) {
    appendAiStoryToComposeSteps(add, { projectId, title, prompt })
    appendAnswerStep(steps)
    return {
      planId: createPlanId(),
      goal: '通过 Control 托管 GameStudio AI 创建故事、蓝图智能体评审、必要修复和合成校验',
      strategy: 'sequential',
      steps
    }
  }

  if (wantsProductionDelivery) {
    appendFullP0Steps(add, { projectId, title, config, prompt })
    appendP1AssetSteps(add, { projectId })
    appendAnswerStep(steps)
    return {
      planId: createPlanId(),
      goal: '执行 Control + Hermes/OMLX + GameStudio Server 的 P0 文本 + P1 图片资产完整生产交付闭环',
      strategy: 'sequential',
      steps
    }
  }

  if (wantsFullP0) {
    appendFullP0Steps(add, { projectId, title, config, prompt })
    appendAnswerStep(steps)
    return {
      planId: createPlanId(),
      goal: '执行 Control + Hermes/OMLX + GameStudio Server 的 P0 文本互动故事生产闭环',
      strategy: 'sequential',
      steps
    }
  }

  if (wantsCreate) {
    add('step_story_create_project', '创建互动故事项目', 'story_create_project', { title })
    if (wantsConfig) add('step_story_configure_project', '写入故事生成配置', 'story_configure_project', { projectId, config })
    add('step_story_inspect_project', '读取项目目录证据', 'story_inspect_project', { projectId })
    appendAnswerStep(steps)
    return {
      planId: createPlanId(),
      goal: '通过 Control story workflow 创建互动故事项目并返回可验证目录证据',
      strategy: 'sequential',
      steps
    }
  }

  if (wantsStoryBibleOnly && forbidsAssetPlan && forbidsLockTest) {
    add('step_story_create_bible', '显式生成 Story Bible', 'story_create_bible', {
      projectId,
      timeoutMs: 600000
    })
    appendAnswerStep(steps, { skipReview: true })
    return {
      planId: createPlanId(),
      goal: '仅显式生成并写回 Story Bible，然后返回可验证结果摘要',
      strategy: 'sequential',
      steps
    }
  }

  if (wantsLockTest) {
    add('step_story_create_bible', '显式生成 Story Bible', 'story_create_bible', {
      projectId,
      timeoutMs: 600000
    })
    add('step_story_create_asset_plan', '基于 Story Bible 创建资产计划', 'story_create_asset_plan', {
      projectId,
      rebuild: false,
      source: 'control_story_lock_test'
    })
    add('step_story_preflight_image_provider', '检查 ComfyUI 和 SDXL 锁定测试前置条件', 'story_preflight_image_provider', {
      projectId,
      mode: 'storyboard',
      timeoutMs: 15000,
      lockAnalysisRequired: false
    })
    add('step_story_lock_test', '执行事物锁定出图测试', 'story_lock_test', {
      projectId,
      style: 'picture_book',
      maxAttempts: 3,
      timeoutMs: 600000
    })
    appendAnswerStep(steps)
    return {
      planId: createPlanId(),
      goal: '通过 Control story workflow 对指定项目执行 SDXL 事物锁定出图测试，验证 ComfyUI 锁定工作流可用性',
      strategy: 'sequential',
      steps
    }
  }

  if (wantsLockAssets) {
    add('step_story_create_bible', '显式生成 Story Bible', 'story_create_bible', {
      projectId,
      timeoutMs: 600000
    })
    add('step_story_create_asset_plan', '锁定故事必须包括的事物', 'story_create_asset_plan', {
      projectId,
      rebuild: /重建|重新|rebuild/i.test(prompt),
      source: 'control_lock_object_stage'
    })
    add('step_story_preflight_image_provider', '检查锁定事物出图前置条件', 'story_preflight_image_provider', {
      projectId,
      mode: 'storyboard',
      timeoutMs: 15000,
      lockAnalysisRequired: false
    })
    add('step_story_generate_lock_asset_references', '绘制锁定事物参考图', 'story_generate_lock_asset_references', {
      projectId,
      maxAssets: 8,
      batchSize: 1,
      style: 'picture_book',
      timeoutMs: 600000,
      source: 'control_lock_object_stage'
    })
    add('step_story_validate_project', '校验锁定资产引用和项目结构', 'story_validate_project', { projectId })
    appendAnswerStep(steps)
    return {
      planId: createPlanId(),
      goal: '通过 Control story workflow 完成锁定事物识别、锁定参考图生成和项目校验',
      strategy: 'sequential',
      steps
    }
  }

  if (wantsAssets) {
    add('step_story_create_bible', '显式生成 Story Bible', 'story_create_bible', {
      projectId,
      timeoutMs: 600000
    })
    add('step_story_create_asset_plan', '创建故事资产计划', 'story_create_asset_plan', {
      projectId,
      rebuild: /重建|重新|rebuild/i.test(prompt),
      source: 'control_production_delivery'
    })
    add('step_story_preflight_image_provider', '检查图片 provider 生产前置条件', 'story_preflight_image_provider', {
      projectId,
      mode: /分镜|连续|storyboard/i.test(prompt) ? 'storyboard' : 'basic',
      timeoutMs: 15000
    })
    add('step_story_generate_asset_candidate', '生成或检查故事资产候选', 'story_generate_asset_candidate', {
      projectId,
      assetKind: /角色|立绘|sprite|character/i.test(prompt) ? 'character' : 'background',
      prompt
    })
    add('step_story_validate_project', '校验资产引用和项目结构', 'story_validate_project', { projectId })
    add('step_story_export_project', '重新导出带资产的互动故事项目', 'story_export_project', { projectId })
    appendAnswerStep(steps)
    return {
      planId: createPlanId(),
      goal: '通过 Control story workflow 执行 P1 图片资产前置检查、计划、生成、校验和导出',
      strategy: 'sequential',
      steps
    }
  }

  if (wantsExport) {
    add('step_story_validate_project', '导出前校验项目结构', 'story_validate_project', { projectId })
    add('step_story_export_project', '导出互动故事项目', 'story_export_project', { projectId })
    appendAnswerStep(steps)
    return {
      planId: createPlanId(),
      goal: '通过 Control story workflow 校验并导出互动故事项目',
      strategy: 'sequential',
      steps
    }
  }

  if (wantsValidate) {
    add('step_story_validate_project', '校验互动故事项目', 'story_validate_project', { projectId })
    appendAnswerStep(steps)
    return {
      planId: createPlanId(),
      goal: '通过 Control story workflow 校验互动故事项目并返回失败边界',
      strategy: 'sequential',
      steps
    }
  }

  if (wantsOutlineOrScripts) {
    add('step_story_generate_scripts_candidate', '生成故事脚本候选', 'story_generate_scripts_candidate', { projectId, brief: prompt, title })
    if (wantsWriteBack) {
      add('step_story_write_scripts', '写入故事脚本到项目', 'story_write_scripts', { projectId })
      add('step_story_compile_blueprint', '编译脚本为蓝图', 'story_compile_blueprint', { projectId })
      add('step_story_compile_compose', '编译蓝图为可运行故事', 'story_compile_compose', { projectId })
      add('step_story_validate_project', '校验生成结果', 'story_validate_project', { projectId })
    }
    appendAnswerStep(steps)
    return {
      planId: createPlanId(),
      goal: wantsWriteBack ? '生成故事脚本并写回项目形成最小 story/scripts 结构' : '生成可审核的故事大纲和脚本候选',
      strategy: 'sequential',
      steps
    }
  }

  if (wantsConfigFailureAnalysis) {
    add('step_story_inspect_project', '检查项目配置落盘状态和失败边界', 'story_inspect_project', { projectId })
    appendAnswerStep(steps)
    return {
      planId: createPlanId(),
      goal: '检查项目配置落盘状态并说明失败边界',
      strategy: 'sequential',
      steps
    }
  }

  if (wantsConfig) {
    add('step_story_configure_project', '写入故事生成配置', 'story_configure_project', { projectId, config })
    add('step_story_inspect_project', '读取项目配置和目录证据', 'story_inspect_project', { projectId })
    appendAnswerStep(steps)
    return {
      planId: createPlanId(),
      goal: '通过 Control story workflow 写入并验证项目生成配置',
      strategy: 'sequential',
      steps
    }
  }

  if (wantsReadConfig || wantsInspect) {
    add('step_story_inspect_project', '读取故事项目目录和配置证据', 'story_inspect_project', { projectId })
    appendAnswerStep(steps)
    return {
      planId: createPlanId(),
      goal: '读取当前故事项目目录、配置、脚本、蓝图、资源和导出证据',
      strategy: 'sequential',
      steps
    }
  }

  appendFullP0Steps(add, { projectId, title, config, prompt })
  appendAnswerStep(steps)
  return {
    planId: createPlanId(),
    goal: '执行 Control + Hermes/OMLX + GameStudio Server 的 P0 文本互动故事生产闭环',
    strategy: 'sequential',
    steps
  }
}