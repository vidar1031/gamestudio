# 右脑（Kimi）监督左脑任务执行 — 实施计划

> 版本: 2026-06-06
> 目标: 系统启动后，由右脑（Kimi）主动引导介入，建立左脑任务执行的监督、评估、修正闭环
> 前提: 左右脑双模型已就绪，Control Console 可正常访问

---

## 1. 概述

### 1.1 问题背景

当前 Control 系统的左右脑分工已明确（见 `ai/BRAIN_DIVISION.md`），但存在以下盲区：

- **左脑执行质量无人评估**：左脑（OMLX）完成 story workflow、自检等任务后，没有独立的第三方评估其输出质量
- **失败模式无法自动识别**：左脑任务失败时，系统只能依赖人工查看日志，无法自动分析根因
- **优化建议无法自动生成**：系统运行一段时间后，哪些环节效率低、哪些配置不合理，需要人工总结

### 1.2 解决思路

引入**右脑监督机制**：

```
┌─────────────────────────────────────────────────────────────────┐
│                      右脑（Kimi）监督引擎                         │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐        │
│  │ 任务派发  │→│ 状态监控  │→│ 质量评估  │→│ 修正指令  │        │
│  └──────────┘  └──────────┘  └──────────┘  └──────────┘        │
│       ↑                                            ↓            │
│       └──────────── 左脑执行反馈 ───────────────────┘            │
└─────────────────────────────────────────────────────────────────┘
```

**核心原则**：
- 右脑不替代左脑执行任务，只负责**评估、诊断、指导**
- 左脑仍然是所有任务的实际执行者
- 右脑的评估结果写入系统记忆，供后续任务参考

---

## 2. 系统启动后主动引导介入流程

### 2.1 触发时机

右脑监督在以下时机自动触发：

| 时机 | 触发条件 | 监督类型 |
|------|----------|----------|
| T1 | Control 系统完成一键启动后 30 秒内 | 启动自检评估 |
| T2 | 左脑完成任意 reasoning session 后 | 单次任务评估 |
| T3 | 每 30 分钟（如果系统持续运行） | 周期性健康检查 |
| T4 | 用户主动输入 `"系统评估"`、`"检查左脑状态"` | 人工触发评估 |

### 2.2 主动引导介入的 5 步流程

```
Step 1: 右脑唤醒
  └─▶ 触发条件满足后，Control Server 自动创建 "supervision" 类型 reasoning session
  └─▶ 该 session 的 route 强制走右脑（action=meta_analysis）
  └─▶ 系统提示词："你是 Control 系统的监督智能体，当前任务是对左脑执行质量进行评估..."

Step 2: 数据聚合
  └─▶ 右脑读取左脑最近 N 次 reasoning sessions 的执行结果
  └─▶ 读取 agent-runtime-events.jsonl 中的运行事件
  └─▶ 读取 ai/memory/ 下的状态文件（STATUS.md、TASK_QUEUE.md 等）
  └─▶ 读取 docs/PRODUCTION_DEFECTS.md 中的已知缺陷列表

Step 3: 质量评估
  └─▶ 右脑分析数据，按"任务完成度评分卡"逐项打分
  └─▶ 识别失败模式、瓶颈、配置问题
  └─▶ 生成分项评分和总体评估结论

Step 4: 修正指令生成
  └─▶ 对于评分低于阈值的项目，生成具体修正建议
  └─▶ 修正建议格式化为 actionable items（可执行项）
  └─▶ 将修正建议写入 ai/memory/TASK_QUEUE.md

Step 5: 结果持久化与通知
  └─▶ 评估报告写入 state/reasoning-sessions/supervision-{timestamp}.json
  └─▶ 在 Control Console 顶部状态条显示评估摘要
  └─▶ 如果发现问题，推送通知到控制台日志区
```

### 2.3 Control Console 状态条显示

启动后右脑介入时，状态条按阶段显示：

```
🟡 右脑监督中：正在评估左脑最近 10 次任务执行情况...
🟢 左脑评估完成：5/6 项通过，1 项需修正（点击展开详情）
🔴 左脑评估发现问题：story_blueprint_review 步骤异常，已生成修正建议
```

---

