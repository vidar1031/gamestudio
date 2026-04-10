# 三层工作流设计（P0→P1）：脚本层 → 占位蓝图层 → 合成作品层

> 目标：把当前“直接编辑节点/角色/资源”的编辑器（合成层）升级为**工业级正确**的三段式生产线：
>
> 1) **方案脚本层（Story Script Layer）**：只写「发生了什么」的文本与顺序
> 2) **占位蓝图层（Node Placeholder / Blueprint Layer）**：把脚本映射为「可执行结构」+「角色/背景/Event 占位」+「分支 choices」
> 3) **合成作品层（Composition & Runtime Layer）**：把占位具体化为真实资源/动画/声音/时间线，并导出 H5
>
> 本文档只约束 `gamestudio/`，不涉及 `app_system/`。

---

## 0. 已确认的关键决策（你已确认）

1) ✅ **分支 choices 在第二层（蓝图层）完成**：第三层不再修改结构，只做表现/资源具体化。
2) ✅ **P0 就要 Event 占位**：第二层需要能创建/分配 Event（哪怕 P0 先只做占位与绑定，不做复杂执行）。
3) ✅ **ID 锁定**：脚本卡片 / 蓝图节点 / 占位实体（Actor/Background/Event）一旦创建，`id` 永久不变；AI 也不得修改。

---

## 1. 总体原则（保证可行、可扩展、AI 可控）

### 1.1 分区职责不混合（沿用编辑器契约）
每一层都使用同一种布局骨架：
- **顶部：全局行为（TopBar）**：打开/保存/上一步/下一步/校验/导出
- **左侧：结构管理（Structure Panel）**：列表/树/顺序/创建/删除/选择
- **中央：画布呈现（Canvas Preview）**：只展示，不出现配置字段
- **右侧：唯一编辑入口（Inspector Panel）**：属性编辑

> 统一布局让用户成本更低，也避免“同一操作在多个地方出现”。

### 1.2 三层只解决一种问题（严格边界）
- **脚本层**：语义（文本 + 顺序）
- **蓝图层**：结构（节点 + choices + 占位 Actor/Background/Event）
- **合成层**：执行（资源/动画/声音/时间线 + 运行态预览 + 导出）

### 1.3 AI 参与必须“被允许的层级 + Schema 约束”
- AI 不是自由发挥，而是“在指定层级的 Schema 里做受控生成/建议”。
- 不允许跨层引用（例如脚本层出现 assetId、蓝图层指定 png/mp3 URL、合成层重写结构）。

---

## 2. 文件项目制：分层存储（JSON）

每个项目一个目录：

```
storage/projects/<projectId>/
  meta.json            # 项目元信息（阶段/更新时间/标题等，Hub 用）

  scripts.json         # 第一层：脚本文档（ScriptDocV1）
  blueprint.json       # 第二层：蓝图文档（BlueprintDocV1）

  project.json         # 第三层：合成层项目（ProjectV1：characters/assets…）
  story.json           # 第三层：合成层故事（StoryV1：nodes/choices/visuals…）

  assets/              # 项目素材（AI 生成的图片也在这里）
```

> 说明：第三层仍沿用现有 `project.json/story.json`（你现在的界面）。

---

## 3. Schema（最终版，P0 必须实现）

### 3.1 第一层：scripts.json（Story Script Layer）
**定位**：纯文本脚本卡片流（顺序可调），不包含结构字段。

```ts
type ScriptCard = {
  id: string            // 锁定
  name: string          // 脚本1/脚本2…（可改名）
  order: number
  text: string          // 纯文本/Markdown
  updatedAt: string
}

type ScriptDocV1 = {
  schemaVersion: '1.0'
  cards: ScriptCard[]
  updatedAt: string
}
```

### 3.2 第二层：blueprint.json（Node Placeholder / Blueprint Layer）
**定位**：把脚本卡片映射为“结构化分镜蓝图”。

蓝图层包含两部分：
1) **结构节点（BlueprintNode）**：scene/ending + choices（✅ choices 在这一层完成）
2) **占位实体（Placeholder）**：Actor / Background / Event（✅ P0 先做 Event）

```ts
type PlaceholderKind = 'actor' | 'background' | 'event'

type Placeholder = {
  id: string            // 锁定
  kind: PlaceholderKind
  name: string          // 例如：放羊娃 / 狼 / 羊 / 村民 / 森林 / 事件-狼出现
  tags?: string[]       // 可选：用于 AI/筛选/复用
}

// BlueprintNode = “结构节点”（不是资源实例）
type BlueprintNode = {
  id: string            // 锁定
  scriptCardId: string  // 来源脚本

  name: string
  kind: 'scene' | 'ending'
  textDraft?: string    // 从脚本抽取/手填，进入合成时作为默认文本

  // 占位分配（仅引用 Placeholder.id，不绑定真实资源）
  backgroundId?: string
  actorIds: string[]
  eventIds: string[]

  // 分支结构（✅ 这一层完成）
  choices: { id: string; text: string; toNodeId: string }[]
}

type BlueprintDocV1 = {
  schemaVersion: '1.0'

  startNodeId: string
  placeholders: Placeholder[]
  nodes: BlueprintNode[]

  updatedAt: string
}
```

