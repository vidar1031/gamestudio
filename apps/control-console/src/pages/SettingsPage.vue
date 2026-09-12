<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { useControlConsoleApp } from '../composables/useControlConsoleApp'
import { runMemoryLifecycleMaintenance, getMemoryLifecycleReport } from '../services/controlApi'
import { alertDialog, confirmDialog } from '../lib/uiDialog'

const app = useControlConsoleApp()

const apiKeys = ref({
  moonshot: '',
  openai: '',
  doubao: ''
})

const maintenanceBusy = ref(false)
const maintenanceResult = ref<any>(null)
const maintenanceError = ref('')
const reportBusy = ref(false)
const reportData = ref<any>(null)
const reportError = ref('')

onMounted(() => {
  app.loadEngineConfig()
  apiKeys.value.moonshot = sessionStorage.getItem('gs_api_key_moonshot') || ''
  apiKeys.value.openai = sessionStorage.getItem('gs_api_key_openai') || ''
  apiKeys.value.doubao = sessionStorage.getItem('gs_api_key_doubao') || ''
})

function saveApiKeys() {
  sessionStorage.setItem('gs_api_key_moonshot', apiKeys.value.moonshot)
  sessionStorage.setItem('gs_api_key_openai', apiKeys.value.openai)
  sessionStorage.setItem('gs_api_key_doubao', apiKeys.value.doubao)
  void alertDialog('API Key 已保存到当前会话（sessionStorage）')
}

async function restartControl() {
  if (!(await confirmDialog({ title: '重启 Control Server', message: '确定要重启 Control Server 吗？页面会短暂断开并自动恢复。', confirmText: '确认重启' }))) return
  app.restartGlobalRuntime()
}

async function runMaintenance() {
  const agentId = app.selectedAgentId.value || 'hermes-manager'
  maintenanceBusy.value = true
  maintenanceError.value = ''
  maintenanceResult.value = null
  try {
    const res = await runMemoryLifecycleMaintenance(agentId)
    const payload = await res.json().catch(() => null)
    if (!res.ok || !payload?.ok) throw new Error(payload?.error || `http_${res.status}`)
    maintenanceResult.value = payload
  } catch (e) {
    maintenanceError.value = String(e)
  } finally {
    maintenanceBusy.value = false
  }
}

async function loadReport() {
  const agentId = app.selectedAgentId.value || 'hermes-manager'
  reportBusy.value = true
  reportError.value = ''
  reportData.value = null
  try {
    const res = await getMemoryLifecycleReport(agentId)
    const payload = await res.json().catch(() => null)
    if (!res.ok || !payload?.ok) throw new Error(payload?.error || `http_${res.status}`)
    reportData.value = payload
  } catch (e) {
    reportError.value = String(e)
  } finally {
    reportBusy.value = false
  }
}
</script>

<template>
  <div class="page-settings">
    <section class="page-section">
      <h2>API Key 与会话配置</h2>
      <p class="section-hint">以下密钥仅保存在浏览器 sessionStorage 中，刷新页面后需重新输入。生产环境应通过后端安全存储。</p>

      <div class="form-group">
        <label>Moonshot API Key</label>
        <input v-model="apiKeys.moonshot" type="password" class="form-input" placeholder="sk-..." />
      </div>
      <div class="form-group">
        <label>OpenAI API Key</label>
        <input v-model="apiKeys.openai" type="password" class="form-input" placeholder="sk-..." />
      </div>
      <div class="form-group">
        <label>豆包 API Key</label>
        <input v-model="apiKeys.doubao" type="password" class="form-input" placeholder="..." />
      </div>

      <button class="action-btn primary" @click="saveApiKeys">保存到会话</button>
    </section>

    <section class="page-section">
      <h2>内存生命周期维护</h2>
      <p class="section-hint">清理过期会话、归档旧记忆文件、回收磁盘空间。</p>
      <div class="action-bar">
        <button class="action-btn" :disabled="maintenanceBusy" @click="runMaintenance">
          {{ maintenanceBusy ? '维护中...' : '执行维护' }}
        </button>
        <button class="action-btn" :disabled="reportBusy" @click="loadReport">
          {{ reportBusy ? '加载中...' : '查看报告' }}
        </button>
      </div>
      <div v-if="maintenanceError" class="error-banner">{{ maintenanceError }}</div>
      <div v-if="maintenanceResult" class="result-pre">{{ JSON.stringify(maintenanceResult, null, 2) }}</div>
      <div v-if="reportError" class="error-banner">{{ reportError }}</div>
      <div v-if="reportData" class="result-pre">{{ JSON.stringify(reportData, null, 2) }}</div>
    </section>

    <section class="page-section">
      <h2>系统运维</h2>
      <div class="action-bar">
        <button class="action-btn" :disabled="app.runtimeBusy.value" @click="restartControl">
          {{ app.runtimeBusy.value ? '执行中...' : '重启 Control Server' }}
        </button>
        <button class="action-btn" @click="app.loadEngineConfig()">刷新引擎配置</button>
      </div>

      <div class="placeholder-panel">
        <p>此处未来可扩展：环境变量管理、启动脚本配置、ComfyUI/OMLX 路径设置、自动启动项。</p>
      </div>
    </section>
  </div>
</template>

<style scoped>
.page-settings {
  display: flex;
  flex-direction: column;
  gap: 24px;
}

.page-section h2 {
  margin: 0 0 6px;
  font-size: 18px;
  color: var(--c-text-inv);
}

.section-hint {
  margin: 0 0 16px;
  color: var(--c-text-sub);
  font-size: 13px;
}

.form-group {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-bottom: 14px;
}

.form-group label {
  font-size: 13px;
  color: var(--c-text-sub);
  font-weight: 600;
}

.form-input {
  padding: 10px 12px;
  border-radius: 8px;
  border: 1px solid var(--c-border-mid);
  background: var(--c-bg-input);
  color: var(--c-text);
  font: inherit;
  font-size: 14px;
}

.form-input:focus {
  outline: none;
  border-color: var(--c-accent);
}

.action-btn {
  padding: 8px 14px;
  border-radius: 8px;
  border: 1px solid var(--c-border-mid);
  background: rgba(255, 255, 255, 0.06);
  color: var(--c-text);
  font: inherit;
  font-size: 13px;
  cursor: pointer;
}

.action-btn:hover {
  background: rgba(255, 255, 255, 0.1);
}

.action-btn:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}

.action-btn.primary {
  background: var(--c-accent);
  color: #081018;
  border-color: transparent;
}

.action-bar {
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
  margin-bottom: 14px;
}

.error-banner {
  margin-bottom: 12px;
  padding: 10px 12px;
  border-radius: 8px;
  background: rgba(255, 107, 107, 0.14);
  border: 1px solid rgba(255, 107, 107, 0.28);
  color: var(--c-error);
  font-size: 13px;
}

.result-pre {
  padding: 12px;
  border-radius: 8px;
  background: #0b0f14;
  border: 1px solid var(--c-border);
  color: var(--c-text-sub);
  font-family: SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  font-size: 12px;
  line-height: 1.5;
  max-height: 260px;
  overflow: auto;
  white-space: pre-wrap;
  word-break: break-word;
}

.placeholder-panel {
  padding: 18px;
  border-radius: 10px;
  background: var(--c-bg-panel);
  border: 1px dashed var(--c-border-mid);
  color: var(--c-text-sub);
  font-size: 14px;
  line-height: 1.6;
}
</style>
