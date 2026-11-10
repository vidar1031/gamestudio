// 姿态需求/姿势草稿共享类型与纯函数（2026-11-01 抽取自 BlueprintStudio + StoryboardLockWorkspace 的同名实现，
// 蓝图定义端与锁定执行端共用同一份，避免两处各维护一套语义）。
import type { StoryAssetPlan } from '../../api'

/** 计划资产上的姿态需求项（plan.assets[].poseRequirements） */
export type PoseRequirementItem = {
  reqId: string
  stateKey: string
  label: string
  sceneId?: string
  sceneIds?: string[]
  sceneName?: string
  pose?: string
  view?: string
  action?: string
  expression?: string
  promptZh?: string
  promptEn?: string
  createdAt?: string
  [k: string]: unknown
}

/** 需求涉及幕数（sceneIds 数组优先，单 sceneId 回退） */
export function sceneCountOfRequirement(req: unknown): number {
  const r = req as PoseRequirementItem | null
  if (!r) return 0
  if (Array.isArray(r.sceneIds)) return r.sceneIds.length
  return String(r.sceneId || '').trim() ? 1 : 0
}

/** 语义名 → stateKey 规范化（蓝图新增需求与锁定端 upsert 同口径） */
export function poseStateKeyFromName(name: string): string {
  const n = String(name || '').trim()
  if (!n) return ''
  if (/^[\x20-\x7e]+$/.test(n)) return n.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')
  return n
}

/** 锁定端：指定资产在某场景下当前生效的需求（无命中回退自定义空需求壳） */
export function activePoseRequirementFor(asset: any, sceneId: string, activeReqId: string): PoseRequirementItem {
  const reqs: PoseRequirementItem[] = Array.isArray(asset?.poseRequirements) ? asset.poseRequirements : []
  const sid = String(sceneId || '')
  const active = reqs.find((req) => String(req?.reqId || '') === String(activeReqId || '') && String(req?.sceneId || '') === sid)
  if (active) return active
  const scoped = reqs.find((req) => String(req?.sceneId || '') === sid)
  if (scoped) return scoped
  return {
    reqId: `custom::${sid || 'scene'}`,
    stateKey: 'custom',
    label: '自定义姿态',
    sceneId: sid,
    promptZh: '',
    promptEn: ''
  }
}

/** 锁定端：需求行场景名展示 */
export function poseSceneLabelOf(sceneId: string, options: { sceneId: string; label: string }[]): string {
  return options.find((item) => item.sceneId === sceneId)?.label || '当前场景'
}

// ============ 姿势变体执行台每资产本地草稿（持久化本体在 plan 资产 poseDraft） ============
export type PoseDraftEntry = {
  posePromptZh: string
  posePromptEn: string
  negativePromptZh: string
  negativePromptEn: string
  sceneId: string
  advancedOpen: boolean
  ipadapterOn: boolean
  ipadapterWeight: number
  ipadapterStartAt: number
  ipadapterEndAt: number
  lockNames: Record<string, string>
  /** 中文稿来源：user=用户手输；ai=AI/配方/需求回填（残留不带回模型，防旧姿势重生） */
  promptZhSource?: string
}

export function defaultPoseDraft(): PoseDraftEntry {
  // 默认档位取实测中间值（权重 0.8 / 区间 0.2-0.9）：0.7 档姿势自由但服装漂，0.9 档服装全锁但姿势被拉回正身
  return { posePromptZh: '', posePromptEn: '', negativePromptZh: '', negativePromptEn: '', sceneId: '', advancedOpen: false, ipadapterOn: true, ipadapterWeight: 0.8, ipadapterStartAt: 0.2, ipadapterEndAt: 0.9, lockNames: {}, promptZhSource: '' }
}

/** 评分徽标配色：未评分灰，≥70 绿，40-69 黄，<40 红 */
export function poseScoreBadgeOf(c: any): { text: string; color: string } {
  if (!Number.isFinite(Number(c?.score))) return { text: '未评分', color: 'rgba(148,163,184,0.9)' }
  const s = Math.round(Number(c.score))
  const color = s >= 70 ? '#4ade80' : s >= 40 ? '#facc15' : '#f87171'
  return { text: `${s} 分`, color }
}

/** 资产的姿态/状态变体并集（锁定链通用查询） */
export function variantPoolOf(asset: any): any[] {
  return [...(Array.isArray(asset?.poseVariants) ? asset.poseVariants : []), ...(Array.isArray(asset?.stateVariants) ? asset.stateVariants : [])]
}

/** 从计划资产列表查资产（按 id） */
export function findPlanAsset(plan: StoryAssetPlan | null, assetId: string): any {
  return (Array.isArray(plan?.assets) ? (plan!.assets as any[]) : []).find((x) => String(x?.id || '') === String(assetId || '')) || null
}
