<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { useControlConsoleApp } from '../composables/useControlConsoleApp'
import { getOverview, getBootstrap } from '../services/controlApi'
import { listProjects, getAiCoverage } from '../services/projectApi'

const app = useControlConsoleApp()

const overview = ref<any>(null)
const bootstrap = ref<any>(null)
const overviewBusy = ref(false)
const overviewError = ref('')

// ── 出图总账卡片 ─────────────────────────────────
type CoverageAssetItem = { id: string; name: string; category: string; status: string }
type CoverageSceneItem = { id: string; name: string; status: string }
type CoverageSummary = {
  hasPlan: boolean
  assets: { total: number; locked: number; items: CoverageAssetItem[] }
  scenes: { total: number; bound: number; items: CoverageSceneItem[] }
  overall: { required: number; done: number; remaining: number; percent: number; pendingReviews: number }
}

const CATEGORY_LABELS: Record<string, string> = {
  character: '角色',
  prop: '道具',
  scene_anchor: '场景锚点',
  background: '背景'
}
const ASSET_STATUS_LABELS: Record<string, string> = {
  missing: '缺少图片',
  candidates: '候选待选定',
  selected: '已选定待锁定',
  locked: '已锁定'
}
const SCENE_STATUS_LABELS: Record<string, string> = {
  pending: '待渲染',
  rendered: '已渲染待绑定',
  bound: '已绑定'
}

const coverage = ref<CoverageSummary | null>(null)
const coverageProjectTitle = ref('')
const coverageError = ref('')
const coverageBusy = ref(false)
const gapsExpanded = ref(false)
let coverageProjectId = ''
let coverageTimer: number | undefined

const assetGroups = computed(() => {
  const groups = new Map<string, { key: string; label: string; locked: number; total: number }>()
  for (const item of coverage.value?.assets?.items || []) {
    const key = item.category || 'other'
    if (!groups.has(key)) groups.set(key, { key, label: CATEGORY_LABELS[key] || key, locked: 0, total: 0 })
    const group = groups.get(key)!
    group.total += 1
    if (item.status === 'locked') group.locked += 1
  }
  return [...groups.values()]
})

const gapList = computed(() => {
  const gaps: { key: string; name: string; kindLabel: string; statusLabel: string }[] = []
  for (const item of coverage.value?.assets?.items || []) {
    if (item.status === 'locked') continue
    gaps.push({
      key: `asset:${item.id}`,
      name: item.name || item.id,
      kindLabel: CATEGORY_LABELS[item.category] || '资产',
      statusLabel: ASSET_STATUS_LABELS[item.status] || item.status
    })
  }
  for (const item of coverage.value?.scenes?.items || []) {
    if (item.status === 'bound') continue
    gaps.push({
      key: `scene:${item.id}`,
      name: item.name || item.id,
      kindLabel: '背景',
      statusLabel: SCENE_STATUS_LABELS[item.status] || item.status
    })
  }
  return gaps
})

const visibleGaps = computed(() => (gapsExpanded.value ? gapList.value : gapList.value.slice(0, 5)))

// 项目来源：control-server 项目列表代理中最近更新的项目（控制台暂无「当前故事项目」绑定概念）
async function resolveCoverageProject() {
  const res = await listProjects()
  const payload = await res.json().catch(() => null)
  if (!res.ok || !payload?.ok) throw new Error(payload?.error || `http_${res.status}`)
  const projects = Array.isArray(payload.projects) ? payload.projects : []
  if (!projects.length) throw new Error('项目库暂无项目')
  const sorted = [...projects].sort((a, b) => String(b?.updatedAt || '').localeCompare(String(a?.updatedAt || '')))
  coverageProjectId = String(sorted[0]?.id || '')
  coverageProjectTitle.value = String(sorted[0]?.title || sorted[0]?.id || '')
}

async function loadCoverage() {
  if (coverageBusy.value) return
  coverageBusy.value = true
  try {
    if (!coverageProjectId) await resolveCoverageProject()
    const res = await getAiCoverage(coverageProjectId)
    const payload = await res.json().catch(() => null)
    if (!res.ok || !payload?.ok) throw new Error(payload?.message || payload?.error || `http_${res.status}`)
    coverage.value = payload.coverage || null
    coverageError.value = ''
  } catch (e) {
    coverageProjectId = ''
    coverageError.value = `出图总账读取失败：${e instanceof Error ? e.message : String(e)}`
  } finally {
    coverageBusy.value = false
  }
}

