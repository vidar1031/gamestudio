<script setup lang="ts">
import { computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useControlConsoleApp } from '../composables/useControlConsoleApp'

const route = useRoute()
const router = useRouter()
const app = useControlConsoleApp()

const navItems = [
  { name: 'Chat', path: '/chat', icon: '◉', label: '聊天' },
  { name: 'Dashboard', path: '/dashboard', icon: '□', label: '总览' },
  { name: 'Generators', path: '/generators', icon: '⚙', label: '生成工具' },
  { name: 'Agents', path: '/agents', icon: '◆', label: '本地 Agent' },
  { name: 'Projects', path: '/projects', icon: '▣', label: '项目' },
  { name: 'Sessions', path: '/sessions', icon: '▶', label: '任务与会话' },
  { name: 'Logs', path: '/logs', icon: '≡', label: '日志与诊断' },
  { name: 'Settings', path: '/settings', icon: '⚙', label: '设置' },
  { name: 'Workbench', path: '/workbench', icon: '⌘', label: '工作台' },
  { name: 'Studio', path: 'http://localhost:8868/', icon: '✎', label: 'Studio 编辑器', external: true }
]

const currentPath = computed(() => route.path)

const hermesStatus = computed(() => {
  const state = app.leftBrainRunning.value ? 'running' : 'stopped'
  return {
    state,
    label: state === 'running' ? 'Hermes 运行中' : 'Hermes 已停止',
    tone: state === 'running' ? 'success' : 'warn'
  }
})

const controlStatus = computed(() => {
  const ok = app.managerHealth.value?.ok ?? false
  return {
    ok,
    label: ok ? 'Control 在线' : 'Control 离线',
    tone: ok ? 'success' : 'error'
  }
})

const studioStatus = computed(() => {
  const reachable = app.overview.value?.studio?.reachable ?? false
  return {
    reachable,
    label: reachable ? 'Studio 在线' : 'Studio 离线',
    tone: reachable ? 'success' : 'error'
  }
})

const criticalAlerts = computed(() => app.overview.value?.alerts?.filter((a) => a.level === 'critical') || [])
const hasCriticalAlerts = computed(() => criticalAlerts.value.length > 0)

function navigate(item: typeof navItems[number]) {
  if (item.external) {
    window.open(item.path, '_blank')
    return
  }
  router.push(item.path)
}
</script>

<template>
  <div class="console-layout">
    <aside class="console-sidebar">
      <div class="sidebar-brand">
        <span class="brand-icon">🛡</span>
        <span class="brand-text">守护台</span>
      </div>
      <nav class="sidebar-nav">
        <button
          v-for="item in navItems"
          :key="item.path"
          class="sidebar-nav-item"
          :class="{ active: !item.external && currentPath === item.path }"
          @click="navigate(item)"
        >
          <span class="nav-icon">{{ item.icon }}</span>
          <span class="nav-label">{{ item.label }}</span>
        </button>
      </nav>
      <div class="sidebar-footer">
        <div class="status-row">
          <span class="status-dot" :data-tone="controlStatus.tone"></span>
          <span class="status-text">{{ controlStatus.label }}</span>
        </div>
        <div class="status-row">
          <span class="status-dot" :data-tone="hermesStatus.tone"></span>
          <span class="status-text">{{ hermesStatus.label }}</span>
        </div>
        <div class="status-row">
          <span class="status-dot" :data-tone="studioStatus.tone"></span>
          <span class="status-text">{{ studioStatus.label }}</span>
        </div>
      </div>
    </aside>

    <main class="console-main">
      <header class="console-topbar">
        <div class="topbar-left">
          <h1 class="page-title">{{ route.meta.title || '守护台' }}</h1>
        </div>
        <div class="topbar-right">
          <button
            v-if="!app.leftBrainRunning.value"
            class="topbar-action primary"
            :disabled="app.smartStartBusy.value || app.runtimeBusy.value"
            @click="app.smartStartHermes()"
          >
            {{ app.smartStartBusy.value ? '启动中...' : '⚡ 一键启动 Hermes' }}
          </button>
          <button
            v-else
            class="topbar-action danger"
            :disabled="app.runtimeBusy.value"
            @click="app.toggleHermesRuntime('left')"
          >
            停止 Hermes
          </button>
          <span class="agent-badge">{{ app.selectedAgentId.value || '未选择 Agent' }}</span>
        </div>
      </header>

      <div v-if="hasCriticalAlerts" class="global-alert-banner">
        <div class="global-alert-title">⚠ 系统前置条件未满足，已禁止 story 生产测试</div>
        <ul class="global-alert-list">
          <li v-for="(alert, idx) in criticalAlerts" :key="idx">
            <span class="alert-source">[{{ alert.source }}]</span>
            <span class="alert-message">{{ alert.message }}</span>
          </li>
        </ul>
      </div>
      <div class="console-content">
        <router-view />
      </div>
    </main>
  </div>
