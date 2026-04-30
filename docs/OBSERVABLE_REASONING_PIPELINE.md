# 可观测推理链（Observable Reasoning Pipeline）MVP 设计

## 目标

在 `apps/control-console` 的 Hermes 对话区增加一条可观测执行链，让用户不仅能看到最终回答，还能看到：

- 计划如何生成
- 当前在执行哪一步
- 是否调用了工具
- 工具返回了什么摘要结果
- 最终回答是基于哪些中间结果生成的

第一版不追求完整多智能体协作，不暴露原始私有思维文本，只展示结构化的计划、步骤、工具和结果。

## 非目标

- 不直接暴露模型原始 chain-of-thought
- 不在第一版实现 WebSocket
- 不在第一版实现复杂 DAG 并发调度
- 不替换现有聊天记录文件语义；`ai/chat/*.json` 继续只保存对话回合

## 三层职责

### 1. Planner

Planner 负责把用户问题转成结构化计划，而不是直接生成最终答案。

第一版实现策略：

- 使用 control-server 内部规划器函数生成 plan
- 先覆盖少量高价值问题类型
- 对无法识别的问题，退化为默认三步链：读取上下文 -> 生成回答 -> 返回结果

输出对象：

```json
{
  "planId": "plan_xxx",
  "goal": "列出 GameStudio 已创建故事并总结",
  "strategy": "sequential",
  "steps": [
    {
      "stepId": "step_locate_project",
      "title": "定位项目目录",
      "action": "locate_project",
      "tool": "project.locate",
      "dependsOn": []
    },
    {
      "stepId": "step_list_stories",
      "title": "读取故事索引",
      "action": "list_created_stories",
      "tool": "project.listStories",
      "dependsOn": ["step_locate_project"]
    },
    {
      "stepId": "step_summarize",
      "title": "生成最终回答",
      "action": "summarize_story_index",
      "tool": "model.answer",
      "dependsOn": ["step_list_stories"]
    }
  ]
}
```

### 2. Executor

Executor 由 `control-server` 驱动，Hermes 只负责语言回答生成；工具调用和状态推进由 control-server 负责。

第一版执行原则：

- 只支持顺序执行
- 每一步必须显式进入 `running / completed / failed`
- 每一步必须产出可记录的摘要
- 工具调用结果先结构化保存，再决定是否传给模型
- 模型调用也必须视为受控任务：plan、answer、quality gate、self-review、context draft 和普通 chat 都必须经过全局模型任务队列，不允许多个入口同时压到本地 OMLX。
- 长模型任务必须写入 heartbeat 事件；在没有流式 token 的情况下，Control Console 仍要能看到任务仍在执行、已运行多久、是否仍在预算内。

### 3. Observer

Observer 只负责展示和重放，不参与推理。

第一版展示来源：

- control-server 持久化的 reasoning session 文件
- control-console 轮询 session 快照

第二版再升级为 SSE 流式推送。

## 事件协议

统一事件对象：

```ts
type ReasoningEvent = {
  eventId: string
  sessionId: string
  type:
    | 'plan_created'
    | 'step_started'
    | 'tool_called'
    | 'tool_result'
    | 'step_completed'
    | 'step_failed'
    | 'final_answer_ready'
    | 'session_completed'
    | 'session_failed'
  timestamp: string
  stepId?: string
  title: string
  summary: string
  data?: Record<string, unknown>
}
```

事件展示规则：

- `plan_created`：显示计划总览与步骤列表
- `step_started`：显示当前执行步骤
- `tool_called`：显示调用的工具名和目标
- `tool_result`：显示工具返回摘要
- `step_completed`：显示步骤完成
- `final_answer_ready`：显示最终回答已生成

## Session 模型

每次可观测提问创建一个 reasoning session。

```ts
type ReasoningSession = {
  sessionId: string
  agentId: string
  userPrompt: string
  status: 'planning' | 'running' | 'completed' | 'failed'
  createdAt: string
  updatedAt: string
  plan: ReasoningPlan | null
  currentStepId: string | null
  events: ReasoningEvent[]
  artifacts: {
    projectRoot?: string
    storyIndex?: Array<{
      projectId: string
      filePath: string
      nodeCount: number
      nodeNames: string[]
    }>
    finalAnswer?: string
  }
  error?: string | null
}
```

## 存储

聊天记录与推理记录分离：

- `ai/chat/YYYY-MM-DD.json`：继续保存 user / hermes / error 对话回合
- `state/reasoning-sessions/<sessionId>.json`：保存 plan、events、artifacts、状态

理由：

- 聊天记录面向用户回看
- 推理 session 面向执行可观测与调试
- 两者可通过 `sessionId` 关联，但不混写

## MVP 接口

