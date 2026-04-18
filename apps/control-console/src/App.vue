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
  availableActions: Array<'start' | 'stop' | 'pause' | 'resume' | 'exit'>
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

type MemoryConfigAgent = {
  name: string
  title: string
  agentId: string
  role: string
  personality: string
  responsibilities: string[]
}

type MemoryConfig = {
  sourceFiles: string[]
  agentCount: number
  agents: MemoryConfigAgent[]
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
const memoryConfig = ref<MemoryConfig | null>(null)
const memoryConfigBusy = ref(false)
const memoryConfigError = ref('')



const leftBrainRunning = ref(false)
const rightBrainRunning = ref(false)
const liveLogs = ref('')
let logInterval: any = null

onMounted(() => {
  logInterval = setInterval(fetchLogs, 1500)
})

async function fetchLogs() {
  if (selectedAgentId.value) {
    try {
      const res = await fetch('/api/control/agents/' + selectedAgentId.value + '/logs')
      const data = await res.json()
      if (data.ok) liveLogs.value = data.logs
    } catch(e) {}
  }
}

async function actOnModel(side: 'left' | 'right', action: 'load'|'unload') {
  const brain = side === 'left' ? leftBrain.value : rightBrain.value
  if (!brain.model) return
  const isLeft = side === 'left'
  if (isLeft) inspectingLeft.value = true
  else inspectingRight.value = true

  try {
     const res = await fetch('/api/control/models/' + action, {
       method: 'POST',
       headers: { 'Content-Type': 'application/json' },
       body: JSON.stringify({ model: brain.model, provider: brain.provider, baseUrl: brain.baseUrl })
     })
     // If unloaded, mark as not ready
     if (action === 'unload') {
       if (isLeft && leftInspection.value) leftInspection.value.accessible = false
       if (!isLeft && rightInspection.value) rightInspection.value.accessible = false
     } else {
       await inspectSelectedModel(side) // Re-inspect to set it ready
     }
  } catch(e){}
  if (isLeft) inspectingLeft.value = false
  else inspectingRight.value = false
}

const leftBrain = ref({

  provider: 'custom/local',
  baseUrl: 'http://127.0.0.1:18888/v1',
  model: 'gpt-oss-20b-MXFP4-Q8',
  contextLength: null as number | null,
  recommendedMaxOutputTokens: null as number | null,
  tokenizer: null as string | null,
  metadataSource: 'unavailable'
})
const rightBrain = ref({
  provider: 'custom/local',
  baseUrl: 'http://127.0.0.1:18888/v1',
  model: 'gpt-oss-20b-MXFP4-Q8',
  contextLength: null as number | null,
  recommendedMaxOutputTokens: null as number | null,
  tokenizer: null as string | null,
  metadataSource: 'unavailable'
})

const availableLeftModels = ref<any[]>([])
const availableRightModels = ref<any[]>([])

const fetchingLeft = ref(false)
const fetchingRight = ref(false)

const leftError = ref('')
const rightError = ref('')

const leftInspection = ref<ModelInspection | null>(null)
const rightInspection = ref<ModelInspection | null>(null)

const inspectingLeft = ref(false)
const inspectingRight = ref(false)







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

const runtimePrimaryAction = computed<'start' | 'pause' | 'resume' | null>(() => {
  const actions = runtimeState.value?.availableActions || []
  if (actions.includes('pause')) return 'pause'
  if (actions.includes('resume')) return 'resume'
  if (actions.includes('start')) return 'start'
  return null
})

const runtimeActionLabel = computed(() => {
  if (!runtimePrimaryAction.value) return '启动引擎'
  if (runtimePrimaryAction.value === 'pause') return '暂停引擎'
  if (runtimePrimaryAction.value === 'resume') return '恢复引擎'
  if (runtimePrimaryAction.value === 'start') return '启动引擎'
  return '未安装'
})

const selectedModelOption = computed(() => {
  return availableLeftModels.value.find((item: LocalModelItem) => item.id === leftBrain.value.model) || null
})

const startBlockedByModelInspection = computed(() => {
  if (selectedAgent.value?.definition.runtime !== 'hermes') return false
  if (runtimeState.value?.state === 'running') return false
  return fetchingLeft.value || inspectingLeft.value || !leftBrain.value.model || leftInspection.value?.accessible === false
})

// 添加中文标签映射，使机器的 key 更易读
function getChineseCheckLabel(key: string) {
  const map: Record<string, string> = {
    'mcp-connection': 'MCP 协议连接池',
    'python-env': 'Python 运行时环境',
    'workspace-access': '工作区读写权限',
    'model-route': 'LLM 模型路由',
    'agent-memory': 'Agent 记忆配置'
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
    memoryConfig.value = null
    memoryConfigError.value = ''
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
    memoryConfig.value = null
    memoryConfigError.value = ''
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
  memoryConfigBusy.value = true
  try {
    const response = await fetch('/api/control/agents/' + selectedAgentId.value + '/config')
    if (response.ok) {
      const payload = await response.json()
      if (payload.ok) {
         // load into left
         leftBrain.value.provider = payload.config.provider
         leftBrain.value.baseUrl = payload.config.baseUrl
         leftBrain.value.model = payload.config.model
         memoryConfig.value = payload.config.memory || null
         memoryConfigError.value = ''
         // init both
         await fetchLocalModels('left')
         await fetchLocalModels('right')
      }
    } else {
      memoryConfig.value = null
      memoryConfigError.value = `config_http_${response.status}`
    }
  } catch(e) {
    memoryConfig.value = null
    memoryConfigError.value = String(e)
  } finally {
    memoryConfigBusy.value = false
  }
}




async function fetchLocalModels(side: 'left' | 'right') {
  const brain = side === 'left' ? leftBrain : rightBrain
  const fetching = side === 'left' ? fetchingLeft : fetchingRight
  const avail = side === 'left' ? availableLeftModels : availableRightModels
  const err = side === 'left' ? leftError : rightError

  fetching.value = true
  err.value = ''
  try {
    const backendParam = brain.value.provider === 'ollama' ? 'ollama' : 'omlx'
    const query = new URLSearchParams({
      provider: backendParam,
      baseUrl: brain.value.baseUrl
    })
    const resp = await fetch('/api/control/local-models?' + query.toString())
    if (resp.ok) {
      const data = await resp.json()
      if (data.ok) {
        avail.value = data.models as LocalModelItem[]
        if (data.models.length > 0 && !data.models.find((m: LocalModelItem) => m.id === brain.value.model)) {
          brain.value.model = data.models[0].id
        }
        syncEngineMetadataFromSelection(side)
        await inspectSelectedModel(side)
      } else {
        avail.value = []
        err.value = data.error || '模型列表获取失败'
      }
    } else {
      avail.value = []
      err.value = 'http_' + resp.status
    }
  } catch (e) {
    avail.value = []
    err.value = String(e)
  } finally {
    fetching.value = false
  }
}



function syncEngineMetadataFromSelection(side: 'left' | 'right') {
  const brain = side === 'left' ? leftBrain : rightBrain
  const avail = side === 'left' ? availableLeftModels : availableRightModels
  const selected = avail.value.find((item: LocalModelItem) => item.id === brain.value.model) || null
  
  if (!selected) {
    brain.value.contextLength = null
    brain.value.recommendedMaxOutputTokens = null
    brain.value.tokenizer = null
    brain.value.metadataSource = 'unavailable'
    return
  }
  brain.value.contextLength = selected.contextLength ?? null
  brain.value.recommendedMaxOutputTokens = selected.recommendedMaxOutputTokens ?? null
  brain.value.tokenizer = selected.tokenizer ?? null
  brain.value.metadataSource = selected.metadataSource || 'unavailable'
}



async function inspectSelectedModel(side: 'left' | 'right') {
  const brain = side === 'left' ? leftBrain : rightBrain
  const inspection = side === 'left' ? leftInspection : rightInspection
  const inspecting = side === 'left' ? inspectingLeft : inspectingRight

  if (!brain.value.model) {
    inspection.value = null
    return
  }

  inspecting.value = true
  try {
    const backendParam = brain.value.provider === 'ollama' ? 'ollama' : 'omlx'
    const query = new URLSearchParams({
      provider: backendParam,
      model: brain.value.model,
      baseUrl: brain.value.baseUrl
    })
    const response = await fetch('/api/control/local-models/inspect?' + query.toString())
    if (!response.ok) throw new Error('inspect_' + response.status)
    const payload = await response.json()
    inspection.value = payload.inspection || null
  } catch (e) {
    inspection.value = {
      model: brain.value.model,
      accessible: false,
      status: 'error',
      detail: String(e),
      checkedAt: new Date().toISOString(),
      usage: { promptTokens: null, completionTokens: null, totalTokens: null },
      contextLength: brain.value.contextLength,
      recommendedMaxOutputTokens: brain.value.recommendedMaxOutputTokens,
      tokenizer: brain.value.tokenizer,
      metadataSource: brain.value.metadataSource
    } as any
  } finally {
    inspecting.value = false
  }
}

function handleProviderChange(side: 'left' | 'right') {
  const brain = side === 'left' ? leftBrain : rightBrain
  brain.value.baseUrl = brain.value.provider === 'ollama' ? 'http://127.0.0.1:11434/v1' : 'http://127.0.0.1:18888/v1'
  brain.value.model = ''
  if(side === 'left') { availableLeftModels.value = []; leftInspection.value = null }
  else { availableRightModels.value = []; rightInspection.value = null }
  fetchLocalModels(side)
}

function handleModelChange(side: 'left' | 'right') {
  syncEngineMetadataFromSelection(side)
  inspectSelectedModel(side)
}

const chatHistory = ref<{role: string, content: string, tokens?: any}[]>([])
async function sendChat() {
  if (!sandboxPrompt.value.trim()) return
  
  const userText = sandboxPrompt.value
  chatHistory.value.push({ role: 'user', content: userText })
  sandboxPrompt.value = ''
  sandboxBusy.value = true

  try {
    const response = await fetch('/api/control/agents/hermes-manager/ping-model', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: userText })
    })
    const payload = await response.json()
    if (payload.ok) {
      chatHistory.value.push({ 
         role: 'hermes', 
         content: payload.reply, 
         tokens: payload.raw?.usage // capture token count here!
      })
    } else {
      chatHistory.value.push({ role: 'error', content: payload.error })
    }
  } catch (e) {
    chatHistory.value.push({ role: 'error', content: String(e) })
  } finally {
    sandboxBusy.value = false
  }
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



