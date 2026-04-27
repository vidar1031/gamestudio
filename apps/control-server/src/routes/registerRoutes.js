import { registerControlServerRoutes } from '../server/controlServerCore.js'

export function registerRoutes(app) {
  registerControlServerRoutes(app)
}