## 3. 左脑任务清单（详细描述）

左脑需要执行的任务分为 **6 大类别**，每类有明确的完成标准和验收条件。

### 3.1 类别一：系统自检（System Self-Check）

**任务 ID**: `gamestudio_self_check`

**任务描述**：
左脑需要验证整个 GameStudio 生态系统的健康状态，包括：
1. GameStudio Server (`:1999`) 是否可访问
2. GameStudio Editor (`:8868`) 是否可访问
3. ComfyUI (`:8188`) 是否可访问且 GPU 正常
4. OMLX (`:18888`) 是否健康
5. 项目存储目录 `storage/projects/` 是否可读写
6. AI 记忆目录 `ai/memory/` 文件结构是否正确

**完成标准（验收条件）**：

| 检查项 | 通过标准 | 数据来源 |
|--------|----------|----------|
| serverHealth | `curl http://127.0.0.1:1999/api/health` 返回 `ok=true` | HTTP 响应 |
| editorHealth | `curl http://localhost:8868` 返回 HTTP 200 | HTTP 响应 |
| comfyUiHealth | `curl http://127.0.0.1:8188/system_stats` 返回 `comfyui_version` | HTTP 响应 |
| omlxHealth | `curl http://127.0.0.1:18888/health` 返回 `status=healthy` | HTTP 响应 |
| storageRw | 能创建/删除 `storage/projects/.test_rw` 临时文件 | 文件系统 |
| memoryStructure | `ai/memory/` 下 STATUS.md、TASK_QUEUE.md、DECISIONS.md、LONG_TASKS.md 均存在 | 文件系统 |

**评分权重**：20%（系统基础可用性，任何一项失败即总体失败）

---

### 3.2 类别二：故事生产流水线（Story Production Pipeline）

**任务 ID**: `story_production`

**任务描述**：
左脑负责驱动完整的互动故事生产流程，包括：
1. **脚本生成**：根据用户提示词生成 ScriptDocV1（角色、场景、对话结构）
2. **蓝图编译**：将 ScriptDocV1 编译为 BlueprintDocV1（节点图结构）
3. **蓝图校验**：验证蓝图节点的连通性、必填字段、资产引用
4. **资产计划**：生成背景图、角色立绘、音效等资产需求清单
5. **资产生成**：调用 ComfyUI 生成背景图，确认输出到 `storage/projects/{projectId}/assets/`
6. **项目导出**：导出可运行的 H5 互动故事包

**完成标准（验收条件）**：

| 阶段 | 通过标准 | 验证方法 |
|------|----------|----------|
| 脚本生成 | `scriptDoc.characters.length >= 2`，`scriptDoc.scenes.length >= 3` | 解析 JSON |
| 蓝图编译 | `blueprintDoc.nodes.length >= 5`，`blueprintDoc.entryNode` 存在 | 解析 JSON |
| 蓝图校验 | `validation.errors.length === 0`，`validation.warnings.length <= 3` | 校验结果 |
| 资产计划 | `assetPlan.backgrounds.length >= 1`，`assetPlan.characters.length >= 1` | 解析 JSON |
| 资产生成 | `storage/projects/{id}/assets/` 下存在至少 1 张 PNG/JPG | 文件系统 |
| 项目导出 | 导出目录存在 `index.html` 和 `story.json` | 文件系统 |

**评分权重**：30%（核心业务功能，决定系统价值）

---

### 3.3 类别三：推理任务执行（Reasoning Task Execution）

**任务 ID**: `reasoning_execution`

**任务描述**：
左脑接收用户自然语言指令，通过 reasoning session 分解为 action chain 并执行：
1. **计划生成**：将用户 prompt 分解为有序的 action 列表
2. **Action 执行**：逐个执行 action（文件读写、API 调用、命令执行等）
3. **Review 审核**：执行结果经过 review gate 审核
4. **最终回答**：生成结构化的最终回答

**完成标准（验收条件）**：

