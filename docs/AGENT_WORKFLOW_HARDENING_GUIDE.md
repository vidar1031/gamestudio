# GameStudio 智能体强化升级指南

## 目的

本文档说明如何把自然语言任务逐步升级成 GameStudio 可稳定完成的智能体 workflow。

重点不是无限增加关键词，而是建立从“任务题目”到“准确识别”再到“受控执行”和“验收证据”的完整闭环。

适用范围：

- Control Console 提交的 Hermes/OMLX 任务。
- `apps/control-server` 中的 reasoning plan、action 执行和审核流程。
- `config/hermes/skills` 和 `config/hermes/intents` 中的路由提示。
- GameStudio 项目创建、故事生成、资产生成、验证和导出任务。

## 基本判断

### 不推荐的方式

```text
用户换一种说法 -> 补一个关键词 -> 再失败 -> 再补一个关键词
```

这种方式短期有效，但长期会导致规则膨胀、误判变多、模型绕过规则、维护困难。

### 推荐的方式

```text
任务题目
  -> 归一化为少数高层 intent
  -> 选择固定 workflow
  -> 生成受控 action plan
  -> executor 校验参数和权限
  -> 写入 artifact
  -> evaluator 验收
  -> 输出证据化结论
```

关键词或标签只负责入口路由，不负责最终可靠性。

## 分层结构

### 1. 任务题目层

来源：用户在 Control Console 或聊天里输入的自然语言。

示例：

- 找出 `storage/projects` 中当前已有项目。
- 扫描当前项目，说明有哪些 story/script 文件。
- 创建一个新的互动故事项目。
- 基于 brief 生成故事大纲。
- 生成项目导出包。

要求：

- 允许自然语言多样表达。
- 不要求用户记住内部 action 名称。
- 不把自然语言直接当执行命令。

### 2. Intent 识别层

目标：把自然语言归一化为少数任务类型。

建议的高层 intent：

| intent | 说明 |
| --- | --- |
| `list_projects` | 列出当前已有项目 |
| `inspect_project` | 检查某个项目结构和摘要 |
| `create_story_project` | 创建故事项目骨架 |
| `configure_story_project` | 配置项目生成参数 |
| `generate_story_outline` | 生成故事大纲 |
| `generate_story_scripts` | 生成故事脚本和节点 |
| `generate_story_assets` | 生成或补齐故事资产 |
| `validate_project` | 校验项目结构、资源和脚本 |
| `export_project` | 导出项目 |

Intent 可以通过以下位置维护：

- `apps/control-server/src/server/reasoning/heuristics.js`：内置检测、目录/文件推断、确定性评分。
- `apps/control-server/src/server/reasoning/promptBuilders.js`：fallback plan 和 planner 约束。
- `config/hermes/skills/gamestudio-workspace/SKILL.md`：给 Hermes 的轻量执行提示。
- `config/hermes/intents/`：适合后续沉淀可配置 intent 规则。

注意：intent 应该少而稳定，不应为每个同义词建一个新 intent。

### 3. Workflow 层

目标：把 intent 转成固定任务流程。

每个 workflow 应包含：

- workflow id。
- 输入参数 schema。
- 步骤 action 列表。
- 是否需要人工审核。
- 产物路径。
- 验收规则。
- 失败时必须返回的证据。

建议未来集中放在：

```text
apps/control-server/src/server/workflows/
```

或先以配置形式放在：

```text
config/hermes/intents/
config/hermes/workflows/
```

当前还没有完整 workflow registry 时，可以先在 `promptBuilders.js` 的 fallback plan 和 `heuristics.js` 的 deterministic evaluator 中固化最小流程。

### 4. Action Schema 层

目标：限制模型只能调用受控能力。

当前相关位置：

- `apps/control-server/src/server/capabilities/actionRegistry.js`
- `apps/control-server/src/server/capabilities/toolRegistry.js`
- `apps/control-server/src/server/controlServerCore.js`

常见 action：

