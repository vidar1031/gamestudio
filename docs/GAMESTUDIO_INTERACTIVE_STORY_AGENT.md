# GameStudio 交互故事智能体说明

## 定位

GameStudio 的交互故事智能体不是一个只靠聊天回答问题的助手，而是由 `control + Hermes + OMLX + GameStudio` 组成的受控自动化系统。

目标是让用户通过 Control Console 发起任务，由 Hermes/OMLX 负责理解、规划、生成和解释，由 Control Server 负责权限、工具、状态和审核，由 GameStudio 的业务服务完成真实项目读写、故事生成、资产生成、校验和导出。

核心原则：模型可以提出计划和内容，但项目状态必须来自可验证的工具结果，任务执行必须落在受控 action 和 workflow 上。

## 总体链路

```text
用户
  -> apps/control-console
  -> apps/control-server
  -> Hermes Manager
  -> Hermes Gateway
  -> OMLX / local model endpoint
  -> structured plan / answer
  -> control-server observable actions
  -> apps/server / storage/projects / filesystem
  -> 审核结果与最终回答
```

当前本地 OMLX 常用 endpoint：`http://127.0.0.1:18888/v1`。

Control 会先把请求交给 Hermes，Hermes 再根据当前左脑配置把任务路由到实际 provider/model。模型输出不能直接等同于执行结果，必须经过 Control Server 的工具层和审核层。

## 主要目录结构

```text
apps/
  control-console/      Control Console 前端，Vue + Vite
  control-server/       Control Server 后端，负责 Hermes 控制、reasoning、审核和工具执行
  editor/               H5 互动故事编辑器前端，React + TypeScript
  server/               GameStudio 业务后端，负责项目文件、AI 生成、资产、导出等业务 API

ai/
  AGENTS.md             Hermes/智能体运行边界与项目入口
  USER.md               用户偏好与协作边界
  MEMORY.md             项目权威事实与当前工作方式
  TOOLS.md              工具和命令说明
  memory/
    STATUS.md           当前状态
    TASK_QUEUE.md       短任务队列
    LONG_TASKS.md       长任务主线
    DECISIONS.md        已确认规则和取舍
    YYYY-MM-DD.md       当日日志
  chat/                 Hermes 聊天记录

config/
  hermes/
    manager.left-brain.json          左脑模型与 workflow 配置
    manager.left-brain.state.json    左脑运行状态
    skills/                          Hermes skill 规则
    intents/                         可扩展 intent 配置

docs/                   设计、控制、测试和流程文档
packages/               schema、runtime、builder 等共享包
state/
  agent-runtime-sessions/            可观测执行 session
  reasoning-sessions/                reasoning session
  agent-runtime-events.jsonl         agent runtime 事件流
  reasoning-review-records.jsonl     reasoning 审核记录
  context-pool/                      已确认上下文池

storage/
  projects/             故事项目创建与持久化目录
  demo_library/         demo 素材库
```

如果设置 `STUDIO_STORAGE_ROOT`，业务后端会以外部 storage 根目录下的 `projects/` 和 `demo_library/` 为准。

## 功能模块

### Control Console

目录：`apps/control-console`

职责：

- 提供用户提交任务、查看运行状态、审核计划和步骤的界面。
- 展示 Hermes 当前绑定、模型、endpoint、运行状态和诊断信息。
- 暴露上下文选择、上下文池、技能建议、记忆编辑等控制面能力。

它是交互入口，不直接执行文件系统操作。

### Control Server

目录：`apps/control-server`

职责：

- 管理 Hermes Agent 对象和运行时状态。
- 构建 reasoning plan、执行 observable action、记录 session 和事件。
- 维护 human review gate，控制哪些步骤需要人工确认。
- 连接 Hermes Gateway 与本地/远端模型 provider。
- 执行受控工具，如列目录、读文件、搜索、写入候选、运行白名单脚本。
- 将模型输出转化为可验证结果，而不是把模型回答直接当事实。

