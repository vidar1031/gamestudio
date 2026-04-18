const fs = require('fs');

let code = fs.readFileSync('apps/control-console/src/App.vue', 'utf8');

// 1. Rename strings in template
code = code.replace(/控制网关 \(Control Gateway\)/g, '智能体网关 (Agent Gateway)');
code = code.replace(/指派调度器/g, '智能体管理器');

// 2. Restore top-level action button
const newButtonHtml = `
          <button
            class="action-btn"
            :disabled="runtimeBusy || runtimeState?.state === 'uninstalled'"
            @click="toggleGlobalRuntime"
          >
            {{ runtimeBusy ? '处理中...' : runtimeActionLabel }}
          </button>
`;
code = code.replace(/<!-- Removed top-level Action Button -->/, newButtonHtml);

// 3. Add toggleGlobalRuntime to script
const func = `
async function toggleGlobalRuntime() {
  if (!selectedAgent.value || selectedAgent.value.definition.runtime !== 'hermes' || !runtimeState.value) return

  if (runtimeState.value.state === 'uninstalled') {
    error.value = runtimeState.value.detail
    return
  }

  runtimeBusy.value = true
  error.value = ''

  try {
    const isRunning = runtimeState.value.state === 'running'
    const action = isRunning ? 'stop' : 'start'
    
    const payloadBody: any = { action, brainSide: 'left', stopAll: true }
    if (action === 'start') {
       payloadBody.config = { ...leftBrain.value, side: 'left' }
    }
    const response = await fetch('/api/control/agents/hermes-manager/runtime-action', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payloadBody)
    })
    
    if (response.ok) {
       const payload = await response.json()
       runtimeState.value = payload.runtimeStatus
       if (action === 'start') {
           leftBrainRunning.value = true
           await loadHermesSelfCheck()
       } else {
           leftBrainRunning.value = false
           rightBrainRunning.value = false
           selfCheck.value = null
       }
    }
  } catch (caught) {
    error.value = String(caught)
  } finally {
    runtimeBusy.value = false
  }
}
`;

// Insert the new function right after toggleHermesRuntime
const injectionPoint = code.indexOf('async function toggleHermesRuntime');
if (injectionPoint > -1 && !code.includes('toggleGlobalRuntime()')) {
    // find end of toggleHermesRuntime function
    const endBrace = code.indexOf('}\n', code.indexOf('finally {', injectionPoint));
    const nextLine = code.indexOf('\\n', endBrace) + 1 || endBrace + 2;
    code = code.slice(0, nextLine) + func + code.slice(nextLine);
}

fs.writeFileSync('apps/control-console/src/App.vue', code);
