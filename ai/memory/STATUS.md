## 当前目标

control 基石功能全部完成并已提交里程碑（commit 0331a91）。后续方向：内容质量闭环（按 `docs/狼来了内容质量闭环工作流.md` 跑通"生成→完整度核实→定向修复→再核实"直到 PASS）。

## 当前结果（2026-08-19）

- 里程碑提交 `0331a91`：control 基石（执行引擎/守护/治理闭环/cron/右脑监察/隔离配额/proposal 治理/注册表）+ 生产链（图片三级门禁/分层合成/完整度核实/资源互斥/学习治理桥/历史检索/strict 显式失败/有界记忆注入/事件地图/项目绑定/一键启动自愈）。测试 381→393 全绿。
- 里程碑后增量：事件页卡片化；技能治理首轮评估激活 6 个（talkscene/writing-plans/long-task/comfyui/outlines/guidance）；提交确认门弹窗移除（内联审核卡片承担确认）；问句形态优先分类（R013，咨询不再误入生产）；**滚动压缩探索机制**（exploreAnswer：分块取证→压缩中间结论→综合回答→切题自检，answer_only 咨询走此路径）。
- 两个关键问题实测答对：「能否创建乌鸦喝水」答"能+依据"且不误建项目；「你是什么系统」正确自述守护智能体身份与能力。
- 一键启动自愈：外来模型（含加载中）先清扫 + 失败守卫收敛重试；守护台四状态行（Control/Hermes/Studio/OMLX）；路由记忆刷新保持页面。
- **出图总账（2026-08-30）**：新增确定性只读聚合 `GET /api/projects/:id/ai/coverage`（`apps/server/src/ai/storyCoverage.js`），从 plan/story/project/reviews+磁盘事实计算每个资产（missing/candidates/selected/locked/not_required）与场景（pending/rendered/bound）状态及全局完成度；批量渲染缺口改以总账为准（pending 才重渲），批次结果带总账快照；reference/select 选定即补写 lock_confirm approved 记录（control 旁路链路也留痕，decidedBy=control）。UI：编辑器锁定工作台摘要行（1.5s 轮询）、control-console 守护台「出图总账」卡片（5s 轮询，经 `/api/control/talkscene/projects/:id/ai/coverage` 代理）。
- **三只小猪全图分析与修复（2026-08-30）**：
  1. 资产锁定 6/12 到终态（4 角色+稻草屋+早餐桌；wolf/早餐桌系补写 lock_confirm 留痕，原因记录 params.note）。2 个 location 为 prompt_only 不需要立绘（总账已排除）。
  2. 6 个道具（木屋/砖房/铁门/烟囱/壁炉/开水锅）候选池全部不达标：AI 视觉评审逐项未通过（分数 40-58，原因如"锅像奶油汤""门不是铁门"），S4-01 门禁正确拦截。重抽不能盲目重复——8-29 已迭代 4-9 轮均失败，需改进生成策略（工作流/LoRA/提示词定向修复）。
  3. 场景渲染三重缺陷已修复（`buildStorySceneRenderSpec` + 渲染路由）：a) scene.promptAssets 全空→改从资产侧 sceneIds 反推；b) 全局 forbiddenSubstitutes 把 wood_house/brick_house 等资产词塞进 negative 把房子全禁了→按本场景所需资产过滤；c) 剧情中文直接进 prompt 模型读不懂→渲染前经 translateStoryAssetPromptPair 转英文，prompt 顺序改为内容→锚点→风格基调。验证：vxeeg0 从"水乡"变为"山谷+茅草屋"（对题）。
  4. 遗留缺陷：backgroundOnly 仍画出人物（剧情翻译残留的"三人"叙事压过 negative 与前置约束）；plan 的场景↦资产/地点关联不全（straw_house 0 场景）；10 张跑题场景图已拒绝待重渲。根子在 buildStoryAssetPlan 的关联与场景设定 prompt 质量——属内容质量闭环下一步。
  5. 当前总账：required 23 / done 8 / 35%。线稿锁定：4 角色+2 道具已就绪可进线稿；6 道具需重抽；场景 2/11 绑定。
