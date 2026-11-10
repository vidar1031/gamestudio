// X 波（2026-10-28 用户裁决：最小可生成完整细节尺寸，交互故事不出大图）：全链出图尺寸策略表。
// 消费纪律：出图链各环节从本表取尺寸；stylePreset.sizes 同名键可覆盖（与 getStoryAssetRenderProfile 同款预设语义）。
// 越表生成（调用方显式传尺寸）允许但必须明说——保留调用方覆盖通道。
export const RENDER_SIZE_TABLE = {
  primary_reference: [768, 1152], // 主参考/立绘（SDXL 解剖细节下限，维持现状不再放大）
  pose_variant: [768, 1152], // 姿态变体同立绘档
  lineart: [768, 1152], // 线稿/ControlNet hint 与主参考同源尺寸（对齐需要）
  model_sheet: [1344, 768], // 三视图 sheet 横图（三栏各 448×768，总像素≈1MP SDXL 甜区）
  model_sheet_cell: [448, 768], // sheet 等宽切割后单视角
  scene_background: [720, 1280], // 场景背景（舞台原生正好，不再上浮）
  prop_single: [768, 768], // 道具单件
  scenery_element: [768, 768] // 背景元素单件（地形块/材料堆/环境装饰，2026-11-06）
}

/** 取尺寸（stylePreset.sizes[key] 覆盖优先；键不存在回退内置表；返回 [w,h]） */
export function renderSizeOf(key, stylePreset) {
  const hit = stylePreset && typeof stylePreset === 'object' && stylePreset.sizes && Array.isArray(stylePreset.sizes[key]) && stylePreset.sizes[key].length >= 2
    ? stylePreset.sizes[key]
    : null
  const base = RENDER_SIZE_TABLE[key] || [768, 1152]
  const w = Number(hit ? hit[0] : base[0])
  const h = Number(hit ? hit[1] : base[1])
  return [Number.isFinite(w) && w > 0 ? Math.round(w) : base[0], Number.isFinite(h) && h > 0 ? Math.round(h) : base[1]]
}
