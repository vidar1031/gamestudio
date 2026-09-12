# AGENTS.md - GameStudio

本文档面向 AI 编码代理。阅读本文档前，默认读者对本项目一无所知。

---

## 项目概述

GameStudio 是一个 H5 互动故事生产工具仓库。当前主方向是让 `control` 驱动 `Hermes` 完成故事项目的创建、配置、生成与验证。

系统由两条主线组成：
- **业务平面**：`apps/editor`（前端编辑器）+ `apps/server`（业务后端），负责互动故事的编辑、编译、校验、资产管理和导出。
- **控制平面**：`apps/control-console`（控制台前端）+ `apps/control-server`（控制台后端），负责任务编排、模型路由、审核门禁、可观测执行和生命周期控制。

项目产物真相源：`storage/projects/`。若设置了环境变量 `STUDIO_STORAGE_ROOT`，则以外部目录为准。

---

## 技术栈

| 层级 | 技术 |
| --- | --- |
| 包管理 | npm workspaces |
| 运行时 | Node.js 18+，ES Modules |
| 后端框架 | Hono (`@hono/node-server`) |
| 前端编辑器 | Vite + React 18 + TypeScript + PixiJS v8 |
| 控制台前端 | Vite + Vue 3 + TypeScript + CodeMirror 6 |
| 构建工具 | Vite（应用）、tsc（包） |
| 脚本 | Bash（macOS）、Node.js |

---

## 仓库结构

```text
apps/
  editor/           # H5 互动故事编辑器（React + PixiJS）
  server/           # 业务后端：项目读写、编译、校验、资产、导出
  control-console/  # 控制平面 UI（Vue）
  control-server/   # 控制平面后端：任务编排、Hermes 控制、审核
packages/
  schema/           # 共享类型与 schema（ProjectV1、StoryV1、BlueprintDocV1 等）
  builder/          # 构建插件接口定义（BuilderPlugin）
  runtime-pixi/     # PixiJS 运行时（预留包）
storage/
  projects/         # 项目产物真相源
  demo_library/     # Demo 素材库
ai/               # Hermes 项目记忆、契约与工具目录
config/hermes/    # Hermes 左脑配置、intent、routing、skill
state/            # 运行时事件、reasoning sessions、review records
scripts/          # 构建、生命周期、测试、维护脚本
```

### 关键目录事实

- 编辑器源码：`apps/editor/src`
- 业务后端源码：`apps/server/src`
- 控制台前端源码：`apps/control-console/src`
- 控制台后端源码：`apps/control-server/src`
- 项目存储根：`storage`
- 项目创建目录：`storage/projects`
- Demo 素材目录：`storage/demo_library`

---

## 端口与服务

| 服务 | 地址 |
| --- | --- |
| GameStudio Server | `http://127.0.0.1:1999` |
| GameStudio Editor | `http://localhost:8868` |
| Control Server | `http://127.0.0.1:2099` |
| Control Console | `http://127.0.0.1:8870` |
| OMLX（本地模型） | `http://127.0.0.1:18888/v1` |

### 本地模型硬约束（32G / 8K，2026-08-26 实测确立）

- 全系统（GameStudio `storage/_config/studio_settings.json` 的 scripts/prompt/translation + Hermes `config/hermes/manager.left-brain.json`）统一使用 `Qwen3.6-27B-4bit`（8K 上下文变体）。
- **禁止**改回 `Qwen3.6-27B-MLX-4bit`（32K 变体）：KV 预留 ~5.6GB，27B 权重 ~15.7GB，合计超 oMLX prefill 内存护栏（~22.95GB）导致全部 400 拒答；且 control 资源调度器只认配置模型，其他已加载模型会被 `guard_unload_foreign_model` 强杀（生成中请求被断）。
- 本地模型调用必须给出有限 `max_output_tokens`（增强/翻译类 ≤2048）；OMLX 按 max_tokens 预留 KV，默认 8192 会直接撞护栏。
- 同一模型的多次调用串行执行，禁止并行 prefill（KV 峰值翻倍）。

