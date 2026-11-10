// 本地服务卡（2026-10-25 用户指令）：OMLX / ComfyUI 等本地工具的状态灯 + 一键启动。
// 项目启动而模型工具未启动时，生成类调用全废——这里提供明面的状态与拉起入口；启动走任务台账，不搞黑盒。
import { useEffect, useState } from 'react'
import SectionCard, { TestResultLine, type StatusLevel } from './SectionCard'
import { IconServer } from './icons'
import { getStudioTools, launchStudioTool, type SettingsHost, type StudioToolInfo } from './settingsApi'

export default function LocalToolsCard(props: { host: SettingsHost; defaultOpen?: boolean }) {
  const { host } = props
  const [tools, setTools] = useState<StudioToolInfo[]>([])
  const [busyKey, setBusyKey] = useState('')

  async function refresh() {
    try {
      setTools(await getStudioTools())
    } catch {
      /* 下轮再试 */
    }
  }

  useEffect(() => {
    void refresh()
  }, [])

  async function launch(tool: StudioToolInfo) {
    if (busyKey) return
    setBusyKey(tool.key)
    try {
      const res = await launchStudioTool(tool.key)
      const ok = Boolean(res?.success)
      host.recordServiceTestResult(`tool-${tool.key}`, {
        ok,
        note: ok ? String(res.message || '已就绪') : `启动未完成：${String(res?.message || res?.error || '未知原因')}`,
        at: Date.now()
      })
      host.appendLog(`本地服务启动：${tool.label} → ${res?.message || res?.error || '-'}`)
      await refresh()
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      host.recordServiceTestResult(`tool-${tool.key}`, { ok: false, note: `启动失败：${msg}`, at: Date.now() })
      host.appendLog(`本地服务启动失败：${tool.label} ${msg}`)
    } finally {
      setBusyKey('')
    }
  }

  const onlineCount = tools.filter((t) => t.online).length
  const summary = tools.length ? `在线 ${onlineCount}/${tools.length}` : '检测中…'
  const status: StatusLevel = busyKey ? 'checking' : tools.length && onlineCount === tools.length ? 'ok' : tools.some((t) => !t.online) ? 'warn' : 'ok'
  const statusText = status === 'warn' ? '有服务离线' : ''

  return (
    <SectionCard title="本地服务" icon={<IconServer />} summary={summary} status={status} statusText={statusText} enabled={null} defaultOpen={props.defaultOpen}>
      <div className="hint">项目启动而本地模型/出图服务未启动时，生成类调用会失败。这里显示它们的状态并可一键拉起（OMLX 走菜单栏 App、ComfyUI 走可见终端窗口；启动过程进任务台账）。</div>
      {tools.map((t) => {
        const res = host.serviceTestResults[`tool-${t.key}`] || null
        const rowStatus: StatusLevel = busyKey === t.key ? 'checking' : t.online ? 'ok' : 'warn'
        return (
          <div className="settings-row" style={{ gridTemplateColumns: '110px 1fr auto' }} key={t.key}>
            <div className="settings-row-label" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span className={`settings-light settings-light-${rowStatus}`} />
              {t.label}
            </div>
            <div className="hint" style={{ alignSelf: 'center' }}>
              {t.online ? `在线 · 响应 ${t.latencyMs ?? '-'}ms · ${t.url}` : `离线 · ${t.url}`}
            </div>
            <button className="btn secondary" type="button" disabled={Boolean(busyKey) || t.online} onClick={() => void launch(t)}>
              {busyKey === t.key ? '启动中…' : t.online ? '已在线' : '启动'}
            </button>
            {res ? (
              <div style={{ gridColumn: '1 / -1' }}>
                <TestResultLine result={res} />
              </div>
            ) : null}
          </div>
        )
        })}
    </SectionCard>
  )
}
