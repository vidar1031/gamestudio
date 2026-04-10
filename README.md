# gamestudio（P0：点击交互小故事制作工具）

本目录是一个独立的“制作/构建工具”子工程，用于生产超轻量的点击交互小故事小游戏（分支选择 → 结果导向）。

P0 目标：
- 仅支持 **小故事互动**（选择/分支/结局），不做复杂玩法。
- 编辑器：Vite + React + TypeScript
- 渲染：Pixi.js（运行时）
- 数据：文件项目制（JSON + assets），无需数据库
- 构建：插件化 builder（支持未来扩展更多小游戏类型）
- 产物：统一产物协议（导出到 gamestudio 内供 app_system 导入；不直接写入 online_game_resources）

文档：
- 设计与协议：`gamestudio/docs/DESIGN_P0.md`
- 使用说明（工作流）：`gamestudio/docs/使用说明_三层工作流.md`
- P0 复盘（现状评估）：`gamestudio/docs/P0_REVIEW_2026Q1.md`
- 产品工具分析（现状诊断与结论）：`gamestudio/docs/产品工具分析_2026-03-24.md`
- P1 设计基线：`gamestudio/docs/DESIGN_P1.md`
- P1 注释与说明规范：`gamestudio/docs/P1_COMMENTING_GUIDE.md`
- P2 设计方向（发布优先）：`gamestudio/docs/DESIGN_P2.md`

## 快速开始（P0）

注意：不要写成 `npm --prefix -- apps/editor ...`，`--prefix` 后面必须是路径，例如 `..`。

推荐直接使用统一启动脚本：
- 首次启动前先在仓库根执行 `npm install`
- `./start_project.sh`
- 如果是 agent / 自动化 / 后台启动：`./start_project.sh --detached`
- 查看状态：`./status_project.sh`
- 停止后台进程：`./stop_project.sh`

在 `app_system/` 目录下：
- 安装依赖（首次）：`npm --prefix .. install`
- 启动 server：`npm run dev:server`（默认端口 `1999`）
- 启动 editor：`npm run dev:editor`（默认端口 `8868`）

可选：将运行数据/导出物写入仓库外（推荐在长期使用/多人协作时开启）：
- 设置环境变量 `STUDIO_STORAGE_ROOT` 指向外部目录（例如 `~/gamestudio_storage`）
- server 将使用该目录下的 `projects/`、`demos/`、`demo_library/`

AI 生成脚本（服务端调用，避免 key 暴露给浏览器）：
- 在仓库根创建 `.env.local`（参考 `.env.example`）
- 设置 `STUDIO_AI_PROVIDER=openai`
- 设置 `OPENAI_API_KEY=...`
- 可选：`STUDIO_AI_MODEL=gpt-4o-mini`、`STUDIO_AI_TIMEOUT_MS=20000`、`STUDIO_AI_BASE_URL=https://api.openai.com/v1`

AI 生成脚本（本地 Ollama）：
- 安装并启动 Ollama（默认地址 `http://127.0.0.1:11434`）
- 设置 `STUDIO_AI_PROVIDER=ollama`
- 可选：`STUDIO_OLLAMA_MODEL=qwen3:8b`、`STUDIO_OLLAMA_URL=http://127.0.0.1:11434`

AI（Doubao/火山 Ark）提示：
- **文本（写故事/提示词）** 与 **生图（Seedream）** 的模型要分开配置：Seedream 模型只能用于 `/api/v3/images/generations`，不能用于 `/api/v3/chat/completions`。
- 推荐环境变量：
  - 文本：`DOUBAO_ARK_TEXT_MODEL=doubao-1-5-pro-32k-250115`
  - 生图：`DOUBAO_ARK_MODEL=doubao-seedream-4-0-250828`

demo 手动拷贝目录：`gamestudio/storage/demo_library/<demoId>/story.json`（素材放同目录的 `assets/`）。

使用流程：
1) 打开 `http://localhost:8868`
2) 点击“新建项目”或选择已有项目
3) 修改 story JSON（P0 先用 JSON 编辑，后续再做图形化节点编辑）
4) “保存”→“导出并打开”（会打开 `http://localhost:1999/demos/.../dist/index.html`）

## 运行约定

- 权威启动入口：`./start_project.sh`
- agent 后台启动模式：`./start_project.sh --detached`
- 状态检查入口：`./status_project.sh`
- 停止入口：`./stop_project.sh`
- 仓库只保留以上 3 个运行脚本；首次启动前需先执行 `npm install`
- 权威端口：
  - server: `1999`
  - editor: `8868`
- editor 健康探测优先使用：`http://localhost:8868`
- 启动前建议先跑：`npm run typecheck`
- 如果 agent 要写回项目状态，统一更新：
  - `PROJECT_PLAN.md`
  - `memory/STATUS.md`
  - `memory/YYYY-MM-DD.md`

开发契约：`gamestudio/ai/interactive_story_editor.contract.md`