</template>

<style scoped>
.console-layout {
  display: grid;
  grid-template-columns: 220px 1fr;
  min-height: 100vh;
  background: var(--c-bg-deep);
  color: var(--c-text);
}

.console-sidebar {
  display: flex;
  flex-direction: column;
  gap: 16px;
  padding: 18px 14px;
  background: var(--c-bg-base);
  border-right: 1px solid var(--c-border);
}

.sidebar-brand {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 0 8px 12px;
  border-bottom: 1px solid var(--c-border);
}

.brand-icon {
  font-size: 22px;
}

.brand-text {
  font-size: 17px;
  font-weight: 800;
  color: var(--c-text-inv);
  letter-spacing: 0.02em;
}

.sidebar-nav {
  display: flex;
  flex-direction: column;
  gap: 6px;
  flex: 1;
}

.sidebar-nav-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  border-radius: 8px;
  border: 1px solid transparent;
  background: transparent;
  color: var(--c-text-sub);
  font: inherit;
  font-size: 14px;
  text-align: left;
  cursor: pointer;
  transition: background 0.15s, color 0.15s, border-color 0.15s;
}

.sidebar-nav-item:hover {
  background: rgba(255, 255, 255, 0.06);
  color: var(--c-text);
}

.sidebar-nav-item.active {
  background: var(--c-accent-dim);
  border-color: rgba(94, 204, 255, 0.34);
  color: var(--c-text-inv);
}

.nav-icon {
  width: 20px;
  text-align: center;
  font-size: 15px;
}

.sidebar-footer {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px 8px 0;
  border-top: 1px solid var(--c-border);
  font-size: 12px;
}

.status-row {
  display: flex;
  align-items: center;
  gap: 8px;
}

.status-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--c-text-muted);
}

.status-dot[data-tone='success'] {
  background: var(--c-success);
  box-shadow: 0 0 0 2px rgba(77, 214, 140, 0.25);
}

.status-dot[data-tone='warn'] {
  background: var(--c-warn);
  box-shadow: 0 0 0 2px rgba(246, 201, 78, 0.25);
}

.status-dot[data-tone='error'] {
  background: var(--c-error);
  box-shadow: 0 0 0 2px rgba(255, 107, 107, 0.25);
}

.status-text {
  color: var(--c-text-sub);
}

.console-main {
  display: flex;
  flex-direction: column;
  min-width: 0;
  overflow: hidden;
}

.console-topbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 14px 22px;
  background: var(--c-bg-base);
  border-bottom: 1px solid var(--c-border);
}

.page-title {
  margin: 0;
  font-size: 18px;
  font-weight: 700;
  color: var(--c-text-inv);
}

.topbar-right {
  display: flex;
  align-items: center;
  gap: 12px;
}

.topbar-action {
  padding: 8px 14px;
  border-radius: 8px;
  border: 1px solid transparent;
  font: inherit;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  transition: opacity 0.15s;
}

.topbar-action:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}

.topbar-action.primary {
  background: var(--c-accent);
  color: #081018;
}

.topbar-action.danger {
  background: rgba(255, 107, 107, 0.18);
  border-color: rgba(255, 107, 107, 0.34);
  color: var(--c-error);
}

.agent-badge {
  padding: 5px 10px;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.06);
  border: 1px solid var(--c-border);
  font-size: 12px;
  color: var(--c-text-sub);
}

.console-content {
  flex: 1;
  padding: 20px 22px;
  overflow-y: auto;
  min-height: 0;
}

.global-alert-banner {
  margin: 12px 16px 0;
  padding: 12px 16px;
  border-radius: 8px;
  border: 1px solid rgba(255, 107, 107, 0.45);
  background: rgba(255, 107, 107, 0.12);
  color: #ffd6d6;
}

.global-alert-title {
  font-weight: 700;
  margin-bottom: 8px;
  color: #ff8a80;
}

.global-alert-list {
  margin: 0;
  padding-left: 18px;
  font-size: 13px;
  line-height: 1.6;
}

.global-alert-list li {
  margin-bottom: 4px;
}

.alert-source {
  font-weight: 600;
  color: #ff8a80;
  margin-right: 6px;
}

.alert-message {
  color: #ffd6d6;
}
</style>
