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

## 运行时能力基准（2026-08-24，用户明确指令）
- **32G 硬约束写死**：模型（权重+KV cache）≤23–25GB；上下文硬顶 16384 tokens（16K），任何链路不得超出；OMLX 加载上下文必须设 16384；出图与推理沿用 AUTO-R01 内存互斥。
- **运行时记忆超短化**：聊天回放 ≤6 条（3 对）、推理链回放 ≤4 条、输出 ≤4096 tokens、压缩阈值 75%（≈12288）；**长记忆全部外部化**（`ai/chat/` 落盘、`ai/memory/*.md`、session-search FTS5、`state/` 证据、`storage/projects/` 真相源），模型上下文内不得依赖长记忆，需要历史事实必须先检索外部存储。
- **稳定性优先**：慢可以（500s 超时不改）；断/崩不行——失败必须显式 failed/blocked 带错误消息，禁止静默吞错、禁止空回答标完成、禁止前置可阻断的内存风险操作跑到崩溃。
- 权威基准文件：`docs/运行时能力测试基准.md`（含 A–E 组测试通过标准与差距清单）。control 侧落地：`shortTerm.maxContextTokens/maxOutputTokens` 经 `applyRuntimeTokenBudget` 钳制 binding 元数据；replay 窗口默认值 24/8 → 6/4。
- 遗留差距：hermes-agent `MINIMUM_CONTEXT_LENGTH=64000` 地板（`agent_init.py:1525`）需仓库外改为可配置并设 16384，且 `config.yaml` 设 `model.context_length: 16384`（待用户处置）；agent-stream 咨询路径外部记忆检索接入、gateway 错误显式透传（空答不再标完成）为 control 待建设项。

## 8K 测试期收口（2026-08-24，用户明确指令）
- **测试期上下文预算 8192（8K）**，16K 降为机器绝对硬顶（后续阶段经用户确认再升）：control `shortTerm.maxContextTokens=8192 / maxOutputTokens=2048`；control 记忆注入配额 1500/4500 字符；gateway `context_file_max_chars=800`。
- **滚动式压缩流**：`compressChatMessages` 由"丢最旧"升级为滚动压缩摘要（有界 12 行/1200 字符摘要驻留系统消息，确定性、无额外模型调用）；agent-stream 咨询路径新增外部记忆有界注入（聊天落盘最近 ≤4 对 × 140 字）。
- **失败显式化**：phasedAgentStream 按 gateway 真实 SSE schema（`assistant.delta`/`assistant.completed`/`error`）解析，流内错误与空回答一律显式失败（session failed + error 事件），禁止静默吞错。
- **gateway 8K 放行**：hermes-agent `MINIMUM_CONTEXT_LENGTH` 改为读 `HERMES_MINIMUM_CONTEXT_LENGTH` env（control 启动 gateway 时按预算下发 8192）；hermes `config.yaml` 裁剪：`platform_toolsets.api_server` 仅留 memory+session_search、关 `environment_probe`/`task_completion_guidance`——单轮 prefill 6,535→2,751 tokens。
- **当前唯一阻塞（用户侧）**：OMLX prefill 内存顶——权重 17.44GB + KV+SDPA 固定预留 ~5.5GB ≈ 23.1GB > Metal cap 22.99GB。三选一：`sudo sysctl iogpu.wired_limit_mb=26624`（推荐）/ oMLX Memory Guard=aggressive / OMLX 加载上下文降 4096（仅兜底）。解除后即可按基准跑 A–E 组。
- 兜底选项：如需在无 sudo 情况下先测链路，可把绑定模型临时切 Qwen3.5-9B-MLX-4bit（权重 ~5-6GB 必然放得下），测完切回 27B；9B 对话能力弱（2026-08-19 已记录），答案质量不按 27B 标准评判。

