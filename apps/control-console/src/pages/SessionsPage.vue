<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useControlConsoleApp } from '../composables/useControlConsoleApp'
import {
  listReasoningSessions,
  cancelReasoningSessionRequest,
  clearReasoningSessionRecord,
  recoverReasoningSession,
  listReasoningQueueItems,
  getReasoningQueueItemDetail,
  retryReasoningSession
} from '../services/reasoningApi'

type SessionSummary = {
  sessionId: string
  status: string
  verdict?: 'PASS' | 'FAIL' | 'BLOCKED' | 'CANCELLED'
  userPrompt: string
  title: string
  createdAt: string
  updatedAt: string
  currentStepId: string | null
  stepCount: number
  currentStepIndex: number | null
}

type QueueSessionSummary = {
  status: string
  title: string
  error: string | null
  currentStepId: string | null
  currentStepIndex: number | null
  stepCount: number
  review: { title: string | null; targetType: string | null; reviewPhase: string | null } | null
}

type QueueItemView = {
  sessionId: string
  taskId: string
  projectId: string | null
  status: string
  retryCount: number
  nextAttemptAt: string | null
  lastError: string | null
  attempts: number
  recoveryCount: number
  createdAt: string | null
  updatedAt: string | null
  startedAt: string | null
  finishedAt: string | null
  session: QueueSessionSummary | null
}

type QueueItemDetail = {
  item: QueueItemView & {
    retryHistory?: Array<{ attempt: number; scheduledAt: string; nextAttemptAt: string; rule?: string; reason?: string; error?: string }>
    history?: Array<{ from: string | null; to: string; reason: string; at: string }>
  }
  session: (QueueSessionSummary & { sessionId: string; currentStep: { stepId: string | null; title: string | null; action: string | null } | null; projectId: string | null }) | null
  evidence: {
    checkpoints: Array<{ file: string; stepIndex: number }>
    latestCheckpoint: { stepIndex: number; nextStepIndex: number; completedAt: string | null } | null
    retryPolicy: Record<string, unknown> | null
    artifacts: { projectRoot: string | null; storyIndex: number | null; finalAnswerPreview: string | null } | null
    recentEvents: Array<{ type: string | null; title: string | null; summary: string | null; timestamp: string | null; stepId: string | null }>
  }
}

const app = useControlConsoleApp()
const sessions = ref<SessionSummary[]>([])
const queueItems = ref<QueueItemView[]>([])
const busy = ref(false)
const error = ref('')
const actionMessage = ref('')
const showTerminal = ref(true)
const queueFilter = ref('active')
const expandedQueueId = ref('')
const queueDetails = ref<Record<string, QueueItemDetail>>({})

// AUTO-D01：队列展示态——item queued 且带重试窗口 = 重试等待（镜像 session retry_wait 语义）
function queueDisplayStatus(entry: QueueItemView) {
  if (entry.status === 'queued' && entry.nextAttemptAt) return 'retry_wait'
  return entry.status
}

const QUEUE_STATUS_LABELS: Record<string, string> = {
  queued: '排队中',
  claimed: '已领取',
  running: '运行中',
  retry_wait: '重试等待',
  waiting_review: '等待审核',
  completed: '已完成',
  failed: '已失败',
  cancelled: '已取消',
  timeout: '已超时',
  blocked: '已阻断'
}

const TERMINAL_QUEUE_STATES = ['completed', 'failed', 'cancelled', 'timeout', 'blocked']

const filteredQueueItems = computed(() => {
  if (queueFilter.value === 'all') return queueItems.value
  if (queueFilter.value === 'active') {
    return queueItems.value.filter((entry) => !TERMINAL_QUEUE_STATES.includes(entry.status))
  }
  return queueItems.value.filter((entry) => queueDisplayStatus(entry) === queueFilter.value)
})

async function loadQueueItems() {
  const res = await listReasoningQueueItems()
  const payload = await res.json().catch(() => null)
  if (!res.ok || !payload?.ok) throw new Error(payload?.error || `http_${res.status}`)
  queueItems.value = Array.isArray(payload.items) ? payload.items : []
  // 刷新后详情与服务端一致：已展开的详情一并重新拉取
  if (expandedQueueId.value) {
    await loadQueueDetail(expandedQueueId.value)
  }
}

async function loadQueueDetail(sessionId: string) {
  const res = await getReasoningQueueItemDetail(sessionId)
  const payload = await res.json().catch(() => null)
  if (!res.ok || !payload?.ok) throw new Error(payload?.error || `http_${res.status}`)
  queueDetails.value = { ...queueDetails.value, [sessionId]: payload as QueueItemDetail }
}

