<script setup lang="ts">
import type { ReasoningReview } from '../types/reasoning'

defineProps<{
  review: ReasoningReview
  targetLabel: string
  busy: boolean
  autoApprove: boolean
  approveLabel: string
  rejectLabel: string
  canStepBack: boolean
  evidence: ReasoningReview['evidence']
  draft: string
  formatEvidence: (value: unknown) => string
}>()

const emit = defineEmits<{
  (e: 'submit', decision: 'approve' | 'reject' | 'back'): void
  (e: 'update:draft', value: string): void
}>()

function onDraftInput(event: Event) {
  emit('update:draft', (event.target as HTMLTextAreaElement).value)
}
</script>

<template>
  <div class="review-card" data-testid="reasoning-review-card">
    <div class="review-card-kind">{{ targetLabel }}</div>
    <div class="review-card-title">{{ review.title }}</div>
    <div class="review-card-summary">{{ review.summary }}</div>
    <div class="review-card-mode-hint">{{ autoApprove ? '当前为自动直跑模式：运行任务图和步骤不会停在审核框。' : '当前为人工全审模式：运行任务图、执行步骤和最终回答都会进入审核。' }}</div>
    <div v-if="evidence?.outboundPreview" class="review-card-evidence">
      <div class="review-card-evidence-title">本轮提交流程</div>
      <pre class="review-card-evidence-pre">{{ formatEvidence(evidence.outboundPreview) }}</pre>
    </div>
    <div v-if="evidence?.rawResponsePreview" class="review-card-evidence">
      <div class="review-card-evidence-title">模型首先返回的结果</div>
      <pre class="review-card-evidence-pre">{{ evidence.rawResponsePreview }}</pre>
    </div>
    <div v-if="evidence?.structuredResult" class="review-card-evidence">
      <div class="review-card-evidence-title">结构化结果摘要</div>
      <pre class="review-card-evidence-pre">{{ formatEvidence(evidence.structuredResult) }}</pre>
    </div>
    <textarea
      :value="draft"
      class="review-card-editor"
      rows="4"
      spellcheck="false"
      placeholder="驳回时填写修正条件，例如：必须调用 project.listStories，不要猜数据库。"
      :disabled="autoApprove || busy"
      @input="onDraftInput"
    />
    <div class="review-card-actions">
      <button v-if="canStepBack" class="action-btn outline" :disabled="busy || autoApprove" @click="emit('submit', 'back')">{{ busy ? '提交中...' : '后退一步' }}</button>
      <button class="action-btn outline" :disabled="busy || autoApprove" @click="emit('submit', 'reject')">{{ busy ? '提交中...' : rejectLabel }}</button>
      <button class="action-btn" :disabled="busy || autoApprove" @click="emit('submit', 'approve')">{{ busy ? '提交中...' : approveLabel }}</button>
    </div>
  </div>
</template>

<style scoped>
.review-card {
  margin: 8px 12px;
  border: 1px solid var(--c-accent, #5eccff);
  border-radius: 10px;
  background: rgba(94, 204, 255, 0.05);
  padding: 10px 12px;
}
.review-card-kind {
  font-size: 12px;
  color: var(--c-accent, #5eccff);
  font-weight: 600;
}
.review-card-title {
  margin-top: 4px;
  font-size: 14px;
  font-weight: 600;
}
.review-card-summary {
  margin-top: 4px;
  font-size: 12px;
  color: var(--c-text-muted, rgba(255, 255, 255, 0.65));
  white-space: pre-wrap;
}
.review-card-mode-hint {
  margin: 8px 0;
  font-size: 12px;
  color: var(--c-text-muted, rgba(255, 255, 255, 0.5));
}
.review-card-evidence {
  margin-top: 8px;
}
.review-card-evidence-title {
  font-size: 12px;
  color: var(--c-text-muted, rgba(255, 255, 255, 0.55));
  margin-bottom: 4px;
}
.review-card-evidence-pre {
  margin: 0;
  max-height: 200px;
  overflow: auto;
  font-size: 11px;
  background: rgba(0, 0, 0, 0.25);
  border-radius: 6px;
  padding: 8px;
  white-space: pre-wrap;
  word-break: break-all;
}
.review-card-editor {
  margin-top: 8px;
  width: 100%;
  box-sizing: border-box;
  background: rgba(0, 0, 0, 0.25);
  color: inherit;
  border: 1px solid var(--c-border, rgba(255, 255, 255, 0.14));
  border-radius: 8px;
  padding: 8px;
  font: inherit;
  font-size: 12px;
  resize: vertical;
}
.review-card-actions {
  margin-top: 8px;
  display: flex;
  gap: 8px;
  justify-content: flex-end;
}
</style>
