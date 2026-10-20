// 首页项目卡状态映射（首页定义 §4 用户语言单一来源，2026-10-20 画廊版）
// 输入服务端 ProjectSummary 真相，输出 { label, tone }；前端不自行推断阶段。
import type { ProjectSummary } from '../api'

export type ProjectStatusTone = 'ok' | 'warn' | 'accent' | 'muted'

export function projectStatus(s: ProjectSummary): { label: string; tone: ProjectStatusTone } {
  if (s.stage === 'export') return { label: '已导出', tone: 'accent' }
  if (s.stage === 'playable') {
    const img = s.imageStats
    const imagesDone = !img || img.totalScenes <= 0 || img.withImages >= img.totalScenes
    return imagesDone ? { label: '已完成 · 可导出', tone: 'ok' } : { label: '制作中 · 还差场景图', tone: 'warn' }
  }
  if (s.stage === 'compose') return { label: '制作中 · 合成排版中', tone: 'warn' }
  if (s.stage === 'blueprint') return { label: '制作中 · 蓝图构建中', tone: 'warn' }
  return { label: '制作中 · 脚本创作中', tone: 'warn' }
}

// 状态筛选 pill 组（工具条）：全部/制作中/已完成/已导出
export type HubStatusFilter = 'all' | 'making' | 'done' | 'exported'

export function matchStatusFilter(s: ProjectSummary, filter: HubStatusFilter): boolean {
  if (filter === 'all') return true
  if (filter === 'exported') return s.stage === 'export'
  const tone = projectStatus(s).tone
  if (filter === 'done') return tone === 'ok'
  return tone !== 'ok' && s.stage !== 'export'
}