- **第 5/6 步完成（2026-08-30 中午）**：
  1. 第 5 步（参考图与锁定）7/7：木屋两轮新抽卡共 17 张全被 AI 评审打回（多视图/设计稿/带环境，已向 slender/rigid/ambient/generic prop 负向词补 design sheet、multi-view layout、multiple houses 等排除词），最终复用 8-26 审核通过的锁定测试图经审核 API 正式锁定。
  2. 第 6 步（线稿锁定）7/7：6 资产线稿经 control 事件链（GS-30）串行生成成功，wood_house 补跑后 lineartFinalAssetUri 全部到位；抽查狼/木屋线稿成品风格正确。遗留一条 approve 自动跟进产生的重复 pre_generate 待审已作废（后续修复：自动跟进应带旁路或复用模式）。
  3. 第 7 步准备：plan 场景↦资产关联已用新端点 `POST .../plan/repair-links`（确定性名称/别名子串匹配，支持 aliasOverrides 证据别名）修复，11 场景全部挂对锚点；待做 = 全量重渲 11 场景（onlyMissing=false，含 2 张已绑定但画风落后的旧图）→ placements → 校验导出。注意：渲染仍会把人物画进背景（剧情翻译残留叙事），重渲前需再验证或接受该缺陷。
  4. 用户修正（2026-08-30）：向导第 7 步改名「完成锁定」（原「完成出图」），ready=参考图+线稿全锁定；场景出图是锁定完成后的独立阶段。2 个 location 资产（村庄边缘/草原牧场，prompt_only 且 0 场景关联）已从 plan 删除并写入 excludedAssetIds（重建不复活）；资产总数 14→12。
  5. 锁定补齐战（2026-08-30 下午）：发现并修复**锁定测试端点忽略 assetId 的 bug**（全锁定后固定回退到大野狼，5 张误生成狼图留存在 story_lock_tests）；铁门/壁炉经锁定测试路径通过并线稿完成；砖房/烟囱/沸水锅最终轮仍内容级失败（砖房→砖墙入口、烟囱→整套壁炉、锅→锅内冒火），前后 20+ 次尝试确认该模型+工作流对这三类结构件产出不稳定，按用户确认以**纯文字锚点**进场景图（prompt_only，不卡 S4-02），后续质量闭环定向抓。锁定测试 off 模式已补 lock_confirm 留痕。当前总账 23/11/48%（资产锁定 9/12，场景绑定 2/11）。
  6. 人工特批与编辑器缺陷修复（2026-08-30 傍晚，用户指令驱动）：a) **主参考允许人工特批越过 AI 评审**（DECISIONS.md 已登记）：服务端 select 端点收 `manualOverride:true` 放行并留痕（lock_confirm 带 manual_override + 被越过门禁结论），编辑器候选图被 409 拒绝后弹应用内 div 确认框（z-index 200，非系统弹窗）。沸水锅已被用户特批锁定（10/12）。b) 门禁拒绝原因原藏在折叠日志→工作台顶部常显错误横幅。c) **202 审核挂起响应无 plan 会把编辑器内存计划清空**（用户点生成线稿后向导资产数变 0、被打回第 3/4 步的根因）→ 线稿/抽卡 handler 加 pendingReview 守卫，plan 只在响应带 plan 时更新；磁盘数据未被污染。d) **第 4 步样式错乱**（puppeteer 探针实测定因）：工作卡 grid 模板硬编码 6 行、子元素随出图总账条变 7 个 → 全局提示词行被压 0 高内容重叠，改 `grid-auto-rows: max-content`；`.story-lock-textarea` 缺 `box-sizing:border-box` 致中英列重叠 18px。e) 第 6 步补显示待审核列表（线稿 manual 挂审的批准入口此前只在 5/7 步可见）。
  7. **12/12 全部锁定+线稿完成（2026-08-30 傍晚）**：砖房/烟囱经人工特批选定候选（砖房 seed_3899750627、烟囱 seed_15827281，均绘本风白底），沸水锅/砖房/烟囱线稿补齐；发现 plan 写盘竞态（线稿写回与 select 写回并发互相覆盖）——本次以串行重跑规避，根修（plan 写锁/合并写）待做。当前总账 23/14/61%，场景绑定 2/11，待审核 0。第 5、6 步全绿，可进第 7 步场景出图阶段。
  8. **场景出图阶段完成，总账 23/23 100%（2026-08-30 晚）**：a) placements 只合成角色（prop 不合成是设计限制）→ 修正 backgroundOnly 只剔除角色、道具锚点画进背景；b) 背景图喂透明抠图参考会把整图洗白（实测白板）→ 背景不再喂图像参考，只用文字锚点；c) 剧情叙事人名剥离后仍画出人物/狼（三轮实测）→ 背景 prompt 彻底弃用叙事文本，改由非角色资产英文锚点+世界锚点构成；d) 全量重渲 11 场景（GS-34）+ 3 张问题图单点重渲，逐张审核通过；e) placements 重跑后角色按剧情正确出场（11 场景 15 站位更新）；f) 校验 0 issue、导出成功、可玩 H5 无头实测无 console 错误、场景推进正常。已知小瑕疵：3 猪同场时只见到 2 只（站位/缩放重叠），pig-1 与 pig-3 立绘相似度偏高——留待内容质量闭环。plan 写盘竞态在本阶段再次发作（placements 写回时场景关联曾丢失），写锁根修优先级升高。
  9. **正式场景出图弹窗改造（2026-08-30 晚，用户指令"能编辑、能重新出图进行管理"）**：AiStoryboardBatchModal 的正式出图区改为场景管理卡片——每卡含状态徽标（待出图/已出图待绑定/已绑定/出图中/待审核）、当前场景图缩略图（点击看大图）、场景原文折叠、提示词编辑（原有绑定保留）、单卡「重新出图」（走 renderStorySceneAi + backgroundOnly，202 挂审有提示）；新增待审核管理区（3s 轮询 reviews，批准/拒绝内联处理，批准 scene_bind 后重载项目）+ 顶部出图总账行 + 底部「全部重渲」（串行，待审核场景跳过）。placements 写回补了 ai.referenceAssetId 回填（修体检"缺少角色参考图"）；storyAssetPlanConfirmedAt 曾被编辑器旧标签页自动保存覆盖——编辑器保存覆盖服务端状态与 plan 写盘竞态属同一待修族。
  10. **弹窗二轮改造（2026-08-30 深夜）**：a) 整体紧凑化（弹窗作用域覆盖，不动全局类）+ 场景卡显示「出场事物」（plan 场景关联+锁定状态）；b) 打开弹窗自动定位到场景管理区（scrollIntoView，只定位一次）；c) 场景图版本管理：新增服务端三端点（`GET scenes/:sceneId/images` 列版本、`POST .../bind` 换绑+scene_bind 留痕、`POST .../images/delete` 删除，绑定中禁删），卡片缩略图区改横排版本条（当前背景高亮，点选后可设为背景/删除）；d) 修真相一致性 bug：`saveStoryAssetPlan` 此前不同步 project.json 副本、`plan` 接口 rebuild:false 返回派生计划丢人工补充——两修后编辑器看到=磁盘真相。
  11. **场景编排器（2026-08-31，Animate 式，用户批准后实施）**：合成工作室 Pixi 画布升级为编排器——placement sprite 可点选/拖动（pointermove 纯 Pixi 零 React 渲染、pointerup 一次提交 doc.story，坐标经 computeStageViewport 归一化换算，探针实测逐位精确）、Shift+滚轮缩放（0.05–4）；左栏新增「素材」页签（项目角色+已锁定计划资产含道具）HTML5 拖入画布即生成 placement（同素材多实例）；右栏摆放属性补齐素材名标题+zIndex 等；场景管理卡加「编排站位」入口定位节点。关键迁移修复：旧摆放数据无 id 字段导致寻址失败，openProject 时统一 uid 补齐并标脏待保存。探针测试产生的 3 条重复摆放已清理。typecheck 通过。
  12. **编排器增强（2026-08-31）**：画布顶部工具栏——编辑/预览模式切换徽标（预览=只读）、缩放（−/%/＋/适应窗口）、平移工具、选中后 左右/上下反转（flipX/flipY 负 scale，编辑器与导出运行时 storyPixi.js 同语义）、前移/后移（zIndex）、删除、撤销（doc.story 快照栈深 50 + Ctrl/Cmd+Z）；右栏「元素层级」全元素列表（背景+摆放按 zIndex 排序，显隐/上移下移/删除/选中联动）；探针实测拖入→撤销→恢复、反转/层级落盘、缩放平移组合下拖动坐标逐位精确。
  13. **编排器两轮实测修复（2026-08-31 晚，用户实测反馈）**：a) 自动保存此前被 `!sbOpen && !sbRenderOpen` 门控只在弹窗打开时生效——编排画布的层级/拖动修改刷新即回退；已改为 dirty 即 1.2s 防抖保存（busy 守卫保留），探针实测 下移→4s 落盘→undo→再落盘。b) 画布点选改像素级命中（透明像素穿透）：纹理一次构建 alpha 图缓存（WeakMap），stage 级 pointerdown 从顶层到底层逐摆放做 worldTransform 逆变换+alpha 阈值判定，全透明则取消选中；回退矩形命中兜底。探针实测：不透明区命中猪妈妈、透明穿透选中下层猪老大、天空区取消选中、缩放平移组合下仍准确。
  14. **创作过程缓冲文件（2026-08-31，用户指令"每个故事要有自己的缓冲文件，不能只在浏览器缓存"）**：`apps/server/src/creationBuffer.js` + 挂载点——每个项目 `creation-buffer/`：journal.jsonl 追加式创作事件日志（锁定/线稿/场景绑定/站位/提示词起草/项目更新，含 actor 与摘要）+ snapshots/ 写前快照（project.json/story.json/plan.json，保留最近 20 份自动轮转，5s 防抖）。覆盖主要写入通道：PUT project、saveStoryAssetPlan、persistSceneBackgroundBinding、reference select、lineart、placements、prompt-enhance。只读查询 `GET /api/projects/:id/creation-buffer`（日志尾部+快照列表）。恢复=把快照目录文件复制回项目根。同日提示词丢失事件（旧会话保存覆盖）即从导出快照手工恢复，该缓冲为此类事故提供原生防线。
  15. **乐观锁与拖入消失根治（2026-08-31）**：PUT project 强制 `_rev`（缺失/不符 409 返回最新文档），内部主要写入路径递增 `_rev`；编辑器 saveCurrent 带 `_rev`，409 时自动取最新版本号重试（修复初版从 `{project,story}` 包装顶层误取 `_rev` 导致永远落入刷新分支的 bug——用户"拖入 1.2 秒后消失"的精确根因），实测拖入→自动保存→层级与磁盘双留存。control 侧 updateProject 先读 `_rev` 再提交。
  16. **对话框透明度+工具包风格化（2026-08-31）**：`DialogLayoutV1.opacity`（0-1）贯通 schema/导出运行时（card 0.74×op、textBox 0.35×op）/编辑器右栏滑杆+画布预览。工具包写实皮质风改绘本风：重写锚点（flat 2D/bold outline/排除 photorealism）后重抽，seed_3595085342 卡通帆布工具包（木柄工具露出）经人工特批锁定+线稿+画布摆放图替换完成。本地 AI 风格处理评估：管线能力足够，瓶颈在锚点纪律而非模型。
  17. **动作立绘工作流定型+场景 2 试点（2026-09-01，用户批准"之后就按这个流程进行工作"）**：右栏摆放属性「动作描述」+「生成动作立绘（透明）」→ 绿幕生成 → 抠图 → 覆盖该摆放。**配方（7 轮 A/B 实测定论）**：a) 指纹锚点置 prompt 最前；b) 人类称谓去人类化（eldest brother 等→pig character）+ 动作句补动物主语；c) 中文动作词服务端先转英文（此前中文动作词全失效）；d) 动作句加 `(…:1.25)` 权重；e) **IPAdapter 默认关**——plus-face/通用 plus 各权重各区间档都会锚死主参考站姿导致动作词失效，纯文本配方身份+动作双达标（`STUDIO_SPRITE_IPADAPTER=on` 可开）；f) **抠图改服务端 RMBG 语义分割**（新端点 `/ai/character/cutout`）——前端按颜色 chroma key 对衣服撞色/渐变底必挖穿，角点采样也救不回。配套修复：摆放与角色默认/主参考共享资产时严禁覆盖（曾把猪老大主参考覆盖成废图，已从备份恢复）；PUT 资产按 id::uri 判重导致同 id 换 uri 后无限膨胀（改同 id 有 uri 即不保留旧条目+按 id 去重，已清 6 条重复）；`storyAssetPlanConfirmedAt` 被内存空值 delete 丢失致向导打回「待确认」（编辑器两处+服务端守卫改保留磁盘真相）。试点成果：场景 2 三猪各有剧情动作（老大指/老二抱胸/老三指），RMBG 透明立绘干净；背景三轮重渲（书本幻觉→加权前置词）终版含木柴堆+泥土地，稻草堆被画成茅草屋顶（模型强关联，遗留——正道是把稻草堆/木柴堆做成锁定道具摆放，而非画进背景）。
  18. **选中即属性+摆放调试面板（2026-09-01，用户反馈"点击图无法打开属性、无编辑功能"，A+B+C+D 全量实施）**：根因=画布 onSelect 只 setActivePlacementId、从不切 selection，角色/资源页签下点图右栏无反应。A) handleStageSelect：点选→切节点上下文+左栏回节点页签+展开元素层级+右栏 scrollIntoView 到摆放属性卡（key 重挂载触发 CSS 高亮脉冲）+吐司报名字；B) 摆放属性卡升级：图片来源追溯块（缩略图/资产 id/生成提示词摘要/在资源中打开）、翻转开关收进面板、重置变换、调试信息 details（placement JSON+复制）——数值 x/y/缩放/角度/zIndex/可见本就有；C) 高亮框四角缩放手柄（拖距比实时改 scale、pointerup 提交，手柄作高亮框子节点随框销毁）+ 双击摆放直开动作立绘弹窗（400ms 同 id 判定）；D) 预览态只读（renderStage interactive 门控已有+handleStageSelect 双保险）。探针实测：角色页签复现断点→点图右栏直达摆放属性、面板元素齐、双击开弹窗。
  19. **动作立绘抽卡池+场景 2 分层重制（2026-09-01，用户指令"一轮不可能成功，要第 5 步同等能力"）**：a) 新弹窗 `AiPoseSpritePoolModal.tsx`（摆放场景专用，角色默认图流程保持旧弹窗）——生成 1 张/再出 4 张（串行 n/4）/候选池网格（评分徽标 ≥70 绿 40-69 黄 <40 红）/单张重抽/删除/AI 评分/选定后抠图应用；候选持久化在 `placement.poseCandidates`（schema 已加字段）；b) 新端点 `POST /ai/character/pose-review`（`characterPoseReview.js`）——Kimi 视觉对比锁定主参考，三维评分（身份/画风/服装），**硬性指示姿势不同不扣分**，实测废图人类女孩 0 分、风格漂移 35 分判别有效；c) sprite 端点加 `kind:'prop'` 道具模式——角色版 chromaHint 的 "single character or single animal/no props" 会把道具生成带成人类少女（实测三连），道具版改 "single object, no character"+负向补死；d) 弹窗 z-index 20→60（工具条 40 压弹窗的实测投诉）；e) 顶栏「场景出图」直达入口（跳过 7 步向导）。**背身配方**：`(back view, view from behind, facing away from viewer:1.4)` + 具体动作——普通"背对镜头"措辞无效，加权后才稳定出背身（3/3 成功）。场景 2 重制：稻草堆/木柴堆/泥土地三道具透明立绘入计划（17 资产）+摆位；三猪背身立绘（A1 指点/B1 叉腰回望/C2 伸臂，翻转对齐指向）；**事故教训：探针 textarea 全局选择器曾把姿势文本误写进场景正文与 timeline（已恢复原文）——UI 探针选择器必须限定容器作用域**。
