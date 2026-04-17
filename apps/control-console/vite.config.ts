import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  plugins: [vue()],
  server: {
    port: 8870,
    host: '0.0.0.0',
    proxy: {
      '/api': {
        target: process.env.CONTROL_SERVER_ORIGIN || 'http://127.0.0.1:2099',
        changeOrigin: true
      }
    }
  }
})