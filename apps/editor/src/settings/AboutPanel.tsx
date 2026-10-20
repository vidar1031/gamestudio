// 关于区（ui_设置定义.md §9.6）：版本与构建标识 / 文档站入口 / 许可证 / 诊断信息打包导出。
import { useEffect, useState } from 'react'
import SectionCard from './SectionCard'
import { IconAbout } from './icons'
import { resolveUrl } from '../api'
import type { StudioStorageInfo } from './settingsApi'

export default function AboutPanel(props: {
  storageInfo: StudioStorageInfo | null
  exportBusy: boolean
  onExport: () => void
  defaultOpen?: boolean
}) {
  const [buildId, setBuildId] = useState('')
  useEffect(() => {
    let alive = true
    fetch(resolveUrl('/api/health'))
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        if (alive && j && j.buildId) setBuildId(String(j.buildId))
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [])

  const version = props.storageInfo?.version || ''
  const docsysUrl = props.storageInfo?.docsysUrl || 'http://127.0.0.1:8891/'

  return (
    <SectionCard title="关于" icon={<IconAbout />} summary={version ? `v${version}` : ''} status="ok" statusText="" enabled={null} defaultOpen={props.defaultOpen}>
      <div className="settings-row">
        <div className="settings-row-label">版本</div>
        <div className="hint">{version ? `v${version}` : '（读取中…）'}</div>
      </div>
      {buildId ? (
        <div className="settings-row">
          <div className="settings-row-label">构建标识</div>
          <div className="hint">{buildId}</div>
        </div>
      ) : null}
      <div className="settings-row">
        <div className="settings-row-label">文档站</div>
        <div>
          <a href={docsysUrl} target="_blank" rel="noreferrer">
            打开文档站（docsys）
          </a>
        </div>
      </div>
      <div className="settings-row">
        <div className="settings-row-label">许可证</div>
        <div className="hint">本地私有部署，随仓库分发。</div>
      </div>
      <div className="settings-row">
        <div className="settings-row-label">诊断打包</div>
        <div style={{ display: 'grid', gap: 8, justifyItems: 'start' }}>
          <button className="btn secondary" type="button" onClick={props.onExport} disabled={props.exportBusy}>
            {props.exportBusy ? '打包中…' : '导出诊断信息'}
          </button>
          <div className="hint">打包当前生效配置（Key 仅含掩码）与一次浅检结果，供二次开发/报障使用。</div>
        </div>
      </div>
    </SectionCard>
  )
}
