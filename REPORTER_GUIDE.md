# Reporter Agent 使用指南

## 概述

Reporter Agent 是一个**主动汇报**的 Agent，在 OpenClaw 启动后会自动向用户汇报 GameStudio 项目的当前状态。

## 配置完成清单

✅ 已完成以下配置：

1. **AGENTS.md** - 添加了 `reporter-daily` 角色定义
2. **scripts/lifecycle/reporter.sh** - 汇报脚本（可执行）
3. **.openclaw/agents/reporter.yaml** - Agent 配置文件
4. **.openclaw/startup.yaml** - 启动配置
5. **BOOT.md** - 启动指令

## 如何使用

### 方式 1：在 OpenClaw UI 中配置

1. 打开 `/Volumes/ovokit2t/AIOVO/openclaw/OpenClaw.app`

2. 添加 Reporter Agent：
   - Agent ID: `reporter`
   - 名称: `Reporter`
   - 模型: `omlx/gemma-4-26b-a4b-it-4bit`
   - 系统提示词: 从 `AGENTS.md` 中复制 `reporter-daily` 的 System Prompt

3. 配置启动行为：
   - 在 OpenClaw 设置中找到 "Startup" 或 "Auto-run" 选项
   - 设置启动时执行: `bash scripts/lifecycle/reporter.sh`
   - 或使用 BOOT.md 中的指令

### 方式 2：手动触发汇报

在任何时候，你都可以让 reporter agent 执行汇报：

```bash
bash scripts/lifecycle/reporter.sh
```

### 方式 3：通过 OpenClaw 对话触发

在 OpenClaw 聊天中发送：
```
请汇报项目状态
```

Reporter agent 会自动执行汇报脚本并返回结果。

## 汇报内容

Reporter 会汇报以下信息：

1. **服务状态** - Server、Editor、Health API 是否运行
2. **当前目标** - 从 STATUS.md 提取
3. **待办任务** - 从 TASK_QUEUE.md 提取（前 3 个）
4. **阻塞项** - 当前阻塞项目推进的问题
5. **今日进展** - 从当日日志提取
6. **建议下一步** - 基于当前状态的建议

## 示例输出

```
📊 GameStudio 项目状态汇报
=========================

✅ 服务状态
- Server (:1999): 运行中
- Health API: 正常
- Editor (:8868): 可访问

📋 当前目标
让 OpenClaw 先具备"最基础的项目推进能力"

📝 待办任务（前 3 个）
[ ] 正式场景出图验证
[ ] 资产漂移记录
[ ] assetRefs 传递链路定位

🚧 阻塞项
当前机器未提供 Docker daemon

📈 今日进展
今日暂无日志

🎯 建议下一步
有待办任务需要处理
[ ] 正式场景出图验证

=========================
汇报完成 ✅
```

## 自定义汇报内容

如需修改汇报内容，编辑 `scripts/lifecycle/reporter.sh`：

```bash
# 添加新的汇报项
echo "🔔 自定义汇报项"
# 你的自定义逻辑
echo "汇报内容"
```

## 定时汇报（可选）

如果需要定时汇报（如每 2 小时），可以在 OpenClaw 的 Cron 配置中添加：

```json
{
  "id": "reporter-cron",
  "agentId": "reporter",
  "schedule": {
    "kind": "every",
    "everyMs": 7200000  // 2 小时
  },
  "payload": {
    "kind": "agentTurn",
    "message": "请执行项目状态汇报"
  }
}
```

## 故障排查

### 问题：Reporter 未自动启动
- 检查 BOOT.md 是否正确配置
- 检查 reporter agent 是否在 OpenClaw 中正确添加
- 手动运行 `bash scripts/lifecycle/reporter.sh` 测试

### 问题：汇报内容不完整
- 检查 `memory/STATUS.md` 是否存在
- 检查 `memory/TASK_QUEUE.md` 是否存在
- 检查服务是否正常运行

### 问题：脚本执行失败
- 检查脚本权限：`ls -la scripts/lifecycle/reporter.sh`
- 检查项目目录：`pwd` 应该在 `/Volumes/ovokit2t/aiwork/gamestudio`

## 文件位置

| 文件 | 用途 |
|------|------|
| `AGENTS.md` | Agent 角色定义 |
| `scripts/lifecycle/reporter.sh` | 汇报脚本 |
| `.openclaw/agents/reporter.yaml` | Agent 配置 |
| `.openclaw/startup.yaml` | 启动配置 |
| `BOOT.md` | 启动指令 |