## 多轮长聊不崩垮机制（2026-08-24，用户明确指令"一定要把这个问题解决"）
- **根因修复（"卡了一年"的真凶）**：reasoning 链的记忆同步步骤（模型重写 STATUS/TASK_QUEUE）此前**插在回答之前**且失败即整 session 失败——泛词误触发（"运行"命中闭环正则）+ 模型重写挂起 510s（`write_memory_file_rewrite_model_failed: model_task_timeout`），用户连回答都拿不到。修复：①同步步骤移到回答之后并标记 `bestEffort`——超时/失败只留 `step_skipped_best_effort` 证据事件，session 以回答正常完成；②闭环触发正则收窄（移除 运行/执行/生成/创建 等泛词，真实变更流仍由 hasMutatingWork 覆盖）。
- **对话水位管理（ChatGPT 式，用户点名机制）**：`GET chat-history` 返回 `waterLevel`（条数/对数/估算 tokens/预算/比例/ok·warn·high）；`POST chat-history/compact` 需用户确认：`compress`=最早若干轮压成一对有界摘要（12 行/1200 字封顶，保留最近 4 轮原文），`clear`=归档 `ai/chat/archive/` 后清空重开。console 聊天页在水位 warn/high 时出横幅，明示"丢弃什么、保留什么、话题方向不变"。
- 语义：注入已有界（回放 ≤6 条/咨询 ≤4 对），水位是防"无限制累积"的用户可见管理层而非硬闸——结构上支持无限制持续交互。

## 咨询查证能力回归（2026-08-25，用户实测发现"没有读取能力"）
- **根因**：8K 省内存把 gateway `platform_toolsets.api_server` 裁到 memory+session_search，咨询系统提示却仍承诺 read_file/search_files 等工具——指令与工具面脱节，模型如实回答"没有文件读取工具"，只能基于注入记忆作答（灰姑娘等旧记录由此混入）。
- **修复架构**：恢复 file toolset 会连带 write_file/patch 写能力、绕过审核门禁，故不恢复；改为 **control 侧只读查证执行器**（`phasedAgentStream.js`）：规划阶段模型输出工具 JSON（截断 JSON 自动补闭合修复）→ control 在工作区内真实执行 `read_file`/`list_directory`/`search_files`（越界 `path_out_of_workspace`、非白名单 `tool_not_allowed` 硬拒绝）→ 结果存 `state/tool-results/` → 有界压缩（1500/4000 字符）→ 回答阶段禁止输出工具 JSON（伪迹剥离，剥空则显式失败）。
- **配套收紧**：未提限机器 prefill 安全顶 ~4.5K tokens——咨询出站预算守卫（超 2600 字符先丢记忆块再硬截断）；外部记忆注入收紧到 ≤2 对 × 100 字符。
- 实测证据：规划→查证（search_files 命中 4 处）→压缩→回答 全链通过；单测覆盖越界/写操作拒绝、伪解析不炸。
- **二轮实测追加（指代+内容查证）**：发现"自我设防回答回灌"问题——上一轮"没有读取工具"的误答经记忆块注入会自我强化；修复：能力免责声明类回答不进回放（`CAPABILITY_DISCLAIMER_PATTERN` 过滤）；规划提示补指代解析（它/该/这个→结合项目库实况解析完整路径）与"内容是什么"类必查证规则；项目库实况在项目 ≤5 个时给完整 uuid（供 read_file 直接定位）。实测："它的具体故事内容是什么"→ 模型主动 read_file → 读出《三只小猪》真实蓝图并正确汇报（与 blueprint.json 磁盘内容一致）。
- **读取不爆内存**：读取在 control 侧 fs 执行、结果有界压缩后才给模型；gateway 不加载工具 schema，prefill 不增长。之前裁工具面省的是"schema 进提示词"的内存，不是读取本身的内存。

