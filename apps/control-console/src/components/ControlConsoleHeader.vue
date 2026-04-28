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
          title="热重启 Hermes Python 进程，不会重载 control-server 代码。"
        >
          {{ runtimeBusy ? '处理中...' : '🔁 热重启 Hermes 进程' }}
        </button>

        <button
          class="action-btn"
          :disabled="runtimeBusy || runtimeState?.state === 'uninstalled' || !runtimePrimaryAction"
          @click="toggleGlobalRuntime"
          title="启动 / 暂停 / 恢复 Hermes 智能体（即左脑 runtime）。这是同一个进程，下方「引擎配置」面板的启动按钮指向同一动作。"
        >
          {{ runtimeBusy ? '处理中...' : runtimeActionLabel + ' Hermes（左脑）' }}
        </button>
      </div>

      <div
        v-if="selectedAgent?.definition.runtime === 'hermes'"
        style="margin-top: 6px; font-size: 12px; line-height: 1.5; color: var(--c-text-sub);"
      >
        说明：「Hermes 智能体」= 当前唯一的左脑 runtime 进程。顶部按钮与下方「引擎配置 → 启动 Hermes」是同一个动作的两处入口。<br/>
        如果只想热重启 Hermes 进程，点「热重启 Hermes 进程」即可；如果刚改了 control-server 代码，请到终端执行 <code>sh restart_control.sh</code>。
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