async function loadSessions() {
  const agentId = app.selectedAgentId.value || 'hermes-manager'
  const res = await listReasoningSessions(agentId, { limit: 50, includeTerminal: showTerminal.value })
  const payload = await res.json().catch(() => null)
  if (!res.ok || !payload?.ok) throw new Error(payload?.error || `http_${res.status}`)
  sessions.value = Array.isArray(payload.sessions) ? payload.sessions : []
}

// 刷新 = 重新拉取服务端状态，不做本地缓存臆测
async function loadAll() {
  busy.value = true
  error.value = ''
  try {
    await Promise.all([loadQueueItems(), loadSessions()])
  } catch (e) {
    error.value = String(e)
  } finally {
    busy.value = false
  }
}

// 操作反馈：成功显示结果，失败/阻断直接展示 API 返回的 error/detail
async function runQueueAction(action: () => Promise<Response>, successText: string) {
  busy.value = true
  error.value = ''
  actionMessage.value = ''
  try {
    const res = await action()
    const payload = await res.json().catch(() => null)
    if (!res.ok || !payload?.ok) {
      throw new Error(payload?.detail || payload?.error || `http_${res.status}`)
    }
    actionMessage.value = successText
    await loadAll()
  } catch (e) {
    error.value = String(e)
    await loadAll()
  } finally {
    busy.value = false
  }
}

async function cancel(sessionId: string) {
  const agentId = app.selectedAgentId.value || 'hermes-manager'
  await runQueueAction(() => cancelReasoningSessionRequest(agentId, sessionId), '任务已取消。')
}

async function clear(sessionId: string) {
  const agentId = app.selectedAgentId.value || 'hermes-manager'
  await runQueueAction(() => clearReasoningSessionRecord(agentId, sessionId), '会话记录已清理。')
}

async function recover(sessionId: string) {
  const agentId = app.selectedAgentId.value || 'hermes-manager'
  await runQueueAction(() => recoverReasoningSession(agentId, sessionId), '任务已从断点恢复执行。')
}

async function retry(sessionId: string) {
  const agentId = app.selectedAgentId.value || 'hermes-manager'
  await runQueueAction(() => retryReasoningSession(agentId, sessionId), '任务已重新排队，将自动领取执行。')
}

async function toggleQueueDetail(sessionId: string) {
  if (expandedQueueId.value === sessionId) {
    expandedQueueId.value = ''
    return
  }
  expandedQueueId.value = sessionId
  if (!queueDetails.value[sessionId]) {
    try {
      await loadQueueDetail(sessionId)
    } catch (e) {
      error.value = String(e)
    }
  }
}

