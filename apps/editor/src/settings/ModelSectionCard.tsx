// 文本族三卡共用（ui_设置定义.md §7.1/§7.2/§7.3）：故事分镜 / 图像提示词 / 提示词翻译。
// Provider 切换、模型记忆、URL 记忆、测试连接逻辑移植自 StudioSettingsModal（已验证行为原样保留）。
// 提示词翻译支持「跟随图像提示词」（provider 留空，§8 翻译跟随）；translation 无独立总开关（§6 enabled 不含 translation）。
import { useRef } from 'react'
import SectionCard, { TestResultLine, type StatusLevel } from './SectionCard'
import { IconScript, IconPrompt, IconTranslate } from './icons'
import {
  OPENAI_MODEL_PRESETS,
  defaultModelBySectionProvider,
  defaultTextProviderApiUrl,
  getOllamaModelOptions,
  getRememberedModelList,
  getRememberedModelValue,
  isLikelyInvalidOpenAIModel,
  isOpenAIPresetModel,
  providerKey,
  textProviderModelPlaceholder,
  textProviderUrlMeta,
  type SettingsHost,
  type TextSection
} from './settingsApi'

function OllamaModelEditor(props: {
  section: TextSection
  provider: string | null | undefined
  model: string | null | undefined
  host: SettingsHost
  onChange: (next: string) => void
}) {
  const { host, section, provider } = props
  const suppressModelRememberRef = useRef(false)
  const remembered = getRememberedModelList(host.modelMemory, section, provider)
  const current = String(props.model || '')
  const options = getOllamaModelOptions(host.modelMemory, section, provider, current)
  return (
    <div style={{ display: 'grid', gap: 8 }}>
      <select
        value={options.includes(current) ? current : '__custom__'}
        onChange={(e) => {
          const next = e.target.value === '__custom__' ? current : e.target.value
          props.onChange(next)
          if (e.target.value !== '__custom__') host.rememberModel(section, provider || '', next)
        }}
      >
        {options.map((m) => (
          <option key={m} value={m}>{m}</option>
        ))}
        <option value="__custom__">自定义（手动输入）</option>
      </select>
      <input
        value={current}
        placeholder={textProviderModelPlaceholder(provider)}
        onChange={(e) => props.onChange(e.target.value)}
        onBlur={(e) => {
          if (suppressModelRememberRef.current) {
            suppressModelRememberRef.current = false
            return
          }
          host.rememberModel(section, provider || '', e.target.value)
        }}
      />
      {remembered.length ? (
        <div style={{ display: 'grid', gap: 8 }}>
          <div className="hint">历史模型</div>
          <div className="settings-chip-list">
            {remembered.map((item) => (
              <span key={item} className="settings-chip">
                <button
                  type="button"
                  onMouseDown={(e) => {
                    suppressModelRememberRef.current = true
                    e.preventDefault()
                  }}
                  onClick={() => props.onChange(item)}
                >
                  {item}
                </button>
                <button
                  type="button"
                  className="settings-chip-del"
                  onMouseDown={(e) => {
                    suppressModelRememberRef.current = true
                    e.preventDefault()
                  }}
                  onClick={() => {
                    host.forgetModel(section, provider || '', item)
                    if (current === item) props.onChange('')
                  }}
                  aria-label={`删除模型 ${item}`}
                  title={`删除模型 ${item}`}
                >
                  删除
                </button>
              </span>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  )
}

export default function ModelSectionCard(props: {
  section: TextSection
  title: string
  hint?: string
  host: SettingsHost
  defaultOpen?: boolean
}) {
  const { host, section } = props
  const cfg = host.draft[section] || {}
  const provider = String(cfg.provider || '')
  const followable = section === 'translation'
  // translation 无 enabled 总开关（§6），其余两卡开关对应 enabled.<key>
  const enabled = followable ? null : Boolean(host.draft.enabled?.[section as 'scripts' | 'prompt'])
  const testing = host.testingService === section

  let status: StatusLevel = 'ok'
  let statusText = ''
  // 任务A：状态灯失败态取自内联测试结果（每次测试都记录），不再只依赖诊断区快照
  const testRes = testing ? null : host.serviceTestResults[section] || null
  if (testing) {
    status = 'checking'
  } else if (enabled === false) {
    status = 'off'
  } else if (followable && !provider) {
    const promptProvider = String(host.draft.prompt?.provider || '').toLowerCase()
    const promptReady = Boolean(promptProvider && promptProvider !== 'none')
    status = promptReady ? 'ok' : 'warn'
    statusText = promptReady ? '跟随图像提示词' : '未配置'
  } else if (!provider || provider === 'none') {
    status = 'warn'
  } else if (testRes && !testRes.ok) {
    status = 'error'
    statusText = '不可用'
  }

  const summary =
    enabled === false
      ? '已停用'
      : followable && !provider
        ? '跟随图像提示词'
        : !provider || provider === 'none'
          ? '未配置'
          : `${provider} / ${String(cfg.model || '') || '默认模型'}`

  function onProviderChange(nextProvider: string) {
    host.rememberModel(section, provider, String(cfg.model || ''))
    host.rememberUrl(section, provider, String(cfg.apiUrl || ''))
    if (followable && !nextProvider) {
      // 跟随图像提示词：清空本组配置，服务端按 prompt 组取值（§8）
      host.patchSection(section, { provider: '', model: '', apiUrl: '' })
      return
    }
    const recalled = getRememberedModelValue(host.modelMemory, section, nextProvider)
    const nextModel = recalled || defaultModelBySectionProvider(section, nextProvider, host.effective)
    const recalledUrl = (host.urlMemory[section] || {})[providerKey(nextProvider)] || ''
    const nextApiUrl = recalledUrl || defaultTextProviderApiUrl(nextProvider)
    host.patchSection(section, { provider: nextProvider, model: nextModel, apiUrl: nextApiUrl })
  }

  const urlMeta = textProviderUrlMeta(provider)
  const patchModel = (next: string) => host.patchSection(section, { model: next })
  const bodyDisabled = enabled === false

  return (
    <SectionCard
      title={props.title}
      icon={section === 'scripts' ? <IconScript /> : section === 'prompt' ? <IconPrompt /> : <IconTranslate />}
      summary={summary}
      status={status}
      statusText={statusText}
      enabled={enabled}
      onToggleEnabled={followable ? undefined : (v) => host.setEnabled(section as 'scripts' | 'prompt', v)}
      defaultOpen={props.defaultOpen}
    >
      {props.hint ? <div className="hint">{props.hint}</div> : null}
      <div className="settings-row">
        <div className="settings-row-label">Provider</div>
        <select value={provider} onChange={(e) => onProviderChange(e.target.value)}>
          {followable ? <option value="">跟随图像提示词</option> : null}
          <option value="none">{followable ? '停用' : '未配置'}</option>
          <option value="localoxml">localoxml</option>
          <option value="openai">openai</option>
          <option value="doubao">doubao</option>
          <option value="ollama">ollama</option>
        </select>
      </div>
      {followable && !provider ? (
        <div className="settings-row" style={{ gridTemplateColumns: '110px 1fr auto' }}>
          <div className="settings-row-label">连通动作</div>
          <div className="hint" style={{ alignSelf: 'center' }}>按图像提示词的当前值测试</div>
          <button
            className="btn secondary"
            type="button"
            onClick={() => host.runServiceDiagnose(section)}
            disabled={Boolean(host.testingService)}
          >
            {testing ? '检测中…' : '测试连接'}
          </button>
        </div>
      ) : (
        <div className="settings-row" style={{ gridTemplateColumns: '110px 1fr auto' }}>
          <div className="settings-row-label">模型</div>
          {provider === 'ollama' ? (
            <OllamaModelEditor section={section} provider={provider} model={cfg.model} host={host} onChange={patchModel} />
          ) : provider === 'openai' ? (
            <div style={{ display: 'grid', gap: 8 }}>
              <select
                value={isOpenAIPresetModel(cfg.model) ? String(cfg.model || '') : '__custom__'}
                onChange={(e) => {
                  const next = e.target.value === '__custom__' ? String(cfg.model || '') : e.target.value
                  patchModel(next)
                  host.rememberModel(section, provider, next)
                }}
              >
                {OPENAI_MODEL_PRESETS.map((m) => (
                  <option key={m} value={m}>{m}</option>
                ))}
                <option value="__custom__">自定义（手动输入）</option>
              </select>
              {!isOpenAIPresetModel(cfg.model) ? (
                <input
                  value={String(cfg.model || '')}
                  placeholder={textProviderModelPlaceholder(provider)}
                  onChange={(e) => {
                    patchModel(e.target.value)
                    host.rememberModel(section, provider, e.target.value)
                  }}
                />
              ) : null}
              {isLikelyInvalidOpenAIModel(cfg.model) ? (
                <div className="hint" style={{ color: '#fca5a5' }}>
                  当前 OpenAI 模型名看起来无效。请改用 `gpt-5`、`gpt-5-mini`、`gpt-5-nano` 或 `gpt-4o-mini`。
                </div>
              ) : null}
            </div>
          ) : (
            <input
              value={String(cfg.model || '')}
              placeholder={textProviderModelPlaceholder(provider)}
              onChange={(e) => {
                patchModel(e.target.value)
                host.rememberModel(section, provider, e.target.value)
              }}
            />
          )}
          <button
            className="btn secondary"
            type="button"
            onClick={() => host.runServiceDiagnose(section)}
            disabled={bodyDisabled || Boolean(host.testingService)}
          >
            {testing ? '检测中…' : '测试连接'}
          </button>
        </div>
      )}
      {urlMeta ? (
        <div className="settings-row">
          <div className="settings-row-label">{urlMeta.label}</div>
          <input
            value={String(cfg.apiUrl || '')}
            placeholder={urlMeta.placeholder}
            onChange={(e) => {
              host.patchSection(section, { apiUrl: e.target.value })
              host.rememberUrl(section, provider, e.target.value)
            }}
          />
        </div>
      ) : null}
      <TestResultLine result={testRes} />
    </SectionCard>
  )
}
