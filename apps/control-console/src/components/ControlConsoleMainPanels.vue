<script setup lang="ts">
import { unref } from 'vue'
import { Codemirror } from 'vue-codemirror'
import { renderChatMessage } from '../lib/chatMarkdown'
import ControlConsoleSkillProposalsPanel from './ControlConsoleSkillProposalsPanel.vue'
import {
  formatDurationSeconds,
  formatReasoningEventTime,
  getReasoningEventMetaLines,
  getReasoningEventOps,
  getReasoningEventPreviewBlocks,
} from '../lib/reasoning'
import { useControlConsoleAppContext } from '../composables/useControlConsoleAppContext'

const {
  activeEditorFilePath,
  activeReasoningSession,
  availableLeftModels,
  availableRightModels,
  brainActiveTab,
  canClearReasoningSession,
  cancelReasoningSession,
  chatActiveRequestElapsedSeconds,
  chatMemoryBusy,
  chatContextInfo,
  chatHistory,
  chatMemoryDirty,
  chatMemoryDraft,
  chatMemoryEditorOpen,
  chatMemoryError,
  chatMemoryFile,
  chatMemoryOpenBusy,
  chatMemoryOpenMessage,
  chatMemorySaveBusy,
  chatMemorySaveMessage,
  chatScrollContainer,
  chatUiStatus,
  clearAllMemoryRecords,
  clearSelectedMemoryRecords,
  clearReasoningSession,
  clearVisibleLogs,
  closeEditorModal,
  closeSubmitGate,
  composerPrefersReasoning,
  configSaveError,
  configSaveMessage,
  configSaving,
  confirmSubmitGate,
  contextCandidatesBusy,
  contextCandidatesError,
  contextSourceCandidates,
  contextPoolDeleteBusy,
  contextPoolEditorBusy,
  contextPoolEditorError,
  contextPoolEntries,
  contextPoolFile,
  contextPoolFileContent,
  contextPoolFileDirty,
  contextPoolFileSaveMessage,
  contextPoolEditorExtensions,
  contextPoolSaveBusy,
  contextPoolSaveMessage,
  dashboardActiveTab,
  deleteContextPoolEntry,
  editorModalKind,
  editorModalOpen,
  editorModalTitle,
  error,
  fetchLocalModels,
  fetchingLeft,
  generateSubmitContextDraft,
  getChineseCheckLabel,
  getLogLineColor,
  getPreviewControllerRequest,
  getPreviewPlannerHints,
  getPreviewRuntimeRoute,
  handleChatComposerKeydown,
  handleModelChange,
  handleProviderChange,
  healthError,
  inspectingLeft,
  leftBrain,
  leftBrainBlockedReason,
  leftBrainConfigSaved,
  leftBrainRunning,
  leftBrainSummary,
  leftError,
  leftInspection,
  loadMemoryRecords,
  memoryConfig,
  memoryClearBusy,
  memoryClearMessage,
  memoryClearSelection,
  memoryClearTargets,
  memoryConfigBusy,
  memoryConfigError,
  memoryRecordContent,
  memoryRecordDirty,
  memoryRecordEditorBusy,
  memoryRecordEditorError,
  memoryRecordEditorExtensions,
  memoryRecordFile,
  memoryRecordSaveBusy,
  memoryRecordSaveMessage,
  memoryRecords,
  memoryRecordsBusy,
  memoryRecordsError,
  loadChatHistory,
  loadChatMemoryFile,
  loadContextCandidates,
  loadContextPoolEntry,
  loadContextSourceFile,
  loadEngineConfig,
  openChatHistoryFileInEditor,
  openChatMemoryEditor,
  openContextPoolEntryInEditor,
  openMemoryRecordInEditor,
  preflightBusy,
  primaryComposerActionLabel,
  rawLiveLogs,
  logContainer,
  runtimeBusy,
  reasoningAutoApproveEnabled,
  reasoningBusy,
  reasoningCapabilities,
  reasoningCapabilitiesBusy,
  reasoningCapabilitiesError,
  reasoningElapsedSeconds,
  reasoningError,
  reasoningPendingReview,
  canReasoningStepBack,
  reasoningApproveActionLabel,
  reasoningRejectActionLabel,
  reasoningReviewBusy,
  reasoningReviewDraft,
  reasoningReviewEvidence,
  reasoningReviewTargetLabel,
  reasoningStatusLabel,
  reasoningStopBusy,
  reasoningTimelineRef,
  reviewModeLabel,
  rightBrain,
  rightInspection,
  runLeftBrainPreflight,
  runtimePrimaryAction,
  runtimeState,
  saveChatMemoryFile,
  saveMemoryRecordFile,
  saveConfirmedContextPoolEntry,
  saveContextPoolEntryEdits,
  saveContextSourceFile,
  saveLeftBrainConfig,
  secondaryComposerActionLabel,
  selectedAgent,
  selectedContextPoolEntry,
  selectedContextPoolEntryId,
  selectedContextSource,
  selectedContextSourceId,
  sandboxBusy,
  sandboxPrompt,
  sendChat,
  sendObservableReasoningChat,
  getMemoryRecordStatusLabel,
  getMemoryRecordStatusTone,
  isMemoryRecordUpdated,
  shortTermMemoryHint,
  shortTermMinContextTokens,
  showChatStatusBanner,
  skillConfig,
  skillFilesText,
  sourceEditorBusy,
  sourceEditorContent,
  sourceEditorDirty,
  sourceEditorError,
  sourceEditorExtensions,
  sourceEditorFile,
  sourceEditorSaveBusy,
  sourceEditorSaveMessage,
  submitConfirmedSummary,
  submitDraftBusy,
  submitDraftError,
  submitDraftResult,
  submitGateMode,
  submitGateOpen,
  submitPromptDraft,
  submitReasoningReview,
  submitSelectedContextPoolIds,
  submitSelectedSourceIds,
  actOnModel,
  toggleHermesRuntime,
  visibleLogLines,
  formatActionHintLine,
  formatReasoningEvidence,
  smartStartHermes,
  smartStartBusy,
  smartStartMessage,
} = useControlConsoleAppContext<any>()

function memoryRecordsByScope(scope: string) {
  const records = unref(memoryRecords)
  return (Array.isArray(records) ? records : []).filter((record: any) => record.scope === scope)
}

function formatMemoryRecordMeta(record: any) {
  const parts = []
  if (record.filePath) parts.push(record.filePath)
  if (record.updatedAt) parts.push(`更新 ${new Date(record.updatedAt).toLocaleString()}`)
  if (typeof record.sizeChars === 'number') parts.push(`${record.sizeChars} 字符`)
  if (typeof record.lineCount === 'number') parts.push(`${record.lineCount} 行`)
  return parts.join(' · ')
}
</script>