| action | 能力 | 关键限制 |
| --- | --- | --- |
| `list_directory_contents` | 列目录 | 参数必须是目录 |
| `read_file_content` | 读文件 | 参数必须是文件 |
| `search_workspace_text` | 搜索文本 | 限制 workspace 内 |
| `edit_workspace_file` | 编辑文件候选 | 必须审核 |
| `create_workspace_file` | 创建文件候选 | 必须审核 |
| `write_memory_file` | 写 memory | 必须审核或受控 |
| `run_lifecycle_script` | 运行生命周期脚本 | 白名单 + 审核 |
| `generate_default_answer` | 生成最终回答 | 必须基于 artifacts |

Action schema 是任务可靠性的关键，不应该让模型凭自然语言自由发明工具。

### 5. Executor Guard 层

目标：执行前做硬校验。

必须具备：

- 路径必须在 workspace 内。
- 文件 action 不能读目录。
- 目录 action 不能列文件。
- 写入 action 不能越权。
- 删除和脚本执行必须审核。
- 高风险动作失败时给出可解释错误。

示例：

`read_file_content` 在执行前应检查：

```text
exists -> isFile -> readFile
```

不能只检查 exists 后直接 `readFileSync`。

### 6. Artifact 层

目标：每一步执行结果都沉淀成结构化证据。

当前位置：

```text
state/agent-runtime-sessions/
state/reasoning-sessions/
state/agent-runtime-events.jsonl
state/reasoning-review-records.jsonl
```

artifact 应至少包含：

- 请求参数。
- 解析后的真实路径。
- 直接工具结果。
- 计数和摘要。
- 错误详情。
- 最终答案是否持久化。

### 7. Evaluator 层

目标：判断任务是否真的完成。

当前相关位置：

- `apps/control-server/src/server/reasoning/heuristics.js`
- `apps/control-server/src/server/reasoning/qualityGate.js`

评分不应只看回答是否像样，还要看是否包含证据。

例如 `list_projects` 至少要检查：

- 是否扫描了 `storage/projects`。
- 是否列出实际项目目录。
- 是否没有编造项目。
- 如果为空，是否明确说明目录为空。

## 在哪里“打标签”才合理

这里的“标签”应理解为任务路由元数据，而不是无穷关键词补丁。

### 适合放标签的位置

| 位置 | 用途 | 应放什么 |
| --- | --- | --- |
| `config/hermes/skills/gamestudio-workspace/SKILL.md` | 给模型的轻量提示 | 最小路由提示、禁止越界规则 |
| `config/hermes/intents/` | 可配置 intent | intent 名称、同义表达、requiredActions、answerAction |
| `heuristics.js` | 稳定内置规则 | 高置信检测、目录/文件推断、确定性答案 |
| `promptBuilders.js` | fallback plan | 模型不稳定时的标准 plan |
| `actionRegistry.js` | 能力注册 | action 名称、工具、是否写入、是否审核 |
| `toolRegistry.js` | 工具注册 | tool 名称、描述、参数边界 |
| workflow registry | 常用任务预制 | 固定步骤、输入、验收规则 |

### 不适合放标签的位置

- 不要把长期业务规则散落在 prompt 文案里。
- 不要把每个失败题目的原句硬写成特殊 case。
- 不要让模型输出中夹带“我觉得应该读某文件”就直接执行。
- 不要把用户聊天历史当作可靠任务状态。

## 从任务题目到达成任务的流程

### Step 1：收集任务题目

把失败题目和成功题目都记录下来。

建议字段：

```json
{
  "prompt": "找出 storage/projects中当前已有项目。",
  "expectedIntent": "list_projects",
  "expectedArtifacts": ["directoryListings.storage/projects"],
  "expectedAnswerMustContain": ["扫描目录", "项目目录列表"],
  "mustNotActions": ["read_file_content:storage/projects"]
}
```

### Step 2：归一化 intent

不要为“找出”“列出”“看看”“盘点”分别创建四个任务，只归一到 `list_projects`。

### Step 3：绑定 workflow

`list_projects` 的 workflow 应固定为：

```text
list_directory_contents(storage/projects)
generate_default_answer
```

除非用户明确要求读取项目内容，否则不进入 `scripts.json`。

### Step 4：执行器保护

即使模型生成了错误步骤，也要被 normalize 或 executor guard 拦截。

示例：

