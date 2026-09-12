<script setup lang="ts">
import { ref, onMounted, computed } from 'vue'
import {
  getProjectBinding,
  putProjectBinding,
  type ProjectBinding,
  type ProjectBindingProbe,
  type ProjectCapability,
  type ProjectRuntimeDescriptor
} from '../services/bindingApi'
import { confirmDialog } from '../lib/uiDialog'

// 当前绑定项目卡片状态
const binding = ref<ProjectBinding | null>(null)
const bindingProbe = ref<ProjectBindingProbe | null>(null)
const capabilities = ref<ProjectCapability[]>([])
const runtimeDescriptor = ref<ProjectRuntimeDescriptor | null>(null)
const capabilityError = ref<string | null>(null)
const bindingEditing = ref(false)
const bindingLabel = ref('')
const bindingBaseUrl = ref('')
const bindingBusy = ref(false)
const bindingError = ref('')

// 能力管理状态
const discoveredCapabilities = ref<any[]>([])
const discoveryBusy = ref(false)
const discoveryError = ref('')
const capabilityBusyId = ref('')

const capabilityStats = computed(() => {
  const total = capabilities.value.length
  const readCount = capabilities.value.filter((item) => item.type === 'read').length
  const writeCount = capabilities.value.filter((item) => item.type === 'write').length
  const reviewCount = capabilities.value.filter((item) => item.requiresReview).length
  return { total, readCount, writeCount, reviewCount }
})

async function loadBinding() {
  bindingError.value = ''
  try {
    const res = await getProjectBinding()
    const payload = await res.json().catch(() => null)
    if (!res.ok || !payload?.ok) throw new Error(payload?.error || `http_${res.status}`)
    binding.value = payload.binding || null
    bindingProbe.value = payload.probe || null
    capabilities.value = Array.isArray(payload.capabilities) ? payload.capabilities : []
    runtimeDescriptor.value = payload.runtimeDescriptor || null
    capabilityError.value = payload.capabilityError || null
  } catch (e) {
    bindingError.value = e instanceof Error ? e.message : String(e)
  }
}

function startEditBinding() {
  bindingLabel.value = binding.value?.label || ''
  bindingBaseUrl.value = binding.value?.baseUrl || 'http://127.0.0.1:1999'
  bindingEditing.value = true
  bindingError.value = ''
}

async function saveBinding() {
  if (bindingBusy.value) return
  bindingBusy.value = true
  bindingError.value = ''
  try {
    const res = await putProjectBinding({ label: bindingLabel.value.trim(), baseUrl: bindingBaseUrl.value.trim() })
    const payload = await res.json().catch(() => null)
    if (!res.ok || !payload?.ok) throw new Error(payload?.error || `http_${res.status}`)
    bindingEditing.value = false
    await loadBinding()
  } catch (e) {
    bindingError.value = e instanceof Error ? e.message : String(e)
  } finally {
    bindingBusy.value = false
  }
}

async function unbind() {
  if (bindingBusy.value) return
  if (!(await confirmDialog({ title: '解除项目绑定', message: '确定要解除当前项目绑定吗？', confirmText: '解除绑定', danger: true }))) return
  bindingBusy.value = true
  bindingError.value = ''
  try {
    const res = await putProjectBinding({ bound: false })
    const payload = await res.json().catch(() => null)
    if (!res.ok || !payload?.ok) throw new Error(payload?.error || `http_${res.status}`)
    bindingEditing.value = false
    await loadBinding()
  } catch (e) {
    bindingError.value = e instanceof Error ? e.message : String(e)
  } finally {
    bindingBusy.value = false
  }
}

async function discoverCapabilities() {
  if (discoveryBusy.value) return
  discoveryBusy.value = true
  discoveryError.value = ''
  try {
    const res = await fetch('/api/control/capabilities/discover')
    const payload = await res.json().catch(() => null)
    if (!res.ok || !payload?.ok) throw new Error(payload?.error || `http_${res.status}`)
    discoveredCapabilities.value = Array.isArray(payload.capabilities) ? payload.capabilities : []
  } catch (e) {
    discoveryError.value = e instanceof Error ? e.message : String(e)
  } finally {
    discoveryBusy.value = false
  }
}

