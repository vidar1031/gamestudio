<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { useControlConsoleApp } from '../composables/useControlConsoleApp'
import { getOverview, getBootstrap } from '../services/controlApi'

const app = useControlConsoleApp()

const overview = ref<any>(null)
const bootstrap = ref<any>(null)
const overviewBusy = ref(false)
const overviewError = ref('')

async function loadOverview() {
  overviewBusy.value = true
  overviewError.value = ''
  try {
    const [overviewRes, bootstrapRes] = await Promise.allSettled([getOverview(), getBootstrap()])
    if (overviewRes.status === 'fulfilled' && overviewRes.value.ok) {
      overview.value = await overviewRes.value.json().catch(() => null)
    }
    if (bootstrapRes.status === 'fulfilled' && bootstrapRes.value.ok) {
      bootstrap.value = await bootstrapRes.value.json().catch(() => null)
    }
  } catch (e) {
    overviewError.value = String(e)
  } finally {
    overviewBusy.value = false
  }
}

onMounted(() => {
  app.loadVersions()
  loadOverview()
})
</script>

<template>
  <div class="page-dashboard">
    <section class="dashboard-welcome">
      <h2>GameStudio 管理总览</h2>
      <p>在此管理生成工具、本地 Agent、项目、任务与系统配置。</p>
      <div v-if="overviewError" class="error-banner">{{ overviewError }}</div>
    </section>

    <section class="dashboard-grid">
      <div class="dashboard-card" data-tone="info">
        <div class="card-header">
          <span class="card-icon">🧠</span>
          <span class="card-title">Hermes 网关</span>
        </div>
        <div class="card-body">
          <div class="card-status" :data-tone="app.leftBrainRunning.value ? 'success' : 'warn'">
            {{ app.leftBrainRunning.value ? '运行中' : '已停止' }}
          </div>
          <div class="card-detail">{{ app.leftBrainSummary.value || '左脑尚未启动' }}</div>
        </div>
        <div class="card-actions">
          <button
            class="card-btn primary"
            :disabled="app.smartStartBusy.value || app.runtimeBusy.value"
            @click="app.smartStartHermes()"
          >
            {{ app.leftBrainRunning.value ? '重启 Hermes' : '⚡ 一键启动' }}
          </button>
        </div>
      </div>

      <div class="dashboard-card" data-tone="info">
        <div class="card-header">
          <span class="card-icon">⚙️</span>
          <span class="card-title">生成工具</span>
        </div>
        <div class="card-body">
          <div class="card-status" :data-tone="app.effectivePreflightReady.value ? 'success' : 'warn'">
            {{ app.effectivePreflightReady.value ? '配置就绪' : '待配置' }}
          </div>
          <div class="card-detail">
            文本：{{ app.leftBrain.value.provider || '-' }} / {{ app.leftBrain.value.model || '-' }}
          </div>
        </div>
        <div class="card-actions">
          <router-link to="/generators" class="card-btn">管理生成工具</router-link>
        </div>
      </div>

      <div class="dashboard-card" data-tone="info">
        <div class="card-header">
          <span class="card-icon">▣</span>
          <span class="card-title">项目</span>
        </div>
        <div class="card-body">
          <div class="card-status" data-tone="info">项目库</div>
          <div class="card-detail">查看、创建与管理 storage/projects 中的互动故事项目。</div>
        </div>
        <div class="card-actions">
          <router-link to="/projects" class="card-btn">打开项目库</router-link>
        </div>
      </div>

      <div class="dashboard-card" data-tone="info">
        <div class="card-header">
          <span class="card-icon">▶</span>
          <span class="card-title">任务与会话</span>
        </div>
        <div class="card-body">
          <div class="card-status" :data-tone="app.reasoningBusy.value ? 'running' : 'info'">
            {{ app.reasoningBusy.value ? '有任务运行中' : '无运行中任务' }}
          </div>
          <div class="card-detail">管理推理 session、生产测试与任务队列。</div>
        </div>
        <div class="card-actions">
          <router-link to="/sessions" class="card-btn">查看会话</router-link>
        </div>
      </div>
    </section>

    <section v-if="overview?.ok" class="dashboard-section">
      <h3>系统模块状态</h3>
      <div class="module-grid">
        <div v-for="(status, key) in overview.modules" :key="key" class="module-card" :data-status="status">
          <div class="module-name">{{ key }}</div>
          <div class="module-status">{{ status }}</div>
        </div>
      </div>
    </section>

    <section v-if="bootstrap?.ok" class="dashboard-section">
      <h3>后续里程碑</h3>
      <ul class="milestone-list">
        <li v-for="(milestone, index) in bootstrap.nextMilestones" :key="index">{{ milestone }}</li>
      </ul>
    </section>

    <section class="dashboard-section">
      <h3>系统信息</h3>
      <div class="info-grid">
        <div class="info-item">
          <span class="info-label">Control Server</span>
          <span class="info-value">{{ app.managerHealth.value?.service || '-' }} {{ app.managerHealth.value?.version || '' }}</span>
        </div>
        <div class="info-item">
          <span class="info-label">当前 Agent</span>
          <span class="info-value">{{ app.selectedAgentLabel.value || app.selectedAgentId.value || '-' }}</span>
        </div>
        <div class="info-item">
          <span class="info-label">Hermes 版本</span>
          <span class="info-value">{{ app.versions.value?.hermesVersion || '-' }}</span>
        </div>
        <div class="info-item">
          <span class="info-label">OMLX 版本</span>
          <span class="info-value">{{ app.versions.value?.omlxVersion || '-' }}</span>
        </div>
      </div>
    </section>
  </div>
