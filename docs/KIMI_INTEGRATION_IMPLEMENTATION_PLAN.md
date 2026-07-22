# Kimi 接入 Control 系统 — 四阶段详细实施方案

> 版本: 2026-06-06  
> 目标: 将 Kimi (Moonshot AI) 接入 Control 系统，实现 meta-analysis 和自动优化能力  
> 前提: 已有有效的 Kimi API Key (`sk-xxx`)，本机可访问 `https://api.moonshot.cn`

---

## 阶段 1: 接入 Kimi 作为 Direct-Route 工具

**目标**: 让 Control 系统能直接调用 Kimi API，不经过 Hermes Gateway。  
**工期**: 1-2 天  
**风险**: 低（只增加 provider 支持，不改动核心逻辑）

### 1.1 修改点清单

#### 1.1.1 环境变量配置

**文件**: `.env.local`（仓库根目录，如不存在则创建）

**新增内容**:
```bash
# Moonshot (Kimi) API 配置
MOONSHOT_API_KEY=sk-your-actual-key-here
MOONSHOT_BASE_URL=https://api.moonshot.cn/v1
```

**安全注意**:
- `.env.local` 已在 `.gitignore` 中，不会提交到 git
- 不要把真实 key 提交到代码仓库
- 建议 key 权限只开 "对话"，不开 "文件" 和 "微调"

#### 1.1.2 后端: provider 名称规范化

**文件**: `apps/control-server/src/server/controlServerCore.js`

**修改**: `normalizeProviderName()` 函数（第 232 行）

```javascript
// 修改前
function normalizeProviderName(provider) {
  const normalized = String(provider || '').trim().toLowerCase()
  if (!normalized || normalized === 'custom/local' || normalized === 'custom-local') {
    return 'omlx'
  }
  return normalized
}

// 修改后
function normalizeProviderName(provider) {
  const normalized = String(provider || '').trim().toLowerCase()
  if (!normalized || normalized === 'custom/local' || normalized === 'custom-local') {
    return 'omlx'
  }
  // 将 moonshot / kimi 统一识别为 moonshot
  if (normalized === 'kimi') return 'moonshot'
  return normalized
}
```

#### 1.1.3 后端: API Key 获取逻辑

**文件**: `apps/control-server/src/server/controlServerCore.js`

**修改**: `getProviderApiKey()` 函数（第 483 行附近）

```javascript
// 修改前
function getProviderApiKey(normalizedProvider) {
  if (normalizedProvider === 'omlx' || normalizedProvider === 'localoxml') {
    return getEnvValue('LOCALOXML_API_KEY') || getEnvValue('STUDIO_AI_API_KEY') || 'omlx123'
  }
  return getEnvValue('OPENAI_API_KEY') || getEnvValue('STUDIO_AI_API_KEY') || ''
}

// 修改后
function getProviderApiKey(normalizedProvider) {
  if (normalizedProvider === 'omlx' || normalizedProvider === 'localoxml') {
    return getEnvValue('LOCALOXML_API_KEY') || getEnvValue('STUDIO_AI_API_KEY') || 'omlx123'
  }
  if (normalizedProvider === 'moonshot') {
    return getEnvValue('MOONSHOT_API_KEY') || getEnvValue('STUDIO_AI_API_KEY') || ''
  }
  return getEnvValue('OPENAI_API_KEY') || getEnvValue('STUDIO_AI_API_KEY') || ''
}
```

#### 1.1.4 后端: 默认 baseUrl 支持

**文件**: `apps/control-server/src/server/controlServerCore.js`

**修改**: `normalizeModelBaseUrl()` 函数（第 463 行附近）

```javascript
// 修改前
function normalizeModelBaseUrl(baseUrl, provider) {
  const fallback = provider === 'ollama' ? 'http://127.0.0.1:11434/v1' : 'http://127.0.0.1:18888/v1'
  // ...
}

// 修改后
function normalizeModelBaseUrl(baseUrl, provider) {
  if (provider === 'moonshot') {
    return String(baseUrl || getEnvValue('MOONSHOT_BASE_URL') || 'https://api.moonshot.cn/v1').trim()
  }
  const fallback = provider === 'ollama' ? 'http://127.0.0.1:11434/v1' : 'http://127.0.0.1:18888/v1'
  // ... 保持原有逻辑不变
}
```

#### 1.1.5 后端: 预检逻辑支持 moonshot

**文件**: `apps/control-server/src/server/controlServerCore.js`

**修改**: `buildHermesPreflight()` 中的模型目录获取逻辑（第 2451 行附近）

当前 `fetchLocalModelCatalog` 只能探测本地 OMLX/Ollama。对于 Moonshot，需要：
- 如果 provider 是 moonshot，跳过本地模型目录探测
- 直接返回硬编码的 Moonshot 模型列表（或调用 Moonshot /v1/models）

