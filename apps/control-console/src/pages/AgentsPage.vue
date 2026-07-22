<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { useControlConsoleApp } from '../composables/useControlConsoleApp'
import { getAgentContract, getAgentStartupProfile, getAgentStartupFlow, getAgentNextAction, getAgentWorkflowDiagnostics } from '../services/controlApi'

const app = useControlConsoleApp()

const agentMeta = ref({
  contract: null as any,
  startupProfile: null as any,
  startupFlow: null as any,
  nextAction: null as any,
  workflowDiagnostics: null as any
})
const metaBusy = ref(false)
const metaError = ref('')

async function loadAgentMeta() {
  const agentId = app.selectedAgentId.value
  if (!agentId) return
  metaBusy.value = true
  metaError.value = ''
  try {
    const [contractRes, profileRes, flowRes, nextRes, diagRes] = await Promise.allSettled([
      getAgentContract(agentId),
      getAgentStartupProfile(agentId),
      getAgentStartupFlow(agentId),
      getAgentNextAction(agentId),
      getAgentWorkflowDiagnostics(agentId)
    ])

    async function parse(p: PromiseSettledResult<Response>) {
      if (p.status !== 'fulfilled' || !p.value.ok) return null
      const data = await p.value.json().catch(() => null)
      return data?.ok ? data : null
    }

    agentMeta.value = {
      contract: await parse(contractRes),
      startupProfile: await parse(profileRes),
      startupFlow: await parse(flowRes),
      nextAction: await parse(nextRes),
      workflowDiagnostics: await parse(diagRes)
    }
  } catch (e) {
    metaError.value = String(e)
  } finally {
    metaBusy.value = false
  }
}

onMounted(() => {
  app.loadHermesSelfCheck()
  loadAgentMeta()
})
</script>

