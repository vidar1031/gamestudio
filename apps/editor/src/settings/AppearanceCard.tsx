// 界面偏好卡（ui_设置定义.md §9.1）：主题与语言。
// 切换即写入 appearance 节并应用到 document.documentElement.dataset.theme（零重渲染）；
// 主题包/语言包当前各一档（dark / zh-CN），新增档位随《设计令牌与主题扩展规范》落地。
import SectionCard from './SectionCard'
import { IconPalette } from './icons'
import type { SettingsHost } from './settingsApi'

export default function AppearanceCard(props: { host: SettingsHost; defaultOpen?: boolean }) {
  const { host } = props
  const cfg = host.draft.appearance || {}
  const theme = String(cfg.theme || 'dark')
  const locale = String(cfg.locale || 'zh-CN')

  return (
    <SectionCard
      title="主题与语言"
      icon={<IconPalette />}
      summary={`${theme === 'dark' ? '深色' : theme} · ${locale === 'zh-CN' ? '简体中文' : locale}`}
      status="ok"
      enabled={null}
      defaultOpen={props.defaultOpen}
    >
      <div className="settings-row">
        <div className="settings-row-label">主题</div>
        <select
          value={theme}
          onChange={(e) => {
            const next = { theme: e.target.value, locale }
            host.patchSection('appearance', next)
            host.applyAppearance(next)
          }}
        >
          <option value="dark">深色</option>
        </select>
      </div>
      <div className="settings-row">
        <div className="settings-row-label">语言</div>
        <select
          value={locale}
          onChange={(e) => {
            const next = { theme, locale: e.target.value }
            host.patchSection('appearance', next)
            host.applyAppearance(next)
          }}
        >
          <option value="zh-CN">简体中文</option>
        </select>
      </div>
      <div className="hint">切换即时生效并计入待保存修改，点页首「保存并应用」后写入配置。</div>
    </SectionCard>
  )
}
