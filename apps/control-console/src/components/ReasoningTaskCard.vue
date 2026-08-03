<script setup lang="ts">
import { computed, ref } from 'vue'
import type { ReasoningSession } from '../types/reasoning'
import { formatDurationSeconds, getReasoningStepStates, getStoryProductionMeta, type ReasoningStepState } from '../lib/reasoning'

const props = defineProps<{
  session: ReasoningSession
  statusLabel: string
  elapsedSeconds: number
}>()

const steps = computed(() => getReasoningStepStates(props.session))
const meta = computed(() => getStoryProductionMeta(props.session))
const goal = computed(() => (props.session.runtimeTaskGraph || props.session.plan)?.goal || '')
const expandedStepIds = ref<Record<string, boolean>>({})

const GAMESTUDIO_SERVER_ORIGIN = 'http://127.0.0.1:1999'

function distLink(distUrl: string) {
  if (!distUrl) return ''
  return distUrl.startsWith('/') ? `${GAMESTUDIO_SERVER_ORIGIN}${distUrl}` : distUrl
}

function toggleStep(stepId: string) {
  expandedStepIds.value = { ...expandedStepIds.value, [stepId]: !expandedStepIds.value[stepId] }
}

function stateIcon(state: ReasoningStepState) {
  switch (state) {
    case 'completed': return '✓'
    case 'failed': return '✗'
    case 'blocked': return '⊘'
    case 'skipped': return '⤼'
    case 'running': return '⟳'
    case 'waiting_review': return '◌'
    default: return '○'
  }
}

function stateLabel(state: ReasoningStepState) {
  switch (state) {
    case 'completed': return '完成'
    case 'failed': return '失败'
    case 'blocked': return '被阻断'
    case 'skipped': return '跳过'
    case 'running': return '执行中'
    case 'waiting_review': return '待审核'
    default: return '待执行'
  }
}
</script>

