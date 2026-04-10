# P0 设计文档：点击交互小故事制作工具（gamestudio）

## 1. 背景与目标

现有工程已经具备：
- 站点（site 模板 + 中台数据 sitehub）
- 游戏管理（app_system）
- 资源盘（online_game_resources）

缺口是“生产工具”：缺少一个独立的制作/构建系统，用于生成小游戏 demo/产物并交由 app_system 导入管理；再由管理系统分配到资源盘（online_game_resources）形成闭环。

P0 只做一个类型：**点击交互小故事**：
- 逻辑：节点（场景）+ 选项（分支）+ 结局（结果）
- 交互：点击选择、跳转节点、展示结果
- 内容：文本 + 背景/角色图（可选）+ 音频（可选）

约束：
- 渲染使用 Pixi.js
- 存储使用文件项目制（JSON）
- 暂不依赖 MongoDB/Redis 等

## 2. 工程形态（monorepo）

采用一个小型 monorepo，分离 schema/runtime/builder/editor/server，保证后续扩展“更多小游戏类型”时边界清晰。

```
gamestudio/
  apps/
    editor/               # React 编辑器（P0：图谱编辑 + 预览 + 导出）
    server/               # Hono 服务（P0：文件存储 + 导出 + 预览配置）
  packages/
    schema/               # StoryGraph 数据结构与 JSON Schema
    runtime-pixi/         # Pixi.js 运行时（加载 story.json 并渲染）
    builder/              # 插件接口 + 构建管线（P0：story-pixi 插件）
  storage/
    projects/
      <projectId>/
        project.json      # 项目元数据（title、type、createdAt...）
        story.json        # StoryGraph（节点/分支/结局）
        assets/           # 素材文件（图片/音频等）
```

## 3. 核心概念

### 3.1 Project（项目）
文件项目制：每个项目一个目录，至少包含：
- `project.json`：项目元信息（id/title/pluginId/version）
- `story.json`：故事图数据（StoryGraph）
- `assets/`：素材

### 3.2 Plugin（构建插件）
不同小游戏类型用不同插件实现。P0 只有一个插件：`story-pixi`。

插件负责：
- 描述编辑器表单 schema（可选）
- 校验项目输入
- 构建导出产物（dist）
- 提供运行时模板（index.html + runtime 入口）

### 3.3 Artifact（产物）
统一产物协议，便于后续由 app_system 导入管理；并由管理系统分配到 online_game_resources 进行静态托管（制作工具本身不直接写入资源盘）。

## 4. 插件接口定义（P0 版本）

见代码：`packages/builder/src/plugin.ts`

设计原则：
- 插件只关注“如何从输入项目生成 dist”
- builder 统一提供：日志、目录管理、版本信息、产物协议写入

## 5. 产物协议（Artifact Protocol）

导出产物必须包含：

```
dist/
  index.html
  game.manifest.json
  story.json
  assets/...
  runtime/...
```

### 5.1 game.manifest.json（必需）

P0 字段（可扩展）：
- `schemaVersion`: `"1.0"`
- `gameType`: `"story"`
- `engine`: `"pixi"`
- `entry`: `"index.html"`
- `title`: string
- `projectId`: string
- `build`: `{ time, toolVersion, pluginId, pluginVersion }`
- `files`: `{ story, assetsDir }`

### 5.2 运行时约定（Runtime Contract）
- 运行时需能从同目录读取 `story.json`
- 运行时需能用相对路径读取 `assets/*`

## 6. P0 功能清单

### Editor（最小可用）
- 新建项目（title）
- 编辑 StoryGraph（节点/选项/结局）
- 预览（在编辑器内运行 runtime，加载当前 story）
- 导出（触发 server 导出 dist.zip 或 dist 目录）

### Server（最小可用）
- `GET /api/projects`：列项目
- `POST /api/projects`：新建项目
- `GET /api/projects/:id`：读项目（project+story）
- `PUT /api/projects/:id`：写项目（project+story）
- `POST /api/projects/:id/export`：导出 dist（写到临时目录并返回下载地址）

导出产物访问：
- `GET /demos/:projectId/:buildId/dist/index.html`

## 7. 后续对接（P1+）
- 通过 app_system 的“导入 demo/产物”流程，将导出包入库并分配到 online_game_resources（制作工具不直接复制过去）
- 调用 `app_system` 的 API 创建/更新游戏记录与站点数据
- AI 侧（ComfyUI/WebUI）作为“素材生成器插件”，与项目素材库对接
