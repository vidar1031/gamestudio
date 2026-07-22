<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { listProjects, createProject, deleteProject } from '../services/projectApi'

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

onMounted(load)
</script>

<template>
  <div class="page-projects">
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
