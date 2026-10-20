---
status: 评审中
owner: 规则统筹师（待任命）
version: v1.0-draft
updated: 2026-10-20
---
# 设置定义（能力装配台）

> 类型：**全局定义（送审版）**——定义完整目标产品的设置界面，超前于当前实现；语音、视频等能力未落地不影响其定义成立（实现状态只在 §11 实现映射登记）。
> 定义效力：本文是设置界面的唯一真相源；实现与本文冲突时，改实现或修订本文，不允许两边漂移。
> 定位依据《UI 设计规范》§1：TalkScene 是本地部署工具，模型矩阵可配置是核心卖点，**设置是一等功能区**。观感与分区规则见《UI 设计规范》§6。

## 1. 定位

设置 = **本地 AI 能力矩阵的装配台**，回答四个问题：

1. 我的工具用哪些模型？（模型矩阵：文本/视觉/图像/语音/视频）
2. 服务在哪里？（各服务地址）
3. 凭据配好了吗？（接口 Key）
4. 现在能不能用？（当前生效 + 诊断）

设置是独立页面（路由可达），不是弹窗。页首固定"保存并应用"与"当前生效"摘要。

## 2. 能力矩阵总览（组织图）

```chart org
设置·能力装配台
  文本模型族
    故事分镜
    图像提示词
    提示词翻译
  视觉模型族
    审核模型·完整度核实
    姿势评审通道
  生成服务族
    图像服务
    语音·TTS
    视频合成
  界面与数据
    主题与语言
    存储
  基础设施
    守护台关联
    接口Key
    网络代理
    诊断
    关于
```

## 3. 页面结构（组织图）

```chart org
设置页
  页首
    当前生效·只读摘要条
    保存并应用
  模型矩阵区
    故事分镜卡
    图像提示词卡
    提示词翻译卡
    审核模型卡
    图像服务卡
    语音卡
    视频卡
  界面区·主题与语言
  存储区
  接口Key区
  网络区
  诊断区
  关于区
```

每区一张折叠卡：模型矩阵默认展开，其余默认收起；技术语言集中诊断区与关于区。

## 4. 页首与全局行为

### 4.1 当前生效摘要条（只读）
每能力一行，格式统一 `用途：provider / model`；未启用显示"已停用"，启用但未配置显示"未配置"（警告色）。行序固定：故事分镜 / 图像提示词 / 提示词翻译 / 审核模型 / 图像服务 / 语音 / 视频；末尾一行界面偏好（主题 · 语言）。摘要随保存即时刷新。

### 4.2 保存并应用
- 有未保存修改时才可点（脏态感知）；保存中禁用并显示进度；成功给吐司确认；失败给原因且**保留编辑内容不清空**。
- 离开页面有未保存修改时给确认（放弃/继续编辑）。
- 写盘只经服务端，前端不留副本；每次写入更新 `updatedAt`。

## 5. 卡片统一部件契约

模型矩阵区每张能力卡由同一套部件组成（缺一部件需在条目内声明理由）：

| 部件 | 定义 |
|---|---|
| 启用开关 | 对应 `enabled.<key>`；关=该能力全站动作阻断，卡内其余部件灰显保留值 |
| 状态灯 | 已配置（绿）/ 未配置（黄）/ 检测中（蓝）/ 不可用（红，附原因） |
| Provider | 下拉，切换后模型与地址按该 Provider 的记忆值回填 |
| 模型 | 下拉+手输；每 Provider 记忆最近用过的模型清单，可单条删除 |
| 接口地址 | 按 Provider 显示对应标签（OXML URL / Ollama URL / Base URL / 接口 URL） |
| 连通动作 | 文本族=测试连接；语音=试听；图像/视频=试跑；审核=测试连接；结果进运行日志 |
| 折叠行为 | 卡标题行常显状态灯+当前值摘要，展开后才显示全部配置项；**启用开关从停用切到启用时卡片自动展开**（让配置立即可见） |

## 6. 配置数据模型（目标全集；真相源 `storage/_config/studio_settings.json`）

