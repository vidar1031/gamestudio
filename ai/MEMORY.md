# MEMORY - GameStudio Project Memory

## 项目使命

让 `control + hermes` 成为 GameStudio 的统一任务控制面，能够围绕故事项目执行完整链路：

项目创建 -> 项目配置 -> 故事/脚本生成 -> 图片与资产生成 -> 项目验证 -> 导出交付

## 权威事实

- 前端编辑器目录：`apps/editor`
- 业务后端目录：`apps/server`
- 控制台前端目录：`apps/control-console`
- 控制台后端目录：`apps/control-server`
- 项目创建目录：`storage/projects`
- demo 素材目录：`storage/demo_library`
- 若配置 `STUDIO_STORAGE_ROOT`，则以外部 storage 根目录为准

## 当前工作方式

- 普通聊天用于短问题和直接执行。
- reasoning / 可观测执行用于多步骤长任务。
- 对项目扫描类任务，必须显式返回扫描目录、缺失目录和证据不足原因。
- 长任务方向详见 `ai/memory/LONG_TASKS.md`。
- 当前短任务队列详见 `ai/memory/TASK_QUEUE.md`。

## 长任务主线

1. 建立 control 驱动的故事项目创建流程。
2. 建立项目配置与模板装配流程。
3. 建立故事脚本、蓝图与场景规划生成流程。
4. 建立图片与资产生成、入库、回填流程。
5. 建立项目验证、导出与交付流程。

## 当前重点

- 里程碑 commit `0331a91` 已提交：control 基石（执行引擎/守护/治理闭环/cron/右脑监察/多项目隔离配额/proposal 治理/注册表）+ 生产链（图片三级审核门禁/分层合成/完整度核实/资源互斥调度/strict 路由显式失败/有界记忆注入/事件层与项目绑定/一键启动自愈）。里程碑回归基线 393/393 全绿，里程碑后增量 406 全绿。
- 当前主线：内容质量闭环——按 `docs/狼来了内容质量闭环工作流.md` 跑通「生成 → 完整度核实 → 定向修复 → 再核实」直到通过；现行全链路 22 步（P0 文本 12 步 + P1 分层合成 6 步 + 记忆同步×3 + 最终回答）。
- 里程碑后已落地：守护台「项目事件」页卡片化、技能治理首轮评估激活 6 个技能、问句形态优先分类（R013，咨询问句不再误入生产）、滚动压缩探索回答（exploreAnswer）、一键启动自愈。
- 记忆维护纪律不变：状态变化后同步 `STATUS.md` / `TASK_QUEUE.md` / `DECISIONS.md`，必要时补 `LONG_TASKS.md`；当日日志由系统自动写 `ai/memory/daily/`，禁止手工创建日期日志。