async function toggleHermesRuntime(side: 'left' | 'right') {
  if (!selectedAgent.value || selectedAgent.value.definition.runtime !== 'hermes') return

  runtimeBusy.value = true
  error.value = ''

  try {
    const brain = side === 'left' ? leftBrain.value : rightBrain.value
    const isRunningNow = side === 'left' ? leftBrainRunning.value : rightBrainRunning.value
    const action = isRunningNow ? 'stop' : 'start'
    
    // Check if we are stopping the last brain
    const willStopBoth = action === 'stop' && (
      (side === 'left' && !rightBrainRunning.value) || 
      (side === 'right' && !leftBrainRunning.value)
    );

    const payloadBody: any = { action, brainSide: side, stopAll: willStopBoth }
    if (action === 'start') {
       payloadBody.config = { ...brain, side }
    }
    const response = await fetch('/api/control/agents/hermes-manager/runtime-action', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payloadBody)
    })
    
    if (response.ok) {
       const payload = await response.json()
       runtimeState.value = payload.runtimeStatus
       if (side === 'left') leftBrainRunning.value = !isRunningNow
       else rightBrainRunning.value = !isRunningNow
    }
  } catch (caught) {
    error.value = String(caught)
  } finally {
    runtimeBusy.value = false
  }
}

async function toggleGlobalRuntime() {
  if (!selectedAgent.value || selectedAgent.value.definition.runtime !== 'hermes' || !runtimeState.value) return

  if (runtimeState.value.state === 'uninstalled') {
    error.value = runtimeState.value.detail
    return
  }

  runtimeBusy.value = true
  error.value = ''

  try {
    const action = runtimePrimaryAction.value
    if (!action) {
      error.value = 'runtime_action_unavailable'
      return
    }
    
    const payloadBody: any = { action, brainSide: 'left', stopAll: true }
    if (action === 'start' || action === 'resume') {
       payloadBody.config = { ...leftBrain.value, side: 'left' }
    }
    const response = await fetch('/api/control/agents/hermes-manager/runtime-action', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payloadBody)
    })
    
    if (response.ok) {
       const payload = await response.json()
       runtimeState.value = payload.runtimeStatus
       if (action === 'start' || action === 'resume') {
           leftBrainRunning.value = true
           await loadHermesSelfCheck()
       } else {
           leftBrainRunning.value = false
           rightBrainRunning.value = false
           selfCheck.value = null
       }
    }
  } catch (caught) {
    error.value = String(caught)
  } finally {
    runtimeBusy.value = false
  }
}