### 创建 session

`POST /api/control/agents/:agentId/reasoning-sessions`

请求：

```json
{
  "prompt": "gamestudio 的已创建故事是什么？"
}
```

返回：

```json
{
  "ok": true,
  "session": { "sessionId": "...", "status": "planning" }
}
```

### 查询 session

`GET /api/control/agents/:agentId/reasoning-sessions/:sessionId`

返回完整快照：plan、events、status、artifacts、finalAnswer。

## MVP 工具集

第一版仅实现以下工具：

1. `project.locate`
   - 返回 GameStudio 根目录

2. `project.listStories`
   - 扫描 `projects/*/scripts.json`
   - 提取 projectId、文件路径、节点数量、节点名

3. `model.answer`
   - 基于工具结果和用户问题生成最终回答

## UI 设计

在 control-console 聊天区新增一个 Timeline 面板，不混入聊天气泡。

展示顺序：

1. `PLAN`
2. `STEP 1`
3. `TOOL`
4. `RESULT`
5. `STEP 2`
6. `TOOL`
7. `RESULT`
8. `FINAL ANSWER`

聊天气泡只保留：

- 用户问题
- Hermes 最终回答

Timeline 面板只展示结构化过程。

## 第一版实现范围

- 新增 reasoning session 路由
- 新增 session 文件持久化
- 新增 `project.listStories` 工具
- control-console 新增 timeline 面板
- 前端用轮询刷新 session 状态

## 第二版演进

- 把 session 轮询升级为 SSE
- 把 Planner 改为模型生成的 JSON plan
- 增加更多工具类型
- 支持 DAG 和可重试步骤

## 可靠性修正方向

当前系统不再把“模型自我审查”作为可靠性主体。正确闭环是：

1. Planner 生成候选 plan。
2. Control Server 校验 plan 是否只包含已注册 action 和合法参数。
3. Executor 执行工具，产出 artifacts。
4. Deterministic evaluator 先根据 artifacts 判断事实是否成立。
5. 模型质量评分只作为文案质量、遗漏提示和人工复核建议，不替代 artifact 验收。

对于 GameStudio 项目自动化，workflow registry 是主线。自然语言只负责选择 workflow 和补齐参数；workflow 定义固定 action 链、产物路径、风险审核点和验收规则。

## 提问入口公式

Control Console 中的每次提问都不再默认等价于“让模型直接回答”。Control Server 需要先把问题归入一种执行意图：

1. `answer_only`：只适合普通解释，不需要项目事实证据。
2. `plan_then_answer`：需要先规划、收集上下文或工具证据，再回答。
3. `inspect_then_answer`：用于“当前是否已经具备/覆盖/建立/完成/缺口是什么”这类能力状态问题，必须先检查文档、配置和代码证据。
4. `workflow_execute`：用于创建项目、生成故事、资产、校验和导出等项目自动化任务，必须进入注册 workflow。
5. `write_or_invoke_review`：涉及写入、删除、脚本执行或生命周期动作时，必须等待人工审核。

当前已落地的通用检查型 workflow 是 `project_capability_status`：它覆盖 workflow registry、deterministic evaluator 覆盖度、Control Server 自动化状态机、Hermes 是否承担候选生成、GameStudio Server 能力、关键词打标签可靠性、短中期缺口等同类问题。该 workflow 使用固定公式：读取关键设计文档 -> 列 intent 配置目录 -> 搜索 docs 证据 -> 搜索 control-server 实现证据 -> 基于 artifacts 生成回答。这样避免为 L1-11、L1-12、L1-15 等题目逐个硬编码。

在实现上，这个入口公式拆成两段：

1. `request_decision`：只带决策规则和当前题目，判断题目属于 `project_listing`、`directory_listing`、`file_inspection`、`directory_inspection`、`surface_location`、`capability_status_inspection`、`story_workflow_execute`、`write_or_invoke_review`、`contextual_plan_answer` 或 `answer_only`。这一段不能回答题目，也不能生成工具步骤。
2. `reasoning_plan`：只有在题目类型确定后才加载项目记忆、最近上下文、已选技能和 artifacts，生成可执行 plan 或进入固定 workflow。

为了保护本地模型资源，`request_decision` 使用确定性分类优先；当规则置信度不足时，才通过全局模型队列调用 Hermes 做轻量分类。模型分类仍只是候选决策，不能绕过 Control Server 的 workflow、review gate 和 evaluator。

## 成功标准

当用户提问：`gamestudio 的已创建故事是什么？`

control-console 能同时看到：

1. Plan 已创建
2. 正在读取故事索引
3. 工具返回几个项目、每个项目多少节点
4. Hermes 基于该结果生成最终回答
5. 最终回答仍落入聊天记录文件