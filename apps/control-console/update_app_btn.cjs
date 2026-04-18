const fs = require('fs');
let code = fs.readFileSync('apps/control-console/src/App.vue', 'utf8');

code = code.replace(/<button\n\s+class="action-btn"\n\s+:disabled="runtimeBusy[\s\S]*?<\/button>/m, `<!-- Removed top-level Action Button -->`);

// Add Start/Stop buttons inside Left and Right panels
code = code.replace(/<div class="panel-title">🧠 左脑配置 \(Left Brain\)<\/div>/, `
  <div class="panel-title" style="flex: 1;">🧠 左脑配置 (Left Brain)</div>
  <button class="action-btn" :disabled="runtimeBusy || startBlockedByModelInspection" @click="toggleHermesRuntime('left')" style="padding: 2px 10px; font-size: 12px; margin-left: auto;">
     {{ runtimeBusy ? '处理中...' : (runtimeState?.label === '运行中' && runtimeState?.brainSide === 'left' ? '🔴 停止左脑' : '🚀 启动左脑') }}
  </button>
`);

code = code.replace(/<div class="panel-title">🧠 右脑配置 \(Right Brain\)<\/div>/, `
  <div class="panel-title" style="flex: 1;">🧠 右脑配置 (Right Brain)</div>
  <button class="action-btn" :disabled="runtimeBusy || startBlockedByModelInspection" @click="toggleHermesRuntime('right')" style="padding: 2px 10px; font-size: 12px; margin-left: auto;">
     {{ runtimeBusy ? '处理中...' : (runtimeState?.label === '运行中' && runtimeState?.brainSide === 'right' ? '🔴 停止右脑' : '🚀 启动右脑') }}
  </button>
`);

// update toggleHermesRuntime implementation to take "side"
code = code.replace(/async function toggleHermesRuntime\(\) {[\s\S]*?^}/m, `
async function toggleHermesRuntime(side: 'left' | 'right') {
  if (!selectedAgent.value || selectedAgent.value.definition.runtime !== 'hermes' || !runtimeState.value) {
    return
  }
  if (runtimeState.value.state === 'uninstalled') {
    error.value = runtimeState.value.detail
    return
  }

  runtimeBusy.value = true
  error.value = ''

  try {
    const brain = side === 'left' ? leftBrain.value : rightBrain.value
    // If it's already running, stop it, REGARDLESS of side for now (simplifying singleton)
    // We pass side to the backend if needed, but since it's a single PID we just stop it.
    const isRunning = runtimeState.value.state === 'running'
    const action = isRunning ? 'stop' : 'start'
    const payloadBody: any = { action, brainSide: side }
    if (action === 'start') {
       payloadBody.config = {
        provider: brain.provider,
        baseUrl: brain.baseUrl,
        model: brain.model,
        contextLength: brain.contextLength,
        recommendedMaxOutputTokens: brain.recommendedMaxOutputTokens,
        tokenizer: brain.tokenizer,
        metadataSource: brain.metadataSource,
        side: side
      }
    }
    const response = await fetch('/api/control/agents/hermes-manager/runtime-action', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payloadBody)
    })
    if (!response.ok) throw new Error('http_' + response.status)

    const payload = await response.json()
    runtimeState.value = { ...payload.runtimeStatus, brainSide: isRunning ? null : side }

    if (runtimeState.value?.state === 'running') {
      await loadHermesSelfCheck()
    } else {
      selfCheck.value = null
    }
  } catch (caught) {
    error.value = String(caught)
  } finally {
    runtimeBusy.value = false
  }
}
`);

// Add summary styling changes to headers to display button inline
code = code.replace(/<summary class="panel-header"/g, '<summary class="panel-header" style="display: flex; align-items: center; justify-content: space-between;"');

fs.writeFileSync('apps/control-console/src/App.vue', code);