## 写意图→可确认提案（2026-08-25，用户指令："主动弹出让我确认继续"）
- **问题**：咨询中提写请求（"能把故事重命名为《X》吗"），模型只能空说"请回复确认"，确认了也没人能执行——提案与执行脱节。
- **机制**：`agent-stream` 路由在分类后、模型调用前确定性识别写意图（首版覆盖"重命名项目"：意图正则 + 新名称引号提取 + 从当前问题与近 4 轮历史按 uuid/标题解析唯一目标项目），命中即返回 `action_proposal` JSON（eventId=project.update/GS-05、payload={projectId, project:{title}}、人话摘要），不调模型。
- **承接**：console `tryAgentStreamSubmission` 把提案落到**既有事件确认卡**（`eventConfirmPending`），用户「确认执行」→ `dispatchEventFromChat(confirmed:true)` → command 审核门 → GameStudio Server 执行 → 事件证据；「取消」则终止。目标/名称解析不唯一时不拦截，落回模型追问。
- **实测**：改名问题→提案正确（7c04ca64→三只小猪）；未确认 dispatch→`review_required` 拦截；已确认 dispatch→真实执行成功（用同标题幂等写入验证，未改用户数据）。
- **锁定/出图阶段聊天驱动（同日追加）**：阶段意图表 `PRODUCTION_STAGE_INTENTS`（顺序即优先级）：环境体检→`studio.selfcheck`（query 直发直答）、检查项目→`project.inspect`（query）、生成 Story Bible→`story.bible.generate`、主参考锁定→`asset.reference.lock`、生成参考图→`asset.reference.generate`、锁定测试→`asset.lock.test`、渲染缺失场景→`asset.scene.renderAll`（onlyMissing 断点续跑）。command 走确认卡门禁；query 由 console 直接 dispatch 并把结果卡读回聊天。改名 > 具体阶段 > 宽泛出图推进（资产计划）三级匹配顺序。
- **编辑器"点击无反应"根因**：①环境体检未通过（实测 ComfyUI 8188 不可达）→ 出图类按钮按门禁设计禁用；②`生成 Story Bible` 在"未打开有效项目"时静默 return 无反馈——已修为可见错误提示（ComposeStudio.tsx runStoryboardGenerateEntitySpec）。
- 语义边界：提案本身不是执行；只有用户点确认才写。后续可扩展更多写意图类型（当前仅重命名）。
- **生产推进提案（同日追加）**：识别"出场景图/渲染/补齐资产/继续生产"等推进意图（须含推进动词：生成/创建/开始/推进/继续/渲染/出图/补齐——纯分析类问法不拦截，落回咨询查证），产出 `asset.plan.create`（GS-18，P1 场景图生产链入口）提案，摘要写明后续链路（参考图锁定→场景渲染→校验导出，逐步审核）。实测：推进问法→提案正确解析到当前项目；分析问法→正常落链。另修：回答阶段剥离 hermes 原生 `<tool_call>` XML 伪迹（咨询路径无 shell 工具，泄漏即脏输出），规划/回答提示明确"不存在 shell/终端/写文件工具"。
- 注意：机器重启后 `iogpu.wired_limit_mb` 复位为 0 必须重跑提限 + `omlx-cli restart`，否则大 prompt 再被 prefill guard 拒（2026-08-25 晨实测复现）。

## 启动内存闸自愈（2026-08-25，用户指令：提限做进启动逻辑）
- `ensureOmlxPrefillHealthy` 嵌入 `startHermesRuntime`：①sysctl 检测，低于目标（默认 26624MB，env `HERMES_IOGPU_WIRED_LIMIT_MB` 可调）尝试 `sudo -n` 免密提限（需一次性安装 `scripts/utils/install_iogpu_sudoers.sh` 的 sudoers 规则，仅授权这一条 sysctl 命令）；②**~3K tokens 真实规模探测**（1-token ping 测不出闸——微型 prompt 不触发 OMLX 的闸值核算，教训已验证）；③prefill 被拒自动 `omlx-cli restart` 后复测一次；仍不健康则不启动 gateway 并返回明确指引（不启动死网关）。
- 关键事实：omlx-server 缓存**启动时**的 cap——sysctl 提限后必须重启 omlx 才生效；系统内存占用波动会让 27B/8K 恰好压在闸边（差 0.04GB 即拒），提限后约有 1.4GB 余量。

