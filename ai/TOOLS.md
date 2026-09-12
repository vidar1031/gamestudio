# TOOLS - GameStudio Control / Hermes Tool Catalog

## 运行时与接口

- OMLX: `http://127.0.0.1:18888/v1`
- GameStudio Server: `http://127.0.0.1:1999`
- GameStudio Editor: `http://localhost:8868`
- Control Server: `http://127.0.0.1:2099`
- Control Console: `http://127.0.0.1:8870`

## 控制平面常用接口

- 聊天发送：`POST /api/control/agents/hermes-manager/ping-model`
- agent 流式咨询（answer_only/R013 咨询路径，SSE）：`POST /api/control/agents/hermes-manager/agent-stream`
- 发送预览：`POST /api/control/agents/hermes-manager/submission-preview`
- 可观测执行创建：`POST /api/control/agents/hermes-manager/reasoning-sessions`
- 可观测执行查询：`GET /api/control/agents/hermes-manager/reasoning-sessions/:sessionId`
- 可观测执行审核：`POST /api/control/agents/hermes-manager/reasoning-sessions/:sessionId/review`
- 失败会话人工重试（受控）：`POST /api/control/agents/hermes-manager/reasoning-sessions/:sessionId/retry`
- 工作流诊断：`GET /api/control/agents/hermes-manager/workflow-diagnostics`
- 历史会话检索（只读，直查 Hermes state.db FTS5）：`GET /api/control/hermes/session-search?q=`

### 事件层与项目绑定

- 事件注册表（跟随当前绑定项目）：`GET /api/control/events/registry`
- 事件执行历史：`GET /api/control/events/runs`
- 事件执行入口（唯一）：`POST /api/control/events/dispatch`
- 当前绑定项目读取/修改：`GET /api/control/project-binding`、`PUT /api/control/project-binding`

### 治理页对应端点

- 待审核中心：`GET /api/control/reviews/pending`
- 治理操作审计：`GET /api/control/governance/audit`
- 任务队列只读列表/详情：`GET /api/control/queue/items`、`GET /api/control/queue/items/:sessionId`
- 资源互斥调度状态（AUTO-R01）：`GET /api/control/resources/state`
- cron 定时任务：`GET/POST /api/control/cron/jobs`、`POST /api/control/cron/jobs/:jobId/status`、`DELETE /api/control/cron/jobs/:jobId`、`POST /api/control/cron/jobs/:jobId/trigger`
- 右脑监察：`GET /api/control/supervision/right-brain`、`POST /api/control/supervision/right-brain/run`、`POST /api/control/supervision/right-brain/runs/:runId/suggestions/:suggestionId/review`；运行状态：`GET /api/control/supervision/state`
- 项目/workflow 注册表：`GET /api/control/registry/overview`、`GET /api/control/registry/projects`、`GET /api/control/registry/workflows`、受控触发 `POST /api/control/registry/workflows/:workflowId/runs`、run 审核 `POST /api/control/registry/runs/:runId/review`
- 技能治理：候选扫描 `GET /api/control/skills/candidates`、候选内容 `GET /api/control/skills/candidates/:name/content`、人审 `POST /api/control/skills/candidates/:name/review`、已激活 `GET /api/control/skills/active`

## GameStudio Server 常用接口

- 故事完整度核实（真实浏览器逐节点走查导出 H5 + Kimi 视觉评审，异步任务）：`POST /api/projects/:id/ai/story/completeness-check`
- 最近完整度报告：`GET /api/projects/:id/ai/story/completeness-check/latest`
- 任务进度轮询：`GET /api/projects/:id/ai/tasks`
- 出图总账（需要多少图/完成多少/缺哪些，确定性只读聚合）：`GET /api/projects/:id/ai/coverage`；control 代理：`GET /api/control/gamestudio/projects/:projectId/ai/coverage`
- 场景↦资产关联确定性修复（名称/别名子串匹配，支持 aliasOverrides 证据别名）：`POST /api/projects/:id/ai/story/assets/plan/repair-links`
- 角色动作立绘（绿幕图生成；2026-09-01 定型配方：指纹前置+去人类化+动物主语+动作强调 `(…:1.25)`，中文动作词服务端自动转英文；`characterId` 可接 IPAdapter 但默认关——实测各档位都会锚死主参考站姿，`STUDIO_SPRITE_IPADAPTER=on` 才启用）：`POST /api/projects/:id/ai/character/sprite`
- 立绘抠图（RMBG 语义分割 → 透明 PNG；已替代前端 chroma key——按颜色抠图对衣服撞色/渐变底会挖穿）：`POST /api/projects/:id/ai/character/cutout`

## 权威目录

- 仓库根：`/Volumes/ovokit2t/aiwork/gamestudio`
- 编辑器源码：`apps/editor/src`
- 业务后端源码：`apps/server/src`
- 控制台前端源码：`apps/control-console/src`
- 控制台后端源码：`apps/control-server/src`
- 项目存储目录：`storage/projects`
- Demo 素材目录：`storage/demo_library`
- Hermes 项目记忆目录：`ai`

## 项目命令

### 业务服务

```bash
./start_project.sh
./start_project.sh --detached
./status_project.sh
./stop_project.sh
```

### 控制平面

```bash
sh restart_control.sh
```

### 健康检查

```bash
curl -sS http://127.0.0.1:1999/api/health
curl -sS http://localhost:8868
curl -sS http://127.0.0.1:2099/api/health
curl -sS http://127.0.0.1:2099/api/control/agents/hermes-manager/workflow-diagnostics
```

### 校验命令

```bash
npm run typecheck
npm --workspace @game-studio/editor run typecheck
npm --workspace @game-studio/control-console run typecheck
node --check apps/control-server/src/index.js
node --check apps/server/src/index.js
```

## 使用原则

- stories / 项目扫描类任务优先检查 `storage/projects`
- 目录缺失时必须显式报告，不要把空结果当成成功
- 对 editor schema、节点结构、角色/资源关系的判断，以 `ai/interactive_story_editor.contract.md` 为准
