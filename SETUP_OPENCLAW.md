# OpenClaw 配置指南

## 环境信息

- **OpenClaw 应用**: `/Volumes/ovokit2t/AIOVO/openclaw/OpenClaw.app`
- **项目工作区**: `/Volumes/ovokit2t/aiwork/gamestudio/`
- **omlx 模型服务**: `http://127.0.0.1:18888/v1`
- **OpenClaw 版本**: 2026.4.12-beta.1

> 注意：本指南只保留当前可执行链路。不要在仓库文档中保存真实 token。

## 配置方式

### 1. 通过 OpenClaw UI 配置（推荐）

1. **打开 OpenClaw 应用**
   - 路径：`/Volumes/ovokit2t/AIOVO/openclaw/OpenClaw.app`

2. **添加工作区**
   - 打开工作区：`/Volumes/ovokit2t/aiwork/gamestudio/`
   - OpenClaw 会自动读取以下文件：
     - `AGENTS.md` - Agent 角色定义
     - `MEMORY.md` - 项目记忆
     - `PROJECT_PLAN.md` - 项目计划
     - `.openclaw/skills/` - 项目技能

3. **配置 Gateway**
   - 打开 OpenClaw 设置
   - 配置 Gateway：
     - Mode: `local`
     - Auth: `token`
     - Token: 从 `~/.openclaw/openclaw.json` 获取

4. **配置模型**
   - 在 OpenClaw 设置中添加 omlx Provider：
     - Base URL: `http://127.0.0.1:18888/v1`
     - API Key: `omlx123`
     - API: `openai-completions`
   - 添加模型：
     - `gemma-4-26b-a4b-it-4bit` (128k context)
     - `Qwen3.5-27B-Claude-4.6-Opus-Distilled-MLX-4bit` (131k context)

5. **配置 Agent**
   - 在 OpenClaw 设置中添加 3 个 Agent：
     - **planner**: 使用 `gemma-4-26b-a4b-it-4bit`
     - **executor**: 使用 `gemma-4-26b-a4b-it-4bit`
     - **critic**: 使用 `gemma-4-26b-a4b-it-4bit`

### 2. 通过配置文件（直接编辑）

编辑 `~/.openclaw/openclaw.json`：

```json
{
  "gateway": {
    "mode": "local",
    "auth": {
      "mode": "token",
      "token": "你的token"
    }
  },
  "agents": {
    "defaults": {
      "workspace": "/Volumes/ovokit2t/aiwork/gamestudio/",
      "model": {
        "primary": "omlx/gemma-4-26b-a4b-it-4bit"
      },
      "sandbox": {
        "mode": "off"
      },
      "maxConcurrent": 1,
      "subagents": {
        "maxConcurrent": 1
      }
    },
    "list": [
      {
        "id": "planner",
        "name": "Planner",
        "model": {
          "primary": "omlx/gemma-4-26b-a4b-it-4bit"
        },
        "systemPromptOverride": "You are a Planner agent. Your role is to analyze tasks, break them into clear steps, and coordinate with Executor and Critic agents."
      },
      {
        "id": "executor",
        "name": "Executor",
        "model": "omlx/gemma-4-26b-a4b-it-4bit"
      },
      {
        "id": "critic",
        "name": "Critic",
        "model": {
          "primary": "omlx/gemma-4-26b-a4b-it-4bit"
        },
        "systemPromptOverride": "You are a Critic agent. Your role is to review code changes, identify bugs, security issues, and suggest improvements."
      }
    ]
  },
  "models": {
    "mode": "replace",
    "providers": {
      "omlx": {
        "baseUrl": "http://127.0.0.1:18888/v1",
        "apiKey": "omlx123",
        "api": "openai-completions",
        "models": [
          {
            "id": "gemma-4-26b-a4b-it-4bit",
            "name": "Gemma 4 26B A4B IT",
            "contextWindow": 128000,
            "maxTokens": 8192
          },
          {
            "id": "Qwen3.5-27B-Claude-4.6-Opus-Distilled-MLX-4bit",
            "name": "Qwen3.5 27B",
            "contextWindow": 131072,
            "maxTokens": 8192
          }
        ]
      }
    }
  },
  "tools": {
    "deny": ["group:web", "browser"]
  }
}
```

## 验证配置

1. **打开 OpenClaw 应用**
   ```bash
   open "/Volumes/ovokit2t/AIOVO/openclaw/OpenClaw.app"
   ```

2. **验证工作区加载**
   - 打开 `/Volumes/ovokit2t/aiwork/gamestudio/`
   - 确认 Agent 列表显示 planner, executor, critic
   - 确认模型可用

3. **测试模型连接**
   - 在 OpenClaw 中发送测试消息
   - 或使用 UI 中的测试功能

4. **验证 Skills 加载**
   - 检查 OpenClaw 是否识别 `gamestudio-ops` 技能
   - 确认可以调用项目 API

## 快速启动

```bash
# 1. 启动 omlx 模型服务（如果未运行）
# omlx 服务路径：检查你的 omlx 配置

# 2. 启动 OpenClaw Gateway（如果未运行）
# 通过 OpenClaw UI 启动

# 3. 启动项目服务
bash /Volumes/ovokit2t/aiwork/gamestudio/scripts/lifecycle/start_project.sh --detached

# 4. 验证服务
curl -sS http://127.0.0.1:1999/api/health
curl -sS http://localhost:8868
```

## 故障排查

### 问题：OpenClaw 无法找到工作区配置
- 确认工作区路径正确：`/Volumes/ovokit2t/aiwork/gamestudio/`
- 确认 `.md` 文件在根目录
- 确认 `.openclaw/skills/` 目录存在

### 问题：模型连接失败
```bash
# 检查 omlx 服务
curl http://127.0.0.1:18888/v1/models
curl -H "Authorization: Bearer omlx123" http://127.0.0.1:18888/v1/models
```

### 问题：Agent 无法执行
- 检查 Gateway 状态
- 检查 Agent 配置是否正确
- 确认模型服务可用

### 问题：monitor 反复 unauthorized / token mismatch
- 说明网关 token 与 monitor 使用的 token 不一致。
- 不要把 token 写入仓库文档；应从本机私有配置读取并保持单一来源。

### 问题：launchd 任务加载了但脚本不执行（exit code 126）
- 若日志出现 `Operation not permitted` / `Sandbox deny file-read-data`，通常是系统对外置盘路径脚本读取限制。
- 先用手动脚本确认功能，再决定是否迁移执行位置。