- `read_file_content(storage/projects)` 应被拒绝为 `read_file_content_not_file`。
- `list_directory_contents(apps/server/src/index.js)` 应被拒绝为 `list_directory_contents_not_directory`。

### Step 5：验收

最终回答必须引用 artifact。

对于 `list_projects`，答案应该包含：

- 扫描目录。
- 直接子项数量。
- 项目目录名。
- 如果需要，说明未递归读取项目内容。

## 示例一：预制 `list_projects`

### 用户题目

```text
找出 storage/projects中当前已有项目。
```

同义表达：

```text
扫描 storage/projects，列出当前已有项目。
看看现在有哪些项目。
盘点当前项目目录。
storage/projects 下面有什么项目？
```

### Intent

```text
list_projects
```

### 推荐标签位置

在 `config/hermes/intents/` 中沉淀可配置规则，示意：

```json
{
  "id": "list_projects",
  "description": "列出 storage/projects 当前已有项目目录",
  "keywords": ["storage/projects", "项目", "已有", "当前", "列出", "找出", "盘点", "有哪些"],
  "requiredActions": ["list_directory_contents"],
  "answerAction": "generate_default_answer",
  "params": {
    "dirPath": "storage/projects"
  },
  "mustNotActions": ["read_file_content"]
}
```

注意：`keywords` 是入口辅助，不是唯一保护。真正保护来自固定 workflow 和 executor guard。

### 固定 workflow

```json
{
  "workflowId": "list_projects",
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

### 验收规则

```text
PASS 条件：
- artifact.directoryListings 包含 storage/projects。
- 最终答案列出每个直接子目录。
- 最终答案不声称读取了 scripts.json，除非确实执行过对应文件读取。

FAIL 条件：
- 未扫描 storage/projects。
- 编造不存在项目。
- 把 storage/projects 当文件读取。
```

### 当前项目中的正确答案示例

```text
已扫描目录：storage/projects
直接子项数量：1
当前已有项目：
1. 296d0b72-5583-47b3-bd6f-c585d159820e