<template>
  <div class="message-banner error" v-if="healthError">
    <span>❌</span> 控制面健康检查失败: {{ healthError }}
  </div>

  <div class="message-banner tip" v-else-if="selectedAgent?.definition.runtime === 'openclaw'">
    <span>ℹ️</span> 提示：OpenClaw 目前仅为功能预留的占位节点。现阶段请切换回 Hermes 工作流进行系统调度。
  </div>

  <div class="message-banner error" v-else-if="runtimeState?.state === 'uninstalled'">
    <span>⚠️</span> 引擎缺失：Hermes 环境未就绪或受控网关丢失，请检查底层依赖 ({{ runtimeState?.detail }})。
  </div>

  <div class="message-banner tip" v-else-if="runtimeState?.state === 'stopped'">
    <span>💤</span> 智能体已休眠：Hermes 引擎已就绪，但受控服务未启动。请点击右上方的「启动引擎」按钮进行唤醒。
  </div>
  <div class="message-banner tip" v-if="selectedAgent?.definition.runtime === 'hermes' && runtimePrimaryAction && (runtimePrimaryAction === 'start' || runtimePrimaryAction === 'resume') && leftBrainBlockedReason">
    <span>ℹ️</span> 当前无法启动 Hermes：{{ leftBrainBlockedReason }}
  </div>

  <div class="feature-panels" v-if="selectedAgent?.definition.runtime === 'hermes'">
    <details class="panel" open style="margin-bottom: 8px; border: 1px solid #444;">
      <summary class="panel-header" style="display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 8px; background: rgba(100,100,100,0.2); padding: 4px 8px; min-height: 28px;">
        <div class="panel-title" style="font-size: 13px;">📜 后台日志与决策轨 (Real-time Logs & Trajectory)</div>
        <div style="display: flex; justify-content: flex-end;">
          <button class="action-btn outline" @click="clearVisibleLogs" style="padding: 2px 10px; font-size: 12px;">清空窗口</button>
        </div>
      </summary>
      <div class="panel-content" style="padding: 0;">
        <div ref="logContainer" style="width:100%; height: 350px; background: #111; font-family: monospace; font-size: 11px; padding: 4px; border-top: 1px solid #333; resize: vertical; outline: none; overflow: auto; white-space: pre-wrap; word-break: break-all;">
          <div v-if="visibleLogLines.length === 0" style="color: var(--c-text-muted);">等待日志回放...</div>
          <div v-for="(line, index) in visibleLogLines" :key="`${index}-${line}`" :style="{ color: getLogLineColor(line), marginBottom: '1px', lineHeight: '1.2' }">{{ line }}</div>
        </div>
      </div>
    </details>

    <details class="panel" open style="margin-bottom: 16px; border: 1px solid #444;">
      <summary class="panel-header" style="display: flex; align-items: center; justify-content: space-between; background: rgba(0,200,255,0.1)">
        <div style="display: flex; flex: 1; min-width: 0; align-items: center; gap: 12px; flex-wrap: wrap;">
          <div class="panel-title" style="flex: 0 0 auto;">🧠 引擎配置 (Brain Configuration)</div>
          <div style="display: flex; align-items: center; gap: 10px; min-width: 0; font-size: 12px; color: var(--c-text); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; flex-wrap: wrap;">
            <span>运行模型: {{ leftBrainSummary.modelLabel }}</span>
            <span :style="{ color: leftBrainConfigSaved ? 'var(--c-success-dim)' : 'var(--c-error-dim)' }">{{ leftBrainConfigSaved ? '已保存左脑配置' : '未保存左脑配置' }}</span>
            <span :style="{ color: leftBrainSummary.statusLabel === '已启动' ? 'var(--c-success-dim)' : 'var(--c-error-dim)' }">{{ leftBrainSummary.statusLabel }}</span>
          </div>
        </div>
        <div style="display: flex; gap: 8px; flex-wrap: wrap;">
          <button class="action-btn outline" :disabled="preflightBusy || memoryConfigBusy || configSaving || smartStartBusy" @click.stop="runLeftBrainPreflight" style="padding: 2px 10px; font-size: 12px;" title="只跑左脑配置自检（OMLX / Ollama 连通、模型加载、记忆/技能配置等），不启动 runtime。">
            {{ preflightBusy ? '自检中...' : '🔎 自检' }}
          </button>
          <button
            class="action-btn"
            :disabled="runtimeBusy || memoryConfigBusy || configSaving || smartStartBusy || leftBrainRunning"
            @click.stop="smartStartHermes"
            style="padding: 2px 10px; font-size: 12px; background: var(--c-success-dim, #2f9e44); color: #fff;"
            title="一键串起：保存左脑配置 → 运行自检 → 启动 Hermes。等价于按顺序点「保存」+「自检」+「启动 Hermes」。"
          >
            {{ smartStartBusy ? '一键启动中...' : '⚡ 一键启动 (保存→自检→启动)' }}
          </button>
          <button class="action-btn" :disabled="runtimeBusy || memoryConfigBusy || configSaving || smartStartBusy" @click.stop="toggleHermesRuntime('left')" style="padding: 2px 10px; font-size: 12px;" title="启动 / 停止 Hermes runtime（即左脑进程）。与顶部「启动 Hermes（左脑）」是同一个动作。">
            {{ runtimeBusy ? '处理中...' : (leftBrainRunning ? '🔴 停止 Hermes' : '🚀 启动 Hermes (应用此配置)') }}
          </button>
        </div>
      </summary>
      <div class="panel-content" style="padding: 0;">
        <div v-if="smartStartMessage" :style="{ padding: '6px 12px', fontSize: '12px', borderBottom: '1px solid rgba(255,255,255,0.06)', background: 'rgba(94,204,255,0.08)', color: 'var(--c-accent)' }">{{ smartStartMessage }}</div>
        <!-- Tab switcher -->
        <div style="display: flex; border-bottom: 1px solid rgba(255,255,255,0.1); background: rgba(0,0,0,0.18);">
          <button @click="brainActiveTab = 'left'" :style="{ padding: '8px 20px', fontSize: '13px', fontWeight: 600, cursor: 'pointer', background: 'transparent', border: 'none', borderBottom: brainActiveTab === 'left' ? '2px solid var(--c-accent)' : '2px solid transparent', color: brainActiveTab === 'left' ? 'var(--c-accent)' : 'var(--c-text-sub)' }">🧠 左脑</button>
          <button @click="brainActiveTab = 'right'" :style="{ padding: '8px 20px', fontSize: '13px', fontWeight: 600, cursor: 'pointer', background: 'transparent', border: 'none', borderBottom: brainActiveTab === 'right' ? '2px solid var(--c-warn)' : '2px solid transparent', color: brainActiveTab === 'right' ? 'var(--c-warn)' : 'var(--c-text-sub)', opacity: 0.7 }">🔮 右脑 <span style="font-size: 11px; opacity: 0.7;">[未开放]</span></button>
        </div>

        <!-- Left Brain Tab -->
        <div v-if="brainActiveTab === 'left'" style="padding: 12px;">
            <div style="display: flex; flex-wrap: wrap; gap: 16px; align-items: center; padding: 12px; background: rgba(0,0,0,0.2); border-radius: 6px;">
              <div style="flex: 1; min-width: 140px; display: flex; flex-direction: column; gap: 4px;">
                <label>推理平台</label>
                <select v-model="leftBrain.provider" @change="handleProviderChange('left')">
                  <option value="omlx">OMLX (Local)</option>
                  <option value="ollama">Ollama</option>
                </select>
              </div>
              <div style="flex: 1; min-width: 140px; display: flex; flex-direction: column; gap: 4px;">
                <label>服务地址</label>
                <input type="text" v-model="leftBrain.baseUrl" />
              </div>
            </div>
            <div style="display: flex; flex-direction: column; gap: 4px; margin-top: 12px; padding: 12px; background: rgba(0,0,0,0.2); border-radius: 6px;">
              <label>运行模型</label>
              <div style="display: flex; flex-wrap: wrap; gap: 8px;">
                <select v-model="leftBrain.model" @change="handleModelChange('left')" style="flex: 1; min-width: 160px;">
                  <option value="">-- 请选择模型 --</option>
                  <option v-for="mod in availableLeftModels" :key="mod.id" :value="mod.id">{{ mod.id }}</option>
                </select>
                <div style="display: flex; gap: 8px;">
                  <button @click="fetchLocalModels('left')" :disabled="fetchingLeft" :style="{ background: fetchingLeft ? undefined : 'rgba(94,204,255,0.12)', borderColor: 'var(--c-accent)', color: 'var(--c-accent)', minWidth: '56px' }">{{ fetchingLeft ? '刷新中...' : '🔄 刷新' }}</button>
                  <button @click="actOnModel('left', 'load')" :disabled="!leftBrain.model || fetchingLeft || inspectingLeft || leftBrainSummary.statusLabel === '已启动'">➕加载</button>
                  <button @click="actOnModel('left', 'unload')" :disabled="!leftBrain.model || fetchingLeft || inspectingLeft || leftBrainSummary.statusLabel !== '已启动'">➖卸载</button>
                </div>
              </div>
              <div v-if="availableLeftModels.length === 0 && !fetchingLeft && !leftError" style="margin-top: 6px; font-size: 12px; color: var(--c-text-muted);">未获取到模型列表，请确认推理服务已启动后点击「刷新」。</div>
            </div>
            <div v-if="leftInspection" style="margin-top: 8px; font-size: 12px; color: var(--c-text-muted); padding: 6px 12px; border: 1px solid rgba(255,255,255,0.06); border-radius: 6px; background: rgba(0,0,0,0.15);">
              探测: <span :style="{color: leftInspection.accessible ? 'var(--c-success-dim)' : 'var(--c-error-dim)'}">{{ leftInspection.accessible ? '就绪' : '异常' }}</span>
              | 上下文窗口: {{ leftInspection.contextLength || '-' }}
              | Tokens: {{ leftInspection.usage?.totalTokens || '-' }}
              <span v-if="!leftInspection.accessible && leftInspection.detail" style="margin-left: 8px; color: var(--c-error-dim);">· {{ leftInspection.detail }}</span>
            </div>
            <div v-if="leftError" class="text-error" style="margin-top: 8px; font-size: 12px; padding: 6px 10px; border-radius: 6px; background: rgba(255,80,80,0.08);">{{ leftError }}</div>
            <div v-if="leftBrainBlockedReason && !leftBrainRunning" style="margin-top: 10px; font-size: 12px; color: var(--c-warn); padding: 6px 10px; border: 1px solid rgba(246,201,78,0.2); border-radius: 6px; background: rgba(246,201,78,0.06);">⚠ {{ leftBrainBlockedReason }}</div>

            <!-- Clear & Memory Status — always visible -->
            <div style="display: flex; flex-direction: column; gap: 8px; margin-top: 12px; padding: 12px; background: rgba(0,0,0,0.24); border-radius: 6px; border: 1px solid rgba(255,255,255,0.06);">
              <div style="display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 10px;">
                <div>
                  <div style="font-size: 13px; color: var(--c-text); font-weight: 600;">测试前清理与记忆状态</div>
                  <div style="font-size: 12px; color: var(--c-text-muted); margin-top: 4px;">展示短期记忆、长期记忆和日志的真实动态状态。可先清空测试记录，再用外部编辑器核对文件。</div>
                </div>
                <div style="display: flex; flex-wrap: wrap; gap: 8px; align-items: center;">
                  <button class="action-btn outline" @click="loadMemoryRecords" :disabled="memoryRecordsBusy || memoryClearBusy">{{ memoryRecordsBusy ? '刷新中...' : '刷新状态' }}</button>
                  <button class="action-btn outline" @click="clearAllMemoryRecords" :disabled="memoryClearBusy || memoryConfigBusy || configSaving">{{ memoryClearBusy ? '清理中...' : '清空全部记录' }}</button>
                </div>
              </div>
              <div style="display: flex; flex-direction: column; gap: 6px;">
                <label style="font-size: 12px; color: var(--c-text-muted);">可清理项目（勾选后点击「清理所选记录」）</label>
                <div v-if="memoryRecordsBusy && memoryClearTargets.length === 0" class="chat-memory-desc">读取清理项目中...</div>
                <div v-else-if="memoryClearTargets.length === 0" class="chat-memory-desc">当前没有可用的清理项，请先点击「刷新状态」。</div>
                <label v-for="target in memoryClearTargets" :key="target.value" style="display: flex; gap: 10px; align-items: flex-start; padding: 8px 12px; border: 1px solid rgba(255,255,255,0.08); border-radius: 8px; background: rgba(255,255,255,0.02); cursor: pointer;">
                  <input v-model="memoryClearSelection" type="checkbox" :value="target.value" style="margin-top: 2px;" />
                  <span style="display: flex; flex-direction: column; gap: 2px;">
                    <span style="font-size: 13px; color: var(--c-text); font-weight: 600;">{{ target.label }}</span>
                    <span class="chat-memory-desc">{{ target.description }}</span>
                  </span>
                </label>
                <button class="action-btn" @click="clearSelectedMemoryRecords" :disabled="memoryClearBusy || memoryClearSelection.length === 0" style="align-self: flex-start;">{{ memoryClearBusy ? '清理中...' : '清理所选记录' }}</button>
              </div>
              <div v-if="memoryClearMessage" style="font-size: 12px; color: var(--c-accent);">{{ memoryClearMessage }}</div>
              <div v-if="memoryRecordsError" class="text-error" style="font-size: 12px;">{{ memoryRecordsError }}</div>
            </div>

            <!-- Short-term memory records — always visible -->
            <div style="display: flex; flex-direction: column; gap: 10px; margin-top: 12px; padding: 12px; background: rgba(0,0,0,0.2); border-radius: 6px;">
              <div style="font-size: 13px; color: var(--c-text); font-weight: 600;">短期记忆与上下文缓冲</div>
              <div v-if="memoryRecordsBusy && memoryRecords.length === 0" class="chat-memory-desc">读取记录中...</div>
              <div v-else-if="memoryRecordsByScope('short-term').filter((item: any) => item.key !== 'runtime-log' && item.key !== 'daily-log').length === 0 && memoryRecordsByScope('context-pool').length === 0" class="chat-memory-desc">当前还没有可显示的短期记忆记录。</div>
              <div v-else class="submit-source-list">
                <div v-for="record in [...memoryRecordsByScope('short-term').filter((item: any) => item.key !== 'runtime-log' && item.key !== 'daily-log'), ...memoryRecordsByScope('context-pool')]" :key="record.key" class="submit-source-item">
                  <div class="submit-source-item-header" style="align-items: flex-start; gap: 12px;">
                    <div style="display: flex; flex-direction: column; gap: 4px; flex: 1; min-width: 0;">
                      <div style="display: flex; flex-wrap: wrap; gap: 8px; align-items: center;">
                        <strong>{{ record.label }}</strong>
                        <span class="reasoning-plan-step-chip" :style="{ color: getMemoryRecordStatusTone(record), borderColor: getMemoryRecordStatusTone(record) }">{{ getMemoryRecordStatusLabel(record) }}</span>
                        <span v-if="record.itemCount" class="chat-memory-desc">{{ record.itemCount }} 项</span>
                        <span v-if="isMemoryRecordUpdated(record.key)" class="chat-memory-desc" style="color: var(--c-accent);">已变化</span>
                      </div>
                      <div class="chat-memory-desc">{{ formatMemoryRecordMeta(record) }}</div>
                      <div v-if="record.preview" class="chat-memory-desc" style="white-space: pre-wrap; color: var(--c-text);">{{ record.preview }}</div>
                    </div>
                    <button v-if="record.canOpen" class="action-btn outline" type="button" @click="openMemoryRecordInEditor(record.key)">编辑/打开</button>
                  </div>
                </div>
              </div>
            </div>

            <!-- Long-term memory records — always visible -->
            <div style="display: flex; flex-direction: column; gap: 10px; margin-top: 12px; padding: 12px; background: rgba(0,0,0,0.2); border-radius: 6px;">
              <div style="font-size: 13px; color: var(--c-text); font-weight: 600;">长期记忆与日志</div>
              <div v-if="memoryRecordsByScope('long-term').length === 0 && memoryRecordsByScope('short-term').filter((item: any) => item.key === 'runtime-log' || item.key === 'daily-log').length === 0" class="chat-memory-desc">当前还没有长期记忆文件状态，请点击「刷新状态」。</div>
              <div v-else class="submit-source-list">
                <div v-for="record in [...memoryRecordsByScope('long-term'), ...memoryRecordsByScope('short-term').filter((item: any) => item.key === 'runtime-log' || item.key === 'daily-log')]" :key="record.key" class="submit-source-item">
                  <div class="submit-source-item-header" style="align-items: flex-start; gap: 12px;">
                    <div style="display: flex; flex-direction: column; gap: 4px; flex: 1; min-width: 0;">
                      <div style="display: flex; flex-wrap: wrap; gap: 8px; align-items: center;">
                        <strong>{{ record.label }}</strong>
                        <span class="reasoning-plan-step-chip" :style="{ color: getMemoryRecordStatusTone(record), borderColor: getMemoryRecordStatusTone(record) }">{{ getMemoryRecordStatusLabel(record) }}</span>
                      </div>
                      <div class="chat-memory-desc">{{ formatMemoryRecordMeta(record) }}</div>
                      <div v-if="record.preview" class="chat-memory-desc" style="white-space: pre-wrap; color: var(--c-text);">{{ record.preview }}</div>
                    </div>
                    <button v-if="record.canOpen" class="action-btn outline" type="button" @click="openMemoryRecordInEditor(record.key)">编辑/打开</button>
                  </div>
                </div>
              </div>
            </div>

            <div style="display: flex; flex-wrap: wrap; align-items: center; gap: 12px; margin-top: 12px;">
              <button class="action-btn" @click="saveLeftBrainConfig" :disabled="configSaving || memoryConfigBusy || !memoryConfig">{{ configSaving ? '保存中...' : (leftBrainConfigSaved ? '已保存左脑配置' : '未保存左脑配置') }}</button>
              <button class="action-btn outline" @click="loadEngineConfig" :disabled="memoryConfigBusy || configSaving">{{ memoryConfigBusy ? '读取中...' : '刷新配置' }}</button>
              <span v-if="configSaveMessage" style="font-size: 12px; color: var(--c-accent);">{{ configSaveMessage }}</span>
            </div>
            <div v-if="configSaveError" class="text-error" style="margin-top: 8px;">{{ configSaveError }}</div>
        </div>

        <!-- Right Brain Tab -->
        <div v-else style="padding: 12px; opacity: 0.65;">
            <div style="margin-bottom: 12px; font-size: 12px; color: var(--c-text-muted); padding: 8px 12px; border: 1px solid rgba(246,201,78,0.2); border-radius: 6px; background: rgba(246,201,78,0.05);">
              右脑当前保持置灰，只作为后续扩展占位，不参与 HermesManager 启动。
            </div>
            <div style="display: flex; flex-wrap: wrap; gap: 16px; align-items: center; padding: 12px; background: rgba(0,0,0,0.2); border-radius: 6px;">
              <div style="flex: 1; min-width: 140px; display: flex; flex-direction: column; gap: 4px;"><label>推理平台</label><select v-model="rightBrain.provider" disabled><option value="omlx">OMLX (Local)</option><option value="ollama">Ollama</option></select></div>
              <div style="flex: 1; min-width: 140px; display: flex; flex-direction: column; gap: 4px;"><label>服务地址</label><input type="text" v-model="rightBrain.baseUrl" disabled /></div>
            </div>
            <div style="display: flex; flex-direction: column; gap: 4px; margin-top: 12px; padding: 12px; background: rgba(0,0,0,0.2); border-radius: 6px;">
              <label>运行模型</label>
              <div style="display: flex; gap: 8px;"><select v-model="rightBrain.model" style="flex: 1;" disabled><option value="">-- 未开放 --</option><option v-for="mod in availableRightModels" :key="mod.id" :value="mod.id">{{ mod.id }}</option></select><button disabled>未开放</button></div>
            </div>
            <div v-if="rightInspection" style="margin-top: 12px; font-size: 12px; color: var(--c-text-muted);">状态: <span :style="{color: rightInspection.accessible ? 'var(--c-success-dim)' : 'var(--c-error-dim)'}">{{ rightInspection.accessible ? '就绪' : '异常' }}</span> | 窗口: {{ rightInspection.contextLength || '-' }} | 探测Tokens: {{ rightInspection.usage?.totalTokens || '-' }}</div>
        </div>
      </div>
    </details>

    <details class="panel" open style="margin-bottom: 24px;">
      <summary class="panel-header" style="display: flex; align-items: center; justify-content: space-between;">
        <div class="panel-title">💬 Hermes 直连对话 (Chat & Token Monitor)</div>
      </summary>
      <div class="panel-content chat-panel-shell">
        <div v-if="showChatStatusBanner" class="message-banner" :class="chatUiStatus.kind === 'error' ? 'error' : 'tip'" style="margin-bottom: 12px; font-size: 12px; line-height: 1.5;">
          <div><strong>{{ chatUiStatus.kind === 'pending' ? '聊天请求进行中' : chatUiStatus.kind === 'busy' ? '聊天请求排队保护' : chatUiStatus.kind === 'recovering' ? '聊天超时自动恢复' : chatUiStatus.kind === 'timeout' ? '聊天等待超时，后台继续处理' : '聊天请求异常' }}</strong></div>
          <div style="margin-top: 4px; color: var(--c-text);">{{ chatUiStatus.message }}</div>
          <div v-if="chatUiStatus.activeRequest" style="margin-top: 4px; color: var(--c-text);">活动请求: 已运行 {{ chatActiveRequestElapsedSeconds }} 秒 · 提示长度 {{ chatUiStatus.activeRequest.promptChars }} 字符</div>
        </div>
        <div ref="chatScrollContainer" class="chat-thread-resizable">
          <div class="chat-thread">
            <div v-if="chatHistory.length === 0" class="chat-empty-state"><div class="chat-empty-title">Hermes 对话已就绪</div><div class="chat-empty-copy">输入消息后使用 Cmd/Ctrl + Enter 触发当前标签页主动作，Enter 可直接换行。可观测推理链标签页会优先走 observable reasoning。</div></div>
            <div v-for="(msg, i) in chatHistory" :key="i" class="chat-row" :data-role="msg.role">
              <div class="chat-bubble" :data-role="msg.role">
                <div class="chat-role">{{ msg.role.toUpperCase() }}</div>
                <div class="chat-message-text" v-html="renderChatMessage(msg.content)"></div>
                <div v-if="msg.tokens" class="chat-token-usage">Token 消耗: 提示词 {{ msg.tokens.prompt_tokens }} | 输出 {{ msg.tokens.completion_tokens }} | 总计 {{ msg.tokens.total_tokens }}</div>
              </div>
            </div>
          </div>
        </div>
        <div class="chat-composer">
          <textarea v-model="sandboxPrompt" class="chat-composer-input" rows="3" @keydown="handleChatComposerKeydown" placeholder="直接发送指令给 Hermes..." />
          <div class="chat-composer-footer">
            <div class="chat-composer-hint">Enter 换行，Cmd/Ctrl + Enter 触发当前标签页主动作。当前{{ composerPrefersReasoning ? '优先开始可观测执行' : '优先直接聊天' }}。</div>
            <div class="chat-composer-actions">
              <label class="reasoning-auto-approve-toggle"><input v-model="reasoningAutoApproveEnabled" type="checkbox" /><span>{{ reviewModeLabel }}</span></label>
              <button v-if="composerPrefersReasoning" class="action-btn" @click="sendObservableReasoningChat" :disabled="sandboxBusy || reasoningBusy || !sandboxPrompt.trim()">{{ primaryComposerActionLabel }}</button>
              <button v-else class="action-btn outline" @click="sendObservableReasoningChat" :disabled="sandboxBusy || reasoningBusy || !sandboxPrompt.trim()">{{ secondaryComposerActionLabel }}</button>
              <button v-if="reasoningBusy && activeReasoningSession" class="action-btn outline" @click="cancelReasoningSession" :disabled="reasoningStopBusy">{{ reasoningStopBusy ? '停止中...' : '停止' }}</button>
              <button v-if="composerPrefersReasoning" class="action-btn outline" @click="sendChat" :disabled="sandboxBusy || reasoningBusy || !sandboxPrompt.trim()">{{ secondaryComposerActionLabel }}</button>
              <button v-else class="action-btn" @click="sendChat" :disabled="sandboxBusy || reasoningBusy || !sandboxPrompt.trim()">{{ primaryComposerActionLabel }}</button>
            </div>
          </div>
        </div>

        <div v-if="submitGateOpen" class="chat-context-panel submit-gate-panel">
          <div class="chat-context-summary-line"><strong>提交前确认</strong><span>{{ submitGateMode === 'reasoning' ? '可观测执行' : '直接发送' }}</span><span>可先预览 Control 提交包、Hermes 当前运行时路由和命中的 skill/action hints，再决定是否发送</span></div>
          <div class="submit-gate-block"><div class="chat-memory-title">本次问题</div><textarea v-model="submitPromptDraft" class="chat-memory-editor" rows="3" spellcheck="false" /></div>
          <div class="submit-gate-grid">
            <div class="submit-gate-block">
              <div class="chat-memory-title">手工附加上下文源</div>
              <div v-if="contextCandidatesBusy" class="chat-memory-desc">读取中...</div>
              <div v-else class="submit-source-list">
                <label v-for="source in contextSourceCandidates" :key="source.sourceId" class="submit-source-item">
                  <div class="submit-source-item-header">
                    <label class="submit-source-checkbox-line"><input v-model="submitSelectedSourceIds" type="checkbox" :value="source.sourceId" :disabled="!source.exists" /><span>{{ source.label }}</span></label>
                    <button class="action-btn outline submit-source-open-btn" type="button" @click.stop="loadContextSourceFile(source.sourceId)" :disabled="sourceEditorBusy">{{ selectedContextSourceId === source.sourceId ? '已打开' : '查看/编辑' }}</button>
                  </div>
                  <span class="chat-context-source-meta">{{ source.exists ? `载入 ${source.loadedChars} / ${source.totalChars} 字符` : '当前文件缺失' }}</span>
                </label>
                <div v-if="contextSourceCandidates.length === 0" class="chat-memory-desc">当前没有需要手工附加的原始上下文源；Hermes 启动后会自行读取默认 memory 文件。</div>
              </div>
            </div>
            <div class="submit-gate-block">
              <div class="chat-memory-title">已确认上下文池</div>
              <div v-if="contextCandidatesBusy" class="chat-memory-desc">读取中...</div>
              <div v-else class="submit-source-list">
                <label v-for="entry in contextPoolEntries" :key="entry.entryId" class="submit-source-item"><input v-model="submitSelectedContextPoolIds" type="checkbox" :value="entry.entryId" /><span>{{ entry.title }}</span><span class="chat-memory-desc">{{ entry.updatedAt }}</span></label>
                <div v-if="contextPoolEntries.length === 0" class="chat-memory-desc">当前还没有已确认的上下文池记录。</div>
              </div>
            </div>
          </div>
          <div class="submit-gate-block" style="margin-top: 12px;"><div class="chat-memory-title">原始上下文文件编辑器</div><div v-if="sourceEditorError" class="message-banner error" style="font-size: 12px;">{{ sourceEditorError }}</div><div v-if="selectedContextSource && sourceEditorFile" class="chat-memory-desc">当前已选择 {{ selectedContextSource.label }}。点击上方“查看/编辑”会用弹窗打开编辑器，快捷键将锁定在编辑器内。</div><div v-else class="chat-memory-desc">如有手工附加源，点击上方“查看/编辑”即可在弹窗中在线打开文件。</div></div>
          <div class="submit-gate-block" style="margin-top: 12px;"><div class="chat-memory-title">压缩后的运行上下文</div><div class="chat-memory-desc">点击“查看发送预览”后会自动生成本轮上下文压缩摘要。你可以直接修改，确认后会随本次 agentRuntime 任务一起注入。</div><textarea v-model="submitConfirmedSummary" class="chat-memory-editor" rows="5" spellcheck="false" placeholder="这里会自动填入本轮上下文压缩摘要；也可以手工改写后再提交。" /><div class="reasoning-review-actions" style="margin-top: 8px;"><button class="action-btn outline" @click="saveConfirmedContextPoolEntry" :disabled="contextPoolSaveBusy || !submitConfirmedSummary.trim()">{{ contextPoolSaveBusy ? '保存中...' : '保存到上下文池' }}</button></div><div v-if="contextPoolSaveMessage" class="chat-memory-desc" style="margin-top: 6px;">{{ contextPoolSaveMessage }}</div></div>
          <div class="reasoning-review-actions" style="margin-top: 12px;"><button class="action-btn outline" @click="generateSubmitContextDraft" :disabled="submitDraftBusy || contextCandidatesBusy || !submitPromptDraft.trim()">{{ submitDraftBusy ? '预览中...' : '查看发送预览' }}</button><button class="action-btn outline" @click="closeSubmitGate" :disabled="submitDraftBusy || contextPoolSaveBusy">取消</button><button class="action-btn" @click="confirmSubmitGate" :disabled="submitDraftBusy || contextPoolSaveBusy || !submitPromptDraft.trim()">{{ submitGateMode === 'reasoning' ? '确认开始可观测执行' : '确认直接发送' }}</button></div>
          <div v-if="contextCandidatesError || submitDraftError" class="message-banner error" style="margin-top: 8px; font-size: 12px;">{{ contextCandidatesError || submitDraftError }}</div>
          <div v-if="submitDraftResult" class="reasoning-review-box" style="margin-top: 12px;">
            <div class="reasoning-plan-title">提交流程预览</div>
            <div v-if="submitDraftResult.summary" class="chat-memory-desc" style="margin-bottom: 10px; white-space: pre-wrap;">{{ submitDraftResult.summary }}</div>
            <div v-if="getPreviewControllerRequest(submitDraftResult.outboundPreview) || getPreviewRuntimeRoute(submitDraftResult.outboundPreview) || getPreviewPlannerHints(submitDraftResult.outboundPreview)" class="transport-preview-grid">
              <div v-if="getPreviewControllerRequest(submitDraftResult.outboundPreview)" class="transport-preview-card controller"><div class="transport-preview-card-title">Control 提交给 Hermes</div><div class="transport-preview-meta">目标 {{ getPreviewControllerRequest(submitDraftResult.outboundPreview)?.target }}</div><div class="transport-preview-meta">调度模型 hermes-agent · 共 {{ getPreviewControllerRequest(submitDraftResult.outboundPreview)?.totalMessages }} 条消息 · system {{ getPreviewControllerRequest(submitDraftResult.outboundPreview)?.systemMessageCount }} · 历史重放 {{ getPreviewControllerRequest(submitDraftResult.outboundPreview)?.replayedMessageCount }} · user {{ getPreviewControllerRequest(submitDraftResult.outboundPreview)?.userMessageCount }}</div><pre class="reasoning-evidence-pre transport-preview-pre">{{ formatReasoningEvidence(getPreviewControllerRequest(submitDraftResult.outboundPreview)?.messages || []) }}</pre></div>
              <div v-if="getPreviewRuntimeRoute(submitDraftResult.outboundPreview)" class="transport-preview-card route"><div class="transport-preview-card-title">Hermes 当前运行时路由</div><div class="transport-preview-meta">运行时 {{ getPreviewRuntimeRoute(submitDraftResult.outboundPreview)?.provider }} / {{ getPreviewRuntimeRoute(submitDraftResult.outboundPreview)?.model }}</div><div class="transport-preview-meta">Base URL {{ getPreviewRuntimeRoute(submitDraftResult.outboundPreview)?.baseUrl }}</div><div class="chat-memory-desc" style="white-space: pre-wrap;">{{ getPreviewRuntimeRoute(submitDraftResult.outboundPreview)?.note }}</div></div>
              <div v-if="getPreviewPlannerHints(submitDraftResult.outboundPreview)" class="transport-preview-card hints"><div class="transport-preview-card-title">命中的 skill / action hints</div><div v-if="getPreviewPlannerHints(submitDraftResult.outboundPreview)?.suggestedActions?.length" class="transport-preview-meta">建议动作 {{ getPreviewPlannerHints(submitDraftResult.outboundPreview)?.suggestedActions?.join(', ') }}</div><div v-if="getPreviewPlannerHints(submitDraftResult.outboundPreview)?.selectedSkills?.length" class="chat-context-sources-list" style="margin-top: 8px;"><div v-for="skill in getPreviewPlannerHints(submitDraftResult.outboundPreview)?.selectedSkills || []" :key="skill.filePath" class="chat-context-source-line"><strong class="chat-context-source-label">{{ skill.name }}</strong><span class="chat-context-source-ok">{{ skill.hintCount }} 条 hint</span><span>{{ skill.filePath }}</span></div></div></div>
            </div>
          </div>
        </div>

        <div class="dashboard-tabs" style="margin: 16px 0;">
          <button class="dashboard-tab-btn" :class="{ active: dashboardActiveTab === 'reasoning' }" @click="dashboardActiveTab = 'reasoning'">可观测推理链</button>
          <button class="dashboard-tab-btn" :class="{ active: dashboardActiveTab === 'context' }" @click="dashboardActiveTab = 'context'">当前上下文</button>
          <button class="dashboard-tab-btn" :class="{ active: dashboardActiveTab === 'plan' }" @click="dashboardActiveTab = 'plan'">Agent Runtime</button>
          <button class="dashboard-tab-btn" :class="{ active: dashboardActiveTab === 'pool' }" @click="dashboardActiveTab = 'pool'">上下文池</button>
          <button class="dashboard-tab-btn" :class="{ active: dashboardActiveTab === 'history' }" @click="dashboardActiveTab = 'history'">聊天记录存档</button>
          <button class="dashboard-tab-btn" :class="{ active: dashboardActiveTab === 'skills' }" @click="dashboardActiveTab = 'skills'">技能提案</button>
        </div>

        <div class="dashboard-tab-content" v-show="dashboardActiveTab === 'reasoning'">
          <div v-if="activeReasoningSession || reasoningError" class="reasoning-panel">
            <div class="reasoning-panel-header"><div><div class="chat-memory-title">agentRuntime 可观测任务链</div><div class="reasoning-subtitle"><span v-if="reasoningBusy" class="reasoning-busy-dot"></span>状态 {{ reasoningStatusLabel }}<span v-if="activeReasoningSession"> · Session {{ activeReasoningSession.sessionId }} · 总计时 {{ formatDurationSeconds(reasoningElapsedSeconds) }}</span></div></div><div class="reasoning-panel-actions"><button class="action-btn outline" @click="clearReasoningSession" :disabled="!canClearReasoningSession || reasoningStopBusy">{{ reasoningStopBusy && canClearReasoningSession ? '清理中...' : '清理记录' }}</button></div></div>
            <div v-if="activeReasoningSession?.runtimeTaskGraph || activeReasoningSession?.plan" class="reasoning-plan-box"><div class="reasoning-plan-title">运行任务图</div><div class="reasoning-plan-goal">{{ (activeReasoningSession.runtimeTaskGraph || activeReasoningSession.plan)?.goal }}</div><div class="reasoning-plan-steps"><div v-for="step in (activeReasoningSession.runtimeTaskGraph || activeReasoningSession.plan)?.steps || []" :key="step.stepId" class="reasoning-plan-step" :class="{ active: activeReasoningSession.currentStepId === step.stepId, review: activeReasoningSession.review?.stepId === step.stepId }"><strong>{{ step.title }}</strong><span class="reasoning-plan-step-chip">{{ step.action }}</span><span class="reasoning-plan-step-chip">{{ step.tool }}</span></div></div></div>
            <div v-if="reasoningPendingReview" class="reasoning-review-box">
              <div class="reasoning-plan-title">{{ reasoningReviewTargetLabel }}</div>
              <div class="reasoning-review-title">{{ reasoningPendingReview.title }}</div>
              <div class="reasoning-review-summary">{{ reasoningPendingReview.summary }}</div>
              <div class="chat-memory-desc" style="margin-bottom: 10px;">{{ reasoningAutoApproveEnabled ? '当前为自动直跑模式：运行任务图和步骤不会停在审核框。' : '当前为人工全审模式：运行任务图、执行步骤和最终回答都会进入审核。' }}</div>
              <div v-if="reasoningReviewEvidence?.outboundPreview" class="reasoning-evidence-block"><div class="reasoning-evidence-title">本轮提交流程</div><pre class="reasoning-evidence-pre">{{ formatReasoningEvidence(reasoningReviewEvidence.outboundPreview) }}</pre></div>
              <div v-if="reasoningReviewEvidence?.rawResponsePreview" class="reasoning-evidence-block"><div class="reasoning-evidence-title">模型首先返回的结果</div><pre class="reasoning-evidence-pre">{{ reasoningReviewEvidence.rawResponsePreview }}</pre></div>
              <div v-if="reasoningReviewEvidence?.structuredResult" class="reasoning-evidence-block"><div class="reasoning-evidence-title">结构化结果摘要</div><pre class="reasoning-evidence-pre">{{ formatReasoningEvidence(reasoningReviewEvidence.structuredResult) }}</pre></div>
              <textarea v-model="reasoningReviewDraft" class="chat-memory-editor reasoning-review-editor" rows="4" spellcheck="false" placeholder="驳回时填写修正条件，例如：必须调用 project.listStories，不要猜数据库。" :disabled="reasoningAutoApproveEnabled" />
              <div class="reasoning-review-actions"><button v-if="canReasoningStepBack" class="action-btn outline" @click="submitReasoningReview('back')" :disabled="reasoningReviewBusy || reasoningAutoApproveEnabled">{{ reasoningReviewBusy ? '提交中...' : '后退一步' }}</button><button class="action-btn outline" @click="submitReasoningReview('reject')" :disabled="reasoningReviewBusy || reasoningAutoApproveEnabled">{{ reasoningReviewBusy ? '提交中...' : reasoningRejectActionLabel }}</button><button class="action-btn" @click="submitReasoningReview('approve')" :disabled="reasoningReviewBusy || reasoningAutoApproveEnabled">{{ reasoningReviewBusy ? '提交中...' : reasoningApproveActionLabel }}</button></div>
            </div>
            <div v-if="activeReasoningSession?.events?.length" class="reasoning-timeline" ref="reasoningTimelineRef"><div v-for="event in activeReasoningSession.events" :key="event.eventId" class="reasoning-event-row"><div class="reasoning-event-type">{{ event.type }}</div><div class="reasoning-event-body"><div class="reasoning-event-title">{{ event.title }}</div><div class="reasoning-event-summary">{{ event.summary }}</div><div v-if="getReasoningEventMetaLines(event).length" class="reasoning-event-meta-list"><span v-for="line in getReasoningEventMetaLines(event)" :key="`${event.eventId}-${line}`" class="reasoning-event-meta-chip">{{ line }}</span></div><div v-if="getReasoningEventOps(event).length" class="reasoning-event-ops"><div class="reasoning-event-ops-title">可观测调用</div><div v-for="line in getReasoningEventOps(event)" :key="`${event.eventId}-${line}`" class="reasoning-event-op-line">{{ line }}</div></div><div v-if="getReasoningEventPreviewBlocks(event).length" class="reasoning-event-ops"><div class="reasoning-event-ops-title">Hermes 返回</div><div v-for="block in getReasoningEventPreviewBlocks(event)" :key="`${event.eventId}-${block.title}`" style="margin-top: 8px;"><div class="reasoning-event-ops-title" style="margin-bottom: 4px;">{{ block.title }}</div><pre class="reasoning-evidence-pre" style="margin: 0; max-height: 240px; overflow: auto;">{{ block.content }}</pre></div></div></div><div class="reasoning-event-time">{{ formatReasoningEventTime(event.timestamp) }}</div></div></div>
            <div v-if="activeReasoningSession?.error || reasoningError" class="message-banner error" style="font-size: 12px; line-height: 1.5;">{{ activeReasoningSession?.error || reasoningError }}</div>
          </div>
        </div>

        <div class="dashboard-tab-content" v-show="dashboardActiveTab === 'context'"><div v-if="chatContextInfo" class="chat-context-panel"><div class="chat-context-summary-line"><strong>本次上下文</strong><span>已加载 {{ chatContextInfo.loadedSourceCount }}/{{ chatContextInfo.selectedSourceCount }}</span><span v-if="chatContextInfo.contextPoolEntryCount">上下文池 {{ chatContextInfo.contextPoolEntryCount }} 条</span><span>重放历史 {{ chatContextInfo.replayedMessageCount }} 条</span><span>运行时 {{ chatContextInfo.runtime.provider }} / {{ chatContextInfo.runtime.model }}</span></div></div></div>
        <div class="dashboard-tab-content" v-show="dashboardActiveTab === 'plan'">
          <div v-if="reasoningCapabilities || reasoningCapabilitiesBusy || reasoningCapabilitiesError" class="chat-context-panel capability-panel">
            <div class="chat-context-summary-line capability-summary">
              <strong>{{ reasoningCapabilities?.runtime?.runtimeName || 'agentRuntime' }} 注册与检查</strong>
              <span v-if="reasoningCapabilities">tool {{ reasoningCapabilities.tools.length }}</span>
              <span v-if="reasoningCapabilities">action {{ reasoningCapabilities.actions.length }}</span>
              <span v-if="reasoningCapabilities">skill {{ reasoningCapabilities.skills.length }}</span>
              <span v-if="reasoningCapabilities">check {{ reasoningCapabilities.behaviorChecks.length }}</span>
              <span v-if="reasoningCapabilities?.guide?.exists">附带扩展示例</span>
            </div>
            <div v-if="reasoningCapabilitiesError" class="message-banner error" style="margin-top: 8px; font-size: 12px;">{{ reasoningCapabilitiesError }}</div>
            <div v-else-if="reasoningCapabilitiesBusy" class="chat-memory-desc" style="margin-top: 8px;">读取中...</div>
            <template v-else-if="reasoningCapabilities">
              <div class="chat-memory-desc" style="margin-top: 8px;">这里展示当前 control 中的 {{ reasoningCapabilities.runtime.controlPlaneName }} / {{ reasoningCapabilities.runtime.runtimeName }} 语义、运行行为检查、基础工具、动作映射和已加载 skill。后续新增工具或动作时，只需在 server capability registry 中登记即可被这里展示。</div>
              <div class="transport-preview-grid" style="margin-top: 12px;">
                <div class="transport-preview-card controller">
                  <div class="transport-preview-card-title">运行面入口</div>
                  <div class="submit-source-list" style="margin-top: 8px;">
                    <div class="submit-source-item">
                      <div class="submit-source-item-header"><strong>控制前端</strong><span class="reasoning-plan-step-chip">main</span></div>
                      <div class="chat-memory-desc">{{ reasoningCapabilities.runtime.frontend.root }}</div>
                      <div class="chat-memory-desc">入口 {{ reasoningCapabilities.runtime.frontend.entryFile }}</div>
                    </div>
                    <div class="submit-source-item">
                      <div class="submit-source-item-header"><strong>控制后端</strong><span class="reasoning-plan-step-chip">index</span></div>
                      <div class="chat-memory-desc">{{ reasoningCapabilities.runtime.backend.root }}</div>
                      <div class="chat-memory-desc">入口 {{ reasoningCapabilities.runtime.backend.entryFile }}</div>
                    </div>
                  </div>
                </div>
                <div class="transport-preview-card route">
                  <div class="transport-preview-card-title">行为检查</div>
                  <div class="submit-source-list" style="margin-top: 8px;">
                    <div v-for="check in reasoningCapabilities.behaviorChecks" :key="check.key" class="submit-source-item">
                      <div class="submit-source-item-header">
                        <strong>{{ getChineseCheckLabel(check.key) }}</strong>
                        <span class="reasoning-plan-step-chip">{{ check.status }}</span>
                      </div>
                      <div class="chat-memory-desc">{{ check.detail }}</div>
                    </div>
                  </div>
                </div>
                <div class="transport-preview-card controller">
                  <div class="transport-preview-card-title">基础工具</div>
                  <div class="submit-source-list" style="margin-top: 8px;">
                    <div v-for="tool in reasoningCapabilities.tools" :key="tool.tool" class="submit-source-item">
                      <div class="submit-source-item-header">
                        <strong>{{ tool.title }}</strong>
                        <span class="reasoning-plan-step-chip">{{ tool.tool }}</span>
                      </div>
                      <div class="chat-memory-desc">{{ tool.category }} · {{ tool.executionMode }} · {{ tool.reviewPolicy === 'required' ? '需人工审核' : '可自动继续' }}</div>
                      <div class="chat-memory-desc">{{ tool.description }}</div>
                      <div class="chat-context-sources-list" v-if="tool.routes?.length">
                        <div v-for="route in tool.routes" :key="`${tool.tool}-${route}`" class="chat-context-source-line"><span>{{ route }}</span></div>
                      </div>
                    </div>
                  </div>
                </div>
                <div class="transport-preview-card route">
                  <div class="transport-preview-card-title">动作映射</div>
                  <div class="submit-source-list" style="margin-top: 8px;">
                    <div v-for="action in reasoningCapabilities.actions" :key="action.action" class="submit-source-item">
                      <div class="submit-source-item-header">
                        <strong>{{ action.title }}</strong>
                        <span class="reasoning-plan-step-chip">{{ action.action }}</span>
                      </div>
                      <div class="chat-memory-desc">tool {{ action.tool }} · {{ action.requiresHumanReview ? '需审核' : '可自动继续' }}</div>
                      <div class="chat-memory-desc">{{ action.description }}</div>
                      <div class="chat-context-sources-list" v-if="action.paramsSpec?.length">
                        <div v-for="item in action.paramsSpec" :key="`${action.action}-${item}`" class="chat-context-source-line"><span>{{ item }}</span></div>
                      </div>
                    </div>
                  </div>
                </div>
                <div class="transport-preview-card hints">
                  <div class="transport-preview-card-title">已加载技能</div>
                  <div v-if="reasoningCapabilities.skills.length === 0" class="chat-memory-desc" style="margin-top: 8px;">当前没有可用 skill。</div>
                  <div v-else class="submit-source-list" style="margin-top: 8px;">
                    <div v-for="skill in reasoningCapabilities.skills" :key="skill.filePath" class="submit-source-item">
                      <div class="submit-source-item-header">
                        <strong>{{ skill.name }}</strong>
                        <span class="reasoning-plan-step-chip">{{ skill.hintCount }} hint</span>
                      </div>
                      <div class="chat-memory-desc">{{ skill.filePath }}</div>
                      <div class="chat-context-sources-list" v-if="skill.actionHints?.length">
                        <div v-for="hint in skill.actionHints" :key="hint.hintId" class="chat-context-source-line"><span>{{ formatActionHintLine(hint) }}</span></div>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </template>
          </div>
        </div>
        <div class="dashboard-tab-content" v-show="dashboardActiveTab === 'pool'"><div class="chat-memory-panel"><div class="chat-memory-header-row"><div><div class="chat-memory-title">上下文池</div><div class="chat-memory-desc">这里只保存人工确认后的上下文理解；未确认内容不会落盘，也不会复用。</div></div><div class="chat-memory-actions"><button class="action-btn outline" @click="loadContextCandidates" :disabled="contextCandidatesBusy || contextPoolEditorBusy">{{ contextCandidatesBusy ? '刷新中...' : '刷新列表' }}</button></div></div><div class="chat-memory-meta"><span>记录数 {{ contextPoolEntries.length }}</span></div></div></div>
        <div class="dashboard-tab-content" v-show="dashboardActiveTab === 'history'"><div class="chat-memory-panel"><div class="chat-memory-header-row"><div><div class="chat-memory-title">聊天记录存档</div><div class="chat-memory-desc">按日期持续写入的长期聊天记录，用于回看、整理和人工提取信息；它不等同于 Agent 记忆文件。</div></div><div class="chat-memory-actions"><button class="action-btn outline" @click="openChatHistoryFileInEditor" :disabled="chatMemoryOpenBusy || chatMemoryBusy || chatMemorySaveBusy">{{ chatMemoryOpenBusy ? '打开中...' : '在编辑器打开' }}</button><button class="action-btn outline" @click="openChatMemoryEditor" :disabled="chatMemoryBusy || chatMemorySaveBusy || chatMemoryOpenBusy">{{ chatMemoryBusy ? '读取中...' : '内嵌查看' }}</button><button class="action-btn outline" @click="loadChatHistory" :disabled="chatMemoryBusy || chatMemorySaveBusy || chatMemoryOpenBusy">刷新路径</button></div></div><div v-if="chatMemoryFile" class="chat-memory-meta"><span :style="{ color: chatMemoryFile.exists ? 'var(--c-success-dim)' : 'var(--c-error-dim)' }">{{ chatMemoryFile.exists ? '文件已存在' : '今日文件尚未生成，保存后会创建' }}</span><span>字符数 {{ chatMemoryFile.sizeChars }}</span><span>更新时间 {{ chatMemoryFile.updatedAt || '未写入' }}</span></div><div v-if="chatMemoryEditorOpen" class="chat-memory-editor-shell"><textarea v-model="chatMemoryDraft" class="chat-memory-editor" spellcheck="false" placeholder="这里显示 ai/chat 下当天聊天记录 JSON，可直接编辑后保存。" /><div class="chat-memory-editor-footer"><div class="chat-memory-editor-hint">服务端保存前会校验 JSON 数组结构，避免写坏聊天历史。</div><div class="chat-memory-actions"><button class="action-btn outline" @click="loadChatMemoryFile" :disabled="chatMemoryBusy || chatMemorySaveBusy">{{ chatMemoryBusy ? '刷新中...' : '重新加载' }}</button><button class="action-btn" @click="saveChatMemoryFile" :disabled="chatMemorySaveBusy || chatMemoryBusy || !chatMemoryDirty">{{ chatMemorySaveBusy ? '保存中...' : '保存文件' }}</button></div></div></div><div v-if="chatMemoryOpenMessage" class="message-banner tip" style="font-size: 12px; line-height: 1.5;">{{ chatMemoryOpenMessage }}</div><div v-if="chatMemorySaveMessage" class="message-banner tip" style="font-size: 12px; line-height: 1.5;">{{ chatMemorySaveMessage }}</div><div v-if="chatMemoryError" class="message-banner error" style="font-size: 12px; line-height: 1.5;">{{ chatMemoryError }}</div></div></div>

        <div class="dashboard-tab-content" v-show="dashboardActiveTab === 'skills'">
          <ControlConsoleSkillProposalsPanel />
        </div>

        <div v-if="editorModalOpen" class="editor-modal-backdrop" @click.self="closeEditorModal">
          <div class="editor-modal-shell" tabindex="-1" role="dialog" aria-modal="true" :aria-label="editorModalTitle">
            <div class="editor-modal-header"><div><div class="chat-memory-title">{{ editorModalTitle }}</div><div class="chat-memory-desc">{{ activeEditorFilePath }}</div></div><div class="editor-modal-actions"><button v-if="editorModalKind === 'context-pool'" class="action-btn outline" @click="openContextPoolEntryInEditor" :disabled="contextPoolEditorBusy">{{ contextPoolEditorBusy ? '处理中...' : '在编辑器打开' }}</button><button class="action-btn outline" @click="closeEditorModal">关闭</button></div></div>
            <div v-if="editorModalKind === 'source' && selectedContextSource && sourceEditorFile" class="context-file-editor-shell"><div class="chat-memory-meta"><span>{{ selectedContextSource.label }}</span><span>字符数 {{ sourceEditorFile.sizeChars }}</span><span>更新时间 {{ sourceEditorFile.updatedAt || '未写入' }}</span><span>快捷键已锁定：Tab / Ctrl+S / Ctrl+W</span></div><Codemirror v-model="sourceEditorContent" class="context-file-codemirror" :extensions="sourceEditorExtensions" :style="{ height: '60vh' }" /><div class="reasoning-review-actions" style="margin-top: 8px;"><button class="action-btn" @click="saveContextSourceFile" :disabled="sourceEditorSaveBusy || !sourceEditorDirty">{{ sourceEditorSaveBusy ? '保存中...' : '保存源文件' }}</button></div><div v-if="sourceEditorSaveMessage" class="chat-memory-desc">{{ sourceEditorSaveMessage }}</div></div>
            <div v-else-if="editorModalKind === 'memory-record' && memoryRecordFile" class="context-file-editor-shell"><div v-if="memoryRecordEditorError" class="message-banner error" style="font-size: 12px; margin-bottom: 8px;">{{ memoryRecordEditorError }}</div><div class="chat-memory-meta"><span>{{ editorModalTitle }}</span><span>字符数 {{ memoryRecordFile.sizeChars }}</span><span>更新时间 {{ memoryRecordFile.updatedAt || '未写入' }}</span><span>快捷键已锁定：Tab / Ctrl+S / Ctrl+W</span></div><Codemirror v-model="memoryRecordContent" class="context-file-codemirror" :extensions="memoryRecordEditorExtensions" :style="{ height: '60vh' }" /><div class="reasoning-review-actions" style="margin-top: 8px;"><button class="action-btn" @click="saveMemoryRecordFile" :disabled="memoryRecordEditorBusy || memoryRecordSaveBusy || !memoryRecordDirty">{{ memoryRecordSaveBusy ? '保存中...' : '保存记忆记录' }}</button></div><div v-if="memoryRecordSaveMessage" class="chat-memory-desc">{{ memoryRecordSaveMessage }}</div></div>
            <div v-else-if="editorModalKind === 'context-pool' && selectedContextPoolEntry && contextPoolFile" class="context-file-editor-shell"><div class="chat-memory-meta"><span>{{ selectedContextPoolEntry.title }}</span><span>字符数 {{ contextPoolFile.sizeChars }}</span><span>更新时间 {{ contextPoolFile.updatedAt || '未写入' }}</span><span>快捷键已锁定：Tab / Ctrl+S / Ctrl+W</span></div><Codemirror v-model="contextPoolFileContent" class="context-file-codemirror" :extensions="contextPoolEditorExtensions" :style="{ height: '60vh' }" /><div class="reasoning-review-actions" style="margin-top: 8px;"><button class="action-btn" @click="saveContextPoolEntryEdits" :disabled="contextPoolEditorBusy || !contextPoolFileDirty">{{ contextPoolEditorBusy ? '保存中...' : '保存修改' }}</button><button class="action-btn outline mini-danger-btn" @click="deleteContextPoolEntry(selectedContextPoolEntry.entryId)" :disabled="contextPoolDeleteBusy || contextPoolEditorBusy">{{ contextPoolDeleteBusy ? '删除中...' : '删除记录' }}</button></div><div v-if="contextPoolFileSaveMessage" class="chat-memory-desc">{{ contextPoolFileSaveMessage }}</div></div>
          </div>
        </div>
      </div>
    </details>
  </div>
</template>