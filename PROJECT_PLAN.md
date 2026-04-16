# game_studio - P1 M2 推进计划

## 当前主线

- 当前默认主线不是泛化基建补全，而是“稳定生产 H5 交互小故事”。
- 自动推进时按以下链路判断优先级：
  - 故事创建
  - 脚本转蓝图
  - 连续性约束
  - 场景图生成
  - 合成与导出
  - 测试与验收
- `memory/TASK_QUEUE.md` 是短期推进顺序的任务源；本文件保留中期计划和技术方向。

## 文档定位

- 本文件是中长期规划，不作为实时执行状态来源。
- 实时状态、阻塞项、下一步动作请以 `memory/STATUS.md` 与 `memory/TASK_QUEUE.md` 为准。

## 📋 目标
将项目从"功能可用"升级为"稳定生产可用"

### 验收标准
- [ ] **服务稳定性**: 连续 7 天无崩溃，健康检查成功率 > 99%
- [ ] **资产生成质量**: assetRefs 传递准确率 > 90%，漂移率 < 10%
- [ ] **编辑器可用性**: 核心功能（场景编辑、资产锁定、出图）无阻塞 bug
- [ ] **Agent 自治能力**: 可独立完成日常巡检、任务推进、状态更新
- [ ] **文档完整性**: AGENTS.md、MEMORY.md、PROJECT_PLAN.md 保持同步更新

---

## 🔍 任务完成日志（2026-03-11）

### ✅ 任务 1：环境检查与依赖安装
- [x] `package.json` 结构检查 (monorepo)
- [x] `apps/server/package.json` 检查
- [x] `apps/editor/package.json` 检查
- [x] `npm install` 完成
- [x] `.env.local` 检查（不存在，使用 env.js 动态配置）

### ✅ 任务 2：服务启动
| 服务 | 端口 | 状态 | Session ID |
|------|------|------|------------|
| Server API | 1999 | ✅ Running | briny-shore |
| Editor (Vite) | 8868 | ✅ Running | kind-meadow |

### ✅ 任务 3：M2 代码探索完成

---

## 🎯 M2 任务清单

### M2.1 批量任务队列化 ⏳ UNIMPLEMENTED
**现状**: 无批量接口，当前均为同步单项目处理

- [ ] 批量创建项目 API (`/api/projects/batch/create`)
- [ ] 提示词生成任务队列化 (需要 bull/pq)
- [ ] 出图任务队列化 (已有 `/api/studio/image/test` 单个接口)
- [ ] 支持暂停操作
- [ ] 支持取消操作（已有 `AbortController` in timeout）
- [ ] 支持续跑功能
- [ ] 门控与重试组合使用

**现有相关代码**:
- `/api/projects/ai/create` - 单项目创建 (timeout: 90s)
- `/api/projects/:id/ai/regenerate` - 单项目重新生成
- `/api/studio/image/*` - 单个图片生成接口

---

### M2.2 超时策略统一 ✅ PARTIALLY IMPLEMENTED
**现状**: 已有 timeoutMs 参数，但无统一管理

| API | Default Timeout | Max | Min |
|-----|-----------------|-----|-----|
| AI Scripts Generate | 90,000ms | - | - |
| AI Background Image | 60,000ms | 300,000ms | 5,000ms |
| ComfyUI Collect | 15,000ms | - | - |
| Doubao Request | 8,000ms | 30,000ms | 1,000ms |

- [x] 文本生成超时策略 (`clampInt(q.timeoutMs, min, max, default)`)
- [x] 图像生成超时策略
- [ ] 支持 `none` 模式（无超时） - 需添加
- [ ] 超时配置可持久化 (当前在 studio/settings.json 中)

**现有实现**:
```javascript
const timeoutMs = clampInt(q.timeoutMs, 1_000, 30_000, 8_000)
const t = setTimeout(() => controller.abort(), timeoutMs)
```

---

### M2.3 Provider 健康检查 ⏳ UNIMPLEMENTED
**现状**: 仅有基础 `/api/health`，无 Provider 级别检查

