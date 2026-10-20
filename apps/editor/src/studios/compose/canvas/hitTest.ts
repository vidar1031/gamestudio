import { Sprite } from 'pixi.js'
import { getAlphaMap } from './textures'

// 像素级命中：世界点 → worldTransform 逆变换得纹理局部点（翻转/缩放/旋转天然覆盖）→ alpha > 10 才算命中
export function hitPlacementSprite(sp: Sprite, gx: number, gy: number): boolean {
  try {
    const tex = sp.texture
    const tw = Number(tex.width) || 0
    const th = Number(tex.height) || 0
    if (!tw || !th) return false
    const local = sp.worldTransform.applyInverse({ x: gx, y: gy })
    // anchor (0.5,1)：局部空间纹理范围 x∈[-tw/2, tw/2]，y∈[-th, 0]
    const lx = local.x + tw * 0.5
    const ly = local.y + th
    if (lx < 0 || ly < 0 || lx >= tw || ly >= th) return false
    const am = getAlphaMap(tex)
    if (!am) return true // alpha 图不可用（跨域/未就绪）：回退矩形命中
    const px = Math.min(am.width - 1, Math.max(0, Math.floor((lx / tw) * am.width)))
    const py = Math.min(am.height - 1, Math.max(0, Math.floor((ly / th) * am.height)))
    return am.data[py * am.width + px] > 10
  } catch {
    return false
  }
}
