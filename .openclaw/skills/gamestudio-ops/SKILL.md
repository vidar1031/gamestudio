---
name: gamestudio-ops
description: Use when working on the local game_studio project and you need a stable workflow for understanding the project, running it, validating changes, updating project memory, or performing recurring maintenance through OpenClaw agents and cron.
---

# Gamestudio Ops

Use this skill for work inside `/Users/zhanghongqin/work/game_studio`.

## Read Order

- `README.md`
- `USER.md`
- `MEMORY.md` for main sessions only
- `PROJECT_PLAN.md`
- `memory/STATUS.md`
- `memory/DECISIONS.md`
- `SOP_AI_STORY_FLOW.md` for AI story creation workflow
- latest daily note in `memory/`

Then inspect only the files directly related to the current task.

## Chat Invocation Rule

When the human request mentions any of these intents, apply `SOP_AI_STORY_FLOW.md` by default:

- "AI创建故事"
- "生成提示文本"
- "随机结构公式"
- "脚本层草稿"
- "故事生成失败/重试"

Execution policy:

- Manager should first restate task input contract briefly.
- Execute step-by-step with pass/fail markers.
- Return output using the SOP output contract.
- If blocked, return minimal handoff instead of broad troubleshooting text.

## Canonical Runtime

- launcher: `bash start_project.sh`
- agent launcher: `bash start_project.sh --detached`
- status: `bash status_project.sh`
- stop: `bash stop_project.sh`
- server: `http://127.0.0.1:1999`
- editor: `http://localhost:8868`
- health: `curl -sS http://127.0.0.1:1999/api/health`

## H5 故事主链路 API（executor 必读）

所有 API 均通过 `exec` + `curl` 调用，**不要用 `web_fetch`**（会被安全策略拦截本地地址）。

### Stage 1: 故事创建（AI 生成）
```bash
# 创建项目 + AI 生成脚本（一步到位）
curl -sS -X POST http://127.0.0.1:1999/api/projects/ai/create \
  -H "Content-Type: application/json" \
  -d '{"prompt":"一个关于勇敢小兔的故事","title":"勇敢的兔子","choicePoints":2,"optionsPerChoice":2,"endings":2}'
# 返回: {success, project:{id,...}, scripts:{cards:[...]}, gen:{provider,model,durationMs}}
# 记下 project.id 用于后续步骤
```

### Stage 2: 蓝图编译（scripts → blueprint）
```bash
# 编译蓝图（POST，body 可为空 {}）
curl -sS -X POST http://127.0.0.1:1999/api/projects/{projectId}/compile/blueprint \
  -H "Content-Type: application/json" -d '{}'
# 返回: {success, blueprint:{startNodeId,nodes:[...]}, report:{errors,warnings,info}, validation:{ok,errors,warnings}}
```

### Stage 3: 蓝图验证（可选）
```bash
# 验证蓝图结构
curl -sS -X POST http://127.0.0.1:1999/api/projects/{projectId}/validate/blueprint \
  -H "Content-Type: application/json" -d '{}'
# AI 审查蓝图（需要 AI provider 可用）
curl -sS -X POST http://127.0.0.1:1999/api/projects/{projectId}/ai/review/blueprint \
  -H "Content-Type: application/json" -d '{}'
```

### Stage 4: 合成（blueprint → story.json）
```bash
# 合成运行时 story（蓝图 → 可播放结构）
curl -sS -X POST http://127.0.0.1:1999/api/projects/{projectId}/compile/compose \
  -H "Content-Type: application/json" -d '{}'
# 返回: 合成后的 story.json 内容
```

### Stage 5: 导出（story → H5 产物）
```bash
# 导出 H5（构建 dist 目录）
curl -sS -X POST http://127.0.0.1:1999/api/projects/{projectId}/export \
  -H "Content-Type: application/json" -d '{}'
# 返回: {buildId, distUrl} — distUrl 可在浏览器打开预览

# 导出 + 打包 ZIP
curl -sS -X POST http://127.0.0.1:1999/api/projects/{projectId}/export/publish \
  -H "Content-Type: application/json" -d '{}'
# 返回: {buildId, distUrl, packageUrl, packageName}
```

### 辅助 API
```bash
# 列出所有项目
curl -sS http://127.0.0.1:1999/api/projects

# 读取项目详情
curl -sS http://127.0.0.1:1999/api/projects/{projectId}

# 读取脚本
curl -sS http://127.0.0.1:1999/api/projects/{projectId}/scripts

# 读取蓝图
curl -sS http://127.0.0.1:1999/api/projects/{projectId}/blueprint

# 诊断所有 AI provider 状态
curl -sS -X POST http://127.0.0.1:1999/api/studio/diagnose -H "Content-Type: application/json" -d '{}'

# AI 状态
curl -sS http://127.0.0.1:1999/api/ai/status
```

