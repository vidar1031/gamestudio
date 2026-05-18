# Control → Hermes → OMLX → GameStudio 完整驱动链路文档

> 本文档是 control 平面驱动 GameStudio 生产 H5 交互故事的**权威链路说明**。
> 更新日期：2026-05-18

---

## 1. 链路拓扑

```
┌─────────────────┐     ┌──────────────────┐     ┌─────────────────────┐
│ Control Console │────▶│  Control Server  │────▶│  Hermes Gateway     │
│   (Vue3, 8870)  │     │   (Hono, 2099)   │     │  (Python, 8742)     │
└─────────────────┘     └──────────────────┘     └─────────────────────┘
                               │                           │
                               │     ┌─────────────────────┘
                               │     │
                               ▼     ▼
                        ┌──────────────────┐
                        │  OMLX / OpenAI   │
                        │  (18888 / remote)│
                        └──────────────────┘
                               │
                               ▼
                        ┌──────────────────┐
                        │ GameStudio Server│
                        │  (Hono, 1999)    │
                        └──────────────────┘
                               │
                               ▼
                        ┌──────────────────┐
                        │ storage/projects/│
                        │   (真相源)        │
                        └──────────────────┘
```

---

## 2. 分层职责

| 层级 | 地址 | 职责 |
|------|------|------|
| **Control Console** | `http://127.0.0.1:8870` | UI 操作界面：chat、reasoning review、生命周期按钮 |
| **Control Server** | `http://127.0.0.1:2099` | 编排中枢：请求分类、session 管理、质量门禁、workflow 执行 |
| **Hermes Gateway** | `http://127.0.0.1:8742/v1` | Agent 运行时：注入记忆、调用模型、返回结构化回答 |
| **OMLX** | `http://127.0.0.1:18888/v1` | 本地模型推理服务（OpenAI-compatible） |
| **GameStudio Server** | `http://127.0.0.1:1999` | 业务后端：项目 CRUD、编译、校验、资产生成、导出 |
| **Storage** | `storage/projects/` | 项目产物真相源 |

---

## 3. 模型路由契约

Control Server 通过 `requestHermesChatCompletion()` 发送模型请求，支持两种 transport：

| Transport | 目标 | 使用场景 | 模型 |
|-----------|------|----------|------|
| `hermes` | `http://127.0.0.1:8742/v1` | Chat、Reasoning Plan、Reasoning Answer、Quality Gate | `hermes-agent` |
| `direct` | `http://127.0.0.1:18888/v1` | Story Scripts Candidate、Story Blueprint Review | `Qwen3.6-35B-A3B-4bit` |

**决策逻辑**：
1. 检查 `binding.workflow.modelRouting.phaseRoutes` 中是否有当前 phase 的显式路由
2. 若无显式路由，使用 `defaultRoute`
3. `story_scripts_candidate` 和 `story_blueprint_review` 强制使用 `direct` transport 并设置 `strict: true`

**风险点**：`direct` transport 硬编码依赖 `Qwen3.6-35B-A3B-4bit`。若 OMLX 中该模型未加载，直接失败且无 fallback。

---

## 4. Control Server → GameStudio Server 通信契约

Control Server 通过 `gameStudioServerClient`（`apps/control-server/src/server/services/gameStudioServerClient.js`）与 GameStudio Server 通信。

### 4.1 基础约定

- **Base URL**: `http://127.0.0.1:1999`（可通过 `GAMESTUDIO_SERVER_BASE_URL` 覆盖）
- **CORS**: GameStudio Server 已配置 `origin: '*'`，无跨域障碍
- **超时**: 默认 120s，部分端点（如 AI 生成）可覆盖为 300s
- **返回结构**: 统一为 `{ ok, status, endpoint, url, data, error?, message?, retryable? }`

### 4.2 数据契约断裂点（已识别）

#### 🔴 断裂点 1：`getAiStatus()` 返回结构不匹配

**服务端端点**: `GET /api/ai/status`

**服务端实际返回**:
```json
{
  "success": true,
  "ai": {
    "provider": "localoxml",
    "openai": { "baseUrl": "...", "model": "..." },
    "localoxml": { "baseUrl": "...", "model": "..." },
    "proxy": { "url": "..." },
    "diagnostics": { "lastCheckedAt": "...", "lastOk": true }
  }
}
```

**Control Server 期望读取**:
```js
aiStatus?.data?.ai?.effective?.enabled?.image
// 或
aiStatus?.data?.ai?.enabled?.image
```

**问题**: 服务端返回的 `ai` 对象**没有 `effective` 和 `enabled` 字段**，导致 `imageEnabled` 永远为 `false`。

