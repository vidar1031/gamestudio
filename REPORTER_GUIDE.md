# Reporter 指南（当前生效版）

## 目标

Reporter 用于输出项目状态摘要，不负责改代码。

## 当前推荐用法

### 1) 手动执行一次汇报（最稳定）

```bash
cd /Volumes/ovokit2t/aiwork/gamestudio
bash scripts/lifecycle/reporter.sh
```

### 2) 作为启动后动作

- 启动后可由会话或脚本触发 `reporter.sh`。
- 若自动触发失败，回退到手动执行即可。

## 汇报输入源

Reporter 读取以下数据：

- `memory/STATUS.md`
- `memory/TASK_QUEUE.md`
- `memory/YYYY-MM-DD.md`
- `scripts/lifecycle/status_project.sh`

## 职责边界

- 做：读取状态并汇报
- 不做：改代码、改配置、重构流程

## 常见问题

### 启动后未自动汇报

先手动执行：

```bash
bash scripts/lifecycle/reporter.sh
```

如果手动正常，说明是启动触发链路问题，不是 reporter 内容问题。

### 汇报信息缺失

- 检查 `memory/STATUS.md`、`memory/TASK_QUEUE.md` 是否存在且有内容。
- 检查 `bash scripts/lifecycle/status_project.sh` 是否可执行。

## 相关文件

- `AGENTS.md`
- `BOOT.md`
- `scripts/lifecycle/reporter.sh`
- `memory/STATUS.md`
- `memory/TASK_QUEUE.md`
