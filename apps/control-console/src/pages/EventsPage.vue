<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { getEventRegistry, getEventRuns, dispatchEvent } from '../services/eventsApi'
import { getProjectBinding, type ProjectBinding, type ProjectBindingProbe } from '../services/bindingApi'

// 注册表事件类型（字段与 apps/server/events/registry.v1.json 对齐）
type RegistryEvent = {
  code?: string
  eventId: string
  version?: number
  category: string
  kind: 'query' | 'command' | string
  title: string
  description?: string
  payloadSchema?: { required?: string[] }
  sideEffects?: string[]
  idempotent?: boolean
  reviewRequired?: boolean
  timeoutMs?: number
  aliases?: string[]
}

type RegistryCategory = { id: string; title: string }

type EventRegistry = {
  registryVersion?: string
  categories?: RegistryCategory[]
  events?: RegistryEvent[]
}

type EventRun = {
  traceId?: string
  ts?: string
  eventId?: string
  code?: string
  kind?: string
  caller?: string
  ok?: boolean
  durationMs?: number
  error?: string | null
  transport?: { method?: string; endpoint?: string; status?: number }
}

type RunResult = {
  ok: boolean
  error?: string | null
  durationMs?: number
  result?: unknown
  traceId?: string
}

const binding = ref<ProjectBinding | null>(null)
const probe = ref<ProjectBindingProbe | null>(null)
const registry = ref<EventRegistry | null>(null)
const unavailableReason = ref('')
const loading = ref(false)
const loadError = ref('')

const executeBusy = ref<Record<string, boolean>>({})
const executeResults = ref<Record<string, RunResult>>({})
const historyOpen = ref<Record<string, boolean>>({})
const historyBusy = ref<Record<string, boolean>>({})
const historyRuns = ref<Record<string, EventRun[]>>({})

const events = computed(() => registry.value?.events || [])
const eventCount = computed(() => events.value.length)

// 按 category 分组：先按注册表 categories 顺序，再补充未登记的分组
const groupedEvents = computed(() => {
  const categories = registry.value?.categories || []
  const groups: { id: string; title: string; events: RegistryEvent[] }[] = []
  const byCategory = new Map<string, RegistryEvent[]>()
  for (const event of events.value) {
    const key = String(event.category || 'other')
    if (!byCategory.has(key)) byCategory.set(key, [])
    byCategory.get(key)!.push(event)
  }
  for (const category of categories) {
    const list = byCategory.get(category.id)
    if (list?.length) {
      groups.push({ id: category.id, title: category.title || category.id, events: list })
      byCategory.delete(category.id)
    }
  }
  for (const [id, list] of byCategory.entries()) {
    groups.push({ id, title: id, events: list })
  }
  return groups
})

// 查询类且无必填参数的事件可在页面直接执行；其余保持聊天入口纪律
function canRunInline(event: RegistryEvent) {
  if (event.kind !== 'query') return false
  const required = event.payloadSchema?.required
  return !Array.isArray(required) || required.length === 0
}

function chatHint(event: RegistryEvent) {
  const alias = event.aliases?.[0] || event.code || event.eventId
  return `在聊天中输入 gamestudio ${alias} 执行`
}

async function load() {
  loading.value = true
  loadError.value = ''
  unavailableReason.value = ''
  registry.value = null
  try {
    const bindingRes = await getProjectBinding()
    const bindingPayload = await bindingRes.json().catch(() => null)
    if (bindingRes.ok && bindingPayload?.ok) {
      binding.value = bindingPayload.binding || null
      probe.value = bindingPayload.probe || null
    }
    const res = await getEventRegistry()
    const payload = await res.json().catch(() => null)
    if (!payload) throw new Error(`event_registry_http_${res.status}`)
    if (payload.available === true && payload.registry) {
      registry.value = payload.registry as EventRegistry
      if (payload.binding) binding.value = payload.binding
    } else {
      unavailableReason.value = payload.error || payload.reason || 'registry_unavailable'
    }
  } catch (e) {
    loadError.value = e instanceof Error ? e.message : String(e)
  } finally {
    loading.value = false
  }
}

