<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue'
import { useControlConsoleApp } from '../composables/useControlConsoleApp'
import { getStructuredLogs, triggerSupervision } from '../services/controlApi'
import {
  getEventHistory,
  getLogPrefixes,
  getReviewRecords,
  getStorageOverview,
  runMaintenanceReset,
  runRetention
} from '../services/maintenanceApi'

const app = useControlConsoleApp()

type StorageEntry = {
  key: string
  label: string
  exists: boolean
  fileCount: number
  totalBytes: number
  sizeLabel: string
  oldestAt: string | null
  newestAt: string | null
}

type ResetCategory = {
  key: string
  label: string
  impactLevel?: 'safe' | 'caution' | 'high' | 'critical'
  impactLabel?: string
  description?: string
  impactSummary?: string
  exists?: boolean
  fileCount?: number
  totalBytes?: number
  sizeLabel?: string
  newestAt?: string | null
}

type ConfirmTarget = {
  key: string
  label: string
  impactLevel?: string
  impactLabel?: string
  description?: string
  impactSummary?: string
  fileCount?: number
  sizeLabel?: string
  newestAt?: string | null
  isAll?: boolean
}

type EventHistoryItem = {
  ts?: string
  traceId?: string
  eventId?: string
  code?: string
  kind?: string
  caller?: string
  ok?: boolean
  durationMs?: number
  error?: string | null
}

type ReviewRecordItem = {
  timestamp?: string
  ts?: string
  source?: string
  sessionId?: string
  targetType?: string
  decision?: string
  action?: string | null
  stepId?: string | null
}

const logPrefix = ref('hermes-runtime')
const logLines = ref(100)
const structuredLogs = ref<any[]>([])
const structuredBusy = ref(false)
const structuredError = ref('')
const logPrefixes = ref<string[]>([])
const supervisionTriggerBusy = ref(false)
const supervisionTriggerMessage = ref('')
const supervisionRunning = ref<{ sessionId: string; trigger: string } | null>(null)
const supervisionLatest = ref<any>(null)
const supervisionState = ref<any>(null)
let supervisionPollTimer: ReturnType<typeof setInterval> | null = null

const storageOverview = ref<StorageEntry[]>([])
const resetCategories = ref<ResetCategory[]>([])
const confirmTarget = ref<ConfirmTarget | null>(null)
const storageBusy = ref(false)
const storageError = ref('')
const resetBusy = ref('')
const resetMessage = ref('')

const eventHistory = ref<EventHistoryItem[]>([])
const eventHistoryBusy = ref(false)
const eventHistoryError = ref('')

const reviewRecords = ref<ReviewRecordItem[]>([])
const reviewRecordsBusy = ref(false)
const reviewRecordsError = ref('')

async function loadStructuredLogs() {
  structuredBusy.value = true
  structuredError.value = ''
  try {
    const res = await getStructuredLogs(logPrefix.value, logLines.value)
    const payload = await res.json().catch(() => null)
    if (!res.ok || !payload?.ok) throw new Error(payload?.error || `http_${res.status}`)
    structuredLogs.value = Array.isArray(payload.logs) ? payload.logs : []
  } catch (e) {
    structuredError.value = String(e)
  } finally {
    structuredBusy.value = false
  }
}

async function loadLogPrefixes() {
  try {
    const res = await getLogPrefixes()
    const payload = await res.json().catch(() => null)
    if (res.ok && payload?.ok && Array.isArray(payload.prefixes)) {
      logPrefixes.value = payload.prefixes
      if (payload.prefixes.length > 0 && !payload.prefixes.includes(logPrefix.value)) {
        logPrefix.value = payload.prefixes.includes('hermes-runtime') ? 'hermes-runtime' : payload.prefixes[0]
      }
    }
  } catch {
    // 前缀发现失败时保持默认值
  }
}

