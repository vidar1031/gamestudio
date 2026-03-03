# P0 锁定目标：Timeline + Event + State（可执行方案）

> 本文用于“锁死目标”，减少反复沟通成本。只描述 **P0 必须实现** 与 **明确不做**，并给出可落地的 Schema 与里程碑拆解。

## 1. P0 目标（锁死）

### 1.1 交互故事内核

- **节点（Node）**：场景 / 结局。
- **时间线（Timeline / PPT 触发）**：每个节点内部由若干“步骤（Step）”组成，按触发机制推进（自动播放 / 点击继续 / 选择确认 / 定时器 / 事件通知 / 条件成立）。
- **事件（Event）**：可复用的“动作片段/宏”，用于统筹动画/文本/转场/弹窗等行为。
- **状态（State）**：变量（数值/布尔/字符串/标签集合） + 条件表达式，用于《狼来了》这类“累积状态 → 条件分流”的故事。
- **结局卡（Ending Card）**：所有结局统一使用标准结局卡结构展示（结果要点 + 核心道理 + 操作按钮）。

### 1.2 P0 产物要求

- **必须支持纯逻辑故事**：无任何素材时，使用默认主题与默认 UI 也能导出可玩 H5。
- **节点像 Flash 元件**：节点内可承载多类型对象（文本/图片/动画/视频等）——**P0 先定义扩展点**，只落地“文本 + 选择 + 结局卡 +（可选）背景图/角色立绘”。
- **三层工作流不变**：脚本层 → 蓝图层（结构/占位/choices）→ 合成层（Timeline+Event+State+资源）。
- **ID 锁定**：项目内所有核心对象（Node/Step/Event/Choice/Asset/Character）创建后 ID 不变。

## 2. P0 明确不做（锁死）

- 不做复杂动画编辑器（曲线、骨骼、粒子、blend tree）。
- 不做视频/高级音频剪辑（仅预留 Action 类型，P0 不实现）。
- 不做多人协作、权限、版本分支。
- 不做自由脚本（禁止 eval / JS 表达式），条件与变量操作采用受限 DSL。
- 不做“全图可视化节点编排器”（P0 先保证可用的结构列表 + 预览 + 校验 + 快速测试）。

## 3. 统一运行时模型（Runtime Contract）

### 3.1 Story / Node / Timeline 的执行语义

1. Story 启动 → 进入 `startNodeId`。
2. 进入 Node 时：
   - 初始化该 Node 的“舞台”（Stage）与 UI（默认主题）。
   - Timeline 指针从 Step[0] 开始执行。
3. 每个 Step：
   - 执行 `actions[]`（顺序执行，P0 不做并行）。
   - 然后进入 `advance` 等待（自动/点击/选择/定时/事件/条件）。
   - 满足后推进到下一个 Step；若 Step 触发了“跳转”则立即切换 Node 并重置 timeline。
4. 结局 Node：
   - 推荐用 Timeline 触发 `ui.showEndingCard` 作为最后一步，或由默认规则自动补齐。

### 3.2 Trigger / Advance（PPT 触发机制）

P0 统一用 `advance` 表达“下一步如何推进”：

- `auto`：动作执行完自动进入下一步
- `click`：等待用户点击“继续”
- `choice`：等待用户在选项中选择并确认（**P0 锁定：点选即确认并跳转**；后续再扩展“二次确认”）
- `timer`：等待 `ms` 毫秒
- `event`：等待某事件名被 emit
- `condition`：等待条件表达式成立（**P0 锁定：默认轮询 200ms**，可在 step 内覆盖）
- `end`：结束本节点时间线（停在当前节点，通常用于结局节点）

> 注：事件通知既包括“内部事件”（脚本/动作触发）也包括“外部事件”（动画播放结束、资源加载完成、以后可对接广告 SDK 等）。

### 3.3 Event（宏/片段）

