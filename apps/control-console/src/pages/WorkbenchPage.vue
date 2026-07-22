<script setup lang="ts">
import ControlConsoleDiagnosticsPanel from '../components/ControlConsoleDiagnosticsPanel.vue'
import ControlConsoleMainPanels from '../components/ControlConsoleMainPanels.vue'
import ControlConsoleSkillProposalsPanel from '../components/ControlConsoleSkillProposalsPanel.vue'
</script>

<template>
  <div class="page-workbench">
    <ControlConsoleMainPanels />
    <ControlConsoleDiagnosticsPanel />
    <ControlConsoleSkillProposalsPanel />
  </div>
</template>

<style scoped>
.page-workbench {
  display: flex;
  flex-direction: column;
  gap: 16px;
}
</style>
