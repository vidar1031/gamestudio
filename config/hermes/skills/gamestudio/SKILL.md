---
name: gamestudio
description: "Diagnose GameStudio story tool components, verify component status, generate operational reports. Covers Control Server, ComfyUI backend, storage layer, story workflows, and export verification."
version: 1.0.1
created: 2026-05-14
tags:
  - gamestudio
  - story-tool
  - diagnostic
  - status-check
  - comfyui
  - control-server
  - story-workflow
---

# GameStudio — Story Tool Diagnostic and Status Verification

Class-level skill for diagnosing GameStudio story tool components, verifying component status, and generating operational reports.

## Triggers

- User asks about GameStudio story tool status, boot, or whether components are running
- User asks "游戏故事工具是否启动" or similar Chinese queries about GameStudio
- User references "gamestudio" in context of story creation, asset generation, or workflow
- Automated quality review flags gamestudio bootstrap/readiness checks

## Component Model

GameStudio consists of these interconnected components:

1. **GameStudio Server** — 业务后端 API（默认端口 1999，健康检查 `http://127.0.0.1:1999/api/health`），项目读写/编译/校验/资产/导出
2. **Editor** — Vite + React SPA 编辑器（默认端口 8868），无 /health 端点
3. **Control Server** — 控制平面后端（默认端口 2099，`http://127.0.0.1:2099/api/health`），任务编排/审核/治理
4. **Control Console（守护台）** — 控制平面 UI（默认端口 8870）
5. **ComfyUI Backend** — 出图引擎（默认端口 8188）
6. **OMLX** — 本地模型服务（默认端口 18888，`/health`）
7. **Storage Layer** — `storage/projects/` 目录（项目真相源：meta.json, project.json, story.json, scripts.json, blueprint.json, assets/, story-assets/）
8. **Server Source** — `apps/server/src/`（AI 集成、蓝图编译、校验）；ComfyUI 工作流模板在 `apps/server/workflows/`
9. **Hermes Gateway** — agent/LLM 路由层（API server 默认端口 8742）

## Diagnostic Procedure

When verifying GameStudio status, follow this sequence:

### Step 1: GameStudio Server + Editor Check

```bash
# GameStudio Server 健康检查（权威）
curl -s -o /dev/null -w "HTTP_CODE:%{http_code}" http://127.0.0.1:1999/api/health

# Editor（Vite SPA，无 /health）可访问性
curl -s -o /dev/null -w "HTTP_CODE:%{http_code}" http://localhost:8868/

# Control Server 健康检查
curl -s -o /dev/null -w "HTTP_CODE:%{http_code}" http://127.0.0.1:2099/api/health
```

Expected: 1999 `/api/health` 返回 ok，8868 返回 SPA HTML，2099 `/api/health` 返回 ok。

### Step 2: ComfyUI Backend Check

```bash
# Check if port 8188 is listening
lsof -i :8188 2>/dev/null | head -5

# Check HTTP ping
curl -s http://127.0.0.1:8188/ping 2>/dev/null; echo "EXIT:$?"
# Exit code 7 = connection refused = NOT running
```

Expected: Port 8188 listening, ping returns 200. If exit code 7 (connection refused), ComfyUI is NOT running — this is a critical missing component for AI asset generation.

### Step 3: Storage Layer Verification

```bash
# Count projects
ls storage/projects/ 2>/dev/null | wc -l

# List project directories
ls storage/projects/ 2>/dev/null

# Check latest project structure
ls storage/projects/<project-id>/ 2>/dev/null
```

Expected files in each project directory: `ai_blueprint_review.json`, `assets/`, `blueprint.json`, `meta.json`, `project.json`, `scripts.json`, `story-assets/`, `story.json`

### Step 4: Story Content Verification

```bash
# Check story.json (narrative structure)
cat storage/projects/<project-id>/story.json | head -20

# Check project.json (asset configuration, scenes, characters)
cat storage/projects/<project-id>/project.json | head -30

# Check meta.json (project metadata, AI formula)
cat storage/projects/<project-id>/meta.json
```