async function loadOverview() {
  overviewBusy.value = true
  overviewError.value = ''
  try {
    const [overviewRes, bootstrapRes] = await Promise.allSettled([getOverview(), getBootstrap()])
    if (overviewRes.status === 'fulfilled' && overviewRes.value.ok) {
      overview.value = await overviewRes.value.json().catch(() => null)
    }
    if (bootstrapRes.status === 'fulfilled' && bootstrapRes.value.ok) {
      bootstrap.value = await bootstrapRes.value.json().catch(() => null)
    }
  } catch (e) {
    overviewError.value = String(e)
  } finally {
    overviewBusy.value = false
  }
}

onMounted(() => {
  app.loadVersions()
  loadOverview()
  loadCoverage()
  coverageTimer = window.setInterval(loadCoverage, 5000)
})

onUnmounted(() => {
  if (coverageTimer !== undefined) window.clearInterval(coverageTimer)
})
</script>

<template>
  <div class="page-dashboard">
    <section class="dashboard-welcome">
      <h2>GameStudio 管理总览</h2>
      <p>在此管理生成工具、本地 Agent、项目、任务与系统配置。</p>
      <div v-if="overviewError" class="error-banner">{{ overviewError }}</div>
    </section>

    <section class="dashboard-help-entry">
      <div class="help-entry-text">
        <span class="help-entry-title">使用帮助</span>
        <span class="help-entry-desc">基础配置、支持功能、问法与测试、注意事项与暂未支持清单</span>
      </div>
      <router-link to="/help" class="card-btn">打开使用帮助</router-link>
    </section>

    <section class="dashboard-grid">
      <div class="dashboard-card" data-tone="info">
        <div class="card-header">
          <span class="card-icon">🧠</span>
          <span class="card-title">Hermes 网关</span>
        </div>
        <div class="card-body">
          <div class="card-status" :data-tone="app.leftBrainRunning.value ? 'success' : 'warn'">
            {{ app.leftBrainRunning.value ? '运行中' : '已停止' }}
          </div>
          <div class="card-detail">
            {{ app.leftBrainSummary.value.providerLabel }} · {{ app.leftBrainSummary.value.modelLabel }}
          </div>
          <div class="card-detail sub">{{ app.leftBrainSummary.value.baseUrlLabel }} · {{ app.leftBrainSummary.value.statusLabel }}</div>
          <div v-if="app.smartStartMessage.value" class="card-progress" :data-busy="app.smartStartBusy.value">
            {{ app.smartStartMessage.value }}
          </div>
        </div>
        <div v-if="!app.leftBrainRunning.value" class="card-actions">
          <div class="card-detail sub">使用右上角「一键启动 Hermes」启动。</div>
        </div>
      </div>

      <div class="dashboard-card" data-tone="info">
        <div class="card-header">
          <span class="card-icon">⚙️</span>
          <span class="card-title">生成工具</span>
        </div>
        <div class="card-body">
          <div class="card-status" :data-tone="app.effectivePreflightReady.value ? 'success' : 'warn'">
            {{ app.effectivePreflightReady.value ? '配置就绪' : '待配置' }}
          </div>
          <div class="card-detail">
            文本：{{ app.leftBrain.value.provider || '-' }} / {{ app.leftBrain.value.model || '-' }}
          </div>
        </div>
        <div class="card-actions">
          <router-link to="/generators" class="card-btn">管理生成工具</router-link>
        </div>
      </div>

      <div class="dashboard-card" data-tone="info">
        <div class="card-header">
          <span class="card-icon">▣</span>
          <span class="card-title">项目</span>
        </div>
        <div class="card-body">
          <div class="card-status" data-tone="info">项目库</div>
          <div class="card-detail">查看、创建与管理 storage/projects 中的互动故事项目。</div>
        </div>
        <div class="card-actions">
          <router-link to="/projects" class="card-btn">打开项目库</router-link>
        </div>
      </div>

      <div class="dashboard-card" data-tone="info">
        <div class="card-header">
          <span class="card-icon">▶</span>
          <span class="card-title">任务与会话</span>
        </div>
        <div class="card-body">
          <div class="card-status" :data-tone="app.reasoningBusy.value ? 'running' : 'info'">
            {{ app.reasoningBusy.value ? '有任务运行中' : '无运行中任务' }}
          </div>
          <div class="card-detail">管理推理 session、生产测试与任务队列。</div>
        </div>
        <div class="card-actions">
          <router-link to="/sessions" class="card-btn">查看会话</router-link>
        </div>
      </div>
    </section>

    <section class="dashboard-section">
      <h3>出图总账</h3>
      <div class="coverage-card">
        <div v-if="coverageError" class="error-banner">{{ coverageError }}</div>
        <template v-if="coverage">
          <div class="coverage-head">
            <span class="coverage-project">项目：{{ coverageProjectTitle || '-' }}</span>
            <span class="coverage-overall">
              总进度 {{ coverage.overall.done }}/{{ coverage.overall.required }} · {{ coverage.overall.percent }}%
            </span>
          </div>
          <div class="coverage-bar">
            <div class="coverage-bar-fill" :style="{ width: `${coverage.overall.percent}%` }"></div>
          </div>
          <div v-if="!coverage.hasPlan" class="coverage-hint">该项目尚未生成资产计划，暂无出图统计。</div>
          <div class="coverage-lines">
            <div v-for="group in assetGroups" :key="group.key" class="coverage-line">
              <span class="coverage-label">{{ group.label }}</span>
              <span class="coverage-value">{{ group.locked }}/{{ group.total }} 已锁定</span>
            </div>
            <div class="coverage-line">
              <span class="coverage-label">背景</span>
              <span class="coverage-value">{{ coverage.scenes.bound }}/{{ coverage.scenes.total }} 已绑定</span>
            </div>
            <div class="coverage-line">
              <span class="coverage-label">待审核</span>
              <span class="coverage-value" :data-warn="coverage.overall.pendingReviews > 0 || null">
                {{ coverage.overall.pendingReviews }} 项
              </span>
            </div>
          </div>
          <div v-if="gapList.length" class="coverage-gaps">
            <div class="coverage-gaps-title">缺口清单（{{ gapList.length }} 项）</div>
            <ul class="coverage-gaps-list">
              <li v-for="gap in visibleGaps" :key="gap.key">
                {{ gap.name }} · {{ gap.kindLabel }} · {{ gap.statusLabel }}
              </li>
            </ul>
            <button v-if="gapList.length > 5" class="coverage-toggle" @click="gapsExpanded = !gapsExpanded">
              {{ gapsExpanded ? '收起' : `展开全部 ${gapList.length} 项` }}
            </button>
          </div>
          <div v-else class="coverage-done">全部图片已完成。</div>
        </template>
        <div v-else-if="!coverageError" class="coverage-hint">正在读取出图总账…</div>
      </div>
    </section>

    <section v-if="overview?.ok" class="dashboard-section">
      <h3>系统模块状态</h3>
      <div class="module-grid">
        <div v-for="(status, key) in overview.modules" :key="key" class="module-card" :data-status="status">
          <div class="module-name">{{ key }}</div>
          <div class="module-status">{{ status }}</div>
        </div>
      </div>
    </section>

    <section v-if="bootstrap?.ok" class="dashboard-section">
      <h3>后续里程碑</h3>
      <ul class="milestone-list">
        <li v-for="(milestone, index) in bootstrap.nextMilestones" :key="index">{{ milestone }}</li>
      </ul>
    </section>

    <section class="dashboard-section">
      <h3>系统信息</h3>
      <div class="info-grid">
        <div class="info-item">
          <span class="info-label">Control Server</span>
          <span class="info-value">{{ app.managerHealth.value?.service || '-' }} {{ app.managerHealth.value?.version || '' }}</span>
        </div>
        <div class="info-item">
          <span class="info-label">当前 Agent</span>
          <span class="info-value">{{ app.selectedAgentLabel.value || app.selectedAgentId.value || '-' }}</span>
        </div>
        <div class="info-item">
          <span class="info-label">Hermes 版本</span>
          <span class="info-value">{{ app.versions.value?.hermesVersion || '-' }}</span>
        </div>
        <div class="info-item">
          <span class="info-label">OMLX 版本</span>
          <span class="info-value">{{ app.versions.value?.omlxVersion || '-' }}</span>
        </div>
      </div>
    </section>
  </div>