async function registerCapability(cap: any) {
  if (capabilityBusyId.value) return
  capabilityBusyId.value = cap.id
  try {
    const res = await fetch('/api/control/capabilities/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ capability: cap, actor: 'console' })
    })
    const payload = await res.json().catch(() => null)
    if (!res.ok || !payload?.ok) throw new Error(payload?.error || `http_${res.status}`)
    await loadBinding()
    await discoverCapabilities()
  } catch (e) {
    discoveryError.value = e instanceof Error ? e.message : String(e)
  } finally {
    capabilityBusyId.value = ''
  }
}

async function disableCapability(capabilityId: string) {
  if (capabilityBusyId.value) return
  capabilityBusyId.value = capabilityId
  try {
    const res = await fetch(`/api/control/capabilities/${encodeURIComponent(capabilityId)}/disable`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ actor: 'console' })
    })
    const payload = await res.json().catch(() => null)
    if (!res.ok || !payload?.ok) throw new Error(payload?.error || `http_${res.status}`)
    await loadBinding()
  } catch (e) {
    discoveryError.value = e instanceof Error ? e.message : String(e)
  } finally {
    capabilityBusyId.value = ''
  }
}

onMounted(() => {
  loadBinding()
  discoverCapabilities()
})
</script>

<template>
  <div class="page-projects">
    <section class="page-section">
      <div class="section-header">
        <h2>当前绑定项目</h2>
        <button v-if="!bindingEditing" class="action-btn" @click="startEditBinding">
          {{ binding?.bound ? '修改绑定' : '去绑定' }}
        </button>
      </div>
      <p class="section-hint">守护台的事件地图与生产链路都面向绑定的 GameStudio 服务。</p>

      <div v-if="bindingError" class="error-banner">{{ bindingError }}</div>

      <div v-if="bindingEditing" class="binding-edit">
        <input v-model="bindingLabel" class="create-input" placeholder="项目名称（如：GameStudio 交互故事）" />
        <input v-model="bindingBaseUrl" class="create-input" placeholder="服务地址（仅支持本机地址）" />
        <div class="binding-edit-actions">
          <button class="action-btn primary" :disabled="bindingBusy || !bindingBaseUrl.trim()" @click="saveBinding">
            {{ bindingBusy ? '保存中…' : '保存绑定' }}
          </button>
          <button class="action-btn" :disabled="bindingBusy" @click="bindingEditing = false">取消</button>
          <button v-if="binding?.bound" class="action-btn danger" :disabled="bindingBusy" @click="unbind">解除绑定</button>
        </div>
      </div>

      <div v-else-if="binding?.bound" class="binding-card">
        <div class="project-info">
          <div class="project-title">
            {{ binding.label || '已绑定项目' }}
            <span class="reach-badge" :data-tone="bindingProbe?.reachable ? 'success' : 'error'">
              {{ bindingProbe?.reachable ? '在线' : '不可达' }}
            </span>
          </div>
          <div class="project-meta">{{ binding.baseUrl }}</div>
        </div>
        <div class="binding-side">
          <span class="binding-events">能力数：{{ capabilityStats.total }}</span>
          <router-link class="action-btn link" to="/events">查看项目事件</router-link>
        </div>
      </div>
      <div v-if="binding?.bound && bindingProbe && !bindingProbe.reachable" class="warn-banner">
        绑定的项目暂时不可达（{{ bindingProbe.detail || '连接失败' }}）。请确认 GameStudio 服务已启动，或修改绑定地址。
      </div>

      <div v-else-if="binding && !binding.bound" class="empty-state">
        尚未绑定项目。点击右上角「去绑定」选择要对接的 GameStudio 服务。
      </div>
    </section>

    <section v-if="binding?.bound" class="page-section">
      <div class="section-header">
        <h2>项目能力</h2>
        <router-link class="action-btn link" to="/events">查看事件地图</router-link>
      </div>
      <p class="section-hint">以下能力来自绑定项目的事件注册表，是智能体可发现、可计划、可受控执行的动作清单。</p>

      <div v-if="capabilityError" class="error-banner">{{ capabilityError }}</div>

      <div class="capability-stats">
        <span class="stat-chip">共 {{ capabilityStats.total }} 项</span>
        <span class="stat-chip">只读 {{ capabilityStats.readCount }}</span>
        <span class="stat-chip">写入 {{ capabilityStats.writeCount }}</span>
        <span class="stat-chip warn">需审核 {{ capabilityStats.reviewCount }}</span>
      </div>

      <div v-if="capabilities.length" class="capability-list">
        <div v-for="cap in capabilities" :key="cap.id" class="capability-card">
          <div class="capability-header">
            <span class="capability-label">{{ cap.label }}</span>
            <span class="capability-type" :data-type="cap.type">{{ cap.type === 'read' ? '只读' : '写入' }}</span>
            <span v-if="cap.requiresReview" class="capability-review">需审核</span>
          </div>
          <div class="capability-id">{{ cap.id }}</div>
          <div v-if="cap.description" class="capability-desc">{{ cap.description }}</div>
          <div class="capability-actions">
            <button class="action-btn small danger" :disabled="capabilityBusyId === cap.id" @click="disableCapability(cap.id)">
              禁用
            </button>
          </div>
        </div>
      </div>
      <div v-else class="empty-state">未从事件注册表中解析到能力。</div>
    </section>

    <section v-if="binding?.bound" class="page-section">
      <div class="section-header">
        <h2>能力管理</h2>
        <button class="action-btn" :disabled="discoveryBusy" @click="discoverCapabilities">
          {{ discoveryBusy ? '探测中…' : '重新探测' }}
        </button>
      </div>
      <p class="section-hint">探测绑定项目的新能力，验证后注册为正式能力。只有验证通过的能力才能注册。</p>

      <div v-if="discoveryError" class="error-banner">{{ discoveryError }}</div>

      <div v-if="discoveredCapabilities.length" class="capability-list">
        <div v-for="cap in discoveredCapabilities" :key="cap.id" class="capability-card">
          <div class="capability-header">
            <span class="capability-label">{{ cap.label }}</span>
            <span class="capability-type" :data-type="cap.type">{{ cap.type === 'read' ? '只读' : '写入' }}</span>
            <span v-if="cap.requiresReview" class="capability-review">需审核</span>
            <span class="capability-verify" :data-ok="cap.verified">{{ cap.verified ? '已验证' : '未验证' }}</span>
          </div>
          <div class="capability-id">{{ cap.id }}</div>
          <div v-if="cap.description" class="capability-desc">{{ cap.description }}</div>
          <div class="capability-actions">
            <button
              class="action-btn small primary"
              :disabled="capabilityBusyId === cap.id || !cap.verified"
              @click="registerCapability(cap)"
            >
              注册
            </button>
          </div>
        </div>
      </div>
      <div v-else class="empty-state">未发现新能力。点击"重新探测"扫描绑定项目。</div>
    </section>

    <section class="page-section">
      <div class="section-header">
        <h2>交互方式说明</h2>
      </div>
      <p class="section-hint">守护台智能体不直接管理绑定项目的内部内容。它通过互动聊天与「项目事件」映射触发动作；绑定项目自行运行生产。故事项目的创建与管理在 Studio 编辑器中进行。</p>
      <div class="binding-links">
        <router-link class="action-btn" to="/events">查看项目事件</router-link>
        <a class="action-btn" href="http://localhost:8868/" target="_blank" rel="noopener">打开 Studio 编辑器</a>
      </div>
    </section>
  </div>
