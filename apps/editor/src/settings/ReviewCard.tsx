// 审核模型卡（ui_设置定义.md §7.4）：完整度核实 + 姿势评审独立通道。
// 缺部件声明（§5）：无启用开关——审核以 Provider=停用 表达关闭；评审通道不可用时门禁 fail-closed 挂起，不在本页放宽。
import SectionCard, { TestResultLine, type StatusLevel } from './SectionCard'
import { IconReview } from './icons'
import type { SettingsHost } from './settingsApi'

export default function ReviewCard(props: { host: SettingsHost; defaultOpen?: boolean }) {
  const { host } = props
  const cfg = host.draft.review || {}
  const provider = String(cfg.provider || 'moonshot')
  const poseProvider = String(cfg.poseReviewProvider || 'auto')
  const testing = host.testingService === 'review'
  const testRes = testing ? null : host.serviceTestResults['review'] || null

  let status: StatusLevel = 'ok'
  let statusText = ''
  if (provider === 'none' || provider === 'off') {
    status = 'off'
  } else if (!provider) {
    status = 'warn'
  } else if (testing) {
    status = 'checking'
  } else if (testRes && !testRes.ok) {
    status = 'error'
    statusText = '不可用'
  }

  const summary = status === 'off' ? '已停用' : `${provider || '未配置'} / ${String(cfg.model || '') || '默认模型'}`

  return (
    <SectionCard title="审核模型" icon={<IconReview />} summary={summary} status={status} statusText={statusText} enabled={null} defaultOpen={props.defaultOpen}>
      <div className="hint">
        用于「完整度核实」逐节点画面视觉评审与「姿势一致性评审」。moonshot 使用 Kimi 视觉模型（外部计费）；omlx
        使用本地视觉模型（需支持图片输入）。评审通道不可用时，对应审核将挂起等待处置，不会自动放行。
      </div>
      <div className="settings-row">
        <div className="settings-row-label">Provider</div>
        <select
          value={provider}
          onChange={(e) => {
            const nextProvider = e.target.value
            const nextModel = nextProvider === 'omlx' ? 'Qwen3.6-27B-4bit' : nextProvider === 'moonshot' ? 'kimi-for-coding' : ''
            const nextApiUrl =
              nextProvider === 'omlx' ? 'http://127.0.0.1:18888/v1' : nextProvider === 'moonshot' ? 'https://api.kimi.com/coding/v1' : ''
            host.patchSection('review', { provider: nextProvider, model: nextModel, apiUrl: nextApiUrl })
          }}
        >
          <option value="moonshot">moonshot（Kimi 视觉）</option>
          <option value="omlx">omlx（本地视觉）</option>
          <option value="none">停用</option>
        </select>
      </div>
      <div className="settings-row">
        <div className="settings-row-label">模型</div>
        <input
          value={String(cfg.model || '')}
          placeholder={provider === 'omlx' ? 'Qwen3.6-27B-4bit' : 'kimi-for-coding'}
          onChange={(e) => host.patchSection('review', { model: e.target.value })}
        />
      </div>
      <div className="settings-row">
        <div className="settings-row-label">接口地址</div>
        <input
          value={String(cfg.apiUrl || '')}
          placeholder={provider === 'omlx' ? 'http://127.0.0.1:18888/v1' : 'https://api.kimi.com/coding/v1'}
          onChange={(e) => host.patchSection('review', { apiUrl: e.target.value })}
        />
      </div>
      <div className="settings-row" style={{ gridTemplateColumns: '110px 1fr auto' }}>
        <div className="settings-row-label">连通动作</div>
        <div className="hint" style={{ alignSelf: 'center' }}>探测评审端点连通性（不产生评审调用）</div>
        <button
          className="btn secondary"
          type="button"
          onClick={() => host.runServiceDiagnose('review')}
          disabled={status === 'off' || Boolean(host.testingService)}
        >
          {testing ? '检测中…' : '测试连接'}
        </button>
      </div>
      <TestResultLine result={testRes} />

      <div className="settings-subhead">姿势评审通道</div>
      <div className="settings-row">
        <div className="settings-row-label">Provider</div>
        <select value={poseProvider} onChange={(e) => host.patchSection('review', { poseReviewProvider: e.target.value })}>
          <option value="auto">自动（有 Kimi Key 走 Kimi，否则本地）</option>
          <option value="kimi">kimi（Kimi 视觉）</option>
          <option value="local_vl">local_vl（本地视觉模型）</option>
          <option value="off">关闭</option>
        </select>
      </div>
      {poseProvider === 'local_vl' ? (
        <>
          <div className="settings-row">
            <div className="settings-row-label">模型</div>
            <input
              value={String(cfg.poseReviewModel || '')}
              placeholder="如 gemma-4-26b-a4b-it-4bit"
              onChange={(e) => host.patchSection('review', { poseReviewModel: e.target.value })}
            />
          </div>
          <div className="settings-row">
            <div className="settings-row-label">接口地址</div>
            <input
              value={String(cfg.poseReviewBaseUrl || '')}
              placeholder="http://127.0.0.1:18888/v1"
              onChange={(e) => host.patchSection('review', { poseReviewBaseUrl: e.target.value })}
            />
          </div>
        </>
      ) : null}
    </SectionCard>
  )
}