## 会话历史管理（2026-08-26，用户指令）
- **选型：文件，不上数据库**。每个会话一个文件 `ai/chat/sessions/<sessionId>.json`（{sessionId,title,createdAt,updatedAt,entries}），列表由扫描得出。理由：量级小（数十个）、人类可读可备份、与项目"文件即真相源"哲学一致；深度检索已有 Hermes 会话 FTS5（session-search）承担，不重复建库。量级上来后可再评估 SQLite。
- **语义**：`新建会话` = 归档当前（含跨天回填内容整体入档）+ 清空工作区 + 轮换 chatSessionId；`打开` = 当前非空先自动归档再写入目标会话内容继续；`删除` = 删文件。端点：`GET chat-sessions` / `POST chat-sessions/archive-current` / `POST chat-sessions/:id/open` / `DELETE chat-sessions/:id`。压缩/水位管理作用于当前工作文件（打开某会话后压缩即对该会话生效）。
- **ID 核验去重（用户指令"不能重复"）**：工作区跟踪来源会话文件 id（`activeChatSessionFileId`，打开时设置、归档后清除）；归档时——内容未变（同长度同内容）→ 不建档仅清空；已续聊（同前缀、条目变多）→ 更新原会话文件（同 id，不新建）；前缀不一致 → 才按新会话建档。实测：打开后点新建会话返回 `deduplicated: true`，不再产生重复记录。
- **跨天回填与显式清空的冲突解决**：今天文件**不存在**才回填近 3 天（200 条封顶）；文件存在但为空 = 用户显式归档/清空，尊重为空不回填。
- **配套修复**：console 增加 runtime 状态 5s 轮询（修"已启动但聊天页提示未启动"——此前 runtime 状态只在手动操作时更新，轮询不覆盖）。

## 出图生产链单链资源编排（2026-08-25，用户裁决）
- **模型纪律（用户明确）**：故事/任务全部用 27B；**不用 9B**（唯一例外：未来用户明确指定的自动化守护监听场景）、**不用云端 Kimi**。27B 本身没问题是调用形态问题。
- **资源串行单链**：LLM 段（bible/资产计划/提示词）与 GPU 段（参考图/锁定测试/渲染）永不共存——GPU 步骤 AUTO-R01 自动卸载 OMLX 模型、批次结束回载（既有）；LLM 段期间 ComfyUI 必须停止或空载（其 torch MPS 驻留可达 ~20GB）。生成期完成检查是确定性文件核查（不用模型），视觉评审走 Kimi 云端。
- **Story Bible 分块生成（核心修复）**：单发大 schema 调用的 prefill 工作区（~4.4GB）在 27B 权重+KV（~23GB）之上必撞 prefill 内存闸；`storyBible.js` 新增 `generateStoryBibleChunked`——全局锚定/角色/道具/地点/场景绑定 5 个独立小调用（每次 prefill ~1GB）+ 合并 + 轻量修复（只带草稿），localoxml 默认走分块、失败回退单发。配套：bible 输入瘦身（场景/脚本正文 ≤500 字符、brief ≤800）、超时信封放宽（server 单次 ≤600s、客户端 600s、步骤 900s）。
- 编辑器手动功能修复：bible/生成类按钮的静默守卫（无项目/忙碌）改为可见提示（ComposeStudio.tsx）；体检未通过的真因是 ComfyUI 不在线。

## 事实类问题误答根治（2026-08-25，"问爬山行、问 gamestudio 就错"）
- **根因分层**：①OMLX 内存闸期所有大 prompt 被 400（hermes_empty_answer，已自愈）；②咨询流（R013 问句优先接入）当时没有当前事实来源，模型改用 gateway 仅剩的工具 session_search 翻旧会话档案（灰姑娘历史记录）冒充现状，还如实报告"没有读取工具"；纯知识问答（爬山/健身）不受影响是因为不依赖项目事实。
- **验证手段沉淀**：诊断"系统提示是否送达"用唯一标记法（身份块埋 ZXQ9917 → 模型能报出 → 证明 ephemeral system_message 全链送达；hermes 仅在 ASCII codec 异常重试路径才剥离非 ASCII，正常路径原样追加）。
- **修复**：咨询流每轮注入「项目库实况」——control 从 `storage/projects` 磁盘直读项目目录 + 各 `project.json` 标题（≤10 个，读失败如实标注），并声明其优先级高于任何会话记录/记忆/session_search 结果；查询当前项目实况禁止再调 session_search。实测：同一问题由"仅 1 个灰姑娘"纠正为"4 个（狼来了/测试写盘/未命名×2）"，与磁盘一致。

