// 2026-09-02 姿势变体配方库：内置配方（中英双稿）+ 常用排除 chips 常量。
// 供锁定向导姿势变体区「配方」弹层与负向 chips 行使用；项目自定义配方存 project.state.aiBackground.customPoseRecipes。

export type PoseRecipe = {
  id: string
  name: string
  forKind: 'character' | 'prop' | 'any'
  promptZh: string
  promptEn: string
}

// 内置配方：角色姿势均带服装延续约束；道具配方带单件/object only 约束（对应锁定测试的 lockProfile 语义）
export const BUILTIN_POSE_RECIPES: PoseRecipe[] = [
  {
    id: 'char-back-point',
    name: '背身·指向',
    forKind: 'character',
    promptZh: '背身视角，背对镜头，伸右臂明确指向目标方向，身体微前倾，表情投入，服装与主参考保持一致，不得换装',
    promptEn:
      '(back view, view from behind, facing away from viewer:1.4), right arm extended pointing clearly toward the target, body leaning slightly forward, engaged expression, outfit consistent with the main reference, no costume change'
  },
  {
    id: 'char-back-lookback-hips',
    name: '背身·回望叉腰',
    forKind: 'character',
    promptZh: '背身视角，背对镜头，双手叉腰，头部侧转回望镜头方向，表情自信，服装与主参考保持一致，不得换装',
    promptEn:
      '(back view, view from behind, facing away from viewer:1.4), hands on hips, head turned looking back toward viewer over shoulder, confident expression, outfit consistent with the main reference, no costume change'
  },
  {
    id: 'char-front-stand',
    name: '正面·站姿立绘',
    forKind: 'character',
    promptZh: '正面全身视角，自然站姿，面朝镜头，表情平静，双臂自然下垂，服装与主参考保持一致，不得换装',
    promptEn:
      'full body front view, natural standing pose, facing viewer, calm expression, arms relaxed at sides, outfit consistent with the main reference, no costume change'
  },
  {
    id: 'char-side-walk',
    name: '侧面·行走',
    forKind: 'character',
    promptZh: '正侧面全身视角，行走中，一腿前一腿后，手臂自然摆动，表情专注看向前方，服装与主参考保持一致，不得换装',
    promptEn:
      'full body side view, walking mid-stride, one leg forward one leg back, arms swinging naturally, focused expression looking ahead, outfit consistent with the main reference, no costume change'
  },
  {
    id: 'char-bend-down',
    name: '弯腰/蹲下动作',
    forKind: 'character',
    promptZh: '正面微侧视角，弯腰蹲下，双膝弯曲，双臂向前下方伸出，表情专注，服装与主参考保持一致，不得换装',
    promptEn:
      'front view with slight angle, bending down into a crouch, knees bent, arms reaching forward and down, focused expression, outfit consistent with the main reference, no costume change'
  },
  {
    id: 'prop-single',
    name: '道具·单件白底参考图',
    forKind: 'prop',
    promptZh: '单个道具，完整居中展示，白底，无手持无人物，无场景',
    promptEn: 'single object only, fully visible and centered, plain white background, no hands, no people, no scene'
  },
  {
    id: 'prop-stack',
    name: '道具·堆叠物（稻草堆/木柴堆类）',
    forKind: 'prop',
    promptZh: '堆叠物道具，松散堆叠，体积感明确，白底，无人物无场景',
    promptEn: '(stacked pile object, loosely heaped, clear volume:1.3), object only, plain background, no people, no scene'
  },
  {
    id: 'prop-ground',
    name: '道具·地面块（泥土地类）',
    forKind: 'prop',
    promptZh: '一块地面/地块，轻微俯视角度，边缘清晰完整，无人物无建筑',
    promptEn: 'a single patch of ground terrain, slight top-down view, clear complete edges, object only, no people, no buildings'
  }
]

// 常用排除 chips：点击把中文短语追加进姿势负向栏（去重）
export const POSE_NEGATIVE_CHIPS: { label: string; phrase: string }[] = [
  { label: '人物', phrase: '人物' },
  { label: '多只动物', phrase: '多只动物' },
  { label: '场景背景', phrase: '场景背景' },
  { label: '换装', phrase: '换装' },
  { label: '写实', phrase: '写实' },
  { label: '3D渲染', phrase: '3D渲染' },
  { label: '文字水印', phrase: '文字水印' },
  { label: '多余道具', phrase: '多余道具' }
]

// 组装槽位的视角选项（槽位组装弹层用）
export const POSE_VIEW_OPTIONS = ['正面全身', '背身', '侧面', '微侧', '俯视']

// ============ 2026-09-02 常用提示词预设（配置 drawer「提示词预设」区） ============
// 追加到全局正向/负向的中英文栏；textEn 缺失时英文栏标注「待翻译」不自动调翻译；按文本片段去重。
export type PromptPreset = {
  id: string
  name: string
  kind: 'positive' | 'negative'
  textZh: string
  textEn?: string
}

export const PROMPT_PRESETS: PromptPreset[] = [
  {
    id: 'style-picture-book',
    name: '绘本平涂约束',
    kind: 'positive',
    textZh: '卡通童话绘本风，flat 2D 插画，粗描边，赛璐璐平涂，暖色柔和配色',
    textEn: 'cartoon fairy tale picture book style, flat 2D illustration, bold clean outlines, cel shading, warm soft color palette'
  },
  {
    id: 'chroma-character',
    name: '绿幕角色约束',
    kind: 'positive',
    textZh: '纯绿幕背景（RGB 0,255,0），单一角色居中，全身，边缘干净清晰',
    textEn:
      'solid pure green screen background (RGB 0,255,0 chroma key green), flat uniform green, no gradient, no texture, single character centered, full body, clean sharp edges'
  },
  {
    id: 'chroma-prop',
    name: '绿幕道具约束',
    kind: 'positive',
    textZh: '纯绿幕背景，单件道具居中完整，无角色无人物，边缘干净清晰',
    textEn:
      'solid pure green screen background (RGB 0,255,0 chroma key green), single object centered, fully visible, no character, no people, clean sharp edges'
  },
  {
    id: 'view-back',
    name: '背身视角配方',
    kind: 'positive',
    textZh: '背身视角，背对镜头，面朝远离镜头方向（1.4 加权）',
    textEn: '(back view, view from behind, facing away from viewer:1.4)'
  },
  {
    id: 'costume-keep',
    name: '服装延续约束',
    kind: 'positive',
    textZh: '服装与主参考保持一致，不得换装',
    textEn: 'outfit consistent with the main reference, no costume change'
  },
  {
    id: 'neg-general',
    name: '通用负向包',
    kind: 'negative',
    textZh: '文字，水印，低质量，模糊，畸形，多人物，复杂背景',
    textEn: 'text, watermark, low quality, blurry, deformed, multiple people, complex background'
  },
  {
    id: 'neg-realistic',
    name: '写实排除包',
    kind: 'negative',
    textZh: '写实，照片级真实，3D 渲染，CGI，油画，厚涂',
    textEn: 'realistic, photorealistic, 3d render, cgi, oil painting, impasto'
  }
]
