// 调用通道卡（2026-10-21 用户裁决：直连 / 代理（守护台）二选一开关段，不叫"守护台关联"）。
// 直连：本机直连本地模型，无调度互斥；代理（守护台）：统一调度本机重负载算力，守护台离线即阻断以保护内存。
// env STUDIO_RESOURCE_LEASE_ENABLED 显式设定时优先于本选择。
import { useEffect, useState } from 'react'
import SectionCard, { TestResultLine, type StatusLevel } from './SectionCard'
import { IconLink } from './icons'
import { getControlLink, type SettingsHost, type StudioControlLink } from './settingsApi'

export default function ControlLinkCard(props: { host: SettingsHost; defaultOpen?: boolean }) {
  const { host } = props
  const cfg = host.draft.control || {}
  // 通道取值：proxy=代理（守护台调度，leaseEnabled=true）/ direct=直连（leaseEnabled=false）
  const mode: 'proxy' | 'direct' = cfg.leaseEnabled === false ? 'direct' : 'proxy'
  const [link, setLink] = useState<StudioControlLink | null>(null)
  const [busy, setBusy] = useState(false)

  async function probe(recordResult: boolean) {
    if (busy) return
    setBusy(true)
    const startedAt = Date.now()
    try {
      const res = await getControlLink()
      setLink(res)
      if (recordResult) {
        const elapsed = Date.now() - startedAt
        host.recordServiceTestResult('control', res.reachable
          ? { ok: true, note: `守护台在线 · 响应 ${res.latencyMs || elapsed}ms`, at: Date.now() }
          : { ok: false, note: `守护台不可达（${res.baseUrl}）；建议：启动守护台（local-agent-control），或切换到直连`, at: Date.now() })
        host.appendLog(`调用通道测试：reachable=${res.reachable ? 'true' : 'false'} baseUrl=${res.baseUrl} latencyMs=${res.latencyMs}`)
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      if (recordResult) {
        host.recordServiceTestResult('control', { ok: false, note: `测试失败：${msg}；建议：检查守护台地址或切换到直连`, at: Date.now() })
        host.appendLog(`调用通道测试失败：${msg}`)
      }
    } finally {
      setBusy(false)
    }
  }

  useEffect(() => {
    void probe(false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const testRes = busy ? null : host.serviceTestResults['control'] || null

  let status: StatusLevel = 'ok'
  let statusText = ''
  if (busy) status = 'checking'
  else if (mode === 'direct') statusText = '直连'
  else if (link && !link.reachable) {
    status = 'error'
    statusText = '守护台离线'
  }

  const summary =
    mode === 'direct'
      ? '直连（本地模型）'
      : link
        ? `代理（守护台）· ${link.reachable ? '在线' : '离线'}`
        : '检测中…'

  return (
    <SectionCard
      title="调用通道"
      icon={<IconLink />}
      summary={summary}
      status={status}
      statusText={statusText}
      enabled={null}
      defaultOpen={props.defaultOpen}
    >
      <div className="hint">
        生成类调用（文本模型 / 出图 / 视觉评审）走哪条通道：<b>直连</b>=本机直连本地模型，无调度互斥；<b>代理（守护台）</b>=守护台统一调度本机重负载，守护台离线即阻断以保护内存。保存后即时生效，无需重启。
      </div>
      <div className="settings-row" style={{ gridTemplateColumns: '110px 1fr' }}>
        <div className="settings-row-label">通道</div>
        <div className="settings-seg" role="radiogroup" aria-label="调用通道">
          <button
            type="button"
            role="radio"
            aria-checked={mode === 'direct'}
            className={`settings-seg-btn${mode === 'direct' ? ' is-on' : ''}`}
            onClick={() => host.patchSection('control', { leaseEnabled: false })}
          >
            直连
          </button>
          <button
            type="button"
            role="radio"
            aria-checked={mode === 'proxy'}
            className={`settings-seg-btn${mode === 'proxy' ? ' is-on' : ''}`}
            onClick={() => host.patchSection('control', { leaseEnabled: true })}
          >
            代理（守护台）
          </button>
        </div>
      </div>
      {mode === 'proxy' ? (
        <div className="settings-row">
          <div className="settings-row-label">守护台地址</div>
          <input
            value={String(cfg.baseUrl || '')}
            placeholder="http://127.0.0.1:2099"
            onChange={(e) => host.patchSection('control', { baseUrl: e.target.value })}
            autoComplete="off"
            spellCheck={false}
          />
        </div>
      ) : null}
      {link?.envOverride ? (
        <div className="hint" style={{ color: '#fbbf24' }}>环境变量 STUDIO_RESOURCE_LEASE_ENABLED 已显式设定，通道以环境变量为准。</div>
      ) : null}
      {mode === 'proxy' ? (
        <div className="settings-row" style={{ gridTemplateColumns: '110px 1fr auto' }}>
          <div className="settings-row-label">连通动作</div>
          <div className="hint" style={{ alignSelf: 'center' }}>
            {link ? `当前：${link.reachable ? '在线' : '离线'} · ${link.baseUrl}` : '读取中…'}
          </div>
          <button className="btn secondary" type="button" onClick={() => void probe(true)} disabled={busy}>
            {busy ? '检测中…' : '测试连接'}
          </button>
        </div>
      ) : null}
      <TestResultLine result={testRes} />
    </SectionCard>
  )
}
