import { createPinia } from 'pinia'
import { createApp } from 'vue'

import App from './App.vue'
import { i18n } from './i18n'
import { connectDesktopClient } from './lib/desktop-client'
import { installPageTransitions } from './lib/motion'
import { initMotionPreference } from './lib/motion-preference'
import { router } from './router'
// The bundled fonts (SIL OFL 1.1) register before the theme names them.
import '@fontsource-variable/inter'
import '@fontsource-variable/noto-sans-sc'
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
import './styles/motion.css'

initMotionPreference()
connectDesktopClient()

const app = createApp(App)
app.use(createPinia())
app.use(i18n)
app.use(router)
installPageTransitions(router)

// Mount the recovery UI even when the initial route's assets could not load.
await router.isReady().catch(() => undefined)
app.mount('#app')
