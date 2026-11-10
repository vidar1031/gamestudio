import { toProjectAssetUrl } from '../pose/assetUrl'
import { locationSceneIdsOf } from './LocationTemplateBoard'
import AssignScenePicker from './AssignScenePicker'

// 背景元素看板（2026-11-06 scenery 类目）：地形块/材料堆/环境装饰——独立出图透明立绘（非满幅），
// 经预演锚占摆入背景层与角色层之间。卡片只导航与状态呈现；出图/锁定在资产详情（同源道具链）。
// 2026-11-10 状态机对齐地点模板（用户裁决：背景/背景内/前景三层不混乱，各自状态机+深链管理位）。
type SceneryBoardProps = {
  projectId: string
  assets: any[]
  scenes: any[]
  promptDrafts?: Record<string, any>
  busy?: boolean
  onOpenAsset: (assetId: string) => void
  onOpenScene: (sceneId: string) => void
  onDelete: (assetId: string) => void
  // 2026-11-06 提示词批量生成（与事物链同源，仅生成本看板资产缺失项）+ 状态计数三色语义
  onGeneratePrompts?: (onlyAssetIds?: string[]) => void
  promptGenBusy?: boolean
  enhanceProgress?: { current: number; total: number; busy: boolean }
  enhanceFailures?: Array<{ assetId: string; label: string; reason: string }>
  // 2026-11-10：每幕场景背景是否已出（场景 chip 标注与地点模板同口径）
  sceneBackgroundOf?: (sceneId: string) => boolean
  // 2026-11-10 幕分配管理（用户裁决：用户有能力编辑管理分配）——卡片上直接增删，服务端三处同步写口
  onAssignScene?: (assetId: string, sceneId: string, action: 'add' | 'remove') => void
}

function sceneryImageOf(asset: any, projectId: string) {
  const direct = String(asset?.primaryReferenceAssetUri || asset?.latestRecommendedReferenceAssetUri || '').trim()
  if (direct) return toProjectAssetUrl(projectId, direct)
  const batch = Array.isArray(asset?.latestReferenceBatch) ? asset.latestReferenceBatch : []
  const refs = Array.isArray(asset?.generatedRefs) ? asset.generatedRefs : []
  const candidate = batch[0] || refs[refs.length - 1]
  return toProjectAssetUrl(projectId, String(candidate?.assetPath || candidate?.projectAssetUri || candidate?.url || '').trim())
}

// 出图/锁定轨（背景内元素的核心生命周期）：待抽卡 → 待选定锁定 → 已锁定
function sceneryStatusOf(asset: any): { label: string; ok: boolean; action: 'draw' | 'select' | 'done' } {
  if (String(asset?.primaryReferenceAssetUri || '').trim() || String(asset?.referenceStatus || '').trim() === 'ready') {
    return { label: '已锁定', ok: true, action: 'done' }
  }
  const batch = Array.isArray(asset?.latestReferenceBatch) ? asset.latestReferenceBatch : []
  const refs = Array.isArray(asset?.generatedRefs) ? asset.generatedRefs : []
  if (batch.length || refs.length) return { label: '待选定锁定', ok: false, action: 'select' }
  return { label: '待抽卡', ok: false, action: 'draw' }
}

