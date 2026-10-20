# 左右脑任务分工规则

> 本文定义 Control 系统中左脑（本地 OMLX）与右脑（云端 Kimi）的任务分工、路由规则和降级策略。
>
> **关联文档**：
> - `docs/archive/KIMI_RIGHT_BRAIN_SUPERVISION_PLAN.md` — 右脑监督左脑任务执行的实施计划（评估标准、修正机制、持续测试循环；完成态计划档案，已落地为 HERMES-H03）
> - `docs/archive/KIMI_RIGHT_BRAIN_TEST_PLAN.md` — 左右脑双模型架构测试规划（完成态计划档案）
>
> 更新规则：新增路由规则时同步更新本文；模型能力变化时重新评估分工边界。

---

## 1. 脑区定义

| 属性 | 左脑 🧠 | 右脑 🔮 |
|------|---------|---------|
| Provider | `omlx` | `moonshot` |
| Base URL | `http://127.0.0.1:18888/v1` | `https://api.kimi.com/coding/v1` |
| 模型 | `Qwen3.6-27B-MLX-4bit` | `kimi-for-coding` |
| 上下文窗口 | ~128K | 262,144 tokens |
| 部署方式 | 本地 OMLX 服务（direct 路由直连） | 云端 API（direct route） |
| 可用性 | 依赖本地硬件 | 依赖外网 + API Key |
| 特性 | 低成本、低延迟、隐私安全 | 大上下文、强推理、代码能力 |

---

## 2. 分工原则

### 2.1 默认路由规则

**左脑是默认路由**。所有未显式配置路由的任务一律走左脑。

### 2.2 右脑专用任务

以下任务**必须**走右脑，不可降级到左脑：

| 任务类型 | Action | 理由 |
|----------|--------|------|
| 系统元分析 | `meta_analysis` | 需要分析 286+ sessions 的历史数据，上下文需求大；需要强推理能力识别瓶颈和根因 |
| 复杂代码审查 | （预留） | 需要 deep reasoning 和跨文件关联分析 |
| 架构设计建议 | （预留） | 需要大上下文理解整个系统 |

### 2.3 左脑专用任务

以下任务**必须**走左脑，不可路由到右脑：

| 任务类型 | Action 前缀 | 理由 |
|----------|-------------|------|
| 故事生产 | `story_` | 依赖本地 ComfyUI、项目目录、资产管线 |
| TalkScene 启动/自检 | `talkscene_` | 需要操作本地进程和文件系统 |
| 文件读写 | `read_file_content`, `write_memory_file` 等 | 确定性操作，无需模型推理 |
| 日常对话回答 | `generate_default_answer` | 低延迟要求，左脑足够 |

### 2.4 禁止行为

- ❌ 右脑不可用时，meta-analysis 任务**不得**静默降级到左脑（应明确报错）
- ❌ 左脑不可用时，story workflow **不得**路由到右脑（右脑无本地资源访问能力）
- ❌ 不得在代码中硬编码路由规则（必须通过 `modelRouting.actionRoutes` / `phaseRoutes` 配置）

---

## 3. 路由配置

路由规则存储在 `config/hermes/manager.left-brain.json` 的 `workflow.modelRouting` 中。

### 3.1 当前配置

以下为 `config/hermes/manager.left-brain.json` 中 `workflow.modelRouting` 的当前真实内容（2026-08-19 核对）：