---

## 构建与开发命令

### 首次使用

```bash
npm install
```

### 业务服务（前台模式）

```bash
./start_project.sh
```

后台模式（用于自动化/代理）：

```bash
./start_project.sh --detached
```

停止：

```bash
./stop_project.sh
```

状态：

```bash
./status_project.sh
```

### 控制平面

```bash
sh restart_control.sh
```

### 单独开发

```bash
# 构建共享包（必须先执行，因为 editor 依赖 schema）
npm run build:packages

# 单独启动各服务
npm run dev:server
npm run dev:editor
npm run dev:control-server
npm run dev:control-console
```

### 类型检查

```bash
# 全部前端项目
npm run typecheck

# 单独项目
npm --workspace @game-studio/editor run typecheck
npm --workspace @game-studio/control-console run typecheck
```

### 后端语法检查

```bash
node --check apps/control-server/src/index.js
node --check apps/server/src/index.js
```

---

## 代码组织

### Apps

#### `apps/editor`
- **框架**：Vite + React 18 + TypeScript
- **入口**：`src/main.tsx` -> `src/App.tsx`
- **工作室页面**：
  - `Hub.tsx` — 项目列表与入口
  - `ScriptStudio.tsx` — 脚本层编辑
  - `BlueprintStudio.tsx` — 蓝图层编辑
  - `ComposeStudio.tsx` — 合成层编辑
- **关键文件**：`src/api.ts`（与服务端通信）、`src/studios/`（各工作室页面）
- **编辑器契约**：节点式交互故事编辑器，严格遵循左/中/右/顶四区布局。详见 `ai/interactive_story_editor.contract.md`。

#### `apps/server`
- **框架**：Node.js + Hono（`@hono/node-server`）
- **入口**：`src/index.js`
- **模块**：
  - `src/ai/` — AI 相关：脚本生成、提示词、背景图生成、资产计划、Story Bible、诊断等
  - `src/blueprint/` — 蓝图编译与校验
  - `src/studio/` — 项目状态、设置、密钥管理
  - `src/plugins/` — 构建插件（storyPixi.js）
  - `src/net/` — 网络代理

#### `apps/control-console`
- **框架**：Vite + Vue 3 + TypeScript
- **入口**：`src/main.ts` -> `src/App.vue`
- **结构**：
  - `components/` — Vue 组件
  - `composables/` — Vue Composition API 逻辑
  - `services/` — API 封装（controlApi、chatApi、reasoningApi）
  - `lib/` — 共享工具（chatMarkdown、reasoning 格式化）

#### `apps/control-server`
- **框架**：Node.js + Hono
- **入口**：`src/index.js`
- **分层**：
  - `app/createApp.js` — Hono app 创建与中间件
  - `config/` — 常量与路径配置
  - `routes/registerRoutes.js` — 统一路由装配入口
  - `server/routes/` — 按域拆分的路由模块（overview、runtime、config、context、chat、reasoning）
  - `server/services/` — 服务层（chat、config、context、reasoning、runtime、gameStudioServerClient）
  - `server/workflows/` — 工作流定义（storyProduction、gameStudioBootstrap、projectStatus）
  - `server/reasoning/` — 推理相关（分类、记忆、质量门、提示词构建）
  - `server/intents/` — Intent 注册与提案管理

### Packages

#### `packages/schema`
- 共享 TypeScript 类型定义
- 关键输出：`ProjectV1`、`StoryV1`、`NodeV1`、`CharacterV1`、`AssetV1`、`BlueprintDocV1`、`ScriptDocV1`、`AiBackgroundStateV1` 等
- 构建产物输出到 `dist/`，含 `.d.ts` 声明文件

#### `packages/builder`
- 构建插件接口定义
- 核心类型：`BuilderPlugin`、`BuildContext`、`ArtifactManifestV1`

