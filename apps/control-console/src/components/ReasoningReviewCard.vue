<script setup lang="ts">
import { computed, ref } from 'vue'
import type { ReasoningReview } from '../types/reasoning'
import { extractEvidenceKeyParams } from '../lib/humanize'

const props = defineProps<{
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

// 首屏关键参数（人话 chips）：从 outboundPreview 挑平铺字段，原始负载统一收进「技术细节」
const keyParams = computed(() => extractEvidenceKeyParams(props.evidence))

// 驳回输入框展开状态：默认收起，点击"驳回"时展开
const rejectExpanded = ref(false)

// 智能审核模式提示：根据 action 类型推断审核级别
const reviewModeHint = computed(() => {
  if (props.autoApprove) return '当前为自动直跑模式：运行任务图和步骤不会停在审核框。'
  const action = String(props.review?.action || '')
  if (/export|publish|deploy/i.test(action)) return '当前为强制人工审核：导出/发布前必须人工确认。'
  if (/create|write|update|delete|configure|generate|render|lock/i.test(action)) return '当前为写入前人工审核：写入操作前需要人工确认。'
  if (/compile|validate|check|analyze/i.test(action)) return '当前为自动审核（保留版本）：自动执行但保留版本记录。'
  if (/read|get|list|inspect|search|query/i.test(action)) return '当前为自动审核：只读操作自动通过。'
  return '当前为人工全审模式：运行任务图、执行步骤和最终回答都会进入审核。'
})

function onDraftInput(event: Event) {
  emit('update:draft', (event.target as HTMLTextAreaElement).value)
}

function onRejectClick() {
  if (!rejectExpanded.value) {
    rejectExpanded.value = true
    return
  }
  emit('submit', 'reject')
}

function onApproveClick() {
  rejectExpanded.value = false
  emit('submit', 'approve')
}

function onBackClick() {
  rejectExpanded.value = false
  emit('submit', 'back')
}
</script>

<template>
  <div class="review-card" data-testid="reasoning-review-card">
    <div class="review-card-kind">{{ targetLabel }}</div>
    <div class="review-card-title">{{ review.title }}</div>
    <div class="review-card-summary">{{ review.summary }}</div>
    <div v-if="keyParams.length" class="review-card-params">
      <span v-for="param in keyParams" :key="param.label" class="review-card-param">
        {{ param.label }}: {{ param.value }}
      </span>
    </div>
    <div class="review-card-mode-hint">{{ reviewModeHint }}</div>

    <!-- 技术细节：默认收起 -->
    <details v-if="evidence?.outboundPreview || evidence?.rawResponsePreview || evidence?.structuredResult" class="review-card-tech">
      <summary>技术细节（原始负载）</summary>
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
    </details>

    <!-- 驳回修正条件：默认收起，点击"驳回"时展开 -->
    <details v-if="rejectExpanded" class="review-card-reject-details" open>
      <summary>驳回修正条件</summary>
      <textarea
        :value="draft"
        class="review-card-editor"
        rows="3"
        spellcheck="false"
        placeholder="请填写修正条件，例如：必须调用 project.listStories，不要猜数据库。"
        :disabled="autoApprove || busy"
        @input="onDraftInput"
      />
    </details>

    <div class="review-card-actions">
      <button v-if="canStepBack" class="action-btn outline" :disabled="busy || autoApprove" @click="onBackClick">{{ busy ? '提交中...' : '后退一步' }}</button>
      <button class="action-btn outline" :disabled="busy || autoApprove" @click="onRejectClick">{{ busy ? '提交中...' : rejectLabel }}</button>
      <button class="action-btn" :disabled="busy || autoApprove" @click="onApproveClick">{{ busy ? '提交中...' : approveLabel }}</button>
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
.review-card-params {
  margin-top: 6px;
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.review-card-param {
  border: 1px solid var(--c-border, rgba(255, 255, 255, 0.14));
  border-radius: 999px;
  padding: 1px 10px;
  font-size: 11px;
  color: var(--c-text-muted, rgba(255, 255, 255, 0.65));
  word-break: break-all;
}
.review-card-tech {
  margin-top: 8px;
  font-size: 12px;
  color: var(--c-text-muted, rgba(255, 255, 255, 0.55));
}
.review-card-tech summary { cursor: pointer; user-select: none; }
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
.review-card-reject-details {
  margin-top: 8px;
  font-size: 12px;
  color: var(--c-text-muted, rgba(255, 255, 255, 0.55));
}
.review-card-reject-details summary { cursor: pointer; user-select: none; }
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