本次只列出项目目录，没有递归读取项目内容。
```

## 示例二：预制 `inspect_project`

### 用户题目

```text
检查项目 296d0b72-5583-47b3-bd6f-c585d159820e 的故事结构。
```

同义表达：

```text
看看这个项目里面有哪些 story/script 文件。
读取这个项目的 scripts.json 摘要。
检查当前项目内容完整吗？
```

### Intent

```text
inspect_project
```

### 输入参数

```json
{
  "projectId": "296d0b72-5583-47b3-bd6f-c585d159820e"
}
```

### 固定 workflow

```json
{
  "workflowId": "inspect_project",
  "steps": [
    {
      "action": "list_directory_contents",
      "params": { "dirPath": "storage/projects/296d0b72-5583-47b3-bd6f-c585d159820e" },
      "skipReview": true
    },
    {
      "action": "read_file_content",
      "params": { "filePath": "storage/projects/296d0b72-5583-47b3-bd6f-c585d159820e/scripts.json" },
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

### Executor Guard

执行前必须检查：

- 项目目录存在且是目录。
- `scripts.json` 存在且是文件。
- 如果不存在，返回缺失证据，不编造内容。

### 验收规则

```text
PASS 条件：
- 列出项目目录。
- 如果 scripts.json 存在，读取并总结节点/脚本数量。
- 如果 scripts.json 不存在，明确说明缺失路径。

FAIL 条件：
- 不检查项目目录就直接回答。
- 读取目录当文件。
- scripts.json 不存在时编造脚本内容。
```

## 示例三：预制 `create_story_project`

### 用户题目

```text
创建一个新的互动故事项目，主题是雨夜咖啡馆里的时间循环。
```

### Intent

```text
create_story_project
```

### 输入参数

```json
{
  "title": "雨夜咖啡馆里的时间循环",
  "theme": "time-loop mystery",
  "targetRoot": "storage/projects"
}
```

### 固定 workflow

```text
1. validate_project_create_input
2. create_project_directory
3. create_project_metadata
4. create_initial_story_files
5. list_directory_contents(newProjectDir)
6. validate_project(newProjectDir)
7. generate_default_answer
```

### 审核要求

创建项目属于写入任务，必须在写入前展示候选计划和目标路径，等待用户确认。

### 验收规则

```text
PASS 条件：
- 新项目目录位于 storage/projects。
- 有 metadata 或等效项目配置文件。
- 有初始 story/scripts/blueprint 中至少一个约定入口。
- 最终答案列出创建的文件和目录。

FAIL 条件：
- 创建到错误目录。
- 未经审核写入。
- 只口头说创建成功但没有文件证据。
```

## 常用任务预制建议

### P0：先固化读类任务

优先级最高，风险低，能提升基础稳定性。

- `list_projects`
- `inspect_project`
- `locate_app_module`
- `inspect_control_backend`
- `inspect_image_entrypoints`

### P1：固化写类任务

需要审核门。

- `create_story_project`
- `configure_story_project`
- `generate_story_outline`
- `generate_story_scripts`
- `write_memory_update`

### P2：固化运行类任务

需要白名单和超时控制。

- `validate_project`
- `export_project`
- `run_project_build`
- `restart_control`
- `restart_server`

## 强化检查清单

新增或修复一个智能体任务时，按这个清单走：

1. 这是不是一个已有 intent？如果是，不新建 intent。
2. 这个任务是否有固定 workflow？如果没有，先写最小 workflow。
3. 每一步是否能映射到已注册 action？如果不能，先补 action schema。
4. action 参数是否有 executor guard？尤其是文件/目录、写入、删除、脚本。
5. 是否需要人工审核？写入和脚本默认需要。
6. 是否会写入 artifact？没有 artifact 就无法验收。
7. 是否有 deterministic evaluator？至少要有 PASS/FAIL 的硬条件。
8. 是否需要写入 `ai/memory/STATUS.md` 或 `TASK_QUEUE.md`？只有状态变化时写。
9. 是否更新 docs 或 skill？只写必要规则，避免重复长文档。
10. 是否用真实失败题目回放测试？不要只测理想表达。

## 失败处理策略

### 规划错误

如果模型生成了不合规 plan：

- 优先用 fallback plan 替代。
- 或在 normalize 阶段删除不允许的步骤。
- 不要直接执行模型的越界步骤。

### 参数错误

如果 action 参数类型错误：

- executor 拒绝执行。
- 返回明确错误，如 `read_file_content_not_file`。
- session 记录错误和 stepId。

### 答案错误

如果工具执行正确但答案错：

- 使用 deterministic answer builder。
- 或触发 quality gate 修正。
- 不要重新执行无关工具。

### 上下文漂移

如果模型沿用上一题目标：

- context draft 必须明确当前题目优先。
- 用户明确路径时，以当前路径为准。
- 近期聊天只能辅助消解省略，不是事实源。

## 最小落地路线

### 第一阶段：修复基础安全

- `read_file_content` 增加 `isFile()` 检查。
- `list_directory_contents` 已有 `isDirectory()` 检查，保持。
- 对 `EISDIR` 这类底层错误做可读错误包装。

### 第二阶段：固化项目列表 workflow

- 新增或加强 `list_projects` intent。
- fallback plan 固定为列 `storage/projects`。
- evaluator 要求答案列出真实目录结果。

### 第三阶段：固化项目检查 workflow

- 区分 `list_projects` 与 `inspect_project`。
- 只有 inspect 类任务才读取项目内 `scripts.json`。
- 缺文件时输出证据不足，不编造。

### 第四阶段：固化创建与生成 workflow

- 创建项目、生成故事、生成脚本、生成资产都走预制 workflow。
- 所有写入前都需要审核。
- 所有产物都要回到 `storage/projects` 验证。

### 第五阶段：固化导出 workflow

- 导出前先 validate。
- 导出后列出产物路径。
- 最终答案给出 PASS/FAIL 和证据摘要。

## 总结

GameStudio 的智能体强化方向不是让模型“更会猜”，而是让系统更会控制：

- 自然语言负责表达意图。
- intent 负责归一化。
- workflow 负责标准流程。
- action schema 负责能力边界。
- executor guard 负责安全。
- artifact 负责证据。
- evaluator 负责验收。
- human review 负责高风险确认。

这样才能支撑通过对话交互控制器 + 智能体，稳定完成项目强化、故事生成、故事资产生成、项目验证和导出。