## 人工特批越过 AI 评审（2026-08-30，用户明确指令）
- **主参考选定允许人工确认越过 S4-01 评审门禁**：AI 视觉评审只是候选意见，不再是设主参考的前置硬条件。编辑器候选图点击「设为主参考」被门禁拒绝时，先显示拒绝原因（顶部错误横幅常显，不再藏进折叠日志），用户确认后带 `manualOverride: true` 重试放行。
- **留痕**：特批写入的 lock_confirm 记录带 `params.manual_override=true` + 被越过的门禁 code/message + 原评审结论；服务端 `asset.reference.select` 落 `manual_override` 事件日志。control 自动化链路不带 manualOverride，仍被门禁拦截（自动化无特权）。
- 边界：文件真实性校验（存在/非空/有效图片/项目目录内）不受特批影响，仍然强制。

## 动作立绘生成配方（2026-09-01，7 轮 A/B 实测定论）
- **场景内角色动作立绘（透明 PNG 覆盖摆放）的定式**：指纹锚点置 prompt 最前 → 人类称谓去人类化（eldest brother/boy 等→对应动物 character）→ 中文动作词服务端先转英文 → 动作句补动物主语并加 `(…:1.25)` 权重。绿幕图 → 服务端 RMBG 抠图（`/ai/character/cutout`）→ 新建/覆盖摆放专属姿势资产。
- **IPAdapter 不用于动作立绘**（`STUDIO_SPRITE_IPADAPTER=on` 才开）：plus-face 人脸模型会把动物角色锚成人类；通用 plus 模型虽锁身份，但各权重（0.7–0.85）各区间（[0,1]/[0.25,0.9]）都会把主参考的站姿一并锚死，动作词全部失效。纯文本配方身份+动作双达标。
- **抠图一律服务端 RMBG，废弃前端 chroma key 主路**：模型给不出纯绿底（实测青/蓝绿/渐变底），按颜色抠图对撞色衣服必挖穿；RMBG 语义分割对任意底色均干净（角点采样作为无 ComfyUI 时的兜底保留）。
- **摆放姿势资产独立建档**：摆放与角色默认图/锁定主参考共享资产 id 时严禁原位覆盖（曾把猪老大主参考覆盖成废图）——只有摆放已持有独立姿势资产时才覆盖，否则一律 `createAsset`。
- **场景关键道具进背景失败时的正道**：稻草堆类道具被模型强关联成茅草屋顶（3 轮重渲实测）——关键道具应做成锁定透明道具摆放（拖入画布），而不是指望背景图画出来。

## 抽卡池与背身/道具有效配方（2026-09-01 补充）
- **动作立绘一律走抽卡池**（AiPoseSpritePoolModal）：单发模式废弃——生成 1/再出 4 → AI 评分（pose-review，姿势不同不扣分）→ 人工选定才抠图应用；候选持久化 `placement.poseCandidates`。
- **背身/回头姿势必须加权**：`(back view, view from behind, facing away from viewer:1.4)` + 具体动作；普通"背对镜头"中文措辞或平叙英文均会被模型正身先验压掉。
- **道具生成用 `kind:'prop'`**：角色版绿幕提示含 "single character or single animal / no props"，会把道具带成人类（实测 4 连）；道具版 "single object, no character" + 负向补死角色词。物体名加 `(…:1.3)` 权重更稳。
- **UI 探针铁律：选择器必须限定容器作用域**（弹窗内查找而非 document 全局）——全局 textarea 查找曾把姿势文本误写进场景正文与 timeline 动作（数据已恢复）。

