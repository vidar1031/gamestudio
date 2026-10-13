# GameStudio 全系统项目治理规则

> 本文档是 GameStudio 项目的**最高级治理规则**。任何 agent、开发者、维护者必须遵守。
> 违反本文档规则的操作视为无效，必须回滚或修正。
> 本文档的修改必须经过 `ai/memory/DECISIONS.md` 级别的决策记录。

---

## 目录

1. [文档层级与归属规则](#1-文档层级与归属规则)
2. [记忆文件管理规则](#2-记忆文件管理规则)
3. [Control → Agent → OMLX 工作流规则](#3-control--agent--omlx-工作流规则)
4. [文档创建、更新、清理规则](#4-文档创建更新清理规则)
5. [归档与删除规则](#5-归档与删除规则)
6. [禁止行为清单](#6-禁止行为清单)
7. [违规处理流程](#7-违规处理流程)
8. [项目总监（Director Profile）约定](#8-项目总监director-profile约定)

---

## 1. 文档层级与归属规则

### 1.1 文档层级结构

```text
项目根目录
├── docs/                          # 系统级权威文档（只读契约）
│   ├── PROJECT_GOVERNANCE.md      # ← 本文档（最高级规则）
│   ├── 系统生产级推进方案.md       # 系统分工、启动流程、任务流、路由规则
│   ├── 狼来了内容质量闭环工作流.md  # 现行生产主手册（22 步全链路 + 质量闭环）
│   ├── Control + GameStudio 生产工作流联调测试说明.md  # 联调测试标准与验证清单
│   ├── PRODUCTION_DEFECTS.md      # 当前生产缺陷与未实现项
│   ├── UI_REDESIGN_PROPOSAL.md    # UI 重设计提案（实施状态见文档头）
│   ├── HERMES_EVALUATION_2026-07-23.md  # Hermes 评估记录（留存追溯）
│   ├── archive/                   # 完成态计划档案（playbook、KIMI 四件套等，仅追溯）
│   └── README.md                  # docs/ 目录索引
│
├── ai/                            # Agent 契约与运行时记忆
│   ├── AGENTS.md                  # Agent 工作契约
│   ├── MEMORY.md                  # 长任务方向
│   ├── TOOLS.md                   # 工具与接口细节
│   ├── USER.md                    # 用户偏好
│   ├── BRAIN_DIVISION.md          # 左右脑分工与路由规则
│   ├── control_architecture.md    # Control 架构说明
│   ├── interactive_story_editor.contract.md
│   ├── chat/                      # 聊天历史（按日期 JSON，自动维护）
│   └── memory/                    # ← 运行时记忆（唯一权威）
│       ├── STATUS.md              # 当前目标/结果/阻塞/下一步
│       ├── TASK_QUEUE.md          # 短任务队列
│       ├── DECISIONS.md           # 稳定规则与架构边界
│       ├── LONG_TASKS.md          # 长任务方向与里程碑
│       └── daily/                 # 当日日志（系统自动写入，禁止手工创建）
│
├── memory/                        # ⚠️ 已弃用（见 README.md）
│
├── state/                         # 运行时状态与自动维护数据
│   ├── memory-archive/            # 记忆归档目录
│   ├── memory-lifecycle/          # 生命周期维护报告
│   ├── agent-runtime-sessions/    # Reasoning session 存储
│   ├── reasoning-queue/           # 持久化任务队列（AUTO-C01）
│   ├── reasoning-checkpoints/     # Session checkpoint
│   ├── events/ + event-runs/      # 事件层执行记录
│   ├── agent-stream-bridge/       # agent 流式咨询会话映射
│   ├── retention-cleanup/         # 保留清理报告（AUTO-C03）
│   ├── story-production/          # 生产项目状态
│   ├── cron-jobs.json             # cron 定时任务（HERMES-H02）
│   ├── governance-audit.jsonl     # 治理操作审计（HERMES-H01）
│   ├── proposal-governance.json   # proposal 治理状态（AUTO-F02）
│   ├── project-workflow-registry.json  # 项目/workflow 注册表（HERMES-H04）
│   ├── resource-scheduler.json    # 资源互斥调度状态（AUTO-R01）
│   ├── project-binding.json       # 当前绑定项目
│   ├── right-brain-supervision.json    # 右脑监察记录（HERMES-H03）
│   ├── skill-governance.json      # 技能治理状态
│   └── *.jsonl                    # 事件流、评审记录等
│
└── storage/projects/              # 项目产物真相源
```

### 1.2 各层级职责边界

| 目录 | 用途 | 维护者 | 读写权限 |
|------|------|--------|----------|
| `docs/` | 系统级权威文档、契约、方案 | 人类维护者 + Agent（只读/建议） | 人类写入，Agent 只读 |
| `ai/` | Agent 契约、工具说明、运行时记忆 | Agent + 人类 | Agent 可读写 `ai/memory/`，只读其他 |
| `ai/memory/` | **唯一权威运行时记忆** | Agent | Agent 读写，人类可读 |
| `memory/` | ⚠️ **已弃用** | 无人 | 禁止写入 |
| `state/` | 运行时状态、自动维护数据、归档 | Control Server | 程序自动维护 |
| `storage/projects/` | 项目产物真相源 | GameStudio Server | 程序写入，人类只读 |

### 1.3 关键原则

**原则 1：单源真相**
- `ai/memory/` 是运行时记忆的**唯一权威来源**。
- `memory/` 根目录已弃用，禁止在其中创建任何文件。
- 禁止在 `ai/memory/` 和 `memory/` 之间复制文件维持"双备份"。

**原则 2：文档不堆流水账**
- `docs/` 只保留系统级契约、方案和边界说明。
- 单次测试结果、session ID、临时结论**禁止**写入 `docs/`。
- 当日进展更新 `ai/memory/STATUS.md`，详细过程进入 `state/`。

**原则 3：Agent 读取以 `ai/` 为准**
- Agent 运行时只读取 `ai/` 下的契约文件和 `ai/memory/` 下的记忆文件。
- Agent **禁止**读取 `memory/` 根目录、`docs/` 中的历史版本、或 `state/` 中的原始事件流。

**原则 4：云端模型调用必须经用户显式确认（2026-09-21 用户指令，硬性法律）**
- 任何云端模型调用（Kimi/moonshot 等非本机 provider）必须携带本次执行的用户显式确认；未经确认的主动/被动云端调用一律违规，守护台右脑启动执行同样适用。
- 每次云端执行必须落治理审计明细（路由/模型/调用方/usage tokens），禁止黑盒执行。
- 代码级硬门禁写死在 `local-agent-control`：模型调用收口 `modelTaskQueue.requestHermesChatCompletion` + 右脑执行端点 + 门禁模块 `security/cloudCallGate.js`；新增模型调用路径必须过同一门禁，禁止旁路。

---

## 2. 记忆文件管理规则

### 2.1 记忆文件清单

`ai/memory/` 下只允许存在以下 4 个文件：

| 文件 | 用途 | 更新触发条件 | 格式要求 |
|------|------|-------------|----------|
| `STATUS.md` | 当前目标、结果、阻塞、下一步 | 每次多步骤任务完成后 | Markdown，4 个 H2 标题 |
| `TASK_QUEUE.md` | 短任务推进队列 | 任务状态变化时 | Markdown 列表 |
| `DECISIONS.md` | 稳定规则与架构边界 | 新的稳定取舍确认后 | Markdown，编号决策 |
| `LONG_TASKS.md` | 长任务方向与里程碑 | 长任务方向变化时 | Markdown，阶段划分 |

另有 `daily/` 子目录：当日日志由 Control Server 在有实质变更后自动写入（`ai/memory/daily/YYYY-MM-DD.md`），不属于手工记忆文件，不适用 4 文件限制；**禁止手工**在 `ai/memory/` 下创建日期日志。

### 2.2 禁止在 ai/memory/ 下创建的文件

以下文件类型**严格禁止**出现在 `ai/memory/`：

- ❌ 按日期的日志文件（如 `2026-05-18.md`）
- ❌ 临时笔记或草稿
- ❌ 与上述 4 个文件功能重复的文件
- ❌ 二进制文件、JSON 文件（记忆必须是 Markdown）

### 2.3 记忆更新规则

**规则 2.3.1：多步骤任务完成后必须同步记忆**

任何多步骤执行任务完成后，必须在最终回答前同步更新记忆文件：

```
如果任务改变了项目状态、修复了运行时规则、推进了任务链：
  → 更新 ai/memory/STATUS.md
  → 更新 ai/memory/TASK_QUEUE.md

如果涉及稳定规则或架构边界变化：
  → 更新 ai/memory/DECISIONS.md

如果涉及长任务方向或里程碑变化：
  → 更新 ai/memory/LONG_TASKS.md
```

**规则 2.3.2：STATUS.md 格式**

```markdown
## 当前目标
[一句话描述当前要达成的目标]

## 当前结果
[已完成的成果， bullet 列表]

## 当前阻塞
[如果有阻塞，说明原因；无阻塞则写"无阻塞"]

## 下一步
[具体的下一步行动，编号列表]

sessionId: [最近的 reasoning session ID，可选]
updatedAt: [ISO 8601 时间戳]
```

**规则 2.3.3：禁止只更新聊天历史**

- 只更新聊天历史、不更新记忆文件 → **视为无效操作**
- 必须同步到 `ai/memory/` 下的对应文件

### 2.4 记忆的自动维护

Control Server 通过 `runMemoryLifecycleMaintenance` 自动维护：

| 数据类型 | 保留策略 | 归档位置 |
|----------|----------|----------|
| Chat History | 30 天后归档，单文件最多 120 条 | `state/memory-archive/chat/` |
| Context Pool | 90 天后归档 | `state/memory-archive/context/` |
| Reasoning Session | 7 天后进入 sleeping，30 天后归档 | `state/memory-archive/sessions/` |
| Daily Log | 30 天后归档 | `state/memory-archive/daily-logs/` |
| Project Memory (STATUS/TASK/DECISION/LONG) | **永久保留**（AWAKE 状态） | 不归档 |

---

## 3. Control → Agent → OMLX 工作流规则

### 3.1 工作流总览

```text
用户输入 prompt
  │
  ▼
Control Console ──► Control Server
  │
  ▼
Request Classification（启发式规则优先）
  │
  ├──► answer_only ───────────► 直接返回答案（不走模型）
  │
  ├──► plan_then_answer ──────► 读取项目资料 → 返回答案
  │
  ├──► inspect_then_answer ───► 查询系统状态 → 返回答案
  │
  ├──► workflow_execute ──────► 生成 plan → 执行 steps
  │       │
  │       ├──► productionTest=true ──► bypass 所有 review
  │       │
  │       └──► productionTest=false ─► 正常 review 流程
  │
  └──► write_or_invoke_review ─► 请求人工审核 → 执行
  │
  ▼
需要模型时 ──► Hermes Gateway ──► OMLX / 其他 Provider
  │
  ▼
GameStudio Server（项目读写、编译、校验、导出）
  │
  ▼
Artifacts / Evaluator → Control 基于证据返回结论
```

### 3.2 Control 层规则

**规则 3.2.1：确定性分类优先**

- Control Server 收到请求后，先执行启发式规则分类。
- 只有规则置信度不足时才调用模型做轻量分类。
- 命中固定 workflow 后，**禁止**模型自由发明 action 名。

**规则 3.2.2：生产任务必须进入 reasoning session**

- 所有 `workflow_execute` 类型的请求必须创建 reasoning session。
- 必须生成明确 plan（steps 列表）。
- 必须记录 step artifacts 和 evaluator 结果。
- 最终结论必须基于 artifacts，不能基于模型自由发挥。

**规则 3.2.3：productionTest 模式规则**

| 参数 | 说明 |
|------|------|
| `productionTest=true` | 完整 bypass 所有 review gate，用于自动化测试 |
| `productionTest=false`（默认） | 正常 review 流程，mutation 步骤需要 approve |
| `requireModelAnswer=true` | 调用 OMLX 生成真实内容 |
| `requireModelAnswer=false`（默认） | 使用 deterministic fallback |

组合行为：

| productionTest | requireModelAnswer | 行为 |
|----------------|-------------------|------|
| true | false | 使用 fallback 脚本，不走 OMLX，最快完成 |
| true | true | 调用 OMLX 生成真实内容，bypass review |
| false | false | 正常流程，fallback 脚本，需 review |
| false | true | 正常流程，OMLX 生成，需 review |

**规则 3.2.4：禁止直接操作 ComfyUI**

- Control **禁止**直接把 ComfyUI 视为生产入口。
- 图片生成必须通过 GameStudio Server API。
- 用单独 curl 打 ComfyUI 不算生产通过。

### 3.3 Agent 层规则

**规则 3.3.1：Agent 只执行允许的操作**

- Agent 只能执行 `agentDefinitions.js` 中声明的 capabilities。
- Agent **不能**决定项目是否成功（这是 evaluator 的职责）。
- Agent **不能**直接写项目文件（必须通过 GameStudio Server API）。

**规则 3.3.2：模型输出只能作为候选**

- OMLX 生成的 scripts、Story Bible、asset plan 都是**候选**，不是事实。
- 候选必须经过 schema 校验、evaluator 评估才能落盘。
- fallback 候选必须显式标记 `fallback: true`，不能冒充模型创作成功。

**规则 3.3.3：请求分类规则**

Agent 运行时遵循以下分类优先级（从高到低）：

1. `write_or_invoke_review`（变更操作，需审核）
2. `gamestudio_bootstrap_execute`（GameStudio 启动/诊断）
3. `story_workflow_execute`（故事工作流）
4. `inspect_then_answer`（能力状态查询）
5. `plan_then_answer`（默认兜底，项目相关查询）
6. `answer_only`（最低优先级，纯文本回答）

### 3.4 OMLX 层规则

**规则 3.4.1：OMLX 职责边界**

- OMLX 只负责**本地模型推理**。
- 不做项目编排、文件落盘、边界判断。
- 不做请求分类、plan 生成（这些是 Control 的职责）。

**规则 3.4.2：response_format 兼容性**

- `gpt-oss-20b` 在 `/responses` API 的 `json_schema` response_format 下会返回空 `content`。
- 当前 workaround：fallback 到 `chat/completions` + schema 嵌入 system prompt。
- 此 workaround 适用于 `localoxml` provider。
- 若 OMLX 更新修复此问题，可回退到 `/responses`。

**规则 3.4.3：max_tokens 设置**

| 场景 | max_tokens | 原因 |
|------|-----------|------|
| Story scripts candidate | 8192 | 中文故事脚本需要更多 token |
| Story Bible | 8192 | 复杂 schema 输出 |
| Blueprint review | 900 | 评审结果通常较短 |
| Quality calibration | 360 | 简短评分 |
| Context draft | 320 | 简短摘要 |

---

## 4. 文档创建、更新、清理规则

### 4.1 文档创建规则

**规则 4.1.1：新文档默认不新增**

- 优先合并到现有权威文档。
- 只有出现全新的系统级概念时才新建文档。
- 新建文档必须归入正确的层级（`docs/`、`ai/`、`ai/memory/`）。

**规则 4.1.2：创建前检查清单**

创建新文档前必须回答：

1. 这个内容是否必须是一个独立文档？（能否合并到现有文档？）
2. 这个文档的读者是谁？（人类 / Agent / 两者？）
3. 这个文档放在哪个层级？（`docs/` / `ai/` / `ai/memory/`）
4. 这个文档的更新频率是多少？（一次性 / 每任务 / 每日 / 稳定）
5. 这个文档是否已有重复？（搜索整个项目确认）

### 4.2 文档更新规则

**规则 4.2.1：更新必须同步**

- 如果一个改动影响了多个文档，必须同步更新所有相关文档。
- 不能出现 A 文档说"已完成"、B 文档说"未实现"的矛盾状态。
- 更新后必须检查文档间的一致性。

**规则 4.2.2：标记已修复的缺陷**

- 已修复的缺陷必须明确标记（如 `~~已删除线~~ ✅ 已修复`）。
- 不能简单删除缺陷描述（保留历史记录）。
- 必须注明修复的文件和位置。

**规则 4.2.3：禁止在文档中堆流水账**

- 文档中不允许出现 "今天做了 A，明天做了 B" 的流水账。
- 过程性描述必须压缩为一句能力摘要。
- 详细过程进入 `state/` 或测试 artifacts。

### 4.3 文档清理规则

**规则 4.3.1：定期审查**

每月 1 号执行文档审查：

1. 检查 `ai/memory/` 下是否有非法文件（按日期的日志、临时文件等）。
2. 检查 `memory/` 根目录是否被重新使用（应始终为空或只有 README.md）。
3. 检查 `docs/` 中是否有过期内容（已修复的缺陷未标记、过时的技术细节）。
4. 检查 `state/memory-archive/` 中是否有需要永久删除的归档。

**规则 4.3.2：空文件必须删除**

- `ai/memory/` 下发现空文件 → 立即删除。
- `docs/` 下发现空文件 → 确认是否需要补充内容，否则删除。

**规则 4.3.3：重复文件必须合并或删除**

- 发现两个文件内容 80% 以上重复 → 合并为一个，删除另一个。
- 发现 `memory/` 和 `ai/memory/` 有同名文件 → 以 `ai/memory/` 为准，删除 `memory/` 下的。

---

## 5. 归档与删除规则

### 5.1 归档规则

**规则 5.1.1：什么需要归档**

| 内容类型 | 归档时机 | 归档位置 |
|----------|----------|----------|
| 按日期的日志文件 | 创建后 7 天 | `state/memory-archive/daily-logs/` |
| 旧的 chat history | 30 天后 | `state/memory-archive/chat/` |
| 旧的 context pool | 90 天后 | `state/memory-archive/context/` |
| 旧的 reasoning session | 30 天后 | `state/memory-archive/sessions/` |
| 已弃用的文档 | 确认弃用后 | `state/memory-archive/wrong-memory/` |

**规则 5.1.2：归档必须保留元数据**

归档时必须记录：

```json
{
  "archivedAt": "2026-05-18T00:00:00Z",
  "originalPath": "memory/2026-04-30.md",
  "reason": "daily_log_expired",
  "archivedBy": "memory-lifecycle"
}
```

**规则 5.1.3：禁止直接删除未归档的文件**

- 必须先归档，再删除原文件。
- 例外：`ai/memory/` 下的 4 个权威记忆文件永久保留，不归档。

### 5.2 删除规则

**规则 5.2.1：什么可以永久删除**

- `ai/memory/` 下的空文件。
- `memory/` 根目录下的任何文件（该目录已弃用）。
- `state/memory-archive/` 下超过 1 年的归档（需人工确认）。
- `state/agent-runtime-sessions/` 下已完成且超过 90 天的 session（由 lifecycle 自动处理）。

**规则 5.2.2：什么绝对不能删除**

- `ai/memory/STATUS.md`、`TASK_QUEUE.md`、`DECISIONS.md`、`LONG_TASKS.md`。
- `docs/` 下的所有权威文档。
- `ai/AGENTS.md`、`ai/TOOLS.md`、`ai/control_architecture.md`。
- `storage/projects/` 下的任何项目文件（除非明确确认项目已废弃）。

---

## 6. 禁止行为清单

以下行为**严格禁止**，违反者必须回滚并记录违规：

### 6.1 文档层面

| # | 禁止行为 | 后果 |
|---|----------|------|
| D1 | 在 `memory/` 根目录下创建任何新文件 | 状态不同步，Agent 读取不到 |
| D2 | 在 `ai/memory/` 下创建按日期的日志文件 | 记忆目录混乱，生命周期无法管理 |
| D3 | 在 `ai/memory/` 下创建第 5 个记忆文件 | 超出设计容量，Agent 读取规则被破坏 |
| D4 | 在 `docs/` 中写入单次测试结果或 session ID | 文档堆满流水账，失去权威 |
| D5 | 两个文档对同一事实给出矛盾描述 | 双源真相，决策混乱 |
| D6 | 删除已修复的缺陷描述（不标记"已修复"） | 历史记录丢失 |
| D7 | 更新聊天历史但不更新 `ai/memory/` | 运行时记忆过期 |

### 6.2 工作流层面

| # | 禁止行为 | 后果 |
|---|----------|------|
| W1 | Control 直接调用 ComfyUI 生成图片 | 绕过 GameStudio Server，无法追踪 |
| W2 | 模型自由发明 action 名 | 执行不可控，可能破坏项目 |
| W3 | fallback 候选不标记 `fallback: true` | 虚假成功，质量无法评估 |
| W4 | `productionTest=true` 在生产环境使用 | review gate 被 bypass，安全风险 |
| W5 | Agent 直接写项目文件 | 绕过 GameStudio API，数据不一致 |
| W6 | 跳过 Story Bible 直接生成资产 | 角色/地点一致性无法保证 |

### 6.3 数据层面

| # | 禁止行为 | 后果 |
|---|----------|------|
| S1 | 直接删除 `storage/projects/` 下的项目 | 数据丢失，无法恢复 |
| S2 | 直接修改 `state/` 下的 `.jsonl` 文件 | 事件流被破坏，审计失效 |
| S3 | 在未归档的情况下删除 reasoning session | 历史记录丢失 |
| S4 | 将模型输出当事实写入 `project.json` | 数据污染，evaluator 失效 |

---

## 7. 违规处理流程

### 7.1 发现违规

任何人发现违规行为，必须：

1. 在 `ai/memory/STATUS.md` 中记录违规事件。
2. 如果违规涉及稳定规则，在 `ai/memory/DECISIONS.md` 中追加禁止项。
3. 如果违规造成数据损坏，立即回滚或修复。

### 7.2 违规记录格式

```markdown
## 违规记录

- 时间: [ISO 8601]
- 违规项: [D1/D2/W1/W2 等编号]
- 描述: [简要描述]
- 影响: [造成的数据/状态影响]
- 处理: [回滚/修复/归档]
- 预防: [如何避免再次违规]
```

### 7.3 定期审计

每月 1 号执行全系统审计：

1. 检查 `memory/` 根目录是否为空（应为空或只有 README.md）。
2. 检查 `ai/memory/` 下是否只有 4 个文件。
3. 检查 `docs/` 中是否有矛盾描述。
4. 检查 `state/` 下是否有未归档的过期数据。
5. 检查 `storage/projects/` 下是否有孤儿项目。
6. 检查最近一次 `runMemoryLifecycleMaintenance` 报告。

---

## 8. 项目总监（Director Profile）约定

> 2026-10-13 用户指令确立：守护台跑某个绑定项目的生产链时，必须有一个"项目总监"从头到尾指挥该项目的全部正确行为；切换到其他绑定项目时，由其他项目自己的总监接管。本节约定该概念的语义与底线。

### 8.1 总监是什么

**总监 = 规则化导演编排器 + 失败处置策略表 + 项目级生产约定，不是一个大模型。**

本机 32G 内存物理约束跑不动第二个常驻大模型，且"靠外部更强模型救场"与"本地智能体自主完成"的目标矛盾。总监的智能体现在：

1. **全链状态机推进**：知道本项目生产链的完整步骤图、每步的前置/产出/验收标准。
2. **失败处置策略表**：每类失败对应唯一确定的处置动作，Guardian 按表自动执行，不靠模型临场决策：
   - 瞬断（ECONNREFUSED/超时/5xx）→ 断点自动续跑（预算 3 次）
   - 模型输出格式坏（JSON 截断/解析失败）→ 容错解析 + 带错误反馈重试一次
   - 单轮额度上限（如锁定出图 maxNewGenerations）→ 收敛重试，已完成部分不重跑
   - 视觉评审不过 → 重抽（新种子），同一资产连续失败达上限才停摆
   - 业务死锁/审核拒绝/证据不足 → **停摆等人工**（失败即停，不可绕过）
3. **项目级生产约定**：该项目的故事结构公式、审核阈值、提示词约定、风格锁定词——写入项目绑定档案的 `directorProfile`，守护台切到哪个项目就用哪个项目的总监档案。

### 8.2 绑定切换语义

- 守护台 `currentProjectId` 切换 = 总监切换。GameStudio 的总监管互动故事生产全链；forge-studio 等分析型项目有自己的总监档案。
- 没有总监档案的项目**不允许跑生产链**（只允许 CRUD/健康检查类调用）。
- 总监档案存于项目注册表（local-agent-control `state/projects-registry.json` 的 `directorProfile` 字段），修改走审核门禁并写治理审计。

### 8.3 底线（不可绕过）

- 失败即停契约高于一切自动处置：策略表之外的失败一律停摆等人工。
- 自动处置只允许策略表内声明的类型；每次自动处置必须写 reasoning 事件 + 治理审计（actor=guardian-managed/director）。
- 本地模型只负责内容生成，不负责"失败后怎么办"的决策——决策只能来自策略表或人工。

### 8.4 实施状态（2026-10-13）

- 已实现：Guardian 守护循环（瞬断不断点续跑、orphan 自动恢复、托管自动批准、firstFailure 停摆）、任务中心守护横幅/托管开关、本地 VL 评审兜底。
- 待建设：完整失败处置策略表入 directorProfile（当前瞬断/额度/停摆三类已生效，格式自愈与评审重抽的自动重试待入表）、forge-studio 总监档案。

---

> 本文档最后更新：2026-10-13
> 下次审查：2026-11-01
> 文档状态：`authoritative-enforced`
