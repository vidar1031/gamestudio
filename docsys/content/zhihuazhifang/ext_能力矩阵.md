---
status: 编写中
owner: 规则统筹师（待任命）
version: v1.1-draft
updated: 2026-11-01
---
# 能力矩阵与阶段归属

> 类型：全量能力台账 + 阶段归属分析。编纂方法（2026-10-21 起强制执行）：能力清单只从机器可读真相源枚举——**服务端端点表（114 个）+ 事件注册表（registry.v1.json）+ 编辑器组件树 + 《模块开发卷宗》模块表**，四源交叉对照，禁止凭印象。
> 维护纪律：任何新功能/新端点/新弹窗必须挂矩阵行才准合入；矩阵随波次滚动更新；失实即评审打回。

## 1. 创作入口域（首页 / 新建页）

| 能力 | 端点/位置 | 说明 |
|---|---|---|
| AI 创建故事 | `POST /api/projects/ai/create` | 一句话创意 → 脚本草稿（新建页） |
| 项目 CRUD/草稿确认 | `/api/projects(/:id)`、`confirm-draft` | 项目库画廊与草稿箱 |
| 项目摘要（封面/朝向/状态） | `GET /api/projects/summary` | 画廊卡数据源 |
| 模板与规则库 | `/api/ai/prompt/templates/*`、`/api/ai/prompt-library/*`、`/api/ai/rules` | 结构公式模板与全局规则 |
| 环境与能力自检 | `/api/ai/status`、`/api/ai/models`、`/api/ai/diagnose`、`/api/capabilities` | 设置页诊断区 |

## 2. 脚本层域（脚本工作室）

| 能力 | 端点 | 说明 |
|---|---|---|
| 剧本读写 | `GET/PUT /api/projects/:id/scripts` | 分镜卡片编辑 |
| 剧本分析 | `POST analyze/scripts` | 结构/内容分析 |
| 编译蓝图 / 校验 | `POST compile/blueprint`、`POST validate/blueprint` | 见《详细设计说明书》§3.1 |
| AI 解释/修复脚本 | `POST ai/review/blueprint`、`POST ai/fix/scripts` | 候选语义，人工确认落稿 |

## 3. 圣经与资产计划域

| 能力 | 端点 | 说明 |
|---|---|---|
| 圣经生成 / 质检 | `story/bible`、`story/bible/qc` | 角色设定/世界观/叙事约束 |
| 资产计划生成与维护 | `assets/plan`、`plan/persist`、`plan/remove-asset`、`plan/repair-links` | 事物提取/归属/场景关联修复 |
| 资产继承（系列化） | `assets/inherit` | 续集复用前作资产 |
| 逐场景元素分析 | `scenes/:sceneId/analyze-elements` | 有什么分析出什么，写回计划同源 |

## 4. 提示词链域

| 能力 | 端点 | 说明 |
|---|---|---|
| 提示词预检/评审 | `ai/prompt/review`、`storyboard/prompt-review` | 结构预检+AI 评审优化稿 |
| 全局提示词生成 | `storyboard/global-prompt-generate` | 全局锚点起草 |
| 单资产提示词增强 | `assets/:assetId/prompt-enhance` | 增强/翻译留痕 |
| 翻译链 | `ai/translate` | 中文锚点→英文（容错降级链） |
| 背景提示词 | `ai/background/prompt` | 场景背景提示词起草 |

## 5. 多姿态与变体域（角色多姿态全链）