```javascript
// 在 buildHermesPreflight 中增加 moonshot 分支
if (binding.provider === 'moonshot') {
  // Moonshot 为云端模型，不探测本地目录
  const moonshotModels = [
    { id: 'kimi-latest', object: 'model', owned_by: 'moonshot' },
    { id: 'kimi-k2-0711-preview', object: 'model', owned_by: 'moonshot' }
  ]
  // 简化预检：只检查 apiKey 和网络可达性
  const keyOk = Boolean(getProviderApiKey('moonshot'))
  return {
    ready: keyOk,
    checkedAt: new Date().toISOString(),
    checks: [
      { key: 'moonshot-api-key', label: 'Moonshot API Key', status: keyOk ? 'ok' : 'error', detail: keyOk ? 'API Key 已配置' : '未配置 MOONSHOT_API_KEY' },
      { key: 'moonshot-models', label: 'Moonshot 模型列表', status: 'ok', detail: `可用模型: ${moonshotModels.map(m => m.id).join(', ')}` }
    ],
    selectedModel: binding.model || 'kimi-latest',
    models: moonshotModels,
    provider: 'moonshot',
    baseUrl: binding.baseUrl
  }
}
```

#### 1.1.6 前端: Control Console 添加 Moonshot provider 选项

**文件**: `apps/control-console/src/composables/useControlConsoleApp.ts`

**修改 1**: provider 选项数组（搜索 `omlx` 相关的 select option）

在 provider select 的 options 中新增：

```typescript
// 在 provider 下拉框选项中增加
{ value: 'moonshot', label: 'Moonshot (Kimi)' }
```

**修改 2**: 模型探测逻辑

当前 `loadLeftBrainModels()` / `loadRightBrainModels()` 通过 `fetchLocalModelCatalog` 获取模型列表。对于 Moonshot：
- 当 provider === 'moonshot' 时，直接返回硬编码列表，不调用本地 catalog API
- 或调用 `https://api.moonshot.cn/v1/models` 获取实时列表

```typescript
async function loadModelsForProvider(provider: string, baseUrl: string) {
  if (provider === 'moonshot') {
    return [
      { id: 'kimi-latest', label: 'kimi-latest (推荐)' },
      { id: 'kimi-k2-0711-preview', label: 'kimi-k2-0711-preview' }
    ]
  }
  // 原有逻辑不变
  const response = await fetch(`/api/control/local-models?provider=${provider}&baseUrl=${baseUrl}`)
  // ...
}
```

#### 1.1.7 前端: baseUrl 默认值

**文件**: `apps/control-console/src/composables/useControlConsoleApp.ts`

当用户选择 Moonshot provider 时，自动填充默认 baseUrl：

```typescript
watch(() => leftBrain.value.provider, (provider) => {
  if (provider === 'moonshot' && !leftBrain.value.baseUrl) {
    leftBrain.value.baseUrl = 'https://api.moonshot.cn/v1'
  }
})
```

### 1.2 验证步骤

#### 验证 1: 后端语法检查

```bash
cd /Volumes/ovokit2t/aiwork/gamestudio
node --check apps/control-server/src/server/controlServerCore.js
```

#### 验证 2: 前端类型检查

```bash
cd /Volumes/ovokit2t/aiwork/gamestudio
npm --workspace @game-studio/control-console run typecheck
```

#### 验证 3: 完整流程测试

1. 重启 Control Server
2. 打开 Control Console (`http://127.0.0.1:8870`)
3. 进入"左脑配置"面板
4. Provider 选择 `Moonshot (Kimi)`
5. Base URL 应自动填充 `https://api.moonshot.cn/v1`
6. Model 选择 `kimi-latest`
7. 点击"保存配置"
8. 点击"启动引擎"
9. 在 Control Console Chat 发送一条简单消息
10. 检查 `.run/control-server.log` 中是否出现 `[MODEL_TASK] transport=direct model=kimi-latest`
11. 检查是否收到 Kimi 的回复

#### 验证 4: 网络连通性检查（如失败）

```bash
curl -sS https://api.moonshot.cn/v1/models \
  -H "Authorization: Bearer $MOONSHOT_API_KEY"
```

---

## 阶段 2: 开发 Meta-Analysis 能力

**目标**: 让 Kimi 能读取 Control 系统的运行数据，分析性能瓶颈和代码问题，生成结构化报告。  
**工期**: 2-3 天  
**风险**: 中（需要新增 workflow、action、tool，涉及 prompt engineering）

### 2.1 核心设计

新增一个独立的 `meta_analysis` 能力域，不改动现有左右脑框架。触发方式：
- 用户在 Control Console Chat 输入 meta-analysis 类提示词
- 或定时任务自动触发（可选）

### 2.2 修改点清单

#### 2.2.1 新增: Meta-Analysis Workflow

**新建文件**: `apps/control-server/src/server/workflows/metaAnalysisWorkflows.js`

