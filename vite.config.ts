import { fileURLToPath, URL } from 'node:url'

import vue from '@vitejs/plugin-vue'
import { defineConfig, type ProxyOptions } from 'vite'

const apiTarget = 'http://127.0.0.1:2727'
const localApiProxy: ProxyOptions = {
  target: apiTarget,
  changeOrigin: true,
  configure(proxy) {
    proxy.on('proxyReq', (outgoing, incoming) => {
      // Translate only an already same-origin dev request. Keep foreign origins
      // unchanged so the production request policy still rejects them.
      if (incoming.headers.origin === `http://${incoming.headers.host}`) outgoing.setHeader('origin', apiTarget)
    })
  },
}

export default defineConfig({
  root: fileURLToPath(new URL('./web', import.meta.url)),
  plugins: [vue()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./web/src', import.meta.url)),
    },
  },
  build: {
    outDir: fileURLToPath(new URL('./dist/web', import.meta.url)),
    emptyOutDir: true,
    sourcemap: false,
  },
  server: {
    host: '127.0.0.1',
    proxy: {
      '/api': localApiProxy,
      '/employee-workspaces': localApiProxy,
    },
  },
})
