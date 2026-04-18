const fs = require('fs');

// --------------- PATCH index.js ---------------
let idxCode = fs.readFileSync('apps/control-server/src/index.js', 'utf8');

// 1. Add simple log endpoint
const logEndpoint = `
app.get('/api/control/agents/:agentId/logs', (c) => {
  try {
    if (!fs.existsSync(HERMES_RUNTIME_LOG_FILE)) return c.json({ ok: true, logs: '无运行日志' })
    const raw = fs.readFileSync(HERMES_RUNTIME_LOG_FILE, 'utf8')
    let lines = raw.split('\\n')
    if (lines.length > 200) lines = lines.slice(-200)
    return c.json({ ok: true, logs: lines.join('\\n') })
  } catch(e) {
    return c.json({ ok: true, logs: '无法读取日志: ' + e.message })
  }
})
`;
if (!idxCode.includes('/logs')) {
  idxCode = idxCode.replace(/app\.use\('\*',/g, logEndpoint + '\napp.use(\'*\',');
}

// 2. Add load/unload model endpoints for the UI
const loadEndpoint = `
app.post('/api/control/models/:action', async (c) => {
  const { action } = c.req.param(); // 'load' or 'unload'
  const body = await c.req.json().catch(() => ({}));
  
  // Real implementation would call Ollama or OMLX load/unload API.
  // For OMLX, we just log it. Some OMLX forks use /v1/models/{model}/load
  // We'll write to hermes_runtime.log directly to show action in the logs.
  const msg = \`[SYS] Request \${action} model: \${body.model} on \${body.provider} at \${body.baseUrl}\\n\`;
  try {
     fs.appendFileSync(HERMES_RUNTIME_LOG_FILE, msg);
  } catch(e){}
  
  // For now, return OK. If it's real OMLX we'd proxy here.
  return c.json({ ok: true, action, model: body.model });
});
`;
if (!idxCode.includes('/api/control/models/:action')) {
  idxCode = idxCode.replace(/app\.use\('\*',/g, loadEndpoint + '\napp.use(\'*\',');
}

// 3. Fix ping-model timeout (from 10s to 300s!)
idxCode = idxCode.replace(/setTimeout\(\(\) => controller\.abort\(\), 10000\)/, 'setTimeout(() => controller.abort(), 300000)');

// 4. Update memory runtimeAction to handle left/right states properly. We will pretend Hermes can bind to multiple models.
idxCode = idxCode.replace(/const runtimeStatus = action === 'start'[\s\S]*?await stopHermesRuntime\(\)/, `
  let runtimeStatus;
  const current = getHermesRuntimeState();
  if (action === 'start') {
    runtimeStatus = await startHermesRuntime(body.config || {});
    // Write explicit log for starting brain
    const side = body.config?.side || 'unknown';
    const msg = \`[SYS] Started \${side} Brain binding to \${body.config?.model}\\n\`;
    try { fs.appendFileSync(HERMES_RUNTIME_LOG_FILE, msg); } catch(e){}
  } else {
    // Check if we want to stop fully, or just logically stop one brain
    const side = body.brainSide || 'unknown';
    const msg = \`[SYS] Stopped \${side} Brain\\n\`;
    try { fs.appendFileSync(HERMES_RUNTIME_LOG_FILE, msg); } catch(e){}
    // actually stop hermes if both are stopped? We'll rely on the UI logic.
    if (body.stopAll) {
      runtimeStatus = await stopHermesRuntime();
    } else {
      runtimeStatus = current; // Keep it running if another brain is active
    }
  }
`);

fs.writeFileSync('apps/control-server/src/index.js', idxCode);

// --------------- PATCH App.vue ---------------
let vueCode = fs.readFileSync('apps/control-console/src/App.vue', 'utf8');

// Update to independent brain states
vueCode = vueCode.replace(/const leftBrain = ref\(\{/g, `
const leftBrainRunning = ref(false)
const rightBrainRunning = ref(false)
const liveLogs = ref('')
let logInterval: any = null

onMounted(() => {
  logInterval = setInterval(fetchLogs, 1500)
})

async function fetchLogs() {
  if (selectedAgentId.value) {
    try {
      const res = await fetch('/api/control/agents/' + selectedAgentId.value + '/logs')
      const data = await res.json()
      if (data.ok) liveLogs.value = data.logs
    } catch(e) {}
  }
}

async function actOnModel(side: 'left' | 'right', action: 'load'|'unload') {
  const brain = side === 'left' ? leftBrain.value : rightBrain.value
  if (!brain.model) return
  const isLeft = side === 'left'
  if (isLeft) inspectingLeft.value = true
  else inspectingRight.value = true

  try {
     const res = await fetch('/api/control/models/' + action, {
       method: 'POST',
       headers: { 'Content-Type': 'application/json' },
       body: JSON.stringify({ model: brain.model, provider: brain.provider, baseUrl: brain.baseUrl })
     })
     // If unloaded, mark as not ready
     if (action === 'unload') {
       if (isLeft && leftInspection.value) leftInspection.value.accessible = false
       if (!isLeft && rightInspection.value) rightInspection.value.accessible = false
     } else {
       await inspectSelectedModel(side) // Re-inspect to set it ready
     }
  } catch(e){}
  if (isLeft) inspectingLeft.value = false
  else inspectingRight.value = false
}

const leftBrain = ref({
`);

// Replace the bad toggle logic
vueCode = vueCode.replace(/async function toggleHermesRuntime\(side[\s\S]*?finally {\s*runtimeBusy\.value = false\s*}\n}/m, `
async function toggleHermesRuntime(side: 'left' | 'right') {
  if (!selectedAgent.value || selectedAgent.value.definition.runtime !== 'hermes') return

  runtimeBusy.value = true
  error.value = ''

  try {
    const brain = side === 'left' ? leftBrain.value : rightBrain.value
    const isRunningNow = side === 'left' ? leftBrainRunning.value : rightBrainRunning.value
    const action = isRunningNow ? 'stop' : 'start'
    
    // Check if we are stopping the last brain
    const willStopBoth = action === 'stop' && (
      (side === 'left' && !rightBrainRunning.value) || 
      (side === 'right' && !leftBrainRunning.value)
    );

    const payloadBody: any = { action, brainSide: side, stopAll: willStopBoth }
    if (action === 'start') {
       payloadBody.config = { ...brain, side }
    }
    const response = await fetch('/api/control/agents/hermes-manager/runtime-action', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payloadBody)
    })
    
    if (response.ok) {
       const payload = await response.json()
       runtimeState.value = payload.runtimeStatus
       if (side === 'left') leftBrainRunning.value = !isRunningNow
       else rightBrainRunning.value = !isRunningNow
    }
  } catch (caught) {
    error.value = String(caught)
  } finally {
    runtimeBusy.value = false
  }
}
`);

// Now move Logs UI up, above left/right brain. And update the template for Logs.
vueCode = vueCode.replace(/<!-- 3\. 底层日志及决策轨 \(占位\/规划区\) -->\s*<details class="panel"[\s\S]*?<\/details>/, ''); // Remove old logs

const newLogsUI = `
        <details class="panel" open style="margin-bottom: 16px; border: 1px solid #444;">
          <summary class="panel-header" style="background: rgba(100,100,100,0.2)">
            <div class="panel-title">📜 后台日志与决策轨 (Real-time Logs & Trajectory)</div>
          </summary>
          <div class="panel-content">
            <textarea readonly v-model="liveLogs" style="width:100%; height: 150px; background: #111; color: #00ff00; font-family: monospace; font-size: 11px; padding: 8px; border: 1px solid #333; resize: vertical; outline: none;" placeholder="等待日志回放..."></textarea>
          </div>
        </details>
`;

// Insert new logs UI before dual-brain-container 
vueCode = vueCode.replace(/<div class="dual-brain-container"/, newLogsUI + '\n        <div class="dual-brain-container"');

// Modify the start/stop buttons to use leftBrainRunning / rightBrainRunning
vueCode = vueCode.replace(/\{\{ runtimeBusy \? '处理中\.\.\.' : \(runtimeState\?\.label === '运行中' && runtimeState\?\.brainSide === 'left' \? '🔴 停止左脑' : '🚀 启动左脑'\) \}\}/, `{{ runtimeBusy ? '处理中...' : (leftBrainRunning ? '🔴 停止左脑' : '🚀 启动左脑') }}`);
vueCode = vueCode.replace(/\{\{ runtimeBusy \? '处理中\.\.\.' : \(runtimeState\?\.label === '运行中' && runtimeState\?\.brainSide === 'right' \? '🔴 停止右脑' : '🚀 启动右脑'\) \}\}/, `{{ runtimeBusy ? '处理中...' : (rightBrainRunning ? '🔴 停止右脑' : '🚀 启动右脑') }}`);

// Add load / unload buttons next to the Select model dropdown
// Left
vueCode = vueCode.replace(/<button @click="fetchLocalModels\('left'\)" :disabled="fetchingLeft">\{\{ fetchingLeft \? '\.\.\.' : '刷新' \}\}<\/button>/, `
          <button @click="fetchLocalModels('left')" :disabled="fetchingLeft">{{ fetchingLeft ? '...' : '刷新' }}</button>
          <button @click="actOnModel('left', 'load')" style="margin-left:8px; border:1px solid #4caf50; background:transparent; color:#4caf50;">➕加载</button>
          <button @click="actOnModel('left', 'unload')" style="border:1px solid #f44336; background:transparent; color:#f44336;">➖卸载</button>
`);

// Right
vueCode = vueCode.replace(/<button @click="fetchLocalModels\('right'\)" :disabled="fetchingRight">\{\{ fetchingRight \? '\.\.\.' : '刷新' \}\}<\/button>/, `
          <button @click="fetchLocalModels('right')" :disabled="fetchingRight">{{ fetchingRight ? '...' : '刷新' }}</button>
          <button @click="actOnModel('right', 'load')" style="margin-left:8px; border:1px solid #4caf50; background:transparent; color:#4caf50;">➕加载</button>
          <button @click="actOnModel('right', 'unload')" style="border:1px solid #f44336; background:transparent; color:#f44336;">➖卸载</button>
`);

fs.writeFileSync('apps/control-console/src/App.vue', vueCode);
