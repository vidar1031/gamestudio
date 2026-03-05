# P1 设计基线（2026Q1）

本文是 P1 阶段统一入口，目标是把“可用”升级为“可维护、可扩展、可验证”。

## 1. P1 目标

1. 工程化：建立稳定 schema、配置、日志、测试体系。  
2. 稳定性：跨 Provider 的错误可恢复、可观测、可追踪。  
3. 可扩展：为后续 Agent/Skill、LoRA 生效、工作流模板化预留规范接口。  

## 2. 非目标（P1 不做）

- 不做全新编辑器重构（保持现有交互骨架）。
- 不做多引擎运行时切换（仍以 Pixi 运行链路为主）。
- 不做复杂权限系统与多租户。

## 3. P1 分阶段里程碑

## M1（基础治理）
- `project.state.aiBackground` 文档化 + schema 化 + migration。
- 统一错误码与日志字段（provider/model/stage/traceId/durationMs）。
- 为关键链路补充最小回归测试（文本生成、提示词生成、单图、批量图）。

## M2（稳定生产）
- 批量任务队列化（提示词/出图），支持暂停、取消、续跑。
- 全链路超时策略统一（文本与图像分开策略，支持 `none` 模式）。
- Provider 健康检查标准化（连通性 vs 深度可用）。

## M3（可扩展能力）
- ComfyUI LoRA 生效（从“预留配置”升级为可执行参数）。
- 工作流模板化（按风格/分辨率/模型维度可切换）。
- Agent/Skill 接口层（先约束契约，再逐步接入）。

## 4. 关键技术策略

### 4.1 状态结构
- 统一放在：`project.state.aiBackground`
- 子块拆分：
  - `global`：全局正负与元信息
  - `storyboardScenes`：按 `nodeId` 存场景提示词
  - `storyboardBatchDraft`：批量参数草稿
  - `storyboardPromptMeta`：最近一轮提示词生成参数快照

### 4.2 错误分层
- `user_error`：输入缺失/配置错误（可直接提示用户）
- `provider_error`：上游模型/接口异常
- `system_error`：本地代码、存储、解析异常

### 4.3 任务语义
- `generate_prompts` 与 `apply_images` 作为两个独立任务阶段。
- 每阶段都必须支持：
  - 局部失败不中断
  - 继续未完成
  - 重试失败项

## 5. P1 交付物清单

1. 文档：
   - `P0_REVIEW_2026Q1.md`（现状）
   - `DESIGN_P1.md`（本文件）
   - `P1_COMMENTING_GUIDE.md`（注释与说明规范）
2. 代码：
   - 状态 schema/迁移
   - 错误码常量
   - 任务执行器（含续跑）
3. 验证：
   - 最小自动化测试
   - 人工回归清单（Provider 组合矩阵）

## 6. 当前落地进展（2026-03-03）

已完成（M1）：
- `project.state.aiBackground` 标准结构与 migration（global/storyboardScenes/storyboardBatchDraft/storyboardPromptMeta）。
- 项目读写链路接入 migration（editor API + server 读写兜底）。
- 提示词与出图关键链路引入统一 traceId + 结构化日志字段（stage/project/provider/model/durationMs/err）。
- 统一错误分类（user/provider/system）并返回稳定错误码。
- 新增最小回归脚本：
  - `apps/server/scripts/test_p1_state_migration.mjs`
  - `apps/server/scripts/test_p1_ai_error_classify.mjs`

进行中（M2）：
- 分镜批量任务执行器增加“暂停/继续/取消”门控（提示词与出图两阶段一致语义）。
- 继续未完成/重试失败与门控可组合使用（先取消再点“继续未完成”恢复推进）。
