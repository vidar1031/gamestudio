# GameStudio 项目目录结构

## 项目根目录 (storage/projects/<project-id>/)

每个故事项目包含以下标准文件和目录：

```
storage/projects/<project-id>/
├── meta.json          # 项目元数据（标题、阶段、AI公式）
├── project.json       # 完整项目配置（资产、场景、角色、锁定配置）
├── story.json         # 叙事结构（场景节点、时间线、动作序列）
├── scripts.json       # 脚本配置
├── blueprint.json     # 编译后的蓝图
├── ai_blueprint_review.json  # AI 蓝图审查结果
├── assets/            # 资产存储目录
└── story-assets/      # 故事资产元数据 (plan.json)
```

## meta.json 结构

```json
{
  "schemaVersion": "1.0",
  "id": "uuid",
  "title": "故事标题",
  "stage": "script",           // script | compose | validate | export
  "createdAt": "ISO-8601",
  "updatedAt": "ISO-8601",
  "aiFormula": {
    "schemaVersion": "1.0",
    "format": "numeric",
    "choicePoints": 2,
    "optionsPerChoice": 2,
    "endings": 2
  }
}
```

## project.json 关键部分

- `characters`: 已生成的角色资产列表（包含 image 资产及其 ComfyUI 生成信息）
- `storyAssets`: 角色锁定、场景锁定、道具锁定的完整配置
  - `lockProfile`: character_core / location_anchor / generic_prop 等
  - `lockWorkflow`: character_sheet / scene_prompt_only 等
  - `renderStrategy`: ref_required / optional_ref / prompt_only
  - `referenceStatus`: "ready" | "missing" | "generated"
- `scenes`: 故事场景列表，每个场景包含：
  - `sceneId`, `sceneIndex`, `sceneName`, `summary`
  - `workflow`: 渲染工作流类型
  - `missingRequiredAssetIds`: 缺失的必要资产 ID 列表
  - `referenceStatus`: 资产引用状态

## story.json 结构

```json
{
  "schemaVersion": "2.0",
  "startNodeId": "bn_sc_timestamp_id",
  "nodes": [
    {
      "id": "bn_sc_timestamp_id",
      "name": "场景名称",
      "kind": "scene",
      "body": { "text": "场景描述文本" },
      "timeline": {
        "steps": [
          {
            "id": "st_scene_id_step",
            "actions": [
              { "type": "ui.setText", "mode": "replace", "text": "..." }
            ]
          }
        ]
      }
    }
  ]
}
```

## 资产生成状态解读

- `referenceStatus: "ready"` — 资产已通过 ComfyUI 生成，有实际图像文件
- `referenceStatus: "missing"` — 资产尚未生成（ComfyUI 不可用或未完成）
- `referenceStatus: "generated"` — 资产已生成但可能未通过审查

对于 `renderStrategy: "ref_required"` 的场景，missing 资产会阻止场景渲染。

## 服务器源目录

```
apps/server/src/
├── ai/                  # AI 集成模块
│   ├── storyAssets.js   # 故事资产管理
│   ├── storyBible.js    # 故事圣经生成
│   ├── storyLock.js     # 资产锁定管理
│   ├── storyboardPromptReview.js  # 分镜提示审查
│   ├── characterPrompt.js # 角色提示生成
│   └── imagePrompt.js   # 图像提示生成
├── blueprint/
│   ├── compile.js       # 蓝图编译
│   └── validate.js      # 蓝图验证
├── workflows/           # ComfyUI 工作流模板
│   ├── comfyui_story_lock_test_template.json
│   └── comfyui_hat_object_lock_template.json
└── studio/            # 控制服务器模块
```

## 参考

- 完整的示例项目以 `storage/projects/` 当前实际内容为准（历史项目 id 会随清理变化，不要在文档中写死）