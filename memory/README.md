# ⚠️ 此目录已弃用

`memory/` 根目录下的 markdown 记忆文件已迁移到 `ai/memory/`。

## 原因

- `ai/memory/` 是 agent 运行时唯一读取的记忆目录（见 `ai/AGENTS.md`）。
- `memory/` 和 `ai/memory/` 重复维护导致内容不同步、状态混乱。
- 为避免双源真相，统一使用 `ai/memory/` 作为权威记忆目录。

## 当前权威记忆位置

| 文件 | 用途 |
|------|------|
| `ai/memory/STATUS.md` | 当前目标、结果、阻塞、下一步 |
| `ai/memory/TASK_QUEUE.md` | 短任务推进队列 |
| `ai/memory/DECISIONS.md` | 生效中的稳定规则和架构边界 |
| `ai/memory/LONG_TASKS.md` | 长任务方向和里程碑 |

## 历史日志归档

按日期创建的日志文件（如 `2026-04-30.md`、`2026-05-15.md`）已归档到 `state/memory-archive/daily-logs/`。

## 规则

- **禁止**在 `memory/` 根目录下新建任何 markdown 文件。
- **禁止**在 `memory/` 根目录下恢复旧的 `STATUS.md`、`TASK_QUEUE.md`、`DECISIONS.md`。
- 所有记忆更新必须写入 `ai/memory/` 下的对应文件。