</template>

<style scoped>
.page-dashboard {
  display: flex;
  flex-direction: column;
  gap: 24px;
}

.dashboard-welcome h2 {
  margin: 0 0 6px;
  font-size: 22px;
  color: var(--c-text-inv);
}

.dashboard-welcome p {
  margin: 0 0 10px;
  color: var(--c-text-sub);
}

.error-banner {
  margin-top: 10px;
  padding: 10px 12px;
  border-radius: 8px;
  background: rgba(255, 107, 107, 0.14);
  border: 1px solid rgba(255, 107, 107, 0.28);
  color: var(--c-error);
  font-size: 13px;
}

.dashboard-help-entry {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 12px 16px;
  border-radius: 12px;
  background: var(--c-bg-panel);
  border: 1px solid var(--c-border);
}

.help-entry-text {
  display: flex;
  align-items: baseline;
  gap: 10px;
  min-width: 0;
  flex-wrap: wrap;
}

.help-entry-title {
  font-size: 15px;
  font-weight: 700;
  color: var(--c-text-inv);
}

.help-entry-desc {
  font-size: 12px;
  color: var(--c-text-muted);
}

.dashboard-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
  gap: 16px;
}

.dashboard-card {
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding: 16px;
  border-radius: 12px;
  background: var(--c-bg-panel);
  border: 1px solid var(--c-border);
}