<template>
  <div class="task-card" data-testid="reasoning-task-card">
    <div class="task-card-header">
      <div class="task-card-title">任务执行链</div>
      <div class="task-card-subtitle">
        {{ statusLabel }} · 总计时 {{ formatDurationSeconds(elapsedSeconds) }}<template v-if="meta.projectId"> · 项目 {{ meta.projectId.slice(0, 8) }}</template>
      </div>
    </div>
    <div v-if="goal" class="task-card-goal">{{ goal }}</div>
    <div v-if="meta.fallback" class="task-card-fallback-badge">
      ⚠ 脚本候选使用了确定性兜底（{{ meta.fallbackReason || 'fallback' }}），非模型真实生成
    </div>
    <div class="task-card-steps">
      <div
        v-for="step in steps"
        :key="step.stepId"
        class="task-step"
        :data-state="step.state"
      >
        <button class="task-step-main" type="button" @click="toggleStep(step.stepId)">
          <span class="task-step-icon" :data-state="step.state">{{ stateIcon(step.state) }}</span>
          <span class="task-step-title">{{ step.title }}</span>
          <span class="task-step-chip">{{ step.action }}</span>
          <span class="task-step-state-label" :data-state="step.state">{{ stateLabel(step.state) }}</span>
        </button>
        <div v-if="step.summary" class="task-step-summary">{{ step.summary }}</div>
        <div v-if="expandedStepIds[step.stepId]" class="task-step-evidence">
          <div v-if="step.evaluatorName" class="task-step-evidence-line">
            evaluator: {{ step.evaluatorName }}
            · {{ step.evaluatorPassed === null ? '未判定' : step.evaluatorPassed ? '通过' : '未通过' }}<template v-if="step.evaluatorScore !== null"> · 分数 {{ step.evaluatorScore }}</template>
          </div>
          <div v-if="step.reviewProvider" class="task-step-evidence-line">评审路由: {{ step.reviewProvider }}</div>
          <div v-if="step.failedStage" class="task-step-evidence-line warn">失败阶段: {{ step.failedStage }}</div>
          <div v-if="step.evidenceFiles.length" class="task-step-evidence-line">项目文件证据: {{ step.evidenceFiles.join(', ') }}</div>
          <div v-if="step.distExists" class="task-step-evidence-line ok">
            dist 产物已存在（磁盘事实）<a v-if="step.distUrl" class="task-step-dist-link" :href="distLink(step.distUrl)" target="_blank" rel="noopener">打开可玩地址 ↗</a>
          </div>
          <div v-if="!step.evaluatorName && !step.evidenceFiles.length && !step.failedStage" class="task-step-evidence-line">该步骤暂无 evaluator 与证据快照。</div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.task-card {
  margin: 8px 12px;
  border: 1px solid var(--c-border, rgba(94, 204, 255, 0.25));
  border-radius: 10px;
  background: var(--c-bg-elevated, rgba(255, 255, 255, 0.03));
  padding: 10px 12px;
}
.task-card-header {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
}
.task-card-title {
  font-weight: 600;
  color: var(--c-accent, #5eccff);
  font-size: 13px;
}
.task-card-subtitle {
  font-size: 12px;
  color: var(--c-text-muted, rgba(255, 255, 255, 0.55));
}
.task-card-goal {
  margin-top: 6px;
  font-size: 12px;
  color: var(--c-text-muted, rgba(255, 255, 255, 0.6));
}
.task-card-fallback-badge {
  margin-top: 8px;
  font-size: 12px;
  color: #ff9d9d;
  border: 1px solid rgba(255, 120, 120, 0.4);
  border-radius: 6px;
  padding: 4px 8px;
}
.task-card-steps {
  margin-top: 8px;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.task-step {
  border-radius: 8px;
  padding: 2px 4px;
}
.task-step[data-state="failed"] {
  background: rgba(255, 100, 100, 0.06);
}
.task-step[data-state="waiting_review"] {
  background: rgba(94, 204, 255, 0.07);
}
.task-step-main {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  background: none;
  border: none;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
  padding: 4px 2px;
}
.task-step-icon {
  width: 18px;
  text-align: center;
  flex: none;
}
.task-step-icon[data-state="completed"] { color: var(--c-success-dim, #4ade80); }
.task-step-icon[data-state="failed"] { color: #ff8a8a; }
.task-step-icon[data-state="blocked"] { color: var(--c-text-muted, rgba(255, 255, 255, 0.45)); }
.task-step-icon[data-state="running"] { color: var(--c-accent, #5eccff); }
.task-step-icon[data-state="waiting_review"] { color: var(--c-accent, #5eccff); }
.task-step-title {
  font-size: 13px;
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.task-step-chip {
  font-size: 11px;
  color: var(--c-text-muted, rgba(255, 255, 255, 0.45));
  border: 1px solid var(--c-border, rgba(255, 255, 255, 0.12));
  border-radius: 999px;
  padding: 1px 8px;
  flex: none;
}
.task-step-state-label {
  font-size: 11px;
  flex: none;
  color: var(--c-text-muted, rgba(255, 255, 255, 0.5));
}
.task-step-state-label[data-state="failed"] { color: #ff8a8a; }
.task-step-state-label[data-state="waiting_review"] { color: var(--c-accent, #5eccff); }
.task-step-state-label[data-state="completed"] { color: var(--c-success-dim, #4ade80); }
.task-step-summary {
  margin: 0 0 4px 26px;
  font-size: 12px;
  color: var(--c-text-muted, rgba(255, 255, 255, 0.55));
}
.task-step-evidence {
  margin: 2px 0 6px 26px;
  font-size: 12px;
  border-left: 2px solid var(--c-border, rgba(94, 204, 255, 0.25));
  padding: 4px 8px;
  display: flex;
  flex-direction: column;
  gap: 3px;
}
.task-step-evidence-line {
  color: var(--c-text-muted, rgba(255, 255, 255, 0.6));
  word-break: break-all;
}
.task-step-evidence-line.ok { color: var(--c-success-dim, #4ade80); }
.task-step-evidence-line.warn { color: #ffb26b; }
.task-step-dist-link {
  margin-left: 8px;
  color: var(--c-accent, #5eccff);
  text-decoration: none;
}
.task-step-dist-link:hover { text-decoration: underline; }
</style>
