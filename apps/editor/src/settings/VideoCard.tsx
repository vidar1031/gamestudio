// 视频合成卡（ui_设置定义.md §7.7）：分辨率/帧率/码率/字幕样式/音轨绑定。
// 试跑：视频合成能力未实现，渲染为禁用态（定义先行，随能力版本上线）。
import SectionCard, { type StatusLevel } from './SectionCard'
import { IconVideo } from './icons'
import { normalizeBitrateDraft, normalizeSubtitleStyleDraft, type SettingsHost } from './settingsApi'

export default function VideoCard(props: { host: SettingsHost; defaultOpen?: boolean }) {
  const { host } = props
  const cfg = host.draft.video || {}
  const provider = String(cfg.provider || 'none').toLowerCase()
  const enabled = Boolean(host.draft.enabled?.video)
  const bitrate = normalizeBitrateDraft(cfg.bitrate)
  const subtitle = normalizeSubtitleStyleDraft(cfg.subtitleStyle)
  const audioTrack = cfg.audioTrack === 'none' ? 'none' : 'tts'
  const ttsEnabled = Boolean(host.draft.enabled?.tts)

  let status: StatusLevel = 'ok'
  if (!enabled) status = 'off'
  else if (!provider || provider === 'none') status = 'warn'

  const summary = !enabled
    ? '已停用'
    : !provider || provider === 'none'
      ? '未配置'
      : `${provider} / ${String(cfg.resolution || '1080p')} · ${Number(cfg.fps) === 24 ? 24 : 30}fps`

  return (
    <SectionCard
      title="视频合成"
      icon={<IconVideo />}
      summary={summary}
      status={status}
      enabled={enabled}
      onToggleEnabled={(v) => host.setEnabled('video', v)}
      defaultOpen={props.defaultOpen}
    >
      <div className="hint">预演视频的合成后端——场景帧序列 + 字幕轨 + 配音轨 → 可分享的演示视频文件。合成能力随能力版本上线，这里先行配置。</div>
      <div className="settings-row">
        <div className="settings-row-label">Provider</div>
        <select value={provider} onChange={(e) => host.patchSection('video', { provider: e.target.value })}>
          <option value="none">未配置</option>
          <option value="local">local（本地合成）</option>
          <option value="doubao">doubao（外部 API）</option>
          <option value="openai">openai（外部 API）</option>
        </select>
      </div>
      <div className="settings-row">
        <div className="settings-row-label">分辨率</div>
        <select
          value={String(cfg.resolution || '1080p')}
          onChange={(e) => host.patchSection('video', { resolution: e.target.value })}
        >
          <option value="720p">720p</option>
          <option value="1080p">1080p</option>
          <option value="1080x1920">竖屏 1080×1920</option>
        </select>
      </div>
      <div className="settings-row">
        <div className="settings-row-label">帧率</div>
        <select value={String(Number(cfg.fps) === 24 ? 24 : 30)} onChange={(e) => host.patchSection('video', { fps: Number(e.target.value) })}>
          <option value="24">24 fps</option>
          <option value="30">30 fps</option>
        </select>
      </div>
      <div className="settings-row" style={{ gridTemplateColumns: '110px 1fr 1fr' }}>
        <div className="settings-row-label">码率</div>
        <select
          value={bitrate === 'auto' ? 'auto' : 'manual'}
          onChange={(e) => host.patchSection('video', { bitrate: e.target.value === 'auto' ? 'auto' : 4000 })}
        >
          <option value="auto">自动</option>
          <option value="manual">手动</option>
        </select>
        {bitrate !== 'auto' ? (
          <input
            type="number"
            min={100}
            step={100}
            value={bitrate}
            placeholder="kbps"
            onChange={(e) => {
              const n = Math.round(Number(e.target.value))
              host.patchSection('video', { bitrate: Number.isFinite(n) && n > 0 ? n : 'auto' })
            }}
          />
        ) : (
          <span className="hint" style={{ alignSelf: 'center' }}>按分辨率与帧率自动取值</span>
        )}
      </div>
      <div className="settings-subhead">字幕样式</div>
      <div className="settings-row" style={{ gridTemplateColumns: '110px 1fr 1fr 1fr' }}>
        <div className="settings-row-label">字号/位置</div>
        <input
          type="number"
          min={8}
          max={120}
          value={subtitle.fontSize}
          onChange={(e) => {
            const n = Math.round(Number(e.target.value))
            host.patchSection('video', { subtitleStyle: { ...subtitle, fontSize: Number.isFinite(n) ? n : 24 } })
          }}
        />
        <select
          value={subtitle.position}
          onChange={(e) => host.patchSection('video', { subtitleStyle: { ...subtitle, position: e.target.value } })}
        >
          <option value="bottom">底部</option>
          <option value="top">顶部</option>
        </select>
        <input
          type="number"
          min={0}
          max={1}
          step={0.05}
          value={subtitle.bgOpacity}
          title="底色不透明度（0–1）"
          onChange={(e) => {
            const n = Number(e.target.value)
            host.patchSection('video', { subtitleStyle: { ...subtitle, bgOpacity: Number.isFinite(n) ? n : 0.6 } })
          }}
        />
      </div>
      <div className="hint">字幕样式依次为：字号（px）/ 位置 / 底色不透明度（0–1）。</div>
      <div className="settings-row">
        <div className="settings-row-label">音轨绑定</div>
        <select value={audioTrack} onChange={(e) => host.patchSection('video', { audioTrack: e.target.value })}>
          <option value="tts">语音合成（读取语音卡当前生效值）</option>
          <option value="none">无声</option>
        </select>
      </div>
      {audioTrack === 'tts' && !ttsEnabled ? (
        <div className="hint" style={{ color: '#fbbf24' }}>语音 TTS 未启用，视频将无声合成；可在上方「语音 TTS」卡启用。</div>
      ) : null}
      {provider && provider !== 'none' && provider !== 'local' ? (
        <div className="settings-row">
          <div className="settings-row-label">接口地址</div>
          <input
            value={String(cfg.apiUrl || '')}
            placeholder="外部 API 接口地址"
            onChange={(e) => host.patchSection('video', { apiUrl: e.target.value })}
          />
        </div>
      ) : null}
      <div className="settings-row" style={{ gridTemplateColumns: '110px 1fr' }}>
        <div className="settings-row-label">连通动作</div>
        <div className="settings-row-actions">
          <button className="btn secondary" type="button" disabled title="随能力版本上线">
            试跑（随能力版本上线）
          </button>
        </div>
      </div>
    </SectionCard>
  )
}