#### `packages/runtime-pixi`
- PixiJS 运行时预留包（当前为空占位）

---

## 开发约定

### 语言
- 项目文档、注释、UI 文案以**中文**为主。
- 代码标识符（变量、函数、类型）使用英文。

### 代码修改原则
- **最小改动**：只修改与问题直接相关的文件，避免格式化无关代码、重命名无关变量、重组项目结构。
- 修改前必须说明：根因、受影响文件、修改安全性。
- 分阶段执行：inspect -> isolate -> explain -> patch -> verify，每阶段 STOP 并总结。

### UI 约束
- 深色基底 + 单一强调色（`#5eccff`）。
- 组件状态仅三种：default / hover / active。
- 主界面固定三栏语义：列表 / 主操作区 / 说明。
- 文案面向用户，不出现 `P0/P1/P2`、`实验`、`临时` 等研发术语。
- Provider/Model 展示格式统一为 `provider / model`。
- 未配置 Provider 时动作必须明确阻断，不得静默失败。
- 详见 `docs/系统生产级推进方案.md` 的 "UI 约束" 章节。

### 控制平面契约
- 生命周期控制（`start`、`stop`、`pause`、`resume`、`exit`、`all-restart`）是**保护行为**，不可被新功能替代。
- `control-console` 与 `control-server` 必须保持同一套控制语义；若一侧调整 contract，另一侧必须同步更新。
- 左脑配置 -> 预检/自检 -> 启动/恢复的顺序不可绕过。
- reasoning 与 chat 语义分离：`ping-model` 是普通聊天路径，`reasoning-sessions` 是可观测推理路径。
- 本地重负载资源互斥（AUTO-R01）：OMLX 模型与 ComfyUI 出图共享机器内存，由 control 资源调度器互斥；`HERMES_RESOURCE_SCHEDULER_ENABLED` 默认开，状态见 `GET /api/control/resources/state` 与守护台「资源互斥」卡片。2026-09-12 扩展为统一互斥：槽位 llm/gpu/vision 三类（vision=视觉评审模型换入）；**所有本地模型/出图调用必须先取租约**——apps/server 经 `POST /api/control/resources/lease`（客户端封装 `apps/server/src/ai/resourceLease.js`，choke point：openai.js 文本、background.js 出图、storyCompleteness.js/characterPoseReview.js 视觉），control 内部非 step 调用经 `withInlineLlmLease`；story_* 委派类 step 不在边界持卡（防双向等待死锁）。
- 详见 `docs/系统生产级推进方案.md` 与 `ai/control_architecture.md`。

### 编辑器契约
- 节点式交互故事编辑器，**对象优先于数据**，**结构优先于视觉**。
- 严格四区布局：顶部（全局行为）、左侧（结构管理）、中央（画布预览）、右侧（属性编辑）。
- 右侧是**唯一编辑入口**，禁止同一字段在多处出现。
- 详见 `ai/interactive_story_editor.contract.md`。

