# TOOLS - GameStudio Control / Hermes Tool Catalog

## 运行时与接口

- OMLX: `http://127.0.0.1:18888/v1`
- GameStudio Server: `http://127.0.0.1:1999`
- GameStudio Editor: `http://localhost:8868`
- Control Server: `http://127.0.0.1:2099`
- Control Console: `http://127.0.0.1:8870`

## 控制平面常用接口

- 聊天发送：`POST /api/control/agents/hermes-manager/ping-model`
- 发送预览：`POST /api/control/agents/hermes-manager/submission-preview`
- 可观测执行创建：`POST /api/control/agents/hermes-manager/reasoning-sessions`
- 可观测执行查询：`GET /api/control/agents/hermes-manager/reasoning-sessions/:sessionId`
- 可观测执行审核：`POST /api/control/agents/hermes-manager/reasoning-sessions/:sessionId/review`
- 工作流诊断：`GET /api/control/agents/hermes-manager/workflow-diagnostics`

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
