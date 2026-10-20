// 守护台关联卡（2026-10-20）：租约运行时开关（control.leaseEnabled）+ 守护台地址 + 连通测试。
// 语义：开启=托管模式（守护台统一调度本机重负载算力，守护台离线即阻断以保护内存）；
// 关闭=独立模式（直连本地模型，无互斥保护）。env STUDIO_RESOURCE_LEASE_ENABLED 显式设定时优先于本开关。
import { useEffect, useState } from 'react'
import SectionCard, { TestResultLine, type StatusLevel } from './SectionCard'
import { IconLink } from './icons'
import { getControlLink, type SettingsHost, type StudioControlLink } from './settingsApi'

export default function ControlLinkCard(props: { host: SettingsHost; defaultOpen?: boolean }) {
  const { host } = props
  const cfg = host.draft.control || {}
  const leaseEnabled = cfg.leaseEnabled !== false
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
          : { ok: false, note: `守护台不可达（${res.baseUrl}）；建议：请启动守护台（local-agent-control）或关闭关联`, at: Date.now() })
        host.appendLog(`守护台关联测试：reachable=${res.reachable ? 'true' : 'false'} baseUrl=${res.baseUrl} latencyMs=${res.latencyMs}`)
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      if (recordResult) {
        host.recordServiceTestResult('control', { ok: false, note: `测试失败：${msg}；建议：请启动守护台（local-agent-control）或关闭关联`, at: Date.now() })
        host.appendLog(`守护台关联测试失败：${msg}`)
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
  else if (!leaseEnabled) status = 'off'
  else if (testRes && !testRes.ok) {
    status = 'error'
    statusText = '守护台离线'
  } else if (link && !link.reachable) {
    status = 'error'
    statusText = '守护台离线'
  }

  const summary = !leaseEnabled
    ? '独立模式（租约已关）'
    : link
      ? `${link.reachable ? '托管模式 · 守护台在线' : '托管模式 · 守护台离线'} · ${link.baseUrl}`
      : '检测中…'

  return (
    <SectionCard
      title="守护台关联"
      icon={<IconLink />}
      summary={summary}
      status={status}
      statusText={status === 'off' ? '独立模式' : statusText}
      enabled={leaseEnabled}
      onToggleEnabled={(v) => host.patchSection('control', { leaseEnabled: v })}
      defaultOpen={props.defaultOpen}
    >
      <div className="hint">
        开启 = 托管模式：守护台统一调度本机重负载算力（文本模型 / 出图 / 视觉评审互斥），守护台离线即阻断以保护内存；
        关闭 = 独立模式：直连本地模型，无互斥保护。保存后即时生效，无需重启。
      </div>
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
      {link?.envOverride ? (
        <div className="hint" style={{ color: '#fbbf24' }}>环境变量 STUDIO_RESOURCE_LEASE_ENABLED 已显式设定，开关以环境变量为准。</div>
      ) : null}
      <div className="settings-row" style={{ gridTemplateColumns: '110px 1fr auto' }}>
        <div className="settings-row-label">连通动作</div>
        <div className="hint" style={{ alignSelf: 'center' }}>
          {link ? `当前：${link.reachable ? '在线' : '离线'} · ${link.baseUrl}` : '读取中…'}
        </div>
        <button className="btn secondary" type="button" onClick={() => void probe(true)} disabled={busy || !leaseEnabled}>
          {busy ? '检测中…' : '测试连接'}
        </button>
      </div>
      <TestResultLine result={testRes} />
    </SectionCard>
  )
}
