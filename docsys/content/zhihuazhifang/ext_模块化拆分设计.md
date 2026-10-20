---
status: 评审中
owner: 规则统筹师（待任命）
version: v0.9-draft
updated: 2026-10-20
---
# 模块化拆分设计（目标架构）

> 类型：工程变更设计（《工程升级实施方案》P2/P3 的施工蓝图）。
> 纪律：本文只描述目标架构与迁移规则；实施逐波进行，每波过适应度函数才合并。
> 保护清单（不得触碰语义）：真相源存储模型、双平面分离、三级审核+托管审批、资源三槽调度、失败即停+断点续跑、台账与证据链。

## 1. 引言

### 1.1 编写目的
为三个巨型单文件（业务后端入口 13.7k 行、控制面核心 15.4k 行、编辑器合成工作室 ~9.5k 行）的拆分给出目标结构、拆分边界、迁移规则与验收口径。

### 1.2 问题陈述（现状证据）
模块边界靠注释分区而非文件边界；编排器内嵌路由处理器并经进程内自调用复用链路；摆位规则四套堆叠生长；业务面无单元测试基座；真相源写盘无运行时契约校验。

### 1.3 参考资料
《概要设计说明书》、《详细设计说明书》、《工程升级实施方案》、《测试分析报告》§5.2。

## 2. 目标结构

### 2.1 业务面（apps/server/src/）

```text
apps/server/src/
  index.js      # 装配壳（<200 行：建 app、装配上下文、按注册表挂路由、启动）
  routes/       # 路由注册表：每域一文件，纯协议层（取参/校验/调服务/回包）
  services/     # 服务层：编排与流程（状态变体编排、摆位决策、场景编排）
  ai/           # domain 域保持：纯函数与算法，不持框架对象
# 依赖方向自上而下单向：装配 → 路由 → 服务 → 域
```

**routes/ 分域清单**（按端点族，迁移后 index.js 不含任何业务逻辑）：
| 文件 | 端点族 |
|---|---|
| studio.routes.js | 健康/项目 CRUD/设置/密钥 |
| story.routes.js | 脚本/蓝图/故事读写/编译/校验 |
| storyAssets.routes.js | 资产计划/参考图/锁定/线稿 |
| storyStates.routes.js | 状态提取/状态变体生成/载体变体/道具状态 |
| storyScenes.routes.js | 场景背景/构图/摆位/批量渲染/走查 |
| review.routes.js | 评审族（姿势/背景/完整度/审图代理） |
| export.routes.js | 导出/构建 |

**services/ 首批**：storyStatesGenerate.js（状态变体编排器，从端点抽出）、placementDecision.js（摆位决策管线，见 §3.3）。

### 2.2 控制面（apps/control-server/src/server/）

```text
apps/control-server/src/server/
  controlServerCore.js    # 编排骨架（<2k 行：装配+分发）
  workflows/executors/    # step 执行器：按 action 域一文件一域，纯函数不持全局
  reasoning/              # 保持：分类/队列/看门狗/调度器已模块化
```

executor 拆分清单：storyBible / storyAssets / storyStates / storyScenes / storyExport / lifecycle / memory 各一文件；每个 executor 为纯函数（输入 step+上下文，输出 step 结果），不持全局。

### 2.3 编辑器（apps/editor/src/）

```text
apps/editor/src/
  studios/ComposeStudio.tsx  # 待拆巨件（画布+编排+属性+弹窗内联）
  canvas/                    # Pixi 舞台层
  orchestration/             # 编排操作层
  panels/                    # 右栏属性族
    modals/                  # 弹窗族归位
# 状态经 store 集中，画布命令单向流动
```

本波只拆不重构交互（交互改版属工程线 P1，不在此波混入——Tidy First）。

## 3. 拆分规则（每个迁移波必须遵守）

### 3.1 路由注册表模式
每个路由文件导出 `register<Domain>Routes(app, ctx)`；ctx 为显式依赖对象（存储路径、服务函数、配置访问器），禁止文件内隐式引用全局。装配顺序集中在 routes/index.js。

### 3.2 服务层模式
凡"编排多个端点/外部服务"的逻辑（如状态变体生成的串行编排），必须从路由抽到 services/ 纯函数：输入参数化、返回结构化结果、副作用经注入。路由只留协议层。

### 3.3 摆位决策管线（placementDecision.js）
四套摆位规则（构图需求单/状态变体/载体承载/表情差分）收敛为规则注册表：每条规则 `{ name, match(ctx), decide(ctx) }`，按序求值、首中生效、决策全程可解释（返回命中规则名，进台账）。新增规则只注册不改主干。

### 3.4 契约运行时校验层
真相源写盘路径（saveStoryAssetPlan、story.json/project.json 写入口）挂 schema 运行时校验（轻量自研校验器，零依赖）：字段类型/枚举/必填校验失败即拒绝写入并结构化报错。schema 包类型为唯一事实源，校验器由其生成规则对齐（先覆盖 PlanV1 热字段）。

### 3.5 业务面测试基座
采用 Node 自带 node:test（零新依赖）；夹具目录 testcases/fixtures/；首批覆盖确定性核心：脚本拟合、状态缺口、合并语义、摆位决策、翻译容错。命令：`npm run test:server`。

## 4. 迁移波次与验收