| 检查项 | 通过标准 | 验证方法 |
|--------|----------|----------|
| 计划完整性 | plan.steps.length >= 1，每个 step 有明确的 action 和 params | 解析 plan JSON |
| 执行成功率 | executedSteps / totalSteps >= 0.8（80% 以上步骤成功执行） | session 状态 |
| Review 通过率 | reviewedSteps / executedSteps >= 0.9（90% 以上通过审核） | review 记录 |
| 最终回答质量 | answer.length >= 100，包含 actionable 内容 | 内容分析 |
| 执行时长 | 总耗时 <= 5 分钟（简单任务）或 <= 15 分钟（复杂任务） | session 时间戳 |

**评分权重**：25%（智能体核心能力）

---

### 3.4 类别四：记忆管理（Memory Management）

**任务 ID**: `memory_management`

**任务描述**：
左脑负责维护系统长期记忆，包括：
1. **STATUS.md 更新**：当前目标、阻塞项、下一步行动的实时更新
2. **TASK_QUEUE.md 维护**：短任务队列的增删改
3. **DECISIONS.md 记录**：生效中的规则和取舍
4. **LONG_TASKS.md 追踪**：长任务方向的进展记录
5. **每日日志**：生成当天的运行摘要日志

**完成标准（验收条件）**：

| 检查项 | 通过标准 | 验证方法 |
|--------|----------|----------|
| STATUS 时效性 | 最后修改时间 <= 24 小时 | 文件 mtime |
| TASK_QUEUE 非空 | `tasks.length >= 1` 或明确标记为"队列已清空" | 文件内容 |
| DECISIONS 完整性 | 最近 7 天内有新决策记录 | 文件内容 |
| LONG_TASKS 进展 | 长任务列表有进展标记（非全部"pending"） | 文件内容 |
| 日志连续性 | `ai/chat/` 下当天有日志文件 | 文件系统 |

**评分权重**：10%（系统自我管理能力）

---

### 3.5 类别五：配置与路由正确性（Config & Routing）

**任务 ID**: `config_routing`

**任务描述**：
左脑需要确保配置和路由规则的正确性：
1. `config/hermes/manager.left-brain.json` 结构完整
2. `modelRouting` 中 `defaultRoute` 指向左脑
3. `actionRoutes.meta_analysis` 指向右脑
4. 环境变量 `.env.local` 中必要配置齐全

**完成标准（验收条件）**：

| 检查项 | 通过标准 | 验证方法 |
|--------|----------|----------|
| 配置结构 | `config.provider`、`config.baseUrl`、`config.model` 均存在 | JSON 解析 |
| 左脑路由 | `defaultRoute.provider === 'omlx'` 或 `defaultRoute.transport === 'hermes'` | JSON 解析 |
| 右脑路由 | `actionRoutes.meta_analysis.provider === 'moonshot'` | JSON 解析 |
| 环境变量 | `MOONSHOT_API_KEY` 或 `STUDIO_AI_API_KEY` 存在且非空 | `process.env` |

**评分权重**：10%（架构正确性）

---

### 3.6 类别六：日志与可观测性（Observability）

**任务 ID**: `observability`

**任务描述**：
系统运行过程中产生的日志和事件需要完整可追踪：
1. `state/agent-runtime-events.jsonl` 正常写入
2. `state/reasoning-sessions/` 下 session 文件完整
3. `.run/` 下各服务的 PID 和日志文件存在
4. 错误事件有明确的 error code 和上下文

**完成标准（验收条件）**：

| 检查项 | 通过标准 | 验证方法 |
|--------|----------|----------|
| 事件流连续性 | `agent-runtime-events.jsonl` 最后写入时间 <= 1 小时 | 文件 mtime |
| Session 完整性 | 最近 5 个 session 均包含 `plan`、`execution`、`answer` 三段 | JSON 解析 |
| 服务日志 | `.run/server.log`、`.run/control-server.log` 最后更新时间 <= 1 小时 | 文件 mtime |
| 错误可追溯 | 任意 error event 包含 `errorCode`、`timestamp`、`sessionId` | JSONL 解析 |

**评分权重**：5%（可维护性）

---

## 4. 评估标准与完成度判定

### 4.1 评分卡（Scorecard）

右脑对左脑每次评估使用统一的评分卡：