**影响**: `story_generate_asset_candidate` workflow step 中的条件判断：
```js
if (projectId && imageEnabled && assetKind === 'background')
```
由于 `imageEnabled === false`，**资产生成被完全跳过**。

**修复方向**: 
- 方案 A（推荐）：在 `gameStudioServerClient.getAiStatus()` 中做适配转换，根据 `provider` 字段推断 `enabled` 状态
- 方案 B：修改服务端 `getAiStatusSnapshot()` 使其返回 `effective.enabled` 结构

#### 🟡 断裂点 2：`story_validate_project` 无对应服务端端点

**Tool Registry 映射**: `story_validate_project` → `internal:gamestudio/projects.validate`

**问题**: GameStudio Server **没有** `POST /api/projects/:id/validate` 端点，只有 `POST /api/projects/:id/validate/blueprint`。

**当前行为**: `validateBlueprint()` 被调用（`POST /api/projects/:id/validate/blueprint`），但这只校验 blueprint，不校验 `project.json` + `story.json` + asset URI 的完整性。

---

## 5. Story Production 工作流（正确行为定义）

### 5.1 完整流程（19 步）

```
1. story_create_project              → POST /api/projects/ai/create
2. story_generate_scripts_candidate  → internal:hermes/story.scripts.candidate (direct OMLX)
3. story_configure_project           → PUT /api/projects/:id
4. story_compile_blueprint           → POST /api/projects/:id/compile/blueprint
5. story_validate_blueprint          → POST /api/projects/:id/validate/blueprint
6. story_review_blueprint_agent      → internal:hermes/story.blueprint.review (direct OMLX)
7. story_fix_scripts                 → POST /api/projects/:id/ai/fix/scripts
8. story_compile_blueprint (retry)   → POST /api/projects/:id/compile/blueprint
9. story_validate_blueprint (retry)  → POST /api/projects/:id/validate/blueprint
10. story_compile_compose            → POST /api/projects/:id/compile/compose
11. story_generate_story_bible       → POST /api/projects/:id/ai/story/bible
12. story_generate_asset_plan        → POST /api/projects/:id/ai/story/assets/plan
13. story_lock_asset_references      → POST /api/projects/:id/ai/story/assets/reference
14. story_select_asset_references    → POST /api/projects/:id/ai/story/assets/reference/select
15. story_generate_asset_candidate   → POST /api/projects/:id/ai/background
16. story_render_scenes              → (未实现完整链路)
17. story_validate_project           → POST /api/projects/:id/validate/blueprint (当前替代)
18. story_export_project             → POST /api/projects/:id/export
19. story_generate_default_answer    → 总结报告
```

### 5.2 当前停滞点

`state/story-production/current-project.json` 显示最后执行的是第 17 步 `story_validate_project`（2026-05-12），之后无后续动作。

**可能原因**:
1. `imageEnabled` 为 `false` 导致第 15 步 `story_generate_asset_candidate` 被跳过
2. 第 17 步后没有明确的后续步骤定义
3. `MAX_MODEL_CALLS_PER_SESSION = 8` 可能已超限

---

## 6. Bootstrap 工作流（正确行为定义）

```
1. gamestudio_ensure_running    → 检查 GameStudio Server health
2. gamestudio_self_check        → 运行 diagnoseStudio
3. gamestudio_read_settings     → GET /api/studio/settings
4. gamestudio_configure_local_production → PUT /api/studio/settings
5. gamestudio_preflight_image   → POST /api/studio/image/preflight
```

### 6.1 `gamestudio_configure_local_production` 验证逻辑

写入 settings 后，Control Server 会**读回验证**:
```js
effective?.enabled?.image === true
effective?.image?.provider === 'comfyui'
effective?.scripts?.provider === 'localoxml'
```

**注意**: `PUT /api/studio/settings` 返回结构为 `{ success: true, settings }`，**不包含 `effective`**。Control Server 通过额外的 `GET /api/studio/settings` 调用获取 `effective`。此链路当前正常。

---

## 7. 记忆回写契约

### 7.1 正确行为

每次 reasoning session 结束后，`finalizeReasoningSessionWithQualityGate()` 应：

1. **更新 `ai/memory/STATUS.md`**:
   - 当前目标（1 个）
   - 阻塞项（如有）
   - 下一步行动（1 个）

2. **更新 `ai/memory/TASK_QUEUE.md`**:
   - 未完成的短任务列表（3-5 个）
   - 每个任务的状态：pending / in_progress / blocked / done

3. **更新 `ai/memory/LONG_TASKS.md`**:
   - 长任务方向（1-2 个）
   - 当前进度

### 7.2 当前状态（断裂）