> Event（P0）的最小含义：**“这个节点发生过某个事件”**。
> - P0 先做：创建/命名/分配
> - P1 再做：把 Event 具体化为第三层可执行能力（音效/动画触发/埋点/转场/变量等）

### 3.3 第三层：合成层（Composition & Runtime Layer）
第三层沿用现有 V1：
- `project.json`（ProjectV1）：`characters[]`、`assets[]`
- `story.json`（StoryV1）：`nodes[]` + `choices[]` + `visuals.backgroundAssetId` + `placements[]`

第三层是唯一可以：
- 绑定真实图片/声音
- 调整 placement（位置/缩放/角度）
- 引入 Animate/时间线（P1）
- 负责导出 H5

---

## 4. 阶段切换（编译）

### 4.1 Script → Blueprint（生成蓝图）
默认生成策略（P0 先简单可控）：
- 每个 `ScriptCard` 默认生成 1 个 `BlueprintNode(kind=scene)`
- `textDraft = card.text`（或截取前 N 行）
- 自动串联 choices：
  - card1 → card2 → … → last
  - last → 自动生成 ending（如果用户尚未创建）

用户在蓝图层可以：
- 为一个脚本卡片创建多个蓝图节点
- 修改/新增 choices（生成 10 结局就是在蓝图层完成）
- 建立 placeholders（Actor/Background/Event）并分配到节点

### 4.2 Blueprint → Composition（合成初始化）
将蓝图编译为 `project.json + story.json`（可运行）：
- 每个 `Placeholder(kind=actor)` 生成一个 `CharacterV1`（图片先空）
- 每个 `BlueprintNode` 生成一个 `NodeV1`
  - `body.text = textDraft || ''`
  - `choices` 复制
  - `visuals.placements` 根据 `actorIds` 生成默认 placement（x=0.5,y=1,scale=1,rotation=0）
  - `visuals.backgroundAssetId`：此时仍为空（或生成一个“背景占位 asset”，由用户在第三层选择真实背景图）

**冲突策略（P0 先落地）**
- P0：提供“覆盖重建（reset compose）”作为默认行为（带明确二次确认）。
- P1：再做“merge（仅补齐缺失）”。

---

## 5. UI 设计（四区布局，三层 + Hub）

### 5.1 Hub（入口）
- 中央：
  - 大卡片：`+ 创建新故事`
  - 草稿列表：title / 更新时间 / 当前阶段（脚本/蓝图/合成）

### 5.2 第一层：Script Studio
- 左侧：脚本列表（增删 + 排序）
- 中央：脚本卡片画布（只选择，不编辑）
- 右侧：脚本属性（name/text），自动保存
- 顶部：保存状态 + 下一步（生成蓝图）

### 5.3 第二层：Blueprint Studio
- 左侧：脚本列表（按 scriptCard 过滤）+ 蓝图节点列表 + placeholders 列表（Actor/Background/Event）
- 中央：当前分镜的节点卡片/流程展示（只选择）
- 右侧：
  - 节点属性：name/kind/textDraft/choices
  - 占位分配：background/actors/events
  - placeholder 属性：name/tags
- 顶部：上一步（脚本）+ 下一步（进入合成）+ 蓝图校验

### 5.4 第三层：Compose Studio（现有界面）
- 左侧：Node/Character/Asset
- 中央：运行态预览（Pixi）
- 右侧：唯一编辑入口
- 顶部：保存/导出/校验

---

## 6. 服务端 API（文件项目制）

现有（保持）：
- `GET/POST/PUT /api/projects`
- `POST /api/projects/:id/export`

新增（P0 需要）：
- `GET /api/projects/:id/scripts`
- `PUT /api/projects/:id/scripts`
- `GET /api/projects/:id/blueprint`
- `PUT /api/projects/:id/blueprint`
- `POST /api/projects/:id/compile/blueprint`（脚本→蓝图）
- `POST /api/projects/:id/compile/compose`（蓝图→合成）

---

## 7. AI 约束（必须写入契约/系统提示词）

### 7.1 Script 层（编剧助手）
✅ 允许：续写/改写/拆分/润色文本脚本
❌ 禁止：输出任何结构字段、id、资源引用

### 7.2 Blueprint 层（分镜结构助手）
✅ 允许：建议角色/背景/Event 占位，建议 choices 结构（但必须在 Schema 内）
❌ 禁止：指定具体图片/音频 URL，输出引擎代码

### 7.3 Compose 层（工程执行助手）
✅ 允许：在既定结构下绑定资源、生成素材（AI）、调 placement、生成导出配置
❌ 禁止：重写结构（nodes/choices）、修改任何锁定 id

---

## 8. P0 实现顺序（建议）

1) Hub：创建新故事 + 草稿列表
2) Script Studio：脚本 CRUD + 排序 + 自动保存
3) Compile：Script → Blueprint（默认生成）
4) Blueprint Studio：节点/choices/占位实体（Actor/Background/Event）与分配
5) Compile：Blueprint → Compose（覆盖重建 + 二次确认）
6) Compose Studio：复用现有合成编辑器 + 导出