```json
{
  "assessmentId": "supervision-2026-06-06T10:00:00Z",
  "assessedAt": "2026-06-06T10:00:00Z",
  "leftBrainVersion": "0.1.0",
  "overallScore": 78,
  "overallStatus": "needs_improvement",
  "categories": [
    {
      "id": "system_self_check",
      "name": "系统自检",
      "weight": 20,
      "score": 100,
      "status": "passed",
      "details": "所有 6 项检查通过"
    },
    {
      "id": "story_production",
      "name": "故事生产流水线",
      "weight": 30,
      "score": 60,
      "status": "needs_improvement",
      "details": "蓝图编译通过，但资产生成阶段 ComfyUI 返回 503"
    },
    {
      "id": "reasoning_execution",
      "name": "推理任务执行",
      "weight": 25,
      "score": 85,
      "status": "passed",
      "details": "执行成功率 85%，review 通过率 92%"
    },
    {
      "id": "memory_management",
      "name": "记忆管理",
      "weight": 10,
      "score": 90,
      "status": "passed",
      "details": "STATUS.md 3 小时前更新，TASK_QUEUE 有 2 项待办"
    },
    {
      "id": "config_routing",
      "name": "配置与路由",
      "weight": 10,
      "score": 100,
      "status": "passed",
      "details": "左右脑路由配置正确"
    },
    {
      "id": "observability",
      "name": "日志与可观测性",
      "weight": 5,
      "score": 70,
      "status": "warning",
      "details": "control-server.log 2 小时未更新，可能日志轮转异常"
    }
  ]
}
```

### 4.2 状态判定规则

| 总体得分 | 状态 | 含义 | 后续动作 |
|----------|------|------|----------|
| 90-100 | `excellent` | 左脑运行优秀 | 记录最佳实践，更新 DECISIONS.md |
| 75-89 | `passed` | 左脑运行正常，有小问题 | 生成优化建议，写入 TASK_QUEUE（优先级低） |
| 60-74 | `needs_improvement` | 有明显问题需修正 | 生成修正指令，写入 TASK_QUEUE（优先级中），通知用户 |
| 0-59 | `critical` | 严重问题，系统不可用 | 立即生成修正指令，标记为 P0，发送告警通知 |

### 4.3 单项失败阈值

即使总体得分高，以下单项如果失败，整体状态直接降级：

- **系统自检**得分 < 50：左脑基础服务不可用，状态强制为 `critical`
- **配置与路由**得分 < 50：左右脑分工混乱，状态强制为 `critical`
- **故事生产流水线**得分 < 40：核心业务不可用，状态强制为 `needs_improvement`

---

## 5. 失败检测与修正机制

### 5.1 失败分类与根因分析

右脑检测到左脑任务失败后，按以下分类进行根因分析：

| 失败类型 | 典型症状 | 根因分析方向 | 修正策略 |
|----------|----------|--------------|----------|
| **服务不可达** | HTTP timeout / Connection refused | 进程是否存活？端口是否冲突？ | 重启服务、检查端口占用 |
| **配置错误** | 返回 400/500，错误提示含配置项 | 配置文件语法？环境变量缺失？ | 修正配置、重新加载 |
| **资源不足** | OOM、GPU 内存不足、磁盘满 | 模型是否过大？并发是否过高？ | 切换轻量模型、清理缓存 |
| **逻辑错误** | 执行结果不符合预期 | 代码 bug？边界条件未处理？ | 生成补丁建议，人工确认后应用 |
| **外部依赖失败** | ComfyUI 返回 503、Kimi API 429 | 下游服务是否过载？ | 重试（指数退避）、切换备用方案 |
| **数据损坏** | JSON parse error、文件格式异常 | 写入过程中断？并发写冲突？ | 从备份恢复、重建索引 |

### 5.2 修正指令生成格式

右脑生成的修正指令必须格式化为可执行的结构：