async function loadStorageOverview() {
  storageBusy.value = true
  storageError.value = ''
  try {
    const res = await getStorageOverview()
    const payload = await res.json().catch(() => null)
    if (!res.ok || !payload?.ok) throw new Error(payload?.error || `http_${res.status}`)
    storageOverview.value = Array.isArray(payload.overview) ? payload.overview : []
    resetCategories.value = Array.isArray(payload.categories) ? payload.categories : (Array.isArray(payload.resetCategories) ? payload.resetCategories : [])
  } catch (e) {
    storageError.value = String(e)
  } finally {
    storageBusy.value = false
  }
}

async function runRetentionNow() {
  storageBusy.value = true
  resetMessage.value = ''
  try {
    const res = await runRetention()
    const payload = await res.json().catch(() => null)
    if (!res.ok || !payload?.ok) throw new Error(payload?.error || `http_${res.status}`)
    const report = payload.report || {}
    resetMessage.value = `保留清理完成：归档 ${report.archived || 0} 项，受保护 ${report.protected || 0} 项${report.archiveDir ? `，归档于 ${report.archiveDir}` : '，无超期数据'}`
    await loadStorageOverview()
  } catch (e) {
    resetMessage.value = String(e)
  } finally {
    storageBusy.value = false
  }
}

function openResetConfirm(target: ResetCategory | ConfirmTarget) {
  confirmTarget.value = {
    key: target.key,
    label: target.label,
    impactLevel: target.impactLevel,
    impactLabel: target.impactLabel,
    description: target.description,
    impactSummary: target.impactSummary,
    fileCount: target.fileCount,
    sizeLabel: target.sizeLabel,
    newestAt: target.newestAt ?? null,
    isAll: target.key === 'all'
  }
}

function closeResetConfirm() {
  if (resetBusy.value) return
  confirmTarget.value = null
}

function impactTone(level?: string) {
  if (level === 'safe') return 'var(--c-success-dim)'
  if (level === 'caution') return 'var(--c-warn)'
  if (level === 'high') return 'var(--c-error-dim)'
  if (level === 'critical') return 'var(--c-error)'
  return 'var(--c-text-muted)'
}

async function confirmResetCategory() {
  const target = confirmTarget.value
  if (!target || resetBusy.value) return
  resetBusy.value = target.key
  resetMessage.value = ''
  try {
    const res = await runMaintenanceReset(target.key)
    const payload = await res.json().catch(() => null)
    if (!res.ok || !payload?.ok) throw new Error(payload?.error || `http_${res.status}`)
    const results = Array.isArray(payload.report?.results) ? payload.report.results : []
    const cleared = results.reduce((sum: number, item: any) => sum + (item.cleared || 0), 0)
    resetMessage.value = `已归档并清空「${target.label}」：共 ${cleared} 个文件。归档位于 state/_archive/reset_*。`
    confirmTarget.value = null
    await loadStorageOverview()
  } catch (e) {
    resetMessage.value = String(e)
  } finally {
    resetBusy.value = ''
  }
}

async function loadEventHistory() {
  eventHistoryBusy.value = true
  eventHistoryError.value = ''
  try {
    const res = await getEventHistory(100)
    const payload = await res.json().catch(() => null)
    if (!res.ok || !payload?.ok) throw new Error(payload?.error || `http_${res.status}`)
    eventHistory.value = Array.isArray(payload.events) ? payload.events : []
  } catch (e) {
    eventHistoryError.value = String(e)
  } finally {
    eventHistoryBusy.value = false
  }
}

async function loadReviewRecords() {
  reviewRecordsBusy.value = true
  reviewRecordsError.value = ''
  try {
    const res = await getReviewRecords(100)
    const payload = await res.json().catch(() => null)
    if (!res.ok || !payload?.ok) throw new Error(payload?.error || `http_${res.status}`)
    reviewRecords.value = Array.isArray(payload.records) ? payload.records : []
  } catch (e) {
    reviewRecordsError.value = String(e)
  } finally {
    reviewRecordsBusy.value = false
  }
}

async function loadSupervisionState() {
  try {
    const res = await fetch('/api/control/supervision/state')
    const payload = await res.json().catch(() => null)
    if (res.ok && payload?.ok) supervisionState.value = payload
  } catch {
    // 状态加载失败不阻塞页面
  }
}

