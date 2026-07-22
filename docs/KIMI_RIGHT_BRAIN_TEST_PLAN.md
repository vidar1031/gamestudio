# 左右脑双模型架构 — 测试规划

> 本文定义右脑（Kimi）接入后的完整测试策略，覆盖引导流程、双模型启动、元分析能力、分工规则验证和**左脑监督评估**。
>
> **关联文档**：
> - `ai/BRAIN_DIVISION.md` — 左右脑任务分工规则
> - `docs/KIMI_RIGHT_BRAIN_SUPERVISION_PLAN.md` — 右脑监督左脑任务执行的完整实施计划（含评估标准、修正机制、持续测试循环）

---

## 1. 测试目标

| 目标 | 说明 |
|------|------|
| T1 | 验证 `restart_control.sh` 后自动打开浏览器，引导流程正常显示 |
| T2 | 验证左脑（OMLX）一键启动完整链路：保存 → 自检 → 启动 → 就绪 |
| T3 | 验证右脑（Kimi）配置保存、探测、自检链路 |
| T4 | 验证双模型同时就绪后，元分析任务走右脑路由 |
| T5 | 验证分工规则：左脑任务不走右脑，右脑任务不走左脑 |
| T6 | 验证引导者状态条根据系统状态正确切换 |

---

## 2. 测试环境

```bash
# 前置条件
node -v  # v18+
npm -v   # v9+

# 服务端口
Control Server : 2099
Control Console: 8870
GameStudio Server: 1999
GameStudio Editor: 8868
OMLX (左脑)   : 18888
Kimi API (右脑): https://api.kimi.com/coding/v1

# 环境变量（.env.local）
MOONSHOT_API_KEY=sk-...
```

---

## 3. 测试用例

### TC-01: 重启脚本自动打开浏览器

| 项 | 内容 |
|----|------|
| 前置 | macOS 系统，有 `open` 命令 |
| 步骤 | 1. 终端执行 `sh scripts/lifecycle/restart_control.sh` |
| 期望 | 1. control-server 和 control-console 正常启动<br>2. 日志输出 `🌐 正在打开控制台...`<br>3. 浏览器自动打开 `http://127.0.0.1:8870` |
| 通过标准 | 浏览器成功打开控制台页面 |

---

### TC-02: 引导者状态条 — 左脑未启动

| 项 | 内容 |
|----|------|
| 前置 | Control Console 已加载，左脑未运行 |
| 步骤 | 1. 打开 `http://127.0.0.1:8870`<br>2. 观察页面顶部引导状态条 |
| 期望 | 显示黄色警告条：`⚡ 左脑未启动` + 说明文字 + `一键启动` 按钮 |
| 通过标准 | 状态条正确显示，一键启动按钮可点击 |

---

### TC-03: 引导者状态条 — 左脑就绪、右脑未启用

| 项 | 内容 |
|----|------|
| 前置 | 左脑已启动运行，右脑 `enabled: false` |
| 步骤 | 1. 完成左脑一键启动<br>2. 观察引导状态条变化 |
| 期望 | 显示绿色成功条：`✅ 左脑就绪` + 提示可在引擎配置中启用右脑 |
| 通过标准 | 状态条从黄色变为绿色，文字正确 |

---

### TC-04: 引导者状态条 — 双脑就绪

| 项 | 内容 |
|----|------|
| 前置 | 左脑已启动，右脑已启用且探测通过 |
| 步骤 | 1. 在引擎配置中启用右脑<br>2. 配置 Moonshot provider + API Key + `kimi-for-coding`<br>3. 点击保存<br>4. 点击探测右脑<br>5. 观察引导状态条 |
| 期望 | 显示绿色成功条：`✅ 系统就绪` + `左脑运行中，右脑探测通过。可以开始工作。` |
| 通过标准 | 状态条显示系统就绪，一键启动按钮消失 |

---

### TC-05: 一键启动 4 步链路

| 项 | 内容 |
|----|------|
| 前置 | 左脑配置未保存或未启动，右脑已启用且已配置 |
| 步骤 | 1. 点击引导状态条中的 `⚡ 一键启动` 按钮 |
| 期望 | 依次显示：<br>- `步骤 1/4：保存左脑配置...`<br>- `步骤 2/4：运行左脑自检...`<br>- `步骤 3/4：启动 Hermes runtime...`<br>- `步骤 4/4：探测右脑连通性...`<br>最终显示：`✅ 一键启动完成。左脑已就绪，右脑探测通过。` |
| 通过标准 | 4 步全部成功，无错误中断 |

---

### TC-06: 右脑配置保存与探测

| 项 | 内容 |
|----|------|
| 前置 | Control Console 已加载 |
| 步骤 | 1. 进入「引擎配置」→「右脑」标签<br>2. 开启 enabled 开关<br>3. Provider 选择 `Moonshot (Kimi)`<br>4. 填写 API Key<br>5. 点击保存<br>6. 点击 `🔮 探测右脑` |
| 期望 | 1. 保存成功，配置写入 `config/hermes/manager.left-brain.json`<br>2. 探测返回模型列表，包含 `kimi-for-coding`<br>3. 探测状态显示 `accessible: true` |
| 通过标准 | 配置持久化成功，探测返回 200，模型信息正确 |