async function runEvent(event: RegistryEvent) {
  if (!canRunInline(event) || executeBusy.value[event.eventId]) return
  executeBusy.value[event.eventId] = true
  delete executeResults.value[event.eventId]
  try {
    const res = await dispatchEvent({ event: event.eventId, payload: {}, caller: 'console' })
    const result = await res.json().catch(() => null)
    executeResults.value[event.eventId] = result || { ok: false, error: `event_dispatch_http_${res.status}` }
  } catch (e) {
    executeResults.value[event.eventId] = { ok: false, error: e instanceof Error ? e.message : String(e) }
  } finally {
    executeBusy.value[event.eventId] = false
  }
}

async function toggleHistory(event: RegistryEvent) {
  const key = event.eventId
  historyOpen.value[key] = !historyOpen.value[key]
  if (!historyOpen.value[key]) return
  historyBusy.value[key] = true
  try {
    const res = await getEventRuns(event.eventId, 10)
    const payload = await res.json().catch(() => null)
    historyRuns.value[key] = Array.isArray(payload?.runs) ? payload.runs : []
  } catch {
    historyRuns.value[key] = []
  } finally {
    historyBusy.value[key] = false
  }
}

function formatTime(ts?: string) {
  if (!ts) return '-'
  const date = new Date(ts)
  return Number.isNaN(date.getTime()) ? ts : date.toLocaleString()
}

function formatResult(result: unknown) {
  try {
    const text = JSON.stringify(result, null, 2)
    return text.length > 1200 ? `${text.slice(0, 1200)}\n…（结果过长已截断）` : text
  } catch {
    return String(result)
  }
}

onMounted(load)
</script>

<template>
  <div class="page-events">
    <section class="binding-card">
      <div class="binding-info">
        <div class="binding-title">
          <span class="binding-name">{{ binding?.bound ? binding.label || '已绑定项目' : '尚未绑定项目' }}</span>
          <span
            v-if="binding?.bound"
            class="reach-badge"
            :data-tone="probe?.reachable ? 'success' : 'error'"
          >{{ probe?.reachable ? '在线' : '不可达' }}</span>
        </div>
        <div v-if="binding?.bound" class="binding-meta">{{ binding.baseUrl }}</div>
        <div v-else class="binding-meta">绑定后此处展示事件来源服务地址</div>
      </div>
      <div class="binding-side">
        <span v-if="registry" class="event-count">{{ eventCount }} 个事件</span>
        <button class="action-btn" :disabled="loading" @click="load">{{ loading ? '加载中…' : '刷新' }}</button>
      </div>
    </section>

    <div v-if="loadError" class="error-banner">事件注册表加载失败：{{ loadError }}</div>

    <div v-else-if="binding && !binding.bound" class="empty-state">
      尚未绑定项目。请先到「项目」页顶部完成绑定，再回来查看事件地图。
      <router-link class="link-btn" to="/projects">去项目页绑定</router-link>
    </div>

    <div v-else-if="!loading && unavailableReason" class="empty-state">
      绑定的项目暂时不可达，无法读取事件注册表（{{ unavailableReason }}）。
      请确认 GameStudio 服务已启动，然后点击「刷新」重试。
    </div>

    <template v-else-if="registry">
      <section v-for="group in groupedEvents" :key="group.id" class="event-group">
        <h2 class="group-title">{{ group.title }} <span class="group-count">{{ group.events.length }}</span></h2>
        <div class="event-list">
          <div v-for="event in group.events" :key="event.eventId" class="event-card">
            <div class="event-main">
              <div class="event-head">
                <span class="event-title">{{ event.title }}</span>
                <span class="event-code">{{ event.code || event.eventId }}</span>
                <span class="kind-badge" :data-kind="event.kind">
                  {{ event.kind === 'query' ? '查询 · 直接执行' : '命令 · 需确认' }}
                </span>
                <span v-if="event.sideEffects?.length" class="flag-badge warn">有副作用</span>
                <span v-if="event.timeoutMs" class="flag-badge">超时 {{ Math.round(event.timeoutMs / 1000) }}s</span>
              </div>
              <div v-if="event.description" class="event-desc">{{ event.description }}</div>
              <div v-if="event.aliases?.length" class="event-aliases">
                <span v-for="alias in event.aliases" :key="alias" class="alias-chip">{{ alias }}</span>
              </div>
              <div v-if="!canRunInline(event)" class="event-hint">
                {{ chatHint(event) }}<template v-if="event.kind === 'query'">（需要参数）</template><template v-else>（命令类事件需在确认卡片中执行）</template>
              </div>

              <div v-if="executeResults[event.eventId]" class="run-result" :data-ok="executeResults[event.eventId].ok">
                <div class="run-result-head">
                  {{ executeResults[event.eventId].ok ? '执行成功' : '执行失败' }}
                  <span v-if="executeResults[event.eventId].durationMs !== undefined" class="run-duration">
                    {{ executeResults[event.eventId].durationMs }}ms
                  </span>
                </div>
                <div v-if="executeResults[event.eventId].error" class="run-error">{{ executeResults[event.eventId].error }}</div>
                <pre v-else class="run-json">{{ formatResult(executeResults[event.eventId].result) }}</pre>
              </div>

              <div v-if="historyOpen[event.eventId]" class="run-history">
                <div v-if="historyBusy[event.eventId]" class="history-empty">加载中…</div>
                <div v-else-if="!historyRuns[event.eventId]?.length" class="history-empty">暂无执行记录</div>
                <div v-for="run in historyRuns[event.eventId]" :key="run.traceId || run.ts" class="history-row">
                  <span class="history-status" :data-ok="run.ok">{{ run.ok ? '成功' : '失败' }}</span>
                  <span class="history-time">{{ formatTime(run.ts) }}</span>
                  <span class="history-meta">{{ run.caller || '-' }} · {{ run.durationMs ?? '-' }}ms</span>
                  <span v-if="run.error" class="history-error">{{ run.error }}</span>
                </div>
              </div>
            </div>
            <div class="event-actions">
              <button
                v-if="canRunInline(event)"
                class="action-btn primary"
                :disabled="executeBusy[event.eventId]"
                @click="runEvent(event)"
              >{{ executeBusy[event.eventId] ? '执行中…' : '执行' }}</button>
              <button class="action-btn" @click="toggleHistory(event)">
                {{ historyOpen[event.eventId] ? '收起历史' : '历史' }}
              </button>
            </div>
          </div>
        </div>
      </section>
    </template>
  </div>