| 键 | 含义 | 取值/结构 | 默认 |
|---|---|---|---|
| `enabled` | 能力总开关 | `scripts / prompt / image / tts / video` 五个布尔；关=对应动作全站阻断 | 文本族与图像开，tts/video 关 |
| `scripts` | 故事分镜文本模型 | `provider / model / apiUrl` | localoxml |
| `prompt` | 图像提示词文本模型 | 同上 | localoxml |
| `translation` | 提示词翻译文本模型 | 同上；未配时跟随 `prompt` | 跟随 |
| `image` | 图像服务 | `provider / model(checkpoint) / loras / size / apiUrl / sdwebuiBaseUrl / comfyuiBaseUrl / comfyuiModelsRoot / activeStylePreset / stylePresets` | comfyui |
| `review` | 审核模型（视觉） | `provider / model / apiUrl` + 姿势评审独立通道 `poseReviewProvider / poseReviewModel / poseReviewBaseUrl` | auto |
| `tts` | 语音合成 | `provider / model / voice / speed / format / apiUrl` | edge，speed=1.0，format=mp3 |
| `video` | 视频合成 | `provider / resolution / fps / bitrate / subtitleStyle / audioTrack / apiUrl` | local，1080p，30fps，码率自动 |
| `appearance` | 界面偏好 | `theme`（主题包名）/ `locale`（BCP 47） | dark / zh-CN |
| `storage` | 存储 | `root`（存储根路径，支持外部目录） | 仓内 storage/ |
| `control` | 守护台关联 | `leaseEnabled`（资源租约开关）/ `baseUrl`（守护台地址） | true / `http://127.0.0.1:2099` |
| `secrets` | 接口 Key | `openaiApiKey / localoxmlApiKey / doubaoArkApiKey` | 空 |
| `network` | 网络 | `proxyUrl` | 空=直连 |

schema 演进经 `schemaVersion` 迁移：新增键带默认回填，废弃键迁移后清除，迁移记录进运行日志。

## 7. 模型矩阵逐功能说明

### 7.1 故事分镜（文本）
- **是什么**：一句话创意 → 脚本层草稿的生成模型。
- **Provider**：`localoxml`（本地 OMLX）/ `ollama` / `openai`。
- **配置项**：按 §5 部件契约。
- **行为与异常**：保存即生效；测试连接回报延迟与模型名；服务不可达时状态灯转红并给"检查服务是否启动"指引；未启用或缺配置时，新建故事的"生成"阻断并直达本卡。

### 7.2 图像提示词（文本）
- **是什么**：出图提示词的增强/扩写模型（抽卡、锁定测试、场景渲染的提示词加工）。
- 配置与行为同 7.1，独立 Provider/模型/地址。

### 7.3 提示词翻译（文本）
- **是什么**：中文提示词 → 英文出图提示词的翻译模型（出图模型只认英文锚点）。
- **缺省规则**：未单独配置时自动跟随"图像提示词"，摘要条显示"跟随图像提示词"。

### 7.4 审核模型（视觉）
- **是什么**：两条视觉评审通道——①完整度核实（逐节点画面评审）；②姿势一致性评审（姿势变体对锁定主参考的比对）。
- **Provider**：`moonshot`（Kimi 视觉，外部计费）/ `omlx`（本地视觉模型，需支持图片输入）/ `auto`（有 Kimi Key 走 Kimi，否则本地）/ `off`。
- **配置项**：完整度核实一组 `provider/model/apiUrl`；姿势评审独立一组 `poseReviewProvider/poseReviewModel/poseReviewBaseUrl`。
- **行为**：评审通道不可用时对应门禁 fail-closed 挂起待处置，不盲批（安全边界，不在本页放宽）。

### 7.5 图像服务（出图）
- **是什么**：全部图片生成的执行后端。
- **Provider**：`comfyui`（本地工作流）/ `sdwebui`（本地 WebUI）/ `doubao`（外部 API）。
- **配置项**：
  | 项 | 说明 |
  |---|---|
  | checkpoint / 模型 | sdwebui 可自动拉取模型列表（老版本不支持则手填），带预置清单 |
  | LoRA 栈 | `名称:权重` 列表，按序注入 |
  | 默认尺寸 | `宽x高` |
  | 服务地址 | sdwebuiBaseUrl / comfyuiBaseUrl / doubao apiUrl |
  | ComfyUI 模型目录 | 本地模型根路径（能力自检用）；目录缺失时状态灯转黄并提示 |
  | 风格预设 | `activeStylePreset` 激活一份 `stylePresets` 预设 |
