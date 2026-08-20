# DECISIONS.md — 生效中的规则与取舍

> 本文件只记录已验证的稳定决策，由人工或经审核的流程更新。上次重建：2026-07-23（此前内容误写为刷新指令，已清理）。

## 架构定位（2026-07-23 确认）
- Hermes = 本地智能常驻助手（24/7 daemon），GameStudio 是其第一个实测项目。
- 治理中台 = 「守护台」（原 control-console，UI 层已改名），负责让助手不黑盒、可管理、可审核。
- 生产链（分类→plan→执行→生成→评审→导出）保持 Control + GameStudio Server 确定性实现；Hermes 从"模型代理"角色退役，在助手层启用 cron/子 agent/多渠道等原生能力。

## 生产纪律（2026-07-22 起生效）
- 模型输出只能是候选；脚本生成/蓝图评审失败必须显式失败，禁止确定性兜底冒充成功（F-12/F-13）。
- 生产代码不得包含测试用例关键词与回答关键词填充（F-11）。
- 写入/删除/导出/脚本动作全部过 review gate 并落审核记录；密钥只存 `.env`（`MOONSHOT_API_KEY`），不进 git。

## 模型路由（当前生效）
- 左脑绑定模型：Qwen3.6-27B-MLX-4bit（OMLX，direct 路由）。2026-08-19 由 gpt-oss-20b-MXFP4-Q8 切换：gpt-oss 会被 OMLX 自动拉起占内存、且对话与指令遵守能力不足，27B 在 32G 机器上可运行并与资源互斥调度（AUTO-R01）配合；此前 2026-07-23 由 Qwen3.5-9B 切换（9B 对话能力不足）。右脑固定 moonshot/kimi-for-coding。
- strict 路由语义（2026-08-18 修正）：hermes+strict 路由与左脑绑定不一致时**显式失败**（`route_unavailable:strict_route_model_mismatch:*`，经 C02 收敛 blocked 等人工修配置），不再静默降级 direct；strict 可满足时正常走 hermes；非 strict 不一致保持 best-effort 直连但以 `degradedFrom` 留痕；不可满足状态在 buildConfigValidation 自检项与 workflow-diagnostics `modelRouting.strictRoutes` 可见。原"静默降级"登记作废。

## 记忆注入（2026-08-18 修正）
- `workflow.memoryOverlayMode` 默认 `content-injection`：回答阶段把核心记忆文件正文**有界**注入系统消息（每文件 `HERMES_MEMORY_OVERLAY_FILE_CHAR_LIMIT` 默认 3000、总量 `HERMES_MEMORY_OVERLAY_TOTAL_CHAR_LIMIT` 默认 12000，超限截尾标注；AGENTS.md 默认不注入正文仅列引用，`HERMES_MEMORY_OVERLAY_AGENT_DEFINITION_CHAR_LIMIT` 可开极低上限；空/缺失文件跳过）。
- `references-only` 保留为可选项；其文案已修正为"正文未注入、不要读文件、不要编造"，不再宣称路径是 authoritative 内容（原 references-only 让 gpt-oss 误以为要先读文件而读不到，输出停在思考通道正文为空，且回答缺记忆事实而编造——该模式名存实亡的问题由此了结）。

## 咨询问句分类取舍（2026-08-19，用户明确指令）
- **问句形态优先于关键词强制**：命中「吗/呢/么 结尾或带问号、能不能/能否/可以…吗/会不会/是不是/是什么/为什么/如何/先回答/先告诉我」等咨询形态的输入，即使含「创建/生成 + 故事」等生产关键词，也先走 `answer_only`（滚动压缩探索路径）回答，**不触发 story/bootstrap 工作流**；祈使句（创建/生成/开始/执行…）维持 `ai/AGENTS.md` 硬性生产规则第 2 条的强制工作流不变。
- 背景：「可以使用gamestudio创建故事《乌鸦喝水》吗？先回答我？」曾被关键词强制进生产工作流而真建项目，咨询被误伤；本取舍是对硬性规则第 2 条的显式收窄（仅限问句形态），实现于 `requestClassificationRules.js`（R013_consultative_question_form）。
- 配套：answer_only 咨询回答改为滚动压缩探索（分块提取→水位压缩→综合→切题自检，见 `reasoning/exploreAnswer.js`），预算 env：`HERMES_EXPLORE_CONTEXT_BUDGET`（默认 16000）/ `HERMES_EXPLORE_CHUNK_CHARS`（默认 6000）/ `HERMES_EXPLORE_NOTES_CHAR_LIMIT`（默认 4000）；模型调用失败显式失败（exploreFailure），不伪造；生产测试（productionTest）与 requireModelAnswer 硬门禁保持单跳路径不变。
