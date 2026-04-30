# GameStudio Control System

## 目标

在 `gamestudio` 项目内建立独立的控制器系统，作为后续状态机、阶段机、任务单、错误恢复与 Hermes 接入的唯一控制入口。

当前这一版先完成工程脚手架，目标是让控制系统具备独立启动、独立访问、独立演进的基础条件。

当前已进一步补齐第一项真实业务前置：在管理器系统内建立 Hermes 代理角色模型，使 Hermes 不再只是外部概念，而是控制系统中的一级资源对象。

## 当前目录结构

```text
apps/
  control-console/   # Vue + Vite 管理控制台前端
  control-server/    # Node + Hono 控制服务后端
```

## 当前启动命令

在仓库根目录执行：

```bash
npm run dev:control-server
npm run dev:control-console
```

默认端口：

- Control Server: `2099`
- Control Console: `8870`

## 当前能力范围

已具备：

- 控制系统独立工作区应用
- 健康检查接口 `/api/health`
- 控制系统占位接口 `/api/control/overview`
- Hermes 代理注册接口 `/api/control/agents`
- Hermes 单代理详情接口 `/api/control/agents/hermes-manager`
- Hermes 动作契约接口 `/api/control/agents/hermes-manager/contract`
- Hermes 启动配置接口 `/api/control/agents/hermes-manager/startup-profile`
- Hermes 首轮启动流接口 `/api/control/agents/hermes-manager/startup-flow`
- Hermes 下一条动作接口 `/api/control/agents/hermes-manager/next-action`
- Vue 控制台首页，展示当前控制系统定位与健康状态
- 全局模型任务队列：control-server 内所有 Hermes/OMLX chat completion 请求必须经过统一队列，默认同一时间只允许 1 个模型任务运行，并按 session 限制模型调用预算，避免本地 OMLX 被 plan、answer、quality gate、self-review、context draft 等并发请求压垮。
- 可观测长任务心跳：reasoning task 在等待模型或 provider 时必须持续写入 heartbeat 事件，Control Console 不能长时间静默，让用户误判为卡死。

## Hermes 代理对象

当前管理器系统先内建一个系统级代理对象：`hermes-manager`。

该对象用于回答 5 个问题：

1. 管理器里的 Hermes 是谁。
2. 当前绑定到哪个运行时。
3. 当前具备哪些能力。
4. 当前处于什么可用状态。
5. 当前允许通过什么动作契约与管理器交互。

当前最小模型包含：

- `definition`：角色定义
- `binding`：运行时绑定
- `status`：当前状态
- `contract`：动作请求/结果约束
- `startupProfile`：启动后行为配置

## Hermes Startup Profile

管理器现在开始承担 Hermes 启动后行为的控制职责。

当前 `startupProfile` 的目标是：

1. 让 Hermes 启动后先向管理器报到。
2. 让 Hermes 读取控制系统概览与保存后的项目记忆配置。
3. 让 Hermes 通过管理器来决定第一条动作，而不是依赖旧的仓库内自举文件。

当前配置明确约束：

- 不依赖已废弃的仓库内自举文件
- 不从会话对话中猜项目阶段
- 不直接写项目 memory 状态文件
- 必须以管理器为启动控制平面

这一步先在 manager 侧建模，后续 Hermes 再对接该 profile，实现 manager-driven startup。

## Hermes First-Step Operation Flow

管理器现在补上了真正可执行的第一步操作流程，而不是只展示概念说明。

当前流程分成 4 个阶段：

1. 注册运行时
2. 读取控制面概览
3. 执行运行健康检查
4. 请求第一条管理动作

并且单独暴露：

- `startup-flow`：首轮接管流程定义
- `next-action`：当前应由 Hermes 执行的下一条动作

这一步的目标是让控制台和后续 Hermes 对接，都围绕“第一条真实动作”而不是散乱信息进行。

这一步的目的不是先接全部业务，而是先让管理器系统“认识 Hermes”，为后续状态机推进、错误恢复和闭环测试提供固定挂载点。

暂未实现：

- 状态机模型定义
- 阶段机规则编辑
- 任务单与事件日志持久化
- Hermes 调度接口约定
- Hermes 真正消费 manager startup profile
- Hermes 真正消费 manager next-action / startup-flow
- 错误分类与恢复动作

## 设计原则

1. 控制系统放在 `gamestudio` 内部，但逻辑上独立。
2. 后续 Hermes、GameStudio Server、出图流程都通过控制系统 API/SDK 读写事实状态。
3. 控制系统将成为唯一状态真相源，而不是另一个展示面板。
4. Hermes 首先作为控制系统内的一级代理资源建模，再基于该代理对象扩展具体业务接口。
5. Hermes 的项目启动行为应统一由 manager 提供的 startup profile 与保存配置驱动。
6. 模型请求不是状态机。Hermes/OMLX 只能生成候选 plan、候选内容、解释和评分建议；任务推进、权限、重试、artifact 与验收必须由 Control Server 负责。
7. 本地模型资源必须受控调度。任何新增模型调用都必须接入 `apps/control-server/src/server/model/modelTaskQueue.js`，不得在业务模块中直接 `fetch` Hermes gateway。

