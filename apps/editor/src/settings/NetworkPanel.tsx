// 网络区（ui_设置定义.md §9.4）：proxyUrl，留空 = 直连。
import SectionCard from './SectionCard'
import { IconNetwork } from './icons'
import type { SettingsHost } from './settingsApi'

export default function NetworkPanel(props: { host: SettingsHost; defaultOpen?: boolean }) {
  const { host } = props
  const proxyUrl = String(host.draft.network?.proxyUrl || '')
  return (
    <SectionCard
      title="网络代理"
      icon={<IconNetwork />}
      summary={proxyUrl || '直连'}
      status="ok"
      statusText=""
      enabled={null}
      defaultOpen={props.defaultOpen}
    >
      <div className="settings-row">
        <div className="settings-row-label">代理地址</div>
        <input
          value={proxyUrl}
          placeholder="http://127.0.0.1:7897"
          onChange={(e) => host.patchSection('network', { proxyUrl: e.target.value.trim() })}
          autoComplete="off"
          spellCheck={false}
        />
      </div>
      <div className="hint">用于 OpenAI / 其他需要代理的文本请求。留空表示直连；常见本地代理示例：http://127.0.0.1:7897。</div>
    </SectionCard>
  )
}
