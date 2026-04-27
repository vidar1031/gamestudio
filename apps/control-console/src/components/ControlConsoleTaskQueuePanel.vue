<script setup lang="ts">
import { useControlConsoleAppContext } from '../composables/useControlConsoleAppContext'

const { runtimeState } = useControlConsoleAppContext<any>()
</script>

<template>
  <div class="feature-panels" v-if="runtimeState?.state === 'running'">
    <details class="panel" open>
      <summary class="panel-header" style="display: flex; align-items: center; justify-content: space-between;">
        <div class="panel-title">📋 调度任务栈看板 (Project status & Queues)</div>
      </summary>
      <div class="panel-content placeholder-mode">
        <p class="placeholder-desc">功能插槽：未来将直读内存文件 <code>STATUS.md</code> 与 <code>TASK_QUEUE.md</code>，可视化当前项目进度、阻塞项与堆积任务。</p>
        <div class="mock-grid">
          <div class="mock-card">
            <div class="mock-icon">🟢</div>
            <div class="mock-body">
              <strong>全局服务健康</strong>
              <span>Engine: http/1999 | Editor: http/8868</span>
            </div>
          </div>
          <div class="mock-card">
            <div class="mock-icon">📦</div>
            <div class="mock-body">
              <strong>原子任务队列排期</strong>
              <span>当前积压：3 项待执行批次</span>
            </div>
          </div>
        </div>
        <div class="panel-footer">
          <button class="action-btn outline" disabled>拉取工作区快照</button>
        </div>
      </div>
    </details>
  </div>
</template>