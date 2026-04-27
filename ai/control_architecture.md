# CONTROL Architecture - GameStudio Control / Hermes 当前结构说明

本文档描述当前已经落地的 `control` 控制平面结构，供本地 agent、维护者和后续重构任务作为事实参考。

这不是计划文档，也不是未来目标草案。未在本文档中明确写出的结构或行为，不应默认视为已完成能力。

## 1. 系统定位

当前 `control` 系统由两个应用组成：

- `apps/control-server`：权威控制后端，负责运行时控制、Hermes 配置、chat/context/reasoning 控制接口。
- `apps/control-console`：权威操作界面，负责把配置、自检、运行控制、chat、context、reasoning 工作流集中暴露给操作者。

当前系统的核心约束：

- 生命周期控制是保护行为，`start / stop / pause / resume / exit / all-restart` 不能被新功能替代。
- 左脑配置、自检、运行启动三者顺序保持不变。
- `control-console` 与 `control-server` 使用同一套控制语义；若一侧调整 contract，另一侧必须同步更新。

## 2. 目录事实

### 2.1 control-server

当前后端目录结构：

```text
apps/control-server/src/
  index.js
  app/
    createApp.js
  config/
    constants.js
    paths.js
  routes/
    registerRoutes.js
  server/
    agentDefinitions.js
    controlServerCore.js
    routes/
      overviewRoutes.js
      runtimeRoutes.js
      configRoutes.js
      contextRoutes.js
      chatRoutes.js
      chatRequestRoutes.js
      reasoningRoutes.js
```

### 2.2 control-console

当前前端相关结构：

```text
apps/control-console/src/
  App.vue
  lib/
    chatMarkdown.ts
    reasoning.ts
  services/
    controlApi.ts
    chatApi.ts
    reasoningApi.ts
```

## 3. control-server 当前分层

### 3.1 启动层

- `apps/control-server/src/index.js`
  - 只负责创建 app、注册路由、执行启动期 orphan session 清理、启动服务。
- `apps/control-server/src/app/createApp.js`
  - 负责创建 Hono app 和挂载基础中间件。
- `apps/control-server/src/routes/registerRoutes.js`
  - 作为统一路由装配入口，把 app 交给 control server 核心注册逻辑。

这一层不再直接承载业务 API 细节。

### 3.2 配置层

- `apps/control-server/src/config/constants.js`
  - 控制端口、Hermes API 基础地址、chat timeout、reasoning lease / timeout / retry 等常量。
- `apps/control-server/src/config/paths.js`
  - Hermes 根目录、控制配置文件、状态文件、session 目录、runtime 日志、context pool、storage 等路径事实。

这一层的职责是提供路径和常量真相，避免在业务逻辑中重复拼接。

### 3.3 核心层

- `apps/control-server/src/server/agentDefinitions.js`
  - 当前静态 agent 定义，至少包含 `hermes-manager` 与 `openclaw`。
- `apps/control-server/src/server/controlServerCore.js`
  - 当前仍是主要规则与状态实现所在文件。
  - 已经从“单入口文件”退化为“核心实现模块”，不再承担启动装配职责。
  - 对外负责：
    - 暴露 `registerControlServerRoutes(app)`
    - 暴露 `cleanupOrphanedReasoningSessions()`
    - 提供路由注册共享 context
    - 持有 Hermes chat / reasoning 的活动状态和大量共享 helper

### 3.4 路由域层

当前 `control-server` 已按控制域拆出独立注册模块：

- `apps/control-server/src/server/routes/overviewRoutes.js`
  - 健康检查
  - control overview / bootstrap
  - agent 列表、详情、contract、startup-profile、startup-flow、next-action
  - runtime-status
  - agent logs
  - model load / unload
- `apps/control-server/src/server/routes/runtimeRoutes.js`
  - runtime-action
  - local model catalog
  - local model inspect
  - self-check
- `apps/control-server/src/server/routes/configRoutes.js`
  - config 获取与保存
  - workflow diagnostics
  - reasoning capabilities
  - preflight-check
- `apps/control-server/src/server/routes/contextRoutes.js`
  - context candidates
  - context source content 读写
  - context draft
  - submission preview
  - context pool 列表、详情、文件、open、删除
- `apps/control-server/src/server/routes/chatRoutes.js`
  - chat history
  - chat memory file / chat history file 读写
  - chat history file open
- `apps/control-server/src/server/routes/chatRequestRoutes.js`
  - `ping-model` 聊天请求执行
  - active request / timeout / recovery 相关返回
- `apps/control-server/src/server/routes/reasoningRoutes.js`
  - reasoning session 创建、查询、取消、review

这些模块当前只负责路由与 HTTP 交互，不拥有独立状态源；它们通过 `controlServerCore.js` 提供的共享 context 访问规则函数与运行态。

## 4. control-server 当前能力边界

