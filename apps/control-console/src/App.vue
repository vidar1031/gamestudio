<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

type HealthResponse = {
  ok: boolean
  service: string
  version: string
  now: string
}

type AgentListItem = {
  definition: {
    id: string
    name: string
    runtime: string
    role: string
  }
  status: {
    availability: string
  }
}

type RuntimeState = {
  state: 'uninstalled' | 'stopped' | 'running'
  label: string
  detail: string
  pid: number | null
  logFile: string
  availableActions: Array<'start' | 'stop' | 'exit'>
}

type SelfCheckResponse = {
  agentId: string
  runtimeStatus: string
  summary: string
  checkedAt: string
  checks: Array<{
    key: string
    label: string
    status: string
    detail: string
  }>
  info: {
    model: string
    provider: string
    baseUrl: string
    contextLength?: number | null
    recommendedMaxOutputTokens?: number | null
    tokenizer?: string | null
    metadataSource?: string | null
    workspace: string
    command: string
    interactionMode: string
  }
}

type TokenUsage = {
  promptTokens: number | null
  completionTokens: number | null
  totalTokens: number | null
}

type ModelInspection = {
  model: string
  accessible: boolean
  status: 'ok' | 'error'
  detail: string
  checkedAt: string
  usage: TokenUsage
  contextLength: number | null
  recommendedMaxOutputTokens: number | null
  tokenizer: string | null
  metadataSource: string
}

const managerHealth = ref<HealthResponse | null>(null)
const agentOptions = ref<AgentListItem[]>([])
const selectedAgentId = ref('')
const selectedAgentLabel = ref('')
const selfCheck = ref<SelfCheckResponse | null>(null)
const connecting = ref(false)
const runtimeBusy = ref(false)
const error = ref('')
const healthError = ref('')
const runtimeState = ref<RuntimeState | null>(null)

// 模型交互沙盒状态
const sandboxOpen = ref(false)
const sandboxPrompt = ref('你好，系统控制面握手测试。')
const sandboxReply = ref('')
const sandboxBusy = ref(false)
const sandboxError = ref('')

const engineConfig = ref({
  provider: 'custom/local',
  baseUrl: 'http://127.0.0.1:18888/v1',
  model: 'gpt-oss-20b-MXFP4-Q8',
  contextLength: null as number | null,
  recommendedMaxOutputTokens: null as number | null,
  tokenizer: null as string | null,
  metadataSource: 'unavailable'
})
const availableLocalModels = ref<any[]>([])
const fetchingModels = ref(false)
const modelInventoryError = ref('')
const selectedModelInspection = ref<ModelInspection | null>(null)
const inspectingModel = ref(false)

type LocalModelItem = {
  id: string
  created?: number | null
  ownedBy?: string | null
  contextLength?: number | null
  recommendedMaxOutputTokens?: number | null
  tokenizer?: string | null
  metadataSource?: string
}

const selectedAgent = computed(() => {
  return agentOptions.value.find((item) => item.definition.id === selectedAgentId.value) || null
})

const runtimeStatus = computed(() => {
  if (selectedAgent.value?.definition.runtime === 'openclaw') {
    return '待开放 (占位)'
  }
  return runtimeState.value?.label || '未选择'
})

const runtimeActionLabel = computed(() => {
  if (!runtimeState.value) return '启动引擎'
  if (runtimeState.value.state === 'running') return '停止运行'
  if (runtimeState.value.state === 'stopped') return '启动引擎'
  return '未安装'
})

const selectedModelOption = computed(() => {
  return availableLocalModels.value.find((item: LocalModelItem) => item.id === engineConfig.value.model) || null
})

const startBlockedByModelInspection = computed(() => {
  if (selectedAgent.value?.definition.runtime !== 'hermes') return false
  if (runtimeState.value?.state === 'running') return false
  return fetchingModels.value || inspectingModel.value || !engineConfig.value.model || selectedModelInspection.value?.accessible === false
})

// 添加中文标签映射，使机器的 key 更易读
function getChineseCheckLabel(key: string) {
  const map: Record<string, string> = {
    'mcp-connection': 'MCP 协议连接池',
    'python-env': 'Python 运行时环境',
    'workspace-access': '工作区读写权限',
    'model-route': 'LLM 模型路由'
  }
  return map[key] || key
}

