<script setup lang="ts">
import { onMounted } from 'vue'
import { useControlConsoleAppContext } from '../composables/useControlConsoleAppContext'

const {
  skillProposalsList,
  skillIntentsActive,
  skillProposalGovernance,
  skillProposalsBusy,
  skillProposalsError,
  skillProposalsScanMessage,
  skillProposalsActionBusy,
  loadSkillProposals,
  scanSkillProposals,
  testSkillProposal,
  reviewSkillProposal,
  promoteSkillProposal,
  rejectSkillProposal,
  rollbackSkillIntent,
  deactivateSkillIntent,
} = useControlConsoleAppContext<any>()

onMounted(() => {
  loadSkillProposals()
})

function isBusyForAction(prefix: string, id: string): boolean {
  return skillProposalsActionBusy.value === `${prefix}:${id}`
}

// AUTO-F02：proposal 治理状态（candidate/tested/approved/active/rejected/rolled_back）
const GOVERNANCE_STATUS_LABELS: Record<string, string> = {
  candidate: '候选·未测试',
  tested: '已测试·待审核',
  approved: '已审核·待激活',
  active: '已激活',
  rejected: '已驳回',
  rolled_back: '已回滚',
}

function governanceOf(id: string): any {
  return skillProposalGovernance.value.find((entry: any) => entry.id === id) || null
}

function governanceStatusOf(id: string): string {
  return governanceOf(id)?.status || 'candidate'
}

function governanceLabelOf(id: string): string {
  return GOVERNANCE_STATUS_LABELS[governanceStatusOf(id)] || governanceStatusOf(id)
}

function summarizeMatch(def: any): string {
  if (!def?.match) return '—'
  const groups: string[] = []
  if (Array.isArray(def.match.anyRegex) && def.match.anyRegex.length) groups.push(`anyRegex: ${def.match.anyRegex.join(' | ')}`)
  if (Array.isArray(def.match.allRegex) && def.match.allRegex.length) groups.push(`allRegex: ${def.match.allRegex.join(' & ')}`)
  if (Array.isArray(def.match.noneRegex) && def.match.noneRegex.length) groups.push(`noneRegex: ${def.match.noneRegex.join(' , ')}`)
  return groups.join('；') || '—'
}

function summarizeEvaluation(def: any): string {
  const ev = def?.evaluation
  if (!ev) return '无评估配置'
  const parts: string[] = [`minScore=${ev.minScore ?? 70}`]
  if (Array.isArray(ev.mustInclude) && ev.mustInclude.length) parts.push(`mustInclude=${ev.mustInclude.length}`)
  if (Array.isArray(ev.forbidden) && ev.forbidden.length) parts.push(`forbidden=${ev.forbidden.length}`)
  if (Array.isArray(ev.evidenceRegex) && ev.evidenceRegex.length) parts.push(`evidence=${ev.evidenceRegex.length}`)
  return parts.join(' · ')
}
</script>

