<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { getProjectBinding, type ProjectBinding, type ProjectCapability } from '../services/bindingApi'

type ActionItem = {
  actionId: string
  traceId: string
  sessionId?: string | null
  capabilityId: string
  projectId?: string | null
  input: Record<string, unknown>
  actor: string
  state: string
  stateTransitions: Array<{ from: string | null; to: string; reason: string; timestamp: string }>
  evidence: Array<Record<string, unknown>>
  review?: { decision: string; actor: string; note?: string; reviewedAt: string } | null
  result?: Record<string, unknown> | null
  error?: string | null
  retryCount: number
  maxRetries: number
  createdAt: string
  updatedAt: string
  optimization?: {
    round: number
    parentActionId?: string | null
    bestScore?: number | null
    history: Array<Record<string, unknown>>
  }
}

const binding = ref<ProjectBinding | null>(null)
const capabilities = ref<ProjectCapability[]>([])
const actions = ref<ActionItem[]>([])
const loading = ref(false)
const loadError = ref('')
const filterStatus = ref('')
const transitionBusy = ref<Record<string, boolean>>({})

const filteredActions = computed(() => {
  if (!filterStatus.value) return actions.value
  return actions.value.filter((item) => item.state === filterStatus.value)
})

const stateOptions = [
  { value: '', label: '全部状态' },
  { value: 'planned', label: '已计划' },
  { value: 'ready', label: '就绪' },
  { value: 'executing', label: '执行中' },
  { value: 'waiting_review', label: '待审核' },
  { value: 'approved', label: '已批准' },
  { value: 'failed', label: '失败' },
  { value: 'retry_wait', label: '待重试' },
  { value: 'completed', label: '已完成' },
  { value: 'rolled_back', label: '已回滚' },
  { value: 'cancelled', label: '已取消' }
]

function stateLabel(state: string) {
  const found = stateOptions.find((item) => item.value === state)
  return found ? found.label : state
}

function stateTone(state: string) {
  if (state === 'completed') return 'success'
  if (state === 'failed' || state === 'rolled_back') return 'error'
  if (state === 'waiting_review' || state === 'retry_wait') return 'warn'
  if (state === 'executing') return 'accent'
  return 'default'
}

async function load() {
  loading.value = true
  loadError.value = ''
  try {
    const bindingRes = await getProjectBinding()
    const bindingPayload = await bindingRes.json().catch(() => null)
    if (bindingRes.ok && bindingPayload?.ok) {
      binding.value = bindingPayload.binding || null
      capabilities.value = Array.isArray(bindingPayload.capabilities) ? bindingPayload.capabilities : []
    }
    const res = await fetch('/api/control/actions?limit=100')
    const payload = await res.json().catch(() => null)
    if (!res.ok || !payload?.ok) throw new Error(payload?.error || `http_${res.status}`)
    actions.value = Array.isArray(payload.actions) ? payload.actions : []
  } catch (e) {
    loadError.value = e instanceof Error ? e.message : String(e)
  } finally {
    loading.value = false
  }
}

async function execute(action: ActionItem) {
  if (transitionBusy.value[action.actionId]) return
  transitionBusy.value[action.actionId] = true
  try {
    const res = await fetch(`/api/control/actions/${encodeURIComponent(action.actionId)}/execute`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirmed: false })
    })
    const payload = await res.json().catch(() => null)
    if (!res.ok || !payload?.ok) {
      if (payload?.error === 'review_required') {
        await load()
        return
      }
      throw new Error(payload?.error || `http_${res.status}`)
    }
    await load()
  } catch (e) {
    loadError.value = e instanceof Error ? e.message : String(e)
  } finally {
    transitionBusy.value[action.actionId] = false
  }
}

async function transition(action: ActionItem, toState: string) {
  if (transitionBusy.value[action.actionId]) return
  transitionBusy.value[action.actionId] = true
  try {
    const res = await fetch(`/api/control/actions/${encodeURIComponent(action.actionId)}/transition`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ toState, actor: 'console', reason: 'manual_from_console' })
    })
    const payload = await res.json().catch(() => null)
    if (!res.ok || !payload?.ok) throw new Error(payload?.error || `http_${res.status}`)
    await load()
  } catch (e) {
    loadError.value = e instanceof Error ? e.message : String(e)
  } finally {
    transitionBusy.value[action.actionId] = false
  }
}

function formatTime(iso?: string) {
  if (!iso) return '-'
  try {
    return new Date(iso).toLocaleString('zh-CN', { hour12: false })
  } catch {
    return iso
  }
}

onMounted(() => {
  load()
})
</script>