- **会话观察**：
  1. 灰姑娘故事创建：通过 exploreAnswer 路径成功生成文本，未误触项目创建流程。
  2. 三只小猪故事创建：成功生成"三只小猪抵抗大野狼"情节文本。
  3. 丑小鸭故事创建：成功生成"丑小鸭变成白天鹅"情节文本。
  4. 乌鸦喝水故事创建：成功生成"乌鸦用石子喝水"情节文本。
  5. 三只小猪圣经数据生成（2026-08-25）：bible 文本已生成（1117 chars，5 字段齐全：characters/settings/rules/dialogue/narrative）。但磁盘上 bible.json 文件不存在——bibleNode 写入路径与项目目录结构不匹配，写入操作被静默吞掉。Control task `bible_only_7c04ca64_20260825` stuck 在 running 状态。bible 数据本身完整可用，写入路径需修正。

## 当前阻塞

- 无（2026-08-24 OMLX 内存顶已解除：`iogpu.wired_limit_mb=26624` + `omlx-cli restart`；机器重启后 sysctl 复位需重跑）。
- OMLX 默认模型 gpt-oss 会被自动拉起占内存（已有清扫+守卫+重试兜住启动；根除需在 OMLX 面板改默认模型，无 API）。
- 机器内存压力时 27B 模型加载可能失败（动态上限），属环境约束。
- hermes 原生 Web UI/TUI 未启用（决策：守护台即治理 UI，不另启）；多渠道不启用（用户明确）。
- **bible.json 写入路径问题**：三只小猪 bible 数据已生成完整，但磁盘文件未写入。bibleNode 的写入路径需对齐 `storage/projects/<projectId>/bible.json`。

