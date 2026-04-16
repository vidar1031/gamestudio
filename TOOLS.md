# TOOLS.md - GameStudio 环境配置

## 本地服务

### OpenClaw Gateway
- URL: `ws://127.0.0.1:18789`
- Token: 从本机私有配置读取（不要写入仓库文档）
- 认证模式: token
- 状态检查: `openclaw status`

### omlx 本地模型服务
- URL: `http://127.0.0.1:18888/v1`
- API Key: `omlx123`
- 可用模型:
  - `gemma-4-26b-a4b-it-4bit` (主模型，128k ctx)
  - `Qwen3.5-27B-Claude-4.6-Opus-Distilled-MLX-4bit` (推理模型，131k ctx)
- 状态检查: `curl http://127.0.0.1:18888/v1/models`

### GameStudio Server
- URL: `http://127.0.0.1:1999`
- 健康检查: `curl http://127.0.0.1:1999/api/health`
- 诊断接口: `curl -X POST http://127.0.0.1:1999/api/studio/diagnose`
- 启动: `./start_project.sh --detached`
- 状态: `./status_project.sh`
- 停止: `./stop_project.sh`

### GameStudio Editor
- URL: `http://localhost:8868`
- 类型: Vite + React 18 + TypeScript
- 构建: `npm run build --workspace @game-studio/editor`
- 类型检查: `npm run typecheck --workspace @game-studio/editor`

## 项目路径

### 核心目录
- 项目根: `/Volumes/ovokit2t/aiwork/gamestudio`
- 服务端: `apps/server/src/`
- 编辑器: `apps/editor/src/`
- 记忆库: `memory/`
- OpenClaw 配置: `~/.openclaw/`

### 关键文件
- 项目配置: `AGENTS.md`, `MEMORY.md`, `PROJECT_PLAN.md`
- 任务队列: `memory/TASK_QUEUE.md`
- 状态追踪: `memory/STATUS.md`
- 决策记录: `memory/DECISIONS.md`
- 每日日志: `memory/YYYY-MM-DD.md`

## 验证命令

### 服务端检查
```bash
node --check apps/server/src/index.js
node --check apps/server/src/ai/storyAssets.js
node --check apps/server/src/ai/ollama.js
node --check apps/server/src/ai/translate.js
```

### 编辑器检查
```bash
npm run typecheck --workspace @game-studio/editor
npm --workspace @game-studio/editor run typecheck
```

### 项目健康
```bash
bash status_project.sh
curl -sS http://127.0.0.1:1999/api/health
curl -sS http://localhost:8868
```

## SSH/远程

- 无远程部署，全部本地运行

## 监控

### OpenClaw 监控
- Dashboard: `http://localhost:9876`
- 日志: `/tmp/monitor.log`
- 启动: `cd monitor/openclaw && npm start`
- 停止: `cd monitor/openclaw && npm run stop`

## 注意事项

- 本地无 Docker，sandbox 模式不可用
- 代理配置: `NO_PROXY=localhost,127.0.0.1`
- Node 版本: 25.9.0 (nvm 管理)
- 项目运行在扩展盘 `/Volumes/ovokit2t/`