export default function SceneryElementBoard(props: SceneryBoardProps) {
  const scenesById = new Map(props.scenes.map((scene) => [String(scene?.sceneId || ''), scene]))
  const sceneNameOf = (sceneId: string) => String(scenesById.get(sceneId)?.sceneName || sceneId)
  const hasBackgroundOf = (sceneId: string) => Boolean(props.sceneBackgroundOf?.(sceneId))
  // 提示词状态计数（缺中文稿=缺失）：绿=全部完成 / 黄=有缺失 / 红=有失败
  const promptReadyOf = (asset: any) => {
    const draft = (props.promptDrafts || {})[String(asset?.id || '')] || {}
    return Boolean(String(draft.promptZh || draft.promptEn || asset?.anchorPrompt || asset?.referencePromptEn || '').trim())
  }
  const promptReviewOf = (asset: any) => ((props.promptDrafts || {})[String(asset?.id || '')] || {})?.promptReview || null
  const promptDone = props.assets.filter(promptReadyOf).length
  const promptTotal = props.assets.length
  const boardFailures = (props.enhanceFailures || []).filter((f) => props.assets.some((a) => String(a?.id || '') === f.assetId))
  const promptTone = boardFailures.length ? 'bad' : (promptTotal > 0 && promptDone >= promptTotal ? 'ok' : 'warn')
  return (
    <div className="location-template-board" data-testid="scenery-element-board">
      <div className="story-lock-prompt-group-head">
        <span className="story-lock-prompt-group-title">背景内元素</span>
        <span className="hint">（{props.assets.length}）</span>
      </div>
      {/* 2026-11-10 文案正向化：讲清"背景内"定位与图片出处；与背景本体/前景中心的边界一眼可辨 */}
      <div className="hint" style={{ margin: '4px 0 10px' }}>烘进背景层的地形、材料、装饰（如稻草堆、泥巴地）：在元素详情独立出透明立绘并锁定；分配到幕后随摆位进入该幕背景层与前景之间，多幕复用同一立绘。</div>
      <div className="story-lock-grid-toolbar location-template-toolbar">
        <span className={`ai-storyboard-status ${promptTone}`} title="背景元素提示词已生成计数">
          提示词 {promptDone}/{promptTotal}{boardFailures.length ? ` · 失败 ${boardFailures.length}` : ''}
        </span>
        <span style={{ flex: 1 }} />
        <button
          className="btn secondary"
          type="button"
          disabled={Boolean(props.promptGenBusy) || props.busy || !promptTotal || promptDone >= promptTotal}
          onClick={() => props.onGeneratePrompts?.(props.assets.map((x) => String(x?.id || '')).filter(Boolean))}
          title="为背景元素批量生成中文提示词（已生成的跳过，不覆盖）"
        >
          {props.enhanceProgress?.busy ? `生成中…（${props.enhanceProgress.current}/${props.enhanceProgress.total}）` : `批量生成提示词（${promptTotal - promptDone}）`}
        </button>
      </div>
      <div className="location-template-grid">
        {props.assets.map((asset) => {
          const id = String(asset?.id || '').trim()
          const name = String(asset?.name || id || '未命名元素')
          const image = sceneryImageOf(asset, props.projectId)
          const sceneIds = locationSceneIdsOf(asset, props.scenes)
          const status = sceneryStatusOf(asset)
          const draft = (props.promptDrafts || {})[id] || {}
          const promptReady = Boolean(String(draft.promptZh || draft.promptEn || asset?.anchorPrompt || asset?.referencePromptEn || '').trim())
          const review = promptReviewOf(asset)
          const reviewScore = Number(review?.score)
          const reviewLow = review && Number.isFinite(reviewScore) && reviewScore < 50
          const mainActionLabel = status.action === 'draw' ? '去抽卡' : (status.action === 'select' ? '去选定锁定' : '管理')
          return (
            <article className="location-template-card" key={id} data-scenery-id={id}>
              <button type="button" className="location-template-main" onClick={() => props.onOpenAsset(id)} title="管理背景元素出图与锁定">
                <span className={`location-template-thumb ${image ? 'ready' : 'missing'}`}>
                  {image ? <img src={image} alt={name} /> : <span>{status.action === 'select' ? '候选待选定' : '立绘未出'}</span>}
                </span>
                <span className="location-template-title">{name}</span>
                <span className="location-template-meta">
                  <span className={`ai-storyboard-status ${promptReady ? 'ok' : 'warn'}`} title="提示词是否已就绪">{promptReady ? '提示词就绪' : '待起草'}</span>
                  {reviewLow ? (
                    <span className="ai-storyboard-status warn" title={String(review?.summary || '评审分低于保留阈值，建议重新生成提示词')}>评分 {Math.round(reviewScore)}/100·建议重生</span>
                  ) : null}
                  <span className={`ai-storyboard-status ${status.ok ? 'ok' : 'warn'}`} title="透明立绘出图与锁定状态">{status.label}</span>
                  <span className={`ai-storyboard-status ${sceneIds.length ? 'ok' : 'warn'}`} title="分配到的幕数">{sceneIds.length ? `已分配 ${sceneIds.length} 幕` : '未分配场景'}</span>
                </span>
              </button>
              {/* 主按钮随出图/锁定轨流转；场景 chip 标注该幕背景是否已出（与地点模板同口径）；
                  分配可就地增删（2026-11-10 用户裁决），chip 跳转该幕背景管理、× 移除分配 */}
              <div className="location-template-scenes">
                {status.action !== 'done' ? (
                  <button type="button" className="btn secondary" onClick={() => props.onOpenAsset(id)} title="进入元素详情出图与锁定">{mainActionLabel}</button>
                ) : null}
                {sceneIds.map((sceneId) => {
                  const done = hasBackgroundOf(sceneId)
                  return (
                    <span key={sceneId} style={{ display: 'inline-flex', alignItems: 'center', gap: 2 }}>
                      <button type="button" className="btn secondary" onClick={() => props.onOpenScene(sceneId)} title={done ? '该幕背景已出，进入背景管理' : '该幕背景未出，进入背景管理出图'}>
                        {done ? '✓' : '○'} {sceneNameOf(sceneId)}
                      </button>
                      {props.onAssignScene ? (
                        <button type="button" className="icon-btn" style={{ fontSize: 11, padding: '0 4px' }} title="从该幕移除本元素（场景出图与摆位同步剔除）" onClick={() => props.onAssignScene?.(id, sceneId, 'remove')}>×</button>
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
      {!props.assets.length ? <div className="hint">尚无背景元素：在蓝图做场景元素分析时，地形块/材料堆/环境装饰会归入此类（如稻草堆、泥巴地、岩石区）。</div> : null}
    </div>
  )
}