async function loadSupervisionLatest() {
  try {
    const res = await fetch('/api/control/supervision/latest')
    const payload = await res.json().catch(() => null)
    if (res.ok && payload?.ok && payload.hasData) {
      supervisionLatest.value = payload
      return payload
    }
  } catch {
    // 结果加载失败不阻塞
  }
  return null
}

function stopSupervisionPolling() {
  if (supervisionPollTimer) {
    clearInterval(supervisionPollTimer)
    supervisionPollTimer = null
  }
}

async function runSupervision() {
  if (supervisionTriggerBusy.value) return
  supervisionTriggerBusy.value = true
  supervisionTriggerMessage.value = ''
  supervisionLatest.value = null
  try {
    const res = await triggerSupervision({ trigger: 'manual' })
    const payload = await res.json().catch(() => null)
    if (!res.ok || !payload?.ok) throw new Error(payload?.error || `http_${res.status}`)
    const sessionId = String(payload.sessionId || '')
    supervisionRunning.value = { sessionId, trigger: payload.trigger || 'manual' }
    supervisionTriggerMessage.value = `评估进行中（session ${sessionId.slice(0, 22)}…），评分卡 >= 90 且全部通过时不调用右脑。`
    await loadSupervisionState()

    stopSupervisionPolling()
    let attempts = 0
    supervisionPollTimer = setInterval(async () => {
      attempts += 1
      const latest = await loadSupervisionLatest()
      if (latest && latest.sessionId === supervisionRunning.value?.sessionId && latest.status !== 'running') {
        stopSupervisionPolling()
        const sc = latest.scorecard
        supervisionTriggerMessage.value = sc
          ? `评估完成：总体 ${sc.overallScore} 分（${sc.overallStatus}）${latest.correctionPlan ? '，右脑已给出修正建议' : '，未调用右脑'}`
          : '评估完成'
        supervisionRunning.value = null
        app.loadSupervisionResult()
      }
      if (attempts >= 60) {
        stopSupervisionPolling()
        supervisionTriggerMessage.value = '评估超时（3 分钟未返回结果），请查看执行日志。'
        supervisionRunning.value = null
      }
    }, 3000)
  } catch (e) {
    supervisionTriggerMessage.value = String(e)
  } finally {
    supervisionTriggerBusy.value = false
  }
}

function formatTime(iso?: string | null) {
  if (!iso) return '-'
  const d = new Date(iso)
  return isNaN(d.getTime()) ? String(iso) : `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`
}

onMounted(() => {
  app.fetchLogs()
  app.loadSupervisionResult()
  loadSupervisionState()
  loadSupervisionLatest()
  loadLogPrefixes().then(() => loadStructuredLogs())
  loadStorageOverview()
  loadEventHistory()
  loadReviewRecords()
})

onUnmounted(() => {
  stopSupervisionPolling()
})
</script>

