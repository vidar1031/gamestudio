// 场景姿态执行台（2026-11-01 从 StoryboardLockWorkspace 抽出为独立组件）：
// 锁定事物向导第 5 步的「场景姿态（角色）/状态变体（道具）」两段整体迁入本组件——
// 向导侧只保留执行（选场景 → 按蓝图已定义需求生成候选 → AI 评分 → 锁定并应用）；
// 需求定义 UI 已按 2026-10-27 裁决前移蓝图（PoseRequirementEditor），本组件对需求只读展示 + 「修改需求」回跳蓝图。
import React from 'react'
import { toProjectAssetUrl } from './assetUrl'
import {
  activePoseRequirementFor,
  defaultPoseDraft,
  poseSceneLabelOf,
  poseScoreBadgeOf,
  type PoseDraftEntry
} from './poseTypes'

type PoseGenOpts = {
  posePrompt: string
  posePromptZh?: string
  posePromptEn?: string
  negativePromptZh?: string
  negativePromptEn?: string
  ipadapter?: { enabled: boolean; weight: number; startAt: number; endAt: number }
}

export type ScenePoseWorkbenchProps = {
  projectId: string
  asset: any
  planAssets: any[]
  assetPlanBusy?: boolean
  // busy 旗（ComposeStudio 侧任务态）
  poseGeneratingId?: string
  poseDrawProgress?: { done: number; total: number } | null
  poseReviewingId?: string
  poseLockingKey?: string
  poseReqBusyId?: string
  propStateBusyId?: string
  propStateGenKey?: string
  // 该资产关联场景选项（场景序号+名称）
  poseSceneOptions: { sceneId: string; label: string }[]
  // 展开态在父级（聚焦回跳/锚点滚动要读写），此处受控
  poseExpanded: boolean
  onPoseExpandedChange: (v: boolean) => void
  stateExpanded: boolean
  onStateExpandedChange: (v: boolean) => void
  // 回跳聚焦：定位到具体需求（蓝图「管理」入口）
  focusReqId?: string
  // 回跳聚焦：指定场景（切执行台场景选择）
  focusSceneId?: string
  // 回调（ComposeStudio 执行链）
  onGotoBlueprint?: () => void
  onPoseDraftSave?: (assetId: string, draft: { promptZh: string; promptEn: string; negativePromptZh: string; negativePromptEn: string; sceneId: string; ipadapterOn: boolean; ipadapterWeight: number; ipadapterStartAt: number; ipadapterEndAt: number; promptZhSource?: string }) => void
  onPoseRequirementGenerate?: (assetId: string, reqId: string, count?: 1 | 4) => void
  onPoseRequirementsBatchGenerate?: (assetId: string) => void
  onPoseReviewAll?: (assetId: string) => void
  onPoseRedraw?: (assetId: string, assetPath: string, opts: PoseGenOpts) => void
  onPoseDeleteCandidate?: (assetId: string, assetPath: string) => void
  onPoseLock?: (assetId: string, assetPath: string, name: string, prompts: { posePrompt: string; posePromptZh?: string; posePromptEn?: string }, sceneId?: string) => Promise<{ ok: boolean; projectAssetId?: string; applied?: boolean; message?: string }>
  onPoseDeleteVariant?: (assetId: string, variantId: string) => Promise<{ ok: boolean; message?: string }>
  onPoseGalleryOpen?: (assetId: string) => void
  onPropStatesExtract?: (assetId: string) => void
  onPropStateGenerate?: (assetId: string, state: { stateKey: string; label: string; description?: string }) => void
}

