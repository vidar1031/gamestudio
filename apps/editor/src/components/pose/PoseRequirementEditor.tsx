// 姿态需求共享编辑器（2026-11-01 抽取自 BlueprintStudio 内联实现，并迁入原锁定向导的「AI 建议 / 翻译为英文」能力）：
// 蓝图层 = 需求定义唯一入口；本组件负责清单增删改、中英双稿、视角/动作/表情组装器、配方应用、AI 建议、翻译。
// 锁定向导不再维护第二份定义 UI（只读摘要 + 回跳蓝图），消除两处重复功能组件。
import { useState } from 'react'
import { POSE_VIEW_OPTIONS } from '../../poseRecipes'
import { poseStateKeyFromName, sceneCountOfRequirement } from './poseTypes'
import { usePoseAiSuggest } from './usePoseAiSuggest'
import { usePromptTranslate } from './usePromptTranslate'
import { confirmRerun } from '../shared/confirmRerun'

export type PoseRecipeOption = { name: string; promptZh: string; promptEn: string }

type Props = {
  projectId: string
  /** 计划资产（读 poseRequirements / name） */
  asset: any
  /** 全局 busy（编排保存等外部忙碌时禁用输入） */
  busy?: boolean
  /** 配方库（内置+自定义，调用方组装传入） */
  recipes?: PoseRecipeOption[]
  /** AI 建议的剧情上下文：按幕取文本（调用方持有 story/script 数据） */
  sceneTextFor?: (sceneId: string) => string
  /** AI 建议的角色身份指纹提示词（可选） */
  fingerprintPrompt?: string
  /** 整单保存（调用方接 usePoseRequirementOps 或自有写口） */
  onSave: (assetId: string, requirements: any[], okNote: string) => void
  saving?: boolean
  err?: string
  note?: string
  emptyHint?: string
}

