# Game Studio Memory

## Mission

- `game_studio` 是一个用于制作超轻量点击交互小故事的独立工具工程。
- 当前优先级不是继续堆功能，而是先把项目收敛到"可稳定运行、可持续迭代、可被 agent 自动维护"。

## Canonical Runtime

- 启动：`./scripts/lifecycle/start_project.sh`（agent 用 `./scripts/lifecycle/start_project.sh --detached`）
- 状态：`./scripts/lifecycle/status_project.sh`
- 停止：`./scripts/lifecycle/stop_project.sh`
- Server：`http://127.0.0.1:1999`，健康检查 `curl http://127.0.0.1:1999/api/health`
- Editor：`http://localhost:8868`

## Project Architecture

- npm workspaces monorepo：apps（server + editor）、packages（schema + builder + runtime-pixi）、storage
- Server：Hono 框架（JS ESM），端口 1999
- Editor：Vite + React 18 + TypeScript，端口 8868
- 渲染引擎：Pixi.js 8
- 存储：文件项目制（JSON + assets），无数据库
- 存储根路径：`storage/`（即 STUDIO_STORAGE_ROOT）

## AI Configuration System

项目需要两类 AI 模型才能生产故事：**文本生成**（写故事脚本）和 **图片生成**（做场景/背景图）。

### 配置优先级

`studio_settings.json` > `.env.local` > `.env` > 硬编码默认值

### 运行时设置（editor 可视化配置）

- 文件路径：`storage/_config/studio_settings.json`
- 编辑器提供 **设置面板**（齿轮图标），可配置 4 个能力：scripts、prompt、image、tts
- 每个能力独立选择 provider 和 model
- 修改后通过 API `PUT /api/studio/settings` 持久化
- **这是用户和 agent 配置 AI 模型的首选方式**

### API 检查和配置

| 操作 | API |
|------|-----|
| 查看当前设置 | `GET /api/studio/settings` |
| 修改设置 | `PUT /api/studio/settings` (JSON body) |
| AI 状态快照 | `GET /api/ai/status` |
| AI 深度诊断 | `POST /api/ai/diagnose` |
| 可用模型列表 | `GET /api/ai/models` |
| SDWebUI 模型 | `GET /api/studio/sdwebui/models` |
| ComfyUI 模型 | `GET /api/studio/comfyui/models` |
| 图片测试出图 | `POST /api/studio/image/test` |

### 文本生成 Provider

| Provider | 适用场景 | 关键配置 |
|----------|---------|---------|
| `openai` | 云端/兼容端点 | STUDIO_AI_BASE_URL + OPENAI_API_KEY + STUDIO_AI_MODEL |
| `ollama` | 本地/局域网 LLM | STUDIO_OLLAMA_URL + STUDIO_OLLAMA_MODEL |
| `doubao` | 火山引擎 | DOUBAO_ARK_CHAT_URL + DOUBAO_ARK_TEXT_MODEL + DOUBAO_ARK_API_KEY |

### 图片生成 Provider

| Provider | 适用场景 | 关键配置 |
|----------|---------|---------|
| `sdwebui` | 本地 SD WebUI | SDWEBUI_BASE_URL（默认 127.0.0.1:7860）|
| `comfyui` | 本地 ComfyUI | COMFYUI_BASE_URL（默认 127.0.0.1:8188）|
| `doubao` | 豆包文生图 | DOUBAO_ARK_IMAGES_URL + DOUBAO_ARK_MODEL + DOUBAO_ARK_API_KEY |

### 当前 studio_settings.json 状态

- scripts: ollama / gemma3:12b — 需确认 ollama 服务和模型是否可用
- prompt: ollama / gemma3:12b
- image: comfyui / dreamshaper_8.safetensors — 需确认 ComfyUI 是否运行
- tts: doubao

### agent 检查 AI 配置的标准流程

1. 确保项目已启动：`bash status_project.sh`
2. 查看当前 AI 设置：`curl -sS http://127.0.0.1:1999/api/studio/settings`
3. 查看 AI 状态：`curl -sS http://127.0.0.1:1999/api/ai/status`
4. 诊断：`curl -sS -X POST http://127.0.0.1:1999/api/ai/diagnose`
5. 修改设置示例：`curl -sS -X PUT -H "Content-Type: application/json" -d '{"scripts":{"provider":"ollama","model":"qwen3.5:27b-q4_K_M"}}' http://127.0.0.1:1999/api/studio/settings`

## Editor UI Guide

- Hub 页面：项目列表，创建/打开/删除项目
- ScriptStudio：脚本编辑，AI 生成故事草稿
- BlueprintStudio：蓝图编辑，脚本→蓝图编译，AI 审查
- ComposeStudio：合成/预览/导出 H5
- 设置面板（齿轮图标）：配置 AI provider/model/proxy
- 导航流：Hub → ScriptStudio → BlueprintStudio → ComposeStudio

## Key API Routes

### 系统
- `GET /api/health` — 健康检查
- `GET /api/ai/status` — AI 配置快照
- `POST /api/ai/diagnose` — AI 深度诊断
- `GET /api/ai/models` — 可用模型列表

### 设置
- `GET /api/studio/settings` — 读取全局设置
- `PUT /api/studio/settings` — 保存全局设置

### 项目管理
- `GET /api/projects` — 项目列表
- `POST /api/projects` — 创建项目
- `POST /api/projects/ai/create` — AI 创建项目

### 产线操作
- `POST /api/projects/:id/compile/blueprint` — 脚本→蓝图编译
- `POST /api/projects/:id/compile/compose` — 合成编译
- `POST /api/projects/:id/export` — 导出 H5
- `POST /api/projects/:id/ai/background` — AI 生成背景图
- `POST /api/projects/:id/ai/story/bible` — Story Bible 生成
- `POST /api/projects/:id/ai/character/fingerprint` — 角色指纹

## Storage Structure

```
storage/
  _config/studio_settings.json   # 全局 AI/网络设置
  projects/<projectId>/
    project.json                 # 元数据
    story.json                   # StoryGraph
    scripts.json                 # 脚本层
    blueprint.json               # 蓝图层
    assets/                      # 素材
  demo_library/                  # Demo 样例
```

## Project Workflow

- 三层工作流是项目核心：
  - 脚本层：内容草稿
  - 蓝图层：结构与分支
  - 合成层：资源和表现
- 结构修改优先发生在脚本层和蓝图层，不在合成层改结构
- 自动推进优先级：故事创建 → 蓝图 → 连续性 → 场景图 → 导出 → 测试

## Agent Working Rules

- 做代码改动前先检查项目状态
- 改动后更新 `memory/STATUS.md` 和 `memory/YYYY-MM-DD.md`

## Known Issues

- 旧 `start*.sh` 脚本已全部降级为弃用包装器
- agent 自动维护前先保证 `npm run typecheck` 通过
- 短期任务源：`memory/TASK_QUEUE.md`
