# User Preferences

> 本文档定义用户与 agent 团队协作的偏好、边界和期望。
> 所有 agent（planner / executor / critic / reporter）必须遵循本文档。
> 偏好变化时，请更新本文档并同步写入 `memory/DECISIONS.md`。

---

## Collaboration Defaults

- 默认用中文沟通，结论先于展开说明。
- 更偏好先执行、后回报，不希望先给大段方案再等待确认。
- 结果汇报优先包含：做了什么、是否验证通过、下一步是什么。
- 能由 agent 代为运行、检查、修改的任务，尽量不要回退给用户手工执行。
- **主动推进**：任务进行中，agent 应自动推进下一个可执行步骤，无需每次等待用户确认。
- **阻塞才问**：只有在遇到歧义、风险高、或需要用户决策时才停下来询问。
- **批量汇报**：多个小步骤完成后，合并为一次汇报，避免碎片化消息。

---

## Engineering Preferences

### 技术栈偏好

- **语言**：TypeScript 优先于 JavaScript；Python 用于脚本和工具链。
- **框架**：后端优先 Node.js (Express/Fastify) 或 Python (FastAPI)；前端优先 React。
- **构建工具**：优先使用项目已有的构建工具（如 `npm run build`、`tsc`）。
- **测试框架**：优先使用项目已有的测试框架（如 `vitest`、`pytest`）。

### 代码风格

- 遵循项目已有的 lint 规则（如 `.eslintrc`、`pyproject.toml`），不要引入新 lint 工具。
- 命名规范：
  - 变量/函数：`camelCase`
  - 类/接口：`PascalCase`
  - 常量：`UPPER_SNAKE_CASE`
  - 文件：`kebab-case.ts` 或 `snake_case.py`
- 注释优先写 **why**，而非 **what**。不要为显而易见的代码加注释。
- 函数保持单一职责，单个文件不超过 300 行（超出则拆分）。

### 工程原则

- 本地优先：默认优先使用本地模型、本地工具和本地可验证链路。
- 云模型是增强选项，不应成为主流程依赖；恢复额度后可动态切回。
- 保持 agent 身份稳定，不因切换模型而更换 agent id 或清空会话。
- 对项目操作采用小步快跑：一次只做一个清晰动作批次，改后立即验证。
- **验证标准**：
  - 代码变更 → `tsc --noEmit` 或等价 typecheck 通过
  - 功能变更 → 相关测试通过（`npm test` 或等价命令）
  - 关键路径 → 手动验证核心行为（如 API 端点可访问）
- **失败处理**：
  - 任务失败 → 先分析根因，能自动重试则重试一次
  - 重试仍失败 → 报告用户，附带错误日志、已尝试的操作、建议下一步
  - 不要静默忽略失败，不要跳过验证

---

## Project Structure Preferences

- **目录组织**：
  - `src/` - 源代码
  - `tests/` - 测试文件，与 `src/` 结构镜像
  - `scripts/` - 运维和工具脚本
  - `memory/` - agent 状态和记忆文件
  - `docs/` - 文档和设计
- **新建文件时**：优先放到上述目录，不要散落在项目根目录。
- **依赖管理**：新增依赖必须写入 `package.json` 或 `requirements.txt`，执行 `npm install` 或 `pip install`。
- **环境变量**：新增配置项必须更新 `.env.example`，不要硬编码密钥。

---

## Safety & Permission Boundaries

### 可自动执行（无需确认）

- 读取文件、搜索代码、运行测试、运行 typecheck
- 小范围代码修改（单文件、逻辑清晰、有测试覆盖）
- 运行项目标准启动/停止/状态检查脚本

### 需要确认后执行

- 删除文件或目录（尤其是 `rm -rf`、`git clean`）
- 修改依赖版本（`npm install <pkg>@version`、`pip install --upgrade`）
- 修改 CI/CD 配置、Dockerfile、环境变量
- 外部操作（发送邮件、推送消息、调用第三方 API 写操作）
- `git push`、`git force-push`、`git reset --hard`

### 禁止操作

- 提交包含密钥、token、密码的代码
- 修改 `.env` 中的真实密钥（只允许修改 `.env.example`）
- 任何不可逆的大范围删除操作

---

## Feedback & Reporting Preferences

- **进度更新频率**：每个生产任务完成后自动汇报一次，不要每条消息都汇报。
- **主动汇报触发条件**：
  - 任务完成 / 失败 / 被阻塞
  - 发现新的风险或决策点
  - 用户主动询问状态
- **汇报格式**（适用于 executor / planner）：
  ```
  ✅ 完成：[任务简述]
  📝 修改：[文件/配置变更简述]
  🔍 验证：[验证方式 + 结果]
  ➡️ 下一步：[建议的下一个动作]
  ```
- **日报/总结**：用户要求时，汇总当日 `memory/YYYY-MM-DD.md` 和 `memory/TASK_QUEUE.md` 输出结构化总结。

---

## Project Expectations

- 希望 OpenClaw 长期管理 `game_studio`，包括理解需求、拆分任务、修改代码、验证结果、维护项目状态。
- 希望系统持续积累对用户和项目的理解，但这种理解必须落到可持续文件记忆，而不是依赖短期上下文。
- 重要状态、偏好、决策变化要写回项目记忆，保证未来换模型后仍能延续工作。
- **记忆维护规则**：
  - 新偏好/决策 → 更新 `USER.md` 或 `memory/DECISIONS.md`
  - 任务状态变化 → 更新 `memory/TASK_QUEUE.md` 和 `memory/STATUS.md`
  - 每日工作结束前 → 写入或更新 `memory/YYYY-MM-DD.md`

---

## Review Preferences

- 审查优先指出风险、回归、缺失验证，不要空泛表扬。
- 若无明显问题，明确给出 `PASS`，同时说明残余风险或未覆盖验证。
- 审查输出保持简短、可执行，避免长篇泛化建议。
- **审查重点**：
  - 正确性：逻辑是否有漏洞、边界条件是否处理
  - 安全性：是否有注入风险、密钥是否泄露
  - 性能：是否有明显的性能退化（如 O(n²) 替代 O(n)）
  - 可维护性：代码是否可读、是否遵循项目约定

---

## Startup & Automation Preferences

- **启动汇报**：每次打开 GameStudio 项目时，必须自动执行一次 reporter 汇报
- **邮件汇报**：定时任务必须保持加载状态，每 3 小时发送一次状态邮件
- **验证方式**：启动后检查 `launchctl list | grep gamestudio` 确认任务已加载
- **失败处理**：如果 reporter 未自动执行，agent 应手动运行 `bash scripts/lifecycle/reporter.sh`

### 自动化开关（运行模式）

- 默认模式：`manual`（手动优先，监控/看门狗默认关闭）
- `startup_report_enabled`：默认 `on`
- `scheduled_email_enabled`：默认 `on`
- `openclaw_monitor_enabled`：默认 `off`，仅在用户明确要求时开启
- `self_heal_enabled`：默认 `off`，仅在用户明确要求时开启
- 10 分钟超时自愈仅在 `self_heal_enabled=on` 时生效

## Anti-Patterns（不希望出现的行为）

- ❌ 大段计划后等待确认，而不先执行验证
- ❌ 修改后不运行验证，直接说"完成"
- ❌ 输出完整日志或大段代码，除非被明确要求
- ❌ 用英文回复中文问题（除非用户要求英文）
- ❌ 在没有理解问题的情况下盲目修改
- ❌ 跳过测试或 typecheck，假设"应该没问题"
- ❌ 替用户做决策而不解释原因
