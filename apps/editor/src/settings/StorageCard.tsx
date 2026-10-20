// 存储卡（ui_设置定义.md §9.2）：存储根路径展示与编辑。
// root 可空 = 默认仓内 storage/；改后重启生效（运行时根以服务端 STUDIO_STORAGE_ROOT 为准）。
import SectionCard from './SectionCard'
import { IconStorage } from './icons'
import type { SettingsHost } from './settingsApi'

export default function StorageCard(props: { host: SettingsHost; defaultOpen?: boolean }) {
  const { host } = props
  const info = host.storageInfo
  const rootDraft = String(host.draft.storage?.root || '')

  return (
    <SectionCard
      title="存储"
      icon={<IconStorage />}
      summary={info ? info.root : '载入中…'}
      status={info ? (info.writable ? 'ok' : 'error') : 'checking'}
      statusText={info ? (info.writable ? '可写' : '不可写') : '检测中'}
      enabled={null}
      defaultOpen={props.defaultOpen}
    >
      <div className="settings-row">
        <div className="settings-row-label">当前存储根</div>
        <div className="hint" style={{ wordBreak: 'break-all' }}>
          {info ? `${info.root}（${info.writable ? '可写' : '不可写'}）` : '载入中…'}
        </div>
      </div>
      <div className="settings-row">
        <div className="settings-row-label">存储根路径</div>
        <input
          value={rootDraft}
          placeholder="留空 = 仓内 storage/"
          onChange={(e) => host.patchSection('storage', { root: e.target.value })}
          autoComplete="off"
          spellCheck={false}
        />
      </div>
      <div className="hint">可改为外部目录；改后重启生效，重启时会做写权限自检。</div>
    </SectionCard>
  )
}