| 能力 | 端点 | 说明 |
|---|---|---|
| 参考图抽卡 / 评审 / 选定（锁定） | `character/reference`、`reference/review`、`reference/select` | 三级门禁链 |
| 参考图优化 / 锁定测试 | `reference/optimize`、`lock/test` | 候选优化与锁定验证 |
| 线稿 | `assets/lineart` | ControlNet 线稿（姿势骨架约束） |
| 角色指纹锚点 / 姿势提示词 | `character/fingerprint`、`character/pose-prompt` | 身份一致性锚 |
| 姿势评审 | `character/pose-review` | 视觉评审（身份/画风/服装三维） |
| 动作立绘 / 抠图 | `character/sprite`、`character/cutout` | 绿幕生成→RMBG 语义分割 |
| 姿势需求提取 / 姿势变体自动编排 | `pose-states`、`pose-variants/auto` | 剧情姿势→骨架库匹配→变体生成 |
| 姿态需求清单定义 / 写回（蓝图定义期） | `PUT assets/:assetId/pose-requirements` | 蓝图要素库姿态需求清单编辑（增删改、组装器/配方/AI 建议/翻译，共享组件 PoseRequirementEditor）+「提取剧情姿势需求」persist 写回；落 `plan.assets[].poseRequirements`（K 波 2026-10-27；2026-11-01 定义/执行分工定型，锁定向导侧只读+回跳） |
| 场景姿态执行台（锁定出图期） | `character/sprite(+cutout)`、`character/pose-review` | 锁定向导第 5 步：选场景→按蓝图已定义需求生成候选→AI 评分→锁定并应用（共享组件 ScenePoseWorkbench；需求双稿蓝图维护，生成时缺英文稿服务端自动翻译） |
| 编排草稿显式选图 | `PUT scenes/:sceneId/composition-draft`（items 收 `imageAssetId`） | 蓝图预演占位图预览的显式选择落 `plan.scenes[].composition.items[].imageAssetId`（空串=清除）；`placementDecision` 消费端显式选图优先于剧情命中/表情差分推导（2026-11-01） |
| 状态提取 / 状态变体生成 | `states/extract`、`states/generate`、`state-variants/generate` | 剧情状态表→缺口→生成编排 |
| 道具状态提取 / 载体变体 | `prop-states`、`craft/carrier-variant` | 道具跨场景视觉状态与承载工艺 |
| 资产图库 | `assets/:assetId/gallery`、`gallery/delete` | 资产图片版本库 |

## 6. 导演构图域

| 能力 | 端点 | 说明 |
|---|---|---|
| 构图需求单（导演） | `story/composition` | 每幕谁上场/什么状态/位置大小层级关系/原文依据 |
| 摆位写回 | `scenes/placements` | 需求单→确定性摆位（幂等，人工摆位保留） |

## 7. 场景出图域

| 能力 | 端点 | 说明 |
|---|---|---|
| 单幕出图 / 全量 / 批量（断点续渲） | `ai/background`、`scenes/:id/render`、`scenes/render-all`、`scenes/batch(+resume)` | 纯环境背景链 |
| 分层出图 | `scenes/:id/layered-produce` | 分层合成链 |
| 场景图版本管理 / 绑定 | `scenes/:id/images`、`images/delete`、`scenes/:id/bind` | 版本条/换绑/删图 |
| 出图能力自检 / 自动修复 | `comfyui/capability-check`、`comfyui/auto-fix` | 节点/模型缺失体检与自愈 |
| 素材上传/导入/压缩/目录 | `assets/upload`、`assets/import`、`assets/compress`、`assets-library`、`assets/ai`、`assets/open-folder` | 素材管理 |

## 8. 审核门禁域

| 能力 | 端点 | 说明 |
|---|---|---|
| 评审列表 / 批准 / 拒绝 / 全批 | `ai/reviews`、`reviews/:id/approve`、`reject`、`approve-all` | 三级门禁（出图前/锁定/绑定） |
| 场景图评审与反馈 | `scene-review`、`scene-review/feedback` | 整图评审、打回重出建议合入 |

## 9. 验证交付域

| 能力 | 端点 | 说明 |
|---|---|---|
| 编译合成 | `compile/compose` | 蓝图→可运行 story.json |
| 导出预览 / 发布包 / 构建清单 | `export`、`export/publish`、`exports(/:buildId)` | H5 可玩包（≤5MB 分层压缩） |
| 走查 / 完整度核实 | `walkthrough`、`completeness-check(/latest)` | 全结局路径枚举+逐节点画面评审 |
| 出图总账 | `coverage` | 只读聚合完成度 |
| 运行时状态 | `runtime/status` | 运行时探测 |

## 10. 运维底座域（横切，不动）

