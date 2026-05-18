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
- 详见 `docs/UI_SELF_CONSTRAINTS.md`。

### 控制平面契约
- 生命周期控制（`start`、`stop`、`pause`、`resume`、`exit`、`all-restart`）是**保护行为**，不可被新功能替代。
- `control-console` 与 `control-server` 必须保持同一套控制语义；若一侧调整 contract，另一侧必须同步更新。
- 左脑配置 -> 预检/自检 -> 启动/恢复的顺序不可绕过。
- reasoning 与 chat 语义分离：`ping-model` 是普通聊天路径，`reasoning-sessions` 是可观测推理路径。
- 详见 `docs/CONTROL_SYSTEM.md` 与 `ai/control_architecture.md`。

### 编辑器契约
- 节点式交互故事编辑器，**对象优先于数据**，**结构优先于视觉**。
- 严格四区布局：顶部（全局行为）、左侧（结构管理）、中央（画布预览）、右侧（属性编辑）。
- 右侧是**唯一编辑入口**，禁止同一字段在多处出现。
- 详见 `ai/interactive_story_editor.contract.md`。

### 安全边界
- 模型输出只能作为候选，不是事实。
- 写入、删除、导出、脚本和外部服务动作必须受 review gate 约束。
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
| `docs/CONTROL_SYSTEM.md` | Control 系统全面说明 |
| `docs/系统生产级推进方案.md` | 唯一生产级推进方案 |
| `docs/PRODUCT_AND_STORY_WORKFLOW.md` | 产品定位与三层故事工作流 |
| `docs/UI_SELF_CONSTRAINTS.md` | 前端 UI 约束规范 |
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

## 给 Agent 的核心建议

1. **先读契约再动手**：涉及 control 读 `ai/control_architecture.md`，涉及 editor 读 `ai/interactive_story_editor.contract.md`，涉及 UI 读 `docs/UI_SELF_CONSTRAINTS.md`。
2. **保护生命周期控制**：控制平面的 `start/stop/pause/resume/exit` 是产品行为，不可被新配置面板覆盖或替代。
3. **控制前后端对齐**：修改 `control-server` API 时，必须同步检查 `control-console` 的 service 层和 UI callsite。
4. **以文件事实为先**：对项目路径、目录结构、任务状态的判断，以实际文件系统为准，不以旧聊天印象为准。
5. **storage/projects 是真相源**：stories / 项目扫描类任务必须优先扫描 `storage/projects`，并在结果里明确返回已扫描目录、缺失目录、证据不足原因。
6. **禁止编造未观测事实**：未扫描到的 assets、scenes、props、图片生成状态，不得编造成“已扫描事实”。
