<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { useControlConsoleApp } from '../composables/useControlConsoleApp'
import { listReasoningSessions, cancelReasoningSessionRequest, clearReasoningSessionRecord, recoverReasoningSession } from '../services/reasoningApi'

type SessionSummary = {
  sessionId: string
  status: string
  userPrompt: string
  title: string
  createdAt: string
  updatedAt: string
  currentStepId: string | null
  stepCount: number
  currentStepIndex: number | null
}

const app = useControlConsoleApp()
const sessions = ref<SessionSummary[]>([])
const busy = ref(false)
const error = ref('')
const showTerminal = ref(true)

async function loadSessions() {
  const agentId = app.selectedAgentId.value || 'hermes-manager'
  busy.value = true
  error.value = ''
  try {
    const res = await listReasoningSessions(agentId, { limit: 50, includeTerminal: showTerminal.value })
    const payload = await res.json().catch(() => null)
    if (!res.ok || !payload?.ok) throw new Error(payload?.error || `http_${res.status}`)
    sessions.value = Array.isArray(payload.sessions) ? payload.sessions : []
  } catch (e) {
    error.value = String(e)
  } finally {
    busy.value = false
  }
}

async function cancel(sessionId: string) {
  const agentId = app.selectedAgentId.value || 'hermes-manager'
  busy.value = true
  try {
    await cancelReasoningSessionRequest(agentId, sessionId)
    await loadSessions()
  } catch (e) {
    error.value = String(e)
  } finally {
    busy.value = false
  }
}

async function clear(sessionId: string) {
  const agentId = app.selectedAgentId.value || 'hermes-manager'
  busy.value = true
  try {
    await clearReasoningSessionRecord(agentId, sessionId)
    await loadSessions()
  } catch (e) {
    error.value = String(e)
  } finally {
    busy.value = false
  }
}

async function recover(sessionId: string) {
  const agentId = app.selectedAgentId.value || 'hermes-manager'
  busy.value = true
  try {
    await recoverReasoningSession(agentId, sessionId)
    await loadSessions()
  } catch (e) {
    error.value = String(e)
  } finally {
    busy.value = false
  }
}