```javascript
import path from 'node:path'
import { GAMESTUDIO_ROOT } from '../../config/paths.js'

export function isMetaAnalysisPrompt(userPrompt) {
  const prompt = String(userPrompt || '').toLowerCase()
  return /优化.*control|改进.*系统|分析.*性能|审查.*代码|系统诊断|瓶颈分析|meta.*analysis|self.*review|进化.*agent/i.test(prompt)
}

export function buildMetaAnalysisPlan(userPrompt) {
  return {
    planId: `meta_analysis_${Date.now()}`,
    goal: '收集 Control 系统运行数据，通过 Kimi 分析性能瓶颈、代码问题和改进机会',
    strategy: 'sequential',
    steps: [
      {
        stepId: 'step_meta_collect_logs',
        title: '收集运行日志和性能数据',
        action: 'meta_collect_data',
        tool: 'meta.collectData',
        params: { sources: ['control-server.log', 'hermes-gateway.log', 'agent-runtime-events'] },
        skipReview: true
      },
      {
        stepId: 'step_meta_analyze',
        title: 'Kimi 分析系统瓶颈',
        action: 'meta_analyze',
        tool: 'model.assist',
        params: {
          modelRoute: { transport: 'direct', provider: 'moonshot', model: 'kimi-latest' },
          question: '基于以下 Control 系统运行数据，分析性能瓶颈、错误模式和改进机会'
        },
        skipReview: true
      },
      {
        stepId: 'step_meta_report',
        title: '生成结构化分析报告',
        action: 'meta_report',
        tool: 'planner.answer',
        skipReview: true
      }
    ]
  }
}
```

#### 2.2.2 新增: Meta-Analysis Action Registry

**文件**: `apps/control-server/src/server/capabilities/actionRegistry.js`

在 `REASONING_ACTIONS` 中新增：

```javascript
meta_collect_data: {
  title: '收集元分析数据',
  tool: REASONING_TOOLS['meta.collectData'].tool,
  category: 'meta-analysis',
  description: '聚合 Control 系统日志、session 统计和性能数据，供 Kimi 分析。',
  paramsSpec: [
    'sources: 数据源数组，如 ["control-server.log", "hermes-gateway.log", "agent-runtime-events"]'
  ]
},
meta_analyze: {
  title: '执行元分析',
  tool: REASONING_TOOLS['model.assist'].tool,
  category: 'meta-analysis',
  description: '调用 Kimi 对收集的数据进行深度分析。',
  paramsSpec: [
    'modelRoute: { transport, provider, model }',
    'question: 分析问题的具体描述'
  ]
}
```

#### 2.2.3 新增: Meta-Analysis Tool Registry

**文件**: `apps/control-server/src/server/capabilities/toolRegistry.js`

新增工具定义：

```javascript
'meta.collectData': {
  tool: 'meta.collectData',
  executionMode: 'deterministic',
  reviewPolicy: 'auto',
  category: 'meta-analysis',
  description: '读取并聚合 Control 系统运行日志、session 统计、错误模式。',
  routes: ['internal:meta/collectData']
},
'model.assist': {
  tool: 'model.assist',
  executionMode: 'model-assisted',
  reviewPolicy: 'auto',
  category: 'meta-analysis',
  description: '调用指定外部模型（如 Kimi）执行辅助分析任务，支持 direct route。',
  routes: ['internal:model/assist']
}
```

#### 2.2.4 新增: Meta-Analysis Action 执行逻辑

**文件**: `apps/control-server/src/server/controlServerCore.js`

在 `executeReasoningStep()` 中新增分支：

```javascript
if (action === 'meta_collect_data') {
  const sources = step.params?.sources || ['control-server.log']
  const collected = await executeMetaCollectData(sources)
  const result = buildMetaAnalysisResult({
    action, ok: true,
    data: collected,
    summary: `已收集 ${Object.keys(collected).length} 个数据源`
  })
  updateMetaAnalysisArtifacts(sessionId, step, stepIndex, result)
  return result
}

if (action === 'meta_analyze') {
  const collectedData = getMetaAnalysisCollectedData(sessionId)
  const modelRoute = step.params?.modelRoute || { transport: 'direct', provider: 'moonshot', model: 'kimi-latest' }
  const question = step.params?.question || '分析系统性能瓶颈'
  
  const prompt = buildMetaAnalysisPrompt(collectedData, question)
  
  // 关键：使用 direct route 调用 Kimi，绕过 Hermes
  const analysisResult = await requestHermesChatCompletion({
    messages: [
      { role: 'system', content: '你是一个系统架构分析师，擅长分析 Node.js 后端系统的性能瓶颈和代码质量问题。' },
      { role: 'user', content: prompt }
    ],
    route: modelRoute,  // ← 这里传入 direct route
    maxTokens: 8192,
    temperature: 0.3
  })
  
  const result = buildMetaAnalysisResult({
    action, ok: true,
    data: { analysis: analysisResult.choices?.[0]?.message?.content || '' },
    summary: 'Kimi 分析完成'
  })
  updateMetaAnalysisArtifacts(sessionId, step, stepIndex, result)
  return result
}
```

#### 2.2.5 新增: 数据收集函数

**文件**: `apps/control-server/src/server/controlServerCore.js`

