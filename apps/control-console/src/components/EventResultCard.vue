<script setup lang="ts">
import { computed } from 'vue'

type DispatchResult = {
  ok: boolean
  eventId: string | null
  code?: string | null
  kind?: string
  traceId: string
  durationMs?: number
  transport?: {
    method?: string
    endpoint?: string
    status?: number
  }
  result?: unknown
  error?: string | null
}

const props = defineProps<{
  result: DispatchResult
  busy?: boolean
}>()

const emit = defineEmits<{
  (e: 'close'): void
}>()

const resultPreview = computed(() => {
  try {
    const text = JSON.stringify(props.result.result, null, 2)
    return text.length > 1200 ? `${text.slice(0, 1200)}...` : text
  } catch {
    return '[unserializable]'
  }
})

const statusLabel = computed(() => (props.result.ok ? '执行成功' : '执行失败'))
const transportLine = computed(() => {
  const t = props.result.transport || {}
  return [t.method, t.endpoint, t.status ? `HTTP ${t.status}` : ''].filter(Boolean).join(' ')
})
</script>

<template>
  <div class="event-result-card" :data-ok="result.ok ? 'true' : 'false'">
    <div class="event-result-header">
      <div>
        <div class="event-result-title">
          事件执行结果 <span class="event-result-status">{{ statusLabel }}</span>
        </div>
        <div class="event-result-meta">
          <span>{{ result.eventId }}</span>
          <span v-if="result.code">{{ result.code }}</span>
          <span v-if="transportLine">{{ transportLine }}</span>
          <span v-if="result.durationMs != null">{{ result.durationMs }}ms</span>
          <span v-if="result.traceId">trace {{ result.traceId.slice(0, 8) }}</span>
        </div>
      </div>
      <button class="event-result-close" type="button" @click="emit('close')">关闭</button>
    </div>
    <div v-if="busy" class="event-result-loading">执行中...</div>
    <div v-else-if="result.error" class="event-result-error">{{ result.error }}</div>
    <pre v-if="!busy && resultPreview" class="event-result-preview">{{ resultPreview }}</pre>
  </div>
</template>

<style scoped>
.event-result-card {
  margin: 6px 12px;
  border: 1px solid var(--c-border-mid);
  border-radius: 10px;
  background: var(--c-bg-panel);
  padding: 12px;
}
.event-result-card[data-ok='true'] { border-color: rgba(77, 214, 140, 0.4); }
.event-result-card[data-ok='false'] { border-color: rgba(255, 107, 107, 0.4); }
.event-result-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 10px;
}
.event-result-title { font-size: 13px; font-weight: 600; color: var(--c-text); }
.event-result-status {
  font-size: 11px;
  font-weight: 400;
  margin-left: 6px;
  color: var(--c-success-dim);
}
.event-result-card[data-ok='false'] .event-result-status { color: var(--c-error-dim); }
.event-result-meta {
  margin-top: 4px;
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  font-size: 11px;
  color: var(--c-text-muted);
  font-family: monospace;
}
.event-result-close {
  border: 1px solid var(--c-border-mid);
  background: transparent;
  color: var(--c-text-sub);
  border-radius: 8px;
  padding: 4px 12px;
  font-size: 12px;
  cursor: pointer;
  flex: none;
}
.event-result-close:hover { color: var(--c-text); border-color: var(--c-accent); }
.event-result-loading { margin-top: 8px; font-size: 12px; color: var(--c-text-muted); }
.event-result-error {
  margin-top: 8px;
  font-size: 12px;
  color: var(--c-error-dim);
  border: 1px solid rgba(255, 107, 107, 0.35);
  background: rgba(255, 107, 107, 0.08);
  border-radius: 8px;
  padding: 8px 10px;
}
.event-result-preview {
  margin: 8px 0 0;
  max-height: 240px;
  overflow: auto;
  font-size: 11px;
  background: rgba(0, 0, 0, 0.25);
  border-radius: 6px;
  padding: 8px;
  white-space: pre-wrap;
  word-break: break-all;
  scrollbar-width: none;
  -ms-overflow-style: none;
}
.event-result-preview::-webkit-scrollbar { display: none; }
</style>
