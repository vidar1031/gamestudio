// 故事需求规格整理器。
// 职责：
// - 从用户输入提取故事字段（标题、简介、互动结构、是否出图、是否导出）；
// - 识别缺失的必填字段；
// - 生成追问问题；
// - 用户确认后生成完整的需求规格。

/**
 * 从用户输入中提取故事字段。
 */
export function extractStoryFields(userPrompt) {
  const text = String(userPrompt || '').trim()
  const fields = {
    title: '',
    brief: '',
    choicePoints: null,
    optionsPerChoice: null,
    endings: null,
    wantsScene: null,
    wantsExport: null
  }

  // 提取标题
  const titleMatch = text.match(/创建\s*(?:一个|个)?\s*(.+?)\s*的?故事/i) || text.match(/(.+?)的故事/i)
  if (titleMatch && titleMatch[1]) {
    fields.title = titleMatch[1].trim().replace(/^[一个|个]\s*/, '')
  }

  // 提取简介（标题后的补充描述）
  const briefMatch = text.match(/故事(?:简介|内容|描述)[：:](.+?)(?:[，。；;]|$)/i)
    || text.match(/(?:关于|讲述|描述)(.+?)(?:[，。；;]|$)/i)
    || text.match(/故事[，,](.+?)(?:[，。；;]|$)/i)
  if (briefMatch && briefMatch[1]) {
    fields.brief = briefMatch[1].trim()
  }
  // 兜底：如果标题已提取，标题后的剩余文本作为简介
  if (!fields.brief && fields.title) {
    const afterTitle = text.split(fields.title)[1] || ''
    const cleaned = afterTitle.replace(/^[的|故事|，,。；;\s]+/, '').trim()
    if (cleaned) fields.brief = cleaned
  }

  // 提取互动结构参数
  const choiceMatch = text.match(/(\d+)\s*[个|点]?\s*选择/i)
  if (choiceMatch) fields.choicePoints = Math.max(1, Math.min(3, Number(choiceMatch[1])))

  const optionsMatch = text.match(/(\d+)\s*选/i)
  if (optionsMatch) fields.optionsPerChoice = Math.max(2, Math.min(3, Number(optionsMatch[1])))

  const endingsMatch = text.match(/(\d+)\s*[个|种]?\s*结局/i)
  if (endingsMatch) fields.endings = Math.max(1, Math.min(3, Number(endingsMatch[1])))

  // 是否出图
  if (/不出图|不生成图|不要图|无图/i.test(text)) {
    fields.wantsScene = false
  } else if (/出图|生成图|场景图|分镜|渲染|图片|插画/i.test(text)) {
    fields.wantsScene = true
  }

  // 是否导出
  if (/不导出|不要导出|无需导出/i.test(text)) {
    fields.wantsExport = false
  } else if (/导出|export|产物|交付|发布/i.test(text)) {
    fields.wantsExport = true
  }

  return fields
}

/**
 * 识别缺失的必填字段。
 */
export function identifyMissingFields(fields) {
  const missing = []
  if (!fields.title) missing.push({ field: 'title', label: '故事标题', question: '请提供故事标题（如：三只小猪）' })
  if (!fields.brief) missing.push({ field: 'brief', label: '故事简介', question: '请提供故事简介（如：三只小猪抵抗大野狼）' })
  return missing
}

/**
 * 推荐默认值。
 */
export function recommendDefaults(fields) {
  const defaults = {
    choicePoints: fields.choicePoints ?? 2,
    optionsPerChoice: fields.optionsPerChoice ?? 2,
    endings: fields.endings ?? 2,
    wantsScene: fields.wantsScene ?? false,
    wantsExport: fields.wantsExport ?? false
  }
  return defaults
}

/**
 * 生成需求规格确认文本。
 */
export function buildRequirementSummary(fields, defaults) {
  const lines = []
  lines.push(`标题：${fields.title || '未提供'}`)
  lines.push(`故事简介：${fields.brief || '未提供'}`)
  lines.push(`互动结构：${defaults.choicePoints} 个选择点，每个选择点 ${defaults.optionsPerChoice} 个选项，共 ${defaults.endings} 个结局`)
  lines.push(`是否出图：${defaults.wantsScene ? '是' : '否'}`)
  lines.push(`是否导出：${defaults.wantsExport ? '是' : '否'}`)
  return lines.join('\n')
}

/**
 * 编译完整需求规格。
 */
export function compileStoryRequirement(userPrompt) {
  const fields = extractStoryFields(userPrompt)
  const missing = identifyMissingFields(fields)
  const defaults = recommendDefaults(fields)

  return {
    fields,
    missing,
    defaults,
    summary: buildRequirementSummary(fields, defaults),
    complete: missing.length === 0
  }
}
