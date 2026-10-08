# 公共姿势骨架库（pose_library）

跨故事复用的 OpenPose 骨架图资产。骨架驱动的姿势变体链（2026-10-08 定型）：
**骨架图 → union ControlNet(type=openpose) 锁姿势 + IPAdapter 锁身份 + 文本词锁服装**，
解决绿幕 IPAdapter "换姿势必被拉回主参考站姿" 的确定性墙（实测坐/骑姿势全部失败后的正路）。

## 骨架清单

| 文件 | 姿势 | 视角 | 烘焙来源 | 首验场景 |
| --- | --- | --- | --- | --- |
| `sitting_desk.png` | 坐姿办公（手前伸打字） | 侧面 | 姿势源图（ComfyUI 生成） | 小明的工作日·后果一（办公桌）、结局二（沙发瘫坐复用） |
| `riding_ebike.png` | 骑电动车（扶把前倾） | 侧面 | 姿势源图（ComfyUI 生成） | 小明的工作日·后果二 |
| `standing_front.png` | 自然站立 | 正面 | 小明主参考立绘直接提取 | 小明的工作日·结局一 |

## 烘焙新骨架（补库流程）

1. 准备姿势源图（任何含目标姿势的单人图；可先用 ComfyUI 生成一张"侧视图+目标姿势"的插画）。
2. 提取骨架：
   ```bash
   node .tmp/pose_bake.mjs <源图> storage/_shared/pose_library/<名称>.png gamestudio_pose/<名称>
   ```
   链：`extractComfyuiPoseSkeleton`（apps/server/src/ai/background.js）→ DWPreprocessor（未注册时回退 OpenposePreprocessor）。
   依赖：comfyui_controlnet_aux + OpenPose 三件权重（`ckpts/lllyasviel/Annotators/`）+ venv 装 scikit-image。

## 用骨架出姿势变体立绘

```bash
node .tmp/pose_variant.mjs <身份主参考(抠图)> <骨架png> <输出png> "<英文提示词>" [w h ipStart ipWeight]
```

链：`generateComfyuiPoseVariantSprite`（union controlnet-union-sdxl-1.0 + ip-adapter-plus_sdxl_vit-h）。
**关键参数经验**（三轮对照实验得出）：

- 身份参考用**抠图**（selected_cutout webp），不要用带白底构图的原始参考图——否则 IPAdapter 会把参考图构图（站姿全身）泄漏成画面左侧的半透明"幽灵人"。
- `ipadapterStartAt=0.25`（默认 0.0/0.2 都会漏构图）；`ipadapterWeight=0.85`；`controlStrength=0.9`。
- 提示词必须以 `one single person only:` 开头，否则手部关键点簇会被读成第二个人。
- 控制图尺寸必须与潜空间一致（脚本内 sips 自动缩放到 w×h）。
- 已知墙：服装颜色受身份基图引力强（灰睡衣基图→"黑色西服"产出灰蓝西服），颜色强约束目前不可达，按"款式对即可"验收。

## 登记进故事资产（正式链）

骨架产物经 `layered-produce` 端点登记（2026-10-08 起支持 `spriteAssetPath` 直供 + `sceneIds[]` 多场景绑定）：

```json
POST /api/projects/:id/ai/story/scenes/:sceneId/layered-produce
{"poses":[{"lockName":"坐姿·办公","planAssetId":"xiao-ming","characterId":"xiao-ming",
  "spriteAssetPath":"assets/ai/.../pose_xxx.png","posePrompt":"...","sceneIds":["bn_sc_..."]}]}
```

自动完成：pose-review（可选）→ rmbg 抠图 → project.json 登记 → plan poseVariants 追加 → lock_confirm 留痕。
摆位选择优先级：compStateHit > poseHit(sceneId/sceneIds) > 表情差分 > 主参考。