## 下一步

0. **8K 测试期首轮实测已通过（2026-08-24）**：A–E 组证据见 `docs/运行时能力测试基准.md` 第 7 节。
0.1 **重启链路根治（2026-08-24）**：孤儿进程找回 + all-restart 死代码修复。实测全链通过。
0.2 **多轮长聊不崩垮（2026-08-24，"卡了一年"根因闭合）**：记忆同步 bestEffort + 闭环触发正则收窄 + 对话水位管理。复跑原失败问题已正常完成。
0.3 **咨询查证能力回归（2026-08-25）**：只读查证执行器（phasedAgentStream）+ 出站预算守卫。规划→查证→压缩→回答全链通过。
0.4 **启动内存闸自愈 + 事实类问题根治（2026-08-25）**：ensureOmlxPrefillHealthy 嵌入启动流 + 咨询流注入项目库实况。
0.5 **bible.json 写入路径修复**：修正 bibleNode 写入路径对齐 `storage/projects/<projectId>/bible.json`，完成后验证磁盘文件存在。
1. 内容质量闭环实测：跑狼来了，核实器拦截的图文不匹配问题做定向修复。
2. 项目经理最终验收（总计划第 12 节）。
3. 修复 OMLX memory rewrite 500 后重跑真实 P0/P1 验收。
4. 长任务方向：L2 cron/子 agent 机制就绪，待真实凭证恢复后分期验收。

