# Hermes 能力审查与定位评估（2026-07-23）

> 状态：**方向已确认（2026-07-23）**：Hermes 定位为**常驻智能助手层**（24/7 daemon），从生产链的"模型代理"角色退役；治理中台（现 control-console）为其治理端。
> 本文基于 2026-07-23 两轮全量代码审查（control-server + hermes-agent gateway 接口层 + 配置与运行状态）。
> 关联：`docs/HERMES_CAPABILITY_GAP_ANALYSIS.md`、`docs/PRODUCTION_DEFECTS.md`。

## 战略定位（2026-07-23 与需求方确认）

**目标关系**：Hermes = 本地智能常驻助手（24/7 守护，可配置任意项目、执行适合的工作流）；治理中台 = 治理 Hermes 的站点（让它不黑盒、可管理、可审核）；GameStudio = 助手驱动的第一个实测项目，不是全部。

**历史偏差**：建设过程中关系被跑反——Control 变成了编排司机，Hermes 退化为生产链里的模型转发代理（本审查发现其边际价值≈0 的原因）。正确关系是：**Hermes 作为常驻助手编排"何时做、为什么做、做完汇报"；Control+GameStudio 作为被调用的确定性能力 API（做得对、留证据、可审核）**。

**目标三层架构**：

```
常驻助手层（Hermes daemon）：cron 定时 / 子 agent（监察、plan 执行）/ 多渠道 / 技能与记忆
  —— agent loop 与子 agent 由右脑强模型驱动（本地 9B 跑 loop 已被日志实证不可靠）
治理层（现 control-server + 治理中台站点）：项目/工作流注册表、review gate、evaluator、
  证据、审核记录；助手的写入/执行动作全部过门禁（"全部要记录审核"）
能力层（GameStudio Server 等）：故事生产 API（已验证）/ 图片生成 API / 未来其他项目能力
```

**关键事实**：Hermes 的 cron（`~/.hermes/cron/jobs.json`，daily-reporter 每日真实执行）、子代理（delegate_task）、多渠道 gateway、技能/记忆体系均为现成能力——自研同等 agent 运行时不划算；当前集成的问题是把它们闲置、只用作转发壳。

## 〇、全库性误述纠正

配置/文档/状态文件长期声称"评审/生成经 Hermes"，真相：路由 `story_blueprint_review` 声明 hermes+strict，但运行时 `normalizeModelRouteEntry`（`apps/control-server/src/server/controlServerCore.js:1701-1705`）因路由模型与绑定模型不一致**静默降级为 direct 直连**。2026-07-22 e2e 的蓝图评审实际是 direct gpt-oss-20b（8 秒，usage 带 OMLX 原生字段）。**strict 路由形同虚设，"经 Hermes"表述与实际数据平面脱节。**

## 一、审查结论（三子系统）

### 1. 记忆系统：名不副实，含致命缺陷

- 全部记忆语义由 Control 实现（文件截断注入、24/8 重放窗口、chat 历史持久化、记忆写入+review gate、TTL 归档）。Hermes gateway 为 stateless 设计，Control 从不传 `X-Hermes-Session-*` 头；Hermes 原生记忆子系统从未接入。
- 【致命】启动注入的 13 个 `GAMESTUDIO_*` env，Hermes 全库零读取（仅 `HERMES_EPHEMERAL_SYSTEM_PROMPT` 被消费）。
- 【致命】`ai/memory/DECISIONS.md`、`LONG_TASKS.md` 自 2026-06-18 起内容是"请刷新本文件"的指令文本而非记忆（fallback 落盘 bug），且每日被全量注入 planner prompt——注入垃圾，起反作用。
- 【高】planner 全量注入 vs answer 路径 references-only 只给路径（且走 direct 无人读）——同 session 策略自相矛盾；跨 session 重放污染；每日 00:00 短期记忆清零；context-pool 与 session 索引只写不读；Hermes cron 每日向已弃用的 `memory/` 根目录写文件（Control 无感知、无审核）。

### 2. 技能系统：100% Control 自导自演

唯一 SKILL.md（12 条关键词→动作映射）由 Control 自解析、自用（兜底 plan + prompt 提示）；Hermes 侧零消费。内置规则表 `REASONING_INTENT_RULES = []` 已清空。MCP 为纯 stub 却注册 `mcp_call` action（调用必失败）。

