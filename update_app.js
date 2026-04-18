const fs = require('fs');
let code = fs.readFileSync('apps/control-console/src/App.vue', 'utf8');

// Replace single engineConfig with dual brains.
code = code.replace(/const engineConfig = ref\({[\s\S]*?}\)/, `
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
`);

// Update logic calls
code = code.replace(/async function loadEngineConfig\(\) {[\s\S]*?^}/m, `
async function loadEngineConfig() {
  try {
    const response = await fetch('/api/control/agents/' + selectedAgentId.value + '/config')
    if (response.ok) {
      const payload = await response.json()
      if (payload.ok) {
         // load into left
         leftBrain.value.provider = payload.config.provider
         leftBrain.value.baseUrl = payload.config.baseUrl
         leftBrain.value.model = payload.config.model
         // init both
         await fetchLocalModels('left')
         await fetchLocalModels('right')
      }
    }
  } catch(e) {}
}
`);

code = code.replace(/async function fetchLocalModels\(\) {[\s\S]*?^}/m, `
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
`);

code = code.replace(/function syncEngineMetadataFromSelection\(\) {[\s\S]*?^}/m, `
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
`);

code = code.replace(/async function inspectSelectedModel\(\) {[\s\S]*?^}/m, `
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
`);

// The html template part:
code = code.replace(/<details class="panel" open>[\s\S]*?<div class="panel-title">⚙️ 模型引擎配置[\s\S]*?<\/div>[\s\S]*?<\/details>/, 
`
<div class="dual-brain-container" style="display: flex; gap: 16px; margin-bottom: 16px; width: 100%;">
  <!-- Left Brain -->
  <details class="panel" open style="flex: 1; border: 1px solid #444;">
    <summary class="panel-header" style="background: rgba(0,200,255,0.1)">
      <div class="panel-title">🧠 左脑配置 (Left Brain)</div>
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
    <summary class="panel-header" style="background: rgba(255,200,0,0.1)">
      <div class="panel-title">🧠 右脑配置 (Right Brain)</div>
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

<details class="panel" open style="margin-bottom: 24px;">
  <summary class="panel-header">
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
`
);

// Clean up old remaining vars to prevent compilation error
code = code.replace(/engineConfig\.value/g, 'leftBrain.value');
code = code.replace(/const engineConfig = ref\({[\s\S]*?}\)/g, '');
code = code.replace(/const availableLocalModels = ref<any\[\]>\(\[\]\)/g, '');
code = code.replace(/const fetchingModels = ref\(false\)/g, '');
code = code.replace(/const modelInventoryError = ref\(''\)/g, '');
code = code.replace(/const selectedModelInspection = ref<ModelInspection \| null>\(null\)/g, '');
code = code.replace(/const inspectingModel = ref\(false\)/g, '');
code = code.replace(/function handleProviderChange\(\) {[\s\S]*?^}/m, '');
code = code.replace(/function handleModelChange\(\) {[\s\S]*?^}/m, '');
code = code.replace(/async function pingModel\(\) {[\s\S]*?^}/m, '');
// Remove old sandbox details
code = code.replace(/<details class="panel" :open="sandboxOpen">[\s\S]*?<\/details>/, '');

fs.writeFileSync('apps/control-console/src/App.vue', code);
console.log('App.vue updated successfully.');