### 验收判定规则
- Stage 1 通过: `scripts.cards` 非空且 ≥ 3 张卡
- Stage 2 通过: `blueprint.nodes` 非空且 `validation.ok === true` 且 `report.errors` 为空
- Stage 4 通过: story.json 中 `nodes` 非空且 `startNodeId` 存在
- Stage 5 通过: export 返回 `buildId` 且 `distUrl` 可访问（`curl -sS -o /dev/null -w "%{http_code}" {distUrl}` 返回 200）

## Agent Contract

- Manager defines acceptance criteria and delegates small verified tasks.
- Manager must treat human chat turns as normal requests, not heartbeat maintenance turns.
- **Intent-first rule**: when the user asks about project status, startup, stop, or health, manager must immediately run the corresponding command with `exec` and return the result. No planning, no delegation, no asking. Act first, report after.
- **API 调用规则**：所有对 127.0.0.1:1999 的调用一律用 `exec` + `curl`，**严禁使用 `web_fetch`**（会被安全策略拦截）。
- For basic lifecycle work (status/start/stop/health check), manager uses `exec` directly:
  - 状态/运行吗 → `bash status_project.sh`
  - 启动 → `bash start_project.sh --detached` → verify health
  - 停止 → `bash stop_project.sh`
  - 健康检查 → `curl -sS http://127.0.0.1:1999/api/health`
- For quick runtime checks like one short diagnostic command, manager may use `exec` or `process` directly.
- **production-push 规则**：manager 在自动推进时，如果任务只需要调几个 API（创建、编译、导出），manager 应直接用 `exec` + `curl` 完成，不需要 spawn executor。只有需要改代码或多步 shell debug 时才 spawn。
- 当 manager spawn executor 时，如果 executor 使用本地 9B 模型且任务涉及理解项目代码/查找 API，应改用 `remote-qwen35`（27B 模型）。
- For code changes, multi-step shell work, or anything long-running, manager delegates through `sessions_spawn` with `runtime: subagent`.
- Prefer `executor-omlx` first for small local execution work. If it returns timeout, abort, error, or no output, manager must immediately tell the user what failed, then either retry once with `remote-qwen35` or fall back to a direct local status check.
- If an inter-session follow-up arrives with text like `Continue where you left off. The previous model attempt failed or timed out.`, treat it as a child failure/continuation signal, not as a fresh human instruction.
- After such a continuation signal, manager must not blindly respawn the same labeled subagent task. First summarize the known child result or run one direct local fallback check.
- Manager must not use the ACP runtime for routine project checks.
- Manager must not ask the human to manually run project commands if `executor-omlx` is available for the task.
- Executor handles one small action batch at a time.
- Reviewer checks risks and missing validation.
- Recorder updates project memory only.
- Reviewer keeps a stable role identity even if its backing model changes; do not create a new reviewer agent id just because the model changes.

## Reviewer Output

- Start with `FAIL` when there are concrete findings; otherwise start with `PASS`.
- Focus on bugs, regressions, missing validation, and acceptance gaps.
- Keep findings concise and actionable.
- If no findings exist, state residual risk or testing gaps in one short block.

## Execution Rules

- Prefer one command batch or one code change batch per turn.
- Do not ask executor to return full logs by default.
- If a delegated task returns timeout, abort, error, or `(no output)`, manager must reply immediately with a short failure status before starting fallback work.
- For Telegram human chats, do not use `sessions_yield` for startup/status tasks. Either answer from the child completion event immediately or switch to a direct fallback check in the same turn.
- For Telegram startup/status/stop requests, prefer this exact order:
  - `bash status_project.sh`
  - if user asked to start and status is down, run `bash start_project.sh --detached`
  - if user asked to stop, run `bash stop_project.sh`
  - report the script result directly
- Return:
  - changed files or executed commands
  - pass/fail validation
  - next concrete step
- For startup/status requests, prefer direct `bash status_project.sh`, health checks, or one short local command batch first. Delegate only when the task is multi-step, long-running, or needs isolated execution.
- When delegation is necessary for startup/status work, the child agent should directly run the needed shell commands, then return the final conclusion instead of handing the shell snippet back to the user.
- For startup tasks launched by an agent, prefer `bash start_project.sh --detached`, then verify `http://127.0.0.1:1999/api/health` and `http://localhost:8868`.
- Ignore deprecated wrapper scripts with similar names; they are compatibility shims only, not decision targets.
- Run `npm run typecheck` before and after substantial TypeScript changes.
- Update memory files only when there is meaningful new state.

## AI Configuration Operations

项目的 AI 生产能力依赖两类模型：**文本生成**（写故事脚本）和 **图片生成**（做场景/背景图）。

### 快速检查 AI 状态