onMounted(async () => {
  const [healthResult, agentsResult] = await Promise.allSettled([
    fetch('/api/health'),
    fetch('/api/control/agents')
  ])

  if (healthResult.status === 'fulfilled') {
    if (healthResult.value.ok) {
      managerHealth.value = await healthResult.value.json()
      healthError.value = ''
    } else {
      healthError.value = `health_http_${healthResult.value.status}`
    }
  } else {
    healthError.value = healthResult.reason instanceof Error ? healthResult.reason.message : String(healthResult.reason)
  }

  if (agentsResult.status === 'fulfilled') {
    if (agentsResult.value.ok) {
      const payload = await agentsResult.value.json()
      agentOptions.value = payload.agents || []
      error.value = ''

      const savedChoice = localStorage.getItem('hermes_control_selected_agent')
      if (savedChoice && agentOptions.value.find(item => item.definition.id === savedChoice)) {
        selectedAgentId.value = savedChoice
        await connectSelectedAgent()
      }
    } else {
      error.value = `agents_http_${agentsResult.value.status}`
    }
  } else {
    error.value = agentsResult.reason instanceof Error ? agentsResult.reason.message : String(agentsResult.reason)
  }
})

async function connectSelectedAgent() {
  if (!selectedAgentId.value) {
    selfCheck.value = null
    runtimeState.value = null
    selectedAgentLabel.value = ''
    error.value = ''
    localStorage.removeItem('hermes_control_selected_agent')
    return
  }

  localStorage.setItem('hermes_control_selected_agent', selectedAgentId.value)

  const agent = agentOptions.value.find((item) => item.definition.id === selectedAgentId.value)
  selectedAgentLabel.value = agent?.definition.name || selectedAgentId.value

  if (agent?.definition.runtime !== 'hermes') {
    selfCheck.value = null
    runtimeState.value = null
    error.value = ''
    return
  }

  await loadEngineConfig()
  await loadHermesRuntimeStatus()
  if (runtimeState.value?.state === 'running') {
    await loadHermesSelfCheck()
  } else {
    selfCheck.value = null
  }
}

async function loadHermesRuntimeStatus() {
  await refreshHermesRuntimeState()
}

async function refreshHermesRuntimeState() {
  const response = await fetch('/api/control/agents/hermes-manager/runtime-status')
  if (!response.ok) {
    throw new Error(`runtime_status_http_${response.status}`)
  }

  const payload = await response.json()
  runtimeState.value = payload.runtimeStatus
}

async function loadEngineConfig() {
  try {
    const response = await fetch(`/api/control/agents/${selectedAgentId.value}/config`)
    if (response.ok) {
      const payload = await response.json()
      if (payload.ok) {
        engineConfig.value.provider = payload.config.provider
        engineConfig.value.baseUrl = payload.config.baseUrl
        engineConfig.value.model = payload.config.model
        engineConfig.value.contextLength = payload.config.contextLength ?? null
        engineConfig.value.recommendedMaxOutputTokens = payload.config.recommendedMaxOutputTokens ?? null
        engineConfig.value.tokenizer = payload.config.tokenizer ?? null
        engineConfig.value.metadataSource = payload.config.metadataSource ?? 'unavailable'
        await fetchLocalModels()
      }
    }
  } catch (e) {
    console.error(e)
  }
}

async function fetchLocalModels() {
  fetchingModels.value = true
  modelInventoryError.value = ''
  try {
    const backendParam = engineConfig.value.provider === 'ollama' ? 'ollama' : 'omlx'
    const query = new URLSearchParams({
      provider: backendParam,
      baseUrl: engineConfig.value.baseUrl
    })
    const resp = await fetch(`/api/control/local-models?${query.toString()}`)
    if (resp.ok) {
      const data = await resp.json()
      if (data.ok) {
        availableLocalModels.value = data.models as LocalModelItem[]
        if (data.models.length > 0 && !data.models.find((m: LocalModelItem) => m.id === engineConfig.value.model)) {
          engineConfig.value.model = data.models[0].id
        }
        syncEngineMetadataFromSelection()
        await inspectSelectedModel()
      } else {
        availableLocalModels.value = []
        selectedModelInspection.value = null
        modelInventoryError.value = data.error || '模型列表获取失败'
      }
    } else {
      availableLocalModels.value = []
      selectedModelInspection.value = null
      modelInventoryError.value = `model_inventory_http_${resp.status}`
    }
  } catch (e) {
    console.error(e)
    availableLocalModels.value = []
    selectedModelInspection.value = null
    modelInventoryError.value = e instanceof Error ? e.message : String(e)
  } finally {
    fetchingModels.value = false
  }
}