## 当前结构性改造约束

项目仍处于构建测试阶段，不保留旧的不可靠路径作为兼容分支。后续改造按最新方案直接推进：

1. `controlServerCore.js` 不再作为新增能力的默认落点；新增能力优先拆到 `server/model/`、`server/reasoning/`、`server/workflows/`、`server/capabilities/` 或 `server/routes/`。
2. Control Server 是工程可靠性主体；Hermes 是候选生成与解释层；OMLX 是推理资源。
3. 每个项目自动化目标必须落到 workflow、action schema、executor guard、artifact、deterministic evaluator 五层之一。
4. 自我评分和自我强化只能产生待审核 proposal，不能直接修改运行规则，也不能作为事实正确性的唯一依据。
5. 所有长任务必须有预算：最大模型调用次数、最大运行时间、最大上下文大小、最大重试次数和明确取消路径。
6. 记忆和上下文必须有生命周期。chat、context pool、reasoning session、daily log、memory markdown 不能无限保存并默认注入 planner；具体规则见 [MEMORY_LIFECYCLE.md](MEMORY_LIFECYCLE.md)。

## 问题路由约定

Control Server 在收到用户提问后先做执行路径判定，不把自然语言直接等同为聊天回答。

- `answer_only`：低风险普通解释。
- `plan_then_answer`：需要 reasoning plan 和 artifact 的只读任务。
- `inspect_then_answer`：当前能力状态、覆盖度、是否完成、缺口类问题。当前由 `apps/control-server/src/server/workflows/projectStatusWorkflows.js` 提供 `project_capability_status` 通用检查 workflow。
- `workflow_execute`：故事项目创建、配置、生成、资产、验证、导出。
- `write_or_invoke_review`：写入、删除、脚本和生命周期动作。

`project_capability_status` 不是 L1-11 的专用规则，而是一类问题的固定检查公式：关键文档 -> intent 配置目录 -> docs 搜索 -> control-server 实现搜索 -> artifact-based answer。后续新增能力状态题应优先扩展这个 workflow 的证据选择，而不是继续添加单题 if 分支。

### 第一阶段决策规则

Reasoning plan 的第一阶段是 request decision，而不是直接加载全部上下文生成计划。该阶段只允许使用“决策规则 + 当前题目”，输出题目类型、置信度和原因，不回答题目内容。

当前类型集合：

- `project_listing`：盘点 `storage/projects` 现有项目。
- `directory_listing`：列出工作区目录内容。
- `file_inspection`：解释具体文件的职责、作用或内容。
- `directory_inspection`：解释具体目录的职责、作用或内容。
- `surface_location`：询问 editor/control/server 等入口在哪里。
- `capability_status_inspection`：询问 workflow、evaluator、状态机、Hermes、GameStudio Server、关键词可靠性或能力缺口是否完成/覆盖/建立。
- `story_workflow_execute`：创建、配置、生成、校验或导出互动故事项目。
- `write_or_invoke_review`：写入、删除、重命名、运行脚本、启动、停止、重启等需要审核的动作。
- `contextual_plan_answer`：需要结合最近上下文继续规划或分析。
- `answer_only`：不需要项目事实证据的普通解释。

工程策略是确定性分类优先；只有规则置信度不足时，才调用 Hermes 做轻量 request decision，并且该调用只携带规则和题目，不携带项目上下文。命中专用 workflow 后，再进入对应上下文收集与执行逻辑。

## 记忆生命周期约定

Control Server 的记忆分为运行态记录、浅记忆、深记忆、归档记忆和删除项。

- 运行态记录用于审计，不默认进入模型上下文。
- 浅记忆默认睡眠，只在题目、caseId、sessionId、文件路径或人工选择命中时唤醒。
- 深记忆默认醒着，但必须受 token 预算和题型路由限制。
- 归档记忆只保留索引，不自动注入全文。
- 删除项必须有明确原因，模型只能提出删除 proposal，不能直接删除深记忆。

后续新增 memory/context 功能应优先落到 `server/memory/`，不要继续堆进 `controlServerCore.js`。

## 后续建设顺序

1. 定义项目主状态模型。
2. 定义阶段机与流转规则。
3. 将 Hermes 动作与管理器命令绑定。
4. 让 Hermes 消费 manager startup profile 与保存后的配置文件。
5. 增加任务单、事件日志与恢复动作。
6. 与 Hermes 做首个最小闭环测试。