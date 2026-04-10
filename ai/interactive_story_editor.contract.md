# 交互故事编辑器（节点式）开发契约 / AI Prompt Contract

> 本文件是 **AI 专用的稳定开发契约**。后续任何 UI/代码/接口改动必须以本契约为准。
>
> 你正在开发的是一个【节点式交互故事编辑器】：
> - 不是 Demo
> - 不是 JSON 编辑器
> - 不要求新用户理解 JSON
>
> 核心原则：
> - **对象优先于数据**（用户操作对象，不操作 JSON）
> - **结构优先于视觉**（先能正确表达节点/分支/角色/资源，再优化美术效果）
> - **编辑器优先于展示**（编辑闭环第一，预览其次）
> - **分区职责不可混合**（左/中/右/顶职责固定）

---

## A. 本次实现涉及的对象（Node / Character / Asset）

### 1) Node（节点）
- Node 是故事结构的核心单元，分两类：
  - `Scene`：包含文本与选项（分支）
  - `Ending`：结局节点（无选项）
- Node **可引用**：
  - 背景资源（background asset）
  - 出场角色列表（CharacterPlacement[]）

### 2) Character（角色）
- Character 是 **独立实体**（不绑定具体 Node）。
- Character 必须具备：
  - 图片（AssetRef）
  - 默认属性（如默认大小/锚点等，可选）
- Node 中出现角色是通过 **Placement（摆放）** 来实现：
  - 位置（x, y）
  - 大小（scale 或 heightRatio）
  - 角度（rotation）
  - 层级（zIndex，可选）

### 3) Asset（资源）
- Asset 是可复用资源实体（图片/音频/字体…）。
- Asset 必须可被：
  - Character 引用（角色图片）
  - Node 引用（背景图、音效等）
- AI 生成属于 Asset 的一种来源（source = `ai`）。

---

## B. 涉及的 UI 区域（固定布局）

页面结构 **必须固定为**：
1) **顶部：全局行为（TopBar）**
2) **左侧：结构管理（Structure Panel）**
3) **中央：画布预览（Canvas Preview）**
4) **右侧：属性编辑（Inspector Panel）**

---

## C. 每个区域新增/修改的职责（必须明确归属）

### 1) 顶部 TopBar（全局行为）
只允许出现 **全局行为**（不依赖“当前节点字段编辑”）：
- Project：新建/打开/保存/导出
- Undo/Redo（可选）
- 运行模式切换：编辑 / 预览（可选，或默认始终预览）
- 全局校验：结构错误提示入口（如断链、无 start、循环等）

禁止：
- 在顶部编辑 Node 文本、背景、角色参数
- 顶部出现“同一操作的第二入口”（例如右侧已能保存，顶部再做保存表单）

### 2) 左侧 Structure Panel（结构管理）
只管理 **结构与导航**，不编辑内容：
- Node 列表（Scene / Ending）与筛选
- 新建节点（Scene/Ending）
- 连接关系管理（可在左侧以“选项列表 + 指向节点”呈现，编辑发生在右侧）
- Story 起点（Start Node）选择
- Character 列表（角色库）：新增/删除/重命名
- Asset 列表（资源库）：导入/上传/AI 生成入口可在右侧（左侧只展示与选择）

禁止：
- 左侧出现 Node 文本编辑框、背景 URL 输入、角色坐标输入
- 左侧展示/编辑 JSON
- 左侧同时承担“创建 + 编辑表单”导致交互模糊

### 3) 中央 Canvas Preview（故事呈现）
只负责 **预览故事效果**：
- 预览当前选中节点（或从 start 运行）
- 展示背景、角色摆放、文本与选项按钮
- 点击选项可模拟跳转

禁止：
- 出现任何配置字段（输入框、下拉、数值框）
- 出现结构树/列表
- 以 JSON 形式展示节点数据

### 4) 右侧 Inspector Panel（唯一编辑入口）
右侧是 **唯一的编辑入口**，根据当前 selection 显示不同编辑器：
- Node Inspector（编辑节点内容与表现）
- Character Inspector（编辑角色实体）
- Placement Inspector（编辑某个节点里的某个角色摆放）
- Asset Inspector（资源详情/替换/AI 生成/尺寸信息）

禁止：
- 同一个字段在多个区域出现（例如背景既能在顶部改，又能在右侧改）
- 右侧之外出现“编辑字段”

---

## D. 交互校验条件（必须满足）

1. 所有功能都能明确归属到某个 UI 区域（Top / Left / Center / Right）
2. 不存在“同时创建又编辑”的模糊交互  
   - 例：点击“新建节点”后，必须进入明确状态：创建完成并选中该节点 → 右侧进入 Node 编辑；或进入“新建向导”页面（P1）
