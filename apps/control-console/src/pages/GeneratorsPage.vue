<script setup lang="ts">
import { onMounted } from 'vue'
import { useControlConsoleApp } from '../composables/useControlConsoleApp'

const app = useControlConsoleApp()

const providers = [
  { value: 'omlx', label: 'OMLX（本地）' },
  { value: 'ollama', label: 'Ollama（本地）' },
  { value: 'openai', label: 'OpenAI（云端）' },
  { value: 'doubao', label: '豆包（云端）' }
]

onMounted(() => {
  app.loadEngineConfig()
  app.loadHermesSelfCheck()
  app.fetchLocalModels('left')
  app.fetchLocalModels('right')
})
</script>

<template>
  <div class="page-generators">
    <section class="page-section">
      <div class="section-header">
        <h2>文本生成模型（左脑）</h2>
        <span class="section-status" :data-tone="app.leftBrainRunning.value ? 'success' : 'warn'">
          {{ app.leftBrainRunning.value ? '运行中' : '已停止' }}
        </span>
      </div>
      <p class="section-hint">配置 OMLX / Ollama / OpenAI / 豆包等文本模型 provider、加载/卸载模型、执行预检。</p>

      <div class="config-form">
        <div class="form-row">
          <div class="form-group">
            <label>Provider</label>
            <select v-model="app.leftBrain.value.provider" @change="app.handleProviderChange('left')">
              <option v-for="p in providers" :key="p.value" :value="p.value">{{ p.label }}</option>
            </select>
          </div>
          <div class="form-group flex-2">
            <label>Base URL</label>
            <input v-model="app.leftBrain.value.baseUrl" type="text" placeholder="http://127.0.0.1:18888/v1" />
          </div>
        </div>

        <div class="form-row">
          <div class="form-group flex-2">
            <label>模型</label>
            <select v-model="app.leftBrain.value.model" @change="app.handleModelChange('left')">
              <option value="">请选择模型</option>
              <option v-for="m in app.availableLeftModels.value" :key="m.id" :value="m.id">{{ m.id }}</option>
            </select>
          </div>
          <div class="form-group">
            <label>上下文长度</label>
            <input v-model="app.leftBrain.value.contextLength" type="number" placeholder="自动探测" />
          </div>
        </div>

        <div v-if="app.leftBrainBlockedReason.value && !app.leftBrainRunning.value" class="blocked-hint">
          ⚠ {{ app.leftBrainBlockedReason.value }}
        </div>

        <div v-if="app.leftInspection.value?.model" class="inspection-card">
          <div class="inspection-title">探测结果</div>
          <div class="inspection-row">
            <span>状态</span>
            <span :data-tone="app.leftInspection.value.accessible ? 'success' : 'error'">
              {{ app.leftInspection.value.accessible ? '可访问' : '不可访问' }}
            </span>
          </div>
          <div class="inspection-row">
            <span>已加载</span>
            <span>{{ app.leftInspection.value.loaded ? '是' : '否' }}</span>
          </div>
          <div class="inspection-row">
            <span>详情</span>
            <span>{{ app.leftInspection.value.detail || '-' }}</span>
          </div>
        </div>

        <div class="action-bar">
          <button class="action-btn primary" :disabled="app.configSaving.value" @click="app.saveLeftBrainConfig">
            {{ app.configSaving.value ? '保存中...' : '💾 保存配置' }}
          </button>
          <button class="action-btn" :disabled="!app.leftBrain.value.model || app.fetchingLeft.value || app.inspectingLeft.value || app.leftBrainRunning.value" @click="app.actOnModel('left', 'load')">
            ➕ 加载模型
          </button>
          <button class="action-btn" :disabled="!app.leftBrain.value.model || app.fetchingLeft.value || app.inspectingLeft.value || !app.leftBrainRunning.value" @click="app.actOnModel('left', 'unload')">
            ➖ 卸载模型
          </button>
          <button class="action-btn" :disabled="!app.leftBrain.value.model || app.fetchingLeft.value || app.inspectingLeft.value" @click="app.inspectSelectedModel('left')">
            {{ app.inspectingLeft.value ? '探测中...' : '🔎 探测' }}
          </button>
          <button class="action-btn" :disabled="app.preflightBusy.value" @click="app.runLeftBrainPreflight">
            {{ app.preflightBusy.value ? '预检中...' : '运行预检' }}
          </button>
        </div>

        <div v-if="app.configSaveMessage.value" class="message-tip">{{ app.configSaveMessage.value }}</div>
        <div v-if="app.configSaveError.value" class="message-error">{{ app.configSaveError.value }}</div>
        <div v-if="app.modelSwitchMessage.value" class="message-tip">{{ app.modelSwitchMessage.value }}</div>
      </div>
    </section>

    <section class="page-section">
      <div class="section-header">
        <h2>图片生成模型</h2>
        <span class="section-status" data-tone="info">配置中</span>
      </div>
      <p class="section-hint">配置 ComfyUI / SD-WebUI / 豆包等图片 provider，执行 preflight，查看节点与模型就绪状态。</p>

      <div class="config-form">
        <div class="form-row">
          <div class="form-group">
            <label>Provider</label>
            <select>
              <option value="comfyui">ComfyUI（本地）</option>
              <option value="sdwebui">SD-WebUI（本地）</option>
              <option value="doubao">豆包（云端）</option>
            </select>
          </div>
          <div class="form-group flex-2">
            <label>Base URL</label>
            <input type="text" value="http://127.0.0.1:8188" />
          </div>
        </div>
        <div class="action-bar">
          <button class="action-btn" @click="app.loadHermesSelfCheck()">刷新自检</button>
        </div>
      </div>
    </section>

    <section class="page-section">
      <div class="section-header">
        <h2>右脑监督模型</h2>
        <span class="section-status" :data-tone="app.rightBrainEnabled.value ? 'success' : 'muted'">
          {{ app.rightBrainEnabled.value ? '已启用' : '未启用' }}
        </span>
      </div>
      <p class="section-hint">右脑（Kimi/云端模型）用于元分析与监督评估，不直接参与实时推理。</p>

      <div class="config-form">
        <div class="form-row">
          <div class="form-group">
            <label class="checkbox-label">
              <input v-model="app.rightBrainEnabled.value" type="checkbox" />
              启用右脑
            </label>
          </div>
        </div>
        <div class="form-row">
          <div class="form-group">
            <label>Provider</label>
            <select v-model="app.rightBrain.value.provider" @change="app.handleProviderChange('right')" :disabled="!app.rightBrainEnabled.value">
              <option value="omlx">OMLX</option>
              <option value="ollama">Ollama</option>
              <option value="moonshot">Moonshot</option>
            </select>
          </div>
          <div class="form-group flex-2">
            <label>Base URL</label>
            <input v-model="app.rightBrain.value.baseUrl" type="text" :disabled="!app.rightBrainEnabled.value" />
          </div>
        </div>
        <div class="form-row">
          <div class="form-group flex-2">
            <label>模型</label>
            <select v-model="app.rightBrain.value.model" @change="app.handleModelChange('right')" :disabled="!app.rightBrainEnabled.value">
              <option value="">请选择模型</option>
              <option v-for="m in app.availableRightModels.value" :key="m.id" :value="m.id">{{ m.id }}</option>
              <option v-if="app.rightBrain.value.provider === 'moonshot' && app.availableRightModels.value.length === 0" value="kimi-for-coding">kimi-for-coding</option>
            </select>
          </div>
          <div class="form-group">
            <label>API Key</label>
            <input v-model="app.rightBrain.value.apiKey" type="password" placeholder="云端 provider 需要" :disabled="!app.rightBrainEnabled.value" />
          </div>
        </div>
        <div class="action-bar">
          <button class="action-btn primary" :disabled="app.configSaving.value" @click="app.saveLeftBrainConfig">
            {{ app.configSaving.value ? '保存中...' : '💾 保存配置' }}
          </button>
          <button class="action-btn" :disabled="!app.rightBrain.value.model || app.fetchingRight.value || app.inspectingRight.value || !app.rightBrainEnabled.value" @click="app.actOnModel('right', 'load')">
            ➕ 加载
          </button>
          <button class="action-btn" :disabled="!app.rightBrain.value.model || app.fetchingRight.value || app.inspectingRight.value || !app.rightBrainEnabled.value" @click="app.actOnModel('right', 'unload')">
            ➖ 卸载
          </button>
          <button class="action-btn" :disabled="!app.rightBrain.value.model || app.fetchingRight.value || app.inspectingRight.value || !app.rightBrainEnabled.value" @click="app.inspectSelectedModel('right')">
            {{ app.inspectingRight.value ? '探测中...' : '🔎 探测' }}
          </button>
        </div>
      </div>
    </section>
  </div>