</template>

<style scoped>
.page-events {
  display: flex;
  flex-direction: column;
  gap: 20px;
}

.binding-card {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 14px;
  padding: 14px 16px;
  border-radius: 10px;
  background: var(--c-bg-panel);
  border: 1px solid var(--c-border);
}

.binding-title {
  display: flex;
  align-items: center;
  gap: 10px;
}

.binding-name {
  font-size: 15px;
  font-weight: 700;
  color: var(--c-text-inv);
}

.binding-meta {
  margin-top: 4px;
  font-size: 12px;
  color: var(--c-text-muted);
  font-family: SFMono-Regular, Menlo, Monaco, Consolas, monospace;
}

.binding-side {
  display: flex;
  align-items: center;
  gap: 10px;
}

.event-count {
  font-size: 12px;
  color: var(--c-text-sub);
}

.reach-badge {
  padding: 2px 8px;
  border-radius: 999px;
  font-size: 12px;
}

.reach-badge[data-tone='success'] {
  background: rgba(77, 214, 140, 0.15);
  color: var(--c-success);
}

.reach-badge[data-tone='error'] {
  background: rgba(255, 107, 107, 0.15);
  color: var(--c-error);
}

.error-banner {
  padding: 10px 12px;
  border-radius: 8px;
  background: rgba(255, 107, 107, 0.14);
  border: 1px solid rgba(255, 107, 107, 0.28);
  color: var(--c-error);
  font-size: 13px;
}

.empty-state {
  padding: 28px;
  text-align: center;
  color: var(--c-text-muted);
  font-size: 14px;
  line-height: 1.8;
  background: var(--c-bg-panel);
  border: 1px dashed var(--c-border);
  border-radius: 10px;
}