sessionId: 里程碑后由多轮交互推进
updatedAt: 2026-08-30T02:25:00.000Z
## 当前结果（2026-09-01 补充）

20. **出图统一管理归位（用户裁决"所有出图都归在锁定出图中"）**：a) 锁定向导第 5 步角色资产卡新增「姿势变体」管理区——姿势需求输入（场景预填）/生成 1 张/再出 4 张/AI 评分（pose-review）/命名锁定（RMBG→建 project asset→写 plan asset.poseVariants→saveStoryAssetPlan 双写持久化）/已锁定列表删除（被摆放引用时 div 弹窗阻断）/候选持久化 poseCandidates；b) IPAdapter 档位开放：sprite 端点接受 body.ipadapter={enabled,weight,startAt,endAt} 覆盖 env 默认，向导高级参数折叠区可调（默认关）；c) 摆放属性降级为纯消费端——「图片（覆盖）」下拉只列角色默认+已锁定姿势变体（历史值追加"未纳入管理"保底显示），「生成动作立绘」与画布双击均改跳转「管理姿势变体…」（向导定位到该角色第 5 步姿势区，锚点 pose-asset-<assetId>）；抽卡池弹窗 AiPoseSpritePoolModal 已删除退役；d) 三猪背身变体迁移注册（char.pig-1/2/3 各 1 条），三个道具补登记 lock_confirm 批准记录（道具模式生成+目检选定留痕）——**出图总账回到 28/28 100%，待审核 0**。探针 16 项全过（生成/评分/锁定/下拉选中/迁移一致性）。教训沉淀：上轮把生成管理建在属性面板（消费端）导致"图找不到"——生成管理能力必须只有锁定车间一个家。

21. **姿势变体 AI 提示词+主参考延续修复（2026-09-01，用户验收三连问驱动）**：a) 姿势需求改中/英双栏 +「AI 生成提示词」（新端点 `/ai/character/pose-prompt`，`characterPrompt.js` 的 generateCharacterPosePrompt：openai/localoxml/doubao 三路由，约束只写视角/动作/表情/手势+服装延续，严禁背景词；实测中文稿 66 字/英文稿 298 字符质量可用；OMLX json_schema 空 output_text 用 extractResponseOutputText 兜底，偶发空输出端点内串行重试 1 次）；b) **IPAdapter 身份失效根因破案并修复**：锁定主参考是 RMBG 透明底 cutout，CLIP vision 对透明区编码是脏的导致身份锚定完全失效（出人类女性、评分 5）——sprite 端点喂 IPAdapter 前一律 PIL 合成白底（缓存 `_flatwhite.png`），实测同条件 5→45 分且背身+白衬衫锁定成功；c) 档位实测结论：0.7 档姿势自由但裤鞋颜色漂、0.9 档服装全锁但姿势拉回正身，默认取 0.8/0.2-0.9 折中并在高级参数里写清取舍提示；d) 候选/变体记录带 promptZh/promptEn 双稿追溯。遗留：char.pig-1/3 各有一张低分探针废图可在向导删除；IPAdapter 高分档与姿势自由的兼得需 ControlNet 姿势+IPAdapter 身份组合（未做）。