<template>
  <div class="chat-memory-panel skill-proposals-panel">
    <div class="chat-memory-header-row">
      <div>
        <div class="chat-memory-title">智能体技能提案 (Skill Intent Proposals)</div>
        <div class="chat-memory-desc">
          基于 <code>state/agent-runtime-review-records.jsonl</code> 中重复出现的人工纠偏，自动生成纯数据型 intent 提案。
          提案落在 <code>config/hermes/intents/_inbox/</code>，默认不可执行；必须依次通过 测试门禁 → 人工审核 → 人工激活 才会生效，
          每次激活保留版本快照，可回滚到上一版本，全程留审计。
        </div>
      </div>
      <div class="chat-memory-actions">
        <button class="action-btn outline" :disabled="skillProposalsBusy" @click="loadSkillProposals">
          {{ skillProposalsBusy ? '刷新中...' : '🔄 刷新' }}
        </button>
        <button class="action-btn" :disabled="skillProposalsBusy" @click="scanSkillProposals(2)">
          {{ skillProposalsBusy ? '扫描中...' : '🛰 扫描审阅记录' }}
        </button>
      </div>
    </div>

    <div v-if="skillProposalsScanMessage" class="chat-memory-meta" style="color: var(--c-accent);">{{ skillProposalsScanMessage }}</div>
    <div v-if="skillProposalsError" class="text-error" style="font-size: 12px;">{{ skillProposalsError }}</div>

    <section class="skill-proposals-section">
      <header class="skill-proposals-section-header">
        <span class="skill-proposals-section-title">📥 待审提案 (_inbox)</span>
        <span class="chat-memory-meta">{{ skillProposalsList.length }} 条</span>
      </header>
      <div v-if="skillProposalsList.length === 0" class="chat-memory-desc">暂无待审提案。点击「扫描审阅记录」可基于历史人工纠偏生成新的提案。</div>
      <div v-else class="submit-source-list">
        <div v-for="proposal in skillProposalsList" :key="proposal.id" class="submit-source-item skill-proposal-card">
          <div class="submit-source-item-header" style="align-items: flex-start; gap: 12px;">
            <div style="display: flex; flex-direction: column; gap: 4px; flex: 1; min-width: 0;">
              <span style="display: flex; align-items: center; gap: 8px; flex-wrap: wrap;">
                <strong>{{ proposal.id }}</strong>
                <span class="reasoning-plan-step-chip">{{ governanceLabelOf(proposal.id) }}</span>
                <span v-if="governanceOf(proposal.id)?.lastTest" class="chat-memory-meta">
                  测试：{{ governanceOf(proposal.id).lastTest.passed ? '通过' : '未通过' }}
                </span>
              </span>
              <span class="chat-memory-desc">{{ proposal.def?.description || '（无描述）' }}</span>
              <span class="chat-memory-meta">匹配规则：{{ summarizeMatch(proposal.def) }}</span>
              <span class="chat-memory-meta">评估配置：{{ summarizeEvaluation(proposal.def) }}</span>
              <span class="chat-memory-meta" v-if="proposal.def?.provenance?.occurrence">
                复现次数：{{ proposal.def.provenance.occurrence }} ·
                生成时间：{{ proposal.def.provenance.generatedAt }}
              </span>
              <details v-if="proposal.def?.provenance?.sampleUserPrompts?.length" class="skill-proposal-samples">
                <summary>示例触发问题（{{ proposal.def.provenance.sampleUserPrompts.length }} 条）</summary>
                <ul>
                  <li v-for="(sample, index) in proposal.def.provenance.sampleUserPrompts" :key="index">{{ sample }}</li>
                </ul>
              </details>
              <details v-if="proposal.def?.evaluation?.correctionPrompt" class="skill-proposal-samples">
                <summary>修正提示词</summary>
                <pre class="reasoning-evidence-pre">{{ proposal.def.evaluation.correctionPrompt }}</pre>
              </details>
              <span v-if="proposal.error" class="text-error" style="font-size: 12px;">载入失败：{{ proposal.error }}</span>
            </div>
            <div style="display: flex; flex-direction: column; gap: 6px;">
              <button
                class="action-btn outline"
                :disabled="!!skillProposalsActionBusy || !!proposal.error"
                @click="testSkillProposal(proposal.id)"
              >
                {{ isBusyForAction('test', proposal.id) ? '测试中...' : '🧪 测试门禁' }}
              </button>
              <button
                class="action-btn outline"
                :disabled="!!skillProposalsActionBusy || !!proposal.error || governanceStatusOf(proposal.id) !== 'tested'"
                @click="reviewSkillProposal(proposal.id, 'approve')"
              >
                {{ isBusyForAction('review', proposal.id) ? '审核中...' : '✔️ 审核通过' }}
              </button>
              <button
                class="action-btn"
                :disabled="!!skillProposalsActionBusy || !!proposal.error || governanceStatusOf(proposal.id) !== 'approved'"
                @click="promoteSkillProposal(proposal.id)"
              >
                {{ isBusyForAction('promote', proposal.id) ? '激活中...' : '✅ 晋级激活' }}
              </button>
              <button
                class="action-btn outline"
                :disabled="!!skillProposalsActionBusy"
                @click="rejectSkillProposal(proposal.id)"
              >
                {{ isBusyForAction('reject', proposal.id) ? '驳回中...' : '🗑 驳回' }}
              </button>
            </div>
          </div>
        </div>
      </div>
    </section>

    <section class="skill-proposals-section">
      <header class="skill-proposals-section-header">
        <span class="skill-proposals-section-title">⚙️ 已激活 Intents</span>
        <span class="chat-memory-meta">{{ skillIntentsActive.length }} 个</span>
      </header>
      <div v-if="skillIntentsActive.length === 0" class="chat-memory-desc">暂无已注册的 intent。</div>
      <div v-else class="submit-source-list">
        <div v-for="intent in skillIntentsActive" :key="intent.id" class="submit-source-item skill-intent-card">
          <div class="submit-source-item-header" style="align-items: flex-start; gap: 12px;">
            <div style="display: flex; flex-direction: column; gap: 4px; flex: 1; min-width: 0;">
              <span style="display: flex; align-items: center; gap: 8px; flex-wrap: wrap;">
                <strong>{{ intent.id }}</strong>
                <span class="reasoning-plan-step-chip">{{ intent.source }}</span>
                <span v-if="intent.hasMatchPlan" class="reasoning-plan-step-chip">plan</span>
                <span v-if="intent.hasMatchAnswer" class="reasoning-plan-step-chip">answer</span>
                <span v-if="intent.hasMatchEvaluation" class="reasoning-plan-step-chip">evaluation</span>
                <span v-if="governanceOf(intent.id)" class="reasoning-plan-step-chip">
                  v{{ governanceOf(intent.id).currentVersion }} · 版本 {{ governanceOf(intent.id).versionCount }} 条
                </span>
              </span>
              <span v-if="intent.description" class="chat-memory-desc">{{ intent.description }}</span>
            </div>
            <div v-if="intent.source !== 'builtin'" style="display: flex; flex-direction: column; gap: 6px;">
              <button
                class="action-btn outline"
                :disabled="!!skillProposalsActionBusy || !governanceOf(intent.id) || governanceOf(intent.id).status !== 'active'"
                @click="rollbackSkillIntent(intent.id)"
              >
                {{ isBusyForAction('rollback', intent.id) ? '回滚中...' : '↩️ 回滚' }}
              </button>
              <button
                class="action-btn outline"
                :disabled="!!skillProposalsActionBusy"
                @click="deactivateSkillIntent(intent.id)"
              >
                {{ isBusyForAction('deactivate', intent.id) ? '下线中...' : '⛔️ 下线' }}
              </button>
            </div>
            <div v-else class="chat-memory-meta" style="align-self: center;">内置·不可下线</div>
          </div>
        </div>
      </div>
    </section>
  </div>
</template>

<style scoped>
.skill-proposals-panel { gap: 12px; }
.skill-proposals-section { display: flex; flex-direction: column; gap: 8px; padding: 10px; border: 1px solid rgba(255,255,255,0.06); border-radius: 8px; background: rgba(0,0,0,0.18); }
.skill-proposals-section-header { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.skill-proposals-section-title { font-size: 13px; font-weight: 700; color: var(--c-text); letter-spacing: 0.04em; }
.skill-proposal-card { border-color: rgba(94,204,255,0.18); }
.skill-intent-card { border-color: rgba(124,252,154,0.16); }
.skill-proposal-samples { font-size: 12px; color: var(--c-text-sub); }
.skill-proposal-samples summary { cursor: pointer; color: var(--c-accent); }
.skill-proposal-samples ul { margin: 6px 0 0; padding-left: 18px; }
.skill-proposal-samples pre { margin-top: 6px; }
</style>