- **风格预设**：一份预设 = checkpoint + LoRA 栈（显式/角色动物/默认风格三层）+ 风格锁定句 + 道具风格句与排除词 + 场景安静区措辞 + 各剖面尺寸矩阵 + 审核链说明 + 压缩策略。预设管理动作：新建 / 复制 / 删除 / 从生产样本沉淀；生产验证过的预设删除需二次确认；切换预设即整链出图风格切换。

### 7.6 语音 TTS
- **是什么**：语音合成能力——角色配音、旁白朗读、预演视频音轨的来源。
- **Provider**：`edge`（免费·联网·推荐）/ `say`（本机内置·离线）/ `doubao`（外部 API，未接入）/ `openai`（外部 API）/ `local`（自定义接口，经接口地址接入）。
- **配置项**：Provider；模型（openai/local）；`voice` 音色（按 Provider 预设清单下拉，可手填）；`speed` 语速（0.5–2.0）；`format`（mp3/wav，wav 仅部分 Provider 可用）；接口地址（openai/local）；启用开关；**试听**（真实合成一句样例并即时播放，产物留档 `storage/_shared/tts_previews/`）。
- **行为与异常**：未启用或缺配置时，一切配音/音轨动作阻断并直达本卡；试听失败给原因（引擎缺失/网络/凭据/音色不存在）与下一步建议；edge 需联网，离线兜底用 say。
- **音色库（按角色分组，2026-10-20，真相源 `apps/server/src/ai/ttsVoices.js`）**：edge 免费音色 + 音高/语速微调派生；故事角色绑定复用预设 id，也兼容裸引擎音名。

  | 组 | 预设 id | 中文名 | 引擎音 | 微调 |
  |---|---|---|---|---|
  | 女声 | female_gentle | 温柔女声 | zh-CN-XiaoxiaoNeural | — |
  | 女声 | female_lively | 活泼女声 | zh-CN-XiaoyiNeural | — |
  | 男声 | male_sunshine | 阳光男声 | zh-CN-YunxiNeural | — |
  | 男声 | male_deep | 浑厚男声 | zh-CN-YunyangNeural | — |
  | 男声 | male_passion | 激昂男声 | zh-CN-YunjianNeural | — |
  | 童声 | child_boy | 男童声 | zh-CN-YunxiaNeural | +6Hz |
  | 童声 | child_girl | 女童声 | zh-CN-XiaoyiNeural | +20Hz · +4% |
  | 长辈 | elder_male | 老年男声 | zh-CN-YunyangNeural | -18Hz · -8% |
  | 长辈 | elder_female | 老年女声 | zh-CN-XiaoxiaoNeural | -16Hz · -8% |
  | 特色 | dialect_liaoning / dialect_shaanxi | 东北/陕西女声（方言彩蛋） | zh-CN-liaoning-XiaobeiNeural / zh-CN-shaanxi-XiaoniNeural | — |

  离线兜底（say，无音高可调）：婷婷 Tingting（女）/ 美佳 Meijia（女）/ 思南 Sinan（男）。
  试听样例存放 `storage/_shared/tts_previews/`（`sample_<预设id>.mp3` 四音色样例 + `preview_<ts>` 试听留档，自动保留最近 10 份）。

### 7.7 视频合成
- **是什么**：预演视频的合成后端——场景帧序列 + 字幕轨 + 配音轨 → 可分享的演示视频文件。
- **Provider**：`local`（本地合成，ffmpeg 链路）/ 外部 API（经接口地址接入）。
- **配置项**：
  | 项 | 说明 |
  |---|---|
  | 分辨率 | 预设档位（720p / 1080p / 竖屏 1080×1920） |
  | 帧率 | 24 / 30 fps |
  | 码率 | 自动 / 手动 kbps |
  | 字幕样式 | 字号/位置/底色（取令牌，与导出运行时一致） |
  | 音轨绑定 | 旁白音源 = 语音 TTS（§7.6）；未启用 TTS 时可无声合成 |
  | 接口地址 | 外部 API 时填写 |
- **行为**：衔接导出链（项目卡「导出视频」）；未启用时该动作阻断并直达本卡；合成是长任务，进任务指示器与 `/ai/tasks` 台账。