Event 是可复用动作片段：
- 一个 Event = `actions[]` 的模板
- Timeline Step 可 `event.call(eventId)`，将动作展开执行
- Event 可以被多 Node 共用（例如：统一的“选择弹窗出现/消失”、“结局卡展示”、“转场”）

### 3.4 State（变量与条件）

#### 变量类型（P0）
- `number`（默认 0）
- `boolean`（默认 false）
- `string`（默认 ""）
- `tags`（字符串集合）

#### 操作（P0）
- `set` / `add` / `inc` / `toggle`
- `tags.add` / `tags.remove` / `tags.has`

#### 条件表达式（P0）

采用 **JSON 结构表达式**（避免 eval），P0 支持：

- 比较：`== != < <= > >=`
- 逻辑：`and / or / not`
- tags：`tags.has`

推荐结构：

```json
{
  "op": "and",
  "args": [
    { "op": ">=", "left": { "var": "trust" }, "right": 70 },
    { "op": "tags.has", "var": "motiveTags", "value": "prank" }
  ]
}
```

变量引用统一为 `{ "var": "xxx" }`，字面量直接写 `number/boolean/string`。

> 轮询策略（锁死）：`advance.condition` 默认每 `200ms` 评估一次条件；Step 可通过 `advance.pollMs` 覆盖（例如 100/500）。

---

## 4. P0 合成层 Schema（锁死）

> 说明：脚本层（scripts.json）与蓝图层（blueprint.json）维持现状；本节只锁定 **合成层（Story/Project）** 的演进方向，用于支持 Timeline + Event + State。

### 4.1 ProjectV2（建议 schemaVersion=2.0）

新增（P0 必需）：
- `events[]`：事件库（宏）
- `state.vars[]`：变量定义（类型 + 默认值）

示例：

```json
{
  "schemaVersion": "2.0",
  "id": "proj_xxx",
  "title": "狼来了",
  "pluginId": "story-pixi",
  "pluginVersion": "0.2.0",
  "createdAt": "2026-02-07T00:00:00.000Z",
  "updatedAt": "2026-02-07T00:00:00.000Z",
  "assets": [],
  "characters": [],
  "events": [
    {
      "id": "evt_show_choice",
      "name": "显示选项弹窗",
      "actions": [{ "type": "ui.toast", "text": "请选择…" }]
    }
  ],
  "state": {
    "vars": [
      { "name": "trust", "type": "number", "default": 100 },
      { "name": "lieCount", "type": "number", "default": 0 },
      { "name": "motive", "type": "string", "default": "" },
      { "name": "tags", "type": "tags", "default": [] }
    ]
  }
}
```

### 4.2 StoryV2 / NodeV2（Timeline 为核心）

Node 的核心是：
- `timeline.steps[]`
- `choices[]`（仍保留，用于 `advance.choice` 与纯逻辑导出；并扩展 effects/conditions）
- `endingCard`（仅结局节点需要）

```json
{
  "schemaVersion": "2.0",
  "startNodeId": "n_start",
  "nodes": [
    {
      "id": "n_start",
      "name": "发现西瓜",
      "kind": "scene",
      "body": { "text": "乐乐发现了大西瓜…" },
      "timeline": {
        "steps": [
          {
            "id": "s1",
            "actions": [{ "type": "ui.setText", "mode": "replace", "text": "炎热的夏天…" }],
            "advance": { "type": "click" }
          },
          {
            "id": "s2",
            "actions": [{ "type": "ui.appendText", "text": "\n乐乐试着搬…" }],
            "advance": { "type": "auto" }
          },
          {
            "id": "s3",
            "actions": [{ "type": "event.call", "eventId": "evt_show_choice" }],
            "advance": { "type": "choice" }
          }
        ]
      },
      "choices": [
        { "id": "c1", "text": "团结坚持", "toNodeId": "n_c1" },
        { "id": "c2", "text": "寻找方法", "toNodeId": "n_c2" }
      ]
    },
    {
      "id": "n_end_1",
      "name": "结局：团结制胜",
      "kind": "ending",
      "timeline": {
        "steps": [
          {
            "id": "s_end",
            "actions": [
              {
                "type": "ui.showEndingCard",
                "card": {
                  "title": "团结制胜 · 终获成果",
                  "bullets": ["重新分工合作", "克服土坡困难", "成功搬回蚁穴"],
                  "moral": "团结就是力量，坚持到底就能克服困难。",
                  "buttons": [
                    { "type": "restart", "label": "重新开始" },
                    { "type": "backToHub", "label": "返回工作台" }
                  ]
                }
              }
            ],
            "advance": { "type": "end" }
          }
        ]
      }
    }
  ]
}
```