```json
{
  "workflow": {
    "modelRouting": {
      "defaultRoute": {
        "provider": "omlx",
        "baseUrl": "http://127.0.0.1:18888/v1",
        "model": "Qwen3.6-27B-MLX-4bit",
        "transport": "direct",
        "requestedTransport": "direct",
        "strict": false,
        "unavailableReason": "",
        "degradedFrom": ""
      },
      "phaseRoutes": {
        "story_blueprint_review": {
          "provider": "omlx",
          "baseUrl": "http://127.0.0.1:18888/v1",
          "model": "Qwen3.6-27B-MLX-4bit",
          "transport": "direct",
          "requestedTransport": "direct",
          "strict": true,
          "unavailableReason": "",
          "degradedFrom": ""
        }
      },
      "actionRoutes": {
        "meta_analysis": {
          "provider": "moonshot",
          "baseUrl": "https://api.kimi.com/coding/v1",
          "model": "kimi-for-coding",
          "transport": "direct",
          "requestedTransport": "direct",
          "strict": false,
          "unavailableReason": "",
          "degradedFrom": ""
        },
        "right_brain_supervision": {
          "provider": "moonshot",
          "baseUrl": "https://api.kimi.com/coding/v1",
          "model": "kimi-for-coding",
          "transport": "direct",
          "requestedTransport": "direct",
          "strict": false,
          "unavailableReason": "",
          "degradedFrom": ""
        }
      },
      "strictRouteRequiredPhases": [
        "story_blueprint_review"
      ]
    }
  }
}
```

说明：
- 左脑默认路由已改为 `transport: "direct"`（直连 OMLX，不再经 Hermes Gateway 转发）。
- `right_brain_supervision` 为右脑监察（HERMES-H03）专用 action 路由，与 `meta_analysis` 同一通道。
- `strictRouteRequiredPhases` 列出 strict 语义必须满足的 phase；hermes+strict 与左脑绑定不一致时显式失败（`route_unavailable:strict_route_model_mismatch:*`），不再静默降级（详见 `ai/memory/DECISIONS.md` 与 `ai/control_architecture.md`）。

### 3.2 解析优先级

`resolveModelRouteForPhase` 按以下优先级解析路由：

1. `options.action` → `actionRoutes[actionKey]`（最高优先级）
2. `phase` → `phaseRoutes[phaseKey]`
3. `defaultRoute`

若路由的 `provider` 与右脑的 `provider` 一致，且右脑已启用、有 API Key，则自动注入 `Authorization: Bearer {apiKey}`。

---

## 4. 代码实现规范

### 4.1 强制右脑的任务

对于必须走右脑的任务，代码中应：

1. 调用 `resolveModelRouteForPhase(binding, phase, { action: 'meta_analysis' })`
2. 检查返回的 `provider` 是否为预期值
3. 若右脑未启用，返回明确错误（不降级）

示例（`executeMetaAnalysisStep`）：

```javascript
const resolved = resolveModelRouteForPhase(binding, 'meta_analysis', { action: 'meta_analysis' })
if (resolved.provider !== 'moonshot') {
  return { success: false, error: '右脑未配置，无法执行元分析' }
}
// resolved.headers 已自动包含 Authorization
```

### 4.2 User-Agent 要求

`kimi-for-coding` 模型调用 `/chat/completions` 时需要特定的 User-Agent：

```javascript
const route = {
  ...resolved,
  headers: {
    ...resolved.headers,
    'User-Agent': 'Kilo-Code/1.0',
  }
}
```

> 注：`/models` 接口无此限制。仅 chat completions 需要。

---

## 5. 降级策略

| 场景 | 行为 |
|------|------|
| 右脑未启用 | meta-analysis 返回错误："右脑未启用，无法执行元分析" |
| 右脑 API Key 无效 | 返回错误："右脑认证失败，请检查 API Key" |
| 右脑网络不可达 | 返回错误："右脑服务不可达" |
| 左脑未运行 | story/talkscene 任务阻塞，返回错误 |
| 左脑模型未加载 | 自动触发 load，或返回降级提示 |

---

## 6. 扩展计划

已兑现项：

- ~~右脑监督左脑任务执行~~：已落地为 `right_brain_supervision` action 路由 + 治理端点（HERMES-H03，`apps/control-server/src/server/reasoning/rightBrainSupervision.js` + `routes/supervisionRoutes.js`，守护台治理页「右脑监察」区块），详见 `ai/control_architecture.md`。

未来可能新增右脑任务（仍未实现）：

- `code_review`：跨文件代码审查
- `architecture_advice`：系统架构改进建议
- `security_audit`：安全漏洞扫描

新增时需同步更新：
1. 本文档
2. `manager.left-brain.json` 的 `actionRoutes`
3. `actionRegistry.js` 和 `toolRegistry.js`
4. `executeReasoningStep` 分发逻辑（如需要）