关键文件和模块：

- `src/server/controlServerCore.js`：control server 核心运行、session、审核、action 执行。
- `src/server/reasoning/heuristics.js`：常见问题检测、目录/文件推断、确定性答案和评分。
- `src/server/reasoning/promptBuilders.js`：planner prompt、fallback plan、plan normalization。
- `src/server/reasoning/modelRequests.js`：调用 Hermes/模型生成 plan 和 answer。
- `src/server/workspace/inspectors.js`：工作区目录和入口文件的可观测检查。
- `src/server/capabilities/actionRegistry.js`：reasoning action 注册表。
- `src/server/capabilities/toolRegistry.js`：reasoning tool 注册表。

### Hermes Manager

逻辑对象：`hermes-manager`

职责：

- 作为 GameStudio 控制面里的系统级代理对象。
- 读取项目记忆、技能、上下文池和近期会话。
- 将用户自然语言请求转换为任务图或回答。
- 在模型输出和 Control Server 工具层之间承担规划层角色。

Hermes Manager 不应该直接无约束读写项目文件。它的输出必须通过 Control Server 的 action schema、审核和执行器。

### OMLX / Local Model

职责：

- 生成计划、解释结果、生成故事文本、生成候选配置或候选文件内容。
- 根据 Control Server 注入的上下文回答问题。

限制：

- 模型不能作为唯一事实源。
- 模型计划不能越过 action schema。
- 模型可以建议读取 `scripts.json`，但只有任务明确需要脚本内容时才应执行。

### GameStudio Editor

目录：`apps/editor`

职责：

- 提供 H5 互动故事可视化编辑体验。
- 承载故事结构、场景、分镜、角色、背景、素材预览等创作界面。
- 通过业务后端 API 读取和保存项目数据。

它是用户创作和预览的主应用，不是 Hermes 控制平面。

### GameStudio Server

目录：`apps/server`

职责：

- 提供项目读写、资源管理、AI 生成、图片生成、导出等业务 API。
- 负责 `storage/projects` 中项目结构的真实创建、修改、验证和导出。
- 对接图片生成后端，如 ComfyUI、Stable Diffusion 或其他 provider。

常见职责：

- 项目文件管理。
- 故事结构生成与保存。
- 脚本和蓝图编译。
- 图片 prompt 生成。
- 背景、角色、故事资产生成。
- 项目校验和导出。

### Storage

目录：`storage`

职责：

- `storage/projects`：项目创建和持久化目录。
- `storage/demo_library`：demo 素材库。
- `storage/_config`：存储层配置。

任何“当前已有项目”“项目是否创建成功”“导出是否存在”等结论，都应回到 storage 或业务 API 的可观测证据。

## 智能体执行模式

### 普通聊天

适合：

- 简短问答。
- 解释目录职责。
- 查询当前状态。
- 生成建议或草案。

风险：

- 容易受到聊天历史干扰。
- 如果没有工具结果，回答可能只是基于记忆或推断。

### 可观测执行

适合：

- 多步骤任务。
- 需要列目录、读文件、搜索、写入或运行脚本的任务。
- 需要人工审核的任务。

要求：

- 先生成 plan。
- 每个 step 对应真实 action。
- step 执行后写入 session artifact。
- 最终答案必须基于 artifact，而不是重新幻想。

### Workflow 执行

这是后续应强化的方向。

适合：

- 创建项目。
- 生成故事。
- 生成脚本。
- 生成图片资产。
- 验证项目。
- 导出交付。

workflow 应该有固定输入、固定 action 链、固定产物路径和固定验收规则。自然语言只负责选择 workflow 和补齐参数。

## 当前实施顺序

现阶段不再优先扩大自由问答能力，而是把 GameStudio 智能化能力收敛到受控 workflow：