#### Choice 扩展（P0 必需）

为兼容《狼来了》的状态逻辑，Choice 需要支持：
- `effects[]`：选择后对 State 的影响（变量加减、打标签等）
- `visibleWhen` / `enabledWhen`：条件控制（可选）

示例：

```json
{
  "id": "cA",
  "text": "故意说谎（恶作剧）",
  "toNodeId": "n2",
  "effects": [
    { "type": "state.add", "var": "trust", "value": -30 },
    { "type": "state.inc", "var": "lieCount", "value": 1 },
    { "type": "state.set", "var": "motive", "value": "prank" }
  ]
}
```

## 蓝图规则说明（脚本 -> 蓝图 编译规则）

本节详细说明系统如何从 `scripts.json`（脚本卡序列）解析并生成 `blueprint.json` 的规则。实现参考：`apps/server/src/blueprint/compile.js` 中的 `compileBlueprintFromScripts`。

- 概念映射：每张脚本卡（card）对应一个蓝图节点（node），节点 id 使用 `bn_<cardId>`。
- 节点类型判定：若卡名包含“结局”或在所有卡中没有任何显式结局卡时最后一张卡则视为 `ending`，否则为 `scene`。

1) 脚本分段与“选择点”识别

  - 识别逻辑：对每张卡的 `text` 使用“选项”模式识别选项（函数名：`pickOptions`）。支持两种形式：
    - 独行格式（每行一项）：以 `选项A：文本` / `选项1：文本` 开头的行会被识别为选项。
    - 行内格式（段内多项）：在同一段中内联出现 `选项A：... 选项B：...` 的情况也会被解析为多选项。
  - 键的格式：选项键可为单字母 A-Z（不区分大小写）或数字（1-99）。解析后统一保留原键（字母转大写）。
  - 有效判定：识别到 >= 2 个选项则认为该卡为“选择点（choice point）”。

2) 后果（Consequence）与分支目标推断

  - 后果卡的识别策略：在一个选择点之后的若干张卡中查找与该选择相关的“后果卡”，支持的指示方式包括：
    - 标题形态 `A后果` / `B后果` / `C后果`（`looksLikeConsequence`），匹配字母键。
    - 数字前缀形态 `n后果k`（例如 `1后果1` 表示第1个选择点的第1个后果），用于多选择点的显式编号。
    - 若当前被视作“最后一个选择点”，还会尝试把 `结局N` 映射回选项键（通过字母->数字映射或数字键直接映射）。
  - 查找范围与合并点：编译器会在选择点之后向前最多查找一定数量的卡（默认上限约 40 张）以发现后果卡。若后果卡存在，编译器将把这些后果卡作为分支目标；若缺失，则该选项临时指向“join node”（通常是下一非后果卡或终止节点）。

3) 结局识别与终止节点

  - 若存在显式 `结局X` 命名的卡，会被当做 `ending` 节点并计入结局统计。
  - 若没有任何显式结局卡，系统会把最后一张脚本卡视为终止结局（terminal node）。

4) 自动继续（线性场景）

  - 对于非选择点卡，默认生成一个“继续”选择（id 为 `bc_<cardId>`，文本为 `继续`），指向下一张卡对应的节点（或终止节点）。