| 文件 | 应有内容 | 实际内容 |
|------|----------|----------|
| `STATUS.md` | 当前目标、阻塞、下一步 | `Refresh ai/memory/STATUS.md after this run...`（自指指令） |
| `TASK_QUEUE.md` | 活跃短任务列表 | `Rewrite ai/memory/TASK_QUEUE.md so it keeps only active short tasks...` |
| `LONG_TASKS.md` | 长任务状态 | `Refresh ai/memory/LONG_TASKS.md so it reflects...` |

**后果**: Hermes Gateway 启动时通过环境变量注入这些文件，但文件内容为空/自指指令。Hermes 每次运行都从零上下文开始，无法积累历史知识。

---

## 8. 错误处理与降级策略

### 8.1 Control Server 层

| 故障场景 | 应有行为 | 当前状态 |
|----------|----------|----------|
| OMLX 不可达 | 3 次重试后标记失败，尝试 fallback 模型 | 有 transient probe failure budget（3 次），无模型 fallback |
| Hermes Gateway 崩溃 | 检测 log 中的 fault pattern，自动 fail session | ✅ 已实现（log watcher 轮询） |
| GameStudio Server 不可达 | 返回 retryable=true，由 workflow 决定是否重试 | ✅ 已实现 |
| 模型调用超限 | 应拆分 session 或提升 budget | ❌ 硬编码 MAX_MODEL_CALLS=8，容易超限 |

### 8.2 降级路径

```
OMLX (18888) 不可用
  → 若配置了 OpenAI API Key → 降级到 OpenAI
  → 若配置了 Ollama → 降级到 Ollama
  → 无任何可用模型 → 返回 deterministic fallback（ capability status answer ）
```

**当前问题**: `loadProviderModel()` / `unloadProviderModel()` 仅支持 `omlx` provider，OpenAI 和 Ollama 无法通过 Control 生命周期管理。

---

## 9. 已知缺陷清单

| # | 缺陷 | 严重度 | 影响 | 修复方向 |
|---|------|--------|------|----------|
| 1 | `getAiStatus()` 数据契约断裂 | 🔴 高 | 资产生成被跳过 | 适配 client 或修改服务端返回 |
| 2 | 记忆文件为空/自指 | 🔴 高 | Hermes 无历史上下文 | 在 session finalize 中写入记忆 |
| 3 | `story_validate_project` 无对应端点 | 🟡 中 | 仅校验 blueprint，不校验项目完整性 | 新增 `POST /api/projects/:id/validate/project` |
| 4 | `MAX_MODEL_CALLS_PER_SESSION = 8` | 🟡 中 | 完整 workflow 容易超限 | 提升至 16 或 24 |
| 5 | 硬编码 ComfyUI 路径 | 🟡 中 | 换机器后路径失效 | 改为从 env/studio settings 读取 |
| 6 | `direct` transport 硬编码模型 | 🟡 中 | Qwen3.6-35B 不可用时失败 | 支持模型列表探测和 fallback |
| 7 | Server 端 openai.js fallback URL 错误 | 🟢 低 | localoxml 未配置时打到 OpenAI | 修复 fallback 逻辑 |

---

## 10. 验证检查清单

启动链路前，确认以下检查项：

- [ ] GameStudio Server (`:1999`) 健康检查通过：`GET /api/health`
- [ ] Control Server (`:2099`) 健康检查通过：`GET /api/health`
- [ ] OMLX (`:18888`) 模型列表可获取：`GET /v1/models`
- [ ] Hermes Gateway (`:8742`) 进程运行中（PID 存在）
- [ ] `getAiStatus()` 返回包含有效的 `enabled` 信息
- [ ] `getStudioSettings()` 返回 `effective.enabled.image === true`
- [ ] `ai/memory/STATUS.md` 包含有效目标（非自指指令）
- [ ] `storage/projects/` 可读写

---

## 11. 附录：关键文件索引

| 文件 | 作用 |
|------|------|
| `apps/control-server/src/server/controlServerCore.js` | Control Server 执行引擎（9855 行） |
| `apps/control-server/src/server/services/gameStudioServerClient.js` | GameStudio Server 客户端封装 |
| `apps/control-server/src/server/model/modelTaskQueue.js` | 模型任务队列与路由 |
| `apps/server/src/index.js` | GameStudio Server 入口（7604 行） |
| `apps/server/src/ai/diagnostics.js` | AI 状态快照与诊断 |
| `apps/server/src/studio/settings.js` | Studio 配置与 effective 计算 |
| `config/hermes/manager.left-brain.json` | Hermes 模型路由配置 |
| `ai/memory/STATUS.md` | 当前目标与阻塞 |
| `ai/memory/TASK_QUEUE.md` | 短任务队列 |
| `state/story-production/current-project.json` | 当前生产项目状态 |
