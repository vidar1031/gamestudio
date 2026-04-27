const fs = require('fs');
const content = fs.readFileSync('apps/control-console/src/App.vue', 'utf8');

const targetStart = '<div class="chat-memory-panel">';
const targetEnd = '<details class="panel" open v-if="runtimeState?.state === ';

const startIndex = content.indexOf('<div v-if="chatContextInfo" class="chat-context-panel">');
const endIndexStr = '<details class="panel" open v-if="runtimeState?.state === \'running\'" style="margin-bottom: 24px;">';
const endIndex = content.indexOf(endIndexStr);

if (startIndex === -1 || endIndex === -1) {
  console.log('Failed to find boundaries');
  process.exit(1);
}

const originalPanels = content.substring(startIndex, endIndex);

const template = `
<div class="dashboard-tabs" style="margin: 16px 0;">
  <button class="dashboard-tab-btn" :class="{ active: dashboardActiveTab === 'reasoning' }" @click="dashboardActiveTab = 'reasoning'">可观测推理链</button>
  <button class="dashboard-tab-btn" :class="{ active: dashboardActiveTab === 'context' }" @click="dashboardActiveTab = 'context'">当前上下文</button>
  <button class="dashboard-tab-btn" :class="{ active: dashboardActiveTab === 'plan' }" @click="dashboardActiveTab = 'plan'">Plan 能力注册表</button>
  <button class="dashboard-tab-btn" :class="{ active: dashboardActiveTab === 'pool' }" @click="dashboardActiveTab = 'pool'">上下文池</button>
  <button class="dashboard-tab-btn" :class="{ active: dashboardActiveTab === 'history' }" @click="dashboardActiveTab = 'history'">聊天记录存档</button>
</div>

<div class="dashboard-tab-content" v-show="dashboardActiveTab === 'reasoning'">
  <!-- reasoning_placeholder -->
</div>

<div class="dashboard-tab-content" v-show="dashboardActiveTab === 'context'">
  <!-- context_placeholder -->
</div>

<div class="dashboard-tab-content" v-show="dashboardActiveTab === 'plan'">
  <!-- plan_placeholder -->
</div>

<div class="dashboard-tab-content" v-show="dashboardActiveTab === 'pool'">
  <!-- pool_placeholder -->
</div>

<div class="dashboard-tab-content" v-show="dashboardActiveTab === 'history'">
  <!-- history_placeholder -->
</div>
`;

function extractPanel(html, startDiv, endRegex) {
    const startIdx = html.indexOf(startDiv);
    if (startIdx === -1) return { panel: '', rest: html };
    
    // Simple naive balancing for this specific structure
    let depth = 0;
    let endIdx = -1;
    const divRegex = /<\/?(?:div|details)[^>]*>/g;
    divRegex.lastIndex = startIdx;
    
    let match;
    while ((match = divRegex.exec(html)) !== null) {
        if (match[0].startsWith('</')) depth--;
        else if (match[0].startsWith('<d')) depth++;
        
        if (depth === 0) {
            endIdx = match.index + match[0].length;
            break;
        }
    }
    
    if (endIdx === -1) return { panel: html.substring(startIdx), rest: html.substring(0, startIdx) };
    
    return {
        panel: html.substring(startIdx, endIdx),
        rest: html.substring(0, startIdx) + html.substring(endIdx)
    };
}

let rest = originalPanels;

const p1 = extractPanel(rest, '<div v-if="chatContextInfo" class="chat-context-panel">');
const contextPanel = p1.panel;
rest = p1.rest;

const p2 = extractPanel(rest, '<details v-if="reasoningCapabilities');
const planPanel = p2.panel.replace('<details', '<div').replace('</details>', '</div>').replace('open>', '>');
rest = p2.rest;

const p3 = extractPanel(rest, '<div class="chat-memory-panel">'); // Context Pool
const poolPanel = p3.panel;
rest = p3.rest;

// Extract modal separately to not nest it inside tabs
const modalMatch = extractPanel(rest, '<div v-if="editorModalOpen" class="editor-modal-backdrop"');
const modalPanel = modalMatch.panel;
rest = modalMatch.rest;

const p4 = extractPanel(rest, '<div v-if="activeReasoningSession || reasoningError" class="reasoning-panel">');
const reasoningPanel = p4.panel;
rest = p4.rest;

const p5 = extractPanel(rest, '<div class="chat-memory-panel">'); // History
const historyPanel = p5.panel;
rest = p5.rest;

let newPanels = template
  .replace('<!-- reasoning_placeholder -->', reasoningPanel)
  .replace('<!-- context_placeholder -->', contextPanel)
  .replace('<!-- plan_placeholder -->', planPanel)
  .replace('<!-- pool_placeholder -->', poolPanel)
  .replace('<!-- history_placeholder -->', historyPanel);

// Append the modal to the outside of the tabs
newPanels += '\n\n' + modalPanel + '\n\n' + rest.trim();

const newContent = content.substring(0, startIndex) + newPanels + '\n' + content.substring(endIndex);

fs.writeFileSync('apps/control-console/src/App.vue', newContent);
console.log('Successfully patched App.vue');

