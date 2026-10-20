import {
  type StageConfigV1
} from '../../../api'
import { normalizeStageV1 } from './normalize'
import { numberOr } from './utils'

export type StageViewport = {
  stageW: number
  stageH: number
  scale: number
  offsetX: number
  offsetY: number
  scaleMode: 'contain' | 'cover'
}

export function computeStageViewport(stageCfg: StageConfigV1 | undefined, viewW: number, viewH: number): StageViewport {
  const s = normalizeStageV1(stageCfg)
  const stageW = Math.max(1, Math.floor(numberOr(s.width, 720)))
  const stageH = Math.max(1, Math.floor(numberOr(s.height, 1280)))
  const scaleMode = String(s.scaleMode || 'contain') === 'cover' ? 'cover' : 'contain'
  const sx = viewW / stageW
  const sy = viewH / stageH
  const scale = scaleMode === 'cover' ? Math.max(sx, sy) : Math.min(sx, sy)
  const offsetX = (viewW - stageW * scale) / 2
  const offsetY = (viewH - stageH * scale) / 2
  return { stageW, stageH, scale, offsetX, offsetY, scaleMode }
}