<template>
  <div class="page-logs">
    <!-- 清理与重置 -->
    <section class="page-section">
      <div class="section-header">
        <h2>清理与重置</h2>
        <div class="header-actions">
          <button class="action-btn" :disabled="storageBusy" @click="loadStorageOverview">刷新状态</button>
          <button class="action-btn" :disabled="storageBusy" @click="runRetentionNow">执行保留清理</button>
        </div>
      </div>
      <p class="section-hint">
        这里管理 Control 生成的状态数据与审计记录（会话、事件、审核、测试报告、归档）。与工作台「测试前清理与记忆状态」互补：那里管理记忆类（日志/会话缓冲/上下文池/长期记忆/状态记录），这里管理状态数据；重叠的「运行轨迹/会话记录」语义一致，都是先归档再清理。
        所有清理一律先归档到 state/_archive/ 再清空；权威记忆（ai/memory/*）、配置（config/）与项目产物（storage/projects）不受影响。
      </p>
      <div v-if="storageError" class="error-banner">{{ storageError }}</div>
      <div v-if="resetMessage" class="message-tip">{{ resetMessage }}</div>

      <div class="clean-list">
        <div v-for="category in resetCategories" :key="category.key" class="clean-item" :data-empty="!category.exists || category.fileCount === 0">
          <div class="clean-item-main">
            <div class="clean-item-title-row">
              <span class="clean-item-title">{{ category.label }}</span>
              <span class="impact-chip" :style="{ color: impactTone(category.impactLevel), borderColor: impactTone(category.impactLevel) }">{{ category.impactLabel || '影响未知' }}</span>
              <span class="clean-item-meta">占用 {{ category.exists ? category.sizeLabel : '无' }} · {{ category.fileCount ?? 0 }} 个文件<span v-if="category.newestAt"> · 最新 {{ formatTime(category.newestAt) }}</span></span>
            </div>
            <div class="clean-item-desc">{{ category.description }}</div>
            <div class="clean-item-impact" :style="{ color: impactTone(category.impactLevel) }">{{ category.impactSummary }}</div>
          </div>
          <button class="action-btn outline clean-item-btn" :disabled="resetBusy !== ''" @click="openResetConfirm(category)">
            {{ resetBusy === category.key ? '清理中...' : '清理此项' }}
          </button>
        </div>
      </div>
    </section>

    <!-- 二级确认弹窗（应用内，含影响说明与数据量） -->
    <div v-if="confirmTarget" class="reset-confirm-backdrop" @click.self="closeResetConfirm">
      <div class="reset-confirm-modal" role="dialog" aria-modal="true" aria-label="确认清理">
        <div class="reset-confirm-title">
          确认清理「{{ confirmTarget.label }}」
          <span class="impact-chip" :style="{ color: impactTone(confirmTarget.impactLevel), borderColor: impactTone(confirmTarget.impactLevel) }">{{ confirmTarget.impactLabel || '影响未知' }}</span>
        </div>
        <div class="reset-confirm-body">
          <div class="reset-confirm-row"><span class="reset-confirm-key">作用</span><span>{{ confirmTarget.description }}</span></div>
          <div class="reset-confirm-row"><span class="reset-confirm-key">影响</span><span :style="{ color: impactTone(confirmTarget.impactLevel) }">{{ confirmTarget.impactSummary }}</span></div>
          <div v-if="!confirmTarget.isAll" class="reset-confirm-row">
            <span class="reset-confirm-key">数据量</span>
            <span>{{ confirmTarget.fileCount ?? 0 }} 个文件 · {{ confirmTarget.sizeLabel || '无' }}<span v-if="confirmTarget.newestAt"> · 最新 {{ formatTime(confirmTarget.newestAt) }}</span></span>
          </div>
          <div class="reset-confirm-row"><span class="reset-confirm-key">归档</span><span>先移动到 state/_archive/ 归档，再从当前状态清空；权威记忆、配置与 storage/projects 不受影响。</span></div>
        </div>
        <div class="reset-confirm-actions">
          <button class="action-btn outline" :disabled="resetBusy !== ''" @click="closeResetConfirm">取消</button>
          <button class="action-btn danger" :disabled="resetBusy !== ''" @click="confirmResetCategory">
            {{ resetBusy ? '清理中...' : '确认归档并清空' }}
          </button>
        </div>
      </div>
    </div>

    <!-- 实时日志 -->
    <section class="page-section">
      <div class="section-header">
        <h2>实时日志</h2>
        <button class="action-btn" @click="app.fetchLogs()">刷新</button>
      </div>
      <p class="section-hint">来源：Hermes gateway 运行日志（/tmp/gamestudio-hermes-gateway.log），Control 重启不保留。</p>
      <div class="log-toolbar">
        <button class="action-btn" :disabled="app.logClearBusy.value" @click="app.clearVisibleLogs()">
          {{ app.logClearBusy.value ? '清理中...' : '清空显示' }}
        </button>
      </div>
      <div ref="app.logContainer" class="log-viewer">
        <div
          v-for="(line, index) in app.visibleLogLines.value"
          :key="index"
          class="log-line"
          :style="{ color: app.getLogLineColor(line) }"
        >
          {{ line }}
        </div>
        <div v-if="!app.visibleLogLines.value.length" class="empty-state">暂无日志</div>
      </div>
    </section>

    <!-- 结构化日志查询 -->
    <section class="page-section">
      <div class="section-header">
        <h2>结构化日志查询</h2>
      </div>
      <div class="query-bar">
        <div class="form-group">
          <label>前缀（今日）</label>
          <select v-model="logPrefix" class="prefix-select" @change="loadStructuredLogs">
            <option v-for="prefix in logPrefixes" :key="prefix" :value="prefix">{{ prefix }}</option>
            <option v-if="!logPrefixes.length" :value="logPrefix">{{ logPrefix }}</option>
          </select>
        </div>
        <div class="form-group">
          <label>行数</label>
          <input v-model.number="logLines" type="number" min="10" max="1000" />
        </div>
        <button class="action-btn" :disabled="structuredBusy" @click="loadStructuredLogs">
          {{ structuredBusy ? '查询中...' : '查询' }}
        </button>
      </div>
      <div v-if="structuredError" class="error-banner">{{ structuredError }}</div>
      <div class="structured-log-viewer">
        <pre v-if="structuredLogs.length" class="structured-pre">{{ JSON.stringify(structuredLogs, null, 2) }}</pre>
        <div v-else class="empty-state">该前缀今日暂无结构化日志</div>
      </div>
    </section>

    <!-- 事件分发历史 -->
    <section class="page-section">
      <div class="section-header">
        <h2>事件分发历史</h2>
        <button class="action-btn" :disabled="eventHistoryBusy" @click="loadEventHistory">
          {{ eventHistoryBusy ? '加载中...' : '刷新' }}
        </button>
      </div>
      <p class="section-hint">来源：state/events/events.jsonl（最近 100 条，倒序）。</p>
      <div v-if="eventHistoryError" class="error-banner">{{ eventHistoryError }}</div>
      <div class="audit-table-wrap">
        <table class="audit-table">
          <thead>
            <tr>
              <th>时间</th>
              <th>事件</th>
              <th>编号</th>
              <th>来源</th>
              <th>结果</th>
              <th>耗时</th>
              <th>traceId</th>
            </tr>
          </thead>
          <tbody>
            <tr v-if="!eventHistory.length && !eventHistoryBusy">
              <td colspan="7" class="empty-cell">暂无事件记录</td>
            </tr>
            <tr v-for="(item, index) in eventHistory" :key="item.traceId || index">
              <td class="time-cell">{{ formatTime(item.ts) }}</td>
              <td class="mono-cell">{{ item.eventId || '-' }}</td>
              <td class="mono-cell">{{ item.code || '-' }}</td>
              <td><span class="caller-badge">{{ item.caller || '-' }}</span></td>
              <td><span class="result-badge" :data-ok="item.ok !== false">{{ item.ok !== false ? 'ok' : 'fail' }}</span></td>
              <td class="mono-cell">{{ item.durationMs != null ? `${item.durationMs}ms` : '-' }}</td>
              <td class="mono-cell muted">{{ item.traceId ? item.traceId.slice(0, 8) : '-' }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>

    <!-- 审核记录 -->
    <section class="page-section">
      <div class="section-header">
        <h2>审核记录</h2>
        <button class="action-btn" :disabled="reviewRecordsBusy" @click="loadReviewRecords">
          {{ reviewRecordsBusy ? '加载中...' : '刷新' }}
        </button>
      </div>
      <p class="section-hint">来源：agent-runtime / reasoning review records（最近 100 条，倒序）。</p>
      <div v-if="reviewRecordsError" class="error-banner">{{ reviewRecordsError }}</div>
      <div class="audit-table-wrap">
        <table class="audit-table">
          <thead>
            <tr>
              <th>时间</th>
              <th>来源</th>
              <th>会话</th>
              <th>目标</th>
              <th>决定</th>
            </tr>
          </thead>
          <tbody>
            <tr v-if="!reviewRecords.length && !reviewRecordsBusy">
              <td colspan="5" class="empty-cell">暂无审核记录</td>
            </tr>
            <tr v-for="(item, index) in reviewRecords" :key="index">
              <td class="time-cell">{{ formatTime(item.timestamp || item.ts) }}</td>
              <td><span class="caller-badge">{{ item.source || '-' }}</span></td>
              <td class="mono-cell muted">{{ item.sessionId ? item.sessionId.slice(0, 22) : '-' }}</td>
              <td class="mono-cell">{{ [item.targetType, item.action || item.stepId].filter(Boolean).join(' / ') || '-' }}</td>
              <td><span class="result-badge" :data-ok="item.decision === 'approve'">{{ item.decision || '-' }}</span></td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>

    <!-- 自检与监督 -->
    <section class="page-section">
      <h2>自检与监督</h2>
      <p class="section-hint">
        监督评估 = 右脑（Kimi）对左脑（OMLX）执行质量的可控评估：先确定性评分卡，>= 90 且全部通过时不调用右脑；不达标才由右脑给出修正建议。日常任务执行不依赖右脑。
        定时评估：{{ supervisionState?.enabled ? '已启用（启动后 30s + 每 30 分钟）' : '未启用' }}<span v-if="supervisionState?.authFailure"> · 曾因认证失败自动关停（{{ supervisionState.authFailure.recoveryHint }}）</span>
      </p>
      <div class="action-bar">
        <button class="action-btn" @click="app.loadHermesSelfCheck()">刷新自检</button>
        <button class="action-btn" :disabled="app.supervisionLoading.value" @click="loadSupervisionLatest(); app.loadSupervisionResult()">
          {{ app.supervisionLoading.value ? '加载中...' : '查看监督评估' }}
        </button>
        <button class="action-btn" :disabled="supervisionTriggerBusy || !!supervisionRunning" @click="runSupervision">
          {{ supervisionTriggerBusy ? '触发中...' : (supervisionRunning ? '评估进行中...' : '触发监督评估') }}
        </button>
      </div>
      <div v-if="supervisionTriggerMessage" class="message-tip">{{ supervisionTriggerMessage }}</div>

      <div v-if="supervisionLatest?.scorecard" class="diagnostics-card">
        <div class="diag-title">
          最近监督评估
          <span class="diag-score" :data-status="supervisionLatest.scorecard.overallStatus === 'passed' ? 'ok' : 'error'">
            {{ supervisionLatest.scorecard.overallScore }} 分（{{ supervisionLatest.scorecard.overallStatus }}）
          </span>
        </div>
        <div class="diag-summary">
          session {{ supervisionLatest.sessionId }} · {{ supervisionLatest.status }} · {{ formatTime(supervisionLatest.updatedAt) }}
          <span v-if="!supervisionLatest.correctionPlan"> · 评分通过，未调用右脑</span>
        </div>
        <div class="diag-checks">
          <div
            v-for="category in supervisionLatest.scorecard.categories || []"
            :key="category.name"
            class="diag-check"
            :data-status="category.status === 'passed' ? 'ok' : 'error'"
          >
            <span class="check-key">{{ category.name }}</span>
            <span class="check-status">{{ category.status }}</span>
            <span class="check-detail">{{ category.score }} 分{{ category.detail ? ` · ${category.detail}` : '' }}</span>
          </div>
        </div>
        <div v-if="supervisionLatest.correctionPlan" class="diag-correction">
          <div class="diag-title">右脑修正建议</div>
          <pre class="structured-pre">{{ typeof supervisionLatest.correctionPlan === 'string' ? supervisionLatest.correctionPlan : JSON.stringify(supervisionLatest.correctionPlan, null, 2) }}</pre>
        </div>
      </div>

      <div v-if="app.selfCheck.value" class="diagnostics-card">
        <div class="diag-title">自检结果</div>
        <div class="diag-summary">{{ app.selfCheck.value.summary }}</div>
        <div class="diag-checks">
          <div
            v-for="check in app.selfCheck.value.checks"
            :key="check.key"
            class="diag-check"
            :data-status="check.status"
          >
            <span class="check-key">{{ check.label }}</span>
            <span class="check-status">{{ check.status }}</span>
            <span class="check-detail">{{ check.detail }}</span>
          </div>
        </div>
      </div>
    </section>
  </div>
</template>

<style scoped>
.page-logs {
  display: flex;
  flex-direction: column;
  gap: 24px;
}

.page-section h2 {
  margin: 0 0 6px;
  font-size: 18px;
  color: var(--c-text-inv);
}

.section-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 12px;
}

.header-actions {
  display: flex;
  gap: 8px;
}

.section-hint {
  margin: 0 0 12px;
  font-size: 12px;
  color: var(--c-text-muted);
  line-height: 1.6;
}

.log-toolbar {
  margin-bottom: 10px;
}

.log-viewer {
  min-height: 320px;
  max-height: 520px;
  overflow-y: auto;
  padding: 14px;
  border-radius: 10px;
  background: #0b0f14;
  border: 1px solid var(--c-border);
  font-family: SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  font-size: 12px;
  line-height: 1.55;
  color: var(--c-text-sub);
  white-space: pre-wrap;
  word-break: break-word;
  scrollbar-width: none;
  -ms-overflow-style: none;
}

.log-viewer::-webkit-scrollbar { display: none; }

.log-line {
  padding: 1px 0;
}

.empty-state {
  padding: 24px;
  text-align: center;
  color: var(--c-text-muted);
}

.query-bar {
  display: flex;
  gap: 12px;
  align-items: flex-end;
  flex-wrap: wrap;
  margin-bottom: 12px;
}

.form-group {
  display: flex;
  flex-direction: column;
  gap: 5px;
}

.form-group label {
  font-size: 12px;
  color: var(--c-text-sub);
}

.form-group input,
.prefix-select {
  padding: 8px 10px;
  border-radius: 6px;
  border: 1px solid var(--c-border-mid);
  background: var(--c-bg-input);
  color: var(--c-text);
  font: inherit;
  font-size: 13px;
}

.structured-log-viewer {
  min-height: 160px;
  max-height: 360px;
  overflow: auto;
  padding: 12px;
  border-radius: 8px;
  background: #0b0f14;
  border: 1px solid var(--c-border);
  scrollbar-width: none;
  -ms-overflow-style: none;
}

.structured-log-viewer::-webkit-scrollbar { display: none; }

.structured-pre {
  margin: 0;
  font-family: SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  font-size: 12px;
  line-height: 1.5;
  color: var(--c-text-sub);
  white-space: pre-wrap;
  word-break: break-word;
}

.clean-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.clean-item {
  display: flex;
  gap: 12px;
  align-items: flex-start;
  justify-content: space-between;
  padding: 10px 12px;
  border: 1px solid var(--c-border);
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.02);
}

.clean-item[data-empty='true'] {
  opacity: 0.55;
}

.clean-item.all {
  border-color: rgba(255, 107, 107, 0.35);
}

.clean-item-main {
  display: flex;
  flex-direction: column;
  gap: 4px;
  flex: 1;
  min-width: 0;
}

.clean-item-title-row {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
}

.clean-item-title {
  font-size: 13px;
  color: var(--c-text);
  font-weight: 600;
}

.clean-item-meta {
  font-size: 12px;
  color: var(--c-text-muted);
}

.clean-item-desc {
  font-size: 12px;
  color: var(--c-text-sub);
  line-height: 1.55;
}

.clean-item-impact {
  font-size: 12px;
  line-height: 1.55;
}

.clean-item-btn {
  flex: 0 0 auto;
}

.impact-chip {
  font-size: 11px;
  padding: 0 8px;
  border-radius: 999px;
  border: 1px solid var(--c-border-mid);
}

.reset-confirm-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.65);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1100;
  padding: 20px;
}

.reset-confirm-modal {
  width: min(560px, calc(100vw - 40px));
  max-height: calc(100vh - 40px);
  overflow-y: auto;
  border: 1px solid rgba(255, 107, 107, 0.4);
  border-radius: 10px;
  background: var(--c-bg-panel);
  padding: 16px;
  box-shadow: 0 20px 60px rgba(0, 0, 0, 0.5);
  scrollbar-width: none;
  -ms-overflow-style: none;
}

.reset-confirm-modal::-webkit-scrollbar { display: none; }

.reset-confirm-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--c-text);
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
}

.reset-confirm-body {
  margin-top: 12px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.reset-confirm-row {
  display: flex;
  gap: 10px;
  font-size: 12px;
  line-height: 1.6;
  color: var(--c-text-sub);
}

.reset-confirm-key {
  flex: 0 0 44px;
  color: var(--c-text-muted);
}

.reset-confirm-actions {
  margin-top: 14px;
  display: flex;
  gap: 8px;
  justify-content: flex-end;
}

.audit-table-wrap {
  border: 1px solid var(--c-border);
  border-radius: 10px;
  overflow: auto;
  max-height: 360px;
  scrollbar-width: none;
  -ms-overflow-style: none;
}

.audit-table-wrap::-webkit-scrollbar { display: none; }

.audit-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 12px;
}

.audit-table th,
.audit-table td {
  padding: 8px 10px;
  text-align: left;
  border-bottom: 1px solid var(--c-border);
  color: var(--c-text-sub);
}

.audit-table th {
  background: var(--c-bg-card);
  color: var(--c-text);
  font-weight: 600;
  position: sticky;
  top: 0;
}

.audit-table tr:last-child td { border-bottom: none; }

.mono-cell {
  font-family: SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  font-size: 11px;
}

.mono-cell.muted { color: var(--c-text-muted); }

.time-cell {
  white-space: nowrap;
  font-family: SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  font-size: 11px;
  color: var(--c-text-muted);
}

.caller-badge {
  display: inline-block;
  padding: 1px 8px;
  border-radius: 999px;
  font-size: 11px;
  border: 1px solid var(--c-border-mid);
  color: var(--c-text-sub);
}

.result-badge {
  display: inline-block;
  padding: 1px 8px;
  border-radius: 6px;
  font-size: 11px;
  font-weight: 700;
  background: rgba(255, 107, 107, 0.16);
  color: var(--c-error);
}

.result-badge[data-ok='true'] {
  background: rgba(77, 214, 140, 0.16);
  color: var(--c-success);
}

.empty-cell {
  text-align: center;
  color: var(--c-text-muted);
  padding: 20px !important;
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

.action-btn.danger {
  border-color: rgba(255, 107, 107, 0.4);
  color: var(--c-error-dim);
  background: rgba(255, 107, 107, 0.08);
}

.action-btn.danger:hover:not(:disabled) {
  background: rgba(255, 107, 107, 0.16);
}

.action-btn.danger.strong {
  border-color: var(--c-error);
  font-weight: 600;
}

.error-banner {
  margin-bottom: 12px;
  padding: 10px 12px;
  border-radius: 8px;
  background: rgba(255, 107, 107, 0.14);
  border: 1px solid rgba(255, 107, 107, 0.28);
  color: var(--c-error);
  font-size: 13px;
}

.message-tip {
  margin-bottom: 12px;
  font-size: 13px;
  color: var(--c-success);
}

.action-bar {
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
  margin-bottom: 16px;
}

.diagnostics-card {
  padding: 16px;
  border-radius: 10px;
  background: var(--c-bg-panel);
  border: 1px solid var(--c-border);
}

.diag-title {
  font-weight: 700;
  color: var(--c-text-inv);
  margin-bottom: 8px;
}

.diag-score {
  margin-left: 8px;
  font-size: 12px;
  font-weight: 600;
}

.diag-score[data-status='ok'] { color: var(--c-success); }
.diag-score[data-status='error'] { color: var(--c-error); }

.diag-correction {
  margin-top: 14px;
  border-top: 1px solid var(--c-border);
  padding-top: 12px;
}

.diag-summary {
  font-size: 13px;
  color: var(--c-text-sub);
  margin-bottom: 12px;
}

.diag-checks {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.diag-check {
  display: grid;
  grid-template-columns: 140px 80px 1fr;
  gap: 12px;
  align-items: center;
  padding: 8px 10px;
  border-radius: 6px;
  background: var(--c-bg-card);
  font-size: 13px;
}

.check-key {
  color: var(--c-text);
  font-weight: 600;
}

.check-status {
  text-transform: uppercase;
  font-size: 11px;
  font-weight: 700;
}

.diag-check[data-status='ok'] .check-status {
  color: var(--c-success);
}

.diag-check[data-status='error'] .check-status {
  color: var(--c-error);
}

.check-detail {
  color: var(--c-text-sub);
}
</style>