## 8. 联动规则（声明）

| 规则 | 定义 |
|---|---|
| 翻译跟随 | `translation` 未配置时取 `prompt` 的同组值；一旦单独保存即解除跟随 |
| 音轨绑定 | `video.audioTrack=tts` 时，视频合成读取语音卡当前生效值；TTS 未启用=无声合成并提示 |
| 预设联动 | 切换 `activeStylePreset` 后，出图链（抽卡/锁定/线稿/场景）下一次调用即按新预设执行，不回溯已产出图 |
| 总开关优先 | `enabled.<key>=false` 时该能力一切动作阻断，不论配置是否完整 |

## 9. 界面与基础设施逐功能说明

### 9.1 界面偏好
- **主题**：主题包下拉（默认 `dark`；主题包即《设计令牌与主题扩展规范》§6 的语义层覆写包），切换即时生效、零重渲染。
- **语言**：语言包下拉（默认 `zh-CN`；BCP 47 命名、RFC 4647 回退），切换即时生效；缺译条目回落默认语言并标记待译。

### 9.2 存储
- **配置项**：存储根路径（默认仓内 `storage/`，可改外部目录，改后重启生效并做写权限自检）；「打开项目目录」直达文件管理器；创作缓冲（journal+快照）容量一览。

### 9.3 接口 Key
- **是什么**：外部服务商凭据（OpenAI / localoxml / Doubao 三条）。
- **行为**：输入框显示当前生效掩码值（如 `****x123`）并标注来源（env / server 配置）；「显示」临时明文、「清空」移除、「保存」写服务端真相源；离开字段自动保存；刷新页面不丢已保存 Key。
- 纪律：Key 只写服务端配置，不进入前端缓存与任何日志。

### 9.4 网络代理
- `proxyUrl`，用于需要代理的文本请求（如 OpenAI）；留空=直连。

### 9.5 守护台关联
- **是什么**：与守护台（local-agent-control）资源租约的关联开关——TalkScene 重负载本地资源调用（文本生成/出图/视觉评审）是否经守护台统一调度。
- **配置项**：启用开关（`control.leaseEnabled`，默认开）；守护台地址（`control.baseUrl`）；「测试连接」（探测守护台健康，内联结果行）。
- **行为**：开启=托管模式——守护台统一调度本机重负载算力，守护台离线即阻断以保护内存墙（fail-closed）；关闭=独立模式——直连本地模型，无互斥保护，TalkScene 脱离守护台自足运行。环境变量 `STUDIO_RESOURCE_LEASE_ENABLED` 显式设定时优先于本开关（独立调试语义保留）。
- 定位：这是"守护台不是准入后端"（《概要设计说明书》§1.2.1）在用户界面的落点。

### 9.6 诊断
- **快速检测**清单：
  | 检测项 | 动作 | 消耗标注 |
  |---|---|---|
  | 浅检 | 连通性 + 配置完整性（全部能力） | 零消耗，默认 |
  | 深检文本 | 实跑一轮文本生成 | 勾选确认，标注预计时长 |
  | 深检出图 | 实跑一张图 | 勾选确认，标注消耗与时长 |
  | 深检语音 | 合成 5 秒样例 | 勾选确认 |
  | 深检视频 | 合成 3 秒样片 | 勾选确认 |
- **运行日志**：本页操作与检测结果的留痕区（每条=时间+对象+结果）；清空需确认；可打包导出（进关于区）。

### 9.7 关于
- 版本号与构建标识、文档站（docsys）入口、许可证、诊断信息打包导出（供二次开发/报障）。

## 10. 生效与阻断逻辑（逻辑图）

```chart flow
edit: 修改配置
save: 保存并应用
persist: 写真相源
load: 运行时读取
gate: 已启用且已配置？
pass: 动作放行
block: 阻断并给配置入口
edit -> save -> persist -> load -> gate
gate -> pass: 是
gate -> block: 否
block -> edit: 一键跳到对应卡
```

阻断矩阵（能力未启用/未配置时被阻断的动作）：