function formatTime(iso: string | null) {
  if (!iso) return '-'
  const d = new Date(iso)
  return isNaN(d.getTime()) ? iso : `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

function isRunning(status: string) {
  // AUTO-B04：终态（completed/blocked/cancelled/timeout）与 failed 不提供取消入口；
  // orphaned 等非终态仍可取消（orphaned -> cancelled 为合法转移）
  return !['completed', 'failed', 'cancelled', 'timeout', 'blocked'].includes(status)
}

function queueReason(entry: QueueItemView) {
  return entry.session?.error || entry.lastError || '-'
}

onMounted(loadAll)
</script>

<template>
  <div class="page-sessions">
    <section class="page-section">
      <div class="section-header">
        <h2>任务队列</h2>
        <div class="header-actions">
          <select v-model="queueFilter" class="filter-select">
            <option value="active">进行中</option>
            <option value="all">全部</option>
            <option value="queued">排队中</option>
            <option value="running">运行中</option>
            <option value="retry_wait">重试等待</option>
            <option value="waiting_review">等待审核</option>
            <option value="blocked">已阻断</option>
          </select>
          <button class="action-btn" :disabled="busy" @click="loadAll">刷新</button>
        </div>
      </div>
      <p class="section-hint">查看队列任务的当前步骤、重试计划与失败原因；可取消、恢复或重试任务。点击行查看详情与证据。</p>

      <div v-if="error" class="error-banner">{{ error }}</div>
      <div v-if="actionMessage" class="success-banner">{{ actionMessage }}</div>

      <div class="session-table-wrap">
        <table class="session-table">
          <thead>
            <tr>
              <th>状态</th>
              <th>任务</th>
              <th>项目</th>
              <th>当前步骤</th>
              <th>重试</th>
              <th>原因</th>
              <th>更新时间</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-if="!filteredQueueItems.length && !busy">
              <td colspan="8" class="empty-cell">暂无队列任务</td>
            </tr>
            <template v-for="entry in filteredQueueItems" :key="entry.sessionId">
              <tr class="queue-row" @click="toggleQueueDetail(entry.sessionId)">
                <td>
                  <span class="status-badge" :data-status="queueDisplayStatus(entry)">{{ QUEUE_STATUS_LABELS[queueDisplayStatus(entry)] || entry.status }}</span>
                  <div v-if="entry.session && entry.session.status !== entry.status" class="sub-status">会话：{{ entry.session.status }}</div>
                </td>
                <td>
                  <div class="session-title">{{ entry.session?.title || entry.taskId }}</div>
                  <div class="session-id">{{ entry.sessionId }}</div>
                </td>
                <td class="time-cell">{{ entry.projectId || '-' }}</td>
                <td>
                  <div class="progress-text">
                    {{ entry.session && entry.session.currentStepIndex != null ? entry.session.currentStepIndex + 1 : '-' }} / {{ entry.session?.stepCount ?? '-' }}
                  </div>
                </td>
                <td>
                  <div class="progress-text">第 {{ entry.retryCount }} 次</div>
                  <div v-if="queueDisplayStatus(entry) === 'retry_wait'" class="sub-status">将于 {{ formatTime(entry.nextAttemptAt) }} 执行</div>
                </td>
                <td class="reason-cell">{{ queueReason(entry) }}</td>
                <td class="time-cell">{{ formatTime(entry.updatedAt) }}</td>
                <td>
                  <div class="row-actions" @click.stop>
                    <button v-if="entry.session && isRunning(entry.session.status)" class="action-btn small" :disabled="busy" @click="cancel(entry.sessionId)">取消</button>
                    <button v-if="entry.session?.status === 'orphaned'" class="action-btn small" :disabled="busy" @click="recover(entry.sessionId)">恢复</button>
                    <button v-if="entry.session?.status === 'failed'" class="action-btn small" :disabled="busy" @click="retry(entry.sessionId)">重试</button>
                  </div>
                </td>
              </tr>
              <tr v-if="expandedQueueId === entry.sessionId" class="detail-row">
                <td colspan="8">
                  <div v-if="queueDetails[entry.sessionId]" class="queue-detail">
                    <div class="detail-block">
                      <div class="detail-title">当前状态</div>
                      <div class="detail-line">会话状态：{{ queueDetails[entry.sessionId].session?.status || '会话记录缺失' }}</div>
                      <div v-if="queueDetails[entry.sessionId].session?.currentStep" class="detail-line">
                        当前步骤：{{ queueDetails[entry.sessionId].session?.currentStep?.title || queueDetails[entry.sessionId].session?.currentStep?.stepId }}
                      </div>
                      <div v-if="queueDetails[entry.sessionId].session?.review" class="detail-line">
                        待审核：{{ queueDetails[entry.sessionId].session?.review?.title || queueDetails[entry.sessionId].session?.review?.targetType }}
                      </div>
                      <div v-if="queueDetails[entry.sessionId].evidence.latestCheckpoint" class="detail-line">
                        断点：已完成第 {{ (queueDetails[entry.sessionId].evidence.latestCheckpoint?.stepIndex ?? 0) + 1 }} 步，可从第 {{ (queueDetails[entry.sessionId].evidence.latestCheckpoint?.nextStepIndex ?? 0) + 1 }} 步继续
                      </div>
                    </div>
                    <div v-if="queueDetails[entry.sessionId].item.retryHistory?.length" class="detail-block">
                      <div class="detail-title">重试记录</div>
                      <div v-for="(record, index) in queueDetails[entry.sessionId].item.retryHistory" :key="index" class="detail-line">
                        第 {{ record.attempt }} 次：{{ record.reason || record.rule || '-' }}（{{ formatTime(record.scheduledAt) }}）
                      </div>
                    </div>
                    <div v-if="queueDetails[entry.sessionId].evidence.artifacts" class="detail-block">
                      <div class="detail-title">产物</div>
                      <div v-if="queueDetails[entry.sessionId].evidence.artifacts?.projectRoot" class="detail-line">
                        项目目录：{{ queueDetails[entry.sessionId].evidence.artifacts?.projectRoot }}
                      </div>
                      <div v-if="queueDetails[entry.sessionId].evidence.artifacts?.finalAnswerPreview" class="detail-line">
                        最终回答预览：{{ queueDetails[entry.sessionId].evidence.artifacts?.finalAnswerPreview }}
                      </div>
                      <div v-if="!queueDetails[entry.sessionId].evidence.artifacts?.projectRoot && !queueDetails[entry.sessionId].evidence.artifacts?.finalAnswerPreview" class="detail-line">
                        暂无可展示产物
                      </div>
                    </div>
                    <div v-if="queueDetails[entry.sessionId].evidence.recentEvents.length" class="detail-block">
                      <div class="detail-title">最近事件</div>
                      <div v-for="(event, index) in queueDetails[entry.sessionId].evidence.recentEvents" :key="index" class="detail-line">
                        {{ formatTime(event.timestamp) }} {{ event.title || event.type }} — {{ event.summary || '' }}
                      </div>
                    </div>
                  </div>
                  <div v-else class="queue-detail">详情加载中…</div>
                </td>
              </tr>
            </template>
          </tbody>
        </table>
      </div>
    </section>

    <section class="page-section">
      <div class="section-header">
        <h2>任务与会话</h2>
        <div class="header-actions">
          <label class="checkbox-label">
            <input v-model="showTerminal" type="checkbox" @change="loadAll" />
            显示已结束
          </label>
          <button class="action-btn" :disabled="busy" @click="loadAll">刷新</button>
        </div>
      </div>
      <p class="section-hint">管理推理 session、生产测试、取消/清理/恢复异常任务。</p>

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
              <th>结论</th>
              <th>标题 / Prompt</th>
              <th>进度</th>
              <th>更新时间</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-if="!sessions.length && !busy">
              <td colspan="6" class="empty-cell">暂无会话</td>
            </tr>
            <tr v-for="session in sessions" :key="session.sessionId">
              <td>
                <span class="status-badge" :data-status="session.status">{{ session.status }}</span>
              </td>
              <td>
                <span class="verdict-badge" :data-verdict="session.verdict || 'BLOCKED'">{{ session.verdict || '-' }}</span>
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
                  <button v-if="session.status === 'orphaned'" class="action-btn small" :disabled="busy" @click="recover(session.sessionId)">恢复</button>
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

.success-banner {
  margin-bottom: 14px;
  padding: 10px 12px;
  border-radius: 8px;
  background: rgba(77, 214, 140, 0.12);
  border: 1px solid rgba(77, 214, 140, 0.28);
  color: var(--c-success);
  font-size: 13px;
}

.filter-select {
  padding: 7px 10px;
  border-radius: 8px;
  border: 1px solid var(--c-border-mid);
  background: rgba(255, 255, 255, 0.06);
  color: var(--c-text);
  font: inherit;
  font-size: 13px;
  cursor: pointer;
}

.queue-row {
  cursor: pointer;
}

.queue-row:hover {
  background: rgba(255, 255, 255, 0.03);
}

.detail-row td {
  background: rgba(255, 255, 255, 0.02);
}

.queue-detail {
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding: 6px 4px;
  color: var(--c-text-sub);
  font-size: 12px;
}

.detail-block {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.detail-title {
  font-weight: 700;
  color: var(--c-text);
  margin-bottom: 2px;
}

.detail-line {
  line-height: 1.5;
  word-break: break-all;
}

.sub-status {
  margin-top: 4px;
  font-size: 11px;
  color: var(--c-text-muted);
}

.reason-cell {
  max-width: 240px;
  color: var(--c-text-sub);
  word-break: break-all;
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
.status-badge[data-status='claimed'] { background: rgba(94, 204, 255, 0.16); color: var(--c-accent); }
.status-badge[data-status='queued'] { background: rgba(94, 204, 255, 0.1); color: var(--c-accent); }
.status-badge[data-status='retry_wait'] { background: rgba(246, 201, 78, 0.16); color: var(--c-warn); }
.status-badge[data-status='waiting_review'] { background: rgba(246, 201, 78, 0.16); color: var(--c-warn); }
.status-badge[data-status='blocked'] { background: rgba(246, 201, 78, 0.16); color: var(--c-warn); }
.status-badge[data-status='timeout'] { background: rgba(255, 107, 107, 0.16); color: var(--c-error); }
.status-badge[data-status='completed'] { background: rgba(77, 214, 140, 0.16); color: var(--c-success); }
.status-badge[data-status='failed'] { background: rgba(255, 107, 107, 0.16); color: var(--c-error); }
.status-badge[data-status='cancelled'] { background: rgba(246, 201, 78, 0.16); color: var(--c-warn); }

.verdict-badge {
  display: inline-block;
  padding: 3px 8px;
  border-radius: 6px;
  font-size: 11px;
  font-weight: 700;
  font-family: SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  background: rgba(255, 255, 255, 0.08);
  color: var(--c-text-sub);
}

.verdict-badge[data-verdict='PASS'] { background: rgba(77, 214, 140, 0.16); color: var(--c-success); }
.verdict-badge[data-verdict='FAIL'] { background: rgba(255, 107, 107, 0.16); color: var(--c-error); }
.verdict-badge[data-verdict='BLOCKED'] { background: rgba(246, 201, 78, 0.16); color: var(--c-warn); }
.verdict-badge[data-verdict='CANCELLED'] { background: rgba(255, 255, 255, 0.12); color: var(--c-text-sub); }

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