## 出图能力统一归属锁定车间（2026-09-01，用户裁决）
- **所有出图的生成管理只有锁定向导一个家**：角色主参考/线稿/姿势变体/道具全在向导第 5 步管理（抽卡/评分/锁定/画廊/删除）；摆放属性卡是**纯消费端**——下拉只列已锁定姿势变体，「生成」类按钮一律跳转向导定位，不得在属性面板内建第二套生成管理（实测：能力分散两处 → 用户找不到图）。
- **姿势变体数据模型**：`plan asset.poseVariants=[{id,name,posePrompt,greenPath,cutoutPath,projectAssetId,projectAssetUri,score,reason,createdAt}]`，未锁定候选 `poseCandidates`；锁定动作 = RMBG 抠图 → 建 project asset（`AI 姿势 <资产名>·<姿势名>`）→ 写 plan 双写持久化；删除被摆放引用的变体必须阻断并提示。
- **IPAdapter 作为可调档位而非定死开关**：sprite 端点接受 `body.ipadapter={enabled,weight,startAt,endAt}`；默认关（锚死站姿的实测结论不变），用户可按角色效果在高级参数里 A/B。
- **旁路产物也要回到总账终态**：凡经目检选定投入使用的生成物（如道具模式产物），必须补登记 lock_confirm 批准记录留痕，否则出图总账永远到不了 100%。

## IPAdapter 主参考必须先合成白底（2026-09-01，实测破案）
- RMBG 透明底 cutout 直接喂 IPAdapter 会让 CLIP vision 编码失真、身份锚定完全失效（候选变人类、评分 5/100）；sprite 端点已内置"喂前一律 PIL 合成白底 + _flatwhite.png 缓存"。任何新增 IPAdapter 调用方必须走同一处理，不得直接传透明底 PNG。
- 姿势变体生成默认延续主参考（IPAdapter 默认开，0.8/0.2-0.9 折中档）：保姿势调低权重（0.7），保服装调高（0.9），取舍提示写在向导高级参数里。

## 剧情感知是提示词生成的硬上下文（2026-09-01，用户实测驱动）
- 姿势/场景类 AI 提示词生成**必须携带剧情正文**（关联场景下拉选择，默认第一个关联场景）：空上下文的"AI 生成"只会产出通用站桩词。生成指令必须显式要求"从剧情文本判断视角/动作/表情/手势，剧情有指向/注视/背负必须体现，禁止无依据正面站桩立绘"。
- 管理完备性对等原则：主参考有「管理图片」画廊，姿势变体必须有同款画廊（候选+已锁定两分组）——同一类资产的生成物只有一处管理界面，用户才找得到图。

## 姿势立绘提示词三不原则（2026-09-02，老二修正轮实测）
- **不写具体服装颜色**：每只猪的主参考配色不同（老大/老三蓝裤、老二白裤），写死颜色必然撞色被评审扣分——只写"与主参考一致"，颜色交给 IPAdapter 白底主参考携带。
- **不写场景道具词**（木柴堆/稻草堆/泥土地）：道具已在画布分层摆放，姿势词写了道具会被画成立绘背景，绿幕/RMBG 链就废了——朝向词（"侧头看右侧"）才是正确表达。
- **不写与剧情无关的泛化正面词**：剧情生成出正面站桩词时，用「组装」或配方改成背身再抽，不要直接跑。

## 故事工厂的一致性技术栈（2026-09-02，用户裁决定型）
- **不自训 LoRA**：本机 32G 训不动 SDXL LoRA；且故事工厂（成百上千故事）逐角色炼 LoRA 成本上完全不成立。
- **三层分工**：风格层=市场验证风格 LoRA（当前挂载 flat_childrenXX:0.7，CivitAI 9.3k 下载实测最高效）；角色层=IPAdapter 白底主参考（零训练）；解剖层=抽卡+评分门禁过滤，视图分库自举。
- **LoRA 选型方法**：CivitAI API 按 SDXL+用途检索按下载量排序（本地代理 7897 出站），挂载后用既有 Kimi 评分门禁 A/B 对比出分选型——不凭名气凭分数。
- CivitAI 部分资产作者限制登录下载（如 J_cartoon 12.4k 下载的第一名），无账号时顺移下一名。

## 分层合成工艺定型（2026-09-08，场景3/4 实测定论）
- **场景图一律分层合成**：背景只画环境（background-only，禁写房屋/角色/动物，显式 prompt 覆盖时不拼 worldAnchor），角色用姿势变体立绘、房屋/道具用透明立绘摆入。道具锚点必须从场景 promptAssets 剔除（否则模型把房子画进背景）。
- **分层场景标记**：`plan.scenes[].layeredComposition=true`——repairStoryAssetPlanSceneLinks 与渲染链路尊重该标记（promptAssets 只收角色；道具 sceneIds 仍记录供姿势场景选项）。
- **规格文件驱动**：`creation-buffer/sceneN_layered_spec.json`（background/poses/propSprites/placements）+ 守护台事件 `GS-44 asset.scene.layeredProduce` 触发；两阶段纪律：先生成→目检→再写摆位（占位符经摆位校验拦截）。

