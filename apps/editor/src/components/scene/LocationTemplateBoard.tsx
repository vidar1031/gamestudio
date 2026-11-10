import { toProjectAssetUrl } from '../pose/assetUrl'
import AssignScenePicker from './AssignScenePicker'

type LocationBoardProps = {
  projectId: string
  assets: any[]
  scenes: any[]
  promptDrafts: Record<string, any>
  busy?: boolean
  onOpenAsset: (assetId: string) => void
  onOpenScene: (sceneId: string) => void
  onDelete: (assetId: string) => void
  // 2026-11-06 提示词批量生成（与事物链同源，仅生成本看板资产缺失项）+ 状态计数三色语义
  onGeneratePrompts?: (onlyAssetIds?: string[]) => void
  promptGenBusy?: boolean
  enhanceProgress?: { current: number; total: number; busy: boolean }
  enhanceFailures?: Array<{ assetId: string; label: string; reason: string }>
  // 2026-11-10 状态机化（用户裁决）：每幕场景背景是否已出（由场景背景看板 items 派生），
  // 卡片主按钮按 未分配→去分配 / 待出图→去该幕出图 / 已出图→用于 N 幕 流转。
  sceneBackgroundOf?: (sceneId: string) => boolean
  // 2026-11-10 幕分配管理（用户裁决：用户有能力编辑管理分配）——卡片上直接增删，服务端三处同步写口
  onAssignScene?: (assetId: string, sceneId: string, action: 'add' | 'remove') => void
}

function locationImageOf(asset: any, projectId: string) {
  const direct = String(asset?.primaryReferenceAssetUri || asset?.latestRecommendedReferenceAssetUri || '').trim()
  if (direct) return toProjectAssetUrl(projectId, direct)
  const batch = Array.isArray(asset?.latestReferenceBatch) ? asset.latestReferenceBatch : []
  const refs = Array.isArray(asset?.generatedRefs) ? asset.generatedRefs : []
  const candidate = batch[0] || refs[refs.length - 1]
  return toProjectAssetUrl(projectId, String(candidate?.assetPath || candidate?.projectAssetUri || candidate?.url || '').trim())
}

export function locationSceneIdsOf(asset: any, scenes: any[]) {
  const sceneIds = new Set(scenes.map((scene) => String(scene?.sceneId || '')))
  const id = String(asset?.id || '')
  const own = Array.isArray(asset?.sceneIds) ? asset.sceneIds.map(String).filter(Boolean) : []
  const linked = scenes.filter((scene) => {
    const assetIds = Array.isArray(scene?.assetIds) ? scene.assetIds : []
    const promptAssetIds = Array.isArray(scene?.promptAssets) ? scene.promptAssets.map((item: any) => String(item?.id || '')) : []
    return assetIds.includes(id) || promptAssetIds.includes(id)
  }).map((scene) => String(scene?.sceneId || '')).filter(Boolean)
  return [...new Set([...own, ...linked])].filter((id) => sceneIds.has(id))
}

