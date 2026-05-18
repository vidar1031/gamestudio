# 生产缺陷与不足报告

> 本文是 `docs/` 中唯一集中记录**当前仍然存在**的生产缺陷、未实现项和系统性不足的文档。已修复的问题不再写入本文，应归档到版本历史或 commit message 中。
>
> 更新规则：发现新缺陷时直接追加；修复后移动到"已修复归档"区或删除；定期清理过期条目。

---

## P0 — 阻塞生产自动化

| # | 缺陷/不足 | 影响 | 状态 | 修复方向 |
|---|-----------|------|------|----------|
| P0-01 | **ComfyUI 未集成 / 未运行** | `image_provider_not_ready` 阻塞 P1 图片资产生成，导致完整图文故事闭环无法完成 | 活跃 | 安装/配置 ComfyUI，或实现 mock provider 用于自动化测试 |
| P0-02 | **`L4-04` evaluator false-pass** | `compose evaluator` 失败（`blueprint 节点数=0`、`failedStage=validate_project_evaluator`）时，case 仍被自动判为 `PASS` | 活跃 | 收紧 `finalizeReasoningSessionWithQualityGate` 判定逻辑：evaluator 失败必须记为 FAIL |
| P0-03 | **Character asset pipeline 未实现** | `assetKind === 'character'` 时直接返回失败，角色 sprite 无法生成 | 活跃 | 实现 character sprite 生成 workflow，或从当前生产路径中移除并给出明确降级说明 |
| P0-04 | **模型切换回滚可能留空模型** | unload 成功但 rollback load 失败时，OMLX 处于无模型状态 | 待验证 | rollback 失败时自动加载最小可用模型，并标记降级状态 |

---

## P1 — 影响稳定性

| # | 缺陷/不足 | 影响 | 状态 | 修复方向 |
|---|-----------|------|------|----------|
| P1-01 | **`L1-02` 长尾回答** | `step_generate_capability_answer` 耗时过长，虽最终可完成但耗时不受控 | 活跃 | 压缩 answer 生成逻辑，或设置明确的上限超时并返回降级结果 |
| P1-02 | **OMLX `response_format` workaround 脆弱性** | 当前依赖 schema 嵌入 prompt + `chat/completions` fallback；若 OMLX 更新可能再次失败 | 活跃 | 向 OMLX 上游反馈 `response_format` 问题；建立更健壮的 fallback 链 |
| P1-03 | **Control Server 全局错误处理器待观察** | 已添加 `process.on('unhandledRejection')` / `uncaughtException`，但长期稳定性仍需验证 | 待观察 | 增加错误分类、自动恢复和报警机制 |
| P1-04 | **OMLX 503/504 重试逻辑待观察** | 已添加 3 次指数退避重试，但长期效果未验证 | 待观察 | 增加重试 metrics 和失败模式分析 |
| P1-05 | **`sessionCallCounts` / `inspectModelAccessCache` 无清理** | 长期运行内存泄漏 | 活跃 | session 完成时删除旧 entry，或添加 TTL |
| P1-06 | **Port 清理不可靠** | `restart_control.sh` 等重启脚本偶发 port 占用，需手动 kill | 活跃 | 增强脚本中 port 检测和强制清理逻辑 |
| P1-07 | **模型名大小写不一致** | catalog 查找大小写敏感导致 metadata 缺失 | 活跃 | 统一使用小写 `gpt-oss-20b-mxfp4-q8` |

---

## P2 — 影响可维护性与安全

| # | 缺陷/不足 | 影响 | 状态 | 修复方向 |
|---|-----------|------|------|----------|
| P2-01 | **Control API 完全无认证** | 任何人可启停 Hermes、切换模型 | 活跃 | 添加 `X-API-Key` 中间件，至少限制 localhost 暴露 |
| P2-02 | **OMLX API key 硬编码 fallback** | `LOCALOXML_API_KEY` 未设置时回退到 `'omlx123'` | 活跃 | 移除 fallback，强制从 env 读取 |
| P2-03 | **`.env.example` 严重过时** | 新部署不知道新 env var 存在 | 活跃 | 补全 `COMFYUI_ROOT`、`HERMES_MODEL_TASK_MAX_CALLS_PER_SESSION` 等 |
| P2-04 | **Reasoning session 文件永久累积** | `state/agent-runtime-sessions/` 无限增长 | 活跃 | 添加定期清理（保留最近 N 天），或按 session 完成时间归档 |
| P2-05 | **Chat history JSON 无上限** | `readStoredHermesChatHistory` 读取文件越来越大 | 活跃 | 添加最大 entry 数限制 |

---

## 未实现功能清单

以下不是缺陷，而是尚未进入生产级实现的能力缺口：

| # | 能力 | 当前状态 | 预期实现方式 |
|---|------|----------|--------------|
| U-01 | 完整任务状态机和阶段机 | 未实现 | 定义 session 生命周期状态（queued → running → pausing → paused → resuming → completed/failed/cancelled）|
| U-02 | 跨重启 checkpoint 恢复 | 未实现 | 定期持久化 session 状态，重启后扫描 orphan session 并收敛 |
| U-03 | 批量任务队列、暂停、取消、续跑 | 未实现 | 建立任务队列服务，支持 per-project workflow 的批量调度 |
| U-04 | `_inbox` proposal 自动化测试与晋级 | 未实现 | proposal 必须经自动化测试、可视化审批后才可晋级为 active intent/workflow |
| U-05 | 完整图片资产闭环 | 前置门禁已具备，后续未实现 | Story Bible → asset plan → 串行生成 → 落盘 → 引用回填 → 校验 → 重新导出 |
| U-06 | 生产运维 UI：一键取消/恢复 | 未实现 | Control Console 增加"取消当前 session"、"停止 production test"、"恢复异常任务"按钮 |
| U-07 | 动态模型切换 UI 配置入口 | 后端已部分支持，UI 未开放 | Control Console 增加 `workflow.modelRouting` 配置面板 |
| U-08 | 安全自我强化闭环 | 未实现 | `_inbox` 的审核、测试、晋级、回滚和可视化审批流程 |
| U-09 | Hermes Gateway 崩溃自动重启 | 无感知，下次状态检查才发现 | 注册 `child.on('exit')` 自动重启逻辑 |

---

## 已修复归档（不删除，只用于追溯）

| # | 缺陷 | 修复时间 | 修复内容 |
|---|------|----------|----------|
| F-01 | `productionTest` 不 bypass story mutation review | 2026-05-18 | `productionTest` 现在 bypass plan review、step review、write/edit review、quality gate |
| F-02 | OMLX `response_format: json_schema` 空输出 | 2026-05-18 | fallback 到 `chat/completions` + schema 嵌入 prompt |
| F-03 | Story Bible JSON 截断 | 2026-05-18 | `max_tokens` 提升到 8192 |
| F-04 | `createStoryBible` timeout 过短 | 2026-05-18 | plan 中 timeout 提升到 300s |
| F-05 | `generateScriptsCandidate` maxTokens 过小 | 2026-05-18 | `maxTokens` 从 1600 提升到 8192 |
| F-06 | Story Bible 未持久化 | 2026-05-18 | `POST /api/projects/:id/ai/story/bible` 写入 `project.state.aiBackground.storyBible` |
| F-07 | P0 workflow 缺少 `story_create_bible` 步骤 | 2026-05-18 | `appendFullP0Steps` 添加 `story_create_bible` 步骤 |
| F-08 | `wantsCreate` 正则未匹配"产出" | 2026-05-18 | 正则添加 `产出` 匹配 |

---

> 本文最后更新：2026-05-18
