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
    // Token, theme and shared chrome stylesheets are read as text by specs that
    // check contrast, layering, divider lines, the motion rules and the page loading's layout.
    // The centred line font (styles/fonts.css) is checked against the bundled Inter stylesheet.
    // Agent card and 待决策 row stylesheets are read for their selection and centre-line rules.
    css: { include: [/tokens\.css/, /styles[\\/]theme[\\/]/, /web[\\/]styles\.css/, /primitives\.css/, /motion\.css/, /styles[\\/]vue\.css/, /styles[\\/]fonts\.css/, /fontsource-variable[\\/]inter[\\/]index\.css/, /agent-profile\.css/, /review-list[\\/]review-rows\.css/] },
  },
})
