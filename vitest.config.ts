import { fileURLToPath, URL } from 'node:url'

import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  root: fileURLToPath(new URL('./web', import.meta.url)),
  plugins: [vue()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./web/src', import.meta.url)),
    },
  },
  test: {
    environment: 'jsdom',
    include: ['src/**/*.spec.ts'],
    setupFiles: ['src/test-support/setup.ts'],
    // Shared Windows CI runners can be several times slower than a workstation;
    // multi-step page specs need more than the 5-second default there.
    testTimeout: 15_000,
    // Tokens are read as text by specs that check colour contrast.
    css: { include: [/tokens\.css/] },
  },
})
