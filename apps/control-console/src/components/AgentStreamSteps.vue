<script setup lang="ts">
import type { AgentStreamAction, AgentStreamStep } from '../types/agentStream'

// agent 流式咨询的步骤区：每个 STEP 一张卡——「💭 思考（可展开）」→「⚙ 动作：动作名 + 目标」→「结果」。
// 只渲染人话摘要与关键字段；原始负载一律不进本组件（server 桥已做摘要化）。
const props = defineProps<{
  steps: AgentStreamStep[]
  answerDraft: string
  active: boolean
}>()

function isLatestStep(step: AgentStreamStep) {
  return props.steps.length > 0 && props.steps[props.steps.length - 1].stepIndex === step.stepIndex
}

function actionIcon(action: AgentStreamAction) {
  switch (action.status) {
    case 'running': return '⟳'
    case 'done': return '✓'
    case 'blocked': return '⊘'
    default: return '✗'
  }
}

function actionStatusLabel(action: AgentStreamAction) {
  switch (action.status) {
    case 'running': return '执行中'
    case 'done': return '完成'
    case 'blocked': return '已拦截'
    default: return '失败'
  }
}
</script>

<template>
  <div class="agent-stream" data-testid="agent-stream-steps">
    <div class="agent-stream-header">
      <span class="agent-stream-title">agent 流式咨询</span>
      <span v-if="active" class="agent-stream-live">● 边想边做中</span>
    </div>
    <div v-for="step in steps" :key="step.stepIndex" class="agent-step">
      <div class="agent-step-badge">STEP {{ step.stepIndex }}</div>
      <details v-if="step.thinking.length" class="agent-thinking" :open="isLatestStep(step)">
        <summary>
          💭 思考{{ isLatestStep(step) && active ? '中…' : '' }}
          <span class="agent-thinking-count">{{ step.thinking.length }} 段</span>
        </summary>
        <div class="agent-thinking-body">
          <div v-for="(text, i) in step.thinking" :key="i" class="agent-thinking-text">{{ text }}</div>
        </div>
      </details>
      <div
        v-for="action in step.actions"
        :key="action.actionId"
        class="agent-action"
        :data-status="action.status"
      >
        <span class="agent-action-icon" :data-status="action.status">{{ actionIcon(action) }}</span>
        <span class="agent-action-label">⚙ {{ action.actionLabel }}</span>
        <span v-if="action.target" class="agent-action-target">{{ action.target }}</span>
        <span class="agent-action-status" :data-status="action.status">{{ actionStatusLabel(action) }}</span>
        <div v-if="action.error" class="agent-action-error">{{ action.error }}</div>
      </div>
    </div>
    <div v-if="answerDraft" class="agent-answer-draft">
      <div class="agent-answer-title">✍ 正在组织回答</div>
      <div class="agent-answer-text">{{ answerDraft }}</div>
    </div>
  </div>
</template>

<style scoped>
.agent-stream {
  margin: 8px 12px;
  border: 1px solid var(--c-border, rgba(94, 204, 255, 0.25));
  border-radius: 10px;
  background: var(--c-bg-elevated, rgba(255, 255, 255, 0.03));
  padding: 10px 12px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.agent-stream-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.agent-stream-title {
  font-weight: 600;
  color: var(--c-accent, #5eccff);
  font-size: 13px;
}
.agent-stream-live { color: var(--c-success, #4ade80); font-size: 11px; }
.agent-step {
  border: 1px solid var(--c-border, rgba(255, 255, 255, 0.1));
  border-radius: 8px;
  padding: 8px 10px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.agent-step-badge {
  font-size: 11px;
  font-weight: 600;
  color: var(--c-text-muted, rgba(255, 255, 255, 0.5));
  letter-spacing: 0.04em;
}
.agent-thinking summary {
  cursor: pointer;
  font-size: 12px;
  color: var(--c-text-sub, rgba(255, 255, 255, 0.75));
  user-select: none;
}
.agent-thinking-count {
  margin-left: 6px;
  font-size: 11px;
  color: var(--c-text-muted, rgba(255, 255, 255, 0.45));
}
.agent-thinking-body {
  margin-top: 6px;
  display: flex;
  flex-direction: column;
  gap: 4px;
  max-height: 220px;
  overflow-y: auto;
}
.agent-thinking-text {
  font-size: 12px;
  color: var(--c-text-sub, rgba(255, 255, 255, 0.75));
  white-space: pre-wrap;
  word-break: break-word;
  border-left: 2px solid var(--c-border, rgba(94, 204, 255, 0.25));
  padding-left: 8px;
}
.agent-action {
  display: flex;
  align-items: baseline;
  gap: 8px;
  flex-wrap: wrap;
  font-size: 12px;
}
.agent-action-icon { width: 16px; text-align: center; flex: none; }
.agent-action-icon[data-status='done'] { color: var(--c-success-dim, #4ade80); }
.agent-action-icon[data-status='failed'] { color: #ff8a8a; }
.agent-action-icon[data-status='blocked'] { color: var(--c-warn, #f6c94e); }
.agent-action-icon[data-status='running'] { color: var(--c-accent, #5eccff); }
.agent-action-label { color: var(--c-text, #fff); }
.agent-action-target {
  color: var(--c-text-muted, rgba(255, 255, 255, 0.55));
  word-break: break-all;
  min-width: 0;
  flex: 1;
}
.agent-action-status { flex: none; font-size: 11px; color: var(--c-text-muted, rgba(255, 255, 255, 0.5)); }
.agent-action-status[data-status='done'] { color: var(--c-success-dim, #4ade80); }
.agent-action-status[data-status='failed'] { color: #ff8a8a; }
.agent-action-status[data-status='blocked'] { color: var(--c-warn, #f6c94e); }
.agent-action[data-status='blocked'] {
  border: 1px solid rgba(246, 201, 78, 0.35);
  border-radius: 6px;
  padding: 4px 6px;
}
.agent-action-error {
  width: 100%;
  font-size: 11px;
  color: var(--c-warn, #f6c94e);
}
.agent-answer-draft {
  border: 1px solid var(--c-accent-dim, rgba(94, 204, 255, 0.35));
  border-radius: 8px;
  padding: 8px 10px;
  background: rgba(94, 204, 255, 0.05);
}
.agent-answer-title { font-size: 11px; color: var(--c-accent, #5eccff); margin-bottom: 4px; }
.agent-answer-text {
  font-size: 13px;
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 260px;
  overflow-y: auto;
}
</style>