5) ID 与选择生成策略

  - 选择 id 由编译器生成：一般形态为 `bc_<cardId>_<optionKey>`，方便追踪来源。
  - 对于被识别为后果的卡（consequence cards），编译器会强制为其生成“继续”单项，且把这些后果节点的选择指向同一 `joinNodeId`（以保证分支后可合流）。

6) 合并与保留策略（与现有蓝图的交互）

  - 如果当前蓝图（`prevBlueprint`）对某个节点已有手工编辑的 choices（非编译器生成的 id），编译器默认保留这些手工 choices，并在 `report.warnings` 中添加 `preserve_manual_choices` 警告；只有当之前的 choices 明显为编译器生成（id 模式或单一 auto-continue）时，才会被覆盖。
  - 对于视觉/表现（textDraft、visuals、timeline），编译器会尽量保留 `prevBlueprint` 中已存在的内容（优先使用已编辑内容），仅对结构（节点列表、choices 目标）按脚本重新计算。

7) 公式（AI 生成时传入的 expectedFormula）影响

  - 如果存在 `expectedFormula`（例如 AI 生成时返回的 choicePoints/optionsPerChoice/endings），编译器会：
    - 把公式中的选择点数量用作“期望”的选择点计数；若实际检测到的选择点数量与公式不符，会在 `report.warnings` 中写入 `formula_choicePoints_mismatch`。
    - 在最后一个（期望）选择点处，编译器会尝试把选项直接映射到显式 `结局N` 上（如果能找到对应的结局卡）。

8) 常见警告与错误（report 中的 code）

  - `missing_consequence`：某个选项未找到对应的后果卡，已临时跳转到合流（join）节点。
  - `consequence_index_mismatch`：发现后果卡的编号与当前选择点编号不一致（例如误用 `3后果1` 在第1个选择点），会记录详细对比。
  - `formula_optionsPerChoice_mismatch` / `formula_endings_too_few`：与 AI 公式检验相关的不匹配警告。
  - `missing_start` / `missing_terminal`：无法推断 startNodeId 或终止节点（脚本卡缺失 id 或为空）视为错误。

9) 输出与接口

  - 编译函数返回结构：{ blueprint, report, debug }，其中 `report` 包含 `errors/warnings/info`，便于在 UI 中展示诊断信息。
  - 对应的服务端接口：`POST /api/projects/:id/compile/blueprint`（会把生成的 `blueprint.json` 写回项目目录，并返回 `report` 与 `validation`）。

示例：如果某张脚本卡 A 内含 “选项A：去左边 选项B：去右边”，编译器会把 A 识别为选择点；随后若在 A 之后发现名为 “A后果” 的卡，则把 A 的选项 A 指向该后果卡对应节点；如果找不到，则把该选项指向默认合流节点（下一张非后果卡或终止节点），并在 `report.warnings` 中提醒缺失后果。

此规则集在 P0 中保证了“从自由文本脚本自动生成结构化蓝图”的最小可用性，同时保留对手工编辑的尊重（不随意覆盖已编辑的选择与表现）。如需进一步示例或将此规则改为更严格/宽松的匹配策略，我可以把示例脚本与对应生成的 `blueprint.json` 一并生成展示。


---

## 5. P0 Action 列表（最小闭环）

> 原则：**动作类型有限且可控**，不引入脚本执行；未来扩展多媒体时只增 Action 类型，不改变引擎语义。

### 5.1 UI（纯逻辑必须）
- `ui.setText { mode: replace|append, text }`
- `ui.appendText { text }`
- `ui.clearText {}`
- `ui.toast { text }`
- `ui.showEndingCard { card }`

### 5.2 Flow（跳转/重开）
- `flow.gotoNode { nodeId }`
- `flow.restart {}`
- `flow.backToHub { url? }`（可选：编辑器环境可用；导出产物若无 Hub 可隐藏按钮或跳转到配置 url）
- `flow.stopTimeline {}`

### 5.3 Event（宏）
- `event.call { eventId }`
- `events.emit { name, payload? }`