```json
{
  "correctionId": "corr-2026-06-06T10:05:00Z",
  "triggeredBy": "supervision-2026-06-06T10:00:00Z",
  "priority": "P1",
  "category": "story_production",
  "issue": "资产生成阶段 ComfyUI 返回 503",
  "rootCause": "ComfyUI 未在 Terminal 窗口中启动，nohup 后台启动导致 GPU 初始化失败",
  "actions": [
    {
      "step": 1,
      "type": "command",
      "description": "停止当前 ComfyUI 进程",
      "command": "pkill -f 'python.*ComfyUI'",
      "reviewRequired": false
    },
    {
      "step": 2,
      "type": "command",
      "description": "在 Terminal 窗口中启动 ComfyUI",
      "command": "open -a Terminal /Volumes/ovokit2t/ComfyUI && sleep 2 && osascript -e 'tell application \"Terminal\" to do script \"cd /Volumes/ovokit2t/ComfyUI && sh ./start.sh\"'",
      "reviewRequired": false
    },
    {
      "step": 3,
      "type": "verify",
      "description": "验证 ComfyUI 健康状态",
      "command": "curl -s http://127.0.0.1:8188/system_stats | jq '.comfyui_version'",
      "expectedOutput": "非空字符串",
      "reviewRequired": false
    },
    {
      "step": 4,
      "type": "retry_task",
      "description": "重试之前失败的资产生成任务",
      "targetTask": "asset_generation_for_project_xxx",
      "reviewRequired": true
    }
  ],
  "estimatedFixTime": "3 分钟",
  "rollbackPlan": "若 ComfyUI 仍无法启动，切换为 SD-WebUI 作为备用图片生成器"
}
```

### 5.3 自动修正 vs 人工确认

| 修正动作类型 | 自动执行？ | 人工确认？ | 理由 |
|--------------|-----------|-----------|------|
| 读取日志/检查状态 | ✅ 自动 | ❌ 不需要 | 只读操作，无副作用 |
| 重启服务（同配置） | ✅ 自动 | ⚠️ 建议确认 | 风险低，但可能中断当前任务 |
| 修改配置文件 | ❌ 不自动 | ✅ 必须确认 | 写入操作，可能导致配置漂移 |
| 删除文件/清理缓存 | ❌ 不自动 | ✅ 必须确认 | 破坏性行为，需 review gate |
| 重试失败任务 | ⚠️ 条件自动 | ⚠️ 建议确认 | 如果是 P0 问题可自动重试，否则需确认 |
| 切换备用模型/服务 | ❌ 不自动 | ✅ 必须确认 | 架构级变更，需人工决策 |

### 5.4 修正后重评估

每次修正执行后，右脑自动触发**局部重评估**：

```
修正执行完成
  └─▶ 等待 10 秒（服务启动/配置生效）
  └─▶ 重新运行失败的检查项
  └─▶ 如果通过：标记为已修复，更新评估报告
  └─▶ 如果失败：生成二级修正指令（ escalation ）
          └─▶ 二级修正最多 3 次
          └─▶ 3 次后仍失败：升级为人工介入告警
```

---

## 6. 持续测试循环（Continuous Supervision Loop）

### 6.1 循环架构

```
┌─────────────┐     ┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│   数据收集   │────→│   质量评估   │────→│   修正指令   │────→│   执行验证   │
│  (左脑执行)  │     │  (右脑分析)  │     │  (右脑生成)  │     │  (左脑执行)  │
└─────────────┘     └─────────────┘     └─────────────┘     └─────────────┘
       ↑                                                        │
       └──────────────────────── 反馈 ──────────────────────────┘
```

### 6.2 周期性健康检查

每 30 分钟执行的轻量级检查（不触发完整的 reasoning session）：

| 检查项 | 方法 | 耗时 | 失败阈值 |
|--------|------|------|----------|
| OMLX 健康 | `curl /health` | < 1s | 连续 3 次失败 |
| GameStudio Server | `curl /api/health` | < 1s | 连续 2 次失败 |
| Control Server | `curl /api/health` | < 1s | 连续 2 次失败 |
| 磁盘空间 | `df -h` | < 1s | 可用 < 10% |
| 内存使用 | `ps aux` | < 1s | 内存使用 > 90% |

如果周期性检查发现异常，立即触发完整的右脑评估。

### 6.3 趋势分析

右脑不仅评估当前状态，还分析历史趋势：

- **成功率趋势**：最近 10 次 story workflow 的成功率是否下降？
- **响应时间趋势**：OMLX 的 TTFT（Time To First Token）是否变长？
- **错误类型聚类**：最近 24 小时内最常见的错误类型是什么？
- **资源使用趋势**：磁盘、内存、GPU 使用率是否持续增长？