1. 先防崩：所有模型请求统一进入 Control Server 的全局模型任务队列，默认单并发运行，并按 session 限制模型调用预算；长任务持续写入 heartbeat，取消 session 必须中断等待链路。
2. 再固化基础题：项目事实类问题必须走 workflow/action/artifact/evaluator，而不是只读最近上下文后让模型直接回答。
3. 再固化故事 workflow：`create_story_project`、`configure_story_project`、`generate_story_outline`、`generate_story_scripts`、`generate_story_assets`、`validate_project`、`export_project` 必须逐个形成固定输入、固定 action、固定 artifact 和 deterministic evaluator。
4. 最后做强化：Hermes 的自我审查和失败总结只生成待审核 proposal，人工确认后才能晋级为 intent、workflow 或 evaluator 规则。

这个顺序的目标是避免 Hermes/OMLX 反复进入“模型回答 -> 模型评分 -> 模型重答 -> 模型再评分”的不稳定循环，让 Control Server 成为工程可靠性主体。

## 提问不是直接回答

Control Console 的用户提问先进入 Control Server 的意图判定层，而不是直接交给 Hermes/OMLX 回答。当前约定：

- 普通解释问题可以直接回答，但仍应受上下文预算和模型队列控制。
- 项目事实问题必须先收集目录、文件、搜索或业务 API artifact。
- 能力状态问题必须进入 `project_capability_status` 检查型 workflow，先验证文档、配置和代码证据，再回答“是否已完成/覆盖/建立/具备”。
- 项目创作和自动化问题必须进入注册 story workflow，不能只靠聊天文本声明成功。
- 写入和脚本类问题必须进入 review gate。

这个约定不与 Hermes 强化冲突。Hermes 的职责是帮助生成候选计划、候选内容、解释和 proposal；Control Server 的职责是决定当前问题应走哪种执行路径，并保证 artifacts 和 evaluator 能验证结果。

当前第一阶段决策只处理题目结构，不处理题目答案。它的输入是决策规则和当前题目，输出是类型、置信度和原因。只有类型确定后，系统才加载项目上下文并进入后续 plan、inspect、workflow 或 review 流程。这样可以避免测试题把 Hermes 直接带入“回答模式”，也能让 L1-11、L1-12、L1-15 等同类题复用一套检查规则。

## 为什么不能只靠关键词打标签

“打标签”或关键词路由可以帮助系统快速进入正确任务类型，但不能成为可靠性的主体。

这次 `找出 storage/projects 中当前已有项目` 失败的原因说明了风险：

1. 题目表达从“列出”换成“找出”。
2. 目录列表 intent 没有稳定命中。
3. 模型规划多生成了“读取 scripts.json 验证项目结构”的步骤。
4. 参数又错成读取 `storage/projects` 目录本身。
5. 执行器没有拒绝目录作为文件读取，触发 `EISDIR`。

所以正确方向不是无限补“找出、盘点、看看、有哪些”这类词，而是把任务升级为结构化能力：

- intent 用来粗路由。
- workflow 用来定义标准流程。
- action schema 用来限制模型能调用什么。
- executor guard 用来拒绝非法参数。
- artifact/evaluator 用来判断是否完成。

## 可靠性分层

### 第一层：语言路由

识别用户大概想做什么，例如：

- 列项目。
- 看项目内容。
- 创建故事项目。
- 生成故事大纲。
- 生成脚本。
- 验证项目。
- 导出项目。

这一层可以使用关键词、正则、模型分类或 intent 配置，但只能做入口。

### 第二层：结构化计划

把任务转成明确 plan：

```json
{
  "goal": "列出 storage/projects 当前已有项目",
  "strategy": "sequential",
  "steps": [
    {
      "action": "list_directory_contents",
      "params": { "dirPath": "storage/projects" },
      "skipReview": true
    },
    {
      "action": "generate_default_answer",
      "params": {},
      "skipReview": true
    }
  ]
}
```

### 第三层：action schema

每个 action 必须有明确参数和能力边界。

示例：