### Step 5: Server Source Verification

```bash
# Check workflow templates
ls apps/server/workflows/

# Check AI integration source
ls apps/server/src/ai/

# Check blueprint compilation
ls apps/server/src/blueprint/
```

### Step 6: Export/Build Verification

```bash
# Check exported builds exist
ls storage/projects/<project-id>/builds/ 2>/dev/null

# Verify dist output
ls storage/projects/<project-id>/builds/latest/dist/index.html 2>/dev/null
```

## Status Report Template

When reporting status, always cover:

```
## GameStudio 故事工具状态报告 (YYYY-MM-DD HH:MM)

### 总评：[完全运行中 / 部分运行中 / 关键组件缺失]

| 组件 | 状态 | 详情 |
|------|------|------|
| GameStudio Server (port 1999) | 运行中/未运行 | [/api/health, HTTP status] |
| Editor (port 8868) | 可访问/不可用 | [SPA status] |
| Control Server (port 2099) | 运行中/未运行 | [/api/health] |
| ComfyUI (port 8188) | 运行中/未运行 | [port binding, ping result] |
| 存储项目 | [N] 个项目 | [list of project IDs] |
| 故事资产 (AI 图像) | 部分/完整/缺失 | [asset count, missing count] |
| 编辑器界面 | 可访问/不可用 | [SPA status] |
| 导出产物 | [路径/状态] | [build verification] |

### 问题清单
1. [Critical issue 1]
2. [Critical issue 2]

### 建议操作
1. [Actionable step 1]
2. [Actionable step 2]
```

## Pitfalls

- **ComfyUI missing is silent failure**: The editor may appear "running" (Control Server responds HTTP 200), but without ComfyUI on port 8188, AI image generation silently fails. Always check port 8188 independently.
- **Export path references can be stale**: Projects may reference build paths (`storage/projects/<id>/builds/latest/dist/index.html`) that don't exist — always verify the file actually exists, not just that the reference exists in config.
- **Story asset referenceStatus**: In project.json, check `referenceStatus` field for each asset. "missing" means the asset was never generated (ComfyUI was unavailable); "ready" means generated successfully. "refRequired" assets will block scene rendering.
- **Partial asset generation**: Projects may have some assets (e.g., wolf character sheets) generated from previous successful ComfyUI runs, but still have missing critical assets (e.g., shepherd boy) because they were added later when ComfyUI was offline.
- **Terminal pipe security warnings**: When piping curl output to interpreters, use safer alternatives like `vet` or `tirith run`. Example: `curl -s http://127.0.0.1:1999/api/projects 2>/dev/null | python3 -m json.tool` will trigger security scans.
- **grep -P flag**: On macOS, `grep -P` (Perl regex) may not be available. Use `grep -E` (extended regex) or `awk` instead.

## 项目工作流记忆规则

**重要**：读取项目状态时，优先从 `ai/memory/` 子目录读取，而非 `memory/` 根目录。

- **状态文件路径**：`ai/memory/STATUS.md`（当前目标、结果、阻塞、下一步）
- **任务队列**：`ai/memory/TASK_QUEUE.md`（待处理任务队列）
- **决策记录**：`ai/memory/DECISIONS.md`（已验证的稳定规则）
- **当日进展**：由系统自动写入 `ai/memory/daily/YYYY-MM-DD.md`；**禁止手工在 `ai/memory/` 下创建按日期的日志文件**（AGENTS.md 禁令）
- **错误路径**：`memory/` 根目录（已弃用，参见 AGENTS.md）

**关键规则**：
- 读取项目状态时，始终先检查 `ai/memory/` 子目录下的文件
- 仅在共享记忆文件不存在、超过 7 天或明显不足时，才使用 `session_search`
- 记忆文件的写入遵循 AGENTS.md 的更新规则（状态变化更新 STATUS/TASK_QUEUE/DECISIONS，不写日期日志）

## References

- See `references/gamestudio-diagnostic-checklist.md` for a condensed one-page diagnostic checklist
- See `references/gamestudio-project-structure.md` for the expected project directory structure