function formatTime(iso: string) {
  if (!iso) return '-'
  const d = new Date(iso)
  return isNaN(d.getTime()) ? iso : `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

function isRunning(status: string) {
  return status !== 'completed' && status !== 'failed' && status !== 'cancelled'
}

onMounted(loadSessions)
</script>

<template>
  <div class="page-sessions">
    <section class="page-section">
      <div class="section-header">
        <h2>任务与会话</h2>
        <div class="header-actions">
          <label class="checkbox-label">
            <input v-model="showTerminal" type="checkbox" @change="loadSessions" />
            显示已结束
          </label>
          <button class="action-btn" :disabled="busy" @click="loadSessions">刷新</button>
        </div>
      </div>
      <p class="section-hint">管理推理 session、生产测试、取消/清理/恢复异常任务。</p>

      <div v-if="error" class="error-banner">{{ error }}</div>

      <div class="session-state-grid">
        <div class="state-card">
          <div class="state-label">当前任务</div>
          <div class="state-value" :data-tone="app.reasoningBusy.value ? 'running' : 'info'">
            {{ app.reasoningBusy.value ? '运行中' : '空闲' }}
          </div>
        </div>
        <div class="state-card">
          <div class="state-label">自动审批</div>
          <div class="state-value">{{ app.reasoningAutoApproveEnabled.value ? '已开启' : '已关闭' }}</div>
        </div>
        <div class="state-card">
          <div class="state-label">待审核</div>
          <div class="state-value" :data-tone="app.reasoningPendingReview.value ? 'warn' : 'info'">
            {{ app.reasoningPendingReview.value ? '有' : '无' }}
          </div>
        </div>
      </div>

      <div class="action-bar">
        <button
          class="action-btn"
          :disabled="!app.reasoningBusy.value || app.reasoningStopBusy.value"
          @click="app.cancelReasoningSession"
        >
          取消当前任务
        </button>
        <button
          class="action-btn"
          @click="app.clearReasoningSession"
        >
          清理当前会话
        </button>
      </div>

      <div class="session-table-wrap">
        <table class="session-table">
          <thead>
            <tr>
              <th>状态</th>
              <th>标题 / Prompt</th>
              <th>进度</th>
              <th>更新时间</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-if="!sessions.length && !busy">
              <td colspan="5" class="empty-cell">暂无会话</td>
            </tr>
            <tr v-for="session in sessions" :key="session.sessionId">
              <td>
                <span class="status-badge" :data-status="session.status">{{ session.status }}</span>
              </td>
              <td>
                <div class="session-title">{{ session.title || session.userPrompt || '无标题' }}</div>
                <div class="session-id">{{ session.sessionId }}</div>
              </td>
              <td>
                <div class="progress-text">
                  {{ session.currentStepIndex != null ? session.currentStepIndex + 1 : '-' }} / {{ session.stepCount }}
                </div>
              </td>
              <td class="time-cell">{{ formatTime(session.updatedAt) }}</td>
              <td>
                <div class="row-actions">
                  <button v-if="isRunning(session.status)" class="action-btn small" :disabled="busy" @click="cancel(session.sessionId)">取消</button>
                  <button v-if="session.status === 'failed'" class="action-btn small" :disabled="busy" @click="recover(session.sessionId)">恢复</button>
                  <button class="action-btn small danger" :disabled="busy" @click="clear(session.sessionId)">清理</button>
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>
  </div>
</template>

<style scoped>
.page-sessions {
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

.header-actions {
  display: flex;
  align-items: center;
  gap: 12px;
}

.section-hint {
  margin: 0 0 14px;
  color: var(--c-text-sub);
  font-size: 13px;
}

.checkbox-label {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  color: var(--c-text-sub);
  cursor: pointer;
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

.session-state-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
  gap: 12px;
  margin-bottom: 16px;
}

.state-card {
  padding: 14px;
  border-radius: 10px;
  background: var(--c-bg-panel);
  border: 1px solid var(--c-border);
}

.state-label {
  font-size: 12px;
  color: var(--c-text-muted);
  margin-bottom: 6px;
}

.state-value {
  font-size: 16px;
  font-weight: 700;
  color: var(--c-text);
}

.state-value[data-tone='running'] { color: var(--c-accent); }
.state-value[data-tone='warn'] { color: var(--c-warn); }

.action-bar {
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
  margin-bottom: 16px;
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

.action-btn.small {
  padding: 5px 10px;
  font-size: 12px;
}

.action-btn.danger {
  background: rgba(255, 107, 107, 0.18);
  border-color: rgba(255, 107, 107, 0.34);
  color: var(--c-error);
}

.session-table-wrap {
  overflow-x: auto;
  border-radius: 10px;
  border: 1px solid var(--c-border);
  background: var(--c-bg-panel);
}

.session-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
}

.session-table th,
.session-table td {
  padding: 10px 12px;
  text-align: left;
  border-bottom: 1px solid var(--c-border);
  vertical-align: top;
}

.session-table th {
  color: var(--c-text-sub);
  font-weight: 700;
  background: rgba(255, 255, 255, 0.03);
}

.empty-cell {
  text-align: center;
  color: var(--c-text-muted);
  padding: 28px;
}

.status-badge {
  display: inline-block;
  padding: 3px 8px;
  border-radius: 999px;
  font-size: 11px;
  font-weight: 700;
  text-transform: uppercase;
  background: rgba(255, 255, 255, 0.08);
  color: var(--c-text-sub);
}

.status-badge[data-status='running'] { background: rgba(94, 204, 255, 0.16); color: var(--c-accent); }
.status-badge[data-status='completed'] { background: rgba(77, 214, 140, 0.16); color: var(--c-success); }
.status-badge[data-status='failed'] { background: rgba(255, 107, 107, 0.16); color: var(--c-error); }
.status-badge[data-status='cancelled'] { background: rgba(246, 201, 78, 0.16); color: var(--c-warn); }

.session-title {
  color: var(--c-text);
  max-width: 320px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.session-id {
  margin-top: 3px;
  font-size: 11px;
  color: var(--c-text-muted);
  font-family: SFMono-Regular, Menlo, Monaco, Consolas, monospace;
}

.time-cell {
  color: var(--c-text-sub);
  white-space: nowrap;
}

.progress-text {
  color: var(--c-text-sub);
}

.row-actions {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}
</style>
