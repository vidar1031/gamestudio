<script setup lang="ts">
import { watch, onBeforeUnmount } from 'vue'
import { useUiDialogState, resolveUiDialog } from '../lib/uiDialog'

const dialog = useUiDialogState()

function onKeydown(event: KeyboardEvent) {
  if (!dialog.value) return
  if (event.key === 'Escape') {
    event.preventDefault()
    resolveUiDialog(false)
  } else if (event.key === 'Enter') {
    event.preventDefault()
    resolveUiDialog(true)
  }
}

watch(dialog, (value) => {
  if (value) window.addEventListener('keydown', onKeydown, true)
  else window.removeEventListener('keydown', onKeydown, true)
})

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeydown, true)
})
</script>

<template>
  <Teleport to="body">
    <div v-if="dialog" class="ui-dialog-backdrop" @click.self="resolveUiDialog(false)">
      <div class="ui-dialog" role="dialog" aria-modal="true" :aria-label="dialog.title">
        <div class="ui-dialog-head">
          <div class="ui-dialog-title">{{ dialog.title }}</div>
          <button class="ui-dialog-close" type="button" title="关闭" @click="resolveUiDialog(false)">✕</button>
        </div>
        <div class="ui-dialog-body">{{ dialog.message }}</div>
        <div class="ui-dialog-actions">
          <button
            v-if="dialog.showCancel"
            class="ui-dialog-btn outline"
            type="button"
            @click="resolveUiDialog(false)"
          >{{ dialog.cancelText }}</button>
          <button
            class="ui-dialog-btn"
            :class="dialog.danger ? 'danger' : 'primary'"
            type="button"
            @click="resolveUiDialog(true)"
          >{{ dialog.confirmText }}</button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.ui-dialog-backdrop {
  position: fixed;
  inset: 0;
  z-index: 1000;
  background: rgba(6, 9, 14, 0.62);
  backdrop-filter: blur(2px);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
}
.ui-dialog {
  width: min(440px, 100%);
  background: var(--c-bg-panel);
  border: 1px solid var(--c-border-mid);
  border-radius: 12px;
  box-shadow: 0 18px 48px rgba(0, 0, 0, 0.55);
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.ui-dialog-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 14px 16px 12px;
  border-bottom: 1px solid var(--c-border);
}
.ui-dialog-title {
  font-size: 14px;
  font-weight: 700;
  color: var(--c-text-inv);
}
.ui-dialog-close {
  flex: none;
  width: 26px;
  height: 26px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: transparent;
  border: 1px solid transparent;
  border-radius: 6px;
  color: var(--c-text-muted);
  font-size: 13px;
  cursor: pointer;
  transition: background 0.15s, color 0.15s, border-color 0.15s;
}
.ui-dialog-close:hover {
  background: rgba(255, 255, 255, 0.07);
  color: var(--c-text);
  border-color: var(--c-border-mid);
}
.ui-dialog-body {
  padding: 16px;
  font-size: 13px;
  line-height: 1.7;
  color: var(--c-text-sub);
  white-space: pre-line;
  max-height: 45vh;
  overflow-y: auto;
}
.ui-dialog-actions {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
  padding: 12px 16px 16px;
}
.ui-dialog-btn {
  height: 34px;
  padding: 0 18px;
  border-radius: 7px;
  border: 1px solid transparent;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  transition: background 0.15s, border-color 0.15s, color 0.15s;
}
.ui-dialog-btn.primary {
  background: rgba(94, 204, 255, 0.16);
  color: var(--c-accent);
  border-color: var(--c-accent-dim);
}
.ui-dialog-btn.primary:hover {
  background: rgba(94, 204, 255, 0.28);
}
.ui-dialog-btn.danger {
  background: rgba(255, 107, 107, 0.14);
  color: var(--c-error);
  border-color: rgba(255, 107, 107, 0.35);
}
.ui-dialog-btn.danger:hover {
  background: rgba(255, 107, 107, 0.26);
}
.ui-dialog-btn.outline {
  background: transparent;
  color: var(--c-text-sub);
  border-color: var(--c-border-mid);
}
.ui-dialog-btn.outline:hover {
  color: var(--c-text);
  background: rgba(255, 255, 255, 0.06);
}
</style>