### 5.4 State（变量）
- `state.set { var, value }`
- `state.add { var, value }`（number）
- `state.inc { var, value }`（number）
- `state.toggle { var }`（boolean）
- `state.tags.add { var, value }`
- `state.tags.remove { var, value }`

### 5.5 资源/舞台（P0 可选，但建议预留）
- `stage.setBackground { assetId | color }`
- `stage.setPlacements { placements[] }`（复用现有角色摆放概念）

---

## 6. P0 编辑器能力（按分区职责落地）

### 6.1 脚本层（方案脚本）
- 管理脚本卡（增删/排序/选择）
- 文本编辑（纯文本即可）
- 一键进入蓝图（覆盖/不覆盖）

### 6.2 蓝图层（结构/占位/choices）
- 节点列表（场景/结局）
- 占位库（角色/背景/事件）
- 节点的 choices 编辑（toNodeId 连接）
- 校验：startNode、断链、结局节点无 choices

### 6.3 合成层（Timeline + Event + State）
右侧属性区（唯一编辑入口）最小要有：
- Node 时间线步骤列表（steps），支持：
  - 新增步骤、排序、删除
  - 每步 `actions` 编辑（有限类型）
  - 每步 `advance` 类型选择（auto/click/choice/timer/event/condition）
- Event 库（新增/编辑/引用）
- State 面板（变量定义 + 当前运行态观察器）
- 结局卡编辑器（ending nodes）

中央画布（只展示效果）：
- 纯逻辑预览：文本/继续/选项/结局卡
- 可选素材预览：背景/角色（若存在）

顶部全局：
- 运行/暂停/重开、快速跳转节点、导出预览
- **P0 锁定控制按钮**：重新开始、返回工作台（编辑器环境）

---

## 7. 三案例兼容性对照（锁死结论）

### 7.1 《小蚂蚁搬西瓜》（逻辑型）
- 仅用：`ui.setText/appendText + advance.click/choice + endingCard`
- 无素材也可导出

### 7.2 《盲人摸象》（动画型）
- 用：Timeline（多 step）+ Event（动作宏）+ advance.timer/event（等待动画结束）
- P0 先用“文本+占位动作”跑通；P0.5 再补 `stage.*` 与过渡 action

### 7.3 《狼来了》（状态型）
- 用：State（trust/lieCount/motive）+ Choice.effects + advance.condition（条件成立触发分流）
- 避免“节点爆炸”，让 10 结局由条件路由完成

---

## 8. 可执行里程碑（锁死）

### P0（最小闭环，必须产出）
1. Runtime 引擎：Node + Timeline Steps + Advance 触发 + Event 宏 + State + Condition
2. 默认 UI：纯逻辑故事可玩（继续/选择/结局卡）
3. 编辑器：合成层支持 steps/actions/advance、Event 库、State 变量、结局卡
4. 校验：可达性/断链/结局卡缺失/条件引用未知变量
5. 导出：生成可部署的 H5（无素材也能运行）
6. 控制按钮：重新开始、返回工作台（在编辑器环境；导出产物按需隐藏或跳转）

### P0.5（动画/舞台增强，仍不做复杂编辑器）
- `stage.setBackground / setPlacements` 真正落地
- 简单转场与动画（例如 fade/move/scale），并能通过 `advance.event` 等待“动画完成”
- 对话结构化（speaker + text），支持旁白/多角色

### P1（扩展型元件）
- 组件类型扩展：图片/动画片段/视频（Action 扩展）
- 模板化：常见结构（发现→冲突→选择→结局）一键生成
- AI 辅助：脚本拆分为 steps、自动生成 endingCard 草稿、生成占位图

---

## 9. 已锁定细节（避免返工）

1. `advance.choice`：**点选即确认并跳转**
2. `advance.condition`：默认轮询 **200ms**
3. EndingCard / 控制按钮：P0 必须包含 **重新开始** 与 **返回工作台（编辑器环境）**
