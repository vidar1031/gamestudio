<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { useControlConsoleApp } from '../composables/useControlConsoleApp'
import { getStructuredLogs, triggerSupervision } from '../services/controlApi'

const app = useControlConsoleApp()

const logPrefix = ref('control')
const logLines = ref(100)
const structuredLogs = ref<any[]>([])
const structuredBusy = ref(false)
const structuredError = ref('')
const supervisionTriggerBusy = ref(false)
const supervisionTriggerMessage = ref('')

async function loadStructuredLogs() {
  structuredBusy.value = true
  structuredError.value = ''
  try {
    const res = await getStructuredLogs(logPrefix.value, logLines.value)
    const payload = await res.json().catch(() => null)
    if (!res.ok || !payload?.ok) throw new Error(payload?.error || `http_${res.status}`)
    structuredLogs.value = Array.isArray(payload.logs) ? payload.logs : []
  } catch (e) {
    structuredError.value = String(e)
  } finally {
    structuredBusy.value = false
  }
}

async function runSupervision() {
  supervisionTriggerBusy.value = true
  supervisionTriggerMessage.value = ''
  try {
    const res = await triggerSupervision({ trigger: 'manual' })
    const payload = await res.json().catch(() => null)
    if (!res.ok || !payload?.ok) throw new Error(payload?.error || `http_${res.status}`)
    supervisionTriggerMessage.value = payload.message || '监督评估已触发'
    setTimeout(() => app.loadSupervisionResult(), 2000)
  } catch (e) {
    supervisionTriggerMessage.value = String(e)
  } finally {
    supervisionTriggerBusy.value = false
  }
}

onMounted(() => {
  app.fetchLogs()
  app.loadSupervisionResult()
  loadStructuredLogs()
})
</script>

<template>
  <div class="page-logs">
    <section class="page-section">
      <div class="section-header">
        <h2>实时日志</h2>
        <button class="action-btn" @click="app.fetchLogs()">刷新</button>
      </div>
      <div class="log-toolbar">
        <button class="action-btn" :disabled="app.logClearBusy.value" @click="app.clearVisibleLogs()">
          {{ app.logClearBusy.value ? '清理中...' : '清空显示' }}
        </button>
      </div>
      <div ref="app.logContainer" class="log-viewer">
        <div
          v-for="(line, index) in app.visibleLogLines.value"
          :key="index"
          class="log-line"
          :style="{ color: app.getLogLineColor(line) }"
        >
          {{ line }}
        </div>
        <div v-if="!app.visibleLogLines.value.length" class="empty-state">暂无日志</div>
      </div>
    </section>

    <section class="page-section">
      <div class="section-header">
        <h2>结构化日志查询</h2>
      </div>
      <div class="query-bar">
        <div class="form-group">
          <label>前缀</label>
          <input v-model="logPrefix" type="text" placeholder="control" />
        </div>
        <div class="form-group">
          <label>行数</label>
          <input v-model.number="logLines" type="number" min="10" max="1000" />
        </div>
        <button class="action-btn" :disabled="structuredBusy" @click="loadStructuredLogs">
          {{ structuredBusy ? '查询中...' : '查询' }}
        </button>
      </div>
      <div v-if="structuredError" class="error-banner">{{ structuredError }}</div>
      <div class="structured-log-viewer">
        <pre v-if="structuredLogs.length" class="structured-pre">{{ JSON.stringify(structuredLogs, null, 2) }}</pre>
        <div v-else class="empty-state">无结构化日志</div>
      </div>
    </section>

    <section class="page-section">
      <h2>自检与监督</h2>
      <div class="action-bar">
        <button class="action-btn" @click="app.loadHermesSelfCheck()">刷新自检</button>
        <button class="action-btn" :disabled="app.supervisionLoading.value" @click="app.loadSupervisionResult()">
          {{ app.supervisionLoading.value ? '加载中...' : '查看监督评估' }}
        </button>
        <button class="action-btn" :disabled="supervisionTriggerBusy" @click="runSupervision">
          {{ supervisionTriggerBusy ? '触发中...' : '触发监督评估' }}
        </button>
      </div>
      <div v-if="supervisionTriggerMessage" class="message-tip">{{ supervisionTriggerMessage }}</div>

      <div v-if="app.selfCheck.value" class="diagnostics-card">
        <div class="diag-title">自检结果</div>
        <div class="diag-summary">{{ app.selfCheck.value.summary }}</div>
        <div class="diag-checks">
          <div
            v-for="check in app.selfCheck.value.checks"
            :key="check.key"
            class="diag-check"
            :data-status="check.status"
          >
            <span class="check-key">{{ check.label }}</span>
            <span class="check-status">{{ check.status }}</span>
            <span class="check-detail">{{ check.detail }}</span>
          </div>
        </div>
      </div>
    </section>
  </div>
