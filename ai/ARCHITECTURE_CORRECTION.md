# 系统架构修正 — 2026-06-06

## 之前理解错误

**错误**：认为 Control 直接生成故事内容。
**正确**：Control 只驱动 GameStudio，GameStudio 自己生成一切内容。

---

## 正确的职责边界

### GameStudio (apps/editor + apps/server) — 核心生产引擎
- **唯一的内容生产者**。所有故事生成（脚本、蓝图、合成、图片）都在 GameStudio 内部完成。
- 本地 AI：OMLX (gpt-oss-20b) 通过 Hermes Gateway 提供文本生成
- 图片生成：ComfyUI (port 8188) 通过 GameStudio Server 调用
- Editor (port 8868)：用户/Control 操作界面
- Server (port 1999)：业务 API（项目读写、编译、校验、资产、导出）

### Control (apps/control-console + apps/control-server) — 智能体编排层
- **模拟用户操作 GameStudio**，不是替代 GameStudio 生产
- 发送请求给 GameStudio Server → GameStudio 执行 → Control 监控状态
- 可以批量连续执行：创建故事 → 生成脚本 → 验证 → 下一个故事
- 为未来长篇故事自动化、自动任务编排打基础
- 监控和上报：检测生成失败、质量不足、自动重试

### 左脑 (OMLX via Hermes)
- 执行本地化任务：分类、路由、模拟用户操作 GameStudio
- 验证故事生成结果：检查结构、字数、完整性
- 连续批量执行：Story 1 → Story 2 → Story 3 ...
- **可升级可更换**：模型不是固定的，OMLX 可以换更强模型

### 右脑 (Kimi via api.kimi.com)
- 帮助左脑无法正确执行时强化左脑
- 升级、优化左脑能力（分类规则、提示词、质量门阈值）
- 最终目标：左脑能独立完成所有本地化任务，不再需要右脑介入

### Hermes Gateway (port 8742)
- OMLX 模型的统一入口
- 模型路由、负载均衡、超时重试
- **持续升级**：Hermes 本身在更新，模型能力在增强

---

## 数据流（正确的）

```
Control Console (用户/Agent)
    ↓
Control Server (编排/监控)
    ↓ 发送操作请求（创建项目、生成脚本、编译蓝图...）
GameStudio Server (业务后端)
    ↓ 调用本地 AI / ComfyUI
GameStudio Editor (生产界面)
    ↓ 生成内容
    ↓ 返回结果
Control Server (验证/记录)
    ↓ 继续下一个故事或上报问题
```

---

## Control 的具体职责

1. **模拟用户操作**：代替用户点击 Editor 中的按钮
2. **批量自动化**：连续创建 10 个、20 个故事，不需要人工干预
3. **状态监控**：实时检查 GameStudio 的生成进度、成功/失败
4. **自动验证**：检查生成的脚本结构、字数、完整性
5. **问题上报**：检测到缺陷时记录、上报、尝试自动修复
6. **模型无关**：不依赖特定模型，左脑模型可以更换

## GameStudio 的具体职责

1. **接收 Control 的操作请求**
2. **调用本地 OMLX 模型生成内容**（通过 Hermes）
3. **调用 ComfyUI 生成图片**
4. **编译、校验、导出故事**
5. **返回状态给 Control**

---

## 当前实现偏差与修正计划

### 偏差 1：Control 直接生成内容
- 现状：Control 的 story workflow 中，部分步骤在 Control 侧直接调用模型生成内容
- 修正：所有内容生成请求必须发给 GameStudio Server，由 GameStudio 调用本地 AI

### 偏差 2：混淆 Control 和 GameStudio 的生成边界
- 现状：story_generate_scripts_candidate 等步骤可能混淆了调用方
- 修正：明确 Control 只发送操作指令，GameStudio 执行并返回结果

### 偏差 3：缺少批量执行和自动验证机制
- 现状：单次执行有，但批量连续执行和自动验证不够完善
- 修正：添加批量 story 生产 workflow，自动验证脚本质量

### 偏差 4：缺少问题上报和自动修复
- 现状：失败时记录日志，但缺少系统性上报和修复尝试
- 修正：建立缺陷记录 → 分析 → 修复 → 验证的闭环

---

## 下一步行动

1. **修正 Control → GameStudio 的调用边界** — 确保所有生成操作走 GameStudio API
2. **完善批量执行 workflow** — 支持连续生成 N 个故事
3. **建立自动验证机制** — 脚本结构、字数、完整性检查
4. **建立问题上报通道** — 缺陷自动记录到 ai/memory/ 和 state/
5. **持续更新文档** — AGENTS.md、MEMORY.md、STATUS.md 实时同步