</script>

<template>
  <main class="shell">
    <header class="console-header">
      <h1>智能体网关 (Agent Gateway)</h1>
      
      <div class="agent-controls">
        <div class="agent-selector-bar">
          <label for="agent-select">智能体管理器：</label>
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
            :disabled="runtimeBusy || runtimeState?.state === 'uninstalled' || !runtimePrimaryAction"
            @click="toggleGlobalRuntime"
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
          

        <details class="panel" open style="margin-bottom: 16px; border: 1px solid #444;">
          <summary class="panel-header" style="background: rgba(100,100,100,0.2)">
            <div class="panel-title">📜 后台日志与决策轨 (Real-time Logs & Trajectory)</div>
          </summary>
          <div class="panel-content">
            <textarea readonly v-model="liveLogs" style="width:100%; height: 150px; background: #111; color: #00ff00; font-family: monospace; font-size: 11px; padding: 8px; border: 1px solid #333; resize: vertical; outline: none;" placeholder="等待日志回放..."></textarea>
          </div>
        </details>

        <div class="dual-brain-container" style="display: flex; gap: 16px; margin-bottom: 16px; width: 100%;">
  <!-- Left Brain -->
  <details class="panel" open style="flex: 1; border: 1px solid #444;">
    <summary class="panel-header" style="display: flex; align-items: center; justify-content: space-between; background: rgba(0,200,255,0.1)">
      
  <div class="panel-title" style="flex: 1;">🧠 左脑配置 (Left Brain)</div>
  <button class="action-btn" :disabled="runtimeBusy || startBlockedByModelInspection" @click="toggleHermesRuntime('left')" style="padding: 2px 10px; font-size: 12px; margin-left: auto;">
     {{ runtimeBusy ? '处理中...' : (leftBrainRunning ? '🔴 停止左脑' : '🚀 启动左脑') }}
  </button>

    </summary>
    <div class="panel-content">
      <div style="display: flex; gap: 16px; align-items: center; padding: 12px; background: rgba(0,0,0,0.2); border-radius: 6px;">
        <div style="flex: 1; display: flex; flex-direction: column; gap: 4px;">
          <label>推理平台</label>
          <select v-model="leftBrain.provider" @change="handleProviderChange('left')">
            <option value="custom/local">OMLX (Local)</option>
            <option value="ollama">Ollama</option>
          </select>
        </div>
        <div style="flex: 1; display: flex; flex-direction: column; gap: 4px;">
          <label>服务地址</label>
          <input type="text" v-model="leftBrain.baseUrl" />
        </div>
      </div>
      <div style="display: flex; flex-direction: column; gap: 4px; margin-top: 12px; padding: 12px; background: rgba(0,0,0,0.2); border-radius: 6px;">
        <label>运行模型</label>
        <div style="display: flex; gap: 8px;">
          <select v-model="leftBrain.model" @change="handleModelChange('left')" style="flex: 1;">
            <option v-for="mod in availableLeftModels" :key="mod.id" :value="mod.id">{{ mod.id }}</option>
          </select>
          
          <button @click="fetchLocalModels('left')" :disabled="fetchingLeft">{{ fetchingLeft ? '...' : '刷新' }}</button>
          <button @click="actOnModel('left', 'load')" style="margin-left:8px; border:1px solid #4caf50; background:transparent; color:#4caf50;">➕加载</button>
          <button @click="actOnModel('left', 'unload')" style="border:1px solid #f44336; background:transparent; color:#f44336;">➖卸载</button>

        </div>
      </div>
      <div v-if="leftInspection" style="margin-top: 12px; font-size: 12px; color: #aaa;">
         状态: <span :style="{color: leftInspection.accessible ? '#7CFC9A' : '#FF8A80'}">{{ leftInspection.accessible ? '就绪' : '异常' }}</span>
         | 窗口: {{ leftInspection.contextLength || '-' }}
         | 探测Tokens: {{ leftInspection.usage?.totalTokens || '-' }}
      </div>
    </div>
  </details>

  <!-- Right Brain -->
  <details class="panel" open style="flex: 1; border: 1px solid #444;">
    <summary class="panel-header" style="display: flex; align-items: center; justify-content: space-between; background: rgba(255,200,0,0.1)">
      
  <div class="panel-title" style="flex: 1;">🧠 右脑配置 (Right Brain)</div>
  <button class="action-btn" :disabled="runtimeBusy || startBlockedByModelInspection" @click="toggleHermesRuntime('right')" style="padding: 2px 10px; font-size: 12px; margin-left: auto;">
     {{ runtimeBusy ? '处理中...' : (rightBrainRunning ? '🔴 停止右脑' : '🚀 启动右脑') }}
  </button>

    </summary>
    <div class="panel-content">
      <div style="display: flex; gap: 16px; align-items: center; padding: 12px; background: rgba(0,0,0,0.2); border-radius: 6px;">
        <div style="flex: 1; display: flex; flex-direction: column; gap: 4px;">
          <label>推理平台</label>
          <select v-model="rightBrain.provider" @change="handleProviderChange('right')">
            <option value="custom/local">OMLX (Local)</option>
            <option value="ollama">Ollama</option>
          </select>
        </div>
        <div style="flex: 1; display: flex; flex-direction: column; gap: 4px;">
          <label>服务地址</label>
          <input type="text" v-model="rightBrain.baseUrl" />
        </div>
      </div>
      <div style="display: flex; flex-direction: column; gap: 4px; margin-top: 12px; padding: 12px; background: rgba(0,0,0,0.2); border-radius: 6px;">
        <label>运行模型</label>
        <div style="display: flex; gap: 8px;">
          <select v-model="rightBrain.model" @change="handleModelChange('right')" style="flex: 1;">
            <option v-for="mod in availableRightModels" :key="mod.id" :value="mod.id">{{ mod.id }}</option>
          </select>
          
          <button @click="fetchLocalModels('right')" :disabled="fetchingRight">{{ fetchingRight ? '...' : '刷新' }}</button>
          <button @click="actOnModel('right', 'load')" style="margin-left:8px; border:1px solid #4caf50; background:transparent; color:#4caf50;">➕加载</button>
          <button @click="actOnModel('right', 'unload')" style="border:1px solid #f44336; background:transparent; color:#f44336;">➖卸载</button>

        </div>
      </div>
      <div v-if="rightInspection" style="margin-top: 12px; font-size: 12px; color: #aaa;">
         状态: <span :style="{color: rightInspection.accessible ? '#7CFC9A' : '#FF8A80'}">{{ rightInspection.accessible ? '就绪' : '异常' }}</span>
         | 窗口: {{ rightInspection.contextLength || '-' }}
         | 探测Tokens: {{ rightInspection.usage?.totalTokens || '-' }}
      </div>
    </div>
  </details>