- [ ] 连通性检查标准化 (DNS / TLS / Proxy)
- [ ] 深度可用检查 (实际 API 调用测试)
- [ ] 健康状态展示 (UI + API)
- [ ] 自动降级策略 (fallback provider)

**现有实现**:
```javascript
app.get('/api/health', (c) => c.json({ ok: true, service: 'game_studio_server' }))
```

---

## 📊 P1 vs M2 对比

| 功能 | P1 状态 | M2 需求 |
|------|--------|--------|
| 单项目创建 | ✅ Complete | N/A |
| AI 脚本生成 | ✅ Complete | Batch + Queue |
| 蓝图编译 | ✅ Complete | Batch Support |
| Provider 切换 | ✅ Complete | Health Check |
| 任务取消 | ⚠️ Partial (AbortController) | UI Control |
| **批量任务** | ❌ N/A | ✅ Need Implement |
| **任务队列** | ❌ N/A | ✅ Need Implement |
| **健康检查** | ⚠️ Basic | ✅ Need Deep Check |

---

## 🔧 技术实现建议

### M2.1 实现方案
```bash
# 安装 Bull (Node.js Job Queue)
npm install bull redis

# 或轻量级 pq
npm install pq
```

API Design:
```javascript
POST /api/batch/projects/create
{
  "prompts": [
    { "prompt": "...", "title": "..." },
    // ...
  ],
  "provider": "doubao",
  "parallelism": 3,  // 并发数
  "timeoutMs": 120000
}

// Response
{
  "batchId": "uuid",
  "total": 10,
  "status": "queued",
  "url": "/api/batch/:batchId/status"
}
```

### M2.3 实现方案
```javascript
POST /api/providers/health/check
{
  "provider": "doubao",
  "deepCheck": true  // 实际调用测试
}

// Response
{
  "provider": "doubao",
  "status": "ok|degraded|down",
  "latencyMs": 234,
  "lastError": null,
  "suggestion": "use"
}
```

---

## 📂 代码地图

### Server (apps/server/src/)
```
index.js          # 主入口，所有 API 端点 (3684 行)
├── ai/           # AI Provider 模块
│   ├── scripts.js      # 脚本生成分发
│   ├── analyze.js      # 脚本结构分析 ✅
│   ├── openai.js       # OpenAI Provider ✅
│   ├── doubao.js       # 豆包 Provider ✅
│   ├── ollama.js       # Ollama Provider ✅
│   └── background.js   # AI 背景图生成
├── blueprint/    # 蓝图编译
│   ├── compile.js      # cards → choices ✅
│   └── validate.js     # 蓝图验证 ✅
├── studio/       # 项目状态
│   ├── projectState.js # 状态规范化 ✅
│   └── settings.js     # 设置管理
└── plugins/story-pixi/ # Pixi.js 故事引擎

scripts/          # 测试脚本
├── test_doubao_*.mjs
├── test_ollama_*.mjs
└── test_p1_*.mjs
```

### Editor (apps/editor/src/)
```
api.ts            # API Client TypeScript definitions ✅
schema/           # Shared types (@game-studio/schema)
```

---

## 📊 进度跟踪

- **启动时间**: 2026-03-11 17:32
- **Executor**: Remote Qwen 3.5 (subagent:d4b37afd)
- **Manager**: cloud-doubao
- **Status**: ✅ Exploration Complete, M2 Implementation Pending

### 下一步行动
1. Reviewer 评估当前探索结果
2. Manager 决定 M2 实施优先级
3. Executor 根据决策实现具体功能

---

## 📝 References
- `memory/2026-03-11.md` - 详细执行日志
- `apps/server/src/index.js` - Main server code
- `apps/server/src/ai/scripts.js` - Script generation
- `apps/server/src/ai/analyze.js` - Script analysis
- `apps/editor/src/api.ts` - API client types

---

*Last updated: 2026-04-14 by Copilot (plan positioning refresh)*