.card-header {
  display: flex;
  align-items: center;
  gap: 10px;
}

.card-icon {
  font-size: 20px;
}

.card-title {
  font-weight: 700;
  color: var(--c-text-inv);
}

.card-body {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.card-status {
  font-size: 13px;
  font-weight: 700;
  color: var(--c-text-sub);
}

.card-status[data-tone='success'] { color: var(--c-success); }
.card-status[data-tone='warn'] { color: var(--c-warn); }
.card-status[data-tone='running'] { color: var(--c-accent); }

.card-detail {
  font-size: 13px;
  color: var(--c-text-sub);
  line-height: 1.45;
}

.card-detail.sub {
  margin-top: 2px;
  font-size: 11px;
  color: var(--c-text-muted);
}

.card-progress {
  margin-top: 8px;
  font-size: 12px;
  line-height: 1.5;
  color: var(--c-accent);
  border: 1px solid var(--c-accent-dim);
  background: rgba(94, 204, 255, 0.06);
  border-radius: 8px;
  padding: 6px 10px;
}

.card-progress[data-busy='false'] {
  color: var(--c-text-sub);
}

.card-actions {
  margin-top: auto;
  display: flex;
  gap: 8px;
}

.card-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
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

.card-btn:hover {
  background: rgba(255, 255, 255, 0.1);
}

.card-btn.primary {
  background: var(--c-accent);
  color: #081018;
  border-color: transparent;
}

.dashboard-section h3 {
  margin: 0 0 12px;
  font-size: 16px;
  color: var(--c-text-inv);
}

.module-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
  gap: 10px;
}

.module-card {
  padding: 12px;
  border-radius: 8px;
  background: var(--c-bg-card);
  border: 1px solid var(--c-border);
}

.module-name {
  font-size: 12px;
  color: var(--c-text-muted);
  text-transform: uppercase;
  margin-bottom: 6px;
}

.module-status {
  font-size: 14px;
  font-weight: 700;
  color: var(--c-text);
}

.module-card[data-status='bootstrapped'] .module-status { color: var(--c-success); }
.module-card[data-status='pending'] .module-status { color: var(--c-warn); }

.milestone-list {
  margin: 0;
  padding-left: 20px;
  color: var(--c-text-sub);
  font-size: 14px;
  line-height: 1.8;
}

.info-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: 12px;
}

.info-item {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 12px;
  border-radius: 8px;
  background: var(--c-bg-card);
  border: 1px solid var(--c-border);
}

.info-label {
  font-size: 12px;
  color: var(--c-text-muted);
}

.info-value {
  font-size: 14px;
  color: var(--c-text);
}

.coverage-card {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 16px;
  border-radius: 12px;
  background: var(--c-bg-panel);
  border: 1px solid var(--c-border);
}

.coverage-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
}

.coverage-project {
  font-size: 14px;
  font-weight: 700;
  color: var(--c-text-inv);
}

.coverage-overall {
  font-size: 13px;
  color: var(--c-accent);
  font-weight: 700;
}

.coverage-bar {
  height: 6px;
  border-radius: 3px;
  background: var(--c-bg-card);
  border: 1px solid var(--c-border);
  overflow: hidden;
}

.coverage-bar-fill {
  height: 100%;
  background: var(--c-accent);
  transition: width 0.4s ease;
}

.coverage-hint {
  font-size: 12px;
  color: var(--c-text-muted);
}

.coverage-lines {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.coverage-line {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
  font-size: 13px;
}

.coverage-label {
  color: var(--c-text-muted);
}

.coverage-value {
  color: var(--c-text);
}

.coverage-value[data-warn] {
  color: var(--c-warn);
}

.coverage-gaps-title {
  font-size: 12px;
  color: var(--c-text-muted);
  margin-bottom: 6px;
}

.coverage-gaps-list {
  margin: 0;
  padding-left: 18px;
  font-size: 12px;
  line-height: 1.8;
  color: var(--c-text-sub);
}

.coverage-toggle {
  margin-top: 6px;
  align-self: flex-start;
  padding: 4px 10px;
  border-radius: 6px;
  border: 1px solid var(--c-border-mid);
  background: rgba(255, 255, 255, 0.06);
  color: var(--c-text);
  font: inherit;
  font-size: 12px;
  cursor: pointer;
}

.coverage-toggle:hover {
  background: rgba(255, 255, 255, 0.1);
}

.coverage-done {
  font-size: 12px;
  color: var(--c-success);
}
</style>
