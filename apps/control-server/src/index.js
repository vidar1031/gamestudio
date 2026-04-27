import { serve } from '@hono/node-server'
import { createApp } from './app/createApp.js'
import { CONTROL_SERVER_PORT } from './config/constants.js'
import { registerRoutes } from './routes/registerRoutes.js'
import { cleanupOrphanedReasoningSessions } from './server/controlServerCore.js'

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