趋势分析结果写入 `ai/memory/LONG_TASKS.md`，作为系统优化方向。

---

## 7. 具体实现方法

### 7.1 后端新增模块

#### 7.1.1 `server/reasoning/supervision.js`

新增模块，负责：
- 聚合左脑执行数据
- 构建评分卡
- 生成修正指令

```javascript
// 核心函数签名
export async function aggregateSupervisionData(options = {}) {
  // 读取 reasoning-sessions、agent-runtime-events、memory 文件
  // 返回结构化数据
}

export function buildSupervisionScorecard(data) {
  // 按 6 大类别逐项评分
  // 返回评分卡 JSON
}

export function buildCorrectionPlan(scorecard, categoryId) {
  // 针对低于阈值的类别生成修正计划
  // 返回修正指令 JSON
}
```

#### 7.1.2 `server/reasoning/promptBuilders.js` 新增监督提示词

```javascript
export function buildSupervisionPrompt(data, scorecard) {
  const systemMessage = `你是一名 Control 系统监督专家。你的职责是：
1. 评估左脑（本地 OMLX 模型）的任务执行质量
2. 识别失败模式和根因
3. 生成具体、可执行的修正建议
4. 判断哪些修正可以自动执行，哪些需要人工确认

评分标准：
- 系统自检（20%）：基础服务可用性
- 故事生产（30%）：核心业务功能完整性
- 推理执行（25%）：任务分解与执行成功率
- 记忆管理（10%）：状态文件维护质量
- 配置路由（10%）：架构配置正确性
- 可观测性（5%）：日志与事件完整性

修正指令格式要求：
- 每个 action 必须有 type（command/verify/retry_task）
- 每个 action 必须标明 reviewRequired（true/false）
- 必须提供 estimatedFixTime 和 rollbackPlan`

  return [
    { role: 'system', content: systemMessage },
    { role: 'user', content: `请基于以下数据生成监督评估报告和修正指令：\n\n${JSON.stringify({ data, scorecard }, null, 2)}` }
  ]
}
```

#### 7.1.3 `controlServerCore.js` 新增监督执行入口

```javascript
async function executeSupervisionStep(sessionId, step, userPrompt, stepIndex) {
  const scope = step.params?.scope || 'overview'
  const data = await aggregateSupervisionData({ scope, maxSessions: 50 })
  const scorecard = buildSupervisionScorecard(data)

  // 如果所有项都通过，直接返回，不走模型
  if (scorecard.overallScore >= 90 && scorecard.categories.every(c => c.status === 'passed')) {
    return {
      success: true,
      result: { scorecard, conclusion: '左脑运行优秀，无需修正' }
    }
  }

  // 有问题时，调用右脑生成修正指令
  const messages = buildSupervisionPrompt(data, scorecard)
  const binding = buildHermesBinding()
  const resolvedRoute = resolveModelRouteForPhase(binding, 'meta_analysis', { action: 'meta_analysis' })
  const route = {
    transport: resolvedRoute.transport,
    baseUrl: resolvedRoute.baseUrl,
    model: resolvedRoute.model,
    headers: { ...resolvedRoute.headers, 'User-Agent': 'Kilo-Code/1.0' }
  }

  const response = await requestHermesChatCompletion({
    sessionId, phase: 'meta_analysis', messages, maxTokens: 8000, temperature: 0.2, route, timeoutMs: 120000
  })

  // 解析右脑返回的修正指令，写入 TASK_QUEUE
  const correctionPlan = parseCorrectionPlan(response.content)
  await persistCorrectionPlan(correctionPlan)

  return { success: true, result: { scorecard, correctionPlan } }
}
```

#### 7.1.4 定时任务触发器

在 `controlServerCore.js` 的初始化逻辑中：

```javascript
// 系统启动后 30 秒触发首次监督
setTimeout(() => {
  triggerSupervision({ trigger: 'post_startup', delay: 0 })
}, 30000)

// 每 30 分钟触发周期性监督
setInterval(() => {
  triggerSupervision({ trigger: 'periodic', delay: 0 })
}, 30 * 60 * 1000)
```