22. **剧情感知提示词+姿势图片画廊（2026-09-01 晚，用户验收二问驱动）**：a) 姿势变体区新增「关联场景」下拉（plan 资产 sceneIds → story 节点序 #N 名称），「AI 生成提示词」更名「按剧情生成提示词」并携带选中场景正文——实测猪老大×选址分歧产出「右手伸出食指指向右侧地面以示意稻草区域，自信略带狡黠，服装与主参考一致」（命中剧情点，此前空上下文出通用站桩词）；生成指令强化"剧情有指向/注视/背负动作必须体现，禁止无依据正面站桩"，中文稿剥背景短语防与绿幕提示词打架；b) 姿势变体「管理图片（更多 N）」画廊 overlay（复用 story-lock-gallery 样式）：候选（评分徽标/查看大图/删除）+已锁定变体（名称/查看/删除，引用阻断 div 弹窗）两分组；阻断弹窗 z-index 升 140 压画廊 130。探针全 PASS。

23. **姿势草稿持久化+候选迁移（2026-09-02，用户验收"最新生成的图与提示词不可见"）**：a) 根因=姿势区中/英提示词与档位只活内存、抽卡池时代候选在 placement 级而新区读 plan 资产级、curl 试验图无登记；b) plan 资产加 `poseDraft`（promptZh/promptEn/sceneId/IPAdapter 三档），五个持久化时机（剧情生成完成/场景预填/抽卡点击/场景切换/参数失焦），不逐键入写盘；c) 一次性迁移脚本（.tmp/migrate_pose_candidates_20260902.py 保留）：placement.poseCandidates 归并进 plan 资产并清字段、登记 11 张磁盘生成图为候选（mtime 转 createdAt）、猪老大/猪老三种子草稿；d) 跨资产重复候选 ch_1788253531528 裁决保留 char.pig-1 侧（实际生成语境）。探针全 PASS 含刷新后持久化闭环；画廊 7 候选+1 锁定全可见。

24. **锁定向导卡片墙重构（2026-09-02，用户手绘草图+批准）**：a) 一级「事物总览」卡片墙为默认主视图（plan 已确认时）——每卡最终确认图（主参考 cutout 垫棋盘格）+名称+类型+四态徽标（已锁定/待锁定/待抽卡/待起草，纯函数 assetLockStatusOf 与门禁同口径）+场景数+状态快捷动作；未锁定在前排序+状态/类型筛选；顶部总账+下一步建议+批量入口+配置；b) 二级资产详情弹层（z-125）：标题栏（名称/状态/上一个/下一个/关闭）+环节锚点导航+提示词/参考图/线稿/姿势变体三节——第 4/5/6 步资产卡抽取为共用渲染函数（renderAssetPromptCard/renderAssetRefRow/renderAssetLineartRow/renderGlobalPromptSections），步骤模式原样保留可回退，零逻辑分叉；c) 右侧配置 drawer（z-126）：全局提示词四格+模型接口只读摘要+采样参数只读+IPAdapter 档位说明；d) 摆放侧「管理姿势变体…」直达二级弹层姿势区。探针 30 项全过（含步骤模式回归、摆放下拉回归）。ComposeStudio 零改动（props 全复用）。遗留：二级上/下一个按排序后全量数组循环（不随筛选收窄）；猪老二提示词评分 34/100 为既有数据问题待用户裁决重生。

25. **猪老三场景2全链路实测（2026-09-02，用户指令"测试猪老三在主参考基础上符合场景2需求"）**：完整走通 选场景→剧情提示词→IPAdapter 延续主参考抽卡→AI 评分→命名锁定→摆放切换。**过程中抓到真 bug**：a) pose-prompt 的 userHint 语义缺陷——字段里残留的旧完整草稿被模型当"额外要求"整段保留（正面站桩词反复重生），指令已修正（hint 仅补充约束、与剧情冲突以剧情为准、旧稿只参考风格词汇），修正后猪老三产出背身指向稿；b) 探针侧教训再记一条：弹层内同名按钮/文本框必须用区块 class 作用域（.pose-variant-section / placeholder 特征），全局 find 曾误点主参考区的「再出 4 张」、误读主提示词文本框当姿势栏。结果：4 张新候选出分 45/20/25/40（最佳 45 为背身+指点+蓝衫裤），锁定为「背身·指点（剧情版）」并切换到场景 2 摆放；废图（人类女 5 分/裸猪 30 分）已从候选删除；画布构图验证通过。StoryboardLockWorkspace 存在 React "Expected static flag" 警告（hooks 顺序问题，功能未受影响）待清理。

