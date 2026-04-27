<script setup lang="ts">
import ControlConsoleDiagnosticsPanel from './components/ControlConsoleDiagnosticsPanel.vue'
import ControlConsoleHeader from './components/ControlConsoleHeader.vue'
import ControlConsoleMainPanels from './components/ControlConsoleMainPanels.vue'
import ControlConsoleTaskQueuePanel from './components/ControlConsoleTaskQueuePanel.vue'
import { provideControlConsoleApp } from './composables/useControlConsoleAppContext'
import { useControlConsoleApp } from './composables/useControlConsoleApp'

const controlConsoleApp = useControlConsoleApp()
provideControlConsoleApp(controlConsoleApp)
</script>

<template>
  <main class="shell">
    <ControlConsoleHeader />
    <section class="console-body" v-if="controlConsoleApp.selectedAgentId">
      <ControlConsoleMainPanels />
      <ControlConsoleDiagnosticsPanel />
      <ControlConsoleTaskQueuePanel />
    </section>
  </main>
</template>

<style>
:root {
  --c-bg-deep: #0e1117;
  --c-bg-base: #12161d;
  --c-bg-panel: #1a2030;
  --c-bg-card: #222a36;
  --c-bg-input: #1c2535;
  --c-border: rgba(255,255,255,0.09);
  --c-border-mid: rgba(255,255,255,0.14);
  --c-text: #e4eaf2;
  --c-text-sub: #9daab8;
  --c-text-muted: #5e6e82;
  --c-text-inv: #ffffff;
  --c-accent: #5eccff;
  --c-accent-dim: rgba(94,204,255,0.18);
  --c-success: #4dd68c;
  --c-success-dim: #7cfc9a;
  --c-warn: #f6c94e;
  --c-error: #ff6b6b;
  --c-error-dim: #ff8a80;
}

