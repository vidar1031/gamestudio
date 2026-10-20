// 图像服务卡（ui_设置定义.md §7.5）：provider/checkpoint/LoRA/尺寸/服务地址/模型目录/风格预设管理。
// sdwebui 模型列表加载、ComfyUI 连续分镜体检、模型记忆逻辑移植自 StudioSettingsModal（原样保留）。
import { useEffect, useMemo, useState } from 'react'
import SectionCard, { TestResultLine, type StatusLevel } from './SectionCard'
import { IconImage } from './icons'
import {
  SDWEBUI_MODEL_PRESETS,
  defaultModelBySectionProvider,
  getRememberedModelValue,
  getSdwebuiModels,
  normalizeModelOption,
  preflightStudioImage,
  readCurrentModel,
  withImageDefaults,
  type SettingsHost
} from './settingsApi'

export default function ImageServiceCard(props: { host: SettingsHost; defaultOpen?: boolean }) {
  const { host } = props
  const cfg = host.draft.image || {}
  const provider = String(cfg.provider || '').toLowerCase()
  const enabled = Boolean(host.draft.enabled?.image)
  const testing = host.testingService === 'image'

  const [sdModelsBusy, setSdModelsBusy] = useState(false)
  const [sdModelsErr, setSdModelsErr] = useState('')
  const [sdModelsNote, setSdModelsNote] = useState('')
  const [sdModelsSource, setSdModelsSource] = useState<'api' | 'disk'>('api')
  const [sdModelList, setSdModelList] = useState<string[]>([])
  const [imgPreflightBusy, setImgPreflightBusy] = useState(false)
  const [imgPreflightSummary, setImgPreflightSummary] = useState('')
  const [imgPreflightDiag, setImgPreflightDiag] = useState<any>(null)
  const [imgPreflightDetailOpen, setImgPreflightDetailOpen] = useState(false)

  async function loadImageModels(p: string, baseUrl?: string) {
    if (String(p || '').toLowerCase() !== 'sdwebui') {
      setSdModelList([])
      setSdModelsErr('')
      setSdModelsNote('')
      setSdModelsSource('api')
      return
    }
    setSdModelsBusy(true)
    setSdModelsErr('')
    setSdModelsNote('')
    setSdModelsSource('api')
    try {
      const res = await getSdwebuiModels(baseUrl)
      const models = (res.models || []).map((x: any) => normalizeModelOption(x, 'sdwebui')).filter(Boolean)
      setSdModelList(models)
      setSdModelsNote(String(res.note || ''))
      const currentModel = readCurrentModel(res)
      if (currentModel) {
        const cur = host.draft.image || {}
        if (String(cur.provider || '').toLowerCase() === 'sdwebui' && !String(cur.model || '').trim()) {
          host.patchSection('image', { model: currentModel })
        }
      }
      if (String(res.note || '') === 'models_api_not_supported') {
        host.appendLog('已连接 SDWebUI，但当前版本不支持模型列表接口（可手动填写模型名）')
      } else {
        host.appendLog(`已加载 SDWebUI 模型：${Array.isArray(res.models) ? res.models.length : 0} 个`)
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      setSdModelsErr(msg)
      host.appendLog(`加载 SDWebUI 模型失败：${msg}`)
    } finally {
      setSdModelsBusy(false)
    }
  }

  // 进入图像卡且 provider=sdwebui 时自动拉取模型列表（沿用弹窗 refresh 行为）
  useEffect(() => {
    if (provider === 'sdwebui') void loadImageModels('sdwebui', String(cfg.sdwebuiBaseUrl || ''))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [provider])

  async function runImagePreflightOnly() {
    if (imgPreflightBusy) return
    setImgPreflightBusy(true)
    setImgPreflightSummary('')
    const startedAt = Date.now()
    try {
      host.appendLog('开始运行连续分镜体检（不出图）...')
      const pf = await preflightStudioImage({ settings: host.buildSettingsWithSecrets(), timeoutMs: 12000, mode: 'storyboard' })
      const checks = pf.checks || {}
      const baseUrl = String(checks.baseUrl || '')
      const missingNodes = Array.isArray(checks.missingNodes) ? checks.missingNodes : []
      const elapsed = Date.now() - startedAt
      if (pf.ok) {
        const msg = `体检通过：${baseUrl || 'comfyui'} 连续分镜依赖就绪`
        setImgPreflightSummary(msg)
        host.appendLog(msg)
        host.recordServiceTestResult('image', { ok: true, note: `体检通过 · ${baseUrl || 'comfyui'} · 耗时 ${(elapsed / 1000).toFixed(1)}s`, at: Date.now() })
        return
      }
      const lines = [
        baseUrl ? `baseUrl=${baseUrl}` : '',
        checks.reason ? `reason=${checks.reason}` : '',
        missingNodes.length ? `missingNodes=${missingNodes.join(',')}` : '',
        pf.message ? `message=${pf.message}` : ''
      ].filter(Boolean)
      const msg = `检查失败：${lines.join(' ; ')}`
      setImgPreflightSummary(msg)
      host.appendLog(msg)
      host.recordServiceTestResult('image', {
        ok: false,
        note: `体检失败：${checks.reason ? String(checks.reason) : pf.message || '未知原因'}；建议：请检查 ComfyUI 是否已启动，节点缺失请经 ComfyUI-Manager 安装后重启`,
        at: Date.now()
      })
      setImgPreflightDiag({ ok: false, checks, message: pf.message || '', details: msg })
      setImgPreflightDetailOpen(true)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      setImgPreflightSummary(`体检失败：${msg}`)
      host.appendLog(`体检失败：${msg}`)
      host.recordServiceTestResult('image', {
        ok: false,
        note: `体检失败：${msg}；建议：请检查 ComfyUI 是否已启动，或核对服务地址`,
        at: Date.now()
      })
    } finally {
      setImgPreflightBusy(false)
    }
  }

  const sdModelOptions = useMemo(() => {
    const set = new Set<string>()
    const current = normalizeModelOption(cfg.model, provider)
    if (current) set.add(current)
    for (const m of sdModelList || []) {
      const x = normalizeModelOption(m, provider)
      if (x) set.add(x)
    }
    // 磁盘扫描模式下只显示真实模型（外加当前值保证可见）
    if (!(provider === 'comfyui' && sdModelsSource === 'disk')) {
      for (const m of SDWEBUI_MODEL_PRESETS) {
        const x = normalizeModelOption(m, provider)
        if (x) set.add(x)
      }
    }
    return Array.from(set).filter(Boolean)
  }, [sdModelList, cfg.model, provider, sdModelsSource])

  let status: StatusLevel = 'ok'
  let statusText = ''
  // 任务A：失败态取自内联测试结果（测试连接与 ComfyUI 体检都记录）
  const testRes = testing || imgPreflightBusy ? null : host.serviceTestResults['image'] || null
  if (testing || imgPreflightBusy) status = 'checking'
  else if (!enabled) status = 'off'
  else if (!provider || provider === 'none') status = 'warn'
  else if (testRes && !testRes.ok) {
    status = 'error'
    statusText = '不可用'
  }

  const summary = !enabled ? '已停用' : !provider || provider === 'none' ? '未配置' : `${provider} / ${String(cfg.model || '') || '默认模型'}`

  const loras = Array.isArray(cfg.loras) ? cfg.loras : []
  const presets = cfg.stylePresets && typeof cfg.stylePresets === 'object' ? (cfg.stylePresets as Record<string, any>) : {}
  const presetNames = Object.keys(presets)
  const activePreset = String(cfg.activeStylePreset || '')

  function patchPresetState(nextPresets: Record<string, any>, nextActive?: string) {
    host.patchSection('image', {
      stylePresets: nextPresets,
      activeStylePreset: nextActive == null ? activePreset : nextActive
    })
  }

  function createPreset() {
    const name = String(window.prompt('新预设名称（唯一标识，如 my_style_v1）') || '').trim()
    if (!name) return
    if (presets[name]) {
      window.alert(`预设「${name}」已存在`)
      return
    }
    patchPresetState(
      {
        ...presets,
        [name]: {
          label: name,
          note: '设置页新建',
          createdAt: new Date().toISOString(),
          checkpoint: String(cfg.model || ''),
          loras: [...loras],
          size: String(cfg.size || '')
        }
      },
      name
    )
    host.appendLog(`已新建风格预设：${name}（保存后生效）`)
  }

  function duplicatePreset() {
    if (!activePreset || !presets[activePreset]) return
    const name = String(window.prompt(`复制「${activePreset}」为新预设，名称：`) || '').trim()
    if (!name) return
    if (presets[name]) {
      window.alert(`预设「${name}」已存在`)
      return
    }
    patchPresetState({ ...presets, [name]: { ...presets[activePreset], label: name, note: `复制自 ${activePreset}` } }, name)
    host.appendLog(`已复制风格预设：${activePreset} → ${name}（保存后生效）`)
  }

  function deletePreset() {
    if (!activePreset || !presets[activePreset]) return
    if (!window.confirm(`删除风格预设「${activePreset}」？出图链将回退到内置默认风格。`)) return
    const sample = String(presets[activePreset]?.sourceSample || '').trim()
    if (sample) {
      // 生产验证过的预设删除需二次确认（§7.5）
      if (!window.confirm(`「${activePreset}」沉淀自生产样本（${sample}），删除后不可恢复。确认删除？`)) return
    }
    const next = { ...presets }
    delete next[activePreset]
    patchPresetState(next, '')
    host.appendLog(`已删除风格预设：${activePreset}（保存后生效）`)
  }

  return (
    <SectionCard
      title="图像服务"
      icon={<IconImage />}
      summary={summary}
      status={status}
      statusText={statusText}
      enabled={enabled}
      onToggleEnabled={(v) => host.setEnabled('image', v)}
      defaultOpen={props.defaultOpen}
    >
      <div className="settings-row">
        <div className="settings-row-label">Provider</div>
        <select
          value={provider || 'none'}
          onChange={(e) => {
            const nextProvider = e.target.value
            host.rememberModel('image', provider, String(cfg.model || ''))
            const recalled = getRememberedModelValue(host.modelMemory, 'image', nextProvider)
            const nextModel = recalled || defaultModelBySectionProvider('image', nextProvider, host.effective)
            const nextImage = withImageDefaults({ ...cfg, provider: nextProvider, model: nextModel })
            host.patchSection('image', nextImage)
            if (String(nextProvider).toLowerCase() === 'sdwebui') void loadImageModels('sdwebui', String(nextImage.sdwebuiBaseUrl || ''))
          }}
        >
          <option value="none">未配置</option>
          <option value="sdwebui">sdwebui</option>
          <option value="comfyui">comfyui</option>
          <option value="doubao">doubao</option>
        </select>
      </div>

      {provider !== 'comfyui' ? (
        <div className="settings-row" style={{ gridTemplateColumns: '110px 1fr auto' }}>
          <div className="settings-row-label">模型</div>
          {provider === 'sdwebui' ? (
            <select
              value={String(cfg.model || '')}
              onChange={(e) => {
                host.patchSection('image', { model: e.target.value })
                host.rememberModel('image', provider, e.target.value)
              }}
            >
              <option value="">自动/当前模型</option>
              {sdModelOptions.map((m) => (
                <option key={m} value={m}>{m}</option>
              ))}
            </select>
          ) : (
            <input
              value={String(cfg.model || '')}
              placeholder="如 doubao-seedream-4-0-250828（可留空）"
              onChange={(e) => {
                host.patchSection('image', { model: e.target.value })
                host.rememberModel('image', provider, e.target.value)
              }}
            />
          )}
          <div className="settings-row-actions">
            <button
              className="btn secondary"
              type="button"
              onClick={() => host.runServiceDiagnose('image')}
              disabled={!enabled || Boolean(host.testingService)}
            >
              {testing ? '检测中…' : '测试连接'}
            </button>
          </div>
        </div>
      ) : null}

      {provider === 'sdwebui' ? (
        <div className="settings-row" style={{ gridTemplateColumns: '110px 1fr auto' }}>
          <div className="settings-row-label">模型列表</div>
          <div className="hint" style={{ alignSelf: 'center' }}>
            {sdModelsErr
              ? `加载失败：${sdModelsErr}`
              : sdModelsNote === 'models_api_not_supported'
                ? '当前 SDWebUI 版本不支持模型列表接口（可手动输入模型）'
                : `接口加载 ${sdModelList.length} 个，预置 ${SDWEBUI_MODEL_PRESETS.length} 个`}
          </div>
          <button
            className="btn secondary"
            type="button"
            onClick={() => void loadImageModels('sdwebui', String(cfg.sdwebuiBaseUrl || ''))}
            disabled={sdModelsBusy || !enabled}
          >
            {sdModelsBusy ? '加载中…' : '刷新模型'}
          </button>
        </div>
      ) : null}

      {provider === 'comfyui' ? (
        <div className="settings-row" style={{ gridTemplateColumns: '110px 1fr auto' }}>
          <div className="settings-row-label">ComfyUI</div>
          <input
            value={String(cfg.comfyuiBaseUrl || '')}
            placeholder="http://127.0.0.1:8188（可选）"
            onChange={(e) => host.patchSection('image', { comfyuiBaseUrl: e.target.value })}
          />
          <button className="btn secondary" type="button" onClick={() => void runImagePreflightOnly()} disabled={!enabled || imgPreflightBusy}>
            {imgPreflightBusy ? '体检中…' : '测试连接'}
          </button>
        </div>
      ) : null}

      {provider === 'sdwebui' || provider === 'comfyui' ? (
        <div className="hint">
          {provider === 'comfyui'
            ? 'ComfyUI 设置页只保留地址连通与连续分镜依赖体检；模型、LoRA 与采样参数请在「AI 分镜批量生成」里按当前工作流填写。'
            : 'SDWebUI 出图会自动注入风格化提示（卡通/国风/绘本）与反写实负面词；建议先点「AI 解析提示词」，优先使用英文提示词。'}
        </div>
      ) : null}
      {provider === 'comfyui' ? <div className="hint">当前仅校验 baseUrl、基础节点和连续分镜依赖节点是否就绪，不在这里绑定 checkpoint / LoRA。</div> : null}
      {provider === 'comfyui' && imgPreflightSummary ? <div className="hint">{imgPreflightSummary}</div> : null}

      {provider === 'comfyui' && imgPreflightDiag ? (
        <div className="settings-inline-detail">
          <div className="settings-subhead" style={{ cursor: 'pointer' }} onClick={() => setImgPreflightDetailOpen((v) => !v)}>
            出图配置检查详情{imgPreflightDetailOpen ? '（收起）' : '（展开）'}
          </div>
          {imgPreflightDetailOpen ? (
            <div style={{ display: 'grid', gap: 8 }}>
              <div className="hint">ComfyUI baseUrl：{String(imgPreflightDiag?.checks?.baseUrl || '') || '（未设置）'}</div>
              <div className="ai-modal-err" style={{ marginTop: 0 }}>
                {String(imgPreflightDiag?.checks?.reason || 'preflight_failed')}
                {imgPreflightDiag?.message ? ` - ${String(imgPreflightDiag.message)}` : ''}
              </div>
              {Array.isArray(imgPreflightDiag?.checks?.missingNodes) && imgPreflightDiag.checks.missingNodes.length ? (
                <div className="hint">
                  缺少节点（相当于缺插件/自定义节点）：{imgPreflightDiag.checks.missingNodes.join('，')}；
                  {String(imgPreflightDiag?.checks?.hints?.managerHint || '建议通过 ComfyUI-Manager 安装/更新节点，然后重启 ComfyUI')}
                </div>
              ) : null}
              {imgPreflightDiag?.checks?.mode === 'storyboard' ? (
                <>
                  <div className="hint">
                    ControlNet：{imgPreflightDiag?.checks?.extras?.controlnet?.ok ? 'ok' : 'missing'}
                    {Array.isArray(imgPreflightDiag?.checks?.extras?.controlnet?.missingNodes) && imgPreflightDiag.checks.extras.controlnet.missingNodes.length
                      ? ` nodes=${imgPreflightDiag.checks.extras.controlnet.missingNodes.join(',')}`
                      : ''}
                    ；IP-Adapter：{imgPreflightDiag?.checks?.extras?.ipadapter?.ok ? 'ok' : 'missing'}
                    {Array.isArray(imgPreflightDiag?.checks?.extras?.ipadapter?.missingNodes) && imgPreflightDiag.checks.extras.ipadapter.missingNodes.length
                      ? ` nodes=${imgPreflightDiag.checks.extras.ipadapter.missingNodes.join(',')}`
                      : ''}
                  </div>
                  <div className="hint">
                    SDXL 锁定工作流：{imgPreflightDiag?.checks?.extras?.storyLock?.ok ? 'ok' : 'missing'}；checkpoint=
                    {String(imgPreflightDiag?.checks?.extras?.storyLock?.checkpointModel || '-')}
                  </div>
                </>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}

      {provider === 'doubao' ? (
        <div className="settings-row">
          <div className="settings-row-label">接口地址</div>
          <input
            value={String(cfg.apiUrl || '')}
            placeholder="https://ark.../api/v3/images/generations（可选）"
            onChange={(e) => host.patchSection('image', { apiUrl: e.target.value })}
          />
        </div>
      ) : null}

      <TestResultLine result={testRes} />

      {provider === 'sdwebui' ? (
        <div className="settings-row">
          <div className="settings-row-label">SDWebUI</div>
          <input
            value={String(cfg.sdwebuiBaseUrl || '')}
            placeholder="http://127.0.0.1:7860（可选）"
            onChange={(e) => host.patchSection('image', { sdwebuiBaseUrl: e.target.value })}
            onBlur={() => {
              if (provider === 'sdwebui') void loadImageModels('sdwebui', String(cfg.sdwebuiBaseUrl || ''))
            }}
          />
        </div>
      ) : null}

      {provider === 'comfyui' ? (
        <div className="settings-row">
          <div className="settings-row-label">模型目录</div>
          <input
            value={String(cfg.comfyuiModelsRoot || '')}
            placeholder="ComfyUI 模型根路径（能力自检用；目录缺失状态灯转黄）"
            onChange={(e) => host.patchSection('image', { comfyuiModelsRoot: e.target.value })}
          />
        </div>
      ) : null}

      {provider && provider !== 'none' ? (
        <>
          <div className="settings-row">
            <div className="settings-row-label">默认尺寸</div>
            <input
              value={String(cfg.size || '')}
              placeholder="宽x高，如 1024x1024"
              onChange={(e) => host.patchSection('image', { size: e.target.value })}
            />
          </div>
          <div className="settings-row" style={{ gridTemplateColumns: '110px 1fr', alignItems: 'start' }}>
            <div className="settings-row-label">LoRA 栈</div>
            <div style={{ display: 'grid', gap: 8 }}>
              {loras.map((lora, idx) => (
                <div key={idx} style={{ display: 'flex', gap: 8 }}>
                  <input
                    value={String(lora || '')}
                    placeholder="名称:权重，如 myLora.safetensors:0.8"
                    onChange={(e) => {
                      const next = [...loras]
                      next[idx] = e.target.value
                      host.patchSection('image', { loras: next })
                    }}
                  />
                  <button
                    className="btn secondary"
                    type="button"
                    onClick={() => host.patchSection('image', { loras: loras.filter((_, i) => i !== idx) })}
                  >
                    删除
                  </button>
                </div>
              ))}
              <div>
                <button className="btn secondary" type="button" onClick={() => host.patchSection('image', { loras: [...loras, ''] })}>
                  添加 LoRA
                </button>
              </div>
              <div className="hint">按顺序注入出图链；留空行保存时会被忽略。</div>
            </div>
          </div>

          <div className="settings-subhead">风格预设</div>
          <div className="settings-row" style={{ gridTemplateColumns: '110px 1fr auto' }}>
            <div className="settings-row-label">当前预设</div>
            <select
              value={activePreset}
              onChange={(e) => {
                host.patchSection('image', { activeStylePreset: e.target.value })
                host.appendLog(e.target.value ? `已切换风格预设：${e.target.value}（保存后生效）` : '已停用风格预设（保存后生效）')
              }}
            >
              <option value="">不使用预设</option>
              {presetNames.map((name) => (
                <option key={name} value={name}>
                  {String(presets[name]?.label || name)}
                  {presets[name]?.sourceSample ? '（生产样本）' : ''}
                </option>
              ))}
            </select>
            <div className="settings-row-actions">
              <button className="btn secondary" type="button" onClick={createPreset}>新建</button>
              <button className="btn secondary" type="button" onClick={duplicatePreset} disabled={!activePreset}>复制</button>
              <button className="btn secondary" type="button" onClick={deletePreset} disabled={!activePreset}>删除</button>
              <button className="btn secondary" type="button" disabled title="沉淀由生产链路完成，随能力版本上线">
                从生产样本沉淀（随能力版本上线）
              </button>
            </div>
          </div>
          <div className="hint">
            预设 = checkpoint + LoRA 栈 + 风格锁定句等整链风格参数；切换预设即整链出图风格切换，不回溯已产出图。
          </div>
        </>
      ) : null}
    </SectionCard>
  )
}
