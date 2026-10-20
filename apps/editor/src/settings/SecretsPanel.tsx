// 接口 Key 区（ui_设置定义.md §9.3）：按服务商分组，显示掩码/来源标注/显示明文/清空/自动保存。
// 行为移植自 StudioSettingsModal（已验证：离开字段自动保存、刷新不丢已保存 Key）；
// 纪律：Key 只写服务端配置，不进入前端缓存与任何日志。
import SectionCard from './SectionCard'
import { IconKey } from './icons'
import type { StudioEffectiveConfig } from './settingsApi'
import { SECRET_LABELS, hasDirtySecrets, type SecretDirtyState, type SecretDraft, type SecretField } from './settingsApi'

type ShowKey = 'openai' | 'localoxml' | 'doubao'

const ROWS: { field: SecretField; showKey: ShowKey; label: string; placeholder: string }[] = [
  { field: 'doubaoArkApiKey', showKey: 'doubao', label: 'Doubao', placeholder: 'DOUBAO_ARK_API_KEY' },
  { field: 'openaiApiKey', showKey: 'openai', label: 'OpenAI', placeholder: 'OPENAI_API_KEY' },
  { field: 'localoxmlApiKey', showKey: 'localoxml', label: 'localoxml', placeholder: 'LOCALOXML_API_KEY' }
]

export default function SecretsPanel(props: {
  effective: StudioEffectiveConfig | null
  secretDraft: SecretDraft
  secretDirty: SecretDirtyState
  secretAutoSaveBusy: boolean
  secretSaveNote: string
  secretSaveOk: boolean | null
  showSecret: Record<ShowKey, boolean>
  onEdit: (field: SecretField, value: string, cleared?: boolean) => void
  onToggleShow: (key: ShowKey) => void
  onSaveNow: () => void
  defaultOpen?: boolean
}) {
  const configuredCount = ROWS.filter((r) => props.effective?.secrets?.[r.showKey]?.present).length
  return (
    <SectionCard
      title="接口 Key"
      icon={<IconKey />}
      summary={props.effective ? `已配置 ${configuredCount} / ${ROWS.length}` : '载入中…'}
      status={props.effective ? 'ok' : 'checking'}
      statusText=""
      enabled={null}
      defaultOpen={props.defaultOpen}
    >
      {ROWS.map((row) => {
        const eff = props.effective?.secrets?.[row.showKey]
        return (
          <div key={row.field} style={{ display: 'grid', gap: 8 }}>
            <div className="hint">
              {row.label}：
              {eff?.present ? `${String(eff.masked || '(已设置)')}（来源：${String(eff.source || '-')}）` : '未设置'}
            </div>
            <div className="settings-row-actions">
              <input
                type={props.showSecret[row.showKey] ? 'text' : 'password'}
                value={props.secretDraft[row.field]}
                placeholder={row.placeholder}
                onChange={(e) => props.onEdit(row.field, e.target.value)}
                onPaste={(e) => {
                  e.preventDefault()
                  props.onEdit(row.field, e.clipboardData.getData('text'))
                }}
                autoComplete="off"
                spellCheck={false}
                style={{ flex: 1, minWidth: 260 }}
              />
              <button className="btn secondary" type="button" onClick={() => props.onToggleShow(row.showKey)}>
                {props.showSecret[row.showKey] ? '隐藏' : '显示'}
              </button>
              <button className="btn secondary" type="button" onClick={() => props.onEdit(row.field, '', true)}>
                清空
              </button>
            </div>
          </div>
        )
      })}

      <div className="settings-row-actions">
        <button
          className="btn secondary"
          type="button"
          onClick={props.onSaveNow}
          disabled={props.secretAutoSaveBusy || !hasDirtySecrets(props.secretDirty)}
        >
          {props.secretAutoSaveBusy ? '保存中…' : '立即保存 Key'}
        </button>
        <span
          className="hint"
          style={{ color: props.secretSaveOk === false ? '#fca5a5' : props.secretSaveOk === true ? '#86efac' : 'rgba(226,232,240,0.72)' }}
        >
          {props.secretSaveNote}
        </span>
      </div>

      <div className="hint">
        Key 会写入 server 侧 storage/_config/studio_settings.json。修改后自动保存；刷新页面不会丢失已保存的 Key。
      </div>
    </SectionCard>
  )
}
