// 首页项目卡状态映射（首页定义 §4 用户语言单一来源，2026-10-20 画廊版）
// 输入服务端 ProjectSummary 真相，输出 { label, tone }；前端不自行推断阶段。
// Q 波（2026-10-27 倒挂根修）：stage 语义=真实生产进度（服务端 deriveProjectStage 单一来源）——
//   playable=dist 存在「已导出 · 可试玩」；export=生产齐无 dist「已完成 · 待导出」；其余为制作中分档。
import type { ProjectSummary } from '../api'

export type ProjectStatusTone = 'ok' | 'warn' | 'accent' | 'muted'

export function projectStatus(s: ProjectSummary): { label: string; tone: ProjectStatusTone } {
  if (s.stage === 'playable') return { label: '已导出 · 可试玩', tone: 'accent' }
  if (s.stage === 'export') return { label: '已完成 · 待导出', tone: 'ok' }
  if (s.stage === 'compose') return { label: '制作中 · 合成排版中', tone: 'warn' }
  if (s.stage === 'blueprint') return { label: '制作中 · 蓝图构建中', tone: 'warn' }
  return { label: '制作中 · 脚本创作中', tone: 'warn' }
}

// 状态筛选 pill 组（工具条）：全部/制作中/已完成/已导出
// Q 波口径：已导出=dist 存在（playable）；已完成=生产齐（export+playable，playable 同入两档）；制作中=其余
export type HubStatusFilter = 'all' | 'making' | 'done' | 'exported'

export function matchStatusFilter(s: ProjectSummary, filter: HubStatusFilter): boolean {
  if (filter === 'all') return true
  if (filter === 'exported') return s.stage === 'playable'
  if (filter === 'done') return s.stage === 'export' || s.stage === 'playable'
  return s.stage === 'script' || s.stage === 'blueprint' || s.stage === 'compose'
}