function syncEngineMetadataFromSelection() {
  const selected = selectedModelOption.value
  if (!selected) {
    engineConfig.value.contextLength = null
    engineConfig.value.recommendedMaxOutputTokens = null
    engineConfig.value.tokenizer = null
    engineConfig.value.metadataSource = 'unavailable'
    return
  }

  engineConfig.value.contextLength = selected.contextLength ?? null
  engineConfig.value.recommendedMaxOutputTokens = selected.recommendedMaxOutputTokens ?? null
  engineConfig.value.tokenizer = selected.tokenizer ?? null
  engineConfig.value.metadataSource = selected.metadataSource || 'unavailable'
}

async function inspectSelectedModel() {
  if (!engineConfig.value.model) {
    selectedModelInspection.value = null
    return
  }

  inspectingModel.value = true
  try {
    const backendParam = engineConfig.value.provider === 'ollama' ? 'ollama' : 'omlx'
    const query = new URLSearchParams({
      provider: backendParam,
      model: engineConfig.value.model,
      baseUrl: engineConfig.value.baseUrl
    })
    const response = await fetch(`/api/control/local-models/inspect?${query.toString()}`)
    if (!response.ok) {
      throw new Error(`model_inspect_http_${response.status}`)
    }
    const payload = await response.json()
    selectedModelInspection.value = payload.inspection || null
    if (payload.inspection) {
      engineConfig.value.contextLength = payload.inspection.contextLength ?? engineConfig.value.contextLength
      engineConfig.value.recommendedMaxOutputTokens = payload.inspection.recommendedMaxOutputTokens ?? engineConfig.value.recommendedMaxOutputTokens
      engineConfig.value.tokenizer = payload.inspection.tokenizer ?? engineConfig.value.tokenizer
      engineConfig.value.metadataSource = payload.inspection.metadataSource || engineConfig.value.metadataSource
    }
  } catch (e) {
    selectedModelInspection.value = {
      model: engineConfig.value.model,
      accessible: false,
      status: 'error',
      detail: e instanceof Error ? e.message : String(e),
      checkedAt: new Date().toISOString(),
      usage: {
        promptTokens: null,
        completionTokens: null,
        totalTokens: null
      },
      contextLength: engineConfig.value.contextLength,
      recommendedMaxOutputTokens: engineConfig.value.recommendedMaxOutputTokens,
      tokenizer: engineConfig.value.tokenizer,
      metadataSource: engineConfig.value.metadataSource
    }
  } finally {
    inspectingModel.value = false
  }
}

function handleProviderChange() {
  engineConfig.value.baseUrl = engineConfig.value.provider === 'ollama' ? 'http://127.0.0.1:11434/v1' : 'http://127.0.0.1:18888/v1'
  engineConfig.value.model = ''
  availableLocalModels.value = []
  selectedModelInspection.value = null
  fetchLocalModels()
}

function handleModelChange() {
  syncEngineMetadataFromSelection()
  inspectSelectedModel()
}

async function loadHermesSelfCheck() {
  connecting.value = true
  error.value = ''

  try {
    const response = await fetch('/api/control/agents/hermes-manager/self-check')
    if (!response.ok) {
      if (response.status === 409) {
        const payload = await response.json()
        runtimeState.value = payload.runtimeStatus || runtimeState.value
      }
      throw new Error(`self_check_http_${response.status}`)
    }

    const payload = await response.json()
    selfCheck.value = payload.selfCheck
  } catch (caught) {
    selfCheck.value = null
    error.value = caught instanceof Error ? caught.message : String(caught)
  } finally {
    connecting.value = false
  }
}