<template>
  <div class="page-agents">
    <section class="page-section">
      <div class="section-header">
        <h2>本地 Agent 控制</h2>
      </div>
      <p class="section-hint">管理 Hermes 左脑/右脑生命周期、查看运行时状态与 Agent 元信息。</p>

      <div class="agent-control-grid">
        <div class="agent-card">
          <div class="agent-card-title">左脑（Hermes 推理）</div>
          <div class="agent-card-status" :data-tone="app.leftBrainRunning.value ? 'success' : 'warn'">
            {{ app.leftBrainRunning.value ? '运行中' : '已停止' }}
          </div>
          <div class="agent-card-detail">Provider: {{ app.leftBrain.value.provider || '-' }}<br>Model: {{ app.leftBrain.value.model || '-' }}</div>
          <div class="agent-card-actions">
            <button
              v-if="!app.leftBrainRunning.value"
              class="action-btn primary"
              :disabled="app.runtimeBusy.value"
              @click="app.executeGlobalRuntimeAction('start')"
            >
              启动
            </button>
            <button
              v-else
              class="action-btn danger"
              :disabled="app.runtimeBusy.value"
              @click="app.executeGlobalRuntimeAction('pause')"
            >
              暂停
            </button>
            <button
              class="action-btn"
              :disabled="app.runtimeBusy.value"
              @click="app.restartGlobalRuntime()"
            >
              整体重启
            </button>
          </div>
        </div>

        <div class="agent-card">
          <div class="agent-card-title">右脑（Kimi 监督）</div>
          <div class="agent-card-status" :data-tone="app.rightBrainEnabled.value ? (app.rightInspection.value?.accessible ? 'success' : 'info') : 'muted'">
            {{ app.rightBrainEnabled.value ? (app.rightInspection.value?.accessible ? '已探测' : '已启用待探测') : '未启用' }}
          </div>
          <div class="agent-card-detail">Provider: {{ app.rightBrain.value.provider || '-' }}<br>Model: {{ app.rightBrain.value.model || '-' }}</div>
          <div class="agent-card-actions">
            <router-link to="/generators" class="action-btn">配置右脑</router-link>
          </div>
        </div>
      </div>
    </section>

    <section class="page-section">
      <div class="section-header">
        <h2>Agent 元信息</h2>
        <button class="action-btn" :disabled="metaBusy" @click="loadAgentMeta">刷新</button>
      </div>
      <div v-if="metaError" class="error-banner">{{ metaError }}</div>

      <div class="meta-grid">
        <div class="meta-card">
          <div class="meta-title">Agent 契约</div>
          <pre v-if="agentMeta.contract" class="meta-pre">{{ JSON.stringify(agentMeta.contract.contract, null, 2) }}</pre>
          <div v-else class="meta-empty">{{ metaBusy ? '加载中...' : '无数据' }}</div>
        </div>
        <div class="meta-card">
          <div class="meta-title">启动画像</div>
          <pre v-if="agentMeta.startupProfile" class="meta-pre">{{ JSON.stringify(agentMeta.startupProfile.startupProfile, null, 2) }}</pre>
          <div v-else class="meta-empty">{{ metaBusy ? '加载中...' : '无数据' }}</div>
        </div>
        <div class="meta-card">
          <div class="meta-title">启动流程</div>
          <pre v-if="agentMeta.startupFlow" class="meta-pre">{{ JSON.stringify(agentMeta.startupFlow.startupFlow, null, 2) }}</pre>
          <div v-else class="meta-empty">{{ metaBusy ? '加载中...' : '无数据' }}</div>
        </div>
        <div class="meta-card">
          <div class="meta-title">推荐下一步</div>
          <pre v-if="agentMeta.nextAction" class="meta-pre">{{ JSON.stringify(agentMeta.nextAction.nextAction, null, 2) }}</pre>
          <div v-else class="meta-empty">{{ metaBusy ? '加载中...' : '无数据' }}</div>
        </div>
        <div class="meta-card wide">
          <div class="meta-title">工作流诊断</div>
          <pre v-if="agentMeta.workflowDiagnostics" class="meta-pre">{{ JSON.stringify(agentMeta.workflowDiagnostics.diagnostics, null, 2) }}</pre>
          <div v-else class="meta-empty">{{ metaBusy ? '加载中...' : '无数据' }}</div>
        </div>
      </div>
    </section>
  </div>
</template>

<style scoped>
.page-agents {
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

.agent-control-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
  gap: 16px;
}

.agent-card {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 16px;
  border-radius: 12px;
  background: var(--c-bg-panel);
  border: 1px solid var(--c-border);
}

.agent-card-title {
  font-weight: 700;
  color: var(--c-text-inv);
}

.agent-card-status {
  font-size: 13px;
  font-weight: 700;
}

.agent-card-status[data-tone='success'] { color: var(--c-success); }
.agent-card-status[data-tone='warn'] { color: var(--c-warn); }
.agent-card-status[data-tone='info'] { color: var(--c-accent); }
.agent-card-status[data-tone='muted'] { color: var(--c-text-muted); }

.agent-card-detail {
  font-size: 13px;
  color: var(--c-text-sub);
  line-height: 1.5;
}

.agent-card-actions {
  margin-top: auto;
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}

.action-btn {
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

.meta-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));
  gap: 16px;
}

.meta-card {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 14px;
  border-radius: 10px;
  background: var(--c-bg-panel);
  border: 1px solid var(--c-border);
}

.meta-card.wide {
  grid-column: 1 / -1;
}

.meta-title {
  font-weight: 700;
  color: var(--c-text-inv);
  font-size: 14px;
}

.meta-pre {
  margin: 0;
  padding: 10px;
  border-radius: 6px;
  background: #0b0f14;
  border: 1px solid var(--c-border);
  color: var(--c-text-sub);
  font-size: 12px;
  line-height: 1.5;
  max-height: 240px;
  overflow: auto;
  white-space: pre-wrap;
  word-break: break-word;
}

.meta-empty {
  padding: 20px;
  text-align: center;
  color: var(--c-text-muted);
  font-size: 13px;
}
</style>