export default function LocationTemplateBoard(props: LocationBoardProps) {
  const scenesById = new Map(props.scenes.map((scene) => [String(scene?.sceneId || ''), scene]))
  const sceneNameOf = (sceneId: string) => String(scenesById.get(sceneId)?.sceneName || sceneId)
  const hasBackgroundOf = (sceneId: string) => Boolean(props.sceneBackgroundOf?.(sceneId))
  const sceneIdsOf = (asset: any) => locationSceneIdsOf(asset, props.scenes)
  // 提示词轨（锚点就绪口径与卡片一致）：绿=全部就绪 / 黄=有缺失 / 红=有失败
  const promptReadyOf = (asset: any) => {
    const draft = props.promptDrafts[String(asset?.id || '')] || {}
    return Boolean(String(draft.promptZh || draft.promptEn || asset?.anchorPrompt || asset?.referencePromptEn || '').trim())
  }
  const promptReviewOf = (asset: any) => (props.promptDrafts[String(asset?.id || '')] || {})?.promptReview || null
  const promptDone = props.assets.filter(promptReadyOf).length
  const promptTotal = props.assets.length
  const boardFailures = (props.enhanceFailures || []).filter((f) => props.assets.some((a) => String(a?.id || '') === f.assetId))
  const promptTone = boardFailures.length ? 'bad' : (promptTotal > 0 && promptDone >= promptTotal ? 'ok' : 'warn')
  return (
    <div className="location-template-board" data-testid="location-template-board">
      <div className="story-lock-prompt-group-head">
        <span className="story-lock-prompt-group-title">地点模板</span>
        <span className="hint">（{props.assets.length}）</span>
      </div>
      {/* 2026-11-10 文案正向化（用户裁决：不再用"不要求/无需"否定句） */}
      <div className="hint" style={{ margin: '4px 0 10px' }}>环境锚点词直接写进各幕场景背景：先分配到场景，再去该幕背景管理出图；卡片图片即该幕背景图，随出图自动回填。</div>
      <div className="story-lock-grid-toolbar location-template-toolbar">
        <span className={`ai-storyboard-status ${promptTone}`} title="地点锚点提示词已就绪计数">
          提示词 {promptDone}/{promptTotal}{boardFailures.length ? ` · 失败 ${boardFailures.length}` : ''}
        </span>
        <span style={{ flex: 1 }} />
        <button
          className="btn secondary"
          type="button"
          disabled={Boolean(props.promptGenBusy) || props.busy || !promptTotal || promptDone >= promptTotal}
          onClick={() => props.onGeneratePrompts?.(props.assets.map((a) => String(a?.id || '')).filter(Boolean))}
          title="为本地点模板批量生成中文提示词（已就绪的跳过，不覆盖）"
        >
          {props.enhanceProgress?.busy ? `生成中…（${props.enhanceProgress.current}/${props.enhanceProgress.total}）` : `批量生成提示词（${promptTotal - promptDone}）`}
        </button>
      </div>
      <div className="location-template-grid">
        {props.assets.map((asset) => {
          const id = String(asset?.id || '').trim()
          const name = String(asset?.name || id || '未命名地点')
          const image = locationImageOf(asset, props.projectId)
          const sceneIds = sceneIdsOf(asset)
          const draft = props.promptDrafts[id] || {}
          const anchorReady = Boolean(String(draft.promptZh || draft.promptEn || asset?.anchorPrompt || asset?.referencePromptEn || '').trim())
          const review = promptReviewOf(asset)
          const reviewScore = Number(review?.score)
          // 2026-11-10：就绪（有词）与质量（评分）拆成两个徽标——低分黄点与绿色就绪不再互打架
          const reviewLow = review && Number.isFinite(reviewScore) && reviewScore < 50
          const pendingScenes = sceneIds.filter((sid) => !hasBackgroundOf(sid))
          const doneScenes = sceneIds.length - pendingScenes.length
          // 轨B（场景与图）状态机：未分配 → 已分配待出图 → 全部已出
          const trackB = !sceneIds.length
            ? { tone: 'warn' as const, label: '未分配场景', action: 'assign' as const, targetSceneId: '' }
            : pendingScenes.length
              ? { tone: 'warn' as const, label: `待出背景 ${pendingScenes.length}/${sceneIds.length} 幕`, action: 'render' as const, targetSceneId: pendingScenes[0] }
              : { tone: 'ok' as const, label: `已用于 ${sceneIds.length} 幕`, action: 'open' as const, targetSceneId: '' }
          const placeholder = trackB.action === 'assign'
            ? '先分配到场景'
            : (trackB.action === 'render' ? '背景图未出' : '')
          return (
            <article className="location-template-card" key={id} data-location-id={id}>
              <button type="button" className="location-template-main" onClick={() => props.onOpenAsset(id)} title="管理地点模板与提示词">
                <span className={`location-template-thumb ${image ? 'ready' : 'missing'}`}>
                  {image ? <img src={image} alt={name} /> : <span>{placeholder}</span>}
                </span>
                <span className="location-template-title">{name}</span>
                <span className="location-template-meta">
                  <span className={`ai-storyboard-status ${anchorReady ? 'ok' : 'warn'}`} title="锚点提示词是否已就绪">{anchorReady ? '锚点就绪' : '待起草'}</span>
                  {reviewLow ? (
                    <span className="ai-storyboard-status warn" title={String(review?.summary || '评审分低于保留阈值，建议重新生成提示词')}>评分 {Math.round(reviewScore)}/100·建议重生</span>
                  ) : null}
                  <span className={`ai-storyboard-status ${trackB.tone}`} title="场景分配与各幕背景图产出状态">{trackB.label}</span>
                </span>
              </button>
              <details className="location-template-prompt">
                <summary>环境提示词</summary>
                <div className="hint">{String(draft.promptZh || draft.promptEn || asset?.anchorPrompt || asset?.referencePromptEn || '（未起草）')}</div>
              </details>
              {/* 主按钮随状态机流转；分配可就地增删（2026-11-10 用户裁决：用户有能力编辑管理分配），
                  chip 跳转该幕背景管理、× 移除分配、末端选择器新增分配 */}
              <div className="location-template-scenes">
                {trackB.action === 'render' ? (
                  <button type="button" className="btn secondary" onClick={() => props.onOpenScene(trackB.targetSceneId)} title="进入该幕背景管理，出场景背景图">去出背景：{sceneNameOf(trackB.targetSceneId)}</button>
                ) : null}
                {sceneIds.map((sceneId) => {
                  const done = hasBackgroundOf(sceneId)
                  return (
                    <span key={sceneId} style={{ display: 'inline-flex', alignItems: 'center', gap: 2 }}>
                      <button type="button" className="btn secondary" onClick={() => props.onOpenScene(sceneId)} title={done ? '该幕背景已出，进入背景管理' : '该幕背景未出，进入背景管理出图'}>
                        {done ? '✓' : '○'} {sceneNameOf(sceneId)}
                      </button>
                      {props.onAssignScene ? (
                        <button type="button" className="icon-btn" style={{ fontSize: 11, padding: '0 4px' }} title="从该幕移除本地点（场景出图与摆位同步剔除）" onClick={() => props.onAssignScene?.(id, sceneId, 'remove')}>×</button>
                      ) : null}
                    </span>
                  )
                })}
                {props.onAssignScene ? (
                  <AssignScenePicker
                    scenes={props.scenes.filter((s) => !sceneIds.includes(String(s?.sceneId || ''))).map((s) => ({ id: String(s?.sceneId || ''), name: String(s?.sceneName || s?.sceneId || '') })).filter((s) => s.id)}
                    busy={props.busy}
                    onAssign={(sid) => props.onAssignScene?.(id, sid, 'add')}
                  />
                ) : null}
              </div>
              <div className="location-template-actions">
                <button type="button" className="btn secondary" onClick={() => props.onOpenAsset(id)}>管理</button>
                <button type="button" className="btn secondary" style={{ color: '#fca5a5' }} disabled={props.busy} onClick={() => props.onDelete(id)}>删除</button>
              </div>
            </article>
          )
        })}
      </div>
      {!props.assets.length ? <div className="hint">尚无地点模板，可先在蓝图做场景元素分析。</div> : null}
    </div>
  )
}