### 7.2 前端新增展示

#### 7.2.1 Control Console 状态条扩展

```vue
<!-- 监督中状态 -->
<div v-if="supervisionActive" class="message-banner warn">
  <span>🔮</span> 右脑监督中：正在评估左脑执行质量（{{ supervisionProgress }}%）...
</div>

<!-- 监督完成 - 有问题 -->
<div v-else-if="supervisionResult?.overallStatus === 'needs_improvement'" class="message-banner warn">
  <span>⚠️</span> 左脑评估完成：{{ supervisionResult.overallScore }} 分，{{ supervisionResult.failedCategories.length }} 项需修正
  <button @click="showSupervisionDetails">查看详情</button>
</div>

<!-- 监督完成 - 优秀 -->
<div v-else-if="supervisionResult?.overallStatus === 'excellent'" class="message-banner success">
  <span>✅</span> 左脑运行优秀（{{ supervisionResult.overallScore }} 分），所有检查项通过
</div>
```

#### 7.2.2 评估详情面板

在 Control Console 新增「系统健康」面板（可折叠）：

```
┌─────────────────────────────────────────────┐
│  🔮 右脑监督评估报告（2 分钟前）              │
├─────────────────────────────────────────────┤
│  总体评分: 78/100  🟡 需改进                  │
├─────────────────────────────────────────────┤
│  ✅ 系统自检        100/100                  │
│  🟡 故事生产         60/100  [查看修正建议]   │
│  ✅ 推理执行         85/100                  │
│  ✅ 记忆管理         90/100                  │
│  ✅ 配置路由        100/100                  │
│  ⚠️ 可观测性         70/100                  │
├─────────────────────────────────────────────┤
│  待修正项（2）                               │
│  1. [P1] 资产生成：ComfyUI 503 → [立即修正]  │
│  2. [P2] 日志轮转：control-server.log 2h 未更新 → [查看] │
└─────────────────────────────────────────────┘
```

### 7.3 新增 Action 和 Tool 注册

在 `actionRegistry.js` 和 `toolRegistry.js` 中注册：

```javascript
// actionRegistry.js
supervision_evaluate: {
  title: '监督评估',
  tool: REASONING_TOOLS['model.supervisionEvaluate'].tool,
  category: 'planner',
  description: '由右脑对左脑执行质量进行全面评估，生成评分卡和修正建议',
  paramsSpec: [
    'scope?: 评估范围，可选 overview/sessions/errors/performance，默认 overview',
    'autoCorrect?: 是否自动执行低风险修正，默认 false'
  ]
}

// toolRegistry.js
'model.supervisionEvaluate': {
  tool: 'model.supervisionEvaluate',
  title: '监督评估',
  category: 'planner',
  executionMode: 'model-assisted',
  reviewPolicy: 'auto',
  description: '调用右脑模型对左脑任务执行质量进行监督评估',
  routes: ['internal:reasoning/model.supervisionEvaluate']
}
```

---

## 8. 完整测试流程（端到端验证）

### 8.1 测试环境准备

```bash
# 1. 确保所有服务就绪
curl http://127.0.0.1:18888/health          # OMLX
curl http://127.0.0.1:1999/api/health       # GameStudio Server
curl http://127.0.0.1:2099/api/health       # Control Server
curl http://127.0.0.1:2099/api/control/versions  # 版本信息

# 2. 确保右脑配置正确
cat config/hermes/manager.left-brain.json | jq '.workflow.modelRouting.actionRoutes.meta_analysis'
# 应显示 provider=moonshot, model=kimi-for-coding
```

### 8.2 测试步骤

#### Step 1: 验证启动后自动监督触发

```bash
# 重启 Control 系统
sh scripts/lifecycle/restart_control.sh

# 等待 30 秒
sleep 30

# 检查是否生成了 supervision session
curl -s http://127.0.0.1:2099/api/control/agents/hermes-manager/reasoning-sessions | jq '.sessions[] | select(.type=="supervision")'
```

**期望结果**：自动生成了一个 `type: "supervision"` 的 reasoning session，状态为 `completed` 或 `running`。