</template>

<style scoped>
.page-logs {
  display: flex;
  flex-direction: column;
  gap: 24px;
}

.page-section h2 {
  margin: 0 0 6px;
  font-size: 18px;
  color: var(--c-text-inv);
}

.section-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 12px;
}

.log-toolbar {
  margin-bottom: 10px;
}

.log-viewer {
  min-height: 320px;
  max-height: 520px;
  overflow-y: auto;
  padding: 14px;
  border-radius: 10px;
  background: #0b0f14;
  border: 1px solid var(--c-border);
  font-family: SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  font-size: 12px;
  line-height: 1.55;
  color: var(--c-text-sub);
  white-space: pre-wrap;
  word-break: break-word;
}

.log-line {
  padding: 1px 0;
}

.empty-state {
  padding: 24px;
  text-align: center;
  color: var(--c-text-muted);
}

.query-bar {
  display: flex;
  gap: 12px;
  align-items: flex-end;
  flex-wrap: wrap;
  margin-bottom: 12px;
}

.form-group {
  display: flex;
  flex-direction: column;
  gap: 5px;
}

.form-group label {
  font-size: 12px;
  color: var(--c-text-sub);
}

.form-group input {
  padding: 8px 10px;
  border-radius: 6px;
  border: 1px solid var(--c-border-mid);
  background: var(--c-bg-input);
  color: var(--c-text);
  font: inherit;
  font-size: 13px;
}

.structured-log-viewer {
  min-height: 160px;
  max-height: 360px;
  overflow: auto;
  padding: 12px;
  border-radius: 8px;
  background: #0b0f14;
  border: 1px solid var(--c-border);
}

.structured-pre {
  margin: 0;
  font-family: SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  font-size: 12px;
  line-height: 1.5;
  color: var(--c-text-sub);
  white-space: pre-wrap;
  word-break: break-word;
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

.error-banner {
  margin-bottom: 12px;
  padding: 10px 12px;
  border-radius: 8px;
  background: rgba(255, 107, 107, 0.14);
  border: 1px solid rgba(255, 107, 107, 0.28);
  color: var(--c-error);
  font-size: 13px;
}

.message-tip {
  margin-bottom: 12px;
  font-size: 13px;
  color: var(--c-success);
}

.action-bar {
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
  margin-bottom: 16px;
}

.diagnostics-card {
  padding: 16px;
  border-radius: 10px;
  background: var(--c-bg-panel);
  border: 1px solid var(--c-border);
}

.diag-title {
  font-weight: 700;
  color: var(--c-text-inv);
  margin-bottom: 8px;
}

.diag-summary {
  font-size: 13px;
  color: var(--c-text-sub);
  margin-bottom: 12px;
}

.diag-checks {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.diag-check {
  display: grid;
  grid-template-columns: 140px 80px 1fr;
  gap: 12px;
  align-items: center;
  padding: 8px 10px;
  border-radius: 6px;
  background: var(--c-bg-card);
  font-size: 13px;
}

.check-key {
  color: var(--c-text);
  font-weight: 600;
}

.check-status {
  text-transform: uppercase;
  font-size: 11px;
  font-weight: 700;
}

.check-status[data-status='ok'], .diag-check[data-status='ok'] .check-status {
  color: var(--c-success);
}

.check-status[data-status='error'], .diag-check[data-status='error'] .check-status {
  color: var(--c-error);
}

.check-detail {
  color: var(--c-text-sub);
}
</style>