```javascript
async function executeMetaCollectData(sources) {
  const result = {}
  
  for (const source of sources) {
    if (source === 'control-server.log') {
      const logPath = path.join(GAMESTUDIO_ROOT, '.run', 'control-server.log')
      result.controlServerLog = await tailLogFile(logPath, 200)
    }
    if (source === 'hermes-gateway.log') {
      const logPath = '/tmp/gamestudio-hermes-gateway.log'
      result.hermesGatewayLog = await tailLogFile(logPath, 200)
    }
    if (source === 'agent-runtime-events') {
      const eventsPath = path.join(GAMESTUDIO_ROOT, 'state', 'agent-runtime-events.jsonl')
      result.agentRuntimeEvents = await tailJsonlFile(eventsPath, 100)
    }
    if (source === 'reasoning-sessions') {
      const sessionsDir = path.join(GAMESTUDIO_ROOT, 'state', 'reasoning-sessions')
      result.sessionStats = await collectSessionStats(sessionsDir)
    }
  }
  
  // 收集代码统计
  result.codeMetrics = {
    controlServerLines: await countLines(path.join(GAMESTUDIO_ROOT, 'apps', 'control-server', 'src')),
    recentCommits: await getRecentGitCommits(10),
    openIssues: [] // 可从 state 中读取
  }
  
  return result
}

function tailLogFile(filePath, lines = 200) {
  return new Promise((resolve) => {
    const { spawn } = require('child_process')
    const child = spawn('tail', ['-n', String(lines), filePath])
    let output = ''
    child.stdout.on('data', (data) => { output += data })
    child.on('close', () => resolve(output))
    child.on('error', () => resolve(`[无法读取日志: ${filePath}]`))
  })
}

async function collectSessionStats(sessionsDir) {
  const files = await fs.promises.readdir(sessionsDir).catch(() => [])
  const sessions = []
  for (const file of files.slice(-50)) {
    if (!file.endsWith('.json')) continue
    const content = await fs.promises.readFile(path.join(sessionsDir, file), 'utf8').catch(() => null)
    if (!content) continue
    try {
      const session = JSON.parse(content)
      sessions.push({
        id: session.sessionId,
        status: session.status,
        planStepCount: session.plan?.steps?.length || 0,
        finalAnswerLength: String(session.artifacts?.finalAnswer || '').length,
        createdAt: session.createdAt,
        endedAt: session.endedAt
      })
    } catch {}
  }
  const total = sessions.length
  const completed = sessions.filter(s => s.status === 'completed').length
  const failed = sessions.filter(s => s.status === 'failed').length
  const avgSteps = total > 0 ? sessions.reduce((sum, s) => sum + s.planStepCount, 0) / total : 0
  return { total, completed, failed, avgSteps: Math.round(avgSteps * 10) / 10, recent: sessions.slice(-10) }
}
```

#### 2.2.6 新增: Meta-Analysis Prompt 构建

**文件**: `apps/control-server/src/server/controlServerCore.js`

```javascript
function buildMetaAnalysisPrompt(collectedData, question) {
  const { controlServerLog, hermesGatewayLog, agentRuntimeEvents, sessionStats, codeMetrics } = collectedData
  
  const lines = [
    `# Control 系统运行数据分析请求`,
    ``,
    `## 用户问题`,
    question,
    ``,
    `## Session 统计（最近 50 个）`,
    `- 总数: ${sessionStats?.total || 'N/A'}`,
    `- 完成: ${sessionStats?.completed || 'N/A'}`,
    `- 失败: ${sessionStats?.failed || 'N/A'}`,
    `- 平均步骤数: ${sessionStats?.avgSteps || 'N/A'}`,
    ``,
    `## 最近 Session 列表`,
    ...(sessionStats?.recent || []).map(s => `- ${s.id}: status=${s.status} steps=${s.planStepCount} answer=${s.finalAnswerLength}chars`),
    ``,
    `## Control Server 日志尾部（最近 200 行）`,
    '```',
    String(controlServerLog || '(无日志)').slice(-8000),
    '```',
    ``,
    `## Hermes Gateway 日志尾部（最近 200 行）`,
    '```',
    String(hermesGatewayLog || '(无日志)').slice(-8000),
    '```',
    ``,
    `## 代码规模`,
    `- Control Server 源码行数: ${codeMetrics?.controlServerLines || 'N/A'}`,
    ``,
    `## 分析要求`,
    `1. 识别当前系统的关键性能瓶颈`,
    `2. 列出最近出现的错误模式和根因`,
    `3. 指出代码质量或架构上的改进机会`,
    `4. 按优先级排序改进建议（P0/P1/P2）`,
    `5. 对每个建议给出具体理由和预期效果`,
    ``,
    `请用中文回答，结构清晰，证据具体。`
  ]
  
  return lines.join('\n')
}
```

#### 2.2.7 修改: Request Classification 支持 Meta-Analysis

**文件**: `apps/control-server/src/server/reasoning/requestClassificationRules.js`

新增 detector 和 rule：

```javascript
const META_ANALYSIS_PATTERN = /优化.*control|改进.*系统|分析.*性能|审查.*代码|系统诊断|瓶颈分析|meta.*analysis|self.*review|进化.*agent/i