### 安全边界
- 模型输出只能作为候选，不是事实。
- 写入、删除、导出、脚本和外部服务动作必须受 review gate 约束。
- **正式工作流强制（2026-09-09 用户指令，硬性法律，不可绕过）**：任何故事生产（创建/脚本/蓝图/圣经/资产计划/锁定事物/线稿/场景出图/摆位/校验/导出）**必须走正式生产工作流链**（control reasoning `story_workflow_execute` 的分步计划），每一步必须有可观测记录（reasoning session 事件流 + `/ai/tasks` 进度 + 审核记录），**任何一步失败必须显式停止**（failed/blocked 等待处置），禁止带病继续执行后续步骤。**禁止用零散 API/事件的即席组合替代正式工作流**——事件分发只用于正式链内的确定性步骤与经批准的修补动作，不得作为生产主路径。生产任务默认 reviewMode=manual（计划先审、逐步骤可审），只有用户明确授权才可用 full-auto。
- 图片生成实行三级审核门禁（`STUDIO_IMAGE_REVIEW_MODE=manual` 时）：出图前审核（`pre_generate`）→ AI 评审后人工确认锁定（`lock_confirm`）→ 场景图人工确认绑定（`scene_bind`）。审核记录存 `<project>/reviews/image_reviews.jsonl`；`approve` 后才执行生成或写回。Control 驱动的调用默认带 `x-image-review-mode: off` 旁路（control 已有自己的步骤级审核）。
- 长任务（锁定测试、场景渲染、批量渲染）必须经 `/api/projects/:id/ai/tasks` 暴露进度，禁止黑盒同步调用。
- 出图可观测（强制规则，2026-08-29 用户指令）：ComfyUI 只能经 `ensureComfyUiRunning` / `openComfyUiInTerminal`（Terminal.app 可见窗口）启动，禁止 `nohup` 等黑盒静默启动；一切出图动作（参考图抽卡、锁定测试、线稿、场景渲染）必须创建 `/api/projects/:id/ai/tasks` 进度条目并在锁定事物向导 UI 可见，禁止无进度黑盒跑图。
- 出图即压（强制规则，2026-09-09 用户指令）：生成图写盘时按用途分层压缩（`apps/server/src/ai/imageOptimize.js`）——立绘/cutout/主参考走**无损 WebP**（真相源零质量损失），场景背景走 JPEG q90，候选/绿幕/线稿/测试图走 WebP q92；禁止再落未压缩大 PNG。存量批压走 `POST /api/projects/:id/assets/compress`（幂等，同步改写 project.json 与 plan.json 引用）。导出包另有一层引用收集+压缩（`storyPixi.js`，目标 ≤5MB），两层不冲突。
- workspace 外路径必须拒绝。
- `_inbox` proposal 不能自动晋级为 active intent、workflow 或 evaluator。
- `.env` / `.env.local` 不得提交含真实密钥的版本。

---

## 测试

### 类型检查
前端项目使用 TypeScript `noEmit` 模式做类型检查，无单元测试框架。

```bash
npm run typecheck
```

### Smoke Test

```bash
bash scripts/test/smoke_test_pipeline.sh
```

该脚本委托给 `scripts/test/control_production_test.mjs`，执行 Control-First 生产流水线测试，包含：
- L1 硬门禁：模型链路与角色定位
- L2 确定性事实源与项目证据
- L3 安全边界与审核门禁
- 后续 story workflow 验证

### 控制生产测试

```bash
npm run test:control-production
# 或
node scripts/test/control_production_test.mjs
```

支持参数：`--stage=`、`--case=`、`--stop-on-fail`、`--manual-verdict`、`--use-running-control`。

### 健康检查

```bash
curl -sS http://127.0.0.1:1999/api/health    # GameStudio Server
curl -sS http://localhost:8868               # Editor
curl -sS http://127.0.0.1:2099/api/health    # Control Server
curl -sS http://127.0.0.1:2099/api/control/agents/hermes-manager/workflow-diagnostics
curl -sS http://127.0.0.1:1999/api/ai/comfyui/capability-check   # ComfyUI 出图能力（节点/模型缺失）
curl -sS "http://127.0.0.1:1999/api/projects/<id>/ai/tasks"      # 项目长任务进度
curl -sS "http://127.0.0.1:1999/api/projects/<id>/ai/reviews?status=pending"   # 待人工审核
curl -sS "http://127.0.0.1:2099/api/control/hermes/session-search?q=<关键词>"   # Hermes 历史会话只读检索（FTS5）
```

---

## 配置与环境变量

配置文件：`.env.example` 提供完整模板，复制为 `.env.local` 后填写真实值。

关键变量：