</div>

<details class="panel" open style="margin-bottom: 16px; border: 1px solid #444;">
  <summary class="panel-header" style="display: flex; align-items: center; justify-content: space-between; background: rgba(140,255,0,0.08)">
    <div class="panel-title">🧩 记忆配置 (Agent Memory)</div>
    <button class="action-btn" @click.stop="loadEngineConfig" :disabled="memoryConfigBusy" style="padding: 2px 10px; font-size: 12px; margin-left: auto;">
      {{ memoryConfigBusy ? '读取中...' : '刷新记忆' }}
    </button>
  </summary>
  <div class="panel-content">
    <div style="display: flex; gap: 16px; flex-wrap: wrap; margin-bottom: 12px;">
      <div style="flex: 1; min-width: 220px; padding: 12px; background: rgba(0,0,0,0.2); border-radius: 6px;">
        <div style="font-size: 12px; color: #aaa; margin-bottom: 6px;">配置摘要</div>
        <div style="font-size: 24px; font-weight: 700; color: #8cff00;">{{ memoryConfig?.agentCount ?? 0 }}</div>
        <div style="font-size: 12px; color: #aaa;">已读取 Agent 数量</div>
      </div>
      <div style="flex: 2; min-width: 320px; padding: 12px; background: rgba(0,0,0,0.2); border-radius: 6px;">
        <div style="font-size: 12px; color: #aaa; margin-bottom: 6px;">Hermes 读取源</div>
        <div v-if="memoryConfig?.sourceFiles?.length" style="display: flex; flex-direction: column; gap: 4px; font-size: 12px; color: #ddd;">
          <div v-for="sourceFile in memoryConfig.sourceFiles" :key="sourceFile" style="font-family: monospace; word-break: break-all;">{{ sourceFile }}</div>
        </div>
        <div v-else style="font-size: 12px; color: #888;">未检测到 agent 配置文件。</div>
      </div>
    </div>

    <div v-if="memoryConfigError" class="text-error">{{ memoryConfigError }}</div>

    <div v-if="memoryConfig?.agents?.length" style="display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 12px;">
      <div v-for="agent in memoryConfig.agents" :key="agent.agentId || agent.name" style="padding: 12px; background: rgba(0,0,0,0.2); border-radius: 6px; border: 1px solid rgba(255,255,255,0.06);">
        <div style="display: flex; align-items: baseline; justify-content: space-between; gap: 8px; margin-bottom: 10px;">
          <div style="font-size: 16px; font-weight: 600;">{{ agent.name }}</div>
          <div style="font-size: 11px; color: #8cff00; font-family: monospace;">{{ agent.agentId || 'unknown' }}</div>
        </div>
        <div style="font-size: 12px; color: #aaa; margin-bottom: 4px;">角色</div>
        <div style="margin-bottom: 10px; color: #f2f2f2;">{{ agent.role }}</div>
        <div style="font-size: 12px; color: #aaa; margin-bottom: 4px;">性格</div>
        <div style="margin-bottom: 10px; color: #f2f2f2;">{{ agent.personality }}</div>
        <div style="font-size: 12px; color: #aaa; margin-bottom: 4px;">工作职责</div>
        <ul style="margin: 0; padding-left: 18px; color: #ddd; display: flex; flex-direction: column; gap: 4px;">
          <li v-for="responsibility in agent.responsibilities" :key="responsibility">{{ responsibility }}</li>
        </ul>
      </div>
    </div>
    <div v-else-if="!memoryConfigBusy && !memoryConfigError" style="font-size: 12px; color: #888;">暂无可展示的 Agent 记忆配置。</div>
  </div>
