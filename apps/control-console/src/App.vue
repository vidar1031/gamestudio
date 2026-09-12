<script setup lang="ts">
import { provideControlConsoleApp } from './composables/useControlConsoleAppContext'
import { useControlConsoleApp } from './composables/useControlConsoleApp'
import UiDialog from './components/UiDialog.vue'

const controlConsoleApp = useControlConsoleApp()
provideControlConsoleApp(controlConsoleApp)
</script>

<template>
  <router-view />
  <UiDialog />
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

* { box-sizing: border-box; }

/* 全局统一细滚动条（暗色基底，hover 显强调色） */
::-webkit-scrollbar {
  width: 8px;
  height: 8px;
}
::-webkit-scrollbar-track {
  background: transparent;
}
::-webkit-scrollbar-thumb {
  background: rgba(255, 255, 255, 0.13);
  border-radius: 4px;
}
::-webkit-scrollbar-thumb:hover {
  background: rgba(94, 204, 255, 0.35);
}
::-webkit-scrollbar-corner {
  background: transparent;
}
* {
  scrollbar-width: thin;
  scrollbar-color: rgba(255, 255, 255, 0.18) transparent;
}

body {
  margin: 0;
  font-family: system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
  background: var(--c-bg-deep);
  color: var(--c-text);
}
</style>