26. **老二老三剧情版姿势收官（2026-09-02）**：老二走完整流程（剧情提示词→抽 4→评分）时剧情生成出了正面微侧词且 Kimi 限流（engine overloaded 间歇 429），改用背身配方补抽 3 张，目检选背身看右（手叉腰）锁定为「背身·叉腰看右（剧情版）」；老三评语优化轮新出 4 张，50 分背身高举指点（白衬衫蓝裤）锁定为「背身·指点（优化版）」——两摆放均已切换，画布三猪背身构图成立。已出分评价写回候选（老二 45/40、老三 50/25），老二裸猪废图删除。教训：Kimi 评审有限流，批量评分要间隔重试；数据脚本对 project.json 的 plan 访问不能用 `'assets' in d` 判别（project 顶层自带 assets 会误判，已踩一次并修复）。

27. **猪老二场景2修正轮（2026-09-02，用户"图还不对"）**：根因两条——a) 我手工补正的提示词写了"蓝裤"（老二主参考是白裤）+ 写了"木柴堆"道具词，导致候选把木柴堆画成背景、裤色被评审连环扣分；b) 剧情生成对老二仍出正面词（hint 残留问题，指令修正已减弱但未根除）。**正确配方**：姿势词只写视角+朝向+动作+表情，服装只写"与主参考一致"（不写具体颜色，颜色交给 IPAdapter 白底主参考），严禁在姿势词里写场景道具（道具已在画布分层）。修正后抽 4 张：3 张合格背身（白衫白裤棕带），最佳「背身看右+黑鞋」Kimi 55 分（全项目最高），锁定为「背身·盯木柴（场景2）」并切换摆放；木柴背景 4 张废图已删、另 3 张登记入池。场景 2 三猪背身构图最终成立。

28. **市场 LoRA 验证落地（2026-09-02，用户裁决：本机训不动 LoRA、故事工厂模式必须用市场验证 LoRA）**：CivitAI 实测检索（走本地代理 7897）：绘本向 SDXL LoRA 市场头部=【Picture book illustration】J_cartoon（12.4k 下载但作者限制登录下载，无账号绕不开）→ 第二名 flat childrenXX（9.3k）下载成功（114MB 进 ComfyUI models/loras）。**发现 ComfyUI 本机已有 9 枚相关 LoRA 闲置未挂**（含 PictureBookStyle/StorybookRedmond 儿童书系/Flat2D_Cutout/Anime_Furry/GameProps）。三枚 A/B（同背身词同 IPAdapter 档位各抽 2 张+Kimi 评分）：Flat2D_Cutout 25/55、StorybookRedmondV2 35/42、**flat_childrenXX 60/30**——60 分为全项目最高分且服装（白衬衫白裤棕带）全对。结论链：纯文本 5-20 → IPAdapter 白底 40-55 → 市场风格 LoRA+IPAdapter 60。已将 flat_childrenXX:0.7 挂载为 studio_settings 默认 LoRA（全链生效，后续背景出图也带此风格），两张达标图登记入猪老二候选池。LoRA 自训路线正式从路线图移除（硬件不够+工厂模式不合理）。

29. **LoRA 选择器+提示词预设设置化（2026-09-02，用户指令"已下载的做成可选择，常用继承参考样图提示词做成可选设置"）**：锁定向导配置 drawer 新增两区——a)「出图 LoRA」：打开时拉 `GET /api/studio/comfyui/models` 列出 ComfyUI 可用 LoRA（本机 10 枚），当前挂载列表（名称+强度可改+移除），添加（下拉排除已挂载+强度默认 0.7，上限 8 对齐 parseComfyLoras），「保存 LoRA 设置」先 GET 再 PUT 整对象只改 image.loras，成功内联提示（规格偏离：未走全局 toast，drawer 无 setToast 通道）；b)「提示词预设」：poseRecipes.ts 新增 PROMPT_PRESETS 7 条（绘本平涂/绿幕角色/绿幕道具/背身配方/服装延续/通用负向包/写实排除包，英文措辞取实测有效的 chromaHint/negBase 同款），预设下拉+目标（全局正向/负向）+追加去重，走全局提示词既有保存链。探针 14 项全过（挂载增删落盘往返验证、预设追加去重、settings 最终态=验证默认）。遗留：LoRA 编辑未保存直接关 drawer 无脏标记提示（小项）。

30. **老大老二 LoRA 轮收官（2026-09-03）**：默认挂载 flat_childrenXX:0.7 后全链路重抽。老大：首批 4 张 IPAdapter 0.8 档全出正身（82/66/62/48，正身 82 分全场最高但不符合背身需求），降权 0.65/区间 0.3-0.85 补 3 张出真背身指左（62 分，白衫蓝裤棕鞋全对、侧脸朝向左）锁定「背身·指左（LoRA版）」；老二：60 分背身侧头看右（白衫白裤棕带）锁定「背身·盯木柴（LoRA版）」。两摆放已切换，画布验证通过。**插曲教训**：曾误判"画布渲染白剪影"——原生分辨率裁切确认渲染正常，是降采样截图把白衣猪看成剪影；结论前先裁原图验证，别凭缩略图下渲染 bug 结论。全部已评分候选（含老大正身 82 分）登记入池供后续场景选用。