export default function PoseRequirementEditor(props: Props) {
  const assetId = String(props.asset?.id || '').trim()
  const reqs: any[] = Array.isArray(props.asset?.poseRequirements) ? props.asset.poseRequirements : []
  const disabled = Boolean(props.busy || props.saving)
  const [newInput, setNewInput] = useState('')
  const [asmInputs, setAsmInputs] = useState<Record<string, { view: string; action: string; expression: string }>>({})
  const aiSuggest = usePoseAiSuggest(props.projectId)
  const translator = usePromptTranslate(props.projectId)
  const aiBusy = aiSuggest.busy || translator.busy

  if (!assetId) return null

  const saveNext = (next: any[], okNote: string) => props.onSave(assetId, next, okNote)

  const addRequirement = () => {
    const name = newInput.trim()
    if (!name) return
    const key = poseStateKeyFromName(name)
    if (!key) return
    if (reqs.some((r: any) => String(r?.stateKey || '') === key)) return
    saveNext([
      ...reqs,
      {
        reqId: `custom::${key}`,
        stateKey: key,
        label: name,
        sceneIds: [],
        pose: name,
        view: '',
        action: '',
        expression: '',
        excludedProps: [],
        promptZh: `仅画角色本身，纯白背景，不含道具与场景，${name}`,
        promptEn: '',
        createdAt: new Date().toISOString()
      }
    ], `已新增姿态需求「${name}」`)
    setNewInput('')
  }

  const patchReq = (ri: number, patch: Record<string, unknown>, okNote: string) =>
    saveNext(reqs.map((x: any, i: number) => (i === ri ? { ...x, ...patch } : x)), okNote)

  const firstSceneIdOf = (r: any) => String(r?.sceneId || '').trim() || String((Array.isArray(r?.sceneIds) ? r.sceneIds[0] : '') || '').trim()

  const runAiSuggest = async (r: any, ri: number) => {
    const label = String(r?.label || r?.stateKey || '')
    if (!(await confirmRerun({ action: 'AI 建议姿态提示词', hasExisting: Boolean(String(r?.promptZh || r?.promptEn || '').trim()) }))) return
    const res = await aiSuggest.suggest({
      characterName: String(props.asset?.name || label),
      fingerprintPrompt: props.fingerprintPrompt,
      sceneText: props.sceneTextFor?.(firstSceneIdOf(r)) || '',
      userHint: String(r?.promptZh || '')
    })
    if (!res) return
    patchReq(ri, { promptZh: res.promptZh, promptEn: res.promptEn }, `需求「${label}」已按 AI 建议更新`)
  }

  const runTranslate = async (r: any, ri: number) => {
    const zh = String(r?.promptZh || '').trim()
    if (!zh) return
    if (!(await confirmRerun({ action: '翻译姿态提示词', hasExisting: Boolean(String(r?.promptEn || '').trim()) }))) return
    const en = await translator.translate(zh)
    if (!en) return
    patchReq(ri, { promptEn: en }, `需求「${String(r?.label || r?.stateKey || '')}」英文稿已翻译`)
  }

  return (
    <div className="form-row">
      <label>姿态需求清单</label>
      <div style={{ display: 'grid', gap: 8 }}>
        {reqs.length ? (
          reqs.map((r: any, ri: number) => {
            const reqKey = String(r?.reqId || ri)
            const asm = asmInputs[reqKey] || { view: '', action: '', expression: '' }
            const patchAsm = (patch: Partial<typeof asm>) => setAsmInputs((prev) => ({ ...prev, [reqKey]: { ...asm, ...prev[reqKey], ...patch } }))
            return (
              <div key={reqKey} style={{ border: '1px solid rgba(148,163,184,0.16)', borderRadius: 10, padding: 8, display: 'grid', gap: 4 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                  <span style={{ fontWeight: 700, fontSize: 12.5 }}>{String(r?.label || r?.stateKey || '未命名')}</span>
                  <span className="hint" style={{ fontSize: 12 }}>stateKey: {String(r?.stateKey || '—')} · 涉及 {sceneCountOfRequirement(r)} 幕</span>
                  <span style={{ flex: 1 }} />
                  <button
                    type="button"
                    className="bp-flip-btn"
                    disabled={disabled || aiBusy}
                    title="按该需求关联的剧情上下文生成姿态提示词（中英双稿，覆盖现值）"
                    onClick={() => void runAiSuggest(r, ri)}
                  >
                    {aiSuggest.busy ? '建议中…' : 'AI 建议'}
                  </button>
                  <button
                    type="button"
                    className="bp-flip-btn"
                    style={{ color: '#fca5a5' }}
                    disabled={disabled || props.saving}
                    title="删除该需求（写回计划；已产变体不受影响）"
                    onClick={() => saveNext(reqs.filter((_: any, i: number) => i !== ri), `已删除姿态需求「${String(r?.label || r?.stateKey || '')}」`)}
                  >
                    删
                  </button>
                </div>
                <input
                  key={`reqzh_${reqKey}_${String(r?.promptZh || '').length}`}
                  className="input"
                  style={{ fontSize: 12 }}
                  defaultValue={String(r?.promptZh || '')}
                  disabled={disabled}
                  placeholder="中文提示词（生成变体用）"
                  title="该需求的中文提示词（生成变体时消费）；失焦/回车写盘"
                  onBlur={(e) => {
                    const v = e.target.value
                    if (v === String(r?.promptZh || '')) return
                    patchReq(ri, { promptZh: v }, '需求提示词已保存')
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
                  }}
                />
                <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                  <input
                    key={`reqen_${reqKey}_${String(r?.promptEn || '').length}`}
                    className="input"
                    style={{ fontSize: 12, flex: 1 }}
                    defaultValue={String(r?.promptEn || '')}
                    disabled={disabled}
                    placeholder="英文提示词（可手编，或点右侧翻译）"
                    title="该需求的英文提示词；失焦/回车写盘"
                    onBlur={(e) => {
                      const v = e.target.value
                      if (v === String(r?.promptEn || '')) return
                      patchReq(ri, { promptEn: v }, '需求提示词已保存')
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
                    }}
                  />
                  <button
                    type="button"
                    className="bp-flip-btn"
                    disabled={disabled || aiBusy || !String(r?.promptZh || '').trim()}
                    title="把中文稿翻译为英文写入（走服务端翻译链）"
                    onClick={() => void runTranslate(r, ri)}
                  >
                    {translator.busy ? '翻译中…' : '翻译为英文'}
                  </button>
                </div>
                {/* 视角/动作/表情组装器 + 配方应用（写入该条中文稿/英文稿） */}
                <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', alignItems: 'center' }}>
                  <select
                    className="sel"
                    style={{ padding: '3px 6px', fontSize: 12 }}
                    value={asm.view}
                    disabled={disabled}
                    onChange={(e) => patchAsm({ view: e.target.value })}
                  >
                    <option value="">视角…</option>
                    {POSE_VIEW_OPTIONS.map((v) => (
                      <option key={v} value={v}>{v}</option>
                    ))}
                  </select>
                  <input
                    className="input"
                    style={{ padding: '3px 8px', fontSize: 12, width: 130 }}
                    value={asm.action}
                    disabled={disabled}
                    placeholder="动作（如：指向稻草堆）"
                    onChange={(e) => patchAsm({ action: e.target.value })}
                  />
                  <input
                    className="input"
                    style={{ padding: '3px 8px', fontSize: 12, width: 100 }}
                    value={asm.expression}
                    disabled={disabled}
                    placeholder="表情（如：得意）"
                    onChange={(e) => patchAsm({ expression: e.target.value })}
                  />
                  <button
                    type="button"
                    className="bp-flip-btn"
                    disabled={disabled || !asm.view || !asm.action.trim()}
                    title="把视角/动作/表情拼成自然中文句写入该需求中文提示词（覆盖现值；英文稿清空待翻译）"
                    onClick={() => {
                      const sentence = [asm.view, asm.action.trim(), asm.expression.trim()].filter(Boolean).join('，')
                      patchReq(ri, { promptZh: sentence, promptEn: '' }, `需求「${String(r?.label || r?.stateKey || '')}」提示词已组装写入`)
                      patchAsm({ view: '', action: '', expression: '' })
                    }}
                  >
                    组装进中文稿
                  </button>
                  <select
                    className="sel"
                    style={{ padding: '3px 6px', fontSize: 12 }}
                    value=""
                    disabled={disabled || !(props.recipes || []).length}
                    title="从配方库选择姿势提示词写入该需求（中文稿+英文稿）"
                    onChange={(e) => {
                      const hit = (props.recipes || []).find((x) => x.name === e.target.value)
                      if (!hit) return
                      patchReq(ri, { promptZh: hit.promptZh, promptEn: hit.promptEn }, `需求「${String(r?.label || r?.stateKey || '')}」已套用配方「${hit.name}」`)
                    }}
                  >
                    <option value="">配方…</option>
                    {(props.recipes || []).map((x) => (
                      <option key={x.name} value={x.name}>{x.name}</option>
                    ))}
                  </select>
                </div>
              </div>
            )
          })
        ) : (
          <div className="hint" style={{ fontSize: 12 }}>{props.emptyHint || '还没有姿态需求。下方新增，或由 AI 从剧情提取。'}</div>
        )}
        <div style={{ display: 'flex', gap: 4 }}>
          <input
            className="input"
            style={{ flex: 1, padding: '3px 8px', fontSize: 12 }}
            placeholder="新增姿态需求（语义名，如 吹气/倒地/奔跑）"
            value={newInput}
            disabled={disabled}
            onChange={(e) => setNewInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') addRequirement()
            }}
          />
          <button
            type="button"
            className="bp-flip-btn"
            disabled={disabled || !newInput.trim()}
            title="新增姿态需求（写回计划 poseRequirements；重名去重）"
            onClick={addRequirement}
          >
            + 新增
          </button>
        </div>
        {props.err ? <div className="hint" style={{ color: '#fca5a5' }}>{props.err}</div> : null}
        {props.note ? <div className="hint" style={{ color: '#86efac' }}>{props.note}</div> : null}
        {aiSuggest.err ? <div className="hint" style={{ color: '#fca5a5' }}>AI 建议失败:{aiSuggest.err}</div> : null}
        {translator.err ? <div className="hint" style={{ color: '#fca5a5' }}>翻译失败:{translator.err}</div> : null}
      </div>
    </div>
  )
}
