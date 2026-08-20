<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { renderChatMessage } from '../lib/chatMarkdown'
import { formatPayloadRows } from '../lib/humanize'
import {
  formatDurationSeconds,
  formatReasoningEventTime,
  getReasoningEventMetaLines,
  getReasoningEventOps,
  getReasoningEventPreviewBlocks,
} from '../lib/reasoning'
import ReasoningTaskCard from '../components/ReasoningTaskCard.vue'
import ReasoningReviewCard from '../components/ReasoningReviewCard.vue'
import EventChainCard from '../components/EventChainCard.vue'
import EventResultCard from '../components/EventResultCard.vue'
import AgentStreamSteps from '../components/AgentStreamSteps.vue'
import { useControlConsoleAppContext } from '../composables/useControlConsoleAppContext'

const app = useControlConsoleAppContext()

const chatThreadRef = ref<HTMLElement | null>(null)
const logOpen = ref(true)
const userScrolledUp = ref(false)

const sessionEvents = computed(() => app.activeReasoningSession.value?.events || [])
const eventCount = computed(() => sessionEvents.value.length)
// agent 流式咨询进行中/刚结束时展示流式步骤区；此时 session 无确定性 plan，任务执行链卡片让位
const agentStreamVisible = computed(() => app.agentStreamActive.value || app.agentStreamSteps.value.length > 0)
const eventConfirmPayloadRows = computed(() => formatPayloadRows(app.eventConfirmPending.value?.payload))

function handleChatThreadScroll() {
  const el = chatThreadRef.value
  if (!el) return
  const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight
  userScrolledUp.value = distanceFromBottom > 96
}

watch(
  () => [app.chatHistory.value.length, eventCount.value, app.activeReasoningSession.value?.status, app.agentStreamSteps.value.length, app.agentStreamAnswerDraft.value.length],
  async () => {
    await nextTick()
    const el = chatThreadRef.value
    if (el && !userScrolledUp.value) el.scrollTop = el.scrollHeight
  }
)
</script>

