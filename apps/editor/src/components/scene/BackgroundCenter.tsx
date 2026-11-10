import { cloneElement, type ReactElement, type ReactNode } from 'react'

type Props = {
  sceneBoard: ReactElement<{ focusSceneId?: string }>
  locationBoard: ReactNode
  locationCount: number
  sceneCount: number
  // 2026-11-06 背景元素（scenery）：地形块/材料堆/环境装饰
  sceneryBoard?: ReactNode
  sceneryCount?: number
  focusSceneId?: string
  focusRequestId?: number
}

// 2026-11-09 用户裁决：背景中心不再用页签切换——与前景中心同构的分组卡片墙，同屏直出。
// 2026-11-10 边界裁决：背景中心只管理背景——① 背景本体（每幕场景背景图 + 地点模板锚点词）；
// ② 背景内元素（烘进/摆进背景层的地形、材料、装饰）。前景角色/道具一律在「前景中心」管理，不进这里。
export default function BackgroundCenter(props: Props) {
  return (
    <div className="background-center background-center-groups">
      <section className="story-lock-cardwall-group" data-group="scenes">
        <div className="story-lock-prompt-group-head">
          <span className="story-lock-prompt-group-title">背景本体</span>
          <span className="hint">（{props.sceneCount} 幕背景 + {props.locationCount} 个地点模板）</span>
        </div>
        <div className="hint" style={{ margin: '2px 0 10px' }}>每幕的满幅场景背景图，与各地点的环境锚点词；地点模板不单独出图，图片随各幕背景产出。</div>
        {cloneElement(props.sceneBoard, { focusSceneId: props.focusSceneId })}
        {props.locationBoard}
      </section>
      <section className="story-lock-cardwall-group" data-group="scenery">
        {props.sceneryBoard}
      </section>
    </div>
  )
}
