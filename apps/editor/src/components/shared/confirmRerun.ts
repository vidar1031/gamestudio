// AI 生成/分析类动作的二次确认公共模块（2026-11-03 用户裁决）：
// 已有结果时先弹确认，防止误点覆盖/重复执行昂贵生成。各工作室统一调用，不再各自为政。
import { dlgConfirm } from '../../dialog'

export type RerunConfirmOptions = {
  /** 动作名（用于确认文案，如「场景元素分析」「AI 生成提示词」「场景出图」「生成配音」） */
  action: string
  /** 是否已有可覆盖的结果（已分析/已生成/已出图/已配音）。false 时不打扰直接执行 */
  hasExisting: boolean
  /** 被守卫的执行体；省略时仅作确认闸，由调用方确认后继续 */
  run?: () => void | Promise<void>
}

/** 有旧结果时先二次确认；返回 true=允许执行，false=用户取消（未执行） */
export async function confirmRerun(opts: RerunConfirmOptions): Promise<boolean> {
  if (opts.hasExisting) {
    const ok = await dlgConfirm(`该操作将重新执行「${opts.action}」，可能覆盖已有结果或新增一轮生成。确定继续？`, { okText: '继续执行', cancelText: '取消' })
    if (!ok) return false
  }
  if (opts.run) await opts.run()
  return true
}
