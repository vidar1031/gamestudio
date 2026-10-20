// 角色音色库（2026-10-20，ui_设置定义.md §7.6）：edge-tts 免费音色 + 音高/语速微调派生。
// 覆盖 女声/男声/童声（男孩/女孩）/长辈 + 方言彩蛋特色组；say 离线兜底三条（无音高可调）。
// 故事角色绑定复用：经 resolveTtsVoice 归一 预设id/裸引擎音名 → { engineVoice, pitch, rateAdjust }。
// 真相源：edge_tts --list-voices 实跑验证（2026-10-20）。

// pitch：Hz 偏移（edge-tts --pitch=±Hz）；rateAdjust：语速百分比偏移（与语速倍率叠加，edge-tts --rate=±%）
export const EDGE_VOICE_GROUPS = [
  {
    group: '女声',
    items: [
      { id: 'female_gentle', label: '温柔女声', engineVoice: 'zh-CN-XiaoxiaoNeural', pitch: 0, rateAdjust: 0, trait: 'Warm' },
      { id: 'female_lively', label: '活泼女声', engineVoice: 'zh-CN-XiaoyiNeural', pitch: 0, rateAdjust: 0, trait: 'Lively' }
    ]
  },
  {
    group: '男声',
    items: [
      { id: 'male_sunshine', label: '阳光男声', engineVoice: 'zh-CN-YunxiNeural', pitch: 0, rateAdjust: 0, trait: 'Lively·Sunshine' },
      { id: 'male_deep', label: '浑厚男声', engineVoice: 'zh-CN-YunyangNeural', pitch: 0, rateAdjust: 0, trait: 'Professional·Reliable' },
      { id: 'male_passion', label: '激昂男声', engineVoice: 'zh-CN-YunjianNeural', pitch: 0, rateAdjust: 0, trait: 'Passion' }
    ]
  },
  {
    group: '童声',
    items: [
      // YunxiaNeural：Cute 卡通/小说声线，作童声基底
      { id: 'child_boy', label: '男童声', engineVoice: 'zh-CN-YunxiaNeural', pitch: 6, rateAdjust: 0, trait: 'Cute（基底）' },
      { id: 'child_girl', label: '女童声', engineVoice: 'zh-CN-XiaoyiNeural', pitch: 20, rateAdjust: 4, trait: 'Lively + 音高微调' }
    ]
  },
  {
    group: '长辈',
    items: [
      { id: 'elder_male', label: '老年男声', engineVoice: 'zh-CN-YunyangNeural', pitch: -18, rateAdjust: -8, trait: '降调放慢' },
      { id: 'elder_female', label: '老年女声', engineVoice: 'zh-CN-XiaoxiaoNeural', pitch: -16, rateAdjust: -8, trait: '降调放慢' }
    ]
  },
  {
    group: '特色',
    items: [
      { id: 'dialect_liaoning', label: '东北女声（方言彩蛋）', engineVoice: 'zh-CN-liaoning-XiaobeiNeural', pitch: 0, rateAdjust: 0, trait: '方言' },
      { id: 'dialect_shaanxi', label: '陕西女声（方言彩蛋）', engineVoice: 'zh-CN-shaanxi-XiaoniNeural', pitch: 0, rateAdjust: 0, trait: '方言' }
    ]
  }
]

// say（macOS 内置·离线兜底）：无音高可调
export const SAY_VOICE_PRESETS = [
  { id: 'say_tingting', label: '婷婷（女声）', engineVoice: 'Tingting', pitch: 0, rateAdjust: 0 },
  { id: 'say_meijia', label: '美佳（女声）', engineVoice: 'Meijia', pitch: 0, rateAdjust: 0 },
  { id: 'say_sinan', label: '思南（男声）', engineVoice: 'Sinan', pitch: 0, rateAdjust: 0 }
]

function allPresets() {
  return [...EDGE_VOICE_GROUPS.flatMap((g) => g.items), ...SAY_VOICE_PRESETS]
}

// 分组清单（编辑器音色下拉直接消费）；doubao/local 无预设（手填）
export function listTtsVoiceGroups(provider) {
  const p = String(provider || '').trim().toLowerCase()
  if (p === 'edge') return EDGE_VOICE_GROUPS.map((g) => ({ group: g.group, items: g.items.map((x) => ({ ...x })) }))
  if (p === 'say') return [{ group: '本机离线', items: SAY_VOICE_PRESETS.map((x) => ({ ...x })) }]
  return []
}

/**
 * 音色归一：预设 id 或裸引擎音名（兼容旧配置里直接存的 zh-CN-XiaoxiaoNeural / Tingting）。
 * @returns {{ id: string, label: string, engineVoice: string, pitch: number, rateAdjust: number } | null}
 */
export function resolveTtsVoice(voice) {
  const v = String(voice || '').trim()
  if (!v) return null
  const presets = allPresets()
  const byId = presets.find((x) => x.id === v)
  if (byId) return { ...byId }
  const byEngine = presets.find((x) => x.engineVoice.toLowerCase() === v.toLowerCase())
  if (byEngine) return { ...byEngine }
  // 自定义引擎音名：原样透传，不做音高/语速微调
  return { id: v, label: v, engineVoice: v, pitch: 0, rateAdjust: 0 }
}