| 变量 | 用途 |
| --- | --- |
| `STUDIO_STORAGE_ROOT` | 外部存储根目录（可选） |
| `STUDIO_AI_PROVIDER` | AI 提供商：`openai` / `localoxml` / `ollama` |
| `OPENAI_API_KEY` | OpenAI API 密钥 |
| `STUDIO_BG_PROVIDER` | 背景图生成：`sdwebui` / `comfyui` / `doubao` |
| `COMFYUI_BASE_URL` | ComfyUI 服务地址 |
| `SDWEBUI_BASE_URL` | SD-WebUI 服务地址 |
| `STUDIO_PROXY_URL` | 本地 HTTP 代理（如 Clash） |
| `STUDIO_IMAGE_REVIEW_MODE` | 图片生成审核模式：`manual`（默认，人工门禁）/ `ai_only`（AI 评审即终审）/ `off`（全自动） |
| `MOONSHOT_API_KEY` | Moonshot/Kimi API 密钥；配置后锁定测试视觉评审走 Kimi |
| `STUDIO_POSE_REVIEW_PROVIDER` | 姿势一致性评审通道：`auto`（默认，有 Kimi key 走 Kimi 否则本地视觉模型）/ `kimi` / `local_vl` / `off`；也可在 `storage/_config/studio_settings.json` 的 review 节配置 `poseReviewProvider/poseReviewModel/poseReviewBaseUrl` |
| `HERMES_VISION_MODEL` | 本地视觉评审模型名（默认 `gemma-4-26b-a4b-it-4bit`，经 OMLX 多模态）；同步写入 `config/hermes/manager.left-brain.json` 的 `visionModel` 字段，资源调度器外来模型守卫据此放行 |

服务器启动时会自动加载 `.env` / `.env.local`（通过 `apps/server/src/env.js`）。

---

## 部署与生命周期

所有生命周期脚本位于 `scripts/lifecycle/`：

| 脚本 | 用途 |
| --- | --- |
| `start_project.sh` | 启动 editor + server（前台/后台） |
| `stop_project.sh` | 停止业务服务 |
| `restart_control.sh` | 重启 control-server + control-console |
| `restart_server.sh` | 重启 server |
| `status_project.sh` | 查看运行状态 |
| `team_checkin.sh` | 团队签到 |
| `reporter.sh` | 状态报告 |

PID 与日志保存在 `.run/` 目录：
- `server.pid` / `server.log`
- `editor.pid` / `editor.log`
- `control-server.pid` / `control-server.log`
- `control-console.pid` / `control-console.log`

---

## 文档索引

| 文档 | 用途 |
| --- | --- |
| `README.md` | 项目快速启动、权威目录、端口 |
| `docs/README.md` | docs/ 目录入口与维护规则 |
| `docs/PROJECT_GOVERNANCE.md` | 全系统最高治理规则 |
| `docs/系统生产级推进方案.md` | 系统分工、启动流程、任务流、路由规则、UI 约束 |
| `docs/Control + GameStudio 生产工作流联调测试说明.md` | 联调测试标准与验证清单 |
| `docs/PRODUCTION_DEFECTS.md` | 当前生产缺陷与未实现项 |
| `docs/运行时能力测试基准.md` | 32G/16K 运行时硬约束与分组测试通过标准（硬基准，不可偏离） |
| `ai/AGENTS.md` | Hermes 工作契约（控制平面专用） |
| `ai/TOOLS.md` | 工具目录、接口、端口、命令速查 |
| `ai/control_architecture.md` | Control 当前结构说明（权威当前状态） |
| `ai/interactive_story_editor.contract.md` | 编辑器 schema / UI 契约 |
| `ai/memory/STATUS.md` | 当前目标、阻塞、下一步 |
| `ai/memory/TASK_QUEUE.md` | 短任务推进 |
| `ai/memory/DECISIONS.md` | 生效中的规则与取舍 |
| `ai/memory/LONG_TASKS.md` | 长任务方向 |

---

## 技能文件（.claude/skills/）

仓库根目录的 `.claude/skills/` 包含当前项目生效的编码规则，agent 应遵守：

