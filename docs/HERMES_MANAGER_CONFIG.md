# HermesManager 配置说明

本文档定义 GameStudio 中 HermesManager 的最小可控启动配置，以及与 Hermes 原生读取机制的兼容关系。

## 目标

HermesManager 启动前，不仅要配置模型，还要显式配置：

- 短期记忆门槛
- 长期记忆文件
- 技能库路径与 SKILL.md 文件
- 左右脑启用状态

只有当这些项都完整可用时，控制台才允许启动 Hermes。

## 配置真相源

仓库内统一使用：

- config/hermes/manager.left-brain.json

该文件由 control-server 读取，并由 control-console 的左脑配置面板写回。

兼容策略：

- 如果旧的 Hermes 外部配置仍存在，server 会在读不到仓库配置时回退读取旧配置。
- 一旦在控制台保存，新的真相源就是仓库内的 config/hermes/manager.left-brain.json。

## 默认目录规划

- config/hermes/
- config/hermes/skills/
- ai/
- ai/memory/

职责如下：

- config/hermes: HermesManager 可写的控制配置
- config/hermes/skills: HermesManager 显式挂载的技能文件
- ai: GameStudio 的认知源文件
- ai/memory: GameStudio 的状态源文件

## 与 Hermes 原生机制的关系

这里必须区分两件事：

1. Hermes 原生内建记忆
  - Hermes 自己的持久记忆不是写到 ai/memory
  - Hermes 内建记忆使用自己的 memories 目录和 MEMORY.md / USER.md 机制

2. GameStudio 工作区状态
  - GameStudio 当前把项目状态源维护在 ai/ 和 ai/memory/
  - control 管理系统只允许 Hermes 按左脑配置中保存的 ai 路径读取这些源文件

因此当前 manager 的做法是：

- ai/ 和 ai/memory/ 作为项目内唯一源文件
- 左脑自检、保存配置、启动都直接使用保存后的 ai 路径
- 不把 ai/memory 误称为 Hermes 原生写回目录

## manager.left-brain.json 结构

```json
{
  "provider": "omlx",
  "baseUrl": "http://127.0.0.1:18888/v1",
  "model": "gpt-oss-20b-MXFP4-Q8",
  "shortTerm": {
    "minContextTokens": 65536
  },
  "memory": {
    "agentDefinitionFile": ".../ai/AGENTS.md",
    "userFile": ".../ai/USER.md",
    "memoryFile": ".../ai/MEMORY.md",
    "longTasksFile": ".../ai/memory/LONG_TASKS.md",
    "statusFile": ".../ai/memory/STATUS.md",
    "taskQueueFile": ".../ai/memory/TASK_QUEUE.md",
    "decisionsFile": ".../ai/memory/DECISIONS.md",
    "dailyLogDir": ".../ai/memory"
  },
  "skills": {
    "skillRoot": ".../config/hermes/skills",
    "skillFiles": [
      ".../config/hermes/skills/gamestudio-workspace/SKILL.md"
    ]
  },
  "brains": {
    "rightBrainEnabled": false
  }
}
```

## 启动判定

以下条件全部满足，左脑才允许启动：

- provider、baseUrl、model 已配置
- 模型上下文窗口不低于 65536 token
- ai/AGENTS.md、ai/USER.md、ai/MEMORY.md 存在
- ai/memory 下的 LONG_TASKS、STATUS、TASK_QUEUE、DECISIONS 存在
- 技能根目录存在
- skillFiles 至少有一个有效的 SKILL.md
- 右脑保持禁用

附加约束：

- 当 reasoning / workflow 执行改变项目状态、修复运行时规则或推进多步骤任务时，必须在最终回答前安排记忆同步步骤，至少更新 `STATUS.md` 与 `TASK_QUEUE.md`，并在规则或长线主线变更时同步 `DECISIONS.md` 与 `LONG_TASKS.md`
- 当日日志只读取当天 `ai/memory/YYYY-MM-DD.md`；当天文件不存在时不回退旧日志

## 当前默认技能

- config/hermes/skills/gamestudio-workspace/SKILL.md

该技能只负责给 HermesManager 提供最小上下文入口，避免为理解项目而全仓扫描。

## 控制台行为

当前控制台的约束是：

- 左脑面板负责模型、记忆、技能配置
- 左脑必须先完成一次显式自检，才能启动
- 右脑保持置灰，不参与启动
- 启动失败时，server 返回缺失项，console 直接展示具体阻塞
- 自检和启动日志统一写入顶部日志窗口