</details>

<details class="panel" open style="margin-bottom: 24px;">
  <summary class="panel-header" style="display: flex; align-items: center; justify-content: space-between;">
    <div class="panel-title">💬 Hermes 直连对话 (Chat & Token Monitor)</div>
  </summary>
  <div class="panel-content">
    <div class="chat-container" style="display: flex; flex-direction: column; gap: 12px; max-height: 400px; overflow-y: auto; padding: 12px; background: rgba(0,0,0,0.3); border-radius: 6px; margin-bottom: 12px;">
       <div v-for="(msg, i) in chatHistory" :key="i" :style="{
         padding: '8px 12px',
         borderRadius: '6px',
         alignSelf: msg.role === 'user' ? 'flex-end' : 'flex-start',
         background: msg.role === 'user' ? '#1976D2' : (msg.role === 'error' ? '#D32F2F' : '#333'),
         maxWidth: '80%'
       }">
          <div style="font-weight: bold; font-size: 12px; opacity: 0.8; margin-bottom: 4px;">{{ msg.role.toUpperCase() }}</div>
          <div>{{ msg.content }}</div>
          <div v-if="msg.tokens" style="font-size: 11px; color: #8CFF00; margin-top: 6px; border-top: 1px solid rgba(255,255,255,0.1); padding-top: 4px;">
            Token 消耗: 提示词 {{ msg.tokens.prompt_tokens }} | 输出 {{ msg.tokens.completion_tokens }} | 总计 {{ msg.tokens.total_tokens }}
          </div>
       </div>
    </div>
    <div style="display: flex; gap: 8px;">
      <input type="text" v-model="sandboxPrompt" @keyup.enter="sendChat" placeholder="直接发送指令给 Hermes..." style="flex: 1; padding: 8px; border-radius: 4px; background: #222; border: 1px solid #555; color: #fff;" />
      <button class="action-btn" @click="sendChat" :disabled="sandboxBusy">{{ sandboxBusy ? '发送中...' : '发送' }}</button>
    </div>
  </div>
</details>

        </div>

        <!-- 管理器功能面板区（处于运行态时全部展开展示） -->
        <div class="feature-panels" v-if="runtimeState?.state === 'running'">
          
          <!-- 1. 引擎诊断与配置上下文 (可折叠) -->
          <details class="panel" open>
            <summary class="panel-header" style="display: flex; align-items: center; justify-content: space-between;">
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
          

          <!-- 3. 项目状态与任务栈看板 (占位/规划区) -->
          <details class="panel" open>
            <summary class="panel-header" style="display: flex; align-items: center; justify-content: space-between;">
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

          

        </div>
    </section>
  </main>
</template>