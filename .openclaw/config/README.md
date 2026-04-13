# OpenClaw 工作区配置

本目录包含 OpenClaw AI 助理的工作区配置文件。

## 文件说明

| 文件 | 用途 |
|------|------|
| `AGENTS.md` | Agent 角色定义和行为规则 |
| `MEMORY.md` | 项目记忆和架构信息 |
| `PROJECT_PLAN.md` | 项目计划和验收标准 |
| `USER.md` | 用户偏好和协作方式 |
| `SOUL.md` | AI 行为准则 |
| `IDENTITY.md` | 工作区身份标识 |
| `BOOT.md` | 启动播种消息 |
| `HEARTBEAT.md` | 心跳和自动巡检规则 |
| `TOOLS.md` | 环境配置和验证命令 |

## 目录结构

```
.openclaw/
├── config/           # 配置文件
├── skills/           # 技能定义
└── workspace-state.json # 工作区状态
```

## 注意事项

- 这些文件由 OpenClaw 自动读取和管理
- 不要手动修改 `workspace-state.json`
- 修改配置文件后需要重启 OpenClaw Gateway