.link-btn {
  color: var(--c-accent);
  text-decoration: none;
  margin-left: 6px;
}

.event-group {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.group-title {
  margin: 0;
  font-size: 15px;
  color: var(--c-text-inv);
}

.group-count {
  margin-left: 6px;
  font-size: 12px;
  font-weight: 400;
  color: var(--c-text-muted);
}

.event-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.event-card {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 14px;
  padding: 14px 16px;
  border-radius: 10px;
  background: var(--c-bg-panel);
  border: 1px solid var(--c-border);
}

.event-main {
  flex: 1;
  min-width: 0;
}

.event-head {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
}

.event-title {
  font-weight: 600;
  color: var(--c-text-inv);
}

.event-code {
  font-size: 12px;
  color: var(--c-text-muted);
  font-family: SFMono-Regular, Menlo, Monaco, Consolas, monospace;
}

.kind-badge {
  padding: 2px 8px;
  border-radius: 999px;
  font-size: 12px;
}

.kind-badge[data-kind='query'] {
  background: var(--c-accent-dim);
  color: var(--c-accent);
}

.kind-badge[data-kind='command'] {
  background: rgba(246, 201, 78, 0.15);
  color: var(--c-warn);
}

.flag-badge {
  padding: 2px 8px;
  border-radius: 999px;
  font-size: 12px;
  background: rgba(255, 255, 255, 0.06);
  color: var(--c-text-sub);
}

.flag-badge.warn {
  background: rgba(255, 107, 107, 0.12);
  color: var(--c-error-dim);
}

.event-desc {
  margin-top: 6px;
  font-size: 13px;
  color: var(--c-text-sub);
  line-height: 1.6;
}

.event-aliases {
  margin-top: 8px;
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.alias-chip {
  padding: 1px 8px;
  border-radius: 999px;
  font-size: 12px;
  background: rgba(255, 255, 255, 0.06);
  border: 1px solid var(--c-border);
  color: var(--c-text-sub);
}

.event-hint {
  margin-top: 8px;
  font-size: 12px;
  color: var(--c-text-muted);
}

.event-actions {
  display: flex;
  flex-direction: column;
  gap: 8px;
  flex-shrink: 0;
}

.action-btn {
  padding: 7px 14px;
  border-radius: 8px;
  border: 1px solid var(--c-border-mid);
  background: rgba(255, 255, 255, 0.06);
  color: var(--c-text);
  font: inherit;
  font-size: 13px;
  cursor: pointer;
  white-space: nowrap;
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

.run-result {
  margin-top: 10px;
  padding: 10px 12px;
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.04);
  border: 1px solid var(--c-border);
}

.run-result[data-ok='true'] {
  border-color: rgba(77, 214, 140, 0.3);
}

.run-result[data-ok='false'] {
  border-color: rgba(255, 107, 107, 0.3);
}

.run-result-head {
  font-size: 13px;
  font-weight: 600;
  color: var(--c-text-inv);
}

.run-duration {
  margin-left: 8px;
  font-weight: 400;
  color: var(--c-text-muted);
}

.run-error {
  margin-top: 6px;
  font-size: 12px;
  color: var(--c-error);
}

.run-json {
  margin: 8px 0 0;
  padding: 8px 10px;
  border-radius: 6px;
  background: var(--c-bg-deep);
  font-size: 12px;
  line-height: 1.5;
  color: var(--c-text-sub);
  max-height: 260px;
  overflow: auto;
  white-space: pre-wrap;
  word-break: break-all;
}

.run-history {
  margin-top: 10px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.history-empty {
  padding: 10px;
  font-size: 12px;
  color: var(--c-text-muted);
}

.history-row {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 10px;
  padding: 8px 10px;
  border-radius: 6px;
  background: rgba(255, 255, 255, 0.04);
  font-size: 12px;
}

.history-status[data-ok='true'] {
  color: var(--c-success);
}

.history-status[data-ok='false'] {
  color: var(--c-error);
}

.history-time {
  color: var(--c-text-sub);
}

.history-meta {
  color: var(--c-text-muted);
}

.history-error {
  color: var(--c-error-dim);
  word-break: break-all;
}
</style>