// 在 matchesDetector 中新增 case
function matchesDetector(detector, prompt) {
  switch (detector) {
    // ... 原有 cases ...
    case 'meta_analysis_execute':
      return META_ANALYSIS_PATTERN.test(prompt)
    // ...
  }
}
```

**文件**: `config/hermes/routing/request_classification_rules.json`

新增 rule：

```json
{
  "ruleId": "R013_meta_analysis_execute",
  "requestType": "meta_analysis_execute",
  "priority": 125,
  "detector": "meta_analysis_execute",
  "reason": "meta_analysis_request",
  "needsContext": true,
  "requiresHumanReview": false,
  "deterministicPlan": true,
  "route": "workflow_execute"
}
```

#### 2.2.8 修改: Prompt Builder 支持 Meta-Analysis Plan

**文件**: `apps/control-server/src/server/reasoning/promptBuilders.js`

导入并添加分支：

```javascript
import { isMetaAnalysisPrompt, buildMetaAnalysisPlan } from '../workflows/metaAnalysisWorkflows.js'

// 在 buildPlannerPlanForRequest 中新增
if (isMetaAnalysisPrompt(userPrompt) || contextSelection?.requestDecision?.type === 'meta_analysis_execute') {
  return buildMetaAnalysisPlan(userPrompt)
}
```

### 2.3 验证步骤

#### 验证 1: 分类测试

```bash
# 启动 Control Server + Hermes（阶段 1 已完成）
# 在 Control Console Chat 输入:
"分析 Control 系统当前性能瓶颈"

# 检查响应是否触发 meta-analysis workflow
# 期望: session 的 plan 包含 step_meta_collect_logs → step_meta_analyze → step_meta_report
```

#### 验证 2: 数据收集测试

```bash
# 检查 meta_collect_data 步骤是否正确读取了日志文件
curl -sS http://127.0.0.1:2099/api/control/agents/hermes-manager/agent-runtime-sessions/${SESSION_ID}
# 期望: artifacts.metaAnalysis.steps.step_meta_collect_data.data 包含日志内容
```

#### 验证 3: Kimi 调用测试

```bash
# 检查 model.assist 步骤是否使用了 direct route 调用 Kimi
# 期望: .run/control-server.log 中出现 [MODEL_TASK] transport=direct model=kimi-latest
# 期望: session artifacts 中包含 Kimi 的分析报告
```

#### 验证 4: 报告质量

- 报告是否识别了真实的性能问题？
- 是否引用了日志中的具体错误？
- 建议是否有可操作性？

---

## 阶段 3: 实现自动优化闭环

**目标**: 实现完整的 meta-cognition loop：分析 → 计划 → 修改 → 验证 → 记忆。  
**工期**: 3-5 天  
**风险**: 高（涉及自动代码修改，必须严格走 review gate）

### 3.1 核心设计原则

1. **绝不自动落盘**: 所有代码修改必须走 review gate (`reviewPolicy: 'required'`)
2. **渐进式优化**: 每次只修改 1-3 个文件，小步快跑
3. **验证前置**: 修改前必须能复现问题，修改后必须能通过测试
4. **记忆积累**: 每次优化的经验教训写入 `ai/memory/DECISIONS.md`

### 3.2 修改点清单

#### 3.2.1 新增: Meta-Optimization Workflow

**新建文件**: `apps/control-server/src/server/workflows/metaOptimizationWorkflows.js`

```javascript
export function isMetaOptimizationPrompt(userPrompt) {
  const prompt = String(userPrompt || '').toLowerCase()
  return /自动优化|自动修复|自动改进|apply.*fix|实施.*改进|执行.*优化|进化.*agent/i.test(prompt)
}