</template>

<style scoped>
.page-generators {
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

.section-status {
  font-size: 12px;
  font-weight: 700;
  padding: 4px 10px;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.06);
}

.section-status[data-tone='success'] { color: var(--c-success); background: rgba(77, 214, 140, 0.12); }
.section-status[data-tone='warn'] { color: var(--c-warn); background: rgba(246, 201, 78, 0.12); }
.section-status[data-tone='info'] { color: var(--c-accent); background: rgba(94, 204, 255, 0.12); }
.section-status[data-tone='muted'] { color: var(--c-text-muted); }

.section-hint {
  margin: 0 0 16px;
  color: var(--c-text-sub);
  font-size: 13px;
}

.config-form {
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding: 16px;
  border-radius: 12px;
  background: var(--c-bg-panel);
  border: 1px solid var(--c-border);
}

.form-row {
  display: flex;
  gap: 14px;
  flex-wrap: wrap;
}

.form-group {
  display: flex;
  flex-direction: column;
  gap: 6px;
  flex: 1;
  min-width: 160px;
}

.form-group.flex-2 {
  flex: 2;
}

.form-group label {
  font-size: 12px;
  color: var(--c-text-sub);
  font-weight: 600;
}

.form-group input,
.form-group select {
  padding: 9px 11px;
  border-radius: 8px;
  border: 1px solid var(--c-border-mid);
  background: var(--c-bg-input);
  color: var(--c-text);
  font: inherit;
  font-size: 14px;
}

