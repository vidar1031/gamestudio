const fs = require('fs');
const file = 'apps/control-console/src/App.vue';
let content = fs.readFileSync(file, 'utf8');

const targetStr = content.substring(
  content.indexOf('<div class="dual-brain-container"'),
  content.indexOf('<details class="panel" open style="margin-bottom: 24px;">')
);

const newStr = `
<details class="panel" open style="margin-bottom: 16px; border: 1px solid #444;">
  <summary class="panel-header" style="display: flex; align-items: center; justify-content: space-between; background: rgba(0,200,255,0.1)">
    <div style="display: flex; flex: 1; min-width: 0; align-items: center; gap: 12px; flex-wrap: wrap;">
      <div class="panel-title" style="flex: 0 0 auto;">🧠 引擎配置 (Brain Configuration)</div>
      <div style="display: flex; align-items: center; gap: 10px; min-width: 0; font-size: 12px; color: #cfe8ef; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; flex-wrap: wrap;">
        <span>运行模型: {{ leftBrainSummary.modelLabel }}</span>
        <span :style="{ color: leftBrainConfigSaved ? '#9de2b0' : '#ffb3a7' }">{{ leftBrainConfigSaved ? '已保存左脑配置' : '未保存左脑配置' }}</span>
        <span :style="{ color: leftSelectedModelLoaded ? '#9de2b0' : '#ffb3a7' }">{{ leftBrainSummary.statusLabel }}</span>
      </div>
    </div>
    <div style="display: flex; gap: 8px;">
      <button class="action-btn outline" :disabled="preflightBusy || memoryConfigBusy || configSaving" @click.stop="runLeftBrainPreflight" style="padding: 2px 10px; font-size: 12px;">
        {{ preflightBusy ? '自检中...' : '🔎 自检' }}
      </button>
      <button class="action-btn" :disabled="runtimeBusy || memoryConfigBusy || configSaving" @click.stop="toggleHermesRuntime('left')" style="padding: 2px 10px; font-size: 12px;">
        {{ runtimeBusy ? '处理中...' : (leftBrainRunning ? '🔴 停止左脑' : '🚀 启动左脑') }}
      </button>
    </div>
  </summary>
  <div class="panel-content" style="padding: 0;">
    <div class="dual-brain-container" style="display: flex; flex-wrap: wrap; gap: 16px; width: 100%; padding: 12px;">
      
      <!-- Left Brain Content -->
      <div style="flex: 1; min-width: 300px; border: 1px solid #444; border-radius: 6px; padding: 12px; background: rgba(0,0,0,0.1);">
        <h3 style="margin-top: 0; margin-bottom: 12px; color: #cfe8ef; font-size: 14px;">左脑 (Left Brain)</h3>
        
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
            <option value="">请选择模型</option>
            <option v-for="mod in availableLeftModels" :key="mod.id" :value="mod.id">{{ mod.id }}</option>
          </select>
          <div style="display: flex; gap: 8px;">
            <button @click="fetchLocalModels('left')" :disabled="fetchingLeft">{{ fetchingLeft ? '...' : '刷新' }}</button>
            <button
              @click="actOnModel('left', 'load')"
              :disabled="!leftBrain.model || fetchingLeft || inspectingLeft || leftSelectedModelLoaded"
              :style="{
                border: '1px solid #4caf50',
                background: 'transparent',
                color: !leftBrain.model || fetchingLeft || inspectingLeft || leftSelectedModelLoaded ? '#5d7e63' : '#4caf50',
                opacity: !leftBrain.model || fetchingLeft || inspectingLeft || leftSelectedModelLoaded ? '0.45' : '1',
                cursor: !leftBrain.model || fetchingLeft || inspectingLeft || leftSelectedModelLoaded ? 'not-allowed' : 'pointer'
              }"
            >➕加载</button>
            <button
              @click="actOnModel('left', 'unload')"
              :disabled="!leftBrain.model || fetchingLeft || inspectingLeft || !leftSelectedModelLoaded"
              :style="{
                border: '1px solid #f44336',
                background: 'transparent',
                color: !leftBrain.model || fetchingLeft || inspectingLeft || !leftSelectedModelLoaded ? '#8d6767' : '#f44336',
                opacity: !leftBrain.model || fetchingLeft || inspectingLeft || !leftSelectedModelLoaded ? '0.45' : '1',
                cursor: !leftBrain.model || fetchingLeft || inspectingLeft || !leftSelectedModelLoaded ? 'not-allowed' : 'pointer'
              }"
            >➖卸载</button>
          </div>
        </div>
      </div>
      <div v-if="leftInspection" style="margin-top: 12px; font-size: 12px; color: #aaa;">
         状态: <span :style="{color: leftInspection.accessible ? '#7CFC9A' : '#FF8A80'}">{{ leftInspection.accessible ? '就绪' : '异常' }}</span>
         | 窗口: {{ leftInspection.contextLength || '-' }}
         | 探测Tokens: {{ leftInspection.usage?.totalTokens || '-' }}
      </div>
      <div v-if="leftBrainBlockedReason && !leftBrainRunning" style="margin-top: 12px; font-size: 12px; color: #ffb3a7;">{{ leftBrainBlockedReason }}</div>

      <template v-if="memoryConfig && skillConfig">
      <div style="display: flex; flex-direction: column; gap: 4px; margin-top: 12px; padding: 12px; background: rgba(0,0,0,0.2); border-radius: 6px;">
        <label>短期记忆最小窗口 Token</label>
        <input type="number" min="65536" step="1024" v-model="shortTermMinContextTokens" />
      </div>

      <div style="display: flex; flex-direction: column; gap: 8px; margin-top: 12px; padding: 12px; background: rgba(0,0,0,0.2); border-radius: 6px;">
        <div style="font-size: 13px; color: #ddd; font-weight: 600;">长期记忆文件</div>
        <label>Agent 定义文件</label>
        <input type="text" v-model="memoryConfig.agentDefinitionFile" />
        <label>用户记忆文件</label>
        <input type="text" v-model="memoryConfig.userFile" />
        <label>项目记忆文件</label>
        <input type="text" v-model="memoryConfig.memoryFile" />
        <label>状态文件</label>
        <input type="text" v-model="memoryConfig.statusFile" />
        <label>任务队列文件</label>
        <input type="text" v-model="memoryConfig.taskQueueFile" />
        <label>决策文件</label>
        <input type="text" v-model="memoryConfig.decisionsFile" />
        <label>日志目录</label>
        <input type="text" v-model="memoryConfig.dailyLogDir" />
      </div>

      <div style="display: flex; flex-direction: column; gap: 8px; margin-top: 12px; padding: 12px; background: rgba(0,0,0,0.2); border-radius: 6px;">
        <div style="font-size: 13px; color: #ddd; font-weight: 600;">技能库配置</div>
        <label>技能根目录</label>
        <input type="text" v-model="skillConfig.skillRoot" />
        <label>技能文件清单（每行一个 SKILL.md）</label>
        <textarea v-model="skillFilesText" style="min-height: 96px; resize: vertical;"></textarea>
        <div style="font-size: 12px; color: #888;">当前可用技能文件：{{ skillConfig?.skillCount ?? 0 }}</div>
      </div>

      <div style="display: flex; flex-wrap: wrap; align-items: center; gap: 12px; margin-top: 12px;">
        <button class="action-btn" @click="saveLeftBrainConfig" :disabled="configSaving || memoryConfigBusy">
          {{ saveLeftBrainLabel }}
        </button>
        <button class="action-btn outline" @click="loadEngineConfig" :disabled="memoryConfigBusy || configSaving">{{ memoryConfigBusy ? '读取中...' : '刷新配置' }}</button>
        <span v-if="configSaveMessage" style="font-size: 12px; color: #7CFC9A;">{{ configSaveMessage }}</span>
      </div>
      </template>
      <div v-else style="margin-top: 12px; font-size: 12px; color: #888;">左脑启动配置读取中。</div>
      <div v-if="memoryConfigError" class="text-error" style="margin-top: 8px;">{{ memoryConfigError }}</div>
      <div v-if="configSaveError" class="text-error" style="margin-top: 8px;">{{ configSaveError }}</div>
      </div>

      <!-- Right Brain Content -->
      <div style="flex: 1; min-width: 300px; border: 1px solid #444; border-radius: 6px; padding: 12px; background: rgba(255,200,0,0.05); opacity: 0.6;">
        <h3 style="margin-top: 0; margin-bottom: 12px; color: #f5d76e; font-size: 14px;">右脑 (Right Brain) <span style="font-size: 12px; color: #aaa; margin-left: 8px;">[未开放]</span></h3>
        <div style="display: flex; flex-wrap: wrap; gap: 16px; align-items: center; padding: 12px; background: rgba(0,0,0,0.2); border-radius: 6px;">
          <div style="flex: 1; min-width: 140px; display: flex; flex-direction: column; gap: 4px;">
            <label>推理平台</label>
            <select v-model="rightBrain.provider" disabled>
              <option value="omlx">OMLX (Local)</option>
              <option value="ollama">Ollama</option>
            </select>
          </div>
          <div style="flex: 1; min-width: 140px; display: flex; flex-direction: column; gap: 4px;">
            <label>服务地址</label>
            <input type="text" v-model="rightBrain.baseUrl" disabled />
          </div>
        </div>
        <div style="display: flex; flex-direction: column; gap: 4px; margin-top: 12px; padding: 12px; background: rgba(0,0,0,0.2); border-radius: 6px;">
          <label>运行模型</label>
          <div style="display: flex; gap: 8px;">
            <select v-model="rightBrain.model" style="flex: 1;" disabled>
              <option v-for="mod in availableRightModels" :key="mod.id" :value="mod.id">{{ mod.id }}</option>
            </select>
            <button disabled>未开放</button>
          </div>
        </div>
        <div style="margin-top: 12px; font-size: 12px; color: #bbb;">右脑当前保持置灰，只作为后续扩展占位，不参与 HermesManager 启动。</div>
        <div v-if="rightInspection" style="margin-top: 12px; font-size: 12px; color: #aaa;">
           状态: <span :style="{color: rightInspection.accessible ? '#7CFC9A' : '#FF8A80'}">{{ rightInspection.accessible ? '就绪' : '异常' }}</span>
           | 窗口: {{ rightInspection.contextLength || '-' }}
           | 探测Tokens: {{ rightInspection.usage?.totalTokens || '-' }}
        </div>
      </div>
    
    </div>
  </div>
</details>
`;

content = content.replace(targetStr, newStr);
fs.writeFileSync(file, content);