| 波次 | 内容 | 验收门 |
|---|---|---|
| W1 | 状态机族抽出（storyStates.routes + storyStatesGenerate 服务） | ✅ 已完成并验证（语法/启动/伪项目 404/真实幂等响应/控制面 17 测试） |
| W2 | 摆位决策管线化（placementDecision） | ✅ 已完成：services/placementDecision.js（417 行）承载四组命名决策段（A1/CARRIER/STATE/REMOVAL）+命中记录；端点 471→188 行；黄金基线逐字节对照一致、12/12 测试绿 |
| W3 | 契约运行时校验层（PlanV1 热字段先行） | ✅ 已完成：planContract.js 挂 saveStoryAssetPlan；24 个存量项目计划零误拦；单测 3 用例 |
| W4 | 业务面测试基座+首批确定性用例 | ✅ 已完成：apps/server/test/（状态缺口/合并语义/翻译容错/契约校验）11 用例全绿，npm test 接线 |
| W5 | 其余路由族迁出（8 族 118 端点）+ 控制面 30 执行器拆分 | ⚠️ 记录偏差修正（2026-10-20）：原记"index.js 13690→1550 行级"不实，该波实际止于 4,500 行；controlServerCore 15375→13377 属实。双仓测试全绿 |
| W5+ | index.js 收尾拆分 + control 续拆 + 样式域拆分（2026-10-20） | ✅ index.js 4,500→555 行装配壳（路由族全迁出）；controlServerCore 13,376→12,839（phaseExecutors 迁出）；style.css 5,573→style/ 七域文件+聚合入口（选择器零改动，级联顺序保持） |
| W6 | ComposeStudio.tsx 机械拆分（2026-10-20）：orchestration 纯函数族（normalize/runtime/storyboardPlan/stageViewport/draftStorage/utils）→ canvas（renderStage/hitTest/textures/StageToolbar/StageOverlay）→ panels（RightPanel+NodePropsFold/NodeTimelineFold/NodePlacementsFold/ComposeTopBar/ExternalUpdateBanner/ComposeLeftPanel）→ modals（StoryboardOverrideModal/LatestExportModal/SceneReviewPanel/CompletenessModal） | ✅ 已完成：12,869→7,561 行（-41%），compose/ 目录族 23 文件 6,322 行；typecheck 全绿；vite build 绿（于 src 副本验证，仓内 style.css 被并行线程残留 `//` 注释阻塞，非本波产物）；画布行为探针 9/9（节点切换/点选/拖动落盘回读/撤销恢复/缩放/平移，司马光砸缸探针副本，验完即删）。主文件未到装配壳：剩余 ~6,300 行为状态托管+编排处理器（sb* 锁定事物/批量出图链 40+ 函数深耦合组件态，只搬不改义边界外，需后续 hook 化/store 化波次） |

## 5. 风险与回退
- 每波独立提交；验证门不过整波回退（不留半截拆分态）。
- 拆分期间冻结对应域的功能新增（Tidy First：整理与功能不混提）。
- 拆分不改变任何 API 路径/请求响应语义/真相源格式——外部无感知。

## 6. 拆分裁决规则与巨文件台账（2026-10-20 声明）

> 裁决原则：**不是"全部拆分"**，按阈值裁决；拆分是手段，可维护性与二次开发可读性才是目的。

### 6.1 拆分判定（满足任一即必须拆）
1. 单文件 >1500 行；或
2. 职责域 >3 个（如 Hub.tsx 同时承载创建弹窗/草稿箱/项目卡/设置入口）；或
3. 月均变更冲突热区（多人/多 agent 同改排队）。
1000–1500 行进评审裁决；<1000 行不主动拆。纯数据/常量/生成物不拆。

### 6.2 拆分完成定义
装配壳 <200 行；路由文件纯协议层；服务/执行器为纯函数；每波过适应度函数并独立提交。

### 6.3 现存巨文件台账（2026-10-20 实测，随波次滚动更新）
| 文件 | 现状 | 裁决 | 归属波次 |
|---|---|---|---|
| apps/editor ComposeStudio.tsx | 7,561 行（2026-10-20 W6 后：状态托管+编排处理器+装配 JSX；画布/编排纯逻辑/右栏属性族/弹窗已迁至 studios/compose/ 目录族 23 文件 6,322 行） | 部分完成：剩余主体为组件态耦合的编排处理器（runStoryboard* 族/sb* 向导链），下一波按 hook/store 化拆义推进（超出"只搬不改义"边界） | W6 已落地；续波待立项 |
| apps/editor Hub.tsx | 771 行（2026-10-20：项目库+草稿条目；创建域迁 pages/CreateStoryPage，草稿通道迁 hub/draftHistory.ts） | ✅ 已完成 | U0.5 已落地 |
| apps/server index.js | 555 行装配壳（2026-10-20 W5+ 收尾：业务逻辑全迁 routes/ 九族+services/） | ✅ 已完成 | W5+ 已落地 |
| apps/editor style.css | 聚合入口 + style/ 七域（base/compose/create/hub/settings/startup/studios，2026-10-20） | ✅ 已完成（选择器零改动） | W5+ 已落地 |
| StudioSettingsModal.tsx | 已删除（2026-10-20 退役；功能在 pages/SettingsPage + settings/ 族） | ✅ 已完成 | U0.5 已落地 |
| controlServerCore.js | 12,839 行（2026-10-20：storyExecutors+phaseExecutors 已出） | 续拆：executor 族按 §2.2 清单推进至 <2k | P3 续波 |

### 6.4 架构合理性裁决口径
模块/架构是否合理，以三问裁决：依赖方向是否单向（装配→路由→服务→域）？新增能力是否只加注册项不改主干？新人/新 agent 能否按目录树定位任意端点？三问皆"是"即合理，否则列入上表排队。
