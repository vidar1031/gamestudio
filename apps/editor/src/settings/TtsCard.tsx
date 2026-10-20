// 语音 TTS 卡（ui_设置定义.md §7.6，2026-10-20 落地）：provider/音色/语速/格式/接口地址 + 试听。
// edge（免费·联网·推荐）与 say（本机内置·离线）真实合成；doubao 未接入诚实报错；openai/local 走 /audio/speech。
import { useEffect, useState } from 'react'
import SectionCard, { TestResultLine, type StatusLevel } from './SectionCard'
import { IconVoice } from './icons'
import { clampTtsSpeed, getTtsVoices, previewTts, type SettingsHost, type TtsVoiceGroup } from './settingsApi'

const TTS_PROVIDERS: { value: string; label: string }[] = [
  { value: '', label: '未配置' },
  { value: 'edge', label: 'edge（免费·联网·推荐）' },
  { value: 'say', label: 'say（本机内置·离线）' },
  { value: 'doubao', label: 'doubao（外部 API·未接入）' },
  { value: 'openai', label: 'openai（外部 API）' },
  { value: 'local', label: 'local（自定义接口）' }
]

const PREVIEW_TEXT = '小猫去河边钓鱼'

export default function TtsCard(props: { host: SettingsHost; defaultOpen?: boolean }) {
  const { host } = props
  const cfg = host.draft.tts || {}
  const provider = String(cfg.provider || '').toLowerCase()
  const enabled = Boolean(host.draft.enabled?.tts)
  const [voiceGroups, setVoiceGroups] = useState<TtsVoiceGroup[]>([])
  const [voicesErr, setVoicesErr] = useState('')
  const [previewBusy, setPreviewBusy] = useState(false)

  useEffect(() => {
    let alive = true
    if (!provider || provider === 'none') {
      setVoiceGroups([])
      setVoicesErr('')
      return
    }
    getTtsVoices(provider)
      .then((list) => {
        if (alive) {
          setVoiceGroups(list)
          setVoicesErr('')
        }
      })
      .catch((e) => {
        if (alive) {
          setVoiceGroups([])
          setVoicesErr(e instanceof Error ? e.message : String(e))
        }
      })
    return () => {
      alive = false
    }
  }, [provider])

  const voiceItems = voiceGroups.flatMap((g) => g.items)
  const voice = String(cfg.voice || '')

  // 音色清单加载后，当前为空时回填首个预设（角色音色库 id）
  useEffect(() => {
    if (voiceItems.length && !voice.trim()) {
      host.patchSection('tts', { voice: voiceItems[0].id })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [voiceGroups])

  // 当前值兼容：预设 id 或裸引擎音名都能归一到中文名；自定义音名走手输
  const matchedPreset = voiceItems.find((x) => x.id === voice) || voiceItems.find((x) => x.engineVoice.toLowerCase() === voice.toLowerCase())
  const voiceLabel = matchedPreset ? matchedPreset.label : voice

  const wavSupported = provider === 'openai' || provider === 'local'
  const testRes = previewBusy ? null : host.serviceTestResults['tts'] || null

  let status: StatusLevel = 'ok'
  if (!enabled) status = 'off'
  else if (previewBusy) status = 'checking'
  else if (!provider || provider === 'none') status = 'warn'
  else if (testRes && !testRes.ok) status = 'error'

  const summary = !enabled
    ? '已停用'
    : !provider || provider === 'none'
      ? '未配置'
      : `${provider} / ${voiceLabel || '默认音色'}`

  const showVoiceSelect = voiceGroups.length > 0

  async function onPreview() {
    if (previewBusy) return
    setPreviewBusy(true)
    const startedAt = Date.now()
    host.appendLog(`开始语音试听：provider=${provider} voice=${voice || '(默认)'}`)
    try {
      const res = await previewTts({
        settings: host.buildSettingsWithSecrets(),
        text: PREVIEW_TEXT,
        voice: voice || undefined,
        speed: typeof cfg.speed === 'number' ? cfg.speed : 1.0,
        format: cfg.format === 'wav' && wavSupported ? 'wav' : 'mp3'
      })
      const elapsed = Date.now() - startedAt
      host.recordServiceTestResult('tts', {
        ok: true,
        note: `试听成功 · ${res.provider} / ${res.voice || '默认音色'} · ${(res.bytes / 1024).toFixed(1)}KB · 耗时 ${(elapsed / 1000).toFixed(1)}s`,
        at: Date.now()
      })
      host.appendLog(`语音试听成功：provider=${res.provider} voice=${res.voice || '-'} bytes=${res.bytes} elapsedMs=${elapsed}`)
      const url = URL.createObjectURL(res.blob)
      const audio = new Audio(url)
      const release = () => URL.revokeObjectURL(url)
      audio.onended = release
      audio.onerror = release
      void audio.play().catch(() => {})
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      host.recordServiceTestResult('tts', {
        ok: false,
        note: `试听失败：${msg}；建议：edge 引擎需联网，离线环境请改用 say；openai 请核对接口 Key`,
        at: Date.now()
      })
      host.appendLog(`语音试听失败：${msg}`)
    } finally {
      setPreviewBusy(false)
    }
  }

  return (
    <SectionCard
      title="语音 TTS"
      icon={<IconVoice />}
      summary={summary}
      status={status}
      enabled={enabled}
      onToggleEnabled={(v) => host.setEnabled('tts', v)}
      defaultOpen={props.defaultOpen}
    >
      <div className="hint">语音合成能力——角色配音、旁白朗读、预演视频音轨的来源。edge 走微软免费通道（需联网）；say 为本机内置引擎（离线可用）。</div>
      <div className="settings-row">
        <div className="settings-row-label">Provider</div>
        <select
          value={provider}
          onChange={(e) => {
            const next = e.target.value
            host.patchSection('tts', { provider: next })
          }}
        >
          {TTS_PROVIDERS.map((p) => (
            <option key={p.value} value={p.value}>
              {p.label}
            </option>
          ))}
        </select>
      </div>
      {provider === 'doubao' ? <div className="hint" style={{ color: '#fbbf24' }}>Doubao 语音合成暂未接入，试听会返回失败；请改用 edge 或 say。</div> : null}
      {voicesErr ? (
        <div className="hint" style={{ color: '#fca5a5' }}>音色清单加载失败:{voicesErr}。请重启业务后端（运行中的旧版本没有语音接口）。</div>
      ) : null}
      {provider && provider !== 'none' ? (
        <>
          {provider === 'openai' || provider === 'local' ? (
            <div className="settings-row">
              <div className="settings-row-label">模型</div>
              <input
                value={String(cfg.model || '')}
                placeholder={provider === 'openai' ? 'tts-1（可留空）' : '按接口服务要求填写'}
                onChange={(e) => host.patchSection('tts', { model: e.target.value })}
              />
            </div>
          ) : null}
          <div className="settings-row" style={{ gridTemplateColumns: '110px 1fr' }}>
            <div className="settings-row-label">音色</div>
            {showVoiceSelect ? (
              <div style={{ display: 'grid', gap: 8 }}>
                <select
                  value={matchedPreset ? matchedPreset.id : '__custom__'}
                  onChange={(e) => {
                    if (e.target.value === '__custom__') return
                    host.patchSection('tts', { voice: e.target.value })
                  }}
                >
                  {voiceGroups.map((g) => (
                    <optgroup key={g.group} label={g.group}>
                      {g.items.map((x) => (
                        <option key={x.id} value={x.id} title={x.engineVoice}>
                          {x.label}
                        </option>
                      ))}
                    </optgroup>
                  ))}
                  <option value="__custom__">自定义（手动输入）</option>
                </select>
                {!matchedPreset ? (
                  <input
                    value={voice}
                    placeholder="引擎音名，如 zh-CN-XiaoxiaoNeural"
                    onChange={(e) => host.patchSection('tts', { voice: e.target.value })}
                  />
                ) : null}
                {matchedPreset && (matchedPreset.pitch || matchedPreset.rateAdjust) ? (
                  <div className="hint">
                    派生微调：音高 {matchedPreset.pitch! >= 0 ? '+' : ''}
                    {matchedPreset.pitch}Hz，语速 {matchedPreset.rateAdjust! >= 0 ? '+' : ''}
                    {matchedPreset.rateAdjust}%
                  </div>
                ) : null}
              </div>
            ) : (
              <input
                value={voice}
                placeholder="音色标识（可留空用默认）"
                onChange={(e) => host.patchSection('tts', { voice: e.target.value })}
              />
            )}
          </div>
          <div className="settings-row" style={{ gridTemplateColumns: '110px 1fr auto' }}>
            <div className="settings-row-label">语速</div>
            <input
              type="range"
              min={0.5}
              max={2.0}
              step={0.05}
              value={typeof cfg.speed === 'number' ? cfg.speed : 1.0}
              onChange={(e) => host.patchSection('tts', { speed: clampTtsSpeed(e.target.value, 1.0) })}
            />
            <span className="hint" style={{ minWidth: 32, textAlign: 'right' }}>
              ×{(typeof cfg.speed === 'number' ? cfg.speed : 1.0).toFixed(2)}
            </span>
          </div>
          <div className="settings-row">
            <div className="settings-row-label">格式</div>
            <div style={{ display: 'grid', gap: 4 }}>
              <select
                value={cfg.format === 'wav' ? 'wav' : 'mp3'}
                onChange={(e) => host.patchSection('tts', { format: e.target.value })}
              >
                <option value="mp3">mp3</option>
                <option value="wav" disabled={!wavSupported}>
                  wav{wavSupported ? '' : '（当前引擎不支持）'}
                </option>
              </select>
              {cfg.format === 'wav' && !wavSupported ? (
                <div className="hint" style={{ color: '#fbbf24' }}>edge / say 引擎仅输出压缩音频；wav 请改用 openai / local。</div>
              ) : null}
            </div>
          </div>
          {provider === 'openai' || provider === 'local' ? (
            <div className="settings-row">
              <div className="settings-row-label">接口地址</div>
              <input
                value={String(cfg.apiUrl || '')}
                placeholder={provider === 'openai' ? 'https://api.openai.com/v1（可留空）' : '如 http://127.0.0.1:8080/v1'}
                onChange={(e) => host.patchSection('tts', { apiUrl: e.target.value })}
              />
            </div>
          ) : null}
          <div className="settings-row" style={{ gridTemplateColumns: '110px 1fr auto' }}>
            <div className="settings-row-label">连通动作</div>
            <div className="hint" style={{ alignSelf: 'center' }}>
              合成一句样例「{PREVIEW_TEXT}」即时播放；edge 需联网，say 离线可用。
            </div>
            <button className="btn secondary" type="button" onClick={() => void onPreview()} disabled={previewBusy || !enabled}>
              {previewBusy ? '合成中…' : '试听'}
            </button>
          </div>
        </>
      ) : null}
      <TestResultLine result={testRes} />
    </SectionCard>
  )
}