3. 新用户不需要理解 JSON 就能使用  
   - JSON 仅用于内部存储与导出，UI 不暴露
4. 同一个操作不会在多个地方出现  
   - 例如“添加角色”只能在左侧角色库（创建实体），摆放角色只能在右侧 Node/Placement（添加到节点）

---

## E. 最终 Schema（P0 目标）

> 说明：这是“最终目标 Schema”。P0 可先实现子集，但字段名与结构需向该 Schema 对齐，避免后续迁移成本。

### E1) 顶层：Project

```ts
export type ProjectV1 = {
  schemaVersion: '1.0'
  id: string
  title: string
  createdAt: string
  updatedAt: string

  story: StoryV1
  characters: CharacterV1[]
  assets: AssetV1[]
}
```

### E2) Story / Node

```ts
export type StoryV1 = {
  startNodeId: string
  nodes: NodeV1[]
}

export type NodeV1 = SceneNodeV1 | EndingNodeV1

export type BaseNodeV1 = {
  id: string
  name: string
  kind: 'scene' | 'ending'
  visuals?: NodeVisualsV1
}

export type SceneNodeV1 = BaseNodeV1 & {
  kind: 'scene'
  body: {
    text: string
  }
  choices: ChoiceV1[]
}

export type EndingNodeV1 = BaseNodeV1 & {
  kind: 'ending'
  body: {
    text: string
  }
  choices?: never
}

export type ChoiceV1 = {
  id: string
  text: string
  toNodeId: string
}
```

### E3) 视觉：背景与角色摆放

```ts
export type NodeVisualsV1 = {
  background?: AssetRefV1
  placements?: CharacterPlacementV1[]
}

export type CharacterPlacementV1 = {
  id: string
  characterId: string
  transform: Transform2DV1
  visible?: boolean
  zIndex?: number
}

export type Transform2DV1 = {
  // 归一化坐标（0..1），便于适配不同屏幕
  x: number
  y: number
  // 缩放（1 = 原始大小；或使用 heightRatio 方式）
  scale: number
  rotationDeg: number
  anchor?: { x: number; y: number } // 默认 {0.5, 1}
}
```

### E4) Character（独立实体）

```ts
export type CharacterV1 = {
  id: string
  name: string // 例如：放羊娃、村民、狼
  image?: AssetRefV1
  defaults?: {
    anchor?: { x: number; y: number }
    scale?: number
  }
}
```

### E5) Asset（资源）

```ts
export type AssetV1 = {
  id: string
  kind: 'image' | 'audio' | 'other'
  name: string
  // 相对路径为主（最终由 app_system 导入后统一分配）；制作阶段可用本地路径
  uri: string
  meta?: {
    width?: number
    height?: number
    sizeBytes?: number
  }
  source?: {
    type: 'upload' | 'import' | 'ai'
    prompt?: string
    provider?: 'sdwebui' | 'comfyui'
  }
}

export type AssetRefV1 = { assetId: string }
```

---

## F. UI 组件结构（React 参考）

> 目标：保持 **左侧结构 / 中央预览 / 右侧属性** 的严格边界。

```txt
<InteractiveStoryEditorPage>
  <TopBar />
  <MainLayout>
    <StructurePanel />      // 左：节点/角色/资源树 + 选择
    <CanvasPreview />       // 中：纯预览（Pixi）
    <InspectorPanel />      // 右：唯一编辑入口
  </MainLayout>

  // 可选：弹窗层（属于 TopBar/Inspector 的延伸，不算中心画布）
  <ModalLayer />
</InteractiveStoryEditorPage>
```

### StructurePanel（左侧）
- Tabs：
  - Nodes（Scene/Ending 列表）
  - Characters（角色库）
  - Assets（资源库）
- Actions：
  - New Scene / New Ending
  - Set Start Node
  - New Character
  - Import Asset（仅导入动作；编辑细节在右侧）

### CanvasPreview（中央）
- 输入：`selectedNodeId`、`projectSnapshot`
- 输出：纯渲染
- 交互：点击选项跳转（可选）

### InspectorPanel（右侧）
- 根据 selectionType 渲染：
  - NodeInspector
  - CharacterInspector
  - PlacementInspector
  - AssetInspector（含 AI 生成）

---

## G. 数据与导出路线（必须一致）

制作工具（gamestudio）只负责生成 demo/产物并保存在自身目录中：
- `gamestudio/storage/...`

**禁止**：gamestudio 直接写入 `online_game_resources`  
正确路线：
1) gamestudio 产出 demo/产物（本地）
2) 由 `app_system` 导入 demo/产物并纳管
3) 再由 app_system 分配到 `online_game_resources` 静态托管