### 3. Agent 能力：Hermes 不可替代部分 = 零

以真实 e2e（reasoning_1784725013297）为准：分类（Control 规则表）、plan（Control 确定性 13 步）、执行（Control→GameStudio Server）、脚本/Bible（GameStudio Server 直连 OMLX）、评审（Control 确定性 + GameStudio 规则 + direct 模型三方取 min）、evaluator/证据/审核（Control）。链路中无任何环节必须经 Hermes。

## 二、优势 vs 坏处

**继续使用的优势（真实但全部可替代）**：5 类后台文本调用的传输层（`requestHermesChatCompletion` 原生支持 direct，改一行路由即可平移）；ephemeral system prompt 注入（文本本由 Control 拼）；Telegram 入口（与本项目无关）。

**坏处（实打实成本）**：
- Python venv + gateway 进程的 spawn/监控/恢复全套负担；一次未定位原因的 SIGTERM 事故；33% 重启孤儿会话（P1-11）；61.8h 悬挂会话（P1-08）
- agent loop 失控风险：走 hermes 的请求进入最多 90 轮迭代，gateway 日志实证本地 9B 模型连败工具调用循环 5-6 次
- supervision 30 分钟定时器空转：已产生 75 个自动 session，meta_analysis 持续 401 退避重试（Kimi key 失效，待用户提供新 key）
- 对 `HERMES_HOME/.env`、`config.yaml` 的写入污染；长期"经 Hermes"认知误导

**结论：当前集成状态下，Hermes 边际价值 ≈ 0，边际成本 > 0。**（这是对当前集成的评估，非对 Hermes 框架本身的评估——其工具生态约 95% 未启用。）

## 三、决策（2026-07-23 已确认）

**决议：从生产链退役 Hermes 的"模型代理"角色；在助手层启用 Hermes 原生能力。**

补充决议：治理中台站点（现 control-console）更名为**「守护台」**——定位为全天守护助手的治理台。改名分两阶段：UI 层（品牌、标题、导航）已执行；包名/目录名（control-console/control-server）为第二阶段工程改动。信息架构后续按"与助手对话 / 助手的日程 / 助手的项目 / 审核中心 / 助手的健康"心智重排。

- 生产链（分类→plan→执行→生成→评审→校验→导出）保持 Control + GameStudio Server 的确定性实现不变（e2e 已验证可靠）。
- 助手层启用 Hermes 现成能力：cron 定时（每日自动建故事/定时关停系统）、子 agent（监察、plan 执行——必须挂右脑强模型）、多渠道 gateway、技能/记忆体系。
- 原"选项 B（保留但收缩）"与"选项 C（无边界启用）"均否决：前者治标不治本，后者与治理方向冲突；采用"C 的边界内版本"——助手层原生能力开启，但写入/执行动作仍全部过治理层 review gate 并落审核记录。
- 集成关系翻转：由"Control spawn Hermes 当模型代理"改为"Hermes 常驻，治理层/能力层作为其可调用的 API"。

## 四、附：审查中确认的可立即修复项（与定位调整无关）

1. `ai/memory/DECISIONS.md`、`LONG_TASKS.md` 内容是指令垃圾，需清空重建；fallback 落盘不得写入指令文本（`reasoning/memory.js:124-166` 根因）。
2. supervision 定时器在 meta_analysis 401 修复前应关停（每 30 分钟空转烧钱）。
3. 聊天页（`#/chat`）在人工全审模式下点击发送会打开"提交前确认"弹窗（`openSubmitGate`），新页面未渲染该弹窗导致提交无反应（已修复：改为居中模态遮罩，支持确认/返回/拒绝/生成预览）。
4. `restart_server.sh` 相对路径 bug；`story_scripts_candidate` 死路由配置残留（已修复：从默认路由、`manager.left-brain.json` 和 `strictRouteRequiredPhases` 中移除）。

---

> 审查方式说明：两轮全量只读审查（记忆系统、技能与 agent 能力），证据均附文件路径与行号；gateway 侧仅读接口层与运行日志，未深入 AIAgent 内部；meta_analysis 401 根因（key 失效 vs 端点变更）未向第三方验证。