export function buildMetaOptimizationPlan(userPrompt, previousAnalysisSessionId = null) {
  return {
    planId: `meta_opt_${Date.now()}`,
    goal: '基于 meta-analysis 报告，生成具体代码修改方案，经人工审核后应用，验证效果并记录经验',
    strategy: 'sequential',
    steps: [
      {
        stepId: 'step_meta_opt_load_analysis',
        title: '加载先前的 meta-analysis 报告',
        action: 'meta_opt_load_analysis',
        tool: 'meta.loadAnalysis',
        params: { previousSessionId: previousAnalysisSessionId },
        skipReview: true
      },
      {
        stepId: 'step_meta_opt_plan_changes',
        title: 'Kimi 生成具体代码修改方案',
        action: 'meta_opt_plan_changes',
        tool: 'model.assist',
        params: {
          modelRoute: { transport: 'direct', provider: 'moonshot', model: 'kimi-latest' },
          maxTokens: 16384  // 代码修改需要更多 token
        },
        skipReview: true
      },
      {
        stepId: 'step_meta_opt_review_changes',
        title: '人工审核代码修改方案',
        action: 'meta_opt_review_changes',
        tool: 'review.gate',
        skipReview: false  // ← 关键：必须人工审核
      },
      {
        stepId: 'step_meta_opt_apply_changes',
        title: '应用审核通过的代码修改',
        action: 'meta_opt_apply_changes',
        tool: 'workspace.editFile',
        skipReview: true  // 审核已通过，这里自动执行
      },
      {
        stepId: 'step_meta_opt_syntax_check',
        title: '语法检查修改后的文件',
        action: 'meta_opt_syntax_check',
        tool: 'shell.execute',
        params: { command: 'node --check' },
        skipReview: true
      },
      {
        stepId: 'step_meta_opt_run_tests',
        title: '运行测试验证修改效果',
        action: 'meta_opt_run_tests',
        tool: 'test.run',
        params: { command: 'npm run test:control-production -- --stage=l1' },
        skipReview: true
      },
      {
        stepId: 'step_meta_opt_write_memory',
        title: '将优化经验写入记忆',
        action: 'meta_opt_write_memory',
        tool: 'write.memory',
        params: { filePath: 'ai/memory/DECISIONS.md' },
        skipReview: true
      },
      {
        stepId: 'step_meta_opt_answer',
        title: '汇总优化执行结果',
        action: 'meta_opt_answer',
        tool: 'planner.answer',
        skipReview: true
      }
    ]
  }
}
```

#### 3.2.2 新增: Kimi 代码修改 Prompt

**文件**: `apps/control-server/src/server/controlServerCore.js`

```javascript
function buildMetaOptimizationChangePlanPrompt(analysisReport, targetFiles) {
  return `
你是一位资深 Node.js 后端工程师。基于以下系统分析报告，请生成具体的代码修改方案。

## 分析报告摘要
${analysisReport}

## 修改要求
1. 每次只修改最优先的 1-3 个问题
2. 对每个修改提供：文件路径、修改原因、修改前后的代码 diff
3. 修改必须保持向后兼容，不破坏现有 API
4. 优先选择影响面小、收益高的改进

## 输出格式
请严格按以下 JSON 格式输出（不要包含 markdown 代码块标记）：

{
  "changes": [
    {
      "filePath": "apps/control-server/src/server/xxx.js",
      "reason": "修改原因...",
      "search": "要替换的原始代码片段（必须精确匹配）",
      "replace": "替换后的代码"
    }
  ],
  "summary": "本次修改共涉及 N 个文件，预期解决..."
}

注意：
- search 必须精确匹配文件中的原始代码，包括缩进和换行
- 如果修改涉及多个不连续的位置，请拆分为多个 change 项
- 不要修改测试文件
`
}
```

#### 3.2.3 新增: 修改应用逻辑

**文件**: `apps/control-server/src/server/controlServerCore.js`

```javascript
if (action === 'meta_opt_apply_changes') {
  const changes = step.params?.changes || []
  const results = []
  
  for (const change of changes) {
    const filePath = path.join(GAMESTUDIO_ROOT, change.filePath)
    
    // 安全检查：文件必须在 GAMESTUDIO_ROOT 下
    if (!filePath.startsWith(GAMESTUDIO_ROOT)) {
      results.push({ filePath: change.filePath, ok: false, error: 'path_outside_workspace' })
      continue
    }
    
    // 安全检查：只能修改 .js/.ts/.json/.md 文件
    const ext = path.extname(filePath)
    if (!['.js', '.ts', '.json', '.md'].includes(ext)) {
      results.push({ filePath: change.filePath, ok: false, error: 'file_type_not_allowed' })
      continue
    }
    
    try {
      const content = fs.readFileSync(filePath, 'utf8')
      if (!content.includes(change.search)) {
        results.push({ filePath: change.filePath, ok: false, error: 'search_pattern_not_found' })
        continue
      }
      
      const newContent = content.replace(change.search, change.replace)
      if (newContent === content) {
        results.push({ filePath: change.filePath, ok: false, error: 'replace_no_effect' })
        continue
      }
      
      // 写入前备份
      const backupPath = `${filePath}.backup.${Date.now()}`
      fs.writeFileSync(backupPath, content, 'utf8')
      
      fs.writeFileSync(filePath, newContent, 'utf8')
      results.push({ filePath: change.filePath, ok: true, backup: backupPath })
    } catch (error) {
      results.push({ filePath: change.filePath, ok: false, error: error.message })
    }
  }
  
  const ok = results.every(r => r.ok)
  const result = buildMetaOptimizationResult({
    action, ok,
    data: { results },
    summary: ok
      ? `已应用 ${results.length} 个文件的修改`
      : `${results.filter(r => !r.ok).length} 个文件修改失败: ${results.filter(r => !r.ok).map(r => `${r.filePath}(${r.error})`).join(', ')}`
  })
  updateMetaOptimizationArtifacts(sessionId, step, stepIndex, result)
  return result
}
```

#### 3.2.4 新增: 语法检查步骤

```javascript
if (action === 'meta_opt_syntax_check') {
  const changedFiles = getMetaOptimizationChangedFiles(sessionId)
  const results = []
  
  for (const file of changedFiles) {
    const ext = path.extname(file)
    if (ext === '.js') {
      const { execSync } = require('child_process')
      try {
        execSync(`node --check "${file}"`, { cwd: GAMESTUDIO_ROOT, timeout: 10000 })
        results.push({ file, ok: true })
      } catch (error) {
        results.push({ file, ok: false, error: error.stderr?.toString() || error.message })
      }
    } else {
      results.push({ file, ok: true, note: 'skipped_non_js' })
    }
  }
  
  const ok = results.every(r => r.ok)
  // ... 构建 result ...
}
```

#### 3.2.5 新增: 记忆写入步骤

```javascript
if (action === 'meta_opt_write_memory') {
  const optimization = getMetaOptimizationSummary(sessionId)
  const memoryEntry = `
## ${new Date().toISOString()} — Control 系统自动优化记录

**触发原因**: ${optimization.triggerPrompt}

**修改文件**:
${optimization.changes.map(c => `- ${c.filePath}: ${c.reason}`).join('\n')}

**验证结果**: ${optimization.testResult.ok ? '通过' : '未通过'}

**经验教训**:
${optimization.lessons}

---
`
  
  const memoryPath = path.join(GAMESTUDIO_ROOT, 'ai', 'memory', 'DECISIONS.md')
  fs.appendFileSync(memoryPath, memoryEntry, 'utf8')
  
  // ... 构建 result ...
}
```

### 3.3 验证步骤

#### 验证 1: Review Gate 拦截

1. 在 Control Console Chat 输入："自动优化 Control 系统"
2. 系统生成 meta-optimization plan
3. 执行到 `step_meta_opt_review_changes` 时，session 状态变为 `waiting_review`
4. 在 Control Console 的"可观测推理链"面板看到审核请求
5. **不点击 approve**，确认系统不会自动继续

#### 验证 2: 修改应用测试

1. 在 review gate 点击 approve
2. 系统执行 `meta_opt_apply_changes`
3. 检查目标文件是否被修改
4. 检查是否有 `.backup.{timestamp}` 文件生成
5. 运行 `node --check` 验证语法

#### 验证 3: 回滚测试

1. 如果修改导致问题，使用 backup 文件手动回滚：
```bash
cp apps/control-server/src/server/xxx.js.backup.1234567890 apps/control-server/src/server/xxx.js
```

#### 验证 4: 记忆写入验证

```bash
tail -50 ai/memory/DECISIONS.md
# 期望: 能看到本次优化的记录
```

---

## 阶段 4: 正式启用左右脑双模型架构

**目标**: 将 Kimi 正式接入为"右脑"，实现左右脑智能分工。  
**工期**: 3-5 天  
**风险**: 中（涉及 UI/后端大量联动修改，但逻辑相对清晰）

### 4.1 左右脑分工设计

| 任务类型 | 左脑 (OMLX) | 右脑 (Kimi) |
|----------|------------|------------|
| 日常 chat | ✅ | ❌ |
| planner 生成计划 | ✅ | ❌ |
| story workflow 执行 | ✅ | ❌ |
| 代码生成/修改 | ❌ | ✅ |
| 质量审查/复审 | ❌ | ✅ |
| meta-analysis | ❌ | ✅ |
| 复杂推理 (>200k context) | ❌ | ✅ |
| 边界情况 fallback | ❌ | ✅ |

### 4.2 修改点清单

#### 4.2.1 前端: 启用右脑 UI

**文件**: `apps/control-console/src/components/ControlConsoleMainPanels.vue`

- 去掉右脑表单的 `disabled` 属性
- 将 `[未开放]` 标签改为状态指示器
- 添加右脑"启动/暂停"按钮

```vue
<!-- 修改前 -->
<button disabled>未开放</button>