.chat-panel-shell { display: flex; flex-direction: column; gap: 12px; }
.chat-thread { display: flex; flex-direction: column; gap: 14px; min-height: 100%; max-height: none; overflow-y: auto; padding: 16px; background: linear-gradient(180deg, rgba(18, 22, 28, 0.96) 0%, rgba(26, 31, 38, 0.92) 100%); border: 1px solid rgba(255, 255, 255, 0.08); border-radius: 12px; }
.chat-thread-resizable { min-height: 320px; max-height: min(72vh, 860px); resize: vertical; overflow: auto; }
.chat-empty-state { display: flex; flex-direction: column; gap: 6px; margin: auto 0; color: var(--c-text-sub); }
.chat-empty-title { font-size: 16px; font-weight: 700; color: var(--c-text); }
.chat-empty-copy { font-size: 13px; color: var(--c-text); }
.chat-row { display: flex; }
.chat-row[data-role='user'] { justify-content: flex-end; }
.chat-row[data-role='hermes'], .chat-row[data-role='error'] { justify-content: flex-start; }
.chat-bubble { width: fit-content; max-width: min(78ch, 82%); padding: 12px 14px; border-radius: 16px; box-shadow: 0 10px 30px rgba(0, 0, 0, 0.16); }
.chat-bubble[data-role='user'] { background: linear-gradient(135deg, #2a7dd6 0%, #1f5ea8 100%); color: var(--c-text); border-bottom-right-radius: 6px; }
.chat-bubble[data-role='hermes'] { background: linear-gradient(135deg, #222a33 0%, #161d26 100%); color: var(--c-text); border: 1px solid rgba(142, 196, 255, 0.18); border-bottom-left-radius: 6px; }
.chat-bubble[data-role='error'] { background: linear-gradient(135deg, #6d1f28 0%, #54161d 100%); color: var(--c-text); border: 1px solid rgba(255, 160, 160, 0.22); border-bottom-left-radius: 6px; }
.chat-role { margin-bottom: 6px; font-size: 11px; font-weight: 700; letter-spacing: 0.08em; opacity: 0.72; }
.chat-message-text { font-size: 15px; line-height: 1.6; word-break: break-word; }
.chat-message-text h1,.chat-message-text h2,.chat-message-text h3,.chat-message-text h4,.chat-message-text h5,.chat-message-text h6 { margin: 0 0 10px; line-height: 1.35; color: #ffffff; }
.chat-message-text h1 { font-size: 20px; }
.chat-message-text h2 { font-size: 18px; }
.chat-message-text h3 { font-size: 16px; }
.chat-message-text p,.chat-message-text ul,.chat-message-text ol,.chat-message-text blockquote,.chat-message-text pre { margin: 0; }
.chat-message-text ul,.chat-message-text ol { padding-left: 20px; }
.chat-message-text blockquote { padding-left: 12px; border-left: 3px solid rgba(143, 191, 255, 0.45); color: var(--c-text); }
.chat-message-text code { padding: 1px 5px; border-radius: 6px; background: rgba(255, 255, 255, 0.08); font: 12px/1.5 SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', monospace; }
.chat-message-text pre { padding: 12px; border-radius: 10px; background: rgba(4, 8, 14, 0.72); overflow: auto; }
.chat-message-text pre code { display: block; padding: 0; background: transparent; }
.chat-message-text a { color: var(--c-accent); text-decoration: underline; }
.chat-token-usage { margin-top: 10px; padding-top: 8px; border-top: 1px solid rgba(255, 255, 255, 0.08); font-size: 11px; color: var(--c-success); }
.chat-composer { display: flex; flex-direction: column; gap: 8px; padding: 12px; background: rgba(15, 18, 23, 0.72); border: 1px solid rgba(255, 255, 255, 0.08); border-radius: 12px; }
.chat-composer-input, .chat-memory-editor { width: 100%; padding: 12px 14px; resize: vertical; border-radius: 10px; background: #12161c; border: 1px solid #45515f; color: var(--c-text); }
.chat-composer-input { min-height: 88px; max-height: 220px; font: inherit; line-height: 1.5; }
.chat-memory-editor { min-height: 220px; font: 12px/1.6 SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', monospace; }
.chat-composer-input:focus, .chat-memory-editor:focus { outline: none; border-color: #59a7ff; box-shadow: 0 0 0 3px rgba(89, 167, 255, 0.16); }
.chat-composer-footer, .chat-memory-editor-footer, .chat-memory-header-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.chat-composer-actions, .chat-memory-actions, .editor-modal-actions { display: flex; flex-wrap: wrap; gap: 8px; }
.chat-composer-hint, .chat-memory-editor-hint, .chat-memory-desc, .chat-context-source-meta, .chat-memory-meta { font-size: 12px; color: var(--c-text-sub); }
.chat-context-panel, .chat-memory-panel, .reasoning-panel { display: flex; flex-direction: column; gap: 8px; padding: 12px; background: rgba(15, 18, 23, 0.72); border: 1px solid rgba(255, 255, 255, 0.08); border-radius: 12px; }
.reasoning-panel { border-color: rgba(89, 167, 255, 0.22); gap: 10px; }
.submit-gate-panel { border-color: rgba(89, 167, 255, 0.24); }
.submit-gate-grid, .transport-preview-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 12px; }
.submit-source-list, .chat-context-sources-list, .reasoning-plan-steps { display: flex; flex-direction: column; gap: 6px; }
.submit-source-item, .transport-preview-card, .reasoning-plan-box, .reasoning-artifact-box, .reasoning-timeline, .reasoning-review-box { padding: 10px 12px; border-radius: 10px; background: rgba(9, 12, 18, 0.56); border: 1px solid rgba(255, 255, 255, 0.06); }
.transport-preview-card.controller { border-color: rgba(89, 167, 255, 0.32); background: rgba(13, 24, 38, 0.72); }
.transport-preview-card.route { border-color: rgba(255, 184, 107, 0.28); background: rgba(36, 24, 10, 0.62); }
.transport-preview-card.hints { border-color: rgba(124, 252, 154, 0.24); background: rgba(12, 28, 20, 0.62); }
.reasoning-review-box { background: rgba(56, 46, 14, 0.26); border-color: rgba(255, 214, 102, 0.28); }
.reasoning-plan-title, .reasoning-event-ops-title { font-size: 12px; font-weight: 700; letter-spacing: 0.08em; color: var(--c-accent); }
.reasoning-plan-step, .reasoning-artifact-item, .reasoning-event-row, .chat-context-source-line { display: flex; flex-wrap: wrap; gap: 8px 12px; padding-top: 6px; border-top: 1px solid rgba(255,255,255,0.06); font-size: 12px; line-height: 1.5; color: var(--c-text); }
.reasoning-plan-step:first-child, .reasoning-artifact-item:first-child, .reasoning-event-row:first-child, .chat-context-source-line:first-child { padding-top: 0; border-top: none; }
.reasoning-plan-step-chip, .reasoning-event-meta-chip { padding: 2px 8px; border-radius: 999px; background: rgba(143, 191, 255, 0.12); border: 1px solid rgba(143, 191, 255, 0.18); color: var(--c-text); }
.reasoning-evidence-pre { margin: 0; padding: 10px 12px; border-radius: 8px; background: rgba(9, 12, 18, 0.72); border: 1px solid rgba(255,255,255,0.08); color: var(--c-text-sub); font-size: 12px; line-height: 1.55; white-space: pre-wrap; word-break: break-word; max-height: 280px; overflow: auto; }
.reasoning-timeline { max-height: 420px; overflow-y: auto; }
.editor-modal-backdrop { position: fixed; inset: 0; z-index: 1200; display: flex; align-items: center; justify-content: center; padding: 24px; background: rgba(5, 8, 12, 0.76); backdrop-filter: blur(4px); }
.editor-modal-shell { width: min(1120px, 100%); max-height: calc(100vh - 48px); display: flex; flex-direction: column; gap: 12px; padding: 16px; background: #10151c; border: 1px solid rgba(89, 167, 255, 0.24); border-radius: 14px; box-shadow: 0 24px 80px rgba(0, 0, 0, 0.45); }
.context-file-codemirror { border: 1px solid rgba(255,255,255,0.08); border-radius: 10px; overflow: hidden; }
.context-file-codemirror .cm-editor { height: 100%; font-size: 12px; }
.context-file-codemirror .cm-scroller { font-family: 'SFMono-Regular', 'Menlo', 'Monaco', monospace; }
.reasoning-busy-dot { display: inline-block; width: 7px; height: 7px; border-radius: 50%; background: var(--c-accent); animation: reasoning-dot-blink 1s ease-in-out infinite; vertical-align: middle; margin-right: 4px; }
.reasoning-planning-spinner { display: inline-block; width: 13px; height: 13px; border: 2px solid rgba(89, 167, 255, 0.25); border-top-color: var(--c-accent); border-radius: 50%; animation: reasoning-spinner-rotate 0.8s linear infinite; flex-shrink: 0; }
@keyframes reasoning-dot-blink { 0%,100%{opacity:1;} 50%{opacity:0.3;} }
@keyframes reasoning-spinner-rotate { to { transform: rotate(360deg); } }
@media (max-width: 820px) {
  .chat-thread-resizable { min-height: 260px; max-height: 60vh; }
  .chat-thread { padding: 12px; }
  .chat-bubble { max-width: 92%; }
  .chat-composer { padding: 10px; }
  .chat-composer-footer { flex-direction: column; align-items: stretch; }
}
</style>
