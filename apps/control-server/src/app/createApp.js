import { Hono } from 'hono'
import { cors } from 'hono/cors'

export function createApp() {
  const app = new Hono()
  app.use('*', cors({ origin: '*', allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'] }))
  return app
}