<script setup lang="ts">
import { useControlConsoleAppContext } from '../composables/useControlConsoleAppContext'

const {
  connecting,
  error,
  getChineseCheckLabel,
  runtimeState,
  selfCheck,
} = useControlConsoleAppContext<any>()
</script>

<template>
  <details class="panel" open v-if="runtimeState?.state === 'running'" style="margin-bottom: 24px;">
    <summary class="panel-header" style="display: flex; align-items: center; justify-content: space-between;">
      <div class="panel-title">🩺 运行时自检诊断 (Runtime Diagnostics)</div>
      <span class="indicator" v-if="connecting">🔄 自检流转中...</span>
    </summary>
    <div class="panel-content">
      <p v-if="error" class="text-error">{{ error }}</p>
      <p v-else-if="!selfCheck && !connecting" class="text-muted">未能获取诊断快照，请重新启动引擎拉取。</p>
      <div v-else-if="selfCheck" class="diagnostics-grid">
        <div class="diagnostics-summary">
          <strong>诊断综合汇报:</strong> {{ selfCheck.summary }}
        </div>
        <div class="info-columns">
          <div class="info-block">
            <h3>💡 核心配置追踪 (Context Setup)</h3>
            <dl class="prop-list">
              <dt>驱动模型</dt><dd>{{ selfCheck.info.model }}</dd>
              <dt>接口路由</dt><dd>{{ selfCheck.info.provider }}</dd>
              <dt>服务地址</dt><dd class="code">{{ selfCheck.info.baseUrl }}</dd>
              <dt>上下文窗口</dt><dd>{{ selfCheck.info.contextLength ?? 'unknown' }}</dd>
              <dt>建议单轮输出</dt><dd>{{ selfCheck.info.recommendedMaxOutputTokens ?? 'unknown' }}</dd>
              <dt>Tokenizer</dt><dd>{{ selfCheck.info.tokenizer || 'unknown' }}</dd>
              <dt>持载区(CWD)</dt><dd class="code">{{ selfCheck.info.workspace }}</dd>
              <dt>交互策略</dt><dd>{{ selfCheck.info.interactionMode }}</dd>
              <dt>时间戳</dt><dd>{{ selfCheck.checkedAt }}</dd>
            </dl>
          </div>
          <div class="info-block">
            <h3>🔌 能力校验钩子 (Capabilities Check)</h3>
            <ul class="capability-list">
              <li v-for="item in selfCheck.checks" :key="item.key">
                <span class="status-icon">{{ item.status === 'ok' ? '✅' : '⚠️' }}</span>
                <div class="cap-text">
                  <strong>{{ getChineseCheckLabel(item.key) }}</strong>
                  <span class="cap-detail">{{ item.detail }}</span>
                </div>
              </li>
            </ul>
          </div>
        </div>
      </div>
    </div>
  </details>
</template>