- `list_directory_contents` 只能接受目录。
- `read_file_content` 只能接受文件。
- `edit_workspace_file` 必须生成候选稿并等待审核。
- `run_lifecycle_script` 只能运行白名单脚本。
- `export_project` 必须返回导出路径和校验证据。

### 第四层：执行器保护

执行器必须拒绝不合理输入。

例如：

- 目录不能被 `read_file_content` 读取。
- 文件不能被 `list_directory_contents` 当目录列出。
- 路径不能逃出 workspace。
- 写入、删除、脚本执行必须经过审核。

### 第五层：artifact 和验收

每个任务完成后必须有证据：

- 扫描了哪个目录。
- 发现了哪些项目。
- 创建了哪些文件。
- 哪些校验通过。
- 导出产物在哪里。
- 哪些部分失败，失败原因是什么。

## 面向故事自动化的目标能力

建议逐步固化以下 workflow：

1. `list_projects`：列出当前项目。
2. `inspect_project`：读取项目 metadata、story、scripts、assets 摘要。
3. `create_story_project`：创建标准项目骨架。
4. `configure_story_project`：写入项目风格、模型、模板、生成参数。
5. `generate_story_outline`：生成故事大纲。
6. `generate_story_scripts`：生成脚本和节点结构。
7. `generate_story_assets`：生成或补齐图片资产。
8. `validate_project`：验证结构、资源引用、脚本完整性。
9. `export_project`：导出可交付项目。

这些 workflow 才是 GameStudio 自动化强化的主线。对话只是入口，workflow 和 action 才是可达成性的基础。

## 与 GPT / Claude 类系统的关系

GPT、Claude 或其他成熟 agent 系统也会使用标签、路由、工具 schema 和安全策略，但通常不会只靠关键词。

更常见的组合是：

- system prompt：设定行为边界。
- tool schema：约束可调用工具和参数。
- router / classifier：选择任务类型。
- memory / retrieval：提供上下文。
- planner：生成结构化步骤。
- executor：执行工具并做权限校验。
- evaluator：根据证据评估结果。
- human review：在高风险步骤前确认。

GameStudio 也应该采用这种分层，而不是把所有可靠性压在模型理解自然语言上。



### 中期项当前状态

- `已完成基础框架`：`config/hermes/intents` 已建立可配置 intent 机制，control-server 启动时可自动加载 JSON intent，也支持 `_inbox` 提案晋级；但当前还没有真正投入使用的项目级 JSON intent 文件。
- `未完成`：独立的 workflow registry 还没有建立，当前固定流程主要仍写在 `promptBuilders.js` 的 fallback plan 和 builtin intent 中。
- `部分完成`：模型 planner 输出已经被 action schema、allowed actions 和 plan normalization 约束，但还没有严格收敛到“只能落在已注册 workflow 上”。
- `部分完成`：deterministic evaluator 已覆盖目录列表、workspace 定位、仓库文件职责、仓库目录职责、图片服务入口等问题；但还没有做到每个故事 workflow 都有自己的 evaluator。
- `已开始`：Control Server 已建立全局模型任务队列，reasoning、quality gate、context draft、写入候选和普通 chat 的 Hermes/OMLX 请求统一排队，避免本地模型在测试题或故事 workflow 中被多个入口并发压垮。

### 长期项当前状态

- `进行中`：Control Server 已具备 reasoning session、review gate、quality gate、artifacts、memory sync、intent registry 等状态机雏形，但还不是完整的项目自动化状态机。
- `部分完成`：Hermes 已经承担候选计划、候选答案、候选改写内容和解释生成，但仍需要更多 project workflow 来承接它的输出。
- `部分完成`：GameStudio Server 已经承担项目读写、AI 生成、图片生成、校验和导出等业务 API，但与 control 的 story workflow contract 还未完全固化。
- `未完成`：故事生成、资产生成、验证、导出还没有全部通过 Control Console 形成端到端、可审核、可重复执行的统一闭环。