async function toggleHermesRuntime() {
  if (!selectedAgent.value || selectedAgent.value.definition.runtime !== 'hermes' || !runtimeState.value) {
    return
  }

  if (runtimeState.value.state === 'uninstalled') {
    error.value = runtimeState.value.detail
    return
  }

  runtimeBusy.value = true
  error.value = ''

  try {
    const action = runtimeState.value.state === 'running' ? 'stop' : 'start'
    const payloadBody: any = { action }
    if (action === 'start') {
      payloadBody.config = {
        provider: engineConfig.value.provider,
        baseUrl: engineConfig.value.baseUrl,
        model: engineConfig.value.model,
        contextLength: engineConfig.value.contextLength,
        recommendedMaxOutputTokens: engineConfig.value.recommendedMaxOutputTokens,
        tokenizer: engineConfig.value.tokenizer,
        metadataSource: engineConfig.value.metadataSource
      }
    }
    const response = await fetch('/api/control/agents/hermes-manager/runtime-action', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payloadBody)
    })

    if (!response.ok) {
      throw new Error(`runtime_action_http_${response.status}`)
    }

    const payload = await response.json()
    runtimeState.value = payload.runtimeStatus

    if (runtimeState.value?.state === 'running') {
      await loadHermesSelfCheck()
    } else {
      selfCheck.value = null
    }
  } catch (caught) {
    error.value = caught instanceof Error ? caught.message : String(caught)
  } finally {
    runtimeBusy.value = false
  }
}

async function pingModel() {
  if (!sandboxPrompt.value.trim()) return

  sandboxBusy.value = true
  sandboxError.value = ''
  sandboxReply.value = ''

  try {
    const response = await fetch('/api/control/agents/hermes-manager/ping-model', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ prompt: sandboxPrompt.value })
    })

    if (!response.ok) {
      throw new Error(`sandbox_action_http_${response.status}`)
    }

    const payload = await response.json()
    if (payload.ok) {
      sandboxReply.value = payload.reply
    } else {
      sandboxError.value = payload.error || '模型无响应或接口异常'
    }
  } catch (caught) {
    sandboxError.value = caught instanceof Error ? caught.message : String(caught)
  } finally {
    sandboxBusy.value = false
  }
}
</script>