export default function ScenePoseWorkbench(props: ScenePoseWorkbenchProps) {
  const asset = props.asset || {}
  const assetId = String(asset?.id || '').trim()
  const projectId = String(props.projectId || '')
  const isCharacterAsset = String(asset?.category || '') === 'character'

  // ============ 本地执行态（草稿覆盖层/展开/阻断提示；数据本体在 plan 资产上） ============
  const [poseDrafts, setPoseDrafts] = React.useState<Record<string, PoseDraftEntry>>({})
  const [activeReqId, setActiveReqId] = React.useState('')
  const [generateCount, setGenerateCount] = React.useState<1 | 4>(4)
  const [appliedMarks, setAppliedMarks] = React.useState<Record<string, boolean>>({})
  const [blockMsg, setBlockMsg] = React.useState('')

  const poseDraftOf = (a?: any): PoseDraftEntry => {
    const local = poseDrafts[assetId]
    if (local) return local
    const base = defaultPoseDraft()
    const p = a && typeof a.poseDraft === 'object' && a.poseDraft ? a.poseDraft : null
    if (!p) return base
    return {
      ...base,
      posePromptZh: String(p.promptZh || ''),
      posePromptEn: String(p.promptEn || ''),
      negativePromptZh: String(p.negativePromptZh || ''),
      negativePromptEn: String(p.negativePromptEn || ''),
      sceneId: String(p.sceneId || ''),
      ipadapterOn: p.ipadapterOn !== undefined ? Boolean(p.ipadapterOn) : base.ipadapterOn,
      ipadapterWeight: Number.isFinite(Number(p.ipadapterWeight)) ? Number(p.ipadapterWeight) : base.ipadapterWeight,
      ipadapterStartAt: Number.isFinite(Number(p.ipadapterStartAt)) ? Number(p.ipadapterStartAt) : base.ipadapterStartAt,
      ipadapterEndAt: Number.isFinite(Number(p.ipadapterEndAt)) ? Number(p.ipadapterEndAt) : base.ipadapterEndAt,
      promptZhSource: String((p as any).promptZhSource || ''),
      lockNames: {}
    }
  }
  const poseDraft = poseDraftOf(asset)
  const patchPoseDraft = (patch: Partial<PoseDraftEntry>) =>
    setPoseDrafts((prev) => ({ ...prev, [assetId]: { ...(prev[assetId] || poseDraftOf(asset)), ...patch } }))
  const savePoseDraft = (draft: PoseDraftEntry) => {
    props.onPoseDraftSave?.(assetId, {
      promptZh: String(draft.posePromptZh || ''),
      promptEn: String(draft.posePromptEn || ''),
      negativePromptZh: String(draft.negativePromptZh || ''),
      negativePromptEn: String(draft.negativePromptEn || ''),
      sceneId: String(draft.sceneId || ''),
      ipadapterOn: Boolean(draft.ipadapterOn),
      ipadapterWeight: Number(draft.ipadapterWeight) || 0.8,
      ipadapterStartAt: Number(draft.ipadapterStartAt) || 0.2,
      ipadapterEndAt: Number(draft.ipadapterEndAt) || 0.9,
      promptZhSource: String(draft.promptZhSource || '')
    })
  }

  const poseBusy = Boolean(props.poseGeneratingId || props.poseReviewingId || props.poseLockingKey || props.poseReqBusyId || props.assetPlanBusy)
  const poseCands: any[] = Array.isArray(asset?.poseCandidates) ? asset.poseCandidates : []
  const poseVariants: any[] = Array.isArray(asset?.poseVariants) ? asset.poseVariants : []
  const poseReqs: any[] = Array.isArray(asset?.poseRequirements) ? asset.poseRequirements : []
  const poseDoneReqIds = new Set(poseCands.map((c: any) => String(c?.reqId || '')).filter(Boolean))
  const poseReqTodoCount = poseReqs.filter((r) => String(r?.promptZh || r?.promptEn || '').trim() && !poseDoneReqIds.has(String(r?.reqId || ''))).length
  const poseSceneOpts = (props.poseSceneOptions || []).filter((o) => o && String(o.sceneId || '').trim())
  const poseSceneSel = String(poseDraft.sceneId || '').trim() || String(poseSceneOpts[0]?.sceneId || '')
  const poseGalleryCount = poseCands.length + poseVariants.length
  const lockedForScene = poseVariants.filter((variant: any) => String(variant?.sceneId || '') === poseSceneSel || (Array.isArray(variant?.sceneIds) && variant.sceneIds.includes(poseSceneSel)))
  const applied = Boolean(appliedMarks[`${assetId}:${poseSceneSel}`])

  // 聚焦回跳：外部指定需求（蓝图「管理」入口）时切到该需求并展开
  React.useEffect(() => {
    const rid = String(props.focusReqId || '').trim()
    if (!rid) return
    setActiveReqId(rid)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.focusReqId])

  // 聚焦回跳：外部指定场景时切执行台场景（持久化进 poseDraft，与手动切换同语义）
  React.useEffect(() => {
    const sid = String(props.focusSceneId || '').trim()
    if (!sid) return
    const cur = poseDrafts[assetId] || poseDraftOf(asset)
    if (String(cur.sceneId || '') === sid) return
    const next = { ...cur, sceneId: sid }
    setPoseDrafts((prev) => ({ ...prev, [assetId]: next }))
    savePoseDraft(next)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.focusSceneId])

  // 当前生效需求：显式点选优先（跨场景需求也可生成）；无点选回退场景命中/自定义壳
  const activeReq = (() => {
    const wanted = String(activeReqId || '').trim()
    if (wanted) {
      const byId = poseReqs.find((r: any) => String(r?.reqId || '') === wanted)
      if (byId) return byId
    }
    return activePoseRequirementFor(asset, poseSceneSel, activeReqId)
  })()
  const activeReqIdEff = String(activeReq?.reqId || '')
  const activeReqExists = poseReqs.some((r: any) => String(r?.reqId || '') === activeReqIdEff)
  const activeZh = String(activeReq?.promptZh || '')
  const activeEn = String(activeReq?.promptEn || '')
  const activeHasPrompt = Boolean(activeZh.trim() || activeEn.trim())

  const poseGenOptsOf = (): PoseGenOpts => {
    const zh = activeZh.trim()
    const en = activeEn.trim()
    return {
      posePrompt: en || zh,
      posePromptZh: zh,
      posePromptEn: en,
      negativePromptZh: String(poseDraft.negativePromptZh || '').trim(),
      negativePromptEn: String(poseDraft.negativePromptEn || '').trim(),
      ipadapter: poseDraft.ipadapterOn
        ? { enabled: true, weight: Number(poseDraft.ipadapterWeight) || 0.8, startAt: Number(poseDraft.ipadapterStartAt) || 0.2, endAt: Number(poseDraft.ipadapterEndAt) || 0.9 }
        : undefined
    }
  }

  const generateActive = () => {
    if (!activeReqExists || !activeHasPrompt) {
      setBlockMsg('当前没有可执行的蓝图姿态需求：请先到蓝图层定义（姿态需求清单），或点选上方已有需求。')
      return
    }
    setBlockMsg('')
    props.onPoseRequirementGenerate?.(assetId, activeReqIdEff, generateCount)
  }

  const applyPoseCandidate = async (assetPath: string, name: string, prompts: { posePrompt: string; posePromptZh?: string; posePromptEn?: string }, sceneId: string) => {
    if (!props.onPoseLock) return
    const result = await props.onPoseLock(assetId, assetPath, name, prompts, sceneId)
    if (result?.ok) {
      setAppliedMarks((prev) => ({ ...prev, [`${assetId}:${sceneId}`]: true, [`${assetId}:${sceneId}:${assetPath}`]: true }))
      setBlockMsg('')
    } else {
      setBlockMsg(String(result?.message || '姿态已锁定，但应用场景失败'))
    }
  }

  // ============ 状态变体（道具/地点等非角色资产专属） ============
  const stateReqs: any[] = Array.isArray(asset?.stateRequirements) ? asset.stateRequirements : []
  const stateVariants: any[] = Array.isArray(asset?.stateVariants) ? asset.stateVariants : []
  const stateMergeInto = asset?.stateMergeInto && typeof asset.stateMergeInto === 'object' ? asset.stateMergeInto : null
  const stateChecked = Boolean(String(asset?.stateCheckedAt || '').trim())
  const stateExtractingHere = props.propStateBusyId === assetId
  const stateBusy = poseBusy || Boolean(props.propStateBusyId || props.propStateGenKey)
  const stateMergeContainerId = String(stateMergeInto?.containerPropId || '').trim()
  const stateMergeContainerName = stateMergeInto
    ? (String(stateMergeInto?.containerName || '').trim()
      || String((props.planAssets.find((a: any) => String(a?.id || '').trim() === stateMergeContainerId) || {})?.name || '').trim()
      || stateMergeContainerId)
    : ''

  if (!assetId) return null

  return (
    <>
      {/* ============ 场景姿态（角色资产专属）：执行台四步 ============ */}
      {isCharacterAsset ? (
        <div className="pose-variant-section" id={`pose-asset-${assetId}`}>
          <div className="pose-variant-head" onClick={() => props.onPoseExpandedChange(!props.poseExpanded)}>
            <span>场景姿态<span className="hint" style={{ fontWeight: 400 }}>（按需生成，可复用）</span></span>
            <span className="hint">{poseVariants.length ? `已锁定 ${poseVariants.length} 个 · 候选 ${poseCands.length} 张` : (poseCands.length ? `候选 ${poseCands.length} 张` : '未生成')}</span>
            <span>{props.poseExpanded ? '－' : '＋'}</span>
          </div>
          {props.poseExpanded ? (
            <div className="pose-variant-body">
              <div className="pose-pool-field">
                <label>1 选择场景</label>
                <select
                  className="sel"
                  value={poseSceneSel}
                  disabled={poseBusy || poseSceneOpts.length === 0}
                  onChange={(e) => {
                    const sceneId = e.target.value
                    const next = { ...poseDraft, sceneId }
                    patchPoseDraft({ sceneId })
                    savePoseDraft(next)
                  }}
                >
                  {poseSceneOpts.length === 0 ? <option value="">（无关联场景）</option> : poseSceneOpts.map((o) => <option key={o.sceneId} value={o.sceneId}>{o.label}</option>)}
                </select>
                <div className="hint">
                  {lockedForScene.length ? `当前场景已应用 ${lockedForScene.length} 个姿态，可继续复用或新建。` : '当前场景还没有专用姿态，生成后锁定应用到该场景。'}
                  {applied ? ' 最近一次新姿态已锁定并应用。' : ''}
                </div>
              </div>

              {/* 2 姿态需求：蓝图定义，此处只读 + 回跳修改（2026-11-01 定义/执行分工裁决） */}
              <div className="pose-req-block">
                <div className="pose-req-head">
                  <span className="pose-req-title">2 姿态需求<span className="hint" style={{ fontWeight: 400 }}>（蓝图层定义 · 此处只读）</span></span>
                  <button type="button" className="btn secondary" disabled={poseBusy || props.poseReqBusyId === assetId || poseReqTodoCount === 0} onClick={() => props.onPoseRequirementsBatchGenerate?.(assetId)}>
                    {props.poseGeneratingId === assetId && props.poseDrawProgress ? `批量生成中（${props.poseDrawProgress.done}/${props.poseDrawProgress.total}）` : `按需求批量生成（${poseReqTodoCount}）`}
                  </button>
                  <button type="button" className="btn secondary" disabled={poseBusy} onClick={() => props.onGotoBlueprint?.()}>修改需求</button>
                </div>
                {poseReqs.length ? (
                  <div className="pose-req-list">
                    {poseReqs.map((req: any) => {
                      const reqId = String(req?.reqId || '')
                      const selected = reqId === activeReqIdEff
                      return (
                        <button
                          type="button"
                          key={reqId}
                          className={`pose-req-row ${selected ? 'active' : ''}`}
                          style={{ textAlign: 'left', borderColor: selected ? '#5eccff' : undefined }}
                          onClick={() => {
                            setActiveReqId(reqId)
                            const nextSceneId = String(req?.sceneId || poseSceneSel)
                            if (nextSceneId && nextSceneId !== poseSceneSel) {
                              const next = { ...poseDraft, sceneId: nextSceneId }
                              patchPoseDraft({ sceneId: nextSceneId })
                              savePoseDraft(next)
                            }
                          }}
                        >
                          <div className="pose-req-meta">
                            <span className="pose-req-scene" title={String(req?.sceneName || req?.sceneId || '')}>{(() => {
                              // 场景名解析：需求自带 sceneName 优先；手工需求常缺 sceneName，用关联场景选项把裸 sceneId 翻译成 #N 幕名
                              const rawName = String(req?.sceneName || '').trim()
                              if (rawName) return rawName
                              const sid = String(req?.sceneId || '').trim()
                              const resolved = sid ? (poseSceneOpts.find((o) => o.sceneId === sid)?.label || '') : ''
                              return resolved || sid || String(req?.label || '未命名')
                            })()}</span>
                            <span className="pose-req-chips">
                              {String(req?.pose || '').trim() ? <span className="pose-req-chip">{String(req.pose)}</span> : null}
                              {String(req?.view || '').trim() ? <span className="pose-req-chip">{String(req.view)}</span> : null}
                              {String(req?.action || '').trim() ? <span className="pose-req-chip">{String(req.action)}</span> : null}
                              {String(req?.expression || '').trim() ? <span className="pose-req-chip">{String(req.expression)}</span> : null}
                            </span>
                            {poseDoneReqIds.has(reqId) ? <span className="ai-storyboard-status ok">已有候选</span> : null}
                          </div>
                          <div className="hint" style={{ fontSize: 12 }}>{String(req?.promptZh || '').trim() || '（无提示词）'}</div>
                        </button>
                      )
                    })}
                  </div>
                ) : (
                  <div className="hint">还没有姿态需求：需求在蓝图层定义（选中预演元素 → 姿态需求清单），定义后回此处按需求出图。</div>
                )}
                {activeReqIdEff && activeHasPrompt ? (
                  <div className="story-lock-prompt-grid">
                    <div className="story-lock-prompt-field">
                      <span>当前需求 · 中文（只读）</span>
                      <textarea className="story-lock-textarea compact-rows" value={activeZh} readOnly />
                    </div>
                    <div className="story-lock-prompt-field">
                      <span>当前需求 · 英文（只读）</span>
                      <textarea className="story-lock-textarea compact-rows" value={activeEn} readOnly placeholder={activeZh.trim() ? '生成时由服务端自动翻译' : '（空）'} />
                    </div>
                  </div>
                ) : null}
                {blockMsg ? <div className="hint" style={{ color: '#fca5a5' }}>{blockMsg}</div> : null}
              </div>

              {/* 3 生成候选 */}
              <div className="pose-req-block">
                <div className="pose-req-head">
                  <span className="pose-req-title">3 生成候选</span>
                  <select
                    className="sel"
                    style={{ width: 'auto' }}
                    value={generateCount}
                    disabled={poseBusy}
                    onChange={(e) => setGenerateCount(Number(e.target.value) === 1 ? 1 : 4)}
                  >
                    <option value={4}>4 张候选</option>
                    <option value={1}>1 张候选</option>
                  </select>
                  <button
                    type="button"
                    className="btn secondary"
                    disabled={poseBusy || !activeHasPrompt || !activeReqExists}
                    title={!activeReqExists ? '当前没有可执行的蓝图姿态需求：请到蓝图层定义' : (!activeHasPrompt ? '当前需求没有提示词' : '按当前需求生成姿势候选')}
                    onClick={generateActive}
                  >
                    {props.poseGeneratingId === assetId ? '生成中…' : `生成 ${generateCount} 张候选`}
                  </button>
                  <button type="button" className="btn secondary" onClick={() => props.onPoseReviewAll?.(assetId)} disabled={poseBusy || poseCands.length === 0}>
                    {props.poseReviewingId === assetId ? '评分中…' : 'AI 评分'}
                  </button>
                  <button type="button" className="btn secondary" onClick={() => patchPoseDraft({ advancedOpen: !poseDraft.advancedOpen })}>
                    {poseDraft.advancedOpen ? '收起高级参数' : '高级参数'}
                  </button>
                  <button type="button" className="btn secondary" onClick={() => props.onPoseGalleryOpen?.(assetId)} disabled={poseBusy}>
                    {poseGalleryCount > 0 ? `管理图片（更多 ${poseGalleryCount}）` : '管理图片'}
                  </button>
                </div>
                <div className="hint">需求双稿在蓝图层维护；生成时中文缺英文稿由服务端自动翻译，英文手动修订不会被覆盖。</div>
              </div>
              {poseDraft.advancedOpen ? (
                <div className="pose-variant-advanced">
                  <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
                    <input
                      type="checkbox"
                      checked={poseDraft.ipadapterOn}
                      onChange={(e) => {
                        const next = { ...poseDraft, ipadapterOn: e.target.checked }
                        patchPoseDraft({ ipadapterOn: e.target.checked })
                        savePoseDraft(next)
                      }}
                    />
                    IPAdapter 身份锚定（默认开：姿势变体延续主参考图；可关闭或调权重/区间）
                  </label>
                  {poseDraft.ipadapterOn ? (
                    <div className="hint" style={{ marginBottom: 6 }}>实测档位：权重低（0.7）姿势更自由但服装颜色可能漂；权重高（0.9）服装全锁但姿势会被主参考站姿拉回。默认 0.8 / 0.2-0.9 折中，按评分结果微调。</div>
                  ) : null}
                  {poseDraft.ipadapterOn ? (
                    <div className="pose-pool-grid2" style={{ gridTemplateColumns: '1fr 1fr 1fr' }}>
                      <div className="pose-pool-field">
                        <label>权重</label>
                        <input
                          type="number"
                          step="0.05"
                          value={poseDraft.ipadapterWeight}
                          onChange={(e) => patchPoseDraft({ ipadapterWeight: Number(e.target.value) })}
                          onBlur={() => savePoseDraft(poseDraft)}
                        />
                      </div>
                      <div className="pose-pool-field">
                        <label>区间 start</label>
                        <input
                          type="number"
                          step="0.05"
                          value={poseDraft.ipadapterStartAt}
                          onChange={(e) => patchPoseDraft({ ipadapterStartAt: Number(e.target.value) })}
                          onBlur={() => savePoseDraft(poseDraft)}
                        />
                      </div>
                      <div className="pose-pool-field">
                        <label>区间 end</label>
                        <input
                          type="number"
                          step="0.05"
                          value={poseDraft.ipadapterEndAt}
                          onChange={(e) => patchPoseDraft({ ipadapterEndAt: Number(e.target.value) })}
                          onBlur={() => savePoseDraft(poseDraft)}
                        />
                      </div>
                    </div>
                  ) : null}
                </div>
              ) : null}

              {/* 4 审核并应用 */}
              <div className="pose-req-head" style={{ marginTop: 12 }}>
                <span className="pose-req-title">4 审核并应用</span>
              </div>
              {poseCands.length === 0 ? (
                <div className="pose-pool-empty">还没有候选。在蓝图层定义需求后，回此处点「生成候选」。</div>
              ) : (
                <div className="pose-pool-grid">
                  {poseCands.map((c: any, idx: number) => {
                    const cPath = String(c?.assetPath || '').trim()
                    const badge = poseScoreBadgeOf(c)
                    const lockingHere = props.poseLockingKey === `${assetId}:${cPath}`
                    const cReqId = String(c?.reqId || '')
                    const candidateApplied = Boolean(appliedMarks[`${assetId}:${String(c?.sceneId || poseSceneSel)}:${cPath}`])
                    // 表情差分：expr::{expression} 需求出的候选，默认锁定名「表情·X」——摆位按剧情表情自动选用
                    const defaultLockName = cReqId.startsWith('expr::') ? `表情·${cReqId.slice(6)}` : `姿势 ${poseVariants.length + 1}`
                    const lockName = String(poseDraft.lockNames[cPath] ?? defaultLockName)
                    return (
                      <div className="pose-pool-card" key={cPath || idx}>
                        <img alt="姿势候选" src={toProjectAssetUrl(projectId, cPath)} />
                        <span className="pose-pool-score" style={{ color: badge.color }} title={String(c?.reason || '未评分')}>{badge.text}</span>
                        <div className="pose-pool-card-ops">
                          <span className="hint">候选 {idx + 1}</span>
                          <span style={{ display: 'inline-flex', gap: 4 }}>
                            <button type="button" className="icon-btn" title="单张重抽（删除该候选并重新生成 1 张）" disabled={poseBusy} onClick={() => props.onPoseRedraw?.(assetId, cPath, poseGenOptsOf())}>↻</button>
                            <button type="button" className="icon-btn danger" title="删除该候选（文件保留在磁盘）" disabled={poseBusy} onClick={() => props.onPoseDeleteCandidate?.(assetId, cPath)}>✕</button>
                          </span>
                        </div>
                        <div className="pose-variant-lock-row">
                          <input
                            value={lockName}
                            onChange={(e) => patchPoseDraft({ lockNames: { ...poseDraft.lockNames, [cPath]: e.target.value } })}
                            placeholder={defaultLockName}
                            disabled={poseBusy || candidateApplied}
                          />
                          <button
                            type="button"
                            className="btn secondary"
                            disabled={poseBusy || !cPath || candidateApplied}
                            title={candidateApplied ? '该候选已锁定并应用' : '锁定候选并应用到对应场景'}
                            onClick={() => void applyPoseCandidate(cPath, String(lockName || defaultLockName).trim(), {
                              posePrompt: String(c?.promptEn || c?.promptZh || c?.posePrompt || poseDraft.posePromptEn || poseDraft.posePromptZh || '').trim(),
                              posePromptZh: String(c?.promptZh || poseDraft.posePromptZh || '').trim(),
                              posePromptEn: String(c?.promptEn || poseDraft.posePromptEn || '').trim()
                            }, String(c?.sceneId || poseSceneSel))}
                          >
                            {candidateApplied ? '已应用' : lockingHere ? '应用中…' : `锁定并应用到${poseSceneLabelOf(String(c?.sceneId || poseSceneSel), poseSceneOpts)}`}
                          </button>
                        </div>
                      </div>
                    )
                  })}
                </div>
              )}
              {poseVariants.length ? (
                <div>
                  <div className="hint" style={{ margin: '4px 0 6px' }}>已锁定姿势变体（可在摆放属性「图片（修改）」中选用）：</div>
                  <div className="pose-variant-list">
                    {poseVariants.map((v: any, idx: number) => {
                      const vSrc = toProjectAssetUrl(projectId, String(v?.projectAssetUri || v?.cutoutPath || '').trim())
                      return (
                        <div className="pose-variant-item" key={String(v?.id || idx)}>
                          {vSrc ? <img alt={String(v?.name || '姿势')} src={vSrc} /> : null}
                          <div style={{ fontWeight: 700, fontSize: 12 }}>{String(v?.name || `姿势 ${idx + 1}`)}</div>
                          {Number.isFinite(Number(v?.score)) ? <div className="hint">评分 {Math.round(Number(v.score))} 分</div> : null}
                          <button
                            type="button"
                            className="btn secondary"
                            disabled={poseBusy}
                            onClick={() => void (async () => {
                              const res = await props.onPoseDeleteVariant?.(assetId, String(v?.id || ''))
                              if (res && !res.ok) setBlockMsg(String(res.message || '该姿势变体正被摆放引用，无法删除'))
                            })()}
                          >
                            删除
                          </button>
                        </div>
                      )
                    })}
                  </div>
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}

      {/* ============ 状态变体（道具/地点等非角色资产专属） ============ */}
      {!isCharacterAsset ? (
        <div className="pose-variant-section" id={`state-asset-${assetId}`}>
          <div className="pose-variant-head" onClick={() => props.onStateExpandedChange(!props.stateExpanded)}>
            <span>状态变体</span>
            <span className="hint">{stateVariants.length ? `已锁定 ${stateVariants.length} 个 · 需求 ${stateReqs.length} 条` : (stateReqs.length ? `需求 ${stateReqs.length} 条` : '未提取需求')}</span>
            <span>{props.stateExpanded ? '－' : '＋'}</span>
          </div>
          {props.stateExpanded ? (
            <div className="pose-variant-body">
              <div className="pose-req-block">
                <div className="pose-req-head">
                  <span className="pose-req-title">剧情状态需求{stateReqs.length ? `（${stateReqs.length} 条）` : ''}</span>
                  <button
                    type="button"
                    className="btn secondary"
                    disabled={stateBusy}
                    title="AI 读取全故事场景，提取该事物在剧情中的视觉状态变化（候选制，可重复提取）"
                    onClick={() => props.onPropStatesExtract?.(assetId)}
                  >
                    {stateExtractingHere ? '提取中…' : (stateChecked ? '重新提取状态需求' : '提取状态需求')}
                  </button>
                </div>
                {stateMergeInto ? (
                  <div className="hint">已并入 {stateMergeContainerName}，状态在其状态图内呈现，本事物不再单独出状态图。</div>
                ) : stateReqs.length === 0 ? (
                  <div className="hint">{stateChecked ? '该事物在剧情中无视觉状态变化。' : '尚未提取状态需求。提取后每个状态可单独生成状态立绘，同一状态可生成多个版本。'}</div>
                ) : (
                  <div className="pose-req-list">
                    {stateReqs.map((req: any) => {
                      const reqKey = String(req?.stateKey || '').trim()
                      const reqSceneCount = Array.isArray(req?.sceneIds) ? req.sceneIds.length : 0
                      const versionCount = stateVariants.filter((v: any) => String(v?.stateKey || '').trim() === reqKey).length
                      const genningHere = Boolean(reqKey) && props.propStateGenKey === `${assetId}:${reqKey}`
                      return (
                        <div className={`pose-req-row ${versionCount ? 'done' : ''}`} key={reqKey}>
                          <div className="pose-req-meta">
                            <span className="pose-req-scene" title={String(req?.label || reqKey)}>{String(req?.label || reqKey || '未命名状态')}</span>
                            <span className="pose-req-chips">
                              <span className="pose-req-chip">适用 {reqSceneCount} 个场景</span>
                              {versionCount ? <span className="pose-req-chip">已出 {versionCount} 版</span> : null}
                            </span>
                            {versionCount ? <span className="ai-storyboard-status ok">已出图</span> : null}
                          </div>
                          {String(req?.description || '').trim() ? <div className="hint">{String(req.description)}</div> : null}
                          <div className="pose-req-actions" style={{ justifyContent: 'flex-end' }}>
                            <button
                              type="button"
                              className="btn secondary"
                              disabled={stateBusy || !reqKey}
                              title="按该状态生成 1 张状态立绘（生成→评审→抠图→登记全自动，进度见顶部任务条；同一状态可生成多个版本）"
                              onClick={() => props.onPropStateGenerate?.(assetId, { stateKey: reqKey, label: String(req?.label || reqKey).trim(), description: String(req?.description || '').trim() })}
                            >
                              {genningHere ? '生成中…' : '生成'}
                            </button>
                          </div>
                        </div>
                      )
                    })}
                  </div>
                )}
              </div>
              {stateVariants.length ? (
                <div>
                  <div className="hint" style={{ margin: '4px 0 6px' }}>已锁定状态变体：</div>
                  <div className="pose-variant-list">
                    {stateVariants.map((v: any, idx: number) => {
                      const vSrc = toProjectAssetUrl(projectId, String(v?.projectAssetUri || v?.cutoutPath || '').trim())
                      return (
                        <div className="pose-variant-item" key={String(v?.id || idx)} title={String(v?.reason || '')}>
                          {vSrc ? <img alt={String(v?.name || '状态')} src={vSrc} /> : null}
                          <div style={{ fontWeight: 700, fontSize: 12 }}>{String(v?.name || `状态 ${idx + 1}`)}</div>
                          {Number.isFinite(Number(v?.score)) ? <div className="hint">评分 {Math.round(Number(v.score))} 分</div> : null}
                        </div>
                      )
                    })}
                  </div>
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}
    </>
  )
}