</template>

<style scoped>
.page-projects {
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

.create-bar {
  display: flex;
  gap: 10px;
  margin-bottom: 16px;
}

.create-input {
  flex: 1;
  min-width: 200px;
  padding: 9px 12px;
  border-radius: 8px;
  border: 1px solid var(--c-border-mid);
  background: var(--c-bg-input);
  color: var(--c-text);
  font: inherit;
  font-size: 14px;
}

.create-input:focus {
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

.action-btn.danger {
  background: rgba(255, 107, 107, 0.18);
  border-color: rgba(255, 107, 107, 0.34);
  color: var(--c-error);
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

.warn-banner {
  margin-top: 10px;
  padding: 10px 12px;
  border-radius: 8px;
  background: rgba(246, 201, 78, 0.12);
  border: 1px solid rgba(246, 201, 78, 0.3);
  color: var(--c-warn);
  font-size: 13px;
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

.binding-side {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-shrink: 0;
}

.binding-events {
  font-size: 12px;
  color: var(--c-text-sub);
}

.binding-edit {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 14px 16px;
  border-radius: 10px;
  background: var(--c-bg-panel);
  border: 1px solid var(--c-border);
}

.binding-edit-actions {
  display: flex;
  gap: 10px;
}

.reach-badge {
  margin-left: 8px;
  padding: 2px 8px;
  border-radius: 999px;
  font-size: 12px;
  font-weight: 400;
}

.reach-badge[data-tone='success'] {
  background: rgba(77, 214, 140, 0.15);
  color: var(--c-success);
}

.reach-badge[data-tone='error'] {
  background: rgba(255, 107, 107, 0.15);
  color: var(--c-error);
}

.action-btn.link {
  text-decoration: none;
  display: inline-block;
}

.project-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
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

.project-card {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 14px;
  padding: 14px 16px;
  border-radius: 10px;
  background: var(--c-bg-panel);
  border: 1px solid var(--c-border);
}

.project-title {
  font-weight: 600;
  color: var(--c-text-inv);
}

.project-meta {
  margin-top: 4px;
  font-size: 12px;
  color: var(--c-text-muted);
  font-family: SFMono-Regular, Menlo, Monaco, Consolas, monospace;
}

.project-actions {
  display: flex;
  gap: 8px;
}

.capability-stats {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  margin-bottom: 14px;
}

.stat-chip {
  padding: 4px 10px;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.06);
  border: 1px solid var(--c-border);
  color: var(--c-text-sub);
  font-size: 12px;
}

.stat-chip.warn {
  background: rgba(246, 201, 78, 0.12);
  border-color: rgba(246, 201, 78, 0.3);
  color: var(--c-warn);
}

.capability-list {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: 10px;
}

.capability-card {
  padding: 12px 14px;
  border-radius: 10px;
  background: var(--c-bg-panel);
  border: 1px solid var(--c-border);
}

.capability-header {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.capability-label {
  font-weight: 600;
  color: var(--c-text-inv);
  font-size: 13px;
}

.capability-type {
  padding: 2px 8px;
  border-radius: 999px;
  font-size: 11px;
  background: rgba(94, 204, 255, 0.12);
  color: var(--c-accent);
}

.capability-type[data-type='write'] {
  background: rgba(255, 183, 77, 0.14);
  color: var(--c-warn);
}

.capability-review {
  padding: 2px 8px;
  border-radius: 999px;
  font-size: 11px;
  background: rgba(255, 107, 107, 0.14);
  color: var(--c-error);
}

.capability-id {
  margin-top: 6px;
  font-size: 12px;
  color: var(--c-text-muted);
  font-family: SFMono-Regular, Menlo, Monaco, Consolas, monospace;
}

.capability-desc {
  margin-top: 6px;
  font-size: 12px;
  color: var(--c-text-sub);
  line-height: 1.5;
}

.capability-verify {
  padding: 2px 8px;
  border-radius: 999px;
  font-size: 11px;
  background: rgba(255, 183, 77, 0.14);
  color: var(--c-warn);
}

.capability-verify[data-ok='true'] {
  background: rgba(77, 214, 140, 0.15);
  color: var(--c-success);
}

.capability-actions {
  margin-top: 8px;
  display: flex;
  gap: 8px;
}

.action-btn.small {
  padding: 4px 10px;
  font-size: 12px;
}
</style>
