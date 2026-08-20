/**
 * 人话化展示工具：把结构化负载收敛为「关键参数 chips / 人话摘要 / 参数行」。
 * 原始 JSON/diff/结构化负载一律由组件收进可折叠「技术细节」区，不直接铺首屏。
 */

export type KeyParam = { label: string; value: string }
export type PayloadRow = { key: string; value: string }

const PARAM_VALUE_LIMIT = 80

function clip(value: unknown, limit = PARAM_VALUE_LIMIT): string {
  const text = String(value ?? '').trim()
  if (!text) return ''
  return text.length > limit ? `${text.slice(0, limit)}…` : text
}

/**
 * 从审核卡 evidence.outboundPreview 提取首屏关键参数（tool/action/路径/命令/查询/项目等）。
 * outboundPreview 形状随步骤类型变化，只挑平铺的简单字段，复杂对象留在「技术细节」。
 */
export function extractEvidenceKeyParams(evidence: unknown): KeyParam[] {
  if (!evidence || typeof evidence !== 'object') return []
  const outbound = (evidence as Record<string, unknown>).outboundPreview
  if (!outbound || typeof outbound !== 'object') return []
  const src = outbound as Record<string, unknown>
  const params: KeyParam[] = []
  const pick = (label: string, value: unknown) => {
    const text = clip(value)
    if (text) params.push({ label, value: text })
  }
  pick('工具', src.tool)
  pick('动作', src.action)
  pick('文件', src.path ?? src.filePath)
  pick('命令', src.command)
  pick('查询', src.query)
  pick('项目', src.projectId)
  pick('阶段', src.phase)
  pick('接口', src.endpoint)
  pick('地址', src.url)
  const provider = clip(src.provider)
  const model = clip(src.model)
  if (provider || model) params.push({ label: '模型', value: [provider, model].filter(Boolean).join(' / ') })
  return params.slice(0, 6)
}

/**
 * 事件确认卡参数的人话行：逐键展示；嵌套值 JSON 截断，仍比整段 payload 易读。
 */
export function formatPayloadRows(payload: unknown): PayloadRow[] {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return []
  return Object.entries(payload as Record<string, unknown>).map(([key, value]) => {
    if (value === null || value === undefined) return { key, value: '-' }
    if (typeof value === 'object') return { key, value: clip(JSON.stringify(value), 120) }
    return { key, value: clip(value, 120) }
  })
}

/**
 * 事件执行结果的人话摘要：优先 message/summary 文本，其次常见数组字段的数量结论。
 * 摘要不出来时返回空串，由组件只保留「技术细节」折叠区。
 */
export function summarizeEventResultPayload(result: unknown): string {
  if (result === null || result === undefined) return ''
  if (typeof result === 'string') return clip(result, 200)
  if (Array.isArray(result)) return `返回 ${result.length} 条记录。`
  if (typeof result !== 'object') return clip(result, 200)
  const obj = result as Record<string, unknown>
  const message = clip(obj.message ?? obj.summary ?? obj.text)
  if (message) return message
  const parts: string[] = []
  for (const [key, value] of Object.entries(obj)) {
    if (Array.isArray(value)) {
      const noun = key.includes('project') ? '个项目' : key.includes('stor') ? '个故事' : '条记录'
      parts.push(`${value.length} ${noun}`)
    }
  }
  if (parts.length) return `返回 ${parts.join('，')}。`
  return ''
}