---

### TC-07: 元分析端到端调用

| 项 | 内容 |
|----|------|
| 前置 | 左右脑双模型就绪 |
| 步骤 | 1. 进入 reasoning chat<br>2. 输入 `系统元分析` |
| 期望 | 1. Plan 生成包含 `meta_analysis` action<br>2. 步骤执行显示：`正在聚合系统运行数据...` → `数据聚合完成: N 个会话` → `正在调用右脑模型 kimi-for-coding 进行分析...` → `元分析完成 (tokens: X)`<br>3. 返回结构化分析报告 |
| 通过标准 | meta_analysis 步骤成功，answer 非空，走右脑路由 |

---

### TC-08: 元分析路由验证（不走左脑）

| 项 | 内容 |
|----|------|
| 前置 | 左右脑双模型就绪，左脑 OMLX 在 18888 |
| 步骤 | 1. 触发元分析<br>2. 检查 control-server 日志 |
| 期望 | 日志显示 `[MODEL_TASK] phase=meta_analysis transport=direct model=kimi-for-coding`<br>不应出现 `transport=hermes` 或 `model=gpt-oss-20b` |
| 通过标准 | 确认请求发往 `api.kimi.com`，非本地 18888 |

---

### TC-09: 左脑任务不走右脑

| 项 | 内容 |
|----|------|
| 前置 | 左右脑双模型就绪 |
| 步骤 | 1. 触发 story workflow（如 `创建一个小红帽互动故事`） |
| 期望 | 所有 story workflow 步骤的模型请求走 `transport=hermes`，使用 `gpt-oss-20b-MXFP4-Q8` |
| 通过标准 | 无请求发往 Kimi API |

---

### TC-10: 右脑禁用时不降级

| 项 | 内容 |
|----|------|
| 前置 | 右脑 enabled: false 或未配置 API Key |
| 步骤 | 1. 触发元分析 |
| 期望 | 返回错误：`右脑未启用或配置不完整，无法执行元分析。请先在引擎配置中启用右脑并配置 API Key。` |
| 通过标准 | 明确报错，不静默失败，不走左脑降级 |

---

### TC-11: 配置驱动路由验证

| 项 | 内容 |
|----|------|
| 前置 | 配置文件已写入 `actionRoutes.meta_analysis` |
| 步骤 | 1. 检查 `config/hermes/manager.left-brain.json`<br>2. 验证 `resolveModelRouteForPhase` 返回 |
| 期望 | 配置文件中存在：<br>```json<br>"actionRoutes": {<br>  "meta_analysis": {<br>    "provider": "moonshot",<br>    "baseUrl": "https://api.kimi.com/coding/v1",<br>    "model": "kimi-for-coding",<br>    "transport": "direct"<br>  }<br>}<br>``` |
| 通过标准 | 配置正确，`resolveModelRouteForPhase` 返回 provider=moonshot |

---

## 4. 测试执行顺序

```
TC-01  →  TC-02  →  TC-03  →  TC-04  →  TC-05
 ↓        ↓        ↓        ↓        ↓
浏览器   引导条   引导条   引导条   一键启动
自动打开 未启动   左脑就绪 双脑就绪 4步链路

TC-06  →  TC-07  →  TC-08  →  TC-09  →  TC-10  →  TC-11
 ↓        ↓        ↓        ↓        ↓        ↓
右脑配置 元分析   路由验证 分工规则 降级策略 配置验证
```

---

## 5. 通过标准

| 等级 | 定义 |
|------|------|
| 🔴 Blocker | TC-01 ~ TC-05 中任何一项失败，系统无法进入可用状态 |
| 🟡 Critical | TC-06 ~ TC-08 失败，右脑功能不可用 |
| 🟢 Normal | TC-09 ~ TC-11 失败，不影响核心功能，但需记录修复 |

---

## 6. 自动化测试建议

以下用例可通过脚本自动化：

```bash
# TC-01: 重启脚本测试
sh scripts/lifecycle/restart_control.sh
sleep 5
curl -sS http://127.0.0.1:8870 | grep -q "智能体网关"

# TC-06: 右脑探测 API 测试
curl -sS "http://127.0.0.1:2099/api/control/local-models/inspect?provider=moonshot&model=kimi-for-coding&baseUrl=https://api.kimi.com/coding/v1"

# TC-07: 元分析端到端（需要 reasoning session）
curl -sS -X POST http://127.0.0.1:2099/api/control/agents/hermes-manager/reasoning-sessions \
  -H "Content-Type: application/json" \
  -d '{"prompt":"系统元分析"}'
```

---

> 本文最后更新：2026-05-28
