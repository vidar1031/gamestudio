import { inject, provide } from 'vue'

const CONTROL_CONSOLE_APP_KEY = Symbol('control-console-app')

export function provideControlConsoleApp(app: any) {
  provide(CONTROL_CONSOLE_APP_KEY, app)
}

export function useControlConsoleAppContext<T = any>(): T {
  const app = inject<T | null>(CONTROL_CONSOLE_APP_KEY, null)
  if (!app) {
    throw new Error('control_console_app_context_missing')
  }
  return app
}