#### Step 2: 验证评分卡生成

```bash
# 查看最新 supervision session 的 result
curl -s http://127.0.0.1:2099/api/control/agents/hermes-manager/reasoning-sessions/{sessionId} | jq '.result.scorecard'
```

**期望结果**：返回完整的评分卡 JSON，包含 6 大类别的得分和状态。

#### Step 3: 模拟左脑任务失败

```bash
# 手动停止 ComfyUI 模拟故事生产失败
pkill -f 'python.*ComfyUI'

# 等待下一次周期性监督（或手动触发）
# 手动触发方式：在 Control Console 输入 "系统评估"
```

**期望结果**：
- 右脑的评估报告中 `story_production` 得分下降
- 生成了针对 ComfyUI 的修正指令
- Control Console 状态条显示警告

#### Step 4: 验证修正指令执行

```bash
# 在 Control Console 点击修正建议中的"立即修正"
# 或直接调用 API

# 验证修正后重评估
curl -s http://127.0.0.1:2099/api/control/agents/hermes-manager/reasoning-sessions | jq '.sessions[] | select(.type=="supervision") | .result.scorecard.categories[] | select(.id=="story_production")'
```

**期望结果**：修正后 `story_production` 得分回升到 90+。

#### Step 5: 验证人工确认机制

```bash
# 模拟一个需要人工确认的修正（如修改配置文件）
# 在 Control Console 应该看到：
# "[需确认] 建议修改 config/hermes/manager.left-brain.json，是否应用？"
```

**期望结果**：高风险修正不会自动执行，必须等待用户点击确认。

### 8.3 测试通过标准

| # | 测试项 | 通过标准 |
|---|--------|----------|
| S1 | 启动后自动监督 | 重启 30 秒内自动生成 supervision session |
| S2 | 评分卡完整 | 6 大类别均有得分，总分计算正确 |
| S3 | 失败检测 | 手动制造故障后，评分卡正确反映 |
| S4 | 修正指令生成 | 对失败项生成了可执行的修正指令 |
| S5 | 自动修正低风险项 | 读取日志、检查状态等只读操作自动执行 |
| S6 | 人工确认高风险项 | 修改配置、删除文件等操作需要确认 |
| S7 | 修正后重评估 | 修正执行后自动重新评估，得分更新 |
| S8 | 趋势分析 | 连续多次评估后，能识别成功率趋势 |
| S9 | 通知机制 | 发现问题时 Control Console 状态条正确显示 |
| S10 | 持久化 | 评估报告写入 state/reasoning-sessions/ |

---

## 9. 与现有文档的关联

| 本文档 | 关联文档 | 关系 |
|--------|----------|------|
| 第 3 章左脑任务清单 | `ai/BRAIN_DIVISION.md` | 补充：BRAIN_DIVISION 定义分工，本文定义评估标准 |
| 第 5 章修正机制 | `docs/PRODUCTION_DEFECTS.md` | 补充：PRODUCTION_DEFECTS 记录已知缺陷，本文定义自动发现和修正 |
| 第 7 章实现方法 | `docs/KIMI_INTEGRATION_IMPLEMENTATION_PLAN.md` | 补充：KIMI_INTEGRATION 描述接入方案，本文描述监督机制 |
| 第 8 章测试流程 | `docs/KIMI_RIGHT_BRAIN_TEST_PLAN.md` | 补充：TEST_PLAN 描述基础功能测试，本文描述监督机制端到端测试 |

---

## 10. 实施路线图

| 阶段 | 内容 | 工期 | 依赖 |
|------|------|------|------|
| Phase 1 | 实现 `supervision.js` 数据聚合和评分卡 | 2 天 | 元分析模块已完成 |
| Phase 2 | 实现右脑监督提示词和修正指令生成 | 2 天 | Phase 1 |
| Phase 3 | 实现自动/人工确认执行机制 | 2 天 | Phase 2 |
| Phase 4 | Control Console 状态条和详情面板 | 2 天 | Phase 3 |
| Phase 5 | 端到端测试和调优 | 2 天 | Phase 4 |

**总计：约 10 个工作日**

---

> 本文最后更新：2026-06-06