<!-- 修改后 -->
<button @click="executeGlobalRuntimeAction('start', 'right')" :disabled="!rightBrainConfigReady">
  {{ rightBrainRunning ? '暂停右脑' : '启动右脑' }}
</button>
```

#### 4.2.2 后端: 右脑独立生命周期

**文件**: `apps/control-server/src/server/routes/runtimeRoutes.js`

扩展 `runtime-action` API，支持 `brainSide: 'right'`：

```javascript
app.post('/api/control/agents/:agentId/runtime-action', async (c) => {
  // ...
  const side = body.brainSide || 'left'
  
  if (side === 'right') {
    // 右脑不 spawn 新进程，而是配置 direct route
    const rightConfig = getPersistedHermesControlConfig().rightBrain
    if (!rightConfig?.model) {
      return c.json({ ok: false, error: 'right_brain_not_configured' }, 400)
    }
    
    updateHermesControlState({
      brains: { rightBrainEnabled: action === 'start' || action === 'resume' }
    })
    
    return c.json({
      ok: true,
      action,
      side: 'right',
      runtimeStatus: getHermesRuntimeState()
    })
  }
  
  // 左脑原有逻辑不变
})
```

#### 4.2.3 后端: 模型路由规则

**文件**: `apps/control-server/src/server/controlServerCore.js`

在 `resolveModelRouteForPhase()` 中增加左右脑选择逻辑：

```javascript
function resolveModelRouteForPhase(phase, action, config) {
  const rightBrainEnabled = config.brains?.rightBrainEnabled
  const rightBrain = config.rightBrain
  
  // 定义右脑任务列表
  const rightBrainPhases = ['answer', 'quality_retry', 'meta_analysis', 'code_review']
  const rightBrainActions = ['story_review_blueprint_agent', 'meta_opt_plan_changes']
  
  if (rightBrainEnabled && (rightBrainPhases.includes(phase) || rightBrainActions.includes(action))) {
    return {
      transport: 'direct',
      provider: rightBrain.provider,
      baseUrl: rightBrain.baseUrl,
      model: rightBrain.model,
      headers: { 'Authorization': `Bearer ${getProviderApiKey(rightBrain.provider)}` }
    }
  }
  
  // 默认走左脑
  return config.workflow?.modelRouting?.defaultRoute
}
```

#### 4.2.4 后端: 持久化右脑配置

**文件**: `apps/control-server/src/server/controlServerCore.js`

```javascript
function buildPersistedHermesControlConfig(rawConfig) {
  const cfg = rawConfig || getHermesControlConfig()
  return {
    // ... 左脑配置不变 ...
    rightBrain: cfg.rightBrain || null,
    brains: {
      rightBrainEnabled: Boolean(cfg.brains?.rightBrainEnabled)
    }
  }
}
```

### 4.3 验证步骤

#### 验证 1: 双模型共存

1. 左脑配置 OMLX，右脑配置 Kimi
2. 启动左脑（Hermes spawn）
3. "启用"右脑（仅标记 rightBrainEnabled = true）
4. 发送 story workflow 请求 → 左脑处理
5. 发送 meta-analysis 请求 → 右脑处理
6. 检查日志中 `[MODEL_TASK] transport=direct model=kimi-latest`

#### 验证 2: 单点故障隔离

1. 断开网络（模拟 Kimi 不可用）
2. 右脑任务应失败，但左脑任务不受影响
3. 系统应优雅降级，提示"右脑暂不可用，使用左脑完成"

#### 验证 3: 配置热切换

1. 在运行中切换右脑模型
2. 新请求应立即使用新模型
3. 旧请求不受影响

---

## 附录：全部修改文件汇总

### 阶段 1（接入 Kimi）

| # | 文件 | 修改类型 |
|---|------|---------|
| 1 | `.env.local` | 新增环境变量 |
| 2 | `apps/control-server/src/server/controlServerCore.js` | 修改 normalizeProviderName, getProviderApiKey, normalizeModelBaseUrl, buildHermesPreflight |
| 3 | `apps/control-console/src/composables/useControlConsoleApp.ts` | 修改 provider 选项、模型加载、baseUrl 默认值 |

### 阶段 2（Meta-Analysis）

| # | 文件 | 修改类型 |
|---|------|---------|
| 4 | `apps/control-server/src/server/workflows/metaAnalysisWorkflows.js` | **新建** |
| 5 | `apps/control-server/src/server/capabilities/actionRegistry.js` | 新增 meta 相关 actions |
| 6 | `apps/control-server/src/server/capabilities/toolRegistry.js` | 新增 meta/model 相关 tools |
| 7 | `apps/control-server/src/server/controlServerCore.js` | 新增 executeMetaCollectData, buildMetaAnalysisPrompt, meta action 分支 |
| 8 | `apps/control-server/src/server/reasoning/requestClassificationRules.js` | 新增 meta_analysis detector |
| 9 | `config/hermes/routing/request_classification_rules.json` | 新增 R013 rule |
| 10 | `apps/control-server/src/server/reasoning/promptBuilders.js` | 新增 meta-analysis plan 分支 |

### 阶段 3（自动优化闭环）

| # | 文件 | 修改类型 |
|---|------|---------|
| 11 | `apps/control-server/src/server/workflows/metaOptimizationWorkflows.js` | **新建** |
| 12 | `apps/control-server/src/server/capabilities/actionRegistry.js` | 新增 meta_opt 相关 actions |
| 13 | `apps/control-server/src/server/capabilities/toolRegistry.js` | 新增相关 tools |
| 14 | `apps/control-server/src/server/controlServerCore.js` | 新增 meta_opt_apply_changes, meta_opt_syntax_check, meta_opt_write_memory 等执行逻辑 |

### 阶段 4（左右脑架构）

| # | 文件 | 修改类型 |
|---|------|---------|
| 15 | `apps/control-console/src/components/ControlConsoleMainPanels.vue` | 启用右脑 UI |
| 16 | `apps/control-server/src/server/routes/runtimeRoutes.js` | 扩展 runtime-action 支持 brainSide: 'right' |
| 17 | `apps/control-server/src/server/controlServerCore.js` | 修改模型路由、配置持久化 |

---

## 实施建议

1. **不要一次做完四个阶段**。建议按阶段交付，每阶段完成后验证再进入下一阶段。
2. **阶段 1 必须最先完成**。它是后续所有阶段的基础。
3. **阶段 3 的自动修改必须保守**。建议前几次只让 Kimi 修改日志级别、注释、配置值等低风险内容，验证 review gate 和回滚机制可靠后，再逐步开放代码逻辑修改。
4. **阶段 4 是可选的**。如果阶段 2+3 已经能满足"用 Kimi 优化系统"的诉求，可以暂不启用正式右脑架构。
5. **成本监控**。Kimi 按 token 计费，meta-analysis 的 prompt 通常包含大量日志文本（可能 10k-50k tokens/次），建议：
   - 限制每次分析的日志行数（如最多 500 行）
   - 限制 session 历史查询范围（如只查最近 7 天）
   - 在 Control Console 显示预估 token 消耗