<template>
  <div class="chat-page">
    <!-- 状态与提示区 -->
    <div class="chat-status-bar">
      <span class="chat-status-item">
        任务状态 <strong>{{ app.reasoningStatusLabel.value }}</strong>
      </span>
      <span v-if="app.activeReasoningSession.value" class="chat-status-item">
        Session {{ app.activeReasoningSession.value.sessionId }} · 总计时 {{ formatDurationSeconds(app.reasoningElapsedSeconds.value) }}
      </span>
      <span class="chat-status-item mode">{{ app.reviewModeLabel.value }}</span>
      <button
        v-if="app.canClearReasoningSession.value"
        class="chat-btn outline small"
        :disabled="app.reasoningStopBusy.value"
        @click="app.clearReasoningSession()"
      >清理记录</button>
    </div>
    <div v-if="app.reasoningSubmitBlockedReason.value" class="chat-banner error">
      {{ app.reasoningSubmitBlockedReason.value }}
    </div>
    <div v-if="app.reasoningError.value || app.activeReasoningSession.value?.error" class="chat-banner error">
      {{ app.reasoningError.value || app.activeReasoningSession.value?.error }}
    </div>
    <div v-if="app.reasoningClearMessage.value" class="chat-banner tip">{{ app.reasoningClearMessage.value }}</div>

    <!-- 聊天线程（含任务卡片与审核卡片） -->
    <div ref="chatThreadRef" class="chat-thread" @scroll="handleChatThreadScroll">
      <div v-if="app.chatHistory.value.length === 0 && !app.activeReasoningSession.value" class="chat-empty">
        <div class="chat-empty-title">开始一个治理任务</div>
        <div class="chat-empty-copy">
          在下方输入任务（例如：一口气生产一个小红帽互动故事）。任务执行链、审核点和最终回答都会出现在这里。
        </div>
      </div>
      <div v-for="(msg, i) in app.chatHistory.value" :key="i" class="chat-row" :data-role="msg.role">
        <div class="chat-bubble" :data-role="msg.role">
          <div class="chat-role">{{ msg.role.toUpperCase() }}</div>
          <div class="chat-message-text" v-html="renderChatMessage(msg.content)"></div>
          <div v-if="msg.tokens" class="chat-token-usage">
            Token 消耗: 提示词 {{ msg.tokens.prompt_tokens }} | 输出 {{ msg.tokens.completion_tokens }} | 总计 {{ msg.tokens.total_tokens }}
          </div>
        </div>
      </div>
      <AgentStreamSteps
        v-if="agentStreamVisible"
        :steps="app.agentStreamSteps.value"
        :answer-draft="app.agentStreamAnswerDraft.value"
        :active="app.agentStreamActive.value"
      />
      <ReasoningTaskCard
        v-if="app.activeReasoningSession.value && !agentStreamVisible"
        :session="app.activeReasoningSession.value"
        :status-label="app.reasoningStatusLabel.value"
        :elapsed-seconds="app.reasoningElapsedSeconds.value"
      />
      <EventChainCard
        v-if="app.eventChainVisible.value && app.eventRegistry.value"
        :registry="app.eventRegistry.value"
        :busy="app.eventRegistryBusy.value"
        :error="app.eventRegistryError.value"
        @close="app.closeEventChain()"
      />

      <!-- 事件执行确认卡（command + reviewRequired 事件先确认再执行） -->
      <div v-if="app.eventConfirmPending.value" class="event-confirm-card">
        <div class="event-confirm-title">
          确认执行事件
          <span class="event-confirm-sub">该事件为指令类且需要审核</span>
        </div>
        <div class="event-confirm-meta">
          <span>{{ app.eventConfirmPending.value.event.title }}</span>
          <span>{{ app.eventConfirmPending.value.event.eventId }}</span>
          <span v-if="app.eventConfirmPending.value.event.code">{{ app.eventConfirmPending.value.event.code }}</span>
        </div>
        <!-- 人话参数行优先；原始 payload 收进折叠的技术细节 -->
        <div v-if="eventConfirmPayloadRows.length" class="event-confirm-rows">
          <div v-for="row in eventConfirmPayloadRows" :key="row.key" class="event-confirm-row">
            <span class="event-confirm-key">{{ row.key }}</span>
            <span class="event-confirm-value">{{ row.value }}</span>
          </div>
        </div>
        <details v-if="app.eventConfirmPending.value.payload && Object.keys(app.eventConfirmPending.value.payload).length" class="event-confirm-tech">
          <summary>技术细节（原始参数）</summary>
          <pre class="event-confirm-payload">{{ JSON.stringify(app.eventConfirmPending.value.payload, null, 2) }}</pre>
        </details>
        <div class="event-confirm-actions">
          <button class="chat-btn outline" :disabled="app.eventDispatchBusy.value" @click="app.cancelEventDispatch()">取消</button>
          <button class="chat-btn primary" :disabled="app.eventDispatchBusy.value" @click="app.confirmEventDispatch()">{{ app.eventDispatchBusy.value ? '执行中...' : '确认执行' }}</button>
        </div>
      </div>

      <EventResultCard
        v-if="app.eventDispatchResult.value"
        :result="app.eventDispatchResult.value"
        :busy="app.eventDispatchBusy.value"
        @close="app.eventDispatchResult.value = null"
      />
      <ReasoningReviewCard
        v-if="app.reasoningPendingReview.value"
        :review="app.reasoningPendingReview.value"
        :target-label="app.reasoningReviewTargetLabel.value"
        :busy="app.reasoningReviewBusy.value"
        :auto-approve="app.reasoningAutoApproveEnabled.value"
        :approve-label="app.reasoningApproveActionLabel.value"
        :reject-label="app.reasoningRejectActionLabel.value"
        :can-step-back="app.canReasoningStepBack.value"
        :evidence="app.reasoningReviewEvidence.value"
        :draft="app.reasoningReviewDraft.value"
        :format-evidence="app.formatReasoningEvidence"
        @submit="app.submitReasoningReview"
        @update:draft="app.reasoningReviewDraft.value = $event"
      />
    </div>

    <!-- 输入区 -->
    <div class="chat-composer">
      <textarea
        v-model="app.sandboxPrompt.value"
        class="chat-composer-input"
        rows="3"
        placeholder="输入任务，Control 会创建 agentRuntime 可观测执行链..."
        @keydown="app.handleChatComposerKeydown"
      />
      <div class="chat-composer-footer">
        <div class="chat-composer-hint">Enter 换行，Cmd/Ctrl + Enter 开始任务执行。所有模型调用统一提交给 Hermes。</div>
        <div class="chat-composer-actions">
          <button
            class="chat-btn outline"
            title="脱离当前执行链、清空输入与对话内容（聊天记录归档后清空），开始全新会话"
            @click="app.startNewChatSession()"
          >新建会话</button>
          <label class="chat-toggle">
            <input v-model="app.reasoningAutoApproveEnabled.value" type="checkbox" />
            <span>{{ app.reviewModeLabel.value }}</span>
          </label>
          <button
            class="chat-btn primary"
            :disabled="app.reasoningBusy.value || !app.sandboxPrompt.value.trim() || !!app.reasoningSubmitBlockedReason.value"
            :title="app.reasoningSubmitBlockedReason.value || ''"
            @click="app.sendObservableReasoningChat()"
          >{{ app.primaryComposerActionLabel.value }}</button>
          <button
            v-if="app.activeReasoningSession.value"
            class="chat-btn outline"
            :disabled="app.reasoningStopBusy.value"
            @click="app.cancelReasoningSession()"
          >{{ app.reasoningStopBusy.value ? '停止中...' : '停止' }}</button>
        </div>
      </div>
    </div>

    <!-- 执行日志 -->
    <div class="chat-log-section">
      <button class="chat-log-header" type="button" @click="logOpen = !logOpen">
        <span>{{ logOpen ? '▾' : '▸' }} 执行日志（{{ eventCount }} 条事件）</span>
        <span v-if="app.reasoningBusy.value" class="chat-log-live">● 进行中</span>
      </button>
      <div v-if="logOpen" class="chat-log-body">
        <div v-if="eventCount === 0" class="chat-empty-copy">当前没有执行事件。发起任务后，这里会逐步记录 plan、工具调用、模型请求与审核流转。</div>
        <div v-for="event in sessionEvents" :key="event.eventId" class="chat-log-row">
          <div class="chat-log-type">{{ event.type }}</div>
          <div class="chat-log-content">
            <div class="chat-log-title">{{ event.title }}</div>
            <div class="chat-log-summary">{{ event.summary }}</div>
            <div v-if="getReasoningEventMetaLines(event).length" class="chat-log-meta">
              <span v-for="line in getReasoningEventMetaLines(event)" :key="`${event.eventId}-${line}`" class="chat-log-meta-chip">{{ line }}</span>
            </div>
            <div v-if="getReasoningEventOps(event).length" class="chat-log-ops">
              <div class="chat-log-ops-title">可观测调用</div>
              <div v-for="line in getReasoningEventOps(event)" :key="`${event.eventId}-${line}`" class="chat-log-op-line">{{ line }}</div>
            </div>
            <div v-for="block in getReasoningEventPreviewBlocks(event)" :key="`${event.eventId}-${block.title}`" class="chat-log-ops">
              <details class="chat-log-details">
                <summary>{{ block.title }}（技术细节）</summary>
                <pre class="chat-log-pre">{{ block.content }}</pre>
              </details>
            </div>
          </div>
          <div class="chat-log-time">{{ formatReasoningEventTime(event.timestamp) }}</div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.chat-page {
  display: flex;
  flex-direction: column;
  gap: 10px;
  height: calc(100vh - 120px);
  min-height: 480px;
}
.chat-status-bar {
  display: flex;
  align-items: center;
  gap: 14px;
  flex-wrap: wrap;
  font-size: 12px;
  color: var(--c-text-sub);
}
.chat-status-item strong { color: var(--c-text); }
.chat-status-item.mode {
  border: 1px solid var(--c-border-mid);
  border-radius: 999px;
  padding: 1px 10px;
}
.chat-banner {
  font-size: 12px;
  line-height: 1.5;
  border-radius: 8px;
  padding: 8px 10px;
}
.chat-banner.error {
  color: var(--c-error-dim);
  border: 1px solid rgba(255, 107, 107, 0.35);
  background: rgba(255, 107, 107, 0.08);
}
.chat-banner.tip {
  color: var(--c-accent);
  border: 1px solid var(--c-accent-dim);
  background: rgba(94, 204, 255, 0.06);
}
.chat-thread {
  flex: 1;
  overflow-y: auto;
  border: 1px solid var(--c-border);
  border-radius: 10px;
  background: var(--c-bg-panel);
  padding: 6px 4px;
  min-height: 160px;
  scrollbar-width: none;
  -ms-overflow-style: none;
}
.chat-thread::-webkit-scrollbar { display: none; }
.chat-empty { padding: 32px 16px; text-align: center; }
.chat-empty-title { font-size: 14px; font-weight: 600; margin-bottom: 6px; }
.chat-empty-copy { font-size: 12px; color: var(--c-text-muted); line-height: 1.6; }
.chat-row { display: flex; margin: 6px 12px; }
.chat-row[data-role="user"] { justify-content: flex-end; }
.chat-bubble {
  max-width: 78%;
  border: 1px solid var(--c-border);
  border-radius: 10px;
  padding: 8px 12px;
  background: var(--c-bg-card);
}
.chat-bubble[data-role="user"] {
  border-color: var(--c-accent-dim);
  background: rgba(94, 204, 255, 0.08);
}
.chat-role { font-size: 10px; color: var(--c-text-muted); margin-bottom: 4px; }
.chat-message-text { font-size: 13px; line-height: 1.6; word-break: break-word; }
.chat-token-usage { margin-top: 6px; font-size: 11px; color: var(--c-text-muted); }
.chat-composer {
  border: 1px solid var(--c-border);
  border-radius: 10px;
  background: var(--c-bg-panel);
  padding: 10px;
}
.chat-composer-input {
  width: 100%;
  box-sizing: border-box;
  background: var(--c-bg-input);
  color: var(--c-text);
  border: 1px solid var(--c-border-mid);
  border-radius: 8px;
  padding: 10px;
  font: inherit;
  font-size: 13px;
  line-height: 1.5;
  resize: vertical;
  min-height: 64px;
  scrollbar-width: none;
  -ms-overflow-style: none;
}
.chat-composer-input::-webkit-scrollbar { display: none; }
.chat-composer-input:focus { outline: none; border-color: var(--c-accent); }
.chat-composer-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  margin-top: 8px;
  flex-wrap: wrap;
}
.chat-composer-hint { font-size: 11px; color: var(--c-text-muted); }
.chat-composer-actions { display: flex; align-items: center; gap: 10px; }
.chat-toggle {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--c-text-sub);
  cursor: pointer;
}
.chat-btn {
  border: 1px solid var(--c-accent);
  background: var(--c-accent);
  color: #06222f;
  border-radius: 8px;
  padding: 6px 16px;
  font-size: 13px;
  cursor: pointer;
}
.chat-btn:disabled { opacity: 0.45; cursor: not-allowed; }
.chat-btn.outline {
  background: transparent;
  color: var(--c-accent);
}
.chat-btn.small { padding: 2px 10px; font-size: 12px; }
.chat-log-section {
  border: 1px solid var(--c-border);
  border-radius: 10px;
  background: var(--c-bg-panel);
}
.chat-log-header {
  width: 100%;
  display: flex;
  justify-content: space-between;
  align-items: center;
  background: none;
  border: none;
  color: var(--c-text-sub);
  font: inherit;
  font-size: 12px;
  padding: 8px 12px;
  cursor: pointer;
}
.chat-log-live { color: var(--c-success); font-size: 11px; }
.chat-log-body {
  max-height: 300px;
  overflow-y: auto;
  border-top: 1px solid var(--c-border);
  padding: 8px 12px;
  scrollbar-width: none;
  -ms-overflow-style: none;
}
.chat-log-body::-webkit-scrollbar { display: none; }
.chat-log-row {
  display: flex;
  gap: 10px;
  padding: 6px 0;
  border-bottom: 1px solid var(--c-border);
  font-size: 12px;
}
.chat-log-row:last-child { border-bottom: none; }
.chat-log-type {
  flex: none;
  width: 130px;
  color: var(--c-accent);
  font-size: 11px;
  word-break: break-all;
}
.chat-log-content { flex: 1; min-width: 0; }
.chat-log-title { font-weight: 600; }
.chat-log-summary { color: var(--c-text-sub); margin-top: 2px; white-space: pre-wrap; }
.chat-log-meta { margin-top: 4px; display: flex; flex-wrap: wrap; gap: 4px; }
.chat-log-meta-chip {
  border: 1px solid var(--c-border-mid);
  border-radius: 999px;
  padding: 0 8px;
  font-size: 11px;
  color: var(--c-text-muted);
}
.chat-log-ops { margin-top: 6px; }
.chat-log-ops-title { font-size: 11px; color: var(--c-text-muted); margin-bottom: 2px; }
.chat-log-op-line { color: var(--c-text-sub); font-size: 11px; }
.chat-log-pre {
  margin: 4px 0 0;
  max-height: 200px;
  overflow: auto;
  font-size: 11px;
  background: rgba(0, 0, 0, 0.25);
  border-radius: 6px;
  padding: 8px;
  white-space: pre-wrap;
  word-break: break-all;
  scrollbar-width: none;
  -ms-overflow-style: none;
}
.chat-log-pre::-webkit-scrollbar { display: none; }
.chat-log-time { flex: none; font-size: 11px; color: var(--c-text-muted); }
.event-confirm-card {
  margin: 6px 12px;
  border: 1px solid rgba(246, 201, 78, 0.4);
  border-radius: 10px;
  background: var(--c-bg-panel);
  padding: 12px;
}
.event-confirm-title { font-size: 13px; font-weight: 600; color: var(--c-warn); }
.event-confirm-sub { font-size: 11px; color: var(--c-text-muted); font-weight: 400; margin-left: 6px; }
.event-confirm-meta {
  margin-top: 6px;
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  font-size: 11px;
  color: var(--c-text-muted);
  font-family: monospace;
}
.event-confirm-rows {
  margin-top: 8px;
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 12px;
}
.event-confirm-row { display: flex; gap: 8px; align-items: baseline; }
.event-confirm-key { flex: none; color: var(--c-text-muted); min-width: 72px; }
.event-confirm-value { color: var(--c-text); word-break: break-all; }
.event-confirm-tech { margin-top: 8px; font-size: 11px; color: var(--c-text-muted); }
.event-confirm-tech summary { cursor: pointer; user-select: none; }
.chat-log-details summary { cursor: pointer; user-select: none; font-size: 11px; color: var(--c-text-muted); }
.event-confirm-payload {
  margin: 8px 0 0;
  max-height: 160px;
  overflow: auto;
  font-size: 11px;
  background: rgba(0, 0, 0, 0.25);
  border-radius: 6px;
  padding: 8px;
  white-space: pre-wrap;
  word-break: break-all;
  scrollbar-width: none;
  -ms-overflow-style: none;
}
.event-confirm-payload::-webkit-scrollbar { display: none; }
.event-confirm-actions { margin-top: 10px; display: flex; gap: 8px; justify-content: flex-end; }
</style>