| 技能 | 规则 |
| --- | --- |
| `agent-execution.md` | 分阶段执行（inspect/isolate/explain/patch/verify），每阶段 STOP |
| `code-modification.md` | 最小改动原则，修改前说明根因、受影响文件、安全性 |
| `project-analysis.md` | 增量分析，每次最多 10 个文件、2 层目录 |
| `token-control.md` | Token 控制 |
| `js-runtime-debug.md` | 运行时调试 |

---

## Agent 定位（最高优先级，不可偏离）

- **我是 control 的建设者，不是生产操作员。** 禁止直接调用 GameStudio 生成类 API（出图、锁定测试、线稿、场景渲染、导出等）替用户完成生产任务——那会造成 token 浪费、绕过审核、产出无证据链的结果。
- 生产任务（故事生成、场景图生成）必须由 **control 侧通过事件机制**驱动：用户 → control（hermes-manager）→ 事件分发（`apps/server/events/registry.v1.json` + `eventDispatcher`）→ GameStudio Server → ComfyUI。
- 我的工作范围是修改 `apps/control-server` / `apps/control-console` / `apps/server` 的代码，让 control 具备并持续增强自动化能力：事件注册与映射、工作流编排、审核门禁、可观测执行链、能力自愈。
- 验证生产链路时，由 control 侧事件链执行，我只观察证据（事件分发记录、reasoning sessions、`/ai/tasks` 进度、审核记录），不越俎代庖。
- 任何"帮我跑一遍生产"的请求，都转化为"让 control 能跑一遍生产"的代码建设；发现 control 能力不足时，补 control 的能力，而不是自己下场。
- 图片生产的把关在审核门禁（出图前/锁定确认/场景绑定），审核入口统一呈现在 control-console，人不需要切换到其他界面。

### 工具链验证硬性指标（2026-09-10 用户指令，不可绕过）

- **验证必须走工具自身链路**：能力验证/测试必须经由工具自身的链路完成（编辑器 UI、control 事件链、正式生产工作流），并在工具内留下可观测证据（plan/项目数据、`/ai/tasks` 进度、审核记录、UI 可见状态）。**禁止用"直接 API 调用 + 原始输出判定"代替工具链验证后宣布达标**。仅纯 CRUD/健康检查/配置读写类接口允许命令行直验。
- **测试必须在工具内留痕**：生成类能力测试产生的候选（提示词/需求清单/草稿/候选图）必须经工具链落到工具内可见状态，用户打开 UI 即可复核；汇报时必须指明证据在工具内的位置。测试完"工具里什么都没有"= 验证不成立。
- **结合需求用足工具**：实现新需求时优先复用并接入既有工具链能力（持久化、审核门禁、进度条目、翻译链、关联选择器），不得另起绕过这些能力的旁路实现；发现工具链缺能力就补工具链，不用手工代偿。
- **生产操作归用户/正式工作流**：出图、脚本、导出等生产内容永远由用户操作或正式工作流驱动；agent 的职责是把工具链建到"用户自己能用本地 AI 跑通全部流程"。

---

## 给 Agent 的核心建议

1. **先读契约再动手**：涉及 control 读 `ai/control_architecture.md`，涉及 editor 读 `ai/interactive_story_editor.contract.md`，涉及 UI 读 `docs/系统生产级推进方案.md` 的 "UI 约束" 章节。
2. **保护生命周期控制**：控制平面的 `start/stop/pause/resume/exit` 是产品行为，不可被新配置面板覆盖或替代。
3. **控制前后端对齐**：修改 `control-server` API 时，必须同步检查 `control-console` 的 service 层和 UI callsite。
4. **以文件事实为先**：对项目路径、目录结构、任务状态的判断，以实际文件系统为准，不以旧聊天印象为准。
5. **storage/projects 是真相源**：stories / 项目扫描类任务必须优先扫描 `storage/projects`，并在结果里明确返回已扫描目录、缺失目录、证据不足原因。
6. **禁止编造未观测事实**：未扫描到的 assets、scenes、props、图片生成状态，不得编造成“已扫描事实”。
