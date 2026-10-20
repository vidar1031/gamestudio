// 诊断区（ui_设置定义.md §9.5）：快速检测清单 + 运行日志。本区允许技术语言（成行成组、有标题）。
// 深检语音已上线（2026-10-20：真实合成一句样例）；深检视频保持禁用（随能力版本上线）。
import SectionCard, { TestResultLine } from './SectionCard'
import { IconDiag } from './icons'
import { getRunLogColor, type ServiceTestResult } from './settingsApi'

const SERVICE_LABELS: Record<string, string> = {
  server: '服务',
  scripts: '故事分镜',
  prompt: '图像提示词',
  translation: '提示词翻译',
  review: '审核模型',
  image: '图像服务',
  tts: '语音'
}

export default function DiagnosticsPanel(props: {
  diagBusy: boolean
  deepText: boolean
  deepImages: boolean
  onDeepText: (v: boolean) => void
  onDeepImages: (v: boolean) => void
  onRun: () => void
  deepTtsBusy: boolean
  onDeepTts: () => void
  ttsResult: ServiceTestResult | null
  diagnostics: any
  runLogs: string[]
  onClearLogs: () => void
  defaultOpen?: boolean
}) {
  const services = props.diagnostics && props.diagnostics.services ? (props.diagnostics.services as Record<string, any>) : null
  return (
    <SectionCard
      title="诊断"
      icon={<IconDiag />}
      summary={props.diagBusy ? '检测中…' : props.diagnostics ? `上次检测 ${props.diagnostics.ok ? '通过' : '有异常'}` : '尚未检测'}
      status={props.diagBusy ? 'checking' : props.diagnostics ? (props.diagnostics.ok ? 'ok' : 'error') : 'ok'}
      statusText=""
      enabled={null}
      defaultOpen={props.defaultOpen}
    >
      <div className="settings-subhead">快速检测</div>
      <div style={{ display: 'grid', gap: 8 }}>
        <div className="settings-row" style={{ gridTemplateColumns: '110px 1fr' }}>
          <div className="settings-row-label">浅检</div>
          <div className="hint">连通性 + 配置完整性（全部能力）；零消耗，默认执行。</div>
        </div>
        <div className="settings-row" style={{ gridTemplateColumns: '110px 1fr' }}>
          <div className="settings-row-label">深检文本</div>
          <label className="hint" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <input type="checkbox" style={{ width: 'auto' }} checked={props.deepText} onChange={(e) => props.onDeepText(e.target.checked)} />
            实跑一轮文本生成（预计约 1 分钟）
          </label>
        </div>
        <div className="settings-row" style={{ gridTemplateColumns: '110px 1fr' }}>
          <div className="settings-row-label">深检出图</div>
          <label className="hint" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <input type="checkbox" style={{ width: 'auto' }} checked={props.deepImages} onChange={(e) => props.onDeepImages(e.target.checked)} />
            实跑一张图（消耗本机出图资源；外部 API 出图会产生计费）
          </label>
        </div>
        <div className="settings-row" style={{ gridTemplateColumns: '110px 1fr' }}>
          <div className="settings-row-label">深检语音</div>
          <div style={{ display: 'grid', gap: 8, justifyItems: 'start' }}>
            <div className="settings-row-actions">
              <button className="btn secondary" type="button" onClick={props.onDeepTts} disabled={props.deepTtsBusy}>
                {props.deepTtsBusy ? '合成中…' : '合成一句样例'}
              </button>
              <span className="hint">按语音卡当前配置真实合成（edge 需联网）</span>
            </div>
            <TestResultLine result={props.deepTtsBusy ? null : props.ttsResult} />
          </div>
        </div>
        <div className="settings-row" style={{ gridTemplateColumns: '110px 1fr' }}>
          <div className="settings-row-label">深检视频</div>
          <div className="settings-row-actions">
            <button className="btn secondary" type="button" disabled title="随能力版本上线">
              合成 3 秒样片（随能力版本上线）
            </button>
          </div>
        </div>
        <div>
          <button className="btn" type="button" onClick={props.onRun} disabled={props.diagBusy}>
            {props.diagBusy ? '检测中…' : '运行检测'}
          </button>
        </div>
      </div>

      {services ? (
        <>
          <div className="settings-subhead">检测结果</div>
          <div style={{ display: 'grid', gap: 4 }}>
            {Object.keys(SERVICE_LABELS)
              .filter((k) => services[k])
              .map((k) => {
                const item = services[k]
                const ok = item && item.ok !== false
                return (
                  <div key={k} className="hint" style={{ color: ok ? '#86efac' : '#fca5a5' }}>
                    {SERVICE_LABELS[k]}：{ok ? '正常' : '异常'}
                    {item.provider ? `（${String(item.provider)}${item.model ? ` / ${String(item.model)}` : ''}）` : ''}
                    {item.note ? ` — ${String(item.note)}` : ''}
                  </div>
                )
              })}
          </div>
        </>
      ) : null}

      <div className="settings-subhead">运行日志</div>
      <div className="settings-log">
        {props.runLogs.length ? (
          props.runLogs.map((line, idx) => (
            <div key={`${idx}-${line.slice(0, 24)}`} style={{ color: getRunLogColor(line) }}>
              {line}
            </div>
          ))
        ) : (
          <div style={{ color: 'rgba(148,163,184,0.9)' }}>（暂无日志）</div>
        )}
      </div>
      <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
        <button
          className="btn secondary"
          type="button"
          onClick={() => {
            // §9.5：清空需确认
            if (!props.runLogs.length) return
            if (window.confirm('清空运行日志？')) props.onClearLogs()
          }}
          disabled={props.diagBusy}
        >
          清空
        </button>
      </div>
    </SectionCard>
  )
}