```bash
# 1. 确保服务在跑
bash status_project.sh

# 2. 当前 AI 设置
curl -sS http://127.0.0.1:1999/api/studio/settings | python3 -m json.tool

# 3. AI 运行状态快照
curl -sS http://127.0.0.1:1999/api/ai/status

# 4. 深度诊断（检测 provider 连通性）
curl -sS -X POST http://127.0.0.1:1999/api/ai/diagnose
```

### 修改 AI 设置

通过 API 修改，立即生效且持久化到 `storage/_config/studio_settings.json`：

```bash
# 切换文本模型
curl -sS -X PUT -H "Content-Type: application/json" \
  -d '{"scripts":{"provider":"ollama","model":"qwen3.5:27b-q4_K_M"}}' \
  http://127.0.0.1:1999/api/studio/settings

# 切换图片模型
curl -sS -X PUT -H "Content-Type: application/json" \
  -d '{"image":{"provider":"comfyui","model":"dreamshaper_8.safetensors"}}' \
  http://127.0.0.1:1999/api/studio/settings
```

### 查看可用模型

```bash
# 文本模型（ollama/openai 兼容端点）
curl -sS http://127.0.0.1:1999/api/ai/models

# SDWebUI 模型
curl -sS http://127.0.0.1:1999/api/studio/sdwebui/models

# ComfyUI 模型
curl -sS http://127.0.0.1:1999/api/studio/comfyui/models
```

### AI 配置意图映射

| 用户意图 | agent 操作 |
|---------|-----------|
| AI 配置/模型情况 | `curl -sS http://127.0.0.1:1999/api/studio/settings` |
| AI 能用吗/诊断 | `curl -sS -X POST http://127.0.0.1:1999/api/ai/diagnose` |
| 切换模型到 X | `PUT /api/studio/settings` + 对应 JSON body |
| 有哪些模型 | `GET /api/ai/models` |
| 测试出图 | `curl -sS -X POST http://127.0.0.1:1999/api/studio/image/test` |

### 已核实的故障模式（供自动化复用）

#### 1) 远程模型“启动了但创建仍失败”——`ECONNREFUSED`

特征：
- AI 故事创建返回 `ai_generate_failed`
- 错误里常见 `connect ECONNREFUSED <host>:18888`（远程 LLM 端口当时未监听/未就绪，或监听地址不对）

处理顺序（一次最小闭环）：
1. 先确认服务健康：`bash status_project.sh` / `curl -sS http://127.0.0.1:1999/api/health`
2. 再做 Provider 深度诊断：`curl -sS -X POST http://127.0.0.1:1999/api/ai/diagnose`
3. 如 diagnose 仍显示连接拒绝：
   - 等待 5~15 秒后重试一次（远程服务可能仍在初始化）
   - 必要时重启本地 game_studio：`./restart_project.sh`（会先 stop 再 start）

已核实现状（供判断优先级）：
- 当 `POST /api/ai/diagnose` 返回 `ok:true` 后，再跑 `bash smoke_test_pipeline.sh`，通常应能覆盖 Stage 2~6 的端到端闭环

#### 2) 蓝图“后果承接”告警——`missing_consequence` / `consequence_index_mismatch`

特征：
- 蓝图编译出现黄字提示（warnings），蓝图仍可能可达，但语义可能被“临时跳转收束”补齐

原因要点：
- 选择点 text 解析到多个选项，但后续找不到与之匹配的 `i后果k` 后果卡
- 或后果卡命名里 `i` 写错：`i` 表示“第几个选择点”，不是卡片序号

当前修复（已上线、用于 AI 自动生成）：
- 当 scripts 由 `POST /api/projects/ai/create` 或 `POST /api/projects/:id/ai/regenerate` 生成时，服务端会在写入 `scripts.json` 前做一次规范化，把后果卡 name 强制对齐为 `i后果k`（数字选项）/ `A后果`（字母选项）

所以自动化建议：
- 如果 warnings 仍存在，优先检查脚本是否真的缺“每个选择项 1 张后果卡”
- 人工/agent 侧按规则修正文案：
  - 选项必须换行且格式为 `选项1：...`、`选项2：...`
  - 后果卡 name 必须为 `i后果k`（例如第 1 个选择点的选项 2：`1后果2`）

#### 3) JSON 解析错误——`Expected ',' or '}' after property value ...`

特征：
- 常见于 automation/agent 发送的 `curl -d '<json>'` 中 JSON 字符串本身不合法（缺逗号/缺右花括号/多余逗号等）

处理方式：
- 直接把准备发送的 JSON body 复制出来，用 `python3 -m json.tool` 验证格式
- 避免 trailing comma，避免引号未转义导致截断

## Maintenance Mode

For heartbeat or cron:

- apply this section only to real heartbeat or cron turns, never to human DM/chat messages
- read `memory/STATUS.md` and the latest daily note first
- run lightweight checks
- record only meaningful deltas
- if nothing changed, keep the output minimal and use `HEARTBEAT_OK` only in that maintenance context