31. **"删除不掉/切换不了"根因与根治（2026-09-03，用户实测）**：表象=删姿势变体被误报"仍被引用"+摆放下拉切不到新变体；根因=用户开了多日的编辑器旧会话，其自动保存在 409 后**带着旧内容重试成功**，把磁盘上我的外部修正整体回滚（摆放退回旧资产），再叠加我删除旧资产 → 引用落空画布白板。根治三件套：a) 删除阻断检查改为先 `getProject` 拉服务端磁盘真相再判引用（不再用内存旧数据）；b) 编辑器新增**外部更新横幅**——20s 轮询+聚焦时对比服务端/本地 _rev，高了就提示「刷新加载最新」（dirty 时文案警示保存将覆盖）；c) PUT 资产合并加**引用保护**——凡被磁盘摆放/角色默认/主参考/计划主参考/姿势变体引用的资产，入站缺失一律保留（不再只看 story_assets 前缀前缀）；plan/persist 返回最新 _rev 且编辑器采信（防横幅把自己保存误报成外部更新）。数据已修复：三个姿势资产恢复、三摆放就位、老二两个垃圾变体（叉腰看右旧版/姿势3）已删。**操作规约沉淀：今后一切数据级直写必须同步递增 project.json _rev**。

---

## 重大推进节点（2026-09-06 ~ 09-09）：三只小猪全故事生产闭环首次完整跑通

> 这是 TalkScene 从"建设期"进入"生产能力验证期"的节点：一个 11 场景互动故事从出图到导出全程跑通，且全程经守护台事件链驱动。

### 交付事实（全部磁盘/走查实测）
- **三只小猪 11/11 场景全套分层出图完成**：48 条分层摆位、11 张背景（全部 background-only 空景，道具/角色全部立绘分层）、9 个新姿势变体（狼吹气/狼趴屋顶/狼倒栽/狼逃离/老大逃跑/老大老二敲门/老二举锤/老三和泥/老三加固）。
- **H5 导出 4.6MB 可玩**（`/demos/7c04ca64.../latest/dist/index.html`）：完整度核实（真实浏览器逐节点走查）11/11 技术全通过（0 加载失败/0 console 错误/双分支可达结局）。
- **素材治理**：工作区 385MB→63MB（存量批压 524 张），导出 397MB→4.5MB（引用收集+压缩）。
- **新能力（守护台事件链）**：`GS-44 asset.scene.layeredProduce`（分层出图编排端点：姿势/道具/背景/摆位一条龙，规格文件驱动 `creation-buffer/sceneN_layered_spec.json`）、`GS-45 asset.compress`（存量批压）、`asset.scene.render` 支持显式 prompt 覆盖。
- **视觉评审本地化**：gemma-4-26b-a4b-it-4bit 经 OMLX 实测多模态可用，姿势评审/完整度评审默认 local_vl（Kimi 留给用户显式切换）；调度器外来模型守卫放行名单（左脑配置 visionModel）。
- **场景卡联动**：AI 分镜批量生成模态「出场事物」chips 可点击直达锁定向导该资产详情。
- **素材复用**：跨项目素材库（GET /api/assets-library）+ 导入（POST assets/import）服务端就绪；顶栏「素材目录」Finder 直达。

### 本轮修掉的确定性缺陷（均有事故现场）
- compose/compile 合并逻辑用蓝图 actorIds 重建摆位 → 全量摆位被清空（已改为既有摆位优先，重编译验证 48 条存活）。
- 渲染端点显式自定义 prompt 时 worldAnchor（含村庄/建筑/月夜词）仍拼入 → 背景必出房子（已修：显式覆盖时不再拼锚点）。
- 守护台三连：`extractJsonObjectString` 贪婪切片把重复 JSON 拼成非法（改配平括号截取）；项目列表关键词误截文件读取请求；裸 shell 命令被误判只读剥光 shell_execute。
- `isTalkSceneBootstrapPrompt` 不认裸「启动 ComfyUI」；osascript do script 的 Apple Events 授权被拒后静默失败 → 改 `.command`+LaunchServices 免授权拉起 Terminal 可见窗口。
- control `vision_analyze` "模型名含 qwen 即支持视觉"误判（Qwen3.6-27B 纯文本），改认真多模态标记。
- repairStoryAssetPlanSceneLinks 会把道具锚点重新加回分层场景（已加 layeredComposition 标记并让 repair 尊重它）。

### 已登记的剩余缺陷（详见对话内 P0/P1/P2 清单，要点）
- P0：身份一致性靠抽卡次数堆（SDXL+IPAdapter 命中 50-70%）；摆位坐标全靠人工；Hermes 创作参与受 OMLX prefill 贴线限制（P1-15 未治理）。
- P1：Kimi 与 gemma 评分口径未校准；背景模型不听"禁写房屋"；道具抠图残块（本次稻草堆用现成稻草堆替换规避）；角色指纹词全空。
- P2：LLM↔VL↔ComfyUI 换模型分钟级延迟；守护台「分层出图」无 UI 卡片（要敲命令）；素材导入选择器 UI 未做；结局节点工艺覆盖薄。

### 事故教训（必须记住）
- 批处理规格 sceneId 错位一位 → 5 个场景被写入下一场景内容。生成物内容正确救回，重绑修复。**今后场景映射一律以 story.json 节点 id+name 对照为准，禁止凭序号印象。**
- 规格文件占位符（__POSE_xxx__）经摆位校验正确拦截未部分写入——门禁有效，流程保持两阶段（先生成→目检→再摆位）。
