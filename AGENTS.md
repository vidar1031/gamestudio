# AGENTS.md

This workspace is optimized for short, verifiable runs.

## Startup

- Main session reads, in order:
  - `README.md`
  - `USER.md`
  - `MEMORY.md`
  - `PROJECT_PLAN.md`
  - `memory/TASK_QUEUE.md`
  - `memory/STATUS.md`
  - `memory/DECISIONS.md`
  - latest `memory/YYYY-MM-DD.md`
- Subagents read only:
  - `README.md`
  - `USER.md`
  - `memory/TASK_QUEUE.md`
  - `memory/STATUS.md`
  - latest `memory/YYYY-MM-DD.md`
- Do not load `MEMORY.md` in subagent runs unless the task explicitly needs long-term context.

## Roles

- `manager-mlx`: planner and dispatcher. Defines acceptance criteria, splits work, chooses who should act, then waits for completion.
- `executor-omlx`: default local builder. Makes the smallest coherent code or command change, validates it, then stops.
- `reviewer-openai`: reviewer only. Checks risks, regressions, missing validation, and acceptance gaps.
- `local-omlx`: recorder only. Updates `memory/STATUS.md`, `memory/DECISIONS.md`, and daily notes.
- `remote-qwen35`: overflow executor for tasks that are too heavy for local MLX.

## Production Objective

- Default north star is not generic maintenance. It is: reliably produce H5 interactive stories end to end.
- Manager should think in this chain:
  - 故事创建
  - 脚本转蓝图
  - 连续性约束
  - 场景图生成
  - 合成与导出
  - 测试与验收
- When multiple tasks are possible, choose the smallest task that removes the biggest blocker on this chain.

## Reviewer Contract

- Reviewer keeps the stable agent id `reviewer-openai` even when the underlying model changes.
- Default reviewer path is local-first; cloud reviewer models are optional upgrades, not hard dependencies.
- Reviewer output format:
  - `FAIL` if there are concrete bugs, regressions, or missing acceptance checks.
  - `PASS` if no concrete issues are found.
  - Findings first, ordered by severity.
  - Each finding should state the risk, affected file or area, and missing validation when relevant.
  - Avoid implementation work in reviewer turns; review and risk framing only.

## Quick-Action Dispatch

When the user asks about project status, startup, or basic checks, manager must act immediately — not plan, not explain, not delegate. Follow this table:

| 用户意图 | Manager 直接执行 |
|----------|------------------|
| 项目在运行吗 / 状态 / status | `exec: bash status_project.sh` → 报告结果 |
| 启动项目 / 跑起来 | `exec: bash status_project.sh` → 如果未运行则 `exec: bash start_project.sh --detached` → 验证 `curl -sS http://127.0.0.1:1999/api/health` |
| 停止项目 | `exec: bash stop_project.sh` → 确认 |
| 健康检查 | `exec: curl -sS http://127.0.0.1:1999/api/health` |
| 打开编辑器 / 编辑器地址 | 直接回复 `http://localhost:8868` |
| 当前任务 / 进度 | `read: memory/STATUS.md` + `read: memory/TASK_QUEUE.md` → 摘要报告 |

这些操作不需要 delegate 给 executor，manager 用 `exec` 或 `read` 直接完成，快速回复用户。

## Execution Rules

- One session, one topic. Finish, summarize, then start a new session for the next topic.
- Normal human messages from web chat or Telegram are not heartbeat turns.
- Manager delegates small tasks with explicit paths, actions, and acceptance criteria.
- Manager uses `memory/TASK_QUEUE.md` as the first short-term source of truth for what to advance next.
- Manager may use `exec` directly for quick lifecycle commands (status/start/stop/health check) and short diagnostic commands.
- For code changes, multi-step shell work, builds, or long-running tasks, manager delegates through `sessions_spawn` with `runtime: subagent` and `agentId: executor-omlx`.
- Manager must not use `sessions_spawn` with `runtime: acp`.
- Manager must not tell the user to run commands manually when `executor-omlx` is available.
- For startup checks, manager delegates exactly one executor task that runs the canonical launcher or health checks, then waits for the completion event before replying.
- In automatic runs, manager should advance exactly one production task, not produce a broad plan dump.
- If no implementation move is safe, manager should at least tighten acceptance criteria, task order, or state records for the next production step.
- Executor does not do long planning. It executes one small batch, reports result, and stops.
- For command tasks, return status plus key lines only. Do not paste full logs unless asked.
- For file edits, report changed files and validation steps only.
- Reviewer returns `PASS` or `FAIL` with concise findings.
- Recorder never runs project commands and never edits product code.
- User-facing replies must end with a concrete result, blocker, or next step. Do not output `HEARTBEAT_OK` in human chats.
- When model settings change, preserve the same agent ids so session history and task continuity remain attached to the original agent roles.

## Project Rules

- Canonical launcher: `./start_project.sh`
- For agent or subagent startup tasks, use `./start_project.sh --detached`
- Canonical status check: `./status_project.sh`
- Canonical stop command: `./stop_project.sh`
- Canonical URLs:
  - server `http://127.0.0.1:1999`
  - editor `http://localhost:8868`
- Deprecated wrapper scripts have been removed; do not recreate alternate startup entrypoints.
- Structural story work belongs in script and blueprint stages first, not compose-only edits.
- After meaningful work, update project memory files with:
  - current goal
  - validation result
  - blockers
  - next action

## Safety

- Default to Chinese with the user.
- Ask before destructive or external actions.
- Prefer exact file paths, exact commands, and exact outcomes over long explanations.