| 能力 | 被阻断动作 |
|---|---|
| 故事分镜 | 新建故事生成、脚本再生成 |
| 图像提示词 | 提示词增强、AI 解析提示词 |
| 提示词翻译 | 出图前翻译（阻断出图链上游） |
| 审核模型 | 完整度核实、姿势评审（fail-closed 挂起） |
| 图像服务 | 抽卡/锁定测试/线稿/场景渲染一切出图 |
| 语音 | 配音、音轨生成、试听 |
| 视频 | 导出视频 |

## 11. 代码结构（真相文件树，以仓内文件为准）

```text
apps/editor/src/
  pages/SettingsPage.tsx         # 设置路由：页首摘要 + 分区折叠卡
  settings/EffectiveSummary.tsx  # 当前生效只读摘要条（§4.1 行序固定）
  settings/SectionCard.tsx       # 卡片统一部件契约（§5：开关/状态灯/Provider/模型/地址/连通）
  settings/ModelSectionCard.tsx  # 文本族三卡（故事分镜/图像提示词/提示词翻译）
  settings/ReviewCard.tsx        # 审核模型 + 姿势评审独立通道
  settings/ImageServiceCard.tsx  # 图像服务：provider/checkpoint/LoRA/尺寸/风格预设管理
  settings/TtsCard.tsx           # 语音：provider/音色/语速/试听
  settings/VideoCard.tsx         # 视频：分辨率/帧率/码率/字幕/音轨绑定
  settings/AppearanceCard.tsx    # 主题与语言
  settings/StorageCard.tsx       # 存储根路径 / 打开目录 / 创作缓冲
  settings/SecretsPanel.tsx      # 接口 Key：显示/清空/保存/来源标注/自动保存
  settings/NetworkPanel.tsx      # 网络代理 proxyUrl
  settings/ControlLinkCard.tsx   # 守护台关联：租约开关/地址/连通测试
  settings/DiagnosticsPanel.tsx  # 快速检测清单 + 运行日志
  settings/AboutPanel.tsx        # 版本 / 文档站 / 许可证 / 诊断打包
  settings/settingsApi.ts        # 设置读写（经 server，不落前端缓存）
server 侧
  routes/studio.routes.js        # 设置读写 / 密钥管理端点
storage/_config/studio_settings.json  # 真相源（§6 数据模型）
```

实现映射：当前实现为 `apps/editor/src/StudioSettingsModal.tsx` 单文件全屏弹窗（1,789 行，含文本族/审核/图像服务/Key/网络/诊断与模型记忆逻辑），按《UI 设计规范》§6/§7 迁移为独立页面与上树组件，已验证行为（模型记忆、自动保存、检测链路）原样迁移。**定义先行项**：语音 TTS（§7.6）、视频合成（§7.7）、界面偏好（§9.1）、存储区（§9.2）、关于区（§9.7）——随对应能力版本落地，定义不变。

> 注记（2026-10-20 第四波）：守护台关联（§9.5）已实施上线——`control` 节入 schema（v1.2），租约运行时开关+地址+连通测试可用；env 显式设定优先语义保留。旧弹窗 StudioSettingsModal 已于同日退役删除。

> 注记：设置页 V1 已实施（2026-10-20，`apps/editor/src/pages/SettingsPage.tsx` + `apps/editor/src/settings/` 组件族，数据模型 schemaVersion 1.1），弹窗 `StudioSettingsModal.tsx` 冻结待退役。
> 注记（2026-10-20 第二波）：语音 TTS 试听已上线——edge（tools/tts-venv 的 edge-tts，联网）与 say（本机内置，离线）真实合成并播放，openai/local 走 `/audio/speech`，doubao 诚实报 `tts_provider_pending`；测试连接内联结果行（任务A）同步落地；视频合成仍为定义先行。
> 注记（2026-10-20 第三波）：角色音色库上线（§7.6 音色库表，`apps/server/src/ai/ttsVoices.js`）——女声/男声/童声/长辈四组九音色 + 方言彩蛋特色组，edge 音高微调派生女童/长辈；`voice` 兼容预设 id 与裸引擎音名；四音色样例实跑留档 `storage/_shared/tts_previews/sample_*.mp3`。

## 12. 自适应与令牌

- ≥1440 两列卡栅；1024–1440 单列+摘要条吸顶；<1024 单列全宽。
- 全部样式取 `--ts-*` 令牌；检测/日志等诊断组件进组件层令牌，不另造样式。
