import { serve } from '@hono/node-server'
import { createApp } from './app/createApp.js'
import { CONTROL_SERVER_PORT } from './config/constants.js'
import { registerRoutes } from './routes/registerRoutes.js'
import { cleanupOrphanedReasoningSessions } from './server/controlServerCore.js'

process.on('unhandledRejection', (reason, promise) => {
  console.error(`[FATAL][unhandledRejection] ${reason instanceof Error ? reason.stack || reason.message : String(reason)}`)
})

process.on('uncaughtException', (error) => {
  console.error(`[FATAL][uncaughtException] ${error instanceof Error ? error.stack || error.message : String(error)}`)
})

const port = CONTROL_SERVER_PORT
const app = createApp()

registerRoutes(app)
cleanupOrphanedReasoningSessions()

serve({
  fetch: app.fetch,
  port
}, () => {
  console.log(`[control-server] listening on http://127.0.0.1:${port}`)
})
