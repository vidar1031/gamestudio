<script setup lang="ts">
import { computed } from 'vue'

type RegistryEvent = {
  eventId: string
  code?: string
  version?: number
  category: string
  kind: 'command' | 'query' | string
  title: string
  description?: string
  reviewRequired?: boolean
  timeoutMs?: number
}

type RegistryCategory = {
  id: string
  title: string
}

type Registry = {
  registryVersion: string
  provider?: {
    id?: string
    name?: string
    baseUrl?: string
  }
  categories?: RegistryCategory[]
  events: RegistryEvent[]
}

const props = defineProps<{
  registry: Registry
  busy?: boolean
  error?: string
}>()

const emit = defineEmits<{
  (e: 'close'): void
}>()

const groupedEvents = computed(() => {
  const categories = props.registry.categories || []
  const events = Array.isArray(props.registry.events) ? props.registry.events : []
  const groups = categories.map((category) => ({
    id: category.id,
    title: category.title,
    events: events.filter((event) => event.category === category.id)
  }))
  const knownIds = new Set(categories.map((category) => category.id))
  const others = events.filter((event) => !knownIds.has(event.category))
  if (others.length > 0) {
    groups.push({ id: '_other', title: '其他', events: others })
  }
  return groups.filter((group) => group.events.length > 0)
})

const commandCount = computed(() => (props.registry.events || []).filter((event) => event.kind === 'command').length)
const queryCount = computed(() => (props.registry.events || []).filter((event) => event.kind === 'query').length)
</script>

<template>
  <div class="event-chain-card">
    <div class="event-chain-header">
      <div>
        <div class="event-chain-title">
          项目事件链
          <span class="event-chain-sub">
            {{ registry.provider?.name || registry.provider?.id || 'GameStudio' }} · 注册表 v{{ registry.registryVersion }} · {{ registry.events.length }} 个事件（指令 {{ commandCount }} / 查询 {{ queryCount }}）
          </span>
        </div>
        <div class="event-chain-desc">通过对话激活载入；事件到具体执行的映射下一步处理。</div>
      </div>
      <button class="event-chain-close" type="button" @click="emit('close')">关闭</button>
    </div>

    <div v-if="busy" class="event-chain-loading">事件链载入中...</div>
    <div v-else-if="error" class="event-chain-error">{{ error }}</div>
    <div v-else class="event-chain-body">
      <div v-for="group in groupedEvents" :key="group.id" class="event-chain-group">
        <div class="event-chain-group-title">{{ group.title }}（{{ group.events.length }}）</div>
        <div class="event-chain-event-list">
          <div v-for="event in group.events" :key="event.eventId" class="event-chain-event">
            <span class="event-chain-event-kind" :data-kind="event.kind">{{ event.kind === 'command' ? '指令' : '查询' }}</span>
            <span v-if="event.code" class="event-chain-event-code">{{ event.code }}</span>
            <span class="event-chain-event-title">{{ event.title }}</span>
            <span v-if="event.reviewRequired" class="event-chain-event-review">需审核</span>
            <span class="event-chain-event-id">{{ event.eventId }}</span>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.event-chain-card {
  margin: 6px 12px;
  border: 1px solid var(--c-accent-dim);
  border-radius: 10px;
  background: var(--c-bg-panel);
  padding: 12px;
}
.event-chain-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 10px;
}
.event-chain-title { font-size: 13px; font-weight: 600; color: var(--c-accent); }
.event-chain-sub { font-size: 11px; color: var(--c-text-muted); font-weight: 400; margin-left: 6px; }
.event-chain-desc { margin-top: 4px; font-size: 11px; color: var(--c-text-muted); }
.event-chain-close {
  border: 1px solid var(--c-border-mid);
  background: transparent;
  color: var(--c-text-sub);
  border-radius: 8px;
  padding: 4px 12px;
  font-size: 12px;
  cursor: pointer;
  flex: none;
}
.event-chain-close:hover { color: var(--c-text); border-color: var(--c-accent); }
.event-chain-loading { margin-top: 10px; font-size: 12px; color: var(--c-text-muted); }
.event-chain-error {
  margin-top: 10px;
  font-size: 12px;
  color: var(--c-error-dim);
  border: 1px solid rgba(255, 107, 107, 0.35);
  background: rgba(255, 107, 107, 0.08);
  border-radius: 8px;
  padding: 8px 10px;
}
.event-chain-body { margin-top: 10px; max-height: 320px; overflow-y: auto; scrollbar-width: none; -ms-overflow-style: none; }
.event-chain-body::-webkit-scrollbar { display: none; }
.event-chain-group { margin-bottom: 10px; }
.event-chain-group:last-child { margin-bottom: 0; }
.event-chain-group-title { font-size: 12px; font-weight: 600; color: var(--c-text-sub); margin-bottom: 4px; }
.event-chain-event-list { display: flex; flex-direction: column; gap: 2px; }
.event-chain-event {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  padding: 3px 6px;
  border-radius: 6px;
}
.event-chain-event:hover { background: rgba(94, 204, 255, 0.06); }
.event-chain-event-kind {
  flex: none;
  font-size: 10px;
  padding: 0 6px;
  border-radius: 999px;
  border: 1px solid var(--c-border-mid);
  color: var(--c-text-muted);
}
.event-chain-event-kind[data-kind='command'] {
  border-color: var(--c-accent-dim);
  color: var(--c-accent);
}
.event-chain-event-code {
  flex: none;
  font-size: 10px;
  padding: 0 6px;
  border-radius: 6px;
  font-family: monospace;
  background: rgba(94, 204, 255, 0.1);
  border: 1px solid var(--c-accent-dim);
  color: var(--c-accent);
}
.event-chain-event-title { color: var(--c-text); }
.event-chain-event-review {
  flex: none;
  font-size: 10px;
  padding: 0 6px;
  border-radius: 999px;
  border: 1px solid rgba(246, 201, 78, 0.4);
  color: var(--c-warn);
}
.event-chain-event-id { margin-left: auto; font-size: 11px; color: var(--c-text-muted); font-family: monospace; }
</style>
