<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { listProjects, createProject, deleteProject } from '../services/projectApi'
import { getProjectBinding, putProjectBinding, type ProjectBinding, type ProjectBindingProbe } from '../services/bindingApi'
import { getEventRegistry } from '../services/eventsApi'

type ProjectItem = {
  id: string
  title: string
  updatedAt?: string
  createdAt?: string
}

const projects = ref<ProjectItem[]>([])
const busy = ref(false)
const error = ref('')
const newTitle = ref('')

// 当前绑定项目卡片状态
const binding = ref<ProjectBinding | null>(null)
const bindingProbe = ref<ProjectBindingProbe | null>(null)
const bindingEventCount = ref<number | null>(null)
const bindingEditing = ref(false)
const bindingLabel = ref('')
const bindingBaseUrl = ref('')
const bindingBusy = ref(false)
const bindingError = ref('')

async function loadBinding() {
  bindingError.value = ''
  try {
    const res = await getProjectBinding()
    const payload = await res.json().catch(() => null)
    if (!res.ok || !payload?.ok) throw new Error(payload?.error || `http_${res.status}`)
    binding.value = payload.binding || null
    bindingProbe.value = payload.probe || null
    bindingEventCount.value = null
    // 绑定可达时再拉事件数；不可达保持 null，由卡片呈现「-」
    if (binding.value?.bound && bindingProbe.value?.reachable) {
      const regRes = await getEventRegistry()
      const regPayload = await regRes.json().catch(() => null)
      if (regPayload?.available === true && Array.isArray(regPayload?.registry?.events)) {
        bindingEventCount.value = regPayload.registry.events.length
      }
    }
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
  if (!confirm('确定要解除当前项目绑定吗？')) return
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

async function load() {
  busy.value = true
  error.value = ''
  try {
    const res = await listProjects()
    const payload = await res.json().catch(() => null)
    if (!res.ok || !payload?.ok) throw new Error(payload?.error || `http_${res.status}`)
    projects.value = Array.isArray(payload.projects) ? payload.projects : []
  } catch (e) {
    error.value = String(e)
  } finally {
    busy.value = false
  }
}

async function create() {
  if (!newTitle.value.trim()) return
  busy.value = true
  error.value = ''
  try {
    const res = await createProject(newTitle.value.trim())
    const payload = await res.json().catch(() => null)
    if (!res.ok || !payload?.ok) throw new Error(payload?.error || `http_${res.status}`)
    newTitle.value = ''
    await load()
  } catch (e) {
    error.value = String(e)
  } finally {
    busy.value = false
  }
}

async function remove(id: string) {
  if (!confirm('确定要删除该项目吗？')) return
  busy.value = true
  error.value = ''
  try {
    const res = await deleteProject(id)
    const payload = await res.json().catch(() => null)
    if (!res.ok || !payload?.ok) throw new Error(payload?.error || `http_${res.status}`)
    await load()
  } catch (e) {
    error.value = String(e)
  } finally {
    busy.value = false
  }
}

function openEditor(projectId: string) {
  window.open(`http://localhost:8868/?project=${encodeURIComponent(projectId)}`, '_blank')
}

onMounted(() => {
  loadBinding()
  load()
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
          <span class="binding-events">事件数：{{ bindingEventCount === null ? '-' : bindingEventCount }}</span>
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

    <section class="page-section">
      <div class="section-header">
        <h2>项目库</h2>
        <button class="action-btn" :disabled="busy" @click="load">刷新</button>
      </div>
      <p class="section-hint">管理 storage/projects 中的互动故事项目。点击项目可在 Editor 中打开。</p>

      <div class="create-bar">
        <input
          v-model="newTitle"
          class="create-input"
          placeholder="新项目标题"
          @keydown.enter="create"
        />
        <button class="action-btn primary" :disabled="busy || !newTitle.trim()" @click="create">
          创建项目
        </button>
      </div>

      <div v-if="error" class="error-banner">{{ error }}</div>

      <div class="project-list">
        <div v-if="!projects.length && !busy" class="empty-state">暂无项目</div>
        <div v-for="project in projects" :key="project.id" class="project-card">
          <div class="project-info">
            <div class="project-title">{{ project.title || '未命名项目' }}</div>
            <div class="project-meta">ID: {{ project.id }}</div>
          </div>
          <div class="project-actions">
            <button class="action-btn" @click="openEditor(project.id)">在 Editor 中打开</button>
            <button class="action-btn danger" :disabled="busy" @click="remove(project.id)">删除</button>
          </div>
        </div>
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
</style>