<template>
  <main class="shell">
    <header class="console-header">
      <h1>控制网关 (Control Gateway)</h1>
      
      <div class="agent-controls">
        <div class="agent-selector-bar">
          <label for="agent-select">指派调度器：</label>
          <div class="select-wrapper">
            <select id="agent-select" v-model="selectedAgentId" @change="connectSelectedAgent">
              <option value="">请选择要挂载的智能体</option>
              <option
                v-for="agent in agentOptions"
                :key="agent.definition.id"
                :value="agent.definition.id"
              >
                {{ agent.definition.name }} ({{ agent.definition.runtime }})
              </option>
            </select>
          </div>
        </div>
        
        <!-- 仅当选择 Hermes 时显示状态与控制按钮，在一排紧凑显示 -->
        <div class="runtime-controls" v-if="selectedAgent?.definition.runtime === 'hermes'">
          <div class="status-badge" :data-state="runtimeState?.state || 'unknown'">
            <span class="status-dot"></span>
            {{ runtimeState?.label || '检测中...' }}
          </div>
          <button
            class="action-btn"
            :disabled="runtimeBusy || runtimeState?.state === 'uninstalled' || startBlockedByModelInspection"
            @click="toggleHermesRuntime"
          >
            {{ runtimeBusy ? '处理中...' : runtimeActionLabel }}
          </button>
        </div>
        
        <div class="runtime-controls" v-else-if="selectedAgent">
          <div class="status-badge" data-state="unknown">
            <span class="status-dot"></span>
            {{ runtimeStatus }}
          </div>
        </div>
      </div>
    </header>

    <section class="console-body" v-if="selectedAgentId">
        <!-- 提示信息横幅视图 -->
        <div class="message-banner error" v-if="healthError">
          <span>❌</span> 控制面健康检查失败: {{ healthError }}
        </div>
        
        <div class="message-banner tip" v-else-if="selectedAgent?.definition.runtime === 'openclaw'">
          <span>ℹ️</span> 提示：OpenClaw 目前仅为功能预留的占位节点。现阶段请切换回 Hermes 工作流进行系统调度。
        </div>

        <div class="message-banner error" v-else-if="runtimeState?.state === 'uninstalled'">
          <span>⚠️</span> 引擎缺失：Hermes 环境未就绪或受控网关丢失，请检查底层依赖 ({{ runtimeState?.detail }})。
        </div>
        
        <div class="message-banner tip" v-else-if="runtimeState?.state === 'stopped'">
          <span>💤</span> 智能体已休眠：Hermes 引擎已就绪，但受控服务未启动。请点击右上方的「启动引擎」按钮进行唤醒。
        </div>

        <div class="feature-panels" v-if="selectedAgent?.definition.runtime === 'hermes'">
          <details class="panel" open>
            <summary class="panel-header">
              <div class="panel-title">⚙️ 模型引擎配置 (Model Engine Configuration)</div>
            </summary>
            <div class="panel-content">
              <p v-if="modelInventoryError" class="text-error">{{ modelInventoryError }}</p>
              <div style="display: flex; gap: 16px; align-items: center; padding: 12px; background: rgba(0,0,0,0.2); border-radius: 6px;">
                <div style="display: flex; flex-direction: column; gap: 4px;">
                  <label style="font-size: 12px; color: #888;">推理后端平台</label>
                  <select v-model="engineConfig.provider" :disabled="runtimeState?.state === 'running'" @change="handleProviderChange" style="padding: 4px 8px; border-radius: 4px; background: #222; color: #ddd; border: 1px solid #444;">
                    <option value="custom/local">OMLX (Local)</option>
                    <option value="ollama">Ollama</option>
                  </select>
                </div>
                <div style="display: flex; flex-direction: column; gap: 4px; flex: 1;">
                  <label style="font-size: 12px; color: #888;">运行模型</label>
                  <div style="display: flex; gap: 8px;">
                    <select v-model="engineConfig.model" :disabled="runtimeState?.state === 'running' || fetchingModels" @change="handleModelChange" style="flex: 1; padding: 4px 8px; border-radius: 4px; background: #222; color: #ddd; border: 1px solid #444;">
                      <option v-if="availableLocalModels.length === 0" :value="engineConfig.model">{{ engineConfig.model || '未发现模型' }}</option>
                      <option v-for="mod in availableLocalModels" :key="mod.id" :value="mod.id">{{ mod.id }}</option>
                    </select>
                    <button class="action-btn" style="background: transparent; border: 1px solid #555; padding: 4px 12px;" @click="fetchLocalModels" :disabled="fetchingModels || runtimeState?.state === 'running'">
                      {{ fetchingModels ? '...' : '刷新' }}
                    </button>
                  </div>
                </div>
                <div style="display: flex; flex-direction: column; gap: 4px;">
                  <label style="font-size: 12px; color: #888;">服务地址</label>
                  <input type="text" v-model="engineConfig.baseUrl" :disabled="runtimeState?.state === 'running'" style="padding: 4px 8px; border-radius: 4px; background: #222; color: #ddd; border: 1px solid #444; width: 220px;" />
                </div>
              </div>
              <div style="margin-top: 12px; padding: 12px; background: rgba(255,255,255,0.04); border-radius: 6px; border: 1px solid rgba(255,255,255,0.08);">
                <div style="display: flex; justify-content: space-between; align-items: center; gap: 12px; margin-bottom: 8px;">
                  <strong>模型控制信息</strong>
                  <span style="font-size: 12px; color: #999;" v-if="inspectingModel">正在探测模型访问...</span>
                </div>
                <div style="display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px 16px; font-size: 13px;">
                  <div>
                    <div style="color: #888; font-size: 12px;">访问状态</div>
                    <div :style="{ color: selectedModelInspection?.accessible ? '#7CFC9A' : '#FF8A80' }">{{ selectedModelInspection ? (selectedModelInspection.accessible ? '可访问' : '不可访问') : '未检测' }}</div>
                  </div>
                  <div>
                    <div style="color: #888; font-size: 12px;">检查时间</div>
                    <div>{{ selectedModelInspection?.checkedAt || '-' }}</div>
                  </div>
                  <div style="grid-column: 1 / -1;">
                    <div style="color: #888; font-size: 12px;">访问详情</div>
                    <div>{{ selectedModelInspection?.detail || '尚未执行模型访问探测' }}</div>
                  </div>
                  <div>
                    <div style="color: #888; font-size: 12px;">上下文窗口</div>
                    <div>{{ selectedModelInspection?.contextLength ?? engineConfig.contextLength ?? 'unknown' }}</div>
                  </div>
                  <div>
                    <div style="color: #888; font-size: 12px;">建议单轮输出</div>
                    <div>{{ selectedModelInspection?.recommendedMaxOutputTokens ?? engineConfig.recommendedMaxOutputTokens ?? 'unknown' }}</div>
                  </div>
                  <div>
                    <div style="color: #888; font-size: 12px;">Tokenizer</div>
                    <div>{{ selectedModelInspection?.tokenizer || engineConfig.tokenizer || 'unknown' }}</div>
                  </div>
                  <div>
                    <div style="color: #888; font-size: 12px;">元数据来源</div>
                    <div>{{ selectedModelInspection?.metadataSource || engineConfig.metadataSource || 'unknown' }}</div>
                  </div>
                  <div>
                    <div style="color: #888; font-size: 12px;">探测输入 Tokens</div>
                    <div>{{ selectedModelInspection?.usage?.promptTokens ?? '-' }}</div>
                  </div>
                  <div>
                    <div style="color: #888; font-size: 12px;">探测输出 Tokens</div>
                    <div>{{ selectedModelInspection?.usage?.completionTokens ?? '-' }}</div>
                  </div>
                  <div>
                    <div style="color: #888; font-size: 12px;">探测总 Tokens</div>
                    <div>{{ selectedModelInspection?.usage?.totalTokens ?? '-' }}</div>
                  </div>
                  <div>
                    <div style="color: #888; font-size: 12px;">提供方</div>
                    <div>{{ selectedModelOption?.ownedBy || 'local' }}</div>
                  </div>
                </div>
              </div>
            </div>
          </details>
        </div>

        <!-- 管理器功能面板区（处于运行态时全部展开展示） -->
        <div class="feature-panels" v-if="runtimeState?.state === 'running'">
          
          <!-- 1. 引擎诊断与配置上下文 (可折叠) -->
          <details class="panel" open>
            <summary class="panel-header">
              <div class="panel-title">🩺 运行时自检诊断 (Runtime Diagnostics)</div>
              <span class="indicator" v-if="connecting">🔄 自检流转中...</span>
            </summary>
            
            <div class="panel-content">
               <p v-if="error" class="text-error">{{ error }}</p>
               <p v-else-if="!selfCheck && !connecting" class="text-muted">未能获取诊断快照，请重新启动引擎拉取。</p>
               <div v-else-if="selfCheck" class="diagnostics-grid">
                  <div class="diagnostics-summary">
                    <strong>诊断综合汇报:</strong> {{ selfCheck.summary }}
                  </div>
                  
                  <div class="info-columns">
                    <div class="info-block">
                      <h3>💡 核心配置追踪 (Context Setup)</h3>
                      <dl class="prop-list">
                        <dt>驱动模型</dt><dd>{{ selfCheck.info.model }}</dd>
                        <dt>接口路由</dt><dd>{{ selfCheck.info.provider }}</dd>
                        <dt>服务地址</dt><dd class="code">{{ selfCheck.info.baseUrl }}</dd>
                        <dt>上下文窗口</dt><dd>{{ selfCheck.info.contextLength ?? 'unknown' }}</dd>
                        <dt>建议单轮输出</dt><dd>{{ selfCheck.info.recommendedMaxOutputTokens ?? 'unknown' }}</dd>
                        <dt>Tokenizer</dt><dd>{{ selfCheck.info.tokenizer || 'unknown' }}</dd>
                        <dt>持载区(CWD)</dt><dd class="code">{{ selfCheck.info.workspace }}</dd>
                        <dt>交互策略</dt><dd>{{ selfCheck.info.interactionMode }}</dd>
                        <dt>时间戳</dt><dd>{{ selfCheck.checkedAt }}</dd>
                      </dl>
                    </div>

                    <div class="info-block">
                      <h3>🔌 能力校验钩子 (Capabilities Check)</h3>
                      <ul class="capability-list">
                        <li v-for="item in selfCheck.checks" :key="item.key">
                          <span class="status-icon">{{ item.status === 'ok' ? '✅' : '⚠️' }}</span>
                          <div class="cap-text">
                            <strong>{{ getChineseCheckLabel(item.key) }}</strong>
                            <span class="cap-detail">{{ item.detail }}</span>
                          </div>
                        </li>
                      </ul>
                    </div>
                  </div>
               </div>
            </div>
          </details>

          <!-- 2. 模型交互沙盒 (Interactive Playground) -->
          <details class="panel" :open="sandboxOpen">
            <summary class="panel-header" @click="sandboxOpen = !sandboxOpen">
              <div class="panel-title">💬 模型基座直连测试 (Model Sandbox)</div>
            </summary>
            
            <div class="panel-content">
               <p class="sandbox-desc">发送直接测试指令验证大模型链路及当前引擎配置。由于本地大模型未开启时会报超时，可在此验证超时回滚或错误状态。</p>
               <div class="sandbox-layout">
                 <textarea 
                   class="sandbox-input" 
                   v-model="sandboxPrompt" 
                   placeholder="输入测试提示词..." 
                   rows="3"
                   :disabled="sandboxBusy"
                 ></textarea>
                 
                 <button 
                  class="action-btn sandbox-send" 
                  :disabled="sandboxBusy || !sandboxPrompt" 
                  @click="pingModel"
                 >
                   {{ sandboxBusy ? '生成呼叫中...' : 'Send Prompt 📤' }}
                 </button>
               </div>

               <div class="sandbox-result" v-if="sandboxReply || sandboxError || sandboxBusy">
                 <div class="sandbox-spinner" v-if="sandboxBusy">
                   <span>模型生成中，请耐心等待 (配置超时10秒) ...</span>
                 </div>
                 <div class="message-banner error" v-else-if="sandboxError">
                   <span>❌</span> 请求失败或超时: {{ sandboxError }}
                 </div>
                 <div class="sandbox-reply" v-else>
                   <span class="reply-badge">模型返回</span>
                   <p>{{ sandboxReply }}</p>
                 </div>
               </div>
            </div>
          </details>

          <!-- 3. 项目状态与任务栈看板 (占位/规划区) -->
          <details class="panel" open>
            <summary class="panel-header">
              <div class="panel-title">📋 调度任务栈看板 (Project status & Queues)</div>
            </summary>
            <div class="panel-content placeholder-mode">
              <p class="placeholder-desc">功能插槽：未来将直读内存文件 <code>STATUS.md</code> 与 <code>TASK_QUEUE.md</code>，可视化当前项目进度、阻塞项与堆积任务。</p>
              <div class="mock-grid">
                <div class="mock-card">
                  <div class="mock-icon">🟢</div>
                  <div class="mock-body">
                    <strong>全局服务健康</strong>
                    <span>Engine: http/1999 | Editor: http/8868</span>
                  </div>
                </div>
                <div class="mock-card">
                  <div class="mock-icon">📦</div>
                  <div class="mock-body">
                    <strong>原子任务队列排期</strong>
                    <span>当前积压：3 项待执行批次</span>
                  </div>
                </div>
              </div>
              <div class="panel-footer">
                <button class="action-btn outline" disabled>拉取工作区快照</button>
              </div>
            </div>
          </details>

          <!-- 3. 底层日志及决策轨 (占位/规划区) -->
          <details class="panel">
            <summary class="panel-header">
              <div class="panel-title">📜 后台日志与决策轨 (Logs & Trajectory)</div>
            </summary>
            <div class="panel-content placeholder-mode">
              <p class="placeholder-desc">功能插槽：未来将追踪 <code>hermes-gateway</code> 网关流，并解析 <code>DECISIONS.md</code> 提供代理活动的审计回放。</p>
              <div class="mock-terminal">
                <div class="log-line">[SYS] Control gateway bounded to Hermes process...</div>
                <div class="log-line">[SYS] Heartbeat sync established.</div>
                <div class="log-line text-muted">Awaiting external instruction triggers...</div>
              </div>
            </div>
          </details>

        </div>
    </section>
  </main>
</template>