### 4.1 已完成能力

当前控制后端已稳定承载以下能力：

- 健康检查与 control 概览
- Hermes / OpenClaw agent 资源暴露
- Hermes lifecycle 控制
- 左脑配置读取、保存、readiness、自检、workflow diagnostics
- 本地模型目录获取与 inspection
- chat 历史、chat 文件、主动聊天请求
- context source / context pool 工作台能力
- reasoning session 创建、轮询、审批、取消
- 服务器启动时 orphan reasoning session 清理

### 4.2 当前未继续拆开的部分

虽然路由已模块化，但以下内容仍集中在 `controlServerCore.js`：

- Hermes runtime 控制规则
- provider/baseUrl 归一化
- 文件读写 helper
- chat history / context / reasoning 的规则实现
- reasoning session 状态流转和执行辅助函数
- route shared context 的装配

也就是说，当前已经完成的是“控制面结构拆分”和“路由域拆分”，还没有把核心规则继续下沉成更细的 service / repository 文件。

## 5. control-console 当前分层

### 5.1 页面层

- `apps/control-console/src/App.vue`
  - 仍是当前顶层页面壳和主要状态容器。
  - 已不再承担所有 HTTP path 拼接工作。

### 5.2 共享工具层

- `apps/control-console/src/lib/chatMarkdown.ts`
  - 负责 chat markdown 渲染。
- `apps/control-console/src/lib/reasoning.ts`
  - 负责 reasoning 时间、事件、持续时长等共享格式化逻辑。

页面内重复 helper 已回收，不再保持双份实现。

### 5.3 API service 层

- `apps/control-console/src/services/controlApi.ts`
  - 健康检查、agent、日志、runtime、config、models、preflight、自检、runtime/model action。
- `apps/control-console/src/services/chatApi.ts`
  - chat history、chat file、ping-model、context candidates、submission preview。
- `apps/control-console/src/services/reasoningApi.ts`
  - reasoning capabilities、reasoning session 创建与取消。

当前前端已经完成的关键变化是：主要请求从 `App.vue` 的直接 `fetch()` 调用改为通过 service 层统一封装。

## 6. 当前控制契约

### 6.1 运行控制契约

当前保护中的运行时动作仍为：

- `start`
- `stop`
- `pause`
- `resume`
- `exit`
- `all-restart`

这些动作仍由 `control-server` 解释并返回统一的 runtime state / control state 结果，console 只是操作界面，不是状态真相源。

### 6.2 配置启动约束

当前依旧要求：

1. 左脑配置先保存。
2. preflight / readiness 通过。
3. 再进入 Hermes runtime 启动或恢复。

任何后续 agent 若直接绕过此顺序调用 runtime-action，应视为违反当前控制契约。

### 6.3 reasoning 与 chat 语义分离

虽然 chat 与 reasoning 都会调用模型，但当前控制语义明确区分：

- `ping-model` 是普通聊天路径。
- `reasoning-sessions` 是可观测推理执行路径。
- `submission-preview` 只做预览，不触发实际模型调用。
- `context-*` 路由属于工作台资源，不等于 chat 请求本身。

## 7. 本地 agent 使用建议

当任务涉及 `control`、`control-server`、`control-console`、`Hermes manager` 时，建议按以下顺序读取：

1. `README.md`
2. `ai/AGENTS.md`
3. `ai/TOOLS.md`
4. `ai/control_architecture.md`
5. `docs/CONTROL_SYSTEM.md`
6. 需要补 runtime / reasoning 细节时，再读：
   - `docs/HERMES_MANAGER_CONFIG.md`
   - `docs/OBSERVABLE_REASONING_PIPELINE.md`

使用原则：

- 先按本文档找模块归属，再进入具体文件。
- 若需求只涉及控制路由或控制按钮，不要重新全仓扫描。
- 若改动影响 API contract，必须同时检查 console service 层与对应 UI callsite。
- 若改动 runtime 语义，必须优先保护 lifecycle controls，不要让配置面板覆盖掉运行控制语义。

## 8. 后续演进建议

如果未来继续向更细粒度重构推进，建议从 `controlServerCore.js` 继续往下拆，但应按规则层拆，不要退回“把所有东西扔进 utils”这种结构：

- 先拆 runtime 规则与 control config 规则
- 再拆 chat/context 文件管理规则
- 最后拆 reasoning 执行与 review 规则

判断标准不是文件数量，而是：

- 路由模块是否只负责 HTTP
- 核心规则是否不再混杂文件路径与协议细节
- console 是否继续保持 contract 对齐

## 9. 文档状态

本文档状态：`authoritative-current`

适用范围：

- 本地 agent 读取
- control 模块维护
- 后续 control 相关重构前的结构对齐

不适用范围：

- 未来目标承诺
- 尚未落地的 service / repository 细分设计
- editor / server 非 control 模块说明
