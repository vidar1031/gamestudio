# GameStudio 文档目录

`docs/` 当前按「治理 / 生产方案 / 操作手册 / 评估与提案 / 归档区」组织，真实结构如下。

## 治理

| 文档 | 用途 | 面向读者 |
|------|------|----------|
| [`PROJECT_GOVERNANCE.md`](PROJECT_GOVERNANCE.md) | 全系统最高治理规则：文档层级、记忆管理、禁止行为、违规处理 | 所有 Agent、开发者、维护者 |

## 生产方案

| 文档 | 用途 | 面向读者 |
|------|------|----------|
| [`系统生产级推进方案.md`](系统生产级推进方案.md) | 系统分工（明确行为边界）、启动流程、生产任务流、路由规则、UI 约束、放行标准、关键文件索引 | 开发者、维护者 |
| [`PRODUCTION_DEFECTS.md`](PRODUCTION_DEFECTS.md) | 当前生产缺陷（P0/P1/P2）、未实现功能清单、已修复归档 | 开发者、维护者 |

## 操作手册

| 文档 | 用途 | 面向读者 |
|------|------|----------|
| [`狼来了内容质量闭环工作流.md`](狼来了内容质量闭环工作流.md) | 现行生产主手册：从守护台聊天发起故事生产，跑通「生成 → 完整度核实 → 定向修复 → 再核实」闭环（全链路 22 步） | 操作者、测试人员 |
| [`Control + GameStudio 生产工作流联调测试说明.md`](Control%20+%20GameStudio%20生产工作流联调测试说明.md) | 联调测试标准、阶段定义、验证检查清单、放行判断 | 测试人员、开发者 |

## 评估与提案

| 文档 | 用途 | 面向读者 |
|------|------|----------|
| [`HERMES_EVALUATION_2026-07-23.md`](HERMES_EVALUATION_2026-07-23.md) | Hermes 接入评估记录（一次性评估，留存追溯） | 维护者 |
| [`UI_REDESIGN_PROPOSAL.md`](UI_REDESIGN_PROPOSAL.md) | Editor 流水线工作台 + 守护台三区工作台设计提案（实施状态见文档头） | 开发者 |
| [`本地智能体项目执行实施方案.md`](本地智能体项目执行实施方案.md) | 本地智能体项目执行实施方案：能力声明驱动编排、受控执行状态机、多轮优化闭环 | 开发者、维护者 |

## 归档区（`archive/`）

完成态计划与历史分析档案，只用于追溯，不作为当前状态依据：

- `agent-automation-playbook/` — 自动化 playbook 系列
- KIMI 四件套：`KIMI_RIGHT_BRAIN_SUPERVISION_PLAN.md`、`KIMI_RIGHT_BRAIN_TEST_PLAN.md`、`KIMI_RIGHT_BRAIN_FEASIBILITY_ANALYSIS.md`、`KIMI_INTEGRATION_IMPLEMENTATION_PLAN.md`（右脑监察已落地，见 `ai/BRAIN_DIVISION.md` 与 `ai/control_architecture.md`）
- `ARCHITECTURE_CORRECTION.md`、`HERMES_CAPABILITY_GAP_ANALYSIS.md`、`HERMES_RUNTIME_AND_CONTROL_INTERACTION.md`、`GameStudio 自动启动与自动测试机制分析.md`、`PRODUCTION_TEST_EXECUTION_PLAN.md`

## 阅读顺序

1. **新加入的 Agent** → 先读 `PROJECT_GOVERNANCE.md`，了解什么能做、什么不能做。
2. **要启动或调试系统** → 读 `系统生产级推进方案.md` 的"启动流程"和"系统分工"章节。
3. **要跑生产** → 读 `狼来了内容质量闭环工作流.md`。
4. **要执行联调测试** → 读 `Control + GameStudio 生产工作流联调测试说明.md`，按验证检查清单执行。
5. **要修复缺陷或推进功能** → 读 `PRODUCTION_DEFECTS.md`，确认缺陷状态和修复方向。

## 已合并/删除的旧文档

以下文档的内容已合并到核心文档中，原文件已删除：

- ~~`CONTROL_SYSTEM.md`~~ → 合并到 `系统生产级推进方案.md`（模块结构、核心链路、路由规则）和 `PROJECT_GOVERNANCE.md`（安全边界、记忆规则）
- ~~`CONTROL_TO_GAMESTUDIO_CHAIN.md`~~ → 合并到 `系统生产级推进方案.md`（启动流程、通信契约、错误处理、关键文件索引）和 `Control + GameStudio 生产工作流联调测试说明.md`（验证检查清单）和 `PRODUCTION_DEFECTS.md`（缺陷清单）
- ~~`PRODUCT_AND_STORY_WORKFLOW.md`~~ → 合并到 `系统生产级推进方案.md`（产品定位、项目结构、三层故事工作流）
- ~~`Control Console 使用说明.md`~~ → 合并到 `系统生产级推进方案.md`（指令分类、productionTest 模式、设计原则）
- ~~`UI_SELF_CONSTRAINTS.md`~~ → 合并到 `系统生产级推进方案.md`（UI 约束章节）