任务台账（`ai/tasks`，全局+按项目）、模型对话明细（`model-dialogs`）、创作缓冲（`creation-buffer` journal+快照）、事件注册表（`events/registry`）、健康（`health`）、设置与通道（`studio/settings`、`diagnose`、`selfcheck`、`control-link`、`storage-info`、`tts/voices`、`tts/preview`、`image/models`、`image/preflight`、`image/test`、`comfyui/models`、`sdwebui/models`）、文档站托管（`/docs/`）。

## 11. 阶段归属分析（哪些直接拆入蓝图阶段）

判定规则：不依赖出图的准备工作 → 蓝图层；画面生产与精修 → 合成层；交付验证 → 合成层尾部；底座 → 横切不动。

### 直接拆入蓝图阶段（生产准备中心承接）

| 域 | 拆入内容 | 承接位置 |
|---|---|---|
| 圣经与资产计划域 | 全部（圣经生成质检/资产计划/继承/逐场景分析） | 蓝图层要素库 + AI 分析（已在线） |
| 提示词链域 | 主链（预检/评审/中文确认/翻译批准/全局提示词） | 锁定工作区第 4 步「全局与事物提示词」（蓝图顶栏承接入口） |
| 多姿态域 | 出图执行全部（抽卡/评审/锁定/线稿/姿势与状态变体生成与评分/抠图/图库） | 锁定工作区（六步向导第 5 步「出图管理」元素出图工作区，含场景姿态工作区） |
| 多姿态域 | 姿态需求**定义**（清单增删改/AI 提取/组装器与配方/预演姿态选择） | 蓝图层要素库+元素属性（已在线，K/L/M/R 波 2026-10-27；落 plan.assets[].poseRequirements） |
| 导演构图域 | 需求单**生成**（预排） | 蓝图占位演示 + AI 构图预排（已在线） |
| 脚本层域的校验回读 | 编译校验结论 | 蓝图顶栏校验徽标（已在线） |

### 留在合成阶段（补图车间）

| 域 | 留内容 |
|---|---|
| 场景出图域 | 全部（单幕/批量/分层/版本/绑定/自检/素材管理）——补图主操作 |
| 导演构图域 | 需求单**查看与改意**、摆位幂等写回——精修位的上游编辑面 |
| 审核门禁域 | 场景图评审与打回重出（出图后的质量闭环） |
| 验证交付域 | 全部（编译/导出/走查/完整度/总账）——交付前验证门 |
| 提示词链域 | 场景级提示词微调与增强（补图动作的一部分） |

### 横切与入口（不动）

创作入口域（首页/新建页）、运维底座域全部；审核门禁的存储与三级语义跨层不变。

### 归属分析结论

按上表执行后，两层职责干净：**蓝图层产"备齐"（结构+元素+姿态需求+长相+配音+预排），合成层产"画面"（补图+审核+精修）与"交付"（验证+导出）**。多姿态域出图执行整体在蓝图层锁定工作区完成——合成层不再承载任何"定长相"的工作。

> 注记（2026-11-01 兼容说明）：**标准系三视图默认 UI 已退役**（R/T/U/Z 波落地的正/侧/背三视图链退出默认生产 UI，锁定工作区 `dHasSheet=false`，不再是任何生产步骤的必经环节）；服务端 model-sheet 族端点与历史锁定数据仅保留兼容（当前姿势生成已强制使用主参考，不再消费历史三视图），旧入口与死代码块清理待后续代码批处理。锁定事物向导当前为**六步**（第 4 步全局与事物提示词 → 第 5 步出图管理[主参考/场景姿态/线稿逐元素工作区] → 第 6 步完成锁定）。

> 注记（2026-10-25）：事件注册表（`apps/server/events/registry.v1.json`）事件短编号由 GS- 迁移为 TS-（gamestudio 时代残留清理，编号同值顺延；原撞号的 studio.lifecycle.status/stop 让位 TS-54/55）；同批增补 TS-56…TS-64（场景元素分析/本地服务状态与启动/全局任务台账/调用通道查询/TTS 音色与试听），全部条目经端点存在性对账（55 旧条目零失效路径）。
