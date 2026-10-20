// 当前生效·只读摘要条（ui_设置定义.md §4.1）：
// 行序固定 故事分镜/图像提示词/提示词翻译/审核模型/图像服务/语音/视频，末尾一行界面偏好。
import type { StudioEffectiveConfig, StudioSettings } from './settingsApi'

type SummaryLine = { label: string; text: string; warn: boolean }

function textLine(label: string, enabled: boolean, cfg: { provider: string; model: string | null } | undefined): SummaryLine {
  if (!enabled) return { label, text: '已停用', warn: false }
  const p = String(cfg?.provider || '').trim()
  if (!p || p === 'none') return { label, text: '未配置', warn: true }
  return { label, text: `${p} / ${cfg?.model || '默认模型'}`, warn: false }
}

export default function EffectiveSummary(props: { settings: StudioSettings | null; effective: StudioEffectiveConfig | null }) {
  const e = props.effective
  const s = props.settings
  if (!e) {
    return (
      <div className="settings-summary">
        <div className="settings-summary-line">
          <span className="settings-summary-label">当前生效</span>
          <span>载入中…</span>
        </div>
      </div>
    )
  }

  const lines: SummaryLine[] = []
  lines.push(textLine('故事分镜', e.enabled.scripts, e.scripts))
  lines.push(textLine('图像提示词', e.enabled.prompt, e.prompt))

  // §8 翻译跟随：settings.translation 未单独配置时跟随图像提示词
  const translationOwn = String(s?.translation?.provider || '').trim()
  if (translationOwn) {
    lines.push(textLine('提示词翻译', true, e.translation))
  } else if (e.enabled.prompt) {
    lines.push({ label: '提示词翻译', text: `跟随图像提示词（${e.translation.provider} / ${e.translation.model || '默认模型'}）`, warn: false })
  } else {
    lines.push({ label: '提示词翻译', text: '已停用（跟随图像提示词）', warn: false })
  }

  const reviewProvider = String(e.review?.provider || '').trim()
  if (!reviewProvider || reviewProvider === 'none' || reviewProvider === 'off') {
    lines.push({ label: '审核模型', text: '已停用', warn: false })
  } else {
    lines.push({ label: '审核模型', text: `${reviewProvider} / ${e.review?.model || '默认模型'}`, warn: false })
  }

  lines.push(textLine('图像服务', e.enabled.image, e.image))

  if (!e.enabled.tts) {
    lines.push({ label: '语音', text: '已停用', warn: false })
  } else {
    const p = String(e.tts?.provider || '').trim()
    if (!p || p === 'none') lines.push({ label: '语音', text: '未配置', warn: true })
    else lines.push({ label: '语音', text: `${p} / ${e.tts?.model || e.tts?.voice || '默认'}`, warn: false })
  }

  if (!e.enabled.video) {
    lines.push({ label: '视频', text: '已停用', warn: false })
  } else {
    const p = String(e.video?.provider || '').trim()
    if (!p || p === 'none') lines.push({ label: '视频', text: '未配置', warn: true })
    else lines.push({ label: '视频', text: `${p} / ${e.video?.resolution || '1080p'} · ${e.video?.fps || 30}fps`, warn: false })
  }

  const theme = String(e.appearance?.theme || 'dark')
  const locale = String(e.appearance?.locale || 'zh-CN')
  lines.push({
    label: '界面偏好',
    text: `主题 ${theme === 'dark' ? '深色' : theme} · 语言 ${locale === 'zh-CN' ? '简体中文' : locale}`,
    warn: false
  })

  return (
    <div className="settings-summary" aria-label="当前生效">
      {lines.map((line) => (
        <div className="settings-summary-line" key={line.label}>
          <span className="settings-summary-label">{line.label}</span>
          <span className={line.warn ? 'settings-summary-warn' : undefined}>{line.text}</span>
        </div>
      ))}
    </div>
  )
}