.form-group input:focus,
.form-group select:focus {
  outline: none;
  border-color: var(--c-accent);
}

.form-group input:disabled,
.form-group select:disabled {
  opacity: 0.55;
}

.checkbox-label {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  cursor: pointer;
}

.blocked-hint {
  padding: 10px 12px;
  border-radius: 8px;
  background: rgba(246, 201, 78, 0.1);
  border: 1px solid rgba(246, 201, 78, 0.25);
  color: var(--c-warn);
  font-size: 13px;
}

.inspection-card {
  padding: 12px;
  border-radius: 8px;
  background: var(--c-bg-card);
  border: 1px solid var(--c-border);
}

.inspection-title {
  font-weight: 700;
  color: var(--c-text-inv);
  margin-bottom: 8px;
}

.inspection-row {
  display: flex;
  justify-content: space-between;
  font-size: 13px;
  padding: 4px 0;
  color: var(--c-text-sub);
}

.inspection-row span:first-child {
  color: var(--c-text);
}

.action-bar {
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
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

.action-btn.primary {
  background: var(--c-accent);
  color: #081018;
  border-color: transparent;
}

.message-tip {
  font-size: 13px;
  color: var(--c-success);
}

.message-error {
  font-size: 13px;
  color: var(--c-error);
}
</style>