</template>

<style scoped>
.page-dashboard {
  display: flex;
  flex-direction: column;
  gap: 24px;
}

.dashboard-welcome h2 {
  margin: 0 0 6px;
  font-size: 22px;
  color: var(--c-text-inv);
}

.dashboard-welcome p {
  margin: 0 0 10px;
  color: var(--c-text-sub);
}

.error-banner {
  margin-top: 10px;
  padding: 10px 12px;
  border-radius: 8px;
  background: rgba(255, 107, 107, 0.14);
  border: 1px solid rgba(255, 107, 107, 0.28);
  color: var(--c-error);
  font-size: 13px;
}

.dashboard-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
  gap: 16px;
}

.dashboard-card {
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding: 16px;
  border-radius: 12px;
  background: var(--c-bg-panel);
  border: 1px solid var(--c-border);
}

.card-header {
  display: flex;
  align-items: center;
  gap: 10px;
}

.card-icon {
  font-size: 20px;
}

.card-title {
  font-weight: 700;
  color: var(--c-text-inv);
}

.card-body {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.card-status {
  font-size: 13px;
  font-weight: 700;
  color: var(--c-text-sub);
}

.card-status[data-tone='success'] { color: var(--c-success); }
.card-status[data-tone='warn'] { color: var(--c-warn); }
.card-status[data-tone='running'] { color: var(--c-accent); }

.card-detail {
  font-size: 13px;
  color: var(--c-text-sub);
  line-height: 1.45;
}

.card-actions {
  margin-top: auto;
  display: flex;
  gap: 8px;
}

.card-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 8px 14px;
  border-radius: 8px;
  border: 1px solid var(--c-border-mid);
  background: rgba(255, 255, 255, 0.06);
  color: var(--c-text);
  font: inherit;
  font-size: 13px;
  text-decoration: none;
  cursor: pointer;
}

.card-btn:hover {
  background: rgba(255, 255, 255, 0.1);
}

.card-btn.primary {
  background: var(--c-accent);
  color: #081018;
  border-color: transparent;
}

.dashboard-section h3 {
  margin: 0 0 12px;
  font-size: 16px;
  color: var(--c-text-inv);
}

.module-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
  gap: 10px;
}

.module-card {
  padding: 12px;
  border-radius: 8px;
  background: var(--c-bg-card);
  border: 1px solid var(--c-border);
}

.module-name {
  font-size: 12px;
  color: var(--c-text-muted);
  text-transform: uppercase;
  margin-bottom: 6px;
}

.module-status {
  font-size: 14px;
  font-weight: 700;
  color: var(--c-text);
}

.module-card[data-status='bootstrapped'] .module-status { color: var(--c-success); }
.module-card[data-status='pending'] .module-status { color: var(--c-warn); }

.milestone-list {
  margin: 0;
  padding-left: 20px;
  color: var(--c-text-sub);
  font-size: 14px;
  line-height: 1.8;
}

.info-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: 12px;
}

.info-item {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 12px;
  border-radius: 8px;
  background: var(--c-bg-card);
  border: 1px solid var(--c-border);
}

.info-label {
  font-size: 12px;
  color: var(--c-text-muted);
}

.info-value {
  font-size: 14px;
  color: var(--c-text);
}
</style>
