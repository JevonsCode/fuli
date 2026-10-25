import { createPinia } from 'pinia'
import { createApp } from 'vue'

import App from './App.vue'
import ConsoleSignIn from './features/console-session/ConsoleSignIn.vue'
import { SIGN_IN_PAGE_PATH } from './features/console-session/sign-in'
import { i18n } from './i18n'
import { initMotionPreference } from './lib/motion-preference'
import { initPalettePreference } from './lib/palette-preference'
import { router } from './router'
// The theme comes first: it declares the cascade layer order.
import './styles/theme/tailwind.css'
import './styles/tokens.css'
import '../styles.css'
import './styles/console-responsive.css'
import './styles/connections.css'
import './styles/knowledge-graph.css'
import './styles/vue.css'
import './styles/project-overview.css'
import './styles/primitives.css'

initMotionPreference()
initPalettePreference()

// The sign-in page `fuli open` lands on runs alone, before any console request (rec#11 D-61).
if (window.location.pathname === SIGN_IN_PAGE_PATH) {
  createApp(ConsoleSignIn).use(i18n).mount('#app')
} else {
  const app = createApp(App)
  app.use(createPinia())
  app.use(i18n)
  app.use(router)

  // Mount the recovery UI even when the initial route's assets could not load.
  await router.isReady().catch(() => undefined)
  app.mount('#app')
}
