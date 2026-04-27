<script setup lang="ts">
import { useControlConsoleAppContext } from '../composables/useControlConsoleAppContext'

const {
  agentOptions,
  agentSelectionLocked,
  connectSelectedAgent,
  canAllRestartRuntime,
  restartGlobalRuntime,
  runtimeActionLabel,
  runtimeBusy,
  runtimePrimaryAction,
  runtimeState,
  runtimeStatus,
  selectedAgent,
  selectedAgentId,
  toggleGlobalRuntime,
} = useControlConsoleAppContext<any>()
</script>

<template>
  <header class="console-header">
    <h1>智能体网关 (Agent Gateway)</h1>

    <div class="agent-controls">
      <div class="agent-selector-bar">
        <label for="agent-select">全局管理器：</label>
        <div class="select-wrapper">
          <select id="agent-select" v-model="selectedAgentId" @change="connectSelectedAgent" :disabled="agentSelectionLocked">
            <option v-for="agent in agentOptions" :key="agent.definition.id" :value="agent.definition.id">
              {{ agent.definition.name }} ({{ agent.definition.runtime }})
            </option>
          </select>
        </div>
        <div style="font-size: 12px; color: var(--c-text-sub); margin-top: 4px;">
          {{ agentSelectionLocked ? '所有标签页共享同一个 Hermes 全局管理器状态。' : '当前允许手动切换管理器。' }}
        </div>
      </div>

      <div class="runtime-controls" v-if="selectedAgent?.definition.runtime === 'hermes'">
        <div class="status-badge" :data-state="runtimeState?.state || 'unknown'">
          <span class="status-dot"></span>
          {{ runtimeState?.label || '检测中...' }}
        </div>

        <button
          v-if="canAllRestartRuntime"
          class="action-btn outline"
          :disabled="runtimeBusy || runtimeState?.state === 'uninstalled'"
          @click="restartGlobalRuntime"
        >
          {{ runtimeBusy ? '处理中...' : '重启引擎 runtime' }}
        </button>

        <button
          class="action-btn"
          :disabled="runtimeBusy || runtimeState?.state === 'uninstalled' || !runtimePrimaryAction"
          @click="toggleGlobalRuntime"
        >
          {{ runtimeBusy ? '处理中...' : runtimeActionLabel }}
        </button>
      </div>

      <div
        v-if="selectedAgent?.definition.runtime === 'hermes'"
        style="margin-top: 6px; font-size: 12px; line-height: 1.5; color: var(--c-text-sub);"
      >
        `重启引擎 runtime` 只会重启 Hermes runtime，不会重载 control-server 代码；如果刚修改了控制台后端流程，请执行 `sh restart_control.sh`。
      </div>

      <div class="runtime-controls" v-else-if="selectedAgent">
        <div class="status-badge" data-state="unknown">
          <span class="status-dot"></span>
          {{ runtimeStatus }}
        </div>
      </div>
    </div>
  </header>
</template>