<template>
  <div class="page-actions">
    <section class="page-section">
      <div class="section-header">
        <h2>项目动作</h2>
        <button class="action-btn" @click="load">刷新</button>
      </div>
      <p class="section-hint">每个动作是绑定项目能力的一次受控执行实例，具备独立状态机、审核记录与证据链。</p>

      <div v-if="loadError" class="error-banner">{{ loadError }}</div>

      <div class="filter-bar">
        <select v-model="filterStatus" class="filter-select">
          <option v-for="opt in stateOptions" :key="opt.value" :value="opt.value">{{ opt.label }}</option>
        </select>
        <span class="filter-count">共 {{ filteredActions.length }} 项</span>
      </div>

      <div v-if="loading" class="empty-state">加载中…</div>
      <div v-else-if="!filteredActions.length" class="empty-state">暂无动作记录。</div>

      <div v-else class="action-list">
        <div v-for="action in filteredActions" :key="action.actionId" class="action-card">
          <div class="action-header">
            <span class="action-capability">{{ action.capabilityId }}</span>
            <span class="action-state" :data-tone="stateTone(action.state)">{{ stateLabel(action.state) }}</span>
          </div>
          <div class="action-meta">
            <span>ID：{{ action.actionId }}</span>
            <span>Trace：{{ action.traceId }}</span>
            <span>发起：{{ action.actor }}</span>
            <span>时间：{{ formatTime(action.createdAt) }}</span>
          </div>
          <div v-if="action.projectId" class="action-project">项目：{{ action.projectId }}</div>
          <div v-if="action.error" class="action-error">错误：{{ action.error }}</div>
          <div v-if="action.review" class="action-review">
            审核：{{ action.review.decision === 'approve' ? '通过' : '拒绝' }}（{{ action.review.actor }}）
            <span v-if="action.review.note">— {{ action.review.note }}</span>
          </div>
          <div class="action-controls">
            <button
              v-if="action.state === 'ready' || action.state === 'retry_wait'"
              class="action-btn primary"
              :disabled="transitionBusy[action.actionId]"
              @click="execute(action)"
            >
              执行
            </button>
            <template v-if="action.state === 'waiting_review'">
              <button class="action-btn primary" :disabled="transitionBusy[action.actionId]" @click="transition(action, 'approved')">
                批准
              </button>
              <button class="action-btn danger" :disabled="transitionBusy[action.actionId]" @click="transition(action, 'failed')">
                拒绝
              </button>
            </template>
          </div>
        </div>
      </div>
    </section>
  </div>
</template>

<style scoped>
.page-actions {
  display: flex;
  flex-direction: column;
  gap: 24px;
}

.page-section h2 {
  margin: 0;
  font-size: 18px;
  color: var(--c-text-inv);
}

.section-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 6px;
}

.section-hint {
  margin: 0 0 14px;
  color: var(--c-text-sub);
  font-size: 13px;
}

.error-banner {
  margin-bottom: 14px;
  padding: 10px 12px;
  border-radius: 8px;
  background: rgba(255, 107, 107, 0.14);
  border: 1px solid rgba(255, 107, 107, 0.28);
  color: var(--c-error);
  font-size: 13px;
}

.filter-bar {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 14px;
}

.filter-select {
  padding: 8px 12px;
  border-radius: 8px;
  border: 1px solid var(--c-border-mid);
  background: var(--c-bg-input);
  color: var(--c-text);
  font: inherit;
  font-size: 13px;
}

.filter-count {
  font-size: 12px;
  color: var(--c-text-sub);
}

.action-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.action-card {
  padding: 14px 16px;
  border-radius: 10px;
  background: var(--c-bg-panel);
  border: 1px solid var(--c-border);
}

.action-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.action-capability {
  font-weight: 600;
  color: var(--c-text-inv);
  font-size: 14px;
}

.action-state {
  padding: 2px 10px;
  border-radius: 999px;
  font-size: 12px;
  background: rgba(255, 255, 255, 0.08);
  color: var(--c-text-sub);
}

.action-state[data-tone='success'] {
  background: rgba(77, 214, 140, 0.15);
  color: var(--c-success);
}

.action-state[data-tone='error'] {
  background: rgba(255, 107, 107, 0.15);
  color: var(--c-error);
}

.action-state[data-tone='warn'] {
  background: rgba(246, 201, 78, 0.15);
  color: var(--c-warn);
}

.action-state[data-tone='accent'] {
  background: rgba(94, 204, 255, 0.15);
  color: var(--c-accent);
}

.action-meta {
  margin-top: 8px;
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  font-size: 12px;
  color: var(--c-text-muted);
  font-family: SFMono-Regular, Menlo, Monaco, Consolas, monospace;
}

.action-project {
  margin-top: 6px;
  font-size: 12px;
  color: var(--c-text-sub);
}

.action-error {
  margin-top: 6px;
  font-size: 12px;
  color: var(--c-error);
}

.action-review {
  margin-top: 6px;
  font-size: 12px;
  color: var(--c-warn);
}

.action-controls {
  margin-top: 10px;
  display: flex;
  gap: 8px;
}

.action-btn {
  padding: 6px 12px;
  border-radius: 8px;
  border: 1px solid var(--c-border-mid);
  background: rgba(255, 255, 255, 0.06);
  color: var(--c-text);
  font: inherit;
  font-size: 12px;
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

.action-btn.danger {
  background: rgba(255, 107, 107, 0.18);
  border-color: rgba(255, 107, 107, 0.34);
  color: var(--c-error);
}

.empty-state {
  padding: 28px;
  text-align: center;
  color: var(--c-text-muted);
  font-size: 14px;
  background: var(--c-bg-panel);
  border: 1px dashed var(--c-border);
  border-radius: 10px;
}
</style>
