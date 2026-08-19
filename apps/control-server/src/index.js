import { serve } from '@hono/node-server'
import { createApp } from './app/createApp.js'
import { CONTROL_SERVER_PORT } from './config/constants.js'
import { registerRoutes } from './routes/registerRoutes.js'
import { cleanupOrphanedReasoningSessions, startReasoningQueueWorker, startGatewaySupervision, startCronScheduler, startResourceScheduler } from './server/controlServerCore.js'

process.on('unhandledRejection', (reason, promise) => {
  console.error(`[FATAL][unhandledRejection] ${reason instanceof Error ? reason.stack || reason.message : String(reason)}`)
})

process.on('uncaughtException', (error) => {
  console.error(`[FATAL][uncaughtException] ${error instanceof Error ? error.stack || error.message : String(error)}`)
})

const port = CONTROL_SERVER_PORT
const app = createApp()

registerRoutes(app)
// AUTO-B03/AUTO-C01：先收敛孤儿 session + 恢复持久化队列调度，再启动队列 worker
cleanupOrphanedReasoningSessions()
startReasoningQueueWorker()
// AUTO-C04：gateway 监督恢复（默认关闭，HERMES_GATEWAY_SUPERVISION_ENABLED=true 启用）
startGatewaySupervision()
// HERMES-H02：cron 受控生产触发调度 tick（只提交受控任务；无注册 job 时为空转）
startCronScheduler()
// AUTO-R01：本地重负载资源互斥调度（单模型守卫 reconcile；HERMES_RESOURCE_SCHEDULER_ENABLED 默认开）
startResourceScheduler()

serve({
  fetch: app.fetch,
  port
}, () => {
  console.log(`[control-server] listening on http://127.0.0.1:${port}`)
})