## 出图即压（2026-09-09，用户指令，强制规则）
- 生成图写盘时按用途分层压缩（`apps/server/src/ai/imageOptimize.js`）：立绘/cutout/主参考=无损 WebP（真相源零质量损失）；场景背景=JPEG q90；候选/绿幕/线稿/测试图=WebP q92。禁止再落未压缩大 PNG。
- 存量批压 `POST /api/projects/:id/assets/compress`（GS-45）幂等可复跑，同步改写 project.json/plan.json 引用。
- 导出包目标 ≤5MB：storyPixi 构建只收集 story.json 引用资产并压缩（背景 JPEG q82/立绘 WebP≤512px），不再整树复制。

## 视觉评审本地化（2026-09-08，Kimi 周配额耗尽倒逼）
- **默认本地**：姿势评审与完整度评审默认 `local_vl`/`omlx` + `gemma-4-26b-a4b-it-4bit`（经 OMLX，实测多模态可用）；Kimi 仅用户显式切回。评审输入降采样 ≤512px（防 prefill 护栏）。
- **视觉模型判定**：只认 VL 后缀/gemma-3/4/gpt-4o/claude/gemini/pixtral——Qwen3.6-27B 是纯文本模型（此前"名字含 qwen 即视觉"误判已修）。
- **调度器放行**：左脑配置 `visionModel` 字段为资源调度器外来模型守卫放行名单数据源；gemma 与 27B 不能常驻共存（~30GB>26.8GB 顶），OMLX LRU 自平衡，评审/聊天间有换模型分钟级延迟属已知代价。
- 评分口径未校准（同图 Kimi 34 vs gemma 45），阈值按通道各自记录，不跨通道比较。

## compose/compile 摆位保留（2026-09-08，摆位清空事故修复）
- 合成编译的摆位合并：**既有摆位优先**——blueprint actorIds 只用于给"没有任何摆位"的节点生成默认站排与为新增角色补默认位；道具层（characterId 为空）永远保留；actorIds 为空时摆位原样不动。重跑 compile/validate/export 链条不再冲掉人工编排。

## 工具链验证硬性指标（2026-09-10，用户指令；同步收录于根 AGENTS.md「Agent 定位」）
- **根因**：姿势状态提取能力首次验证时，agent 用 curl 直打接口看原始输出即宣布"达标"，候选未落 plan、UI 需求清单为空、未接关联场景/草稿链——绕过工具链的验证等于工具没跑通。
- **验证必须走工具自身链路**（编辑器 UI / control 事件链 / 正式工作流），并在工具内留可观测证据（plan/项目数据、`/ai/tasks`、审核记录、UI 状态）；禁止"直接 API 调用 + 原始输出判定"代替工具链验证。仅纯 CRUD/健康/配置类接口允许命令行直验。
- **测试必须在工具内留痕**：生成类候选（提示词/需求清单/草稿/候选图）经工具链落到 UI 可复核状态，汇报指明证据位置；"工具里什么都没有"= 验证不成立。
- **结合需求用足工具**：新需求优先复用既有工具链（持久化、审核门禁、进度条目、翻译链、关联选择器），缺能力补工具链，不手工代偿；生产操作（出图/脚本/导出）永远归用户或正式工作流。

## ComfyUI 启动机制（2026-09-08 修正）
- 禁用 osascript `do script`（Apple Events「自动化」授权被拒后 -1743 静默失败且只弹一次框）；一律 `.command` 包装文件 + `open -a Terminal`（LaunchServices，无需授权），Terminal 可见窗口语义不变。守护台「启动 ComfyUI」类请求直认 bootstrap 链（isGameStudioBootstrapPrompt 不再要求 gamestudio 字样）。
